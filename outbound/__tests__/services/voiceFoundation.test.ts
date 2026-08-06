/**
 * @jest-environment node
 *
 * The voice foundation: the call-scope facts feed, the provider webhook attach, and referral transfer.
 *
 * The scope builder is a **facts feed with no scripting**, and that separation is what lets the voice
 * prompt be edited without touching code — so the tests assert the facts are present and correct, and
 * that no behavioural instruction leaks in.
 *
 * The referral transfer's defining property is the ASYMMETRY between the two chats: warm identity and a
 * non-gating highlight on the NEW chat, a HARD STOP on the SOURCE (both opt-outs, tasks cancelled,
 * archived — outreach now points at the real person). Conflating it with a decline is the likely mistake,
 * so that distinction is pinned directly, as is the key gate that refuses a fork it cannot reach.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/phoneScreening', () => ({
  screenPhoneAtEnroll: jest.fn().mockResolvedValue(false),
  FULL_SCRUB_FLAG: 'full_scrub_gate',
}));

import { store } from '../../testSupport/mockFirestore';
import {
  buildInboundCallScope,
  buildOutboundCallScope,
  buildVoiceSchedulingBlock,
  hubspotContextLine,
  inboundCallContext,
  outboundCallContext,
  __testing as cs,
} from '../../services/callScope';
import {
  attachOutboundPostCallWebhookToAgent,
  __testing as el,
} from '../../services/elevenlabs';
import {
  REFERRAL_HIGHLIGHT_LABEL,
  handleReferralTransfer,
  __testing as rt,
} from '../../services/referralTransfer';
import {
  NOT_INTERESTED_LABEL,
  REFERRAL_TRANSFERRED_LABEL,
  resolveActiveOutboundChat,
} from '../../services/chat';
import { COLLECTION as DNC_COLLECTION } from '../../services/dncAreaCodes';
import type { ChatMemory } from '../../types';

const CHAT = 'outbound__agentA__15551230000';

function mem(over: ChatMemory = {}): ChatMemory {
  return {
    first_name: 'Jane',
    last_name: 'Smith',
    company: 'Acme',
    customer_email: 'jane@acme.com',
    phone_number: '15551230000',
    timezone: 'America/New_York',
    ...over,
  };
}

/** Seed a `make_phone_call` or `send_email` tool use into the chat's history. */
function seedToolUse(
  id: string,
  name: string,
  input: Record<string, unknown> = {}
) {
  store.set(`chats/${CHAT}/messages/${id}`, {
    role: 'assistant',
    timestamp: new Date(`2026-08-0${id.slice(-1)}T10:00:00Z`),
    content: [{ toolUse: { toolUseId: id, name, input } }],
  });
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  store.set('agents/agentA', { sales_agent_name: 'Nova' });
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_OUTBOUND_POST_CALL_WEBHOOK_ID;
  delete process.env.ELEVENLABS_OUTBOUND_CONVERSATION_INIT_WEBHOOK_ID;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the call-scope facts feed', () => {
  it('classifies a first outreach when there is no prior contact', async () => {
    const ctx = await outboundCallContext(mem(), CHAT);
    expect(ctx.call_type).toBe('FIRST_OUTREACH');
    expect(ctx.calls).toBe(0);
    expect(ctx.email_subjects).toEqual([]);
  });

  it('classifies a follow-up from prior calls or emails in history', async () => {
    seedToolUse('t1', 'make_phone_call');
    seedToolUse('t2', 'send_email', { subject: 'Quick question' });
    const ctx = await outboundCallContext(mem(), CHAT);
    expect(ctx.call_type).toBe('FOLLOW_UP');
    expect(ctx.calls).toBe(1);
    expect(ctx.email_subjects).toEqual(['Quick question']);
  });

  it('counts the from-number call variant too', async () => {
    seedToolUse('t1', 'make_phone_call_from_number');
    expect((await outboundCallContext(mem(), CHAT)).calls).toBe(1);
  });

  it('classifies a REMINDER when booked, WITHOUT scanning history', async () => {
    seedToolUse('t1', 'make_phone_call');
    const ctx = await outboundCallContext(mem(), CHAT, true);
    expect(ctx.call_type).toBe('REMINDER');
    expect(ctx.calls).toBe(0); // short-circuited — no scan
  });

  it('emits the core facts and no behavioural scripting', async () => {
    const scope = await buildOutboundCallScope(mem(), CHAT);
    expect(scope).toContain('call_type: FIRST_OUTREACH');
    expect(scope).toContain('prospect_stage: New');
    expect(scope).toContain('prospect: Jane Smith at Acme');
    expect(scope).toContain('contact on file: jane@acme.com · 15551230000');
    expect(scope).toContain('earliest bookable demo time is TOMORROW');
    // A facts feed: it must not tell the agent how to behave.
    expect(scope.toLowerCase()).not.toContain('you should');
    expect(scope.toLowerCase()).not.toContain('say ');
  });

  it('states the booked demo time and link on a reminder call', async () => {
    const scope = await buildOutboundCallScope(
      mem({
        meeting_at: '2026-08-11T14:00:00Z',
        hubspot_meeting_link: 'https://meet.example.com/x',
      }),
      CHAT,
      true
    );
    expect(scope).toContain('booked demo:');
    expect(scope).toContain('August 11'); // rendered in the prospect's zone
    expect(scope).toContain('meeting link: https://meet.example.com/x');
  });

  it('falls back to a generic booked line with no meeting_at', async () => {
    const scope = await buildOutboundCallScope(mem(), CHAT, true);
    expect(scope).toContain('booked demo: already on the calendar');
  });

  it('reports prior contact and whether the prospect has replied', async () => {
    seedToolUse('t1', 'make_phone_call');
    seedToolUse('t2', 'send_email', { subject: 'First touch' });

    const cold = await buildOutboundCallScope(mem(), CHAT);
    expect(cold).toContain('prior contact: 1 call, 1 email (no reply yet)');
    expect(cold).toContain('prior email subjects: First touch');

    const engaged = await buildOutboundCallScope(
      mem({ current_stage: 'Engaged' }),
      CHAT
    );
    expect(engaged).toContain('(replied)');
  });

  it('always reports cadence position, with the first-touch anchors when present', async () => {
    const scope = await buildOutboundCallScope(
      mem({
        email_followup_count: 2,
        call_followup_count: 1,
        _first_outbound_email_at: '2026-08-01T10:00:00Z',
        _first_outbound_call_at: '2026-08-02T10:00:00Z',
      }),
      CHAT
    );
    expect(scope).toContain('follow-ups so far: email 2 of 4, call 1');
    expect(scope).toContain('first email 2026-08-01T10:00:00Z');
    expect(scope).toContain('first call 2026-08-02T10:00:00Z');
  });

  it('reuses a supplied context rather than scanning twice', async () => {
    const ctx = await outboundCallContext(mem(), CHAT);
    const scope = await buildOutboundCallScope(mem(), CHAT, false, ctx);
    expect(scope).toContain(`call_type: ${ctx.call_type}`);
  });

  it('omits lines it has no facts for', async () => {
    const scope = await buildOutboundCallScope({}, CHAT);
    expect(scope).toContain('prospect: the prospect'); // the fallback label
    expect(scope).not.toContain('contact on file');
    expect(scope).not.toContain('contact context');
  });

  it('falls back to Eastern for an invalid timezone rather than throwing', async () => {
    const scope = await buildOutboundCallScope(
      mem({ timezone: 'Not/AZone' }),
      CHAT
    );
    expect(scope).toContain('America/New_York');
  });
});

