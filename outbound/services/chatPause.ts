/**
 * Pause / resume outbound chats — a REVERSIBLE freeze, distinct from the terminal `archive`.
 *
 * ## Freezing costs zero task writes
 *
 * A paused chat has top-level `status: "paused"`. The cron's due-task query admits a task only when
 * its parent chat's `status` is absent or `"active"`, so setting `status: "paused"` freezes ALL of a
 * chat's scheduled tasks at the QUERY layer. They stay `executed: false` and re-appear on resume — no
 * per-task writes are needed to freeze, which is what makes pausing a whole campaign cheap.
 *
 * ## Resume has to repair the overdue ones
 *
 * The cron's window is roughly `now - 2·window … now + window`, so a task that went overdue during a
 * long pause would fall out of the window entirely and never fire. Resume therefore reschedules every
 * pending task whose `execute_at` is now in the past to the next business-hours slot in the prospect's
 * timezone. Future-dated tasks are left alone.
 *
 * The per-task 30-second jitter is deliberate: without it, a chat's whole backlog lands on the same
 * `execute_at` and fires in a single tick.
 */

import { db, toDate } from '../firebase/db';
import {
  addLabelToChat,
  removeLabelFromChat,
  updateTask,
} from '../firebase/chat';
import { nextBusinessHoursStart } from './scheduling';
import type { ChatMemory, TaskDoc } from '../types';

export const PAUSED_LABEL = 'paused';

function chatRef(chatId: string) {
  return db.collection('chats').doc(chatId);
}

/**
 * Set the chat to paused, freezing its tasks via the cron's status gate.
 *
 * A no-op when the chat is already paused, or archived — archive is terminal, and pausing it would
 * imply it could be resumed. Best-effort; `true` only when it actually paused.
 */
export async function pauseChat(
  chatId: string,
  by = 'manual'
): Promise<boolean> {
  if (!chatId) return false;
  try {
    const snap = await chatRef(chatId).get();
    if (!snap.exists) return false;
    const d = snap.data() ?? {};
    if (
      d.status === 'paused' ||
      d.status === 'archived' ||
      d.archived === true
    ) {
      return false;
    }

    const nowIso = new Date().toISOString();
    await chatRef(chatId).set(
      {
        status: 'paused',
        status_changed_at: nowIso, // universal last-status-change stamp, for any status
        paused_at: nowIso,
        paused_by: String(by || 'manual'),
      },
      { merge: true }
    );
    try {
      await addLabelToChat(chatId, PAUSED_LABEL);
    } catch {
      // The label is for the UI; the `status` field is the actual gate.
    }
    console.log(`[OB PAUSE] paused chat=${chatId} by=${by}`);
    return true;
  } catch (e) {
    console.warn(`[OB PAUSE] pauseChat failed chat=${chatId}: ${e}`);
    return false;
  }
}

/**
 * Flip a paused chat back to active and reschedule its overdue pending tasks.
 *
 * Acts only on a chat currently at `status: "paused"`, so resuming an active or archived chat is a
 * no-op rather than an accidental un-archive. Best-effort.
 */
export async function resumeChat(
  chatId: string
): Promise<{ resumed: boolean; rescheduled: number }> {
  if (!chatId) return { resumed: false, rescheduled: 0 };
  try {
    const snap = await chatRef(chatId).get();
    const d = snap.exists ? (snap.data() ?? {}) : {};
    if (d.status !== 'paused') return { resumed: false, rescheduled: 0 };

    await chatRef(chatId).set(
      {
        status: 'active',
        status_changed_at: new Date().toISOString(),
        paused_at: null,
        paused_by: null,
      },
      { merge: true }
    );
    try {
      await removeLabelFromChat(chatId, PAUSED_LABEL);
    } catch {
      // Cosmetic only.
    }

    const n = await rescheduleFrozenTasks(
      chatId,
      (d.memory ?? {}) as ChatMemory
    );
    console.log(
      `[OB PAUSE] resumed chat=${chatId}, rescheduled ${n} overdue task(s)`
    );
    return { resumed: true, rescheduled: n };
  } catch (e) {
    console.warn(`[OB PAUSE] resumeChat failed chat=${chatId}: ${e}`);
    return { resumed: false, rescheduled: 0 };
  }
}

/**
 * Move every pending task whose `execute_at` is now in the past to the next business-hours slot in
 * the prospect's timezone, with a small per-task jitter so the backlog does not all fire in one tick.
 *
 * Skipped and permanently-failed tasks are terminal and left alone. Future-dated tasks are untouched.
 * A task with NO `execute_at` at all is rescheduled — it would otherwise never be selected. Returns
 * the count moved.
 */
export async function rescheduleFrozenTasks(
  chatId: string,
  memory?: ChatMemory | null
): Promise<number> {
  const tz = (memory ?? {}).timezone || 'America/New_York';
  const now = new Date();
  let moved = 0;
  try {
    const snap = await chatRef(chatId)
      .collection('tasks')
      .where('executed', '==', false)
      .get();

    let i = 0;
    for (const t of snap.docs) {
      const td = (t.data() ?? {}) as TaskDoc;
      if (td.skipped || td.permanent_failure) continue;

      const ea = toDate(td.execute_at);
      if (ea !== null && ea >= now) continue; // still in the future → leave it

      const base = await nextBusinessHoursStart(tz, null, chatId);
      const newAt = new Date(base.getTime() + i * 30_000);
      if (await updateTask(chatId, t.id, { execute_at: newAt })) moved += 1;
      i += 1;
    }
  } catch (e) {
    console.warn(
      `[OB PAUSE] rescheduleFrozenTasks failed chat=${chatId}: ${e}`
    );
  }
  return moved;
}

/** Pause a list of chats. */
export async function pauseChats(
  chatIds: readonly string[] | null | undefined,
  by = 'bulk'
): Promise<{ paused: number; chat_ids: string[] }> {
  const done: string[] = [];
  for (const cid of chatIds ?? []) {
    if (await pauseChat(cid, by)) done.push(cid);
  }
  return { paused: done.length, chat_ids: done };
}

/** Resume a list of chats, summing the tasks rescheduled across all of them. */
export async function resumeChats(
  chatIds: readonly string[] | null | undefined
): Promise<{ resumed: number; rescheduled: number; chat_ids: string[] }> {
  const resumed: string[] = [];
  let rescheduled = 0;
  for (const cid of chatIds ?? []) {
    const r = await resumeChat(cid);
    if (r.resumed) {
      resumed.push(cid);
      rescheduled += r.rescheduled;
    }
  }
  return { resumed: resumed.length, rescheduled, chat_ids: resumed };
}
