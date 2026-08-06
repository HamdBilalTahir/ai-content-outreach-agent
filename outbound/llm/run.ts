/**
 * The tool-dispatch loop — `with_tools`.
 *
 * One call to `withTools` is one agent TURN: ask the model, run whatever tools it asked for, feed the
 * results back, repeat until it stops. Everything that makes a turn safe or lossless lives here.
 *
 * ## The dispatch is a TABLE, not the source's 96-branch `elif` chain
 *
 * This is the one structural departure, and it is forced. The source dispatches 96 tool names, of which
 * about 85 are INBOUND tools (WhatsApp, Zoho, Xtime, hotel booking, dealership appointments) belonging to
 * the product this port is a clean break from. Reproducing the chain would mean porting or stubbing ~85
 * modules that are out of scope, and the ground rules forbid stubbing.
 *
 * So the table holds the tools that exist here, and an unrecognised name gets the source's own
 * "not implemented by this runtime" error toolResult — the exact path the source takes when `message`
 * is still `None` after the chain. A tool the model hallucinates, or an inbound tool an agent config
 * leaks in, therefore behaves identically to the source: one error result, and the turn continues so
 * the model can react. This is also why Phase 8a inverted the source's ~20 direct schema imports into
 * a registry: a tool becomes dispatchable the moment it is ported, with no edit here.
 *
 * ## The rapid queue is drained TWICE, and the second one is a race fix
 *
 * A customer can send another message while the model is thinking. The first drain runs right after
 * `generateText`; the second runs at `end_turn`, because a message that arrived between those two
 * points would otherwise be answered only on the NEXT turn — or not at all. Both re-open the turn
 * instead of replying to a stale view of the conversation.
 *
 * The two drains differ in one detail: the first POPS a trailing assistant message before appending, so
 * the model's half-formed reply to the older input is discarded. The end_turn drain does not, because
 * the assistant turn there is the completed answer.
 *
 * ## A generation failure PERSISTS what already happened, then re-raises
 *
 * If the model call fails after tools have already run in earlier iterations, those tool results are
 * written to the chat before the error propagates. Otherwise a mid-turn provider blip would silently
 * discard a real email send or a placed call from the conversation history — the side effect happened,
 * so the record must survive.
 *
 * ## The short-circuit ends `@ai` turns that were entirely gated
 *
 * When every tool in an iteration returned a deterministic BY-DESIGN gate (opt-out, suppressed,
 * business-hours defer, phone-lane-call-only) and none succeeded or genuinely FAILED, there is nothing
 * for the model to add — so the turn ends without another round-trip whose only output would be a
 * discarded acknowledgement. Genuine failures are deliberately NOT short-circuited: the loop continues
 * so the model can react and the failure reaches the chat. Customer-facing turns are excluded entirely;
 * they always get a reply.
 *
 * ## An unexpected stop reason returns UNDEFINED, not a result
 *
 * The source `return`s bare from inside the loop, so the caller receives `None` rather than a tuple.
 * Preserved: callers must handle it, and Phase 8b⁴ does.
 *
 * ## Not ported
 *
 * The `create_plan` repeat-guard: `create_plan` is an inbound tool, so the branch is unreachable here.
 * The `switch_to_next_vehicle` and Xtime branches, and the ~85 other inbound handlers, for the same
 * reason. `sync_hubspot_stage` after `mark_prospect_lost` / `update_prospect` is Phase 9.
 */

import { generateText } from './ask';
import {
  BACKEND_GUARDRAILS_HEADER,
  OUTBOUND_MESSAGE_TOOL_NAMES,
  appendToolResultMessage,
  buildMessage,
  buildToolResultMessage,
  extractToolStatusAndMessage,
  injectBackendGuardrails,
  injectGroqToolUsePolicy,
  resolveProviderForTurn,
  stampEmailOutcomeOnToolCall,
  terminalBlockShortcircuitEnabled,
} from './turnHelpers';
import {
  addMessagesToChat,
  clearRapidQueue,
  getRapidQueue,
  logLlmUsage,
} from '../firebase/chat';
import { turnIsByDesignGated } from '../services/chat';
import { envInt } from '../config';
import { parseAndRunSendEmail } from '../tools/email';
import {
  parseAndRunMakePhoneCall,
  parseAndRunMakePhoneCallFromNumber,
} from '../tools/makePhoneCall';
import { parseAndRunReviewCallTranscript } from '../tools/reviewCallTranscript';
import {
  parseAndRunGetHubspotAvailableSlots,
  parseAndRunScheduleHubspotMeeting,
} from '../tools/hubspotMeetingTools';
import {
  parseAndRunCreateCustomTask,
  parseAndRunDeleteCustomTask,
  parseAndRunUpdateCustomTask,
} from '../tools/taskTools';
import {
  parseAndRunClearNotInterested,
  parseAndRunMarkCadenceComplete,
  parseAndRunMarkProspectLost,
} from '../tools/stageTools';
import { parseAndRunEscalateToHuman } from '../tools/escalateToHuman';
import type { BedrockMessage } from '../types';
import type { GenerateMeta } from './ask';

