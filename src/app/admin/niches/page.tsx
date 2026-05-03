import { getAllNiches } from '../../../../lib/db/niches';
import { getAllPipelines } from '../../../../lib/db/pipelines';
import NichesManager from './NichesManager';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function NichesPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const [niches, pipelines] = await Promise.all([
    getAllNiches(userId),
    getAllPipelines(userId),
  ]);

  const serializedNiches = niches.map((niche) => ({
    ...niche,
    lastCrawled: niche.lastCrawled
      ? (niche.lastCrawled.toMillis() as any)
      : null,
    createdAt: niche.createdAt?.toMillis() as any,
    updatedAt: niche.updatedAt?.toMillis() as any,
  }));

  const serializedPipelines = pipelines.map((p) => ({
    ...p,
    createdAt: p.createdAt?.toMillis() as any,
    updatedAt: p.updatedAt?.toMillis() as any,
  }));

  return (
    <NichesManager
      initialNiches={serializedNiches}
      pipelines={serializedPipelines}
    />
  );
}
