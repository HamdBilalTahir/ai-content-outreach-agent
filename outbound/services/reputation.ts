/**
 * Domain reputation controls: a circuit breaker plus a domain-wide daily budget with a warm-up ramp.
 *
 * ## The breaker window is TIME-based, and that is not incidental
 *
 * Rates are computed over the trailing 72 hours of `email_send_log`. A row-COUNT window would
 * deadlock: once halted, no new rows are written, so the last N rows stay the same bad rows and the
 * rate never falls. Halts therefore clear by **time** (bad rows aging out of the window) or **by
 * hand** (the ops document) — and nothing else.
 *
 * ## Volume floors, because a rate from one event is not a rate
 *
 * A halt needs the rate condition AND enough evidence. A single bounce never halts. Post-warm-up, a
 * single complaint warns and two halt. During warm-up the first complaint halts outright — at a cap of
 * 10–50 sends a day, one complaint genuinely is a crisis.
 *
 * ## Per-domain isolation
 *
 * Each agent sends from its own domain, so the breaker, the budget, and the warm-up are all keyed by
 * sending domain: one domain's bounces never halt another. The global `email_breaker/state` document
 * remains a master kill-switch whose `force_halt` halts every domain.
 *
 * ## The budget is one transactional counter
 *
 * Per-campaign `per_day` values and per-agent hourly buckets do not compose into a global ceiling, so
 * there is a single daily counter per domain. Its effective cap is `min(configured cap, warm-up ramp)`,
 * and the fail-safe for a missing or unparseable start date is always the SMALLEST cap — never
 * ramp-complete.
 *
 * A synchronous send failure returns its token. An asynchronous bounce intentionally does NOT: a
 * bounce IS a send as far as reputation is concerned. Do not "fix" that.
 */

import { FieldValue, db } from '../firebase/db';
import { domainDailyCap, domainStartDate } from '../config';

export const SEND_LOG = 'email_send_log';
export const BUDGET_COLLECTION = 'email_domain_budget';
export const BREAKER_COLLECTION = 'email_breaker';
export const BREAKER_DOC_ID = 'state';

export const BREAKER_WINDOW_HOURS = 72;
export const BOUNCE_HALT_RATE = 0.02;
export const BOUNCE_WARN_RATE = 0.01;
/**
 * A halt needs rate ≥ 2% AND ≥ 2 bounce events over the trailing window. An earlier
 * "(≥25 sends OR ≥2 events)" formulation contradicted "a single bounce never halts" and was retired.
 */
export const BOUNCE_MIN_EVENTS = 2;
export const COMPLAINT_HALT_RATE = 0.004;
export const COMPLAINT_MIN_EVENTS_POST_WARMUP = 2;

/** Warm-up ramp: `[dayOffset, cap]`. Applies to the domain budget only; campaign pacing is untouched. */
export const RAMP: ReadonlyArray<readonly [number, number]> = [
  [0, 10],
  [4, 20],
  [8, 35],
  [12, 50],
];

/** Statuses meaning the mail actually LEFT the system, and so counts as a send. */
const SENT_STATUSES: ReadonlySet<string> = new Set([
  'sent',
  'bounced',
  'complained',
]);

function dayKey(dt?: Date): string {
  return (dt ?? new Date()).toISOString().slice(0, 10);
}

/**
 * The sending domain — the reputation key. Each agent sends from its own domain, so everything here
 * is keyed by this.
 */
export function domainOf(sender: unknown): string {
  const s = String(sender ?? '')
    .trim()
    .toLowerCase();
  return s.includes('@') ? s.split('@').pop()! : '';
}

/** Per-domain daily counter document. A legacy call with no domain keeps the bare day key. */
function budgetDocId(domain = ''): string {
  return domain ? `${domain}_${dayKey()}` : dayKey();
}

// ─────────────────────────────────────────────────────────────────────────────
// Warm-up ramp / effective cap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Days since the warm-up anchor. `startDate` is the per-agent override; it falls back to
 * `DOMAIN_START_DATE`.
 *
 * Missing, unparseable, or future → 0 (cap 10) plus an ERROR log. The fail-safe is always the
 * SMALLEST cap: never default to ramp-complete, because that would let a misconfiguration send at full
 * volume from a cold domain.
 */
