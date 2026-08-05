import { NextResponse } from 'next/server';

import { db } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

/**
 * The ids of agents that own an OUTBOUND skill — what narrows the picker from every agent to the ones
 * this product actually drives.
 *
 * Ported from the admin panel's `/api/outbound/agents`. Its comment explains why it exists at all: the
 * browser client SDK's `collectionGroup('skills')` query fails in some environments and needs its own
 * index, which made the caller silently fall back to listing EVERY agent. Doing it server-side through the
 * Admin SDK is the fix, and the fallback is still there — `useOutboundAgents` treats a failure as "no
 * filter" rather than "no agents", so a broken index degrades to a longer list instead of an empty one.
 *
 * Note this sits UNDER `/api/outbound/`, which the backend port mounts as a catch-all. Next.js resolves a
 * static segment ahead of a catch-all, so this route wins for `/api/outbound/agents` and everything else
 * still falls through to the ported route table. That is worth knowing before adding more routes here: any
 * new static path silently takes precedence over the table.
 */
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const snap = await db
      .collectionGroup('skills')
      .where('type', '==', 'outbound')
      .get();

    const ids = new Set<string>();
    for (const doc of snap.docs) {
      // `skills` is a subcollection of `agents/{id}`, so the grandparent is the agent.
      const agentId = doc.ref.parent.parent?.id;
      if (agentId) ids.add(agentId);
    }

    return NextResponse.json({ agent_ids: [...ids] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[outbound/agents] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
