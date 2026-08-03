/**
 * The FTC DNC area-code registry endpoints — the port of `views/dnc_area_codes.py`.
 *
 * One document per area code, recording the codes our FTC SAN subscription covers. The scrub only runs
 * against registered, unexpired codes, so this registry is what bounds where DNC checking is authorized
 * at all — an unregistered area code is not "assumed clean", it is out of scope for the SAN.
 *
 * ## There is no status field, on purpose
 *
 * Active/inactive is DERIVED from `san_expiry_date` at read time. A stored flag would need someone to
 * remember to flip it on the day a subscription lapsed; a derived one cannot drift. `listAreaCodes`
 * annotates each row with `is_expired`/`is_active`.
 *
 * ## DELETE answers 400 on a failed delete, not 200
 *
 * The source returns `400` when `deleteAreaCode` reports false, which happens for a well-formed code
 * that was not in the registry. That is unusual — a delete of something absent is normally idempotent —
 * but it is the honest answer here: the caller asked to withdraw authorization for a code, and "there
 * was nothing to withdraw" means their mental model of the registry is wrong. Preserved.
 */

import {
  deleteAreaCode,
  listAreaCodes,
  upsertAreaCodes,
} from '../services/dncAreaCodes';
import { validateDncDelete, validateDncUpsert } from './serializers';
import { json } from './types';
import type { OutboundRequest, OutboundResponse } from './types';

/** GET — every registered code, each annotated with its derived active/expired state. */
export async function dncAreaCodesListView(): Promise<OutboundResponse> {
  const rows = await listAreaCodes();
  return json({ success: true, area_codes: rows, count: rows.length });
}

/**
 * POST — add or update codes, with the SAN details applied to every code in the request.
 *
 * `success` tracks whether anything was SAVED, not whether the request was well-formed: a body whose
 * codes were all already present still saves them (the upsert merges), so a `false` here means the
 * write itself did nothing. Invalid tokens come back under `invalid` alongside a 200 — see the note in
 * `serializers.ts` on why this endpoint reports them rather than rejecting the request.
 */
export async function dncAreaCodesUpsertView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const result = validateDncUpsert(request.body);
  if (!result.valid) {
    return json({ success: false, errors: result.errors }, 400);
  }
  const v = result.data!;
  const saved = await upsertAreaCodes(
    v.valid_area_codes,
    v.san_id,
    v.org_id,
    v.san_expiry_date
  );
  return json({
    success: saved.saved.length > 0,
    saved: saved.saved,
    invalid: v.invalid_area_codes,
  });
}

/**
 * DELETE — withdraw one area code.
 *
 * The code may arrive in the body or the query string, because a `DELETE` with a body is awkward for
 * some clients and the source accepts both. Body wins.
 */
export async function dncAreaCodeDeleteView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const supplied = request.body.area_code ?? request.query.area_code;
  const result = validateDncDelete(supplied);
  if (!result.valid) {
    return json({ success: false, errors: result.errors }, 400);
  }
  const areaCode = result.data!.area_code;
  const deleted = await deleteAreaCode(areaCode);
  return json(
    { success: deleted, area_code: areaCode, deleted },
    deleted ? 200 : 400
  );
}
