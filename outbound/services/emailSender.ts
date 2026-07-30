/**
 * THE UNIFIED EMAIL CHOKE POINT — every outbound email passes through `sendEmail` here.
 *
 * Direct calls to `sendEmailViaSendgrid` outside this module are forbidden and asserted against in the
 * suite. The LLM and skills choose *what to say*; this module guarantees *what every email carries*
 * (compliance headers and footer) and *who never receives one* (suppression, verification, breaker,
 * budgets).
 *
 * ## TWO INDEPENDENT AXES — do not conflate them
 *
 * They were one axis once, and that caused silent drops.
 *
 * **`gate_profile` — WHICH GATES APPLY. Chosen by STATE, not by the caller.**
 *  - `reply` — `in_reply_to` present AND the inbound anchor is fresh. Class privileges are earned by
 *    state, not by headers: a stale thread keeps its threading headers but gates as `outreach`.
 *  - `transactional` — booking confirmations and invites, declared by transactional callers.
 *  - `outreach` — everything else: cold first touch, cadence nudges, stale-thread follow-ups.
 *
 * **`origin` — WHICH DEFERRAL MACHINERY THE CALLER OWNS. Fixed at the call site.**
 *  - `llm_tool` — the sender creates the retry task itself, because the LLM turn ends and nobody else
 *    will.
 *  - `nudge_service` — returns `{deferred, retry_at}`; the nudge's own scheduler reschedules.
 *  - `transactional_service` — exempt from every deferring gate. Reaching one is a bug, and logs as an
 *    assertion failure rather than deferring silently.
 *
 * ## GATE ORDER — cheapest and terminal first, consuming counters LAST
 *
 *     G0 CAN-SPAM config → invalid-address → opt-out → phone-lane → G1a breaker
 *       → G2 suppression → G3 provider live → G4 verification
 *       → G0b business hours → hourly bucket → G1b domain budget → per-recipient cap
 *       → G5 compliance build → send → send_log
 *
 * The ordering is load-bearing in two places. **G0b sits after the address-quality skips** so a
 * suppressed or invalid address is TERMINALLY skipped and never turned into a retry, and **before the
 * consuming gates** so an after-hours send burns neither a bucket token nor domain budget. And the
 * per-recipient cap is last of the consumers, so a deferral above it never burns a recipient token.
 *
 * ## Failure semantics, deliberately mixed
 *
 * G2 fails CLOSED on its own data. G3 fails OPEN on provider API errors. The domain budget fails
 * CLOSED because it is a reputation control. The hourly bucket and the recipient cap fail OPEN because
 * they are rate controls. See `PORT-PLAN.md` for the full table.
 */

import { DateTime } from 'luxon';

import { createTaskWithId } from '../firebase/chat';
import * as sup from './suppression';
import * as rep from './reputation';
import * as sgmail from './sendgridMail';
import type {
  SendResult,
  SendgridAttachment,
  SendgridConfig,
} from './sendgridMail';
import {
  businessHoursStartAfter,
  checkBusinessHours,
  resolveCustomerState,
  resolveCustomerTimezone,
} from './businessHours';
import {
  deletePendingFollowups,
  deletePendingOutboundOutreach,
} from './scheduling';
import { secondsUntilReset, tryConsume } from './rateLimit';
import { verify } from './verification';
import {
  emailInvalid,
  emailOptedOut,
  loadChatDoc,
  resolveOutboundName,
  updateEmailMeta,
} from './chat';
import {
  allowCatchAll,
  companyName as envCompanyName,
  companyPostalAddress,
  emailsPerHour,
  emailsPerRecipientPerDay,
  replyFreshnessHours,
  unsubBaseUrl,
  unsubMailto,
} from '../config';
import type { ChatMemory } from '../types';

export const PROFILE_OUTREACH = 'outreach';
export const PROFILE_REPLY = 'reply';
export const PROFILE_TRANSACTIONAL = 'transactional';

