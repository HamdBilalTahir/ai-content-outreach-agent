/**
 * The seven HubSpot admin/preview endpoints — the port of `views/hubspot_discovery.py`.
 *
 * These serve the FE's two-step HubSpot setup and its campaign audience picker. Everything is read-only
 * except `add-property-option` (which edits a CRM property) and `delete-records` (the E2E teardown).
 *
 * ## The token is resolved two ways, and the two resolvers prefer OPPOSITE sources
 *
 * `resolveToken` prefers a directly-supplied `access_token`; `resolveConfig` prefers `agent_id`. That
 * looks inconsistent and is not:
 *
 *  - **Step 1 of setup has no saved action yet.** The FE holds a Private-App token the user just pasted
 *    and needs discovery to work against it, so a supplied token wins wherever a bare token suffices.
 *  - **The list/search helpers refresh the token internally**, which needs the whole config — a bare
 *    `access_token` cannot be refreshed. An `agent_id` yields a refreshable config, so it wins there.
 *
 * Both still accept either input; only the preference order differs, and it differs because the two
 * callers need different things from the answer.
 *
 * ## Why the audience preview excludes on TWO different keys
 *
 * `campaignExcludes` hides contacts already enrolled in this campaign, by contact id. But a shared
 * dealership line means a *distinct* contact carries the *same* phone, which an id-based exclusion
 * cannot see — and enrollment would collapse it onto the existing chat. `campaignChannelKeys` catches
 * that, so the preview count matches what enrollment will actually create. Both are empty without a
 * `campaign_id`, which is what the "Add more" flow supplies.
 *
 * ## `delete-records` is gated twice, and both gates are hard
 *
 * The caller must declare `record_type: "Test"`, and when a `chat_id` is given the chat's own
 * `memory.record_type` must also be Test. A real prospect's CRM records cannot be deleted through this
 * route by any payload. The memory cleanup afterwards is deliberately conditional on the delete having
 * SUCCEEDED — clearing the id on a failure would leave a live CRM record with nothing pointing at it.
 */

import { getAgentActions } from '../firebase/agent';
import { getMemory, setMemory } from '../firebase/chat';
import {
  accessToken,
  deleteHubspotRecords,
  resolveHubspotConfig,
} from '../services/hubspot';
import type { HubspotConfig } from '../services/hubspot';
import {
  MANAGED_CONTACT_PROPERTIES,
  addPropertyOption,
  discoverHubspotConfig,
} from '../services/hubspotDiscovery';
import {
  allContactPropertyNames,
  dropExcludedMembers,
  fetchHubspotListMembers,
  listHubspotContactProperties,
  listHubspotLists,
  searchHubspotContacts,
} from '../services/hubspotAudiences';
import { enrolledChannelKeys, enrolledContactIds } from '../services/campaigns';
import { json } from './types';
import type { OutboundRequest, OutboundResponse } from './types';

type Body = Record<string, unknown>;

const NEEDS_AUTH = { error: 'access_token or agent_id required' };

/** Prefer a directly-supplied token, then a saved action's. See the module note on why. */
async function resolveToken(body: Body): Promise<string | null> {
  const supplied = body.access_token;
  if (supplied) return String(supplied);
  const agentId = body.agent_id;
  if (agentId) {
    const cfg = resolveHubspotConfig(
      (await getAgentActions(String(agentId))) ?? []
    );
    return await accessToken(cfg, String(agentId));
  }
  return null;
}

/** Prefer `agent_id`, because only a full config can be refreshed. See the module note. */
async function resolveConfig(
  body: Body
): Promise<[Partial<HubspotConfig> | null, string]> {
  const agentId = body.agent_id;
  if (agentId) {
    return [
      resolveHubspotConfig((await getAgentActions(String(agentId))) ?? []),
      String(agentId),
    ];
  }
  const token = body.access_token;
  if (token) return [{ access_token: String(token) }, ''];
  return [null, ''];
}

/**
 * The FE's de-selections, plus everything already enrolled in this campaign.
 *
 * A set, so a contact the FE also de-selected is not counted twice. Empty of campaign ids without a
 * `campaign_id` — a fresh campaign has nothing enrolled to hide.
 */
