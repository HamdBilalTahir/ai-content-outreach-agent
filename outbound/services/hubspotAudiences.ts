/**
 * HubSpot audience selection: lists, contact search, and the enrollment stamps.
 *
 * This is what turns a HubSpot portal into a campaign audience. The FE campaign console reads through
 * here because the OAuth token lives on the agent's action, and members come back already mapped to the
 * `initiate-outbound` lead-payload shape so the FE just forwards them. Closes `resolveAudiencePage`'s
 * HubSpot sources and enroll's three contact stamps.
 *
 * ## A property must EXIST before it can be filtered on
 *
 * HubSpot search returns a 400 for an unknown property, so `ensureContactProperty` runs before any
 * filter or stamp that names a custom one. It is cached per process, and a 409 counts as success —
 * concurrent creation is the goal, not a conflict. A **boolean** property additionally needs exactly two
 * options valued `true`/`false`, or HubSpot rejects it outright.
 *
 * ## Cross-campaign dedup is permanent, and lives on the contact
 *
 * `ava_last_contacted` is stamped at enrollment and drives a `NOT_HAS_PROPERTY` exclusion on every later
 * search. It is deliberately never cleared: the point is that a contact Ava has already worked is not
 * silently re-enrolled by the next campaign.
 *
 * ## Filter groups are OR-ed, so an exclusion must be added to EVERY group
 *
 * HubSpot evaluates `filterGroups` as a disjunction. Adding the contacted-exclusion or the area-code
 * constraint to only the first group would leave every other branch unfiltered — the exclusion has to be
 * distributed across the whole DNF to hold. Both helpers do that, and a filter added to no groups at all
 * becomes a lone group rather than being dropped.
 *
 * ## An explicitly-empty area-code selection must match NOTHING
 *
 * If the caller selected area codes and none survive validation, the filter becomes `IN [""]` — a
 * sentinel that matches no contact. Returning everything instead would dial an unscrubbed audience,
 * which is the opposite of what an area-code selection is for.
 *
 * ## Area-code filtering happens server-side for search, client-side for lists
 *
 * Search filters on the backfilled `aaai_area_code` property, so HubSpot returns exactly the matches —
 * no client scan and no 10k result cap. Lists have no server-side filter, so their page is post-filtered
 * after hydration. Email-only members (no phone) are ALWAYS kept either way.
 *
 * ## `total` is HubSpot's raw count, before the area filter
 *
 * Deliberate, and worth knowing when reading the number: it is the match count for the query, not the
 * length of the returned page.
 */

import { HUBSPOT_BASE, accessToken, hsHeaders } from './hubspot';
import {
  annotateAreaCode,
  effectiveAllowed,
  phonePasses,
} from './dncAreaCodes';
import type { HubspotConfig } from './hubspot';

const REQUEST_TIMEOUT_MS = 30_000;
const PROPERTY_TIMEOUT_MS = 20_000;

/**
 * Baseline properties always fetched — everything needed to build a lead payload for enrollment.
 *
 * Preview calls can request MORE; those come back under each member's `properties` for the FE to render
 * without changing the enrollment shape.
 */
export const MEMBER_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'mobilephone',
  'company',
  'state',
  'zip',
  // Context props, carried into memory for a compressed local_scope / email blurb.
  'jobtitle',
  'city',
  'hs_timezone',
  'lifecyclestage',
  'website',
  'aaai_area_code', // backfilled; the server-side area-code filter reads it
  'aaai_website_verified_business_phone', // backfilled: phone found on the company website
];

/** Cross-campaign dedup. `ava_last_contacted` drives the exclusion; the campaign id is attribution. */
export const CONTACTED_PROP = 'ava_last_contacted';
export const CAMPAIGN_PROP = 'ava_last_campaign_id';
/** START is stamped at ENROLLMENT, so attribution exists before the contact is actually reached. */
export const CAMPAIGN_START_PROP = 'ava_last_campaign_start';
export const CAMPAIGN_END_PROP = 'ava_last_campaign_end';
/** The NANP area code of the contact's own line, backfilled and searchable. */
export const AAAI_AREA_CODE_PROP = 'aaai_area_code';
/** The Twilio CNAM caller type, stamped at enrollment from the phone screen. */
export const CONTACT_NUMBER_TYPE_PROP = 'contact_number_type';

const NUMBER_TYPES = new Set(['business', 'consumer', 'unknown']);

