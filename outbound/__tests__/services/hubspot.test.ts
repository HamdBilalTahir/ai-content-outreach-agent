/**
 * @jest-environment node
 *
 * The HubSpot client core.
 *
 * The whole CRM layer is best-effort mirroring, so the properties worth protecting are about what it
 * REFUSES to do and what it never loses:
 *
 *  - **Only the v2 action counts**, keyed on `provider` — the legacy `hubspot` action must be ignored,
 *    and an action with no credentials is "not connected", which is what makes the layer a no-op.
 *  - **Test records get their own owner and meeting link**, and the two must stay in step or an E2E run
 *    books on the real rep's calendar.
 *  - **Contact matching is ordered by trustworthiness**, and a name match needs BOTH parts — matching on
 *    a first name alone would merge strangers.
 *  - **An email change ADDS**: the primary and every existing secondary survive, because the old address
 *    is how prior threads, bounces, and suppression entries stay attributable.
 *  - **Nothing throws.** These are called from `try` blocks whose purpose is "the outcome already
 *    happened, record it if you can".
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  CONTACT_STAGES,
  STAGE_RANK,
  accessToken,
  addContactSecondaryEmail,
  createContact,
  findContactByName,
  findContactByPhone,
  findExistingContact,
  hsHeaders,
  logHubspotDealNote,
  logHubspotNote,
  preservePriorEmailOnContact,
  refreshHubspotToken,
  resolveHubspotConfig,
  resolveMeetingSlug,
  resolveOwnerId,
  updateContactProperties,
  updateContactProperty,
  deleteObject,
  deleteHubspotRecords,
} from '../../services/hubspot';
import type { AgentAction } from '../../firebase/agent';

const TOKEN = 'pat-token';
const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';
const CONTACT = '12345';

let fetchMock: jest.Mock;

/** A JSON response. */
function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** An active v2 action with a Private App token. */
function v2Action(over: Record<string, unknown> = {}): AgentAction {
  return {
    id: 'act_hs',
    status: 'active',
    provider: 'hubspot_v2',
    auth: { access_token: TOKEN },
    additional_meta: {},
    ...over,
  } as unknown as AgentAction;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  process.env.HUBSPOT_CLIENT_ID = 'cid';
  process.env.HUBSPOT_CLIENT_SECRET = 'secret';
  fetchMock = jest.fn().mockResolvedValue(ok({}));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
  delete process.env.HUBSPOT_CLIENT_ID;
  delete process.env.HUBSPOT_CLIENT_SECRET;
});

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveHubspotConfig', () => {
  test('matches the v2 action and fills every default', () => {
    const cfg = resolveHubspotConfig([v2Action()]);
    expect(cfg.access_token).toBe(TOKEN);
    expect(cfg.action_id).toBe('act_hs');
    // An agent that connected HubSpot without customizing anything still gets a working config.
    expect(cfg.contact_stage_property).toBe('hs_lead_status');
    expect(cfg.source_property).toBe('lead_source');
    expect(cfg.source_value).toBe('Lily Outbound Comms');
    expect(cfg.env_property).toBe('record_type');
    expect(cfg.env_default_value).toBe('Real');
  });

  test('IGNORES the legacy `hubspot` action entirely', () => {
    // That action belongs to create_hubspot_lead / update_hubspot_lead and must never match.
    const legacy = v2Action({ provider: 'hubspot', type: 'hubspot' });
    expect(resolveHubspotConfig([legacy])).toEqual({});
  });

  test('matches on `type` as a secondary, since getAgentActions blanks it sometimes', () => {
    const byType = v2Action({ provider: '', type: 'hubspot_v2' });
    expect(resolveHubspotConfig([byType]).access_token).toBe(TOKEN);
  });

  test('an inactive action is skipped', () => {
    expect(resolveHubspotConfig([v2Action({ status: 'inactive' })])).toEqual(
      {}
    );
  });

  test('an action with NO credentials is "not connected"', () => {
    // This is what makes the whole CRM layer a no-op for an unconfigured agent.
    expect(resolveHubspotConfig([v2Action({ auth: {} })])).toEqual({});
  });

  test('an empty or null action list yields no config', () => {
    expect(resolveHubspotConfig([])).toEqual({});
    expect(resolveHubspotConfig(null)).toEqual({});
  });

  test('configured metadata overrides the defaults', () => {
    const cfg = resolveHubspotConfig([
      v2Action({
        additional_meta: {
          contact_stage_property: 'custom_stage',
          source_value: 'Custom Source',
          pipeline_id: 'pipe_1',
          stage_ids: { Lead: 'stage_lead' },
        },
      }),
    ]);
    expect(cfg.contact_stage_property).toBe('custom_stage');
    expect(cfg.source_value).toBe('Custom Source');
    expect(cfg.pipeline_id).toBe('pipe_1');
    expect(cfg.stage_ids).toEqual({ Lead: 'stage_lead' });
  });

  test('the meeting link supplies the slug and owner when not set directly', () => {
    const cfg = resolveHubspotConfig([
      v2Action({
        additional_meta: {
          meeting_link: { slug: 'link-slug', owner_id: 'own_1' },
        },
      }),
    ]);
    expect(cfg.meeting_slug).toBe('link-slug');
    expect(cfg.owner_id).toBe('own_1');
  });
});

