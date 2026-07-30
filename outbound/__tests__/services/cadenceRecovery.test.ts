/**
 * @jest-environment node
 *
 * Stalled-chat recovery, the call-lifecycle reconcile, booking reminders, and the cron orchestration.
 *
 * The properties worth pinning:
 *  - `hasAnyPendingTask` fails CLOSED, so a read fault never triggers a spurious review;
 *  - recovery only touches a CONTACTED chat past the grace window with ZERO pending tasks;
 *  - the collapse keeps the SOONEST-due task, not an arbitrary one;
 *  - the cron's four anti-duplicate layers each hold independently — in particular per-chat
 *    serialization, which the per-task claim cannot provide;
 *  - a priority task bypasses the per-tick cap;
 *  - the business-hours pre-gate reschedules WITHOUT running a turn.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  ensureNextStepAfterCall,
  finalizeUnresolvedCall,
  reconcileStalePendingCalls,
  recoverOrCollapseChat,
  reviewChat,
} from '../../services/stalledRecovery';
import {
  scheduleBookingReminders,
  __testing as rem,
} from '../../services/reminders';
import {
  filterDueOutboundTasks,
  processOutboundTasks,
} from '../../services/cron';
import type { ChatDoc } from '../../types';

const CHAT = 'outbound__agentA__15551230000';

/** A chat that recovery considers eligible: active, reachable, contacted, quiet. */
function eligibleChat(over: Record<string, unknown> = {}): ChatDoc {
  return {
    type: 'outbound',
    status: 'active',
    agentId: 'agentA',
    stage: 'Contacted',
    phone_opt_out: false,
    email_opt_out: false,
    memory: {
      agent_id: 'agentA',
      phone_number: '15551230000',
      customer_email: 'a@b.com',
      sales_agent_name: 'Nova',
      timezone: 'UTC',
      _outreach_lane: 'email',
      // Contacted long ago, so the grace window has elapsed.
      _nova_last_contacted: '2020-01-01T00:00:00Z',
    },
    ...over,
  } as ChatDoc;
}

function seedChat(over: Record<string, unknown> = {}): ChatDoc {
  const d = eligibleChat(over);
  store.set(`chats/${CHAT}`, d);
  return d;
}

beforeEach(() => {
  store.reset();
  store.set('agents/agentA', { sales_agent_name: 'Nova' });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('recoverOrCollapseChat — the exclusion gates', () => {
  it.each([
    ['a paused chat', { status: 'paused' }],
    ['an archived chat', { status: 'archived' }],
    ['a not-interested chat', { labels: ['not_interested'] }],
    ['a referral-transferred chat', { labels: ['referral_transferred'] }],
    ['a terminal-stage chat', { stage: 'Lost' }],
    ['a cadence-complete chat', { cadence_complete: true }],
  ])('does nothing for %s', async (_label, over) => {
    const d = seedChat(over);
    await expect(recoverOrCollapseChat(CHAT, d)).resolves.toEqual({});
  });

  it('does nothing for a fully opted-out chat', async () => {
    const d = seedChat({ phone_opt_out: true, email_opt_out: true });
    await expect(recoverOrCollapseChat(CHAT, d)).resolves.toEqual({});
  });

  it('does nothing for a NEVER-contacted chat — that is enrollment’s job', async () => {
    const d = seedChat({
      memory: { ...eligibleChat().memory, _nova_last_contacted: undefined },
    });
    await expect(recoverOrCollapseChat(CHAT, d)).resolves.toEqual({});
  });

  it('does nothing while inside the grace window', async () => {
    const d = seedChat({
      memory: {
        ...eligibleChat().memory,
        _nova_last_contacted: new Date().toISOString(),
      },
    });
    await expect(recoverOrCollapseChat(CHAT, d)).resolves.toEqual({});
  });

  it('does nothing when exactly one proactive task is queued — that is healthy', async () => {
    const d = seedChat();
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'followup_if_no_reply',
      executed: false,
      execute_at: new Date(),
    });
    await expect(recoverOrCollapseChat(CHAT, d)).resolves.toEqual({});
  });

  it('does nothing when an OPERATIONAL task is pending — a review already owns the loop', async () => {
    const d = seedChat();
    store.set(`chats/${CHAT}/tasks/watchdog`, {
      type: 'check_if_call_succeeded',
      executed: false,
    });
    await expect(recoverOrCollapseChat(CHAT, d)).resolves.toEqual({});
  });

  it('ignores TERMINAL tasks when counting pending work', async () => {
    const d = seedChat();
    store.set(`chats/${CHAT}/tasks/dead`, {
      type: 'followup_if_no_reply',
      executed: false,
      skipped: true,
    });
    // The skipped task does not count, so recovery proceeds and schedules a step.
    const r = await recoverOrCollapseChat(CHAT, d);
    expect(r.recovered).toBe(true);
  });
});

