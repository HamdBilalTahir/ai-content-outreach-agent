/**
 * FTC DNC area-code registry.
 *
 * ## Why this exists at all
 *
 * The DNC scrub provider only returns valid FEDERAL-DNC results for the area codes our FTC SAN
 * subscription covers. Querying an un-subscribed area code silently comes back **"clean"** — a false
 * negative, not an error. So a number we are not authorized to scrub would look scrubbed-and-safe and
 * get dialled. This registry records exactly which NANP area codes we may scrub, so the enrollment
 * gate can opt the phone out instead of trusting a meaningless clean result.
 *
 * Firestore: `dnc_ftc_area_codes`, one document per area code, document id = the 3-digit code.
 *
 * Active/inactive is **derived from `san_expiry_date`** — there is no stored status field, so a lapsed
 * subscription automatically stops being scrubbable without anyone remembering to flip a flag.
 */

import { BATCH_LIMIT, FieldValue, db } from '../firebase/db';

export const COLLECTION = 'dnc_ftc_area_codes';

/** NANP area code: exactly 3 digits, first digit 2-9 (0 and 1 are invalid leading digits). */
const AREA_CODE_RE = /^[2-9]\d{2}$/;

export function isValidAreaCode(areaCode: unknown): boolean {
  return AREA_CODE_RE.test(String(areaCode ?? '').trim());
}

/** The NANP area code of a phone number — the first 3 digits after an optional `1`. `''` if none. */
export function areaCodeOf(phone: unknown): string {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 10 ? digits.slice(0, 3) : '';
}

/**
 * Accept `YYYY-MM-DD` / `MM/DD/YYYY` / `MM/DD/YY` / a `Date` → `YYYY-MM-DD`. `null` if empty or bad.
 */
export function normalizeExpiry(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s);
  if (m) {
    // Two-digit years follow Python's `%y`: 69-99 → 1900s, 00-68 → 2000s.
    const yy = Number(m[3]);
    const year = yy >= 69 ? 1900 + yy : 2000 + yy;
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }

  return null;
}

/** Compare against today in local time, matching the source's `date.today()`. */
function isExpired(expiryStr: unknown): boolean {
  if (!expiryStr) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiryStr));
  if (!m) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
  return String(expiryStr) < today;
}

/** Firestore timestamps → ISO strings so a document is JSON-serializable for the frontend. */
function jsonify(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] =
      v &&
      typeof v === 'object' &&
      typeof (v as { toDate?: unknown }).toDate === 'function'
        ? (v as { toDate(): Date }).toDate().toISOString()
        : v instanceof Date
          ? v.toISOString()
          : v;
  }
  return out;
}

/**
 * Pure: split a raw list into `[dedupedValid, invalid]`, order-preserving.
 * Invalid codes are *reported*, not silently dropped, so the admin form can show what was rejected.
 */
export function splitValid(
  areaCodes: readonly unknown[] | null | undefined
): [string[], string[]] {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of areaCodes ?? []) {
    const ac = String(raw ?? '').trim();
    if (!isValidAreaCode(ac)) {
      if (ac) invalid.push(ac);
      continue;
    }
    if (seen.has(ac)) continue;
    seen.add(ac);
    valid.push(ac);
  }
  return [valid, invalid];
}

/**
 * Bulk create/update one document per area code under a single SAN.
 *
 * Written in Firestore batches so an all-US upload is a handful of round-trips rather than one write
 * per code. Only the SAN fields actually provided are written (merge keeps the rest), and
 * `created_at` is stamped only on brand-new documents — hence the cheap `listDocuments` scan first.
 */
export async function upsertAreaCodes(
  areaCodes: readonly unknown[],
  sanId?: string | null,
  orgId?: string | null,
  sanExpiryDate?: unknown
): Promise<{ saved: string[]; invalid: string[] }> {
  const [valid, invalid] = splitValid(areaCodes);
  if (!valid.length) return { saved: [], invalid };

  const expiry = normalizeExpiry(sanExpiryDate);

  let existing = new Set<string>();
  try {
    const refs = await db.collection(COLLECTION).listDocuments();
    existing = new Set(refs.map((r) => r.id));
  } catch (e) {
    console.warn(
      `[DNC_AREA_CODES] existing-id scan failed (created_at may reset): ${e}`
    );
  }

  const payload = (ac: string): Record<string, unknown> => {
    const p: Record<string, unknown> = {
      area_code: ac,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (sanId !== null && sanId !== undefined) p.san_id = String(sanId).trim();
    if (orgId !== null && orgId !== undefined) p.org_id = String(orgId).trim();
    if (expiry !== null) p.san_expiry_date = expiry;
    if (!existing.has(ac)) p.created_at = FieldValue.serverTimestamp();
    return p;
  };

  const saved: string[] = [];
  try {
    for (let start = 0; start < valid.length; start += BATCH_LIMIT) {
      const chunk = valid.slice(start, start + BATCH_LIMIT);
      const batch = db.batch();
      for (const ac of chunk) {
        batch.set(db.collection(COLLECTION).doc(ac), payload(ac), {
          merge: true,
        });
      }
      await batch.commit();
      saved.push(...chunk);
    }
  } catch (e) {
    console.warn(
      `[DNC_AREA_CODES] batch upsert failed after ${saved.length} saved: ${e}`
    );
  }
  return { saved, invalid };
}

/** All registry documents (JSON-safe), annotated with `is_expired`/`is_active`, sorted by code. */
export async function listAreaCodes(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    const snap = await db.collection(COLLECTION).get();
    for (const doc of snap.docs) {
      const d = jsonify(doc.data() ?? {});
      d.area_code = d.area_code || doc.id;
      const expired = isExpired(d.san_expiry_date);
      d.is_expired = expired;
      d.is_active = !expired; // derived from expiry — there is no stored status
      out.push(d);
    }
  } catch (e) {
    console.warn(`[DNC_AREA_CODES] list failed: ${e}`);
  }
  out.sort((a, b) =>
    String(a.area_code ?? '').localeCompare(String(b.area_code ?? ''))
  );
  return out;
}

