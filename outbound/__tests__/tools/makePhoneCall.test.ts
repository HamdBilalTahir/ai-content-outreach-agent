/**
 * @jest-environment node
 *
 * The `make_phone_call` tool.
 *
 * The suite is organised around the FOUR-GATE CHAIN, because both the order and the bypasses are
 * load-bearing:
 *
 *  - **Order.** The dial guard runs before scope-building, so a refusal wastes no work; the concurrency
 *    cap is reserved LAST, because it is the only gate that consumes a resource.
 *  - **Bypasses.** A Test record and an admin override bypass the PACING gates (dial guard, cap) but
 *    NEVER the opt-out gate — consent is not a pacing concern. `isHotProspect` bypasses nothing at all.
 *  - **Slot accounting.** A failed dial releases its slot immediately; a live call keeps it for the
 *    completion webhook. Getting that backwards leaks capacity until the TTL sweep.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
// The business-hours gate is clock-dependent, and because it runs BEFORE the pacing gates a `Real`
// record outside the window can never REACH them. That ordering is correct and is asserted in its own
// block below — but to exercise gates 3 and 4 in isolation the check has to be controlled, so it
// reports "inside hours" by default and the gate-2 block drives it explicitly.
jest.mock('../../services/businessHours', () => {
  const actual = jest.requireActual('../../services/businessHours');
  return {
    ...actual,
    checkBusinessHours: jest
      .fn()
      .mockReturnValue({ timezone: null, localTime: null, wasFallback: false }),
  };
});

import { store } from '../../testSupport/mockFirestore';
import {
  FROM_NUMBER_PHONE_NUMBER_ID,
  buildToolResult,
  isHotProspect,
  isTestRecord,
  parseAndRunMakePhoneCall,
  parseAndRunMakePhoneCallFromNumber,
  toE164,
  voiceBusinessHoursGate,
} from '../../tools/makePhoneCall';
import { activeVoiceCount } from '../../services/voiceConcurrency';
import { checkBusinessHours } from '../../services/businessHours';
import type { BedrockMessage } from '../../types';

const CHAT = 'outbound__agentA__15551230000';
const AGENT = 'agentA';
const PHONE = '+13034430103';
const SLOT_DOC = 'settings/outbound_voice_concurrency';

/** Pull the json payload out of a tool-result envelope. */
function payloadOf(res: BedrockMessage): Record<string, unknown> {
  const block = (res.content ?? [])[0] as Record<string, never>;
  const tr = block.toolResult as unknown as {
    content: Array<{ json: Record<string, unknown> }>;
  };
  return tr.content[0].json;
}

/** A chat whose gates all pass. `record_type: Real`, phone open, no prior call. */
function seedChat(over: Record<string, unknown> = {}) {
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    status: 'active',
    agentId: AGENT,
    phone_opt_out: false,
    memory: {
      agent_id: AGENT,
      phone_number: '13034430103',
      customer_email: 'a@b.com',
      // `Test` bypasses business hours, which would otherwise make the suite clock-dependent.
      record_type: 'Test',
      timezone: 'America/Denver',
      first_name: 'Jane',
      company: 'Acme',
      ...((over.memory as Record<string, unknown>) ?? {}),
    },
    ...over,
  });
}

function seedAgent(over: Record<string, unknown> = {}) {
  store.set(`agents/${AGENT}`, {
    sales_agent_name: 'Nova',
    voice_agent_assistant_id: 'el-assistant-1',
    voice_ai_provider: 'elevenlabs',
    voice_settings: { phoneNumberId: 'phnum_1' },
    dynamic_variables: {},
    ...over,
  });
}

let fetchMock: jest.Mock;

