/**
 * @jest-environment node
 *
 * The six webhook / cron / turn views.
 *
 * The handlers underneath are already covered by their own suites, so these tests assert what the VIEW
 * layer adds and nothing else — which is where the surprises are:
 *
 *  - Four endpoints answer **200 on failure**, each because its caller retries non-2xx.
 *  - `window` is parsed with Python's `int()` semantics, not `parseInt`.
 *  - `leads: []` is a 400, not a fallback to the single-lead form.
 *  - `call-llm-outbound` derives the **namespaced** outbound chat id from `phone_number`.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../services/cron', () => ({ processOutboundTasks: jest.fn() }));
jest.mock('../../services/enroll', () => ({ enrollContact: jest.fn() }));
jest.mock('../../services/voiceWebhooks', () => ({
  handlePostCallWebhook: jest.fn(),
  handleConversationInitWebhook: jest.fn(),
}));
jest.mock('../../services/emailWebhook', () => ({
  handleInboundEmail: jest.fn(),
}));
jest.mock('../../services/emailCompliance', () => ({
  handleSendgridEventWebhook: jest.fn(),
  handleUnsubscribeGet: jest.fn(),
  handleUnsubscribePost: jest.fn(),
}));
jest.mock('../../llm/turn', () => ({ runOutboundTurn: jest.fn() }));

import {
  callLlmOutboundView,
  conversationInitWebhookView,
  elevenlabsOutboundWebhookView,
  emailInboundWebhookView,
  initiateOutboundWebhookView,
  sendgridEventWebhookView,
  taskCronJobView,
  unsubscribeGetView,
  unsubscribePostView,
} from '../../http/webhookViews';
import { processOutboundTasks } from '../../services/cron';
import { enrollContact } from '../../services/enroll';
import {
  handleConversationInitWebhook,
  handlePostCallWebhook,
} from '../../services/voiceWebhooks';
import { handleInboundEmail } from '../../services/emailWebhook';
import {
  handleSendgridEventWebhook,
  handleUnsubscribeGet,
  handleUnsubscribePost,
} from '../../services/emailCompliance';
import { runOutboundTurn } from '../../llm/turn';
import type { OutboundRequest } from '../../http/types';

/** A request with everything defaulted, so each test states only what it is about. */
function req(over: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query: {},
    headers: {},
    body: {},
    bodyArray: null,
    rawBody: '',
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// task-cron-job
// ─────────────────────────────────────────────────────────────────────────────

describe('taskCronJobView', () => {
  it('defaults the window to 2 and returns the tick summary', async () => {
    (processOutboundTasks as jest.Mock).mockResolvedValue({
      success: true,
      processed: 3,
    });
    const res = await taskCronJobView(req({ method: 'GET' }));
    expect(processOutboundTasks).toHaveBeenCalledWith({ window: 2 });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, processed: 3 });
  });

  it('honours a valid window', async () => {
    (processOutboundTasks as jest.Mock).mockResolvedValue({});
    await taskCronJobView(req({ method: 'GET', query: { window: '15' } }));
    expect(processOutboundTasks).toHaveBeenCalledWith({ window: 15 });
  });

  it.each([['2.5'], ['abc'], ['2abc'], ['']])(
    'falls back to 2 for window=%p, as Python int() does',
    async (raw) => {
      // `parseInt` would answer 2 for "2.5"/"2abc" by truncation — right answer, wrong reason — and
      // NaN for "abc", which would then flow into the query as a NaN window.
      (processOutboundTasks as jest.Mock).mockResolvedValue({});
      await taskCronJobView(req({ method: 'GET', query: { window: raw } }));
      expect(processOutboundTasks).toHaveBeenCalledWith({ window: 2 });
    }
  );

  it('answers 200 with success:false when the tick throws', async () => {
    // A scheduler retries non-2xx, and the tick has already fired real touches by the time it faults.
    (processOutboundTasks as jest.Mock).mockRejectedValue(
      new Error('firestore down')
    );
    const res = await taskCronJobView(req({ method: 'GET' }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: false,
      error: 'Error: firestore down',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// initiate-outbound
// ─────────────────────────────────────────────────────────────────────────────

describe('initiateOutboundWebhookView', () => {
  it('enrolls a leads[] batch and reports per-lead results', async () => {
    (enrollContact as jest.Mock)
      .mockResolvedValueOnce({ success: true, chat_id: 'c1' })
      .mockResolvedValueOnce({ success: false, error: 'no phone' });
    const res = await initiateOutboundWebhookView(
      req({ body: { leads: [{ contact_information: {} }, {}] } })
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: true,
      processed: 2,
      succeeded: 1,
      results: [
        { success: true, chat_id: 'c1' },
        { success: false, error: 'no phone' },
      ],
    });
  });

  it('accepts a single lead posted as the whole body', async () => {
    (enrollContact as jest.Mock).mockResolvedValue({ success: true });
    const body = { contact_information: { phone: '+13035551212' } };
    await initiateOutboundWebhookView(req({ body }));
    expect(enrollContact).toHaveBeenCalledWith(body);
  });

  it('400s an explicit empty leads[] rather than falling back to the single-lead form', async () => {
    // `leads is None` in the source, not falsiness: `leads: []` is a caller saying "enroll these zero
    // contacts", and answering 200/success for that would hide an empty import.
    const res = await initiateOutboundWebhookView(
      req({ body: { leads: [], contact_information: { phone: '+1303' } } })
    );
    expect(res.status).toBe(400);
    expect(enrollContact).not.toHaveBeenCalled();
  });

  it('400s a body with neither leads nor contact_information', async () => {
    const res = await initiateOutboundWebhookView(req({ body: { foo: 1 } }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      success: false,
      error: 'leads array is required',
    });
  });

  it('lets one throwing lead fail without failing the batch', async () => {
    (enrollContact as jest.Mock)
      .mockRejectedValueOnce(new Error('bad zip'))
      .mockResolvedValueOnce({ success: true });
    const res = await initiateOutboundWebhookView(
      req({ body: { leads: [{}, {}] } })
    );
    expect(res.json).toMatchObject({
      success: true,
      processed: 2,
      succeeded: 1,
    });
    expect((res.json as { results: unknown[] }).results[0]).toEqual({
      success: false,
      error: 'Error: bad zip',
    });
  });

  it('reports success:false when every lead failed', async () => {
    (enrollContact as jest.Mock).mockResolvedValue({ success: false });
    const res = await initiateOutboundWebhookView(
      req({ body: { leads: [{}, {}] } })
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: false, succeeded: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the two ElevenLabs webhooks
// ─────────────────────────────────────────────────────────────────────────────

describe('elevenlabsOutboundWebhookView', () => {
  it('passes the signature header and the RAW body to the verifier', async () => {
    (handlePostCallWebhook as jest.Mock).mockResolvedValue({ status: 'ok' });
    const rawBody = '{"conversation_id":"conv_1"}';
    await elevenlabsOutboundWebhookView(
      req({
        headers: { 'elevenlabs-signature': 't=1,v0=deadbeef' },
        body: { conversation_id: 'conv_1' },
        rawBody,
      })
    );
    expect(handlePostCallWebhook).toHaveBeenCalledWith(
      { conversation_id: 'conv_1' },
      { signature: 't=1,v0=deadbeef', rawBody }
    );
  });

  it('answers 200 even for a refused signature', async () => {
    // The provider retries non-2xx, and a retry cannot make a bad signature good.
    (handlePostCallWebhook as jest.Mock).mockResolvedValue({
      status: 'error',
      message: 'invalid signature',
    });
    const res = await elevenlabsOutboundWebhookView(req());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'error', message: 'invalid signature' });
  });
});

describe('conversationInitWebhookView', () => {
  it('returns the handler’s dynamic variables', async () => {
    (handleConversationInitWebhook as jest.Mock).mockResolvedValue({
      dynamic_variables: { first_name: 'Jane' },
    });
    const res = await conversationInitWebhookView(req());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ dynamic_variables: { first_name: 'Jane' } });
  });

  it('answers empty variables — never an error — when the handler throws', async () => {
    // A pre-call hook that errors leaves the provider without the payload it is waiting on, and the
    // call does not connect. Answering without context beats not answering the phone.
    (handleConversationInitWebhook as jest.Mock).mockRejectedValue(
      new Error('firestore down')
    );
    const res = await conversationInitWebhookView(req());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ dynamic_variables: {} });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// email-inbound
// ─────────────────────────────────────────────────────────────────────────────

describe('emailInboundWebhookView', () => {
  it('forwards the agent_id query param and strips status out of the body', async () => {
    (handleInboundEmail as jest.Mock).mockResolvedValue({
      success: true,
      status: 200,
      chat_id: 'c1',
    });
    const res = await emailInboundWebhookView(
      req({ body: { from: 'a@b.com' }, query: { agent_id: 'agent_7' } })
    );
    expect(handleInboundEmail).toHaveBeenCalledWith(
      { from: 'a@b.com' },
      'agent_7'
    );
    expect(res.status).toBe(200);
    // `status` is the HTTP code, not a body field — the source passes it to Response(status=...).
    expect(res.json).toEqual({ success: true, chat_id: 'c1' });
  });

  it('passes null when no agent_id is given', async () => {
    (handleInboundEmail as jest.Mock).mockResolvedValue({
      success: true,
      status: 200,
    });
    await emailInboundWebhookView(req());
    expect(handleInboundEmail).toHaveBeenCalledWith({}, null);
  });

  it('surfaces the handler’s 400 for an unparseable sender', async () => {
    (handleInboundEmail as jest.Mock).mockResolvedValue({
      success: false,
      status: 400,
      error: 'could not parse sender',
    });
    const res = await emailInboundWebhookView(req());
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SendGrid events + unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

describe('sendgridEventWebhookView', () => {
  it('passes the array body, both signature headers, and the raw bytes', async () => {
    (handleSendgridEventWebhook as jest.Mock).mockResolvedValue({
      success: true,
      status: 200,
      processed: 1,
    });
    const events = [{ event: 'bounce', email: 'a@b.com' }];
    const res = await sendgridEventWebhookView(
      req({
        bodyArray: events,
        rawBody: JSON.stringify(events),
        headers: {
          'x-twilio-email-event-webhook-signature': 'sig',
          'x-twilio-email-event-webhook-timestamp': '1700000000',
        },
      })
    );
    expect(handleSendgridEventWebhook).toHaveBeenCalledWith(events, {
      signature: 'sig',
      timestamp: '1700000000',
      rawBody: JSON.stringify(events),
    });
    expect(res.json).toEqual({ success: true, processed: 1 });
  });

  it('surfaces the 401 — the one webhook here that fails CLOSED', async () => {
    (handleSendgridEventWebhook as jest.Mock).mockResolvedValue({
      success: false,
      status: 401,
      error: 'invalid signature',
    });
    const res = await sendgridEventWebhookView(req());
    expect(res.status).toBe(401);
  });

  it('passes null for bodyArray when the body was not an array, so the handler re-parses raw', async () => {
    (handleSendgridEventWebhook as jest.Mock).mockResolvedValue({
      success: true,
      status: 200,
    });
    await sendgridEventWebhookView(req({ rawBody: '[{"event":"dropped"}]' }));
    expect(handleSendgridEventWebhook).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ rawBody: '[{"event":"dropped"}]' })
    );
  });
});

describe('the unsubscribe views', () => {
  it('reads the address and token from the QUERY string on GET', async () => {
    (handleUnsubscribeGet as jest.Mock).mockReturnValue({
      status: 200,
      body: '<page>',
      contentType: 'text/html',
    });
    const res = unsubscribeGetView(
      req({ method: 'GET', query: { e: 'a@b.com', t: 'tok' } })
    );
    expect(handleUnsubscribeGet).toHaveBeenCalledWith('a@b.com', 'tok');
    expect(res).toEqual({
      status: 200,
      body: '<page>',
      contentType: 'text/html',
    });
  });

  it('reads them from the QUERY string on POST too, which is what makes one-click work', async () => {
    // RFC 8058 one-click POSTs the link itself with an `List-Unsubscribe=One-Click` body and no
    // session. Reading the address from the body would break it.
    (handleUnsubscribePost as jest.Mock).mockResolvedValue({
      status: 200,
      body: 'done',
      contentType: 'text/plain',
    });
    await unsubscribePostView(
      req({
        query: { e: 'a@b.com', t: 'tok' },
        body: { 'List-Unsubscribe': 'One-Click' },
      })
    );
    expect(handleUnsubscribePost).toHaveBeenCalledWith('a@b.com', 'tok');
  });

  it('renders the 400 page for a bad token without suppressing', async () => {
    (handleUnsubscribeGet as jest.Mock).mockReturnValue({
      status: 400,
      body: 'Invalid unsubscribe link.',
      contentType: 'text/plain',
    });
    const res = unsubscribeGetView(
      req({ method: 'GET', query: { e: 'a@b.com' } })
    );
    expect(res.status).toBe(400);
    expect(handleUnsubscribePost).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// call-llm-outbound
// ─────────────────────────────────────────────────────────────────────────────

describe('callLlmOutboundView', () => {
  it('derives the NAMESPACED outbound chat id from phone_number', async () => {
    // Without the `outbound__` prefix this would mint a fresh inbound-shaped chat for a prospect who
    // already has one, and the FE's turn would run against an empty history.
    (runOutboundTurn as jest.Mock).mockResolvedValue({
      status: 200,
      entries: [],
    });
    await callLlmOutboundView(
      req({
        body: {
          message: 'hi',
          agent_id: 'agent_1',
          phone_number: '+13035551212',
        },
      })
    );
    expect(runOutboundTurn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'outbound__agent_1__13035551212' })
    );
  });

  it('prefers an explicit chat_id — how the cron and email webhook invoke it', async () => {
    (runOutboundTurn as jest.Mock).mockResolvedValue({ status: 200 });
    await callLlmOutboundView(
      req({
        body: {
          message: '@ai reply to that',
          agent_id: 'agent_1',
          chat_id: 'outbound__agent_1__existing',
          phone_number: '+13035551212',
        },
      })
    );
    expect(runOutboundTurn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'outbound__agent_1__existing' })
    );
  });

  it('defaults provider to unipile and the trigger source to human', async () => {
    // Only a HUMAN trigger is authoritative on timing; an HTTP request is one by definition.
    (runOutboundTurn as jest.Mock).mockResolvedValue({ status: 200 });
    await callLlmOutboundView(
      req({ body: { message: 'hi', agent_id: 'a', chat_id: 'c' } })
    );
    expect(runOutboundTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'unipile',
        adminTriggerSource: 'human',
      })
    );
  });

  it('400s on missing fields, naming phone_number OR chat_id as one requirement', async () => {
    const res = await callLlmOutboundView(req({ body: { agent_id: 'a' } }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: 'Missing required fields: message, phone_number or chat_id',
    });
    expect(runOutboundTurn).not.toHaveBeenCalled();
  });

  it('passes the 202 through — a queued message is not an error', async () => {
    (runOutboundTurn as jest.Mock).mockResolvedValue({
      status: 202,
      queued: true,
    });
    const res = await callLlmOutboundView(
      req({ body: { message: 'hi', agent_id: 'a', chat_id: 'c' } })
    );
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ queued: true });
  });
});
