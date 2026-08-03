/**
 * @jest-environment node
 *
 * The three voice-agent admin views.
 *
 * The ordering is what these mostly protect:
 *
 *  - **Sync happens BEFORE the agent doc is written.** If ElevenLabs refuses the prompt, the doc is left
 *    untouched — so it never claims a prompt the provider is not actually serving.
 *  - **The webhook attach is best-effort and comes after the sync**, because the prompt is saved and the
 *    agent exists either way, and failing the request over something the next sync fixes would strand
 *    the user's edit.
 *  - **The default snapshot is taken on the FIRST save**, since reset has nothing to restore to
 *    otherwise.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);
jest.mock('../../firebase/agent', () => ({ getAgent: jest.fn() }));
jest.mock('../../services/elevenlabs', () => ({
  attachOutboundPostCallWebhookToAgent: jest.fn(),
}));
jest.mock('../../services/elevenlabsAgentService', () => ({
  createElevenlabsAgent: jest.fn(),
  updateElevenlabsAgent: jest.fn(),
}));
jest.mock('../../services/chat', () => ({ resolveOutboundName: jest.fn() }));

import { store } from '../../testSupport/mockFirestore';
import {
  voiceConnectView,
  voiceResetView,
  voiceSettingsUpdateView,
} from '../../http/voiceViews';
import { getAgent } from '../../firebase/agent';
import { attachOutboundPostCallWebhookToAgent } from '../../services/elevenlabs';
import {
  createElevenlabsAgent,
  updateElevenlabsAgent,
} from '../../services/elevenlabsAgentService';
import { resolveOutboundName } from '../../services/chat';
import type { OutboundRequest } from '../../http/types';

const AGENT = 'agent_1';

function req(body: Record<string, unknown> = {}): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query: {},
    headers: {},
    body,
    bodyArray: null,
    rawBody: '',
  };
}

/** What the agent doc looks like after the view wrote to it. */
function storedAgent(): Record<string, unknown> {
  return (store.get(`agents/${AGENT}`) ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
  (attachOutboundPostCallWebhookToAgent as jest.Mock).mockResolvedValue(true);
  (updateElevenlabsAgent as jest.Mock).mockResolvedValue(true);
  (createElevenlabsAgent as jest.Mock).mockResolvedValue('el_new');
  (resolveOutboundName as jest.Mock).mockResolvedValue('Lily');
  store.set(`agents/${AGENT}`, {});
});

// ─────────────────────────────────────────────────────────────────────────────
// voice/update/
// ─────────────────────────────────────────────────────────────────────────────

