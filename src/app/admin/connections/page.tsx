import {
  getPrimaryConnection,
  createOrUpdateConnection,
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

  let accounts: any[] = [];
  try {
    accounts = await getConnectedAccounts(userId);
  } catch (error) {
    console.error('Failed to fetch Unipile accounts:', error);
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
  } else if (resolvedSearchParams?.success === 'true' && accounts.length > 0) {
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

  // Fetch the primary connection
  const connection = await getPrimaryConnection(userId);

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
    />
  );
}
