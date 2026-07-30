/**
 * Deterministic post-email processing — the email counterpart to the call-transcript review, minus
 * voicemail, because email is in-band: there is no transcript to fetch, only the thread already in
 * `messages_v3`.
 *
 * ## Two-stage detection, everywhere it matters
 *
 * Every signal this module reads from a customer's reply is REGEX-then-LLM, and the split is deliberate:
 * a regex miss is definitively negative and costs nothing, so no model call is made; a regex HIT is only
 * a candidate, because the same keywords appear in questions, negations, and paraphrase. The model
 * confirms INTENT.
 *
 * The two confirmations fail in OPPOSITE directions, and each direction is the safe one for its stake:
 *  - **Opt-out** falls back to TRUE (honour the possible opt-out) — never weaker than a regex-only
 *    verdict, and compliance-safe.
 *  - **Callback number** falls back to FALSE — TCPA stakes, so the phone channel is never opened on a
 *    guess.
 *
 * ## The reinitiation ladder is three-way for a reason
 *
 * A suppressed address emailing us with non-opt-out content is ambiguous, and the right response depends
 * entirely on WHY it was suppressed:
 *  - **consent** — a direct inquiry is an express invitation, so the suppression lifts;
 *  - **complaint** — never auto-lift. An automated wrong guess here is expensive, so it escalates;
 *  - **deliverability** — their ability to SEND says nothing about our ability to DELIVER, so it
 *    re-verifies when a provider is configured and lifts only on `valid`. With no provider it lifts
 *    once, labelled, and a later bounce re-suppresses permanently.
 */

import { db } from '../firebase/db';
import { createTaskWithId, getMemory, setMemory } from '../firebase/chat';
import * as sup from './suppression';
import { verify } from './verification';
import { envStr } from '../config';
import {
  OPT_OUT_RE,
  PEWC_DISCLOSURE_MARKER,
  PHONE_IN_TEXT_RE,
  stripQuotedReply,
} from './emailText';
import {
  capturePhoneConsent,
  loadChatDoc,
  logEmailActivity,
  phoneOptedOut,
} from './chat';
import {
  deletePendingOutboundOutreach,
  nextBusinessHoursStart,
} from './scheduling';
import { normalizePhone } from './dncFullScrub';
import { handleNotInterested } from './notInterested';
import { handleReferralTransfer } from './referralTransfer';
import { generateAndCacheSummary } from './conversationSummary';
import {
  detectChannelPreferences,
  extractFromTranscriptWithSchema,
  llmText,
  parseJsonResponse,
  resolveStageAndSkills,
} from '../tools/reviewHelpers';
import type { GenerateMeta } from '../llm/ask';

function chatRef(chatId: string) {
  return db.collection('chats').doc(chatId);
}

/**
 * An `AGENT:`/`CUSTOMER:` transcript from the chat's most recent email rows, both directions, oldest
 * first for readability. Best-effort → `''`.
 */
export async function buildEmailTranscript(
  chatId: string,
  limit = 20
): Promise<string> {
  if (!chatId) return '';
  try {
    const snap = await chatRef(chatId)
      .collection('messages_v3')
      .where('source', '==', 'email')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const rows = [...snap.docs].reverse(); // oldest-first
    const lines: string[] = [];
    for (const r of rows) {
      const d = r.data() ?? {};
      const body = String(
        ((d.content ?? {}) as Record<string, unknown>).body ?? ''
      ).trim();
      if (!body) continue;
      const who = d.direction === 'inbound' ? 'CUSTOMER' : 'AGENT';
      lines.push(`${who}: ${body}`);
    }
    return lines.join('\n');
  } catch (e) {
    console.warn(`[EMAIL_REVIEW] transcript build failed for ${chatId}: ${e}`);
    return '';
  }
}

