import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { scrapeBrandWebsite } from '../services/websiteScraper';
import { sanitizeImages } from '../utils/sanitizeImages';
import { auditInstagram } from '../services/instagramAuditor';
import { generatePitch } from '../services/geminiPitchGenerator';
import { createLead } from '../db/leads';
import { createPitchEvaluation } from '../db/pitchEvaluations';
import { getNicheById } from '../db/niches';
import { getCrawlSessionStatus, appendAgentLog } from '../db/crawlSessions';
import type { ScrapedBrand } from '../services/websiteScraper';
import type { InstagramAudit } from '../services/instagramAuditor';
import type { PitchOutput } from '../services/geminiPitchGenerator';

const PipelineAnnotation = Annotation.Root({
  userId: Annotation<string>,
  pipelineId: Annotation<string>,
  url: Annotation<string>,
  isDuplicate: Annotation<boolean>,
  nicheId: Annotation<string>,
  crawlSessionId: Annotation<string | null>,
  crawlSource: Annotation<string>,
  isSandbox: Annotation<boolean | undefined>,
  scrapedData: Annotation<ScrapedBrand | null>,
  sanitizedImages: Annotation<string[]>,
  instagramData: Annotation<InstagramAudit | null>,
  aiEvaluation: Annotation<PitchOutput | null>,
  leadId: Annotation<string | null>,
  error: Annotation<string | null>,
  playbooks: Annotation<Record<string, string>>,
});

type PipelineState = typeof PipelineAnnotation.State;

async function checkStatus(state: PipelineState) {
  if (state.crawlSessionId) {
    const status = await getCrawlSessionStatus(state.crawlSessionId);
    if (status === 'Stopped') {
      await appendAgentLog(
        state.crawlSessionId,
        'strategist',
        '🛑 Abort signal received from Overseer. Halting all agent activity safely.'
      );
      throw new Error('Pipeline stopped by user');
    }
  }
}

async function globalDeduplicationNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  await checkStatus(state);

  const { getPipelineById } = await import('../db/pipelines');
  const pipeline = await getPipelineById(state.userId, state.pipelineId);
  const overrideGlobalDeduplication =
    pipeline?.settings?.overrideGlobalDeduplication || false;

  if (overrideGlobalDeduplication) {
    return { isDuplicate: false };
  }

  const { db } = await import('../firebase/admin');
  const dedupHash = state.url.toLowerCase().replace(/\/$/, '');

  // Check if lead exists globally (any user or pipeline? The requirement says "any pipeline in the system", usually scoped to user but let's scope to user to be safe, or globally?)
  // "already been contacted by ANY pipeline in the system" -> we check where dedupHash == this hash.
  const snapshot = await db
    .collection('leads')
    .where('dedupHash', '==', dedupHash)
    .where('userId', '==', state.userId)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    if (state.crawlSessionId) {
      await appendAgentLog(
        state.crawlSessionId,
        'strategist',
        'Target identified, but global scan indicates previous contact by another campaign. Skipping.'
      );
    }
    return { isDuplicate: true };
  }

  return { isDuplicate: false };
}

function checkDuplicateAfterInitial(
  state: PipelineState
): typeof END | 'scrapeWebsiteNode' {
  if (state.isDuplicate) return END;
  return 'scrapeWebsiteNode';
}

