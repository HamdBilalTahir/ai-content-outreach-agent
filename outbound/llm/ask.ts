/**
 * The outbound model layer — `generateText`, and the routing behind it.
 *
 * Three providers, ONE wire format. Bedrock Converse shape is canonical: Groq and direct-Anthropic
 * requests are converted out of it and their responses converted back into it. That is why the rest of
 * the codebase only ever deals in Bedrock-shaped messages, and why switching provider changes nothing
 * downstream.
 *
 * ## Routing, in order
 *
 *  1. An explicit `meta_data.llm_provider` wins.
 *  2. A `groq/`-prefixed, known-Groq, or `openai/`/`moonshotai/`-prefixed model routes to Groq — and is
 *     FORCED to the single allowed Groq model, with a warning. This deployment permits exactly one, for
 *     tool-call reliability, so an unexpected Groq model is corrected rather than attempted.
 *  3. A known Bedrock prefix routes to Bedrock.
 *  4. Anything else containing `/` routes to Groq (it cannot be a Bedrock id).
 *  5. Otherwise Bedrock.
 *
 * Then the global `LLM_PROVIDER=anthropic` switch may reroute a Bedrock-bound *Claude* model to the
 * direct Anthropic API. Non-Claude Bedrock models and Groq are unaffected.
 *
 * ## The empty-text-block sanitizer is not optional
 *
 * Bedrock Converse rejects a text block whose text is empty — "text content blocks must be non-empty" —
 * and an empty block most often rides along with a `toolUse` the model emitted, or lands in stored
 * history. So the FULL history is scrubbed before every converse call, not just the new message: a
 * single empty block anywhere in a long history fails the whole request. A message left with no blocks
 * gets a minimal placeholder, so the message and the role alternation both survive.
 *
 * ## Determinism
 *
 * Temperature is pinned to 0 on every path. The Bedrock path re-asserts it even though the shared
 * inference config already sets it, because a caller-supplied config could otherwise change it.
 */

import { DateTime } from 'luxon';

import {
  ANTHROPIC_FALLBACK_MODEL,
  anthropicEnabled,
  toAnthropicModelId,
} from './provider';
import {
  getDefaultTools,
  getToolsForEnabledFunctions,
  type ToolSpec,
} from './toolRegistry';
import { CREDS, awsRegion, envStr, requireEnv } from '../config';
import type { BedrockContentBlock, BedrockMessage } from '../types';

/** The fallback when no agent configuration supplies a model. */
export const DEFAULT_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** The single Groq model this deployment permits. */
export const GROQ_OPENAI_OSS_120_MODEL = 'openai/gpt-oss-120b';

/** The Haiku id the Bedrock path falls back to when the primary model errors. */
const BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Readable aliases so a Firestore or UI configuration can carry a friendly name.
 *
 * Every legacy alias routes to the one allowed model, deliberately: they exist so an older stored
 * configuration keeps working rather than to offer a choice.
 */
const GROQ_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'openai/gpt-oss-120b': GROQ_OPENAI_OSS_120_MODEL,
  'openai/gpt-oss-120': GROQ_OPENAI_OSS_120_MODEL,
  'openai-oss-120': GROQ_OPENAI_OSS_120_MODEL,
  'openai oss 120': GROQ_OPENAI_OSS_120_MODEL,
  'open ai oss 120': GROQ_OPENAI_OSS_120_MODEL,
  'oss-120': GROQ_OPENAI_OSS_120_MODEL,
  'gpt-oss-120': GROQ_OPENAI_OSS_120_MODEL,
  'gpt oss 120': GROQ_OPENAI_OSS_120_MODEL,
  kimi2: GROQ_OPENAI_OSS_120_MODEL,
  'kimi-2': GROQ_OPENAI_OSS_120_MODEL,
  'kimi 2': GROQ_OPENAI_OSS_120_MODEL,
  'moonshotai/kimi-k2-instruct-0905': GROQ_OPENAI_OSS_120_MODEL,
  'moonshot/kimi-k2-instruct-0905': GROQ_OPENAI_OSS_120_MODEL,
  'moonshot kimi 2': GROQ_OPENAI_OSS_120_MODEL,
};

