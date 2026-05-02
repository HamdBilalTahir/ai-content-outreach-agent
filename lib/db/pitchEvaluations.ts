import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { PitchEvaluation } from '../types';

const COLLECTION = 'pitchEvaluations';

export async function createPitchEvaluation(
  data: Omit<PitchEvaluation, 'id' | 'createdAt'>
): Promise<string> {
  try {
    const ref = await db.collection(COLLECTION).add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('createPitchEvaluation failed:', err);
    throw err;
  }
}

export async function getPitchEvaluationByLeadId(
  leadId: string
): Promise<PitchEvaluation | null> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('leadId', '==', leadId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as PitchEvaluation;
  } catch (err) {
    console.error('getPitchEvaluationByLeadId failed:', err);
    throw err;
  }
}