/** Per-turn tool-call and token counters, returned to the caller. */
export interface SessionUsage {
  tools: Record<string, number>;
  tokens: { input: number; output: number };
}

export interface TurnMeta extends GenerateMeta {
  channel?: string;
  enabled_functions?: string[];
  skill_enabled_tools?: Iterable<string>;
  chat_id?: string;
  is_admin_trigger?: boolean;
  [k: string]: unknown;
}

export interface WithToolsArgs {
  systemPrompt: string;
  inputText?: string;
  chatHistory?: BedrockMessage[];
  accountId?: string;
  attendeeId?: string;
  chatId?: string;
  agentId?: string | null;
  metaData?: TurnMeta;
}

/** Everything a tool handler might need. Assembled once per dispatch. */
interface DispatchContext {
  toolUseId: string;
  input: Record<string, unknown>;
  accountId: string;
  attendeeId: string;
  chatId: string;
  metaData: TurnMeta;
}

type ToolHandler = (ctx: DispatchContext) => Promise<BedrockMessage>;

/**
 * The tools this runtime can run.
 *
 * Argument ORDER differs per tool because the source's handler signatures do; each is matched to its
 * own ported signature rather than normalized, so a future re-port against the Python stays comparable.
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  send_email: (c) => parseAndRunSendEmail(c.toolUseId, c.input, c.metaData),

  make_phone_call: (c) =>
    parseAndRunMakePhoneCall(c.toolUseId, c.input, c.metaData),
  make_phone_call_from_number: (c) =>
    parseAndRunMakePhoneCallFromNumber(c.toolUseId, c.input, c.metaData),
  review_call_transcript: (c) =>
    parseAndRunReviewCallTranscript(c.toolUseId, c.input, {
      chatId: c.chatId,
      metaData: c.metaData,
    }),

  create_custom_task: (c) =>
    parseAndRunCreateCustomTask(
      c.toolUseId,
      c.input,
      c.accountId,
      c.attendeeId,
      c.chatId,
      c.metaData
    ),
  update_custom_task: (c) =>
    parseAndRunUpdateCustomTask(
      c.toolUseId,
      c.input,
      c.accountId,
      c.attendeeId,
      c.chatId
    ),
  delete_custom_task: (c) =>
    parseAndRunDeleteCustomTask(
      c.toolUseId,
      c.input,
      c.accountId,
      c.attendeeId,
      c.chatId
    ),

  get_hubspot_available_slots: (c) =>
    parseAndRunGetHubspotAvailableSlots(c.toolUseId, c.input, {
      ...c.metaData,
      chat_id: c.chatId,
    }),
  schedule_hubspot_meeting: (c) =>
    parseAndRunScheduleHubspotMeeting(c.toolUseId, c.input, {
      ...c.metaData,
      chat_id: c.chatId,
    }),

  mark_prospect_lost: (c) =>
    parseAndRunMarkProspectLost(c.toolUseId, c.input, c.chatId, c.metaData),
  mark_cadence_complete: (c) =>
    parseAndRunMarkCadenceComplete(c.toolUseId, c.input, c.chatId, c.metaData),
  clear_not_interested: (c) =>
    parseAndRunClearNotInterested(c.toolUseId, c.input, c.chatId),
  escalate_to_human: (c) =>
    parseAndRunEscalateToHuman(
      c.toolUseId,
      c.input as { reason?: string; evidence?: string },
      c.chatId,
      c.metaData
    ),
};

/** Tool names this runtime can dispatch. Exposed so the turn entry can report them. */
export function dispatchableToolNames(): string[] {
  return Object.keys(TOOL_HANDLERS).sort();
}

/** One queued rapid message, as the queue stores it. */
interface QueuedMessage {
  from?: string;
  userType?: string;
  message: string;
}

/** The JSON envelope a queued message becomes — the same shape `buildMessage` produces. */
function queuedTextBlock(q: QueuedMessage): { text: string } {
  return {
    text: JSON.stringify({
      from: q.from ?? 'user',
      userType: q.userType ?? 'customer',
      text: q.message,
    }),
  };
}

