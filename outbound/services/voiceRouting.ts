/**
 * Durable outbound voice-call → chat resolution.
 *
 * Post-call routing must NOT depend on the ephemeral `pending_calls` document surviving — it is
 * deleted right after the place-call turn. So the chat is reconstructed from data that is durable at
 * webhook time: the FROM phone number's owner (else the assistant-id match) plus the customer number,
 * which together rebuild the namespaced outbound chat id `outbound__{agentId}__{number}`.
 */

import { db } from '../firebase/db';
import {
  getPhoneNumber,
  getPhoneNumberByNumber,
} from '../firebase/phoneNumbers';

/**
 * The agent document id whose `voice_agent_assistant_id` matches, or `null`.
 *
 * Several agents can share ONE provider assistant — an inbound web persona and an outbound persona
 * often point at the same voice agent. When several match, prefer the agent that OWNS an outbound
 * phone number, so an inbound call-back to the outbound line resolves to the outbound agent rather
 * than the shared inbound persona. Falls back to the first match.
 */
export async function findAgentByAssistantId(
  assistantId: string | null | undefined
): Promise<string | null> {
  if (!assistantId) return null;
  try {
    const snap = await db
      .collection('agents')
      .where('voice_agent_assistant_id', '==', assistantId)
      .limit(10)
      .get();
    const matches = snap.docs.map((a) => a.id);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    for (const aid of matches) {
      const owned = await db
        .collection('phone_numbers')
        .where('agent_id', '==', aid)
        .limit(1)
        .get();
      if (!owned.empty) return aid;
    }
    return matches[0];
  } catch (e) {
    console.warn(`[OB_VOICE] findAgentByAssistantId failed: ${e}`);
    return null;
  }
}

/**
 * Our oversee agent id for an OUTBOUND call — the same id the outbound chat was created under.
 * Priority: the FROM phone number's owner, then the assistant-id match.
 */
export async function resolveOutboundAgentId(
  metadata: Record<string, unknown> | null | undefined,
  assistantId?: string | null
): Promise<string | null> {
  try {
    const pc = ((metadata ?? {}).phone_call ?? {}) as Record<string, unknown>;
    const pnid = pc.phone_number_id ?? pc.agent_phone_number_id;
    if (pnid) {
      const doc = await getPhoneNumber(String(pnid));
      if (doc) {
        const aid = doc.oversee_agent_id ?? doc.agent_id;
        if (aid) return String(aid);
      }
    }
  } catch (e) {
    console.warn(`[OB_VOICE] agent resolve via phone_number_id failed: ${e}`);
  }
  return findAgentByAssistantId(assistantId);
}

/**
 * Our oversee agent id for an INBOUND call to one of our numbers. Priority: the CALLED number's owner
 * in `phone_numbers`, then the assistant-id match.
 */
export async function resolveOutboundAgentForInbound(
  calledNumber: string | null | undefined,
  assistantId?: string | null
): Promise<string | null> {
  try {
    if (calledNumber) {
      const doc = await getPhoneNumberByNumber(calledNumber);
      if (doc) {
        const aid = doc.oversee_agent_id ?? doc.agent_id;
        if (aid) return String(aid);
      }
    }
  } catch (e) {
    console.warn(
      `[OB_VOICE] inbound agent resolve via calledNumber failed: ${e}`
    );
  }
  return findAgentByAssistantId(assistantId);
}

/**
 * The customer's phone from provider metadata: `phone_call.external_number` first, then the Twilio
 * body's `From` / `To`.
 */
export function extractCustomerPhone(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const md = metadata ?? {};
  try {
    const pc = (md.phone_call ?? {}) as Record<string, unknown>;
    const ext = String(pc.external_number ?? '').trim();
    if (ext) return ext;

    const body = (md.body ?? {}) as Record<string, unknown>;
    for (const k of ['From', 'To']) {
      const v = String(body[k] ?? '').trim();
      if (v) return v;
    }
  } catch (e) {
    console.warn(`[OB_VOICE] extractCustomerPhone failed: ${e}`);
  }
  return null;
}
