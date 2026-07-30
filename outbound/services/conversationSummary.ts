/**
 * Conversation-summary caching.
 *
 * After each review, generates a 3–5 sentence summary and caches it on the chat as
 * `_conversation_summary`. The point is that the call tool and the conversation-initiation webhook can
 * then inject cross-channel context with NO LLM call at call time — a summary computed once after the
 * conversation is free to read on every later turn, whereas summarizing at dial time would add latency
 * to the one moment that cannot afford it.
 *
 * Deferred out of Phase 5, which could not have it: it needs the model layer.
 */

import { db } from '../firebase/db';
import { generateText, textOf, type GenerateMeta } from '../llm/ask';

/**
 * Generate a summary and cache it. Returns the summary, or `''` on failure.
 *
 * Best-effort throughout: a summary is context, not state, so a failure here degrades the next turn's
 * context rather than breaking the review that called it.
 */
export async function generateAndCacheSummary(
  chatId: string,
  transcript: string,
  confirmedFields: Record<string, unknown> = {},
  channelPrefs: Record<string, unknown> = {},
  interactionType = 'sms',
  metaData?: GenerateMeta | null
): Promise<string> {
  if (!transcript) return '';

  const confirmedStr = Object.keys(confirmedFields ?? {}).length
    ? Object.entries(confirmedFields)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')
    : 'none';
  const prefsStr = Object.keys(channelPrefs ?? {}).length
    ? Object.entries(channelPrefs)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')
    : 'none';

  const systemPrompt =
    'You are a conversation analyst. Generate a concise 3-5 sentence summary of this ' +
    `${interactionType.replace(/_/g, ' ')} conversation between an agent and a customer.\n\n` +
    'Include: what was discussed, customer sentiment/mood, key decisions or objections, ' +
    'and any unresolved issues. Be factual and concise. Return only the summary text.';

  // The transcript is capped because a summary prompt does not benefit from the full history, and the
  // cost of a long one is paid on every review.
  const userPrompt =
    `Transcript:\n${transcript.slice(0, 3000)}\n\n` +
    `Fields confirmed in this interaction: ${confirmedStr}\n` +
    `Channel preferences detected: ${prefsStr}\n\n` +
    'Write a 3-5 sentence summary.';

  try {
    const messages = [
      { role: 'user' as const, content: [{ text: userPrompt }] },
    ];
    const result = await generateText(
      systemPrompt,
      messages,
      null,
      metaData ?? {}
    );
    const summary = textOf(result);

    if (!summary) {
      console.warn(
        `[ConversationSummary] Empty summary from LLM for chat=${chatId}`
      );
      return '';
    }

    await db.collection('chats').doc(chatId).update({
      'memory._conversation_summary': summary,
      'memory._conversation_summary_at': new Date().toISOString(),
    });

    console.log(
      `[ConversationSummary] Cached summary for chat=${chatId} ` +
        `(${interactionType}, ${summary.length} chars)`
    );
    return summary;
  } catch (e) {
    console.warn(
      `[ConversationSummary] Failed to generate summary for chat=${chatId}: ${e}`
    );
    return '';
  }
}
