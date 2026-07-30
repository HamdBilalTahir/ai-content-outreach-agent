/**
 * The outbound cron — the task processor.
 *
 * Fetches due, non-executed tasks on ACTIVE `type == "outbound"` chats and runs each as an `@AI admin`
 * turn. Tasks live in the shared `chats/{id}/tasks` collection; the inbound cron independently skips
 * `type == "outbound"`, so the two never double-process.
 *
 * ## Four independent layers stop the same task running twice
 *
 * This is the most correctness-critical ordering in the system, and each layer exists because the one
 * before it is insufficient:
 *
 *  1. **The wide lookback** guarantees an overdue task is still *found*. The shared query's default
 *     lower bound is only `now - 2·window`, so a task overdue by more than a few minutes would fall
 *     out of the window and be stranded forever. The default lookback is 14 days.
 *  2. **Per-chat serialization** keeps only the OLDEST due task per chat this tick. Two DIFFERENT due
 *     tasks on one chat would otherwise run concurrently and race past the non-atomic processing
 *     soft-lock, producing duplicate reviews and stage flapping. A per-TASK claim cannot stop this,
 *     because the task ids differ.
 *  3. **The atomic dispatch claim** marks the task executed AT DISPATCH, before the 15–45s turn runs.
 *     Without it the same task re-dispatches on every overlapping tick for the whole run.
 *  4. **The per-chat dial guard**, inside the call tool itself.
 *
 * Combined with the claim, layer 2 gives: one chat ⇒ at most one turn in flight.
 *
 * ## The business-hours pre-gate is at the TASK level, deliberately
 *
 * For a pure outreach task outside the prospect's window, the task is rescheduled and NO LLM turn
 * runs. Gating inside the turn instead would burn a turn, produce reasoning, and leak a "deferred"
 * card into the conversation. The deferral is represented purely by the rescheduled task. Review,
 * continuation and watchdog tasks are NOT gated — they process results without contacting anyone.
 *
 * ## Priority tasks bypass the cap
 *
 * Test records and human `@ai`-override tasks are queued at the FRONT and are never subject to the
 * per-tick cap, so an E2E run or an admin's explicit instruction dispatches on the very next tick
 * rather than waiting behind a production backlog.
 *
 * ## The injected turn runner
 *
 * The source lazily imports `run_outbound_llm` inside the function to break a circular import. The LLM
 * layer is a later phase, so `processOutboundTasks` takes the runner as a parameter instead. That makes
 * the whole orchestration — the claim, the gates, the serialization, the priority split — testable now,
 * with the LLM phase supplying the real runner and the HTTP layer wiring it.
 */

import { db, getAllChunked, runWithConcurrency, toDate } from '../firebase/db';
import { getMemory, updateTask, updateTaskStatus } from '../firebase/chat';
import { checkBusinessHours } from './businessHours';
import { claimTask, dispatchClaimEnabled } from './taskDispatch';
import { nextBusinessHoursStart } from './scheduling';
import { reconcileVoiceSlots } from './voiceConcurrency';
import { emailDailySummary, type DailySummary } from './reputation';
import { reconcileStalePendingCalls } from './stalledRecovery';
import {
  archiveCampaignBatch,
  enrollCampaignBatch,
  enrollingCampaignIds,
  pauseCampaignChatsBatch,
  pausedCampaignIds,
  pausingCampaignIds,
  resumeCampaignChatsBatch,
  resumingCampaignIds,
  runningCampaignIds,
  stalledRecoveryBatch,
  stoppedUnarchivedCampaignIds,
} from './campaigns';
import {
  failOutboundTask,
  hasReachableChannel,
  isNotInterested,
  loadChatDoc,
  markTaskSkipped,
  stopsProactive,
} from './chat';
import { maxTasksPerTick, stalledSweepMax, taskLookbackMin } from '../config';
import { OUTREACH_TASK_TYPES, type DueTask, type TaskDoc } from '../types';

const OUTREACH_TASK_TYPE_SET: ReadonlySet<string> = new Set(
  OUTREACH_TASK_TYPES
);

