/**
 * The campaign endpoints and the manual chat pause/resume endpoints — the port of `views/campaigns.py`.
 *
 * The FE fires ONE call to start a campaign and then polls status; all enrollment and pacing happens in
 * the backend (`services/campaigns.ts`). No batching or scheduling lives on the client, which is why
 * these views are thin: create validates the audience descriptor and returns an id, and everything else
 * is a status read or a lifecycle flip.
 *
 * ## The audience descriptor is validated here and nowhere else
 *
 * `validateAudience` is the only gate between an FE payload and a campaign that will enroll thousands of
 * contacts, so it is strict about the three source types and their required picker. It also **normalizes
 * `area_codes` in place** — an area-code selection that reaches enrollment unvalidated is how an
 * unscrubbed audience gets dialled, so an invalid code is a 400 rather than something to drop quietly.
 *
 * ## `include_contact_ids` is authoritative and self-sufficient
 *
 * An explicit id array enrolls exactly those ids regardless of the picker, so it satisfies the per-type
 * "picker required" check. That is what lets the FE preview a list, let the user deselect rows, and fire
 * the campaign with the survivors — without also having to re-send a `list_id` that no longer describes
 * the audience.
 *
 * ## Lifecycle actions never return an unparseable error
 *
 * `doAction` is shared by the detail POST and the three sub-routes, and every path through it returns
 * JSON: 400 for a bad action or a missing id, 404 for a campaign that is not there, 500 with an `error`
 * key for a backend fault. The source calls this out in its own docstring — an unhandled HTML 500 is a
 * failure the FE cannot show the user.
 */

import {
  addRecords,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  stopCampaign,
} from '../services/campaigns';
import {
  pauseChat,
  pauseChats,
  resumeChat,
  resumeChats,
} from '../services/chatPause';
import { splitValid } from '../services/dncAreaCodes';
import { json } from './types';
import type { OutboundRequest, OutboundResponse } from './types';
import type { CampaignDoc } from '../types';

const AUDIENCE_TYPES = ['csv', 'hubspot_list', 'hubspot_search'] as const;

type Audience = Record<string, unknown>;

/**
 * `[ok, error]` for an audience descriptor, normalizing `area_codes` in place.
 *
 * Emptiness, not presence, decides each per-type check: the source tests `audience.get("contacts") or
 * []` and `bool(audience.get("include_contact_ids"))`, so an empty array is treated as no selection at
 * all. That is the right reading — a `contacts: []` csv campaign has nobody to enroll.
 */
export function validateAudience(audience: unknown): [boolean, string | null] {
  if (!audience || typeof audience !== 'object' || Array.isArray(audience)) {
    return [false, 'audience object is required'];
  }
  const a = audience as Audience;
  const atype = a.type as string;
  if (!AUDIENCE_TYPES.includes(atype as (typeof AUDIENCE_TYPES)[number])) {
    return [
      false,
      `audience.type must be one of ${JSON.stringify(AUDIENCE_TYPES)}`,
    ];
  }

  // See the module note: an explicit id array satisfies every per-type picker requirement.
  const hasInclude = Array.isArray(a.include_contact_ids)
    ? a.include_contact_ids.length > 0
    : Boolean(a.include_contact_ids);

  if (atype === 'csv' && !hasInclude) {
    const contacts = a.contacts;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return [false, 'audience.contacts is required for a csv campaign'];
    }
  }
  if (atype === 'hubspot_list' && !hasInclude && !a.list_id) {
    return [false, 'audience.list_id is required for a hubspot_list campaign'];
  }
  if (
    atype === 'hubspot_search' &&
    !hasInclude &&
    !a.filterGroups &&
    !a.filter_groups &&
    !a.filters
  ) {
    return [
      false,
      'audience.filterGroups (or filters) is required for a hubspot_search campaign',
    ];
  }

  // ANY invalid code rejects the whole request rather than being dropped. An area-code selection is a
  // DNC-scrubbability claim, and silently enrolling the codes that happened to parse would dial the
  // rest unscrubbed — the exact thing the selection exists to prevent.
  const rawCodes = a.area_codes;
  if (rawCodes) {
    const [valid, invalid] = splitValid(
      Array.isArray(rawCodes) ? rawCodes : [rawCodes]
    );
    if (invalid.length > 0) {
      return [
        false,
        `invalid area_codes (must be 3-digit NANP, first digit 2-9): ${JSON.stringify(invalid)}`,
      ];
    }
    a.area_codes = valid;
  }
  return [true, null];
}

