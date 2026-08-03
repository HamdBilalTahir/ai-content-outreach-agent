/**
 * Request-body validation for the DNC area-code registry — the port of `serializers.py`.
 *
 * **This is not a general DRF port.** It implements exactly the two serializers the source defines and
 * the field behaviours they actually rely on. A generic `Serializer`/`Field` framework would be a large
 * amount of speculative code in service of two endpoints, and the port's rule is to build what is used.
 *
 * What IS reproduced faithfully, because the FE reads it:
 *
 *  - **The error shape.** `{field: [message, ...]}` — DRF's `serializer.errors`. A field-level failure
 *    and an object-level `ValidationError({field: msg})` both land there, so the form can attach a
 *    message to an input.
 *  - **The two-pass order.** Field validation runs first; the object-level `validate()` runs ONLY if
 *    every field passed. A malformed `san_expiry_date` therefore reports the date problem alone rather
 *    than also complaining about area codes it never got to look at.
 *
 * ## `area_codes` accepts a bulk paste, and that is the point
 *
 * The admin form's real input is a copy-paste out of a spreadsheet or an email. Splitting on any run of
 * non-digits means comma, space, newline, semicolon, and pipe all work without asking the user which
 * separator to use. A list of strings still works for programmatic callers.
 *
 * ## Invalid codes are REPORTED, not rejected
 *
 * A request carrying one bad token still saves the good ones and returns the bad ones under `invalid`.
 * A 400 comes only when NOTHING is valid. That is the opposite of the campaign audience validator,
 * which rejects the whole request on any bad code — deliberately, and for a reason: this endpoint
 * *registers* which codes may be scrubbed, so a rejected token narrows the registry and is safe. There
 * a rejected token would have widened the dialled audience past what was scrubbed.
 */

import {
  isValidAreaCode,
  normalizeExpiry,
  splitValid,
} from '../services/dncAreaCodes';

export interface ValidationResult<T> {
  valid: boolean;
  /** DRF's `serializer.errors`. Present only when `valid` is false. */
  errors?: Record<string, string[]>;
  /** DRF's `validated_data`. Present only when `valid` is true. */
  data?: T;
}

/**
 * DRF's `CharField.to_internal_value`: stringify, then strip (`trim_whitespace` defaults on).
 *
 * `null` is only legal with `allow_null`, and a boolean is rejected outright — DRF excludes `bool` from
 * the accepted scalar types explicitly, because `str(True)` is `"True"` and that is never what a caller
 * meant. Returns the string, or an error message.
 */
function charField(
  value: unknown,
  opts: { allowNull?: boolean } = {}
): { value: string | null } | { error: string } {
  if (value === null || value === undefined) {
    if (opts.allowNull) return { value: null };
    return { error: 'This field may not be null.' };
  }
  if (typeof value === 'boolean' || typeof value === 'object') {
    return { error: 'Not a valid string.' };
  }
  return { value: String(value).trim() };
}

/**
 * DRF's `AreaCodesField`: a list of tokens, from either an array or one bulk-paste string.
 *
 * Per-token VALIDITY is not judged here — only shape. The serializer's object-level pass splits
 * valid from invalid, because that split is what the response reports.
 */
export function areaCodesField(
  data: unknown
): { value: string[] } | { error: string } {
  if (typeof data === 'string') {
    return { value: data.split(/\D+/).filter((t) => t !== '') };
  }
  if (Array.isArray(data)) {
    const out: string[] = [];
    for (const x of data) {
      // Same bool exclusion as `charField`, and for the same reason.
      if (
        typeof x === 'boolean' ||
        (typeof x !== 'string' && typeof x !== 'number')
      ) {
        return { error: 'each area code must be a string' };
      }
      const s = String(x).trim();
      if (s) out.push(s);
    }
    return { value: out };
  }
  return { error: 'must be a list of strings or a single string' };
}

