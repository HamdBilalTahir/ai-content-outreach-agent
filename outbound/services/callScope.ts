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

// ─────────────────────────────────────────────────────────────────────────────
// Voice-call scope assembly
//
// Deferred out of Phase 2, which shipped only the deterministic consent-ask line above. Everything
// below is the FACTS FEED the module docstring describes: it emits what is true about the prospect and
// this call, and carries no scripting. The voice agent's own prompt reads `call_type` and
// `prospect_stage` and decides how to run the call — which is what lets the prompt be edited without
// touching this code.
// ─────────────────────────────────────────────────────────────────────────────

import { DateTime } from 'luxon';

import { db } from '../firebase/db';

const DEFAULT_TZ = 'America/New_York';

/** The current funnel stage from memory, defaulting to `New`. */
function prospectStage(mem: ChatMemory | null | undefined): string {
  const m = mem ?? {};
  return String(m.current_stage ?? m.stage ?? 'New').trim() || 'New';
}

/** `"Jane Smith at Acme"`, or the fallback when no name is on file. */
function who(
  mem: ChatMemory | null | undefined,
  fallback = 'the prospect'
): string {
  const m = mem ?? {};
  const name = [
    String(m.first_name ?? '').trim(),
    String(m.last_name ?? '').trim(),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const company = String(m.company ?? '').trim();
  const label = name || fallback;
  return company ? `${label} at ${company}` : label;
}

/**
 * The scheduling FACT the agent needs to avoid offering an impossible time: today's date in the
 * prospect's zone, plus the explicit statement that the earliest bookable demo is tomorrow.
 */
function todayLine(
  mem: ChatMemory | null | undefined,
  chatId?: string | null
): string {
  try {
    let tzName = String((mem ?? {}).timezone ?? '').trim() || DEFAULT_TZ;
    let now = DateTime.now().setZone(tzName);
    if (!now.isValid) {
      tzName = DEFAULT_TZ;
      now = DateTime.now().setZone(tzName);
    }
    const today = now.toFormat('cccc, LLLL d, yyyy');
    return `- today: ${today} (${tzName}); earliest bookable demo time is TOMORROW or later`;
  } catch (e) {
    console.warn(`[SCOPE] today-line failed for ${chatId}: ${e}`);
    return '';
  }
}

function contactLine(mem: ChatMemory | null | undefined): string {
  const m = mem ?? {};
  const onFile = [
    String(m.customer_email ?? '').trim(),
    String(m.phone_number ?? '').trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  return onFile ? `- contact on file: ${onFile}` : '';
}

/**
 * Availability FACTS for the voice agent.
 *
 * The agent cannot fetch slots mid-call, so they are pre-computed and passed in. Facts only — the
 * voice prompt decides how to offer them.
 */
export function buildVoiceSchedulingBlock(
  slotsText = '',
  meetingLink = ''
): string {
  const parts: string[] = [
    slotsText || 'AVAILABLE MEETING TIMES: none pre-loaded for this call.',
  ];
  if (meetingLink) parts.push(`MEETING LINK: ${meetingLink}`);
  return parts.join('\n\n');
}

/** The booked demo time in the prospect's zone. Falls back to the raw stored value. */
function formatMeetingWhen(mem: ChatMemory | null | undefined): string {
  const raw = String((mem ?? {}).meeting_at ?? '').trim();
  if (!raw) return '';
  try {
    let tzName = String((mem ?? {}).timezone ?? '').trim() || DEFAULT_TZ;
    let local = DateTime.fromISO(raw.replace('Z', '+00:00'), { zone: tzName });
    if (!local.isValid) {
      tzName = DEFAULT_TZ;
      local = DateTime.fromISO(raw.replace('Z', '+00:00'), { zone: tzName });
    }
    if (!local.isValid) return raw;
    return `${local.toFormat('cccc, LLLL d')} at ${local.toFormat('h:mm a')} (${tzName})`;
  } catch {
    return raw;
  }
}

/** Prior calls placed and email subjects sent on THIS chat, from its message history. Best-effort. */
async function scanPriorInteractions(
  chatId: string | null | undefined
): Promise<{ calls: number; emailSubjects: string[] }> {
  let calls = 0;
  const emailSubjects: string[] = [];
  if (!chatId) return { calls, emailSubjects };

  try {
    const snap = await db
      .collection('chats')
      .doc(chatId)
      .collection('messages')
      .orderBy('timestamp')
      .get();
    for (const m of snap.docs) {
      const content = (m.data() ?? {}).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const tu = (block as Record<string, unknown>).toolUse;
        if (typeof tu !== 'object' || tu === null) continue;
        const t = tu as Record<string, unknown>;
        const nm = String(t.name ?? '');
        if (nm === 'make_phone_call' || nm === 'make_phone_call_from_number') {
          calls += 1;
        } else if (nm === 'send_email') {
          const subj = String(
            ((t.input ?? {}) as Record<string, unknown>).subject ?? ''
          ).trim();
          if (subj) emailSubjects.push(subj.slice(0, 80));
        }
      }
    }
  } catch (e) {
    console.warn(`[SCOPE] history scan failed for ${chatId}: ${e}`);
  }
  return { calls, emailSubjects };
}

export interface CallContext {
  call_type: string;
  stage: string;
  calls: number;
  email_subjects: string[];
  known?: boolean;
}

/**
 * One history scan → the discrete facts the call needs.
 *
 * Callers pass the returned object into the scope builder so the history is scanned ONCE, and set
 * `call_type` and `prospect_stage` as discrete dynamic variables on the call.
 */
export async function outboundCallContext(
  chatMemory: ChatMemory | null | undefined,
  chatId?: string | null,
  booked = false
): Promise<CallContext> {
  const mem = chatMemory ?? {};
  if (booked) {
    return {
      call_type: 'REMINDER',
      stage: prospectStage(mem),
      calls: 0,
      email_subjects: [],
    };
  }
  const { calls, emailSubjects } = await scanPriorInteractions(chatId);
  return {
    call_type: calls || emailSubjects.length ? 'FOLLOW_UP' : 'FIRST_OUTREACH',
    stage: prospectStage(mem),
    calls,
    email_subjects: emailSubjects,
  };
}

/**
 * Compressed, important-only context from the linked CRM contact — role at company, location,
 * lifecycle. Kept short deliberately so it does not bloat the prompt, and empty when nothing useful.
 */
export function hubspotContextLine(
  chatMemory: ChatMemory | null | undefined
): string {
  const m = chatMemory ?? {};
  const role = String(m.job_title ?? '').trim();
  const company = String(m.company ?? '').trim();
  const loc = [String(m.city ?? '').trim(), String(m.state ?? '').trim()]
    .filter(Boolean)
    .join(', ');
  const lifecycle = String(m.lifecyclestage ?? '').trim();

  const label = role && company ? `${role} at ${company}` : role || company;
  let line = [label, loc ? `(${loc})` : ''].filter(Boolean).join(' ');
  if (lifecycle) line = `${line} — ${lifecycle}`.trim();
  return line.replace(/^[\s—]+|[\s—]+$/g, '');
}

/** Assemble the prior-contact line shared by the outbound and inbound scopes. */
function priorContactBits(calls: number, subjects: string[]): string[] {
  const bits: string[] = [];
  if (calls) bits.push(`${calls} call${calls > 1 ? 's' : ''}`);
  if (subjects.length) {
    bits.push(`${subjects.length} email${subjects.length > 1 ? 's' : ''}`);
  }
  return bits;
}

/**
 * OUTBOUND voice-call FACTS. Facts only — no behaviour scripting.
 *
 * The `call_type` is the single most important line: the voice prompt branches on it to decide whether
 * this is a first touch, a follow-up, or a reminder for a demo already on the calendar.
 */
export async function buildOutboundCallScope(
  chatMemory: ChatMemory | null | undefined,
  chatId?: string | null,
  booked = false,
  ctxIn?: CallContext | null
): Promise<string> {
  const mem = chatMemory ?? {};
  const ctx = ctxIn ?? (await outboundCallContext(mem, chatId, booked));
  const ct = ctx.call_type;

  const lines: string[] = [
    'CALL CONTEXT (facts for this call — the voice agent prompt decides how to use them):',
    `- call_type: ${ct}`,
    `- prospect_stage: ${ctx.stage}`,
    `- prospect: ${who(mem)}`,
  ];

  const cl = contactLine(mem);
  if (cl) lines.push(cl);
  const hc = hubspotContextLine(mem);
  if (hc) lines.push(`- contact context: ${hc}`);
  const tl = todayLine(mem, chatId);
  if (tl) lines.push(tl);

  if (ct === 'REMINDER') {
    const when = formatMeetingWhen(mem);
    const link = String(mem.hubspot_meeting_link ?? '').trim();
    lines.push(
      when ? `- booked demo: ${when}` : '- booked demo: already on the calendar'
    );
    if (link) lines.push(`- meeting link: ${link}`);
  } else if (ct === 'FOLLOW_UP' || ct === 'INBOUND_KNOWN') {
    const bits = priorContactBits(ctx.calls, ctx.email_subjects);
    const engaged = ['engaged', 'lead'].includes(
      ctx.stage.trim().toLowerCase()
    );
    lines.push(
      `- prior contact: ${bits.join(', ')} (${engaged ? 'replied' : 'no reply yet'})`
    );
    if (ctx.email_subjects.length) {
      lines.push('- prior email subjects: ' + ctx.email_subjects.join('; '));
    }
  }

  // Cadence state, so the voice agent knows how far into the cadence this call is.
  const ef = Number(mem.email_followup_count ?? 0);
  const cf = Number(mem.call_followup_count ?? 0);
  let cadence = `- follow-ups so far: email ${ef} of 4, call ${cf}`;
  if (mem._first_outbound_email_at) {
    cadence += `; first email ${String(mem._first_outbound_email_at)}`;
  }
  if (mem._first_outbound_call_at) {
    cadence += `; first call ${String(mem._first_outbound_call_at)}`;
  }
  lines.push(cadence);

  return lines.join('\n');
}

/** One scan → inbound call facts. A caller is KNOWN when a name or any prior contact is on record. */
export async function inboundCallContext(
  chatMemory: ChatMemory | null | undefined,
  chatId?: string | null
): Promise<CallContext> {
  const mem = chatMemory ?? {};
  const name = [
    String(mem.first_name ?? '').trim(),
    String(mem.last_name ?? '').trim(),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const { calls, emailSubjects } = await scanPriorInteractions(chatId);
  const known = Boolean(name || calls || emailSubjects.length);
  return {
    call_type: known ? 'INBOUND_KNOWN' : 'INBOUND_NEW',
    stage: prospectStage(mem),
    calls,
    email_subjects: emailSubjects,
    known,
  };
}

/** INBOUND voice-call FACTS — the customer called us. Facts only. */
export async function buildInboundCallScope(
  chatMemory: ChatMemory | null | undefined,
  chatId?: string | null,
  ctxIn?: CallContext | null
): Promise<string> {
  const mem = chatMemory ?? {};
  const ctx = ctxIn ?? (await inboundCallContext(mem, chatId));

  const lines: string[] = [
    'CALL CONTEXT (facts for this INBOUND call — the customer called us; the voice agent prompt ' +
      'decides how to use them):',
    `- call_type: ${ctx.call_type}`,
    `- prospect_stage: ${ctx.stage}`,
    `- caller: ${who(mem, 'the caller')}`,
  ];

  const cl = contactLine(mem);
  if (cl) lines.push(cl);
  const tl = todayLine(mem, chatId);
  if (tl) lines.push(tl);

  if (ctx.known && (ctx.calls || ctx.email_subjects.length)) {
    lines.push(
      '- prior contact: ' +
        priorContactBits(ctx.calls, ctx.email_subjects).join(', ')
    );
    if (ctx.email_subjects.length) {
      lines.push('- prior email subjects: ' + ctx.email_subjects.join('; '));
    }
  }
  return lines.join('\n');
}

/** Exposed for tests: the pure formatters. */
export const __testing = {
  prospectStage,
  who,
  contactLine,
  todayLine,
  formatMeetingWhen,
};
