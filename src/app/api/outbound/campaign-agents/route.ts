import { NextResponse } from 'next/server';

import { db } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

/**
 * Agents that have at least one outbound campaign, each with their campaigns — the funnel's agent and
 * campaign pickers.
 *
 * Reads `outbound_campaigns` through the Admin SDK, which is the same collection the ported backend's
 * `services/campaigns.ts` writes. The source's comment explains why it must be server-side: Firestore
 * rules block the browser client SDK from that collection, so a direct client read returned nothing.
 *
 * ## The company filter is dropped
 *
 * The source resolves the agents' documents and keeps only those whose `company_id` matches, matching both
 * string and number because the documents are inconsistent about the type. This repo has no companies, so
 * that filter would exclude everything — every agent here would fail a comparison against an id that does
 * not exist. `companyId` is therefore accepted and ignored rather than required, so the ported client's
 * query string needs no edit. Same decision as `/api/agents/list`.
 *
 * The agent documents are still fetched, because the picker needs their names.
 */
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Group every campaign by agent. The source notes campaigns are deliberate and few, and carry no
    // company id — so fetching all and grouping beats chunk-querying hundreds of agent ids.
    const campSnap = await db.collection('outbound_campaigns').get();
    const campaignsByAgent = new Map<
      string,
      { campaign_id: string; name: string; created: number }[]
    >();

    for (const doc of campSnap.docs) {
      const c = (doc.data() ?? {}) as Record<string, unknown>;
      const aid = String(c.agent_id ?? '');
      if (!aid) continue;
      const createdAt = c.created_at as
        | { toMillis?: () => number }
        | number
        | undefined;
      const created =
        (typeof createdAt === 'object' && createdAt?.toMillis?.()) ||
        (typeof createdAt === 'number' ? createdAt : 0);
      const list = campaignsByAgent.get(aid) ?? [];
      list.push({
        campaign_id: doc.id,
        name: String(c.name || doc.id),
        created,
      });
      campaignsByAgent.set(aid, list);
    }

    if (campaignsByAgent.size === 0) {
      return NextResponse.json({ agents: [] });
    }

    const agentIds = [...campaignsByAgent.keys()];
    const agentDocs = await db.getAll(
      ...agentIds.map((id) => db.collection('agents').doc(id))
    );

    const agents = agentDocs
      .filter((doc) => doc.exists)
      .map((doc) => {
        const a = (doc.data() ?? {}) as Record<string, unknown>;
        const memory = (a.memory ?? {}) as Record<string, unknown>;
        const campaigns = (campaignsByAgent.get(doc.id) ?? [])
          // Newest campaign first, so the picker opens on the one being worked.
          .sort((x, y) => y.created - x.created)
          .map(({ campaign_id, name }) => ({ campaign_id, name }));
        return {
          agent_id: doc.id,
          name: String(
            a.name || a.display_name || memory.display_name || doc.id
          ),
          campaigns,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ agents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[outbound/campaign-agents] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
