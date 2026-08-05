'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Megaphone,
  ArrowLeft,
  RefreshCw,
  Pause,
  Play,
  Plus,
  Loader2,
  StopCircle,
  PauseCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  BusinessOnlyBadge,
  LitigatorOnlyBadge,
  Campaign,
  StatusPill,
  TERMINAL_STATUSES,
} from '../shared';
import NewCampaignSheet from './NewCampaignSheet';
import ChatDetailView from '@/components/outbound/chat-detail/ChatDetailView';
import {
  ChatContactList,
  type ContactChat,
} from '@/components/outbound/chat-detail/ChatContactList';

const POLL_MS = 12 * 1000;
const CHATS_POLL_MS = 60 * 1000;

// One inline stat in the compact header strip. Shows a skeleton until the data
// is ready, so the row reveals every number together instead of flashing partial
// values (e.g. Enrolled filled while Contacted/Engaged are still "—").
function Stat({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      {loading ? (
        <Skeleton className="h-4 w-7 rounded" />
      ) : (
        <span className="text-[15px] font-bold tabular-nums text-gray-900">
          {typeof value === 'number' ? value.toLocaleString() : '—'}
        </span>
      )}
      <span className="text-[11px] uppercase tracking-wide text-gray-400">
        {label}
      </span>
    </div>
  );
}

