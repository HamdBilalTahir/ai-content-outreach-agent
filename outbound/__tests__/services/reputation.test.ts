/**
 * @jest-environment node
 *
 * Domain reputation: the circuit breaker, the warm-up ramp, and the daily budget.
 *
 * The properties worth pinning, each of which is a decision the source makes deliberately:
 *  - the breaker window is TIME-based, so a halt can clear as rows age out (a count-based window
 *    would deadlock — halted means no new rows, so the rate would never fall);
 *  - a single bounce NEVER halts, because a rate computed from one event is not a rate;
 *  - warm-up is stricter on complaints than post-warm-up, since one complaint at cap 10 IS a crisis;
 *  - a missing or unparseable start date holds the ramp at the SMALLEST cap, never ramp-complete;
 *  - audit rows (failed/skipped/deferred) must not dilute the breaker's rates;
 *  - the budget fails CLOSED, unlike a rate limiter.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  BREAKER_COLLECTION,
  BREAKER_DOC_ID,
  BUDGET_COLLECTION,
  RAMP,
  SEND_LOG,
  breakerCheck,
  consumeDomainBudget,
  domainOf,
  effectiveDailyCap,
  inWarmup,
  logEmailOutcome,
  newSendLogRef,
  rampCap,
  releaseDomainBudget,
  writeSendLog,
} from '../../services/reputation';

const DOMAIN = 'mail.example.com';
const SENDER = `lily@${DOMAIN}`;

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

function daysAgoDate(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Seed a send-log row. */
function logRow(
  id: string,
  status: string,
  over: Record<string, unknown> = {}
) {
  store.set(`${SEND_LOG}/${id}`, {
    sender: SENDER,
    domain: DOMAIN,
    sent_at: hoursAgo(1),
    status,
    ...over,
  });
}

beforeEach(() => {
  store.reset();
  delete process.env.DOMAIN_START_DATE;
  delete process.env.DOMAIN_DAILY_CAP;
});

describe('domainOf — the reputation key', () => {
  it('extracts and lowercases the sending domain', () => {
    expect(domainOf('Lily@Mail.Example.COM')).toBe('mail.example.com');
    expect(domainOf('  a@b.co  ')).toBe('b.co');
  });

  it('is empty for a non-address', () => {
    expect(domainOf('nodomain')).toBe('');
    expect(domainOf('')).toBe('');
    expect(domainOf(null)).toBe('');
  });
});

