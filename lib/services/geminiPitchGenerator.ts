import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { InstagramAudit } from './instagramAuditor';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const llm = new ChatGoogleGenerativeAI({
  model: 'gemini-3.1-flash-live-preview',
  apiKey: process.env.GEMINI_API_KEY,
});

const PitchOutputSchema = z.object({
  socialMediaGapScore: z
    .number()
    .min(1)
    .max(10)
    .describe(
      "Score 1–10 rating the brand's video content poverty. 10 = total poverty."
    ),
  pitchAngle: z.enum(['noVideo', 'badVideo', 'costPain', 'volumeHungry']),
  targetProductName: z.string(),
  targetProductImageUrl: z
    .string()
    .describe(
      'Must be one of the sanitized image URLs provided in the prompt.'
    ),
  generatedPitch: z
    .string()
    .describe('WhatsApp opener under 300 characters, conversational tone.'),
});

const structuredLlm = llm.withStructuredOutput(PitchOutputSchema);

const SYSTEM_PROMPT = `You are a commercial director auditing brands for visual content poverty.

Pitch angles:
- noVideo: brand has no video content at all — easiest sell
- badVideo: brand has video but it looks cheap/amateur — show them better is possible
- costPain: brand is already making video and feeling the cost — position as cheaper
- volumeHungry: brand needs a lot of content fast (new products, seasonal) — position for volume

Rules:
- Score socialMediaGapScore 1–10 (10 = complete media poverty, 1 = already producing great video)
- Write generatedPitch as a casual WhatsApp message, referencing the specific product by name
- Pitch must be under 300 characters — it's an opener, not a pitch deck
- targetProductImageUrl must be one of the sanitized image URLs you receive`;

export type PitchOutput = z.infer<typeof PitchOutputSchema>;

export interface GeminiPitchInput {
  pageText: string | null;
  sanitizedImages: string[];
  instagramData: InstagramAudit | null;
  brandName: string | null;
  productPrice: number | null;
}

function buildUserMessage(input: GeminiPitchInput): HumanMessage {
  const igSummary = input.instagramData
    ? `Instagram: ${input.instagramData.postCount} recent posts, hasReels=${input.instagramData.hasReels}, avgLikes=${input.instagramData.avgEngagement}`
    : 'Instagram: no data available';

  const textBlock = [
    `Brand: ${input.brandName ?? 'Unknown'}`,
    `Product price: ${input.productPrice != null ? `$${input.productPrice}` : 'unknown'}`,
    igSummary,
    '',
    'Website text:',
    input.pageText ?? '(no text available)',
    '',
    'Sanitized image URLs (choose targetProductImageUrl from this list):',
    ...input.sanitizedImages,
  ].join('\n');

  const imageBlocks = input.sanitizedImages.map((url) => ({
    type: 'image_url' as const,
    image_url: { url },
  }));

  return new HumanMessage({
    content: [{ type: 'text', text: textBlock }, ...imageBlocks],
  });
}

export async function generatePitch(
  input: GeminiPitchInput
): Promise<PitchOutput | null> {
  try {
    const result = await structuredLlm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      buildUserMessage(input),
    ]);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `geminiPitchGenerator failed for brand "${input.brandName}": ${message}`
    );
    return null;
  }
}
