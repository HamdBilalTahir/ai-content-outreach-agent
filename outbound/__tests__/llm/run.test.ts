/**
 * @jest-environment node
 *
 * The tool-dispatch loop.
 *
 * A turn is where side effects happen, so the tests are about what must never be LOST or DUPLICATED:
 *
 *  - **A generation failure persists what already ran.** Tools in earlier iterations really sent emails
 *    and placed calls; a mid-turn provider blip must not erase their record from the conversation.
 *  - **The rapid queue is drained TWICE**, and the second drain is a race fix: a message arriving between
 *    the first drain and `end_turn` must re-open the turn, not be answered next time or never. The two
 *    drains differ deliberately in whether they discard a half-formed assistant reply.
 *  - **An unknown tool gets one error result and the turn continues** — the source's own fallthrough, and
 *    what an inbound tool leaking through an agent config must do here.
 *  - **The short-circuit ends only fully-gated `@ai` turns.** A genuine FAILURE must keep the loop alive
 *    so the model can react, and a customer-facing turn must always get its reply.
 *  - **`send_email`'s outcome is stamped before the result is appended**, or the inbox shows a deferred
 *    email as delivered.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../llm/ask', () => {
  const actual = jest.requireActual('../../llm/ask');
  return { ...actual, generateText: jest.fn() };
});
jest.mock('../../firebase/chat', () => {
  const actual = jest.requireActual('../../firebase/chat');
  return {
    ...actual,
    getRapidQueue: jest.fn(),
    clearRapidQueue: jest.fn(),
    logLlmUsage: jest.fn(),
    addMessagesToChat: jest.fn(),
  };
});
jest.mock('../../tools/email', () => ({ parseAndRunSendEmail: jest.fn() }));
jest.mock('../../tools/makePhoneCall', () => ({
  parseAndRunMakePhoneCall: jest.fn(),
  parseAndRunMakePhoneCallFromNumber: jest.fn(),
}));
jest.mock('../../tools/reviewCallTranscript', () => ({
  parseAndRunReviewCallTranscript: jest.fn(),
}));
jest.mock('../../tools/taskTools', () => ({
  parseAndRunCreateCustomTask: jest.fn(),
  parseAndRunUpdateCustomTask: jest.fn(),
  parseAndRunDeleteCustomTask: jest.fn(),
}));
jest.mock('../../tools/stageTools', () => ({
  parseAndRunMarkProspectLost: jest.fn(),
  parseAndRunMarkCadenceComplete: jest.fn(),
  parseAndRunClearNotInterested: jest.fn(),
}));

import { generateText } from '../../llm/ask';
import {
  addMessagesToChat,
  clearRapidQueue,
  getRapidQueue,
  logLlmUsage,
} from '../../firebase/chat';
import { parseAndRunSendEmail } from '../../tools/email';
import { parseAndRunMakePhoneCall } from '../../tools/makePhoneCall';
import { parseAndRunCreateCustomTask } from '../../tools/taskTools';
import { dispatchableToolNames, withTools } from '../../llm/run';
import type { BedrockMessage } from '../../types';

const gen = generateText as jest.Mock;
const rapidQueue = getRapidQueue as jest.Mock;
const clearQueue = clearRapidQueue as jest.Mock;
const usageLog = logLlmUsage as jest.Mock;
const persist = addMessagesToChat as jest.Mock;
const sendEmail = parseAndRunSendEmail as jest.Mock;
const makeCall = parseAndRunMakePhoneCall as jest.Mock;
const createTask = parseAndRunCreateCustomTask as jest.Mock;

const CHAT = 'outbound__agentA__15551230000';
const AGENT = 'agentA';

const NO_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  cache_read_input_tokens: 0,
  cache_write_input_tokens: 0,
};

/** A model turn that just talks. */
function endTurn(text = 'All done') {
  return {
    stopReason: 'end_turn',
    toolsRequested: [],
    payload: { role: 'assistant', content: [{ text }] },
    tokenUsage: NO_USAGE,
  };
}

/**
 * A model turn that asks for one or more tools.
 *
 * Emulates the real `generateText` contract faithfully: on `tool_use` it PUSHES the assistant turn onto
 * the caller's message list and returns that list as the payload. Without the push, the history would
 * never contain the `toolUse` block, and `stampEmailOutcomeOnToolCall` would have nothing to find — the
 * tests would pass while proving nothing.
 */