describe('the inbound call scope', () => {
  it('is INBOUND_NEW for an unknown caller', async () => {
    const ctx = await inboundCallContext({}, CHAT);
    expect(ctx.call_type).toBe('INBOUND_NEW');
    expect(ctx.known).toBe(false);
  });

  it('is INBOUND_KNOWN on a name alone, with no history', async () => {
    const ctx = await inboundCallContext({ first_name: 'Jane' }, CHAT);
    expect(ctx.call_type).toBe('INBOUND_KNOWN');
  });

  it('is INBOUND_KNOWN on history alone, with no name', async () => {
    seedToolUse('t1', 'make_phone_call');
    expect((await inboundCallContext({}, CHAT)).call_type).toBe(
      'INBOUND_KNOWN'
    );
  });

  it('says the customer called us, and names the caller', async () => {
    const scope = await buildInboundCallScope(mem(), CHAT);
    expect(scope).toContain('INBOUND call');
    expect(scope).toContain('the customer called us');
    expect(scope).toContain('caller: Jane Smith at Acme');
  });

  it('uses the caller fallback label when no name is on file', async () => {
    const scope = await buildInboundCallScope({}, CHAT);
    expect(scope).toContain('caller: the caller');
  });
});

describe('buildVoiceSchedulingBlock — slots cannot be fetched mid-call', () => {
  it('states plainly when nothing was pre-loaded', () => {
    expect(buildVoiceSchedulingBlock()).toContain('none pre-loaded');
  });

  it('passes the slots and link through', () => {
    const b = buildVoiceSchedulingBlock(
      'AVAILABLE: Tue 2pm, Wed 10am',
      'https://meet.example.com/x'
    );
    expect(b).toContain('Tue 2pm');
    expect(b).toContain('MEETING LINK: https://meet.example.com/x');
  });
});

