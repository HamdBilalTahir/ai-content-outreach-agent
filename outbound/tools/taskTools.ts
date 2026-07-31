/**
 * The three scheduling tools: `create_custom_task`, `update_custom_task`, `delete_custom_task`.
 *
 * These are how the agent schedules its own next touch, so the gates here decide whether a cadence
 * advances at all.
 *
 * ## `create_custom_task` runs four gates before it writes anything
 *
 *  1. **Type coercion.** `callback` and `outbound_call` are rewritten to `outbound_outreach`. Not
 *     cosmetic: the INBOUND cron fetches those two type names separately and would CONSUME the task,
 *     so a call scheduled under either name leaks out of the outbound lane entirely.
 *  2. **The channel gate.** Reads the trustworthy top-level opt-out keys and refuses to schedule a task
 *     whose channel is closed — a call task needs phone open, an email task needs email open. Fails
 *     OPEN when the chat doc cannot be read, because a read fault must not stall every cadence.
 *  3. **Email follow-ups require a SENT email.** `_first_outbound_email_at` is stamped only on a real
 *     send. A DEFERRED send already queued its own retry, so scheduling a follow-up on top would
 *     double-touch and advance the cadence with no email ever going out.
 *  4. **Single-pending.** `followup_if_no_reply` and `call_followup` replace their own prior unexecuted
 *     task rather than stacking; `outbound_outreach` additionally clears pending follow-ups, because a
 *     queued first touch means no follow-up should exist yet.
 *
 * ## The human `@ai` override is authoritative on timing, and applies to real records too
 *
 * `admin_asap` fires now; `admin_override` honours the exact time and SKIPS the business-hours clamp
 * even on a weekend. The task is tagged `admin_override` so the cron also runs it without the per-tick
 * cap or the business-hours pre-gate. This is deliberate: an admin's explicit instruction outranks the
 * pacing machinery, which exists to stop the MODEL from cold-calling at 2am.
 *
 * ## Business-hours clamping is inconsistent between create and update, on purpose here
 *
 * `create` clamps four voice types including `call_followup`; `update` clamps only three and OMITS
 * `call_followup`. So creating a phone-cadence bump lands inside business hours, but RESCHEDULING one
 * through `update_custom_task` does not. That is a real inconsistency in the source, and it is preserved
 * — changing it would move when live calls are placed. Both sets are named separately below so the
 * difference is visible rather than looking like a typo.
 *
 * ## "Already gone" is a SUCCESS for update and delete
 *
 * A task that already fired or was cancelled reports `skipped`, not `failed`. The distinction matters
 * because the agent surfaces tool failures into the conversation, and "I could not cancel a task that
 * no longer exists" is both alarming and wrong — the goal was already met.
 */

import { FieldValue, db } from '../firebase/db';
import {
  createTaskWithId,
  deleteTask,
  getMemory,
  getTask,
  updateTask,
} from '../firebase/chat';
import {
  PROACTIVE_TASK_TYPES,
  clampToBusinessHours,
  computeExecuteAt,
  deletePendingFollowups,
  deletePendingOutboundOutreach,
  enforceSingleProactiveTask,
} from '../services/scheduling';
import { loadChatDoc, taskChannelOpen } from '../services/chat';
import { registerTool } from '../llm/toolRegistry';
import type { BedrockMessage } from '../types';

/** Voice types the INBOUND cron fetches by name — rewritten so they stay in the outbound lane. */
const COERCE_TYPES: ReadonlySet<string> = new Set([
  'callback',
  'outbound_call',
]);

/**
 * Types that place a CALL, and so must land inside the prospect's business hours on CREATE.
 * `call_followup` is the phone-only bump cadence used when there is no email to nudge by.
 */
const VOICE_TASK_TYPES_CREATE: ReadonlySet<string> = new Set([
  'outbound_outreach',
  'callback',
  'outbound_call',
  'call_followup',
]);

/**
 * The same idea on UPDATE — but the source's set OMITS `call_followup`, so a rescheduled phone bump is
 * never clamped. See the module note; preserved rather than harmonized.
 */
const VOICE_TASK_TYPES_UPDATE: ReadonlySet<string> = new Set([
  'outbound_outreach',
  'callback',
  'outbound_call',
]);

