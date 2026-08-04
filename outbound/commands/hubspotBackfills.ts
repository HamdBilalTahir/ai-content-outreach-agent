/**
 * The two HubSpot property backfills — the port of `backfill_deal_campaign` and
 * `backfill_aaai_area_code`.
 *
 * Both write to a customer's live CRM, so both are narrower than they look. See the module note in
 * `optoutBackfills.ts` on why the Django command wrapper is not ported.
 *
 * ## Each one writes exactly ONE property, and nothing else
 *
 * Every batch-update input is `{id, properties: {<the one property>}}`. That is not a stylistic
 * preference: a batch update replaces the properties it is given, so including a field that was read
 * slightly stale would overwrite a rep's edit made in the meantime. Reads are read-only, and `dryRun`
 * writes nothing at all — including not creating the property.
 *
 * ## The area-code backfill pages by SEEK, not by offset
 *
 * HubSpot's search API caps `after` at 10,000 results, so an offset walk silently truncates an audience
 * larger than that — and reports success. Sorting by `hs_object_id` ascending and filtering
 * `hs_object_id > lastId` has no cap and covers every record. The last id is returned so a run killed
 * partway through can resume exactly where it stopped rather than starting over.
 */

import { getAgentActions } from '../firebase/agent';
import {
  HUBSPOT_BASE,
  accessToken,
  hsHeaders,
  resolveHubspotConfig,
} from '../services/hubspot';
import {
  AAAI_AREA_CODE_PROP,
  CAMPAIGN_PROP,
  batchReadContacts,
  batchUpdateContacts,
  ensureContactProperty,
} from '../services/hubspotAudiences';
import {
  DEAL_CAMPAIGN_PROP,
  ensureDealProperty,
} from '../services/hubspotDeals';
import { areaCodeOf } from '../services/dncAreaCodes';
import { assocObjectIds } from '../services/dealAnalytics';
import type { HubspotConfig } from '../services/hubspot';

const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_PAGE = 100;

/** Resolve an agent's HubSpot config and token, or `null` with the reason logged. */
async function resolveAuth(
  agentId: string
): Promise<{ cfg: Partial<HubspotConfig>; token: string } | null> {
  const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
  if (!cfg.refresh_token && !cfg.access_token) {
    console.error('HubSpot v2 not connected for this agent — aborting');
    return null;
  }
  const token = await accessToken(cfg, agentId);
  if (!token) {
    console.error('could not resolve a HubSpot token — aborting');
    return null;
  }
  return { cfg, token };
}

// ─────────────────────────────────────────────────────────────────────────────
// backfill_deal_campaign
// ─────────────────────────────────────────────────────────────────────────────

export interface DealCampaignOptions {
  agentId: string;
  dryRun?: boolean;
}

export interface DealCampaignResult {
  scanned: number;
  patched: number;
  skipped: number;
  dry_run: boolean;
  aborted?: string;
}

/** The first associated contact's campaign id for a deal, or `null`. */
async function dealContactCampaign(
  token: string,
  dealId: string
): Promise<string | null> {
  const ids = await assocObjectIds(token, 'deals', dealId, 'contacts', 10);
  if (ids.length === 0) return null;
  for (const c of await batchReadContacts(token, ids, [CAMPAIGN_PROP])) {
    const cid = ((c.properties ?? {}) as Record<string, unknown>)[
      CAMPAIGN_PROP
    ];
    if (cid) return String(cid);
  }
  return null;
}

/**
 * Stamp `ava_campaign_id` on deals that predate deal-level campaign stamping.
 *
 * Those deals carry the campaign only on the associated CONTACT, as `ava_last_campaign_id`, so the funnel
 * cannot filter by campaign with one native Deal Search. This copies it down.
 *
 * Entirely HubSpot-side — no Firestore involved. The search filters on `NOT_HAS_PROPERTY`, which is what
 * makes the run idempotent: an already-stamped deal is not returned at all, so a re-run costs one empty
 * search. A deal whose contact has no campaign is skipped rather than stamped blank, because an empty
 * string in HubSpot means "clear this property" and would be indistinguishable from a real value later.
 */
