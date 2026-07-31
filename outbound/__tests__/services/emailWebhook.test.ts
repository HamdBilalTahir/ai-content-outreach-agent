/**
 * @jest-environment node
 *
 * The inbound email-reply webhook.
 *
 * This handler is an ordered chain of seven exits, and the ORDER is the design — each must be checked
 * before the next, because the later step would do the wrong thing for a message the earlier one owns.
 * The tests walk that order deliberately:
 *
 *  - **Opt-out precedes any reply**, so an unsubscribe never receives an LLM answer.
 *  - **The decline precedes the normal reply**, because a decline email's body is usually EMPTY —
 *    replying to blank text produces nothing, so the turn is driven by an instruction instead.
 *  - **A paused chat is a full freeze**: logged and alerted, but no turn, no stage bump, and
 *    crucially no nudge cancellation.
 *  - **"No match" is a 200**, because SendGrid retries non-2xx and an unmatched address never will.
 *  - **Forwarded mail** hides the real prospect behind a rewritten `from`, so candidate extraction is
 *    tested against Reply-To, the envelope, and the raw headers.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../llm/turn', () => ({ runOutboundLlm: jest.fn() }));
jest.mock('../../services/emailReview', () => ({
  emailOptOutDetected: jest.fn(),
  handleSuppressedReinitiation: jest.fn(),
  notifyOps: jest.fn(),
  reviewEmail: jest.fn(),
}));
jest.mock('../../services/suppression', () => ({
  isSuppressed: jest.fn(),
  suppress: jest.fn(),
}));

import { store } from '../../testSupport/mockFirestore';
import { runOutboundLlm } from '../../llm/turn';
import {
  emailOptOutDetected,
  handleSuppressedReinitiation,
  notifyOps,
  reviewEmail,
} from '../../services/emailReview';
import { isSuppressed, suppress } from '../../services/suppression';
import {
  handleInboundEmail,
  isMeetingDecline,
  parseAddress,
  parseRawHeaders,
  recipientAddresses,
  senderCandidates,
  stripRePrefix,
} from '../../services/emailWebhook';

const runTurn = runOutboundLlm as jest.Mock;
const optOutDetected = emailOptOutDetected as jest.Mock;
const suppressedReinit = handleSuppressedReinitiation as jest.Mock;
const opsAlert = notifyOps as jest.Mock;
const review = reviewEmail as jest.Mock;
const suppressedCheck = isSuppressed as jest.Mock;
const suppressMock = suppress as jest.Mock;

const EMAIL = 'jane@corp.com';
const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';

function seedChat(over: Record<string, unknown> = {}) {
  const { memory: memOver, ...rest } = over;
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    agentId: AGENT,
    stage: 'Contacted',
    labels: [],
    ...rest,
    memory: {
      agent_id: AGENT,
      customer_email: EMAIL,
      first_name: 'Jane',
      phone_number: '15551230000',
      ...((memOver as Record<string, unknown>) ?? {}),
    },
  });
}

function chat(): Record<string, unknown> {
  return store.get(`chats/${CHAT}`) ?? {};
}

function memory(): Record<string, unknown> {
  return (chat().memory as Record<string, unknown>) ?? {};
}

function payload(over: Record<string, unknown> = {}) {
  return {
    from: `Jane <${EMAIL}>`,
    subject: 'Re: quick question',
    text: 'Sounds good!',
    ...over,
  };
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  delete process.env.EMAIL_REACTIVATION_POLICY_ENABLED;
  delete process.env.UNSUB_MAILTO;
  runTurn.mockResolvedValue({ status: 200, entries: [] });
  optOutDetected.mockResolvedValue(false);
  suppressedCheck.mockResolvedValue(null);
  suppressMock.mockResolvedValue(true);
  review.mockResolvedValue(undefined);
  seedChat();
});

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('address and header parsing', () => {
  test('extracts a bare address from a display-name header', () => {
    expect(parseAddress('"Jane Doe" <jane@corp.com>')).toBe(EMAIL);
    expect(parseAddress('jane@corp.com')).toBe(EMAIL);
    expect(parseAddress('  JANE@CORP.COM  ')).toBe(EMAIL);
  });

  test('anything without an @ is not an address', () => {
    expect(parseAddress('Jane Doe')).toBe('');
    expect(parseAddress('')).toBe('');
    expect(parseAddress(null)).toBe('');
  });

  test('headers that REPEAT are all kept, in order', () => {
    // Forwarded mail carries several Message-ID and Delivered-To lines; the first is the original.
    const h = parseRawHeaders(
      'Message-ID: <original@corp.com>\nMessage-ID: <forwarder@mail.com>\nSubject: Hi'
    );
    expect(h['message-id']).toEqual([
      '<original@corp.com>',
      '<forwarder@mail.com>',
    ]);
  });

  test('folded continuation lines are joined back onto their header', () => {
    const h = parseRawHeaders('Subject: a very\n long subject\nFrom: x@y.com');
    expect(h.subject).toEqual(['a very long subject']);
    expect(h.from).toEqual(['x@y.com']);
  });

  test('an empty or unparseable blob yields no headers, not a throw', () => {
    expect(parseRawHeaders('')).toEqual({});
    expect(parseRawHeaders(null)).toEqual({});
    expect(parseRawHeaders('no colon here')).toEqual({});
  });

  test('stripRePrefix removes stacked Re:/Fwd: prefixes', () => {
    expect(stripRePrefix('Re: Fwd: Re: Demo')).toBe('Demo');
    expect(stripRePrefix('Demo')).toBe('Demo');
  });
});

describe('senderCandidates', () => {
  test('finds the real prospect behind a rewritten `from` on forwarded mail', () => {
    // The top-level from is the mailbox; the prospect is only in Reply-To and the raw headers.
    const headers = parseRawHeaders(
      `Reply-To: ${EMAIL}\nFrom: forwarder@mail.com\nDelivered-To: agent@mail.com`
    );
    const c = senderCandidates({ from: 'agent@mail.com' }, headers);
    expect(c).toContain(EMAIL);
  });

  test('reads the SMTP envelope, as a string or an object', () => {
    expect(
      senderCandidates({ envelope: JSON.stringify({ from: EMAIL }) }, {})
    ).toContain(EMAIL);
    expect(senderCandidates({ envelope: { from: EMAIL } }, {})).toContain(
      EMAIL
    );
  });

  test('a malformed envelope contributes nothing rather than throwing', () => {
    expect(senderCandidates({ from: EMAIL, envelope: '{{{' }, {})).toEqual([
      EMAIL,
    ]);
  });

  test('candidates are de-duplicated and lowercased', () => {
    const c = senderCandidates(
      { from: `Jane <${EMAIL}>`, 'reply-to': 'JANE@CORP.COM' },
      {}
    );
    expect(c).toEqual([EMAIL]);
  });
});

describe('recipientAddresses', () => {
  test('collects the envelope RCPT, the To header, and Delivered-To', () => {
    const headers = parseRawHeaders('Delivered-To: unsub@mail.com');
    const r = recipientAddresses(
      {
        envelope: { to: ['agent@mail.com'] },
        to: 'sales@corp.com, ops@corp.com',
      },
      headers
    );
    expect([...r].sort()).toEqual([
      'agent@mail.com',
      'ops@corp.com',
      'sales@corp.com',
      'unsub@mail.com',
    ]);
  });
});

describe('isMeetingDecline', () => {
  test('the iMIP subject is the reliable always-present signal', () => {
    expect(isMeetingDecline('Declined: Demo with Acme', '', {})).toBe(true);
    expect(isMeetingDecline('Re: Declined: Demo', '', {})).toBe(true);
  });

  test('an .ics REPLY with PARTSTAT=DECLINED is the stronger signal', () => {
    expect(
      isMeetingDecline(
        'Demo',
        'BEGIN:VCALENDAR\nMETHOD:REPLY\nPARTSTAT=DECLINED',
        {}
      )
    ).toBe(true);
    // Also found when the calendar payload rides in another field.
    expect(
      isMeetingDecline('Demo', '', {
        attachment1: 'BEGIN:VCALENDAR METHOD:REPLY PARTSTAT=DECLINED',
      })
    ).toBe(true);
  });

  test('an ACCEPT is not a decline', () => {
    expect(
      isMeetingDecline('Accepted: Demo', 'METHOD:REPLY PARTSTAT=ACCEPTED', {})
    ).toBe(false);
  });

  test('an ordinary reply is not a decline', () => {
    expect(isMeetingDecline('Re: Demo', 'Sounds good', {})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The exit chain
// ─────────────────────────────────────────────────────────────────────────────

describe('the exit chain', () => {
  test('EXIT 1 — an unparseable sender is a 400', async () => {
    const r = await handleInboundEmail({ subject: 'hi', text: 'hello' });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(runTurn).not.toHaveBeenCalled();
  });

  test('EXIT 2 — no matching chat is a 200, because a retry cannot help', async () => {
    store.reset();
    const r = await handleInboundEmail(payload());
    // SendGrid retries non-2xx; an unmatched address will not match next time either.
    expect(r.status).toBe(200);
    expect(r.success).toBe(false);
    expect(r.candidates).toEqual([EMAIL]);
  });

  test('EXIT 3 — a non-outbound chat is never driven by the outbound agent', async () => {
    seedChat({ type: 'web' });
    const r = await handleInboundEmail(payload());
    // The MATCHER is already outbound-strict, so a web chat never even resolves — this falls to
    // EXIT 2 rather than EXIT 3. That is the point of the type check being defence in depth: it is
    // unreachable through this path by construction, and guards any other caller.
    expect(r.success).toBe(false);
    expect(r.error).toBe('no matching outbound chat');
    expect(runTurn).not.toHaveBeenCalled();
  });

  test('EXIT 4 — an opt-out reply never gets an LLM answer', async () => {
    optOutDetected.mockResolvedValue(true);
    const r = await handleInboundEmail(
      payload({ text: 'please unsubscribe me' })
    );
    expect(r.email_opt_out).toBe(true);
    expect(runTurn).not.toHaveBeenCalled();
    expect(chat().email_opt_out).toBe(true);
    expect(memory()._email_opt_out).toBe(true);
    expect(chat().labels).toContain('email_opted_out');
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'opted-out-by-reply',
      'email-webhook'
    );
  });

  test('EXIT 4 — the unsub MAILBOX is a content-independent trigger', async () => {
    // A List-Unsubscribe one-click mailto often carries no opt-out words at all.
    process.env.UNSUB_MAILTO = 'unsub@mail.com';
    optOutDetected.mockResolvedValue(false);
    const r = await handleInboundEmail(
      payload({ text: '', envelope: { to: ['unsub@mail.com'] } })
    );
    expect(r.email_opt_out).toBe(true);
    expect(suppressMock).toHaveBeenCalledWith(
      EMAIL,
      'opted-out-via-unsub-mailbox',
      'email-webhook'
    );
  });

  test('EXIT 4 — the local-part convention works with no configured mailbox', async () => {
    const r = await handleInboundEmail(
      payload({ text: '', envelope: { to: ['unsubscribe@anything.com'] } })
    );
    expect(r.email_opt_out).toBe(true);
  });

  test('EXIT 4 — an opt-out keeps the PHONE channel and the call cadence', async () => {
    optOutDetected.mockResolvedValue(true);
    store.set(`chats/${CHAT}/tasks/t_call`, {
      type: 'call_followup',
      executed: false,
      data: {},
    });
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    await handleInboundEmail(payload());
    expect(chat().phone_opt_out).toBeUndefined();
    expect(chat().stage).toBe('Contacted'); // not Lost
    expect(store.get(`chats/${CHAT}/tasks/t_call`)).toBeDefined();
    expect(store.get(`chats/${CHAT}/tasks/t_email`)).toBeUndefined();
  });

  test('EXIT 5 — a suppressed sender is notify-only while the policy is OFF', async () => {
    suppressedCheck.mockResolvedValue({ reason: 'spam-complaint' });
    const r = await handleInboundEmail(payload());
    expect(r.action).toBe('notified');
    expect(r.suppressed).toBe('spam-complaint');
    expect(opsAlert).toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  test('EXIT 5 — with the policy ON, an unlifted decision still blocks the reply', async () => {
    process.env.EMAIL_REACTIVATION_POLICY_ENABLED = 'true';
    suppressedCheck.mockResolvedValue({ reason: 'hard-bounce' });
    suppressedReinit.mockResolvedValue({
      lifted: false,
      action: 'verify-gated',
    });
    const r = await handleInboundEmail(payload());
    expect(r.action).toBe('verify-gated');
    expect(runTurn).not.toHaveBeenCalled();
  });

  test('EXIT 5 — a LIFTED decision falls through to the normal reply', async () => {
    process.env.EMAIL_REACTIVATION_POLICY_ENABLED = 'true';
    suppressedCheck.mockResolvedValue({ reason: 'unsubscribed' });
    suppressedReinit.mockResolvedValue({ lifted: true, action: 'reactivated' });
    await handleInboundEmail(payload());
    expect(runTurn).toHaveBeenCalled();
  });

  test('EXIT 6 — a decline drives the turn by INSTRUCTION, not the empty body', async () => {
    seedChat({ memory: { meeting_booked: true, meeting_at: 'Thursday 10am' } });
    const r = await handleInboundEmail(
      payload({ subject: 'Declined: Demo with Acme', text: '' })
    );
    expect(r.meeting_declined).toBe(true);
    expect(memory().meeting_declined).toBe(true);
    // The body is blank, so replying to it would produce nothing.
    const instruction = String(runTurn.mock.calls[0][0]);
    expect(instruction).toContain('DECLINED the demo calendar invite');
    expect(instruction).toContain('Thursday 10am');
  });

  test('EXIT 6 — a decline on an UNBOOKED chat is just a normal reply', async () => {
    // Scoped to booked chats: without a meeting there is nothing to decline.
    const r = await handleInboundEmail(
      payload({ subject: 'Declined: something' })
    );
    expect(r.meeting_declined).toBeUndefined();
    expect(runTurn).toHaveBeenCalledWith(
      'Sounds good!',
      AGENT,
      CHAT,
      expect.anything()
    );
  });

  test('EXIT 7 — a paused chat is frozen: no turn, no stage bump, nudges KEPT', async () => {
    seedChat({ status: 'paused' });
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    const r = await handleInboundEmail(payload());
    expect(r.paused).toBe(true);
    expect(runTurn).not.toHaveBeenCalled();
    expect(chat().stage).toBe('Contacted');
    // The freeze is total — even the nudge cancellation is skipped until someone resumes it.
    expect(store.get(`chats/${CHAT}/tasks/t_email`)).toBeDefined();
    expect(store.paths('technical_alerts')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The normal reply
// ─────────────────────────────────────────────────────────────────────────────

describe('a normal reply', () => {
  test('advances the stage, reopens the cadence, and runs the turn', async () => {
    seedChat({ cadence_complete: true, email_followup_count: 3 });
    const r = await handleInboundEmail(payload());
    expect(r.success).toBe(true);
    expect(chat().stage).toBe('Engaged');
    expect(chat().cadence_complete).toBe(false);
    expect(chat().email_followup_count).toBe(0);
    expect(runTurn).toHaveBeenCalledWith('Sounds good!', AGENT, CHAT, {
      provider: 'email',
      attendeeId: '15551230000',
    });
  });

  test('cancels pending email nudges — the customer has engaged', async () => {
    store.set(`chats/${CHAT}/tasks/t_email`, {
      type: 'followup_if_no_reply',
      executed: false,
      data: {},
    });
    await handleInboundEmail(payload());
    expect(store.get(`chats/${CHAT}/tasks/t_email`)).toBeUndefined();
  });

  test('records the threading anchor so the next send threads correctly', async () => {
    await handleInboundEmail(
      payload({ headers: 'Message-ID: <abc@corp.com>\nSubject: Re: Demo' })
    );
    expect(memory()._last_inbound_email_message_id).toBe('<abc@corp.com>');
    expect(typeof memory()._last_inbound_email_at).toBe('string');
    expect(memory()._email_references).toContain('<abc@corp.com>');
    // The canonical subject is stored without the Re: prefix.
    expect(memory()._email_thread_subject).toBe('quick question');
  });

  test('the ORIGINAL Message-ID wins over a forwarder’s', async () => {
    await handleInboundEmail(
      payload({
        headers: 'Message-ID: <original@corp.com>\nMessage-ID: <fwd@mail.com>',
      })
    );
    expect(memory()._last_inbound_email_message_id).toBe('<original@corp.com>');
  });

  test('an existing thread subject is not overwritten', async () => {
    seedChat({ memory: { _email_thread_subject: 'Original thread' } });
    await handleInboundEmail(payload({ headers: 'Message-ID: <x@y.com>' }));
    expect(memory()._email_thread_subject).toBe('Original thread');
  });

  test('the post-reply review runs AFTER the turn', async () => {
    await handleInboundEmail(payload());
    expect(review).toHaveBeenCalledWith(CHAT, AGENT, { agent_id: AGENT });
    const turnOrder = runTurn.mock.invocationCallOrder[0];
    const reviewOrder = review.mock.invocationCallOrder[0];
    // The thread needs both sides before it is worth reviewing.
    expect(reviewOrder).toBeGreaterThan(turnOrder);
  });

  test('a review failure never breaks the reply that already went out', async () => {
    review.mockRejectedValue(new Error('review exploded'));
    const r = await handleInboundEmail(payload());
    expect(r.success).toBe(true);
    expect(runTurn).toHaveBeenCalled();
  });

  test('a turn failure is reported, not thrown', async () => {
    runTurn.mockRejectedValue(new Error('model down'));
    const r = await handleInboundEmail(payload());
    expect(r.success).toBe(true);
    expect((r.agent as Record<string, unknown>).error).toContain('model down');
  });

  test('no agentId logs the reply to history instead of running a turn', async () => {
    seedChat({ agentId: '', memory: { agent_id: '' } });
    const r = await handleInboundEmail(payload());
    expect(r.agent).toEqual({ skipped: 'no agentId on chat' });
    expect(runTurn).not.toHaveBeenCalled();
  });
});
