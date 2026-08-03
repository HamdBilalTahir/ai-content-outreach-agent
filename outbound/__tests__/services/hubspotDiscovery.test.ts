/**
 * @jest-environment node
 *
 * HubSpot discovery, owners, meeting links, property options, and the two meeting tools.
 *
 * What these protect:
 *
 *  - **A meeting link's organizer is a USER id, not an owner id.** Conflating them silently breaks the
 *    binding that keeps the CRM record owner and the meeting organizer the same person.
 *  - **`addPropertyOption` is allowlisted and idempotent.** It edits someone else's CRM schema, and
 *    HubSpot accepts duplicate labels that then cannot be removed from the UI.
 *  - **`schedule_hubspot_meeting` prefers the RESOLVED slot** over whatever the model supplies — a
 *    booking at the wrong time is worse than no booking.
 *  - **Reminders are scheduled deterministically**, because the source records the model silently
 *    skipping them and producing booked demos with none.
 *  - **`ensureMeetingHost` is idempotent and picks the Test owner for a Test record**, so the named host
 *    is the owner of the calendar actually being booked.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/hubspotMeetings', () => {
  const actual = jest.requireActual('../../services/hubspotMeetings');
  return {
    ...actual,
    getHubspotSlots: jest.fn(),
    bookHubspotMeeting: jest.fn(),
    finalizeMeetingBooking: jest.fn(),
  };
});
jest.mock('../../services/reminders', () => ({
  scheduleBookingReminders: jest.fn(),
}));

import { store } from '../../testSupport/mockFirestore';
import {
  bookHubspotMeeting,
  finalizeMeetingBooking,
  getHubspotSlots,
} from '../../services/hubspotMeetings';
import { scheduleBookingReminders } from '../../services/reminders';
import {
  MANAGED_CONTACT_PROPERTIES,
  addPropertyOption,
  discoverHubspotConfig,
  listMeetingLinks,
  listOwners,
  listPropertyOptions,
  resolveOwnerName,
} from '../../services/hubspotDiscovery';
import { ensureMeetingHost } from '../../services/chat';
import {
  parseAndRunGetHubspotAvailableSlots,
  parseAndRunScheduleHubspotMeeting,
} from '../../tools/hubspotMeetingTools';
import type { BedrockMessage } from '../../types';

const slotsMock = getHubspotSlots as jest.Mock;
const bookMock = bookHubspotMeeting as jest.Mock;
const finalizeMock = finalizeMeetingBooking as jest.Mock;
const remindersMock = scheduleBookingReminders as jest.Mock;

const TOKEN = 'pat-token';
const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';

let fetchMock: jest.Mock;

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function payloadOf(res: BedrockMessage): Record<string, unknown> {
  const content = (
    res as unknown as {
      content: {
        toolResult: { content: { json: Record<string, unknown> }[] };
      }[];
    }
  ).content;
  return content[0].toolResult.content[0].json;
}

function seedAgent(meta: Record<string, unknown> = {}) {
  store.set(`agents/${AGENT}`, {});
  store.set(`agents/${AGENT}/actions/a1`, {
    status: 'active',
    provider: 'hubspot_v2',
    auth: { access_token: TOKEN },
    additional_meta: { meeting_slug: 'real-slug', ...meta },
  });
}

function seedChat(over: Record<string, unknown> = {}) {
  store.set(`chats/${CHAT}`, {
    type: 'outbound',
    agentId: AGENT,
    memory: { agent_id: AGENT, customer_email: 'jane@corp.com', ...over },
  });
}

function memory(): Record<string, unknown> {
  return (store.get(`chats/${CHAT}`)?.memory ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  slotsMock.mockResolvedValue({
    available_days: [],
    total_slots: 0,
    timezone: 'UTC',
  });
  bookMock.mockResolvedValue({
    success: true,
    message: '',
    meeting_url: 'https://meet/x',
  });
  finalizeMock.mockResolvedValue('https://meet/x');
  remindersMock.mockResolvedValue(['r1', 'r2']);
  fetchMock = jest.fn().mockResolvedValue(ok({}));
  global.fetch = fetchMock as unknown as typeof fetch;
  seedAgent();
  seedChat();
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// Owners and meeting links
// ─────────────────────────────────────────────────────────────────────────────

describe('listOwners', () => {
  test('returns both identifiers and a never-blank name', async () => {
    fetchMock.mockResolvedValue(
      ok({
        results: [
          {
            id: 'own_1',
            userId: 'u_1',
            email: 'a@x.com',
            firstName: 'Arnold',
            lastName: 'Phipps',
          },
          { id: 'own_2', userId: 'u_2', email: 'b@x.com' },
        ],
      })
    );
    const owners = await listOwners(TOKEN);
    expect(owners[0]).toEqual({
      id: 'own_1',
      user_id: 'u_1',
      email: 'a@x.com',
      name: 'Arnold Phipps',
    });
    // A nameless owner still needs something to show in a dropdown.
    expect(owners[1].name).toBe('b@x.com');
  });

  test('paginates until the cursor clears', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ results: [{ id: '1' }], paging: { next: { after: 'c2' } } })
      )
      .mockResolvedValueOnce(ok({ results: [{ id: '2' }] }));
    expect(await listOwners(TOKEN)).toHaveLength(2);
  });

  test('an error returns what it had, rather than throwing', async () => {
    fetchMock.mockResolvedValue(ok({}, 500));
    expect(await listOwners(TOKEN)).toEqual([]);
  });
});

describe('listMeetingLinks', () => {
  test('maps the organizer through USER id — not owner id', async () => {
    // A link names its organizer by user id; contacts and deals carry the owner id. Conflating them
    // silently breaks the record-owner ↔ meeting-organizer binding.
    fetchMock.mockResolvedValue(
      ok({ results: [{ slug: 'demo', name: 'Demo', organizerUserId: 'u_1' }] })
    );
    const links = await listMeetingLinks(TOKEN, [
      { id: 'own_1', user_id: 'u_1', email: 'a@x.com', name: 'Arnold Phipps' },
    ]);
    expect(links[0]).toEqual({
      slug: 'demo',
      name: 'Demo',
      owner_id: 'own_1',
      owner_name: 'Arnold Phipps',
      owner_email: 'a@x.com',
    });
  });

  test('an unmatched organizer leaves the owner fields undefined, not wrong', async () => {
    fetchMock.mockResolvedValue(
      ok({ results: [{ slug: 'demo', organizerUserId: 'u_9' }] })
    );
    const links = await listMeetingLinks(TOKEN, [
      { id: 'own_1', user_id: 'u_1' },
    ]);
    expect(links[0].owner_id).toBeUndefined();
  });

  test('owners are fetched when not supplied', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/owners')
        ? ok({ results: [{ id: 'own_1', userId: 'u_1' }] })
        : ok({ results: [{ slug: 'demo', organizerUserId: 'u_1' }] })
    );
    expect((await listMeetingLinks(TOKEN))[0].owner_id).toBe('own_1');
  });
});

describe('resolveOwnerName', () => {
  test('resolves a display name, falling back to the email', async () => {
    fetchMock.mockResolvedValue(
      ok({ firstName: 'Arnold', lastName: 'Phipps' })
    );
    expect(await resolveOwnerName(TOKEN, 'own_1')).toBe('Arnold Phipps');
    fetchMock.mockResolvedValue(ok({ email: 'a@x.com' }));
    expect(await resolveOwnerName(TOKEN, 'own_1')).toBe('a@x.com');
  });

  test('an empty id, a failure, or nothing usable is null', async () => {
    expect(await resolveOwnerName(TOKEN, '')).toBeNull();
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await resolveOwnerName(TOKEN, 'own_1')).toBeNull();
    fetchMock.mockResolvedValue(ok({}));
    expect(await resolveOwnerName(TOKEN, 'own_1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property options
// ─────────────────────────────────────────────────────────────────────────────

describe('listPropertyOptions', () => {
  test('returns visible options and SKIPS hidden ones', async () => {
    // Hidden options are archived in HubSpot's UI and must not reappear in ours.
    fetchMock.mockResolvedValue(
      ok({
        options: [
          { label: 'New', value: 'new' },
          { label: 'Archived', value: 'old', hidden: true },
        ],
      })
    );
    expect(await listPropertyOptions(TOKEN, 'hs_lead_status')).toEqual([
      { label: 'New', value: 'new' },
    ]);
  });

  test('a free-text or missing property yields an empty list', async () => {
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await listPropertyOptions(TOKEN, 'nope')).toEqual([]);
  });
});

describe('addPropertyOption', () => {
  test('REFUSES a property outside the allowlist', async () => {
    // Adding an option to an arbitrary property is a schema edit on someone else's CRM.
    const r = await addPropertyOption(TOKEN, 'firstname', 'X');
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('appends a new option, preserving the existing ones', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ options: [{ label: 'New', value: 'new' }] }))
      .mockResolvedValueOnce(
        ok({
          options: [
            { label: 'New', value: 'new' },
            { label: 'Engaged', value: 'engaged' },
          ],
        })
      );
    const r = await addPropertyOption(TOKEN, 'hs_lead_status', 'Engaged');
    expect(r).toMatchObject({ success: true, added: true });
    // HubSpot replaces rather than merges, so the whole list must be PATCHed back.
    const body = JSON.parse(
      (fetchMock.mock.calls[1][1] as { body: string }).body
    );
    expect(body.options).toHaveLength(2);
  });

  test('is IDEMPOTENT on value OR label', async () => {
    // HubSpot accepts duplicate labels, which then render as an unremovable duplicate entry.
    fetchMock.mockResolvedValue(
      ok({ options: [{ label: 'Engaged', value: 'engaged' }] })
    );
    expect(
      await addPropertyOption(TOKEN, 'hs_lead_status', 'Engaged')
    ).toMatchObject({
      success: true,
      added: false,
    });
    expect(
      await addPropertyOption(TOKEN, 'hs_lead_status', 'Different', 'engaged')
    ).toMatchObject({ added: false });
    // Only the GETs happened — no PATCH.
    expect(
      fetchMock.mock.calls.filter(
        (c) => (c[1] as { method?: string }).method === 'PATCH'
      )
    ).toHaveLength(0);
  });

  test('the value defaults to the label', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ options: [] }))
      .mockResolvedValueOnce(ok({ options: [] }));
    await addPropertyOption(TOKEN, 'lead_source', 'My Source');
    const body = JSON.parse(
      (fetchMock.mock.calls[1][1] as { body: string }).body
    );
    expect(body.options[0]).toMatchObject({
      label: 'My Source',
      value: 'My Source',
    });
  });

  test('the allowlist is exactly the two managed properties', () => {
    expect(MANAGED_CONTACT_PROPERTIES).toEqual([
      'hs_lead_status',
      'lead_source',
    ]);
  });
});

describe('discoverHubspotConfig', () => {
  test('assembles every dropdown source, fetching owners ONCE', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/owners'))
        return ok({ results: [{ id: 'own_1', userId: 'u_1' }] });
      if (u.includes('/meeting-links')) {
        return ok({ results: [{ slug: 'demo', organizerUserId: 'u_1' }] });
      }
      if (u.includes('/pipelines/deals')) {
        return ok({ results: [{ id: 'p1', label: 'Sales', stages: [] }] });
      }
      return ok({ options: [{ label: 'New', value: 'new' }] });
    });
    const cfg = await discoverHubspotConfig(TOKEN, AGENT);
    expect(cfg.owners).toHaveLength(1);
    expect(cfg.meeting_links[0].owner_id).toBe('own_1');
    expect(cfg.pipelines).toHaveLength(1);
    expect(cfg.lead_status_options).toHaveLength(1);
    expect(cfg.outbound_stages.length).toBeGreaterThan(0);
    // A portal with hundreds of owners is 100 per page — one pagination, not two.
    const ownerCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/crm/v3/owners?')
    );
    expect(ownerCalls).toHaveLength(1);
  });

  test('falls back to the default stages with no agent', async () => {
    const cfg = await discoverHubspotConfig(TOKEN, null);
    expect(cfg.outbound_stages.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureMeetingHost
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureMeetingHost', () => {
  test('resolves the owner name and caches it on the chat', async () => {
    seedAgent({ owner_id: 'own_1' });
    fetchMock.mockResolvedValue(
      ok({ firstName: 'Arnold', lastName: 'Phipps' })
    );
    expect(await ensureMeetingHost(CHAT, AGENT)).toBe('Arnold Phipps');
    expect(memory().meeting_host).toBe('Arnold Phipps');
  });

  test('an already-cached name short-circuits before ANY CRM call', async () => {
    seedChat({ meeting_host: 'Cached Name' });
    expect(await ensureMeetingHost(CHAT, AGENT)).toBe('Cached Name');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a TEST record uses the test owner — the calendar actually being booked', async () => {
    seedAgent({ owner_id: 'own_real', owner_id_test: 'own_test' });
    seedChat({ record_type: 'Test' });
    fetchMock.mockResolvedValue(ok({ firstName: 'Test', lastName: 'Rep' }));
    await ensureMeetingHost(CHAT, AGENT);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/owners/own_test');
  });

  test('a passed-in memory object is updated in place, so the turn is not stale', async () => {
    seedAgent({ owner_id: 'own_1' });
    fetchMock.mockResolvedValue(
      ok({ firstName: 'Arnold', lastName: 'Phipps' })
    );
    const mem = { agent_id: AGENT };
    await ensureMeetingHost(CHAT, AGENT, mem);
    expect((mem as Record<string, unknown>).meeting_host).toBe('Arnold Phipps');
  });

  test('no owner configured, no agent, or an unresolvable owner is null', async () => {
    expect(await ensureMeetingHost(CHAT, AGENT)).toBeNull(); // no owner_id configured
    expect(await ensureMeetingHost(CHAT, '')).toBeNull();
    seedAgent({ owner_id: 'own_1' });
    fetchMock.mockResolvedValue(ok({}, 404));
    expect(await ensureMeetingHost(CHAT, AGENT)).toBeNull();
    expect(memory().meeting_host).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two tools
// ─────────────────────────────────────────────────────────────────────────────

describe('get_hubspot_available_slots', () => {
  test('returns the slots for the resolved slug', async () => {
    slotsMock.mockResolvedValue({
      available_days: [
        { date: '2026-08-05', day_of_week: 'Wednesday', available_times: [] },
      ],
      total_slots: 1,
      timezone: 'America/Denver',
    });
    const r = payloadOf(
      await parseAndRunGetHubspotAvailableSlots(
        'tu1',
        { timezone: 'America/Denver', days_ahead: 5 },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(r.total_slots).toBe(1);
    expect(slotsMock).toHaveBeenCalledWith(
      expect.anything(),
      AGENT,
      'America/Denver',
      5,
      'real-slug'
    );
  });

  test('a TEST chat gets the TEST link’s slots', async () => {
    seedAgent({ meeting_slug: 'real-slug', meeting_slug_test: 'test-slug' });
    seedChat({ record_type: 'Test' });
    await parseAndRunGetHubspotAvailableSlots(
      'tu1',
      {},
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(slotsMock.mock.calls[0][4]).toBe('test-slug');
  });

  test('an unconnected action or a missing slug is an error payload', async () => {
    store.set(`agents/${AGENT}/actions/a1`, {
      status: 'active',
      provider: 'hubspot_v2',
      auth: {},
    });
    expect(
      String(
        payloadOf(
          await parseAndRunGetHubspotAvailableSlots(
            'tu1',
            {},
            { agent_id: AGENT }
          )
        ).error
      )
    ).toContain('not connected');

    seedAgent({ meeting_slug: '' });
    expect(
      String(
        payloadOf(
          await parseAndRunGetHubspotAvailableSlots(
            'tu1',
            {},
            { agent_id: AGENT }
          )
        ).error
      )
    ).toContain('No meeting_slug');
  });

  test('a fetch failure is reported in the payload, never thrown', async () => {
    slotsMock.mockRejectedValue(new Error('HubSpot down'));
    expect(
      String(
        payloadOf(
          await parseAndRunGetHubspotAvailableSlots(
            'tu1',
            {},
            { agent_id: AGENT, chat_id: CHAT }
          )
        ).error
      )
    ).toContain('HubSpot down');
  });
});

describe('schedule_hubspot_meeting', () => {
  test('prefers the RESOLVED slot over the model’s epoch', async () => {
    // A model turning "Friday at 10:45" into millis is exactly the arithmetic it gets wrong, and a
    // booking at the wrong time is worse than none.
    seedChat({
      _agreed_slot: {
        start_time_ms: 1_800_000_000_000,
        duration_ms: 900_000,
        label: 'L',
      },
    });
    await parseAndRunScheduleHubspotMeeting(
      'tu1',
      { start_time_ms: 1_111_111_111_111, duration_ms: 1_800_000 },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(bookMock.mock.calls[0][2]).toMatchObject({
      startTimeMs: 1_800_000_000_000,
      durationMs: 900_000,
    });
  });

  test('falls back to the model’s epoch when no slot was resolved', async () => {
    await parseAndRunScheduleHubspotMeeting(
      'tu1',
      { start_time_ms: 1_111_111_111_111, duration_ms: 900_000 },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(bookMock.mock.calls[0][2].startTimeMs).toBe(1_111_111_111_111);
  });

  test('name and email fall back to the chat', async () => {
    seedChat({
      first_name: 'Jane',
      last_name: 'Doe',
      customer_email: 'jane@corp.com',
    });
    await parseAndRunScheduleHubspotMeeting(
      'tu1',
      { start_time_ms: 1, duration_ms: 1 },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(bookMock.mock.calls[0][2]).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@corp.com',
    });
  });

  test('a multi-word surname stays intact', async () => {
    await parseAndRunScheduleHubspotMeeting(
      'tu1',
      { name: 'Jane van der Berg', start_time_ms: 1, duration_ms: 1 },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(bookMock.mock.calls[0][2].lastName).toBe('van der Berg');
  });

  test('on success it finalizes, schedules reminders, and clears the slot', async () => {
    seedChat({
      _agreed_slot: { start_time_ms: 1_800_000_000_000, duration_ms: 900_000 },
    });
    const r = payloadOf(
      await parseAndRunScheduleHubspotMeeting(
        'tu1',
        {},
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(r.meeting_link).toBe('https://meet/x');
    // Deterministic, because the model silently skipped them and left demos with no reminders.
    expect(r.reminders_scheduled).toBe(2);
    // Cleared, so a later turn cannot re-book the same time.
    expect(memory()._agreed_slot).toBeNull();
  });

  test('the booked-with email is captured when the chat had none', async () => {
    seedChat({ customer_email: '' });
    await parseAndRunScheduleHubspotMeeting(
      'tu1',
      { email: 'booked@corp.com', start_time_ms: 1, duration_ms: 1 },
      { agent_id: AGENT, chat_id: CHAT }
    );
    expect(memory().customer_email).toBe('booked@corp.com');
  });

  test('a booking THROW is reported as a failure payload', async () => {
    bookMock.mockRejectedValue(new Error('slot taken'));
    const r = payloadOf(
      await parseAndRunScheduleHubspotMeeting(
        'tu1',
        { start_time_ms: 1, duration_ms: 1 },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(r.success).toBe(false);
    expect(String(r.message)).toContain('slot taken');
  });

  test('an unsuccessful booking does NOT finalize or schedule reminders', async () => {
    bookMock.mockResolvedValue({ success: false, message: 'no availability' });
    const r = payloadOf(
      await parseAndRunScheduleHubspotMeeting(
        'tu1',
        { start_time_ms: 1, duration_ms: 1 },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    expect(r.success).toBe(false);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(remindersMock).not.toHaveBeenCalled();
  });

  test('a reminder failure does not fail the booking', async () => {
    remindersMock.mockRejectedValue(new Error('scheduler down'));
    const r = payloadOf(
      await parseAndRunScheduleHubspotMeeting(
        'tu1',
        { start_time_ms: 1, duration_ms: 1 },
        { agent_id: AGENT, chat_id: CHAT }
      )
    );
    // The meeting exists; losing the reminders must not report failure.
    expect(r.success).toBe(true);
    expect(r.meeting_link).toBe('https://meet/x');
  });

  test('an unconnected action refuses before booking', async () => {
    store.set(`agents/${AGENT}/actions/a1`, {
      status: 'active',
      provider: 'hubspot_v2',
      auth: {},
    });
    const r = payloadOf(
      await parseAndRunScheduleHubspotMeeting('tu1', {}, { agent_id: AGENT })
    );
    expect(r.success).toBe(false);
    expect(bookMock).not.toHaveBeenCalled();
  });
});
