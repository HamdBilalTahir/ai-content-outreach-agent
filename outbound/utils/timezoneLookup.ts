/**
 * US area code / ZIP → IANA timezone + state resolution. Pure in-memory lookups, no I/O.
 *
 * This is what lets the business-hours guard schedule a call in the prospect's own local time from
 * nothing but their phone number. Where an area code spans multiple timezones the majority zone is
 * used — a deliberate approximation, since the alternative (refusing to guess) would push every
 * such prospect onto the tighter unknown-timezone fallback window.
 *
 * The data tables live in `./timezoneTables` and are generated from the Python source; the
 * derivations below (`ZIP3_TO_STATE`, `ZIP3_TO_TIMEZONE`) are computed at module load exactly as the
 * source computed them, and a test asserts the result still matches the Python output.
 */

import {
  AREA_CODE_TO_STATE,
  AREA_CODE_TO_TIMEZONE,
  STATE_TO_TIMEZONE,
  ZIP3_STATE_RANGES,
  ZIP3_TIMEZONE_OVERRIDES,
} from './timezoneTables';

export { AREA_CODE_TO_STATE, AREA_CODE_TO_TIMEZONE, STATE_TO_TIMEZONE };

/** ZIP3 → state, expanded from the USPS Sectional Center Facility ranges. */
export const ZIP3_TO_STATE: Readonly<Record<string, string>> = (() => {
  const mapping: Record<string, string> = {};
  for (const [start, end, state] of ZIP3_STATE_RANGES) {
    for (let n = start; n <= end; n += 1) {
      mapping[String(n).padStart(3, '0')] = state;
    }
  }
  return mapping;
})();

/**
 * ZIP3 → timezone: inherited from the ZIP3's state, then the split-state overrides applied on top.
 * Order matters — the overrides must win.
 */
export const ZIP3_TO_TIMEZONE: Readonly<Record<string, string>> = (() => {
  const mapping: Record<string, string> = {};
  for (const [zip3, state] of Object.entries(ZIP3_TO_STATE)) {
    const tz = STATE_TO_TIMEZONE[state];
    if (tz) mapping[zip3] = tz;
  }
  return { ...mapping, ...ZIP3_TIMEZONE_OVERRIDES };
})();

/**
 * Extract the 3-digit NANP area code from a digits-only phone string.
 * Accepts 11 digits starting with `1`, or a bare 10 digits. Anything else is not a recognizable US
 * number and returns `null` — callers then fall back to a country-code lookup or the ET window.
 */
export function extractUsAreaCode(normalizedPhone: string): string | null {
  const s = String(normalizedPhone ?? '');
  if (!s || !/^\d+$/.test(s)) return null;
  if (s.length === 11 && s.startsWith('1')) return s.slice(1, 4);
  if (s.length === 10) return s.slice(0, 3);
  return null;
}

/** IANA timezone for a US phone number, by area code. `null` when unrecognized or unmapped. */
export function getTimezoneForPhone(normalizedPhone: string): string | null {
  const areaCode = extractUsAreaCode(normalizedPhone);
  if (!areaCode) return null;
  return AREA_CODE_TO_TIMEZONE[areaCode] ?? null;
}

/**
 * 2-letter US state for a phone number, by area code. `null` for international or unmapped numbers,
 * which the business-hours guard reads as "federal holidays only".
 */
export function getStateForPhone(normalizedPhone: string): string | null {
  const areaCode = extractUsAreaCode(normalizedPhone);
  if (!areaCode) return null;
  return AREA_CODE_TO_STATE[areaCode] ?? null;
}

/**
 * First 3 digits of a US ZIP. Tolerates 5- and 9-digit forms and surrounding whitespace, and bails
 * cleanly on alphanumeric (non-US) input such as a Canadian or UK postcode.
 */
function extractZip3(zipCode: unknown): string | null {
  if (zipCode === null || zipCode === undefined) return null;
  const s = String(zipCode).trim();
  if (s.length < 3) return null;
  const head = s.slice(0, 3);
  return /^\d{3}$/.test(head) ? head : null;
}

/** 2-letter US state from a ZIP. `null` for non-US or unparseable input. */
export function getStateForZip(zipCode: unknown): string | null {
  const zip3 = extractZip3(zipCode);
  if (!zip3) return null;
  return ZIP3_TO_STATE[zip3] ?? null;
}

/** IANA timezone from a ZIP, honouring the split-state overrides. `null` for non-US input. */
export function getTimezoneForZip(zipCode: unknown): string | null {
  const zip3 = extractZip3(zipCode);
  if (!zip3) return null;
  return ZIP3_TO_TIMEZONE[zip3] ?? null;
}
