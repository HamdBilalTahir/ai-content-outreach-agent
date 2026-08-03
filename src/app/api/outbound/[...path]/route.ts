/**
 * The outbound app's HTTP mount — the Next.js equivalent of Django's
 * `path("outbound_agent/", include("outbound_agent.urls"))`.
 *
 * Everything this file does is hand the request to the ported route table. The table, the views, and
 * their tests all live under `outbound/` and know nothing about Next.js; see `outbound/http/routes.ts`.
 */

import { handleOutboundRequest } from '../../../../../outbound/http/routes';

type Ctx = { params: Promise<{ path: string[] }> };

async function serve(request: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return handleOutboundRequest(request, (path ?? []).join('/'));
}

export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;

// Several of these routes place calls, send mail, and run a full LLM turn; the default serverless
// timeout is not enough for the cron tick in particular.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
