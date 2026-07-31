/**
 * Post-call classification, and the actions a review takes from it.
 *
 * ## The classifiers have OPPOSITE defaults, each chosen for recoverability
 *
 * This is the most important thing in the module, and normalizing it would be a real regression:
 *
 *  - `classifyAnswerer` defaults to **`"human"`** on any error. A wrong `human` just leaves the chat at
 *    Contacted and the cadence re-dials — recoverable. Discarding a REAL call as voicemail is not.
 *  - `hadMeaningfulEngagement` defaults to **`false`**. Not advancing a stage is safe and recoverable; a
 *    wrong advance corrupts the funnel.
 *
 * ## There are deliberately NO deterministic phrase pre-checks
 *
 * The source removed them and explains why at length. A phrase pre-check scanned the WHOLE transcript and
 * fired on ANY machine phrase — so a call that OPENED with a machine segment (a call-screening "record
 * your name", hold music, even a voicemail greeting) and THEN had a live person pick up and converse was
 * wrongly discarded. Only reading the whole transcript can see the live pickup.
 *
 * The trade the source made explicit: the pre-check guarded one thing — the model's weakness on very
 * short machine greetings — which is a RECOVERABLE error. But it CAUSED the unrecoverable one. Review
 * runs once per call, off the hot path, so the extra model call is free.
 *
 * The single non-model shortcut is the FACTUAL "nobody spoke" case: zero human turns is `none`. That is
 * not a heuristic.
 *
 * ## Turn counts are never trusted as a signal
 *
 * An automated menu repeats and produces many turns while never being a person — it used to drive chats
 * to Engaged. Both prompts say so explicitly.
 */

import { FieldValue, db } from '../firebase/db';
import { createTaskWithId, setMemory } from '../firebase/chat';
import {
  clampToBusinessHours,
  deletePendingOutboundOutreach,
  nextBusinessHoursStart,
} from '../services/scheduling';
import { loadChatDoc, phoneOptedOut } from '../services/chat';
import { llmText, parseJsonResponse } from './reviewHelpers';
import type { GenerateMeta } from '../llm/ask';
import type { ChatMemory } from '../types';

export type Answerer = 'human' | 'ivr' | 'voicemail' | 'none';

const ANSWERER_VALUES: ReadonlySet<string> = new Set([
  'human',
  'ivr',
  'voicemail',
  'none',
]);

/**
 * The auto-retry cap after a voicemail or no-answer.
 *
 * **It is ZERO in the source, which disables the retry entirely** — `attempts >= 0` is always true on the
 * first check. The code path is kept so the behaviour can be restored by changing this one constant,
 * rather than by rewriting the scheduler. Ported at 0 deliberately: raising it would silently turn a
 * disabled feature back on.
 */
export const MAX_VOICE_RETRIES = 0;

/** Count HUMAN turns in an `AI:`/`HUMAN:` transcript. */
export function countHumanTurns(transcript: string | null | undefined): number {
  if (!transcript) return 0;
  return transcript
    .split('\n')
    .filter((line) => line.trim().toUpperCase().startsWith('HUMAN:')).length;
}

/**
 * The AUTHORITATIVE "who or what picked up" classification.
 *
 * Model-only, for the reason in the module docstring. Defaults to `human` on error or unparseable output,
 * so a genuine call is never discarded.
 */