describe('voiceSettingsUpdateView', () => {
  it('creates the ElevenLabs agent, saves the prompt, and snapshots the default', async () => {
    (getAgent as jest.Mock).mockResolvedValue({ name: 'Lily Agent' });
    const res = await voiceSettingsUpdateView(
      req({
        agent_id: AGENT,
        voice_prompt: 'You are Lily.',
        voice_settings: { voice: 'rachel' },
      })
    );
    expect(createElevenlabsAgent).toHaveBeenCalledWith(
      'Lily Agent',
      'You are Lily.',
      { voice: 'rachel' },
      AGENT,
      null,
      {}
    );
    expect(res.json).toEqual({
      success: true,
      agent_id: AGENT,
      voice_agent_assistant_id: 'el_new',
      created: true,
      default_saved: true,
    });
    expect(storedAgent()).toMatchObject({
      voice_prompt: 'You are Lily.',
      voice_prompt_default: 'You are Lily.',
      voice_agent_assistant_id: 'el_new',
      voice_ai_provider: 'elevenlabs',
      voice_agent_kind: 'outbound',
    });
  });

  it('UPDATES rather than creates when an assistant id is already on the doc', async () => {
    (getAgent as jest.Mock).mockResolvedValue({
      name: 'Lily Agent',
      voice_agent_assistant_id: 'el_existing',
    });
    const res = await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: 'v2' })
    );
    expect(updateElevenlabsAgent).toHaveBeenCalledWith(
      'el_existing',
      'Lily Agent',
      'v2',
      {},
      AGENT,
      null,
      {}
    );
    expect(createElevenlabsAgent).not.toHaveBeenCalled();
    expect(res.json).toMatchObject({ created: false });
  });

  it('does NOT re-snapshot the default once one exists', async () => {
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt_default: 'original',
      voice_agent_assistant_id: 'el_1',
    });
    const res = await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: 'edited' })
    );
    expect(res.json).toMatchObject({ default_saved: false });
    expect(storedAgent().voice_prompt_default).toBeUndefined();
  });

  it('re-snapshots on an explicit set_default', async () => {
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt_default: 'original',
      voice_agent_assistant_id: 'el_1',
    });
    await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: 'new baseline', set_default: true })
    );
    expect(storedAgent().voice_prompt_default).toBe('new baseline');
  });

  it('treats a BLANK stored default as no default at all', async () => {
    // Otherwise reset would faithfully restore an empty prompt.
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt_default: '   ',
      voice_agent_assistant_id: 'el_1',
    });
    await voiceSettingsUpdateView(req({ agent_id: AGENT, voice_prompt: 'p' }));
    expect(storedAgent().voice_prompt_default).toBe('p');
  });

  it('falls back to the prompt and settings already on the doc', async () => {
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt: 'stored prompt',
      voice_settings: { voice: 'adam' },
      voice_agent_assistant_id: 'el_1',
    });
    await voiceSettingsUpdateView(req({ agent_id: AGENT }));
    expect(updateElevenlabsAgent).toHaveBeenCalledWith(
      'el_1',
      expect.any(String),
      'stored prompt',
      { voice: 'adam' },
      AGENT,
      null,
      {}
    );
  });

  it('refuses an explicitly EMPTY prompt rather than falling back to the stored one', async () => {
    // `is None`, not falsiness. Falling back here would report success for an edit that cleared the
    // prompt, leaving the user's change silently undone.
    (getAgent as jest.Mock).mockResolvedValue({ voice_prompt: 'stored' });
    const res = await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: '   ' })
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      success: false,
      error: 'voice_prompt is required (none on the agent doc yet)',
    });
    expect(createElevenlabsAgent).not.toHaveBeenCalled();
  });

  it('400s with no prompt anywhere', async () => {
    (getAgent as jest.Mock).mockResolvedValue({});
    expect(
      (await voiceSettingsUpdateView(req({ agent_id: AGENT }))).status
    ).toBe(400);
  });

  it('502s on an ElevenLabs failure and writes NOTHING to the doc', async () => {
    // The order is the point: the doc must never claim a prompt the provider is not serving.
    (getAgent as jest.Mock).mockResolvedValue({
      voice_agent_assistant_id: 'el_1',
    });
    (updateElevenlabsAgent as jest.Mock).mockResolvedValue(false);
    const res = await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: 'p' })
    );
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ success: false });
    expect(storedAgent()).toEqual({});
  });

  it('502s when create returns no id', async () => {
    (getAgent as jest.Mock).mockResolvedValue({});
    (createElevenlabsAgent as jest.Mock).mockResolvedValue(null);
    const res = await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: 'p' })
    );
    expect(res.status).toBe(502);
    expect(storedAgent()).toEqual({});
  });

  it('still saves when the webhook attach fails — best-effort, and the next sync fixes it', async () => {
    (getAgent as jest.Mock).mockResolvedValue({});
    (attachOutboundPostCallWebhookToAgent as jest.Mock).mockRejectedValue(
      new Error('429')
    );
    const res = await voiceSettingsUpdateView(
      req({ agent_id: AGENT, voice_prompt: 'p' })
    );
    expect(res.status).toBe(200);
    expect(storedAgent().voice_prompt).toBe('p');
  });

  it('re-attaches the OUTBOUND webhook after every sync', async () => {
    // The cloned create/update may have set the inbound one.
    (getAgent as jest.Mock).mockResolvedValue({});
    await voiceSettingsUpdateView(req({ agent_id: AGENT, voice_prompt: 'p' }));
    expect(attachOutboundPostCallWebhookToAgent).toHaveBeenCalledWith('el_new');
  });

  it('derives a name from the outbound persona when the doc has none', async () => {
    (getAgent as jest.Mock).mockResolvedValue({});
    await voiceSettingsUpdateView(req({ agent_id: AGENT, voice_prompt: 'p' }));
    expect(createElevenlabsAgent).toHaveBeenCalledWith(
      'Lily (Outbound)',
      'p',
      {},
      AGENT,
      null,
      {}
    );
  });

  it('400s without an agent_id and 404s for an agent that does not exist', async () => {
    expect((await voiceSettingsUpdateView(req({}))).status).toBe(400);
    (getAgent as jest.Mock).mockResolvedValue(null);
    const res = await voiceSettingsUpdateView(
      req({ agent_id: 'ghost', voice_prompt: 'p' })
    );
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ success: false, error: 'agent not found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// voice/reset/
// ─────────────────────────────────────────────────────────────────────────────

describe('voiceResetView', () => {
  it('restores the default prompt and re-syncs', async () => {
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt: 'edited',
      voice_prompt_default: 'original',
      voice_settings: { voice: 'adam' },
      voice_agent_assistant_id: 'el_1',
    });
    const res = await voiceResetView(req({ agent_id: AGENT }));
    expect(updateElevenlabsAgent).toHaveBeenCalledWith(
      'el_1',
      expect.any(String),
      'original',
      { voice: 'adam' },
      AGENT,
      null,
      {}
    );
    expect(res.json).toEqual({
      success: true,
      agent_id: AGENT,
      voice_agent_assistant_id: 'el_1',
      reset_to_default: true,
    });
    expect(storedAgent()).toEqual({
      voice_prompt: 'original',
      voice_agent_assistant_id: 'el_1',
    });
  });

  it('writes only the two fields it changes, leaving voice_settings alone', async () => {
    // Rewriting settings here would make a concurrent settings save lose.
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt_default: 'original',
      voice_settings: { voice: 'adam' },
      voice_agent_assistant_id: 'el_1',
    });
    await voiceResetView(req({ agent_id: AGENT }));
    expect(Object.keys(storedAgent()).sort()).toEqual([
      'voice_agent_assistant_id',
      'voice_prompt',
    ]);
  });

  it.each([[undefined], [''], ['   ']])(
    '400s with no usable default (%p) and syncs nothing',
    async (given) => {
      (getAgent as jest.Mock).mockResolvedValue({
        voice_prompt_default: given,
      });
      const res = await voiceResetView(req({ agent_id: AGENT }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        success: false,
        error: 'no voice_prompt_default saved to reset to',
      });
      expect(updateElevenlabsAgent).not.toHaveBeenCalled();
      expect(createElevenlabsAgent).not.toHaveBeenCalled();
    }
  );

  it('502s on a sync failure and leaves the doc untouched', async () => {
    (getAgent as jest.Mock).mockResolvedValue({
      voice_prompt_default: 'original',
      voice_agent_assistant_id: 'el_1',
    });
    (updateElevenlabsAgent as jest.Mock).mockResolvedValue(false);
    const res = await voiceResetView(req({ agent_id: AGENT }));
    expect(res.status).toBe(502);
    expect(storedAgent()).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// voice-agent/connect/
// ─────────────────────────────────────────────────────────────────────────────

describe('voiceConnectView', () => {
  it('attaches the outbound webhook and records the connection', async () => {
    const res = await voiceConnectView(
      req({ agent_id: AGENT, voice_agent_assistant_id: 'el_9' })
    );
    expect(attachOutboundPostCallWebhookToAgent).toHaveBeenCalledWith('el_9');
    expect(res.json).toEqual({
      success: true,
      agent_id: AGENT,
      voice_agent_assistant_id: 'el_9',
      post_call_webhook_synced: true,
    });
    expect(storedAgent()).toMatchObject({
      voice_agent_assistant_id: 'el_9',
      voice_ai_provider: 'elevenlabs',
      voice_agent_kind: 'outbound',
    });
  });

  it('accepts the legacy elevenlabs_agent_id field name', async () => {
    await voiceConnectView(req({ elevenlabs_agent_id: 'el_9' }));
    expect(attachOutboundPostCallWebhookToAgent).toHaveBeenCalledWith('el_9');
  });

  it('works with no agent_id at all, persisting nothing', async () => {
    // Attaching the webhook is useful on its own; the FE sometimes connects a voice agent before it has
    // an outbound agent to bind it to.
    const res = await voiceConnectView(
      req({ voice_agent_assistant_id: 'el_9' })
    );
    expect(res.json).toMatchObject({ success: true, agent_id: null });
    expect(storedAgent()).toEqual({});
  });

  it('400s without an assistant id', async () => {
    const res = await voiceConnectView(req({ agent_id: AGENT }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      success: false,
      error: 'voice_agent_assistant_id is required',
    });
    expect(attachOutboundPostCallWebhookToAgent).not.toHaveBeenCalled();
  });

  it('reports NULL — not false — for a non-ElevenLabs provider', async () => {
    // Nothing was attempted, which is different from an attach that was tried and failed.
    const res = await voiceConnectView(
      req({ voice_agent_assistant_id: 'v_9', voice_ai_provider: 'Vapi' })
    );
    expect(res.json).toMatchObject({ post_call_webhook_synced: null });
    expect(attachOutboundPostCallWebhookToAgent).not.toHaveBeenCalled();
  });

  it('lower-cases the provider before deciding, and before storing it', async () => {
    await voiceConnectView(
      req({
        agent_id: AGENT,
        voice_agent_assistant_id: 'el_9',
        voice_ai_provider: 'ElevenLabs',
      })
    );
    expect(attachOutboundPostCallWebhookToAgent).toHaveBeenCalledWith('el_9');
    expect(storedAgent().voice_ai_provider).toBe('elevenlabs');
  });

  it('still succeeds when persisting the connection fails — the webhook is the part that matters', async () => {
    const res = await voiceConnectView(
      req({ agent_id: '', voice_agent_assistant_id: 'el_9' })
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ post_call_webhook_synced: true });
  });

  it('reports a failed attach as false', async () => {
    (attachOutboundPostCallWebhookToAgent as jest.Mock).mockResolvedValue(
      false
    );
    const res = await voiceConnectView(
      req({ voice_agent_assistant_id: 'el_9' })
    );
    expect(res.json).toMatchObject({ post_call_webhook_synced: false });
  });
});