/** One pending at a time, so nudges never stack. Email cadence and phone cadence respectively. */
const SINGLE_PENDING_TYPES: ReadonlySet<string> = new Set([
  'followup_if_no_reply',
  'call_followup',
]);

/** Wrap a tool result in the Bedrock envelope. */
function toolResult(
  toolUseId: string,
  result: Record<string, unknown>
): BedrockMessage {
  return {
    role: 'user',
    content: [{ toolResult: { toolUseId, content: [{ json: result }] } }],
  } as unknown as BedrockMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// create_custom_task
// ─────────────────────────────────────────────────────────────────────────────

export const createCustomTaskDescription = {
  toolSpec: {
    name: 'create_custom_task',
    description:
      'Schedule a future action on this prospect and get back a task ID (usable to update or ' +
      'delete it later). Pick the task_type that matches your intent: schedule the NEXT email ' +
      "follow-up when they haven't replied, schedule the NEXT call attempt, honor a " +
      'customer-requested callback at a specific time, or set a plain reminder. Choose the ' +
      "date/time in the prospect's local timezone; call tasks are automatically kept inside " +
      'business hours.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          task_type: {
            type: 'string',
            description:
              'Which kind of scheduled action — pick by intent:\n' +
              "- 'followup_if_no_reply': the next EMAIL follow-up to send only if the " +
              "prospect still hasn't replied (the email no-reply nudge cadence). Only " +
              'one is ever pending at a time — scheduling a new one replaces the prior.\n' +
              "- 'call_followup': the next phone CALL attempt (a retry of a missed call, " +
              'or the next round of calling). Phone-only; one pending at a time.\n' +
              "- 'callback': a callback at a specific time the CUSTOMER asked for.\n" +
              "- 'reminder': a generic reminder with no channel semantics.\n" +
              "Use 'followup_if_no_reply' for email nudges and 'call_followup' for call " +
              'attempts — do not use a generic type for those.',
          },
          date: {
            type: 'string',
            description: 'The date for the task in YYYY-MM-DD format',
          },
          time: {
            type: 'string',
            description: 'The time for the task in HH:MM format (24-hour)',
          },
          timezone: {
            type: 'string',
            description:
              "The timezone for the task (e.g., 'UTC', 'America/New_York')",
          },
          notes: {
            type: 'string',
            description: 'Additional notes or context for the task',
            default: '',
          },
          additional_data: {
            type: 'object',
            description: 'Any additional data specific to the task type',
            default: {},
          },
        },
        required: ['task_type', 'date', 'time', 'timezone'],
      },
    },
  },
} as const;

registerTool(
  createCustomTaskDescription.toolSpec.name,
  createCustomTaskDescription
);

/**
 * Delete every unexecuted task of one type, so "one pending at a time" holds. Returns the count.
 *
 * Best-effort by design: a failed purge must not stop the new task being written, because a missing
 * next touch stalls the cadence while a duplicate merely double-touches.
 */
export async function deletePreviousSinglePendingTasks(
  chatId: string,
  taskType: string
): Promise<number> {
  let deleted = 0;
  try {
    const snap = await db
      .collection('chats')
      .doc(chatId)
      .collection('tasks')
      .where('type', '==', taskType)
      .where('executed', '==', false)
      .get();
    for (const task of snap.docs) {
      try {
        await task.ref.delete();
        deleted += 1;
      } catch (e) {
        console.warn(`[OB] delete ${taskType} task ${task.id} failed: ${e}`);
      }
    }
  } catch (e) {
    console.warn(`[OB] query ${taskType} tasks failed for ${chatId}: ${e}`);
  }
  return deleted;
}

export interface CreateTaskOptions {
  adminAsap?: boolean;
  adminOverride?: boolean;
}

/**
 * Resolve `execute_at` and write the task. Returns `[taskId | null, message]`.
 *
 * The clamp reads the prospect's CACHED timezone and state from memory rather than trusting the
 * LLM-supplied timezone — the cached location is the source of truth for state-aware holidays. When the
 * clamp moves the time, the reason is written into the task notes AND the tool message, so the agent can
 * see why the call is not at the time it asked for.
 */
