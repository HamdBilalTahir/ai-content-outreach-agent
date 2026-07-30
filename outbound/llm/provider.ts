/**
 * The global provider switch, and the Bedrock → direct-Anthropic model mapping.
 *
 * `LLM_PROVIDER=anthropic` reroutes Bedrock-bound Claude calls to the direct Anthropic Messages API.
 * Everything else stays on Bedrock Converse, and Groq routing is untouched by this switch.
 *
 * ## Models map by TIER, not by exact snapshot — and that is the load-bearing decision
 *
 * Several snapshots that still work on Bedrock are RETIRED on the direct Anthropic API and 404 there.
 * The source records four verified cases: `claude-sonnet-4-20250514`, `claude-3-5-haiku-20241022`, and
 * both 3.5 Sonnet snapshots. Mapping by capability tier keeps the switch pointed at a live model and
 * makes it forward-compatible: moving to a newer model later is a change to two constants.
 *
 * A tier-mapped id is therefore NOT the id that was asked for, deliberately. Mapping by exact snapshot
 * would look more faithful and would 404 in production.
 */

import { envStr } from '../config';

/**
 * The current API-available models, by tier. Only these two tiers are used, so these two constants are
 * the whole model policy for the direct-Anthropic path.
 */
export const ANTHROPIC_HAIKU = 'claude-haiku-4-5-20251001';
export const ANTHROPIC_SONNET = 'claude-sonnet-4-5-20250929';

/** Used when a mapped model errors — always current. */
export const ANTHROPIC_FALLBACK_MODEL = ANTHROPIC_HAIKU;

const REGION_PREFIXES = ['us.', 'eu.', 'apac.', 'us-gov.'] as const;

/** The active provider: `"anthropic"` or `"bedrock"`, defaulting to Bedrock. */
export function getLlmProvider(): 'anthropic' | 'bedrock' {
  const raw = envStr('LLM_PROVIDER') || 'bedrock';
  return raw.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'bedrock';
}

/** True when the global flag routes Claude calls to the direct Anthropic API. */
export function anthropicEnabled(): boolean {
  return getLlmProvider() === 'anthropic';
}

/**
 * Map a Bedrock model id to a current, API-available direct-Anthropic model.
 *
 * Returns `null` when the id is not a Claude model — an `amazon.*` or `meta.*` model, say — which
 * signals the caller to stay on Bedrock for that request rather than guessing a mapping.
 *
 * Opus is not used by this application; it maps to Sonnet so the call still succeeds rather than
 * 404-ing on a retired Opus snapshot.
 *
 *     us.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5-20251001
 *     us.anthropic.claude-sonnet-4-20250514-v1:0  → claude-sonnet-4-5-20250929 (Sonnet 4 retired on API)
 *     anthropic.claude-3-5-sonnet-20240620-v1:0   → claude-sonnet-4-5-20250929 (3.5 Sonnet retired)
 */
export function toAnthropicModelId(
  bedrockModelId: string | null | undefined
): string | null {
  if (!bedrockModelId) return null;

  const lowered = String(bedrockModelId).trim().toLowerCase();
  if (!lowered.includes('claude')) return null; // non-Anthropic Bedrock model — stay on Bedrock

  if (lowered.includes('opus')) return ANTHROPIC_SONNET;
  if (lowered.includes('sonnet')) return ANTHROPIC_SONNET;
  if (lowered.includes('haiku')) return ANTHROPIC_HAIKU;

  // A Claude model of unrecognised tier: strip the Bedrock decorations and try it directly. The
  // caller falls back to Haiku if the id turns out not to be served.
  let candidate = lowered;
  for (const prefix of REGION_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  if (candidate.startsWith('anthropic.')) {
    candidate = candidate.slice('anthropic.'.length);
  }
  return candidate.replace(/-v\d+:\d+$/, ''); // strip "-v1:0" / "-v2:0"
}
