/**
 * Feature flags from the Firestore `feature_flags` collection — one document per flag, carrying
 * `{enabled, description, updated_at}`.
 *
 * Only the read path is ported: outbound consults flags (the Full Scrub kill-switch), it never sets
 * them. The inbound module also holds a large family of per-dealer toggle documents in `settings`;
 * none of those are read by outbound code, so they are deliberately not here.
 *
 * The 60-second in-process cache exists because the flag is read per contact during enrollment, and
 * without it a 500-contact campaign is 500 identical Firestore reads. It resets on deploy, which is
 * the intended granularity — a flag flip takes effect within a minute.
 */

import { db } from './db';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: boolean;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Is the named flag enabled?
 *
 * Fail-CLOSED on a read error and on an absent document: an unknown flag state must not silently
 * enable a gate nobody has turned on. `phoneScreening` relies on this — it treats a flag it cannot
 * read as off, which skips screening rather than blocking every lead.
 */
export async function isEnabled(flagName: string): Promise<boolean> {
  if (!flagName) return false;

  const hit = cache.get(flagName);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = false;
  try {
    const doc = await db.collection('feature_flags').doc(flagName).get();
    value = doc.exists ? Boolean((doc.data() ?? {}).enabled) : false;
  } catch (e) {
    console.warn(
      `[FLAGS] read failed for ${flagName} — treating as disabled: ${e}`
    );
    value = false;
  }
  cache.set(flagName, { value, at: Date.now() });
  return value;
}

/** Drop the cache. Tests use this; production relies on the TTL. */
export function clearFlagCache(): void {
  cache.clear();
}
