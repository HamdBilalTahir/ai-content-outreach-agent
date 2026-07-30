/**
 * @jest-environment node
 *
 * The shared email-text contracts, the `send_email` tool's three deterministic gates, and the
 * suppression-reinitiation policy ladder.
 *
 * The copy classifiers get the most coverage because each one decides whether an LLM-composed email may
 * go out at all, and a FALSE POSITIVE is the expensive direction: it would block ordinary cold outreach.
 * So every classifier is tested for what it must NOT match as carefully as for what it must.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/emailSender', () => {
  const actual = jest.requireActual('../../services/emailSender');
  return {
    ...actual,
    sendEmail: jest.fn().mockResolvedValue({
      success: true,
      skipped: false,
      message_id: 'msg-1',
      error: null,
      status: 'sent',
      profile: 'outreach',
      origin: 'llm_tool',
    }),
  };
});
jest.mock('../../services/verification', () => ({
  verify: jest.fn().mockResolvedValue({ result: 'valid', detail: 'mx-pass' }),
}));

import { store } from '../../testSupport/mockFirestore';
import {
  OPT_OUT_RE,
  PEWC_DISCLOSURE_MARKER,
  PEWC_DISCLOSURE_TEXT,
  isBookingConfirmation,
  isNoAnswerEmail,
  isReminderEmail,
  stripQuotedReply,
  stripRePrefix,
} from '../../services/emailText';
import { parseAndRunSendEmail, __testing as et } from '../../tools/email';
import { sendEmail } from '../../services/emailSender';
import {
  buildEmailTranscript,
  handleSuppressedReinitiation,
  latestInboundEmailBody,
  pewcDisclosureOnRecord,
} from '../../services/emailReview';
import { verify } from '../../services/verification';
import {
  CLASS_COMPLAINT,
  CLASS_CONSENT,
  CLASS_DELIVERABILITY,
  COLLECTION as SUP_COLLECTION,
  suppress,
} from '../../services/suppression';

const CHAT = 'outbound__agentA__15551230000';
const send = sendEmail as jest.Mock;

/** Pull the json payload out of a tool-result envelope. */
function payloadOf(res: { content?: unknown[] }): Record<string, unknown> {
  const block = (res.content ?? [])[0] as Record<string, never>;
  const tr = block.toolResult as unknown as {
    content: Array<{ json: Record<string, unknown> }>;
  };
  return tr.content[0].json;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  send.mockResolvedValue({
    success: true,
    skipped: false,
    message_id: 'msg-1',
    error: null,
    status: 'sent',
    profile: 'outreach',
    origin: 'llm_tool',
  });
  (verify as jest.Mock).mockResolvedValue({
    result: 'valid',
    detail: 'mx-pass',
  });
  store.set('agents/agentA', { sales_agent_name: 'Nova' });
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    memory: { agent_id: 'agentA', customer_email: 'a@b.com' },
  });
  delete process.env.VERIFY_PROVIDER;
  delete process.env.VERIFY_API_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('stripQuotedReply — why the opt-out matcher is safe to run', () => {
  it('cuts at quoted lines', () => {
    expect(stripQuotedReply('No thanks\n\n> our earlier email')).toBe(
      'No thanks'
    );
  });

  it('cuts at the Gmail and Outlook reply headers', () => {
    expect(
      stripQuotedReply('Interested!\n\nOn Mon, Jul 1, Nova wrote:\nold text')
    ).toBe('Interested!');
    expect(stripQuotedReply('Sure\n\n-- Original Message --\nold text')).toBe(
      'Sure'
    );
  });

  it('cuts at our OWN footer, which is the whole point', () => {
    // Our CAN-SPAM footer contains "opt out"; unstripped, a plain reply would look like an opt-out.
    const reply =
      'Sounds good, tell me more\n\n--\nNova | Acme\nopt out: https://x';
    const cleaned = stripQuotedReply(reply);
    expect(cleaned).toBe('Sounds good, tell me more');
    expect(OPT_OUT_RE.test(cleaned)).toBe(false);
    // Unstripped, it WOULD have matched — that is the bug this prevents.
    expect(OPT_OUT_RE.test(reply)).toBe(true);
  });

  it('cuts at the EARLIEST marker when several are present', () => {
    expect(stripQuotedReply('Yes\n\n> quoted\n\nOn Mon, X wrote:')).toBe('Yes');
  });

  it('returns a clean reply unchanged, and tolerates empties', () => {
    expect(stripQuotedReply('Just a normal reply')).toBe('Just a normal reply');
    expect(stripQuotedReply('')).toBe('');
    expect(stripQuotedReply(null)).toBe('');
  });
});