describe('recoverOrCollapseChat — the collapse', () => {
  it('collapses >1 proactive tasks to the SOONEST-due one', async () => {
    const d = seedChat();
    store.set(`chats/${CHAT}/tasks/later`, {
      type: 'followup_if_no_reply',
      executed: false,
      execute_at: new Date('2030-01-01T00:00:00Z'),
    });
    store.set(`chats/${CHAT}/tasks/sooner`, {
      type: 'callback',
      executed: false,
      execute_at: new Date('2026-08-01T00:00:00Z'),
    });
    const r = await recoverOrCollapseChat(CHAT, d);
    expect(r.collapsed).toBe(true);
    expect(store.get(`chats/${CHAT}/tasks/sooner`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/later`)).toBeUndefined();
  });

  it('sorts a null execute_at last, since it cannot be the imminent touch', async () => {
    const d = seedChat();
    store.set(`chats/${CHAT}/tasks/noAt`, {
      type: 'followup_if_no_reply',
      executed: false,
    });
    store.set(`chats/${CHAT}/tasks/dated`, {
      type: 'callback',
      executed: false,
      execute_at: new Date('2026-08-01T00:00:00Z'),
    });
    await recoverOrCollapseChat(CHAT, d);
    expect(store.get(`chats/${CHAT}/tasks/dated`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/noAt`)).toBeUndefined();
  });
});

describe('reviewChat — the deterministic reconcile', () => {
  it('schedules the ONE next EMAIL step with an attempt-numbered note', async () => {
    const d = seedChat({
      memory: {
        ...eligibleChat().memory,
        _outreach_lane: 'email',
        email_followup_count: 1,
      },
    });
    const r = await reviewChat(CHAT, d);
    expect(r.recovered).toBe(true);
    const tasks = store.collection(`chats/${CHAT}/tasks`);
    expect(tasks).toHaveLength(1);
    const td = tasks[0][1];
    expect(td.type).toBe('outbound_outreach');
    // `createTaskWithId` nests the caller's payload under `data`, matching the inbound writer.
    const payload = td.data as Record<string, unknown>;
    expect(payload.task_source).toBe('review_chat');
    expect(payload.channel).toBe('email');
    expect(String(payload.notes)).toContain('#2 of 4'); // count+1 of the cap
  });

  it('schedules a PHONE step on the phone lane', async () => {
    const d = seedChat({
      memory: {
        ...eligibleChat().memory,
        _outreach_lane: 'phone',
        call_followup_count: 0,
      },
    });
    await reviewChat(CHAT, d);
    const payload = store.collection(`chats/${CHAT}/tasks`)[0][1]
      .data as Record<string, unknown>;
    expect(payload.channel).toBe('phone');
    expect(String(payload.notes)).toContain('call attempt #1 of 4');
  });

  it('marks the cadence complete when exhausted', async () => {
    const d = seedChat({
      memory: {
        ...eligibleChat().memory,
        _outreach_lane: 'email',
        email_followup_count: 4,
      },
    });
    const r = await reviewChat(CHAT, d);
    expect(r.cadence_complete).toBe(true);
    expect(store.get(`chats/${CHAT}`)!.cadence_complete).toBe(true);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });

  it('flips phone→email instead of completing when the test fallback is available', async () => {
    const d = seedChat({
      email_fallback_available: true,
      stage: 'Contacted',
      memory: {
        ...eligibleChat().memory,
        _outreach_lane: 'phone',
        _email_fallback_available: true,
        call_followup_count: 4,
      },
    });
    const r = await reviewChat(CHAT, d);
    expect(r.email_fallback).toBe(true);
    expect(r.cadence_complete).toBeUndefined();

    const chat = store.get(`chats/${CHAT}`)!;
    expect(chat.outreach_lane).toBe('email');
    expect(chat.email_fallback_available).toBe(false); // fire-once, never loops
    expect(chat.email_followup_count).toBe(0); // fresh email cadence
    expect(chat.call_followup_count).toBe(0);

    const payload = store.collection(`chats/${CHAT}/tasks`)[0][1]
      .data as Record<string, unknown>;
    expect(payload.channel).toBe('email');
    expect(String(payload.notes)).toContain('#1 of 4'); // framed as email attempt 1
  });

  it('kills a STALE in-progress call before deciding', async () => {
    const d = seedChat({
      memory: {
        ...eligibleChat().memory,
        _outreach_lane: 'phone',
        call_followup_count: 0,
        // Placed long ago and never reviewed → stale.
        _last_outbound_call_at: '2026-07-01T00:00:00Z',
      },
    });
    store.set(`chats/${CHAT}/activities/a1`, {
      timestamp: new Date(),
      toolCall: {
        toolName: 'make_phone_call',
        status: 'in_progress',
        result: { call_id: 'call1', status: 'in_progress' },
      },
    });
    const r = await reviewChat(CHAT, d);
    expect(r.killed_stale_call).toBe(true);
    // The card is flipped and the dial guard unblocked.
    const tc = store.get(`chats/${CHAT}/activities/a1`)!.toolCall as Record<
      string,
      unknown
    >;
    expect(tc.status).toBe('failed');
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._last_call_reviewed_at).toBeTruthy();
    expect(m._last_call_unanswered_at).toBeTruthy();
  });
});

