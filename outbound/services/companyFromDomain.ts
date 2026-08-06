/**
 * Derive a dealership's display name from an email domain, for contacts that arrive with no company.
 *
 * Many HubSpot contacts have no `company`, but their work email domain names the dealership
 * (`mbtemecula.com` → "Mercedes-Benz of Temecula"), which gives the agent something to talk about.
 *
 * ## The name is written to the CHAT only, never to HubSpot
 *
 * It is a guess, and a guess must not pollute the CRM. It lands on `memory.company`, and the enrollment
 * and HubSpot-sync paths guard on `_company_is_derived` so it is never pushed upstream. That flag is the
 * whole reason this can be used at all.
 *
 * An LLM does the mapping because abbreviations need interpretation (`mb`, `vw`, `chevy`, `cdjr`), and
 * each distinct domain is resolved ONCE and cached in Firestore. Free-mail domains resolve to `''` and
 * never reach the model. Best-effort throughout: never throws.
 */

import { db } from '../firebase/db';
import { llmText, parseJsonResponse } from '../tools/reviewHelpers';

const CACHE_COLLECTION = 'tool_configs';
const CACHE_DOC = 'domain_companies';

/** Domains per LLM call — bounded so a response cannot truncate mid-array. */
const COMPANY_BATCH = 40;

/**
 * Personal / free-mail domains → no company. Never sent to the model.
 *
 * Not just a cost saving: asking a model to name "the dealership at gmail.com" invites it to invent one,
 * and an invented company is worse than a blank because the agent would say it out loud.
 */
export const FREE_MAIL = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'aol.com',
  'me.com',
  'msn.com',
  'live.com',
  'comcast.net',
  'att.net',
  'verizon.net',
  'sbcglobal.net',
  'cox.net',
  'ymail.com',
  'protonmail.com',
  'proton.me',
  'mac.com',
  'gmx.com',
  'mail.com',
]);

const COMPANY_SYSTEM_PROMPT =
  "You convert a US car-dealership email DOMAIN into the dealership's proper display name, for a " +
  'sales agent to say in conversation. Expand common abbreviations: mb → Mercedes-Benz, vw → ' +
  'Volkswagen, chevy → Chevrolet, cdjr → Chrysler Dodge Jeep Ram, gmc stays GMC, bmw stays BMW. ' +
  "Insert 'of' where it reads naturally.\n" +
  'Examples:\n' +
  '  mbtemecula.com → Mercedes-Benz of Temecula\n' +
  '  toyotaofyakima.com → Toyota of Yakima\n' +
  '  burientoyota.com → Burien Toyota\n' +
  '  cartersubaru.com → Carter Subaru\n' +
  '  hellmanmotorco.com → Hellman Motor Co\n' +
  '  ebautobrokers.com → EB Auto Brokers\n' +
  'Return one entry per input domain, using the domain text exactly as provided. If a domain is ' +
  'generic, unclear, or clearly not a dealership, return an empty string for its company.\n\n' +
  'Respond with JSON only, shaped ' +
  '{"results": [{"domain": "<verbatim domain>", "company": "<name or empty string>"}]}.';

/** The domain part of an email, lowercased. `''` when there is no `@`. */
export function domainOf(email: unknown): string {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  return e.includes('@') ? e.split('@').pop()! : '';
}

export function isFreeMail(domain: unknown): boolean {
  return FREE_MAIL.has(
    String(domain ?? '')
      .trim()
      .toLowerCase()
  );
}

/**
 * LLM-map DISTINCT business domains → `{domain: companyName}`.
 *
 * Chunked at `COMPANY_BATCH`. Entries the model returns blank are kept out of the result, so a caller
 * sees "no company" rather than an empty string it might render.
 */
export async function companyFromDomainsLlm(
  domains: readonly string[]
): Promise<Record<string, string>> {
  const uniq = [
    ...new Set(
      (domains ?? [])
        .map((d) =>
          String(d ?? '')
            .trim()
            .toLowerCase()
        )
        .filter((d) => d && !isFreeMail(d))
    ),
  ];
  if (uniq.length === 0) return {};

  if (uniq.length > COMPANY_BATCH) {
    const out: Record<string, string> = {};
    for (let i = 0; i < uniq.length; i += COMPANY_BATCH) {
      Object.assign(
        out,
        await companyFromDomainsLlm(uniq.slice(i, i + COMPANY_BATCH))
      );
    }
    return out;
  }

  const userPrompt =
    'Map these email domains:\n' +
    uniq.map((d) => `- ${d}`).join('\n') +
    '\n\nReturn the JSON now.';

  try {
    const raw = await llmText(COMPANY_SYSTEM_PROMPT, userPrompt);
    if (!raw) {
      console.warn(`[DOMAIN_CO] empty LLM response for ${uniq.length} domains`);
      return {};
    }
    const parsed = parseJsonResponse(raw);
    const out: Record<string, string> = {};
    for (const item of (parsed.results ?? []) as Array<
      Record<string, unknown>
    >) {
      const d = String(item?.domain ?? '')
        .trim()
        .toLowerCase();
      const company = String(item?.company ?? '').trim();
      if (d && company) out[d] = company;
    }
    return out;
  } catch (e) {
    console.warn(
      `[DOMAIN_CO] LLM mapping failed for ${uniq.length} domains: ${e}`
    );
    return {};
  }
}

async function readCache(): Promise<Record<string, string>> {
  try {
    const doc = await db.collection(CACHE_COLLECTION).doc(CACHE_DOC).get();
    if (!doc.exists) return {};
    return ((doc.data() ?? {}).companies ?? {}) as Record<string, string>;
  } catch (e) {
    console.warn(`[DOMAIN_CO] cache read failed: ${e}`);
    return {};
  }
}

async function writeCache(newMap: Record<string, string>): Promise<void> {
  if (Object.keys(newMap).length === 0) return;
  try {
    await db
      .collection(CACHE_COLLECTION)
      .doc(CACHE_DOC)
      .set({ companies: newMap }, { merge: true });
  } catch (e) {
    console.warn(`[DOMAIN_CO] cache write failed: ${e}`);
  }
}

/**
 * `{domain: companyName}` for business domains, LLM-mapping only what is not cached.
 *
 * Free-mail domains are dropped before the cache is even consulted, and domains that resolved to a blank
 * are omitted from the result entirely.
 */
export async function getCompanyNames(
  domains: readonly string[]
): Promise<Record<string, string>> {
  const wanted = new Set(
    (domains ?? [])
      .map((d) =>
        String(d ?? '')
          .trim()
          .toLowerCase()
      )
      .filter((d) => d && !isFreeMail(d))
  );
  if (wanted.size === 0) return {};

  const cache = await readCache();
  const missing = [...wanted].filter((d) => !(d in cache));
  if (missing.length > 0) {
    const fresh = await companyFromDomainsLlm(missing);
    if (Object.keys(fresh).length > 0) {
      await writeCache(fresh);
      Object.assign(cache, fresh);
    }
  }

  const out: Record<string, string> = {};
  for (const d of wanted) if (cache[d]) out[d] = cache[d];
  return out;
}

/**
 * A dealership name for one email, or `''` for free-mail and anything without a domain.
 *
 * Hits the cache; the model is consulted only for a domain never seen before.
 */
export async function companyForEmail(email: unknown): Promise<string> {
  const d = domainOf(email);
  if (!d || isFreeMail(d)) return '';
  return (await getCompanyNames([d]))[d] ?? '';
}
