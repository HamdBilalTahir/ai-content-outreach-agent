/**
 * @jest-environment node
 *
 * The two HubSpot property backfills.
 *
 * Both write to a customer's live CRM, so the tests are about the guardrails:
 *
 *  - **Exactly one property per write.** A batch update replaces the properties it is given, so a second
 *    field read slightly stale would overwrite a rep's edit.
 *  - **SEEK pagination, not offset.** HubSpot caps `after` at 10,000 results, so an offset walk truncates a
 *    larger audience *and reports success*.
 *  - **A dry run creates nothing**, including the property itself.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/agent', () => ({ getAgentActions: jest.fn() }));
jest.mock('../../services/hubspot', () => {
  const actual = jest.requireActual('../../services/hubspot');
  return {
    ...actual,
    accessToken: jest.fn(),
    resolveHubspotConfig: jest.fn(),
  };
});
jest.mock('../../services/hubspotAudiences', () => {
  const actual = jest.requireActual('../../services/hubspotAudiences');
  return {
    ...actual,
    batchReadContacts: jest.fn(),
    batchUpdateContacts: jest.fn(),
    ensureContactProperty: jest.fn(),
  };
});
jest.mock('../../services/hubspotDeals', () => {
  const actual = jest.requireActual('../../services/hubspotDeals');
  return { ...actual, ensureDealProperty: jest.fn() };
});
jest.mock('../../services/dealAnalytics', () => ({
  assocObjectIds: jest.fn(),
}));

import {
  backfillAaaiAreaCode,
  backfillDealCampaign,
} from '../../commands/hubspotBackfills';
import { getAgentActions } from '../../firebase/agent';
import { accessToken, resolveHubspotConfig } from '../../services/hubspot';
import {
  batchReadContacts,
  batchUpdateContacts,
  ensureContactProperty,
} from '../../services/hubspotAudiences';
import { ensureDealProperty } from '../../services/hubspotDeals';
import { assocObjectIds } from '../../services/dealAnalytics';

const AGENT = 'agentA';

let fetchMock: jest.Mock;

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** The parsed body of the nth fetch call. */
function bodyOf(n: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[n][1].body));
}

