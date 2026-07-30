/**
 * Fixed-window token bucket in Firestore — outbound send-rate limiting.
 *
 * Smooths outbound email bursts: a campaign whose contacts all become due at once would otherwise
 * blast simultaneously, which is exactly the pattern that damages sender reputation. Keyed per agent
 * (the sender scope).
 *
 * **Fail-OPEN throughout.** Any error returns "allowed", because a limiter fault must never stop the
 * flow from sending. Contrast `taskDispatch.claimTask`, which fails closed — there, the risk is a
 * duplicate side effect, so the safe answer is the opposite.
 */

import { db } from '../firebase/db';

const COLLECTION = 'rate_limits';

export interface WindowState {
  allow: boolean;
  windowStart: number;
  count: number;
}

/**
 * The pure fixed-window decision — no I/O, and the piece worth unit-testing.
 *
 * Resets the window once `window` seconds have elapsed, then allows only while under budget.
 * Returns the state to persist, so the transaction wrapper stays trivial.
 */
export function evaluate(
  now: number,
  windowStart: number,
  count: number,
  maxN: number,
  windowSeconds: number
): WindowState {
  let ws = windowStart;
  let c = count;
  if (now - ws >= windowSeconds) {
    // Window elapsed → reset.
    ws = now;
    c = 0;
  }
  if (c >= maxN) {
    // Budget exhausted for this window.
    return { allow: false, windowStart: ws, count: c };
  }
  return { allow: true, windowStart: ws, count: c + 1 };
}

/**
 * Seconds until the fixed window for `key` rolls over — i.e. until a token is guaranteed free.
 *
 * This exists to fix a real starvation bug: a bucket-deferred email that simply "retries soon" lands
 * back in the STILL-FULL window and defers again, and most of a campaign's email never sends. Using
 * the real reset time reschedules it to the next genuinely open slot instead.
 *
 * Returns 0 when there is no active window or it has already elapsed. Fail-open → 0 (retry soon).
 */
export async function secondsUntilReset(
  key: string,
  windowSeconds: number
): Promise<number> {
  if (!key) return 0;
  try {
    const snap = await db.collection(COLLECTION).doc(String(key)).get();
    if (!snap.exists) return 0;
    const ws = Number((snap.data() ?? {}).window_start ?? 0);
    if (ws <= 0) return 0;
    return Math.max(0, ws + Math.trunc(windowSeconds) - Date.now() / 1000);
  } catch (e) {
    console.warn(`[OB RATE] secondsUntilReset failed for ${key}: ${e}`);
    return 0;
  }
}

/**
 * Consume one token for `key` within a fixed window.
 *
 * Runs inside a Firestore transaction so it is safe under the cron's parallel workers. Returns
 * `true` when allowed (token consumed), `false` when the window budget is exhausted. Fail-open
 * (`true`) on any error or a non-positive limit — never block sending on a limiter fault.
 */
export async function tryConsume(
  key: string,
  maxPerWindow: number,
  windowSeconds: number
): Promise<boolean> {
  if (!key || Math.trunc(maxPerWindow || 0) <= 0) return true;
  try {
    const ref = db.collection(COLLECTION).doc(String(key));
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() ?? {}) : {};
      const state = evaluate(
        Date.now() / 1000,
        Number(data.window_start ?? 0),
        Number(data.count ?? 0),
        Math.trunc(maxPerWindow),
        Math.trunc(windowSeconds)
      );
      if (state.allow) {
        tx.set(ref, { window_start: state.windowStart, count: state.count });
      }
      return state.allow;
    });
  } catch (e) {
    console.error(`[OB RATE] tryConsume failed for ${key}: ${e}`);
    return true; // fail-open — never block sending on a limiter fault
  }
}
