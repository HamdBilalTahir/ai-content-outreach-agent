import { db } from '../firebase/admin';
import type { DispatchLog } from '../types';

const COLLECTION = 'dispatchLogs';

export async function createDispatchLog(
  data: Omit<DispatchLog, 'id'>
): Promise<string> {
  try {
    const ref = await db.collection(COLLECTION).add(data);
    return ref.id;
  } catch (err) {
    console.error('createDispatchLog failed:', err);
    throw err;
  }
}

export async function getDispatchLogsByLeadId(
  leadId: string
): Promise<DispatchLog[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('leadId', '==', leadId)
      .get();
    return snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as DispatchLog
    );
  } catch (err) {
    console.error('getDispatchLogsByLeadId failed:', err);
    throw err;
  }
}
