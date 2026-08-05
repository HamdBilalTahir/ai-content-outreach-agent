import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { initiateOutboundWebhookView } from '../../../../../outbound/http/webhookViews';
import type { OutboundRequest } from '../../../../../outbound/http/types';

/**
 * Lead intake, for the browser.
 *
 * ## Why this exists rather than repointing the client
 *
 * The plan recorded this as "a repoint, not a new route" — the ported backend mounts the same handler at
 * `webhook/initiate-outbound/`, the Django path it preserved, while the source's proxy used the shorter
 * `initiate`. Editing the client's URL would have been one character cheaper and wrong for two reasons.
 *
 * First, the source's proxy exists to inject an `X-API-Key` so the browser never sees it. Second — and this
 * is the one that decided it — **the ported `initiateOutboundWebhookView` has no auth guard at all.** That
 * is correct for what it is: a webhook, `AllowAny` in Django, called by external lead sources. But it means
 * `/api/outbound/webhook/initiate-outbound/` is reachable unauthenticated through the catch-all, and
 * pointing a browser button at it would have put an unauthenticated lead-enrolment endpoint one fetch away
 * from the UI.
 *
 * This route adds the session guard for the browser path and calls the view in-process. The webhook path is
 * untouched and still open, which is what an external lead source needs — worth knowing, since anything
 * that can reach it can enrol leads and start calls.
 */
export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed body reaches the view as `{}`, which answers its own 400.
  }

  // The view is framework-free by design (backend phase 10a), so it takes the shape directly rather than a
  // `Request`. Only `body` is read by this handler; the rest of the shape is filled to satisfy the type.
  const outboundRequest: OutboundRequest = {
    method: 'POST',
    params: {},
    query: {},
    headers: {},
    body,
    bodyArray: null,
    rawBody: '',
  };

  const result = await initiateOutboundWebhookView(outboundRequest);
  return NextResponse.json(result.json, { status: result.status });
}
