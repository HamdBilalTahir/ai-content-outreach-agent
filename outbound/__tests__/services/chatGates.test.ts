/**
 * @jest-environment node
 *
 * The outbound consent/gate matrix — the part of `services/chat` a mistake in is most expensive,
 * because a wrong answer means contacting someone who asked us not to, or silently freezing a
 * prospect nobody notices.
 *
 * Three properties are asserted deliberately and repeatedly:
 *
 *  1. **Gates read the TRUSTWORTHY top-level keys, never `memory`.** `memory` is LLM-writable, so a
 *     gate that read consent from it could be talked out of blocking by the model. The one narrow
 *     memory fallback fires only when the top-level key is ABSENT (a pre-seeding chat).
 *  2. **`"N"` means NOT opted out.** A plain truthiness check reads the string `"N"` as blocked,
 *     which would silently re-gate a channel that was just reopened. Every flag type this key has
 *     been written as over the codebase's history is covered.
 *  3. **"Not interested" is neither an opt-out nor a stage.** It stops proactive outreach only.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  CADENCE_COMPLETE_KEY,
  NOT_INTERESTED_LABEL,
  REFERRAL_TRANSFERRED_LABEL,
  cadenceExhausted,
  callAwaitingReview,
  capturePhoneConsent,
  clearCadenceComplete,
  emailInvalid,
  emailOptedOut,
  failOutboundTask,
  getFollowupCounts,
  hasEmailFallback,
  hasReachableChannel,
  isCadenceComplete,
  isNotInterested,
  isTerminalStage,
  markTaskSkipped,
  phoneOptedOut,
  recentDialBlocks,
  resetFollowupCounts,
  setCadenceComplete,
  shouldBlockManualLead,
  shouldFallbackToEmail,
  smsOptedOut,
  stopsProactive,
  taskChannelOpen,
} from '../../services/chat';

const CHAT = 'outbound__agentA__15551230000';

/** A reachable chat: phone and email on file, nothing opted out. */
function reachable(over: Record<string, unknown> = {}) {
  return {
    type: 'outbound',
    phone_opt_out: false,
    email_opt_out: false,
    memory: { phone_number: '+15551230000', customer_email: 'a@b.com' },
    ...over,
  };
}

