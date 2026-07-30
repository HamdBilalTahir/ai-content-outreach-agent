/**
 * The generic SendGrid Mail Send helper, plus per-agent SendGrid config resolution.
 *
 * DO NOT CALL `sendEmailViaSendgrid` DIRECTLY. Every outbound email must go through
 * `emailSender.sendEmail`, which is the compliance and suppression choke point. The source guards
 * this with a CI test; the same guard is asserted in this port's suite.
 *
 * ## There is no hardcoded from-address, deliberately
 *
 * The API key and the send-from both come entirely from the agent's connected SendGrid action, with
 * NO env fallback. Outbound runs on a dedicated warming domain: sending from the main domain, or via
 * a shared env key, would burn it. An unconfigured agent gets a refusal rather than a default.
 *
 * ## Tracking is set in the payload, overriding account settings
 *
 *  - **Open tracking ON** — a 1×1 pixel, no link rewriting. Gives open rates in provider stats, with
 *    the usual caveats (Apple MPP inflates, image blockers undercount).
 *  - **Click tracking OFF** — it rewrites every link to a provider redirect domain, which reads as
 *    phishy on cold B2B and hurts deliverability.
 *  - **Subscription tracking OFF** — we own unsubscribe via our own `List-Unsubscribe` header and
 *    CAN-SPAM footer, so the provider's version would be a second, conflicting mechanism.
 */

import { emailSandboxMode } from '../config';
import type { AgentAction } from '../firebase/agent';

export const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

/** SendGrid's own limits on category tags. */
const MAX_CATEGORIES = 10;
const MAX_CATEGORY_LEN = 255;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The per-agent SendGrid configuration, resolved from the connected action.
 *
 * Every `additional_meta` field is per-DOMAIN, because each agent sends from its own domain: the
 * CAN-SPAM footer, the opt-out target, and the reputation posture all have to match the sending
 * domain. Any field left unset here stays `null` and falls back to the matching env var, resolved in
 * `emailSender`.
 */
export interface SendgridConfig {
  api_key: string | null;
  from_email: string | null;
  from_name: string | null;
  /** Route customer replies to a dedicated inbound-parse address instead of the human mailbox. */
  reply_to: string | null;
  company_name: string | null;
  postal_address: string | null;
  unsub_base_url: string | null;
  unsub_mailto: string | null;
  daily_cap: string | number | null;
  warmup_start_date: string | null;
  per_hour: string | number | null;
  per_recipient: string | number | null;
}

const EMPTY_CONFIG: SendgridConfig = {
  api_key: null,
  from_email: null,
  from_name: null,
  reply_to: null,
  company_name: null,
  postal_address: null,
  unsub_base_url: null,
  unsub_mailto: null,
  daily_cap: null,
  warmup_start_date: null,
  per_hour: null,
  per_recipient: null,
};

/**
 * Pull the SendGrid config from the agent's connected action.
 *
 * An action that exists but carries no API key is SKIPPED rather than accepted — the loop keeps
 * looking, because a half-configured action must not shadow a working one.
 */
export function resolveSendgridConfig(
  actions: readonly AgentAction[] | null | undefined
): SendgridConfig {
  for (const action of actions ?? []) {
    if (action.status !== 'active') continue;

    const provider = String(action.provider ?? '').toLowerCase();
    const atype = String(action.type ?? '').toLowerCase();
    if (!provider.includes('sendgrid') && !atype.includes('sendgrid')) continue;

    const auth = (action.auth ?? {}) as Record<string, unknown>;
    const key = auth.api_key ?? auth.apiKey;
    if (!key) continue; // configured later — keep looking

    const meta =
      ((action.additional_meta ?? {}) as Record<string, unknown>) ?? {};
    const pick = (k: string): string | null =>
      meta[k] === null || meta[k] === undefined ? null : String(meta[k]);

    return {
      api_key: String(key),
      from_email: pick('from_email'),
      from_name: pick('from_name'),
      reply_to: pick('reply_to'),
      company_name: pick('company_name'),
      postal_address: pick('postal_address'),
      unsub_base_url: pick('unsub_base_url'),
      unsub_mailto: pick('unsub_mailto'),
      daily_cap: (meta.daily_cap as string | number | undefined) ?? null,
      warmup_start_date: pick('warmup_start_date'),
      per_hour: (meta.per_hour as string | number | undefined) ?? null,
      per_recipient:
        (meta.per_recipient as string | number | undefined) ?? null,
    };
  }
  return { ...EMPTY_CONFIG };
}

/** A SendGrid attachment. `content` is base64. */
export interface SendgridAttachment {
  content: string;
  type?: string;
  filename?: string;
  disposition?: string;
}

