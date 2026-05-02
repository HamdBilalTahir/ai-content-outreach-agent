import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Connection } from '../types';

const COLLECTION = 'connections';

export async function createOrUpdateConnection(
  userId: string,
  data: Partial<Omit<Connection, 'id' | 'connectedAt' | 'updatedAt' | 'userId'>>
): Promise<string> {
  try {
    // We use userId as the document ID for their connection
    const docRef = db.collection(COLLECTION).doc(userId);
    const doc = await docRef.get();

    if (!doc.exists) {
      await docRef.set({
        userId,
        ...data,
        connectedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await docRef.update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return docRef.id;
  } catch (err) {
    console.error('createOrUpdateConnection failed:', err);
    throw err;
  }
}

export async function getPrimaryConnection(
  userId: string
): Promise<Connection | null> {
  try {
    const doc = await db.collection(COLLECTION).doc(userId).get();

    if (!doc.exists) return null;

    return { id: doc.id, ...doc.data() } as Connection;
  } catch (err) {
    console.error('getPrimaryConnection failed:', err);
    throw err;
  }
}

export async function disconnectPrimaryConnection(
  userId: string
): Promise<void> {
  try {
    const docRef = db.collection(COLLECTION).doc(userId);
    await docRef.update({
      status: 'disconnected',
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('disconnectPrimaryConnection failed:', err);
    throw err;
  }
}
