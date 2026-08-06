/**
 * Shared-line winner selection for outbound enrollment.
 *
 * When several HubSpot contacts share one dealership phone number, enrollment keeps a SINGLE chat per
 * line (dedup by phone). This module decides WHICH contact that chat represents: the most SENIOR
 * contact, with the most-recently-created one breaking a same-rank tie.
 *
 * ## Why an LLM, and why it is nearly free
 *
 * Job titles are messy free text, so seniority is scored by a model. Two things keep that cheap:
 *
 *  - It is called ONLY for lines that actually have 2+ contacts. A single-contact line never reaches
 *    this module, so the common case costs nothing.
 *  - Each distinct title is ranked ONCE and cached in Firestore. Repeats — "Sales Manager" across
 *    fifty dealerships — are free after the first.
 *
 * Everything here is best-effort and never throws. A failed lookup falls back to rank 0 (unknown), so
 * enrollment can always make a deterministic choice.
 */

import { db } from '../firebase/db';
import { llmText, parseJsonResponse } from '../tools/reviewHelpers';

/** Firestore cache: one document holding `{ normalizedTitle: rank }`. */
const CACHE_COLLECTION = 'tool_configs';
const CACHE_DOC = 'role_ranks';

/** Chunk size, so no single response can truncate mid-array. */
const RANK_BATCH = 40;

const RANK_SYSTEM_PROMPT =
  'You rank auto-dealership job titles by SENIORITY / decision-making authority, for choosing ' +
  'the single best person to contact at a dealership. Return an integer score 0-100 for EACH ' +
  'title on this scale:\n' +
  '  90-100 = Owner, Dealer Principal, President, CEO, Partner, Founder\n' +
  '  75-89  = General Manager (GM), General Sales Manager (GSM), Executive Manager, VP\n' +
  '  60-74  = Director (Sales/Fixed Ops/Marketing), Managing Partner’s deputy\n' +
  "  40-59  = Sales Manager, Finance/F&I Manager, Service Manager, Parts Manager, any 'Manager'\n" +
  '  20-39  = Salesperson, Sales Consultant, Advisor, Associate, BDC, Internet Sales, IC roles\n' +
  '  1-19   = Junior/support/administrative roles\n' +
  '  0      = Empty, unknown, or unrecognizable title\n' +
  "Judge on the title's authority in a car dealership. Return one entry per input title, using " +
  'the title text exactly as provided.\n\n' +
  'Respond with JSON only, shaped ' +
  '{"rankings": [{"title": "<verbatim title>", "rank": <0-100 integer>}]}.';

