/**
 * Outbound escalate-to-human — hand a genuine opportunity the AI cannot close to a HUMAN rep.
 *
 * Fires for a buyer-capable prospect showing soft interest, or one who is AI-skeptical **but would talk to
 * a human**. Five side effects, in order:
 *
 *  1. stage → `Lead`, sub_stage → `pre_booking` (the funnel's PREBOOKED bucket and the FE's "Pre-Booking" pill)
 *  2. opt out BOTH channels, so no further outreach can ever fire
 *  3. delete every pending proactive task
 *  4. mark `escalate` (the FE's escalated tab) plus reason and evidence
 *  5. create a HubSpot deal at "New Outbound – Potential Opportunity" — NOT the demo stage — and post ONE
 *     handover note
 *
 * ## Exclusivity with the demo-booking flow is structural, not incidental
 *
 * Two mechanisms, because one is not enough. The guard below refuses to escalate a chat already on the
 * booking path, and step 5 pre-writes `hubspot_deal_id` + `_hubspot_synced_stage: 'Lead'` so the normal
 * Lead→"Initial Demo Scheduled" push sees an existing deal and never runs. Without the second, a later
 * stage sync would drag an escalated lead into the demo stage behind the rep's back.
 *
 * Every side effect is individually wrapped: by the time step 3 runs the chat is already opted out, and
 * abandoning the rest would leave it half-escalated — flagged to no one, or silent with no rep assigned.
 */

import { db } from '../firebase/db';
import { addLabelToChat, setEscalate, setMemory } from '../firebase/chat';
import { getAgentActions } from '../firebase/agent';
import { setProspectStage, setProspectSubStage } from '../firebase/prospect';
import { isEscalated, loadChatDoc } from '../services/chat';
import { enforceSingleProactiveTask } from '../services/scheduling';
import {
  accessToken,
  logHubspotDealNote,
  resolveHubspotConfig,
  resolveOwnerId,
  updateContactProperty,
} from '../services/hubspot';
import {
  createDealForContact,
  dealname,
  recentTranscript,
} from '../services/hubspotDeals';
import { llmText } from './reviewHelpers';
import { registerTool } from '../llm/toolRegistry';
import type { BedrockMessage, ChatMemory } from '../types';

/**
 * "New Outbound – Potential Opportunity" in the default Sales Pipeline — immediately before "Initial Demo
 * Scheduled". A code fallback: `cfg.stage_ids.PreBooking` wins when the agent config sets it.
 */
export const PRE_BOOKING_STAGE_ID = '1412860208';
export const PRE_BOOKING_SUB_STAGE = 'pre_booking';

const NOTE_AT_KEY = '_escalation_note_at';

/**
 * Escalation may fire at ANY live funnel stage.
 *
 * The escalation skill is enabled on every stage, and the review-driven path runs while the chat is still
 * `Contacted` — BEFORE the Engaged advance — so blocking `Contacted` would stop it firing at all. Only a
 * TERMINAL or unknown stage is refused: a Lost chat is done, and an empty stage means nothing was ever
 * established. The real "is this a genuine opportunity?" judgement belongs to the review classifier and the
 * skill instructions, not to the funnel label.
 */
const NO_ESCALATION_STAGES = new Set(['', 'Lost', 'closed_lost']);

export const escalateToolDescription = {
  toolSpec: {
    name: 'escalate_to_human',
    description:
      'Hand this outbound lead to a HUMAN sales rep and stop all AI outreach. Call ONLY when an active ' +
      'SKILL authorizes it for a genuine opportunity the AI cannot close — a buyer-capable person ' +
      'showing soft interest, or who is skeptical of talking to an AI but would talk to a human. Do NOT ' +
      'call for: a booked demo (that path is separate), a plain callback, a referral to someone else, a ' +
      "flat 'not interested', or a gatekeeper who only took a message. This parks the lead as a " +
      "'Pre-Booking' opportunity for a human.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'Why this is a human-worthy opportunity: the signal, in one line.',
          },
          evidence: {
            type: 'string',
            description:
              'The exact customer quote that shows soft interest / AI-skepticism-but-human-open.',
          },
        },
        required: ['reason'],
      },
    },
  },
} as const;

registerTool(escalateToolDescription.toolSpec.name, escalateToolDescription);

