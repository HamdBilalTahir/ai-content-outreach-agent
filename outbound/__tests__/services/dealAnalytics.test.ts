/**
 * @jest-environment node
 *
 * The deal-analytics read layer.
 *
 * `attributedStageCounts` gets most of the attention, because it is where the funnel's numbers actually
 * come from and every one of its exclusions exists to stop the funnel claiming credit it has not earned:
 *
 *  - **A never-contacted chat is never counted.** A deal on that contact was created by a rep directly.
 *  - **An archived chat is never counted.** It is dead, and the FE already drops it.
 *  - **Two chats mapping to the same deal count ONCE.**
 *
 * Plus the two things a reader of the dashboard cannot see: the counts are Firestore-sourced (so they are
 * as of the last scan, not this instant), and won/lost is classified by LABEL in one place.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/hubspot', () => {
  const actual = jest.requireActual('../../services/hubspot');
  return { ...actual, accessToken: jest.fn() };
});

import { store } from '../../testSupport/mockFirestore';
import {
  attributedStageCounts,
  chatWasContacted,
  dealFunnelCounts,
  dealPipelineStages,
  dealSearchTotal,
  fetchContactDeals,
  isoToMs,
  readDealsBatch,
  stageType,
} from '../../services/dealAnalytics';
import { accessToken } from '../../services/hubspot';

const TOKEN = 'pat-token';
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

/** Seed an outbound chat that HAS been contacted and HAS an attributed deal. */
function seedAttributed(
  chatId: string,
  over: Record<string, unknown> = {},
  memOver: Record<string, unknown> = {}
) {
  store.set(`chats/${chatId}`, {
    agentId: AGENT,
    type: 'outbound',
    stage: 'Contacted',
    ...over,
    memory: {
      _converted_to_deal: true,
      hubspot_deal_id: 'deal_1',
      _hubspot_deal_stage_id: 'stage_lead',
      _hubspot_deal_converted_at: '2026-07-15T12:00:00Z',
      ...memOver,
    },
  });
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (accessToken as jest.Mock).mockResolvedValue(TOKEN);
  fetchMock = jest.fn().mockResolvedValue(ok({}));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// stageType
// ─────────────────────────────────────────────────────────────────────────────

describe('stageType', () => {
  it.each([
    ['Closed Won', 'won'],
    ['  CLOSED WON ', 'won'],
    ['Closed Lost', 'lost'],
    ['closed lost', 'lost'],
    ['Demo Scheduled', 'open'],
    ['', 'open'],
  ])('classifies %p as %p by LABEL', (label, expected) => {
    // The funnel, the timeline, and the attribution stage sync all derive won/lost from here, so a
    // change to this classification changes all three at once.
    expect(stageType({ label })).toBe(expected);
  });

  it('ignores everything except the label', () => {
    // Notably NOT `metadata.isClosed` — the source classifies on the label alone.
    expect(
      stageType({ label: 'Negotiation', metadata: { isClosed: 'true' } })
    ).toBe('open');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dealPipelineStages
// ─────────────────────────────────────────────────────────────────────────────

describe('dealPipelineStages', () => {
  it('orders by displayOrder and re-indexes `order` from zero', async () => {
    fetchMock.mockResolvedValue(
      ok({
        label: 'Outbound',
        stages: [
          { id: 's3', label: 'Closed Won', displayOrder: 9 },
          { id: 's1', label: 'Lead', displayOrder: 1 },
          { id: 's2', label: 'Demo', displayOrder: 4 },
        ],
      })
    );
    const shape = await dealPipelineStages(TOKEN, 'pipe_1', 's1');
    expect(shape?.label).toBe('Outbound');
    expect(shape?.stages).toEqual([
      { id: 's1', label: 'Lead', order: 0, type: 'open', is_entry: true },
      { id: 's2', label: 'Demo', order: 1, type: 'open', is_entry: false },
      { id: 's3', label: 'Closed Won', order: 2, type: 'won', is_entry: false },
    ]);
  });

  it('marks nothing as the entry stage when none is configured', async () => {
    fetchMock.mockResolvedValue(ok({ stages: [{ id: 's1', label: 'Lead' }] }));
    const shape = await dealPipelineStages(TOKEN, 'pipe_1', null);
    expect(shape?.stages[0].is_entry).toBe(false);
  });

  it('returns null — not an empty shape — on a failure', async () => {
    // The funnel turns this into a reported error, because an empty funnel and an unreachable pipeline
    // are indistinguishable to whoever is reading the dashboard.
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await dealPipelineStages(TOKEN, 'gone')).toBeNull();
  });

  it('returns null on a thrown request', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await dealPipelineStages(TOKEN, 'pipe_1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the batch reads
// ─────────────────────────────────────────────────────────────────────────────

describe('readDealsBatch', () => {
  it('keys the result by id and returns just the properties', async () => {
    fetchMock.mockResolvedValue(
      ok({
        results: [
          { id: 'd1', properties: { dealstage: 's1' } },
          { id: 'd2', properties: { dealstage: 's2' } },
        ],
      })
    );
    expect(await readDealsBatch(TOKEN, ['d1', 'd2'], ['dealstage'])).toEqual({
      d1: { dealstage: 's1' },
      d2: { dealstage: 's2' },
    });
  });

  it('chunks at 100 inputs per request', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `d${i}`);
    fetchMock.mockResolvedValue(ok({ results: [] }));
    await readDealsBatch(TOKEN, ids, ['dealstage']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('SKIPS a failing chunk and keeps the rest', async () => {
    // A partial result is useful to every caller; losing one page of a large scan is better than losing
    // the scan.
    const ids = Array.from({ length: 150 }, (_, i) => `d${i}`);
    fetchMock
      .mockResolvedValueOnce(ok({}, 500))
      .mockResolvedValueOnce(ok({ results: [{ id: 'd140', properties: {} }] }));
    expect(await readDealsBatch(TOKEN, ids, ['dealstage'])).toEqual({
      d140: {},
    });
  });

  it('makes no request for an empty or all-falsy id list', async () => {
    expect(await readDealsBatch(TOKEN, [], ['dealstage'])).toEqual({});
    expect(await readDealsBatch(TOKEN, [null, ''], ['dealstage'])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchContactDeals', () => {
  it('asks for a per-stage entry timestamp for every pipeline stage', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ results: [{ toObjectId: 'd1' }] }))
      .mockResolvedValueOnce(
        ok({
          results: [
            {
              id: 'd1',
              properties: {
                dealstage: 'won',
                pipeline: 'p1',
                amount: '5000',
                createdate: '2026-07-01T00:00:00Z',
                hs_date_entered_won: '2026-07-20T00:00:00Z',
              },
            },
          ],
        })
      );
    const deals = await fetchContactDeals(TOKEN, 'c1', ['s1', 'won']);
    // One batch read, not one read per stage.
    const body = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(body.properties).toContain('hs_date_entered_s1');
    expect(body.properties).toContain('hs_date_entered_won');
    expect(deals).toEqual([
      {
        deal_id: 'd1',
        dealstage: 'won',
        pipeline: 'p1',
        amount: '5000',
        createdate: '2026-07-01T00:00:00Z',
        stage_entered_at: '2026-07-20T00:00:00Z',
      },
    ]);
  });

  it('falls back to createdate when the stage has no entry timestamp', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ results: [{ toObjectId: 'd1' }] }))
      .mockResolvedValueOnce(
        ok({
          results: [
            {
              id: 'd1',
              properties: {
                dealstage: 's1',
                createdate: '2026-07-01T00:00:00Z',
              },
            },
          ],
        })
      );
    const deals = await fetchContactDeals(TOKEN, 'c1', ['s1']);
    expect(deals[0].stage_entered_at).toBe('2026-07-01T00:00:00Z');
  });

  it('returns [] and skips the batch read when the contact has no deals', async () => {
    fetchMock.mockResolvedValue(ok({ results: [] }));
    expect(await fetchContactDeals(TOKEN, 'c1')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('dealSearchTotal', () => {
  it('reads the server-side total', async () => {
    fetchMock.mockResolvedValue(ok({ total: 42 }));
    expect(await dealSearchTotal(TOKEN, [{ propertyName: 'x' }])).toBe(42);
  });

  it('is 0 on a failure, never a throw', async () => {
    fetchMock.mockResolvedValue(ok({}, 500));
    expect(await dealSearchTotal(TOKEN, [])).toBe(0);
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await dealSearchTotal(TOKEN, [])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isoToMs / chatWasContacted
// ─────────────────────────────────────────────────────────────────────────────

describe('isoToMs', () => {
  it('parses ISO-8601, with or without the Z', () => {
    expect(isoToMs('2026-07-15T12:00:00Z')).toBe(
      Date.parse('2026-07-15T12:00:00Z')
    );
    expect(isoToMs('2026-07-15T12:00:00+00:00')).toBe(
      Date.parse('2026-07-15T12:00:00Z')
    );
  });

  it('passes an already-epoch-millis string straight through', () => {
    expect(isoToMs('1784000000000')).toBe(1784000000000);
  });

  it.each([[null], [undefined], [''], ['   '], ['not a date']])(
    'is null for %p',
    (given) => {
      expect(isoToMs(given)).toBeNull();
    }
  );
});

describe('chatWasContacted', () => {
  it.each([['Contacted'], ['Engaged'], ['Lead'], ['Lost']])(
    'is true at stage %p',
    (stage) => {
      expect(chatWasContacted({ stage })).toBe(true);
    }
  );

  it.each([['New'], ['']])('is false at stage %p', (stage) => {
    expect(chatWasContacted({ stage })).toBe(false);
  });

  it('is false for an absent stage, and for no chat at all', () => {
    expect(chatWasContacted({})).toBe(false);
    expect(chatWasContacted(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attributedStageCounts
// ─────────────────────────────────────────────────────────────────────────────

describe('attributedStageCounts', () => {
  it('counts one attributed deal per stage', async () => {
    seedAttributed('c1');
    seedAttributed('c2', {}, { hubspot_deal_id: 'deal_2' });
    seedAttributed(
      'c3',
      {},
      {
        hubspot_deal_id: 'deal_3',
        _hubspot_deal_stage_id: 'stage_won',
      }
    );
    expect(await attributedStageCounts(AGENT)).toEqual({
      stage_lead: 2,
      stage_won: 1,
    });
  });

  it('DEDUPES by deal id — two chats on the same deal count once', async () => {
    // One contact can map to several chats, and both carry the same attribution.
    seedAttributed('c1');
    seedAttributed('c2');
    expect(await attributedStageCounts(AGENT)).toEqual({ stage_lead: 1 });
  });

  it('EXCLUDES a never-contacted chat, even with a stale attribution on it', async () => {
    // The deal was created by a rep directly; counting it is false attribution that inflates the funnel.
    seedAttributed('c1', { stage: 'New' });
    expect(await attributedStageCounts(AGENT)).toEqual({});
  });

  it.each([[{ archived: true }], [{ status: 'archived' }]])(
    'EXCLUDES an archived chat (%p)',
    async (over) => {
      // The stop sweep stamps both flags; the FE drops archived from the inbox and the drill lists, so
      // counting them here would disagree with the UI.
      seedAttributed('c1', over);
      expect(await attributedStageCounts(AGENT)).toEqual({});
    }
  );

  it('excludes an inbound or web chat', async () => {
    seedAttributed('c1', { type: 'web' });
    expect(await attributedStageCounts(AGENT)).toEqual({});
  });

  it('excludes a chat that never converted, or is missing either id', async () => {
    seedAttributed('c1', {}, { _converted_to_deal: false });
    seedAttributed('c2', {}, { hubspot_deal_id: null });
    seedAttributed('c3', {}, { _hubspot_deal_stage_id: null });
    expect(await attributedStageCounts(AGENT)).toEqual({});
  });

  it('returns {} for source=inbound without reading anything', async () => {
    // Correct rather than a gap: the attributed set is outbound-origin by construction, so an inbound
    // filter over it is empty by definition.
    seedAttributed('c1');
    expect(await attributedStageCounts(AGENT, { source: 'inbound' })).toEqual(
      {}
    );
  });

  it('filters by record_type, reading the chat field then memory', async () => {
    seedAttributed('c1', { record_type: 'Test' });
    seedAttributed(
      'c2',
      {},
      { hubspot_deal_id: 'deal_2', record_type: 'Test' }
    );
    seedAttributed('c3', {}, { hubspot_deal_id: 'deal_3' }); // defaults to Real
    expect(await attributedStageCounts(AGENT, { recordType: 'Test' })).toEqual({
      stage_lead: 2,
    });
    expect(await attributedStageCounts(AGENT, { recordType: 'Real' })).toEqual({
      stage_lead: 1,
    });
  });

  it('counts every record type for record_type=all', async () => {
    seedAttributed('c1', { record_type: 'Test' });
    seedAttributed('c2', {}, { hubspot_deal_id: 'deal_2' });
    expect(await attributedStageCounts(AGENT, { recordType: 'all' })).toEqual({
      stage_lead: 2,
    });
  });

  it('filters by campaign, reading the chat field then memory', async () => {
    seedAttributed('c1', { campaign_id: 'camp_1' });
    seedAttributed(
      'c2',
      {},
      {
        hubspot_deal_id: 'deal_2',
        campaign_id: 'camp_1',
      }
    );
    seedAttributed('c3', { campaign_id: 'camp_2' }, { hubspot_deal_id: 'd3' });
    expect(
      await attributedStageCounts(AGENT, { campaignId: 'camp_1' })
    ).toEqual({
      stage_lead: 2,
    });
  });

  it('bounds on the CONVERSION timestamp, inclusive at both ends', async () => {
    const at = (iso: string) => ({ _hubspot_deal_converted_at: iso });
    seedAttributed(
      'c1',
      {},
      { hubspot_deal_id: 'd1', ...at('2026-07-01T00:00:00Z') }
    );
    seedAttributed(
      'c2',
      {},
      { hubspot_deal_id: 'd2', ...at('2026-07-15T00:00:00Z') }
    );
    seedAttributed(
      'c3',
      {},
      { hubspot_deal_id: 'd3', ...at('2026-07-31T00:00:00Z') }
    );
    const counts = await attributedStageCounts(AGENT, {
      createdAfterMs: Date.parse('2026-07-01T00:00:00Z'),
      createdBeforeMs: Date.parse('2026-07-15T00:00:00Z'),
    });
    expect(counts).toEqual({ stage_lead: 2 });
  });

  it('DROPS a row with no parseable conversion date when a bound is set', async () => {
    // The strict reading: a date-bounded question cannot honestly include a row whose date is unknown.
    seedAttributed('c1', {}, { _hubspot_deal_converted_at: null });
    expect(await attributedStageCounts(AGENT, { createdAfterMs: 0 })).toEqual(
      {}
    );
    // With no bound, the same row counts.
    expect(await attributedStageCounts(AGENT)).toEqual({ stage_lead: 1 });
  });

  it('ignores another agent’s chats', async () => {
    seedAttributed('c1');
    store.set('chats/other', {
      agentId: 'agentB',
      type: 'outbound',
      stage: 'Contacted',
      memory: {
        _converted_to_deal: true,
        hubspot_deal_id: 'deal_9',
        _hubspot_deal_stage_id: 'stage_lead',
      },
    });
    expect(await attributedStageCounts(AGENT)).toEqual({ stage_lead: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dealFunnelCounts
// ─────────────────────────────────────────────────────────────────────────────

describe('dealFunnelCounts', () => {
  const cfg = {
    access_token: TOKEN,
    pipeline_id: 'pipe_1',
    stage_ids: { Lead: 's1' },
  };

  function pipelineOk() {
    fetchMock.mockResolvedValue(
      ok({
        label: 'Outbound',
        stages: [
          { id: 's1', label: 'Lead', displayOrder: 1 },
          { id: 's2', label: 'Closed Won', displayOrder: 2 },
        ],
      })
    );
  }

  it('takes the stage SHAPE from HubSpot and the COUNTS from Firestore', async () => {
    // The point of the module: a rep-created deal on an agent-engaged contact carries no `lead_source`
    // tag, so a HubSpot deal search would read zero for work the agent caused.
    pipelineOk();
    seedAttributed('c1', {}, { _hubspot_deal_stage_id: 's1' });
    seedAttributed(
      'c2',
      {},
      { hubspot_deal_id: 'd2', _hubspot_deal_stage_id: 's2' }
    );
    const out = await dealFunnelCounts(cfg, AGENT);
    expect(out).toEqual({
      pipeline_id: 'pipe_1',
      pipeline_label: 'Outbound',
      stages: [
        {
          id: 's1',
          label: 'Lead',
          order: 0,
          type: 'open',
          is_entry: true,
          count: 1,
        },
        {
          id: 's2',
          label: 'Closed Won',
          order: 1,
          type: 'won',
          is_entry: false,
          count: 1,
        },
      ],
      total: 2,
    });
  });

  it('lists every stage with a zero count, not just the occupied ones', async () => {
    // The funnel chart needs the empty columns; omitting them would silently reshape the dashboard.
    pipelineOk();
    const out = await dealFunnelCounts(cfg, AGENT);
    expect(out.stages?.map((s) => s.count)).toEqual([0, 0]);
    expect(out.total).toBe(0);
  });

  it('reports an ERROR, not an empty chart, when auth fails', async () => {
    (accessToken as jest.Mock).mockResolvedValue(null);
    expect(await dealFunnelCounts(cfg, AGENT)).toEqual({
      error: 'HubSpot auth failed (no valid token)',
    });
  });

  it('reports an error when no pipeline is configured', async () => {
    expect(await dealFunnelCounts({ access_token: TOKEN }, AGENT)).toEqual({
      error: 'HubSpot pipeline not configured (cfg.pipeline_id missing)',
    });
  });

  it('reports an error when the pipeline cannot be read', async () => {
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await dealFunnelCounts(cfg, AGENT)).toEqual({
      error: 'deal pipeline pipe_1 not found',
    });
  });

  it('passes the filters through to the attribution scan', async () => {
    pipelineOk();
    seedAttributed(
      'c1',
      { record_type: 'Test' },
      { _hubspot_deal_stage_id: 's1' }
    );
    const real = await dealFunnelCounts(cfg, AGENT, { recordType: 'Real' });
    expect(real.total).toBe(0);
    const test = await dealFunnelCounts(cfg, AGENT, { recordType: 'Test' });
    expect(test.total).toBe(1);
  });
});
