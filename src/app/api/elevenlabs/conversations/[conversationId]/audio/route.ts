import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../../../../lib/utils/auth';
import { envStr } from '../../../../../../../outbound/config';

export const maxDuration = 300;

/**
 * A call recording, streamed to the `<audio>` element in the chat detail view.
 *
 * The substance here is the RANGE handling, and it is carried across untouched: buffering to send an
 * explicit `Content-Length` (without it the browser cannot size the stream and reports `duration:
 * Infinity`, so the progress bar never moves), `Accept-Ranges` to advertise seekability, and honouring
 * Range with 206 so a seek does not snap back to the start. Those three comments in the source read like
 * someone who debugged each symptom.
 *
 * Two substitutions: this repo's session guard replaces the `backendToken` check, and the source's
 * `getConversationAudio` helper is inlined — it is one authenticated ElevenLabs fetch, and pulling in that
 * module would drag the rest of its API surface with it. The key comes from the same
 * `ELEVENLABS_API_KEY` the ported backend reads.
 *
 * `params` is awaited: a Promise in Next 16, synchronous in the Next 14 the source targets.
 */
async function getConversationAudio(conversationId: string): Promise<Blob> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`,
    { method: 'GET', headers: { 'xi-api-key': envStr('ELEVENLABS_API_KEY') } }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation audio: ${response.status} ${response.statusText}`
    );
  }
  return response.blob();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { conversationId } = await params;

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation ID is required' },
        { status: 400 }
      );
    }

    const audioBlob = await getConversationAudio(conversationId);
    // Buffer fully so we can send an explicit Content-Length — without it the
    // browser can't size the stream and an <audio> element reports duration
    // Infinity (no total, non-moving progress bar). `inline` so it plays in
    // place rather than downloading.
    const audioBuffer = await audioBlob.arrayBuffer();
    const total = audioBuffer.byteLength;

    // Base headers. `Accept-Ranges: bytes` advertises seekability so the browser
    // will issue Range requests (and enables the seek bar); without honoring
    // those requests, seeking snaps the player back to the start.
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="conversation-${conversationId}.mp3"`,
      'Cache-Control': 'private, max-age=3600',
    };

    // Honor a Range request with 206 Partial Content so the <audio> element can
    // seek to arbitrary points in the recording.
    const rangeHeader = request.headers.get('range');
    const match = rangeHeader
      ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      : null;
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        return new NextResponse(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
        });
      }
      return new NextResponse(audioBuffer.slice(start, end + 1), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    });
  } catch (error: any) {
    console.error('Error fetching conversation audio:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch conversation audio' },
      { status: 500 }
    );
  }
}
