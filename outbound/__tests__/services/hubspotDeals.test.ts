/**
 * @jest-environment node
 *
 * HubSpot stage sync, deals, and the deal brief.
 *
 * `syncHubspotStage` runs after every stage write, so the properties that matter are about what it
 * REFUSES and what it writes only once:
 *
 *  - **The forward-only guard has two halves.** Same-stage is idempotence (which is what lets callers
 *    fire unconditionally); the rank comparison is never-downgrade. `Lost` is exempt from the rank
 *    because it is terminal — blocking it would leave a closed prospect looking open in the CRM.
 *  - **Minimal writes.** Core fields are written once at creation; an existing contact is not
 *    re-enriched per transition, so the CRM's own edits survive.
 *  - **Create vs LINK are different activities.** A campaign against records that already existed must
 *    show "updated", not "created".
 *  - **The brief is guaranteed non-empty**, because outbound populates none of the inbound
 *    qualification keys and thin/empty Notes were the original bug.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../tools/reviewHelpers', () => ({ llmText: jest.fn() }));
jest.mock('../../services/conversationSummary', () => ({
  generateAndCacheSummary: jest.fn(),
}));

import { store } from '../../testSupport/mockFirestore';
import { llmText } from '../../tools/reviewHelpers';
import { generateAndCacheSummary } from '../../services/conversationSummary';
import {
  DEAL_CAMPAIGN_PROP,
  dealname,
  deterministicDealBrief,
  generateDealBrief,
  maybeAddDealConversationNote,
  recentTranscript,
  schedulingPageUrl,
  syncHubspotStage,
} from '../../services/hubspotDeals';
import type { ChatMemory } from '../../types';

const llm = llmText as jest.Mock;
const cacheSummary = generateAndCacheSummary as jest.Mock;

const TOKEN = 'pat-token';
const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';
const CONTACT = 'c_1';
const DEAL = 'd_1';

let fetchMock: jest.Mock;

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Wire the agent's HubSpot v2 action with a full pipeline config. */
function seedAgent(meta: Record<string, unknown> = {}) {
  store.set(`agents/${AGENT}`, {});
  store.set(`agents/${AGENT}/actions/a1`, {
    status: 'active',
    provider: 'hubspot_v2',
    auth: { access_token: TOKEN },
    additional_meta: {
      pipeline_id: 'pipe_1',
      stage_ids: { Lead: 'stage_lead', Lost: 'stage_lost' },
      stage_values: { Contacted: 'CONTACTED_VAL', Lead: 'LEAD_VAL' },
      ...meta,
    },
  });
}

function seedChat(over: Record<string, unknown> = {}) {
  const { memory: memOver, ...rest } = over;
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    agentId: AGENT,
    stage: 'Contacted',
    ...rest,
    memory: {
      agent_id: AGENT,
      customer_email: 'jane@corp.com',
      first_name: 'Jane',
      last_name: 'Doe',
      company: 'Acme',
      phone_number: '15551230000',
      ...((memOver as Record<string, unknown>) ?? {}),
    },
  });
}

function memory(): Record<string, unknown> {
  return (store.get(`chats/${CHAT}`)?.memory ?? {}) as Record<string, unknown>;
}

function activities(): Array<Record<string, unknown>> {
  return store
    .paths(`chats/${CHAT}/activities`)
    .map((p) => store.get(p) as Record<string, unknown>);
}

function activityNames(): string[] {
  return activities().map(
    (a) => String((a.toolCall as Record<string, unknown>).toolName)
  );
}

/** Every request made, as `METHOD url`. */
function calls(): string[] {
  return fetchMock.mock.calls.map(
    (c) => `${(c[1] as { method?: string }).method ?? 'GET'} ${String(c[0])}`
  );
}

/**
 * The body of the first POST to `matcher`.
 *
 * POST-only and `search`-excluded on purpose: `/objects/contacts/search` also contains
 * `/objects/contacts`, and its body's `properties` is a string ARRAY, which silently defeated my first
 * version of this helper.
 */
