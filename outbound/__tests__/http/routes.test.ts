/**
 * @jest-environment node
 *
 * The route table and the dispatcher.
 *
 * The paths themselves are asserted rather than trusted, because they are a published contract: the
 * provider webhook URLs are configured against them in ElevenLabs and SendGrid consoles, and the
 * unsubscribe links inside already-delivered mail point at `/unsub/` forever. A rename here silently
 * breaks mail that has already left the building.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../http/webhookViews', () => ({
  taskCronJobView: jest.fn(async () => ({ status: 200, json: { cron: true } })),
  initiateOutboundWebhookView: jest.fn(async () => ({ status: 200, json: {} })),
  elevenlabsOutboundWebhookView: jest.fn(async () => ({
    status: 200,
    json: {},
  })),
  conversationInitWebhookView: jest.fn(async () => ({ status: 200, json: {} })),
  emailInboundWebhookView: jest.fn(async () => ({ status: 200, json: {} })),
  sendgridEventWebhookView: jest.fn(async () => ({ status: 200, json: {} })),
  unsubscribeGetView: jest.fn(() => ({
    status: 200,
    body: 'page',
    contentType: 'text/html',
  })),
  unsubscribePostView: jest.fn(async () => ({ status: 200, body: 'done' })),
  callLlmOutboundView: jest.fn(async () => ({ status: 200, json: {} })),
}));

import { handleOutboundRequest, matchRoute, routes } from '../../http/routes';
import * as views from '../../http/webhookViews';

const url = (p: string) => `http://x/api/outbound/${p}`;

describe('the route table', () => {
  it('preserves every source path verbatim, trailing slashes included', () => {
    expect(routes.map((r) => r.path)).toEqual([
      'webhooks/sendgrid/',
      'unsub/',
      'webhook/initiate-outbound/',
      'webhook/email-inbound/',
      // The two ElevenLabs paths have NO trailing slash in the source. Kept, because these are
      // configured by hand in the provider console and a mismatch is a silent 404.
      'voice-agent/elevenlabs/outbound-webhook',
      'voice-agent/elevenlabs/conversation-init',
      'call-llm-outbound/',
      'task-cron-job/',
    ]);
  });

  it('keeps the source url names, which the FE reverses', () => {
    expect(routes.map((r) => r.name)).toEqual([
      'outbound_sendgrid_events',
      'outbound_unsubscribe',
      'outbound_initiate',
      'outbound_email_inbound',
      'outbound_elevenlabs_webhook',
      'outbound_elevenlabs_conversation_init',
      'outbound_call_llm',
      'outbound_task_cron_job',
    ]);
  });

  it('gives unsub/ a GET and a POST — and they are different views', () => {
    const unsub = routes.find((r) => r.name === 'outbound_unsubscribe');
    expect(Object.keys(unsub!.methods).sort()).toEqual(['GET', 'POST']);
    expect(unsub!.methods.GET).not.toBe(unsub!.methods.POST);
  });
});

describe('matchRoute', () => {
  it('matches with or without the trailing slash', () => {
    expect(matchRoute('task-cron-job/')?.route.name).toBe(
      'outbound_task_cron_job'
    );
    expect(matchRoute('task-cron-job')?.route.name).toBe(
      'outbound_task_cron_job'
    );
  });

  it('does not match a prefix or a longer path', () => {
    expect(matchRoute('webhook')).toBeNull();
    expect(matchRoute('task-cron-job/extra')).toBeNull();
  });

  it('returns null for a route whose view has not landed yet', () => {
    // Absent from the table on purpose — see the note in routes.ts on why nothing is stubbed.
    expect(matchRoute('campaigns/')).toBeNull();
    expect(matchRoute('hubspot/discovery/')).toBeNull();
  });

  it('captures a path parameter under the source parameter name', () => {
    const table = [
      { name: 'x', path: 'campaigns/:campaign_id/pause/', methods: {} },
    ];
    // Exercised through the real matcher by temporarily standing in a parameterised route, since none
    // of Phase 10a's own paths take a parameter.
    const saved = routes.splice(0, routes.length, ...table);
    try {
      const m = matchRoute('campaigns/camp_9/pause/');
      expect(m?.params).toEqual({ campaign_id: 'camp_9' });
    } finally {
      routes.splice(0, routes.length, ...saved);
    }
  });
});

describe('handleOutboundRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('dispatches to the matched view', async () => {
    const res = await handleOutboundRequest(
      new Request(url('task-cron-job/?window=5')),
      'task-cron-job/'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cron: true });
    expect(views.taskCronJobView).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown path with DRF’s own detail shape', async () => {
    const res = await handleOutboundRequest(new Request(url('nope/')), 'nope/');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Not found.' });
  });

  it('405s a known path under the wrong method, rather than 404ing it', async () => {
    // The distinction is the point: a 404 here would report "no such endpoint" for an endpoint that
    // exists, which is the harder failure to diagnose from outside.
    const res = await handleOutboundRequest(
      new Request(url('task-cron-job/'), { method: 'POST' }),
      'task-cron-job/'
    );
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ detail: 'Method "POST" not allowed.' });
  });

  it('turns a view exception into a 500 instead of letting it escape', async () => {
    (views.taskCronJobView as jest.Mock).mockRejectedValueOnce(
      new Error('boom')
    );
    const res = await handleOutboundRequest(
      new Request(url('task-cron-job/')),
      'task-cron-job/'
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false });
  });

  it('renders a text view through with its content type', async () => {
    const res = await handleOutboundRequest(
      new Request(url('unsub/?e=a@b.com&t=tok')),
      'unsub/'
    );
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('page');
  });
});
