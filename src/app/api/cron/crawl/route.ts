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

    for (const settings of allSettings) {
      if (
        !settings.crawlEnabled ||
        currentHour !== settings.crawlScheduleHour
      ) {
        continue;
      }

      // Execute the pipeline for the specific user's settings
      const strategy = await runCrawlStrategyAgent(settings.userId);
      const { crawlSessionId, crawlTargets } = strategy;

      const prospectorResults = await runAutoProspector(
        crawlTargets,
        crawlSessionId
      );

      const allBrandUrls: { url: string; nicheId: string }[] =
        prospectorResults.flatMap((r) =>
          r.brandUrls.map((url) => ({ url, nicheId: r.nicheId }))
        );

      const leadsDiscovered = allBrandUrls.length;
      totalLeadsDiscovered += leadsDiscovered;

      const pipelineTasks = allBrandUrls.map(
        ({ url, nicheId }) =>
          () =>
            runPipeline({
              userId: settings.userId,
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
