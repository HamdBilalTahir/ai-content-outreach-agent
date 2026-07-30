/**
 * Business-hours guard and scheduling helpers for outbound calls.
 *
 * Window rules (**calls only** — email and reminder follow-ups send at any time):
 *
 *  - Customer timezone known (cached on `memory.timezone`, or resolvable from a US area code) →
 *    **9:00 AM – 6:55 PM** local, Mon–Fri.
 *  - Timezone unknown (international, unmapped US area code, corrupt cache) →
 *    **11:00 AM – 4:55 PM US Eastern**, a deliberately tighter cross-coast fallback so a guess can
 *    never place a call at 6am Pacific.
 *  - The `:55` cutoff rather than `:00` leaves an in-flight voice call a five-minute buffer.
 *
 * Calls are also blocked on weekends and on US federal holidays (plus state holidays when the state
 * is known).
 *
 * **Every failure mode is permissive by design.** If timezone resolution or the holiday calendar
 * blows up entirely, the guard returns ALLOW rather than breaking the calling tool. A guard that
 * throws stops all outreach; a guard that occasionally allows a call slightly outside the window is
 * the lesser failure. The one exception is that an unknown timezone tightens rather than widens the
 * window — that path is reached often enough to matter.
 */

import { DateTime } from 'luxon';

import { getStateForPhone, getTimezoneForPhone } from '../utils/timezoneLookup';
import type { ChatMemory } from '../types';

/** Customer-timezone-known window: 9:00 AM to 6:55 PM local. */
export const BUSINESS_HOURS_START_MIN = 9 * 60;
export const BUSINESS_HOURS_END_MIN = 18 * 60 + 55;

/**
 * Fallback window when the customer timezone is unknown.
 * 11 AM – 4:55 PM ET is roughly 8 AM – 1:55 PM PT: comfortably business hours coast to coast.
 */
export const FALLBACK_HOURS_START_MIN = 11 * 60;
export const FALLBACK_HOURS_END_MIN = 16 * 60 + 55;
export const FALLBACK_TZ = 'America/New_York';

// ─────────────────────────────────────────────────────────────────────────────
// US federal + state holiday detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The holiday calendar is loaded lazily and **guarded**, mirroring the source's optional
 * `holidays` import: when the package is unavailable or throws, every holiday check returns `false`
 * (fail-open) so calls are never wrongly blocked and the guard never raises.
 *
 * NOTE: this is `date-holidays`, a different implementation from the Python `holidays` package. The
 * fail-open contract and the federal/state split are preserved, but exact date parity between the
 * two libraries is not guaranteed.
 */
type HolidayChecker = { isHoliday(date: Date): unknown };

let holidaysCtor:
  | (new (...args: string[]) => HolidayChecker)
  | null
  | undefined;

function loadHolidays(): (new (...args: string[]) => HolidayChecker) | null {
  if (holidaysCtor !== undefined) return holidaysCtor;
  try {
    holidaysCtor = require('date-holidays') as new (
      ...args: string[]
    ) => HolidayChecker;
  } catch {
    holidaysCtor = null;
    console.warn(
      '[OB business_hours] `date-holidays` not available — holiday checks disabled (fail-open).'
    );
  }
  return holidaysCtor;
}

/** Cache calendars by `state|year`; `state` empty means federal-only. */
const HOLIDAY_CACHE = new Map<string, HolidayChecker | null>();

function holidayCalendar(
  state: string | null,
  year: number
): HolidayChecker | null {
  const Ctor = loadHolidays();
  if (!Ctor) return null;

  const key = `${state ?? ''}|${year}`;
  if (HOLIDAY_CACHE.has(key)) return HOLIDAY_CACHE.get(key) ?? null;

  let cal: HolidayChecker | null = null;
  try {
    cal = state ? new Ctor('US', state) : new Ctor('US');
  } catch (e) {
    // An unknown state code must not break the guard — fall back to federal-only.
    console.warn(
      `[OB business_hours] holidays US/${String(state)} raised: ${e} — falling back to federal-only`
    );
    try {
      cal = new Ctor('US');
    } catch {
      cal = null;
    }
  }
  HOLIDAY_CACHE.set(key, cal);
  return cal;
}

/**
 * True iff `d` is a US federal holiday, or (when `state` is given) a state holiday.
 * Fail-open: `false` whenever the calendar is unavailable.
 */
