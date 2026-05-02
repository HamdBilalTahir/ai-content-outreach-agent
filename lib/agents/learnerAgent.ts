import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  getIntelligenceRegistry,
  updateIntelligenceRegistry,
} from '../db/intelligence';
import {
  getPlaybook,
  uploadPlaybook,
  deletePlaybook,
} from '../services/blobStorage';
import type { FeedbackSignal } from '../types';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-flash-live-preview',
});

const DEFAULT_PLAYBOOKS = {
  strategist: `# Strategist Playbook
- **Mission**: Identify high-conversion niches and targets.
- **Rules**: Base target selection on metrics, not intuition.`,
  copywriter: `# Copywriter Playbook
- **Mission**: Write compelling, short WhatsApp pitches.
- **Rules**: Keep it under 300 characters. Conversational tone.`,
  scraper: `# Scraper Playbook
- **Mission**: Extract structural brand data and media.
- **Rules**: Ignore irrelevant domains. Keep data structured.`,
  auditor: `# Auditor Playbook
- **Mission**: Analyze social media presence and visual quality.
- **Rules**: Provide objective scores based on media rules.`,
  analyst: `# Analyst Playbook
- **Mission**: Synthesize scraper and auditor data into cohesive gap scores.
- **Rules**: Provide clear, concise narratives for scoring decisions.`,
};

function buildLearnerPrompt(
  agentRole: string,
  currentPlaybook: string,
  signal: FeedbackSignal
): string {
  return `You are the Learner Agent updating the **${agentRole}** playbook based on human feedback.

## Current Playbook:
${currentPlaybook}

## New Feedback Signal:
- Outcome: ${signal.outcome}
- Pitch Angle Used: ${signal.pitchAngleUsed}
- Gap Score: ${signal.gapScoreAtPitch}
- Notes: ${signal.notes || 'No specific notes'}

## Task:
Synthesize this feedback into the playbook. If the feedback contains explicit rules (e.g., "Stop pitching SEO"), add a clear rule to the "Rules" or "Blacklist" section. If the outcome is positive ("Closed"), reinforce the successful patterns.

Respond ONLY with the updated raw Markdown for the playbook. Do not wrap it in \`\`\`markdown backticks, just return the text itself.`;
}

export async function runBatchLearnerAgent(
  userId: string,
  pipelineId: string,
  approvedLeads: any[],
  rejectedLeads: any[],
  humanEditedMessages: any[]
): Promise<void> {
  const rolesToUpdate = ['strategist', 'copywriter']; // We mainly update Strategist and Copywriter based on sandbox batch

  for (const role of rolesToUpdate) {
    let currentPlaybook =
      DEFAULT_PLAYBOOKS[role as keyof typeof DEFAULT_PLAYBOOKS] ||
      `# ${role} Playbook`;
    let currentBlobUrl = null;

    const registry = await getIntelligenceRegistry(userId, pipelineId, role);
    if (registry && registry.blobUrl) {
      currentBlobUrl = registry.blobUrl;
      try {
        currentPlaybook = await getPlaybook(registry.blobUrl);
      } catch (err) {
        console.warn(
          `Could not fetch existing playbook for ${role}, using default.`
        );
      }
    }

    const prompt = `You are the Learner Agent updating the **${role}** playbook based on a recent Sandbox run batch of explicit human approvals, rejections, and edits.

## Current Playbook:
${currentPlaybook}

## Batch Data:
- Approved Leads: ${approvedLeads.length} targets. E.g. ${approvedLeads.map((l: any) => l.brandName).join(', ')}
- Rejected Leads: ${rejectedLeads.length} targets. E.g. ${rejectedLeads.map((l: any) => l.brandName).join(', ')}
- Human Edited Messages:
${humanEditedMessages.map((m: any) => `  * Original: "${m.original}"\n  * Edited: "${m.edited}"`).join('\n')}

## Task:
Analyze the user's explicit approvals, rejections, and copy edits. Rewrite your current Playbook Markdown to reflect these new preferences.
For example, if you are the Strategist, add rules about what types of targets to avoid based on rejections. If you are the Copywriter, mimic the human's edited messaging style.

Respond ONLY with the updated raw Markdown for the playbook. Do not wrap it in \`\`\`markdown backticks, just return the text itself.`;

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

    const newBlobUrl = await uploadPlaybook(userId, role, newPlaybookMarkdown);

    await updateIntelligenceRegistry(
      userId,
      pipelineId,
      role,
      newBlobUrl,
      true
    );

    if (currentBlobUrl) {
      try {
        await deletePlaybook(currentBlobUrl);
      } catch (err) {
        console.warn(
          `Failed to delete old playbook blob: ${currentBlobUrl}`,
          err
        );
      }
    }
  }
}

export async function runLearnerAgent(
  userId: string,
  pipelineId: string,
  signal: FeedbackSignal
): Promise<void> {
  const rolesToUpdate = [
    'strategist',
    'copywriter',
    'scraper',
    'auditor',
    'analyst',
  ];

  // A more sophisticated system might route feedback to specific agents based on the notes content.
  // For now, we'll run the learner for all agents so they can each absorb the feedback if relevant.
  for (const role of rolesToUpdate) {
    let currentPlaybook =
      DEFAULT_PLAYBOOKS[role as keyof typeof DEFAULT_PLAYBOOKS] ||
      `# ${role} Playbook`;
    let currentBlobUrl = null;

    const registry = await getIntelligenceRegistry(userId, pipelineId, role);
    if (registry && registry.blobUrl) {
      currentBlobUrl = registry.blobUrl;
      try {
        currentPlaybook = await getPlaybook(registry.blobUrl);
      } catch (err) {
        console.warn(
          `Could not fetch existing playbook for ${role}, using default.`
        );
      }
    }

    const prompt = buildLearnerPrompt(role, currentPlaybook, signal);
    const result = await model.generateContent(prompt);
    let newPlaybookMarkdown = result.response.text().trim();

    // Clean up potential markdown formatting backticks if the model ignores instructions
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

    const newBlobUrl = await uploadPlaybook(userId, role, newPlaybookMarkdown);

    await updateIntelligenceRegistry(
      userId,
      pipelineId,
      role,
      newBlobUrl,
      true
    );

    if (currentBlobUrl) {
      try {
        await deletePlaybook(currentBlobUrl);
      } catch (err) {
        console.warn(
          `Failed to delete old playbook blob: ${currentBlobUrl}`,
          err
        );
      }
    }
  }
}
