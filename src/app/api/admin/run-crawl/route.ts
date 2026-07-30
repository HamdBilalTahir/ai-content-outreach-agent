import { NextResponse } from 'next/server';
import { runCrawlStrategyAgent } from '../../../../../lib/agents/crawlStrategyAgent';
import { runAutoProspector } from '../../../../../lib/services/autoprospector';
import { runPipeline } from '../../../../../lib/pipeline/runPipeline';
import { updateCrawlSession } from '../../../../../lib/db/crawlSessions';
import { getSettings } from '../../../../../lib/db/settings';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

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

import {
  createCrawlSession,
  getCrawlSession,
} from '../../../../../lib/db/crawlSessions';
import { appendAgentLog } from '../../../../../lib/db/crawlSessions';

export async function POST(req: Request) {
  console.log(`\n--- POST /api/admin/run-crawl ---`);
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let forceNicheId: string | undefined;
    let maxTargets: number | undefined;
    let isSandbox = false;
    let pipelineId: string | undefined;
    let resumeSessionId: string | undefined;
    try {
      const body = await req.json();
      forceNicheId = body.forceNicheId;
      maxTargets = body.maxTargets ? Number(body.maxTargets) : undefined;
      isSandbox = !!body.isSandbox;
      pipelineId = body.pipelineId;
      resumeSessionId = body.resumeSessionId;
    } catch {
      // Ignore JSON parse errors
    }

    const settings = await getSettings(userId);
    console.log(
      `[run-crawl] Settings loaded. crawlEnabled: ${settings.crawlEnabled}`
    );
    if (!settings.crawlEnabled) {
      console.log(`[run-crawl] 🛑 Crawling disabled in settings. Exiting.`);
      return NextResponse.json(
        { message: 'Crawling is disabled in settings' },
        { status: 200 }
      );
    }

    const activePipelineId = pipelineId || 'default-pipeline';
    let crawlSessionId = resumeSessionId;

    if (resumeSessionId) {
      console.log(`[run-crawl] Resuming session: ${resumeSessionId}`);
      await updateCrawlSession(resumeSessionId, { sessionStatus: 'Running' });
      await appendAgentLog(
        resumeSessionId,
        'system',
        'Resuming crawl session from checkpoint...'
      );
    } else {
      // Create the crawl session immediately so the frontend can subscribe to it
      crawlSessionId = await createCrawlSession({
        userId,
        pipelineId: activePipelineId,
        nicheId: forceNicheId || 'auto',
        targetUrls: [],
        discoveredBrands: [],
        leadsCreated: 0,
        leadsQualified: 0,
        agentReasoning: 'Initializing strategy...',
        sessionStatus: 'Running',
        completedAt: null,
        isSandbox: isSandbox || false,
        agentLogs: [
          {
            timestamp: new Date().toISOString(),
            agentRole: 'strategist',
            narrative:
              'Initializing the strategy engine. Reviewing pipeline parameters...',
          },
        ],
      });
    }

    // Run the rest of the pipeline in the background
    // (We don't await this so the response returns immediately)
    console.log(
      `[run-crawl] Spawning background crawl for session ${crawlSessionId}...`
    );
    runBackgroundCrawl(
      userId,
      crawlSessionId!,
      forceNicheId,
      settings,
      maxTargets,
      isSandbox,
      activePipelineId,
      !!resumeSessionId
    ).catch((err) => {
      console.error('Background crawl failed:', err);
    });

    return NextResponse.json({
      success: true,
      message: resumeSessionId
        ? 'Crawl resumed in the background.'
        : 'Crawl started in the background.',
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
  forceNicheId: string | undefined,
  settings: any,
  maxTargets?: number,
  isSandbox?: boolean,
  pipelineId?: string,
  isResuming?: boolean
) {
  console.log(`\n[Background Crawl] Started for session ${crawlSessionId}`);
  try {
    let allBrandUrls: { url: string; nicheId: string }[] = [];

    if (isResuming) {
      const session = await getCrawlSession(crawlSessionId);
      if (session?.discoveredBrands && session.discoveredBrands.length > 0) {
        console.log(
          `[run-crawl] Resuming with ${session.discoveredBrands.length} discovered brands from checkpoint.`
        );
        // Note: For simplicity we assume nicheId is the forceNicheId or 'auto' if not stored per brand in checkpoint
        allBrandUrls = session.discoveredBrands.map((url) => ({
          url,
          nicheId: forceNicheId || 'auto',
        }));
      }
    }

    let strategyAttempts = 0;
    const MAX_STRATEGY_ATTEMPTS = 2;

    if (!isResuming || allBrandUrls.length === 0) {
      let systemWarning: string | undefined;

      while (strategyAttempts < MAX_STRATEGY_ATTEMPTS) {
        strategyAttempts++;
        console.log(
          `[run-crawl] Invoking runCrawlStrategyAgent (Attempt ${strategyAttempts})...`
        );
        const strategy = await runCrawlStrategyAgent(
          userId,
          forceNicheId,
          isSandbox,
          pipelineId,
          crawlSessionId,
          systemWarning
        );
        const { targetNiches, agentReasoning } = strategy;

        await updateCrawlSession(crawlSessionId, {
          agentReasoning,
        });

        await appendAgentLog(
          crawlSessionId,
          'scraper',
          `Strategy received. I will now prospect the target URLs across the requested niches to map out potential leads.`
        );

        const prospectorResults = await runAutoProspector(
          targetNiches,
          crawlSessionId
        );

        allBrandUrls = prospectorResults.flatMap((r) =>
          r.brandUrls.map((url) => ({ url, nicheId: r.nicheId }))
        );

        if (maxTargets && maxTargets > 0) {
          allBrandUrls = allBrandUrls.slice(0, maxTargets);
        }

        if (allBrandUrls.length > 0) {
          break; // Found leads, exit retry loop
        } else {
          console.log(
            `[Background Crawl] 0 leads discovered on attempt ${strategyAttempts}.`
          );
          systemWarning = `SYSTEM WARNING: Both Tavily searches and Firecrawl maps resulted in 0 usable company domains. Generate entirely new search queries and map targets focusing on a different angle.`;
          await appendAgentLog(crawlSessionId, 'strategist', systemWarning);
        }
      }
    }

    const leadsDiscovered = allBrandUrls.length;

    if (leadsDiscovered === 0) {
      console.log(
        `[Background Crawl] 0 leads discovered after ${MAX_STRATEGY_ATTEMPTS} attempts. Aborting.`
      );
      await updateCrawlSession(crawlSessionId, {
        leadsCreated: 0,
        leadsQualified: 0,
        sessionStatus: 'Completed',
      });
      return;
    }

    const pipelineTasks = allBrandUrls.map(({ url, nicheId }) => async () => {
      if (isResuming) {
        const session = await getCrawlSession(crawlSessionId);
        if (session?.processedBrands?.includes(url)) {
          console.log(
            `[Background Crawl] Skipping already processed URL: ${url}`
          );
          return null;
        }
      }

      const leadId = await runPipeline({
        userId,
        url,
        nicheId,
        crawlSessionId,
        crawlSource: 'manual-crawl',
        isSandbox,
        pipelineId: pipelineId || 'default-pipeline',
      });

      // Mark as processed regardless of success or failure
      const { markBrandProcessed } =
        await import('../../../../../lib/db/crawlSessions');
      await markBrandProcessed(crawlSessionId, url);

      return leadId;
    });

    console.log(
      `[Background Crawl] Executing ${pipelineTasks.length} pipelines with concurrency ${settings.maxConcurrentPipelines}...`
    );
    const pipelineResults = await runWithConcurrencyLimit(
      pipelineTasks,
      settings.maxConcurrentPipelines
    );

    const leadsQualified = pipelineResults.filter((id) => id !== null).length;
    console.log(
      `[Background Crawl] Pipelines finished. Leads qualified: ${leadsQualified}`
    );

    // Build per-niche stats and evaluate health
    const nicheStats = new Map<string, { qualified: number; total: number }>();
    for (let i = 0; i < allBrandUrls.length; i++) {
      const { nicheId } = allBrandUrls[i];
      const stat = nicheStats.get(nicheId) ?? { qualified: 0, total: 0 };
      stat.total++;
      if (pipelineResults[i] !== null) stat.qualified++;
      nicheStats.set(nicheId, stat);
    }
    const { evaluateNicheHealth } =
      await import('../../../../../lib/agents/nicheHealthEvaluator');
    await evaluateNicheHealth(userId, crawlSessionId, nicheStats);

    await appendAgentLog(
      crawlSessionId,
      'system',
      `Process completed successfully! Qualified ${leadsQualified} leads out of ${leadsDiscovered} discovered.`
    );

    await updateCrawlSession(crawlSessionId, {
      leadsCreated: leadsDiscovered,
      leadsQualified,
      sessionStatus: 'Completed',
    });
  } catch (err: any) {
    console.error('Background crawl error:', err);
    await appendAgentLog(
      crawlSessionId,
      'system',
      `Process failed with error: ${err?.message || 'Unknown error'}`
    );
    await updateCrawlSession(crawlSessionId, {
      sessionStatus: 'Failed',
    });
  }
}
