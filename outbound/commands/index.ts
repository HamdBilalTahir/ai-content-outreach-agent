/**
 * The operational commands — the port of `management/commands/`.
 *
 * Django gives each of these a `manage.py` entry, argv parsing, and a `BaseCommand` subclass. This port
 * keeps what those wrap — the defaults, the clamps, the `--dry-run` semantics, the paging — as plain
 * functions, and drops the runner: Django supplies one, this repo has none, and adding a TypeScript
 * script runner as a dependency is outside a port of the application.
 *
 * `commands` below is the registry that replaces `manage.py <name>`. It maps each source command's name,
 * verbatim, to its function, so a future CLI or admin route is a lookup rather than a switch — and so the
 * set is greppable against `ls management/commands/`.
 *
 * ## Two of these are not really new
 *
 * `reconcile_stale_calls` already runs inside the cron tick, and `run_deal_attribution` is the scan the
 * `analytics/run-deal-attribution/` endpoint runs. Both exist here for what the source built them for: a
 * manual sweep with hand-picked bounds, and a verifier you can point at one chat. The `runDealAttribution`
 * wrapper adds the one thing the endpoint deliberately does not — it pages to exhaustion, because a cron
 * caller wants a bounded slice while an operator wants the job finished.
 */

import { reconcileStalePendingCalls } from '../services/stalledRecovery';
import { runDealAttribution } from '../services/dealAttribution';
import { backfillAaaiAreaCode, backfillDealCampaign } from './hubspotBackfills';
import { backfillWebsiteVerifiedBusiness } from './websiteVerifiedBusiness';
import {
  backfillEmailOptoutChatFlags,
  backfillEmailSuppression,
  backfillLastInboundEmailAt,
  backfillOptoutFlags,
} from './optoutBackfills';

export * from './hubspotBackfills';
export * from './optoutBackfills';
export * from './websiteVerifiedBusiness';

// ─────────────────────────────────────────────────────────────────────────────
// reconcile_stale_calls
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Only calls older than this many minutes. Defaults to the service's own threshold. */
  olderThanMin?: number | null;
  maxScan?: number;
  dryRun?: boolean;
}

/**
 * Finalize stale in-flight outbound calls — placed but never completed, and not reviewable.
 *
 * The failure it repairs is silent and self-sustaining: the `pending_calls` lookup doc was never deleted,
 * the call card sits at `in_progress`, and the per-chat dial guard keeps blocking the next attempt until
 * its six-hour fail-open. So the chat drops out of the cadence with nothing reviewing it and nothing
 * reporting it.
 *
 * A thin pass-through, because the sweep itself is the cron's and is already tested there. What this adds
 * is the ability to choose the bounds by hand — a shorter `olderThanMin` after a known provider outage
 * finds calls the cron's conservative threshold is still waiting on.
 */
export async function reconcileStaleCalls(options: ReconcileOptions = {}) {
  const { olderThanMin = null, maxScan = 200, dryRun = false } = options;
  return reconcileStalePendingCalls(olderThanMin, maxScan, dryRun);
}

// ─────────────────────────────────────────────────────────────────────────────
// run_deal_attribution
// ─────────────────────────────────────────────────────────────────────────────

export interface AttributionRunOptions {
  agentId?: string | null;
  campaignId?: string | null;
  /** One chat only — the verification path. Disables paging. */
  onlyChatId?: string | null;
  limit?: number;
  dryRun?: boolean;
}

export interface AttributionRunResult {
  pages: number;
  scanned: number;
  attributed: number;
  updated: number;
  dry_run: boolean;
}

/**
 * Run the conversion scan to EXHAUSTION, following the cursor across pages.
 *
 * The opposite bound to the HTTP endpoint on purpose: that one answers a scheduler and returns after one
 * bounded page, because a request that runs for an hour is a request that gets killed. An operator running
 * this wants the sweep to finish, so the loop follows `next_cursor` until it comes back null.
 *
 * `onlyChatId` short-circuits after one iteration even if a cursor came back, matching the source — a
 * single-chat verification has nothing to page through.
 */
export async function runDealAttributionToCompletion(
  options: AttributionRunOptions = {}
): Promise<AttributionRunResult> {
  const {
    agentId = null,
    campaignId = null,
    onlyChatId = null,
    limit,
    dryRun = false,
  } = options;

  const totals = { scanned: 0, attributed: 0, updated: 0 };
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const r = await runDealAttribution({
      agentId,
      campaignId,
      cursor,
      limit,
      onlyChatId,
      dryRun,
    });
    pages += 1;
    totals.scanned += r.scanned;
    totals.attributed += r.attributed;
    totals.updated += r.updated;
    console.log(
      `  page ${pages}: scanned=${r.scanned} attributed=${r.attributed} ` +
        `updated=${r.updated} next_cursor=${r.next_cursor}`
    );
    cursor = r.next_cursor;
    if (!cursor || onlyChatId) break;
  }

  return { pages, ...totals, dry_run: dryRun };
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every command, under the source's own name.
 *
 * Deliberately typed loosely: these take different option shapes, and a lowest-common-denominator
 * signature would either lose each command's real arguments or force a fake uniform one. A caller looks up
 * the name it wants and passes that command's options.
 */
export const commands = {
  reconcile_stale_calls: reconcileStaleCalls,
  run_deal_attribution: runDealAttributionToCompletion,
  backfill_optout_flags: backfillOptoutFlags,
  backfill_last_inbound_email_at: backfillLastInboundEmailAt,
  backfill_email_suppression: backfillEmailSuppression,
  backfill_email_optout_chat_flags: backfillEmailOptoutChatFlags,
  backfill_deal_campaign: backfillDealCampaign,
  backfill_aaai_area_code: backfillAaaiAreaCode,
  backfill_website_verified_business: backfillWebsiteVerifiedBusiness,
} as const;

export type CommandName = keyof typeof commands;