function fullName(memory: ChatMemory): string {
  return [memory.first_name, memory.last_name]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// The handover note
// ─────────────────────────────────────────────────────────────────────────────

/** One LLM call → a rep-facing handover note in light HTML. `''` on failure; the caller falls back. */
async function generateBriefLlm(
  transcript: string,
  reason: string,
  evidence: string,
  memory: ChatMemory
): Promise<string> {
  const system =
    'You are writing a SHORT internal handoff note for a HUMAN sales rep taking over an outbound lead the ' +
    'AI could not close. Output light HTML only (<b>, <br>) — no markdown, no preamble. Use ONLY facts ' +
    'present in the conversation or fields given; never invent. Produce EXACTLY two sections:\n' +
    '<b>Why this is an opportunity</b><br> — 2–4 sentences: who the person is and whether they can buy, ' +
    "what they actually said that signals interest or that they'd engage a human (quote them briefly), and " +
    'the objection (e.g. AI-skepticism, no authority).<br><br>' +
    '<b>Next steps for the rep</b><br> — 2–4 short <br>-separated lines: exactly who to call (name + ' +
    'number if a decision-maker/referral was named in the call), the best time / callback window if ' +
    'mentioned, and a one-line suggested opening that addresses the objection.';

  const user =
    `PROSPECT: ${fullName(memory) || '(unknown)'} at ${memory.company || '(unknown company)'}\n` +
    `WHY FLAGGED (system reason): ${reason || '(none)'}\n` +
    `KEY QUOTE: ${evidence || '(none)'}\n\n` +
    `CONVERSATION:\n${transcript || '(none)'}`;

  // Two attempts, as the source does — the note is the rep's only context, so one transient failure
  // should not drop them to the deterministic fallback.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await llmText(system, user);
      if (text.trim()) return text.trim();
    } catch (e) {
      console.warn(
        `[OB ESCALATE] brief gen attempt ${attempt + 1} failed: ${e}`
      );
    }
  }
  return '';
}

/** LLM-free fallback, so a handover note is ALWAYS present. */
export function deterministicBrief(
  memory: ChatMemory,
  reason: string,
  evidence: string
): string {
  const name = fullName(memory);
  const why: string[] = [];
  if (name) {
    why.push(
      `Prospect <b>${name}</b>${memory.company ? ` at ${memory.company}` : ''}`
    );
  }
  if (reason) why.push(reason);
  if (evidence) why.push(`They said: "${evidence}"`);

  let whyTxt =
    why.join('. ') ||
    'A buyer-capable prospect showed soft interest the AI could not close.';
  const steps = [
    'Call the prospect back as a human — the AI put them off, a person can re-engage.',
    "Address the objection directly and, if there's genuine fit, book the demo.",
  ];
  if (memory._conversation_summary) {
    whyTxt += `<br><br><b>Context:</b> ${memory._conversation_summary}`;
  }
  return (
    `<b>Why this is an opportunity</b><br>${whyTxt}<br><br>` +
    `<b>Next steps for the rep</b><br>${steps.join('<br>')}`
  );
}