describe('OPT_OUT_RE is a PRE-FILTER, not a verdict', () => {
  it.each([
    'unsubscribe',
    'please stop emailing me',
    'remove me from your list',
    'opt out',
    'opt-out',
    "don't email me again",
    'no more emails',
  ])('flags %p as a candidate', (s) => {
    expect(OPT_OUT_RE.test(s)).toBe(true);
  });

  it('also flags QUESTIONS and NEGATIONS — which is why intent confirmation gates it', () => {
    // These are candidates, not opt-outs. The deferred LLM check is what rejects them.
    expect(OPT_OUT_RE.test('is there an unsubscribe option?')).toBe(true);
    expect(OPT_OUT_RE.test("please don't remove me from the list")).toBe(true);
  });

  it('does not flag ordinary replies', () => {
    expect(OPT_OUT_RE.test('Sounds interesting, can we talk Tuesday?')).toBe(
      false
    );
    expect(OPT_OUT_RE.test('Not a fit right now, thanks')).toBe(false);
  });
});

describe('isBookingConfirmation — narrow on purpose', () => {
  it.each([
    'Your demo is confirmed',
    "You're all set for Thursday",
    'I locked it in',
    'Calendar invite attached',
    "I've got you down for 2pm",
    'Looking forward to our demo',
    'See you on Thursday',
  ])('matches the confirmed-meeting assertion %p', (s) => {
    expect(isBookingConfirmation('', s)).toBe(true);
  });

  it('does NOT match generic outreach — a false positive would block cold email', () => {
    for (const s of [
      'Would you be open to a demo next week?',
      'I have Tuesday at 2pm or Wednesday at 10am — which works?',
      'Can I show you a quick walkthrough?',
      'Are you the right person for this?',
    ]) {
      expect(isBookingConfirmation('', s)).toBe(false);
    }
  });

  it('scans the subject as well as the body', () => {
    expect(isBookingConfirmation('Demo confirmed', 'details inside')).toBe(
      true
    );
  });
});

describe('isReminderEmail', () => {
  it.each([
    'Quick reminder about your demo',
    'Your demo is tomorrow',
    'Demo today at 2pm',
    'demo in about 2 hours',
    'Just a reminder',
    'Meeting reminder',
    'coming up tomorrow',
  ])('matches %p', (s) => {
    expect(isReminderEmail('', s)).toBe(true);
  });

  it('does not match ordinary outreach', () => {
    expect(isReminderEmail('', 'Following up on my last note')).toBe(false);
  });
});

describe('isNoAnswerEmail — narrow on purpose', () => {
  it.each([
    'I tried to reach you earlier',
    "I couldn't connect with you",
    'Tried calling this morning',
    'I gave you a ring',
    'We missed you',
    'Left you a voicemail',
    'attempted to call',
    'reached out by phone',
  ])('matches the unanswered-call premise %p', (s) => {
    expect(isNoAnswerEmail('', s)).toBe(true);
  });

  it('does NOT match generic call-scheduling language', () => {
    // A false positive here blocks ordinary outreach behind a call that never needed to happen.
    for (const s of [
      'Would you like to book a call?',
      'Happy to hop on a call',
      'Can we schedule a call next week?',
      'Worth a quick call?',
    ]) {
      expect(isNoAnswerEmail('', s)).toBe(false);
    }
  });
});

describe('the PEWC disclosure is a byte-stable contract', () => {
  it('contains its own marker — code keys on the marker, not the full text', () => {
    expect(PEWC_DISCLOSURE_TEXT).toContain(PEWC_DISCLOSURE_MARKER);
  });

  it('carries the required TCPA elements', () => {
    expect(PEWC_DISCLOSURE_TEXT).toContain('automated and AI-generated');
    expect(PEWC_DISCLOSURE_TEXT).toContain('not a condition of any purchase');
    expect(PEWC_DISCLOSURE_TEXT).toContain('reply STOP to opt out');
  });
});

describe('stripRePrefix', () => {
  it('collapses repeated prefixes so a thread never reads "Re: Re:"', () => {
    expect(stripRePrefix('Re: Re: Fwd: Quick question')).toBe('Quick question');
    expect(stripRePrefix('RE: hello')).toBe('hello');
    expect(stripRePrefix('hello')).toBe('hello');
    expect(stripRePrefix(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the send tool's gate 1 — a confirmation needs a real booking", () => {
  it('BLOCKS a confirmation when no booking is on record', async () => {
    const res = await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Demo confirmed', body: "You're all set." },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    const p = payloadOf(res);
    expect(p.status).toBe('blocked');
    expect(String(p.message)).toContain('schedule_hubspot_meeting first');
    expect(send).not.toHaveBeenCalled();
  });

  it('allows it once meeting_booked is set, and classifies it TRANSACTIONAL', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: { agent_id: 'agentA', meeting_booked: true },
    });
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Demo confirmed', body: "You're all set." },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    expect(send).toHaveBeenCalled();
    expect((send.mock.calls[0][0] as Record<string, unknown>).profile).toBe(
      'transactional'
    );
  });

  it('lets ordinary outreach through with no profile override', async () => {
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Quick question', body: 'Open to a demo?' },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    expect(
      (send.mock.calls[0][0] as Record<string, unknown>).profile
    ).toBeNull();
  });
});