const SUPPORTED_GROQ_MODELS: ReadonlySet<string> = new Set([
  GROQ_OPENAI_OSS_120_MODEL,
]);

const BEDROCK_MODEL_PREFIXES = [
  'us.',
  'eu.',
  'apac.',
  'anthropic.',
  'amazon.',
  'meta.',
  'ai21.',
  'cohere.',
  'mistral.',
  'deepseek.',
] as const;

/** Shared inference config. Temperature 0 for determinism across providers. */
const INFERENCE_CONFIG = { temperature: 0, maxTokens: 2048 } as const;

/** A company whose agents default to Sonnet when no model is explicitly assigned. */
const SONNET_COMPANY_IDS: ReadonlySet<string> = new Set(['248']);

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
}

export interface GenerateMeta {
  llm_provider?: string;
  assigned_model?: string;
  company_id?: string | number;
  agent_id?: string;
  [k: string]: unknown;
}

/**
 * The turn result. `stopReason` drives the caller's loop: `tool_use` means `toolsRequested` is
 * populated and `payload` is the MUTATED message list with the assistant turn appended; anything else
 * means `payload` is the single normalized output message.
 */
export interface GenerateResult {
  stopReason: string;
  toolsRequested: BedrockContentBlock[];
  payload: BedrockMessage[] | BedrockMessage;
  tokenUsage: TokenUsage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the transient `type` field from `toolUse` blocks.
 *
 * Bedrock may RETURN `type` on a tool use but REJECTS it on a subsequent request, so a stored message
 * replayed as history would fail. Cleaning at the boundary is what makes a response safe to persist and
 * reuse.
 */
export function cleanBedrockResponse(message: unknown): BedrockMessage {
  if (typeof message !== 'object' || message === null) {
    return message as BedrockMessage;
  }
  const m = { ...(message as Record<string, unknown>) };
  if (Array.isArray(m.content)) {
    m.content = m.content.map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const it = { ...(item as Record<string, unknown>) };
      if (typeof it.toolUse === 'object' && it.toolUse !== null) {
        const tu = { ...(it.toolUse as Record<string, unknown>) };
        delete tu.type;
        it.toolUse = tu;
      }
      return it;
    });
  }
  return m as unknown as BedrockMessage;
}

/** True for a pure `{text}` block whose text is empty or whitespace-only. */
function isEmptyTextBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as Record<string, unknown>;
  // A tool block is never an empty-text block.
  if ('toolUse' in b || 'toolResult' in b || 'toolUseId' in b) return false;
  if (!('text' in b)) return false;
  return !String(b.text ?? '').trim();
}

/**
 * Strip empty text blocks IN PLACE across the whole history, before every converse call.
 *
 * Mutates each content list in place rather than rebuilding it, which preserves list identity — the
 * caller's append-and-return contract depends on that. A message left with nothing gets a placeholder
 * so the role alternation Bedrock requires is not broken by the removal.
 */
