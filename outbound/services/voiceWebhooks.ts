/**
 * The two ElevenLabs voice webhooks: POST-CALL (a call finished) and CONVERSATION-INIT (a call is
 * about to connect and needs context).
 *
 * These are the framework-free handlers. The HTTP routes that call them arrive with the Phase 10
 * surface; nothing here knows about a request object beyond the two plain inputs it is handed.
 *
 * ## The two webhooks have OPPOSITE signature policies, and that is deliberate
 *
 *  - **Post-call** VERIFIES. A secret configured means a valid signature is required, because this
 *    handler mutates: it flips call cards, schedules a review turn, and releases a concurrency slot.
 *    No secret configured means process-with-a-warning, so a fresh deployment is not silently deaf.
 *  - **Conversation-init** NEVER BLOCKS. It only reads and returns context, and the provider signs it
 *    with a DIFFERENT secret than the post-call one — so hard-failing returned an empty payload and the
 *    agent answered with its generic opener, losing all caller context and bookable slots. That was a
 *    real production bug. The check runs, logs, and proceeds either way.
 *
 * ## Resolving a conversation to a chat has three tiers, ordered by durability
 *
 *  1. **`pending_calls`** — the fast path, and usually already GONE by webhook time: the place-call
 *     turn deletes it.
 *  2. **`outbound_call_index`** — written at placement, `conversation_id → chat_id`, and survives the
 *     pending cleanup. This is the ONLY reliable resolver when the dialed number differs from the chat
 *     key (an admin "@ai call this other number").
 *  3. **agent + customer number** — reconstruct the deterministic `outbound__` id and confirm the chat
 *     EXISTS. Never derived from the phone alone, and it never mints a chat: an unmatched webhook is a
 *     no-op, not a new conversation.
 *
 * ## Every response is a 200
 *
 * A webhook that returns an error status gets retried by the provider, and none of these failures are
 * retryable — an unmatched conversation stays unmatched. So failures are reported in the BODY and the
 * status is always 200. The `matched` flag is what tells the caller whether anything happened.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { db } from '../firebase/db';
import {
  createTaskWithId,
  deleteUnexecutedTasksByType,
  getMemory,
  getPendingCall,
  setMemory,
} from '../firebase/chat';
import { setProspectStage } from '../firebase/prospect';
import {
  addMessagesV3AndActivities,
  updateMessagesV3ForPhoneCall,
} from '../firebase/outboundChatMessages';
import { envStr } from '../config';
import {
  buildDeterministicChatId,
  clearCadenceComplete,
  getOutboundCallIndex,
  deleteOutboundCallIndex,
  getOrCreateOutboundChat,
  isOutboundChat,
  markCallCompletedInActivities,
  markCallCompletedInMessages,
  meetingHostFact,
  pronouncePhoneNumber,
  resetFollowupCounts,
  resolveOutboundName,
} from './chat';
import {
  extractCustomerPhone,
  resolveOutboundAgentForInbound,
  resolveOutboundAgentId,
} from './voiceRouting';
import { buildOutboundCallScope, inboundCallContext } from './callScope';
import { resolveLocation } from './enroll';
import { deletePendingTasksByType } from './scheduling';
import { releaseVoiceSlot } from './voiceConcurrency';
import { fetchConversationFromElevenlabs } from './elevenlabs';
import { syncHubspotStage } from './hubspotDeals';
import { buildAvailabilityBlock } from './hubspotMeetings';
import { formatElevenlabsTranscript } from '../tools/reviewCallTranscript';
import type { BedrockMessage, ChatMemory } from '../types';

/** The webhook payloads carry arbitrary provider fields; only the ones read here are named. */
type Payload = Record<string, unknown>;

export interface SignedRequest {
  /** The `ElevenLabs-Signature` header value, if present. */
  signature?: string | null;
  /** The EXACT raw body bytes as received. Re-serializing the parsed JSON would break the HMAC. */
  rawBody: string;
}

export interface WebhookResult {
  status: 'ok' | 'error' | 'ignored';
  matched?: boolean;
  chat_id?: string;
  message?: string;
  type?: string;
}