function bodyOf(matcher: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    (c) =>
      String(c[0]).includes(matcher) &&
      !String(c[0]).includes('search') &&
      (c[1] as { method?: string }).method === 'POST'
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : {};
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  llm.mockResolvedValue('');
  cacheSummary.mockResolvedValue('');
  fetchMock = jest.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/contacts/search')) return ok({ results: [] });
    if (u.includes('/objects/contacts') && !u.includes('search')) {
      return ok({ id: CONTACT, properties: {} }, 201);
    }
    if (u.includes('/objects/deals')) return ok({ id: DEAL }, 201);
    if (u.includes('/objects/notes')) return ok({ id: 'n_1' }, 201);
    if (u.includes('/properties/deals')) return ok({}, 200);
    return ok({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  seedAgent();
  seedChat();
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// The guards
// ─────────────────────────────────────────────────────────────────────────────

describe('syncHubspotStage guards', () => {
  test('a NON-outbound chat is never synced', async () => {
    seedChat({ type: 'web' });
    await syncHubspotStage(CHAT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the same stage already synced is a free no-op', async () => {
    // This is what lets every caller fire unconditionally after a stage write.
    seedChat({ memory: { _hubspot_synced_stage: 'Contacted' } });
    await syncHubspotStage(CHAT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a BACKWARD move is refused, so hs_lead_status is never downgraded', async () => {
    seedChat({ stage: 'Contacted', memory: { _hubspot_synced_stage: 'Engaged' } });
    await syncHubspotStage(CHAT);
    expect(fetchMock).not.toHaveBeenCalled();
    // The already-synced marker is untouched.
    expect(memory()._hubspot_synced_stage).toBe('Engaged');
  });

  test('a FORWARD move proceeds', async () => {
    seedChat({ stage: 'Engaged', memory: { _hubspot_synced_stage: 'Contacted' } });
    await syncHubspotStage(CHAT);
    expect(memory()._hubspot_synced_stage).toBe('Engaged');
  });

  test('LOST always syncs, even from a later stage — it is terminal', async () => {
    // Lost is absent from the rank on purpose; blocking it would leave a closed prospect open.
    seedChat({
      stage: 'Lost',
      memory: {
        _hubspot_synced_stage: 'Lead',
        hubspot_contact_id: CONTACT,
        hubspot_deal_id: DEAL,
      },
    });
    await syncHubspotStage(CHAT);
    expect(calls().some((c) => c.startsWith('PATCH') && c.includes('/deals/'))).toBe(
      true
    );
    expect(memory()._hubspot_synced_stage).toBe('Lost');
  });

  test('an unconfigured agent is a silent no-op', async () => {
    // Connecting the action IS the on-switch; there is no separate toggle.
    store.set(`agents/${AGENT}/actions/a1`, { status: 'active', provider: 'hubspot_v2', auth: {} });
    await syncHubspotStage(CHAT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a chat with no stage, or no agent, does nothing', async () => {
    seedChat({ stage: '', memory: { agent_id: '' } });
    store.set(`chats/${CHAT}`, { ...store.get(`chats/${CHAT}`)!, agentId: '' });
    await syncHubspotStage(CHAT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a missing chat is a clean no-op', async () => {
    store.reset();
    await expect(syncHubspotStage('nope')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contact stages
// ─────────────────────────────────────────────────────────────────────────────

describe('a contact-stage sync', () => {
  test('creates the contact with the core fields ONCE and stamps the stage', async () => {
    await syncHubspotStage(CHAT);
    const created = bodyOf('/objects/contacts');
    expect(created.properties).toMatchObject({
      email: 'jane@corp.com',
      firstname: 'Jane',
      lastname: 'Doe',
      company: 'Acme',
      phone: '15551230000',
      lead_source: 'Lily Outbound Comms',
      record_type: 'Real',
    });
    expect(memory().hubspot_contact_id).toBe(CONTACT);
    expect(activityNames()).toContain('hubspot_contact_created');
    expect(activityNames()).toContain('hubspot_stage_updated');
  });

  test('the configured stage VALUE is written, not the stage name', async () => {
    await syncHubspotStage(CHAT);
    const patch = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string }).method === 'PATCH'
    );
    const body = JSON.parse((patch![1] as { body: string }).body);
    expect(body.properties.hs_lead_status).toBe('CONTACTED_VAL');
  });

  test('a timezone is converted to HubSpot’s own format', async () => {
    seedChat({ memory: { timezone: 'America/New_York' } });
    await syncHubspotStage(CHAT);
    expect(
      (bodyOf('/objects/contacts').properties as Record<string, unknown>)
        .hs_timezone
    ).toBe('america_slash_new_york');
  });

  test('a TEST record is kept off the marketing-contact bill', async () => {
    // E2E runs create real HubSpot contacts, and marketing contacts are billed.
    seedChat({ memory: { record_type: 'Test' } });
    await syncHubspotStage(CHAT);
    const props = bodyOf('/objects/contacts').properties as Record<
      string,
      unknown
    >;
    expect(props.hs_marketable_status).toBe('false');
    expect(props.record_type).toBe('Test');
  });

  test('a Test record uses the TEST owner', async () => {
    seedAgent({ owner_id: 'real_owner', owner_id_test: 'test_owner' });
    seedChat({ memory: { record_type: 'Test' } });
    await syncHubspotStage(CHAT);
    expect(
      (bodyOf('/objects/contacts').properties as Record<string, unknown>)
        .hubspot_owner_id
    ).toBe('test_owner');
  });

  test('record_type is accepted from the chat-doc TOP LEVEL too', async () => {
    seedChat({ record_type: 'Test', memory: {} });
    await syncHubspotStage(CHAT);
    expect(
      (bodyOf('/objects/contacts').properties as Record<string, unknown>)
        .record_type
    ).toBe('Test');
  });

  test('an EXISTING HubSpot contact is LINKED, and logs "updated" not "created"', async () => {
    // A campaign against records that already existed must not imply we created them.
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/contacts/search')) return ok({ results: [{ id: 'existing' }] });
      return ok({}, 200);
    });
    await syncHubspotStage(CHAT);
    expect(activityNames()).toContain('hubspot_contact_updated');
    expect(activityNames()).not.toContain('hubspot_contact_created');
    expect(memory().hubspot_contact_id).toBe('existing');
  });

  test('an already-linked contact is NOT re-enriched — minimal writes', async () => {
    seedChat({ memory: { hubspot_contact_id: CONTACT } });
    await syncHubspotStage(CHAT);
    // No POST to create, and the only contact write is the stage PATCH.
    const contactWrites = calls().filter((c) => c.includes('/objects/contacts'));
    expect(contactWrites.every((c) => c.startsWith('PATCH'))).toBe(true);
  });

  test('a Note is written so HubSpot’s last-activity date reflects the push', async () => {
    await syncHubspotStage(CHAT);
    const note = bodyOf('/objects/notes');
    expect(String((note.properties as Record<string, unknown>).hs_note_body)).toContain(
      'prospect stage updated to <b>Contacted</b>'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lead → deal
// ─────────────────────────────────────────────────────────────────────────────

describe('a Lead sync', () => {
  test('creates the deal, advances the contact, and records both', async () => {
    seedChat({ stage: 'Lead' });
    await syncHubspotStage(CHAT);
    const deal = bodyOf('/objects/deals');
    expect(deal.properties).toMatchObject({
      dealname: 'Jane Doe — Acme',
      pipeline: 'pipe_1',
      dealstage: 'stage_lead',
    });
    // The deal is associated to its contact on creation.
    expect((deal.associations as unknown[])).toHaveLength(1);
    expect(memory().hubspot_deal_id).toBe(DEAL);
    expect(activityNames()).toContain('hubspot_deal_created');
  });

  test('the contact’s lead status advances to Lead too', async () => {
    // HubSpot auto-advances lifecyclestage, but lead-status would stay stuck at Engaged.
    seedChat({ stage: 'Lead', memory: { hubspot_contact_id: CONTACT } });
    await syncHubspotStage(CHAT);
    const patch = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]).includes('/objects/contacts/') &&
        (c[1] as { method?: string }).method === 'PATCH'
    );
    const body = JSON.parse((patch![1] as { body: string }).body);
    expect(body.properties.hs_lead_status).toBe('LEAD_VAL');
  });

  test('campaign attribution lands on the DEAL, not just the contact', async () => {
    // HubSpot cannot filter a deal by its contact's property, so the funnel needs it here.
    seedChat({ stage: 'Lead', memory: { campaign_id: 'camp_9' } });
    await syncHubspotStage(CHAT);
    const props = bodyOf('/objects/deals').properties as Record<string, unknown>;
    expect(props[DEAL_CAMPAIGN_PROP]).toBe('camp_9');
  });

  test('the deal INHERITS the contact’s owner', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/contacts/search')) return ok({ results: [] });
      if (u.includes('hubspot_owner_id')) {
        return ok({ properties: { hubspot_owner_id: 'own_7' } });
      }
      if (u.includes('/objects/contacts')) return ok({ id: CONTACT }, 201);
      if (u.includes('/objects/deals')) return ok({ id: DEAL }, 201);
      return ok({});
    });
    seedChat({ stage: 'Lead' });
    await syncHubspotStage(CHAT);
    expect(
      (bodyOf('/objects/deals').properties as Record<string, unknown>)
        .hubspot_owner_id
    ).toBe('own_7');
  });

  test('an existing deal is counted as synced without creating another', async () => {
    seedChat({
      stage: 'Lead',
      memory: { hubspot_contact_id: CONTACT, hubspot_deal_id: DEAL },
    });
    await syncHubspotStage(CHAT);
    expect(calls().some((c) => c === `POST ${'https://api.hubapi.com'}/crm/v3/objects/deals`)).toBe(
      false
    );
    expect(memory()._hubspot_synced_stage).toBe('Lead');
  });

  test('Lead with NO pipeline configured warns and creates nothing', async () => {
    seedAgent({ pipeline_id: '', stage_ids: {} });
    seedChat({ stage: 'Lead' });
    await syncHubspotStage(CHAT);
    expect(memory().hubspot_deal_id).toBeUndefined();
    // Nothing was marked synced, so a later config fix retries.
    expect(memory()._hubspot_synced_stage).toBeUndefined();
  });
});

describe('a Lost sync', () => {
  test('moves an existing DEAL to the closed-lost stage', async () => {
    seedChat({
      stage: 'Lost',
      memory: { hubspot_contact_id: CONTACT, hubspot_deal_id: DEAL },
    });
    await syncHubspotStage(CHAT);
    const patch = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/objects/deals/')
    );
    expect(JSON.parse((patch![1] as { body: string }).body).properties.dealstage).toBe(
      'stage_lost'
    );
    expect(activityNames()).toContain('hubspot_deal_updated');
  });

  test('with NO deal, falls back to the contact’s lead status', async () => {
    seedChat({ stage: 'Lost', memory: { hubspot_contact_id: CONTACT } });
    await syncHubspotStage(CHAT);
    const patch = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/objects/contacts/')
    );
    // The default when no Lost value is configured.
    expect(
      JSON.parse((patch![1] as { body: string }).body).properties.hs_lead_status
    ).toBe('Unqualified');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The deal brief
// ─────────────────────────────────────────────────────────────────────────────

describe('the deal brief', () => {
  function seedTranscript() {
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      timestamp: new Date('2026-08-01T10:00:00Z'),
      sender: { kind: 'customer' },
      content: { body: 'We run 3 rooftops.' },
    });
    store.set(`chats/${CHAT}/messages_v3/m2`, {
      timestamp: new Date('2026-08-01T10:01:00Z'),
      sender: { kind: 'ai' },
      content: { body: 'Great — Thursday at 10?' },
    });
    store.set(`chats/${CHAT}/messages_v3/m3`, {
      timestamp: new Date('2026-08-01T10:02:00Z'),
      direction: 'internal',
      sender: { kind: 'ai' },
      content: { body: 'internal note, not conversation' },
    });
  }

  test('the transcript is oldest-first and EXCLUDES internal notes', async () => {
    seedTranscript();
    const t = await recentTranscript(CHAT, 10);
    expect(t).toBe('CUSTOMER: We run 3 rooftops.\nAGENT: Great — Thursday at 10?');
    // Internal notes are our own annotations, not conversation.
    expect(t).not.toContain('internal note');
  });

  test('the inbound qualification keys drive the deterministic brief when present', async () => {
    const brief = await deterministicDealBrief({
      dealer_type: 'Franchise',
      rooftops: '3',
      demo_time: 'Thursday 10am',
    } as unknown as ChatMemory);
    expect(brief).toContain('<b>Dealer type:</b> Franchise');
    expect(brief).toContain('<b>Rooftops:</b> 3');
  });

  test('with NONE of them set it falls back to what outbound actually has', async () => {
    // This is the fix for outbound Notes arriving thin or empty.
    const brief = await deterministicDealBrief({
      first_name: 'Jane',
      last_name: 'Doe',
      company: 'Acme',
      meeting_at: 'Thursday 10am',
      _conversation_summary: 'Wants to book a demo.',
    } as unknown as ChatMemory);
    expect(brief).toContain('<b>Prospect:</b> Jane Doe');
    expect(brief).toContain('<b>Company:</b> Acme');
    expect(brief).toContain('<b>Demo:</b> Thursday 10am');
    expect(brief).toContain('<b>Summary:</b> Wants to book a demo.');
  });

  test('with no summary either, a transcript excerpt still gives the rep something', async () => {
    seedTranscript();
    const brief = await deterministicDealBrief(
      { first_name: 'Jane' } as unknown as ChatMemory,
      CHAT
    );
    expect(brief).toContain('<b>Recent conversation:</b>');
    expect(brief).toContain('We run 3 rooftops.');
  });

  test('the LLM brief is used when it produces text', async () => {
    seedTranscript();
    llm.mockResolvedValue('<b>Prospect:</b> Jane at Acme');
    expect(await generateDealBrief(CHAT, {} as ChatMemory)).toBe(
      '<b>Prospect:</b> Jane at Acme'
    );
  });

  test('the LLM is RETRIED once — the note is written only once per deal', async () => {
    seedTranscript();
    llm.mockResolvedValueOnce('').mockResolvedValueOnce('<b>Prospect:</b> Jane');
    expect(await generateDealBrief(CHAT, {} as ChatMemory)).toBe(
      '<b>Prospect:</b> Jane'
    );
    expect(llm).toHaveBeenCalledTimes(2);
  });

  test('with nothing to brief on at all, the LLM is not called', async () => {
    expect(await generateDealBrief(CHAT, {} as ChatMemory)).toBe('');
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('maybeAddDealConversationNote', () => {
  beforeEach(() => {
    seedChat({
      memory: {
        hubspot_deal_id: DEAL,
        hubspot_contact_id: CONTACT,
        meeting_booked: true,
        meeting_at: 'Thursday 10am',
        _conversation_summary: 'Wants a demo.',
      },
    });
  });

  test('posts the brief once and stamps the marker', async () => {
    await maybeAddDealConversationNote(CHAT, AGENT);
    const note = bodyOf('/objects/notes');
    expect(String((note.properties as Record<string, unknown>).hs_note_body)).toContain(
      'Wants a demo.'
    );
    expect(typeof memory()._hubspot_deal_note_at).toBe('string');
  });

  test('is EXACTLY once per deal', async () => {
    seedChat({
      memory: {
        hubspot_deal_id: DEAL,
        meeting_booked: true,
        _hubspot_deal_note_at: '2026-08-01T00:00:00Z',
      },
    });
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a Lead with NO booked meeting has nothing to brief on', async () => {
    seedChat({ memory: { hubspot_deal_id: DEAL } });
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('no deal at all is a no-op', async () => {
    seedChat({ memory: { meeting_booked: true } });
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a playground chat is skipped', async () => {
    seedChat({
      playground: true,
      memory: { hubspot_deal_id: DEAL, meeting_booked: true },
    });
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a MISSING summary is filled, but a cached one is never regenerated', async () => {
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      timestamp: new Date(),
      sender: { kind: 'customer' },
      content: { body: 'hello' },
    });
    // Cached → no regeneration, because reviews refresh it over the deal's life.
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(cacheSummary).not.toHaveBeenCalled();

    store.reset();
    seedAgent();
    seedChat({
      memory: { hubspot_deal_id: DEAL, meeting_booked: true },
    });
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      timestamp: new Date(),
      sender: { kind: 'customer' },
      content: { body: 'hello' },
    });
    cacheSummary.mockResolvedValue('generated summary');
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(cacheSummary).toHaveBeenCalled();
  });

  test('a brief that comes back empty writes no note', async () => {
    // Every field blanked: seedChat's defaults (name, company) would otherwise be enough for the
    // deterministic brief to produce something — which is the point of that fallback.
    seedChat({
      memory: {
        hubspot_deal_id: DEAL,
        meeting_booked: true,
        first_name: '',
        last_name: '',
        company: '',
        customer_email: '',
      },
    });
    await maybeAddDealConversationNote(CHAT, AGENT);
    expect(calls().some((c) => c.includes('/objects/notes'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('dealname', () => {
  test('joins person, vehicle, and company', () => {
    expect(
      dealname({
        first_name: 'Jane',
        last_name: 'Doe',
        year: 2022,
        make: 'Ford',
        model: 'F-150',
        company: 'Acme',
      } as unknown as ChatMemory)
    ).toBe('Jane Doe — 2022 Ford F-150 — Acme');
  });

  test('falls back to the email, then to a generic name', () => {
    expect(
      dealname({ customer_email: 'jane@corp.com' } as unknown as ChatMemory)
    ).toBe('jane@corp.com');
    expect(dealname({} as ChatMemory)).toBe('Outbound opportunity');
  });
});

describe('schedulingPageUrl', () => {
  test('builds the public meetings URL, or null', () => {
    expect(schedulingPageUrl('my-slug')).toBe(
      'https://meetings.hubspot.com/my-slug'
    );
    expect(schedulingPageUrl(null)).toBeNull();
  });
});
