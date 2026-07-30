/**
 * Central env/config access for the outbound flow.
 *
 * Replaces the source's two config sources — Django `settings.*` and scattered
 * `os.getenv(...)` calls — with one module. Two rules make this port behave like the source
 * while staying testable:
 *
 *  1. **Every value is read lazily, inside a function.** The Python module-level constants
 *     (`MAX_TASKS_PER_TICK = int(os.getenv(...))`) were evaluated once at import. Reading at call
 *     time instead lets a test set `process.env.X` without module-registry surgery, and the
 *     behavioral difference is nil for a serverless process whose env never changes mid-run.
 *  2. **The two boolean conventions from the source are preserved exactly**, because they encode
 *     opposite intents — see `flagDefaultOn` / `flagDefaultOff`. Getting one backwards silently
 *     flips a safety gate, so they are separate functions rather than one with a default param.
 *
 * Integration credentials are read through `requireEnv`, which throws
 * `OutboundIntegrationNotConfigured`. Nothing here throws at import time: the flow must load, and
 * all of its deterministic gating must run, on a machine with none of these keys set.
 */

/** Thrown when an integration is invoked without its credentials configured. */
export class OutboundIntegrationNotConfigured extends Error {
  readonly integration: string;
  readonly missing: string[];

  constructor(integration: string, missing: string[]) {
    super(
      `${integration} is not configured — missing env: ${missing.join(', ')}. ` +
        `Set it to activate this integration; the outbound flow runs without it.`
    );
    this.name = 'OutboundIntegrationNotConfigured';
    this.integration = integration;
    this.missing = missing;
  }
}

function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** String env with a default. */
export function envStr(name: string, fallback = ''): string {
  return raw(name) ?? fallback;
}

/**
 * Integer env with a default. A non-numeric value falls back rather than throwing — the source's
 * `int(os.getenv(...))` would raise at import, which for a tunable is worse than using the default.
 */
