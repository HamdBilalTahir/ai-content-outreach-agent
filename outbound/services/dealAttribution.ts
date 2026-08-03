/**
 * Prospect → HubSpot-deal attribution — the scan that writes what the funnel reads.
 *
 * A prospect the agent engaged sometimes converts via ANOTHER rep: a deal is created or advanced on the
 * same contact but outside the agent flow, so a `lead_source`-filtered deal search misses it and the
 * funnel reads zero. This scans outbound chats by their stored `memory.hubspot_contact_id`, reads that
 * contact's associated deals of ANY origin, and writes the attribution back onto the chat.
 *
 * ## Bounded per call, resumable by cursor
 *
 * One id-ordered page of `limit` outbound chats, returning `next_cursor` — the last chat id — which the
 * caller re-invokes with until it comes back `null`. The caller is a Vercel cron capped at about five
 * minutes, so an unbounded sweep would be killed partway through with no way to resume. Everything here
 * is idempotent, which is what makes running it hourly safe.
 *
 * ## Two write paths, gated differently on purpose
 *
 * **Activities and the memory write-back are CHANGE-gated.** An activity is written on the first
 * attribution of a deal or when its stage moves, tracked in `memory._attributed_deals` as
 * `{dealId: stageId}` — otherwise every hourly run would add another "converted to deal" card to the
 * same chat.
 *
 * **The funnel-stage sync is STATE-gated, and runs on every scan.** It compares the chat's CURRENT
 * stage/sub_stage against the target the deal implies, rather than reacting to a deal-stage change. That
 * is what makes it self-healing: an already-attributed chat whose promotion was missed — deal sitting at
 * an intermediate stage while the chat still says `Contacted` — is corrected on the next scan instead of
 * waiting for the deal to move again. It no-ops once the two agree.
 *
 * Getting these two the same way round would break one of them: a change-gated sync could never heal,
 * and a state-gated activity writer would duplicate cards forever.
 *
 * ## The primary deal is the most-advanced one
 *
 * A contact can carry several deals. Chat memory reflects one — the highest pipeline `order`, tie-broken
 * by the latest stage-entry time. Activities are still written for every deal, so the history is
 * complete even though the summary fields name a single deal.
 *
 * ## A never-contacted chat is skipped entirely
 *
 * No write-back, no activity, no stage sync. A deal on that contact was a rep's own work, and attributing
 * it would be false attribution — see `chatWasContacted` in `dealAnalytics.ts`.
 */

import { db } from '../firebase/db';
import { setMemory } from '../firebase/chat';
import { getAgentActions } from '../firebase/agent';
import { setProspectStage, setProspectSubStage } from '../firebase/prospect';
import { accessToken, resolveHubspotConfig } from './hubspot';
import {
  chatWasContacted,
  dealPipelineStages,
  fetchContactDeals,
} from './dealAnalytics';
import type { PipelineStage, ScannedDeal } from './dealAnalytics';

/** Outbound chats scanned per call, so the caller's five-minute cap is never the thing that stops us. */
export const DEFAULT_SCAN_LIMIT = 100;
export const MAX_SCAN_LIMIT = 500;

/**
 * Contacted-but-pre-Lead stages an OPEN deal promotes out of.
 *
 * Deliberately NOT including `New`/absent: a never-contacted chat is gated out of attribution entirely
 * before this is consulted, so it can never be promoted by a rep's deal.
 */
const PRE_LEAD_STAGES = new Set(['Contacted', 'Engaged']);

/**
 * Stamped on every sync-driven stage change, so `stage_history` separates HubSpot-synced moves from
 * customer-interaction moves (`make_phone_call`, `incoming_sms`, `outbound_meeting_booked`, …).
 * Consumers filter on the prefix.
 */
export const HS_SYNC_TRIGGER_PREFIX = 'hubspot_stage_sync:';

type ChatData = Record<string, unknown>;

function slug(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/ /g, '_');
}

/** A HubSpot amount → number, or `null`. An unparseable amount is absent, not zero. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function randomToolUseId(): string {
  // 24 hex chars, matching the source's `uuid4().hex[:24]`.
  let out = '';
  while (out.length < 24) out += Math.random().toString(16).slice(2);
  return `tooluse_${out.slice(0, 24)}`;
}

function activitiesRef(chatId: string) {
  return db.collection('chats').doc(chatId).collection('activities');
}

/** The card the chat UI renders as "Prospect converted to deal at &lt;stage&gt;". */
async function writeConversionActivity(
  chatId: string,
  deal: ScannedDeal,
  stageLabel: string,
  pipelineLabel: string | undefined
): Promise<void> {
  const when = deal.stage_entered_at || deal.createdate || '';
  await activitiesRef(chatId)
    .doc()
    .set({
      timestamp: new Date(),
      kind: 'tool_call',
      toolCall: {
        toolUseId: randomToolUseId(),
        toolName: 'prospect_converted_to_deal',
        input: {
          stage: stageLabel,
          deal_id: deal.deal_id,
          pipeline: pipelineLabel,
          amount: num(deal.amount),
        },
        result: {
          status: 'success',
          message: `Prospect converted to deal at ${stageLabel} on ${when}`,
        },
        status: 'success',
      },
    });
}

