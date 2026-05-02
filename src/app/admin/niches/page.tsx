import { getAllNiches } from '../../../../lib/db/niches';
import NichesManager from './NichesManager';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function NichesPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const niches = await getAllNiches(userId);

  const serializedNiches = niches.map((niche) => ({
    ...niche,
    lastCrawled: niche.lastCrawled
      ? (niche.lastCrawled.toMillis() as any)
      : null,
    createdAt: niche.createdAt?.toMillis() as any,
    updatedAt: niche.updatedAt?.toMillis() as any,
  }));

  return <NichesManager initialNiches={serializedNiches} />;
}
