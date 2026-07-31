/**
 * The outbound turn entry — what actually runs an agent turn end to end.
 *
 * `runOutboundTurn` assembles the prompt, guards concurrency, calls the dispatch loop, and persists the
 * result. `runOutboundLlm` is the thin wrapper the cron and the email webhook call, and it is what
 * closes the injected `runTurn` seam Phase 5 left open.
 *
 * Framework-free on purpose: the source drives all of this through a DRF view and invokes it in-process
 * via a request shim, so the logic and the HTTP endpoint were fused. Here the logic is a function and
 * Phase 10's route will be a thin adapter over the same call — the shim disappears.
 *
 * ## The `@ai` trigger has two flavours and only one of them can override timing
 *
 * A message mentioning `@ai` or `@atlas` is an ADMIN instruction. A **human**-typed one arrives over
 * HTTP and is AUTHORITATIVE on timing: it may bypass the normal delays and business-hours clamp, and
 * "asap"/"immediately"/"right away"/"right now" forces the action now. An **internal** one — the cron,
 * the email webhook — carries `admin_trigger_source: 'internal'` and gets no such authority, because
 * automated triggers firing "immediately" is how a scheduler stampedes.
 *
 * Both flags flow into the tools through `metaData`: `admin_override` (any human trigger) and
 * `admin_asap`. `create_custom_task` reads them, and so does the cron's ungated-execution path.
 *
 * ## The rapid-status guard is a per-chat lock, and its failure mode is a stuck chat
 *
 * `rapid_status = true` means a turn is already running for this chat; a new message is QUEUED rather
 * than starting a second concurrent turn against the same history. The flag is therefore cleared in
 * every exit path — success, failure, and the early returns — because a leaked `true` silently queues
 * every future message and the chat goes quiet with no error anywhere.
 *
 * ## An outbound chat DISCARDS its base prompt
 *
 * `applySkillsToPrompt` resets the base prompt to empty for `type: 'outbound'` and uses the active
 * skill text as the whole prompt. That is why the injections below are re-applied AFTER skills, and why
 * `restoreWipedInjections` exists: the meeting-host fact and the `@ai` recent-conversation block are
 * added before skills run and would otherwise be wiped — which is precisely what makes "@ai read the
 * inbound email and reply" work.
 *
 * ## The prompt's AVAILABILITY block is computed, never left to the model
 *
 * Channel reachability, opt-outs, the no-answer-email window, and the follow-up counts are all resolved
 * in code and stated as facts. The no-answer gate is the clearest case: it is a "within 24 hours"
 * judgement, models are unreliable at time arithmetic, and getting it wrong means either a wasted turn
 * the send guard blocks anyway or an email whose premise is false.
 *
 * The STATUS line exists for a subtler reason: a prospect can be reopened by ops, but the message
 * history is never rewritten — so without an authoritative current-status line the agent re-reads its
 * own old "marked Lost, cannot be reactivated" text and refuses to act.
 *
 * ## Not ported
 *
 * The inbound halves of the source view: WhatsApp/Unipile/Twilio account resolution, attachment
 * analysis instructions, the VIN protocol, appraisal confirmed-fields substitution, the inbound SMS
 * local scope, per-vehicle message windowing, the TCPA gate, and the notification-engine escalation
 * gate. All belong to the inbound product; none has an outbound code path. `sync_hubspot_stage` on an
 * inbound SMS reply is Phase 9.
 */

import {
  addMessagesToChat,
  addToRapidQueue,
  getChatMessages,
  getMemory,
  getRapidStatus,
  setRapidStatus,
} from '../firebase/chat';
import {
  getAgent,
  getAgentDataForPrompt,
  getAgentPrompt,
  getEnabledFunctionsForAgent,
} from '../firebase/agent';
import { db } from '../firebase/db';
import {
  applySkillsToPrompt,
  replaceTemplateVariables,
  resolveStageAndSkills,
  restoreWipedInjections,
} from '../services/skillsResolver';
import {
  buildPhoneConsentAskLine,
  hubspotContextLine,
} from '../services/callScope';
import { meetingHostFact } from '../services/chat';
import { maxEmailFollowups } from '../config';
import { withTools } from './run';
import type { SessionUsage, TurnMeta } from './run';
import type { BedrockMessage, ChatMemory } from '../types';