beforeEach(() => {
  jest.clearAllMocks();
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (resolveHubspotConfig as jest.Mock).mockReturnValue({
    access_token: 'tok',
    pipeline_id: 'p1',
  });
  (accessToken as jest.Mock).mockResolvedValue('tok');
  (ensureDealProperty as jest.Mock).mockResolvedValue(true);
  (ensureContactProperty as jest.Mock).mockResolvedValue(true);
  (batchUpdateContacts as jest.Mock).mockImplementation(
    async (_t: string, u: unknown[]) => ({ updated: u.length, error: null })
  );
  (batchReadContacts as jest.Mock).mockResolvedValue([]);
  (assocObjectIds as jest.Mock).mockResolvedValue([]);
  fetchMock = jest.fn().mockResolvedValue(ok({ results: [] }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillDealCampaign
// ─────────────────────────────────────────────────────────────────────────────

describe('backfillDealCampaign', () => {
  it('copies the campaign down from the associated contact', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ results: [{ id: 'd1' }] }))
      .mockResolvedValueOnce(ok({}, 200));
    (assocObjectIds as jest.Mock).mockResolvedValue(['c1']);
    (batchReadContacts as jest.Mock).mockResolvedValue([
      { properties: { ava_last_campaign_id: 'camp_1' } },
    ]);

    const out = await backfillDealCampaign({ agentId: AGENT });
    expect(out).toMatchObject({ scanned: 1, patched: 1, skipped: 0 });
    // The PATCH writes exactly one property.
    expect(bodyOf(1)).toEqual({ properties: { ava_campaign_id: 'camp_1' } });
  });

  it('scopes the search to the pipeline and to deals MISSING the property', async () => {
    // `NOT_HAS_PROPERTY` is what makes the run idempotent: an already-stamped deal is not returned, so a
    // re-run costs one empty search.
    await backfillDealCampaign({ agentId: AGENT });
    const filters = (
      bodyOf(0).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters).toEqual([
      { propertyName: 'pipeline', operator: 'EQ', value: 'p1' },
      { propertyName: 'ava_campaign_id', operator: 'NOT_HAS_PROPERTY' },
    ]);
  });

  it('SKIPS a deal whose contact has no campaign rather than stamping blank', async () => {
    // An empty string in HubSpot means "clear this property", and would be indistinguishable from a real
    // value later.
    fetchMock.mockResolvedValueOnce(ok({ results: [{ id: 'd1' }] }));
    const out = await backfillDealCampaign({ agentId: AGENT });
    expect(out).toMatchObject({ scanned: 1, patched: 0, skipped: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('takes the FIRST associated contact that has a campaign', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ results: [{ id: 'd1' }] }))
      .mockResolvedValueOnce(ok({}, 200));
    (assocObjectIds as jest.Mock).mockResolvedValue(['c1', 'c2']);
    (batchReadContacts as jest.Mock).mockResolvedValue([
      { properties: {} },
      { properties: { ava_last_campaign_id: 'camp_2' } },
    ]);
    await backfillDealCampaign({ agentId: AGENT });
    expect(bodyOf(1)).toEqual({ properties: { ava_campaign_id: 'camp_2' } });
  });

  it('follows the search cursor across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ results: [{ id: 'd1' }], paging: { next: { after: 'tok' } } })
      )
      .mockResolvedValueOnce(ok({ results: [{ id: 'd2' }] }));
    const out = await backfillDealCampaign({ agentId: AGENT });
    expect(out.scanned).toBe(2);
    expect(bodyOf(1).after).toBe('tok');
  });

  it('counts a failed PATCH as neither patched nor skipped', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ results: [{ id: 'd1' }] }))
      .mockResolvedValueOnce(ok({}, 429));
    (assocObjectIds as jest.Mock).mockResolvedValue(['c1']);
    (batchReadContacts as jest.Mock).mockResolvedValue([
      { properties: { ava_last_campaign_id: 'camp_1' } },
    ]);
    const out = await backfillDealCampaign({ agentId: AGENT });
    expect(out).toMatchObject({ scanned: 1, patched: 0, skipped: 0 });
  });

  it('aborts on a failed search rather than reporting a clean finish', async () => {
    fetchMock.mockResolvedValueOnce(ok({}, 500));
    expect(await backfillDealCampaign({ agentId: AGENT })).toMatchObject({
      aborted: 'search_failed',
      scanned: 0,
    });
  });

  it.each([
    [
      'no_hubspot_auth',
      () => (resolveHubspotConfig as jest.Mock).mockReturnValue({}),
    ],
    [
      'no_pipeline',
      () =>
        (resolveHubspotConfig as jest.Mock).mockReturnValue({
          access_token: 'tok',
        }),
    ],
  ])('aborts with %p before touching HubSpot', async (aborted, arrange) => {
    arrange();
    expect(await backfillDealCampaign({ agentId: AGENT })).toMatchObject({
      aborted,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PATCHes nothing under dryRun but still reports the count', async () => {
    fetchMock.mockResolvedValueOnce(ok({ results: [{ id: 'd1' }] }));
    (assocObjectIds as jest.Mock).mockResolvedValue(['c1']);
    (batchReadContacts as jest.Mock).mockResolvedValue([
      { properties: { ava_last_campaign_id: 'camp_1' } },
    ]);
    const out = await backfillDealCampaign({ agentId: AGENT, dryRun: true });
    expect(out).toMatchObject({ scanned: 1, patched: 1, dry_run: true });
    // Only the search — no PATCH.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillAaaiAreaCode
// ─────────────────────────────────────────────────────────────────────────────

describe('backfillAaaiAreaCode', () => {
  /** A search page of contacts. */
  function page(contacts: Array<Record<string, unknown>>) {
    return ok({ results: contacts });
  }

  it('derives the code from phone, falling back to mobilephone', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: '1', properties: { phone: '+13035551212' } },
        { id: '2', properties: { mobilephone: '(770) 555-1212' } },
      ])
    );
    const out = await backfillAaaiAreaCode({ agentId: AGENT });
    expect(out.distribution).toEqual({ '303': 1, '770': 1 });
    expect(batchUpdateContacts).toHaveBeenCalledWith('tok', [
      { id: '1', properties: { aaai_area_code: '303' } },
      { id: '2', properties: { aaai_area_code: '770' } },
    ]);
  });

  it('buckets an unparseable phone under "(none)"', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: '1', properties: {} }]));
    const out = await backfillAaaiAreaCode({ agentId: AGENT });
    expect(out.distribution).toEqual({ '(none)': 1 });
  });

  it('SKIPS a contact whose stored value already matches', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        {
          id: '1',
          properties: { phone: '+13035551212', aaai_area_code: '303' },
        },
      ])
    );
    const out = await backfillAaaiAreaCode({ agentId: AGENT });
    expect(out.skipped_unchanged).toBe(1);
    expect(batchUpdateContacts).not.toHaveBeenCalled();
  });

  it('pages by SEEK on hs_object_id, not by offset', async () => {
    // HubSpot caps `after` at 10,000 results, so an offset walk truncates a larger audience AND reports
    // success. Seeking by id has no cap.
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      properties: { phone: '+13035551212' },
    }));
    fetchMock
      .mockResolvedValueOnce(page(first))
      .mockResolvedValueOnce(page([{ id: '101', properties: {} }]));
    const out = await backfillAaaiAreaCode({ agentId: AGENT });
    expect(out.scanned).toBe(101);
    const filters = (
      bodyOf(1).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters[1]).toEqual({
      propertyName: 'hs_object_id',
      operator: 'GT',
      value: '100',
    });
    expect(bodyOf(1).after).toBeUndefined();
    expect(bodyOf(1).sorts).toEqual([
      { propertyName: 'hs_object_id', direction: 'ASCENDING' },
    ]);
  });

  it('flushes a full batch mid-page and returns a resumable cursor', async () => {
    const contacts = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      properties: { phone: '+13035551212' },
    }));
    fetchMock.mockResolvedValueOnce(page(contacts));
    const out = await backfillAaaiAreaCode({ agentId: AGENT });
    expect(batchUpdateContacts).toHaveBeenCalledTimes(1);
    expect((batchUpdateContacts as jest.Mock).mock.calls[0][1]).toHaveLength(
      100
    );
    // Returned even on a clean finish, so a killed run resumes where it stopped.
    expect(out.last_id).toBe('100');
  });

  it('resumes from a supplied cursor', async () => {
    await backfillAaaiAreaCode({ agentId: AGENT, after: '500' });
    const filters = (
      bodyOf(0).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters[1]).toMatchObject({ operator: 'GT', value: '500' });
  });

  it('stops at the limit mid-page', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: '1', properties: { phone: '+13035551212' } },
        { id: '2', properties: { phone: '+17705551212' } },
        { id: '3', properties: { phone: '+12125551212' } },
      ])
    );
    const out = await backfillAaaiAreaCode({ agentId: AGENT, limit: 2 });
    expect(out.scanned).toBe(2);
  });

  it('honours a custom scoping filter', async () => {
    await backfillAaaiAreaCode({
      agentId: AGENT,
      filterProperty: 'hs_lead_status',
      filterValue: 'NEW',
    });
    const filters = (
      bodyOf(0).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters[0]).toEqual({
      propertyName: 'hs_lead_status',
      operator: 'EQ',
      value: 'NEW',
    });
  });

  it('does not CREATE the property under dryRun, and does not read it either', async () => {
    // A dry run that created the property would have changed the CRM schema while claiming to change
    // nothing.
    fetchMock.mockResolvedValueOnce(
      page([{ id: '1', properties: { phone: '+13035551212' } }])
    );
    const out = await backfillAaaiAreaCode({ agentId: AGENT, dryRun: true });
    expect(ensureContactProperty).not.toHaveBeenCalled();
    expect(batchUpdateContacts).not.toHaveBeenCalled();
    expect(bodyOf(0).properties).toEqual(['phone', 'mobilephone']);
    // The distribution is the dry run's real output — it says whether the phone data is good enough for
    // the area-code filter to be worth using.
    expect(out.distribution).toEqual({ '303': 1 });
  });

  it('aborts when the property cannot be ensured', async () => {
    (ensureContactProperty as jest.Mock).mockResolvedValue(false);
    expect(await backfillAaaiAreaCode({ agentId: AGENT })).toMatchObject({
      aborted: 'property_missing',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts without a token', async () => {
    (accessToken as jest.Mock).mockResolvedValue(null);
    expect(await backfillAaaiAreaCode({ agentId: AGENT })).toMatchObject({
      aborted: 'no_hubspot_auth',
    });
  });

  it('stops on a failed search but still flushes what it queued', async () => {
    // The first page must be FULL, or the short-page check ends the walk before the failure is reached.
    // A partial sweep plus a resumable cursor beats losing the page that already succeeded.
    const contacts = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      properties: { phone: '+13035551212', aaai_area_code: '303' },
    }));
    fetchMock
      .mockResolvedValueOnce(page(contacts))
      .mockResolvedValueOnce(ok({}, 500));
    const out = await backfillAaaiAreaCode({ agentId: AGENT });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.scanned).toBe(100);
    expect(out.skipped_unchanged).toBe(100);
    expect(out.last_id).toBe('100');
  });

  it('ends the walk on a SHORT page without a second request', async () => {
    fetchMock.mockResolvedValueOnce(
      page([{ id: '1', properties: { phone: '+13035551212' } }])
    );
    await backfillAaaiAreaCode({ agentId: AGENT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
