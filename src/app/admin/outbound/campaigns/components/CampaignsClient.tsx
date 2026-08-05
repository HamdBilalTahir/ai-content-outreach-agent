'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Megaphone, Plus, RefreshCw } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BusinessOnlyBadge,
  LitigatorOnlyBadge,
  Campaign,
  campaignId,
  sectionCard,
  StatusPill,
  useOutboundAgents,
} from '../shared';
import NewCampaignSheet from './NewCampaignSheet';
import { SearchableSelect } from './SearchableSelect';
import { cn } from '@/lib/utils';

// Data-dense dashboard header cells: small, uppercase, tracked, muted.
const HEAD_CLS =
  'text-[11px] font-semibold uppercase tracking-wide text-gray-400';

// In-memory cache (module scope) so returning to the list via back-nav paints
// the last-seen campaigns instantly, then refreshes in the background.
const campaignsCache = new Map<string, Campaign[]>();
let lastAgentId: string | null = null;

const SOURCE_LABEL: Record<string, string> = {
  hubspot_list: 'HubSpot list',
  hubspot_search: 'HubSpot search',
  csv: 'CSV / Excel',
};

function formatCreated(v?: string | number): string {
  if (v == null) return '—';
  const d = typeof v === 'number' ? new Date(v) : new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Right-aligned metric value: real numbers get tabular figures so columns line
// up; missing values recede to a muted dash so the eye lands on actual data.
function Metric({ v, strong }: { v?: number; strong?: boolean }) {
  if (typeof v !== 'number') return <span className="text-gray-300">—</span>;
  return (
    <span
      className={cn(
        'tabular-nums',
        strong ? 'font-semibold text-gray-900' : 'text-gray-700'
      )}
    >
      {v.toLocaleString()}
    </span>
  );
}

export default function CampaignsClient({ companyId }: { companyId: string }) {
  const router = useRouter();
  const {
    outboundAgents,
    loading: loadingAgents,
    selectedId,
    setSelectedId,
  } = useOutboundAgents(companyId);

  const [campaigns, setCampaigns] = useState<Campaign[]>(() =>
    lastAgentId ? (campaignsCache.get(lastAgentId) ?? []) : []
  );
  const [hasLoaded, setHasLoaded] = useState<boolean>(
    () => !!(lastAgentId && campaignsCache.get(lastAgentId))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    if (!selectedId) return;
    // Paint cached rows immediately (instant on back-nav / agent switch), then
    // refresh in the background.
    const cached = campaignsCache.get(selectedId);
    if (cached) {
      setCampaigns(cached);
      setHasLoaded(true);
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outbound/campaigns?agent_id=${encodeURIComponent(selectedId)}`
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      const list: Campaign[] = Array.isArray(data)
        ? data
        : (data?.campaigns ?? []);
      setCampaigns(list);
      campaignsCache.set(selectedId, list);
      lastAgentId = selectedId;
      setHasLoaded(true);
    } catch (e: any) {
      setError(e?.message || 'Could not load campaigns');
      if (!cached) setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  // Skeleton while booting with nothing to show yet (agents still resolving, no
  // agent selected, or the very first fetch with no cached rows).
  const showSkeleton = loadingAgents || !selectedId || (loading && !hasLoaded);

  const openCampaign = useCallback(
    (id: string) => {
      router.push(
        `/admin/outbound/campaigns/${encodeURIComponent(
          id
        )}?companyId=${encodeURIComponent(
          companyId
        )}&agentId=${encodeURIComponent(selectedId)}`
      );
    },
    [router, companyId, selectedId]
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[#fbfbfc] p-8">
      {/* Header */}
      <div className="mb-8 flex shrink-0 items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg shadow-slate-900/25">
          <Megaphone className="size-6" />
        </div>
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-gray-900">
            Outbound · Campaigns
          </h1>
          <p className="mt-1 text-[14px] text-gray-500">
            Run outbound at scale — pick an audience, fire it, and watch the
            funnel.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="mb-6 flex shrink-0 flex-wrap items-center gap-3">
        <div className="w-[280px]">
          <SearchableSelect
            value={selectedId}
            onChange={setSelectedId}
            options={outboundAgents.map((a) => ({
              value: a.id,
              label: a.name,
            }))}
            disabled={loadingAgents}
            placeholder={loadingAgents ? 'Loading agents…' : 'Select agent'}
            searchPlaceholder="Search agents…"
            emptyText="No agents found."
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-10 gap-1.5 rounded-xl"
          onClick={load}
          disabled={!selectedId || loading}
        >
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          Refresh
        </Button>

        <div className="ml-auto">
          <Button
            className="h-10 gap-1.5 rounded-xl bg-slate-900 text-white hover:bg-slate-800"
            onClick={() => setSheetOpen(true)}
            disabled={!selectedId}
          >
            <Plus className="size-4" />
            New campaign
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={sectionCard + ' p-0'}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD_CLS}>Name</TableHead>
                <TableHead className={HEAD_CLS}>Source</TableHead>
                <TableHead className={cn(HEAD_CLS, 'text-right')}>
                  Audience
                </TableHead>
                <TableHead className={cn(HEAD_CLS, 'text-right')}>
                  Enrolled
                </TableHead>
                <TableHead className={cn(HEAD_CLS, 'text-right')}>
                  Contacted
                </TableHead>
                <TableHead className={cn(HEAD_CLS, 'text-right')}>
                  Engaged
                </TableHead>
                <TableHead className={cn(HEAD_CLS, 'text-right')}>
                  Booked
                </TableHead>
                <TableHead className={HEAD_CLS}>Status</TableHead>
                <TableHead className={HEAD_CLS}>Created</TableHead>
                {/* trailing chevron affordance column */}
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {showSkeleton ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                    {Array.from({ length: 10 }).map((_, j) => (
                      <TableCell key={j} className="py-3.5">
                        <Skeleton className="h-4 w-full max-w-[120px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : error && campaigns.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="h-24 text-center text-[13px] text-red-500"
                  >
                    {error}
                  </TableCell>
                </TableRow>
              ) : campaigns.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={10} className="py-14">
                    <div className="flex flex-col items-center justify-center gap-3 text-center">
                      <div className="flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                        <Megaphone className="size-6" />
                      </div>
                      <div>
                        <p className="text-[15px] font-semibold text-gray-900">
                          No campaigns yet
                        </p>
                        <p className="mt-1 text-[13px] text-gray-500">
                          Pick an audience and fire your first outbound
                          campaign.
                        </p>
                      </div>
                      <Button
                        className="mt-1 h-9 gap-1.5 rounded-xl bg-slate-900 text-white hover:bg-slate-800"
                        onClick={() => setSheetOpen(true)}
                        disabled={!selectedId}
                      >
                        <Plus className="size-4" />
                        New campaign
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                campaigns.map((c) => {
                  const id = campaignId(c);
                  return (
                    <TableRow
                      key={id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${c.name || 'campaign'}`}
                      className="group cursor-pointer transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                      onClick={() => openCampaign(id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openCampaign(id);
                        }
                      }}
                    >
                      <TableCell className="py-3.5 font-medium text-gray-900">
                        <span className="flex items-center gap-2">
                          <span className="truncate">
                            {c.name || 'Untitled'}
                          </span>
                          <BusinessOnlyBadge show={c.business_only} />
                          <LitigatorOnlyBadge show={c.litigator_only} />
                        </span>
                      </TableCell>
                      <TableCell className="py-3.5 text-gray-600">
                        {SOURCE_LABEL[String(c.source)] ?? c.source ?? (
                          <span className="text-gray-300">—</span>
                        )}
                      </TableCell>
                      <TableCell className="py-3.5 text-right">
                        <Metric v={c.audience_size ?? c.total} strong />
                      </TableCell>
                      <TableCell className="py-3.5 text-right">
                        <Metric v={c.enrolled_count} strong />
                      </TableCell>
                      <TableCell className="py-3.5 text-right">
                        <Metric v={c.counts?.contacted} />
                      </TableCell>
                      <TableCell className="py-3.5 text-right">
                        <Metric v={c.counts?.engaged} />
                      </TableCell>
                      <TableCell className="py-3.5 text-right">
                        <Metric v={c.counts?.booked} />
                      </TableCell>
                      <TableCell className="py-3.5">
                        <StatusPill status={c.status} />
                      </TableCell>
                      <TableCell className="py-3.5 text-gray-500">
                        {formatCreated(c.created_at)}
                      </TableCell>
                      <TableCell className="py-3.5 pr-3 text-right">
                        <ChevronRight className="ml-auto size-4 text-gray-300 transition-colors group-hover:text-gray-500" />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <NewCampaignSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        agentId={selectedId}
        onCreated={() => {
          setSheetOpen(false);
          load();
        }}
      />
    </div>
  );
}