/** `@ai` / `@atlas` — an admin instruction rather than a customer message. */
const MENTIONS = ['@atlas', '@ai'];

/** Words that make a HUMAN `@ai` trigger act now rather than at the cadence's next slot. */
const ASAP_RE = /\b(asap|immediately|right away|right now)\b/i;

/** Does this message address the agent directly? */
export function checkMention(text: string | null | undefined): boolean {
  const lower = String(text ?? '').toLowerCase();
  return MENTIONS.some((m) => lower.includes(m));
}

export interface RunTurnInput {
  message: string;
  agentId: string;
  chatId: string;
  attendeeId?: string | null;
  accountId?: string | null;
  provider?: string;
  /** `'human'` (an HTTP request) or `'internal'` (cron, email webhook). Only human overrides timing. */
  adminTriggerSource?: string;
}

export interface RunTurnResult {
  status: number;
  entries?: BedrockMessage[];
  usage?: SessionUsage;
  queued?: boolean;
  error?: string;
}

/** The message-context preamble and the sender identity for this turn. */
function resolveTriggerContext(message: string, adminTriggerSource: string) {
  if (checkMention(message)) {
    const source = String(adminTriggerSource || 'human')
      .trim()
      .toLowerCase();
    const adminOverride = source === 'human';
    return {
      messageContext:
        'This is a message from ADMIN with instruction. Please act accorindly. Admin with refer ' +
        'to you as @ai or @atlas. Use send_web_message_to_admin to message back to admin if needed.\n',
      messageFrom: 'admin',
      channel: 'whatsapp', // admin messages come from web; the channel does not gate their tools
      adminTrigger: true,
      // Only a HUMAN trigger is authoritative on timing — an automated one firing "immediately"
      // is how a scheduler stampedes.
      adminOverride,
      adminAsap: adminOverride && ASAP_RE.test(String(message ?? '')),
    };
  }
  return {
    messageContext:
      'You received the message on WhatsApp. IMPORTANT: You MUST call the appropriate WhatsApp ' +
      'tool to reply - plain text responses will NOT be delivered to the customer.\n',
    messageFrom: 'customer',
    channel: 'whatsapp',
    adminTrigger: false,
    adminOverride: false,
    adminAsap: false,
  };
}

/** `"Y"`-style truthiness, as the prompt blocks read it. */
function isY(memory: ChatMemory, key: string): boolean {
  return (
    String((memory as Record<string, unknown>)[key] ?? '').toUpperCase() === 'Y'
  );
}

/** Is an unanswered call on record within the last 24 hours? Computed, never asked of the model. */
function noAnswerWindowFresh(memory: ChatMemory): boolean {
  const stamp = memory._last_call_unanswered_at;
  if (!stamp) return false;
  try {
    const ts = new Date(String(stamp).replace('Z', '+00:00'));
    if (Number.isNaN(ts.getTime())) return false;
    return Date.now() - ts.getTime() <= 24 * 3_600_000;
  } catch {
    return false;
  }
}

/**
 * The OUTBOUND LEAD CONTEXT and AVAILABILITY & SIGNALS blocks.
 *
 * Every line is a resolved fact. See the module note on why the no-answer gate and the STATUS line are
 * computed here rather than left to the model.
 */