/** The audit card for a sync-driven stage change — visible in the campaign inbox, clearly HubSpot-sourced. */
async function writeStageSyncActivity(
  chatId: string,
  fromStage: string | null,
  toStage: string,
  stageLabel: string
): Promise<void> {
  await activitiesRef(chatId)
    .doc()
    .set({
      timestamp: new Date(),
      kind: 'tool_call',
      toolCall: {
        toolUseId: randomToolUseId(),
        toolName: 'hubspot_stage_synced',
        input: {
          from_stage: fromStage || null,
          to_stage: toStage,
          hubspot_stage: stageLabel,
          source: 'hubspot_sync',
        },
        result: {
          status: 'success',
          message:
            `Stage synced ${fromStage || '(none)'} → ${toStage}: ` +
            `HubSpot deal stage found '${stageLabel}'`,
        },
        status: 'success',
      },
    });
}

export interface SyncOptions {
  dryRun?: boolean;
}

/**
 * Mirror the attributed deal's HubSpot stage onto the chat's funnel stage. Deterministic; no LLM.
 *
 *  - **open** (entry or intermediate) → `stage: Lead`, and `sub_stage` = the HubSpot stage, i.e. the
 *    *type* of Lead (`Lead · contract_sent`), advancing as the deal moves.
 *  - **won** → `CRM Won`. The Lead-lock in `setProspectStage` records this as `sub_stage: crm_won`.
 *  - **lost** → `Lost`, carrying the HubSpot stage as the reason.
 *
 * State-gated and therefore self-healing — see the module note. Returns a `[from, to]` descriptor when
 * something was applied, else `null`.
 *
 * Every stage call is individually wrapped: a rejected transition (forward-only, the Lead-lock) must not
 * abort the scan of the remaining chats.
 */
export async function syncStageFromDeal(
  chatId: string,
  chatData: ChatData,
  stageLabel: string,
  stageTypeValue: string | undefined,
  options: SyncOptions = {}
): Promise<[string | null, string] | null> {
  const { dryRun = false } = options;
  const t = String(stageTypeValue ?? '')
    .trim()
    .toLowerCase();
  const mem = (chatData.memory ?? {}) as Record<string, unknown>;
  const currentStage = (chatData.stage as string) ?? null;
  const currentSub = slug(chatData.sub_stage ?? mem.sub_stage ?? '');
  const dealersId = String(
    chatData.dealers_id ?? chatData.dealer_id ?? mem.dealers_id ?? ''
  );
  const companyId = String(chatData.company_id ?? mem.company_id ?? '');
  const trigger = `${HS_SYNC_TRIGGER_PREFIX}${stageLabel}`;

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (dryRun) return;
    try {
      await fn();
    } catch (e) {
      console.warn(`[DEAL_ATTR] stage sync call failed chat=${chatId}: ${e}`);
    }
  };

  let applied: [string | null, string] | null = null;

  if (t === 'won') {
    // Lead-locked, so a won deal shows up as sub_stage `crm_won`. Gate on THAT, not on the stage name.
    if (currentSub !== 'crm_won') {
      await run(() =>
        setProspectStage(chatId, 'CRM Won', trigger, dealersId, companyId)
      );
      applied = [currentStage, 'CRM Won'];
    }
  } else if (t === 'lost') {
    if (currentStage !== 'Lost' && currentSub !== 'lost') {
      await run(() =>
        setProspectStage(
          chatId,
          'Lost',
          trigger,
          dealersId,
          companyId,
          `hubspot_closed_lost:${stageLabel}`
        )
      );
      applied = [currentStage, 'Lost'];
    }
  } else {
    // An open deal means the prospect IS a Lead, and its "type" is the current HubSpot stage.
    const targetSub = slug(stageLabel);
    let changed = false;
    if (currentStage !== null && PRE_LEAD_STAGES.has(currentStage)) {
      await run(() =>
        setProspectStage(chatId, 'Lead', trigger, dealersId, companyId)
      );
      changed = true;
    }
    if (currentSub !== targetSub) {
      // The sub-stage setter takes no dealer/company arguments in this port — see the recorded
      // divergence on the dealer-analytics subsystem (Phase 1).
      await run(() => setProspectSubStage(chatId, stageLabel, trigger));
      changed = true;
    }
    if (changed) applied = [currentStage, `Lead · ${stageLabel}`];
  }

  if (applied && !dryRun) {
    try {
      await writeStageSyncActivity(chatId, applied[0], applied[1], stageLabel);
    } catch (e) {
      console.warn(
        `[DEAL_ATTR] stage-sync activity failed chat=${chatId}: ${e}`
      );
    }
  }
  return applied;
}

