/**
 * @jest-environment node
 *
 * The seven HubSpot admin/preview views.
 *
 * Two things here are worth protecting above the rest:
 *
 *  - **The two token resolvers prefer OPPOSITE sources**, and both preferences are deliberate. A
 *    "consistency" cleanup either breaks step-1 setup (no saved action yet) or breaks token refresh
 *    (a bare access_token cannot be refreshed).
 *  - **`delete-records` is gated twice**, and its memory cleanup fires only for a delete that actually
 *    succeeded — clearing an id on a failure would orphan a live CRM record.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/agent', () => ({ getAgentActions: jest.fn() }));
jest.mock('../../firebase/chat', () => ({
  getMemory: jest.fn(),
  setMemory: jest.fn(),
}));
jest.mock('../../services/hubspot', () => ({
  accessToken: jest.fn(),
  deleteHubspotRecords: jest.fn(),
  resolveHubspotConfig: jest.fn(),
}));
jest.mock('../../services/hubspotDiscovery', () => ({
  MANAGED_CONTACT_PROPERTIES: ['hs_lead_status', 'lead_source'],
  addPropertyOption: jest.fn(),
  discoverHubspotConfig: jest.fn(),
}));
jest.mock('../../services/hubspotAudiences', () => ({
  allContactPropertyNames: jest.fn(),
  dropExcludedMembers: jest.fn(),
  fetchHubspotListMembers: jest.fn(),
  listHubspotContactProperties: jest.fn(),
  listHubspotLists: jest.fn(),
  searchHubspotContacts: jest.fn(),
}));
jest.mock('../../services/campaigns', () => ({
  enrolledChannelKeys: jest.fn(),
  enrolledContactIds: jest.fn(),
}));

import {
  hubspotAddPropertyOptionView,
  hubspotContactPropertiesView,
  hubspotDeleteRecordsView,
  hubspotDiscoveryView,
  hubspotListMembersView,
  hubspotListsView,
  hubspotSearchContactsView,
} from '../../http/hubspotViews';
import { getAgentActions } from '../../firebase/agent';
import { getMemory, setMemory } from '../../firebase/chat';
import {
  accessToken,
  deleteHubspotRecords,
  resolveHubspotConfig,
} from '../../services/hubspot';
import {
  addPropertyOption,
  discoverHubspotConfig,
} from '../../services/hubspotDiscovery';
import {
  allContactPropertyNames,
  dropExcludedMembers,
  fetchHubspotListMembers,
  listHubspotContactProperties,
  listHubspotLists,
  searchHubspotContacts,
} from '../../services/hubspotAudiences';
import {
  enrolledChannelKeys,
  enrolledContactIds,
} from '../../services/campaigns';
import type { OutboundRequest } from '../../http/types';

function req(body: Record<string, unknown> = {}): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query: {},
    headers: {},
    body,
    bodyArray: null,
    rawBody: '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (resolveHubspotConfig as jest.Mock).mockReturnValue({
    refresh_token: 'r',
    access_token: 'saved-token',
  });
  (accessToken as jest.Mock).mockResolvedValue('saved-token');
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (enrolledContactIds as jest.Mock).mockResolvedValue([]);
  (enrolledChannelKeys as jest.Mock).mockResolvedValue(new Set());
  (fetchHubspotListMembers as jest.Mock).mockResolvedValue({
    members: [],
    next_cursor: null,
  });
  (searchHubspotContacts as jest.Mock).mockResolvedValue({
    members: [],
    total: 0,
    next_cursor: null,
  });
  (dropExcludedMembers as jest.Mock).mockImplementation((m) => m);
});

// ─────────────────────────────────────────────────────────────────────────────
// token resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('token resolution', () => {
  it('prefers a directly-supplied access_token over a saved action', async () => {
    // Step 1 of setup has no saved action at all — the FE holds a token the user just pasted, and
    // discovery has to work against it.
    (discoverHubspotConfig as jest.Mock).mockResolvedValue({ pipelines: [] });
    await hubspotDiscoveryView(req({ access_token: 'pasted', agent_id: 'a1' }));
    expect(discoverHubspotConfig).toHaveBeenCalledWith('pasted', 'a1');
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('falls back to the saved action when only agent_id is given', async () => {
    (discoverHubspotConfig as jest.Mock).mockResolvedValue({});
    await hubspotDiscoveryView(req({ agent_id: 'a1' }));
    expect(getAgentActions).toHaveBeenCalledWith('a1');
    expect(discoverHubspotConfig).toHaveBeenCalledWith('saved-token', 'a1');
  });

  it('prefers agent_id in the CONFIG resolver — the opposite preference', async () => {
    // The list/search helpers refresh internally, and a bare access_token cannot be refreshed. Both
    // preferences are deliberate; normalizing them breaks one caller or the other.
    await hubspotListMembersView(
      req({ agent_id: 'a1', access_token: 'pasted', list_id: '7' })
    );
    expect(fetchHubspotListMembers).toHaveBeenCalledWith(
      { refresh_token: 'r', access_token: 'saved-token' },
      'a1',
      '7',
      expect.anything()
    );
  });

  it('uses a bare access_token as a minimal config when there is no agent_id', async () => {
    await hubspotListMembersView(req({ access_token: 'pasted', list_id: '7' }));
    expect(fetchHubspotListMembers).toHaveBeenCalledWith(
      { access_token: 'pasted' },
      '',
      '7',
      expect.anything()
    );
  });

  it.each([
    ['discovery', hubspotDiscoveryView],
    ['lists', hubspotListsView],
    ['contact-properties', hubspotContactPropertiesView],
    ['search-contacts', hubspotSearchContactsView],
  ])('400s %s with neither token nor agent_id', async (_name, view) => {
    const res = await view(req({}));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'access_token or agent_id required' });
  });

  it('400s when the saved action resolves no token at all', async () => {
    (accessToken as jest.Mock).mockResolvedValue(null);
    const res = await hubspotListsView(req({ agent_id: 'a1' }));
    expect(res.status).toBe(400);
    expect(listHubspotLists).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// property-option
// ─────────────────────────────────────────────────────────────────────────────

describe('hubspotAddPropertyOptionView', () => {
  it('adds an option to an allowlisted property', async () => {
    (addPropertyOption as jest.Mock).mockResolvedValue({
      success: true,
      added: true,
    });
    const res = await hubspotAddPropertyOptionView(
      req({
        access_token: 't',
        property_name: 'lead_source',
        label: 'Trade Show',
        value: 'trade_show',
      })
    );
    expect(addPropertyOption).toHaveBeenCalledWith(
      't',
      'lead_source',
      'Trade Show',
      'trade_show'
    );
    expect(res.status).toBe(200);
  });

  it('refuses a property outside the allowlist', async () => {
    // A hard gate, not a convenience: this writes to someone else's CRM schema.
    const res = await hubspotAddPropertyOptionView(
      req({ access_token: 't', property_name: 'firstname', label: 'X' })
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: 'property_name must be one of ["hs_lead_status","lead_source"]',
    });
    expect(addPropertyOption).not.toHaveBeenCalled();
  });

  it.each([[{ property_name: 'lead_source' }], [{ label: 'X' }], [{}]])(
    '400s the incomplete payload %p',
    async (partial) => {
      const res = await hubspotAddPropertyOptionView(
        req({ access_token: 't', ...partial })
      );
      expect(res.status).toBe(400);
      expect(addPropertyOption).not.toHaveBeenCalled();
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// the audience preview
// ─────────────────────────────────────────────────────────────────────────────

describe('hubspotListMembersView', () => {
  it('400s without a list_id, after the auth check', async () => {
    const res = await hubspotListMembersView(req({ agent_id: 'a1' }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'list_id required' });
  });

  it('defaults the page limit to 100 and passes the cursor through', async () => {
    await hubspotListMembersView(
      req({ agent_id: 'a1', list_id: '7', cursor: 'tok' })
    );
    expect(fetchHubspotListMembers).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      '7',
      expect.objectContaining({ after: 'tok', limit: 100, properties: null })
    );
  });

  it('applies BOTH exclusion axes for an add-more preview', async () => {
    // Contact ids catch the same contact; channel keys catch a DIFFERENT contact sharing a dealership
    // phone, which enrollment would collapse onto the existing chat.
    (enrolledContactIds as jest.Mock).mockResolvedValue(['c9']);
    (enrolledChannelKeys as jest.Mock).mockResolvedValue(
      new Set(['p:3035551212'])
    );
    (fetchHubspotListMembers as jest.Mock).mockResolvedValue({
      members: [{ contact_information: {} }],
      next_cursor: null,
    });
    await hubspotListMembersView(
      req({
        agent_id: 'a1',
        list_id: '7',
        campaign_id: 'camp_1',
        exclude_contact_ids: ['c1'],
      })
    );
    expect(dropExcludedMembers).toHaveBeenCalledWith(
      [{ contact_information: {} }],
      expect.arrayContaining(['c1', 'c9']),
      new Set(['p:3035551212'])
    );
  });

  it('does not filter at all without a campaign_id or de-selections', async () => {
    (fetchHubspotListMembers as jest.Mock).mockResolvedValue({
      members: [{ contact_information: {} }],
      next_cursor: null,
    });
    await hubspotListMembersView(req({ agent_id: 'a1', list_id: '7' }));
    expect(enrolledContactIds).not.toHaveBeenCalled();
    expect(dropExcludedMembers).not.toHaveBeenCalled();
  });

  it('skips the filter pass when the page came back empty', async () => {
    (enrolledContactIds as jest.Mock).mockResolvedValue(['c9']);
    await hubspotListMembersView(
      req({ agent_id: 'a1', list_id: '7', campaign_id: 'camp_1' })
    );
    expect(dropExcludedMembers).not.toHaveBeenCalled();
  });

  it('shows an inflated count rather than failing when the channel keys cannot be read', async () => {
    // Fails OPEN: a preview that errors leaves the picker blank, which is worse than a count that is
    // slightly high.
    (enrolledChannelKeys as jest.Mock).mockRejectedValue(new Error('down'));
    (fetchHubspotListMembers as jest.Mock).mockResolvedValue({
      members: [{ contact_information: {} }],
      next_cursor: null,
    });
    const res = await hubspotListMembersView(
      req({ agent_id: 'a1', list_id: '7', campaign_id: 'camp_1' })
    );
    expect(res.status).toBe(200);
  });
});

describe('requested properties', () => {
  it('resolves every property name for all_properties: true', async () => {
    (allContactPropertyNames as jest.Mock).mockResolvedValue(['a', 'b']);
    await hubspotListMembersView(
      req({ agent_id: 'a1', list_id: '7', all_properties: true })
    );
    expect(fetchHubspotListMembers).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      '7',
      expect.objectContaining({ properties: ['a', 'b'] })
    );
  });

  it('falls back to the explicit list when all_properties resolution fails', async () => {
    // Best-effort: rendering fewer columns beats failing the preview.
    (allContactPropertyNames as jest.Mock).mockRejectedValue(new Error('429'));
    await hubspotListMembersView(
      req({
        agent_id: 'a1',
        list_id: '7',
        all_properties: true,
        properties: ['firstname'],
      })
    );
    expect(fetchHubspotListMembers).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      '7',
      expect.objectContaining({ properties: ['firstname'] })
    );
  });

  it('treats an empty properties array as the lean default', async () => {
    await hubspotListMembersView(
      req({ agent_id: 'a1', list_id: '7', properties: [] })
    );
    expect(fetchHubspotListMembers).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      '7',
      expect.objectContaining({ properties: null })
    );
  });
});

describe('hubspotSearchContactsView', () => {
  it('accepts either casing of filterGroups and passes the lot through', async () => {
    await hubspotSearchContactsView(
      req({
        agent_id: 'a1',
        filter_groups: [{ filters: [] }],
        filters: [{ property: 'state' }],
        limit: 25,
      })
    );
    expect(searchHubspotContacts).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      expect.objectContaining({
        filterGroups: [{ filters: [] }],
        filters: [{ property: 'state' }],
        limit: 25,
      })
    );
  });

  it('sends contact-id exclusions INTO the search, so total reflects them', async () => {
    (enrolledContactIds as jest.Mock).mockResolvedValue(['c9']);
    await hubspotSearchContactsView(
      req({ agent_id: 'a1', campaign_id: 'camp_1' })
    );
    expect(searchHubspotContacts).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      expect.objectContaining({ excludeContactIds: ['c9'] })
    );
  });

  it('applies the channel-key pass AFTER the search, which the API cannot express', async () => {
    (enrolledChannelKeys as jest.Mock).mockResolvedValue(new Set(['p:1']));
    (searchHubspotContacts as jest.Mock).mockResolvedValue({
      members: [{ contact_information: {} }],
      total: 1,
      next_cursor: null,
    });
    await hubspotSearchContactsView(
      req({ agent_id: 'a1', campaign_id: 'camp_1' })
    );
    // `null` for the ids — those were already applied inside the search.
    expect(dropExcludedMembers).toHaveBeenCalledWith(
      [{ contact_information: {} }],
      null,
      new Set(['p:1'])
    );
  });

  it.each([
    [undefined, true],
    [null, false],
    [false, false],
    [0, false],
    [true, true],
  ])(
    'coerces exclude_contacted=%p to %p, as bool(data.get(k, True)) does',
    async (given, expected) => {
      // The second place in the port where `??` would have turned cross-campaign dedup back on for an
      // explicit null. Same rule as the campaign create view.
      const body: Record<string, unknown> = { agent_id: 'a1' };
      if (given !== undefined) body.exclude_contacted = given;
      await hubspotSearchContactsView(req(body));
      expect(searchHubspotContacts).toHaveBeenCalledWith(
        expect.anything(),
        'a1',
        expect.objectContaining({ excludeContacted: expected })
      );
    }
  );
});

describe('the two simple proxies', () => {
  it('wraps the list result under `lists`', async () => {
    (listHubspotLists as jest.Mock).mockResolvedValue([{ id: 1, name: 'A' }]);
    const res = await hubspotListsView(req({ access_token: 't' }));
    expect(res.json).toEqual({ lists: [{ id: 1, name: 'A' }] });
  });

  it('wraps the property result under `properties`', async () => {
    (listHubspotContactProperties as jest.Mock).mockResolvedValue([
      { name: 'state' },
    ]);
    const res = await hubspotContactPropertiesView(req({ access_token: 't' }));
    expect(res.json).toEqual({ properties: [{ name: 'state' }] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// delete-records
// ─────────────────────────────────────────────────────────────────────────────

describe('hubspotDeleteRecordsView', () => {
  beforeEach(() => {
    (deleteHubspotRecords as jest.Mock).mockResolvedValue({
      authenticated: true,
      contact_deleted: true,
      deal_deleted: true,
    });
  });

  it.each([[undefined], ['Real'], [''], ['tests'], [null]])(
    'GATE 1: refuses record_type=%p',
    async (recordType) => {
      const res = await hubspotDeleteRecordsView(
        req({ record_type: recordType, agent_id: 'a1', contact_id: 'c1' })
      );
      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        error: "refusing to delete — record_type must be 'Test'",
      });
      expect(deleteHubspotRecords).not.toHaveBeenCalled();
    }
  );

  it('GATE 1 accepts any casing and surrounding whitespace', async () => {
    const res = await hubspotDeleteRecordsView(
      req({ record_type: '  TEST ', agent_id: 'a1', contact_id: 'c1' })
    );
    expect(res.status).toBe(200);
  });

  it('GATE 2: refuses when the chat itself is not a Test record', async () => {
    (getMemory as jest.Mock).mockResolvedValue({ record_type: 'Real' });
    const res = await hubspotDeleteRecordsView(
      req({ record_type: 'Test', chat_id: 'chat_1' })
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: "refusing to delete — chat memory.record_type is not 'Test'",
    });
    expect(deleteHubspotRecords).not.toHaveBeenCalled();
  });

  it('GATE 2: refuses a chat whose memory is missing or unreadable', async () => {
    // The only safe direction for a delete: "cannot tell" reads as "not Test".
    (getMemory as jest.Mock).mockResolvedValue(null);
    const res = await hubspotDeleteRecordsView(
      req({ record_type: 'Test', chat_id: 'gone' })
    );
    expect(res.status).toBe(400);
    expect(deleteHubspotRecords).not.toHaveBeenCalled();
  });

  it('resolves the agent and both ids from the chat memory', async () => {
    (getMemory as jest.Mock).mockResolvedValue({
      record_type: 'Test',
      agent_id: 'a_mem',
      hubspot_contact_id: 'c_mem',
      hubspot_deal_id: 'd_mem',
    });
    await hubspotDeleteRecordsView(
      req({ record_type: 'Test', chat_id: 'chat_1' })
    );
    expect(deleteHubspotRecords).toHaveBeenCalledWith(
      'a_mem',
      'c_mem',
      'd_mem'
    );
  });

  it('lets explicit ids win over the ones on the chat', async () => {
    (getMemory as jest.Mock).mockResolvedValue({
      record_type: 'Test',
      agent_id: 'a_mem',
      hubspot_contact_id: 'c_mem',
    });
    await hubspotDeleteRecordsView(
      req({
        record_type: 'Test',
        chat_id: 'chat_1',
        agent_id: 'a_explicit',
        contact_id: 'c_explicit',
      })
    );
    expect(deleteHubspotRecords).toHaveBeenCalledWith(
      'a_explicit',
      'c_explicit',
      ''
    );
  });

  it('400s with no agent resolvable from anywhere', async () => {
    const res = await hubspotDeleteRecordsView(
      req({ record_type: 'Test', contact_id: 'c1' })
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: 'agent_id (or a chat_id whose memory has agent_id) is required',
    });
  });

  it('400s when neither id was supplied nor found', async () => {
    const res = await hubspotDeleteRecordsView(
      req({ record_type: 'Test', agent_id: 'a1' })
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: 'contact_id and/or deal_id required (none found)',
    });
  });

  it('clears the ids from memory after a successful delete', async () => {
    (getMemory as jest.Mock).mockResolvedValue({
      record_type: 'Test',
      agent_id: 'a1',
      hubspot_contact_id: 'c1',
      hubspot_deal_id: 'd1',
    });
    await hubspotDeleteRecordsView(
      req({ record_type: 'Test', chat_id: 'chat_1' })
    );
    expect(setMemory).toHaveBeenCalledWith('chat_1', {
      hubspot_contact_id: null,
      hubspot_deal_id: null,
    });
  });

  it('does NOT clear an id whose delete failed', async () => {
    // Clearing on a failure would leave a live CRM record with nothing pointing at it.
    (getMemory as jest.Mock).mockResolvedValue({
      record_type: 'Test',
      agent_id: 'a1',
      hubspot_contact_id: 'c1',
      hubspot_deal_id: 'd1',
    });
    (deleteHubspotRecords as jest.Mock).mockResolvedValue({
      authenticated: true,
      contact_deleted: true,
      deal_deleted: false,
    });
    await hubspotDeleteRecordsView(
      req({ record_type: 'Test', chat_id: 'chat_1' })
    );
    expect(setMemory).toHaveBeenCalledWith('chat_1', {
      hubspot_contact_id: null,
    });
  });

  it('clears nothing when auth itself failed', async () => {
    (getMemory as jest.Mock).mockResolvedValue({
      record_type: 'Test',
      agent_id: 'a1',
      hubspot_contact_id: 'c1',
    });
    (deleteHubspotRecords as jest.Mock).mockResolvedValue({
      authenticated: false,
      contact_deleted: null,
      deal_deleted: null,
    });
    const res = await hubspotDeleteRecordsView(
      req({ record_type: 'Test', chat_id: 'chat_1' })
    );
    expect(setMemory).not.toHaveBeenCalled();
    expect(res.json).toMatchObject({ authenticated: false });
  });

  it('echoes the ids it acted on alongside the per-object results', async () => {
    const res = await hubspotDeleteRecordsView(
      req({
        record_type: 'Test',
        agent_id: 'a1',
        contact_id: 'c1',
        deal_id: 'd1',
      })
    );
    expect(res.json).toEqual({
      authenticated: true,
      contact_deleted: true,
      deal_deleted: true,
      contact_id: 'c1',
      deal_id: 'd1',
    });
  });

  it('does not touch memory when no chat_id was given', async () => {
    await hubspotDeleteRecordsView(
      req({ record_type: 'Test', agent_id: 'a1', contact_id: 'c1' })
    );
    expect(getMemory).not.toHaveBeenCalled();
    expect(setMemory).not.toHaveBeenCalled();
  });
});