export async function classifyAnswerer(
  transcript: string,
  metaData?: GenerateMeta | null
): Promise<Answerer> {
  try {
    if (countHumanTurns(transcript) === 0) {
      console.log('[ANSWERER] 0 human turns — none / no answer');
      return 'none';
    }

    const systemPrompt =
      "You are given a phone call transcript (agent 'AI:' turns and answerer 'HUMAN:' turns). " +
      'Classify WHO the agent ended up dealing with. Do NOT assume a HUMAN turn is a real person, ' +
      'and do NOT rely on how many turns there are (an automated menu repeats and can produce many ' +
      'turns). Judge from the content across the WHOLE call. Return exactly one:\n' +
      '- "human": a real live person the agent actually conversed with — answered a question, ' +
      'gave information, objected, asked something, agreed or declined. Even a curt real reply ' +
      'counts. CRITICAL: a call often OPENS with automated audio — a call-screening prompt ' +
      '("record your name and reason for calling", "I\'ll see if they\'re available"), hold ' +
      'music, "please stay/hold on the line", or even a voicemail greeting — and THEN a live ' +
      'person picks up and talks. If a live person joins and converses at ANY point, the answer is ' +
      '"human"; the automated opening does NOT make the call ivr/voicemail. A live gatekeeper / ' +
      'receptionist who responds to the agent — even only to take a message or forward you — is ' +
      'also "human".\n' +
      '- "ivr": an automated attendant / phone menu / switchboard that NEVER hands off to a live ' +
      "person who converses — e.g. 'thank you for calling <dealer>', 'for Sales press 1', 'to reach " +
      "... press', 'your call is important', repeating hold/menu prompts. It never actually " +
      'responds to what the agent says.\n' +
      '- "voicemail": ONLY a pre-recorded answering-machine / voicemail greeting and nothing else ' +
      "— 'you've reached ...', 'leave a message after the tone', 'I'm not available right now'. A " +
      'short one-line greeting with no beep transcribed still counts as voicemail — BUT only if no ' +
      'live person ever engages afterward.\n' +
      '- "none": nobody spoke / no answer / dead air.\n' +
      'Decide by whether a real person ultimately engaged, NOT by any single line: automated audio ' +
      'FOLLOWED BY a live conversation is "human".\n\n' +
      'Respond with valid JSON only: {"answerer": "human"|"ivr"|"voicemail"|"none"}';

    const parsed = parseJsonResponse(
      await llmText(systemPrompt, `TRANSCRIPT:\n${transcript}`, metaData)
    );
    const val = String(parsed.answerer ?? '')
      .trim()
      .toLowerCase();
    if (ANSWERER_VALUES.has(val)) {
      console.log(`[ANSWERER] LLM classified as ${val}`);
      return val as Answerer;
    }
    console.log(
      '[ANSWERER] unrecognized classifier output — defaulting to human'
    );
    return 'human';
  } catch (e) {
    console.warn(`[ANSWERER] classify failed: ${e} — defaulting to human`);
    return 'human';
  }
}

/**
 * True if the call did NOT reach a live human.
 *
 * Backed by the answerer classifier, with no turn-count shortcut — an IVR emits many turns yet reached no
 * person. IVR is a DISTINCT outcome the caller handles separately; this covers voicemail and no-answer
 * only. Errors default to `false` (live), so a genuine call is never skipped.
 */
export async function detectVoicemail(
  transcript: string,
  metaData?: GenerateMeta | null
): Promise<boolean> {
  try {
    const answerer = await classifyAnswerer(transcript, metaData);
    return answerer === 'voicemail' || answerer === 'none';
  } catch (e) {
    console.warn(
      `[VOICEMAIL] detectVoicemail failed: ${e} — defaulting to live call`
    );
    return false;
  }
}

/**
 * The low-engagement backstop: is the human side ONLY a recorded greeting?
 *
 * The provider sometimes transcribes an answering-machine greeting as if it were a live human, which is
 * why this exists as a second opinion rather than trusting the turn labels. Defaults to `false` (live).
 */
export async function llmDetectVoicemail(
  transcript: string,
  metaData?: GenerateMeta | null
): Promise<boolean> {
  const systemPrompt =
    'You are given a phone call transcript (AI agent and HUMAN turns). ElevenLabs sometimes ' +
    'transcribes an answering-machine / voicemail greeting AS IF it were a live human, so do not ' +
    'assume a HUMAN turn means a real person. Decide: did a real live person answer, or is the ' +
    'HUMAN content ONLY a voicemail / answering-machine recording?\n\n' +
    'Return is_voicemail=true if the HUMAN line(s) are a pre-recorded greeting or automated ' +
    'message, e.g.: "you\'ve reached ...", "the person you are trying to reach is not ' +
    "available\", 'please leave a message after the tone/beep', 'record your message', \"I'm " +
    'not available right now", "I can\'t come to the phone", "you\'ve reached the voicemail ' +
    "of ...\", 'at the tone', 'I'll get back to you' — with NO live person engaging afterward.\n" +
    'Return is_voicemail=false if a real person responded to the agent in the moment — answered a ' +
    'question, gave information, pushed back, or asked something — even a short live reply like ' +
    "\"who's this?\" or 'not interested'. CRITICAL: a call can OPEN with automated audio (a " +
    'call-screening "record your name", hold music, "please hold/stay on the line", or a ' +
    'voicemail greeting) and THEN a live person picks up and talks — that is is_voicemail=false. A ' +
    'live gatekeeper / receptionist who offers to take a message or forward you is also a real ' +
    'person → is_voicemail=false. When genuinely unsure, prefer is_voicemail=false (a real call ' +
    'must never be discarded as voicemail).\n\n' +
    'Respond with valid JSON only: {"is_voicemail": true/false}';

  const parsed = parseJsonResponse(
    await llmText(systemPrompt, `TRANSCRIPT:\n${transcript}`, metaData)
  );
  const isVm = Boolean(parsed.is_voicemail ?? false);
  console.log(`[VOICEMAIL] LLM verdict: is_voicemail=${isVm}`);
  return isVm;
}

