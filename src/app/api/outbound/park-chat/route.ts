import { NextResponse } from 'next/server';
// Imported rather than reached for as the ambient `FirebaseFirestore` global: `tsc` knows that namespace,
// eslint's no-undef does not. Same fix as the funnel routes in U4.
import type {
  DocumentReference,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { db as adminDb } from '../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../lib/utils/auth';

// Parks (archives + FULLY deletes) the prospect's existing outbound chat(s)
// before a new E2E fire, so the deterministic chat (outbound__{agentId}__{channel})
// truly starts fresh — get_or_create_outbound_chat re-creates it clean instead of
// returning yesterday's history.
//
// The chat id is deterministic, so we target it DIRECTLY (guaranteed hit) rather
// than only fuzzy-matching phone/email. Every subcollection is discovered via
// listCollections() (not a hardcoded list) and the whole doc tree is removed with
// recursiveDelete. Best-effort: failure must not block the fire.

const BATCH_LIMIT = 450;

const phoneKey = (v: unknown) =>
  String(v ?? '')
    .replace(/\D/g, '')
    .slice(-10);
const emailKey = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/**
 * Ported from the admin panel with the substitutions established in U4/U5: `auth()` →
 * `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes, field writes and arithmetic are the source's.
 */

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const agentId = body?.agent_id;
  const phone = body?.phone;
  const email = body?.email;
  if (!agentId || (!phone && !email)) {
    return NextResponse.json(
      { error: 'agent_id and at least one of phone/email are required' },
      { status: 400 }
    );
  }

  try {
    // ── Collect target chat refs ──────────────────────────────────────────
    // 1) Deterministic ids from the known channel keys (the reliable path).
    const digits = String(phone ?? '').replace(/\D/g, '');
    const channelKeys = new Set<string>();
    if (digits) {
      channelKeys.add(digits); // e.g. 19083864637
      if (digits.length > 10) channelKeys.add(digits.slice(-10)); // 9083864637
    }
    if (email) channelKeys.add(emailKey(email));

    const refsById = new Map<string, DocumentReference>();
    Array.from(channelKeys).forEach((key) => {
      const id = `outbound__${agentId}__${key}`;
      refsById.set(id, adminDb.collection('chats').doc(id));
    });

    // 2) Fuzzy fallback — any outbound chat for this agent whose phone/email
    // matches (catches non-standard ids from older runs).
    const snap = await adminDb
      .collection('chats')
      .where('agentId', '==', agentId)
      .where('type', '==', 'outbound')
      .get();
    const targetPhone = phoneKey(phone);
    const targetEmail = emailKey(email);
    snap.docs.forEach((d) => {
      const data = d.data();
      const m = data.memory || {};
      const cPhone = phoneKey(
        data.phone_number ?? m.phone_number ?? m.phone ?? data.userId
      );
      const cEmail = emailKey(
        m.customer_email ?? m.email ?? data.customer_email
      );
      if (
        (!!targetPhone && cPhone === targetPhone) ||
        (!!targetEmail && cEmail === targetEmail)
      ) {
        refsById.set(d.id, d.ref);
      }
    });

    const parkedAt = new Date();
    const parkedIds: string[] = [];

    for (const [chatId, chatRef] of Array.from(refsById.entries())) {
      const chatSnap = await chatRef.get();
      if (!chatSnap.exists) continue;

      // Don't overwrite a prior archive — append a _N suffix per run.
      let destId = chatId;
      let seq = 0;
      while (
        (await adminDb.collection('e2e_test_chats').doc(destId).get()).exists
      ) {
        seq++;
        destId = `${chatId}_${seq}`;
      }
      const destRef = adminDb.collection('e2e_test_chats').doc(destId);

      // Archive: root doc (keep type:"outbound" so the outbound parked view
      // surfaces it) + every subcollection doc (discovered dynamically).
      const subCols = await chatRef.listCollections();
      const writes: { ref: DocumentReference; data: any }[] = [
        {
          ref: destRef,
          data: {
            ...chatSnap.data(),
            // Mark the archive non-active so the task cron's status gate
            // (parent status present && != 'active') skips its tasks — the
            // same fix as the e2e park route. Tasks are archived as-is.
            status: 'archived',
            _parked_at: parkedAt,
            _original_id: chatId,
            _park_seq: seq,
            _oversee: false,
          },
        },
      ];
      for (const col of subCols) {
        const s = await col.get();
        s.docs.forEach((sub: QueryDocumentSnapshot) => {
          writes.push({
            ref: destRef.collection(col.id).doc(sub.id),
            data: sub.data(),
          });
        });
      }
      for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
        const batch = adminDb.batch();
        writes
          .slice(i, i + BATCH_LIMIT)
          .forEach((w) => batch.set(w.ref, w.data));
        await batch.commit();
      }

      // Completely delete the live chat: root doc + ALL subcollections, recursively.
      await adminDb.recursiveDelete(chatRef);

      parkedIds.push(destId);
    }

    return NextResponse.json({
      success: true,
      parked_count: parkedIds.length,
      chat_ids: parkedIds,
    });
  } catch (err: any) {
    console.error('[outbound/park-chat] error:', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to park outbound chat' },
      { status: 500 }
    );
  }
}
