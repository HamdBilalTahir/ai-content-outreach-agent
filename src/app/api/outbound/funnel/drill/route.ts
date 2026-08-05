import { NextResponse } from 'next/server';
// `Query` imported rather than reached for as the ambient `FirebaseFirestore` global: `tsc` knows that
// namespace, eslint's no-undef does not.
import { Timestamp } from 'firebase-admin/firestore';
import type { Query } from 'firebase-admin/firestore';

import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';
import { isArchivedChat } from '@/lib/utils';

// Chats behind a funnel column, via the Admin SDK (the drawer previously queried
// with the browser client SDK).
//
//   GET ?kind=deal|chat-stage &source= &agent_ids=a,b &campaign_id= &start=ISO &end=ISO
//       deal:       &stage_ids=id1,id2   (attributed HubSpot deal stages)
//       chat-stage: &stage=New           (current chat stage)
//   -> { chats: [{ chat_id, name, phone, company, stage, started_at, updated_at, last_message }] }

const toMs = (cam: any, snake: any): number | null =>
  cam?.toDate?.()?.getTime?.() ?? (typeof snake === 'number' ? snake : null);

function messagePreview(lm: any): string | null {
  if (!lm) return null;
  const c = lm.content;
  if (typeof c === 'string') return c.slice(0, 140);
  if (Array.isArray(c)) {
    const text = c
      .map((p: any) => (typeof p === 'string' ? p : (p?.text ?? '')))
      .filter(Boolean)
      .join(' ');
    return text ? text.slice(0, 140) : null;
  }
  return null;
}

function contactName(c: any, m: any): string | null {
  return (
    [m.first_name, m.last_name].filter(Boolean).join(' ') ||
    c.display_name ||
    m.display_name ||
    m.contact_name ||
    m.phone ||
    c.phone ||
    c.userId ||
    null
  );
}

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
  const kind = searchParams.get('kind');
  const source = searchParams.get('source') || 'outbound';
  const campaignId = searchParams.get('campaign_id') || null;
  const agentIds = (searchParams.get('agent_ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const agentSet = new Set(agentIds);
  const startIso = searchParams.get('start');
  const endIso = searchParams.get('end');
  const start = startIso ? new Date(startIso) : null;
  const end = endIso ? new Date(endIso) : null;
  const startMs = start?.getTime() ?? null;
  const endMs = end?.getTime() ?? null;

  const toCard = (id: string, c: any, dealStage = false) => {
    const m = c.memory ?? {};
    const started_at = toMs(c.createdAt, c.created_at);
    return {
      chat_id: id,
      name: contactName(c, m),
      phone: m.phone || c.phone || c.userId || null,
      company: m.company || c.company || m.company_name || null,
      stage: (dealStage ? (m.hubspot_deal_stage ?? c.stage) : c.stage) ?? null,
      sub_stage: (c.sub_stage ?? null) as string | null,
      escalate: c.escalate === true,
      started_at,
      updated_at: toMs(c.updatedAt, c.updated_at) ?? started_at,
      last_message: messagePreview(c.latest_message),
    };
  };

  try {
    let list: any[] = [];

    if (kind === 'deal') {
      const wanted = new Set(
        (searchParams.get('stage_ids') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const snap = await adminDb
        .collection('chats')
        .where('memory._converted_to_deal', '==', true)
        .get();
      list = snap.docs
        .map((d) => ({ id: d.id, c: d.data() as any }))
        .filter(({ c }) => {
          const m = c.memory ?? {};
          if (!wanted.has(m._hubspot_deal_stage_id)) return false;
          if (c.record_type === 'Test') return false;
          if (isArchivedChat(c)) return false;
          if (source !== 'all' && c.type !== source) return false;
          if (agentSet.size && !agentSet.has(String(c.agentId))) return false;
          if (campaignId && c.campaign_id !== campaignId) return false;
          if (startMs != null && endMs != null) {
            const t = toMs(c.createdAt, c.created_at);
            if (t == null || t < startMs || t > endMs) return false;
          }
          return true;
        })
        .map(({ id, c }) => toCard(id, c, true));
    } else {
      const stage = searchParams.get('stage') || '';
      let q: Query =
        source === 'all'
          ? adminDb
              .collection('chats')
              .where('type', 'in', ['outbound', 'inbound'])
          : adminDb.collection('chats').where('type', '==', source);
      q = q.where('stage', '==', stage);
      if (campaignId) q = q.where('campaign_id', '==', campaignId);
      if (start && end) {
        q = q
          .where('createdAt', '>=', Timestamp.fromDate(start))
          .where('createdAt', '<=', Timestamp.fromDate(end));
      }
      const snap = await q.get();
      list = snap.docs
        .filter((d) => {
          const c = d.data() as any;
          if (String(c.record_type ?? '') === 'Test') return false;
          if (isArchivedChat(c)) return false;
          return agentSet.size ? agentSet.has(String(c.agentId ?? '')) : true;
        })
        .map((d) => toCard(d.id, d.data()));
    }

    list = list
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 200);
    return NextResponse.json({ chats: list });
  } catch (error: any) {
    console.error('[outbound/funnel/drill] GET error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
