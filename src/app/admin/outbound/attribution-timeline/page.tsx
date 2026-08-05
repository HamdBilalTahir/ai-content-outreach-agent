import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import AttributionTimelineClient from './components/AttributionTimelineClient';

export const dynamic = 'force-dynamic';

/**
 * The attribution timeline — one deal's first-touch → acquisition history.
 *
 * Same shape as the other ported pages: this repo's per-page auth guard, and the source's `companyId`
 * resolution block dropped (it read a `next-auth` session and called a Django `campaign_maker` endpoint,
 * none of which exists here). The prop is threaded through empty so the client stays byte-identical.
 *
 * Worth noting what this page proves: it fetches `analytics/deal-timeline` and `analytics/deal-funnel`,
 * both served by the ported backend — so phases 10d¹ and 10d³ are live, not dead code. See UI plan
 * revision 3, which claimed the opposite and is corrected there.
 */
export default async function AttributionTimelinePage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }
  return <AttributionTimelineClient companyId="" />;
}
