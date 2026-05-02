import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Lead } from '../types';

const COLLECTION = 'leads';

export async function createLead(
  data: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    const existing = await db
      .collection(COLLECTION)
      .where('dedupHash', '==', data.dedupHash)
      .limit(1)
      .get();

    if (!existing.empty) {
      return existing.docs[0].id;
    }

    const ref = await db.collection(COLLECTION).add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return ref.id;
  } catch (err) {
    console.error('createLead failed:', err);
    throw err;
  }
}

export async function getLeads(userId: string, limit = 100): Promise<Lead[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Lead);
  } catch (err) {
    console.error('getLeads failed:', err);
    throw err;
  }
}

export async function getLeadById(
  userId: string,
  id: string
): Promise<Lead | null> {
  try {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) return null;
    return { id: doc.id, ...doc.data() } as Lead;
  } catch (err) {
    console.error('getLeadById failed:', err);
    throw err;
  }
}

export async function getLeadsByStatus(
  userId: string,
  status: Lead['status'],
  limit = 100
): Promise<Lead[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .where('status', '==', status)
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Lead);
  } catch (err) {
    console.error('getLeadsByStatus failed:', err);
    throw err;
  }
}

export async function updateLeadStatus(
  userId: string,
  id: string,
  status: Lead['status']
): Promise<void> {
  try {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      throw new Error('Not found or unauthorized');
    }

    await db.collection(COLLECTION).doc(id).update({
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('updateLeadStatus failed:', err);
    throw err;
  }
}

export async function updateLead(
  userId: string,
  id: string,
  data: Partial<Lead>
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
    console.error('updateLead failed:', err);
    throw err;
  }
}
