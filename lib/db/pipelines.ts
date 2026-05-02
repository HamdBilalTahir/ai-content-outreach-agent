import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Pipeline } from '../types';

const COLLECTION = 'pipelines';

export async function createPipeline(
  data: Omit<Pipeline, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    const ref = await db.collection(COLLECTION).add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('createPipeline failed:', err);
    throw err;
  }
}

export async function getAllPipelines(userId: string): Promise<Pipeline[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .get();
    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as Pipeline
    );
  } catch (err) {
    console.error('getAllPipelines failed:', err);
    throw err;
  }
}

export async function getPipelineById(
  userId: string,
  id: string
): Promise<Pipeline | null> {
  try {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) return null;
    return { id: doc.id, ...doc.data() } as Pipeline;
  } catch (err) {
    console.error('getPipelineById failed:', err);
    throw err;
  }
}

export async function updatePipeline(
  userId: string,
  id: string,
  data: Partial<Pipeline>
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
    console.error('updatePipeline failed:', err);
    throw err;
  }
}
