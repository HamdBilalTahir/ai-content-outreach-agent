/**
 * Referral transfer — the person we were reaching is gone or wrong, and the call pointed us at a
 * DIFFERENT person. Outreach FORKS to a new warm chat, and the source chat is hard-stopped.
 *
 * Distinct from `not_interested`: that is a DECLINE, this is a wrong or departed contact we re-route. The
 * two are easy to conflate and behave very differently — a decline ends the pursuit, a referral continues
 * it against someone else.
 *
 * ## The asymmetry between the two chats is the point
 *
 * The **NEW** chat gets warm referral identity — `referred_by`, a warm `_conversation_summary`, and a
 * rewritten first-touch instruction — plus a `referral` HIGHLIGHT label. That label is for human review
 * and is deliberately NOT a proactive-stop label: comms still go out. It also gets the referrer's prior
 * call cards seeded in as clearly-tagged background, and a top-level `referrer_chat_id` pointer.
 *
 * The **SOURCE** chat is HARD-STOPPED: both opt-outs set, pending tasks cancelled, and the chat archived
 * with an `archive_reason`. We have re-pointed outreach at the real person, so the wrong-name chat must
 * never be dialed or emailed again. It gets no referral-identity memory keys at all — those live
 * exclusively on the new chat, so a later reader can never mistake the source for the referred contact.
 *
 * ## Two ways to create the new chat
 *
 * **Same-line** (`forceSameLine`) — the referred person is reachable at the number we just dialed: a
 * different person at THIS dealership, or the buyer who personally answered. A phone-keyed chat id would
 * collide with the source's, so the chat is created directly under a CUSTOM id and the enroll tail is
 * mirrored inline. It carries the SOURCE's `userId` so an inbound call or reply from the line resolves to
 * this active chat rather than the archived source — see `resolveActiveOutboundChat`.
 *
 * **Normal** — the referred person has their own email or phone, so ordinary enrollment applies and the
 * first-touch task's notes are rewritten in place (recreating the task would disturb the ≤1-proactive
 * invariant).
 *
 * ## The deterministic key gate is a backstop, not a formality
 *
 * A fork is expensive and hard to reverse. Before creating anything we require a name AND a company AND a
 * reachable channel. A name-only referral to someone at a DIFFERENT store ("Andre, over at the Ford
 * store") has no reachable contact, so it must FAIL rather than fork onto the wrong line. The caller keeps
 * the source as-is and a later call can resolve it properly.
 */

import { FieldValue, db, toDate } from '../firebase/db';
import {
  addLabelToChat,
  createTaskWithId,
  getMemory,
  setMemory,
} from '../firebase/chat';
import { getAgentActions } from '../firebase/agent';
import { setProspectStage } from '../firebase/prospect';
import { nameSlug } from './chat';
import { enrollContact } from './enroll';
import {
  accessToken,
  createContact,
  findExistingContact,
  resolveHubspotConfig,
} from './hubspot';
import { cancelPendingTasks } from './notInterested';
import {
  enforceSingleProactiveTask,
  nextBusinessHoursStart,
} from './scheduling';

/** The NEW chat's review highlight. NOT a proactive-stop label — comms still go out. */
export const REFERRAL_HIGHLIGHT_LABEL = 'referral';

function digits(s: unknown): string {
  return String(s ?? '').replace(/\D/g, '');
}

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
  company?: string | null;
  referred_company?: string | null;
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

/**
 * Fully stop the source chat once outreach is re-pointed at a new person.
 *
 * BOTH opt-outs (chat-doc top level — that is what the deterministic gates read), pending tasks
 * cancelled, and the chat ARCHIVED so the cron skips it. `archiveReason` distinguishes the sub-case
 * (`identity_mismatch` for a wrong-company fork, `moved_employer`, …). Best-effort.
 */
