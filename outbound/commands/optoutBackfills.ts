/**
 * The opt-out and email-state backfills — the port of four `management/commands/backfill_*`.
 *
 * These migrate data written before a gate existed. Every one of them is idempotent and **set-only**: it
 * seeds or raises a flag and never clears one, because clearing a real opt-out is the one mistake a
 * consent backfill must not be able to make. Re-running is always safe, which is what lets these be run
 * against production without a maintenance window.
 *
 * ## The Django management-command wrapper is NOT ported
 *
 * Each source command is `add_arguments` plus a `handle` that calls its logic. The arguments — defaults,
 * clamps, `--dry-run` — are the substance and they live in these function signatures. What is dropped is
 * `BaseCommand`, argv parsing, and the `manage.py` entry, because Django supplies a runner and this repo
 * has none; inventing one (and taking a `tsx` dependency for it) is outside a port. Every function here is
 * directly callable from a Node script or an admin route.
 *
 * ## `dryRun` reports the same counters a real run would
 *
 * Not a partial simulation — the read path is identical and only the write is skipped, so the numbers a
 * dry run prints are the numbers the real run will produce. A dry run that undercounted would be worse
 * than none, because it would be trusted.
 */

import { db } from '../firebase/db';
import {
  CHAT_EVENT_DISPOSITION,
  flagChatsForEmailEvent,
} from '../services/emailCompliance';
import {
  CLASS_COMPLAINT,
  CLASS_CONSENT,
  COLLECTION as SUPPRESSION_COLLECTION,
  classForReason,
  suppress,
} from '../services/suppression';
import { getOutboundChatByEmail, getWebChatByEmail } from '../services/chat';

export interface BackfillOptions {
  dryRun?: boolean;
}