export function isHoliday(d: Date, state?: string | null): boolean {
  const fed = holidayCalendar(null, d.getUTCFullYear());
  if (!fed) return false;
  try {
    if (fed.isHoliday(d)) return true;
  } catch {
    return false;
  }
  if (!state) return false;
  const st = holidayCalendar(state, d.getUTCFullYear());
  if (!st) return false;
  try {
    return Boolean(st.isHoliday(d));
  } catch {
    return false;
  }
}

/** Federal-only holiday check. */
export function isUsFederalHoliday(d: Date): boolean {
  return isHoliday(d, null);
}

/**
 * E.164 country code → a representative IANA timezone.
 *
 * Without this, an international contact (say +972) would fall to the ET window, which is a poor
 * proxy for their local business hours. Both the business-hours check and the deferral retry-time
 * use this resolver, so the two stay in sync. Matched longest-prefix-first.
 */
const COUNTRY_CODE_TZ: Readonly<Record<string, string>> = {
  '972': 'Asia/Jerusalem',
  '971': 'Asia/Dubai',
  '44': 'Europe/London',
  '61': 'Australia/Sydney',
  '91': 'Asia/Kolkata',
  '92': 'Asia/Karachi',
  '353': 'Europe/Dublin',
  '33': 'Europe/Paris',
  '49': 'Europe/Berlin',
  '34': 'Europe/Madrid',
  '39': 'Europe/Rome',
  '52': 'America/Mexico_City',
  '55': 'America/Sao_Paulo',
  '63': 'Asia/Manila',
  '65': 'Asia/Singapore',
  '27': 'Africa/Johannesburg',
  '64': 'Pacific/Auckland',
  '31': 'Europe/Amsterdam',
  '48': 'Europe/Warsaw',
  '20': 'Africa/Cairo',
};

/**
 * Best-effort IANA zone for a non-US E.164 number, from the country-code map.
 * `1` (US/Canada) returns `null` — that is the area-code lookup's job, which is far more precise.
 */
function timezoneFromCountryCode(digits: string): string | null {
  if (digits.startsWith('1')) return null;
  for (const length of [3, 2, 1]) {
    const cc = digits.slice(0, length);
    if (cc in COUNTRY_CODE_TZ) return COUNTRY_CODE_TZ[cc];
  }
  return null;
}

/**
 * Resolve the customer's IANA timezone: cached `memory.timezone` first, then the US area-code
 * lookup, then the non-US country-code fallback. `null` only when nothing resolves, at which point
 * callers use the tighter ET window.
 */
export function resolveCustomerTimezone(
  phoneNumber: string | undefined,
  chatMemory: ChatMemory | null | undefined
): string | null {
  const cached = chatMemory?.timezone;
  if (cached) return String(cached);
  if (!phoneNumber) return null;
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) return null;
  return getTimezoneForPhone(digits) ?? timezoneFromCountryCode(digits);
}

/**
 * Resolve the customer's 2-letter US state: cached `memory.state` first, else the area-code lookup.
 * `null` for international or unmapped numbers, which means federal-only holiday checking.
 */
export function resolveCustomerState(
  phoneNumber: string | undefined,
  chatMemory: ChatMemory | null | undefined
): string | null {
  const cached = chatMemory?.state;
  if (cached) return String(cached).toUpperCase();
  if (!phoneNumber) return null;
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) return null;
  return getStateForPhone(digits);
}

function isValidZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** Minutes since local midnight — the unit the `:55` cutoff is expressed in. */
function minutesOfDay(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

/** luxon weekday is 1=Mon..7=Sun, so 6 and 7 are the weekend. */
function isWeekend(dt: DateTime): boolean {
  return dt.weekday >= 6;
}

/** A `Date` carrying the LOCAL calendar date, for the holiday calendars (which are date-only). */
function localCalendarDate(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day));
}

export interface BusinessHoursBlock {
  /** The timezone the decision was made in, or `null` when the call is allowed. */
  timezone: string | null;
  /** Local time at the moment of the decision, or `null` when allowed. */
  localTime: Date | null;
  /** True when the decision fell back to Eastern because the customer zone was unknown. */
  wasFallback: boolean;
}

