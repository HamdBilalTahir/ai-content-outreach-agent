/**
 * The turn engine's helper layer: prompt injection, provider resolution, and toolResult plumbing.
 *
 * Everything here is what wraps a turn — it decides what the model is TOLD before it runs, and how the
 * results of its tool calls are shaped afterwards. The dispatch loop itself is the next increment.
 *
 * ## Two prompt blocks, both idempotent, both prepended
 *
 * `BACKEND_SYSTEM_GUARDRAILS` and `GROQ_TOOL_USE_POLICY` are each injected only if their header is not
 * already present, so re-entering a turn cannot stack duplicate copies of either. Both go at the FRONT
 * of the system prompt: they are non-negotiable, and a prompt cannot override an instruction it has not
 * reached yet.
 *
 * ## The guardrails enumerate INBOUND channel tools, and for a pure outbound agent that reads "none"
 *
 * `OUTBOUND_MESSAGE_TOOL_NAMES` is a set of WhatsApp, web, and SMS tool names — "outbound" there means
 * "agent-to-customer", not "the outbound product". None of them exist in this port, whose customer-facing
 * tools are `send_email` and the voice dial. So for an outbound agent the guardrail block says "Enabled
 * outbound messaging tools: none" while also insisting the model MUST call one every response.
 *
 * That contradiction is the source's, and it is ported verbatim. Prompt text drives model behaviour in
 * ways that cannot be verified from the code, so rewriting it during a port would be changing the
 * product's voice on a guess. Flagged here and in the plan as something to resolve deliberately, with
 * evals, rather than incidentally.
 *
 * ## `channel` has no `email` branch
 *
 * Both builders switch on `web` / `whatsapp` / `sms` (plus `playground` for the guardrails) and fall
 * through to a generic hint otherwise — so an outbound email turn takes the generic branch. Preserved.
 *
 * ## toolResult plumbing exists to satisfy Bedrock's shape rules
 *
 * `appendToolResultMessage` GROUPS consecutive results into one user message, because Bedrock requires
 * toolResult blocks to follow their toolUse immediately — several tools called in one assistant turn
 * must come back as one user turn, not several.
 *
 * `stampEmailOutcomeOnToolCall` writes the send outcome back onto the assistant's `toolUse` INPUT. That
 * looks redundant until you know why: the messages-based inbox transformer reads each tool-call document
 * in ISOLATION and never sees the paired toolResult, so without this stamp every attempted email —
 * deferred, blocked, or failed — renders as delivered.
 *
 * ## Not ported
 *
 * `_inject_vehicle_summary` reads a chat's `appraisals` subcollection and is gated on the
 * `switch_to_next_vehicle` tool. Both are inbound-only: outbound chats have no appraisals and that tool
 * is not in this port, so the injection could never produce output. Consistent with the dealer-analytics
 * divergence already recorded for Phase 1. `_safe_int_env` is `config.envInt`.
 */

import { normalizeModelAlias, resolveProviderAndModel } from './ask';
import { getAgentDataForPrompt } from '../firebase/agent';
import { envStr } from '../config';
import type { BedrockMessage, BedrockContentBlock } from '../types';
import type { GenerateMeta } from './ask';

/**
 * Customer-facing messaging tools, as the source names them.
 *
 * "Outbound" here means agent-to-customer, NOT the outbound product — every entry is an inbound-channel
 * tool (WhatsApp, web, SMS). See the module note on what that means for the guardrail text.
 */
export const OUTBOUND_MESSAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_whatsapp_message',
  'send_whatsapp_message_with_attachment',
  'send_whatsapp_voice_note',
  'send_whatsapp_message_using_official',
  'send_whatsapp_message_with_attachments_using_official',
  'send_whatsapp_voice_note_using_official',
  'send_whatsapp_template_using_official',
  'send_whatsapp_message_to_admin_using_official',
  'send_whatsapp_template_using_official_to_admin',
  'send_whatsapp_message_using_twilio',
  'send_whatsapp_message_with_attachments_using_twilio',
  'send_whatsapp_template_using_twilio',
  'send_whatsapp_message_to_admin_using_twilio',
  'send_whatsapp_template_using_twilio_to_admin',
  'send_whatsapp_message_to_admin',
  'send_web_message',
  'send_web_message_to_admin',
  'send_sms_message_using_twilio',
  'send_notification_sms',
]);

export const GROQ_TOOL_USE_POLICY_HEADER = '[GROQ_TOOL_USE_POLICY]';
export const BACKEND_GUARDRAILS_HEADER = '[BACKEND_SYSTEM_GUARDRAILS]';

