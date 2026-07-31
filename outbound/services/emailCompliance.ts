/**
 * Email compliance: the SendGrid event webhook and the unsubscribe endpoint.
 *
 * These are the handlers; the HTTP routes arrive with Phase 10. Between them they are how an
 * unsubscribe, a spam complaint, or a hard bounce actually takes effect — so the failure modes here are
 * regulatory, not cosmetic.
 *
 * ## GET must never unsubscribe anyone
 *
 * The unsubscribe link is followed by corporate mail scanners — SafeLinks, Proofpoint, Mimecast — which
 * fetch every URL in a message. A GET that suppressed would let one scan mass-unsubscribe an entire
 * domain. So GET renders a confirmation page and nothing else; only POST suppresses, covering both the
 * page's button and RFC 8058 one-click (empty body, no login).
 *
 * ## An unverified event webhook is REJECTED, and that is the opposite of the port's usual default
 *
 * Most gates in this codebase fail open, because a fault must not stop outreach. This one fails CLOSED:
 * a forged event could suppress an arbitrary address and silence a real prospect permanently. No public
 * key configured means reject, unless `SENDGRID_WEBHOOK_ALLOW_UNSIGNED=true` says otherwise for dev.
 *
 * ## Every one of these events closes the EMAIL channel only
 *
 * A bounce, an unsubscribe, or a spam report never marks the prospect Lost and never touches the phone
 * cadence. A bad address or a withdrawn email consent says nothing about whether the person can be
 * called — treating it as terminal would discard workable leads at scale. `call_followup` tasks are
 * deliberately left alone when email touches are cancelled.
 *
 * ## Suppression is global; the chat flag is what makes it visible and explicable
 *
 * `suppress()` stops future sends. The chat-level work — the trustworthy top-level `email_opt_out` /
 * `email_invalid` keys, the memory mirror, the label, the activity row, and the visible `@ai` note —
 * exists so the event is EXPLAINED in the thread and gated deterministically, rather than mail silently
 * stopping with no reason anywhere a human can see.
 *
 * `dropped` is deliberately suppress-only: a drop is usually a downstream effect of an already-
 * suppressed address, so flagging the chat off it would be a false signal.
 *
 * ## Not ported
 *
 * The web-chat half of `cancelPendingEmailTouches`. `cancel_nudge_task` belongs to
 * `inbound_email_nudge`, an inbound web-widget service that refuses outbound chats outright — see the
 * Phase 6b² revision in PORT-PLAN.md. Outbound chats are handled in full.
 */

import { createVerify } from 'node:crypto';

import { FieldValue, db } from '../firebase/db';
import type { QueryDocumentSnapshot } from '../firebase/db';
import {
  addLabelToChat,
  deleteUnexecutedTasksByType,
  getMemory,
  setMemory,
} from '../firebase/chat';
import {
  getOutboundChatByEmail,
  getWebChatByEmail,
  logEmailActivity,
  logInternalNote,
} from './chat';
import { suppress, verifyUnsubToken } from './suppression';
import { SEND_LOG } from './reputation';
import { envStr } from '../config';

/** SendGrid event type → the suppression class it records. */
const SUPPRESS_BY_EVENT: Record<string, string> = {
  bounce: 'hard-bounce',
  dropped: 'sg-dropped',
  spamreport: 'spam-complaint',
  unsubscribe: 'unsubscribed',
  group_unsubscribe: 'unsubscribed-group',
};

/** Events that also rewrite the send-log row's status. */
const SEND_LOG_STATUS: Record<string, string> = {
  bounce: 'bounced',
  spamreport: 'complained',
};

/** How a suppressible event lands on the chat. See the module note on why `dropped` is absent. */
interface ChatDisposition {
  opt_out?: boolean;
  invalid?: boolean;
  activity_event: string;
  note_suffix: string;
}

