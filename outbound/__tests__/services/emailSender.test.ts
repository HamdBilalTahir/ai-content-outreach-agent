/**
 * @jest-environment node
 *
 * The email choke point.
 *
 * This suite is organised around the two things the module exists to guarantee, because both are
 * order-dependent and a plausible-looking reordering breaks them silently:
 *
 *  1. **GATE ORDER.** G0b business-hours sits AFTER the address-quality skips, so a suppressed or
 *     invalid address is terminally skipped and never turned into a retry task; and BEFORE the
 *     consuming gates, so an after-hours send burns neither a bucket token nor domain budget. The
 *     per-recipient cap is last of the consumers, and releases the domain budget when it skips.
 *  2. **THE TWO AXES.** `gate_profile` is chosen by STATE — a caller cannot claim `reply` privileges
 *     for a stale thread — while `origin` decides who owns a deferral. Every deferred send has an
 *     owner; nothing is silently dropped.
 *
 * Plus the compliance builder, whose output is code-appended and must never depend on the prompt.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
// G0b business-hours is CLOCK-DEPENDENT, and because it sits before the consuming gates a `Real`
// record outside the window can never REACH them — so on a weekend four of the tests below were
// asserting `domain_budget` while the real answer was `outside_business_hours`. The gate order is
// correct and is asserted explicitly in its own test; to exercise the consuming gates at all, the
// check has to be controlled, so it reports "inside hours" by default.
jest.mock('../../services/businessHours', () => {
  const actual = jest.requireActual('../../services/businessHours');
  return {
    ...actual,
    checkBusinessHours: jest
      .fn()
      .mockReturnValue({ timezone: null, localTime: null, wasFallback: false }),
  };
});
// The transport is the one thing we never exercise for real.
jest.mock('../../services/sendgridMail', () => {
  const actual = jest.requireActual('../../services/sendgridMail');
  return {
    ...actual,
    sendEmailViaSendgrid: jest.fn().mockResolvedValue({
      success: true,
      skipped: false,
      message_id: 'msg-1',
      error: null,
    }),
  };
});
jest.mock('../../services/verification', () => ({
  verify: jest.fn().mockResolvedValue({ result: 'valid', detail: 'mx-pass' }),
}));

import { store } from '../../testSupport/mockFirestore';
import {
  ORIGIN_LLM_TOOL,
  ORIGIN_NUDGE,
  ORIGIN_TRANSACTIONAL,
  PROFILE_OUTREACH,
  PROFILE_REPLY,
  PROFILE_TRANSACTIONAL,
  buildCompliance,
  sendEmail,
  __testing as es,
} from '../../services/emailSender';
import { sendEmailViaSendgrid } from '../../services/sendgridMail';
import { verify } from '../../services/verification';
import { checkBusinessHours } from '../../services/businessHours';
import { suppress } from '../../services/suppression';
import { BUDGET_COLLECTION, SEND_LOG } from '../../services/reputation';
import type { ChatMemory } from '../../types';

const TO = 'prospect@example.com';
const FROM = 'lily@mail.example.com';
const CHAT = 'outbound__agentA__15551230000';
const send = sendEmailViaSendgrid as jest.Mock;

/** A memory whose business-hours check will pass, and which is not phone-lane. */
function mem(over: ChatMemory = {}): ChatMemory {
  return {
    agent_id: 'agentA',
    record_type: 'Test', // bypasses the business-hours gate and the domain budget
    timezone: 'UTC',
    _outreach_lane: 'email',
    ...over,
  };
}