beforeEach(() => {
  store.reset();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('opt-out value normalization — every type this flag has been written as', () => {
  it.each([
    [true, true],
    ['Y', true],
    ['y', true],
    ['YES', true],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    [1, true],
  ])('treats %p as OPTED OUT', (value, expected) => {
    expect(phoneOptedOut({ phone_opt_out: value } as never)).toBe(expected);
  });

  it.each([
    [false, false],
    ['N', false],
    ['n', false],
    ['NO', false],
    ['false', false],
    [0, false],
    [null, false],
    ['', false],
    [undefined, false],
  ])('treats %p as NOT opted out', (value, expected) => {
    expect(phoneOptedOut({ phone_opt_out: value } as never)).toBe(expected);
  });

  it('does not read "N" as truthy — the bug this normalization exists to prevent', () => {
    // A bare truthiness check would make "N" (meaning "do NOT block") re-gate the phone channel.
    expect(
      phoneOptedOut({ phone_opt_out: 'N', block_phone: 'N' } as never)
    ).toBe(false);
  });
});

describe('gates read the top-level key, not memory', () => {
  it('ignores a memory opt-out when that key IS present at the top level and false', () => {
    // The LLM-writable side says blocked; the code-owned side says open. Open wins.
    expect(
      phoneOptedOut({
        phone_opt_out: false,
        memory: { phone_opt_out: 'Y' },
      } as never)
    ).toBe(false);
    expect(
      emailOptedOut({
        email_opt_out: false,
        memory: { _email_opt_out: true },
      } as never)
    ).toBe(false);
  });

  it('still honours a memory `block_phone` even when top-level `phone_opt_out` is false', () => {
    // Not a contradiction: `phoneOptedOut` consults TWO independent top-level keys, each with its
    // own fallback. Chat creation seeds `phone_opt_out`/`email_opt_out` but NOT `block_phone`, so
    // top-level `block_phone` is absent on every chat and its memory fallback is permanently live.
    // The asymmetry errs toward BLOCKING, which is the safe direction for a consent gate — a
    // "cleanup" that made this return false would un-gate contacts the DNC path had blocked.
    expect(
      phoneOptedOut({
        phone_opt_out: false,
        memory: { block_phone: 'Y' },
      } as never)
    ).toBe(true);
    // Explicitly reopening the channel writes top-level `block_phone: "N"`, which then wins.
    expect(
      phoneOptedOut({
        phone_opt_out: false,
        block_phone: 'N',
        memory: { block_phone: 'Y' },
      } as never)
    ).toBe(false);
  });

  it('falls back to memory ONLY when the top-level key is absent (pre-seeding chat)', () => {
    expect(phoneOptedOut({ memory: { phone_opt_out: 'Y' } } as never)).toBe(
      true
    );
    expect(phoneOptedOut({ memory: { block_phone: 'Y' } } as never)).toBe(true);
    expect(emailOptedOut({ memory: { _email_opt_out: true } } as never)).toBe(
      true
    );
    expect(smsOptedOut({ memory: { sms_opt_out: 'Y' } } as never)).toBe(true);
    expect(emailInvalid({ memory: { _email_invalid: true } } as never)).toBe(
      true
    );
  });

  it('blocks the phone via either top-level key', () => {
    expect(phoneOptedOut({ phone_opt_out: true } as never)).toBe(true);
    expect(phoneOptedOut({ block_phone: 'Y' } as never)).toBe(true);
  });
});

describe('emailInvalid is a bad mailbox, not a consent decision', () => {
  it('closes email but leaves the phone reachable', () => {
    const d = reachable({ email_invalid: true });
    expect(emailInvalid(d as never)).toBe(true);
    expect(emailOptedOut(d as never)).toBe(false); // NOT a consent flag
    expect(phoneOptedOut(d as never)).toBe(false);
    expect(hasReachableChannel(d as never)).toBe(true); // phone keeps them reachable
  });

  it('makes a chat unreachable when it is the only channel', () => {
    const d = {
      email_invalid: true,
      memory: { customer_email: 'a@b.com' },
    };
    expect(hasReachableChannel(d as never)).toBe(false);
  });
});

describe('hasReachableChannel — presence AND consent', () => {
  it('is true when either channel is fully open', () => {
    expect(hasReachableChannel(reachable() as never)).toBe(true);
    expect(
      hasReachableChannel(
        reachable({ memory: { phone_number: '+15551230000' } }) as never
      )
    ).toBe(true);
    expect(
      hasReachableChannel(
        reachable({ memory: { customer_email: 'a@b.com' } }) as never
      )
    ).toBe(true);
  });

  it('is false when a channel is on file but opted out', () => {
    expect(
      hasReachableChannel({
        phone_opt_out: true,
        email_opt_out: true,
        memory: { phone_number: '+1555', customer_email: 'a@b.com' },
      } as never)
    ).toBe(false);
  });

  it('is false when no channel is on file at all', () => {
    expect(hasReachableChannel({ memory: {} } as never)).toBe(false);
    expect(hasReachableChannel({} as never)).toBe(false);
    expect(hasReachableChannel(null)).toBe(false);
  });

  it('treats whitespace as absent', () => {
    expect(
      hasReachableChannel({
        memory: { phone_number: '   ', customer_email: '  ' },
      } as never)
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the proactive-stop labels are not opt-outs and not a stage', () => {
  it('stops proactive outreach for both stop labels', () => {
    expect(stopsProactive({ labels: [NOT_INTERESTED_LABEL] })).toBe(true);
    expect(stopsProactive({ labels: [REFERRAL_TRANSFERRED_LABEL] })).toBe(true);
  });

  it('does NOT treat a highlight label as a stop label', () => {
    // The NEW chat created by a referral transfer carries `referral`, which must stay active.
    expect(stopsProactive({ labels: ['referral'] })).toBe(false);
    expect(stopsProactive({ labels: ['phone_consent_captured'] })).toBe(false);
    expect(stopsProactive({ labels: [] })).toBe(false);
    expect(stopsProactive({})).toBe(false);
  });

  it('isNotInterested is specific to its own label', () => {
    expect(isNotInterested({ labels: [NOT_INTERESTED_LABEL] })).toBe(true);
    expect(isNotInterested({ labels: [REFERRAL_TRANSFERRED_LABEL] })).toBe(
      false
    );
  });

  it('leaves the consent flags and the stage untouched — that is the whole distinction', () => {
    const d = reachable({ labels: [NOT_INTERESTED_LABEL], stage: 'Contacted' });
    expect(stopsProactive(d as never)).toBe(true);
    expect(phoneOptedOut(d as never)).toBe(false);
    expect(emailOptedOut(d as never)).toBe(false);
    expect(isTerminalStage(d as never)).toBe(false);
    // Still reachable: an inbound reply can re-open the conversation.
    expect(hasReachableChannel(d as never)).toBe(true);
  });
});

describe('terminal stage', () => {
  it.each(['Lost', 'lost', 'closed_lost', ' LOST '])(
    'treats %p as terminal',
    (stage) => {
      expect(isTerminalStage({ stage })).toBe(true);
    }
  );

  it.each(['Lead', 'Contacted', 'New', '', undefined])(
    'treats %p as non-terminal',
    (stage) => {
      expect(isTerminalStage({ stage } as never)).toBe(false);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe('taskChannelOpen — gating task CREATION, not just execution', () => {
  it('requires the phone open for a call-type task', () => {
    expect(taskChannelOpen(reachable() as never, 'callback')).toBe(true);
    expect(
      taskChannelOpen(reachable({ phone_opt_out: true }) as never, 'callback')
    ).toBe(false);
    expect(
      taskChannelOpen(
        { memory: { customer_email: 'a@b.com' } } as never,
        'callback'
      )
    ).toBe(false); // no number on file
  });

  it('requires email open for an email-type task', () => {
    expect(taskChannelOpen(reachable() as never, 'followup_if_no_reply')).toBe(
      true
    );
    expect(
      taskChannelOpen(
        reachable({ email_opt_out: true }) as never,
        'followup_if_no_reply'
      )
    ).toBe(false);
  });

  it('treats every call-family type as a call', () => {
    const blocked = reachable({ phone_opt_out: true });
    for (const t of [
      'outbound_call',
      'callback',
      'call_followup',
      'voice_call_followup',
      'check_if_call_succeeded',
    ]) {
      expect(taskChannelOpen(blocked as never, t)).toBe(false);
    }
  });

  it('lets a channel-neutral outreach through on ANY open channel', () => {
    // The skill picks the channel, so only full unreachability blocks it.
    expect(
      taskChannelOpen(
        reachable({ phone_opt_out: true }) as never,
        'outbound_outreach'
      )
    ).toBe(true);
    expect(
      taskChannelOpen(
        {
          phone_opt_out: true,
          email_opt_out: true,
          memory: { phone_number: '+1555', customer_email: 'a@b.com' },
        } as never,
        'outbound_outreach'
      )
    ).toBe(false);
  });

  it('defaults an UNKNOWN type to any-open, so a new type fails safe rather than closed', () => {
    expect(taskChannelOpen(reachable() as never, 'some_future_type')).toBe(
      true
    );
  });

  it('honours an explicit channel over the type-derived one', () => {
    const emailOnlyBlocked = reachable({ email_opt_out: true });
    expect(
      taskChannelOpen(emailOnlyBlocked as never, 'reminder', 'email')
    ).toBe(false);
    expect(taskChannelOpen(emailOnlyBlocked as never, 'reminder', 'call')).toBe(
      true
    );
  });

  it('gates sms on the sms flag, not the phone flag', () => {
    expect(
      taskChannelOpen(reachable({ sms_opt_out: true }) as never, '', 'sms')
    ).toBe(false);
    expect(taskChannelOpen(reachable() as never, '', 'sms')).toBe(true);
  });

  it('refuses everything once a stop label is present, whatever the channel', () => {
    const stopped = reachable({ labels: [NOT_INTERESTED_LABEL] });
    expect(taskChannelOpen(stopped as never, 'outbound_outreach')).toBe(false);
    expect(taskChannelOpen(stopped as never, 'callback')).toBe(false);
    expect(taskChannelOpen(stopped as never, '', 'email')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cadence-complete marker', () => {
  it('round-trips through the top-level key with a reason', async () => {
    store.set(`chats/${CHAT}`, reachable());
    expect(await setCadenceComplete(CHAT, 'phone_cap_reached')).toBe(true);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d[CADENCE_COMPLETE_KEY]).toBe(true);
    expect(d.cadence_complete_reason).toBe('phone_cap_reached');
    expect(isCadenceComplete(d as never)).toBe(true);
  });

  it('truncates a runaway reason to 200 chars', async () => {
    store.set(`chats/${CHAT}`, reachable());
    await setCadenceComplete(CHAT, 'x'.repeat(500));
    expect(
      store.get(`chats/${CHAT}`)!.cadence_complete_reason as string
    ).toHaveLength(200);
  });

  it('is cleared by a reopen, which is what an inbound reply triggers', async () => {
    store.set(`chats/${CHAT}`, reachable());
    await setCadenceComplete(CHAT);
    await clearCadenceComplete(CHAT);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d[CADENCE_COMPLETE_KEY]).toBe(false);
    expect(d.cadence_reopened_at).toBeTruthy();
    expect(isCadenceComplete(d as never)).toBe(false);
  });

  it('returns false for a falsy chat id rather than writing anything', async () => {
    expect(await setCadenceComplete('')).toBe(false);
    expect(store.docs.size).toBe(0);
  });
});

describe('follow-up counters', () => {
  it('reads zero for a chat that has none', async () => {
    store.set(`chats/${CHAT}`, reachable());
    expect(await getFollowupCounts(CHAT)).toEqual({ email: 0, call: 0 });
  });

  it('resets both counters — a reply starts a fresh cadence', async () => {
    store.set(
      `chats/${CHAT}`,
      reachable({ email_followup_count: 3, call_followup_count: 2 })
    );
    await resetFollowupCounts(CHAT);
    expect(await getFollowupCounts(CHAT)).toEqual({ email: 0, call: 0 });
  });
});

describe('cadenceExhausted — per-lane, count-based', () => {
  it('counts CALL follow-ups on the phone lane', () => {
    expect(
      cadenceExhausted({ _outreach_lane: 'phone', call_followup_count: 3 })
    ).toBe(false);
    expect(
      cadenceExhausted({ _outreach_lane: 'phone', call_followup_count: 4 })
    ).toBe(true);
    // The email count is irrelevant on the phone lane.
    expect(
      cadenceExhausted({ _outreach_lane: 'phone', email_followup_count: 99 })
    ).toBe(false);
  });

  it('counts EMAIL follow-ups on the email lane, which is the default', () => {
    expect(cadenceExhausted({ email_followup_count: 3 })).toBe(false);
    expect(cadenceExhausted({ email_followup_count: 4 })).toBe(true);
    expect(
      cadenceExhausted({ _outreach_lane: 'email', email_followup_count: 4 })
    ).toBe(true);
  });

  it('falls back to the chat-doc counter when memory has none', () => {
    expect(cadenceExhausted({}, { email_followup_count: 4 })).toBe(true);
  });
});

describe('shouldFallbackToEmail — the test-only phone-first escape hatch', () => {
  const eligible = {
    memory: {
      _email_fallback_available: true,
      _outreach_lane: 'phone' as const,
      call_followup_count: 4,
      customer_email: 'a@b.com',
    },
    doc: {
      email_fallback_available: true,
      stage: 'Contacted',
      email_opt_out: false,
      memory: { customer_email: 'a@b.com' },
    },
  };

  it('fires when every condition holds', () => {
    expect(shouldFallbackToEmail(eligible.memory, eligible.doc as never)).toBe(
      true
    );
  });

  it('is false for a real record, which never carries the flag', () => {
    const mem = { ...eligible.memory, _email_fallback_available: undefined };
    expect(
      shouldFallbackToEmail(mem, {
        ...eligible.doc,
        email_fallback_available: undefined,
      } as never)
    ).toBe(false);
  });

  it('is false before the phone cap is reached', () => {
    expect(
      shouldFallbackToEmail(
        { ...eligible.memory, call_followup_count: 3 },
        eligible.doc as never
      )
    ).toBe(false);
  });

  it('is false on the email lane — there is nothing to fall back to', () => {
    expect(
      shouldFallbackToEmail(
        { ...eligible.memory, _outreach_lane: 'email' },
        eligible.doc as never
      )
    ).toBe(false);
  });

  it('is false once the prospect engaged, since a phone engagement clears the flag', () => {
    for (const stage of ['Engaged', 'Lead', 'Lost']) {
      expect(
        shouldFallbackToEmail(eligible.memory, {
          ...eligible.doc,
          stage,
        } as never)
      ).toBe(false);
    }
  });

  it('is false when email is unreachable — opted out, invalid, or absent', () => {
    expect(
      shouldFallbackToEmail(eligible.memory, {
        ...eligible.doc,
        email_opt_out: true,
      } as never)
    ).toBe(false);
    expect(
      shouldFallbackToEmail(eligible.memory, {
        ...eligible.doc,
        email_invalid: true,
      } as never)
    ).toBe(false);
    expect(
      shouldFallbackToEmail(eligible.memory, {
        ...eligible.doc,
        memory: {},
      } as never)
    ).toBe(false);
  });

  it('hasEmailFallback accepts either the top-level flag or the memory mirror', () => {
    expect(hasEmailFallback({ email_fallback_available: true })).toBe(true);
    expect(hasEmailFallback({ _email_fallback_available: true })).toBe(true);
    expect(
      hasEmailFallback({ memory: { _email_fallback_available: true } })
    ).toBe(true);
    expect(hasEmailFallback({})).toBe(false);
    expect(hasEmailFallback(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('recentDialBlocks — the structural stop for the repeat-dial storm', () => {
  const now = new Date('2026-07-30T18:00:00Z');
  const minsAgo = (n: number) =>
    new Date(now.getTime() - n * 60_000).toISOString();

  it('allows the first ever dial', () => {
    expect(recentDialBlocks({}, now).blocked).toBe(false);
    expect(recentDialBlocks(null, now).blocked).toBe(false);
  });

  it('blocks inside the 30-minute recency floor', () => {
    const r = recentDialBlocks({ _last_outbound_call_at: minsAgo(5) }, now);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('recency floor');
  });

  it('blocks a prior call that is still awaiting review', () => {
    const r = recentDialBlocks(
      { _last_outbound_call_at: minsAgo(120) }, // past the floor, never reviewed
      now
    );
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('awaiting review');
  });

  it('allows once the prior call was reviewed', () => {
    expect(
      recentDialBlocks(
        {
          _last_outbound_call_at: minsAgo(120),
          _last_call_reviewed_at: minsAgo(60),
        },
        now
      ).blocked
    ).toBe(false);
  });

  it('fails OPEN past the awaiting-review maximum, so a chat is never frozen forever', () => {
    // 7h > the 6h default: the review never ran, but outreach must continue.
    expect(
      recentDialBlocks({ _last_outbound_call_at: minsAgo(420) }, now).blocked
    ).toBe(false);
  });

  it('does NOT block a legitimate multi-day follow-up cadence', () => {
    expect(
      recentDialBlocks(
        {
          _last_outbound_call_at: minsAgo(60 * 48),
          _last_call_reviewed_at: minsAgo(60 * 47),
        },
        now
      ).blocked
    ).toBe(false);
  });

  it('treats a future stamp as recent — clock skew prefers the safe answer', () => {
    const r = recentDialBlocks({ _last_outbound_call_at: minsAgo(-30) }, now);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('clock skew');
  });

  it('falls back to the first-call stamp when the last-call one is missing', () => {
    expect(
      recentDialBlocks({ _first_outbound_call_at: minsAgo(5) }, now).blocked
    ).toBe(true);
  });

  it('reads a naive (zone-less) stamp as UTC rather than local time', () => {
    // A local-time reading would shift by the host offset and flip the decision.
    expect(
      recentDialBlocks({ _last_outbound_call_at: '2026-07-30T17:55:00' }, now)
        .blocked
    ).toBe(true);
  });
});

describe('callAwaitingReview', () => {
  it('is false with no call on record', () => {
    expect(callAwaitingReview({})).toBe(false);
  });

  it('is true for a placed call never reviewed', () => {
    expect(
      callAwaitingReview({ _last_outbound_call_at: '2026-07-30T10:00:00Z' })
    ).toBe(true);
  });

  it('is true when the review predates the call', () => {
    expect(
      callAwaitingReview({
        _last_outbound_call_at: '2026-07-30T10:00:00Z',
        _last_call_reviewed_at: '2026-07-29T10:00:00Z',
      })
    ).toBe(true);
  });

  it('is false once reviewed after the call', () => {
    expect(
      callAwaitingReview({
        _last_outbound_call_at: '2026-07-30T10:00:00Z',
        _last_call_reviewed_at: '2026-07-30T11:00:00Z',
      })
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('capturePhoneConsent — an email reply with a number is written consent', () => {
  beforeEach(() => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      phone_opt_out: true,
      block_phone: 'Y',
      memory: { customer_email: 'a@b.com' },
    });
  });

  it('reopens the phone channel on the TRUSTWORTHY top-level keys', async () => {
    expect(await capturePhoneConsent(CHAT, ' +1 555 987 6543 ')).toBe(true);
    const d = store.get(`chats/${CHAT}`)!;
    expect(d.phone_opt_out).toBe(false);
    expect(d.block_phone).toBe('N');
    // The gate itself must now read open — that is the point of the top-level flip.
    expect(phoneOptedOut(d as never)).toBe(false);
    expect(hasReachableChannel(d as never)).toBe(true);
  });

  it('records the number and the consent audit artifact in memory', async () => {
    await capturePhoneConsent(CHAT, '+15559876543', {
      pewc: true,
      message_id: 'm1',
    });
    const mem = (store.get(`chats/${CHAT}`)!.memory ?? {}) as Record<
      string,
      unknown
    >;
    expect(mem.phone_number).toBe('+15559876543');
    const consent = mem._phone_consent as Record<string, unknown>;
    expect(consent.source).toBe('email_reply');
    expect(consent.pewc).toBe(true);
    expect(consent.message_id).toBe('m1');
    expect(mem._phone_consent_at).toBe(consent.at);
  });

  it('labels the chat for the UI', async () => {
    await capturePhoneConsent(CHAT, '+15559876543');
    expect(store.get(`chats/${CHAT}`)!.labels).toContain(
      'phone_consent_captured'
    );
  });

  it('drops null/undefined proof entries rather than storing them', async () => {
    await capturePhoneConsent(CHAT, '+15559876543', {
      pewc: null,
      snippet: undefined,
      ok: false,
    });
    const consent = (
      (store.get(`chats/${CHAT}`)!.memory ?? {}) as Record<string, unknown>
    )._phone_consent as Record<string, unknown>;
    expect('pewc' in consent).toBe(false);
    expect('snippet' in consent).toBe(false);
    expect(consent.ok).toBe(false); // false is a real value, not an absent one
  });

  it('refuses a blank number without touching the chat', async () => {
    expect(await capturePhoneConsent(CHAT, '   ')).toBe(false);
    expect(store.get(`chats/${CHAT}`)!.phone_opt_out).toBe(true);
  });
});

describe('shouldBlockManualLead — Lead is owned by a real booking', () => {
  it('blocks a manual Lead with no booking on record', () => {
    expect(shouldBlockManualLead('Lead', {})).toBe(true);
    expect(shouldBlockManualLead('lead', { meeting_booked: false })).toBe(true);
  });

  it('allows a manual Lead once a booking exists', () => {
    expect(shouldBlockManualLead('Lead', { meeting_booked: true })).toBe(false);
  });

  it('never blocks any other stage', () => {
    expect(shouldBlockManualLead('Engaged', {})).toBe(false);
    expect(shouldBlockManualLead('', {})).toBe(false);
    expect(shouldBlockManualLead(null, null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('markTaskSkipped — terminal but audit-distinct from a real execution', () => {
  it('sets executed AND the skip trail, so the due query never re-picks it', async () => {
    store.set(`chats/${CHAT}/tasks/t1`, { type: 'callback', executed: false });
    expect(await markTaskSkipped(CHAT, 't1', 'channel_opted_out')).toBe(true);
    const t = store.get(`chats/${CHAT}/tasks/t1`)!;
    expect(t.executed).toBe(true);
    expect(t.skipped).toBe(true);
    expect(t.skip_reason).toBe('channel_opted_out');
    expect(t.skipped_at).toBeInstanceOf(Date);
  });

  it('returns false for a missing task rather than creating one', async () => {
    expect(await markTaskSkipped(CHAT, 'nope')).toBe(false);
    expect(store.get(`chats/${CHAT}/tasks/nope`)).toBeUndefined();
  });

  it('returns false on missing ids', async () => {
    expect(await markTaskSkipped('', 't1')).toBe(false);
    expect(await markTaskSkipped(CHAT, '')).toBe(false);
  });
});

describe('failOutboundTask — reopening what the dispatch claim closed', () => {
  it('flips executed back to false for a retriable failure', async () => {
    // The claim set executed=true up front; without the reopen the backoff tick never re-selects it.
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'callback',
      executed: true,
      retry_count: 0,
    });
    await failOutboundTask(CHAT, 't1', 'provider timeout');
    const t = store.get(`chats/${CHAT}/tasks/t1`)!;
    expect(t.permanent_failure).toBeFalsy();
    expect(t.executed).toBe(false);
  });

  it('leaves a permanent failure closed', async () => {
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'callback',
      executed: true,
      retry_count: 2, // the next attempt hits the 3-retry ceiling
    });
    await failOutboundTask(CHAT, 't1', 'still failing');
    const t = store.get(`chats/${CHAT}/tasks/t1`)!;
    expect(t.permanent_failure).toBe(true);
    expect(t.executed).toBe(true);
  });

  it('does not reopen when the claim kill-switch was off', async () => {
    store.set(`chats/${CHAT}/tasks/t1`, {
      type: 'callback',
      executed: false,
      retry_count: 0,
    });
    await failOutboundTask(CHAT, 't1', 'boom', false);
    // Never claimed, so nothing to reopen; the backoff write owns the state.
    expect(store.get(`chats/${CHAT}/tasks/t1`)!.permanent_failure).toBeFalsy();
  });

  it('never throws on a missing task', async () => {
    await expect(
      failOutboundTask(CHAT, 'missing', 'reason')
    ).resolves.toBeUndefined();
  });
});
