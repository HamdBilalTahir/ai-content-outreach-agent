/**
 * HubSpot stage sync, deals, and the rep-facing deal brief.
 *
 * `syncHubspotStage` is called right after every `setProspectStage`, and it is the single place where
 * the outbound funnel becomes CRM state. Closes the `syncHubspotStage` and
 * `maybeAddDealConversationNote` seams — nine call sites across the review orchestrator, the email
 * webhook, the stage tools, enroll, and the conversation-init webhook.
 *
 * ## The forward-only guard has two halves, and they catch different things
 *
 * `_hubspot_synced_stage` equal to the current stage is the IDEMPOTENCE half: redundant calls cost
 * nothing, which is what lets every caller fire it unconditionally. The rank comparison is the
 * NEVER-DOWNGRADE half: if a funnel stage was already pushed, a backward or equal move is refused, so a
 * stray path cannot overwrite `hs_lead_status` with a lower value or log a backward "stage updated to"
 * Note. Firestore is already forward-only; this stops a regression there from reaching the CRM.
 *
 * `Lost` is deliberately absent from the rank, so it always syncs — it is terminal, and blocking it
 * would leave a closed prospect looking open in the CRM.
 *
 * ## Connecting the action IS the on-switch
 *
 * There is no `hubspot_sync` toggle, and deliberately so: it is not an LLM tool, so the skills UI could
 * never show it. An active HubSpot v2 action is the whole gate.
 *
 * ## MINIMAL WRITES on an existing contact
 *
 * Core fields — name, company, phone, source, record type, state, timezone — are written ONCE, at
 * creation. An existing contact is NOT re-enriched on every transition, and no separate Company object
 * is created for the outbound path. Only the Ava-owned stage key is touched per transition. That keeps
 * the CRM's own edits from being overwritten by a bot on every stage change.
 *
 * ## `contact_created` distinguishes two activities that look alike
 *
 * A genuine create logs `hubspot_contact_created`; LINKING an existing HubSpot record logs
 * `hubspot_contact_updated` instead. Campaigns running against records that already existed need to
 * show "updated", not "created", or the numbers imply we built a database we actually just matched.
 *
 * ## A Test record is kept off the marketing-contact bill
 *
 * `hs_marketable_status: "false"` on creation. E2E runs create real HubSpot contacts, and marketing
 * contacts are billed.
 *
 * ## The deal brief prefers an LLM but is GUARANTEED non-empty
 *
 * `generateDealBrief` is evidence-only and omits anything it cannot support. When it fails, the
 * deterministic fallback builds from whatever outbound actually has — name, company, meeting time,
 * source, summary, transcript excerpt — because the source records that outbound Notes were arriving
 * thin or empty. A brief that exists is worth more than a perfect one that does not.
 *
 * ## Not ported
 *
 * `sync_hubspot_inbound_lead` (~156 lines): it bails on `type == "outbound"` and its production caller
 * is the INBOUND web turn — the third instance of the pattern behind plan revision 7.
 * `_associate_deal_company` is unreachable from the outbound path, which never creates a Company (see
 * the minimal-write note); the outbound `ensureCompany` helper is ported since stage sync references it.
 */

import { db } from '../firebase/db';
import { getAgentActions } from '../firebase/agent';
import { getMemory, setMemory } from '../firebase/chat';
import { resolveOutboundName } from './chat';
import { generateAndCacheSummary } from './conversationSummary';
import { llmText } from '../tools/reviewHelpers';
import {
  CONTACT_STAGES,
  DEAL_TO_CONTACT_ASSOC_TYPE_ID,
  HUBSPOT_BASE,
  STAGE_RANK,
  accessToken,
  createContact,
  findContactByEmail,
  hsHeaders,
  logHubspotDealNote,
  logHubspotNote,
  resolveHubspotConfig,
  resolveOwnerId,
  updateContactProperty,
} from './hubspot';
import type { ChatMemory } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

/** Written once per deal — the note is exactly-once. */
const DEAL_NOTE_AT_KEY = '_hubspot_deal_note_at';

/** Campaign attribution on the DEAL, so the funnel can filter by campaign in one native search. */
export const DEAL_CAMPAIGN_PROP = 'ava_campaign_id';