async function hardStopSource(
  sourceChatId: string,
  newChatId: string,
  archiveReason = 'referred_to_new_contact'
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await db.collection('chats').doc(sourceChatId).set(
      {
        phone_opt_out: true,
        email_opt_out: true,
        archived: true,
        status: 'archived',
        archive_reason: archiveReason,
        archived_at: now,
        status_changed_at: now,
        _referred_to_chat: newChatId,
      },
      { merge: true }
    );
    await setMemory(sourceChatId, {
      phone_opt_out: 'Y',
      _email_opt_out: true,
      _referred_to_chat: newChatId,
    });
    await cancelPendingTasks(sourceChatId);
  } catch (e) {
    console.warn(`[REFERRAL] hard-stop of source ${sourceChatId} failed: ${e}`);
  }
}

/**
 * Load the referrer (source) chat's context INTO the forked chat, FIRST, as clearly-labeled background —
 * never as the new chat's own back-and-forth.
 *
 * Copies the source's `messages_v3` CALL cards (each carries a `callId`, from which the frontend renders
 * the call's summary, audio, and transcript) tagged `kind: 'referrer_context'`, preceded by one intro
 * note. Also carries the source's `_conversation_summary` across as `_referrer_conversation_summary`.
 * Best-effort; returns the number of cards copied.
 *
 * Called for EVERY fork, so a re-homed chat always opens with its prior context.
 *
 * **Chronological ordering diverges in mechanism, not intent.** The source sorts on `str(timestamp)`,
 * which works in Python because a Firestore datetime stringifies to an ISO-ish form. In JS
 * `String(Timestamp)` is `[object Object]` for every card, so that sort would compare all keys equal and
 * degrade to stream order. Sorting on the coerced epoch preserves what the source achieves.
 */
export async function seedReferrerContext(
  newChatId: string,
  sourceChatId: string
): Promise<number> {
  let copied = 0;
  try {
    const srcRef = db.collection('chats').doc(sourceChatId);
    const newCol = db
      .collection('chats')
      .doc(newChatId)
      .collection('messages_v3');
    const snap = await srcRef.collection('messages_v3').get();
    const cards = snap.docs
      .map((d) => (d.data() ?? {}) as Record<string, unknown>)
      .filter(
        (c) =>
          c.type === 'call' &&
          ((c.content ?? {}) as Record<string, unknown>).callId
      );
    if (cards.length === 0) return 0;

    cards.sort(
      (a, b) =>
        (toDate(a.timestamp)?.getTime() ?? 0) -
        (toDate(b.timestamp)?.getTime() ?? 0)
    );

    // Intro header, timestamped just before the first card so the whole block sits at the TOP.
    const firstTs = toDate(cards[0].timestamp);
    const hdrTs = firstTs ? new Date(firstTs.getTime() - 1000) : new Date();
    await newCol.doc().set({
      timestamp: hdrTs,
      direction: 'internal',
      source: 'virtuans',
      type: 'text',
      status: 'delivered',
      sender: { kind: 'ai' },
      recipient: 'admin',
      kind: 'referrer_context',
      content: {
        kind: 'referrer_context',
        body:
          `CONTEXT FROM PRIOR CHAT (${sourceChatId}) — the earlier call history that led here. ` +
          `Background only; this is NOT this chat's own conversation.`,
      },
      attachments: [],
    });

    for (const md of cards) {
      const doc = { ...md };
      doc.kind = 'referrer_context';
      const content = { ...((doc.content ?? {}) as Record<string, unknown>) };
      content.kind = 'referrer_context';
      doc.content = content;
      await newCol.doc().set(doc);
      copied += 1;
    }

    try {
      const srcSummary = ((await getMemory(sourceChatId)) ?? {})
        ._conversation_summary;
      if (srcSummary) {
        await setMemory(newChatId, {
          _referrer_conversation_summary: srcSummary,
        });
      }
    } catch {
      // Best-effort: the cards are the substance, the summary is a bonus.
    }
    console.log(
      `[REFERRAL] seeded ${copied} referrer call card(s) ${sourceChatId} → ${newChatId}`
    );
  } catch (e) {
    console.warn(
      `[REFERRAL] seedReferrerContext failed ${sourceChatId}→${newChatId}: ${e}`
    );
  }
  return copied;
}

