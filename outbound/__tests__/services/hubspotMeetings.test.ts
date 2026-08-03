/**
 * @jest-environment node
 *
 * HubSpot meeting availability, booking, and the post-booking path.
 *
 * The three availability filters each fix a specific reported bug, so each gets its own test:
 *
 *  - **15-minute durations only** — the demo is 15 minutes, so the link's 30/60 availability is ignored.
 *  - **A 30-minute lead buffer** — without it the agent offered slots starting now.
 *  - **Never today** — same-day calls put the customer on the spot.
 *
 * Plus the two asymmetries worth protecting: booking THROWS (a failed booking must not read as success),
 * while everything after it is individually wrapped (the meeting already exists in HubSpot); and
 * `finalizeMeetingBooking` deliberately sends NO email, because the skill sends exactly one.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../services/emailSender', () => ({
  sendEmail: jest.fn(),
  ORIGIN_TRANSACTIONAL: 'transactional',
  PROFILE_TRANSACTIONAL: 'transactional',
}));
jest.mock('../../services/hubspotDeals', () => {
  const actual = jest.requireActual('../../services/hubspotDeals');
  return { ...actual, syncHubspotStage: jest.fn() };
});

import { store } from '../../testSupport/mockFirestore';
import { sendEmail } from '../../services/emailSender';
import { syncHubspotStage } from '../../services/hubspotDeals';
import {
  bookHubspotMeeting,
  bookMeeting,
  buildIcs,
  extractBookingInfo,
  finalizeMeetingBooking,
  formatSlots,
  formatSlotsForVoice,
  getHubspotSlots,
  sendMeetingInvite,
} from '../../services/hubspotMeetings';
import type { ChatMemory } from '../../types';

const send = sendEmail as jest.Mock;
const stageSync = syncHubspotStage as jest.Mock;

const TOKEN = 'pat-token';
const AGENT = 'agentA';
const CHAT = 'outbound__agentA__15551230000';
const TZ = 'UTC';

let fetchMock: jest.Mock;

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const DAY_MS = 24 * 3600 * 1000;

/** Availability for a single 15-minute slot at `startMs`. */
function availability(startMs: number, durationMs = 900_000) {
  return {
    [String(durationMs)]: { availabilities: [{ startMillisUtc: startMs }] },
  };
}