/** Canonical cache key: lowercased, whitespace-collapsed, trimmed. */
export function normalizeTitle(title: unknown): string {
  return String(title ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * LLM-rank a list of DISTINCT job titles → `{normalizedTitle: rank}`.
 *
 * Best-effort: unresolved titles are omitted and the caller defaults them to 0. Chunks above
 * `RANK_BATCH` so one long response cannot truncate mid-array and lose every title after the cut.
 *
 * The source constrains the model with Bedrock's `output_config` json_schema; this asks for the same
 * shape in the prompt and parses tolerantly, which is what the rest of this port does — and note the
 * source itself already parses defensively (`raw[find('{') : rfind('}')+1]`), so it does not fully trust
 * the constraint either.
 */
export async function rankTitlesLlm(
  titles: readonly unknown[]
): Promise<Record<string, number>> {
  const uniq: unknown[] = [];
  const seen = new Set<string>();
  for (const t of titles ?? []) {
    const n = normalizeTitle(t);
    if (n && !seen.has(n)) {
      seen.add(n);
      uniq.push(t);
    }
  }
  if (uniq.length === 0) return {};

  if (uniq.length > RANK_BATCH) {
    const out: Record<string, number> = {};
    for (let i = 0; i < uniq.length; i += RANK_BATCH) {
      Object.assign(out, await rankTitlesLlm(uniq.slice(i, i + RANK_BATCH)));
    }
    return out;
  }

  const userPrompt =
    'Rank these job titles:\n' +
    uniq.map((t) => `- ${String(t)}`).join('\n') +
    '\n\nReturn the JSON now.';

  try {
    const raw = await llmText(RANK_SYSTEM_PROMPT, userPrompt);
    if (!raw) {
      console.warn(`[ROLE_RANK] empty LLM response for ${uniq.length} titles`);
      return {};
    }
    const parsed = parseJsonResponse(raw);
    const out: Record<string, number> = {};
    for (const item of (parsed.rankings ?? []) as Array<
      Record<string, unknown>
    >) {
      const n = normalizeTitle(item?.title);
      const r = Number(item?.rank);
      if (!n || !Number.isFinite(r)) continue;
      // Clamped: a model returning 250 must not outrank a real owner.
      out[n] = Math.max(0, Math.min(100, Math.trunc(r)));
    }
    return out;
  } catch (e) {
    console.warn(
      `[ROLE_RANK] LLM ranking failed for ${uniq.length} titles: ${e}`
    );
    return {};
  }
}

async function readCache(): Promise<Record<string, number>> {
  try {
    const doc = await db.collection(CACHE_COLLECTION).doc(CACHE_DOC).get();
    if (!doc.exists) return {};
    return ((doc.data() ?? {}).ranks ?? {}) as Record<string, number>;
  } catch (e) {
    console.warn(`[ROLE_RANK] cache read failed: ${e}`);
    return {};
  }
}

async function writeCache(newRanks: Record<string, number>): Promise<void> {
  if (Object.keys(newRanks).length === 0) return;
  try {
    const ranks: Record<string, number> = {};
    for (const [k, v] of Object.entries(newRanks)) ranks[normalizeTitle(k)] = v;
    await db
      .collection(CACHE_COLLECTION)
      .doc(CACHE_DOC)
      .set({ ranks }, { merge: true });
  } catch (e) {
    console.warn(`[ROLE_RANK] cache write failed: ${e}`);
  }
}

/**
 * `{normalizedTitle: rank}` for the given titles, LLM-ranking ONLY what is not already cached.
 *
 * One batched call for the misses, then the fresh ranks are persisted. Anything still unresolved
 * defaults to 0. Call this only when a line has 2+ contacts — see the module note.
 */
export async function getTitleRanks(
  titles: readonly unknown[]
): Promise<Record<string, number>> {
  const wanted = new Set(
    (titles ?? []).map((t) => normalizeTitle(t)).filter(Boolean)
  );
  if (wanted.size === 0) return {};

  const cache = await readCache();

  // Deduplicate by normalized key while keeping the ORIGINAL text, which is what the model is shown.
  const byNormalized = new Map<string, unknown>();
  for (const t of titles ?? []) {
    const n = normalizeTitle(t);
    if (n) byNormalized.set(n, t);
  }
  const missing = [...byNormalized.entries()]
    .filter(([n]) => !(n in cache))
    .map(([, original]) => original);

  if (missing.length > 0) {
    const fresh = await rankTitlesLlm(missing);
    if (Object.keys(fresh).length > 0) {
      await writeCache(fresh);
      Object.assign(cache, fresh);
    }
  }

  const out: Record<string, number> = {};
  for (const n of wanted) out[n] = Math.trunc(Number(cache[n]) || 0);
  return out;
}

/**
 * Does the INCOMING contact beat the current chat owner? Three keys, highest priority first:
 *
 *  1. **CALLABLE beats non-callable.** A contact whose phone is not a litigator is reachable by call,
 *     the preferred channel. Contacts sharing a line share the same phone and therefore the same
 *     litigator status, so within a line this is a no-op — the source keeps it as a safety net that
 *     would fire if callability ever differed, and defaults both sides to callable when unknown.
 *  2. **Higher role rank**, from the LLM scoring above.
 *  3. **Later `created`** breaks a tie. HubSpot's `createdate` is an ISO string, so lexicographic
 *     comparison is chronological — no parsing needed, and an unparseable date degrades to a string
 *     compare rather than throwing.
 */
export function contactWins(
  incomingRank: number,
  incomingCreated: string,
  curRank: number,
  curCreated: string,
  incomingCallable = true,
  curCallable = true
): boolean {
  const ic = Boolean(incomingCallable);
  const cc = Boolean(curCallable);
  if (ic !== cc) return ic;

  const ir = Math.trunc(Number(incomingRank) || 0);
  const cr = Math.trunc(Number(curRank) || 0);
  if (ir !== cr) return ir > cr;

  return String(incomingCreated ?? '') > String(curCreated ?? '');
}
