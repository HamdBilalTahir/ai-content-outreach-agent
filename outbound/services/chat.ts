/**
 * Outbound chat state and the deterministic gate layer.
 *
 * This is the module every other outbound phase reads before it does anything irreversible: it owns
 * the chat document's shape, the opt-out gate matrix, the labels that stop proactive outreach, the
 * cadence counters and caps, and the per-chat dial dedup.
 *
 * ## The trust tiers, and why they are not interchangeable
 *
 * The chat document has two tiers of state, and the gates deliberately read only one of them:
 *
 *  - **Top-level keys are code-owned and trustworthy** — `phone_opt_out`, `email_opt_out`,
 *    `sms_opt_out`, `email_invalid`, `labels[]`, `cadence_complete`, `stage`, `status`. These are
 *    written by intake, the DNC scrub, the unsubscribe path, and the review tools. Every consent
 *    gate reads from here.
 *  - **`memory` is LLM-writable** — the agent's tools write to it during a turn. It carries channel
 *    PRESENCE (is there a phone/email on file) and free-form prospect context.
 *
 * A gate that read consent out of `memory` could be talked out of blocking by the model itself.
 * Presence is safe to read from `memory` because clearing it only makes a channel look *absent*,
 * which is the more restrictive direction. `_optout_flag` keeps a narrow memory fallback used ONLY
 * when the top-level key is absent entirely — that is a chat created before the keys were seeded,
 * and without the fallback an already-opted-out old chat would silently un-gate.
 *
 * ## "Not interested" is not an opt-out, and not a stage
 *
 * Three different things are deliberately kept apart, and conflating them is the most likely way to
 * break this module:
 *  - **Opt-out flags** encode the customer's *consent* to be contacted at all.
 *  - **The `Lost` stage** is our terminal business outcome.
 *  - **The `not_interested` label** is our read of the conversation: it stops PROACTIVE outreach but
 *    leaves inbound replies answerable, so a prospect who declines can still re-open the deal.
 *
 * ## Persona name is data, not code
 *
 * Every customer-visible surface resolves the agent's display name through `resolveOutboundName`,
 * which reads `sales_agent_name` off chat memory or the agent doc. Nothing hardcodes a persona, so a
 * rebrand is a config change. `contactedMarkerKey` derives the per-chat dedup marker from that name,
 * with a legacy fixed key still read as a fallback so cadence never breaks for chats seeded before
 * the name became dynamic.
 *
 * ## Deferred to later phases
 *
 * Three functions in the source module reach forward into subsystems that are not ported yet, and
 * are intentionally absent here rather than stubbed:
 *  - `ensure_meeting_host` — resolves the HubSpot contact owner; lands with the HubSpot phase.
 *  - `finalize_unresolved_call` and `reconcile_stale_pending_calls` — need `voice_concurrency` and
 *    `stalled_recovery`; they land with the voice phase.
 * The pure pieces they build on (`meetingHostFact`, `callAwaitingReview`) are ported here, because
 * they are testable now and the deferred orchestrators are the only missing part.
 */

import { FieldValue, db, toDate } from '../firebase/db';
import { getAgent } from '../firebase/agent';
import {
  addLabelToChat,
  getMemory,
  setMemory,
  updateTaskFailure,
  updateTaskStatus,
} from '../firebase/chat';
import {
  dialAwaitingReviewMaxMin,
  dialRecencyFloorMin,
  maxCallFollowups,
  maxEmailFollowups,
} from '../config';
import type {
  BedrockContentBlock,
  BedrockMessage,
  ChatDoc,
  ChatMemory,
} from '../types';

/**
 * Firestore doc IDs disallow `/`, the empty string, and `.`/`..` as whole names, and cap at 1500
 * bytes. Sanitize to a safe, human-readable subset. Cloned from the inbound webhook's helper so the
 * outbound namespacing matches it exactly.
 */
const DOC_ID_SAFE_RE = /[^a-zA-Z0-9_-]/g;

/** Strip leading and trailing underscores, the equivalent of Python's `.strip('_')`. */
function stripUnderscores(s: string): string {
  return s.replace(/^_+/, '').replace(/_+$/, '');
}

/**
 * Stable Firestore doc ID from `(agentId, userId)`. The same inputs always produce the same ID, so
 * concurrent webhook calls for the same person target one document and only one `create()` wins.
 */
