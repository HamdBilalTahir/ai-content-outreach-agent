/**
 * The three lifecycle tools: `mark_prospect_lost`, `mark_cadence_complete`, `clear_not_interested`.
 *
 * ## Three outcomes that look similar and are NOT interchangeable
 *
 * Getting these confused is how a workable lead gets closed, so each one is scoped narrowly:
 *
 *  - **Lost** is a terminal STAGE. The prospect cannot be reactivated and pending nudges are cancelled.
 *  - **not_interested** is a LABEL. It stops proactive outreach on both channels but changes no stage
 *    and sets no opt-out — the prospect declined the offer, not the channel.
 *  - **cadence_complete** is a MARKER meaning "we finished our planned touches and got no response".
 *    Not a stage change, not an opt-out, and an inbound reply reopens it.
 *
 * ## `mark_prospect_lost` REFUSES to close a prospect two ways, and both are load-bearing
 *
 *  1. **`customer_not_interested` is routed to the label, never the stage.** The outcome is then
 *     identical whether the review auto-detected the decline or the agent called this tool.
 *  2. **A call-channel dead end is not a terminal Lost while EMAIL is still reachable.** `wrong_contact`,
 *     `unable_to_reach`, and `no_response` all mean the PHONE did not get us to the person — that is not
 *     grounds for closing a prospect we can still email. Those stand down the call channel and keep the
 *     prospect active. Only an explicit all-channel opt-out or a stated decline is a true Lost, which is
 *     precisely why `customer_opted_out` and `customer_not_interested` are absent from that set.
 *
 * ## `mark_cadence_complete` can decline to complete, and that is the point
 *
 * If the PHONE cadence is spent with no engagement but an email fallback is still available, it flips the
 * lane to email and schedules the first email INSTEAD of closing the cadence. This deliberately routes
 * the skill's completion through the same decision the deterministic safety net uses, so the fallback
 * fires whether completion is skill-driven or sweep-driven. Fails OPEN: a read fault falls straight
 * through to normal completion.
 *
 * ## `clear_not_interested` reverses ONLY the label
 *
 * It does not touch `phone_opt_out`, `block_phone`, or `email_opt_out`, because the label never set them
 * — those come from a genuine customer opt-out. Clearing consent the label never took would override a
 * real "stop calling". The stage is untouched too. Admin-invoked only.
 */

import { db } from '../firebase/db';
import { getMemory, removeLabelFromChat } from '../firebase/chat';
import { setProspectStage } from '../firebase/prospect';
import {
  emailOptedOut,
  loadChatDoc,
  setCadenceComplete,
  shouldFallbackToEmail,
} from '../services/chat';
import { enforceSingleProactiveTask } from '../services/scheduling';
import { handleNotInterested } from '../services/notInterested';
import { fallbackToEmailLane } from '../services/stalledRecovery';
import { syncHubspotStage } from '../services/hubspotDeals';
import { registerTool } from '../llm/toolRegistry';
import type { BedrockMessage, ChatDoc } from '../types';

export const VALID_LOST_REASONS = [
  'customer_opted_out',
  'customer_not_interested',
  'unable_to_reach',
  'wrong_contact',
  'no_response',
] as const;

/**
 * Reasons meaning the PHONE failed to reach the person — a wrong number, no pickup, a gatekeeper or
 * IVR, nobody by that name.
 *
 * Deliberately EXCLUDES `customer_opted_out` and `customer_not_interested`: those are statements from
 * the person, not failures of the channel, and they ARE grounds for a terminal close.
 */
const CALL_CHANNEL_REASONS: ReadonlySet<string> = new Set([
  'wrong_contact',
  'unable_to_reach',
  'no_response',
]);

/** Nudge types that must never fire after a chat is closed. */
const PENDING_FOLLOWUP_TYPES = ['followup_if_no_reply', 'call_followup'];

const NOT_INTERESTED_LABEL = 'not_interested';

