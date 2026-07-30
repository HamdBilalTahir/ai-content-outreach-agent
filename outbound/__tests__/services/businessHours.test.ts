/**
 * @jest-environment node
 *
 * The business-hours guard.
 *
 * This is the gate that decides whether a prospect gets phoned right now, so every boundary matters:
 * the `:55` cutoff exists to leave an in-flight call a buffer, and the tighter unknown-timezone
 * window exists so a guess can never dial someone at 6am. The clock is frozen per test — a
 * time-dependent guard tested against the real clock is a flaky test that passes at 2pm and fails at
 * 9pm.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import {
  BUSINESS_HOURS_END_MIN,
  BUSINESS_HOURS_START_MIN,
  FALLBACK_HOURS_END_MIN,
  FALLBACK_HOURS_START_MIN,
  FALLBACK_TZ,
  businessHoursSlot,
  businessHoursStartAfter,
  checkBusinessHours,
  clampToBusinessHours,
  nextBusinessHoursStart,
  resolveCustomerState,
  resolveCustomerTimezone,
} from '../../services/businessHours';

/** Freeze the clock at a UTC instant. */
function freeze(iso: string): void {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  jest.setSystemTime(new Date(iso));
}

afterEach(() => {
  jest.useRealTimers();
});

describe('window constants', () => {
  it('uses a :55 cutoff, not :00, to leave an in-flight call a buffer', () => {
    expect(BUSINESS_HOURS_START_MIN).toBe(9 * 60);
    expect(BUSINESS_HOURS_END_MIN).toBe(18 * 60 + 55);
  });

  it('uses a TIGHTER window when the timezone is unknown', () => {
    // 11:00-16:55 ET is ~8:00-13:55 PT — business hours coast to coast.
    expect(FALLBACK_HOURS_START_MIN).toBe(11 * 60);
    expect(FALLBACK_HOURS_END_MIN).toBe(16 * 60 + 55);
    expect(FALLBACK_HOURS_END_MIN - FALLBACK_HOURS_START_MIN).toBeLessThan(
      BUSINESS_HOURS_END_MIN - BUSINESS_HOURS_START_MIN
    );
  });
});

describe('resolveCustomerTimezone', () => {
  it('prefers the cached memory value over the area code', () => {
    expect(
      resolveCustomerTimezone('3035550123', { timezone: 'Asia/Tokyo' })
    ).toBe('Asia/Tokyo');
  });

  it('falls back to the US area-code lookup', () => {
    expect(resolveCustomerTimezone('3035550123', {})).toBe('America/Denver');
  });

  it('resolves a non-US number through the country-code map', () => {
    // Without this an international contact would land on the ET window, a poor proxy for their day.
    expect(resolveCustomerTimezone('+972 50 555 1234', {})).toBe(
      'Asia/Jerusalem'
    );
    expect(resolveCustomerTimezone('447700900123', {})).toBe('Europe/London');
  });

  it('returns null for an unknown number so the caller uses the tighter window', () => {
    expect(resolveCustomerTimezone('9995550123', {})).toBeNull();
    expect(resolveCustomerTimezone('', {})).toBeNull();
  });
});

describe('resolveCustomerState', () => {
  it('prefers memory and upper-cases it', () => {
    expect(resolveCustomerState('3035550123', { state: 'ny' })).toBe('NY');
  });

  it('falls back to the area code', () => {
    expect(resolveCustomerState('3035550123', {})).toBe('CO');
  });

  it('returns null for international numbers — federal holidays only', () => {
    expect(resolveCustomerState('+972505551234', {})).toBeNull();
  });
});

