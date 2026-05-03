import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { scrapeBrandWebsite } from '../../../../../lib/services/websiteScraper';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const llm = new ChatGoogleGenerativeAI({
  model: 'gemini-3.1-pro-preview',
  apiKey: process.env.GEMINI_API_KEY,
});

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const reqBody = await req.json();
    const { user_urls, rough_goal, images } = reqBody;
    if (!rough_goal) {
      return NextResponse.json(
        { error: 'rough_goal is required' },
        { status: 400 }
      );
    }

    // Extract base64 images
    const imageParts = Array.isArray(images) ? images : [];

    // Split urls and scrape the first one for context
    const urls = user_urls
      ? user_urls
          .split(',')
          .map((u: string) => u.trim())
          .filter((u: string) => u.length > 0)
      : [];
    let scrapedText = '';
    if (urls.length > 0) {
      try {
        const data = await scrapeBrandWebsite(urls[0]);
        scrapedText = data?.pageText?.slice(0, 3000) || 'No text extracted';
      } catch (err) {
        console.warn('Failed to scrape URL, continuing with rough goal:', err);
        scrapedText = 'Could not extract website data.';
      }
    }

    const textPrompt = `Based on this company data, uploaded images (if any) and the rough goal, output a JSON object with two fields: detailed_goal (what we are selling) and concept_strategy (how we will pitch it, our tone, and target traits).

Company Data:
${scrapedText}

Rough Goal: ${rough_goal}

Respond ONLY with a valid JSON object:
{
  "detailed_goal": "<expanded goal>",
  "concept_strategy": "<pitch strategy>"
}`;

    const messageContent: any[] = [{ type: 'text', text: textPrompt }];

    if (imageParts.length > 0) {
      imageParts.forEach((base64Str: string) => {
        messageContent.push({
          type: 'image_url',
          image_url: { url: base64Str },
        });
      });
    }

    console.log(
      'Sending generate-strategy request to Gemini using LangChain...'
    );
    console.log('Text Prompt:', textPrompt);
    console.log(`Included ${imageParts.length} images.`);

    const message = new HumanMessage({ content: messageContent });
    const result = await llm.invoke([message]);

    let raw = (result.content as string).trim();
    if (raw.startsWith('```json'))
      raw = raw
        .replace(/^```json/, '')
        .replace(/```$/, '')
        .trim();
    if (raw.startsWith('```'))
      raw = raw.replace(/^```/, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON from Gemini');
    }

    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Generate strategy preview failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
