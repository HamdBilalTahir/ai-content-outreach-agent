/**
 * The six webhook / cron / turn views — the request-level half of work whose handlers already landed.
 *
 * Ports `views/task_cron_job.py`, `views/initiate_outbound_webhook.py`, and the view classes of
 * `views/elevenlabs_webhook.py`, `views/conversation_init_webhook.py`, `views/email_webhook.py`,
 * `views/email_compliance.py`, plus `OutboundCallLLMView` from `call_llm_outbound.py`. Every one of
 * those bodies was already ported as a framework-free handler in an earlier phase; what is left here is
 * exactly what a DRF view does and nothing else: read the request, call the handler, pick a status.
 *
 * ## Four endpoints answer 200 on failure, on purpose
 *
 * The cron, the two ElevenLabs webhooks, and the inbound-email webhook all report problems in the body
 * with a 200 status. That is not laziness in the source — each of their callers retries non-2xx:
 *
 *  - **The cron** partially completed. A replay would re-run the touches that already fired.
 *  - **The two ElevenLabs webhooks** are told about a call that has already happened. A retry cannot
 *    make an unmatched `conversation_id` match, and the conversation-init hook must never delay a
 *    connecting call — it answers `{dynamic_variables: {}}` rather than an error, always.
 *  - **The email webhook** returns 200 for "matched nothing", for the same reason: SendGrid retries
 *    non-2xx, and an address that matched nothing will not match on the retry either.
 *
 * The two that DO fail loudly are the ones where a retry is the correct response: the SendGrid event
 * webhook (401 on a bad signature) and the lead-intake webhook (400 on a malformed batch).
 */

import { processOutboundTasks } from '../services/cron';
import { enrollContact } from '../services/enroll';
import {
  handlePostCallWebhook,
  handleConversationInitWebhook,
} from '../services/voiceWebhooks';
import { handleInboundEmail } from '../services/emailWebhook';
import {
  handleSendgridEventWebhook,
  handleUnsubscribeGet,
  handleUnsubscribePost,
} from '../services/emailCompliance';
import { buildDeterministicChatId } from '../services/chat';
import { runOutboundTurn } from '../llm/turn';
import { json, pyInt, text } from './types';
import type { OutboundRequest, OutboundResponse } from './types';
import type { EnrollResult, Lead } from '../services/enroll';

// ─────────────────────────────────────────────────────────────────────────────
// GET /task-cron-job/
// ─────────────────────────────────────────────────────────────────────────────

