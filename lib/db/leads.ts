import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Lead } from '../types';

const COLLECTION = 'leads';

export function getLeadDocRef(id: string) {
  if (id.startsWith('sandbox_candidate:')) {
    const [, pId, rId, cId] = id.split(':');
    return db
      .collection('pipelines')
      .doc(pId)
      .collection('sandbox_runs')
      .doc(rId)
      .collection('sandbox_candidates')
      .doc(cId);
  }
  return db.collection(COLLECTION).doc(id);
}

export async function createLead(
  data: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    const collectionRef =
      data.isSandbox && data.pipelineId && data.crawlSessionId
        ? db
            .collection('pipelines')
            .doc(data.pipelineId)
            .collection('sandbox_runs')
            .doc(
              data.crawlSessionId.replace('sandbox:', '').split(':').pop() ||
                data.crawlSessionId
            )
            .collection('sandbox_candidates')
        : db.collection(COLLECTION);

    const existing = await collectionRef
      .where('dedupHash', '==', data.dedupHash)
      .limit(1)
      .get();

    if (!existing.empty) {
      const existingId = existing.docs[0].id;
      return data.isSandbox
        ? `sandbox_candidate:${data.pipelineId}:${data.crawlSessionId?.replace('sandbox:', '').split(':').pop() || data.crawlSessionId}:${existingId}`
        : existingId;
    }

    const ref = await collectionRef.add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return data.isSandbox
      ? `sandbox_candidate:${data.pipelineId}:${data.crawlSessionId?.replace('sandbox:', '').split(':').pop() || data.crawlSessionId}:${ref.id}`
      : ref.id;
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
    const doc = await getLeadDocRef(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) return null;
    return { id, ...doc.data() } as Lead;
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
      // fetch a bit more just in case we filter out sandbox ones
      .limit(limit * 2)
      .get();

    const allLeads = snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as Lead
    );
    return allLeads.filter((l) => !l.isSandbox).slice(0, limit);
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
    const doc = await getLeadDocRef(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      throw new Error('Not found or unauthorized');
    }

    await getLeadDocRef(id).update({
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
    const doc = await getLeadDocRef(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      throw new Error('Not found or unauthorized');
    }

    await getLeadDocRef(id).update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('updateLead failed:', err);
    throw err;
  }
}
