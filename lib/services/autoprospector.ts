import Firecrawl from '@mendable/firecrawl-js';
import { tavily } from '@tavily/core';
import { db } from '../firebase/admin';
import { updateCrawlSession, appendAgentLog } from '../db/crawlSessions';
import type { TargetNiche } from '../agents/crawlStrategyAgent';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';

if (!process.env.FIRECRAWL_API_KEY) {
  throw new Error('Missing required environment variable: FIRECRAWL_API_KEY');
}

if (!process.env.TAVILY_API_KEY) {
  throw new Error('Missing required environment variable: TAVILY_API_KEY');
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const llm = new ChatGoogleGenerativeAI({
  model: 'gemini-3.1-pro-preview',
  apiKey: process.env.GEMINI_API_KEY,
});

const ResolverSchema = z.object({
  actual_company_website: z
    .string()
    .url()
    .nullable()
    .describe(
      'The external brand domain extracted from the profile. Null if not found.'
    ),
});
const structuredResolver = llm.withStructuredOutput(ResolverSchema);

const ListicleResolverSchema = z.object({
  extracted_brands: z.array(
    z.object({
      brand_name: z.string(),
      company_website_url: z.string().url(),
    })
  ),
});
const listicleStructuredResolver = llm.withStructuredOutput(
  ListicleResolverSchema
);

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
  'wikipedia.org',
  'apple.com',
  'google.com',
  'yahoo.com',
];

const DIRECTORY_REGEX =
  /directory|profile|listing|review|top-10|best-|yelp\.com|g2\.com|capterra\.com|trustpilot\.com|clutch\.co|yellowpages\.com|bbb\.org|angi\.com|thumbtack\.com|glassdoor\.com|indeed\.com|tripadvisor\.com|foursquare\.com/i;

const LISTICLE_REGEX = /\/blog\/|\/article\/|\/guides\/|\/features\/|\/top-/i;

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

function extractBrandUrls(links: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const link of links) {
    try {
      const parsed = new URL(link);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (isBlockedUrl(link)) continue;

      const normalized = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
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

async function runTavilySearch(query: string): Promise<string[]> {
  try {
    const searchRes = await tvly.search(query, {
      searchDepth: 'basic',
      maxResults: 15,
    });

    return searchRes.results.map((r: any) => r.url);
  } catch (err: any) {
    console.error(`Tavily search failed for query "${query}":`, err.message);
    return [];
  }
}

async function runFirecrawlMap(url: string): Promise<string[]> {
  let attempt = 1;
  while (attempt <= 2) {
    const timer = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 30_000)
    );

    try {
      const result = await Promise.race([
        firecrawl.map(url, { limit: 50 }),
        timer,
      ]);

      if (result === null) {
        console.error(`Firecrawl timeout for ${url}`);
        return [];
      }

      return (result as any).links ?? [];
    } catch (err: any) {
      console.warn(
        `Firecrawl map request failed for ${url} (Attempt ${attempt}):`,
        err.message
      );
      await new Promise((r) => setTimeout(r, 5000));
      attempt++;
    }
  }
  return [];
}

async function resolveDirectoryUrl(url: string): Promise<string | null> {
  console.log(`[DirectoryResolver] Resolving directory profile: ${url}`);
  try {
    const scrapeResult = (await firecrawl.scrape(url, {
      formats: ['markdown'],
    })) as any;

    if (!scrapeResult.success || !scrapeResult.markdown) {
      console.warn(`[DirectoryResolver] Failed to scrape ${url}`);
      return null;
    }

    const prompt = `Extract the actual external company website URL from this directory profile page content. Ignore the directory's own internal links. If you cannot find a valid external company website, return null. \n\nContent:\n${scrapeResult.markdown.substring(0, 15000)}`;

    const parsed = await structuredResolver.invoke(prompt);

    if (parsed?.actual_company_website) {
      console.log(
        `[DirectoryResolver] Extracted brand website: ${parsed.actual_company_website}`
      );
      return parsed.actual_company_website;
    }

    return null;
  } catch (error) {
    console.error(`[DirectoryResolver] Error resolving ${url}:`, error);
    return null;
  }
}

