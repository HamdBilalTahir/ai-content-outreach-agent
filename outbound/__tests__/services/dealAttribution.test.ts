/**
 * @jest-environment node
 *
 * The conversion scan.
 *
 * The property that matters most is that **the two write paths are gated differently, and getting either
 * one the other way round breaks it**:
 *
 *  - Activities and the memory write-back are CHANGE-gated. State-gating them would re-card the same
 *    deal on every hourly run.
 *  - The funnel-stage sync is STATE-gated. Change-gating it would mean an already-attributed chat whose
 *    promotion was missed stays wrong until the deal happens to move again.
 *
 * Plus: a never-contacted chat is skipped entirely, the primary deal is the most-advanced one, and the
 * cursor only comes back when the page was FULL.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../firebase/chat', () => ({ setMemory: jest.fn() }));
jest.mock('../../firebase/agent', () => ({ getAgentActions: jest.fn() }));
jest.mock('../../firebase/prospect', () => ({
  setProspectStage: jest.fn(),
  setProspectSubStage: jest.fn(),
}));
jest.mock('../../services/hubspot', () => ({
  accessToken: jest.fn(),
  resolveHubspotConfig: jest.fn(),
}));
jest.mock('../../services/dealAnalytics', () => {
  const actual = jest.requireActual('../../services/dealAnalytics');
  return {
    ...actual,
    dealPipelineStages: jest.fn(),
    fetchContactDeals: jest.fn(),
  };
});

import { store } from '../../testSupport/mockFirestore';
import {
  HS_SYNC_TRIGGER_PREFIX,
  attributeChatDeals,
  resolveAgentContext,
  runDealAttribution,
  syncStageFromDeal,
} from '../../services/dealAttribution';
import { setMemory } from '../../firebase/chat';
import { getAgentActions } from '../../firebase/agent';
import { setProspectStage, setProspectSubStage } from '../../firebase/prospect';
import { accessToken, resolveHubspotConfig } from '../../services/hubspot';
import {
  dealPipelineStages,
  fetchContactDeals,
} from '../../services/dealAnalytics';
import type { ScannedDeal } from '../../services/dealAnalytics';
import type { StageMeta } from '../../services/dealAttribution';

const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';

/** A pipeline with an entry stage, an intermediate, and both terminals. */
const STAGE_META: StageMeta = {
  pipeline_label: 'Outbound',
  stages: {
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
    s_lost: {
      id: 's_lost',
      label: 'Closed Lost',
      order: 3,
      type: 'lost',
      is_entry: false,
    },
  },
};

function deal(over: Partial<ScannedDeal> = {}): ScannedDeal {
  return {
    deal_id: 'd1',
    dealstage: 's_lead',
    pipeline: 'p1',
    amount: '5000',
    createdate: '2026-07-01T00:00:00Z',
    stage_entered_at: '2026-07-10T00:00:00Z',
    ...over,
  };
}

/** Read the activity cards written to a chat. */
function activities(chatId = CHAT): Array<Record<string, unknown>> {
  return store
    .paths(`chats/${chatId}/activities`)
    .map((p) => store.get(p) as Record<string, unknown>);
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (setProspectStage as jest.Mock).mockResolvedValue(true);
  (setProspectSubStage as jest.Mock).mockResolvedValue(true);
  (resolveHubspotConfig as jest.Mock).mockReturnValue({
    access_token: 'tok',
    pipeline_id: 'p1',
    stage_ids: { Lead: 's_lead' },
  });
  (accessToken as jest.Mock).mockResolvedValue('tok');
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (dealPipelineStages as jest.Mock).mockResolvedValue({
    label: 'Outbound',
    stages: Object.values(STAGE_META.stages),
  });
  (fetchContactDeals as jest.Mock).mockResolvedValue([deal()]);
});

// ─────────────────────────────────────────────────────────────────────────────
// syncStageFromDeal
// ─────────────────────────────────────────────────────────────────────────────

