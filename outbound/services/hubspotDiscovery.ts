/**
 * HubSpot owners, meeting links, property options, and config discovery.
 *
 * This is the read side the FE's two-step admin setup calls: everything needed to populate the HubSpot
 * v2 config dropdowns, plus the one write that adds a dropdown option to a managed property.
 *
 * ## `list_owners` is fetched once and threaded through
 *
 * `listMeetingLinks` needs owners to resolve each link's organizer, and `discoverHubspotConfig` needs
 * them for its own list. Passing the fetched list in avoids a second full pagination — which matters,
 * because a portal with hundreds of owners is 100 per page.
 *
 * ## A meeting link's organizer is what BINDS the record owner
 *
 * The FE shows the owner when a link is chosen and binds the record owner FROM it (real → `owner_id`,
 * test → `owner_id_test`). That is what keeps the CRM record owner and the meeting organizer the same
 * person — the invariant Phase 9a's `resolveOwnerId` depends on. The mapping goes through `userId`,
 * because a link names its organizer by USER id while contacts and deals are stamped with the OWNER id.
 *
 * ## Only two properties may have options added
 *
 * `addPropertyOption` refuses anything outside `MANAGED_CONTACT_PROPERTIES`. Adding an option to an
 * arbitrary property from an admin screen is a schema edit on someone else's CRM, so the allowlist is
 * the guard, not a convenience.
 *
 * It is also idempotent: an option whose value OR label already exists returns `added: false` rather
 * than duplicating it — HubSpot happily accepts two options with the same label, which then renders as
 * a confusing duplicate dropdown entry nobody can remove from the UI.
 *
 * ## Both paginators carry a hard safety cap
 *
 * Ten pages for links, twenty for owners. A malformed `paging.next` that never clears would otherwise
 * loop forever against a live API; the cap turns that into a truncated result plus a log line.
 *
 * ## Deferred
 *
 * The deal-funnel analytics (`deal_funnel_counts` and its stage-attribution scan) move to Phase 10 with
 * `views/deal_funnel.py`, the endpoint that is their only consumer — consistent with how every other
 * view has been handled.
 */

import { HUBSPOT_BASE, hsHeaders } from './hubspot';
import { getAvailableStages, DEFAULT_STAGES } from '../firebase/skills';

const REQUEST_TIMEOUT_MS = 30_000;

/** The only contact properties an admin screen may add options to. See the module note. */
export const MANAGED_CONTACT_PROPERTIES = [
  'hs_lead_status',
  'lead_source',
] as const;

/** Pagination safety caps — see the module note. */
const MAX_LINK_PAGES = 10;
const MAX_OWNER_PAGES = 20;

export interface HubspotOwner {
  id?: string;
  user_id?: string;
  email?: string;
  name?: string;
}

export interface MeetingLink {
  slug?: string;
  name?: string;
  owner_id?: string;
  owner_name?: string;
  owner_email?: string;
}

/**
 * Active HubSpot owners.
 *
 * `id` is the `hubspot_owner_id` stamped on contacts and deals; `user_id` is what a meeting link's
 * `organizerUserId` refers to. They are different identifiers for the same person, and conflating them
 * is why the mapping below goes through `user_id`.
 */