/**
 * True only if the customer genuinely engaged in a two-way conversation.
 *
 * Gates the Contacted → Engaged advance, so a call with no real conversation never becomes Engaged. A
 * real person saying they CANNOT talk is not engagement — an unavailability brush-off is explicitly
 * `false`.
 *
 * Defaults to `false` on error: not advancing is recoverable, a wrong advance corrupts the funnel. There
 * is no turn-count floor, because turns cannot be trusted; the clearly-engaged demo case is protected
 * upstream by hard signals (a resolved booking or captured schema fields short-circuit before this runs).
 */
export async function hadMeaningfulEngagement(
  transcript: string,
  metaData?: GenerateMeta | null
): Promise<boolean> {
  try {
    const humanTurns = countHumanTurns(transcript);
    const systemPrompt =
      'You are given a phone call transcript (AI agent and HUMAN turns). Decide whether the HUMAN ' +
      'genuinely ENGAGED in a real two-way conversation with the agent. Do NOT rely on the number ' +
      'of turns — an automated menu repeats and can produce many turns.\n\n' +
      'engaged=true if the human substantively participated in ANY way: answered a question, ' +
      'gave information about themselves or their business, raised or argued an objection, asked ' +
      'a real question, agreed or declined an offer, or agreed to a meeting/demo/time. Terse or ' +
      "filler replies ('good', 'yeah', 'sure', 'uh') ALONGSIDE real answers still count — judge " +
      'the whole exchange, not the tone of individual lines.\n' +
      "engaged=false if the human's content is EXCLUSIVELY an unavailability/deferral brush-off " +
      "('I'm unavailable right now', 'can't talk', 'not a good time', 'who's this?' with nothing " +
      'substantive), a voicemail/answering-machine greeting, OR an automated attendant / phone ' +
      "menu / switchboard ('thank you for calling ...', 'for Sales press 1', 'to reach ... " +
      "press', hold prompts) — a menu or recording is NOT engagement no matter how many turns.\n" +
      'When genuinely unsure about a real person, prefer engaged=true.\n\n' +
      'Respond with valid JSON only: {"engaged": true/false}';

    const parsed = parseJsonResponse(
      await llmText(systemPrompt, `TRANSCRIPT:\n${transcript}`, metaData)
    );
    const engaged = Boolean(parsed.engaged ?? false);
    console.log(
      `[ENGAGEMENT] verdict: engaged=${engaged} (human_turns=${humanTurns})`
    );
    return engaged;
  } catch (e) {
    console.warn(`[ENGAGEMENT] check failed: ${e} — defaulting to NOT engaged`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The actions a review takes
// ─────────────────────────────────────────────────────────────────────────────

function prospectTz(memory: ChatMemory | null | undefined): string {
  return String((memory ?? {}).timezone ?? '') || 'America/New_York';
}

function prospectName(memory: ChatMemory | null | undefined): string {
  const m = memory ?? {};
  return (
    [String(m.first_name ?? '').trim(), String(m.last_name ?? '').trim()]
      .filter(Boolean)
      .join(' ') || 'the prospect'
  );
}

/**
 * Auto-retry the call once after a voicemail or no-answer.
 *
 * **Currently a no-op**, because `MAX_VOICE_RETRIES` is 0 — see that constant. The guard is kept so the
 * behaviour is one config change away and can never loop when re-enabled.
 *
 * Reads the phone opt-out from the TRUSTWORTHY top-level keys rather than memory: a review must never
 * auto-dial a contact who opted out between the call and the review.
 */
export async function scheduleRetryCall(
  chatId: string,
  agentId: string,
  memory: ChatMemory | null | undefined
): Promise<boolean> {
  try {
    if (!chatId) return false;
    if (phoneOptedOut(await loadChatDoc(chatId))) {
      console.log(
        `[REVIEW][VOICE_FU] phone opt-out — skipping retry call for chat=${chatId}`
      );
      return false;
    }

    const attempts = Number((memory ?? {})._voice_followup_attempts ?? 0);
    if (attempts >= MAX_VOICE_RETRIES) {
      console.log(
        `[REVIEW][VOICE_FU] retry cap reached (${attempts}) for chat=${chatId}`
      );
      return false;
    }

    const tz = prospectTz(memory);
    const executeAt = await nextBusinessHoursStart(tz, null, chatId);
    await deletePendingOutboundOutreach(chatId); // reschedule, do not stack
    await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
      notes:
        `Retry the outbound call to ${prospectName(memory)} — the previous attempt reached ` +
        `voicemail/no answer. Place the call per your outbound skill.`,
      agent_id: agentId,
      account_id: agentId,
      attendee_id: (memory ?? {}).phone_number,
      timezone: tz,
      task_source: 'voice_followup_retry',
    });
    await setMemory(chatId, { _voice_followup_attempts: attempts + 1 });
    console.log(
      `[REVIEW][VOICE_FU] scheduled retry call for chat=${chatId} at ${executeAt.toISOString()} (attempt ${attempts + 1})`
    );
    return true;
  } catch (e) {
    console.warn(
      `[REVIEW][VOICE_FU] retry scheduling failed (non-blocking): ${e}`
    );
    return false;
  }
}

/**
 * Schedule a callback the customer asked for — at their stated time if one was given, else the next
 * business-hours slot. Either way it is clamped into business hours, so an agreed "call me at 7am" still
 * lands inside the window.
 */
export async function scheduleCallback(
  chatId: string,
  agentId: string,
  memory: ChatMemory | null | undefined,
  deferredUntilIso?: string | null
): Promise<boolean> {
  try {
    if (!chatId) return false;
    if (phoneOptedOut(await loadChatDoc(chatId))) {
      console.log(
        `[REVIEW][VOICE_FU] phone opt-out — skipping callback for chat=${chatId}`
      );
      return false;
    }

    const tz = prospectTz(memory);
    let executeAt: Date | null = null;
    if (deferredUntilIso) {
      try {
        const dt = new Date(String(deferredUntilIso).replace('Z', '+00:00'));
        if (!Number.isNaN(dt.getTime())) {
          executeAt = await clampToBusinessHours(dt, tz, null, chatId);
        }
      } catch {
        executeAt = null;
      }
    }
    if (executeAt === null) {
      executeAt = await nextBusinessHoursStart(tz, null, chatId);
    }

    await deletePendingOutboundOutreach(chatId);
    await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
      notes:
        `Callback requested by ${prospectName(memory)}` +
        (deferredUntilIso ? ` for ${deferredUntilIso}` : '') +
        '. Place the outbound call per your outbound skill.',
      agent_id: agentId,
      account_id: agentId,
      attendee_id: (memory ?? {}).phone_number,
      timezone: tz,
      task_source: 'voice_followup_callback',
    });
    console.log(
      `[REVIEW][VOICE_FU] scheduled callback for chat=${chatId} at ${executeAt.toISOString()}`
    );
    return true;
  } catch (e) {
    console.warn(
      `[REVIEW][VOICE_FU] callback scheduling failed (non-blocking): ${e}`
    );
    return false;
  }
}