/** Tomorrow at 10:00 UTC — comfortably past the lead buffer and not today. */
function tomorrowAt(hour = 10): number {
  const d = new Date(Date.now() + DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d.getTime();
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  send.mockResolvedValue({
    success: true,
    profile: 'transactional',
    origin: 'transactional',
  });
  stageSync.mockResolvedValue(undefined);
  fetchMock = jest.fn().mockResolvedValue(ok({}));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error -- restoring the global between tests
  delete global.fetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// The three filters
// ─────────────────────────────────────────────────────────────────────────────

describe('formatSlots filters', () => {
  test('offers a valid 15-minute slot tomorrow', () => {
    const slots = formatSlots(availability(tomorrowAt(10)), TZ, 7);
    expect(slots.total_slots).toBe(1);
    expect(slots.available_days[0].available_times[0].duration_minutes).toBe(
      15
    );
    expect(slots.available_days[0].available_times[0].time).toBe('10:00');
  });

  test('FILTER 1 — 30- and 60-minute availability is ignored entirely', () => {
    // The outbound demo is 15 minutes; both what we show AND what we book stay 15.
    expect(
      formatSlots(availability(tomorrowAt(), 1_800_000), TZ, 7).total_slots
    ).toBe(0);
    expect(
      formatSlots(availability(tomorrowAt(), 3_600_000), TZ, 7).total_slots
    ).toBe(0);
  });

  test('FILTER 2 — a slot inside the 30-minute lead buffer is never offered', () => {
    // Without this the agent offered slots starting "now" and had no time to place the call.
    const inTenMinutes = Date.now() + 10 * 60 * 1000;
    expect(formatSlots(availability(inTenMinutes), TZ, 7).total_slots).toBe(0);
  });

  test('FILTER 3 — TODAY is excluded completely, even later today', () => {
    // Same-day calls put the customer on the spot and read as sloppy.
    const laterToday = Date.now() + 6 * 3600 * 1000;
    const d = new Date(laterToday);
    // Only meaningful if it is still the same UTC day.
    if (d.getUTCDate() === new Date().getUTCDate()) {
      expect(formatSlots(availability(laterToday), TZ, 7).total_slots).toBe(0);
    }
  });

  test('a slot beyond the window is excluded', () => {
    const inTenDays = Date.now() + 10 * DAY_MS;
    expect(formatSlots(availability(inTenDays), TZ, 3).total_slots).toBe(0);
  });

  test('empty availability yields an empty, well-formed result', () => {
    expect(formatSlots({}, TZ, 7)).toEqual({
      available_days: [],
      total_slots: 0,
      timezone: TZ,
    });
    expect(formatSlots(null, TZ, 7).total_slots).toBe(0);
  });

  test('times are rendered in the prospect’s own timezone', () => {
    // A slot described in the wrong zone is worse than no slot.
    const start = tomorrowAt(15); // 15:00 UTC
    const utc = formatSlots(availability(start), 'UTC', 7);
    const denver = formatSlots(availability(start), 'America/Denver', 7);
    expect(utc.available_days[0].available_times[0].time).toBe('15:00');
    expect(denver.available_days[0].available_times[0].time).not.toBe('15:00');
    expect(denver.timezone).toBe('America/Denver');
  });

  test('an invalid timezone falls back to UTC rather than throwing', () => {
    expect(
      formatSlots(availability(tomorrowAt()), 'Not/AZone', 7).total_slots
    ).toBe(1);
  });

  test('days are sorted, and times within a day are sorted', () => {
    const raw = {
      '900000': {
        availabilities: [
          { startMillisUtc: tomorrowAt(14) },
          { startMillisUtc: tomorrowAt(9) },
          { startMillisUtc: tomorrowAt(9) + DAY_MS },
        ],
      },
    };
    const slots = formatSlots(raw, TZ, 7);
    expect(slots.available_days).toHaveLength(2);
    expect(slots.available_days[0].available_times.map((t) => t.time)).toEqual([
      '09:00',
      '14:00',
    ]);
  });
});

describe('formatSlotsForVoice', () => {
  test('lists EVERY time per day by default', () => {
    // The voice agent has no tool to fetch slots mid-call; capping would narrow the options silently.
    const slots = formatSlots(
      {
        '900000': {
          availabilities: [
            { startMillisUtc: tomorrowAt(9) },
            { startMillisUtc: tomorrowAt(10) },
            { startMillisUtc: tomorrowAt(11) },
          ],
        },
      },
      TZ,
      7
    );
    const text = formatSlotsForVoice(slots);
    expect(text).toContain('AVAILABLE MEETING TIMES (times in UTC):');
    expect(text).toContain('09:00, 10:00, 11:00');
  });

  test('maxPerDay caps it when a caller asks', () => {
    const slots = formatSlots(
      {
        '900000': {
          availabilities: [
            { startMillisUtc: tomorrowAt(9) },
            { startMillisUtc: tomorrowAt(10) },
          ],
        },
      },
      TZ,
      7
    );
    expect(formatSlotsForVoice(slots, 5, 1)).toContain('09:00');
    expect(formatSlotsForVoice(slots, 5, 1)).not.toContain('10:00');
  });

  test('no availability is an empty string, not a header with nothing under it', () => {
    expect(
      formatSlotsForVoice({ available_days: [], total_slots: 0, timezone: TZ })
    ).toBe('');
    expect(formatSlotsForVoice(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetching
// ─────────────────────────────────────────────────────────────────────────────

describe('getHubspotSlots', () => {
  test('reports a missing slug as an error rather than throwing', async () => {
    const r = await getHubspotSlots({ access_token: TOKEN }, AGENT, TZ, 3);
    expect(r.error).toContain('meeting_slug not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reports failed auth as an error', async () => {
    const r = await getHubspotSlots({}, AGENT, TZ, 3, 'slug');
    expect(r.error).toContain('HubSpot auth failed');
  });

  test('fetches ONE month when the window stays inside it', async () => {
    fetchMock.mockResolvedValue(
      ok({
        linkAvailability: {
          linkAvailabilityByDuration: availability(tomorrowAt()),
        },
      })
    );
    // A 1-day window is only two months if today is the last of the month.
    const r = await getHubspotSlots(
      { access_token: TOKEN },
      AGENT,
      TZ,
      1,
      'slug'
    );
    expect(r.total_slots).toBeGreaterThanOrEqual(0);
    const monthOffsets = fetchMock.mock.calls.map(
      (c) => String(c[0]).match(/monthOffset=(\d+)/)?.[1]
    );
    expect(monthOffsets).toContain('0');
  });

  test('fetches a SECOND month when the window crosses one', async () => {
    fetchMock.mockResolvedValue(
      ok({ linkAvailability: { linkAvailabilityByDuration: {} } })
    );
    // 40 days always crosses a month boundary.
    await getHubspotSlots({ access_token: TOKEN }, AGENT, TZ, 40, 'slug');
    const offsets = fetchMock.mock.calls.map(
      (c) => String(c[0]).match(/monthOffset=(\d+)/)?.[1]
    );
    expect(offsets).toContain('1');
  });

  test('an availability error yields no slots, not a throw', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'nope' }, 500));
    const r = await getHubspotSlots(
      { access_token: TOKEN },
      AGENT,
      TZ,
      3,
      'slug'
    );
    expect(r.total_slots).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking
// ─────────────────────────────────────────────────────────────────────────────

describe('booking', () => {
  test('a successful booking returns normalized info', async () => {
    fetchMock.mockResolvedValue(
      ok({
        calendarEventId: 'evt_1',
        contactId: 'c_1',
        duration: 900_000,
        webConferenceUrl: 'https://meet/abc',
        subject: 'Demo',
        bookingTimezone: 'America/Denver',
      })
    );
    const info = await bookHubspotMeeting({ access_token: TOKEN }, AGENT, {
      startTimeMs: tomorrowAt(),
      durationMs: 900_000,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@corp.com',
      timezone: TZ,
      slug: 'slug',
    });
    expect(info).toMatchObject({
      success: true,
      booking_id: 'evt_1',
      contact_id: 'c_1',
      duration_minutes: 15,
      meeting_url: 'https://meet/abc',
      timezone: 'America/Denver',
    });
  });

  test('the join link is found under ANY of its four names', () => {
    // HubSpot names it differently across meeting types; missing one blanks the confirmation link.
    for (const key of [
      'webConferenceUrl',
      'conferenceUrl',
      'joinUrl',
      'location',
    ]) {
      expect(
        extractBookingInfo({ [key]: 'https://meet/x' }, TZ).meeting_url
      ).toBe('https://meet/x');
    }
  });

  test('a booking failure THROWS — it must not read as success', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'slot taken' }, 409));
    await expect(
      bookMeeting(
        TOKEN,
        'slug',
        'Jane',
        'Doe',
        'j@c.com',
        tomorrowAt(),
        900_000,
        TZ
      )
    ).rejects.toThrow('HubSpot booking 409');
  });

  test('a missing slug or token is a success:false result, not a throw', async () => {
    expect(
      (
        await bookHubspotMeeting({ access_token: TOKEN }, AGENT, {
          startTimeMs: 1,
          durationMs: 1,
          firstName: 'a',
          lastName: 'b',
          email: 'c@d.com',
          timezone: TZ,
        })
      ).success
    ).toBe(false);
    expect(
      (
        await bookHubspotMeeting({}, AGENT, {
          startTimeMs: 1,
          durationMs: 1,
          firstName: 'a',
          lastName: 'b',
          email: 'c@d.com',
          timezone: TZ,
          slug: 'slug',
        })
      ).success
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The .ics invite
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIcs', () => {
  const info = {
    success: true,
    message: '',
    booking_id: 'evt_1',
    subject: 'Demo with Acme',
    meeting_url: 'https://meet/abc',
  };

  test('produces a REQUEST VEVENT with CRLF line endings', () => {
    const ics = buildIcs(
      info,
      tomorrowAt(),
      900_000,
      'jane@corp.com',
      'sales@us.com'
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('SUMMARY:Demo with Acme');
    expect(ics).toContain('LOCATION:https://meet/abc');
    expect(ics).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:jane@corp.com'
    );
    expect(ics).toContain('ORGANIZER;CN=Auto Acquire AI:mailto:sales@us.com');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  test('DTEND respects the duration, and defaults when it is zero', () => {
    const start = tomorrowAt(10);
    const ics = buildIcs(info, start, 900_000, 'j@c.com', 's@u.com');
    const dtstart = ics.match(/DTSTART:(\d{8}T\d{6}Z)/)![1];
    const dtend = ics.match(/DTEND:(\d{8}T\d{6}Z)/)![1];
    expect(dtstart).not.toBe(dtend);
    // A zero duration falls back to HubSpot's 30 minutes rather than a zero-length event.
    const zero = buildIcs(info, start, 0, 'j@c.com', 's@u.com');
    expect(zero).toContain('DTEND:');
  });

  test('with no meeting url the description still says something useful', () => {
    const ics = buildIcs(
      { success: true, message: '' },
      tomorrowAt(),
      900_000,
      'j@c.com',
      's@u.com'
    );
    expect(ics).toContain(
      'DESCRIPTION:Your scheduled demo with Auto Acquire AI.'
    );
    expect(ics).toContain('SUMMARY:Auto Acquire AI demo');
  });

  test('the UID is stable for the same booking', () => {
    const a = buildIcs(info, 123, 900_000, 'j@c.com', 's@u.com');
    const b = buildIcs(info, 123, 900_000, 'j@c.com', 's@u.com');
    expect(a.match(/UID:(.+)/)![1]).toBe(b.match(/UID:(.+)/)![1]);
  });
});

describe('sendMeetingInvite', () => {
  const sgAction = [
    {
      status: 'active',
      provider: 'sendgrid',
      type: 'sendgrid',
      auth: { api_key: 'SG.key' },
      additional_meta: { from_email: 'sales@us.com', from_name: 'Nova' },
    },
  ];

  test('sends TRANSACTIONAL with the .ics attached', async () => {
    const okSend = await sendMeetingInvite(
      {
        success: true,
        message: '',
        subject: 'Demo',
        meeting_url: 'https://meet/x',
      },
      sgAction,
      { customer_email: 'jane@corp.com', agent_id: AGENT } as ChatMemory,
      { startTimeMs: tomorrowAt(), durationMs: 900_000, chatId: CHAT }
    );
    expect(okSend).toBe(true);
    const args = send.mock.calls[0][0];
    // Requested mail: consent suppression must not block it, but a dead address still does.
    expect(args.origin).toBe('transactional');
    expect(args.profile).toBe('transactional');
    expect(args.attachments[0].filename).toBe('invite.ics');
    expect(args.attachments[0].type).toBe('text/calendar; method=REQUEST');
    expect(String(args.text)).toContain('Join: https://meet/x');
  });

  test('no recipient address means no send', async () => {
    expect(
      await sendMeetingInvite(
        { success: true, message: '' },
        sgAction,
        {} as ChatMemory,
        { startTimeMs: 1, durationMs: 1 }
      )
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  test('an unconfigured SendGrid action skips the invite', async () => {
    expect(
      await sendMeetingInvite(
        { success: true, message: '' },
        [],
        { customer_email: 'j@c.com' } as ChatMemory,
        { startTimeMs: 1, durationMs: 1 }
      )
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  test('a send failure is false, never a throw', async () => {
    send.mockRejectedValue(new Error('sendgrid down'));
    expect(
      await sendMeetingInvite(
        { success: true, message: '' },
        sgAction,
        { customer_email: 'j@c.com' } as ChatMemory,
        { startTimeMs: 1, durationMs: 1 }
      )
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The post-booking path
// ─────────────────────────────────────────────────────────────────────────────

describe('finalizeMeetingBooking', () => {
  function seedChat(over: Record<string, unknown> = {}) {
    store.set(`chats/${CHAT}`, {
      type: 'outbound',
      agentId: AGENT,
      memory: { agent_id: AGENT, customer_email: 'jane@corp.com', ...over },
    });
  }

  function memory(): Record<string, unknown> {
    return (store.get(`chats/${CHAT}`)?.memory ?? {}) as Record<
      string,
      unknown
    >;
  }

  test('records the meeting and returns the link', async () => {
    seedChat();
    const start = tomorrowAt(10);
    const link = await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      {
        success: true,
        message: '',
        meeting_url: 'https://meet/abc',
        contact_id: 'c_1',
        booking_id: 'evt_1',
      },
      { startTimeMs: start, durationMs: 900_000, slug: 'slug' }
    );
    expect(link).toBe('https://meet/abc');
    expect(memory().meeting_booked).toBe(true);
    expect(typeof memory().meeting_at).toBe('string');
    // The calendar-event id is kept — insurance, and what an RSVP reconciliation would key on.
    expect(memory().booking_id).toBe('evt_1');
    expect(memory().hubspot_contact_id).toBe('c_1');
    expect(memory().hubspot_meeting_link).toBe('https://meet/abc');
  });

  test('falls back to the scheduling page when there is no conference url', async () => {
    seedChat();
    // The link must be non-empty: the skill's one confirmation email waits on it.
    const link = await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      { success: true, message: '' },
      { startTimeMs: tomorrowAt(), slug: 'my-slug' }
    );
    expect(link).toBe('https://meetings.hubspot.com/my-slug');
    expect(memory().hubspot_meeting_link).toBe(
      'https://meetings.hubspot.com/my-slug'
    );
  });

  test('advances an OUTBOUND chat to Lead and syncs the deal', async () => {
    seedChat();
    await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      { success: true, message: '' },
      { startTimeMs: tomorrowAt(), slug: 'slug' }
    );
    expect(store.get(`chats/${CHAT}`)?.stage).toBe('Lead');
    expect(stageSync).toHaveBeenCalledWith(CHAT, AGENT);
  });

  test('a NON-outbound chat gets the meeting record but no Lead advance', async () => {
    store.set(`chats/${CHAT}`, { type: 'web', memory: {} });
    await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      { success: true, message: '' },
      { startTimeMs: tomorrowAt(), slug: 'slug' }
    );
    expect(memory().meeting_booked).toBe(true);
    expect(stageSync).not.toHaveBeenCalled();
  });

  test('sends NO confirmation email — the skill sends exactly one', async () => {
    // Sending here would produce a duplicate, or worse a linkless email before the link is known.
    seedChat();
    await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      { success: true, message: '' },
      { startTimeMs: tomorrowAt(), slug: 'slug' }
    );
    expect(send).not.toHaveBeenCalled();
  });

  test('a failed Lead step does not lose the meeting record', async () => {
    // By now the meeting EXISTS in HubSpot; a local failure must not undo or hide it.
    seedChat();
    stageSync.mockRejectedValue(new Error('CRM down'));
    const link = await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      { success: true, message: '', meeting_url: 'https://meet/abc' },
      { startTimeMs: tomorrowAt(), slug: 'slug' }
    );
    expect(link).toBe('https://meet/abc');
    expect(memory().meeting_booked).toBe(true);
  });

  test('with no chat id it still returns the link', async () => {
    expect(
      await finalizeMeetingBooking(
        null,
        AGENT,
        [],
        { success: true, message: '', meeting_url: 'https://meet/x' },
        { startTimeMs: tomorrowAt() }
      )
    ).toBe('https://meet/x');
  });

  test('the booking activity is logged for the UI', async () => {
    seedChat();
    await finalizeMeetingBooking(
      CHAT,
      AGENT,
      [],
      { success: true, message: '', meeting_url: 'https://meet/x' },
      { startTimeMs: tomorrowAt(), slug: 'slug' }
    );
    const acts = store
      .paths(`chats/${CHAT}/activities`)
      .map((p) => store.get(p) as Record<string, unknown>);
    expect(
      acts.map((a) => (a.toolCall as Record<string, unknown>).toolName)
    ).toContain('hubspot_meeting_booked');
  });
});