/**
 * Fold top-level id selections into the audience.
 *
 * The FE sends these either place, and the audience is what the enrollment engine reads. An audience
 * that already carries the key wins, so a caller who set both is not silently overridden by the
 * shorthand.
 */
function foldIdSelections(body: Record<string, unknown>, audience: Audience) {
  for (const key of ['exclude_contact_ids', 'include_contact_ids']) {
    const top = body[key];
    const inAudience = audience[key];
    const topSet = Array.isArray(top) ? top.length > 0 : Boolean(top);
    const audienceSet = Array.isArray(inAudience)
      ? inAudience.length > 0
      : Boolean(inAudience);
    if (topSet && !audienceSet) audience[key] = top;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST|GET /campaigns/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fire a campaign. Returns **201** with the new id, in status `enrolling`.
 *
 * The 201 is the source's, and it matters to the FE: it distinguishes "the campaign now exists and the
 * worker will enroll it" from a 200 that could just as well be a status read.
 */
export async function createCampaignView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const agentId = body.agent_id;
  if (!agentId) return json({ error: 'agent_id is required' }, 400);

  const audience: Audience = { ...((body.audience as Audience) ?? {}) };
  const [ok, err] = validateAudience(audience);
  if (!ok) return json({ error: err }, 400);
  foldIdSelections(body, audience);

  // `bool(data.get(k, default))` in the source: the DEFAULT fires only on an absent key, and whatever
  // is present is then coerced. Both halves are done here because both belong to the request — a
  // `null` from the FE means "off", not "unset", and the service's own coercion is looser than that.
  const excludeContacted =
    body.exclude_contacted === undefined
      ? true
      : Boolean(body.exclude_contacted);

  const campaignId = await createCampaign({
    name: body.name as string,
    agentId: String(agentId),
    recordType: body.record_type as string,
    perDay: body.per_day as number,
    audience,
    excludeContacted,
    businessOnly: Boolean(body.business_only),
  });
  return json({ campaign_id: campaignId, status: 'enrolling' }, 201);
}

/** List campaigns, optionally narrowed to one agent. */
export async function listCampaignsView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  return json({ campaigns: await listCampaigns(request.query.agent_id) });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET|POST /campaigns/{campaign_id}/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Campaign status: the projection the FE's progress bar reads.
 *
 * `remaining` is `null` — not `0` — until `total` is a known integer. The enrollment worker counts the
 * audience asynchronously and leaves `total: null` until it has, and reporting `0 remaining` for
 * "not counted yet" would render a campaign that has barely started as finished.
 */
export async function campaignDetailView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const campaign = await getCampaign(request.params.campaign_id);
  if (!campaign) return json({ error: 'campaign not found' }, 404);

  const c = campaign as CampaignDoc & Record<string, unknown>;
  const enrolled = Math.trunc(Number(c.enrolled_count) || 0);
  const total = c.total;
  return json({
    id: c.id,
    name: c.name,
    status: c.status,
    per_day: c.per_day,
    record_type: c.record_type,
    enrolled_count: enrolled,
    total,
    remaining:
      typeof total === 'number' && Number.isInteger(total)
        ? Math.max(0, total - enrolled)
        : null,
    business_only: Boolean(c.business_only),
    created_at: c.created_at,
  });
}

const ACTIONS: Record<
  string,
  (campaignId: string) => Promise<CampaignDoc | null>
> = {
  pause: pauseCampaign,
  resume: resumeCampaign,
  stop: stopCampaign,
};