/** Per-process cache. Contact and deal properties are namespaced so a shared name cannot collide. */
const ENSURED_PROPS = new Set<string>();

export interface LeadPayload {
  id: string;
  contact_information: {
    email: string;
    phone_number: string;
    first_name: string;
    last_name: string;
  };
  input_data: Record<string, unknown>;
  properties: Record<string, unknown>;
  area_code?: string;
}

/** HubSpot `hs_timezone` (`america_slash_new_york`) → IANA (`America/New_York`). Best-effort. */
export function hsTimezoneToIana(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try {
    return s
      .replace(/_slash_/g, '/')
      .split('/')
      .map((part) =>
        part
          .split('_')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join('_')
      )
      .join('/');
  } catch {
    return '';
  }
}

/** The baseline properties, plus any extras. Deduped, order-preserving. */
export function reqProperties(extra?: string[] | null): string[] {
  if (!extra || extra.length === 0) return [...MEMBER_PROPERTIES];
  return [...new Set([...MEMBER_PROPERTIES, ...extra.filter(Boolean)])];
}

/**
 * Create a custom CONTACT property if it does not exist. Cached per process.
 *
 * A boolean property needs exactly two options valued `true`/`false` — HubSpot rejects it otherwise.
 */
export async function ensureContactProperty(
  token: string,
  name: string,
  label: string,
  propType: string,
  fieldType: string
): Promise<boolean> {
  if (ENSURED_PROPS.has(name)) return true;
  try {
    const r = await fetch(
      `${HUBSPOT_BASE}/crm/v3/properties/contacts/${name}`,
      {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(PROPERTY_TIMEOUT_MS),
      }
    );
    if (r.status === 200) {
      ENSURED_PROPS.add(name);
      return true;
    }
    const payload: Record<string, unknown> = {
      name,
      label,
      type: propType,
      fieldType,
      groupName: 'contactinformation',
    };
    if (propType === 'bool' || fieldType === 'booleancheckbox') {
      payload.options = [
        { label: 'Yes', value: 'true', displayOrder: 0, hidden: false },
        { label: 'No', value: 'false', displayOrder: 1, hidden: false },
      ];
    }
    const c = await fetch(`${HUBSPOT_BASE}/crm/v3/properties/contacts`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROPERTY_TIMEOUT_MS),
    });
    if ([200, 201, 409].includes(c.status)) {
      ENSURED_PROPS.add(name);
      return true;
    }
    console.warn(
      `[HS] ensure property ${name} failed ${c.status}: ${(await c.text()).slice(0, 150)}`
    );
  } catch (e) {
    console.warn(`[HS] ensureContactProperty ${name} error: ${e}`);
  }
  return false;
}

/** Both dedup properties. Returns whether `ava_last_contacted` is usable in a search filter. */
export async function ensureContactedProps(token: string): Promise<boolean> {
  const ok = await ensureContactProperty(
    token,
    CONTACTED_PROP,
    'Ava last contacted',
    'datetime',
    'date'
  );
  await ensureContactProperty(
    token,
    CAMPAIGN_PROP,
    'Ava last campaign',
    'string',
    'text'
  );
  return ok;
}

