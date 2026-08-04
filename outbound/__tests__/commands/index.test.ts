/**
 * @jest-environment node
 *
 * The two operational runners and the command registry.
 *
 * The one behaviour with real content is `runDealAttributionToCompletion`: it pages to EXHAUSTION, which is
 * the opposite bound to the HTTP endpoint running the same scan. That difference is deliberate — a
 * scheduler wants a bounded slice, an operator wants the job finished — and collapsing them would either
 * time out the cron or leave the manual sweep half-done.
 *
 * The registry is asserted against the source's own command names, because those names are what an
 * operator types and what makes the set greppable against `ls management/commands/`.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../services/stalledRecovery', () => ({
  reconcileStalePendingCalls: jest.fn(),
}));
jest.mock('../../services/dealAttribution', () => ({
  runDealAttribution: jest.fn(),
}));

import {
  commands,
  reconcileStaleCalls,
  runDealAttributionToCompletion,
} from '../../commands';
import { reconcileStalePendingCalls } from '../../services/stalledRecovery';
import { runDealAttribution } from '../../services/dealAttribution';

/** A scan page. `next_cursor` null means the sweep is done. */
function scanPage(over: Record<string, unknown> = {}) {
  return {
    success: true,
    scanned: 10,
    attributed: 4,
    updated: 3,
    stage_synced: 2,
    next_cursor: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (reconcileStalePendingCalls as jest.Mock).mockResolvedValue({
    scanned: 0,
    finalized: 0,
  });
  (runDealAttribution as jest.Mock).mockResolvedValue(scanPage());
});

describe('reconcileStaleCalls', () => {
  it('defaults to the service threshold and a 200-doc scan', async () => {
    // `null` for the age, not a number: the service owns the default, and hard-coding one here would let
    // the two drift.
    await reconcileStaleCalls();
    expect(reconcileStalePendingCalls).toHaveBeenCalledWith(null, 200, false);
  });

  it('passes hand-picked bounds through', async () => {
    // The reason this exists at all: a shorter window after a known provider outage finds calls the cron's
    // conservative threshold is still waiting on.
    await reconcileStaleCalls({ olderThanMin: 5, maxScan: 50, dryRun: true });
    expect(reconcileStalePendingCalls).toHaveBeenCalledWith(5, 50, true);
  });

  it('returns the sweep summary unchanged', async () => {
    (reconcileStalePendingCalls as jest.Mock).mockResolvedValue({
      scanned: 7,
      finalized: 2,
    });
    expect(await reconcileStaleCalls()).toEqual({ scanned: 7, finalized: 2 });
  });
});

describe('runDealAttributionToCompletion', () => {
  it('pages to EXHAUSTION, summing the counters', async () => {
    (runDealAttribution as jest.Mock)
      .mockResolvedValueOnce(scanPage({ next_cursor: 'chat_b' }))
      .mockResolvedValueOnce(scanPage({ next_cursor: 'chat_d' }))
      .mockResolvedValueOnce(scanPage({ next_cursor: null }));
    const out = await runDealAttributionToCompletion();
    expect(out).toEqual({
      pages: 3,
      scanned: 30,
      attributed: 12,
      updated: 9,
      dry_run: false,
    });
  });

  it('feeds each page’s cursor into the next call', async () => {
    (runDealAttribution as jest.Mock)
      .mockResolvedValueOnce(scanPage({ next_cursor: 'chat_b' }))
      .mockResolvedValueOnce(scanPage({ next_cursor: null }));
    await runDealAttributionToCompletion();
    expect(
      (runDealAttribution as jest.Mock).mock.calls[0][0].cursor
    ).toBeNull();
    expect((runDealAttribution as jest.Mock).mock.calls[1][0].cursor).toBe(
      'chat_b'
    );
  });

  it('stops after ONE page for onlyChatId, even if a cursor came back', async () => {
    // A single-chat verification has nothing to page through.
    (runDealAttribution as jest.Mock).mockResolvedValue(
      scanPage({ next_cursor: 'chat_b' })
    );
    const out = await runDealAttributionToCompletion({ onlyChatId: 'chat_7' });
    expect(out.pages).toBe(1);
    expect(runDealAttribution).toHaveBeenCalledTimes(1);
  });

  it('forwards every filter, and the dry-run flag', async () => {
    await runDealAttributionToCompletion({
      agentId: 'a1',
      campaignId: 'camp_1',
      limit: 50,
      dryRun: true,
    });
    expect(runDealAttribution).toHaveBeenCalledWith({
      agentId: 'a1',
      campaignId: 'camp_1',
      cursor: null,
      limit: 50,
      onlyChatId: null,
      dryRun: true,
    });
  });

  it('reports one page for an empty sweep rather than zero', async () => {
    // The scan always runs once; "zero pages" would read as "it did not run".
    (runDealAttribution as jest.Mock).mockResolvedValue(
      scanPage({ scanned: 0, attributed: 0, updated: 0 })
    );
    expect(await runDealAttributionToCompletion()).toMatchObject({
      pages: 1,
      scanned: 0,
    });
  });
});

describe('the command registry', () => {
  it('holds every source command under its own name', () => {
    // Verbatim from `ls management/commands/`, minus `__init__`. These names are what an operator types.
    expect(Object.keys(commands).sort()).toEqual([
      'backfill_aaai_area_code',
      'backfill_deal_campaign',
      'backfill_email_optout_chat_flags',
      'backfill_email_suppression',
      'backfill_last_inbound_email_at',
      'backfill_optout_flags',
      'backfill_website_verified_business',
      'reconcile_stale_calls',
      'run_deal_attribution',
    ]);
  });

  it('maps every name to a callable', () => {
    for (const [name, fn] of Object.entries(commands)) {
      expect(typeof fn).toBe('function');
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });
});