function response(
  toolUseId: string,
  status: string,
  message: string
): BedrockMessage {
  return {
    role: 'user',
    content: [
      { toolResult: { toolUseId, content: [{ json: { status, message } }] } },
    ],
  } as unknown as BedrockMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// mark_prospect_lost
// ─────────────────────────────────────────────────────────────────────────────

export const markProspectLostToolDescription = {
  toolSpec: {
    name: 'mark_prospect_lost',
    description:
      'Mark a prospect as Lost when the customer has opted out, is not interested, is the wrong ' +
      'contact, or cannot be reached after the outreach cadence is exhausted. This is a terminal ' +
      'action — once marked Lost, the prospect cannot be reactivated, and all pending follow-up ' +
      'tasks are cancelled.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why the prospect is being marked as lost',
            enum: VALID_LOST_REASONS,
          },
        },
        required: ['reason'],
      },
    },
  },
} as const;

registerTool(
  markProspectLostToolDescription.toolSpec.name,
  markProspectLostToolDescription
);

/**
 * Delete unexecuted nudge tasks for a closed chat, so none fire post-close.
 *
 * Best-effort and never throws: the Lost transition has already succeeded by the time this runs, and
 * failing here must not report the close as failed.
 */
async function cancelPendingFollowups(chatId: string): Promise<number> {
  if (!chatId) return 0;
  let deleted = 0;
  try {
    const tasksRef = db.collection('chats').doc(chatId).collection('tasks');
    for (const taskType of PENDING_FOLLOWUP_TYPES) {
      const snap = await tasksRef
        .where('type', '==', taskType)
        .where('executed', '==', false)
        .get();
      for (const task of snap.docs) {
        try {
          await task.ref.delete();
          deleted += 1;
        } catch (e) {
          console.warn(
            `[OB mark_prospect_lost] failed to delete ${taskType} task ${task.id}: ${e}`
          );
        }
      }
    }
  } catch (e) {
    console.warn(
      `[OB mark_prospect_lost] cancel pending follow-ups failed for ${chatId}: ${e}`
    );
  }
  return deleted;
}

export interface StageToolMeta {
  agent_id?: string;
  // Widened to match the turn's meta shape: the source reads this loosely and stringifies it, so a
  // numeric company id from an older record must not be a type error at the call site.
  company_id?: string | number;
  [k: string]: unknown;
}