/** PATCH properties onto one contact. Shared by the three stamps. */
async function patchContact(
  token: string,
  contactId: string,
  props: Record<string, unknown>,
  label: string
): Promise<boolean> {
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}`,
      {
        method: 'PATCH',
        headers: hsHeaders(token),
        body: JSON.stringify({ properties: props }),
        signal: AbortSignal.timeout(PROPERTY_TIMEOUT_MS),
      }
    );
    if (resp.status === 200 || resp.status === 201) return true;
    console.warn(
      `[HS] stamp ${label} ${contactId} failed ${resp.status}: ${(await resp.text()).slice(0, 150)}`
    );
  } catch (e) {
    console.warn(`[HS] stamp ${label} error: ${e}`);
  }
  return false;
}

/**
 * Stamp the Twilio CNAM caller type. Anything outside the known set becomes `unknown`.
 *
 * Normalizing rather than rejecting matters: an unrecognised value from the vendor should read as
 * "we do not know", not corrupt the property with a value the filters cannot match.
 */
export async function stampContactNumberType(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  contactId: string,
  numberType: string
): Promise<boolean> {
  if (!contactId) return false;
  let nt = String(numberType ?? '')
    .trim()
    .toLowerCase();
  if (!NUMBER_TYPES.has(nt)) nt = 'unknown';
  const token = await accessToken(cfg, agentId);
  if (!token) return false;
  return patchContact(
    token,
    contactId,
    { [CONTACT_NUMBER_TYPE_PROP]: nt },
    'contact_number_type'
  );
}

/**
 * Mark a contact as contacted-by-Ava now, plus the campaign id.
 *
 * This is what makes the next campaign's search skip them. HubSpot datetimes are epoch millis.
 */
export async function stampContactContacted(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  contactId: string,
  campaignId?: string | null
): Promise<boolean> {
  if (!contactId) return false;
  const token = await accessToken(cfg, agentId);
  if (!token) return false;
  await ensureContactedProps(token);
  const props: Record<string, unknown> = { [CONTACTED_PROP]: Date.now() };
  if (campaignId) props[CAMPAIGN_PROP] = String(campaignId);
  return patchContact(token, contactId, props, 'contacted');
}

/** ISO-8601 or a Date → HubSpot's epoch-millis datetime. `null` on anything unparseable. */
export function isoToEpochMs(isoOrDate: unknown): number | null {
  if (!isoOrDate) return null;
  try {
    const d =
      isoOrDate instanceof Date ? isoOrDate : new Date(String(isoOrDate));
    if (Number.isNaN(d.getTime())) throw new Error('unparseable');
    return d.getTime();
  } catch (e) {
    console.warn(
      `[HS] isoToEpochMs(${JSON.stringify(isoOrDate)}) failed: ${e}`
    );
    return null;
  }
}

/**
 * Stamp campaign attribution and its time window.
 *
 * Only the fields provided are written — it never clears the others, so setting the END later cannot
 * wipe the campaign id or start. `campaign_id` + `start` at enrollment; `end` when the campaign stops.
 */
export async function stampContactCampaign(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  contactId: string,
  opts: {
    campaignId?: string | null;
    startMs?: number | null;
    endMs?: number | null;
  } = {}
): Promise<boolean> {
  if (!contactId) return false;
  const token = await accessToken(cfg, agentId);
  if (!token) return false;

  const props: Record<string, unknown> = {};
  if (opts.campaignId) props[CAMPAIGN_PROP] = String(opts.campaignId);
  if (opts.startMs !== undefined && opts.startMs !== null) {
    props[CAMPAIGN_START_PROP] = Math.trunc(opts.startMs);
  }
  if (opts.endMs !== undefined && opts.endMs !== null) {
    props[CAMPAIGN_END_PROP] = Math.trunc(opts.endMs);
  }
  if (Object.keys(props).length === 0) return false;

  await ensureContactedProps(token);
  await ensureContactProperty(
    token,
    CAMPAIGN_START_PROP,
    'Ava last campaign start',
    'datetime',
    'date'
  );
  await ensureContactProperty(
    token,
    CAMPAIGN_END_PROP,
    'Ava last campaign end',
    'datetime',
    'date'
  );
  return patchContact(token, contactId, props, 'campaign');
}

/**
 * A HubSpot contact → an `initiate-outbound` lead payload, plus the full fetched `properties`.
 *
 * `phone_number` falls back `phone` → `mobilephone`: both are the contact's own line, and a portal that
 * only fills one is common. Enrollment reads `contact_information` and `input_data`; the extra
 * `properties` key is for the FE preview and is harmless to enrollment.
 */
export function contactToLeadPayload(
  contactId: unknown,
  propsIn: Record<string, unknown> | null | undefined
): LeadPayload {
  const props = propsIn ?? {};
  const inputData: Record<string, unknown> = {
    hubspot_contact_id: String(contactId),
  };
  if (props.company) inputData.company = props.company;
  if (props.state) inputData.state = props.state;
  if (props.zip) inputData.zip = props.zip;
  if (props.jobtitle) inputData.job_title = props.jobtitle;
  if (props.city) inputData.city = props.city;
  if (props.lifecyclestage) inputData.lifecyclestage = props.lifecyclestage;
  // The "phone found on the company website" signal — enroll's business-only gate reads it to rescue a
  // verified business landline that CNAM alone would have rejected.
  if (props.aaai_website_verified_business_phone) {
    inputData.website_verified_business =
      props.aaai_website_verified_business_phone;
  }
  // A FALLBACK only: enroll's own location resolution wins when it resolves.
  const iana = hsTimezoneToIana(props.hs_timezone);
  if (iana) inputData.timezone = iana;

  return {
    id: String(contactId),
    contact_information: {
      email: (props.email as string) || '',
      phone_number:
        (props.phone as string) || (props.mobilephone as string) || '',
      first_name: (props.firstname as string) || '',
      last_name: (props.lastname as string) || '',
    },
    input_data: inputData,
    properties: { ...props },
  };
}

/**
 * Drop members the FE de-selected, or that would collapse onto an existing chat.
 *
 * `excludeIds` matches on contact id OR email, because the FE keys by id with an email fallback.
 * `excludeChannelKeys` catches the case the id-based exclude misses entirely: a shared dealership line,
 * where a DIFFERENT contact id carries a phone or email already enrolled.
 */
export function dropExcludedMembers(
  members: LeadPayload[],
  excludeIds?: Array<string | number | null | undefined> | null,
  excludeChannelKeys?: Iterable<string> | null
): LeadPayload[] {
  const excl = new Set(
    (excludeIds ?? [])
      .filter((x) => x !== null && x !== undefined && x !== '')
      .map((x) => String(x))
  );
  const chk = new Set(excludeChannelKeys ?? []);
  if (excl.size === 0 && chk.size === 0) return members;

  const out: LeadPayload[] = [];
  for (const m of members) {
    const ci = m.contact_information ?? {
      email: '',
      phone_number: '',
      first_name: '',
      last_name: '',
    };
    const email = ci.email;
    if ((m.id && excl.has(String(m.id))) || (email && excl.has(email)))
      continue;
    if (chk.size > 0) {
      const ph = String(ci.phone_number ?? '').replace(/\D/g, '');
      const em = String(email ?? '')
        .trim()
        .toLowerCase();
      if ((ph && chk.has(`p:${ph.slice(-10)}`)) || (em && chk.has(`e:${em}`))) {
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * Annotate every member with its NANP area code, and filter to the selected subset when there is one.
 *
 * Email-only members are ALWAYS kept — they have no area code to judge, and dropping them would silence
 * a reachable channel. With no selection, members are annotated and none are dropped.
 */
export async function annotateAndFilterAreaCodes(
  members: LeadPayload[],
  areaCodes?: unknown
): Promise<LeadPayload[]> {
  const allowed = await effectiveAllowed(areaCodes as string[] | null);
  const out: LeadPayload[] = [];
  for (const m of members) {
    annotateAreaCode(m as unknown as Record<string, unknown>);
    const phone = m.contact_information?.phone_number ?? '';
    if (phonePasses(phone, allowed)) out.push(m);
  }
  return out;
}

/** The portal's contact lists, paginated. */
export async function listHubspotLists(
  token: string
): Promise<Array<{ id: unknown; name: unknown; size: unknown }>> {
  const out: Array<{ id: unknown; name: unknown; size: unknown }> = [];
  let offset = 0;
  try {
    for (;;) {
      const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/lists/search`, {
        method: 'POST',
        headers: hsHeaders(token),
        body: JSON.stringify({
          query: '',
          count: 100,
          offset,
          processingTypes: [],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (resp.status !== 200) {
        console.error(
          `[HS] list lists ${resp.status}: ${(await resp.text()).slice(0, 200)}`
        );
        break;
      }
      const body = ((await resp.json()) ?? {}) as Record<string, unknown>;
      for (const lst of (body.lists ?? []) as Array<Record<string, unknown>>) {
        out.push({
          id: lst.listId ?? lst.listVersion,
          name: lst.name,
          size:
            ((lst.additionalProperties ?? {}) as Record<string, unknown>)
              .hs_list_size ?? lst.size,
        });
      }
      if (!body.hasMore) break;
      offset = (body.offset as number) ?? offset + 100;
    }
  } catch (e) {
    console.error(`[HS] listHubspotLists error: ${e}`);
  }
  return out;
}

