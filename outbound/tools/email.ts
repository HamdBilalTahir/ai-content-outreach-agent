/**
 * The outbound `send_email` tool.
 *
 * Keeps the same tool NAME as inbound so existing Firestore skill and action configs keep resolving,
 * while the implementation lives here. Sends through the unified choke point — every compliance,
 * suppression, breaker, budget and verification gate lives there, not here — and advances the outbound
 * funnel to `Contacted` on a successful send.
 *
 * ## What this module owns: three deterministic gates on the LLM's copy
 *
 * The model composes the body, so these gates exist to stop it asserting things we cannot back:
 *
 *  1. **Booking confirmation.** An email claiming a confirmed meeting may only go out when a booking
 *     actually succeeded (`memory.meeting_booked`, written only by the booking finalizer). This stops a
 *     "your demo is confirmed" email going out after the booking call failed.
 *  2. **No-answer premise.** A "couldn't reach you" email requires a FRESH unanswered call on record.
 *     A deferred no-answer email detached from any recent call is dropped; the call cadence re-attempts
 *     and re-stamps the window. Email-only and phone-opted-out contacts are exempt, because there is no
 *     call for the email to be tied to.
 *  3. **Missing join link.** A confirmation or reminder gets the meeting link appended when the body
 *     omits it. The link must never depend on the model remembering to paste it — otherwise the customer
 *     gets a "Demo confirmed" email they cannot act on, even though the booking set the link in the same
 *     turn.
 *
 * ## Threading is anchored to the customer's real Message-ID
 *
 * A reply threads in-thread ONLY when the webhook captured the customer's actual RFC822 Message-ID. That
 * anchor is written by the webhook and never clobbered here with the provider's internal message id,
 * which is a different identifier and would thread to nothing.
 *
 * ## Deferred
 *
 * The post-send HubSpot stage sync arrives with the HubSpot phase; it is best-effort CRM mirroring in the
 * source and does not affect the send outcome or the funnel advance.
 */

import { getMemory, setMemory } from '../firebase/chat';
import { setProspectStage } from '../firebase/prospect';
import { toHtml, toText } from '../services/emailFormat';
import { resolveSendgridConfig } from '../services/sendgridMail';
import {
  ORIGIN_LLM_TOOL,
  PROFILE_TRANSACTIONAL,
  sendEmail,
} from '../services/emailSender';
import {
  NO_ANSWER_MAX_AGE_HOURS,
  PEWC_DISCLOSURE_MARKER,
  isBookingConfirmation,
  isNoAnswerEmail,
  isReminderEmail,
  stripRePrefix,
} from '../services/emailText';
import {
  bumpFollowupCount,
  isOutboundChat,
  logEmailMessage,
} from '../services/chat';
import { deletePendingOutboundOutreach } from '../services/scheduling';
import { markContacted } from '../services/enroll';
import { registerTool } from '../llm/toolRegistry';
import type { AgentAction } from '../firebase/agent';
import type { BedrockMessage, ChatMemory } from '../types';

