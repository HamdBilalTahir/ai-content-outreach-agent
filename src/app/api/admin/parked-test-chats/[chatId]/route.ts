import { NextResponse } from 'next/server';
import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

// Full read-only detail for one parked E2E test chat: chat fields + the
// message thread (messages_v3, INTERNAL messages included), tasks,
// activities (the unified AI-action timeline), appraisals, and
// notifications. Mirrors the shape the CRM view consumes, but read-only.

function serialize(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

/**
 * Ported from the admin panel with the substitutions established in U4–U6a: `auth()` →
 * `getAuthenticatedUserId()`, and `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing). Query shapes and serialization are
 * the source's.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // A Promise in Next 16; synchronous in the Next 14 the source targets.
  const { chatId } = await params;
  if (!chatId) {
    return NextResponse.json({ error: 'chatId required' }, { status: 400 });
  }

  try {
    const base = adminDb.collection('e2e_test_chats').doc(chatId);
    const [chatSnap, msgSnap, taskSnap, actSnap, apprSnap, notifSnap] =
      await Promise.all([
        base.get(),
        // Fetch the whole subcollection (no orderBy) — Firestore's orderBy
        // silently drops docs missing the sort field, which would hide any
        // inbound message stored without a clean `timestamp`. We sort in memory.
        base.collection('messages_v3').get(),
        base.collection('tasks').get(),
        base.collection('activities').get(),
        base.collection('appraisals').get(),
        base.collection('notifications').get(),
      ]);

    if (!chatSnap.exists) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    const toMs = (v: any): number => {
      if (!v) return 0;
      if (typeof v?.toDate === 'function') return v.toDate().getTime();
      if (typeof v === 'string') {
        const ms = new Date(v).getTime();
        return isNaN(ms) ? 0 : ms;
      }
      if (typeof v === 'number') return v;
      return 0;
    };

    // INTERNAL messages are intentionally kept — this is a debug/review view.
    // ALL directions (inbound / outbound / internal) are included; nothing is
    // filtered. Sorted oldest-first in memory.
    const messages = msgSnap.docs
      .map((d) => {
        const data = d.data();
        const ts = data.timestamp;
        return {
          id: d.id,
          _ms: toMs(ts),
          timestamp:
            ts?.toDate?.()?.toISOString() ??
            (typeof ts === 'string' ? ts : null),
          type: (data.type ?? 'text') as string,
          direction: (data.direction ?? null) as string | null,
          sender: (data.sender ?? null) as { kind?: string } | null,
          content: serialize(data.content ?? null),
          status: (data.status ?? null) as string | null,
          source: (data.source ?? null) as string | null,
          attachments: serialize(data.attachments ?? []),
        };
      })
      .sort((a, b) => a._ms - b._ms)
      // `_ms` is a sort key added above and destructured off here so it does not reach the client. Same
      // omit-by-destructure idiom as elsewhere; this repo's config does not enable `ignoreRestSiblings`.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ _ms, ...m }) => m);

    const tasks = taskSnap.docs
      .map((d) => {
        const r = d.data();
        return {
          id: d.id,
          type: (r.type ?? null) as string | null,
          executed: (r.executed ?? false) as boolean,
          execute_at: r.execute_at?.toDate?.()?.toISOString() ?? null,
          created_at: r.created_at?.toDate?.()?.toISOString() ?? null,
          instructions: (r.data?.instructions ?? null) as string | null,
          phone_number: (r.phone_number ?? null) as string | null,
          aiAction: (r.ai_action ?? false) as boolean,
          data: serialize(r.data ?? null),
          output: serialize(r.output ?? null),
        };
      })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const activities = actSnap.docs.map((d) => ({
      id: d.id,
      ...serialize(d.data()),
    }));

    const appraisals = apprSnap.docs
      .map((d) => ({ id: d.id, ...serialize(d.data()) }))
      .sort((a: any, b: any) =>
        (b.activated_at || b.queued_at || '').localeCompare(
          a.activated_at || a.queued_at || ''
        )
      );

    const notifications = notifSnap.docs
      .map((d) => ({ id: d.id, ...serialize(d.data()) }))
      .sort((a: any, b: any) =>
        String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
      );

    return NextResponse.json(
      {
        chatFields: serialize(chatSnap.data() ?? {}),
        messages,
        tasks,
        activities,
        appraisals,
        notifications,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('[parked-test-chats/:id] error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message },
      { status: 500 }
    );
  }
}
