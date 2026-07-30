/**
 * Per-contact enrollment — the single entry point into the outbound flow.
 *
 * `enrollContact` creates or dedupes the `type: "outbound"` chat, seeds memory, applies every
 * consent gate, resolves the outreach lane, sets stage `New`, and schedules the channel-neutral
 * `outbound_outreach` task. Two callers:
 *  - the intake webhook — `executeAt` omitted, so it computes its own immediate-ish time;
 *  - the campaign engine — a **staggered** `executeAt` paced by the campaign, plus a `campaignId`.
 *
 * ## The gate order is load-bearing
 *
 * Enrollment applies four independent phone gates, and the order matters because each one can make
 * the next unnecessary:
 *  1. **Intake flags** — a testing affordance so the front end can seed opt-outs directly.
 *  2. **The area-code registry gate** — a phone whose NANP area code is not in our DNC-scrubbable
 *     registry cannot be lawfully auto-called. This also SKIPS the DNC scrub entirely, because
 *     DNCScrub would false-clean an un-subscribed area code — there is no point paying for the call.
 *  3. **The DNC Full Scrub** — only reached when the area code is scrubbable.
 *  4. The union of the three decides `phone_opt_out`.
 *
 * ## Opt-outs are SET-ONLY
 *
 * Re-enrolling a chat never writes `false` to an opt-out key. A contact who unsubscribed during a
 * previous campaign must not be reset to reachable by being re-enrolled in a new one. Chat creation
 * already seeded both keys `false`, so absence here means "leave whatever is there".
 *
 * ## Enrollment is not contact
 *
 * The contacted marker is deliberately NOT stamped here — only `markContacted` sets it, when the
 * agent actually reaches out. So a contact enrolled into a campaign that ended before outreach
 * happened stays unmarked and is re-selectable by a later campaign.
 *
 * ## Deferred: the HubSpot stamps
 *
 * The source makes five best-effort HubSpot calls from `enrollContact` (`ensure_meeting_host`, the
 * CNAM number-type stamp, the campaign attribution stamp, and `sync_hubspot_stage`) and one from
 * `markContacted` (`stamp_contact_contacted`). Every one is CRM *mirroring* wrapped in its own
 * try/except: none affects the enrollment outcome. They arrive with the HubSpot phase; the
 * enrollment logic here is complete without them.
 */

import { DateTime } from 'luxon';

import { FieldValue, db } from '../firebase/db';
import {
  addLabelToChat,
  createTaskWithId,
  getMemory,
  setMemory,
} from '../firebase/chat';
import { getAgent } from '../firebase/agent';
import { setProspectStage } from '../firebase/prospect';
import { testPhoneFirstEnabled } from '../config';
import { areaCodeOf, isAreaCodeAllowed } from './dncAreaCodes';
import { screenPhoneAtEnroll } from './phoneScreening';
import {
  enforceSingleProactiveTask,
  nextBusinessHoursStart,
} from './scheduling';
import {
  getStateForPhone,
  getStateForZip,
  getTimezoneForPhone,
  getTimezoneForZip,
} from '../utils/timezoneLookup';
import * as svc from './chat';
import type { ChatMemory, OutreachLane } from '../types';

const OUTREACH_NOTES =
  'Begin outbound outreach for this prospect. Follow your outbound skill for channel ' +
  'choice, sequence, and follow-ups.';

