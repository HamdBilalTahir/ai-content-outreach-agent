/**
 * The two HubSpot meeting tools: `get_hubspot_available_slots` and `schedule_hubspot_meeting`.
 *
 * ## Config comes from the agent's ACTIONS, not the skill's tool scoping
 *
 * Both tools resolve the HubSpot v2 action directly. That is deliberate: it means the action needs no
 * `functions` list to be usable, so connecting HubSpot is enough and a skill author cannot accidentally
 * scope the CRM out of existence.
 *
 * ## The RESOLVED slot beats whatever the model supplies
 *
 * `schedule_hubspot_meeting` prefers `memory._agreed_slot` — the exact millis the review's slot matcher
 * resolved from the transcript — over the `start_time_ms` the model passes in. Models are unreliable at
 * turning "Friday at 10:45" into an epoch, and a booking at the wrong time is worse than no booking.
 * The model's value is the fallback, used only when no agreed slot is on record.
 *
 * ## Booking does three things the caller must not have to remember
 *
 * On success it captures the email the customer booked with (if the chat had none), runs the shared
 * post-booking path, and **deterministically schedules the pre-demo reminders** — the source records
 * that leaving reminders to the model meant it silently skipped them, producing booked demos with no
 * reminders at all. Then it clears `_agreed_slot`, so a later turn cannot re-book the same time.
 *
 * ## No email is sent here
 *
 * The skill sends the ONE confirmation email as its last step, using the `hubspot_meeting_link` this
 * populates. See `hubspotMeetings.finalizeMeetingBooking` for why that split exists.
 */

import { getMemory, setMemory } from '../firebase/chat';
import { getAgentActions } from '../firebase/agent';
import { resolveHubspotConfig, resolveMeetingSlug } from '../services/hubspot';
import {
  bookHubspotMeeting,
  finalizeMeetingBooking,
  getHubspotSlots,
} from '../services/hubspotMeetings';
import { scheduleBookingReminders } from '../services/reminders';
import { registerTool } from '../llm/toolRegistry';
import type { BedrockMessage } from '../types';
import type { AgentAction } from '../firebase/agent';

function toolResult(
  toolUseId: string,
  payload: Record<string, unknown>
): BedrockMessage {
  return {
    role: 'user',
    content: [{ toolResult: { toolUseId, content: [{ json: payload }] } }],
  } as unknown as BedrockMessage;
}

export interface MeetingToolMeta {
  agent_id?: string;
  chat_id?: string | null;
  is_playground?: boolean;
  actions?: AgentAction[] | null;
  [k: string]: unknown;
}

/** Resolve the agent's actions, preferring a caller-supplied list. */
async function resolveActions(
  metaData: MeetingToolMeta
): Promise<AgentAction[]> {
  if (metaData.agent_id) {
    return (await getAgentActions(metaData.agent_id)) ?? [];
  }
  return metaData.actions ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// get_hubspot_available_slots
// ─────────────────────────────────────────────────────────────────────────────

export const getHubspotAvailableSlotsDescription = {
  toolSpec: {
    name: 'get_hubspot_available_slots',
    description:
      'Fetch the bookable demo slots from the connected HubSpot meeting link. Returns the available ' +
      "days and times in the prospect's timezone.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description:
              "The prospect's timezone, e.g. 'America/New_York'. Times are returned in it.",
          },
          days_ahead: {
            type: 'number',
            description: 'How many days ahead to look. Defaults to 3.',
          },
        },
      },
    },
  },
} as const;

registerTool(
  getHubspotAvailableSlotsDescription.toolSpec.name,
  getHubspotAvailableSlotsDescription
);

/** Run `get_hubspot_available_slots`. Errors are returned in the payload, never thrown. */
export async function parseAndRunGetHubspotAvailableSlots(
  toolUseId: string,
  input: { timezone?: string; days_ahead?: number },
  metaData: MeetingToolMeta = {}
): Promise<BedrockMessage> {
  const timezone = input.timezone ?? 'America/New_York';
  const daysAhead = input.days_ahead ?? 3;
  const agentId = String(metaData.agent_id ?? '');
  const chatId = metaData.chat_id ?? null;

  const cfg = resolveHubspotConfig(await resolveActions(metaData));
  if (!cfg.refresh_token && !cfg.access_token) {
    return toolResult(toolUseId, {
      error: 'HubSpot v2 action not connected (no access token).',
    });
  }

  // A Test chat sees the TEST link's slots, so an E2E run never books the real rep's calendar.
  const recordType = chatId
    ? (await getMemory(chatId))?.record_type
    : undefined;
  const slug = resolveMeetingSlug(cfg, recordType);
  if (!slug) {
    return toolResult(toolUseId, {
      error: 'No meeting_slug configured on the HubSpot v2 action.',
    });
  }

  try {
    const slots = await getHubspotSlots(
      cfg,
      agentId,
      timezone,
      daysAhead,
      slug
    );
    return toolResult(toolUseId, slots as unknown as Record<string, unknown>);
  } catch (e) {
    console.error(`[HS] get_hubspot_available_slots failed: ${e}`);
    return toolResult(toolUseId, { error: String(e) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// schedule_hubspot_meeting
// ─────────────────────────────────────────────────────────────────────────────

export const scheduleHubspotMeetingDescription = {
  toolSpec: {
    name: 'schedule_hubspot_meeting',
    description:
      'Book the demo on the connected HubSpot meeting link. Call this FIRST, before sending any ' +
      'confirmation email — its success sets the meeting link the email must include. Uses the slot ' +
      'agreed on the call when one was resolved.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          start_time_ms: {
            type: 'number',
            description:
              'Slot start as epoch milliseconds. Ignored when a slot was already agreed on the call.',
          },
          duration_ms: {
            type: 'number',
            description: 'Meeting length in milliseconds.',
          },
          name: {
            type: 'string',
            description:
              "The attendee's full name. Falls back to the name on the chat.",
          },
          email: {
            type: 'string',
            description:
              "The attendee's email. Falls back to the address on the chat.",
          },
          timezone: {
            type: 'string',
            description: "The attendee's timezone.",
          },
        },
      },
    },
  },
} as const;

