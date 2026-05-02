import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Niche } from '../types';

const COLLECTION = 'niches';

export async function createNiche(
  data: Omit<Niche, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    const ref = await db.collection(COLLECTION).add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('createNiche failed:', err);
    throw err;
  }
}

export async function getAllNiches(userId: string): Promise<Niche[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .orderBy('crawlPriority', 'desc')
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Niche);
  } catch (err) {
    console.error('getAllNiches failed:', err);
    throw err;
  }
}

export async function updateNiche(
  userId: string,
  id: string,
  data: Partial<Niche>
): Promise<void> {
  try {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      throw new Error('Not found or unauthorized');
    }

    await db
      .collection(COLLECTION)
      .doc(id)
      .update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.error('updateNiche failed:', err);
    throw err;
  }
}

export async function getNicheById(
  userId: string,
  id: string
): Promise<Niche | null> {
  try {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) return null;
    return { id: doc.id, ...doc.data() } as Niche;
  } catch (err) {
    console.error('getNicheById failed:', err);
    throw err;
  }
}
