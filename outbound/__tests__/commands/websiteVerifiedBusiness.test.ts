/**
 * @jest-environment node
 *
 * The website-verified-business backfill.
 *
 * The extraction helpers get the most attention, because they decide whether a lead survives the
 * `business_only` gate — and a false negative there silently drops a reachable prospect:
 *
 *  - **Last-ten matching** is what makes a site's `(303) 555-1212` equal HubSpot's `+13035551212`.
 *  - **`tel:` links and visible text are UNIONED**, because plenty of sites print a number without linking
 *    it, and plenty link one they never print.
 *  - **A URL that is not http(s) is refused**, not coerced — CRM website fields really do carry
 *    `ms-outlook://` values.
 *
 * Plus the write discipline: `false` is recorded for a contact with no site (absent and false are different
 * facts), and exactly one property is ever written.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/agent', () => ({ getAgentActions: jest.fn() }));
jest.mock('../../services/hubspot', () => {
  const actual = jest.requireActual('../../services/hubspot');
  return {
    ...actual,
    accessToken: jest.fn(),
    resolveHubspotConfig: jest.fn(),
  };
});
jest.mock('../../services/hubspotAudiences', () => {
  const actual = jest.requireActual('../../services/hubspotAudiences');
  return {
    ...actual,
    batchUpdateContacts: jest.fn(),
    ensureContactProperty: jest.fn(),
  };
});

import {
  WEBSITE_VERIFIED_PROP,
  backfillWebsiteVerifiedBusiness,
  last10,
  normalizeUrl,
  phoneListedOnSite,
  phonesFromHtml,
  providerUrl,
} from '../../commands/websiteVerifiedBusiness';
import { getAgentActions } from '../../firebase/agent';
import { accessToken, resolveHubspotConfig } from '../../services/hubspot';
import {
  batchUpdateContacts,
  ensureContactProperty,
} from '../../services/hubspotAudiences';

const AGENT = 'agentA';

let fetchMock: jest.Mock;

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function bodyOf(n: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[n][1].body));
}

const SCRAPER_ENV = [
  'SCRAPER_PROVIDER',
  'SCRAPER_API_KEY',
  'SCRAPER_EXTRA',
  'SCRAPER_URL_TEMPLATE',
];

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of SCRAPER_ENV) delete process.env[k];
  (getAgentActions as jest.Mock).mockResolvedValue([]);
  (resolveHubspotConfig as jest.Mock).mockReturnValue({ access_token: 'tok' });
  (accessToken as jest.Mock).mockResolvedValue('tok');
  (ensureContactProperty as jest.Mock).mockResolvedValue(true);
  (batchUpdateContacts as jest.Mock).mockImplementation(
    async (_t: string, u: unknown[]) => ({ updated: u.length, error: null })
  );
  fetchMock = jest.fn().mockResolvedValue(ok({ results: [] }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
  for (const k of SCRAPER_ENV) delete process.env[k];
});

// ─────────────────────────────────────────────────────────────────────────────
// last10
// ─────────────────────────────────────────────────────────────────────────────

describe('last10', () => {
  it.each([
    ['+13035551212', '3035551212'],
    ['(303) 555-1212', '3035551212'],
    ['303.555.1212', '3035551212'],
    ['1-303-555-1212', '3035551212'],
    // 11 digits NOT starting with 1 — keep the last ten rather than assuming a country code.
    ['23035551212', '3035551212'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(last10(input)).toBe(expected);
  });

  it.each([['555-1212'], [''], [null], ['abc'], ['12345']])(
    'is empty for %p — fewer than ten digits is not a phone',
    (input) => {
      expect(last10(input)).toBe('');
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  it('reduces a URL to scheme + host', () => {
    expect(normalizeUrl('https://acme.com/about/contact?x=1')).toBe(
      'https://acme.com'
    );
  });

  it('adds http:// to a bare host', () => {
    expect(normalizeUrl(' acme.com ')).toBe('http://acme.com');
  });

  it('keeps a port and a subdomain', () => {
    expect(normalizeUrl('www.acme.com:8080')).toBe('http://www.acme.com:8080');
  });

  it.each([['ms-outlook://x'], ['ftp://acme.com']])(
    'REFUSES the non-web scheme %p rather than coercing it',
    (input) => {
      // Prefixing http:// onto these makes a URL that resolves to nothing and costs a request to find out.
      expect(normalizeUrl(input)).toBe('');
    }
  );

  it.each([['mailto:a@b.com'], ['http://user:pw@acme.com']])(
    'refuses %p, which WHATWG URL would parse as userinfo plus a REAL host',
    (input) => {
      // The divergence this exists to prevent: `mailto:a@b.com` has no `://`, so it gets prefixed to
      // `http://mailto:a@b.com`. Python's urlparse reads that as host `mailto:a@b.com` — garbage that fails
      // to fetch. `new URL` reads it as userinfo `mailto:a` plus host `b.com`, so a direct translation
      // would fetch an unrelated real domain and could verify a lead against someone else's phone number.
      expect(normalizeUrl(input)).toBe('');
    }
  );

  it.each([[''], [null], ['localhost'], ['not a url'], ['  ']])(
    'is empty for %p',
    (input) => {
      // A host with no dot is not a company website.
      expect(normalizeUrl(input)).toBe('');
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// phonesFromHtml
// ─────────────────────────────────────────────────────────────────────────────

describe('phonesFromHtml', () => {
  it('extracts from a tel: link', () => {
    expect(phonesFromHtml('<a href="tel:+1-303-555-1212">Call us</a>')).toEqual(
      new Set(['3035551212'])
    );
  });

  it('UNIONS tel: links and visible text', () => {
    // Sites print numbers they never link, and link numbers they never print.
    const html =
      '<a href="tel:3035551212">Sales</a><p>Service: (770) 555-1212</p>';
    expect(phonesFromHtml(html)).toEqual(new Set(['3035551212', '7705551212']));
  });

  it('reads a number out of a JSON-LD script block', () => {
    // Stripping tags leaves SCRIPT contents in the text, exactly as BeautifulSoup's get_text does.
    const html =
      '<script type="application/ld+json">{"telephone":"+1 303 555 1212"}</script>';
    expect(phonesFromHtml(html)).toEqual(new Set(['3035551212']));
  });

  it('handles single quotes and spacing in the href', () => {
    expect(phonesFromHtml("<a href = 'tel:3035551212'>x</a>")).toEqual(
      new Set(['3035551212'])
    );
  });

  it('is empty for a page with no numbers, and for nothing at all', () => {
    expect(phonesFromHtml('<p>Contact us online</p>')).toEqual(new Set());
    expect(phonesFromHtml(null)).toEqual(new Set());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// providerUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('providerUrl', () => {
  it('is null with nothing configured — fetch directly', () => {
    expect(providerUrl('https://acme.com')).toBeNull();
  });

  it('builds a ScrapingBee URL with JS rendering on', () => {
    process.env.SCRAPER_PROVIDER = 'ScrapingBee';
    process.env.SCRAPER_API_KEY = 'k1';
    expect(providerUrl('https://acme.com/a b')).toBe(
      'https://app.scrapingbee.com/api/v1/?api_key=k1&render_js=true&url=https%3A%2F%2Facme.com%2Fa%20b'
    );
  });

  it('builds a ScraperAPI URL', () => {
    process.env.SCRAPER_PROVIDER = 'scraperapi';
    process.env.SCRAPER_API_KEY = 'k1';
    expect(providerUrl('https://acme.com')).toContain(
      'api.scraperapi.com/?api_key=k1&render=true'
    );
  });

  it('appends SCRAPER_EXTRA, normalizing a leading ampersand', () => {
    process.env.SCRAPER_PROVIDER = 'scrapingbee';
    process.env.SCRAPER_API_KEY = 'k1';
    process.env.SCRAPER_EXTRA = '&premium_proxy=true';
    expect(providerUrl('https://acme.com')).toMatch(/&premium_proxy=true$/);
    expect(providerUrl('https://acme.com')).not.toContain('&&');
  });

  it('builds from a raw template, which needs no key', () => {
    // The no-lock-in escape hatch: a provider the source never heard of works without a code change, and
    // its template may embed auth however it likes.
    process.env.SCRAPER_PROVIDER = 'raw';
    process.env.SCRAPER_URL_TEMPLATE = 'https://p.example/{key}/get?u={url}';
    expect(providerUrl('https://acme.com')).toBe(
      'https://p.example//get?u=https%3A%2F%2Facme.com'
    );
  });

  it('is null for raw with no template', () => {
    process.env.SCRAPER_PROVIDER = 'raw';
    expect(providerUrl('https://acme.com')).toBeNull();
  });

  it('is null for a named provider with no key', () => {
    process.env.SCRAPER_PROVIDER = 'scrapingbee';
    expect(providerUrl('https://acme.com')).toBeNull();
  });

  it('is null for an unrecognised provider', () => {
    process.env.SCRAPER_PROVIDER = 'somethingelse';
    process.env.SCRAPER_API_KEY = 'k1';
    expect(providerUrl('https://acme.com')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phoneListedOnSite
// ─────────────────────────────────────────────────────────────────────────────

describe('phoneListedOnSite', () => {
  it('is true when the number is on the page', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue('<a href="tel:3035551212">x</a>');
    expect(
      await phoneListedOnSite('https://acme.com', '3035551212', fetcher)
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://acme.com');
  });

  it('is false when a DIFFERENT number is listed', async () => {
    const fetcher = jest.fn().mockResolvedValue('<p>(770) 555-1212</p>');
    expect(
      await phoneListedOnSite('https://acme.com', '3035551212', fetcher)
    ).toBe(false);
  });

  it('is false — never a throw — when the page cannot be fetched', async () => {
    // A site we cannot read is not evidence. This is the documented consequence of dropping Playwright: a
    // JS-rendered or Cloudflare-protected site lands here.
    const fetcher = jest.fn().mockResolvedValue(null);
    expect(
      await phoneListedOnSite('https://acme.com', '3035551212', fetcher)
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillWebsiteVerifiedBusiness
// ─────────────────────────────────────────────────────────────────────────────

describe('backfillWebsiteVerifiedBusiness', () => {
  function page(contacts: Array<Record<string, unknown>>) {
    return ok({ results: contacts });
  }

  const listed: jest.Mock = jest.fn();

  beforeEach(() => {
    listed.mockReset();
    listed.mockResolvedValue('<a href="tel:3035551212">x</a>');
  });

  it('verifies a contact whose phone is on their site, writing ONE property', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        {
          id: '1',
          properties: { phone: '+13035551212', website: 'acme.com' },
        },
      ])
    );
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      fetcher: listed,
    });
    expect(out).toMatchObject({ scanned: 1, verified: 1, written: 1 });
    expect(batchUpdateContacts).toHaveBeenCalledWith('tok', [
      { id: '1', properties: { [WEBSITE_VERIFIED_PROP]: 'true' } },
    ]);
  });

  it('records "false" for a contact with NO website — absent and false differ', async () => {
    // The gate needs to tell "checked, not listed" from "never checked".
    fetchMock.mockResolvedValueOnce(
      page([{ id: '1', properties: { phone: '+13035551212' } }])
    );
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      fetcher: listed,
    });
    expect(out).toMatchObject({
      scanned: 1,
      verified: 0,
      no_website_or_phone: 1,
    });
    expect(batchUpdateContacts).toHaveBeenCalledWith('tok', [
      { id: '1', properties: { [WEBSITE_VERIFIED_PROP]: 'false' } },
    ]);
    // No fetch attempted — there was nothing to fetch.
    expect(listed).not.toHaveBeenCalled();
  });

  it('counts a contact with no PHONE the same way', async () => {
    fetchMock.mockResolvedValueOnce(
      page([{ id: '1', properties: { website: 'acme.com' } }])
    );
    expect(
      (
        await backfillWebsiteVerifiedBusiness({
          agentId: AGENT,
          fetcher: listed,
        })
      ).no_website_or_phone
    ).toBe(1);
  });

  it('falls back to mobilephone, and normalizes a messy website value', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        {
          id: '1',
          properties: {
            mobilephone: '(303) 555-1212',
            website: 'https://acme.com/about?x=1',
          },
        },
      ])
    );
    await backfillWebsiteVerifiedBusiness({ agentId: AGENT, fetcher: listed });
    expect(listed).toHaveBeenCalledWith('https://acme.com');
  });

  it('SKIPS a contact whose stored value already matches', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        {
          id: '1',
          properties: {
            phone: '+13035551212',
            website: 'acme.com',
            [WEBSITE_VERIFIED_PROP]: 'true',
          },
        },
      ])
    );
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      fetcher: listed,
    });
    expect(out.skipped_unchanged).toBe(1);
    expect(batchUpdateContacts).not.toHaveBeenCalled();
  });

  it('flushes every TEN contacts, so a killed run keeps most of its progress', async () => {
    // Each contact costs a fetch of someone else's website, so a page of 100 takes minutes.
    const contacts = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 1),
      properties: { phone: '+13035551212', website: 'acme.com' },
    }));
    fetchMock.mockResolvedValueOnce(page(contacts));
    await backfillWebsiteVerifiedBusiness({ agentId: AGENT, fetcher: listed });
    // 10 + 10 + a final flush of 5.
    expect(batchUpdateContacts).toHaveBeenCalledTimes(3);
    expect((batchUpdateContacts as jest.Mock).mock.calls[0][1]).toHaveLength(
      10
    );
    expect((batchUpdateContacts as jest.Mock).mock.calls[2][1]).toHaveLength(5);
  });

  it('pages by SEEK on hs_object_id', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      properties: {},
    }));
    fetchMock
      .mockResolvedValueOnce(page(first))
      .mockResolvedValueOnce(page([{ id: '101', properties: {} }]));
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      fetcher: listed,
    });
    expect(out.scanned).toBe(101);
    const filters = (
      bodyOf(1).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters[1]).toEqual({
      propertyName: 'hs_object_id',
      operator: 'GT',
      value: '100',
    });
    expect(bodyOf(1).after).toBeUndefined();
  });

  it('resumes from a supplied cursor and returns the last id', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: '600', properties: {} }]));
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      after: '500',
      fetcher: listed,
    });
    const filters = (
      bodyOf(0).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters[1]).toMatchObject({ operator: 'GT', value: '500' });
    expect(out.last_id).toBe('600');
  });

  it('stops at the limit mid-page', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: '1', properties: {} },
        { id: '2', properties: {} },
        { id: '3', properties: {} },
      ])
    );
    expect(
      (
        await backfillWebsiteVerifiedBusiness({
          agentId: AGENT,
          limit: 2,
          fetcher: listed,
        })
      ).scanned
    ).toBe(2);
  });

  it('honours a custom scoping filter', async () => {
    await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      filterProperty: 'hs_lead_status',
      filterValue: 'NEW',
      fetcher: listed,
    });
    const filters = (
      bodyOf(0).filterGroups as Array<Record<string, unknown>>
    )[0].filters as Array<Record<string, unknown>>;
    expect(filters[0]).toEqual({
      propertyName: 'hs_lead_status',
      operator: 'EQ',
      value: 'NEW',
    });
  });

  it('under dryRun creates nothing, writes nothing, and does not read the property', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: '1', properties: { phone: '+13035551212', website: 'acme.com' } },
      ])
    );
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      dryRun: true,
      fetcher: listed,
    });
    expect(ensureContactProperty).not.toHaveBeenCalled();
    expect(batchUpdateContacts).not.toHaveBeenCalled();
    expect(bodyOf(0).properties).toEqual(['phone', 'mobilephone', 'website']);
    // It still FETCHES, so the verified count is the real answer — that is the point of a dry run here.
    expect(out).toMatchObject({ scanned: 1, verified: 1, written: 0 });
  });

  it.each([
    [
      'no_hubspot_auth',
      () => (accessToken as jest.Mock).mockResolvedValue(null),
    ],
    [
      'property_missing',
      () => (ensureContactProperty as jest.Mock).mockResolvedValue(false),
    ],
  ])('aborts with %p before searching', async (aborted, arrange) => {
    arrange();
    expect(
      await backfillWebsiteVerifiedBusiness({ agentId: AGENT, fetcher: listed })
    ).toMatchObject({ aborted });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops on a failed search but flushes what it queued', async () => {
    const contacts = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      properties: { phone: '+13035551212', website: 'acme.com' },
    }));
    fetchMock
      .mockResolvedValueOnce(page(contacts))
      .mockResolvedValueOnce(ok({}, 500));
    const out = await backfillWebsiteVerifiedBusiness({
      agentId: AGENT,
      fetcher: listed,
    });
    expect(out.scanned).toBe(100);
    expect(out.written).toBe(100);
    expect(out.last_id).toBe('100');
  });
});
