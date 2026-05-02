import { getPrimaryConnection } from '../../../../lib/db/connections';
import ConnectManager from './ConnectManager';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ConnectPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const connection = await getPrimaryConnection(userId);

  const serializedConnection = connection
    ? {
        ...connection,
        connectedAt: connection.connectedAt?.toMillis() as any,
        updatedAt: connection.updatedAt?.toMillis() as any,
      }
    : null;

  return <ConnectManager initialConnection={serializedConnection} />;
}