registerTool(
  scheduleHubspotMeetingDescription.toolSpec.name,
  scheduleHubspotMeetingDescription
);

export interface ScheduleMeetingInput {
  start_time_ms?: number;
  duration_ms?: number;
  name?: string;
  email?: string;
  timezone?: string;
}

/** Run `schedule_hubspot_meeting`. See the module note on slot precedence and the three side effects. */
export async function parseAndRunScheduleHubspotMeeting(
  toolUseId: string,
  input: ScheduleMeetingInput,
  metaData: MeetingToolMeta = {}
): Promise<BedrockMessage> {
  const agentId = String(metaData.agent_id ?? '');
  const chatId = metaData.chat_id ?? null;
  const isPlayground = !!metaData.is_playground;
  const timezone = input.timezone ?? 'America/New_York';
  const actions = await resolveActions(metaData);

  let startTimeMs = input.start_time_ms;
  let durationMs = input.duration_ms;
  let email = input.email ?? '';
  let name = (input.name ?? '').trim();

  const chatMem = chatId ? ((await getMemory(chatId)) ?? {}) : {};
  const agreed = (chatMem._agreed_slot ?? {}) as Record<string, unknown>;

  // The RESOLVED slot wins — see the module note. A model turning "Friday at 10:45" into an epoch is
  // exactly the kind of arithmetic it gets wrong, and a booking at the wrong time is worse than none.
  if (agreed.start_time_ms) {
    startTimeMs = Number(agreed.start_time_ms);
    durationMs = Number(agreed.duration_ms) || durationMs;
  }
  if (!email) email = String(chatMem.customer_email ?? '');
  if (!name) {
    name = [chatMem.first_name, chatMem.last_name]
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
      .join(' ');
  }

  const parts = name.split(' ');
  const firstName = parts[0] ?? '';
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';

  const cfg = resolveHubspotConfig(actions);
  if (!cfg.refresh_token && !cfg.access_token) {
    return toolResult(toolUseId, {
      success: false,
      message: 'HubSpot v2 action not connected.',
    });
  }

  const slug = resolveMeetingSlug(cfg, chatMem.record_type);
  if (!slug) {
    return toolResult(toolUseId, {
      success: false,
      message: 'No meeting_slug configured on the HubSpot v2 action.',
    });
  }

  let bookingInfo;
  try {
    bookingInfo = await bookHubspotMeeting(cfg, agentId, {
      startTimeMs: Number(startTimeMs),
      durationMs: Number(durationMs),
      firstName,
      lastName,
      email,
      timezone,
      slug,
    });
  } catch (e) {
    console.error(`[HS] booking failed chat=${chatId}: ${e}`);
    return toolResult(toolUseId, {
      success: false,
      message: `Booking failed: ${e}`,
    });
  }

  const payload = { ...bookingInfo } as Record<string, unknown>;

  if (bookingInfo.success) {
    // Capture the address they booked with, if the chat had none — the invite needs a recipient.
    if (chatId && email && !chatMem.customer_email) {
      try {
        await setMemory(chatId, { customer_email: email });
      } catch {
        // Best-effort.
      }
    }

    // The shared post-booking path: meeting memory, the link, the activity, Lead + Deal. No email.
    const meetingLink = await finalizeMeetingBooking(
      chatId,
      agentId,
      actions,
      bookingInfo,
      {
        startTimeMs: Number(startTimeMs),
        durationMs: Number(durationMs),
        slug,
        isPlayground,
      }
    );
    payload.meeting_link = meetingLink;

    // Deterministic, never left to the model — the source records it silently skipping them, which
    // produced booked demos with zero reminders.
    if (chatId) {
      try {
        const ids = await scheduleBookingReminders(chatId, agentId);
        payload.reminders_scheduled = ids.length;
      } catch (e) {
        console.warn(`[HS] reminder scheduling failed chat=${chatId}: ${e}`);
      }
    }

    // Clear the resolved slot, so a later turn cannot re-book the same time.
    if (chatId && agreed.start_time_ms) {
      try {
        await setMemory(chatId, { _agreed_slot: null });
      } catch {
        // Best-effort.
      }
    }
  }

  return toolResult(toolUseId, payload);
}
