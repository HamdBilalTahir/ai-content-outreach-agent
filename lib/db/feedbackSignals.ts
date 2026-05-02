import { db } from '../firebase/admin';
import type { FeedbackSignal } from '../types';

const COLLECTION = 'feedbackSignals';

export async function createFeedbackSignal(
  data: Omit<FeedbackSignal, 'id'>
): Promise<string> {
  try {
    const ref = await db.collection(COLLECTION).add(data);
    return ref.id;
  } catch (err) {
    console.error('createFeedbackSignal failed:', err);
    throw err;
  }
}

export async function getFeedbackSignalsByNiche(
  nicheId: string
): Promise<FeedbackSignal[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('nicheId', '==', nicheId)
      .get();
    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as FeedbackSignal
    );
  } catch (err) {
    console.error('getFeedbackSignalsByNiche failed:', err);
    throw err;
  }
}

export async function getAllFeedbackSignals(
  userId: string
): Promise<FeedbackSignal[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .get();
    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as FeedbackSignal
    );
  } catch (err) {
    console.error('getAllFeedbackSignals failed:', err);
    throw err;
  }
}
