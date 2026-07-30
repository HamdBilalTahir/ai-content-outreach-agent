/**
 * @jest-environment node
 *
 * The model layer: provider routing, the tier-based Anthropic mapping, the empty-text sanitizer, the
 * three-way format conversion, and the tool registry.
 *
 * Two properties get the most coverage because both are silent failures:
 *
 *  1. **The sanitizer.** Bedrock rejects an empty text block anywhere in the history, not just in the
 *     newest message, and it must mutate IN PLACE — the caller's append-and-return contract depends on
 *     list identity. A rebuild that returned a new list would pass a naive test and break the turn loop.
 *  2. **Tier mapping, not snapshot mapping.** Several snapshots that work on Bedrock are retired on the
 *     direct API and 404. Mapping by exact snapshot would look more faithful and fail in production, so
 *     the tests assert the retired ids specifically map FORWARD.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import {
  ANTHROPIC_FALLBACK_MODEL,
  ANTHROPIC_HAIKU,
  ANTHROPIC_SONNET,
  anthropicEnabled,
  getLlmProvider,
  toAnthropicModelId,
} from '../../llm/provider';
import {
  DEFAULT_MODEL,
  GROQ_OPENAI_OSS_120_MODEL,
  anthropicResponseToBedrock,
  bedrockMessagesToAnthropic,
  bedrockMessagesToGroq,
  bedrockToolsToAnthropic,
  bedrockToolsToGroq,
  cleanBedrockResponse,
  groqResponseToBedrock,
  normalizeModelAlias,
  parseToolArguments,
  resolveProviderAndModel,
  sanitizeBedrockMessages,
  selectModel,
  textOf,
} from '../../llm/ask';
import {
  __resetRegistry,
  getDefaultTools,
  getToolsForEnabledFunctions,
  registerTool,
  registerToolAlias,
  registeredToolNames,
  type ToolSpec,
} from '../../llm/toolRegistry';
import type { BedrockMessage } from '../../types';

function spec(name: string): ToolSpec {
  return {
    toolSpec: {
      name,
      description: `does ${name}`,
      inputSchema: { json: { type: 'object', properties: {} } },
    },
  };
}

beforeEach(() => {
  delete process.env.LLM_PROVIDER;
  __resetRegistry();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the provider switch', () => {
  it('defaults to bedrock', () => {
    expect(getLlmProvider()).toBe('bedrock');
    expect(anthropicEnabled()).toBe(false);
  });

  it('flips to anthropic only on the exact value', () => {
    process.env.LLM_PROVIDER = 'anthropic';
    expect(anthropicEnabled()).toBe(true);
    process.env.LLM_PROVIDER = 'ANTHROPIC';
    expect(anthropicEnabled()).toBe(true); // case-insensitive
    process.env.LLM_PROVIDER = 'anthropic-ish';
    expect(anthropicEnabled()).toBe(false); // not a prefix match
  });
});

describe('the Anthropic mapping is by TIER, not snapshot', () => {
  it('maps the live Haiku id to Haiku', () => {
    expect(
      toAnthropicModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0')
    ).toBe(ANTHROPIC_HAIKU);
  });

  it('maps RETIRED snapshots FORWARD rather than reproducing them', () => {
    // Each of these still works on Bedrock and 404s on the direct API. Exact-snapshot mapping would
    // look faithful and break in production.
    expect(
      toAnthropicModelId('us.anthropic.claude-sonnet-4-20250514-v1:0')
    ).toBe(ANTHROPIC_SONNET);
    expect(
      toAnthropicModelId('anthropic.claude-3-5-sonnet-20240620-v1:0')
    ).toBe(ANTHROPIC_SONNET);
    expect(
      toAnthropicModelId('us.anthropic.claude-3-5-haiku-20241022-v1:0')
    ).toBe(ANTHROPIC_HAIKU);
  });

  it('maps Opus to Sonnet rather than 404-ing on an unused tier', () => {
    expect(toAnthropicModelId('us.anthropic.claude-opus-4-20250101-v1:0')).toBe(
      ANTHROPIC_SONNET
    );
  });

  it('returns null for a NON-Claude model, signalling "stay on Bedrock"', () => {
    expect(toAnthropicModelId('amazon.titan-text-v1')).toBeNull();
    expect(toAnthropicModelId('meta.llama3-70b-instruct-v1:0')).toBeNull();
    expect(toAnthropicModelId('')).toBeNull();
    expect(toAnthropicModelId(null)).toBeNull();
  });

  it('strips Bedrock decorations for an unrecognised Claude tier', () => {
    expect(toAnthropicModelId('us.anthropic.claude-future-9-v2:0')).toBe(
      'claude-future-9'
    );
  });

  it('keeps the fallback pointed at a live model', () => {
    expect(ANTHROPIC_FALLBACK_MODEL).toBe(ANTHROPIC_HAIKU);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('provider routing', () => {
  it('honours an explicit provider, including the tolerated typo', () => {
    expect(resolveProviderAndModel(null, { llm_provider: 'groq' })[0]).toBe(
      'groq'
    );
    // `ggoq` is a typo the source tolerates, so an existing misconfiguration keeps working.
    expect(resolveProviderAndModel(null, { llm_provider: 'ggoq' })[0]).toBe(
      'groq'
    );
    expect(
      resolveProviderAndModel('anything', { llm_provider: 'bedrock' })
    ).toEqual(['bedrock', 'anything']);
  });

  it('FORCES every Groq route onto the one allowed model', () => {
    // This deployment permits exactly one Groq model for tool-call reliability, so an unexpected one
    // is corrected rather than attempted.
    for (const m of [
      'groq/some-other-model',
      'openai/gpt-4',
      'moonshotai/kimi-k2-instruct-0905',
      'openai/gpt-oss-120b',
    ]) {
      expect(resolveProviderAndModel(m)).toEqual([
        'groq',
        GROQ_OPENAI_OSS_120_MODEL,
      ]);
    }
  });

  it('routes every known Bedrock prefix to Bedrock, unchanged', () => {
    for (const p of ['us.', 'eu.', 'apac.', 'anthropic.', 'amazon.', 'meta.']) {
      const id = `${p}some-model-v1:0`;
      expect(resolveProviderAndModel(id)).toEqual(['bedrock', id]);
    }
  });

  it('routes an unknown slash-containing id to Groq — it cannot be a Bedrock id', () => {
    expect(resolveProviderAndModel('vendor/thing')).toEqual([
      'groq',
      GROQ_OPENAI_OSS_120_MODEL,
    ]);
  });

  it('defaults a bare unknown id to Bedrock', () => {
    expect(resolveProviderAndModel('mystery-model')).toEqual([
      'bedrock',
      'mystery-model',
    ]);
  });

  it('falls back to the default model with no id at all', () => {
    expect(resolveProviderAndModel(null)).toEqual(['bedrock', DEFAULT_MODEL]);
  });
});

describe('model aliases and selection', () => {
  it('resolves every legacy alias to the one allowed Groq model', () => {
    for (const a of ['kimi2', 'kimi-2', 'oss-120', 'gpt oss 120']) {
      expect(normalizeModelAlias(a)).toBe(GROQ_OPENAI_OSS_120_MODEL);
    }
  });

  it('strips a groq/ prefix before resolving', () => {
    expect(normalizeModelAlias('groq/kimi2')).toBe(GROQ_OPENAI_OSS_120_MODEL);
  });

  it('passes an unknown id through, trimmed', () => {
    expect(normalizeModelAlias('  us.anthropic.thing  ')).toBe(
      'us.anthropic.thing'
    );
    expect(normalizeModelAlias(null)).toBeNull();
  });

  it('prefers an assigned model, then a company default, then the fallback', () => {
    expect(selectModel({ assigned_model: 'kimi2' })).toBe(
      GROQ_OPENAI_OSS_120_MODEL
    );
    expect(selectModel({ company_id: '248' })).toContain('sonnet');
    expect(selectModel({})).toBe(DEFAULT_MODEL);
    expect(selectModel(null)).toBe(DEFAULT_MODEL);
  });

  it('lets an assigned model win over the company default', () => {
    expect(
      selectModel({ company_id: '248', assigned_model: 'us.anthropic.haiku-x' })
    ).toBe('us.anthropic.haiku-x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the empty-text sanitizer', () => {
  it('strips an empty text block from ANYWHERE in the history', () => {
    // A single empty block anywhere fails the whole request, so it is not enough to clean the newest.
    const msgs: BedrockMessage[] = [
      { role: 'user', content: [{ text: 'real' }, { text: '' }] },
      { role: 'assistant', content: [{ text: '   ' }, { text: 'answer' }] },
    ];
    sanitizeBedrockMessages(msgs);
    expect(msgs[0].content).toEqual([{ text: 'real' }]);
    expect(msgs[1].content).toEqual([{ text: 'answer' }]);
  });

  it('mutates IN PLACE, preserving list identity', () => {
    // The caller's append-and-return contract depends on this. A rebuild would break the turn loop.
    const content = [{ text: 'keep' }, { text: '' }];
    const msgs: BedrockMessage[] = [{ role: 'user', content }];
    sanitizeBedrockMessages(msgs);
    expect(msgs[0].content).toBe(content); // same array object
    expect(content).toEqual([{ text: 'keep' }]);
  });

  it('substitutes a placeholder rather than emptying a message', () => {
    // Removing the message would break the role alternation Bedrock requires.
    const msgs: BedrockMessage[] = [{ role: 'user', content: [{ text: '' }] }];
    sanitizeBedrockMessages(msgs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual([{ text: '(no content)' }]);
  });

  it('never treats a TOOL block as empty text', () => {
    const toolUse = { toolUse: { toolUseId: 't1', name: 'x', input: {} } };
    const toolResult = { toolResult: { toolUseId: 't1', content: [] } };
    const msgs: BedrockMessage[] = [
      { role: 'assistant', content: [toolUse] as never },
      { role: 'user', content: [toolResult] as never },
    ];
    sanitizeBedrockMessages(msgs);
    expect(msgs[0].content).toEqual([toolUse]);
    expect(msgs[1].content).toEqual([toolResult]);
  });

  it('leaves a clean history untouched and tolerates nullish input', () => {
    const msgs: BedrockMessage[] = [
      { role: 'user', content: [{ text: 'ok' }] },
    ];
    sanitizeBedrockMessages(msgs);
    expect(msgs[0].content).toEqual([{ text: 'ok' }]);
    expect(() => sanitizeBedrockMessages(null)).not.toThrow();
    expect(() => sanitizeBedrockMessages([])).not.toThrow();
  });
});

describe('cleanBedrockResponse', () => {
  it('strips the transient `type` Bedrock returns but rejects on replay', () => {
    const cleaned = cleanBedrockResponse({
      role: 'assistant',
      content: [
        {
          toolUse: { toolUseId: 't1', name: 'x', input: {}, type: 'tool_use' },
        },
      ],
    });
    const tu = (cleaned.content![0] as Record<string, never>).toolUse as Record<
      string,
      unknown
    >;
    expect('type' in tu).toBe(false);
    expect(tu.toolUseId).toBe('t1');
  });

  it('leaves text blocks and non-object input alone', () => {
    expect(
      cleanBedrockResponse({ role: 'assistant', content: [{ text: 'hi' }] })
        .content
    ).toEqual([{ text: 'hi' }]);
    expect(cleanBedrockResponse(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Bedrock ↔ Anthropic conversion', () => {
  it('converts tools to the Anthropic shape', () => {
    expect(bedrockToolsToAnthropic([spec('send_email')])).toEqual([
      {
        name: 'send_email',
        description: 'does send_email',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
  });

  it('converts text, tool use, and tool result', () => {
    const out = bedrockMessagesToAnthropic([
      { role: 'user', content: [{ text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 't1',
              name: 'send_email',
              input: { to: 'a' },
            },
          },
        ] as never,
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 't1',
              content: [{ json: { status: 'sent' } }],
            },
          },
        ] as never,
      },
    ]);
    expect(out[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(out[1].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'send_email', input: { to: 'a' } },
    ]);
    // Anthropic takes a tool result as a STRING, so a json payload is serialized.
    expect(out[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: '{"status":"sent"}',
      },
    ]);
  });

  it('drops empty text and any message left with no content', () => {
    expect(
      bedrockMessagesToAnthropic([{ role: 'user', content: [{ text: '  ' }] }])
    ).toEqual([]);
  });

  it('converts a response back, mapping the tool_use stop reason', () => {
    const r = anthropicResponseToBedrock({
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'send_email', input: { to: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolsRequested).toHaveLength(1);
    expect(r.tokenUsage.total_tokens).toBe(15);
    expect((r.payload as BedrockMessage).role).toBe('assistant');
  });

  it('reports end_turn for a text-only response', () => {
    const r = anthropicResponseToBedrock({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: {},
    });
    expect(r.stopReason).toBe('end_turn');
    expect(r.toolsRequested).toEqual([]);
  });
});

describe('Bedrock ↔ Groq conversion', () => {
  it('puts the system prompt first', () => {
    const out = bedrockMessagesToGroq('be helpful', []);
    expect(out[0]).toEqual({ role: 'system', content: 'be helpful' });
  });

  it('maps tool calls onto the assistant message', () => {
    const out = bedrockMessagesToGroq('sys', [
      {
        role: 'assistant',
        content: [
          { text: 'calling' },
          {
            toolUse: {
              toolUseId: 't1',
              name: 'send_email',
              input: { to: 'a' },
            },
          },
        ] as never,
      },
    ]);
    const msg = out[1];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('calling');
    const calls = msg.tool_calls as Array<Record<string, never>>;
    expect(calls[0].id).toBe('t1');
    expect((calls[0].function as Record<string, string>).arguments).toBe(
      '{"to":"a"}'
    );
  });

  it('makes a tool RESULT its own message, as the Groq format requires', () => {
    const out = bedrockMessagesToGroq('sys', [
      {
        role: 'user',
        content: [
          { toolResult: { toolUseId: 't1', content: [{ text: 'ok' }] } },
        ] as never,
      },
    ]);
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' });
  });

  it('converts tools to function definitions', () => {
    expect(bedrockToolsToGroq([spec('x')])[0]).toMatchObject({
      type: 'function',
      function: { name: 'x' },
    });
  });

  it('tolerates arguments arriving as a string or an object', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolArguments('not json')).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
  });

  it('infers tool_use from the presence of tool calls', () => {
    const r = groqResponseToBedrock({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'c1',
                function: { name: 'send_email', arguments: '{"to":"a"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolsRequested).toHaveLength(1);
    expect(r.tokenUsage.input_tokens).toBe(3);
  });

  it('reports end_turn for a text-only Groq response', () => {
    const r = groqResponseToBedrock({
      choices: [{ message: { content: 'hello' } }],
      usage: {},
    });
    expect(r.stopReason).toBe('end_turn');
    expect(textOf(r)).toBe('hello');
  });
});

describe('textOf', () => {
  it('concatenates text from a single message or a list', () => {
    expect(
      textOf({
        payload: { role: 'assistant', content: [{ text: 'a' }, { text: 'b' }] },
      })
    ).toBe('ab');
    expect(
      textOf({
        payload: [
          { role: 'user', content: [{ text: 'x' }] },
          { role: 'assistant', content: [{ text: 'y' }] },
        ],
      })
    ).toBe('xy');
  });

  it('ignores tool blocks and tolerates junk', () => {
    expect(
      textOf({
        payload: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 't', name: 'x', input: {} } }],
        },
      })
    ).toBe('');
    expect(textOf(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the tool registry', () => {
  it('returns the schemas for enabled functions', () => {
    registerTool('send_email', spec('send_email'));
    registerTool('make_phone_call', spec('make_phone_call'));
    const tools = getToolsForEnabledFunctions(['send_email']);
    expect(tools).toHaveLength(1);
    expect(tools[0].toolSpec.name).toBe('send_email');
  });

  it('SKIPS an unregistered name rather than throwing', () => {
    // A partially ported tool set must degrade to a smaller tool list, not a failed turn.
    registerTool('send_email', spec('send_email'));
    const tools = getToolsForEnabledFunctions(['send_email', 'not_ported_yet']);
    expect(tools).toHaveLength(1);
  });

  it('defaults to every registered tool', () => {
    registerTool('a', spec('a'));
    registerTool('b', spec('b'));
    expect(getDefaultTools()).toHaveLength(2);
    expect(registeredToolNames()).toEqual(['a', 'b']);
  });

  it('supports an alias sharing one implementation under a second name', () => {
    const base = spec('text_knowledge_source');
    registerTool('text_knowledge_source', base);
    registerToolAlias('read_from_kb', base, 'friendlier description');
    const tools = getToolsForEnabledFunctions(['read_from_kb']);
    expect(tools[0].toolSpec.name).toBe('read_from_kb');
    expect(tools[0].toolSpec.description).toBe('friendlier description');
    // The alias reuses the same input schema.
    expect(tools[0].toolSpec.inputSchema).toBe(base.toolSpec.inputSchema);
  });

  it('is empty for nullish enabled functions', () => {
    expect(getToolsForEnabledFunctions(null)).toEqual([]);
    expect(getToolsForEnabledFunctions([])).toEqual([]);
  });
});

describe('the send_email tool registers itself on import', () => {
  it('is available to the model layer with no wiring step', async () => {
    __resetRegistry();
    await import('../../tools/email');
    expect(registeredToolNames()).toContain('send_email');
  });
});
