/**
 * The route table — the port of `urls.py` and `views/__init__.py`.
 *
 * Django mounts the outbound app under `/outbound_agent/`; this port mounts it under `/api/outbound/`,
 * and every path below it is preserved **verbatim**, trailing slashes included. That matters more than
 * it looks: the FE reverses these paths by name, the provider webhook URLs are configured against them
 * in ElevenLabs and SendGrid, and the unsubscribe links inside already-delivered mail point at
 * `/unsub/?e=…&t=…` forever. A path is a published contract; only the mount prefix changes.
 *
 * The source's `name=` values are kept for the same reason — they are the identifiers the FE and the
 * `reverse()` calls use, so they stay findable by grep across both codebases.
 *
 * ## One catch-all adapter, not thirty route files
 *
 * `urls.py` is a first-match ordered list, and reproducing it as a list keeps that ordering meaningful
 * and testable. Next.js file-based routing would scatter the same information across thirty
 * directories, where the ordering is implicit in the framework's own precedence rules rather than in
 * anything a reader can check. `matchRoute` is first-match in declaration order, exactly like Django,
 * so a future ambiguity resolves the same way in both.
 *
 * ## The table lists only the routes whose views exist
 *
 * Consistent with the port's rule against stubs. A path absent from the table 404s, which is the
 * honest answer; a path present but wired to a placeholder would answer 200 with a lie. The remaining
 * entries land with their views in the rest of Phase 10 — see `PORT-PLAN.md`.
 */

import {
  campaignActionView,
  campaignAddRecordsView,
  campaignDetailView,
  campaignPauseView,
  campaignResumeView,
  campaignStopView,
  chatPauseView,
  chatResumeView,
  chatsPauseView,
  chatsResumeView,
  createCampaignView,
  listCampaignsView,
} from './campaignViews';
import {
  hubspotAddPropertyOptionView,
  hubspotContactPropertiesView,
  hubspotDeleteRecordsView,
  hubspotDiscoveryView,
  hubspotListMembersView,
  hubspotListsView,
  hubspotSearchContactsView,
} from './hubspotViews';
import { dealFunnelView } from './analyticsViews';
import {
  dncAreaCodeDeleteView,
  dncAreaCodesListView,
  dncAreaCodesUpsertView,
} from './dncViews';
import {
  voiceConnectView,
  voiceResetView,
  voiceSettingsUpdateView,
} from './voiceViews';
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
} from './webhookViews';
import { fromWebRequest, toWebResponse } from './request';
import { json } from './types';
import type { HttpMethod, OutboundView } from './types';

export interface Route {
  /** The source's `name=`, verbatim. See the module note. */
  name: string;
  /** The path relative to the mount. `:param` captures one segment, under the source's own name. */
  path: string;
  methods: Partial<Record<HttpMethod, OutboundView>>;
}

/**
 * Every route the outbound app serves, in `urls.py` order.
 *
 * The comments are the source's, kept because they record why several of these behave unusually — the
 * GET/POST asymmetry on `unsub/`, and the conversation-init hook being an INBOUND concern living in the
 * outbound app.
 */