describe('Test-record routing', () => {
  const cfg = {
    meeting_slug: 'real-slug',
    meeting_slug_test: 'test-slug',
    owner_id: 'real-owner',
    owner_id_test: 'test-owner',
  };

  test('a Test record gets the test slug AND the test owner, in step', () => {
    // They must agree, or an E2E contact is owned by one rep and booked on another's calendar.
    expect(resolveMeetingSlug(cfg, 'Test')).toBe('test-slug');
    expect(resolveOwnerId(cfg, 'Test')).toBe('test-owner');
  });

  test('a Real record gets the real pair', () => {
    expect(resolveMeetingSlug(cfg, 'Real')).toBe('real-slug');
    expect(resolveOwnerId(cfg, 'Real')).toBe('real-owner');
  });

  test('with no test values configured a Test record falls back to the real ones', () => {
    const bare = { meeting_slug: 'real-slug', owner_id: 'real-owner' };
    expect(resolveMeetingSlug(bare, 'Test')).toBe('real-slug');
    expect(resolveOwnerId(bare, 'Test')).toBe('real-owner');
  });

  test('the check is case- and whitespace-insensitive', () => {
    expect(resolveMeetingSlug(cfg, '  TEST  ')).toBe('test-slug');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

describe('authentication', () => {
  test('a Private App token is used DIRECTLY — no refresh round-trip', async () => {
    expect(await accessToken({ access_token: TOKEN }, AGENT)).toBe(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a refresh token is exchanged, and the result persisted on the action', async () => {
    fetchMock.mockResolvedValue(
      ok({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 })
    );
    const token = await accessToken(
      { refresh_token: 'old', action_id: 'act_hs' },
      AGENT
    );
    expect(token).toBe('fresh');
    // The ROTATED refresh token must be stored, or every later call breaks.
    const saved = store.get(`agents/${AGENT}/actions/act_hs`)?.auth as Record<
      string,
      unknown
    >;
    expect(saved.access_token).toBe('fresh');
    expect(saved.refresh_token).toBe('rotated');
  });

  test('a response with no rotated token keeps the one we sent', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'fresh' }));
    const auth = await refreshHubspotToken('old', AGENT, 'act_hs');
    expect(auth?.refresh_token).toBe('old');
    expect(auth?.expires_in).toBe(1800);
  });

  test('a failed refresh is null, not a throw', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'invalid_grant' }, 400));
    expect(await refreshHubspotToken('old', AGENT, 'act_hs')).toBeNull();
    expect(await accessToken({ refresh_token: 'old' }, AGENT)).toBeNull();
  });

  test('a network failure during refresh is null', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    expect(await refreshHubspotToken('old', AGENT, 'act_hs')).toBeNull();
  });

  test('no credentials at all resolves to null — the CRM mirror is skipped', async () => {
    expect(await accessToken({}, AGENT)).toBeNull();
  });

  test('the auth header is a bearer token', () => {
    expect(hsHeaders(TOKEN).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contact matching
// ─────────────────────────────────────────────────────────────────────────────

describe('contact matching', () => {
  test('email is tried FIRST and short-circuits the rest', async () => {
    fetchMock.mockResolvedValue(ok({ results: [{ id: CONTACT }] }));
    const cid = await findExistingContact(TOKEN, {
      email: 'Jane@Corp.com',
      phone: '+15551230000',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(cid).toBe(CONTACT);
    // One search only — the strongest signal matched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Lowercased before searching.
    expect(body.filterGroups[0].filters[0].value).toBe('jane@corp.com');
  });

  test('falls through email → phone → name', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ results: [] })) // email miss
      .mockResolvedValueOnce(ok({ results: [] })) // phone miss
      .mockResolvedValueOnce(ok({ results: [{ id: CONTACT }] })); // name hit
    const cid = await findExistingContact(TOKEN, {
      email: 'a@b.com',
      phone: '+15551230000',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(cid).toBe(CONTACT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('a phone search checks BOTH phone and mobilephone', async () => {
    fetchMock.mockResolvedValue(ok({ results: [{ id: CONTACT }] }));
    await findContactByPhone(TOKEN, '+1 (555) 123-0000');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Two filter GROUPS: HubSpot ORs groups, so this is phone OR mobilephone.
    expect(body.filterGroups).toHaveLength(2);
    expect(body.filterGroups[0].filters[0].propertyName).toBe('phone');
    expect(body.filterGroups[1].filters[0].propertyName).toBe('mobilephone');
    // Matched on the last-10 NANP digits, because a real CRM stores every format.
    expect(body.filterGroups[0].filters[0].value).toBe('5551230000');
  });

  test('a phone that does not normalise to 10 digits is NOT searched', async () => {
    // A partial number would match strangers.
    expect(await findContactByPhone(TOKEN, '555')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a name match requires BOTH parts', async () => {
    // Matching on a first name alone would merge different people.
    expect(await findContactByName(TOKEN, 'Jane', '')).toBeNull();
    expect(await findContactByName(TOKEN, '', 'Doe')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a name search ANDs both filters in one group', async () => {
    fetchMock.mockResolvedValue(ok({ results: [{ id: CONTACT }] }));
    await findContactByName(TOKEN, 'Jane', 'Doe');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.filterGroups).toHaveLength(1);
    expect(body.filterGroups[0].filters).toHaveLength(2);
  });

  test('nothing to match on returns null without a request', async () => {
    expect(await findExistingContact(TOKEN, {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a search failure is null, never a throw', async () => {
    fetchMock.mockRejectedValue(new Error('HubSpot down'));
    expect(await findContactByName(TOKEN, 'Jane', 'Doe')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contact writes
// ─────────────────────────────────────────────────────────────────────────────

describe('createContact', () => {
  test('creates and returns the id, dropping empty properties', async () => {
    fetchMock.mockResolvedValue(ok({ id: CONTACT }, 201));
    const cid = await createContact(TOKEN, {
      email: 'jane@corp.com',
      firstname: 'Jane',
      company: '',
      phone: null,
    });
    expect(cid).toBe(CONTACT);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // An empty string tells HubSpot to CLEAR a property, so empties are dropped rather than sent.
    expect(body.properties).toEqual({
      email: 'jane@corp.com',
      firstname: 'Jane',
    });
  });

  test('a 409 RECOVERS the existing id by email rather than failing', async () => {
    // A race between two turns must not lose the contact.
    fetchMock
      .mockResolvedValueOnce(ok({ message: 'exists' }, 409))
      .mockResolvedValueOnce(ok({ results: [{ id: CONTACT }] }));
    expect(await createContact(TOKEN, { email: 'jane@corp.com' })).toBe(
      CONTACT
    );
  });

  test('a 409 with no email to look up is a null', async () => {
    fetchMock.mockResolvedValue(ok({}, 409));
    expect(await createContact(TOKEN, { firstname: 'Jane' })).toBeNull();
  });

  test('nothing to write is a null with no request', async () => {
    expect(await createContact(TOKEN, { email: '', company: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an error response is null, never a throw', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'bad' }, 500));
    expect(await createContact(TOKEN, { email: 'a@b.com' })).toBeNull();
  });
});

describe('contact property updates', () => {
  test('a batch PATCH sends only the non-empty properties', async () => {
    fetchMock.mockResolvedValue(ok({}, 200));
    expect(
      await updateContactProperties(TOKEN, CONTACT, {
        firstname: 'Jane',
        company: '',
        lead_source: 'Lily Outbound Comms',
      })
    ).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.properties).toEqual({
      firstname: 'Jane',
      lead_source: 'Lily Outbound Comms',
    });
  });

  test('a falsy single-property value is a no-op, never a clear', async () => {
    expect(await updateContactProperty(TOKEN, CONTACT, 'firstname', '')).toBe(
      false
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an empty batch makes no request', async () => {
    expect(await updateContactProperties(TOKEN, CONTACT, {})).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The append-only email
// ─────────────────────────────────────────────────────────────────────────────

describe('addContactSecondaryEmail', () => {
  test('APPENDS, keeping the primary and every existing secondary', async () => {
    // The old address is how prior threads, bounces, and suppression stay attributable.
    fetchMock
      .mockResolvedValueOnce(
        ok({
          properties: {
            email: 'primary@corp.com',
            hs_additional_emails: 'old1@corp.com;old2@corp.com',
          },
        })
      )
      .mockResolvedValueOnce(ok({}, 200));
    expect(await addContactSecondaryEmail(TOKEN, CONTACT, 'new@corp.com')).toBe(
      true
    );
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.properties.hs_additional_emails).toBe(
      'old1@corp.com;old2@corp.com;new@corp.com'
    );
  });

  test('an address that is already the PRIMARY is a success with no write', async () => {
    fetchMock.mockResolvedValue(ok({ properties: { email: 'jane@corp.com' } }));
    expect(
      await addContactSecondaryEmail(TOKEN, CONTACT, 'JANE@corp.com')
    ).toBe(true);
    // Reporting failure would make an idempotent call look broken.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('an address already among the secondaries is also a no-op success', async () => {
    fetchMock.mockResolvedValue(
      ok({
        properties: {
          email: 'primary@corp.com',
          hs_additional_emails: 'new@corp.com',
        },
      })
    );
    expect(await addContactSecondaryEmail(TOKEN, CONTACT, 'new@corp.com')).toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a contact with NO secondaries yet gets the first one', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ properties: { email: 'primary@corp.com' } }))
      .mockResolvedValueOnce(ok({}, 200));
    await addContactSecondaryEmail(TOKEN, CONTACT, 'new@corp.com');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.properties.hs_additional_emails).toBe('new@corp.com');
  });

  test('missing arguments are rejected without a request', async () => {
    expect(await addContactSecondaryEmail(TOKEN, '', 'a@b.com')).toBe(false);
    expect(await addContactSecondaryEmail(TOKEN, CONTACT, '  ')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failed read is false, never a throw', async () => {
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await addContactSecondaryEmail(TOKEN, CONTACT, 'a@b.com')).toBe(
      false
    );
  });
});

describe('preservePriorEmailOnContact', () => {
  function seedChat(over: Record<string, unknown> = {}) {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: { hubspot_contact_id: CONTACT, ...over },
    });
    store.set(`agents/${AGENT}`, {});
    store.set(`agents/${AGENT}/actions/act_hs`, {
      status: 'active',
      provider: 'hubspot_v2',
      auth: { access_token: TOKEN },
      additional_meta: {},
      action_id: 'shared',
    });
    store.set('actions/shared', { functions: [] });
  }

  test('adds the new address as a secondary', async () => {
    seedChat();
    fetchMock
      .mockResolvedValueOnce(ok({ properties: { email: 'old@corp.com' } }))
      .mockResolvedValueOnce(ok({}, 200));
    expect(
      await preservePriorEmailOnContact(CHAT, AGENT, null, 'new@corp.com')
    ).toBe(true);
  });

  test('a chat with NO HubSpot contact is a clean false', async () => {
    store.set(`chats/${CHAT}`, { type: 'outbound', memory: {} });
    expect(
      await preservePriorEmailOnContact(CHAT, AGENT, null, 'new@corp.com')
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an unconfigured agent is a clean false — no token, no mirror', async () => {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      memory: { hubspot_contact_id: CONTACT },
    });
    store.set(`agents/${AGENT}`, {});
    expect(
      await preservePriorEmailOnContact(CHAT, AGENT, null, 'new@corp.com')
    ).toBe(false);
  });

  test('an empty new address is rejected', async () => {
    seedChat();
    expect(await preservePriorEmailOnContact(CHAT, AGENT, null, '  ')).toBe(
      false
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notes and deletion
// ─────────────────────────────────────────────────────────────────────────────

describe('notes', () => {
  test('a contact note carries the contact association type', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'note_1' }, 201));
    expect(await logHubspotNote(TOKEN, CONTACT, 'Called Jane.')).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.properties.hs_note_body).toBe('Called Jane.');
    expect(typeof body.properties.hs_timestamp).toBe('number');
    expect(body.associations[0].types[0].associationTypeId).toBe(202);
  });

  test('a deal note carries the DEAL association type', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'note_2' }, 201));
    expect(await logHubspotDealNote(TOKEN, 'deal_1', 'Brief.')).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.associations[0].types[0].associationTypeId).toBe(214);
  });

  test('a missing id or empty body makes no request', async () => {
    expect(await logHubspotNote(TOKEN, '', 'body')).toBe(false);
    expect(await logHubspotNote(TOKEN, CONTACT, '')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failure is false, never a throw into the sync', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await logHubspotNote(TOKEN, CONTACT, 'body')).toBe(false);
  });
});

describe('deleteObject', () => {
  test('a 204 is success', async () => {
    fetchMock.mockResolvedValue(ok({}, 204));
    expect(await deleteObject(TOKEN, 'contacts', CONTACT)).toBe(true);
  });

  test('a 404 is ALSO success — already gone meets the goal', async () => {
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await deleteObject(TOKEN, 'deals', 'deal_1')).toBe(true);
  });

  test('a real error is false', async () => {
    fetchMock.mockResolvedValue(ok({}, 500));
    expect(await deleteObject(TOKEN, 'contacts', CONTACT)).toBe(false);
  });

  test('no id makes no request', async () => {
    expect(await deleteObject(TOKEN, 'contacts', '')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteHubspotRecords', () => {
  /**
   * Wire up an agent whose active v2 action carries a Private App token.
   *
   * `provider` and `auth` live on the AGENT's own action document, not on the shared `actions/{id}`
   * one — that shared doc contributes only `type`, `action_prompt`, and `functions`, and
   * `updateAgentActionAuth` writes the refreshed token back to the per-agent doc. Getting this
   * backwards makes `resolveHubspotConfig` see an unconnected agent.
   */
  function connectAgent() {
    store.set(`agents/${AGENT}`, {});
    store.set(`agents/${AGENT}/actions/act_hs`, {
      status: 'active',
      provider: 'hubspot_v2',
      auth: { access_token: TOKEN },
    });
  }

  test('deletes both objects and reports each result', async () => {
    connectAgent();
    fetchMock.mockResolvedValue(ok({}, 204));
    expect(await deleteHubspotRecords(AGENT, CONTACT, 'deal_1')).toEqual({
      authenticated: true,
      contact_deleted: true,
      deal_deleted: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('an id not asked about stays NULL, distinct from a failure', async () => {
    // The view clears an id from chat memory only when that id was actually deleted, so "not asked"
    // and "asked and failed" must not collapse into one value.
    connectAgent();
    fetchMock.mockResolvedValue(ok({}, 204));
    expect(await deleteHubspotRecords(AGENT, CONTACT)).toEqual({
      authenticated: true,
      contact_deleted: true,
      deal_deleted: null,
    });
  });

  test('a failed delete is false, not null', async () => {
    connectAgent();
    fetchMock.mockResolvedValue(ok({}, 500));
    expect(await deleteHubspotRecords(AGENT, CONTACT)).toMatchObject({
      contact_deleted: false,
    });
  });

  test('an unconnected agent attempts nothing at all', async () => {
    const out = await deleteHubspotRecords(AGENT, CONTACT, 'deal_1');
    expect(out).toEqual({
      authenticated: false,
      contact_deleted: null,
      deal_deleted: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the funnel constants', () => {
  test('the contact stages stop before Lead — Lead lives on the deal', () => {
    expect(CONTACT_STAGES).toEqual(['New', 'Contacted', 'Engaged']);
  });

  test('Lost is deliberately ABSENT from the rank, so it always syncs', () => {
    // It is terminal, and a rank comparison would block it.
    expect(STAGE_RANK.Lost).toBeUndefined();
    expect(STAGE_RANK.New).toBeLessThan(STAGE_RANK.Lead);
  });
});