describe('the warm-up ramp', () => {
  it('steps at each rung and never regresses', () => {
    expect(rampCap(0)).toBe(10);
    expect(rampCap(3)).toBe(10);
    expect(rampCap(4)).toBe(20);
    expect(rampCap(7)).toBe(20);
    expect(rampCap(8)).toBe(35);
    expect(rampCap(12)).toBe(50);
    expect(rampCap(999)).toBe(50); // stays at the last rung
  });

  it('holds at the SMALLEST cap when the start date is missing', () => {
    // The fail-safe must never be ramp-complete: a misconfiguration would send full volume cold.
    expect(effectiveDailyCap(1000, null)).toBe(RAMP[0][1]);
  });

  it('holds at day 0 for an unparseable or future start date', () => {
    expect(effectiveDailyCap(1000, 'not-a-date')).toBe(10);
    const future = new Date(Date.now() + 86_400_000 * 30)
      .toISOString()
      .slice(0, 10);
    expect(effectiveDailyCap(1000, future)).toBe(10);
  });

  it('takes the MIN of the configured cap and the ramp', () => {
    expect(effectiveDailyCap(1000, daysAgoDate(20))).toBe(50); // ramp complete, cap is the limit
    expect(effectiveDailyCap(5, daysAgoDate(20))).toBe(5); // configured cap is lower
    expect(effectiveDailyCap(1000, daysAgoDate(5))).toBe(20); // ramp is lower
  });

  it('accepts a full ISO start date as well as a bare day', () => {
    expect(effectiveDailyCap(1000, `${daysAgoDate(20)}T12:00:00Z`)).toBe(50);
  });

  it('falls back to DOMAIN_DAILY_CAP for an invalid per-agent cap', () => {
    process.env.DOMAIN_DAILY_CAP = '7';
    expect(effectiveDailyCap('nonsense', daysAgoDate(20))).toBe(7);
    expect(effectiveDailyCap(null, daysAgoDate(20))).toBe(7);
  });

  it('inWarmup is true while the ramp is strictly below the configured cap', () => {
    expect(inWarmup(1000, daysAgoDate(0))).toBe(true);
    expect(inWarmup(50, daysAgoDate(20))).toBe(false); // ramp reached 50 == cap → done
    expect(inWarmup(10, daysAgoDate(0))).toBe(false); // ramp 10 == cap 10 → never in warm-up
    expect(inWarmup(20, daysAgoDate(0))).toBe(true); // ramp 10 < cap 20
  });

  it('stays PERMANENTLY in warm-up when the configured cap exceeds the ramp ceiling', () => {
    // The ramp tops out at 50, so any cap above it is never reached and `inWarmup` never goes false.
    // That is not a bug: it keeps the stricter first-complaint-halts rule in force for a domain
    // configured beyond what the ramp will ever authorize, which is the conservative reading.
    expect(rampCap(9_999)).toBe(50);
    expect(inWarmup(1000, daysAgoDate(9_999))).toBe(true);
  });
});

