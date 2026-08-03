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
jest.mock('../../http/voiceViews', () => ({
  voiceConnectView: jest.fn(async () => ({ status: 200, json: {} })),
  voiceSettingsUpdateView: jest.fn(async () => ({ status: 200, json: {} })),
  voiceResetView: jest.fn(async () => ({ status: 200, json: {} })),
}));
jest.mock('../../http/dncViews', () => ({
  dncAreaCodesListView: jest.fn(async () => ({ status: 200, json: {} })),
  dncAreaCodesUpsertView: jest.fn(async () => ({ status: 200, json: {} })),
  dncAreaCodeDeleteView: jest.fn(async () => ({ status: 200, json: {} })),
}));
jest.mock('../../http/hubspotViews', () => ({
  hubspotDiscoveryView: jest.fn(async () => ({ status: 200, json: {} })),
  hubspotAddPropertyOptionView: jest.fn(async () => ({
    status: 200,
    json: {},
  })),
  hubspotDeleteRecordsView: jest.fn(async () => ({ status: 200, json: {} })),
  hubspotListsView: jest.fn(async () => ({ status: 200, json: {} })),
  hubspotListMembersView: jest.fn(async () => ({ status: 200, json: {} })),
  hubspotContactPropertiesView: jest.fn(async () => ({
    status: 200,
    json: {},
  })),
  hubspotSearchContactsView: jest.fn(async () => ({ status: 200, json: {} })),
}));
jest.mock('../../http/campaignViews', () => ({
  createCampaignView: jest.fn(async () => ({ status: 201, json: {} })),
  listCampaignsView: jest.fn(async () => ({ status: 200, json: {} })),
  campaignDetailView: jest.fn(async () => ({ status: 200, json: {} })),
  campaignActionView: jest.fn(async () => ({ status: 200, json: {} })),
  campaignPauseView: jest.fn(async () => ({ status: 200, json: {} })),
  campaignResumeView: jest.fn(async () => ({ status: 200, json: {} })),
  campaignStopView: jest.fn(async () => ({ status: 200, json: {} })),
  campaignAddRecordsView: jest.fn(async () => ({ status: 200, json: {} })),
  chatPauseView: jest.fn(async () => ({ status: 200, json: {} })),
  chatResumeView: jest.fn(async () => ({ status: 200, json: {} })),
  chatsPauseView: jest.fn(async () => ({ status: 200, json: {} })),
  chatsResumeView: jest.fn(async () => ({ status: 200, json: {} })),
}));

