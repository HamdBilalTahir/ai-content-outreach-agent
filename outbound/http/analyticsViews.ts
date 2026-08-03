/**
 * The analytics dashboard endpoints — the deal funnel and the attribution scan.
 *
 * Ports `views/deal_funnel.py` and `views/deal_conversion.py`. The FE prepends its own Firestore New/Contacted/Engaged counts and
 * clumps the intermediate open stages into one column with a per-stage drill-down, so what this returns
 * is the HubSpot half only.
 *
 * ## The date filter is a DAY range, resolved in UTC
 *
 * `start_date` and `end_date` are `YYYY-MM-DD` and both inclusive: the end bound is that day's
 * `23:59:59.999`, not its midnight. Using midnight would silently exclude everything that happened on
 * the last day of the range the user picked — the classic off-by-one-day in a date picker, and the one
 * that looks like "the dashboard is missing today's conversions".
 *
 * An unparseable date is treated as UNBOUNDED rather than as an error. That is the source's choice and
 * it is the right one for a dashboard: a malformed query param should widen the view, not blank it.
 */

import { getAgentActions } from '../firebase/agent';
import { resolveHubspotConfig } from '../services/hubspot';
import { dealFunnelCounts } from '../services/dealAnalytics';
import { runDealAttribution } from '../services/dealAttribution';
import { requireApiKey } from './apiAuth';
import { json } from './types';
import type { OutboundRequest, OutboundResponse } from './types';

const SOURCES = ['all', 'outbound', 'inbound'];

/**
 * `YYYY-MM-DD` strings → inclusive UTC day bounds in epoch millis.
 *
 * `null` on either side means unbounded. The strict pattern check matters: `new Date('2026-13-45')` is
 * `Invalid Date` but `new Date('2026-1-5')` quietly parses, and accepting sloppy input here would make
 * two differently-typed queries return different ranges.
 */
export function dayBoundsMs(
  startDate: string | undefined | null,
  endDate: string | undefined | null
): [number | null, number | null] {
  const parse = (d: string | undefined | null): number | null => {
    const s = String(d ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  };
  const start = parse(startDate);
  const end = parse(endDate);
  return [
    start,
    // Inclusive end-of-day: one day forward, one millisecond back. See the module note.
    end === null ? null : end + 86_400_000 - 1,
  ];
}

/** GET /analytics/deal-funnel/ — per-stage deal counts for the dashboard. */
export async function dealFunnelView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const q = request.query;
  const agentId = q.agent_id;
  if (!agentId) return json({ error: 'agent_id is required' }, 400);

  const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
  if (!cfg.refresh_token && !cfg.access_token) {
    return json({ error: 'HubSpot v2 not connected for this agent' }, 400);
  }

  // An unrecognised source falls back to `all` rather than 400ing — same reasoning as the dates.
  let source = String(q.source ?? 'all')
    .trim()
    .toLowerCase();
  if (!SOURCES.includes(source)) source = 'all';

  const recordType = q.record_type || 'Real';
  const [startMs, endMs] = dayBoundsMs(q.start_date, q.end_date);

  const result = await dealFunnelCounts(cfg, agentId, {
    campaignId: q.campaign_id || null,
    source,
    createdAfterMs: startMs,
    createdBeforeMs: endMs,
    recordType,
  });
  if (result.error) return json(result, 400);

  // The filters are echoed back so the FE can confirm what it actually got — the coercions above mean
  // the effective query is not always the one that was sent.
  return json({
    ...result,
    filters: {
      campaign_id: q.campaign_id || null,
      source,
      start_date: q.start_date || null,
      end_date: q.end_date || null,
      record_type: recordType,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /analytics/run-deal-attribution/
// ─────────────────────────────────────────────────────────────────────────────

/** Body first, then query — the FE cron posts a body, a manual re-scan is easier as a URL. */
function param(request: OutboundRequest, key: string): unknown {
  const fromBody = request.body[key];
  return fromBody === null || fromBody === undefined
    ? request.query[key]
    : fromBody;
}

/**
 * Run one bounded page of the conversion scan.
 *
 * **The one outbound endpoint behind an API key.** Everything else here is either signature-verified (the
 * provider webhooks) or FE-facing; this one writes attribution across every outbound chat, so it is
 * guarded — and the guard fails closed, including when the key is not configured at all.
 *
 * A scan failure answers **200 with `success: false`**, for the same reason the cron does: the caller is
 * a scheduler that retries non-2xx, and this scan has already written attribution to some chats by the
 * time it faults. The writes are idempotent, so a replay is safe — but a retry storm against a scan that
 * faults every time is not, and the caller should see the error and stop rather than loop.
 */
export async function runDealAttributionView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const deny = requireApiKey(request);
  if (deny) return deny;

  try {
    return json(
      await runDealAttribution({
        agentId: (param(request, 'agent_id') as string) || null,
        campaignId: (param(request, 'campaign_id') as string) || null,
        cursor: (param(request, 'cursor') as string) || null,
        limit: param(request, 'limit'),
        onlyChatId: (param(request, 'only_chat_id') as string) || null,
        // Truthiness is spelled out because a `dry_run=false` query STRING is truthy in JS. Only these
        // three spellings enable it, matching the source.
        dryRun: ['1', 'true', 'yes'].includes(
          String(param(request, 'dry_run') ?? '')
            .trim()
            .toLowerCase()
        ),
      })
    );
  } catch (e) {
    console.error(`[DEAL_ATTR] run failed: ${e}`);
    return json({ success: false, error: String(e) });
  }
}