function toolUse(
  specs: Array<{ id: string; name: string; input?: Record<string, unknown> }>
) {
  const blocks = specs.map((s) => ({
    toolUse: { toolUseId: s.id, name: s.name, input: s.input ?? {} },
  }));
  return (messages: BedrockMessage[]) => {
    messages.push({
      role: 'assistant',
      content: blocks,
    } as unknown as BedrockMessage);
    return {
      stopReason: 'tool_use',
      toolsRequested: blocks,
      payload: messages,
      tokenUsage: NO_USAGE,
    };
  };
}

/** Queue model responses in order; thunks receive the live message list. */
function modelSays(
  ...responses: Array<
    ReturnType<typeof endTurn> | ReturnType<typeof toolUse> | object
  >
) {
  let i = 0;
  gen.mockImplementation(async (_sp: string, messages: BedrockMessage[]) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === 'function'
      ? (r as (m: BedrockMessage[]) => unknown)(messages)
      : r;
  });
}

/** One tool, the common case. */
function oneTool(name: string, input: Record<string, unknown> = {}, id = 't1') {
  return toolUse([{ id, name, input }]);
}

/** A toolResult as a handler returns it. */
function result(id: string, json: Record<string, unknown>): BedrockMessage {
  return {
    role: 'user',
    content: [{ toolResult: { toolUseId: id, content: [{ json }] } }],
  } as unknown as BedrockMessage;
}

