/**
 * Email suppression — the reputation layer's memory. Firestore `email_suppression/{email}`, doc id
 * being the lowercased address.
 *
 * ## Three classes, and why the gate matrix keys on CLASS not reason
 *
 *  - **deliverability** — dead addresses. Blocks EVERY profile, including transactional.
 *  - **consent** — unsubscribed or opted out. Blocks outreach and reply, but NOT transactional —
 *    that is the CAN-SPAM carve-out for a transactional message they are entitled to receive.
 *  - **complaint** — spam reports. Blocks outreach and reply, and NEVER auto-lifts.
 *
 * Reasons are many and grow over time; classes are three and stable. Both the gate matrix and the
 * reactivation policy key on class, so adding a new provider reason is a one-line map entry rather
 * than a change to every gate. An UNKNOWN reason maps to `deliverability`, the hardest block —
 * fail-safe, so a typo or a new provider event can never accidentally widen sending.
 *
 * ## Entries are never deleted
 *
 * A lift sets `active: false` and writes a reactivation trail, preserving who lifted it and the prior
 * reason. Re-suppressing a probe-once reactivation marks it `probe_once_failed`, so a second
 * contradiction can never auto-lift again — only an explicit ops identity can.
 *
 * ## The unsubscribe token
 *
 * A versioned HMAC (`"1" + HMAC-SHA256(key, "unsub:" + email)[:23]`): deterministic, so it needs no
 * storage and validates with no lookup, and unforgeable without the signing key. The version prefix
 * is what allows the scheme to be rotated later without invalidating live links.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { db } from '../firebase/db';
import { unsubSigningKeyV1 } from '../config';

export const COLLECTION = 'email_suppression';

export const CLASS_DELIVERABILITY = 'deliverability';
export const CLASS_CONSENT = 'consent';
export const CLASS_COMPLAINT = 'complaint';

export type SuppressionClass =
  | typeof CLASS_DELIVERABILITY
  | typeof CLASS_CONSENT
  | typeof CLASS_COMPLAINT;

const REASON_CLASS: Readonly<Record<string, SuppressionClass>> = {
  // deliverability — dead / undeliverable addresses
  'hard-bounce': CLASS_DELIVERABILITY,
  'sg-bounce': CLASS_DELIVERABILITY,
  'sg-block': CLASS_DELIVERABILITY,
  'sg-invalid': CLASS_DELIVERABILITY,
  'sg-dropped': CLASS_DELIVERABILITY,
  'verify-invalid': CLASS_DELIVERABILITY,
  // consent — they asked us to stop
  unsubscribed: CLASS_CONSENT,
  'unsubscribed-group': CLASS_CONSENT,
  'opted-out-by-reply': CLASS_CONSENT,
  'sg-global-unsub': CLASS_CONSENT,
  // complaint — they reported us as spam
  'spam-complaint': CLASS_COMPLAINT,
  'sg-spam-report': CLASS_COMPLAINT,
};

/** An unknown reason blocks hardest — a new provider event must never widen sending. */
export function classForReason(reason: string): SuppressionClass {
  return REASON_CLASS[reason] ?? CLASS_DELIVERABILITY;
}

function norm(email: unknown): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

export interface SuppressionEntry {
  class: SuppressionClass;
  reason: string;
  probe_once_failed: boolean;
}

/**
 * Record a suppression. Idempotent, and entries are never deleted.
 *
 * Re-suppressing an address that had been lifted by the probe-once policy marks it
 * `probe_once_failed`, which permanently disqualifies it from any future auto-lift. Best-effort —
 * returns `false` on a storage error.
 */
export async function suppress(
  emailRaw: string,
  reason: string,
  source?: string | null
): Promise<boolean> {
  const email = norm(emailRaw);
  if (!email || !email.includes('@')) return false;

  const now = new Date().toISOString();
  try {
    const ref = db.collection(COLLECTION).doc(email);
    const doc = await ref.get();
    const existing = doc.exists ? (doc.data() ?? null) : null;

    if (existing) {
      const updates: Record<string, unknown> = {
        active: true,
        re_suppressed_at: now,
      };
      // A failed probe-once lift is permanent-pending-ops: no future auto-lift, ever.
      if (existing.reactivated_by === 'inbound-email-probe-once') {
        updates.probe_once_failed = true;
      }
      const sources = (existing.sources ?? []) as string[];
      if (source && !sources.includes(source)) {
        updates.sources = [...sources, source];
      }
      await ref.update(updates);
    } else {
      await ref.set({
        class: classForReason(reason),
        reason,
        added_at: now,
        active: true,
        sources: source ? [source] : [],
      });
    }
    console.log(
      `[SUPPRESS] ${email} reason=${reason} class=${classForReason(reason)} source=${source}`
    );
    return true;
  } catch (e) {
    console.error(`[SUPPRESS] write failed for ${email}: ${e}`);
    return false;
  }
}

/**
 * The active suppression entry for an address, or `null`.
 *
 * FAILS CLOSED on a storage error: rather than report a clean address it returns a synthetic
 * `deliverability` entry with reason `suppression-store-error`, so the send gate blocks instead of
 * mailing an address whose state is unknown. A clean read of a clean address returns `null`, and so
 * does a reactivated entry (`active: false`) — a lift on record reads as clear.
 */
