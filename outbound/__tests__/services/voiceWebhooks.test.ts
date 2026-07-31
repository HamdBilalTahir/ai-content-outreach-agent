/**
 * @jest-environment node
 *
 * The two ElevenLabs voice webhooks.
 *
 * What these tests exist to protect:
 *
 *  - **The OPPOSITE signature policies.** Post-call verifies and refuses; conversation-init logs and
 *    proceeds. Hard-failing the pre-call webhook returned an empty payload in production and the agent
 *    answered with its generic opener, losing all caller context — so "never blocks" is asserted with a
 *    deliberately invalid signature.
 *  - **The three resolution tiers**, in durability order, and that the last one never MINTS a chat. An
 *    unmatched webhook must be a no-op.
 *  - **The transcript is stored from the webhook's OWN payload** before the review task is scheduled.
 *    That ordering is what stops the review racing a re-fetch that returns an empty turn array and
 *    scoring a real conversation as voicemail.
 *  - **Every response is a 200-shaped body.** A retryable-looking failure would make the provider
 *    redeliver, and none of these failures are retryable.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/elevenlabs', () => ({
  ELEVENLABS_BASE_API: 'https://api.elevenlabs.io',
  fetchConversationFromElevenlabs: jest.fn(),
  outboundPostCallWebhookId: () => 'wh_1',
}));
jest.mock('../../services/voiceRouting', () => ({
  resolveOutboundAgentId: jest.fn(),
  resolveOutboundAgentForInbound: jest.fn(),
  extractCustomerPhone: jest.fn(),
}));
jest.mock('../../services/callScope', () => ({
  buildOutboundCallScope: jest.fn(),
  inboundCallContext: jest.fn(),
}));
jest.mock('../../services/voiceConcurrency', () => ({
  releaseVoiceSlot: jest.fn(),
}));

import { createHmac } from 'node:crypto';

import { store } from '../../testSupport/mockFirestore';
import { fetchConversationFromElevenlabs } from '../../services/elevenlabs';
import {
  extractCustomerPhone,
  resolveOutboundAgentForInbound,
  resolveOutboundAgentId,
} from '../../services/voiceRouting';
import {
  buildOutboundCallScope,
  inboundCallContext,
} from '../../services/callScope';
import { releaseVoiceSlot } from '../../services/voiceConcurrency';
import { buildDeterministicChatId } from '../../services/chat';
import {
  handleConversationInitWebhook,
  handlePostCallWebhook,
  verifyElevenlabsSignature,
} from '../../services/voiceWebhooks';

const AGENT = 'agentA';
const PHONE = '+15551230000';
const CALL = 'conv_abc';
const CHAT = `outbound__${buildDeterministicChatId(AGENT, PHONE)}`;

const fetchConv = fetchConversationFromElevenlabs as jest.Mock;
const resolveAgentId = resolveOutboundAgentId as jest.Mock;
const resolveAgentInbound = resolveOutboundAgentForInbound as jest.Mock;
const extractPhone = extractCustomerPhone as jest.Mock;
const buildScope = buildOutboundCallScope as jest.Mock;
const inboundCtx = inboundCallContext as jest.Mock;
const releaseSlot = releaseVoiceSlot as jest.Mock;

/** No secret configured, so the signature check is a warn-and-proceed. */
const UNSIGNED = { signature: null, rawBody: '{}' };

function seedChat(over: Record<string, unknown> = {}) {
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    stage: 'Contacted',
    memory: {
      agent_id: AGENT,
      phone_number: PHONE,
      first_name: 'Jane',
      record_type: 'Real',
      ...((over.memory as Record<string, unknown>) ?? {}),
    },
    ...over,
  });
}

function postCallPayload(over: Record<string, unknown> = {}) {
  return {
    type: 'post_call_transcription',
    data: {
      conversation_id: CALL,
      transcript: [
        { role: 'agent', message: 'Hi Jane' },
        { role: 'user', message: 'Hello' },
      ],
      ...over,
    },
  };
}

