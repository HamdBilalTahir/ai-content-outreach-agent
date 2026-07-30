/**
 * Shared deterministic email-text contracts.
 *
 * These constants and matchers are keyed on by FOUR different modules — the send tool, the post-email
 * review, the inbound nudge, and the email webhook — so they live in one place rather than being
 * duplicated or imported across module boundaries that would otherwise cycle. In the source they are
 * scattered across `tools/email.py` and `services/inbound_email_nudge.py`, and the review imports from
 * both; co-locating them makes the shared contract explicit.
 *
 * Everything here is pure: no I/O, no LLM. Several of these matchers gate a compliance-relevant
 * decision, so each records what it must NOT match — the narrowness is the point.
 */

/**
 * The TCPA prior-express-WRITTEN-consent (PEWC) disclosure.
 *
 * Included by the Email Skill ONLY when an outbound email asks a prospect whose phone channel is closed
 * for a callback number, so that their reply constitutes written consent for AI voice and automated SMS.
 *
 * **The wording is flagged in the source as pending counsel approval and is transcribed verbatim. Do not
 * reword it.** `PEWC_DISCLOSURE_MARKER` is a stable, distinctive fragment that CODE keys on
 * deterministically: the send tool counts an "ask" only when the body contains it, and the review
 * confirms written consent (as opposed to mere prior-express consent) by finding it in our own outbound
 * email before enabling an automated call. Changing the marker silently breaks both.
 */
export const PEWC_DISCLOSURE_MARKER = 'automated and AI-generated';

export const PEWC_DISCLOSURE_TEXT =
  "If you'd like Auto Acquire AI to follow up by phone, reply with the best number. By providing it, you " +
  'agree to receive automated and AI-generated calls and text messages from Auto Acquire AI at that number, ' +
  'including for marketing. Consent is not a condition of any purchase. Message and data rates may apply; ' +
  'reply STOP to opt out.';

/** How fresh an unanswered call must be for a "couldn't reach you" email to be allowed out. */
export const NO_ANSWER_MAX_AGE_HOURS = 24;

// ─────────────────────────────────────────────────────────────────────────────
// Quoted-reply stripping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markers that begin the quoted reply history or a signature.
 *
 * Everything from the EARLIEST match onward is not the customer's newly-typed text. This exists for a
 * specific reason: a reply that quotes our own CAN-SPAM footer — which contains the words "opt out" —
 * would otherwise look exactly like an opt-out request. Stripping first is what makes the opt-out
 * matcher safe to run.
 */
const REPLY_CUT_MARKERS: readonly RegExp[] = [
  /^\s*>/m, // quoted lines
  /^\s*On\b[\s\S]{0,300}?\bwrote:/m, // Gmail / Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/im, // Outlook
  /^_{5,}\s*$/m, // Outlook divider
  /\n-- ?\n/, // signature, and our own "\n\n--\n" footer
];

/**
 * Only the customer's newly-typed text: everything from the first quote or footer marker onward is
 * dropped. A clean reply with no marker is returned unchanged.
 */
