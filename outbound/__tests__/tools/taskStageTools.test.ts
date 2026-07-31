/**
 * @jest-environment node
 *
 * The six task and lifecycle tools.
 *
 * These are how the agent schedules its own next touch and closes prospects, so the tests focus on the
 * refusals rather than the happy paths:
 *
 *  - **`create_custom_task`'s four gates**, including the two that make it decline to schedule at all:
 *    a closed channel, and an email follow-up with no email ever sent.
 *  - **The type coercion is not cosmetic.** `callback` and `outbound_call` must become
 *    `outbound_outreach` or the inbound cron consumes the task and the call never happens.
 *  - **`mark_prospect_lost` refuses to close twice over.** A decline routes to the label; a
 *    call-channel dead end stands down the phone and keeps emailing. Both prevent losing a workable lead.
 *  - **`mark_cadence_complete` can decline to complete** and flip to the email lane instead.
 *  - **"Already gone" is a SKIP, not a failure**, for both update and delete — the agent surfaces tool
 *    failures into the conversation, and a task that no longer exists already satisfies the request.
 *  - **The create/update business-hours asymmetry**, asserted deliberately so it reads as intentional.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/stalledRecovery', () => ({
  fallbackToEmailLane: jest.fn(),
}));
jest.mock('../../services/notInterested', () => ({
  handleNotInterested: jest.fn(),
}));

import { store } from '../../testSupport/mockFirestore';
import { fallbackToEmailLane } from '../../services/stalledRecovery';
import { handleNotInterested } from '../../services/notInterested';
import {
  parseAndRunCreateCustomTask,
  parseAndRunDeleteCustomTask,
  parseAndRunUpdateCustomTask,
  __testing as tt,
} from '../../tools/taskTools';
import {
  VALID_LOST_REASONS,
  parseAndRunClearNotInterested,
  parseAndRunMarkCadenceComplete,
  parseAndRunMarkProspectLost,
  __testing as st,
} from '../../tools/stageTools';
import type { BedrockMessage } from '../../types';

const CHAT = 'outbound__agentA__15551230000';
const AGENT = 'agentA';

const fallbackLane = fallbackToEmailLane as jest.Mock;
const notInterested = handleNotInterested as jest.Mock;

function payloadOf(res: BedrockMessage): Record<string, unknown> {
  const content = (
    res as unknown as {
      content: {
        toolResult: { content: { json: Record<string, unknown> }[] };
      }[];
    }
  ).content;
  return content[0].toolResult.content[0].json;
}

function seedChat(over: Record<string, unknown> = {}) {
  // `...rest` BEFORE `memory`, so an override of one memory key cannot drop the rest of the defaults.
  const { memory: memOver, ...rest } = over;
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    agentId: AGENT,
    phone_opt_out: false,
    email_opt_out: false,
    ...rest,
    memory: {
      agent_id: AGENT,
      phone_number: '15551230000',
      customer_email: 'jane@corp.com',
      timezone: 'America/Denver',
      // `Test` bypasses the business-hours clamp, keeping most schedules deterministic.
      record_type: 'Test',
      ...((memOver as Record<string, unknown>) ?? {}),
    },
  });
}

function tasks(): Array<Record<string, unknown> & { id: string }> {
  return store.paths(`chats/${CHAT}/tasks`).map((p) => ({
    ...(store.get(p) as Record<string, unknown>),
    id: p.split('/').pop()!,
  }));
}

/** Schedule a task through the tool, defaulting to a far-future weekday slot. */
async function create(
  input: Record<string, unknown>,
  meta: Record<string, unknown> = {}
) {
  return payloadOf(
    await parseAndRunCreateCustomTask(
      'tu1',
      {
        date: '2026-09-02',
        time: '14:00',
        timezone: 'America/Denver',
        ...input,
      },
      'acct1',
      'attend1',
      CHAT,
      meta
    )
  );
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  fallbackLane.mockResolvedValue('task_email_1');
  notInterested.mockResolvedValue({ ok: true });
  seedChat();
});

// ─────────────────────────────────────────────────────────────────────────────
// create_custom_task
// ─────────────────────────────────────────────────────────────────────────────

