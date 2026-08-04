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
jest.mock('../../services/dealAttribution', () => ({
  runDealAttribution: jest.fn(),
}));
jest.mock('../../services/dealTimeline', () => ({
  buildDealTimeline: jest.fn(),
}));

import {
  dayBoundsMs,
  dealFunnelView,
  dealTimelineView,
  runDealAttributionView,
} from '../../http/analyticsViews';
import { runDealAttribution } from '../../services/dealAttribution';
import { buildDealTimeline } from '../../services/dealTimeline';
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

const KEY = 'super-secret-internal-key';

/** A POST to the scan endpoint, authorised unless told otherwise. */
function scanReq(
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
  headers: Record<string, string> = { 'x-api-key': KEY }
): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query,
    headers,
    body,
    bodyArray: null,
    rawBody: '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTERNAL_VALIDATION_KEY = KEY;
  (buildDealTimeline as jest.Mock).mockResolvedValue({
    success: true,
    events: [],
    touchpoint_count: 0,
  });
  (runDealAttribution as jest.Mock).mockResolvedValue({
    success: true,
    scanned: 3,
    attributed: 2,
    updated: 2,
    stage_synced: 1,
    next_cursor: 'chat_z',
  });
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (resolveHubspotConfig as jest.Mock).mockReturnValue({ access_token: 't' });
  (dealFunnelCounts as jest.Mock).mockResolvedValue({
    pipeline_id: 'p1',
    stages: [],
    total: 0,
  });
});

afterEach(() => {
  delete process.env.INTERNAL_VALIDATION_KEY;
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

// ─────────────────────────────────────────────────────────────────────────────
// run-deal-attribution
// ─────────────────────────────────────────────────────────────────────────────

describe('runDealAttributionView', () => {
  it('runs the scan and returns the counters plus the resume cursor', async () => {
    const res = await runDealAttributionView(
      scanReq({
        agent_id: 'a1',
        campaign_id: 'camp_1',
        cursor: 'chat_m',
        limit: 50,
      })
    );
    expect(runDealAttribution).toHaveBeenCalledWith({
      agentId: 'a1',
      campaignId: 'camp_1',
      cursor: 'chat_m',
      limit: 50,
      onlyChatId: null,
      dryRun: false,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, next_cursor: 'chat_z' });
  });

  it('401s an unauthenticated caller WITHOUT running the scan', async () => {
    // The one outbound endpoint behind an API key, because it writes attribution across every chat.
    const res = await runDealAttributionView(scanReq({}, {}, {}));
    expect(res.status).toBe(401);
    expect(runDealAttribution).not.toHaveBeenCalled();
  });

  it('401s when the key is not configured at all, rather than opening up', async () => {
    delete process.env.INTERNAL_VALIDATION_KEY;
    const res = await runDealAttributionView(scanReq());
    expect(res.status).toBe(401);
    expect(runDealAttribution).not.toHaveBeenCalled();
  });

  it('reads a parameter from the QUERY when the body does not carry it', async () => {
    // The FE cron posts a body; a manual re-scan is easier to fire as a URL.
    await runDealAttributionView(scanReq({}, { only_chat_id: 'chat_7' }));
    expect(runDealAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ onlyChatId: 'chat_7' })
    );
  });

  it('lets the BODY win over the query', async () => {
    await runDealAttributionView(
      scanReq({ agent_id: 'body' }, { agent_id: 'query' })
    );
    expect(runDealAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'body' })
    );
  });

  it.each([['1'], ['true'], ['TRUE'], ['yes'], [' Yes '], [true]])(
    'enables dryRun for %p',
    async (given) => {
      await runDealAttributionView(scanReq({ dry_run: given }));
      expect(runDealAttribution).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true })
      );
    }
  );

  it.each([['false'], ['0'], ['no'], [''], [undefined], ['maybe']])(
    'leaves dryRun off for %p',
    async (given) => {
      // Spelled out rather than relying on truthiness: the STRING "false" is truthy in JS, so a
      // `?dry_run=false` query would otherwise silently turn the scan into a no-op that reported
      // success — and nobody would notice the attribution had stopped.
      await runDealAttributionView(scanReq({ dry_run: given }));
      expect(runDealAttribution).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: false })
      );
    }
  );

  it('answers 200 with success:false when the scan throws', async () => {
    // The caller is a scheduler that retries non-2xx, and the scan has already written attribution to
    // some chats by the time it faults.
    (runDealAttribution as jest.Mock).mockRejectedValue(new Error('hs down'));
    const res = await runDealAttributionView(scanReq());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: false, error: 'Error: hs down' });
  });

  it('passes a blank parameter through as null, not an empty string', async () => {
    await runDealAttributionView(scanReq({ agent_id: '', cursor: '' }));
    expect(runDealAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: null, cursor: null })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deal-timeline
// ─────────────────────────────────────────────────────────────────────────────

describe('dealTimelineView', () => {
  /** A GET to the timeline endpoint, authorised unless told otherwise. */
  function tlReq(
    query: Record<string, string> = {},
    headers: Record<string, string> = { 'x-api-key': KEY }
  ): OutboundRequest {
    return {
      method: 'GET',
      params: {},
      query,
      headers,
      body: {},
      bodyArray: null,
      rawBody: '',
    };
  }

  it('builds the timeline from the query params', async () => {
    const res = await dealTimelineView(
      tlReq({ agent_id: 'a1', deal_id: 'd1', record_type: 'all' })
    );
    expect(buildDealTimeline).toHaveBeenCalledWith({
      agentId: 'a1',
      dealId: 'd1',
      chatId: null,
      recordType: 'all',
    });
    expect(res.status).toBe(200);
  });

  it('defaults record_type to Real, so a Test deal is not surfaced by accident', async () => {
    await dealTimelineView(tlReq({ agent_id: 'a1', deal_id: 'd1' }));
    expect(buildDealTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: 'Real' })
    );
  });

  it('401s an unauthenticated caller WITHOUT making any HubSpot call', async () => {
    // Behind the key because it makes several HubSpot requests per call — an open endpoint could burn the
    // portal's rate limit.
    const res = await dealTimelineView(tlReq({ agent_id: 'a1' }, {}));
    expect(res.status).toBe(401);
    expect(buildDealTimeline).not.toHaveBeenCalled();
  });

  it('passes a blank param through as null', async () => {
    await dealTimelineView(tlReq({ agent_id: 'a1', deal_id: '', chat_id: '' }));
    expect(buildDealTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: null, chatId: null })
    );
  });

  it('surfaces a validation failure as a 200 the FE can read', async () => {
    (buildDealTimeline as jest.Mock).mockResolvedValue({
      success: false,
      error: 'agent_id is required',
    });
    const res = await dealTimelineView(tlReq());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: false, error: 'agent_id is required' });
  });

  it('answers 200 with success:false when the build throws', async () => {
    (buildDealTimeline as jest.Mock).mockRejectedValue(new Error('hs down'));
    const res = await dealTimelineView(
      tlReq({ agent_id: 'a1', deal_id: 'd1' })
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: false, error: 'Error: hs down' });
  });
});
