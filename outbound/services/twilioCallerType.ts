/**
 * Twilio Lookup v2 — CNAM (caller-name) business/consumer classification.
 *
 * Line type comes from the DNCScrub Full Scrub; this module asks Twilio for the caller-name package
 * only, to learn whether a number is a business or a consumer:
 *
 *     GET https://lookups.twilio.com/v2/PhoneNumbers/{e164}?Fields=caller_name
 *     → body.caller_name.caller_type ∈ {"BUSINESS", "CONSUMER", null}
 *
 * CNAM is US-only and best-effort: many numbers have no name on file and come back with no
 * `caller_type`, reported here as `"unknown"`. Roughly $0.01 per lookup, hence the 180-day cache.
 *
 * The cache shares the `phone_lookups` collection with the inbound line-type cache, so CNAM fields
 * are written under distinct keys (`caller_type`, `caller_name`, `cnam_checked_at`) with `merge` —
 * the two caches coexist in one document per number and neither clobbers the other.
 *
 * Fail-open throughout: any error or missing name yields `caller_type: "unknown"`.
 *
 * NOTE: `phoneScreening` currently does NOT call this — the CNAM gate is disabled there because
 * coverage was too poor to be useful. The client is ported so re-enabling it is a one-line change.
 */

import { db } from '../firebase/db';
import { getSmsAccountsByAgent, getTwilioConnection } from '../firebase/twilio';
import { envStr } from '../config';
import { toDate } from '../firebase/db';

const CACHE_TTL_DAYS = 180;

export type CallerType = 'business' | 'consumer' | 'unknown';

export interface CallerTypeResult {
  caller_type: CallerType;
  caller_name: string | null;
  source: 'cache' | 'api' | 'disabled' | 'error';
  error?: string;
}

function normalizeE164(phone: unknown): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? '+' + digits : null;
}

/** `[accountSid, authToken]` for the agent's ACTIVE SMS connection, else `[null, null]`. */
async function resolveTwilioCredentials(
  agentId: string | null | undefined
): Promise<[string | null, string | null]> {
  if (!agentId) return [null, null];
  const accounts = await getSmsAccountsByAgent(agentId);
  const active = accounts.find((a) => a.status === 'active');
  if (!active) return [null, null];
  const conn = await getTwilioConnection(
    active.twilio_connection_id as string | undefined
  );
  if (!conn) return [null, null];
  return [
    (conn.account_sid as string) ?? null,
    (conn.auth_token as string) ?? null,
  ];
}

/** A cached caller type, if a FRESH CNAM entry exists. Expiry re-verifies, because CNAM decays. */
async function readCache(phoneE164: string): Promise<CallerTypeResult | null> {
  try {
    const doc = await db.collection('phone_lookups').doc(phoneE164).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    const checked = toDate(data.cnam_checked_at);
    const callerType = data.caller_type as CallerType | undefined;
    if (!checked || !callerType) return null;
    const ageDays = (Date.now() - checked.getTime()) / 86_400_000;
    if (ageDays >= CACHE_TTL_DAYS) return null;
    return {
      caller_type: callerType,
      caller_name: (data.caller_name as string) ?? null,
      source: 'cache',
    };
  } catch (e) {
    console.warn(`[CNAM] cache read failed for ${phoneE164}: ${e}`);
    return null;
  }
}

/** Persist the CNAM result under distinct keys, merging so the line-type cache survives. */
async function writeCache(
  phoneE164: string,
  callerType: CallerType,
  callerName: string | null
): Promise<void> {
  try {
    await db.collection('phone_lookups').doc(phoneE164).set(
      {
        caller_type: callerType,
        caller_name: callerName,
        cnam_checked_at: new Date(),
      },
      { merge: true }
    );
  } catch (e) {
    console.warn(`[CNAM] cache write failed for ${phoneE164}: ${e}`);
  }
}

function mapCallerType(raw: unknown): CallerType {
  const v = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (v === 'BUSINESS') return 'business';
  if (v === 'CONSUMER') return 'consumer';
  return 'unknown';
}

/**
 * Look up a number's caller type. Fail-open: any error, or no name on file, yields `"unknown"`.
 *
 * `TWILIO_LOOKUP_DISABLED` short-circuits before any I/O, which is how the paid lookup is switched
 * off wholesale in a test or cost-controlled environment.
 */
export async function lookupCallerType(
  phone: unknown,
  agentId?: string | null
): Promise<CallerTypeResult> {
  if (envStr('TWILIO_LOOKUP_DISABLED')) {
    return { caller_type: 'unknown', caller_name: null, source: 'disabled' };
  }

  const phoneE164 = normalizeE164(phone);
  if (!phoneE164) {
    return {
      caller_type: 'unknown',
      caller_name: null,
      source: 'error',
      error: 'invalid_phone',
    };
  }

  const cached = await readCache(phoneE164);
  if (cached) return cached;

  const [accountSid, authToken] = await resolveTwilioCredentials(agentId);
  if (!accountSid || !authToken) {
    console.warn(`[CNAM] no Twilio creds for agent=${agentId} — unknown`);
    return {
      caller_type: 'unknown',
      caller_name: null,
      source: 'error',
      error: 'no_twilio_credentials',
    };
  }

  let body: Record<string, unknown>;
  try {
    const creds = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const resp = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${phoneE164}?Fields=caller_name`,
      {
        headers: { Authorization: `Basic ${creds}` },
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!resp.ok) {
      console.warn(`[CNAM] HTTP ${resp.status} for ${phoneE164} — unknown`);
      return {
        caller_type: 'unknown',
        caller_name: null,
        source: 'error',
        error: `http_${resp.status}`,
      };
    }
    body = (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    console.warn(`[CNAM] lookup failed for ${phoneE164}: ${e} — unknown`);
    return {
      caller_type: 'unknown',
      caller_name: null,
      source: 'error',
      error: String(e).slice(0, 200),
    };
  }

  const cn = (body.caller_name ?? {}) as Record<string, unknown>;
  const callerType = mapCallerType(cn.caller_type);
  const callerName = (cn.caller_name as string) ?? null;
  await writeCache(phoneE164, callerType, callerName);
  return { caller_type: callerType, caller_name: callerName, source: 'api' };
}
