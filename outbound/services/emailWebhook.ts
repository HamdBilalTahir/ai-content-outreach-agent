/**
 * The inbound email-reply webhook — how a prospect's reply reaches the agent.
 *
 * This is the handler; the HTTP route is Phase 10. Structurally it is an ordered chain of exits, and
 * the ORDER is the design: each one below must be checked before the one after it, because the later
 * step would do the wrong thing for a message the earlier step owns.
 *
 * ## The exits, in order, and why each precedes the next
 *
 *  1. **No parseable sender** — nothing can be resolved. A 400.
 *  2. **No matching outbound chat** — a 200 with `success: false`. Never an error status: SendGrid
 *     retries non-2xx, and an unmatched address will never match on a retry.
 *  3. **Not an outbound chat** — defence in depth. The matcher is already outbound-strict; this guards
 *     any other path from letting the outbound agent drive someone else's conversation.
 *  4. **Email opt-out** — BEFORE any reply, because an opt-out must never receive an LLM answer.
 *  5. **Suppressed sender re-initiating** — the content was not an opt-out (step 4 established that),
 *     so this is a suppressed address writing to us. Policy-gated; default is notify-only.
 *  6. **Meeting declined** — only meaningful on a booked chat, and it must precede the normal reply
 *     because a decline email's body is usually EMPTY. Replying to blank text produces nothing useful,
 *     so the turn is driven by an `@AI` instruction instead.
 *  7. **Paused chat** — a full freeze. Log and alert, but no turn, no stage bump, no nudge cancellation.
 *
 * Only past all seven does a reply become a normal turn.
 *
 * ## Sender resolution handles forwarded mail
 *
 * On forwarded or redirected mail the top-level `from` is rewritten to the mailbox address, so the real
 * prospect appears only in `Reply-To`, the SMTP envelope, or the raw headers. All are collected into an
 * ordered, de-duplicated candidate list. Matching is by `memory.customer_email`, so non-prospect
 * addresses fall out naturally — the order only has to surface the real sender somewhere.
 *
 * ## The unsub mailbox is a content-independent opt-out signal
 *
 * A List-Unsubscribe one-click `mailto:` often carries NO opt-out words at all, so body matching alone
 * would miss it. Delivery TO the unsub mailbox is therefore its own trigger, checked alongside the
 * text match on the customer's newly-typed content (with quoted history stripped, so our own CAN-SPAM
 * footer cannot trip it).
 *
 * ## Only the webhook writes the threading anchor
 *
 * `_last_inbound_email_message_id` and `_last_inbound_email_at` are set here and nowhere else. The send
 * path must never write them, or a follow-up with no customer reply would thread as a reply and claim
 * the reply gate's exemptions.
 *
 * ## Not ported
 *
 * The web-chat fallback: it calls `handle_web_email_reply` in `inbound_email_nudge`, an inbound
 * web-widget service that refuses outbound chats — see plan revision 7. An unmatched address falls
 * through to exit 2 instead, which is what the source does when no web chat matches either.
 */

import { db } from '../firebase/db';
import {
  addLabelToChat,
  deleteUnexecutedTasksByType,
  getMemory,
  setMemory,
} from '../firebase/chat';
import { setProspectStage } from '../firebase/prospect';
import { getAgentActions } from '../firebase/agent';
import {
  clearCadenceComplete,
  getOutboundChatByEmail,
  logEmailActivity,
  logEmailMessage,
  logInboundEmailToHistory,
  logInternalNote,
  resetFollowupCounts,
} from './chat';
import {
  emailOptOutDetected,
  handleSuppressedReinitiation,
  notifyOps,
  reviewEmail,
} from './emailReview';
import { isSuppressed, suppress } from './suppression';
import { resolveSendgridConfig } from './sendgridMail';
import { deletePendingReminders } from './reminders';
import { runOutboundLlm } from '../llm/turn';
import { envStr } from '../config';

/** SendGrid Inbound Parse delivers a flat form payload; only the fields read here are named. */
export type InboundEmailPayload = Record<string, unknown>;

