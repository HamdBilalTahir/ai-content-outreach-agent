import Firecrawl from '@mendable/firecrawl-js';
import stringSimilarity from 'string-similarity';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { findPhoneNumbersInText } from 'libphonenumber-js';

if (!process.env.FIRECRAWL_API_KEY) {
  throw new Error('Missing required environment variable: FIRECRAWL_API_KEY');
}

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

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
  let attempt = 1;
  while (true) {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), TIMEOUT_MS)
    );
    console.log(
      `[API: WebsiteScraper] 📤 Asking Firecrawl to rip data from: ${url} (Formats: ${SCRAPE_FORMATS.join(', ')}) (Attempt ${attempt})`
    );

    try {
      const result = await Promise.race([
        firecrawl.scrape(url, { formats: [...SCRAPE_FORMATS] }),
        timeout,
      ]);
      console.log(
        `[API: WebsiteScraper] 📥 Firecrawl returned: ${result ? 'Success - Data extracted' : 'Timeout/Failed'}`
      );
      return result;
    } catch (err: any) {
      const isRateLimit =
        err.status === 429 ||
        (err.message && err.message.includes('Rate limit exceeded'));

      if (isRateLimit) {
        let waitTime = 20;
        const match = err.message?.match(/retry after (\d+)s/);
        if (match) {
          waitTime = parseInt(match[1], 10) + 1;
        }
        console.warn(
          `[API: WebsiteScraper] ⚠️ Firecrawl rate limit hit for ${url}. Retrying in ${waitTime}s (Attempt ${attempt})...`
        );
        await new Promise((r) => setTimeout(r, waitTime * 1000));
        attempt++;
        continue;
      }

      console.error(
        `[API: WebsiteScraper] ❌ Firecrawl scrape failed for ${url}:`,
        err
      );
      return null;
    }
  }
}

function getCountryCodeFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    const tld = parts[parts.length - 1].toLowerCase();

    const tldMap: Record<string, string> = {
      uk: 'GB',
      au: 'AU',
      ae: 'AE',
      sa: 'SA',
      fr: 'FR',
      de: 'DE',
      it: 'IT',
      es: 'ES',
      ca: 'CA',
      in: 'IN',
      za: 'ZA',
      br: 'BR',
      pk: 'PK',
      nz: 'NZ',
      sg: 'SG',
      my: 'MY',
      ie: 'IE',
      ch: 'CH',
      nl: 'NL',
      se: 'SE',
      no: 'NO',
      dk: 'DK',
      fi: 'FI',
      at: 'AT',
      mx: 'MX',
      ar: 'AR',
      cl: 'CL',
    };
    if (tldMap[tld]) return tldMap[tld];
  } catch {}
  return null;
}

async function extractWhatsApp(
  text: string,
  links: string[],
  url: string
): Promise<string | null> {
  // Try exact wa.me links first (these always have country codes)
  for (const link of links) {
    const match = link.match(/wa\.me\/(\+?[\d]+)/);
    if (match) return normalizePhone(match[1]);
  }

  const waLinkInText = text.match(/wa\.me\/(\+?[\d]+)/);
  if (waLinkInText) return normalizePhone(waLinkInText[1]);

  // plain international number patterns (starts with +)
  const intlMatch = text.match(
    /(?<!\d)(\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4})(?!\d)/
  );
  if (intlMatch) {
    const digits = intlMatch[1].replace(/\D/g, '');
    if (digits.length >= 10) return normalizePhone(digits);
  }

  // If no international format found, let's use Gemini to intelligently extract it with the right country code based on address/context
  try {
    const { z } = await import('zod');

    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.1-pro-preview',
      apiKey: process.env.GEMINI_API_KEY,
    });

    const PhoneSchema = z.object({
      whatsapp_number: z
        .string()
        .nullable()
        .describe(
          'The phone/whatsapp number of the business. You MUST prepend the correct international country calling code (e.g. +1, +44, +971) based on the business location or address mentioned in the text. If no phone number is found, return null.'
        ),
    });

    const structured = llm.withStructuredOutput(PhoneSchema);
    const res = await structured.invoke(
      `Extract the business phone or WhatsApp number from this website text. It is CRITICAL that you determine the business's country from context clues (addresses, cities, currencies, TLD) and prepend the correct international country code (e.g. +44 for UK, +971 for UAE) if it's a local number.\n\nWebsite URL: ${url}\n\nText:\n${text.substring(0, 10000)}`
    );

    if (res?.whatsapp_number) {
      const digits = res.whatsapp_number.replace(/\D/g, '');
      if (digits.length >= 10) return `+${digits}`;
      return res.whatsapp_number;
    }
  } catch (err) {
    console.warn('[extractWhatsApp] LLM extraction failed', err);
  }

  // Final fallback using libphonenumber-js with TLD heuristic
  const defaultCountry = getCountryCodeFromUrl(url) || 'US';

  const telMatch = text.match(/tel:(\+?[\d\s\-().]+)/);
  if (telMatch) {
    try {
      const phones = findPhoneNumbersInText(telMatch[1], defaultCountry as any);
      if (phones.length > 0 && phones[0].number?.number) {
        return phones[0].number.number.toString();
      }
    } catch {}
    const digits = telMatch[1].replace(/\D/g, '');
    if (digits.length >= 10) return normalizePhone(digits);
    // If libphonenumber fails and it's less than 10 digits, just return the raw phone number
    return telMatch[1];
  }

  try {
    const phones = findPhoneNumbersInText(text, defaultCountry as any);
    for (const phone of phones) {
      if (phone.number?.number) return phone.number.number.toString();
      // If libphonenumber found a match but couldn't parse the exact number, return the raw matched text
      if (phone.startsAt !== undefined && phone.endsAt !== undefined) {
        return text.substring(phone.startsAt, phone.endsAt);
      }
    }
  } catch {}

  return null;
}

