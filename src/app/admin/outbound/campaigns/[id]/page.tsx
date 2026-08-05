import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';
import CampaignDetailClient from '../components/CampaignDetailClient';

export const dynamic = 'force-dynamic';

/**
 * One campaign's detail view.
 *
 * Two changes from the source, both forced rather than chosen:
 *
 *  - **`params` and `searchParams` are Promises in Next 16.** The source destructures them synchronously,
 *    which was correct on Next 14. Same change the backend's route handlers took in Phase 10a.
 *  - **The `companyId` resolution block is gone** — see the note on the list page. It read a `next-auth`
 *    session and called a Django `campaign_maker` endpoint, none of which exists here.
 *
 * `agentId` still comes off the query string: the list page puts it there when the operator picks an
 * agent, so the detail view opens against the same one rather than re-resolving a default.
 */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ companyId?: string; agentId?: string }>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const { id } = await params;
  const { agentId } = await searchParams;

  return (
    <CampaignDetailClient
      campaignId={id}
      companyId=""
      agentId={agentId ?? ''}
    />
  );
}
