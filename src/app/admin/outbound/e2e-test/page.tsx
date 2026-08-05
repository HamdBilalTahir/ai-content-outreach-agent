import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import OutboundE2ETestClient from './components/OutboundE2ETestClient';

export const dynamic = 'force-dynamic';

/**
 * The outbound E2E test screen — enrol a test lead, watch the agent work it, inspect the chat.
 *
 * Same two changes as every other ported page: this repo's per-page auth guard, and the source's
 * `companyId` resolution dropped (it read a `next-auth` session and called a Django `campaign_maker`
 * endpoint, none of which exists here). The prop is threaded through empty so the client — the largest
 * single file in either port at 3,829 lines — stays byte-identical.
 */
export default async function OutboundE2ETestPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }
  return <OutboundE2ETestClient companyId="" />;
}