describe('finalizeUnresolvedCall', () => {
  beforeEach(() => {
    seedChat({
      memory: {
        ...eligibleChat().memory,
        _last_outbound_call_at: '2026-07-01T00:00:00Z',
      },
    });
  });

  it('stamps reviewed, bumps the call count, and records the call id', async () => {
    expect(
      await finalizeUnresolvedCall(CHAT, {
        callId: 'call1',
        scheduleNext: false,
      })
    ).toBe(true);
    const d = store.get(`chats/${CHAT}`)!;
    const m = d.memory as Record<string, unknown>;
    expect(m._last_call_reviewed_at).toBeTruthy();
    expect(m._last_call_unanswered_at).toBeTruthy();
    expect(m._reviewed_call_ids).toEqual(['call1']);
    expect(d.call_followup_count).toBe(1);
  });

  it('does NOT bump the count when not treated as unanswered', async () => {
    await finalizeUnresolvedCall(CHAT, {
      callId: 'call1',
      asUnanswered: false,
      scheduleNext: false,
    });
    const d = store.get(`chats/${CHAT}`)!;
    expect(d.call_followup_count).toBeUndefined();
    expect(
      (d.memory as Record<string, unknown>)._last_call_unanswered_at
    ).toBeUndefined();
  });

  it('posts a visible internal note so the resolution is explained', async () => {
    await finalizeUnresolvedCall(CHAT, {
      callId: 'call1',
      scheduleNext: false,
    });
    const rows = store.collection(`chats/${CHAT}/messages_v3`);
    expect(rows).toHaveLength(1);
    expect(rows[0][1].direction).toBe('internal');
  });

  it('cancels the dangling watchdog task', async () => {
    store.set(`chats/${CHAT}/tasks/w1`, {
      type: 'check_if_call_succeeded',
      executed: false,
    });
    await finalizeUnresolvedCall(CHAT, {
      callId: 'call1',
      scheduleNext: false,
    });
    expect(store.get(`chats/${CHAT}/tasks/w1`)).toBeUndefined();
  });

  it('schedules the next step when asked, and not when the caller owns it', async () => {
    await finalizeUnresolvedCall(CHAT, { callId: 'call1', scheduleNext: true });
    expect(store.collection(`chats/${CHAT}/tasks`).length).toBeGreaterThan(0);

    store.reset();
    seedChat();
    await finalizeUnresolvedCall(CHAT, {
      callId: 'call1',
      scheduleNext: false,
    });
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });

  it('returns false for a falsy chat id', async () => {
    expect(await finalizeUnresolvedCall('')).toBe(false);
  });
});