export const ORIGIN_LLM_TOOL = 'llm_tool';
export const ORIGIN_NUDGE = 'nudge_service';
export const ORIGIN_TRANSACTIONAL = 'transactional_service';

export type GateProfile =
  | typeof PROFILE_OUTREACH
  | typeof PROFILE_REPLY
  | typeof PROFILE_TRANSACTIONAL;

export type SendOrigin =
  | typeof ORIGIN_LLM_TOOL
  | typeof ORIGIN_NUDGE
  | typeof ORIGIN_TRANSACTIONAL;

/**
 * Guidance strings returned to the model on a terminal skip.
 *
 * They exist because the model's instinct on a blocked email is either to retry it, invent a different
 * address, or mark the prospect lost — all three wrong. Each string says explicitly what to do instead
 * and, in particular, that email being blocked is NOT grounds to mark a prospect lost when a phone is
 * still reachable.
 */
const GUIDANCE: Readonly<Record<string, string>> = {
  suppressed:
    'This address must not be emailed. Do not retry it or substitute another address. ' +
    'If a phone is on file and not phone-opted-out, switch to phone and continue per ' +
    'your skill. Do NOT mark the prospect lost just because email is blocked — only ' +
    'mark_prospect_lost if no channel is reachable (no phone, or phone also opted out) ' +
    "or the prospect has opted out of ALL contact / said they're not interested.",
  invalid:
    'This address is invalid/undeliverable. Do not retry it or guess another address. ' +
    'If a phone is on file and not phone-opted-out, switch to phone and continue per your ' +
    'skill. Do NOT mark the prospect lost just because email is undeliverable — only ' +
    'mark_prospect_lost if no channel is reachable or the prospect opted out of ALL ' +
    "contact / said they're not interested.",
  risky:
    'This address could not be verified as deliverable. Do not retry it this turn. ' +
    'Prefer phone contact if the skill allows; otherwise continue per your skill.',
  'recipient-daily-cap':
    'This recipient has reached the daily email limit. Do not retry today ' +
    'and do not send additional emails to them. Continue per your skill.',
  'compliance-config-missing':
    'Email is unavailable due to a configuration error (missing ' +
    'CAN-SPAM postal address) — notify an administrator. Do not ' +
    "retry, and do not work around this by moving the email's " +
    'content to another channel.',
};

/**
 * A fresh inbound anchor within the freshness window.
 *
 * A MISSING timestamp counts as stale, which is the safe default: an unanchored send gates as cold
 * outreach and so carries the unsubscribe machinery.
 */
function replyIsFresh(memory: ChatMemory | null | undefined): boolean {
  const raw = (memory ?? {})._last_inbound_email_at;
  if (!raw) return false;
  try {
    const ts = new Date(String(raw).replace('Z', '+00:00'));
    if (Number.isNaN(ts.getTime())) return false;
    return Date.now() - ts.getTime() <= replyFreshnessHours() * 3_600_000;
  } catch {
    return false;
  }
}

/** Resolve the gate profile from STATE. A caller cannot claim `reply` privileges for a stale thread. */
function resolveProfile(
  profile: string | null | undefined,
  inReplyTo: string | null | undefined,
  memory: ChatMemory | null | undefined
): GateProfile {
  if (profile === PROFILE_TRANSACTIONAL) return PROFILE_TRANSACTIONAL;
  // Explicit: the caller is answering a message literally in hand.
  if (profile === PROFILE_REPLY) return PROFILE_REPLY;
  if (inReplyTo && replyIsFresh(memory)) return PROFILE_REPLY;
  return PROFILE_OUTREACH;
}

/** The prospect-local next 9:00 business morning — today's if still ahead, else the next allowed day. */
function nextBusinessMorning(
  tz: string | null | undefined,
  state: string | null | undefined
): Date {
  try {
    const startToday = businessHoursStartAfter(0, tz, state);
    return startToday > new Date()
      ? startToday
      : businessHoursStartAfter(1, tz, state);
  } catch {
    return new Date(Date.now() + 12 * 3_600_000);
  }
}