describe('checkBusinessHours — known timezone', () => {
  const memory = { timezone: 'America/Denver', state: 'CO' };

  it('ALLOWS a weekday mid-window', () => {
    freeze('2026-03-04T18:00:00Z'); // Wed 11:00 MST
    expect(checkBusinessHours('3035550123', memory).timezone).toBeNull();
  });

  it('BLOCKS just before the window opens', () => {
    freeze('2026-03-04T15:59:00Z'); // Wed 08:59 MST
    const r = checkBusinessHours('3035550123', memory);
    expect(r.timezone).toBe('America/Denver');
    expect(r.wasFallback).toBe(false);
  });

  it('ALLOWS exactly at the window open', () => {
    freeze('2026-03-04T16:00:00Z'); // Wed 09:00 MST
    expect(checkBusinessHours('3035550123', memory).timezone).toBeNull();
  });

  it('ALLOWS at 18:54 but BLOCKS at 18:55 — the cutoff is exclusive', () => {
    freeze('2026-03-05T01:54:00Z'); // Wed 18:54 MST
    expect(checkBusinessHours('3035550123', memory).timezone).toBeNull();
    freeze('2026-03-05T01:55:00Z'); // Wed 18:55 MST
    expect(checkBusinessHours('3035550123', memory).timezone).toBe(
      'America/Denver'
    );
  });

  it('BLOCKS all day Saturday and Sunday', () => {
    freeze('2026-03-07T18:00:00Z'); // Sat 11:00 MST
    expect(checkBusinessHours('3035550123', memory).timezone).toBe(
      'America/Denver'
    );
    freeze('2026-03-08T18:00:00Z'); // Sun 11:00 MST
    expect(checkBusinessHours('3035550123', memory).timezone).toBe(
      'America/Denver'
    );
  });

  it('falls back to the ET window when the cached timezone is corrupt', () => {
    freeze('2026-03-04T18:00:00Z'); // Wed 13:00 ET — inside the fallback window
    const r = checkBusinessHours('9995550123', { timezone: 'Not/AZone' });
    expect(r.timezone).toBeNull(); // allowed via the fallback
  });
});

describe('checkBusinessHours — unknown timezone falls back to Eastern', () => {
  it('ALLOWS inside 11:00-16:55 ET', () => {
    freeze('2026-03-04T17:00:00Z'); // Wed 12:00 EST
    expect(checkBusinessHours('9995550123', {}).timezone).toBeNull();
  });

  it('BLOCKS at 10:59 ET, before the tighter window opens', () => {
    freeze('2026-03-04T15:59:00Z'); // Wed 10:59 EST
    const r = checkBusinessHours('9995550123', {});
    expect(r.timezone).toBe(FALLBACK_TZ);
    expect(r.wasFallback).toBe(true);
  });

  it('BLOCKS at 17:00 ET, after it closes — even though a known-tz prospect would be allowed', () => {
    freeze('2026-03-04T22:00:00Z'); // Wed 17:00 EST
    expect(checkBusinessHours('9995550123', {}).wasFallback).toBe(true);
  });

  it('BLOCKS on the weekend', () => {
    freeze('2026-03-07T17:00:00Z'); // Sat 12:00 EST
    expect(checkBusinessHours('9995550123', {}).timezone).toBe(FALLBACK_TZ);
  });
});

describe('nextBusinessHoursStart', () => {
  it('nudges 2 minutes forward when already inside the window', () => {
    // Not "now" — the 2-minute gap lets the caller's own write land before the cron re-reads it.
    freeze('2026-03-04T18:00:00Z'); // Wed 11:00 MST
    const at = nextBusinessHoursStart('America/Denver', 'CO');
    expect(at.getTime()).toBe(new Date('2026-03-04T18:02:00Z').getTime());
  });

  it('moves to today 09:00 when called before the window', () => {
    freeze('2026-03-04T13:00:00Z'); // Wed 06:00 MST
    const at = nextBusinessHoursStart('America/Denver', 'CO');
    expect(at.toISOString()).toBe('2026-03-04T16:00:00.000Z'); // 09:00 MST
  });

  it('moves to the next morning when called after the window', () => {
    freeze('2026-03-04T04:00:00Z'); // Tue 21:00 MST
    const at = nextBusinessHoursStart('America/Denver', 'CO');
    expect(at.toISOString()).toBe('2026-03-04T16:00:00.000Z'); // Wed 09:00 MST
  });

  it('skips the weekend to Monday morning, ACROSS the DST transition', () => {
    // Deliberately spans the 2026 US DST start (Sun 8 March): Saturday is MST (UTC-7) but the
    // Monday it lands on is MDT (UTC-6), so 09:00 local is 15:00Z, not 16:00Z. The window is
    // defined in LOCAL wall-clock minutes, so an implementation doing naive UTC arithmetic would
    // schedule this an hour late every spring.
    freeze('2026-03-07T18:00:00Z'); // Sat 11:00 MST
    const at = nextBusinessHoursStart('America/Denver', 'CO');
    expect(at.toISOString()).toBe('2026-03-09T15:00:00.000Z'); // Mon 09:00 MDT
  });

  it('keeps 09:00 local on both sides of the DST boundary', () => {
    freeze('2026-03-04T04:00:00Z'); // Tue 21:00 MST — before DST
    expect(nextBusinessHoursStart('America/Denver', 'CO').toISOString()).toBe(
      '2026-03-04T16:00:00.000Z' // 09:00 MST = UTC-7
    );
    freeze('2026-03-10T04:00:00Z'); // Mon 22:00 MDT — after DST
    expect(nextBusinessHoursStart('America/Denver', 'CO').toISOString()).toBe(
      '2026-03-10T15:00:00.000Z' // 09:00 MDT = UTC-6
    );
  });
});