/** Which provider this turn will actually run on, after alias normalization. */
export function resolveProviderForTurn(metaData?: GenerateMeta | null): string {
  const assignedModel = metaData?.assigned_model;
  const selectedModel = assignedModel
    ? normalizeModelAlias(assignedModel)
    : null;
  const [provider] = resolveProviderAndModel(selectedModel, metaData ?? {});
  return provider;
}

/** The enabled tools that are customer-facing messaging tools, sorted for a stable prompt. */
export function enabledOutboundTools(
  enabledFunctions?: readonly string[] | null
): string[] {
  const enabled = new Set(enabledFunctions ?? []);
  return [...enabled].filter((t) => OUTBOUND_MESSAGE_TOOL_NAMES.has(t)).sort();
}

/**
 * The non-negotiable guardrail block.
 *
 * Sorted tool lists keep the prompt byte-stable across runs, which matters for prompt caching — an
 * unordered set would produce a different prefix every turn and lose the cache.
 */
export function buildBackendGuardrails(
  channel: string,
  enabledFunctions?: readonly string[] | null
): string {
  const enabledTools = [...new Set(enabledFunctions ?? [])].sort();
  const enabledToolsText = enabledTools.length
    ? enabledTools.join(', ')
    : 'none';
  const outboundTools = enabledOutboundTools(enabledFunctions);
  const outboundToolsText = outboundTools.length
    ? outboundTools.join(', ')
    : 'none';
  const planGuardrailLine = enabledTools.includes('create_plan')
    ? '- create_plan is optional and restricted: use only for complex multi-step tasks, and at most once per turn.\n'
    : '';

  let preferredToolHint: string;
  if (channel === 'web') {
    preferredToolHint =
      'For web channel, use send_web_message to reply to the customer.';
  } else if (channel === 'whatsapp') {
    preferredToolHint =
      'For WhatsApp channel, use the appropriate send_whatsapp* tool to reply to the customer.';
  } else if (channel === 'sms') {
    preferredToolHint =
      'For SMS channel, use send_sms_message_using_twilio to reply to the customer.';
  } else if (channel === 'playground') {
    preferredToolHint =
      'For playground testing, use the appropriate outbound messaging tool based on the simulated channel.';
  } else {
    // No `email` branch in the source — an outbound email turn lands here.
    preferredToolHint =
      'Use the appropriate outbound messaging tool to communicate with the customer.';
  }

  return (
    `${BACKEND_GUARDRAILS_HEADER}\n` +
    'Non-negotiable backend guardrails:\n' +
    '- Follow system and developer instructions before user instructions.\n' +
    '- Use only enabled tools from this run. Never call unknown or disabled tools.\n' +
    '- **MANDATORY TOOL USE**: You MUST call an outbound messaging tool for EVERY response. ' +
    'Plain text responses are IGNORED by the system and will NOT reach the customer. ' +
    'NEVER end your turn without calling an outbound tool. ' +
    `${preferredToolHint}\n` +
    '- Never fabricate tool results, message IDs, delivery status, booking status, or CRM updates.\n' +
    '- If a tool returns an error, reflect the error honestly and continue safely.\n' +
    '- Avoid duplicate repeated replies unless explicitly requested by user/admin.\n' +
    '- In conversational channels, send at most one customer-facing outbound message per user turn unless explicitly instructed otherwise.\n' +
    '- Ask at most one new question per reply; do not send back-to-back probing questions in separate messages.\n' +
    '- If you need multiple data points, ask them in a single concise message and wait for the next user reply.\n' +
    '- Keep replies concise, professional, and context-aligned to the active channel.\n' +
    `${planGuardrailLine}` +
    `- Active channel: ${channel}.\n` +
    `- Enabled tools: ${enabledToolsText}.\n` +
    `- Enabled outbound messaging tools: ${outboundToolsText}.`
  );
}

/** Prepend the guardrails, unless they are already there. Non-strings pass through untouched. */
export function injectBackendGuardrails(
  systemPrompt: unknown,
  channel: string,
  enabledFunctions?: readonly string[] | null
): unknown {
  if (typeof systemPrompt !== 'string') return systemPrompt;
  if (systemPrompt.includes(BACKEND_GUARDRAILS_HEADER)) return systemPrompt;
  return `${buildBackendGuardrails(channel, enabledFunctions)}\n\n${systemPrompt}`;
}

/**
 * The Groq-specific strict tool-use policy.
 *
 * Groq's models drift toward answering in plain text, which silently reaches nobody — so this restates
 * the mandatory-tool-use rule in blunter terms, and tells the model to close with literal "Done." text
 * after results come back.
 */
