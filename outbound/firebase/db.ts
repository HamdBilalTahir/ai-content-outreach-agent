/**
 * The single Firestore seam for the outbound flow.
 *
 * Every outbound module imports `db` from here rather than reaching for `firebase-admin` directly.
 * That gives us one place to mock in tests (no suite needs live credentials) and one place that
 * knows how this app initializes Firestore — the shared admin app in `lib/firebase/admin.ts`, so
 * outbound reads and writes the same project as the rest of the repo.
 *
 * Also re-exports the sentinel/type helpers the ported code needs, because the Python source used
 * `google.cloud.firestore` module-level constants (`SERVER_TIMESTAMP`, `Increment`, `ArrayUnion`)
 * that live on `FieldValue` in the Node SDK.
 */

import * as admin from 'firebase-admin';

import { db } from '../../lib/firebase/admin';

export { db };

/** `firestore.SERVER_TIMESTAMP`, `Increment`, `ArrayUnion`, `ArrayRemove`, `delete()`. */
export const FieldValue = admin.firestore.FieldValue;

/**
 * Firestore `Timestamp`, for converting stored datetimes to JS `Date`.
 * The type is exported under a distinct name rather than merged with the value, so the two never
 * read as a redeclaration.
 */
export const Timestamp = admin.firestore.Timestamp;
export type FirestoreTimestamp = admin.firestore.Timestamp;

export type DocumentData = admin.firestore.DocumentData;
export type DocumentReference = admin.firestore.DocumentReference;
export type DocumentSnapshot = admin.firestore.DocumentSnapshot;
export type QueryDocumentSnapshot = admin.firestore.QueryDocumentSnapshot;
export type Transaction = admin.firestore.Transaction;
export type WriteBatch = admin.firestore.WriteBatch;

/** Firestore caps a batch at 500 operations; several ported writers assert against this. */
export const BATCH_LIMIT = 500;

/**
 * Coerce whatever a datetime field holds into a JS `Date`, or `null`.
 *
 * Reads have to tolerate three shapes for the same field: a Firestore `Timestamp` (the normal
 * case), a `Date` (a value written in this process before a round-trip), and an ISO string (older
 * documents and webhook payloads). The Python code leaned on duck-typing plus a `.replace(tzinfo=…)`
 * fixup for naive datetimes; in TS the equivalent is centralized here so no caller re-implements it
 * and gets one of the three wrong.
 */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (value instanceof Timestamp) return value.toDate();
  if (
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Read `db.getAll` in chunks.
 *
 * The cron's wide-lookback query can match thousands of tasks sharing a few hundred parent chats.
 * The source learned the hard way that a per-task `chat_ref.get()` inside the result stream held
 * the gRPC stream open past its ~300s deadline; batching the parent reads instead turned minutes
 * into seconds. The chunk size mirrors the source's 300.
 */
export async function getAllChunked(
  refs: DocumentReference[],
  chunkSize = 300
): Promise<DocumentSnapshot[]> {
  const out: DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += chunkSize) {
    const chunk = refs.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    out.push(...(await db.getAll(...chunk)));
  }
  return out;
}

/**
 * Run `tasks` with at most `limit` in flight, preserving result order.
 *
 * Stands in for the source's `ThreadPoolExecutor(max_workers=…)`. `Promise.all` alone would start
 * everything at once, which is exactly what the per-tick cap exists to prevent — an unbounded fan-out
 * would burst the downstream voice/email providers.
 *
 * A rejected task rejects the whole call, matching `as_completed` + an uncaught raise; callers that
 * want per-item isolation catch inside their own thunk (as the ported cron does).
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const max = Math.max(1, Math.min(limit, tasks.length));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: max }, () => worker()));
  return results;
}
