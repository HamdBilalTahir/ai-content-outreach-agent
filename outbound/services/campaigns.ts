/**
 * The outbound campaign engine — the backend owns everything after the front end fires once.
 *
 * Flow: one `createCampaign` call carries the chosen audience and a pace (`per_day`). The campaign is
 * stored in status `enrolling`; the cron then calls `enrollCampaignBatch` each tick, which pages the
 * audience and enrolls contacts with a **staggered `execute_at`**. The cron's own per-tick cap drains
 * the resulting queue.
 *
 * ## The status machine
 *
 *     enrolling ──(source exhausted)──▶ running
 *         │                               │
 *         ├──(pause)──▶ paused ──(resume)─┤
 *         │                               │
 *         └──(stop)──▶ stopped (terminal, archive sweep)
 *
 * `paused` and `stopped` are cascaded onto the campaign's chats by **bounded, cursor-driven cron
 * sweeps** rather than in one write. A campaign can hold tens of thousands of chats, so every sweep
 * pages at 200 and advances a cursor — `_pause_cursor`, `_resume_cursor`, `_archive_cursor`,
 * `_stalled_cursor`. That is why each has a matching `_*_done` flag: the cron needs to know whether to
 * keep advancing it.
 *
 * ## Two pacing bases, not one
 *
 * Phone-lane and email-lane contacts are paced differently, and conflating them was the bug the
 * separate `email_paced_count` exists to prevent. Phone contacts fire TODAY inside business hours —
 * voice concurrency is the only throttle — so they must NOT consume an email `per_day` slot. Email
 * contacts get the day-bucketed stagger keyed on their own base.
 *
 * ## `enrolled_count` counts chats, not rows
 *
 * It reflects ACTUAL enrollments. Counting the raw page size let skipped records (invalid address,
 * area-code filtered, cross-campaign dedup) inflate it until it drifted above the real chat count. The
 * cursor still advances by the whole page, so the source drains either way.
 *
 * ## Deferred: the HubSpot audience sources
 *
 * `resolveAudiencePage` supports the `csv` source now. `hubspot_list`, `hubspot_search`, and the
 * `include_contact_ids` allow-list need the HubSpot contact-fetch layer and arrive with that phase —
 * they are one function's worth of surface. Everything else here (the status machine, pacing, cursors,
 * batching, the lane split, enrollment verification, the area-code gate, the stats breakdown) is
 * complete and works against a CSV audience today. `archiveCampaignBatch`'s per-contact campaign-END
 * stamp is deferred with them.
 */

import { db } from '../firebase/db';
import { businessHoursSlot } from './businessHours';
import { enrollContact, resolveLocation, type Lead } from './enroll';
import { nextBusinessHoursStart } from './scheduling';
import {
  effectiveAllowed,
  getAllowedAreaCodes,
  phonePasses,
} from './dncAreaCodes';
import { verify } from './verification';
import { pauseChat, resumeChat } from './chatPause';
import { recoverOrCollapseChat } from './stalledRecovery';
import type { CampaignDoc, CampaignStatus } from '../types';

const COLLECTION = 'outbound_campaigns';
export const DEFAULT_PER_DAY = 100;
export const ENROLL_BATCH_SIZE = 100;
/** Every chat sweep pages at this size; a short page means the source is exhausted. */
const CHAT_PAGE_SIZE = 200;

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name?: string;
  agentId: string;
  recordType?: string;
  perDay?: number;
  audience?: Record<string, unknown>;
  /** Cross-campaign dedup. Default on. */
  excludeContacted?: boolean;
  /** Reduced gating: the DNC Full Scrub plus a business confirmation. */
  businessOnly?: boolean;
}

/** Create a campaign in status `enrolling`. Returns the new campaign id. */
export async function createCampaign(
  input: CreateCampaignInput
): Promise<string> {
  const ref = db.collection(COLLECTION).doc();
  await ref.set({
    name: input.name || 'Campaign',
    agent_id: input.agentId,
    record_type: input.recordType || 'Real',
    per_day: Math.trunc(Number(input.perDay) || DEFAULT_PER_DAY),
    audience: input.audience ?? {},
    exclude_contacted: input.excludeContacted !== false,
    business_only: Boolean(input.businessOnly),

    status: 'enrolling',
    enrolled_count: 0,
    cursor: null,
    total: null,
    /** Audiences queued by `addRecords`, drained after the current source. */
    pending_batches: [],
    created_at: new Date().toISOString(),
  });
  return ref.id;
}

export async function getCampaign(
  campaignId: string
): Promise<CampaignDoc | null> {
  const doc = await db.collection(COLLECTION).doc(campaignId).get();
  if (!doc.exists) return null;
  return { ...(doc.data() ?? {}), id: campaignId } as CampaignDoc;
}