/** Hydrate contact ids into `{id, properties}` via the batch-read API. */
export async function batchReadContacts(
  token: string,
  ids: Array<string | number>,
  properties?: string[] | null
): Promise<Array<Record<string, unknown>>> {
  if (!ids || ids.length === 0) return [];
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/read`,
      {
        method: 'POST',
        headers: hsHeaders(token),
        body: JSON.stringify({
          properties: reqProperties(properties),
          inputs: ids.map((i) => ({ id: String(i) })),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status === 200) {
      return (((await resp.json()) as Record<string, unknown>).results ??
        []) as Array<Record<string, unknown>>;
    }
    console.error(
      `[HS] batch read contacts ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] batchReadContacts error: ${e}`);
  }
  return [];
}

/** Batch-PATCH up to 100 contacts. The caller chunks. */
export async function batchUpdateContacts(
  token: string,
  updates: Array<{ id: string; properties: Record<string, unknown> }>
): Promise<{ updated: number; error: string | null }> {
  if (!updates || updates.length === 0) return { updated: 0, error: null };
  try {
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/update`,
      {
        method: 'POST',
        headers: hsHeaders(token),
        body: JSON.stringify({ inputs: updates }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status === 200 || resp.status === 202) {
      const body = (await resp.json()) as Record<string, unknown>;
      const results = (body.results ?? []) as unknown[];
      return { updated: results.length || updates.length, error: null };
    }
    const text = (await resp.text()).slice(0, 200);
    console.error(`[HS] batch update contacts ${resp.status}: ${text}`);
    return { updated: 0, error: `batch update ${resp.status}` };
  } catch (e) {
    console.error(`[HS] batchUpdateContacts error: ${e}`);
    return { updated: 0, error: String(e) };
  }
}

