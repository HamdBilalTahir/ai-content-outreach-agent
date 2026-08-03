/**
 * The three voice-agent admin endpoints — the port of `views/voice_settings.py` and
 * `views/voice_connect.py`.
 *
 * These manage the ElevenLabs side of an outbound agent: connect an existing voice agent, save and sync
 * its prompt, and reset the prompt to a saved default. All three are FE-callable admin actions, and
 * none of them is on a call path.
 *
 * ## Agent-doc fields
 *
 * - `voice_prompt` — the CURRENT ElevenLabs system prompt. The user edits this; per-call scenario
 *   handling (`call_type`, `prospect_stage`) lives inside it.
 * - `voice_prompt_default` — a snapshot taken the FIRST time a prompt is saved, and the only thing
 *   reset has to restore to. Without it, reset has nothing to do, which is why the first save takes it
 *   automatically rather than waiting to be asked.
 * - `voice_settings` — the voice config map (voice, phone number id, models).
 * - `voice_agent_assistant_id` / `voice_ai_provider` / `voice_agent_kind: "outbound"`.
 *
 * ## The OUTBOUND post-call webhook is re-attached after every sync
 *
 * `createElevenlabsAgent` / `updateElevenlabsAgent` are clones of the inbound provisioner and may set
 * the INBOUND webhook, so both sync paths attach the outbound one afterwards. That attach is
 * best-effort: the prompt is saved and the agent exists either way, and failing the whole request over
 * a webhook the next sync will fix would strand the user's edit.
 *
 * ## Sync failure is a 502, and it happens BEFORE anything is written
 *
 * The order is deliberate. If ElevenLabs refuses the prompt, the agent doc is left untouched — so the
 * doc never claims a prompt the provider is not actually serving. A 502 (not a 500) says the fault was
 * upstream, which is what the FE needs to decide whether retrying is worth anything.
 */

import { db } from '../firebase/db';
import { getAgent } from '../firebase/agent';
import { attachOutboundPostCallWebhookToAgent } from '../services/elevenlabs';
import {
  createElevenlabsAgent,
  updateElevenlabsAgent,
} from '../services/elevenlabsAgentService';
import { resolveOutboundName } from '../services/chat';
import { json } from './types';
import type { OutboundRequest, OutboundResponse } from './types';
import type { VoiceSettings } from '../services/elevenlabsAgentService';

type AgentDoc = Record<string, unknown>;

function agentRef(agentId: string) {
  return db.collection('agents').doc(agentId);
}

/**
 * Create or update the ElevenLabs agent from `prompt` + `voiceSettings`, attach the outbound post-call
 * webhook, and return `[assistantId, created]`. THROWS on a hard failure — see the module note on why
 * the caller must not write anything until this resolves.
 */
async function syncPromptToElevenlabs(
  agentId: string,
  agentData: AgentDoc,
  prompt: string,
  voiceSettings: VoiceSettings
): Promise<[string, boolean]> {
  const name = String(
    agentData.name ||
      agentData.agent_name ||
      `${await resolveOutboundName(undefined, agentData)} (Outbound)`
  );
  const dynamicVariables = (agentData.dynamic_variables ?? {}) as Record<
    string,
    unknown
  >;
  let assistantId = String(agentData.voice_agent_assistant_id ?? '');
  let created = false;

  if (assistantId) {
    const ok = await updateElevenlabsAgent(
      assistantId,
      name,
      prompt,
      voiceSettings,
      agentId,
      null,
      dynamicVariables
    );
    if (!ok) throw new Error('updateElevenlabsAgent failed');
  } else {
    const newId = await createElevenlabsAgent(
      name,
      prompt,
      voiceSettings,
      agentId,
      null,
      dynamicVariables
    );
    if (!newId) throw new Error('createElevenlabsAgent failed');
    assistantId = newId;
    created = true;
  }

  // Best-effort: the cloned create/update may have set the INBOUND webhook. See the module note.
  try {
    await attachOutboundPostCallWebhookToAgent(assistantId);
  } catch (e) {
    console.warn(`[OB_VOICE] webhook attach failed for ${assistantId}: ${e}`);
  }
  return [assistantId, created];
}

/** Load the agent, or the response to return instead. */
async function loadAgent(
  agentId: unknown
): Promise<{ id: string; data: AgentDoc } | OutboundResponse> {
  if (!agentId)
    return json({ success: false, error: 'agent_id is required' }, 400);
  const id = String(agentId);
  const data = await getAgent(id);
  if (!data) return json({ success: false, error: 'agent not found' }, 404);
  return { id, data: data as AgentDoc };
}