describe('the circuit breaker', () => {
  it('is clear with no traffic', async () => {
    const r = await breakerCheck(DOMAIN);
    expect(r.halted).toBe(false);
    expect(r.stats).toEqual({
      sends_72h: 0,
      bounces_72h: 0,
      complaints_72h: 0,
    });
  });

  it('does NOT halt on a single bounce, whatever the rate', async () => {
    // 1/1 is a 100% bounce rate, but one event is not a rate.
    logRow('a', 'bounced');
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(r.halted).toBe(false);
    expect(r.stats).toMatchObject({ sends_72h: 1, bounces_72h: 1 });
  });

  it('halts once the rate AND the event floor are both met', async () => {
    logRow('a', 'bounced');
    logRow('b', 'bounced');
    for (let i = 0; i < 20; i += 1) logRow(`s${i}`, 'sent');
    // 2/22 ≈ 9% ≥ 2%, and 2 ≥ 2 events.
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(r.halted).toBe(true);
    expect(r.reason).toContain('bounce rate');
  });

  it('does not halt below the rate threshold even with many events', async () => {
    logRow('a', 'bounced');
    logRow('b', 'bounced');
    for (let i = 0; i < 300; i += 1) logRow(`s${i}`, 'sent');
    // 2/302 ≈ 0.7% — under 2%.
    expect((await breakerCheck(DOMAIN, 1000, daysAgoDate(30))).halted).toBe(
      false
    );
  });

  it('halts on the FIRST complaint during warm-up', async () => {
    logRow('c', 'complained');
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(0)); // day 0 → in warm-up
    expect(r.halted).toBe(true);
    expect(r.reason).toContain('warm-up');
  });

  it('post-warm-up, one complaint warns and two halt', async () => {
    logRow('c', 'complained');
    for (let i = 0; i < 50; i += 1) logRow(`s${i}`, 'sent');
    expect((await breakerCheck(DOMAIN, 10, daysAgoDate(30))).halted).toBe(
      false
    );
    logRow('c2', 'complained');
    const r = await breakerCheck(DOMAIN, 10, daysAgoDate(30));
    expect(r.halted).toBe(true);
    expect(r.reason).toContain('complaints');
  });

  it('EXCLUDES audit rows from the send count, so deferrals cannot dilute the rate', async () => {
    logRow('a', 'bounced');
    logRow('b', 'bounced');
    for (let i = 0; i < 500; i += 1) {
      logRow(`d${i}`, 'deferred', { reason: 'domain_budget' });
    }
    // If deferrals counted, 2/502 would be under threshold and this would not halt.
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(r.stats).toMatchObject({ sends_72h: 2 });
    expect(r.halted).toBe(true);
  });

  it('counts bounced and complained rows as SENDS — they did leave the system', async () => {
    logRow('a', 'bounced');
    logRow('b', 'complained');
    logRow('c', 'sent');
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(r.stats).toMatchObject({ sends_72h: 3 });
  });

  it('ignores rows outside the 72h window, which is how a halt clears by TIME', async () => {
    logRow('old1', 'bounced', { sent_at: hoursAgo(100) });
    logRow('old2', 'bounced', { sent_at: hoursAgo(96) });
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(r.stats).toMatchObject({ sends_72h: 0 });
    expect(r.halted).toBe(false);
  });

  it('isolates domains — one domain’s bounces never halt another', async () => {
    logRow('a', 'bounced', { domain: 'other.com', sender: 'x@other.com' });
    logRow('b', 'bounced', { domain: 'other.com', sender: 'x@other.com' });
    const r = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(r.stats).toMatchObject({ sends_72h: 0 });
    expect(r.halted).toBe(false);
    // The other domain IS halted.
    expect(
      (await breakerCheck('other.com', 1000, daysAgoDate(30))).halted
    ).toBe(true);
  });

  it('falls back to deriving the domain from the sender when the row has no domain field', async () => {
    logRow('a', 'bounced', { domain: undefined });
    logRow('b', 'bounced', { domain: undefined });
    expect(
      (await breakerCheck(DOMAIN, 1000, daysAgoDate(30))).stats
    ).toMatchObject({ sends_72h: 2 });
  });

  it('honours a per-domain force_halt regardless of rates', async () => {
    store.set(`${BREAKER_COLLECTION}/${DOMAIN}`, {
      force_halt: true,
      set_by: 'hamd',
    });
    const r = await breakerCheck(DOMAIN);
    expect(r.halted).toBe(true);
    expect(r.reason).toContain('hamd');
  });

  it('honours the MASTER force_halt for every domain', async () => {
    store.set(`${BREAKER_COLLECTION}/${BREAKER_DOC_ID}`, {
      force_halt: true,
      set_by: 'ops',
    });
    const r = await breakerCheck('any.domain.com');
    expect(r.halted).toBe(true);
    expect(r.reason).toContain('master');
  });

  it('force-resumes on a FUTURE override_until, and ignores a past one', async () => {
    logRow('a', 'bounced');
    logRow('b', 'bounced');
    for (let i = 0; i < 20; i += 1) logRow(`s${i}`, 'sent');

    store.set(`${BREAKER_COLLECTION}/${DOMAIN}`, {
      override_until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const overridden = await breakerCheck(DOMAIN, 1000, daysAgoDate(30));
    expect(overridden.halted).toBe(false);
    expect(overridden.reason).toContain('override_until');
    // Stats are still reported while overridden, so ops can see what it is suppressing.
    expect(overridden.stats).toMatchObject({ bounces_72h: 2 });

    store.set(`${BREAKER_COLLECTION}/${DOMAIN}`, {
      override_until: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect((await breakerCheck(DOMAIN, 1000, daysAgoDate(30))).halted).toBe(
      true
    );
  });

  it('ignores an unparseable override_until rather than force-resuming on it', async () => {
    logRow('a', 'bounced');
    logRow('b', 'bounced');
    for (let i = 0; i < 20; i += 1) logRow(`s${i}`, 'sent');
    store.set(`${BREAKER_COLLECTION}/${DOMAIN}`, {
      override_until: 'garbage',
    });
    expect((await breakerCheck(DOMAIN, 1000, daysAgoDate(30))).halted).toBe(
      true
    );
  });
});

describe('the domain daily budget', () => {
  it('increments transactionally up to the effective cap, then refuses', async () => {
    const start = daysAgoDate(0); // ramp cap 10
    for (let i = 1; i <= 10; i += 1) {
      const r = await consumeDomainBudget(DOMAIN, 1000, start);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
      expect(r.cap).toBe(10);
    }
    const over = await consumeDomainBudget(DOMAIN, 1000, start);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(10);
  });

  it('keeps a separate counter per domain and per day', async () => {
    const start = daysAgoDate(0);
    await consumeDomainBudget('a.com', 1000, start);
    await consumeDomainBudget('b.com', 1000, start);
    const day = new Date().toISOString().slice(0, 10);
    expect(store.get(`${BUDGET_COLLECTION}/a.com_${day}`)!.count).toBe(1);
    expect(store.get(`${BUDGET_COLLECTION}/b.com_${day}`)!.count).toBe(1);
  });

  it('uses the bare day key for a legacy call with no domain', async () => {
    await consumeDomainBudget('', 1000, daysAgoDate(0));
    const day = new Date().toISOString().slice(0, 10);
    expect(store.get(`${BUDGET_COLLECTION}/${day}`)!.count).toBe(1);
  });

  it('fails CLOSED on a storage error — this is a reputation control, not a rate control', async () => {
    const spy = jest.spyOn(store.docs, 'get').mockImplementation(() => {
      throw new Error('firestore down');
    });
    try {
      const r = await consumeDomainBudget(DOMAIN, 1000, daysAgoDate(0));
      expect(r.allowed).toBe(false);
      expect(r.count).toBe(-1);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a token on a synchronous failure', async () => {
    const start = daysAgoDate(0);
    await consumeDomainBudget(DOMAIN, 1000, start);
    await consumeDomainBudget(DOMAIN, 1000, start);
    await releaseDomainBudget(DOMAIN);
    const day = new Date().toISOString().slice(0, 10);
    expect(store.get(`${BUDGET_COLLECTION}/${DOMAIN}_${day}`)!.count).toBe(1);
  });

  it('never throws when releasing against a missing counter', async () => {
    await expect(releaseDomainBudget('nope.com')).resolves.toBeUndefined();
  });
});

describe('the send log', () => {
  it('writes a labelled successful-send row', async () => {
    const ref = newSendLogRef();
    await writeSendLog(ref, {
      agent_id: 'ag1',
      sender: SENDER,
      recipient: 'Cust@Example.com',
      profile: 'outreach',
      origin: 'llm_tool',
      chat_id: 'c1',
      campaign_id: 'camp1',
    });
    const [[, row]] = store.collection(SEND_LOG);
    expect(row.status).toBe('sent');
    expect(row.recipient).toBe('cust@example.com'); // lowercased
    expect(row.domain).toBe(DOMAIN); // derived from the sender
    expect(row.profile).toBe('outreach');
    expect(row.origin).toBe('llm_tool');
  });

  it('writes an audit row carrying the reason, and truncates a long error', async () => {
    await logEmailOutcome({
      agent_id: 'ag1',
      sender: SENDER,
      recipient: 'c@e.com',
      status: 'deferred',
      reason: 'domain_budget',
      error: 'e'.repeat(900),
    });
    const [[, row]] = store.collection(SEND_LOG);
    expect(row.status).toBe('deferred');
    expect(row.reason).toBe('domain_budget');
    expect(row.error).toHaveLength(500);
  });

  it('reuses a pre-allocated ref so an async event can correlate to the row', async () => {
    const ref = newSendLogRef();
    await logEmailOutcome({
      sender: SENDER,
      recipient: 'c@e.com',
      status: 'failed',
      ref,
    });
    expect(store.collection(SEND_LOG)).toHaveLength(1);
    expect(store.get(`${SEND_LOG}/${ref.id}`)!.status).toBe('failed');
  });
});