async function campaignExcludes(body: Body): Promise<string[]> {
  const excl = new Set(
    ((body.exclude_contact_ids as unknown[]) ?? [])
      .filter((x) => x !== null && x !== undefined && x !== '')
      .map((x) => String(x))
  );
  const campaignId = body.campaign_id;
  if (campaignId) {
    for (const id of await enrolledContactIds(String(campaignId))) excl.add(id);
  }
  return [...excl];
}

/**
 * The phone/email channel keys already enrolled — the second exclusion axis.
 *
 * Fails OPEN to an empty set: a preview that cannot read the campaign's keys should show a slightly
 * inflated count, not error out and leave the picker blank.
 */
async function campaignChannelKeys(body: Body): Promise<Set<string>> {
  const campaignId = body.campaign_id;
  if (!campaignId) return new Set();
  try {
    return await enrolledChannelKeys(String(campaignId));
  } catch (e) {
    console.warn(`[OB] campaignChannelKeys failed for ${campaignId}: ${e}`);
    return new Set();
  }
}

/**
 * Which HubSpot properties the preview wants per contact: everything, an explicit list, or the lean
 * default (`null`).
 *
 * `all_properties` is best-effort — a failed property listing falls through to the explicit list rather
 * than failing the preview, because rendering fewer columns beats rendering nothing.
 */
async function requestedProperties(body: Body): Promise<string[] | null> {
  if (body.all_properties) {
    const token = await resolveToken(body);
    if (token) {
      try {
        return await allContactPropertyNames(token);
      } catch (e) {
        console.warn(`[OB] all_properties resolution failed: ${e}`);
      }
    }
  }
  const props = body.properties;
  return Array.isArray(props) && props.length > 0 ? (props as string[]) : null;
}

/**
 * `bool(data.get("exclude_contacted", True))`.
 *
 * The default fires only on an ABSENT key; a present value is then read for truthiness. So an explicit
 * `null` means OFF — the same absent-vs-null distinction the campaign create view handles, and the
 * second place in the port where `??` would have silently turned cross-campaign dedup back on.
 */
function excludeContactedFlag(body: Body): boolean {
  return body.exclude_contacted === undefined
    ? true
    : Boolean(body.exclude_contacted);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /hubspot/discovery/  and  /hubspot/property-option/
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the FE's config dropdowns need, in one call. */
export async function hubspotDiscoveryView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const token = await resolveToken(body);
  if (!token) return json(NEEDS_AUTH, 400);
  // `agent_id` is the agent this config is FOR, and drives `outbound_stages` from its available stages.
  const agentId = body.agent_id ? String(body.agent_id) : undefined;
  return json(await discoverHubspotConfig(token, agentId));
}

/**
 * Add an option to a managed contact property.
 *
 * The allowlist is a hard gate, not a convenience: this writes to someone else's CRM schema, and
 * HubSpot accepts a duplicate label which then cannot be removed through its own UI.
 */
export async function hubspotAddPropertyOptionView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const token = await resolveToken(body);
  const property = body.property_name;
  const label = body.label;
  if (!token || !property || !label) {
    return json(
      { error: 'access_token/agent_id, property_name, and label required' },
      400
    );
  }
  if (
    !(MANAGED_CONTACT_PROPERTIES as readonly string[]).includes(
      String(property)
    )
  ) {
    return json(
      {
        error: `property_name must be one of ${JSON.stringify(MANAGED_CONTACT_PROPERTIES)}`,
      },
      400
    );
  }
  return json(
    await addPropertyOption(
      token,
      String(property),
      String(label),
      body.value as string | undefined
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The audience picker: lists, list members, contact properties, search
// ─────────────────────────────────────────────────────────────────────────────

/** The portal's contact lists, for the FE dropdown. */
export async function hubspotListsView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const token = await resolveToken(request.body);
  if (!token) return json(NEEDS_AUTH, 400);
  return json({ lists: await listHubspotLists(token) });
}

/** One page of a list's members as lead payloads, with the add-more exclusions applied. */
export async function hubspotListMembersView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const [cfg, agentId] = await resolveConfig(body);
  const listId = body.list_id;
  if (!cfg) return json(NEEDS_AUTH, 400);
  if (!listId) return json({ error: 'list_id required' }, 400);

  const result = await fetchHubspotListMembers(cfg, agentId, String(listId), {
    after: (body.cursor as string) ?? null,
    limit: (body.limit as number) ?? 100,
    properties: await requestedProperties(body),
    areaCodes: body.area_codes,
  });

  // Both exclusion axes — see the module note on why one is not enough.
  const excl = await campaignExcludes(body);
  const channelKeys = await campaignChannelKeys(body);
  if ((excl.length > 0 || channelKeys.size > 0) && result.members?.length) {
    result.members = dropExcludedMembers(result.members, excl, channelKeys);
  }
  return json(result);
}