function isResponse(x: unknown): x is OutboundResponse {
  return typeof x === 'object' && x !== null && 'status' in x;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /voice/update/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save the outbound voice prompt and settings on the agent doc, and sync them to ElevenLabs.
 *
 * `voice_prompt` and `voice_settings` both fall back to whatever is already on the doc, so the FE can
 * re-sync without resending everything. A blank prompt is refused rather than pushed — an agent with an
 * empty system prompt answers the phone with nothing to say.
 */
export async function voiceSettingsUpdateView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const loaded = await loadAgent(body.agent_id);
  if (isResponse(loaded)) return loaded;
  const { id: agentId, data: agentData } = loaded;

  // `is None`, not falsiness: an explicit empty string reaches the blank check below and is refused,
  // rather than silently falling back to the stored prompt and reporting success.
  const promptIn =
    body.voice_prompt === undefined || body.voice_prompt === null
      ? agentData.voice_prompt
      : body.voice_prompt;
  const prompt = String(promptIn ?? '');
  if (!prompt.trim()) {
    return json(
      {
        success: false,
        error: 'voice_prompt is required (none on the agent doc yet)',
      },
      400
    );
  }
  const voiceSettings = (body.voice_settings ||
    agentData.voice_settings ||
    {}) as VoiceSettings;

  let assistantId: string;
  let created: boolean;
  try {
    [assistantId, created] = await syncPromptToElevenlabs(
      agentId,
      agentData,
      prompt,
      voiceSettings
    );
  } catch (e) {
    console.error(`[OB_VOICE] sync failed for agent ${agentId}: ${e}`);
    return json({ success: false, error: `ElevenLabs sync failed: ${e}` }, 502);
  }

  const updates: Record<string, unknown> = {
    voice_prompt: prompt,
    voice_settings: voiceSettings,
    voice_agent_assistant_id: assistantId,
    voice_ai_provider: 'elevenlabs',
    voice_agent_kind: 'outbound',
  };
  // Snapshot the default on the FIRST save (or when asked), so reset always has a target. A blank
  // stored default counts as no default — otherwise reset would restore an empty prompt.
  if (
    body.set_default ||
    !String(agentData.voice_prompt_default ?? '').trim()
  ) {
    updates.voice_prompt_default = prompt;
  }
  await agentRef(agentId).set(updates, { merge: true });

  return json({
    success: true,
    agent_id: agentId,
    voice_agent_assistant_id: assistantId,
    created,
    default_saved: 'voice_prompt_default' in updates,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /voice/reset/
// ─────────────────────────────────────────────────────────────────────────────

/** Restore `voice_prompt` from `voice_prompt_default` and re-sync. */
export async function voiceResetView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const loaded = await loadAgent(request.body.agent_id);
  if (isResponse(loaded)) return loaded;
  const { id: agentId, data: agentData } = loaded;

  const defaultPrompt = String(agentData.voice_prompt_default ?? '').trim();
  if (!defaultPrompt) {
    return json(
      { success: false, error: 'no voice_prompt_default saved to reset to' },
      400
    );
  }
  const voiceSettings = (agentData.voice_settings ?? {}) as VoiceSettings;

  let assistantId: string;
  try {
    [assistantId] = await syncPromptToElevenlabs(
      agentId,
      agentData,
      defaultPrompt,
      voiceSettings
    );
  } catch (e) {
    console.error(`[OB_VOICE] reset sync failed for agent ${agentId}: ${e}`);
    return json({ success: false, error: `ElevenLabs sync failed: ${e}` }, 502);
  }

  // Only the two fields reset actually changes — `voice_settings` was not touched, and rewriting it
  // would make a concurrent settings save lose.
  await agentRef(agentId).set(
    { voice_prompt: defaultPrompt, voice_agent_assistant_id: assistantId },
    { merge: true }
  );
  return json({
    success: true,
    agent_id: agentId,
    voice_agent_assistant_id: assistantId,
    reset_to_default: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /voice-agent/connect/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach the OUTBOUND post-call webhook to an existing ElevenLabs agent and record the connection.
 *
 * Outbound-only: it never touches the inbound webhook. Note what this does NOT require — an `agent_id`
 * is optional, because attaching the webhook is useful on its own and the FE sometimes connects a voice
 * agent before it has an outbound agent to bind it to. When an `agent_id` IS given, persisting the
 * connection is best-effort and does not fail the request: the webhook is the part that changes
 * behaviour, and the doc write can be repeated.
 */
export async function voiceConnectView(
  request: OutboundRequest
): Promise<OutboundResponse> {
  const body = request.body;
  const agentId = body.agent_id ? String(body.agent_id) : null;
  const elAgentId = String(
    body.voice_agent_assistant_id ?? body.elevenlabs_agent_id ?? ''
  );
  const provider = String(body.voice_ai_provider ?? 'elevenlabs').toLowerCase();

  if (!elAgentId) {
    return json(
      { success: false, error: 'voice_agent_assistant_id is required' },
      400
    );
  }

  // `null`, not `false`, for a non-ElevenLabs provider: nothing was attempted, which is different from
  // an attach that was tried and failed.
  let webhookSynced: boolean | null = null;
  if (provider === 'elevenlabs') {
    webhookSynced = await attachOutboundPostCallWebhookToAgent(elAgentId);
  }

  if (agentId) {
    try {
      await agentRef(agentId).set(
        {
          voice_agent_assistant_id: elAgentId,
          voice_ai_provider: provider,
          voice_agent_kind: 'outbound',
        },
        { merge: true }
      );
    } catch (e) {
      console.warn(
        `[OB_CONNECT] failed to persist voice config for agent ${agentId}: ${e}`
      );
    }
  }

  return json({
    success: true,
    agent_id: agentId,
    voice_agent_assistant_id: elAgentId,
    post_call_webhook_synced: webhookSynced,
  });
}
