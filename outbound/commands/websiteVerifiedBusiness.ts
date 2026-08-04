/**
 * Backfill `aaai_website_verified_business_phone` — was the contact's own phone found listed on their
 * company website?
 *
 * The `business_only` campaign gate reads it to rescue a **verified business landline**: a number listed on
 * the company's own site that CNAM reports as unknown or consumer. Without it those leads are dropped, and
 * CNAM returns "unknown" for very nearly every number (see the Phase 4 note on why the CNAM gate is ported
 * but not called), so this property is what makes `business_only` usable at all rather than a filter that
 * rejects almost everything.
 *
 * ## The Playwright and scraping-provider ENGINES are not ported
 *
 * The source picks a fetch engine three ways: a configured scraping API, else headless Chromium via
 * Playwright when installed, else plain requests. This port keeps the provider path and the direct path,
 * and **drops Playwright**.
 *
 * Why: Playwright is a ~300MB browser download and a process lifecycle — the source needs a page counter,
 * a periodic recycle every 25 pages, and a teardown, because on its own author's machine Chromium wedges
 * after 25–50 pages. That is a substantial operational dependency in service of one backfill, and this
 * repo does not have it.
 *
 * The consequence is stated rather than hidden: **a JS-rendered or Cloudflare-protected site yields
 * `false`** — exactly what the source's own `SCRAPER_ENGINE=requests` mode does. Configure
 * `SCRAPER_PROVIDER` to get JS rendering back; that path renders and rotates proxies, and it is ported in
 * full. `fetchPage` is an injectable seam, so a Playwright fetcher can be dropped in later without
 * touching anything else here.
 *
 * ## `false` is written for a contact with no website, and that is the point
 *
 * Absent and `false` are different facts: absent means never checked, `false` means checked and not
 * listed. The gate needs to tell those apart, so every scanned contact gets a value.
 *
 * ## It flushes every TEN contacts, not every hundred
 *
 * Each contact costs a network fetch of someone else's website, so a page of a hundred takes minutes. The
 * source flushes small deliberately, so a run killed mid-page keeps most of its progress — the same reason
 * it returns a resumable cursor.
 */

import { getAgentActions } from '../firebase/agent';
import {
  HUBSPOT_BASE,
  accessToken,
  hsHeaders,
  resolveHubspotConfig,
} from '../services/hubspot';
import {
  batchUpdateContacts,
  ensureContactProperty,
} from '../services/hubspotAudiences';
import { envStr } from '../config';

/** The property this writes, and the only one it ever writes. */
export const WEBSITE_VERIFIED_PROP = 'aaai_website_verified_business_phone';

const SEARCH_PAGE = 100;
/** See the module note — small on purpose. */
const FLUSH_AT = 10;
const FETCH_TIMEOUT_MS = 8_000;
const PROVIDER_TIMEOUT_MS = 45_000;

/** Homepage only. The source trimmed the deeper paths: they are slow and rarely add a number. */
const PATHS = [''] as const;

const UA = 'Mozilla/5.0 (compatible; AvaOutbound/1.0)';

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const TEL_HREF_RE = /href\s*=\s*["']tel:([^"']+)["']/gi;
const TAG_RE = /<[^>]+>/g;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A phone reduced to its last ten digits, or `''` when there are fewer than ten.
 *
 * Comparing on the last ten is what makes the match work at all: a site writes `(303) 555-1212` and
 * HubSpot stores `+13035551212`, and a US country code is stripped so the two agree.
 */
export function last10(phone: unknown): string {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : '';
}

/**
 * A fetchable `http(s)` base URL, or `''` for anything that is not one.
 *
 * The junk this rejects is real: CRM website fields carry `ms-outlook://` values and bare words. A scheme
 * containing `://` is refused outright rather than coerced — prefixing `http://` onto `ms-outlook://x`
 * would produce a URL that resolves to nothing and costs a request to find out.
 *
 * ## Credentials in the parsed URL are refused, and this one is NOT in the source
 *
 * A `mailto:a@b.com` in the website field has no `://`, so both the source and this prefix it to
 * `http://mailto:a@b.com`. Python's `urlparse` reads that as host `mailto:a@b.com` and hands back a
 * garbage URL that simply fails to fetch. **WHATWG `URL` reads it as userinfo `mailto:a` plus host
 * `b.com`** — so a direct translation would fetch `b.com`, a real and unrelated domain, and could verify a
 * lead against a phone number on somebody else's website.
 *
 * That is a wrong answer rather than a missing one, so the port refuses any URL that parsed with a username
 * or password. A company website field never legitimately carries credentials, and the outcome — this
 * contact is not verifiable — matches what the source effectively produces by failing the fetch.
 */
