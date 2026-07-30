/**
 * @jest-environment node
 *
 * Timezone/state resolution, plus an EQUIVALENCE CHECK of the derived ZIP3 maps against the Python
 * source's own output.
 *
 * The equivalence check is the important one: the ZIP3 tables are 949 entries built from 56 SCF
 * ranges plus 37 split-state overrides, and a single off-by-one in a range boundary would silently
 * put a prospect in the wrong timezone — which then places a call at the wrong local hour. The
 * fixture was dumped from the Python module, so this asserts the TS derivation reproduces it exactly.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import expected from '../../testSupport/fixtures/zip3FromPythonSource.json';
import {
  AREA_CODE_TO_STATE,
  AREA_CODE_TO_TIMEZONE,
  ZIP3_TO_STATE,
  ZIP3_TO_TIMEZONE,
  extractUsAreaCode,
  getStateForPhone,
  getStateForZip,
  getTimezoneForPhone,
  getTimezoneForZip,
} from '../../utils/timezoneLookup';

describe('derived ZIP3 tables match the Python source exactly', () => {
  it('ZIP3_TO_STATE is identical', () => {
    expect(ZIP3_TO_STATE).toEqual(expected.ZIP3_TO_STATE);
  });

  it('ZIP3_TO_TIMEZONE is identical', () => {
    expect(ZIP3_TO_TIMEZONE).toEqual(expected.ZIP3_TO_TIMEZONE);
  });

  it('covers 949 ZIP3 prefixes', () => {
    expect(Object.keys(ZIP3_TO_STATE)).toHaveLength(949);
    expect(Object.keys(ZIP3_TO_TIMEZONE)).toHaveLength(949);
  });
});

describe('generated area-code tables', () => {
  it('carry the source counts', () => {
    expect(Object.keys(AREA_CODE_TO_TIMEZONE)).toHaveLength(332);
    expect(Object.keys(AREA_CODE_TO_STATE)).toHaveLength(331);
  });

  it('preserves the post-hoc overrides applied at the bottom of the source module', () => {
    // 217 is corrected from Eastern to Central, and 340 (US Virgin Islands) to Puerto Rico time.
    expect(AREA_CODE_TO_TIMEZONE['217']).toBe('America/Chicago');
    expect(AREA_CODE_TO_TIMEZONE['340']).toBe('America/Puerto_Rico');
  });
});

describe('extractUsAreaCode', () => {
  it('reads a 10-digit number', () => {
    expect(extractUsAreaCode('3035550123')).toBe('303');
  });

  it('reads an 11-digit number with the country code', () => {
    expect(extractUsAreaCode('13035550123')).toBe('303');
  });

  it('rejects non-digits, wrong lengths, and an 11-digit non-US number', () => {
    expect(extractUsAreaCode('+1 303 555 0123')).toBeNull(); // must be pre-normalized
    expect(extractUsAreaCode('303555')).toBeNull();
    expect(extractUsAreaCode('97235551234')).toBeNull(); // 11 digits but not leading 1
    expect(extractUsAreaCode('')).toBeNull();
  });
});

describe('getTimezoneForPhone / getStateForPhone', () => {
  it.each([
    ['3035550123', 'America/Denver', 'CO'],
    ['2125550123', 'America/New_York', 'NY'],
    ['3105550123', 'America/Los_Angeles', 'CA'],
    ['3125550123', 'America/Chicago', 'IL'],
  ])('resolves %s to %s / %s', (phone, tz, state) => {
    expect(getTimezoneForPhone(phone)).toBe(tz);
    expect(getStateForPhone(phone)).toBe(state);
  });

  it('returns null for an unmapped or unparseable number', () => {
    expect(getTimezoneForPhone('9995550123')).toBeNull();
    expect(getStateForPhone('nonsense')).toBeNull();
  });
});

describe('getStateForZip / getTimezoneForZip', () => {
  it('resolves a 5-digit ZIP', () => {
    expect(getStateForZip('80202')).toBe('CO');
    expect(getTimezoneForZip('80202')).toBe('America/Denver');
  });

  it('resolves a ZIP+4', () => {
    expect(getStateForZip('80202-1234')).toBe('CO');
  });

  it('honours the split-state overrides', () => {
    // The FL panhandle is Central, not Eastern like the rest of the state.
    expect(getStateForZip('32501')).toBe('FL');
    expect(getTimezoneForZip('32501')).toBe('America/Chicago');
    // TN east is Eastern.
    expect(getTimezoneForZip('37402')).toBe('America/New_York');
    // TX El Paso is Mountain.
    expect(getTimezoneForZip('79901')).toBe('America/Denver');
    // MI Upper Peninsula.
    expect(getTimezoneForZip('49938')).toBe('America/Menominee');
  });

  it('returns null for non-US or unparseable input', () => {
    expect(getStateForZip('M5V 3A8')).toBeNull(); // Canadian postcode
    expect(getStateForZip('SW1A')).toBeNull();
    expect(getStateForZip('ab')).toBeNull();
    expect(getStateForZip(null)).toBeNull();
    expect(getTimezoneForZip(undefined)).toBeNull();
  });

  it('accepts a numeric ZIP', () => {
    expect(getStateForZip(80202)).toBe('CO');
  });
});
