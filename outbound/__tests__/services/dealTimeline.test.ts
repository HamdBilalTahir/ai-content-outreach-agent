/**
 * @jest-environment node
 *
 * The per-deal touchpoint timeline.
 *
 * Three properties carry the weight, and each one is a thing the dashboard would get visibly wrong:
 *
 *  - **De-duplication with HubSpot preferred, and the loser donating its fields.** The AI and HubSpot both
 *    see the same email and the same acquisition, so without this every touchpoint count doubles on
 *    exactly the deals this view exists to explain — and a naive "keep HubSpot" would throw away the
 *    richer record's detail.
 *  - **Stage changes are never fabricated.** HubSpot's per-stage history is sparse, and inventing entries
 *    at `createdate` would show a plausible history that never happened.
 *  - **An AI `acquired` on an OPEN deal is dropped.** `prospect_converted_to_deal` is an attribution
 *    marker, not an acquisition; keeping it would report an open deal as won.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../firebase/agent', () => ({ getAgentActions: jest.fn() }));
jest.mock('../../services/hubspot', () => ({
  accessToken: jest.fn(),
  resolveHubspotConfig: jest.fn(),
}));
jest.mock('../../services/dealAnalytics', () => {
  const actual = jest.requireActual('../../services/dealAnalytics');
  return {
    ...actual,
    dealPipelineStages: jest.fn(),
    fetchDealDetail: jest.fn(),
    getDealEngagements: jest.fn(),
    readDealsBatch: jest.fn(),
  };
});

import { store } from '../../testSupport/mockFirestore';
import {
  aiActivityEvents,
  aiMessageEvents,
  buildDealTimeline,
  dealEvents,
  dedup,
  dedupFamily,
  engagementEvents,
  findSourceChat,
} from '../../services/dealTimeline';
import { getAgentActions } from '../../firebase/agent';
import { accessToken, resolveHubspotConfig } from '../../services/hubspot';
import {
  dealPipelineStages,
  fetchDealDetail,
  getDealEngagements,
  readDealsBatch,
} from '../../services/dealAnalytics';
import type { PipelineStage } from '../../services/dealAnalytics';
import type { TimelineEvent } from '../../services/dealTimeline';

const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';
const DEAL = 'deal_1';

const STAGES: Record<string, PipelineStage> = {
  s_lead: {
    id: 's_lead',
    label: 'Lead',
    order: 0,
    type: 'open',
    is_entry: true,
  },
  s_sent: {
    id: 's_sent',
    label: 'Contract Sent',
    order: 1,
    type: 'open',
    is_entry: false,
  },
  s_won: {
    id: 's_won',
    label: 'Closed Won',
    order: 2,
    type: 'won',
    is_entry: false,
  },
};

function event(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    at: '2026-07-01T00:00:00Z',
    _ms: Date.parse('2026-07-01T00:00:00Z'),
    source: 'ai',
    channel: 'email',
    type: 'email_sent',
    direction: 'out',
    title: null,
    status: null,
    meta: {},
    ...over,
  };
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (resolveHubspotConfig as jest.Mock).mockReturnValue({
    access_token: 'tok',
    pipeline_id: 'p1',
    stage_ids: { Lead: 's_lead' },
  });
  (accessToken as jest.Mock).mockResolvedValue('tok');
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (dealPipelineStages as jest.Mock).mockResolvedValue({
    label: 'Outbound',
    stages: Object.values(STAGES),
  });
  (readDealsBatch as jest.Mock).mockResolvedValue({
    [DEAL]: { pipeline: 'p1' },
  });
  (getDealEngagements as jest.Mock).mockResolvedValue({
    emails: [],
    calls: [],
    meetings: [],
    notes: [],
    tasks: [],
  });
  (fetchDealDetail as jest.Mock).mockResolvedValue({
    deal_id: DEAL,
    dealstage: 's_sent',
    pipeline: 'p1',
    amount: '5000',
    createdate: '2026-07-01T00:00:00Z',
    closedate: null,
    stage_entered_at: '2026-07-10T00:00:00Z',
    stage_entered: { s_sent: '2026-07-10T00:00:00Z' },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dealEvents
// ─────────────────────────────────────────────────────────────────────────────

describe('dealEvents', () => {
  const base = {
    deal_id: DEAL,
    dealstage: 's_sent',
    pipeline: 'p1',
    amount: '5000',
    createdate: '2026-07-01T00:00:00Z',
    closedate: null,
    stage_entered_at: '2026-07-10T00:00:00Z',
    stage_entered: {},
  };

  it('emits deal_created and one stage_change per RECORDED entry', () => {
    const { events } = dealEvents(
      { ...base, stage_entered: { s_sent: '2026-07-10T00:00:00Z' } },
      STAGES
    );
    expect(events.map((e) => e.type)).toEqual(['deal_created', 'stage_change']);
    expect(events[1]).toMatchObject({
      title: 'Contract Sent',
      meta: { stage_id: 's_sent', stage_type: 'open' },
    });
  });

  it('does NOT fabricate stage changes when HubSpot recorded no history', () => {
    // Sparse on older or manually-staged deals. A reconstruction at createdate would show a plausible
    // history that never happened.
    const { events } = dealEvents(base, STAGES);
    expect(events.map((e) => e.type)).toEqual(['deal_created']);
  });

  it('rolls a won stage into `acquired` rather than emitting a stage_change too', () => {
    const { events, acquiredAt } = dealEvents(
      {
        ...base,
        dealstage: 's_won',
        stage_entered: {
          s_sent: '2026-07-10T00:00:00Z',
          s_won: '2026-07-20T00:00:00Z',
        },
      },
      STAGES
    );
    expect(events.filter((e) => e.type === 'stage_change')).toHaveLength(1);
    const acq = events.find((e) => e.type === 'acquired');
    expect(acq).toMatchObject({ title: 'Closed Won', meta: { amount: 5000 } });
    expect(acquiredAt).toBe('2026-07-20T00:00:00Z');
  });

  it('falls back to closedate for a won deal with no stage-entry timestamp', () => {
    // HubSpot stamps closedate reliably on close even when the per-stage history is missing, which is
    // what makes the acquisition always showable.
    const { acquiredAt } = dealEvents(
      { ...base, dealstage: 's_won', closedate: '2026-07-25T00:00:00Z' },
      STAGES
    );
    expect(acquiredAt).toBe('2026-07-25T00:00:00Z');
  });

  it('falls back to the current stage entry when there is no closedate either', () => {
    const { acquiredAt } = dealEvents({ ...base, dealstage: 's_won' }, STAGES);
    expect(acquiredAt).toBe('2026-07-10T00:00:00Z');
  });

  it('reports an acquisition for a deal that PASSED THROUGH a won stage and moved on', () => {
    // Reopened deals exist; the acquisition still happened.
    const { acquiredAt, events } = dealEvents(
      {
        ...base,
        dealstage: 's_sent',
        stage_entered: { s_won: '2026-07-20T00:00:00Z' },
      },
      STAGES
    );
    expect(acquiredAt).toBe('2026-07-20T00:00:00Z');
    expect(events.find((e) => e.type === 'acquired')?.title).toBe('Closed Won');
  });

  it('reports no acquisition for an open deal', () => {
    expect(dealEvents(base, STAGES).acquiredAt).toBeNull();
  });

  it('drops an event with no usable timestamp instead of placing it at epoch zero', () => {
    // Epoch zero would sort before the deal existed and read as the first touch.
    const { events } = dealEvents({ ...base, createdate: null }, STAGES);
    expect(events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// engagementEvents
// ─────────────────────────────────────────────────────────────────────────────

describe('engagementEvents', () => {
  it('types emails and calls by direction', () => {
    const out = engagementEvents({
      emails: [
        {
          id: 'e1',
          hs_timestamp: '2026-07-02T00:00:00Z',
          hs_email_direction: 'INCOMING_EMAIL',
          hs_email_subject: 'Re: demo',
        },
        {
          id: 'e2',
          hs_timestamp: '2026-07-01T00:00:00Z',
          hs_email_direction: 'EMAIL',
        },
      ],
      calls: [
        {
          id: 'c1',
          hs_timestamp: '2026-07-03T00:00:00Z',
          hs_call_direction: 'INBOUND',
        },
        {
          id: 'c2',
          hs_timestamp: '2026-07-04T00:00:00Z',
          hs_call_direction: 'OUTBOUND',
        },
      ],
      meetings: [],
      notes: [],
      tasks: [],
    });
    expect(out.map((e) => [e.type, e.direction])).toEqual([
      ['email_reply', 'in'],
      ['email_sent', 'out'],
      ['customer_call', 'in'],
      ['ai_call', 'out'],
    ]);
  });

  it('uses the meeting START time, not the time it was logged', () => {
    const out = engagementEvents({
      meetings: [
        {
          id: 'm1',
          hs_timestamp: '2026-07-01T00:00:00Z',
          hs_meeting_start_time: '2026-07-15T14:00:00Z',
        },
      ],
    });
    expect(out[0].at).toBe('2026-07-15T14:00:00Z');
  });

  it('strips HTML from a note body and truncates it', () => {
    const out = engagementEvents({
      notes: [
        {
          id: 'n1',
          hs_timestamp: '2026-07-01T00:00:00Z',
          hs_note_body: '<p>Spoke to <b>Jane</b> &amp; agreed terms</p>',
        },
      ],
    });
    expect(out[0].title).toBe('Spoke to Jane & agreed terms');
  });

  it('files a task under the note channel, flagged in meta', () => {
    const out = engagementEvents({
      tasks: [
        {
          id: 't1',
          hs_timestamp: '2026-07-01T00:00:00Z',
          hs_task_subject: 'Follow up',
          hs_task_status: 'COMPLETED',
        },
      ],
    });
    expect(out[0]).toMatchObject({
      channel: 'note',
      type: 'note',
      title: 'Follow up',
      status: 'COMPLETED',
      meta: { is_task: true },
    });
  });

  it('drops an undated engagement and tolerates missing groups', () => {
    expect(
      engagementEvents({ emails: [{ id: 'e1', hs_email_subject: 'x' }] })
    ).toEqual([]);
    expect(engagementEvents({})).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the AI side
// ─────────────────────────────────────────────────────────────────────────────

describe('aiMessageEvents', () => {
  function msg(id: string, data: Record<string, unknown>) {
    store.set(`chats/${CHAT}/messages_v3/${id}`, {
      timestamp: '2026-07-01T00:00:00Z',
      ...data,
    });
  }

  it('SKIPS internal messages — the team talking to itself is not a touchpoint', async () => {
    // Counting them would inflate touchpoint_count with admin notes and `@ai` instructions.
    msg('m1', { direction: 'internal', source: 'web' });
    expect(await aiMessageEvents(CHAT)).toEqual([]);
  });

  it('types a call from either the direction or the sender kind', async () => {
    msg('m1', { source: 'call', direction: 'inbound' });
    msg('m2', { source: 'call', sender: { kind: 'customer' } });
    msg('m3', { source: 'call', direction: 'outbound' });
    const out = await aiMessageEvents(CHAT);
    // Either signal is enough — the two are set by different writers.
    expect(out.map((e) => e.type)).toEqual([
      'customer_call',
      'customer_call',
      'ai_call',
    ]);
  });

  it('carries only the call fields that are present', async () => {
    msg('m1', {
      source: 'call',
      content: { outcome: 'answered', duration: 90, summary: '' },
    });
    expect((await aiMessageEvents(CHAT))[0].meta).toEqual({
      outcome: 'answered',
      duration: 90,
    });
  });

  it('reads an email subject from the content or the message', async () => {
    msg('m1', { source: 'email', content: { subject: 'Inner' } });
    msg('m2', { source: 'email', subject: 'Outer' });
    const out = await aiMessageEvents(CHAT);
    expect(out.map((e) => e.title)).toEqual(['Inner', 'Outer']);
  });

  it('treats anything else as SMS, using the body as the title', async () => {
    msg('m1', { content: { body: 'hey there' } });
    expect((await aiMessageEvents(CHAT))[0]).toMatchObject({
      channel: 'sms',
      type: 'ai_sms',
      title: 'hey there',
    });
  });

  it('is empty for a chat with no messages', async () => {
    expect(await aiMessageEvents(CHAT)).toEqual([]);
  });
});

describe('aiActivityEvents', () => {
  function card(
    id: string,
    toolName: string,
    input: Record<string, unknown> = {}
  ) {
    store.set(`chats/${CHAT}/activities/${id}`, {
      timestamp: '2026-07-05T00:00:00Z',
      kind: 'tool_call',
      toolCall: { toolName, input },
    });
  }

  it('maps the four card types it recognises', async () => {
    card('a1', 'prospect_converted_to_deal', {
      stage: 'Closed Won',
      deal_id: DEAL,
      amount: '5000',
    });
    card('a2', 'hubspot_stage_synced', {
      hubspot_stage: 'Contract Sent',
      from_stage: 'Contacted',
      to_stage: 'Lead',
    });
    card('a3', 'schedule_hubspot_meeting', {
      start_time: 123,
      meeting_link: 'u',
    });
    card('a4', 'email_reply_received', { subject: 'Re: demo' });
    const out = await aiActivityEvents(CHAT);
    expect(out.map((e) => e.type)).toEqual([
      'acquired',
      'stage_change',
      'meeting',
      'email_reply',
    ]);
    expect(out[0].meta).toEqual({ deal_id: DEAL, amount: 5000 });
  });

  it.each([
    ['email_bounced', 'bounced'],
    ['bounced', 'bounced'],
    ['email_unsubscribed', 'unsubscribed'],
    ['unsubscribed', 'unsubscribed'],
  ])('maps %p to an outbound email with status %p', async (name, status) => {
    card('a1', name);
    expect((await aiActivityEvents(CHAT))[0]).toMatchObject({
      channel: 'email',
      direction: 'out',
      status,
    });
  });

  it('IGNORES every other card on the chat', async () => {
    // A chat carries dozens of cards that are not touchpoints — task creation, label changes, reviews.
    card('a1', 'create_custom_task');
    card('a2', 'review_call_transcript');
    expect(await aiActivityEvents(CHAT)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// de-duplication
// ─────────────────────────────────────────────────────────────────────────────

describe('dedupFamily', () => {
  it('buckets every acquisition together, whatever its source or time', () => {
    expect(dedupFamily(event({ type: 'acquired' }))).toBe('acquired');
  });

  it('buckets a stage change by LABEL, since the two sources name it differently', () => {
    // The AI card records the label; HubSpot records the id.
    expect(
      dedupFamily(event({ type: 'stage_change', title: '  Contract Sent ' }))
    ).toBe('stage|contract sent');
  });

  it('buckets emails per direction within a TWO-MINUTE window', () => {
    // Fuzzy on purpose: the two systems stamp the same send seconds apart, so an exact key would collapse
    // nothing at all.
    const t = Date.parse('2026-07-01T00:00:00Z');
    expect(dedupFamily(event({ _ms: t }))).toBe(
      dedupFamily(event({ _ms: t + 60_000 }))
    );
    expect(dedupFamily(event({ _ms: t }))).not.toBe(
      dedupFamily(event({ _ms: t + 200_000 }))
    );
    // Direction is part of the key — a reply is not the same touch as the send.
    expect(dedupFamily(event({ _ms: t, direction: 'in' }))).not.toBe(
      dedupFamily(event({ _ms: t, direction: 'out' }))
    );
  });

  it('buckets meetings within a DAY', () => {
    const t = Date.parse('2026-07-01T09:00:00Z');
    expect(
      dedupFamily(event({ channel: 'meeting', type: 'meeting', _ms: t }))
    ).toBe(
      dedupFamily(
        event({ channel: 'meeting', type: 'meeting', _ms: t + 3_600_000 })
      )
    );
  });

  it.each([
    [{ channel: 'call', type: 'ai_call' }],
    [{ channel: 'note', type: 'note' }],
    [{ channel: 'deal', type: 'deal_created' }],
  ])('never de-dupes %p', (over) => {
    // Two calls two minutes apart are two calls.
    expect(dedupFamily(event(over))).toBeNull();
  });
});

describe('dedup', () => {
  it('keeps the HubSpot record over the AI reconstruction', () => {
    const t = Date.parse('2026-07-01T00:00:00Z');
    const out = dedup([
      event({ source: 'ai', _ms: t, title: 'AI subject' }),
      event({ source: 'hubspot', _ms: t + 30_000, title: 'HS subject' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'hubspot', title: 'HS subject' });
  });

  it('lets the LOSER donate the fields the winner lacks', () => {
    // Preferring the authoritative record must not mean losing the richer one's detail.
    const t = Date.parse('2026-07-01T00:00:00Z');
    const out = dedup([
      event({
        source: 'ai',
        _ms: t,
        title: 'AI subject',
        status: 'delivered',
        meta: { chat_id: CHAT },
      }),
      event({
        source: 'hubspot',
        _ms: t,
        title: null,
        meta: { engagement_id: 'e1' },
      }),
    ]);
    expect(out[0]).toMatchObject({
      source: 'hubspot',
      title: 'AI subject',
      status: 'delivered',
      meta: { engagement_id: 'e1', chat_id: CHAT },
    });
  });

  it('lets the WINNER keep its own value when both have one', () => {
    const t = Date.parse('2026-07-01T00:00:00Z');
    const out = dedup([
      event({ source: 'ai', _ms: t, title: 'AI', meta: { k: 'ai' } }),
      event({ source: 'hubspot', _ms: t, title: 'HS', meta: { k: 'hs' } }),
    ]);
    expect(out[0]).toMatchObject({ title: 'HS', meta: { k: 'hs' } });
  });

  it('breaks a same-source tie on having a title, then on metadata count', () => {
    const t = Date.parse('2026-07-01T00:00:00Z');
    const titled = dedup([
      event({ source: 'ai', _ms: t, title: null }),
      event({ source: 'ai', _ms: t, title: 'Has one' }),
    ]);
    expect(titled[0].title).toBe('Has one');

    const richer = dedup([
      event({ source: 'ai', _ms: t, title: 'a', meta: {} }),
      event({ source: 'ai', _ms: t, title: 'b', meta: { x: 1, y: 2 } }),
    ]);
    expect(richer[0].meta).toEqual({ x: 1, y: 2 });
  });

  it('passes never-de-duped events through untouched', () => {
    const calls = [
      event({ channel: 'call', type: 'ai_call' }),
      event({ channel: 'call', type: 'ai_call' }),
    ];
    expect(dedup(calls)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findSourceChat
// ─────────────────────────────────────────────────────────────────────────────

describe('findSourceChat', () => {
  it('follows the attribution linkage from a deal id', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: { hubspot_deal_id: DEAL },
    });
    const [id, data] = await findSourceChat(DEAL);
    expect(id).toBe(CHAT);
    expect(data).toMatchObject({ type: 'outbound' });
  });

  it('prefers an explicit chat id over the linkage', async () => {
    store.set('chats/explicit', { type: 'outbound' });
    store.set(`chats/${CHAT}`, { memory: { hubspot_deal_id: DEAL } });
    expect((await findSourceChat(DEAL, 'explicit'))[0]).toBe('explicit');
  });

  it('is [null, null] for a deal with no chat — a normal answer, not an error', async () => {
    // A rep can create a deal from scratch, and that deal has no chat we know of.
    expect(await findSourceChat('unknown_deal')).toEqual([null, null]);
    expect(await findSourceChat(null, 'ghost')).toEqual([null, null]);
    expect(await findSourceChat()).toEqual([null, null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDealTimeline
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDealTimeline', () => {
  function seedChat(over: Record<string, unknown> = {}) {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      record_type: 'Real',
      ...over,
      memory: {
        hubspot_deal_id: DEAL,
        hubspot_contact_id: 'c1',
        first_name: 'Jane',
        last_name: 'Doe',
        company: 'Acme',
        phone_number: '+13035551212',
        customer_email: 'jane@acme.com',
        ...((over.memory ?? {}) as Record<string, unknown>),
      },
    });
  }

  it('builds the full contract for an open deal', async () => {
    seedChat();
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(out.success).toBe(true);
    expect(out.deal).toEqual({
      deal_id: DEAL,
      stage: 's_sent',
      stage_label: 'Contract Sent',
      pipeline: 'Outbound',
      amount: 5000,
      created_at: '2026-07-01T00:00:00Z',
      acquired_at: null,
    });
    expect(out.contact).toEqual({
      contact_id: 'c1',
      name: 'Jane Doe',
      company: 'Acme',
      phone: '+13035551212',
      email: 'jane@acme.com',
    });
    expect(out.chat_id).toBe(CHAT);
    expect(out.first_touch_at).toBe('2026-07-01T00:00:00Z');
    expect(out.days_to_acquire).toBeNull();
    expect(out.touchpoint_count).toBe(2);
  });

  it('STRIPS the internal sort key from every event', async () => {
    seedChat();
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    for (const e of out.events ?? []) expect('_ms' in e).toBe(false);
  });

  it('sorts ascending, with deal_created first on a tie', async () => {
    // Nothing can precede the deal existing.
    seedChat();
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      timestamp: '2026-07-01T00:00:00Z',
      source: 'email',
      content: { subject: 'first touch' },
    });
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(out.events?.[0].type).toBe('deal_created');
  });

  it('DROPS an AI acquisition when the deal is still open', async () => {
    // `prospect_converted_to_deal` is written for any attributed deal; on an open one it is an
    // attribution marker, and showing it would report the deal as won.
    seedChat();
    store.set(`chats/${CHAT}/activities/a1`, {
      timestamp: '2026-07-12T00:00:00Z',
      toolCall: {
        toolName: 'prospect_converted_to_deal',
        input: { stage: 'Lead' },
      },
    });
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(out.events?.some((e) => e.type === 'acquired')).toBe(false);
    expect(out.deal?.acquired_at).toBeNull();
  });

  it('keeps ONE acquisition on a won deal, preferring the HubSpot record', async () => {
    (fetchDealDetail as jest.Mock).mockResolvedValue({
      deal_id: DEAL,
      dealstage: 's_won',
      pipeline: 'p1',
      amount: '5000',
      createdate: '2026-07-01T00:00:00Z',
      closedate: '2026-07-20T00:00:00Z',
      stage_entered_at: '2026-07-20T00:00:00Z',
      stage_entered: { s_won: '2026-07-20T00:00:00Z' },
    });
    seedChat();
    store.set(`chats/${CHAT}/activities/a1`, {
      timestamp: '2026-07-19T00:00:00Z',
      toolCall: {
        toolName: 'prospect_converted_to_deal',
        input: { stage: 'Closed Won', deal_id: DEAL },
      },
    });
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    const acq = out.events?.filter((e) => e.type === 'acquired') ?? [];
    expect(acq).toHaveLength(1);
    expect(acq[0].source).toBe('hubspot');
    expect(out.deal?.acquired_at).toBe('2026-07-20T00:00:00Z');
    // First touch to acquisition, rounded to whole days.
    expect(out.days_to_acquire).toBe(19);
  });

  it('excludes a Test deal from the default Real view, and includes it under all', async () => {
    seedChat({ record_type: 'Test' });
    expect(
      await buildDealTimeline({ agentId: AGENT, dealId: DEAL })
    ).toMatchObject({
      success: true,
      reason: 'record_type_excluded',
      events: [],
    });
    expect(
      (
        await buildDealTimeline({
          agentId: AGENT,
          dealId: DEAL,
          recordType: 'all',
        })
      ).success
    ).toBe(true);
  });

  it('surfaces AI and HubSpot touchpoints side by side', async () => {
    seedChat();
    (getDealEngagements as jest.Mock).mockResolvedValue({
      calls: [
        {
          id: 'c1',
          hs_timestamp: '2026-07-05T00:00:00Z',
          hs_call_direction: 'OUTBOUND',
        },
      ],
    });
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      timestamp: '2026-07-03T00:00:00Z',
      content: { body: 'checking in' },
    });
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(out.events?.map((e) => [e.source, e.type])).toEqual([
      ['hubspot', 'deal_created'],
      ['ai', 'ai_sms'],
      ['hubspot', 'ai_call'],
      ['hubspot', 'stage_change'],
    ]);
  });

  it('still builds when the engagement read fails', async () => {
    // Best-effort: losing HubSpot's engagements should not lose the deal's own history.
    seedChat();
    (getDealEngagements as jest.Mock).mockRejectedValue(new Error('429'));
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(out.success).toBe(true);
    expect(out.touchpoint_count).toBe(2);
  });

  it.each([
    [{ dealId: DEAL }, 'agent_id is required'],
    [{ agentId: AGENT }, 'deal_id or chat_id is required'],
  ])('returns success:false for %p', async (opts, error) => {
    expect(await buildDealTimeline(opts)).toEqual({ success: false, error });
  });

  it('distinguishes an ERROR from an empty REASON', async () => {
    // The FE relies on this: a bad config is the caller's problem, a deal with nothing to show is not.
    seedChat();
    (resolveHubspotConfig as jest.Mock).mockReturnValue({});
    expect(await buildDealTimeline({ agentId: AGENT, dealId: DEAL })).toEqual({
      success: false,
      error: 'agent has no HubSpot config',
    });

    (resolveHubspotConfig as jest.Mock).mockReturnValue({
      access_token: 'tok',
    });
    (accessToken as jest.Mock).mockResolvedValue(null);
    expect(await buildDealTimeline({ agentId: AGENT, dealId: DEAL })).toEqual({
      success: false,
      error: 'could not acquire HubSpot token',
    });
  });

  it.each([
    ['no_source_chat', () => undefined],
    [
      'no_deal_on_chat',
      () => store.set(`chats/${CHAT}`, { type: 'outbound', memory: {} }),
    ],
  ])('reports reason %p with an empty list', async (reason, arrange) => {
    arrange();
    const out = await buildDealTimeline({
      agentId: AGENT,
      chatId: reason === 'no_source_chat' ? 'ghost' : CHAT,
    });
    expect(out).toMatchObject({ success: true, reason, events: [] });
  });

  it('reports deal_not_found when the deal cannot be read', async () => {
    seedChat();
    (readDealsBatch as jest.Mock).mockResolvedValue({});
    expect(
      await buildDealTimeline({ agentId: AGENT, dealId: DEAL })
    ).toMatchObject({ success: true, reason: 'deal_not_found' });
  });

  it('prefers the DEAL’s own pipeline over the configured one', async () => {
    // A rep can move a deal into a pipeline the agent is not configured for, and its own stage labels are
    // the ones the timeline should show.
    seedChat();
    (readDealsBatch as jest.Mock).mockResolvedValue({
      [DEAL]: { pipeline: 'p_other' },
    });
    await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(dealPipelineStages).toHaveBeenCalledWith('tok', 'p_other', 's_lead');
  });

  it('falls back to the configured pipeline when the deal’s cannot be read', async () => {
    seedChat();
    (readDealsBatch as jest.Mock).mockResolvedValue({
      [DEAL]: { pipeline: 'p_other' },
    });
    (dealPipelineStages as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        label: 'Outbound',
        stages: Object.values(STAGES),
      });
    const out = await buildDealTimeline({ agentId: AGENT, dealId: DEAL });
    expect(dealPipelineStages).toHaveBeenCalledTimes(2);
    expect(out.deal?.pipeline).toBe('Outbound');
  });

  it('falls back to display_name when there is no first/last name', async () => {
    seedChat({
      memory: { first_name: '', last_name: '', display_name: 'Acme Motors' },
    });
    expect(
      (await buildDealTimeline({ agentId: AGENT, dealId: DEAL })).contact
    ).toMatchObject({ name: 'Acme Motors' });
  });
});
