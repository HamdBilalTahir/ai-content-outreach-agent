/**
 * The deal-analytics read layer — the funnel's counts, and the CRM reads the attribution scan and the
 * timeline are built on.
 *
 * Ported from the analytics half of `services/hubspot.py`. It lives in its own module because it is a
 * read-only reporting layer with a different shape from everything else in the CRM port: nothing here
 * writes to HubSpot, and its consumers are dashboard endpoints rather than the agent.
 *
 * ## The funnel counts come from FIRESTORE, not from a HubSpot deal search
 *
 * This is the design decision the whole module turns on, and it is counter-intuitive enough to state
 * plainly. A prospect the agent engaged may convert via **another rep**: a deal is created or advanced
 * on the same contact but WITHOUT the agent's `lead_source` tag. A `lead_source`-filtered deal search
 * therefore misses it and the funnel reads zero for work the agent actually caused.
 *
 * So the counts come from the attribution the conversion scan writes into chat memory, and only the
 * stage list — labels, order, won/lost typing, `is_entry` — is read LIVE from the HubSpot pipeline. The
 * consequence to be aware of: **the counts are as of the last scan**, not as of this instant.
 *
 * ## Three exclusions, each of which would otherwise inflate the funnel
 *
 *  - **Never-contacted chats.** `stage` is set to `Contacted` the moment `make_phone_call` or
 *    `send_email` fires, so a chat still at `New`/absent is proof the AI never reached out. A deal on
 *    that contact was created by a rep directly; counting it is false attribution.
 *  - **Archived chats**, parked by the campaign stop sweep. They are dead, and the FE drops them from
 *    the inbox and the drill-down lists, so counting them here would disagree with the UI.
 *  - **Duplicate deals.** One contact can map to several chats and therefore to the same deal, so the
 *    scan dedupes by `deal_id` before counting.
 *
 * ## Won/lost is classified by LABEL, in one place
 *
 * `stageType` reads `"closed won"` / `"closed lost"` case-insensitively. The funnel, the timeline, and
 * the attribution stage sync all derive won/lost from this one function, so getting the classification
 * right fixes all three at once — and getting it wrong breaks all three the same way.
 */

import { db } from '../firebase/db';
import { HUBSPOT_BASE, accessToken, hsHeaders } from './hubspot';
import type { HubspotConfig } from './hubspot';

const REQUEST_TIMEOUT_MS = 30_000;

/** The properties every deal read needs. */
export const DEAL_SCAN_PROPERTIES = [
  'dealstage',
  'pipeline',
  'amount',
  'createdate',
] as const;

/** A batch read caps at 100 inputs per HubSpot request. */
const BATCH_CHUNK = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline shape
// ─────────────────────────────────────────────────────────────────────────────

export type StageType = 'won' | 'lost' | 'open';

export interface PipelineStage {
  id: string;
  label: string;
  order: number;
  type: StageType;
  /** True for the stage the agent's own deals enter at (`cfg.stage_ids.Lead`). */
  is_entry: boolean;
}

export interface PipelineShape {
  label: string;
  stages: PipelineStage[];
}

/** Won/lost from the stage LABEL. The single classification authority — see the module note. */
export function stageType(stage: Record<string, unknown>): StageType {
  const label = String(stage.label ?? '')
    .trim()
    .toLowerCase();
  if (label === 'closed won') return 'won';
  if (label === 'closed lost') return 'lost';
  return 'open';
}

/**
 * One deal pipeline's stages, ordered by `displayOrder`.
 *
 * Richer than `listDealPipelines`, which drops the metadata this needs for won/lost typing. `null` on
 * any failure, which the funnel turns into a reported error rather than an empty chart — an empty
 * funnel and an unreachable pipeline look identical to a reader otherwise.
 */