export async function deleteAreaCode(areaCode: unknown): Promise<boolean> {
  const ac = String(areaCode ?? '').trim();
  if (!isValidAreaCode(ac)) return false;
  try {
    await db.collection(COLLECTION).doc(ac).delete();
    return true;
  } catch (e) {
    console.warn(`[DNC_AREA_CODES] delete failed for ${ac}: ${e}`);
    return false;
  }
}

/** The set of area codes we may currently scrub (registered and not past SAN expiry). */
export async function getAllowedAreaCodes(): Promise<Set<string>> {
  const allowed = new Set<string>();
  try {
    const snap = await db.collection(COLLECTION).get();
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      const ac = String(d.area_code ?? doc.id);
      if (isExpired(d.san_expiry_date)) continue;
      allowed.add(ac);
    }
  } catch (e) {
    console.warn(`[DNC_AREA_CODES] getAllowed failed: ${e}`);
  }
  return allowed;
}

/**
 * Is this area code registered and unexpired?
 *
 * **Fails CLOSED** — a read error returns `false`, which opts the phone out. Treating an unknown
 * registry state as "scrubbable" is the exact false-negative this module exists to prevent.
 */
export async function isAreaCodeAllowed(areaCode: unknown): Promise<boolean> {
  const ac = String(areaCode ?? '').trim();
  if (!isValidAreaCode(ac)) return false;
  try {
    const doc = await db.collection(COLLECTION).doc(ac).get();
    if (!doc.exists) return false;
    return !isExpired((doc.data() ?? {}).san_expiry_date);
  } catch (e) {
    console.warn(`[DNC_AREA_CODES] read failed for ${ac}: ${e}`);
    return false;
  }
}

// ─────────────────────────── campaign / enroll filtering ───────────────────────────

/**
 * Resolve a campaign's chosen area-code subset into the set to enforce, or `null` for no filter.
 *
 *  - empty/absent selection → `null`: NO area-code restriction (other gates still apply).
 *  - otherwise → the chosen valid codes ∩ the registered-unexpired registry, dropping invalid,
 *    expired and unregistered codes.
 *
 * MAY resolve to an **empty set**, which is meaningful and different from `null`: no phone-bearing
 * record passes, though email-only contacts still do.
 */
export async function effectiveAllowed(
  selected: readonly unknown[] | null | undefined
): Promise<Set<string> | null> {
  const [valid] = splitValid(selected ?? []);
  if (!valid.length) return null;
  const allowed = await getAllowedAreaCodes();
  return new Set(valid.filter((ac) => allowed.has(ac)));
}

/**
 * Does this phone clear the area-code filter?
 * `allowed === null` → always true (filter off). No/unparseable phone → `keepNoPhone`, so an
 * email-only contact is not dropped by a phone filter.
 */
export function phonePasses(
  phone: unknown,
  allowed: Set<string> | null,
  keepNoPhone = true
): boolean {
  if (allowed === null) return true;
  const ac = areaCodeOf(phone);
  if (!ac) return keepNoPhone;
  return allowed.has(ac);
}

/** Best-effort phone from a lead payload, checking each shape the callers use. */
function leadPhone(lead: Record<string, unknown> | null | undefined): string {
  const d = lead ?? {};
  const contact = (d.contact_information ?? {}) as Record<string, unknown>;
  const input = (d.input_data ?? {}) as Record<string, unknown>;
  return String(
    contact.phone_number ?? input.phone_number ?? d.phone_number ?? ''
  );
}

/** Stamp `lead.area_code` so the frontend can group and de-select by area code. */
export function annotateAreaCode(
  lead: Record<string, unknown>
): Record<string, unknown> {
  if (lead && typeof lead === 'object')
    lead.area_code = areaCodeOf(leadPhone(lead));
  return lead;
}