describe('create_custom_task', () => {
  test('schedules a task and returns its id', async () => {
    const r = await create({ task_type: 'reminder', notes: 'ping Jane' });
    expect(r.status).toBe('created');
    expect(typeof r.task_id).toBe('string');
    const t = tasks()[0];
    expect(t.type).toBe('reminder');
    expect((t.data as Record<string, unknown>).notes).toBe('ping Jane');
    expect((t.data as Record<string, unknown>).original_date).toBe(
      '2026-09-02'
    );
  });

  test('GATE 1: callback and outbound_call are COERCED to outbound_outreach', async () => {
    // Not cosmetic — the inbound cron fetches those names and would consume the task.
    for (const type of ['callback', 'outbound_call']) {
      store.reset();
      seedChat();
      await create({ task_type: type });
      expect(tasks()[0].type).toBe('outbound_outreach');
    }
    expect([...tt.COERCE_TYPES]).toEqual(['callback', 'outbound_call']);
  });

  test('GATE 2: a closed channel refuses to schedule', async () => {
    seedChat({ phone_opt_out: true });
    const r = await create({ task_type: 'call_followup' });
    expect(r.status).toBe('skipped');
    expect(String(r.message)).toContain('opted out');
    expect(tasks()).toHaveLength(0);
  });

  test('GATE 2 fails OPEN when the chat doc is missing', async () => {
    store.reset(); // no chat doc at all
    const r = await create({ task_type: 'call_followup' });
    // A read fault must not stall every cadence.
    expect(r.status).toBe('created');
  });

  test('GATE 3: an email follow-up needs an email to have actually SENT', async () => {
    const r = await create({ task_type: 'followup_if_no_reply' });
    expect(r.status).toBe('skipped');
    // A deferred send already queued its own retry; a follow-up on top would double-touch.
    expect(String(r.message)).toContain('No email has actually sent yet');
    expect(tasks()).toHaveLength(0);
  });

  test('GATE 3 passes once a real send has been stamped', async () => {
    seedChat({ memory: { _first_outbound_email_at: '2026-08-01T10:00:00Z' } });
    const r = await create({ task_type: 'followup_if_no_reply' });
    expect(r.status).toBe('created');
  });

  test('GATE 4: a single-pending type REPLACES its prior unexecuted task', async () => {
    seedChat({ memory: { _first_outbound_email_at: '2026-08-01T10:00:00Z' } });
    store.set(`chats/${CHAT}/tasks/t_old`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    const r = await create({ task_type: 'followup_if_no_reply' });
    expect(r.status).toBe('created');
    expect(String(r.message)).toContain('Deleted 1 previous unexecuted');
    expect(tasks()).toHaveLength(1);
  });

  test('an EXECUTED prior task is left alone — only pending ones are replaced', async () => {
    seedChat({ memory: { _first_outbound_email_at: '2026-08-01T10:00:00Z' } });
    store.set(`chats/${CHAT}/tasks/t_done`, {
      type: 'followup_if_no_reply',
      executed: true,
      data: {},
    });
    await create({ task_type: 'followup_if_no_reply' });
    // History is not rewritten; the executed task remains as a record of the touch.
    expect(tasks()).toHaveLength(2);
  });

  test('outbound_outreach also clears pending FOLLOW-UPS', async () => {
    store.set(`chats/${CHAT}/tasks/t_fu`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    await create({ task_type: 'outbound_outreach' });
    // A queued first touch means no follow-up should exist yet.
    expect(
      tasks().filter((t) => t.type === 'followup_if_no_reply')
    ).toHaveLength(0);
    expect(tasks().filter((t) => t.type === 'outbound_outreach')).toHaveLength(
      1
    );
  });

  test('an admin ASAP override fires NOW', async () => {
    const before = Date.now();
    const r = await create(
      { task_type: 'outbound_outreach' },
      { admin_asap: true }
    );
    expect(String(r.message)).toContain('ASAP → scheduled now');
    const at = (tasks()[0].execute_at as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect((tasks()[0].data as Record<string, unknown>).admin_override).toBe(
      true
    );
  });

  test('an admin override honours the EXACT time and bypasses business hours', async () => {
    // A real record, at 3am on a Sunday — the pacing machinery exists to stop the MODEL doing this,
    // not to override a human instruction.
    seedChat({ memory: { record_type: 'Real' } });
    const r = await create(
      { task_type: 'outbound_outreach', date: '2026-09-06', time: '03:00' },
      { admin_override: true }
    );
    expect(String(r.message)).toContain('exact time honored');
    expect((tasks()[0].data as Record<string, unknown>).admin_override).toBe(
      true
    );
  });

  test('a missing chat_id fails cleanly', async () => {
    const r = payloadOf(
      await parseAndRunCreateCustomTask(
        'tu1',
        { task_type: 'reminder', date: '2026-09-02', time: '14:00' },
        'a',
        'b',
        ''
      )
    );
    expect(r.status).toBe('failed');
    expect(r.message).toBe('chat_id is required');
  });

  test('an unparseable date is reported, not thrown', async () => {
    const r = await create({ task_type: 'reminder', date: 'not-a-date' });
    expect(r.status).toBe('failed');
    expect(String(r.message)).toContain('Invalid date/time format');
  });

  test('the clamp sets omit call_followup on UPDATE but not CREATE', () => {
    // Asserted directly so the asymmetry reads as intentional rather than a typo.
    expect(tt.VOICE_TASK_TYPES_CREATE.has('call_followup')).toBe(true);
    expect(tt.VOICE_TASK_TYPES_UPDATE.has('call_followup')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// update_custom_task
// ─────────────────────────────────────────────────────────────────────────────

describe('update_custom_task', () => {
  function seedTask(over: Record<string, unknown> = {}) {
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'reminder',
      executed: false,
      execute_at: new Date('2026-09-02T20:00:00Z'),
      data: {
        notes: 'original',
        original_date: '2026-09-02',
        original_time: '14:00',
        timezone: 'America/Denver',
        keep_me: 'yes',
      },
      ...over,
    });
  }

  async function update(input: Record<string, unknown>) {
    return payloadOf(
      await parseAndRunUpdateCustomTask(
        'tu1',
        { task_id: 't1', ...input },
        'a',
        'b',
        CHAT
      )
    );
  }

  test('a task that no longer exists is SKIPPED, not failed', async () => {
    const r = await update({ notes: 'x' });
    // The agent surfaces failures into the conversation, and the goal is already met.
    expect(r.status).toBe('skipped');
    expect(String(r.message)).toContain('no longer exists');
  });

  test('reschedules and records the new original date/time', async () => {
    seedTask();
    const r = await update({ date: '2026-09-10', time: '09:30' });
    expect(r.status).toBe('updated');
    const d = store.get(`chats/${CHAT}/tasks/t1`)!.data as Record<
      string,
      unknown
    >;
    expect(d.original_date).toBe('2026-09-10');
    expect(d.original_time).toBe('09:30');
  });

  test('additional_data MERGES rather than replacing the payload', async () => {
    seedTask();
    await update({ additional_data: { added: 'new' } });
    const d = store.get(`chats/${CHAT}/tasks/t1`)!.data as Record<
      string,
      unknown
    >;
    // A partial update must not silently drop the rest of the task's data.
    expect(d.added).toBe('new');
    expect(d.keep_me).toBe('yes');
    expect(d.notes).toBe('original');
  });

  test('marks a task executed', async () => {
    seedTask();
    const r = await update({ executed: true });
    expect(String(r.message)).toContain('status to executed');
    expect(store.get(`chats/${CHAT}/tasks/t1`)!.executed).toBe(true);
  });

  test('changes the task type', async () => {
    seedTask();
    await update({ task_type: 'callback' });
    expect(store.get(`chats/${CHAT}/tasks/t1`)!.type).toBe('callback');
  });

  test('an empty update is a failure — there is nothing to apply', async () => {
    seedTask();
    const r = await update({});
    expect(r.status).toBe('failed');
    expect(r.message).toBe('No updates provided');
  });

  test('a missing task_id fails cleanly', async () => {
    const r = payloadOf(
      await parseAndRunUpdateCustomTask('tu1', {}, 'a', 'b', CHAT)
    );
    expect(r.status).toBe('failed');
    expect(r.message).toBe('task_id is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// delete_custom_task
// ─────────────────────────────────────────────────────────────────────────────

describe('delete_custom_task', () => {
  async function remove(input: Record<string, unknown> = {}) {
    return payloadOf(
      await parseAndRunDeleteCustomTask(
        'tu1',
        { task_id: 't1', ...input },
        'a',
        'b',
        CHAT
      )
    );
  }

  test('deletes the task and names its type', async () => {
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'callback',
      executed: false,
      data: {},
    });
    const r = await remove({ reason: 'customer rescheduled' });
    expect(r.status).toBe('deleted');
    expect(String(r.message)).toContain("type 'callback'");
    expect(String(r.message)).toContain('customer rescheduled');
    expect(tasks()).toHaveLength(0);
  });

  test('an already-gone task is SKIPPED — the delete goal is already met', async () => {
    const r = await remove();
    expect(r.status).toBe('skipped');
    expect(String(r.message)).toContain('already gone');
  });

  test('a missing task_id fails cleanly', async () => {
    const r = payloadOf(
      await parseAndRunDeleteCustomTask('tu1', {}, 'a', 'b', CHAT)
    );
    expect(r.status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mark_prospect_lost
// ─────────────────────────────────────────────────────────────────────────────

describe('mark_prospect_lost', () => {
  async function lost(reason: string, meta: Record<string, unknown> = {}) {
    return payloadOf(
      await parseAndRunMarkProspectLost('tu1', { reason }, CHAT, meta)
    );
  }

  test('an opt-out IS a terminal Lost', async () => {
    const r = await lost('customer_opted_out');
    expect(r.status).toBe('success');
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Lost');
  });

  test('REFUSAL 1: a decline routes to the LABEL, never the Lost stage', async () => {
    const r = await lost('customer_not_interested');
    expect(r.status).toBe('skipped');
    expect(notInterested).toHaveBeenCalledWith(
      CHAT,
      'customer_said_not_interested',
      'mark_prospect_lost'
    );
    // Stage untouched — the outcome matches what the review's auto-detection does.
    expect(store.get(`chats/${CHAT}`)!.stage).toBeUndefined();
  });

  test('REFUSAL 2: a call dead end with EMAIL open stands down the phone, not the prospect', async () => {
    for (const reason of ['wrong_contact', 'unable_to_reach', 'no_response']) {
      store.reset();
      seedChat();
      const r = await lost(reason);
      expect(r.status).toBe('skipped');
      expect(String(r.message)).toContain('call-channel dead end');
      const chat = store.get(`chats/${CHAT}`)!;
      // The phone closes; the prospect stays workable by email.
      expect(chat.phone_opt_out).toBe(true);
      expect(chat.block_phone).toBe(true);
      expect(chat.stage).toBeUndefined();
    }
  });

  test('the SAME reason IS a Lost once email is gone too', async () => {
    seedChat({ memory: { customer_email: '' } });
    const r = await lost('unable_to_reach');
    expect(r.status).toBe('success');
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Lost');
  });

  test('an opted-out email counts as unreachable, so the close proceeds', async () => {
    seedChat({ email_opt_out: true });
    const r = await lost('no_response');
    expect(r.status).toBe('success');
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Lost');
  });

  test('the two TRUE-Lost reasons are excluded from the call-channel set', () => {
    // The exclusion is the design: those are statements from the person, not channel failures.
    expect(st.CALL_CHANNEL_REASONS.has('customer_opted_out')).toBe(false);
    expect(st.CALL_CHANNEL_REASONS.has('customer_not_interested')).toBe(false);
  });

  test('Lost cancels pending nudges so none fire against a closed prospect', async () => {
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    store.set(`chats/${CHAT}/tasks/t_call`, {
      type: 'call_followup',
      executed: false,
      data: {},
    });
    store.set(`chats/${CHAT}/tasks/t_other`, {
      type: 'reminder',
      executed: false,
      data: {},
    });
    const r = await lost('customer_opted_out');
    expect(String(r.message)).toContain(
      'Cancelled 2 pending follow-up task(s)'
    );
    // Only the nudge types are cancelled; an unrelated reminder is left alone.
    expect(tasks().map((t) => t.type)).toEqual(['reminder']);
  });

  test('an invalid reason is rejected with the valid list', async () => {
    const r = await lost('because_i_said_so');
    expect(r.status).toBe('error');
    for (const reason of VALID_LOST_REASONS) {
      expect(String(r.message)).toContain(reason);
    }
  });

  test('a missing chat is an error, not a crash', async () => {
    store.reset();
    const r = await lost('customer_opted_out');
    expect(r.status).toBe('error');
    expect(String(r.message)).toContain('not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mark_cadence_complete
// ─────────────────────────────────────────────────────────────────────────────

describe('mark_cadence_complete', () => {
  async function complete(reason = 'no reply') {
    return payloadOf(
      await parseAndRunMarkCadenceComplete('tu1', { reason }, CHAT, {
        agent_id: AGENT,
      })
    );
  }

  test('marks the chat cadence-complete and clears queued proactive work', async () => {
    store.set(`chats/${CHAT}/tasks/t_pending`, {
      type: 'outbound_outreach',
      executed: false,
      data: {},
    });
    const r = await complete('email cadence exhausted');
    expect(r.status).toBe('success');
    expect(store.get(`chats/${CHAT}`)!.cadence_complete).toBe(true);
    // Cadence is done → nothing proactive should remain queued.
    expect(tasks()).toHaveLength(0);
  });

  test('it is NOT a stage change and NOT an opt-out', async () => {
    await complete();
    const chat = store.get(`chats/${CHAT}`)!;
    expect(chat.stage).toBeUndefined();
    expect(chat.phone_opt_out).toBe(false);
  });

  test('a spent PHONE cadence with an email fallback flips lane instead of completing', async () => {
    seedChat({
      email_fallback_available: true,
      // ALL of shouldFallbackToEmail's conditions: fallback available, lane is phone, the call cap is
      // reached, the stage shows no engagement, and the email address is reachable.
      call_followup_count: 4,
      memory: { _outreach_lane: 'phone', _email_fallback_available: true },
    });
    const r = await complete('all call attempts made');
    expect(r.status).toBe('success');
    expect(String(r.message)).toContain(
      'switched this prospect to the email lane'
    );
    expect(fallbackLane).toHaveBeenCalled();
    // Crucially: the cadence is NOT closed, because a live channel remains.
    expect(store.get(`chats/${CHAT}`)!.cadence_complete).toBeUndefined();
  });

  test('the fallback pre-check fails OPEN — completion still happens', async () => {
    // No chat doc: the pre-check cannot read anything and must fall through, not throw.
    store.reset();
    const r = await complete();
    expect(r.status).toBe('success');
    expect(fallbackLane).not.toHaveBeenCalled();
  });

  test('a missing chat_id is an error', async () => {
    const r = payloadOf(
      await parseAndRunMarkCadenceComplete('tu1', { reason: 'x' }, '')
    );
    expect(r.status).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clear_not_interested
// ─────────────────────────────────────────────────────────────────────────────

describe('clear_not_interested', () => {
  async function clear() {
    return payloadOf(await parseAndRunClearNotInterested('tu1', {}, CHAT));
  }

  test('removes the label so proactive outreach resumes', async () => {
    seedChat({ labels: ['not_interested', 'vip'] });
    const r = await clear();
    expect(r.status).toBe('success');
    expect(String(r.message)).toContain('re-opened');
    expect(store.get(`chats/${CHAT}`)!.labels).toEqual(['vip']);
  });

  test('it reverses ONLY the label — real consent is left in place', async () => {
    seedChat({
      labels: ['not_interested'],
      phone_opt_out: true,
      email_opt_out: true,
      stage: 'Contacted',
    });
    await clear();
    const chat = store.get(`chats/${CHAT}`)!;
    // The label never set these, so clearing them would override a genuine "stop calling".
    expect(chat.phone_opt_out).toBe(true);
    expect(chat.email_opt_out).toBe(true);
    expect(chat.stage).toBe('Contacted');
  });

  test('removing an absent label is still a success — idempotent', async () => {
    seedChat({ labels: [] });
    const r = await clear();
    expect(r.status).toBe('success');
    // The write succeeds either way, so the tool reports the label as removed. My first version of this
    // test expected the "nothing to remove" message, which is NOT what an absent label produces —
    // `removeLabelFromChat` returns true whenever the arrayRemove UPDATE succeeds, present or not.
    expect(String(r.message)).toContain('re-opened');
    expect(store.get(`chats/${CHAT}`)!.labels).toEqual([]);
  });

  test('the "nothing to remove" message actually reports a failed WRITE', async () => {
    // A quirk preserved from the source: that branch is reached only when removeLabelFromChat returns
    // false, which happens on a Firestore error — not when the label is simply absent. The message is
    // misleading about the cause, but it is the source's, and the status stays `success` either way.
    store.reset(); // no chat doc → the update rejects
    const r = await clear();
    expect(r.status).toBe('success');
    expect(String(r.message)).toContain('nothing to remove');
  });

  test('a missing chat_id is an error', async () => {
    const r = payloadOf(await parseAndRunClearNotInterested('tu1', {}, ''));
    expect(r.status).toBe('error');
  });
});
