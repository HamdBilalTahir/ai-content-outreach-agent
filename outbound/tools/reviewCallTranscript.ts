/**
 * The `review_call_transcript` tool — the post-call orchestrator.
 *
 * Every voice call funnels through here exactly once, and almost every downstream decision about the
 * prospect is made in this one pass: what was said, who answered, whether a demo was agreed, whether
 * outreach moves to a different person, and whether the chat advances to Engaged.
 *
 * ## Four ways out before any analysis runs, and they are NOT interchangeable
 *
 *  1. **No `call_id`** — nothing to review. Plain failure.
 *  2. **The provider has no such conversation** — TERMINAL. Retrying cannot help, so the attempt is
 *     FINALIZED (`finalizeUnresolvedCall`): the dial guard's awaiting-review block clears, the
 *     in-progress card flips to failed, the voice slot is released, the watchdog is cancelled. This is
 *     what lets the 20-minute `check_if_call_succeeded` fallback self-heal a stale in-flight call
 *     instead of freezing the chat forever.
 *  3. **An empty transcript** — "still processing". NOT terminal, and deliberately not treated as a
 *     voicemail: concluding "nobody spoke" from a transcript that has not landed yet would discard a
 *     real conversation.
 *  4. **This `call_id` was already reviewed** — an idempotent no-op success. Belt-and-braces with the
 *     dispatch claim and the per-chat serialization. Without it, a re-fired review re-evaluates
 *     engagement and re-writes the stage; that is the Lost↔Engaged flapping seen in production.
 *
 * ## `classifyCallOutcome` is the SINGLE authority on demo-versus-callback
 *
 * Booking, the callback task, `_customer_wants_callback`, and the hot-prospect signal all derive from
 * that one call. The channel-preference detector still labels a demo-slot agreement in callback-flavoured
 * terms (`customer_requested_call`, `ending_reason=customer_asked_callback`, `conversation_status=deferred`),
 * so a demo explicitly OVERWRITES those signals before the result goes out. A booked demo must never
 * read as a callback anywhere downstream.
 *
 * A demo that cannot be slot-matched still schedules a booking task. It is never downgraded to a
 * callback — the booking turn resolves the exact time against live availability.
 *
 * ## Opt-out mirroring sets on opt-out and clears ONLY on an explicit opt-in
 *
 * Never on mere absence. A prior opt-out has to survive a later call that simply did not mention it.
 *
 * ## The referral fork has two hard guards
 *
 * A false positive forks a duplicate chat AND stops the source chat's outreach — it stranded a booked
 * demo once. So: **DEMO WINS** (a referral signal co-firing with a demo agreement is spurious), and
 * **DIFFERENT PERSON ONLY** (the referred email/phone must differ from the prospect's own — "email my
 * other address instead" is an email update, not a referral).
 *
 * ## Engagement trusts hard signals over the heuristic
 *
 * A booked slot or captured schema fields mean the call was engaged BY DEFINITION.
 * `hadMeaningfulEngagement` is only consulted when there is no hard signal, because it has misjudged
 * clearly-engaged demo-booking calls and defaults false on error.
 *
 * And when there is no engagement, "no engagement" is not the same as "voicemail". Blindly retrying
 * re-dialed a fully engaged demo-booking call; blindly not retrying misses a genuine voicemail that
 * slipped past the turn-count gate. So the ambiguity is resolved explicitly with the voicemail
 * classifier rather than guessed.
 *
 * ## Deferred
 *
 * The HubSpot slot matcher arrives with Phase 9; it is injected as `resolveBookingSlot` (see
 * `BookingSlotResolver`). With no resolver the demo takes the source's own unmatched path — byte-for-byte
 * what the source does when HubSpot is not configured. `maybeAddDealConversationNote`,
 * `preservePriorEmailOnContact`, and `syncHubspotStage` are also Phase 9; each was best-effort and
 * non-blocking in the source. The Vapi fetcher is not ported, matching `makePhoneCall`: no Vapi dialer
 * exists in this deployment, so no Vapi call can be under review.
 */

import { FieldValue, db } from '../firebase/db';
import { createTaskWithId, getMemory, setMemory } from '../firebase/chat';
import { getAgent } from '../firebase/agent';
import { setProspectStage } from '../firebase/prospect';
import { envStr } from '../config';
import {
  clearCadenceComplete,
  hasEmailFallback,
  markCallCompletedInActivities,
  markCallCompletedInMessages,
  resetFollowupCounts,
} from '../services/chat';
import { scanPriorInteractions } from '../services/callScope';
import { finalizeUnresolvedCall } from '../services/stalledRecovery';
import { deletePendingOutboundOutreach } from '../services/scheduling';
import { handleNotInterested } from '../services/notInterested';
import { handleReferralTransfer } from '../services/referralTransfer';
import { generateAndCacheSummary } from '../services/conversationSummary';
import { preservePriorEmailOnContact } from '../services/hubspot';
import {
  maybeAddDealConversationNote,
  syncHubspotStage,
} from '../services/hubspotDeals';
import { ELEVENLABS_BASE_API } from '../services/elevenlabs';
import {
  classifyCallOutcome,
  detectChannelPreferences,
  extractFromTranscriptWithSchema,
  resolveStageAndSkills,
} from './reviewHelpers';
import type { ChannelPreferences, SchemaField } from './reviewHelpers';
import {
  classifyAnswerer,
  hadMeaningfulEngagement,
  llmDetectVoicemail,
  markCallReviewed,
  scheduleCallback,
  scheduleFollowupEmail,
  scheduleRetryCall,
} from './reviewActions';
import { buildToolResult } from './makePhoneCall';
import type { GenerateMeta } from '../llm/ask';
import type { BedrockMessage, ChatMemory } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

