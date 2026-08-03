/**
 * HubSpot meeting availability, booking, and the post-booking path.
 *
 * Closes the review's injected `resolveBookingSlot`, `makePhoneCall`'s availability injection, and the
 * conversation-init slot injection — the last three non-analytics CRM seams.
 *
 * ## Three filters on what may be offered, each fixing a specific reported bug
 *
 *  1. **15-minute durations ONLY.** The outbound demo is a 15-minute meeting, so the link's 30- and
 *     60-minute availability is ignored entirely — both what is shown and what is booked stay 15.
 *  2. **A 30-minute lead buffer.** Without it the agent offered slots starting now (the source records a
 *     "Thu 3:15/3:30" bug): there has to be time to actually place the call.
 *  3. **Never TODAY.** `d <= today` excludes the current day completely — same-day calls put the customer
 *     on the spot and read as sloppy. The source records a "Monday July 6 = today" bug here.
 *
 * ## Two months are fetched only when the window actually crosses one
 *
 * The availability endpoint is per-month, so a `days_ahead` window ending in the next month needs a
 * second call. Checking first keeps the common case at one request.
 *
 * ## `formatSlotsForVoice` lists EVERY time, not a selection
 *
 * The voice agent has no tool to fetch slots mid-call, so its prompt gets the full list for the next few
 * days and the model picks which to suggest. Capping here would silently narrow the prospect's options.
 *
 * ## Booking THROWS; everything after it does not
 *
 * `bookMeeting` raises on a non-2xx, because a failed booking must not look like a success — the caller
 * needs to tell the customer. Everything in `finalizeMeetingBooking` is individually wrapped instead:
 * by then the meeting EXISTS in HubSpot, so a failure to record it locally must not undo or hide that.
 *
 * ## `finalizeMeetingBooking` deliberately sends NO confirmation email
 *
 * The skill sends exactly one, as its last step, once `hubspot_meeting_link` is in memory. Sending here
 * too would produce either a duplicate or — worse — a linkless email that arrives before the link is
 * known. The separate `sendMeetingInvite` is the .ics attachment path, which is opt-in and fires
 * alongside HubSpot's own confirmation.
 */

import { DateTime } from 'luxon';

import { getMemory, setMemory } from '../firebase/chat';
import { setProspectStage } from '../firebase/prospect';
import { isOutboundChat, logEmailMessage, resolveOutboundName } from './chat';
import { resolveSendgridConfig } from './sendgridMail';
import {
  ORIGIN_TRANSACTIONAL,
  PROFILE_TRANSACTIONAL,
  sendEmail,
} from './emailSender';
import { HUBSPOT_BASE, accessToken, hsHeaders } from './hubspot';
import {
  logHubspotActivity,
  schedulingPageUrl,
  syncHubspotStage,
} from './hubspotDeals';
import type { HubspotConfig } from './hubspot';
import type { ChatMemory } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

/** The outbound demo length. The link's other durations are ignored — see the module note. */
const DEMO_DURATION_MINUTES = 15;

/** Time that must exist between now and an offered slot, so the call can actually be placed. */
const LEAD_BUFFER_MS = 30 * 60 * 1000;

/** HubSpot's default when a booking response omits the duration. */
const DEFAULT_DURATION_MS = 1_800_000;

export interface SlotTime {
  time: string;
  datetime: string;
  start_time_ms: number;
  duration_ms: number;
  duration_minutes: number;
}

export interface SlotDay {
  date: string;
  day_of_week: string;
  available_times: SlotTime[];
}

export interface Slots {
  available_days: SlotDay[];
  total_slots: number;
  timezone: string;
  error?: string;
}

export interface BookingInfo {
  success: boolean;
  message: string;
  booking_id?: string;
  contact_id?: string;
  start?: string;
  end?: string;
  duration_minutes?: number;
  meeting_url?: string;
  subject?: string;
  timezone?: string;
}

