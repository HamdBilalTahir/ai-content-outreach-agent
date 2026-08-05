import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { fetchConversationFromElevenlabs } from '../../../../../outbound/services/elevenlabs';

export const maxDuration = 300;

/**
 * A call's transcript, by conversation id.
 *
 * ## This is the one route whose SOURCE could not be ported
 *
 * The admin panel's version calls `getCallTranscript(callId, session.user.backendToken)` against the
 * **inbound Django product** — a service this repo does not have and is not a port of. There was nothing to
 * translate: no local equivalent of that endpoint, and no `backendToken` to authenticate with.
 *
 * So the data comes from where it actually originates. Outbound calls are placed through ElevenLabs, and
 * `fetchConversationFromElevenlabs` — backend phase 7b²d, already used by the post-call webhook to build
 * the transcript in the first place — reads the same conversation the inbound API was relaying. The E2E
 * client's contract is unchanged: it passes `?call_id=` and reads the response.
 *
 * The practical difference to be aware of: the inbound API returned its own shaped transcript, whereas this
 * returns ElevenLabs' conversation payload verbatim. The client derives what it renders from
 * `transcript`/`analysis` fields that ElevenLabs supplies, which is why passing the payload through works —
 * but a field the inbound service synthesized rather than relayed would be absent, and would show as a
 * blank in the UI rather than an error.
 */
export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const callId = new URL(request.url).searchParams.get('call_id');
  if (!callId) {
    return NextResponse.json(
      { error: 'call_id parameter is required' },
      { status: 400 }
    );
  }

  try {
    const conversation = await fetchConversationFromElevenlabs(callId);
    if (!conversation) {
      // `null` means the provider has no such conversation — a 404 rather than a 500, because the caller
      // asked about something that does not exist rather than something that broke.
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }
    return NextResponse.json(conversation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[voice-workers/transcript] GET error:', message);
    return NextResponse.json(
      { error: 'Failed to fetch transcript' },
      { status: 500 }
    );
  }
}