describe('clampToBusinessHours', () => {
  it('leaves an in-window datetime unchanged', () => {
    freeze('2026-03-04T12:00:00Z');
    const dt = new Date('2026-03-04T18:00:00Z'); // Wed 11:00 MST
    expect(clampToBusinessHours(dt, 'America/Denver', 'CO').getTime()).toBe(
      dt.getTime()
    );
  });

  it('pushes a pre-dawn datetime to 09:00 the same day', () => {
    freeze('2026-03-04T12:00:00Z');
    const dt = new Date('2026-03-04T11:00:00Z'); // Wed 04:00 MST
    expect(clampToBusinessHours(dt, 'America/Denver', 'CO').toISOString()).toBe(
      '2026-03-04T16:00:00.000Z'
    );
  });

  it('pushes a Saturday datetime to Monday 09:00 local (MDT, post-DST)', () => {
    freeze('2026-03-04T12:00:00Z');
    const dt = new Date('2026-03-07T18:00:00Z'); // Sat
    expect(clampToBusinessHours(dt, 'America/Denver', 'CO').toISOString()).toBe(
      '2026-03-09T15:00:00.000Z'
    );
  });
});

describe('businessHoursStartAfter', () => {
  it('offset 0 is the next allowed business day at 09:00', () => {
    freeze('2026-03-04T13:00:00Z'); // Wed 06:00 MST
    expect(
      businessHoursStartAfter(0, 'America/Denver', 'CO').toISOString()
    ).toBe('2026-03-04T16:00:00.000Z');
  });

  it('counts BUSINESS days, skipping the weekend', () => {
    freeze('2026-03-06T13:00:00Z'); // Fri 06:00 MST
    // +1 business day from Friday is Monday, not Saturday. 09:00 MDT once DST has begun.
    expect(
      businessHoursStartAfter(1, 'America/Denver', 'CO').toISOString()
    ).toBe('2026-03-09T15:00:00.000Z');
  });
});

describe('businessHoursSlot', () => {
  it('slot 0 is the day start', () => {
    freeze('2026-03-04T13:00:00Z');
    expect(
      businessHoursSlot(0, 0, 10, 'America/Denver', 'CO').toISOString()
    ).toBe('2026-03-04T16:00:00.000Z');
  });

  it('spreads a cohort evenly across the window instead of clustering at 09:00', () => {
    // Bursting a whole daily cohort at once reads as spam and bursts the providers.
    freeze('2026-03-04T13:00:00Z');
    const per = 10;
    const times = Array.from({ length: per }, (_, i) =>
      businessHoursSlot(0, i, per, 'America/Denver', 'CO').getTime()
    );
    const uniq = new Set(times);
    expect(uniq.size).toBe(per);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const windowSeconds =
      (BUSINESS_HOURS_END_MIN - BUSINESS_HOURS_START_MIN) * 60;
    const spanSeconds = (times[per - 1] - times[0]) / 1000;
    expect(spanSeconds).toBeLessThan(windowSeconds);
    expect(spanSeconds).toBeGreaterThan(windowSeconds * 0.8);
  });

  it('is deterministic — the same inputs give the same instant, so a paused campaign resumes identically', () => {
    freeze('2026-03-04T13:00:00Z');
    const a = businessHoursSlot(0, 3, 10, 'America/Denver', 'CO').getTime();
    const b = businessHoursSlot(0, 3, 10, 'America/Denver', 'CO').getTime();
    expect(a).toBe(b);
  });

  it('keeps every slot inside the same allowed day', () => {
    freeze('2026-03-04T13:00:00Z');
    const dayStart = businessHoursStartAfter(
      0,
      'America/Denver',
      'CO'
    ).getTime();
    const last = businessHoursSlot(
      0,
      99,
      100,
      'America/Denver',
      'CO'
    ).getTime();
    const windowMs =
      (BUSINESS_HOURS_END_MIN - BUSINESS_HOURS_START_MIN) * 60_000;
    expect(last - dayStart).toBeLessThan(windowMs);
  });

  it('guards against a zero or negative perDay', () => {
    freeze('2026-03-04T13:00:00Z');
    expect(() =>
      businessHoursSlot(0, 0, 0, 'America/Denver', 'CO')
    ).not.toThrow();
  });
});
