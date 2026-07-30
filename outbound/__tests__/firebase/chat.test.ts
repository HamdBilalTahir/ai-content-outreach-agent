/**
 * @jest-environment node
 *
 * Firestore-touching operations in `firebase/chat.ts`: memory, tasks, labels, message writes.
 *
 * The two things most worth pinning down: `setMemory` must not clobber sibling keys (several
 * writers touch memory during one turn), and `updateTaskFailure` must distinguish "ran
 * successfully" from "gave up" — the cron's retry behaviour depends on that pair of flags.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  addLabelToChat,
  addMessagesToChat,
  createTaskWithId,
  deleteTask,
  deleteUnexecutedTasksByType,
  getChatMessages,
  getMemory,
  getTask,
  incrementUnreadCount,
  removeLabelFromChat,
  setMemory,
  updateTask,
  updateTaskFailure,
  updateTaskStatus,
} from '../../firebase/chat';

const CHAT = 'chat1';

beforeEach(() => {
  store.reset();
  store.set(`chats/${CHAT}`, { type: 'outbound' });
});

describe('getMemory / setMemory', () => {
  it('creates an empty memory map when the field is absent', async () => {
    expect(await getMemory(CHAT)).toEqual({});
    expect(store.get(`chats/${CHAT}`)!.memory).toEqual({});
  });

  it('returns {} for a missing chat', async () => {
    expect(await getMemory('nope')).toEqual({});
  });

  it('merges keys WITHOUT clobbering siblings', async () => {
    // The dot-path write is the whole point: a read-modify-write of the map would drop concurrent
    // writes from the other writers that touch memory during a single turn.
    store.set(`chats/${CHAT}`, {
      memory: {
        phone_number: '3035550123',
        first_name: 'Dana',
        timezone: 'America/Denver',
      },
    });

    await setMemory(CHAT, { phone_opt_out: 'Y' });

    expect(await getMemory(CHAT)).toEqual({
      phone_number: '3035550123',
      first_name: 'Dana',
      timezone: 'America/Denver',
      phone_opt_out: 'Y',
    });
  });

  it('overwrites only the named key', async () => {
    store.set(`chats/${CHAT}`, { memory: { stage: 'New', keep: 1 } });
    await setMemory(CHAT, { stage: 'Contacted' });
    expect(await getMemory(CHAT)).toEqual({ stage: 'Contacted', keep: 1 });
  });

  it('returns false for a missing chat rather than creating one', async () => {
    expect(await setMemory('nope', { a: 1 })).toBe(false);
    expect(store.get('chats/nope')).toBeUndefined();
  });
});

describe('tasks', () => {
  it('seeds executed=false so the cron query can select the task', async () => {
    const taskId = await createTaskWithId(
      CHAT,
      'outbound_outreach',
      new Date('2026-03-04T09:00:00Z'),
      {
        notes: 'begin outreach',
      }
    );
    expect(taskId).toBeTruthy();

    const task = store.get(`chats/${CHAT}/tasks/${taskId}`)!;
    expect(task.executed).toBe(false);
    expect(task.permanent_failure).toBe(false);
    expect(task.type).toBe('outbound_outreach');
    expect(task.data).toEqual({ notes: 'begin outreach' });
  });

  it('getTask attaches task_id and returns {} when absent', async () => {
    const taskId = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    expect((await getTask(CHAT, taskId)).task_id).toBe(taskId);
    expect(await getTask(CHAT, 'ghost')).toEqual({});
  });

  it('updateTask stamps updated_at and returns false for a missing task', async () => {
    const taskId = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    expect(await updateTask(CHAT, taskId, { executed: true })).toBe(true);
    expect(
      store.get(`chats/${CHAT}/tasks/${taskId}`)!.updated_at
    ).toBeInstanceOf(Date);
    expect(await updateTask(CHAT, 'ghost', { executed: true })).toBe(false);
  });

  it('updateTaskStatus flips executed', async () => {
    const taskId = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    await updateTaskStatus(CHAT, taskId, true);
    expect(store.get(`chats/${CHAT}/tasks/${taskId}`)!.executed).toBe(true);
  });

  it('deleteTask returns false for a missing task', async () => {
    expect(await deleteTask(CHAT, 'ghost')).toBe(false);
  });

  it('deleteUnexecutedTasksByType removes only pending tasks of that type', async () => {
    const a = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    const b = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    const c = (await createTaskWithId(CHAT, 'callback', new Date()))!;
    await updateTaskStatus(CHAT, b, true); // already executed — must survive

    expect(await deleteUnexecutedTasksByType(CHAT, 'followup')).toBe(1);
    expect(store.get(`chats/${CHAT}/tasks/${a}`)).toBeUndefined();
    expect(store.get(`chats/${CHAT}/tasks/${b}`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/${c}`)).toBeDefined();
  });
});

describe('updateTaskFailure', () => {
  it('reschedules with 10 -> 20 -> 40 minute backoff', async () => {
    const taskId = (await createTaskWithId(CHAT, 'followup', new Date()))!;

    for (const [attempt, expectedMinutes] of [
      [1, 10],
      [2, 20],
    ] as const) {
      const before = Date.now();
      await updateTaskFailure(CHAT, taskId, 'transient', false, 3, 10);
      const task = store.get(`chats/${CHAT}/tasks/${taskId}`)!;
      expect(task.retry_count).toBe(attempt);
      expect(task.executed).toBeFalsy(); // reopened so the backoff tick re-selects it
      const delayMinutes =
        ((task.execute_at as Date).getTime() - before) / 60_000;
      expect(delayMinutes).toBeGreaterThanOrEqual(expectedMinutes - 0.1);
      expect(delayMinutes).toBeLessThan(expectedMinutes + 1);
    }
  });

  it('marks permanent failure once maxRetries is reached, with BOTH flags', async () => {
    // executed=true + permanent_failure=true is what distinguishes "gave up" from "ran fine".
    const taskId = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    await updateTaskFailure(CHAT, taskId, 'e1', false, 2, 10);
    await updateTaskFailure(CHAT, taskId, 'e2', false, 2, 10);

    const task = store.get(`chats/${CHAT}/tasks/${taskId}`)!;
    expect(task.executed).toBe(true);
    expect(task.permanent_failure).toBe(true);
    expect(task.status).toBe('permanently_failed');
    expect(task.failure_reason).toBe('e2');
  });

  it('honours an explicit permanent failure on the first attempt', async () => {
    const taskId = (await createTaskWithId(CHAT, 'followup', new Date()))!;
    await updateTaskFailure(CHAT, taskId, 'unrecoverable', true);
    const task = store.get(`chats/${CHAT}/tasks/${taskId}`)!;
    expect(task.permanent_failure).toBe(true);
    expect(task.retry_count).toBe(1);
  });
});

describe('labels', () => {
  it('is idempotent — the same label is never duplicated', async () => {
    // Callers apply not_interested / cadence_complete from several paths.
    await addLabelToChat(CHAT, 'not_interested');
    await addLabelToChat(CHAT, 'not_interested');
    expect(store.get(`chats/${CHAT}`)!.labels).toEqual(['not_interested']);
  });

  it('accumulates distinct labels and removes one without touching the rest', async () => {
    await addLabelToChat(CHAT, 'paused');
    await addLabelToChat(CHAT, 'area_code_unscrubbable');
    await removeLabelFromChat(CHAT, 'paused');
    expect(store.get(`chats/${CHAT}`)!.labels).toEqual([
      'area_code_unscrubbable',
    ]);
  });

  it('returns false for a missing chat', async () => {
    expect(await addLabelToChat('nope', 'x')).toBe(false);
  });
});

describe('incrementUnreadCount', () => {
  it('increments atomically', async () => {
    await incrementUnreadCount(CHAT);
    await incrementUnreadCount(CHAT);
    expect(store.get(`chats/${CHAT}`)!.unread_count).toBe(2);
  });
});

describe('addMessagesToChat', () => {
  it('writes messages with strictly increasing timestamps from the base', async () => {
    const base = new Date('2026-03-04T12:00:00.000Z');
    const ids = await addMessagesToChat(
      CHAT,
      [
        { role: 'user', content: [{ text: 'a' }] },
        { role: 'assistant', content: [{ text: 'b' }] },
      ],
      true, // playground: skip the v3 read models
      base
    );

    expect(ids).toHaveLength(2);
    const stamps = store
      .collection(`chats/${CHAT}/messages`)
      .map(([, d]) => (d.timestamp as Date).getTime())
      .sort((a, b) => a - b);
    expect(stamps).toEqual([base.getTime(), base.getTime() + 1]);
  });

  it('normalizes content on the way in', async () => {
    await addMessagesToChat(
      CHAT,
      [{ role: 'user', content: 'bare string' }],
      true
    );
    const [, doc] = store.collection(`chats/${CHAT}/messages`)[0];
    expect(doc.content).toEqual([{ text: 'bare string' }]);
  });

  it('bumps the chat updatedAt', async () => {
    await addMessagesToChat(
      CHAT,
      [{ role: 'user', content: [{ text: 'a' }] }],
      true
    );
    expect(store.get(`chats/${CHAT}`)!.updatedAt).toBeInstanceOf(Date);
  });

  it('returns null when the batch would exceed the Firestore 500-op limit', async () => {
    // 500 messages + 1 chat update = 501 operations.
    const many = Array.from({ length: 500 }, () => ({
      role: 'user',
      content: [{ text: 'x' }],
    }));
    expect(await addMessagesToChat(CHAT, many, true)).toBeNull();
    expect(store.collection(`chats/${CHAT}/messages`)).toHaveLength(0);
  });

  it('accepts exactly 499 messages', async () => {
    const many = Array.from({ length: 499 }, () => ({
      role: 'user',
      content: [{ text: 'x' }],
    }));
    expect(await addMessagesToChat(CHAT, many, true)).toHaveLength(499);
  });
});

describe('getChatMessages', () => {
  it('returns messages in chronological order, normalized', async () => {
    const base = new Date('2026-03-04T12:00:00.000Z');
    await addMessagesToChat(
      CHAT,
      [
        { role: 'user', content: [{ text: 'first' }] },
        { role: 'assistant', content: [{ text: 'second' }] },
      ],
      true,
      base
    );

    const msgs = await getChatMessages(CHAT);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].content).toEqual([{ text: 'first' }]);
  });

  it('with a limit, returns the most recent N restored to chronological order', async () => {
    const base = new Date('2026-03-04T12:00:00.000Z');
    await addMessagesToChat(
      CHAT,
      [
        { role: 'user', content: [{ text: 'm1' }] },
        { role: 'assistant', content: [{ text: 'm2' }] },
        { role: 'user', content: [{ text: 'm3' }] },
      ],
      true,
      base
    );

    const msgs = await getChatMessages(CHAT, 2);
    expect(msgs.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'm2',
      'm3',
    ]);
  });

  it('returns [] for a chat with no messages', async () => {
    expect(await getChatMessages(CHAT)).toEqual([]);
  });
});