async function scrapeWebsiteNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  await checkStatus(state);
  if (state.crawlSessionId)
    await appendAgentLog(
      state.crawlSessionId,
      'scraper',
      `Extracting site architecture from ${state.url}. Passing data to the Auditor.`
    );
  const scrapedData = await scrapeBrandWebsite(state.url);

  // Check whatsapp number globally
  if (scrapedData?.whatsappNumber) {
    const { getPipelineById } = await import('../db/pipelines');
    const pipeline = await getPipelineById(state.userId, state.pipelineId);
    const overrideGlobalDeduplication =
      pipeline?.settings?.overrideGlobalDeduplication || false;

    if (!overrideGlobalDeduplication) {
      const { db } = await import('../firebase/admin');
      // strict normalize
      const normalizedPhone = scrapedData.whatsappNumber.replace(/\D/g, '');
      const snapshot = await db
        .collection('leads')
        .where('whatsappNumber', '==', normalizedPhone)
        .where('userId', '==', state.userId)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        if (state.crawlSessionId) {
          await appendAgentLog(
            state.crawlSessionId,
            'strategist',
            'Target identified, but global scan indicates previous contact by another campaign. Skipping.'
          );
        }
        return {
          scrapedData: { ...scrapedData, whatsappNumber: normalizedPhone },
          isDuplicate: true,
        };
      }
      return {
        scrapedData: { ...scrapedData, whatsappNumber: normalizedPhone },
      };
    }
  }

  return { scrapedData };
}

function checkDuplicateAfterScrape(
  state: PipelineState
): typeof END | 'sanitizeImagesNode' {
  if (state.isDuplicate) return END;
  return 'sanitizeImagesNode';
}

async function sanitizeImagesNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  await checkStatus(state);
  if (state.crawlSessionId)
    await appendAgentLog(
      state.crawlSessionId,
      'scraper',
      `Cleaning up raw images from ${state.url} to prep for analysis.`
    );
  const raw = state.scrapedData?.imageUrls ?? [];
  return { sanitizedImages: sanitizeImages(raw) };
}

async function auditInstagramNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  await checkStatus(state);
  const instagramUrl = state.scrapedData?.instagramUrl ?? null;
  if (state.crawlSessionId)
    await appendAgentLog(
      state.crawlSessionId,
      'auditor',
      `Running forensics on ${instagramUrl || state.url}. Handing my report to the Lead Analyst.`
    );
  const instagramData = await auditInstagram(instagramUrl);
  return { instagramData };
}

async function generatePitchNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  await checkStatus(state);

  const aiEvaluation = await generatePitch({
    pageText: state.scrapedData?.pageText ?? null,
    sanitizedImages: state.sanitizedImages,
    instagramData: state.instagramData,
    brandName: state.scrapedData?.brandName ?? null,
    productPrice: state.scrapedData?.productPrice ?? null,
    playbooks: (state as any).playbooks,
  });

  if (state.crawlSessionId && aiEvaluation) {
    await appendAgentLog(
      state.crawlSessionId,
      'analyst',
      `Reviewing reports from Scraper and Auditor for ${state.url}. ${aiEvaluation.analystNarrative || `I am scoring their Visual Poverty at ${aiEvaluation.socialMediaGapScore}/10. Tagging Copywriter to draft the pitch.`}`
    );
    await appendAgentLog(
      state.crawlSessionId,
      'copywriter',
      `${aiEvaluation.copywriterNarrative || `Drafting outreach message using the ${aiEvaluation.pitchAngle} angle. Pitch finalized and saved to Sandbox Queue.`}`
    );
  }
  return { aiEvaluation };
}