export async function listOwners(token: string): Promise<HubspotOwner[]> {
  const owners: HubspotOwner[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; page < MAX_OWNER_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: '100' });
      if (after) params.set('after', after);
      const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/owners?${params}`, {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (resp.status !== 200) {
        console.error(
          `[HS] owners ${resp.status}: ${(await resp.text()).slice(0, 200)}`
        );
        break;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      for (const o of (data.results ?? []) as Array<Record<string, unknown>>) {
        const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
        owners.push({
          id: o.id as string,
          user_id: o.userId as string,
          email: o.email as string,
          // Never blank: a nameless owner still needs something to show in a dropdown.
          name: name || (o.email as string) || (o.id as string),
        });
      }
      after = (
        ((data.paging ?? {}) as Record<string, unknown>).next as
          | Record<string, unknown>
          | undefined
      )?.after as string | undefined;
      if (!after) break;
    }
  } catch (e) {
    console.error(`[HS] listOwners: ${e}`);
  }
  return owners;
}

/**
 * Meeting links, each with its organizer resolved to a HubSpot owner.
 *
 * Pass `owners` (from `listOwners`) to avoid a second full pagination.
 */
export async function listMeetingLinks(
  token: string,
  ownersIn?: HubspotOwner[] | null
): Promise<MeetingLink[]> {
  const owners = ownersIn ?? (await listOwners(token));
  const ownersByUser = new Map<string, HubspotOwner>();
  for (const o of owners) {
    if (o.user_id) ownersByUser.set(String(o.user_id), o);
  }

  const links: MeetingLink[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; page < MAX_LINK_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: '100' });
      if (after) params.set('after', after);
      const resp = await fetch(
        `${HUBSPOT_BASE}/scheduler/v3/meetings/meeting-links?${params}`,
        {
          method: 'GET',
          headers: hsHeaders(token),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
      if (resp.status !== 200) {
        console.error(
          `[HS] meeting-links ${resp.status}: ${(await resp.text()).slice(0, 200)}`
        );
        break;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      for (const m of (data.results ?? []) as Array<Record<string, unknown>>) {
        // organizerUserId is a USER id; contacts and deals carry the OWNER id.
        const owner = ownersByUser.get(String(m.organizerUserId ?? '')) ?? {};
        links.push({
          slug: m.slug as string,
          name: m.name as string,
          owner_id: owner.id,
          owner_name: owner.name,
          owner_email: owner.email,
        });
      }
      after = (
        ((data.paging ?? {}) as Record<string, unknown>).next as
          | Record<string, unknown>
          | undefined
      )?.after as string | undefined;
      if (!after) break;
    }
  } catch (e) {
    console.error(`[HS] listMeetingLinks: ${e}`);
  }
  return links;
}

/**
 * An owner id → a display name.
 *
 * This is what lets the agent tell a prospect who they will be meeting. Falls back to the email when
 * the owner has no name set, and `null` only when there is nothing usable at all.
 */
export async function resolveOwnerName(
  token: string,
  ownerId: unknown
): Promise<string | null> {
  const oid = String(ownerId ?? '').trim();
  if (!oid) return null;
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/owners/${oid}`, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.warn(
        `[HS] owner ${oid} lookup ${resp.status}: ${(await resp.text()).slice(0, 150)}`
      );
      return null;
    }
    const o = ((await resp.json()) ?? {}) as Record<string, unknown>;
    const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
    return name || (o.email as string) || null;
  } catch (e) {
    console.warn(`[HS] resolveOwnerName failed for ${oid}: ${e}`);
    return null;
  }
}