export default function CampaignDetailClient({
  campaignId,
  companyId,
  agentId,
}: {
  campaignId: string;
  companyId: string;
  agentId?: string;
}) {
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [endConfirm, setEndConfirm] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Funnel counts aren't returned by the detail GET — derived client-side:
  // Contacted/Engaged from Firestore chat stages, Booked from the deal funnel.
  const [counts, setCounts] = useState<{
    contacted: number | null;
    engaged: number | null;
    booked: number | null;
  }>({ contacted: null, engaged: null, booked: null });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Contact inbox ──
  const [chats, setChats] = useState<ContactChat[]>([]);
  // True count of enrolled chats (the API caps the returned list but reports the
  // real total). Used for the "Enrolled" KPI instead of the backend counter,
  // which over-counts (it tallies dequeued records, not chats actually created).
  const [chatsTotal, setChatsTotal] = useState<number | null>(null);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/outbound/campaigns/${encodeURIComponent(campaignId)}`
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      setCampaign(data as Campaign);
      setError(null);
      setLastRefreshedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || 'Could not load campaign');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/outbound/campaigns/${encodeURIComponent(campaignId)}/chats`,
        { cache: 'no-store' }
      );
      const data = await res.json();
      if (res.ok) {
        const list = Array.isArray(data.chats) ? data.chats : [];
        setChats(list);
        setChatsTotal(
          typeof data.total === 'number' ? data.total : list.length
        );
      }
    } catch (e) {
      console.error('[campaign] chats list failed', e);
    } finally {
      setChatsLoaded(true);
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadChats();
    const id = setInterval(loadChats, CHATS_POLL_MS);
    return () => clearInterval(id);
  }, [loadChats]);

  // Auto-select the first contact once the list arrives.
  useEffect(() => {
    if (!activeChatId && chats.length > 0) setActiveChatId(chats[0].chat_id);
  }, [chats, activeChatId]);

  // Poll the campaign until it reaches a terminal status.
  useEffect(() => {
    const terminal =
      campaign && TERMINAL_STATUSES.has(String(campaign.status).toLowerCase());
    if (terminal) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(load, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [campaign?.status, load]);

  const act = async (action: 'pause' | 'resume' | 'stop') => {
    setActing(true);
    try {
      const res = await fetch(
        `/api/outbound/campaigns/${encodeURIComponent(campaignId)}/${action}`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      toast.success(
        action === 'pause'
          ? 'Campaign paused'
          : action === 'resume'
            ? 'Campaign resumed'
            : 'Campaign ended'
      );
      await load();
    } catch (e: any) {
      toast.error(e?.message || `Could not ${action} campaign`);
    } finally {
      setActing(false);
    }
  };

  const status = String(campaign?.status ?? '').toLowerCase();
  const isPaused = status === 'paused';
  const isTerminal = TERMINAL_STATUSES.has(status);
  // The detail GET doesn't return agent_id — prefer the one threaded from the
  // list URL, falling back to the campaign doc if present.
  const effectiveAgentId = agentId || campaign?.agent_id || '';

  // "Booked" from the deal-funnel API (HubSpot pipeline entry stage). Contacted/Engaged are
  // derived from the loaded chats below — a two-equality count query (campaign_id + stage)
  // needs a composite index and was silently failing to a stale backend counter.
  const loadBooked = useCallback(async () => {
    if (!campaignId || !effectiveAgentId) return;
    try {
      const res = await fetch(
        `/api/outbound/analytics/deal-funnel?agent_id=${encodeURIComponent(
          effectiveAgentId
        )}&campaign_id=${encodeURIComponent(campaignId)}`
      );
      const data = await res.json();
      if (res.ok) {
        const entry = (data?.stages ?? []).find((s: any) => s?.is_entry);
        setCounts((prev) => ({ ...prev, booked: entry?.count ?? 0 }));
      }
    } catch (e) {
      console.error('[campaign] deal funnel failed', e);
    }
  }, [campaignId, effectiveAgentId]);

  useEffect(() => {
    loadBooked();
  }, [loadBooked]);

  const total = campaign?.total ?? campaign?.audience_size;
  // Enrolled = chats that actually exist for this campaign (ground truth), not
  // the backend counter, which over-counts dequeued records. Falls back to the
  // counter until the chats have loaded.
  const enrolled = chatsLoaded ? (chatsTotal ?? 0) : campaign?.enrolled_count;
  // Derive Contacted/Engaged from the SAME loaded chats the contact rail shows, so the header
  // numbers always match the list (and its stage-filter counts) — current stage membership.
  const contacted = chatsLoaded
    ? chats.filter((c) => c.stage === 'Contacted').length
    : (campaign?.counts?.contacted ?? undefined);
  const engaged = chatsLoaded
    ? chats.filter((c) => c.stage === 'Engaged').length
    : (campaign?.counts?.engaged ?? undefined);
  const booked = counts.booked ?? campaign?.counts?.booked;
  // Remaining = records still to process, from the backend. Do NOT derive it as
  // (audience − enrolled): the gap also includes contacts permanently skipped as
  // duplicate/invalid numbers, which are not "remaining" — they'll never enroll.
  const remaining = campaign?.remaining;

  // Tick once a second so the "last refreshed" label counts up live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const lastRefreshedLabel = useMemo(() => {
    if (!lastRefreshedAt) return null;
    const secs = Math.max(0, Math.round((now - lastRefreshedAt) / 1000));
    if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'} ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  }, [lastRefreshedAt, now]);

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[#fbfbfc] p-6">
      {/* Paused banner — high-visibility, so anyone landing sees the campaign is halted. */}
      {isPaused && (
        <div className="mb-4 flex shrink-0 items-center gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3 shadow-sm">
          <PauseCircle className="size-6 shrink-0 text-amber-600" />
          <div className="min-w-0 text-[13px] leading-tight text-amber-900">
            <span className="font-bold">
              Campaign paused
              {campaign?.paused_at
                ? ` at ${new Date(campaign.paused_at).toLocaleString()}`
                : ''}
            </span>
            <span className="ml-1.5 font-medium text-amber-700">
              — no new contacts are being enrolled or contacted. Click Resume to
              continue.
            </span>
          </div>
        </div>
      )}
      {/* Compact header strip */}
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3">
        <button
          onClick={() =>
            router.push(
              `/admin/outbound/campaigns?companyId=${encodeURIComponent(
                companyId
              )}`
            )
          }
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50"
          aria-label="Back to campaigns"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-md shadow-slate-900/20">
          <Megaphone className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-[18px] font-bold leading-tight tracking-tight text-gray-900">
              {campaign?.name || (loading ? 'Loading…' : 'Campaign')}
            </h1>
            {campaign && <StatusPill status={campaign.status} />}
            <BusinessOnlyBadge show={campaign?.business_only} />
            <LitigatorOnlyBadge show={campaign?.litigator_only} />
          </div>
          {campaign?.per_day != null && (
            <p className="mt-0.5 text-[11px] text-gray-400">
              Pacing {campaign.per_day.toLocaleString()} contacts/day
            </p>
          )}
        </div>

        {/* Inline stats */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-gray-100 bg-white px-4 py-2 shadow-sm">
          <Stat
            label="Enrolled"
            loading={!chatsLoaded}
            value={
              typeof enrolled === 'number'
                ? enrolled
                : typeof total === 'number'
                  ? total
                  : undefined
            }
          />
          <Stat label="Contacted" value={contacted} loading={!chatsLoaded} />
          <Stat label="Engaged" value={engaged} loading={!chatsLoaded} />
          <Stat label="Booked" value={booked} loading={!chatsLoaded} />
          <Stat label="Remaining" value={remaining} loading={!chatsLoaded} />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 rounded-xl"
              onClick={() => {
                load();
                loadChats();
                loadBooked();
              }}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            {lastRefreshedLabel && (
              <span className="text-[11px] leading-tight text-gray-400">
                Last refreshed
                <br />
                {lastRefreshedLabel}
              </span>
            )}
          </div>
          <div className="mx-1 h-6 w-px bg-gray-200" />
          {!isTerminal && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 rounded-xl"
              disabled={acting}
              onClick={() => act(isPaused ? 'resume' : 'pause')}
            >
              {acting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : isPaused ? (
                <Play className="size-4" />
              ) : (
                <Pause className="size-4" />
              )}
              {isPaused ? 'Resume' : 'Pause'}
            </Button>
          )}
          {!isTerminal && campaign && (
            <AlertDialog
              open={endOpen}
              onOpenChange={(open) => {
                setEndOpen(open);
                if (!open) setEndConfirm('');
              }}
            >
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 rounded-xl border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                  disabled={acting}
                >
                  <StopCircle className="size-4" />
                  End
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>End this campaign?</AlertDialogTitle>
                  <AlertDialogDescription>
                    No more contacts will be enrolled. Anyone already in a
                    conversation with Ava continues. This can&apos;t be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-2">
                  <p className="text-sm text-slate-600">
                    Type{' '}
                    <span className="font-semibold text-slate-900">
                      End {campaign.name}
                    </span>{' '}
                    to confirm.
                  </p>
                  <Input
                    value={endConfirm}
                    onChange={(e) => setEndConfirm(e.target.value)}
                    placeholder={`End ${campaign.name}`}
                    autoFocus
                  />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={endConfirm !== `End ${campaign.name}`}
                    onClick={() => act('stop')}
                    className="bg-red-600 text-white hover:bg-red-700"
                  >
                    End campaign
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button
            className="h-9 gap-1.5 rounded-xl bg-slate-900 text-white hover:bg-slate-800"
            disabled={!effectiveAgentId || isPaused || isTerminal}
            title={
              isPaused
                ? 'Resume the campaign to add records'
                : isTerminal
                  ? 'Campaign has ended'
                  : undefined
            }
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-4" />
            Add more
          </Button>
        </div>
      </div>

      {error && !campaign && (
        <div className="mb-3 rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-[13px] text-red-600">
          {error}
        </div>
      )}

      {/* Inbox: contact rail + conversation */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Contact rail (shared component; stage filter enabled) */}
        <ChatContactList
          chats={chats}
          loading={!chatsLoaded}
          activeChatId={activeChatId}
          onSelect={setActiveChatId}
          showStageFilter
          emptyHint="Enrolled contacts appear here once the campaign starts."
        />

        {/* Conversation + activities */}
        <ChatDetailView chatId={activeChatId} className="min-h-0 flex-1" />
      </div>

      {effectiveAgentId && (
        <NewCampaignSheet
          open={addOpen}
          onOpenChange={setAddOpen}
          agentId={effectiveAgentId}
          mode="add"
          campaignId={campaignId}
          campaignScreening={{
            businessOnly: campaign?.business_only,
            litigatorOnly: campaign?.litigator_only,
          }}
          onCreated={() => {
            setAddOpen(false);
            load();
            loadChats();
          }}
        />
      )}
    </div>
  );
}
