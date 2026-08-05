'use client';

// Namespace import as well: the file annotates a prop with `React.ReactNode`, and this repo's eslint
// flags the ambient namespace as `no-undef`.
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  Sparkles,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AudioPlayer } from '@/components/outbound/chat-detail/AudioPlayer';
import { CallTranscriptModal } from '@/components/outbound/chat-detail/CallTranscriptModal';
import { fetchTranscriptText } from '@/components/outbound/chat-detail/helpers';

// ── Types (match the read-only API responses) ──────────────────────
interface ChatSummary {
  id: string;
  name: string;
  phone: string;
  email: string;
  vehicle: string;
  vehicleDetails: string;
  stage: string;
  dealerName: string;
  dealersId: string | number | null;
  offer: number;
  isCertificateOffer: boolean;
  parkedAt: string | null;
  updatedAt: string | null;
}

interface Message {
  id: string;
  timestamp: string | null;
  type: string;
  direction: string | null;
  sender: { kind?: string } | null;
  content: any;
  status: string | null;
  source: string | null;
  attachments: any[];
}

interface Task {
  id: string;
  type: string | null;
  executed: boolean;
  execute_at: string | null;
  created_at: string | null;
  instructions: string | null;
  phone_number: string | null;
  aiAction: boolean;
  data: any;
  output: any;
}

interface Activity {
  id: string;
  timestamp?: any;
  kind?: string;
  toolCall?: {
    toolName?: string;
    input?: any;
    result?: any;
    status?: string;
  };
  [key: string]: any;
}

interface Detail {
  chatFields: Record<string, any>;
  messages: Message[];
  tasks: Task[];
  activities: Activity[];
  appraisals: any[];
  notifications: any[];
}

type RightTab = 'info' | 'vehicle' | 'activity' | 'notifications';

