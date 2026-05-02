import { NextResponse } from 'next/server';
import { runCrawlStrategyAgent } from '../../../../../lib/agents/crawlStrategyAgent';
import { runAutoProspector } from '../../../../../lib/services/autoprospector';
import { runPipeline } from '../../../../../lib/pipeline/runPipeline';
import { updateCrawlSession } from '../../../../../lib/db/crawlSessions';
import { getSettings } from '../../../../../lib/db/settings';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

const MAX_CONCURRENCY = 5;

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

export async function POST() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await getSettings(userId);
    if (!settings.crawlEnabled) {
      return NextResponse.json(
        { message: 'Crawling is disabled in settings' },
        { status: 200 }
      );
    }

    const strategy = await runCrawlStrategyAgent(userId);
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

    const pipelineTasks = allBrandUrls.map(
      ({ url, nicheId }) =>
        () =>
          runPipeline({
            userId,
            url,
            nicheId,
            crawlSessionId,
            crawlSource: 'manual-crawl',
          })
    );

    const pipelineResults = await runWithConcurrencyLimit(
      pipelineTasks,
      settings.maxConcurrentPipelines
    );

    const leadsQualified = pipelineResults.filter((id) => id !== null).length;

    await updateCrawlSession(crawlSessionId, {
      leadsCreated: leadsDiscovered,
      leadsQualified,
      sessionStatus: 'Completed',
    });

    return NextResponse.json({
      success: true,
      leadsDiscovered,
      leadsQualified,
      sessionId: crawlSessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Manual crawl failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
