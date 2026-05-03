import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';
import ManualTriggers from './ManualTriggers';
import { getAllNiches } from '../../../../lib/db/niches';
import { getAllPipelines } from '../../../../lib/db/pipelines';

export default async function SessionsPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const niches = await getAllNiches(userId);
  const nicheOptions = niches.map((n) => ({ id: n.id, name: n.nicheName }));

  const pipelines = await getAllPipelines(userId);
  const pipelineOptions = pipelines.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Diagnostics</h1>
      </div>
      <ManualTriggers niches={nicheOptions} pipelines={pipelineOptions} />
    </div>
  );
}