/** Visible options for a contact enumeration property. `[]` for a free-text or missing property. */
export async function listPropertyOptions(
  token: string,
  propertyName: string
): Promise<Array<{ label: unknown; value: unknown }>> {
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/properties/contacts/${propertyName}`,
      {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status !== 200) {
      console.warn(
        `[HS] property ${propertyName} ${resp.status}: ${(await resp.text()).slice(0, 150)}`
      );
      return [];
    }
    const options = (((await resp.json()) as Record<string, unknown>).options ??
      []) as Array<Record<string, unknown>>;
    // Hidden options are archived in HubSpot's UI and must not reappear in ours.
    return options
      .filter((o) => !o.hidden)
      .map((o) => ({ label: o.label, value: o.value }));
  } catch (e) {
    console.error(`[HS] listPropertyOptions(${propertyName}): ${e}`);
    return [];
  }
}

export interface AddOptionResult {
  success: boolean;
  added?: boolean;
  options?: Array<{ label: unknown; value: unknown }>;
  error?: string;
}

/**
 * Add an option to a MANAGED contact enumeration property. Idempotent.
 *
 * Refuses any property outside the allowlist — see the module note. Fetches the current options,
 * appends, and PATCHes the whole list back, because HubSpot replaces rather than merges. An option
 * matching on value OR label already present returns `added: false`: HubSpot accepts duplicate labels
 * and they render as an unremovable duplicate in the UI.
 */
export async function addPropertyOption(
  token: string,
  propertyName: string,
  label: string,
  valueIn?: string | null
): Promise<AddOptionResult> {
  if (
    !(MANAGED_CONTACT_PROPERTIES as readonly string[]).includes(propertyName)
  ) {
    return {
      success: false,
      error: `property_name must be one of ${MANAGED_CONTACT_PROPERTIES.join(', ')}`,
    };
  }
  const value = valueIn || label;
  const url = `${HUBSPOT_BASE}/crm/v3/properties/contacts/${propertyName}`;
  const visible = (opts: Array<Record<string, unknown>>) =>
    opts
      .filter((o) => !o.hidden)
      .map((o) => ({ label: o.label, value: o.value }));

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      return {
        success: false,
        error: `fetch ${propertyName} ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      };
    }
    const options = (((await resp.json()) as Record<string, unknown>).options ??
      []) as Array<Record<string, unknown>>;

    if (options.some((o) => o.value === value || o.label === label)) {
      return { success: true, added: false, options: visible(options) };
    }

    options.push({
      label,
      value,
      displayOrder: options.length,
      hidden: false,
    });
    const patch = await fetch(url, {
      method: 'PATCH',
      headers: hsHeaders(token),
      body: JSON.stringify({ options }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (patch.status === 200 || patch.status === 201) {
      const patched = (((await patch.json()) as Record<string, unknown>)
        .options ?? options) as Array<Record<string, unknown>>;
      return { success: true, added: true, options: visible(patched) };
    }
    return {
      success: false,
      error: `patch ${patch.status}: ${(await patch.text()).slice(0, 200)}`,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** Deal pipelines and their stages, for mapping Lead/Lost onto deal-stage ids. */
export async function listDealPipelines(
  token: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/pipelines/deals`, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.error(
        `[HS] deal pipelines ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return [];
    }
    const results = (((await resp.json()) as Record<string, unknown>).results ??
      []) as Array<Record<string, unknown>>;
    return results.map((p) => ({
      id: p.id,
      label: p.label,
      stages: ((p.stages ?? []) as Array<Record<string, unknown>>)
        .slice()
        .sort(
          (a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0)
        )
        .map((s) => ({
          id: s.id,
          label: s.label,
          display_order: s.displayOrder,
        })),
    }));
  } catch (e) {
    console.error(`[HS] listDealPipelines: ${e}`);
    return [];
  }
}

export interface DiscoveredConfig {
  outbound_stages: string[];
  pipelines: Array<Record<string, unknown>>;
  meeting_links: MeetingLink[];
  owners: HubspotOwner[];
  lead_status_options: Array<{ label: unknown; value: unknown }>;
  source_options: Array<{ label: unknown; value: unknown }>;
}

/**
 * Everything the FE needs to populate the HubSpot v2 config dropdowns.
 *
 * Owners are fetched ONCE and reused for the meeting-link organizer resolution — see the module note.
 * The agent's own funnel stages come first, falling back to the defaults, so the mapping UI offers the
 * stages this agent actually uses.
 */
export async function discoverHubspotConfig(
  token: string,
  agentId?: string | null
): Promise<DiscoveredConfig> {
  let outboundStages: string[];
  try {
    outboundStages = agentId
      ? await getAvailableStages(agentId)
      : [...DEFAULT_STAGES];
  } catch {
    outboundStages = [...DEFAULT_STAGES];
  }

  const owners = await listOwners(token);
  const [pipelines, meetingLinks, leadStatusOptions, sourceOptions] =
    await Promise.all([
      listDealPipelines(token),
      listMeetingLinks(token, owners),
      listPropertyOptions(token, 'hs_lead_status'),
      listPropertyOptions(token, 'lead_source'),
    ]);

  return {
    outbound_stages: outboundStages,
    pipelines,
    meeting_links: meetingLinks,
    owners,
    lead_status_options: leadStatusOptions,
    source_options: sourceOptions,
  };
}