async function buildEscalationNote(
  chatId: string,
  memory: ChatMemory,
  reason: string,
  evidence: string,
  transcript?: string | null
): Promise<string> {
  let text = transcript ?? '';
  if (!text) {
    try {
      // The source reads this from `inbound_booking_email._recent_transcript`, which is not ported (an
      // inbound module — plan revision 6). `hubspotDeals.recentTranscript` is the outbound equivalent
      // already used to build deal notes, so the handover note is assembled from the same source.
      text = await recentTranscript(chatId, 30);
    } catch {
      text = '';
    }
  }
  const brief =
    (await generateBriefLlm(text, reason, evidence, memory)) ||
    deterministicBrief(memory, reason, evidence);
  const name = fullName(memory) || 'Prospect';
  return `<b>${name} — Pre-Booking opportunity (AI → human handoff)</b><br><br>${brief}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Pre-Booking deal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the deal at the Pre-Booking stage and post ONE handover note.
 *
 * Best-effort: returns the existing deal id on any failure, because the chat is already escalated by the
 * time this runs and losing the CRM half must not undo the rest.
 */
async function createPrebookingDealAndNote(
  chatId: string,
  agentId: string,
  memory: ChatMemory,
  reason: string,
  evidence: string,
  transcript?: string | null
): Promise<string | null> {
  const existing: string | null = memory.hubspot_deal_id
    ? String(memory.hubspot_deal_id)
    : null;
  try {
    const cfg = resolveHubspotConfig((await getAgentActions(agentId)) ?? []);
    if (!cfg.refresh_token && !cfg.access_token) return existing;

    const token = await accessToken(cfg, agentId);
    const contactId = memory.hubspot_contact_id;
    if (!token || !contactId) {
      console.log(
        `[OB ESCALATE] ${chatId}: no HubSpot token/contact — skipping deal`
      );
      return existing;
    }

    let dealId = existing;
    if (!dealId) {
      const stageId = (cfg.stage_ids ?? {}).PreBooking || PRE_BOOKING_STAGE_ID;
      const owner = resolveOwnerId(cfg, memory.record_type as string);
      const extra: Record<string, unknown> = {};
      if (owner) extra.hubspot_owner_id = owner;

      dealId = await createDealForContact(
        token,
        String(cfg.pipeline_id ?? ''),
        stageId,
        dealname(memory),
        String(contactId),
        extra
      );
      // Deal exists → put the CONTACT on the same owner, so the record and the deal do not disagree
      // about who owns the relationship.
      if (dealId && owner) {
        await updateContactProperty(
          token,
          String(contactId),
          'hubspot_owner_id',
          String(owner)
        );
      }
    }
    if (!dealId) return null;

    // Suppresses the normal Lead→"Initial Demo Scheduled" push — see the module note on exclusivity.
    await setMemory(chatId, {
      hubspot_deal_id: dealId,
      _hubspot_synced_stage: 'Lead',
    });

    if (!memory[NOTE_AT_KEY]) {
      const note = await buildEscalationNote(
        chatId,
        memory,
        reason,
        evidence,
        transcript
      );
      if (note && (await logHubspotDealNote(token, dealId, note))) {
        await setMemory(chatId, {
          [NOTE_AT_KEY]: new Date().toISOString(),
          escalation_note: note,
        });
        console.log(
          `[OB ESCALATE] ${chatId}: handover note posted to deal ${dealId}`
        );
      }
    }
    return dealId;
  } catch (e) {
    console.error(`[OB ESCALATE] ${chatId}: deal/note failed: ${e}`);
    return existing;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

export interface EscalateResult {
  status: 'success' | 'skipped' | 'blocked' | 'failed';
  escalated?: boolean;
  sub_stage?: string;
  deal_id?: string | null;
  reason?: string;
  stage?: string;
  message?: string;
}

export interface EscalateOptions {
  agentId?: string | null;
  reason?: string;
  evidence?: string | null;
  metaData?: Record<string, unknown> | null;
  transcript?: string | null;
}

/**
 * Park an outbound chat as a human-owned Pre-Booking Lead. Idempotent; every side effect best-effort.
 */
export async function escalateChat(
  chatId: string,
  options: EscalateOptions = {}
): Promise<EscalateResult> {
  const {
    reason = '',
    evidence = null,
    metaData = null,
    transcript = null,
  } = options;
  if (!chatId) return { status: 'failed', reason: 'no chat_id' };

  const doc = (await loadChatDoc(chatId)) ?? {};
  const memory = (doc.memory ?? {}) as ChatMemory;

  if (isEscalated(doc)) {
    return { status: 'skipped', escalated: true, reason: 'already_escalated' };
  }
  // DEMO WINS — never escalate a chat already on the booking path.
  if (memory.meeting_booked || memory._agreed_slot || memory.demo_time) {
    console.log(
      `[OB ESCALATE] ${chatId}: on booking path — escalation skipped (demo wins)`
    );
    return { status: 'skipped', reason: 'demo_booking_in_progress' };
  }
  const stage = String(doc.stage ?? '').trim();
  if (NO_ESCALATION_STAGES.has(stage)) {
    console.log(
      `[OB ESCALATE] ${chatId}: stage='${stage}' not eligible (terminal/unknown)`
    );
    return { status: 'blocked', reason: 'terminal_or_unknown_stage', stage };
  }

  const meta = metaData ?? {};
  const agentId = String(
    options.agentId || doc.agentId || memory.agent_id || ''
  );
  const dealersId = String(
    memory.dealers_id || memory.dealer_id || meta.dealers_id || ''
  );
  const companyId = String(memory.company_id || meta.company_id || '');

  // 1) stage → Lead + sub_stage → pre_booking
  try {
    await setProspectStage(
      chatId,
      'Lead',
      'outbound_escalation',
      dealersId,
      companyId
    );
    // The source passes `assume_lead=True` to bypass a guard that refuses a sub_stage on a non-Lead chat —
    // needed because the stage it just set has not been read back yet. This port's `setProspectSubStage`
    // carries no such guard (Phase 1 simplification), so it already behaves as if the flag were set.
    await setProspectSubStage(
      chatId,
      PRE_BOOKING_SUB_STAGE,
      'outbound_escalation'
    );
  } catch (e) {
    console.error(`[OB ESCALATE] ${chatId}: stage/sub_stage set failed: ${e}`);
  }

  // 2) opt out BOTH channels, so no further outreach can fire
  try {
    await db
      .collection('chats')
      .doc(chatId)
      .set(
        { phone_opt_out: true, block_phone: true, email_opt_out: true },
        { merge: true }
      );
    await setMemory(chatId, { _email_opt_out: true });
  } catch (e) {
    console.error(`[OB ESCALATE] ${chatId}: opt-out failed: ${e}`);
  }

  // 3) cancel every pending proactive task
  try {
    await enforceSingleProactiveTask(chatId, null);
  } catch (e) {
    console.error(`[OB ESCALATE] ${chatId}: task cancel failed: ${e}`);
  }

  // 4) mark escalated + reason/evidence. Truncated as the source does: these render in a FE panel, and an
  //    LLM-authored reason can run long.
  try {
    await setEscalate(chatId, true);
    await db
      .collection('chats')
      .doc(chatId)
      .set(
        {
          escalated_at: new Date().toISOString(),
          escalation_reason: String(reason ?? '').slice(0, 500),
          escalation_evidence: String(evidence ?? '').slice(0, 1000),
        },
        { merge: true }
      );
    try {
      await addLabelToChat(chatId, 'escalated');
    } catch {
      // The label is for the UI; `escalate` is the actual gate.
    }
  } catch (e) {
    console.error(`[OB ESCALATE] ${chatId}: escalate flag failed: ${e}`);
  }

  // 5) HubSpot deal at the Pre-Booking stage + ONE handover note
  const dealId = await createPrebookingDealAndNote(
    chatId,
    agentId,
    memory,
    reason,
    String(evidence ?? ''),
    transcript
  );

  console.log(
    `[OB ESCALATE] ${chatId}: escalated → Lead/pre_booking (deal=${dealId})`
  );
  return {
    status: 'success',
    escalated: true,
    sub_stage: PRE_BOOKING_SUB_STAGE,
    deal_id: dealId,
    reason,
  };
}

function toolResult(
  toolUseId: string,
  payload: Record<string, unknown>
): BedrockMessage {
  return {
    role: 'user',
    content: [{ toolResult: { toolUseId, content: [{ json: payload }] } }],
  } as unknown as BedrockMessage;
}

/**
 * The agent-invoked path, enabled by a skill.
 *
 * The review tool calls `escalateChat` directly; this lets the agent trigger the same flow when a skill
 * authorizes it, so both entry points share one implementation and one set of guards.
 */
export async function parseAndRunEscalateToHuman(
  toolUseId: string,
  input: { reason?: string; evidence?: string },
  chatId: string,
  metaData?: Record<string, unknown> | null
): Promise<BedrockMessage> {
  const reason = input?.reason ?? '';
  const evidence = input?.evidence ?? null;
  const meta = metaData ?? {};
  const agentId = String(meta.agent_id ?? meta.tool_agent_id ?? '');

  console.log(`[OB ESCALATE] tool call chat=${chatId} reason='${reason}'`);
  let result: EscalateResult;
  try {
    result = await escalateChat(chatId, {
      agentId,
      reason,
      evidence,
      metaData: meta,
    });
  } catch (e) {
    console.error(`[OB ESCALATE] tool run failed chat=${chatId}: ${e}`);
    return toolResult(toolUseId, { status: 'failed', reason: String(e) });
  }

  if (result.status === 'success') {
    result = {
      ...result,
      message:
        'Lead handed to a human rep (Pre-Booking). Stop all outreach on this chat.',
    };
  }
  return toolResult(toolUseId, result as unknown as Record<string, unknown>);
}
