'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  endOfDay,
  format,
  formatDistanceToNowStrict,
  startOfDay,
  startOfMonth,
  subDays,
} from 'date-fns';
import type { DateRange } from 'react-day-picker';
import {
  AlertTriangle,
  CalendarDays,
  Filter,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { MultiSelect } from './MultiSelect';
import FunnelChatsDrawer, { type FunnelDrill } from './FunnelChatsDrawer';
import type { FunnelStage, DealFunnelResponse } from '../types';
import { USE_TEST_DATA, TEST_FIRESTORE, TEST_DEAL } from '../test-data';

// Chat-stage columns drilled by the chat `stage` field. Deal columns (Booking Set /
// Intermediate / Closed Won / Closed Lost) are drilled separately via the attributed
// HubSpot deal stage — see drillForKey. Maps the column key → the chat `stage` value.
const DEAL_COL_LABEL: Record<string, string> = {
  booking: 'Booking Set',
  intermediate: 'Intermediate',
  won: 'Closed Won',
  lost: 'Closed Lost',
};

const DRILLABLE_STAGES: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  engaged: 'Engaged',
};

// A Firestore outbound_campaigns doc (read defensively — shape is lightly specified).
interface CampaignOption {
  id: string;
  name: string;
}

type SourceKey = 'all' | 'outbound' | 'inbound';
type RangeKey = 'all' | 'month' | '7d' | 'custom';

// A single funnel table row.
interface TableRowData {
  key: string;
  label: string;
  value: number | null;
  prev?: number | null; // reference count for Conv. + Drop-off
  colorKey?: string; // stage dot colour
  sub?: boolean; // indented intermediate sub-stage
  showConv?: boolean;
  showDrop?: boolean;
  countClass?: string; // count text colour (won/lost)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCES: { key: SourceKey; label: string }[] = [
  { key: 'outbound', label: 'Outbound' },
  { key: 'inbound', label: 'Inbound' },
  { key: 'all', label: 'All' },
];

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'month', label: 'This month' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'custom', label: 'Custom' },
];

const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// Shared card surface — minimal editorial: hairline border, very soft shadow.
const CARD =
  'rounded-xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]';

