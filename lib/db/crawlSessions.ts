import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { CrawlSession } from '../types';

const COLLECTION = 'crawlSessions';

function getDocRef(id: string) {
  if (id.startsWith('sandbox:')) {
    const [, pipelineId, runId] = id.split(':');
    return db
      .collection('pipelines')
      .doc(pipelineId)
      .collection('sandbox_runs')
      .doc(runId);
  }
  return db.collection(COLLECTION).doc(id);
}

export async function createCrawlSession(
  data: Omit<CrawlSession, 'id' | 'startedAt'>
): Promise<string> {
  try {
    const collectionRef = data.isSandbox
      ? db
          .collection('pipelines')
          .doc(data.pipelineId)
          .collection('sandbox_runs')
      : db.collection(COLLECTION);

    const ref = await collectionRef.add({
      ...data,
      startedAt: FieldValue.serverTimestamp(),
    });
    return data.isSandbox ? `sandbox:${data.pipelineId}:${ref.id}` : ref.id;
  } catch (err) {
    console.error('createCrawlSession failed:', err);
    throw err;
  }
}

import type { AgentLog } from '../types';

export async function appendAgentLog(
  id: string,
  agentRole: AgentLog['agentRole'],
  narrative: string
): Promise<void> {
  try {
    await getDocRef(id).update({
      agentLogs: FieldValue.arrayUnion({
        timestamp: new Date().toISOString(),
        agentRole,
        narrative,
      }),
    });
  } catch (err) {
    console.error('appendAgentLog failed:', err);
  }
}

export async function updateCrawlSession(
  id: string,
  data: Partial<CrawlSession>
): Promise<void> {
  try {
    await getDocRef(id).update(data);
  } catch (err) {
    console.error('updateCrawlSession failed:', err);
    throw err;
  }
}

export async function markBrandProcessed(
  id: string,
  url: string
): Promise<void> {
  try {
    await getDocRef(id).update({
      processedBrands: FieldValue.arrayUnion(url),
    });
  } catch (err) {
    console.error('markBrandProcessed failed:', err);
  }
}

export async function getCrawlSession(
  id: string
): Promise<CrawlSession | null> {
  try {
    const doc = await getDocRef(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() } as CrawlSession;
  } catch (err) {
    console.error('getCrawlSession failed:', err);
    return null;
  }
}

export async function getCrawlSessionStatus(
  id: string
): Promise<string | null> {
  try {
    const doc = await getDocRef(id).get();
    if (!doc.exists) return null;
    return doc.data()?.sessionStatus ?? null;
  } catch (err) {
    console.error('getCrawlSessionStatus failed:', err);
    return null;
  }
}

export async function getRecentCrawlSessions(
  userId: string,
  limit = 100
): Promise<CrawlSession[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as CrawlSession
    );
  } catch (err) {
    console.error('getRecentCrawlSessions failed:', err);
    throw err;
  }
}
