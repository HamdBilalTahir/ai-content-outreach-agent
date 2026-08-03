/**
 * The analytics dashboard endpoints — currently the deal funnel.
 *
 * Ports `views/deal_funnel.py`. The FE prepends its own Firestore New/Contacted/Engaged counts and
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
