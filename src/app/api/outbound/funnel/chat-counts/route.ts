import { NextResponse } from 'next/server';
// `Query` imported rather than reached for as the ambient `FirebaseFirestore` global: `tsc` knows that
// namespace, eslint's no-undef does not.
import { Timestamp } from 'firebase-admin/firestore';
import type { Query } from 'firebase-admin/firestore';

import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

// Top-of-funnel chat-stage counts (New / Contacted / Engaged / Lost) via the
// Admin SDK — the funnel previously counted with the browser client SDK
// (getCountFromServer), which is unreliable in some environments.
//
//   GET ?agent_ids=a,b&campaign_ids=c,d&source=outbound|inbound|all&start=ISO&end=ISO
//   -> { new, contacted, engaged, lost }
//
// campaign_ids omitted/empty = all campaigns (no campaign filter). Mirrors the
// client's countForStage: excludes Test + archived chats; 'Lost' also excludes
// deal-converted chats (counted on the deal side), with the Test∩converted
// overlap added back so it isn't subtracted twice.

type AdminQuery = Query;

const count = async (q: AdminQuery): Promise<number> =>
  (await q.count().get()).data().count;

/**
 * Ported from the admin panel with three substitutions, all mechanical:
 *
 *  - `auth()` / `Session` → this repo's `getAuthenticatedUserId()`. Same 401 on failure.
 *  - `adminDb` → this repo's `db`, and its null guard is DROPPED: `lib/firebase/admin.ts` throws at import
 *    when its env is missing, so a reachable `db` is never null and the 500 branch was unreachable here.
 *  - `@/lib/chat-utils` → `@/lib/utils`, where `isArchivedChat` landed in U0.
 *
 * Everything else — the query shapes, the filters, the arithmetic — is the source's.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const agentIds = (searchParams.get('agent_ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const campaignIds = (searchParams.get('campaign_ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const source = searchParams.get('source') || 'outbound';
  const startIso = searchParams.get('start');
  const endIso = searchParams.get('end');

  if (agentIds.length === 0) {
    return NextResponse.json({ new: 0, contacted: 0, engaged: 0, lost: 0 });
  }

  const start = startIso ? new Date(startIso) : null;
  const end = endIso ? new Date(endIso) : null;

  // (agent × campaign) scopes — one campaign filter per selected campaign, or a
  // single no-campaign-filter scope when all/none are selected.
  const scopes: { agentId: string; campaignId?: string }[] = agentIds.flatMap(
    (agentId) =>
      campaignIds.length
        ? campaignIds.map((campaignId) => ({ agentId, campaignId }))
        : [{ agentId }]
  );

  const chats = () => adminDb.collection('chats');

  const baseQuery = (
    agentId: string,
    campaignId: string | undefined,
    stage: string
  ): AdminQuery => {
    let q: AdminQuery =
      source === 'all'
        ? chats().where('type', 'in', ['outbound', 'inbound'])
        : chats().where('type', '==', source);
    q = q.where('agentId', '==', agentId);
    if (campaignId) q = q.where('campaign_id', '==', campaignId);
    q = q.where('stage', '==', stage);
    if (start && end) {
      q = q
        .where('createdAt', '>=', Timestamp.fromDate(start))
        .where('createdAt', '<=', Timestamp.fromDate(end));
    }
    return q;
  };

  const countForStage = async (
    stage: string,
    excludeConverted = false
  ): Promise<number> => {
    const per = await Promise.all(
      scopes.map(async ({ agentId, campaignId }) => {
        const q = baseQuery(agentId, campaignId, stage);
        const testQ = q.where('record_type', '==', 'Test');
        const archQ = q.where('archived', '==', true);
        if (!excludeConverted) {
          const [all, test, arch] = await Promise.all([
            count(q),
            count(testQ),
            count(archQ),
          ]);
          return all - test - arch;
        }
        const convQ = q.where('memory._converted_to_deal', '==', true);
        const testConvQ = q
          .where('record_type', '==', 'Test')
          .where('memory._converted_to_deal', '==', true);
        const [all, test, conv, testConv, arch] = await Promise.all([
          count(q),
          count(testQ),
          count(convQ),
          count(testConvQ),
          count(archQ),
        ]);
        return all - test - conv + testConv - arch;
      })
    );
    return per.reduce((a, b) => a + b, 0);
  };

  try {
    const [newC, contactedC, engagedC, lostC] = await Promise.all([
      countForStage('New'),
      countForStage('Contacted'),
      countForStage('Engaged'),
      countForStage('Lost', true),
    ]);
    return NextResponse.json({
      new: newC,
      contacted: contactedC,
      engaged: engagedC,
      lost: lostC,
    });
  } catch (error: any) {
    console.error('[outbound/funnel/chat-counts] GET error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