export async function backfillDealCampaign(
  options: DealCampaignOptions
): Promise<DealCampaignResult> {
  const { agentId, dryRun = false } = options;
  const result: DealCampaignResult = {
    scanned: 0,
    patched: 0,
    skipped: 0,
    dry_run: dryRun,
  };

  const auth = await resolveAuth(agentId);
  if (!auth) return { ...result, aborted: 'no_hubspot_auth' };
  const { cfg, token } = auth;

  const pipelineId = cfg.pipeline_id;
  if (!pipelineId) {
    console.error('cfg.pipeline_id missing — aborting');
    return { ...result, aborted: 'no_pipeline' };
  }

  await ensureDealProperty(
    token,
    DEAL_CAMPAIGN_PROP,
    'Ava campaign',
    'string',
    'text'
  );

  let after: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
            {
              propertyName: DEAL_CAMPAIGN_PROP,
              operator: 'NOT_HAS_PROPERTY',
            },
          ],
        },
      ],
      properties: ['dealname'],
      limit: SEARCH_PAGE,
    };
    if (after) body.after = after;

    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.error(
        `deal search ${resp.status}: ${(await resp.text()).slice(0, 200)} — aborting`
      );
      return { ...result, aborted: 'search_failed' };
    }
    const data = ((await resp.json()) ?? {}) as Record<string, unknown>;

    for (const d of (data.results ?? []) as Array<Record<string, unknown>>) {
      result.scanned += 1;
      const dealId = String(d.id ?? '');
      const campaignId = await dealContactCampaign(token, dealId);
      if (!campaignId) {
        result.skipped += 1;
        console.log(`deal ${dealId}: no contact campaign — skip`);
        continue;
      }
      if (dryRun) {
        console.log(`[dry] deal ${dealId} <- ava_campaign_id=${campaignId}`);
        result.patched += 1;
        continue;
      }
      const pr = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}`, {
        method: 'PATCH',
        headers: hsHeaders(token),
        body: JSON.stringify({
          properties: { [DEAL_CAMPAIGN_PROP]: campaignId },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (pr.status === 200 || pr.status === 201) {
        result.patched += 1;
        console.log(`deal ${dealId} <- ava_campaign_id=${campaignId}`);
      } else {
        console.error(
          `deal ${dealId}: patch ${pr.status}: ${(await pr.text()).slice(0, 150)}`
        );
      }
    }

    after = (
      ((data.paging ?? {}) as Record<string, unknown>).next as
        | Record<string, unknown>
        | undefined
    )?.after as string | null;
    if (!after) break;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// backfill_aaai_area_code
// ─────────────────────────────────────────────────────────────────────────────

export interface AreaCodeOptions {
  agentId: string;
  /** Scopes the backfill. Defaults to the enrichment flag, as the source does. */
  filterProperty?: string;
  filterValue?: string;
  dryRun?: boolean;
  /** Stop after N contacts. `0` means all. */
  limit?: number;
  /** Resume from this `hs_object_id`, exclusive. */
  after?: string | null;
}

export interface AreaCodeResult {
  scanned: number;
  written: number;
  skipped_unchanged: number;
  /** Area code → count. The dry run's real output. */
  distribution: Record<string, number>;
  /** The cursor to resume from. Returned even on a clean finish. */
  last_id: string | null;
  dry_run: boolean;
  aborted?: string;
}

const BATCH_SIZE = 100;

/**
 * Stamp `aaai_area_code` on contacts from their OWN line — `phone`, falling back to `mobilephone`.
 *
 * The campaign audience preview filters on this property server-side (`aaai_area_code IN [...]`), so an
 * unpopulated contact is invisible to an area-code-scoped campaign. That is the failure this fixes, and it
 * is silent: the preview simply returns fewer people than it should.
 *
 * Idempotent by comparing against the stored value before queueing a write, so a re-run costs reads and
 * picks up newly-enriched contacts. `dryRun` reports the area-code distribution and creates nothing —
 * which is the point of running it first: the distribution tells you whether the phone data is good enough
 * for the filter to be worth using.
 */
export async function backfillAaaiAreaCode(
  options: AreaCodeOptions
): Promise<AreaCodeResult> {
  const {
    agentId,
    filterProperty = 'enriched_by_aaai_outbound',
    filterValue = 'true',
    dryRun = false,
    limit = 0,
  } = options;

  const result: AreaCodeResult = {
    scanned: 0,
    written: 0,
    skipped_unchanged: 0,
    distribution: {},
    last_id: options.after ?? null,
    dry_run: dryRun,
  };

  const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
  const token = await accessToken(cfg, agentId);
  if (!token) {
    console.error(
      "HubSpot auth failed (no token) — check the agent's HubSpot connection."
    );
    return { ...result, aborted: 'no_hubspot_auth' };
  }
  if (!dryRun) {
    const ok = await ensureContactProperty(
      token,
      AAAI_AREA_CODE_PROP,
      'AAAI Area Code',
      'string',
      'text'
    );
    if (!ok) {
      console.error(
        `Could not ensure property ${AAAI_AREA_CODE_PROP}; aborting.`
      );
      return { ...result, aborted: 'property_missing' };
    }
  }

  // The stored value is only read on a real run — a dry run has nothing to compare against and does not
  // want to imply the property exists.
  const props = [
    'phone',
    'mobilephone',
    ...(dryRun ? [] : [AAAI_AREA_CODE_PROP]),
  ];
  let pending: Array<{ id: string; properties: Record<string, unknown> }> = [];

  const flush = async (): Promise<void> => {
    if (dryRun || pending.length === 0) {
      pending = [];
      return;
    }
    const res = await batchUpdateContacts(token, pending);
    if (res.error) {
      console.error(
        `batch update failed near id=${result.last_id}: ${res.error}`
      );
    }
    result.written += res.updated;
    pending = [];
  };

  for (;;) {
    const filters: Array<Record<string, unknown>> = [
      { propertyName: filterProperty, operator: 'EQ', value: filterValue },
    ];
    // SEEK pagination — see the module note on the 10,000-result `after` cap.
    if (result.last_id) {
      filters.push({
        propertyName: 'hs_object_id',
        operator: 'GT',
        value: String(result.last_id),
      });
    }

    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: props,
        limit: SEARCH_PAGE,
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status !== 200) {
      console.error(
        `search ${resp.status} near id=${result.last_id}: ${(await resp.text()).slice(0, 200)}`
      );
      break;
    }
    const results = ((((await resp.json()) ?? {}) as Record<string, unknown>)
      .results ?? []) as Array<Record<string, unknown>>;
    if (results.length === 0) break;

    let hitLimit = false;
    for (const c of results) {
      result.scanned += 1;
      const p = (c.properties ?? {}) as Record<string, unknown>;
      const code = areaCodeOf(p.phone || p.mobilephone || '');
      const bucket = code || '(none)';
      result.distribution[bucket] = (result.distribution[bucket] ?? 0) + 1;

      if (!dryRun) {
        if (String(p[AAAI_AREA_CODE_PROP] ?? '') === String(code ?? '')) {
          result.skipped_unchanged += 1;
        } else {
          pending.push({
            id: String(c.id),
            properties: { [AAAI_AREA_CODE_PROP]: code },
          });
          if (pending.length >= BATCH_SIZE) await flush();
        }
      }

      result.last_id = (c.id as string) || result.last_id;
      if (limit && result.scanned >= limit) {
        hitLimit = true;
        break;
      }
    }

    if (hitLimit || results.length < SEARCH_PAGE) break;
  }
  await flush();

  return result;
}
