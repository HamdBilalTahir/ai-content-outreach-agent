/**
 * ElevenLabs conversational-agent provisioning: create, update, read, and knowledge-base sync.
 *
 * This is the write side of the voice stack. `elevenlabs.ts` patches a webhook onto an agent someone
 * else built; this module builds the whole agent — prompt, voice, turn-taking, system tools, knowledge
 * bases — from the Firestore `voice_settings` document.
 *
 * ## `voiceSettings` is read in BOTH snake_case and camelCase, and the two fallbacks are not equivalent
 *
 * Every field is looked up twice because Firestore holds a mix of both conventions. The important part
 * is that the source uses two DIFFERENT fallback mechanisms, and they disagree about zero:
 *
 *  - `a or b(default)` — Python's `or`, so a **falsy** value (`0`, `""`, `False`) falls through to the
 *    default. `optimizeStreamingLatency`, `turnTimeout`, `maxConversationDuration`, and
 *    `silenceEndCallTimeout` all work this way: a configured `0` becomes the default, NOT zero.
 *  - `a.get(key, default)` — a dict default, which only applies when the key is ABSENT. `stability`,
 *    `similarity`, and `speed` work this way: a configured `0` stays zero.
 *
 * So `stability: 0` is honoured and `turn_timeout: 0` is silently replaced by 7. That is surprising, it
 * is load-bearing (these values reach the provider verbatim), and normalizing it would change how every
 * existing agent behaves. Ported exactly, with a test for each side.
 *
 * ## The prompt gets two template blocks injected if they are missing
 *
 * `{{local_scope}}` carries the per-call context, `{{skills}}` the voice-labelled skills. Both are
 * prepended (or, for skills, spliced in after `local_scope`'s `{% endif %}`) when absent, and both
 * always get a `"Not Available"` placeholder so the `{% if %}` block still renders when no value is
 * supplied at call time.
 *
 * **The module docstring in the source is stale on exactly this point.** It claims the `{% if skills %}`
 * block is NOT injected and that "skills never drive voice" — but the code injects the block AND the
 * placeholder, in two places, each with its own comment explaining that outbound voice does inject
 * voice-labelled skills. The code is newer and internally consistent, so the code is the spec here; the
 * false claim is not carried over.
 *
 * ## Deferred and diverged
 *
 * `getToolsForAgent` (the inbound tools-mapper's custom voice tools) is not ported — it is best-effort
 * wrapped in the source, so an agent provisions without it exactly as it does when the mapper throws.
 * The post-call webhook id comes from the env-gated resolver Phase 7a settled on rather than the
 * source's live "look the webhook up by name" API call.
 */

import { db, runWithConcurrency } from '../firebase/db';
import { getAgent, getKnowledgeSourcesByAgent } from '../firebase/agent';
import { baseUrl, envStr } from '../config';
import { ELEVENLABS_BASE_API, outboundPostCallWebhookId } from './elevenlabs';
import type { DocumentData } from '../firebase/db';

/**
 * Every provider call in this module uses the same timeout.
 *
 * A DIVERGENCE, recorded deliberately: the source passes `timeout=30` on the five agent calls and omits
 * it entirely on the three knowledge-base calls. `fetch` has no default timeout either, so porting that
 * omission faithfully would let a KB upload or delete hang the whole serverless invocation. There is no
 * stated intent to preserve — the module's own other calls establish 30s — so it is applied uniformly.
 * If a large KB upload ever needs longer, this is the one number to raise.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** The Firestore document holding workspace-wide voice defaults. */
export const DEFAULT_VOICE_SETTINGS_ID = 'FQKBHsU2DaUNu4fGqIXy';

/**
 * The conversation-initiation path an agent is told to fetch per-caller context from.
 *
 * **Preserved verbatim from the source, and it points at the INBOUND app.** The outbound app ships its
 * own handler at `/outbound_agent/voice-agent/elevenlabs/conversation-init`, mounted for exactly this
 * purpose and wired to outbound services (`resolveOutboundAgentForInbound`, `buildOutboundCallScope`) —
 * so an agent provisioned here fetches inbound context and the outbound handler is never reached. That
 * looks like a copy-paste survivor from the clone, but the path is inert until the route exists (Phase
 * 10), and guessing at provisioning that points live agents somewhere new is not a port's call. Left as
 * the source has it, overridable by env, and flagged for Phase 10 to settle.
 */
export const CONVERSATION_INIT_PATH =
  '/inbound_agent/voice-agent/elevenlabs/conversation-init';

