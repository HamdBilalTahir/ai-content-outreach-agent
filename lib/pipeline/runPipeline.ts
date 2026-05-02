import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { scrapeBrandWebsite } from '../services/websiteScraper';
import { sanitizeImages } from '../utils/sanitizeImages';
import { auditInstagram } from '../services/instagramAuditor';
import { generatePitch } from '../services/geminiPitchGenerator';
import { createLead } from '../db/leads';
import { createPitchEvaluation } from '../db/pitchEvaluations';
import { getNicheById } from '../db/niches';
import type { ScrapedBrand } from '../services/websiteScraper';
import type { InstagramAudit } from '../services/instagramAuditor';
import type { PitchOutput } from '../services/geminiPitchGenerator';

const PipelineAnnotation = Annotation.Root({
  userId: Annotation<string>,
  url: Annotation<string>,
  nicheId: Annotation<string>,
  crawlSessionId: Annotation<string | null>,
  crawlSource: Annotation<string>,
  scrapedData: Annotation<ScrapedBrand | null>,
  sanitizedImages: Annotation<string[]>,
  instagramData: Annotation<InstagramAudit | null>,
  aiEvaluation: Annotation<PitchOutput | null>,
  leadId: Annotation<string | null>,
  error: Annotation<string | null>,
});

type PipelineState = typeof PipelineAnnotation.State;

async function scrapeWebsiteNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  const scrapedData = await scrapeBrandWebsite(state.url);
  return { scrapedData };
}

async function sanitizeImagesNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  const raw = state.scrapedData?.imageUrls ?? [];
  return { sanitizedImages: sanitizeImages(raw) };
}

async function auditInstagramNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  const instagramUrl = state.scrapedData?.instagramUrl ?? null;
  const instagramData = await auditInstagram(instagramUrl);
  return { instagramData };
}

async function generatePitchNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  const aiEvaluation = await generatePitch({
    pageText: state.scrapedData?.pageText ?? null,
    sanitizedImages: state.sanitizedImages,
    instagramData: state.instagramData,
    brandName: state.scrapedData?.brandName ?? null,
    productPrice: state.scrapedData?.productPrice ?? null,
  });
  return { aiEvaluation };
}

async function saveLeadNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  const {
    scrapedData,
    aiEvaluation,
    url,
    nicheId,
    crawlSessionId,
    crawlSource,
  } = state;

  // Assume state includes userId, so let's pull it from the graph state or pass it through.
  // Wait, I didn't add userId to PipelineAnnotation! Let's do that next.
  const userId = state.userId || '';

  const dedupHash = url.toLowerCase().replace(/\/$/, '');

  const leadId = await createLead({
    userId,
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
  .addNode('scrapeWebsiteNode', scrapeWebsiteNode)
  .addNode('sanitizeImagesNode', sanitizeImagesNode)
  .addNode('auditInstagramNode', auditInstagramNode)
  .addNode('generatePitchNode', generatePitchNode)
  .addNode('saveLeadNode', saveLeadNode)
  .addEdge(START, 'scrapeWebsiteNode')
  .addEdge('scrapeWebsiteNode', 'sanitizeImagesNode')
  .addEdge('sanitizeImagesNode', 'auditInstagramNode')
  .addEdge('auditInstagramNode', 'generatePitchNode')
  .addConditionalEdges('generatePitchNode', shouldSaveLead)
  .addEdge('saveLeadNode', END)
  .compile();

export interface PipelineInput {
  userId: string;
  url: string;
  nicheId: string;
  crawlSessionId: string | null;
  crawlSource: string;
}

export async function runPipeline(
  input: PipelineInput
): Promise<string | null> {
  try {
    const result = await graph.invoke({
      ...input,
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
