import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import {
  createPipeline,
  updatePipeline,
} from '../../../../../lib/db/pipelines';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { uploadPlaybook } from '../../../../../lib/services/blobStorage';
import { updateIntelligenceRegistry } from '../../../../../lib/db/intelligence';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-pro-preview',
});

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { name, user_urls, clientSeedUrls, detailed_goal, concept_strategy } =
      await req.json();
    if (!name || !detailed_goal || !concept_strategy) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Create pipeline
    const pipelineId = await createPipeline({
      userId,
      name,
      description: detailed_goal,
      status: 'paused',
      connectionId: null,
      settings: {
        overrideGlobalDeduplication: false,
      },
    });

    // Also store user_urls and strategy in the pipeline
    await updatePipeline(userId, pipelineId, {
      clientSeedUrls: clientSeedUrls
        ? clientSeedUrls
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
      settings: {
        overrideGlobalDeduplication: false,
        sourceUrls: user_urls,
        conceptStrategy: concept_strategy,
      } as any,
    });

    const roles = ['strategist', 'copywriter', 'scraper', 'auditor', 'analyst'];

    // Generate Playbooks concurrently
    await Promise.all(
      roles.map(async (role) => {
        const prompt = `Based on the following approved strategy, write a Markdown Playbook for the "${role}" agent persona in an autonomous outreach system.
      
Detailed Goal: ${detailed_goal}
Concept Strategy: ${concept_strategy}
Source URLs: ${user_urls}

Generate only raw markdown for the playbook rules. Make it concise and actionable.`;

        const result = await model.generateContent(prompt);
        let newPlaybookMarkdown = result.response.text().trim();

        if (newPlaybookMarkdown.startsWith('```markdown')) {
          newPlaybookMarkdown = newPlaybookMarkdown
            .replace(/^```markdown/, '')
            .replace(/```$/, '')
            .trim();
        } else if (newPlaybookMarkdown.startsWith('```')) {
          newPlaybookMarkdown = newPlaybookMarkdown
            .replace(/^```/, '')
            .replace(/```$/, '')
            .trim();
        }

        const blobUrl = await uploadPlaybook(userId, role, newPlaybookMarkdown);
        await updateIntelligenceRegistry(
          userId,
          pipelineId,
          role as any,
          blobUrl,
          true
        );
      })
    );

    return NextResponse.json({ success: true, pipelineId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Init pipeline failed:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
