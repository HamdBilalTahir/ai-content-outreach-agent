import { NextResponse } from 'next/server';

import { buildDealTimeline } from '../../../../../../outbound/services/dealTimeline';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

/**
 * The deal timeline, for the browser.
 *
 * ## Why this route has to exist, when the other pages need no proxy at all
 *
 * U1 established that the admin panel's `/api/outbound/*` proxies need no porting: the backend's catch-all
 * serves the same paths, so the UI's URLs already resolve. **That generalization fails here, and this is
 * the exception.**
 *
 * The backend's `dealTimelineView` is behind `requireApiKey` — faithfully, because the Django view it was
 * ported from is `require_api_key`. A browser fetch carries no API key, so routing this page's main data
 * call through the catch-all returns `401 API key is required`. The admin panel hits the same wall and
 * solves it with a proxy whose only job is to inject `X-API-Key` server-side; its own comment says so.
 *
 * ## Why it calls the builder directly rather than re-injecting a key
 *
 * The API-key guard authenticates **service-to-service** callers — a cron route, a script. Here the caller
 * is an authenticated browser session, which is a stronger check, not a weaker one. Synthesizing a request
 * with a key attached in order to satisfy a guard in the same process would be theatre: it would prove only
 * that this file can read its own environment variable.
 *
 * So the session is the authorization and `buildDealTimeline` is called directly.
 *
 * ## What that costs, stated rather than glossed
 *
 * This static route SHADOWS the catch-all for this path — including the trailing-slash form, which Next
 * normalizes here. So `dealTimelineView`, with its API-key guard, is **no longer reachable over HTTP**. It
 * remains correct and covered by its own tests, but nothing can call it through the mount any more.
 *
 * That is acceptable because no service caller exists: in the source these are two different URLs (the Next
 * proxy at `/api/...`, Django at `/outbound_agent/...`), and here they collapse onto one. Inventing a second
 * path to preserve an unused surface would be speculative. Worth knowing if a cron or script ever needs the
 * key-guarded view — it needs a path, and this one is taken.
 *
 * The parameter validation mirrors the source proxy's, including its 400 before any work is done.
 */
export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;
  const agentId = sp.get('agent_id');
  const dealId = sp.get('deal_id');
  const chatId = sp.get('chat_id');

  if (!agentId || (!dealId && !chatId)) {
    return NextResponse.json(
      { error: 'agent_id and one of deal_id / chat_id are required' },
      { status: 400 }
    );
  }

  try {
    const result = await buildDealTimeline({
      agentId,
      // `deal_id` wins when both are present, matching the source proxy.
      dealId: dealId || null,
      chatId: dealId ? null : chatId,
      recordType: sp.get('record_type') || 'Real',
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[outbound/analytics/deal-timeline] GET error:', message);
    return NextResponse.json({ success: false, error: message });
  }
}
