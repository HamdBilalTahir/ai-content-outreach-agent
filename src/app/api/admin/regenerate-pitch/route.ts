import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { leadId, note, currentPitch } = await req.json();
    if (!leadId || !note) {
      return NextResponse.json(
        { error: 'leadId and note are required' },
        { status: 400 }
      );
    }

    if (!process.env.GEMINI_API_KEY) throw new Error('Missing Gemini Key');

    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.1-pro-preview',
      apiKey: process.env.GEMINI_API_KEY,
    });

    const prompt = `You are a copywriter rewriting an outreach pitch based on a user's note.
Current Pitch:
${currentPitch || '(No pitch provided)'}

User's Note / Instruction:
${note}

Rewrite the pitch according to the note. Keep it under 300 characters, conversational, and direct. Return ONLY the new pitch text, nothing else.`;

    const res = await llm.invoke(prompt);
    return NextResponse.json({
      success: true,
      newPitch: res.content.toString().trim(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