export interface EmailWebhookResult {
  success: boolean;
  status: number;
  chat_id?: string;
  sender?: string;
  error?: string;
  candidates?: string[];
  email_opt_out?: boolean;
  suppressed?: string;
  action?: string;
  meeting_declined?: boolean;
  paused?: boolean;
  agent?: unknown;
}

const RE_PREFIX = /^((re|fwd|fw)\s*:\s*)+/i;
const DECLINE_SUBJECT = /^\s*(re:\s*|fwd:\s*)*declined:/i;

/** Strip leading `Re:`/`Fwd:` so a canonical thread subject is stored once. */
export function stripRePrefix(subject: string | null | undefined): string {
  return String(subject ?? '')
    .replace(RE_PREFIX, '')
    .trim();
}

/**
 * Extract the bare address from a header value like `"Jane Doe" <jane@corp.com>`.
 *
 * A minimal stand-in for Python's `parseaddr`. Returns `''` when there is nothing address-shaped, so
 * callers can filter without a separate validity check.
 */
export function parseAddress(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const angled = s.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : s).trim().replace(/^["']|["']$/g, '');
  return candidate.includes('@') ? candidate.toLowerCase() : '';
}

/**
 * Parse the raw RFC 822 header blob into a multimap.
 *
 * Values are arrays because the headers that matter here REPEAT: forwarded mail carries several
 * `Message-ID` and `Delivered-To` lines, and the first one is the original. Continuation lines
 * (leading whitespace) are folded back onto the previous header, as the spec requires.
 */
export function parseRawHeaders(
  raw: string | null | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const text = String(raw ?? '');
  if (!text.trim()) return out;

  let currentKey = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) && currentKey) {
      const list = out[currentKey];
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    (out[currentKey] ??= []).push(value);
  }
  return out;
}

function headerValues(
  headers: Record<string, string[]>,
  name: string
): string[] {
  return headers[name.toLowerCase()] ?? [];
}

/**
 * Ordered, de-duplicated candidate sender addresses.
 *
 * See the module note: on forwarded mail the real prospect is not in `from`.
 */
