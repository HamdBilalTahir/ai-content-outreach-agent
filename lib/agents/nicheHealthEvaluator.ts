import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import {
  getAllNiches,
  updateNiche,
  createNiche,
  getNicheById,
} from '../db/niches';
import { appendAgentLog } from '../db/crawlSessions';
import type { Niche } from '../types';

const FAILURE_THRESHOLD = 3;
const MIN_SUCCESS_RATE = 0.05; // 5% qualified / total

const PivotNicheSchema = z.object({
  nicheName: z
    .string()
    .describe('Human-readable name for the replacement niche'),
  marketHypothesis: z
    .string()
    .describe('Why this adjacent market is worth targeting'),
  seedUrls: z
    .array(z.string())
    .describe('Seed URLs or discovery query strings for this new niche'),
  reasoning: z
    .string()
    .describe(
      'One-sentence explanation of why this niche was chosen as a replacement'
    ),
});

function getLlm() {
  return new ChatGoogleGenerativeAI({
    model: 'gemini-3.1-pro-preview',
    apiKey: process.env.GEMINI_API_KEY,
  });
}

export async function evaluateNicheHealth(
  userId: string,
  crawlSessionId: string,
  nicheStats: Map<string, { qualified: number; total: number }>
): Promise<void> {
  if (nicheStats.size === 0) return;

  console.log(
    `\n[NicheHealthEvaluator] Evaluating ${nicheStats.size} niche(s) for session ${crawlSessionId}...`
  );

  await appendAgentLog(
    crawlSessionId,
    'strategist',
    `🧠 [The Strategist] Reviewing session performance across ${nicheStats.size} niche(s)...`
  );

  for (const [nicheId, stats] of nicheStats.entries()) {
    const niche = await getNicheById(userId, nicheId);
    if (!niche || (niche.status ?? 'active') === 'cool-down') continue;

    const successRate = stats.total > 0 ? stats.qualified / stats.total : 0;
    const isFailing = successRate < MIN_SUCCESS_RATE;

    const newConsecutiveFailures = isFailing
      ? (niche.consecutive_failures ?? 0) + 1
      : 0;
    const newHealthScore = Math.max(0, 100 - newConsecutiveFailures * 33);

    if (newConsecutiveFailures >= FAILURE_THRESHOLD) {
      const reason = `Exhausted market. Generated ${stats.qualified} qualified lead(s) out of ${stats.total} target(s) across ${FAILURE_THRESHOLD} consecutive sessions.`;

      await updateNiche(userId, nicheId, {
        consecutive_failures: newConsecutiveFailures,
        health_score: newHealthScore,
        status: 'cool-down',
        coolDownReason: reason,
      });

      console.log(
        `[NicheHealthEvaluator] Cooled down niche "${niche.nicheName}": ${reason}`
      );

      await appendAgentLog(
        crawlSessionId,
        'strategist',
        `🧠 [The Strategist] '${niche.nicheName}' has failed to yield results for ${FAILURE_THRESHOLD} consecutive runs. Putting niche on cool-down. Initiating lateral market research...`
      );

      await runLateralPivot(userId, niche, reason, crawlSessionId);
    } else {
      await updateNiche(userId, nicheId, {
        consecutive_failures: newConsecutiveFailures,
        health_score: newHealthScore,
      });

      if (isFailing) {
        await appendAgentLog(
          crawlSessionId,
          'strategist',
          `⚠️ [The Strategist] '${niche.nicheName}' underperformed this run (${stats.qualified}/${stats.total} qualified). Health: ${newHealthScore}/100. Failures: ${newConsecutiveFailures}/${FAILURE_THRESHOLD}.`
        );
      } else {
        await appendAgentLog(
          crawlSessionId,
          'strategist',
          `✅ [The Strategist] '${niche.nicheName}' is healthy. ${stats.qualified}/${stats.total} leads qualified. Health: ${newHealthScore}/100.`
        );
      }
    }
  }
}

async function runLateralPivot(
  userId: string,
  cooledNiche: Niche,
  coolDownReason: string,
  crawlSessionId: string
): Promise<void> {
  try {
    const allNiches = await getAllNiches(userId);
    const activeNiches = allNiches.filter(
      (n) => (n.status ?? 'active') === 'active' && n.id !== cooledNiche.id
    );

    // Research adjacent market with Tavily
    let marketResearch = '';
    if (process.env.TAVILY_API_KEY) {
      try {
        const { tavily } = await import('@tavily/core');
        const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });
        const query = `market adjacent to "${cooledNiche.nicheName}" high buying intent brands`;
        const searchRes = await tvly.search(query, {
          searchDepth: 'basic',
          maxResults: 3,
        });
        marketResearch = searchRes.results
          .map((r: any) => `- ${r.title}: ${r.content}`)
          .join('\n');
      } catch (err) {
        console.warn('[LateralPivot] Tavily research failed:', err);
      }
    }

    const activeNicheList =
      activeNiches.length > 0
        ? activeNiches
            .map(
              (n) =>
                `- ${n.nicheName} (avg gap score: ${n.avgGapScore}, close rate: ${n.closeRate})`
            )
            .join('\n')
        : '(none)';

    const prompt = `You are a market research AI for an outreach pipeline.

The niche "${cooledNiche.nicheName}" has been placed on cool-down.
Reason: ${coolDownReason}

Currently successful active niches:
${activeNicheList}

Market Research (adjacent markets):
${marketResearch || 'No data available.'}

Task: Invent 1 entirely new, adjacent niche with similar buying signals to replace the failed one.
The new niche must:
- Be similar to what is working (draw patterns from the active niches)
- Have clear, observable buying intent signals
- Be discoverable via web searches

Return a JSON object for the replacement niche.`;

    const llm = getLlm();
    const structuredLlm = llm.withStructuredOutput(PivotNicheSchema);
    const pivot = await structuredLlm.invoke(prompt);

    if (!pivot) {
      console.warn('[LateralPivot] LLM returned no pivot suggestion.');
      return;
    }

    const newNicheId = await createNiche({
      userId,
      pipelineId: cooledNiche.pipelineId,
      nicheName: pivot.nicheName,
      crawlPriority: 5,
      avgGapScore: 0,
      closeRate: 0,
      avgProductPrice: 0,
      seedUrls: pivot.seedUrls,
      blacklistedSignals: [],
      lastCrawled: null,
      aiReasoning: pivot.reasoning,
      marketHypothesis: pivot.marketHypothesis,
      health_score: 100,
      consecutive_failures: 0,
      status: 'active',
      replacedNicheId: cooledNiche.id,
      replacedNicheName: cooledNiche.nicheName,
    });

    console.log(
      `[LateralPivot] Created replacement niche "${pivot.nicheName}" (${newNicheId}) to replace "${cooledNiche.nicheName}"`
    );

    await appendAgentLog(
      crawlSessionId,
      'strategist',
      `🧠 [The Strategist] Added '${pivot.nicheName}' as a replacement target for '${cooledNiche.nicheName}'. Reason: ${pivot.reasoning}`
    );
  } catch (err) {
    console.error('[LateralPivot] Failed to create replacement niche:', err);
  }
}
