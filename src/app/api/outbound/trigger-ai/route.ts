import { NextResponse } from 'next/server';
import { db as adminDb } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { runOutboundTurn } from '../../../../../outbound/llm/turn';

// Sends an "@AI …" trigger message into an outbound chat by running one Ava turn
// via POST /outbound_agent/call-llm-outbound/. Same payload + auth as the inbound
// call-llm ({ message, phone_number, agent_id, attendee_id } + Token auth); only
// the URL differs. Reads phone + agentId off the chat doc, prefixes "@AI".
/**
 * Ported from the admin panel with the substitutions established in U4/U5: `auth()` →
 * `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes, field writes and arithmetic are the source's.
 *
 * One larger change: the source POSTs to Django's `call-llm-outbound/` with a `backendToken`. That turn
 * is LOCAL here — `runOutboundTurn` from backend phase 8b⁴ — so it is called in-process. No HTTP hop, no
 * token, and the chat-resolution logic below (phone + agentId off the chat doc) is unchanged, because the
 * turn still needs both.
 *
 * `runOutboundTurn` takes a resolved `chatId`, which we already have — so unlike the
 * `call-llm-outbound` view it does not need to derive one from the phone number.
 */

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const chatId = body?.chatId;
  const raw = String(body?.message ?? '').trim();
  if (!chatId || !raw) {
    return NextResponse.json(
      { error: 'chatId and message are required' },
      { status: 400 }
    );
  }

  const message = /^@ai\b/i.test(raw) ? raw : `@AI ${raw}`;

  try {
    const snap = await adminDb.collection('chats').doc(chatId).get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }
    const data = snap.data()!;
    const phone =
      data.memory?.phone_number ||
      data.memory?.phone ||
      data.phone_number ||
      data.userId ||
      '';
    const agentId =
      String(data.agentId || '') || String(chatId).split('__')[1] || '';
    if (!phone || !agentId) {
      return NextResponse.json(
        { error: 'Chat is missing phone or agentId' },
        { status: 400 }
      );
    }

    // The turn runs in-process. `adminTriggerSource: 'human'` is the important argument — this is an
    // operator typing into the E2E screen, and only a human trigger is authoritative on timing (see the
    // note on `runOutboundTurn`). The source got the same effect by hitting the HTTP endpoint, whose
    // default is 'human'.
    const { status, ...payload } = await runOutboundTurn({
      message,
      agentId,
      chatId: String(chatId),
      attendeeId: phone,
      provider: 'unipile',
      adminTriggerSource: 'human',
    });
    return NextResponse.json(payload, { status });
  } catch (err: any) {
    console.error('[outbound/trigger-ai] error:', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to trigger the outbound agent' },
      { status: 502 }
    );
  }
}