/** Friendly voice name → provider voice id. */
export const VOICE_ID_MAPPING: Record<string, string> = {
  'mark-natural': '21m00Tcm4TlvDq8ikWAM', // Rachel (default)
  'sarah-natural': 'EXAVITQu4vr4xnSDxMaL',
  adam: 'pNInz6obpgDQGcFmaJgB',
  antoni: 'ErXwobaYiN019PkySvjV',
  rachel: '21m00Tcm4TlvDq8ikWAM',
  domi: 'AZnzlk1XvdvUeBnXmlld',
  elli: 'MF3mGyEYCl7XYWbV9V6O',
  josh: 'TxGEqnHWrfWFTfGW9XjX',
  arnold: 'VR6AewLTigWG4xSOukaG',
  sam: 'yoZ06aMxZJJ28mfd3POQ',
};

export type VoiceSettings = Record<string, unknown>;
export type ConversationConfig = Record<string, unknown>;
export type SystemTool = Record<string, unknown>;

/** A knowledge-base entry as the agent config wants it. */
export interface KbEntry {
  type: 'file';
  name: string;
  id: string;
}

function authHeaders(): Record<string, string> {
  return {
    'xi-api-key': envStr('ELEVENLABS_API_KEY'),
    'Content-Type': 'application/json',
  };
}

