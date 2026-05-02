import { getSettings } from '../../../../lib/db/settings';
import { getPrimaryConnection } from '../../../../lib/db/connections';
import SettingsManager from './SettingsManager';
import { getAuthenticatedUserId } from '../../../../lib/utils/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect('/login');
  }

  const settings = await getSettings(userId);
  const connection = await getPrimaryConnection(userId);

  const serializedSettings = {
    ...settings,
    updatedAt: settings.updatedAt?.toMillis() as any, // serialize timestamp to number
  };

  const connectedNumber =
    connection?.status === 'connected'
      ? `+${connection.countryCode || ''}${connection.phoneNumber}`
      : null;

  return (
    <SettingsManager
      initialSettings={serializedSettings}
      connectedNumber={connectedNumber}
    />
  );
}
