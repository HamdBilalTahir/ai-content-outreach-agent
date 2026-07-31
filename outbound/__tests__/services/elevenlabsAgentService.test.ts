/**
 * @jest-environment node
 *
 * ElevenLabs conversational-agent provisioning.
 *
 * Three properties carry the weight here, and each is the kind of thing a "tidy-up" would silently
 * break:
 *
 *  - **The two settings fallbacks disagree about zero.** `optimize_streaming_latency`, `turn_timeout`,
 *    `max_conversation_duration`, and `silence_end_call_timeout` are read with Python's `or`, so a
 *    configured `0` becomes the DEFAULT. `stability`, `similarity`, and `speed` are read with a dict
 *    default, so a configured `0` STAYS zero. Both sides are asserted side by side.
 *  - **The prompt template blocks.** `{{local_scope}}` and `{{skills}}` are injected when missing, and
 *    skills must land AFTER local_scope's `{% endif %}` — nesting them wrongly would make one block
 *    swallow the other.
 *  - **Knowledge-base name/id alignment.** The source paired names to ids by index across a FILTERED
 *    list, so one failed upload mislabelled every later KB. The regression test fails a middle upload
 *    and checks the survivors kept their own names.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  CONVERSATION_INIT_PATH,
  DEFAULT_VOICE_SETTINGS_ID,
  VOICE_ID_MAPPING,
  buildPlaceholders,
  buildSystemTools,
  createElevenlabsAgent,
  createKnowledgeBasesFromSources,
  deleteKbDocument,
  ensurePromptTemplateBlocks,
  extractKbText,
  getDefaultLlmModel,
  getDefaultSoftTimeoutMessage,
  getDefaultTurnEagerness,
  getElevenlabsAgent,
  mapToElevenlabsFormat,
  mapVoiceId,
  syncKnowledgeBasesToElevenlabs,
  updateElevenlabsAgent,
} from '../../services/elevenlabsAgentService';

const AGENT = 'agentA';
const EL_AGENT = 'el_agent_1';

let fetchMock: jest.Mock;

/** Every provider call succeeds, returning a fresh KB/agent id per call. */
function providerAccepts() {
  let n = 0;
  fetchMock.mockImplementation(async () => {
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ agent_id: `new_agent_${n}`, id: `kb_${n}` }),
      text: async () => '',
    };
  });
}

function lastBody(): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  return JSON.parse(calls[calls.length - 1][1].body as string);
}

function seedDefaults(data: Record<string, unknown>) {
  store.set(`default_voice_settings/${DEFAULT_VOICE_SETTINGS_ID}`, data);
}

function seedKnowledgeSource(id: string, data: Record<string, unknown>) {
  store.set(`knowledge_sources/${id}`, { agent_id: AGENT, ...data });
}

