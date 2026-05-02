import { getSettings } from '../../../../lib/db/settings';
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

  const serializedSettings = {
    ...settings,
    updatedAt: settings.updatedAt?.toMillis() as any, // serialize timestamp to number
  };

  return <SettingsManager initialSettings={serializedSettings} />;
}