/** `true` or the string `"Y"` — the two shapes a memory opt-out flag is written in. */
function memTruthy(v: unknown): boolean {
  return (
    v === true ||
    String(v ?? '')
      .trim()
      .toUpperCase() === 'Y'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// backfill_optout_flags
// ─────────────────────────────────────────────────────────────────────────────

export interface OptoutFlagsResult {
  scanned: number;
  changed: number;
  dry_run: boolean;
}

/**
 * Copy per-chat opt-out signals from `memory` up to the TRUSTWORTHY chat-doc top-level keys the gates
 * read: `email_opt_out`, `phone_opt_out`, `sms_opt_out`.
 *
 * New chats get these at creation; this migrates the ones that predate that. Two rules, and the second is
 * the important one:
 *
 *  - A **missing** key is seeded, `false` or `true` as the memory says.
 *  - A top-level `true` is **never flipped back to false**. The memory flags are the older, less
 *    trustworthy record — if the chat doc says the customer opted out and memory disagrees, the chat doc
 *    wins. Any other rule would let a stale memory field silently re-open a closed channel.
 *
 * `phone_opt_out` reads two memory fields, because `block_phone` is the older spelling and both are live
 * on real data.
 */
export async function backfillOptoutFlags(
  options: BackfillOptions = {}
): Promise<OptoutFlagsResult> {
  const { dryRun = false } = options;
  let scanned = 0;
  let changed = 0;

  const snap = await db
    .collection('chats')
    .where('type', '==', 'outbound')
    .get();

  for (const doc of snap.docs) {
    scanned += 1;
    const d = (doc.data() ?? {}) as Record<string, unknown>;
    const mem = (d.memory ?? {}) as Record<string, unknown>;

    const desired: Record<string, boolean> = {
      email_opt_out: memTruthy(mem._email_opt_out),
      phone_opt_out: memTruthy(mem.phone_opt_out) || memTruthy(mem.block_phone),
      sms_opt_out: memTruthy(mem.sms_opt_out),
    };

    const updates: Record<string, boolean> = {};
    for (const [key, want] of Object.entries(desired)) {
      if (!(key in d)) {
        updates[key] = want;
      } else if (want && d[key] !== true) {
        // Raise only. See the module note on why this never goes the other way.
        updates[key] = true;
      }
    }
    if (Object.keys(updates).length === 0) continue;

    changed += 1;
    if (dryRun) {
      console.log(`[dry] ${doc.id} <- ${JSON.stringify(updates)}`);
      continue;
    }
    try {
      await db.collection('chats').doc(doc.id).update(updates);
    } catch (e) {
      console.error(`${doc.id}: update failed (${e})`);
    }
  }

  return { scanned, changed, dry_run: dryRun };
}

// ─────────────────────────────────────────────────────────────────────────────
// backfill_last_inbound_email_at
// ─────────────────────────────────────────────────────────────────────────────

export interface LastInboundEmailResult {
  stamped: number;
  dry_run: boolean;
}

/**
 * Stamp `memory._last_inbound_email_at` from each chat's latest INBOUND email.
 *
 * The send gate treats a missing timestamp as stale, so without this every live thread loses its
 * reply-class privileges the moment the gate ships — a deploy would silently stop the follow-ups on
 * exactly the conversations that were going well.
 *
 * Scoped by ORDERING on the threading anchor rather than filtering on it: Firestore's `order_by` excludes
 * documents missing the field, which is precisely the set we want, and it needs no composite index. A chat
 * carrying the anchor has received email; one already carrying the stamp is skipped.
 */
export async function backfillLastInboundEmailAt(
  options: BackfillOptions = {}
): Promise<LastInboundEmailResult> {
  const { dryRun = false } = options;
  let stamped = 0;

  const snap = await db
    .collection('chats')
    .orderBy('memory._last_inbound_email_message_id')
    .get();

  for (const doc of snap.docs) {
    const d = (doc.data() ?? {}) as Record<string, unknown>;
    const mem = (d.memory ?? {}) as Record<string, unknown>;
    if (!mem._last_inbound_email_message_id || mem._last_inbound_email_at) {
      continue;
    }

    const latest = await db
      .collection('chats')
      .doc(doc.id)
      .collection('messages_v3')
      .where('source', '==', 'email')
      .where('direction', '==', 'inbound')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    if (latest.docs.length === 0) continue;

    const ts = ((latest.docs[0].data() ?? {}) as Record<string, unknown>)
      .timestamp;
    if (!ts) continue;
    const iso = ts instanceof Date ? ts.toISOString() : String(ts);

    stamped += 1;
    if (dryRun) {
      console.log(`[dry] chat ${doc.id}: _last_inbound_email_at = ${iso}`);
      continue;
    }
    await db
      .collection('chats')
      .doc(doc.id)
      .update({ 'memory._last_inbound_email_at': iso });
  }

  return { stamped, dry_run: dryRun };
}

// ─────────────────────────────────────────────────────────────────────────────
// backfill_email_suppression
// ─────────────────────────────────────────────────────────────────────────────

/** SendGrid's own suppression lists, and the reason each one records. */
const SG_LISTS: Array<[string, string]> = [
  ['suppression/bounces', 'sg-bounce'],
  ['suppression/blocks', 'sg-block'],
  ['suppression/spam_reports', 'sg-spam-report'],
  ['suppression/invalid_emails', 'sg-invalid'],
  ['asm/suppressions/global', 'sg-global-unsub'],
];

const SG_PAGE = 500;

export interface EmailSuppressionOptions extends BackfillOptions {
  /** Omit to skip the SendGrid half and seed only from Firestore. */
  sendgridApiKey?: string;
}

export interface EmailSuppressionResult {
  total: number;
  dry_run: boolean;
}

/**
 * Seed the suppression store from every pre-existing signal: SendGrid's lists, chats flagged
 * `memory._email_opt_out`, and Lost-by-opt-out chats carrying an address.
 *
 * Idempotent because the doc id is the lowercased address and `suppress` merges — the first reason wins
 * and later sources append to `sources[]`. So the three passes can overlap freely, which they will: a
 * customer who replied "stop" is usually also on SendGrid's global unsubscribe list.
 *
 * A failing SendGrid list is SKIPPED, not fatal. The Firestore passes are the ones we can always
 * complete, and losing the vendor's view of history should not cost us our own.
 */
export async function backfillEmailSuppression(
  options: EmailSuppressionOptions = {}
): Promise<EmailSuppressionResult> {
  const { dryRun = false, sendgridApiKey = '' } = options;
  let total = 0;

  const apiKey = sendgridApiKey.trim();
  if (apiKey) {
    for (const [path, reason] of SG_LISTS) {
      let offset = 0;
      for (;;) {
        const url = `https://api.sendgrid.com/v3/${path}?limit=${SG_PAGE}&offset=${offset}`;
        let rows: Array<Record<string, unknown>>;
        try {
          const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(30_000),
          });
          rows = ((await resp.json()) ?? []) as Array<Record<string, unknown>>;
        } catch (e) {
          console.error(`${path}: fetch failed (${e}) — skipping list`);
          break;
        }
        if (!Array.isArray(rows) || rows.length === 0) break;

        for (const row of rows) {
          const email = String(row.email ?? row.recipient_email ?? '')
            .trim()
            .toLowerCase();
          if (!email) continue;
          total += 1;
          if (dryRun) {
            console.log(`[dry] ${email} <- ${reason}`);
          } else {
            await suppress(email, reason, `backfill:${path}`);
          }
        }
        if (rows.length < SG_PAGE) break;
        offset += SG_PAGE;
      }
      console.log(`${path}: done`);
    }
  } else {
    console.log('no sendgridApiKey — skipping SendGrid lists');
  }

  // Chats whose memory records a reply-based opt-out.
  const optedOut = await db
    .collection('chats')
    .where('memory._email_opt_out', '==', true)
    .get();
  for (const doc of optedOut.docs) {
    const mem = (((doc.data() ?? {}) as Record<string, unknown>).memory ??
      {}) as Record<string, unknown>;
    const email = String(mem.customer_email ?? mem.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) continue;
    total += 1;
    if (dryRun) {
      console.log(`[dry] ${email} <- opted-out-by-reply (chat ${doc.id})`);
    } else {
      await suppress(email, 'opted-out-by-reply', `backfill:chat:${doc.id}`);
    }
  }

  // Lost-by-opt-out chats. The reason is read from the chat doc first, then memory, because both
  // spellings exist on real data.
  const lost = await db.collection('chats').where('stage', '==', 'Lost').get();
  for (const doc of lost.docs) {
    const d = (doc.data() ?? {}) as Record<string, unknown>;
    const mem = (d.memory ?? {}) as Record<string, unknown>;
    if ((d.lost_reason ?? mem.lost_reason) !== 'customer_opted_out') continue;
    const email = String(mem.customer_email ?? mem.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) continue;
    total += 1;
    if (dryRun) {
      console.log(`[dry] ${email} <- unsubscribed (Lost chat ${doc.id})`);
    } else {
      await suppress(email, 'unsubscribed', `backfill:lost:${doc.id}`);
    }
  }

  return { total, dry_run: dryRun };
}

