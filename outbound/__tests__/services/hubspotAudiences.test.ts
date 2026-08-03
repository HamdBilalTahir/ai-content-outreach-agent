/**
 * @jest-environment node
 *
 * HubSpot audience selection: lists, search, and the enrollment stamps.
 *
 * The properties worth protecting are the ones where a subtle mistake changes WHO gets dialled:
 *
 *  - **An exclusion must be added to EVERY filter group**, because HubSpot ORs groups — adding it to one
 *    leaves every other branch unfiltered.
 *  - **An explicitly-empty area-code selection must match NOTHING**, not everything. Returning
 *    everything would dial an unscrubbed audience, the opposite of what the selection is for.
 *  - **Email-only members are always kept** — they have no area code to judge, and dropping them would
 *    silence a reachable channel.
 *  - **The channel-key exclusion catches what the id-based one misses**: a shared dealership line under
 *    a different contact id.
 *  - **Operator normalization**, because a value-requiring operator with no value must be DROPPED — sent,
 *    it 400s the query and loses the whole audience rather than one row.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/dncAreaCodes', () => {
  const actual = jest.requireActual('../../services/dncAreaCodes');
  return { ...actual, effectiveAllowed: jest.fn() };
});

import { store } from '../../testSupport/mockFirestore';
import { effectiveAllowed } from '../../services/dncAreaCodes';
import {
  AAAI_AREA_CODE_PROP,
  CAMPAIGN_END_PROP,
  CAMPAIGN_PROP,
  CAMPAIGN_START_PROP,
  CONTACTED_PROP,
  CONTACT_NUMBER_TYPE_PROP,
  annotateAndFilterAreaCodes,
  applyAreaCodeFilter,
  applyExcludeContacted,
  batchUpdateContacts,
  buildFilter,
  buildFilterGroups,
  contactToLeadPayload,
  dropExcludedMembers,
  ensureContactProperty,
  fetchHubspotListMembers,
  hsTimezoneToIana,
  isoToEpochMs,
  listHubspotLists,
  reqProperties,
  searchHubspotContacts,
  stampContactCampaign,
  stampContactContacted,
  stampContactNumberType,
  __testing as ha,
} from '../../services/hubspotAudiences';
import type { LeadPayload } from '../../services/hubspotAudiences';

const allowedMock = effectiveAllowed as jest.Mock;

const TOKEN = 'pat-token';
const AGENT = 'agentA';
const CFG = { access_token: TOKEN };
const CONTACT = 'c_1';

let fetchMock: jest.Mock;

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** The body of the Nth request. */
function bodyAt(n: number): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[n][1] as { body: string }).body);
}

/** The body of the first request whose url matches. */
function bodyMatching(matcher: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(matcher));
  return call ? JSON.parse((call[1] as { body: string }).body) : {};
}