/** Generic or shared-inbox local parts — a routing inbox, not a person's own address. */
const DEPT_EMAIL_PREFIXES: ReadonlySet<string> = new Set([
  'marketing',
  'info',
  'sales',
  'contact',
  'support',
  'admin',
  'hello',
  'team',
  'office',
  'help',
  'service',
  'services',
  'enquiries',
  'inquiries',
  'careers',
  'hr',
  'billing',
  'accounts',
  'accounting',
  'noreply',
  'no-reply',
  'reception',
  'frontdesk',
  'front-desk',
  'dealer',
]);

/** `department` (a shared routing inbox) versus `personal`. Best-effort on the local part. */
export function classifyEmail(addr: unknown): 'department' | 'personal' {
  try {
    const local = String(addr).split('@')[0].trim().toLowerCase();
    return DEPT_EMAIL_PREFIXES.has(local) ? 'department' : 'personal';
  } catch {
    return 'personal';
  }
}

/**
 * Schedule a follow-up email to an address captured on the call — a gatekeeper saying "email us at ...".
 *
 * The address is recorded as a SECONDARY entry in `_additional_emails` and **never overwrites the primary
 * `customer_email`**: a receptionist's shared inbox is not the prospect's address, and overwriting would
 * silently redirect the whole cadence.
 *
 * The wording is classification-aware for the same reason — a department inbox gets a polite FORWARD
 * request naming the prospect, while a personal address is addressed directly. Both notes explicitly
 * forbid no-answer and booking-confirmation wording, because neither premise is true here.
 */