async function saveLeadNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  await checkStatus(state);
  if (state.crawlSessionId)
    await appendAgentLog(
      state.crawlSessionId,
      'system',
      `Lead ${state.url} has been qualified and persisted to the database.`
    );

  const {
    scrapedData,
    aiEvaluation,
    url,
    nicheId,
    crawlSessionId,
    crawlSource,
    isSandbox,
  } = state;

  // Assume state includes userId, so let's pull it from the graph state or pass it through.
  // Wait, I didn't add userId to PipelineAnnotation! Let's do that next.
  const userId = state.userId || '';

  const dedupHash = url.toLowerCase().replace(/\/$/, '');

  const leadId = await createLead({
    userId,
    pipelineId: state.pipelineId,
    nicheId,
    crawlSessionId,
    brandName: scrapedData?.brandName ?? url,
    websiteUrl: url,
    whatsappNumber: scrapedData?.whatsappNumber ?? '',
    instagramUrl: scrapedData?.instagramUrl ?? null,
    targetProductName: aiEvaluation?.targetProductName ?? null,
    targetProductImageUrl: aiEvaluation?.targetProductImageUrl ?? null,
    generatedPitch: aiEvaluation?.generatedPitch ?? null,
    pitchAngle: aiEvaluation?.pitchAngle ?? null,
    crawlSource,
    dedupHash,
    socialMediaGapScore: aiEvaluation?.socialMediaGapScore ?? 0,
    status: 'Qualified',
    isSandbox,
    dispatchStatus: isSandbox ? 'pending_approval' : undefined,
  });

  if (aiEvaluation) {
    await createPitchEvaluation({
      userId,
      leadId,
      gapScore: aiEvaluation.socialMediaGapScore,
      pitchAngle: aiEvaluation.pitchAngle,
      sanitizedImages: state.sanitizedImages,
      websiteTextSummary: scrapedData?.pageText?.slice(0, 500) ?? '',
      igPostSummary: state.instagramData
        ? `${state.instagramData.postCount} posts, hasReels=${state.instagramData.hasReels}, avgLikes=${state.instagramData.avgEngagement}`
        : '',
      rawGeminiResponse: JSON.stringify(aiEvaluation),
    });
  }

  return { leadId };
}

function shouldSaveLead(state: PipelineState): typeof END | 'saveLeadNode' {
  if (!state.aiEvaluation) return END;
  if (state.aiEvaluation.socialMediaGapScore < 8) return END;
  if (!state.scrapedData?.whatsappNumber) return END;
  return 'saveLeadNode';
}

const graph = new StateGraph(PipelineAnnotation)
  .addNode('globalDeduplicationNode', globalDeduplicationNode)
  .addNode('scrapeWebsiteNode', scrapeWebsiteNode)
  .addNode('sanitizeImagesNode', sanitizeImagesNode)
  .addNode('auditInstagramNode', auditInstagramNode)
  .addNode('generatePitchNode', generatePitchNode)
  .addNode('saveLeadNode', saveLeadNode)
  .addEdge(START, 'globalDeduplicationNode')
  .addConditionalEdges('globalDeduplicationNode', checkDuplicateAfterInitial)
  .addConditionalEdges('scrapeWebsiteNode', checkDuplicateAfterScrape)
  .addEdge('sanitizeImagesNode', 'auditInstagramNode')
  .addEdge('auditInstagramNode', 'generatePitchNode')
  .addConditionalEdges('generatePitchNode', shouldSaveLead)
  .addEdge('saveLeadNode', END)
  .compile();

export interface PipelineInput {
  userId: string;
  pipelineId: string;
  url: string;
  nicheId: string;
  crawlSessionId: string | null;
  crawlSource: string;
  isSandbox?: boolean;
}

export async function runPipeline(
  input: PipelineInput
): Promise<string | null> {
  try {
    // Before invoking, fetch playbooks for RAG
    const { getAllIntelligenceForPipeline } =
      await import('../db/intelligence');
    const { getPlaybook } = await import('../services/blobStorage');

    const registries = await getAllIntelligenceForPipeline(
      input.userId,
      input.pipelineId
    );

    const playbooks: Record<string, string> = {};
    for (const reg of registries) {
      try {
        playbooks[reg.agentRole] = await getPlaybook(reg.blobUrl);
      } catch (e) {
        console.warn(`Failed to fetch playbook for ${reg.agentRole}`);
      }
    }

    // Pass the playbook to generatePitchNode
    (input as any).playbooks = playbooks;

    const result = await graph.invoke({
      ...input,
      isDuplicate: false,
      scrapedData: null,
      sanitizedImages: [],
      instagramData: null,
      aiEvaluation: null,
      leadId: null,
      error: null,
    });

    return result.leadId ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`runPipeline failed for ${input.url}: ${message}`);
    return null;
  }
}
