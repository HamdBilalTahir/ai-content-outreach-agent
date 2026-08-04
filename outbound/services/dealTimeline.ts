/**
 * Per-deal touchpoint timeline — first touch → acquisition, merged across three sources.
 *
 * For one deal, every touchpoint becomes a single date-ascending event list:
 *
 *  - **The HubSpot deal** → `deal_created`, one `stage_change` per stage entered, and `acquired`.
 *  - **HubSpot engagements** → emails, calls, meetings, notes, tasks associated to the deal.
 *  - **Our AI outreach** → the chat's `messages_v3` plus its activities.
 *
 * The source chat is found through the attribution linkage (`memory.hubspot_deal_id`) that the conversion
 * scan writes, which is why 10d² had to land first.
 *
 * ## The two views overlap, so events are DE-DUPLICATED with HubSpot preferred
 *
 * An AI email logged to HubSpot appears twice; so does the acquisition (our
 * `prospect_converted_to_deal` card and HubSpot's won stage). Showing both would double every touchpoint
 * count on the very deals the timeline exists to explain. The bucketing is deliberately fuzzy —
 * two-minute windows for email, a day for meetings — because the two systems stamp the same touch at
 * slightly different times, and an exact-match dedupe would catch none of them.
 *
 * The loser of a bucket **donates its fields**: whichever event is kept absorbs any `title`, `status`, or
 * `meta` keys the other had. Preferring the authoritative record must not mean losing the richer one's
 * detail.
 *
 * ## Stage changes are never fabricated
 *
 * `hs_date_entered_<id>` history is sparse on older or manually-staged deals — often empty. Only stages
 * with a real timestamp emit a `stage_change`, so the timeline shows what HubSpot actually recorded rather
 * than a plausible reconstruction. The acquisition is the exception and always shows for a won deal, since
 * that is the event the whole view exists for: its time is the won stage's entry, else `closedate` (which
 * HubSpot reliably stamps on close), else the current stage's entry.
 *
 * ## An AI `acquired` on an OPEN deal is dropped
 *
 * `prospect_converted_to_deal` is written for any attributed deal, won or not — it is an attribution
 * marker, not an acquisition. Keeping it would show an open deal as acquired, which is the one thing a
 * conversion dashboard must never do.
 */

import { db } from '../firebase/db';
import { getAgentActions } from '../firebase/agent';
import { accessToken, resolveHubspotConfig } from './hubspot';
import {
  DEAL_SCAN_PROPERTIES,
  dealPipelineStages,
  fetchDealDetail,
  getDealEngagements,
  isoToMs,
  readDealsBatch,
} from './dealAnalytics';
import type {
  DealDetail,
  EngagementGroups,
  PipelineStage,
} from './dealAnalytics';
import type { HubspotConfig } from './hubspot';

/** Cap a runaway chat's `messages_v3` read. */
const MAX_AI_MESSAGES = 300;

/**
 * De-dup ranking: the authoritative HubSpot record beats SYC beats our AI-side reconstruction.
 *
 * `syc` has no producer in this port — it is carried so an event from that source, if one is ever added,
 * ranks where the source says it should rather than silently losing to HubSpot *and* to AI.
 */
const SRC_RANK: Record<string, number> = { hubspot: 3, syc: 2, ai: 1 };

type Stages = Record<string, PipelineStage>;

