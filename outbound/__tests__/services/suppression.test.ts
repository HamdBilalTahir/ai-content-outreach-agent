/**
 * @jest-environment node
 *
 * Email suppression and the unsubscribe token.
 *
 * The properties worth pinning:
 *  - an UNKNOWN reason maps to the HARDEST class, so a new provider event can never widen sending;
 *  - `isSuppressed` fails CLOSED on a storage error — it must never report a clean address it could
 *    not actually read;
 *  - complaint-class and failed-probe-once entries are never auto-lifted, only ops-lifted;
 *  - entries are never deleted, so the audit trail survives a lift.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  CLASS_COMPLAINT,
  CLASS_CONSENT,
  CLASS_DELIVERABILITY,
  COLLECTION,
  classForReason,
  isSuppressed,
  reactivate,
  suppress,
  unsubToken,
  verifyUnsubToken,
} from '../../services/suppression';

const EMAIL = 'a@b.com';

beforeEach(() => {
  store.reset();
  delete process.env.UNSUB_SIGNING_KEY_V1;
});

describe('classForReason — the gate matrix keys on CLASS, not reason', () => {
  it.each([
    ['hard-bounce', CLASS_DELIVERABILITY],
    ['sg-bounce', CLASS_DELIVERABILITY],
    ['sg-block', CLASS_DELIVERABILITY],
    ['sg-invalid', CLASS_DELIVERABILITY],
    ['sg-dropped', CLASS_DELIVERABILITY],
    ['verify-invalid', CLASS_DELIVERABILITY],
    ['unsubscribed', CLASS_CONSENT],
    ['unsubscribed-group', CLASS_CONSENT],
    ['opted-out-by-reply', CLASS_CONSENT],
    ['sg-global-unsub', CLASS_CONSENT],
    ['spam-complaint', CLASS_COMPLAINT],
    ['sg-spam-report', CLASS_COMPLAINT],
  ])('maps %s → %s', (reason, klass) => {
    expect(classForReason(reason)).toBe(klass);
  });

  it('maps an UNKNOWN reason to the hardest class — fail-safe against a new provider event', () => {
    expect(classForReason('some-new-sendgrid-event')).toBe(
      CLASS_DELIVERABILITY
    );
    expect(classForReason('')).toBe(CLASS_DELIVERABILITY);
  });
});

describe('suppress', () => {
  it('creates an active entry with its class and source', async () => {
    expect(await suppress(' A@B.com ', 'hard-bounce', 'webhook')).toBe(true);
    const d = store.get(`${COLLECTION}/${EMAIL}`)!; // doc id is the lowercased address
    expect(d.class).toBe(CLASS_DELIVERABILITY);
    expect(d.reason).toBe('hard-bounce');
    expect(d.active).toBe(true);
    expect(d.sources).toEqual(['webhook']);
  });

  it('is idempotent, appending only NEW sources', async () => {
    await suppress(EMAIL, 'hard-bounce', 'webhook');
    await suppress(EMAIL, 'hard-bounce', 'webhook');
    await suppress(EMAIL, 'hard-bounce', 'live-check');
    const d = store.get(`${COLLECTION}/${EMAIL}`)!;
    expect(d.sources).toEqual(['webhook', 'live-check']);
    expect(d.re_suppressed_at).toBeTruthy();
  });

  it('does NOT overwrite the original class on re-suppression', async () => {
    // The first reason is the record; a later event must not rewrite history.
    await suppress(EMAIL, 'spam-complaint');
    await suppress(EMAIL, 'hard-bounce');
    expect(store.get(`${COLLECTION}/${EMAIL}`)!.class).toBe(CLASS_COMPLAINT);
  });

  it('marks a re-suppressed probe-once lift as permanently unliftable', async () => {
    store.set(`${COLLECTION}/${EMAIL}`, {
      class: CLASS_DELIVERABILITY,
      reason: 'hard-bounce',
      active: false,
      reactivated_by: 'inbound-email-probe-once',
    });
    await suppress(EMAIL, 'hard-bounce');
    const d = store.get(`${COLLECTION}/${EMAIL}`)!;
    expect(d.probe_once_failed).toBe(true);
    expect(d.active).toBe(true);
  });

  it('refuses a non-address', async () => {
    expect(await suppress('notanemail', 'hard-bounce')).toBe(false);
    expect(await suppress('', 'hard-bounce')).toBe(false);
    expect(store.docs.size).toBe(0);
  });
});

describe('isSuppressed', () => {
  it('returns null for an address with no entry', async () => {
    await expect(isSuppressed(EMAIL)).resolves.toBeNull();
    await expect(isSuppressed('')).resolves.toBeNull();
  });

  it('returns the active entry with its class', async () => {
    await suppress(EMAIL, 'unsubscribed');
    await expect(isSuppressed('A@B.COM')).resolves.toEqual({
      class: CLASS_CONSENT,
      reason: 'unsubscribed',
      probe_once_failed: false,
    });
  });

  it('treats a lifted entry as clear', async () => {
    await suppress(EMAIL, 'hard-bounce');
    await reactivate(EMAIL, 'policy');
    await expect(isSuppressed(EMAIL)).resolves.toBeNull();
  });

  it('derives the class from the reason when the stored class is missing', async () => {
    store.set(`${COLLECTION}/${EMAIL}`, {
      reason: 'sg-spam-report',
      active: true,
    });
    const r = await isSuppressed(EMAIL);
    expect(r?.class).toBe(CLASS_COMPLAINT);
  });

  it('fails CLOSED on a storage error — never report a clean address it could not read', async () => {
    const err = new Error('firestore down');
    const spy = jest.spyOn(store.docs, 'get').mockImplementation(() => {
      throw err;
    });
    try {
      const r = await isSuppressed(EMAIL);
      expect(r).not.toBeNull();
      expect(r!.class).toBe(CLASS_DELIVERABILITY);
      expect(r!.reason).toBe('suppression-store-error');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('reactivate — entries are never deleted', () => {
  it('flips active to false and preserves the trail', async () => {
    await suppress(EMAIL, 'hard-bounce');
    expect(await reactivate(EMAIL, 'policy', 'auto')).toBe(true);
    const d = store.get(`${COLLECTION}/${EMAIL}`)!;
    expect(d.active).toBe(false);
    expect(d.reactivated_by).toBe('policy');
    expect(d.reactivated_actor).toBe('auto');
    expect(d.prior_reason).toBe('hard-bounce'); // the record survives the lift
  });

  it('REFUSES an auto-lift of a complaint-class entry', async () => {
    await suppress(EMAIL, 'spam-complaint');
    expect(await reactivate(EMAIL, 'policy')).toBe(false);
    expect(store.get(`${COLLECTION}/${EMAIL}`)!.active).toBe(true);
  });

  it('REFUSES an auto-lift of an already-failed probe-once entry', async () => {
    store.set(`${COLLECTION}/${EMAIL}`, {
      class: CLASS_DELIVERABILITY,
      reason: 'hard-bounce',
      active: true,
      probe_once_failed: true,
    });
    expect(await reactivate(EMAIL, 'policy')).toBe(false);
  });

  it('allows an explicit OPS lift of either refused case', async () => {
    await suppress(EMAIL, 'spam-complaint');
    expect(await reactivate(EMAIL, 'ops', 'hamd')).toBe(true);
    expect(store.get(`${COLLECTION}/${EMAIL}`)!.active).toBe(false);
  });

  it('returns true when there is nothing to lift — that is the desired end state', async () => {
    await expect(reactivate('nobody@nowhere.com', 'policy')).resolves.toBe(
      true
    );
  });

  it('returns false for a falsy address', async () => {
    await expect(reactivate('', 'policy')).resolves.toBe(false);
  });
});

describe('the unsubscribe token', () => {
  it('is empty (links disabled) with no signing key, rather than forgeable', () => {
    expect(unsubToken(EMAIL)).toBe('');
    expect(verifyUnsubToken(EMAIL, 'anything')).toBe(false);
  });

  it('is deterministic and version-prefixed, so it validates with no lookup', () => {
    process.env.UNSUB_SIGNING_KEY_V1 = 'secret';
    const t = unsubToken(EMAIL);
    expect(t).toBe(unsubToken(EMAIL));
    expect(t.startsWith('1')).toBe(true);
    expect(t).toHaveLength(24); // "1" + 23 hex chars
  });

  it('is address-specific and case-insensitive on the address', () => {
    process.env.UNSUB_SIGNING_KEY_V1 = 'secret';
    expect(unsubToken('A@B.com')).toBe(unsubToken('a@b.com'));
    expect(unsubToken('x@y.com')).not.toBe(unsubToken(EMAIL));
  });

  it('round-trips its own token and rejects everything else', () => {
    process.env.UNSUB_SIGNING_KEY_V1 = 'secret';
    const t = unsubToken(EMAIL);
    expect(verifyUnsubToken(EMAIL, t)).toBe(true);
    expect(verifyUnsubToken(EMAIL, ` ${t} `)).toBe(true); // trimmed
    expect(verifyUnsubToken('other@b.com', t)).toBe(false);
    expect(verifyUnsubToken(EMAIL, '')).toBe(false);
    expect(verifyUnsubToken(EMAIL, '2' + t.slice(1))).toBe(false); // wrong version
    expect(verifyUnsubToken(EMAIL, '1' + 'f'.repeat(23))).toBe(false);
  });

  it('rejects a wrong-length token without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so the length is checked first.
    process.env.UNSUB_SIGNING_KEY_V1 = 'secret';
    expect(() => verifyUnsubToken(EMAIL, '1abc')).not.toThrow();
    expect(verifyUnsubToken(EMAIL, '1abc')).toBe(false);
  });

  it('changes with the signing key, so rotation invalidates old tokens', () => {
    process.env.UNSUB_SIGNING_KEY_V1 = 'k1';
    const a = unsubToken(EMAIL);
    process.env.UNSUB_SIGNING_KEY_V1 = 'k2';
    expect(unsubToken(EMAIL)).not.toBe(a);
    expect(verifyUnsubToken(EMAIL, a)).toBe(false);
  });
});