export function buildDeterministicChatId(
  agentId: string | null | undefined,
  userId: string | null | undefined
): string {
  const safeAgent =
    stripUnderscores(String(agentId ?? '').replace(DOC_ID_SAFE_RE, '_')) ||
    'agent';
  const safeUser =
    stripUnderscores(String(userId ?? '').replace(DOC_ID_SAFE_RE, '_')) ||
    'user';
  return `${safeAgent}__${safeUser}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent-name resolution (name-agnostic; no hardcoded persona)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Final fallback only. The real name lives on the agent doc's `sales_agent_name` and is mirrored
 * into chat memory at enrollment, so this should rarely be hit.
 */
const DEFAULT_OUTBOUND_NAME = 'Lily';

/** A chat id, a full chat doc, or a bare memory dict — all three are accepted by the resolver. */
type NameSource = string | ChatDoc | ChatMemory | null | undefined;

function memoryFrom(source: ChatDoc | ChatMemory): ChatMemory {
  const asDoc = source as ChatDoc;
  if (asDoc.memory && typeof asDoc.memory === 'object') return asDoc.memory;
  return source as ChatMemory;
}

/**
 * Resolve the agent's display name for a chat, name-agnostically, in order:
 *  1. chat memory `sales_agent_name` — outbound chats are seeded at enrollment, the fast path;
 *  2. `agentData.sales_agent_name` when the caller already holds the agent doc;
 *  3. the chat's agent doc, looked up from memory's `agent_id` — this is what makes an INBOUND chat
 *     (web widget / WhatsApp, never seeded with a name) resolve to its own persona without touching
 *     the inbound flow;
 *  4. the generic default.
 */
export async function resolveOutboundName(
  chatIdOrDoc?: NameSource,
  agentData?: Record<string, unknown> | null
): Promise<string> {
  let mem: ChatMemory = {};
  try {
    if (typeof chatIdOrDoc === 'string' && chatIdOrDoc) {
      mem = (await getMemory(chatIdOrDoc)) ?? {};
    } else if (chatIdOrDoc && typeof chatIdOrDoc === 'object') {
      mem = memoryFrom(chatIdOrDoc) ?? {};
      const direct = (chatIdOrDoc as ChatDoc).sales_agent_name;
      if (direct) return String(direct);
    }
    if (mem.sales_agent_name) return String(mem.sales_agent_name);
  } catch (e) {
    console.warn(`[OB] resolveOutboundName chat read failed: ${e}`);
  }

  if (agentData?.sales_agent_name) return String(agentData.sales_agent_name);

  const agentId =
    mem.agent_id ??
    (chatIdOrDoc && typeof chatIdOrDoc === 'object'
      ? (chatIdOrDoc as ChatDoc).agentId
      : undefined);
  if (agentId) {
    try {
      const ad = (await getAgent(String(agentId))) ?? {};
      if (ad.sales_agent_name) return String(ad.sales_agent_name);
    } catch (e) {
      console.warn(
        `[OB] resolveOutboundName agent read failed agent=${String(agentId)}: ${e}`
      );
    }
  }
  return DEFAULT_OUTBOUND_NAME;
}

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
};

/**
 * Format a phone number for slow, clear TTS.
 *
 * The voice model has no SSML or `<break>` support, so punctuation is the only pacing lever
 * available: each digit becomes a word, a COMMA separates digits and a PERIOD separates groups.
 * Country code first, national part grouped 3-3-4.
 *
 *     +17816791321 → "plus one. seven, eight, one. six, seven, nine. one, three, two, one"
 *
 * No trailing period: callers and templates add their own sentence punctuation
 * (`"...at {{callback_number_pronounced}}. Again, ..."`), and one here would double up.
 * Anything that is not a groupable phone number (the "this number" placeholder, say) is returned
 * unchanged.
 */
export function pronouncePhoneNumber(raw: unknown): string {
  if (!raw) return String(raw ?? '');
  const s = String(raw).trim();
  const digits = [...s].filter((c) => c >= '0' && c <= '9');
  if (digits.length < 10) return s; // not confidently groupable — leave as-is

  const national = digits.slice(digits.length - 10);
  const country = digits.slice(0, digits.length - 10);
  const say = (seq: string[]): string =>
    seq.map((d) => DIGIT_WORDS[d]).join(', ');

  const parts: string[] = [];
  if (country.length || s.startsWith('+')) {
    const cc = country.length ? country : ['1'];
    parts.push('plus ' + cc.map((d) => DIGIT_WORDS[d]).join(' '));
  }
  parts.push(say(national.slice(0, 3)));
  parts.push(say(national.slice(3, 6)));
  parts.push(say(national.slice(6, 10)));
  return parts.join('. ');
}

/** Lowercase alphanumeric slug of a persona name (`'Lily'` → `'lily'`, `'Ava B'` → `'ava_b'`). */
export function nameSlug(name: unknown): string {
  const slug = stripUnderscores(
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
  );
  return slug || 'agent';
}

/** Name-derived per-chat dedup marker key (`'Lily'` → `'_lily_last_contacted'`). */
export function contactedMarkerKey(name: unknown): string {
  return `_${nameSlug(name)}_last_contacted`;
}

/**
 * The fixed marker key from before the persona name became dynamic. Reads fall back to it so
 * cadence and dedup never break for chats seeded before the rename, or mid-migration.
 */
const LEGACY_CONTACTED_MARKER_KEY = '_ava_last_contacted';

/**
 * Read the "first outreach sent" timestamp from a chat's memory, name-agnostically: the
 * name-derived key first, then the legacy key.
 */
export async function contactedMarkerValue(
  memory: ChatMemory | null | undefined
): Promise<unknown> {
  const mem = memory ?? {};
  const key = contactedMarkerKey(await resolveOutboundName(mem));
  return mem[key] ?? mem[LEGACY_CONTACTED_MARKER_KEY];
}

function chatRef(chatId: string) {
  return db.collection('chats').doc(chatId);
}

/**
 * True iff the chat's `type` field is `"outbound"`. This is the robust discriminator for any
 * outbound check — preferred over matching the chat-id prefix. Reads the chat doc when not supplied.
 */
export async function isOutboundChat(
  chatId: string,
  chatData?: ChatDoc | null
): Promise<boolean> {
  if (!chatId) return false;
  try {
    let d = chatData;
    if (d === null || d === undefined) {
      const doc = await chatRef(chatId).get();
      d = doc.exists ? ((doc.data() ?? {}) as ChatDoc) : {};
    }
    return (d ?? {}).type === 'outbound';
  } catch (e) {
    console.warn(`[OB] isOutboundChat read failed chat=${chatId}: ${e}`);
    return false;
  }
}

/** Read the full chat doc once — top-level gate keys plus `memory` — for the gates below. */
export async function loadChatDoc(chatId: string): Promise<ChatDoc> {
  if (!chatId) return {};
  try {
    const doc = await chatRef(chatId).get();
    return doc.exists ? ((doc.data() ?? {}) as ChatDoc) : {};
  } catch (e) {
    console.warn(`[OB] loadChatDoc failed chat=${chatId}: ${e}`);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic opt-out gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize one opt-out flag to a boolean, tolerant of every TYPE this key has been written as
 * across the codebase's history: real booleans, the DNC/consent string form (`"Y"`/`"N"`), textual
 * booleans, and numerics.
 *
 * Only affirmative values mean OPTED OUT — `"N"`, `"false"`, `0`, `null`, `""` all mean not opted
 * out. This matters more than it looks: a truthiness check would read the string `"N"` (which means
 * "do NOT block") as blocked, silently re-gating a channel that was just opened.
 */
function isOptedOutValue(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['Y', 'YES', 'TRUE', '1'].includes(
    String(v ?? '')
      .trim()
      .toUpperCase()
  );
}

/**
 * Read a boolean opt-out flag from the TRUSTWORTHY chat-doc top-level key.
 *
 * The memory fallback fires ONLY when the top-level key is absent altogether — a chat created before
 * the keys were seeded. Without it, an already-opted-out old chat would silently un-gate. New chats
 * always carry the top-level key from creation, so `memory` can never corrupt a gate on one.
 */
function optoutFlag(
  chatData: ChatDoc | null | undefined,
  topKey: string,
  ...memKeys: string[]
): boolean {
  const d = (chatData ?? {}) as Record<string, unknown>;
  if (topKey in d) return isOptedOutValue(d[topKey]);
  const m = ((chatData ?? {}).memory ?? {}) as Record<string, unknown>;
  return memKeys.some((mk) => isOptedOutValue(m[mk]));
}

/**
 * PHONE opted out — top-level `phone_opt_out` / `block_phone`, memory fallback for pre-change chats.
 * Set from the DNC API in production; also settable at intake for testing.
 *
 * NOTE the asymmetry between the two keys, which is deliberate and load-bearing: chat creation seeds
 * `phone_opt_out` and `email_opt_out` but NOT `block_phone`, so top-level `block_phone` is absent on
 * every chat and its memory fallback stays permanently live. A memory `block_phone: "Y"` therefore
 * blocks even when top-level `phone_opt_out` is `false`. That errs toward BLOCKING, the safe
 * direction for a consent gate — "tidying" the second check away would un-gate contacts the DNC
 * path had blocked. Reopening the channel writes top-level `block_phone: "N"`, which then wins.
 */
export function phoneOptedOut(chatData: ChatDoc | null | undefined): boolean {
  const d = chatData ?? {};
  return (
    optoutFlag(d, 'phone_opt_out', 'phone_opt_out', 'block_phone') ||
    optoutFlag(d, 'block_phone', 'block_phone')
  );
}

/**
 * EMAIL opted out — top-level `email_opt_out`, memory fallback `_email_opt_out`. Set by the
 * reply/unsubscribe opt-out path, and by intake for testing.
 */
export function emailOptedOut(chatData: ChatDoc | null | undefined): boolean {
  return optoutFlag(
    chatData,
    'email_opt_out',
    '_email_opt_out',
    'email_opt_out'
  );
}

/** SMS opted out — top-level `sms_opt_out`, memory fallback for pre-change chats. */
export function smsOptedOut(chatData: ChatDoc | null | undefined): boolean {
  return optoutFlag(chatData, 'sms_opt_out', 'sms_opt_out');
}

/**
 * The email ADDRESS is undeliverable (verified `invalid`) — distinct from `emailOptedOut`, which is
 * consent. This means the mailbox itself is bad, so the email channel is closed on every profile
 * including transactional. A valid phone still keeps the contact reachable: this flag never touches
 * the phone channel or the lane.
 */
export function emailInvalid(chatData: ChatDoc | null | undefined): boolean {
  return optoutFlag(
    chatData,
    'email_invalid',
    '_email_invalid',
    'email_invalid'
  );
}

/**
 * True if at least ONE channel is open — a phone on file and not opted out, or an email on file that
 * is neither opted out nor known-bad. Opt-out comes from the top-level keys, presence from `memory`.
 * Fully unreachable → `false`, and no task is created.
 */
export function hasReachableChannel(
  chatData: ChatDoc | null | undefined
): boolean {
  const d = chatData ?? {};
  const m = d.memory ?? {};
  const phoneOpen =
    Boolean(String(m.phone_number ?? '').trim()) && !phoneOptedOut(d);
  const emailOpen =
    Boolean(String(m.customer_email ?? '').trim()) &&
    !emailOptedOut(d) &&
    !emailInvalid(d);
  return phoneOpen || emailOpen;
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels that stop proactive outreach
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The customer declined. Set on the top-level `labels` array by the review-triggered handler. NOT an
 * opt-out flag and NOT the Lost stage — it only stops PROACTIVE outreach (the cron cadence and new
 * task creation). Send tools are intentionally not gated on it, so an inbound reply can re-open the
 * conversation.
 */
export const NOT_INTERESTED_LABEL = 'not_interested';

/**
 * The person we were reaching is gone or wrong and the outreach moved to a NEW chat for the referred
 * person. Stops proactive outreach on this SOURCE chat only; the new chat is a normal active chat
 * carrying a separate `referral` highlight label, which is not a stop label.
 */
export const REFERRAL_TRANSFERRED_LABEL = 'referral_transferred';

/** Labels that halt proactive outreach. Not opt-out flags, not a stage. */
const PROACTIVE_STOP_LABELS: ReadonlySet<string> = new Set([
  NOT_INTERESTED_LABEL,
  REFERRAL_TRANSFERRED_LABEL,
]);

/** True if the chat carries the `not_interested` label. */
export function isNotInterested(chatData: ChatDoc | null | undefined): boolean {
  return ((chatData ?? {}).labels ?? []).includes(NOT_INTERESTED_LABEL);
}

/**
 * True if the chat carries any label that halts proactive outreach. Read from the trustworthy
 * top-level `labels[]`.
 */
export function stopsProactive(chatData: ChatDoc | null | undefined): boolean {
  const labels = (chatData ?? {}).labels ?? [];
  return labels.some((lbl) => PROACTIVE_STOP_LABELS.has(lbl));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence-complete marker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set when a chat's outreach cadence is exhausted, so the stalled-chat recovery sweep stops
 * re-reviewing it. An inbound reply clears it alongside `resetFollowupCounts`. Same trust tier as
 * `labels` and the opt-out keys — read from the top level, never from memory.
 */
export const CADENCE_COMPLETE_KEY = 'cadence_complete';

const TERMINAL_STAGES: ReadonlySet<string> = new Set(['lost', 'closed_lost']);

/** True if the chat's outreach cadence is marked complete. */
export function isCadenceComplete(
  chatData: ChatDoc | null | undefined
): boolean {
  return Boolean((chatData ?? {})[CADENCE_COMPLETE_KEY]);
}

/** True if the chat is in a terminal stage (Lost / closed_lost) — never re-engage proactively. */
export function isTerminalStage(chatData: ChatDoc | null | undefined): boolean {
  return TERMINAL_STAGES.has(
    String((chatData ?? {}).stage ?? '')
      .trim()
      .toLowerCase()
  );
}

/** Mark the chat's outreach cadence complete, with a timestamp and reason. Best-effort. */
export async function setCadenceComplete(
  chatId: string,
  reason = 'cadence_exhausted'
): Promise<boolean> {
  if (!chatId) return false;
  try {
    await chatRef(chatId).set(
      {
        [CADENCE_COMPLETE_KEY]: true,
        cadence_complete_at: new Date().toISOString(),
        cadence_complete_reason: String(reason ?? '').slice(0, 200),
      },
      { merge: true }
    );
    return true;
  } catch (e) {
    console.warn(`[OB] setCadenceComplete failed chat=${chatId}: ${e}`);
    return false;
  }
}

/**
 * Reopen a chat by clearing the cadence-complete marker — an inbound reply re-activates proactive
 * handling. Best-effort; called alongside `resetFollowupCounts` in the inbound-reply seams.
 */
export async function clearCadenceComplete(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    await chatRef(chatId).set(
      {
        [CADENCE_COMPLETE_KEY]: false,
        cadence_reopened_at: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (e) {
    console.warn(`[OB] clearCadenceComplete failed chat=${chatId}: ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-creation gate
// ─────────────────────────────────────────────────────────────────────────────

const CALL_TASK_TYPES: ReadonlySet<string> = new Set([
  'outbound_call',
  'callback',
  'call_followup',
  'voice_call_followup',
  'check_if_call_succeeded',
]);
const EMAIL_TASK_TYPES: ReadonlySet<string> = new Set(['followup_if_no_reply']);

/**
 * Deterministic gate for creating or running an outbound task: may a task of this type (or explicit
 * `channel`) proceed for this chat, given its opt-outs?
 *
 * Call-type needs the phone open, email-type needs email open, sms needs sms open. `outbound_outreach`
 * is channel-neutral (the skill picks) so it needs ANY open channel, and an unknown type defaults to
 * the same — fail-safe, blocked only when the contact is fully unreachable. A `reminder` carries its
 * channel explicitly, so pass `channel`.
 *
 * The point of gating CREATION rather than only execution is that a task which would use an
 * opted-out channel never exists in the first place.
 */
export function taskChannelOpen(
  chatData: ChatDoc | null | undefined,
  taskType = '',
  channel?: string | null
): boolean {
  const d = chatData ?? {};
  if (stopsProactive(d)) return false; // not-interested / referral-transferred → no NEW proactive task

  let ch = String(channel ?? '')
    .trim()
    .toLowerCase();
  if (!ch) {
    if (CALL_TASK_TYPES.has(taskType)) ch = 'call';
    else if (EMAIL_TASK_TYPES.has(taskType)) ch = 'email';
  }

  const m = d.memory ?? {};
  if (ch === 'call') {
    return Boolean(String(m.phone_number ?? '').trim()) && !phoneOptedOut(d);
  }
  if (ch === 'email') {
    return Boolean(String(m.customer_email ?? '').trim()) && !emailOptedOut(d);
  }
  if (ch === 'sms') {
    return Boolean(String(m.phone_number ?? '').trim()) && !smsOptedOut(d);
  }
  return hasReachableChannel(d);
}

function taskRef(chatId: string, taskId: string) {
  return chatRef(chatId).collection('tasks').doc(taskId);
}

/**
 * Mark a task terminal-but-distinct when the opt-out gate skips it: `executed = true` so the due
 * query (which filters `executed == false`) never re-picks it, PLUS `skipped` / `skip_reason` /
 * `skipped_at`.
 *
 * Audit-distinct from a real execution on purpose — a gated task must never be counted as outreach.
 */
export async function markTaskSkipped(
  chatId: string,
  taskId: string,
  reason = 'channel_opted_out'
): Promise<boolean> {
  if (!chatId || !taskId) return false;
  try {
    await taskRef(chatId, taskId).update({
      executed: true,
      skipped: true,
      skip_reason: reason,
      skipped_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn(
      `[OB] markTaskSkipped failed chat=${chatId} task=${taskId}: ${e}`
    );
    return false;
  }
}

/**
 * Task-failure handling for the dispatch-once cron.
 *
 * Records the failure through the shared `updateTaskFailure` (10 → 20 → 40 minute backoff, permanent
 * at max retries) and then REOPENS a retriable failure: because the dispatch claim set
 * `executed = true` up front, a failed task would otherwise never be re-selected. So it re-reads the
 * task and, unless the failure went permanent, flips `executed` back to `false` for the backoff tick.
 *
 * `claimed` is the cron's dispatch-claim flag: with the claim kill-switch off the task was never
 * marked executed, so no reopen is needed. Best-effort; never throws.
 */
export async function failOutboundTask(
  chatId: string,
  taskId: string,
  reason: string,
  claimed = true
): Promise<void> {
  try {
    await updateTaskFailure(chatId, taskId, reason);
    if (claimed) {
      const snap = await taskRef(chatId, taskId).get();
      const td = snap.exists ? (snap.data() ?? {}) : {};
      if (!td.permanent_failure) {
        await updateTaskStatus(chatId, taskId, false); // reopen for the scheduled backoff retry
      }
    }
  } catch (e) {
    console.warn(
      `[OB] failOutboundTask error chat=${chatId} task=${taskId}: ${e}`
    );
  }
}

/**
 * Record a customer-provided callback number as WRITTEN CONSENT and reopen the phone channel.
 *
 * Called when a prospect whose phone channel was closed — opted out, or no number on file — replies
 * to our email with a number to reach them on. That reply is express permission to call. Writes:
 *  - memory `phone_number`, plus `_phone_consent` (the audit artifact: source, timestamp, message id,
 *    number, snippet) and `_phone_consent_at`;
 *  - the trustworthy top-level keys the gates actually read — `phone_opt_out: false` and
 *    `block_phone: "N"` — so `phoneOptedOut` / `hasReachableChannel` / the call tool stop blocking;
 *  - the `phone_consent_captured` label, for the UI.
 *
 * `proof.pewc` records whether this is prior-express-WRITTEN consent (our email carried the
 * disclosure) versus mere prior-express consent; the caller sets it and call enablement keys on it.
 *
 * Best-effort — never throws, because a failure here must not break the email reply flow. Returns
 * `true` when the gate-relevant top-level flip succeeded.
 */
export async function capturePhoneConsent(
  chatId: string,
  numberRaw: string,
  proof?: Record<string, unknown> | null
): Promise<boolean> {
  const number = String(numberRaw ?? '').trim();
  if (!chatId || !number) return false;

  const consent: Record<string, unknown> = {
    source: 'email_reply',
    at: new Date().toISOString(),
    number,
  };
  if (proof) {
    for (const [k, v] of Object.entries(proof)) {
      if (v !== null && v !== undefined) consent[k] = v;
    }
  }

  try {
    await setMemory(chatId, {
      phone_number: number,
      _phone_consent: consent,
      _phone_consent_at: consent.at as string,
    });
  } catch (e) {
    console.warn(
      `[OB] capturePhoneConsent memory write failed chat=${chatId}: ${e}`
    );
  }

  let ok = false;
  try {
    // The gate-relevant write: reopen the phone channel on the trustworthy top-level keys.
    await chatRef(chatId).update({ phone_opt_out: false, block_phone: 'N' });
    ok = true;
  } catch (e) {
    console.warn(
      `[OB] capturePhoneConsent top-level flip failed chat=${chatId}: ${e}`
    );
  }

  try {
    await addLabelToChat(chatId, 'phone_consent_captured');
  } catch (e) {
    console.warn(`[OB] capturePhoneConsent label failed chat=${chatId}: ${e}`);
  }

  console.log(
    `[OB] phone consent captured for chat=${chatId} (***${number.slice(-4)}) — phone channel reopened`
  );
  return ok;
}

/**
 * True iff a manual stage update to `Lead` must be blocked.
 *
 * `Lead` is owned by a successful meeting booking, which sets the stage, the Deal, and
 * `memory.meeting_booked` together. A manual `Lead` is allowed only when a booking is already on
 * record — otherwise a failed booking could leave the prospect at `Lead` with no Deal behind it.
 */
export function shouldBlockManualLead(
  stage: string | null | undefined,
  memory: ChatMemory | null | undefined
): boolean {
  if (
    String(stage ?? '')
      .trim()
      .toLowerCase() !== 'lead'
  ) {
    return false;
  }
  return (memory ?? {}).meeting_booked !== true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bedrock history repair
// ─────────────────────────────────────────────────────────────────────────────

function isBlock(b: unknown): b is Record<string, unknown> {
  return typeof b === 'object' && b !== null;
}

/** Merge adjacent same-role messages so history strictly alternates user ↔ assistant. */
function mergeConsecutiveRoles(messages: BedrockMessage[]): BedrockMessage[] {
  const merged: BedrockMessage[] = [];
  for (const m of messages) {
    const content = m.content ?? [];
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = [...(last.content ?? []), ...content];
    } else {
      merged.push({ role: m.role, content: [...content] });
    }
  }
  return merged;
}

/**
 * Drop `toolUse` blocks not answered by a matching `toolResult` in the IMMEDIATELY following message,
 * and orphan `toolResult` blocks with no matching `toolUse` in the preceding one — anywhere in the
 * history, not just at the tail. Then drop any message left with no content.
 *
 * Bedrock and Anthropic both require every `toolUse` to be answered by a `toolResult` in the next
 * message. A crashed turn — the model errored right after a `toolUse` was persisted, then the
 * customer sent a new message — leaves a dangling `toolUse` mid-history that bricks *every* later
 * turn with "`tool_use` ids were found without `tool_result` blocks immediately after". Assumes
 * strictly alternating roles, so run it after `mergeConsecutiveRoles`.
 */
function stripUnpairedToolBlocks(messages: BedrockMessage[]): BedrockMessage[] {
  const n = messages.length;
  messages.forEach((m, i) => {
    const content = m.content ?? [];
    if (
      m.role === 'assistant' &&
      content.some((b) => isBlock(b) && 'toolUse' in b)
    ) {
      const answered = new Set<string>();
      if (i + 1 < n && messages[i + 1].role === 'user') {
        for (const b of messages[i + 1].content ?? []) {
          if (isBlock(b) && 'toolResult' in b) {
            const tid = (b.toolResult as Record<string, unknown> | undefined)
              ?.toolUseId;
            if (tid) answered.add(String(tid));
          }
        }
      }
      m.content = content.filter(
        (b) =>
          !(
            isBlock(b) &&
            'toolUse' in b &&
            !answered.has(
              String(
                (b.toolUse as Record<string, unknown> | undefined)?.toolUseId
              )
            )
          )
      );
    } else if (
      m.role === 'user' &&
      content.some((b) => isBlock(b) && 'toolResult' in b)
    ) {
      const uses = new Set<string>();
      if (i - 1 >= 0 && messages[i - 1].role === 'assistant') {
        for (const b of messages[i - 1].content ?? []) {
          if (isBlock(b) && 'toolUse' in b) {
            const tid = (b.toolUse as Record<string, unknown> | undefined)
              ?.toolUseId;
            if (tid) uses.add(String(tid));
          }
        }
      }
      m.content = content.filter(
        (b) =>
          !(
            isBlock(b) &&
            'toolResult' in b &&
            !uses.has(
              String(
                (b.toolResult as Record<string, unknown> | undefined)?.toolUseId
              )
            )
          )
      );
    }
  });
  return messages.filter((m) => (m.content ?? []).length > 0);
}

/**
 * Return a Bedrock-valid copy of an outbound chat's message history.
 *
 * Outbound turns can chain several tools in one turn (`make_phone_call` then `send_email`, say), and
 * an interrupted post-tool round-trip can leave the history in a state Bedrock rejects: consecutive
 * same-role messages, a `toolUse` (trailing or mid-history) whose `toolResult` never arrived, or an
 * orphan `toolResult`. Because Bedrock validates before the model responds, such a history makes
 * EVERY subsequent turn fail — this repair is what lets the chat self-heal.
 *
 * Pure and best-effort: on any unexpected shape it returns the input unchanged rather than risk
 * mangling real history.
 */
export function repairOutboundHistory(
  messages: BedrockMessage[] | null | undefined
): BedrockMessage[] | null | undefined {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  try {
    for (const m of messages) {
      if (typeof m !== 'object' || m === null || !('role' in m))
        return messages;
    }

    let merged = mergeConsecutiveRoles(messages);
    merged = stripUnpairedToolBlocks(merged); // drops unpaired tool blocks + empty messages
    merged = mergeConsecutiveRoles(merged); // re-merge in case a message was dropped

    // Belt and braces: a trailing assistant turn that is now pure text is fine, but never end on an
    // assistant `toolUse` — nothing can answer it.
    const last = merged[merged.length - 1];
    if (last && last.role === 'assistant') {
      if ((last.content ?? []).some((b) => isBlock(b) && 'toolUse' in b)) {
        merged.pop();
      }
    }
    return merged;
  } catch (e) {
    console.warn(`[OB] repairOutboundHistory failed, passing through: ${e}`);
    return messages;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create (or fetch) the outbound chat under a NAMESPACED deterministic doc id:
 * `outbound__{agentId}__{user}`, where `user` is the phone if present, else the email.
 *
 * The `outbound__` prefix is what keeps outbound documents from ever colliding with inbound chats
 * (which use `{agentId}__{user}`), so an outbound lead can never overwrite a live inbound chat.
 *
 * Returns `{chatId, created}`. `created` is `false` when the document already existed — meaning a
 * phone/email COLLISION reused an existing chat rather than creating a new one, which the caller
 * needs to know.
 */
export async function getOrCreateOutboundChat(
  agentId: string,
  chatKey: string,
  displayName = '',
  dealerId?: string | null
): Promise<{ chatId: string; created: boolean }> {
  const chatId = 'outbound__' + buildDeterministicChatId(agentId, chatKey);
  const ref = chatRef(chatId);
  if ((await ref.get()).exists) return { chatId, created: false };

  // Re-enroll dedup for an id-namespace mismatch. The deterministic doc id embeds `agentId`, but a
  // chat MIGRATED from another agent keeps its OLD doc id while its `agentId` field now points here.
  // Re-enrolling that contact under this agent would otherwise create a DUPLICATE under the new
  // namespaced id. Query the auto-indexed `userId` only — no composite index needed — and filter
  // agent and type in code.
  try {
    const snap = await db
      .collection('chats')
      .where('userId', '==', chatKey)
      .limit(10)
      .get();
    for (const doc of snap.docs) {
      const dd = (doc.data() ?? {}) as ChatDoc;
      if (dd.type === 'outbound' && String(dd.agentId) === String(agentId)) {
        console.log(
          `[OB] reusing existing outbound chat ${doc.id} for agent=${agentId} ` +
            `user=${chatKey} (doc-id namespace mismatch — migrated chat)`
        );
        return { chatId: doc.id, created: false };
      }
    }
  } catch (e) {
    console.warn(
      `[OB] re-enroll dedup lookup failed agent=${agentId} user=${chatKey}: ${e}`
    );
  }

  let companyId = '';
  try {
    const a = await db.collection('agents').doc(agentId).get();
    companyId = a.exists ? String((a.data() ?? {}).company_id ?? '') : '';
  } catch (e) {
    console.error(`[OB] company_id lookup failed for agent ${agentId}: ${e}`);
  }

  const data: Record<string, unknown> = {
    agentId,
    userId: chatKey,
    attendee_id: chatKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    company_id: companyId,
    status: 'active',
    status_changed_at: new Date().toISOString(),
    playground: false,
    memory: { display_name: displayName },
    channel: 'email',
    type: 'outbound',
    // The deterministic gate keys, present from the get-go: code-owned, never LLM-written. Flipped
    // true later by the DNC scrub, the email unsubscribe path, or intake flags.
    email_opt_out: false,
    phone_opt_out: false,
  };
  if (dealerId) {
    data.dealer_id = dealerId;
    data.dealers_id = dealerId;
  }

  try {
    await ref.create(data); // rejects if a concurrent call won the race — which is fine
  } catch (e) {
    console.log(
      `[OB] outbound chat ${chatId} already exists or create race: ${e}`
    );
  }
  return { chatId, created: true };
}

/** Stamp a high-level `type` field on the chat doc, covering pre-existing chats. Best-effort. */
export async function setChatType(
  chatId: string,
  chatType = 'outbound'
): Promise<void> {
  try {
    await chatRef(chatId).set({ type: chatType }, { merge: true });
  } catch (e) {
    console.error(`[OB] setChatType failed chat=${chatId}: ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up counters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two independent counters stored ON THE CHAT DOC (the source of truth, like `stage`): how many
 * follow-up emails and calls have gone out. The FIRST outreach on a channel is touch #0, not a
 * follow-up; every later send on that channel increments its counter.
 *
 * The outbound skill's prompt text owns the cadence *timing*; this code owns the *count* and surfaces
 * it back into the prompt. Both reset to zero when the prospect engages, because a reply starts a
 * fresh cadence.
 */
const FOLLOWUP_COUNT_KEYS: Readonly<Record<string, string>> = {
  email: 'email_followup_count',
  call: 'call_followup_count',
};

/** Atomically increment the follow-up counter for channel `'email'` or `'call'`. Best-effort. */
export async function bumpFollowupCount(
  chatId: string,
  channel: string
): Promise<void> {
  const key = FOLLOWUP_COUNT_KEYS[channel];
  if (!chatId || !key) return;
  try {
    await chatRef(chatId).set(
      { [key]: FieldValue.increment(1) },
      { merge: true }
    );
  } catch (e) {
    console.warn(
      `[OB] bumpFollowupCount(${channel}) failed chat=${chatId}: ${e}`
    );
  }
}

/** Zero both follow-up counters — a fresh cadence once the prospect engages. Best-effort. */
export async function resetFollowupCounts(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    await chatRef(chatId).set(
      { email_followup_count: 0, call_followup_count: 0 },
      { merge: true }
    );
  } catch (e) {
    console.warn(`[OB] resetFollowupCounts failed chat=${chatId}: ${e}`);
  }
}

/** Read `{email, call}` follow-up counts from the chat doc, zero-defaulted. Best-effort. */
export async function getFollowupCounts(
  chatId: string
): Promise<{ email: number; call: number }> {
  try {
    const d = (await loadChatDoc(chatId)) ?? {};
    return {
      email: Number(d.email_followup_count ?? 0),
      call: Number(d.call_followup_count ?? 0),
    };
  } catch {
    return { email: 0, call: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-chat dial dedup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp, tolerating a trailing `Z` or a naive value, into a `Date` — or `null`.
 * Naive values are read as UTC, matching the source's `replace(tzinfo=utc)`.
 */
function parseIso(val: unknown): Date | null {
  if (!val) return null;
  try {
    let s = String(val).replace('Z', '+00:00');
    // A naive stamp (no zone offset after the time part) is UTC by convention here.
    const hasZone = /(?:[+-]\d{2}:?\d{2})$/.test(s);
    if (!hasZone) s = `${s}Z`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * The structural stop for the repeat-dial storm: should a NEW outbound dial be BLOCKED for this chat
 * right now?
 *
 * Pure and unit-testable. Blocks when a prior call is too recent (the recency floor) OR is still
 * awaiting review, within a fail-open maximum so a chat whose review never ran is not frozen forever.
 * Independent of the task-claim and per-chat-serial layers — a belt-and-braces guard at the tool
 * itself, keyed on the stamps the call tool and the transcript review write.
 *
 * A legitimate follow-up cadence is hours or days apart, so the 30-minute floor never blocks a real
 * follow-up; it only kills minute-apart re-fires.
 */
export function recentDialBlocks(
  memory: ChatMemory | null | undefined,
  now?: Date
): { blocked: boolean; reason: string } {
  const m = memory ?? {};
  const at = now ?? new Date();
  const last = parseIso(m._last_outbound_call_at ?? m._first_outbound_call_at);
  if (last === null) return { blocked: false, reason: '' };

  const ageMin = (at.getTime() - last.getTime()) / 60_000;
  if (ageMin < 0) {
    // Clock skew or a future stamp — prefer safe and treat it as recent.
    return {
      blocked: true,
      reason: 'last call stamp is in the future (clock skew) — not dialing',
    };
  }

  const floor = dialRecencyFloorMin();
  if (ageMin < floor) {
    return {
      blocked: true,
      reason: `last call was ${Math.trunc(ageMin)} min ago (< ${floor} min recency floor)`,
    };
  }

  const reviewed = parseIso(m._last_call_reviewed_at);
  const awaiting = reviewed === null || reviewed < last;
  if (awaiting && ageMin < dialAwaitingReviewMaxMin()) {
    return {
      blocked: true,
      reason: `prior call ${Math.trunc(ageMin)} min ago is still awaiting review`,
    };
  }
  return { blocked: false, reason: '' };
}

/**
 * True if a call was placed for this chat that has NOT been reviewed since — i.e. it is still in
 * flight from the cadence's point of view, and the dial guard is blocking on it.
 */
export function callAwaitingReview(
  memory: ChatMemory | null | undefined
): boolean {
  const m = memory ?? {};
  const last = parseIso(m._last_outbound_call_at);
  if (last === null) return false;
  const reviewed = parseIso(m._last_call_reviewed_at);
  return reviewed === null || reviewed < last;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat lookup by email
// ─────────────────────────────────────────────────────────────────────────────

/** Pick the most recently updated of a set of candidate chats, by whichever stamp is present. */
function newestChatId(
  rows: Array<{ id: string; data: ChatDoc }>
): string | null {
  let bestId: string | null = null;
  let bestTs: number | null = null;
  for (const { id, data } of rows) {
    const raw =
      data.updatedAt ?? data.updated_at ?? data.created ?? data.createdAt;
    const ts = toDate(raw)?.getTime() ?? null;
    if (bestId === null || (ts !== null && (bestTs === null || ts > bestTs))) {
      bestId = id;
      bestTs = ts;
    }
  }
  return bestId;
}

/**
 * Resolve an OUTBOUND chat by the customer's email.
 *
 * Matches ONLY chats stamped `type == "outbound"` — never an inbound or SMS chat, even when it shares
 * the same `customer_email`, because the same prospect can legitimately have both. Most recently
 * updated wins.
 */
export async function getOutboundChatByEmail(
  email: string,
  agentId?: string | null
): Promise<string | null> {
  if (!email) return null;
  try {
    const normalized = email.trim().toLowerCase();
    let q = db
      .collection('chats')
      .where('memory.customer_email', '==', normalized);
    if (agentId) q = q.where('agentId', '==', agentId);
    const snap = await q.limit(50).get();
    const rows = snap.docs
      .map((c) => ({ id: c.id, data: (c.data() ?? {}) as ChatDoc }))
      .filter((r) => r.data.type === 'outbound'); // strictly outbound — never fall back to inbound
    return newestChatId(rows);
  } catch (e) {
    console.error(`[OB] getOutboundChatByEmail failed: ${e}`);
    return null;
  }
}

/**
 * Resolve a WEB-WIDGET (inbound) chat by the lead's email — the fallback the email webhook uses when
 * the outbound matcher misses.
 *
 * Web chats store the address as `memory.email` and carry no `type` field, so anything stamped
 * `type == "outbound"` is excluded here: the mirror image of `getOutboundChatByEmail`.
 */
export async function getWebChatByEmail(
  email: string,
  agentId?: string | null
): Promise<string | null> {
  if (!email) return null;
  try {
    const normalized = email.trim().toLowerCase();
    let q = db.collection('chats').where('memory.email', '==', normalized);
    if (agentId) q = q.where('agentId', '==', agentId);
    const snap = await q.limit(50).get();
    const rows = snap.docs
      .map((c) => ({ id: c.id, data: (c.data() ?? {}) as ChatDoc }))
      .filter((r) => r.data.type !== 'outbound'); // outbound chats belong to the outbound matcher
    return newestChatId(rows);
  } catch (e) {
    console.error(`[OB] getWebChatByEmail failed: ${e}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation logging
// ─────────────────────────────────────────────────────────────────────────────

/** The internal classification the email choke point stamps on every send. */
export interface EmailLabel {
  profile?: string;
  origin?: string;
}

/**
 * Append a UI-visible email message to `messages_v3`. Best-effort.
 *
 * `email_label` on outbound sends is the internal classification stamped by the email choke point —
 * `{profile: outreach|reply|transactional, origin: llm_tool|nudge_service|transactional_service}` —
 * so chats can be analyzed one by one or in aggregate later.
 */
export async function logEmailMessage(
  chatId: string,
  body: string,
  direction: string,
  subject = '',
  emailLabel?: EmailLabel | null
): Promise<void> {
  try {
    const senderKind = direction === 'inbound' ? 'customer' : 'ai';
    const recipient = direction === 'inbound' ? 'ai' : 'customer';
    const doc: Record<string, unknown> = {
      timestamp: new Date(),
      direction,
      source: 'email',
      type: 'text',
      status: direction === 'inbound' ? 'delivered' : 'sent',
      sender: { kind: senderKind },
      recipient,
      sms_owner: 'outbound_agent',
      content: { body: body ?? '', subject: subject ?? '' },
      attachments: [],
    };
    if (emailLabel) {
      doc.email_label = {
        profile: emailLabel.profile ?? '',
        origin: emailLabel.origin ?? '',
      };
    }
    await chatRef(chatId).collection('messages_v3').doc().set(doc);
  } catch (e) {
    console.error(`[OB] logEmailMessage failed chat=${chatId}: ${e}`);
  }
}

/**
 * Append an inbound email as a Bedrock-format user message to the chat's `messages` history.
 *
 * ONLY for SHORT-CIRCUIT webhook paths — opt-out, suppressed, not-outbound, no-agent — where no LLM
 * turn runs. Without this the email is stranded in `messages_v3` and invisible to the model on every
 * later turn, including an admin `@ai` "read the inbound email and reply".
 *
 * Do NOT call it on the normal reply path: there the turn already puts the body into that turn and
 * persists it, so a second write would duplicate the email in history.
 *
 * Writes straight to the `messages` subcollection rather than routing through `addMessagesToChat`,
 * which would also mirror to `messages_v3` (duplicating the row `logEmailMessage` already wrote) and
 * try to parse the text as a customer-JSON payload, producing noisy parse errors.
 */
export async function logInboundEmailToHistory(
  chatId: string,
  body: string,
  subject = ''
): Promise<boolean> {
  try {
    if (!chatId || !String(body ?? '').trim()) return false;
    const header = '[Inbound email]' + (subject ? ` Subject: ${subject}` : '');
    const text = `${header}\n\n${body.trim()}`;
    await chatRef(chatId)
      .collection('messages')
      .doc()
      .set({
        role: 'user',
        content: [{ text }],
        timestamp: new Date(),
      });
    return true;
  } catch (e) {
    console.error(`[OB] logInboundEmailToHistory failed chat=${chatId}: ${e}`);
    return false;
  }
}

const EMAIL_ACTIVITY_NAMES: Readonly<Record<string, string>> = {
  reply: 'email_reply_received',
  unsubscribe: 'email_unsubscribed',
  spam: 'email_spam_reported',
  bounce: 'email_bounced',
};

const EMAIL_ACTIVITY_MESSAGES: Readonly<Record<string, string>> = {
  reply: 'Customer replied by email',
  unsubscribe: 'Customer unsubscribed (email opt-out)',
  spam: 'Customer marked email as spam (email opt-out)',
  bounce: 'Email hard-bounced (address marked invalid)',
};

/**
 * UI-visible activity for a customer email event (reply, unsubscribe, spam, bounce), written to the
 * chat's `activities` subcollection.
 *
 * Uses `kind: 'tool_call'` with a descriptive `toolName` — the same shape every standalone activity
 * uses — so the activity feed renders it with no frontend change. Best-effort.
 */
export async function logEmailActivity(
  chatId: string,
  event: string,
  senderEmail?: string | null,
  subject?: string | null
): Promise<void> {
  try {
    await chatRef(chatId)
      .collection('activities')
      .doc()
      .set({
        timestamp: new Date(),
        kind: 'tool_call',
        toolCall: {
          toolName: EMAIL_ACTIVITY_NAMES[event] ?? event,
          input: { from: senderEmail ?? '', subject: subject ?? '' },
          result: { message: EMAIL_ACTIVITY_MESSAGES[event] ?? event },
          status: 'success',
        },
      });
  } catch (e) {
    console.error(`[OB] logEmailActivity failed chat=${chatId}: ${e}`);
  }
}

/**
 * Write an AI internal note to the conversation (`messages_v3`, `direction: 'internal'`) — visible to
 * admins in the thread, never sent to the customer.
 *
 * Used to surface when the agent could NOT carry out an action, so a blocked turn explains itself
 * instead of looking silent. Best-effort.
 */
export async function logInternalNote(
  chatId: string,
  body: string
): Promise<void> {
  try {
    await chatRef(chatId)
      .collection('messages_v3')
      .doc()
      .set({
        timestamp: new Date(),
        direction: 'internal',
        source: 'virtuans',
        type: 'text',
        status: 'delivered',
        sender: { kind: 'ai' },
        recipient: 'admin',
        content: { body: body ?? '' },
        attachments: [],
      });
  } catch (e) {
    console.error(`[OB] logInternalNote failed chat=${chatId}: ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn-outcome scans
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool outcomes meaning "the action did NOT happen", worth surfacing to the admin. `deferred` is
 * deliberately excluded: it is a scheduled retry, not a failure.
 */
const FAILED_ACTION_STATUSES: ReadonlySet<string> = new Set([
  'skipped',
  'failed',
  'blocked',
]);

/** The `{json: {...}}` payload carried by a `toolResult`, or `{}`. */
function resultJson(tr: Record<string, unknown>): Record<string, unknown> {
  for (const c of (tr.content ?? []) as unknown[]) {
    if (isBlock(c) && isBlock(c.json)) return c.json as Record<string, unknown>;
  }
  return {};
}

function blocksOf(entry: unknown): Record<string, unknown>[] {
  if (!isBlock(entry)) return [];
  const content = entry.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isBlock);
}

/**
 * Chat-level, tool-agnostic scan of one turn's Bedrock entries. Returns admin-readable note strings
 * for every tool call whose result means the action did not happen — status in
 * skipped/failed/blocked, or `success: false` / an error with no status. Empty when the turn
 * succeeded.
 *
 * The first pass collects which tools SUCCEEDED somewhere in the turn, because a tool that was
 * blocked and then also succeeded (a send gated pre-booking, then sent post-booking) self-corrected:
 * its earlier block is not a real failure and must not surface a note.
 */
export function notesForFailedActions(
  newChatEntries: BedrockMessage[] | null | undefined
): string[] {
  const toolNames = new Map<string, string>(); // toolUseId → toolName
  const succeededTools = new Set<string>();
  const notes: string[] = [];

  try {
    for (const entry of newChatEntries ?? []) {
      for (const block of blocksOf(entry)) {
        const tu = block.toolUse;
        if (isBlock(tu) && tu.toolUseId) {
          toolNames.set(String(tu.toolUseId), String(tu.name ?? 'action'));
        }
      }
    }

    for (const entry of newChatEntries ?? []) {
      for (const block of blocksOf(entry)) {
        const tr = block.toolResult;
        if (!isBlock(tr)) continue;
        const res = resultJson(tr);
        const status = String(res.status ?? '').toLowerCase();
        if (
          status === 'success' ||
          status === 'sent' ||
          (!status && res.success === true)
        ) {
          succeededTools.add(toolNames.get(String(tr.toolUseId)) ?? 'action');
        }
      }
    }

    for (const entry of newChatEntries ?? []) {
      for (const block of blocksOf(entry)) {
        const tr = block.toolResult;
        if (!isBlock(tr)) continue;
        const res = resultJson(tr);
        const status = String(res.status ?? '').toLowerCase();
        const failed =
          FAILED_ACTION_STATUSES.has(status) ||
          (!status && (res.success === false || Boolean(res.error)));
        if (!failed) continue;
        const tool = toolNames.get(String(tr.toolUseId)) ?? 'action';
        if (succeededTools.has(tool)) continue; // self-corrected this turn
        const detail =
          res.message ?? res.reason ?? res.error ?? status ?? 'blocked';
        notes.push(
          `⚠️ The agent couldn't complete ${tool} — ${String(detail)}`
        );
      }
    }
  } catch (e) {
    console.warn(`[OB] notesForFailedActions scan failed: ${e}`);
  }
  return notes;
}

/**
 * Deterministic BY-DESIGN gates — expected, no-real-work outcomes that carry their own explanation
 * (phone-lane-call-only, opt-out, suppressed, business-hours or capacity defer, dedup). A `deferred`
 * has already scheduled its own retry.
 *
 * `failed` is deliberately EXCLUDED: a genuine failure is not a by-design gate and must stay visible,
 * so it never takes the quiet activity-only path.
 */
const BY_DESIGN_GATED_STATUSES: ReadonlySet<string> = new Set([
  'skipped',
  'blocked',
  'deferred',
]);

/**
 * True iff every tool call in `entries` ended in a deterministic by-design gate and NONE either
 * succeeded or genuinely failed.
 *
 * In that case the turn produced no real, LLM-worthy work and no error worth showing: it can end
 * without another generate round-trip and be persisted as an activity only, kept out of the
 * re-tokenized `messages` history, with no chat note.
 *
 * Returns `false` — the NORMAL path, persisted with a visible "couldn't complete" note — when a real
 * action succeeded, when a genuine failure occurred, or on ANY ambiguity (no tool result, an
 * unrecognized shape). That asymmetry is the point: by-design gates stay quiet while genuine
 * failures stay visible.
 */
export function turnIsByDesignGated(
  entries: BedrockMessage[] | null | undefined
): boolean {
  let sawGated = false;
  try {
    for (const entry of entries ?? []) {
      for (const block of blocksOf(entry)) {
        const tr = block.toolResult;
        if (!isBlock(tr)) continue;
        const res = resultJson(tr);
        const status = String(res.status ?? '').toLowerCase();

        // A real action happened → not gated.
        if (
          status === 'success' ||
          status === 'sent' ||
          (!status && res.success === true)
        ) {
          return false;
        }
        // A GENUINE FAILURE → not gated: it must stay visible in the chat.
        if (
          status === 'failed' ||
          (!status && (res.success === false || Boolean(res.error)))
        ) {
          return false;
        }
        if (BY_DESIGN_GATED_STATUSES.has(status)) {
          sawGated = true;
          continue;
        }
        return false; // unrecognized or ambiguous → keep normal behaviour
      }
    }
  } catch (e) {
    console.warn(`[OB] turnIsByDesignGated scan failed: ${e}`);
    return false;
  }
  return sawGated;
}

/**
 * If the turn made NO tool call, return the agent's concatenated assistant text; otherwise `null`.
 *
 * Used to surface a text-only `@ai` reply (say "I don't see an inbound email") as an internal note, so
 * a do-nothing turn explains itself. The end-turn `"Done"` placeholder is ignored.
 */
export function assistantTextIfNoTool(
  newChatEntries: BedrockMessage[] | null | undefined
): string | null {
  const texts: string[] = [];
  try {
    for (const entry of newChatEntries ?? []) {
      for (const block of blocksOf(entry)) {
        if (block.toolUse) return null; // a tool ran → covered by the other scans
        if (entry.role === 'assistant' && 'text' in block) {
          const t = String(block.text ?? '').trim();
          if (t && t !== 'Done') texts.push(t);
        }
      }
    }
  } catch (e) {
    console.warn(`[OB] assistantTextIfNoTool scan failed: ${e}`);
    return null;
  }
  const joined = texts.join('\n').trim();
  return joined || null;
}

/**
 * Compact block of the last `limit` REAL conversation messages from `messages_v3`, chronological, for
 * injecting recent cross-channel context on an `@ai` trigger.
 *
 * Counts only customer-facing exchanges — phone calls, emails, customer and agent messages. INTERNAL
 * entries (admin `@ai` triggers, internal AI notes) are excluded and do not count toward `limit`,
 * which is why the query over-fetches before filtering. Best-effort → `''` on error.
 */
export async function recentConversationContext(
  chatId: string,
  limit = 3
): Promise<string> {
  if (!chatId || limit <= 0) return '';
  let rows: Array<Record<string, unknown>>;
  try {
    const snap = await chatRef(chatId)
      .collection('messages_v3')
      .orderBy('timestamp', 'desc')
      .limit(Math.max(limit * 5, 30))
      .get();
    rows = snap.docs.map((r) => (r.data() ?? {}) as Record<string, unknown>);
  } catch (e) {
    console.warn(
      `[OB] recentConversationContext query failed chat=${chatId}: ${e}`
    );
    return '';
  }

  const picked: Array<Record<string, unknown>> = [];
  for (const d of rows) {
    // newest-first
    if (d.direction === 'internal') continue; // skip admin @ai + internal notes
    picked.push(d);
    if (picked.length >= limit) break;
  }
  picked.reverse(); // chronological for the LLM

  const agentName = await resolveOutboundName(chatId);
  const lines: string[] = [];
  for (const d of picked) {
    const c = (d.content ?? {}) as Record<string, unknown>;
    const channel = String(d.source ?? 'message').toUpperCase();
    const who =
      ((d.sender ?? {}) as Record<string, unknown>).kind === 'customer'
        ? 'Customer'
        : agentName;
    // Call cards carry the summary rather than a body.
    const body = String(c.summary ?? c.body ?? '').trim();
    const subject = String(c.subject ?? '').trim();
    let text = (subject ? `[${subject}] ` : '') + body;
    if (text.length > 600) text = text.slice(0, 600) + '…';
    lines.push(`${channel} · ${who}: ${text}`);
  }
  return lines.join('\n');
}

/** The meeting host's role. HubSpot owner data carries no reliable job title, so it lives here. */
/**
 * Resolve and cache the meeting host — the HubSpot contact OWNER's display name — as
 * `memory.meeting_host`.
 *
 * This is what lets the agent tell a prospect who they will actually be meeting, by name, across email,
 * SMS, and a live call, and it is what reminders and confirmations use to name the rep.
 *
 * Idempotent: an already-cached name short-circuits before any CRM call, so the common path costs
 * nothing. Real records resolve the config `owner_id`, Test records `owner_id_test` — the same split as
 * the meeting link, so the named host is the owner of the calendar being booked.
 *
 * Best-effort throughout: returns the name or `null`, never throws, and never blocks its caller. When a
 * `memory` object was passed in, the resolved name is written back onto it too, so the caller's already-
 * loaded copy is not stale for the rest of the turn.
 *
 * Closes the seam deferred out of Phase 3.
 */
export async function ensureMeetingHost(
  chatId: string,
  agentId?: string | null,
  memory?: ChatMemory | null
): Promise<string | null> {
  try {
    const mem = memory ?? (await getMemory(chatId)) ?? {};
    const existing = String(mem.meeting_host ?? '').trim();
    if (existing) return existing;

    const aid = String(agentId || mem.agent_id || '');
    if (!chatId || !aid) return null;

    const { resolveHubspotConfig, accessToken } = await import('./hubspot');
    const { resolveOwnerName } = await import('./hubspotDiscovery');
    const { getAgentActions } = await import('../firebase/agent');

    const cfg = resolveHubspotConfig((await getAgentActions(aid)) ?? []);
    if (!cfg || Object.keys(cfg).length === 0) return null;

    const isTest =
      String(mem.record_type ?? '')
        .trim()
        .toLowerCase() === 'test';
    const ownerId =
      isTest && cfg.owner_id_test ? cfg.owner_id_test : cfg.owner_id;
    if (!ownerId) return null;

    const token = await accessToken(cfg, aid);
    if (!token) return null;

    const name = await resolveOwnerName(token, ownerId);
    if (name) {
      await setMemory(chatId, { meeting_host: name });
      // Keep the caller's loaded copy current for the rest of this turn.
      if (memory) memory.meeting_host = name;
      return name;
    }
    return null;
  } catch (e) {
    console.warn(`[OB] ensureMeetingHost failed chat=${chatId}: ${e}`);
    return null;
  }
}

export const MEETING_HOST_TITLE = 'VP of Sales';

/**
 * One-line fact injected into the agent's prompt and call scope so it can name who the prospect will
 * meet — even on first contact, before a booking exists. `''` when no host is known.
 */
export function meetingHostFact(name: string | null | undefined): string {
  const n = String(name ?? '').trim();
  if (!n) return '';
  return (
    `MEETING HOST: the prospect will meet with our ${MEETING_HOST_TITLE}, ${n}. ` +
    `If they ask who they'll speak to, meet, or who will be on the demo — even before a ` +
    `meeting is booked — tell them it's our ${MEETING_HOST_TITLE}, ${n}.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-chat email rollup
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed enums — safe as Firestore dot-path segments, because they are never raw user input. */
const EMAIL_META_PROFILES = ['outreach', 'reply', 'transactional'] as const;
const EMAIL_META_STATUSES = ['sent', 'failed', 'skipped', 'deferred'] as const;

export type EmailMetaStatus = (typeof EMAIL_META_STATUSES)[number];

/**
 * Per-chat email rollup at `chats/{id}.email_meta`, written by the email choke point on EVERY outcome
 * so a single chat read answers "what email activity happened here, and why":
 *
 *     email_meta: {
 *       counts:     {sent, failed, skipped, deferred},   // atomic increments
 *       by_profile: {outreach, reply, transactional},    // sent counts per internal label
 *       last_outcome: {status, profile, origin, reason, error, recipient, at},
 *       last_sent_at,
 *     }
 *
 * Cross-chat analysis uses the `email_send_log` collection, labelled the same way; this rollup is the
 * fast per-chat view. Best-effort; never throws.
 */
export async function updateEmailMeta(
  chatId: string,
  opts: {
    status: string;
    profile?: string | null;
    origin?: string | null;
    reason?: string | null;
    error?: string | null;
    recipient?: string | null;
  }
): Promise<void> {
  const { status, profile, origin, reason, error, recipient } = opts;
  if (!chatId || !(EMAIL_META_STATUSES as readonly string[]).includes(status)) {
    return;
  }
  try {
    const now = new Date();
    const updates: Record<string, unknown> = {
      [`email_meta.counts.${status}`]: FieldValue.increment(1),
      'email_meta.last_outcome': {
        status,
        profile: profile ?? '',
        origin: origin ?? '',
        reason: reason ?? '',
        error: String(error ?? '').slice(0, 300),
        recipient: String(recipient ?? '').toLowerCase(),
        at: now,
      },
    };
    if (status === 'sent') {
      updates['email_meta.last_sent_at'] = now;
      if (
        profile &&
        (EMAIL_META_PROFILES as readonly string[]).includes(profile)
      ) {
        updates[`email_meta.by_profile.${profile}`] = FieldValue.increment(1);
      }
    }
    await chatRef(chatId).update(updates);
  } catch (e) {
    console.warn(
      `[OB] email_meta update failed chat=${chatId} (non-blocking): ${e}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable call index
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `conversation_id → chat_id`, for the post-call webhook.
 *
 * `pending_calls` is deleted at the end of the place-call turn, and the webhook's number-based
 * fallback fails whenever we dial a number that differs from the chat key (an admin `@ai call
 * <other number>`, say). This outbound-owned index survives until the webhook consumes it, so a call
 * is always resolvable by its conversation id regardless of which number was dialed.
 */
const CALL_INDEX = 'outbound_call_index';

/** Persist `callId → chatId` so the post-call webhook can resolve the chat. Best-effort. */
export async function saveOutboundCallIndex(
  callId: string,
  chatId: string,
  agentId?: string | null
): Promise<void> {
  if (!callId || !chatId) return;
  try {
    await db
      .collection(CALL_INDEX)
      .doc(callId)
      .set({
        chat_id: chatId,
        agent_id: agentId ?? '',
        created_at: new Date(),
      });
  } catch (e) {
    console.error(`[OB] saveOutboundCallIndex failed call=${callId}: ${e}`);
  }
}

/** `{chat_id, agent_id}` for a call id, or `{}` if absent. Never throws. */
export async function getOutboundCallIndex(
  callId: string
): Promise<Record<string, unknown>> {
  if (!callId) return {};
  try {
    const doc = await db.collection(CALL_INDEX).doc(callId).get();
    return doc.exists ? (doc.data() ?? {}) : {};
  } catch (e) {
    console.error(`[OB] getOutboundCallIndex failed call=${callId}: ${e}`);
    return {};
  }
}

/** Remove the index entry once the webhook or review has consumed it. Best-effort. */
export async function deleteOutboundCallIndex(callId: string): Promise<void> {
  if (!callId) return;
  try {
    await db.collection(CALL_INDEX).doc(callId).delete();
  } catch (e) {
    console.error(`[OB] deleteOutboundCallIndex failed call=${callId}: ${e}`);
  }
}

/**
 * Approximate number of outbound calls currently IN FLIGHT — index documents created within
 * `windowMinutes`. Each entry is deleted once the post-call webhook or review consumes it, and the
 * time window bounds staleness if a webhook never arrives.
 *
 * Used to enforce a workspace-level call concurrency cap. Returns 0 on error so a read failure never
 * blocks placing a call.
 */
export async function countActiveOutboundCalls(
  windowMinutes = 20
): Promise<number> {
  try {
    const cutoff = new Date(
      Date.now() - Math.max(1, Math.trunc(windowMinutes)) * 60_000
    );
    const snap = await db
      .collection(CALL_INDEX)
      .where('created_at', '>=', cutoff)
      .get();
    return snap.docs.length;
  } catch (e) {
    console.error(`[OB] countActiveOutboundCalls failed: ${e}`);
    return 0;
  }
}

const CALL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'make_phone_call',
  'make_phone_call_from_number',
]);

/**
 * Flip the `make_phone_call` entry in the `activities` subcollection — what the Activities panel
 * reads — from `in_progress` to `outcome`, matched by call id. Returns the number of documents
 * updated.
 *
 * Shared by the post-call webhook AND the transcript review, which is the backstop when no webhook
 * arrives.
 */
export async function markCallCompletedInActivities(
  chatId: string,
  conversationId: string,
  summary: string | null,
  outcome: string
): Promise<number> {
  let updated = 0;
  try {
    const snap = await chatRef(chatId).collection('activities').get();
    for (const a of snap.docs) {
      const tc = ((a.data() ?? {}).toolCall ?? {}) as Record<string, unknown>;
      if (!CALL_TOOL_NAMES.has(String(tc.toolName))) continue;
      const res = (tc.result ?? {}) as Record<string, unknown>;
      if (res.call_id !== conversationId) continue;
      if (tc.status !== 'in_progress' && res.status !== 'in_progress') continue;
      const upd: Record<string, unknown> = {
        'toolCall.status': outcome,
        'toolCall.result.status': outcome,
      };
      if (summary) upd['toolCall.result.summary'] = summary;
      await a.ref.update(upd);
      updated += 1;
    }
  } catch (e) {
    console.error(
      `[OB] markCallCompletedInActivities failed chat=${chatId}: ${e}`
    );
  }
  return updated;
}

/**
 * Flip the `make_phone_call` `toolResult` in the `messages` collection (the LLM's context) from
 * `in_progress` to `outcome`, matched by call id, so the next turn sees the call is done. Returns
 * `true` if a result was updated.
 */
export async function markCallCompletedInMessages(
  chatId: string,
  conversationId: string,
  summary: string | null,
  outcome: string
): Promise<boolean> {
  try {
    const snap = await chatRef(chatId)
      .collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      if (d.role !== 'user') continue;
      const content = d.content;
      if (!Array.isArray(content)) continue;

      let changed = false;
      for (const item of content) {
        const tr = isBlock(item) ? item.toolResult : null;
        if (!isBlock(tr)) continue;
        for (const c of (tr.content ?? []) as unknown[]) {
          const j = isBlock(c) ? c.json : null;
          if (
            isBlock(j) &&
            j.call_id === conversationId &&
            j.status === 'in_progress'
          ) {
            j.status = outcome;
            j.success = outcome === 'completed' ? 'true' : 'false';
            if (summary) j.summary = summary;
            j.message = `Call ${outcome}.`;
            changed = true;
          }
        }
      }
      if (changed) {
        await doc.ref.update({ content });
        return true;
      }
    }
  } catch (e) {
    console.error(
      `[OB] markCallCompletedInMessages failed chat=${chatId}: ${e}`
    );
  }
  return false;
}

/**
 * The call id of this chat's most recent `make_phone_call` activity still stuck `in_progress`, or
 * `null`.
 *
 * Lets the deterministic review reconcile flip the right card when it finalizes a stale call, since
 * memory does not carry the call id. Bounded scan of recent activities; best-effort.
 */
export async function findInProgressCallId(
  chatId: string
): Promise<string | null> {
  if (!chatId) return null;
  try {
    const snap = await chatRef(chatId)
      .collection('activities')
      .orderBy('timestamp', 'desc')
      .limit(40)
      .get();
    for (const a of snap.docs) {
      // newest-first
      const tc = ((a.data() ?? {}).toolCall ?? {}) as Record<string, unknown>;
      if (!CALL_TOOL_NAMES.has(String(tc.toolName))) continue;
      const res = (tc.result ?? {}) as Record<string, unknown>;
      if (tc.status === 'in_progress' || res.status === 'in_progress') {
        const cid = res.call_id;
        if (cid) return String(cid);
      }
    }
  } catch (e) {
    console.warn(`[OB] findInProgressCallId failed chat=${chatId}: ${e}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence caps and the email-fallback gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A TEST phone-first chat that still has its EMAIL lane in reserve.
 *
 * Set at enrollment (top-level `email_fallback_available`, memory mirror
 * `_email_fallback_available`) when a test lead has BOTH a reachable phone and email: the phone
 * cadence runs first, and if it is exhausted with no engagement the lane flips phone → email to run
 * the cold email cadence. The flag is cleared once the flip fires, so it never loops, and when a
 * positive phone engagement focuses the phone lane.
 *
 * Real records never set it, so the whole fallback is test-scoped.
 */
export function hasEmailFallback(
  chatDataOrMemory: ChatDoc | ChatMemory | null | undefined
): boolean {
  const d = (chatDataOrMemory ?? {}) as ChatDoc;
  if (d.email_fallback_available === true) return true; // top-level flag
  const m = (
    d.memory && typeof d.memory === 'object' ? d.memory : chatDataOrMemory
  ) as ChatMemory | null;
  return (m ?? {})._email_fallback_available === true;
}

function callCount(
  m: ChatMemory | null | undefined,
  chatData: ChatDoc | null | undefined
): number {
  return Number(
    (m ?? {}).call_followup_count ?? (chatData ?? {}).call_followup_count ?? 0
  );
}

function emailCount(
  m: ChatMemory | null | undefined,
  chatData: ChatDoc | null | undefined
): number {
  return Number(
    (m ?? {}).email_followup_count ?? (chatData ?? {}).email_followup_count ?? 0
  );
}

/**
 * Stages meaning "we never got real engagement". A phone engagement advances to Engaged or Lead — and
 * clears the email-fallback flag — so a still-New/Contacted phone-first chat at the call cap is
 * exactly the fallback case.
 */
const NO_ENGAGEMENT_STAGES: ReadonlySet<string> = new Set([
  '',
  'new',
  'contacted',
]);

/**
 * Deterministic "reached cadence max" check for the CURRENT lane: the phone lane counts call
 * follow-ups, the email lane (the default) counts email follow-ups.
 *
 * A test phone-first chat that is phone-exhausted is NOT necessarily done: if its email fallback is
 * available, `shouldFallbackToEmail` routes it to the email cadence instead of completion. That
 * decision belongs to the callers, not here.
 */
export function cadenceExhausted(
  memory: ChatMemory | null | undefined,
  chatData?: ChatDoc | null
): boolean {
  const m = memory ?? {};
  const lane = String(m._outreach_lane ?? '')
    .trim()
    .toLowerCase();
  if (lane === 'phone') return callCount(m, chatData) >= maxCallFollowups();
  return emailCount(m, chatData) >= maxEmailFollowups();
}

/**
 * The TEST phone-first → email fallback gate. Pure: no writes, no scheduling.
 *
 * True iff the phone cadence is spent with NO engagement and the email lane is still available and
 * reachable — i.e. run the cold email cadence rather than marking the whole cadence complete. ALL of
 * these must hold:
 *  - the email fallback is available (a test chat with both channels reachable at enrollment),
 *  - the current lane is `phone`,
 *  - the phone cadence is exhausted (the call cap is reached),
 *  - the chat never engaged (stage still New/Contacted — an engagement would have cleared the flag),
 *  - email is reachable (address on file, not opted out, not known-bad).
 *
 * Real records never carry the flag, so this is always `false` for them.
 */
export function shouldFallbackToEmail(
  memory: ChatMemory | null | undefined,
  chatData?: ChatDoc | null
): boolean {
  const m = memory ?? {};
  const d = chatData ?? {};
  if (!(hasEmailFallback(d) || hasEmailFallback(m))) return false;
  if (
    String(m._outreach_lane ?? '')
      .trim()
      .toLowerCase() !== 'phone'
  ) {
    return false;
  }
  if (callCount(m, d) < maxCallFollowups()) return false;

  const stage = String(d.stage ?? m.current_stage ?? '')
    .trim()
    .toLowerCase();
  if (!NO_ENGAGEMENT_STAGES.has(stage)) return false;

  const mem = (d.memory && typeof d.memory === 'object' ? d.memory : m) ?? {};
  return (
    Boolean(String(mem.customer_email ?? mem.email ?? '').trim()) &&
    !emailOptedOut(d) &&
    !emailInvalid(d)
  );
}

/** Re-exported so callers reading a turn's blocks do not need the Bedrock types directly. */
export type { BedrockContentBlock };