/**
 * Fold queued messages into the history so the turn answers the LATEST input.
 *
 * `popTrailingAssistant` discards a half-formed reply to the older input — correct for the mid-loop
 * drain, wrong at end_turn where the assistant turn is the finished answer.
 */
function foldQueuedMessages(
  msg: BedrockMessage[],
  queued: QueuedMessage[],
  popTrailingAssistant: boolean
): void {
  if (popTrailingAssistant) {
    const last = msg[msg.length - 1] as BedrockMessage | undefined;
    if (last && last.role === 'assistant') msg.pop();
  }

  const last = msg[msg.length - 1] as
    | (BedrockMessage & { content?: unknown })
    | undefined;
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    for (const q of queued) {
      (last.content as unknown[]).push(queuedTextBlock(q));
    }
    return;
  }
  msg.push({
    role: 'user',
    content: queued.map(queuedTextBlock),
  } as unknown as BedrockMessage);
}

/**
 * Run one agent turn.
 *
 * Returns `[newHistoryEntries, sessionUsage]` — only the entries this turn ADDED, so the caller
 * persists exactly the delta. Returns `undefined` on an unexpected stop reason (see the module note).
 */
export async function withTools(
  args: WithToolsArgs
): Promise<[BedrockMessage[], SessionUsage] | undefined> {
  const {
    systemPrompt,
    inputText = '',
    chatHistory = [],
    accountId = '',
    attendeeId = '',
    agentId = null,
  } = args;
  const metaData: TurnMeta = args.metaData ?? {};

  console.log('[LLM] Starting LLM processing');

  const sessionUsage: SessionUsage = {
    tools: {},
    tokens: { input: 0, output: 0 },
  };

  const channel = String(metaData.channel ?? 'unknown');
  let enabledFunctions = [...(metaData.enabled_functions ?? [])];

  // An oversee agent must reach SMS through the handoff flow, because sending directly bypasses it and
  // breaks reply routing. A SKILL that explicitly enabled the direct tool overrides this — the skill
  // author knows the stage they are in. Inbound-shaped (the handoff tool is not in this port), but kept:
  // it is pure list filtering, and it MUTATES metaData.enabled_functions, which the rest of the turn reads.
  const skillEnabledTools = new Set(metaData.skill_enabled_tools ?? []);
  if (
    enabledFunctions.includes('handle_sms_conversation') &&
    !skillEnabledTools.has('send_sms_message_using_twilio')
  ) {
    enabledFunctions = enabledFunctions.filter(
      (f) => f !== 'send_sms_message_using_twilio'
    );
    metaData.enabled_functions = enabledFunctions;
    console.log(
      '[LLM] Stripped send_sms_message_using_twilio (oversee agent uses handle_sms_conversation)'
    );
  }

  const providerForTurn = resolveProviderForTurn(metaData);
  let runtimeSystemPrompt = injectBackendGuardrails(
    systemPrompt,
    channel,
    enabledFunctions
  ) as string;
  console.log('[LLM] Applied backend guardrails in system prompt');
  // The chat id the TURN uses comes from meta_data, overriding the parameter — as in the source.
  const chatId = String(metaData.chat_id ?? '');
  if (providerForTurn === 'groq') {
    runtimeSystemPrompt = injectGroqToolUsePolicy(
      runtimeSystemPrompt,
      channel,
      enabledFunctions
    ) as string;
    console.log('[LLM] Applied Groq tool-use policy in system prompt');
  }

  const msg: BedrockMessage[] = inputText
    ? buildMessage(chatHistory, inputText, metaData)
    : [...chatHistory];

  const initialHistoryLength = chatHistory.length;

  let stopReason: string | null = null;
  let answer = '';
  let usedToolCallInTurn = false;
  let toolIterationCount = 0;
  // 0 disables the guard entirely; set above 0 only for a hard cap.
  const groqMaxToolIterations = envInt('GROQ_MAX_TOOL_ITERATIONS', 0);

  // The source writes `while stop_reason != 'end_turn'`, but that condition never actually ends the
  // loop: the end_turn branch always breaks first, an unexpected stop reason returns, and the queue
  // drains reset stop_reason and continue. Every exit is a break or a return, so this is the honest
  // shape — and the type checker agrees, since it can prove the condition is always true on re-entry.
  for (;;) {
    if (
      providerForTurn === 'groq' &&
      groqMaxToolIterations > 0 &&
      toolIterationCount >= groqMaxToolIterations
    ) {
      console.warn(
        `[LLM] Groq loop guard triggered after ${toolIterationCount} iterations. ` +
          'Ending turn to prevent retry storm.'
      );
      answer = 'Done';
      msg.push({
        role: 'assistant',
        content: [{ text: 'Done' }],
      } as unknown as BedrockMessage);
      break;
    }

    toolIterationCount += 1;
    const startTime = Date.now();

    let result;
    try {
      result = await generateText(
        runtimeSystemPrompt,
        msg,
        enabledFunctions,
        metaData
      );
    } catch (e) {
      console.error(`[LLM] generate_text failed mid-turn: ${e}`);
      // The side effects of earlier iterations already HAPPENED — an email sent, a call placed. Persist
      // their record before the error propagates, or the conversation silently loses them.
      try {
        const partialEntries = msg.slice(initialHistoryLength);
        if (chatId && partialEntries.length > 0) {
          await addMessagesToChat(chatId, partialEntries);
          console.warn(
            `[LLM] Persisted ${partialEntries.length} partial chat entries for chat ${chatId} ` +
              'before re-raising generate_text error.'
          );
        }
      } catch (persistErr) {
        console.error(
          `[LLM] Failed to persist partial chat entries after generate_text error: ${persistErr}`
        );
      }
      throw e;
    }

    const {
      stopReason: rawStop,
      toolsRequested,
      payload,
      tokenUsage: usage,
    } = result;
    stopReason = rawStop;
    console.log(`[LLM] Stop reason: ${stopReason}`);

    sessionUsage.tokens.input += usage?.input_tokens ?? 0;
    sessionUsage.tokens.output += usage?.output_tokens ?? 0;

    // DRAIN 1 — a message that arrived while the model was thinking. Re-open the turn rather than
    // reply to a stale view of the conversation.
    const queuedMessages = (await getRapidQueue(chatId)) as QueuedMessage[];
    console.log(
      `[LLM] Found ${queuedMessages.length} queued messages for chat ${chatId}`
    );
    if (queuedMessages.length > 0) {
      foldQueuedMessages(msg, queuedMessages, true);
      await clearRapidQueue(chatId);
      console.log(`[LLM] Cleared rapid message queue for chat ${chatId}`);
      stopReason = null;
      continue;
    }

    if (stopReason === 'end_turn') {
      console.log('[LLM] The LLM ended turn and this is the answer');
      const blocks = ((payload as { content?: unknown })?.content ??
        []) as Array<Record<string, unknown>>;
      answer = blocks
        .map((a) => (a?.text as string) ?? '\n')
        .join('')
        .trim();

      // DRAIN 2 — the race fix. A message that landed between DRAIN 1 and here would otherwise be
      // answered only on the next turn, or never. No assistant pop: this one IS the finished answer.
      const lateQueued = (await getRapidQueue(chatId)) as QueuedMessage[];
      if (lateQueued.length > 0) {
        console.log(
          `[LLM] Found ${lateQueued.length} queued messages at end_turn for chat ${chatId}; continuing turn.`
        );
        foldQueuedMessages(msg, lateQueued, false);
        await clearRapidQueue(chatId);
        stopReason = null;
        continue;
      }

      await logLlmUsage({
        agent_id: agentId ?? '',
        chat_id: chatId,
        action: 'response_generation',
        processing_time_ms: Date.now() - startTime,
        system_prompt: runtimeSystemPrompt,
        chat_history: msg,
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        cache_write_input_tokens: usage?.cache_write_input_tokens ?? 0,
        model_version: String(metaData.assigned_model ?? 'unknown'),
        channel,
      });

      // After tool execution the terminal assistant text is persisted as "Done" — the Bedrock chat
      // pattern the rest of the stack expects. Without a tool call, the model's own message is kept.
      if (usedToolCallInTurn) {
        msg.push({
          role: 'assistant',
          content: [{ text: 'Done' }],
        } as unknown as BedrockMessage);
      } else if (
        payload &&
        typeof payload === 'object' &&
        (payload as { role?: string }).role === 'assistant'
      ) {
        msg.push(payload as BedrockMessage);
      } else {
        msg.push({
          role: 'assistant',
          content: [{ text: answer }],
        } as unknown as BedrockMessage);
      }
      break;
    }

    if (stopReason === 'tool_use') {
      usedToolCallInTurn = true;
      // Where this iteration's tool results begin — the window the short-circuit scan reads.
      const iterStart = msg.length;

      for (const content of toolsRequested ?? []) {
        const toolUse = (content as Record<string, unknown>)?.toolUse as
          | Record<string, unknown>
          | undefined;
        if (!toolUse) continue;

        const toolUseId = String(toolUse.toolUseId ?? '');
        const toolUseName = String(toolUse.name ?? '');
        const toolUseInput = (toolUse.input ?? {}) as Record<string, unknown>;
        console.log(`[LLM] Tool use - ID: ${toolUseId}, Name: ${toolUseName}`);

        const isOutboundTool = OUTBOUND_MESSAGE_TOOL_NAMES.has(toolUseName);
        sessionUsage.tools[toolUseName] =
          (sessionUsage.tools[toolUseName] ?? 0) + 1;

        const handler = TOOL_HANDLERS[toolUseName];
        let message: BedrockMessage | null = null;

        if (handler) {
          message = await handler({
            toolUseId,
            input: toolUseInput,
            accountId,
            attendeeId,
            chatId,
            metaData,
          });

          // The inbox transformer reads tool-call docs in isolation, so the send outcome has to be
          // stamped onto the toolUse INPUT before the result is appended. Must run against `msg`
          // while the assistant turn holding this toolUseId is still the latest one.
          if (toolUseName === 'send_email') {
            stampEmailOutcomeOnToolCall(msg, toolUseId, message);
          }

          appendToolResultMessage(msg, message);

          // Phase 9: `mark_prospect_lost` and `update_prospect` mirror the new stage to HubSpot here.
          // Best-effort and non-blocking in the source, so its absence changes nothing else.
        } else {
          // The source's own fallthrough when nothing matched the chain. An inbound tool leaked in by
          // an agent config, or one the model invented, lands here — one error result, turn continues.
          console.warn(
            `[LLM] Unknown or unhandled tool requested: ${toolUseName}`
          );
          message = buildToolResultMessage(toolUseId, {
            jsonPayload: {
              status: 'error',
              message: `Tool '${toolUseName}' is not implemented by this runtime.`,
            },
            status: 'error',
          });
          appendToolResultMessage(msg, message);
        }

        if (providerForTurn === 'groq' && isOutboundTool) {
          const [toolStatus, toolMessage] =
            extractToolStatusAndMessage(message);
          if (toolStatus === 'error') {
            console.warn(
              `[LLM] Outbound tool error detected (${toolUseName}): ` +
                `${toolMessage ? toolMessage.slice(0, 120) : 'unknown'}`
            );
          }
        }

        await logLlmUsage({
          agent_id: agentId ?? '',
          chat_id: chatId,
          action: toolUseName,
          processing_time_ms: Date.now() - startTime,
          system_prompt: runtimeSystemPrompt,
          // History BEFORE this tool's response, so the log shows the model's view when it called.
          chat_history: msg.slice(0, -1),
          tool_call_params: toolUseInput,
          tool_call_response: message as unknown as Record<string, unknown>,
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          total_tokens: usage?.total_tokens ?? 0,
          cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
          cache_write_input_tokens: usage?.cache_write_input_tokens ?? 0,
          model_version: String(metaData.assigned_model ?? 'unknown'),
          channel,
        });
      }

      // SHORT-CIRCUIT — see the module note. Only on an @ai-trigger turn, and only when every tool in
      // this iteration was gated BY DESIGN: a genuine failure keeps the loop going so the model reacts.
      if (metaData.is_admin_trigger && terminalBlockShortcircuitEnabled()) {
        try {
          if (turnIsByDesignGated(msg.slice(iterStart))) {
            console.log(
              '[LLM] By-design gate on @ai turn — ending turn without another LLM round-trip.'
            );
            answer = 'Done';
            msg.push({
              role: 'assistant',
              content: [{ text: 'Done' }],
            } as unknown as BedrockMessage);
            break;
          }
        } catch (e) {
          console.warn(`[LLM] terminal-block short-circuit skipped: ${e}`);
        }
      }
    } else {
      // Preserved: a bare return, so the caller sees `undefined` rather than a result tuple.
      console.warn(`[LLM] Unexpected stop reason: ${stopReason}`);
      return undefined;
    }
  }

  console.log(`[LLM] Final answer: ${answer.slice(0, 100)}...`);

  const newEntries = msg.slice(initialHistoryLength);
  console.log(`[LLM] Returning ${newEntries.length} new chat history entries`);
  return [newEntries, sessionUsage];
}

/** Exposed for tests: the dispatch table's shape without invoking anything. */
export const __testing = { TOOL_HANDLERS, BACKEND_GUARDRAILS_HEADER };