/** Make the provider accept the call and return a conversation id. */
function providerAccepts(conversationId = 'conv-1') {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, conversation_id: conversationId }),
    text: async () => '',
  });
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  process.env.ELEVENLABS_API_KEY = 'xi-key';
  delete process.env.SIM_VOICE_BRIDGE_URL;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  providerAccepts();
  (checkBusinessHours as jest.Mock).mockReturnValue({
    timezone: null,
    localTime: null,
    wasFallback: false,
  });
  seedAgent();
  seedChat();
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('toE164', () => {
  it('assumes US/Canada for a bare 10-digit number', () => {
    expect(toE164('3034430103')).toBe('+13034430103');
    expect(toE164('(303) 443-0103')).toBe('+13034430103');
  });

  it('preserves an explicit country code', () => {
    expect(toE164('+442079460958')).toBe('+442079460958');
    expect(toE164('13034430103')).toBe('+13034430103');
  });

  it('is empty for nothing usable', () => {
    expect(toE164('')).toBe('');
    expect(toE164(null)).toBe('');
    expect(toE164('no digits here')).toBe('');
  });
});

describe('the bypass predicates', () => {
  it('isTestRecord is case-insensitive', () => {
    expect(isTestRecord({ record_type: 'Test' })).toBe(true);
    expect(isTestRecord({ record_type: 'test' })).toBe(true);
    expect(isTestRecord({ record_type: 'Real' })).toBe(false);
    expect(isTestRecord({})).toBe(false);
  });

  it('isHotProspect reads engagement or an explicit callback request', () => {
    expect(isHotProspect('Engaged', {})).toBe(true);
    expect(isHotProspect('Lead', {})).toBe(true);
    expect(isHotProspect('Contacted', {})).toBe(false);
    expect(isHotProspect('New', { _customer_wants_callback: 'Y' })).toBe(true);
    expect(isHotProspect('New', {})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GATE 1 — phone opt-out is terminal and never bypassed', () => {
  it('BLOCKS an opted-out contact', async () => {
    seedChat({ phone_opt_out: true });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('blocked');
    expect(String(p.message)).toContain('opted out');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is NOT bypassed by a Test record or an admin override', async () => {
    // Consent is not a pacing concern — unlike every other gate here.
    seedChat({ phone_opt_out: true, memory: { record_type: 'Test' } });
    expect(
      payloadOf(
        await parseAndRunMakePhoneCall(
          'tu1',
          { phone_number: PHONE },
          { agent_id: AGENT, chat_id: CHAT, admin_override: true }
        )
      ).status
    ).toBe('blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates NO retry task — a DNC contact must never be re-dialed', async () => {
    seedChat({ phone_opt_out: true });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });
});

describe('GATE 2 — business hours defers rather than dropping', () => {
  it('bypasses entirely for a Test record', async () => {
    // The seeded chat is `Test`, so the gate short-circuits and the call goes out.
    const gate = await voiceBusinessHoursGate(
      'tu1',
      PHONE,
      CHAT,
      { record_type: 'Test' },
      AGENT
    );
    expect(gate).toBeNull();
  });

  it('defers a Real record outside the window, WITH a retry task and a reason', async () => {
    (checkBusinessHours as jest.Mock).mockReturnValue({
      timezone: 'America/Denver',
      localTime: new Date('2026-08-01T03:00:00Z'),
      wasFallback: false,
    });
    seedChat({ memory: { record_type: 'Real', timezone: 'America/Denver' } });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('deferred');
    expect(p.reason).toBe('outside_business_hours');
    expect(p.retry_at).toBeTruthy();
    expect(String(p.message)).toContain('Do not');
    const outreach = store
      .collection(`chats/${CHAT}/tasks`)
      .filter(([, t]) => t.type === 'outbound_outreach');
    expect(outreach).toHaveLength(1);
    expect((outreach[0][1].data as Record<string, unknown>).task_source).toBe(
      'voice_defer_outside_business_hours'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs BEFORE the pacing gates — an out-of-hours Real record never reaches them', async () => {
    // The ordering is the point: business hours is cheaper and more terminal, so a chat that is both
    // out-of-hours AND inside the dial-recency floor defers on HOURS, and reserves no slot.
    (checkBusinessHours as jest.Mock).mockReturnValue({
      timezone: 'America/Denver',
      localTime: new Date('2026-08-01T03:00:00Z'),
      wasFallback: false,
    });
    seedChat({
      memory: {
        record_type: 'Real',
        _last_outbound_call_at: new Date().toISOString(),
      },
    });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.reason).toBe('outside_business_hours');
    expect(await activeVoiceCount()).toBe(0);
  });

  it('fails OPEN — a guard fault proceeds rather than dropping outreach', async () => {
    (checkBusinessHours as jest.Mock).mockImplementation(() => {
      throw new Error('timezone machinery broken');
    });
    const gate = await voiceBusinessHoursGate(
      'tu1',
      PHONE,
      CHAT,
      { record_type: 'Real' },
      AGENT
    );
    expect(gate).toBeNull(); // proceed, do not drop outreach
  });
});

describe('GATE 3 — the per-chat dial guard', () => {
  it('SKIPS when a prior call is too recent', async () => {
    seedChat({
      memory: {
        record_type: 'Real',
        _last_outbound_call_at: new Date().toISOString(),
      },
    });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('skipped');
    expect(String(p.message)).toContain('do not re-dial now');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SKIPS when a prior call is still awaiting review', async () => {
    seedChat({
      memory: {
        record_type: 'Real',
        // Past the recency floor, but never reviewed.
        _last_outbound_call_at: new Date(
          Date.now() - 120 * 60_000
        ).toISOString(),
      },
    });
    expect(
      payloadOf(
        await parseAndRunMakePhoneCall(
          'tu1',
          { phone_number: PHONE },
          { agent_id: AGENT, chat_id: CHAT }
        )
      ).status
    ).toBe('skipped');
  });

  it('is bypassed by a Test record and by an admin override', async () => {
    const recent = new Date().toISOString();
    seedChat({
      memory: { record_type: 'Test', _last_outbound_call_at: recent },
    });
    expect(
      payloadOf(
        await parseAndRunMakePhoneCall(
          'tu1',
          { phone_number: PHONE },
          { agent_id: AGENT, chat_id: CHAT }
        )
      ).status
    ).toBe('in_progress');

    store.reset();
    seedAgent();
    providerAccepts('conv-2');
    seedChat({
      memory: { record_type: 'Real', _last_outbound_call_at: recent },
    });
    expect(
      payloadOf(
        await parseAndRunMakePhoneCall(
          'tu1',
          { phone_number: PHONE },
          { agent_id: AGENT, chat_id: CHAT, admin_override: true }
        )
      ).status
    ).toBe('in_progress');
  });

  it('runs BEFORE scope-building — a refusal reads no message history', async () => {
    seedChat({
      memory: {
        record_type: 'Real',
        _last_outbound_call_at: new Date().toISOString(),
      },
    });
    // Seed history the scope builder would have scanned.
    store.set(`chats/${CHAT}/messages/m1`, {
      role: 'assistant',
      timestamp: new Date(),
      content: [
        { toolUse: { toolUseId: 't', name: 'make_phone_call', input: {} } },
      ],
    });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    // Nothing was reserved and nothing dialed, which is what "wasted no work" means here.
    expect(await activeVoiceCount()).toBe(0);
  });
});

describe('GATE 4 — the voice concurrency cap', () => {
  it('reserves a slot for a live call and KEEPS it for the webhook', async () => {
    seedChat({ memory: { record_type: 'Real' } });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('in_progress');
    // Held until the completion webhook (or the TTL sweep) releases it.
    expect(await activeVoiceCount()).toBe(1);
  });

  it('RELEASES the slot when the dial fails — otherwise capacity leaks until the TTL', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, message: 'carrier rejected' }),
      text: async () => '',
    });
    seedChat({ memory: { record_type: 'Real' } });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('failed');
    expect(await activeVoiceCount()).toBe(0);
  });

  it('DEFERS at capacity, with a deterministic jitter and a retry task', async () => {
    // Fill the ledger to the default cap.
    const slots: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      slots[`other${i}`] = {
        chat_id: `other${i}`,
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      };
    }
    store.set(SLOT_DOC, { active_slots: slots });
    seedChat({ memory: { record_type: 'Real' } });

    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('deferred');
    expect(String(p.message)).toContain('capacity reached');
    expect(fetchMock).not.toHaveBeenCalled();

    const tasks = store
      .collection(`chats/${CHAT}/tasks`)
      .filter(([, t]) => t.type === 'outbound_outreach');
    expect(tasks).toHaveLength(1);
    expect((tasks[0][1].data as Record<string, unknown>).task_source).toBe(
      'voice_concurrency_defer'
    );
  });

  it('has NO hot-prospect bypass — the cap is absolute', async () => {
    const slots: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      slots[`other${i}`] = {
        chat_id: `other${i}`,
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      };
    }
    store.set(SLOT_DOC, { active_slots: slots });
    // Engaged AND explicitly wants a callback — as hot as a prospect gets.
    seedChat({
      stage: 'Engaged',
      memory: {
        record_type: 'Real',
        current_stage: 'Engaged',
        _customer_wants_callback: 'Y',
      },
    });
    expect(
      payloadOf(
        await parseAndRunMakePhoneCall(
          'tu1',
          { phone_number: PHONE },
          { agent_id: AGENT, chat_id: CHAT }
        )
      ).status
    ).toBe('deferred');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the dial payload', () => {
  it('wraps the scope in an explicit SCOPE envelope', async () => {
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body
    ) as Record<string, never>;
    const scope = (
      (body.conversation_initiation_client_data as Record<string, never>)
        .dynamic_variables as Record<string, string>
    ).local_scope;
    expect(scope).toContain('IMPORTANT: SCOPE OF THIS CALL');
    expect(scope).toContain('END OF SCOPE');
    expect(scope).toContain('call_type:');
  });

  it('exposes call_type and prospect_stage as discrete variables the prompt branches on', async () => {
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const vars = (
      JSON.parse(
        (fetchMock.mock.calls[0][1] as { body: string }).body
      ) as Record<string, never>
    ).conversation_initiation_client_data as Record<string, never>;
    const dv = vars.dynamic_variables as Record<string, string>;
    expect(dv.call_type).toBe('FIRST_OUTREACH');
    expect(dv.prospect_stage).toBe('New');
    expect(dv.tool_agent_id).toBe(AGENT);
  });

  it('flips to a REMINDER call type when a demo is already booked', async () => {
    seedChat({ memory: { record_type: 'Test', meeting_booked: true } });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const dv = (
      (
        JSON.parse(
          (fetchMock.mock.calls[0][1] as { body: string }).body
        ) as Record<string, never>
      ).conversation_initiation_client_data as Record<string, never>
    ).dynamic_variables as Record<string, string>;
    expect(dv.call_type).toBe('REMINDER');
  });

  it('injects only the declared dynamic variables', async () => {
    seedAgent({
      dynamic_variables: {
        first_name: 'placeholder',
        sales_agent_name: 'placeholder',
        dealer_name: 'placeholder',
      },
    });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const dv = (
      (
        JSON.parse(
          (fetchMock.mock.calls[0][1] as { body: string }).body
        ) as Record<string, never>
      ).conversation_initiation_client_data as Record<string, never>
    ).dynamic_variables as Record<string, string>;
    expect(dv.first_name).toBe('Jane');
    expect(dv.sales_agent_name).toBe('Nova');
    expect(dv.dealer_name).toBe('Acme'); // mapped from `company`
    expect(dv.callback_number).toBeUndefined(); // not declared
  });

  it('falls back to a spoken-friendly first_name rather than "Not Available"', async () => {
    seedAgent({ dynamic_variables: { first_name: 'placeholder' } });
    seedChat({ memory: { record_type: 'Test', first_name: undefined } });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const dv = (
      (
        JSON.parse(
          (fetchMock.mock.calls[0][1] as { body: string }).body
        ) as Record<string, never>
      ).conversation_initiation_client_data as Record<string, never>
    ).dynamic_variables as Record<string, string>;
    expect(dv.first_name).toBe('there');
  });

  it('pronounces the callback number for TTS when declared', async () => {
    seedAgent({ dynamic_variables: { callback_number: 'placeholder' } });
    store.set('phone_numbers/phnum_1', { phone_number: '+17816791321' });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const dv = (
      (
        JSON.parse(
          (fetchMock.mock.calls[0][1] as { body: string }).body
        ) as Record<string, never>
      ).conversation_initiation_client_data as Record<string, never>
    ).dynamic_variables as Record<string, string>;
    expect(dv.callback_number).toBe('+17816791321');
    expect(dv.callback_number_pronounced).toContain('seven, eight, one');
  });

  it('appends the cached summary AFTER the scope, so it cannot overwrite it', async () => {
    seedChat({
      memory: {
        record_type: 'Test',
        _conversation_summary: 'Prior call went well.',
      },
    });
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const scope = (
      (
        (
          JSON.parse(
            (fetchMock.mock.calls[0][1] as { body: string }).body
          ) as Record<string, never>
        ).conversation_initiation_client_data as Record<string, never>
      ).dynamic_variables as Record<string, string>
    ).local_scope;
    expect(scope.indexOf('call_type:')).toBeLessThan(
      scope.indexOf('CONVERSATION SUMMARY')
    );
  });
});