export function senderCandidates(
  data: InboundEmailPayload,
  headers: Record<string, string[]>
): string[] {
  const raw: Array<unknown> = [data.from, data['reply-to'] ?? data['Reply-To']];

  const env = data.envelope;
  if (env) {
    try {
      const obj = (typeof env === 'string' ? JSON.parse(env) : env) as Record<
        string,
        unknown
      >;
      raw.push(obj.from);
    } catch {
      // A malformed envelope just contributes no candidate.
    }
  }
  for (const h of [
    'Reply-To',
    'From',
    'X-Forwarded-For',
    'Delivered-To',
    'Return-Path',
  ]) {
    raw.push(...headerValues(headers, h));
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const addr = parseAddress(item as string);
    if (addr && !seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

/** Every address this mail was delivered to. `envelope.to` is the real RCPT; the rest are fallbacks. */
export function recipientAddresses(
  data: InboundEmailPayload,
  headers: Record<string, string[]>
): Set<string> {
  const recips = new Set<string>();

  const env = data.envelope;
  if (env) {
    try {
      const obj = (typeof env === 'string' ? JSON.parse(env) : env) as Record<
        string,
        unknown
      >;
      for (const t of (obj.to ?? []) as string[]) {
        const a = parseAddress(t);
        if (a) recips.add(a);
      }
    } catch {
      // Same as above.
    }
  }
  for (const rawTo of [data.to, data.To]) {
    for (const part of String(rawTo ?? '').split(',')) {
      const a = parseAddress(part);
      if (a) recips.add(a);
    }
  }
  for (const h of ['To', 'Delivered-To', 'X-Delivered-To']) {
    for (const value of headerValues(headers, h)) {
      const a = parseAddress(value);
      if (a) recips.add(a);
    }
  }
  return recips;
}

/**
 * Was this delivered to the agent's unsubscribe mailbox?
 *
 * The clean, content-independent signal for a List-Unsubscribe one-click mailto. Falls back to a
 * local-part convention so an agent with no configured mailbox still honours `unsub@` / `unsubscribe@`.
 */
export async function addressedToUnsub(
  data: InboundEmailPayload,
  headers: Record<string, string[]>,
  agentId: string | null | undefined
): Promise<boolean> {
  const recips = recipientAddresses(data, headers);
  if (recips.size === 0) return false;

  let unsub = '';
  try {
    if (agentId) {
      const cfg = resolveSendgridConfig((await getAgentActions(agentId)) ?? []);
      unsub = String(cfg.unsub_mailto ?? '')
        .trim()
        .toLowerCase();
    }
  } catch {
    unsub = '';
  }
  if (!unsub) unsub = envStr('UNSUB_MAILTO').trim().toLowerCase();
  if (unsub && recips.has(unsub)) return true;

  return [...recips].some((a) =>
    ['unsub', 'unsubscribe'].includes(a.split('@')[0])
  );
}

/**
 * Is this a calendar DECLINE of the demo?
 *
 * Two signals. The iMIP subject (`Declined: …`) is always present and reliable. The `.ics` payload —
 * `METHOD:REPLY` with `PARTSTAT=DECLINED` — is stronger but only available when Inbound Parse delivers
 * the attachment. Callers gate this on `meeting_booked`, so it only fires for a chat that had one.
 */
export function isMeetingDecline(
  subject: string | null | undefined,
  body: string | null | undefined,
  data: InboundEmailPayload
): boolean {
  if (DECLINE_SUBJECT.test(String(subject ?? ''))) return true;

  let blob = String(body ?? '');
  try {
    for (const [k, v] of Object.entries(data ?? {})) {
      if (
        typeof v === 'string' &&
        (v.includes('BEGIN:VCALENDAR') || k.toLowerCase().includes('calendar'))
      ) {
        blob += `\n${v}`;
      }
    }
  } catch {
    // A odd payload just means we rely on the subject signal.
  }
  const up = blob.toUpperCase();
  return up.includes('METHOD:REPLY') && up.includes('PARTSTAT=DECLINED');
}

/** The threading anchor + freshness stamp. Only this webhook writes them — see the module note. */
async function recordThreadAnchor(
  chatId: string,
  data: InboundEmailPayload,
  headers: Record<string, string[]>,
  memory: Record<string, unknown>
): Promise<void> {
  try {
    // The FIRST Message-ID in a preserved chain is the original; a forwarder may prepend its own.
    const ids = headerValues(headers, 'Message-ID');
    const msgId = String(ids[0] ?? data['message-id'] ?? '').trim();
    if (!msgId) return;

    const refs = String(memory._email_references ?? '').trim();
    const updates: Record<string, unknown> = {
      _last_inbound_email_message_id: msgId,
      // The send gate treats a thread as a true reply only within its freshness window; a stale
      // thread keeps the headers but gates as outreach.
      _last_inbound_email_at: new Date().toISOString(),
      _email_references: refs.includes(msgId)
        ? refs
        : `${refs} ${msgId}`.trim(),
    };
    if (!memory._email_thread_subject) {
      const subj = stripRePrefix(
        String(data.subject ?? headerValues(headers, 'Subject')[0] ?? '')
      );
      if (subj) updates._email_thread_subject = subj;
    }
    await setMemory(chatId, updates);
  } catch {
    // Threading is a nicety; losing it must not cost the reply.
  }
}

/**
 * Handle one inbound email.
 *
 * Returns a result whose `status` mirrors the source view's HTTP code. Note that "no match" is a **200**:
 * SendGrid retries non-2xx deliveries, and an address that matched nothing will not match on a retry.
 */
export async function handleInboundEmail(
  data: InboundEmailPayload,
  agentIdQuery?: string | null
): Promise<EmailWebhookResult> {
  const headers = parseRawHeaders(data.headers as string);
  const body = String(data.text ?? data.html ?? '').trim();
  const subject = String(data.subject ?? '').trim();

  const candidates = senderCandidates(data, headers);
  console.log(
    `[OB_EMAIL] inbound POST from=${JSON.stringify(data.from)} subject=${JSON.stringify(subject)} ` +
      `candidates=${JSON.stringify(candidates)}`
  );

  // EXIT 1 — nothing address-shaped anywhere.
  if (candidates.length === 0) {
    return { success: false, status: 400, error: 'could not parse sender' };
  }

  // The prospect's real address matches memory.customer_email; a mailbox or forwarder address will not.
  let chatId: string | null = null;
  let senderEmail = '';
  for (const cand of candidates) {
    const cid = await getOutboundChatByEmail(cand, agentIdQuery ?? null);
    if (cid) {
      chatId = cid;
      senderEmail = cand;
      break;
    }
  }

  // EXIT 2 — no outbound chat. A 200: a retry cannot make this match.
  if (!chatId) {
    console.warn(
      `[OB_EMAIL] NO MATCH — candidates=${JSON.stringify(candidates)} agent_id_q=${JSON.stringify(agentIdQuery)}`
    );
    return {
      success: false,
      status: 200,
      error: 'no matching outbound chat',
      candidates,
    };
  }

  // One read: `agentId` is ALWAYS the top-level key — memory.agent_id is not reliably set, and reading
  // it there is what made replies arrive but never process ("Missing required fields: agent_id").
  const snap = await db.collection('chats').doc(chatId).get();
  const chatData = snap.exists ? (snap.data() ?? {}) : {};
  const memory = (chatData.memory ?? (await getMemory(chatId)) ?? {}) as Record<
    string,
    unknown
  >;
  const agentId = String(chatData.agentId ?? memory.agent_id ?? '');
  console.log(
    `[OB_EMAIL] matched chat=${chatId} sender=${senderEmail} agent_id=${agentId}`
  );

  // EXIT 3 — defence in depth. The outbound agent must never drive a non-outbound chat.
  if (chatData.type !== 'outbound') {
    console.warn(
      `[OB_EMAIL] matched chat is not outbound (type=${JSON.stringify(chatData.type)}) — skipping LLM run`
    );
    return {
      success: true,
      status: 200,
      chat_id: chatId,
      sender: senderEmail,
      agent: { skipped: 'not an outbound chat' },
    };
  }
  if (!agentId) {
    console.warn(
      `[OB_EMAIL] cannot resolve agentId for chat=${chatId} — skipping LLM run`
    );
  }

  // EXIT 4 — opt-out, BEFORE any reply. Either signal fires: delivery to the unsub mailbox (content
  // independent), or opt-out language in the customer's newly-typed text.
  try {
    const viaUnsubMailbox = await addressedToUnsub(data, headers, agentId);
    if (
      viaUnsubMailbox ||
      (await emailOptOutDetected(subject, body, { agent_id: agentId }))
    ) {
      const reason = viaUnsubMailbox
        ? 'opted-out-via-unsub-mailbox'
        : 'opted-out-by-reply';
      await setMemory(chatId, { _email_opt_out: true });
      try {
        // The trustworthy chat-doc TOP-LEVEL key the deterministic gates read.
        await db
          .collection('chats')
          .doc(chatId)
          .update({ email_opt_out: true });
      } catch (e) {
        console.warn(
          `[OB_EMAIL] top-level email_opt_out set failed for ${chatId}: ${e}`
        );
      }
      try {
        // The global suppression store is the single source of truth the send gate reads.
        await suppress(senderEmail, reason, 'email-webhook');
      } catch (e) {
        console.warn(
          `[OB_EMAIL] suppression write failed for ${senderEmail}: ${e}`
        );
      }
      try {
        await addLabelToChat(chatId, 'email_opted_out');
      } catch (e) {
        console.warn(`[OB_EMAIL] opt-out label failed for ${chatId}: ${e}`);
      }
      try {
        // EMAIL channel only — the phone cadence is untouched and the prospect is not Lost.
        const cancelled = await deleteUnexecutedTasksByType(
          chatId,
          'followup_if_no_reply'
        );
        console.log(
          `[OB_EMAIL] email opt-out for ${chatId} — flagged _email_opt_out, ` +
            `cancelled ${cancelled} email nudge(s); phone channel kept`
        );
      } catch (e) {
        console.warn(
          `[OB_EMAIL] opt-out nudge cancel failed for ${chatId}: ${e}`
        );
      }
      await logEmailMessage(chatId, body, 'inbound', subject);
      await logEmailActivity(chatId, 'unsubscribe', senderEmail, subject);
      try {
        const name =
          String((await getMemory(chatId))?.first_name ?? '').trim() ||
          senderEmail;
        await logInternalNote(
          chatId,
          `${name} unsubscribed from emails — email channel opted out.`
        );
      } catch (e) {
        console.warn(`[OB_EMAIL] unsubscribe note failed for ${chatId}: ${e}`);
      }
      // No turn runs, so persist to the model history explicitly — otherwise a later admin
      // "@ai read the inbound email and reply" cannot see it.
      await logInboundEmailToHistory(chatId, body, subject);
      return {
        success: true,
        status: 200,
        chat_id: chatId,
        sender: senderEmail,
        email_opt_out: true,
      };
    }
  } catch (e) {
    console.warn(
      `[OB_EMAIL] opt-out check failed for ${chatId} (continuing): ${e}`
    );
  }

  // EXIT 5 — a suppressed address writing to us, and step 4 established the content is NOT an opt-out.
  try {
    const entry = await isSuppressed(senderEmail);
    if (entry) {
      await logEmailMessage(chatId, body, 'inbound', subject);
      const policyOn =
        envStr('EMAIL_REACTIVATION_POLICY_ENABLED', 'false').toLowerCase() ===
        'true';
      if (policyOn) {
        const decision = await handleSuppressedReinitiation(
          chatId,
          agentId,
          senderEmail,
          entry
        );
        if (!decision.lifted) {
          await logInboundEmailToHistory(chatId, body, subject);
          return {
            success: true,
            status: 200,
            chat_id: chatId,
            sender: senderEmail,
            suppressed: entry.reason,
            action: decision.action,
          };
        }
        // Lifted → fall through to the normal reply flow. The send gate reads the reactivation just
        // written, and Firestore document reads are strongly consistent.
      } else {
        console.warn(
          `[OB_EMAIL] suppressed sender ${senderEmail} re-initiated (${entry.reason}) — ` +
            'reactivation policy OFF, notifying ops'
        );
        try {
          await notifyOps(chatId, senderEmail, entry);
        } catch {
          // The alert is best-effort; the conservative no-reply outcome still holds.
        }
        await logInboundEmailToHistory(chatId, body, subject);
        return {
          success: true,
          status: 200,
          chat_id: chatId,
          sender: senderEmail,
          suppressed: entry.reason,
          action: 'notified',
        };
      }
    }
  } catch (e) {
    console.warn(
      `[OB_EMAIL] suppressed-sender check failed for ${chatId} (continuing): ${e}`
    );
  }

  // EXIT 6 — a calendar decline. Precedes the normal reply because the decline email's body is
  // usually EMPTY, so the turn is driven by an instruction rather than the (blank) reply text.
  try {
    if (
      memory.meeting_booked === true &&
      isMeetingDecline(subject, body, data)
    ) {
      await setMemory(chatId, {
        meeting_declined: true,
        meeting_declined_at: new Date().toISOString(),
      });
      try {
        const cleared = await deletePendingReminders(chatId);
        console.log(
          `[OB_EMAIL] meeting DECLINED for ${chatId} — cleared ${cleared} reminder(s)`
        );
      } catch (e) {
        console.warn(
          `[OB_EMAIL] reminder clear on decline failed for ${chatId}: ${e}`
        );
      }
      try {
        await logEmailMessage(
          chatId,
          body || '(calendar decline)',
          'inbound',
          subject
        );
        await logEmailActivity(
          chatId,
          'meeting_declined',
          senderEmail,
          subject
        );
      } catch {
        // Audit only.
      }

      const demo = memory.meeting_at ?? 'the scheduled time';
      let result: unknown;
      if (agentId) {
        const instruction =
          `@AI The prospect DECLINED the demo calendar invite (was ${demo}). Reach ` +
          'out — call if a phone is reachable, otherwise email — to ask why they ' +
          "declined and offer to reschedule; if they're no longer interested, " +
          'mark_lost with a reason.';
        try {
          result = await runOutboundLlm(instruction, agentId, chatId, {
            provider: 'email',
            attendeeId: String(memory.phone_number ?? senderEmail),
          });
        } catch (e) {
          console.error(
            `[OB_EMAIL] decline follow-up run failed for ${chatId}: ${e}`
          );
          result = { error: String(e) };
        }
      } else {
        await logInboundEmailToHistory(chatId, body, subject);
        result = { skipped: 'no agentId' };
      }
      return {
        success: true,
        status: 200,
        chat_id: chatId,
        sender: senderEmail,
        meeting_declined: true,
        agent: result,
      };
    }
  } catch (e) {
    console.warn(
      `[OB_EMAIL] decline handling failed for ${chatId} (continuing): ${e}`
    );
  }

  // EXIT 7 — a paused chat is a full freeze: log and alert, but no turn, no stage bump, and NO nudge
  // cancellation. It stays paused until someone resumes it explicitly.
  if (chatData.status === 'paused') {
    try {
      await logEmailMessage(chatId, body, 'inbound', subject);
      await logInboundEmailToHistory(chatId, body, subject);
    } catch {
      // Audit only.
    }
    try {
      await db
        .collection('technical_alerts')
        .doc()
        .set({
          dealers_id: String(memory.dealers_id ?? memory.dealer_id ?? ''),
          company_id: String(memory.company_id ?? ''),
          chat_id: chatId,
          type: 'paused_chat_inbound_reply',
          message:
            `Paused chat got an inbound email reply from ${senderEmail} — ` +
            'resume it to let the agent reply.',
          details: { subject },
          severity: 'medium',
          created_at: new Date(),
        });
    } catch (e) {
      console.warn(`[OB_EMAIL] paused-chat alert failed for ${chatId}: ${e}`);
    }
    console.log(
      `[OB_EMAIL] chat ${chatId} is PAUSED — logged inbound reply + alert, no LLM run`
    );
    return {
      success: true,
      status: 200,
      chat_id: chatId,
      sender: senderEmail,
      paused: true,
    };
  }

  // Past every exit: a real reply from an engaged prospect.
  await setProspectStage(
    chatId,
    'Engaged',
    'incoming_email',
    String(memory.dealers_id ?? memory.dealer_id ?? ''),
    String(memory.company_id ?? '')
  );
  try {
    // A reply reopens the chat and restarts the cadence at #1 after any later quiet spell.
    await resetFollowupCounts(chatId);
    await clearCadenceComplete(chatId);
  } catch {
    // Non-blocking.
  }

  try {
    const cancelled = await deleteUnexecutedTasksByType(
      chatId,
      'followup_if_no_reply'
    );
    if (cancelled) {
      console.log(
        `[OB_EMAIL] cancelled ${cancelled} pending followup_if_no_reply task(s) for ${chatId} (customer replied)`
      );
    }
  } catch (e) {
    console.warn(
      `[OB_EMAIL] failed to cancel followup_if_no_reply tasks for ${chatId}: ${e}`
    );
  }
  // Phase 9: syncHubspotStage mirrors the Engaged transition.

  await recordThreadAnchor(chatId, data, headers, memory);

  try {
    await logEmailMessage(chatId, body, 'inbound');
    await logEmailActivity(chatId, 'reply', senderEmail, subject);
  } catch {
    // Audit only.
  }

  let result: unknown;
  if (!agentId) {
    await logInboundEmailToHistory(chatId, body, subject);
    result = { skipped: 'no agentId on chat' };
  } else {
    try {
      result = await runOutboundLlm(body, agentId, chatId, {
        provider: 'email',
        attendeeId: String(memory.phone_number ?? senderEmail),
      });
    } catch (e) {
      console.error(`[OB_EMAIL] runOutboundLlm failed for ${chatId}: ${e}`);
      result = { error: String(e) };
    }
    try {
      // Runs AFTER the turn, so the thread has both sides. Best-effort — it must never break a reply
      // that has already gone out.
      await reviewEmail(chatId, agentId, { agent_id: agentId });
    } catch (e) {
      console.warn(`[OB_EMAIL] reviewEmail failed for ${chatId}: ${e}`);
    }
  }

  return {
    success: true,
    status: 200,
    chat_id: chatId,
    sender: senderEmail,
    agent: result,
  };
}