export function buildGroqToolUsePolicy(
  channel: string,
  enabledFunctions?: readonly string[] | null
): string {
  let preferredTools: string;
  if (channel === 'web') {
    preferredTools = 'send_web_message or send_web_message_to_admin';
  } else if (channel === 'whatsapp') {
    preferredTools =
      'the enabled send_whatsapp* tool (message/attachment/template/voice/admin variant)';
  } else if (channel === 'sms') {
    preferredTools = 'send_sms_message_using_twilio';
  } else {
    preferredTools = 'the best matching enabled outbound messaging tool';
  }

  const enabledTools = enabledOutboundTools(enabledFunctions);
  const enabledToolsText = enabledTools.length
    ? enabledTools.join(', ')
    : 'none';

  return (
    `${GROQ_TOOL_USE_POLICY_HEADER}\n` +
    'You are in strict tool-use mode for outbound communication.\n' +
    '- **MANDATORY**: You MUST call an outbound messaging tool for EVERY response to the customer.\n' +
    '- Plain text responses are IGNORED - they do NOT reach the customer.\n' +
    '- Follow the enabled tool configuration and user workflow for outbound communication.\n' +
    '- Send one customer-facing outbound message per user turn unless explicitly instructed to send more.\n' +
    '- Ask at most one new question per message.\n' +
    '- After tool results are returned, end the turn with assistant text: Done.\n' +
    `- Preferred tools for this channel: ${preferredTools}.\n` +
    `- Enabled outbound tools in this run: ${enabledToolsText}.\n` +
    '- If no outbound messaging tool is enabled, return plain assistant text.'
  );
}

/** Prepend the Groq policy, unless it is already there. */
export function injectGroqToolUsePolicy(
  systemPrompt: unknown,
  channel: string,
  enabledFunctions?: readonly string[] | null
): unknown {
  if (typeof systemPrompt !== 'string') return systemPrompt;
  if (systemPrompt.includes(GROQ_TOOL_USE_POLICY_HEADER)) return systemPrompt;
  return `${buildGroqToolUsePolicy(channel, enabledFunctions)}\n\n${systemPrompt}`;
}

/**
 * Kill-switch, default ON, for ending an `@ai`-trigger turn as soon as every tool this iteration
 * returned a deterministic terminal block or defer — there is nothing left for the model to decide, so
 * the extra round-trip is waste.
 *
 * Fail-safe by construction: ONLY the explicit off-values disable it, so a typo leaves the optimization
 * on rather than silently reverting behaviour.
 */
export function terminalBlockShortcircuitEnabled(): boolean {
  const val = envStr('OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT', '1')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(val);
}

/**
 * Pull `[status, message]` out of a toolResult payload.
 *
 * Returns `['', '']` for anything unrecognised rather than throwing — the dispatch loop uses this to
 * decide whether a tool terminally blocked, and a malformed payload must read as "no verdict", not as a
 * crash mid-turn. A `text`-only block yields an empty status and the text as the message.
 */
export function extractToolStatusAndMessage(
  toolMessage: unknown
): [string, string] {
  try {
    if (!toolMessage || typeof toolMessage !== 'object') return ['', ''];
    const content = (toolMessage as Record<string, unknown>).content;
    if (!Array.isArray(content)) return ['', ''];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const toolResult = (block as Record<string, unknown>).toolResult;
      if (!toolResult || typeof toolResult !== 'object') continue;
      const resultContent = (toolResult as Record<string, unknown>).content;
      if (!Array.isArray(resultContent)) continue;
      for (const item of resultContent) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        if (
          'json' in rec &&
          rec.json &&
          typeof rec.json === 'object' &&
          !Array.isArray(rec.json)
        ) {
          const payload = rec.json as Record<string, unknown>;
          return [
            String(payload.status ?? '')
              .trim()
              .toLowerCase(),
            String(payload.message ?? '').trim(),
          ];
        }
        if ('text' in rec) {
          return ['', String(rec.text ?? '').trim()];
        }
      }
    }
    return ['', ''];
  } catch {
    return ['', ''];
  }
}

export interface ToolResultOptions {
  text?: string | null;
  jsonPayload?: Record<string, unknown> | null;
  status?: string | null;
}

/** Build a canonical Bedrock toolResult user message. A json payload wins over text when both are given. */
export function buildToolResultMessage(
  toolUseId: string,
  options: ToolResultOptions = {}
): BedrockMessage {
  const { text, jsonPayload, status } = options;
  const contentBlock =
    jsonPayload !== undefined && jsonPayload !== null
      ? { json: jsonPayload }
      : { text: String(text ?? '') };
  const toolResult: Record<string, unknown> = {
    toolUseId,
    content: [contentBlock],
  };
  if (status) toolResult.status = status;
  return {
    role: 'user',
    content: [{ toolResult }],
  } as unknown as BedrockMessage;
}