/**
 * Create a new outbound chat under a CUSTOM doc id, for a referred person who shares the source's line.
 *
 * A phone-keyed id would collide with the source chat, so this mirrors `getOrCreateOutboundChat`'s field
 * set plus the enroll tail — seed memory, stage New, one warm first-touch task — rather than routing
 * through enrollment. Returns the task id.
 *
 * `userKey` (the SOURCE chat's `userId`) becomes this chat's `userId`, so an INBOUND call or reply from
 * the number resolves to THIS active chat via `resolveActiveOutboundChat`, not the archived source.
 */
async function createSameLineChat(
  newChatId: string,
  agentId: string,
  phone: string | null | undefined,
  identity: Record<string, unknown>,
  extraMemory: Record<string, unknown>,
  campaignId: string | null,
  dealersId: unknown,
  companyId: unknown,
  warmNotes: string,
  userKey?: string | null
): Promise<string | null> {
  const uid = userKey || phone;
  const ref = db.collection('chats').doc(newChatId);
  await ref.set({
    agentId,
    userId: uid,
    attendee_id: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    company_id: companyId || '',
    status: 'active',
    // TOP-LEVEL campaign_id: the campaign UI lists contacts by this field, so a same-line fork must carry
    // it here (not only in memory) or it is invisible in the campaign view it belongs to.
    ...(campaignId ? { campaign_id: String(campaignId) } : {}),
    status_changed_at: new Date().toISOString(),
    playground: false,
    channel: 'email',
    type: 'outbound',
    email_opt_out: false,
    phone_opt_out: false,
    ...(dealersId
      ? { dealer_id: String(dealersId), dealers_id: String(dealersId) }
      : {}),
    memory: {},
  });

  await setMemory(newChatId, {
    ...identity,
    phone_number: digits(phone) || String(phone ?? ''),
    agent_id: agentId,
    campaign_id: campaignId ? String(campaignId) : null,
    _ob_state: 'new',
    ...extraMemory,
  });
  await setProspectStage(
    newChatId,
    'New',
    'referral_transfer',
    dealersId ? String(dealersId) : '',
    String(companyId || '')
  );

  const mem = (await getMemory(newChatId)) ?? {};
  const executeAt = await nextBusinessHoursStart(
    mem.timezone as string | null,
    mem.state as string | null,
    newChatId
  );
  const tid = await createTaskWithId(
    newChatId,
    'outbound_outreach',
    executeAt,
    {
      task_type: 'outbound_outreach',
      notes: warmNotes,
      agent_id: agentId,
      account_id: agentId,
      campaign_id: campaignId ? String(campaignId) : null,
      task_source: 'referral_transfer',
    }
  );
  await enforceSingleProactiveTask(newChatId, tid);
  return tid;
}

export interface ReferralResult {
  ok: boolean;
  error?: string;
  insufficient_keys?: boolean;
  new_chat_id?: string;
  contact_id?: string | null;
  same_line?: boolean;
  created_contact?: boolean;
  campaign_id?: string | null;
  source_chat_id?: string;
}

export interface ReferralOptions {
  referrer?: string | null;
  source?: string;
  /**
   * Keep the new chat on the DIALED line — custom-keyed on the source phone — even when a referred email
   * is present, so it never collides with the source's phone-keyed chat. The email is still used for
   * HubSpot dedup. Set by the review only when the person is genuinely reachable at the number we dialed.
   */
  forceSameLine?: boolean;
  /** Stamped on the archived source, e.g. `identity_mismatch`. */
  archiveReason?: string;
}

/**
 * Move outreach from a wrong or departed contact to a NEW warm chat for the referred person.
 *
 * Best-effort throughout: every side effect is independently wrapped, so one failure never blocks the
 * rest. `referred.company` (alias `referred_company`), when present, OVERRIDES the source's company — the
 * identity-mismatch route uses that, because there the whole company was wrong (the number rings a
 * different dealership).
 */