export interface StageMeta {
  pipeline_label?: string;
  stages: Record<string, PipelineStage>;
}

export interface AgentContext {
  token: string;
  stageIds: string[];
  stageMeta: StageMeta;
}

/**
 * The HubSpot context for one agent, or `null` when it has none usable.
 *
 * Cached per scan call by the orchestrator, because otherwise a page of a hundred chats belonging to the
 * same agent would refresh the same OAuth token a hundred times.
 */
export async function resolveAgentContext(
  agentId: string
): Promise<AgentContext | null> {
  const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
  if (!cfg.refresh_token && !cfg.access_token) return null;
  const token = await accessToken(cfg, agentId);
  if (!token) return null;
  const pipelineId = cfg.pipeline_id;
  if (!pipelineId) return null;
  const entry = (cfg.stage_ids ?? {}).Lead;
  const pdef = await dealPipelineStages(token, pipelineId, entry);
  if (!pdef) return null;

  const stages: Record<string, PipelineStage> = {};
  for (const s of pdef.stages) stages[s.id] = s;
  return {
    token,
    stageIds: Object.keys(stages),
    stageMeta: { pipeline_label: pdef.label, stages },
  };
}

export interface AttributeResult {
  activities: number;
  memoryUpdated: boolean;
  stageSynced: [string | null, string] | null;
}

/**
 * Attribute one chat's deals, idempotently.
 *
 * `record_type` is never touched — `setMemory` writes only the keys it is given, which is what keeps a
 * Test record from being silently reclassified by an analytics scan.
 */
export async function attributeChatDeals(
  chatId: string,
  chatData: ChatData,
  deals: readonly ScannedDeal[],
  stageMeta: StageMeta,
  options: SyncOptions = {}
): Promise<AttributeResult> {
  const { dryRun = false } = options;
  const none: AttributeResult = {
    activities: 0,
    memoryUpdated: false,
    stageSynced: null,
  };
  if (!chatWasContacted(chatData)) return none;

  const mem = (chatData.memory ?? {}) as Record<string, unknown>;
  // {dealId: stageId} already carded. This is what keeps an hourly scan from re-carding the same deal.
  const logged = {
    ...((mem._attributed_deals ?? {}) as Record<string, string>),
  };
  const { stages } = stageMeta;
  const pipelineLabel = stageMeta.pipeline_label;

  const valid = (deals ?? []).filter((d) => d.deal_id && d.dealstage);
  const newLogged = { ...logged };
  let activities = 0;

  for (const d of valid) {
    const did = d.deal_id;
    const sid = d.dealstage as string;
    if (logged[did] === sid) continue;
    const label = stages[sid]?.label || sid;
    if (!dryRun) {
      try {
        await writeConversionActivity(chatId, d, label, pipelineLabel);
      } catch (e) {
        console.warn(
          `[DEAL_ATTR] activity write failed chat=${chatId} deal=${did}: ${e}`
        );
        // NOT recorded as logged — an unwritten card must be retried next scan.
        continue;
      }
    }
    newLogged[did] = sid;
    activities += 1;
  }

  let memoryUpdated = false;
  let stageSynced: [string | null, string] | null = null;

  if (valid.length > 0) {
    // The most-advanced deal, tie-broken by the latest stage entry. An unknown stage ranks -1, so a
    // deal in another pipeline never outranks one in ours.
    const rank = (d: ScannedDeal): [number, string] => [
      stages[d.dealstage as string]?.order ?? -1,
      String(d.stage_entered_at ?? ''),
    ];
    const primary = valid.reduce((best, d) => {
      const [ro, rs] = rank(d);
      const [bo, bs] = rank(best);
      return ro > bo || (ro === bo && rs > bs) ? d : best;
    });

    const psid = primary.dealstage as string;
    const psm = stages[psid];
    const plabel = psm?.label || psid;
    const changed =
      mem._hubspot_deal_stage_id !== psid ||
      mem.hubspot_deal_id !== primary.deal_id ||
      !mem._converted_to_deal;

    if (activities > 0 || changed) {
      if (!dryRun) {
        await setMemory(chatId, {
          hubspot_deal_id: primary.deal_id,
          hubspot_deal_stage: plabel,
          _hubspot_deal_stage_id: psid,
          hubspot_deal_pipeline: pipelineLabel || primary.pipeline,
          _converted_to_deal: true,
          _hubspot_deal_converted_at:
            primary.stage_entered_at || primary.createdate,
          _attributed_deals: newLogged,
        });
      }
      memoryUpdated = true;
    }

    // Runs on EVERY scan and self-gates — see the module note on why this is state-gated while the two
    // writes above are change-gated.
    stageSynced = await syncStageFromDeal(chatId, chatData, plabel, psm?.type, {
      dryRun,
    });
  }

  return { activities, memoryUpdated, stageSynced };
}