/** Read a possibly-nested settings bag, tolerating a non-object value. */
function bag(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The workspace-wide voice defaults. Returns `{}` when the document is missing or unreadable, which the
 * three readers below turn into their own hardcoded fallbacks — so a Firestore outage degrades to
 * working defaults rather than an unprovisionable agent.
 */
export async function getDefaultVoiceSettings(): Promise<
  Record<string, unknown>
> {
  try {
    const doc = await db
      .collection('default_voice_settings')
      .doc(DEFAULT_VOICE_SETTINGS_ID)
      .get();
    if (doc.exists) {
      console.log('Fetched default voice settings from Firebase');
      return doc.data() ?? {};
    }
    console.warn('Default voice settings document not found, using fallback');
  } catch (e) {
    console.error(`Error fetching default voice settings from Firebase: ${e}`);
  }
  return {};
}

/**
 * Note that this and the two readers below each fetch the defaults document independently, so a fully
 * unconfigured agent costs three reads of the same document. Kept as three separate functions because
 * each is part of the module's public surface and the result is identical either way.
 */
export async function getDefaultLlmModel(): Promise<string> {
  const d = await getDefaultVoiceSettings();
  const llmModel = (d.llm || d.llmModel) as string | undefined;
  if (llmModel) {
    console.log(`Using default LLM model from Firebase: ${llmModel}`);
    return llmModel;
  }
  const fallback = 'qwen3-30b-a3b';
  console.log(`Using fallback LLM model: ${fallback}`);
  return fallback;
}

export async function getDefaultTurnEagerness(): Promise<string> {
  const d = await getDefaultVoiceSettings();
  const eagerness = (d.turn_eagerness || d.turnEagerness) as string | undefined;
  if (eagerness) {
    console.log(`Using default turn_eagerness from Firebase: ${eagerness}`);
    return eagerness;
  }
  const fallback = 'patient';
  console.log(`Using fallback turn_eagerness: ${fallback}`);
  return fallback;
}

export async function getDefaultSoftTimeoutMessage(): Promise<string> {
  const d = await getDefaultVoiceSettings();
  const message = (d.soft_timeout_message || d.softTimeoutMessage) as
    | string
    | undefined;
  if (message) {
    console.log(`Using default soft_timeout_message from Firebase: ${message}`);
    return message;
  }
  const fallback = 'Hhmmmm...yeah give me a second...';
  console.log(`Using fallback soft_timeout_message: ${fallback}`);
  return fallback;
}

/**
 * Map a friendly voice name to a provider voice id.
 *
 * An input that already LOOKS like a provider id (over 15 chars, alphanumeric once dashes and
 * underscores are stripped) is passed through untouched, so a raw id never gets mangled. An unknown name
 * falls back to Rachel rather than failing the provision.
 */
export function mapVoiceId(voiceName: string): string {
  const stripped = voiceName.replace(/[-_]/g, '');
  if (
    voiceName.length > 15 &&
    stripped.length > 0 &&
    /^[a-zA-Z0-9]+$/.test(stripped)
  ) {
    console.log(`Voice ID appears valid, using as-is: ${voiceName}`);
    return voiceName;
  }
  const mapped = VOICE_ID_MAPPING[voiceName.toLowerCase()];
  if (mapped) {
    console.log(`Mapped voice name '${voiceName}' to ID: ${mapped}`);
    return mapped;
  }
  console.warn(`Unknown voice name '${voiceName}', using default (Rachel)`);
  return VOICE_ID_MAPPING.rachel;
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt template blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize the prompt and ensure both template blocks exist.
 *
 * Firestore stores `{{variable\_name}}` (escaped underscores from the editor), which would never match a
 * variable name, so those are unescaped first. Then `{{local_scope}}` and `{{skills}}` are injected if
 * absent — skills spliced in AFTER `local_scope`'s `{% endif %}` when one exists, so the two blocks
 * nest correctly rather than one swallowing the other.
 */
export function ensurePromptTemplateBlocks(promptIn: string): string {
  let prompt = promptIn;
  if (prompt.includes('\\_')) {
    prompt = prompt.replaceAll('\\_', '_');
  }

  if (!prompt.includes('{{local_scope}}')) {
    prompt = `{% if local_scope %}\n{{local_scope}}\n{% endif %}\n\n${prompt}`;
    console.log(
      'Prepended {% if local_scope %}{{local_scope}}{% endif %} block to prompt'
    );
  }

  if (!prompt.includes('{{skills}}')) {
    const firstEndif = prompt.indexOf('{% endif %}'); // local_scope's endif
    const skillsBlock = '\n\n{% if skills %}\n{{skills}}\n{% endif %}';
    if (firstEndif !== -1) {
      const insertPos = firstEndif + '{% endif %}'.length;
      prompt =
        prompt.slice(0, insertPos) + skillsBlock + prompt.slice(insertPos);
    } else {
      prompt = `{% if skills %}\n{{skills}}\n{% endif %}\n\n${prompt}`;
    }
    console.log(
      'Injected {% if skills %}{{skills}}{% endif %} block into prompt'
    );
  }

  return prompt;
}

/**
 * Build the provider's `dynamic_variable_placeholders` map from the agent's Firestore variables.
 *
 * Reserved prefixes (`system__`, `secret__`) are dropped, null and empty values become
 * `"Not Available"` so the template still renders, primitives keep their type, and anything else is
 * JSON-stringified. `local_scope` and `skills` are ALWAYS present afterwards — they are supplied per
 * call, and a missing placeholder would leave their `{% if %}` blocks unrendered.
 */
export function buildPlaceholders(
  dynamicVariables?: Record<string, unknown> | null
): Record<string, unknown> {
  const placeholders: Record<string, unknown> = {};

  if (dynamicVariables) {
    if (
      typeof dynamicVariables !== 'object' ||
      Array.isArray(dynamicVariables)
    ) {
      console.warn('dynamic_variables is not a dict, skipping');
    } else {
      for (const [varName, varValue] of Object.entries(dynamicVariables)) {
        if (!varName || typeof varName !== 'string') {
          console.warn(
            `Invalid variable name (empty or not string): ${varName}, skipping`
          );
          continue;
        }
        if (varName.startsWith('system__')) {
          console.warn(
            `Skipping dynamic variable '${varName}' - system__ prefix is reserved`
          );
          continue;
        }
        if (varName.startsWith('secret__')) {
          console.warn(
            `Skipping dynamic variable '${varName}' - secret__ variables are not set as placeholders`
          );
          continue;
        }
        // Strictly null/undefined or the empty STRING. A numeric 0 or a false is a real value and is
        // kept — loose equality here would turn 0 into "Not Available".
        if (varValue === null || varValue === undefined || varValue === '') {
          placeholders[varName] = 'Not Available';
          continue;
        }
        if (
          typeof varValue === 'boolean' ||
          typeof varValue === 'number' ||
          typeof varValue === 'string'
        ) {
          placeholders[varName] = varValue;
        } else {
          try {
            placeholders[varName] = JSON.stringify(varValue);
            console.warn(
              `Converted complex object for variable '${varName}' to JSON string`
            );
          } catch (e) {
            console.error(
              `Failed to serialize variable '${varName}': ${e}, skipping`
            );
          }
        }
      }
    }
  }

  if (!placeholders.local_scope) {
    placeholders.local_scope = 'Not Available';
    console.log(
      "Added local_scope placeholder with default value 'Not Available'"
    );
  }
  if (!placeholders.skills) {
    placeholders.skills = 'Not Available';
    console.log("Added skills placeholder with default value 'Not Available'");
  }

  return placeholders;
}

// ─────────────────────────────────────────────────────────────────────────────
// System tools
// ─────────────────────────────────────────────────────────────────────────────

/** The fields every system tool carries identically. */
function systemToolBase(
  name: string,
  description: string,
  disableInterruptions: boolean
): SystemTool {
  return {
    type: 'system',
    name,
    description,
    response_timeout_secs: 20,
    disable_interruptions: disableInterruptions,
    force_pre_tool_speech: false,
    assignments: [],
    tool_call_sound: null,
    tool_call_sound_behavior: 'auto',
  };
}

/**
 * The enabled system tools, in the source's order.
 *
 * `end_call` is the only one that disables interruptions by default — it must not be talked over. The
 * two transfer tools ship with an empty `transfers` list, which the source notes can be configured
 * later; they are enabled-but-unrouted until then.
 */
export function buildSystemTools(
  toolsConfig: Record<string, unknown>,
  voicemailSettings: Record<string, unknown>
): SystemTool[] {
  const tools: SystemTool[] = [];
  const on = (a: string, b: string) => !!(toolsConfig[a] || toolsConfig[b]);

  if (on('end_call', 'endCall')) {
    tools.push({
      ...systemToolBase(
        'end_call',
        'End call (end_call) when no more instructions to follow or user says like bye etc.',
        true
      ),
      params: { system_tool_type: 'end_call' },
    });
  }
  if (on('detect_language', 'detectLanguage')) {
    tools.push({
      ...systemToolBase(
        'language_detection',
        "Identify and switch to the user's language during the call.",
        false
      ),
      params: { system_tool_type: 'language_detection' },
    });
  }
  if (on('skip_turn', 'skipTurn')) {
    tools.push({
      ...systemToolBase(
        'skip_turn',
        "Allow the agent to skip its turn, effectively waiting for the user's next input.",
        false
      ),
      params: { system_tool_type: 'skip_turn' },
    });
  }
  if (on('transfer_to_agent', 'transferToAgent')) {
    tools.push({
      ...systemToolBase('transfer_to_agent', '', false),
      params: { system_tool_type: 'transfer_to_agent', transfers: [] },
    });
  }
  if (on('transfer_to_number', 'transferToNumber')) {
    tools.push({
      ...systemToolBase('transfer_to_number', '', false),
      params: { system_tool_type: 'transfer_to_number', transfers: [] },
    });
  }
  if (on('play_keypad_touch_tone', 'playKeypadTouchTone')) {
    tools.push({
      ...systemToolBase(
        'play_keypad_touch_tone',
        'Play DTMF tones based on provided digits during a call.',
        false
      ),
      params: { system_tool_type: 'play_keypad_touch_tone' },
    });
  }
  if (on('voicemail_detection', 'voicemailDetection')) {
    tools.push({
      ...systemToolBase(
        'voicemail_detection',
        (voicemailSettings.description as string) ??
          'Detect if the call has reached a voicemail system.',
        (voicemailSettings.disableInterruptions as boolean) ?? false
      ),
      params: {
        system_tool_type: 'voicemail_detection',
        voicemail_message: (voicemailSettings.voicemailMessage as string) ?? '',
      },
    });
  }

  return tools;
}

// ─────────────────────────────────────────────────────────────────────────────
// The conversation config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map the Firestore `voice_settings` shape to the provider's `conversation_config`, and return the
 * enabled system tools alongside it.
 *
 * See the module note on the two different fallback mechanisms — `||` versus `??` here is not
 * stylistic, it decides whether a configured zero survives.
 */
export async function mapToElevenlabsFormat(
  prompt: string,
  voiceSettings: VoiceSettings,
  dynamicVariables?: Record<string, unknown> | null
): Promise<[ConversationConfig, SystemTool[]]> {
  const vs = voiceSettings ?? {};

  const agentLanguage = (vs.agent_language ||
    vs.agentLanguage ||
    'en') as string;
  const timezone = (vs.timezone ?? 'America/New_York') as string;

  const selectedVoiceName = (vs.selected_voice ||
    vs.selectedVoice ||
    'mark-natural') as string;
  const selectedVoice = mapVoiceId(selectedVoiceName);
  const firstMessage = (vs.first_message || vs.firstMessage || '') as string;
  const disableInterruptions = !!(
    vs.disable_interruptions || vs.disableInterruptions
  );

  const voicemailSettings = bag(vs.voicemailDetectionSettings);

  let llmModel = (vs.llm_model || vs.llmModel) as string | undefined;
  if (!llmModel) llmModel = await getDefaultLlmModel();

  const ttsModelFamily = (vs.tts_model_family || vs.ttsModelFamily) as
    | string
    | undefined;
  const expressiveMode = !!(vs.expressive_mode || vs.expressiveMode);
  const suggestedAudioTags = (vs.suggested_audio_tags ||
    vs.suggestedAudioTags ||
    []) as unknown[];

  // ttsModelFamily (V3) wins; otherwise fall back to tts_model for backward compatibility.
  const ttsModel = ttsModelFamily
    ? ttsModelFamily
    : ((vs.tts_model || vs.ttsModel || 'eleven_multilingual_v2') as string);

  const advanced = bag(vs.advanced_settings || vs.advancedSettings);
  // `||` — a configured 0 falls through to the default, matching Python's `or`.
  const turnTimeout = (advanced.turn_timeout ||
    advanced.turnTimeout ||
    7) as number;
  const maxDuration = (advanced.max_conversation_duration ||
    advanced.maxConversationDuration ||
    600) as number;
  const silenceTimeout = (advanced.silence_end_call_timeout ||
    advanced.silenceEndCallTimeout ||
    -1) as number;

  let turnEagerness = (vs.turn_eagerness || vs.turnEagerness) as
    | string
    | undefined;
  if (!turnEagerness) turnEagerness = await getDefaultTurnEagerness();

  let softTimeoutMessage = (vs.soft_timeout_message ||
    vs.softTimeoutMessage) as string | undefined;
  if (!softTimeoutMessage) {
    softTimeoutMessage = await getDefaultSoftTimeoutMessage();
  }

  const optimization = bag(vs.voice_optimization || vs.voiceOptimization);
  // `||` for latency (0 → 2), but `??` for the three below: the source reads those with a dict
  // default, which only fires on an ABSENT key, so a configured 0 is honoured.
  const optimizeLatency = (optimization.optimize_streaming_latency ||
    optimization.optimizeStreamingLatency ||
    2) as number;
  const stability = (optimization.stability ?? 0.5) as number;
  const similarity = (optimization.similarity ?? 0.75) as number;
  const speed = (optimization.speed ?? 1.0) as number;

  const toolsConfig = bag(vs.tools);

  const finalPrompt = ensurePromptTemplateBlocks(prompt);

  const conversationConfig: ConversationConfig = {
    agent: {
      prompt: { prompt: finalPrompt, llm: llmModel },
      first_message: firstMessage,
    },
    tts: {
      model_id: ttsModel,
      voice_id: selectedVoice,
      optimize_streaming_latency: optimizeLatency,
      stability,
      similarity_boost: similarity,
      speed,
      expressive_mode: expressiveMode,
      suggested_audio_tags: suggestedAudioTags,
    },
    turn: {
      turn_timeout: turnTimeout,
      mode: 'turn',
      turn_eagerness: turnEagerness,
      silence_end_call_timeout: silenceTimeout,
      soft_timeout_config: {
        timeout_seconds: -1,
        message: softTimeoutMessage,
      },
    },
    conversation: { max_duration_seconds: maxDuration },
  };

  // The V3 conversational model requires the realtime ASR provider.
  if (ttsModel === 'eleven_v3_conversational') {
    conversationConfig.asr = {
      quality: 'high',
      provider: 'scribe_realtime',
      user_input_audio_format: 'pcm_16000',
      keywords: [],
    };
    console.log(
      "Using 'scribe_realtime' ASR provider for V3 conversational model"
    );
  }

  const agentBlock = conversationConfig.agent as Record<string, unknown>;
  agentBlock.language = agentLanguage;
  // Timezone is set at BOTH levels, as the source does — the provider reads it from the prompt block.
  agentBlock.timezone = timezone;
  (agentBlock.prompt as Record<string, unknown>).timezone = timezone;

  // Always non-empty: local_scope and skills are unconditionally added, so the source's
  // "no valid placeholders" branch is unreachable and is not carried over.
  const placeholders = buildPlaceholders(dynamicVariables);
  agentBlock.dynamic_variables = {
    dynamic_variable_placeholders: placeholders,
  };
  console.log(
    `Added ${Object.keys(placeholders).length} dynamic variable placeholders: ` +
      `${JSON.stringify(Object.keys(placeholders))}`
  );

  if (disableInterruptions) {
    (
      conversationConfig.conversation as Record<string, unknown>
    ).interruptions_enabled = false;
  }

  const systemTools = buildSystemTools(toolsConfig, voicemailSettings);
  return [conversationConfig, systemTools];
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / update / read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The request body shared by create and update.
 *
 * The source duplicates this ~130-line block verbatim across `create_elevenlabs_agent` and
 * `update_elevenlabs_agent` — the payloads are identical and only the HTTP verb and log wording differ.
 * One builder here, so the two can never drift apart.
 */
async function buildAgentPayload(
  name: string,
  prompt: string,
  voiceSettings: VoiceSettings,
  kbList: KbEntry[] | null | undefined,
  dynamicVariables?: Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  const [conversationConfig, systemTools] = await mapToElevenlabsFormat(
    prompt,
    voiceSettings,
    dynamicVariables
  );

  // The inbound tools-mapper's custom voice tools are deferred; the source wraps that lookup in a
  // best-effort catch and continues without them, so an agent provisions identically here.
  const allTools: SystemTool[] = [...systemTools];
  if (systemTools.length > 0) {
    console.log(
      `Added ${systemTools.length} system tools to agent configuration`
    );
  }

  const agentBlock = conversationConfig.agent as Record<string, unknown>;
  const promptBlock = agentBlock.prompt as Record<string, unknown>;
  if (allTools.length > 0) {
    promptBlock.tools = allTools;
    console.log(`Total tools configured: ${allTools.length}`);
  }
  if (kbList && kbList.length > 0) {
    promptBlock.knowledge_base = kbList;
    console.log(
      `Added ${kbList.length} knowledge bases to agent configuration`
    );
  }

  const platformSettings: Record<string, unknown> = {};

  const phoneNumberId = (voiceSettings.phone_number_id ||
    voiceSettings.phoneNumberId) as string | undefined;
  if (phoneNumberId) platformSettings.phone_number_id = phoneNumberId;

  const workspaceOverrides: Record<string, unknown> = {};
  const webhookId = outboundPostCallWebhookId();
  if (webhookId) {
    workspaceOverrides.webhooks = {
      post_call_webhook_id: webhookId,
      events: ['transcript', 'audio', 'call_initiation_failure'],
    };
    console.log(
      `Added post-call webhook to agent: ${webhookId} with events: transcript, audio, call_initiation_failure`
    );
  } else {
    console.warn(
      'Could not fetch webhook ID, agent will be configured without post-call webhook'
    );
  }

  // `first_message` so a follow-up call can customize the greeting, `tts.voice_id` so sales-persona
  // voice switching works per call, and the initiation-client-data flag so the pre-call webhook is
  // consulted at all. Without these three the per-call overrides the dial tool sends are ignored.
  platformSettings.overrides = {
    conversation_config_override: {
      agent: { first_message: true },
      tts: { voice_id: true },
    },
    enable_conversation_initiation_client_data_from_webhook: true,
  };

  const initUrl = `${baseUrl()}${CONVERSATION_INIT_PATH}`;
  workspaceOverrides.conversation_initiation_client_data_webhook = {
    url: initUrl,
    request_headers: {},
  };
  console.log(`Added conversation init webhook: ${initUrl}`);

  platformSettings.workspace_overrides = workspaceOverrides;

  return {
    name,
    conversation_config: conversationConfig,
    platform_settings: platformSettings,
  };
}

/** Create a new conversational agent. Returns its id, or `null`. Never throws. */
export async function createElevenlabsAgent(
  name: string,
  prompt: string,
  voiceSettings: VoiceSettings,
  agentId: string,
  kbList?: KbEntry[] | null,
  dynamicVariables?: Record<string, unknown> | null
): Promise<string | null> {
  void agentId; // the source uses it only for the deferred custom-tools lookup
  try {
    const payload = await buildAgentPayload(
      name,
      prompt,
      voiceSettings,
      kbList,
      dynamicVariables
    );
    console.log(`Creating ElevenLabs agent: ${name}`);
    const resp = await fetch(`${ELEVENLABS_BASE_API}/v1/convai/agents/create`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200 && resp.status !== 201) {
      console.error(
        `ElevenLabs create agent failed: ${resp.status} - ${await resp.text()}`
      );
      return null;
    }
    const result = (await resp.json()) as Record<string, unknown>;
    const newId = result.agent_id as string | undefined;
    if (newId) {
      console.log(`Successfully created ElevenLabs agent: ${newId}`);
      return newId;
    }
    console.error(`No agent_id in response: ${JSON.stringify(result)}`);
    return null;
  } catch (e) {
    console.error(`Error creating ElevenLabs agent: ${e}`);
    return null;
  }
}

/** Update an existing conversational agent in place. Never throws. */
export async function updateElevenlabsAgent(
  elevenLabsAgentId: string,
  name: string,
  prompt: string,
  voiceSettings: VoiceSettings,
  agentId: string,
  kbList?: KbEntry[] | null,
  dynamicVariables?: Record<string, unknown> | null
): Promise<boolean> {
  void agentId; // see createElevenlabsAgent
  try {
    const payload = await buildAgentPayload(
      name,
      prompt,
      voiceSettings,
      kbList,
      dynamicVariables
    );
    console.log(`Updating ElevenLabs agent: ${elevenLabsAgentId}`);
    const resp = await fetch(
      `${ELEVENLABS_BASE_API}/v1/convai/agents/${elevenLabsAgentId}`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status !== 200 && resp.status !== 201) {
      console.error(
        `ElevenLabs update agent failed: ${resp.status} - ${await resp.text()}`
      );
      return false;
    }
    console.log(`Successfully updated ElevenLabs agent: ${elevenLabsAgentId}`);
    return true;
  } catch (e) {
    console.error(`Error updating ElevenLabs agent: ${e}`);
    return false;
  }
}

/** Read an agent's provider-side configuration. `null` when missing or on error. */
export async function getElevenlabsAgent(
  elevenLabsAgentId: string
): Promise<Record<string, unknown> | null> {
  try {
    console.log(`Fetching ElevenLabs agent: ${elevenLabsAgentId}`);
    const resp = await fetch(
      `${ELEVENLABS_BASE_API}/v1/convai/agents/${elevenLabsAgentId}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': envStr('ELEVENLABS_API_KEY') },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status === 404) {
      console.warn(`ElevenLabs agent not found: ${elevenLabsAgentId}`);
      return null;
    }
    if (resp.status !== 200) {
      console.error(
        `ElevenLabs get agent failed: ${resp.status} - ${await resp.text()}`
      );
      return null;
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    console.error(`Error fetching ElevenLabs agent: ${e}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge bases
// ─────────────────────────────────────────────────────────────────────────────

const KB_CONCURRENCY = 5;

/**
 * The text to upload for one knowledge source, or `null` if there is nothing usable.
 *
 * The source inlines this identical ~45-line extractor inside BOTH KB functions; it is one function
 * here. Only `text` and `document` types are supported; a dict is probed for `content`, then `text` /
 * `data` (and `url` for documents), and falls back to pretty-printed JSON. An empty result, or the
 * degenerate `{}` / `[]` JSON, is rejected rather than uploaded as a useless document.
 */
export function extractKbText(source: DocumentData): string | null {
  const kbType = source.type as string | undefined;
  const name = (source.name as string) ?? 'Knowledge Base';
  const data = source.data ?? {};

  let text: string;
  if (kbType === 'text' || kbType === 'document') {
    if (typeof data === 'string') {
      text = data;
    } else if (data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      const probes =
        kbType === 'document'
          ? [d.content, d.text, d.data, d.url]
          : [d.content, d.text, d.data];
      const found = probes.find((v) => !!v);
      text = found ? String(found) : JSON.stringify(data, null, 2);
    } else {
      text = String(data);
    }
  } else {
    console.warn(`Unsupported KB type: ${kbType}`);
    return null;
  }

  if (!text || text === '{}' || text === '[]') {
    console.warn(`Empty content for KB: ${name}`);
    return null;
  }
  return text;
}

/** Upload one text knowledge base. Returns its document id, or `null`. */
export async function createKbFromText(
  text: string,
  name: string
): Promise<string | null> {
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([text], { type: 'text/plain' }),
      `${name}.txt`
    );
    form.append('name', name);

    const resp = await fetch(
      `${ELEVENLABS_BASE_API}/v1/convai/knowledge-base`,
      {
        method: 'POST',
        // No Content-Type: the runtime sets the multipart boundary itself.
        headers: { 'xi-api-key': envStr('ELEVENLABS_API_KEY') },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!resp.ok) {
      console.error(
        `Failed to create KB: ${resp.status} - ${await resp.text()}`
      );
      return null;
    }
    const result = (await resp.json()) as Record<string, unknown>;
    const docId = (result.id ||
      result.document_id ||
      result.knowledge_base_id) as string | undefined;
    console.log(`KB created: ${docId}`);
    return docId ?? null;
  } catch (e) {
    console.error(`Failed to create KB: ${e}`);
    return null;
  }
}

/** Delete a knowledge-base document. `force` detaches it from any agent still using it. */
export async function deleteKbDocument(
  documentId: string,
  force = true
): Promise<boolean> {
  const url =
    `${ELEVENLABS_BASE_API}/v1/convai/knowledge-base/${documentId}` +
    (force ? '?force=true' : '');
  try {
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(
        `Failed to delete KB ${documentId}: ${resp.status} - ${await resp.text()}`
      );
      return false;
    }
    console.log(`KB deleted: ${documentId}`);
    return true;
  } catch (e) {
    console.error(`Failed to delete KB ${documentId}: ${e}`);
    return false;
  }
}

/** Replace an agent's ENTIRE knowledge-base list. A PATCH scoped to just that field. */
export async function replaceAllKbsInAgent(
  elevenlabsAgentId: string,
  kbList: KbEntry[]
): Promise<boolean> {
  try {
    const resp = await fetch(
      `${ELEVENLABS_BASE_API}/v1/convai/agents/${elevenlabsAgentId}`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          conversation_config: {
            agent: { prompt: { knowledge_base: kbList } },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!resp.ok) {
      console.error(
        `Failed to replace KBs in agent: ${resp.status} - ${await resp.text()}`
      );
      return false;
    }
    console.log(`Replaced ${kbList.length} KBs in agent ${elevenlabsAgentId}`);
    return true;
  } catch (e) {
    console.error(`Failed to replace KBs in agent: ${e}`);
    return false;
  }
}

/**
 * Upload every text/document knowledge source for an agent, bounded to five at a time.
 *
 * **A bug fixed here.** The source built its result list by walking the FILTERED id list and indexing
 * `sources[i]` for the name — so as soon as any one upload failed, every later entry was paired with
 * the WRONG source's name, silently mislabelling the agent's knowledge bases. The fix is to carry each
 * name with its own id and only then drop the failures. Both source KB functions had it; both are fixed.
 */
async function uploadSources(
  sources: DocumentData[]
): Promise<{ kbList: KbEntry[]; kbIds: string[] }> {
  const created = await runWithConcurrency(
    sources.map((source) => async () => {
      const name = (source.name as string) ?? 'Knowledge Base';
      const text = extractKbText(source);
      if (!text) return null;
      console.log(
        `Creating KB '${name}' (type: ${source.type}) with content length: ${text.length}`
      );
      const id = await createKbFromText(text, name);
      return id ? { name, id } : null;
    }),
    KB_CONCURRENCY
  );

  const pairs = created.filter(
    (p): p is { name: string; id: string } => p !== null
  );
  return {
    kbList: pairs.map((p) => ({ type: 'file', name: p.name, id: p.id })),
    kbIds: pairs.map((p) => p.id),
  };
}

/** Only text and document sources become knowledge bases. */
function kbEligible(sources: DocumentData[]): DocumentData[] {
  return sources.filter((s) => s.type === 'text' || s.type === 'document');
}

/**
 * Create knowledge bases from an agent's Firestore knowledge sources.
 *
 * Returns the list for the agent config and the ids to record in Firestore. Best-effort throughout —
 * `[[], []]` means "no knowledge bases", never an exception.
 */
export async function createKnowledgeBasesFromSources(
  agentId: string
): Promise<[KbEntry[], string[]]> {
  try {
    const sources = kbEligible(await getKnowledgeSourcesByAgent(agentId));
    if (sources.length === 0) {
      console.log(`No knowledge sources found for agent ${agentId}`);
      return [[], []];
    }
    console.log(
      `Found ${sources.length} knowledge sources (text/document types) for agent ${agentId}`
    );

    const { kbList, kbIds } = await uploadSources(sources);
    if (kbIds.length === 0) {
      console.error('Failed to create any KBs');
      return [[], []];
    }
    console.log(`Successfully created ${kbIds.length} KBs`);
    return [kbList, kbIds];
  } catch (e) {
    console.error(`Error creating knowledge bases: ${e}`);
    return [[], []];
  }
}

/**
 * Sync Firestore knowledge sources to the provider: upload the new set, point the agent at it, then
 * delete the old documents.
 *
 * **The order matters and is preserved.** Old documents are deleted only AFTER the agent has been
 * successfully re-pointed — a failed replace returns the new ids with `success: false` and leaves the
 * old KBs intact, so the agent keeps working on its previous set instead of being left with none. The
 * one exception is the no-sources case, which deletes the old set and reports success: that IS the
 * intended end state.
 */
export async function syncKnowledgeBasesToElevenlabs(
  agentId: string,
  elevenlabsAgentId: string
): Promise<[string[], boolean]> {
  try {
    const agent = await getAgent(agentId);
    if (!agent) {
      console.error(`Agent ${agentId} not found in Firebase`);
      return [[], false];
    }

    const oldKbIds = (bag(agent.voice_settings).elevenlabs_kb_ids ??
      []) as string[];
    console.log(`Old KB IDs to delete: ${JSON.stringify(oldKbIds)}`);

    const deleteOld = async () => {
      if (oldKbIds.length === 0) return;
      console.log(`Deleting ${oldKbIds.length} old KBs`);
      await runWithConcurrency(
        oldKbIds.map((kid) => () => deleteKbDocument(kid, true)),
        KB_CONCURRENCY
      );
    };

    const sources = kbEligible(await getKnowledgeSourcesByAgent(agentId));
    console.log(
      `Found ${sources.length} knowledge sources (text/document types) to sync`
    );

    if (sources.length === 0) {
      console.log('No knowledge sources to sync');
      await deleteOld();
      return [[], true];
    }

    const { kbList, kbIds } = await uploadSources(sources);
    if (kbIds.length === 0) {
      console.error('Failed to create any KBs');
      return [[], false];
    }
    console.log(`Successfully created ${kbIds.length} KBs`);

    console.log(`Replacing KBs in ElevenLabs agent ${elevenlabsAgentId}`);
    if (!(await replaceAllKbsInAgent(elevenlabsAgentId, kbList))) {
      console.error('Failed to replace KBs in agent');
      // Deliberately NOT deleting the old KBs: the agent is still pointed at them.
      return [kbIds, false];
    }

    await deleteOld();
    console.log(`Successfully synced ${kbIds.length} KBs to ElevenLabs`);
    return [kbIds, true];
  } catch (e) {
    console.error(`Error syncing knowledge bases: ${e}`);
    return [[], false];
  }
}