/** Process every due outbound task. Answers 200 even when the tick faulted — see the module note. */
export async function taskCronJobView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const window = pyInt(request.query.window, 2);
  try {
    return json(await processOutboundTasks({ window }));
  } catch (e) {
    console.error(`[OB_CRON] failed: ${e}`);
    return json({ success: false, error: String(e) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/initiate-outbound/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lead intake: a single lead or a `leads[]` batch, each enrolled immediately.
 *
 * One lead failing does not fail the batch — its error is recorded in `results[i]` and the rest still
 * enroll. `success` is true when *any* lead landed, which is what lets a partially-bad import through.
 */
export async function initiateOutboundWebhookView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  let leads = request.body.leads;

  // `is None`, not falsiness: an explicit `leads: []` does NOT fall back to the single-lead form. It
  // reaches the guard below and 400s, which is the honest answer to "enroll these zero contacts".
  if (
    (leads === null || leads === undefined) &&
    request.body.contact_information
  ) {
    leads = [request.body];
  }
  if (!Array.isArray(leads) || leads.length === 0) {
    return json({ success: false, error: 'leads array is required' }, 400);
  }

  const results: EnrollResult[] = [];
  let ok = 0;
  for (const lead of leads) {
    let result: EnrollResult;
    try {
      result = await enrollContact(lead as Lead);
    } catch (e) {
      console.error(`[OB_INIT] lead failed: ${e}`);
      result = { success: false, error: String(e) };
    }
    results.push(result);
    if (result.success) ok += 1;
  }

  return json({
    success: ok > 0,
    processed: results.length,
    succeeded: ok,
    results,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /voice-agent/elevenlabs/outbound-webhook  and  .../conversation-init
// ─────────────────────────────────────────────────────────────────────────────

/** The `ElevenLabs-Signature` header, verified against the raw bytes. */
function signedRequest(request: OutboundRequest) {
  return {
    signature: request.headers['elevenlabs-signature'] ?? '',
    rawBody: request.rawBody,
  };
}

/** Post-call completion. Verifies the signature and refuses on mismatch — but still with a 200. */
export async function elevenlabsOutboundWebhookView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const result = await handlePostCallWebhook(
    request.body,
    signedRequest(request)
  );
  return json(result);
}

/**
 * Pre-call context for an INBOUND call.
 *
 * Never blocks and never errors: a thrown exception here would leave the provider without the payload
 * it is waiting on, so the fallback is the same empty-variables answer the handler's own failure paths
 * return. The agent then answers the phone without context, which beats not answering it.
 */
export async function conversationInitWebhookView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  try {
    return json(
      await handleConversationInitWebhook(request.body, signedRequest(request))
    );
  } catch (e) {
    console.error(`[OB_INIT] conversation-init failed: ${e}`);
    return json({ dynamic_variables: {} });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/email-inbound/
// ─────────────────────────────────────────────────────────────────────────────

/** An inbound email reply. `agent_id` narrows the address lookup when the FE knows the agent. */
export async function emailInboundWebhookView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const { status, ...payload } = await handleInboundEmail(
    request.body,
    request.query.agent_id ?? null
  );
  return json(payload, status);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/sendgrid/  and  GET|POST /unsub/
// ─────────────────────────────────────────────────────────────────────────────

/** The SendGrid event batch. The one webhook here that fails CLOSED, with a real 401. */
export async function sendgridEventWebhookView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const { status, ...payload } = await handleSendgridEventWebhook(
    request.bodyArray,
    {
      signature:
        request.headers['x-twilio-email-event-webhook-signature'] ?? '',
      timestamp:
        request.headers['x-twilio-email-event-webhook-timestamp'] ?? '',
      rawBody: request.rawBody,
    }
  );
  return json(payload, status);
}

/** GET the unsubscribe link: a confirmation page, and no suppression whatsoever. */
export function unsubscribeGetView(request: OutboundRequest): OutboundResponse {
  const result = handleUnsubscribeGet(
    request.query.e ?? '',
    request.query.t ?? ''
  );
  return text(result.body, result.status, result.contentType);
}

/**
 * POST the unsubscribe: the real thing.
 *
 * The address and token come from the QUERY string on both methods, so RFC 8058 one-click — which
 * POSTs the link with an `List-Unsubscribe=One-Click` body and no session — works unchanged.
 */
export async function unsubscribePostView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const result = await handleUnsubscribePost(
    request.query.e ?? '',
    request.query.t ?? ''
  );
  return text(result.body, result.status, result.contentType);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /call-llm-outbound/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one outbound turn. The FE's endpoint, and the same entry point the cron and the email webhook
 * reach in-process through `runOutboundLlm`.
 *
 * `provider` defaults to `'unipile'` as the source does, and `admin_trigger_source` is left to the
 * caller — an HTTP request defaults to `'human'`, which is the only trigger authoritative on timing.
 * The 202 is not an error: it means the message was queued behind a turn already running for the chat.
 *
 * ## `phone_number` OR `chat_id`, and the namespace is what makes it outbound
 *
 * This is the one piece of view logic Phase 8b⁴ could not absorb, because `runOutboundTurn` takes a
 * resolved `chatId`. The source's outbound edit is called out in its own comment: the FE posts the same
 * payload it posts to the inbound endpoint — `phone_number`, no `chat_id` — so the view derives the
 * chat id itself, and derives the **namespaced** `outbound__{agent}__{number}` id that
 * initiate-outbound created rather than minting a fresh inbound `{agent}__{number}` one. Without the
 * prefix the FE would open a second, empty, inbound-shaped chat for a prospect who already has one.
 *
 * An explicit `chat_id` wins, which is how the cron and the email webhook invoke it. The source's third
 * branch — `group_chat`, resolving a Unipile group by `unipile_chat_id` — is inbound and not ported.
 *
 * The `phone_number` is used verbatim, exactly as the source uses it, so it has to arrive in the same
 * form enrollment stored — `contact_information.phone_number`, trimmed and nothing else. A differently
 * punctuated number derives a different id and the turn runs against an empty chat.
 */
export async function callLlmOutboundView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const message = String(body.message ?? '');
  const agentId = String(body.agent_id ?? '');
  const chatIdIn = String(body.chat_id ?? '');
  const phoneNumber = String(body.phone_number ?? '');

  // Validated here rather than in the turn, because "phone_number OR chat_id" is a property of the
  // REQUEST — by the time the turn runs, only a chat id exists.
  const missing = [
    !message && 'message',
    !agentId && 'agent_id',
    !chatIdIn && !phoneNumber && 'phone_number or chat_id',
  ].filter(Boolean);
  if (missing.length > 0) {
    return json(
      { error: `Missing required fields: ${missing.join(', ')}` },
      400
    );
  }

  const chatId =
    chatIdIn || 'outbound__' + buildDeterministicChatId(agentId, phoneNumber);

  const { status, ...payload } = await runOutboundTurn({
    message,
    agentId,
    chatId,
    attendeeId: (body.attendee_id as string | null) ?? null,
    accountId: (body.account_id as string | null) ?? null,
    provider: String(body.provider ?? 'unipile'),
    adminTriggerSource: String(body.admin_trigger_source ?? 'human'),
  });
  return json(payload, status);
}