// ─────────────────────────────────────────────────────────────────────────────
// backfill_email_optout_chat_flags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A suppression class → the chat-flag disposition.
 *
 * Consent and complaint mean the customer said stop, so the email channel closes. **Everything else —
 * deliverability AND unknown — maps to `invalid`**, deliberately: an unrecognised reason is the case
 * `classForReason` blocks hardest, and treating it as a delivery failure is the conservative reading.
 */
export function dispositionForClass(klass: string) {
  if (klass === CLASS_CONSENT) return CHAT_EVENT_DISPOSITION.unsubscribe;
  if (klass === CLASS_COMPLAINT) return CHAT_EVENT_DISPOSITION.spamreport;
  return CHAT_EVENT_DISPOSITION.bounce;
}

export interface OptoutChatFlagsResult {
  scanned: number;
  chats_flagged: number;
  dry_run: boolean;
}

/**
 * Backfill the CHAT-LEVEL email flags from the global suppression store.
 *
 * Closes a gap the event webhook now handles going forward. Before it, an unsubscribe or hard bounce
 * arriving via the SendGrid event route wrote only the GLOBAL store — never the trustworthy chat-doc flag,
 * and never the `@ai` note that explains to whoever reads the thread why mail stopped.
 * `backfillOptoutFlags` cannot catch these: it copies memory → chat doc, and memory was never set on that
 * route. So this reconciles from the store instead.
 *
 * Idempotent through `only_if_missing`, which skips a chat whose target flag is already set — so a re-run
 * posts no duplicate notes. An `active: false` entry (a lift on record) is treated as cleared and skipped.
 */
export async function backfillEmailOptoutChatFlags(
  options: BackfillOptions = {}
): Promise<OptoutChatFlagsResult> {
  const { dryRun = false } = options;
  let scanned = 0;
  let flagged = 0;

  const snap = await db.collection(SUPPRESSION_COLLECTION).get();
  for (const doc of snap.docs) {
    scanned += 1;
    const d = (doc.data() ?? {}) as Record<string, unknown>;
    if (d.active === false) continue;

    const email = (doc.id ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;

    const klass = String(d.class ?? classForReason(String(d.reason ?? '')));
    const disposition = dispositionForClass(klass);

    if (dryRun) {
      // Resolve the chat here so the dry run reports whether anything would ACTUALLY change, rather than
      // counting every suppression entry as a pending write.
      let chatId: string | null = null;
      try {
        chatId =
          (await getOutboundChatByEmail(email)) ??
          (await getWebChatByEmail(email));
      } catch {
        chatId = null;
      }
      if (chatId) {
        const flag = disposition.opt_out ? 'email_opt_out' : 'email_invalid';
        console.log(`[dry] ${email} (${klass}) -> chat ${chatId}.${flag}=True`);
        flagged += 1;
      }
      continue;
    }

    const outbound = await flagChatsForEmailEvent(email, {
      ...disposition,
      only_if_missing: true,
    });
    if (outbound) flagged += 1;
  }

  return { scanned, chats_flagged: flagged, dry_run: dryRun };
}