export function sanitizeBedrockMessages(
  messages: BedrockMessage[] | null | undefined
): void {
  for (const message of messages ?? []) {
    if (typeof message !== 'object' || message === null) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const kept = content.filter((b) => !isEmptyTextBlock(b));
    // Compare the FILTER result against the original, before substituting the placeholder. Comparing
    // after substitution silently misses the single-empty-block case, where one block is replaced by
    // one placeholder and the lengths match.
    if (kept.length === content.length) continue;
    const replacement = kept.length === 0 ? [{ text: '(no content)' }] : kept;
    content.splice(0, content.length, ...replacement);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize an alias so a configuration can carry a readable name. */
export function normalizeModelAlias(
  modelId: string | null | undefined
): string | null {
  if (!modelId) return null;
  const cleaned = String(modelId).trim();
  const lowered = cleaned.toLowerCase();

  if (lowered.startsWith('groq/')) {
    const raw = cleaned.slice(cleaned.indexOf('/') + 1).trim();
    return GROQ_MODEL_ALIASES[raw.toLowerCase()] ?? raw;
  }
  return GROQ_MODEL_ALIASES[lowered] ?? cleaned;
}

/** Force any Groq request onto the one allowed model, warning when it differs. */
function forceAllowedGroqModel(resolved: string | null): string {
  if (resolved && resolved !== GROQ_OPENAI_OSS_120_MODEL) {
    console.warn(
      `Groq model '${resolved}' is not allowed in this deployment. ` +
        `Forcing '${GROQ_OPENAI_OSS_120_MODEL}'.`
    );
  }
  return GROQ_OPENAI_OSS_120_MODEL;
}

/** Resolve the provider and the concrete model id. See the module docstring for the order. */
export function resolveProviderAndModel(
  modelId: string | null | undefined,
  metaData?: GenerateMeta | null
): ['groq' | 'bedrock', string] {
  const explicitProvider = String(metaData?.llm_provider ?? '')
    .trim()
    .toLowerCase();
  const resolvedModel = modelId || DEFAULT_MODEL;
  const loweredModel = resolvedModel.toLowerCase();

  // `ggoq` is a typo the source tolerates; kept so an existing misconfiguration keeps working.
  if (explicitProvider === 'groq' || explicitProvider === 'ggoq') {
    if (!modelId) return ['groq', GROQ_OPENAI_OSS_120_MODEL];
    if (loweredModel.startsWith('groq/')) {
      return [
        'groq',
        forceAllowedGroqModel(
          normalizeModelAlias(
            resolvedModel.slice(resolvedModel.indexOf('/') + 1)
          )
        ),
      ];
    }
    return ['groq', forceAllowedGroqModel(normalizeModelAlias(resolvedModel))];
  }

  if (explicitProvider === 'bedrock') return ['bedrock', resolvedModel];

  if (loweredModel.startsWith('groq/')) {
    return ['groq', GROQ_OPENAI_OSS_120_MODEL];
  }
  if (SUPPORTED_GROQ_MODELS.has(loweredModel)) {
    return ['groq', GROQ_OPENAI_OSS_120_MODEL];
  }
  if (
    loweredModel.startsWith('openai/') ||
    loweredModel.startsWith('moonshotai/')
  ) {
    return ['groq', GROQ_OPENAI_OSS_120_MODEL];
  }
  if (BEDROCK_MODEL_PREFIXES.some((p) => resolvedModel.startsWith(p))) {
    return ['bedrock', resolvedModel];
  }
  if (resolvedModel.includes('/')) {
    console.warn(
      `Model '${resolvedModel}' is not a known Bedrock id and contains '/'. ` +
        `Routing to Groq with fixed model '${GROQ_OPENAI_OSS_120_MODEL}'.`
    );
    return ['groq', GROQ_OPENAI_OSS_120_MODEL];
  }
  return ['bedrock', resolvedModel];
}

/** Select the model for this turn: an assigned model, then a company default, then the fallback. */
export function selectModel(metaData?: GenerateMeta | null): string {
  const assigned = metaData?.assigned_model;
  const companyId = String(metaData?.company_id ?? '');
  const agentLabel = metaData?.agent_id ?? 'unknown';

  if (assigned) {
    const selected = normalizeModelAlias(assigned) ?? DEFAULT_MODEL;
    console.log(`Using assigned model: ${selected} for agent: ${agentLabel}`);
    return selected;
  }
  if (SONNET_COMPANY_IDS.has(companyId)) {
    const selected = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
    console.log(
      `Company ${companyId} default override: using Sonnet for agent: ${agentLabel}`
    );
    return selected;
  }
  console.warn(
    `No assigned model in meta_data for agent ${agentLabel}, using DEFAULT_MODEL: ${DEFAULT_MODEL}`
  );
  return DEFAULT_MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bedrock
// ─────────────────────────────────────────────────────────────────────────────

function usageFrom(raw: Record<string, unknown> | undefined): TokenUsage {
  const u = (raw ?? {}) as Record<string, number | undefined>;
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    total_tokens: u.totalTokens ?? 0,
    cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
    cache_write_input_tokens: u.cacheWriteInputTokens ?? 0,
  };
}

/** Lazily constructed so importing this module never requires AWS credentials. */
let bedrockClient: unknown = null;

async function getBedrockClient(): Promise<{
  send: (cmd: unknown) => Promise<Record<string, unknown>>;
}> {
  if (bedrockClient === null) {
    const { BedrockRuntimeClient } =
      await import('@aws-sdk/client-bedrock-runtime');
    const creds = requireEnv('bedrock', CREDS.bedrock);
    bedrockClient = new BedrockRuntimeClient({
      region: awsRegion(),
      credentials: {
        accessKeyId: creds.AWS_ACCESS_KEY,
        secretAccessKey: creds.AWS_SECRET_KEY,
      },
      maxAttempts: 2, // mirrors the source's reduced retry budget
    });
  }
  return bedrockClient as {
    send: (cmd: unknown) => Promise<Record<string, unknown>>;
  };
}

/**
 * The Bedrock Converse path.
 *
 * Retries ONCE with Haiku when the primary model errors, then gives up — a second fallback would just
 * delay a real failure. When already on Haiku it re-throws immediately rather than retrying the same
 * model.
 */
async function generateWithBedrock(
  messages: BedrockMessage[],
  systemPrompt: Array<Record<string, unknown>>,
  tools: ToolSpec[],
  modelId: string
): Promise<GenerateResult> {
  const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = await getBedrockClient();

  // Bedrock rejects empty text blocks — scrub the FULL history, including tool-use messages appended
  // by prior loop iterations, before every call.
  sanitizeBedrockMessages(messages);

  const build = (id: string) =>
    new ConverseCommand({
      modelId: id,
      messages: messages as never,
      system: systemPrompt as never,
      toolConfig: { tools: tools as never },
      inferenceConfig: { ...INFERENCE_CONFIG },
    });

  let response: Record<string, unknown>;
  try {
    response = await client.send(build(modelId));
  } catch (e) {
    console.warn(`Bedrock API error: ${e}`);
    if (modelId !== BEDROCK_HAIKU_MODEL) {
      console.log(`Falling back to Haiku 4.5 from ${modelId}`);
      response = await client.send(build(BEDROCK_HAIKU_MODEL));
      console.log('✓ Haiku 4.5 fallback succeeded');
    } else {
      console.error('Cannot fallback (already using Haiku)');
      throw e;
    }
  }

  const outputMessage =
    ((response.output as Record<string, unknown> | undefined)?.message as
      | Record<string, unknown>
      | undefined) ?? {};
  const stopReason = String(response.stopReason ?? '');
  const tokenUsage = usageFrom(response.usage as Record<string, unknown>);

  const cleaned = cleanBedrockResponse(outputMessage);

  if (stopReason === 'tool_use') {
    const toolsRequested = (cleaned.content ?? []).filter(
      (b) => typeof b === 'object' && b !== null && 'toolUse' in b
    );
    // Append to the caller's list and return it — the loop contract.
    messages.push(cleaned);
    return { stopReason, toolsRequested, payload: messages, tokenUsage };
  }

  return { stopReason, toolsRequested: [], payload: cleaned, tokenUsage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct Anthropic
// ─────────────────────────────────────────────────────────────────────────────

/** Bedrock tool specs → Anthropic tool definitions. */
export function bedrockToolsToAnthropic(
  tools: readonly ToolSpec[]
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.toolSpec.name,
    description: t.toolSpec.description,
    input_schema: t.toolSpec.inputSchema.json,
  }));
}

/** Bedrock messages → Anthropic messages. */
export function bedrockMessagesToAnthropic(
  messages: readonly BedrockMessage[]
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    const content: Array<Record<string, unknown>> = [];
    for (const raw of m.content ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const b = raw as Record<string, unknown>;

      if (typeof b.text === 'string') {
        if (b.text.trim()) content.push({ type: 'text', text: b.text });
        continue;
      }
      if (typeof b.toolUse === 'object' && b.toolUse !== null) {
        const tu = b.toolUse as Record<string, unknown>;
        content.push({
          type: 'tool_use',
          id: String(tu.toolUseId ?? ''),
          name: String(tu.name ?? ''),
          input: tu.input ?? {},
        });
        continue;
      }
      if (typeof b.toolResult === 'object' && b.toolResult !== null) {
        const tr = b.toolResult as Record<string, unknown>;
        const blocks = (tr.content ?? []) as Array<Record<string, unknown>>;
        // Anthropic takes tool results as a string, so a json payload is serialized.
        const parts: string[] = [];
        for (const c of blocks) {
          if (typeof c?.text === 'string') parts.push(c.text);
          else if (c?.json !== undefined) parts.push(JSON.stringify(c.json));
        }
        content.push({
          type: 'tool_result',
          tool_use_id: String(tr.toolUseId ?? ''),
          content: parts.join('\n'),
        });
        continue;
      }
    }
    if (content.length) out.push({ role: m.role, content });
  }
  return out;
}