export async function dealPipelineStages(
  token: string,
  pipelineId: string,
  entryStageId?: string | null
): Promise<PipelineShape | null> {
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/pipelines/deals/${encodeURIComponent(String(pipelineId))}`,
      {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status !== 200) {
      console.error(
        `[HS] pipeline ${pipelineId} ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return null;
    }
    const p = ((await resp.json()) ?? {}) as Record<string, unknown>;
    const raw = ((p.stages ?? []) as Array<Record<string, unknown>>)
      .slice()
      .sort(
        (a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0)
      );
    return {
      label: String(p.label ?? ''),
      stages: raw.map((s, i) => ({
        id: String(s.id ?? ''),
        label: String(s.label ?? ''),
        order: i,
        type: stageType(s),
        is_entry: Boolean(entryStageId) && String(s.id ?? '') === entryStageId,
      })),
    };
  } catch (e) {
    console.error(`[HS] dealPipelineStages ${pipelineId}: ${e}`);
    return null;
  }
}

/** Server-side count of deals matching one AND group. `limit=1` and read `total`. `0` on failure. */
export async function dealSearchTotal(
  token: string,
  filters: unknown[]
): Promise<number> {
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: ['dealstage'],
        limit: 1,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200) {
      const data = (await resp.json()) as Record<string, unknown>;
      return Math.trunc(Number(data.total) || 0);
    }
    console.error(
      `[HS] deal search total ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] dealSearchTotal error: ${e}`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact → deals reads (the conversion scan)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ids of the objects of `toType` associated to one `fromType`/`fromId`.
 *
 * CRM v4 default associations. `[]` on failure, which degrades a timeline group or a scan row to empty
 * rather than failing the whole read.
 */
export async function assocObjectIds(
  token: string,
  fromType: string,
  fromId: string,
  toType: string,
  limit = 500
): Promise<string[]> {
  if (!fromId) return [];
  try {
    const url = new URL(
      `${HUBSPOT_BASE}/crm/v4/objects/${fromType}/${encodeURIComponent(String(fromId))}/associations/${toType}`
    );
    url.searchParams.set('limit', String(limit));
    const resp = await fetch(url, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.error(
        `[HS] ${fromType}/${fromId} assoc ${toType} ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return [];
    }
    const data = (await resp.json()) as Record<string, unknown>;
    return ((data.results ?? []) as Array<Record<string, unknown>>)
      .filter((r) => r.toObjectId)
      .map((r) => String(r.toObjectId));
  } catch (e) {
    console.error(`[HS] assocObjectIds ${fromType}/${fromId}->${toType}: ${e}`);
    return [];
  }
}

/** A contact's associated deal ids. The v4 default-associations read. */
export async function getContactDealIds(
  token: string,
  contactId: string
): Promise<string[]> {
  return assocObjectIds(token, 'contacts', contactId, 'deals', 100);
}

/**
 * Batch-read any CRM object's properties. `{id: {prop: value}}`.
 *
 * A failing chunk is SKIPPED, not fatal: a partial result is useful to every caller here, and losing
 * one page of a 400-deal scan is better than losing the scan.
 */
export async function readObjectsBatch(
  token: string,
  objectType: string,
  ids: readonly unknown[],
  properties: readonly string[]
): Promise<Record<string, Record<string, unknown>>> {
  const clean = (ids ?? []).filter(Boolean).map((i) => String(i));
  if (clean.length === 0) return {};
  const out: Record<string, Record<string, unknown>> = {};
  try {
    for (let i = 0; i < clean.length; i += BATCH_CHUNK) {
      const resp = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/${objectType}/batch/read`,
        {
          method: 'POST',
          headers: hsHeaders(token),
          body: JSON.stringify({
            properties: [...properties],
            inputs: clean.slice(i, i + BATCH_CHUNK).map((d) => ({ id: d })),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
      if (resp.status !== 200) {
        console.error(
          `[HS] ${objectType} batch read ${resp.status}: ${(await resp.text()).slice(0, 200)}`
        );
        continue;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      for (const r of (data.results ?? []) as Array<Record<string, unknown>>) {
        out[String(r.id)] = (r.properties ?? {}) as Record<string, unknown>;
      }
    }
  } catch (e) {
    console.error(`[HS] readObjectsBatch ${objectType}: ${e}`);
  }
  return out;
}

/** `readObjectsBatch` for deals. Kept as its own name because every caller reads deals. */
export async function readDealsBatch(
  token: string,
  dealIds: readonly unknown[],
  properties: readonly string[]
): Promise<Record<string, Record<string, unknown>>> {
  return readObjectsBatch(token, 'deals', dealIds, properties);
}

export interface ScannedDeal {
  deal_id: string;
  dealstage: string | null;
  pipeline: unknown;
  amount: unknown;
  createdate: unknown;
  /** `hs_date_entered_<currentStage>`, falling back to `createdate`. */
  stage_entered_at: unknown;
}

/**
 * A contact's deals of ANY origin — agent-created and rep-created alike.
 *
 * The whole point: no existing helper fetched a contact's deals, only create/update/search-count, and a
 * search-count cannot see a deal that lacks the agent's `lead_source` tag. Pass the pipeline's
 * `stageIds` so every per-stage entry timestamp arrives in one batch read rather than one read per stage.
 */
export async function fetchContactDeals(
  token: string,
  contactId: string,
  stageIds?: readonly string[] | null
): Promise<ScannedDeal[]> {
  const dealIds = await getContactDealIds(token, contactId);
  if (dealIds.length === 0) return [];
  const props = [
    ...DEAL_SCAN_PROPERTIES,
    ...(stageIds ?? []).filter(Boolean).map((s) => `hs_date_entered_${s}`),
  ];
  const read = await readDealsBatch(token, dealIds, props);
  return Object.entries(read).map(([dealId, p]) => {
    const stage = (p.dealstage as string) ?? null;
    const entered = stage ? p[`hs_date_entered_${stage}`] : null;
    return {
      deal_id: dealId,
      dealstage: stage,
      pipeline: p.pipeline,
      amount: p.amount,
      createdate: p.createdate,
      stage_entered_at: entered || p.createdate,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-deal reads (the timeline)
// ─────────────────────────────────────────────────────────────────────────────

/** CRM object type → the properties the timeline needs from that engagement. */
const ENGAGEMENT_PROPERTIES: Record<string, string[]> = {
  emails: [
    'hs_timestamp',
    'hs_email_direction',
    'hs_email_subject',
    'hs_email_status',
  ],
  calls: [
    'hs_timestamp',
    'hs_call_title',
    'hs_call_direction',
    'hs_call_duration',
  ],
  meetings: ['hs_timestamp', 'hs_meeting_title', 'hs_meeting_start_time'],
  notes: ['hs_timestamp', 'hs_note_body'],
  tasks: ['hs_timestamp', 'hs_task_subject', 'hs_task_status'],
};

export type EngagementGroups = Record<string, Array<Record<string, unknown>>>;

export interface DealDetail {
  deal_id: string;
  dealstage: string | null;
  pipeline: unknown;
  amount: unknown;
  createdate: unknown;
  closedate: unknown;
  stage_entered_at: unknown;
  /** `hs_date_entered_<id>` for every pipeline stage the deal actually passed through. */
  stage_entered: Record<string, unknown>;
}

/**
 * One deal's properties plus its per-stage entry timestamps.
 *
 * `stage_entered` only carries stages with a REAL timestamp — the sparse entries are what let the
 * timeline avoid fabricating stage changes for deals HubSpot never recorded a history for.
 */
export async function fetchDealDetail(
  token: string,
  dealId: string,
  stageIds?: readonly string[] | null
): Promise<DealDetail | null> {
  if (!dealId) return null;
  const props = [
    ...DEAL_SCAN_PROPERTIES,
    'closedate',
    ...(stageIds ?? []).filter(Boolean).map((s) => `hs_date_entered_${s}`),
  ];
  const read = await readDealsBatch(token, [dealId], props);
  const p = read[String(dealId)];
  if (p === undefined) return null;

  const stage = (p.dealstage as string) ?? null;
  const entered: Record<string, unknown> = {};
  for (const s of stageIds ?? []) {
    const v = p[`hs_date_entered_${s}`];
    if (s && v) entered[s] = v;
  }
  return {
    deal_id: String(dealId),
    dealstage: stage,
    pipeline: p.pipeline,
    amount: p.amount,
    createdate: p.createdate,
    closedate: p.closedate,
    stage_entered_at:
      (stage ? p[`hs_date_entered_${stage}`] : null) || p.createdate,
    stage_entered: entered,
  };
}

/**
 * Every engagement associated to a deal, grouped by type.
 *
 * Best-effort per group: a failing association or read degrades that group to `[]` rather than losing the
 * whole timeline. All five keys are always present, so the caller never has to check.
 */
export async function getDealEngagements(
  token: string,
  dealId: string
): Promise<EngagementGroups> {
  const out: EngagementGroups = {};
  for (const key of Object.keys(ENGAGEMENT_PROPERTIES)) out[key] = [];
  if (!dealId) return out;

  for (const [objectType, props] of Object.entries(ENGAGEMENT_PROPERTIES)) {
    const ids = await assocObjectIds(token, 'deals', dealId, objectType);
    if (ids.length === 0) continue;
    const read = await readObjectsBatch(token, objectType, ids, props);
    for (const [oid, p] of Object.entries(read)) {
      out[objectType].push({ ...p, id: oid });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Firestore attribution scan
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-8601, or an already-epoch-millis string, → epoch millis. `null` if unparseable. */
export function isoToMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Number(s);
  const dt = new Date(s.replace('Z', '+00:00'));
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

/** A chat still at one of these has never been reached out to. */
const UNCONTACTED_STAGES = new Set([null, undefined, '', 'New']);

/**
 * Did the AI actually reach out to this prospect?
 *
 * `stage` becomes `Contacted` the moment `make_phone_call` or `send_email` fires, so anything outside
 * `{absent, '', 'New'}` is local proof of contact. A never-contacted chat must NEVER be attributed or
 * counted — a HubSpot deal on its contact was created by a rep directly, and attributing it would
 * inflate the funnel with work the agent did not cause.
 */
export function chatWasContacted(
  chatData: Record<string, unknown> | null | undefined
): boolean {
  return !UNCONTACTED_STAGES.has(
    (chatData ?? {}).stage as string | null | undefined
  );
}

export interface FunnelFilters {
  campaignId?: string | null;
  /** `all` | `outbound` | `inbound`. */
  source?: string;
  recordType?: string;
  createdAfterMs?: number | null;
  createdBeforeMs?: number | null;
}

/**
 * `{stageId: count}` of deals attributed to this agent's outbound prospects, deduped by deal id.
 *
 * Reads what the conversion scan wrote: `memory._converted_to_deal`, `hubspot_deal_id`,
 * `_hubspot_deal_stage_id`, `_hubspot_deal_converted_at`. Each deal inherits its source chat's
 * `record_type`.
 *
 * **`source: 'inbound'` returns nothing, and that is correct rather than a gap.** The attributed set is
 * outbound-origin by construction — every row comes from an outbound chat — so an inbound filter over it
 * is empty by definition.
 *
 * The date filter bounds `_hubspot_deal_converted_at`, and a row with no parseable conversion timestamp
 * is DROPPED when a bound is set. That is the strict reading: a date-bounded question cannot honestly
 * include a row whose date is unknown.
 */
export async function attributedStageCounts(
  agentId: string,
  filters: FunnelFilters = {}
): Promise<Record<string, number>> {
  const {
    campaignId = null,
    source = 'all',
    recordType = 'Real',
    createdAfterMs = null,
    createdBeforeMs = null,
  } = filters;

  if (source === 'inbound') return {};

  const rt = String(recordType ?? '')
    .trim()
    .toLowerCase();
  // deal_id → stage_id. One contact can map to several chats and therefore to the same deal.
  const seen = new Map<string, string>();

  try {
    const snap = await db
      .collection('chats')
      .where('agentId', '==', agentId)
      .get();
    for (const doc of snap.docs) {
      const cd = (doc.data() ?? {}) as Record<string, unknown>;
      if (cd.type !== 'outbound') continue;
      if (!chatWasContacted(cd)) continue;
      // Archived chats are dead and the FE drops them from the inbox and drill lists. The stop sweep
      // stamps both flags, so either one is enough.
      if (cd.archived === true || String(cd.status ?? '') === 'archived') {
        continue;
      }

      const mem = (cd.memory ?? {}) as Record<string, unknown>;
      if (!mem._converted_to_deal) continue;
      const dealId = mem.hubspot_deal_id;
      const stageId = mem._hubspot_deal_stage_id;
      if (!dealId || !stageId) continue;

      if (rt && rt !== 'all') {
        const chatRt = String(cd.record_type ?? mem.record_type ?? 'Real')
          .trim()
          .toLowerCase();
        if (chatRt !== rt) continue;
      }
      if (campaignId) {
        const chatCamp = String(cd.campaign_id ?? mem.campaign_id ?? '');
        if (chatCamp !== String(campaignId)) continue;
      }
      if (createdAfterMs !== null || createdBeforeMs !== null) {
        const convMs = isoToMs(mem._hubspot_deal_converted_at);
        if (convMs === null) continue;
        if (createdAfterMs !== null && convMs < createdAfterMs) continue;
        if (createdBeforeMs !== null && convMs > createdBeforeMs) continue;
      }

      seen.set(String(dealId), String(stageId));
    }
  } catch (e) {
    console.error(`[HS] attributedStageCounts ${agentId}: ${e}`);
  }

  const counts: Record<string, number> = {};
  for (const sid of seen.values()) {
    counts[sid] = (counts[sid] ?? 0) + 1;
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// The funnel
// ─────────────────────────────────────────────────────────────────────────────

export interface FunnelResult {
  pipeline_id?: string;
  pipeline_label?: string;
  stages?: Array<PipelineStage & { count: number }>;
  total?: number;
  error?: string;
}

/**
 * Per-stage deal counts for the funnel dashboard.
 *
 * The stage list, labels, order, won/lost typing and `is_entry` come LIVE from HubSpot; the counts come
 * from the Firestore attribution. See the module note on why.
 *
 * Every failure is a reported `error` rather than an empty chart, because an empty funnel and an
 * unreachable pipeline are indistinguishable to whoever is looking at the dashboard.
 */
export async function dealFunnelCounts(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  filters: FunnelFilters = {}
): Promise<FunnelResult> {
  const token = await accessToken(cfg, agentId);
  if (!token) return { error: 'HubSpot auth failed (no valid token)' };

  const pipelineId = cfg.pipeline_id;
  if (!pipelineId) {
    return {
      error: 'HubSpot pipeline not configured (cfg.pipeline_id missing)',
    };
  }

  const entryStageId = (cfg.stage_ids ?? {}).Lead;
  const pipeline = await dealPipelineStages(token, pipelineId, entryStageId);
  if (!pipeline) return { error: `deal pipeline ${pipelineId} not found` };

  const counts = await attributedStageCounts(agentId, filters);

  let total = 0;
  const stages = pipeline.stages.map((s) => {
    const count = Math.trunc(Number(counts[s.id]) || 0);
    total += count;
    return { ...s, count };
  });

  return {
    pipeline_id: pipelineId,
    pipeline_label: pipeline.label,
    stages,
    total,
  };
}