function member(over: Partial<LeadPayload> = {}): LeadPayload {
  return {
    id: 'c_1',
    contact_information: {
      email: 'jane@corp.com',
      phone_number: '+15551230000',
      first_name: 'Jane',
      last_name: 'Doe',
    },
    input_data: {},
    properties: {},
    ...over,
  };
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  ha.ENSURED_PROPS.clear();
  // No selection → annotate only, drop nothing.
  allowedMock.mockResolvedValue(null);
  fetchMock = jest.fn().mockResolvedValue(ok({}));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// Small mappers
// ─────────────────────────────────────────────────────────────────────────────

describe('hsTimezoneToIana', () => {
  test('converts HubSpot’s own format to IANA', () => {
    expect(hsTimezoneToIana('america_slash_new_york')).toBe('America/New_York');
    expect(hsTimezoneToIana('europe_slash_london')).toBe('Europe/London');
  });

  test('empty or unusable input yields an empty string', () => {
    expect(hsTimezoneToIana('')).toBe('');
    expect(hsTimezoneToIana(null)).toBe('');
  });
});

describe('isoToEpochMs', () => {
  test('converts an ISO string and a Date to epoch millis', () => {
    expect(isoToEpochMs('2026-08-01T10:00:00Z')).toBe(
      new Date('2026-08-01T10:00:00Z').getTime()
    );
    const d = new Date('2026-08-01T10:00:00Z');
    expect(isoToEpochMs(d)).toBe(d.getTime());
  });

  test('empty or unparseable input is null, not a throw', () => {
    expect(isoToEpochMs('')).toBeNull();
    expect(isoToEpochMs(null)).toBeNull();
    expect(isoToEpochMs('not a date')).toBeNull();
  });
});

describe('reqProperties', () => {
  test('extras are appended and deduped, order preserved', () => {
    const props = reqProperties(['email', 'custom_field']);
    expect(props.filter((p) => p === 'email')).toHaveLength(1);
    expect(props).toContain('custom_field');
    expect(props[0]).toBe('email');
  });

  test('no extras returns the baseline', () => {
    expect(reqProperties()).toContain('aaai_area_code');
    expect(reqProperties(null)).toContain('hs_timezone');
  });
});

describe('contactToLeadPayload', () => {
  test('maps the enrollment shape and carries the full properties', () => {
    const m = contactToLeadPayload('c_9', {
      email: 'jane@corp.com',
      firstname: 'Jane',
      lastname: 'Doe',
      phone: '+15551230000',
      company: 'Acme',
      state: 'CO',
      zip: '80202',
      jobtitle: 'GM',
      city: 'Denver',
      lifecyclestage: 'lead',
      hs_timezone: 'america_slash_denver',
    });
    expect(m.id).toBe('c_9');
    expect(m.contact_information).toEqual({
      email: 'jane@corp.com',
      phone_number: '+15551230000',
      first_name: 'Jane',
      last_name: 'Doe',
    });
    expect(m.input_data).toMatchObject({
      hubspot_contact_id: 'c_9',
      company: 'Acme',
      state: 'CO',
      job_title: 'GM',
      city: 'Denver',
      timezone: 'America/Denver',
    });
    // The FE preview renders from here.
    expect(m.properties.jobtitle).toBe('GM');
  });

  test('phone falls back to mobilephone — both are the contact’s own line', () => {
    expect(
      contactToLeadPayload('c_1', { mobilephone: '+15559998888' })
        .contact_information.phone_number
    ).toBe('+15559998888');
  });

  test('the website-verified business phone signal is carried through', () => {
    // enroll's business-only gate reads it to rescue a verified landline CNAM would reject.
    expect(
      contactToLeadPayload('c_1', {
        aaai_website_verified_business_phone: '+15551112222',
      }).input_data.website_verified_business
    ).toBe('+15551112222');
  });

  test('missing fields become empty strings, never undefined', () => {
    const m = contactToLeadPayload('c_1', {});
    expect(m.contact_information.email).toBe('');
    expect(m.contact_information.first_name).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exclusions
// ─────────────────────────────────────────────────────────────────────────────

describe('dropExcludedMembers', () => {
  test('matches on contact id OR email — the FE keys by id with an email fallback', () => {
    const members = [member({ id: 'a' }), member({ id: 'b' })];
    expect(dropExcludedMembers(members, ['a'])).toHaveLength(1);
    expect(dropExcludedMembers(members, ['jane@corp.com'])).toHaveLength(0);
  });

  test('the CHANNEL-key exclusion catches a shared line under a different id', () => {
    // Exactly what the id-based exclude misses: same dealership phone, different contact.
    const members = [member({ id: 'different_id' })];
    expect(
      dropExcludedMembers(members, [], new Set(['p:5551230000']))
    ).toHaveLength(0);
    expect(
      dropExcludedMembers(members, [], new Set(['e:jane@corp.com']))
    ).toHaveLength(0);
  });

  test('nothing to exclude returns the list untouched', () => {
    const members = [member()];
    expect(dropExcludedMembers(members, [])).toBe(members);
    expect(dropExcludedMembers(members, null, null)).toBe(members);
  });

  test('null and empty ids are ignored rather than matching everything', () => {
    expect(dropExcludedMembers([member()], [null, '', undefined])).toHaveLength(
      1
    );
  });
});

describe('annotateAndFilterAreaCodes', () => {
  test('with NO selection, members are annotated and none dropped', () => {
    allowedMock.mockResolvedValue(null);
    return annotateAndFilterAreaCodes([member()]).then((out) => {
      expect(out).toHaveLength(1);
      expect(out[0].area_code).toBe('555');
    });
  });

  test('with a selection, a non-matching phone is dropped', async () => {
    allowedMock.mockResolvedValue(new Set(['303']));
    expect(await annotateAndFilterAreaCodes([member()], ['303'])).toHaveLength(
      0
    );
  });

  test('a matching phone is kept', async () => {
    allowedMock.mockResolvedValue(new Set(['555']));
    expect(await annotateAndFilterAreaCodes([member()], ['555'])).toHaveLength(
      1
    );
  });

  test('an EMAIL-ONLY member is always kept', async () => {
    // No area code to judge; dropping it would silence a reachable channel.
    allowedMock.mockResolvedValue(new Set(['303']));
    const emailOnly = member({
      contact_information: {
        email: 'jane@corp.com',
        phone_number: '',
        first_name: 'Jane',
        last_name: '',
      },
    });
    expect(await annotateAndFilterAreaCodes([emailOnly], ['303'])).toHaveLength(
      1
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

describe('buildFilter', () => {
  test('maps friendly labels to HubSpot operators', () => {
    expect(
      buildFilter({ property: 'state', operator: 'is', value: 'CO' })
    ).toEqual({
      propertyName: 'state',
      operator: 'EQ',
      value: 'CO',
    });
    expect(
      buildFilter({
        property: 'state',
        operator: 'is any of',
        values: ['CO', 'UT'],
      })
    ).toEqual({ propertyName: 'state', operator: 'IN', values: ['CO', 'UT'] });
  });

  test('a native operator passes through upper-cased — the map is not a whitelist', () => {
    expect(
      buildFilter({ property: 'p', operator: 'contains_token', value: 'x' })
    ).toMatchObject({ operator: 'CONTAINS_TOKEN' });
    expect(
      buildFilter({ property: 'p', operator: 'gte', value: 5 })
    ).toMatchObject({ operator: 'GTE' });
  });

  test('cardinality NORMALIZES the operator both ways', () => {
    // Several values with EQ becomes IN…
    expect(
      buildFilter({ property: 'p', operator: 'eq', values: ['a', 'b'] })
    ).toMatchObject({ operator: 'IN', values: ['a', 'b'] });
    // …and one value with IN collapses to EQ.
    expect(
      buildFilter({ property: 'p', operator: 'in', values: ['a'] })
    ).toEqual({ propertyName: 'p', operator: 'EQ', value: 'a' });
  });

  test('a no-value operator needs no value', () => {
    expect(buildFilter({ property: 'p', operator: 'is known' })).toEqual({
      propertyName: 'p',
      operator: 'HAS_PROPERTY',
    });
  });

  test('a value-requiring operator with NO value is DROPPED', () => {
    // Sent, it 400s the query and loses the whole audience rather than one row.
    expect(buildFilter({ property: 'p', operator: 'eq' })).toBeNull();
    expect(
      buildFilter({ property: 'p', operator: 'in', values: [] })
    ).toBeNull();
  });

  test('a row with no property is dropped', () => {
    expect(buildFilter({ operator: 'eq', value: 'x' })).toBeNull();
  });

  test('propertyName and an array in `value` are both tolerated', () => {
    expect(
      buildFilter({ propertyName: 'p', operator: 'in', value: ['a', 'b'] })
    ).toMatchObject({ operator: 'IN', values: ['a', 'b'] });
  });

  test('empty and null values are stripped before deciding cardinality', () => {
    expect(
      buildFilter({ property: 'p', operator: 'in', values: ['a', '', null] })
    ).toEqual({ propertyName: 'p', operator: 'EQ', value: 'a' });
  });
});

describe('buildFilterGroups', () => {
  test('groups are kept separate — they are OR-ed by HubSpot', () => {
    const groups = buildFilterGroups([
      { filters: [{ property: 'state', operator: 'is', value: 'CO' }] },
      { filters: [{ property: 'state', operator: 'is', value: 'UT' }] },
    ]);
    expect(groups).toHaveLength(2);
  });

  test('a flat filters list is wrapped as ONE and-group, for back-compat', () => {
    const groups = buildFilterGroups(null, [
      { property: 'a', operator: 'is', value: '1' },
      { property: 'b', operator: 'is', value: '2' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].filters).toHaveLength(2);
  });

  test('a bare array is accepted as a group', () => {
    expect(
      buildFilterGroups([[{ property: 'a', operator: 'is', value: '1' }]])
    ).toHaveLength(1);
  });

  test('a group whose rows all drop is itself dropped', () => {
    expect(buildFilterGroups([{ filters: [{ operator: 'eq' }] }])).toEqual([]);
  });

  test('empty criteria yield no filters — HubSpot reads that as all contacts', () => {
    expect(buildFilterGroups()).toEqual([]);
    expect(buildFilterGroups([], [])).toEqual([]);
  });
});

describe('applyExcludeContacted', () => {
  test('is added to EVERY group, because HubSpot ORs them', () => {
    // Adding it to one group would leave every other branch unfiltered.
    const groups = applyExcludeContacted([
      { filters: [{ propertyName: 'a', operator: 'EQ', value: '1' }] },
      { filters: [{ propertyName: 'b', operator: 'EQ', value: '2' }] },
    ]);
    for (const g of groups) {
      expect(
        g.filters.some(
          (f) =>
            f.propertyName === CONTACTED_PROP &&
            f.operator === 'NOT_HAS_PROPERTY'
        )
      ).toBe(true);
    }
  });

  test('with NO groups it becomes the only filter, not dropped', () => {
    const groups = applyExcludeContacted([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].filters[0].propertyName).toBe(CONTACTED_PROP);
  });
});

describe('applyAreaCodeFilter', () => {
  test('the resolved codes are added to every group', async () => {
    allowedMock.mockResolvedValue(new Set(['303', '555']));
    const groups = await applyAreaCodeFilter(
      [{ filters: [{ propertyName: 'a', operator: 'EQ', value: '1' }] }],
      ['303', '555']
    );
    const f = groups[0].filters.find(
      (x) => x.propertyName === AAAI_AREA_CODE_PROP
    )!;
    expect(f.operator).toBe('IN');
    expect(f.values).toEqual(['303', '555']);
  });

  test('an explicitly-empty selection matches NOTHING, not everything', async () => {
    // Returning everything would dial an unscrubbed audience.
    allowedMock.mockResolvedValue(new Set());
    const groups = await applyAreaCodeFilter([], ['999']);
    expect(groups[0].filters[0].values).toEqual(['']);
  });

  test('no selection at all leaves the groups untouched', async () => {
    allowedMock.mockResolvedValue(null);
    const groups = [{ filters: [{ propertyName: 'a', operator: 'EQ' }] }];
    expect(await applyAreaCodeFilter(groups, null)).toBe(groups);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Properties and stamps
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureContactProperty', () => {
  test('an existing property is a cached success', async () => {
    fetchMock.mockResolvedValue(ok({ name: 'x' }, 200));
    expect(await ensureContactProperty(TOKEN, 'x', 'X', 'string', 'text')).toBe(
      true
    );
    // The second call is served from the cache.
    await ensureContactProperty(TOKEN, 'x', 'X', 'string', 'text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a missing property is created', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({}, 404))
      .mockResolvedValueOnce(ok({ name: 'y' }, 201));
    expect(await ensureContactProperty(TOKEN, 'y', 'Y', 'string', 'text')).toBe(
      true
    );
    expect(bodyAt(1).groupName).toBe('contactinformation');
  });

  test('a 409 counts as success — concurrent creation is the goal', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({}, 404))
      .mockResolvedValueOnce(ok({}, 409));
    expect(await ensureContactProperty(TOKEN, 'z', 'Z', 'string', 'text')).toBe(
      true
    );
  });

  test('a BOOLEAN property gets its two required options', async () => {
    // HubSpot rejects a boolean property without exactly true/false options.
    fetchMock
      .mockResolvedValueOnce(ok({}, 404))
      .mockResolvedValueOnce(ok({}, 201));
    await ensureContactProperty(TOKEN, 'b', 'B', 'bool', 'booleancheckbox');
    const opts = bodyAt(1).options as Array<Record<string, unknown>>;
    expect(opts.map((o) => o.value)).toEqual(['true', 'false']);
  });

  test('a real failure is false', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({}, 404))
      .mockResolvedValueOnce(ok({}, 500));
    expect(await ensureContactProperty(TOKEN, 'f', 'F', 'string', 'text')).toBe(
      false
    );
  });
});

describe('the enrollment stamps', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(ok({}, 200));
  });

  test('the CNAM type is written, and an unknown value NORMALIZES', async () => {
    expect(await stampContactNumberType(CFG, AGENT, CONTACT, 'business')).toBe(
      true
    );
    expect(
      (
        bodyMatching('/objects/contacts/').properties as Record<string, unknown>
      )[CONTACT_NUMBER_TYPE_PROP]
    ).toBe('business');

    jest.clearAllMocks();
    fetchMock.mockResolvedValue(ok({}, 200));
    // An unrecognised vendor value must read as "we do not know", not corrupt the property.
    await stampContactNumberType(CFG, AGENT, CONTACT, 'satellite-phone');
    expect(
      (
        bodyMatching('/objects/contacts/').properties as Record<string, unknown>
      )[CONTACT_NUMBER_TYPE_PROP]
    ).toBe('unknown');
  });

  test('contacted stamps the timestamp and the campaign id', async () => {
    expect(await stampContactContacted(CFG, AGENT, CONTACT, 'camp_1')).toBe(
      true
    );
    const props = bodyMatching('/objects/contacts/c_1').properties as Record<
      string,
      unknown
    >;
    expect(typeof props[CONTACTED_PROP]).toBe('number');
    expect(props[CAMPAIGN_PROP]).toBe('camp_1');
  });

  test('campaign stamps ONLY the fields provided — it never clears the others', async () => {
    // Setting the END later must not wipe the campaign id or start.
    await stampContactCampaign(CFG, AGENT, CONTACT, { endMs: 123 });
    const props = bodyMatching('/objects/contacts/c_1').properties as Record<
      string,
      unknown
    >;
    expect(props[CAMPAIGN_END_PROP]).toBe(123);
    expect(props[CAMPAIGN_PROP]).toBeUndefined();
    expect(props[CAMPAIGN_START_PROP]).toBeUndefined();
  });

  test('a campaign stamp with nothing to write makes no request', async () => {
    expect(await stampContactCampaign(CFG, AGENT, CONTACT, {})).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('no contact id, or no token, is a clean false', async () => {
    expect(await stampContactContacted(CFG, AGENT, '')).toBe(false);
    expect(await stampContactContacted({}, AGENT, CONTACT)).toBe(false);
    expect(await stampContactNumberType({}, AGENT, CONTACT, 'business')).toBe(
      false
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lists and search
// ─────────────────────────────────────────────────────────────────────────────

describe('listHubspotLists', () => {
  test('paginates until hasMore is false', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ lists: [{ listId: '1', name: 'A' }], hasMore: true, offset: 100 })
      )
      .mockResolvedValueOnce(
        ok({ lists: [{ listId: '2', name: 'B' }], hasMore: false })
      );
    const lists = await listHubspotLists(TOKEN);
    expect(lists.map((l) => l.id)).toEqual(['1', '2']);
  });

  test('reads the size from additionalProperties when present', async () => {
    fetchMock.mockResolvedValue(
      ok({
        lists: [
          {
            listId: '1',
            name: 'A',
            additionalProperties: { hs_list_size: 42 },
          },
        ],
        hasMore: false,
      })
    );
    expect((await listHubspotLists(TOKEN))[0].size).toBe(42);
  });

  test('an error stops the loop and returns what it had', async () => {
    fetchMock.mockResolvedValue(ok({}, 500));
    expect(await listHubspotLists(TOKEN)).toEqual([]);
  });
});

describe('fetchHubspotListMembers', () => {
  test('hydrates the page into lead payloads', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/memberships')) {
        return ok({
          results: [{ recordId: 'c_1' }, { recordId: 'c_2' }],
          paging: { next: { after: 'cursor_2' } },
        });
      }
      return ok({
        results: [
          {
            id: 'c_1',
            properties: { email: 'a@x.com', phone: '+15551230000' },
          },
          { id: 'c_2', properties: { email: 'b@x.com' } },
        ],
      });
    });
    const page = await fetchHubspotListMembers(CFG, AGENT, 'list_1');
    expect(page.members).toHaveLength(2);
    expect(page.next_cursor).toBe('cursor_2');
    expect(page.members[0].contact_information.email).toBe('a@x.com');
  });

  test('failed auth is an error result, not a throw', async () => {
    const page = await fetchHubspotListMembers({}, AGENT, 'list_1');
    expect(page.error).toContain('HubSpot auth failed');
    expect(page.members).toEqual([]);
  });

  test('a memberships error is reported with its status', async () => {
    fetchMock.mockResolvedValue(ok({}, 403));
    expect((await fetchHubspotListMembers(CFG, AGENT, 'l')).error).toBe(
      'memberships 403'
    );
  });
});

describe('searchHubspotContacts', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/properties/contacts'))
        return ok({ name: 'x' }, 200);
      return ok({
        results: [{ id: 'c_1', properties: { email: 'jane@corp.com' } }],
        total: 57,
        paging: { next: { after: 'cur' } },
      });
    });
  });

  test('returns members, the raw total, and the cursor', async () => {
    const r = await searchHubspotContacts(CFG, AGENT, {
      filters: [{ property: 'state', operator: 'is', value: 'CO' }],
    });
    expect(r.members).toHaveLength(1);
    // `total` is HubSpot's raw pre-area-filter match count, not the page length.
    expect(r.total).toBe(57);
    expect(r.next_cursor).toBe('cur');
  });

  test('the contacted-exclusion is applied BY DEFAULT', async () => {
    await searchHubspotContacts(CFG, AGENT, {});
    const body = bodyMatching('/objects/contacts/search');
    const groups = body.filterGroups as Array<{
      filters: Array<Record<string, unknown>>;
    }>;
    expect(
      groups[0].filters.some((f) => f.propertyName === CONTACTED_PROP)
    ).toBe(true);
  });

  test('the exclusion can be turned OFF explicitly', async () => {
    await searchHubspotContacts(CFG, AGENT, { excludeContacted: false });
    const body = bodyMatching('/objects/contacts/search');
    expect(body.filterGroups).toEqual([]);
  });

  test('the dedup property is ENSURED before it is filtered on', async () => {
    // HubSpot 400s the whole query on an unknown property.
    await searchHubspotContacts(CFG, AGENT, {});
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes('/properties/contacts')
      )
    ).toBe(true);
  });

  test('per-record FE de-selections are applied after the query', async () => {
    const r = await searchHubspotContacts(CFG, AGENT, {
      excludeContactIds: ['c_1'],
    });
    expect(r.members).toHaveLength(0);
    // The total still reflects HubSpot's count.
    expect(r.total).toBe(57);
  });

  test('failed auth is an error result', async () => {
    expect((await searchHubspotContacts({}, AGENT, {})).error).toContain(
      'HubSpot auth failed'
    );
  });

  test('a search error is reported with its status', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/properties/contacts')) return ok({}, 200);
      return ok({ message: 'bad filter' }, 400);
    });
    expect((await searchHubspotContacts(CFG, AGENT, {})).error).toBe(
      'search 400'
    );
  });
});

describe('batchUpdateContacts', () => {
  test('reports the number updated', async () => {
    fetchMock.mockResolvedValue(
      ok({ results: [{ id: 'a' }, { id: 'b' }] }, 200)
    );
    expect(
      await batchUpdateContacts(TOKEN, [
        { id: 'a', properties: { x: 1 } },
        { id: 'b', properties: { x: 2 } },
      ])
    ).toEqual({ updated: 2, error: null });
  });

  test('an empty list makes no request', async () => {
    expect(await batchUpdateContacts(TOKEN, [])).toEqual({
      updated: 0,
      error: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failure reports the status rather than throwing', async () => {
    fetchMock.mockResolvedValue(ok({}, 500));
    expect(
      (await batchUpdateContacts(TOKEN, [{ id: 'a', properties: {} }])).error
    ).toBe('batch update 500');
  });
});