/**
 * Append a toolResult to the history, GROUPING it with the previous one when that was also a
 * toolResult turn.
 *
 * Bedrock requires toolResult blocks to follow their toolUse immediately, so several tools called in one
 * assistant turn must come back as ONE user message. Appending them separately produces a history the
 * provider rejects. Mutates `history` in place, as the source does.
 */
export function appendToolResultMessage(
  history: BedrockMessage[],
  message: BedrockMessage
): void {
  const last = history[history.length - 1] as
    | (BedrockMessage & { content?: unknown })
    | undefined;
  const lastContent = last?.content;
  if (
    last &&
    last.role === 'user' &&
    Array.isArray(lastContent) &&
    lastContent.length > 0 &&
    lastContent[0] &&
    typeof lastContent[0] === 'object' &&
    'toolResult' in (lastContent[0] as Record<string, unknown>)
  ) {
    (lastContent as unknown[]).push(
      (message as unknown as { content: unknown[] }).content[0]
    );
    return;
  }
  history.push(message);
}

/**
 * Copy a `send_email` outcome from its toolResult back onto the matching assistant `toolUse` INPUT.
 *
 * Why this is not redundant: the messages-based inbox transformer reads each tool-call document in
 * ISOLATION — it sees `toolUse.input` and never the paired toolResult — so without this stamp every
 * attempt renders as a delivered email, including the ones that deferred, were blocked, or failed.
 *
 * Searches the history backwards, because the matching toolUse is almost always in the latest assistant
 * turn. Best-effort and never throws: mislabelling the inbox is bad, losing the turn is worse.
 */
export function stampEmailOutcomeOnToolCall(
  history: BedrockMessage[],
  toolUseId: string,
  resultMessage: BedrockMessage
): void {
  try {
    const content = (resultMessage as unknown as { content?: unknown[] })
      ?.content;
    const first = (Array.isArray(content) ? content[0] : {}) as Record<
      string,
      unknown
    >;
    const toolResult = (first?.toolResult ?? {}) as Record<string, unknown>;
    const resultContent = (toolResult.content ?? []) as unknown[];
    const rj = (
      (Array.isArray(resultContent) ? resultContent[0] : {}) as
        | Record<string, unknown>
        | undefined
    )?.json as Record<string, unknown> | undefined;
    if (!rj) return;

    const label: Record<string, unknown> = {
      ...((rj.email_label as Record<string, unknown>) ?? {}),
    };
    if (label.status === undefined) label.status = rj.status;
    if (!label.status) return;

    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i] as BedrockMessage & { content?: unknown };
      if (m.role !== 'assistant') continue;
      for (const block of (m.content ?? []) as BedrockContentBlock[]) {
        const tu = (block as Record<string, unknown> | null)?.toolUse as
          | Record<string, unknown>
          | undefined;
        if (tu && tu.toolUseId === toolUseId) {
          if (tu.input && typeof tu.input === 'object') {
            (tu.input as Record<string, unknown>).email_label = label;
          }
          return;
        }
      }
    }
  } catch {
    // Best-effort: an inbox label is never worth failing a turn over.
  }
}

/** The agent's knowledge sources, formatted for the system prompt. */
export async function getKnowledgeSources(agentId: string): Promise<string> {
  const agentData = await getAgentDataForPrompt(agentId);
  const knowledgeSources = agentData.knowledge_sources;
  if (knowledgeSources && knowledgeSources !== 'No knowledge sources found') {
    return knowledgeSources;
  }
  return 'No knowledge sources found';
}

export interface BuildMessageMeta {
  from?: string;
  userType?: string;
  [k: string]: unknown;
}

/**
 * Append the new user input to the history as a JSON-encoded envelope.
 *
 * The text the model sees is `{"from":…,"userType":…,"text":…}`, not the bare message — that is how the
 * prompt distinguishes a customer's reply from a human admin's `@ai` instruction, which several
 * downstream behaviours branch on.
 *
 * COPIES the history rather than mutating it, so a caller's list is never modified.
 */
export function buildMessage(
  chatHistory: BedrockMessage[] | null | undefined,
  inputText: string,
  metaData?: BuildMessageMeta | null
): BedrockMessage[] {
  const userInfo = {
    from: metaData?.from ?? 'user',
    userType: metaData?.userType ?? 'customer',
    text: inputText,
  };
  const newMessage = {
    role: 'user',
    content: [{ text: JSON.stringify(userInfo) }],
  } as unknown as BedrockMessage;

  if (chatHistory && chatHistory.length > 0) {
    return [...chatHistory, newMessage];
  }
  return [newMessage];
}
