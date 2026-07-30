/**
 * Deterministically (re)schedule the pre-demo reminders after a successful booking.
 *
 * Reminders used to be LLM-driven — the skill told the model to create the tasks — which silently
 * no-op'd whenever the model booked, emailed, and then ended the turn: a booked demo with zero
 * reminders. This schedules them in CODE the moment a booking succeeds, so they always run.
 *
 * The PLAN (offsets, channel, notes) comes from the active Lead-stage skill's `reminders` config. The
 * built-in default below matches the skill prose, so it works before the field is configured, and a
 * configured skill overrides it entirely with its own fixed offsets.
 *
 * Each reminder is a `type: "reminder"` task — the same shape the LLM used to create — which the cron
 * fires as an `@ai` turn whose notes drive the email or call.
 */

import { DateTime } from 'luxon';

import { db, toDate } from '../firebase/db';
import { createTaskWithId, getMemory } from '../firebase/chat';
import { getActiveOutboundSkillsForStage } from './skillsResolver';
import { clampToBusinessHours } from './scheduling';
import { loadChatDoc, taskChannelOpen } from './chat';
import type { ChatMemory, TaskDoc } from '../types';

/**
 * Note templates for the built-in lead-time-aware plan. `{first_name}` / `{company}` / `{demo}` are
 * filled by `fill`.
 */
const N_DAY_BEFORE_EMAIL =
  'Reminder EMAIL for {first_name} at {company} — demo TOMORROW on {demo}. Restate ' +
  'the day/time and include the invite/link.';
const N_DAY_BEFORE_CALL =
  'Reminder CALL — call {first_name} to confirm the demo for {demo}. If they need to ' +
  'move it, capture their preferred new day/time.';
const N_HEADS_UP =
  'Reminder EMAIL — demo TODAY on {demo}. Restate the time and include the join link.';
const N_TWO_HOURS =
  'Reminder EMAIL — demo in ~2 hours on {demo}. Restate the time and include the join link.';
const N_COMBINED =
  'Reminder EMAIL — demo TODAY on {demo}. Include the join link and restate the exact time.';

/**
 * The 9 AM heads-up and the two-hours-before go out as SEPARATE emails only when they are at least
 * this far apart. For an earlier demo they collapse into ONE combined morning email carrying the link
 * — so you never get a bare 9 AM heads-up with no real reminder, nor two emails minutes apart.
 */
const MIN_SPLIT_GAP_MS = 6 * 3_600_000;

