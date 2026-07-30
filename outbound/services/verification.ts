/**
 * Email verification — layered, cheapest-first, cached in Firestore `email_verification/{email}`.
 *
 * Layers: syntax → disposable-domain list → role local-parts → MX lookup → provider API.
 *
 * ## The provider is an upgrade, not a prerequisite
 *
 * With **no provider key configured, an MX pass IS a pass**. This is the load-bearing decision in the
 * module: a missing API key must never halt all mail. It also means `risky` and `unknown` are only
 * ever returned by an actual provider verdict — the local layers only ever say `valid` or `invalid`,
 * except for role addresses, which are provider-independently risky.
 *
 * ## It never SMTP-probes
 *
 * Port 25 is blocked on essentially every cloud host, and probing hurts sender reputation with the
 * very providers we need to stay in good standing with. MX presence is as far as local checking goes.
 *
 * Results drive the caller: `invalid` → suppress (`verify-invalid`) and skip; `risky`/`unknown` →
 * skip but do NOT suppress, because the address may well be fine; `valid` → proceed.
 */

import { promises as dnsPromises } from 'node:dns';

import { db } from '../firebase/db';
import { envStr, verifyCacheTtlDays } from '../config';

export const COLLECTION = 'email_verification';

export type VerifyResult = 'valid' | 'invalid' | 'risky' | 'unknown';

export interface VerifyOutcome {
  result: VerifyResult;
  detail: string;
  cached?: boolean;
}

const SYNTAX_RE = /^[A-Za-z0-9._%+\-']+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Common disposable/throwaway domains — enough to catch the obvious trash. The provider API, when
 * configured, covers the long tail; this list is deliberately not exhaustive.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'getnada.com',
  'trashmail.com',
  'sharklasers.com',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com',
  'mintemail.com',
  'spamgourmet.com',
  'mytemp.email',
  'burnermail.io',
  'tempinbox.com',
  'emailondeck.com',
  'mohmal.com',
]);

/** Role addresses — deliverable, but rarely a person. Provider-independently `risky`. */
const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'info',
  'sales',
  'support',
  'admin',
  'contact',
  'office',
  'hello',
  'help',
  'billing',
  'noreply',
  'no-reply',
  'donotreply',
  'webmaster',
  'postmaster',
  'abuse',
  'marketing',
  'hr',
]);

function norm(email: unknown): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

async function readCache(email: string): Promise<VerifyOutcome | null> {
  try {
    const doc = await db.collection(COLLECTION).doc(email).get();
    if (!doc.exists) return null;
    const d = doc.data() ?? {};
    const checkedAt = d.checked_at;
    if (checkedAt) {
      const ts = new Date(String(checkedAt).replace('Z', '+00:00'));
      const ageDays = (Date.now() - ts.getTime()) / 86_400_000;
      if (!Number.isNaN(ts.getTime()) && ageDays < verifyCacheTtlDays()) {
        return {
          result: (d.result as VerifyResult) ?? 'unknown',
          detail: String(d.detail ?? ''),
          cached: true,
        };
      }
    }
    return null; // expired — re-verify, because deliverability decays
  } catch (e) {
    console.warn(`[VERIFY] cache read failed for ${email}: ${e}`);
    return null;
  }
}

