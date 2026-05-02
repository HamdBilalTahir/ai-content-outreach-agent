import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { SystemSettings } from '../types';

const COLLECTION = 'settings';
const DEFAULT_DOC_ID = 'default';

export const DEFAULT_SETTINGS: Omit<
  SystemSettings,
  'id' | 'updatedAt' | 'userId'
> = {
  crawlEnabled: true,
  dispatchEnabled: true,
  maxConcurrentPipelines: 5,
  dispatchBatchSize: 20,
  crawlScheduleHour: 6,
  dispatchScheduleHour: 9,
};

// Fetch the system-wide default settings
export async function getDefaultSettings(): Promise<SystemSettings> {
  const docRef = db.collection(COLLECTION).doc(DEFAULT_DOC_ID);
  const doc = await docRef.get();

  if (!doc.exists) {
    const defaultData = {
      userId: 'system',
      ...DEFAULT_SETTINGS,
      updatedAt: FieldValue.serverTimestamp(),
    };
    await docRef.set(defaultData);
    return { id: DEFAULT_DOC_ID, ...defaultData } as unknown as SystemSettings;
  }

  return { id: doc.id, ...doc.data() } as SystemSettings;
}

// Fetch user's custom settings if they exist, otherwise fallback to default
export async function getSettings(userId: string): Promise<SystemSettings> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Fallback to system defaults if no custom settings exist for this user
      const defaults = await getDefaultSettings();
      // Return defaults but with this userId so client knows who it belongs to conceptually
      return { ...defaults, userId };
    }

    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as SystemSettings;
  } catch (err) {
    console.error('getSettings failed:', err);
    throw err;
  }
}

// Fetch all active settings (only custom ones, system default isn't a "user" setting to be cron'd over directly unless we want all users to run. Wait, cron jobs need to run for all users. We should return all users' custom settings. Wait, if a user hasn't modified settings, they don't have a document, so the cron won't run for them! We might need to iterate over userProfiles instead.)
export async function getAllSettings(): Promise<SystemSettings[]> {
  try {
    // We only fetch custom settings (userId != 'system')
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '!=', 'system')
      .get();

    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as SystemSettings
    );
  } catch (err) {
    console.error('getAllSettings failed:', err);
    throw err;
  }
}

export async function updateSettings(
  userId: string,
  data: Partial<Omit<SystemSettings, 'id' | 'updatedAt' | 'userId'>>
): Promise<void> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Create custom settings based on default + new data
      const defaults = await getDefaultSettings();

      // Exclude 'id' and 'userId' from defaults when merging
      const {
        id: _id,
        userId: _uid,
        updatedAt: _ua,
        ...defaultsData
      } = defaults;

      await db.collection(COLLECTION).add({
        ...defaultsData,
        ...data,
        userId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const doc = snapshot.docs[0];
      await doc.ref.update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error('updateSettings failed:', err);
    throw err;
  }
}

export async function resetSettings(userId: string): Promise<void> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  } catch (err) {
    console.error('resetSettings failed:', err);
    throw err;
  }
}