/** Run the `mark_prospect_lost` tool. See the module note for the two refusals. */
export async function parseAndRunMarkProspectLost(
  toolUseId: string,
  input: { reason?: string },
  chatId: string,
  metaData: StageToolMeta = {}
): Promise<BedrockMessage> {
  const reason = input?.reason ?? '';

  if (!(VALID_LOST_REASONS as readonly string[]).includes(reason)) {
    console.warn(`[OB mark_prospect_lost] Invalid reason: ${reason}`);
    return response(
      toolUseId,
      'error',
      `Invalid reason. Must be one of: ${VALID_LOST_REASONS.join(', ')}`
    );
  }

  let chatData: ChatDoc;
  let dealersId: string;
  let companyId: string;
  try {
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) {
      return response(toolUseId, 'error', `Chat ${chatId} not found`);
    }
    chatData = (chatDoc.data() ?? {}) as ChatDoc;
    dealersId = String(chatData.dealers_id ?? chatData.dealer_id ?? '');
    companyId = String(chatData.company_id ?? metaData.company_id ?? '');
  } catch (e) {
    console.error(`[OB mark_prospect_lost] Error reading chat: ${e}`);
    return response(toolUseId, 'error', `Error reading chat: ${e}`);
  }

  // REFUSAL 1 — a decline is a label, not the Lost stage. Routed so the outcome is identical whether
  // the review auto-detected it or the agent called this tool.
  if (reason === 'customer_not_interested') {
    try {
      await handleNotInterested(
        chatId,
        'customer_said_not_interested',
        'mark_prospect_lost'
      );
    } catch (e) {
      console.error(
        `[OB mark_prospect_lost] not_interested routing failed for ${chatId}: ${e}`
      );
    }
    return response(
      toolUseId,
      'skipped',
      "Not marked Lost — 'customer_not_interested' is a label, not the Lost stage. Applied the " +
        'not_interested label and stopped proactive outreach (stage unchanged).'
    );
  }

  // REFUSAL 2 — the phone failing is not grounds to close a prospect we can still email.
  if (CALL_CHANNEL_REASONS.has(reason)) {
    let emailOpen = false;
    try {
      const mem = (chatData.memory ?? {}) as Record<string, unknown>;
      emailOpen =
        String(mem.customer_email ?? '').trim().length > 0 &&
        !emailOptedOut(chatData);
    } catch {
      emailOpen = false;
    }
    if (emailOpen) {
      try {
        // Close the CALL channel on the trustworthy top-level keys; email stays open.
        await db
          .collection('chats')
          .doc(chatId)
          .update({ phone_opt_out: true, block_phone: true });
      } catch (e) {
        console.warn(
          `[OB mark_prospect_lost] call-channel stand-down write failed for ${chatId}: ${e}`
        );
      }
      console.log(
        `[OB mark_prospect_lost] ${chatId}: reason '${reason}' + email reachable — NOT Lost; ` +
          'closed call channel, continuing on email.'
      );
      return response(
        toolUseId,
        'skipped',
        `Not marked Lost — '${reason}' is a call-channel dead end but email is still reachable. ` +
          'Closed the call channel (no more calls to this number); continue outreach by email.'
      );
    }
  }

  const success = await setProspectStage(
    chatId,
    'Lost',
    'mark_prospect_lost',
    dealersId,
    companyId,
    reason
  );

  if (!success) {
    return response(
      toolUseId,
      'error',
      'Failed to mark prospect as Lost (may already be Lost)'
    );
  }

  // Lost is terminal → no leftover nudge may fire against a closed prospect.
  const cancelled = await cancelPendingFollowups(chatId);
  // Deterministic CRM mirror: Lost → Closed Lost. Best-effort — the transition already succeeded.
  try {
    const agentId = String(metaData.agent_id ?? chatData.agentId ?? '');
    if (agentId) await syncHubspotStage(chatId, agentId);
  } catch (e) {
    console.warn(
      `[OB mark_prospect_lost] HubSpot sync failed for ${chatId} (non-blocking): ${e}`
    );
  }
  console.log(
    `[OB mark_prospect_lost] Chat ${chatId} marked Lost: ${reason} ` +
      `(${cancelled} pending follow-up task(s) cancelled)`
  );
  return response(
    toolUseId,
    'success',
    `Prospect marked as Lost. Reason: ${reason}.` +
      (cancelled ? ` Cancelled ${cancelled} pending follow-up task(s).` : '')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// mark_cadence_complete
// ─────────────────────────────────────────────────────────────────────────────

export const markCadenceCompleteToolDescription = {
  toolSpec: {
    name: 'mark_cadence_complete',
    description:
      'Call this ONLY when the outbound cadence for this prospect is fully exhausted — every planned ' +
      'touch has been sent (all email follow-ups and/or all call attempts per your outbound skill) and ' +
      'the prospect has NOT replied — so there is nothing left to schedule. It marks the chat ' +
      "cadence-complete so the system stops proactively re-touching it. It is NOT 'Lost' and NOT an " +
      'opt-out: if the prospect later replies, the conversation automatically reopens. Do NOT call this ' +
      'if you still have a next touch to schedule (schedule it instead).',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              "Brief reason, e.g. 'email cadence exhausted, no reply' or 'all call attempts made, no answer'.",
          },
        },
        required: ['reason'],
      },
    },
  },
} as const;

registerTool(
  markCadenceCompleteToolDescription.toolSpec.name,
  markCadenceCompleteToolDescription
);

