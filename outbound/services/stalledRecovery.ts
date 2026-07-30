/**
 * Stalled-chat recovery — the safety net that stops the skill-driven cadence silently dropping chats,
 * plus the call-lifecycle reconciliation it is mutually dependent with.
 *
 * A chat is STALLED when its cadence is not finished but it has NO pending proactive task queued —
 * the skill forgot to schedule the next touch, or a turn errored. This module reconciles such a chat
 * deterministically and also collapses any chat that ends up with >1 pending proactive task back to
 * exactly one, which is the backstop for the ≤1-proactive invariant.
 *
 * ## Why `finalizeUnresolvedCall` lives here and not in `services/chat`
 *
 * The source has it in `services/chat.py`, but it calls `ensure_next_step_after_call` from this
 * module, while `review_chat` here calls it back — a module-level cycle the source breaks with lazy
 * imports inside function bodies. Co-locating the two halves removes the cycle outright rather than
 * reproducing it. `chat.ts` keeps the pure predicate `callAwaitingReview` that both rely on.
 *
 * ## Two fail directions, opposite on purpose
 *
 * `hasAnyPendingTask` fails **CLOSED** — a read error reports "a task exists", so a transient fault
 * cannot be mistaken for an idle chat and fire a spurious review. `recoverOrCollapseChat`'s gates
 * otherwise fail open, because a safety net that throws stops all recovery.
 *
 * The grace window matters for the same reason: a chat is not "stalled" until it has been quiet for
 * it, so recovery never races a task that just fired and whose turn has not yet scheduled the next
 * touch.
 */

import { FieldValue, db, toDate } from '../firebase/db';
import {
  createTaskWithId,
  deletePendingCall,
  deleteUnexecutedTasksByType,
  getMemory,
  setMemory,
} from '../firebase/chat';
import {
  PROACTIVE_TASK_TYPES,
  enforceSingleProactiveTask,
  nextBusinessHoursStart,
} from './scheduling';
import { releaseVoiceSlot } from './voiceConcurrency';
import {
  reviewChatEnabled,
  stalePendingCallMin,
  stalledGraceMin,
  maxCallFollowups,
  maxEmailFollowups,
} from '../config';
import * as svc from './chat';
import type { ChatDoc, ChatMemory, TaskDoc } from '../types';

const RESUME_NOTES =
  'SAFETY-NET RESUME: this chat has NO scheduled next step but its cadence is not complete. From the ' +
  "chat's email/call follow-up counters, determine and schedule the ACTUAL next cadence step per your " +
  'outbound skill (email follow-ups at +1/+3/+5/+7 from the first email; phone at day 0/+1/+3/+5/+7 ' +
  'with a ~2h retry, max 2 calls/day). Schedule exactly ONE next task. If the cadence is already fully ' +
  'exhausted with no reply, call mark_cadence_complete instead of scheduling anything.';

function chatRef(chatId: string) {
  return db.collection('chats').doc(chatId);
}