export function buildOutboundContextBlocks(
  memory: ChatMemory,
  prospectStage: string,
  messageFrom: string,
  message: string
): string {
  const leadLines: string[] = [];
  for (const [label, key] of [
    ['Name', 'first_name'],
    ['Last name', 'last_name'],
    ['Phone', 'phone_number'],
    ['Email', 'customer_email'],
    ['Company', 'company'],
  ] as const) {
    const v = (memory as Record<string, unknown>)[key];
    if (v) leadLines.push(`- ${label}: ${v}`);
  }
  try {
    const hc = hubspotContextLine(memory);
    if (hc) leadLines.push(`- Context: ${hc}`);
  } catch {
    // Context is a nicety; the lead block stands without it.
  }

  const phoneOut = isY(memory, 'block_phone') || isY(memory, 'phone_opt_out');
  const emailOut = memory._email_opt_out === true;
  const avail: string[] = [
    `- current stage: ${prospectStage}`,
    `- phone: ${
      phoneOut
        ? 'opted out (do not call)'
        : memory.phone_number
          ? 'reachable'
          : 'none on file'
    }`,
    `- email: ${
      emailOut
        ? 'opted out (do not email)'
        : memory.customer_email
          ? 'reachable'
          : 'none on file'
    }`,
  ];

  // Phone is the primary channel. Stated deterministically, because a model with both channels open
  // defaults to email.
  if (memory.phone_number && !phoneOut && memory.customer_email) {
    avail.push(
      '- CHANNEL PRIORITY: phone is open and is our PRIMARY channel — place a ' +
        'CALL first; use email only after the call cadence is exhausted.'
    );
  }
  if (isY(memory, 'sms_opt_out')) {
    avail.push('- SMS: opted out (do-not-SMS)');
  }

  // The PEWC consent ask: fires only when phone is closed but email is open, so a reply carries
  // consent and the review can reopen the channel.
  const consentLine = buildPhoneConsentAskLine(memory, messageFrom, message);
  if (consentLine) avail.push(consentLine);

  if (memory._customer_wants_callback) {
    const cbt = memory._callback_time;
    avail.push(`- customer requested a callback${cbt ? ` at ${cbt}` : ''}`);
  }
  if (memory._last_channel) {
    avail.push(
      `- last touch: ${memory._last_channel} at ${memory._last_touch_at}`
    );
  }

  // Only meaningful when a phone is reachable — an email-only prospect has no call to tie a
  // "couldn't reach you" email to.
  if (memory.phone_number && !phoneOut) {
    if (noAnswerWindowFresh(memory)) {
      avail.push(
        '- no-answer email: ALLOWED — an unanswered call is on record within the last 24h.'
      );
    } else {
      avail.push(
        '- no-answer email: NOT ALLOWED right now — reason: no unanswered call within the ' +
          "last 24h on record. Do NOT call send_email for a 'couldn't reach you' / 'tried to " +
          "reach you' email; place (or wait for) a call first, then it becomes valid. (Such an " +
          'email is also blocked at send without a fresh unanswered call.)'
      );
    }
  }

  // The authoritative current status. Without it the agent re-reads its own stale "cannot be
  // reactivated" text from the transcript and refuses to act on a reopened prospect.
  const reachable: string[] = [];
  if (memory.phone_number && !phoneOut) reachable.push('phone');
  if (memory.customer_email && !emailOut) reachable.push('email');
  const isLost =
    String(prospectStage ?? '')
      .trim()
      .toLowerCase() === 'lost';
  if (!isLost && reachable.length > 0) {
    avail.push(
      `- STATUS: this prospect is ACTIVE at stage ${prospectStage} and reachable by ` +
        `${reachable.join(' and ')}. This CURRENT status is authoritative — if anything ` +
        "earlier in the transcript says the prospect is lost, opted-out, or 'cannot be " +
        "reactivated', it is stale; disregard it and continue outreach on the reachable channel(s)."
    );
  }

  // Which touch number we are on, plus the anchor to compute the next offset from, so the skill
  // never restarts or skips a cadence stage.
  const ef = Number(memory.email_followup_count ?? 0) || 0;
  const cf = Number(memory.call_followup_count ?? 0) || 0;
  avail.push(
    `- follow-ups sent so far — email: ${ef} of ${maxEmailFollowups()}, call: ${cf}. ` +
      `First email: ${memory._first_outbound_email_at ?? 'not sent yet'}. ` +
      `First call: ${memory._first_outbound_call_at ?? 'not placed yet'}. ` +
      'Use these to schedule the NEXT follow-up at the correct offset (do not restart or skip stages).'
  );

  const blocks: string[] = [];
  if (leadLines.length > 0) {
    blocks.push(`OUTBOUND LEAD CONTEXT:\n${leadLines.join('\n')}`);
  }
  blocks.push(
    'AVAILABILITY & SIGNALS (CURRENT, authoritative — use for stage, follow-up channel + opt-outs):\n' +
      avail.join('\n')
  );
  return blocks.join('\n\n');
}

