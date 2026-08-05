import { NextResponse } from 'next/server';

import { db } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

/**
 * The agent picker's list.
 *
 * Ported from the admin panel's `/api/agents/list`, with its company scoping REMOVED. The source filters
 * `where('company_id', 'in', [...])` and 400s without a `companyId`, because that panel is multi-tenant —
 * its campaigns page resolves the id by calling a Django `campaign_maker` endpoint with a `next-auth`
 * backend token. None of that exists here: this repo has no companies, no `campaign_maker`, and no
 * `next-auth`. Keeping the parameter would have meant inventing a tenant id to satisfy a filter that
 * scopes nothing.
 *
 * A `companyId` query param is therefore accepted and IGNORED rather than rejected, so the ported client
 * code that appends it needs no edit.
 *
 * Reads through the Admin SDK and projects only what the picker renders — the agent documents carry large
 * prompt and persona blobs that would otherwise be shipped to the browser on every page load.
 */
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const snap = await db
      .collection('agents')
      .select('name', 'agent_name')
      .get();

    const data = snap.docs.map((doc) => {
      const d = doc.data() ?? {};
      return {
        id: doc.id,
        // Both spellings are live on real agent documents; the picker needs one label.
        name: String(d.name ?? d.agent_name ?? doc.id),
      };
    });

    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agents/list] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
