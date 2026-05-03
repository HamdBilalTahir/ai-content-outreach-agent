import { NextRequest, NextResponse } from 'next/server';
import { runCrawlStrategyAgent } from '../../../../../lib/agents/crawlStrategyAgent';
import { runAutoProspector } from '../../../../../lib/services/autoprospector';
import { runPipeline } from '../../../../../lib/pipeline/runPipeline';
import { updateCrawlSession } from '../../../../../lib/db/crawlSessions';
import { getAllSettings } from '../../../../../lib/db/settings';

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allSettings = await getAllSettings();
    const currentHour = new Date().getUTCHours();
    let totalLeadsDiscovered = 0;
    let totalLeadsQualified = 0;
    const sessionIds: string[] = [];

    const { db } = await import('../../../../../lib/firebase/admin');
    const runningPipelinesSnapshot = await db
      .collection('pipelines')
      .where('status', '==', 'running')
      .get();

    // Process running pipelines
    const runningPipelinesByUserId: Record<string, string[]> = {};
    runningPipelinesSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!runningPipelinesByUserId[data.userId]) {
        runningPipelinesByUserId[data.userId] = [];
      }
      runningPipelinesByUserId[data.userId].push(doc.id);
    });

    for (const settings of allSettings) {
      if (
        !settings.crawlEnabled ||
        currentHour !== settings.crawlScheduleHour
      ) {
        continue;
      }

      const activePipelineIds = runningPipelinesByUserId[settings.userId] || [];
      if (activePipelineIds.length === 0) continue;

      // Execute the pipeline for the specific user's active pipelines
      const { getAllNiches } = await import('../../../../../lib/db/niches');
      const niches = await getAllNiches(settings.userId);
      const activeNiches = niches.filter(
        (n) =>
          activePipelineIds.includes(n.pipelineId) &&
          (n.status ?? 'active') === 'active'
      );
      if (activeNiches.length === 0) continue;

      const nicheMap = new Map(activeNiches.map((n) => [n.id, n]));

      // We'll pass activeNiches to the strategy agent to only consider them
      // This requires modifying runCrawlStrategyAgent to accept an array of niche IDs to filter by, or we just rely on it picking.
      // For now, let's allow it to pick from active niches.

      let strategyAttempts = 0;
      const MAX_STRATEGY_ATTEMPTS = 2;
      let allBrandUrls: { url: string; nicheId: string }[] = [];
      let finalCrawlSessionId = '';
      let systemWarning: string | undefined;

      while (strategyAttempts < MAX_STRATEGY_ATTEMPTS) {
        strategyAttempts++;
        console.log(
          `[Cron Crawl] Invoking runCrawlStrategyAgent (Attempt ${strategyAttempts})...`
        );
        const strategy = await runCrawlStrategyAgent(
          settings.userId,
          undefined,
          false,
          undefined,
          undefined,
          systemWarning
        );
        const { crawlSessionId, targetNiches } = strategy;
        finalCrawlSessionId = crawlSessionId;

        // Only prospect targets that are part of active pipelines
        const activeCrawlTargets = targetNiches.filter((t) =>
          nicheMap.has(t.nicheId)
        );

        if (activeCrawlTargets.length > 0) {
          const prospectorResults = await runAutoProspector(
            activeCrawlTargets,
            crawlSessionId
          );

          allBrandUrls = prospectorResults.flatMap((r) =>
            r.brandUrls.map((url) => ({ url, nicheId: r.nicheId }))
          );
        }

        if (allBrandUrls.length > 0) {
          break; // Found leads, exit retry loop
        } else {
          console.log(
            `[Cron Crawl] 0 leads discovered on attempt ${strategyAttempts}.`
          );
          systemWarning = `SYSTEM WARNING: Both Tavily searches and Firecrawl maps resulted in 0 usable company domains. Generate entirely new search queries and map targets focusing on a different angle.`;
          const { appendAgentLog } =
            await import('../../../../../lib/db/crawlSessions');
          await appendAgentLog(crawlSessionId, 'strategist', systemWarning);
        }
      }

      if (allBrandUrls.length === 0) {
        console.log(
          `[Cron Crawl] 0 leads discovered after ${MAX_STRATEGY_ATTEMPTS} attempts. Skipping pipelines.`
        );
        await updateCrawlSession(finalCrawlSessionId, {
          leadsCreated: 0,
          leadsQualified: 0,
          sessionStatus: 'Completed',
        });
        sessionIds.push(finalCrawlSessionId);
        continue;
      }

      // Enforce maxDailyCrawls guardrail
      const filteredBrandUrls = [];
      const crawlCountPerNiche = new Map<string, number>();

      for (const item of allBrandUrls) {
        const niche = nicheMap.get(item.nicheId);
        const maxCrawls = niche?.pipelineGuardrails?.maxDailyCrawls || 10;

        const currentCount = crawlCountPerNiche.get(item.nicheId) || 0;
        if (currentCount >= maxCrawls) {
          continue; // Reached limit
        }

        filteredBrandUrls.push(item);
        crawlCountPerNiche.set(item.nicheId, currentCount + 1);
      }

      allBrandUrls = filteredBrandUrls;

      const leadsDiscovered = allBrandUrls.length;
      totalLeadsDiscovered += leadsDiscovered;

      const pipelineTasks = allBrandUrls.map(
        ({ url, nicheId }) =>
          () =>
            runPipeline({
              userId: settings.userId,
              pipelineId:
                nicheMap.get(nicheId)?.pipelineId || 'default-pipeline',
              url,
              nicheId,
              crawlSessionId: finalCrawlSessionId,
              crawlSource: 'cron-crawl',
            })
      );

      const pipelineResults = await runWithConcurrencyLimit(
        pipelineTasks,
        settings.maxConcurrentPipelines
      );

      const leadsQualified = pipelineResults.filter((id) => id !== null).length;
      totalLeadsQualified += leadsQualified;
      sessionIds.push(finalCrawlSessionId);

      // Build per-niche stats and evaluate health
      const nicheStats = new Map<
        string,
        { qualified: number; total: number }
      >();
      for (let i = 0; i < allBrandUrls.length; i++) {
        const { nicheId } = allBrandUrls[i];
        const stat = nicheStats.get(nicheId) ?? { qualified: 0, total: 0 };
        stat.total++;
        if (pipelineResults[i] !== null) stat.qualified++;
        nicheStats.set(nicheId, stat);
      }
      const { evaluateNicheHealth } =
        await import('../../../../../lib/agents/nicheHealthEvaluator');
      await evaluateNicheHealth(
        settings.userId,
        finalCrawlSessionId,
        nicheStats
      );

      await updateCrawlSession(finalCrawlSessionId, {
        leadsCreated: leadsDiscovered,
        leadsQualified,
        sessionStatus: 'Completed',
      });
    }

    return NextResponse.json({
      leadsDiscovered: totalLeadsDiscovered,
      leadsQualified: totalLeadsQualified,
      sessionIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Cron crawl failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
