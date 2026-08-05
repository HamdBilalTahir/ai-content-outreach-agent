'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessagesSquare, RefreshCw, Trophy, Waypoints } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import ChatDetailView from '@/components/outbound/chat-detail/ChatDetailView';
import { useOutboundAgents } from '../../campaigns/shared';
import { SearchableSelect } from '../../campaigns/components/SearchableSelect';
import { DealTimelineRail } from './DealTimelineRail';
import {
  deriveEventsFromChat,
  isSuccessfulTouchpoint,
  type TimelineEvent,
} from './timeline';

const LILY_AGENT_ID = 'k31pCNgXdYCW0wDs7vZY';

const CARD =
  'rounded-xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]';

interface DealRow {
  chatId: string;
  name: string;
  company: string | null;
  phone: string | null;
  stageLabel: string | null;
  amount: number | null;
  firstTouchAt: string | null;
  acquiredAt: string | null;
  daysToAcquire: number | null;
  events: TimelineEvent[];
}

const daysBetween = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
};

// Full date incl. year (dropping the year is misleading across year boundaries).
const fullDate = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

export default function AttributionTimelineClient({
  companyId,
}: {
  companyId: string;
}) {
  const { outboundAgents, loading: loadingAgents } =
    useOutboundAgents(companyId);
  const agentOptions = outboundAgents.filter(
    (a) => a.name !== 'Ava - Old Prompt'
  );

  const [agentId, setAgentId] = useState('');
  const [deals, setDeals] = useState<DealRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openChatId, setOpenChatId] = useState<string | null>(null);

  // Default the agent to Lily once agents load.
  useEffect(() => {
    if (agentId || loadingAgents || agentOptions.length === 0) return;
    const lily =
      agentOptions.find((a) => a.id === LILY_AGENT_ID) ??
      agentOptions.find((a) => a.name === 'Lily') ??
      agentOptions[0];
    setAgentId(lily ? String(lily.id) : '');
  }, [agentOptions, loadingAgents, agentId]);

  // Fetch the merged HubSpot + AI timeline for one deal, or null on failure.
  const fetchTimeline = useCallback(
    async (
      chatId: string
    ): Promise<Partial<DealRow> & { events: TimelineEvent[] }> => {
      try {
        const res = await fetch(
          `/api/outbound/analytics/deal-timeline?agent_id=${encodeURIComponent(agentId)}&chat_id=${encodeURIComponent(chatId)}`
        );
        if (res.ok) {
          const d = await res.json();
          if (d?.success && Array.isArray(d.events)) {
            return {
              events: (d.events as TimelineEvent[]).filter(
                isSuccessfulTouchpoint
              ),
              amount: d.deal?.amount ?? null,
              firstTouchAt: d.first_touch_at ?? null,
              acquiredAt: d.deal?.acquired_at ?? null,
              daysToAcquire: d.days_to_acquire ?? null,
            };
          }
        }
      } catch {
        /* fall back to Firestore below */
      }
      // Fallback: derive from the AI outreach we store, read via the Admin-SDK
      // route (raw messages_v3 + activities, timestamps ISO-serialized).
      try {
        const evRes = await fetch(
          `/api/outbound/attribution/chat-events?chat_id=${encodeURIComponent(chatId)}`
        );
        if (!evRes.ok) return { events: [] };
        const d = await evRes.json();
        const events = deriveEventsFromChat(
          {},
          Array.isArray(d.messages) ? d.messages : [],
          Array.isArray(d.activities) ? d.activities : []
        ).filter(isSuccessfulTouchpoint);
        return { events };
      } catch {
        return { events: [] };
      }
    },
    [agentId]
  );

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outbound/analytics/deal-funnel?agent_id=${encodeURIComponent(agentId)}`
      );
      const funnel = await res.json().catch(() => null);
      const wonIds = new Set<string>(
        (funnel?.stages ?? [])
          .filter((s: any) => s.type === 'won')
          .map((s: any) => String(s.id))
      );

      // Converted chats for this agent via the Admin-SDK route; filter to the
      // won-stage ids from deal-funnel (client-side, cheap).
      const dealsRes = await fetch(
        `/api/outbound/attribution/deals?agent_id=${encodeURIComponent(agentId)}`
      );
      const dealsData = await dealsRes.json().catch(() => null);
      if (!dealsRes.ok)
        throw new Error(
          dealsData?.error || `Request failed (${dealsRes.status})`
        );
      const base = (
        Array.isArray(dealsData?.deals) ? dealsData.deals : []
      ).filter(
        (d: any) => wonIds.size > 0 && wonIds.has(String(d.hubspotDealStageId))
      );

      // Load each deal's full merged timeline (endpoint, with Firestore fallback).
      const rows: DealRow[] = await Promise.all(
        base.map(async (b: any) => {
          const t = await fetchTimeline(b.chatId);
          return {
            chatId: b.chatId,
            name: b.name,
            company: b.company,
            phone: b.phone,
            stageLabel: b.stageLabel,
            amount: t.amount ?? null,
            firstTouchAt: t.firstTouchAt ?? b.createdAt,
            acquiredAt: t.acquiredAt ?? b.convertedAt,
            daysToAcquire:
              t.daysToAcquire ?? daysBetween(b.createdAt, b.convertedAt),
            events: t.events,
          };
        })
      );
      rows.sort(
        (a, b) =>
          new Date(b.acquiredAt ?? 0).getTime() -
          new Date(a.acquiredAt ?? 0).getTime()
      );
      setDeals(rows);
    } catch (e: any) {
      setError(e?.message || 'Could not load closed-won deals');
      setDeals(null);
    } finally {
      setLoading(false);
    }
  }, [agentId, fetchTimeline]);

  useEffect(() => {
    load();
  }, [load]);

  const kpis = useMemo(() => {
    const d = deals ?? [];
    const spans = d
      .map((x) => x.daysToAcquire)
      .filter((n): n is number => n != null);
    const avg = spans.length
      ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length)
      : null;
    const newest = d
      .map((x) => x.acquiredAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0];
    return { count: d.length, avgDays: avg, newest: newest ?? null };
  }, [deals]);

  const showSkeleton = (loading || loadingAgents) && deals === null;

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[#fbfbfd] px-8 py-6">
      {/* Header */}
      <div className="mb-4 flex shrink-0 items-center gap-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <Waypoints className="size-[18px]" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-[26px] font-semibold leading-none tracking-tight text-slate-900">
            Outbound · Attribution Timeline
          </h1>
          <p className="mt-1.5 text-[13px] text-slate-500">
            Every touchpoint from first touch to acquisition for each closed-won
            deal.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="mb-5 flex shrink-0 flex-wrap items-center gap-2.5 border-b border-slate-200/70 pb-5">
        <div className="w-[240px]">
          <SearchableSelect
            value={agentId}
            onChange={setAgentId}
            options={agentOptions.map((a) => ({
              value: String(a.id),
              label: a.name,
            }))}
            disabled={loadingAgents}
            placeholder={loadingAgents ? 'Loading agents…' : 'Select agent'}
            searchPlaceholder="Search agents…"
            emptyText="No agents found."
          />
        </div>
        <button
          type="button"
          onClick={load}
          disabled={!agentId || loading}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
        >
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          Refresh
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5">
          {showSkeleton ? (
            <TimelineSkeleton />
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          ) : (deals?.length ?? 0) === 0 ? (
            <EmptyState />
          ) : (
            <>
              {/* KPI row */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <Kpi
                  label="Closed-won deals"
                  value={String(kpis.count)}
                  sub="Attributed to the AI"
                  accent="#059669"
                />
                <Kpi
                  label="Avg days to acquire"
                  value={kpis.avgDays == null ? '—' : String(kpis.avgDays)}
                  sub="First touch → acquired"
                  accent="#334155"
                />
                <Kpi
                  label="Most recent win"
                  value={fullDate(kpis.newest)}
                  sub="Latest acquisition"
                  accent="#0f172a"
                />
              </div>

              {/* Deal cards — always show the full timeline (no compaction) */}
              {(deals ?? []).map((deal) => (
                <div key={deal.chatId} className={cn(CARD, 'overflow-hidden')}>
                  <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                      <Trophy className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[14px] font-semibold text-slate-900">
                          {deal.name}
                        </p>
                        <span
                          className="shrink-0 rounded-full border border-emerald-200 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                          title={
                            deal.stageLabel
                              ? `HubSpot stage: ${deal.stageLabel}`
                              : undefined
                          }
                        >
                          Won
                        </span>
                        {deal.amount != null && (
                          <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            ${Number(deal.amount).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-slate-500">
                        {[deal.company, deal.phone]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </p>
                    </div>
                    <div className="hidden shrink-0 text-right sm:block">
                      <p className="text-[12px] font-medium text-slate-700">
                        Acquired {fullDate(deal.acquiredAt)}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {deal.daysToAcquire == null
                          ? `${deal.events.length} touchpoints`
                          : `${deal.daysToAcquire} day${deal.daysToAcquire === 1 ? '' : 's'} · ${deal.events.length} touchpoints`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpenChatId(deal.chatId)}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                    >
                      <MessagesSquare className="size-3.5" />
                      View conversation
                    </button>
                  </div>
                  <div className="px-5 py-4">
                    <DealTimelineRail events={deal.events} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Conversation deep-dive */}
      <Sheet
        open={!!openChatId}
        onOpenChange={(o) => {
          if (!o) setOpenChatId(null);
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 bg-[#fbfbfc] p-0 sm:max-w-[720px] lg:max-w-[55vw]"
        >
          <SheetHeader className="border-b border-gray-100 bg-white px-6 py-4">
            <SheetTitle className="text-[15px] font-bold text-gray-900">
              Conversation
            </SheetTitle>
            <SheetDescription className="text-[12px] text-gray-500">
              Full conversation behind this attribution.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 p-4">
            <ChatDetailView chatId={openChatId} className="min-h-0 flex-1" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <div className={cn(CARD, 'p-4')}>
      <div className="flex items-center gap-2">
        <span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </p>
      </div>
      <p className="mt-2.5 font-mono text-[26px] font-semibold leading-none tabular-nums text-slate-900">
        {value}
      </p>
      <p className="mt-1.5 text-[12px] text-slate-400">{sub}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white py-24 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50">
        <Trophy className="size-[18px] text-slate-400" />
      </div>
      <p className="mt-4 text-[15px] font-semibold text-slate-800">
        No closed-won deals yet
      </p>
      <p className="mt-1 text-[13px] text-slate-500">
        Once a prospect this agent engaged converts to a won HubSpot deal, its
        attribution timeline shows up here.
      </p>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={cn(CARD, 'p-4')}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
            <Skeleton className="mt-2 h-3 w-28" />
          </div>
        ))}
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className={cn(CARD, 'p-5')}>
          <Skeleton className="h-5 w-52" />
          <div className="mt-6 flex gap-8">
            {Array.from({ length: 5 }).map((_, j) => (
              <div key={j} className="flex flex-col items-center gap-2">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