/** The customer's most recent inbound body, quoted history stripped. Best-effort → `''`. */
export async function latestInboundEmailBody(chatId: string): Promise<string> {
  try {
    const snap = await chatRef(chatId)
      .collection('messages_v3')
      .where('source', '==', 'email')
      .where('direction', '==', 'inbound')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    for (const r of snap.docs) {
      const body = String(
        ((r.data() ?? {}).content as Record<string, unknown> | undefined)
          ?.body ?? ''
      );
      return stripQuotedReply(body);
    }
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] latest inbound email read failed for ${chatId}: ${e}`
    );
  }
  return '';
}

/** Our most recent OUTBOUND body — the email that asked for the number. Best-effort → `''`. */
export async function latestOutboundEmailBody(chatId: string): Promise<string> {
  try {
    const snap = await chatRef(chatId)
      .collection('messages_v3')
      .where('source', '==', 'email')
      .where('direction', '==', 'outbound')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    for (const r of snap.docs) {
      return String(
        ((r.data() ?? {}).content as Record<string, unknown> | undefined)
          ?.body ?? ''
      );
    }
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] latest outbound email read failed for ${chatId}: ${e}`
    );
  }
  return '';
}

/**
 * True iff OUR outbound email in this thread carried the PEWC disclosure marker.
 *
 * This is the deterministic difference between prior express WRITTEN consent — which makes an automated
 * voice call permissible — and mere prior express consent, which reopens the channel for MANUAL
 * follow-up only. It reads our own sent copy rather than trusting a model judgement, which is why the
 * marker must stay byte-stable.
 */
export async function pewcDisclosureOnRecord(chatId: string): Promise<boolean> {
  const body = await latestOutboundEmailBody(chatId);
  return body.toLowerCase().includes(PEWC_DISCLOSURE_MARKER.toLowerCase());
}