/**
 * The signature the LLM phase supplies. Runs one task as an `@AI admin` turn and throws on failure,
 * which is what the cron's retry handler keys on.
 */
export type TurnRunner = (
  message: string,
  agentId: string,
  chatId: string
) => Promise<unknown>;

/**
 * The outbound-owned due-task fetch, overdue-safe.
 *
 * PERFORMANCE: the wide-lookback query can match thousands of tasks, and doing a per-task chat read
 * inside the result stream held the stream open for the whole loop, which blew the gRPC deadline. So
 * this (1) drains the query first, closing the stream fast, (2) dedups the parent chat refs and
 * BATCH-reads them, then (3) filters in memory. Same result, seconds rather than minutes.
 */
export async function filterDueOutboundTasks(
  window: number,
  lookbackMinutes: number
): Promise<DueTask[]> {
  const out: DueTask[] = [];
  try {
    const now = Date.now();
    const startTime = new Date(now - lookbackMinutes * 60_000);
    const endTime = new Date(now + window * 60_000);

    const snap = await db
      .collectionGroup('tasks')
      .where('executed', '==', false)
      .where('execute_at', '>=', startTime)
      .where('execute_at', '<=', endTime)
      .get();

    // 1. Drain, with NO I/O in the loop. Collect the UNIQUE parent chat refs — many tasks share a chat.
    const pending: Array<{
      taskId: string;
      taskData: TaskDoc;
      chatPath: string;
      chatId: string;
    }> = [];
    const chatRefs = new Map<string, ReturnType<typeof db.doc>>();
    for (const task of snap.docs) {
      const chatRef = task.ref.parent.parent;
      if (chatRef === null) continue;
      pending.push({
        taskId: task.id,
        taskData: (task.data() ?? {}) as TaskDoc,
        chatPath: chatRef.path,
        chatId: chatRef.id,
      });
      chatRefs.set(chatRef.path, chatRef);
    }

    // 2. Batch-read the unique chat docs — a handful of round-trips, not one blocking read per task.
    const chatDocs = new Map<string, Record<string, unknown>>();
    const snaps = await getAllChunked([...chatRefs.values()]);
    for (const s of snaps) {
      chatDocs.set(s.ref.path, s.exists ? (s.data() ?? {}) : {});
    }

    // 3. Filter in memory against the fetched chat docs.
    for (const { taskId, taskData, chatPath, chatId } of pending) {
      const chatData = chatDocs.get(chatPath) ?? {};
      const status = chatData.status;
      if (status !== null && status !== undefined && status !== 'active') {
        continue; // paused / archived
      }
      if (chatData.type !== 'outbound') continue; // the inbound cron owns the rest

      out.push({
        task_id: taskId,
        chat_id: chatId,
        agent_id: String(chatData.agentId ?? ''),
        chat_type: String(chatData.type ?? ''),
        // Test tasks are prioritized to the front and bypass the cap, so E2E never waits on a backlog.
        record_type: String(
          chatData.record_type ??
            ((chatData.memory ?? {}) as Record<string, unknown>).record_type ??
            ''
        ),
        task_data: taskData,
      });
    }
  } catch (e) {
    console.error(`[OB CRON] filterDueOutboundTasks failed: ${e}`);
  }
  return out;
}

/** Oldest-first by `execute_at`. Unknown values sort last. */
function taskSortValue(t: DueTask): number {
  const ea = toDate(t.task_data?.execute_at);
  return ea === null ? Number.POSITIVE_INFINITY : ea.getTime();
}

async function resolveAgentId(
  chatId: string,
  taskData: TaskDoc | null | undefined
): Promise<string | null> {
  const td = taskData ?? {};
  const fromTask =
    td.agent_id ?? (td.data as Record<string, unknown> | undefined)?.agent_id;
  if (fromTask) return String(fromTask);

  const mem = (await getMemory(chatId)) ?? {};
  if (mem.agent_id) return String(mem.agent_id);

  try {
    const doc = await db.collection('chats').doc(chatId).get();
    return doc.exists ? String((doc.data() ?? {}).agentId ?? '') || null : null;
  } catch {
    return null;
  }
}

