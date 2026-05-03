import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import { getAllNiches } from '../db/niches';
import { getAllFeedbackSignals } from '../db/feedbackSignals';
import { createCrawlSession } from '../db/crawlSessions';
import type { Niche, FeedbackSignal } from '../types';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const llm = new ChatGoogleGenerativeAI({
  model: 'gemini-3.1-pro-preview',
  apiKey: process.env.GEMINI_API_KEY,
});

const TargetNicheSchema = z.object({
  nicheId: z.string().describe('A unique ID for the niche (snake_case)'),
  nicheName: z.string().describe('The human-readable name of the niche'),
  marketHypothesis: z
    .string()
    .describe('Plain English reasoning based on market research'),
  confidenceScore: z.number().describe('Confidence score from 1-100'),
  discoveryActions: z
    .object({
      tavilyQueries: z
        .array(z.string())
        .describe(
          'Open-web semantic search queries to find independent domains'
        ),
      firecrawlMaps: z
        .array(z.string())
        .describe(
          'Specific directory or aggregator URLs to map for internal profiles'
        ),
    })
    .describe('Hybrid discovery tactics to maximize lead volume'),
  signalsToLookFor: z
    .array(z.string())
    .describe('Content/product signals that indicate a high-quality lead'),
});

const StrategyOutputSchema = z.object({
  targetNiches: z
    .array(TargetNicheSchema)
    .describe('List of 2-3 target niches to execute concurrently'),
  agentReasoning: z
    .string()
    .describe('Plain English explanation of your overall strategy'),
});

const structuredLlm = llm.withStructuredOutput(StrategyOutputSchema);

export interface TargetNiche {
  nicheId: string;
  nicheName: string;
  marketHypothesis: string;
  confidenceScore: number;
  discoveryActions: {
    tavilyQueries: string[];
    firecrawlMaps: string[];
  };
  signalsToLookFor: string[];
}

