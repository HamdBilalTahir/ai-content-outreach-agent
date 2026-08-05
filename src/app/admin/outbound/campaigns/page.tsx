import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import CampaignsClient from './components/CampaignsClient';

export const dynamic = 'force-dynamic';

/**
 * The campaigns list.
 *
 * ## `companyId` is threaded through as empty, deliberately
 *
 * The source spends most of this file resolving a company id: it reads a `next-auth` session, pulls a
 * `backendToken`, and calls a Django `campaign_maker/company/user/all/` endpoint to find the operator's
 * first company. None of those three things exists here — no `next-auth`, no `campaign_maker`, no
 * companies — so the whole block is dropped.
 *
 * The prop is still passed, and still empty, because `CampaignsClient` forwards it to
 * `/api/agents/list?companyId=` and puts it in the detail-page URL. That endpoint is ported to IGNORE the
 * parameter (this repo's agents are not tenant-scoped), so an empty value is correct rather than missing —
 * and threading it keeps the client and the detail page byte-identical to the source instead of ripping a
 * prop out of three components to save one string.
 */
export default async function CampaignsPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }
  return <CampaignsClient companyId="" />;
}