const CHAT_EVENT_DISPOSITION: Record<string, ChatDisposition> = {
  unsubscribe: {
    opt_out: true,
    activity_event: 'unsubscribe',
    note_suffix: 'unsubscribed from emails — email channel opted out.',
  },
  group_unsubscribe: {
    opt_out: true,
    activity_event: 'unsubscribe',
    note_suffix: 'unsubscribed from emails — email channel opted out.',
  },
  spamreport: {
    opt_out: true,
    activity_event: 'spam',
    note_suffix: 'marked our email as spam — email channel opted out.',
  },
  bounce: {
    invalid: true,
    activity_event: 'bounce',
    note_suffix:
      'had a hard email bounce — address marked invalid (email channel closed).',
  },
};

export interface SignedEventRequest {
  /** `X-Twilio-Email-Event-Webhook-Signature`. */
  signature?: string | null;
  /** `X-Twilio-Email-Event-Webhook-Timestamp`. */
  timestamp?: string | null;
  /** The EXACT raw body bytes. Re-serializing the parsed JSON would break the signature. */
  rawBody: string;
}

/**
 * Verify the SendGrid event webhook's ECDSA (P-256 / SHA-256) signature over `timestamp + rawBody`.
 *
 * Fails CLOSED — see the module note. The dev escape hatch is explicit and logged.
 */
export function verifyEventSignature(request: SignedEventRequest): boolean {
  const pubB64 = envStr('SENDGRID_WEBHOOK_PUBLIC_KEY').trim();
  if (!pubB64) {
    const allow =
      envStr('SENDGRID_WEBHOOK_ALLOW_UNSIGNED', 'false').toLowerCase() ===
      'true';
    if (!allow) {
      console.error(
        '[SG_EVENTS] SENDGRID_WEBHOOK_PUBLIC_KEY not set and unsigned not allowed'
      );
    }
    return allow;
  }

  const signature = request.signature ?? '';
  const timestamp = request.timestamp ?? '';
  if (!signature || !timestamp) return false;

  try {
    const der = Buffer.from(pubB64, 'base64');
    const verifier = createVerify('SHA256');
    verifier.update(
      Buffer.concat([Buffer.from(timestamp), Buffer.from(request.rawBody)])
    );
    return verifier.verify(
      { key: der, format: 'der', type: 'spki' },
      Buffer.from(signature, 'base64')
    );
  } catch (e) {
    console.warn(`[SG_EVENTS] signature verification failed: ${e}`);
    return false;
  }
}

/**
 * Cancel every scheduled EMAIL touch for this address.
 *
 * `call_followup` is deliberately left standing: calls are a different channel, and an email problem
 * is not a reason to stop dialing. Best-effort; returns the outbound chat id when there is one.
 */
export async function cancelPendingEmailTouches(
  email: string
): Promise<string | null> {
  try {
    const obChat = await getOutboundChatByEmail(email, null);
    if (obChat) {
      const n = await deleteUnexecutedTasksByType(
        obChat,
        'followup_if_no_reply'
      );
      if (n) {
        console.log(
          `[SG_EVENTS] cancelled ${n} email nudge(s) on outbound chat ${obChat}`
        );
      }
    }
    // The web-chat nudge task is not ported — see the module note.
    return obChat ?? null;
  } catch (e) {
    console.warn(`[SG_EVENTS] nudge cancellation failed for ${email}: ${e}`);
    return null;
  }
}

export interface FlagOptions extends Partial<ChatDisposition> {
  /** Backfill mode: skip a chat entirely when the target flags are already set, so re-runs post no duplicate notes. */
  only_if_missing?: boolean;
}

/**
 * Record an email-channel event on the contact's chat(s).
 *
 * The counterpart to global suppression: the trustworthy top-level flags the deterministic gates read,
 * plus the label, activity row, and visible `@ai` note that explain WHY mail stopped. Email channel
 * only — never marks the prospect Lost and never touches the phone cadence.
 *
 * Best-effort throughout: each write is independently guarded, because a failed label must not cost the
 * consent flag. Returns the outbound chat id.
 */