function parseIsoUtc(value: unknown): Date | null {
  if (!value) return null;
  const asDate = toDate(value);
  if (asDate) return asDate;
  try {
    let s = String(value).replace('Z', '+00:00');
    if (!/(?:[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** A skill-authored `reminders` entry: fixed offsets that override the built-in plan wholesale. */
export interface ReminderSpec {
  offset_minutes?: number;
  channel?: string;
  notes?: string;
}

/**
 * The active Lead-stage skill's `reminders` config, or `null` to use the built-in lead-time-aware
 * plan. Best-effort: a read failure falls back to the default rather than skipping reminders.
 */
async function reminderSpecs(agentId: string): Promise<ReminderSpec[] | null> {
  try {
    const skills =
      (await getActiveOutboundSkillsForStage(agentId, 'Lead', [])) ?? [];
    for (const skill of skills) {
      const specs = (skill as Record<string, unknown>).reminders;
      if (Array.isArray(specs) && specs.length > 0) {
        return specs as ReminderSpec[];
      }
    }
  } catch (e) {
    console.warn(
      `[OB REMINDERS] skill config read failed (${e}); using lead-aware default`
    );
  }
  return null;
}

interface PlanEntry {
  execute_at: Date;
  channel: string;
  notes: string;
}

/**
 * The human, lead-time-aware pre-demo plan, used when no skill override is configured:
 *  - demo more than 24h away → a DAY-BEFORE call and email (24h before, the call clamped into
 *    business hours), plus the demo-day reminders. A demo ≤24h out gets no day-before.
 *  - demo day → a 9 AM heads-up email plus a `demo − 2h` email carrying the link, when those are at
 *    least `MIN_SPLIT_GAP_MS` apart; otherwise ONE combined morning email, always before the demo.
 *
 * Past-due entries are pruned by the caller.
 */
async function leadAwarePlan(
  chatId: string,
  meetingAt: Date,
  now: Date,
  tzName: string,
  state: string | null
): Promise<PlanEntry[]> {
  const plan: PlanEntry[] = [];
  const leadMs = meetingAt.getTime() - now.getTime();

  const zone = tzName || 'America/New_York';
  let local = DateTime.fromJSDate(meetingAt, { zone });
  if (!local.isValid) local = DateTime.fromJSDate(meetingAt, { zone: 'UTC' });

  const twoH = new Date(meetingAt.getTime() - 2 * 3_600_000);
  const nineLocal = local.set({
    hour: 9,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const nineUtc = nineLocal.toJSDate();

  // 1. Day-before call and email — ONLY when the demo is more than a day out.
  if (leadMs > 24 * 3_600_000) {
    const dayBefore = new Date(meetingAt.getTime() - 24 * 3_600_000);
    // Routed through the scheduling wrapper, so a `Test` record bypasses the window exactly as it
    // does everywhere else — a day-before confirmation call on a test chat must not be clamped away.
    let callAt = dayBefore;
    try {
      callAt = await clampToBusinessHours(dayBefore, tzName, state, chatId);
    } catch {
      callAt = dayBefore;
    }
    plan.push({
      execute_at: dayBefore,
      channel: 'email',
      notes: N_DAY_BEFORE_EMAIL,
    });
    plan.push({
      execute_at: callAt,
      channel: 'call',
      notes: N_DAY_BEFORE_CALL,
    });
  }

  // 2. Demo-day reminders.
  if (
    nineUtc < meetingAt &&
    twoH.getTime() - nineUtc.getTime() >= MIN_SPLIT_GAP_MS
  ) {
    // Well separated (a late demo) → morning heads-up plus a starting-soon email with the link.
    plan.push({ execute_at: nineUtc, channel: 'email', notes: N_HEADS_UP });
    plan.push({ execute_at: twoH, channel: 'email', notes: N_TWO_HOURS });
  } else {
    // Earlier demo → ONE combined morning email carrying the link, timed before the demo.
    let single = new Date(Math.max(nineUtc.getTime(), twoH.getTime()));
    if (single >= meetingAt) single = twoH;
    plan.push({ execute_at: single, channel: 'email', notes: N_COMBINED });
  }

  return plan;
}

/** `"Friday, July 17 at 10:00 AM EDT"`, in the prospect's zone. */
function formatDemo(meetingAt: Date, tzName: string): string {
  const zone = tzName || 'America/New_York';
  let local = DateTime.fromJSDate(meetingAt, { zone });
  if (!local.isValid) local = DateTime.fromJSDate(meetingAt, { zone: 'UTC' });
  return local.toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
}

/**
 * Token substitution by plain replacement rather than a format call, so a stray brace in
 * skill-authored notes cannot throw.
 */
function fill(
  template: string | undefined,
  firstName: string,
  company: string,
  demo: string
): string {
  let out = String(template ?? '');
  for (const [tok, val] of [
    ['{first_name}', firstName],
    ['{company}', company],
    ['{demo}', demo],
  ] as const) {
    out = out.split(tok).join(val);
  }
  return out;
}

/**
 * Delete unexecuted `reminder` tasks so a re-book or reschedule never stacks duplicates. Returns the
 * count deleted.
 */
export async function deletePendingReminders(chatId: string): Promise<number> {
  let deleted = 0;
  try {
    const snap = await db
      .collection('chats')
      .doc(chatId)
      .collection('tasks')
      .where('type', '==', 'reminder')
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      try {
        await t.ref.delete();
        deleted += 1;
      } catch (e) {
        console.warn(`[OB REMINDERS] delete task ${t.id} failed: ${e}`);
      }
    }
  } catch (e) {
    console.warn(`[OB REMINDERS] dedup query failed for ${chatId}: ${e}`);
  }
  return deleted;
}

/**
 * After a successful booking, (re)schedule the pre-demo reminders deterministically.
 *
 * Dedups existing pending reminders first, skips any spec already in the past, and skips a reminder
 * whose channel is opted out — a call reminder to an opted-out phone, or an email reminder to an
 * opted-out address. Best-effort throughout; never throws. Returns the created task ids.
 */
export async function scheduleBookingReminders(
  chatId: string,
  agentId: string,
  now?: Date
): Promise<string[]> {
  const created: string[] = [];
  if (!chatId) return created;

  try {
    const mem: ChatMemory = (await getMemory(chatId)) ?? {};
    const meetingAt = parseIsoUtc(mem.meeting_at);
    if (!meetingAt) {
      console.warn(
        `[OB REMINDERS] no meeting_at in memory for ${chatId}; skipping`
      );
      return created;
    }

    const tzName = String(mem.timezone ?? '') || 'America/New_York';
    const state = mem.state ? String(mem.state) : null;
    const firstName = String(mem.first_name ?? '').trim() || 'there';
    const company = String(mem.company ?? '').trim() || 'your dealership';
    const demo = formatDemo(meetingAt, tzName);
    const at = now ?? new Date();

    await deletePendingReminders(chatId);

    // The per-channel opt-out gate reads the trustworthy top-level keys, loaded once.
    const chatDoc = await loadChatDoc(chatId);

    const specs = await reminderSpecs(agentId);
    const entries: PlanEntry[] = specs
      ? specs.map((s) => ({
          execute_at: new Date(
            meetingAt.getTime() + Number(s.offset_minutes ?? 0) * 60_000
          ),
          channel: String(s.channel ?? ''),
          notes: String(s.notes ?? ''),
        }))
      : await leadAwarePlan(chatId, meetingAt, at, tzName, state);

    for (const e of entries) {
      try {
        if (e.execute_at <= at) {
          console.log(
            `[OB REMINDERS] skip past ${e.channel} reminder for ${chatId}`
          );
          continue;
        }
        // Fail-open if the chat doc could not be read — a reminder for a booked demo matters more
        // than a gate we cannot evaluate.
        if (
          chatDoc &&
          Object.keys(chatDoc).length > 0 &&
          !taskChannelOpen(chatDoc, 'reminder', e.channel)
        ) {
          console.log(
            `[OB REMINDERS] skip ${e.channel} reminder — channel opted out (${chatId})`
          );
          continue;
        }

        const taskData: Record<string, unknown> = {
          notes: fill(e.notes, firstName, company, demo),
          account_id: agentId,
          attendee_id: mem.phone_number,
          timezone: tzName,
          task_source: 'auto_booking_reminder',
          channel: e.channel,
        };
        const tid = await createTaskWithId(
          chatId,
          'reminder',
          e.execute_at,
          taskData
        );
        if (tid) created.push(tid);
      } catch (e2) {
        console.warn(
          `[OB REMINDERS] failed to create reminder for ${chatId}: ${e2}`
        );
      }
    }

    console.log(
      `[OB REMINDERS] scheduled ${created.length} reminder(s) for ${chatId} (demo ${demo})`
    );
  } catch (e) {
    console.warn(
      `[OB REMINDERS] scheduleBookingReminders failed for ${chatId}: ${e}`
    );
  }
  return created;
}

/** Exposed for tests: the pure plan, independent of Firestore. */
export const __testing = { leadAwarePlan, formatDemo, fill, parseIsoUtc };
export type { TaskDoc };