/** Every contact property with its options, so the FE can build the filter UI. */
export async function hubspotContactPropertiesView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const token = await resolveToken(request.body);
  if (!token) return json(NEEDS_AUTH, 400);
  return json({ properties: await listHubspotContactProperties(token) });
}

/**
 * Search contacts, returning lead payloads plus the preview `total`.
 *
 * Contact-id exclusions go INTO the search (so `total` reflects them), while the channel-key pass runs
 * after — the search API has no way to express "a different contact that shares this phone".
 */
export async function hubspotSearchContactsView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const [cfg, agentId] = await resolveConfig(body);
  if (!cfg) return json(NEEDS_AUTH, 400);

  const result = await searchHubspotContacts(cfg, agentId, {
    filters: body.filters as unknown[] | null,
    filterGroups: (body.filterGroups ?? body.filter_groups) as unknown[] | null,
    after: (body.cursor as string) ?? null,
    limit: (body.limit as number) ?? 100,
    properties: await requestedProperties(body),
    excludeContacted: excludeContactedFlag(body),
    excludeContactIds: await campaignExcludes(body),
    areaCodes: body.area_codes,
  });

  const channelKeys = await campaignChannelKeys(body);
  if (channelKeys.size > 0 && result.members?.length) {
    result.members = dropExcludedMembers(result.members, null, channelKeys);
  }
  return json(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /hubspot/delete-records/
// ─────────────────────────────────────────────────────────────────────────────

/** Delete a Test contact and/or deal. Gated twice — see the module note. */
export async function hubspotDeleteRecordsView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;

  // Hard gate #1 — the caller must declare Test.
  if (
    String(body.record_type ?? '')
      .trim()
      .toLowerCase() !== 'test'
  ) {
    return json(
      { error: "refusing to delete — record_type must be 'Test'" },
      400
    );
  }

  let agentId = body.agent_id ? String(body.agent_id) : '';
  let contactId = body.contact_id ? String(body.contact_id) : '';
  let dealId = body.deal_id ? String(body.deal_id) : '';
  const chatId = body.chat_id ? String(body.chat_id) : '';

  if (chatId) {
    const memory = (await getMemory(chatId)) ?? {};
    // Hard gate #2 — the chat itself must be a Test record. A missing or unreadable chat reads as not
    // Test and is REFUSED, which is the only safe direction for a delete.
    if (
      String(memory.record_type ?? '')
        .trim()
        .toLowerCase() !== 'test'
    ) {
      return json(
        { error: "refusing to delete — chat memory.record_type is not 'Test'" },
        400
      );
    }
    agentId = agentId || String(memory.agent_id ?? '');
    contactId = contactId || String(memory.hubspot_contact_id ?? '');
    dealId = dealId || String(memory.hubspot_deal_id ?? '');
  }

  if (!agentId) {
    return json(
      {
        error: 'agent_id (or a chat_id whose memory has agent_id) is required',
      },
      400
    );
  }
  if (!contactId && !dealId) {
    return json(
      { error: 'contact_id and/or deal_id required (none found)' },
      400
    );
  }

  const result = await deleteHubspotRecords(agentId, contactId, dealId);

  // Clear the ids so a re-run does not point at deleted records — but ONLY for a delete that actually
  // succeeded. Clearing on a failure would orphan a live CRM record.
  if (chatId && result.authenticated) {
    const updates: Record<string, unknown> = {};
    if (contactId && result.contact_deleted) updates.hubspot_contact_id = null;
    if (dealId && result.deal_deleted) updates.hubspot_deal_id = null;
    if (Object.keys(updates).length > 0) {
      try {
        await setMemory(chatId, updates);
      } catch (e) {
        console.warn(
          `[OB] delete-records: failed to clear memory ids for ${chatId}: ${e}`
        );
      }
    }
  }

  return json({ ...result, contact_id: contactId, deal_id: dealId });
}