async function run(over: Record<string, unknown> = {}) {
  return withTools({
    systemPrompt: 'BASE PROMPT',
    inputText: 'hello',
    chatHistory: [],
    accountId: 'acct',
    attendeeId: 'attend',
    agentId: AGENT,
    metaData: {
      chat_id: CHAT,
      channel: 'email',
      enabled_functions: [],
      ...over,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GROQ_MAX_TOOL_ITERATIONS;
  delete process.env.OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT;
  rapidQueue.mockResolvedValue([]);
  usageLog.mockResolvedValue(undefined);
  persist.mockResolvedValue([]);
  sendEmail.mockResolvedValue(result('t1', { status: 'sent' }));
  makeCall.mockResolvedValue(result('t1', { status: 'initiated' }));
  createTask.mockResolvedValue(result('t1', { status: 'created' }));
});

// ─────────────────────────────────────────────────────────────────────────────
// The dispatch table
// ─────────────────────────────────────────────────────────────────────────────

describe('the dispatch table', () => {
  test('covers exactly the tools this runtime has ported', () => {
    expect(dispatchableToolNames()).toEqual([
      'clear_not_interested',
      'create_custom_task',
      'delete_custom_task',
      'escalate_to_human',
      'get_hubspot_available_slots',
      'make_phone_call',
      'make_phone_call_from_number',
      'mark_cadence_complete',
      'mark_prospect_lost',
      'review_call_transcript',
      'schedule_hubspot_meeting',
      'send_email',
      'update_custom_task',
    ]);
  });

  test('dispatches a known tool and feeds the result back', async () => {
    modelSays(oneTool('send_email', { to: 'a@b.com' }), endTurn());
    const [entries] = (await run())!;
    // objectContaining, because the outcome stamp MUTATES the very input object the handler received —
    // so jest's recorded arguments gain `email_label` after the call returns. Harmless in production
    // (the tool has already run), but a real trap for exact-match assertions.
    expect(sendEmail).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ to: 'a@b.com' }),
      expect.objectContaining({ chat_id: CHAT })
    );
    // user input, the assistant toolUse turn, the toolResult, then the terminal "Done".
    expect(entries).toHaveLength(4);
    expect(entries[3]).toEqual({
      role: 'assistant',
      content: [{ text: 'Done' }],
    });
  });

  test('an UNKNOWN tool gets one error result and the turn continues', async () => {
    // An inbound tool leaked in by an agent config, or one the model invented.
    modelSays(oneTool('send_whatsapp_message'), endTurn());
    const [entries] = (await run())!;
    const resultEntry = entries.find((e) =>
      (
        (e as unknown as { content?: Record<string, unknown>[] }).content ?? []
      ).some((b) => 'toolResult' in b)
    ) as unknown as {
      content: {
        toolResult: { content: { json: Record<string, unknown> }[] };
      }[];
    };
    const payload = resultEntry.content[0].toolResult.content[0].json;
    expect(payload.status).toBe('error');
    expect(String(payload.message)).toContain(
      'not implemented by this runtime'
    );
    // The loop kept going — the model gets a chance to react.
    expect(gen).toHaveBeenCalledTimes(2);
  });

  test('several tools in ONE assistant turn come back as one grouped user message', async () => {
    // Bedrock requires toolResult blocks to follow their toolUse immediately.
    modelSays(
      toolUse([
        { id: 't1', name: 'send_email' },
        { id: 't2', name: 'create_custom_task' },
      ]),
      endTurn()
    );
    createTask.mockResolvedValue(result('t2', { status: 'created' }));
    const [entries] = (await run())!;
    const groupedEntry = entries.find((e) =>
      (
        (e as unknown as { content?: Record<string, unknown>[] }).content ?? []
      ).some((b) => 'toolResult' in b)
    ) as unknown as { content: unknown[] };
    expect(groupedEntry.content).toHaveLength(2);
  });

  test('a tool call is counted in session usage', async () => {
    modelSays(
      oneTool('send_email'),
      oneTool('send_email', {}, 't2'),
      endTurn()
    );
    const [, usage] = (await run())!;
    expect(usage.tools.send_email).toBe(2);
    expect(usage.tokens.input).toBe(30); // three generate calls
    expect(usage.tokens.output).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// end_turn
// ─────────────────────────────────────────────────────────────────────────────

describe('ending a turn', () => {
  test('with no tool call, the model’s own message is kept', async () => {
    gen.mockResolvedValueOnce(endTurn('Here is my answer'));
    const [entries] = (await run())!;
    expect(entries[entries.length - 1]).toEqual({
      role: 'assistant',
      content: [{ text: 'Here is my answer' }],
    });
  });

  test('after a tool call, the terminal text is "Done"', async () => {
    // The Bedrock chat pattern the rest of the stack expects.
    modelSays(oneTool('send_email'), endTurn('I sent it!'));
    const [entries] = (await run())!;
    expect(entries[entries.length - 1]).toEqual({
      role: 'assistant',
      content: [{ text: 'Done' }],
    });
  });

  test('only the entries this turn ADDED are returned', async () => {
    gen.mockResolvedValueOnce(endTurn());
    const history = [
      { role: 'user', content: [{ text: 'older' }] },
      { role: 'assistant', content: [{ text: 'earlier' }] },
    ] as unknown as BedrockMessage[];
    const [entries] = (await withTools({
      systemPrompt: 'P',
      inputText: 'hi',
      chatHistory: history,
      metaData: { chat_id: CHAT },
    }))!;
    // The caller persists exactly the delta.
    expect(entries).toHaveLength(2);
  });

  test('usage is logged for the response and for each tool call', async () => {
    modelSays(oneTool('send_email'), endTurn());
    await run();
    const actions = usageLog.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(['send_email', 'response_generation']);
  });

  test('the guardrails reach the model in the system prompt', async () => {
    gen.mockResolvedValueOnce(endTurn());
    await run();
    expect(String(gen.mock.calls[0][0])).toContain(
      '[BACKEND_SYSTEM_GUARDRAILS]'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rapid queue
// ─────────────────────────────────────────────────────────────────────────────

describe('the rapid queue', () => {
  test('DRAIN 1 folds a message that arrived while the model was thinking', async () => {
    rapidQueue.mockResolvedValueOnce([
      { from: 'Jane', userType: 'customer', message: 'actually, wait' },
    ]);
    rapidQueue.mockResolvedValue([]);
    gen.mockResolvedValueOnce(endTurn('stale reply'));
    gen.mockResolvedValueOnce(endTurn('fresh reply'));
    const [entries] = (await run())!;
    // The turn re-opened rather than replying to a stale view.
    expect(gen).toHaveBeenCalledTimes(2);
    expect(clearQueue).toHaveBeenCalledWith(CHAT);
    expect(JSON.stringify(entries)).toContain('actually, wait');
    expect(JSON.stringify(entries)).not.toContain('stale reply');
  });

  test('DRAIN 1 runs BEFORE dispatch, so a queued message ABANDONS the pending tool call', async () => {
    // This is what the assistant-pop is for: drain 1 sits between generateText and the dispatch, so a
    // message arriving in that window discards the model's tool REQUEST rather than executing it
    // against a conversation the customer has already moved on from.
    modelSays(oneTool('send_email'), endTurn('answering the new message'));
    rapidQueue.mockResolvedValueOnce([{ message: 'actually never mind' }]);
    rapidQueue.mockResolvedValue([]);
    const [entries] = (await run())!;

    // The email was never sent, and the abandoned toolUse turn is not in the history.
    expect(sendEmail).not.toHaveBeenCalled();
    const hasToolUse = entries.some((e) =>
      (
        (e as unknown as { content?: Record<string, unknown>[] }).content ?? []
      ).some((b) => 'toolUse' in b)
    );
    expect(hasToolUse).toBe(false);
    expect(JSON.stringify(entries)).toContain('actually never mind');
    // And because no tool ran, the terminal text is the model's own answer, not "Done".
    expect(entries[entries.length - 1]).toEqual({
      role: 'assistant',
      content: [{ text: 'answering the new message' }],
    });
  });

  test('DRAIN 2 is the race fix: a message landing at end_turn re-opens the turn', async () => {
    // Nothing queued at drain 1; something queued by the time end_turn is handled.
    rapidQueue.mockResolvedValueOnce([]);
    rapidQueue.mockResolvedValueOnce([{ message: 'late arrival' }]);
    rapidQueue.mockResolvedValue([]);
    gen.mockResolvedValueOnce(endTurn('answer to the old message'));
    gen.mockResolvedValueOnce(endTurn('answer to the late one'));
    const [entries] = (await run())!;
    expect(gen).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(entries)).toContain('late arrival');
    // Without this drain, that message would be answered only next turn — or never.
    expect(JSON.stringify(entries)).toContain('answer to the late one');
  });

  test('queued messages are folded as the same JSON envelope as normal input', async () => {
    rapidQueue.mockResolvedValueOnce([
      { from: 'Admin', userType: 'human', message: '@ai call now' },
    ]);
    rapidQueue.mockResolvedValue([]);
    gen.mockResolvedValueOnce(endTurn());
    gen.mockResolvedValueOnce(endTurn());
    const [entries] = (await run())!;
    const userEntry = entries.find(
      (e) => (e as { role: string }).role === 'user'
    ) as unknown as { content: { text: string }[] };
    const folded = userEntry.content.map((b) => JSON.parse(b.text));
    expect(folded[folded.length - 1]).toEqual({
      from: 'Admin',
      userType: 'human',
      text: '@ai call now',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe('a generation failure', () => {
  test('PERSISTS what already ran, then re-raises', async () => {
    // The email really was sent; its record must survive the provider blip.
    let call = 0;
    gen.mockImplementation(async (_sp: string, messages: BedrockMessage[]) => {
      call += 1;
      if (call === 1) return oneTool('send_email')(messages);
      throw new Error('provider 503');
    });
    await expect(run()).rejects.toThrow('provider 503');
    expect(persist).toHaveBeenCalledTimes(1);
    const [chatId, entries] = persist.mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect((entries as unknown[]).length).toBeGreaterThan(0);
  });

  test('a failure on the FIRST call still re-raises, with only the input to persist', async () => {
    gen.mockRejectedValueOnce(new Error('boom'));
    await expect(run()).rejects.toThrow('boom');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test('a persistence failure does not mask the original error', async () => {
    gen.mockRejectedValueOnce(new Error('provider 503'));
    persist.mockRejectedValue(new Error('firestore down'));
    await expect(run()).rejects.toThrow('provider 503');
  });

  test('an unexpected stop reason returns UNDEFINED, not a result', async () => {
    // The source returns bare from inside the loop; callers must handle it.
    gen.mockResolvedValueOnce({
      stopReason: 'max_tokens',
      toolsRequested: [],
      payload: { role: 'assistant', content: [] },
      tokenUsage: NO_USAGE,
    });
    expect(await run()).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The short-circuit
// ─────────────────────────────────────────────────────────────────────────────

describe('the by-design-gate short-circuit', () => {
  /** A gated toolResult, the shape `turnIsByDesignGated` recognises. */
  function gated(id = 't1') {
    return result(id, {
      status: 'skipped',
      reason: 'phone_opt_out',
      message: 'contact opted out',
    });
  }

  test('an @ai turn where every tool was gated ends WITHOUT another round-trip', async () => {
    modelSays(oneTool('make_phone_call'), endTurn());
    makeCall.mockResolvedValue(gated());
    const res = await run({ is_admin_trigger: true });
    const [entries] = res!;
    // One generate call only — the redundant acknowledgement is never requested.
    expect(gen).toHaveBeenCalledTimes(1);
    expect(entries[entries.length - 1]).toEqual({
      role: 'assistant',
      content: [{ text: 'Done' }],
    });
  });

  test('a CUSTOMER-facing turn is never short-circuited — it always gets a reply', async () => {
    modelSays(oneTool('make_phone_call'), endTurn('Sorry about that'));
    makeCall.mockResolvedValue(gated());
    await run(); // no is_admin_trigger
    expect(gen).toHaveBeenCalledTimes(2);
  });

  test('a GENUINE failure keeps the loop alive so the model can react', async () => {
    modelSays(oneTool('make_phone_call'), endTurn());
    makeCall.mockResolvedValue(
      result('t1', { status: 'failed', message: 'provider down' })
    );
    await run({ is_admin_trigger: true });
    // Not a by-design gate, so the turn continues and the failure reaches the chat.
    expect(gen).toHaveBeenCalledTimes(2);
  });

  test('the kill switch restores the extra round-trip', async () => {
    process.env.OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT = '0';
    modelSays(oneTool('make_phone_call'), endTurn());
    makeCall.mockResolvedValue(gated());
    await run({ is_admin_trigger: true });
    expect(gen).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The email outcome stamp
// ─────────────────────────────────────────────────────────────────────────────

describe('the send_email outcome stamp', () => {
  test('a DEFERRED send is stamped onto the assistant toolUse input', async () => {
    // Without this, the inbox transformer — which never sees the toolResult — shows it as delivered.
    modelSays(
      toolUse([{ id: 't1', name: 'send_email', input: { to: 'a@b.com' } }]),
      endTurn()
    );
    sendEmail.mockResolvedValue(
      result('t1', { status: 'deferred', reason: 'domain_budget' })
    );
    const [entries] = (await run())!;
    // Find the assistant turn holding the toolUse and read the stamp off its input.
    const assistantWithTool = entries.find((e) =>
      (
        (e as unknown as { content?: Record<string, unknown>[] }).content ?? []
      ).some((b) => 'toolUse' in b)
    ) as unknown as { content: Record<string, unknown>[] };
    const stamped = (
      (assistantWithTool.content[0].toolUse as Record<string, unknown>)
        .input as Record<string, unknown>
    ).email_label;
    expect(stamped).toEqual({ status: 'deferred' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Groq loop guard
// ─────────────────────────────────────────────────────────────────────────────

describe('the Groq loop guard', () => {
  test('is DISABLED by default, so a long tool chain is allowed', async () => {
    modelSays(
      oneTool('send_email'),
      oneTool('send_email', {}, 't2'),
      oneTool('send_email', {}, 't3'),
      endTurn()
    );
    await run();
    expect(gen).toHaveBeenCalledTimes(4);
  });

  test('a configured cap ends the turn on a Groq provider only', async () => {
    process.env.GROQ_MAX_TOOL_ITERATIONS = '2';
    modelSays(oneTool('send_email'));
    // A non-Groq turn ignores the cap entirely, so drive one that IS Groq.
    const res = await run({ assigned_model: 'openai/gpt-oss-120b' });
    const [entries] = res!;
    expect(gen).toHaveBeenCalledTimes(2);
    expect(entries[entries.length - 1]).toEqual({
      role: 'assistant',
      content: [{ text: 'Done' }],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The SMS strip
// ─────────────────────────────────────────────────────────────────────────────

describe('the oversee SMS strip', () => {
  test('removes the direct SMS tool when the handoff flow is enabled', async () => {
    gen.mockResolvedValueOnce(endTurn());
    await run({
      enabled_functions: [
        'handle_sms_conversation',
        'send_sms_message_using_twilio',
        'send_email',
      ],
    });
    // Sending SMS directly bypasses the handoff and breaks reply routing.
    expect(gen.mock.calls[0][2]).toEqual([
      'handle_sms_conversation',
      'send_email',
    ]);
  });

  test('a SKILL that explicitly enabled the direct tool overrides the strip', async () => {
    gen.mockResolvedValueOnce(endTurn());
    await run({
      enabled_functions: [
        'handle_sms_conversation',
        'send_sms_message_using_twilio',
      ],
      skill_enabled_tools: ['send_sms_message_using_twilio'],
    });
    expect(gen.mock.calls[0][2]).toContain('send_sms_message_using_twilio');
  });
});
