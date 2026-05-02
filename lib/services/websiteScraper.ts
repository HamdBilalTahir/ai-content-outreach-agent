import FirecrawlApp from '@mendable/firecrawl-js';

if (!process.env.FIRECRAWL_API_KEY) {
  throw new Error('Missing required environment variable: FIRECRAWL_API_KEY');
}

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const SCRAPE_FORMATS = ['markdown', 'links', 'images'] as const;
const TIMEOUT_MS = 15_000;

export interface ScrapedBrand {
  pageText: string | null;
  imageUrls: string[];
  whatsappNumber: string | null;
  instagramUrl: string | null;
  brandName: string | null;
  productPrice: number | null;
}

async function scrapeUrl(url: string) {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), TIMEOUT_MS)
  );
  const result = await Promise.race([
    firecrawl.scrape(url, { formats: [...SCRAPE_FORMATS] }),
    timeout,
  ]);
  return result;
}

function extractWhatsApp(text: string, links: string[]): string | null {
  for (const link of links) {
    const match = link.match(/wa\.me\/(\+?[\d]+)/);
    if (match) return normalizePhone(match[1]);
  }

  const waLinkInText = text.match(/wa\.me\/(\+?[\d]+)/);
  if (waLinkInText) return normalizePhone(waLinkInText[1]);

  const telMatch = text.match(/tel:(\+?[\d\s\-().]+)/);
  if (telMatch) {
    const digits = telMatch[1].replace(/\D/g, '');
    if (digits.length >= 10) return normalizePhone(digits);
  }

  // plain international number patterns (starts with + or country code 1,44,92 etc.)
  const intlMatch = text.match(
    /(?<!\d)(\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4})(?!\d)/
  );
  if (intlMatch) {
    const digits = intlMatch[1].replace(/\D/g, '');
    if (digits.length >= 10) return normalizePhone(digits);
  }

  return null;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('+') ? raw : `+${digits}`;
}

function extractInstagram(links: string[]): string | null {
  for (const link of links) {
    if (/instagram\.com\/(?!explore|p\/|reel\/|stories\/)[\w.]+/.test(link)) {
      return link;
    }
  }
  return null;
}

function extractBrandName(
  ogTitle: string | undefined,
  title: string | undefined,
  markdown: string | undefined
): string | null {
  if (ogTitle) return ogTitle.trim();
  if (title) return title.trim();
  if (markdown) {
    const h1 = markdown.match(/^#\s+(.+)/m);
    if (h1) return h1[1].trim();
  }
  return null;
}

function extractProductPrice(text: string): number | null {
  const matches = text.matchAll(/[$€£₹]\s*([\d,]+(?:\.\d{1,2})?)/g);
  let highest: number | null = null;
  for (const m of matches) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(val) && (highest === null || val > highest)) highest = val;
  }
  return highest;
}

export async function scrapeBrandWebsite(
  websiteUrl: string
): Promise<ScrapedBrand> {
  const result: ScrapedBrand = {
    pageText: null,
    imageUrls: [],
    whatsappNumber: null,
    instagramUrl: null,
    brandName: null,
    productPrice: null,
  };

  try {
    const page = await scrapeUrl(websiteUrl);
    if (!page) return result;

    const text = page.markdown ?? '';
    const links = page.links ?? [];
    const images = page.images ?? [];

    result.pageText = text.slice(0, 3000) || null;
    result.imageUrls = images;
    result.brandName = extractBrandName(
      page.metadata?.ogTitle,
      page.metadata?.title,
      text
    );
    result.instagramUrl = extractInstagram(links);
    result.whatsappNumber = extractWhatsApp(text, links);
    result.productPrice = extractProductPrice(text);

    if (!result.whatsappNumber) {
      try {
        const contactUrl = new URL('/contact', websiteUrl).href;
        const contactPage = await scrapeUrl(contactUrl);
        if (contactPage) {
          result.whatsappNumber = extractWhatsApp(
            contactPage.markdown ?? '',
            contactPage.links ?? []
          );
        }
      } catch {
        // contact page scrape is best-effort
      }
    }
  } catch (err) {
    console.error(`websiteScraper failed for ${websiteUrl}:`, err);
  }

  return result;
}
