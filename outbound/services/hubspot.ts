/**
 * The HubSpot client core: config resolution, authentication, contacts, and notes.
 *
 * First of five Phase 9 increments. Everything CRM-side in this port is best-effort mirroring — the
 * outbound flow's own state lives in Firestore, and a HubSpot outage must never stop outreach. Every
 * function here returns a falsy result rather than throwing, and that is deliberate rather than lazy:
 * these are called from inside `try` blocks whose whole purpose is "the outcome already happened, record
 * it if you can".
 *
 * ## Only the v2 action counts, identified by `provider`
 *
 * `resolveHubspotConfig` matches `provider == "hubspot_v2"` and ignores the LEGACY `provider ==
 * "hubspot"` action entirely (the one behind `create_hubspot_lead` / `update_hubspot_lead` /
 * `hubspot_book_appointment`). It keys on `provider` rather than `type` because `getAgentActions`
 * blanks `type` and `functions` for actions with no `action_id` — so `provider` is the robust
 * identifier, and `type` is only checked as a secondary.
 *
 * ## Two authentication modes, and the difference matters operationally
 *
 * A `refresh_token` means OAuth: every call refreshes first, and the rotated credentials are persisted
 * back onto the action. An `access_token` alone means a HubSpot **Private App** token — non-expiring,
 * no OAuth flow, no client id or secret needed — and is used directly. An action with neither is not
 * connected and is skipped, which is what makes the whole CRM layer a no-op for an unconfigured agent.
 *
 * ## Test records get their own owner and meeting link
 *
 * `resolveMeetingSlug` and `resolveOwnerId` both branch on `record_type == "Test"`, and they must stay
 * in step: the record owner should be the owner of the calendar being booked, so the CRM owner and the
 * meeting organizer line up. The practical effect is that an E2E run never books on, or assigns records
 * to, the real rep.
 *
 * ## Contact matching is ordered by how much it can be trusted
 *
 * Email (exact) → phone (last-10 NANP, checking both `phone` and `mobilephone`) → first AND last name
 * exact. The name match requires both parts, because matching on a first name alone would merge
 * strangers. `findExistingContact` stops at the first hit.
 *
 * ## An email change ADDS, never replaces
 *
 * `preservePriorEmailOnContact` appends to `hs_additional_emails` and preserves both the primary and
 * every existing secondary. It mirrors the chat's append-only `_email_history`: when the same prospect
 * moves to a new address, HubSpot must not lose the old one — that address is how prior threads,
 * bounces, and suppression entries are still attributable.
 *
 * ## Notes exist for a reason PATCHes cannot serve
 *
 * A plain property PATCH does not update HubSpot's *last activity* date; a Note engagement does. So
 * every push also writes a Note, which both keeps the CRM's activity timeline honest and leaves an
 * audit trail of what this system did.
 */

import { getAgentActions, updateAgentActionAuth } from '../firebase/agent';
import { getMemory } from '../firebase/chat';
import { normalizePhone } from './dncFullScrub';
import { envStr } from '../config';
import type { AgentAction } from '../firebase/agent';

export const HUBSPOT_BASE = 'https://api.hubapi.com';

/** The contact-level funnel stages. `Lead` and beyond live on the deal. */
export const CONTACT_STAGES = ['New', 'Contacted', 'Engaged'] as const;

/** HubSpot's default association type id for Deal → Contact. */
export const DEAL_TO_CONTACT_ASSOC_TYPE_ID = 3;

/**
 * Funnel ordering for the forward-only sync guard.
 *
 * `Lost` is deliberately ABSENT: it is terminal and must always be allowed to sync, in either
 * direction, rather than being blocked by a rank comparison.
 */
export const STAGE_RANK: Record<string, number> = {
  New: 0,
  Contacted: 1,
  Engaged: 2,
  Lead: 3,
};

/**
 * Note → Contact and Note → Deal association type ids.
 *
 * HubSpot-defined constants, verified against `/crm/v4/associations/notes/{contacts,deals}/labels`.
 */