/** The tool spec, in the wire format the model's tool config expects. */
export const emailToolDescription = {
  toolSpec: {
    name: 'send_email',
    description:
      'Send an email to the prospect now — use this for outbound outreach emails, no-reply follow-up ' +
      'nudges, overviews, and meeting confirmations. Provide the recipient, a subject line, and the body.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          to: { type: 'string', description: "The recipient's email address" },
          subject: {
            type: 'string',
            description: 'The subject line of the email',
          },
          body: { type: 'string', description: 'The content of the email' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
} as const;

// Register with the model layer's tool registry at module load, so the agent can call this tool the
// moment the module is imported — no separate wiring step, and no list here to drift out of sync.
registerTool(emailToolDescription.toolSpec.name, emailToolDescription);

export interface EmailToolInput {
  to?: string;
  subject?: string;
  body?: string;
}

export interface EmailToolMeta {
  is_playground?: boolean;
  actions?: AgentAction[] | null;
  chat_id?: string | null;
  agent_id?: string | null;
}

/** Wrap a result payload in the tool-result envelope the turn loop expects. */
function toolResult(
  toolUseId: string,
  json: Record<string, unknown>
): BedrockMessage {
  return {
    role: 'user',
    content: [{ toolResult: { toolUseId, content: [{ json }] } }],
  } as BedrockMessage;
}

/**
 * A phone is on file and not opted out, so a call is a real fallback and the no-answer email should be
 * tied to a recent one. Email-only and phone-opted-out contacts are exempt.
 */
function phoneReachable(memory: ChatMemory | null | undefined): boolean {
  const m = memory ?? {};
  if (!String(m.phone_number ?? '').trim()) return false;
  if (
    String(m.block_phone ?? '')
      .trim()
      .toUpperCase() === 'Y'
  )
    return false;
  if (
    String(m.phone_opt_out ?? '')
      .trim()
      .toUpperCase() === 'Y'
  )
    return false;
  return true;
}

/**
 * True when an unanswered call is on record within the freshness window.
 *
 * Fails CLOSED for this gate specifically: a missing or unparseable stamp counts as NOT fresh, because
 * the alternative is sending an email whose stated premise never happened.
 */
function lastUnansweredCallFresh(
  memory: ChatMemory | null | undefined
): boolean {
  const raw = (memory ?? {})._last_call_unanswered_at;
  if (!raw) return false;
  try {
    let s = String(raw).replace('Z', '+00:00');
    if (!/(?:[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
    const ts = new Date(s);
    if (Number.isNaN(ts.getTime())) return false;
    return Date.now() - ts.getTime() <= NO_ANSWER_MAX_AGE_HOURS * 3_600_000;
  } catch {
    return false;
  }
}

/** Run the `send_email` tool. */
export async function parseAndRunSendEmail(
  toolUseId: string,
  input: EmailToolInput,
  metaData: EmailToolMeta = {}
): Promise<BedrockMessage> {
  const to = input.to ?? '';
  let subject = input.subject ?? '';
  let body = input.body ?? '';

  const isPlayground = Boolean(metaData.is_playground);
  const actions = metaData.actions ?? [];
  const chatId = metaData.chat_id ?? null;

  const cfg = resolveSendgridConfig(actions);

  let memory: ChatMemory = {};
  if (chatId) {
    try {
      memory = (await getMemory(chatId)) ?? {};
    } catch {
      memory = {};
    }
  }

  // GATE 1 — never claim a booked meeting without one on record.
  const isConfirmation = isBookingConfirmation(subject, body);
  if (isConfirmation && memory.meeting_booked !== true) {
    console.warn(
      `[EMAIL] blocked booking-confirmation email to=${to} chat=${chatId}: ` +
        `no successful booking on record (meeting_booked not set)`
    );
    return toolResult(toolUseId, {
      status: 'blocked',
      recipient: to,
      message:
        'Meeting is NOT booked yet, so a confirmation email cannot be sent. Call ' +
        'schedule_hubspot_meeting first; only after it returns success (which sets ' +
        'hubspot_meeting_link) send the confirmation email, and include that link.',
    });
  }

  // GATE 2 — a no-answer email needs a fresh unanswered call behind it.
  if (
    isNoAnswerEmail(subject, body) &&
    phoneReachable(memory) &&
    !lastUnansweredCallFresh(memory)
  ) {
    console.log(
      `[EMAIL] blocked no-answer email to=${to} chat=${chatId}: no unanswered call within ` +
        `${NO_ANSWER_MAX_AGE_HOURS}h on record`
    );
    return toolResult(toolUseId, {
      status: 'blocked',
      recipient: to,
      message:
        `A 'couldn't reach you' email requires an unanswered call within the last ` +
        `${NO_ANSWER_MAX_AGE_HOURS}h, but none is on record. Do not send it now — place ` +
        `(or wait for) a call first per your outbound skill; this email becomes valid ` +
        `right after an unanswered attempt.`,
    });
  }

  // Threading, anchored only to the customer's real Message-ID.
  const inboundMid =
    memory._last_inbound_email_message_id ?? memory._last_email_message_id;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (inboundMid) {
    inReplyTo = String(inboundMid);
    references =
      String(memory._email_references ?? '').trim() || String(inboundMid);
    // Keep the customer in the same visual thread under the canonical subject.
    const threadSubject =
      String(memory._email_thread_subject ?? '') || stripRePrefix(subject);
    subject = threadSubject ? `Re: ${threadSubject}` : subject;
  }

  const agentId = String(metaData.agent_id ?? memory.agent_id ?? 'outbound');

  // A genuine confirmation or a pre-demo reminder is CAN-SPAM transactional: it sends off the outreach
  // budget so cold outreach does not compete with committed-demo mail. Both require an actual booking —
  // gate 1 already returned otherwise for a confirmation.
  const isReminder =
    isReminderEmail(subject, body) && memory.meeting_booked === true;
  const profile = isConfirmation || isReminder ? PROFILE_TRANSACTIONAL : null;

  // GATE 3 — guarantee the join link deterministically.
  if (isConfirmation || isReminder) {
    const mlink = String(memory.hubspot_meeting_link ?? '').trim();
    if (mlink && !(body ?? '').includes(mlink)) {
      body = (body ?? '').trimEnd() + `\n\nJoin your demo here: ${mlink}`;
      console.log(
        `[EMAIL] injected missing meeting link into ` +
          `${isConfirmation ? 'confirmation' : 'reminder'} email chat=${chatId}`
      );
    }
  }

  // Multipart: rendered HTML plus a clean plain-text fallback. The model composes in Markdown, and
  // plain-text-only would show literal `**` and corrupt auto-linked URLs.
  const res = await sendEmail({
    to,
    subject,
    text: toText(body),
    html: toHtml(body),
    origin: ORIGIN_LLM_TOOL,
    profile,
    chatId,
    agentId,
    campaignId: memory.campaign_id ?? null,
    memory,
    fromEmail: cfg.from_email,
    fromName: cfg.from_name,
    inReplyTo,
    references,
    replyTo: cfg.reply_to,
    apiKey: cfg.api_key,
    senderCfg: cfg,
    isPlayground,
  });

  // The classification and gate outcome, surfaced on every tool result so the activity shows whether the
  // email cleared the pipeline and, if not, which gate stopped it.
  const emailLabel = {
    profile: res.profile,
    origin: res.origin,
    compliance: res.status === 'sent' ? 'passed' : 'blocked',
    status: res.status,
    reason: res.reason ?? '',
  };

  // A gate outcome comes back with explicit guidance: skips are terminal, and deferrals already have a
  // retry task, so the model should end the turn cleanly rather than improvise around the gate.
  if (res.status === 'deferred' || res.status === 'skipped') {
    const result: Record<string, unknown> = {
      status: res.status,
      recipient: to,
      reason: res.reason,
      message: res.message ?? '',
      email_label: emailLabel,
    };
    if (res.guidance) result.guidance = res.guidance;
    if (res.retry_at) result.retry_at = res.retry_at;
    return toolResult(toolUseId, result);
  }

  // New outreach: remember the canonical subject so later customer replies thread under it.
  if (chatId && !inboundMid && subject) {
    try {
      if (!memory._email_thread_subject) {
        await setMemory(chatId, {
          _email_thread_subject: stripRePrefix(subject),
        });
      }
    } catch {
      // Threading is cosmetic; a failure here must not fail the send.
    }
  }

  if (!res.success) {
    const reason = res.error ?? 'send failed';
    console.warn(`[EMAIL] sendEmail failed to=${to}: ${reason}`);
    return toolResult(toolUseId, {
      status: 'failed',
      recipient: to,
      error: reason,
      message: `Email NOT sent to ${to}: ${reason}`,
      email_label: emailLabel,
    });
  }

  const result: Record<string, unknown> = {
    status: 'sent',
    recipient: to,
    message_id: res.message_id,
    email_label: emailLabel,
  };

  if (chatId && !isConfirmation) {
    // The follow-up counter. The FIRST outbound email is touch #0, so it stamps the first-email anchor
    // the skill's cadence is measured from; every later email bumps the count. A booking confirmation is
    // transactional, not outreach, so it never counts. The skill owns timing; code owns the count.
    try {
      if (!memory._first_outbound_email_at) {
        await setMemory(chatId, {
          _first_outbound_email_at: new Date().toISOString(),
        });
      } else {
        await bumpFollowupCount(chatId, 'email');
      }
    } catch (e) {
      console.warn(
        `[EMAIL] email follow-up count update failed chat=${chatId}: ${e}`
      );
    }
    // The outreach is now DONE, so clear any pending first-touch task. The follow-up cadence the agent
    // schedules after this send takes over.
    try {
      await deletePendingOutboundOutreach(chatId);
    } catch (e) {
      console.warn(
        `[EMAIL] clear pending outreach after send failed chat=${chatId}: ${e}`
      );
    }
  }

  // PEWC bookkeeping: a SENT email carrying the disclosure IS a number-ask. Counted deterministically,
  // independent of the model, so the ≤2-ask cadence and the written-consent check can key on it.
  if (
    chatId &&
    (body ?? '').toLowerCase().includes(PEWC_DISCLOSURE_MARKER.toLowerCase())
  ) {
    try {
      const prior = Number(memory._phone_ask_count ?? 0);
      await setMemory(chatId, {
        _phone_ask_count: prior + 1,
        _phone_ask_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[EMAIL] _phone_ask_count bump failed chat=${chatId}: ${e}`);
    }
  }

  // Persist the sent email so the thread shows BOTH sides — the webhook logs inbound replies, this is
  // the outbound half.
  if (chatId) {
    try {
      await logEmailMessage(chatId, toText(body), 'outbound', subject, {
        profile: res.profile,
        origin: res.origin,
      });
    } catch {
      // Presentation only.
    }
  }

  // A sent outreach email IS the first user-facing contact, so advance to Contacted. The stage setter is
  // forward-only, so it never regresses an already-Engaged prospect.
  if (chatId && (await isOutboundChat(chatId))) {
    try {
      const mem = (await getMemory(chatId)) ?? {};
      await setProspectStage(
        chatId,
        'Contacted',
        'outbound_email_sent',
        String(mem.dealers_id ?? mem.dealer_id ?? ''),
        String(mem.company_id ?? '')
      );
      // Mark ACTUALLY contacted, which drives cross-campaign dedup and is set only on real outreach.
      try {
        await markContacted(chatId, mem.agent_id as string | undefined);
      } catch {
        // Best-effort.
      }
    } catch (e) {
      console.warn(
        `[EMAIL] outbound Contacted stage set failed chat=${chatId}: ${e}`
      );
    }
  }

  return toolResult(toolUseId, result);
}

/** Exposed for tests: the pure gate predicates. */
export const __testing = { phoneReachable, lastUnansweredCallFresh };