export interface CallInfo {
  transcript: string;
  analysis: Record<string, unknown>;
  recording_url: string;
  call_status: string;
  summary?: string;
}

interface ElevenlabsTurn {
  role?: string | null;
  message?: string | null;
  [k: string]: unknown;
}

/**
 * Convert an ElevenLabs `transcript` array into a readable `AI:`/`HUMAN:` string.
 *
 * Tool turns (`message` is null) are skipped — the review only needs spoken dialogue. Each turn is ONE
 * line, which is what makes HUMAN turns countable for the voicemail gate.
 */
export function formatElevenlabsTranscript(
  transcriptArray: ElevenlabsTurn[] | null | undefined
): string {
  if (!transcriptArray || transcriptArray.length === 0) return '';
  const lines: string[] = [];
  for (const turn of transcriptArray) {
    if (!turn || typeof turn !== 'object') continue;
    const message = turn.message;
    if (message === null || message === undefined) continue;
    const roleRaw = String(turn.role ?? 'unknown').toLowerCase();
    const role = ['agent', 'assistant', 'ai'].includes(roleRaw)
      ? 'AI'
      : 'HUMAN';
    lines.push(`${role}: ${message}`);
  }
  return lines.join('\n');
}

/**
 * The transcript the post-call webhook already RECEIVED and stored at
 * `elevenlabs_conversations/{id}`.
 *
 * Preferred over a live re-fetch, which can race an empty turn-array and then get mis-scored as
 * voicemail.
 */
async function storedTranscript(
  conversationId: string
): Promise<CallInfo | null> {
  try {
    const doc = await db
      .collection('elevenlabs_conversations')
      .doc(conversationId)
      .get();
    if (!doc.exists) return null;
    const d = doc.data() ?? {};
    const tx = String(d.transcript ?? '').trim();
    if (!tx) return null;
    return {
      transcript: tx,
      analysis: { summary: String(d.summary ?? '') },
      recording_url: '',
      call_status: 'done',
    };
  } catch (e) {
    console.warn(
      `[REVIEW] stored-transcript lookup failed for ${conversationId}: ${e}`
    );
    return null;
  }
}

/**
 * Fetch call details for the review: the webhook-stored transcript first, else the live ElevenLabs API.
 *
 * NEVER substitutes the `transcript_summary` prose for the transcript. Prose has no `HUMAN:` lines, so it
 * would count as zero human turns and false-flag a real conversation as voicemail. An empty turn-array
 * yields `''`, which the caller treats as "not ready" rather than as a conclusion about who answered.
 */