function args(over: Record<string, unknown> = {}) {
  return {
    to: TO,
    subject: 'Hello',
    text: 'body text',
    fromEmail: FROM,
    fromName: 'Nova',
    agentId: 'agentA',
    chatId: CHAT,
    memory: mem(),
    senderCfg: {
      postal_address: '1 Test St, Denver CO',
      company_name: 'Acme',
    } as never,
    ...over,
  };
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  send.mockResolvedValue({
    success: true,
    skipped: false,
    message_id: 'msg-1',
    error: null,
  });
  (verify as jest.Mock).mockResolvedValue({
    result: 'valid',
    detail: 'mx-pass',
  });
  // clearAllMocks wipes the implementation the module factory set, so restore "inside hours" here.
  (checkBusinessHours as jest.Mock).mockReturnValue({
    timezone: null,
    localTime: null,
    wasFallback: false,
  });
  store.set('agents/agentA', { sales_agent_name: 'Nova' });
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    email_opt_out: false,
    memory: mem(),
  });
  delete process.env.COMPANY_POSTAL_ADDRESS;
  delete process.env.ALLOW_CATCH_ALL;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the two axes — gate_profile is chosen by STATE', () => {
  it('resolves reply only when the thread anchor is FRESH', () => {
    const fresh = { _last_inbound_email_at: new Date().toISOString() };
    expect(es.resolveProfile(null, 'msg-id', fresh)).toBe(PROFILE_REPLY);
  });

  it('gates a STALE thread as outreach, even though it keeps its threading headers', () => {
    // Class privileges are earned by state, not by headers.
    const stale = { _last_inbound_email_at: '2020-01-01T00:00:00Z' };
    expect(es.resolveProfile(null, 'msg-id', stale)).toBe(PROFILE_OUTREACH);
  });

  it('treats a MISSING anchor as stale — the safe default', () => {
    expect(es.resolveProfile(null, 'msg-id', {})).toBe(PROFILE_OUTREACH);
    expect(es.replyIsFresh({})).toBe(false);
    expect(es.replyIsFresh({ _last_inbound_email_at: 'garbage' })).toBe(false);
  });

  it('honours an EXPLICIT reply or transactional declaration', () => {
    expect(es.resolveProfile(PROFILE_REPLY, null, {})).toBe(PROFILE_REPLY);
    expect(es.resolveProfile(PROFILE_TRANSACTIONAL, null, {})).toBe(
      PROFILE_TRANSACTIONAL
    );
  });

  it('defaults to outreach with no anchor at all', () => {
    expect(es.resolveProfile(null, null, {})).toBe(PROFILE_OUTREACH);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('G0 — the CAN-SPAM hard fail is the FIRST gate', () => {
  it('REFUSES rather than degrading when no postal address is configured', async () => {
    const r = await sendEmail(args({ senderCfg: {} as never }));
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('compliance-config-missing');
    expect(send).not.toHaveBeenCalled();
  });

  it('tells the model NOT to route the content elsewhere', async () => {
    const r = await sendEmail(args({ senderCfg: {} as never }));
    expect(r.guidance).toContain('notify an administrator');
    expect(r.guidance).toContain('do not work around this');
  });

  it('runs before any consuming gate — no budget or bucket token is burned', async () => {
    await sendEmail(args({ senderCfg: {} as never }));
    expect(store.collection(BUDGET_COLLECTION)).toHaveLength(0);
    expect(store.collection('rate_limits')).toHaveLength(0);
  });

  it('accepts the env fallback for the address', async () => {
    process.env.COMPANY_POSTAL_ADDRESS = '2 Env Way';
    const r = await sendEmail(args({ senderCfg: {} as never }));
    expect(r.status).toBe('sent');
  });
});

describe('the deterministic address gates', () => {
  it('skips an invalid address on EVERY profile, including transactional', async () => {
    // A dead mailbox has no transactional carve-out: sending only bounces and burns the domain.
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      email_invalid: true,
      memory: mem(),
    });
    for (const profile of [
      PROFILE_OUTREACH,
      PROFILE_TRANSACTIONAL,
      PROFILE_REPLY,
    ]) {
      const r = await sendEmail(args({ profile }));
      expect(r.status).toBe('skipped');
      expect(r.reason).toBe('email-invalid');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('skips an opted-out address BUT lets transactional through', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      email_opt_out: true,
      memory: mem(),
    });
    expect((await sendEmail(args())).reason).toBe('email-opted-out');
    // The booking-confirmation carve-out.
    expect(
      (await sendEmail(args({ profile: PROFILE_TRANSACTIONAL }))).status
    ).toBe('sent');
  });

  it('skips OUTREACH on a phone-lane chat but not reply or transactional', async () => {
    const phoneLane = mem({ _outreach_lane: 'phone' });
    const r = await sendEmail(args({ memory: phoneLane }));
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('phone-lane-call-only');

    // The phone cadence owns OUTREACH only — these still send.
    expect(
      (
        await sendEmail(
          args({ memory: phoneLane, profile: PROFILE_TRANSACTIONAL })
        )
      ).status
    ).toBe('sent');
    expect(
      (await sendEmail(args({ memory: phoneLane, profile: PROFILE_REPLY })))
        .status
    ).toBe('sent');
  });
});