export interface SendResult {
  success: boolean;
  skipped: boolean;
  message_id: string | null;
  error: string | null;
  /** Set by the choke point, not here. */
  status?: string;
  reason?: string;
  guidance?: string;
  retry_at?: string;
  message?: string;
  profile?: string;
  origin?: string;
}

export interface SendArgs {
  to: string;
  subject?: string;
  text?: string;
  html?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
  api_key?: string | null;
  is_playground?: boolean;
  attachments?: SendgridAttachment[] | null;
  reply_to?: string | null;
  /** Merged into the payload headers, e.g. `List-Unsubscribe`. */
  extra_headers?: Record<string, string | undefined> | null;
  /** Rides on the personalization so the event webhook can correlate back. */
  custom_args?: Record<string, unknown> | null;
  /** Category tags powering the provider's per-category stats breakdown. */
  categories?: string[] | null;
}

/** Send one email. Best-effort: never throws. */
export async function sendEmailViaSendgrid(
  args: SendArgs
): Promise<SendResult> {
  const {
    to: toRaw,
    subject,
    text,
    html,
    from_email: fromEmail,
    from_name: fromName,
    in_reply_to: inReplyTo,
    references,
    api_key: apiKey,
    is_playground: isPlayground = false,
    attachments,
    reply_to: replyTo,
    extra_headers: extraHeaders,
    custom_args: customArgs,
    categories,
  } = args;

  if (isPlayground) {
    console.log(`[SENDGRID] playground — skipping real send to ${toRaw}`);
    return {
      success: true,
      skipped: true,
      message_id: 'playground',
      error: null,
    };
  }

  if (!apiKey) {
    return {
      success: false,
      skipped: true,
      message_id: null,
      error:
        'SendGrid API key not configured — connect the SendGrid action (auth.api_key)',
    };
  }
  if (!fromEmail) {
    return {
      success: false,
      skipped: true,
      message_id: null,
      error:
        'SendGrid from_email not configured — set additional_meta.from_email on the SendGrid action',
    };
  }

  const to = String(toRaw ?? '').trim();
  if (!to) {
    return {
      success: false,
      skipped: true,
      message_id: null,
      error: 'empty recipient',
    };
  }

  const content: Array<{ type: string; value: string }> = [
    { type: 'text/plain', value: text ?? '' },
  ];
  if (html) content.push({ type: 'text/html', value: html });

  const fromObj: Record<string, string> = { email: fromEmail };
  if (fromName) fromObj.name = fromName;

  const personalization: Record<string, unknown> = { to: [{ email: to }] };
  if (customArgs) {
    personalization.custom_args = Object.fromEntries(
      Object.entries(customArgs).map(([k, v]) => [String(k), String(v)])
    );
  }

  const payload: Record<string, unknown> = {
    personalizations: [personalization],
    from: fromObj,
    subject: subject ?? '',
    content,
  };

  const headers: Record<string, string> = {};
  if (inReplyTo) {
    headers['In-Reply-To'] = inReplyTo;
    headers.References = references ?? inReplyTo;
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v) headers[k] = v;
    }
  }
  if (Object.keys(headers).length > 0) payload.headers = headers;

  if (categories) {
    const cats = categories
      .filter(Boolean)
      .map((c) => String(c).slice(0, MAX_CATEGORY_LEN));
    if (cats.length > 0) payload.categories = cats.slice(0, MAX_CATEGORIES);
  }

  payload.tracking_settings = {
    open_tracking: { enable: true },
    click_tracking: { enable: false, enable_text: false },
    subscription_tracking: { enable: false },
  };

  // A live-API dry run: the provider validates the payload and returns 202 without delivering.
  // Independent of `is_playground`, which skips the API call entirely.
  if (emailSandboxMode()) {
    payload.mail_settings = { sandbox_mode: { enable: true } };
    console.log(
      `[SENDGRID] EMAIL_SANDBOX_MODE — validating without delivery to ${to}`
    );
  }

  if (replyTo) payload.reply_to = { email: replyTo };
  if (attachments) payload.attachments = attachments;

  try {
    const resp = await fetch(SENDGRID_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `[SENDGRID] HTTPError to=${to} status=${resp.status} body=${body.slice(0, 300)}`
      );
      return {
        success: false,
        skipped: false,
        message_id: null,
        error: `sendgrid ${resp.status}: ${body.slice(0, 300)}`,
      };
    }

    const messageId = resp.headers.get('X-Message-Id');
    console.log(
      `[SENDGRID] sent to=${to} status=${resp.status} message_id=${messageId}`
    );
    return {
      success: true,
      skipped: false,
      message_id: messageId,
      error: null,
    };
  } catch (e) {
    console.error(`[SENDGRID] network or unexpected error: ${e}`);
    return {
      success: false,
      skipped: false,
      message_id: null,
      error: `network: ${e}`,
    };
  }
}
