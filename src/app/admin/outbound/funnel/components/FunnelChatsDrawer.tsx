'use client';

import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import ChatDetailView from '@/components/outbound/chat-detail/ChatDetailView';
import {
  ChatContactList,
  type ContactChat,
} from '@/components/outbound/chat-detail/ChatContactList';

// What the drawer is drilling into:
//  - chat-stage: chats CURRENTLY at a chat stage (New / Contacted / Engaged) — server-queried by `stage`.
//  - deal: attributed conversions whose HubSpot deal sits in one of `stageIds` (Booking Set / Intermediate /
//    Closed Won / Closed Lost). Sourced from the attribution write-back on the chat (memory._converted_to_deal
//    + memory._hubspot_deal_stage_id), so it shows the contacts + the conversation behind each deal.
export type FunnelDrill =
  | { kind: 'chat-stage'; stage: string }
  | { kind: 'deal'; label: string; stageIds: string[] };

// Drill-down drawer: lists the chats behind a funnel column, scoped like the funnel
// (agents / campaign / date), and reuses the campaign-inbox components
// (ChatContactList + ChatDetailView) — click a contact to open the conversation on the right.
export default function FunnelChatsDrawer({
  open,
  onOpenChange,
  drill,
  source,
  agentIds,
  campaignId,
  start,
  end,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drill: FunnelDrill | null;
  source: 'outbound' | 'inbound' | 'all';
  agentIds: string[];
  campaignId?: string;
  start: Date | null;
  end: Date | null;
}) {
  const [chats, setChats] = useState<ContactChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const heading =
    drill?.kind === 'deal'
      ? drill.label
      : drill?.kind === 'chat-stage'
        ? drill.stage
        : '';

  useEffect(() => {
    if (!open || !drill) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setChats([]);
    setActiveChatId(null);
    (async () => {
      try {
        // Via the Admin-SDK drill route (server-side query + Test/archived
        // filtering + the mapped contact cards).
        const params = new URLSearchParams({ kind: drill.kind, source });
        if (drill.kind === 'deal')
          params.set('stage_ids', drill.stageIds.join(','));
        else params.set('stage', drill.stage);
        if (agentIds.length) params.set('agent_ids', agentIds.join(','));
        if (campaignId) params.set('campaign_id', campaignId);
        if (start && end) {
          params.set('start', start.toISOString());
          params.set('end', end.toISOString());
        }
        const res = await fetch(`/api/outbound/funnel/drill?${params}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok)
          throw new Error(data?.error || `Request failed (${res.status})`);
        const list: ContactChat[] = Array.isArray(data.chats) ? data.chats : [];
        setChats(list);
        setActiveChatId(list[0]?.chat_id ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not load chats');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, drill, source, agentIds, campaignId, start, end]);

  const isDeal = drill?.kind === 'deal';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-[#fbfbfc] p-0 sm:max-w-[900px] lg:max-w-[70vw]"
      >
        <SheetHeader className="border-b border-gray-100 bg-white px-6 py-4">
          <SheetTitle className="text-[16px] font-bold text-gray-900">
            {heading} · {loading ? '…' : chats.length} contact
            {chats.length === 1 ? '' : 's'}
          </SheetTitle>
          <SheetDescription className="text-[12px] text-gray-500">
            {isDeal
              ? `Contacts whose deal is in ${heading} — click one to see the conversation.`
              : `Chats currently at the ${heading} stage.`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 gap-4 p-4">
          {error ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-red-600">
              {error}
            </div>
          ) : (
            <>
              <ChatContactList
                chats={chats}
                loading={loading}
                activeChatId={activeChatId}
                onSelect={setActiveChatId}
                emptyLabel={
                  isDeal
                    ? 'No contacts for this stage'
                    : 'No chats at this stage'
                }
              />
              <ChatDetailView
                chatId={activeChatId}
                className="min-h-0 flex-1"
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
