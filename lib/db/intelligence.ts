import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { IntelligenceRegistry } from '../types';

const COLLECTION = 'intelligence';

export async function getIntelligenceRegistry(
  userId: string,
  pipelineId: string,
  agentRole: string
): Promise<IntelligenceRegistry | null> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .where('pipelineId', '==', pipelineId)
      .where('agentRole', '==', agentRole)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return {
      id: snapshot.docs[0].id,
      ...snapshot.docs[0].data(),
    } as IntelligenceRegistry;
  } catch (err) {
    console.error('getIntelligenceRegistry failed:', err);
    throw err;
  }
}

export async function updateIntelligenceRegistry(
  userId: string,
  pipelineId: string,
  agentRole: string,
  blobUrl: string,
  incrementVersion: boolean = true,
  lastChangeNote?: string
): Promise<string> {
  try {
    const existing = await getIntelligenceRegistry(
      userId,
      pipelineId,
      agentRole
    );

    const changeNote = lastChangeNote
      ? lastChangeNote.split('\n')[0].slice(0, 200)
      : undefined;

    if (existing) {
      await db
        .collection(COLLECTION)
        .doc(existing.id)
        .update({
          blobUrl,
          version: incrementVersion ? existing.version + 1 : existing.version,
          lastUpdated: FieldValue.serverTimestamp(),
          ...(changeNote && { lastChangeNote: changeNote }),
        });
      return existing.id;
    } else {
      const ref = await db.collection(COLLECTION).add({
        userId,
        pipelineId,
        agentRole,
        blobUrl,
        version: 1,
        createdAt: FieldValue.serverTimestamp(),
        lastUpdated: FieldValue.serverTimestamp(),
        ...(changeNote && { lastChangeNote: changeNote }),
      });
      return ref.id;
    }
  } catch (err) {
    console.error('updateIntelligenceRegistry failed:', err);
    throw err;
  }
}

export async function getAllIntelligenceForPipeline(
  userId: string,
  pipelineId: string
): Promise<IntelligenceRegistry[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .where('pipelineId', '==', pipelineId)
      .get();

    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as IntelligenceRegistry
    );
  } catch (err) {
    console.error('getAllIntelligenceForPipeline failed:', err);
    throw err;
  }
}