export async function fetchCallFromElevenlabs(
  conversationId: string
): Promise<CallInfo | null> {
  const stored = await storedTranscript(conversationId);
  if (stored) {
    console.log(
      `[ELEVENLABS] using webhook-stored transcript for ${conversationId}`
    );
    return stored;
  }

  try {
    console.log(`[ELEVENLABS] Fetching conversation: ${conversationId}`);
    const resp = await fetch(
      `${ELEVENLABS_BASE_API}/v1/convai/conversations/${conversationId}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': envStr('ELEVENLABS_API_KEY'),
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    console.log(`[ELEVENLABS] Response status: ${resp.status}`);
    if (resp.status === 404) {
      console.error(
        `[ELEVENLABS] Conversation ${conversationId} not found (404)`
      );
      return null;
    }
    if (resp.status !== 200) {
      console.error(
        `[ELEVENLABS] API error: ${resp.status} - ${await resp.text()}`
      );
      return null;
    }
    const callInfo = (await resp.json()) as Record<string, unknown>;
    const analysis = (callInfo.analysis ?? {}) as Record<string, unknown>;
    const transcriptArray = callInfo.transcript as
      | ElevenlabsTurn[]
      | null
      | undefined;
    const callSuccessful = String(analysis.call_successful ?? 'unknown');
    return {
      transcript: formatElevenlabsTranscript(transcriptArray),
      analysis: {
        summary: String(analysis.transcript_summary ?? ''),
        successEvaluation: callSuccessful === 'success' ? 'true' : 'false',
        call_successful: callSuccessful,
      },
      recording_url: '',
      call_status: String(callInfo.status ?? 'unknown'),
    };
  } catch (e) {
    console.error(`[ELEVENLABS] Fetch failed for ${conversationId}: ${e}`);
    return null;
  }
}

/** What the Phase 9 HubSpot slot matcher returns. `resolved: false` means "no slot matched". */
export interface BookingSlotMatch {
  resolved: boolean;
  label: string | null;
  start_time_ms: number | null;
}

/**
 * The Phase 9 HubSpot slot matcher, injected.
 *
 * Called ONLY after `classifyCallOutcome` has already decided the call is a demo, so it is a pure slot
 * matcher — it must never re-judge demo-versus-callback. It stores `memory._agreed_slot` and schedules
 * the `book_meeting` task itself; the actual booking, Lead transition, link, and confirmation email all
 * happen later in that task's turn.
 */
export type BookingSlotResolver = (input: {
  chatId: string;
  agentId: string;
  transcript: string;
  memory: ChatMemory;
  metaData?: GenerateMeta | null;
  agreedTime?: string | null;
}) => Promise<BookingSlotMatch>;

export interface ReviewOptions {
  chatId?: string | null;
  metaData?: GenerateMeta | null;
  /** Omit to take the unmatched-demo path — identical to the source with HubSpot unconfigured. */
  resolveBookingSlot?: BookingSlotResolver;
  /** Seam for the tests; production uses the real ElevenLabs fetch. */
  fetchCall?: (callId: string) => Promise<CallInfo | null>;
}

/** Drop any prior unexecuted `book_meeting` task so a re-review cannot leave two competing bookings. */
async function dedupePendingBookMeeting(chatId: string): Promise<void> {
  try {
    const snap = await db
      .collection('chats')
      .doc(chatId)
      .collection('tasks')
      .where('type', '==', 'book_meeting')
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      await t.ref.delete();
    }
  } catch {
    // Best-effort, exactly as in the source: a failed dedup must not block the booking itself.
  }
}

/**
 * A demo was agreed but no HubSpot slot could be pre-matched (no availability, no config, or the exact
 * time was not in the list).
 *
 * Still schedules a `book_meeting` task — a demo is NOT downgraded to a callback — and lets the booking
 * turn resolve the exact time against live availability. Best-effort.
 */
export async function scheduleDemoBookingFallback(
  chatId: string,
  agentId: string,
  memory: ChatMemory | null | undefined,
  agreedTime?: string | null
): Promise<void> {
  if (!chatId) return;
  await dedupePendingBookMeeting(chatId);
  try {
    const when = agreedTime ? ` at ${agreedTime}` : '';
    const notes =
      `The customer agreed to a DEMO${when} on the call, but no exact availability slot was ` +
      'pre-matched. Call get_hubspot_available_slots, pick the slot closest to the agreed time ' +
      '(same day), then call schedule_hubspot_meeting FIRST. Only after it returns success (which ' +
      'sets the meeting link) send exactly one confirmation email including that link, as your ' +
      'last step. This is a confirmed demo — do NOT treat it as a callback.';
    await createTaskWithId(
      chatId,
      'book_meeting',
      new Date(Date.now() + 60 * 1000),
      {
        notes,
        agent_id: agentId,
        account_id: agentId,
        attendee_id: (memory ?? {}).phone_number,
        task_source: 'book_after_call_unmatched',
      }
    );
    console.log(
      `[REVIEW][BOOK] chat=${chatId}: demo agreed but slot unmatched → scheduled book_meeting fallback`
    );
  } catch (e) {
    console.warn(
      `[REVIEW][BOOK] demo booking fallback failed (non-blocking): ${e}`
    );
  }
}

/** A memory stamp. */
function stampIso(): string {
  return new Date().toISOString();
}

/** The `CURRENT DATETIME` the classifiers resolve relative times against — second precision, no zone. */
function llmDatetime(): string {
  return new Date().toISOString().slice(0, 19);
}

function digitsOnly(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Fetch the transcript and run the outbound review: schema-driven extraction (driven by the active
 * skill's `memory_schema`, at ANY stage) + channel-preference detection + conversation-summary caching.
 * Updates chat memory and returns a concise result to the calling agent.
 */
export async function parseAndRunReviewCallTranscript(
  toolUseId: string,
  input: Record<string, unknown>,
  options: ReviewOptions = {}
): Promise<BedrockMessage> {
  const { chatId = null, metaData = null, resolveBookingSlot } = options;
  const fetchCall = options.fetchCall ?? fetchCallFromElevenlabs;

  const callId = String(input.call_id ?? '').trim();
  const fieldsToCheck = input.fields_to_check ?? [];

  console.log('[REVIEW] ===== START review_call_transcript (outbound) =====');
  console.log(
    `[REVIEW] call_id=${callId}, fields_to_check(oversee)=${JSON.stringify(fieldsToCheck)}, chat_id=${chatId}`
  );

  let result: Record<string, unknown> = { status: 'failed' };

  if (!callId) {
    console.warn('[REVIEW] Missing call_id, returning early');
    result.message = 'call_id is required';
    return buildToolResult(toolUseId, result);
  }

  // The agent's configured voice provider. Resolved ONCE into a plain string — the source reads
  // `agent_id` again at step 8b, where it is undefined whenever no meta_data was passed; the resulting
  // NameError lands in the function-wide handler and silently skips booking, the callback, the stage
  // advance, AND the idempotency stamp after all the earlier side effects have already run. A resolved
  // const cannot express that.
  const agentId = String(metaData?.agent_id ?? '');
  let provider = 'elevenlabs';
  if (agentId) {
    const agentData = await getAgent(agentId);
    if (agentData) {
      provider = String(
        agentData.voice_ai_provider ?? 'elevenlabs'
      ).toLowerCase();
    }
  }

  console.log(`[REVIEW] Fetching transcript for ${callId} via ${provider}`);

  try {
    // 1. Fetch the transcript. Only the ElevenLabs path exists here; see the module note.
    if (provider !== 'elevenlabs') {
      result.message =
        `Voice provider '${provider}' is not available in this deployment ` +
        '(only the ElevenLabs path is implemented).';
      console.error(
        `[REVIEW] unsupported voice_ai_provider='${provider}' for agent=${agentId}`
      );
      // Deliberately NOT finalized: an unsupported provider is a deployment gap, not evidence that the
      // conversation is gone. Finalizing here would flip a live call's card to failed.
      return buildToolResult(toolUseId, result);
    }
    const callInfo = await fetchCall(callId);

    if (!callInfo) {
      console.warn(`[REVIEW] Call ${callId} not found in ${provider}`);
      result.message = `Call ${callId} not found in ${provider}`;
      // TERMINAL — see the module note. Retrying cannot help, so finalize the attempt rather than
      // leaving the chat frozen.
      if (chatId) {
        try {
          await finalizeUnresolvedCall(chatId, {
            callId,
            reason: 'transcript-not-found',
          });
        } catch (finErr) {
          console.warn(
            `[REVIEW] finalizeUnresolvedCall failed for ${chatId}: ${finErr}`
          );
        }
      }
      return buildToolResult(toolUseId, result);
    }

    const transcript = callInfo.transcript ?? '';
    console.log(
      `[REVIEW] Transcript fetched, length=${transcript.length} chars`
    );
    if (!transcript) {
      result.message =
        'Transcript not available yet. The call may still be processing.';
      return buildToolResult(toolUseId, result);
    }

    // Backstop: flip this call's make_phone_call card in_progress → completed. The post-call webhook
    // normally does it, but when it never matches (e.g. we dialed a number that differs from the chat
    // key) the check_if_call_succeeded fallback routes here instead — so mirror the flip, or the
    // Activities card and the LLM context stay stuck at in_progress.
    if (chatId && callId) {
      try {
        const flipSummary = callInfo.summary || transcript.slice(0, 500);
        await markCallCompletedInActivities(
          chatId,
          callId,
          flipSummary,
          'completed'
        );
        await markCallCompletedInMessages(
          chatId,
          callId,
          flipSummary,
          'completed'
        );
      } catch (flipErr) {
        console.warn(
          `[REVIEW] make_phone_call card flip failed for ${callId}: ${flipErr}`
        );
      }
    }

    // 2. Read memory.
    const currentMemory: ChatMemory = chatId
      ? ((await getMemory(chatId)) ?? {})
      : {};

    // 2b. Call-id idempotency. See the module note — this is what stopped the Lost↔Engaged flapping.
    // (The card flip above already ran and is itself idempotent.)
    const reviewedIds = (currentMemory._reviewed_call_ids ?? []) as string[];
    if (chatId && Array.isArray(reviewedIds) && reviewedIds.includes(callId)) {
      console.log(
        `[REVIEW] call_id ${callId} already reviewed for chat=${chatId} — skipping side effects (idempotent no-op).`
      );
      return buildToolResult(toolUseId, {
        status: 'success',
        call_id: callId,
        already_reviewed: true,
        message: 'This call was already reviewed; no changes re-applied.',
      });
    }

    // 3. Engagement gate — did a live HUMAN pick up? The answerer classifier is authoritative, NOT the
    // turn count: an auto-attendant repeats its menu across many turns, so a count cannot tell an IVR
    // from a live call.
    const answerer = await classifyAnswerer(transcript, metaData);
    if (answerer !== 'human') {
      const isIvr = answerer === 'ivr';
      console.log(
        `[REVIEW] No live human (${answerer}) for ${callId} — skipping field analysis`
      );
      // Stamp the last UNANSWERED-call time. The "couldn't reach you" email is gated on this being
      // fresh (≤24h), so a deferred no-answer email can never accumulate detached from a recent call.
      // The lane stays "phone" and the call cadence keeps dialing to the cap — no lane flip here.
      if (chatId) {
        try {
          await setMemory(chatId, { _last_call_unanswered_at: stampIso() });
        } catch (stampErr) {
          console.warn(
            `[REVIEW] _last_call_unanswered_at stamp failed for ${chatId}: ${stampErr}`
          );
        }
      }
      // Deterministic auto-retry is OFF (MAX_VOICE_RETRIES = 0): the skill owns the
      // 2nd-call-then-email cadence. This no-ops unless the constant is bumped back on.
      const retry = await scheduleRetryCall(
        chatId ?? '',
        agentId,
        currentMemory
      );
      // Voice attempts so far = make_phone_call tool uses on this chat (the current call is already
      // persisted by the time this follow-up turn runs). Lets the skill tell a 1st voicemail (schedule
      // a 2nd call) from a 2nd (switch to the couldn't-reach-you email).
      let voiceAttempts: number | null = null;
      try {
        voiceAttempts = (await scanPriorInteractions(chatId)).calls;
      } catch {
        voiceAttempts = null;
      }
      // Cache a short no-answer summary ONLY if none exists yet — never clobber a prior
      // real-conversation summary. Live declines are is_voicemail=false and fall through to the normal
      // LLM summary below, which already reads "declined / not available".
      if (chatId && !currentMemory._conversation_summary) {
        try {
          await setMemory(chatId, {
            _conversation_summary:
              'No live person reached on the call ' +
              `(${isIvr ? 'auto-attendant / IVR menu' : 'voicemail / no pickup'}) — ` +
              `attempt ${voiceAttempts || 1}. No conversation yet.`,
            _conversation_summary_at: stampIso(),
          });
        } catch (sumErr) {
          console.warn(
            `[REVIEW] no-answer summary cache failed for ${chatId}: ${sumErr}`
          );
        }
      }
      result = {
        status: 'success',
        call_id: callId,
        confirmed_in_this_call: {},
        previously_confirmed: {},
        still_missing: [],
        all_confirmed: false,
        summary:
          'No live human was reached during the call ' +
          `(${isIvr ? 'reached an auto-attendant / IVR menu' : 'voicemail or no answer'}). ` +
          'No new fields were confirmed.',
        customer_wants_callback: false,
        callback_time: null,
        human_reached: false,
        is_voicemail: answerer === 'voicemail',
        is_ivr: isIvr,
        voice_attempts: voiceAttempts,
        follow_up_scheduled: retry ? 'retry_call' : null,
      };
      // This call IS reviewed on the no-human path too → idempotent guard + clears the dial guard.
      await markCallReviewed(chatId ?? '', callId);
      return buildToolResult(toolUseId, result);
    }

    // 4. Resolve stage + active skills (outbound extracts schema at ANY stage).
    const [reviewStage, activeSkills] = await resolveStageAndSkills(
      chatId ?? '',
      agentId
    );
    console.log(
      `[REVIEW] Stage=${reviewStage}, active_skills=${activeSkills.length}`
    );

    const memoryChanges: string[] = [];
    let schemaExtracted: Record<string, unknown> = {};

    // 5. Schema-driven extraction from the active skill(s)' memory_schema.
    if (activeSkills.length > 0) {
      const mergedSchema: Record<string, SchemaField> = {};
      let skillsText = '';
      for (const skill of activeSkills) {
        const skillSchema = skill.memory_schema;
        if (skillSchema && typeof skillSchema === 'object') {
          Object.assign(mergedSchema, skillSchema);
        }
        const skillInstr = skill.instructions;
        if (skillInstr) skillsText += `${skillInstr}\n\n`;
      }

      if (Object.keys(mergedSchema).length > 0) {
        try {
          schemaExtracted = await extractFromTranscriptWithSchema(
            transcript,
            mergedSchema,
            skillsText,
            metaData
          );
          console.log(
            `[REVIEW] Schema extraction returned ${Object.keys(schemaExtracted).length} fields: ` +
              `${JSON.stringify(Object.keys(schemaExtracted))}`
          );
        } catch (e) {
          console.warn(
            `[REVIEW] Schema extraction failed (non-blocking): ${e}`
          );
        }
      } else {
        console.log(
          '[REVIEW] No memory_schema on active skills — skipping schema extraction'
        );
      }
    } else {
      console.log(
        `[REVIEW] No active skills at stage=${reviewStage} — skipping schema extraction`
      );
    }

    // 6. Persist the schema-extracted fields. `customer_email` is APPEND-ONLY and handled separately.
    if (Object.keys(schemaExtracted).length > 0 && chatId) {
      try {
        const schemaUpdates: Record<string, unknown> = {};
        for (const [fieldName, newValue] of Object.entries(schemaExtracted)) {
          if (fieldName === 'customer_email') continue;
          const oldValue =
            (currentMemory as Record<string, unknown>)[fieldName] ?? '';
          schemaUpdates[`memory.${fieldName}`] = newValue;
          memoryChanges.push(
            `${fieldName}: '${oldValue}' -> '${newValue}' (schema extraction)`
          );
        }
        if (Object.keys(schemaUpdates).length > 0) {
          schemaUpdates.updatedAt = FieldValue.serverTimestamp();
          await db.collection('chats').doc(chatId).update(schemaUpdates);
          console.log(
            `[REVIEW] Saved ${Object.keys(schemaUpdates).length - 1} schema-extracted fields to memory`
          );
        }
        const newEmail = String(schemaExtracted.customer_email ?? '').trim();
        if (newEmail) {
          // Append-only: prior addresses stay in _email_history, the newest becomes active. Re-read
          // memory because step 5 may have taken a while.
          const m = (await getMemory(chatId)) ?? {};
          const hist = [...((m._email_history ?? []) as string[])];
          const active = m.customer_email;
          if (active && !hist.includes(active)) hist.push(active);
          if (newEmail !== active) {
            await setMemory(chatId, {
              customer_email: newEmail,
              _email_history: hist,
            });
            // The SAME prospect switching to a different address (not a referral — the transfer guard
            // below verifies that): keep the OLD address on the HubSpot contact by adding the new one
            // as a secondary. Never overwrite or delete the prior address.
            if (m.hubspot_contact_id) {
              try {
                await preservePriorEmailOnContact(chatId, agentId, null, newEmail);
              } catch (e) {
                console.warn(
                  `[REVIEW] HubSpot secondary-email add failed chat=${chatId}: ${e}`
                );
              }
            }
          }
          memoryChanges.push(
            `customer_email recorded: '${newEmail}' (newest active, history kept)`
          );
        }
      } catch (e) {
        console.error(`[REVIEW] Failed to save schema-extracted fields: ${e}`);
      }
    }

    // 7. Channel-preference detection (drives the turn engine's SMS/phone tool re-injection).
    console.log('[REVIEW] Running channel preference detection');
    const channelPref: ChannelPreferences = await detectChannelPreferences(
      transcript,
      'phone_call',
      llmDatetime(),
      metaData
    );

    // The SINGLE authority for the call's primary outcome. See the module note.
    const outcome = await classifyCallOutcome(
      transcript,
      llmDatetime(),
      metaData
    );
    const isDemo = outcome.outcome === 'demo';
    const isCallback = outcome.outcome === 'callback';
    const agreedTime = outcome.agreed_time;

    // Set true only if this call forks to a referral — that path skips the followup_email below.
    let referralHandled = false;
    if (chatId) {
      // Persist review signals so LATER follow-up turns (which never see this tool result) can reason
      // about callback intent, opt-outs, and recency. Always written. Callback intent comes from the
      // outcome classifier, NOT channel_pref — a demo agreement must never persist as a callback, and
      // clearing the flag is what stops makePhoneCall's hot-prospect check from re-dialing a booked demo.
      const prefUpdates: Record<string, unknown> = {
        'memory._last_channel': 'voice',
        'memory._last_touch_at': stampIso(),
        'memory.phone_opt_out': channelPref.phone_opt_out ? 'Y' : 'N',
        'memory._customer_wants_callback': isCallback,
        'memory._callback_time': isCallback ? agreedTime : null,
      };
      if (channelPref.sms_opt_in && currentMemory.sms_opt_out === 'Y') {
        prefUpdates['memory.sms_opt_out'] = 'N';
        memoryChanges.push(
          "sms_opt_out changed from 'Y' to 'N' (customer agreed to receive texts during call)"
        );
      }
      if (channelPref.sms_opt_out && currentMemory.sms_opt_out !== 'Y') {
        prefUpdates['memory.sms_opt_out'] = 'Y';
        memoryChanges.push(
          "sms_opt_out changed to 'Y' (customer asked to stop texts during call)"
        );
      }
      if (channelPref.phone_opt_in && currentMemory.block_phone === 'Y') {
        prefUpdates['memory.block_phone'] = 'N';
        memoryChanges.push(
          "block_phone changed from 'Y' to 'N' (customer agreed to receive calls)"
        );
      }
      if (channelPref.phone_opt_out && currentMemory.block_phone !== 'Y') {
        prefUpdates['memory.block_phone'] = 'Y';
        memoryChanges.push(
          "block_phone changed to 'Y' (customer asked to stop calls)"
        );
      }
      // The deterministic gate source: mirror detected opt-outs to the chat-doc TOP-LEVEL keys. Set on
      // opt-out; clear ONLY on an explicit opt-in — never on mere absence, so a prior opt-out survives
      // a later call that simply did not mention it.
      if (channelPref.phone_opt_out) {
        prefUpdates.phone_opt_out = true;
      } else if (channelPref.phone_opt_in) {
        prefUpdates.phone_opt_out = false;
      }
      if (channelPref.sms_opt_out) {
        prefUpdates.sms_opt_out = true;
      } else if (channelPref.sms_opt_in) {
        prefUpdates.sms_opt_out = false;
      }
      try {
        prefUpdates.updatedAt = FieldValue.serverTimestamp();
        await db.collection('chats').doc(chatId).update(prefUpdates);
        console.log(
          `[REVIEW] Channel preference memory updates: ${JSON.stringify(Object.keys(prefUpdates))}`
        );
      } catch (e) {
        console.error(
          `[REVIEW] Failed to update channel preferences for chat ${chatId}: ${e}`
        );
        memoryChanges.push(`Error updating channel preferences: ${e}`);
      }

      // Not-interested: the customer declined the DEAL, which is distinct from an opt-out. Labels the
      // chat and stops PROACTIVE outreach — it does not change the stage or set any opt-out flag.
      if (
        channelPref.customer_sentiment === 'not_interested' ||
        channelPref.ending_reason === 'customer_said_not_interested'
      ) {
        try {
          await handleNotInterested(
            chatId,
            'customer_said_not_interested',
            'review_call'
          );
          memoryChanges.push(
            'not_interested label added + proactive outreach stopped (customer declined)'
          );
        } catch (e) {
          console.error(
            `[REVIEW] not_interested handling failed for chat ${chatId}: ${e}`
          );
        }
      }

      // Referral to a DIFFERENT person (wrong or departed contact → someone else at the same company):
      // move outreach to a NEW warm chat in the same campaign and label/stop this source chat. Both
      // guards are load-bearing — see the module note.
      const ref =
        channelPref.referral && typeof channelPref.referral === 'object'
          ? channelPref.referral
          : null;
      const refEmail = String(ref?.referred_email ?? '')
        .trim()
        .toLowerCase();
      const refPhone = digitsOnly(ref?.referred_phone);
      const ownEmails = new Set(
        [
          currentMemory.customer_email,
          schemaExtracted.customer_email,
          channelPref.followup_email,
        ]
          .map((e) =>
            String(e ?? '')
              .trim()
              .toLowerCase()
          )
          .filter((e) => e.length > 0)
      );
      const ownPhones = new Set(
        [currentMemory.phone_number, schemaExtracted.phone_number]
          .map(digitsOnly)
          .filter((p) => p.length > 0)
      );
      const referredIsDifferentPerson =
        (!!refEmail && !ownEmails.has(refEmail)) ||
        (!!refPhone && !ownPhones.has(refPhone));
      if (ref?.is_referral && !isDemo && referredIsDifferentPerson) {
        try {
          const rr = await handleReferralTransfer(
            chatId,
            ref,
            ref.referrer_name,
            'review_call'
          );
          if (rr.ok) {
            referralHandled = true;
            memoryChanges.push(
              `referral transfer → new chat ${rr.new_chat_id} (source labelled ` +
                'referral_transferred + outreach stopped)'
            );
          }
        } catch (e) {
          console.error(
            `[REVIEW] referral transfer failed for chat ${chatId}: ${e}`
          );
        }
      } else if (ref?.is_referral) {
        // Flagged a referral but a guard suppressed it — record WHY.
        const why = isDemo
          ? 'demo booked on this chat'
          : "referred contact is the prospect's own (same person)";
        console.log(
          `[REVIEW] referral SUPPRESSED for chat ${chatId} (${why}); ` +
            `ref_email=${refEmail || '-'} ref_phone=${refPhone || '-'} ` +
            `own_emails=${JSON.stringify([...ownEmails].sort()) || '-'}`
        );
        memoryChanges.push(
          `referral signal ignored (${why}) — no transfer, stays on this chat`
        );
      }
    }

    // 8. Cache the conversation summary for cross-channel context.
    //
    // The source also falls back to the recent stored transcript when the formatted one is empty — but
    // an empty transcript already returned at step 1, so that branch is unreachable. Not ported rather
    // than ported dead.
    if (chatId && transcript) {
      try {
        const summaryPrefs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(channelPref)) {
          if (typeof v === 'string' || typeof v === 'boolean') {
            summaryPrefs[k] = v;
          }
        }
        await generateAndCacheSummary(
          chatId,
          transcript,
          schemaExtracted,
          summaryPrefs,
          'voice_call',
          metaData
        );
      } catch (e) {
        console.warn(`[REVIEW] Summary caching failed (non-blocking): ${e}`);
      }
    }

    // 8b. The source retries the rep-facing deal Note here, now the summary is cached (idempotent,
    // best-effort): the summary is now cached, so a deal whose booking-time attempt produced no brief
    // gets one. Idempotent — it no-ops when the note already exists.
    if (chatId && agentId) {
      try {
        await maybeAddDealConversationNote(chatId, agentId);
      } catch (e) {
        console.warn(`[REVIEW] deal note retry failed (non-blocking): ${e}`);
      }
    }

    // The turn engine reads these for dynamic SMS/phone tool re-injection.
    const smsOptInDetected = channelPref.sms_opt_in;

    const channelPreferences: Record<string, unknown> = {
      sms_opt_in: channelPref.sms_opt_in,
      sms_opt_out: channelPref.sms_opt_out,
      phone_opt_in: channelPref.phone_opt_in,
      phone_opt_out: channelPref.phone_opt_out,
      customer_requested_call: channelPref.customer_requested_call,
      customer_requested_sms: channelPref.customer_requested_sms,
    };
    const conversationContext: Record<string, unknown> = {
      conversation_status: channelPref.conversation_status,
      deferred_until: channelPref.deferred_until,
      customer_sentiment: channelPref.customer_sentiment,
      ending_reason: channelPref.ending_reason,
    };

    // HARMONIZE on a DEMO: classifyCallOutcome is the single authority, but detectChannelPreferences
    // still labels a demo-slot agreement in callback-flavoured terms. A booked demo must NEVER read as
    // a callback, so overwrite those signals — the output and any downstream channel-pref use stay
    // consistent with "demo scheduled", not "callback requested".
    if (isDemo) {
      channelPreferences.customer_requested_call = false;
      conversationContext.conversation_status = 'scheduled';
      conversationContext.ending_reason = 'demo_scheduled';
      conversationContext.deferred_until = null;
    }

    // Callback intent comes from the outcome classifier, never channel_pref. A demo is never a callback.
    const wantsCallback = isCallback;
    const callbackTime = isCallback ? agreedTime : null;

    result = {
      status: 'success',
      call_id: callId,
      confirmed_in_this_call: schemaExtracted,
      confirmed_fields: Object.keys(schemaExtracted).sort(),
      previously_confirmed: {},
      still_missing: [],
      all_confirmed: true, // outbound has no hardcoded required-field gate
      summary: '',
      customer_wants_callback: wantsCallback,
      callback_time: callbackTime,
      agreed_slot: null,
      human_reached: true,
      // Past the voicemail gate → this is a live call. `detectVoicemail` is the SOLE authority for
      // is_voicemail; the engagement branch below must never flip it back to true.
      is_voicemail: false,
      low_engagement: false,
      memory_changes: memoryChanges,
      sms_opt_in_detected: smsOptInDetected,
      channel_preferences: channelPreferences,
      conversation_context: conversationContext,
      quotes: channelPref.quotes,
    };

    // 8.5 Outcome-driven booking versus callback — ONE decision, no contradiction. DEMO → match the
    // agreed time to a slot and schedule a `book_meeting` task (the booking, link, Lead, Deal, and the
    // ONE confirmation email all happen in that task's turn). CALLBACK → schedule a callback; never
    // books, never Leads.
    let resolved = false;
    if (isDemo && chatId && transcript) {
      if (resolveBookingSlot) {
        const book = await resolveBookingSlot({
          chatId,
          agentId,
          transcript,
          memory: (await getMemory(chatId)) ?? currentMemory,
          metaData,
          agreedTime,
        });
        resolved = !!book.resolved;
        if (resolved) result.agreed_slot = book.label;
      }
      if (!resolved) {
        // Demo agreed but no slot matched — still book it, never fall to a callback. The booking turn
        // resolves the exact time against live availability.
        await scheduleDemoBookingFallback(
          chatId,
          agentId,
          currentMemory,
          agreedTime
        );
      }
      result.booking_task_created = true;
      // ENFORCE ORDER (book → then email): the booking is a SCHEDULED task, so the meeting is NOT
      // booked yet in THIS turn. Tell the review-turn brain explicitly so it does not try to send a
      // confirmation email now — which the send_email meeting_booked guard would block anyway. This
      // stops the wasted attempt and the warning it logs.
      result.confirmation_email = 'handled_by_book_meeting_task';
      result.do_not_email_now = true;
      result.next_step_note =
        'A book_meeting task is scheduled — it books the meeting via schedule_hubspot_meeting and ' +
        "THEN sends the single confirmation email (with the link) in that task's turn. Do NOT send " +
        'any confirmation email in THIS turn; the meeting is not booked yet.';
      // A demo is booked → any pending proactive outreach (a Day-0 call the skill pre-scheduled, or a
      // stale duplicate left by a human-@ai-override call) is now redundant. Clear it so a booked
      // prospect is not cold-called again by a leftover scheduled task.
      try {
        await deletePendingOutboundOutreach(chatId);
      } catch (dpErr) {
        console.warn(
          `[REVIEW][BOOK] pending-outreach purge skipped chat=${chatId}: ${dpErr}`
        );
      }
      console.log(
        `[REVIEW][BOOK] chat=${chatId}: outcome=demo → book_meeting scheduled ` +
          `(slot_matched=${resolved}, agreed_time=${JSON.stringify(agreedTime)})`
      );
    }

    // 8.6 Voice follow-up: a callback ONLY when the outcome was a callback, never on a demo.
    if (chatId && isCallback) {
      if (
        await scheduleCallback(chatId, agentId, currentMemory, callbackTime)
      ) {
        result.follow_up_scheduled = 'callback';
      }
      console.log(
        `[REVIEW][BOOK] chat=${chatId}: outcome=callback → callback scheduled ` +
          `(no booking/Lead), time=${JSON.stringify(callbackTime)}`
      );
    }

    // 8.7 Follow-up email: an address was agreed or confirmed on the call (e.g. a gatekeeper said
    // "email us at ...") → schedule a follow-up email task. Independent of the callback above — a
    // gatekeeper can give BOTH a callback time and an email.
    //
    // Phone-lane chats are CALL-ONLY: never schedule a proactive follow-up email for them. The phone
    // lane reaches people by phone; email volume is reserved for the email lane. Belt-and-braces with
    // the turn engine's email-tool strip.
    const phoneLane = String(currentMemory._outreach_lane ?? '') === 'phone';
    const followupEmail = channelPref.followup_email;
    if (chatId && followupEmail && !referralHandled && !phoneLane) {
      if (
        await scheduleFollowupEmail(
          chatId,
          agentId,
          currentMemory,
          followupEmail
        )
      ) {
        if (result.follow_up_scheduled === undefined) {
          result.follow_up_scheduled = 'followup_email';
        }
        result.followup_email = followupEmail;
      }
    }

    // 9. Engagement: advance to Engaged ONLY on a genuine two-way conversation. A call that got past
    // the voicemail gate but had no real engagement (a person who only said "can't talk / call me
    // back", or a voicemail mis-transcribed as human) must NOT advance — it stays Contacted and the
    // skill runs its next-attempt cadence. Lead happens later, in the booking-task turn.
    //
    // A call that produced a booking or captured schema fields is engaged BY DEFINITION — trust those
    // hard signals over the LLM heuristic, which has misjudged clearly-engaged demo-booking calls and
    // defaults false on error. Only fall back to the heuristic when there is no signal.
    const hasEngagementSignal =
      resolved || Object.keys(schemaExtracted).length > 0;
    const engaged =
      hasEngagementSignal ||
      (transcript
        ? await hadMeaningfulEngagement(transcript, metaData)
        : false);
    if (chatId && engaged) {
      try {
        const dealersId = String(
          currentMemory.dealers_id || currentMemory.dealer_id || ''
        );
        const companyId = String(metaData?.company_id ?? '');
        await setProspectStage(
          chatId,
          'Engaged',
          'human_reached_call',
          dealersId,
          companyId
        );
        // A live human reached → fresh cadence: zero the follow-up counters and reopen the cadence.
        try {
          await resetFollowupCounts(chatId);
          await clearCadenceComplete(chatId);
          // TEST phone-first: a POSITIVE phone engagement FOCUSES the phone lane — clear the email
          // fallback so an engaged prospect is never cold-emailed (a transactional or reminder email is
          // still allowed; the lane stays "phone"). Real records never carry the flag, so this no-ops.
          if (hasEmailFallback(currentMemory)) {
            await setMemory(chatId, { _email_fallback_available: false });
            await db
              .collection('chats')
              .doc(chatId)
              .set({ email_fallback_available: false }, { merge: true });
            console.log(
              `[REVIEW] test phone-first chat ${chatId}: positive phone engagement → email fallback cleared (phone focus)`
            );
          }
        } catch {
          // Non-blocking: the stage advance is what matters.
        }
        // Comms analytics are dealer-scoped and the source only writes them when a dealers_id exists;
        // outbound prospects have none, so there is nothing to write here.
        try {
          await syncHubspotStage(chatId, agentId);
        } catch {
          // Best-effort CRM mirroring.
        }
      } catch (e) {
        console.error(`[ProspectAnalytics] Failed to set Engaged stage: ${e}`);
      }
    } else if (chatId) {
      // No engagement signal — but "no engagement" is NOT "voicemail", and we must not guess. See the
      // module note: disambiguate explicitly. Skipped when a callback was already scheduled — that IS
      // the touch.
      result.human_reached = false;
      if (result.follow_up_scheduled !== 'callback') {
        if (transcript && (await llmDetectVoicemail(transcript, metaData))) {
          result.is_voicemail = true; // genuine voicemail past the turn-count gate → retry cadence
        } else {
          result.low_engagement = true; // live person, low engagement → no rapid re-dial
        }
        try {
          result.voice_attempts = (await scanPriorInteractions(chatId)).calls;
        } catch {
          result.voice_attempts = null;
        }
      }
      console.log(
        `[REVIEW] Live call but low engagement for ${callId} — staying Contacted, ` +
          `NOT voicemail (callback=${result.follow_up_scheduled === 'callback'})`
      );
    }

    // Full review complete → idempotent guard + clears the dial guard.
    await markCallReviewed(chatId ?? '', callId);
    console.log(
      `[REVIEW] Analysis complete for ${callId}: memory_changes=${JSON.stringify(memoryChanges)}`
    );
    console.log('[REVIEW] ===== END review_call_transcript (success) =====');
  } catch (e) {
    result.message = `Error reviewing transcript: ${e}`;
    console.error(
      `[REVIEW] ===== END review_call_transcript (error): ${e} =====`
    );
  }

  return buildToolResult(toolUseId, result);
}
