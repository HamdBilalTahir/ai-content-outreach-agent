/**
 * The LLM-analysis toolkit the review tools share.
 *
 * Six functions, extracted from `tools/review_call_transcript.py`, which the source also imports from
 * `email_review`. Porting them as their own module makes the shared surface explicit and unblocks the
 * email review's four intent checks and the conversation summary, all of which were waiting on these.
 *
 * ## Every one of these fails toward the CONSERVATIVE answer
 *
 * These are LLM calls whose verdicts drive irreversible actions — opening a phone channel, booking a
 * meeting, marking a prospect not-interested. So each degrades to the answer that does the least:
 *  - `llmText` returns `''` on any error, so a caller sees "no verdict" rather than a wrong one.
 *  - `detectChannelPreferences` returns safe defaults, in which every flag is `false`.
 *  - `classifyCallOutcome` returns `no_commitment`, so a bad read NEVER auto-books a meeting.
 *
 * ## Two prompt rules worth reading before editing either prompt
 *
 * **Declining is not opting out.** "No thanks", "not interested", "I'll pass" are DECLINES, and the
 * channel-preference prompt states explicitly that they must leave both opt-out flags false, reflecting
 * disinterest through sentiment instead. Conflating the two would opt a prospect out of a channel they
 * never asked to leave, which is unrecoverable.
 *
 * **A referral outranks a follow-up email, and the distinction is about WHOSE address it is.** If the
 * target is gone or wrong and any contact detail for someone ELSE is given, that is a referral and the
 * address belongs in `referred_email` — never in `followup_email`, which is only ever for reaching the
 * same person. The source records why: a deterministic backstop once promoted the prospect's OWN address
 * to a referral whenever a loose regex matched, forking a duplicate chat and stranding a booked demo.
 * That backstop was removed, and classification is the LLM's job alone.
 */

import { db } from '../firebase/db';
import { generateText, textOf, type GenerateMeta } from '../llm/ask';
import { getActiveOutboundSkillsForStage } from '../services/skillsResolver';
import type { Skill } from '../firebase/skills';

export const MAX_TRANSCRIPT_CHARS = 15_000;

/**
 * One free-form LLM call, normalized to its text.
 *
 * Best-effort: `''` on any error, so every caller can treat "no text" as "no verdict" and fall back to
 * its own conservative default rather than propagating an exception into a review.
 */
export async function llmText(
  systemPrompt: string,
  userPrompt: string,
  metaData?: GenerateMeta | null
): Promise<string> {
  try {
    const messages = [
      { role: 'user' as const, content: [{ text: userPrompt }] },
    ];
    const result = await generateText(
      systemPrompt,
      messages,
      null,
      metaData ?? {}
    );
    return textOf(result);
  } catch (e) {
    console.warn(`[REVIEW] llmText failed: ${e}`);
    return '';
  }
}

/**
 * Parse an LLM response as JSON, tolerating markdown fences and surrounding prose.
 *
 * Three attempts, cheapest first: strip a fence and parse; parse as-is; then parse the widest
 * brace-delimited span. Models emit all three shapes, and a strict parser would discard usable output.
 */
export function parseJsonResponse(
  rawText: string | null | undefined
): Record<string, unknown> {
  if (!rawText) return {};
  let text = rawText.trim();

  if (text.startsWith('```')) {
    // Drop the opening fence line, then everything from the closing fence.
    const nl = text.indexOf('\n');
    text = nl === -1 ? text : text.slice(nl + 1);
    const close = text.lastIndexOf('```');
    if (close !== -1) text = text.slice(0, close);
    text = text.trim();
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the brace scan.
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Give up.
    }
  }
  return {};
}

/**
 * Resolve the chat's current stage and the skills active for it.
 *
 * DIVERGENCE, deliberate: the source resolves the stage from an `appraisals` subcollection before
 * falling back to the chat document, and loads skills through the INBOUND (unfiltered) resolver.
 * Neither applies to outbound. `appraisals` has no outbound equivalent — outbound contacts are
 * vehicle-less B2B prospects, which is why Phase 1 did not port that subsystem — so the appraisal branch
 * would be permanently inert; and an outbound review wants the skills active for an OUTBOUND chat, which
 * is what the outbound-filtered resolver returns. Reading stage and labels straight off the chat
 * document is the same value the source's fallback produces.
 */
