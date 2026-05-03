import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAllFeedbackSignals } from '../db/feedbackSignals';
import { getAllNiches, updateNiche } from '../db/niches';
import type { FeedbackSignal, Niche } from '../types';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-pro-preview',
});

interface NicheStats {
  nicheId: string;
  nicheName: string;
  closeRate: number;
  avgGapScore: number;
  avgProductPrice: number;
  totalSignals: number;
  currentPriority: number;
  currentBlacklistedSignals: string[];
  rejectedNotes: string[];
}

interface GeminiNicheUpdate {
  nicheId: string;
  crawlPriority: number;
  newBlacklistedSignals: string[];
}

interface GeminiResponse {
  updates: GeminiNicheUpdate[];
  reasoning: string;
}

function aggregateByNiche(
  signals: FeedbackSignal[],
  niches: Niche[]
): NicheStats[] {
  const nicheMap = new Map(niches.map((n) => [n.id, n]));
  const grouped = new Map<string, FeedbackSignal[]>();

  for (const s of signals) {
    if (!grouped.has(s.nicheId)) grouped.set(s.nicheId, []);
    grouped.get(s.nicheId)!.push(s);
  }

  const stats: NicheStats[] = [];

  for (const [nicheId, nicheSignals] of grouped) {
    const niche = nicheMap.get(nicheId);
    if (!niche) continue;

    const closed = nicheSignals.filter((s) => s.outcome === 'Closed').length;
    const closeRate =
      nicheSignals.length > 0 ? closed / nicheSignals.length : 0;
    const avgGapScore =
      nicheSignals.reduce((sum, s) => sum + s.gapScoreAtPitch, 0) /
      nicheSignals.length;
    const avgProductPrice =
      nicheSignals.reduce((sum, s) => sum + s.productPrice, 0) /
      nicheSignals.length;

    const rejectedNotes = nicheSignals
      .filter((s) => s.outcome === 'Rejected' && s.notes)
      .map((s) => s.notes as string);

    stats.push({
      nicheId,
      nicheName: niche.nicheName,
      closeRate,
      avgGapScore: Math.round(avgGapScore * 10) / 10,
      avgProductPrice: Math.round(avgProductPrice),
      totalSignals: nicheSignals.length,
      currentPriority: niche.crawlPriority,
      currentBlacklistedSignals: niche.blacklistedSignals,
      rejectedNotes,
    });
  }

  return stats;
}

function buildPrompt(stats: NicheStats[]): string {
  const nicheList = stats
    .map(
      (s) => `- NicheID: ${s.nicheId} (${s.nicheName})
  CurrentPriority: ${s.currentPriority}
  CloseRate: ${(s.closeRate * 100).toFixed(1)}% (${s.totalSignals} signals)
  AvgGapScore: ${s.avgGapScore}
  AvgProductPrice: $${s.avgProductPrice}
  CurrentBlacklistedSignals: ${s.currentBlacklistedSignals.join(', ') || 'none'}
  RejectionNotes: ${s.rejectedNotes.length ? s.rejectedNotes.join(' | ') : 'none'}`
    )
    .join('\n\n');

  return `You are a growth analyst optimizing an AI outreach pipeline.

## Niche Performance Data
${nicheList}

## Instructions
Based on close rates, gap scores, product prices, and rejection notes:
1. Assign an updated crawlPriority (1–10) for each niche. Higher priority = more crawling tomorrow.
2. Identify any new blacklisted signals to add based on patterns in rejected/ghosted leads.
3. Explain your reasoning in plain English.

Respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON:
{
  "updates": [
    {
      "nicheId": "<id>",
      "crawlPriority": <1-10>,
      "newBlacklistedSignals": ["<signal>", ...]
    }
  ],
  "reasoning": "<plain English explanation>"
}`;
}

export async function runFeedbackLoop(userId: string): Promise<void> {
  const [signals, niches] = await Promise.all([
    getAllFeedbackSignals(userId),
    getAllNiches(userId),
  ]);

  if (signals.length === 0) {
    console.log('feedbackLoopAgent: no signals recorded yet, skipping');
    return;
  }

  const stats = aggregateByNiche(signals, niches);

  if (stats.length === 0) {
    console.log(
      'feedbackLoopAgent: no matching niches found for signals, skipping'
    );
    return;
  }

  const prompt = buildPrompt(stats);
  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();

  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `feedbackLoopAgent: Gemini returned invalid JSON: ${raw.slice(0, 200)}`
    );
  }

  if (!Array.isArray(parsed.updates) || typeof parsed.reasoning !== 'string') {
    throw new Error(
      `feedbackLoopAgent: Gemini response missing required fields: ${raw.slice(0, 200)}`
    );
  }

  const nicheMap = new Map(niches.map((n) => [n.id, n]));

  for (const update of parsed.updates) {
    const niche = nicheMap.get(update.nicheId);
    if (!niche) continue;

    const mergedBlacklist = [
      ...new Set([
        ...niche.blacklistedSignals,
        ...(update.newBlacklistedSignals ?? []),
      ]),
    ];

    await updateNiche(userId, update.nicheId, {
      crawlPriority: update.crawlPriority,
      blacklistedSignals: mergedBlacklist,
    });

    // Create an explicit feedback signal log for the audit ledger
    const { createFeedbackSignal } = await import('../db/feedbackSignals');
    const { FieldValue } = await import('firebase-admin/firestore');
    await createFeedbackSignal({
      userId,
      pipelineId: niche.pipelineId || 'default-pipeline',
      leadId: 'system-adjustment',
      nicheId: update.nicheId,
      outcome: 'Closed',
      pitchAngleUsed: 'noVideo', // Mock, normally stored in lead
      productPrice: 500, // Mock
      gapScoreAtPitch: 6, // Mock
      notes: 'Added via feedbackLoopAgent',
      aiAdjustmentLog: parsed.reasoning,
      recordedAt: FieldValue.serverTimestamp() as any,
    });
  }

  console.log(
    `feedbackLoopAgent: updated ${parsed.updates.length} niches for user ${userId} — ${parsed.reasoning}`
  );
}