export const NOTE_TO_CONTACT_ASSOC_TYPE_ID = 202;
export const NOTE_TO_DEAL_ASSOC_TYPE_ID = 214;

const REQUEST_TIMEOUT_MS = 30_000;

/** Authorized JSON headers. */
export function hsHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export interface HubspotConfig {
  refresh_token?: string;
  access_token?: string;
  action_id?: string;
  contact_stage_property: string;
  stage_values: Record<string, string>;
  source_property: string;
  source_value: string;
  source_value_inbound: string;
  env_property: string;
  env_default_value: string;
  pipeline_id?: string;
  stage_ids: Record<string, string>;
  meeting_slug?: string;
  meeting_slug_test?: string;
  owner_id?: string;
  owner_id_test?: string;
}

/**
 * Pull the active HubSpot **v2** action's configuration, or `{}` when unconfigured.
 *
 * See the module note on why this keys on `provider`. Every default here matters: an agent that
 * connected HubSpot without customizing anything still gets a working stage property, source value, and
 * environment property.
 */
export function resolveHubspotConfig(
  actions: AgentAction[] | null | undefined
): Partial<HubspotConfig> {
  for (const action of actions ?? []) {
    if (action.status !== 'active') continue;

    const provider = String(
      (action as Record<string, unknown>).provider ?? ''
    ).toLowerCase();
    const atype = String(action.type ?? '').toLowerCase();
    // Only the dedicated v2 provider — a legacy "hubspot" action is ignored entirely.
    if (provider !== 'hubspot_v2' && atype !== 'hubspot_v2') continue;

    const meta = ((action as Record<string, unknown>).additional_meta ??
      {}) as Record<string, unknown>;
    const auth = ((action as Record<string, unknown>).auth ?? {}) as Record<
      string,
      unknown
    >;
    const refreshToken = auth.refresh_token as string | undefined;
    const accessToken = auth.access_token as string | undefined;
    // Neither an OAuth refresh token nor a Private App token → not connected yet.
    if (!refreshToken && !accessToken) continue;

    const meetingLink = (meta.meeting_link ?? {}) as Record<string, unknown>;

    return {
      refresh_token: refreshToken,
      access_token: accessToken,
      action_id: action.id,
      contact_stage_property:
        (meta.contact_stage_property as string) || 'hs_lead_status',
      stage_values: (meta.stage_values as Record<string, string>) || {},
      source_property: (meta.source_property as string) || 'lead_source',
      source_value: (meta.source_value as string) || 'Lily Outbound Comms',
      source_value_inbound:
        (meta.source_value_inbound as string) ||
        'Ava Inbound Comms - Web Widget',
      env_property: (meta.env_property as string) || 'record_type',
      env_default_value: (meta.env_default_value as string) || 'Real',
      pipeline_id: meta.pipeline_id as string | undefined,
      stage_ids: (meta.stage_ids as Record<string, string>) || {},
      meeting_slug:
        (meta.meeting_slug as string) ||
        (meetingLink.slug as string | undefined),
      meeting_slug_test: meta.meeting_slug_test as string | undefined,
      // The owner stamped on new contacts; deals inherit it. Should be the owner of the connected
      // meeting calendar, so the record owner and the meeting organizer are the same person.
      owner_id:
        (meta.owner_id as string) ||
        (meetingLink.owner_id as string | undefined),
      owner_id_test: meta.owner_id_test as string | undefined,
    };
  }
  return {};
}

function isTestRecordType(recordType: unknown): boolean {
  return (
    String(recordType ?? '')
      .trim()
      .toLowerCase() === 'test'
  );
}

/**
 * The meeting-link slug for this chat: the test slug for a `Test` record when one is configured,
 * otherwise the real slug. Keeps E2E bookings off the real rep's calendar.
 */