export async function createScheduledCustomTask(
  accountId: string,
  taskType: string,
  date: string,
  time: string,
  timezone: string,
  notes: string,
  additionalData: Record<string, unknown> | null | undefined,
  attendeeId: string,
  chatId: string,
  options: CreateTaskOptions = {}
): Promise<[string | null, string]> {
  try {
    let taskDatetime: Date;
    try {
      taskDatetime = computeExecuteAt(date, time, timezone);
    } catch (e) {
      return [null, `Invalid date/time format: ${e}`];
    }

    let clampedNote = '';
    if (options.adminAsap) {
      taskDatetime = new Date();
      clampedNote = ' [human @ai ASAP → scheduled now]';
      console.log(
        `[OB] create_custom_task: human @ai ASAP override — '${taskType}' scheduled now (chat ${chatId}).`
      );
    } else if (VOICE_TASK_TYPES_CREATE.has(taskType)) {
      if (options.adminOverride) {
        // An admin named an explicit time. Honour it exactly — the pacing machinery exists to stop the
        // MODEL cold-calling at 2am, not to override a human instruction.
        clampedNote =
          ' [human @ai trigger → exact time honored (business hours bypassed)]';
        console.log(
          `[OB] create_custom_task: human @ai override — '${taskType}' exact time honored (chat ${chatId}).`
        );
      } else {
        let tzForClamp = timezone;
        let stateForClamp: string | null = null;
        try {
          const mem = (await getMemory(chatId)) ?? {};
          tzForClamp = mem.timezone || timezone;
          stateForClamp = (mem.state as string | undefined) ?? null;
        } catch (e) {
          console.warn(
            `[OB] create_custom_task: memory read failed for clamp (${e}); using supplied timezone ${timezone}`
          );
        }
        const preClamp = taskDatetime;
        taskDatetime = await clampToBusinessHours(
          taskDatetime,
          tzForClamp,
          stateForClamp,
          chatId
        );
        if (taskDatetime.getTime() !== preClamp.getTime()) {
          const clampedIso = taskDatetime.toISOString();
          clampedNote =
            ` [moved into business hours (outside_business_hours); ` +
            `call time adjusted to ${clampedIso}]`;
          console.log(
            `[OB] create_custom_task: clamped voice '${taskType}' into business hours ` +
              `for chat ${chatId} -> ${clampedIso}`
          );
        }
      }
    }

    const taskData: Record<string, unknown> = {
      notes: clampedNote ? `${notes}${clampedNote}` : notes,
      account_id: accountId,
      attendee_id: attendeeId,
      timezone,
      original_date: date,
      original_time: time,
    };
    if (options.adminOverride || options.adminAsap) {
      // The cron reads this to run the task ungated: no per-tick cap, no business-hours pre-gate.
      taskData.admin_override = true;
    }
    if (additionalData) Object.assign(taskData, additionalData);

    // A queued first-touch outreach means no follow-up should exist yet, and a chat runs ONE lane at a
    // time (phone, or the email fallback after phone exhaustion) — so ≤1 pending TOTAL is right here.
    if (taskType === 'outbound_outreach') {
      await deletePendingOutboundOutreach(chatId);
      await deletePendingFollowups(chatId);
    }

    const taskId = await createTaskWithId(
      chatId,
      taskType,
      taskDatetime,
      taskData
    );
    if (!taskId) return [null, 'Failed to create task in Firestore'];

    // INVARIANT: ≤1 pending PROACTIVE task per chat — this new touch is the only one that should queue.
    try {
      if ((PROACTIVE_TASK_TYPES as readonly string[]).includes(taskType)) {
        await enforceSingleProactiveTask(chatId, taskId);
      }
    } catch (e) {
      console.warn(
        `[OB] enforce_single_proactive after create failed chat=${chatId}: ${e}`
      );
    }

    return [
      taskId,
      `Custom task '${taskType}' scheduled successfully${clampedNote}`,
    ];
  } catch (e) {
    return [null, `Error creating custom task: ${e}`];
  }
}

export interface CreateTaskInput {
  task_type?: string;
  date?: string;
  time?: string;
  timezone?: string;
  notes?: string;
  additional_data?: Record<string, unknown>;
}

export interface TaskToolMeta {
  admin_asap?: boolean;
  admin_override?: boolean;
  [k: string]: unknown;
}