function tasks(): Record<string, unknown>[] {
  return store
    .paths(`chats/${CHAT}/tasks`)
    .map((p) => store.get(p) as Record<string, unknown>);
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  delete process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  fetchConv.mockResolvedValue({
    analysis: { transcript_summary: 'Jane agreed to a demo.' },
    transcript: [{ role: 'agent', message: 'Hi Jane' }],
  });
  resolveAgentId.mockResolvedValue(AGENT);
  extractPhone.mockReturnValue(PHONE);
  resolveAgentInbound.mockResolvedValue(AGENT);
  buildScope.mockResolvedValue('FACTS: Jane, Contacted');
  inboundCtx.mockResolvedValue({
    call_type: 'INBOUND_KNOWN',
    stage: 'Contacted',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyElevenlabsSignature', () => {
  test('no secret configured processes with a warning', () => {
    // A fresh deployment that has not set a secret must not be silently deaf to every call.
    expect(verifyElevenlabsSignature(UNSIGNED)).toBe(true);
  });

  test('a valid signature over "{t}.{rawBody}" passes', () => {
    process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET = 'sekrit';
    const rawBody = '{"a":1}';
    const ts = '1700000000';
    const sig = createHmac('sha256', 'sekrit')
      .update(`${ts}.${rawBody}`)
      .digest('hex');
    expect(
      verifyElevenlabsSignature({ signature: `t=${ts},v0=${sig}`, rawBody })
    ).toBe(true);
  });

  test('a tampered body fails', () => {
    process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET = 'sekrit';
    const ts = '1700000000';
    const sig = createHmac('sha256', 'sekrit')
      .update(`${ts}.{"a":1}`)
      .digest('hex');
    expect(
      verifyElevenlabsSignature({
        signature: `t=${ts},v0=${sig}`,
        rawBody: '{"a":2}',
      })
    ).toBe(false);
  });

  test('a missing or malformed header fails when a secret IS set', () => {
    process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET = 'sekrit';
    expect(verifyElevenlabsSignature({ signature: '', rawBody: '{}' })).toBe(
      false
    );
    expect(
      verifyElevenlabsSignature({ signature: 'garbage', rawBody: '{}' })
    ).toBe(false);
  });

  test('a wrong-length signature is rejected without throwing', () => {
    // Constant-time compare throws on length mismatch, so the length is guarded first.
    process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET = 'sekrit';
    expect(
      verifyElevenlabsSignature({ signature: 't=1,v0=ab', rawBody: '{}' })
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-call: dispatch and resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('post-call dispatch', () => {
  test('an unrecognised webhook type is ignored', async () => {
    const r = await handlePostCallWebhook(
      { type: 'something_else', data: { conversation_id: CALL } },
      UNSIGNED
    );
    expect(r).toEqual({ status: 'ignored', type: 'something_else' });
  });

  test('a missing conversation_id is an error body, not a throw', async () => {
    const r = await handlePostCallWebhook({ type: '' }, UNSIGNED);
    expect(r).toEqual({ status: 'error', message: 'no conversation_id' });
  });

  test('an invalid signature refuses, because this handler MUTATES', async () => {
    process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET = 'sekrit';
    const r = await handlePostCallWebhook(postCallPayload(), {
      signature: 't=1,v0=deadbeef',
      rawBody: '{}',
    });
    expect(r).toEqual({ status: 'error', message: 'invalid signature' });
  });
});

describe('post-call chat resolution', () => {
  test('tier 1: the pending_call doc', async () => {
    seedChat();
    store.set(`pending_calls/${CALL}`, { chat_id: CHAT, agent_id: AGENT });
    const r = await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(r).toEqual({ status: 'ok', matched: true, chat_id: CHAT });
  });

  test('tier 2: the durable call index, when pending_calls is already gone', async () => {
    seedChat();
    store.set(`outbound_call_index/${CALL}`, {
      chat_id: CHAT,
      agent_id: AGENT,
    });
    const r = await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(r.matched).toBe(true);
    expect(r.chat_id).toBe(CHAT);
  });

  test('tier 3: agent + customer number, when the chat already exists', async () => {
    seedChat();
    const r = await handlePostCallWebhook(
      postCallPayload({ metadata: { phone_call: { external_number: PHONE } } }),
      UNSIGNED
    );
    expect(r.matched).toBe(true);
    expect(r.chat_id).toBe(CHAT);
  });

  test('tier 3 NEVER mints a chat — an unknown number is simply unmatched', async () => {
    // No seeded chat. The reconstructed id must be confirmed to exist, not created.
    const r = await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(r).toEqual({ status: 'ok', matched: false });
    expect(store.get(`chats/${CHAT}`)).toBeUndefined();
    expect(tasks()).toHaveLength(0);
  });

  test('a non-outbound chat is not touched', async () => {
    store.set(`chats/${CHAT}`, { type: 'web', memory: {} });
    store.set(`pending_calls/${CALL}`, { chat_id: CHAT });
    const r = await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(r.matched).toBe(false);
    expect(tasks()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-call: the side effects, and their order
// ─────────────────────────────────────────────────────────────────────────────

describe('post-call side effects', () => {
  beforeEach(() => {
    seedChat();
    store.set(`pending_calls/${CALL}`, { chat_id: CHAT, agent_id: AGENT });
  });

  test('the transcript from the webhook payload is stored for the review to read', async () => {
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    const stored = store.get(`elevenlabs_conversations/${CALL}`);
    // The webhook's OWN payload — the copy that cannot race an empty re-fetch.
    expect(stored?.transcript).toBe('AI: Hi Jane\nHUMAN: Hello');
    expect(stored?.summary).toBe('Jane agreed to a demo.');
    expect(typeof stored?.stored_at).toBe('string');
  });

  test('the provider transcript is the fallback when the payload has none', async () => {
    await handlePostCallWebhook(
      { type: 'post_call_transcription', data: { conversation_id: CALL } },
      UNSIGNED
    );
    expect(store.get(`elevenlabs_conversations/${CALL}`)?.transcript).toBe(
      'AI: Hi Jane'
    );
  });

  test('the watchdog fallback is cancelled — this webhook IS the completion signal', async () => {
    store.set(`chats/${CHAT}/tasks/t_watchdog`, {
      type: 'check_if_call_succeeded',
      executed: false,
      data: {},
    });
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(tasks().some((t) => t.type === 'check_if_call_succeeded')).toBe(
      false
    );
  });

  test('exactly ONE review continuation is scheduled, carrying the call id', async () => {
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    const cont = tasks().filter(
      (t) => t.type === 'call_completion_continuation'
    );
    expect(cont).toHaveLength(1);
    const d = cont[0].data as Record<string, unknown>;
    expect(d.call_id).toBe(CALL);
    expect(d.task_source).toBe('elevenlabs_outbound_call_completion');
    expect(String(d.notes)).toContain(CALL);
    expect(String(d.notes)).toContain('review_call_transcript');
  });

  test('a re-delivered webhook does not STACK a second review turn', async () => {
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    store.set(`pending_calls/${CALL}`, { chat_id: CHAT, agent_id: AGENT });
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(
      tasks().filter((t) => t.type === 'call_completion_continuation')
    ).toHaveLength(1);
  });

  test('a TEST record reviews immediately; a real record gets a settle window', async () => {
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    const realAt = (
      tasks().find((t) => t.type === 'call_completion_continuation')!
        .execute_at as Date
    ).getTime();
    expect(realAt).toBeGreaterThan(Date.now() + 30_000);

    store.reset();
    seedChat({ memory: { record_type: 'Test' } });
    store.set(`pending_calls/${CALL}`, { chat_id: CHAT, agent_id: AGENT });
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    const testAt = (
      tasks().find((t) => t.type === 'call_completion_continuation')!
        .execute_at as Date
    ).getTime();
    expect(testAt).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  test('the durable index is dropped and the voice slot released', async () => {
    store.set(`outbound_call_index/${CALL}`, { chat_id: CHAT });
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(store.get(`outbound_call_index/${CALL}`)).toBeUndefined();
    expect(releaseSlot).toHaveBeenCalledWith(CHAT);
  });

  test('the messages_v3 call card is filled in with the real summary', async () => {
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      content: { callId: CALL, outcome: 'initiated', summary: '' },
    });
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    const card = store.get(`chats/${CHAT}/messages_v3/m1`)?.content as Record<
      string,
      unknown
    >;
    expect(card.outcome).toBe('completed');
    expect(card.summary).toBe('Jane agreed to a demo.');
  });

  test('an initiation FAILURE records the reason and never fetches a transcript', async () => {
    const r = await handlePostCallWebhook(
      {
        type: 'call_initiation_failure',
        data: { conversation_id: CALL, failure_reason: 'invalid_number' },
      },
      UNSIGNED
    );
    expect(r.matched).toBe(true);
    expect(fetchConv).not.toHaveBeenCalled();
    // No transcript exists to store for a call that never connected.
    expect(store.get(`elevenlabs_conversations/${CALL}`)).toBeUndefined();
    // But the review is still scheduled, so the chat is not left frozen.
    expect(tasks().some((t) => t.type === 'call_completion_continuation')).toBe(
      true
    );
  });

  test('an INBOUND call with no outbound card to flip gets its own received card', async () => {
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    const v3 = store
      .paths(`chats/${CHAT}/messages_v3`)
      .map((p) => store.get(p)!);
    // Nothing outbound placed this call, so the dedicated INBOUND builder writes the card — which is
    // why it lands as direction=inbound from the customer, not as an outbound make_phone_call card.
    expect(v3).toHaveLength(1);
    expect(v3[0].type).toBe('call');
    expect(v3[0].direction).toBe('inbound');
    expect((v3[0].sender as Record<string, unknown>).kind).toBe('customer');
    const content = v3[0].content as Record<string, unknown>;
    expect(content.callId).toBe(CALL);
    expect(content.summary).toBe('Jane agreed to a demo.');
  });

  test('a re-delivered inbound webhook cannot DUPLICATE the received card', async () => {
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    store.set(`pending_calls/${CALL}`, { chat_id: CHAT, agent_id: AGENT });
    await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    // Guarded on "no card for this call id yet".
    expect(store.paths(`chats/${CHAT}/messages_v3`)).toHaveLength(1);
  });

  test('the review is still scheduled when the card update throws', async () => {
    // The card work is best-effort; losing it must not cost the review turn.
    fetchConv.mockRejectedValue(new Error('provider down'));
    const r = await handlePostCallWebhook(postCallPayload(), UNSIGNED);
    expect(r.matched).toBe(true);
    expect(tasks().some((t) => t.type === 'call_completion_continuation')).toBe(
      true
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation-init
// ─────────────────────────────────────────────────────────────────────────────

describe('conversation-init', () => {
  function initPayload(over: Record<string, unknown> = {}) {
    return {
      caller_id: PHONE,
      agent_id: 'el_assistant_1',
      called_number: '+15559998888',
      ...over,
    };
  }

  test('it NEVER blocks on a bad signature — that emptied the payload in production', async () => {
    process.env.ELEVENLABS_OUTBOUND_WEBHOOK_SECRET = 'sekrit';
    seedChat();
    const r = await handleConversationInitWebhook(initPayload(), {
      signature: 't=1,v0=deadbeef',
      rawBody: '{}',
    });
    // The provider signs this with a DIFFERENT secret, so refusing here loses ALL caller context.
    expect(r.dynamic_variables.local_scope).toBe('FACTS: Jane, Contacted');
  });

  test('an unresolved agent or caller returns a minimal payload, not an error', async () => {
    resolveAgentInbound.mockResolvedValue(null);
    expect(
      await handleConversationInitWebhook(initPayload(), UNSIGNED)
    ).toEqual({ dynamic_variables: {} });

    resolveAgentInbound.mockResolvedValue(AGENT);
    expect(
      await handleConversationInitWebhook(
        initPayload({ caller_id: '' }),
        UNSIGNED
      )
    ).toEqual({ dynamic_variables: {} });
  });

  test('a KNOWN caller advances to Engaged and reopens the cadence', async () => {
    seedChat({ cadence_complete: true, call_followup_count: 3 });
    await handleConversationInitWebhook(initPayload(), UNSIGNED);
    const chat = store.get(`chats/${CHAT}`)!;
    // An inbound call from a known prospect is a strong engagement signal.
    expect(chat.stage).toBe('Engaged');
    expect(chat.cadence_complete).toBe(false);
    expect(chat.call_followup_count).toBe(0);
  });

  test('an UNKNOWN caller is seeded as a new Real prospect at stage New', async () => {
    store.set(`agents/${AGENT}`, { dealers_id: 'd1', company_id: 'c1' });
    const r = await handleConversationInitWebhook(initPayload(), UNSIGNED);
    const chat = store.get(`chats/${CHAT}`)!;
    const memory = chat.memory as Record<string, unknown>;
    expect(chat.stage).toBe('New');
    expect(memory.record_type).toBe('Real');
    expect(memory._ob_state).toBe('new');
    expect(memory.phone_number).toBe(PHONE);
    expect(r.dynamic_variables.call_type).toBe('INBOUND_KNOWN');
  });

  test('the agent-configured variables come from memory, else "Not Available"', async () => {
    store.set(`agents/${AGENT}`, {
      dynamic_variables: { first_name: '', company: '' },
    });
    seedChat({ memory: { first_name: 'Jane' } });
    const r = await handleConversationInitWebhook(initPayload(), UNSIGNED);
    expect(r.dynamic_variables.first_name).toBe('Jane');
    expect(r.dynamic_variables.company).toBe('Not Available');
  });

  test('the callback number is returned both raw and pronounceable', async () => {
    seedChat();
    const r = await handleConversationInitWebhook(initPayload(), UNSIGNED);
    expect(r.dynamic_variables.callback_number).toBe('+15559998888');
    expect(typeof r.dynamic_variables.callback_number_pronounced).toBe(
      'string'
    );
  });

  test('a cached conversation summary is appended to local_scope', async () => {
    seedChat({ memory: { _conversation_summary: 'Asked about pricing.' } });
    const r = await handleConversationInitWebhook(initPayload(), UNSIGNED);
    expect(String(r.dynamic_variables.local_scope)).toContain(
      'CONVERSATION SUMMARY:\nAsked about pricing.'
    );
  });

  test('the opener override is SCOPED to the one voice agent', async () => {
    seedChat();
    // This webhook is shared; overriding first_message for all of them would change their openers.
    const other = await handleConversationInitWebhook(initPayload(), UNSIGNED);
    expect(other.conversation_config_override).toBeUndefined();

    const lily = await handleConversationInitWebhook(
      initPayload({ agent_id: 'agent_6801kw9yvffseg6tmdeqv56wgkdz' }),
      UNSIGNED
    );
    expect(
      (lily.conversation_config_override!.agent as Record<string, unknown>)
        .first_message as string
    ).toContain('How can I help you?');
  });

  test('an unexpected failure still returns a connectable payload', async () => {
    // A pre-call webhook must never stop the call from connecting.
    buildScope.mockRejectedValue(new Error('scope exploded'));
    seedChat();
    expect(
      await handleConversationInitWebhook(initPayload(), UNSIGNED)
    ).toEqual({ dynamic_variables: {} });
  });
});