/** One month of availability for a meeting link, keyed by duration in milliseconds. */
export async function fetchMonthAvailability(
  slug: string,
  timezone: string,
  token: string,
  monthOffset = 0
): Promise<Record<string, unknown>> {
  const url =
    `${HUBSPOT_BASE}/scheduler/v3/meetings/meeting-links/book/availability-page/` +
    `${encodeURIComponent(slug)}?timezone=${encodeURIComponent(timezone)}&monthOffset=${monthOffset}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: hsHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 200) {
      const body = (await resp.json()) as Record<string, unknown>;
      const linkAvailability = (body.linkAvailability ?? {}) as Record<
        string,
        unknown
      >;
      return (linkAvailability.linkAvailabilityByDuration ?? {}) as Record<
        string,
        unknown
      >;
    }
    console.error(
      `[HS] availability ${resp.status}: ${(await resp.text()).slice(0, 200)}`
    );
  } catch (e) {
    console.error(`[HS] availability error: ${e}`);
  }
  return {};
}

/**
 * Turn raw availability into offerable days. See the module note for the three filters.
 *
 * Times are rendered in the prospect's own timezone, which is the whole point of passing it: a slot
 * described in the wrong zone is worse than no slot.
 */
export function formatSlots(
  availabilityByDuration: Record<string, unknown> | null | undefined,
  timezone: string,
  daysAhead: number
): Slots {
  if (
    !availabilityByDuration ||
    Object.keys(availabilityByDuration).length === 0
  ) {
    return { available_days: [], total_slots: 0, timezone };
  }

  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';
  const today = DateTime.now().setZone(zone).startOf('day');
  const cutoff = today.plus({ days: daysAhead });
  const minStartMs = Date.now() + LEAD_BUFFER_MS;

  const byDate = new Map<string, SlotDay>();

  for (const [durationMs, durData] of Object.entries(availabilityByDuration)) {
    const durMin = Math.floor(Number(durationMs) / 60000);
    // FILTER 1 — 15-minute demos only.
    if (durMin !== DEMO_DURATION_MINUTES) continue;

    const availabilities = ((durData ?? {}) as Record<string, unknown>)
      .availabilities as Array<Record<string, unknown>> | undefined;
    for (const slot of availabilities ?? []) {
      const startMs = Number(slot.startMillisUtc ?? 0);
      // FILTER 2 — the lead buffer, so "now" is never offered.
      if (!startMs || startMs < minStartMs) continue;

      const startDt = DateTime.fromMillis(startMs, { zone });
      const day = startDt.startOf('day');
      // FILTER 3 — never today, and never past the window.
      if (day <= today || day > cutoff) continue;

      const key = day.toISODate()!;
      if (!byDate.has(key)) {
        byDate.set(key, {
          date: key,
          day_of_week: startDt.toFormat('cccc'),
          available_times: [],
        });
      }
      byDate.get(key)!.available_times.push({
        time: startDt.toFormat('HH:mm'),
        datetime: startDt.toISO()!,
        start_time_ms: startMs,
        duration_ms: Number(durationMs),
        duration_minutes: durMin,
      });
    }
  }

  const days: SlotDay[] = [];
  let total = 0;
  for (const key of [...byDate.keys()].sort()) {
    const d = byDate.get(key)!;
    d.available_times.sort((a, b) => a.start_time_ms - b.start_time_ms);
    days.push(d);
    total += d.available_times.length;
  }
  return { available_days: days, total_slots: total, timezone };
}

/**
 * Availability as prompt facts for the voice agent.
 *
 * Lists EVERY time per day by default — see the module note. `maxPerDay` caps it when a caller needs to.
 * Deduped by `HH:MM` as a safety net, preserving start order.
 */
export function formatSlotsForVoice(
  slots: Slots | null | undefined,
  maxDays = 5,
  maxPerDay: number | null = null
): string {
  const days = slots?.available_days ?? [];
  if (days.length === 0) return '';

  const tz = slots?.timezone ?? '';
  const lines = [`AVAILABLE MEETING TIMES (times in ${tz}):`];
  for (const d of days.slice(0, maxDays)) {
    const seen = new Set<string>();
    const times: string[] = [];
    for (const t of d.available_times ?? []) {
      if (t.time && !seen.has(t.time)) {
        seen.add(t.time);
        times.push(t.time);
      }
      if (maxPerDay !== null && times.length >= maxPerDay) break;
    }
    if (times.length > 0) {
      lines.push(`- ${d.day_of_week} ${d.date}: ${times.join(', ')}`);
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Book the meeting link. THROWS on failure — see the module note on why this one does.
 */
export async function bookMeeting(
  token: string,
  slug: string,
  firstName: string,
  lastName: string,
  email: string,
  startTimeMs: number,
  durationMs: number,
  timezone: string
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${HUBSPOT_BASE}/scheduler/v3/meetings/meeting-links/book?timezone=${encodeURIComponent(timezone)}`,
    {
      method: 'POST',
      headers: hsHeaders(token),
      body: JSON.stringify({
        slug,
        firstName,
        lastName,
        email,
        startTime: startTimeMs,
        duration: durationMs,
        timezone,
        locale: 'en-us',
        guestEmails: [],
        likelyAvailableUserIds: [],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (resp.status === 200 || resp.status === 201) {
    return (await resp.json()) as Record<string, unknown>;
  }
  const body = (await resp.text()).slice(0, 300);
  console.error(`[HS] book meeting ${resp.status}: ${body}`);
  throw new Error(`HubSpot booking ${resp.status}: ${body}`);
}

/**
 * Normalize a booking response.
 *
 * The join link is named differently across meeting types, so four candidates are checked — otherwise
 * the confirmation email's link is blank whenever a conference URL exists under a different key.
 */
export function extractBookingInfo(
  result: Record<string, unknown>,
  timezone: string
): BookingInfo {
  const meetingUrl =
    (result.webConferenceUrl as string) ||
    (result.conferenceUrl as string) ||
    (result.joinUrl as string) ||
    (result.location as string) ||
    '';
  return {
    success: true,
    message: 'Meeting successfully scheduled',
    booking_id: (result.calendarEventId as string) ?? '',
    contact_id: (result.contactId as string) ?? '',
    start: (result.start as string) ?? '',
    end: (result.end as string) ?? '',
    duration_minutes: Math.floor(
      Number(result.duration ?? DEFAULT_DURATION_MS) / 60000
    ),
    meeting_url: meetingUrl,
    subject: (result.subject as string) ?? '',
    timezone: (result.bookingTimezone as string) ?? timezone,
  };
}

/** Fetch and format available slots. Returns `{error}` rather than throwing when unusable. */
export async function getHubspotSlots(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  timezone: string,
  daysAhead = 3,
  slugIn?: string | null
): Promise<Slots> {
  const slug = slugIn || cfg.meeting_slug;
  if (!slug) {
    return {
      available_days: [],
      total_slots: 0,
      timezone,
      error: 'meeting_slug not configured on the HubSpot v2 action',
    };
  }
  const token = await accessToken(cfg, agentId);
  if (!token) {
    return {
      available_days: [],
      total_slots: 0,
      timezone,
      error: 'HubSpot auth failed (no valid token)',
    };
  }

  const availability: Record<string, unknown> = {
    ...(await fetchMonthAvailability(slug, timezone, token, 0)),
  };
  // A second month only when the window actually crosses one.
  const now = DateTime.now();
  const end = now.plus({ days: daysAhead });
  if (end.month !== now.month || end.year !== now.year) {
    Object.assign(
      availability,
      await fetchMonthAvailability(slug, timezone, token, 1)
    );
  }
  return formatSlots(availability, timezone, daysAhead);
}

/** Book a slot on the meeting link. Returns a `success: false` result rather than throwing. */
export async function bookHubspotMeeting(
  cfg: Partial<HubspotConfig>,
  agentId: string,
  opts: {
    startTimeMs: number;
    durationMs: number;
    firstName: string;
    lastName: string;
    email: string;
    timezone: string;
    slug?: string | null;
  }
): Promise<BookingInfo> {
  const slug = opts.slug || cfg.meeting_slug;
  if (!slug) {
    return {
      success: false,
      message: 'meeting_slug not configured on the HubSpot v2 action',
    };
  }
  const token = await accessToken(cfg, agentId);
  if (!token) {
    return { success: false, message: 'HubSpot auth failed (no valid token)' };
  }
  const result = await bookMeeting(
    token,
    slug,
    opts.firstName,
    opts.lastName,
    opts.email,
    opts.startTimeMs,
    opts.durationMs,
    opts.timezone
  );
  return extractBookingInfo(result, opts.timezone);
}

/** A minimal RFC-5545 VEVENT for the booked meeting. All times UTC, CRLF line endings as the spec wants. */
export function buildIcs(
  bookingInfo: BookingInfo,
  startTimeMs: number,
  durationMs: number,
  toEmail: string,
  organizerEmail: string
): string {
  const fmt = (ms: number) =>
    DateTime.fromMillis(ms, { zone: 'utc' }).toFormat("yyyyMMdd'T'HHmmss'Z'");
  const subject = bookingInfo.subject || 'Auto Acquire AI demo';
  const location = bookingInfo.meeting_url || '';
  const uid = `${bookingInfo.booking_id || startTimeMs}-${toEmail}@autoacquireai.com`;
  const desc = location
    ? `Join: ${location}`
    : 'Your scheduled demo with Auto Acquire AI.';

  return (
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AutoAcquire AI//Outbound//EN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${fmt(Date.now())}`,
      `DTSTART:${fmt(startTimeMs)}`,
      `DTEND:${fmt(startTimeMs + (durationMs || DEFAULT_DURATION_MS))}`,
      `SUMMARY:${subject}`,
      `DESCRIPTION:${desc}`,
      `LOCATION:${location}`,
      `ORGANIZER;CN=Auto Acquire AI:mailto:${organizerEmail}`,
      `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${toEmail}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n') + '\r\n'
  );
}

/**
 * Email the customer an .ics invite for the booked meeting.
 *
 * Sent as TRANSACTIONAL: this is requested mail, so consent suppression does not block it — but a dead
 * address still does. Fires alongside HubSpot's own confirmation; the source accepts the double email.
 */
export async function sendMeetingInvite(
  bookingInfo: BookingInfo,
  actions: unknown[] | null | undefined,
  memory: ChatMemory,
  opts: {
    startTimeMs: number;
    durationMs: number;
    isPlayground?: boolean;
    chatId?: string | null;
  }
): Promise<boolean> {
  try {
    const toEmail = String(memory.customer_email ?? '').trim();
    if (!toEmail) return false;

    const cfg = resolveSendgridConfig(
      actions as Parameters<typeof resolveSendgridConfig>[0]
    );
    if (!cfg.api_key || !cfg.from_email) {
      console.warn('[HS] meeting invite skipped — SendGrid not configured');
      return false;
    }

    const ics = buildIcs(
      bookingInfo,
      opts.startTimeMs,
      opts.durationMs,
      toEmail,
      cfg.from_email
    );
    const b64 = Buffer.from(ics, 'utf-8').toString('base64');
    const startDt = DateTime.fromMillis(opts.startTimeMs, { zone: 'utc' });
    const subject = bookingInfo.subject || 'Your Auto Acquire AI demo';
    const location = bookingInfo.meeting_url || '';

    let text = `Your demo is confirmed for ${startDt.toFormat("cccc, LLLL dd, yyyy 'at' HH:mm 'UTC'")}.`;
    if (location) text += `\nJoin: ${location}`;
    text += '\n\nA calendar invite is attached.';

    // Stream label for Category Stats: this fires for outbound AND inbound web bookings, so it is
    // labelled by chat type — matching the HubSpot lead_source split.
    let stream: string | undefined;
    try {
      stream =
        !opts.chatId || (await isOutboundChat(opts.chatId))
          ? `${await resolveOutboundName(memory)} Outbound Comms`
          : 'Ava Inbound Comms - Web Widget';
    } catch {
      stream = undefined; // sendEmail derives the outbound stream from the resolved name
    }

    const res = await sendEmail({
      to: toEmail,
      subject: `Confirmed: ${subject}`,
      text,
      origin: ORIGIN_TRANSACTIONAL,
      profile: PROFILE_TRANSACTIONAL,
      stream,
      chatId: opts.chatId ?? null,
      agentId: String(memory.agent_id ?? ''),
      memory,
      fromEmail: cfg.from_email,
      fromName: cfg.from_name,
      apiKey: cfg.api_key,
      senderCfg: cfg,
      isPlayground: opts.isPlayground ?? false,
      attachments: [
        {
          content: b64,
          type: 'text/calendar; method=REQUEST',
          filename: 'invite.ics',
          disposition: 'attachment',
        },
      ],
    });

    const ok = !!res.success;
    if (ok && opts.chatId) {
      try {
        // Log our invite to the thread, so confirmations sit alongside the other emails.
        await logEmailMessage(
          opts.chatId,
          text,
          'outbound',
          `Confirmed: ${subject}`,
          { profile: res.profile, origin: res.origin }
        );
      } catch {
        // Audit only.
      }
    }
    return ok;
  } catch (e) {
    console.error(`[HS] sendMeetingInvite failed: ${e}`);
    return false;
  }
}

/**
 * The single post-booking path. Returns the meeting link, or `null`.
 *
 * Records the meeting, then advances an outbound prospect to Lead and syncs the deal. **Sends no
 * confirmation email** — see the module note. Every step is individually wrapped: by the time this runs
 * the meeting EXISTS in HubSpot, so a local failure must neither undo nor hide it.
 */
export async function finalizeMeetingBooking(
  chatId: string | null | undefined,
  agentId: string,
  actions: unknown[] | null | undefined,
  bookingInfo: BookingInfo,
  opts: {
    startTimeMs?: number;
    durationMs?: number;
    slug?: string | null;
    isPlayground?: boolean;
  } = {}
): Promise<string | null> {
  void actions;
  const meetingLink =
    bookingInfo.meeting_url || schedulingPageUrl(opts.slug ?? null);

  // 1. The meeting record. `hubspot_meeting_link` is guaranteed non-empty, because the skill's one
  //    confirmation email waits on it — a blank link would strand the email forever.
  try {
    const updates: Record<string, unknown> = {
      meeting_booked: true,
      meeting_at: null,
      hubspot_meeting_link: meetingLink,
    };
    if (opts.startTimeMs) {
      updates.meeting_at = DateTime.fromMillis(opts.startTimeMs, {
        zone: 'utc',
      }).toISO();
    }
    if (bookingInfo.contact_id) {
      updates.hubspot_contact_id = bookingInfo.contact_id;
    }
    // The calendar-event id: insurance, and what a future RSVP reconciliation would key on.
    if (bookingInfo.booking_id) updates.booking_id = bookingInfo.booking_id;

    if (chatId) {
      await setMemory(chatId, updates);
      await logHubspotActivity(
        chatId,
        'hubspot_meeting_booked',
        { start: updates.meeting_at, slug: opts.slug },
        { meeting_link: meetingLink }
      );
    }
  } catch (e) {
    console.warn(`[HS] meeting memory write failed chat=${chatId}: ${e}`);
  }

  // 2. Lead stage (outbound only) + the deal, via the sync that tags record_type.
  try {
    if (chatId && (await isOutboundChat(chatId))) {
      const mem = (await getMemory(chatId)) ?? {};
      await setProspectStage(
        chatId,
        'Lead',
        'outbound_meeting_booked',
        String(mem.dealers_id ?? mem.dealer_id ?? ''),
        String(mem.company_id ?? '')
      );
      await syncHubspotStage(chatId, agentId);
    }
  } catch (e) {
    console.warn(`[HS] Lead/Deal step failed chat=${chatId}: ${e}`);
  }

  return meetingLink;
}

export const __testing = {
  DEMO_DURATION_MINUTES,
  LEAD_BUFFER_MS,
  DEFAULT_DURATION_MS,
};

// ─────────────────────────────────────────────────────────────────────────────
// The review's slot matcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match an agreed demo time to a bookable slot, then schedule the `book_meeting` task.
 *
 * This is the implementation of the review orchestrator's injected `resolveBookingSlot`.
 *
 * **It is a pure slot MATCHER.** `classifyCallOutcome` has already decided the call was a demo, and this
 * must never re-judge that — it only answers "which of the offered slots did they agree to". Returning
 * `resolved: false` means no slot matched (availability, config, or no firm time), and the caller still
 * schedules a booking task: a demo is never downgraded to a callback.
 *
 * Matching is deliberately LENIENT — the closest slot on the agreed day — because the voice agent read
 * times aloud and the prospect answered in prose. Demanding an exact match would fail most real bookings.
 */
export async function resolveAndScheduleBookingTask(input: {
  chatId: string;
  agentId: string;
  transcript: string;
  memory: ChatMemory;
  metaData?: unknown;
  agreedTime?: string | null;
}): Promise<{
  resolved: boolean;
  label: string | null;
  start_time_ms: number | null;
}> {
  const result = {
    resolved: false,
    label: null as string | null,
    start_time_ms: null as number | null,
  };
  try {
    const { chatId, agentId, transcript, memory, agreedTime } = input;
    const { getAgentActions } = await import('../firebase/agent');
    const { resolveHubspotConfig, resolveMeetingSlug } =
      await import('./hubspot');
    const { llmText, parseJsonResponse, MAX_TRANSCRIPT_CHARS } =
      await import('../tools/reviewHelpers');
    const { createTaskWithId, deleteUnexecutedTasksByType } =
      await import('../firebase/chat');

    const actions = agentId ? ((await getAgentActions(agentId)) ?? []) : [];
    const cfg = resolveHubspotConfig(actions);
    if (!cfg.refresh_token && !cfg.access_token) return result;

    const slug = resolveMeetingSlug(cfg, memory.record_type);
    if (!slug) return result;

    const email = String(memory.customer_email ?? '');
    if (!email) {
      console.log(
        "[REVIEW][BOOK] no customer_email — can't schedule a booking"
      );
      return result;
    }

    const tz = String(memory.timezone ?? 'America/New_York');
    const slots = await getHubspotSlots(cfg, agentId, tz, 9, slug);

    // Flatten to a numbered, date+time-deduped list carrying the booking millis — the same list the
    // voice agent was offered, already filtered of past and too-soon slots by formatSlots.
    const options: Array<{
      id: number;
      label: string;
      start_time_ms: number;
      duration_ms: number;
    }> = [];
    const seen = new Set<string>();
    for (const day of slots.available_days ?? []) {
      for (const t of day.available_times ?? []) {
        const key = `${day.date}|${t.time}`;
        if (!t.start_time_ms || seen.has(key)) continue;
        seen.add(key);
        options.push({
          id: options.length + 1,
          label: `${day.day_of_week} ${day.date} at ${t.time}`,
          start_time_ms: t.start_time_ms,
          duration_ms: t.duration_ms || DEFAULT_DURATION_MS,
        });
      }
    }
    if (options.length === 0) {
      console.log('[REVIEW][BOOK] no HubSpot availability to match against');
      return result;
    }

    const listing = options
      .slice(0, 40)
      .map((o) => `${o.id}. ${o.label}`)
      .join('\n');
    const system =
      'The prospect has ALREADY agreed to attend a demo (decided upstream) — your ONLY job is to MATCH ' +
      'the demo time they agreed to against the available slots. Pick the slot_id for that day+time; if ' +
      "the exact time isn't listed, choose the CLOSEST slot on the SAME day. Return null ONLY if no " +
      'specific day/time was actually agreed anywhere in the transcript.\n' +
      'Respond with JSON only: {"slot_id": <number or null>}.';
    const hint = agreedTime
      ? `AGREED DEMO TIME (from upstream classification): ${agreedTime}\n\n`
      : '';
    const user =
      `${hint}AVAILABLE SLOTS:\n${listing}\n\nTRANSCRIPT:\n` +
      `${transcript.slice(-MAX_TRANSCRIPT_CHARS)}\n\n` +
      'Which slot_id matches the agreed demo time?';

    const parsed = parseJsonResponse(await llmText(system, user));
    const slotId = parsed.slot_id;
    if (typeof slotId !== 'number' || !Number.isInteger(slotId)) {
      console.log(
        `[REVIEW][BOOK] no firm slot agreed (slot_id=${JSON.stringify(slotId)})`
      );
      return result;
    }
    const chosen = options.find((o) => o.id === slotId);
    if (!chosen) {
      console.log(`[REVIEW][BOOK] slot_id ${slotId} not in options`);
      return result;
    }

    if (chatId) {
      // The field the booking tool consumes.
      await setMemory(chatId, {
        _agreed_slot: {
          start_time_ms: chosen.start_time_ms,
          duration_ms: chosen.duration_ms,
          label: chosen.label,
        },
      });
      // Drop any prior unexecuted booking task, then create a fresh one.
      await deleteUnexecutedTasksByType(chatId, 'book_meeting');
      const notes =
        `The customer agreed to a demo at ${chosen.label}. Call ` +
        'schedule_hubspot_meeting FIRST (it uses the agreed slot). Do NOT call ' +
        'send_email for the confirmation until schedule_hubspot_meeting has returned ' +
        'success in this turn — that success sets the meeting link. Only then send ' +
        'exactly one confirmation email, including that link, as your last step.';
      await createTaskWithId(
        chatId,
        'book_meeting',
        new Date(Date.now() + 60 * 1000),
        {
          notes,
          agent_id: agentId,
          account_id: agentId,
          attendee_id: memory.phone_number,
          task_source: 'book_after_call',
        }
      );
    }
    console.log(
      `[REVIEW][BOOK] resolved slot ${chosen.label} → scheduled book_meeting task for chat=${chatId}`
    );
    return {
      resolved: true,
      label: chosen.label,
      start_time_ms: chosen.start_time_ms,
    };
  } catch (e) {
    console.warn(`[REVIEW][BOOK] resolve/schedule failed (non-blocking): ${e}`);
    return result;
  }
}

/**
 * The availability block for a voice call's prompt facts, or `''`.
 *
 * Shared by the outbound dial and the inbound conversation-init, which is why it lives here rather than
 * being written twice. Best-effort: no HubSpot, no slug, or no availability all yield `''`, and the call
 * still happens — just without bookable times.
 */
export async function buildAvailabilityBlock(
  agentId: string,
  memory: ChatMemory,
  daysAhead = 9
): Promise<string> {
  try {
    const { getAgentActions } = await import('../firebase/agent');
    const { resolveHubspotConfig, resolveMeetingSlug } =
      await import('./hubspot');
    const { buildVoiceSchedulingBlock } = await import('./callScope');

    const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
    if (!cfg.refresh_token && !cfg.access_token) return '';
    const slug = resolveMeetingSlug(cfg, memory.record_type);
    if (!slug) return '';

    const tz = String(memory.timezone ?? 'America/New_York');
    const slotsText = formatSlotsForVoice(
      await getHubspotSlots(cfg, agentId, tz, daysAhead, slug)
    );
    if (!slotsText) return '';
    return buildVoiceSchedulingBlock(
      slotsText,
      schedulingPageUrl(slug) ?? undefined
    );
  } catch (e) {
    console.warn(`[HS] availability block skipped: ${e}`);
    return '';
  }
}