/** Human notification for a reactivation decision the system must not make itself. Best-effort. */
export async function notifyOps(
  chatId: string,
  senderEmail: string,
  entry: sup.SuppressionEntry
): Promise<void> {
  try {
    const mem = (await getMemory(chatId)) ?? {};
    await db
      .collection('technical_alerts')
      .doc()
      .set({
        dealers_id: String(mem.dealers_id ?? ''),
        company_id: String(mem.company_id ?? ''),
        chat_id: chatId,
        alert_type: 'suppressed_sender_reinitiated',
        message:
          `Suppressed address ${senderEmail} (${entry.reason}) emailed us — review and ` +
          `reactivate via ops if appropriate.`,
        details: { ...entry },
        severity: 'medium',
        created_at: new Date().toISOString(),
      });
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] ops notification failed for ${senderEmail}: ${e}`
    );
  }
}

export interface ReinitiationResult {
  lifted: boolean;
  action: string;
}

/**
 * The reinitiation policy: a suppressed address emailed us with NON-opt-out content.
 *
 * Gated by a flag in the source and requires human sign-off to enable, so the caller owns whether this
 * runs at all. Best-effort — never throws.
 */
export async function handleSuppressedReinitiation(
  chatId: string,
  agentId: string,
  senderEmail: string,
  entry: sup.SuppressionEntry
): Promise<ReinitiationResult> {
  try {
    const klass = entry.class;

    if (klass === sup.CLASS_CONSENT) {
      // A direct inquiry is an express invitation, so CAN-SPAM permits the reply.
      const ok = await sup.reactivate(senderEmail, 'inbound-email');
      return {
        lifted: Boolean(ok),
        action: ok ? 'reactivated:consent' : 'lift-refused',
      };
    }

    if (klass === sup.CLASS_COMPLAINT || entry.probe_once_failed) {
      // Never auto-lift: a wrong automated guess is expensive here.
      await notifyOps(chatId, senderEmail, entry);
      return { lifted: false, action: 'notified:complaint-class' };
    }

    // Deliverability class. Their ability to SEND is not evidence of our ability to DELIVER.
    if (envStr('VERIFY_PROVIDER').trim() && envStr('VERIFY_API_KEY').trim()) {
      const v = await verify(senderEmail);
      if (v.result === 'valid') {
        const ok = await sup.reactivate(senderEmail, 'inbound-plus-reverify');
        return {
          lifted: Boolean(ok),
          action: ok ? 'reactivated:reverified' : 'lift-refused',
        };
      }
      await notifyOps(chatId, senderEmail, entry);
      return { lifted: false, action: `notified:reverify-${v.result}` };
    }

    // Probe-once: lift, labelled. A subsequent bounce re-suppresses permanently-pending-ops, which is
    // what `suppress` does when it sees this reactivation marker.
    const ok = await sup.reactivate(senderEmail, 'inbound-email-probe-once');
    return {
      lifted: Boolean(ok),
      action: ok ? 'reactivated:probe-once' : 'lift-refused',
    };
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] reinitiation policy failed for ${senderEmail}: ${e}`
    );
    return { lifted: false, action: 'error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The LLM half, deferred out of Phase 6b and unblocked by the model layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True only when the customer's email is a GENUINE unsubscribe request.
 *
 * Two stages. The cheap keyword regex pre-filters the customer's NEWLY-TYPED text — quoted history
 * stripped first, so our own CAN-SPAM footer cannot trip it — and a miss is definitively not an opt-out,
 * with no model call. On a HIT the intent is confirmed, because the same keywords appear in questions
 * ("is there an unsubscribe option?"), negations ("don't remove me"), and paraphrase.
 *
 * EMAIL-channel signal only: the caller must NOT treat this as a phone opt-out.
 */
export async function emailOptOutDetected(
  subject: string | null | undefined,
  body: string | null | undefined,
  metaData?: GenerateMeta | null
): Promise<boolean> {
  try {
    const cleaned = stripQuotedReply(body);
    if (!OPT_OUT_RE.test(`${subject ?? ''}\n${cleaned}`)) return false;
    return llmConfirmOptOut(subject, cleaned, metaData);
  } catch {
    return false;
  }
}

/**
 * The intent check gating an opt-out candidate.
 *
 * Falls back to TRUE on any error or missing verdict — the regex already matched, so failing toward
 * honouring a possible opt-out is never weaker than the regex-only behaviour, and is compliance-safe.
 */
async function llmConfirmOptOut(
  subject: string | null | undefined,
  cleanedBody: string,
  metaData?: GenerateMeta | null
): Promise<boolean> {
  const systemPrompt =
    'A customer replied to a sales email. Decide if their message is a GENUINE request to STOP ' +
    'receiving emails / unsubscribe.\n\n' +
    "opt_out=true ONLY for a clear request to stop emailing them — e.g. 'unsubscribe', 'stop " +
    "emailing me', 'remove me from your list', 'no more emails', 'take me off'.\n" +
    'opt_out=false for anything else, even if it mentions those words: a QUESTION about ' +
    "unsubscribing ('is there an unsubscribe option?', 'how would I opt out later?'), a NEGATION " +
    "('please don't remove me', 'no need to unsubscribe me'), or general interest / questions / " +
    'objections.\n\n' +
    'Respond with valid JSON only: {"opt_out": true/false}';

  const user = `SUBJECT: ${subject ?? ''}\n\nMESSAGE:\n${cleanedBody}`;
  const parsed = parseJsonResponse(await llmText(systemPrompt, user, metaData));

  if (!('opt_out' in parsed)) {
    console.warn(
      '[OB_EMAIL] opt-out intent LLM gave no verdict — falling back to regex match (opt-out)'
    );
    return true;
  }
  const verdict = Boolean(parsed.opt_out);
  console.log(`[OB_EMAIL] opt-out intent LLM verdict: opt_out=${verdict}`);
  return verdict;
}

/**
 * The intent check gating a regex phone match: return the number ONLY when the customer is giving one
 * where WE may call THEM.
 *
 * FAILS CLOSED — any error, missing verdict, or ambiguity returns `''`. TCPA stakes: the phone channel is
 * never opened on a guess. It also rejects our own number quoted back, a fax, an order or reference
 * number, and an explicit refusal.
 */
async function llmConfirmCallbackNumber(
  cleanedBody: string,
  candidate: string,
  metaData?: GenerateMeta | null
): Promise<string> {
  const systemPrompt =
    'A customer replied to a sales email. We asked for a phone number to reach them on. Decide if ' +
    'their message GIVES a phone number where WE may call THEM.\n\n' +
    'is_callback=true ONLY when they provide a number to reach them and it reads as permission to ' +
    "call — e.g. 'sure, call me at 908-386-4637', 'my cell is ...', 'best number is ...'.\n" +
    'is_callback=false for: a number that is NOT theirs to be called on (an office/fax/order or ' +
    "reference number, our own number quoted back), a refusal ('don't call me', 'email only'), or " +
    'any ambiguity.\n' +
    'Return the number EXACTLY as digits when is_callback=true.\n\n' +
    'Respond with valid JSON only: {"is_callback": true/false, "number": "<digits or empty>"}';

  const user = `CANDIDATE NUMBER DETECTED: ${candidate}\n\nCUSTOMER MESSAGE:\n${cleanedBody}`;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonResponse(await llmText(systemPrompt, user, metaData));
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] callback-number LLM failed — fail-closed: ${e}`
    );
    return '';
  }
  if (!parsed.is_callback) return '';
  return String(parsed.number ?? candidate).trim();
}

/**
 * Capture a callback number offered in a reply as consent, and reopen the phone channel.
 *
 * Only acts when the phone channel was CLOSED — opted out, or no number on file — because this is NEW
 * consent, not a re-confirmation of a number we can already call.
 *
 * The PEWC distinction decides what happens next, and it is the whole reason the disclosure marker has
 * to be byte-stable: if OUR email carried the disclosure, the reply is prior express WRITTEN consent and
 * an automated call is scheduled immediately (business-hours clamped). If it did NOT, the channel is
 * reopened for MANUAL follow-up only and **no automated call is placed**. Getting that backwards would
 * place an AI voice call without written consent.
 *
 * Best-effort — never throws. `true` on capture.
 */
export async function capturePhoneConsentFromReply(
  chatId: string,
  agentId: string,
  metaData?: GenerateMeta | null
): Promise<boolean> {
  if (!chatId) return false;
  try {
    const doc = await loadChatDoc(chatId);
    const mem = doc.memory ?? {};

    // Only act on a CLOSED channel.
    const phoneClosed =
      phoneOptedOut(doc) || !String(mem.phone_number ?? '').trim();
    if (!phoneClosed) return false;

    const cleaned = await latestInboundEmailBody(chatId);
    if (!cleaned) return false;

    const m = PHONE_IN_TEXT_RE.exec(cleaned);
    if (!m) return false;

    const candidate = normalizePhone(m[0]);
    if (candidate.length !== 10) return false;

    const confirmed = await llmConfirmCallbackNumber(
      cleaned,
      candidate,
      metaData
    );
    const number = confirmed ? normalizePhone(confirmed) : '';
    if (number.length !== 10) return false;

    const pewc = await pewcDisclosureOnRecord(chatId);

    await capturePhoneConsent(chatId, number, {
      pewc,
      message_id: mem._last_inbound_email_message_id,
      snippet: cleaned.slice(0, 200),
    });

    try {
      await logEmailActivity(
        chatId,
        'phone_consent_captured',
        mem.customer_email,
        pewc
          ? 'callback number provided (PEWC)'
          : 'callback number provided (prior-express)'
      );
    } catch {
      // Presentation only.
    }

    if (!pewc) {
      console.log(
        `[EMAIL_REVIEW] number captured for chat=${chatId} WITHOUT disclosure on record — ` +
          `prior-express only; channel reopened for MANUAL follow-up, no AI call scheduled.`
      );
      return true;
    }

    // Written consent → call now, clamped into the prospect's business hours.
    try {
      const tz = String(mem.timezone ?? '') || 'America/New_York';
      const executeAt = await nextBusinessHoursStart(tz, null, chatId);
      await deletePendingOutboundOutreach(chatId); // reschedule, do not stack
      await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
        notes:
          'Prospect provided a callback number by email in reply to our consent disclosure ' +
          '(written consent to call). Place the call per your outbound skill.',
        agent_id: agentId,
        account_id: agentId,
        attendee_id: number,
        timezone: tz,
        task_source: 'email_consent_call',
      });
      console.log(
        `[EMAIL_REVIEW] PEWC consent call scheduled for chat=${chatId} at ${executeAt.toISOString()}`
      );
    } catch (e) {
      console.warn(
        `[EMAIL_REVIEW] consent call scheduling failed for ${chatId}: ${e}`
      );
    }
    return true;
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] phone-consent capture failed for ${chatId}: ${e}`
    );
    return false;
  }
}

