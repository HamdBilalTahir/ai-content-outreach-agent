/**
 * @jest-environment node
 *
 * The DNC registry's request validation.
 *
 * Two behaviours carry the weight:
 *
 *  - **The bulk paste.** The admin form's real input is a copy-paste out of a spreadsheet, so any run of
 *    non-digits separates codes. If this regressed to comma-only, half the paste would land as one
 *    unparseable token and the registry would silently under-register.
 *  - **Invalid codes are REPORTED, not rejected.** One bad token still saves the good ones. That is the
 *    opposite of the campaign audience validator, and the asymmetry is deliberate — see the note in
 *    `serializers.ts`.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

import {
  areaCodesField,
  validateDncDelete,
  validateDncUpsert,
} from '../../http/serializers';

describe('areaCodesField', () => {
  it.each([
    ['303, 770, 610', ['303', '770', '610']],
    ['303 770\n610', ['303', '770', '610']],
    ['303;770|610', ['303', '770', '610']],
    ['  303,,,770  ', ['303', '770']],
  ])('splits the bulk paste %p on any run of non-digits', (input, expected) => {
    expect(areaCodesField(input)).toEqual({ value: expected });
  });

  it('accepts an array of strings and numbers, trimming each', () => {
    expect(areaCodesField([' 303 ', 770])).toEqual({
      value: ['303', '770'],
    });
  });

  it('drops empty tokens from an array rather than failing', () => {
    expect(areaCodesField(['303', '', '  '])).toEqual({ value: ['303'] });
  });

  it('rejects a boolean inside the array', () => {
    // `String(true)` is `"True"` in Python and `"true"` here — never what a caller meant, so DRF
    // excludes `bool` from its accepted scalar types explicitly and so does this.
    expect(areaCodesField(['303', true])).toEqual({
      error: 'each area code must be a string',
    });
  });

  it('rejects a nested object inside the array', () => {
    expect(areaCodesField([{ code: '303' }])).toEqual({
      error: 'each area code must be a string',
    });
  });

  it.each([[42], [null], [{ a: 1 }]])('rejects the whole value %p', (input) => {
    expect(areaCodesField(input)).toEqual({
      error: 'must be a list of strings or a single string',
    });
  });
});

describe('validateDncUpsert', () => {
  it('validates, dedupes, and normalizes a well-formed body', () => {
    const result = validateDncUpsert({
      area_codes: '303, 770, 303',
      san_id: ' SAN-1 ',
      org_id: 'ORG-9',
      san_expiry_date: '12/31/2026',
    });
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({
      valid_area_codes: ['303', '770'],
      invalid_area_codes: [],
      san_id: 'SAN-1',
      org_id: 'ORG-9',
      // Normalized from MM/DD/YYYY, which the admin form accepts.
      san_expiry_date: '2026-12-31',
    });
  });

  it('merges the single area_code into the list', () => {
    const result = validateDncUpsert({
      area_codes: ['303'],
      area_code: '770',
    });
    expect(result.data?.valid_area_codes).toEqual(['303', '770']);
  });

  it('accepts area_code alone', () => {
    expect(
      validateDncUpsert({ area_code: '303' }).data?.valid_area_codes
    ).toEqual(['303']);
  });

  it('REPORTS invalid tokens alongside the valid ones', () => {
    // Not a rejection: this endpoint registers which codes may be scrubbed, so a dropped token narrows
    // the registry and is safe. The campaign audience validator resolves the opposite way, because
    // there a dropped token would widen the dialled audience past what was scrubbed.
    const result = validateDncUpsert({ area_codes: '303, 1, 99999, 770' });
    expect(result.valid).toBe(true);
    expect(result.data?.valid_area_codes).toEqual(['303', '770']);
    expect(result.data?.invalid_area_codes).toEqual(['1', '99999']);
  });

  it('400s only when NOTHING is valid, and names what was rejected', () => {
    const result = validateDncUpsert({ area_codes: '1, 2, 199' });
    expect(result.valid).toBe(false);
    expect(result.errors?.area_codes[0]).toContain(
      'No valid 3-digit area codes found'
    );
    expect(result.errors?.area_codes[0]).toContain('199');
  });

  it.each([[{}], [{ area_codes: [] }], [{ area_code: '' }], [{ san_id: 'x' }]])(
    'requires a code somewhere — %p',
    (body) => {
      const result = validateDncUpsert(body);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual({
        area_codes: ['Provide area_codes (array or string) or area_code.'],
      });
    }
  );

  it('rejects an unparseable expiry with the format hint', () => {
    const result = validateDncUpsert({
      area_codes: ['303'],
      san_expiry_date: 'next year',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual({
      san_expiry_date: ['Use format YYYY-MM-DD (MM/DD/YYYY also accepted).'],
    });
  });

  it('reports the FIELD error alone, without also running the object pass', () => {
    // DRF runs field validation first and only reaches `validate()` if every field passed. So a body
    // with both a bad date and no codes reports the date — complaining about codes it never looked at
    // would send the form chasing two problems when it has one.
    const result = validateDncUpsert({ san_expiry_date: 'nope' });
    expect(Object.keys(result.errors ?? {})).toEqual(['san_expiry_date']);
  });

  it.each([[''], [null]])(
    'treats a %p expiry as "no expiry recorded"',
    (given) => {
      const result = validateDncUpsert({
        area_codes: ['303'],
        san_expiry_date: given,
      });
      expect(result.valid).toBe(true);
      expect(result.data?.san_expiry_date).toBeNull();
    }
  );

  it('passes an omitted san_id/org_id through as null', () => {
    const result = validateDncUpsert({ area_codes: ['303'] });
    expect(result.data?.san_id).toBeNull();
    expect(result.data?.org_id).toBeNull();
  });

  it('accepts an explicitly null san_id, since the field allows null', () => {
    const result = validateDncUpsert({ area_codes: ['303'], san_id: null });
    expect(result.valid).toBe(true);
    expect(result.data?.san_id).toBeNull();
  });

  it('rejects a non-string san_id', () => {
    const result = validateDncUpsert({
      area_codes: ['303'],
      san_id: { id: 1 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual({ san_id: ['Not a valid string.'] });
  });

  it('reports a malformed area_codes value under its own field', () => {
    const result = validateDncUpsert({ area_codes: 42 });
    expect(result.errors).toEqual({
      area_codes: ['must be a list of strings or a single string'],
    });
  });
});

describe('validateDncDelete', () => {
  it('accepts and trims a valid code', () => {
    expect(validateDncDelete(' 303 ')).toEqual({
      valid: true,
      data: { area_code: '303' },
    });
  });

  it.each([[undefined], [null], ['']])('requires a code — %p', (given) => {
    expect(validateDncDelete(given)).toEqual({
      valid: false,
      errors: { area_code: ['This field is required.'] },
    });
  });

  it.each([['1'], ['1303'], ['103'], ['abc']])(
    'rejects the malformed code %p',
    (given) => {
      const result = validateDncDelete(given);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual({
        area_code: ['must be a 3-digit NANP area code (first digit 2-9).'],
      });
    }
  );
});
