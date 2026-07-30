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
import { appendAgentLog } from '../db/crawlSessions';
import type { FeedbackSignal } from '../types';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-pro-preview',
});

import { z } from 'zod';

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

const DissectionSchema = z.object({
  agentsToUpdate: z.array(
    z.object({
      agentRole: z.enum([
        'strategist',
        'scraper',
        'auditor',
        'analyst',
        'copywriter',
      ]),
      reasoning: z
        .string()
        .describe(
          'Detailed reasoning on why this agent failed and what it did wrong based on the feedback.'
        ),
      dataToChange: z
        .string()
        .describe(
          'Specific instructions on what new rules or intelligence should be added/changed in this agent’s markdown playbook.'
        ),
    })
  ),
});

export async function runBatchLearnerAgent(
  userId: string,
  pipelineId: string,
  approvedLeads: any[],
  rejectedLeads: any[],
  humanEditedMessages: any[],
  sessionId?: string
): Promise<void> {
  console.log(
    `\n[Agent: Learner] Starting batch synthesis for pipeline: ${pipelineId}`
  );
  console.log(
    `[Agent: Learner] Approved: ${approvedLeads.length}, Rejected: ${rejectedLeads.length}, Edits: ${humanEditedMessages.length}`
  );

  if (
    approvedLeads.length === 0 &&
    rejectedLeads.length === 0 &&
    humanEditedMessages.length === 0
  ) {
    console.log(`[Agent: Learner] No feedback to process. Skipping synthesis.`);
    if (sessionId) {
      await appendAgentLog(
        sessionId,
        'system',
        `No actionable feedback provided (0 approved, 0 rejected, 0 edits). Skipping intelligence synthesis.`
      );
    }
    return;
  }

  if (sessionId) {
    await appendAgentLog(
      sessionId,
      'system',
      `Starting intelligence synthesis... Reviewing ${approvedLeads.length} approved leads, ${rejectedLeads.length} rejections, and ${humanEditedMessages.length} message edits.`
    );
  }

  console.log(
    `\n[Agent: Learner - Rejection Understanding Node] Dissecting batch feedback to route intelligence updates...`
  );

  const reasons = rejectedLeads
    .map((l: any) => l.sandboxRejectionReason)
    .filter(Boolean);

  const { getPipelineById } = await import('../db/pipelines');
  const pipeline = await getPipelineById(userId, pipelineId);
  const pipelineGoal =
    pipeline?.description || 'Discover qualified brand leads.';

  const routerPrompt = `You are improving an outreach pipeline with this goal / Ideal Customer Profile:
"""
${pipelineGoal}
"""

Analyze the following batch feedback from a human Overseer:

Approved Leads: ${approvedLeads.length}
Rejected Leads with reasons:
${reasons.length > 0 ? reasons.map((r) => `- ${r}`).join('\n') : 'None'}
Human Edited Messages: ${humanEditedMessages.length}
${humanEditedMessages.map((m: any) => `  * Original: "${m.original}"\n  * Edited: "${m.edited}"`).join('\n')}

Based on this feedback, determine which agent(s) messed up or need their playbooks updated to improve future performance.
Available agents:
- strategist (responsible for finding targets, selecting niches, avoiding bad types of businesses)
- scraper (responsible for extracting website data, contact info, handling missing data)
- auditor (responsible for checking instagram/social media)
- analyst (responsible for scoring visual poverty and creating narrative)
- copywriter (responsible for writing the outreach pitch, tone, style)

You must output a structured JSON identifying the agent role, your reasoning for why they need an update, and the exact data/rules that need to be changed in their markdown intelligence files.`;

  let dissectionResults: {
    agentRole: string;
    reasoning: string;
    dataToChange: string;
  }[] = [];

  try {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.1-pro-preview',
      apiKey: process.env.GEMINI_API_KEY,
    });
    const structured = llm.withStructuredOutput(DissectionSchema);
    const res = await structured.invoke(routerPrompt);
    if (res && res.agentsToUpdate) {
      dissectionResults = res.agentsToUpdate;
    }

    if (sessionId) {
      const identifiedRoles = dissectionResults.map((r) => r.agentRole);
      if (identifiedRoles.length > 0) {
        await appendAgentLog(
          sessionId,
          'system',
          `Dissection complete! I've determined that the following agents need to update their playbooks: ${identifiedRoles.join(', ')}.`
        );
      }
    }

    if (
      dissectionResults.length === 0 &&
      (humanEditedMessages.length > 0 ||
        approvedLeads.length > 0 ||
        rejectedLeads.length > 0)
    ) {
      console.log(
        `[Agent: Learner] LLM returned empty dissection, generating fallback updates.`
      );
      if (humanEditedMessages.length > 0) {
        dissectionResults.push({
          agentRole: 'copywriter',
          reasoning:
            'Human edited messages indicate a change in tone or style is needed.',
          dataToChange: 'Update pitch templates to match human edits.',
        });
      }
      if (approvedLeads.length > 0 || rejectedLeads.length > 0) {
        dissectionResults.push({
          agentRole: 'strategist',
          reasoning:
            'Lead approval/rejection indicates targeting adjustments are needed.',
          dataToChange:
            'Update targeting rules to focus on approved profiles and avoid rejected ones.',
        });
      }
    }

    console.log(
      `[Agent: Learner] Dissection complete. Agents identified for update: ${dissectionResults.map((r) => r.agentRole).join(', ')}`
    );
  } catch (err) {
    console.warn(
      `[Agent: Learner] Failed to dynamically route feedback, aborting update`,
      err
    );
    return;
  }

  for (const updateTask of dissectionResults) {
    const role = updateTask.agentRole;
    console.log(
      `\n[Agent: Learner - Update Intelligence Node] Updating playbook for ${role}...`
    );
    console.log(`Reasoning: ${updateTask.reasoning}`);
    console.log(`Data to Change: ${updateTask.dataToChange}`);

    if (sessionId) {
      await appendAgentLog(
        sessionId,
        role as any,
        `Updating my playbook based on your feedback: "${updateTask.reasoning}"`
      );
    }

    let currentPlaybook =
      DEFAULT_PLAYBOOKS[role as keyof typeof DEFAULT_PLAYBOOKS] ||
      `# ${role} Playbook`;
    let currentBlobUrl = null;

    const registry = await getIntelligenceRegistry(userId, pipelineId, role);
    if (registry && registry.blobUrl) {
      currentBlobUrl = registry.blobUrl;
      try {
        currentPlaybook = await getPlaybook(registry.blobUrl);
      } catch {
        // ...
      }
    }

    const prompt = `You are the Update Intelligence Node. Your task is to update the **${role}**'s intelligence markdown playbook.

## Pipeline Goal / Ideal Customer Profile:
${pipelineGoal}

## Current Playbook:
${currentPlaybook}

## Reasoning for Update:
${updateTask.reasoning}

## Instructions for Change:
${updateTask.dataToChange}

Analyze the reasoning and instructions, and rewrite the Current Playbook Markdown to integrate these new intelligence updates. Keep the rules aligned with the Pipeline Goal / Ideal Customer Profile above. Ensure new rules are clearly added to "Rules" or "Blacklist" sections.

Respond ONLY with the updated raw Markdown for the playbook. Do not wrap it in \`\`\`markdown backticks, just return the text itself.`;

    const result = await model.generateContent(prompt);
    let newPlaybookMarkdown = result.response.text().trim();
    console.log(
      `[Agent: Learner] 📥 Gemini delivered the shiny new ${role} playbook:\n${newPlaybookMarkdown}`
    );

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
      role as any,
      newBlobUrl,
      true,
      updateTask.reasoning
    );

    if (currentBlobUrl && currentBlobUrl !== newBlobUrl) {
      try {
        await deletePlaybook(currentBlobUrl);
      } catch (err) {
        console.warn(
          `Failed to delete old playbook blob: ${currentBlobUrl}`,
          err
        );
      }
    }
    console.log(`[Agent: Learner] ✅ Playbook updated for role: ${role}`);
    if (sessionId) {
      await appendAgentLog(
        sessionId,
        role as any,
        `Successfully committed new rules to my Vercel Blob Playbook!`
      );
    }
  }
  console.log(`[Agent: Learner] ✅ Batch synthesis completed.`);
}

