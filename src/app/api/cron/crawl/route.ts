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
      const activeNiches = niches.filter((n) =>
        activePipelineIds.includes(n.pipelineId)
      );
      if (activeNiches.length === 0) continue;

      const nicheMap = new Map(activeNiches.map((n) => [n.id, n]));

      // We'll pass activeNiches to the strategy agent to only consider them
      // This requires modifying runCrawlStrategyAgent to accept an array of niche IDs to filter by, or we just rely on it picking.
      // For now, let's allow it to pick from active niches.
      const strategy = await runCrawlStrategyAgent(settings.userId);
      const { crawlSessionId, crawlTargets } = strategy;

      // Only prospect targets that are part of active pipelines
      const activeCrawlTargets = crawlTargets.filter((t) =>
        nicheMap.has(t.nicheId)
      );
      if (activeCrawlTargets.length === 0) continue;

      const prospectorResults = await runAutoProspector(
        activeCrawlTargets,
        crawlSessionId
      );

      let allBrandUrls: { url: string; nicheId: string }[] =
        prospectorResults.flatMap((r) =>
          r.brandUrls.map((url) => ({ url, nicheId: r.nicheId }))
        );

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
              crawlSessionId,
              crawlSource: 'cron-crawl',
            })
      );

      const pipelineResults = await runWithConcurrencyLimit(
        pipelineTasks,
        settings.maxConcurrentPipelines
      );

      const leadsQualified = pipelineResults.filter((id) => id !== null).length;
      totalLeadsQualified += leadsQualified;
      sessionIds.push(crawlSessionId);

      await updateCrawlSession(crawlSessionId, {
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
