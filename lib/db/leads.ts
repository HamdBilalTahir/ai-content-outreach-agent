import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase/admin';
import type { Lead } from '../types';

const COLLECTION = 'leads';

// ── Path helpers ──────────────────────────────────────────────────────────────
// Sandbox IDs are encoded as "sandbox:{pipelineId}:{runId}:{docId}".
// They live at: leads/sandbox_{pipelineId}_{runId}/items/{docId}
//
// Automation IDs are plain Firestore doc IDs.
// They live at: leads/{docId}

function parseSandboxId(
  id: string
): { pipelineId: string; runId: string; docId: string } | null {
  if (!id.startsWith('sandbox:')) return null;
  const [, pipelineId, runId, docId] = id.split(':');
  if (!pipelineId || !runId || !docId) return null;
  return { pipelineId, runId, docId };
}

function sandboxContainerId(pipelineId: string, runId: string): string {
  return `sandbox_${pipelineId}_${runId}`;
}

export function getLeadDocRef(id: string) {
  const parsed = parseSandboxId(id);
  if (parsed) {
    const { pipelineId, runId, docId } = parsed;
    return db
      .collection(COLLECTION)
      .doc(sandboxContainerId(pipelineId, runId))
      .collection('items')
      .doc(docId);
  }

  // Backward-compat for legacy sandbox leads
  if (id.startsWith('sandbox:')) {
    const parts = id.split(':');
    if (parts.length === 2) {
      return db
        .collection(COLLECTION)
        .doc('sandbox')
        .collection('leads')
        .doc(parts[1]);
    }
  }

  // Backward-compat for sandbox_candidate: legacy IDs
  if (id.startsWith('sandbox_candidate:')) {
    const docId = id.split(':')[1];
    if (docId) {
      return db
        .collection(COLLECTION)
        .doc('sandbox')
        .collection('leads')
        .doc(docId);
    }
  }

  return db.collection(COLLECTION).doc(id);
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function createLead(
  data: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    if (
      data.isSandbox &&
      data.pipelineId &&
      data.crawlSessionId?.startsWith('sandbox:')
    ) {
      const parts = data.crawlSessionId.split(':');
      const runId = parts[2];
      const containerId = sandboxContainerId(data.pipelineId, runId);
      const colRef = db
        .collection(COLLECTION)
        .doc(containerId)
        .collection('items');

      // Per-run dedup
      const existing = await colRef
        .where('dedupHash', '==', data.dedupHash)
        .limit(1)
        .get();
      if (!existing.empty) {
        return `sandbox:${data.pipelineId}:${runId}:${existing.docs[0].id}`;
      }

      const ref = await colRef.add({
        ...data,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return `sandbox:${data.pipelineId}:${runId}:${ref.id}`;
    }

    // Automation / top-level lead
    const existing = await db
      .collection(COLLECTION)
      .where('dedupHash', '==', data.dedupHash)
      .where('userId', '==', data.userId)
      .limit(1)
      .get();
    if (!existing.empty) return existing.docs[0].id;

    const ref = await db.collection(COLLECTION).add({
      ...data,
      isSandbox: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('createLead failed:', err);
    throw err;
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

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
    let docRef = getLeadDocRef(id);
    let snap = await docRef.get();

    // Fallback: If it's a new path ID but the document is actually in the old sandbox path
    if (!snap.exists && id.startsWith('sandbox:')) {
      const parts = id.split(':');
      if (parts.length > 2) {
        const legacyDocId = parts[parts.length - 1];
        const fallbackRef = db
          .collection(COLLECTION)
          .doc('sandbox')
          .collection('leads')
          .doc(legacyDocId);
        const fallbackSnap = await fallbackRef.get();
        if (fallbackSnap.exists) {
          docRef = fallbackRef;
          snap = fallbackSnap;
        }
      }
    }

    if (!snap.exists || snap.data()?.userId !== userId) return null;
    return { id, ...snap.data() } as Lead;
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

// Returns all leads for a specific sandbox run, with composite IDs attached.
export async function getSandboxLeadsByRun(
  userId: string,
  pipelineId: string,
  runId: string
): Promise<Lead[]> {
  try {
    const containerId = sandboxContainerId(pipelineId, runId);
    const snapshot = await db
      .collection(COLLECTION)
      .doc(containerId)
      .collection('items')
      .where('userId', '==', userId)
      .get();
    return snapshot.docs.map(
      (doc) =>
        ({
          id: `sandbox:${pipelineId}:${runId}:${doc.id}`,
          ...doc.data(),
        }) as Lead
    );
  } catch (err) {
    console.error('getSandboxLeadsByRun failed:', err);
    throw err;
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateLeadStatus(
  userId: string,
  id: string,
  status: Lead['status']
): Promise<void> {
  try {
    let docRef = getLeadDocRef(id);
    let snap = await docRef.get();

    // Fallback: If it's a new path ID but the document is actually in the old sandbox path
    if (!snap.exists && id.startsWith('sandbox:')) {
      const parts = id.split(':');
      if (parts.length > 2) {
        const legacyDocId = parts[parts.length - 1];
        const fallbackRef = db
          .collection(COLLECTION)
          .doc('sandbox')
          .collection('leads')
          .doc(legacyDocId);
        const fallbackSnap = await fallbackRef.get();
        if (fallbackSnap.exists) {
          docRef = fallbackRef;
          snap = fallbackSnap;
        }
      }
    }

    if (!snap.exists || snap.data()?.userId !== userId) {
      throw new Error('Not found or unauthorized');
    }
    await docRef.update({ status, updatedAt: FieldValue.serverTimestamp() });
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
    let docRef = getLeadDocRef(id);
    let snap = await docRef.get();

    // Fallback: If it's a new path ID but the document is actually in the old sandbox path
    if (!snap.exists && id.startsWith('sandbox:')) {
      const parts = id.split(':');
      if (parts.length > 2) {
        const legacyDocId = parts[parts.length - 1];
        const fallbackRef = db
          .collection(COLLECTION)
          .doc('sandbox')
          .collection('leads')
          .doc(legacyDocId);
        const fallbackSnap = await fallbackRef.get();
        if (fallbackSnap.exists) {
          docRef = fallbackRef;
          snap = fallbackSnap;
        }
      }
    }

    if (!snap.exists || snap.data()?.userId !== userId) {
      throw new Error('Not found or unauthorized');
    }
    await docRef.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error('updateLead failed:', err);
    throw err;
  }
}