/** Free-mail domains: associate by company NAME only, never by domain. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'aol.com',
]);

/**
 * Fields the inbound qualification flow populates. Outbound sets none of them, which is exactly why the
 * deterministic brief needs its own outbound branch.
 */
const DEAL_BRIEF_KEYS: ReadonlyArray<[string, string]> = [
  ['contact_name', 'Prospect'],
  ['company_name', 'Company'],
  ['dealer_type', 'Dealer type'],
  ['rooftops', 'Rooftops'],
  ['key_metrics', 'Volume'],
  ['current_solution', 'Current tools'],
  ['pain_points', 'Pain points'],
  ['urgency', 'Urgency'],
  ['qualification_tier', 'Tier'],
  ['demo_time', 'Demo'],
  ['notes', 'Notes'],
];

/** Per-process cache, so a repeated property check is free. Prefixed to avoid object-type collisions. */
const ENSURED_PROPS = new Set<string>();

/**
 * Create a custom DEAL property if it does not exist. Required before stamping or filtering on it.
 *
 * A 409 counts as success — it means another process created it concurrently, which is the goal.
 */
export async function ensureDealProperty(
  token: string,
  name: string,
  label: string,
  propType: string,
  fieldType: string
): Promise<boolean> {
  const cacheKey = `deal:${name}`;
  if (ENSURED_PROPS.has(cacheKey)) return true;
  try {
    const r = await fetch(`${HUBSPOT_BASE}/crm/v3/properties/deals/${name}`, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 200) {
      ENSURED_PROPS.add(cacheKey);
      return true;
    }
    const c = await fetch(`${HUBSPOT_BASE}/crm/v3/properties/deals`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({
        name,
        label,
        type: propType,
        fieldType,
        groupName: 'dealinformation',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if ([200, 201, 409].includes(c.status)) {
      ENSURED_PROPS.add(cacheKey);
      return true;
    }
    console.warn(
      `[HS] ensure deal property ${name} failed ${c.status}: ${(await c.text()).slice(0, 150)}`
    );
  } catch (e) {
    console.warn(`[HS] ensureDealProperty ${name} error: ${e}`);
  }
  return false;
}

/** The contact's owner, so the deal can inherit it. `null` when the contact has none. */
export async function getContactOwner(
  token: string,
  contactId: string
): Promise<string | null> {
  if (!contactId) return null;
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}?properties=hubspot_owner_id`,
      {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status === 200) {
      const props = (((await resp.json()) as Record<string, unknown>)
        .properties ?? {}) as Record<string, unknown>;
      return (props.hubspot_owner_id as string) || null;
    }
  } catch (e) {
    console.warn(`[HS] get contact owner failed: ${e}`);
  }
  return null;
}

/** Create a deal, associated to its contact. Returns the deal id, or `null`. */
export async function createDealForContact(
  token: string,
  pipelineId: string,
  stageId: string,
  dealname: string,
  contactId: string,
  extraProperties?: Record<string, unknown> | null
): Promise<string | null> {
  const properties: Record<string, unknown> = {
    dealname: dealname || 'Outbound opportunity',
    pipeline: pipelineId,
    dealstage: stageId,
  };
  for (const [k, v] of Object.entries(extraProperties ?? {})) {
    if (v) properties[k] = v;
  }
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({
        properties,
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: DEAL_TO_CONTACT_ASSOC_TYPE_ID,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200 || resp.status === 201) {
      return String(((await resp.json()) as Record<string, unknown>).id);
    }
    console.error(
      `[HS] create deal ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] create deal error: ${e}`);
  }
  return null;
}

/** Move a deal to another pipeline stage. */
export async function updateDealStage(
  token: string,
  dealId: string,
  stageId: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: hsHeaders(token),
      body: JSON.stringify({ properties: { dealstage: stageId } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200 || resp.status === 201) return true;
    console.error(
      `[HS] update deal ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] update deal error: ${e}`);
  }
  return false;
}

/** Record a CRM push as a chat activity, so the UI can show it. Never throws into the sync. */
export async function logHubspotActivity(
  chatId: string,
  toolName: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  status = 'success'
): Promise<void> {
  if (!chatId) return;
  try {
    await db
      .collection('chats')
      .doc(chatId)
      .collection('activities')
      .doc()
      .set({
        timestamp: new Date(),
        kind: 'tool_call',
        toolCall: {
          toolName,
          input: input ?? {},
          result: result ?? {},
          status,
        },
      });
  } catch (e) {
    console.warn(`[HS] activity log failed (${toolName}): ${e}`);
  }
}

/** The public scheduling page for a meeting slug. */
export function schedulingPageUrl(
  slug: string | null | undefined
): string | null {
  return slug ? `https://meetings.hubspot.com/${slug}` : null;
}