export async function flagChatsForEmailEvent(
  email: string,
  options: FlagOptions = {}
): Promise<string | null> {
  const {
    opt_out: optOut = false,
    invalid = false,
    activity_event: activityEvent = 'unsubscribe',
    note_suffix: noteSuffix = '',
    only_if_missing: onlyIfMissing = false,
  } = options;

  let obChat: string | null = null;
  try {
    obChat = (await getOutboundChatByEmail(email, null)) ?? null;
  } catch (e) {
    console.warn(`[SG_EVENTS] outbound chat lookup failed for ${email}: ${e}`);
  }
  let webChat: string | null = null;
  try {
    webChat = (await getWebChatByEmail(email, null)) ?? null;
  } catch {
    webChat = null;
  }

  for (const cid of [obChat, webChat]) {
    if (!cid) continue;

    if (onlyIfMissing) {
      let cur: Record<string, unknown> = {};
      try {
        const snap = await db.collection('chats').doc(cid).get();
        cur = snap.exists ? (snap.data() ?? {}) : {};
      } catch {
        cur = {};
      }
      const targetSet =
        (!optOut || cur.email_opt_out === true) &&
        (!invalid || cur.email_invalid === true);
      if (targetSet) continue; // already flagged — idempotent, no duplicate note
    }

    const docUpdates: Record<string, unknown> = {};
    const memUpdates: Record<string, unknown> = {};
    if (optOut) {
      docUpdates.email_opt_out = true;
      memUpdates._email_opt_out = true;
    }
    if (invalid) {
      docUpdates.email_invalid = true;
      memUpdates._email_invalid = true;
    }

    try {
      // The trustworthy chat-doc TOP-LEVEL keys the deterministic gates read.
      if (Object.keys(docUpdates).length > 0) {
        await db.collection('chats').doc(cid).update(docUpdates);
      }
    } catch (e) {
      console.warn(`[SG_EVENTS] chat-doc flag update failed for ${cid}: ${e}`);
    }
    try {
      if (Object.keys(memUpdates).length > 0) await setMemory(cid, memUpdates);
    } catch {
      // The top-level flag is what gates; the memory mirror is for older readers.
    }
    if (optOut) {
      try {
        // Visible chat label, so the opt-out shows in the UI list. Email channel only.
        await addLabelToChat(cid, 'email_opted_out');
      } catch {
        // Cosmetic.
      }
    }
    try {
      await logEmailActivity(cid, activityEvent, email, null);
    } catch {
      // Audit only.
    }
    try {
      // The visible campaign-inbox note, so a human can see why mail stopped.
      const name =
        String((await getMemory(cid))?.first_name ?? '').trim() || email;
      await logInternalNote(cid, `${name} ${noteSuffix}`);
    } catch (e) {
      console.warn(`[SG_EVENTS] internal note failed for ${cid}: ${e}`);
    }
  }

  return obChat;
}

/**
 * Correlate an event to its send-log row and rewrite the status.
 *
 * Three tiers, cheapest first: the `log_id` custom arg that rides flattened on the event, then the
 * provider message id, then the latest row for that recipient. Best-effort — a lost status update is an
 * analytics gap, not a compliance one.
 */
export async function updateSendLog(
  event: Record<string, unknown>,
  newStatus: string
): Promise<void> {
  try {
    const logId = event.log_id;
    if (logId) {
      await db
        .collection(SEND_LOG)
        .doc(String(logId))
        .set({ status: newStatus }, { merge: true });
      return;
    }
    const sgId = String(event.sg_message_id ?? '').split('.')[0];
    const email = String(event.email ?? '').toLowerCase();

    let docs: QueryDocumentSnapshot[] = [];
    if (sgId) {
      const snap = await db
        .collection(SEND_LOG)
        .where('sg_message_id', '==', sgId)
        .limit(1)
        .get();
      docs = snap.docs;
    }
    if (docs.length === 0 && email) {
      const snap = await db
        .collection(SEND_LOG)
        .where('recipient', '==', email)
        .orderBy('sent_at', 'desc')
        .limit(1)
        .get();
      docs = snap.docs;
    }
    for (const d of docs) {
      await d.ref.set({ status: newStatus }, { merge: true });
    }
  } catch (e) {
    console.warn(`[SG_EVENTS] send_log update failed: ${e}`);
  }
}

export interface EventWebhookResult {
  success: boolean;
  status: number;
  processed?: number;
  error?: string;
}

/**
 * Handle a batch of SendGrid events.
 *
 * Unrecognised event types and events with no address are skipped without counting — SendGrid posts
 * opens, clicks, and deliveries through the same endpoint and none of them are compliance events.
 */