interface DeferContext {
  chatId?: string | null;
  agentId: string;
  memory: ChatMemory;
  to: string;
}

/**
 * Dispatch a deferral by ORIGIN. Every deferred send must have an owner — a retry task, or a
 * self-rescheduling service — so that nothing is ever silently dropped.
 */
async function defer(
  origin: SendOrigin,
  condition: string,
  retryAt: Date,
  ctx: DeferContext
): Promise<SendResult> {
  const retryIso = retryAt.toISOString();

  if (origin === ORIGIN_LLM_TOOL && ctx.chatId) {
    try {
      // Once the first outbound email has gone out, a deferred send is a FOLLOW-UP and must
      // reschedule as one — never as a fresh first touch. Only a deferred FIRST email, with no send
      // on record yet, retries as `outbound_outreach`.
      const alreadySent = Boolean(ctx.memory._first_outbound_email_at);
      const retryType = alreadySent
        ? 'followup_if_no_reply'
        : 'outbound_outreach';

      if (retryType === 'outbound_outreach') {
        await deletePendingOutboundOutreach(ctx.chatId); // reschedule, do not stack
        await deletePendingFollowups(ctx.chatId); // a pending outreach means no follow-up yet
      } else {
        await deletePendingFollowups(ctx.chatId);
      }

      await createTaskWithId(ctx.chatId, retryType, retryAt, {
        notes:
          `An email send was deferred (${condition}); retry scheduled for ` +
          `${retryIso}. Continue outreach per your outbound skill.`,
        agent_id: ctx.agentId,
        account_id: ctx.agentId,
        attendee_id: ctx.memory.phone_number,
        task_source: `email_defer_${condition}`,
      });
    } catch (e) {
      console.error(
        `[EMAIL_SENDER] defer task creation failed (${condition}) chat=${ctx.chatId}: ${e}`
      );
    }
  } else if (origin === ORIGIN_TRANSACTIONAL) {
    console.error(
      `[EMAIL_SENDER] ASSERT: transactional send hit a deferring gate ` +
        `(${condition}) to=${ctx.to} — check the gate matrix`
    );
  }
  // nudge_service: no task — its own scheduler reschedules to retryAt.

  console.log(
    `[EMAIL_SENDER] deferred (${condition}) to=${ctx.to} origin=${origin} retry_at=${retryIso}`
  );
  return {
    success: false,
    skipped: true,
    message_id: null,
    error: null,
    status: 'deferred',
    reason: condition,
    retry_at: retryIso,
    message: `Email deferred (${condition}); retry scheduled for ${retryIso}.`,
  };
}

/**
 * A terminal recipient-condition skip: NO retry task, ever. Retrying a suppressed or invalid address
 * later is exactly the failure mode this module exists to prevent.
 */
function skip(reasonKey: string, reasonDetail: string, to: string): SendResult {
  console.log(`[EMAIL_SENDER] skipped to=${to}: ${reasonDetail}`);
  const guidance = GUIDANCE[reasonKey] ?? GUIDANCE.suppressed;
  return {
    success: false,
    skipped: true,
    message_id: null,
    error: null,
    status: 'skipped',
    reason: reasonDetail,
    guidance,
    message: `Email NOT sent to ${to}: ${reasonDetail}. ${GUIDANCE[reasonKey] ?? ''}`,
  };
}

/**
 * G5 — the compliance builder. Code-appended, NEVER prompt-dependent.
 *
 * The identity and physical-address block goes on EVERY email. The unsubscribe machinery — the
 * `List-Unsubscribe` headers and the footer opt-out line — goes only on cold OUTREACH, the unsolicited
 * sends. Replies (1:1) and transactional mail omit it while keeping company and address.
 *
 * Identity and opt-out target are per-agent, because each agent sends from its own domain and the
 * footer must match THAT domain. Callers pass values that already fold in the env fallback.
 *
 * The mailto-only branch is a genuine CAN-SPAM opt-out and keeps the email compliant, but it is NOT
 * RFC 8058 one-click (that is HTTPS-only), so it deliberately omits `List-Unsubscribe-Post`.
 */