/** Run the `create_custom_task` tool. See the module note for the four gates and their order. */
export async function parseAndRunCreateCustomTask(
  toolUseId: string,
  input: CreateTaskInput,
  accountId: string,
  attendeeId: string,
  chatId: string,
  metaData: TaskToolMeta = {}
): Promise<BedrockMessage> {
  const inp = { ...(input ?? {}) };
  let taskType = inp.task_type ?? '';

  // GATE 1 — coerce, or the inbound cron consumes the task and it never dials.
  if (COERCE_TYPES.has(taskType)) {
    console.log(
      `[OB] create_custom_task: coerced task_type '${taskType}' -> 'outbound_outreach' ` +
        `(chat ${chatId}) so the outbound cron handles it, not the inbound voice path`
    );
    taskType = 'outbound_outreach';
  }

  const date = inp.date ?? '';
  const time = inp.time ?? '';
  const timezone = inp.timezone ?? 'UTC';
  const notes = inp.notes ?? '';
  const additionalData = inp.additional_data ?? {};

  // GATE 2 — channel opt-out. Fails OPEN when the doc cannot be read.
  if (chatId) {
    try {
      const doc = await loadChatDoc(chatId);
      // EMPTINESS, not truthiness. `loadChatDoc` returns `{}` for a missing chat AND for a read
      // failure, and the source's `if _doc` treats that as falsy — so an unreadable doc SKIPS this gate
      // and the task is still created. A JS `{}` is truthy, so checking the object alone would invert a
      // documented fail-open into fail-closed and silently stall every cadence on a Firestore blip.
      if (
        Object.keys(doc ?? {}).length > 0 &&
        !taskChannelOpen(doc, taskType)
      ) {
        console.log(
          `[OB] create_custom_task: channel opted out for chat ${chatId} — ` +
            `refusing to schedule '${taskType}'.`
        );
        return toolResult(toolUseId, {
          status: 'skipped',
          message:
            `The channel for a '${taskType}' task is opted out for this contact ` +
            '— no task scheduled. Use an open channel or stop outreach.',
        });
      }
    } catch (e) {
      console.warn(
        `[OB] create_custom_task channel gate skipped for ${chatId}: ${e}`
      );
    }
  }

  // GATE 3 — an email follow-up needs an email to have actually SENT. A deferred send retries itself.
  if (
    chatId &&
    (taskType === 'followup' || taskType === 'followup_if_no_reply')
  ) {
    try {
      if (!(await getMemory(chatId))?._first_outbound_email_at) {
        console.log(
          `[OB] create_custom_task: no prior email send for chat ${chatId} — refusing to ` +
            `schedule '${taskType}' (follow-ups require a sent email; a deferred send retries itself).`
        );
        return toolResult(toolUseId, {
          status: 'skipped',
          message:
            'No email has actually sent yet, so a follow-up cannot be scheduled. If ' +
            'the last email deferred, its retry is already queued — end the turn.',
        });
      }
    } catch (e) {
      console.warn(
        `[OB] create_custom_task followup-on-send gate skipped for ${chatId}: ${e}`
      );
    }
  }

  // GATE 4 — single-pending.
  let deletedCount = 0;
  if (chatId && SINGLE_PENDING_TYPES.has(taskType)) {
    deletedCount = await deletePreviousSinglePendingTasks(chatId, taskType);
  }

  if (!chatId) {
    return toolResult(toolUseId, {
      status: 'failed',
      message: 'chat_id is required',
    });
  }

  const [taskId, msg] = await createScheduledCustomTask(
    accountId,
    taskType,
    date,
    time,
    timezone,
    notes,
    additionalData,
    attendeeId,
    chatId,
    {
      adminAsap: !!metaData.admin_asap,
      adminOverride: !!metaData.admin_override,
    }
  );

  if (!taskId) {
    return toolResult(toolUseId, { status: 'failed', message: msg });
  }
  return toolResult(toolUseId, {
    status: 'created',
    task_id: taskId,
    message:
      deletedCount > 0
        ? `Deleted ${deletedCount} previous unexecuted ${taskType} task(s) and created a new one`
        : msg,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// update_custom_task
// ─────────────────────────────────────────────────────────────────────────────

export const updateCustomTaskDescription = {
  toolSpec: {
    name: 'update_custom_task',
    description:
      'Update an existing custom task. Can update execution time, mark as executed, change task ' +
      'data, task type, or modify any other task properties. Use the task ID returned from ' +
      'create_custom_task.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description:
              'The ID of the task to update (returned from create_custom_task)',
          },
          date: {
            type: 'string',
            description:
              'New date for the task in YYYY-MM-DD format (optional)',
          },
          time: {
            type: 'string',
            description: 'New time for the task in HH:MM format (optional)',
          },
          timezone: {
            type: 'string',
            description: 'New timezone for the task (optional)',
          },
          executed: {
            type: 'boolean',
            description: 'Mark task as executed (true) or not executed (false)',
          },
          task_type: {
            type: 'string',
            description:
              "Update the task type (e.g., 'followup', 'reminder', 'callback')",
          },
          notes: {
            type: 'string',
            description: 'Update task notes or context',
          },
          additional_data: {
            type: 'object',
            description:
              'Update additional task data (will merge with existing data)',
          },
        },
        required: ['task_id'],
      },
    },
  },
} as const;

