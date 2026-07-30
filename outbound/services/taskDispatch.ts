/**
 * The at-most-once dispatch guard — the single most correctness-critical piece of the cron.
 *
 * ## The problem it closes
 *
 * The cron re-selects every `executed == false` task on each tick, and a turn runs synchronously for
 * 15–45 seconds. Without an atomic guard the SAME task re-dispatches on every overlapping and
 * subsequent tick for the whole duration of its run — producing duplicate calls, duplicate emails and
 * duplicate reviews. That failure mode had a name upstream: the "@AI-trigger storm".
 *
 * ## The guard
 *
 * `claimTask` sets `executed = true` inside a single Firestore transaction **at dispatch** — before
 * the turn runs, not after it. Once dispatched the task is `executed = true`, so no later tick
 * re-selects it.
 *
 * There is deliberately **no lease** and no `claimed_at`: the `executed` flag alone is the
 * at-most-once marker. That means there is no multi-minute hold to wait out, so a due task fires on
 * the very next tick. The trade-off is that crash recovery is not the cron's job — a task whose turn
 * hard-crashed stays `executed = true` and is reconciled by the review tools or the stalled-chat
 * safety net, not by a lease expiring.
 *
 * The cron does not own retries either: a *caught* error calls `updateTaskFailure`, which flips
 * `executed = false` with a backoff so the task is re-selected later.
 *
 * ## Fail direction
 *
 * `claimTask` **fails CLOSED** — any error returns `false` and this pass skips the task. Skipping a
 * tick is cheap; a duplicate outbound call is not. (Compare `rateLimit.tryConsume`, which fails open
 * for the opposite reason.)
 */

import { FieldValue, db } from '../firebase/db';
import { dispatchClaimEnabled } from '../config';
import type { TaskDoc } from '../types';

export { dispatchClaimEnabled };

/**
 * The pure claim decision — no I/O, and the piece worth unit-testing.
 *
 * A task is claimable iff it is not already executed and not terminal (skipped or permanently
 * failed). There is no lease to age out: a task whose attempt crashed stays `executed = true` and
 * the cron will NOT re-fire it, by design.
 */
export function shouldClaimTask(taskData: TaskDoc | null | undefined): boolean {
  if (!taskData || typeof taskData !== 'object') return false;
  if (taskData.executed) return false;
  if (taskData.skipped || taskData.permanent_failure) return false;
  return true;
}

/**
 * Atomically claim a task for dispatch so it runs at most once.
 *
 * Returns `true` only for the single caller that wins the transaction. Concurrent or subsequent cron
 * passes read `executed == true` and get `false`, so they skip dispatch.
 *
 * Fail-closed: on ANY error returns `false` — never risk a duplicate dispatch.
 */
export async function claimTask(
  chatId: string,
  taskId: string
): Promise<boolean> {
  if (!chatId || !taskId) return false;
  try {
    const ref = db
      .collection('chats')
      .doc(chatId)
      .collection('tasks')
      .doc(taskId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      if (!shouldClaimTask((snap.data() ?? {}) as TaskDoc)) return false;
      tx.update(ref, {
        executed: true,
        dispatched_at: FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (e) {
    console.warn(`[OB CLAIM] claimTask error for ${chatId}/${taskId}: ${e}`);
    return false;
  }
}