export function normalizeUrl(raw: unknown): string {
  let u = String(raw ?? '').trim();
  if (!u) return '';
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    if (u.includes('://')) return '';
    u = `http://${u}`;
  }
  try {
    const p = new URL(u);
    if (p.username || p.password) return '';
    if (!p.host || !p.host.includes('.')) return '';
    return `${p.protocol}//${p.host}`;
  } catch {
    return '';
  }
}

/**
 * Every last-ten number on a page: `tel:` links first, then the visible text.
 *
 * A `tel:` link is the strongest signal — it is the number the business chose to make clickable — but the
 * set is unioned rather than short-circuited, because plenty of sites print the number without linking it.
 *
 * Ported with regexes rather than a DOM parser. The source uses BeautifulSoup and falls back to a plain
 * regex over the raw HTML when it is unavailable; this is that fallback plus the `tel:` extraction, which
 * is the part that mattered. Note that stripping tags leaves SCRIPT contents in the text, exactly as
 * BeautifulSoup's `get_text` does — which is how a JSON-LD `telephone` value is picked up.
 */
export function phonesFromHtml(html: string | null | undefined): Set<string> {
  const found = new Set<string>();
  const source = html ?? '';

  for (const m of source.matchAll(TEL_HREF_RE)) {
    const n = last10(m[1]);
    if (n) found.add(n);
  }

  const text = source.replace(TAG_RE, ' ');
  for (const m of text.matchAll(PHONE_RE)) {
    const n = last10(m[0]);
    if (n) found.add(n);
  }
  return found;
}

/**
 * The scraping-provider request URL for `targetUrl`, or `null` to fetch directly.
 *
 * Env-configured with no vendor lock-in: `SCRAPER_PROVIDER` is `scrapingbee`, `scraperapi`, or `raw`, and
 * `raw` builds from `SCRAPER_URL_TEMPLATE` with `{key}` and `{url}` placeholders — so a provider the source
 * never heard of works without a code change. Providers render JS and rotate proxies, which is what gets
 * past the 403 and anti-bot pages that block a direct fetch.
 */