/**
 * HMAC-verify a webhook against `ELEVENLABS_OUTBOUND_WEBHOOK_SECRET`.
 *
 * No secret configured → `true` with a warning, so a deployment that has not set one yet still
 * processes calls. A secret configured → a valid `t=…,v0=…` signature over `"{t}.{rawBody}"` is
 * required. Compared in constant time.
 */
export function verifyElevenlabsSignature(request: SignedRequest): boolean {
  const secret =
    envStr('ELEVENLABS_OUTBOUND_WEBHOOK_SECRET') ||
    envStr('ELEVENLABS_WEBHOOK_SECRET');
  if (!secret) {
    console.warn(
      '[OB_EL] no ELEVENLABS_OUTBOUND_WEBHOOK_SECRET set — skipping signature check'
    );
    return true;
  }
  try {
    const header = request.signature ?? '';
    const parts: Record<string, string> = {};
    for (const p of header.split(',')) {
      const i = p.indexOf('=');
      if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    const ts = parts.t ?? '';
    const sig = parts.v0 ?? '';
    const expected = createHmac('sha256', secret)
      .update(`${ts}.${request.rawBody}`)
      .digest('hex');
    // timingSafeEqual throws on a length mismatch, so guard before comparing.
    if (expected.length !== sig.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (e) {
    console.error(`[OB_EL] signature verification error: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-call webhook
// ─────────────────────────────────────────────────────────────────────────────

const HANDLED_TYPES = ['post_call_transcription', 'call_initiation_failure'];

/** Resolve the conversation to an existing outbound chat. See the module note on the three tiers. */
async function resolveChatForConversation(
  conversationId: string,
  payload: Payload,
  data: Payload
): Promise<{ chatId: string | null; agentId: string | null }> {
  const pending = (await getPendingCall(conversationId)) ?? {};
  let chatId = (pending.chat_id as string | undefined) ?? null;
  let agentId = (pending.agent_id as string | undefined) ?? null;

  if (!chatId) {
    const idx = await getOutboundCallIndex(conversationId);
    if (idx?.chat_id) {
      chatId = idx.chat_id as string;
      agentId = agentId ?? (idx.agent_id as string | undefined) ?? null;
      console.log(`[OB_EL] resolved chat by call index -> ${chatId}`);
    }
  }

  if (!chatId) {
    const metadata = (payload.metadata ?? data.metadata ?? {}) as Payload;
    const assistantId = String(payload.agent_id ?? data.agent_id ?? '');
    agentId = await resolveOutboundAgentId(metadata, assistantId);
    const phone = extractCustomerPhone(metadata);
    if (agentId && phone) {
      const candidate = `outbound__${buildDeterministicChatId(agentId, phone)}`;
      // Confirm it EXISTS. This path must never mint a chat.
      if ((await db.collection('chats').doc(candidate).get()).exists) {
        chatId = candidate;
        console.log(`[OB_EL] resolved chat by agent+number -> ${chatId}`);
      }
    }
  }

  return { chatId, agentId };
}

/**
 * Build the call summary, and — for a real completion — persist the transcript the webhook RECEIVED.
 *
 * Storing it at `elevenlabs_conversations/{id}` is what lets the review read it instead of re-fetching.
 * A live re-fetch can race an empty turn-array, which scores as zero human turns and false-flags a real
 * conversation as voicemail; that has lost a booked demo. It also enforces the ordering "only review
 * after the transcript is received", because the review task is scheduled right after this store.
 */
async function buildSummaryAndStoreTranscript(
  conversationId: string,
  webhookType: string,
  payload: Payload,
  data: Payload
): Promise<{ summary: string; outcome: string }> {
  if (webhookType === 'call_initiation_failure') {
    const reason = String(
      payload.failure_reason ?? data.failure_reason ?? 'unknown'
    );
    return {
      summary: `Call initiation failed. Reason: ${reason}`,
      outcome: 'failed',
    };
  }

  const details = (await fetchConversationFromElevenlabs(conversationId)) ?? {};
  const analysis = (details.analysis ?? {}) as Payload;
  let summary = String(analysis.transcript_summary ?? '');

  if (!summary) {
    const turns = (details.transcript ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(turns) && turns.length > 0) {
      summary = turns
        .map((t) => `${t.role ?? 'unknown'}: ${t.message ?? ''}`)
        .join('\n');
    }
  }
  if (!summary) summary = 'Call completed (no transcript available)';

  try {
    // The webhook's own payload first — that is the copy that cannot race.
    const text = formatElevenlabsTranscript(
      (payload.transcript ?? details.transcript ?? []) as Array<
        Record<string, unknown>
      >
    );
    if (text) {
      await db
        .collection('elevenlabs_conversations')
        .doc(conversationId)
        .set({
          transcript: text,
          summary: String(analysis.transcript_summary ?? ''),
          stored_at: new Date().toISOString(),
        });
      console.log(`[OB_EL] stored received transcript for ${conversationId}`);
    }
  } catch (e) {
    console.warn(`[OB_EL] store transcript failed for ${conversationId}: ${e}`);
  }

  return { summary, outcome: 'completed' };
}

/**
 * Record an INBOUND call that has no outbound card to update.
 *
 * `makePhoneCall` never placed it, so neither the activity nor the message flip matched. Writing a
 * dedicated `received_phone_call` card puts the transcript summary on the chat without touching the
 * outbound path. Guarded on "no card for this call id yet", so a re-delivered webhook cannot duplicate.
 */
async function recordInboundCallCard(
  chatId: string,
  conversationId: string,
  summary: string,
  outcome: string
): Promise<void> {
  try {
    const existing = await db
      .collection('chats')
      .doc(chatId)
      .collection('messages_v3')
      .where('content.callId', '==', conversationId)
      .limit(1)
      .get();
    if (!existing.empty) return;

    const phone = String((await getMemory(chatId))?.phone_number ?? '');
    const tid = `received_${conversationId}`;
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: tid,
              name: 'received_phone_call',
              input: {},
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: tid,
              content: [
                {
                  json: {
                    call_id: conversationId,
                    phone_number: phone,
                    summary,
                    recording_url: '',
                    status: outcome,
                  },
                },
              ],
            },
          },
        ],
      },
    ] as unknown as BedrockMessage[];
    await addMessagesV3AndActivities(chatId, messages);
    console.log(
      `[OB_EL] recorded INBOUND call card for ${chatId} call=${conversationId}`
    );
  } catch (e) {
    console.warn(`[OB_EL] inbound call record failed for ${chatId}: ${e}`);
  }
}

/**
 * Handle a completed (or failed-to-initiate) call.
 *
 * The order of the five side effects is the design: cancel the watchdog, fill the card, schedule the
 * review, drop the index, release the slot. The review task is scheduled AFTER the transcript store so
 * it can never run against a transcript that has not landed.
 */
export async function handlePostCallWebhook(
  data: Payload,
  request: SignedRequest
): Promise<WebhookResult> {
  if (!verifyElevenlabsSignature(request)) {
    console.error('[OB_EL] invalid signature');
    return { status: 'error', message: 'invalid signature' };
  }

  const payload = (data.data ?? data) as Payload;
  const webhookType = String(data.type ?? '');
  const conversationId = String(
    payload.conversation_id ?? data.conversation_id ?? ''
  ).trim();

  if (webhookType && !HANDLED_TYPES.includes(webhookType)) {
    return { status: 'ignored', type: webhookType };
  }
  if (!conversationId) {
    return { status: 'error', message: 'no conversation_id' };
  }

  const { chatId, agentId } = await resolveChatForConversation(
    conversationId,
    payload,
    data
  );

  if (!chatId || !(await isOutboundChat(chatId))) {
    console.log(`[OB_EL] no outbound chat for conversation ${conversationId}`);
    return { status: 'ok', matched: false };
  }

  // This webhook IS the completion signal, so cancel the 20-minute check_if_call_succeeded fallback —
  // otherwise it fires later and re-reviews a call already handled here.
  try {
    const deleted = await deleteUnexecutedTasksByType(
      chatId,
      'check_if_call_succeeded'
    );
    if (deleted) {
      console.log(
        `[OB_EL] deleted ${deleted} check_if_call_succeeded task(s) for ${chatId}`
      );
    }
  } catch (e) {
    console.warn(
      `[OB_EL] failed to delete check_if_call_succeeded for ${chatId}: ${e}`
    );
  }

  let summary = '';
  let outcome = 'completed';
  try {
    ({ summary, outcome } = await buildSummaryAndStoreTranscript(
      conversationId,
      webhookType,
      payload,
      data
    ));
    await updateMessagesV3ForPhoneCall(
      chatId,
      conversationId,
      summary,
      '',
      outcome
    );
    console.log(
      `[OB_EL] updated call card summary for ${chatId} (outcome=${outcome})`
    );

    // Flip in_progress → completed in BOTH the Activities panel and the LLM context, matched by call
    // id. Without this the call reads in_progress forever and the model keeps waiting on it.
    const actsUpdated = await markCallCompletedInActivities(
      chatId,
      conversationId,
      summary,
      outcome
    );
    const msgUpdated = await markCallCompletedInMessages(
      chatId,
      conversationId,
      summary,
      outcome
    );
    console.log(
      `[OB_EL] marked make_phone_call ${outcome} for ${chatId} ` +
        `(activities=${actsUpdated}, messages=${msgUpdated})`
    );

    // Neither flip matched and this was a real call → nothing outbound placed it, so it is inbound.
    if (
      webhookType !== 'call_initiation_failure' &&
      !actsUpdated &&
      !msgUpdated
    ) {
      await recordInboundCallCard(chatId, conversationId, summary, outcome);
    }
  } catch (e) {
    console.warn(
      `[OB_EL] failed to update call card/state for ${chatId}: ${e}`
    );
  }

  // TEST records review immediately for E2E speed; real records keep a one-minute settle window.
  const memory = (await getMemory(chatId)) ?? {};
  const isTest =
    String(memory.record_type ?? '')
      .trim()
      .toLowerCase() === 'test';
  const executeAt = new Date(Date.now() + (isTest ? 0 : 60 * 1000));

  try {
    // Single-pending: a re-delivered webhook must not stack a second review turn. Per-chat dial dedup
    // means a chat never has two calls awaiting review, so purging by type leaves exactly one.
    try {
      await deletePendingTasksByType(chatId, 'call_completion_continuation');
    } catch (e) {
      console.warn(
        `[OB_EL] continuation single-pending purge skipped chat=${chatId}: ${e}`
      );
    }
    await createTaskWithId(chatId, 'call_completion_continuation', executeAt, {
      task_type: 'call_completion_continuation',
      call_id: conversationId,
      agent_id: agentId ?? memory.agent_id,
      task_source: 'elevenlabs_outbound_call_completion',
      // The essential mechanic (review THIS call_id) is fixed; "what next" is deferred to the skill,
      // which owns the email / retry / next-attempt decisions.
      notes:
        `Phone call completed. Call ID: ${conversationId}. Review it with the ` +
        'review_call_transcript tool for this call_id, then continue per your outbound ' +
        'skill (e.g. email and/or schedule the next attempt).',
    });
  } catch (e) {
    console.error(`[OB_EL] failed to schedule review task for ${chatId}: ${e}`);
    return { status: 'error', message: String(e) };
  }

  try {
    await deleteOutboundCallIndex(conversationId);
  } catch (e) {
    console.warn(
      `[OB_EL] failed to delete call index for ${conversationId}: ${e}`
    );
  }
  // Idempotent. The cron's TTL reconcile is the backstop when this webhook never arrives.
  try {
    await releaseVoiceSlot(chatId);
  } catch (e) {
    console.warn(`[OB_EL] voice slot release skipped for ${chatId}: ${e}`);
  }

  return { status: 'ok', matched: true, chat_id: chatId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation-init webhook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one voice assistant whose inbound opener is overridden.
 *
 * This webhook is shared by several outbound agents. Only this one's static `first_message` is the
 * outbound "Hello?" probe, which is wrong when the prospect is the caller — so the override is scoped
 * to its id and every other agent keeps its configured opener.
 */
const LILY_VOICE_ASSISTANT_ID = 'agent_6801kw9yvffseg6tmdeqv56wgkdz';

export interface ConversationInitResult {
  dynamic_variables: Record<string, unknown>;
  conversation_config_override?: Record<string, unknown>;
}

/** Seed memory for a brand-new inbound caller, mirroring enroll's minimal seed. Best-effort. */
export async function seedNewInboundCaller(
  chatId: string,
  agentId: string,
  callerPhone: string,
  dealersId: string
): Promise<ChatMemory> {
  const memory: ChatMemory = {
    phone_number: callerPhone,
    record_type: 'Real',
    _ob_state: 'new',
    agent_id: agentId,
  };
  if (dealersId) memory.dealers_id = String(dealersId);
  try {
    const [state, timezone] = resolveLocation(callerPhone, {});
    if (state) memory.state = state;
    if (timezone) memory.timezone = timezone;
  } catch {
    // Location is a nicety; a new caller is still seeded without it.
  }
  try {
    await setMemory(chatId, memory);
  } catch (e) {
    console.warn(`[OB_INIT] seed new caller failed for ${chatId}: ${e}`);
  }
  return memory;
}

/**
 * Answer the provider's pre-call context request for an INBOUND call.
 *
 * Resolves (or creates) the caller's outbound chat and returns the `dynamic_variables` the agent's
 * prompt reads — `local_scope` facts, `call_type`, `prospect_stage`, the agent's configured variables,
 * and the callback number.
 *
 * **Every failure path returns `{dynamic_variables: {}}` rather than an error**, because a pre-call
 * webhook must never stop the call from connecting. The agent then answers without context, which is
 * worse than answering with it but far better than not answering.
 */
export async function handleConversationInitWebhook(
  data: Payload,
  request: SignedRequest
): Promise<ConversationInitResult> {
  // Best-effort only — see the module note. The provider signs this with a DIFFERENT secret than the
  // post-call webhook, so hard-failing here returned an empty payload in production.
  try {
    if (!verifyElevenlabsSignature(request)) {
      console.warn(
        '[OB_INIT] signature check failed/absent — proceeding anyway (pre-call data webhook)'
      );
    }
  } catch {
    // Never let the check itself break the call.
  }

  const callerId = String(data.caller_id ?? data.from_number ?? '').trim();
  const assistantId = String(data.agent_id ?? '').trim();
  const calledNumber = String(
    data.called_number ?? data.to_number ?? ''
  ).trim();

  try {
    const agentId = await resolveOutboundAgentForInbound(
      calledNumber,
      assistantId
    );
    if (!agentId || !callerId) {
      console.log(
        `[OB_INIT] unresolved agent/caller (agent=${agentId}, caller='${callerId}') — minimal payload`
      );
      return { dynamic_variables: {} };
    }

    const agentDoc = await db.collection('agents').doc(agentId).get();
    const agentData = agentDoc.exists ? (agentDoc.data() ?? {}) : {};
    const dynConfig = (agentData.dynamic_variables ?? {}) as Record<
      string,
      unknown
    >;
    const companyId = String(agentData.company_id ?? '');

    // Same deterministic scheme as outreach, so an inbound call lands on the prospect's own chat.
    let chatId = `outbound__${buildDeterministicChatId(agentId, callerId)}`;
    const exists = (await db.collection('chats').doc(chatId).get()).exists;
    let memory: ChatMemory;

    if (exists) {
      memory = (await getMemory(chatId)) ?? {};
      const dealersId = String(memory.dealers_id ?? memory.dealer_id ?? '');
      try {
        // An inbound call from a known prospect is a strong engagement signal.
        await setProspectStage(
          chatId,
          'Engaged',
          'incoming_call',
          dealersId,
          companyId
        );
        try {
          await resetFollowupCounts(chatId);
          await clearCadenceComplete(chatId); // an inbound call reopens the cadence
        } catch {
          // Non-blocking: the stage advance is what matters.
        }
      } catch (e) {
        console.warn(`[OB_INIT] stage->Engaged failed for ${chatId}: ${e}`);
      }
      try {
        await syncHubspotStage(chatId, agentId);
      } catch {
        // Best-effort: the call must connect regardless.
      }
    } else {
      chatId = (await getOrCreateOutboundChat(agentId, callerId)).chatId;
      const dealersId = String(agentData.dealers_id ?? '');
      memory = await seedNewInboundCaller(chatId, agentId, callerId, dealersId);
      try {
        await setProspectStage(
          chatId,
          'New',
          'incoming_call',
          dealersId,
          companyId
        );
      } catch (e) {
        console.warn(`[OB_INIT] stage->New failed for ${chatId}: ${e}`);
      }
    }

    // local_scope is FACTS only. The call is driven entirely by the provider-side agent prompt, so
    // skills are not injected here — the same facts builder outbound uses, fed the INBOUND context so
    // call_type stays INBOUND_* and a known caller reuses the follow-up branch's prior-contact facts.
    const ctx = await inboundCallContext(memory, chatId);
    // `booked` stays false: an inbound caller's booking state is carried by the ctx, and the
    // source passes only the ctx here.
    let localScope = await buildOutboundCallScope(memory, chatId, false, ctx);

    try {
      // Phase 9 supplies `ensureMeetingHost`; until then the fact is built from whatever memory holds,
      // which is exactly what the source falls back to when the CRM lookup fails.
      const hostFact = meetingHostFact(memory.meeting_host);
      if (hostFact) localScope = `${localScope}\n\n${hostFact}`;
    } catch (e) {
      console.warn(`[OB_INIT] meeting-host inject skipped for ${chatId}: ${e}`);
    }

    const summary = String(memory._conversation_summary ?? '').trim();
    if (summary) {
      localScope = `${localScope}\n\nCONVERSATION SUMMARY:\n${summary}`;
    }

    // Real bookable times: the voice agent has no tool to fetch slots mid-call, so without this the
    // model invents them. The same block `makePhoneCall` injects for the outbound direction.
    try {
      const block = await buildAvailabilityBlock(agentId, memory);
      if (block) localScope = `${localScope}\n\n${block}`;
    } catch (e) {
      console.warn(
        `[OB_INIT] inbound slot injection failed for ${chatId}: ${e}`
      );
    }

    const dynamicVariables: Record<string, unknown> = {};
    for (const varName of Object.keys(dynConfig)) {
      const val = (memory as Record<string, unknown>)[varName];
      dynamicVariables[varName] =
        val === null || val === undefined || val === ''
          ? 'Not Available'
          : String(val);
    }
    dynamicVariables.local_scope = localScope;
    dynamicVariables.call_type = ctx.call_type;
    dynamicVariables.prospect_stage = ctx.stage;
    if (calledNumber) {
      dynamicVariables.callback_number = calledNumber;
      dynamicVariables.callback_number_pronounced =
        pronouncePhoneNumber(calledNumber);
    }
    dynamicVariables.sales_agent_name = await resolveOutboundName(
      memory,
      agentData
    );

    const resp: ConversationInitResult = {
      dynamic_variables: dynamicVariables,
    };
    if (assistantId === LILY_VOICE_ASSISTANT_ID) {
      const persona = dynamicVariables.sales_agent_name || 'Lily';
      resp.conversation_config_override = {
        agent: {
          first_message: `Hi! This is ${persona} from AutoAcquire AI. How can I help you?`,
        },
      };
    }

    console.log(
      `[OB_INIT] inbound call resolved chat=${chatId} agent=${agentId} ` +
        `known=${exists} call_type=${ctx.call_type}`
    );
    return resp;
  } catch (e) {
    console.error(
      `[OB_INIT] conversation-init failed (caller='${callerId}'): ${e}`
    );
    return { dynamic_variables: {} };
  }
}