export async function runLearnerAgent(
  userId: string,
  pipelineId: string,
  signal: Pick<
    FeedbackSignal,
    'outcome' | 'pitchAngleUsed' | 'gapScoreAtPitch' | 'notes'
  >,
  sessionId?: string
): Promise<void> {
  console.log(
    `\n[Agent: Learner] Starting continuous synthesis for pipeline: ${pipelineId} based on signal: ${signal.outcome}`
  );

  if (sessionId) {
    await appendAgentLog(
      sessionId,
      'system',
      `Received your feedback. Analyzing what went wrong so the AI can learn and improve future runs...`
    );
  }

  console.log(
    `\n[Agent: Learner - Rejection Understanding Node] Dissecting continuous feedback to route intelligence updates...`
  );

  if (sessionId) {
    await appendAgentLog(
      sessionId,
      'system',
      `Identifying which AI agents were responsible for this mistake...`
    );
  }

  const { getPipelineById } = await import('../db/pipelines');
  const pipeline = await getPipelineById(userId, pipelineId);
  const pipelineGoal =
    pipeline?.description || 'Discover qualified brand leads.';

  const routerPrompt = `You are improving an outreach pipeline with this goal / Ideal Customer Profile:
"""
${pipelineGoal}
"""

Analyze the following continuous feedback from a human Overseer regarding a specific lead:

Outcome: ${signal.outcome}
Pitch Angle Used: ${signal.pitchAngleUsed}
Gap Score at Pitch: ${signal.gapScoreAtPitch}
Notes: ${signal.notes || 'No specific notes'}

Based on this feedback, determine which agent(s) messed up or need their playbooks updated to improve future performance.
Available agents:
- strategist (responsible for finding targets, selecting niches, avoiding bad types of businesses)
- scraper (responsible for extracting website data, contact info, handling missing data)
- auditor (responsible for checking instagram/social media)
- analyst (responsible for scoring visual poverty and creating narrative)
- copywriter (responsible for writing the outreach pitch, tone, style)

You must output a structured JSON identifying the agent role, your reasoning for why they need an update, and the exact data/rules that need to be changed in their markdown intelligence files.`;

  let dissectionResults: {
    agentRole: string;
    reasoning: string;
    dataToChange: string;
  }[] = [];

  try {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.1-pro-preview',
      apiKey: process.env.GEMINI_API_KEY,
    });
    const structured = llm.withStructuredOutput(DissectionSchema);
    const res = await structured.invoke(routerPrompt);
    if (res && res.agentsToUpdate) {
      dissectionResults = res.agentsToUpdate;
    }

    if (dissectionResults.length === 0) {
      console.log(
        `[Agent: Learner] LLM returned empty dissection, generating fallback updates.`
      );
      dissectionResults.push({
        agentRole: 'strategist',
        reasoning:
          'Feedback outcome indicates potential targeting adjustments needed.',
        dataToChange:
          'Review successful and failed profiles to update targeting rules.',
      });
      dissectionResults.push({
        agentRole: 'copywriter',
        reasoning: 'Outcome signals potential messaging issues.',
        dataToChange: 'Adjust pitch angles and tone to improve conversion.',
      });
    }

    console.log(
      `[Agent: Learner] Dissection complete. Agents identified for update: ${dissectionResults.map((r) => r.agentRole).join(', ')}`
    );

    if (sessionId && dissectionResults.length > 0) {
      const roleNames = dissectionResults.map((r) => r.agentRole).join(', ');
      await appendAgentLog(
        sessionId,
        'system',
        `Analysis complete. The following agents need to update their rules: ${roleNames}. Starting playbook updates now...`
      );
    }
  } catch (err) {
    console.warn(
      `[Agent: Learner] Failed to dynamically route feedback, aborting update`,
      err
    );
    if (sessionId) {
      await appendAgentLog(
        sessionId,
        'system',
        `Could not complete the analysis. The AI will try again on the next feedback signal.`
      );
    }
    return;
  }

  for (const updateTask of dissectionResults) {
    const role = updateTask.agentRole;
    console.log(
      `\n[Agent: Learner - Update Intelligence Node] Updating playbook for ${role}...`
    );
    console.log(`Reasoning: ${updateTask.reasoning}`);
    console.log(`Data to Change: ${updateTask.dataToChange}`);

    if (sessionId) {
      await appendAgentLog(
        sessionId,
        role as any,
        `Reviewing your feedback and rewriting my rules to avoid this mistake in the future...`
      );
    }

    let currentPlaybook =
      DEFAULT_PLAYBOOKS[role as keyof typeof DEFAULT_PLAYBOOKS] ||
      `# ${role} Playbook`;
    let currentBlobUrl = null;

    const registry = await getIntelligenceRegistry(userId, pipelineId, role);
    if (registry && registry.blobUrl) {
      currentBlobUrl = registry.blobUrl;
      try {
        currentPlaybook = await getPlaybook(registry.blobUrl);
      } catch {
        // ...
      }
    }

    const prompt = `You are the Update Intelligence Node. Your task is to update the **${role}**'s intelligence markdown playbook based on a recent human feedback signal.

## Pipeline Goal / Ideal Customer Profile:
${pipelineGoal}

## Current Playbook:
${currentPlaybook}

## Reasoning for Update:
${updateTask.reasoning}

## Instructions for Change:
${updateTask.dataToChange}

Analyze the reasoning and instructions, and rewrite the Current Playbook Markdown to integrate these new intelligence updates. Keep the rules aligned with the Pipeline Goal / Ideal Customer Profile above. Ensure new rules are clearly added to "Rules" or "Blacklist" sections. If the outcome is positive ("Closed"), reinforce the successful patterns.

Respond ONLY with the updated raw Markdown for the playbook. Do not wrap it in \`\`\`markdown backticks, just return the text itself.`;

    console.log(
      `[Agent: Learner] 📤 Sending feedback and rules to Gemini for a ${role} playbook upgrade...`
    );
    const result = await model.generateContent(prompt);
    let newPlaybookMarkdown = result.response.text().trim();
    console.log(
      `[Agent: Learner] 📥 Gemini delivered the shiny new ${role} playbook:\n${newPlaybookMarkdown}`
    );

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
      role as any,
      newBlobUrl,
      true,
      updateTask.reasoning
    );

    if (currentBlobUrl && currentBlobUrl !== newBlobUrl) {
      try {
        await deletePlaybook(currentBlobUrl);
      } catch (err) {
        console.warn(
          `Failed to delete old playbook blob: ${currentBlobUrl}`,
          err
        );
      }
    }

    console.log(`[Agent: Learner] ✅ Playbook updated for role: ${role}`);
    if (sessionId) {
      await appendAgentLog(
        sessionId,
        role as any,
        `Playbook updated successfully. I've added new rules to avoid similar mistakes going forward.`
      );
    }
  }

  console.log(`[Agent: Learner] ✅ Continuous synthesis completed.`);
  if (sessionId) {
    await appendAgentLog(
      sessionId,
      'system',
      `All done. The pipeline has learned from your feedback and will perform better on future runs.`
    );
  }
}