export function stripQuotedReply(body: string | null | undefined): string {
  if (!body) return body ?? '';
  let cut = body.length;
  for (const rx of REPLY_CUT_MARKERS) {
    const m = rx.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  return body.slice(0, cut).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out and auto-reply detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cheap opt-out keyword PRE-FILTER.
 *
 * A miss is definitively not an opt-out and needs no LLM. A HIT is only a candidate: the same keywords
 * appear in questions ("is there an unsubscribe option?"), negations ("please don't remove me"), and
 * paraphrase — none of which are opt-outs — so an intent confirmation gates it. Always run this over
 * `stripQuotedReply` output.
 */
export const OPT_OUT_RE =
  /\b(unsubscribe|stop\s+(emailing|sending|contacting)|remove\s+me|opt\s*[- ]?\s*out|don'?t\s+email|no\s+more\s+emails)\b/i;

/** Sender addresses that indicate an automated reply rather than a person. */
export const AUTO_REPLY_SENDER_RE =
  /(no-?reply|do-?not-?reply|postmaster|mailer-daemon|bounces?@)/i;

/** Body text that indicates an out-of-office or delivery-status auto-reply. */
export const AUTO_REPLY_TEXT_RE =
  /(out\s+of\s+(the\s+)?office|auto(matic)?[- ]?repl|autoresponder|undeliver|delivery\s+(status|failure)|vacation\s+response)/i;

// ─────────────────────────────────────────────────────────────────────────────
// Outbound-copy classifiers
//
// Each of these decides whether an LLM-composed email may go out at all, so each is deliberately
// NARROW and documents what it must not match. A false positive here sends a claim we cannot back.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strong "the meeting is booked" assertions.
 *
 * Matching one means the email CLAIMS a confirmed meeting, so it may only go out after a booking
 * actually succeeded. Deliberately narrow: generic outreach ("would you be open to a demo?", proposing
 * times) must NOT match, or every cold email would be blocked.
 */
const BOOKING_CONFIRMATION_RE = new RegExp(
  '\\b(' +
    'confirmed' +
    '|locked\\s+(?:it|that|them|this\\s+in|in)' +
    '|calendar\\s+invite' +
    "|you'?re\\s+all\\s+set|you\\s+are\\s+all\\s+set" +
    '|(?:your|the)\\s+demo\\s+is\\s+(?:scheduled|set|confirmed|booked|locked)' +
    "|i'?ve\\s+got\\s+you\\s+(?:down|scheduled|booked)" +
    '|looking\\s+forward\\s+to\\s+(?:our|the)\\s+(?:demo|meeting|call)' +
    '|see\\s+you\\s+(?:on|then|mon|tue|wed|thu|fri)' +
    ')',
  'i'
);

/** True if the email asserts a confirmed or booked meeting, as opposed to generic outreach. */
export function isBookingConfirmation(
  subject: string | null | undefined,
  body: string | null | undefined
): boolean {
  return BOOKING_CONFIRMATION_RE.test(`${subject ?? ''}\n${body ?? ''}`);
}

/**
 * Pre-demo REMINDER language, restating a booked demo's time and join link.
 *
 * Like a confirmation, a reminder is CAN-SPAM transactional: it goes to every booked prospect, phone-lane
 * included, off the outreach budget. Only meaningful once a meeting is booked, so the CALLER additionally
 * gates on `memory.meeting_booked` — that gate is what stops a generic email posing as one.
 */
const REMINDER_RE = new RegExp(
  '\\b(' +
    'reminder|reminding\\s+you' +
    '|(?:your|the)\\s+demo\\s+is\\s+(?:tomorrow|today|coming\\s+up)' +
    '|demo\\s+(?:tomorrow|today)|demo\\s+in\\s+(?:about\\s+)?(?:~\\s*)?\\d' +
    '|(?:quick|friendly|just\\s+a)\\s+reminder' +
    '|(?:demo|meeting|call)\\s+reminder' +
    '|coming\\s+up\\s+(?:tomorrow|today|in\\s+)' +
    ')',
  'i'
);

/** True if the email reads as a pre-demo reminder. */
export function isReminderEmail(
  subject: string | null | undefined,
  body: string | null | undefined
): boolean {
  return REMINDER_RE.test(`${subject ?? ''}\n${body ?? ''}`);
}

/**
 * "We tried to reach you by phone and couldn't" language.
 *
 * Matching means the email's PREMISE is a recent unanswered call, so it may only go out when a fresh
 * unanswered attempt is actually on record. Kept narrow: generic "book a call", "hop on a call",
 * "schedule a call" outreach must NOT match.
 */
const NO_ANSWER_RE = new RegExp(
  '\\b(' +
    'tried\\s+(?:to\\s+)?(?:reach|call|ring|phone|contact)' +
    '|tried\\s+(?:reaching|calling|ringing|phoning|contacting)' +
    '|tried\\s+to\\s+get\\s+a?\\s*hold\\s+of\\s+you' +
    "|couldn'?t\\s+(?:reach|connect|get\\s+(?:through|a?\\s*hold))|could\\s+not\\s+(?:reach|connect)" +
    "|haven'?t\\s+been\\s+able\\s+to\\s+reach|have\\s+not\\s+been\\s+able\\s+to\\s+reach" +
    '|gave\\s+you\\s+a\\s+(?:call|ring|buzz)' +
    '|(?:we\\s+)?missed\\s+you|missed\\s+(?:each\\s+other|connecting)' +
    '|left\\s+(?:you\\s+)?a\\s+(?:voicemail|message|vm)' +
    '|attempted\\s+to\\s+(?:call|reach)' +
    '|reached\\s+out\\s+by\\s+phone' +
    ')',
  'i'
);

/** True if the email's premise is a recent unanswered phone call. */
export function isNoAnswerEmail(
  subject: string | null | undefined,
  body: string | null | undefined
): boolean {
  return NO_ANSWER_RE.test(`${subject ?? ''}\n${body ?? ''}`);
}

/**
 * A US phone number in free-typed email text — `(908) 386-4637`, `908-386-4637`, `908.386.4637`,
 * `+1 908 386 4637`, `9083864637`.
 *
 * Loose on purpose: an intent confirmation rejects non-callback matches (a fax, an order number, our own
 * number quoted back), so this only has to be a candidate finder.
 */
export const PHONE_IN_TEXT_RE =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

/** Strip leading `Re:`/`Fwd:` prefixes so a threaded subject never becomes `Re: Re: ...`. */
const RE_PREFIX_RE = /^(?:\s*(?:re|fwd?)\s*:\s*)+/i;

export function stripRePrefix(subject: string | null | undefined): string {
  return String(subject ?? '')
    .replace(RE_PREFIX_RE, '')
    .trim();
}