describe('post-dial bookkeeping', () => {
  it('records the durable call index and the pending-call row', async () => {
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(store.get('outbound_call_index/conv-1')).toMatchObject({
      chat_id: CHAT,
    });
    expect(store.get('pending_calls/conv-1')).toBeDefined();
  });

  it('stamps BOTH call anchors on the first call, then only the last-call one', async () => {
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    let m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    const firstAt = m._first_outbound_call_at;
    expect(firstAt).toBeTruthy();
    expect(m._last_outbound_call_at).toBeTruthy();
    expect(store.get(`chats/${CHAT}`)!.call_followup_count).toBeUndefined();

    providerAccepts('conv-2');
    await parseAndRunMakePhoneCall(
      'tu2',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._first_outbound_call_at).toBe(firstAt); // the anchor never moves
    expect(store.get(`chats/${CHAT}`)!.call_followup_count).toBe(1);
  });

  it('creates ONE watchdog, purging any prior unresolved one', async () => {
    await parseAndRunMakePhoneCall(
      'tu1',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    providerAccepts('conv-2');
    await parseAndRunMakePhoneCall(
      'tu2',
      { phone_number: PHONE },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const watchdogs = store
      .collection(`chats/${CHAT}/tasks`)
      .filter(([, t]) => t.type === 'check_if_call_succeeded');
    expect(watchdogs).toHaveLength(1);
  });

  it('does NO bookkeeping when the dial failed', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'provider down',
    });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('failed');
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._last_outbound_call_at).toBeUndefined();
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });
});