export function envInt(name: string, fallback: number): number {
  const v = raw(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Float env with a default. Same fallback-over-throw rule as {@link envInt}. */
export function envFloat(name: string, fallback: number): number {
  const v = raw(name);
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Default-ON kill-switch: `str(getenv(X, "1")).strip().lower() not in ("0","false","off","no")`.
 * Used for guards we want active unless someone deliberately disables them, so any unexpected
 * value resolves to ON (fail-safe).
 */
export function flagDefaultOn(name: string): boolean {
  const v = (raw(name) ?? '1').toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * Default-OFF opt-in: `str(getenv(X, "false")).lower() == "true"`.
 * Used for behavior that must be explicitly turned on (sandbox modes, unsigned-webhook
 * acceptance, policy experiments), so anything other than a literal "true" stays OFF.
 */
export function flagDefaultOff(name: string): boolean {
  return (raw(name) ?? 'false').toLowerCase() === 'true';
}

/**
 * Comma-separated list env (e.g. `INBOUND_NUDGE_OFFSETS_DAYS="1,3,5,7"`). Blank entries dropped.
 */
export function envList(name: string, fallback: string): string[] {
  return (raw(name) ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Same as {@link envList} but parsed to integers, dropping anything non-numeric. */
export function envIntList(name: string, fallback: string): number[] {
  return envList(name, fallback)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Read required credentials for an integration, or throw {@link OutboundIntegrationNotConfigured}
 * naming every missing key at once (so activating an integration is one env edit, not a
 * discover-one-key-per-run loop).
 */
export function requireEnv<K extends string>(
  integration: string,
  names: readonly K[]
): Record<K, string> {
  const out = {} as Record<K, string>;
  const missing: string[] = [];
  for (const name of names) {
    const v = raw(name);
    if (v === undefined) missing.push(name);
    else out[name] = v;
  }
  if (missing.length)
    throw new OutboundIntegrationNotConfigured(integration, missing);
  return out;
}

/** True when every named env var is present — lets callers gate instead of catching. */
export function isConfigured(names: readonly string[]): boolean {
  return names.every((n) => raw(n) !== undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron / task dispatch
// ─────────────────────────────────────────────────────────────────────────────

/** Per-tick budget: max due outbound tasks processed per cron run, in parallel. */
export const maxTasksPerTick = () => envInt('OUTBOUND_MAX_TASKS_PER_TICK', 10);

/** How far back the cron looks for DUE tasks, so overdue tasks are never stranded. Default 14 days. */
export const taskLookbackMin = () =>
  envInt('OUTBOUND_TASK_LOOKBACK_MIN', 14 * 24 * 60);

/** Kill-switch for the atomic dispatch-once claim (default ON). */
export const dispatchClaimEnabled = () =>
  flagDefaultOn('OUTBOUND_TASK_DISPATCH_CLAIM');

/** Max chats the stalled-chat recovery sweep touches per tick, spread across running campaigns. */
export const stalledSweepMax = () => envInt('OUTBOUND_STALLED_SWEEP_MAX', 20);

/** Grace window before a chat with no pending proactive task counts as stalled. */
export const stalledGraceMin = () => envInt('OUTBOUND_STALLED_GRACE_MIN', 60);

/** Kill-switch for the deterministic `review_chat` reconcile (default ON). */
export const reviewChatEnabled = () =>
  flagDefaultOn('OUTBOUND_REVIEW_CHAT_ENABLED');

// ─────────────────────────────────────────────────────────────────────────────
// Cadence / dial guards
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum minutes between dials to the same prospect. */
export const dialRecencyFloorMin = () =>
  envInt('OUTBOUND_DIAL_RECENCY_FLOOR_MIN', 30);

/** Max minutes a call may sit awaiting review before the dial guard stops blocking on it. */
export const dialAwaitingReviewMaxMin = () =>
  envInt('OUTBOUND_DIAL_AWAITING_REVIEW_MAX_MIN', 360);

/** Minutes after which a placed-but-uncompleted call is reconciled as stale. */
export const stalePendingCallMin = () =>
  envInt('OUTBOUND_STALE_PENDING_CALL_MIN', 25);

/** Cadence caps before the lane is considered exhausted. */
export const maxEmailFollowups = () =>
  envInt('OUTBOUND_MAX_EMAIL_FOLLOWUPS', 4);
export const maxCallFollowups = () => envInt('OUTBOUND_MAX_CALL_FOLLOWUPS', 4);

/** Kill-switch for the TEST phone-first email fallback (default ON). */
export const testPhoneFirstEnabled = () =>
  flagDefaultOn('OUTBOUND_TEST_PHONE_FIRST');

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

export const maxConcurrentVoiceCalls = () =>
  envInt('OUTBOUND_MAX_CONCURRENT_VOICE_CALLS', 5);
export const voiceSlotTtlMinutes = () =>
  envInt('OUTBOUND_VOICE_SLOT_TTL_MINUTES', 20);

// ─────────────────────────────────────────────────────────────────────────────
// Email pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-agent hourly send ceiling. The default is **10**, matching the source exactly.
 *
 * An earlier revision of this file had 60, which would have let a warming domain send six times the
 * source's hourly rate — the precise failure the whole reputation layer exists to prevent. Both this
 * and the per-recipient default below are overridden per-agent by the SendGrid action's
 * `additional_meta`, so the env value only applies to an agent that leaves them unset.
 */
export const emailsPerHour = () => envInt('OUTBOUND_EMAILS_PER_HOUR', 10);
export const emailsPerRecipientPerDay = () =>
  envInt('EMAILS_PER_RECIPIENT_PER_DAY', 5);
export const domainDailyCap = () => envInt('DOMAIN_DAILY_CAP', 50);
export const domainStartDate = () => envStr('DOMAIN_START_DATE');
export const emailSandboxMode = () => flagDefaultOff('EMAIL_SANDBOX_MODE');
export const emailReactivationPolicyEnabled = () =>
  flagDefaultOff('EMAIL_REACTIVATION_POLICY_ENABLED');
export const allowCatchAll = () => flagDefaultOff('ALLOW_CATCH_ALL');
export const replyFreshnessHours = () => envInt('REPLY_FRESHNESS_HOURS', 168);
export const inboundNudgeFirstDelayHours = () =>
  envInt('INBOUND_NUDGE_FIRST_DELAY_HOURS', 4);
export const inboundNudgeOffsetsDays = () =>
  envIntList('INBOUND_NUDGE_OFFSETS_DAYS', '1,3,5,7');

/** CAN-SPAM footer identity + unsubscribe surface. */
export const companyName = () => envStr('COMPANY_NAME', 'Auto Acquire AI');
export const companyPostalAddress = () => envStr('COMPANY_POSTAL_ADDRESS');
export const unsubBaseUrl = () => envStr('UNSUB_BASE_URL');
export const unsubMailto = () => envStr('UNSUB_MAILTO');
export const unsubSigningKeyV1 = () => envStr('UNSUB_SIGNING_KEY_V1');
export const sendgridWebhookAllowUnsigned = () =>
  flagDefaultOff('SENDGRID_WEBHOOK_ALLOW_UNSIGNED');

// ─────────────────────────────────────────────────────────────────────────────
// Email verification / scraping providers
// ─────────────────────────────────────────────────────────────────────────────

export const verifyProvider = () => envStr('VERIFY_PROVIDER');
export const verifyCacheTtlDays = () => envInt('VERIFY_CACHE_TTL_DAYS', 30);
export const scraperProvider = () => envStr('SCRAPER_PROVIDER');
export const scraperUrlTemplate = () => envStr('SCRAPER_URL_TEMPLATE');
export const scraperEngine = () => envStr('SCRAPER_ENGINE');
export const scraperExtra = () => envStr('SCRAPER_EXTRA');

// ─────────────────────────────────────────────────────────────────────────────
// LLM
// ─────────────────────────────────────────────────────────────────────────────

/** Default provider when neither the model id nor meta_data selects one. */
export const llmProvider = () => envStr('LLM_PROVIDER', 'bedrock');
export const productionGroqChatHistoryLimit = () =>
  envInt('PRODUCTION_GROQ_CHAT_HISTORY_LIMIT', 60);

/** Kill-switch for the terminal-block short-circuit in the tool loop (default ON). */
export const terminalBlockShortcircuitEnabled = () =>
  flagDefaultOn('OUTBOUND_TERMINAL_BLOCK_SHORTCIRCUIT');

/** AWS region for Bedrock. Credentials are fetched via {@link requireEnv} at call time. */
export const awsRegion = () =>
  envStr('APP_AWS_REGION') || envStr('AWS_REGION', 'us-east-1');

// ─────────────────────────────────────────────────────────────────────────────
// Integration credential sets — the exact keys each integration needs.
// Passed to requireEnv at the call site so an unconfigured integration produces one clear error.
// ─────────────────────────────────────────────────────────────────────────────

export const CREDS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  bedrock: ['AWS_ACCESS_KEY', 'AWS_SECRET_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  sendgrid: ['SENDGRID_API_KEY'],
  hubspot: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'],
  dncscrub: ['DNCSCRUB_LOGIN_ID'],
  verify: ['VERIFY_API_KEY'],
  scraper: ['SCRAPER_API_KEY'],
} as const;

/** Public base URL used to build webhook + unsubscribe links. */
export const baseUrl = () => envStr('BASE_URL');

/** Default ElevenLabs voice, matching the source's fallback. */
export const elevenlabsVoiceId = () =>
  envStr('ELEVENLABS_VOICE_ID', 'kD4dEWy2fbcyXlge6iHh');

/** Post-call webhook secret; falls back to the shared ElevenLabs secret as in the source. */
export const elevenlabsOutboundWebhookSecret = () =>
  envStr('ELEVENLABS_OUTBOUND_WEBHOOK_SECRET') ||
  envStr('ELEVENLABS_WEBHOOK_SECRET');

export const twilioPhoneNumber = () => envStr('TWILIO_PHONE_NUMBER');
export const sendgridWebhookPublicKey = () =>
  envStr('SENDGRID_WEBHOOK_PUBLIC_KEY');
