/**
 * The `make_phone_call` tool — the outbound voice dial.
 *
 * ## Four gates, in a deliberate order, before anything is dialed
 *
 * Each one is cheaper or more terminal than the next, so a refused call does as little work as possible:
 *
 *  1. **Phone opt-out** — reads the trustworthy top-level keys. A DNC or opted-out contact is never
 *     dialed regardless of what the skill says. Terminal: `blocked`, no retry.
 *  2. **Business hours** — never dial outside the prospect's local window. DEFERS rather than dropping:
 *     it schedules a retry at the next business morning and surfaces the reason in both the task notes
 *     and the tool result, so the agent re-attempts in-hours instead of the model deciding to cold-call
 *     at 2am local.
 *  3. **The per-chat dial guard** — the structural stop for the repeat-dial storm. Refuses when a prior
 *     call is too recent or still awaiting review. Sits BEFORE scope-building so a blocked dial wastes
 *     no scope work.
 *  4. **The voice concurrency cap** — reserved atomically, and reserved LAST because it is the only gate
 *     that consumes a resource. At capacity it defers with a deterministic jitter.
 *
 * ## The bypasses are narrow and identical across gates
 *
 * A `Test` record and a human `@ai` override bypass the PACING gates — the dial guard and the concurrency
 * cap — so an E2E run fires back-to-back and an admin's explicit instruction is honoured. Test also
 * bypasses business hours. Neither ever bypasses the OPT-OUT gate: consent is not a pacing concern.
 *
 * `isHotProspect` deliberately bypasses **nothing**. An engaged prospect is called sooner by being
 * scheduled sooner, not by being allowed past a cap — the source records that the old count-then-write
 * cap let hot prospects through and two concurrent dials race past it.
 *
 * ## The slot is released when the dial does NOT become a live call
 *
 * A successful call keeps its slot until the completion webhook releases it (or the TTL sweep, if none
 * arrives). A FAILED dial releases immediately — otherwise a failure would hold capacity until the TTL.
 *
 * ## Deferred
 *
 * The Vapi provider path, the HubSpot availability injection, and `ensureMeetingHost` are not here; see
 * the notes at each call site. The `make_phone_call_from_number` variant and the S3 recording upload
 * land with the rest of the voice phase.
 */

import { DateTime } from 'luxon';

import { db } from '../firebase/db';
import {
  createTaskWithId,
  getMemory,
  savePendingCall,
  setMemory,
} from '../firebase/chat';
import { getAgent } from '../firebase/agent';
import {
  getPhoneNumber,
  getPhoneNumberByOverseeAgentId,
} from '../firebase/phoneNumbers';
import {
  businessHoursStartAfter,
  checkBusinessHours,
  resolveCustomerState,
} from '../services/businessHours';
import {
  buildOutboundCallScope,
  outboundCallContext,
} from '../services/callScope';
import {
  bumpFollowupCount,
  loadChatDoc,
  meetingHostFact,
  phoneOptedOut,
  pronouncePhoneNumber,
  recentDialBlocks,
  resolveOutboundName,
  saveOutboundCallIndex,
} from '../services/chat';
import {
  deletePendingOutboundOutreach,
  deletePendingTasksByType,
  nextBusinessHoursStart,
} from '../services/scheduling';
import { buildSkillsText } from '../services/skillsResolver';
import {
  releaseVoiceSlot,
  tryReserveVoiceSlot,
} from '../services/voiceConcurrency';
import { registerTool } from '../llm/toolRegistry';
import { envStr } from '../config';
import { ELEVENLABS_BASE_API } from '../services/elevenlabs';
import type { BedrockMessage, ChatMemory } from '../types';

/** Stages meaning the prospect has engaged. */
const HOT_STAGES: ReadonlySet<string> = new Set(['engaged', 'lead']);
const TRUTHY: ReadonlySet<string> = new Set(['y', 'yes', 'true', '1']);

/** How long after a dial the watchdog fires if no completion signal arrived. */
const CHECK_TASK_DELAY_MIN = 20;

