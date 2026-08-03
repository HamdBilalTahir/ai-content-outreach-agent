/**
 * The route table — the port of `urls.py` and `views/__init__.py`.
 *
 * Django mounts the outbound app under `/outbound_agent/`; this port mounts it under `/api/outbound/`,
 * and every path below it is preserved **verbatim**, trailing slashes included. That matters more than
 * it looks: the FE reverses these paths by name, the provider webhook URLs are configured against them
 * in ElevenLabs and SendGrid, and the unsubscribe links inside already-delivered mail point at
 * `/unsub/?e=…&t=…` forever. A path is a published contract; only the mount prefix changes.
 *
 * The source's `name=` values are kept for the same reason — they are the identifiers the FE and the
 * `reverse()` calls use, so they stay findable by grep across both codebases.
 *
 * ## One catch-all adapter, not thirty route files
 *
 * `urls.py` is a first-match ordered list, and reproducing it as a list keeps that ordering meaningful
 * and testable. Next.js file-based routing would scatter the same information across thirty
 * directories, where the ordering is implicit in the framework's own precedence rules rather than in
 * anything a reader can check. `matchRoute` is first-match in declaration order, exactly like Django,
 * so a future ambiguity resolves the same way in both.
 *
 * ## The table lists only the routes whose views exist
 *
 * Consistent with the port's rule against stubs. A path absent from the table 404s, which is the
 * honest answer; a path present but wired to a placeholder would answer 200 with a lie. The remaining
 * entries land with their views in the rest of Phase 10 — see `PORT-PLAN.md`.
 */

import {
  callLlmOutboundView,
  conversationInitWebhookView,
  elevenlabsOutboundWebhookView,
  emailInboundWebhookView,
  initiateOutboundWebhookView,
  sendgridEventWebhookView,
  taskCronJobView,
  unsubscribeGetView,
  unsubscribePostView,
} from './webhookViews';
import { fromWebRequest, toWebResponse } from './request';
import { json } from './types';
import type { HttpMethod, OutboundView } from './types';

export interface Route {
  /** The source's `name=`, verbatim. See the module note. */
  name: string;
  /** The path relative to the mount. `:param` captures one segment, under the source's own name. */
  path: string;
  methods: Partial<Record<HttpMethod, OutboundView>>;
}

/**
 * Every route the outbound app serves, in `urls.py` order.
 *
 * The comments are the source's, kept because they record why several of these behave unusually — the
 * GET/POST asymmetry on `unsub/`, and the conversation-init hook being an INBOUND concern living in the
 * outbound app.
 */
export const routes: Route[] = [
  // SendGrid event webhook (bounce/dropped/spamreport/unsubscribe) — signature-verified; feeds the
  // suppression store + send_log status + nudge cancellation.
  {
    name: 'outbound_sendgrid_events',
    path: 'webhooks/sendgrid/',
    methods: { POST: sendgridEventWebhookView },
  },
  // Unsubscribe: GET = confirmation page (never suppresses — link scanners follow GETs);
  // POST = HMAC-validated one-click/form suppression (RFC 8058).
  {
    name: 'outbound_unsubscribe',
    path: 'unsub/',
    methods: { GET: unsubscribeGetView, POST: unsubscribePostView },
  },
  {
    name: 'outbound_initiate',
    path: 'webhook/initiate-outbound/',
    methods: { POST: initiateOutboundWebhookView },
  },
  {
    name: 'outbound_email_inbound',
    path: 'webhook/email-inbound/',
    methods: { POST: emailInboundWebhookView },
  },
  {
    name: 'outbound_elevenlabs_webhook',
    path: 'voice-agent/elevenlabs/outbound-webhook',
    methods: { POST: elevenlabsOutboundWebhookView },
  },
  // PRE-CALL (conversation-init) webhook — ElevenLabs fetches per-caller context on INBOUND calls.
  {
    name: 'outbound_elevenlabs_conversation_init',
    path: 'voice-agent/elevenlabs/conversation-init',
    methods: { POST: conversationInitWebhookView },
  },
  // FE-consumable outbound LLM endpoint (also reused internally by the cron + email webhook).
  {
    name: 'outbound_call_llm',
    path: 'call-llm-outbound/',
    methods: { POST: callLlmOutboundView },
  },
  // Outbound task cron — scheduled externally (Vercel).
  {
    name: 'outbound_task_cron_job',
    path: 'task-cron-job/',
    methods: { GET: taskCronJobView },
  },
];

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/** Split a path into segments, dropping the empty ones a trailing slash produces. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/**
 * First match in declaration order, as Django resolves `urlpatterns`.
 *
 * The trailing slash is not part of the comparison: both sides are reduced to segments, so
 * `task-cron-job/` and `task-cron-job` reach the same view. Django would 301 the slashless form via
 * `APPEND_SLASH` and the client would follow it to the same place — one hop fewer here, same outcome.
 */
export function matchRoute(path: string): RouteMatch | null {
  const wanted = segmentsOf(path);
  for (const route of routes) {
    const pattern = segmentsOf(route.path);
    if (pattern.length !== wanted.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i += 1) {
      const p = pattern[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = wanted[i];
      } else if (p !== wanted[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * Serve one request against the table.
 *
 * The two failure shapes are DRF's own, so a client that already handles them keeps working: `404
 * {"detail": "Not found."}` for an unmatched path, and `405 {"detail": "Method \"X\" not allowed."}`
 * for a path that exists under a different method. The 405 distinction is worth keeping — collapsing
 * both into a 404 would turn "you used GET on a POST endpoint" into "this endpoint does not exist",
 * which is the harder of the two to debug from the outside.
 *
 * An exception escaping a view becomes a 500 rather than a runtime stack trace, because several callers
 * here are third-party webhooks whose retry behaviour is driven by the status code alone.
 */
export async function handleOutboundRequest(
  request: Request,
  path: string
): Promise<Response> {
  const match = matchRoute(path);
  if (!match) {
    return toWebResponse(json({ detail: 'Not found.' }, 404));
  }

  const method = request.method.toUpperCase() as HttpMethod;
  const view = match.route.methods[method];
  if (!view) {
    return toWebResponse(
      json({ detail: `Method "${method}" not allowed.` }, 405)
    );
  }

  try {
    const outboundRequest = await fromWebRequest(request, match.params);
    return toWebResponse(await view(outboundRequest));
  } catch (e) {
    console.error(`[OB_HTTP] ${match.route.name} raised: ${e}`);
    return toWebResponse(json({ success: false, error: String(e) }, 500));
  }
}
