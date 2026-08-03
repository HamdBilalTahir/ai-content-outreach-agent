/**
 * @jest-environment node
 *
 * The deal-funnel dashboard endpoint.
 *
 * `dayBoundsMs` carries the real risk. The end bound is that day's `23:59:59.999`, and using midnight
 * instead would silently drop everything that happened on the last day of the range the user picked —
 * the classic date-picker off-by-one, which surfaces as "the dashboard is missing today's conversions"
 * and looks like a data problem rather than a bounds problem.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/agent', () => ({ getAgentActions: jest.fn() }));
jest.mock('../../services/hubspot', () => ({
  resolveHubspotConfig: jest.fn(),
}));
jest.mock('../../services/dealAnalytics', () => ({
  dealFunnelCounts: jest.fn(),
}));

import { dayBoundsMs, dealFunnelView } from '../../http/analyticsViews';
import { getAgentActions } from '../../firebase/agent';
import { resolveHubspotConfig } from '../../services/hubspot';
import { dealFunnelCounts } from '../../services/dealAnalytics';
import type { OutboundRequest } from '../../http/types';

function req(query: Record<string, string> = {}): OutboundRequest {
  return {
    method: 'GET',
    params: {},
    query,
    headers: {},
    body: {},
    bodyArray: null,
    rawBody: '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (resolveHubspotConfig as jest.Mock).mockReturnValue({ access_token: 't' });
  (dealFunnelCounts as jest.Mock).mockResolvedValue({
    pipeline_id: 'p1',
    stages: [],
    total: 0,
  });
});

describe('dayBoundsMs', () => {
  it('makes the END bound inclusive to 23:59:59.999', async () => {
    const [start, end] = dayBoundsMs('2026-07-01', '2026-07-31');
    expect(start).toBe(Date.parse('2026-07-01T00:00:00.000Z'));
    expect(end).toBe(Date.parse('2026-07-31T23:59:59.999Z'));
  });

  it('leaves either side unbounded independently', () => {
    expect(dayBoundsMs('2026-07-01', undefined)[1]).toBeNull();
    expect(dayBoundsMs(undefined, '2026-07-31')[0]).toBeNull();
    expect(dayBoundsMs(undefined, undefined)).toEqual([null, null]);
  });

  it.each([['2026-7-1'], ['07/31/2026'], ['not a date'], [''], ['2026-07']])(
    'treats the malformed date %p as UNBOUNDED rather than an error',
    (given) => {
      // A malformed query param should widen a dashboard's view, not blank it. The strict pattern also
      // matters: `new Date('2026-1-5')` quietly parses, so two differently-typed queries would
      // otherwise return different ranges.
      expect(dayBoundsMs(given, given)).toEqual([null, null]);
    }
  );

  it('rejects an out-of-range date that matches the shape', () => {
    expect(dayBoundsMs('2026-13-45', null)[0]).toBeNull();
  });
});

describe('dealFunnelView', () => {
  it('resolves the config and returns the counts with the echoed filters', async () => {
    (dealFunnelCounts as jest.Mock).mockResolvedValue({
      pipeline_id: 'p1',
      pipeline_label: 'Outbound',
      stages: [{ id: 's1', count: 3 }],
      total: 3,
    });
    const res = await dealFunnelView(
      req({
        agent_id: 'a1',
        campaign_id: 'camp_1',
        source: 'outbound',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        record_type: 'Test',
      })
    );
    expect(getAgentActions).toHaveBeenCalledWith('a1');
    expect(dealFunnelCounts).toHaveBeenCalledWith({ access_token: 't' }, 'a1', {
      campaignId: 'camp_1',
      source: 'outbound',
      createdAfterMs: Date.parse('2026-07-01T00:00:00.000Z'),
      createdBeforeMs: Date.parse('2026-07-31T23:59:59.999Z'),
      recordType: 'Test',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      pipeline_id: 'p1',
      pipeline_label: 'Outbound',
      stages: [{ id: 's1', count: 3 }],
      total: 3,
      filters: {
        campaign_id: 'camp_1',
        source: 'outbound',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        record_type: 'Test',
      },
    });
  });

  it('defaults source to all and record_type to Real', async () => {
    await dealFunnelView(req({ agent_id: 'a1' }));
    expect(dealFunnelCounts).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      expect.objectContaining({ source: 'all', recordType: 'Real' })
    );
  });

  it.each([['salesforce'], ['OUTBOUND '], ['']])(
    'coerces the source %p, and echoes what it actually used',
    async (given) => {
      const res = await dealFunnelView(req({ agent_id: 'a1', source: given }));
      const used = (dealFunnelCounts as jest.Mock).mock.calls[0][2].source;
      // Trimmed + lower-cased, then anything unrecognised falls back to `all`.
      expect(['all', 'outbound']).toContain(used);
      // Echoed back so the FE can see the effective query is not always the one it sent.
      expect((res.json as { filters: { source: string } }).filters.source).toBe(
        used
      );
    }
  );

  it('400s without an agent_id, before touching HubSpot', async () => {
    const res = await dealFunnelView(req({}));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'agent_id is required' });
    expect(getAgentActions).not.toHaveBeenCalled();
  });

  it('400s when the agent has no HubSpot v2 connection', async () => {
    (resolveHubspotConfig as jest.Mock).mockReturnValue({});
    const res = await dealFunnelView(req({ agent_id: 'a1' }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: 'HubSpot v2 not connected for this agent',
    });
    expect(dealFunnelCounts).not.toHaveBeenCalled();
  });

  it('accepts a refresh-token-only connection', async () => {
    (resolveHubspotConfig as jest.Mock).mockReturnValue({ refresh_token: 'r' });
    expect((await dealFunnelView(req({ agent_id: 'a1' }))).status).toBe(200);
  });

  it('surfaces a funnel error as a 400, without the filters block', async () => {
    (dealFunnelCounts as jest.Mock).mockResolvedValue({
      error: 'deal pipeline p1 not found',
    });
    const res = await dealFunnelView(req({ agent_id: 'a1' }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'deal pipeline p1 not found' });
  });

  it('passes a blank campaign_id through as null, not an empty string', async () => {
    await dealFunnelView(req({ agent_id: 'a1', campaign_id: '' }));
    expect(dealFunnelCounts).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      expect.objectContaining({ campaignId: null })
    );
  });
});
