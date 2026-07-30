/**
 * @jest-environment node
 *
 * The remaining Phase 4 guards: the voice concurrency ledger, pause/resume, the not-interested
 * handler, voice routing, the feature-flag reader, and the pure DNC/verification normalizers.
 *
 * Two fail directions are asserted explicitly because they are opposite and load-bearing:
 * `tryReserveVoiceSlot` fails CLOSED (never exceed capacity), while `isEnabled` failing closed means
 * screening is SKIPPED rather than every lead blocked.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  activeVoiceCount,
  reconcileVoiceSlots,
  releaseVoiceSlot,
  tryReserveVoiceSlot,
} from '../../services/voiceConcurrency';
import {
  PAUSED_LABEL,
  pauseChat,
  pauseChats,
  rescheduleFrozenTasks,
  resumeChat,
  resumeChats,
} from '../../services/chatPause';
import { handleNotInterested } from '../../services/notInterested';
import { NOT_INTERESTED_LABEL } from '../../services/chat';
import {
  extractCustomerPhone,
  findAgentByAssistantId,
  resolveOutboundAgentForInbound,
  resolveOutboundAgentId,
} from '../../services/voiceRouting';
import { clearFlagCache, isEnabled } from '../../firebase/featureFlags';
import { normalizePhone } from '../../services/dncFullScrub';
import { decide } from '../../services/phoneScreening';

const SLOT_DOC = 'settings/outbound_voice_concurrency';
const CHAT = 'outbound__ag1__15551230000';

function futureIso(min = 20): string {
  return new Date(Date.now() + min * 60_000).toISOString();
}
function pastIso(min = 20): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

beforeEach(() => {
  store.reset();
  clearFlagCache();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the voice concurrency ledger', () => {
  it('grants up to the cap, then refuses', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await tryReserveVoiceSlot(`chat${i}`, 3)).toBe(true);
    }
    expect(await tryReserveVoiceSlot('chat3', 3)).toBe(false);
    expect(await activeVoiceCount()).toBe(3);
  });

  it('is idempotent per chat — a re-reserve does not double-count', async () => {
    expect(await tryReserveVoiceSlot(CHAT, 1)).toBe(true);
    expect(await tryReserveVoiceSlot(CHAT, 1)).toBe(true); // same chat, still granted
    expect(await activeVoiceCount()).toBe(1);
    // But a DIFFERENT chat is now at capacity.
    expect(await tryReserveVoiceSlot('other', 1)).toBe(false);
  });

  it('has NO hot-prospect bypass — the cap is absolute', async () => {
    await tryReserveVoiceSlot('a', 1);
    // There is no argument that widens the cap; only the cap value itself does.
    expect(await tryReserveVoiceSlot('hot-prospect', 1)).toBe(false);
  });

  it('treats an expired slot as free, so a dropped webhook cannot wedge capacity', async () => {
    store.set(SLOT_DOC, {
      active_slots: {
        stale: { chat_id: 'stale', expires_at: pastIso(60) },
      },
    });
    expect(await activeVoiceCount()).toBe(0);
    expect(await tryReserveVoiceSlot(CHAT, 1)).toBe(true);
  });

  it('purges expired slots in the same transaction as the reserve', async () => {
    store.set(SLOT_DOC, {
      active_slots: {
        stale: { chat_id: 'stale', expires_at: pastIso(60) },
        live: { chat_id: 'live', expires_at: futureIso() },
      },
    });
    await tryReserveVoiceSlot(CHAT, 5);
    const slots = store.get(SLOT_DOC)!.active_slots as Record<string, unknown>;
    expect(Object.keys(slots).sort()).toEqual(['live', CHAT].sort());
  });

  it('ignores a slot with a missing or unparseable expiry', async () => {
    store.set(SLOT_DOC, {
      active_slots: {
        noexp: { chat_id: 'noexp' },
        bad: { chat_id: 'bad', expires_at: 'garbage' },
      },
    });
    expect(await activeVoiceCount()).toBe(0);
  });

  it('disables the gate entirely for a non-positive cap', async () => {
    expect(await tryReserveVoiceSlot(CHAT, 0)).toBe(true);
    expect(await tryReserveVoiceSlot(CHAT, -1)).toBe(true);
    expect(store.get(SLOT_DOC)).toBeUndefined(); // nothing written
  });

  it('fails CLOSED on a storage error — never risk exceeding capacity', async () => {
    const spy = jest.spyOn(store.docs, 'get').mockImplementation(() => {
      throw new Error('firestore down');
    });
    try {
      expect(await tryReserveVoiceSlot(CHAT, 5)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a falsy chat id', async () => {
    expect(await tryReserveVoiceSlot('', 5)).toBe(false);
  });

  it('releases a held slot and is idempotent about it', async () => {
    await tryReserveVoiceSlot(CHAT, 5);
    expect(await releaseVoiceSlot(CHAT)).toBe(true);
    expect(await activeVoiceCount()).toBe(0);
    expect(await releaseVoiceSlot(CHAT)).toBe(false); // already gone
    expect(await releaseVoiceSlot('')).toBe(false);
  });

  it('releasing one chat leaves another chat’s live slot intact', async () => {
    await tryReserveVoiceSlot('a', 5);
    await tryReserveVoiceSlot('b', 5);
    await releaseVoiceSlot('a');
    const slots = store.get(SLOT_DOC)!.active_slots as Record<string, unknown>;
    expect(Object.keys(slots)).toEqual(['b']);
  });

  it('reconcile drops the expired and reports the live count', async () => {
    store.set(SLOT_DOC, {
      active_slots: {
        s1: { chat_id: 's1', expires_at: pastIso(60) },
        s2: { chat_id: 's2', expires_at: futureIso() },
      },
    });
    expect(await reconcileVoiceSlots()).toBe(1);
    const slots = store.get(SLOT_DOC)!.active_slots as Record<string, unknown>;
    expect(Object.keys(slots)).toEqual(['s2']);
  });

  it('reconcile is a no-op with no ledger document', async () => {
    expect(await reconcileVoiceSlots()).toBe(0);
    expect(await activeVoiceCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pause / resume', () => {
  beforeEach(() => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      status: 'active',
      memory: { timezone: 'America/New_York' },
    });
  });

  it('pausing freezes at the QUERY layer — status only, no task writes', async () => {
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'outbound_outreach',
      executed: false,
      execute_at: new Date('2026-07-01T12:00:00Z'),
    });
    expect(await pauseChat(CHAT, 'ops')).toBe(true);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d.status).toBe('paused');
    expect(d.paused_by).toBe('ops');
    expect(d.paused_at).toBeTruthy();
    expect(d.status_changed_at).toBeTruthy();
    expect(d.labels).toContain(PAUSED_LABEL);
    // The task itself is untouched — that is the point.
    const t = store.get(`chats/${CHAT}/tasks/t1`)!;
    expect(t.executed).toBe(false);
    expect(t.execute_at).toEqual(new Date('2026-07-01T12:00:00Z'));
  });

  it('refuses to pause an already-paused or ARCHIVED chat', async () => {
    store.set(`chats/${CHAT}`, { status: 'paused' });
    expect(await pauseChat(CHAT)).toBe(false);
    store.set(`chats/${CHAT}`, { status: 'archived' });
    expect(await pauseChat(CHAT)).toBe(false);
    store.set(`chats/${CHAT}`, { status: 'active', archived: true });
    expect(await pauseChat(CHAT)).toBe(false);
  });

  it('refuses to pause a nonexistent chat rather than creating one', async () => {
    expect(await pauseChat('nope')).toBe(false);
    expect(await pauseChat('')).toBe(false);
    expect(store.get('chats/nope')).toBeUndefined();
  });

  it('resume only acts on a chat that is actually paused', async () => {
    expect(await resumeChat(CHAT)).toEqual({ resumed: false, rescheduled: 0 });
    store.set(`chats/${CHAT}`, { status: 'archived' });
    expect(await resumeChat(CHAT)).toEqual({ resumed: false, rescheduled: 0 });
    expect(store.get(`chats/${CHAT}`)!.status).toBe('archived'); // no accidental un-archive
  });

  it('resume clears the pause fields and reschedules the OVERDUE tasks only', async () => {
    store.set(`chats/${CHAT}/tasks/overdue`, {
      type: 'outbound_outreach',
      executed: false,
      execute_at: new Date('2020-01-01T00:00:00Z'),
    });
    const future = new Date(Date.now() + 86_400_000);
    store.set(`chats/${CHAT}/tasks/future`, {
      type: 'followup_if_no_reply',
      executed: false,
      execute_at: future,
    });
    await pauseChat(CHAT);

    const r = await resumeChat(CHAT);
    expect(r.resumed).toBe(true);
    expect(r.rescheduled).toBe(1);

    const d = store.get(`chats/${CHAT}`)!;
    expect(d.status).toBe('active');
    expect(d.paused_at).toBeNull();
    expect(d.paused_by).toBeNull();
    expect(d.labels ?? []).not.toContain(PAUSED_LABEL);

    // The overdue one moved forward; the future one did not.
    const moved = store.get(`chats/${CHAT}/tasks/overdue`)!.execute_at as Date;
    expect(moved.getTime()).toBeGreaterThan(Date.now());
    expect(store.get(`chats/${CHAT}/tasks/future`)!.execute_at).toEqual(future);
  });

  it('leaves terminal tasks alone', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    store.set(`chats/${CHAT}/tasks/skipped`, {
      executed: false,
      skipped: true,
      execute_at: old,
    });
    store.set(`chats/${CHAT}/tasks/dead`, {
      executed: false,
      permanent_failure: true,
      execute_at: old,
    });
    expect(await rescheduleFrozenTasks(CHAT, { timezone: 'UTC' })).toBe(0);
    expect(store.get(`chats/${CHAT}/tasks/skipped`)!.execute_at).toEqual(old);
    expect(store.get(`chats/${CHAT}/tasks/dead`)!.execute_at).toEqual(old);
  });

  it('reschedules a task with NO execute_at, which would otherwise never be selected', async () => {
    store.set(`chats/${CHAT}/tasks/noat`, { executed: false });
    expect(await rescheduleFrozenTasks(CHAT, { timezone: 'UTC' })).toBe(1);
    expect(store.get(`chats/${CHAT}/tasks/noat`)!.execute_at).toBeInstanceOf(
      Date
    );
  });

  it('jitters the backlog so a chat’s tasks do not all fire in one tick', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    for (const id of ['a', 'b', 'c']) {
      store.set(`chats/${CHAT}/tasks/${id}`, {
        executed: false,
        execute_at: old,
      });
    }
    expect(await rescheduleFrozenTasks(CHAT, { timezone: 'UTC' })).toBe(3);
    const times = ['a', 'b', 'c'].map((id) =>
      (store.get(`chats/${CHAT}/tasks/${id}`)!.execute_at as Date).getTime()
    );
    expect(new Set(times).size).toBe(3);
  });

  it('bulk pause and resume report what actually changed', async () => {
    store.set('chats/c1', { status: 'active', memory: {} });
    store.set('chats/c2', { status: 'archived', memory: {} });
    const paused = await pauseChats(['c1', 'c2', 'missing']);
    expect(paused).toEqual({ paused: 1, chat_ids: ['c1'] });

    const resumed = await resumeChats(['c1', 'c2']);
    expect(resumed.resumed).toBe(1);
    expect(resumed.chat_ids).toEqual(['c1']);
  });

  it('bulk helpers tolerate nullish input', async () => {
    expect(await pauseChats(null)).toEqual({ paused: 0, chat_ids: [] });
    expect(await resumeChats(undefined)).toEqual({
      resumed: 0,
      rescheduled: 0,
      chat_ids: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('handleNotInterested — a label, not an opt-out and not a stage', () => {
  beforeEach(() => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      stage: 'Contacted',
      phone_opt_out: false,
      email_opt_out: false,
      memory: { phone_number: '+15551230000', customer_email: 'a@b.com' },
    });
  });

  it('labels the chat and cancels every pending task', async () => {
    store.set(`chats/${CHAT}/tasks/t1`, { type: 'followup', executed: false });
    store.set(`chats/${CHAT}/tasks/t2`, { type: 'callback', executed: false });
    store.set(`chats/${CHAT}/tasks/done`, { type: 'followup', executed: true });

    const r = await handleNotInterested(CHAT);
    expect(r.ok).toBe(true);
    expect(r.labelled).toBe(true);
    expect(r.cancelled_tasks).toBe(2);
    expect(store.get(`chats/${CHAT}`)!.labels).toContain(NOT_INTERESTED_LABEL);
    expect(store.get(`chats/${CHAT}/tasks/t1`)).toBeUndefined();
    expect(store.get(`chats/${CHAT}/tasks/done`)).toBeDefined(); // executed ones survive
  });

  it('leaves the STAGE and every OPT-OUT flag untouched — the whole distinction', async () => {
    await handleNotInterested(CHAT);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d.stage).toBe('Contacted'); // not Lost
    expect(d.phone_opt_out).toBe(false);
    expect(d.email_opt_out).toBe(false);
    expect(d.sms_opt_out).toBeUndefined();
    expect(d.block_phone).toBeUndefined();
  });

  it('writes the memory marker for prompt/UI visibility', async () => {
    await handleNotInterested(
      CHAT,
      'declined_on_call',
      'review_call_transcript'
    );
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._not_interested).toBe(true);
    expect(m._not_interested_reason).toBe('declined_on_call');
    expect(m._not_interested_source).toBe('review_call_transcript');
    expect(m._not_interested_at).toBeTruthy();
  });

  it('is idempotent and reports that it was already set', async () => {
    await handleNotInterested(CHAT);
    const second = await handleNotInterested(CHAT);
    expect(second.ok).toBe(true);
    expect(second.already).toBe(true);
    expect(store.get(`chats/${CHAT}`)!.labels).toEqual([NOT_INTERESTED_LABEL]);
  });

  it('refuses a falsy chat id', async () => {
    expect(await handleNotInterested('')).toEqual({
      ok: false,
      error: 'no chat_id',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('voice routing', () => {
  it('prefers the agent that OWNS a phone number when several share an assistant', async () => {
    store.set('agents/shared1', { voice_agent_assistant_id: 'asst1' });
    store.set('agents/shared2', { voice_agent_assistant_id: 'asst1' });
    store.set('phone_numbers/p1', { agent_id: 'shared2' });
    await expect(findAgentByAssistantId('asst1')).resolves.toBe('shared2');
  });

  it('returns the sole match without the ownership probe', async () => {
    store.set('agents/only', { voice_agent_assistant_id: 'asst1' });
    await expect(findAgentByAssistantId('asst1')).resolves.toBe('only');
  });

  it('falls back to the first match when none owns a number', async () => {
    store.set('agents/a1', { voice_agent_assistant_id: 'asst1' });
    store.set('agents/a2', { voice_agent_assistant_id: 'asst1' });
    await expect(findAgentByAssistantId('asst1')).resolves.toBe('a1');
  });

  it('is null with no match or no assistant id', async () => {
    await expect(findAgentByAssistantId('nope')).resolves.toBeNull();
    await expect(findAgentByAssistantId('')).resolves.toBeNull();
    await expect(findAgentByAssistantId(null)).resolves.toBeNull();
  });

  it('resolves an outbound call via the FROM number’s owner first', async () => {
    store.set('phone_numbers/pn1', { oversee_agent_id: 'ownerAgent' });
    store.set('agents/fallbackAgent', { voice_agent_assistant_id: 'asst1' });
    await expect(
      resolveOutboundAgentId(
        { phone_call: { phone_number_id: 'pn1' } },
        'asst1'
      )
    ).resolves.toBe('ownerAgent');
  });

  it('accepts the alternate metadata key for the phone number id', async () => {
    store.set('phone_numbers/pn1', { agent_id: 'ownerAgent' });
    await expect(
      resolveOutboundAgentId({
        phone_call: { agent_phone_number_id: 'pn1' },
      })
    ).resolves.toBe('ownerAgent');
  });

  it('falls back to the assistant match when the number does not resolve', async () => {
    store.set('agents/fallbackAgent', { voice_agent_assistant_id: 'asst1' });
    await expect(
      resolveOutboundAgentId({ phone_call: {} }, 'asst1')
    ).resolves.toBe('fallbackAgent');
    await expect(resolveOutboundAgentId(null, 'asst1')).resolves.toBe(
      'fallbackAgent'
    );
  });

  it('resolves an INBOUND call via the CALLED number’s owner', async () => {
    store.set('phone_numbers/pn1', {
      phone_number: '+15550001111',
      oversee_agent_id: 'ownerAgent',
    });
    await expect(
      resolveOutboundAgentForInbound('+15550001111', 'asst1')
    ).resolves.toBe('ownerAgent');
  });

  it('extracts the customer phone, preferring external_number over the Twilio body', () => {
    expect(
      extractCustomerPhone({
        phone_call: { external_number: '+15551112222' },
        body: { From: '+19998887777' },
      })
    ).toBe('+15551112222');
    expect(extractCustomerPhone({ body: { From: '+19998887777' } })).toBe(
      '+19998887777'
    );
    expect(extractCustomerPhone({ body: { To: '+19998887777' } })).toBe(
      '+19998887777'
    );
    expect(extractCustomerPhone({})).toBeNull();
    expect(extractCustomerPhone(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the feature-flag reader', () => {
  it('reads an enabled flag', async () => {
    store.set('feature_flags/full_scrub_gate', { enabled: true });
    await expect(isEnabled('full_scrub_gate')).resolves.toBe(true);
  });

  it('fails closed for a missing document, a false flag, or a falsy name', async () => {
    await expect(isEnabled('never_created')).resolves.toBe(false);
    store.set('feature_flags/off', { enabled: false });
    await expect(isEnabled('off')).resolves.toBe(false);
    await expect(isEnabled('')).resolves.toBe(false);
  });

  it('caches within the TTL, so a per-contact read is not a per-contact query', async () => {
    store.set('feature_flags/f', { enabled: true });
    await expect(isEnabled('f')).resolves.toBe(true);
    // Flip the underlying doc; the cached value should still win.
    store.set('feature_flags/f', { enabled: false });
    await expect(isEnabled('f')).resolves.toBe(true);
    clearFlagCache();
    await expect(isEnabled('f')).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePhone — the 10-digit NANP form the scrub API takes', () => {
  it('strips formatting and a leading country 1', () => {
    expect(normalizePhone('+1 (707) 527-6405')).toBe('7075276405');
    expect(normalizePhone('17075276405')).toBe('7075276405');
    expect(normalizePhone('7075276405')).toBe('7075276405');
  });

  it('takes the last 10 digits of a longer international number', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('2079460958');
  });

  it('returns a short number unpadded, so the caller can reject it', () => {
    expect(normalizePhone('12345')).toBe('12345');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('phoneScreening.decide — ported and tested, though the CNAM gate is disabled', () => {
  it('allows a confirmed business on any line type', () => {
    expect(decide('mobile', 'business')).toBe(false);
    expect(decide('voip', 'business', true)).toBe(false);
  });

  it('blocks a consumer', () => {
    expect(decide('landline', 'consumer')).toBe(true);
  });

  it('allows UNKNOWN only on a landline', () => {
    expect(decide('landline', 'unknown')).toBe(false);
    expect(decide('mobile', 'unknown')).toBe(true);
    expect(decide('voip', 'unknown')).toBe(true);
    expect(decide('unknown', 'unknown')).toBe(true);
  });

  it('fails CLOSED in business_only mode for anything unconfirmed', () => {
    expect(decide('landline', 'unknown', true)).toBe(true);
    expect(decide('landline', 'consumer', true)).toBe(true);
  });

  it('passes a website-verified number in business_only mode, any line type', () => {
    expect(decide('mobile', 'unknown', true, true)).toBe(false);
  });
});