export const routes: Route[] = [
  // SendGrid event webhook (bounce/dropped/spamreport/unsubscribe) — signature-verified; feeds the
  // suppression store + send_log status + nudge cancellation.
  {
    name: 'outbound_sendgrid_events',
    path: 'webhooks/sendgrid/',
    methods: { POST: sendgridEventWebhookView },
  },
  // Unsubscribe: GET = confirmation page (never suppresses — link scanners follow GETs);
  // POST = HMAC-validated one-click/form suppression (RFC 8058).
  {
    name: 'outbound_unsubscribe',
    path: 'unsub/',
    methods: { GET: unsubscribeGetView, POST: unsubscribePostView },
  },
  {
    name: 'outbound_initiate',
    path: 'webhook/initiate-outbound/',
    methods: { POST: initiateOutboundWebhookView },
  },
  {
    name: 'outbound_email_inbound',
    path: 'webhook/email-inbound/',
    methods: { POST: emailInboundWebhookView },
  },
  {
    name: 'outbound_elevenlabs_webhook',
    path: 'voice-agent/elevenlabs/outbound-webhook',
    methods: { POST: elevenlabsOutboundWebhookView },
  },
  // PRE-CALL (conversation-init) webhook — ElevenLabs fetches per-caller context on INBOUND calls.
  {
    name: 'outbound_elevenlabs_conversation_init',
    path: 'voice-agent/elevenlabs/conversation-init',
    methods: { POST: conversationInitWebhookView },
  },
  // FE-callable: connect an ElevenLabs voice agent to outbound + attach the outbound post-call webhook.
  {
    name: 'outbound_voice_connect',
    path: 'voice-agent/connect/',
    methods: { POST: voiceConnectView },
  },
  // Outbound voice PROMPT management: store the ElevenLabs prompt on the agent doc + sync, and reset it
  // to the saved default. (Cloned inbound voice stack; skills are never injected into calls.)
  {
    name: 'outbound_voice_update',
    path: 'voice/update/',
    methods: { POST: voiceSettingsUpdateView },
  },
  {
    name: 'outbound_voice_reset',
    path: 'voice/reset/',
    methods: { POST: voiceResetView },
  },
  // FE-consumable outbound LLM endpoint (also reused internally by the cron + email webhook).
  {
    name: 'outbound_call_llm',
    path: 'call-llm-outbound/',
    methods: { POST: callLlmOutboundView },
  },
  // Outbound task cron — scheduled externally (Vercel).
  {
    name: 'outbound_task_cron_job',
    path: 'task-cron-job/',
    methods: { GET: taskCronJobView },
  },
  // FE HubSpot v2 config setup: discovery (dropdowns) + add an option to a managed contact property.
  {
    name: 'outbound_hubspot_discovery',
    path: 'hubspot/discovery/',
    methods: { POST: hubspotDiscoveryView },
  },
  {
    name: 'outbound_hubspot_add_property_option',
    path: 'hubspot/property-option/',
    methods: { POST: hubspotAddPropertyOptionView },
  },
  // FE E2E cleanup: delete a Test contact/deal (hard-gated to record_type == "Test").
  {
    name: 'outbound_hubspot_delete_records',
    path: 'hubspot/delete-records/',
    methods: { POST: hubspotDeleteRecordsView },
  },
  // FE campaign audience selection — the backend proxies HubSpot because the token lives here.
  {
    name: 'outbound_hubspot_lists',
    path: 'hubspot/lists/',
    methods: { POST: hubspotListsView },
  },
  {
    name: 'outbound_hubspot_list_members',
    path: 'hubspot/list-members/',
    methods: { POST: hubspotListMembersView },
  },
  {
    name: 'outbound_hubspot_contact_properties',
    path: 'hubspot/contact-properties/',
    methods: { POST: hubspotContactPropertiesView },
  },
  {
    name: 'outbound_hubspot_search_contacts',
    path: 'hubspot/search-contacts/',
    methods: { POST: hubspotSearchContactsView },
  },
  // Campaigns — the FE fires one call; the backend enrolls + paces. GET lists, POST fires.
  {
    name: 'outbound_campaigns',
    path: 'campaigns/',
    methods: { GET: listCampaignsView, POST: createCampaignView },
  },
  {
    name: 'outbound_campaign_pause',
    path: 'campaigns/:campaign_id/pause/',
    methods: { POST: campaignPauseView },
  },
  {
    name: 'outbound_campaign_resume',
    path: 'campaigns/:campaign_id/resume/',
    methods: { POST: campaignResumeView },
  },
  {
    name: 'outbound_campaign_stop',
    path: 'campaigns/:campaign_id/stop/',
    methods: { POST: campaignStopView },
  },
  {
    name: 'outbound_campaign_add_records',
    path: 'campaigns/:campaign_id/add-records/',
    methods: { POST: campaignAddRecordsView },
  },
  // Chat pause / resume — manual single + bulk (status="paused"; freezes tasks, reversible).
  //
  // The BULK routes come first, exactly as they do in `urls.py`. They are two segments to the single
  // routes' three, so nothing currently collides — but the ordering is the source's and is what would
  // keep `chats/pause/` from being read as a chat whose id is "pause" if a two-segment
  // `chats/:chat_id/` route ever landed.
  {
    name: 'outbound_chats_pause',
    path: 'chats/pause/',
    methods: { POST: chatsPauseView },
  },
  {
    name: 'outbound_chats_resume',
    path: 'chats/resume/',
    methods: { POST: chatsResumeView },
  },
  {
    name: 'outbound_chat_pause',
    path: 'chats/:chat_id/pause/',
    methods: { POST: chatPauseView },
  },
  {
    name: 'outbound_chat_resume',
    path: 'chats/:chat_id/resume/',
    methods: { POST: chatResumeView },
  },
  // Declared AFTER the sub-actions, as the source declares it. Three segments versus two means no
  // ambiguity today; keeping the order means there is none tomorrow either.
  {
    name: 'outbound_campaign_detail',
    path: 'campaigns/:campaign_id/',
    methods: { GET: campaignDetailView, POST: campaignActionView },
  },
  // Dashboard funnel — deal counts per pipeline stage (filters: campaign, source, date, record_type).
  {
    name: 'outbound_deal_funnel',
    path: 'analytics/deal-funnel/',
    methods: { GET: dealFunnelView },
  },
  // FE admin: the FTC DNC area-code registry (which area codes our SAN can scrub) — GET/POST/DELETE.
  {
    name: 'outbound_dnc_area_codes',
    path: 'dnc/area-codes/',
    methods: {
      GET: dncAreaCodesListView,
      POST: dncAreaCodesUpsertView,
      DELETE: dncAreaCodeDeleteView,
    },
  },
];

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/** Split a path into segments, dropping the empty ones a trailing slash produces. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/**
 * First match in declaration order, as Django resolves `urlpatterns`.
 *
 * The trailing slash is not part of the comparison: both sides are reduced to segments, so
 * `task-cron-job/` and `task-cron-job` reach the same view. Django would 301 the slashless form via
 * `APPEND_SLASH` and the client would follow it to the same place — one hop fewer here, same outcome.
 */