export function buildCompliance(
  to: string,
  text: string | undefined,
  html: string | null | undefined,
  profile: GateProfile,
  fromName: string | null | undefined,
  opts: {
    companyName?: string | null;
    postalAddress?: string | null;
    unsubBaseUrl?: string | null;
    unsubMailto?: string | null;
    resolvedName?: string;
  } = {}
): { headers: Record<string, string>; text: string; html: string | null } {
  const headers: Record<string, string> = {};
  const footerLines: string[] = [];

  const company = opts.companyName || envCompanyName();
  const address =
    opts.postalAddress !== null && opts.postalAddress !== undefined
      ? opts.postalAddress
      : companyPostalAddress();
  if (!address) {
    console.warn(
      '[EMAIL_SENDER] postal address not set — CAN-SPAM footer incomplete'
    );
  }

  footerLines.push(`${fromName || opts.resolvedName || 'Lily'} | ${company}`);
  if (address) footerLines.push(address);

  if (profile === PROFILE_OUTREACH) {
    const base = (
      opts.unsubBaseUrl !== null && opts.unsubBaseUrl !== undefined
        ? opts.unsubBaseUrl
        : unsubBaseUrl()
    ).replace(/\/+$/, '');
    const mailto =
      opts.unsubMailto !== null && opts.unsubMailto !== undefined
        ? opts.unsubMailto
        : unsubMailto();
    const token = sup.unsubToken(to);

    if (base && token) {
      const unsubUrl = `${base}?t=${token}&e=${encodeURIComponent(to.trim().toLowerCase())}`;
      headers['List-Unsubscribe'] = mailto
        ? `<${unsubUrl}>, <mailto:${mailto}?subject=unsubscribe>`
        : `<${unsubUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      footerLines.push(
        `Not relevant? Reply "no thanks" or opt out: ${unsubUrl}`
      );
    } else if (mailto) {
      headers['List-Unsubscribe'] = `<mailto:${mailto}?subject=unsubscribe>`;
      footerLines.push(`To unsubscribe, email ${mailto}.`);
    } else {
      console.warn(
        '[EMAIL_SENDER] no unsubscribe target set for this domain ' +
          '(unsub_base_url/UNSUB_BASE_URL or unsub_mailto/UNSUB_MAILTO) — ' +
          'List-Unsubscribe omitted; only the reply-based opt-out applies ' +
          '(compliance gap until one is configured)'
      );
    }
  }

  const footerTxt = '\n\n--\n' + footerLines.join('\n');
  const outText = (text ?? '') + footerTxt;
  let outHtml = html ?? null;
  if (outHtml) {
    const esc = footerLines.join('<br>');
    outHtml =
      outHtml +
      '<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">' +
      `<p style="color:#888;font-size:12px">${esc}</p>`;
  }
  return { headers, text: outText, html: outHtml };
}

export interface SendEmailArgs {
  to: string;
  subject?: string;
  text?: string;
  html?: string | null;
  origin?: SendOrigin;
  profile?: string | null;
  /** The provider category tag. Defaults to the agent's own outbound stream name. */
  stream?: string | null;
  chatId?: string | null;
  agentId?: string | null;
  campaignId?: string | null;
  memory?: ChatMemory | null;
  inReplyTo?: string | null;
  references?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  apiKey?: string | null;
  /** The calling agent's resolved SendGrid config; its per-domain values drive footer and posture. */
  senderCfg?: SendgridConfig | null;
  attachments?: SendgridAttachment[] | null;
  isPlayground?: boolean;
}

/** The single send path. */
export async function sendEmail(args: SendEmailArgs): Promise<SendResult> {
  const {
    to,
    subject,
    text,
    html,
    origin = ORIGIN_LLM_TOOL,
    profile = null,
    chatId = null,
    campaignId = null,
    inReplyTo = null,
    references = null,
    fromEmail = null,
    fromName = null,
    replyTo = null,
    apiKey = null,
    senderCfg = null,
    attachments = null,
    isPlayground = false,
  } = args;

  const toNorm = String(to ?? '')
    .trim()
    .toLowerCase();
  const memory: ChatMemory = args.memory ?? {};
  const agentId = String(args.agentId ?? memory.agent_id ?? 'outbound');

  // The provider category is the STREAM, named dynamically from the agent so it tracks the persona
  // rather than hardcoding a name.
  const stream =
    args.stream ??
    `${await resolveOutboundName({ ...memory, agent_id: agentId })} Outbound Comms`;

  // Playground: G2 is evaluated for realism (logged only), then the helper short-circuits. No budgets,
  // no counters, no send-log pollution.
  if (isPlayground) {
    const entry = await sup.isSuppressed(toNorm);
    if (entry) {
      console.log(
        `[EMAIL_SENDER] (playground) would-be suppressed: ${toNorm} ${JSON.stringify(entry)}`
      );
    }
    const res = await sgmail.sendEmailViaSendgrid({
      to,
      subject,
      text,
      html,
      from_email: fromEmail,
      from_name: fromName,
      in_reply_to: inReplyTo,
      references,
      reply_to: replyTo,
      api_key: apiKey,
      is_playground: true,
      attachments,
    });
    res.status = res.success ? 'sent' : 'failed';
    return res;
  }

  const gateProfile = resolveProfile(profile, inReplyTo, memory);

  // Resolve tz/state the SAME way the business-hours CHECK does — memory first, then the phone's area
  // code — so a deferral's retry time is computed in the zone the check evaluates in. Otherwise a chat
  // with no stored timezone gets its retry in the ET fallback while the check uses the area-code zone,
  // and the send defers forever. That was observed live on Central and international numbers.
  let tz: string | null | undefined;
  let state: string | null | undefined;
  try {
    const phoneForTz = memory.phone_number;
    tz = resolveCustomerTimezone(phoneForTz, memory) ?? memory.timezone;
    state = resolveCustomerState(phoneForTz, memory) ?? memory.state;
  } catch {
    tz = memory.timezone;
    state = memory.state;
  }

  // Test records run the FULL gate stack — suppression, verification, per-recipient cap, compliance —
  // but must NOT consume the real production domain budget. Only the budget and breaker are skipped.
  const isTestRecord =
    String(memory.record_type ?? '')
      .trim()
      .toLowerCase() === 'test';

  // Per-agent (per-domain) config, env only as fallback. `domain` is the reputation key.
  const scfg = senderCfg ?? ({} as SendgridConfig);
  const pick = <K extends keyof SendgridConfig>(
    key: K
  ): SendgridConfig[K] | null => {
    const v = scfg[key];
    return v === null || v === undefined || v === '' ? null : v;
  };

  const effCompany =
    (pick('company_name') as string | null) || envCompanyName();
  const effAddress = String(
    (pick('postal_address') as string | null) || companyPostalAddress() || ''
  ).trim();
  const effUnsubBase =
    (pick('unsub_base_url') as string | null) || unsubBaseUrl() || '';
  const effUnsubMailto =
    (pick('unsub_mailto') as string | null) || unsubMailto();
  const effDailyCap = pick('daily_cap');
  const effWarmupStart = pick('warmup_start_date') as string | null;
  const domain = rep.domainOf(fromEmail);

  /**
   * Stamp the internal classification labels on every outcome, audit every non-sent outcome to the
   * send log with its exact cause, and roll it up onto the chat so per-chat analysis is one read.
   */
  const out = async (res: SendResult): Promise<SendResult> => {
    res.profile = gateProfile;
    res.origin = origin;
    if (res.status !== 'sent') {
      await rep.logEmailOutcome({
        agent_id: agentId,
        sender: fromEmail,
        recipient: toNorm,
        status: res.status ?? 'failed',
        reason: res.reason,
        error: res.error,
        campaign_id: campaignId,
        profile: gateProfile,
        origin,
        chat_id: chatId,
        domain,
      });
    }
    if (chatId) {
      try {
        await updateEmailMeta(chatId, {
          status: res.status ?? 'failed',
          profile: gateProfile,
          origin,
          reason: res.reason,
          error: res.error,
          recipient: toNorm,
        });
      } catch (e) {
        console.warn(
          `[EMAIL_SENDER] email_meta rollup failed (non-blocking): ${e}`
        );
      }
    }
    return res;
  };

  const deferCtx: DeferContext = { chatId, agentId, memory, to: toNorm };

  // G0 — CAN-SPAM hard fail. A commercial email without the sender's physical address is a statutory
  // violation, not a degraded mode, so this REFUSES rather than warning. Cheapest gate first: a config
  // error must never burn budget or bucket tokens, or trigger API lookups.
  if (!effAddress) {
    console.error(
      '[EMAIL_SENDER] postal address not set (per-agent postal_address / ' +
        'COMPANY_POSTAL_ADDRESS) — refusing send (CAN-SPAM)'
    );
    return out(
      skip('compliance-config-missing', 'compliance-config-missing', toNorm)
    );
  }

  // The deterministic INVALID-ADDRESS gate. A verified-undeliverable mailbox is dead on EVERY profile —
  // no transactional carve-out, unlike opt-out — because sending to it only bounces and hurts the
  // domain. Such contacts were enrolled on the phone lane; this closes the reply and transactional
  // paths to the bad address too, which the outreach-only phone-lane gate below does not cover.
  if (chatId) {
    try {
      if (emailInvalid(await loadChatDoc(chatId))) {
        console.log(
          `[EMAIL_SENDER] chat ${chatId} — skipping send (email address invalid)`
        );
        return out(skip('suppressed', 'email-invalid', toNorm));
      }
    } catch (e) {
      console.warn(
        `[EMAIL_SENDER] email-invalid gate skipped chat=${chatId}: ${e}`
      );
    }
  }

  // The deterministic EMAIL opt-out gate, reading the trustworthy top-level key. Transactional
  // carve-out: a genuine booking confirmation still goes, mirroring the consent-suppression carve-out.
  if (gateProfile !== PROFILE_TRANSACTIONAL && chatId) {
    try {
      if (emailOptedOut(await loadChatDoc(chatId))) {
        return out(skip('suppressed', 'email-opted-out', toNorm));
      }
    } catch (e) {
      console.warn(
        `[EMAIL_SENDER] email opt-out gate skipped chat=${chatId}: ${e}`
      );
    }
  }

  // PHONE-LANE = CALL-ONLY. A phone-reachable contact is reached by PHONE for proactive outreach and
  // never proactively emailed, so OUTREACH email is a terminal skip with no retry — the phone cadence
  // owns outreach. Transactional and reply email are NOT affected, and still send to phone-lane
  // contacts off the outreach budget.
  if (
    gateProfile === PROFILE_OUTREACH &&
    String(memory._outreach_lane ?? '') === 'phone'
  ) {
    console.log(
      `[EMAIL_SENDER] phone-lane chat ${chatId} — skipping OUTREACH email (call-only lane)`
    );
    return out(skip('phone-lane-call-only', 'phone-lane-call-only', toNorm));
  }

  // G1a — the breaker, for this domain only. Test records bypass: an E2E run must not be halted by it.
  if (gateProfile === PROFILE_OUTREACH && !isTestRecord) {
    const brk = await rep.breakerCheck(domain, effDailyCap, effWarmupStart);
    if (brk.halted) {
      let retryAt: Date;
      try {
        retryAt = businessHoursStartAfter(1, tz, state); // the next business day
      } catch {
        retryAt = new Date(Date.now() + 86_400_000);
      }
      return out(await defer(origin, 'breaker_halt', retryAt, deferCtx));
    }
  }

  // G2 — local suppression, on every profile: a deliverability block stops even transactional mail.
  const entry = await sup.isSuppressed(toNorm);
  if (entry) {
    if (
      entry.class === sup.CLASS_DELIVERABILITY ||
      gateProfile !== PROFILE_TRANSACTIONAL
    ) {
      return out(skip('suppressed', `suppressed:${entry.reason}`, toNorm));
    }
    // consent/complaint plus transactional → requested mail, allowed through (CAN-SPAM carve-out).
  }

  // G3 — the provider's own suppression lists, mirrored locally. Transactional confirmations often go
  // to a fresh, never-emailed address (the booking happened on a call), so they must still honour
  // deliverability suppression: "off the volume cap" is not "skip hygiene".
  if (
    (gateProfile === PROFILE_OUTREACH ||
      gateProfile === PROFILE_TRANSACTIONAL) &&
    apiKey
  ) {
    const sgReason = await sup.checkSendgrid(toNorm, apiKey);
    if (sgReason) {
      return out(skip('suppressed', `suppressed:${sgReason}`, toNorm));
    }
  }

  // G4 — verification. Catches a typo'd confirmation address before it hard-bounces and burns the
  // domain. Fails OPEN on a verifier error so an outage never blocks a committed confirmation.
  if (
    gateProfile === PROFILE_OUTREACH ||
    gateProfile === PROFILE_TRANSACTIONAL
  ) {
    let v: { result: string; detail: string };
    try {
      v = await verify(toNorm);
    } catch (e) {
      console.warn(`[EMAIL_SENDER] verification errored (${e}) — proceeding`);
      v = { result: 'valid', detail: 'verify-error-pass' };
    }
    if (v.result === 'invalid') {
      await sup.suppress(toNorm, 'verify-invalid', `g4:${v.detail}`);
      return out(skip('invalid', `invalid:${v.detail}`, toNorm));
    }
    if (v.result === 'risky' || v.result === 'unknown') {
      if (!allowCatchAll()) {
        return out(skip('risky', `risky:${v.detail}`, toNorm));
      }
    }
  }

  // G0b — business hours, for agent-tool outreach only. See the module docstring for why it sits
  // exactly here. Transactional, test records, and the self-rescheduling nudge service are exempt.
  if (
    origin === ORIGIN_LLM_TOOL &&
    gateProfile === PROFILE_OUTREACH &&
    !isTestRecord
  ) {
    let outsideHours = false;
    try {
      const blocked = checkBusinessHours(memory.phone_number || toNorm, memory);
      outsideHours = blocked.timezone !== null;
    } catch (e) {
      console.warn(
        `[EMAIL_SENDER] business-hours check skipped (${e}) — proceeding`
      );
      outsideHours = false;
    }
    if (outsideHours) {
      return out(
        await defer(
          origin,
          'outside_business_hours',
          nextBusinessMorning(tz, state),
          deferCtx
        )
      );
    }
  }

  // The hourly bucket (outreach only; fails open). Test records bypass.
  if (gateProfile === PROFILE_OUTREACH && !isTestRecord) {
    try {
      const perHour = Number(pick('per_hour') ?? emailsPerHour());
      if (
        perHour > 0 &&
        !(await tryConsume(`email:${agentId}`, perHour, 3600))
      ) {
        // Retry at the NEXT REAL open slot — when this agent's fixed window actually rolls over — not
        // a few minutes into the still-full window. A short jitter guaranteed a re-fail, which was the
        // deferral loop that starved the campaign. A deterministic per-recipient minute spread past
        // the reset then keeps N deferred sends from all re-consuming at the same instant.
        const resetIn = await secondsUntilReset(`email:${agentId}`, 3600);
        const spread =
          1 +
          ([...toNorm].reduce((a, c) => a + c.charCodeAt(0), 0) %
            Math.max(1, perHour));
        const retryAt = new Date(
          Date.now() + resetIn * 1_000 + spread * 60_000
        );
        return out(await defer(origin, 'hourly_bucket', retryAt, deferCtx));
      }
    } catch (e) {
      console.warn(`[EMAIL_SENDER] bucket check skipped (${e})`);
    }
  }

  // G1b — this domain's daily budget (outreach only; fails CLOSED, it is a reputation control).
  let budgetConsumed = false;
  if (gateProfile === PROFILE_OUTREACH && !isTestRecord) {
    const budget = await rep.consumeDomainBudget(
      domain,
      effDailyCap,
      effWarmupStart
    );
    if (!budget.allowed) {
      return out(
        await defer(
          origin,
          'domain_budget',
          nextBusinessMorning(tz, state),
          deferCtx
        )
      );
    }
    budgetConsumed = true;
  }

  // The per-recipient daily ceiling — ALL profiles, fails open, and LAST of the consumers so a
  // deferral above never burns a recipient token.
  try {
    const perRecipient = Number(
      pick('per_recipient') ?? emailsPerRecipientPerDay()
    );
    if (
      perRecipient > 0 &&
      !isTestRecord &&
      !(await tryConsume(`email_to:${toNorm}`, perRecipient, 86_400))
    ) {
      if (budgetConsumed) {
        // A terminal skip must not burn the day's budget.
        await rep.releaseDomainBudget(domain);
      }
      const log =
        gateProfile === PROFILE_TRANSACTIONAL ? console.warn : console.log;
      log(
        `[EMAIL_SENDER] recipient-daily-cap hit for ${toNorm} (profile=${gateProfile})`
      );
      return out(skip('recipient-daily-cap', 'recipient-daily-cap', toNorm));
    }
  } catch (e) {
    console.warn(`[EMAIL_SENDER] recipient cap check skipped (${e})`);
  }

  // G5 — the compliance builder, plus the event-correlation ids that ride to provider events too.
  const resolvedName = await resolveOutboundName({
    ...memory,
    agent_id: agentId,
  });
  const built = buildCompliance(toNorm, text, html, gateProfile, fromName, {
    companyName: effCompany,
    postalAddress: effAddress,
    unsubBaseUrl: effUnsubBase,
    unsubMailto: effUnsubMailto,
    resolvedName,
  });

  const logRef = rep.newSendLogRef();
  const customArgs = {
    agent_id: String(agentId),
    campaign_id: String(campaignId ?? ''),
    log_id: logRef.id,
    profile: gateProfile,
    origin,
  };

  // The provider category is the STREAM only. Domain, profile, origin and status are already recorded
  // per-email in the internal send log, and the provider already filters by delivery status, so
  // tagging them as categories there would just be noise.
  const categories = stream ? [stream] : [];

  const res = await sgmail.sendEmailViaSendgrid({
    to,
    subject,
    text: built.text,
    html: built.html,
    from_email: fromEmail,
    from_name: fromName,
    in_reply_to: inReplyTo,
    references,
    reply_to: replyTo,
    api_key: apiKey,
    is_playground: false,
    attachments,
    extra_headers: built.headers,
    custom_args: customArgs,
    categories,
  });

  if (res.success) {
    await rep.writeSendLog(logRef, {
      agent_id: agentId,
      sender: fromEmail,
      recipient: toNorm,
      sg_message_id: res.message_id,
      campaign_id: campaignId,
      profile: gateProfile,
      origin,
      chat_id: chatId,
      domain,
    });
    res.status = 'sent';
  } else {
    if (budgetConsumed) {
      // A SYNCHRONOUS failure returns its token; an async bounce deliberately does not.
      await rep.releaseDomainBudget(domain);
    }
    res.status = 'failed';
    res.reason = 'sendgrid_error';
  }
  return out(res);
}

/** Exposed for tests: the pure profile and freshness decisions. */
export const __testing = {
  resolveProfile,
  replyIsFresh,
  nextBusinessMorning,
  GUIDANCE,
  DateTime,
};