export function providerUrl(targetUrl: string): string | null {
  const provider = envStr('SCRAPER_PROVIDER').toLowerCase();
  const key = envStr('SCRAPER_API_KEY');
  // `raw` is the only provider allowed to work without a key — its template may embed auth any way it likes.
  if (!provider || (provider !== 'raw' && !key)) return null;

  const enc = encodeURIComponent(targetUrl);
  const extraRaw = envStr('SCRAPER_EXTRA');
  const extra = extraRaw ? `&${extraRaw.replace(/^&+/, '')}` : '';

  if (provider === 'scrapingbee') {
    return `https://app.scrapingbee.com/api/v1/?api_key=${key}&render_js=true&url=${enc}${extra}`;
  }
  if (provider === 'scraperapi') {
    return `http://api.scraperapi.com/?api_key=${key}&render=true&url=${enc}${extra}`;
  }
  if (provider === 'raw') {
    const tmpl = envStr('SCRAPER_URL_TEMPLATE');
    if (!tmpl) return null;
    return tmpl.replace('{key}', key).replace('{url}', enc);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching
// ─────────────────────────────────────────────────────────────────────────────

/** One page fetch. `null` for any failure — a site we cannot read is simply not evidence. */
export type PageFetcher = (url: string) => Promise<string | null>;

/**
 * The default fetcher: a scraping provider when one is configured, else a direct request.
 *
 * Never throws. Every failure mode here — DNS, TLS, 403, timeout, a body that is not text — means the same
 * thing to the caller, and turning any of them into an exception would abort a sweep over one unreachable
 * dealer site.
 */
export const fetchPage: PageFetcher = async (url) => {
  const prov = providerUrl(url);
  try {
    const resp = prov
      ? await fetch(prov, {
          redirect: 'follow',
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        })
      : await fetch(url, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    if (resp.status >= 200 && resp.status < 300) {
      const text = await resp.text();
      return text || null;
    }
  } catch {
    // See the doc comment — every failure is the same non-answer.
  }
  return null;
};

/** Is `targetLast10` listed on the site? Checked across `PATHS`, which is the homepage. */
export async function phoneListedOnSite(
  baseUrl: string,
  targetLast10: string,
  fetcher: PageFetcher = fetchPage
): Promise<boolean> {
  for (const path of PATHS) {
    const html = await fetcher(baseUrl + path);
    if (html && phonesFromHtml(html).has(targetLast10)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The backfill
// ─────────────────────────────────────────────────────────────────────────────

export interface WebsiteVerifiedOptions {
  /**
   * Required, where the source defaults to a hardcoded production agent id. Same decision as the
   * area-code backfill in 10e¹: a literal id in a port is a value that silently rots, and a script that
   * writes to a customer's CRM should not have a default target.
   */
  agentId: string;
  filterProperty?: string;
  filterValue?: string;
  dryRun?: boolean;
  limit?: number;
  /** Resume from this `hs_object_id`, exclusive. */
  after?: string | null;
  /** Injectable for tests, and the seam a Playwright fetcher would plug into. */
  fetcher?: PageFetcher;
}

export interface WebsiteVerifiedResult {
  scanned: number;
  verified: number;
  no_website_or_phone: number;
  written: number;
  skipped_unchanged: number;
  last_id: string | null;
  dry_run: boolean;
  aborted?: string;
}

/**
 * Scan contacts and record whether each one's phone appears on their company website.
 *
 * Seek pagination on `hs_object_id`, for the same reason as the area-code backfill: HubSpot caps `after`
 * at 10,000 results, and an offset walk would truncate a larger audience while reporting success.
 *
 * Idempotent by comparing against the stored value, so a re-run costs reads plus the fetches — which are
 * the expensive part, and why `limit` and `after` exist.
 */
export async function backfillWebsiteVerifiedBusiness(
  options: WebsiteVerifiedOptions
): Promise<WebsiteVerifiedResult> {
  const {
    agentId,
    filterProperty = 'enriched_by_aaai_outbound',
    filterValue = 'true',
    dryRun = false,
    limit = 0,
    fetcher = fetchPage,
  } = options;

  const result: WebsiteVerifiedResult = {
    scanned: 0,
    verified: 0,
    no_website_or_phone: 0,
    written: 0,
    skipped_unchanged: 0,
    last_id: options.after ?? null,
    dry_run: dryRun,
  };

  const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
  const token = await accessToken(cfg, agentId);
  if (!token) {
    console.error('HubSpot auth failed (no token).');
    return { ...result, aborted: 'no_hubspot_auth' };
  }
  if (!dryRun) {
    const ok = await ensureContactProperty(
      token,
      WEBSITE_VERIFIED_PROP,
      'AAAI Website-Verified Business',
      'bool',
      'booleancheckbox'
    );
    if (!ok) {
      console.error(
        `Could not ensure property ${WEBSITE_VERIFIED_PROP}; aborting.`
      );
      return { ...result, aborted: 'property_missing' };
    }
  }

  const props = [
    'phone',
    'mobilephone',
    'website',
    ...(dryRun ? [] : [WEBSITE_VERIFIED_PROP]),
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
      const target = last10(p.phone || p.mobilephone || '');
      const base = normalizeUrl(p.website);

      let listed = false;
      if (target && base) {
        listed = await phoneListedOnSite(base, target, fetcher);
      } else {
        // Counted separately: "no site or no phone" is a data-quality number, not a verification result.
        result.no_website_or_phone += 1;
      }
      if (listed) result.verified += 1;

      // A string, because the property is a `booleancheckbox`. Written for EVERY contact — see the module
      // note on why absent and false are different facts.
      const value = listed ? 'true' : 'false';
      if (!dryRun) {
        if (String(p[WEBSITE_VERIFIED_PROP] ?? '') === value) {
          result.skipped_unchanged += 1;
        } else {
          pending.push({
            id: String(c.id),
            properties: { [WEBSITE_VERIFIED_PROP]: value },
          });
          if (pending.length >= FLUSH_AT) await flush();
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