/** The shared pause/resume/stop handler. Every path returns JSON — see the module note. */
async function doAction(
  campaignId: string,
  action: unknown
): Promise<OutboundResponse> {
  const fn = ACTIONS[String(action ?? '')];
  if (!fn) {
    return json({ error: "action must be 'pause', 'resume', or 'stop'" }, 400);
  }
  if (!campaignId) return json({ error: 'campaign_id is required' }, 400);

  let updated: CampaignDoc | null;
  try {
    updated = await fn(campaignId);
  } catch (e) {
    console.error(`[OB CAMPAIGN] ${action} failed for ${campaignId}: ${e}`);
    return json({ error: `failed to ${action} campaign: ${e}` }, 500);
  }
  if (!updated) return json({ error: 'campaign not found' }, 404);
  return json({ id: campaignId, status: updated.status });
}

/** POST /campaigns/{id}/ — `{action: pause|resume|stop}`. */
export async function campaignActionView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  return doAction(request.params.campaign_id, request.body.action);
}

/** POST /campaigns/{id}/pause/ — pause enrollment AND this campaign's queued outreach. */
export async function campaignPauseView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  return doAction(request.params.campaign_id, 'pause');
}

/** POST /campaigns/{id}/resume/ */
export async function campaignResumeView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  return doAction(request.params.campaign_id, 'resume');
}

/** POST /campaigns/{id}/stop/ — TERMINAL: status `stopped`, then archive the non-engaged chats. */
export async function campaignStopView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  return doAction(request.params.campaign_id, 'stop');
}

/**
 * POST /campaigns/{id}/add-records/ — append records to a live campaign as a new enrollment batch.
 *
 * The failure is a **400, not a 404**, even for "campaign not found": `addRecords` also refuses a
 * paused or stopped campaign, and the source funnels every one of its refusals through the same 400.
 * Preserved — the FE reads the `error` string, and reclassifying by message would be guesswork.
 */
export async function campaignAddRecordsView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const audience: Audience = { ...((body.audience as Audience) ?? {}) };
  const [ok, err] = validateAudience(audience);
  if (!ok) return json({ error: err }, 400);
  foldIdSelections(body, audience);

  const result = await addRecords(request.params.campaign_id, audience);
  if (!result.ok) {
    return json({ error: result.error ?? 'add_records failed' }, 400);
  }
  return json(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat pause / resume — manual, single and bulk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /chats/{chat_id}/pause/ — pause ONE chat.
 *
 * `paused: false` is a normal 200, not an error. The service refuses an already-paused or ARCHIVED
 * chat, and archive is terminal — pausing it would imply it could be resumed.
 */
export async function chatPauseView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const chatId = request.params.chat_id;
  const by = (request.body.by as string) || 'manual';
  return json({
    chat_id: chatId,
    paused: Boolean(await pauseChat(chatId, by)),
  });
}

/** POST /chats/{chat_id}/resume/ — resume ONE chat and reschedule its overdue tasks. */
export async function chatResumeView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const chatId = request.params.chat_id;
  return json({ chat_id: chatId, ...(await resumeChat(chatId)) });
}

/** The bulk guard: a non-array or empty `chat_ids` is a 400, so an empty selection cannot look like a success. */
function bulkIds(request: OutboundRequest): string[] | null {
  const ids = request.body.chat_ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return ids.map((x) => String(x));
}

/** POST /chats/pause/ — bulk. Defaults `by` to `'bulk'`, which is how the audit trail distinguishes them. */
export async function chatsPauseView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const ids = bulkIds(request);
  if (!ids)
    return json({ error: 'chat_ids (non-empty array) is required' }, 400);
  const by = (request.body.by as string) || 'bulk';
  return json(await pauseChats(ids, by));
}

/** POST /chats/resume/ — bulk, summing the tasks rescheduled across every chat. */
export async function chatsResumeView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const ids = bulkIds(request);
  if (!ids)
    return json({ error: 'chat_ids (non-empty array) is required' }, 400);
  return json(await resumeChats(ids));
}
