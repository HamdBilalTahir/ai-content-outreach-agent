import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAllNiches } from '../db/niches';
import { getAllFeedbackSignals } from '../db/feedbackSignals';
import { createCrawlSession } from '../db/crawlSessions';
import type { Niche, FeedbackSignal } from '../types';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-flash-live-preview',
});

export interface CrawlTarget {
  nicheId: string;
  urls: string[];
  signalsToLookFor: string[];
}

export interface CrawlStrategyResult {
  crawlSessionId: string;
  selectedNiches: string[];
  crawlTargets: CrawlTarget[];
  agentReasoning: string;
}

function buildFeedbackSummary(signals: FeedbackSignal[]): string {
  if (signals.length === 0) return 'No feedback signals recorded yet.';

  const byNiche: Record<
    string,
    { closed: number; total: number; angles: Record<string, number> }
  > = {};

  for (const s of signals) {
    if (!byNiche[s.nicheId]) {
      byNiche[s.nicheId] = { closed: 0, total: 0, angles: {} };
    }
    byNiche[s.nicheId].total++;
    if (s.outcome === 'Closed') byNiche[s.nicheId].closed++;
    byNiche[s.nicheId].angles[s.pitchAngleUsed] =
      (byNiche[s.nicheId].angles[s.pitchAngleUsed] ?? 0) + 1;
  }

  return Object.entries(byNiche)
    .map(([nicheId, stats]) => {
      const topAngle = Object.entries(stats.angles).sort(
        (a, b) => b[1] - a[1]
      )[0];
      return `Niche ${nicheId}: ${stats.closed}/${stats.total} closed, top angle: ${topAngle?.[0] ?? 'none'}`;
    })
    .join('\n');
}

function buildPrompt(
  niches: Niche[],
  feedbackSummary: string,
  today: string
): string {
  const nicheList = niches
    .map(
      (n) => `- ID: ${n.id}
  Name: ${n.nicheName}
  CrawlPriority: ${n.crawlPriority}
  AvgGapScore: ${n.avgGapScore}
  CloseRate: ${n.closeRate}
  AvgProductPrice: $${n.avgProductPrice}
  SeedUrls: ${n.seedUrls.join(', ')}
  BlacklistedSignals: ${n.blacklistedSignals.join(', ')}`
    )
    .join('\n\n');

  return `You are a crawl strategy AI for an outreach pipeline.
Today's date: ${today}
Goal: Discover 30–50 qualified brand leads across the most promising niches.

## Niches
${nicheList}

## Recent Feedback Signals
${feedbackSummary}

## Instructions
Analyze the niches and feedback data. Select the best niches to target today based on close rate, gap score, product price, and crawl priority. For each selected niche, suggest specific URLs to crawl (beyond the seed URLs if useful) and list content/product signals that indicate a high-quality lead.

Respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON:
{
  "selectedNiches": ["<nicheId>", ...],
  "crawlTargets": [
    {
      "nicheId": "<nicheId>",
      "urls": ["<url>", ...],
      "signalsToLookFor": ["<signal>", ...]
    }
  ],
  "agentReasoning": "<plain English explanation>"
}`;
}

export async function runCrawlStrategyAgent(
  userId: string
): Promise<CrawlStrategyResult> {
  const [niches, feedbackSignals] = await Promise.all([
    getAllNiches(userId),
    getAllFeedbackSignals(userId),
  ]);

  const today = new Date().toISOString().split('T')[0];
  const feedbackSummary = buildFeedbackSummary(feedbackSignals);
  const prompt = buildPrompt(niches, feedbackSummary, today);

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();

  let parsed: {
    selectedNiches: string[];
    crawlTargets: CrawlTarget[];
    agentReasoning: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (
    !Array.isArray(parsed.selectedNiches) ||
    !Array.isArray(parsed.crawlTargets) ||
    typeof parsed.agentReasoning !== 'string'
  ) {
    throw new Error(
      `Gemini response missing required fields: ${raw.slice(0, 200)}`
    );
  }

  const selectedNicheId = parsed.selectedNiches[0] ?? '';

  const crawlSessionId = await createCrawlSession({
    userId,
    nicheId: selectedNicheId,
    targetUrls: parsed.crawlTargets.flatMap((t) => t.urls),
    discoveredBrands: [],
    leadsCreated: 0,
    leadsQualified: 0,
    agentReasoning: parsed.agentReasoning,
    sessionStatus: 'Running',
    completedAt: null,
  });

  return {
    crawlSessionId,
    selectedNiches: parsed.selectedNiches,
    crawlTargets: parsed.crawlTargets,
    agentReasoning: parsed.agentReasoning,
  };
}