export interface CrawlStrategyResult {
  crawlSessionId: string;
  targetNiches: TargetNiche[];
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
  today: string,
  pipelineGoal: string,
  clientSeedUrls: string[],
  searchData: string,
  playbooks?: Record<string, string>
): string {
  const strategistPlaybook = playbooks?.['strategist']
    ? `\n\n## Strategist Playbook (Learned Rules)\n${playbooks['strategist']}`
    : '';

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
Overall Pipeline Goal: ${pipelineGoal}
Best Client Look-alike Seed URLs: ${clientSeedUrls.join(', ')}

## Niches
${nicheList}

## Market Research (Search Trends)
${searchData}

## Recent Feedback Signals
${feedbackSummary}${strategistPlaybook}

## Instructions
Analyze the pipeline goal, client seed URLs, search trends, existing niches, and feedback data (and strictly adhere to any rules in the Strategist Playbook).

1. Evaluate the search results to synthesize 2-3 high-confidence niches to target concurrently based on market trends.
2. For each selected niche, provide a hybrid discovery plan using both 'tavilyQueries' (semantic web searches for independent domains) and 'firecrawlMaps' (specific aggregator or directory URLs to map). Also list content/product signals that indicate a high-quality lead.
3. Formulate a specific 'marketHypothesis' and 'confidenceScore' for EACH niche in the array.

Respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON:
{
  "targetNiches": [
    {
      "nicheId": "<unique_snake_case_id>",
      "nicheName": "<Human Readable Name>",
      "marketHypothesis": "<your detailed hypothesis for this niche based on data>",
      "confidenceScore": 95,
      "discoveryActions": {
        "tavilyQueries": ["<semantic search queries>", ...],
        "firecrawlMaps": ["<directory or aggregator URLs to map>", ...]
      },
      "signalsToLookFor": ["<signal>", ...]
    }
  ],
  "agentReasoning": "<plain English explanation of the overall strategy>"
}`;
}

export async function runCrawlStrategyAgent(
  userId: string,
  forceNicheId?: string,
  isSandbox?: boolean,
  pipelineId?: string,
  existingSessionId?: string,
  systemWarning?: string
): Promise<CrawlStrategyResult> {
  console.log(`\n[Agent: CrawlStrategy] Starting strategy formulation...`);
  // Fetch playbooks for RAG
  const { getAllIntelligenceForPipeline } = await import('../db/intelligence');
  const { getPlaybook } = await import('../services/blobStorage');
  const { getPipelineById } = await import('../db/pipelines');

  const activePipelineId = pipelineId || 'default-pipeline';
  const registries = await getAllIntelligenceForPipeline(
    userId,
    activePipelineId
  );
  const playbooks: Record<string, string> = {};
  for (const reg of registries) {
    try {
      playbooks[reg.agentRole] = await getPlaybook(reg.blobUrl);
    } catch (e) {
      console.warn(`Failed to fetch playbook for ${reg.agentRole}`);
    }
  }

  const pipeline = await getPipelineById(userId, activePipelineId);
  const pipelineGoal =
    pipeline?.description || 'Discover qualified brand leads.';
  const clientSeedUrls = pipeline?.clientSeedUrls || [];

  // 1. Perform Web Search (Research Phase)
  let searchData = 'No search tools configured.';
  let citations: string[] = [];
  if (process.env.TAVILY_API_KEY) {
    console.log(
      `🧭 [Strategist] Searching web for macro-trends matching the goal...`
    );
    try {
      const { tavily } = await import('@tavily/core');
      const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
      const query = `market trends ${pipelineGoal} high margin industries ${clientSeedUrls.join(' ')}`;
      const searchRes = await tvly.search(query, {
        searchDepth: 'basic',
        maxResults: 3,
      });
      searchData = searchRes.results
        .map((r: any) => `- ${r.title}\n  ${r.content}`)
        .join('\n\n');
      citations = searchRes.results.map((r: any) => r.url);
      console.log(
        `🧭 [Strategist] Completed web search with ${citations.length} results.`
      );
    } catch (err: any) {
      console.error('Tavily search failed:', err.message);
      searchData = 'Search failed: ' + err.message;
    }
  }

  let [niches, feedbackSignals] = await Promise.all([
    getAllNiches(userId),
    getAllFeedbackSignals(userId),
  ]);

  // Never include cooled-down niches in strategy selection
  niches = niches.filter((n) => (n.status ?? 'active') === 'active');

  if (forceNicheId) {
    niches = niches.filter((n) => n.id === forceNicheId);
  }

  const today = new Date().toISOString().split('T')[0];
  const feedbackSummary = buildFeedbackSummary(feedbackSignals);
  const prompt =
    buildPrompt(
      niches,
      feedbackSummary,
      today,
      pipelineGoal,
      clientSeedUrls,
      searchData,
      playbooks
    ) +
    (forceNicheId
      ? `\n\nCRITICAL: You MUST select only the niche provided and generate targets for it.`
      : '') +
    (systemWarning ? `\n\n${systemWarning}` : '');

  console.log(
    `[Agent: CrawlStrategy] 🧠 Consulting Gemini AI for the master strategy...`
  );
  console.log(
    `[Agent: CrawlStrategy] 📤 The Brain's Input:\n${JSON.stringify({ prompt }, null, 2)}`
  );

  const parsed = await structuredLlm.invoke(prompt);

  if (!parsed) {
    throw new Error('Gemini failed to return a valid structured response.');
  }

  console.log(
    `[Agent: CrawlStrategy] 📥 The Masterplan has arrived:\n${JSON.stringify(parsed, null, 2)}`
  );

  const { updateNiche, createNiche } = await import('../db/niches');

  // 1. Process all niches concurrently
  const processNichePromises = parsed.targetNiches.map(async (target) => {
    const existingNiche = niches.find(
      (n) =>
        n.id === target.nicheId ||
        n.nicheName.toLowerCase() === target.nicheName.toLowerCase()
    );

    const seedUrls = target.discoveryActions.tavilyQueries.concat(
      target.discoveryActions.firecrawlMaps
    );

    if (existingNiche) {
      await updateNiche(userId, existingNiche.id, {
        marketHypothesis: target.marketHypothesis,
        confidenceScore: target.confidenceScore,
        researchCitations: citations,
        seedUrls: Array.from(new Set([...existingNiche.seedUrls, ...seedUrls])),
        blacklistedSignals: Array.from(
          new Set([
            ...existingNiche.blacklistedSignals,
            ...target.signalsToLookFor,
          ])
        ),
      });
      // Replace target's nicheId with actual DB ID
      target.nicheId = existingNiche.id;
    } else {
      const newNicheId = await createNiche({
        userId,
        pipelineId: activePipelineId,
        nicheName: target.nicheName,
        crawlPriority: 1,
        avgGapScore: 0,
        closeRate: 0,
        avgProductPrice: 0,
        seedUrls,
        blacklistedSignals: target.signalsToLookFor || [],
        lastCrawled: null,
        aiReasoning: parsed.agentReasoning,
        marketHypothesis: target.marketHypothesis,
        confidenceScore: target.confidenceScore,
        researchCitations: citations,
      });
      // Update target to the real ID
      target.nicheId = newNicheId;
    }

    console.log(
      `🧭 [Strategist] Hypothesis for ${target.nicheName}: ${target.marketHypothesis.substring(0, 50)}... Score: ${target.confidenceScore}%`
    );
  });

  await Promise.all(processNichePromises);

  console.log(
    `[Agent: CrawlStrategy] ✅ Strategy ready. Selected Niches: ${parsed.targetNiches.map((n: TargetNiche) => n.nicheName).join(', ')}`
  );

  let crawlSessionId = existingSessionId;

  if (!crawlSessionId) {
    crawlSessionId = await createCrawlSession({
      userId,
      pipelineId: activePipelineId,
      nicheId: 'multi-niche',
      targetUrls: parsed.targetNiches.flatMap((t: TargetNiche) =>
        t.discoveryActions.tavilyQueries.concat(
          t.discoveryActions.firecrawlMaps
        )
      ),
      discoveredBrands: [],
      leadsCreated: 0,
      leadsQualified: 0,
      agentReasoning: parsed.agentReasoning,
      sessionStatus: 'Running',
      completedAt: null,
      isSandbox: isSandbox || false,
      agentLogs: [
        {
          timestamp: new Date().toISOString(),
          agentRole: 'strategist',
          narrative: parsed.agentReasoning,
        },
      ],
    });
  } else {
    const { appendAgentLog } = await import('../db/crawlSessions');
    await appendAgentLog(crawlSessionId, 'strategist', parsed.agentReasoning);
  }

  return {
    crawlSessionId,
    targetNiches: parsed.targetNiches,
    agentReasoning: parsed.agentReasoning,
  };
}