export interface UpsertData {
  /** Deduped, validated 3-digit codes to upsert. */
  valid_area_codes: string[];
  /** Tokens that were not valid area codes — reported, not saved. */
  invalid_area_codes: string[];
  san_id: string | null;
  org_id: string | null;
  /** Normalized to `YYYY-MM-DD`, or `null` when not supplied. */
  san_expiry_date: string | null;
}

/**
 * Validate the POST body.
 *
 * Rejects (400) on exactly three things: a wrong-typed field, an unparseable expiry, or NO valid code.
 * There is no status field — active/inactive is derived from `san_expiry_date` at read time, so an
 * expired SAN is a registry row that stops matching rather than a row someone has to remember to flip.
 */
export function validateDncUpsert(
  body: Record<string, unknown>
): ValidationResult<UpsertData> {
  const errors: Record<string, string[]> = {};

  let rawCodes: string[] = [];
  if (body.area_codes !== undefined && body.area_codes !== null) {
    const parsed = areaCodesField(body.area_codes);
    if ('error' in parsed) errors.area_codes = [parsed.error];
    else rawCodes = parsed.value;
  }

  let single = '';
  if (body.area_code !== undefined && body.area_code !== null) {
    const parsed = charField(body.area_code);
    if ('error' in parsed) errors.area_code = [parsed.error];
    else single = parsed.value ?? '';
  }

  const optional: Record<string, string | null> = {
    san_id: null,
    org_id: null,
  };
  for (const key of ['san_id', 'org_id']) {
    if (body[key] === undefined) continue;
    const parsed = charField(body[key], { allowNull: true });
    if ('error' in parsed) errors[key] = [parsed.error];
    else optional[key] = parsed.value;
  }

  let expiry: string | null = null;
  if (body.san_expiry_date !== undefined) {
    const parsed = charField(body.san_expiry_date, { allowNull: true });
    if ('error' in parsed) {
      errors.san_expiry_date = [parsed.error];
    } else if (parsed.value) {
      const norm = normalizeExpiry(parsed.value);
      if (norm === null) {
        errors.san_expiry_date = [
          'Use format YYYY-MM-DD (MM/DD/YYYY also accepted).',
        ];
      } else {
        expiry = norm;
      }
    }
    // A blank or null expiry is legal and means "no expiry recorded" — it stays null.
  }

  // The object-level pass runs only if every field passed. See the module note.
  if (Object.keys(errors).length > 0) return { valid: false, errors };

  const raw = [...rawCodes];
  if (single) raw.push(single);
  if (raw.length === 0) {
    return {
      valid: false,
      errors: {
        area_codes: ['Provide area_codes (array or string) or area_code.'],
      },
    };
  }

  const [valid, invalid] = splitValid(raw);
  if (valid.length === 0) {
    return {
      valid: false,
      errors: {
        area_codes: [
          'No valid 3-digit area codes found (first digit 2-9). ' +
            `Invalid: ${JSON.stringify(invalid)}`,
        ],
      },
    };
  }

  return {
    valid: true,
    data: {
      valid_area_codes: valid,
      invalid_area_codes: invalid,
      san_id: optional.san_id,
      org_id: optional.org_id,
      san_expiry_date: expiry,
    },
  };
}

/** Validate the DELETE body/query — one area code, required and well-formed. */
export function validateDncDelete(
  areaCode: unknown
): ValidationResult<{ area_code: string }> {
  if (areaCode === null || areaCode === undefined || areaCode === '') {
    return { valid: false, errors: { area_code: ['This field is required.'] } };
  }
  const parsed = charField(areaCode);
  if ('error' in parsed) {
    return { valid: false, errors: { area_code: [parsed.error] } };
  }
  const value = parsed.value ?? '';
  if (!isValidAreaCode(value)) {
    return {
      valid: false,
      errors: {
        area_code: ['must be a 3-digit NANP area code (first digit 2-9).'],
      },
    };
  }
  return { valid: true, data: { area_code: value } };
}