describe('configuration failures are reported, not silent', () => {
  it('reports a missing phone number, agent, or assistant id', async () => {
    expect(
      payloadOf(await parseAndRunMakePhoneCall('tu1', {}, { agent_id: AGENT }))
        .status
    ).toBe('failed');
    expect(
      payloadOf(
        await parseAndRunMakePhoneCall('tu1', { phone_number: PHONE }, {})
      ).message
    ).toContain('Agent ID not found');

    seedAgent({ voice_agent_assistant_id: undefined });
    expect(
      String(
        payloadOf(
          await parseAndRunMakePhoneCall(
            'tu1',
            { phone_number: PHONE },
            { agent_id: AGENT, chat_id: CHAT }
          )
        ).message
      )
    ).toContain('assistant ID not configured');
  });

  it('names the UNSUPPORTED provider rather than silently no-op-ing', async () => {
    // A Vapi-configured agent must produce a diagnosable result, not an unexplained nothing.
    seedAgent({ voice_ai_provider: 'vapi' });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('failed');
    expect(String(p.message)).toContain("'vapi' is not available");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a deactivated oversee phone number', async () => {
    seedAgent({
      oversee_agent: true,
      make_phone_call_tool_agent_id: 'voiceAgent',
    });
    store.set('agents/voiceAgent', {
      voice_agent_assistant_id: 'el-1',
      voice_ai_provider: 'elevenlabs',
      voice_settings: { phoneNumberId: 'phnum_b' },
    });
    store.set('phone_numbers/pn_oversee', {
      oversee_agent_id: AGENT,
      status: 'deactivated',
      phone_number_id: 'phnum_a',
    });
    const p = payloadOf(
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(p.status).toBe('failed');
    expect(String(p.message)).toContain('deactivated');
  });
});

describe('the simulation bridge', () => {
  it('replaces the provider entirely when the chat is in playground mode', async () => {
    // The point of the bridge is fidelity: it POSTs the real webhook shape back, so every downstream
    // path runs identically to a live call.
    process.env.SIM_VOICE_BRIDGE_URL = 'https://bridge.example.com';
    try {
      seedChat({ playground: true });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      });

      const p = payloadOf(
        await parseAndRunMakePhoneCall(
          'tu1',
          { phone_number: PHONE },
          { agent_id: AGENT, chat_id: CHAT }
        )
      );
      expect(p.status).toBe('in_progress');
      expect(String(p.call_id).startsWith('sim-')).toBe(true);
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        'bridge.example.com'
      );
    } finally {
      delete process.env.SIM_VOICE_BRIDGE_URL;
    }
  });

  it('is not used for a non-playground chat', async () => {
    process.env.SIM_VOICE_BRIDGE_URL = 'https://bridge.example.com';
    try {
      await parseAndRunMakePhoneCall(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      );
      expect(String(fetchMock.mock.calls[0][0])).toContain('elevenlabs.io');
    } finally {
      delete process.env.SIM_VOICE_BRIDGE_URL;
    }
  });
});