function normalizePhone(raw: string): string {
  return `+${raw.replace(/\D/g, '')}`;
}

async function extractInstagram(
  links: string[],
  websiteUrl: string,
  brandName: string | null
): Promise<string | null> {
  const handles = new Set<string>();

  for (const link of links) {
    if (
      link.includes('/p/') ||
      link.includes('/explore/') ||
      link.includes('?share=')
    ) {
      continue;
    }
    const match = link.match(/instagram\.com\/([^/?#]+)/);
    if (match && match[1]) {
      const handle = match[1].toLowerCase();
      if (!['p', 'explore', 'reel', 'stories'].includes(handle)) {
        handles.add(handle);
      }
    }
  }

  if (handles.size === 0) return null;
  const uniqueHandles = Array.from(handles);
  if (uniqueHandles.length === 1)
    return `https://www.instagram.com/${uniqueHandles[0]}/`;

  let domain = '';
  try {
    domain = new URL(websiteUrl).hostname.replace(/^www\./, '').split('.')[0];
  } catch {}

  const targetString = brandName ? brandName.toLowerCase() : domain;
  if (!targetString) return `https://www.instagram.com/${uniqueHandles[0]}/`;

  let bestMatch = uniqueHandles[0];
  let highestScore = 0;

  for (const handle of uniqueHandles) {
    const score = Math.max(
      stringSimilarity.compareTwoStrings(handle, targetString),
      stringSimilarity.compareTwoStrings(handle, domain)
    );
    if (score > highestScore) {
      highestScore = score;
      bestMatch = handle;
    }
  }

  if (highestScore >= 0.3) {
    return `https://www.instagram.com/${bestMatch}/`;
  }

  // Fallback to LLM
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error('No Gemini key');
    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.1-pro-preview',
      apiKey: process.env.GEMINI_API_KEY,
    });
    const prompt = `You are an AI tasked with identifying the official corporate Instagram handle for a brand.
Brand Name: ${brandName || 'Unknown'}
Domain: ${domain || 'Unknown'}
Possible Handles: ${uniqueHandles.join(', ')}

Return ONLY the official handle, nothing else.`;
    const res = await llm.invoke(prompt);
    const chosen = res.content.toString().trim().toLowerCase().replace('@', '');
    if (uniqueHandles.includes(chosen)) {
      return `https://www.instagram.com/${chosen}/`;
    }
  } catch (err) {
    console.warn('[extractInstagram] LLM fallback failed', err);
  }

  return `https://www.instagram.com/${bestMatch}/`;
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
  console.log(`\n[API: WebsiteScraper] Scraping website: ${websiteUrl}`);
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
    result.instagramUrl = await extractInstagram(
      links,
      websiteUrl,
      result.brandName
    );
    result.whatsappNumber = await extractWhatsApp(text, links, websiteUrl);
    result.productPrice = extractProductPrice(text);

    if (!result.whatsappNumber) {
      const contactKeywords = ['contact', 'about', 'reach-us'];
      let targetUrl: string | null = null;
      for (const link of links) {
        if (contactKeywords.some((kw) => link.toLowerCase().includes(kw))) {
          targetUrl = link;
          break;
        }
      }
      if (!targetUrl) {
        try {
          targetUrl = new URL('/contact', websiteUrl).href;
        } catch {}
      }

      if (targetUrl) {
        try {
          console.log(
            `[API: WebsiteScraper] 🕵️ No phone on homepage. Hunting down contact page: ${targetUrl}`
          );
          const contactPage = await scrapeUrl(targetUrl);
          if (contactPage) {
            result.whatsappNumber = await extractWhatsApp(
              contactPage.markdown ?? '',
              contactPage.links ?? [],
              targetUrl
            );
          }
        } catch {
          // contact page scrape is best-effort
        }
      }
    }
  } catch (err) {
    console.error(`websiteScraper failed for ${websiteUrl}:`, err);
  }

  console.log(
    `[API: WebsiteScraper] ✅ Finished scraping. WhatsApp: ${result.whatsappNumber || 'None'}`
  );
  return result;
}