/**
 * The enrollment worker step: advance each `enrolling` campaign by one bounded batch, and each stopped
 * campaign's archive sweep. Bounded per tick, so enrollment never floods one invocation; a large
 * audience drains over successive ticks.
 */
async function advanceEnrollingCampaigns(): Promise<void> {
  try {
    const cids = await enrollingCampaignIds(5);
    for (const cid of cids) {
      try {
        await enrollCampaignBatch(cid);
      } catch (e) {
        console.warn(`[OB CRON] campaign ${cid} enrollment step failed: ${e}`);
      }
    }
    if (cids.length) {
      console.log(`[OB CRON] advanced ${cids.length} enrolling campaign(s)`);
    }

    const sids = await stoppedUnarchivedCampaignIds(5);
    for (const cid of sids) {
      try {
        await archiveCampaignBatch(cid);
      } catch (e) {
        console.warn(`[OB CRON] campaign ${cid} archive step failed: ${e}`);
      }
    }
    if (sids.length) {
      console.log(
        `[OB CRON] advanced archive sweep for ${sids.length} stopped campaign(s)`
      );
    }
  } catch (e) {
    console.warn(`[OB CRON] campaign worker step skipped: ${e}`);
  }
}

/** The pause/resume chat cascade step. Bounded per tick. */
async function advancePausingCampaigns(): Promise<void> {
  try {
    for (const cid of await pausingCampaignIds(5)) {
      try {
        await pauseCampaignChatsBatch(cid);
      } catch (e) {
        console.warn(
          `[OB CRON] campaign ${cid} pause-cascade step failed: ${e}`
        );
      }
    }
    for (const cid of await resumingCampaignIds(5)) {
      try {
        await resumeCampaignChatsBatch(cid);
      } catch (e) {
        console.warn(
          `[OB CRON] campaign ${cid} resume-cascade step failed: ${e}`
        );
      }
    }
  } catch (e) {
    console.warn(`[OB CRON] pause/resume cascade step skipped: ${e}`);
  }
}

/** The stalled-chat recovery step, spread across running campaigns and bounded per tick. */
async function advanceStalledChats(): Promise<void> {
  try {
    const perCampaign = Math.max(1, Math.floor(stalledSweepMax() / 5));
    for (const cid of await runningCampaignIds(5)) {
      try {
        await stalledRecoveryBatch(cid, perCampaign);
      } catch (e) {
        console.warn(
          `[OB CRON] campaign ${cid} stalled-recovery step failed: ${e}`
        );
      }
    }
  } catch (e) {
    console.warn(`[OB CRON] stalled-recovery step skipped: ${e}`);
  }
}

export interface CronResult {
  success: boolean;
  processed: number;
  failed: number;
  due: number;
  deferred: number;
  /** `{}` when the summary itself faulted — a summary fault never breaks the tick. */
  email_summary: DailySummary | Record<string, never>;
}

export interface CronOptions {
  window?: number;
  /** Supplied by the LLM phase. See the module docstring. */
  runTurn: TurnRunner;
}