describe('hubspotContextLine — compressed, and empty when useless', () => {
  it('renders role, company, location and lifecycle', () => {
    expect(
      hubspotContextLine({
        job_title: 'GM',
        company: 'Auto Dealer X',
        city: 'Miami',
        state: 'FL',
        lifecyclestage: 'opportunity',
      })
    ).toBe('GM at Auto Dealer X (Miami, FL) — opportunity');
  });

  it('degrades cleanly with partial data', () => {
    expect(hubspotContextLine({ company: 'Acme' })).toBe('Acme');
    expect(hubspotContextLine({ job_title: 'GM' })).toBe('GM');
    expect(hubspotContextLine({ lifecyclestage: 'lead' })).toBe('lead');
  });

  it('is empty when there is nothing worth saying', () => {
    expect(hubspotContextLine({})).toBe('');
    expect(hubspotContextLine(null)).toBe('');
  });
});

describe('the scope formatters', () => {
  it('defaults the stage to New and prefers current_stage', () => {
    expect(cs.prospectStage({})).toBe('New');
    expect(cs.prospectStage({ stage: 'Lead' })).toBe('Lead');
    expect(cs.prospectStage({ current_stage: 'Engaged', stage: 'Lead' })).toBe(
      'Engaged'
    );
  });

  it('formats the booked time in the prospect zone, falling back to the raw value', () => {
    expect(cs.formatMeetingWhen({ meeting_at: '', timezone: 'UTC' })).toBe('');
    expect(
      cs.formatMeetingWhen({ meeting_at: 'not-a-date', timezone: 'UTC' })
    ).toBe('not-a-date');
    const f = cs.formatMeetingWhen({
      meeting_at: '2026-08-11T14:00:00Z',
      timezone: 'America/New_York',
    });
    expect(f).toContain('America/New_York');
    expect(f).toContain('10:00 AM'); // 14:00Z is 10am EDT
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the provider webhook attach', () => {
  const AGENT = 'el-agent-1';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    // @ts-expect-error -- restoring the global between tests
    delete global.fetch;
  });

  function okGet(platformSettings: Record<string, unknown>) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ platform_settings: platformSettings }),
      text: async () => '',
      headers: new Headers(),
    };
  }

  it('refuses without an id or an API key', async () => {
    expect(await attachOutboundPostCallWebhookToAgent('')).toBe(false);
    delete process.env.ELEVENLABS_API_KEY;
    expect(await attachOutboundPostCallWebhookToAgent(AGENT)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MERGES into existing platform settings without clobbering them', async () => {
    // The whole point: connecting an agent stores only its id, and this must not disturb its prompt.
    fetchMock
      .mockResolvedValueOnce(
        okGet({
          conversation_config: { agent: { prompt: 'DO NOT TOUCH' } },
          workspace_overrides: { existing: 'keep me' },
        })
      )
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

    expect(await attachOutboundPostCallWebhookToAgent(AGENT)).toBe(true);

    const patch = JSON.parse(
      (fetchMock.mock.calls[1][1] as { body: string }).body
    ) as Record<string, never>;
    const ps = patch.platform_settings as Record<string, never>;
    // Pre-existing config survives.
    expect((ps.conversation_config as Record<string, never>).agent).toEqual({
      prompt: 'DO NOT TOUCH',
    });
    const wo = ps.workspace_overrides as Record<string, unknown>;
    expect(wo.existing).toBe('keep me');
    // And the outbound webhook is added.
    const hooks = wo.webhooks as Record<string, unknown>;
    expect(hooks.post_call_webhook_id).toBe(el.outboundPostCallWebhookId());
    expect(hooks.events).toEqual([
      'transcript',
      'audio',
      'call_initiation_failure',
    ]);
  });

  it('enables exactly the per-call overrides the calling tool sends inline', async () => {
    fetchMock
      .mockResolvedValueOnce(okGet({}))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    await attachOutboundPostCallWebhookToAgent(AGENT);

    const ps = (
      JSON.parse(
        (fetchMock.mock.calls[1][1] as { body: string }).body
      ) as Record<string, never>
    ).platform_settings as Record<string, never>;
    const ov = ps.overrides as Record<string, never>;
    const cco = ov.conversation_config_override as Record<string, never>;
    expect((cco.agent as Record<string, unknown>).first_message).toBe(true);
    expect((cco.tts as Record<string, unknown>).voice_id).toBe(true);
    expect(ov.enable_conversation_initiation_client_data_from_webhook).toBe(
      true
    );
  });

  it('adds the init-webhook id only when one is configured', async () => {
    fetchMock
      .mockResolvedValueOnce(okGet({}))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    await attachOutboundPostCallWebhookToAgent(AGENT);
    let hooks = (
      (
        JSON.parse(
          (fetchMock.mock.calls[1][1] as { body: string }).body
        ) as Record<string, never>
      ).platform_settings as Record<string, never>
    ).workspace_overrides as Record<string, never>;
    expect(
      (hooks.webhooks as Record<string, unknown>)
        .conversation_initiation_client_data_webhook_id
    ).toBeUndefined();

    process.env.ELEVENLABS_OUTBOUND_CONVERSATION_INIT_WEBHOOK_ID = 'init-1';
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(okGet({}))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    await attachOutboundPostCallWebhookToAgent(AGENT);
    hooks = (
      (
        JSON.parse(
          (fetchMock.mock.calls[1][1] as { body: string }).body
        ) as Record<string, never>
      ).platform_settings as Record<string, never>
    ).workspace_overrides as Record<string, never>;
    expect(
      (hooks.webhooks as Record<string, unknown>)
        .conversation_initiation_client_data_webhook_id
    ).toBe('init-1');
  });

  it('returns false on a failed GET or PATCH, and never throws on a network error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'no such agent',
    });
    expect(await attachOutboundPostCallWebhookToAgent(AGENT)).toBe(false);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(okGet({})).mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => 'bad',
    });
    expect(await attachOutboundPostCallWebhookToAgent(AGENT)).toBe(false);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await attachOutboundPostCallWebhookToAgent(AGENT)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('referral transfer', () => {
  beforeEach(() => {
    for (const ac of ['303', '212']) {
      store.set(`${DNC_COLLECTION}/${ac}`, {
        area_code: ac,
        san_expiry_date: '2030-01-01',
      });
    }
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      stage: 'Contacted',
      phone_opt_out: false,
      email_opt_out: false,
      memory: {
        agent_id: 'agentA',
        company: 'Acme',
        campaign_id: 'camp1',
        record_type: 'Real',
        phone_number: '13034430103',
        customer_email: 'old@acme.com',
      },
    });
  });

  const referred = {
    referred_email: 'New.Person@acme.com',
    referred_phone: '+12125550199',
    referred_first_name: 'Sam',
    referred_last_name: 'Jones',
    referred_title: 'GM',
  };

  it('creates a NEW chat in the SAME campaign and seeds warm identity', async () => {
    const r = await handleReferralTransfer(CHAT, referred, {
      referrer: 'Dana in ops',
    });
    expect(r.ok).toBe(true);
    expect(r.campaign_id).toBe('camp1');
    expect(r.new_chat_id).toBeTruthy();

    const nc = store.get(`chats/${r.new_chat_id}`)!;
    expect(nc.campaign_id).toBe('camp1');
    const m = nc.memory as Record<string, unknown>;
    expect(m._is_referral).toBe(true);
    expect(m.referred_by).toBe('Dana in ops');
    expect(m.referral_title).toBe('GM');
    expect(m._referred_from_chat_id).toBe(CHAT);
    expect(String(m._conversation_summary)).toContain('WARM referral');
  });

  it('rewrites the first-touch notes so a referral never gets a COLD open', async () => {
    const r = await handleReferralTransfer(CHAT, referred, {
      referrer: 'Dana in ops',
    });
    const tasks = store.collection(`chats/${r.new_chat_id}/tasks`);
    expect(tasks).toHaveLength(1);
    const notes = String((tasks[0][1].data as Record<string, unknown>).notes);
    expect(notes).toContain('WARM REFERRAL first touch');
    expect(notes).toContain('do NOT use the cold-pitch opener');
  });

  it('HIGHLIGHTS the new chat without gating it — comms still go out', async () => {
    const r = await handleReferralTransfer(CHAT, referred, {
      referrer: 'Dana',
    });
    const labels = (store.get(`chats/${r.new_chat_id}`)!.labels ??
      []) as string[];
    expect(labels).toContain(REFERRAL_HIGHLIGHT_LABEL);
    // The highlight must NOT be a proactive-stop label.
    expect(labels).not.toContain(REFERRAL_TRANSFERRED_LABEL);
    expect(labels).not.toContain(NOT_INTERESTED_LABEL);
    // And the task it will fire from is still queued.
    expect(store.collection(`chats/${r.new_chat_id}/tasks`)).toHaveLength(1);
  });

  it('HARD-STOPS the source: both opt-outs, tasks cancelled, archived', async () => {
    store.set(`chats/${CHAT}/tasks/pending`, {
      type: 'followup_if_no_reply',
      executed: false,
    });
    const r = await handleReferralTransfer(CHAT, referred, {
      referrer: 'Dana',
    });
    const src = store.get(`chats/${CHAT}`)!;
    expect(src.phone_opt_out).toBe(true);
    expect(src.email_opt_out).toBe(true);
    expect(src.archived).toBe(true);
    expect(src.status).toBe('archived');
    expect(src.archive_reason).toBe('referred_to_new_contact');
    expect(src._referred_to_chat).toBe(r.new_chat_id);
    expect(store.get(`chats/${CHAT}/tasks/pending`)).toBeUndefined();
  });

  it('stamps the caller’s archive_reason on the source', async () => {
    await handleReferralTransfer(CHAT, referred, {
      referrer: 'Dana',
      archiveReason: 'identity_mismatch',
    });
    expect(store.get(`chats/${CHAT}`)!.archive_reason).toBe(
      'identity_mismatch'
    );
  });

  it('puts NO referral-identity keys on the source chat', async () => {
    await handleReferralTransfer(CHAT, referred, { referrer: 'Dana' });
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._is_referral).toBeUndefined();
    expect(m.referred_by).toBeUndefined();
    expect(m._referred_from_chat_id).toBeUndefined();
  });

  it('points the two chats at each other', async () => {
    const r = await handleReferralTransfer(CHAT, referred, {
      referrer: 'Dana',
    });
    expect(store.get(`chats/${r.new_chat_id}`)!.referrer_chat_id).toBe(CHAT);
    expect(store.get(`chats/${CHAT}`)!._referred_to_chat).toBe(r.new_chat_id);
  });

  it('refuses to switch a chat that is ITSELF a referral, or already switched', async () => {
    const base = store.get(`chats/${CHAT}`)!;
    const baseMem = base.memory as Record<string, unknown>;
    store.set(`chats/${CHAT}`, {
      ...base,
      memory: { ...baseMem, _is_referral: true },
    });
    expect(await handleReferralTransfer(CHAT, referred)).toMatchObject({
      ok: false,
      error: 'source already referral / already switched',
    });

    store.set(`chats/${CHAT}`, {
      ...base,
      memory: { ...baseMem, _referred_to_chat: 'other' },
    });
    expect(await handleReferralTransfer(CHAT, referred)).toMatchObject({
      ok: false,
      error: 'source already referral / already switched',
    });
  });

  it('accepts both key spellings for the referred person', async () => {
    const r = await handleReferralTransfer(
      CHAT,
      { email: 'plain@acme.com', first_name: 'Sam' },
      { referrer: 'Dana' }
    );
    expect(r.ok).toBe(true);
    const m = store.get(`chats/${r.new_chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m.customer_email).toBe('plain@acme.com');
  });

  it('lets the referred company OVERRIDE the source company', async () => {
    const r = await handleReferralTransfer(
      CHAT,
      { ...referred, referred_company: 'Frontier Chevrolet' },
      { referrer: 'Dana' }
    );
    const m = store.get(`chats/${r.new_chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m.company).toBe('Frontier Chevrolet');
  });

  it('refuses a name-only referral with no reachable channel', async () => {
    // "Andre, over at the Ford store" — a real name, but nothing to reach him on and not on this line.
    expect(
      await handleReferralTransfer(CHAT, { referred_first_name: 'Andre' })
    ).toMatchObject({ ok: false, insufficient_keys: true });
  });

  it('refuses when the key gate is missing a NAME even with a reachable channel', async () => {
    expect(
      await handleReferralTransfer(CHAT, { referred_email: 'x@acme.com' })
    ).toMatchObject({ ok: false, insufficient_keys: true });
  });

  it('refuses without an agent on the source', async () => {
    store.set(`chats/${CHAT}`, { type: 'outbound', memory: {} });
    expect(await handleReferralTransfer(CHAT, referred)).toMatchObject({
      ok: false,
      error: 'source chat has no agent_id',
    });
  });

  it('refuses on bad arguments', async () => {
    expect(await handleReferralTransfer('', referred)).toMatchObject({
      ok: false,
    });
    expect(await handleReferralTransfer(CHAT, null)).toMatchObject({
      ok: false,
    });
  });

  it('builds a team-fallback referrer label without doubling the company', async () => {
    expect(rt.atCompany('Acme', 'your team at Acme')).toBe('');
    expect(rt.atCompany('Acme', 'Dana')).toBe(' at Acme');
    expect(rt.warmSummary('your team at Acme', 'Acme', 'GM')).not.toContain(
      'at Acme at Acme'
    );
  });

  it('falls back to a generic referrer when none is named', async () => {
    const r = await handleReferralTransfer(CHAT, referred, { referrer: null });
    const m = store.get(`chats/${r.new_chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m.referred_by).toBe('your team at Acme');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SAME-LINE fork: "there's no Claira, it's Chris" on the dealership's one number. There is no
 * distinct email or phone to key a chat on, so the whole point is that the new chat lives under a CUSTOM
 * id on the SOURCE's line without colliding with the source's phone-keyed chat — and that an inbound call
 * from that number then resolves to the new chat, not the archived one.
 */
describe('referral transfer — same-line fork', () => {
  const SRC = 'outbound__agentA__13034430103';

  beforeEach(() => {
    store.set(`chats/${SRC}`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '13034430103',
      stage: 'Contacted',
      memory: {
        agent_id: 'agentA',
        company: 'Acme',
        campaign_id: 'camp1',
        record_type: 'Real',
        phone_number: '13034430103',
        _conversation_summary: 'Prior call: asked for Claira.',
      },
    });
  });

  const nameOnly = { referred_first_name: 'Chris', referred_last_name: 'Vale' };

  it('keys the new chat on the SOURCE line, clear of the source chat', async () => {
    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    expect(r.ok).toBe(true);
    expect(r.same_line).toBe(true);
    expect(r.new_chat_id).toBe('outbound__agentA__13034430103__chris_vale');
    expect(r.new_chat_id).not.toBe(SRC);
  });

  it('carries the SOURCE userId so an inbound call lands on the ACTIVE chat', async () => {
    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    const nc = store.get(`chats/${r.new_chat_id}`)!;
    expect(nc.userId).toBe('13034430103');
    // The source is archived, so the deterministic id must NOT win the inbound lookup.
    expect(await resolveActiveOutboundChat('agentA', '13034430103')).toBe(
      r.new_chat_id
    );
  });

  it('writes campaign_id at the TOP LEVEL — the campaign view lists by that field', async () => {
    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    expect(store.get(`chats/${r.new_chat_id}`)!.campaign_id).toBe('camp1');
  });

  it('schedules exactly ONE warm first-touch task', async () => {
    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    const tasks = store.collection(`chats/${r.new_chat_id}/tasks`);
    expect(tasks).toHaveLength(1);
    expect(
      String((tasks[0][1].data as Record<string, unknown>).notes)
    ).toContain('WARM REFERRAL first touch');
    expect((tasks[0][1].data as Record<string, unknown>).task_source).toBe(
      'referral_transfer'
    );
  });

  it('name-only WITHOUT same-line is refused — it would fork onto the wrong line', async () => {
    expect(await handleReferralTransfer(SRC, nameOnly)).toMatchObject({
      ok: false,
      insufficient_keys: true,
    });
  });

  it('seeds the referrer’s call cards as tagged BACKGROUND, oldest first', async () => {
    store.set(`chats/${SRC}/messages_v3/b`, {
      type: 'call',
      timestamp: new Date('2026-08-02T10:00:00Z'),
      content: { callId: 'conv_2' },
    });
    store.set(`chats/${SRC}/messages_v3/a`, {
      type: 'call',
      timestamp: new Date('2026-08-01T10:00:00Z'),
      content: { callId: 'conv_1' },
    });
    store.set(`chats/${SRC}/messages_v3/t`, {
      type: 'text',
      timestamp: new Date('2026-08-03T10:00:00Z'),
      content: { body: 'not a call card' },
    });

    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    const seeded = store
      .collection(`chats/${r.new_chat_id}/messages_v3`)
      .map(([, d]) => d)
      .sort(
        (x, y) =>
          (x.timestamp as Date).getTime() - (y.timestamp as Date).getTime()
      );

    // One intro header + the two CALL cards. The text card is not carried across.
    expect(seeded).toHaveLength(3);
    expect(
      String((seeded[0].content as Record<string, unknown>).body)
    ).toContain('CONTEXT FROM PRIOR CHAT');
    expect((seeded[1].content as Record<string, unknown>).callId).toBe(
      'conv_1'
    );
    expect((seeded[2].content as Record<string, unknown>).callId).toBe(
      'conv_2'
    );
    // Every carried doc is tagged so the frontend can never render it as this chat's own conversation.
    for (const d of seeded) expect(d.kind).toBe('referrer_context');
    // The header sorts BEFORE the first card, so the block sits at the top.
    expect((seeded[0].timestamp as Date).getTime()).toBeLessThan(
      (seeded[1].timestamp as Date).getTime()
    );
  });

  it('carries the referrer’s conversation summary across, distinctly named', async () => {
    store.set(`chats/${SRC}/messages_v3/a`, {
      type: 'call',
      timestamp: new Date('2026-08-01T10:00:00Z'),
      content: { callId: 'conv_1' },
    });
    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    const m = store.get(`chats/${r.new_chat_id}`)!.memory as Record<
      string,
      unknown
    >;
    expect(m._referrer_conversation_summary).toBe(
      'Prior call: asked for Claira.'
    );
    // NOT confused with the new chat's own warm summary.
    expect(String(m._conversation_summary)).toContain('WARM referral');
  });

  it('no call cards on the source → nothing seeded, transfer still succeeds', async () => {
    const r = await handleReferralTransfer(SRC, nameOnly, {
      forceSameLine: true,
    });
    expect(r.ok).toBe(true);
    expect(store.collection(`chats/${r.new_chat_id}/messages_v3`)).toHaveLength(
      0
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('resolveActiveOutboundChat', () => {
  const DET = 'outbound__agentA__15551230000';

  it('returns the deterministic chat when it is live — the ordinary case', async () => {
    store.set(`chats/${DET}`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '15551230000',
    });
    expect(await resolveActiveOutboundChat('agentA', '15551230000')).toBe(DET);
  });

  it('prefers the newest live chat on the line when the deterministic one is archived', async () => {
    store.set(`chats/${DET}`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '15551230000',
      archived: true,
    });
    store.set(`chats/${DET}__old`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '15551230000',
      status_changed_at: '2026-08-01T00:00:00Z',
    });
    store.set(`chats/${DET}__new`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '15551230000',
      status_changed_at: '2026-08-05T00:00:00Z',
    });
    expect(await resolveActiveOutboundChat('agentA', '15551230000')).toBe(
      `${DET}__new`
    );
  });

  it('ignores other agents, inbound chats, and archived candidates', async () => {
    store.set(`chats/${DET}`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '15551230000',
      status: 'archived',
    });
    store.set(`chats/other_agent`, {
      type: 'outbound',
      agentId: 'agentB',
      userId: '15551230000',
      status_changed_at: '2026-08-09T00:00:00Z',
    });
    store.set(`chats/inbound_one`, {
      type: 'inbound',
      agentId: 'agentA',
      userId: '15551230000',
      status_changed_at: '2026-08-09T00:00:00Z',
    });
    store.set(`chats/also_archived`, {
      type: 'outbound',
      agentId: 'agentA',
      userId: '15551230000',
      archived: true,
      status_changed_at: '2026-08-09T00:00:00Z',
    });
    // Nothing live to switch to → falls back to the deterministic chat, which at least exists.
    expect(await resolveActiveOutboundChat('agentA', '15551230000')).toBe(DET);
  });

  it('returns null when the line has no chat at all', async () => {
    expect(await resolveActiveOutboundChat('agentA', '19998887777')).toBeNull();
  });
});
