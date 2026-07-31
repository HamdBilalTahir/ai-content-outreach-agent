/**
 * ElevenLabs voice-agent configuration.
 *
 * Attaches the OUTBOUND post-call webhook to an ALREADY-EXISTING voice agent. This exists because
 * connecting an agent from the front end only stores its id — it never pushes platform settings — so the
 * agent has no post-call webhook and the provider never calls back. Without this, a placed call
 * completes and nothing downstream ever learns the outcome.
 *
 * Outbound-only by design: it never touches the inbound agent's post-call webhook, and the PATCH is
 * strictly ADDITIVE — it reads the agent's current `platform_settings`, merges the outbound fields in,
 * and writes those back, so it can never clobber the agent's prompt, voice, or tool configuration.
 */

import { envStr } from '../config';

export const ELEVENLABS_BASE_API = 'https://api.elevenlabs.io';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The workspace webhook resource id wired, in the provider dashboard, to the outbound post-call
 * endpoint. Overridable by env; the literal default is the one the source ships.
 */
export function outboundPostCallWebhookId(): string {
  return (
    envStr('ELEVENLABS_OUTBOUND_POST_CALL_WEBHOOK_ID') ||
    '24b19d5135ce45228aaba0d70dad1940'
  );
}

/**
 * The workspace webhook resource id for the conversation-initiation endpoint, which the agent fetches on
 * INBOUND calls to get per-caller context.
 *
 * Env-gated with no default: when unset, only the enable flag is flipped, and a workspace-level
 * initiation-webhook URL configured in the provider dashboard serves the request instead. The source
 * carries a note to confirm the exact `platform_settings` field name against the current provider agent
 * schema, which is preserved here — this field name is the least certain part of the payload.
 */
function outboundConversationInitWebhookId(): string {
  return envStr('ELEVENLABS_OUTBOUND_CONVERSATION_INIT_WEBHOOK_ID');
}

/**
 * Attach the outbound post-call webhook and the per-call overrides the calling tool relies on
 * (`first_message`, `voice_id`) to an existing agent, WITHOUT touching its prompt, voice, or tools.
 *
 * Best-effort: returns a boolean and never throws.
 */
export async function attachOutboundPostCallWebhookToAgent(
  elevenlabsAgentId: string
): Promise<boolean> {
  if (!elevenlabsAgentId) return false;

  const apiKey = envStr('ELEVENLABS_API_KEY');
  if (!apiKey) {
    console.error('[OB attach_webhook] ELEVENLABS_API_KEY not configured');
    return false;
  }

  const headers = {
    'xi-api-key': apiKey,
    'Content-Type': 'application/json',
  };
  const url = `${ELEVENLABS_BASE_API}/v1/convai/agents/${elevenlabsAgentId}`;

  try {
    const getResp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!getResp.ok) {
      const body = await getResp.text();
      console.error(
        `[OB attach_webhook] GET agent ${elevenlabsAgentId} failed: ` +
          `${getResp.status} ${body.slice(0, 300)}`
      );
      return false;
    }

    const agent = ((await getResp.json()) ?? {}) as Record<string, unknown>;
    const platformSettings = {
      ...((agent.platform_settings as Record<string, unknown>) ?? {}),
    };

    // Merge the outbound post-call webhook into the workspace overrides. Additive.
    const workspaceOverrides = {
      ...((platformSettings.workspace_overrides as Record<string, unknown>) ??
        {}),
    };
    const webhooks: Record<string, unknown> = {
      post_call_webhook_id: outboundPostCallWebhookId(),
      events: ['transcript', 'audio', 'call_initiation_failure'],
    };
    const initId = outboundConversationInitWebhookId();
    if (initId) {
      webhooks.conversation_initiation_client_data_webhook_id = initId;
    }
    workspaceOverrides.webhooks = webhooks;
    platformSettings.workspace_overrides = workspaceOverrides;

    // Allow the per-call overrides the calling tool sends inline, plus inline
    // conversation-initiation client data (the dynamic variables carrying scope and skills).
    const overrides = {
      ...((platformSettings.overrides as Record<string, unknown>) ?? {}),
    };
    const cco = {
      ...((overrides.conversation_config_override as Record<string, unknown>) ??
        {}),
    };
    cco.agent = {
      ...((cco.agent as Record<string, unknown>) ?? {}),
      first_message: true,
    };
    cco.tts = {
      ...((cco.tts as Record<string, unknown>) ?? {}),
      voice_id: true,
    };
    overrides.conversation_config_override = cco;
    overrides.enable_conversation_initiation_client_data_from_webhook = true;
    platformSettings.overrides = overrides;

    const resp = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ platform_settings: platformSettings }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (resp.ok) {
      console.log(
        `[OB attach_webhook] Attached OUTBOUND webhooks to agent ${elevenlabsAgentId} ` +
          `(post_call=${outboundPostCallWebhookId()}, ` +
          `conv_init=${initId || 'workspace/flag-only'})`
      );
      return true;
    }

    const body = await resp.text();
    console.error(
      `[OB attach_webhook] PATCH agent ${elevenlabsAgentId} failed: ` +
        `${resp.status} ${body.slice(0, 300)}`
    );
    return false;
  } catch (e) {
    console.error(
      `[OB attach_webhook] Error attaching webhook to agent ${elevenlabsAgentId}: ${e}`
    );
    return false;
  }
}

/** Exposed for tests: the resolved webhook ids. */
export const __testing = {
  outboundPostCallWebhookId,
  outboundConversationInitWebhookId,
};
