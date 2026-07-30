/**
 * @jest-environment node
 *
 * The three guards whose FAIL DIRECTION is load-bearing, plus the task invariants.
 *
 *   - `taskDispatch.claimTask`  — fails CLOSED. A duplicate outbound call is worse than a skipped tick.
 *   - `rateLimit.tryConsume`    — fails OPEN. A limiter fault must never stop the flow from sending.
 *   - `scheduling.hasPendingProactiveTask` — fails CLOSED. A read fault must not look like a stalled
 *     cadence and trigger a spurious extra outreach.
 *
 * Getting any of these backwards produces a bug that only shows up under load, so each direction is
 * asserted explicitly.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import { claimTask, shouldClaimTask } from '../../services/taskDispatch';
import {
  evaluate,
  secondsUntilReset,
  tryConsume,
} from '../../services/rateLimit';
import {
  computeExecuteAt,
  deletePendingFollowups,
  deletePendingOutboundOutreach,
  enforceSingleProactiveTask,
  hasPendingProactiveTask,
  taskChannel,
} from '../../services/scheduling';

const CHAT = 'chat1';

function seedTask(id: string, data: Record<string, unknown> = {}): void {
  store.set(`chats/${CHAT}/tasks/${id}`, {
    type: 'outbound_outreach',
    executed: false,
    ...data,
  });
}

beforeEach(() => {
  store.reset();
  store.set(`chats/${CHAT}`, { type: 'outbound', memory: {} });
});

describe('shouldClaimTask — the pure claim decision', () => {
  it('claims a fresh pending task', () => {
    expect(shouldClaimTask({ executed: false })).toBe(true);
  });

  it('refuses an already-executed task — this is the at-most-once marker', () => {
    expect(shouldClaimTask({ executed: true })).toBe(false);
  });

  it('refuses a terminal task', () => {
    expect(shouldClaimTask({ executed: false, skipped: true })).toBe(false);
    expect(shouldClaimTask({ executed: false, permanent_failure: true })).toBe(
      false
    );
  });

  it('refuses garbage input', () => {
    expect(shouldClaimTask(null)).toBe(false);
    expect(shouldClaimTask(undefined)).toBe(false);
  });

  it('does NOT consider any lease/age field — there is no lease by design', () => {
    // A crashed turn stays executed=true and is reconciled by the review tools, not a lease expiry.
    // If a lease were reintroduced, a due task would wait out the hold instead of firing next tick.
    expect(
      shouldClaimTask({ executed: true, dispatched_at: new Date(0) })
    ).toBe(false);
  });
});

describe('claimTask — atomic dispatch-once', () => {
  it('marks the task executed AT DISPATCH, before the turn runs', async () => {
    seedTask('t1');
    expect(await claimTask(CHAT, 't1')).toBe(true);
    const task = store.get(`chats/${CHAT}/tasks/t1`)!;
    expect(task.executed).toBe(true);
    expect(task.dispatched_at).toBeInstanceOf(Date);
  });

  it('grants the claim to exactly ONE caller — the storm this exists to prevent', async () => {
    seedTask('t1');
    const first = await claimTask(CHAT, 't1');
    const second = await claimTask(CHAT, 't1');
    const third = await claimTask(CHAT, 't1');
    expect([first, second, third]).toEqual([true, false, false]);
  });

  it('refuses a terminal task', async () => {
    seedTask('t1', { skipped: true });
    expect(await claimTask(CHAT, 't1')).toBe(false);
  });

  it('fails CLOSED for a missing task and missing ids', async () => {
    expect(await claimTask(CHAT, 'ghost')).toBe(false);
    expect(await claimTask('', 't1')).toBe(false);
    expect(await claimTask(CHAT, '')).toBe(false);
  });
});

describe('rateLimit.evaluate — the pure fixed-window decision', () => {
  it('allows while under budget and counts up', () => {
    expect(evaluate(1000, 1000, 0, 3, 60)).toEqual({
      allow: true,
      windowStart: 1000,
      count: 1,
    });
    expect(evaluate(1010, 1000, 2, 3, 60)).toEqual({
      allow: true,
      windowStart: 1000,
      count: 3,
    });
  });

  it('refuses once the budget is exhausted, leaving the window intact', () => {
    expect(evaluate(1010, 1000, 3, 3, 60)).toEqual({
      allow: false,
      windowStart: 1000,
      count: 3,
    });
  });

  it('resets the window once it has elapsed', () => {
    expect(evaluate(1060, 1000, 3, 3, 60)).toEqual({
      allow: true,
      windowStart: 1060,
      count: 1,
    });
  });

  it('treats the window boundary as elapsed (>=, not >)', () => {
    expect(evaluate(1060, 1000, 99, 3, 60).allow).toBe(true);
  });
});

describe('rateLimit.tryConsume', () => {
  it('allows up to the budget then refuses within the window', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1)
      results.push(await tryConsume('agent1', 3, 3600));
    expect(results).toEqual([true, true, true, false]);
  });

  it('fails OPEN for a non-positive limit — an unset cap must not block sending', async () => {
    expect(await tryConsume('agent1', 0, 3600)).toBe(true);
    expect(await tryConsume('agent1', -1, 3600)).toBe(true);
  });

  it('fails OPEN for a missing key', async () => {
    expect(await tryConsume('', 1, 3600)).toBe(true);
  });

  it('keys buckets independently per agent', async () => {
    expect(await tryConsume('a', 1, 3600)).toBe(true);
    expect(await tryConsume('a', 1, 3600)).toBe(false);
    expect(await tryConsume('b', 1, 3600)).toBe(true);
  });
});

describe('rateLimit.secondsUntilReset', () => {
  it('returns 0 when there is no bucket yet', async () => {
    expect(await secondsUntilReset('agent1', 3600)).toBe(0);
  });

  it('reports the real time to the window rollover, not a guess', async () => {
    // This is what stops a bucket-deferred email retrying into a still-full window forever.
    const nowSec = Date.now() / 1000;
    store.set('rate_limits/agent1', { window_start: nowSec, count: 5 });
    const remaining = await secondsUntilReset('agent1', 3600);
    expect(remaining).toBeGreaterThan(3500);
    expect(remaining).toBeLessThanOrEqual(3600);
  });

  it('returns 0 once the window has already elapsed', async () => {
    store.set('rate_limits/agent1', {
      window_start: Date.now() / 1000 - 7200,
      count: 5,
    });
    expect(await secondsUntilReset('agent1', 3600)).toBe(0);
  });

  it('returns 0 for a missing key', async () => {
    expect(await secondsUntilReset('', 3600)).toBe(0);
  });
});

describe('scheduling.taskChannel', () => {
  it('prefers an explicit channel tag', () => {
    expect(
      taskChannel({ channel: 'phone', type: 'followup_if_no_reply' })
    ).toBe('phone');
    expect(taskChannel({ channel: 'email', type: 'callback' })).toBe('email');
  });

  it('infers phone from the call task types', () => {
    expect(taskChannel({ type: 'call_followup' })).toBe('phone');
    expect(taskChannel({ type: 'callback' })).toBe('phone');
  });

  it('defaults everything else to email', () => {
    expect(taskChannel({ type: 'followup_if_no_reply' })).toBe('email');
    expect(taskChannel({})).toBe('email');
    expect(taskChannel(null)).toBe('email');
  });
});

describe('scheduling.enforceSingleProactiveTask — the <=1 pending proactive invariant', () => {
  it('collapses every other pending proactive task, keeping the new one', async () => {
    // Without this, each re-enroll / recovery sweep / review stacks another touch and the prospect
    // gets contacted several times in a row.
    seedTask('old1', { type: 'outbound_outreach' });
    seedTask('old2', { type: 'followup_if_no_reply' });
    seedTask('old3', { type: 'callback' });
    seedTask('new', { type: 'outbound_outreach' });

    expect(await enforceSingleProactiveTask(CHAT, 'new')).toBe(3);
    expect(store.get(`chats/${CHAT}/tasks/new`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/old1`)).toBeUndefined();
    expect(store.get(`chats/${CHAT}/tasks/old3`)).toBeUndefined();
  });

  it('leaves NON-proactive tasks alone — a booked chat legitimately has several reminders', async () => {
    seedTask('reminder', { type: 'reminder' });
    seedTask('watchdog', { type: 'check_if_call_succeeded' });
    seedTask('booking', { type: 'book_meeting' });
    seedTask('new', { type: 'outbound_outreach' });

    expect(await enforceSingleProactiveTask(CHAT, 'new')).toBe(0);
    expect(store.get(`chats/${CHAT}/tasks/reminder`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/watchdog`)).toBeDefined();
  });

  it('leaves already-executed and terminal tasks alone', async () => {
    seedTask('done', { type: 'followup_if_no_reply', executed: true });
    seedTask('skipped', { type: 'callback', skipped: true });
    seedTask('new', { type: 'outbound_outreach' });

    expect(await enforceSingleProactiveTask(CHAT, 'new')).toBe(0);
    expect(store.get(`chats/${CHAT}/tasks/done`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/skipped`)).toBeDefined();
  });

  it("perChannel mode preserves the OTHER channel's pending touch", async () => {
    // A dual test chat runs a phone and an email cadence side by side; collapsing across channels
    // would silently kill one of them.
    seedTask('phone_old', { type: 'call_followup' });
    seedTask('email_old', { type: 'followup_if_no_reply' });
    seedTask('phone_new', { type: 'callback' });

    expect(await enforceSingleProactiveTask(CHAT, 'phone_new', true)).toBe(1);
    expect(store.get(`chats/${CHAT}/tasks/phone_old`)).toBeUndefined();
    expect(store.get(`chats/${CHAT}/tasks/email_old`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/phone_new`)).toBeDefined();
  });

  it('returns 0 for a missing chat id', async () => {
    expect(await enforceSingleProactiveTask('', 'x')).toBe(0);
  });
});

describe('scheduling.hasPendingProactiveTask', () => {
  it('is true when a pending proactive task exists', async () => {
    seedTask('t1', { type: 'followup_if_no_reply' });
    expect(await hasPendingProactiveTask(CHAT)).toBe(true);
  });

  it('is false when only non-proactive or terminal tasks remain', async () => {
    seedTask('r', { type: 'reminder' });
    seedTask('done', { type: 'callback', executed: true });
    seedTask('skip', { type: 'callback', skipped: true });
    expect(await hasPendingProactiveTask(CHAT)).toBe(false);
  });

  it('filters by channel when asked', async () => {
    seedTask('email', { type: 'followup_if_no_reply' });
    expect(await hasPendingProactiveTask(CHAT, 'email')).toBe(true);
    expect(await hasPendingProactiveTask(CHAT, 'phone')).toBe(false);
  });

  it('fails CLOSED on a read error — a fault must not look like a stalled cadence', async () => {
    const scheduling = await import('../../services/scheduling');
    const dbModule = await import('../../firebase/db');
    const spy = jest.spyOn(dbModule.db, 'collection').mockImplementation(() => {
      throw new Error('firestore unavailable');
    });
    try {
      expect(await scheduling.hasPendingProactiveTask(CHAT)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('scheduling.deletePending*', () => {
  it('deletes only pending outbound_outreach', async () => {
    seedTask('a', { type: 'outbound_outreach' });
    seedTask('b', { type: 'outbound_outreach', executed: true });
    seedTask('c', { type: 'callback' });
    expect(await deletePendingOutboundOutreach(CHAT)).toBe(1);
    expect(store.get(`chats/${CHAT}/tasks/b`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/c`)).toBeDefined();
  });

  it('deletes both follow-up types', async () => {
    seedTask('e', { type: 'followup_if_no_reply' });
    seedTask('p', { type: 'call_followup' });
    seedTask('o', { type: 'outbound_outreach' });
    expect(await deletePendingFollowups(CHAT)).toBe(2);
    expect(store.get(`chats/${CHAT}/tasks/o`)).toBeDefined();
  });
});

describe('scheduling.computeExecuteAt', () => {
  it('combines date and time in the given zone', () => {
    expect(
      computeExecuteAt('2026-03-04', '14:30', 'America/New_York').toISOString()
    ).toBe('2026-03-04T19:30:00.000Z');
  });

  it('defaults to UTC when no zone is given', () => {
    expect(computeExecuteAt('2026-03-04', '14:30', '').toISOString()).toBe(
      '2026-03-04T14:30:00.000Z'
    );
  });

  it('THROWS on a bad date/time or zone rather than silently guessing', () => {
    // A silently wrong appointment time is worse than a visible failure.
    expect(() => computeExecuteAt('04/03/2026', '14:30', 'UTC')).toThrow();
    expect(() => computeExecuteAt('2026-03-04', '99:99', 'UTC')).toThrow();
    expect(() =>
      computeExecuteAt('2026-03-04', '14:30', 'Not/AZone')
    ).toThrow();
  });
});
