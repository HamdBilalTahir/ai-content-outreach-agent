/**
 * Task scheduling and the proactive-task invariants.
 *
 * Turns an LLM-supplied date/time/timezone into a UTC `execute_at`, keeps voice and callback tasks
 * inside the prospect's local business hours, and enforces the rule the whole cadence depends on:
 *
 *   **A chat has AT MOST ONE pending proactive task.**
 *
 * Without that, every re-enroll, every recovery sweep and every review that schedules "the next
 * touch" stacks another one, and the prospect gets called or emailed several times in a row. Note
 * that reminders, `book_meeting`, `check_if_call_succeeded` and `call_completion_continuation` are
 * deliberately NOT proactive: they are operational, and a booked chat legitimately has several
 * reminders pending at once.
 */

import { DateTime } from 'luxon';

import { db } from '../firebase/db';
import { getMemory } from '../firebase/chat';
import * as bh from './businessHours';
import {
  PROACTIVE_TASK_TYPES,
  type OutreachLane,
  type TaskDoc,
} from '../types';

export { PROACTIVE_TASK_TYPES };

/**
 * Combine `'YYYY-MM-DD'` + `'HH:MM'` in the given IANA timezone into an absolute instant.
 * Throws on a bad date/time or an unknown zone — callers handle it, because a silently wrong
 * appointment time is worse than a visible failure.
 */
export function computeExecuteAt(
  date: string,
  time: string,
  timezone: string
): Date {
  const dt = DateTime.fromFormat(`${date} ${time}`, 'yyyy-MM-dd HH:mm', {
    zone: timezone || 'UTC',
  });
  if (!dt.isValid) {
    throw new Error(
      `computeExecuteAt: invalid date/time/zone (${date} ${time} ${timezone})`
    );
  }
  return dt.toJSDate();
}

/**
 * THE single business-hours bypass: `Test` records ignore the window entirely, so an end-to-end test
 * call fires when scheduled regardless of local time, weekend or holiday. Keyed on
 * `memory.record_type`, seeded at intake. Best-effort — never throws.
 */
async function bypassBusinessHours(chatId?: string | null): Promise<boolean> {
  if (!chatId) return false;
  try {
    const memory = await getMemory(chatId);
    return (
      String(memory?.record_type ?? '')
        .trim()
        .toLowerCase() === 'test'
    );
  } catch {
    return false;
  }
}

/**
 * The next valid business-hours moment from now in the prospect's timezone.
 * A `Test`-record `chatId` bypasses the guard → now + 2 minutes.
 */
export async function nextBusinessHoursStart(
  timezone?: string | null,
  state?: string | null,
  chatId?: string | null
): Promise<Date> {
  if (await bypassBusinessHours(chatId))
    return new Date(Date.now() + 2 * 60_000);
  return bh.nextBusinessHoursStart(timezone, state);
}

/**
 * Clamp a datetime into the prospect's local business-hours window. Anything already inside the
 * window on an allowed day is returned unchanged. A `Test`-record `chatId` bypasses the guard.
 */
export async function clampToBusinessHours(
  dt: Date,
  timezone?: string | null,
  state?: string | null,
  chatId?: string | null
): Promise<Date> {
  if (await bypassBusinessHours(chatId)) return dt;
  return bh.clampToBusinessHours(dt, timezone, state);
}

function tasksRef(chatId: string) {
  return db.collection('chats').doc(chatId).collection('tasks');
}

/** A task is terminal — and so never touched by these sweeps — once skipped or permanently failed. */
function isTerminal(td: TaskDoc): boolean {
  return Boolean(td.skipped || td.permanent_failure);
}

/**
 * Delete every pending task of the given type(s) on a chat. Best-effort; returns the count deleted.
 */
