import FirecrawlApp from '@mendable/firecrawl-js';
import { db } from '../firebase/admin';
import { updateCrawlSession } from '../db/crawlSessions';
import type { CrawlTarget } from '../agents/crawlStrategyAgent';

if (!process.env.FIRECRAWL_API_KEY) {
  throw new Error('Missing required environment variable: FIRECRAWL_API_KEY');
}

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const BLOCKED_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'linkedin.com',
  'pinterest.com',
  'snapchat.com',
  'amazon.com',
  'etsy.com',
  'ebay.com',
  'walmart.com',
  'shopify.com',
  'aliexpress.com',
  'alibaba.com',
];

function isBlockedUrl(url: string, sourceHost: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const source = sourceHost.replace(/^www\./, '');
    if (host === source) return true;
    return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

function extractBrandUrls(links: string[], sourceUrl: string): string[] {
  const sourceHost = new URL(sourceUrl).hostname;
  const seen = new Set<string>();
  const results: string[] = [];

  for (const link of links) {
    try {
      const parsed = new URL(link);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (isBlockedUrl(link, sourceHost)) continue;
      const normalized = `${parsed.protocol}//${parsed.hostname}`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push(normalized);
      }
    } catch {
      continue;
    }
  }

  return results;
}

async function scrapeWithTimeout(url: string): Promise<string[]> {
  const timer = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 15_000)
  );

  try {
    const result = await Promise.race([
      firecrawl.scrape(url, { formats: ['links'] }),
      timer,
    ]);

    if (result === null) {
      console.error(`Firecrawl timeout for ${url}`);
      return [];
    }

    return result.links ?? [];
  } catch (err) {
    console.error(`Firecrawl request failed for ${url}:`, err);
    return [];
  }
}

async function getExistingDedupHashes(): Promise<Set<string>> {
  const snapshot = await db.collection('leads').select('dedupHash').get();
  return new Set(snapshot.docs.map((d) => d.data().dedupHash as string));
}

function dedupHash(url: string): string {
  return url.toLowerCase().replace(/\/$/, '');
}

export interface ProspectorResult {
  nicheId: string;
  brandUrls: string[];
}

export async function runAutoProspector(
  crawlTargets: CrawlTarget[],
  crawlSessionId: string
): Promise<ProspectorResult[]> {
  const existingHashes = await getExistingDedupHashes();
  const results: ProspectorResult[] = [];
  const allDiscovered: string[] = [];

  for (const target of crawlTargets) {
    const nicheUrls = new Set<string>();

    for (const url of target.urls) {
      const links = await scrapeWithTimeout(url);
      const brandUrls = extractBrandUrls(links, url);

      for (const brandUrl of brandUrls) {
        const hash = dedupHash(brandUrl);
        if (!existingHashes.has(hash)) {
          nicheUrls.add(brandUrl);
          existingHashes.add(hash);
        }
      }
    }

    const brandUrlsArray = Array.from(nicheUrls);
    allDiscovered.push(...brandUrlsArray);
    results.push({ nicheId: target.nicheId, brandUrls: brandUrlsArray });
  }

  await updateCrawlSession(crawlSessionId, {
    discoveredBrands: allDiscovered,
  });

  return results;
}