export async function listCampaigns(
  agentId?: string | null
): Promise<CampaignDoc[]> {
  let q = db.collection(COLLECTION) as ReturnType<typeof db.collection>;
  const snap = agentId
    ? await q.where('agent_id', '==', agentId).get()
    : await q.get();
  return snap.docs.map(
    (d) => ({ ...(d.data() ?? {}), id: d.id }) as CampaignDoc
  );
}

/**
 * Write campaign updates.
 *
 * Whenever the write changes `status`, stamp `status_changed_at` and `updatedAt` too, so every
 * campaign has a reliable last-status-change time rather than only the `stopped_at` that
 * `stopCampaign` sets. A caller may pre-set `status_changed_at` to override.
 */
async function updateCampaign(
  campaignId: string,
  updates: Record<string, unknown>
): Promise<void> {
  let payload = updates ?? {};
  if ('status' in payload && !('status_changed_at' in payload)) {
    const nowIso = new Date().toISOString();
    payload = { ...payload, status_changed_at: nowIso, updatedAt: nowIso };
  }
  await db.collection(COLLECTION).doc(campaignId).set(payload, { merge: true });
}

export async function setStatus(
  campaignId: string,
  statusValue: CampaignStatus
): Promise<void> {
  await updateCampaign(campaignId, { status: statusValue });
}

/**
 * True while the campaign is still `enrolling` or `running` — i.e. not paused, stopped, or done.
 *
 * The enrollment guard uses this to skip a contact still pending in ANOTHER live campaign. A
 * paused/stopped campaign is not active, so its contacts become re-enrollable, which is deliberate.
 */
export async function isCampaignActive(
  campaignId: string | null | undefined
): Promise<boolean> {
  if (!campaignId) return false;
  try {
    const c = await getCampaign(campaignId);
    return Boolean(c && (c.status === 'enrolling' || c.status === 'running'));
  } catch (e) {
    console.warn(
      `[OB CAMPAIGN] isCampaignActive failed for ${campaignId}: ${e}`
    );
    return false;
  }
}

/** HubSpot contact ids already enrolled in THIS campaign, read from its chats. */
export async function enrolledContactIds(
  campaignId: string
): Promise<string[]> {
  const ids: string[] = [];
  try {
    const snap = await db
      .collection('chats')
      .where('campaign_id', '==', campaignId)
      .get();
    for (const d of snap.docs) {
      const cid = ((d.data() ?? {}).memory ?? {}).hubspot_contact_id;
      if (cid) ids.push(String(cid));
    }
  } catch (e) {
    console.warn(
      `[OB CAMPAIGN] enrolledContactIds failed for ${campaignId}: ${e}`
    );
  }
  return ids;
}

/**
 * Normalized CHANNEL keys of contacts already holding a chat in this campaign — the key enrollment
 * actually COLLAPSES on, phone-first. Returns `"p:<last-10-digits>"` and `"e:<lowercased-email>"`.
 *
 * Contact-id dedup alone misses the shared-line collision: a DISTINCT contact sharing a dealership
 * number would silently reuse an existing chat at enroll, so it must not appear selectable in an
 * add-more preview. Keying by phone/email here mirrors the real collapse key.
 */
export async function enrolledChannelKeys(
  campaignId: string
): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const snap = await db
      .collection('chats')
      .where('campaign_id', '==', campaignId)
      .get();
    for (const d of snap.docs) {
      const m = ((d.data() ?? {}).memory ?? {}) as Record<string, unknown>;
      const ph = String(m.phone_number ?? '').replace(/\D/g, '');
      if (ph) keys.add('p:' + ph.slice(-10));
      const em = String(m.customer_email ?? '')
        .trim()
        .toLowerCase();
      if (em) keys.add('e:' + em);
    }
  } catch (e) {
    console.warn(
      `[OB CAMPAIGN] enrolledChannelKeys failed for ${campaignId}: ${e}`
    );
  }
  return keys;
}

/**
 * Append MORE records to a non-terminal campaign as a new batch that starts AFTER the current one.
 *
 * The audience is queued in `pending_batches` and the enroll worker pops it on exhaustion. If the
 * campaign has already drained its current source (status `running`), the batch is promoted
 * immediately by re-entering `enrolling`. `enrolled_count` keeps accumulating, so pacing staggers the
 * new batch after the existing contacts rather than colliding with them.
 *
 * Contacts already enrolled in THIS campaign are excluded, merged with any per-record front-end
 * de-selections. Cross-campaign dedup is untouched.
 */