describe('buildToolResult', () => {
  it('produces the tool-result envelope the turn loop reads', () => {
    const res = buildToolResult('tu1', { status: 'ok' });
    expect(res.role).toBe('user');
    expect(payloadOf(res)).toEqual({ status: 'ok' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The `make_phone_call_from_number` variant
// ─────────────────────────────────────────────────────────────────────────────

describe('make_phone_call_from_number', () => {
  /** The dial payload the provider actually received. */
  function dialBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/twilio/outbound-call')
    );
    return call ? JSON.parse(call[1].body as string) : {};
  }

  test('requires instructions even though the content is never forwarded', async () => {
    // A real contract the caller depends on, preserved from the source. Context comes from memory, so
    // the STRING is unused — but its absence is still a hard failure.
    const r = payloadOf(
      await parseAndRunMakePhoneCallFromNumber(
        'tu1',
        { phone_number: PHONE },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(r.status).toBe('failed');
    expect(r.message).toBe('Instructions are required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('dials from the FIXED number, overriding the agent’s configured one', async () => {
    seedAgent({ voice_settings: { phoneNumberId: 'phnum_agent_own' } });
    await parseAndRunMakePhoneCallFromNumber(
      'tu1',
      { phone_number: PHONE, instructions: 'book a demo' },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(dialBody().agent_phone_number_id).toBe(FROM_NUMBER_PHONE_NUMBER_ID);
  });

  test('inherits the full context the source variant had drifted behind on', async () => {
    // The source's copy was missing call_type, prospect_stage, the meeting-host fact, voice skills, and
    // the availability inject. Its own docstring says "same logic as make_phone_call", so the wrapper
    // implements that stated contract and the drift does not survive the port.
    await parseAndRunMakePhoneCallFromNumber(
      'tu1',
      { phone_number: PHONE, instructions: 'book a demo' },
      { agent_id: AGENT, chat_id: CHAT }
    );
    const clientData = dialBody().conversation_initiation_client_data as Record<
      string,
      unknown
    >;
    const vars = clientData.dynamic_variables as Record<string, unknown>;
    expect(vars.call_type).toBeDefined();
    expect(vars.prospect_stage).toBeDefined();
  });

  test('the opt-out gate still applies — it is not a pacing concern', async () => {
    seedChat({ phone_opt_out: true });
    const r = payloadOf(
      await parseAndRunMakePhoneCallFromNumber(
        'tu1',
        { phone_number: PHONE, instructions: 'book a demo' },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(r.status).toBe('blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
