import { NextResponse } from 'next/server';
import { db as adminDb } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

// Previous outbound runs for an agent, scoped to the E2E Test screen: chats
// tagged type=="outbound" AND record_type=="Test" (real campaign chats are
// record_type=="Real" and are excluded here). Equality-only filters use zigzag
// merge — no composite index needed.
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

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');
  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  try {
    const snap = await adminDb
      .collection('chats')
      .where('agentId', '==', agentId)
      .where('type', '==', 'outbound')
      .where('record_type', '==', 'Test')
      .get();

    const runs = snap.docs
      .map((d) => {
        const c = d.data();
        const startedAt =
          c.createdAt?.toDate?.()?.getTime?.() ??
          (typeof c.created_at === 'number' ? c.created_at : null);
        const m = c.memory ?? {};
        return {
          chat_id: d.id,
          started_at: startedAt,
          stage: (c.stage ?? null) as string | null,
          name: [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
        };
      })
      // ascending (oldest first, latest last); keep the 100 most recent
      .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))
      .slice(-100);

    return NextResponse.json({ runs });
  } catch (error: any) {
    console.error('[outbound/runs] GET error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