export async function addRecords(
  campaignId: string,
  audienceIn: Record<string, unknown> | null | undefined
): Promise<{
  ok: boolean;
  error?: string;
  status?: string;
  queued?: number;
  promoted?: boolean;
}> {
  const camp = await getCampaign(campaignId);
  if (!camp) return { ok: false, error: 'campaign not found' };
  if (camp.status === 'stopped' || camp.status === 'paused') {
    return {
      ok: false,
      error: `campaign is ${camp.status} — resume it before adding records`,
    };
  }

  const audience = { ...(audienceIn ?? {}) };
  const excl = new Set(
    ((audience.exclude_contact_ids as unknown[]) ?? [])
      .filter((x) => x !== null && x !== undefined && x !== '')
      .map((x) => String(x))
  );
  for (const id of await enrolledContactIds(campaignId)) excl.add(id);
  if (excl.size > 0) audience.exclude_contact_ids = [...excl];

  const pending = [...((camp.pending_batches as unknown[]) ?? [])];

  if (camp.status === 'running') {
    // The current source is exhausted, so promote this batch now.
    await updateCampaign(campaignId, {
      audience,
      cursor: null,
      status: 'enrolling',
      pending_batches: pending,
    });
    return { ok: true, status: 'enrolling', queued: 0, promoted: true };
  }

  pending.push(audience);
  await updateCampaign(campaignId, { pending_batches: pending });
  return {
    ok: true,
    status: camp.status,
    queued: pending.length,
    promoted: false,
  };
}

/**
 * Pause: stop enrolling AND stop firing this campaign's queued outreach.
 *
 * Also kicks off the cascade that sets `status: "paused"` on every enrolled chat, so chat status stays
 * the single source of truth and each chat can be resumed individually.
 */
export async function pauseCampaign(
  campaignId: string
): Promise<CampaignDoc | null> {
  const c = await getCampaign(campaignId);
  if (!c) return null;
  await updateCampaign(campaignId, {
    status: 'paused',
    _pause_cursor: null,
    _pause_done: false,
  });
  return getCampaign(campaignId);
}

/**
 * Resume, ONLY from `paused` — `stopped` is terminal. Returns to `enrolling` when the source is not
 * fully drained, else `running`, and kicks off the resume cascade.
 */
export async function resumeCampaign(
  campaignId: string
): Promise<CampaignDoc | null> {
  const c = await getCampaign(campaignId);
  if (!c) return null;
  if (c.status === 'paused') {
    await updateCampaign(campaignId, {
      status: c.cursor ? 'enrolling' : 'running',
      _resume_cursor: null,
      _resume_done: false,
    });
  }
  return getCampaign(campaignId);
}

/**
 * End a campaign — terminal. Halting outreach happens as the archive sweep parks each non-engaged
 * chat; engaged conversations are spared and continue.
 */