/**
 * Run one outbound turn for a chat.
 *
 * Returns a status mirroring the source view's HTTP codes: `200` with the new entries, `202` when the
 * message was queued behind a running turn, `400` on missing input, `500` on failure.
 */
export async function runOutboundTurn(
  input: RunTurnInput
): Promise<RunTurnResult> {
  // Captured immediately, so the message keeps its true arrival time even when the turn (and its
  // nested tool calls) takes seconds.
  const receivedAt = new Date();

  const { message, agentId, chatId } = input;
  if (!message || !agentId || !chatId) {
    const missing = [
      !message && 'message',
      !agentId && 'agent_id',
      !chatId && 'chat_id',
    ].filter(Boolean);
    return {
      status: 400,
      error: `Missing required fields: ${missing.join(', ')}`,
    };
  }

  const trigger = resolveTriggerContext(
    message,
    input.adminTriggerSource ?? 'human'
  );

  const agentData = await getAgent(agentId);
  if (!agentData) {
    return { status: 400, error: `Agent ${agentId} not found` };
  }

  const chatDoc = await db.collection('chats').doc(chatId).get();
  const chatData = chatDoc.exists ? (chatDoc.data() ?? {}) : {};
  const chatType = chatData.type as string | undefined;

  // The per-chat lock. A second concurrent turn against the same history would interleave writes and
  // answer from a stale view, so a message arriving mid-turn is QUEUED for the running turn's drain.
  if (await getRapidStatus(chatId)) {
    await addToRapidQueue(chatId, {
      message,
      from: trigger.messageFrom === 'admin' ? 'admin' : chatId,
      userType: trigger.messageFrom === 'admin' ? 'admin' : 'customer',
    });
    return { status: 202, queued: true };
  }
  await setRapidStatus(chatId, true);

  try {
    const chatHistory = ((await getChatMessages(chatId)) ??
      []) as BedrockMessage[];
    let systemPrompt = (await getAgentPrompt(agentId)) ?? '';
    const enabledFunctions = await getEnabledFunctionsForAgent(agentId);
    const chatMemory = (await getMemory(chatId)) ?? {};

    const promptData = await getAgentDataForPrompt(agentId);
    if (promptData.knowledge_sources) {
      systemPrompt += `\n\nKnowledge Sources url and description:\n${promptData.knowledge_sources}`;
    }
    if (promptData.lead_stages) {
      systemPrompt += `\n\n${promptData.lead_stages}\n`;
    }

    systemPrompt = trigger.messageContext + systemPrompt;

    // Added BEFORE skills, and restored after — see restoreWipedInjections below.
    const hostFact = meetingHostFact(chatMemory.meeting_host);
    if (hostFact) systemPrompt = `${hostFact}\n\n${systemPrompt}`;

    const metaData: TurnMeta = {
      chat_id: chatId,
      channel: trigger.channel,
      enabled_functions: enabledFunctions,
      assigned_model: agentData.assigned_model as string | undefined,
      company_id: agentData.company_id as string | number | undefined,
      agent_id: agentId,
      from: trigger.messageFrom,
      userType: trigger.messageFrom,
      is_admin_trigger: trigger.adminTrigger,
      admin_override: trigger.adminOverride,
      admin_asap: trigger.adminAsap,
      chat_owner_agent_id: agentId,
    };

    // Stage-driven skills. For an outbound chat this REPLACES the base prompt entirely.
    let prospectStage = 'New';
    try {
      // NOTE this is the skills resolver's version, which returns an OBJECT — `reviewHelpers` exports a
      // same-named function returning a TUPLE. Two different contracts under one name in the source.
      const { stage, activeSkills } = await resolveStageAndSkills(
        chatId,
        agentId
      );
      prospectStage = stage;
      if (activeSkills.length > 0) {
        const [prompted, skillEnabledTools] = applySkillsToPrompt(
          systemPrompt,
          activeSkills,
          enabledFunctions,
          chatType
        );
        systemPrompt = prompted;
        metaData.skill_enabled_tools = skillEnabledTools;
        console.log(
          `[Skills] Injected ${activeSkills.length} skills for stage=${stage}`
        );

        if (chatType === 'outbound') {
          // The skill text is now the whole prompt, so the lead's details — seeded at enrollment —
          // would otherwise never reach the agent.
          systemPrompt = `${buildOutboundContextBlocks(
            chatMemory,
            prospectStage,
            trigger.messageFrom,
            message
          )}\n\n${systemPrompt}`;

          const conv = chatMemory._conversation_summary;
          if (conv) {
            systemPrompt = `CONTEXT FROM PRIOR INTERACTIONS:\n${conv}\n\n${systemPrompt}`;
          }
          systemPrompt = replaceTemplateVariables(systemPrompt, chatMemory);
          // Skills wiped the pre-skills injections; put them back on top. This is what makes
          // "@ai read the inbound email and reply" work.
          systemPrompt = restoreWipedInjections(systemPrompt, hostFact, '');
        }
      } else {
        console.log(`[Skills] No active skills for stage=${stage}`);
      }
    } catch (e) {
      console.warn(`[Skills] Failed to load skills: ${e}`);
    }

    const turn = await withTools({
      systemPrompt,
      inputText: message,
      chatHistory,
      accountId: String(input.accountId ?? ''),
      attendeeId: String(input.attendeeId ?? ''),
      chatId,
      agentId,
      metaData,
    });

    if (!turn) {
      // withTools returns undefined on an unexpected stop reason — nothing to persist.
      console.warn(
        `[OB TURN] no result for chat ${chatId} (unexpected stop reason)`
      );
      return { status: 200, entries: [] };
    }

    const [newEntries, usage] = turn;
    if (newEntries.length > 0) {
      // `receivedAt` as the base, so the customer's message keeps its true arrival time.
      await addMessagesToChat(chatId, newEntries, false, receivedAt);
    }
    return { status: 200, entries: newEntries, usage };
  } catch (e) {
    console.error(`[OB TURN] failed for chat ${chatId}: ${e}`);
    return { status: 500, error: String(e) };
  } finally {
    // EVERY exit path clears the lock. A leaked `true` queues every future message for this chat and
    // it goes quiet with no error anywhere — the worst kind of failure to diagnose.
    await setRapidStatus(chatId, false);
  }
}

/**
 * The in-process turn runner for the cron and the email webhook.
 *
 * This is the real implementation of the `runTurn` parameter Phase 5's cron has been carrying as an
 * injected seam. `admin_trigger_source: 'internal'` is the important argument: it marks the trigger
 * automated, so an `@ai` instruction from a scheduler cannot claim a human's authority over timing.
 */
export async function runOutboundLlm(
  message: string,
  agentId: string,
  chatId: string,
  options: {
    provider?: string;
    attendeeId?: string | null;
    accountId?: string | null;
  } = {}
): Promise<RunTurnResult> {
  return runOutboundTurn({
    message,
    agentId,
    chatId,
    attendeeId: options.attendeeId ?? null,
    accountId: options.accountId ?? null,
    provider: options.provider ?? 'outbound',
    adminTriggerSource: 'internal',
  });
}

export const __testing = {
  resolveTriggerContext,
  noAnswerWindowFresh,
  ASAP_RE,
};