/** Parse an ISO stamp, treating a zone-less value as UTC. Mirrors the chat module's reader. */
function parseIso(val: unknown): Date | null {
  if (!val) return null;
  try {
    let s = String(val).replace('Z', '+00:00');
    if (!/(?:[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** `[taskId, executeAt]` for every pending, non-terminal proactive task. */
async function pendingProactive(
  chatId: string
): Promise<Array<[string, Date | null]>> {
  const out: Array<[string, Date | null]> = [];
  try {
    const snap = await chatRef(chatId)
      .collection('tasks')
      .where('type', 'in', [...PROACTIVE_TASK_TYPES])
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      const td = (t.data() ?? {}) as TaskDoc;
      if (td.skipped || td.permanent_failure) continue;
      out.push([t.id, toDate(td.execute_at)]);
    }
  } catch (e) {
    console.warn(
      `[OB STALLED] pending-proactive query failed chat=${chatId}: ${e}`
    );
  }
  return out;
}

/**
 * True if the chat has ANY pending task of ANY type — proactive or operational.
 *
 * This is the "no review in flight AND no scheduled work" gate. A pending operational task
 * (`check_if_call_succeeded`, `call_completion_continuation`, `reminder`, `book_meeting`) means a
 * review is scheduled or in flight and already owns closing the loop, so the deterministic review
 * must not also fire.
 *
 * Fails CLOSED: a read error assumes a task exists, so a bad read never triggers a spurious review.
 */
async function hasAnyPendingTask(chatId: string): Promise<boolean> {
  try {
    const snap = await chatRef(chatId)
      .collection('tasks')
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      const td = (t.data() ?? {}) as TaskDoc;
      if (td.skipped || td.permanent_failure) continue;
      return true;
    }
  } catch (e) {
    console.warn(`[OB STALLED] pending-task query failed chat=${chatId}: ${e}`);
    return true; // fail-CLOSED
  }
  return false;
}

/** The most-recent outreach timestamp on the chat, or `null`. */
async function lastActivity(memory: ChatMemory): Promise<Date | null> {
  const stamps = [
    '_last_outbound_call_at',
    '_first_outbound_call_at',
    '_first_outbound_email_at',
    '_last_call_reviewed_at',
  ].map((k) => parseIso(memory[k]));
  stamps.push(parseIso(await svc.contactedMarkerValue(memory)));
  const live = stamps.filter((t): t is Date => t !== null);
  if (live.length === 0) return null;
  return new Date(Math.max(...live.map((t) => t.getTime())));
}

export interface RecoverResult {
  recovered?: boolean;
  collapsed?: boolean;
  cadence_complete?: boolean;
  email_fallback?: boolean;
  killed_stale_call?: boolean;
  next_task?: string | null;
  resume_task?: string | null;
}

/**
 * The per-chat safety net.
 *
 * Applies the same exclusions the cron does — non-active status, a proactive-stop label, fully opted
 * out, terminal stage, cadence complete — then either collapses a multi-task chat or, for a chat with
 * zero pending work, hands off to the deterministic review.
 *
 * Only recovers a chat whose cadence has already STARTED. A never-contacted chat is enrollment's job,
 * not recovery's.
 */
export async function recoverOrCollapseChat(
  chatId: string,
  chatData: ChatDoc | null | undefined,
  campaignId?: string | null
): Promise<RecoverResult> {
  const d = chatData ?? {};
  if (d.status !== null && d.status !== undefined && d.status !== 'active') {
    return {};
  }
  if (
    svc.stopsProactive(d) ||
    !svc.hasReachableChannel(d) ||
    svc.isTerminalStage(d) ||
    svc.isCadenceComplete(d)
  ) {
    return {};
  }

  const pend = await pendingProactive(chatId);
  if (pend.length > 1) {
    // Collapse to the SOONEST-due — the imminent next touch — and delete the rest. A null execute_at
    // sorts last, since it cannot be the imminent one.
    const sorted = [...pend].sort((a, b) => {
      const av = a[1]?.getTime();
      const bv = b[1]?.getTime();
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return av - bv;
    });
    const keep = sorted[0][0];
    await enforceSingleProactiveTask(chatId, keep);
    console.log(
      `[OB STALLED] collapsed ${pend.length}→1 proactive tasks for chat=${chatId} (kept ${keep})`
    );
    return { collapsed: true };
  }
  if (pend.length === 1) return {}; // healthy — exactly one next touch queued

  if (await hasAnyPendingTask(chatId)) return {};

  const m = (await getMemory(chatId)) ?? d.memory ?? {};
  if (!(await svc.contactedMarkerValue(m))) return {};

  const last = await lastActivity(m);
  if (
    last !== null &&
    Date.now() - last.getTime() < stalledGraceMin() * 60_000
  ) {
    return {}; // within grace — likely mid-turn, do not race a just-fired task
  }

  return reviewChat(chatId, d, m, campaignId ?? d.campaign_id);
}

/**
 * The DETERMINISTIC per-chat reconcile — the improved safety net, with no LLM decision turn.
 *
 * Three steps:
 *  1. KILL a stale in-progress call loop (placed, awaiting review, past the stale threshold) by
 *     finalizing it as a no-answer, which flips the card, unblocks the dial guard, releases the voice
 *     slot and cancels the watchdog.
 *  2. DECIDE continue-versus-complete from the follow-up counters. Exhausted → mark complete, unless
 *     a test phone-first chat still has its email fallback, in which case flip the lane instead.
 *  3. SCHEDULE the ONE correct next typed outreach task, channel taken from the lane, with a
 *     code-computed "attempt #n of m" note.
 *
 * The scheduled task still fires an LLM turn to actually place the call or send the email — only the
 * review decision here is deterministic. The kill-switch falls back to the legacy generic resume.
 */
export async function reviewChat(
  chatId: string,
  chatData: ChatDoc | null | undefined,
  memory?: ChatMemory | null,
  campaignId?: string | null
): Promise<RecoverResult> {
  const d = chatData ?? {};
  let m =
    memory !== null && memory !== undefined
      ? memory
      : ((await getMemory(chatId)) ?? d.memory ?? {});

  if (!reviewChatEnabled()) {
    const agentId = String(d.agentId ?? m.agent_id ?? '');
    const tid = await scheduleResume(
      chatId,
      m,
      agentId,
      campaignId,
      'stalled_recovery'
    );
    return { recovered: true, resume_task: tid };
  }

  const result: RecoverResult = {};

  // 1. Kill a stale in-progress call loop so it stops blocking the dial guard.
  if (svc.callAwaitingReview(m)) {
    const lastCall = parseIso(m._last_outbound_call_at);
    const isStale =
      lastCall !== null &&
      Date.now() - lastCall.getTime() >= stalePendingCallMin() * 60_000;
    if (isStale) {
      const callId = await svc.findInProgressCallId(chatId);
      await finalizeUnresolvedCall(chatId, {
        callId,
        reason: 'review_chat-stale-call',
        asUnanswered: true,
        scheduleNext: false, // this function owns scheduling the specific next step below
      });
      result.killed_stale_call = true;
      m = (await getMemory(chatId)) ?? m; // refresh — finalize bumped call_followup_count
    }
  }

  const agentId = String(d.agentId ?? m.agent_id ?? '');

  // 2. Cadence exhausted for the lane's channel.
  if (svc.cadenceExhausted(m, d)) {
    if (svc.shouldFallbackToEmail(m, d)) {
      const tid = await fallbackToEmailLane(chatId, m, agentId, campaignId);
      console.log(
        `[OB REVIEW_CHAT] chat=${chatId} phone cadence spent, no engagement — fell back to ` +
          `EMAIL lane (scheduled ${tid})`
      );
      result.email_fallback = true;
      result.next_task = tid;
      return result;
    }
    try {
      await svc.setCadenceComplete(chatId, 'cadence_exhausted');
      await enforceSingleProactiveTask(chatId, null); // clear any stragglers
    } catch (e) {
      console.warn(
        `[OB REVIEW_CHAT] mark-complete failed chat=${chatId}: ${e}`
      );
    }
    console.log(
      `[OB REVIEW_CHAT] chat=${chatId} cadence exhausted — marked complete`
    );
    result.cadence_complete = true;
    return result;
  }

  // 3. Schedule the ONE correct next typed step.
  const lane = String(m._outreach_lane ?? '')
    .trim()
    .toLowerCase();
  const channel = lane === 'phone' ? 'phone' : 'email';
  const tid = await scheduleChannelStep(
    chatId,
    m,
    agentId,
    campaignId,
    channel
  );
  console.log(
    `[OB REVIEW_CHAT] chat=${chatId} lane=${lane || 'email'} scheduled next step ${tid}`
  );
  result.recovered = true;
  result.next_task = tid;
  return result;
}

/**
 * Schedule ONE channel-tagged next touch, business-hours clamped, carrying a code-computed
 * "attempt #n of m" note the skill follows, then hold the ≤1-proactive invariant.
 */
async function scheduleChannelStep(
  chatId: string,
  m: ChatMemory,
  agentId: string,
  campaignId: string | null | undefined,
  channel: 'phone' | 'email',
  perChannel = false
): Promise<string | null> {
  let notes: string;
  if (channel === 'phone') {
    const n = Number(m.call_followup_count ?? 0) + 1;
    notes =
      `REVIEW_CHAT RESUME: place call attempt #${n} of ${maxCallFollowups()} per your outbound ` +
      `skill (the prior attempt got no answer / did not connect). Schedule exactly ONE next call; ` +
      `if the call cadence is exhausted call mark_cadence_complete.`;
  } else {
    const n = Number(m.email_followup_count ?? 0) + 1;
    notes =
      `REVIEW_CHAT RESUME: send email follow-up #${n} of ${maxEmailFollowups()} to re-engage ` +
      `(no reply since the last touch) per your outbound skill. Schedule exactly ONE next email; ` +
      `if the email cadence is exhausted call mark_cadence_complete.`;
  }

  const executeAt = await nextBusinessHoursStart(m.timezone, m.state, chatId);
  const tid = await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
    task_type: 'outbound_outreach',
    notes,
    agent_id: agentId,
    account_id: agentId,
    campaign_id: campaignId ? String(campaignId) : null,
    task_source: 'review_chat',
    channel,
  });
  await enforceSingleProactiveTask(chatId, tid, perChannel);
  return tid;
}

/**
 * TEST phone-first → EMAIL fallback. The phone cadence is exhausted with NO engagement, so flip the
 * lane and start the cold email cadence.
 *
 * Clears the fallback flag (fire-once — it must never loop), resets the follow-up counters so the
 * email cadence starts fresh at #1, clears any cadence-complete marker that slipped in, and schedules
 * the ONE first email touch. Called only when `shouldFallbackToEmail` is true.
 */
export async function fallbackToEmailLane(
  chatId: string,
  m: ChatMemory,
  agentId: string,
  campaignId?: string | null
): Promise<string | null> {
  try {
    await chatRef(chatId).set(
      { outreach_lane: 'email', email_fallback_available: false },
      { merge: true }
    );
    await setMemory(chatId, {
      _outreach_lane: 'email',
      _email_fallback_available: false,
    });
  } catch (e) {
    console.warn(
      `[OB REVIEW_CHAT] lane flip phone→email failed chat=${chatId}: ${e}`
    );
  }
  try {
    await svc.resetFollowupCounts(chatId);
    await svc.clearCadenceComplete(chatId);
  } catch (e) {
    console.warn(
      `[OB REVIEW_CHAT] fallback counter reset failed chat=${chatId}: ${e}`
    );
  }
  // A local memory view reflecting the flip, so the scheduled step is framed as email attempt #1.
  const flipped: ChatMemory = {
    ...m,
    _outreach_lane: 'email',
    call_followup_count: 0,
    email_followup_count: 0,
  };
  return scheduleChannelStep(chatId, flipped, agentId, campaignId, 'email');
}

/**
 * Create ONE generic resume task whose notes tell the skill to work out the real next cadence step.
 * The legacy path, used when the deterministic review is switched off.
 */
async function scheduleResume(
  chatId: string,
  m: ChatMemory,
  agentId: string,
  campaignId: string | null | undefined,
  source: string
): Promise<string | null> {
  const executeAt = await nextBusinessHoursStart(m.timezone, m.state, chatId);
  const tid = await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
    task_type: 'outbound_outreach',
    notes: RESUME_NOTES,
    agent_id: agentId,
    account_id: agentId,
    campaign_id: campaignId ? String(campaignId) : null,
    task_source: source,
  });
  await enforceSingleProactiveTask(chatId, tid);
  return tid;
}