/** The lead shape both callers pass. */
export interface Lead {
  contact_information?: Record<string, unknown> | null;
  input_data?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface EnrollResult {
  success: boolean;
  error?: string;
  chat_id?: string;
  task_id?: string | null;
  channel_key?: string;
  /** `false` when a phone/email COLLISION reused an existing chat rather than creating one. */
  created?: boolean;
  skipped?: boolean;
  no_task?: boolean;
  reason?: string;
}

/**
 * `(state, timezone)` for a lead — explicit values on the input first, then derived from the ZIP,
 * then from the phone area code. Shared by enrollment and the campaign pacer, which needs the
 * per-contact timezone to stagger correctly. Best-effort: `[null, null]` on any failure.
 */
export function resolveLocation(
  phone: string | null | undefined,
  data: Record<string, unknown> | null | undefined
): [string | null, string | null] {
  try {
    const d = data ?? {};
    const zip = d.zip ?? d.zip_code ?? d.postal_code;
    const digits = String(phone ?? '').replace(/\D/g, '');

    const state =
      d.state ??
      (zip ? getStateForZip(zip) : null) ??
      (digits ? getStateForPhone(digits) : null);
    const timezone =
      d.timezone ??
      (zip ? getTimezoneForZip(zip) : null) ??
      (digits ? getTimezoneForPhone(digits) : null);

    return [
      state ? String(state).toUpperCase() : null,
      timezone ? String(timezone) : null,
    ];
  } catch (e) {
    console.warn(`[OB_ENROLL] location resolution failed: ${e}`);
    return [null, null];
  }
}

/** Any affirmative form of an opt-out value, across every spelling the front end sends. */
function isAffirmative(...vals: unknown[]): boolean {
  return vals.some(
    (v) =>
      v === true ||
      ['y', 'yes', 'true', '1'].includes(
        String(v ?? '')
          .trim()
          .toLowerCase()
      )
  );
}

export interface EnrollOptions {
  executeAt?: Date | null;
  campaignId?: string | null;
  /** Campaign path: skip a contact already enrolled, the cross-campaign dedup guard. */
  skipIfContacted?: boolean;
  /**
   * The registered-non-expired NANP set, passed by the campaign batch so the area-code gate does not
   * read Firestore once per record. `null` falls back to a single-document read.
   */
  allowedAreaCodes?: ReadonlySet<string> | null;
  businessOnly?: boolean;
  campaignStartMs?: number | null;
  /**
   * The email verified undeliverable. Enroll anyway on the PHONE lane and close the email channel —
   * a valid phone still keeps the contact reachable.
   */
  emailInvalid?: boolean;
}

/** Enroll one contact into the outbound flow. */
export async function enrollContact(
  lead: Lead,
  opts: EnrollOptions = {}
): Promise<EnrollResult> {
  const {
    executeAt: executeAtIn = null,
    campaignId = null,
    skipIfContacted = false,
    allowedAreaCodes = null,
    businessOnly = false,
    emailInvalid: emailInvalidIn = false,
  } = opts;

  const contact = (lead.contact_information ?? {}) as Record<string, unknown>;
  const data = (lead.input_data ?? {}) as Record<string, unknown>;

  const agentId = String(data.agent_id ?? lead.agent_id ?? '');
  if (!agentId) {
    return {
      success: false,
      error: 'agent_id is required (input_data.agent_id)',
    };
  }

  const email = String(contact.email ?? '')
    .trim()
    .toLowerCase();
  const phone = String(contact.phone_number ?? '').trim();
  if (!email && !phone) {
    return { success: false, error: 'lead needs an email or phone_number' };
  }

  // Phone-first: the chat key is what the deterministic doc id collapses on.
  const chatKey = phone || email;
  const dealersId = data.dealers_id ?? data.dealer_id;
  const { chatId, created } = await svc.getOrCreateOutboundChat(
    agentId,
    chatKey,
    String(contact.first_name ?? ''),
    dealersId ? String(dealersId) : null
  );
  await svc.setChatType(chatId, 'outbound');

  // The enrollment dedup guard (campaign path only; single-lead intake keeps enrolling unchanged).
  if (skipIfContacted) {
    try {
      const prior = (await getMemory(chatId)) ?? {};
      // (a) Already actually contacted → never re-dial.
      if (await svc.contactedMarkerValue(prior)) {
        console.log(`[OB_ENROLL] skip ${chatId}: already contacted (dedup)`);
        return {
          success: true,
          skipped: true,
          chat_id: chatId,
          created,
          reason: 'already_contacted',
          channel_key: chatKey,
        };
      }
      // (b) Still pending in a DIFFERENT campaign that is STILL ACTIVE → do not double-enroll. A
      //     paused/stopped/done campaign is not active, so re-enrolling from it is allowed.
      const priorCampaign = prior.campaign_id;
      if (priorCampaign && String(priorCampaign) !== String(campaignId ?? '')) {
        const { isCampaignActive } = await import('./campaigns');
        if (await isCampaignActive(String(priorCampaign))) {
          console.log(
            `[OB_ENROLL] skip ${chatId}: pending in active campaign ${String(priorCampaign)}`
          );
          return {
            success: true,
            skipped: true,
            chat_id: chatId,
            created,
            reason: 'pending_in_active_campaign',
            channel_key: chatKey,
          };
        }
      }
    } catch (e) {
      console.warn(`[OB_ENROLL] dedup check failed for ${chatId}: ${e}`);
    }
  }

  const recordType = String(data.record_type ?? 'Real');

  /** Read a flag from ANY payload level — the front end sends it at whichever one. First truthy wins. */
  const flag = (...keys: string[]): boolean =>
    isAffirmative(...keys.flatMap((k) => [lead[k], data[k], contact[k]]));

  let phoneOptIntake = flag('phone_opt_out', 'block_phone');
  const smsOpt = flag('sms_opt_out');
  let emailOpt = flag('email_opt_out', '_email_opt_out');

  // Store the phone digits-only, matching the shape the rest of the flow reads. The call path re-adds
  // E.164 at dial time. `chatKey` stays raw so the doc id is stable.
  const phoneDigits = phone.replace(/\D/g, '');

  // Resolve the persona name from the agent doc and seed it, so every customer- and CRM-visible
  // surface renders the right name with no hardcoded literal.
  let salesAgentName: string;
  try {
    const agentData = (await getAgent(agentId)) ?? {};
    salesAgentName = await svc.resolveOutboundName(null, agentData);
  } catch (e) {
    console.warn(
      `[OB ENROLL] sales_agent_name resolve failed for agent ${agentId}: ${e}`
    );
    salesAgentName = await svc.resolveOutboundName();
  }

  const memory: ChatMemory = {
    customer_email: email,
    phone_number: phoneDigits || phone,
    first_name: String(contact.first_name ?? ''),
    last_name: String(contact.last_name ?? ''),
    company: String(data.company ?? ''),
    agent_id: agentId,
    sales_agent_name: salesAgentName,
    record_type: recordType,
    _ob_state: 'new',
  };

  // Seed canonical opt-out flags only when opted out — absence means reachable.
  if (phoneOptIntake) memory.phone_opt_out = 'Y';
  if (smsOpt) memory.sms_opt_out = 'Y';
  if (emailOpt) memory._email_opt_out = true;
  if (emailInvalidIn) memory._email_invalid = true;
  if (dealersId) memory.dealers_id = String(dealersId);
  if (campaignId) memory.campaign_id = String(campaignId);
  // Business numbers do not require PEWC consent, so suppress the consent-ask entirely.
  if (businessOnly) memory.business_only = true;

  // Link an EXISTING HubSpot contact when the lead carries its id, so the CRM sync does not have to
  // rely on an email match for a contact with a blank or duplicated address.
  if (data.hubspot_contact_id) {
    memory.hubspot_contact_id = String(data.hubspot_contact_id);
  }

  // Cache the prospect's state/timezone so the business-hours guard schedules in their local time.
  const [state, timezone] = resolveLocation(phone, data);
  if (state) memory.state = state;
  if (timezone) memory.timezone = timezone;

  // Copy through any remaining input fields. `_`-prefixed keys are skipped so a webhook payload can
  // never spoof a code-owned internal marker.
  for (const [k, v] of Object.entries(data)) {
    if (k === 'agent_id' || k.startsWith('_')) continue;
    if (!(k in memory)) memory[k] = v;
  }
  await setMemory(chatId, memory);

  // The area-code compliance gate. A phone whose NANP area code is not in our DNC-scrubbable registry
  // cannot lawfully be auto-called, so opt the phone out AND skip the scrub — DNCScrub would
  // false-clean an un-subscribed area code, so paying for the call buys nothing. Test records bypass,
  // because synthetic E2E numbers are not in the registry.
  let areaCodeOptout = false;
  if (phone && recordType !== 'Test') {
    const ac = areaCodeOf(phone);
    const acOk =
      allowedAreaCodes !== null && allowedAreaCodes !== undefined
        ? Boolean(ac) && allowedAreaCodes.has(ac)
        : await isAreaCodeAllowed(ac);
    if (!acOk) {
      areaCodeOptout = true;
      // No callable phone AND no email → nothing reachable → no task will be scheduled.
      if (!email) emailOpt = true;
      try {
        await setMemory(chatId, {
          _phone_optout_reason: 'area_code_unscrubbable',
        });
        await addLabelToChat(chatId, 'area_code_unscrubbable');
      } catch {
        // Cosmetic; the gate itself is the opt-out flag written below.
      }
      console.log(
        `[OB_ENROLL] ${chatId}: area code ${ac || '?'} not DNC-scrubbable — phone opted out, ` +
          `DNC scrub skipped${!email ? ' (+ email opt-out, no channel)' : ''}.`
      );
    }
  }

  // The DNC scrub, reached only when the area code is scrubbable.
  let dncPhoneOpt = false;
  if (!areaCodeOptout) {
    const websiteVerified = ['true', 'yes', '1', 'y'].includes(
      String(data.website_verified_business ?? '')
        .trim()
        .toLowerCase()
    );
    dncPhoneOpt = await screenPhoneAtEnroll(chatId, phone, agentId, {
      recordType,
      companyId: String(data.company_id ?? ''),
      businessOnly,
      websiteVerified,
    });
  }

  const phoneOptFinal = phoneOptIntake || dncPhoneOpt || areaCodeOptout;
  if (phoneOptFinal) {
    // A memory copy too, for the prompt's availability block.
    try {
      await setMemory(chatId, { phone_opt_out: 'Y' });
    } catch {
      // The top-level key written below is the gate; this is presentation only.
    }
  }
  if (areaCodeOptout && emailOpt) {
    try {
      await setMemory(chatId, { _email_opt_out: true });
    } catch {
      // As above.
    }
  }
  phoneOptIntake = phoneOptFinal; // keep the local name honest for the lane computation below

  // The trustworthy top-level gate keys, plus the durable record_type/campaign copy.
  //
  // Also REACTIVATE from ARCHIVED only: a re-enrolled previously-archived chat (from a stopped
  // campaign) must fire again. A PAUSED chat is deliberately NOT reactivated — a manual or campaign
  // pause has to survive re-enrollment, with its tasks staying frozen until explicitly resumed.
  try {
    const cur = await db.collection('chats').doc(chatId).get();
    const curStatus = cur.exists ? (cur.data() ?? {}).status : null;
    const top: Record<string, unknown> = { record_type: recordType };
    if (curStatus !== 'paused') {
      top.status = 'active';
      top.archived = false;
      top.archive_reason = null;
      top.status_changed_at = new Date().toISOString();
    }
    if (campaignId) top.campaign_id = String(campaignId);
    // SET-ONLY: never write `false` here, so an existing opt-out is not cleared on re-enroll.
    if (emailOpt) top.email_opt_out = true;
    if (emailInvalidIn) top.email_invalid = true;
    if (phoneOptFinal) top.phone_opt_out = true;
    if (smsOpt) top.sms_opt_out = true;
    await db.collection('chats').doc(chatId).set(top, { merge: true });
  } catch (e) {
    console.warn(`[OB_ENROLL] top-level gate write failed for ${chatId}: ${e}`);
  }

  await setProspectStage(
    chatId,
    'New',
    'initiate_outbound',
    dealersId ? String(dealersId) : null,
    String(data.company_id ?? '')
  );

  // No reachable channel → the chat and its CRM record still exist, but there is nothing for the
  // agent to do, so schedule NO outreach task. Reads the freshly-written top-level keys via the
  // shared gate, so it also sees any pre-existing opt-out from a re-enroll.
  const reachDoc = await svc.loadChatDoc(chatId);
  if (reachDoc && !svc.hasReachableChannel(reachDoc)) {
    console.log(
      `[OB_ENROLL] ${chatId}: no reachable channel ` +
        `(phone_opt=${phoneOptFinal}, email_opt=${emailOpt}) — chat created, NO task scheduled.`
    );
    try {
      await setMemory(chatId, { _no_reachable_channel: true });
    } catch {
      // Informational marker only.
    }
    return {
      success: true,
      chat_id: chatId,
      task_id: null,
      created,
      channel_key: chatKey,
      no_task: true,
      reason: 'no_reachable_channel',
    };
  }

  // The outreach LANE — authoritative, computed after the DNC screen. `phone` iff a phone is on file,
  // not opted out, and it survived both the area-code and DNC gates; everything else reachable is
  // `email`. Drives call-only enforcement downstream, so it goes on the trustworthy top level.
  const memNow = (reachDoc.memory ?? {}) as ChatMemory;
  const phoneReachable =
    Boolean(String(memNow.phone_number ?? '').trim()) &&
    !svc.phoneOptedOut(reachDoc);
  const emailReachable =
    Boolean(String(memNow.customer_email ?? memNow.email ?? '').trim()) &&
    !svc.emailOptedOut(reachDoc) &&
    !svc.emailInvalid(reachDoc);
  const isTest = recordType.trim().toLowerCase() === 'test';

  // A TEST record with BOTH channels reachable additionally gets an EMAIL FALLBACK held in reserve:
  // the phone cadence runs first, and only if it is exhausted with no engagement does the lane flip.
  // Real records keep the fixed single lane with no fallback.
  const emailFallback =
    testPhoneFirstEnabled() && isTest && phoneReachable && emailReachable;
  const lane: OutreachLane = phoneReachable ? 'phone' : 'email';

  try {
    const docUpdates: Record<string, unknown> = { outreach_lane: lane };
    const memUpdates: ChatMemory = { _outreach_lane: lane };
    if (emailFallback) {
      docUpdates.email_fallback_available = true;
      memUpdates._email_fallback_available = true;
    }
    await db.collection('chats').doc(chatId).set(docUpdates, { merge: true });
    await setMemory(chatId, memUpdates);
  } catch (e) {
    console.warn(`[OB_ENROLL] outreach_lane write failed for ${chatId}: ${e}`);
  }

  // Direct (non-campaign) enroll timing. TEST fires ASAP; the phone lane fires TODAY inside business
  // hours (concurrency is the throttle, no per-day stagger); the email lane keeps the immediate
  // default. A campaign enroll always passes an explicit per-lane time, so this only affects intake.
  let executeAt = executeAtIn;
  if (executeAt === null || executeAt === undefined) {
    if (isTest) {
      executeAt = new Date();
    } else if (lane === 'phone') {
      executeAt = await nextBusinessHoursStart(
        memNow.timezone,
        memNow.state,
        chatId
      );
    } else {
      executeAt = new Date(Date.now() + 30_000);
    }
  }

  const taskData: Record<string, unknown> = {
    task_type: 'outbound_outreach',
    agent_id: agentId,
    // Channel-neutral: the outbound SKILL owns channel choice, sequence, and follow-ups.
    notes: OUTREACH_NOTES,
  };
  if (campaignId) taskData.campaign_id = String(campaignId);

  const taskId = await createTaskWithId(
    chatId,
    'outbound_outreach',
    executeAt,
    taskData
  );
  // INVARIANT: ≤1 pending proactive task. This fresh first touch is the only one that should be
  // queued, so it collapses any stale outreach or follow-up left by a re-enroll.
  await enforceSingleProactiveTask(chatId, taskId);

  return {
    success: true,
    chat_id: chatId,
    task_id: taskId,
    channel_key: chatKey,
    created,
  };
}

/**
 * Mark a chat as ACTUALLY contacted — called when the first outreach goes out.
 *
 * Sets the name-derived memory marker that powers the enrollment skip-guard. This is the ONLY place
 * the contacted marker is set: enrollment alone does not mark a contact, which is what keeps a
 * never-outreached contact re-selectable by a later campaign.
 *
 * Idempotent (it checks both the name-derived and legacy keys) and best-effort. The HubSpot
 * `stamp_contact_contacted` call arrives with the HubSpot phase.
 */
export async function markContacted(
  chatId: string,
  agentId?: string | null
): Promise<void> {
  if (!chatId) return;
  try {
    const mem = (await getMemory(chatId)) ?? {};
    if (await svc.contactedMarkerValue(mem)) return; // already marked
    const markerKey = svc.contactedMarkerKey(
      await svc.resolveOutboundName(mem)
    );
    await setMemory(chatId, { [markerKey]: new Date().toISOString() });
    void (agentId ?? mem.agent_id);
  } catch (e) {
    console.warn(`[OB_ENROLL] markContacted failed for ${chatId}: ${e}`);
  }
}

/** Exposed for the campaign pacer, which needs the same UTC-now semantics. */
export function nowUtc(): Date {
  return DateTime.utc().toJSDate();
}

/** Re-exported so callers do not need the Firestore sentinel import. */
export { FieldValue };