registerTool(
  updateCustomTaskDescription.toolSpec.name,
  updateCustomTaskDescription
);

export interface UpdateTaskInput {
  task_id?: string;
  date?: string | null;
  time?: string | null;
  timezone?: string | null;
  executed?: boolean | null;
  task_type?: string | null;
  notes?: string | null;
  additional_data?: Record<string, unknown> | null;
}

/**
 * Apply the requested changes. Returns `[true | false | null, message]`, where **null means the task no
 * longer exists** — a benign no-op, not a failure.
 *
 * `additional_data` MERGES into the existing `data` map rather than replacing it, so an update that
 * touches one key cannot silently drop the rest of a task's payload.
 */
export async function updateScheduledCustomTask(
  chatId: string,
  taskId: string,
  input: UpdateTaskInput
): Promise<[boolean | null, string]> {
  try {
    const currentTask = await getTask(chatId, taskId);
    if (!currentTask || Object.keys(currentTask).length === 0) {
      return [
        null,
        `Task ${taskId} no longer exists (already fired or cancelled) — nothing to update.`,
      ];
    }

    const {
      date,
      time,
      timezone,
      executed,
      task_type: taskType,
      notes,
    } = input;
    const additionalData = input.additional_data;
    const updates: Record<string, unknown> = {};
    const msgs: string[] = [];
    const curData = (currentTask.data ?? {}) as Record<string, unknown>;

    const timingTouched =
      date !== undefined || time !== undefined || timezone !== undefined;

    if (timingTouched) {
      const newDate = (date !== undefined ? date : curData.original_date) as
        | string
        | undefined;
      const newTime = (time !== undefined ? time : curData.original_time) as
        | string
        | undefined;
      const newTz = (
        timezone !== undefined ? timezone : (curData.timezone ?? 'UTC')
      ) as string;
      if (newDate && newTime) {
        let dt: Date;
        try {
          dt = computeExecuteAt(newDate, newTime, newTz);
        } catch (e) {
          return [false, `Invalid date/time/timezone: ${e}`];
        }
        const newType = (
          taskType !== undefined ? taskType : currentTask.type
        ) as string | undefined;
        // NOTE the set used here omits `call_followup` — see the module note.
        if (newType && VOICE_TASK_TYPES_UPDATE.has(newType)) {
          dt = await clampToBusinessHours(dt, newTz, null, chatId);
        }
        updates.execute_at = dt;
        msgs.push(`execution time to ${newDate} ${newTime} ${newTz}`);
      }
    }

    const dataUpdates: Record<string, unknown> = {};
    if (timingTouched) {
      dataUpdates.original_date =
        date !== undefined ? date : curData.original_date;
      dataUpdates.original_time =
        time !== undefined ? time : curData.original_time;
      dataUpdates.timezone =
        timezone !== undefined ? timezone : (curData.timezone ?? 'UTC');
    }
    if (notes !== undefined && notes !== null) {
      dataUpdates.notes = notes;
      msgs.push('notes');
    }
    if (additionalData !== undefined && additionalData !== null) {
      Object.assign(dataUpdates, additionalData);
      msgs.push('additional data');
    }
    if (Object.keys(dataUpdates).length > 0) {
      // Merge, never replace: a partial update must not drop the rest of the payload.
      updates.data = { ...curData, ...dataUpdates };
    }

    if (executed !== undefined && executed !== null) {
      updates.executed = executed;
      msgs.push(`status to ${executed ? 'executed' : 'not executed'}`);
    }
    if (taskType !== undefined && taskType !== null) {
      updates.type = taskType;
      msgs.push(`type to '${taskType}'`);
    }

    if (Object.keys(updates).length === 0) {
      return [false, 'No updates provided'];
    }
    if (await updateTask(chatId, taskId, updates)) {
      return [true, `Updated task ${taskId}: ${msgs.join(', ')}`];
    }
    return [false, 'Failed to update task in Firestore'];
  } catch (e) {
    return [false, `Error updating custom task: ${e}`];
  }
}