async function writeCache(
  email: string,
  result: VerifyResult,
  detail: string
): Promise<void> {
  try {
    await db.collection(COLLECTION).doc(email).set({
      result,
      detail,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[VERIFY] cache write failed for ${email}: ${e}`);
  }
}

/**
 * True if the domain has an MX record — or, failing that, an A/AAAA record, which per RFC 5321's
 * implicit-MX rule still accepts mail.
 */
async function mxExists(domain: string, timeoutMs: number): Promise<boolean> {
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('dns timeout')), timeoutMs)
      ),
    ]);
  try {
    const answers = await withTimeout(dnsPromises.resolveMx(domain));
    if (answers.length > 0) return true;
  } catch (e) {
    // No MX, or a lookup error. Fall through to the implicit-MX A/AAAA check below; a genuine
    // infrastructure fault is handled by the caller, which treats a throw as an unknown-pass.
    const code = (e as { code?: string }).code;
    if (code && code !== 'ENODATA' && code !== 'ENOTFOUND') throw e;
  }
  try {
    await withTimeout(dnsPromises.resolve4(domain));
    return true;
  } catch {
    return false;
  }
}

/**
 * Optional provider adapter, selected by `VERIFY_PROVIDER` + `VERIFY_API_KEY`.
 *
 * Returns `null` when unconfigured OR on any error — the caller then trusts the MX layer, which is
 * what keeps a provider outage from halting all mail. A catch-all or unrecognized verdict maps to
 * `risky` (skip, do not suppress) rather than `invalid`, because a catch-all domain says nothing
 * about the individual mailbox.
 */
async function providerCheck(email: string): Promise<VerifyOutcome | null> {
  const provider = envStr('VERIFY_PROVIDER').trim().toLowerCase();
  const apiKey = envStr('VERIFY_API_KEY').trim();
  if (!provider || !apiKey) return null;

  const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return (await resp.json()) as Record<string, unknown>;
  };

  try {
    if (provider === 'zerobounce') {
      const d = await fetchJson(
        `https://api.zerobounce.net/v2/validate?api_key=${apiKey}&email=${encodeURIComponent(email)}`
      );
      const status = String(d.status ?? '').toLowerCase();
      const sub = String(d.sub_status ?? '').toLowerCase();
      if (status === 'valid') {
        return { result: 'valid', detail: `zerobounce:${status}` };
      }
      if (['invalid', 'spamtrap', 'abuse', 'do_not_mail'].includes(status)) {
        return { result: 'invalid', detail: `zerobounce:${status}/${sub}` };
      }
      return { result: 'risky', detail: `zerobounce:${status}/${sub}` };
    }

    if (['neverbounce', 'millionverifier', 'emailable'].includes(provider)) {
      const e = encodeURIComponent(email);
      const urls: Record<string, string> = {
        neverbounce: `https://api.neverbounce.com/v4/single/check?key=${apiKey}&email=${e}`,
        millionverifier: `https://api.millionverifier.com/api/v3/?api=${apiKey}&email=${e}`,
        emailable: `https://api.emailable.com/v1/verify?api_key=${apiKey}&email=${e}`,
      };
      const d = await fetchJson(urls[provider]);
      const raw = String(d.result ?? d.state ?? '').toLowerCase();
      if (['valid', 'deliverable', 'ok'].includes(raw)) {
        return { result: 'valid', detail: `${provider}:${raw}` };
      }
      if (['invalid', 'undeliverable', 'disposable'].includes(raw)) {
        return { result: 'invalid', detail: `${provider}:${raw}` };
      }
      return { result: 'risky', detail: `${provider}:${raw}` };
    }

    console.warn(
      `[VERIFY] unknown provider '${provider}' — skipping provider layer`
    );
    return null;
  } catch (e) {
    console.warn(`[VERIFY] provider check failed (${e}) — trusting MX layer`);
    return null;
  }
}

/** Layered verification with a cache. */
export async function verify(
  emailRaw: string,
  mxTimeoutMs = 5_000
): Promise<VerifyOutcome> {
  const email = norm(emailRaw);
  if (!email) return { result: 'invalid', detail: 'empty' };

  const cached = await readCache(email);
  if (cached) return cached;

  // 1. Syntax / length.
  if (email.length > 254 || !SYNTAX_RE.test(email)) {
    await writeCache(email, 'invalid', 'syntax');
    return { result: 'invalid', detail: 'syntax' };
  }
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  // 2. Disposable domain.
  if (DISPOSABLE_DOMAINS.has(domain)) {
    await writeCache(email, 'invalid', 'disposable-domain');
    return { result: 'invalid', detail: 'disposable-domain' };
  }

  // 3. Role local-part → risky (deliverable, rarely a person).
  if (ROLE_LOCAL_PARTS.has(local)) {
    await writeCache(email, 'risky', 'role-address');
    return { result: 'risky', detail: 'role-address' };
  }

  // 4. MX lookup. A DNS infrastructure fault must not halt all mail, so a throw is an unknown-pass.
  let hasMx: boolean;
  try {
    hasMx = await mxExists(domain, mxTimeoutMs);
  } catch (e) {
    console.warn(
      `[VERIFY] MX lookup errored for ${domain} (${e}) — treating as unknown-pass`
    );
    hasMx = true;
  }
  if (!hasMx) {
    await writeCache(email, 'invalid', 'no-mx');
    return { result: 'invalid', detail: 'no-mx' };
  }

  // 5. Provider API — an OPTIONAL upgrade. No key → MX-pass is a pass.
  const provider = await providerCheck(email);
  if (provider === null) {
    await writeCache(email, 'valid', 'mx-pass');
    return { result: 'valid', detail: 'mx-pass' };
  }
  await writeCache(email, provider.result, provider.detail);
  return provider;
}