describe('syncStageFromDeal', () => {
  it('promotes a Contacted chat to Lead and sets the sub-stage from the HubSpot stage', async () => {
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Contacted' },
      'Contract Sent',
      'open'
    );
    expect(setProspectStage).toHaveBeenCalledWith(
      CHAT,
      'Lead',
      `${HS_SYNC_TRIGGER_PREFIX}Contract Sent`,
      '',
      ''
    );
    expect(setProspectSubStage).toHaveBeenCalledWith(
      CHAT,
      'Contract Sent',
      `${HS_SYNC_TRIGGER_PREFIX}Contract Sent`
    );
    expect(applied).toEqual(['Contacted', 'Lead · Contract Sent']);
  });

  it('SELF-HEALS a chat left at Contacted whose deal already advanced', async () => {
    // The whole reason this is state-gated rather than change-gated: nothing about the deal changed on
    // this scan, and the chat still gets corrected.
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Contacted', sub_stage: 'contract_sent' },
      'Contract Sent',
      'open'
    );
    expect(setProspectStage).toHaveBeenCalledWith(
      CHAT,
      'Lead',
      expect.any(String),
      '',
      ''
    );
    // The sub-stage already matched, so only the stage moved.
    expect(setProspectSubStage).not.toHaveBeenCalled();
    expect(applied).toEqual(['Contacted', 'Lead · Contract Sent']);
  });

  it('is a NO-OP once the chat already matches the deal', async () => {
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Lead', sub_stage: 'Contract Sent' },
      'Contract Sent',
      'open'
    );
    expect(applied).toBeNull();
    expect(setProspectStage).not.toHaveBeenCalled();
    expect(setProspectSubStage).not.toHaveBeenCalled();
    expect(activities()).toHaveLength(0);
  });

  it('advances only the sub-stage for a chat already at Lead', async () => {
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Lead', sub_stage: 'lead' },
      'Contract Sent',
      'open'
    );
    expect(setProspectStage).not.toHaveBeenCalled();
    expect(setProspectSubStage).toHaveBeenCalled();
    expect(applied).toEqual(['Lead', 'Lead · Contract Sent']);
  });

  it('does not promote a stage outside the pre-Lead set', async () => {
    // `New`/absent is not in PRE_LEAD_STAGES, and a never-contacted chat is gated out upstream anyway —
    // but the guard is asserted here so a future edit cannot promote a rep's deal onto a cold chat.
    await syncStageFromDeal(CHAT, { stage: 'New' }, 'Contract Sent', 'open');
    expect(setProspectStage).not.toHaveBeenCalled();
    // The sub-stage still syncs; only the promotion is withheld.
    expect(setProspectSubStage).toHaveBeenCalled();
  });

  it('records a won deal as CRM Won, gating on sub_stage rather than stage', async () => {
    // The Lead-lock means a won prospect stays at stage Lead with sub_stage crm_won, so gating on the
    // stage name would re-apply forever.
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Lead', sub_stage: 'contract_sent' },
      'Closed Won',
      'won'
    );
    expect(setProspectStage).toHaveBeenCalledWith(
      CHAT,
      'CRM Won',
      `${HS_SYNC_TRIGGER_PREFIX}Closed Won`,
      '',
      ''
    );
    expect(applied).toEqual(['Lead', 'CRM Won']);
  });

  it('no-ops a won deal on a chat already at crm_won', async () => {
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Lead', sub_stage: 'crm_won' },
      'Closed Won',
      'won'
    );
    expect(applied).toBeNull();
    expect(setProspectStage).not.toHaveBeenCalled();
  });

  it('records a lost deal as Lost, carrying the HubSpot stage as the reason', async () => {
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Lead' },
      'Closed Lost',
      'lost'
    );
    expect(setProspectStage).toHaveBeenCalledWith(
      CHAT,
      'Lost',
      `${HS_SYNC_TRIGGER_PREFIX}Closed Lost`,
      '',
      '',
      'hubspot_closed_lost:Closed Lost'
    );
    expect(applied).toEqual(['Lead', 'Lost']);
  });

  it.each([[{ stage: 'Lost' }], [{ stage: 'Lead', sub_stage: 'lost' }]])(
    'no-ops a lost deal on an already-lost chat (%p)',
    async (chatData) => {
      expect(
        await syncStageFromDeal(CHAT, chatData, 'Closed Lost', 'lost')
      ).toBeNull();
      expect(setProspectStage).not.toHaveBeenCalled();
    }
  );

  it('writes an audit card carrying the HubSpot stage and the source', async () => {
    await syncStageFromDeal(
      CHAT,
      { stage: 'Contacted' },
      'Contract Sent',
      'open'
    );
    const card = activities()[0];
    expect(card.kind).toBe('tool_call');
    expect(card.toolCall).toMatchObject({
      toolName: 'hubspot_stage_synced',
      input: {
        from_stage: 'Contacted',
        to_stage: 'Lead · Contract Sent',
        hubspot_stage: 'Contract Sent',
        source: 'hubspot_sync',
      },
      status: 'success',
    });
  });

  it('reads dealers/company ids from the chat, then from memory', async () => {
    await syncStageFromDeal(
      CHAT,
      { stage: 'Contacted', memory: { dealers_id: 'd9', company_id: 'c9' } },
      'Lead',
      'open'
    );
    expect(setProspectStage).toHaveBeenCalledWith(
      CHAT,
      'Lead',
      expect.any(String),
      'd9',
      'c9'
    );
  });

  it('does not abort when a stage transition is rejected', async () => {
    // Forward-only and the Lead-lock legitimately reject transitions; one rejected chat must not stop the
    // scan of the rest.
    (setProspectStage as jest.Mock).mockRejectedValue(new Error('rejected'));
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Contacted' },
      'Lead',
      'open'
    );
    expect(applied).toEqual(['Contacted', 'Lead · Lead']);
  });

  it('writes nothing at all under dryRun, but still reports what it would do', async () => {
    const applied = await syncStageFromDeal(
      CHAT,
      { stage: 'Contacted' },
      'Contract Sent',
      'open',
      { dryRun: true }
    );
    expect(applied).toEqual(['Contacted', 'Lead · Contract Sent']);
    expect(setProspectStage).not.toHaveBeenCalled();
    expect(activities()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attributeChatDeals
// ─────────────────────────────────────────────────────────────────────────────

describe('attributeChatDeals', () => {
  it('cards the deal, writes memory, and syncs the stage on a first attribution', async () => {
    const result = await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [deal()],
      STAGE_META
    );
    expect(result.activities).toBe(1);
    expect(result.memoryUpdated).toBe(true);
    expect(result.stageSynced).toEqual(['Contacted', 'Lead · Lead']);
    expect(setMemory).toHaveBeenCalledWith(CHAT, {
      hubspot_deal_id: 'd1',
      hubspot_deal_stage: 'Lead',
      _hubspot_deal_stage_id: 's_lead',
      hubspot_deal_pipeline: 'Outbound',
      _converted_to_deal: true,
      _hubspot_deal_converted_at: '2026-07-10T00:00:00Z',
      _attributed_deals: { d1: 's_lead' },
    });
  });

  it('SKIPS a never-contacted chat entirely', async () => {
    // A deal on that contact was a rep's own work; attributing it would be false attribution.
    const result = await attributeChatDeals(
      CHAT,
      { stage: 'New' },
      [deal()],
      STAGE_META
    );
    expect(result).toEqual({
      activities: 0,
      memoryUpdated: false,
      stageSynced: null,
    });
    expect(setMemory).not.toHaveBeenCalled();
    expect(activities()).toHaveLength(0);
  });

  it('does NOT re-card a deal already logged at the same stage', async () => {
    // The change gate. Without it every hourly run would add another card to the same chat.
    const result = await attributeChatDeals(
      CHAT,
      {
        stage: 'Lead',
        sub_stage: 'lead',
        memory: {
          _attributed_deals: { d1: 's_lead' },
          _converted_to_deal: true,
          hubspot_deal_id: 'd1',
          _hubspot_deal_stage_id: 's_lead',
        },
      },
      [deal()],
      STAGE_META
    );
    expect(result.activities).toBe(0);
    expect(result.memoryUpdated).toBe(false);
    expect(setMemory).not.toHaveBeenCalled();
    expect(activities()).toHaveLength(0);
  });

  it('cards again when the SAME deal moved stage', async () => {
    const result = await attributeChatDeals(
      CHAT,
      {
        stage: 'Lead',
        memory: { _attributed_deals: { d1: 's_lead' }, hubspot_deal_id: 'd1' },
      },
      [deal({ dealstage: 's_sent' })],
      STAGE_META
    );
    expect(result.activities).toBe(1);
    expect(result.memoryUpdated).toBe(true);
    expect((setMemory as jest.Mock).mock.calls[0][1]._attributed_deals).toEqual(
      {
        d1: 's_sent',
      }
    );
  });

  it('picks the MOST-ADVANCED deal as primary, but cards every one', async () => {
    const result = await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [
        deal({ deal_id: 'd1', dealstage: 's_lead' }),
        deal({ deal_id: 'd2', dealstage: 's_won' }),
      ],
      STAGE_META
    );
    expect(result.activities).toBe(2);
    expect((setMemory as jest.Mock).mock.calls[0][1]).toMatchObject({
      hubspot_deal_id: 'd2',
      hubspot_deal_stage: 'Closed Won',
    });
  });

  it('tie-breaks equal stages on the latest stage-entry time', async () => {
    await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [
        deal({ deal_id: 'd1', stage_entered_at: '2026-07-01T00:00:00Z' }),
        deal({ deal_id: 'd2', stage_entered_at: '2026-07-20T00:00:00Z' }),
      ],
      STAGE_META
    );
    expect((setMemory as jest.Mock).mock.calls[0][1].hubspot_deal_id).toBe(
      'd2'
    );
  });

  it('ranks a deal in an UNKNOWN stage below every known one', async () => {
    // A deal in another pipeline must never outrank one in ours.
    await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [
        deal({ deal_id: 'd_other', dealstage: 'foreign_stage' }),
        deal({ deal_id: 'd1', dealstage: 's_lead' }),
      ],
      STAGE_META
    );
    expect((setMemory as jest.Mock).mock.calls[0][1].hubspot_deal_id).toBe(
      'd1'
    );
  });

  it('drops a deal with no id or no stage', async () => {
    const result = await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [deal({ deal_id: '' }), deal({ deal_id: 'd2', dealstage: null })],
      STAGE_META
    );
    expect(result).toEqual({
      activities: 0,
      memoryUpdated: false,
      stageSynced: null,
    });
  });

  it('does NOT mark a deal as logged when its card failed to write, but still writes the FACTS', async () => {
    // Two things happen here and both are deliberate. The log entry lags the write, so an unwritten card
    // is retried on the next scan — `_attributed_deals` stays empty. But the memory write-back still
    // runs, because the source gates it on `activities > 0 OR changed` and this is a first attribution:
    // the deal id and stage are worth more than the card, and the card will catch up.
    //
    // Spied on `store.docs`, not `store.set` — the double's `DocRef.set` writes through the underlying
    // map, and `store.set` is only the suite-facing seeding helper.
    const spy = jest.spyOn(store.docs, 'set').mockImplementationOnce(() => {
      throw new Error('firestore down');
    });
    try {
      const result = await attributeChatDeals(
        CHAT,
        { stage: 'Contacted' },
        [deal()],
        STAGE_META
      );
      expect(result.activities).toBe(0);
      expect(result.memoryUpdated).toBe(true);
      expect((setMemory as jest.Mock).mock.calls[0][1]).toMatchObject({
        hubspot_deal_id: 'd1',
        _converted_to_deal: true,
        // Empty, so the next scan re-cards this deal.
        _attributed_deals: {},
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the deal’s own pipeline when the definition has no label', async () => {
    await attributeChatDeals(CHAT, { stage: 'Contacted' }, [deal()], {
      stages: STAGE_META.stages,
    });
    expect(
      (setMemory as jest.Mock).mock.calls[0][1].hubspot_deal_pipeline
    ).toBe('p1');
  });

  it('never writes record_type — setMemory only writes the keys it is given', async () => {
    // What keeps an analytics scan from silently reclassifying a Test record.
    await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [deal()],
      STAGE_META
    );
    expect(
      Object.keys((setMemory as jest.Mock).mock.calls[0][1])
    ).not.toContain('record_type');
  });

  it('writes nothing under dryRun but reports the full plan', async () => {
    const result = await attributeChatDeals(
      CHAT,
      { stage: 'Contacted' },
      [deal()],
      STAGE_META,
      { dryRun: true }
    );
    expect(result.activities).toBe(1);
    expect(result.memoryUpdated).toBe(true);
    expect(result.stageSynced).not.toBeNull();
    expect(setMemory).not.toHaveBeenCalled();
    expect(activities()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAgentContext
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAgentContext', () => {
  it('builds the token, stage ids, and stage metadata', async () => {
    const ctx = await resolveAgentContext(AGENT);
    expect(ctx?.token).toBe('tok');
    expect(ctx?.stageIds).toEqual(['s_lead', 's_sent', 's_won', 's_lost']);
    expect(ctx?.stageMeta.pipeline_label).toBe('Outbound');
  });

  it.each([
    [
      'no HubSpot connection',
      () => (resolveHubspotConfig as jest.Mock).mockReturnValue({}),
    ],
    [
      'no usable token',
      () => (accessToken as jest.Mock).mockResolvedValue(null),
    ],
    [
      'no pipeline configured',
      () =>
        (resolveHubspotConfig as jest.Mock).mockReturnValue({
          access_token: 'tok',
        }),
    ],
    [
      'an unreadable pipeline',
      () => (dealPipelineStages as jest.Mock).mockResolvedValue(null),
    ],
  ])('is null for %s', async (_name, arrange) => {
    arrange();
    expect(await resolveAgentContext(AGENT)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDealAttribution
// ─────────────────────────────────────────────────────────────────────────────

describe('runDealAttribution', () => {
  /** An outbound chat that qualifies for the scan. */
  function seedChat(id: string, over: Record<string, unknown> = {}) {
    store.set(`chats/${id}`, {
      type: 'outbound',
      stage: 'Contacted',
      agentId: AGENT,
      ...over,
      memory: {
        hubspot_contact_id: 'c1',
        ...((over.memory ?? {}) as Record<string, unknown>),
      },
    });
  }

  it('scans, attributes, and reports the counters', async () => {
    seedChat('chat_a');
    seedChat('chat_b');
    const out = await runDealAttribution();
    expect(out).toMatchObject({
      success: true,
      scanned: 2,
      attributed: 2,
      updated: 2,
      stage_synced: 2,
    });
  });

  it('returns next_cursor ONLY when the page came back full', async () => {
    // A short page means the collection is exhausted, which is what lets the caller stop rather than
    // probing one more empty page.
    seedChat('chat_a');
    seedChat('chat_b');
    expect((await runDealAttribution({ limit: 2 })).next_cursor).toBe('chat_b');
    expect((await runDealAttribution({ limit: 5 })).next_cursor).toBeNull();
  });

  it('resumes after the cursor, so a full sweep terminates', async () => {
    seedChat('chat_a');
    seedChat('chat_b');
    seedChat('chat_c');
    const page1 = await runDealAttribution({ limit: 2 });
    expect(page1.scanned).toBe(2);
    expect(page1.next_cursor).toBe('chat_b');
    const page2 = await runDealAttribution({
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.scanned).toBe(1);
    expect(page2.next_cursor).toBeNull();
  });

  it('clamps the limit to the maximum, and floors it at 1', async () => {
    seedChat('chat_a');
    // 5000 would page the whole collection and blow the caller's five-minute cap.
    expect((await runDealAttribution({ limit: 5000 })).next_cursor).toBeNull();
    expect((await runDealAttribution({ limit: 0 })).scanned).toBe(1);
    expect((await runDealAttribution({ limit: 'abc' })).scanned).toBe(1);
  });

  it('processes just one chat for only_chat_id, and never paginates', async () => {
    seedChat('chat_a');
    seedChat('chat_b');
    const out = await runDealAttribution({ onlyChatId: 'chat_b' });
    expect(out.scanned).toBe(1);
    expect(out.next_cursor).toBeNull();
  });

  it('reports zero for an only_chat_id that does not exist', async () => {
    expect(await runDealAttribution({ onlyChatId: 'ghost' })).toMatchObject({
      success: true,
      scanned: 0,
    });
  });

  it('skips a never-contacted chat BEFORE fetching from HubSpot', async () => {
    seedChat('chat_a', { stage: 'New' });
    const out = await runDealAttribution();
    expect(out.scanned).toBe(1);
    expect(out.attributed).toBe(0);
    expect(fetchContactDeals).not.toHaveBeenCalled();
  });

  it('skips a chat with no stored contact id, before fetching', async () => {
    seedChat('chat_a', { memory: { hubspot_contact_id: null } });
    await runDealAttribution();
    expect(fetchContactDeals).not.toHaveBeenCalled();
  });

  it('filters to one agent, and to one campaign', async () => {
    seedChat('chat_a', { agentId: 'agentB' });
    seedChat('chat_b', { campaign_id: 'camp_1' });
    expect((await runDealAttribution({ agentId: AGENT })).attributed).toBe(1);
    expect(
      (await runDealAttribution({ campaignId: 'camp_1' })).attributed
    ).toBe(1);
    expect(
      (await runDealAttribution({ campaignId: 'camp_zzz' })).attributed
    ).toBe(0);
  });

  it('resolves each agent context ONCE per call, not once per chat', async () => {
    // Otherwise a hundred chats on one agent would refresh the same OAuth token a hundred times.
    seedChat('chat_a');
    seedChat('chat_b');
    seedChat('chat_c');
    await runDealAttribution();
    expect(getAgentActions).toHaveBeenCalledTimes(1);
  });

  it('caches a FAILED context too, so a broken agent is not retried per chat', async () => {
    (dealPipelineStages as jest.Mock).mockResolvedValue(null);
    seedChat('chat_a');
    seedChat('chat_b');
    const out = await runDealAttribution();
    expect(out.attributed).toBe(0);
    expect(getAgentActions).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning when one chat’s deal fetch throws', async () => {
    seedChat('chat_a');
    seedChat('chat_b');
    (fetchContactDeals as jest.Mock)
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce([deal()]);
    const out = await runDealAttribution();
    expect(out.scanned).toBe(2);
    expect(out.attributed).toBe(1);
  });

  it('counts a chat as attributed even when its write-back fails', async () => {
    // `attributed` counts contacts that HAD deals; `updated` counts successful write-backs. Keeping them
    // separate is what makes a partial failure visible in the response.
    seedChat('chat_a');
    (setMemory as jest.Mock).mockRejectedValue(new Error('firestore down'));
    const out = await runDealAttribution();
    expect(out.attributed).toBe(1);
    expect(out.updated).toBe(0);
  });

  it('does not count a contact with no deals as attributed', async () => {
    seedChat('chat_a');
    (fetchContactDeals as jest.Mock).mockResolvedValue([]);
    const out = await runDealAttribution();
    expect(out.scanned).toBe(1);
    expect(out.attributed).toBe(0);
  });

  it('ignores a non-outbound chat', async () => {
    store.set('chats/web_1', {
      type: 'web',
      stage: 'Contacted',
      agentId: AGENT,
      memory: { hubspot_contact_id: 'c1' },
    });
    expect((await runDealAttribution()).scanned).toBe(0);
  });

  it('writes nothing under dryRun', async () => {
    seedChat('chat_a');
    const out = await runDealAttribution({ dryRun: true });
    expect(out).toMatchObject({ attributed: 1, updated: 1 });
    expect(setMemory).not.toHaveBeenCalled();
    expect(setProspectStage).not.toHaveBeenCalled();
  });
});