export async function isSuppressed(
  emailRaw: string
): Promise<SuppressionEntry | null> {
  const email = norm(emailRaw);
  if (!email) return null;
  try {
    const doc = await db.collection(COLLECTION).doc(email).get();
    if (!doc.exists) return null;
    const d = doc.data() ?? {};
    if (d.active === false) return null; // reactivated — treated as clear
    return {
      class:
        (d.class as SuppressionClass) || classForReason(String(d.reason ?? '')),
      reason: String(d.reason ?? 'unknown'),
      probe_once_failed: Boolean(d.probe_once_failed),
    };
  } catch (e) {
    console.error(`[SUPPRESS] read failed for ${email} — failing CLOSED: ${e}`);
    return {
      class: CLASS_DELIVERABILITY,
      reason: 'suppression-store-error',
      probe_once_failed: false,
    };
  }
}

/**
 * Lift a suppression — the reactivation policy, or an audited ops path.
 *
 * The entry is never deleted: `active` flips to `false` and the trail (who, when, the prior reason)
 * is preserved. Refuses complaint-class entries and already-failed probe-once entries unless the
 * caller is an explicit ops identity (`reactivatedBy === 'ops'`). Someone who reported us as spam is
 * never re-mailed by an automated policy.
 *
 * Returns `true` when there is nothing to lift, because that is the desired end state.
 */
export async function reactivate(
  emailRaw: string,
  reactivatedBy: string,
  actor?: string | null
): Promise<boolean> {
  const email = norm(emailRaw);
  if (!email) return false;
  try {
    const ref = db.collection(COLLECTION).doc(email);
    const doc = await ref.get();
    if (!doc.exists) return true; // nothing to lift
    const d = doc.data() ?? {};
    const klass =
      (d.class as SuppressionClass) || classForReason(String(d.reason ?? ''));

    if (reactivatedBy !== 'ops') {
      if (klass === CLASS_COMPLAINT) {
        console.warn(
          `[SUPPRESS] auto-lift refused (complaint class): ${email}`
        );
        return false;
      }
      if (d.probe_once_failed) {
        console.warn(
          `[SUPPRESS] auto-lift refused (probe-once already failed): ${email}`
        );
        return false;
      }
    }

    await ref.update({
      active: false,
      reactivated_at: new Date().toISOString(),
      reactivated_by: reactivatedBy,
      reactivated_actor: actor ?? '',
      prior_reason: d.reason ?? null,
    });
    console.log(
      `[SUPPRESS] reactivated ${email} by=${reactivatedBy} actor=${actor}`
    );
    return true;
  } catch (e) {
    console.error(`[SUPPRESS] reactivate failed for ${email}: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SendGrid live suppression mirror
// ─────────────────────────────────────────────────────────────────────────────

const SG_ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  ['bounces', 'sg-bounce'],
  ['blocks', 'sg-block'],
  ['spam_reports', 'sg-spam-report'],
  ['invalid_emails', 'sg-invalid'],
  ['asm/suppressions/global', 'sg-global-unsub'],
];

/**
 * Ask SendGrid's own suppression lists about an address. Any hit is mirrored into the local store —
 * so each address is asked at most once — and returned as the `sg-*` reason. A 404 or an empty body
 * means clean on that list.
 *
 * API errors fail OPEN (`null`): the local store and the send-time gates still protect, so a SendGrid
 * outage must not halt all sending.
 */
export async function checkSendgrid(
  emailRaw: string,
  apiKey: string
): Promise<string | null> {
  const email = norm(emailRaw);
  if (!email || !apiKey) return null;

  for (const [path, reason] of SG_ENDPOINTS) {
    const url = path.startsWith('asm')
      ? `https://api.sendgrid.com/v3/${path}/${email}`
      : `https://api.sendgrid.com/v3/suppression/${path}/${email}`;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 404) continue; // clean on this list
      if (!resp.ok) {
        console.warn(
          `[SUPPRESS] SendGrid check ${path} error ${resp.status} — failing OPEN`
        );
        return null;
      }
      const body = await resp.text();
      const data: unknown = body ? JSON.parse(body) : null;
      // List endpoints return `[]` or `[{...hit}]`; the global ASM endpoint returns an object
      // carrying the address only when the address is actually suppressed.
      const hit =
        (Array.isArray(data) && data.length > 0) ||
        (!Array.isArray(data) &&
          typeof data === 'object' &&
          data !== null &&
          Boolean(
            (data as Record<string, unknown>).recipient_email ??
            (data as Record<string, unknown>).recipient_emails
          ));
      if (hit) {
        await suppress(email, reason, 'sendgrid-live-check');
        return reason;
      }
    } catch (e) {
      console.warn(
        `[SUPPRESS] SendGrid check ${path} failed (${e}) — failing OPEN`
      );
      return null;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Versioned, deterministic, unforgeable-without-key token: `"1"` + the first 23 hex chars of
 * HMAC-SHA256 over `"unsub:" + email`.
 *
 * Deterministic means an unsubscribe link needs no stored state and validates with no lookup. `''`
 * when no signing key is configured, which disables unsubscribe links rather than emitting a
 * forgeable token.
 */
export function unsubToken(email: string): string {
  const key = unsubSigningKeyV1();
  if (!key) {
    console.warn(
      '[UNSUB] UNSUB_SIGNING_KEY_V1 not set — tokens are empty (unsub links disabled)'
    );
    return '';
  }
  const mac = createHmac('sha256', key)
    .update(`unsub:${norm(email)}`)
    .digest('hex');
  return '1' + mac.slice(0, 23);
}

/**
 * Constant-time validation, dispatched on the leading version character.
 *
 * The comparison is timing-safe so a token cannot be recovered byte by byte from response timing.
 * Lengths are checked first because `timingSafeEqual` throws on a length mismatch.
 */
export function verifyUnsubToken(email: string, tokenRaw: string): boolean {
  const token = String(tokenRaw ?? '').trim();
  if (!token || token[0] !== '1') return false;
  const expected = unsubToken(email);
  if (!expected || expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