export async function handleReferralTransfer(
  sourceChatId: string,
  referred: ReferredPerson | null | undefined,
  options: ReferralOptions = {}
): Promise<ReferralResult> {
  const {
    referrer = null,
    source = 'review',
    forceSameLine = false,
    archiveReason = 'referred_to_new_contact',
  } = options;

  if (!sourceChatId || !referred || typeof referred !== 'object') {
    return { ok: false, error: 'bad args' };
  }

  const email = pick(referred, 'email', 'referred_email').toLowerCase();
  const phone = pick(referred, 'phone', 'referred_phone');
  const first = pick(referred, 'first_name', 'referred_first_name');
  const last = pick(referred, 'last_name', 'referred_last_name');
  const title = pick(referred, 'title', 'referred_title');

  // A NAME alone is now enough to get this far — the same-line switch ("there's no Claira, it's Chris" on
  // the same number) has no distinct email or phone. The key gate below is what actually decides.
  if (!email && !phone && !first) {
    return { ok: false, error: 'no email, phone, or name for referred person' };
  }

  const src = (await getMemory(sourceChatId)) ?? {};
  const agentId = src.agent_id ? String(src.agent_id) : '';
  if (!agentId) return { ok: false, error: 'source chat has no agent_id' };

  // Loop guard: never switch a chat that is ITSELF a referral, or one already switched away.
  if (src._is_referral || src._referred_to_chat) {
    return { ok: false, error: 'source already referral / already switched' };
  }

  const company =
    pick(referred, 'company', 'referred_company') || String(src.company ?? '');
  const campaignId = (src.campaign_id as string | undefined) ?? null;
  const dealersId = src.dealers_id;
  const companyId = src.company_id;
  const recordType = String(src.record_type ?? 'Real');
  const sourcePhone = src.phone_number;

  const referrerLabel =
    String(referrer ?? '').trim() ||
    (company ? `your team at ${company}` : 'your team');

  // SAME-LINE referral: the referred person is reachable at the number we dialed, so that number becomes
  // their contact and a CUSTOM chat key keeps it clear of the source's phone-keyed chat. Same-line is
  // never inferred from a missing email/phone — a name-only referral to someone at a DIFFERENT store has
  // no reachable contact and must fail rather than fork onto the wrong line.
  const sameLine = Boolean(forceSameLine);
  const contactPhone = phone || (sameLine ? String(sourcePhone ?? '') : '');

  // DETERMINISTIC KEY GATE — a backstop in case the review mis-resolves the contact. Name + company + a
  // reachable channel, or no chat is created at all; the caller keeps the source as-is and a later call
  // can try again with more information.
  if (!((first || last) && company && (email || contactPhone))) {
    console.log(
      `[REFERRAL] ${sourceChatId}: insufficient keys to create chat — ` +
        `name=${Boolean(first || last)} company=${Boolean(company)} email=${Boolean(email)} ` +
        `phone=${Boolean(contactPhone)}; not forking`
    );
    return {
      ok: false,
      error:
        'insufficient keys: need name, company, and a phone/email (or same-line)',
      insufficient_keys: true,
    };
  }

  // 1. HubSpot: find-or-create (email → phone → name).
  let contactId: string | null = null;
  let createdContact = false;
  try {
    const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
    const token = await accessToken(cfg, agentId);
    if (token) {
      contactId = await findExistingContact(token, {
        email,
        phone: contactPhone,
        firstName: first,
        lastName: last,
      });
      if (!contactId) {
        const props: Record<string, unknown> = {
          email,
          firstname: first,
          lastname: last,
          company,
          phone: contactPhone,
        };
        if (cfg.source_property && cfg.source_value) {
          props[cfg.source_property] = cfg.source_value;
        }
        if (cfg.env_property) {
          props[cfg.env_property] = recordType;
        }
        contactId = await createContact(token, props);
        createdContact = Boolean(contactId);
      }
    }
  } catch (e) {
    console.warn(`[REFERRAL] HubSpot contact resolve/create failed: ${e}`);
  }

  const identity: Record<string, unknown> = {
    first_name: first,
    last_name: last,
    display_name: first,
    customer_email: email,
    company: company || '',
    hubspot_contact_id: contactId ? String(contactId) : null,
    job_title: title,
  };
  const referralCtx: Record<string, unknown> = {
    referred_by: referrerLabel,
    referral_title: title,
    _is_referral: true,
    _referred_from_chat_id: sourceChatId,
    sales_agent_name: src.sales_agent_name ?? null,
    record_type: recordType,
    dealers_id: dealersId ? String(dealersId) : null,
    _conversation_summary: warmSummary(referrerLabel, company, title),
    _conversation_summary_at: new Date().toISOString(),
  };
  const warmNotes = warmOutreachNotes(referrerLabel, company, title);

  // 2. Create the new chat.
  let newChatId: string;
  if (sameLine) {
    newChatId =
      'outbound__' +
      agentId +
      '__' +
      (digits(sourcePhone) || 'x') +
      '__' +
      (contactId ? String(contactId) : nameSlug(`${first} ${last}`));
    try {
      const srcUserKey = (
        (await db.collection('chats').doc(sourceChatId).get()).data() ?? {}
      ).userId as string | undefined;
      await createSameLineChat(
        newChatId,
        agentId,
        sourcePhone,
        identity,
        referralCtx,
        campaignId,
        dealersId,
        companyId,
        warmNotes,
        srcUserKey
      );
    } catch (e) {
      console.error(
        `[REFERRAL] same-line chat create failed for source=${sourceChatId}: ${e}`
      );
      return {
        ok: false,
        error: `same-line create failed: ${e}`,
        contact_id: contactId,
      };
    }
  } else {
    const lead = {
      contact_information: {
        email,
        phone_number: phone,
        first_name: first,
        last_name: last,
      },
      input_data: {
        agent_id: agentId,
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
    const enrolled = res?.chat_id;
    if (!enrolled) {
      return {
        ok: false,
        error: `enroll returned no chat_id: ${JSON.stringify(res)}`,
        contact_id: contactId,
      };
    }
    newChatId = enrolled;

    try {
      await setMemory(newChatId, referralCtx);
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
            'data.notes': warmNotes,
            updated_at: FieldValue.serverTimestamp(),
          });
      } catch (e) {
        console.warn(
          `[REFERRAL] warm task-notes rewrite failed for ${newChatId}: ${e}`
        );
      }
    }
  }

  // 3. Trace the fork at the CHAT-DOC level: a top-level `referrer_chat_id` on the new chat, the inverse
  //    of the source's `_referred_to_chat`. Set ONLY on forked chats, so its presence marks a chat as
  //    forked-from-a-referrer and the frontend can key on presence/absence.
  try {
    await db
      .collection('chats')
      .doc(newChatId)
      .set({ referrer_chat_id: sourceChatId }, { merge: true });
  } catch (e) {
    console.warn(
      `[REFERRAL] referrer_chat_id write failed for ${newChatId}: ${e}`
    );
  }

  // 4. Load the referrer's prior context into the new chat FIRST, clearly tagged as background.
  await seedReferrerContext(newChatId, sourceChatId);

  // 5. Highlight the new chat for review. Comms still go out — this is not a gate.
  try {
    await addLabelToChat(newChatId, REFERRAL_HIGHLIGHT_LABEL);
  } catch (e) {
    console.warn(`[REFERRAL] highlight label failed for ${newChatId}: ${e}`);
  }

  // 6. HARD-STOP the source chat — outreach now points at the real person.
  await hardStopSource(sourceChatId, newChatId, archiveReason);

  console.log(
    `[REFERRAL] ${sourceChatId} → new chat ${newChatId} (contact=${contactId}, ` +
      `created=${createdContact}, same_line=${sameLine}, campaign=${campaignId}, source=${source})`
  );
  return {
    ok: true,
    new_chat_id: newChatId,
    contact_id: contactId,
    same_line: sameLine,
    created_contact: createdContact,
    campaign_id: campaignId,
    source_chat_id: sourceChatId,
  };
}

/** Exposed for tests: the pure copy builders. */
export const __testing = { warmSummary, warmOutreachNotes, atCompany, pick };
