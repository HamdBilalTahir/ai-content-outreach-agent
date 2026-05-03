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
      health_score: data.health_score ?? 100,
      consecutive_failures: data.consecutive_failures ?? 0,
      status: data.status ?? 'active',
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
    if (!id || id === 'auto') {
      // Create a fallback niche if one doesn't exist
      await createNiche({
        userId,
        pipelineId: data.pipelineId || 'default-pipeline',
        nicheName: 'Auto Discovered Niche',
        crawlPriority: 1,
        avgGapScore: 0,
        closeRate: 0,
        avgProductPrice: 0,
        seedUrls: [],
        blacklistedSignals: [],
        lastCrawled: null,
        aiReasoning:
          data.aiReasoning || 'Automatically generated fallback niche',
      });
      return;
    }
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      // Just create it instead of crashing
      await createNiche({
        userId,
        pipelineId: data.pipelineId || 'default-pipeline',
        nicheName: `Niche ${id}`,
        crawlPriority: 1,
        avgGapScore: 0,
        closeRate: 0,
        avgProductPrice: 0,
        seedUrls: [],
        blacklistedSignals: [],
        lastCrawled: null,
        ...data,
      });
      return;
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

export async function getAllNichesByPipeline(
  userId: string,
  pipelineId: string
): Promise<Niche[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .where('pipelineId', '==', pipelineId)
      .orderBy('crawlPriority', 'desc')
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Niche);
  } catch (err) {
    console.error('getAllNichesByPipeline failed:', err);
    throw err;
  }
}