/**
 * Schedule the next cadence step NOW, with no grace window, when a chat has no pending proactive task
 * and is recoverable.
 *
 * Used right after a stale call is finalized: `finalizeUnresolvedCall` stamps
 * `_last_call_reviewed_at`, which would otherwise reset the stalled-recovery grace and delay the
 * resume by the whole grace window — the "no task scheduled" gap. The per-chat dial-recency floor
 * still prevents a tight re-dial loop.
 */
export async function ensureNextStepAfterCall(
  chatId: string,
  chatData?: ChatDoc | null
): Promise<boolean> {
  try {
    let d = chatData;
    if (d === null || d === undefined) {
      const snap = await chatRef(chatId).get();
      d = snap.exists ? ((snap.data() ?? {}) as ChatDoc) : {};
    }
    if (d.status !== null && d.status !== undefined && d.status !== 'active') {
      return false;
    }
    if (
      svc.stopsProactive(d) ||
      !svc.hasReachableChannel(d) ||
      svc.isTerminalStage(d) ||
      svc.isCadenceComplete(d)
    ) {
      return false;
    }
    if ((await pendingProactive(chatId)).length > 0) return false; // do not stack

    const m = (await getMemory(chatId)) ?? d.memory ?? {};
    if (!(await svc.contactedMarkerValue(m))) return false; // enrollment's job, not recovery's

    const agentId = String(d.agentId ?? m.agent_id ?? '');
    const tid = await scheduleResume(
      chatId,
      m,
      agentId,
      d.campaign_id,
      'call_finalize_resume'
    );
    console.log(
      `[OB STALLED] scheduled next step after stale-call finalize chat=${chatId} task=${tid}`
    );
    return true;
  } catch (e) {
    console.warn(
      `[OB STALLED] ensureNextStepAfterCall failed chat=${chatId}: ${e}`
    );
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Call-lifecycle reconciliation
//
// In the source these live in `services/chat.py`. They are here because they are mutually dependent
// with `ensureNextStepAfterCall` above; see the module docstring.
// ─────────────────────────────────────────────────────────────────────────────

export interface FinalizeOptions {
  callId?: string | null;
  reason?: string;
  /**
   * Treat the call as NOT answered. A "not found at the provider" call means no conversation was ever
   * materialized, i.e. the call did not connect — so the no-answer cadence handling is the correct
   * one, and the call follow-up count must be bumped for it.
   */
  asUnanswered?: boolean;
  /**
   * Schedule the next cadence step immediately. Callers that own scheduling themselves (the review)
   * pass `false`, so this does not also queue a generic resume.
   */
  scheduleNext?: boolean;
}

/**
 * Deterministically finalize a placed call that never completed — no post-call webhook arrived and
 * its transcript cannot be fetched.
 *
 * Without this the chat is frozen by the dial guard's awaiting-review block and the `in_progress`
 * card sits stale forever. Every step is idempotent and independently wrapped:
 *  - stamp `_last_call_reviewed_at`, which clears the awaiting-review dial block, and record the call
 *    id in `_reviewed_call_ids` so a late duplicate review no-ops;
 *  - when unanswered, stamp `_last_call_unanswered_at` and bump the call follow-up count;
 *  - flip the `activities` and `messages` cards from `in_progress` to `failed`;
 *  - release the voice slot, in case the TTL has not already;
 *  - cancel the dangling watchdog task;
 *  - post a visible note so the resolution is explained in the thread;
 *  - schedule the next cadence step.
 *
 * Never throws.
 */
export async function finalizeUnresolvedCall(
  chatId: string,
  opts: FinalizeOptions = {}
): Promise<boolean> {
  const {
    callId = null,
    reason = 'no-completion',
    asUnanswered = true,
    scheduleNext = true,
  } = opts;
  if (!chatId) return false;

  try {
    const nowIso = new Date().toISOString();
    const upd: Record<string, unknown> = {
      'memory._last_call_reviewed_at': nowIso,
    };
    if (asUnanswered) upd['memory._last_call_unanswered_at'] = nowIso;
    if (callId) {
      upd['memory._reviewed_call_ids'] = FieldValue.arrayUnion(callId);
    }
    await chatRef(chatId).update(upd);

    if (asUnanswered) {
      try {
        await svc.bumpFollowupCount(chatId, 'call');
      } catch {
        // The cadence count is important but must not abort the rest of the finalize.
      }
    }

    if (callId) {
      const msg =
        'No answer / call not connected — no conversation was created. Attempt marked resolved.';
      try {
        await svc.markCallCompletedInActivities(chatId, callId, msg, 'failed');
        await svc.markCallCompletedInMessages(chatId, callId, msg, 'failed');
      } catch (e) {
        console.warn(
          `[OB] finalizeUnresolvedCall card flip failed chat=${chatId}: ${e}`
        );
      }
    }

    try {
      await releaseVoiceSlot(chatId);
    } catch {
      // The slot TTL self-heals if this fails.
    }
    try {
      await deleteUnexecutedTasksByType(chatId, 'check_if_call_succeeded');
    } catch {
      // A dangling watchdog is harmless once the chat is marked reviewed.
    }
    try {
      const cid = (callId ?? '').slice(0, 24);
      await svc.logInternalNote(
        chatId,
        `⚠️ Call ${cid || '(no id)'} was not answered / never connected ` +
          `(${reason}) — no conversation on record. Marking the attempt resolved ` +
          `so outreach can continue.`
      );
    } catch {
      // Presentation only.
    }

    if (scheduleNext) {
      try {
        await ensureNextStepAfterCall(chatId);
      } catch (e) {
        console.warn(
          `[OB] finalize next-step schedule skipped chat=${chatId}: ${e}`
        );
      }
    }

    console.log(
      `[OB] finalized unresolved call chat=${chatId} call=${callId} reason=${reason} ` +
        `as_unanswered=${asUnanswered} schedule_next=${scheduleNext}`
    );
    return true;
  } catch (e) {
    console.warn(`[OB] finalizeUnresolvedCall failed chat=${chatId}: ${e}`);
    return false;
  }
}

export interface ReconcileResult {
  scanned: number;
  finalized: number;
  skipped: number;
  older_than_min?: number;
  dry_run?: boolean;
  error?: string;
}

/**
 * Sweep `pending_calls` for OUTBOUND calls placed but never completed, and finalize each.
 *
 * The webhook deletes the document on completion, so a lingering one past the threshold means no
 * completion signal ever arrived. `pending_calls` is shared with inbound, so only documents whose
 * chat is `type == "outbound"` are touched. A finalized document is deleted so it is not re-swept — a
 * late webhook falls back to the durable conversation-id index, and the review is idempotent.
 *
 * A chat that is NOT awaiting review is already resolved, so its stale document is just cleaned up.
 */
export async function reconcileStalePendingCalls(
  olderThanMin?: number | null,
  maxScan = 200,
  dryRun = false
): Promise<ReconcileResult> {
  const older =
    olderThanMin === null || olderThanMin === undefined
      ? stalePendingCallMin()
      : Math.trunc(olderThanMin);
  const cutoff = new Date(Date.now() - older * 60_000);

  let scanned = 0;
  let finalized = 0;
  let skipped = 0;

  let docs;
  try {
    const snap = await db
      .collection('pending_calls')
      .where('created_at', '<', cutoff)
      .limit(maxScan)
      .get();
    docs = snap.docs;
  } catch (e) {
    console.warn(`[OB] reconcileStalePendingCalls query failed: ${e}`);
    return { scanned: 0, finalized: 0, skipped: 0, error: String(e) };
  }

  for (const doc of docs) {
    scanned += 1;
    const d = doc.data() ?? {};
    const chatId = d.chat_id as string | undefined;
    const callId = doc.id;
    if (!chatId) continue;

    let cd: ChatDoc = {};
    try {
      const chatDoc = await chatRef(chatId).get();
      cd = chatDoc.exists ? ((chatDoc.data() ?? {}) as ChatDoc) : {};
    } catch {
      cd = {};
    }

    if (cd.type !== 'outbound') {
      // Outbound-owned sweep; leave inbound's pending calls alone.
      skipped += 1;
      continue;
    }

    if (!svc.callAwaitingReview(cd.memory ?? {})) {
      // Already resolved — just clean up the document.
      skipped += 1;
      if (!dryRun) {
        try {
          await deletePendingCall(callId);
        } catch {
          // Best-effort cleanup.
        }
      }
      continue;
    }

    if (dryRun) {
      console.log(
        `[OB] [dry] would finalize stale call ${callId} chat=${chatId}`
      );
      finalized += 1;
      continue;
    }

    if (
      await finalizeUnresolvedCall(chatId, {
        callId,
        reason: 'stale-pending-call',
      })
    ) {
      finalized += 1;
      try {
        await deletePendingCall(callId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  console.log(
    `[OB] reconcileStalePendingCalls: scanned=${scanned} finalized=${finalized} ` +
      `skipped=${skipped} older_than_min=${older} dry_run=${dryRun}`
  );
  return {
    scanned,
    finalized,
    skipped,
    older_than_min: older,
    dry_run: dryRun,
  };
}
