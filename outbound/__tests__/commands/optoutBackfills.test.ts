/**
 * @jest-environment node
 *
 * The opt-out and email-state backfills.
 *
 * These run against production data, so the properties worth pinning are all about what they REFUSE to do:
 *
 *  - **`backfillOptoutFlags` never clears a top-level opt-out.** It raises and seeds only. Reversing that
 *    would let a stale memory field silently re-open a channel the customer closed.
 *  - **`backfillEmailOptoutChatFlags` posts no duplicate notes on a re-run**, via `only_if_missing`.
 *  - **A `dryRun` reports the counters a real run would produce**, so the numbers can be trusted. A dry run
 *    that undercounted would be worse than none.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/emailCompliance', () => {
  const actual = jest.requireActual('../../services/emailCompliance');
  return { ...actual, flagChatsForEmailEvent: jest.fn() };
});
jest.mock('../../services/suppression', () => {
  const actual = jest.requireActual('../../services/suppression');
  return { ...actual, suppress: jest.fn() };
});
jest.mock('../../services/chat', () => ({
  getOutboundChatByEmail: jest.fn(),
  getWebChatByEmail: jest.fn(),
}));

import { store } from '../../testSupport/mockFirestore';
import {
  backfillEmailOptoutChatFlags,
  backfillEmailSuppression,
  backfillLastInboundEmailAt,
  backfillOptoutFlags,
  dispositionForClass,
} from '../../commands/optoutBackfills';
import { flagChatsForEmailEvent } from '../../services/emailCompliance';
import { suppress } from '../../services/suppression';
import { getOutboundChatByEmail, getWebChatByEmail } from '../../services/chat';

/** The chat doc as it stands after the backfill. */
function chat(id: string): Record<string, unknown> {
  return (store.get(`chats/${id}`) ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (flagChatsForEmailEvent as jest.Mock).mockResolvedValue('chat_1');
  (suppress as jest.Mock).mockResolvedValue(true);
  (getOutboundChatByEmail as jest.Mock).mockResolvedValue(null);
  (getWebChatByEmail as jest.Mock).mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillOptoutFlags
// ─────────────────────────────────────────────────────────────────────────────

describe('backfillOptoutFlags', () => {
  it('seeds all three keys from memory when they are absent', async () => {
    store.set('chats/c1', {
      type: 'outbound',
      memory: { _email_opt_out: true, sms_opt_out: 'Y' },
    });
    const out = await backfillOptoutFlags();
    expect(out).toEqual({ scanned: 1, changed: 1, dry_run: false });
    expect(chat('c1')).toMatchObject({
      email_opt_out: true,
      // Absent from memory → seeded false, not left missing. The gates read these keys directly.
      phone_opt_out: false,
      sms_opt_out: true,
    });
  });

  it('accepts either "Y" or true as a memory opt-out', async () => {
    store.set('chats/c1', {
      type: 'outbound',
      memory: { _email_opt_out: ' y ', phone_opt_out: true },
    });
    await backfillOptoutFlags();
    expect(chat('c1')).toMatchObject({
      email_opt_out: true,
      phone_opt_out: true,
    });
  });

  it('reads block_phone as well as phone_opt_out — both spellings are live', async () => {
    store.set('chats/c1', { type: 'outbound', memory: { block_phone: 'Y' } });
    await backfillOptoutFlags();
    expect(chat('c1').phone_opt_out).toBe(true);
  });

  it('NEVER flips a top-level true back to false', async () => {
    // The chat doc is the trustworthy record. If it says the customer opted out and memory disagrees, the
    // chat doc wins — any other rule lets a stale field re-open a closed channel.
    store.set('chats/c1', {
      type: 'outbound',
      email_opt_out: true,
      phone_opt_out: true,
      sms_opt_out: true,
      memory: {},
    });
    const out = await backfillOptoutFlags();
    expect(out.changed).toBe(0);
    expect(chat('c1')).toMatchObject({
      email_opt_out: true,
      phone_opt_out: true,
      sms_opt_out: true,
    });
  });

  it('raises an existing false when memory says opted out', async () => {
    store.set('chats/c1', {
      type: 'outbound',
      email_opt_out: false,
      memory: { _email_opt_out: true },
    });
    await backfillOptoutFlags();
    expect(chat('c1').email_opt_out).toBe(true);
  });

  it('writes nothing when every key already agrees', async () => {
    store.set('chats/c1', {
      type: 'outbound',
      email_opt_out: false,
      phone_opt_out: false,
      sms_opt_out: false,
      memory: {},
    });
    expect((await backfillOptoutFlags()).changed).toBe(0);
  });

  it('ignores a non-outbound chat', async () => {
    store.set('chats/web_1', { type: 'web', memory: { _email_opt_out: true } });
    expect((await backfillOptoutFlags()).scanned).toBe(0);
  });

  it('counts but does not write under dryRun', async () => {
    store.set('chats/c1', {
      type: 'outbound',
      memory: { _email_opt_out: true },
    });
    const out = await backfillOptoutFlags({ dryRun: true });
    expect(out).toEqual({ scanned: 1, changed: 1, dry_run: true });
    expect(chat('c1').email_opt_out).toBeUndefined();
  });

  it('keeps going when one chat fails to update', async () => {
    store.set('chats/c1', {
      type: 'outbound',
      memory: { _email_opt_out: true },
    });
    store.set('chats/c2', {
      type: 'outbound',
      memory: { _email_opt_out: true },
    });
    const spy = jest.spyOn(store.docs, 'set').mockImplementationOnce(() => {
      throw new Error('firestore down');
    });
    try {
      expect((await backfillOptoutFlags()).changed).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillLastInboundEmailAt
// ─────────────────────────────────────────────────────────────────────────────

describe('backfillLastInboundEmailAt', () => {
  function seedThreaded(id: string, mem: Record<string, unknown> = {}) {
    store.set(`chats/${id}`, {
      memory: { _last_inbound_email_message_id: '<abc@mail>', ...mem },
    });
  }

  it('stamps from the LATEST inbound email', async () => {
    seedThreaded('c1');
    store.set('chats/c1/messages_v3/m1', {
      source: 'email',
      direction: 'inbound',
      timestamp: '2026-07-01T00:00:00Z',
    });
    store.set('chats/c1/messages_v3/m2', {
      source: 'email',
      direction: 'inbound',
      timestamp: '2026-07-20T00:00:00Z',
    });
    const out = await backfillLastInboundEmailAt();
    expect(out).toEqual({ stamped: 1, dry_run: false });
    expect(
      (chat('c1').memory as Record<string, unknown>)._last_inbound_email_at
    ).toBe('2026-07-20T00:00:00Z');
  });

  it('SKIPS a chat that already carries the stamp', async () => {
    seedThreaded('c1', { _last_inbound_email_at: '2026-06-01T00:00:00Z' });
    store.set('chats/c1/messages_v3/m1', {
      source: 'email',
      direction: 'inbound',
      timestamp: '2026-07-20T00:00:00Z',
    });
    expect((await backfillLastInboundEmailAt()).stamped).toBe(0);
  });

  it('skips a chat with no INBOUND email to stamp from', async () => {
    seedThreaded('c1');
    store.set('chats/c1/messages_v3/m1', {
      source: 'email',
      direction: 'outbound',
      timestamp: '2026-07-20T00:00:00Z',
    });
    expect((await backfillLastInboundEmailAt()).stamped).toBe(0);
  });

  it('EXCLUDES a chat with no threading anchor at all', async () => {
    // Ordering on the anchor is what scopes the run: Firestore's order_by drops documents missing the
    // field, which is exactly the set that has never received email.
    store.set('chats/c1', { memory: {} });
    expect((await backfillLastInboundEmailAt()).stamped).toBe(0);
  });

  it('converts a Firestore Date to ISO', async () => {
    seedThreaded('c1');
    store.set('chats/c1/messages_v3/m1', {
      source: 'email',
      direction: 'inbound',
      timestamp: new Date('2026-07-20T12:34:56Z'),
    });
    await backfillLastInboundEmailAt();
    expect(
      (chat('c1').memory as Record<string, unknown>)._last_inbound_email_at
    ).toBe('2026-07-20T12:34:56.000Z');
  });

  it('counts but does not write under dryRun', async () => {
    seedThreaded('c1');
    store.set('chats/c1/messages_v3/m1', {
      source: 'email',
      direction: 'inbound',
      timestamp: '2026-07-20T00:00:00Z',
    });
    expect(await backfillLastInboundEmailAt({ dryRun: true })).toEqual({
      stamped: 1,
      dry_run: true,
    });
    expect(
      (chat('c1').memory as Record<string, unknown>)._last_inbound_email_at
    ).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillEmailSuppression
// ─────────────────────────────────────────────────────────────────────────────

describe('backfillEmailSuppression', () => {
  it('seeds from a chat flagged in memory', async () => {
    store.set('chats/c1', {
      memory: { _email_opt_out: true, customer_email: 'A@Acme.com' },
    });
    const out = await backfillEmailSuppression();
    expect(out).toEqual({ total: 1, dry_run: false });
    expect(suppress).toHaveBeenCalledWith(
      'a@acme.com',
      'opted-out-by-reply',
      'backfill:chat:c1'
    );
  });

  it('seeds from a Lost-by-opt-out chat, reading the reason from either place', async () => {
    store.set('chats/c1', {
      stage: 'Lost',
      lost_reason: 'customer_opted_out',
      memory: { customer_email: 'a@acme.com' },
    });
    store.set('chats/c2', {
      stage: 'Lost',
      memory: { lost_reason: 'customer_opted_out', email: 'b@acme.com' },
    });
    expect((await backfillEmailSuppression()).total).toBe(2);
    expect(suppress).toHaveBeenCalledWith(
      'a@acme.com',
      'unsubscribed',
      'backfill:lost:c1'
    );
  });

  it('ignores a Lost chat lost for another reason', async () => {
    store.set('chats/c1', {
      stage: 'Lost',
      lost_reason: 'not_interested',
      memory: { customer_email: 'a@acme.com' },
    });
    expect((await backfillEmailSuppression()).total).toBe(0);
  });

  it('skips a chat with no address on record', async () => {
    store.set('chats/c1', { memory: { _email_opt_out: true } });
    expect((await backfillEmailSuppression()).total).toBe(0);
  });

  it('skips the SendGrid half with no key, and says so', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await backfillEmailSuppression();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      // @ts-expect-error -- restoring the global
      delete global.fetch;
    }
  });

  it('pages every SendGrid list and records each list’s own reason', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => [{ email: 'X@Acme.com' }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await backfillEmailSuppression({ sendgridApiKey: 'SG.k' });
      // Five lists, one short page each — so one request per list and no second page.
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(out.total).toBe(5);
      expect(suppress).toHaveBeenCalledWith(
        'x@acme.com',
        'sg-bounce',
        'backfill:suppression/bounces'
      );
      expect(suppress).toHaveBeenCalledWith(
        'x@acme.com',
        'sg-global-unsub',
        'backfill:asm/suppressions/global'
      );
    } finally {
      // @ts-expect-error -- restoring the global
      delete global.fetch;
    }
  });

  it('SKIPS a failing SendGrid list without losing the Firestore passes', async () => {
    // Losing the vendor's view of history must not cost us our own.
    store.set('chats/c1', {
      memory: { _email_opt_out: true, customer_email: 'a@acme.com' },
    });
    const fetchMock = jest.fn().mockRejectedValue(new Error('401'));
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      expect(
        (await backfillEmailSuppression({ sendgridApiKey: 'SG.k' })).total
      ).toBe(1);
    } finally {
      // @ts-expect-error -- restoring the global
      delete global.fetch;
    }
  });

  it('counts but does not suppress under dryRun', async () => {
    store.set('chats/c1', {
      memory: { _email_opt_out: true, customer_email: 'a@acme.com' },
    });
    expect(await backfillEmailSuppression({ dryRun: true })).toEqual({
      total: 1,
      dry_run: true,
    });
    expect(suppress).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillEmailOptoutChatFlags
// ─────────────────────────────────────────────────────────────────────────────

describe('dispositionForClass', () => {
  it('maps consent and complaint to an OPT-OUT', () => {
    expect(dispositionForClass('consent').opt_out).toBe(true);
    expect(dispositionForClass('complaint').opt_out).toBe(true);
  });

  it('maps deliverability AND an unknown class to INVALID', () => {
    // Deliberate: an unrecognised reason is the case `classForReason` blocks hardest, so treating it as a
    // delivery failure is the conservative reading.
    expect(dispositionForClass('deliverability').invalid).toBe(true);
    expect(dispositionForClass('something_new').invalid).toBe(true);
  });
});

describe('backfillEmailOptoutChatFlags', () => {
  function suppression(email: string, data: Record<string, unknown> = {}) {
    store.set(`email_suppression/${email}`, {
      reason: 'unsubscribed',
      ...data,
    });
  }

  it('flags each active entry with only_if_missing, so a re-run posts no duplicate notes', async () => {
    suppression('a@acme.com', { class: 'consent' });
    const out = await backfillEmailOptoutChatFlags();
    expect(out).toEqual({ scanned: 1, chats_flagged: 1, dry_run: false });
    expect(flagChatsForEmailEvent).toHaveBeenCalledWith(
      'a@acme.com',
      expect.objectContaining({ opt_out: true, only_if_missing: true })
    );
  });

  it('derives the class from the reason when none is stored', async () => {
    suppression('a@acme.com', { reason: 'sg-bounce' });
    await backfillEmailOptoutChatFlags();
    expect(flagChatsForEmailEvent).toHaveBeenCalledWith(
      'a@acme.com',
      expect.objectContaining({ invalid: true })
    );
  });

  it('SKIPS an entry lifted on record', async () => {
    // `active: false` is a reactivation — treat it as cleared rather than re-closing the channel.
    suppression('a@acme.com', { active: false });
    const out = await backfillEmailOptoutChatFlags();
    expect(out.scanned).toBe(1);
    expect(flagChatsForEmailEvent).not.toHaveBeenCalled();
  });

  it('skips a doc id that is not an address', async () => {
    suppression('not-an-address');
    expect((await backfillEmailOptoutChatFlags()).chats_flagged).toBe(0);
    expect(flagChatsForEmailEvent).not.toHaveBeenCalled();
  });

  it('does not count an entry whose chat could not be found', async () => {
    suppression('a@acme.com');
    (flagChatsForEmailEvent as jest.Mock).mockResolvedValue(null);
    expect((await backfillEmailOptoutChatFlags()).chats_flagged).toBe(0);
  });

  it('RESOLVES the chat under dryRun, so the count reflects real pending writes', async () => {
    // Counting every suppression entry would report work that will not happen — only addresses with a chat
    // change anything.
    suppression('a@acme.com', { class: 'consent' });
    suppression('b@acme.com', { class: 'consent' });
    (getOutboundChatByEmail as jest.Mock).mockImplementation(
      async (e: string) => (e === 'a@acme.com' ? 'chat_a' : null)
    );
    const out = await backfillEmailOptoutChatFlags({ dryRun: true });
    expect(out).toEqual({ scanned: 2, chats_flagged: 1, dry_run: true });
    expect(flagChatsForEmailEvent).not.toHaveBeenCalled();
  });

  it('falls back to a WEB chat under dryRun when there is no outbound one', async () => {
    suppression('a@acme.com');
    (getWebChatByEmail as jest.Mock).mockResolvedValue('web_1');
    expect(
      (await backfillEmailOptoutChatFlags({ dryRun: true })).chats_flagged
    ).toBe(1);
  });

  it('treats a failed dry-run lookup as "no chat" rather than erroring', async () => {
    suppression('a@acme.com');
    (getOutboundChatByEmail as jest.Mock).mockRejectedValue(new Error('down'));
    expect(
      (await backfillEmailOptoutChatFlags({ dryRun: true })).chats_flagged
    ).toBe(0);
  });
});
