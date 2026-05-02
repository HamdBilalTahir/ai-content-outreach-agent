import { db } from '../firebase/admin';
import { UserProfile } from '../types';

const COLLECTION = 'userProfiles';

export async function getUserProfile(
  userId: string
): Promise<UserProfile | null> {
  const doc = await db.collection(COLLECTION).doc(userId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as UserProfile;
}

export async function createUserProfile(
  userId: string,
  email: string | null,
  name?: string | null
): Promise<UserProfile> {
  const newProfile = {
    email: email || '',
    name: name || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.collection(COLLECTION).doc(userId).set(newProfile);

  return { id: userId, ...newProfile } as UserProfile;
}

export async function getAllUserProfiles(): Promise<UserProfile[]> {
  const snapshot = await db.collection(COLLECTION).get();
  return snapshot.docs.map(
    (doc) => ({ id: doc.id, ...doc.data() }) as UserProfile
  );
}