export function resolveMeetingSlug(
  cfg: Partial<HubspotConfig>,
  recordType: unknown
): string | undefined {
  if (isTestRecordType(recordType) && cfg.meeting_slug_test) {
    return cfg.meeting_slug_test;
  }
  return cfg.meeting_slug;
}

/**
 * The record owner, picked the SAME way as the meeting slug — see the module note on why the two must
 * stay in step.
 */
export function resolveOwnerId(
  cfg: Partial<HubspotConfig>,
  recordType: unknown
): string | undefined {
  if (isTestRecordType(recordType) && cfg.owner_id_test) {
    return cfg.owner_id_test;
  }
  return cfg.owner_id;
}

export interface HubspotAuth {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Exchange a refresh token for a fresh access token, and persist the result on the action.
 *
 * The new `refresh_token` is stored too, defaulting to the one we sent: HubSpot may rotate it, and
 * keeping a stale one would break every later call.
 */
export async function refreshHubspotToken(
  refreshToken: string,
  agentId: string,
  actionId: string | undefined
): Promise<HubspotAuth | null> {
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/oauth/v1/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: envStr('HUBSPOT_CLIENT_ID'),
        client_secret: envStr('HUBSPOT_CLIENT_SECRET'),
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.error(
        `[HS] token refresh ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return null;
    }
    const t = (await resp.json()) as Record<string, unknown>;
    const auth: HubspotAuth = {
      access_token: String(t.access_token),
      refresh_token: (t.refresh_token as string) ?? refreshToken,
      expires_in: (t.expires_in as number) ?? 1800,
      token_type: (t.token_type as string) ?? 'bearer',
    };
    if (agentId && actionId) {
      try {
        await updateAgentActionAuth(agentId, actionId, {
          ...auth,
        } as Record<string, unknown>);
      } catch (e) {
        console.warn(`[HS] persist refreshed auth failed: ${e}`);
      }
    }
    return auth;
  } catch (e) {
    console.error(`[HS] token refresh error: ${e}`);
    return null;
  }
}

/**
 * A usable bearer token for this config — see the module note on the two authentication modes.
 *
 * `null` means "not connected", which every caller treats as "skip the CRM mirror".
 */
export async function accessToken(
  cfg: Partial<HubspotConfig>,
  agentId: string
): Promise<string | null> {
  if (cfg.refresh_token) {
    const auth = await refreshHubspotToken(
      cfg.refresh_token,
      agentId,
      cfg.action_id
    );
    return auth?.access_token ?? null;
  }
  return cfg.access_token ?? null;
}

/** POST a CRM search and return the first result's id, or `null`. Never throws. */
async function searchFirstId(
  token: string,
  body: Record<string, unknown>,
  label: string
): Promise<string | null> {
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200) {
      const results = ((await resp.json()) as Record<string, unknown>)
        .results as Array<Record<string, unknown>> | undefined;
      if (results && results.length > 0) return String(results[0].id);
    }
  } catch (e) {
    console.warn(`[HS] ${label} failed: ${e}`);
  }
  return null;
}

/** Exact-email contact lookup — the strongest signal. */
export async function findContactByEmail(
  token: string,
  email: string
): Promise<string | null> {
  return searchFirstId(
    token,
    {
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: email }] },
      ],
      properties: ['email'],
      limit: 1,
    },
    'contact search'
  );
}

/**
 * Contact lookup by phone, checking BOTH `phone` and `mobilephone`.
 *
 * Matches on the last-10 NANP digits via `CONTAINS_TOKEN`, because the same number is stored in half a
 * dozen formats across a real CRM. Anything that does not normalize to 10 digits is not searched: a
 * partial number would match strangers.
 */
export async function findContactByPhone(
  token: string,
  phone: string
): Promise<string | null> {
  const p = normalizePhone(phone ?? '');
  if (p.length !== 10) return null;
  return searchFirstId(
    token,
    {
      // Two filter GROUPS — HubSpot ORs groups and ANDs filters within one, so this is phone OR mobile.
      filterGroups: [
        {
          filters: [
            { propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: p },
          ],
        },
        {
          filters: [
            {
              propertyName: 'mobilephone',
              operator: 'CONTAINS_TOKEN',
              value: p,
            },
          ],
        },
      ],
      properties: ['email'],
      limit: 1,
    },
    'contact search by phone'
  );
}

/** Contact lookup by first AND last name. Both are required — see the module note. */
export async function findContactByName(
  token: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined
): Promise<string | null> {
  const fn = String(firstName ?? '').trim();
  const ln = String(lastName ?? '').trim();
  if (!fn || !ln) return null;
  return searchFirstId(
    token,
    {
      filterGroups: [
        {
          filters: [
            { propertyName: 'firstname', operator: 'EQ', value: fn },
            { propertyName: 'lastname', operator: 'EQ', value: ln },
          ],
        },
      ],
      properties: ['email'],
      limit: 1,
    },
    'contact search by name'
  );
}

/**
 * Does a contact already exist for what we know? Returns the first match's id, or `null`.
 *
 * Ordered by trustworthiness: email, then phone, then full name. See the module note.
 */
export async function findExistingContact(
  token: string,
  opts: {
    email?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } = {}
): Promise<string | null> {
  const email = String(opts.email ?? '').trim();
  if (email) {
    const cid = await findContactByEmail(token, email.toLowerCase());
    if (cid) return cid;
  }
  if (opts.phone) {
    const cid = await findContactByPhone(token, opts.phone);
    if (cid) return cid;
  }
  return findContactByName(token, opts.firstName, opts.lastName);
}

/** Drop empty values — HubSpot treats an empty string as "clear this property". */
function nonEmpty(props: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Create a contact. Returns its id, or `null`.
 *
 * A **409 is recovered, not failed**: it means the contact already exists, so the id is looked up by
 * email instead. Without that, a race between two turns would lose the contact entirely.
 */
export async function createContact(
  token: string,
  props: Record<string, unknown>
): Promise<string | null> {
  const properties = nonEmpty(props);
  if (Object.keys(properties).length === 0) return null;
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({ properties }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200 || resp.status === 201) {
      return String(((await resp.json()) as Record<string, unknown>).id);
    }
    if (resp.status === 409) {
      const email = properties.email as string | undefined;
      if (email) return findContactByEmail(token, email);
    }
    console.error(
      `[HS] create contact ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] create contact error: ${e}`);
  }
  return null;
}

/** PATCH one contact property. A falsy value is a no-op, never a clear. */
export async function updateContactProperty(
  token: string,
  contactId: string,
  prop: string,
  value: string
): Promise<boolean> {
  if (!value) return false;
  return updateContactProperties(token, contactId, { [prop]: value });
}

/**
 * PATCH several contact properties in one call. Empty values are dropped.
 *
 * Used to enrich the core fields on every stage sync, because HubSpot's own scheduler may have created
 * the contact first with only a name and email — so without this those fields are never written.
 * Idempotent: re-writing identical values is a no-op on HubSpot's side.
 */
export async function updateContactProperties(
  token: string,
  contactId: string,
  props: Record<string, unknown>
): Promise<boolean> {
  const properties = nonEmpty(props);
  if (Object.keys(properties).length === 0) return false;
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}`,
      {
        method: 'PATCH',
        headers: hsHeaders(token),
        body: JSON.stringify({ properties }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status === 200 || resp.status === 201) return true;
    console.error(
      `[HS] update contact props ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] update contact props error: ${e}`);
  }
  return false;
}

/**
 * Append an address to `hs_additional_emails`, preserving the primary and every existing secondary.
 *
 * Returns `true` when the address is already on the contact — the goal is met, and reporting failure
 * would make an idempotent call look broken.
 */
export async function addContactSecondaryEmail(
  token: string,
  contactId: string,
  newEmail: string
): Promise<boolean> {
  const addr = String(newEmail ?? '')
    .trim()
    .toLowerCase();
  if (!contactId || !addr) return false;
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}?properties=email,hs_additional_emails`,
      {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status !== 200) {
      console.error(
        `[HS] fetch contact for secondary-email ${resp.status}: ${(await resp.text()).slice(0, 150)}`
      );
      return false;
    }
    const props = (((await resp.json()) as Record<string, unknown>)
      .properties ?? {}) as Record<string, unknown>;
    const primary = String(props.email ?? '')
      .trim()
      .toLowerCase();
    const existing = String(props.hs_additional_emails ?? '')
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (addr === primary || existing.includes(addr)) return true;

    const merged = [...existing, addr].join(';');
    const ok = await updateContactProperties(token, contactId, {
      hs_additional_emails: merged,
    });
    if (ok) {
      console.log(
        `[HS] added secondary email to contact ${contactId} (kept primary + ${existing.length} prior)`
      );
    }
    return ok;
  } catch (e) {
    console.error(`[HS] add secondary email error: ${e}`);
    return false;
  }
}

/**
 * The same prospect moved to a different address → add the NEW one as a secondary, keeping the old.
 *
 * Mirrors the chat's append-only `_email_history`: nothing is deleted. Closes the seam the review
 * orchestrator left open in Phase 7b²b².
 */
export async function preservePriorEmailOnContact(
  chatId: string,
  agentId: string,
  actions: AgentAction[] | null | undefined,
  newEmail: string
): Promise<boolean> {
  try {
    const mem = (await getMemory(chatId)) ?? {};
    const contactId = mem.hubspot_contact_id as string | undefined;
    if (!contactId || !String(newEmail ?? '').trim()) return false;

    let acts = actions;
    if ((!acts || acts.length === 0) && agentId) {
      acts = (await getAgentActions(agentId)) ?? [];
    }
    const cfg = resolveHubspotConfig(acts ?? []);
    const token = await accessToken(cfg, agentId);
    if (!token) return false;

    return addContactSecondaryEmail(token, contactId, newEmail);
  } catch (e) {
    console.warn(
      `[HS] preservePriorEmailOnContact failed chat=${chatId}: ${e}`
    );
    return false;
  }
}

/** Create a Note engagement, associated to a contact or a deal. See the module note on why. */
async function createNote(
  token: string,
  objectId: string,
  body: string,
  assocTypeId: number,
  label: string
): Promise<boolean> {
  if (!objectId || !body) return false;
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({
        properties: { hs_note_body: body, hs_timestamp: Date.now() },
        associations: [
          {
            to: { id: objectId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: assocTypeId,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200 || resp.status === 201) return true;
    console.error(
      `[HS] create ${label} ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] create ${label} error: ${e}`);
  }
  return false;
}

/** A Note on the contact. Updates HubSpot's last-activity date, which a property PATCH does not. */
export async function logHubspotNote(
  token: string,
  contactId: string,
  body: string
): Promise<boolean> {
  return createNote(
    token,
    contactId,
    body,
    NOTE_TO_CONTACT_ASSOC_TYPE_ID,
    'note'
  );
}

/** A Note on the deal — the rep-facing brief lands here. */
export async function logHubspotDealNote(
  token: string,
  dealId: string,
  body: string
): Promise<boolean> {
  return createNote(
    token,
    dealId,
    body,
    NOTE_TO_DEAL_ASSOC_TYPE_ID,
    'deal note'
  );
}

/** Delete any CRM object by type and id. Used by the test-data teardown. */
export async function deleteObject(
  token: string,
  objectType: string,
  objectId: string
): Promise<boolean> {
  if (!objectId) return false;
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/${objectType}/${objectId}`,
      {
        method: 'DELETE',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    // 204 is the documented success; 404 means it is already gone, which meets the goal.
    if (resp.status === 204 || resp.status === 200 || resp.status === 404) {
      return true;
    }
    console.error(
      `[HS] delete ${objectType} ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] delete ${objectType} error: ${e}`);
  }
  return false;
}

export const __testing = { nonEmpty, isTestRecordType, searchFirstId };
