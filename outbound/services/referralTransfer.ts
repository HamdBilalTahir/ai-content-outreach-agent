/**
 * Referral transfer — the person we were reaching is gone or wrong, and the company pointed us to a
 * DIFFERENT person. The outreach moves to a NEW warm chat for the referred person.
 *
 * Distinct from `not_interested`: that is a DECLINE, this is a wrong or departed contact we re-route. The
 * two are easy to conflate and behave very differently — a decline ends the pursuit, a referral continues
 * it against someone else.
 *
 * ## The asymmetry between the two chats is the point
 *
 * The **NEW** chat gets warm referral identity — `referred_by`, a warm `_conversation_summary`, and a
 * rewritten first-touch instruction — plus a `referral` HIGHLIGHT label. That label is for human review
 * and is deliberately NOT a proactive-stop label: comms still go out.
 *
 * The **SOURCE** chat gets ONLY the `referral_transferred` stop label and has its pending tasks
 * cancelled. It gets no referral-identity memory keys at all — those live exclusively on the new chat, so
 * a later reader can never mistake the source for the referred contact. Its stage and opt-out flags are
 * untouched, because a referral says nothing about that person's consent.
 *
 * ## The first-touch rewrite matters
 *
 * Enrollment schedules a task carrying the COLD-pitch instruction. Left alone, the referred contact would
 * get a cold open despite being a warm referral. The task's notes are rewritten in place rather than the
 * task being recreated, so the ≤1-proactive invariant is never disturbed.
 *
 * ## Deferred
 *
 * The CRM contact lookup-or-create arrives with the HubSpot phase. It is best-effort in the source: when
 * it fails, `contact_id` stays null and the transfer proceeds — the new chat is still created, still
 * seeded warm, and still scheduled. So the transfer is complete without it.
 */

import { FieldValue, db } from '../firebase/db';
import { addLabelToChat, getMemory, setMemory } from '../firebase/chat';
import { REFERRAL_TRANSFERRED_LABEL } from './chat';
import { enrollContact } from './enroll';
import { cancelPendingTasks } from './notInterested';

/** The NEW chat's review highlight. NOT a proactive-stop label — comms still go out. */
export const REFERRAL_HIGHLIGHT_LABEL = 'referral';

/**
 * The referred person, as the review tools surface them.
 *
 * Keys come in two spellings, and every field is nullable as well as optional: the LLM classifiers
 * return explicit `null` for a detail they did not find, so a signal object arrives with nulls rather
 * than absent keys. `pick` treats both identically.
 */
export interface ReferredPerson {
  email?: string | null;
  referred_email?: string | null;
  phone?: string | null;
  referred_phone?: string | null;
  first_name?: string | null;
  referred_first_name?: string | null;
  last_name?: string | null;
  referred_last_name?: string | null;
  title?: string | null;
  referred_title?: string | null;
  [k: string]: unknown;
}

/** First non-empty value across the accepted key spellings. */
function pick(
  referred: ReferredPerson | null | undefined,
  ...keys: string[]
): string {
  for (const k of keys) {
    const v = (referred ?? {})[k];
    if (v) return String(v).trim();
  }
  return '';
}

/** ` at Acme`, unless the referrer label already names the company — avoids doubling it. */
function atCompany(company: string, referrerLabel: string): string {
  return company && !(referrerLabel ?? '').includes(company)
    ? ` at ${company}`
    : '';
}

function warmSummary(
  referrerLabel: string,
  company: string,
  title: string
): string {
  const asTitle = title ? ` as the ${title}` : '';
  return (
    `No prior conversation with this contact. ${referrerLabel} pointed us to them${asTitle}` +
    `${atCompany(company, referrerLabel)}. Treat as a WARM referral — open by referencing the referral, ` +
    `not a cold intro.`
  );
}

function warmOutreachNotes(
  referrerLabel: string,
  company: string,
  title: string
): string {
  const asTitle = title ? ` (the ${title})` : '';
  return (
    `WARM REFERRAL first touch${atCompany(company, referrerLabel)}: ${referrerLabel} pointed us to this ` +
    `contact${asTitle}. Open warm by referencing the referral — do NOT use the cold-pitch opener. ` +
    `Then give the value prop and one demo ask. Reach out on the channel(s) on file.`
  );
}

export interface ReferralResult {
  ok: boolean;
  error?: string;
  new_chat_id?: string;
  contact_id?: string | null;
  created_contact?: boolean;
  campaign_id?: string | null;
  source_chat_id?: string;
}

/**
 * Move outreach from a wrong or departed contact to a NEW warm chat for the referred person.
 *
 * Best-effort throughout: every side effect is independently wrapped, so one failure never blocks the
 * rest. The two hard preconditions — a reachable channel for the referred person, and an agent on the
 * source chat — return early, because without either there is nothing to transfer TO.
 */