function daysSinceStart(startDate?: string | null): number {
  const raw = String(startDate ?? domainStartDate() ?? '').trim();
  if (!raw) {
    console.error(
      '[REPUTATION] warm-up start date not set (per-agent warmup_start_date / ' +
        `DOMAIN_START_DATE) — ramp held at day 0 (cap ${RAMP[0][1]}).`
    );
    return 0;
  }

  const start = new Date(raw.includes('T') ? raw : `${raw}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    console.error(
      `[REPUTATION] DOMAIN_START_DATE unparseable ('${raw}') — ramp held at day 0`
    );
    return 0;
  }

  const days = Math.floor((Date.now() - start.getTime()) / 86_400_000);
  if (days < 0) {
    console.error(
      `[REPUTATION] DOMAIN_START_DATE is in the future (${raw}) — ramp held at day 0`
    );
    return 0;
  }
  return days;
}

/** The ramp cap for a day offset — the last rung whose threshold has been reached. */
export function rampCap(days: number): number {
  let cap = RAMP[0][1];
  for (const [dayOffset, c] of RAMP) {
    if (days >= dayOffset) cap = c;
  }
  return cap;
}

/** Per-agent daily cap override; falls back to `DOMAIN_DAILY_CAP`. */
function configuredCap(cap?: number | string | null): number {
  if (cap !== null && cap !== undefined && String(cap).trim() !== '') {
    const n = Number(cap);
    if (Number.isFinite(n)) return Math.trunc(n);
    console.warn(
      `[REPUTATION] invalid per-agent daily_cap ('${String(cap)}') — using DOMAIN_DAILY_CAP`
    );
  }
  return domainDailyCap();
}

export function effectiveDailyCap(
  cap?: number | string | null,
  startDate?: string | null
): number {
  return Math.min(configuredCap(cap), rampCap(daysSinceStart(startDate)));
}

/**
 * True while the ramp has not reached the configured cap — this drives the stricter complaint rule.
 *
 * NOTE the ramp tops out at 50 (`RAMP`'s last rung), so a configured cap ABOVE 50 is never reached and
 * this stays permanently `true`. That is the conservative reading rather than a bug: a domain
 * configured beyond what the ramp will ever authorize keeps the stricter first-complaint-halts rule in
 * force indefinitely.
 */
export function inWarmup(
  cap?: number | string | null,
  startDate?: string | null
): boolean {
  return rampCap(daysSinceStart(startDate)) < configuredCap(cap);
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowStats {
  sends_72h: number;
  bounces_72h: number;
  complaints_72h: number;
}

/**
 * `(sends, bounces, complaints)` over the trailing window.
 *
 * Only rows that actually LEFT the system count as sends. The failed/skipped/deferred audit rows are
 * written for ops visibility and must neither dilute nor inflate the breaker's rates — a day of
 * budget deferrals would otherwise crater the apparent bounce rate.
 *
 * Best-effort: a query failure is treated as clean, because the breaker must not halt sending on its
 * own read error.
 */
async function windowStats(
  domain?: string | null
): Promise<[number, number, number]> {
  const since = new Date(
    Date.now() - BREAKER_WINDOW_HOURS * 3_600_000
  ).toISOString();
  let sends = 0;
  let bounces = 0;
  let complaints = 0;
  try {
    const snap = await db
      .collection(SEND_LOG)
      .where('sent_at', '>=', since)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      const status = String(d.status ?? '');
      if (!SENT_STATUSES.has(status)) continue; // audit-only outcome rows
      if (domain && (d.domain || domainOf(d.sender)) !== domain) continue;
      sends += 1;
      if (status === 'bounced') bounces += 1;
      else if (status === 'complained') complaints += 1;
    }
  } catch (e) {
    console.warn(
      `[REPUTATION] send_log window query failed (${e}) — breaker treats as clean`
    );
  }
  return [sends, bounces, complaints];
}

export interface BreakerResult {
  halted: boolean;
  reason: string;
  stats: WindowStats | Record<string, never>;
}

/**
 * Is sending halted for this domain?
 *
 * Order matters: the GLOBAL master kill-switch is checked first and halts every domain regardless of
 * per-domain state. Then the per-domain ops document, where `force_halt` halts regardless of rates and
 * a future `override_until` force-resumes. Only then are the rates consulted.
 */
export async function breakerCheck(
  domain?: string | null,
  cap?: number | string | null,
  startDate?: string | null
): Promise<BreakerResult> {
  // Global master kill-switch first.
  let masterState: Record<string, unknown> = {};
  try {
    const master = await db
      .collection(BREAKER_COLLECTION)
      .doc(BREAKER_DOC_ID)
      .get();
    masterState = master.exists ? (master.data() ?? {}) : {};
  } catch {
    masterState = {};
  }
  if (masterState.force_halt) {
    return {
      halted: true,
      reason: `force_halt (master) by ${String(masterState.set_by ?? '?')}`,
      stats: {},
    };
  }

  // The per-domain ops document, falling back to the master document when no domain is given.
  let state: Record<string, unknown> = {};
  try {
    const docId = domain || BREAKER_DOC_ID;
    const doc = await db.collection(BREAKER_COLLECTION).doc(docId).get();
    state = doc.exists ? (doc.data() ?? {}) : {};
  } catch {
    state = {};
  }
  if (state.force_halt) {
    return {
      halted: true,
      reason: `force_halt by ${String(state.set_by ?? '?')}`,
      stats: {},
    };
  }

  const overrideUntil = state.override_until;
  let overridden = false;
  if (overrideUntil) {
    const dt = new Date(String(overrideUntil).replace('Z', '+00:00'));
    overridden = !Number.isNaN(dt.getTime()) && dt.getTime() > Date.now();
  }

  const [sends, bounces, complaints] = await windowStats(domain);
  const stats: WindowStats = {
    sends_72h: sends,
    bounces_72h: bounces,
    complaints_72h: complaints,
  };

  if (overridden) {
    return {
      halted: false,
      reason: `override_until ${String(overrideUntil)}`,
      stats,
    };
  }

  if (sends > 0) {
    const bounceRate = bounces / sends;
    const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

    // Bounce rule: rate ≥ threshold AND ≥ 2 events — a single bounce never halts.
    if (bounceRate >= BOUNCE_HALT_RATE && bounces >= BOUNCE_MIN_EVENTS) {
      return {
        halted: true,
        reason: `bounce rate ${pct(bounceRate)} (${bounces}/${sends})`,
        stats,
      };
    }
    if (bounceRate >= BOUNCE_WARN_RATE) {
      console.warn(
        `[REPUTATION] bounce rate warning: ${pct(bounceRate)} (${bounces}/${sends})`
      );
    }

    // Complaint rule. During warm-up the first complaint halts. Post-warm-up the same volume-floor
    // principle as bounces applies: one complaint warns, two or more halt.
    if (complaints > 0) {
      if (inWarmup(cap, startDate)) {
        return {
          halted: true,
          reason: `complaint during warm-up (${complaints})`,
          stats,
        };
      }
      if (complaints >= COMPLAINT_MIN_EVENTS_POST_WARMUP) {
        return {
          halted: true,
          reason: `complaints ${complaints}/${sends} in ${BREAKER_WINDOW_HOURS}h`,
          stats,
        };
      }
      console.warn(
        `[REPUTATION] complaint warning: ${complaints}/${sends} in window`
      );
    }
  }

  return { halted: false, reason: '', stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain-wide daily budget
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetResult {
  allowed: boolean;
  count: number;
  cap: number;
}

/**
 * Transactional increment-if-below-cap on this domain's daily counter, so parallel workers cannot race
 * past the ceiling.
 *
 * Storage error → fail CLOSED. This is a reputation control, not a rate control: the cost of an
 * accidental over-send against a cold domain is far higher than the cost of a deferral.
 */
export async function consumeDomainBudget(
  domain = '',
  cap?: number | string | null,
  startDate?: string | null
): Promise<BudgetResult> {
  const effCap = effectiveDailyCap(cap, startDate);
  const ref = db.collection(BUDGET_COLLECTION).doc(budgetDocId(domain));
  try {
    const [allowed, count] = await db.runTransaction<[boolean, number]>(
      async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists
          ? Number((snap.data() ?? {}).count ?? 0)
          : 0;
        if (current >= effCap) return [false, current];
        tx.set(
          ref,
          {
            count: current + 1,
            cap: effCap,
            updated_at: new Date().toISOString(),
          },
          { merge: true }
        );
        return [true, current + 1];
      }
    );
    return { allowed, count, cap: effCap };
  } catch (e) {
    console.error(
      `[REPUTATION] domain budget transaction failed — failing CLOSED: ${e}`
    );
    return { allowed: false, count: -1, cap: effCap };
  }
}

/**
 * Return one token after a SYNCHRONOUS send failure — a non-2xx before acceptance.
 *
 * Asynchronous failures (accepted, then bounced) intentionally do NOT release: a bounce IS a send for
 * reputation purposes. Best-effort.
 */
export async function releaseDomainBudget(domain = ''): Promise<void> {
  try {
    await db
      .collection(BUDGET_COLLECTION)
      .doc(budgetDocId(domain))
      .update({ count: FieldValue.increment(-1) });
  } catch (e) {
    console.warn(`[REPUTATION] budget release failed (non-blocking): ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Send log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-allocate a send-log document reference so its id can ride along in the provider's custom args,
 * which is what lets an asynchronous webhook event correlate back to the row.
 */
export function newSendLogRef() {
  return db.collection(SEND_LOG).doc();
}

export interface SendLogFields {
  agent_id?: string | null;
  sender?: string | null;
  recipient?: string | null;
  sg_message_id?: string | null;
  campaign_id?: string | null;
  /** `outreach | reply | transactional` — chosen by conversation state. */
  profile?: string | null;
  /** `llm_tool | nudge_service | transactional_service` — the caller's machinery. */
  origin?: string | null;
  chat_id?: string | null;
  domain?: string | null;
}

/**
 * A successful-send row. Every email is labelled with its classification, so the same taxonomy is
 * queryable per chat (the chat rollup) and across chats (this log).
 */
export async function writeSendLog(
  ref: ReturnType<typeof newSendLogRef>,
  f: SendLogFields
): Promise<void> {
  try {
    await ref.set({
      agent_id: f.agent_id ?? '',
      sender: f.sender ?? '',
      recipient: String(f.recipient ?? '').toLowerCase(),
      domain: f.domain || domainOf(f.sender),
      sent_at: new Date().toISOString(),
      status: 'sent',
      sg_message_id: f.sg_message_id ?? '',
      campaign_id: f.campaign_id ?? '',
      profile: f.profile ?? '',
      origin: f.origin ?? '',
      chat_id: f.chat_id ?? '',
    });
  } catch (e) {
    console.warn(`[REPUTATION] send_log write failed (non-blocking): ${e}`);
  }
}

export interface DailySummary {
  sent: number;
  failed: number;
  deferred_by_domain_budget: number;
  deferred_by_bucket: number;
  deferred_by_breaker: number;
  skipped_by_reason: Record<string, number>;
  breaker_state: string;
  by_domain: Record<
    string,
    {
      sent: number;
      failed: number;
      deferred: number;
      skipped: number;
      effective_ramp_cap: number;
      warmup_start_date: string | null;
    }
  >;
  attempts: number;
}

/**
 * Today's email-pipeline outcomes, emitted once per cron tick so ops can see a backlog forming instead
 * of discovering a week-old queue.
 *
 * WARNs when domain-budget deferrals exceed 30% of the day's attempts, which is the signal that
 * campaign `per_day` values oversubscribe the domain cap — the campaigns are promising more sends per
 * day than the warming domain will ever authorize.
 *
 * The per-domain cap and warm-up come from each domain's OWN agent config rather than a single global
 * env fallback, so the summary reflects the real ramp per domain and the "warm-up start not set"
 * warning only fires for a domain genuinely missing one. Config lookups are cached per agent within
 * the call.
 *
 * Deferred out of the compliance phase to here, because it needs `resolveSendgridConfig`.
 */
export async function emailDailySummary(): Promise<DailySummary> {
  const since = new Date().toISOString().slice(0, 10) + 'T00:00:00+00:00';

  let sent = 0;
  let failed = 0;
  let deferredBudget = 0;
  let deferredBucket = 0;
  let deferredBreaker = 0;
  const skippedByReason: Record<string, number> = {};
  const byDomain: Record<
    string,
    {
      sent: number;
      failed: number;
      deferred: number;
      skipped: number;
      agent_id: string;
    }
  > = {};

  try {
    const snap = await db
      .collection(SEND_LOG)
      .where('sent_at', '>=', since)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      const status = String(d.status ?? '');
      const dom = String(d.domain ?? '') || domainOf(d.sender) || '(unknown)';
      const dd = (byDomain[dom] ??= {
        sent: 0,
        failed: 0,
        deferred: 0,
        skipped: 0,
        agent_id: '',
      });
      // Any row's agent_id resolves this domain's config.
      if (!dd.agent_id && d.agent_id) dd.agent_id = String(d.agent_id);

      if (SENT_STATUSES.has(status)) {
        sent += 1;
        dd.sent += 1;
      } else if (status === 'failed') {
        failed += 1;
        dd.failed += 1;
      } else if (status === 'deferred') {
        const reason = String(d.reason ?? '');
        if (reason === 'domain_budget') deferredBudget += 1;
        else if (reason === 'hourly_bucket') deferredBucket += 1;
        else deferredBreaker += 1;
        dd.deferred += 1;
      } else if (status === 'skipped') {
        const key = String(d.reason ?? 'unknown').split(':')[0];
        skippedByReason[key] = (skippedByReason[key] ?? 0) + 1;
        dd.skipped += 1;
      }
    }
  } catch (e) {
    console.warn(`[REPUTATION] daily summary query failed (${e})`);
  }

  const cfgCache = new Map<string, Record<string, unknown>>();
  const domainCfg = async (
    agentId: string
  ): Promise<Record<string, unknown>> => {
    if (!agentId) return {};
    if (!cfgCache.has(agentId)) {
      try {
        const { resolveSendgridConfig } = await import('./sendgridMail');
        const { getAgentActions } = await import('../firebase/agent');
        cfgCache.set(
          agentId,
          resolveSendgridConfig(
            await getAgentActions(agentId)
          ) as unknown as Record<string, unknown>
        );
      } catch (e) {
        console.warn(
          `[REPUTATION] daily summary config resolve failed for ${agentId}: ${e}`
        );
        cfgCache.set(agentId, {});
      }
    }
    return cfgCache.get(agentId) ?? {};
  };

  const domains: DailySummary['by_domain'] = {};
  for (const [dom, dd] of Object.entries(byDomain)) {
    const cfg = await domainCfg(dd.agent_id);
    domains[dom] = {
      sent: dd.sent,
      failed: dd.failed,
      deferred: dd.deferred,
      skipped: dd.skipped,
      effective_ramp_cap: effectiveDailyCap(
        cfg.daily_cap as number | string | null,
        cfg.warmup_start_date as string | null
      ),
      warmup_start_date: (cfg.warmup_start_date as string | null) ?? null,
    };
  }

  const brk = await breakerCheck();
  const skippedTotal = Object.values(skippedByReason).reduce(
    (a, b) => a + b,
    0
  );
  const attempts =
    sent +
    failed +
    deferredBudget +
    deferredBucket +
    deferredBreaker +
    skippedTotal;

  const summary: DailySummary = {
    sent,
    failed,
    deferred_by_domain_budget: deferredBudget,
    deferred_by_bucket: deferredBucket,
    deferred_by_breaker: deferredBreaker,
    skipped_by_reason: skippedByReason,
    breaker_state: brk.halted ? `halted: ${brk.reason}` : 'clear',
    by_domain: domains,
    attempts,
  };

  if (attempts && deferredBudget / attempts > 0.3) {
    console.warn(
      `[REPUTATION][EMAIL SUMMARY] OVERSUBSCRIPTION: ${deferredBudget}/${attempts} ` +
        `(${Math.round((deferredBudget / attempts) * 100)}%) of today's attempts deferred by the ` +
        `domain budget — campaign per_day values exceed the cap; re-pace campaigns.`
    );
  }
  return summary;
}

/**
 * An audit row for every email that did NOT go out — `failed` (a provider error), `skipped` (a gate
 * reason), or `deferred` (a budget, breaker, or bucket condition) — so ops can see exactly why each
 * email did not send.
 *
 * These rows are excluded from the breaker's send counts; see `windowStats`. Best-effort.
 */
export async function logEmailOutcome(
  f: SendLogFields & {
    status: string;
    reason?: string | null;
    error?: string | null;
    ref?: ReturnType<typeof newSendLogRef> | null;
  }
): Promise<void> {
  try {
    const target = f.ref ?? db.collection(SEND_LOG).doc();
    await target.set({
      agent_id: f.agent_id ?? '',
      sender: f.sender ?? '',
      recipient: String(f.recipient ?? '').toLowerCase(),
      domain: f.domain || domainOf(f.sender),
      sent_at: new Date().toISOString(),
      status: f.status,
      reason: f.reason ?? '',
      error: String(f.error ?? '').slice(0, 500),
      campaign_id: f.campaign_id ?? '',
      profile: f.profile ?? '',
      origin: f.origin ?? '',
      chat_id: f.chat_id ?? '',
    });
  } catch (e) {
    console.warn(`[REPUTATION] outcome log write failed (non-blocking): ${e}`);
  }
}
