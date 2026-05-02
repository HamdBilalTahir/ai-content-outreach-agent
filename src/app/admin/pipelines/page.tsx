import { getAllPipelines } from '../../../../lib/db/pipelines';
import { getConnections } from '../../../../lib/db/connections';
import PipelinesManager from './PipelinesManager';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PipelinesPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const [pipelines, connections] = await Promise.all([
    getAllPipelines(userId),
    getConnections(userId),
  ]);

  const serializedPipelines = pipelines.map((p) => ({
    ...p,
    createdAt: p.createdAt?.toMillis() as any,
    updatedAt: p.updatedAt?.toMillis() as any,
  }));

  const serializedConnections = connections.map((c) => ({
    ...c,
    connectedAt: c.connectedAt?.toMillis() as any,
    updatedAt: c.updatedAt?.toMillis() as any,
  }));

  return (
    <div className="mx-auto max-w-7xl">
      <PipelinesManager
        initialPipelines={serializedPipelines}
        connections={serializedConnections}
      />
    </div>
  );
}