async function deletePendingTasks(
  chatId: string,
  types: readonly string[]
): Promise<number> {
  if (!chatId) return 0;
  let n = 0;
  try {
    const snap = await tasksRef(chatId)
      .where('type', 'in', [...types])
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      if (isTerminal((t.data() ?? {}) as TaskDoc)) continue;
      try {
        await t.ref.delete();
        n += 1;
      } catch (e) {
        console.warn(
          `[OB SCHED] delete pending task ${t.id} failed chat=${chatId}: ${e}`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[OB SCHED] delete pending tasks query failed chat=${chatId} types=${types}: ${e}`
    );
  }
  return n;
}

/**
 * The channel a proactive task drives. An explicit `channel` tag wins; otherwise it is inferred from
 * the type (`call_followup`/`callback` → phone, everything else → email).
 *
 * Used ONLY for per-channel enforcement on dual (test) chats. Untagged single-lane production tasks
 * are never grouped by this.
 */
export function taskChannel(td: TaskDoc | null | undefined): OutreachLane {
  const ch = String(td?.channel ?? '')
    .trim()
    .toLowerCase();
  if (ch === 'phone' || ch === 'email') return ch;
  return td?.type === 'call_followup' || td?.type === 'callback'
    ? 'phone'
    : 'email';
}

/**
 * Enforce the proactive-task invariant: delete pending proactive tasks EXCEPT `keepTaskId`.
 * Call immediately after creating a proactive task, keeping the new one.
 *
 * Default (`perChannel = false`) is ≤1 proactive **total** — the freshly-scheduled touch becomes the
 * only pending proactive task. That is production single-lane behaviour.
 *
 * `perChannel = true` (dual test chats only) is ≤1 proactive **per channel**: only other pending
 * tasks on the SAME channel as `keepTaskId` are deleted, so a phone cadence and an email cadence can
 * each hold one pending touch.
 *
 * Best-effort; returns the count deleted.
 */
export async function enforceSingleProactiveTask(
  chatId: string,
  keepTaskId?: string | null,
  perChannel = false
): Promise<number> {
  if (!chatId) return 0;
  let n = 0;
  try {
    const snap = await tasksRef(chatId)
      .where('type', 'in', [...PROACTIVE_TASK_TYPES])
      .where('executed', '==', false)
      .get();
    const rows = snap.docs;

    let keepChannel: OutreachLane | null = null;
    if (perChannel) {
      for (const t of rows) {
        if (t.id === keepTaskId) {
          keepChannel = taskChannel((t.data() ?? {}) as TaskDoc);
          break;
        }
      }
    }

    for (const t of rows) {
      if (t.id === keepTaskId) continue;
      const td = (t.data() ?? {}) as TaskDoc;
      if (isTerminal(td)) continue;
      // A different channel keeps its own pending touch on a dual chat.
      if (perChannel && keepChannel !== null && taskChannel(td) !== keepChannel)
        continue;
      try {
        await t.ref.delete();
        n += 1;
      } catch (e) {
        console.warn(
          `[OB SCHED] enforce_single_proactive delete ${t.id} failed chat=${chatId}: ${e}`
        );
      }
    }

    if (n) {
      console.log(
        `[OB SCHED] enforce_single_proactive: chat=${chatId} kept ${keepTaskId} ` +
          `(per_channel=${perChannel}, channel=${keepChannel}), deleted ${n} other proactive task(s)`
      );
    }
  } catch (e) {
    console.warn(
      `[OB SCHED] enforce_single_proactive query failed chat=${chatId}: ${e}`
    );
  }
  return n;
}

/**
 * Does the chat have at least one pending proactive task?
 *
 * The stalled-chat sweep reads `false` as "cadence stalled — schedule its next step". So this
 * **fails CLOSED**: on a read error it returns `true`, because a transient Firestore fault must not
 * be mistaken for a stalled cadence and trigger a spurious extra outreach.
 */
export async function hasPendingProactiveTask(
  chatId: string,
  channel?: OutreachLane | null
): Promise<boolean> {
  if (!chatId) return false;
  const want = channel
    ? (String(channel).trim().toLowerCase() as OutreachLane)
    : null;
  try {
    const snap = await tasksRef(chatId)
      .where('type', 'in', [...PROACTIVE_TASK_TYPES])
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      const td = (t.data() ?? {}) as TaskDoc;
      if (isTerminal(td)) continue;
      if (want !== null && taskChannel(td) !== want) continue;
      return true;
    }
    return false;
  } catch (e) {
    console.warn(
      `[OB SCHED] hasPendingProactiveTask failed chat=${chatId}: ${e} — assuming pending`
    );
    return true;
  }
}

/**
 * Delete pending tasks of ONE type before creating a fresh one, so duplicate-prone types
 * (`check_if_call_succeeded`, `call_completion_continuation`) never stack.
 */
export async function deletePendingTasksByType(
  chatId: string,
  taskType: string
): Promise<number> {
  return deletePendingTasks(chatId, [taskType]);
}

/**
 * Delete pending `outbound_outreach` tasks, so a deferral or re-outreach reschedules rather than
 * stacking, and a completed outreach leaves none behind.
 */
export async function deletePendingOutboundOutreach(
  chatId: string
): Promise<number> {
  return deletePendingTasks(chatId, ['outbound_outreach']);
}

/**
 * Delete pending email/call follow-ups.
 *
 * Used when a fresh first-touch `outbound_outreach` is queued: a pending outreach means the first
 * touch has not happened, so no follow-up should exist yet — follow-ups are only created after the
 * outreach runs and the review schedules them.
 */
export async function deletePendingFollowups(chatId: string): Promise<number> {
  return deletePendingTasks(chatId, ['followup_if_no_reply', 'call_followup']);
}