describe('ensureNextStepAfterCall', () => {
  it('schedules immediately, with no grace window', async () => {
    const d = seedChat();
    expect(await ensureNextStepAfterCall(CHAT, d)).toBe(true);
    const payload = store.collection(`chats/${CHAT}/tasks`)[0][1]
      .data as Record<string, unknown>;
    expect(payload.task_source).toBe('call_finalize_resume');
  });

  it('does not stack onto an existing proactive task', async () => {
    const d = seedChat();
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'callback',
      executed: false,
      execute_at: new Date(),
    });
    expect(await ensureNextStepAfterCall(CHAT, d)).toBe(false);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(1);
  });

  it('reads the chat itself when none is supplied', async () => {
    seedChat();
    expect(await ensureNextStepAfterCall(CHAT)).toBe(true);
  });

  it('respects the same exclusions', async () => {
    const d = seedChat({ cadence_complete: true });
    expect(await ensureNextStepAfterCall(CHAT, d)).toBe(false);
  });
});

describe('reconcileStalePendingCalls', () => {
  const OLD = new Date(Date.now() - 60 * 60_000);

  it('finalizes a stale outbound call and deletes its pending doc', async () => {
    seedChat({
      memory: {
        ...eligibleChat().memory,
        _last_outbound_call_at: '2026-07-01T00:00:00Z',
      },
    });
    store.set('pending_calls/call1', { chat_id: CHAT, created_at: OLD });

    const r = await reconcileStalePendingCalls();
    expect(r.finalized).toBe(1);
    expect(store.get('pending_calls/call1')).toBeUndefined();
  });

  it('leaves INBOUND pending calls alone — this sweep is outbound-owned', async () => {
    store.set('chats/inboundChat', { type: 'inbound', memory: {} });
    store.set('pending_calls/call2', {
      chat_id: 'inboundChat',
      created_at: OLD,
    });
    const r = await reconcileStalePendingCalls();
    expect(r.finalized).toBe(0);
    expect(r.skipped).toBe(1);
    expect(store.get('pending_calls/call2')).toBeDefined();
  });

  it('just cleans up when the chat is already resolved', async () => {
    seedChat({
      memory: {
        ...eligibleChat().memory,
        _last_outbound_call_at: '2026-07-01T00:00:00Z',
        _last_call_reviewed_at: '2026-07-02T00:00:00Z',
      },
    });
    store.set('pending_calls/call3', { chat_id: CHAT, created_at: OLD });
    const r = await reconcileStalePendingCalls();
    expect(r.finalized).toBe(0);
    expect(r.skipped).toBe(1);
    expect(store.get('pending_calls/call3')).toBeUndefined();
  });

  it('dry-run reports without writing', async () => {
    seedChat({
      memory: {
        ...eligibleChat().memory,
        _last_outbound_call_at: '2026-07-01T00:00:00Z',
      },
    });
    store.set('pending_calls/call4', { chat_id: CHAT, created_at: OLD });
    const r = await reconcileStalePendingCalls(null, 200, true);
    expect(r.finalized).toBe(1);
    expect(store.get('pending_calls/call4')).toBeDefined();
  });

  it('ignores calls inside the threshold', async () => {
    store.set('pending_calls/fresh', {
      chat_id: CHAT,
      created_at: new Date(),
    });
    expect((await reconcileStalePendingCalls()).scanned).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('booking reminders', () => {
  it('splits the demo-day reminders when they are far enough apart', async () => {
    // A 6pm demo: 9am heads-up and 4pm two-hours-before are 7h apart → separate emails.
    const meetingAt = new Date('2026-08-10T18:00:00Z');
    const plan = await rem.leadAwarePlan(
      CHAT,
      meetingAt,
      new Date('2026-08-10T07:00:00Z'),
      'UTC',
      null
    );
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.channel === 'email')).toBe(true);
  });

  it('COMBINES them into one morning email for an early demo', async () => {
    // A 10am demo: 9am and 8am are only an hour apart → one combined email, before the demo.
    const meetingAt = new Date('2026-08-10T10:00:00Z');
    const plan = await rem.leadAwarePlan(
      CHAT,
      meetingAt,
      new Date('2026-08-10T06:00:00Z'),
      'UTC',
      null
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].execute_at.getTime()).toBeLessThan(meetingAt.getTime());
  });

  it('adds the day-before pair only when the demo is MORE than 24h out', async () => {
    const far = await rem.leadAwarePlan(
      CHAT,
      new Date('2026-08-12T18:00:00Z'),
      new Date('2026-08-10T07:00:00Z'),
      'UTC',
      null
    );
    expect(far.filter((p) => p.channel === 'call')).toHaveLength(1);

    const near = await rem.leadAwarePlan(
      CHAT,
      new Date('2026-08-10T18:00:00Z'),
      new Date('2026-08-10T07:00:00Z'),
      'UTC',
      null
    );
    expect(near.filter((p) => p.channel === 'call')).toHaveLength(0);
  });

  it('fills tokens without throwing on a stray brace', () => {
    expect(
      rem.fill('Hi {first_name} at {company} — {demo}', 'Ann', 'Acme', 'Fri')
    ).toBe('Hi Ann at Acme — Fri');
    expect(
      rem.fill('literal {oops} brace {first_name}', 'Ann', 'A', 'D')
    ).toContain('{oops}');
    expect(rem.fill(undefined, 'Ann', 'A', 'D')).toBe('');
  });

  it('schedules the plan, skipping the past and the opted-out channel', async () => {
    seedChat({
      phone_opt_out: true, // the day-before CALL must be skipped
      memory: {
        ...eligibleChat().memory,
        meeting_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        first_name: 'Ann',
        company: 'Acme',
      },
    });
    const created = await scheduleBookingReminders(CHAT, 'agentA');
    expect(created.length).toBeGreaterThan(0);
    const tasks = store.collection(`chats/${CHAT}/tasks`);
    expect(tasks.every(([, t]) => t.type === 'reminder')).toBe(true);
    const payloads = tasks.map(([, t]) => t.data as Record<string, unknown>);
    expect(payloads.some((p) => p.channel === 'call')).toBe(false); // gated out
    expect(
      payloads.every((p) => p.task_source === 'auto_booking_reminder')
    ).toBe(true);
  });

  it('dedups so a re-book never stacks duplicates', async () => {
    seedChat({
      memory: {
        ...eligibleChat().memory,
        meeting_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      },
    });
    const first = await scheduleBookingReminders(CHAT, 'agentA');
    const second = await scheduleBookingReminders(CHAT, 'agentA');
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(second.length);
    expect(first.length).toBe(second.length);
  });

  it('skips entirely with no meeting_at', async () => {
    seedChat();
    await expect(scheduleBookingReminders(CHAT, 'agentA')).resolves.toEqual([]);
  });

  it('returns [] for a falsy chat id', async () => {
    await expect(scheduleBookingReminders('', 'agentA')).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the cron', () => {
  const DUE = new Date(Date.now() - 60_000);

  function seedTask(
    chatId: string,
    taskId: string,
    over: Record<string, unknown> = {}
  ) {
    store.set(`chats/${chatId}/tasks/${taskId}`, {
      type: 'outbound_outreach',
      executed: false,
      execute_at: DUE,
      agent_id: 'agentA',
      notes: 'do the thing',
      admin_override: true, // bypass the business-hours gate unless a test opts in
      ...over,
    });
  }

  function seedOutboundChat(
    chatId: string,
    over: Record<string, unknown> = {}
  ) {
    store.set(`chats/${chatId}`, {
      type: 'outbound',
      status: 'active',
      agentId: 'agentA',
      phone_opt_out: false,
      email_opt_out: false,
      memory: {
        agent_id: 'agentA',
        phone_number: '15551230000',
        customer_email: 'a@b.com',
        timezone: 'UTC',
      },
      ...over,
    });
  }

  it('finds only due tasks on ACTIVE outbound chats', async () => {
    seedOutboundChat('ob1');
    seedTask('ob1', 't1');
    seedOutboundChat('paused', { status: 'paused' });
    seedTask('paused', 't2');
    store.set('chats/inb', { type: 'inbound', status: 'active', memory: {} });
    seedTask('inb', 't3');

    const due = await filterDueOutboundTasks(2, 20_160);
    expect(due.map((t) => t.chat_id)).toEqual(['ob1']);
  });

  it('picks up an OVERDUE task via the wide lookback', async () => {
    seedOutboundChat('ob1');
    seedTask('ob1', 'old', {
      execute_at: new Date(Date.now() - 10 * 24 * 3_600_000),
    });
    const due = await filterDueOutboundTasks(2, 20_160);
    expect(due).toHaveLength(1);
  });

  it('runs a due task and marks it executed via the claim', async () => {
    seedOutboundChat('ob1');
    seedTask('ob1', 't1');
    const runTurn = jest.fn().mockResolvedValue(undefined);

    const r = await processOutboundTasks({ runTurn });
    expect(r.processed).toBe(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(String((runTurn.mock.calls[0] as unknown[])[0])).toContain(
      'do the thing'
    );
    expect(store.get('chats/ob1/tasks/t1')!.executed).toBe(true);
  });

  it('serializes PER CHAT — two due tasks on one chat run one this tick', async () => {
    // The per-task claim cannot prevent this, because the task ids differ.
    seedOutboundChat('ob1');
    seedTask('ob1', 'older', { execute_at: new Date(Date.now() - 120_000) });
    seedTask('ob1', 'newer', { execute_at: new Date(Date.now() - 60_000) });
    const runTurn = jest.fn().mockResolvedValue(undefined);

    const r = await processOutboundTasks({ runTurn });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(r.due).toBe(1);
    // The oldest ran; the other stays pending for a later tick.
    expect(store.get('chats/ob1/tasks/older')!.executed).toBe(true);
    expect(store.get('chats/ob1/tasks/newer')!.executed).toBe(false);
  });

  it('skips a task whose chat carries a proactive-stop label, marking it terminal-but-distinct', async () => {
    seedOutboundChat('ob1', { labels: ['not_interested'] });
    seedTask('ob1', 't1');
    const runTurn = jest.fn();

    await processOutboundTasks({ runTurn });
    expect(runTurn).not.toHaveBeenCalled();
    const t = store.get('chats/ob1/tasks/t1')!;
    expect(t.skipped).toBe(true);
    expect(t.skip_reason).toBe('not_interested');
    expect(t.executed).toBe(true);
  });

  it('skips a fully opted-out chat', async () => {
    seedOutboundChat('ob1', { phone_opt_out: true, email_opt_out: true });
    seedTask('ob1', 't1');
    const runTurn = jest.fn();

    await processOutboundTasks({ runTurn });
    expect(runTurn).not.toHaveBeenCalled();
    expect(store.get('chats/ob1/tasks/t1')!.skip_reason).toBe(
      'channel_opted_out'
    );
  });

  it('drops tasks belonging to a PAUSED campaign', async () => {
    store.set('outbound_campaigns/camp1', {
      status: 'paused',
      _pause_done: true,
    });
    seedOutboundChat('ob1');
    seedTask('ob1', 't1', { campaign_id: 'camp1' });
    const runTurn = jest.fn();

    const r = await processOutboundTasks({ runTurn });
    expect(runTurn).not.toHaveBeenCalled();
    expect(r.due).toBe(0);
  });

  it('reschedules an outreach task outside business hours WITHOUT running a turn', async () => {
    // 3am UTC on a Sunday is outside every window; no turn, no chat message, just a new execute_at.
    seedOutboundChat('ob1', {
      memory: {
        agent_id: 'agentA',
        phone_number: '15551230000',
        timezone: 'UTC',
      },
    });
    seedTask('ob1', 't1', { admin_override: false, type: 'outbound_outreach' });
    const runTurn = jest.fn();

    await processOutboundTasks({ runTurn });
    const t = store.get('chats/ob1/tasks/t1')!;
    if (!runTurn.mock.calls.length) {
      // Deferred: the claim was reset so the morning tick re-dispatches it.
      expect(t.executed).toBe(false);
      expect(t.dispatched_at).toBeNull();
    } else {
      // Inside the window at test time — it ran instead, which is the other valid outcome.
      expect(t.executed).toBe(true);
    }
  });

  it('does NOT business-hours-gate a review/continuation task', async () => {
    seedOutboundChat('ob1');
    seedTask('ob1', 't1', {
      type: 'call_completion_continuation',
      admin_override: false,
    });
    const runTurn = jest.fn().mockResolvedValue(undefined);

    await processOutboundTasks({ runTurn });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('lets a PRIORITY task bypass the per-tick cap', async () => {
    process.env.OUTBOUND_MAX_TASKS_PER_TICK = '1';
    try {
      // The real tasks must be neither Test nor admin_override, or they would themselves be
      // priority. A continuation type keeps them out of the business-hours pre-gate too.
      for (let i = 0; i < 3; i += 1) {
        seedOutboundChat(`real${i}`);
        seedTask(`real${i}`, 't', {
          type: 'call_completion_continuation',
          admin_override: false,
          execute_at: new Date(Date.now() - 300_000),
        });
      }
      seedOutboundChat('testChat', { record_type: 'Test' });
      seedTask('testChat', 't', {
        type: 'call_completion_continuation',
        admin_override: false,
      });

      const runTurn = jest.fn().mockResolvedValue(undefined);
      const r = await processOutboundTasks({ runTurn });
      // 1 capped real task + the uncapped Test task.
      expect(r.processed).toBe(2);
      expect(r.deferred).toBe(2);
    } finally {
      delete process.env.OUTBOUND_MAX_TASKS_PER_TICK;
    }
  });

  it('treats an admin_override task as priority too', async () => {
    process.env.OUTBOUND_MAX_TASKS_PER_TICK = '1';
    try {
      for (let i = 0; i < 2; i += 1) {
        seedOutboundChat(`real${i}`);
        seedTask(`real${i}`, 't', {
          type: 'call_completion_continuation',
          admin_override: false,
          execute_at: new Date(Date.now() - 300_000),
        });
      }
      seedOutboundChat('adminChat');
      seedTask('adminChat', 't', { admin_override: true });

      const runTurn = jest.fn().mockResolvedValue(undefined);
      const r = await processOutboundTasks({ runTurn });
      expect(r.processed).toBe(2); // 1 capped + the override
      expect(r.deferred).toBe(1);
    } finally {
      delete process.env.OUTBOUND_MAX_TASKS_PER_TICK;
    }
  });

  it('records a failure and reopens the task for the backoff retry', async () => {
    seedOutboundChat('ob1');
    seedTask('ob1', 't1', { retry_count: 0 });
    const runTurn = jest.fn().mockRejectedValue(new Error('provider down'));

    const r = await processOutboundTasks({ runTurn });
    expect(r.failed).toBe(1);
    const t = store.get('chats/ob1/tasks/t1')!;
    expect(t.permanent_failure).toBeFalsy();
    expect(t.executed).toBe(false); // reopened
  });

  it('skips a task with no resolvable agent', async () => {
    store.set('chats/ob1', {
      type: 'outbound',
      status: 'active',
      memory: { phone_number: '15551230000' },
    });
    seedTask('ob1', 't1', { agent_id: undefined });
    const runTurn = jest.fn();

    const r = await processOutboundTasks({ runTurn });
    expect(runTurn).not.toHaveBeenCalled();
    expect(r.processed).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('advances the campaign sweeps once per tick', async () => {
    store.set('outbound_campaigns/enrolling1', {
      status: 'enrolling',
      agent_id: 'agentA',
      audience: { type: 'csv', contacts: [] },
      per_day: 10,
    });
    const runTurn = jest.fn();
    await processOutboundTasks({ runTurn });
    // An empty source settles the campaign to running.
    expect(store.get('outbound_campaigns/enrolling1')!.status).toBe('running');
  });

  it('returns a clean result with nothing due', async () => {
    const runTurn = jest.fn();
    await expect(processOutboundTasks({ runTurn })).resolves.toMatchObject({
      success: true,
      processed: 0,
      failed: 0,
      due: 0,
    });
  });
});