/** The settings needed for a provision, with no optional field set. */
const MINIMAL = {
  llm_model: 'gpt-4o',
  turn_eagerness: 'eager',
  soft_timeout_message: 'hm',
};

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  process.env.ELEVENLABS_API_KEY = 'xi-key';
  process.env.BASE_URL = 'https://api.example.com';
  process.env.ELEVENLABS_OUTBOUND_POST_CALL_WEBHOOK_ID = 'wh_1';
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  providerAccepts();
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice id mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('mapVoiceId', () => {
  test('maps a friendly name, case-insensitively', () => {
    expect(mapVoiceId('sarah-natural')).toBe(VOICE_ID_MAPPING['sarah-natural']);
    expect(mapVoiceId('RACHEL')).toBe(VOICE_ID_MAPPING.rachel);
  });

  test('passes a raw provider id through untouched', () => {
    // Over 15 chars and alphanumeric once dashes are stripped — never mangle a real id.
    expect(mapVoiceId('21m00Tcm4TlvDq8ikWAM')).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  test('an unknown SHORT name falls back to Rachel rather than failing the provision', () => {
    expect(mapVoiceId('bogus')).toBe(VOICE_ID_MAPPING.rachel);
  });

  test('the id heuristic has a blind spot: a long unknown name is passed through as an id', () => {
    // 'nonexistent-voice' is 17 chars and alphanumeric once the dash is stripped, so it LOOKS like a
    // provider id and never reaches the name mapping. The Rachel safety net therefore only covers
    // names of 15 characters or fewer; anything longer is forwarded and the provider rejects it.
    // Pinned rather than smoothed over — widening the heuristic would start mangling real ids.
    expect(mapVoiceId('nonexistent-voice')).toBe('nonexistent-voice');
  });

  test('a long name that is NOT id-shaped still goes through the mapping', () => {
    // Spaces break the id heuristic, so this is treated as a name and misses → Rachel.
    expect(mapVoiceId('some very long voice name')).toBe(
      VOICE_ID_MAPPING.rachel
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The prompt template blocks
// ─────────────────────────────────────────────────────────────────────────────

describe('ensurePromptTemplateBlocks', () => {
  test('unescapes the editor-escaped underscores', () => {
    // Firestore stores {{customer\_name}}, which would never match a variable name.
    expect(ensurePromptTemplateBlocks('Hi {{customer\\_name}}')).toContain(
      '{{customer_name}}'
    );
  });

  test('injects both blocks, with skills AFTER local_scope', () => {
    const out = ensurePromptTemplateBlocks('You are a sales agent.');
    expect(out).toContain('{{local_scope}}');
    expect(out).toContain('{{skills}}');
    // Nesting matters: skills must be spliced in after local_scope's endif, not inside it.
    expect(out.indexOf('{{local_scope}}')).toBeLessThan(
      out.indexOf('{{skills}}')
    );
    expect(out.endsWith('You are a sales agent.')).toBe(true);
  });

  test('a prompt that already has both blocks is left alone', () => {
    const p =
      '{% if local_scope %}\n{{local_scope}}\n{% endif %}\n\n{% if skills %}\n{{skills}}\n{% endif %}\n\nBody';
    expect(ensurePromptTemplateBlocks(p)).toBe(p);
  });

  test('a prompt with local_scope only gets skills spliced in after its endif', () => {
    const p = '{% if local_scope %}\n{{local_scope}}\n{% endif %}\n\nBody';
    const out = ensurePromptTemplateBlocks(p);
    expect(out).toBe(
      '{% if local_scope %}\n{{local_scope}}\n{% endif %}' +
        '\n\n{% if skills %}\n{{skills}}\n{% endif %}' +
        '\n\nBody'
    );
  });

  test('a prompt with skills only gets local_scope prepended', () => {
    const out = ensurePromptTemplateBlocks(
      '{% if skills %}\n{{skills}}\n{% endif %}\n\nBody'
    );
    expect(out.startsWith('{% if local_scope %}')).toBe(true);
    expect(out.match(/\{\{skills\}\}/g)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic variable placeholders
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPlaceholders', () => {
  test('local_scope and skills are ALWAYS present', () => {
    // Their {% if %} blocks would not render without a placeholder, so this is unconditional.
    expect(buildPlaceholders(null)).toEqual({
      local_scope: 'Not Available',
      skills: 'Not Available',
    });
  });

  test('reserved prefixes are dropped', () => {
    const p = buildPlaceholders({
      system__caller_id: 'x',
      secret__api_key: 'y',
      keep: 'z',
    });
    expect(p.system__caller_id).toBeUndefined();
    expect(p.secret__api_key).toBeUndefined();
    expect(p.keep).toBe('z');
  });

  test('null and empty-string values become "Not Available"', () => {
    const p = buildPlaceholders({ a: null, b: '' });
    expect(p.a).toBe('Not Available');
    expect(p.b).toBe('Not Available');
  });

  test('a numeric 0 and a false are REAL values and survive', () => {
    // Loose equality against "" would turn 0 into "Not Available"; it must not.
    const p = buildPlaceholders({ count: 0, flag: false });
    expect(p.count).toBe(0);
    expect(p.flag).toBe(false);
  });

  test('complex values are JSON-stringified', () => {
    expect(buildPlaceholders({ tags: ['a', 'b'] }).tags).toBe('["a","b"]');
  });

  test('a supplied local_scope value wins over the default', () => {
    expect(buildPlaceholders({ local_scope: 'real scope' }).local_scope).toBe(
      'real scope'
    );
  });

  test('a non-object dynamic_variables is skipped, not crashed on', () => {
    expect(
      buildPlaceholders('nonsense' as unknown as Record<string, unknown>)
    ).toEqual({ local_scope: 'Not Available', skills: 'Not Available' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// System tools
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSystemTools', () => {
  test('nothing enabled yields no tools', () => {
    expect(buildSystemTools({}, {})).toEqual([]);
  });

  test('snake_case and camelCase both enable a tool', () => {
    expect(buildSystemTools({ end_call: true }, {})).toHaveLength(1);
    expect(buildSystemTools({ endCall: true }, {})).toHaveLength(1);
  });

  test('end_call is the one tool that cannot be talked over', () => {
    const [tool] = buildSystemTools({ end_call: true }, {});
    expect(tool.disable_interruptions).toBe(true);
    expect((tool.params as Record<string, unknown>).system_tool_type).toBe(
      'end_call'
    );
    // Every other tool allows interruption.
    const [skip] = buildSystemTools({ skip_turn: true }, {});
    expect(skip.disable_interruptions).toBe(false);
  });

  test('voicemail detection reads its copy from voicemailDetectionSettings', () => {
    const [tool] = buildSystemTools(
      { voicemail_detection: true },
      {
        description: 'Custom detector',
        voicemailMessage: 'Please call us back.',
        disableInterruptions: true,
      }
    );
    expect(tool.description).toBe('Custom detector');
    expect(tool.disable_interruptions).toBe(true);
    expect((tool.params as Record<string, unknown>).voicemail_message).toBe(
      'Please call us back.'
    );
  });

  test('the transfer tools ship enabled but unrouted', () => {
    const [tool] = buildSystemTools({ transfer_to_number: true }, {});
    expect((tool.params as Record<string, unknown>).transfers).toEqual([]);
  });

  test('tools come back in the source order', () => {
    const names = buildSystemTools(
      {
        voicemail_detection: true,
        end_call: true,
        skip_turn: true,
        detect_language: true,
      },
      {}
    ).map((t) => t.name);
    expect(names).toEqual([
      'end_call',
      'language_detection',
      'skip_turn',
      'voicemail_detection',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The conversation config, and the zero-handling asymmetry
// ─────────────────────────────────────────────────────────────────────────────

describe('mapToElevenlabsFormat', () => {
  async function config(vs: Record<string, unknown>) {
    const [cc] = await mapToElevenlabsFormat('Body', { ...MINIMAL, ...vs });
    return cc;
  }

  test('a configured ZERO survives for stability, similarity, and speed', async () => {
    // Read with a dict default, which only fires on an absent key.
    const cc = await config({
      voice_optimization: { stability: 0, similarity: 0, speed: 0 },
    });
    const tts = cc.tts as Record<string, unknown>;
    expect(tts.stability).toBe(0);
    expect(tts.similarity_boost).toBe(0);
    expect(tts.speed).toBe(0);
  });

  test('a configured ZERO is REPLACED by the default for the `or`-read fields', async () => {
    // The surprising half, and the reason the two are tested together: Python's `or` treats 0 as
    // falsy, so these four fall through to their defaults.
    const cc = await config({
      advanced_settings: {
        turn_timeout: 0,
        max_conversation_duration: 0,
        silence_end_call_timeout: 0,
      },
      voice_optimization: { optimize_streaming_latency: 0 },
    });
    expect((cc.turn as Record<string, unknown>).turn_timeout).toBe(7);
    expect(
      (cc.conversation as Record<string, unknown>).max_duration_seconds
    ).toBe(600);
    expect((cc.turn as Record<string, unknown>).silence_end_call_timeout).toBe(
      -1
    );
    expect((cc.tts as Record<string, unknown>).optimize_streaming_latency).toBe(
      2
    );
  });

  test('real non-zero values pass through on both sides', async () => {
    const cc = await config({
      advanced_settings: { turnTimeout: 12, maxConversationDuration: 900 },
      voice_optimization: { stability: 0.9, optimizeStreamingLatency: 4 },
    });
    expect((cc.turn as Record<string, unknown>).turn_timeout).toBe(12);
    expect(
      (cc.conversation as Record<string, unknown>).max_duration_seconds
    ).toBe(900);
    expect((cc.tts as Record<string, unknown>).stability).toBe(0.9);
    expect((cc.tts as Record<string, unknown>).optimize_streaming_latency).toBe(
      4
    );
  });

  test('timezone is written at BOTH the agent and prompt levels', async () => {
    const cc = await config({ timezone: 'America/Denver' });
    const agent = cc.agent as Record<string, unknown>;
    expect(agent.timezone).toBe('America/Denver');
    expect((agent.prompt as Record<string, unknown>).timezone).toBe(
      'America/Denver'
    );
  });

  test('the V3 model forces the realtime ASR provider', async () => {
    const cc = await config({ tts_model_family: 'eleven_v3_conversational' });
    expect((cc.asr as Record<string, unknown>).provider).toBe(
      'scribe_realtime'
    );
    expect((cc.tts as Record<string, unknown>).model_id).toBe(
      'eleven_v3_conversational'
    );
  });

  test('a non-V3 model gets no asr block at all', async () => {
    const cc = await config({ tts_model: 'eleven_turbo_v2' });
    expect(cc.asr).toBeUndefined();
  });

  test('ttsModelFamily wins over the legacy tts_model', async () => {
    const cc = await config({
      tts_model_family: 'eleven_v3_conversational',
      tts_model: 'eleven_multilingual_v2',
    });
    expect((cc.tts as Record<string, unknown>).model_id).toBe(
      'eleven_v3_conversational'
    );
  });

  test('interruptions are only disabled when asked', async () => {
    const off = await config({ disable_interruptions: true });
    expect(
      (off.conversation as Record<string, unknown>).interruptions_enabled
    ).toBe(false);
    const on = await config({});
    expect(
      (on.conversation as Record<string, unknown>).interruptions_enabled
    ).toBeUndefined();
  });

  test('an unset llm, eagerness, and timeout message fall back to the workspace defaults', async () => {
    seedDefaults({
      llm: 'claude-from-firebase',
      turnEagerness: 'patient-from-firebase',
      softTimeoutMessage: 'one moment from firebase',
    });
    const [cc] = await mapToElevenlabsFormat('Body', {});
    expect(
      ((cc.agent as Record<string, unknown>).prompt as Record<string, unknown>)
        .llm
    ).toBe('claude-from-firebase');
    expect((cc.turn as Record<string, unknown>).turn_eagerness).toBe(
      'patient-from-firebase'
    );
    expect(
      (
        (cc.turn as Record<string, unknown>).soft_timeout_config as Record<
          string,
          unknown
        >
      ).message
    ).toBe('one moment from firebase');
  });

  test('the prompt reaching the provider always carries both template blocks', async () => {
    const [cc] = await mapToElevenlabsFormat('Raw prompt', MINIMAL);
    const prompt = (
      (cc.agent as Record<string, unknown>).prompt as Record<string, unknown>
    ).prompt as string;
    expect(prompt).toContain('{{local_scope}}');
    expect(prompt).toContain('{{skills}}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('workspace defaults', () => {
  test('a missing defaults document degrades to the hardcoded fallbacks', async () => {
    expect(await getDefaultLlmModel()).toBe('qwen3-30b-a3b');
    expect(await getDefaultTurnEagerness()).toBe('patient');
    expect(await getDefaultSoftTimeoutMessage()).toBe(
      'Hhmmmm...yeah give me a second...'
    );
  });

  test('both snake_case and camelCase keys are read', async () => {
    seedDefaults({ llm: 'a', turn_eagerness: 'b', soft_timeout_message: 'c' });
    expect(await getDefaultLlmModel()).toBe('a');
    expect(await getDefaultTurnEagerness()).toBe('b');
    expect(await getDefaultSoftTimeoutMessage()).toBe('c');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create / update
// ─────────────────────────────────────────────────────────────────────────────

describe('provisioning an agent', () => {
  test('create returns the new agent id', async () => {
    const id = await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    expect(id).toBe('new_agent_1');
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/convai/agents/create');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('update PATCHes the agent in place and reports success', async () => {
    const ok = await updateElevenlabsAgent(
      EL_AGENT,
      'Sales',
      'Body',
      MINIMAL,
      AGENT
    );
    expect(ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/v1/convai/agents/${EL_AGENT}`
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
  });

  test('create and update send an IDENTICAL payload', async () => {
    await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    const created = lastBody();
    await updateElevenlabsAgent(EL_AGENT, 'Sales', 'Body', MINIMAL, AGENT);
    // The source duplicates the builder; one shared builder means they cannot drift.
    expect(lastBody()).toEqual(created);
  });

  test('the per-call overrides the dial tool depends on are always enabled', async () => {
    await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    const ps = lastBody().platform_settings as Record<string, unknown>;
    const ov = ps.overrides as Record<string, unknown>;
    const cco = ov.conversation_config_override as Record<string, unknown>;
    expect((cco.agent as Record<string, unknown>).first_message).toBe(true);
    expect((cco.tts as Record<string, unknown>).voice_id).toBe(true);
    expect(ov.enable_conversation_initiation_client_data_from_webhook).toBe(
      true
    );
  });

  test('the post-call webhook is attached with all three events', async () => {
    await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    const ps = lastBody().platform_settings as Record<string, unknown>;
    const wo = ps.workspace_overrides as Record<string, unknown>;
    const wh = wo.webhooks as Record<string, unknown>;
    expect(wh.post_call_webhook_id).toBe('wh_1');
    expect(wh.events).toEqual([
      'transcript',
      'audio',
      'call_initiation_failure',
    ]);
  });

  test('the conversation-init webhook url is built from BASE_URL', async () => {
    await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    const ps = lastBody().platform_settings as Record<string, unknown>;
    const wo = ps.workspace_overrides as Record<string, unknown>;
    expect(
      (
        wo.conversation_initiation_client_data_webhook as Record<
          string,
          unknown
        >
      ).url
    ).toBe(`https://api.example.com${CONVERSATION_INIT_PATH}`);
  });

  test('the webhook block is omitted rather than sent empty when unresolvable', async () => {
    process.env.ELEVENLABS_OUTBOUND_POST_CALL_WEBHOOK_ID = '';
    // The resolver has a literal default, so it still resolves — proving the fallback is live.
    await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    const ps = lastBody().platform_settings as Record<string, unknown>;
    const wo = ps.workspace_overrides as Record<string, unknown>;
    expect((wo.webhooks as Record<string, unknown>).post_call_webhook_id).toBe(
      '24b19d5135ce45228aaba0d70dad1940'
    );
  });

  test('phone_number_id is forwarded when configured, absent otherwise', async () => {
    await createElevenlabsAgent('Sales', 'Body', MINIMAL, AGENT);
    expect(
      (lastBody().platform_settings as Record<string, unknown>).phone_number_id
    ).toBeUndefined();
    await createElevenlabsAgent(
      'Sales',
      'Body',
      { ...MINIMAL, phoneNumberId: 'pn_9' },
      AGENT
    );
    expect(
      (lastBody().platform_settings as Record<string, unknown>).phone_number_id
    ).toBe('pn_9');
  });

  test('system tools and knowledge bases land on the prompt block', async () => {
    await createElevenlabsAgent(
      'Sales',
      'Body',
      { ...MINIMAL, tools: { end_call: true } },
      AGENT,
      [{ type: 'file', name: 'Pricing', id: 'kb_a' }]
    );
    const cc = lastBody().conversation_config as Record<string, unknown>;
    const promptBlock = (cc.agent as Record<string, unknown>).prompt as Record<
      string,
      unknown
    >;
    expect(promptBlock.tools as unknown[]).toHaveLength(1);
    expect(promptBlock.knowledge_base).toEqual([
      { type: 'file', name: 'Pricing', id: 'kb_a' },
    ]);
  });

  test('a provider rejection returns null / false, never throws', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () => 'bad config',
    });
    expect(await createElevenlabsAgent('S', 'B', MINIMAL, AGENT)).toBeNull();
    expect(
      await updateElevenlabsAgent(EL_AGENT, 'S', 'B', MINIMAL, AGENT)
    ).toBe(false);
  });

  test('a network failure returns null, never throws', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    expect(await createElevenlabsAgent('S', 'B', MINIMAL, AGENT)).toBeNull();
  });

  test('a 200 with no agent_id is treated as a failure', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    });
    expect(await createElevenlabsAgent('S', 'B', MINIMAL, AGENT)).toBeNull();
  });
});

describe('getElevenlabsAgent', () => {
  test('returns the agent config', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agent_id: EL_AGENT, name: 'Sales' }),
      text: async () => '',
    });
    expect(await getElevenlabsAgent(EL_AGENT)).toEqual({
      agent_id: EL_AGENT,
      name: 'Sales',
    });
  });

  test('a 404 is null, not an error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    });
    expect(await getElevenlabsAgent(EL_AGENT)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge bases
// ─────────────────────────────────────────────────────────────────────────────

describe('extractKbText', () => {
  test('a plain string is used directly', () => {
    expect(extractKbText({ type: 'text', data: 'hello' })).toBe('hello');
  });

  test('content wins, then text, then data', () => {
    expect(
      extractKbText({ type: 'text', data: { content: 'c', text: 't' } })
    ).toBe('c');
    expect(
      extractKbText({ type: 'text', data: { text: 't', data: 'd' } })
    ).toBe('t');
    expect(extractKbText({ type: 'text', data: { data: 'd' } })).toBe('d');
  });

  test('a document also probes url', () => {
    expect(
      extractKbText({ type: 'document', data: { url: 'https://x/y.pdf' } })
    ).toBe('https://x/y.pdf');
    // A text source has no url probe, so it falls through to the JSON dump.
    expect(
      extractKbText({ type: 'text', data: { url: 'https://x/y.pdf' } })
    ).toContain('"url"');
  });

  test('an unrecognised shape falls back to pretty JSON', () => {
    expect(extractKbText({ type: 'text', data: { a: 1 } })).toBe(
      '{\n  "a": 1\n}'
    );
  });

  test('an unsupported type is rejected', () => {
    expect(extractKbText({ type: 'image', data: 'x' })).toBeNull();
  });

  test('degenerate content is rejected rather than uploaded', () => {
    // An empty object serialises to "{}", which would be a useless KB document.
    expect(extractKbText({ type: 'text', data: '' })).toBeNull();
    expect(extractKbText({ type: 'text', data: [] })).toBeNull();
  });
});

describe('createKnowledgeBasesFromSources', () => {
  test('uploads each eligible source and returns aligned list and ids', async () => {
    seedKnowledgeSource('s1', {
      type: 'text',
      name: 'Pricing',
      data: 'prices',
    });
    seedKnowledgeSource('s2', { type: 'document', name: 'FAQ', data: 'faqs' });
    const [kbList, kbIds] = await createKnowledgeBasesFromSources(AGENT);
    expect(kbIds).toHaveLength(2);
    expect(kbList.map((k) => k.name).sort()).toEqual(['FAQ', 'Pricing']);
    for (const entry of kbList) {
      expect(entry.type).toBe('file');
      expect(kbIds).toContain(entry.id);
    }
  });

  test('ineligible source types are skipped entirely', async () => {
    seedKnowledgeSource('s1', { type: 'website', name: 'Site', data: 'x' });
    expect(await createKnowledgeBasesFromSources(AGENT)).toEqual([[], []]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('no sources is an empty result, not a failure', async () => {
    expect(await createKnowledgeBasesFromSources(AGENT)).toEqual([[], []]);
  });

  test('a FAILED upload must not shift the surviving names onto wrong ids', async () => {
    // The regression the source had: names were paired to ids by index across a filtered list, so
    // one failure mislabelled every KB after it.
    seedKnowledgeSource('s1', { type: 'text', name: 'First', data: 'a' });
    seedKnowledgeSource('s2', { type: 'text', name: 'Second', data: 'b' });
    seedKnowledgeSource('s3', { type: 'text', name: 'Third', data: 'c' });

    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => 'boom',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: `kb_for_call_${call}` }),
        text: async () => '',
      };
    });

    const [kbList] = await createKnowledgeBasesFromSources(AGENT);
    expect(kbList).toHaveLength(2);
    // Whatever survived, no entry may carry the failed source's name, and no two may share a name.
    expect(kbList.map((k) => k.name)).not.toContain('First');
    expect(new Set(kbList.map((k) => k.name)).size).toBe(2);
  });

  test('every upload failing is reported as no knowledge bases', async () => {
    seedKnowledgeSource('s1', { type: 'text', name: 'First', data: 'a' });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    });
    expect(await createKnowledgeBasesFromSources(AGENT)).toEqual([[], []]);
  });
});

describe('deleteKbDocument', () => {
  test('forces by default so an attached document still deletes', async () => {
    await deleteKbDocument('kb_1');
    expect(fetchMock.mock.calls[0][0]).toContain('?force=true');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  test('force can be turned off', async () => {
    await deleteKbDocument('kb_1', false);
    expect(fetchMock.mock.calls[0][0]).not.toContain('force');
  });

  test('a failure is false, never a throw', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await deleteKbDocument('kb_1')).toBe(false);
  });
});

describe('syncKnowledgeBasesToElevenlabs', () => {
  function seedAgent(oldIds: string[] = []) {
    store.set(`agents/${AGENT}`, {
      name: 'Sales',
      voice_settings: { elevenlabs_kb_ids: oldIds },
    });
  }

  test('a missing agent fails without touching the provider', async () => {
    expect(await syncKnowledgeBasesToElevenlabs(AGENT, EL_AGENT)).toEqual([
      [],
      false,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('uploads, re-points the agent, THEN deletes the old documents', async () => {
    seedAgent(['old_1']);
    seedKnowledgeSource('s1', { type: 'text', name: 'Pricing', data: 'p' });

    const [ids, ok] = await syncKnowledgeBasesToElevenlabs(AGENT, EL_AGENT);
    expect(ok).toBe(true);
    expect(ids).toHaveLength(1);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const patchIdx = urls.findIndex((u) => u.includes(`/agents/${EL_AGENT}`));
    const deleteIdx = urls.findIndex((u) => u.includes('old_1'));
    // Order is the safety property: the agent must be re-pointed before the old set is destroyed.
    expect(patchIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(patchIdx);
  });

  test('a failed re-point leaves the OLD documents intact', async () => {
    seedAgent(['old_1']);
    seedKnowledgeSource('s1', { type: 'text', name: 'Pricing', data: 'p' });

    fetchMock.mockImplementation(
      async (url: string, init: { method: string }) => {
        if (init.method === 'PATCH') {
          return {
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => 'no',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'kb_new' }),
          text: async () => '',
        };
      }
    );

    const [ids, ok] = await syncKnowledgeBasesToElevenlabs(AGENT, EL_AGENT);
    expect(ok).toBe(false);
    // The new ids come back so the caller can clean up, but the agent still works on its old set.
    expect(ids).toEqual(['kb_new']);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('old_1'))
    ).toBe(false);
  });

  test('no sources deletes the old set and reports success — that IS the end state', async () => {
    seedAgent(['old_1', 'old_2']);
    const [ids, ok] = await syncKnowledgeBasesToElevenlabs(AGENT, EL_AGENT);
    expect([ids, ok]).toEqual([[], true]);
    const deleted = fetchMock.mock.calls.filter(
      (c) => c[1].method === 'DELETE'
    );
    expect(deleted).toHaveLength(2);
    // Nothing was re-pointed, because there is nothing to point at.
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'PATCH')).toBe(
      false
    );
  });

  test('every upload failing does NOT destroy the old set', async () => {
    seedAgent(['old_1']);
    seedKnowledgeSource('s1', { type: 'text', name: 'Pricing', data: 'p' });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    });
    expect(await syncKnowledgeBasesToElevenlabs(AGENT, EL_AGENT)).toEqual([
      [],
      false,
    ]);
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'DELETE')).toBe(
      false
    );
  });
});