export interface MembersPage {
  members: LeadPayload[];
  next_cursor?: string | null;
  total?: number;
  error?: string;
}

/**
 * One page of a list's contact members, as lead payloads.
 *
 * Area-code filtering here is CLIENT-side over the page, because lists have no server-side filter. The
 * FE's primary source is search, which does filter server-side.
 */
export async function fetchHubspotListMembers(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  listId: string | number,
  opts: {
    after?: string | null;
    limit?: number;
    properties?: string[] | null;
    areaCodes?: unknown;
  } = {}
): Promise<MembersPage> {
  const token = await accessToken(cfg, agentId);
  if (!token) {
    return {
      error: 'HubSpot auth failed (no valid token)',
      members: [],
      next_cursor: null,
    };
  }
  try {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    if (opts.after) params.set('after', opts.after);
    const resp = await fetch(
      `${HUBSPOT_BASE}/crm/v3/lists/${encodeURIComponent(String(listId))}/memberships?${params}`,
      {
        method: 'GET',
        headers: hsHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (resp.status !== 200) {
      console.error(
        `[HS] list memberships ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return {
        error: `memberships ${resp.status}`,
        members: [],
        next_cursor: null,
      };
    }
    const body = ((await resp.json()) ?? {}) as Record<string, unknown>;
    const ids = ((body.results ?? []) as Array<Record<string, unknown>>)
      .map((r) => r.recordId)
      .filter(Boolean) as Array<string | number>;
    const nextCursor = (((body.paging ?? {}) as Record<string, unknown>).next ??
      {}) as Record<string, unknown>;

    const hydrated = await batchReadContacts(token, ids, opts.properties);
    let members = hydrated.map((c) =>
      contactToLeadPayload(
        c.id,
        c.properties as Record<string, unknown> | undefined
      )
    );
    members = await annotateAndFilterAreaCodes(members, opts.areaCodes);
    return { members, next_cursor: (nextCursor.after as string) ?? null };
  } catch (e) {
    console.error(`[HS] fetchHubspotListMembers error: ${e}`);
    return { error: String(e), members: [], next_cursor: null };
  }
}

/** Contact properties, so the FE can build a filter UI. */
export async function listHubspotContactProperties(
  token: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/properties/contacts`, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.error(
        `[HS] list properties ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return [];
    }
    const results = (((await resp.json()) as Record<string, unknown>).results ??
      []) as Array<Record<string, unknown>>;
    return results.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      options: ((p.options ?? []) as Array<Record<string, unknown>>).map(
        (o) => ({ label: o.label, value: o.value })
      ),
    }));
  } catch (e) {
    console.error(`[HS] listHubspotContactProperties error: ${e}`);
    return [];
  }
}

/** Every contact property name — for `all_properties` preview requests. */
export async function allContactPropertyNames(
  token: string
): Promise<string[]> {
  return (await listHubspotContactProperties(token))
    .map((p) => p.name as string)
    .filter(Boolean);
}

/**
 * Friendly FE operator labels → HubSpot Search operators.
 *
 * Unknown values pass through upper-cased, so a HubSpot-native operator the FE sends directly still
 * works — the map is a convenience layer, not a whitelist.
 */
const HS_OPERATORS: Record<string, string> = {
  is: 'EQ',
  equals: 'EQ',
  eq: 'EQ',
  '=': 'EQ',
  'is not': 'NEQ',
  not: 'NEQ',
  isnt: 'NEQ',
  neq: 'NEQ',
  '!=': 'NEQ',
  'is any of': 'IN',
  'any of': 'IN',
  any_of: 'IN',
  in: 'IN',
  'is one of': 'IN',
  'is in': 'IN',
  'none of': 'NOT_IN',
  'not any of': 'NOT_IN',
  not_in: 'NOT_IN',
  'is not in': 'NOT_IN',
  'not in': 'NOT_IN',
  contains: 'CONTAINS_TOKEN',
  contains_token: 'CONTAINS_TOKEN',
  'does not contain': 'NOT_CONTAINS_TOKEN',
  'not contains': 'NOT_CONTAINS_TOKEN',
  'is known': 'HAS_PROPERTY',
  known: 'HAS_PROPERTY',
  has_property: 'HAS_PROPERTY',
  'is unknown': 'NOT_HAS_PROPERTY',
  unknown: 'NOT_HAS_PROPERTY',
  not_has_property: 'NOT_HAS_PROPERTY',
  'greater than': 'GT',
  gt: 'GT',
  'less than': 'LT',
  lt: 'LT',
  gte: 'GTE',
  lte: 'LTE',
};

const NO_VALUE_OPS = new Set(['HAS_PROPERTY', 'NOT_HAS_PROPERTY']);
const MULTI_VALUE_OPS = new Set(['IN', 'NOT_IN']);

/**
 * One FE filter row → a HubSpot filter, or `null` to drop it.
 *
 * Tolerant of `property`/`propertyName` and `value`/`values`, and it NORMALIZES operator against
 * cardinality: several values with `EQ` becomes `IN`, one value with `IN` collapses to `EQ`. A
 * value-requiring operator with no value is dropped rather than sent — HubSpot would reject the query
 * and lose the whole audience, not just the row.
 */
export function buildFilter(
  row: Record<string, unknown>
): Record<string, unknown> | null {
  const prop = row.property ?? row.propertyName;
  if (!prop) return null;

  const rawOp = String(row.operator ?? 'EQ').trim();
  let op = HS_OPERATORS[rawOp.toLowerCase()] ?? rawOp.toUpperCase();

  let values = row.values as unknown[] | undefined;
  let value = row.value;
  if (values === undefined && Array.isArray(value)) {
    values = value as unknown[];
    value = undefined;
  }
  values = (values ?? []).filter(
    (v) => v !== null && v !== undefined && v !== ''
  );

  if (values.length > 1 && (op === 'EQ' || op === 'IN')) {
    op = 'IN';
  } else if (values.length === 1 && op === 'IN') {
    op = 'EQ';
    value = values[0];
    values = [];
  }

  const hf: Record<string, unknown> = { propertyName: prop, operator: op };
  if (NO_VALUE_OPS.has(op)) return hf;
  if (MULTI_VALUE_OPS.has(op)) {
    const vals =
      values.length > 0 ? values : value !== undefined ? [value] : [];
    hf.values = vals;
    return vals.length > 0 ? hf : null;
  }
  if (value !== undefined && value !== null) {
    hf.value = value;
    return hf;
  }
  if (values.length > 0) {
    hf.value = values[0];
    return hf;
  }
  return null;
}

/**
 * FE audience criteria → HubSpot `filterGroups`.
 *
 * Groups are OR-ed; rows within a group are AND-ed. A flat `filters` list is wrapped as one AND group
 * for backwards compatibility. Empty criteria yield `[]`, which HubSpot reads as "all contacts".
 */
export function buildFilterGroups(
  filterGroups?: unknown[] | null,
  filters?: unknown[] | null
): Array<{ filters: Array<Record<string, unknown>> }> {
  const rawGroups: unknown[][] = [];
  for (const g of filterGroups ?? []) {
    const rows =
      g && typeof g === 'object' && !Array.isArray(g)
        ? ((g as Record<string, unknown>).filters as unknown[])
        : (g as unknown[]);
    rawGroups.push(rows ?? []);
  }
  if (filters && filters.length > 0) rawGroups.push(filters);

  const groups: Array<{ filters: Array<Record<string, unknown>> }> = [];
  for (const rows of rawGroups) {
    const built = (rows ?? [])
      .map((r) => buildFilter((r ?? {}) as Record<string, unknown>))
      .filter(Boolean) as Array<Record<string, unknown>>;
    if (built.length > 0) groups.push({ filters: built });
  }
  return groups;
}

/**
 * AND the contacted-exclusion into EVERY OR-branch — see the module note on why every group.
 *
 * With no groups it becomes the only filter, rather than being silently dropped.
 */
export function applyExcludeContacted(
  groups: Array<{ filters: Array<Record<string, unknown>> }>
): Array<{ filters: Array<Record<string, unknown>> }> {
  const excl = {
    propertyName: CONTACTED_PROP,
    operator: 'NOT_HAS_PROPERTY',
  };
  if (groups.length === 0) return [{ filters: [{ ...excl }] }];
  for (const g of groups) {
    g.filters = [...(g.filters ?? []), { ...excl }];
  }
  return groups;
}

/**
 * AND the area-code constraint into every OR-branch.
 *
 * An explicitly-empty selection becomes `IN [""]` — a sentinel matching nothing. See the module note:
 * returning everything would dial an unscrubbed audience.
 */
export async function applyAreaCodeFilter(
  groups: Array<{ filters: Array<Record<string, unknown>> }>,
  areaCodes: unknown
): Promise<Array<{ filters: Array<Record<string, unknown>> }>> {
  const allowed = await effectiveAllowed(areaCodes as string[] | null);
  let codes: string[] | null;
  if (!allowed || allowed.size === 0) {
    codes = areaCodes ? [''] : null;
  } else {
    codes = [...allowed].sort();
  }
  if (codes === null) return groups;

  const f = {
    propertyName: AAAI_AREA_CODE_PROP,
    operator: 'IN',
    values: codes,
  };
  if (groups.length === 0) return [{ filters: [{ ...f }] }];
  for (const g of groups) {
    g.filters = [...(g.filters ?? []), { ...f }];
  }
  return groups;
}

/**
 * Contacts matching the FE's criteria, as lead payloads.
 *
 * `total` is HubSpot's raw pre-area-filter match count — see the module note.
 */
export async function searchHubspotContacts(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  opts: {
    filters?: unknown[] | null;
    filterGroups?: unknown[] | null;
    after?: string | null;
    limit?: number;
    properties?: string[] | null;
    excludeContacted?: boolean;
    excludeContactIds?: Array<string | number> | null;
    areaCodes?: unknown;
  } = {}
): Promise<MembersPage> {
  const token = await accessToken(cfg, agentId);
  if (!token) {
    return {
      error: 'HubSpot auth failed (no valid token)',
      members: [],
      total: 0,
      next_cursor: null,
    };
  }

  let groups = buildFilterGroups(opts.filterGroups, opts.filters);
  if (opts.excludeContacted !== false) {
    // The property must EXIST or the NOT_HAS_PROPERTY filter 400s the whole query.
    await ensureContactedProps(token);
    groups = applyExcludeContacted(groups);
  }
  if (opts.areaCodes) {
    groups = await applyAreaCodeFilter(groups, opts.areaCodes);
  }

  const body: Record<string, unknown> = {
    filterGroups: groups,
    properties: reqProperties(opts.properties),
    limit: opts.limit ?? 100,
  };
  if (opts.after) body.after = opts.after;

  try {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      console.error(
        `[HS] search contacts ${resp.status}: ${(await resp.text()).slice(0, 200)}`
      );
      return {
        error: `search ${resp.status}`,
        members: [],
        total: 0,
        next_cursor: null,
      };
    }
    const data = ((await resp.json()) ?? {}) as Record<string, unknown>;
    let members = ((data.results ?? []) as Array<Record<string, unknown>>).map(
      (c) =>
        contactToLeadPayload(
          c.id,
          c.properties as Record<string, unknown> | undefined
        )
    );
    members = dropExcludedMembers(members, opts.excludeContactIds);
    members = await annotateAndFilterAreaCodes(members, opts.areaCodes);
    const next = (((data.paging ?? {}) as Record<string, unknown>).next ??
      {}) as Record<string, unknown>;
    return {
      members,
      total: (data.total as number) ?? members.length,
      next_cursor: (next.after as string) ?? null,
    };
  } catch (e) {
    console.error(`[HS] searchHubspotContacts error: ${e}`);
    return { error: String(e), members: [], total: 0, next_cursor: null };
  }
}

export const __testing = { HS_OPERATORS, NUMBER_TYPES, ENSURED_PROPS };
