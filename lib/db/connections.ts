import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Connection } from '../types';

const COLLECTION = 'connections';

export async function createOrUpdateConnection(
  userId: string,
  data: Partial<Omit<Connection, 'id' | 'connectedAt' | 'updatedAt' | 'userId'>>
): Promise<string> {
  try {
    const instanceId = data.instanceId;
    if (!instanceId) {
      throw new Error('instanceId is required for connection');
    }

    // We use instanceId as the document ID for their connection
    const docRef = db.collection(COLLECTION).doc(instanceId);
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

export async function getConnections(userId: string): Promise<Connection[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .get();
    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as Connection
    );
  } catch (err) {
    console.error('getConnections failed:', err);
    throw err;
  }
}

export async function getPrimaryConnection(
  userId: string
): Promise<Connection | null> {
  try {
    const connections = await getConnections(userId);
    const connected = connections.filter((c) => c.status === 'connected');
    return connected.length > 0 ? connected[0] : null;
  } catch (err) {
    console.error('getPrimaryConnection failed:', err);
    throw err;
  }
}

export async function disconnectConnection(instanceId: string): Promise<void> {
  try {
    const docRef = db.collection(COLLECTION).doc(instanceId);
    const doc = await docRef.get();
    if (doc.exists) {
      await docRef.update({
        status: 'disconnected',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error('disconnectConnection failed:', err);
    throw err;
  }
}
