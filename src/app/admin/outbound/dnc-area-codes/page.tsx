import { redirect } from 'next/navigation';

import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';
import DncAreaCodesClient from './components/DncAreaCodesClient';

export const dynamic = 'force-dynamic';

/**
 * The FTC DNC area-code registry.
 *
 * The source relies on a layout-level auth guard; this repo guards PER PAGE (see `niches/page.tsx` and
 * every other admin route), because its `admin/layout.tsx` is presentational only. Copying the source's
 * page verbatim would therefore have left the registry readable — and writable — by anyone with the URL.
 * The guard follows this repo's own convention rather than introducing a second one.
 *
 * The registry is global rather than per-user, so the resolved id is only an authentication check; there is
 * no `userId` to scope anything by, which is why the source's comment says no company boilerplate is
 * needed.
 */
export default async function DncAreaCodesPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }
  return <DncAreaCodesClient />;
}