/** Run the `update_custom_task` tool. */
export async function parseAndRunUpdateCustomTask(
  toolUseId: string,
  input: UpdateTaskInput,
  accountId: string,
  attendeeId: string,
  chatId: string
): Promise<BedrockMessage> {
  void accountId;
  void attendeeId;
  const taskId = input.task_id ?? '';
  if (!chatId) {
    return toolResult(toolUseId, {
      status: 'failed',
      message: 'chat_id is required',
    });
  }
  if (!taskId) {
    return toolResult(toolUseId, {
      status: 'failed',
      message: 'task_id is required',
    });
  }
  const [success, message] = await updateScheduledCustomTask(
    chatId,
    taskId,
    input
  );
  // null → already gone: report `skipped`, so the agent does not surface a scary failure for a task
  // whose absence already satisfies the request.
  const status = success === null ? 'skipped' : success ? 'updated' : 'failed';
  return toolResult(toolUseId, { status, task_id: taskId, message });
}

// ─────────────────────────────────────────────────────────────────────────────
// delete_custom_task
// ─────────────────────────────────────────────────────────────────────────────

export const deleteCustomTaskDescription = {
  toolSpec: {
    name: 'delete_custom_task',
    description:
      "Delete a custom task when it's no longer needed. Use this to cancel scheduled follow-ups, " +
      'reminders, callbacks, or other tasks. The task will be permanently removed.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description:
              'The ID of the task to delete (returned from create_custom_task)',
          },
          reason: {
            type: 'string',
            description: 'Optional reason for deleting the task',
            default: '',
          },
        },
        required: ['task_id'],
      },
    },
  },
} as const;

registerTool(
  deleteCustomTaskDescription.toolSpec.name,
  deleteCustomTaskDescription
);

/** Returns `[true | false | null, message]`; **null means already gone**, which meets the goal. */
export async function deleteScheduledCustomTask(
  chatId: string,
  taskId: string,
  reason: string
): Promise<[boolean | null, string]> {
  try {
    const currentTask = await getTask(chatId, taskId);
    if (!currentTask || Object.keys(currentTask).length === 0) {
      return [
        null,
        `Task ${taskId} already gone (fired or cancelled) — nothing to delete.`,
      ];
    }
    const taskType = (currentTask.type as string) ?? 'unknown';
    if (await deleteTask(chatId, taskId)) {
      const reasonText = reason ? ` (Reason: ${reason})` : '';
      return [
        true,
        `Deleted task ${taskId} of type '${taskType}'${reasonText}`,
      ];
    }
    return [false, 'Failed to delete task from Firestore'];
  } catch (e) {
    return [false, `Error deleting custom task: ${e}`];
  }
}

/** Run the `delete_custom_task` tool. */
export async function parseAndRunDeleteCustomTask(
  toolUseId: string,
  input: { task_id?: string; reason?: string },
  accountId: string,
  attendeeId: string,
  chatId: string
): Promise<BedrockMessage> {
  void accountId;
  void attendeeId;
  const taskId = input.task_id ?? '';
  if (!chatId) {
    return toolResult(toolUseId, {
      status: 'failed',
      message: 'chat_id is required',
    });
  }
  if (!taskId) {
    return toolResult(toolUseId, {
      status: 'failed',
      message: 'task_id is required',
    });
  }
  const [success, message] = await deleteScheduledCustomTask(
    chatId,
    taskId,
    input.reason ?? ''
  );
  const status = success === null ? 'skipped' : success ? 'deleted' : 'failed';
  return toolResult(toolUseId, { status, task_id: taskId, message });
}

/** Exposed for tests: the type sets whose difference is deliberate. */
export const __testing = {
  COERCE_TYPES,
  VOICE_TASK_TYPES_CREATE,
  VOICE_TASK_TYPES_UPDATE,
  SINGLE_PENDING_TYPES,
  FieldValue,
};