/** An Anthropic response → the canonical Bedrock shape. */
export function anthropicResponseToBedrock(
  response: Record<string, unknown>
): GenerateResult {
  const blocks = (response.content ?? []) as Array<Record<string, unknown>>;
  const content: BedrockContentBlock[] = [];
  const toolsRequested: BedrockContentBlock[] = [];

  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      content.push({ text: b.text } as BedrockContentBlock);
    } else if (b.type === 'tool_use') {
      const block = {
        toolUse: {
          toolUseId: String(b.id ?? ''),
          name: String(b.name ?? ''),
          input: b.input ?? {},
        },
      } as BedrockContentBlock;
      content.push(block);
      toolsRequested.push(block);
    }
  }

  const u = (response.usage ?? {}) as Record<string, number | undefined>;
  const tokenUsage: TokenUsage = {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_input_tokens: u.cache_creation_input_tokens ?? 0,
  };

  // Anthropic's `tool_use` stop reason maps to Bedrock's, so callers branch identically.
  const stopReason =
    response.stop_reason === 'tool_use'
      ? 'tool_use'
      : String(response.stop_reason ?? 'end_turn');

  return {
    stopReason,
    toolsRequested,
    payload: { role: 'assistant', content } as BedrockMessage,
    tokenUsage,
  };
}