export interface ScanOptions {
  agentId?: string | null;
  campaignId?: string | null;
  cursor?: string | null;
  limit?: unknown;
  /** Process just this chat — a manual re-scan or a verification. No pagination. */
  onlyChatId?: string | null;
  dryRun?: boolean;
}

export interface ScanResult {
  success: boolean;
  scanned: number;
  attributed: number;
  updated: number;
  stage_synced: number;
  /** The last chat id of a FULL page. `null` means the sweep is done. */
  next_cursor: string | null;
}

/**
 * One bounded page of the conversion scan.
 *
 * The filters are applied in cost order — cheap local checks before any HubSpot call — so a page of
 * chats that mostly do not qualify costs almost nothing. In particular `chatWasContacted` and the
 * missing-contact-id check run before the deal fetch.
 *
 * `next_cursor` is non-null only when the page came back FULL. A short page means the collection is
 * exhausted, which is what lets the caller stop rather than probing one more empty page.
 */
export async function runDealAttribution(
  options: ScanOptions = {}
): Promise<ScanResult> {
  const {
    agentId = null,
    campaignId = null,
    cursor = null,
    onlyChatId = null,
    dryRun = false,
  } = options;

  // Clamped, not trusted: an unbounded `limit` from a caller is how the five-minute cap gets hit.
  let lim = DEFAULT_SCAN_LIMIT;
  const rawLimit = Number(options.limit);
  if (options.limit && Number.isFinite(rawLimit)) {
    lim = Math.max(1, Math.min(Math.trunc(rawLimit), MAX_SCAN_LIMIT));
  }

  let docs: Array<{
    id: string;
    data: () => Record<string, unknown> | undefined;
  }>;
  if (onlyChatId) {
    const snap = await db.collection('chats').doc(onlyChatId).get();
    docs = snap.exists ? [snap] : [];
  } else {
    let q = db
      .collection('chats')
      .where('type', '==', 'outbound')
      .orderBy('__name__')
      .limit(lim);
    if (cursor) q = q.startAfter(String(cursor));
    docs = (await q.get()).docs;
  }

  // agentId → context | null. Cached per call, so one page does not refresh one token per chat.
  const agentCtx = new Map<string, AgentContext | null>();
  let scanned = 0;
  let attributed = 0;
  let updated = 0;
  let stageSynced = 0;

  for (const doc of docs) {
    scanned += 1;
    const cd = (doc.data() ?? {}) as ChatData;
    if (cd.type !== 'outbound') continue;
    // Before the HubSpot fetch: a never-contacted chat is not our attribution.
    if (!chatWasContacted(cd)) continue;

    const mem = (cd.memory ?? {}) as Record<string, unknown>;
    const contactId = mem.hubspot_contact_id;
    if (!contactId) continue;

    const aid = String(cd.agentId ?? mem.agent_id ?? '');
    if (!aid || (agentId && aid !== agentId)) continue;
    if (
      campaignId &&
      String(cd.campaign_id ?? mem.campaign_id ?? '') !== String(campaignId)
    ) {
      continue;
    }

    if (!agentCtx.has(aid)) {
      try {
        agentCtx.set(aid, await resolveAgentContext(aid));
      } catch (e) {
        console.warn(`[DEAL_ATTR] agent ctx failed ${aid}: ${e}`);
        agentCtx.set(aid, null);
      }
    }
    const ctx = agentCtx.get(aid);
    if (!ctx) continue;

    let deals: ScannedDeal[];
    try {
      deals = await fetchContactDeals(
        ctx.token,
        String(contactId),
        ctx.stageIds
      );
    } catch (e) {
      console.warn(
        `[DEAL_ATTR] fetch deals failed chat=${doc.id} contact=${contactId}: ${e}`
      );
      continue;
    }
    if (deals.length === 0) continue;

    attributed += 1;
    try {
      const result = await attributeChatDeals(
        doc.id,
        cd,
        deals,
        ctx.stageMeta,
        { dryRun }
      );
      if (result.memoryUpdated) updated += 1;
      if (result.stageSynced) stageSynced += 1;
    } catch (e) {
      console.warn(`[DEAL_ATTR] attribute failed chat=${doc.id}: ${e}`);
    }
  }

  return {
    success: true,
    scanned,
    attributed,
    updated,
    stage_synced: stageSynced,
    next_cursor:
      !onlyChatId && docs.length >= lim ? docs[docs.length - 1].id : null,
  };
}
