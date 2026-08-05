import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import ParkedTestChatsClient from '../../parked-test-chats/components/ParkedTestChatsClient';

export const dynamic = 'force-dynamic';

/**
 * Parked outbound test chats.
 *
 * The client is shared with the inbound parked-chats screen and lives outside the outbound tree, at
 * `admin/parked-test-chats/components/` — the source keeps it there for the same reason, and this page is
 * a ten-line wrapper that narrows it with `?type=outbound`. Both props are the source's, verbatim.
 *
 * The only addition is this repo's per-page auth guard, since its `admin/layout.tsx` is presentational.
 */
export default async function OutboundParkedTestChatsPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }
  return (
    <ParkedTestChatsClient
      listQuery="?type=outbound"
      heading="Parked Outbound Chats"
    />
  );
}