export const makePhoneCallToolDescription = {
  toolSpec: {
    name: 'make_phone_call',
    description:
      'Place an outbound phone call to the prospect now. Provide the phone number in E.164 format. ' +
      'The call is placed by a voice agent; the transcript is reviewed automatically afterwards.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: "The prospect's phone number",
          },
        },
        required: ['phone_number'],
      },
    },
  },
} as const;

registerTool(
  makePhoneCallToolDescription.toolSpec.name,
  makePhoneCallToolDescription
);

/** Wrap a result payload in the tool-result envelope the turn loop expects. */
export function buildToolResult(
  toolUseId: string,
  result: Record<string, unknown>
): BedrockMessage {
  return {
    role: 'user',
    content: [{ toolResult: { toolUseId, content: [{ json: result }] } }],
  } as BedrockMessage;
}

/** Normalize to E.164, assuming US/Canada for a bare 10-digit number. */
export function toE164(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * A hot or reactive prospect: they have engaged, or explicitly asked for a callback.
 *
 * Reported for observability. It does NOT bypass any gate — see the module docstring.
 */
export function isHotProspect(
  stage: string | null | undefined,
  chatMemory: ChatMemory | null | undefined
): boolean {
  if (
    HOT_STAGES.has(
      String(stage ?? '')
        .trim()
        .toLowerCase()
    )
  )
    return true;
  return TRUTHY.has(
    String((chatMemory ?? {})._customer_wants_callback ?? '')
      .trim()
      .toLowerCase()
  );
}

/** An E2E test prospect. Bypasses the PACING guards, never the opt-out gate. */
export function isTestRecord(
  chatMemory: ChatMemory | null | undefined
): boolean {
  return (
    String((chatMemory ?? {}).record_type ?? '')
      .trim()
      .toLowerCase() === 'test'
  );
}

/**
 * The business-hours gate.
 *
 * Returns a deferred tool result to short-circuit the caller, or `null` to proceed.
 *
 * Fails OPEN on every error — `null`, so the call proceeds — mirroring the posture of the underlying
 * check and the opt-out gate: a guard fault must not silently drop outreach.
 */
export async function voiceBusinessHoursGate(
  toolUseId: string,
  phoneNumber: string,
  chatId: string | null | undefined,
  chatMemory: ChatMemory | null | undefined,
  agentId: string
): Promise<BedrockMessage | null> {
  let tzName: string | null;
  let nowLocal: Date | null;
  try {
    if (isTestRecord(chatMemory)) return null; // E2E bypass
    const blocked = checkBusinessHours(phoneNumber, chatMemory ?? {});
    tzName = blocked.timezone;
    nowLocal = blocked.localTime;
    if (tzName === null) return null; // inside hours on an allowed day
  } catch (e) {
    console.warn(
      `[MAKE_PHONE_CALL] business-hours gate skipped chat=${chatId}: ${e} — proceeding`
    );
    return null;
  }

  // Blocked — compute the next business morning and defer.
  let retryAt: Date;
  try {
    const state = resolveCustomerState(phoneNumber, chatMemory ?? {});
    const startToday = businessHoursStartAfter(0, tzName, state);
    retryAt =
      startToday > new Date()
        ? startToday
        : businessHoursStartAfter(1, tzName, state);
  } catch (e) {
    console.warn(
      `[MAKE_PHONE_CALL] next-business-morning calc failed chat=${chatId}: ${e}`
    );
    retryAt = new Date(Date.now() + 12 * 3_600_000);
  }

  const retryIso = retryAt.toISOString();
  let localStr = 'outside hours';
  try {
    if (nowLocal && tzName) {
      localStr = DateTime.fromJSDate(nowLocal, { zone: tzName }).toFormat(
        'ccc hh:mm a ZZZZ'
      );
    }
  } catch {
    localStr = 'outside hours';
  }

  if (chatId) {
    try {
      await deletePendingOutboundOutreach(chatId); // reschedule, do not stack
      await createTaskWithId(chatId, 'outbound_outreach', retryAt, {
        notes:
          `A voice call was deferred (outside_business_hours; prospect local time ` +
          `${localStr}); retry scheduled for ${retryIso}. Continue outreach per your outbound skill.`,
        agent_id: agentId,
        account_id: agentId,
        attendee_id: (chatMemory ?? {}).phone_number ?? phoneNumber,
        task_source: 'voice_defer_outside_business_hours',
      });
    } catch (e) {
      console.error(
        `[MAKE_PHONE_CALL] defer task creation failed chat=${chatId}: ${e}`
      );
    }
  }

  console.log(
    `[MAKE_PHONE_CALL] deferred (outside_business_hours) chat=${chatId} local=${localStr} retry_at=${retryIso}`
  );
  return buildToolResult(toolUseId, {
    status: 'deferred',
    reason: 'outside_business_hours',
    retry_at: retryIso,
    message:
      `Call NOT placed — it is outside the prospect's local business hours ` +
      `(prospect local time ${localStr}). A retry is scheduled for ${retryIso}. Do not ` +
      `attempt to call again now; continue outreach per your outbound skill.`,
  });
}

/**
 * Place the call with the voice provider. Returns the conversation id, or `null`.
 *
 * The context is wrapped in an explicit SCOPE envelope, and the wrapper matters: it tells the agent that
 * this block is what it must do while the rest of its prompt is background it MAY read. Without the
 * framing the agent treats scope facts as one more prompt section.
 *
 * The per-call overrides (`first_message`, `tts.voice_id`) only take effect because the agent has
 * allow-listed them — that is what the webhook-attach step enables. Unlisted overrides are silently
 * ignored by the provider.
 */
export async function initiateElevenlabsCall(opts: {
  agentId: string;
  phoneNumberId: string | null | undefined;
  customerNumber: string;
  context?: string;
  dynamicVariables?: Record<string, string>;
  firstMessage?: string | null;
  chatId?: string | null;
  voiceId?: string | null;
}): Promise<string | null> {
  const {
    agentId,
    phoneNumberId,
    customerNumber,
    context,
    dynamicVariables,
    firstMessage,
    chatId,
    voiceId,
  } = opts;

  // The simulation bridge short-circuit. When the chat is in playground mode and a bridge is
  // configured, the provider is never called: the bridge runs a synthetic conversation and POSTs the
  // real post-call webhook shape back, so EVERY downstream path runs identically to a live call. That
  // fidelity is the point — a simulated call exercises the review, the booking, and the cadence.
  try {
    const bridgeUrl = envStr('SIM_VOICE_BRIDGE_URL');
    let isPlayground = false;
    if (bridgeUrl && chatId) {
      const snap = await db.collection('chats').doc(chatId).get();
      if (snap.exists) isPlayground = Boolean((snap.data() ?? {}).playground);
    }
    if (bridgeUrl && isPlayground) {
      const conversationId = `sim-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      // Synchronous by necessity: no background work survives a serverless request return, so the
      // bridge runs the whole conversation inline and needs a generous timeout.
      const resp = await fetch(bridgeUrl.replace(/\/+$/, '') + '/start/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          voice_agent_id: agentId,
          phone_number_id: phoneNumberId,
          customer_number: customerNumber,
          dynamic_variables: dynamicVariables ?? {},
          first_message: firstMessage,
          chat_id: chatId,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) {
        console.warn(
          `[SIM_VOICE_BRIDGE] bridge returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`
        );
        return null;
      }
      console.log(
        `[SIM_VOICE_BRIDGE] redirected outbound call to bridge: ${conversationId}`
      );
      return conversationId;
    }
  } catch (e) {
    console.warn(
      `[SIM_VOICE_BRIDGE] redirect failed, falling back to the real provider: ${e}`
    );
  }

  const apiKey = envStr('ELEVENLABS_API_KEY');
  const payload: Record<string, unknown> = {
    agent_id: agentId,
    agent_phone_number_id: phoneNumberId,
    to_number: customerNumber,
  };

  const vars: Record<string, string> = {};
  if (context) {
    vars.local_scope =
      `\n                IMPORTANT: SCOPE OF THIS CALL\n\n` +
      `                ${context}\n\n` +
      `                Above is what you need to do. You may read other sections below since they might help you achieve the scope above.\n\n` +
      `                END OF SCOPE\n                `;
  }
  for (const [name, value] of Object.entries(dynamicVariables ?? {})) {
    if (name !== 'local_scope') vars[name] = value; // never override the scope
  }

  const configOverride: Record<string, Record<string, string>> = {};
  if (firstMessage) {
    configOverride.agent = { first_message: firstMessage };
  }
  if (voiceId) {
    configOverride.tts = { voice_id: voiceId };
  }

  if (Object.keys(vars).length || Object.keys(configOverride).length) {
    const clientData: Record<string, unknown> = {};
    if (Object.keys(vars).length) clientData.dynamic_variables = vars;
    if (Object.keys(configOverride).length) {
      clientData.conversation_config_override = configOverride;
    }
    payload.conversation_initiation_client_data = clientData;
  }

  try {
    console.log(`Initiating outbound call to ${customerNumber}`);
    const resp = await fetch(
      `${ELEVENLABS_BASE_API}/v1/convai/twilio/outbound-call`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!resp.ok) {
      console.error(
        `Outbound call failed: ${resp.status} - ${(await resp.text()).slice(0, 300)}`
      );
      return null;
    }
    const info = (await resp.json()) as Record<string, unknown>;
    const conversationId = info.conversation_id as string | undefined;
    if (info.success && conversationId) {
      console.log(
        `Outbound call initiated: conversation_id=${conversationId}, callSid=${String(info.callSid ?? '')}`
      );
      return conversationId;
    }
    console.error(
      `Outbound call failed: success=${String(info.success)}, message=${String(info.message ?? '')}`
    );
    return null;
  } catch (e) {
    console.error(`Error initiating outbound call: ${e}`);
    return null;
  }
}

export interface MakeCallInput {
  phone_number?: string;
}

export interface MakeCallMeta {
  agent_id?: string;
  chat_owner_agent_id?: string;
  chat_id?: string | null;
  userId?: string;
  admin_override?: boolean;
  [k: string]: unknown;
}

/** Run the `make_phone_call` tool. */
export async function parseAndRunMakePhoneCall(
  toolUseId: string,
  input: MakeCallInput,
  metaData: MakeCallMeta = {}
): Promise<BedrockMessage> {
  const phoneNumber = toE164(input.phone_number);
  const chatOwnerAgentId = metaData.chat_owner_agent_id ?? metaData.agent_id;
  const toolAgentId = chatOwnerAgentId ?? metaData.agent_id ?? '';
  let toolUserId = String(
    metaData.userId ??
      (phoneNumber.startsWith('+') ? phoneNumber.slice(1) : phoneNumber)
  ).trim();
  if (toolUserId.startsWith('+')) toolUserId = toolUserId.slice(1);

  const result: Record<string, unknown> = { status: 'failed' };

  if (!phoneNumber) {
    result.message = 'Phone number is required';
    console.error('Phone number is required');
    return buildToolResult(toolUseId, result);
  }

  const agentId = metaData.agent_id;
  if (!agentId) {
    result.message = 'Agent ID not found in meta_data';
    return buildToolResult(toolUseId, result);
  }

  const chatId = metaData.chat_id ?? null;

  const agentData = await getAgent(agentId);
  if (!agentData) {
    result.message = `Agent ${agentId} not found`;
    return buildToolResult(toolUseId, result);
  }

  // Voice routing: an agent may delegate the call to a dedicated voice agent, and an oversee agent
  // inherits that delegation from its parent. The call_id is always saved against the INITIATING agent,
  // so the review resolves back to the right chat regardless of who placed it.
  let routedAgentId = agentData.make_phone_call_tool_agent_id as
    | string
    | undefined;
  if (!routedAgentId && agentData.oversee_agent === true) {
    const parentId = String(agentData.parent_agent ?? '');
    if (parentId) {
      const parentData = await getAgent(parentId);
      if (parentData?.make_phone_call_tool_agent_id) {
        routedAgentId = parentData.make_phone_call_tool_agent_id as string;
        console.log(
          `[MAKE_PHONE_CALL][ROUTING] Inherited make_phone_call_tool_agent_id from parent ${parentId}`
        );
      }
    }
  }

  let voiceAssistantId: string | undefined;
  let voicePhoneNumberId: string | undefined;
  let voiceProvider: string;
  let dynamicVariablesConfig: Record<string, unknown>;
  let phoneDoc: Record<string, unknown> | null = null;

  if (routedAgentId) {
    const routed = await getAgent(routedAgentId);
    if (!routed) {
      result.message = `Voice agent ${routedAgentId} not found`;
      return buildToolResult(toolUseId, result);
    }
    voiceAssistantId = routed.voice_agent_assistant_id as string | undefined;
    voicePhoneNumberId = (
      (routed.voice_settings ?? {}) as Record<string, unknown>
    ).phoneNumberId as string | undefined;
    voiceProvider = String(routed.voice_ai_provider ?? 'vapi').toLowerCase();
    dynamicVariablesConfig = (routed.dynamic_variables ?? {}) as Record<
      string,
      unknown
    >;

    // An oversee agent calls from its OWN number, not the delegated agent's, so the prospect sees a
    // consistent caller id across channels.
    if (agentData.oversee_agent === true) {
      phoneDoc = await getPhoneNumberByOverseeAgentId(agentId);
      if (phoneDoc) {
        if (phoneDoc.status !== 'active') {
          result.message =
            'Phone number is deactivated for voice calls. Cannot make outbound calls.';
          return buildToolResult(toolUseId, result);
        }
        voicePhoneNumberId = phoneDoc.phone_number_id as string | undefined;
      } else {
        console.warn(
          `[MAKE_PHONE_CALL][ROUTING] No phone number for oversee_agent ${agentId}, using the routed agent's`
        );
      }
    }
  } else {
    voiceAssistantId = agentData.voice_agent_assistant_id as string | undefined;
    voicePhoneNumberId = (
      (agentData.voice_settings ?? {}) as Record<string, unknown>
    ).phoneNumberId as string | undefined;
    voiceProvider = String(agentData.voice_ai_provider ?? 'vapi').toLowerCase();
    dynamicVariablesConfig = (agentData.dynamic_variables ?? {}) as Record<
      string,
      unknown
    >;
  }

  if (!voiceAssistantId) {
    result.message = 'Voice agent assistant ID not configured for this agent';
    return buildToolResult(toolUseId, result);
  }

  let chatMemory: ChatMemory = {};
  if (chatId) {
    try {
      chatMemory = (await getMemory(chatId)) ?? {};
    } catch (e) {
      console.error(`Error fetching chat memory: ${e}`);
    }
  }

  // GATE 1 — phone opt-out. Terminal, and never bypassed: consent is not a pacing concern.
  if (chatId) {
    try {
      if (phoneOptedOut(await loadChatDoc(chatId))) {
        console.log(
          `[MAKE_PHONE_CALL] phone opted out for chat=${chatId} — refusing to place call.`
        );
        return buildToolResult(toolUseId, {
          status: 'blocked',
          message:
            'Phone is opted out (DNC) for this contact — no call placed. Use email if it ' +
            'is reachable, otherwise stop outreach.',
        });
      }
    } catch (e) {
      console.warn(
        `[MAKE_PHONE_CALL] phone opt-out gate skipped chat=${chatId}: ${e}`
      );
    }
  }

  // GATE 2 — business hours.
  const bhDeferred = await voiceBusinessHoursGate(
    toolUseId,
    phoneNumber,
    chatId,
    chatMemory,
    agentId
  );
  if (bhDeferred !== null) return bhDeferred;

  // GATE 3 — the per-chat dial guard. Before scope-building, so a refusal wastes no work.
  const bypassPacing =
    isTestRecord(chatMemory) || Boolean(metaData.admin_override);
  if (chatId && !bypassPacing) {
    try {
      const { blocked, reason } = recentDialBlocks(chatMemory);
      if (blocked) {
        console.log(
          `[MAKE_PHONE_CALL] per-chat dial guard: ${reason} — no call placed for chat=${chatId}.`
        );
        return buildToolResult(toolUseId, {
          status: 'skipped',
          message:
            `No call placed — ${reason}. A prior call to this contact is too recent or still ` +
            `awaiting review; do not re-dial now. It will be handled after the review.`,
        });
      }
    } catch (e) {
      console.warn(`[MAKE_PHONE_CALL] dial guard skipped chat=${chatId}: ${e}`);
    }
  }

  // Dynamic variables. Config values are placeholders only — every real value comes from chat memory,
  // and a missing one becomes the literal "Not Available" so the prompt renders rather than breaking.
  const dynamicVariables: Record<string, string> = {};
  if (Object.keys(dynamicVariablesConfig).length && chatId) {
    for (const varName of Object.keys(dynamicVariablesConfig)) {
      const v = chatMemory[varName];
      dynamicVariables[varName] =
        v !== null && v !== undefined ? String(v) : 'Not Available';
    }
  }

  // These three are NOT memory-driven, and are injected only when the agent's config declares them.
  if ('sales_agent_name' in dynamicVariablesConfig) {
    dynamicVariables.sales_agent_name = await resolveOutboundName(
      chatMemory,
      agentData
    );
  }

  if ('callback_number' in dynamicVariablesConfig) {
    // `phoneDoc` is only resolved on the routed/oversee branch; on the direct path resolve the FROM
    // number from the id we are calling with, so the agent can always say a real number.
    let callbackNumber = (phoneDoc?.phone_number as string | undefined) ?? null;
    if (!callbackNumber && voicePhoneNumberId) {
      try {
        const pd = await getPhoneNumber(voicePhoneNumberId);
        if (pd?.phone_number) callbackNumber = String(pd.phone_number);
      } catch (e) {
        console.warn(
          `[MAKE_PHONE_CALL] callback_number resolve from phone_number_id failed: ${e}`
        );
      }
    }
    callbackNumber = callbackNumber || 'this number';
    dynamicVariables.callback_number = callbackNumber;
    dynamicVariables.callback_number_pronounced =
      pronouncePhoneNumber(callbackNumber);
  }

  // Spoken in the opener, so "Not Available" would read badly out loud.
  if ('first_name' in dynamicVariablesConfig) {
    const fn = (dynamicVariables.first_name ?? '').trim();
    if (!fn || fn === 'Not Available') dynamicVariables.first_name = 'there';
  }

  // Outbound memory stores the prospect's company under `company`, so map it across.
  if ('dealer_name' in dynamicVariablesConfig) {
    dynamicVariables.dealer_name =
      String(chatMemory.dealer_name ?? chatMemory.company ?? '').trim() ||
      'your dealership';
  }

  // Canonical routing identifiers, always present so a webhook tool cannot split the chat.
  dynamicVariables.tool_agent_id = String(toolAgentId);
  dynamicVariables.tool_user_id = String(toolUserId);

  // The call scope. A booked demo makes this a REMINDER call rather than a booking call, which changes
  // both the scope and whether availability is offered at all.
  const booked =
    Boolean(chatMemory.meeting_booked) ||
    String(chatMemory.current_stage ?? chatMemory.stage ?? '')
      .trim()
      .toLowerCase() === 'lead';

  // ONE history scan feeds both the scope and the discrete variables the prompt branches on.
  const ctx = await outboundCallContext(chatMemory, chatId, booked);
  let instructions = await buildOutboundCallScope(
    chatMemory,
    chatId,
    booked,
    ctx
  );
  dynamicVariables.call_type = ctx.call_type;
  dynamicVariables.prospect_stage = ctx.stage;

  // The meeting host, so the agent can name who the prospect will meet if asked mid-call. The resolver
  // that populates it arrives with the HubSpot phase; until then this uses whatever is already cached.
  try {
    const host = chatMemory.meeting_host;
    const hostFact = meetingHostFact(host as string | undefined);
    if (hostFact) {
      instructions = instructions ? `${instructions}\n\n${hostFact}` : hostFact;
      dynamicVariables.meeting_host = String(host);
    }
  } catch (e) {
    console.warn(
      `[MAKE_PHONE_CALL] meeting-host inject skipped for ${chatId}: ${e}`
    );
  }

  // Voice skills — e.g. gatekeeper navigation — delivered as their own variable, parallel to the scope.
  // TEXT skills never reach voice: they drive the text brain only.
  try {
    const voiceSkills = await buildSkillsText(
      chatId ?? '',
      chatOwnerAgentId ?? agentId,
      null,
      null,
      true
    );
    if (voiceSkills) dynamicVariables.skills = voiceSkills;
  } catch (e) {
    console.warn(
      `[MAKE_PHONE_CALL] voice skills inject skipped for ${chatId}: ${e}`
    );
  }

  // The pre-computed summary, appended AFTER the scope so it cannot overwrite it. Computed once at
  // review time precisely so no model call is needed here.
  const summary = String(chatMemory._conversation_summary ?? '');
  if (summary) {
    const block = `CONVERSATION SUMMARY:\n${summary}`;
    instructions = instructions ? `${instructions}\n\n${block}` : block;
  }

  // The availability block belongs here — the agent cannot fetch slots mid-call — but it needs the CRM
  // scheduling layer, which arrives with the HubSpot phase. A REMINDER call would skip it anyway: an
  // already-booked call must never offer new times.

  // GATE 4 — the voice concurrency cap. Reserved LAST, because it is the only gate that consumes a
  // resource. No hot-prospect bypass: the cap is absolute.
  let slotReserved = false;
  if (chatId && !bypassPacing) {
    try {
      slotReserved = await tryReserveVoiceSlot(chatId);
    } catch (e) {
      console.warn(
        `[MAKE_PHONE_CALL] voice slot reserve errored chat=${chatId}: ${e} — deferring`
      );
      slotReserved = false;
    }
    if (!slotReserved) {
      const tz = chatMemory.timezone;
      const digits = phoneNumber.replace(/\D/g, '');
      // A deterministic jitter, so N deferred chats do not all retry at the same instant.
      const jitter =
        2 + (digits.length >= 2 ? Number(digits.slice(-2)) % 6 : 0);
      const executeAt = new Date(
        (await nextBusinessHoursStart(tz, null, chatId)).getTime() +
          jitter * 60_000
      );
      try {
        await deletePendingOutboundOutreach(chatId);
      } catch (e) {
        console.warn(
          `[MAKE_PHONE_CALL] cap-defer outreach purge skipped chat=${chatId}: ${e}`
        );
      }
      await createTaskWithId(chatId, 'outbound_outreach', executeAt, {
        notes:
          'A call attempt was deferred because outbound VOICE-call capacity was reached. ' +
          'Continue outreach per your outbound skill (place the call, or use another channel).',
        agent_id: chatOwnerAgentId ?? agentId,
        account_id: chatOwnerAgentId ?? agentId,
        attendee_id: chatMemory.phone_number,
        timezone: tz,
        task_source: 'voice_concurrency_defer',
      });
      console.log(
        `[MAKE_PHONE_CALL] voice concurrency cap reached — deferred call for chat=${chatId} to ${executeAt.toISOString()}`
      );
      return buildToolResult(toolUseId, {
        status: 'deferred',
        message: `Outbound voice-call capacity reached; a retry was scheduled for ${executeAt.toISOString()}.`,
      });
    }
  }

  // Dial.
  try {
    if (voiceProvider === 'elevenlabs') {
      const conversationId = await initiateElevenlabsCall({
        agentId: voiceAssistantId,
        phoneNumberId: voicePhoneNumberId,
        customerNumber: phoneNumber,
        context: instructions,
        dynamicVariables,
        chatId,
      });
      if (conversationId) {
        result.status = 'in_progress';
        result.call_id = conversationId;
        result.phone_number = phoneNumber;
        result.message = 'Call initiated successfully.';
        // The durable index and the pending-call record both exist so the post-call webhook can resolve
        // this chat regardless of which number was dialed.
        if (chatId) {
          await saveOutboundCallIndex(
            conversationId,
            chatId,
            chatOwnerAgentId ?? agentId
          );
          await savePendingCall(
            conversationId,
            chatId,
            chatOwnerAgentId ?? agentId,
            toolUseId,
            phoneNumber,
            ctx.stage
          );
        }
      } else {
        result.status = 'failed';
        result.message = 'Call could not be initiated by the voice provider.';
      }
    } else {
      // The Vapi path is not ported. Reported as a visible failure rather than silently doing nothing,
      // so a Vapi-configured agent produces a diagnosable result instead of an unexplained no-op.
      result.status = 'failed';
      result.message =
        `Voice provider '${voiceProvider}' is not available in this deployment ` +
        `(only the ElevenLabs path is implemented). Configure the agent's voice_ai_provider ` +
        `as 'elevenlabs', or use another channel.`;
      console.error(
        `[MAKE_PHONE_CALL] unsupported voice_ai_provider='${voiceProvider}' for agent=${agentId}`
      );
    }
  } catch (e) {
    result.message = `Error making phone call: ${e}`;
    console.error(`Error in make_phone_call: ${e}`);
  }

  // Release the slot when the dial did NOT become a live call — otherwise a failure holds capacity
  // until the TTL sweep. A live call keeps its slot until the completion webhook.
  if (slotReserved && chatId && result.status !== 'in_progress') {
    try {
      await releaseVoiceSlot(chatId);
    } catch (e) {
      console.warn(
        `[MAKE_PHONE_CALL] voice slot release-on-failure skipped chat=${chatId}: ${e}`
      );
    }
  }

  if (result.status === 'in_progress' && chatId) {
    // The follow-up counter. `_last_outbound_call_at` is stamped on EVERY placed call, because it is
    // what powers the dial guard; `_first_outbound_call_at` stays the first-touch anchor.
    try {
      const nowIso = new Date().toISOString();
      if (!chatMemory._first_outbound_call_at) {
        await setMemory(chatId, {
          _first_outbound_call_at: nowIso,
          _last_outbound_call_at: nowIso,
        });
      } else {
        await setMemory(chatId, { _last_outbound_call_at: nowIso });
        await bumpFollowupCount(chatId, 'call');
      }
    } catch (e) {
      console.warn(
        `[MAKE_PHONE_CALL] call follow-up count update failed chat=${chatId}: ${e}`
      );
    }

    // The watchdog, in case no completion signal ever arrives. Single-pending: a prior unresolved
    // watchdog is purged first, or repeated dials would stack several and each would fire its own
    // review turn.
    try {
      const executeAt = new Date(Date.now() + CHECK_TASK_DELAY_MIN * 60_000);
      try {
        await deletePendingTasksByType(chatId, 'check_if_call_succeeded');
      } catch (e) {
        console.warn(
          `[MAKE_PHONE_CALL] check-task single-pending purge skipped chat=${chatId}: ${e}`
        );
      }
      const checkTaskId = await createTaskWithId(
        chatId,
        'check_if_call_succeeded',
        executeAt,
        {
          notes:
            'Phone call was initiated but no completion or failure webhook was received. ' +
            'Please call review_call_transcript to check if call was successful',
          call_id: result.call_id,
          phone_number: result.phone_number,
          agent_id: chatOwnerAgentId ?? agentId,
          account_id: chatOwnerAgentId ?? agentId,
          attendee_id: toolUserId,
          task_source: 'make_phone_call_check',
        }
      );
      if (checkTaskId) {
        result.check_task_id = checkTaskId;
        result.message =
          'Call initiated successfully. A check task has been automatically created. ' +
          'The system will notify you when the call completes.';
      }
    } catch (e) {
      console.error(
        `[MAKE_PHONE_CALL] Error creating check_if_call_succeeded task: ${e}`
      );
    }
  }

  return buildToolResult(toolUseId, result);
}