export interface TimelineEvent {
  at: string | null;
  /** Sort and de-dup key. Stripped from the response before it goes out. */
  _ms?: number;
  source: string;
  channel: string;
  type: string;
  direction: string | null;
  title: string | null;
  status: string | null;
  meta: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time + event helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Anything time-shaped → epoch millis. Firestore hands back `Date`s; HubSpot hands back strings. */
function ms(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getTime();
  return isoToMs(v);
}

/** Everything in the response normalizes to ISO-8601 UTC with a `Z`. */
function iso(v: unknown): string | null {
  const t = ms(v);
  return t === null ? null : new Date(t).toISOString().replace('.000Z', 'Z');
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface EventFields {
  direction?: string | null;
  title?: string | null;
  status?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * One event, or `null` when it has no usable timestamp.
 *
 * An undated touchpoint is dropped rather than placed at epoch zero, which would sort it before the deal
 * was created and make it read as the first touch.
 */
function ev(
  at: unknown,
  source: string,
  channel: string,
  type: string,
  fields: EventFields = {}
): TimelineEvent | null {
  const t = ms(at);
  if (t === null) return null;
  return {
    at: iso(at),
    _ms: t,
    source,
    channel,
    type,
    direction: fields.direction ?? null,
    title: fields.title || null,
    status: fields.status || null,
    meta: fields.meta ?? {},
  };
}

const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

/**
 * The first ~n characters of text, HTML stripped — HubSpot note bodies are HTML.
 *
 * The entity table is the five named entities plus `&nbsp;`, not Python's full `html.unescape`. This is a
 * 120-character preview for a timeline row; a rare unhandled entity shows as its literal `&…;` rather than
 * costing a dependency, and nothing downstream parses this string.
 */
function firstLine(s: unknown, n = 120): string | null {
  const stripped = String(s ?? '')
    .replace(TAG_RE, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(WS_RE, ' ')
    .trim();
  return stripped ? stripped.slice(0, n) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source chat resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The deal's source chat. An explicit `chatId` wins; otherwise the attribution linkage is followed.
 *
 * Returns `[null, null]` rather than throwing, because "this deal has no chat we know of" is a normal
 * answer for a deal a rep created from scratch.
 */
export async function findSourceChat(
  dealId?: string | null,
  chatId?: string | null
): Promise<[string | null, Record<string, unknown> | null]> {
  if (chatId) {
    const snap = await db.collection('chats').doc(chatId).get();
    return snap.exists
      ? [chatId, (snap.data() ?? {}) as Record<string, unknown>]
      : [null, null];
  }
  if (dealId) {
    const snap = await db
      .collection('chats')
      .where('memory.hubspot_deal_id', '==', String(dealId))
      .limit(1)
      .get();
    for (const doc of snap.docs) {
      return [doc.id, (doc.data() ?? {}) as Record<string, unknown>];
    }
  }
  return [null, null];
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot deal → deal_created / stage_change / acquired
// ─────────────────────────────────────────────────────────────────────────────

export interface DealEventsResult {
  events: TimelineEvent[];
  acquiredAt: string | null;
  amount: number | null;
}

/** `deal_created`, a `stage_change` per recorded entry, and `acquired` for a won deal. */
export function dealEvents(
  detail: DealDetail,
  stagesById: Stages
): DealEventsResult {
  const events: TimelineEvent[] = [];
  const amount = num(detail.amount);
  const entered = detail.stage_entered ?? {};

  const created = ev(detail.createdate, 'hubspot', 'deal', 'deal_created', {
    title: 'Deal created',
    meta: { deal_id: detail.deal_id, pipeline: detail.pipeline },
  });
  if (created) events.push(created);

  // Only stages with a REAL entry timestamp — see the module note on not fabricating history.
  for (const [sid, ts] of Object.entries(entered)) {
    const sm = stagesById[sid];
    // Won stages roll up into the single `acquired` below rather than appearing twice.
    if (sm?.type === 'won') continue;
    const e = ev(ts, 'hubspot', 'stage', 'stage_change', {
      title: sm?.label || sid,
      meta: { stage_id: sid, stage_type: sm?.type },
    });
    if (e) events.push(e);
  }

  const cur = detail.dealstage;
  const curMeta = cur ? stagesById[cur] : undefined;
  const wonEntries = Object.entries(entered).filter(
    ([sid]) => stagesById[sid]?.type === 'won'
  );

  let acquiredAt: string | null = null;
  if (curMeta?.type === 'won' || wonEntries.length > 0) {
    // The current stage if it is won; otherwise the LATEST won stage the deal passed through.
    const wonSid =
      curMeta?.type === 'won'
        ? (cur as string)
        : wonEntries.reduce((best, e) =>
            String(e[1]) > String(best[1]) ? e : best
          )[0];
    const wonLabel = stagesById[wonSid]?.label || wonSid;
    // `closedate` is the reliable middle fallback — HubSpot stamps it on close even when the per-stage
    // entry history is missing.
    const wonAt =
      entered[wonSid] || detail.closedate || detail.stage_entered_at;
    const e = ev(wonAt, 'hubspot', 'deal', 'acquired', {
      title: wonLabel,
      meta: { deal_id: detail.deal_id, amount, stage_id: wonSid },
    });
    if (e) {
      events.push(e);
      acquiredAt = e.at;
    }
  }

  return { events, acquiredAt, amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot engagements → events
// ─────────────────────────────────────────────────────────────────────────────

/** Every associated engagement as an event. Tasks share the `note` channel, flagged in `meta`. */
export function engagementEvents(eng: EngagementGroups): TimelineEvent[] {
  const out: Array<TimelineEvent | null> = [];

  for (const e of eng.emails ?? []) {
    const incoming = String(e.hs_email_direction ?? '')
      .toUpperCase()
      .startsWith('INCOMING');
    out.push(
      ev(
        e.hs_timestamp,
        'hubspot',
        'email',
        incoming ? 'email_reply' : 'email_sent',
        {
          direction: incoming ? 'in' : 'out',
          title: e.hs_email_subject as string,
          status: e.hs_email_status as string,
          meta: { engagement_id: e.id },
        }
      )
    );
  }

  for (const e of eng.calls ?? []) {
    const inbound =
      String(e.hs_call_direction ?? '').toUpperCase() === 'INBOUND';
    out.push(
      ev(
        e.hs_timestamp,
        'hubspot',
        'call',
        inbound ? 'customer_call' : 'ai_call',
        {
          direction: inbound ? 'in' : 'out',
          title: e.hs_call_title as string,
          meta: { engagement_id: e.id, duration: e.hs_call_duration },
        }
      )
    );
  }

  for (const e of eng.meetings ?? []) {
    // The START time, not the logged time — a meeting matters when it happens.
    out.push(
      ev(
        e.hs_meeting_start_time || e.hs_timestamp,
        'hubspot',
        'meeting',
        'meeting',
        { title: e.hs_meeting_title as string, meta: { engagement_id: e.id } }
      )
    );
  }

  for (const e of eng.notes ?? []) {
    out.push(
      ev(e.hs_timestamp, 'hubspot', 'note', 'note', {
        title: firstLine(e.hs_note_body),
        meta: { engagement_id: e.id },
      })
    );
  }

  for (const e of eng.tasks ?? []) {
    out.push(
      ev(e.hs_timestamp, 'hubspot', 'note', 'note', {
        title: e.hs_task_subject as string,
        status: e.hs_task_status as string,
        meta: { engagement_id: e.id, is_task: true },
      })
    );
  }

  return out.filter((e): e is TimelineEvent => e !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// The AI side — messages_v3 + activities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chat's customer-facing messages.
 *
 * `direction: 'internal'` is skipped: admin notes and `@ai` instructions are not touchpoints, and counting
 * them would inflate `touchpoint_count` with the team talking to itself.
 */
export async function aiMessageEvents(
  chatId: string
): Promise<TimelineEvent[]> {
  const out: TimelineEvent[] = [];
  const snap = await db
    .collection('chats')
    .doc(chatId)
    .collection('messages_v3')
    .orderBy('timestamp')
    .limit(MAX_AI_MESSAGES)
    .get();

  for (const doc of snap.docs) {
    const m = (doc.data() ?? {}) as Record<string, unknown>;
    if (m.direction === 'internal') continue;

    const content = (m.content ?? {}) as Record<string, unknown>;
    const source = m.source;
    const fromCustomer =
      ((m.sender ?? {}) as Record<string, unknown>).kind === 'customer';
    // Either signal is enough — the two are set by different writers.
    const inbound = m.direction === 'inbound' || fromCustomer;

    let e: TimelineEvent | null;
    if (source === 'call' || m.type === 'call') {
      const meta: Record<string, unknown> = {};
      for (const k of ['outcome', 'duration', 'summary']) {
        if (content[k]) meta[k] = content[k];
      }
      e = ev(m.timestamp, 'ai', 'call', inbound ? 'customer_call' : 'ai_call', {
        direction: inbound ? 'in' : 'out',
        meta,
      });
    } else if (source === 'email') {
      e = ev(
        m.timestamp,
        'ai',
        'email',
        inbound ? 'email_reply' : 'email_sent',
        {
          direction: inbound ? 'in' : 'out',
          title: (content.subject ?? m.subject) as string,
          status: m.status as string,
        }
      );
    } else {
      e = ev(m.timestamp, 'ai', 'sms', inbound ? 'customer_sms' : 'ai_sms', {
        direction: inbound ? 'in' : 'out',
        title: firstLine(content.body),
        status: m.status as string,
      });
    }
    if (e) out.push(e);
  }
  return out;
}

/** The activity cards that describe a touchpoint. Anything else on the chat is ignored. */
export async function aiActivityEvents(
  chatId: string
): Promise<TimelineEvent[]> {
  const out: Array<TimelineEvent | null> = [];
  const snap = await db
    .collection('chats')
    .doc(chatId)
    .collection('activities')
    .orderBy('timestamp')
    .get();

  for (const doc of snap.docs) {
    const a = (doc.data() ?? {}) as Record<string, unknown>;
    const tc = (a.toolCall ?? {}) as Record<string, unknown>;
    const name = tc.toolName;
    const at = a.timestamp;
    const inp = (tc.input ?? {}) as Record<string, unknown>;

    if (name === 'prospect_converted_to_deal') {
      out.push(
        ev(at, 'ai', 'deal', 'acquired', {
          title: String(inp.stage || 'Converted'),
          meta: { deal_id: inp.deal_id, amount: num(inp.amount) },
        })
      );
    } else if (name === 'hubspot_stage_synced') {
      out.push(
        ev(at, 'ai', 'stage', 'stage_change', {
          title: inp.hubspot_stage as string,
          meta: { from: inp.from_stage, to: inp.to_stage },
        })
      );
    } else if (name === 'schedule_hubspot_meeting') {
      const meta: Record<string, unknown> = {};
      for (const k of ['start_time', 'meeting_link']) {
        if (inp[k]) meta[k] = inp[k];
      }
      out.push(
        ev(at, 'ai', 'meeting', 'meeting', {
          title: (inp.title as string) || 'Meeting scheduled',
          meta,
        })
      );
    } else if (name === 'email_reply_received') {
      out.push(
        ev(at, 'ai', 'email', 'email_reply', {
          direction: 'in',
          title: inp.subject as string,
        })
      );
    } else if (name === 'email_bounced' || name === 'bounced') {
      out.push(
        ev(at, 'ai', 'email', 'email_sent', {
          direction: 'out',
          status: 'bounced',
        })
      );
    } else if (name === 'email_unsubscribed' || name === 'unsubscribed') {
      out.push(
        ev(at, 'ai', 'email', 'email_sent', {
          direction: 'out',
          status: 'unsubscribed',
        })
      );
    }
  }
  return out.filter((e): e is TimelineEvent => e !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// De-duplication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bucket key for events describing the SAME touch across sources. `null` → never de-duped.
 *
 * The windows are fuzzy on purpose: the two systems stamp the same touch at slightly different times, so
 * an exact-match key would collapse nothing. Calls, notes, and `deal_created` are deliberately absent —
 * two calls two minutes apart are two calls.
 */
export function dedupFamily(e: TimelineEvent): string | null {
  const { type, channel, direction } = e;
  // One acquisition, whatever its source or time.
  if (type === 'acquired') return 'acquired';
  // Per stage LABEL, because the AI card records the label and HubSpot records the id.
  if (type === 'stage_change') {
    return `stage|${(e.title ?? '').trim().toLowerCase()}`;
  }
  if (channel === 'email') {
    return `email|${direction}|${Math.floor((e._ms ?? 0) / 120_000)}`;
  }
  if (channel === 'meeting') {
    return `meeting|${Math.floor((e._ms ?? 0) / 86_400_000)}`;
  }
  return null;
}

/** Authoritative source, then having a title, then how much metadata it carries. */
function richness(e: TimelineEvent): [number, number, number] {
  return [
    SRC_RANK[e.source] ?? 0,
    e.title ? 1 : 0,
    Object.keys(e.meta ?? {}).length,
  ];
}

function richer(a: TimelineEvent, b: TimelineEvent): boolean {
  const [a0, a1, a2] = richness(a);
  const [b0, b1, b2] = richness(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

/** Merge `from`'s fields into `into` without overwriting anything `into` already has. */
function donate(into: TimelineEvent, from: TimelineEvent): void {
  for (const k of ['title', 'status'] as const) {
    if (!into[k] && from[k]) into[k] = from[k];
  }
  into.meta = { ...(from.meta ?? {}), ...(into.meta ?? {}) };
}

/** Collapse each bucket to its richest event, which absorbs the losers' fields. */
export function dedup(events: TimelineEvent[]): TimelineEvent[] {
  const families = new Map<string, TimelineEvent>();
  const singles: TimelineEvent[] = [];

  for (const e of events) {
    const fam = dedupFamily(e);
    if (fam === null) {
      singles.push(e);
      continue;
    }
    const cur = families.get(fam);
    if (cur === undefined) {
      families.set(fam, e);
    } else if (richer(e, cur)) {
      donate(e, cur);
      families.set(fam, e);
    } else {
      donate(cur, e);
    }
  }
  return [...singles, ...families.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The deal's own pipeline, falling back to the configured one.
 *
 * The deal's pipeline is tried first because a deal can legitimately live in a pipeline the agent is not
 * configured for — a rep moved it — and its own stage labels are the ones the timeline should show.
 */
async function resolvePipelineStages(
  token: string,
  cfg: Partial<HubspotConfig>,
  dealPipelineId: unknown
): Promise<[Stages, string | null]> {
  const entry = (cfg.stage_ids ?? {}).Lead;
  for (const pid of [dealPipelineId, cfg.pipeline_id]) {
    if (!pid) continue;
    const pdef = await dealPipelineStages(token, String(pid), entry);
    if (pdef) {
      const stages: Stages = {};
      for (const s of pdef.stages) stages[s.id] = s;
      return [stages, pdef.label];
    }
  }
  return [{}, null];
}

export interface TimelineResult {
  success: boolean;
  error?: string;
  /** Why the timeline is empty, when it is. A reason beats a bare empty list for the FE. */
  reason?: string;
  deal?: Record<string, unknown> | null;
  contact?: Record<string, unknown> | null;
  chat_id?: string | null;
  first_touch_at?: string | null;
  days_to_acquire?: number | null;
  touchpoint_count?: number;
  events?: TimelineEvent[];
}

function empty(reason: string): TimelineResult {
  return {
    success: true,
    reason,
    deal: null,
    contact: null,
    chat_id: null,
    first_touch_at: null,
    days_to_acquire: null,
    touchpoint_count: 0,
    events: [],
  };
}

export interface TimelineOptions {
  agentId?: string | null;
  dealId?: string | null;
  chatId?: string | null;
  recordType?: string;
}

/**
 * Build the timeline.
 *
 * Note the two different failure shapes, which the source distinguishes and the FE relies on:
 * `{success: false, error}` for a bad request or an unusable HubSpot config — the caller's problem — and
 * `{success: true, reason}` with an empty event list for a deal that legitimately has nothing to show. A
 * missing chat is not an error.
 */
export async function buildDealTimeline(
  options: TimelineOptions = {}
): Promise<TimelineResult> {
  const {
    agentId = null,
    dealId = null,
    chatId = null,
    recordType = 'Real',
  } = options;

  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!dealId && !chatId) {
    return { success: false, error: 'deal_id or chat_id is required' };
  }

  const [srcChatId, cd] = await findSourceChat(dealId, chatId);
  if (!cd) return empty('no_source_chat');

  const mem = (cd.memory ?? {}) as Record<string, unknown>;
  const resolvedDealId = String(dealId || mem.hubspot_deal_id || '');
  if (!resolvedDealId) return empty('no_deal_on_chat');

  // Never surface a Test deal under the default Real view.
  const wantRt = String(recordType ?? 'Real')
    .trim()
    .toLowerCase();
  const chatRt = String(cd.record_type ?? mem.record_type ?? 'Real')
    .trim()
    .toLowerCase();
  if (wantRt !== 'all' && wantRt !== '' && chatRt !== wantRt) {
    return empty('record_type_excluded');
  }

  const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
  if (!cfg.refresh_token && !cfg.access_token) {
    return { success: false, error: 'agent has no HubSpot config' };
  }
  const token = await accessToken(cfg, agentId);
  if (!token) {
    return { success: false, error: 'could not acquire HubSpot token' };
  }

  // A cheap read first, only to learn the deal's pipeline — the stage ids it yields are what make the
  // full detail read able to ask for every per-stage entry timestamp in one call.
  const base = await readDealsBatch(
    token,
    [resolvedDealId],
    [...DEAL_SCAN_PROPERTIES]
  );
  if (!(resolvedDealId in base)) return empty('deal_not_found');

  const [stagesById, pipelineLabel] = await resolvePipelineStages(
    token,
    cfg,
    base[resolvedDealId].pipeline
  );
  const detail = await fetchDealDetail(
    token,
    resolvedDealId,
    Object.keys(stagesById)
  );
  if (!detail) return empty('deal_not_found');

  const {
    events: fromDeal,
    acquiredAt: dealAcquiredAt,
    amount,
  } = dealEvents(detail, stagesById);
  const isWon = dealAcquiredAt !== null;

  let events = [...fromDeal];
  try {
    events.push(
      ...engagementEvents(await getDealEngagements(token, resolvedDealId))
    );
  } catch (e) {
    console.warn(`[DEAL_TL] engagements failed deal=${resolvedDealId}: ${e}`);
  }
  if (srcChatId) {
    try {
      events.push(...(await aiMessageEvents(srcChatId)));
      events.push(...(await aiActivityEvents(srcChatId)));
    } catch (e) {
      console.warn(`[DEAL_TL] ai events failed chat=${srcChatId}: ${e}`);
    }
  }

  // See the module note: on an OPEN deal our `prospect_converted_to_deal` card is an attribution marker,
  // not an acquisition, and showing it would report an open deal as won.
  if (!isWon) events = events.filter((e) => e.type !== 'acquired');

  events = dedup(events);
  // Ties put `deal_created` first — nothing can precede the deal existing.
  events.sort(
    (a, b) =>
      (a._ms ?? 0) - (b._ms ?? 0) ||
      (a.type === 'deal_created' ? 0 : 1) - (b.type === 'deal_created' ? 0 : 1)
  );

  // Re-derived from the SURVIVING acquired event, which de-dup may have swapped for the HubSpot one.
  const acq = events.filter((e) => e.type === 'acquired');
  const acquiredAt = acq.length > 0 ? acq[acq.length - 1].at : null;
  const firstTouchAt = events.length > 0 ? events[0].at : null;
  const firstMs = events.length > 0 ? (events[0]._ms ?? null) : null;
  const acqMs = ms(acquiredAt);
  const days =
    acqMs !== null && firstMs !== null
      ? Math.round((acqMs - firstMs) / 86_400_000)
      : null;

  for (const e of events) delete e._ms;

  const stageId = detail.dealstage;
  const contactName =
    `${mem.first_name ?? ''} ${mem.last_name ?? ''}`.trim() ||
    (mem.display_name as string) ||
    null;

  return {
    success: true,
    deal: {
      deal_id: resolvedDealId,
      stage: stageId,
      stage_label: stageId ? (stagesById[stageId]?.label ?? null) : null,
      pipeline: pipelineLabel || detail.pipeline,
      amount,
      created_at: iso(detail.createdate),
      acquired_at: acquiredAt,
    },
    contact: {
      contact_id: mem.hubspot_contact_id,
      name: contactName,
      company: mem.company ?? mem.company_name,
      phone: mem.phone_number,
      email: mem.customer_email ?? mem.email,
    },
    chat_id: srcChatId,
    first_touch_at: firstTouchAt,
    days_to_acquire: days,
    touchpoint_count: events.length,
    events,
  };
}