export async function resolveStageAndSkills(
  chatId: string,
  agentId: string
): Promise<[string, Skill[]]> {
  const stage = 'New';
  try {
    if (!chatId) {
      return [stage, await getActiveOutboundSkillsForStage(agentId, stage, [])];
    }
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) {
      return [stage, await getActiveOutboundSkillsForStage(agentId, stage, [])];
    }
    const chatData = chatDoc.data() ?? {};
    const resolvedStage = String(chatData.stage ?? 'New') || 'New';
    const labels = (chatData.labels as string[]) ?? [];
    return [
      resolvedStage,
      await getActiveOutboundSkillsForStage(agentId, resolvedStage, labels),
    ];
  } catch (e) {
    console.warn(
      `[REVIEW] Failed to resolve stage/skills for chat=${chatId}: ${e}`
    );
    return [stage, []];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema-driven extraction
// ─────────────────────────────────────────────────────────────────────────────

/** A skill's `memory_schema` field definition. */
export interface SchemaField {
  type?: string;
  description?: string;
  enum?: unknown[];
}

function buildSchemaText(memorySchema: Record<string, SchemaField>): string {
  const lines: string[] = [];
  for (const [fieldName, rawDef] of Object.entries(memorySchema)) {
    const def = rawDef ?? {};
    let line = `- "${fieldName}" (${def.type ?? 'string'}): ${def.description ?? ''}`;
    if (def.enum?.length) {
      line += ` [allowed values: ${def.enum.map((v) => String(v)).join(', ')}]`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

interface EnumMismatch {
  key: string;
  value: unknown;
  allowed: unknown[];
}

/**
 * Validate extracted data against the schema, coercing types.
 *
 * Unknown keys are dropped: the model is told to return only schema keys, and silently accepting extras
 * would let it write arbitrary fields into chat memory. A value that fails its enum is NOT dropped
 * outright — it is collected so the caller can ask the model to correct it, which recovers a near-miss
 * rather than losing the field.
 */
function validateAndCoerce(
  extracted: Record<string, unknown>,
  memorySchema: Record<string, SchemaField>
): [Record<string, unknown>, EnumMismatch[]] {
  const validated: Record<string, unknown> = {};
  const mismatches: EnumMismatch[] = [];

  for (const [key, rawValue] of Object.entries(extracted ?? {})) {
    if (!(key in memorySchema)) continue;
    const def = memorySchema[key] ?? {};
    const expected = def.type ?? 'string';
    let value = rawValue;

    if (expected === 'boolean' && typeof value === 'string') {
      value = ['true', 'yes', '1'].includes(value.toLowerCase());
    } else if (expected === 'number' && typeof value === 'string') {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      value = Number.isInteger(n) ? n : n;
    }

    if (def.enum?.length && !def.enum.includes(value)) {
      mismatches.push({ key, value, allowed: def.enum });
      continue;
    }
    validated[key] = value;
  }
  return [validated, mismatches];
}

/**
 * Extract structured data from a transcript using a skill's memory schema.
 *
 * Up to three calls, and each retry addresses a DIFFERENT failure: a stricter-JSON retry when nothing
 * parsed at all, then an enum-correction retry naming each bad value and its allowed list. Retrying the
 * same prompt would just repeat the failure.
 *
 * A long transcript is truncated from the FRONT, keeping the most recent text — the end of a
 * conversation carries the commitments.
 */
export async function extractFromTranscriptWithSchema(
  transcript: string,
  memorySchema: Record<string, SchemaField>,
  skillInstructions = '',
  metaData?: GenerateMeta | null
): Promise<Record<string, unknown>> {
  if (!transcript || !memorySchema || Object.keys(memorySchema).length === 0) {
    return {};
  }

  const schemaText = buildSchemaText(memorySchema);
  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? '...[earlier messages truncated]...\n' +
        transcript.slice(-MAX_TRANSCRIPT_CHARS)
      : transcript;

  const systemPrompt =
    'You are analyzing a conversation transcript. Extract data matching the schema below.\n\n' +
    'Rules:\n' +
    '- Only return keys defined in the schema\n' +
    '- Use the types specified (string, number, boolean)\n' +
    '- If a field has allowed values, only use values from that list\n' +
    "- If data for a field is not found in the transcript, omit it entirely (don't guess)\n" +
    '- Return ONLY valid JSON, no explanation or markdown\n';

  let userPrompt = `Schema:\n${schemaText}\n\n`;
  if (skillInstructions) {
    userPrompt += `Agent instructions for context:\n${skillInstructions.slice(0, 1500)}\n\n`;
  }
  userPrompt += `Transcript:\n${truncated}\n\nExtract matching data as JSON:`;

  let extracted = parseJsonResponse(
    await llmText(systemPrompt, userPrompt, metaData)
  );

  if (Object.keys(extracted).length === 0) {
    const strictPrompt =
      userPrompt +
      '\n\nIMPORTANT: Output ONLY a JSON object starting with { and ending ' +
      'with }. No markdown, no prose, no explanation. Just the JSON.';
    extracted = parseJsonResponse(
      await llmText(systemPrompt, strictPrompt, metaData)
    );
  }

  if (Object.keys(extracted).length === 0) {
    console.warn('[SchemaReview] No usable data extracted after 2 attempts');
    return {};
  }

  const [validated, mismatches] = validateAndCoerce(extracted, memorySchema);

  if (mismatches.length) {
    const mismatchLines = mismatches.map(
      (m) =>
        `- Field "${m.key}": you returned "${String(m.value)}" but allowed values are ` +
        `${JSON.stringify(m.allowed)}. Pick the closest match from the allowed list, or omit if no good match.`
    );
    const enumRetryPrompt =
      `${userPrompt}\n\n` +
      "You returned values that don't match the allowed list for some fields. Fix them:\n" +
      mismatchLines.join('\n') +
      '\n\nReturn ONLY a JSON object with the corrected values. ' +
      'Keep all other valid fields from your previous answer.';
    const retried = parseJsonResponse(
      await llmText(systemPrompt, enumRetryPrompt, metaData)
    );
    if (Object.keys(retried).length) {
      const [retriedValidated] = validateAndCoerce(retried, memorySchema);
      Object.assign(validated, retriedValidated);
    }
  }

  console.log(
    `[SchemaReview] Extracted ${Object.keys(validated).length} fields: ${JSON.stringify(Object.keys(validated))}`
  );
  return validated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel-preference detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The referral signal. Every detail is explicitly nullable, because the classifier returns `null` for
 * anything it did not find rather than omitting the key. The index signature lets the transfer handler
 * accept this object directly — the two shapes are the same contract seen from either side.
 */
export interface ReferralSignal {
  is_referral: boolean;
  referred_first_name: string | null;
  referred_last_name: string | null;
  referred_email: string | null;
  referred_phone: string | null;
  referred_title: string | null;
  referrer_name: string | null;
  [k: string]: unknown;
}

export interface ChannelPreferences {
  sms_opt_in: boolean;
  sms_opt_out: boolean;
  phone_opt_in: boolean;
  phone_opt_out: boolean;
  customer_requested_call: boolean;
  customer_requested_sms: boolean;
  conversation_status: string;
  deferred_until: string | null;
  followup_email: string | null;
  customer_sentiment: string;
  ending_reason: string | null;
  quotes: Record<string, string>;
  referral: ReferralSignal;
  [k: string]: unknown;
}

/** The safe defaults. EVERY flag is false, so an unparseable verdict changes nothing. */
export function channelPrefSafeDefaults(): ChannelPreferences {
  return {
    sms_opt_in: false,
    sms_opt_out: false,
    phone_opt_in: false,
    phone_opt_out: false,
    customer_requested_call: false,
    customer_requested_sms: false,
    conversation_status: 'unknown',
    deferred_until: null,
    followup_email: null,
    last_customer_message_at: null,
    last_agent_message_at: null,
    minutes_since_last_customer_message: null,
    unanswered_agent_messages: 0,
    customer_sentiment: 'neutral',
    ending_reason: null,
    quotes: {},
    referral: {
      is_referral: false,
      referred_first_name: null,
      referred_last_name: null,
      referred_email: null,
      referred_phone: null,
      referred_title: null,
      referrer_name: null,
    },
  };
}

const CHANNEL_PREF_SYSTEM =
  'You are a conversation analysis agent that detects customer communication preferences and ' +
  'conversation health. You receive a transcript between an AGENT and a CUSTOMER and the channel ' +
  'type (phone_call or sms).\n\n' +
  "Analyze ONLY the CUSTOMER's messages to detect: SMS opt-in/opt-out, phone opt-in/opt-out, " +
  'channel switch requests, conversation status, and customer sentiment.\n\n' +
  'CRITICAL RULES:\n' +
  "- Only the CUSTOMER's explicit words count. The AGENT stating something does NOT count.\n" +
  '- If a topic was never discussed, the corresponding flag must be false.\n' +
  '- If intent is ambiguous, default to false (conservative).\n' +
  "- DECLINING THE OFFER IS NOT AN OPT-OUT. 'No thanks', 'Not interested', \"I'll pass\", 'No', " +
  "'Not selling', 'Maybe later' are declines, not opt-outs: keep sms_opt_out=false AND " +
  'phone_opt_out=false; reflect disinterest via customer_sentiment/ending_reason instead.\n' +
  "- An opt-out requires an EXPLICIT request to STOP CONTACT on that channel ('stop texting', " +
  "'unsubscribe', 'remove me' for SMS; 'stop calling', 'do not call me' for phone). 'please stop', " +
  "'stop bothering me' DO count. 'I'll stop by' does NOT.\n\n" +
  '- customer_requested_call: set true ONLY when the customer EXPLICITLY asks us to call (them or the ' +
  "target) back (e.g. 'call me tomorrow', 'try back this afternoon', 'reach the manager at 2'); set " +
  'deferred_until to that time in ISO 8601 when one is given. Do NOT set it merely because the agent ' +
  'proposed a time and it was accepted — whether an accepted time is a DEMO the prospect will attend or a ' +
  'CALLBACK for us to place is decided by a SEPARATE step, not here. When unsure, keep it false.\n\n' +
  '- FOLLOW-UP EMAIL: if you agreed to email them and an email address was given AND confirmed, set ' +
  'followup_email to that exact address (lowercased, normalized). Put it verbatim in ' +
  'quotes.followup_email. If no email was agreed, followup_email=null.\n\n' +
  '- REFERRAL TO A DIFFERENT PERSON (IMPORTANT — this takes PRECEDENCE over followup_email): set ' +
  'referral.is_referral=true whenever the person we asked for is the WRONG or DEPARTED contact AND the ' +
  'transcript points us to a DIFFERENT individual (name, email, phone, OR role) — even a partial detail is ' +
  "enough (e.g. 'she no longer works here, email our used-car manager at ewilliams@dealer.com', 'Randy left " +
  "— you want Jane in acquisitions', 'that's not me, try the GM'). Capture whatever is given for that NEW " +
  'person: referred_first_name, referred_last_name, referred_email (lowercased), referred_phone, ' +
  'referred_title (role), referrer_name (who pointed us there). DECISION RULE: if the target is gone/wrong ' +
  'AND ANY new contact detail (email/phone/name/role) for someone else is provided → is_referral=true and ' +
  'that email/phone belongs in referred_email/referred_phone, NOT in followup_email. followup_email is ONLY ' +
  'for reaching the SAME target we already have (a shared/department inbox for the same person). Never put a ' +
  "different person's contact detail in followup_email. If the same person stays the target, " +
  'referral.is_referral=false and all referral fields null.\n\n' +
  'You MUST respond with valid JSON only, no other text, in this exact format:\n' +
  '{\n' +
  '  "sms_opt_in": true/false,\n' +
  '  "sms_opt_out": true/false,\n' +
  '  "phone_opt_in": true/false,\n' +
  '  "phone_opt_out": true/false,\n' +
  '  "customer_requested_call": true/false,\n' +
  '  "customer_requested_sms": true/false,\n' +
  '  "conversation_status": "active" | "unresponsive" | "deferred" | "ended",\n' +
  '  "deferred_until": "ISO 8601 datetime or null",\n' +
  '  "followup_email": "email address (lowercased) or null",\n' +
  '  "customer_sentiment": "interested" | "hesitant" | "neutral" | "frustrated" | "not_interested",\n' +
  '  "ending_reason": "customer_said_not_interested" | "customer_stopped_responding" | ' +
  '"customer_asked_callback" | "conversation_completed" | null,\n' +
  '  "referral": {"is_referral": true/false, "referred_first_name": "str or null", "referred_last_name": ' +
  '"str or null", "referred_email": "lowercased email or null", "referred_phone": "str or null", ' +
  '"referred_title": "role or null", "referrer_name": "who referred us or null"},\n' +
  '  "quotes": {"signal_name": "exact customer quote"}\n' +
  '}';

/**
 * Analyze a transcript for channel-preference signals and conversation health.
 *
 * Merges the model's verdict onto the safe defaults, so a partial response yields conservative values
 * for everything it omitted rather than `undefined`.
 *
 * The source records that a deterministic referral BACKSTOP used to run here and was REMOVED: it
 * promoted the prospect's OWN captured address to a referral whenever a loose "departed/redirect/role"
 * regex matched anywhere, with no check that the address belonged to a different person. That forked a
 * duplicate email-keyed chat AND labelled the source chat transferred, stranding a booked demo.
 * Classification is the model's job alone, and the transfer trigger separately verifies the referred
 * contact differs from the prospect's own.
 */
export async function detectChannelPreferences(
  transcript: string,
  channelType: string,
  currentDatetime: string,
  metaData?: GenerateMeta | null
): Promise<ChannelPreferences> {
  const userMessage =
    `CHANNEL: ${channelType}\n` +
    `CURRENT DATETIME: ${currentDatetime}\n\n` +
    `TRANSCRIPT:\n${transcript}\n\n` +
    "Analyze the CUSTOMER's messages for channel preferences, opt-in/opt-out signals, " +
    'and conversation health. Return the JSON result.';

  const parsed = parseJsonResponse(
    await llmText(CHANNEL_PREF_SYSTEM, userMessage, metaData)
  );
  if (Object.keys(parsed).length === 0) {
    console.warn(
      '[CHANNEL_PREF] No usable channel-preference JSON — returning safe defaults'
    );
    return channelPrefSafeDefaults();
  }

  const merged = {
    ...channelPrefSafeDefaults(),
    ...parsed,
  } as ChannelPreferences;
  console.log(
    `[CHANNEL_PREF] Result: sms_opt_in=${merged.sms_opt_in}, sms_opt_out=${merged.sms_opt_out}, ` +
      `phone_opt_in=${merged.phone_opt_in}, phone_opt_out=${merged.phone_opt_out}, ` +
      `status=${merged.conversation_status}`
  );
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Call-outcome classification
// ─────────────────────────────────────────────────────────────────────────────

export const CALL_OUTCOME_VALUES = [
  'demo',
  'callback',
  'referral',
  'not_interested',
  'no_commitment',
] as const;

export type CallOutcome = (typeof CALL_OUTCOME_VALUES)[number];

const CALL_OUTCOME_SYSTEM =
  'You classify the PRIMARY outcome of a COMPLETED outbound sales call between our AGENT and the ' +
  'person on the line. Decide by PURPOSE, not by surface structure: the agent may propose a specific time ' +
  "in EITHER a demo OR a callback, so 'a time was offered and accepted' does NOT by itself decide it.\n\n" +
  'Return exactly ONE outcome:\n' +
  '- "demo": the PROSPECT (a decision-maker who can evaluate/buy) committed to ATTEND a product demo / ' +
  'walk-through at a specific day+time (THEY will join it). This is the only outcome that books a meeting.\n' +
  '- "callback": a time was set for US to CALL — because the target was UNAVAILABLE/BUSY, or a ' +
  'gatekeeper/assistant/other person was taking info and arranged a time to REACH the target, or the person ' +
  'explicitly asked us to call back. A callback is NOT a demo — we have not secured the decision-maker ' +
  'attending a demo.\n' +
  '- "referral": we were redirected to a DIFFERENT person/contact.\n' +
  '- "not_interested": the person declined / is not interested.\n' +
  '- "no_commitment": spoke but no firm demo, no callback time, no referral, no refusal.\n\n' +
  "STRONG 'demo' SIGNALS — when these are present it IS a demo (do NOT fall back to callback):\n" +
  "  • the agent offers to SHOW / DEMONSTRATE / walk through the product ('we'd love to show you exactly " +
  "how these AI agents work', 'a quick look', 'walk you through it', 'see it in action', 'a demo') and the " +
  'prospect AGREES and accepts one of the offered slots; and ESPECIALLY\n' +
  "  • the agent confirms with a CALENDAR INVITE / MEETING LINK / 'you're all set' ('calendar invite will " +
  "hit your inbox', 'I'll send the invite/link') — that is a tell-tale sign the accepted slot is the DEMO " +
  'itself, not a callback.\n' +
  'TIE-BREAK: only when NONE of those demo signals are present, the agent proposed a time that was accepted, ' +
  'and you are GENUINELY UNSURE whether the person is committing to ATTEND a demo vs arranging for us to ' +
  'reach someone → choose "callback" (conservative — never assume a booked demo on doubt).\n\n' +
  'agreed_time: for a demo OR a callback, the exact agreed date/time in ISO 8601 (resolve relative phrases ' +
  "like 'Thursday at ten' against CURRENT DATETIME); null for the other outcomes.\n\n" +
  'Respond with JSON only: {"outcome": one of the five strings, "agreed_time": "ISO 8601 or null", ' +
  '"quote": "the exact line that decided it"}.';

export interface CallOutcomeResult {
  outcome: CallOutcome;
  agreed_time: string | null;
  quote: string | null;
}

/**
 * The SINGLE, purpose-based decision of what a call produced.
 *
 * This is the one place that decides demo-versus-callback — the channel-preference detector explicitly
 * does NOT, so the two can never contradict each other. `demo` is the only outcome that books a meeting.
 *
 * Fails safe to `no_commitment` on any error, so a bad read never auto-books. The prompt's tie-break
 * pushes the same way: when genuinely unsure between attending a demo and arranging a callback, choose
 * callback.
 */
export async function classifyCallOutcome(
  transcript: string,
  currentDatetime: string,
  metaData?: GenerateMeta | null
): Promise<CallOutcomeResult> {
  try {
    const user =
      `CURRENT DATETIME: ${currentDatetime}\n\nTRANSCRIPT:\n` +
      `${(transcript ?? '').slice(-MAX_TRANSCRIPT_CHARS)}\n\n` +
      'Classify the primary outcome. Return the JSON.';
    const parsed = parseJsonResponse(
      await llmText(CALL_OUTCOME_SYSTEM, user, metaData)
    );

    const raw = String(parsed.outcome ?? '')
      .trim()
      .toLowerCase();
    const outcome: CallOutcome = (
      CALL_OUTCOME_VALUES as readonly string[]
    ).includes(raw)
      ? (raw as CallOutcome)
      : 'no_commitment';

    console.log(
      `[REVIEW][OUTCOME] outcome=${outcome} agreed_time=${JSON.stringify(parsed.agreed_time)}`
    );
    return {
      outcome,
      agreed_time: (parsed.agreed_time as string | null) ?? null,
      quote: (parsed.quote as string | null) ?? null,
    };
  } catch (e) {
    console.warn(
      `[REVIEW][OUTCOME] classification failed (${e}) — defaulting to no_commitment`
    );
    return { outcome: 'no_commitment', agreed_time: null, quote: null };
  }
}

/** Exposed for tests: the pure helpers. */
export const __testing = { buildSchemaText, validateAndCoerce };