export async function scheduleFollowupEmail(
  chatId: string,
  agentId: string,
  memory: ChatMemory | null | undefined,
  emailAddrRaw: string
): Promise<boolean> {
  try {
    if (!chatId || !emailAddrRaw) return false;
    const emailAddr = String(emailAddrRaw).trim();
    const domain = emailAddr.split('@')[1];
    if (!emailAddr.includes('@') || !domain || !domain.includes('.')) {
      return false;
    }
    // NOTE: the source reads the opt-out from MEMORY here, not the trustworthy top-level key as the
    // phone gates do. Preserved as-is — a change would alter which contacts get a follow-up.
    if ((memory ?? {}).email_opt_out) {
      console.log(
        `[REVIEW][EMAIL_FU] email opt-out — skipping follow-up email for chat=${chatId}`
      );
      return false;
    }

    const kind = classifyEmail(emailAddr);

    try {
      const existing = [
        ...(((memory ?? {})._additional_emails as Array<
          Record<string, unknown>
        >) ?? []),
      ];
      const already = existing.some(
        (e) =>
          String((e ?? {}).email ?? '').toLowerCase() ===
          emailAddr.toLowerCase()
      );
      if (!already) {
        existing.push({
          email: emailAddr,
          type: kind,
          source: 'call',
          added_at: new Date().toISOString(),
        });
        await setMemory(chatId, { _additional_emails: existing });
      }
    } catch (e) {
      console.warn(
        `[REVIEW][EMAIL_FU] _additional_emails store failed for ${chatId}: ${e}`
      );
    }

    const tz = prospectTz(memory);
    const executeAt = await nextBusinessHoursStart(tz, null, chatId);
    const name = prospectName(memory);

    const notes =
      kind === 'department'
        ? `Send a SHORT follow-up email via the send_email tool to the shared/department inbox ` +
          `${emailAddr} (a receptionist asked us to email here — it is NOT ${name}'s personal inbox). ` +
          `Word it as a polite forward request: ask them to pass it along to ${name}. Briefly explain our ` +
          `AI helps dealers buy more cars by working their existing database (past walk-ins, service-only ` +
          `customers) and reaching in-market sellers, pitching offers and bringing them straight to them, ` +
          `and offer a quick demo. Do NOT use 'sorry we missed you' / no-answer or booking-confirmation ` +
          `wording.`
        : `Send a SHORT follow-up email via the send_email tool to ${name} at ${emailAddr}. Briefly explain ` +
          `our AI helps you buy more cars by working your existing database (past walk-ins, service-only ` +
          `customers) and reaching in-market sellers, pitching offers and bringing them straight to you, and ` +
          `offer a quick demo. Do NOT use 'sorry we missed you' / no-answer or booking-confirmation wording.`;

    await deletePendingOutboundOutreach(chatId);
    await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
      notes,
      agent_id: agentId,
      account_id: agentId,
      email_to: emailAddr,
      email_kind: kind,
      timezone: tz,
      task_source: 'followup_email',
    });
    console.log(
      `[REVIEW][EMAIL_FU] scheduled follow-up email to ${emailAddr} (${kind}) for chat=${chatId} at ${executeAt.toISOString()}`
    );
    return true;
  } catch (e) {
    console.warn(
      `[REVIEW][EMAIL_FU] follow-up email scheduling failed (non-blocking): ${e}`
    );
    return false;
  }
}

/**
 * The idempotency stamp, and the thing that unblocks the next dial.
 *
 * Two writes with distinct jobs: recording the call id in `_reviewed_call_ids` makes a duplicate or
 * re-fired review of the SAME call a no-op, and stamping `_last_call_reviewed_at` clears the per-chat
 * dial guard's awaiting-review block so the next cadence step can dial.
 *
 * A dot-path update with `arrayUnion`, so concurrent writers cannot clobber the list.
 */
export async function markCallReviewed(
  chatId: string,
  callId: string
): Promise<void> {
  if (!chatId || !callId) return;
  try {
    await db
      .collection('chats')
      .doc(chatId)
      .update({
        'memory._reviewed_call_ids': FieldValue.arrayUnion(callId),
        'memory._last_call_reviewed_at': new Date().toISOString(),
      });
  } catch (e) {
    console.warn(
      `[REVIEW] markCallReviewed failed chat=${chatId} call=${callId}: ${e}`
    );
  }
}

/** Exposed for tests: the pure helpers. */
export const __testing = { prospectTz, prospectName };