export function matchRoute(path: string): RouteMatch | null {
  const wanted = segmentsOf(path);
  for (const route of routes) {
    const pattern = segmentsOf(route.path);
    if (pattern.length !== wanted.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i += 1) {
      const p = pattern[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = wanted[i];
      } else if (p !== wanted[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * Serve one request against the table.
 *
 * The two failure shapes are DRF's own, so a client that already handles them keeps working: `404
 * {"detail": "Not found."}` for an unmatched path, and `405 {"detail": "Method \"X\" not allowed."}`
 * for a path that exists under a different method. The 405 distinction is worth keeping — collapsing
 * both into a 404 would turn "you used GET on a POST endpoint" into "this endpoint does not exist",
 * which is the harder of the two to debug from the outside.
 *
 * An exception escaping a view becomes a 500 rather than a runtime stack trace, because several callers
 * here are third-party webhooks whose retry behaviour is driven by the status code alone.
 */
export async function handleOutboundRequest(
  request: Request,
  path: string
): Promise<Response> {
  const match = matchRoute(path);
  if (!match) {
    return toWebResponse(json({ detail: 'Not found.' }, 404));
  }

  const method = request.method.toUpperCase() as HttpMethod;
  const view = match.route.methods[method];
  if (!view) {
    return toWebResponse(
      json({ detail: `Method "${method}" not allowed.` }, 405)
    );
  }

  try {
    const outboundRequest = await fromWebRequest(request, match.params);
    return toWebResponse(await view(outboundRequest));
  } catch (e) {
    console.error(`[OB_HTTP] ${match.route.name} raised: ${e}`);
    return toWebResponse(json({ success: false, error: String(e) }, 500));
  }
}
