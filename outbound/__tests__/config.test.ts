/**
 * @jest-environment node
 *
 * NOTE: this docblock MUST be the first comment in the file — jest only reads pragmas from the
 * leading docblock, so anything above it (even a comment) silently drops the file back to the
 * project default of jsdom. Outbound is server code, so it needs the node environment.
 *
 * The two boolean env conventions are load-bearing and encode opposite intents, so they get a test:
 * reading one backwards silently flips a safety gate (a default-ON guard becoming OFF, or an
 * explicit opt-in like sandbox mode turning itself on). Everything else here is a thin accessor.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import {
  OutboundIntegrationNotConfigured,
  envInt,
  envIntList,
  envList,
  envStr,
  flagDefaultOff,
  flagDefaultOn,
  isConfigured,
  requireEnv,
} from '../config';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('flagDefaultOn — kill-switches', () => {
  it('is ON when unset', () => {
    delete process.env.OB_TEST_FLAG;
    expect(flagDefaultOn('OB_TEST_FLAG')).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'FALSE', 'Off', ' no '])(
    'is OFF for the explicit off-value %p',
    (value) => {
      process.env.OB_TEST_FLAG = value;
      expect(flagDefaultOn('OB_TEST_FLAG')).toBe(false);
    }
  );

  it.each(['1', 'true', 'yes', 'on', 'anything'])(
    'stays ON (fail-safe) for %p',
    (value) => {
      process.env.OB_TEST_FLAG = value;
      expect(flagDefaultOn('OB_TEST_FLAG')).toBe(true);
    }
  );

  it('treats an empty string as unset, not as off', () => {
    process.env.OB_TEST_FLAG = '';
    expect(flagDefaultOn('OB_TEST_FLAG')).toBe(true);
  });
});

describe('flagDefaultOff — explicit opt-ins', () => {
  it('is OFF when unset', () => {
    delete process.env.OB_TEST_FLAG;
    expect(flagDefaultOff('OB_TEST_FLAG')).toBe(false);
  });

  it.each(['true', 'TRUE', ' True '])(
    'is ON only for the literal %p',
    (value) => {
      process.env.OB_TEST_FLAG = value;
      expect(flagDefaultOff('OB_TEST_FLAG')).toBe(true);
    }
  );

  it.each(['1', 'yes', 'on', '0', 'false', 'anything'])(
    'stays OFF for %p — nothing but "true" enables it',
    (value) => {
      process.env.OB_TEST_FLAG = value;
      expect(flagDefaultOff('OB_TEST_FLAG')).toBe(false);
    }
  );
});

describe('envInt / envStr / envList', () => {
  it('falls back rather than throwing on a non-numeric value', () => {
    process.env.OB_TEST_NUM = 'not-a-number';
    expect(envInt('OB_TEST_NUM', 10)).toBe(10);
  });

  it('parses a numeric value and trims whitespace', () => {
    process.env.OB_TEST_NUM = ' 42 ';
    expect(envInt('OB_TEST_NUM', 10)).toBe(42);
  });

  it('treats blank as unset', () => {
    process.env.OB_TEST_STR = '   ';
    expect(envStr('OB_TEST_STR', 'fallback')).toBe('fallback');
  });

  it('splits lists and drops blanks', () => {
    process.env.OB_TEST_LIST = 'a, b ,, c';
    expect(envList('OB_TEST_LIST', '')).toEqual(['a', 'b', 'c']);
  });

  it('parses int lists, dropping non-numerics', () => {
    process.env.OB_TEST_LIST = '1,3,x,7';
    expect(envIntList('OB_TEST_LIST', '')).toEqual([1, 3, 7]);
  });

  it('uses the fallback list when unset', () => {
    delete process.env.OB_TEST_LIST;
    expect(envIntList('OB_TEST_LIST', '1,3,5,7')).toEqual([1, 3, 5, 7]);
  });
});

describe('requireEnv', () => {
  it('returns every requested value when all are set', () => {
    process.env.OB_A = 'a';
    process.env.OB_B = 'b';
    expect(requireEnv('Thing', ['OB_A', 'OB_B'])).toEqual({
      OB_A: 'a',
      OB_B: 'b',
    });
  });

  it('names ALL missing keys in one error, so activation is a single env edit', () => {
    delete process.env.OB_A;
    delete process.env.OB_B;
    process.env.OB_C = 'c';

    expect(() => requireEnv('Thing', ['OB_A', 'OB_B', 'OB_C'])).toThrow(
      OutboundIntegrationNotConfigured
    );

    try {
      requireEnv('Thing', ['OB_A', 'OB_B', 'OB_C']);
      throw new Error('expected requireEnv to throw');
    } catch (err) {
      const e = err as OutboundIntegrationNotConfigured;
      expect(e.integration).toBe('Thing');
      expect(e.missing).toEqual(['OB_A', 'OB_B']);
      expect(e.message).toContain('OB_A, OB_B');
    }
  });

  it('isConfigured gates without throwing', () => {
    process.env.OB_A = 'a';
    delete process.env.OB_B;
    expect(isConfigured(['OB_A'])).toBe(true);
    expect(isConfigured(['OB_A', 'OB_B'])).toBe(false);
  });
});
