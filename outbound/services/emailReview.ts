/**
 * Deterministic post-email processing — the email counterpart to the call-transcript review, minus
 * voicemail, because email is in-band: there is no transcript to fetch, only the thread already in
 * `messages_v3`.
 *
 * ## What is here, and what is not
 *
 * The source module interleaves deterministic policy with four LLM intent checks. Only the deterministic
 * half is ported, because the LLM helpers it calls (`_llm_text`, `_parse_json_response`,
 * `extract_from_transcript_with_schema`, `detect_channel_preferences`, `_resolve_stage_and_skills`) live
 * in the call-transcript review tool, and the summary refresh needs the model layer — two later phases.
 * Landed now:
 *
 *  - `handleSuppressedReinitiation` — the reinitiation policy ladder, pure decision logic;
 *  - the thread readers (`buildEmailTranscript`, latest inbound/outbound body);
 *  - `pewcDisclosureOnRecord` — the deterministic written-versus-prior-express consent test;
 *  - `notifyOps` — the human-escalation write.
 *
 * Deferred with their dependencies: `emailOptOutDetected`'s intent confirmation, the callback-number
 * confirmation, schema extraction, referral and not-interested detection, and the summary refresh. The
 * PORT-PLAN deferral ledger tracks each.
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
import { getMemory } from '../firebase/chat';
import * as sup from './suppression';
import { verify } from './verification';
import { envStr } from '../config';
import { PEWC_DISCLOSURE_MARKER, stripQuotedReply } from './emailText';

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
