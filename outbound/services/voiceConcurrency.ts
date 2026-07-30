/**
 * Outbound VOICE-call concurrency gate — an atomic reserved-slot ledger.
 *
 * Caps the number of outbound voice calls IN FLIGHT at once (default 5) so a campaign cannot fan out
 * into dozens of simultaneous calls. Separate from the email rate limiter, which is an agent-wide
 * hourly token bucket.
 *
 * ## Why a ledger rather than counting the call index
 *
 * The older cap counted `outbound_call_index` documents, and had three defects this replaces:
 *  1. hot prospects could BYPASS it;
 *  2. it was fail-OPEN — a read error produced a count of 0, i.e. unlimited;
 *  3. it counted and then wrote in two separate steps, so two concurrent dials in the cron's worker
 *     pool both saw `count < 5` and both dialed.
 *
 * This ledger does the count-and-reserve INSIDE A SINGLE TRANSACTION, so exactly N callers win and the
 * rest are refused deterministically. It is **fail-CLOSED** and has **no hot-prospect bypass** — the
 * cap is absolute.
 *
 * Slots auto-expire on a TTL, so a missed release (a dropped webhook) can never wedge capacity
 * permanently. The slot key is the chat id: the per-chat dial guard already ensures at most one call
 * in flight per chat, which makes the key naturally unique AND makes reserving idempotent per chat.
 * Reserve BEFORE the provider POST; release on completion, on a provider failure, or via TTL.
 */

import { FieldValue, db } from '../firebase/db';
import { maxConcurrentVoiceCalls, voiceSlotTtlMinutes } from '../config';

const DOC_COLLECTION = 'settings';
const DOC_ID = 'outbound_voice_concurrency';

interface Slot {
  chat_id: string;
  reserved_at: string;
  expires_at: string;
}

function ref() {
  return db.collection(DOC_COLLECTION).doc(DOC_ID);
}

/** Only the non-expired slots from an `active_slots` map. */
function liveSlots(
  slots: Record<string, unknown> | null | undefined,
  now: Date
): Record<string, Slot> {
  const live: Record<string, Slot> = {};
  for (const [k, v] of Object.entries(slots ?? {})) {
    try {
      const exp = (v as Slot | null)?.expires_at;
      if (!exp) continue;
      const dt = new Date(String(exp).replace('Z', '+00:00'));
      if (Number.isNaN(dt.getTime())) continue;
      if (dt > now) live[k] = v as Slot;
    } catch {
      continue;
    }
  }
  return live;
}

/**
 * Atomically reserve a voice-call slot for this chat. `true` iff a slot is held after the call —
 * either newly reserved, or already held by this chat, which makes it idempotent. `false` at capacity.
 *
 * Race-safe: the count of live slots AND the write happen in ONE transaction, so concurrent dials
 * cannot both slip past the cap. Expired slots are purged in the same transaction, since the whole map
 * is rewritten to the live set.
 *
 * Fail-CLOSED: any error returns `false`, skipping the dial (which reschedules). Never risk exceeding
 * capacity. A cap of zero or less disables the gate entirely.
 */