async function ListicleExtractor(
  url: string,
  crawlSessionId: string
): Promise<string[]> {
  console.log(`[ListicleExtractor] Resolving listicle: ${url}`);
  try {
    const scrapeResult = (await firecrawl.scrape(url, {
      formats: ['markdown'],
    })) as any;

    if (!scrapeResult.success || !scrapeResult.markdown) {
      console.warn(`[ListicleExtractor] Failed to scrape ${url}`);
      return [];
    }

    const prompt = `Read this magazine article. Extract the name of every independent brand mentioned, and locate their direct outbound website link. Do not extract internal magazine links.\n\nContent:\n${scrapeResult.markdown.substring(0, 15000)}`;

    const parsed = await listicleStructuredResolver.invoke(prompt);

    if (parsed?.extracted_brands && parsed.extracted_brands.length > 0) {
      const urls = parsed.extracted_brands.map(
        (b: any) => b.company_website_url
      );
      console.log(
        `[ListicleExtractor] Extracted ${urls.length} brands: ${urls.join(', ')}`
      );

      await appendAgentLog(
        crawlSessionId,
        'scraper',
        `📰 [The Web Scraper] URL identified as an article. Extracted ${urls.length} unique brands from the text. Adding them to the scrape queue and discarding the magazine.`
      );

      return urls;
    }

    return [];
  } catch (error) {
    console.error(`[ListicleExtractor] Error resolving ${url}:`, error);
    return [];
  }
}

async function getExistingDedupHashes(): Promise<Set<string>> {
  const snapshot = await db.collection('leads').select('dedupHash').get();
  return new Set(snapshot.docs.map((d) => d.data().dedupHash as string));
}

function dedupHash(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

export interface ProspectorResult {
  nicheId: string;
  brandUrls: string[];
}

export async function runAutoProspector(
  targetNiches: TargetNiche[],
  crawlSessionId: string
): Promise<ProspectorResult[]> {
  console.log(
    `\n[API: Autoprospector] Starting hybrid prospector for session ${crawlSessionId}...`
  );
  const existingHashes = await getExistingDedupHashes();
  const allDiscovered: string[] = [];

  const processNiche = async (
    target: TargetNiche
  ): Promise<ProspectorResult> => {
    const nicheUrls = new Set<string>();

    // 1. Parallel execution of Tavily and Firecrawl
    const tavilyPromises = (target.discoveryActions?.tavilyQueries || []).map(
      (q: string) => runTavilySearch(q)
    );
    const mapPromises = (target.discoveryActions?.firecrawlMaps || []).map(
      (url: string) => runFirecrawlMap(url)
    );

    console.log(
      `[API: Autoprospector] 🕵️‍♂️ Dispatching ${tavilyPromises.length} Tavily queries and ${mapPromises.length} Firecrawl Maps in parallel for niche ${target.nicheName}...`
    );

    const [tavilyResults, mapResults] = await Promise.all([
      Promise.all(tavilyPromises),
      Promise.all(mapPromises),
    ]);

    const rawTavilyUrls = tavilyResults.flat();
    const rawMapUrls = mapResults.flat();

    const cleanUrls = extractBrandUrls([...rawTavilyUrls, ...rawMapUrls]);
    console.log(
      `[API: Autoprospector] 📥 Merged and filtered: ${cleanUrls.length} potential URLs for niche ${target.nicheName}.`
    );

    // 2. Resolve directories and listicles
    for (const url of cleanUrls) {
      let finalUrls: string[] = [url];

      if (DIRECTORY_REGEX.test(url)) {
        await appendAgentLog(
          crawlSessionId,
          'scraper',
          `Directory link detected: ${url}. Routing to DirectoryResolver...`
        );
        const resolvedUrl = await resolveDirectoryUrl(url);
        if (resolvedUrl) {
          finalUrls = [resolvedUrl];
          await appendAgentLog(
            crawlSessionId,
            'scraper',
            `DirectoryResolver successfully extracted brand domain: ${resolvedUrl}`
          );
        } else {
          await appendAgentLog(
            crawlSessionId,
            'scraper',
            `DirectoryResolver failed to find external link on ${url}. Skipping.`
          );
          continue; // Skip if we couldn't resolve
        }
      } else if (LISTICLE_REGEX.test(url)) {
        const extractedUrls = await ListicleExtractor(url, crawlSessionId);
        if (extractedUrls.length > 0) {
          finalUrls = extractedUrls;
        } else {
          continue; // Skip if nothing extracted
        }
      }

      // Final deduplication check
      for (const finalUrl of finalUrls) {
        if (!isBlockedUrl(finalUrl)) {
          const hash = dedupHash(finalUrl);
          if (!existingHashes.has(hash)) {
            nicheUrls.add(finalUrl);
            existingHashes.add(hash);
          }
        }
      }
    }

    const brandUrlsArray = Array.from(nicheUrls);
    return { nicheId: target.nicheId, brandUrls: brandUrlsArray };
  };

  const results = await Promise.all(
    targetNiches.map((niche) => processNiche(niche))
  );

  for (const r of results) {
    allDiscovered.push(...r.brandUrls);
  }

  await updateCrawlSession(crawlSessionId, {
    discoveredBrands: allDiscovered,
  });

  console.log(
    `[API: Autoprospector] ✅ Prospector finished. Total discovered brands: ${allDiscovered.length}`
  );
  return results;
}
