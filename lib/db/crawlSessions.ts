import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { CrawlSession } from '../types';

const COLLECTION = 'crawlSessions';

export async function createCrawlSession(
  data: Omit<CrawlSession, 'id' | 'startedAt'>
): Promise<string> {
  try {
    const ref = await db.collection(COLLECTION).add({
      ...data,
      startedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('createCrawlSession failed:', err);
    throw err;
  }
}

export async function updateCrawlSession(
  id: string,
  data: Partial<CrawlSession>
): Promise<void> {
  try {
    await db.collection(COLLECTION).doc(id).update(data);
  } catch (err) {
    console.error('updateCrawlSession failed:', err);
    throw err;
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