// Stage progression — a monochrome slate depth ramp (darkness = funnel depth),
// with the only two semantic hues on the page: emerald (won) / rose (lost).
const ROW_COLOR: Record<string, string> = {
  new: '#0f172a',
  contacted: '#334155',
  engaged: '#475569',
  booking: '#64748b',
  intermediate: '#94a3b8',
  won: '#059669',
  lost: '#e11d48',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeBounds(
  key: RangeKey,
  custom: DateRange | undefined
): { start?: Date; end?: Date } {
  const now = new Date();
  switch (key) {
    case 'month':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case '7d':
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case 'custom':
      if (custom?.from && custom?.to) {
        return { start: startOfDay(custom.from), end: endOfDay(custom.to) };
      }
      return {};
    default:
      return {};
  }
}

const num = (n: number) => n.toLocaleString();

// One-decimal percentage, e.g. "38.7%".
const pct1 = (value: number, base: number | null | undefined) =>
  base ? `${((value / base) * 100).toFixed(1)}%` : '—';

// Drop-off between two stages, e.g. "-190 (-61%)".
function dropStr(value: number, prev: number | null | undefined): string {
  if (prev == null || prev <= 0) return '—';
  const drop = prev - value;
  const p = Math.round((drop / prev) * 100);
  // "Drop-off" already implies a decrease — show the magnitude, no minus sign.
  return `${num(drop)} (${p}%)`;
}

// ─── Component ──────────────────────────────────────────────────────────────

const EMPTY_DEAL_FUNNEL: DealFunnelResponse = {
  pipeline_id: '',
  pipeline_label: '',
  filters: {},
  stages: [],
  total: 0,
};

// Merge deal-funnel responses from multiple (agent × campaign) scopes: sum each
// stage's count by stage id, sum the total. Stage metadata (label/order/type/
// is_entry) is taken from the first occurrence.
function mergeDealFunnels(results: DealFunnelResponse[]): DealFunnelResponse {
  if (results.length === 0) return EMPTY_DEAL_FUNNEL;
  if (results.length === 1) return results[0];
  const base = results[0];
  const byId = new Map<string, FunnelStage>();
  for (const r of results) {
    for (const s of r.stages) {
      const ex = byId.get(s.id);
      if (ex) ex.count += s.count;
      else byId.set(s.id, { ...s });
    }
  }
  return {
    pipeline_id: base.pipeline_id,
    pipeline_label: base.pipeline_label,
    filters: base.filters,
    stages: Array.from(byId.values()).sort((a, b) => a.order - b.order),
    total: results.reduce((sum, r) => sum + (r.total || 0), 0),
  };
}

export default function FunnelDashboardClient({
  companyId,
}: {
  companyId: string;
}) {
  // Agents that have campaigns (+ their campaigns), read server-side via the
  // Admin SDK route — the browser can't read `outbound_campaigns` under
  // Firestore rules, so a direct client read returned nothing. Only agents with
  // at least one campaign appear here, which is exactly what the funnel wants.
  const [campaignAgents, setCampaignAgents] = useState<
    {
      agent_id: string;
      name: string;
      campaigns: { campaign_id: string; name: string }[];
    }[]
  >([]);
  const [loadingAgents, setLoadingAgents] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingAgents(true);
    fetch(
      `/api/outbound/campaign-agents?companyId=${encodeURIComponent(companyId)}`
    )
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled)
          setCampaignAgents(Array.isArray(d?.agents) ? d.agents : []);
      })
      .catch((e) => {
        console.error('[funnel] campaign-agents failed', e);
        if (!cancelled) setCampaignAgents([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const agentOptions = campaignAgents.map((a) => ({
    id: a.agent_id,
    name: a.name,
  }));

  // Filters
  const [source, setSource] = useState<SourceKey>('outbound');
  const [drill, setDrill] = useState<FunnelDrill | null>(null);
  // Multi-select agents + campaigns (all / some / none). Agents default to Lily
  // once loaded; campaigns default to every loaded campaign (= "all", which the
  // query treats as no campaign filter so null-campaign chats still count).
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([]);
  // True once the default agent selection has been applied (or there are no
  // agents). Gates the first load so it waits for the Lily default instead of
  // flashing an empty funnel, and lets a later user "clear to none" stick.
  const [agentsInited, setAgentsInited] = useState(false);
  const [rangeKey, setRangeKey] = useState<RangeKey>('all');
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Campaign options (Firestore outbound_campaigns)
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);

  // Data
  const [firestore, setFirestore] = useState<{
    new: number;
    contacted: number;
    engaged: number;
    // Chats that entered the funnel but ended at a terminal chat-stage ('Lost' / not-interested)
    // that isn't New/Contacted/Engaged and isn't a HubSpot deal. Counted so the funnel stays
    // cumulative (they entered) but never shown as their own stage.
    lost?: number;
  } | null>(null);
  const [deal, setDeal] = useState<DealFunnelResponse | null>(null);
  const [dealError, setDealError] = useState<string | null>(null);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // True once the first load has resolved — after that, refreshes update the
  // numbers in place and never re-show the skeleton.
  const [hasLoaded, setHasLoaded] = useState(false);
  // True while a refetch triggered by a FILTER change (agent / source /
  // campaign / date range) is in flight — used to skeleton the number values
  // (only) so it's clear the figures are reloading, without collapsing the
  // layout. Not set by the Refresh button or the 5-min auto-refresh, which
  // update in place.
  const [numbersLoading, setNumbersLoading] = useState(false);
  const prevFilterRef = useRef<string>('');
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [, setTick] = useState(0); // forces the relative "last refreshed" label to re-render

  // Inbound has no campaigns — force "All campaigns" and disable the picker.
  const campaignDisabled = source === 'inbound';

  // ── Default agent selection: Lily, once agents load. Match by stable id first
  // (names churn: Ava ⇄ Lily Outbound), then by name, then the first agent. Uses
  // a ref so it never overrides a later user "clear" (none) back to the default.
  useEffect(() => {
    if (agentsInited || loadingAgents) return;
    if (agentOptions.length === 0) {
      setAgentsInited(true); // no agents — boot with an empty selection
      return;
    }
    const lily =
      agentOptions.find((a) => a.id === 'k31pCNgXdYCW0wDs7vZY') ??
      agentOptions.find((a) => a.name === 'Lily') ??
      agentOptions[0];
    setSelectedAgentIds(lily ? [lily.id] : []);
    setAgentsInited(true);
  }, [agentOptions, loadingAgents, agentsInited]);

  // ── Campaign list (union across the selected agents) ──
  // Derived from the campaign-agents payload (no client-SDK read). Re-defaults
  // to "all campaigns selected" whenever the agent set changes.
  useEffect(() => {
    if (selectedAgentIds.length === 0) {
      setCampaigns([]);
      setSelectedCampaignIds([]);
      return;
    }
    const sel = new Set(selectedAgentIds);
    const seen = new Set<string>();
    const list: CampaignOption[] = [];
    for (const a of campaignAgents) {
      if (!sel.has(a.agent_id)) continue;
      for (const c of a.campaigns) {
        if (seen.has(c.campaign_id)) continue;
        seen.add(c.campaign_id);
        list.push({ id: c.campaign_id, name: c.name });
      }
    }
    setCampaigns(list);
    setSelectedCampaignIds(list.map((c) => c.id)); // default: all selected
  }, [selectedAgentIds, campaignAgents]);

  // Build the (agent × campaign) query scopes for the current selection.
  // Agents are queried one-by-one with `agentId ==` (looping instead of a single
  // `in`) so we reuse existing indexes and add no new composite indexes.
  // Campaigns: "all selected" (or none exist / inbound) => no campaign filter, so
  // null-campaign chats still count; a strict subset => one scope per campaign;
  // cleared => no scopes => zero.
  const buildScopes = useCallback((): {
    agentId: string;
    campaignId?: string;
  }[] => {
    const allCampaigns =
      source === 'inbound' ||
      campaigns.length === 0 ||
      selectedCampaignIds.length === campaigns.length;
    const campaignScopes: (string | undefined)[] = allCampaigns
      ? [undefined]
      : selectedCampaignIds;
    return selectedAgentIds.flatMap((agentId) =>
      campaignScopes.map((campaignId) => ({ agentId, campaignId }))
    );
  }, [selectedAgentIds, selectedCampaignIds, campaigns, source]);

  // ── Top-of-funnel chat-stage counts (via the Admin-SDK route) ──
  // Server-side counting (Test/archived/converted exclusions live there) — the
  // browser client SDK's aggregation was unreliable in some environments.
  const loadFirestore = useCallback(async () => {
    if (selectedAgentIds.length === 0)
      return { new: 0, contacted: 0, engaged: 0, lost: 0 };
    const { start, end } = computeBounds(rangeKey, customRange);
    // "All campaigns" (or none / inbound) => no campaign filter, so null-campaign
    // chats still count; a strict subset => filter to those campaigns.
    const allCampaigns =
      source === 'inbound' ||
      campaigns.length === 0 ||
      selectedCampaignIds.length === campaigns.length;
    const params = new URLSearchParams({
      agent_ids: selectedAgentIds.join(','),
      source,
    });
    if (!allCampaigns && selectedCampaignIds.length)
      params.set('campaign_ids', selectedCampaignIds.join(','));
    if (start && end) {
      params.set('start', start.toISOString());
      params.set('end', end.toISOString());
    }
    const res = await fetch(`/api/outbound/funnel/chat-counts?${params}`);
    const data = await res.json();
    if (!res.ok)
      throw new Error(data?.error || `Request failed (${res.status})`);
    return {
      new: data.new ?? 0,
      contacted: data.contacted ?? 0,
      engaged: data.engaged ?? 0,
      lost: data.lost ?? 0,
    };
  }, [
    rangeKey,
    customRange,
    source,
    selectedAgentIds,
    selectedCampaignIds,
    campaigns,
  ]);

  // ── Deal-side funnel (proxied API) — one call per scope, merged ──
  const loadDeal = useCallback(async () => {
    const { start, end } = computeBounds(rangeKey, customRange);
    const scopes = buildScopes();
    if (scopes.length === 0) return EMPTY_DEAL_FUNNEL;
    const results = await Promise.all(
      scopes.map(async ({ agentId, campaignId }) => {
        const params = new URLSearchParams({ agent_id: agentId });
        // Real deals only — the funnel measures real business outcomes, matching the
        // chat-stage side (which excludes record_type='Test'). Sent explicitly so we
        // never depend on the backend default to keep E2E test deals out.
        params.set('record_type', 'Real');
        if (campaignId) params.set('campaign_id', campaignId);
        if (source !== 'all') params.set('source', source);
        if (start && end) {
          params.set('start_date', format(start, 'yyyy-MM-dd'));
          params.set('end_date', format(end, 'yyyy-MM-dd'));
        }
        const res = await fetch(
          `/api/outbound/analytics/deal-funnel?${params.toString()}`
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || `Request failed (${res.status})`);
        }
        return data as DealFunnelResponse;
      })
    );
    return mergeDealFunnels(results);
  }, [rangeKey, customRange, source, buildScopes]);

  // ── Combined load — independent so one source failing doesn't blank the other ──
  const load = useCallback(async () => {
    setLoading(true);
    if (USE_TEST_DATA) {
      setFirestore(TEST_FIRESTORE);
      setDeal(TEST_DEAL);
      setFirestoreError(null);
      setDealError(null);
      setLastRefreshed(new Date());
      setHasLoaded(true);
      setLoading(false);
      setNumbersLoading(false);
      return;
    }
    // Wait for the default agent selection before the first fetch (avoids a
    // flash of empty data). "None selected" after boot is valid — loaders return
    // zeros.
    if (!agentsInited) {
      return;
    }
    setFirestoreError(null);
    setDealError(null);
    const [fsResult, dealResult] = await Promise.allSettled([
      loadFirestore(),
      loadDeal(),
    ]);
    if (fsResult.status === 'fulfilled') {
      setFirestore(fsResult.value);
    } else {
      console.error('[funnel] firestore counts failed', fsResult.reason);
      setFirestore(null);
      setFirestoreError('Could not load chat counts');
    }
    if (dealResult.status === 'fulfilled') {
      setDeal(dealResult.value);
    } else {
      setDeal(null);
      setDealError(dealResult.reason?.message || 'Could not load deal funnel');
    }
    setLastRefreshed(new Date());
    setHasLoaded(true);
    setLoading(false);
    setNumbersLoading(false);
  }, [agentsInited, loadFirestore, loadDeal]);

  useEffect(() => {
    load();
  }, [load]);

  // Flag a filter change (after the first load) so the number values skeleton
  // while the counts refetch; cleared when `load` completes. Keyed off a
  // signature of all filters so any of them switching triggers it.
  const filterSig = `${[...selectedAgentIds].sort().join(',')}|${[
    ...selectedCampaignIds,
  ]
    .sort()
    .join(',')}|${source}|${rangeKey}|${
    customRange?.from?.toISOString() ?? ''
  }|${customRange?.to?.toISOString() ?? ''}`;
  useEffect(() => {
    if (
      prevFilterRef.current &&
      prevFilterRef.current !== filterSig &&
      hasLoaded
    ) {
      setNumbersLoading(true);
    }
    prevFilterRef.current = filterSig;
  }, [filterSig, hasLoaded]);

  // ── Auto-refresh every 5 min (loadRef avoids resetting the timer on filter changes) ──
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const id = setInterval(() => loadRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // ── Keep the "last refreshed" relative label current ──
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── Derived deal-side aggregates ──
  const dealParts = useMemo(() => {
    if (!deal) return null;
    const stages = deal.stages ?? [];
    const entry = stages.find((s) => s.is_entry);
    const intermediate = stages.filter((s) => s.type === 'open' && !s.is_entry);
    const won = stages.filter((s) => s.type === 'won');
    const lost = stages.filter((s) => s.type === 'lost');
    const sum = (arr: FunnelStage[]) => arr.reduce((a, s) => a + s.count, 0);
    return {
      bookingSet: entry?.count ?? 0,
      intermediate,
      intermediateTotal: sum(intermediate),
      won: sum(won),
      lost: sum(lost),
    };
  }, [deal]);

  const dealNotConnected =
    !!dealError &&
    !deal &&
    /connect|configur|pipeline|hubspot/i.test(dealError);

  // HubSpot stage ids per deal column (from the live pipeline shape). Used to drill
  // a deal column into the attributed conversions sitting in those stages.
  const dealStageIds = useMemo(() => {
    const s = deal?.stages ?? [];
    return {
      booking: s.filter((x) => x.is_entry).map((x) => x.id),
      intermediate: s
        .filter((x) => x.type === 'open' && !x.is_entry)
        .map((x) => x.id),
      won: s.filter((x) => x.type === 'won').map((x) => x.id),
      lost: s.filter((x) => x.type === 'lost').map((x) => x.id),
    };
  }, [deal]);

  // Resolve a column key → the drill payload (chat-stage or deal), or null if not
  // drillable (e.g. a deal column when HubSpot isn't connected).
  const drillForKey = useCallback(
    (key: string): FunnelDrill | null => {
      if (DRILLABLE_STAGES[key])
        return { kind: 'chat-stage', stage: DRILLABLE_STAGES[key] };
      const ids = (dealStageIds as Record<string, string[]>)[key];
      if (ids && ids.length)
        return {
          kind: 'deal',
          label: DEAL_COL_LABEL[key] ?? key,
          stageIds: ids,
        };
      return null;
    },
    [dealStageIds]
  );

  // Cumulative funnel: stages are mutually-exclusive current states, so a real
  // funnel counts "reached at least this stage" = suffix sum down the chain, and
  // rates are taken against the total enrolled (so they never exceed 100%).
  const funnel = useMemo(() => {
    const nw = firestore?.new ?? 0;
    const co = firestore?.contacted ?? 0;
    const en = firestore?.engaged ?? 0;
    // Chats that entered but ended at chat-stage 'Lost' (not-interested). Counted in the
    // entry total so the funnel is cumulative, then treated as a top-of-funnel drop-off —
    // they are NOT shown as a stage and do NOT feed Closed Lost (which stays HubSpot-only).
    const lostEntered = firestore?.lost ?? 0;
    const bk = dealParts?.bookingSet ?? 0;
    const it = dealParts?.intermediateTotal ?? 0;
    const wo = dealParts?.won ?? 0;
    const lo = dealParts?.lost ?? 0;
    const total = nw + lostEntered + co + en + bk + it + wo + lo;
    const rNew = total; // everyone reached New (incl. those since gone to 'Lost')
    const rContacted = total - nw - lostEntered; // lost-chat entrants drop before Contacted
    const rEngaged = rContacted - co;
    const rBooking = rEngaged - en;
    const rIntermediate = rBooking - bk;
    return {
      nw,
      co,
      en,
      bk,
      it,
      wo,
      lo,
      total,
      rNew,
      rContacted,
      rEngaged,
      rBooking,
      rIntermediate,
    };
  }, [firestore, dealParts]);

  // ── Assemble table rows (funnel order, with intermediate sub-stages inline) ──
  const rows = useMemo(() => {
    const fs = firestore;
    const dp = dealParts;
    const list: TableRowData[] = [
      {
        key: 'new',
        label: 'New',
        value: fs ? funnel.rNew : null,
        colorKey: 'new',
      },
      {
        key: 'contacted',
        label: 'Contacted',
        value: fs ? funnel.rContacted : null,
        prev: fs ? funnel.rNew : undefined,
        colorKey: 'contacted',
        showConv: true,
        showDrop: true,
      },
      {
        key: 'engaged',
        label: 'Engaged',
        value: fs ? funnel.rEngaged : null,
        prev: fs ? funnel.rContacted : undefined,
        colorKey: 'engaged',
        showConv: true,
        showDrop: true,
      },
      {
        key: 'booking',
        label: 'Booking Set',
        value: dp ? funnel.rBooking : null,
        prev: funnel.rEngaged,
        colorKey: 'booking',
        showConv: true,
        showDrop: true,
      },
      {
        key: 'intermediate',
        label: 'Intermediate',
        value: dp ? funnel.rIntermediate : null,
        prev: funnel.rBooking,
        colorKey: 'intermediate',
        showConv: true,
        showDrop: true,
      },
    ];
    if (dp) {
      dp.intermediate
        .slice()
        .sort((a, b) => a.order - b.order)
        .forEach((s) =>
          list.push({ key: s.id, label: s.label, value: s.count, sub: true })
        );
    }
    list.push(
      {
        key: 'won',
        label: 'Closed Won',
        value: dp ? funnel.wo : null,
        prev: funnel.rIntermediate,
        colorKey: 'won',
        showConv: true,
        countClass: 'text-emerald-600',
      },
      {
        key: 'lost',
        label: 'Closed Lost',
        value: dp ? funnel.lo : null,
        colorKey: 'lost',
        countClass: 'text-rose-600',
      }
    );
    return list;
  }, [firestore, dealParts, funnel]);

  // Stage columns (transposed table = stages across, metrics down) + the
  // intermediate sub-stages shown as a footnote (not columns — they're parallel
  // open stages, not a sequential step).
  const stageCols = useMemo(() => rows.filter((r) => !r.sub), [rows]);
  const intermediateStages = useMemo(
    () =>
      (dealParts?.intermediate ?? []).slice().sort((a, b) => a.order - b.order),
    [dealParts]
  );

  // Metric rows of the transposed table (stages are the columns).
  const metricRows: {
    key: string;
    label: string;
    hero?: boolean;
    render: (s: TableRowData) => string;
  }[] = [
    {
      key: 'count',
      label: 'Count',
      hero: true,
      render: (s) => (s.value == null ? '—' : num(s.value)),
    },
    {
      key: 'conv',
      label: 'Conversion',
      render: (s) =>
        s.showConv && s.value != null ? pct1(s.value, s.prev) : '—',
    },
    {
      key: 'drop',
      label: 'Drop-off',
      render: (s) =>
        s.showDrop && s.value != null ? dropStr(s.value, s.prev) : '—',
    },
    {
      key: 'share',
      label: '% of Total',
      render: (s) => (s.value != null ? pct1(s.value, funnel.total) : '—'),
    },
  ];

  const totalReal =
    (firestore ? firestore.new + firestore.contacted + firestore.engaged : 0) +
    (dealParts
      ? dealParts.bookingSet +
        dealParts.intermediateTotal +
        dealParts.won +
        dealParts.lost
      : 0);
  const isEmpty = !loading && totalReal === 0 && !dealNotConnected;
  // Show the loading skeleton only on the very first load (page boot) — agents
  // resolving or no agent selected yet. Once loaded, refreshes update the
  // numbers in place without re-showing the skeleton.
  const showSkeleton =
    !hasLoaded &&
    (loading || loadingAgents || (!agentsInited && !USE_TEST_DATA));

  // ── Summary KPIs (business-outcome headline numbers) ──
  const kpis = useMemo(() => {
    // "Reached at least once" = everyone who moved past New (Contacted + Engaged +
    // every later stage), i.e. the cumulative "reached Contacted" from the funnel — NOT
    // the current Contacted-stage count, which drops anyone who has since progressed.
    const reached = firestore ? funnel.rContacted : null;
    const booking = dealParts?.bookingSet ?? null;
    const won = dealParts?.won ?? null;
    const lost = dealParts?.lost ?? null;
    const winBase = (won ?? 0) + (lost ?? 0);
    const fmt = (v: number | null) => (v == null ? '—' : num(v));
    return [
      {
        label: 'Contacts Reached',
        value: fmt(reached),
        sub: 'Reached at least once',
        accent: ROW_COLOR.contacted,
        drillKey: undefined as string | undefined,
      },
      {
        label: 'Meetings Set',
        value: fmt(booking),
        sub:
          booking != null && reached
            ? `${pct1(booking, reached)} of reached`
            : 'Booked demos',
        accent: ROW_COLOR.booking,
        drillKey: 'booking',
      },
      {
        label: 'Deals Won',
        value: fmt(won),
        sub:
          won != null && booking
            ? `${pct1(won, booking)} of meetings`
            : 'Closed won',
        accent: ROW_COLOR.won,
        valueClass: 'text-emerald-600',
        drillKey: 'won',
      },
      {
        label: 'Win Rate',
        value: winBase > 0 ? pct1(won ?? 0, winBase) : '—',
        sub:
          won != null && lost != null
            ? `${num(won)} won · ${num(lost)} lost`
            : 'Won vs lost',
        accent: '#0f172a',
        drillKey: undefined as string | undefined,
      },
    ];
  }, [firestore, dealParts]);

  // ── Analytics for the lower section (funnel shape + insight cards) ──
  const analytics = useMemo(() => {
    if (!firestore && !dealParts) return null;
    const { wo, lo, rNew, rContacted, rEngaged, rBooking, rIntermediate } =
      funnel;

    // Funnel shape uses cumulative "reached" so it narrows monotonically.
    const flow = [
      { key: 'new', label: 'New', value: rNew },
      { key: 'contacted', label: 'Contacted', value: rContacted },
      { key: 'engaged', label: 'Engaged', value: rEngaged },
      { key: 'booking', label: 'Booking Set', value: rBooking },
      { key: 'intermediate', label: 'Intermediate', value: rIntermediate },
      { key: 'won', label: 'Closed Won', value: wo },
    ];
    const max = Math.max(1, ...flow.map((f) => f.value));

    // Step conversions over cumulative reached — always ≤ 100%. Contact rate is
    // vs the total enrolled (rNew === total).
    const rates = [
      {
        label: 'Contact rate',
        value: pct1(rContacted, rNew),
        caption: 'of total enrolled',
      },
      {
        label: 'Engagement rate',
        value: pct1(rEngaged, rContacted),
        caption: 'of those contacted',
      },
      {
        label: 'Booking rate',
        value: pct1(rBooking, rEngaged),
        caption: 'of those engaged',
      },
      {
        label: 'Win rate',
        value: wo + lo > 0 ? pct1(wo, wo + lo) : '—',
        caption: `${num(wo)} won · ${num(lo)} lost`,
      },
    ];

    const steps = [
      { from: 'New', to: 'Contacted', prev: rNew, cur: rContacted },
      { from: 'Contacted', to: 'Engaged', prev: rContacted, cur: rEngaged },
      { from: 'Engaged', to: 'Booking Set', prev: rEngaged, cur: rBooking },
      {
        from: 'Booking Set',
        to: 'Intermediate',
        prev: rBooking,
        cur: rIntermediate,
      },
    ];
    let biggest = steps[0];
    let biggestDrop = steps[0].prev - steps[0].cur;
    for (const st of steps) {
      const d = st.prev - st.cur;
      if (d > biggestDrop) {
        biggest = st;
        biggestDrop = d;
      }
    }
    const biggestPct = biggest.prev
      ? Math.round((biggestDrop / biggest.prev) * 100)
      : 0;

    return {
      flow,
      max,
      rates,
      biggest: { ...biggest, drop: biggestDrop, pct: biggestPct },
      pipeline: {
        open: funnel.bk + funnel.it,
        won: wo,
        lost: lo,
        total: funnel.bk + funnel.it + wo + lo,
      },
    };
  }, [firestore, dealParts, funnel]);

  const rangeLabel =
    rangeKey === 'custom' && customRange?.from && customRange?.to
      ? `${format(customRange.from, 'MMM d')} – ${format(customRange.to, 'MMM d')}`
      : 'Custom';

  // Render a number value, or a skeleton bar while a filter change reloads the
  // figures (numbers-only loading state).
  const numOr = (node: ReactNode): ReactNode =>
    numbersLoading ? (
      <Skeleton className="inline-block h-[0.9em] w-10 align-middle" />
    ) : (
      node
    );

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[#fbfbfd] px-8 py-6">
      {/* Header */}
      <div className="mb-4 flex shrink-0 items-center gap-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <Filter className="size-[18px]" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-[26px] font-semibold leading-none tracking-tight text-slate-900">
            Outbound · Funnel
          </h1>
          <p className="mt-1.5 text-[13px] text-slate-500">
            Business outcomes across the funnel — from first touch to closed
            deal.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="mb-5 flex shrink-0 flex-wrap items-center gap-2.5 border-b border-slate-200/70 pb-5">
        <div className="w-[240px]">
          <MultiSelect
            selected={selectedAgentIds}
            onChange={setSelectedAgentIds}
            options={agentOptions.map((a) => ({ value: a.id, label: a.name }))}
            allLabel="All agents"
            noneLabel="No agents"
            disabled={loadingAgents}
            placeholder={loadingAgents ? 'Loading agents…' : 'Select agents'}
            searchPlaceholder="Search agents…"
            emptyText="No agents found."
          />
        </div>

        <div className="w-[220px]">
          <MultiSelect
            selected={selectedCampaignIds}
            onChange={setSelectedCampaignIds}
            options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
            allLabel="All campaigns"
            noneLabel="No campaigns"
            disabled={campaignDisabled || selectedAgentIds.length === 0}
            placeholder={
              campaignDisabled ? 'No campaigns (inbound)' : 'All campaigns'
            }
            searchPlaceholder="Search campaigns…"
            emptyText="No campaigns found."
          />
        </div>

        {/* Source segmented group */}
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSource(s.key)}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                source === s.key
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Date range segmented group */}
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          {RANGES.map((r) =>
            r.key === 'custom' ? (
              <Popover
                key={r.key}
                open={calendarOpen}
                onOpenChange={setCalendarOpen}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setRangeKey('custom')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                      rangeKey === 'custom'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                    )}
                  >
                    <CalendarDays className="size-3.5" />
                    {rangeKey === 'custom' ? rangeLabel : 'Custom'}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    selected={customRange}
                    onSelect={(range) => {
                      setCustomRange(range);
                      if (range?.from && range?.to) setCalendarOpen(false);
                    }}
                    numberOfMonths={2}
                  />
                </PopoverContent>
              </Popover>
            ) : (
              <button
                key={r.key}
                type="button"
                onClick={() => setRangeKey(r.key)}
                className={cn(
                  'cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                  rangeKey === r.key
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                )}
              >
                {r.label}
              </button>
            )
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {lastRefreshed && (
            <span className="text-[12px] text-slate-400">
              Updated{' '}
              {formatDistanceToNowStrict(lastRefreshed, { addSuffix: true })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-lg border-slate-200 text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:bg-slate-50 hover:text-slate-900"
            onClick={load}
            disabled={(!agentsInited && !USE_TEST_DATA) || loading}
          >
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-5">
          {showSkeleton ? (
            <LoadingState />
          ) : isEmpty ? (
            <EmptyState />
          ) : (
            <>
              {/* Summary KPI tiles */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {kpis.map(({ drillKey, ...k }) => {
                  const kDrill = drillKey ? drillForKey(drillKey) : null;
                  return (
                    <KpiCard
                      key={k.label}
                      {...k}
                      loading={numbersLoading}
                      onClick={kDrill ? () => setDrill(kDrill) : undefined}
                    />
                  );
                })}
              </div>

              {/* Funnel table */}
              <div className={cn(CARD, 'overflow-hidden')}>
                <div className="flex items-center justify-between border-b border-slate-200/70 px-6 py-3.5">
                  <h2 className="text-[13px] font-semibold uppercase tracking-wider text-slate-500">
                    Funnel breakdown
                  </h2>
                  {deal && !dealNotConnected && !dealError && (
                    <span className="text-[12px] text-slate-400">
                      {deal.pipeline_label} ·{' '}
                      <span className="font-mono tabular-nums text-slate-500">
                        {num(deal.total)}
                      </span>{' '}
                      deals
                    </span>
                  )}
                </div>

                {firestoreError && (
                  <div className="px-6 pt-4">
                    <InlineWarning text="Chat counts unavailable — top-of-funnel stages show “—”." />
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="sticky left-0 z-10 bg-white px-6 py-3 text-left align-bottom text-[11px] font-bold uppercase tracking-wider text-slate-400" />
                        {stageCols.map((s) => (
                          <th
                            key={s.key}
                            className={cn(
                              'px-4 py-3 text-center align-bottom',
                              s.key === 'booking' && 'border-l border-slate-200'
                            )}
                          >
                            <div
                              className="mx-auto mb-2 h-1 w-8 rounded-full"
                              style={{
                                backgroundColor: s.colorKey
                                  ? ROW_COLOR[s.colorKey]
                                  : '#94a3b8',
                              }}
                            />
                            {drillForKey(s.key) ? (
                              <button
                                type="button"
                                onClick={() => setDrill(drillForKey(s.key))}
                                title={`View ${s.label} contacts`}
                                className="whitespace-nowrap text-[12px] font-semibold text-slate-700 underline decoration-dotted decoration-slate-300 underline-offset-4 transition-colors hover:text-slate-900 hover:decoration-slate-500"
                              >
                                {s.label}
                              </button>
                            ) : (
                              <span className="whitespace-nowrap text-[12px] font-semibold text-slate-700">
                                {s.label}
                              </span>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {metricRows.map((m) => (
                        <tr
                          key={m.key}
                          className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/60"
                        >
                          <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-6 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            {m.label}
                          </td>
                          {stageCols.map((s) => {
                            const cellDrill = m.hero
                              ? drillForKey(s.key)
                              : null;
                            const drillable = !!cellDrill;
                            return (
                              <td
                                key={s.key}
                                onClick={
                                  drillable
                                    ? () => setDrill(cellDrill)
                                    : undefined
                                }
                                title={
                                  drillable
                                    ? `View ${s.label} contacts`
                                    : undefined
                                }
                                className={cn(
                                  'whitespace-nowrap px-4 text-center font-mono tabular-nums',
                                  s.key === 'booking' &&
                                    'border-l border-slate-100',
                                  m.hero
                                    ? cn(
                                        'py-3 text-[18px] font-bold',
                                        s.countClass ?? 'text-slate-900'
                                      )
                                    : 'py-2.5 text-[13px] text-slate-500',
                                  drillable &&
                                    'cursor-pointer rounded-lg hover:bg-slate-100'
                                )}
                              >
                                {numOr(m.render(s))}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Intermediate breakdown (parallel open stages — shown as a note, not columns) */}
                {intermediateStages.length > 0 && (
                  <div className="border-t border-slate-100 px-6 py-3 text-[12px] text-slate-400">
                    <span className="font-semibold uppercase tracking-wider text-slate-500">
                      Intermediate
                    </span>
                    <span className="mx-2 text-slate-300">·</span>
                    {intermediateStages.map((s, i) => (
                      <span key={s.id}>
                        {i > 0 && (
                          <span className="mx-1.5 text-slate-300">·</span>
                        )}
                        {s.label}{' '}
                        <span className="font-mono font-semibold text-slate-600">
                          {num(s.count)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}

                {/* Deal-side notice */}
                {(dealNotConnected || dealError) && (
                  <div className="px-6 pb-5">
                    {dealNotConnected ? (
                      <DealNotice
                        icon="plug"
                        title="HubSpot not connected"
                        body="Connect HubSpot for this agent to see Booking Set → Closed Won / Lost. Top-of-funnel counts above are unaffected."
                      />
                    ) : (
                      <DealNotice
                        icon="warn"
                        title="Deal funnel unavailable"
                        body={dealError as string}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Lower section — funnel shape + insight cards */}
              {analytics && (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
                  {/* Funnel shape */}
                  <div className={cn(CARD, 'p-5 lg:col-span-2')}>
                    <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Funnel shape
                    </h3>
                    <div className="space-y-2.5">
                      {analytics.flow.map((f) => {
                        const fDrill = drillForKey(f.key);
                        return (
                          <div
                            key={f.key}
                            onClick={
                              fDrill ? () => setDrill(fDrill) : undefined
                            }
                            title={
                              fDrill ? `View ${f.label} contacts` : undefined
                            }
                            className={cn(
                              'flex items-center gap-3 rounded-md',
                              fDrill &&
                                'cursor-pointer transition-colors hover:bg-slate-50'
                            )}
                          >
                            <span className="w-24 shrink-0 text-right text-[12px] font-medium text-slate-500">
                              {f.label}
                            </span>
                            <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-slate-100">
                              <div
                                className="h-full rounded-md transition-[width] duration-500"
                                style={{
                                  width: `${Math.max((f.value / analytics.max) * 100, f.value > 0 ? 2 : 0)}%`,
                                  backgroundColor: ROW_COLOR[f.key],
                                }}
                              />
                            </div>
                            <span className="w-14 shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-slate-700">
                              {numOr(num(f.value))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Conversion rates */}
                  <div className={cn(CARD, 'p-5')}>
                    <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Conversion rates
                    </h3>
                    <div className="space-y-3.5">
                      {analytics.rates.map((r) => (
                        <div
                          key={r.label}
                          className="flex items-baseline justify-between gap-2"
                        >
                          <div>
                            <p className="text-[12px] font-semibold text-slate-700">
                              {r.label}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {r.caption}
                            </p>
                          </div>
                          <span className="font-mono text-[18px] font-bold tabular-nums text-slate-900">
                            {numOr(r.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pipeline summary */}
                  <div className={cn(CARD, 'flex flex-col p-5')}>
                    <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Pipeline summary
                    </h3>
                    <div className="space-y-2.5">
                      <StatLine
                        label="Open deals"
                        value={num(analytics.pipeline.open)}
                        loading={numbersLoading}
                      />
                      <StatLine
                        label="Closed won"
                        value={num(analytics.pipeline.won)}
                        valueClass="text-emerald-600"
                        loading={numbersLoading}
                      />
                      <StatLine
                        label="Closed lost"
                        value={num(analytics.pipeline.lost)}
                        valueClass="text-rose-600"
                        loading={numbersLoading}
                      />
                      <StatLine
                        label="Total deals"
                        value={num(analytics.pipeline.total)}
                        loading={numbersLoading}
                      />
                    </div>
                    <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Biggest drop-off
                      </p>
                      <p className="mt-1 text-[12px] font-semibold text-slate-700">
                        {analytics.biggest.from} → {analytics.biggest.to}
                      </p>
                      <p className="font-mono text-[13px] font-bold tabular-nums text-rose-600">
                        {numOr(
                          `${num(analytics.biggest.drop)} (${analytics.biggest.pct}%)`
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <FunnelChatsDrawer
        open={!!drill}
        onOpenChange={(o) => {
          if (!o) setDrill(null);
        }}
        drill={drill}
        source={source}
        agentIds={selectedAgentIds}
        campaignId={
          selectedCampaignIds.length === 1 &&
          selectedCampaignIds.length !== campaigns.length
            ? selectedCampaignIds[0]
            : undefined
        }
        start={computeBounds(rangeKey, customRange).start ?? null}
        end={computeBounds(rangeKey, customRange).end ?? null}
      />
    </div>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent,
  valueClass,
  loading,
  onClick,
}: {
  label: string;
  value: string | number;
  sub: string;
  accent: string;
  valueClass?: string;
  loading?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      title={onClick ? `View ${label} contacts` : undefined}
      className={cn(
        CARD,
        'p-4',
        onClick &&
          'cursor-pointer transition-colors hover:border-slate-300 hover:bg-slate-50/60'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </p>
      </div>
      {loading ? (
        <Skeleton className="mt-2.5 h-[26px] w-20" />
      ) : (
        <p
          className={cn(
            'mt-2.5 font-mono text-[26px] font-semibold leading-none tabular-nums',
            valueClass ?? 'text-slate-900'
          )}
        >
          {value}
        </p>
      )}
      <p className="mt-1.5 text-[12px] text-slate-400">{sub}</p>
    </div>
  );
}

// ─── Sub-components: skeleton, empty, notices ────────────────────────────────

function LoadingState() {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={cn(CARD, 'p-5')}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-20" />
            <Skeleton className="mt-2 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className={cn(CARD, 'p-6')}>
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, r) => (
            <div key={r} className="flex items-center gap-4">
              <Skeleton className="h-4 w-24 shrink-0" />
              {Array.from({ length: 7 }).map((_, c) => (
                <Skeleton key={c} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className={cn(CARD, 'h-48 p-6 lg:col-span-2')}>
          <Skeleton className="h-3 w-28" />
          <div className="mt-5 space-y-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        </div>
        {Array.from({ length: 2 }).map((_, k) => (
          <div key={k} className={cn(CARD, 'h-48 p-6')}>
            <Skeleton className="h-3 w-28" />
            <div className="mt-5 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function StatLine({
  label,
  value,
  valueClass,
  loading,
}: {
  label: string;
  value: string;
  valueClass?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12px] text-slate-500">{label}</span>
      {loading ? (
        <Skeleton className="h-4 w-10" />
      ) : (
        <span
          className={cn(
            'font-mono text-[14px] font-bold tabular-nums',
            valueClass ?? 'text-slate-900'
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white py-24 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50">
        <Filter className="size-[18px] text-slate-400" />
      </div>
      <p className="mt-4 text-[15px] font-semibold text-slate-800">
        No contacts in this funnel yet
      </p>
      <p className="mt-1 text-[13px] text-slate-500">
        Nothing matches these filters. Try a wider date range or another
        campaign.
      </p>
    </div>
  );
}

function InlineWarning({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
      <AlertTriangle className="size-3.5 shrink-0" />
      {text}
    </div>
  );
}

function DealNotice({
  icon,
  title,
  body,
}: {
  icon: 'plug' | 'warn';
  title: string;
  body: string;
}) {
  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      {icon === 'plug' ? (
        <Unplug className="mt-0.5 size-4 shrink-0 text-slate-400" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      )}
      <div>
        <p className="text-[13px] font-semibold text-slate-800">{title}</p>
        <p className="mt-0.5 text-[12px] text-slate-500">{body}</p>
      </div>
    </div>
  );
}