describe("the send tool's gate 2 — a no-answer email needs a fresh call", () => {
  it('BLOCKS when no unanswered call is on record', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: { agent_id: 'agentA', phone_number: '15551230000' },
    });
    const res = await parseAndRunSendEmail(
      'tu1',
      {
        to: 'a@b.com',
        subject: 'Tried to reach you',
        body: "I couldn't connect.",
      },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    expect(payloadOf(res).status).toBe('blocked');
    expect(send).not.toHaveBeenCalled();
  });

  it('allows it with a FRESH unanswered call', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: {
        agent_id: 'agentA',
        phone_number: '15551230000',
        _last_call_unanswered_at: new Date().toISOString(),
      },
    });
    await parseAndRunSendEmail(
      'tu1',
      {
        to: 'a@b.com',
        subject: 'Tried to reach you',
        body: "I couldn't connect.",
      },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    expect(send).toHaveBeenCalled();
  });

  it('EXEMPTS an email-only contact — there is no call to tie it to', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: { agent_id: 'agentA' }, // no phone
    });
    await parseAndRunSendEmail(
      'tu1',
      {
        to: 'a@b.com',
        subject: 'Tried to reach you',
        body: "I couldn't connect.",
      },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    expect(send).toHaveBeenCalled();
  });

  it('fails CLOSED on a stale or unparseable stamp', () => {
    expect(et.lastUnansweredCallFresh({})).toBe(false);
    expect(
      et.lastUnansweredCallFresh({ _last_call_unanswered_at: 'junk' })
    ).toBe(false);
    expect(
      et.lastUnansweredCallFresh({
        _last_call_unanswered_at: '2020-01-01T00:00:00Z',
      })
    ).toBe(false);
  });

  it('phoneReachable honours both opt-out spellings', () => {
    expect(et.phoneReachable({ phone_number: '15551230000' })).toBe(true);
    expect(
      et.phoneReachable({ phone_number: '15551230000', block_phone: 'Y' })
    ).toBe(false);
    expect(
      et.phoneReachable({ phone_number: '15551230000', phone_opt_out: 'Y' })
    ).toBe(false);
    expect(et.phoneReachable({})).toBe(false);
  });
});

describe("the send tool's gate 3 — the join link is guaranteed", () => {
  beforeEach(() => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: {
        agent_id: 'agentA',
        meeting_booked: true,
        hubspot_meeting_link: 'https://meet.example.com/abc',
      },
    });
  });

  it('appends the link when the model omitted it', async () => {
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Demo confirmed', body: "You're all set." },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    const sent = send.mock.calls[0][0] as Record<string, string>;
    expect(sent.text).toContain('https://meet.example.com/abc');
  });

  it('does not duplicate a link the model already included', async () => {
    await parseAndRunSendEmail(
      'tu1',
      {
        to: 'a@b.com',
        subject: 'Demo confirmed',
        body: "You're all set: https://meet.example.com/abc",
      },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    const sent = send.mock.calls[0][0] as Record<string, string>;
    expect(sent.text.match(/meet\.example\.com/g)).toHaveLength(1);
  });
});