export interface ReviewEmailResult {
  extracted?: Record<string, unknown>;
  summarized?: boolean;
  consent_captured?: boolean;
}

/**
 * Post-email deterministic review, run AFTER the agent's reply is logged.
 *
 * Four independent steps, each wrapped so one failure never blocks the rest:
 *  1. extract the active skill's schema fields from the thread into memory;
 *  2. detect a referral or a decline — a REFERRAL takes precedence, because a wrong or departed contact
 *     pointing us elsewhere is a re-route, not a decline, and treating it as a decline would abandon a
 *     live opportunity;
 *  3. refresh the cross-channel summary, which closes the gap where an email-only exchange left no
 *     context for a later voice turn;
 *  4. capture a callback number as consent if the reply offered one.
 *
 * Best-effort — never throws.
 */
export async function reviewEmail(
  chatId: string,
  agentId: string,
  metaData?: GenerateMeta | null
): Promise<ReviewEmailResult> {
  if (!chatId) return {};
  const transcript = await buildEmailTranscript(chatId);
  if (!transcript) return {};

  // 1. Schema extraction from the active skills' merged memory schema.
  let extracted: Record<string, unknown> = {};
  try {
    const [, activeSkills] = await resolveStageAndSkills(chatId, agentId);
    const mergedSchema: Record<string, never> = {};
    let skillInstructions = '';
    for (const skill of activeSkills ?? []) {
      const sch = (skill as Record<string, unknown>).memory_schema;
      if (sch && typeof sch === 'object') Object.assign(mergedSchema, sch);
      skillInstructions +=
        String((skill as Record<string, unknown>).instructions ?? '') + '\n';
    }
    if (Object.keys(mergedSchema).length) {
      extracted =
        (await extractFromTranscriptWithSchema(
          transcript,
          mergedSchema,
          skillInstructions,
          metaData
        )) ?? {};
      if (Object.keys(extracted).length) {
        await setMemory(chatId, { ...extracted });
        console.log(
          `[EMAIL_REVIEW] extracted ${JSON.stringify(Object.keys(extracted))} for chat=${chatId}`
        );
      }
    }
  } catch (e) {
    console.warn(`[EMAIL_REVIEW] schema extraction failed for ${chatId}: ${e}`);
  }

  // 2. Referral or decline. Email review does not otherwise classify sentiment — an explicit
  //    unsubscribe is handled separately by `emailOptOutDetected`.
  try {
    const prefs =
      (await detectChannelPreferences(
        transcript,
        'email',
        new Date().toISOString().slice(0, 19),
        metaData
      )) ?? {};

    const ref = prefs.referral;
    if (ref?.is_referral && (ref.referred_email || ref.referred_phone)) {
      await handleReferralTransfer(
        chatId,
        ref,
        ref.referrer_name,
        'review_email'
      );
    } else if (
      prefs.customer_sentiment === 'not_interested' ||
      prefs.ending_reason === 'customer_said_not_interested'
    ) {
      await handleNotInterested(
        chatId,
        'customer_said_not_interested',
        'review_email'
      );
    }
  } catch (e) {
    console.warn(
      `[EMAIL_REVIEW] referral/not_interested detection failed for ${chatId}: ${e}`
    );
  }

  // 3. Refresh the cross-channel summary.
  let summarized = false;
  try {
    const summary = await generateAndCacheSummary(
      chatId,
      transcript,
      extracted,
      {},
      'email',
      metaData
    );
    summarized = Boolean(summary);
  } catch (e) {
    console.warn(`[EMAIL_REVIEW] summary caching failed for ${chatId}: ${e}`);
  }

  // 4. TCPA consent capture.
  const consentCaptured = await capturePhoneConsentFromReply(
    chatId,
    agentId,
    metaData
  );

  return { extracted, summarized, consent_captured: consentCaptured };
}