/**
 * Decide whether a call may be placed right now.
 *
 * Returns `{timezone: null, localTime: null, wasFallback: false}` when the call is ALLOWED, and a
 * populated object when BLOCKED. Any one of holiday, weekend, or outside-the-window blocks.
 *
 * The two-value return exists so the caller can explain the deferral and compute the retry time in
 * the same timezone the block was decided in.
 */
export function checkBusinessHours(
  phoneNumber: string | undefined,
  chatMemory: ChatMemory | null | undefined
): BusinessHoursBlock {
  const allowed: BusinessHoursBlock = {
    timezone: null,
    localTime: null,
    wasFallback: false,
  };

  let tzName = resolveCustomerTimezone(phoneNumber, chatMemory);
  const state = resolveCustomerState(phoneNumber, chatMemory);

  if (tzName && !isValidZone(tzName)) tzName = null; // corrupt cache — use the fallback

  if (tzName) {
    const nowLocal = DateTime.now().setZone(tzName);
    const blocked: BusinessHoursBlock = {
      timezone: tzName,
      localTime: nowLocal.toJSDate(),
      wasFallback: false,
    };
    if (isHoliday(localCalendarDate(nowLocal), state)) return blocked;
    if (isWeekend(nowLocal)) return blocked;
    const mins = minutesOfDay(nowLocal);
    if (mins >= BUSINESS_HOURS_START_MIN && mins < BUSINESS_HOURS_END_MIN)
      return allowed;
    return blocked;
  }

  let etNow: DateTime;
  try {
    etNow = DateTime.now().setZone(FALLBACK_TZ);
    if (!etNow.isValid) throw new Error('invalid zone');
  } catch {
    // Timezone machinery catastrophically broken — allow rather than break the tool.
    return allowed;
  }

  const blocked: BusinessHoursBlock = {
    timezone: FALLBACK_TZ,
    localTime: etNow.toJSDate(),
    wasFallback: true,
  };
  if (isHoliday(localCalendarDate(etNow), null)) return blocked;
  if (isWeekend(etNow)) return blocked;
  const mins = minutesOfDay(etNow);
  if (mins >= FALLBACK_HOURS_START_MIN && mins < FALLBACK_HOURS_END_MIN)
    return allowed;
  return blocked;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling helpers — placing a voice task inside the prospect's local window
// ─────────────────────────────────────────────────────────────────────────────

/** A day is blocked for calls if it is a weekend or a holiday (state-aware). */
function dayIsBlocked(local: DateTime, state: string | null): boolean {
  return isWeekend(local) || isHoliday(localCalendarDate(local), state);
}

/** Same-day 09:00 in the same zone. */
function startOfDay(local: DateTime): DateTime {
  return local.set({
    hour: Math.floor(BUSINESS_HOURS_START_MIN / 60),
    minute: BUSINESS_HOURS_START_MIN % 60,
    second: 0,
    millisecond: 0,
  });
}

/**
 * Advance to the next allowed business-hours moment:
 *  - inside the window on an allowed day → unchanged
 *  - before the window on an allowed day → that day's 09:00
 *  - after the window, or a blocked day → the next allowed day's 09:00
 *
 * The loop is bounded at 14 days so a misconfigured calendar can never spin forever.
 */
function nextAllowedSlot(local: DateTime, state: string | null): DateTime {
  let cur = local;
  for (let i = 0; i < 14; i += 1) {
    if (dayIsBlocked(cur, state)) {
      cur = startOfDay(cur.plus({ days: 1 }));
      continue;
    }
    const mins = minutesOfDay(cur);
    if (mins < BUSINESS_HOURS_START_MIN) return startOfDay(cur);
    if (mins >= BUSINESS_HOURS_END_MIN) {
      cur = startOfDay(cur.plus({ days: 1 }));
      continue;
    }
    return cur; // inside the window on an allowed day
  }
  return cur; // give up gracefully after the bound
}

/**
 * Clamp a specific datetime forward into the prospect's local window, skipping weekends and
 * holidays. Best-effort: returns the input unchanged on any error, so scheduling never blocks.
 */
export function clampToBusinessHours(
  dt: Date,
  tz?: string | null,
  state?: string | null
): Date {
  try {
    const zone = tz || 'UTC';
    const local = DateTime.fromJSDate(dt, { zone });
    if (!local.isValid) return dt;
    return nextAllowedSlot(
      local,
      state ? state.toUpperCase() : null
    ).toJSDate();
  } catch (e) {
    console.warn(
      `[OB business_hours] clampToBusinessHours failed (${e}); returning input unchanged`
    );
    return dt;
  }
}

/**
 * 09:00 local on the business day `dayOffset` BUSINESS days from now, skipping weekends and
 * holidays. `dayOffset = 0` is the next allowed business day (today, if today is not blocked).
 * Used by the campaign pacer to stagger enrollments across days at a daily cap.
 */
export function businessHoursStartAfter(
  dayOffset: number,
  tz?: string | null,
  state?: string | null
): Date {
  try {
    const zone = tz || FALLBACK_TZ;
    const st = state ? state.toUpperCase() : null;
    let day = startOfDay(nextAllowedSlot(DateTime.now().setZone(zone), st));
    for (let i = 0; i < Math.max(0, Math.trunc(dayOffset || 0)); i += 1) {
      day = startOfDay(nextAllowedSlot(startOfDay(day.plus({ days: 1 })), st));
    }
    return day.toJSDate();
  } catch (e) {
    console.warn(
      `[OB business_hours] businessHoursStartAfter failed (${e}); returning now`
    );
    return new Date();
  }
}

/**
 * A DISTRIBUTED moment for the `slot`-th contact (0-based) of a cohort on the business day
 * `dayOffset` days out.
 *
 * Spreads `perDay` contacts evenly across the 9:00–18:55 window instead of clustering them all at
 * 09:00 — otherwise a campaign fires its whole daily cohort in one burst, which reads as spam and
 * bursts the voice/email providers.
 *
 * Deterministic on purpose (no RNG): the offset is a pure function of `(slot, perDay)`, which is
 * what makes a paused campaign resumable to the same schedule.
 */
export function businessHoursSlot(
  dayOffset: number,
  slot: number,
  perDay: number,
  tz?: string | null,
  state?: string | null
): Date {
  const base = businessHoursStartAfter(dayOffset, tz, state);
  try {
    const per = Math.max(1, Math.trunc(perDay || 1));
    const idx = Math.max(0, Math.trunc(slot || 0));
    const windowSeconds =
      (BUSINESS_HOURS_END_MIN - BUSINESS_HOURS_START_MIN) * 60;
    // Callers pass `index % perDay`, so slot < perDay and the offset always stays inside the same
    // allowed day's window (<= 18:55).
    const offset = Math.trunc((idx * windowSeconds) / per);
    const st = state ? state.toUpperCase() : null;
    const zone = tz || FALLBACK_TZ;
    const shifted = DateTime.fromJSDate(base, { zone }).plus({
      seconds: offset,
    });
    // Re-clamp for safety (a no-op in-window); guarantees a valid, non-blocked moment.
    return nextAllowedSlot(shifted, st).toJSDate();
  } catch (e) {
    console.warn(
      `[OB business_hours] businessHoursSlot failed (${e}); returning day start`
    );
    return base;
  }
}

/**
 * The next valid business-hours moment from NOW in the prospect's timezone: inside the window →
 * now + 2 minutes; otherwise the next allowed slot's start. Best-effort: now + 5 minutes on error.
 *
 * The 2-minute nudge rather than "now" gives the caller's own write a moment to land before the
 * cron could pick the task up again.
 */
export function nextBusinessHoursStart(
  tz?: string | null,
  state?: string | null
): Date {
  try {
    const zone = tz || FALLBACK_TZ;
    const nowLocal = DateTime.now().setZone(zone);
    if (!nowLocal.isValid) throw new Error('invalid zone');
    const st = state ? state.toUpperCase() : null;
    if (!dayIsBlocked(nowLocal, st)) {
      const mins = minutesOfDay(nowLocal);
      if (mins >= BUSINESS_HOURS_START_MIN && mins < BUSINESS_HOURS_END_MIN) {
        return nowLocal.plus({ minutes: 2 }).toJSDate();
      }
    }
    return nextAllowedSlot(nowLocal, st).toJSDate();
  } catch (e) {
    console.warn(
      `[OB business_hours] nextBusinessHoursStart failed (${e}); returning now + 5 min`
    );
    return new Date(Date.now() + 5 * 60_000);
  }
}

/** Exposed for tests: the pure day-advance decision, independent of the current clock. */
export const __testing = {
  nextAllowedSlot,
  dayIsBlocked,
  startOfDay,
  minutesOfDay,
  isWeekend,
};