describe('the send tool — threading and bookkeeping', () => {
  it('threads under the canonical subject when an inbound anchor exists', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: {
        agent_id: 'agentA',
        _last_inbound_email_message_id: '<real@customer>',
        _email_thread_subject: 'Quick question',
      },
    });
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'whatever', body: 'reply body' },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    const sent = send.mock.calls[0][0] as Record<string, string>;
    expect(sent.inReplyTo).toBe('<real@customer>');
    expect(sent.subject).toBe('Re: Quick question');
  });

  it('sends fresh with no anchor, and remembers the canonical subject', async () => {
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Re: Quick question', body: 'body' },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    const sent = send.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.inReplyTo).toBeNull();
    const m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._email_thread_subject).toBe('Quick question'); // Re: stripped
  });

  it('stamps the first-email anchor, then bumps the follow-up count', async () => {
    const args = {
      to: 'a@b.com',
      subject: 'Hi',
      body: 'first touch',
    };
    await parseAndRunSendEmail('tu1', args, {
      chat_id: CHAT,
      agent_id: 'agentA',
    });
    let m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._first_outbound_email_at).toBeTruthy();
    expect(store.get(`chats/${CHAT}`)!.email_followup_count).toBeUndefined();

    await parseAndRunSendEmail('tu2', args, {
      chat_id: CHAT,
      agent_id: 'agentA',
    });
    expect(store.get(`chats/${CHAT}`)!.email_followup_count).toBe(1);
    m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._first_outbound_email_at).toBeTruthy();
  });

  it('counts a PEWC ask only when the disclosure is actually in the body', async () => {
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Hi', body: 'no disclosure here' },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    let m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._phone_ask_count).toBeUndefined();

    await parseAndRunSendEmail(
      'tu2',
      {
        to: 'a@b.com',
        subject: 'Hi',
        body: `Best number? ${PEWC_DISCLOSURE_TEXT}`,
      },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    m = store.get(`chats/${CHAT}`)!.memory as Record<string, unknown>;
    expect(m._phone_ask_count).toBe(1);
    expect(m._phone_ask_at).toBeTruthy();
  });

  it('advances the prospect to Contacted and logs the outbound half of the thread', async () => {
    await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Hi', body: 'first touch' },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    expect(store.get(`chats/${CHAT}`)!.stage).toBe('Contacted');
    const rows = store.collection(`chats/${CHAT}/messages_v3`);
    expect(rows).toHaveLength(1);
    expect(rows[0][1].direction).toBe('outbound');
  });

  it('surfaces a gate outcome with its guidance, and does not advance the stage', async () => {
    send.mockResolvedValue({
      success: false,
      skipped: true,
      message_id: null,
      error: null,
      status: 'skipped',
      reason: 'suppressed:hard-bounce',
      guidance: 'Do not retry it.',
      message: 'Email NOT sent.',
      profile: 'outreach',
      origin: 'llm_tool',
    });
    const res = await parseAndRunSendEmail(
      'tu1',
      { to: 'a@b.com', subject: 'Hi', body: 'body' },
      { chat_id: CHAT, agent_id: 'agentA' }
    );
    const p = payloadOf(res);
    expect(p.status).toBe('skipped');
    expect(p.guidance).toBe('Do not retry it.');
    expect((p.email_label as Record<string, unknown>).compliance).toBe(
      'blocked'
    );
    expect(store.get(`chats/${CHAT}`)!.stage).toBeUndefined();
  });

  it('reports a transport failure without advancing anything', async () => {
    send.mockResolvedValue({
      success: false,
      skipped: false,
      message_id: null,
      error: 'sendgrid 400',
      status: 'failed',
      profile: 'outreach',
      origin: 'llm_tool',
    });
    const p = payloadOf(
      await parseAndRunSendEmail(
        'tu1',
        { to: 'a@b.com', subject: 'Hi', body: 'body' },
        { chat_id: CHAT, agent_id: 'agentA' }
      )
    );
    expect(p.status).toBe('failed');
    expect(p.error).toBe('sendgrid 400');
    expect(store.get(`chats/${CHAT}`)!.stage).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the email thread readers', () => {
  beforeEach(() => {
    const rows: Array<[string, Record<string, unknown>]> = [
      [
        'm1',
        {
          timestamp: new Date('2026-08-01T10:00:00Z'),
          source: 'email',
          direction: 'outbound',
          content: { body: `Our ask. ${PEWC_DISCLOSURE_TEXT}` },
        },
      ],
      [
        'm2',
        {
          timestamp: new Date('2026-08-02T10:00:00Z'),
          source: 'email',
          direction: 'inbound',
          content: { body: 'Call me at 908-386-4637\n\n> quoted history' },
        },
      ],
      [
        'm3',
        {
          timestamp: new Date('2026-08-03T10:00:00Z'),
          source: 'call',
          direction: 'outbound',
          content: { summary: 'a call, not an email' },
        },
      ],
    ];
    for (const [id, d] of rows) store.set(`chats/${CHAT}/messages_v3/${id}`, d);
  });

  it('builds a chronological AGENT/CUSTOMER transcript from email rows only', async () => {
    const t = await buildEmailTranscript(CHAT);
    const lines = t.split('\n');
    expect(lines[0].startsWith('AGENT:')).toBe(true);
    expect(lines[1].startsWith('CUSTOMER:')).toBe(true);
    expect(t).not.toContain('a call, not an email');
  });

  it('strips quoted history from the latest inbound body', async () => {
    const body = await latestInboundEmailBody(CHAT);
    expect(body).toBe('Call me at 908-386-4637');
  });

  it('finds the PEWC disclosure in OUR outbound copy', async () => {
    await expect(pewcDisclosureOnRecord(CHAT)).resolves.toBe(true);
  });

  it('is false when our copy carried no disclosure', async () => {
    store.set(`chats/${CHAT}/messages_v3/m1`, {
      timestamp: new Date('2026-08-04T10:00:00Z'),
      source: 'email',
      direction: 'outbound',
      content: { body: 'plain outreach, no disclosure' },
    });
    await expect(pewcDisclosureOnRecord(CHAT)).resolves.toBe(false);
  });

  it('is empty for a chat with no email thread', async () => {
    await expect(buildEmailTranscript('nope')).resolves.toBe('');
    await expect(buildEmailTranscript('')).resolves.toBe('');
  });
});

describe('the suppression-reinitiation ladder', () => {
  const EMAIL = 'sender@example.com';

  it('LIFTS a consent-class suppression — a direct inquiry is an express invitation', async () => {
    await suppress(EMAIL, 'unsubscribed');
    const r = await handleSuppressedReinitiation(CHAT, 'agentA', EMAIL, {
      class: CLASS_CONSENT,
      reason: 'unsubscribed',
      probe_once_failed: false,
    });
    expect(r).toEqual({ lifted: true, action: 'reactivated:consent' });
    expect(store.get(`${SUP_COLLECTION}/${EMAIL}`)!.active).toBe(false);
  });

  it('NEVER auto-lifts a complaint class — it escalates instead', async () => {
    await suppress(EMAIL, 'spam-complaint');
    const r = await handleSuppressedReinitiation(CHAT, 'agentA', EMAIL, {
      class: CLASS_COMPLAINT,
      reason: 'spam-complaint',
      probe_once_failed: false,
    });
    expect(r).toEqual({ lifted: false, action: 'notified:complaint-class' });
    expect(store.get(`${SUP_COLLECTION}/${EMAIL}`)!.active).toBe(true);
    expect(store.collection('technical_alerts')).toHaveLength(1);
  });

  it('escalates a failed probe-once rather than lifting again', async () => {
    await suppress(EMAIL, 'hard-bounce');
    const r = await handleSuppressedReinitiation(CHAT, 'agentA', EMAIL, {
      class: CLASS_DELIVERABILITY,
      reason: 'hard-bounce',
      probe_once_failed: true,
    });
    expect(r.lifted).toBe(false);
    expect(r.action).toBe('notified:complaint-class');
  });

  it('re-verifies a deliverability class when a provider is configured', async () => {
    process.env.VERIFY_PROVIDER = 'zerobounce';
    process.env.VERIFY_API_KEY = 'k';
    await suppress(EMAIL, 'hard-bounce');

    (verify as jest.Mock).mockResolvedValue({ result: 'valid', detail: 'ok' });
    const ok = await handleSuppressedReinitiation(CHAT, 'agentA', EMAIL, {
      class: CLASS_DELIVERABILITY,
      reason: 'hard-bounce',
      probe_once_failed: false,
    });
    expect(ok).toEqual({ lifted: true, action: 'reactivated:reverified' });

    // A non-valid re-verify escalates instead of lifting.
    await suppress(EMAIL, 'hard-bounce');
    (verify as jest.Mock).mockResolvedValue({
      result: 'invalid',
      detail: 'no-mx',
    });
    const bad = await handleSuppressedReinitiation(CHAT, 'agentA', EMAIL, {
      class: CLASS_DELIVERABILITY,
      reason: 'hard-bounce',
      probe_once_failed: false,
    });
    expect(bad).toEqual({ lifted: false, action: 'notified:reverify-invalid' });
  });

  it('probes once, LABELLED, when no verification provider is configured', async () => {
    await suppress(EMAIL, 'hard-bounce');
    const r = await handleSuppressedReinitiation(CHAT, 'agentA', EMAIL, {
      class: CLASS_DELIVERABILITY,
      reason: 'hard-bounce',
      probe_once_failed: false,
    });
    expect(r).toEqual({ lifted: true, action: 'reactivated:probe-once' });
    // The label is what makes a later bounce permanent — `suppress` keys on it.
    expect(store.get(`${SUP_COLLECTION}/${EMAIL}`)!.reactivated_by).toBe(
      'inbound-email-probe-once'
    );

    await suppress(EMAIL, 'hard-bounce'); // the bounce comes back
    expect(store.get(`${SUP_COLLECTION}/${EMAIL}`)!.probe_once_failed).toBe(
      true
    );
  });
});