let anthropicClient: unknown = null;

async function getAnthropicClient(): Promise<{
  messages: {
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}> {
  if (anthropicClient === null) {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default;
    const creds = requireEnv('anthropic', CREDS.anthropic);
    anthropicClient = new Anthropic({
      apiKey: creds.ANTHROPIC_API_KEY,
      maxRetries: 2, // mirrors the Bedrock client's reduced budget
    });
    console.log(
      '[LLM] Initialized direct Anthropic client (LLM_PROVIDER=anthropic)'
    );
  }
  return anthropicClient as {
    messages: {
      create: (
        args: Record<string, unknown>
      ) => Promise<Record<string, unknown>>;
    };
  };
}

/** The direct Anthropic path, falling back once to the current Haiku when a mapped model errors. */
async function generateWithAnthropic(
  systemPromptText: string,
  messages: BedrockMessage[],
  tools: ToolSpec[],
  modelId: string
): Promise<GenerateResult> {
  const client = await getAnthropicClient();
  const payload = {
    model: modelId,
    max_tokens: INFERENCE_CONFIG.maxTokens,
    temperature: INFERENCE_CONFIG.temperature,
    system: systemPromptText,
    messages: bedrockMessagesToAnthropic(messages),
    tools: bedrockToolsToAnthropic(tools),
  };

  let response: Record<string, unknown>;
  try {
    response = await client.messages.create(payload);
  } catch (e) {
    if (modelId !== ANTHROPIC_FALLBACK_MODEL) {
      console.warn(
        `[LLM] Anthropic model '${modelId}' failed (${e}) — falling back to ${ANTHROPIC_FALLBACK_MODEL}`
      );
      response = await client.messages.create({
        ...payload,
        model: ANTHROPIC_FALLBACK_MODEL,
      });
    } else {
      throw e;
    }
  }

  const result = anthropicResponseToBedrock(response);
  if (result.stopReason === 'tool_use') {
    // Match the Bedrock contract: append the assistant turn and return the list.
    messages.push(result.payload as BedrockMessage);
    return { ...result, payload: messages };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Groq
// ─────────────────────────────────────────────────────────────────────────────

/** Bedrock messages → Groq/OpenAI chat messages. */
export function bedrockMessagesToGroq(
  systemPromptText: string,
  messages: readonly BedrockMessage[]
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPromptText },
  ];

  for (const m of messages) {
    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolResults: Array<Record<string, unknown>> = [];

    for (const raw of m.content ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const b = raw as Record<string, unknown>;

      if (typeof b.text === 'string' && b.text.trim()) {
        textParts.push(b.text);
      } else if (typeof b.toolUse === 'object' && b.toolUse !== null) {
        const tu = b.toolUse as Record<string, unknown>;
        toolCalls.push({
          id: String(tu.toolUseId ?? ''),
          type: 'function',
          function: {
            name: String(tu.name ?? ''),
            arguments: JSON.stringify(tu.input ?? {}),
          },
        });
      } else if (typeof b.toolResult === 'object' && b.toolResult !== null) {
        const tr = b.toolResult as Record<string, unknown>;
        const blocks = (tr.content ?? []) as Array<Record<string, unknown>>;
        const parts: string[] = [];
        for (const c of blocks) {
          if (typeof c?.text === 'string') parts.push(c.text);
          else if (c?.json !== undefined) parts.push(JSON.stringify(c.json));
        }
        toolResults.push({
          role: 'tool',
          tool_call_id: String(tr.toolUseId ?? ''),
          content: parts.join('\n'),
        });
      }
    }

    // A tool result is its OWN message in the Groq/OpenAI format, not a block on a user message.
    if (toolResults.length) {
      out.push(...toolResults);
      continue;
    }
    if (textParts.length || toolCalls.length) {
      const msg: Record<string, unknown> = {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: textParts.join('\n'),
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

/** Bedrock tool specs → Groq/OpenAI function definitions. */
export function bedrockToolsToGroq(
  tools: readonly ToolSpec[]
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.toolSpec.name,
      description: t.toolSpec.description,
      parameters: t.toolSpec.inputSchema.json,
    },
  }));
}

/** Tolerate a Groq arguments payload arriving as a string or an object. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) {
    return raw as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A Groq response → the canonical Bedrock shape. */
export function groqResponseToBedrock(
  response: Record<string, unknown>
): GenerateResult {
  const choice = ((response.choices as unknown[]) ?? [])[0] as
    | Record<string, unknown>
    | undefined;
  const message = (choice?.message ?? {}) as Record<string, unknown>;

  const content: BedrockContentBlock[] = [];
  const toolsRequested: BedrockContentBlock[] = [];

  const text = String(message.content ?? '');
  if (text.trim()) content.push({ text } as BedrockContentBlock);

  for (const rawCall of (message.tool_calls as unknown[]) ?? []) {
    const call = rawCall as Record<string, unknown>;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const block = {
      toolUse: {
        toolUseId: String(call.id ?? ''),
        name: String(fn.name ?? ''),
        input: parseToolArguments(fn.arguments),
      },
    } as BedrockContentBlock;
    content.push(block);
    toolsRequested.push(block);
  }

  const u = (response.usage ?? {}) as Record<string, number | undefined>;
  const tokenUsage: TokenUsage = {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0,
  };

  const stopReason = toolsRequested.length ? 'tool_use' : 'end_turn';
  return {
    stopReason,
    toolsRequested,
    payload: { role: 'assistant', content } as BedrockMessage,
    tokenUsage,
  };
}

let groqClient: unknown = null;

async function getGroqClient(): Promise<{
  chat: {
    completions: {
      create: (
        args: Record<string, unknown>
      ) => Promise<Record<string, unknown>>;
    };
  };
}> {
  if (groqClient === null) {
    const mod = await import('groq-sdk');
    const Groq = mod.default;
    const creds = requireEnv('groq', CREDS.groq);
    groqClient = new Groq({ apiKey: creds.GROQ_API_KEY });
  }
  return groqClient as {
    chat: {
      completions: {
        create: (
          args: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      };
    };
  };
}

async function generateWithGroq(
  systemPromptText: string,
  messages: BedrockMessage[],
  tools: ToolSpec[],
  modelId: string
): Promise<GenerateResult> {
  const client = await getGroqClient();
  const response = await client.chat.completions.create({
    model: modelId,
    temperature: INFERENCE_CONFIG.temperature,
    max_tokens: INFERENCE_CONFIG.maxTokens,
    messages: bedrockMessagesToGroq(systemPromptText, messages),
    tools: bedrockToolsToGroq(tools),
  });

  const result = groqResponseToBedrock(response);
  if (result.stopReason === 'tool_use') {
    messages.push(result.payload as BedrockMessage);
    return { ...result, payload: messages };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// The entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a model response, preserving the Bedrock message shape whichever provider serves it.
 *
 * The system prompt carries a `cachePoint` so Bedrock can cache the prefix — the system prompt is the
 * largest and most stable part of every turn, so caching it is where the token saving is.
 */
export async function generateText(
  systemPromptText: string,
  messages: BedrockMessage[],
  enabledFunctions?: readonly string[] | null,
  metaData?: GenerateMeta | null
): Promise<GenerateResult> {
  const systemPrompt = [
    { text: systemPromptText },
    { cachePoint: { type: 'default' } },
  ];

  const tools = enabledFunctions?.length
    ? getToolsForEnabledFunctions(enabledFunctions)
    : getDefaultTools();

  const selectedModel = selectModel(metaData);
  const [provider, resolvedModel] = resolveProviderAndModel(
    selectedModel,
    metaData
  );

  if (provider === 'groq') {
    console.log(`Using Groq provider with model: ${resolvedModel}`);
    return generateWithGroq(systemPromptText, messages, tools, resolvedModel);
  }

  // The global switch reroutes only Bedrock-bound CLAUDE models; a non-Claude Bedrock model has no
  // Anthropic mapping and stays where it is.
  if (provider === 'bedrock' && anthropicEnabled()) {
    const anthropicModel = toAnthropicModelId(resolvedModel);
    if (anthropicModel) {
      console.log(
        `Using Anthropic provider with model: ${anthropicModel} (mapped from ${resolvedModel})`
      );
      return generateWithAnthropic(
        systemPromptText,
        messages,
        tools,
        anthropicModel
      );
    }
    console.warn(
      `LLM_PROVIDER=anthropic but '${resolvedModel}' has no Anthropic mapping; staying on Bedrock.`
    );
  }

  console.log(`Using Bedrock provider with model: ${resolvedModel}`);
  return generateWithBedrock(messages, systemPrompt, tools, resolvedModel);
}

/**
 * The concatenated text of a result — what the one-shot callers (intent checks, extraction, summaries)
 * actually want, rather than the full turn structure.
 */
export function textOf(result: GenerateResult | unknown): string {
  const payload =
    typeof result === 'object' && result !== null && 'payload' in result
      ? (result as GenerateResult).payload
      : result;
  const msgs = Array.isArray(payload) ? payload : [payload];
  const parts: string[] = [];
  for (const m of msgs) {
    for (const b of (m as BedrockMessage)?.content ?? []) {
      if (typeof b === 'object' && b !== null && 'text' in b) {
        const t = String((b as Record<string, unknown>).text ?? '');
        if (t) parts.push(t);
      }
    }
  }
  return parts.join('').trim();
}

/** Exposed for tests. */
export const __testing = {
  isEmptyTextBlock,
  forceAllowedGroqModel,
  INFERENCE_CONFIG,
  envStr,
  DateTime,
};