/** Run the `mark_cadence_complete` tool. May flip to the email lane instead of completing. */
export async function parseAndRunMarkCadenceComplete(
  toolUseId: string,
  input: { reason?: string },
  chatId: string,
  metaData: StageToolMeta = {}
): Promise<BedrockMessage> {
  const reason = input?.reason || 'cadence_exhausted';
  if (!chatId) {
    return response(toolUseId, 'error', 'chat_id is required');
  }
  try {
    // The phone→email fallback pre-check. Fails OPEN: a read fault falls through to completion below,
    // because failing to complete a genuinely-spent cadence just leaves the sweep to handle it.
    let fallback = false;
    let doc: ChatDoc = {} as ChatDoc;
    let mem: Record<string, unknown> = {};
    try {
      doc = (await loadChatDoc(chatId)) ?? ({} as ChatDoc);
      mem = ((await getMemory(chatId)) ?? doc.memory ?? {}) as Record<
        string,
        unknown
      >;
      fallback = shouldFallbackToEmail(mem, doc);
    } catch (e) {
      console.warn(
        `[OB CADENCE] fallback pre-check skipped chat=${chatId}: ${e}`
      );
    }

    if (fallback) {
      const agentId = String(
        metaData.agent_id ?? doc.agentId ?? mem.agent_id ?? ''
      );
      const tid = await fallbackToEmailLane(
        chatId,
        mem,
        agentId,
        doc.campaign_id as string | null | undefined
      );
      console.log(
        `[OB CADENCE] chat=${chatId}: phone cadence spent, no engagement — switched to EMAIL ` +
          `fallback lane (scheduled ${tid}) instead of marking complete (reason='${reason}').`
      );
      return response(
        toolUseId,
        'success',
        'Phone cadence is exhausted with no engagement, but an email fallback is available — I have ' +
          'switched this prospect to the email lane and scheduled the first outreach email instead of ' +
          'closing the cadence.'
      );
    }

    await setCadenceComplete(chatId, reason);
    // Cadence is done → nothing proactive should remain queued.
    await enforceSingleProactiveTask(chatId, null);
    console.log(
      `[OB CADENCE] marked cadence_complete for chat=${chatId} (reason='${reason}')`
    );
    return response(
      toolUseId,
      'success',
      'Cadence marked complete — no further proactive outreach will be scheduled. The chat reopens ' +
        'automatically if the prospect replies.'
    );
  } catch (e) {
    console.error(
      `[OB CADENCE] mark_cadence_complete failed chat=${chatId}: ${e}`
    );
    return response(toolUseId, 'error', `Error marking cadence complete: ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// clear_not_interested
// ─────────────────────────────────────────────────────────────────────────────

export const clearNotInterestedToolDescription = {
  toolSpec: {
    name: 'clear_not_interested',
    description:
      "Remove the 'not_interested' label from THIS prospect's chat so proactive outreach resumes. " +
      'Use ONLY when an admin explicitly instructs you (via an @ai message) to re-engage a prospect ' +
      'previously read as not interested. It reverses ONLY the not_interested label — it does NOT ' +
      'change any phone/email opt-out (those reflect real consent) and does not change the stage.',
    inputSchema: { json: { type: 'object', properties: {} } },
  },
} as const;

registerTool(
  clearNotInterestedToolDescription.toolSpec.name,
  clearNotInterestedToolDescription
);

/** Run the `clear_not_interested` tool. Label-only, idempotent. */
export async function parseAndRunClearNotInterested(
  toolUseId: string,
  input: Record<string, unknown>,
  chatId: string
): Promise<BedrockMessage> {
  void input;
  if (!chatId) {
    return response(
      toolUseId,
      'error',
      'No chat_id — cannot re-engage this prospect.'
    );
  }
  let removed = false;
  try {
    removed = !!(await removeLabelFromChat(chatId, NOT_INTERESTED_LABEL));
  } catch (e) {
    console.error(`[OB clear_not_interested] failed for ${chatId}: ${e}`);
    return response(
      toolUseId,
      'error',
      `Failed to clear the not_interested label: ${e}`
    );
  }

  console.log(
    `[OB clear_not_interested] chat ${chatId}: not_interested removed=${removed}`
  );
  // NOTE the "nothing to remove" branch below is reached only when the WRITE failed —
  // `removeLabelFromChat` returns true whenever the arrayRemove update succeeds, whether or not the
  // label was actually present. So an absent label reports "removed", and a Firestore error reports
  // "no label was set". The message is misleading about the cause; preserved as the source has it,
  // because both outcomes are reported as `success` and no caller branches on the wording.
  if (removed) {
    return response(
      toolUseId,
      'success',
      "Removed the 'not_interested' label — proactive outreach re-opened on phone and email. " +
        '(Any phone/email opt-out reflects real consent and is left in place.)'
    );
  }
  return response(
    toolUseId,
    'success',
    "No 'not_interested' label was set on this chat — nothing to remove."
  );
}

/** Exposed for tests: the reason set whose exclusions are deliberate. */
export const __testing = { CALL_CHANNEL_REASONS, PENDING_FOLLOWUP_TYPES };