import { handleOutboundRequest, matchRoute, routes } from '../../http/routes';
import * as views from '../../http/webhookViews';
import * as campaignViews from '../../http/campaignViews';

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
      'voice-agent/connect/',
      'voice/update/',
      'voice/reset/',
      'call-llm-outbound/',
      'task-cron-job/',
      'hubspot/discovery/',
      'hubspot/property-option/',
      'hubspot/delete-records/',
      'hubspot/lists/',
      'hubspot/list-members/',
      'hubspot/contact-properties/',
      'hubspot/search-contacts/',
      'campaigns/',
      'campaigns/:campaign_id/pause/',
      'campaigns/:campaign_id/resume/',
      'campaigns/:campaign_id/stop/',
      'campaigns/:campaign_id/add-records/',
      'chats/pause/',
      'chats/resume/',
      'chats/:chat_id/pause/',
      'chats/:chat_id/resume/',
      // Declared after every campaign sub-action, as the source declares it.
      'campaigns/:campaign_id/',
      'dnc/area-codes/',
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
      'outbound_voice_connect',
      'outbound_voice_update',
      'outbound_voice_reset',
      'outbound_call_llm',
      'outbound_task_cron_job',
      'outbound_hubspot_discovery',
      'outbound_hubspot_add_property_option',
      'outbound_hubspot_delete_records',
      'outbound_hubspot_lists',
      'outbound_hubspot_list_members',
      'outbound_hubspot_contact_properties',
      'outbound_hubspot_search_contacts',
      'outbound_campaigns',
      'outbound_campaign_pause',
      'outbound_campaign_resume',
      'outbound_campaign_stop',
      'outbound_campaign_add_records',
      'outbound_chats_pause',
      'outbound_chats_resume',
      'outbound_chat_pause',
      'outbound_chat_resume',
      'outbound_campaign_detail',
      'outbound_dnc_area_codes',
    ]);
  });

  it('gives unsub/ a GET and a POST — and they are different views', () => {
    const unsub = routes.find((r) => r.name === 'outbound_unsubscribe');
    expect(Object.keys(unsub!.methods).sort()).toEqual(['GET', 'POST']);
    expect(unsub!.methods.GET).not.toBe(unsub!.methods.POST);
  });

  it('has no duplicate name and no duplicate (path, method) pair', () => {
    // A duplicate path/method is a route that can never be reached — first-match resolution means the
    // second one is dead, silently, and only shows up as "that endpoint does nothing".
    expect(new Set(routes.map((r) => r.name)).size).toBe(routes.length);
    const pairs = routes.flatMap((r) =>
      Object.keys(r.methods).map((m) => `${m} ${r.path}`)
    );
    expect(new Set(pairs).size).toBe(pairs.length);
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
    expect(matchRoute('analytics/deal-funnel/')).toBeNull();
    expect(matchRoute('analytics/run-deal-attribution/')).toBeNull();
  });

  it('gives the DNC registry all three of its methods', () => {
    const dnc = matchRoute('dnc/area-codes/')!.route;
    expect(Object.keys(dnc.methods).sort()).toEqual(['DELETE', 'GET', 'POST']);
  });

  it('captures a path parameter under the source parameter name', () => {
    expect(matchRoute('campaigns/camp_9/pause/')?.params).toEqual({
      campaign_id: 'camp_9',
    });
    expect(matchRoute('chats/outbound__a__1303/resume/')?.params).toEqual({
      chat_id: 'outbound__a__1303',
    });
  });

  it('prefers the literal bulk route over the parameterised single route', () => {
    // `chats/pause/` is two segments and `chats/:chat_id/pause/` is three, so these cannot collide
    // today. Asserted anyway: the declaration order is the source's, and it is what would decide the
    // question if a two-segment `chats/:chat_id/` route ever landed.
    expect(matchRoute('chats/pause/')?.route.name).toBe('outbound_chats_pause');
    expect(matchRoute('chats/resume/')?.route.name).toBe(
      'outbound_chats_resume'
    );
  });

  it('resolves the campaign detail route without swallowing the sub-actions', () => {
    // The detail route is declared LAST for exactly this reason.
    expect(matchRoute('campaigns/c1/')?.route.name).toBe(
      'outbound_campaign_detail'
    );
    expect(matchRoute('campaigns/c1/stop/')?.route.name).toBe(
      'outbound_campaign_stop'
    );
    expect(matchRoute('campaigns/c1/add-records/')?.route.name).toBe(
      'outbound_campaign_add_records'
    );
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

  it('hands the captured path parameter to the view', async () => {
    await handleOutboundRequest(
      new Request(url('campaigns/camp_3/stop/'), { method: 'POST' }),
      'campaigns/camp_3/stop/'
    );
    expect(campaignViews.campaignStopView).toHaveBeenCalledWith(
      expect.objectContaining({ params: { campaign_id: 'camp_3' } })
    );
  });

  it('routes GET and POST on campaigns/ to different views', async () => {
    await handleOutboundRequest(new Request(url('campaigns/')), 'campaigns/');
    expect(campaignViews.listCampaignsView).toHaveBeenCalledTimes(1);
    expect(campaignViews.createCampaignView).not.toHaveBeenCalled();

    const res = await handleOutboundRequest(
      new Request(url('campaigns/'), { method: 'POST' }),
      'campaigns/'
    );
    expect(campaignViews.createCampaignView).toHaveBeenCalledTimes(1);
    // The 201 survives the adapter — the FE distinguishes "created" from a status read.
    expect(res.status).toBe(201);
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