// ── Helpers ─────────────────────────────────────────────────────────
function initialsOf(name: string): string {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U'
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  // Future timestamps (e.g. a pending task's scheduled execute_at) read as
  // "in Xh", not "just now".
  const future = diff < 0;
  const abs = Math.abs(diff);
  const label = (n: number, u: string) =>
    future ? `in ${n}${u}` : `${n}${u} ago`;
  const min = Math.floor(abs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return label(min, 'm');
  const hr = Math.floor(min / 60);
  if (hr < 24) return label(hr, 'h');
  const day = Math.floor(hr / 24);
  if (day < 30) return label(day, 'd');
  return d.toLocaleDateString();
}

function money(n: number): string {
  if (!n) return '—';
  return `$${n.toLocaleString()}`;
}

function stageBadge(stage: string): string {
  switch (stage) {
    case 'New':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'Contacted':
      return 'bg-yellow-50 text-yellow-700 border-yellow-200';
    case 'Engaged':
      return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'Lead':
      return 'bg-orange-50 text-orange-700 border-orange-200';
    case 'Won':
    case 'CRM Won':
    case 'Validated Won':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'Lost':
      return 'bg-red-50 text-red-700 border-red-200';
    default:
      return 'bg-slate-50 text-slate-600 border-slate-200';
  }
}

function humanize(s?: string | null): string {
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function bodyOf(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.body || content.text || content.summary || '';
}

// ── Component ───────────────────────────────────────────────────────
export default function ParkedTestChatsClient({
  listQuery = '',
  heading = 'Parked Test Chats',
}: {
  listQuery?: string;
  heading?: string;
} = {}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [tab, setTab] = useState<RightTab>('info');
  // Internal system notes are shown by default (full archive); the toggle hides
  // them when the reviewer wants just the customer↔AI↔human conversation.
  const [showInternal, setShowInternal] = useState(true);
  const threadRef = useRef<HTMLDivElement>(null);

  const fetchList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetch(`/api/admin/parked-test-chats${listQuery}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load parked chats');
      const data = await res.json();
      setChats(data.chats || []);
    } catch (e: any) {
      setListError(e?.message || 'Failed to load');
    } finally {
      setLoadingList(false);
    }
  }, [listQuery]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetail(null);
    setTab('info');
    fetch(`/api/admin/parked-test-chats/${selectedId}`, {
      credentials: 'include',
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Land at the latest message once the thread has actually rendered — gate on
  // !loadingDetail (otherwise the spinner is still up and there's nothing to
  // scroll) and defer to the next frame so layout/height is settled.
  useEffect(() => {
    if (!detail || loadingDetail) return;
    const id = requestAnimationFrame(() => {
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [detail, loadingDetail, selectedId, showInternal]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return chats;
    return chats.filter((c) =>
      [c.name, c.phone, c.email, c.vehicle].some((v) =>
        (v || '').toLowerCase().includes(s)
      )
    );
  }, [chats, search]);

  const selected = chats.find((c) => c.id === selectedId) || null;

  // Map call_id → review_call_transcript result so a call bubble can expand
  // its transcript inline. (No full turn-by-turn transcript is archived; this
  // is the structured review: summary, quotes, confirmed fields, changes.)
  const transcriptByCallId = useMemo(() => {
    const map: Record<string, any> = {};
    for (const a of detail?.activities ?? []) {
      const tool = a.toolCall?.toolName || '';
      const res = a.toolCall?.result;
      const cid = res?.call_id || res?.callId;
      if (tool.toLowerCase().includes('transcript') && cid) map[cid] = res;
    }
    return map;
  }, [detail]);

  return (
    <div className="flex h-full overflow-hidden bg-slate-50 text-[13px] text-slate-700 md:h-screen">
      {/* ── Left: parked chat list ── */}
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Archive className="size-4 text-slate-500" />
              <h1 className="text-sm font-bold tracking-tight text-slate-900">
                {heading}
              </h1>
            </div>
            <button
              onClick={fetchList}
              aria-label="Refresh"
              className="flex size-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <RefreshCw
                className={cn('size-3.5', loadingList && 'animate-spin')}
              />
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Read-only archive of E2E test conversations.
          </p>
          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, vehicle…"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2.5 text-xs text-slate-700 transition focus:border-slate-300 focus:bg-white focus:outline-none"
            />
          </div>
        </div>

        <div className="dark-scrollbar min-h-0 flex-1 overflow-y-auto">
          {loadingList ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : listError ? (
            <div className="px-4 py-10 text-center text-xs text-rose-600">
              {listError}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-slate-400">
              {chats.length === 0
                ? 'No parked chats yet. Run an E2E test against a phone that already has a chat.'
                : 'No matches.'}
            </div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'flex w-full items-start gap-3 border-b border-slate-50 px-4 py-3 text-left transition-colors',
                  selectedId === c.id ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                )}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-600">
                  {initialsOf(c.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold text-slate-900">
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[10px] font-medium text-slate-400">
                      {fmtRelative(c.parkedAt || c.updatedAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                    {c.vehicle || c.phone || '—'}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <span
                      className={cn(
                        'rounded-full border px-1.5 py-px text-[9px] font-semibold',
                        stageBadge(c.stage)
                      )}
                    >
                      {c.stage}
                    </span>
                    {c.offer > 0 && (
                      <span
                        className={cn(
                          'text-[10px] font-semibold',
                          c.isCertificateOffer
                            ? 'text-emerald-600'
                            : 'text-slate-500'
                        )}
                      >
                        {money(c.offer)}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          {filtered.length} parked chat{filtered.length === 1 ? '' : 's'}
        </div>
      </div>

      {/* ── Center: thread ── */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Select a parked chat to view its conversation.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-3.5">
              <span className="flex size-9 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                {initialsOf(selected.name)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">
                  {selected.name}
                </div>
                <div className="truncate text-[11px] text-slate-500">
                  {selected.phone}
                  {selected.dealerName ? ` · ${selected.dealerName}` : ''}
                </div>
              </div>
              <button
                onClick={() => setShowInternal((v) => !v)}
                className={cn(
                  'ml-auto rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors',
                  showInternal
                    ? 'border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200'
                    : 'border-slate-200 bg-white text-slate-400 hover:text-slate-600'
                )}
                title="Toggle internal system notes"
              >
                {showInternal ? 'Internal notes: on' : 'Internal notes: off'}
              </button>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                  stageBadge(selected.stage)
                )}
              >
                {selected.stage}
              </span>
            </div>

            <div
              ref={threadRef}
              className="dark-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5"
            >
              {loadingDetail ? (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
                  <Loader2 className="size-4 animate-spin" /> Loading
                  conversation…
                </div>
              ) : !detail || detail.messages.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  No messages in this conversation.
                </div>
              ) : (
                detail.messages
                  .filter((m) => showInternal || m.direction !== 'internal')
                  .map((m) => (
                    <MessageBubble
                      key={m.id}
                      m={m}
                      transcript={
                        m.content?.callId
                          ? transcriptByCallId[m.content.callId]
                          : undefined
                      }
                    />
                  ))
              )}
            </div>
            <div className="shrink-0 border-t border-slate-100 bg-slate-50 px-6 py-2.5 text-center text-[11px] text-slate-400">
              Read-only — this conversation is archived and cannot be replied
              to.
            </div>
          </>
        )}
      </div>

      {/* ── Right: detail tabs ── */}
      {selected && (
        <div className="flex w-96 shrink-0 flex-col border-l border-slate-200 bg-white">
          <div className="flex border-b border-slate-200">
            {(
              ['info', 'vehicle', 'activity', 'notifications'] as RightTab[]
            ).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'flex-1 px-2 py-2.5 text-[11px] font-semibold capitalize transition-colors',
                  tab === t
                    ? 'border-b-2 border-indigo-500 text-slate-900'
                    : 'text-slate-400 hover:text-slate-600'
                )}
              >
                {t}
                {t === 'activity' && detail
                  ? ` ${detail.activities.length + detail.tasks.length}`
                  : ''}
                {t === 'notifications' && detail
                  ? ` ${detail.notifications.length}`
                  : ''}
              </button>
            ))}
          </div>
          <div className="dark-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            {loadingDetail || !detail ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : tab === 'info' ? (
              <InfoTab summary={selected} fields={detail.chatFields} />
            ) : tab === 'vehicle' ? (
              <VehicleTab
                appraisal={detail.appraisals[0]}
                memory={detail.chatFields?.memory}
              />
            ) : tab === 'activity' ? (
              <ActivityTab
                activities={detail.activities}
                tasks={detail.tasks}
              />
            ) : (
              <NotificationsTab notifications={detail.notifications} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────
function MessageBubble({ m, transcript }: { m: Message; transcript?: any }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [copiedTx, setCopiedTx] = useState(false);
  const isInternal = m.direction === 'internal';
  // A human agent message in messages_v3 has sender.kind === "admin".
  const isHuman = m.sender?.kind === 'admin';
  const isOutbound =
    m.direction === 'outbound' || m.sender?.kind === 'ai' || isHuman;
  const isCall = m.type === 'call';
  const body = bodyOf(m.content);
  const channel = (m.source || '').toUpperCase().includes('WEB')
    ? 'WEB'
    : 'SMS';

  if (isInternal) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[80%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
          <span className="mr-1.5 font-semibold uppercase tracking-wide text-slate-400">
            Internal
          </span>
          {body || '(no content)'}
          {m.timestamp && (
            <span className="ml-2 text-[10px] text-slate-300">
              {fmtTime(m.timestamp)}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (isCall) {
    const summary = m.content?.summary || m.content?.transcript_summary || '';
    const callId =
      m.content?.callId ?? m.content?.call_id ?? m.content?.conversation_id;
    const explicitRecording =
      m.content?.recordingUrl ||
      m.content?.recording_url ||
      transcript?.recording_url ||
      transcript?.recordingUrl ||
      '';
    // Prefer an explicit recording URL; otherwise stream the ElevenLabs
    // conversation audio by call_id via our proxy (same as the campaign inbox).
    const recordingUrl =
      explicitRecording ||
      (callId
        ? `/api/elevenlabs/conversations/${encodeURIComponent(callId)}/audio`
        : undefined);
    // Show the transcript/recording controls once we can fetch or play something.
    const hasCallDetail = !!callId || !!recordingUrl || !!transcript;
    return (
      <div className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
        <div className="max-w-[78%] rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-[12px] text-violet-800">
          <div className="flex items-center gap-2">
            <Phone className="size-3.5" />
            <span className="font-medium">
              {m.content?.outcome ? humanize(m.content.outcome) : 'Phone call'}
            </span>
            {m.timestamp && (
              <span className="text-[10px] text-violet-400">
                {fmtTime(m.timestamp)}
              </span>
            )}
          </div>
          {summary && (
            <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-violet-700">
              {summary}
            </p>
          )}
          {hasCallDetail && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowTranscript(true)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-violet-300 bg-white px-2 py-1 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100"
                >
                  <FileText className="size-3" /> View transcript
                </button>
                {callId && (
                  <button
                    type="button"
                    title="Copy transcript"
                    onClick={async () => {
                      try {
                        const text = await fetchTranscriptText(callId);
                        await navigator.clipboard?.writeText(text);
                        setCopiedTx(true);
                        setTimeout(() => setCopiedTx(false), 1500);
                      } catch {
                        /* no transcript to copy */
                      }
                    }}
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors',
                      copiedTx
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-violet-200 bg-white text-violet-600 hover:bg-violet-100'
                    )}
                  >
                    {copiedTx ? (
                      <>
                        <Check className="size-3 text-emerald-600" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="size-3" /> Copy
                      </>
                    )}
                  </button>
                )}
              </div>
              {recordingUrl && (
                <AudioPlayer
                  src={recordingUrl}
                  durationHint={m.content?.duration}
                />
              )}
            </div>
          )}
          {showTranscript && (
            <CallTranscriptModal
              transcript={transcript}
              recordingUrl={explicitRecording || undefined}
              callId={callId}
              onClose={() => setShowTranscript(false)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col', isOutbound ? 'items-end' : 'items-start')}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[10px] text-slate-400">
        <span className="rounded bg-amber-50 px-1.5 py-px font-semibold text-amber-600">
          {channel}
        </span>
        {isHuman ? (
          <span className="flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-px font-semibold text-emerald-600">
            <User className="size-2.5" /> Human
          </span>
        ) : (
          isOutbound && (
            <span className="flex items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-px font-semibold text-indigo-600">
              <Sparkles className="size-2.5" /> AI
            </span>
          )
        )}
        {m.timestamp && <span>{fmtTime(m.timestamp)}</span>}
      </div>
      <div
        className={cn(
          'max-w-[78%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm',
          isOutbound
            ? 'rounded-tr-sm bg-indigo-50 text-slate-800'
            : 'rounded-tl-sm border border-slate-200 bg-white text-slate-700'
        )}
      >
        {body || '(no content)'}
      </div>
      {m.status && m.status !== 'sent' && (
        <span className="mt-0.5 text-[10px] text-slate-300">{m.status}</span>
      )}
    </div>
  );
}

// ── Info tab ───────────────────────────────────────────────────────
function Row({ label, value }: { label: string; value: any }) {
  const display =
    value === null || value === undefined || value === '' ? '—' : String(value);
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] font-medium text-slate-400">
        {label}
      </span>
      <span className="text-right text-[12px] font-medium text-slate-700">
        {display}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 mt-4 text-[10px] font-semibold uppercase tracking-widest text-slate-400 first:mt-0">
      {children}
    </h3>
  );
}

function InfoTab({
  summary,
  fields,
}: {
  summary: ChatSummary;
  fields: Record<string, any>;
}) {
  const m = fields.memory || {};
  return (
    <div className="divide-y divide-slate-50">
      <div>
        <SectionTitle>Lead</SectionTitle>
        <Row label="Name" value={summary.name} />
        <Row label="Stage" value={summary.stage} />
        <Row label="Dealer" value={summary.dealerName || summary.dealersId} />
        <Row label="Parked" value={fmtDate(summary.parkedAt)} />
        <Row label="Updated" value={fmtDate(summary.updatedAt)} />
      </div>
      <div>
        <SectionTitle>Contact</SectionTitle>
        <Row label="Phone" value={summary.phone} />
        <Row label="Email" value={summary.email} />
      </div>
      <div>
        <SectionTitle>Offer</SectionTitle>
        <Row
          label={
            summary.isCertificateOffer ? 'Certificate offer' : 'Expected price'
          }
          value={money(summary.offer)}
        />
      </div>
      <div>
        <SectionTitle>Compliance</SectionTitle>
        <Row
          label="SMS opt-out"
          value={m.sms_opt_out || fields.sms_opt_out || 'No'}
        />
        <Row
          label="Phone opt-out"
          value={m.phone_opt_out || fields.phone_opt_out || 'No'}
        />
        <Row label="Escalated" value={fields.escalate ? 'Yes' : 'No'} />
        <Row label="Handover" value={fields.handover ? 'Yes' : 'No'} />
      </div>
    </div>
  );
}

// ── Vehicle / Appraisal / Condition tab ────────────────────────────
function VehicleTab({ appraisal, memory }: { appraisal: any; memory: any }) {
  const a = appraisal || {};
  const m = memory || {};
  if (!appraisal && Object.keys(m).length === 0) {
    return (
      <div className="py-10 text-center text-xs text-slate-400">
        No vehicle data on this chat.
      </div>
    );
  }
  // Prefer the appraisal value, fall back to the (customer-confirmed) memory
  // field — condition is collected on the call and stored in memory, so the
  // appraisal doc is often blank.
  const pick = (...vals: any[]) =>
    vals.find((v) => v !== undefined && v !== null && v !== '');
  const odo = pick(a.odometer, m.odometer);
  const confirmed: string[] = Array.isArray(m._fields_confirmed_by_customer)
    ? m._fields_confirmed_by_customer
    : [];
  return (
    <div className="divide-y divide-slate-50">
      <div>
        <SectionTitle>Vehicle</SectionTitle>
        <Row
          label="Year / Make / Model"
          value={[
            pick(a.year, m.year),
            pick(a.make, m.make),
            pick(a.model, m.model),
          ]
            .filter(Boolean)
            .join(' ')}
        />
        <Row label="Trim" value={pick(a.trim, m.trim)} />
        <Row
          label="Mileage"
          value={
            odo && !isNaN(Number(odo))
              ? `${Number(odo).toLocaleString()} mi`
              : odo
          }
        />
        <Row label="Color" value={pick(a.exterior_color, m.exterior_color)} />
        <Row label="VIN" value={pick(a.vin, m.vin)} />
      </div>
      <div>
        <SectionTitle>Appraisal</SectionTitle>
        <Row
          label="Appraisal ID"
          value={pick(a.appraisal_id, m.appraisal_id)}
        />
        <Row label="Status" value={a.status} />
        <Row
          label="Certificate price"
          value={a.certificate_price ? money(Number(a.certificate_price)) : '—'}
        />
        <Row
          label="Expected price"
          value={
            pick(a.expected_price, m.expected_price, m.offer_price)
              ? money(
                  Number(
                    pick(a.expected_price, m.expected_price, m.offer_price)
                  )
                )
              : '—'
          }
        />
      </div>
      <div>
        <SectionTitle>Condition</SectionTitle>
        <Row label="Driveable" value={pick(a.Driveable, m.Driveable)} />
        <Row
          label="Exterior"
          value={pick(a.Exterior, m.Exterior, m.exterior_condition)}
        />
        <Row
          label="Interior"
          value={pick(a.Interior, m.Interior, m.interior_condition)}
        />
        <Row
          label="Mechanical"
          value={pick(a.Mechanical, m.Mechanical, m.mechanical_condition)}
        />
        {confirmed.length > 0 && (
          <div className="pt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Confirmed by customer
            </div>
            <div className="flex flex-wrap gap-1">
              {confirmed.map((f) => (
                <span
                  key={f}
                  className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                >
                  {humanize(f)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity tab (unified timeline) ─────────────────────────────────
type TimelineItem =
  | { kind: 'activity'; ts: number; data: Activity }
  | { kind: 'task'; ts: number; data: Task };

function toMs(v: any): number {
  if (!v) return 0;
  if (typeof v === 'string') {
    const ms = new Date(v).getTime();
    return isNaN(ms) ? 0 : ms;
  }
  if (typeof v === 'object' && typeof v.toDate === 'function')
    return v.toDate().getTime();
  if (typeof v === 'number') return v;
  return 0;
}

function JsonBlock({ label, value }: { label: string; value: any }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="mt-2">
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <pre className="max-h-60 overflow-auto rounded-lg bg-slate-900 p-2.5 text-[10px] leading-relaxed text-slate-200">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function ActivityTab({
  activities,
  tasks,
}: {
  activities: Activity[];
  tasks: Task[];
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const items = useMemo<TimelineItem[]>(() => {
    const merged: TimelineItem[] = [
      ...activities.map((a) => ({
        kind: 'activity' as const,
        ts: toMs(a.timestamp),
        data: a,
      })),
      ...tasks.map((t) => ({
        kind: 'task' as const,
        ts: toMs(t.execute_at || t.created_at),
        data: t,
      })),
    ];
    return merged.sort((a, b) => b.ts - a.ts);
  }, [activities, tasks]);

  if (items.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-slate-400">
        No activity recorded.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="mb-2 text-[11px] text-slate-400">
        Unified timeline — latest first, combining AI actions and tasks.
      </p>
      {items.map((item, i) => {
        const key = `${item.kind}-${item.data.id}-${i}`;
        const isOpen = !!open[key];
        const tsMs = item.ts;
        const when = tsMs ? fmtRelative(new Date(tsMs).toISOString()) : '';

        if (item.kind === 'activity') {
          const a = item.data;
          const name = humanize(a.toolCall?.toolName) || 'AI action';
          const status = a.toolCall?.status;
          return (
            <div key={key} className="rounded-lg border border-slate-200">
              <button
                onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5 shrink-0 text-slate-400" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-slate-400" />
                )}
                <span className="flex-1 truncate text-[12px] font-medium text-slate-700">
                  {name}
                </span>
                <span className="rounded bg-violet-50 px-1.5 py-px text-[9px] font-semibold uppercase text-violet-500">
                  AI action
                </span>
                <span className="shrink-0 text-[10px] text-slate-400">
                  {when}
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-slate-100 px-3 py-2">
                  {status && <Row label="Status" value={status} />}
                  <JsonBlock label="Input" value={a.toolCall?.input} />
                  <JsonBlock label="Output" value={a.toolCall?.result} />
                </div>
              )}
            </div>
          );
        }

        const t = item.data;
        const name = humanize(t.type) || 'Task';
        return (
          <div key={key} className="rounded-lg border border-slate-200">
            <button
              onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              {isOpen ? (
                <ChevronDown className="size-3.5 shrink-0 text-slate-400" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-slate-400" />
              )}
              <span className="flex-1 truncate text-[12px] font-medium text-slate-700">
                {name}
              </span>
              <span
                className={cn(
                  'rounded px-1.5 py-px text-[9px] font-semibold uppercase',
                  t.executed
                    ? 'bg-emerald-50 text-emerald-600'
                    : 'bg-amber-50 text-amber-600'
                )}
              >
                {t.executed ? 'Executed' : 'Pending'}
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">
                {when}
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-slate-100 px-3 py-2">
                {t.instructions && (
                  <Row label="Instructions" value={t.instructions} />
                )}
                <Row label="Execute at" value={fmtDate(t.execute_at)} />
                <JsonBlock label="Data" value={t.data} />
                <JsonBlock label="Output" value={t.output} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Notifications tab ───────────────────────────────────────────────
function NotificationsTab({ notifications }: { notifications: any[] }) {
  if (notifications.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-slate-400">
        No notifications.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {notifications.map((n, i) => {
        const body =
          n.body ||
          n.message ||
          n.text ||
          n.content?.body ||
          n.content?.text ||
          '';
        const title = n.title || humanize(n.type) || 'Notification';
        const ts = n.timestamp
          ? fmtRelative(
              typeof n.timestamp === 'string'
                ? n.timestamp
                : new Date(toMs(n.timestamp)).toISOString()
            )
          : '';
        return (
          <div
            key={n.id || i}
            className="rounded-lg border border-slate-200 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-medium text-slate-700">
                {title}
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">{ts}</span>
            </div>
            {body && (
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">
                {body}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
