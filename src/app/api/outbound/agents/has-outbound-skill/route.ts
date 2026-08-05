import { NextResponse } from 'next/server';
import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

// Advisory pre-flight: does the agent (or its parent) own an outbound-typed
// skill? Via the Admin SDK (the E2E client previously read skills client-side).
//
//   GET ?agent_id= -> { has_outbound: boolean }
/**
 * Ported from the admin panel with the substitutions established in U4/U5: `auth()` →
 * `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes, field writes and arithmetic are the source's.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const agentId = new URL(request.url).searchParams.get('agent_id');
  if (!agentId) {
    return NextResponse.json({ error: 'agent_id required' }, { status: 400 });
  }

  const hasOutbound = async (id: string): Promise<boolean> => {
    const snap = await adminDb
      .collection('agents')
      .doc(id)
      .collection('skills')
      .get();
    return snap.docs.some((d) => (d.data() as any).type === 'outbound');
  };

  try {
    if (await hasOutbound(agentId)) {
      return NextResponse.json({ has_outbound: true });
    }
    const agentSnap = await adminDb.collection('agents').doc(agentId).get();
    const parentId: string | null =
      (agentSnap.data() as any)?.parent_agent ?? null;
    const has = parentId ? await hasOutbound(parentId) : false;
    return NextResponse.json({ has_outbound: has });
  } catch (error: any) {
    console.error('[outbound/agents/has-outbound-skill] GET error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