export async function stopCampaign(
  campaignId: string
): Promise<CampaignDoc | null> {
  const c = await getCampaign(campaignId);
  if (!c) return null;
  await updateCampaign(campaignId, {
    status: 'stopped',
    stopped_at: new Date().toISOString(),
    _archive_cursor: null,
    _archive_done: false,
  });
  return getCampaign(campaignId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat cascades — bounded, cursor-driven, cron-advanced
// ─────────────────────────────────────────────────────────────────────────────

/** One id-ordered page of a campaign's enrolled chats. */
async function campaignChatsPage(campaignId: string, cursor: unknown) {
  let q = db
    .collection('chats')
    .where('campaign_id', '==', campaignId)
    .orderBy('__name__')
    .limit(CHAT_PAGE_SIZE);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  return snap.docs;
}

/**
 * Bounded sweep: mark this campaign's still-active chats paused, tagged `campaign:<id>` so the resume
 * sweep can tell them apart from manually-paused chats.
 */
export async function pauseCampaignChatsBatch(
  campaignId: string
): Promise<{ paused: number; scanned?: number; done: boolean }> {
  const camp = await getCampaign(campaignId);
  if (!camp || camp.status !== 'paused' || camp._pause_done) {
    return { paused: 0, done: Boolean(camp?._pause_done) };
  }

  const docs = await campaignChatsPage(campaignId, camp._pause_cursor);
  let paused = 0;
  for (const d of docs) {
    if (
      (d.data() ?? {}).status === 'active' &&
      (await pauseChat(d.id, `campaign:${campaignId}`))
    ) {
      paused += 1;
    }
  }

  const done = docs.length < CHAT_PAGE_SIZE;
  const updates: Record<string, unknown> = { _pause_done: done };
  if (docs.length > 0) updates._pause_cursor = docs[docs.length - 1].id;
  await updateCampaign(campaignId, updates);
  return { paused, scanned: docs.length, done };
}

/**
 * Bounded sweep: un-pause and reschedule only the chats THIS campaign paused. A manually-paused chat
 * stays paused — that distinction is why `pauseChat` records `paused_by`.
 */
export async function resumeCampaignChatsBatch(
  campaignId: string
): Promise<{ resumed: number; scanned?: number; done: boolean }> {
  const camp = await getCampaign(campaignId);
  if (
    !camp ||
    camp._resume_done ||
    (camp.status !== 'enrolling' && camp.status !== 'running')
  ) {
    return { resumed: 0, done: Boolean(camp?._resume_done) };
  }

  const docs = await campaignChatsPage(campaignId, camp._resume_cursor);
  let resumed = 0;
  for (const d of docs) {
    const dd = d.data() ?? {};
    if (
      dd.status === 'paused' &&
      dd.paused_by === `campaign:${campaignId}` &&
      (await resumeChat(d.id)).resumed
    ) {
      resumed += 1;
    }
  }

  const done = docs.length < CHAT_PAGE_SIZE;
  const updates: Record<string, unknown> = { _resume_done: done };
  if (docs.length > 0) updates._resume_cursor = docs[docs.length - 1].id;
  await updateCampaign(campaignId, updates);
  return { resumed, scanned: docs.length, done };
}

/** Chats already in a live conversation are spared from archiving — do not drop hot leads. */
const ENGAGED_STAGES: ReadonlySet<string> = new Set(['engaged', 'lead']);

/**
 * Archive one non-engaged chat by parking it: `status: "archived"`, which the cron's task filter
 * excludes, plus the reason. Returns `false` when the chat is spared.
 */
async function archiveChatIfNotEngaged(
  chatId: string,
  chatData: Record<string, unknown>,
  reason: string,
  campaignId: string
): Promise<boolean> {
  const stage = String((chatData ?? {}).stage ?? '')
    .trim()
    .toLowerCase();
  if (ENGAGED_STAGES.has(stage)) return false;
  try {
    const nowIso = new Date().toISOString();
    await db
      .collection('chats')
      .doc(chatId)
      .set(
        {
          archived: true,
          archive_reason: reason,
          archived_at: nowIso,
          archived_campaign_id: String(campaignId),
          status: 'archived',
          status_changed_at: nowIso,
        },
        { merge: true }
      );
    return true;
  } catch (e) {
    console.warn(`[OB CAMPAIGN] archive chat ${chatId} failed: ${e}`);
    return false;
  }
}

/**
 * Bounded archive sweep for a stopped campaign: page its chats and archive the non-engaged ones.
 *
 * The per-contact HubSpot campaign-END stamp the source also does here arrives with the HubSpot phase.
 */
export async function archiveCampaignBatch(
  campaignId: string,
  batchSize = CHAT_PAGE_SIZE
): Promise<{
  archived: number;
  scanned?: number;
  done: boolean;
  error?: string;
}> {
  const camp = await getCampaign(campaignId);
  if (!camp || camp.status !== 'stopped' || camp._archive_done) {
    return { archived: 0, done: Boolean(camp?._archive_done) };
  }

  let docs;
  try {
    let q = db
      .collection('chats')
      .where('campaign_id', '==', campaignId)
      .orderBy('__name__')
      .limit(batchSize);
    if (camp._archive_cursor) q = q.startAfter(camp._archive_cursor);
    docs = (await q.get()).docs;
  } catch (e) {
    console.error(`[OB CAMPAIGN] ${campaignId} archive page failed: ${e}`);
    return { archived: 0, done: false, error: String(e) };
  }

  let archived = 0;
  for (const d of docs) {
    if (
      await archiveChatIfNotEngaged(
        d.id,
        d.data() ?? {},
        'campaign_stopped',
        campaignId
      )
    ) {
      archived += 1;
    }
  }

  const done = docs.length < batchSize;
  const updates: Record<string, unknown> = { _archive_done: done };
  if (docs.length > 0) updates._archive_cursor = docs[docs.length - 1].id;
  await updateCampaign(campaignId, updates);
  console.log(
    `[OB CAMPAIGN] ${campaignId} archive sweep: ${archived}/${docs.length} archived (done=${done})`
  );
  return { archived, scanned: docs.length, done };
}

/**
 * Bounded sweep: recover this campaign's stalled chats and collapse any with >1 pending proactive task.
 *
 * The cursor WRAPS at the end rather than stopping, so the sweep loops the campaign continuously —
 * unlike the pause/archive sweeps, recovery is never "done".
 */
export async function stalledRecoveryBatch(
  campaignId: string,
  maxChats: number
): Promise<{ recovered: number; collapsed: number; scanned: number }> {
  const camp = await getCampaign(campaignId);
  if (!camp || (camp.status !== 'enrolling' && camp.status !== 'running')) {
    return { recovered: 0, collapsed: 0, scanned: 0 };
  }

  const docs = await campaignChatsPage(campaignId, camp._stalled_cursor);
  const slice = docs.slice(0, maxChats);
  let recovered = 0;
  let collapsed = 0;
  for (const d of slice) {
    try {
      const r = await recoverOrCollapseChat(d.id, d.data() ?? {}, campaignId);
      if (r.recovered) recovered += 1;
      if (r.collapsed) collapsed += 1;
    } catch (e) {
      console.warn(`[OB STALLED] recover chat ${d.id} failed: ${e}`);
    }
  }

  // Wrap to the start when the source is exhausted, so the sweep loops.
  const nextCursor =
    docs.length >= CHAT_PAGE_SIZE ? docs[docs.length - 1].id : null;
  await updateCampaign(campaignId, { _stalled_cursor: nextCursor });
  return { recovered, collapsed, scanned: slice.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign-id selectors the cron advances each tick
// ─────────────────────────────────────────────────────────────────────────────

async function idsWhere(
  status: CampaignStatus | CampaignStatus[],
  limit: number,
  overFetch: number,
  predicate?: (d: Record<string, unknown>) => boolean
): Promise<string[]> {
  const q = Array.isArray(status)
    ? db.collection(COLLECTION).where('status', 'in', status)
    : db.collection(COLLECTION).where('status', '==', status);
  const snap = await q.limit(limit * overFetch).get();
  const out: string[] = [];
  for (const d of snap.docs) {
    if (predicate && !predicate(d.data() ?? {})) continue;
    out.push(d.id);
    if (out.length >= limit) break;
  }
  return out;
}

/** Campaigns still `enrolling`. */
export async function enrollingCampaignIds(limit = 5): Promise<string[]> {
  try {
    const snap = await db
      .collection(COLLECTION)
      .where('status', '==', 'enrolling')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.id);
  } catch (e) {
    console.warn(`[OB CAMPAIGN] enrollingCampaignIds failed: ${e}`);
    return [];
  }
}

/** Paused campaigns whose chat-pause sweep has not finished. */
export async function pausingCampaignIds(limit = 5): Promise<string[]> {
  try {
    return await idsWhere('paused', limit, 4, (d) => !d._pause_done);
  } catch (e) {
    console.warn(`[OB CAMPAIGN] pausingCampaignIds failed: ${e}`);
    return [];
  }
}

/** Recently-resumed campaigns whose chat-resume sweep has not finished. */
export async function resumingCampaignIds(limit = 5): Promise<string[]> {
  try {
    return await idsWhere(
      ['enrolling', 'running'],
      limit,
      8,
      (d) => d._resume_done === false
    );
  } catch (e) {
    console.warn(`[OB CAMPAIGN] resumingCampaignIds failed: ${e}`);
    return [];
  }
}

/** Live campaigns — the stalled-recovery sweep advances these. */
export async function runningCampaignIds(limit = 5): Promise<string[]> {
  try {
    return await idsWhere(['enrolling', 'running'], limit, 4);
  } catch (e) {
    console.warn(`[OB CAMPAIGN] runningCampaignIds failed: ${e}`);
    return [];
  }
}

/** Ids of currently-paused campaigns — the cron skips their queued tasks. */
export async function pausedCampaignIds(): Promise<Set<string>> {
  try {
    const snap = await db
      .collection(COLLECTION)
      .where('status', '==', 'paused')
      .get();
    return new Set(snap.docs.map((d) => d.id));
  } catch (e) {
    console.warn(`[OB CAMPAIGN] pausedCampaignIds failed: ${e}`);
    return new Set();
  }
}

/** Stopped campaigns whose archive sweep has not finished. */
export async function stoppedUnarchivedCampaignIds(
  limit = 5
): Promise<string[]> {
  try {
    return await idsWhere('stopped', limit, 4, (d) => !d._archive_done);
  } catch (e) {
    console.warn(`[OB CAMPAIGN] stoppedUnarchivedCampaignIds failed: ${e}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pacing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The staggered `execute_at` for the `index`-th contact (0-based) of a campaign: at most `per_day`
 * fire per business day, DISTRIBUTED across the business-hours window in the contact's timezone, so
 * many prospects do not all blast at the 09:00 start.
 *
 * Test records bypass business hours entirely → near-immediate, with a small per-index spread so they
 * do not land on identical timestamps.
 */
export function pacingExecuteAt(
  index: number,
  perDay: number,
  tz?: string | null,
  state?: string | null,
  recordType?: string | null
): Date {
  if (
    String(recordType ?? '')
      .trim()
      .toLowerCase() === 'test'
  ) {
    return new Date(Date.now() + (30 + (Math.trunc(index) % 30)) * 1_000);
  }
  const per = Math.max(1, Math.trunc(perDay || DEFAULT_PER_DAY));
  const dayOffset = Math.floor(Math.trunc(index) / per);
  const slot = Math.trunc(index) % per;
  return businessHoursSlot(dayOffset, slot, per, tz, state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audience paging
// ─────────────────────────────────────────────────────────────────────────────

/** Drop members whose contact id is in the exclusion list. */
export function dropExcludedMembers(
  members: Lead[],
  excludeIds: unknown[] | null | undefined
): Lead[] {
  const excl = new Set(
    (excludeIds ?? [])
      .filter((x) => x !== null && x !== undefined && x !== '')
      .map((x) => String(x))
  );
  if (excl.size === 0) return members;
  return members.filter((m) => {
    const id =
      (m.input_data as Record<string, unknown> | undefined)
        ?.hubspot_contact_id ?? m.hubspot_contact_id;
    return !(id && excl.has(String(id)));
  });
}

export interface AudiencePage {
  leads: Lead[];
  nextCursor: string | null;
  total: number | null;
}

/**
 * One page of a campaign's audience.
 *
 * Only the `csv` source is implemented; the HubSpot sources arrive with the HubSpot phase. An
 * unimplemented type returns an empty page rather than throwing, which lets the enroll worker treat
 * it as an exhausted source and settle the campaign rather than spinning on it every tick.
 */
export async function resolveAudiencePage(
  campaign: CampaignDoc,
  cursor: unknown,
  limit: number
): Promise<AudiencePage> {
  const audience = (campaign.audience ?? {}) as Record<string, unknown>;
  const atype = audience.type;
  const exclIds = audience.exclude_contact_ids as unknown[] | undefined;

  if (atype === 'csv') {
    const contacts = (audience.contacts as Lead[]) ?? [];
    const off = Number(cursor ?? 0) || 0;
    const page = contacts.slice(off, off + limit);
    const nxt = off + limit;
    return {
      leads: dropExcludedMembers(page, exclIds),
      nextCursor: nxt < contacts.length ? String(nxt) : null,
      total: contacts.length,
    };
  }

  if (
    atype === 'hubspot_list' ||
    atype === 'hubspot_search' ||
    (Array.isArray(audience.include_contact_ids) &&
      audience.include_contact_ids.length > 0)
  ) {
    console.warn(
      `[OB CAMPAIGN] audience type '${String(atype)}' needs the HubSpot layer — not yet ported; ` +
        `returning an empty page`
    );
    return { leads: [], nextCursor: null, total: null };
  }

  console.warn(`[OB CAMPAIGN] unknown audience type: ${String(atype)}`);
  return { leads: [], nextCursor: null, total: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment worker step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify the page's email addresses inside a hard time budget. Returns only those that verified
 * INVALID — anything unfinished within the budget counts as unverified and enrolls anyway, because
 * the send-time gate backstops it.
 *
 * The budget exists so a slow verifier cannot blow the cron tick. Verification infrastructure faults
 * exclude nobody.
 */
async function verifyPageEmails(
  page: Lead[],
  timeBudgetMs = 20_000,
  mxTimeoutMs = 3_000
): Promise<Set<string>> {
  const emails = new Set<string>();
  for (const raw of page ?? []) {
    const email = String(
      ((raw?.contact_information ?? {}) as Record<string, unknown>).email ?? ''
    )
      .trim()
      .toLowerCase();
    if (email) emails.add(email);
  }
  if (emails.size === 0) return new Set();

  const invalid = new Set<string>();
  try {
    const deadline = Date.now() + timeBudgetMs;
    const checks = [...emails].map(async (e) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return; // budget exhausted — enrolls unverified
      try {
        const r = await Promise.race([
          verify(e, mxTimeoutMs),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), remaining)
          ),
        ]);
        if (r && r.result === 'invalid') invalid.add(e);
      } catch {
        // A verify fault must not exclude anyone.
      }
    });
    await Promise.all(checks);
  } catch (e) {
    console.warn(`[OB CAMPAIGN] enrollment verification skipped (${e})`);
  }
  return invalid;
}

/** Any affirmative intake phone opt-out, read from every payload level. */
function intakePhoneOptout(
  lead: Lead,
  data: Record<string, unknown>,
  contact: Record<string, unknown>
): boolean {
  const vals = ['phone_opt_out', 'block_phone'].flatMap((k) => [
    lead[k],
    data[k],
    contact[k],
  ]);
  return vals.some(
    (v) =>
      v === true ||
      ['y', 'yes', 'true', '1'].includes(
        String(v ?? '')
          .trim()
          .toLowerCase()
      )
  );
}

export interface EnrollBatchResult {
  status: string;
  enrolled: number;
  skipped_invalid?: number;
  skipped_area_code?: number;
  phone_collision?: number;
  enrolled_bad_email?: number;
  cursor?: string | null;
  error?: string;
}

/**
 * Enroll ONE bounded page of a campaign's audience with staggered `execute_at`, advancing the cursor
 * and the two pacing counters. Flips the campaign to `running` when the source is exhausted and
 * nothing is queued behind it. Idempotent per contact, since enrollment dedups by chat id.
 */
export async function enrollCampaignBatch(
  campaignId: string,
  batchSize = ENROLL_BATCH_SIZE
): Promise<EnrollBatchResult> {
  const camp = await getCampaign(campaignId);
  if (!camp) return { status: 'missing', enrolled: 0 };
  if (camp.status !== 'enrolling') {
    return { status: String(camp.status), enrolled: 0 };
  }

  const agentId = String(camp.agent_id ?? '');
  const perDay = Number(camp.per_day) || DEFAULT_PER_DAY;
  const recordType = String(camp.record_type ?? 'Real');
  const businessOnly = Boolean(camp.business_only);
  const enrolled = Number(camp.enrolled_count ?? 0);
  // The EMAIL-lane pacing base. Phone-lane contacts must not consume email `per_day` slots.
  const emailPaced = Number(camp.email_paced_count ?? 0);

  let page: Lead[];
  let nextCursor: string | null;
  let total: number | null;
  try {
    const r = await resolveAudiencePage(camp, camp.cursor, batchSize);
    page = r.leads;
    nextCursor = r.nextCursor;
    total = r.total;
  } catch (e) {
    console.error(`[OB CAMPAIGN] ${campaignId} audience page failed: ${e}`);
    return { status: 'error', error: String(e), enrolled: 0 };
  }

  // Enrollment-time verification: an invalid address is never enrolled — no chat, no task, no LLM
  // turn, no token spend. Phone-only contacts skip it entirely.
  const invalidEmails = await verifyPageEmails(page);

  // Area-code filtering, computed ONCE per batch rather than per record.
  //   `areaAllowed`  — the campaign's chosen subset ∩ registered-non-expired. Bypassed for Test.
  //   `registered`   — the registry floor handed to enrollContact so its own gate does no I/O per record.
  const audience = (camp.audience ?? {}) as Record<string, unknown>;
  const areaAllowed =
    recordType === 'Test'
      ? null
      : await effectiveAllowed(audience.area_codes as unknown[] | undefined);
  let registered: ReadonlySet<string> | null;
  try {
    registered = await getAllowedAreaCodes();
  } catch {
    registered = null; // enrollContact falls back to a per-record read
  }

  let ok = 0;
  let emailOk = 0;
  let phoneSeen = 0;
  let skippedInvalid = 0;
  let skippedAreaCode = 0;
  let enrolledBadEmail = 0;
  let phoneCollision = 0;

  for (const raw of page) {
    const lead: Lead = { ...(raw ?? {}) };
    const data = { ...((lead.input_data ?? {}) as Record<string, unknown>) };
    data.agent_id = agentId; // campaign-level agent
    if (!('record_type' in data)) data.record_type = recordType;
    lead.input_data = data;

    const contact = (lead.contact_information ?? {}) as Record<string, unknown>;
    const phone = String(contact.phone_number ?? '').trim();
    const email = String(contact.email ?? '')
      .trim()
      .toLowerCase();

    // An INVALID EMAIL no longer drops the whole contact. With a phone on file, enroll on the PHONE
    // lane and mark `email_invalid` — the contact is still dialable. Only drop when there is no phone.
    const emailBad = Boolean(email && invalidEmails.has(email));
    if (emailBad && !phone) {
      skippedInvalid += 1;
      console.log(
        `[OB CAMPAIGN] ${campaignId}: skipped invalid address, no phone (not enrolled)`
      );
      continue;
    }

    // The campaign's area-code selection: drop records outside the chosen subset. Email-only kept.
    if (!phonePasses(phone, areaAllowed)) {
      skippedAreaCode += 1;
      continue;
    }

    const [state, tz] = resolveLocation(phone, data);

    // The LANE SPLIT, estimated from the lead — enrollContact sets the authoritative post-screen flag.
    //  - PHONE lane → fires TODAY in business hours with NO per_day stagger, since voice concurrency is
    //    the throttle. A 1s/contact spread avoids identical timestamps. Does NOT advance the email base.
    //  - EMAIL lane → the per_day stagger, keyed on the dedicated email base.
    const phoneEstimate =
      Boolean(phone) && !intakePhoneOptout(lead, data, contact);
    const isEmailLane = !phoneEstimate;

    let executeAt: Date;
    if (phoneEstimate) {
      const base = await nextBusinessHoursStart(tz, state);
      executeAt = new Date(base.getTime() + phoneSeen * 1_000);
      phoneSeen += 1;
    } else {
      executeAt = pacingExecuteAt(
        emailPaced + emailOk,
        perDay,
        tz,
        state,
        recordType
      );
    }

    try {
      const res = await enrollContact(lead, {
        executeAt,
        campaignId,
        skipIfContacted: true,
        allowedAreaCodes: registered,
        businessOnly,
        emailInvalid: emailBad,
      });
      // A distinct contact whose phone/email collapsed onto an EXISTING chat — the shared-line case.
      // Counted for visibility; the earlier chat stays protected.
      if (res.success && res.created === false) phoneCollision += 1;
      if (res.success && !res.skipped) {
        ok += 1;
        if (emailBad) enrolledBadEmail += 1;
        if (isEmailLane) emailOk += 1;
      }
    } catch (e) {
      console.warn(
        `[OB CAMPAIGN] ${campaignId} enroll failed for a contact: ${e}`
      );
    }
  }

  if (skippedInvalid) {
    console.log(
      `[OB CAMPAIGN] ${campaignId}: ${skippedInvalid} invalid address(es) w/o phone never enrolled`
    );
  }
  if (enrolledBadEmail) {
    console.log(
      `[OB CAMPAIGN] ${campaignId}: ${enrolledBadEmail} contact(s) enrolled phone-lane w/ invalid email`
    );
  }
  if (phoneCollision) {
    console.log(
      `[OB CAMPAIGN] ${campaignId}: ${phoneCollision} contact(s) collapsed onto an existing chat (shared phone/email)`
    );
  }
  if (skippedAreaCode) {
    console.log(
      `[OB CAMPAIGN] ${campaignId}: ${skippedAreaCode} record(s) skipped by area-code filter`
    );
  }

  const updates: Record<string, unknown> = {
    enrolled_count: enrolled + ok,
    email_paced_count: emailPaced + emailOk,
    cursor: nextCursor,
  };
  if (total !== null) updates.total = total;

  // The skip/enroll breakdown, so the UI can explain "50 selected → N enrolled" rather than a silent
  // drop. `last_enroll_stats` is this batch; `enroll_stats` accumulates across every batch.
  const batchStats = {
    enrolled: ok,
    phone_collision: phoneCollision,
    invalid_email_no_phone: skippedInvalid,
    enrolled_bad_email: enrolledBadEmail,
    area_code_skipped: skippedAreaCode,
    page: page.length,
  };
  updates.last_enroll_stats = batchStats;
  const prev = (camp.enroll_stats ?? {}) as Record<string, unknown>;
  const cumulative: Record<string, number> = {};
  for (const k of [
    'enrolled',
    'phone_collision',
    'invalid_email_no_phone',
    'enrolled_bad_email',
    'area_code_skipped',
  ] as const) {
    cumulative[k] = Number(prev[k] ?? 0) + Number(batchStats[k] ?? 0);
  }
  updates.enroll_stats = cumulative;

  if (page.length === 0 || !nextCursor) {
    // The current source is exhausted — drain the next queued batch before finishing, so added records
    // enroll AFTER these (enrolled_count keeps accumulating, so pacing staggers them later).
    const pending = [...((camp.pending_batches as unknown[]) ?? [])];
    if (pending.length > 0) {
      const nextAudience = pending.shift();
      updates.audience = nextAudience;
      updates.cursor = null;
      updates.pending_batches = pending;
      console.log(
        `[OB CAMPAIGN] ${campaignId}: current source exhausted — promoting next queued ` +
          `batch (${pending.length} still queued)`
      );
    } else {
      updates.status = 'running'; // nothing queued → done enrolling
    }
  }

  await updateCampaign(campaignId, updates);
  console.log(
    `[OB CAMPAIGN] ${campaignId}: enrolled ${ok}/${page.length} this batch ` +
      `(total enrolled ${updates.enrolled_count}, status ${String(updates.status ?? 'enrolling')})`
  );

  return {
    status: String(updates.status ?? 'enrolling'),
    enrolled: ok,
    skipped_invalid: skippedInvalid,
    skipped_area_code: skippedAreaCode,
    phone_collision: phoneCollision,
    enrolled_bad_email: enrolledBadEmail,
    cursor: (updates.cursor as string | null) ?? nextCursor,
  };
}