/** Run all due outbound tasks within the window, and advance every campaign sweep once per tick. */
export async function processOutboundTasks(
  opts: CronOptions
): Promise<CronResult> {
  const { window = 2, runTurn } = opts;

  await advanceEnrollingCampaigns();
  await advancePausingCampaigns();

  // Voice-concurrency self-heal, so a dropped completion webhook cannot wedge capacity.
  try {
    await reconcileVoiceSlots();
  } catch (e) {
    console.warn(`[OB CRON] voice-slot reconcile skipped: ${e}`);
  }

  // Chat review / stalled recovery runs BEFORE the global stale-call sweep, so the deterministic
  // review — not a generic resume — handles the stuck-call case for campaign chats.
  await advanceStalledChats();

  // The global stale-call fallback, mainly for non-campaign chats the review does not sweep.
  try {
    await reconcileStalePendingCalls();
  } catch (e) {
    console.warn(`[OB CRON] stale-call reconcile skipped: ${e}`);
  }

  let tasks = await filterDueOutboundTasks(window, taskLookbackMin());

  // Drop tasks belonging to PAUSED campaigns — a pause halts queued outreach, not just enrollment.
  // Filtered BEFORE the per-tick cap so a paused campaign's backlog cannot starve active ones.
  try {
    const paused = await pausedCampaignIds();
    if (paused.size > 0) {
      const campaignOf = (t: DueTask): string | undefined => {
        const td = t.task_data ?? {};
        const cid =
          td.campaign_id ??
          (td.data as Record<string, unknown> | undefined)?.campaign_id;
        return cid ? String(cid) : undefined;
      };
      const before = tasks.length;
      tasks = tasks.filter((t) => {
        const cid = campaignOf(t);
        return !(cid && paused.has(cid));
      });
      if (tasks.length !== before) {
        console.log(
          `[OB CRON] skipped ${before - tasks.length} task(s) from paused campaign(s)`
        );
      }
    }
  } catch (e) {
    console.warn(`[OB CRON] paused-campaign filter skipped: ${e}`);
  }

  tasks.sort((a, b) => taskSortValue(a) - taskSortValue(b));

  // ONE TASK PER CHAT PER TICK — see the module docstring, layer 2.
  const seenChats = new Set<string>();
  const collapsed: DueTask[] = [];
  let sameChatDeferred = 0;
  for (const t of tasks) {
    const cid = t.chat_id;
    if (cid && seenChats.has(cid)) {
      sameChatDeferred += 1;
      continue;
    }
    if (cid) seenChats.add(cid);
    collapsed.push(t);
  }
  if (sameChatDeferred) {
    console.log(
      `[OB CRON] per-chat serialization: deferred ${sameChatDeferred} extra same-chat ` +
        `task(s) to a later tick (${collapsed.length} distinct chat(s) this tick)`
    );
  }

  const due = collapsed.length;

  const isPriority = (t: DueTask): boolean =>
    String(t.record_type ?? '')
      .trim()
      .toLowerCase() === 'test' || Boolean(t.task_data?.admin_override);

  const prioTasks = collapsed.filter(isPriority);
  let realTasks = collapsed.filter((t) => !isPriority(t));

  const cap = maxTasksPerTick();
  let deferred = 0;
  if (realTasks.length > cap) {
    deferred = realTasks.length - cap;
    realTasks = realTasks.slice(0, cap);
    console.log(
      `[OB CRON] capped: processing ${cap} of ${realTasks.length + deferred} capped tasks; ` +
        `${deferred} deferred (+${prioTasks.length} priority task(s) run uncapped, front of queue)`
    );
  }

  const runnable = [...prioTasks, ...realTasks];
  console.log(
    `[OB CRON] ${due} outbound task(s) due; running ${runnable.length} ` +
      `(${prioTasks.length} priority, ${realTasks.length} capped)`
  );

  /** Run one task. `true` on success, `false` on failure, `null` for neither. */
  const runOne = async (task: DueTask): Promise<boolean | null> => {
    const chatId = task.chat_id;
    const taskId = task.task_id;
    const td = task.task_data ?? {};
    const notes =
      td.notes ?? (td.data as Record<string, unknown> | undefined)?.notes ?? '';

    const agentId = await resolveAgentId(chatId, td);
    if (!agentId) {
      console.warn(
        `[OB CRON] no agent_id for chat=${chatId} task=${taskId}; skipping`
      );
      return null;
    }

    // The atomic dispatch-once claim — layer 3.
    let claimed = false;
    if (dispatchClaimEnabled()) {
      if (!(await claimTask(chatId, taskId))) {
        console.log(
          `[OB CRON] chat=${chatId} task=${taskId}: not claimed (another pass owns it) — skip.`
        );
        return null;
      }
      claimed = true;
    }

    // The deterministic reachability backstop, for chats predating the gate keys.
    try {
      const doc = await loadChatDoc(chatId);
      if (doc && stopsProactive(doc)) {
        const why = isNotInterested(doc)
          ? 'not_interested'
          : 'referral_transferred';
        console.log(
          `[OB CRON] chat=${chatId} task=${taskId}: ${why} — skipping (not run).`
        );
        await markTaskSkipped(chatId, taskId, why);
        return null;
      }
      // Fail-open if the doc could not be read.
      if (doc && Object.keys(doc).length > 0 && !hasReachableChannel(doc)) {
        console.log(
          `[OB CRON] chat=${chatId} task=${taskId}: no reachable channel ` +
            `(all opted out) — skipping (not run).`
        );
        await markTaskSkipped(chatId, taskId, 'channel_opted_out');
        return null;
      }
    } catch (e) {
      console.warn(`[OB CRON] reachability gate skipped chat=${chatId}: ${e}`);
    }

    // The TASK-LEVEL business-hours pre-gate. Test records and human overrides bypass it.
    const taskType = String(
      td.type ?? (td.data as Record<string, unknown> | undefined)?.type ?? ''
    );
    if (OUTREACH_TASK_TYPE_SET.has(taskType) && !td.admin_override) {
      try {
        const mem = (await getMemory(chatId)) ?? {};
        if (
          String(mem.record_type ?? '')
            .trim()
            .toLowerCase() !== 'test'
        ) {
          const blocked = checkBusinessHours(mem.phone_number ?? '', mem);
          if (blocked.timezone !== null) {
            const newAt = await nextBusinessHoursStart(
              mem.timezone,
              null,
              chatId
            );
            // The claim already stamped executed; reset it so the morning tick re-dispatches.
            await updateTask(chatId, taskId, {
              execute_at: newAt,
              executed: false,
              dispatched_at: null,
            });
            console.log(
              `[OB CRON] chat=${chatId} task=${taskId} (${taskType}): outside business ` +
                `hours — rescheduled to ${newAt.toISOString()} at TASK level (no LLM turn, no chat msg).`
            );
            return null;
          }
        }
      } catch (e) {
        console.warn(
          `[OB CRON] business-hours pre-gate skipped chat=${chatId}: ${e}`
        );
      }
    }

    const message = `@AI This is your admin. Execute the task based on notes: ${String(notes)}`;
    try {
      await runTurn(message, agentId, chatId);
      // The claim already set executed. Only the kill-switch-off path needs the post-turn mark.
      if (!claimed) await updateTaskStatus(chatId, taskId, true);
      return true;
    } catch (e) {
      console.error(`[OB CRON] task ${taskId} (chat ${chatId}) failed: ${e}`);
      // The ONLY retry the cron owns: a 10→20→40-minute backoff, and because the claim marked the
      // task executed up front, a retriable failure is reopened so the backoff tick re-selects it.
      await failOutboundTask(chatId, taskId, String(e), claimed);
      return false;
    }
  };

  let processed = 0;
  let failed = 0;
  if (runnable.length > 0) {
    const results = await runWithConcurrency(
      runnable.map((t) => () => runOne(t)),
      Math.min(cap, runnable.length)
    );
    for (const r of results) {
      if (r === true) processed += 1;
      else if (r === false) failed += 1;
    }
  }

  // The email daily summary: sent, deferred-by-cause, skipped-by-reason, breaker state, and the
  // per-domain effective ramp cap — with the oversubscription WARN inside `emailDailySummary`.
  // Best-effort, because a summary fault must never break the tick.
  let emailSummary: DailySummary | Record<string, never> = {};
  try {
    emailSummary = await emailDailySummary();
    console.log(`[OB CRON][EMAIL SUMMARY] ${JSON.stringify(emailSummary)}`);
  } catch (e) {
    console.warn(`[OB CRON] email summary failed (non-blocking): ${e}`);
  }

  return {
    success: true,
    processed,
    failed,
    due,
    deferred,
    email_summary: emailSummary,
  };
}
