import {
  getPrimaryConnection,
  createOrUpdateConnection,
  getConnections,
  disconnectConnection,
} from '../../../../lib/db/connections';
import ConnectManager from './ConnectManager';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';
import { getConnectedAccounts } from '../../../../lib/services/unipile';

export const dynamic = 'force-dynamic';

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{
    success?: string;
    account_id?: string;
    phoneNumber?: string;
    countryCode?: string;
  }>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const resolvedSearchParams = await searchParams;

  // If success=true, ensure the latest account is stored in the connections DB
  if (
    resolvedSearchParams?.success === 'true' &&
    resolvedSearchParams?.account_id
  ) {
    const accountId = resolvedSearchParams.account_id;

    await createOrUpdateConnection(userId, {
      provider: 'whatsapp',
      instanceId: accountId, // Unipile account ID
      status: 'connected',
      phoneNumber: resolvedSearchParams.phoneNumber || 'Unknown',
      countryCode: resolvedSearchParams.countryCode || '',
    });
    // Redirect to clear the searchParams
    redirect('/admin/connections');
  }

  // Fetch the primary connection first — Unipile errors are only relevant if
  // the DB already has a connected account.
  const connection = await getPrimaryConnection(userId);

  let accounts: any[] = [];
  let fetchError = null;

  if (connection?.status === 'connected') {
    try {
      accounts = await getConnectedAccounts(userId);
    } catch (error: any) {
      console.warn('Failed to fetch Unipile accounts:', error);
      fetchError = error.message || 'Failed to fetch Unipile accounts';

      try {
        const userConns = await getConnections(userId);
        for (const conn of userConns) {
          if (conn.status === 'connected') {
            await disconnectConnection(conn.id);
          }
        }
      } catch (dbError) {
        console.error('Failed to clean up stale DB connections:', dbError);
      }
    }
  }

  if (resolvedSearchParams?.success === 'true' && accounts.length > 0) {
    const latestAccount = accounts[0];
    await createOrUpdateConnection(userId, {
      provider: 'whatsapp',
      instanceId: latestAccount.accountId, // Unipile account ID
      status: 'connected',
      phoneNumber:
        resolvedSearchParams.phoneNumber ||
        latestAccount.phoneNumber ||
        'Unknown',
      countryCode: resolvedSearchParams.countryCode || '',
    });
    // Redirect to clear the searchParams
    redirect('/admin/connections');
  }

  // Detect credentials mismatch: DB says connected but that instanceId isn't in Unipile anymore
  const credentialsMismatch =
    !fetchError &&
    connection?.status === 'connected' &&
    connection.instanceId != null &&
    !accounts.some((a) => a.accountId === connection.instanceId);

  const serializedConnection = connection
    ? {
        ...connection,
        connectedAt: connection.connectedAt?.toMillis() as any,
        updatedAt: connection.updatedAt?.toMillis() as any,
      }
    : null;

  return (
    <ConnectManager
      accounts={accounts}
      initialConnection={serializedConnection}
      fetchError={fetchError}
      credentialsMismatch={credentialsMismatch}
    />
  );
}
