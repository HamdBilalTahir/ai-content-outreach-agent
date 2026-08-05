import { NextResponse } from 'next/server';
import { db as adminDb } from '../../../../../../lib/firebase/admin';
import { getAuthenticatedUserId } from '../../../../../../lib/utils/auth';

function serializeValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

/**
 * Ported from the admin panel with the substitutions established in U4/U5: `auth()` →
 * `getAuthenticatedUserId()`, `adminDb` → this repo's `db` (its null guard dropped, since
 * `lib/firebase/admin.ts` throws at import when its env is missing), and `@/lib/chat-utils` →
 * `@/lib/utils`. Query shapes, field writes and arithmetic are the source's.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');
  if (!chatId) {
    return NextResponse.json({ error: 'chatId required' }, { status: 400 });
  }

  // Fields on chat docs that are internal/noisy and not useful to display
  const SKIP_FIELDS = new Set([
    'agent_id',
    'attendee_id',
    'last_message',
    'last_message_at',
    'created_at',
    'updated_at',
    'is_deleted',
    'dealer_id',
    'id',
    'phone_number',
    'thread_id',
    'conversation_id',
    'unread_count',
    'last_read_at',
    'tags',
    'metadata',
    'embedding',
  ]);

  try {
    const [
      messagesSnap,
      tasksSnap,
      activitiesSnap,
      notificationsSnap,
      chatSnap,
    ] = await Promise.all([
      adminDb
        .collection('chats')
        .doc(chatId)
        .collection('messages_v3')
        .orderBy('timestamp', 'asc')
        .limit(150)
        .get(),
      adminDb
        .collection('chats')
        .doc(chatId)
        .collection('tasks')
        .orderBy('execute_at', 'asc')
        .get(),
      adminDb.collection('chats').doc(chatId).collection('activities').get(),
      adminDb.collection('chats').doc(chatId).collection('notifications').get(),
      adminDb.collection('chats').doc(chatId).get(),
    ]);

    const messages = messagesSnap.docs.map((d) => {
      const data = d.data();
      const ts = data.timestamp;
      return {
        id: d.id,
        timestamp:
          ts?.toDate?.()?.toISOString() ?? (typeof ts === 'string' ? ts : null),
        type: (data.type ?? 'text') as string,
        direction: (data.direction ?? null) as string | null,
        sender: (data.sender ?? null) as { kind?: string } | null,
        content: (data.content ?? null) as Record<string, any> | null,
        status: (data.status ?? null) as string | null,
        source: (data.source ?? null) as string | null,
        attachments: (data.attachments ?? []) as any[],
      };
    });

    const tasks = tasksSnap.docs.map((d) => {
      const raw = d.data();
      return {
        id: d.id,
        type: (raw.type ?? null) as string | null,
        executed: (raw.executed ?? false) as boolean,
        permanent_failure: (raw.permanent_failure ?? false) as boolean,
        execute_at: raw.execute_at?.toDate?.()?.toISOString() ?? null,
        created_at: raw.created_at?.toDate?.()?.toISOString() ?? null,
        instructions: (raw.data?.instructions ?? null) as string | null,
        phone_number: (raw.phone_number ?? null) as string | null,
        aiAction: (raw.ai_action ?? false) as boolean,
        taskData: raw.data ? serializeValue(raw.data) : null,
        output: raw.output ? serializeValue(raw.output) : null,
      };
    });

    const activities = activitiesSnap.docs.map((d) => ({
      id: d.id,
      ...(serializeValue(d.data()) as Record<string, any>),
    }));
    const notifications = notificationsSnap.docs.map((d) => ({
      id: d.id,
      ...(serializeValue(d.data()) as Record<string, any>),
    }));

    // Extract all chat-level fields for the "Fields" tab
    const chatRaw = chatSnap.data() ?? {};
    const chatFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(chatRaw)) {
      if (!SKIP_FIELDS.has(k)) chatFields[k] = serializeValue(v);
    }

    return NextResponse.json(
      { messages, tasks, activities, notifications, chatFields },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('[monitoring/chat] GET error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}
