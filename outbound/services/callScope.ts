/**
 * Voice-call scope builder.
 *
 * DESIGN: this is a **facts feed only** — prospect stage, call type, contact on file, availability,
 * booked-demo details, prior-contact counts. It carries no in-call scripting ("what to say", "how to
 * say it"): that lives in the voice agent's own prompt, which branches on the facts emitted here.
 * Keeping the split clean is what lets the prompt be edited without touching this code.
 */

import type { ChatMemory } from '../types';

/**
 * A US phone number appearing in a customer's reply. Used to decide the consent-ask cadence
 * deterministically rather than asking the model to judge whether a number was given.
 */
const PHONE_IN_REPLY_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

/**
 * The deterministic phone-consent ASK signal for the outbound availability block (TCPA/PEWC), or
 * `null` when no ask is warranted.
 *
 * Fires only when the phone channel is closed (opted out, or no number on file) AND email is open —
 * there is no point asking for consent to call someone we can already call, and no way to ask at all
 * if we cannot email them.
 *
 * Enforces a hard **≤2 asks** cadence:
 *  1. ASK #1 on a cold outreach turn.
 *  2. ASK #2 on the customer's first reply, only if that reply contained no number.
 *  - If the reply DOES contain a number: stop asking and say we will call.
 *  - Otherwise: do not re-ask.
 *
 * `_phone_ask_count` drives this, and it is bumped only when the disclosure actually went out — so a
 * failed send does not consume an ask.
 *
 * `business_only` campaigns return `null` outright: business numbers do not require PEWC consent.
 */
export function buildPhoneConsentAskLine(
  chatMemory: ChatMemory | null | undefined,
  messageFrom: string,
  message: string
): string | null {
  const m = chatMemory ?? {};
  if (m.business_only) return null;

  const yes = (k: keyof ChatMemory): boolean =>
    String(m[k]).toUpperCase() === 'Y';

  const phoneOut = yes('block_phone') || yes('phone_opt_out');
  const phoneMissing = !String(m.phone_number ?? '').trim();
  const emailOut = m._email_opt_out === true;

  if (!((phoneOut || phoneMissing) && m.customer_email && !emailOut))
    return null;

  const askCount = Number(m._phone_ask_count ?? 0);

  if (
    messageFrom === 'customer' &&
    PHONE_IN_REPLY_RE.test(String(message ?? ''))
  ) {
    return (
      '- phone consent: they included a phone number in this reply. Do NOT ask again — reply ' +
      "briefly that you'll give them a call. (The phone channel is reopened and a call scheduled " +
      'automatically.)'
    );
  }

  if (messageFrom === 'admin' && askCount === 0) {
    return (
      '- phone consent (ASK #1): no callable number (opted out / none). In this outreach email, ' +
      "ALSO ask for the best number to reach them and include your Email Skill's consent " +
      'disclosure verbatim. Keep the demo the primary CTA.'
    );
  }

  if (messageFrom === 'customer' && askCount >= 1 && askCount < 2) {
    return (
      '- phone consent (ASK #2, last time): they replied without a number. In your reply, pair the ' +
      "demo ask with ONE more request for the best number, including your Email Skill's consent " +
      'disclosure verbatim.'
    );
  }

  return null;
}
