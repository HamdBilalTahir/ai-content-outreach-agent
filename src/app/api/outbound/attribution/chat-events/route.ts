import { NextResponse } from 'next/server';

import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

// Raw AI-outreach events for one chat (messages_v3 + activities), via the Admin
// SDK — the client-side fallback for the attribution timeline when the merged
// deal-timeline endpoint is unavailable. The client runs deriveEventsFromChat
// on the returned docs. Firestore Timestamps are serialized to ISO strings so
// that derivation (which expects toDate()/string/number) still works.
//
//   GET ?chat_id= -> { messages: [...], activities: [...] }

function serialize(v: any): any {
  if (v == null) return v;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) out[k] = serialize(v[k]);
    return out;
  }
  return v;
}

/**
 * Ported from the admin panel with the same three substitutions as the funnel routes in U4:
 * `auth()` → `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes and serialization are the source's.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const chatId = new URL(request.url).searchParams.get('chat_id');
  if (!chatId) {
    return NextResponse.json({ error: 'chat_id required' }, { status: 400 });
  }

  try {
    const [msgSnap, actSnap] = await Promise.all([
      adminDb
        .collection('chats')
        .doc(chatId)
        .collection('messages_v3')
        .orderBy('timestamp', 'asc')
        .limit(300)
        .get(),
      adminDb.collection('chats').doc(chatId).collection('activities').get(),
    ]);
    return NextResponse.json({
      messages: msgSnap.docs.map((d) => serialize(d.data())),
      activities: actSnap.docs.map((d) => serialize(d.data())),
    });
  } catch (error: any) {
    console.error('[outbound/attribution/chat-events] GET error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