export async function handleSendgridEventWebhook(
  events: unknown,
  request: SignedEventRequest
): Promise<EventWebhookResult> {
  if (!verifyEventSignature(request)) {
    return { success: false, status: 401, error: 'invalid signature' };
  }

  let list: unknown[];
  if (Array.isArray(events)) {
    list = events;
  } else {
    try {
      list = JSON.parse(request.rawBody || '[]');
      if (!Array.isArray(list)) throw new Error('not a list');
    } catch {
      return { success: false, status: 400, error: 'bad payload' };
    }
  }

  let processed = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    const etype = String(event.event ?? '').toLowerCase();
    const email = String(event.email ?? '')
      .trim()
      .toLowerCase();
    if (!SUPPRESS_BY_EVENT[etype] || !email) continue;

    processed += 1;
    await suppress(email, SUPPRESS_BY_EVENT[etype], `sg-event:${etype}`);
    if (SEND_LOG_STATUS[etype]) {
      await updateSendLog(event, SEND_LOG_STATUS[etype]);
    }
    await cancelPendingEmailTouches(email);

    // Flag the chat so the event is explained in the thread and gated deterministically, not just
    // globally suppressed. Email channel only — never marks the prospect Lost.
    const disposition = CHAT_EVENT_DISPOSITION[etype];
    if (disposition) {
      await flagChatsForEmailEvent(email, disposition);
    }
    console.log(`[SG_EVENTS] ${etype} processed for ${email}`);
  }

  return { success: true, status: 200, processed };
}

const CONFIRM_PAGE = `<!doctype html><html><head><title>Unsubscribe</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center">
<h2>Unsubscribe</h2>
<p>Click below to stop receiving emails from us at <b>{email}</b>.</p>
<form method="POST"><button type="submit"
style="padding:10px 28px;font-size:16px;cursor:pointer">Unsubscribe</button></form>
</body></html>`;

export interface UnsubResult {
  status: number;
  body: string;
  contentType: string;
}

/**
 * GET the unsubscribe link: render a confirmation page, and suppress NOTHING.
 *
 * Mail scanners follow every link in a message, so a GET that suppressed would let one corporate
 * link-scan unsubscribe an entire domain. An invalid token is a 400 with no side effect, logged for
 * tamper monitoring.
 */
export function handleUnsubscribeGet(
  email: string,
  token: string
): UnsubResult {
  const addr = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!addr || !verifyUnsubToken(addr, String(token ?? '').trim())) {
    console.warn(`[UNSUB] invalid GET token for '${addr}'`);
    return {
      status: 400,
      body: 'Invalid unsubscribe link.',
      contentType: 'text/plain',
    };
  }
  return {
    status: 200,
    body: CONFIRM_PAGE.replace('{email}', addr),
    contentType: 'text/html',
  };
}

/**
 * POST the unsubscribe: the real thing.
 *
 * Covers both the confirmation page's button and RFC 8058 one-click, which sends an empty body with no
 * login. Suppresses, cancels pending email touches, and flags the chat exactly as the event route does.
 */
export async function handleUnsubscribePost(
  email: string,
  token: string
): Promise<UnsubResult> {
  const addr = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!addr || !verifyUnsubToken(addr, String(token ?? '').trim())) {
    console.warn(`[UNSUB] invalid POST token for '${addr}' — possible tamper`);
    return {
      status: 400,
      body: 'Invalid unsubscribe link.',
      contentType: 'text/plain',
    };
  }
  await suppress(addr, 'unsubscribed', 'unsub-endpoint');
  await cancelPendingEmailTouches(addr);
  await flagChatsForEmailEvent(addr, CHAT_EVENT_DISPOSITION.unsubscribe);
  console.log(`[UNSUB] suppressed ${addr}`);
  return {
    status: 200,
    body: "You have been unsubscribed. You won't receive further emails from us.",
    contentType: 'text/plain',
  };
}

/** Exposed for tests and the Phase 10 backfill, which reuses the flagging with `only_if_missing`. */
export const __testing = {
  SUPPRESS_BY_EVENT,
  SEND_LOG_STATUS,
  CHAT_EVENT_DISPOSITION,
  FieldValue,
};
