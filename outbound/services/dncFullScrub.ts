/**
 * DNCScrub Full Scrub client.
 *
 * One self-contained client for DNCScrub's consolidated Full Scrub endpoint, which returns a SINGLE
 * `ResultCode` covering federal and state DNC, litigator, internal DNC, wireless/VoIP, EBR, and
 * calling times — plus a `LineType` used by the line-type gate.
 *
 *     GET https://www.dncscrub.com/app/main/rpc/scrub?phoneList={10digit}&version=5&output=json
 *     header: loginId: <DNCSCRUB_LOGIN_ID>
 *
 * ## The clean set is an allowlist, deliberately
 *
 * `C W X E O H V F G` mean "not on a DNC list / callable". Anything NOT in that set is treated as
 * `isClean: false`, so an undocumented or newly-introduced code can never accidentally pass. `Y`
 * (VoIP) is called out in the docstring because it is returned in practice and blocks, even though
 * DNCScrub's own guide groups it loosely.
 *
 * ## Fail-open, but only on transport
 *
 * Any HTTP or parse error returns `isClean: null` — inconclusive, not clean — so the caller does not
 * block a lead on a DNCScrub outage. The distinction matters: `false` is a scrub that ran and said
 * no, `null` is a scrub that never got an answer, and the call-time gate is the backstop for the
 * latter.
 */

import { envStr } from '../config';

export const FULL_SCRUB_URL = 'https://www.dncscrub.com/app/main/rpc/scrub';
const FULL_SCRUB_VERSION = '5';
const REQUEST_TIMEOUT_MS = 20_000;

/** ResultCodes meaning "not on a DNC list / callable". Everything else blocks. */
const CLEAN_CODES: ReadonlySet<string> = new Set([
  'C',
  'W',
  'X',
  'E',
  'O',
  'H',
  'V',
  'F',
  'G',
]);

export type LineType = 'landline' | 'mobile' | 'voip' | 'unknown';

/** DNCScrub `LineType` → our normalized values. */
const LINE_TYPE_MAP: Readonly<Record<string, LineType>> = {
  allother: 'landline',
  landline: 'landline',
  wireless: 'mobile',
  mobile: 'mobile',
  voip: 'voip',
};

function loginId(explicit?: string | null): string {
  return explicit || envStr('DNCSCRUB_LOGIN_ID');
}

/** Strip to a 10-digit NANP number, dropping a leading country `1`. */
export function normalizePhone(phone: unknown): string {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeLineType(raw: unknown): LineType {
  return (
    LINE_TYPE_MAP[
      String(raw ?? '')
        .trim()
        .toLowerCase()
    ] ?? 'unknown'
  );
}

/** Locate the element matching `phone10` in an array- or object-shaped response body. */
function findForPhone(
  body: unknown,
  phone10: string
): Record<string, unknown> | null {
  if (Array.isArray(body)) {
    for (const el of body) {
      if (
        el &&
        typeof el === 'object' &&
        normalizePhone((el as Record<string, unknown>).Phone) === phone10
      ) {
        return el as Record<string, unknown>;
      }
    }
    const first = body[0];
    return first && typeof first === 'object'
      ? (first as Record<string, unknown>)
      : null;
  }
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return null;
}

export interface FullScrubResult {
  phone: string | null;
  result_code: string | null;
  reason: string;
  line_type: LineType;
  /** `null` means inconclusive — the scrub never got an answer. Distinct from a `false` verdict. */
  is_clean: boolean | null;
  is_litigator: boolean;
  /** The full API element, persisted verbatim onto the chat as `dnc_scrub_output`. */
  raw: Record<string, unknown> | null;
  status_code: number | null;
  error: string | null;
}

/** Run a Full Scrub on a single phone. */
export async function fullScrub(
  phone: unknown,
  explicitLoginId?: string | null
): Promise<FullScrubResult> {
  const result: FullScrubResult = {
    phone: null,
    result_code: null,
    reason: '',
    line_type: 'unknown',
    is_clean: null,
    is_litigator: false,
    raw: null,
    status_code: null,
    error: null,
  };

  const p = normalizePhone(phone);
  result.phone = p;
  if (p.length !== 10) {
    result.error = 'invalid_phone';
    return result;
  }

  const key = loginId(explicitLoginId);
  if (!key) {
    result.error = 'missing DNCSCRUB_LOGIN_ID';
    return result;
  }

  let body: unknown;
  try {
    const url = new URL(FULL_SCRUB_URL);
    url.searchParams.set('phoneList', p);
    url.searchParams.set('version', FULL_SCRUB_VERSION);
    url.searchParams.set('output', 'json');

    const resp = await fetch(url, {
      headers: { loginId: key },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    result.status_code = resp.status;

    const text = await resp.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (resp.status >= 400) {
      result.error = `http_${resp.status}: ${String(body).slice(0, 200)}`;
      console.warn(`[FULL_SCRUB] ${p.slice(-4)} -> ${result.error}`);
      return result;
    }
  } catch (e) {
    result.error = String(e).slice(0, 200);
    console.warn(`[FULL_SCRUB] request failed for ***${p.slice(-4)}: ${e}`);
    return result;
  }

  const el = findForPhone(body, p);
  if (!el) {
    result.error = 'no_result_for_phone';
    return result;
  }

  const code = String(el.ResultCode ?? '')
    .trim()
    .toUpperCase();
  const reason = String(el.Reason ?? '').trim();
  result.raw = el;
  result.result_code = code;
  result.reason = reason;
  result.line_type = normalizeLineType(el.LineType);
  result.is_clean = code ? CLEAN_CODES.has(code) : null;
  result.is_litigator =
    code === 'D' && reason.toLowerCase().includes('litigator');
  return result;
}
