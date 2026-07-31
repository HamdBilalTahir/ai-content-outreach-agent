/**
 * @jest-environment node
 *
 * The turn engine's helper layer.
 *
 * The properties worth protecting here are mostly about IDEMPOTENCE and SHAPE, because both fail
 * silently:
 *
 *  - **Both prompt injections are idempotent and prepend.** Re-entering a turn must not stack a second
 *    copy of the guardrails, and the blocks must land at the FRONT — a prompt cannot override an
 *    instruction it has not reached yet.
 *  - **`appendToolResultMessage` GROUPS.** Bedrock requires toolResult blocks to follow their toolUse
 *    immediately, so several tools in one assistant turn must come back as ONE user message. Appending
 *    separately produces a history the provider rejects.
 *  - **`stampEmailOutcomeOnToolCall` is what stops the inbox lying.** The transformer reads each
 *    tool-call document in isolation and never sees the toolResult, so without the stamp a deferred or
 *    blocked email renders as delivered.
 *  - **`extractToolStatusAndMessage` returns a non-verdict, never a throw.** The dispatch loop reads it
 *    to decide whether a tool terminally blocked; a malformed payload must read as "no verdict".
 *  - **`terminalBlockShortcircuitEnabled` fails ON.** Only the explicit off-values disable it, so a typo
 *    cannot silently revert behaviour.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../firebase/agent', () => ({
  getAgentDataForPrompt: jest.fn(),
}));

import { getAgentDataForPrompt } from '../../firebase/agent';
import {
  BACKEND_GUARDRAILS_HEADER,
  GROQ_TOOL_USE_POLICY_HEADER,
  OUTBOUND_MESSAGE_TOOL_NAMES,
  appendToolResultMessage,
  buildBackendGuardrails,
  buildGroqToolUsePolicy,
  buildMessage,
  buildToolResultMessage,
  enabledOutboundTools,
  extractToolStatusAndMessage,
  getKnowledgeSources,
  injectBackendGuardrails,
  injectGroqToolUsePolicy,
  resolveProviderForTurn,
  stampEmailOutcomeOnToolCall,
  terminalBlockShortcircuitEnabled,
} from '../../llm/turnHelpers';
import type { BedrockMessage } from '../../types';

const promptData = getAgentDataForPrompt as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT;
});

// ─────────────────────────────────────────────────────────────────────────────
// The guardrail block
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBackendGuardrails', () => {
  test('states the mandatory-tool-use rule and the active channel', () => {
    const g = buildBackendGuardrails('web', ['send_web_message']);
    expect(g.startsWith(BACKEND_GUARDRAILS_HEADER)).toBe(true);
    expect(g).toContain('**MANDATORY TOOL USE**');
    expect(g).toContain('Active channel: web.');
    expect(g).toContain('use send_web_message to reply');
  });

  test('tool lists are SORTED, so the prompt prefix is byte-stable', () => {
    // An unordered set would change the prefix every turn and lose prompt caching.
    const a = buildBackendGuardrails('web', [
      'send_web_message',
      'create_plan',
    ]);
    const b = buildBackendGuardrails('web', [
      'create_plan',
      'send_web_message',
    ]);
    expect(a).toBe(b);
    expect(a).toContain('Enabled tools: create_plan, send_web_message.');
  });

  test('the create_plan restriction appears only when that tool is enabled', () => {
    expect(buildBackendGuardrails('web', ['create_plan'])).toContain(
      'create_plan is optional and restricted'
    );
    expect(buildBackendGuardrails('web', ['send_web_message'])).not.toContain(
      'create_plan is optional'
    );
  });

  test('each channel gets its own tool hint', () => {
    expect(buildBackendGuardrails('whatsapp', [])).toContain(
      'send_whatsapp* tool'
    );
    expect(buildBackendGuardrails('sms', [])).toContain(
      'send_sms_message_using_twilio'
    );
    expect(buildBackendGuardrails('playground', [])).toContain(
      'playground testing'
    );
  });

  test('an EMAIL channel takes the generic branch — the source has no email case', () => {
    const g = buildBackendGuardrails('email', ['send_email']);
    expect(g).toContain(
      'Use the appropriate outbound messaging tool to communicate with the customer.'
    );
    expect(g).toContain('Active channel: email.');
  });

  test('a pure outbound agent is told its messaging tools are "none"', () => {
    // `send_email` is NOT in OUTBOUND_MESSAGE_TOOL_NAMES — that set is inbound channel tools. The
    // block therefore insists a messaging tool must be called while reporting none exist. Ported
    // verbatim rather than rewritten: prompt text drives model behaviour and needs evals, not a guess.
    const g = buildBackendGuardrails('email', [
      'send_email',
      'make_phone_call',
    ]);
    expect(g).toContain('Enabled outbound messaging tools: none.');
    expect(g).toContain('You MUST call an outbound messaging tool');
    expect(OUTBOUND_MESSAGE_TOOL_NAMES.has('send_email')).toBe(false);
  });

  test('no enabled tools at all reads "none" on both lines', () => {
    const g = buildBackendGuardrails('web', []);
    expect(g).toContain('Enabled tools: none.');
    expect(g).toContain('Enabled outbound messaging tools: none.');
  });
});

describe('enabledOutboundTools', () => {
  test('keeps only messaging tools, sorted and deduped', () => {
    expect(
      enabledOutboundTools([
        'send_web_message',
        'send_email',
        'send_web_message',
        'send_notification_sms',
      ])
    ).toEqual(['send_notification_sms', 'send_web_message']);
  });

  test('null or empty yields an empty list', () => {
    expect(enabledOutboundTools(null)).toEqual([]);
    expect(enabledOutboundTools([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection
// ─────────────────────────────────────────────────────────────────────────────

describe('prompt injection', () => {
  test('the guardrails are PREPENDED, not appended', () => {
    const out = injectBackendGuardrails('BASE PROMPT', 'web', []) as string;
    // The prompt cannot override an instruction it has not reached yet.
    expect(out.startsWith(BACKEND_GUARDRAILS_HEADER)).toBe(true);
    expect(out.endsWith('BASE PROMPT')).toBe(true);
  });

  test('injection is IDEMPOTENT — re-entering a turn cannot stack a second copy', () => {
    const once = injectBackendGuardrails('BASE', 'web', []) as string;
    const twice = injectBackendGuardrails(once, 'web', []) as string;
    expect(twice).toBe(once);
    expect(twice.split(BACKEND_GUARDRAILS_HEADER)).toHaveLength(2);
  });

  test('the Groq policy behaves the same way', () => {
    const once = injectGroqToolUsePolicy('BASE', 'sms', []) as string;
    expect(once.startsWith(GROQ_TOOL_USE_POLICY_HEADER)).toBe(true);
    expect(injectGroqToolUsePolicy(once, 'sms', [])).toBe(once);
  });

  test('both can coexist, each injected once', () => {
    let p: unknown = 'BASE';
    p = injectBackendGuardrails(p, 'web', []);
    p = injectGroqToolUsePolicy(p, 'web', []);
    const s = p as string;
    expect(s.split(BACKEND_GUARDRAILS_HEADER)).toHaveLength(2);
    expect(s.split(GROQ_TOOL_USE_POLICY_HEADER)).toHaveLength(2);
  });

  test('a non-string prompt passes through untouched', () => {
    const obj = { blocks: [] };
    expect(injectBackendGuardrails(obj, 'web', [])).toBe(obj);
    expect(injectGroqToolUsePolicy(null, 'web', [])).toBeNull();
  });
});

describe('buildGroqToolUsePolicy', () => {
  test('restates mandatory tool use in blunter terms and names the closing text', () => {
    const p = buildGroqToolUsePolicy('web', ['send_web_message']);
    expect(p).toContain('**MANDATORY**');
    expect(p).toContain('Plain text responses are IGNORED');
    expect(p).toContain('end the turn with assistant text: Done.');
    expect(p).toContain(
      'Preferred tools for this channel: send_web_message or send_web_message_to_admin.'
    );
  });

  test('an unknown channel gets the generic preference', () => {
    expect(buildGroqToolUsePolicy('email', [])).toContain(
      'the best matching enabled outbound messaging tool'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The short-circuit kill switch
// ─────────────────────────────────────────────────────────────────────────────

describe('terminalBlockShortcircuitEnabled', () => {
  test('defaults ON when unset', () => {
    expect(terminalBlockShortcircuitEnabled()).toBe(true);
  });

  test('only the explicit off-values disable it', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      process.env.OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT = v;
      expect(terminalBlockShortcircuitEnabled()).toBe(false);
    }
  });

  test('a typo leaves it ON rather than silently reverting behaviour', () => {
    for (const v of ['flase', 'nope', '2', 'yes', '']) {
      process.env.OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT = v;
      expect(terminalBlockShortcircuitEnabled()).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toolResult plumbing
// ─────────────────────────────────────────────────────────────────────────────

describe('extractToolStatusAndMessage', () => {
  function jsonResult(payload: Record<string, unknown>) {
    return {
      role: 'user',
      content: [
        { toolResult: { toolUseId: 't1', content: [{ json: payload }] } },
      ],
    };
  }

  test('reads a json payload, lowercasing the status', () => {
    expect(
      extractToolStatusAndMessage(
        jsonResult({ status: 'BLOCKED', message: '  nope  ' })
      )
    ).toEqual(['blocked', 'nope']);
  });

  test('a text-only block yields no status and the text as the message', () => {
    expect(
      extractToolStatusAndMessage({
        role: 'user',
        content: [
          { toolResult: { toolUseId: 't1', content: [{ text: ' hello ' }] } },
        ],
      })
    ).toEqual(['', 'hello']);
  });

  test('anything malformed reads as NO VERDICT, never a throw', () => {
    // The dispatch loop branches on this; a bad payload must not crash the turn.
    for (const bad of [
      null,
      undefined,
      'string',
      42,
      {},
      { content: 'not-an-array' },
      { content: [{}] },
      { content: [{ toolResult: 'no' }] },
      { content: [{ toolResult: { content: 'no' } }] },
      { content: [{ toolResult: { content: [] } }] },
    ]) {
      expect(extractToolStatusAndMessage(bad)).toEqual(['', '']);
    }
  });

  test('missing status and message fields read as empty strings', () => {
    expect(extractToolStatusAndMessage(jsonResult({}))).toEqual(['', '']);
  });
});

describe('buildToolResultMessage', () => {
  test('a json payload becomes a json block', () => {
    const m = buildToolResultMessage('t1', { jsonPayload: { status: 'ok' } });
    const tr = (
      m as unknown as { content: { toolResult: Record<string, unknown> }[] }
    ).content[0].toolResult;
    expect(tr.toolUseId).toBe('t1');
    expect((tr.content as { json: unknown }[])[0].json).toEqual({
      status: 'ok',
    });
    expect(tr.status).toBeUndefined();
  });

  test('text is stringified, and an explicit status is attached', () => {
    const m = buildToolResultMessage('t1', { text: 'oops', status: 'error' });
    const tr = (
      m as unknown as { content: { toolResult: Record<string, unknown> }[] }
    ).content[0].toolResult;
    expect((tr.content as { text: string }[])[0].text).toBe('oops');
    expect(tr.status).toBe('error');
  });

  test('neither text nor json yields an empty text block', () => {
    const m = buildToolResultMessage('t1');
    const tr = (
      m as unknown as { content: { toolResult: Record<string, unknown> }[] }
    ).content[0].toolResult;
    expect((tr.content as { text: string }[])[0].text).toBe('');
  });
});

describe('appendToolResultMessage', () => {
  const assistantTurn = () =>
    ({
      role: 'assistant',
      content: [
        { toolUse: { toolUseId: 't1', name: 'send_email', input: {} } },
      ],
    }) as unknown as BedrockMessage;

  test('GROUPS consecutive results into ONE user message', () => {
    // Bedrock requires toolResult blocks to follow their toolUse immediately, so two tools called in
    // one assistant turn must come back as a single user turn.
    const history: BedrockMessage[] = [assistantTurn()];
    appendToolResultMessage(
      history,
      buildToolResultMessage('t1', { jsonPayload: { status: 'sent' } })
    );
    appendToolResultMessage(
      history,
      buildToolResultMessage('t2', { jsonPayload: { status: 'created' } })
    );
    expect(history).toHaveLength(2);
    const content = (history[1] as unknown as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
  });

  test('starts a new message when the previous turn was NOT a toolResult', () => {
    const history: BedrockMessage[] = [assistantTurn()];
    appendToolResultMessage(
      history,
      buildToolResultMessage('t1', { jsonPayload: {} })
    );
    history.push(assistantTurn());
    appendToolResultMessage(
      history,
      buildToolResultMessage('t2', { jsonPayload: {} })
    );
    expect(history).toHaveLength(4);
  });

  test('an empty history just receives the message', () => {
    const history: BedrockMessage[] = [];
    appendToolResultMessage(
      history,
      buildToolResultMessage('t1', { jsonPayload: {} })
    );
    expect(history).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The email-outcome stamp
// ─────────────────────────────────────────────────────────────────────────────

describe('stampEmailOutcomeOnToolCall', () => {
  function historyWithSend(toolUseId = 't1'): BedrockMessage[] {
    return [
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId,
              name: 'send_email',
              input: { to: 'a@b.com' },
            },
          },
        ],
      },
    ] as unknown as BedrockMessage[];
  }

  function input(history: BedrockMessage[]): Record<string, unknown> {
    const block = (
      history[0] as unknown as { content: Record<string, unknown>[] }
    ).content[0];
    return (block.toolUse as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
  }

  test('a DEFERRED send is labelled deferred, not delivered', () => {
    // The whole point: the inbox transformer never sees the toolResult, so without this stamp every
    // attempt renders as sent.
    const history = historyWithSend();
    stampEmailOutcomeOnToolCall(
      history,
      't1',
      buildToolResultMessage('t1', {
        jsonPayload: { status: 'deferred', reason: 'domain_budget' },
      })
    );
    expect(input(history).email_label).toEqual({ status: 'deferred' });
  });

  test('an explicit email_label is preserved and only filled in', () => {
    const history = historyWithSend();
    stampEmailOutcomeOnToolCall(
      history,
      't1',
      buildToolResultMessage('t1', {
        jsonPayload: {
          status: 'sent',
          email_label: { status: 'sent', subject: 'Hello' },
        },
      })
    );
    expect(input(history).email_label).toEqual({
      status: 'sent',
      subject: 'Hello',
    });
  });

  test('a payload with no status stamps nothing', () => {
    const history = historyWithSend();
    stampEmailOutcomeOnToolCall(
      history,
      't1',
      buildToolResultMessage('t1', { jsonPayload: { message: 'hm' } })
    );
    expect(input(history).email_label).toBeUndefined();
  });

  test('a non-matching toolUseId leaves the history alone', () => {
    const history = historyWithSend('other');
    stampEmailOutcomeOnToolCall(
      history,
      't1',
      buildToolResultMessage('t1', { jsonPayload: { status: 'sent' } })
    );
    expect(input(history).email_label).toBeUndefined();
  });

  test('a malformed result message never throws', () => {
    const history = historyWithSend();
    expect(() =>
      stampEmailOutcomeOnToolCall(
        history,
        't1',
        null as unknown as BedrockMessage
      )
    ).not.toThrow();
    expect(() =>
      stampEmailOutcomeOnToolCall(
        [],
        't1',
        buildToolResultMessage('t1', { jsonPayload: { status: 'sent' } })
      )
    ).not.toThrow();
  });

  test('the LATEST matching assistant turn wins', () => {
    const history = [
      ...historyWithSend('t1'),
      ...historyWithSend('t1'),
    ] as BedrockMessage[];
    stampEmailOutcomeOnToolCall(
      history,
      't1',
      buildToolResultMessage('t1', { jsonPayload: { status: 'blocked' } })
    );
    const second = (
      history[1] as unknown as { content: Record<string, unknown>[] }
    ).content[0];
    const label = (
      (second.toolUse as Record<string, unknown>).input as Record<
        string,
        unknown
      >
    ).email_label;
    expect(label).toEqual({ status: 'blocked' });
    // The earlier turn is untouched — searching backwards stops at the first match.
    expect(input(history).email_label).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Message building and knowledge sources
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessage', () => {
  test('encodes the sender envelope the prompt branches on', () => {
    const [msg] = buildMessage(null, 'hello there', {
      from: 'Admin',
      userType: 'human',
    });
    const text = (msg as unknown as { content: { text: string }[] }).content[0]
      .text;
    // The model must be able to tell a customer reply from a human @ai instruction.
    expect(JSON.parse(text)).toEqual({
      from: 'Admin',
      userType: 'human',
      text: 'hello there',
    });
  });

  test('defaults to a customer sender', () => {
    const [msg] = buildMessage([], 'hi', {});
    const text = (msg as unknown as { content: { text: string }[] }).content[0]
      .text;
    expect(JSON.parse(text)).toMatchObject({
      from: 'user',
      userType: 'customer',
    });
  });

  test('COPIES the history rather than mutating the caller’s list', () => {
    const history = [
      { role: 'user', content: [{ text: 'earlier' }] },
    ] as unknown as BedrockMessage[];
    const out = buildMessage(history, 'later', {});
    expect(out).toHaveLength(2);
    expect(history).toHaveLength(1);
  });
});

describe('getKnowledgeSources', () => {
  test('returns the formatted sources', async () => {
    promptData.mockResolvedValue({ knowledge_sources: 'FAQ: ...' });
    expect(await getKnowledgeSources('agentA')).toBe('FAQ: ...');
  });

  test('the sentinel and an empty value both normalise to the sentinel', async () => {
    promptData.mockResolvedValue({
      knowledge_sources: 'No knowledge sources found',
    });
    expect(await getKnowledgeSources('agentA')).toBe(
      'No knowledge sources found'
    );
    promptData.mockResolvedValue({ knowledge_sources: '' });
    expect(await getKnowledgeSources('agentA')).toBe(
      'No knowledge sources found'
    );
  });
});

describe('resolveProviderForTurn', () => {
  test('resolves a provider for an assigned model, and for none', () => {
    expect(
      typeof resolveProviderForTurn({ assigned_model: 'gpt-oss-120b' })
    ).toBe('string');
    expect(typeof resolveProviderForTurn(null)).toBe('string');
  });
});
