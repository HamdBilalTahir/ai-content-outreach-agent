import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { db as adminDb } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

// Toggle a prospect's per-channel opt-out on the outbound chat's memory.
//   phone → memory.phone_opt_out + memory.block_phone ("Y"/"N")
//   email → memory._email_opt_out (boolean) + the "email_opted_out" label
// These mirror this chat's opt-out decision (what the panel renders). NOTE: the
// global send gate reads the email_suppression store — updating that (so sends
// actually stop) is a backend job and is NOT done here.
/**
 * Ported from the admin panel with the substitutions established in U4/U5: `auth()` →
 * `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes, field writes and arithmetic are the source's.
 */

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const chatId = body?.chat_id;
  if (!chatId) {
    return NextResponse.json({ error: 'chat_id is required' }, { status: 400 });
  }

  const updates: Record<string, any> = {};
  if (typeof body.phone_opt_out === 'boolean') {
    const v = body.phone_opt_out ? 'Y' : 'N';
    updates['memory.phone_opt_out'] = v;
    updates['memory.block_phone'] = v;
    // Also write the top-level boolean flags. The backend STOP webhook sets
    // these, and the display + monitoring gate read them with OR logic
    // (top-level === true wins). Writing only memory left a stale top-level
    // `true` that overrode the toggle — keep both in sync so the toggle sticks.
    updates['phone_opt_out'] = body.phone_opt_out;
    updates['block_phone'] = body.phone_opt_out;
  }
  if (typeof body.email_opt_out === 'boolean') {
    updates['memory._email_opt_out'] = body.email_opt_out;
    updates['email_opt_out'] = body.email_opt_out;
    // Keep the visible label in sync with the flag (the panel renders from either).
    updates['labels'] = body.email_opt_out
      ? FieldValue.arrayUnion('email_opted_out')
      : FieldValue.arrayRemove('email_opted_out');
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'provide phone_opt_out and/or email_opt_out (boolean)' },
      { status: 400 }
    );
  }

  try {
    await adminDb.collection('chats').doc(chatId).update(updates);
    return NextResponse.json({ success: true, updated: Object.keys(updates) });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to update opt-out' },
      { status: 500 }
    );
  }
}
