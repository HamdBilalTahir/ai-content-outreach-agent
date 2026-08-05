'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from 'firebase/firestore';
import { Phone, Mail, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '../../../../lib/firebase/client';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import type { ChatData, ChatMessage, ChatTask, FeedItem } from './types';
import {
  deepFindNumber,
  deepFindString,
  sectionCard,
  serializeValue,
} from './helpers';
import { MessageBubble } from './MessageBubble';
import { AiComposer } from './AiComposer';
import { AccordionSection } from './AccordionSection';
import { StageFunnel } from './StageFunnel';
import { ActivityCard } from './ActivityCard';
import { TaskCard } from './TaskCard';

// Map a raw messages_v3 doc → ChatMessage (same shape the monitoring route
// produces, so downstream rendering/derivations are identical).
function mapMessage(id: string, data: any): ChatMessage {
  const ts = data.timestamp;
  return {
    id,
    timestamp:
      ts?.toDate?.()?.toISOString() ?? (typeof ts === 'string' ? ts : null),
    type: (data.type ?? 'text') as string,
    direction: (data.direction ?? null) as string | null,
    sender: (data.sender ?? null) as { kind?: string } | null,
    content: serializeValue(data.content ?? null) as Record<string, any> | null,
    status: (data.status ?? null) as string | null,
    source: (data.source ?? null) as string | null,
    attachments: (data.attachments ?? []) as any[],
  };
}

function mapTask(id: string, raw: any): ChatTask {
  return {
    id,
    type: (raw.type ?? null) as string | null,
    executed: (raw.executed ?? false) as boolean,
    permanent_failure: (raw.permanent_failure ?? false) as boolean,
    execute_at:
      raw.execute_at?.toDate?.()?.toISOString() ??
      (typeof raw.execute_at === 'string' ? raw.execute_at : null),
    created_at:
      raw.created_at?.toDate?.()?.toISOString() ??
      (typeof raw.created_at === 'string' ? raw.created_at : null),
    instructions: (raw.data?.instructions ?? null) as string | null,
    taskData: raw.data ? serializeValue(raw.data) : null,
    output: raw.output ? serializeValue(raw.output) : null,
  };
}

// Self-contained conversation + activities view for a single outbound chat.
// Given a chatId it subscribes live (Firestore onSnapshot) to the chat doc +
// messages_v3/tasks/activities/notifications and renders the conversation window
// + the Stage/Activities/Scheduled/Notes accordion sidebar — the same body the
// E2E test client shows for an open run, minus the run header / pause controls.
export default function ChatDetailView({
  chatId,
  className,
}: {
  chatId: string | null;
  className?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<ChatTask[]>([]);
  const [activitiesRaw, setActivitiesRaw] = useState<Record<string, any>[]>([]);
  const [notifications, setNotifications] = useState<Record<string, any>[]>([]);
  const [chatFields, setChatFields] = useState<Record<string, any>>({});
  const [loaded, setLoaded] = useState(false);
  // Optimistic overrides for the opt-out checkboxes: the write goes through the admin API,
  // so the live snapshot only reflects it after a round-trip — show the toggle immediately
  // and reconcile on the next snapshot. Cleared when the chat changes.
  const [optOverride, setOptOverride] = useState<{
    phone?: boolean;
    email?: boolean;
  }>({});

  const [copiedId, setCopiedId] = useState(false);

  // Detail sidebar state.
  const [activeSection, setActiveSection] = useState<string>('activities');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(
    new Set()
  );
  const toggleSection = useCallback((key: string) => {
    setActiveSection((prev) => (prev === key ? '' : key));
  }, []);

  // Conversation auto-scroll: stick to the newest message unless the user has
  // scrolled up.
  const convScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Live subscriptions for the open chat (client SDK) — instant from Firestore's
  // local cache on re-open, then live. Only the active chat is subscribed.
  useEffect(() => {
    if (!chatId) {
      setLoaded(false);
      return;
    }
    setLoaded(false);
    setOptOverride({});
    setMessages([]);
    setTasks([]);
    setActivitiesRaw([]);
    setNotifications([]);
    setChatFields({});
    stickToBottomRef.current = true;

    const onErr = (label: string) => (e: unknown) =>
      console.error(`[chat-detail] ${label} listener error`, e);

    const unsubs: Unsubscribe[] = [
      onSnapshot(
        query(
          collection(db, 'chats', chatId, 'messages_v3'),
          orderBy('timestamp', 'asc'),
          limit(150)
        ),
        (snap) => {
          setMessages(snap.docs.map((d) => mapMessage(d.id, d.data())));
          setLoaded(true);
        },
        onErr('messages')
      ),
      onSnapshot(
        query(
          collection(db, 'chats', chatId, 'tasks'),
          orderBy('execute_at', 'asc')
        ),
        (snap) => setTasks(snap.docs.map((d) => mapTask(d.id, d.data()))),
        onErr('tasks')
      ),
      onSnapshot(
        collection(db, 'chats', chatId, 'activities'),
        (snap) =>
          setActivitiesRaw(
            snap.docs.map((d) => ({ id: d.id, ...serializeValue(d.data()) }))
          ),
        onErr('activities')
      ),
      onSnapshot(
        collection(db, 'chats', chatId, 'notifications'),
        (snap) =>
          setNotifications(
            snap.docs.map((d) => ({ id: d.id, ...serializeValue(d.data()) }))
          ),
        onErr('notifications')
      ),
      onSnapshot(
        doc(db, 'chats', chatId),
        (snap) => setChatFields(serializeValue(snap.data() ?? {})),
        onErr('chat')
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [chatId]);

  const chatData = useMemo<ChatData | null>(
    () =>
      loaded
        ? {
            messages,
            tasks,
            activities: activitiesRaw,
            notifications,
            chatFields,
          }
        : null,
    [loaded, messages, tasks, activitiesRaw, notifications, chatFields]
  );

  const currentStage =
    (chatData?.chatFields?.stage as string | undefined) ?? null;
  const allMessages = chatData?.messages ?? [];

  // Keep the conversation pinned to the newest message unless the user scrolled up.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = convScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [allMessages.length, chatId]);

  const activityTime = (a: Record<string, any>) =>
    new Date(a.timestamp || a.created_at || a.createdAt || 0).getTime();
  const activities = [...(chatData?.activities ?? [])].sort(
    (a, b) => activityTime(b) - activityTime(a)
  );
  const notes = chatData?.notifications ?? [];

  // Opt-out status from the chat doc's top-level flags (+ memory/label fallbacks).
  const cf = (chatData?.chatFields ?? {}) as Record<string, any>;
  const optMem = (cf.memory ?? {}) as Record<string, any>;
  const optLabels: string[] = Array.isArray(cf.labels) ? cf.labels : [];
  // Contact name — same precedence as the contact-list route (memory first).
  const contactName =
    [optMem.first_name, optMem.last_name].filter(Boolean).join(' ') ||
    (cf.display_name as string) ||
    (optMem.display_name as string) ||
    (optMem.contact_name as string) ||
    (optMem.phone as string) ||
    (cf.phone as string) ||
    '';
  const phoneOptOut =
    cf.phone_opt_out === true ||
    cf.block_phone === true ||
    String(optMem.block_phone ?? '').toUpperCase() === 'Y' ||
    String(optMem.phone_opt_out ?? '').toUpperCase() === 'Y';
  const emailOptOut =
    cf.email_opt_out === true ||
    optMem._email_opt_out === true ||
    optLabels.includes('email_opted_out');
  // Effective (optimistic override wins until the next snapshot reconciles it).
  const phoneOptOutView = optOverride.phone ?? phoneOptOut;
  const emailOptOutView = optOverride.email ?? emailOptOut;

  const setOptOut = useCallback(
    async (channel: 'phone' | 'email', value: boolean) => {
      if (!chatId) return;
      setOptOverride((prev) => ({ ...prev, [channel]: value }));
      try {
        const res = await fetch('/api/outbound/opt-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            [`${channel}_opt_out`]: value,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || `Request failed (${res.status})`);
        }
      } catch (e: any) {
        // Revert the optimistic toggle on failure.
        setOptOverride((prev) => ({ ...prev, [channel]: undefined }));
        toast.error(e?.message || `Could not update ${channel} opt-out`);
      }
    },
    [chatId]
  );
  // Drop each optimistic override once the live snapshot agrees with it.
  useEffect(() => {
    setOptOverride((prev) => {
      let changed = false;
      const next = { ...prev };
      if (next.phone !== undefined && next.phone === phoneOptOut) {
        delete next.phone;
        changed = true;
      }
      if (next.email !== undefined && next.email === emailOptOut) {
        delete next.email;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [phoneOptOut, emailOptOut]);

  // Map call_id → review_call_transcript result (for the transcript popup) and
  // call_id → recording_url so the call bubble can play the recording inline.
  // The recording_url can be nested anywhere in a tool result (make_phone_call /
  // review_call_transcript), so deep-scan each activity rather than guessing a path.
  const transcriptByCallId: Record<string, any> = {};
  const recordingByCallId: Record<string, string> = {};
  const durationByCallId: Record<string, number> = {};
  for (const a of activities) {
    const tc = a.toolCall ?? a.tool_call ?? {};
    const tool = (tc.toolName ?? tc.tool_name ?? '').toLowerCase();
    const res = tc.result ?? tc.output ?? {};
    const cid =
      res?.call_id ??
      res?.callId ??
      deepFindString(a, ['call_id', 'callId', 'conversation_id']);
    if (!cid) continue;
    if (tool.includes('transcript')) transcriptByCallId[cid] = res;
    const url = deepFindString(a, [
      'recording_url',
      'recordingUrl',
      'audio_url',
      'audioUrl',
    ]);
    if (url && !recordingByCallId[cid]) recordingByCallId[cid] = url;
    const durSec =
      deepFindNumber(a, [
        'call_duration_secs',
        'duration_secs',
        'call_duration',
      ]) ?? deepFindNumber(a, ['duration']);
    if (durSec && !durationByCallId[cid]) durationByCallId[cid] = durSec;
  }

  // The chat is reused per prospect (deterministic id), so re-firing the test
  // piles up duplicate tasks of the same type. Keep the latest task per type —
  // this collapses re-fire duplicates but preserves a real multi-step sequence
  // (outreach / follow-up / confirm use distinct types).
  const dedupeByType = (list: ChatTask[]): ChatTask[] => {
    const byType: Record<string, ChatTask> = {};
    for (const t of list) {
      const key = t.type ?? '—';
      const ts = t.created_at ?? t.execute_at ?? '';
      const cur = byType[key];
      if (!cur || (cur.created_at ?? cur.execute_at ?? '') < ts)
        byType[key] = t;
    }
    return Object.values(byType);
  };

  // A task is "scheduled" only if it's an upcoming follow-up: not yet run, not
  // permanently failed, and its execute_at is in the future. Everything else
  // (done / failed / pending-but-not-scheduled) belongs in the Activities feed.
  const nowMs = Date.now();
  const isScheduled = (t: ChatTask) =>
    !t.executed &&
    !t.permanent_failure &&
    !!t.execute_at &&
    new Date(t.execute_at).getTime() > nowMs;

  const rawTasks = chatData?.tasks ?? [];
  // Scheduled: soonest-up first.
  const scheduledTasks: ChatTask[] = dedupeByType(
    rawTasks.filter(isScheduled)
  ).sort((a, b) => (a.execute_at ?? '').localeCompare(b.execute_at ?? ''));
  // The rest fold into Activities (rendered as task cards, status = done/failed/pending).
  const activityTasks: ChatTask[] = dedupeByType(
    rawTasks.filter((t) => !isScheduled(t))
  );

  // Unified Activities feed: tool-call activities + non-scheduled tasks, newest first.
  const taskTime = (t: ChatTask) =>
    new Date(t.execute_at ?? t.created_at ?? 0).getTime();
  const activityFeed: FeedItem[] = [
    ...activities.map((a) => ({
      kind: 'activity' as const,
      ts: activityTime(a),
      id: a.id as string,
      data: a,
    })),
    ...activityTasks.map((t) => ({
      kind: 'task' as const,
      ts: taskTime(t),
      id: t.id,
      data: t,
    })),
  ].sort((a, b) => b.ts - a.ts);

  if (!chatId) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center',
          className
        )}
      >
        <p className="text-[14px] font-medium text-gray-500">
          Select a contact to view the conversation
        </p>
        <p className="text-[12px] text-gray-400">
          The conversation and activities will appear here.
        </p>
      </div>
    );
  }

  // Skeleton that mirrors the loaded layout so switching contacts is seamless
  // (no blank flash / layout jump) while the chat fetch is in flight.
  if (!chatData) {
    const blk = 'animate-pulse rounded-md bg-gray-200/70';
    const bubbles = [
      { w: 'w-2/3', me: false },
      { w: 'w-1/2', me: true },
      { w: 'w-3/5', me: false },
      { w: 'w-2/5', me: true },
      { w: 'w-1/2', me: false },
    ];
    return (
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-5 xl:flex-row',
          className
        )}
      >
        <div
          className={cn(
            sectionCard,
            '!p-0 flex min-h-0 min-w-0 flex-1 flex-col'
          )}
        >
          <div className="flex shrink-0 items-center border-b border-gray-100 px-5 py-3">
            <div className={cn(blk, 'h-4 w-28')} />
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-5">
            {bubbles.map((b, i) => (
              <div key={i} className={cn('flex', b.me && 'justify-end')}>
                <div className={cn(blk, 'h-12', b.w)} />
              </div>
            ))}
          </div>
          <div className="border-t border-gray-100 p-3">
            <div className={cn(blk, 'h-10 w-full rounded-xl')} />
          </div>
        </div>

        <div
          className={cn(
            sectionCard,
            '!p-0 flex w-full shrink-0 flex-col gap-px overflow-hidden xl:min-h-0 xl:w-96'
          )}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5"
            >
              <div className={cn(blk, 'h-3.5 w-24')} />
              <div className={cn(blk, 'size-4 rounded')} />
            </div>
          ))}
          <div className="space-y-2 p-4">
            <div className={cn(blk, 'h-16 w-full rounded-xl')} />
            <div className={cn(blk, 'h-16 w-full rounded-xl')} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-5 xl:flex-row',
        className
      )}
    >
      <div
        className={cn(sectionCard, '!p-0 flex min-h-0 min-w-0 flex-1 flex-col')}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-800">
              <span className="truncate">{contactName || 'Conversation'}</span>
              <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                {allMessages.length}
              </span>
            </div>
            {chatId && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(chatId);
                  setCopiedId(true);
                  toast.success('Chat ID copied');
                  window.setTimeout(() => setCopiedId(false), 1500);
                }}
                title="Copy chat ID"
                className="group flex min-w-0 cursor-pointer items-center gap-1 text-left font-mono text-[10px] text-gray-400 transition-colors hover:text-gray-600"
              >
                <span className="truncate">{chatId}</span>
                {copiedId ? (
                  <Check className="size-3 shrink-0 text-emerald-500" />
                ) : (
                  <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                )}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-500">
              <Checkbox
                checked={phoneOptOutView}
                onCheckedChange={(v) => setOptOut('phone', v === true)}
                className="size-3.5 cursor-pointer data-[state=checked]:border-rose-500 data-[state=checked]:bg-rose-500"
              />
              <Phone className="size-3 text-gray-400" />
              Phone opt-out
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-500">
              <Checkbox
                checked={emailOptOutView}
                onCheckedChange={(v) => setOptOut('email', v === true)}
                className="size-3.5 cursor-pointer data-[state=checked]:border-rose-500 data-[state=checked]:bg-rose-500"
              />
              <Mail className="size-3 text-gray-400" />
              Email opt-out
            </label>
          </div>
        </div>
        <div
          ref={convScrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5"
        >
          {allMessages.length === 0 ? (
            <p className="py-2 text-[12px] text-gray-400">No messages yet.</p>
          ) : (
            allMessages.map((m) => (
              <MessageBubble
                key={m.id}
                m={m}
                transcript={
                  m.type === 'call'
                    ? transcriptByCallId[
                        m.content?.callId ?? m.content?.call_id ?? ''
                      ]
                    : undefined
                }
                recordingUrl={
                  m.type === 'call'
                    ? recordingByCallId[
                        m.content?.callId ?? m.content?.call_id ?? ''
                      ]
                    : undefined
                }
                durationHint={
                  m.type === 'call'
                    ? durationByCallId[
                        m.content?.callId ?? m.content?.call_id ?? ''
                      ]
                    : undefined
                }
              />
            ))
          )}
        </div>
        <AiComposer chatId={chatId} onSent={() => {}} />
      </div>

      <div
        className={cn(
          sectionCard,
          '!p-0 flex w-full shrink-0 flex-col overflow-y-auto xl:min-h-0 xl:w-96'
        )}
      >
        <AccordionSection
          title="Stage"
          open={activeSection === 'stage'}
          onToggle={() => toggleSection('stage')}
        >
          <StageFunnel currentStage={currentStage} />
        </AccordionSection>

        <AccordionSection
          title="Activities"
          count={activityFeed.length}
          open={activeSection === 'activities'}
          onToggle={() => toggleSection('activities')}
        >
          {activityFeed.length === 0 ? (
            <p className="py-1 text-[12px] text-gray-400">No activities yet.</p>
          ) : (
            <div className="space-y-2">
              {activityFeed.map((item) =>
                item.kind === 'activity' ? (
                  <ActivityCard
                    key={`a-${item.id}`}
                    activity={item.data}
                    expanded={expandedActivities.has(item.id)}
                    onToggle={() =>
                      setExpandedActivities((prev) => {
                        const next = new Set(prev);
                        next.has(item.id)
                          ? next.delete(item.id)
                          : next.add(item.id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <TaskCard
                    key={`t-${item.id}`}
                    task={item.data}
                    expanded={expandedTasks.has(item.id)}
                    onToggle={() =>
                      setExpandedTasks((prev) => {
                        const next = new Set(prev);
                        next.has(item.id)
                          ? next.delete(item.id)
                          : next.add(item.id);
                        return next;
                      })
                    }
                  />
                )
              )}
            </div>
          )}
        </AccordionSection>

        <AccordionSection
          title="Scheduled"
          count={scheduledTasks.length}
          open={activeSection === 'scheduled'}
          onToggle={() => toggleSection('scheduled')}
        >
          {scheduledTasks.length === 0 ? (
            <p className="py-1 text-[12px] text-gray-400">
              No scheduled tasks yet.
            </p>
          ) : (
            <div className="space-y-2">
              {scheduledTasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  expanded={expandedTasks.has(t.id)}
                  onToggle={() =>
                    setExpandedTasks((prev) => {
                      const next = new Set(prev);
                      next.has(t.id) ? next.delete(t.id) : next.add(t.id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          )}
        </AccordionSection>

        <AccordionSection
          title="Notes"
          count={notes.length}
          open={activeSection === 'notes'}
          onToggle={() => toggleSection('notes')}
        >
          {notes.length === 0 ? (
            <p className="py-1 text-[12px] text-gray-400">No notes yet.</p>
          ) : (
            <div className="space-y-2">
              {notes.map((n) => {
                const ts = n.timestamp || n.created_at || n.createdAt;
                const text = n.body || n.message || n.text || n.content;
                return (
                  <div
                    key={n.id}
                    className="rounded-xl border border-gray-200 bg-gray-50 p-3"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-medium text-gray-700">
                        {n.title || n.type || 'Note'}
                      </span>
                      <span className="shrink-0 text-gray-400">
                        {ts ? new Date(ts).toLocaleString() : ''}
                      </span>
                    </div>
                    {text && typeof text === 'string' && (
                      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-gray-600">
                        {text}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </AccordionSection>
      </div>
    </div>
  );
}
