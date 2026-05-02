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

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let forceNicheId: string | undefined;
    let maxTargets: number | undefined;
    let isSandbox = false;
    let pipelineId: string | undefined;
    try {
      const body = await req.json();
      forceNicheId = body.forceNicheId;
      maxTargets = body.maxTargets ? Number(body.maxTargets) : undefined;
      isSandbox = !!body.isSandbox;
      pipelineId = body.pipelineId;
    } catch {
      // Ignore JSON parse errors
    }

    const settings = await getSettings(userId);
    if (!settings.crawlEnabled) {
      return NextResponse.json(
        { message: 'Crawling is disabled in settings' },
        { status: 200 }
      );
    }

    // Start strategy agent to get a session ID
    const strategy = await runCrawlStrategyAgent(
      userId,
      forceNicheId,
      isSandbox,
      pipelineId
    );
    const { crawlSessionId, crawlTargets } = strategy;

    // Run the rest of the pipeline in the background
    // (We don't await this so the response returns immediately)
    runBackgroundCrawl(
      userId,
      crawlSessionId,
      crawlTargets,
      settings,
      maxTargets,
      isSandbox,
      pipelineId
    ).catch((err) => {
      console.error('Background crawl failed:', err);
    });

    return NextResponse.json({
      success: true,
      message: 'Crawl started in the background.',
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

async function runBackgroundCrawl(
  userId: string,
  crawlSessionId: string,
  crawlTargets: any[],
  settings: any,
  maxTargets?: number,
  isSandbox?: boolean,
  pipelineId?: string
) {
  try {
    const prospectorResults = await runAutoProspector(
      crawlTargets,
      crawlSessionId
    );

    let allBrandUrls: { url: string; nicheId: string }[] =
      prospectorResults.flatMap((r) =>
        r.brandUrls.map((url) => ({ url, nicheId: r.nicheId }))
      );

    if (maxTargets && maxTargets > 0) {
      allBrandUrls = allBrandUrls.slice(0, maxTargets);
    }

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
            isSandbox,
            pipelineId: pipelineId || 'default-pipeline',
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
  } catch (err) {
    console.error('Background crawl error:', err);
    await updateCrawlSession(crawlSessionId, {
      sessionStatus: 'Failed',
    });
  }
}
