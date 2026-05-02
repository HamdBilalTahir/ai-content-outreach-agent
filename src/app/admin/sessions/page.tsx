import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';
import ManualTriggers from './ManualTriggers';
import { getAllNiches } from '../../../../lib/db/niches';

export default async function SessionsPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const niches = await getAllNiches(userId);
  const nicheOptions = niches.map((n) => ({ id: n.id, name: n.nicheName }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Diagnostics</h1>
      </div>
      <ManualTriggers niches={nicheOptions} />
    </div>
  );
}