/** Find a company by domain (preferred) or name, else create it. */
export async function findOrCreateCompany(
  token: string,
  name: string | null | undefined,
  domain?: string | null
): Promise<string | null> {
  const nm = String(name ?? '').trim();
  const dom =
    String(domain ?? '')
      .trim()
      .toLowerCase() || null;
  if (!nm && !dom) return null;
  try {
    // Domain is the stronger key: two companies can share a name, not a domain.
    const filter = dom
      ? { propertyName: 'domain', operator: 'EQ', value: dom }
      : { propertyName: 'name', operator: 'EQ', value: nm };
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/companies/search`,
      {
        method: 'POST',
        headers: hsHeaders(token),
        body: JSON.stringify({
          filterGroups: [{ filters: [filter] }],
          properties: ['name', 'domain'],
          limit: 1,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status === 200) {
      const results = ((await resp.json()) as Record<string, unknown>)
        .results as Array<Record<string, unknown>> | undefined;
      if (results && results.length > 0) return String(results[0].id);
    }
    const props: Record<string, unknown> = {};
    if (nm) props.name = nm;
    if (dom) props.domain = dom;
    const cresp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({ properties: props }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (cresp.status === 200 || cresp.status === 201) {
      return String(((await cresp.json()) as Record<string, unknown>).id);
    }
    console.error(
      `[HS] create company ${cresp.status}: ${(await cresp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] find/create company error: ${e}`);
  }
  return null;
}

/** Associate a contact to a company via the v4 default association, which sets Primary company. */
export async function associateContactCompany(
  token: string,
  contactId: string,
  companyId: string
): Promise<boolean> {
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`,
      {
        method: 'PUT',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    return [200, 201, 204].includes(resp.status);
  } catch (e) {
    console.error(`[HS] associate contact->company error: ${e}`);
    return false;
  }
}

/** The deal's display name: person — vehicle — company, falling back to the email. */
export function dealname(memory: ChatMemory): string {
  const m = memory as Record<string, unknown>;
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  const vehicle = [m.year, m.make, m.model]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .trim();
  const parts = [name, vehicle, m.company].filter(Boolean) as string[];
  return parts.length > 0
    ? parts.join(' — ')
    : (m.customer_email as string) || 'Outbound opportunity';
}

// ─────────────────────────────────────────────────────────────────────────────
// The deal brief
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The last N UI-visible messages as `CUSTOMER:`/`AGENT:` lines, oldest first.
 *
 * Internal notes are excluded — they are our own annotations, not conversation. Bodies are truncated so
 * one long paste cannot dominate the brief's input.
 */
export async function recentTranscript(
  chatId: string,
  limit = 12
): Promise<string> {
  try {
    const snap = await db
      .collection('chats')
      .doc(chatId)
      .collection('messages_v3')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    const lines: string[] = [];
    for (const m of [...snap.docs].reverse()) {
      const d = (m.data() ?? {}) as Record<string, unknown>;
      const body = String(
        ((d.content ?? {}) as Record<string, unknown>).body ?? ''
      ).trim();
      if (!body || d.direction === 'internal') continue;
      const who =
        ((d.sender ?? {}) as Record<string, unknown>).kind === 'customer'
          ? 'CUSTOMER'
          : 'AGENT';
      lines.push(`${who}: ${body.slice(0, 400)}`);
    }
    return lines.join('\n');
  } catch (e) {
    console.warn(`[HS] transcript read failed chat=${chatId}: ${e}`);
    return '';
  }
}

/**
 * The fallback brief, used when the LLM call fails.
 *
 * The inbound qualification keys drive it when present. Outbound populates NONE of them, so it falls
 * back to what outbound actually has — which is the whole point: the source records outbound Notes
 * arriving thin or empty, and a brief that exists beats a perfect one that does not.
 */
export async function deterministicDealBrief(
  memory: ChatMemory,
  chatId?: string
): Promise<string> {
  const m = memory as Record<string, unknown>;
  const lines = DEAL_BRIEF_KEYS.filter(([k]) => m[k]).map(
    ([k, label]) => `<b>${label}:</b> ${m[k]}`
  );
  if (lines.length > 0) return lines.join('<br>');

  // The outbound path — none of the inbound qualification keys are set.
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  const ob: string[] = [];
  if (name) ob.push(`<b>Prospect:</b> ${name}`);
  if (m.company) ob.push(`<b>Company:</b> ${m.company}`);
  if (m.meeting_at) ob.push(`<b>Demo:</b> ${m.meeting_at}`);
  if (m.lead_source) ob.push(`<b>Source:</b> ${m.lead_source}`);
  if (m._conversation_summary) {
    ob.push(`<b>Summary:</b> ${m._conversation_summary}`);
  } else if (chatId) {
    // No cached summary — a transcript excerpt still gives the rep something real.
    try {
      const excerpt = (await recentTranscript(chatId, 30)).trim();
      if (excerpt) {
        ob.push(`<b>Recent conversation:</b><br>${excerpt.slice(0, 1500)}`);
      }
    } catch {
      // Best-effort.
    }
  }
  return ob.join('<br>');
}

const DEAL_BRIEF_SYSTEM =
  'You are a sales-ops analyst. From the conversation, produce a concise sales brief for the ' +
  'rep prepping this demo. Use ONLY facts evidenced in the conversation or the known fields — ' +
  "never invent or infer beyond what's said; OMIT any field you have no evidence for. Output " +
  "light HTML only: each field on its own line as '<b>Label:</b> value' separated by <br>. " +
  'No markdown, no preamble. Candidate fields (include only those with evidence): ' +
  'Prospect (name/company/role/location), Business (dealer type / rooftops / current monthly ' +
  'acquisition volume / target additional vehicles), Current setup (tools / process / staff), ' +
  'Goals — what they want in their own words, Interest (turnkey vs specific tools; ' +
  'volume/margin/speed/inspections), Pain points, Urgency/timing, Buying or budget signals, ' +
  'Objections, Qualification tier (High/Medium/Low + one-line why), Demo (day/time + requested ' +
  'focus), Notable quotes.';

/**
 * One model call for a structured, EVIDENCE-ONLY brief. `''` on failure, so the caller falls back.
 *
 * Retried once: the brief is written exactly once per deal, so a transient failure would otherwise cost
 * the rep their only prep note.
 */
export async function generateDealBrief(
  chatId: string,
  memory: ChatMemory
): Promise<string> {
  const m = memory as Record<string, unknown>;
  let transcript = '';
  try {
    transcript = await recentTranscript(chatId, 30);
  } catch {
    transcript = '';
  }
  const cached = String(m._conversation_summary ?? '');
  const known = DEAL_BRIEF_KEYS.filter(([k]) => m[k])
    .map(([k, label]) => `- ${label}: ${m[k]}`)
    .join('\n');
  if (!transcript && !cached && !known) return '';

  const user =
    `CONVERSATION:\n${transcript || '(none)'}\n\n` +
    `PRIOR SUMMARY:\n${cached || '(none)'}\n\n` +
    `KNOWN FIELDS:\n${known || '(none)'}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = (await llmText(DEAL_BRIEF_SYSTEM, user)).trim();
      if (text) return text;
    } catch (e) {
      console.warn(
        `[HS] deal brief gen attempt ${attempt + 1} failed chat=${chatId}: ${e}`
      );
    }
  }
  return '';
}

/**
 * Post the sales-brief Note on the DEAL — once, when there is a booked demo to brief on.
 *
 * Idempotent via `_hubspot_deal_note_at`, and gated on `demo_time` (inbound) or `meeting_booked`
 * (outbound): a Lead with no meeting has nothing to prep for.
 *
 * Fills a MISSING conversation summary before building the brief, but never regenerates over a cached
 * one — reviews refresh that over the deal's life, and overwriting it would discard newer context. The
 * source notes this is precisely why outbound Notes were thin.
 */
export async function maybeAddDealConversationNote(
  chatId: string,
  agentId: string,
  options: { dealId?: string | null; agentActions?: unknown[] | null } = {}
): Promise<void> {
  try {
    if (!chatId || !agentId) return;
    const snap = await db.collection('chats').doc(chatId).get();
    if (!snap.exists) return;
    const chatData = (snap.data() ?? {}) as Record<string, unknown>;
    if (chatData.playground) return;

    const memory = (chatData.memory ?? {}) as ChatMemory as Record<
      string,
      unknown
    >;
    const dealId = options.dealId || (memory.hubspot_deal_id as string);
    if (!dealId) return;
    if (memory[DEAL_NOTE_AT_KEY]) return; // exactly once per deal
    // Only when there is a booked demo/meeting to brief on.
    if (!memory.demo_time && !memory.meeting_booked) return;

    const actions =
      options.agentActions !== undefined && options.agentActions !== null
        ? options.agentActions
        : ((await getAgentActions(agentId)) ?? []);
    const cfg = resolveHubspotConfig(
      actions as Parameters<typeof resolveHubspotConfig>[0]
    );
    if (!cfg.refresh_token && !cfg.access_token) return;
    const token = await accessToken(cfg, agentId);
    if (!token) return;

    // Fill the gap ONLY — never regenerate over a cached summary.
    if (!memory._conversation_summary) {
      try {
        const t = await recentTranscript(chatId, 30);
        if (t) {
          const summary = await generateAndCacheSummary(chatId, t, {}, {});
          if (summary) memory._conversation_summary = summary;
        }
      } catch (e) {
        console.warn(
          `[HS] ensure summary before deal note failed chat=${chatId}: ${e}`
        );
      }
    }

    const brief =
      (await generateDealBrief(chatId, memory as ChatMemory)) ||
      (await deterministicDealBrief(memory as ChatMemory, chatId));
    if (!brief.trim()) return;

    const demo = memory.demo_time;
    const name = await resolveOutboundName({
      ...(memory as ChatMemory),
      agent_id: agentId,
    });
    const title = demo
      ? `${name} demo booked — ${demo}`
      : `${name} — Lead conversation`;

    if (
      await logHubspotDealNote(token, dealId, `<b>${title}</b><br><br>${brief}`)
    ) {
      await setMemory(chatId, { [DEAL_NOTE_AT_KEY]: new Date().toISOString() });
      console.log(
        `[HS] deal conversation note added chat=${chatId} deal=${dealId}`
      );
    }
  } catch (e) {
    console.error(
      `[HS] maybeAddDealConversationNote failed chat=${chatId}: ${e}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror the chat's CURRENT stage to HubSpot. Best-effort, idempotent per stage, never throws.
 *
 * Reads the stage from the chat itself rather than taking it as an argument, which is what makes
 * redundant calls free — every caller can fire it unconditionally after a stage write.
 */
export async function syncHubspotStage(
  chatId: string,
  agentIdIn?: string | null
): Promise<void> {
  try {
    if (!chatId) return;
    const snap = await db.collection('chats').doc(chatId).get();
    if (!snap.exists) return;
    const chatData = (snap.data() ?? {}) as Record<string, unknown>;
    if (chatData.type !== 'outbound') return; // outbound-only, hard guard

    const memory = (chatData.memory ?? {}) as Record<string, unknown>;
    const stage = String(chatData.stage ?? memory.current_stage ?? '');
    if (!stage) return;

    const agentId = String(
      agentIdIn || memory.agent_id || chatData.agentId || ''
    );
    if (!agentId) return;

    // The forward-only guard — see the module note on its two halves.
    const syncedStage = memory._hubspot_synced_stage as string | undefined;
    if (syncedStage === stage) return;
    if (
      stage in STAGE_RANK &&
      syncedStage &&
      syncedStage in STAGE_RANK &&
      STAGE_RANK[stage] <= STAGE_RANK[syncedStage]
    ) {
      console.log(
        `[HS] skip backward sync chat=${chatId}: ${syncedStage} -> ${stage}`
      );
      return;
    }

    // An active HubSpot v2 action is the entire gate — connecting it IS the on-switch.
    const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
    if (!cfg.refresh_token && !cfg.access_token) return;
    const token = await accessToken(cfg, agentId);
    if (!token) return;

    const prop = cfg.contact_stage_property as string;
    const stageValues = (cfg.stage_values ?? {}) as Record<string, string>;
    const stageIds = (cfg.stage_ids ?? {}) as Record<string, string>;
    const pipelineId = cfg.pipeline_id;
    const sourceProp = cfg.source_property;
    const sourceVal = cfg.source_value;
    const envProp = cfg.env_property;
    // record_type may live in memory OR at the chat-doc top level — accept either.
    const envVal = String(
      memory.record_type ??
        chatData.record_type ??
        cfg.env_default_value ??
        'Real'
    );

    let contactId = memory.hubspot_contact_id as string | undefined;
    let dealId = memory.hubspot_deal_id as string | undefined;
    const updates: Record<string, unknown> = {};
    let synced = false;
    // True ONLY on a genuine create — see the module note on why the distinction matters.
    let contactCreated = false;

    const ensureContact = async (): Promise<string | undefined> => {
      if (contactId) return contactId;

      const email = String(memory.customer_email ?? '')
        .trim()
        .toLowerCase();
      if (email) {
        const found = await findContactByEmail(token, email);
        if (found) contactId = found;
      }
      if (!contactId) {
        const props: Record<string, unknown> = {
          email: memory.customer_email,
          firstname: memory.first_name,
          lastname: memory.last_name,
          company: memory.company,
          phone: memory.phone_number,
        };
        if (memory.state) props.state = memory.state;
        if (memory.timezone) {
          // HubSpot's own format: "america_slash_new_york".
          props.hs_timezone = String(memory.timezone)
            .trim()
            .toLowerCase()
            .replace(/\//g, '_slash_');
        }
        if (sourceProp && sourceVal) props[sourceProp] = sourceVal;
        if (envProp && envVal) props[envProp] = envVal;
        if (envVal.toLowerCase() === 'test') {
          // Marketing contacts are billed, and E2E runs create real ones.
          props.hs_marketable_status = 'false';
        }
        const ownerId = resolveOwnerId(cfg, envVal);
        if (ownerId) props.hubspot_owner_id = String(ownerId);

        contactId = (await createContact(token, props)) ?? undefined;
        if (contactId) {
          contactCreated = true;
          await logHubspotActivity(
            chatId,
            'hubspot_contact_created',
            { email: memory.customer_email, stage },
            { contact_id: contactId }
          );
        }
      }
      if (contactId) updates.hubspot_contact_id = contactId;
      return contactId;
    };

    if ((CONTACT_STAGES as readonly string[]).includes(stage)) {
      const cid = await ensureContact();
      if (cid) {
        // MINIMAL WRITES: only the Ava-owned stage key per transition — see the module note.
        synced = await updateContactProperty(
          token,
          cid,
          prop,
          stageValues[stage] ?? stage
        );
        if (synced) {
          await logHubspotActivity(
            chatId,
            'hubspot_stage_updated',
            { stage },
            { [prop]: stageValues[stage] ?? stage }
          );
        }
        if (!contactCreated) {
          // A LINKED existing record logs "updated", not "created" — see the module note.
          const updatedInput: Record<string, unknown> = {
            email: memory.customer_email,
            stage,
          };
          if (sourceProp && sourceVal) updatedInput[sourceProp] = sourceVal;
          if (envProp && envVal) updatedInput[envProp] = envVal;
          await logHubspotActivity(
            chatId,
            'hubspot_contact_updated',
            updatedInput,
            { contact_id: cid }
          );
        }
      }
    } else if (stage === 'Lead') {
      const cid = await ensureContact();
      if (cid) {
        // A deal means the prospect is past Engaged. HubSpot auto-advances lifecyclestage to
        // Opportunity, but the lead-status field would otherwise stay stuck at Engaged.
        await updateContactProperty(
          token,
          cid,
          prop,
          stageValues.Lead ?? 'Lead'
        );
        if (dealId) {
          synced = true; // the deal already exists
        } else if (pipelineId && stageIds.Lead) {
          const dealExtra: Record<string, unknown> = {};
          if (envProp && envVal) dealExtra[envProp] = envVal;
          if (sourceProp && sourceVal) dealExtra[sourceProp] = sourceVal;
          // Campaign attribution on the DEAL: HubSpot cannot filter a deal by its contact's
          // property, so the funnel needs it here to query in one native search.
          const campaignId = memory.campaign_id;
          if (
            campaignId &&
            (await ensureDealProperty(
              token,
              DEAL_CAMPAIGN_PROP,
              'Ava campaign',
              'string',
              'text'
            ))
          ) {
            dealExtra[DEAL_CAMPAIGN_PROP] = String(campaignId);
          }
          const owner = await getContactOwner(token, cid);
          if (owner) dealExtra.hubspot_owner_id = owner;

          dealId =
            (await createDealForContact(
              token,
              pipelineId,
              stageIds.Lead,
              dealname(memory as ChatMemory),
              cid,
              Object.keys(dealExtra).length > 0 ? dealExtra : null
            )) ?? undefined;
          if (dealId) {
            updates.hubspot_deal_id = dealId;
            synced = true;
            await logHubspotActivity(
              chatId,
              'hubspot_deal_created',
              { stage: 'Initial Demo Scheduled', pipeline: pipelineId },
              { deal_id: dealId }
            );
          }
        } else {
          console.warn(
            `[HS] Lead reached but pipeline_id/stage_ids['Lead'] missing (chat ${chatId})`
          );
        }
        // The rep-facing brief, once.
        if (dealId) {
          await maybeAddDealConversationNote(chatId, agentId, { dealId });
        }
      }
    } else if (stage === 'Lost') {
      if (dealId && stageIds.Lost) {
        synced = await updateDealStage(token, dealId, stageIds.Lost);
        if (synced) {
          await logHubspotActivity(
            chatId,
            'hubspot_deal_updated',
            { stage: 'Closed Lost' },
            { deal_id: dealId }
          );
        }
      } else {
        const cid = await ensureContact();
        if (cid) {
          synced = await updateContactProperty(
            token,
            cid,
            prop,
            stageValues.Lost ?? 'Unqualified'
          );
          if (synced) {
            await logHubspotActivity(
              chatId,
              'hubspot_stage_updated',
              { stage: 'Lost' },
              { [prop]: stageValues.Lost ?? 'Unqualified' }
            );
          }
        }
      }
    }

    if (synced) {
      updates._hubspot_synced_stage = stage;
      if (contactId) {
        // A Note, so HubSpot's last-activity date reflects the push.
        const streamName = await resolveOutboundName({
          ...(memory as ChatMemory),
          agent_id: agentId,
        });
        await logHubspotNote(
          token,
          contactId,
          `${streamName} Outbound Comms — prospect stage updated to <b>${stage}</b>.`
        );
      }
    }
    if (Object.keys(updates).length > 0) {
      await setMemory(chatId, updates);
      console.log(
        `[HS] chat ${chatId} synced stage=${stage} synced=${synced} ` +
          `contact=${updates.hubspot_contact_id ?? contactId} deal=${updates.hubspot_deal_id ?? dealId}`
      );
    }
  } catch (e) {
    console.error(`[HS] syncHubspotStage failed chat=${chatId}: ${e}`);
  }
}

/** The find-or-create company path, kept for the callers that do want a Company object. */
export async function ensureCompanyForContact(
  token: string,
  chatId: string,
  contactId: string,
  memory: ChatMemory
): Promise<string | null> {
  const m = memory as Record<string, unknown>;
  if (m.hubspot_company_id || !m.company) return null;

  const email = String(m.customer_email ?? '');
  let domain: string | null = email.includes('@')
    ? email.split('@').pop()!.toLowerCase()
    : null;
  // Free-mail tells us nothing about the employer, so associate by name only.
  if (domain && FREE_MAIL_DOMAINS.has(domain)) domain = null;

  const companyId = await findOrCreateCompany(
    token,
    m.company as string,
    domain
  );
  if (
    companyId &&
    (await associateContactCompany(token, contactId, companyId))
  ) {
    await logHubspotActivity(
      chatId,
      'hubspot_company_associated',
      { company: m.company },
      { company_id: companyId }
    );
    return companyId;
  }
  return null;
}

export const __testing = {
  DEAL_BRIEF_KEYS,
  DEAL_NOTE_AT_KEY,
  FREE_MAIL_DOMAINS,
  ENSURED_PROPS,
  getMemory,
};