export async function tryReserveVoiceSlot(
  chatId: string,
  maxConcurrent?: number | null,
  ttlMinutes?: number
): Promise<boolean> {
  if (!chatId) return false;
  const cap =
    maxConcurrent === null || maxConcurrent === undefined
      ? maxConcurrentVoiceCalls()
      : Math.trunc(maxConcurrent);
  if (cap <= 0) return true; // cap disabled
  const ttl = ttlMinutes ?? voiceSlotTtlMinutes();

  try {
    const r = ref();
    const ok = await db.runTransaction(async (tx) => {
      const snap = await tx.get(r);
      const now = new Date();
      const slots = snap.exists
        ? (((snap.data() ?? {}).active_slots as Record<string, unknown>) ?? {})
        : {};
      const live = liveSlots(slots, now);

      if (chatId in live) return true; // already holding a slot — idempotent, no double-count
      if (Object.keys(live).length >= cap) return false; // at capacity

      const slot: Slot = {
        chat_id: chatId,
        reserved_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttl * 60_000).toISOString(),
      };

      if (!snap.exists) {
        tx.set(r, { active_slots: { [chatId]: slot } });
        return true;
      }

      // Reserve the new slot AND purge the expired ones, via dot-path field updates.
      //
      // The source wrote the whole live map back with `set(..., merge=True)` and commented that this
      // purged expired slots — it does not. Firestore merges map fields RECURSIVELY, so keys absent
      // from the payload survive, and the map grew one dead entry per chat ever dialed until the
      // document approached the 1MB limit. The cap itself was never wrong (`liveSlots` filters on
      // read), so the defect was invisible; only the unbounded growth was real. Dot-path deletes
      // achieve what the comment intended.
      const updates: Record<string, unknown> = {
        [`active_slots.${chatId}`]: slot,
      };
      for (const k of Object.keys(slots)) {
        if (!(k in live)) updates[`active_slots.${k}`] = FieldValue.delete();
      }
      tx.update(r, updates);
      return true;
    });

    console.log(
      `[OB VOICE CAP] reserve chat=${chatId} → ${ok ? 'granted' : 'AT CAPACITY'} (cap=${cap})`
    );
    return ok;
  } catch (e) {
    console.warn(
      `[OB VOICE CAP] tryReserveVoiceSlot failed chat=${chatId}: ${e} — fail-closed (deny)`
    );
    return false;
  }
}

/** Release this chat's voice slot. Idempotent — a no-op if it is already gone. Best-effort. */
export async function releaseVoiceSlot(chatId: string): Promise<boolean> {
  if (!chatId) return false;
  try {
    const r = ref();
    const released = await db.runTransaction(async (tx) => {
      const snap = await tx.get(r);
      if (!snap.exists) return false;
      const slots =
        ((snap.data() ?? {}).active_slots as Record<string, unknown>) ?? {};
      if (!(chatId in slots)) return false;
      // Delete the single field rather than rewriting the map: a concurrent reserve for another
      // chat must not be clobbered by a stale read from this transaction's snapshot.
      tx.update(r, { [`active_slots.${chatId}`]: FieldValue.delete() });
      return true;
    });
    if (released) console.log(`[OB VOICE CAP] released slot chat=${chatId}`);
    return released;
  } catch (e) {
    console.warn(`[OB VOICE CAP] releaseVoiceSlot failed chat=${chatId}: ${e}`);
    return false;
  }
}

/**
 * Self-heal: drop expired slots so a missed release or dropped webhook cannot wedge capacity forever.
 * Returns the number of live slots after the sweep. Called once per cron tick.
 */
export async function reconcileVoiceSlots(): Promise<number> {
  try {
    const r = ref();
    const snap = await r.get();
    if (!snap.exists) return 0;
    const slots =
      ((snap.data() ?? {}).active_slots as Record<string, unknown>) ?? {};
    const live = liveSlots(slots, new Date());
    const before = Object.keys(slots).length;
    const after = Object.keys(live).length;
    if (after !== before) {
      // Dot-path deletes, for the same reason as in the reserve path: a merged `set` of the live map
      // would leave the expired keys in place and never actually reclaim the space.
      const updates: Record<string, unknown> = {};
      for (const k of Object.keys(slots)) {
        if (!(k in live)) updates[`active_slots.${k}`] = FieldValue.delete();
      }
      await r.update(updates);
      console.log(
        `[OB VOICE CAP] reconcile: expired ${before - after} stale slot(s), ${after} live`
      );
    }
    return after;
  } catch (e) {
    console.warn(`[OB VOICE CAP] reconcileVoiceSlots failed: ${e}`);
    return 0;
  }
}

/** Best-effort count of live slots — observability only. */
export async function activeVoiceCount(): Promise<number> {
  try {
    const snap = await ref().get();
    if (!snap.exists) return 0;
    const slots =
      ((snap.data() ?? {}).active_slots as Record<string, unknown>) ?? {};
    return Object.keys(liveSlots(slots, new Date())).length;
  } catch {
    return 0;
  }
}