describe('G2 — local suppression', () => {
  it('blocks a DELIVERABILITY suppression even for transactional', async () => {
    await suppress(TO, 'hard-bounce');
    const r = await sendEmail(args({ profile: PROFILE_TRANSACTIONAL }));
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('suppressed:hard-bounce');
  });

  it('lets a CONSENT suppression through for transactional — the CAN-SPAM carve-out', async () => {
    await suppress(TO, 'unsubscribed');
    expect((await sendEmail(args())).status).toBe('skipped'); // outreach blocked
    expect(
      (await sendEmail(args({ profile: PROFILE_TRANSACTIONAL }))).status
    ).toBe('sent');
  });

  it('is a TERMINAL skip — no retry task is ever created', async () => {
    await suppress(TO, 'hard-bounce');
    await sendEmail(args());
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });
});

describe('G4 — verification', () => {
  it('suppresses and skips an invalid address', async () => {
    (verify as jest.Mock).mockResolvedValue({
      result: 'invalid',
      detail: 'no-mx',
    });
    const r = await sendEmail(args());
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('invalid:no-mx');
    // It also records the suppression, so a later send short-circuits at G2.
    expect(store.get('email_suppression/prospect@example.com')).toBeDefined();
  });

  it('skips a risky address unless catch-all is explicitly allowed', async () => {
    (verify as jest.Mock).mockResolvedValue({
      result: 'risky',
      detail: 'role-address',
    });
    expect((await sendEmail(args())).status).toBe('skipped');

    process.env.ALLOW_CATCH_ALL = 'true';
    expect((await sendEmail(args())).status).toBe('sent');
  });

  it('fails OPEN when the verifier throws — an outage must not block a committed send', async () => {
    (verify as jest.Mock).mockRejectedValue(new Error('dns down'));
    expect((await sendEmail(args())).status).toBe('sent');
  });

  it('does NOT verify on the reply profile — the address already replied to us', async () => {
    await sendEmail(args({ profile: PROFILE_REPLY }));
    expect(verify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('deferrals always have an owner', () => {
  /** Force the domain budget to refuse, which is the cleanest deferring gate to drive. */
  async function exhaustBudget() {
    const day = new Date().toISOString().slice(0, 10);
    store.set(`${BUDGET_COLLECTION}/mail.example.com_${day}`, {
      count: 9_999,
      cap: 10,
    });
  }

  it('llm_tool origin creates the retry task itself', async () => {
    await exhaustBudget();
    const r = await sendEmail(
      args({ memory: mem({ record_type: 'Real' }), origin: ORIGIN_LLM_TOOL })
    );
    expect(r.status).toBe('deferred');
    expect(r.reason).toBe('domain_budget');
    expect(r.retry_at).toBeTruthy();

    const tasks = store.collection(`chats/${CHAT}/tasks`);
    expect(tasks).toHaveLength(1);
    // No send on record yet → retries as a fresh first touch.
    expect(tasks[0][1].type).toBe('outbound_outreach');
    expect((tasks[0][1].data as Record<string, unknown>).task_source).toBe(
      'email_defer_domain_budget'
    );
  });

  it('reschedules as a FOLLOW-UP once a first email has gone out', async () => {
    await exhaustBudget();
    await sendEmail(
      args({
        memory: mem({
          record_type: 'Real',
          _first_outbound_email_at: '2026-07-01T00:00:00Z',
        }),
      })
    );
    const tasks = store.collection(`chats/${CHAT}/tasks`);
    expect(tasks[0][1].type).toBe('followup_if_no_reply');
  });

  it('nudge_service origin creates NO task — its own scheduler owns the retry', async () => {
    await exhaustBudget();
    const r = await sendEmail(
      args({ memory: mem({ record_type: 'Real' }), origin: ORIGIN_NUDGE })
    );
    expect(r.status).toBe('deferred');
    expect(r.retry_at).toBeTruthy();
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(0);
  });

  it('a transactional send never reaches a deferring gate at all', async () => {
    await exhaustBudget();
    const r = await sendEmail(
      args({
        memory: mem({ record_type: 'Real' }),
        profile: PROFILE_TRANSACTIONAL,
        origin: ORIGIN_TRANSACTIONAL,
      })
    );
    // Transactional skips the budget gate entirely, so it sends.
    expect(r.status).toBe('sent');
  });

  it('does not stack retry tasks — a re-deferral reschedules', async () => {
    await exhaustBudget();
    const a = args({ memory: mem({ record_type: 'Real' }) });
    await sendEmail(a);
    await sendEmail(a);
    expect(store.collection(`chats/${CHAT}/tasks`)).toHaveLength(1);
  });
});

describe('G0b — business hours sits between the address gates and the consumers', () => {
  it('an after-hours send DEFERS and burns neither a bucket token nor domain budget', async () => {
    // Drives the gate explicitly rather than relying on the wall clock. `timezone !== null` is what
    // the module reads as "outside the window".
    // NOT mockReturnValueOnce: a Test record never consults this gate, so an unconsumed `Once`
    // survives clearAllMocks (which drops calls, not queued implementations) and fires in the NEXT
    // test. beforeEach re-establishes the inside-hours default, so a plain mockReturnValue is scoped.
    (checkBusinessHours as jest.Mock).mockReturnValue({
      timezone: 'America/Denver',
      localTime: '2026-08-01T03:00:00',
      wasFallback: false,
    });
    const r = await sendEmail(args({ memory: mem({ record_type: 'Real' }) }));
    expect(r.status).toBe('deferred');
    expect(r.reason).toBe('outside_business_hours');
    expect(r.retry_at).toBeTruthy();
    // The deferral IS audited — that is how it has an owner — but it must be logged as `deferred`,
    // and the domain budget must be untouched: nothing was spent on a send that did not happen.
    const log = store.collection(SEND_LOG);
    expect(log).toHaveLength(1);
    expect(log[0][1].status).toBe('deferred');
    expect(log[0][1].reason).toBe('outside_business_hours');
    expect(store.collection(BUDGET_COLLECTION)).toHaveLength(0);
  });

  it('a Test record is not gated by the clock at all', async () => {
    // NOT mockReturnValueOnce: a Test record never consults this gate, so an unconsumed `Once`
    // survives clearAllMocks (which drops calls, not queued implementations) and fires in the NEXT
    // test. beforeEach re-establishes the inside-hours default, so a plain mockReturnValue is scoped.
    (checkBusinessHours as jest.Mock).mockReturnValue({
      timezone: 'America/Denver',
      localTime: '2026-08-01T03:00:00',
      wasFallback: false,
    });
    expect((await sendEmail(args())).status).toBe('sent');
  });
});

describe('the consuming gates, and what they do NOT burn', () => {
  it('the hourly bucket defers past the real window reset, not a few minutes in', async () => {
    // A short jitter would land back in the still-full window and re-fail — the deferral loop.
    process.env.OUTBOUND_EMAILS_PER_HOUR = '1';
    try {
      const a = args({ memory: mem({ record_type: 'Real' }) });
      expect((await sendEmail(a)).status).toBe('sent');
      const second = await sendEmail(a);
      expect(second.status).toBe('deferred');
      expect(second.reason).toBe('hourly_bucket');
      // The retry is at least the window reset away, not seconds.
      const retryIn = new Date(second.retry_at!).getTime() - Date.now();
      expect(retryIn).toBeGreaterThan(60_000);
    } finally {
      delete process.env.OUTBOUND_EMAILS_PER_HOUR;
    }
  });

  it('the per-recipient cap RELEASES the domain budget on its terminal skip', async () => {
    process.env.EMAILS_PER_RECIPIENT_PER_DAY = '1';
    try {
      const a = args({ memory: mem({ record_type: 'Real' }) });
      await sendEmail(a);
      const day = new Date().toISOString().slice(0, 10);
      const afterFirst = Number(
        store.get(`${BUDGET_COLLECTION}/mail.example.com_${day}`)!.count
      );

      const second = await sendEmail(a);
      expect(second.status).toBe('skipped');
      expect(second.reason).toBe('recipient-daily-cap');
      // The budget it consumed on the way in was handed back.
      expect(
        Number(store.get(`${BUDGET_COLLECTION}/mail.example.com_${day}`)!.count)
      ).toBe(afterFirst);
    } finally {
      delete process.env.EMAILS_PER_RECIPIENT_PER_DAY;
    }
  });

  it('a TEST record runs the full gate stack but consumes no domain budget', async () => {
    const r = await sendEmail(args()); // memory defaults to record_type Test
    expect(r.status).toBe('sent');
    expect(store.collection(BUDGET_COLLECTION)).toHaveLength(0);
    // But it WAS verified — the quality gates still applied.
    expect(verify).toHaveBeenCalled();
  });
});

describe('the send outcome', () => {
  it('writes a labelled send-log row on success', async () => {
    await sendEmail(args());
    const rows = store.collection(SEND_LOG);
    expect(rows).toHaveLength(1);
    expect(rows[0][1].status).toBe('sent');
    expect(rows[0][1].profile).toBe(PROFILE_OUTREACH);
    expect(rows[0][1].origin).toBe(ORIGIN_LLM_TOOL);
    expect(rows[0][1].domain).toBe('mail.example.com');
  });

  it('rolls the outcome up onto the chat for a single-read per-chat view', async () => {
    await sendEmail(args());
    const meta = store.get(`chats/${CHAT}`)!.email_meta as Record<
      string,
      never
    >;
    expect((meta.counts as Record<string, number>).sent).toBe(1);
    expect((meta.by_profile as Record<string, number>).outreach).toBe(1);
  });

  it('records a provider failure with its cause and returns the budget token', async () => {
    send.mockResolvedValue({
      success: false,
      skipped: false,
      message_id: null,
      error: 'sendgrid 400: bad payload',
    });
    const r = await sendEmail(args({ memory: mem({ record_type: 'Real' }) }));
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('sendgrid_error');
    const day = new Date().toISOString().slice(0, 10);
    // A SYNCHRONOUS failure returns its token; an async bounce would not.
    expect(
      Number(store.get(`${BUDGET_COLLECTION}/mail.example.com_${day}`)!.count)
    ).toBe(0);
  });

  it('audits every non-sent outcome to the send log with its reason', async () => {
    await suppress(TO, 'hard-bounce');
    await sendEmail(args());
    const rows = store.collection(SEND_LOG);
    expect(rows).toHaveLength(1);
    expect(rows[0][1].status).toBe('skipped');
    expect(String(rows[0][1].reason)).toContain('hard-bounce');
  });

  it('passes correlation ids and the stream category to the transport', async () => {
    await sendEmail(args({ campaignId: 'camp1' }));
    const payload = send.mock.calls[0][0] as Record<string, never>;
    const ca = payload.custom_args as Record<string, string>;
    expect(ca.agent_id).toBe('agentA');
    expect(ca.campaign_id).toBe('camp1');
    expect(ca.profile).toBe(PROFILE_OUTREACH);
    expect(ca.log_id).toBeTruthy();
    expect(payload.categories).toEqual(['Nova Outbound Comms']);
  });

  it('short-circuits playground without touching budgets or the send log', async () => {
    send.mockResolvedValue({
      success: true,
      skipped: true,
      message_id: 'playground',
      error: null,
    });
    const r = await sendEmail(args({ isPlayground: true }));
    expect(r.status).toBe('sent');
    expect(store.collection(SEND_LOG)).toHaveLength(0);
    expect(store.collection(BUDGET_COLLECTION)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('G5 — the compliance builder is code-appended, never prompt-dependent', () => {
  const opts = {
    companyName: 'Acme',
    postalAddress: '1 Test St',
    unsubBaseUrl: 'https://unsub.example.com/u',
    unsubMailto: 'unsub@example.com',
    resolvedName: 'Nova',
  };

  beforeEach(() => {
    process.env.UNSUB_SIGNING_KEY_V1 = 'k1';
  });

  it('puts identity and physical address on EVERY profile', () => {
    for (const p of [
      PROFILE_OUTREACH,
      PROFILE_REPLY,
      PROFILE_TRANSACTIONAL,
    ] as const) {
      const b = buildCompliance(TO, 'body', null, p, 'Nova', opts);
      expect(b.text).toContain('Nova | Acme');
      expect(b.text).toContain('1 Test St');
    }
  });

  it('adds the unsubscribe machinery ONLY to cold outreach', () => {
    const cold = buildCompliance(
      TO,
      'body',
      null,
      PROFILE_OUTREACH,
      'Nova',
      opts
    );
    expect(cold.headers['List-Unsubscribe']).toContain(
      'https://unsub.example.com/u'
    );
    expect(cold.headers['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click'
    );
    expect(cold.text).toContain('opt out:');

    for (const p of [PROFILE_REPLY, PROFILE_TRANSACTIONAL] as const) {
      const b = buildCompliance(TO, 'body', null, p, 'Nova', opts);
      expect(b.headers['List-Unsubscribe']).toBeUndefined();
      expect(b.text).not.toContain('opt out:');
    }
  });

  it('falls back to a mailto opt-out WITHOUT claiming one-click', () => {
    // A mailto is a valid CAN-SPAM opt-out but is not RFC 8058 one-click, which is HTTPS-only.
    const b = buildCompliance(TO, 'body', null, PROFILE_OUTREACH, 'Nova', {
      ...opts,
      unsubBaseUrl: '',
    });
    expect(b.headers['List-Unsubscribe']).toBe(
      '<mailto:unsub@example.com?subject=unsubscribe>'
    );
    expect(b.headers['List-Unsubscribe-Post']).toBeUndefined();
    expect(b.text).toContain('To unsubscribe, email');
  });

  it('omits List-Unsubscribe entirely when no target is configured', () => {
    const b = buildCompliance(TO, 'body', null, PROFILE_OUTREACH, 'Nova', {
      ...opts,
      unsubBaseUrl: '',
      unsubMailto: '',
    });
    expect(b.headers['List-Unsubscribe']).toBeUndefined();
  });

  it('appends the footer to BOTH MIME parts', () => {
    const b = buildCompliance(
      TO,
      'body',
      '<p>body</p>',
      PROFILE_OUTREACH,
      'Nova',
      opts
    );
    expect(b.text).toContain('Acme');
    expect(b.html).toContain('Acme');
    expect(b.html).toContain('<hr');
  });

  it('url-encodes the address into the opt-out link', () => {
    const b = buildCompliance(
      'a+b@example.com',
      'body',
      null,
      PROFILE_OUTREACH,
      'Nova',
      opts
    );
    expect(b.headers['List-Unsubscribe']).toContain('a%2Bb%40example.com');
  });
});
