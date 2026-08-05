import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import FunnelDashboardClient from './components/FunnelDashboardClient';

export const dynamic = 'force-dynamic';

/**
 * The outbound funnel dashboard.
 *
 * Same two changes as the campaigns pages: this repo's per-page auth guard, and the source's `companyId`
 * resolution block dropped — it read a `next-auth` session and called a Django `campaign_maker` endpoint,
 * none of which exists here. The prop is threaded through empty so the client stays byte-identical.
 */
export default async function FunnelPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }
  return <FunnelDashboardClient companyId="" />;
}