export async function handleReferralTransfer(
  sourceChatId: string,
  referred: ReferredPerson | null | undefined,
  referrer?: string | null,
  source = 'review'
): Promise<ReferralResult> {
  if (!sourceChatId || !referred || typeof referred !== 'object') {
    return { ok: false, error: 'bad args' };
  }

  const email = pick(referred, 'email', 'referred_email').toLowerCase();
  const phone = pick(referred, 'phone', 'referred_phone');
  const first = pick(referred, 'first_name', 'referred_first_name');
  const last = pick(referred, 'last_name', 'referred_last_name');
  const title = pick(referred, 'title', 'referred_title');

  if (!email && !phone) {
    return { ok: false, error: 'no email or phone for referred person' };
  }

  const src = (await getMemory(sourceChatId)) ?? {};
  const agentId = src.agent_id;
  if (!agentId) return { ok: false, error: 'source chat has no agent_id' };

  const company = String(src.company ?? '');
  const campaignId = (src.campaign_id as string | undefined) ?? null;
  const dealersId = src.dealers_id;
  const companyId = src.company_id;
  const recordType = String(src.record_type ?? 'Real');

  const referrerLabel =
    String(referrer ?? '').trim() ||
    (company ? `your team at ${company}` : 'your team');

  // The CRM lookup-or-create arrives with the HubSpot phase. Until then the transfer proceeds with no
  // contact id, exactly as the source does when the lookup fails.
  const contactId: string | null = null;
  const createdContact = false;

  // Create the new chat in the SAME campaign, so it inherits the campaign's pacing and gates.
  const lead = {
    contact_information: {
      email,
      phone_number: phone,
      first_name: first,
      last_name: last,
    },
    input_data: {
      agent_id: String(agentId),
      company,
      dealers_id: dealersId,
      company_id: companyId,
      record_type: recordType,
      hubspot_contact_id: contactId,
      referred_by: referrerLabel,
      referral_title: title,
      referral_source_chat: sourceChatId,
    },
  };

  let res;
  try {
    res = await enrollContact(lead, { campaignId });
  } catch (e) {
    console.error(
      `[REFERRAL] enrollContact failed for source=${sourceChatId}: ${e}`
    );
    return { ok: false, error: `enroll failed: ${e}`, contact_id: contactId };
  }

  const newChatId = res?.chat_id;
  if (!newChatId) {
    return {
      ok: false,
      error: `enroll returned no chat_id: ${JSON.stringify(res)}`,
      contact_id: contactId,
    };
  }

  // Warm identity and context — on the NEW chat only.
  try {
    await setMemory(newChatId, {
      referred_by: referrerLabel,
      referral_title: title,
      _is_referral: true,
      _referred_from_chat_id: sourceChatId,
      _conversation_summary: warmSummary(referrerLabel, company, title),
      _conversation_summary_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[REFERRAL] warm memory seed failed for ${newChatId}: ${e}`);
  }

  // Rewrite the first-touch notes in place, so the referred contact does not get a cold open. Updating
  // the existing task rather than recreating it keeps the ≤1-proactive invariant intact.
  const taskId = res?.task_id;
  if (taskId) {
    try {
      await db
        .collection('chats')
        .doc(newChatId)
        .collection('tasks')
        .doc(taskId)
        .update({
          'data.notes': warmOutreachNotes(referrerLabel, company, title),
          updated_at: FieldValue.serverTimestamp(),
        });
    } catch (e) {
      console.warn(
        `[REFERRAL] warm task-notes rewrite failed for ${newChatId}: ${e}`
      );
    }
  }

  // Highlight the new chat for review. Comms still go out — this is not a gate.
  try {
    await addLabelToChat(newChatId, REFERRAL_HIGHLIGHT_LABEL);
  } catch (e) {
    console.warn(`[REFERRAL] highlight label failed for ${newChatId}: ${e}`);
  }

  // Stop and label the SOURCE chat. Only the stop label — no referral-identity keys, and stage and
  // opt-outs untouched.
  try {
    await addLabelToChat(sourceChatId, REFERRAL_TRANSFERRED_LABEL);
    await cancelPendingTasks(sourceChatId);
  } catch (e) {
    console.warn(
      `[REFERRAL] source-chat stop/label failed for ${sourceChatId}: ${e}`
    );
  }

  console.log(
    `[REFERRAL] ${sourceChatId} → new chat ${newChatId} (contact=${contactId}, ` +
      `created=${createdContact}, campaign=${campaignId}, source=${source})`
  );
  return {
    ok: true,
    new_chat_id: newChatId,
    contact_id: contactId,
    created_contact: createdContact,
    campaign_id: campaignId,
    source_chat_id: sourceChatId,
  };
}

/** Exposed for tests: the pure copy builders. */
export const __testing = { warmSummary, warmOutreachNotes, atCompany, pick };
