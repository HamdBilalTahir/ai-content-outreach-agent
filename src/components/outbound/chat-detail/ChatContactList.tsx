'use client';

import { useMemo, useState } from 'react';
import { Inbox as InboxIcon, Building2, Phone, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { stageColor, fmtRelative } from './helpers';

// One contact chat row (shape shared by the campaign inbox and the funnel drawer).
export interface ContactChat {
  chat_id: string;
  name: string | null;
  phone: string | null;
  company: string | null;
  stage: string | null;
  started_at: number | null;
  updated_at: number | null;
  last_message: string | null;
}

export function initials(name: string | null, phone: string | null): string {
  const base = (name || phone || '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

const PAGE = 20;

// Left contact rail: header + optional stage filter + scrollable, paginated list.
// Shared by the campaign inbox and the funnel drill-down drawer so both render the
// exact same component.
export function ChatContactList({
  chats,
  loading,
  activeChatId,
  onSelect,
  showStageFilter = false,
  emptyLabel = 'No contacts yet',
  emptyHint,
}: {
  chats: ContactChat[];
  loading: boolean;
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  showStageFilter?: boolean;
  emptyLabel?: string;
  emptyHint?: string;
}) {
  const [visibleN, setVisibleN] = useState(PAGE);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Distinct stages present, in the order they first appear — drives the filter chips.
  const stages = useMemo(() => {
    const seen: string[] = [];
    for (const c of chats) {
      const s = (c.stage || '').trim();
      if (s && !seen.includes(s)) seen.push(s);
    }
    return seen;
  }, [chats]);

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const filtered = useMemo(() => {
    let list =
      stageFilter === 'all'
        ? chats
        : chats.filter((c) => (c.stage || '') === stageFilter);
    if (q) {
      list = list.filter((c) => {
        const phoneDigits = (c.phone || '').replace(/\D/g, '');
        return (
          (c.name || '').toLowerCase().includes(q) ||
          (c.company || '').toLowerCase().includes(q) ||
          (c.phone || '').toLowerCase().includes(q) ||
          (!!qDigits && phoneDigits.includes(qDigits))
        );
      });
    }
    return list;
  }, [chats, stageFilter, q, qDigits]);
  const visible = filtered.slice(0, visibleN);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-gray-900">Contacts</h2>
        {!loading && (
          <span className="text-[11px] text-gray-400">{filtered.length}</span>
        )}
      </div>

      <div className="border-b border-gray-100 px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setVisibleN(PAGE);
            }}
            placeholder="Search name, company or phone…"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-7 text-[12px] text-gray-700 transition-colors placeholder:text-gray-400 focus:border-slate-300 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-200"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearch('');
                setVisibleN(PAGE);
              }}
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {showStageFilter && stages.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-gray-100 px-2 py-2">
          {['all', ...stages].map((s) => {
            const active = stageFilter === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStageFilter(s);
                  setVisibleN(PAGE);
                }}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                  active
                    ? 'bg-slate-900 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                )}
              >
                {s === 'all' ? 'All' : s}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (
            el.scrollHeight - el.scrollTop - el.clientHeight < 120 &&
            visibleN < filtered.length
          )
            setVisibleN((n) => n + PAGE);
        }}
      >
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 p-2">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-10 text-center">
            <InboxIcon className="size-7 text-gray-300" />
            <p className="text-[12px] text-gray-500">
              {q ? `No contacts match “${search.trim()}”` : emptyLabel}
            </p>
            {!q && emptyHint && (
              <p className="text-[11px] text-gray-400">{emptyHint}</p>
            )}
          </div>
        ) : (
          visible.map((c) => {
            const active = c.chat_id === activeChatId;
            return (
              <button
                key={c.chat_id}
                type="button"
                onClick={() => onSelect(c.chat_id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl p-2 text-left transition-colors',
                  active
                    ? 'bg-slate-100 ring-1 ring-slate-200'
                    : 'hover:bg-gray-50'
                )}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-600">
                  {initials(c.name, c.phone)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-semibold text-gray-900">
                      {c.name || c.phone || 'Unknown'}
                    </span>
                    {c.updated_at && (
                      <span className="shrink-0 text-[10px] text-gray-400">
                        {fmtRelative(new Date(c.updated_at).toISOString())}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {c.stage && (
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                          stageColor(c.stage)
                        )}
                      >
                        {c.stage}
                      </span>
                    )}
                    <span className="truncate text-[11px] text-gray-400">
                      {c.last_message || ''}
                    </span>
                  </div>
                  {(c.company || c.phone) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {c.company && (
                        <span className="inline-flex max-w-[9.5rem] items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                          <Building2 className="size-2.5 shrink-0 text-slate-400" />
                          <span className="truncate">{c.company}</span>
                        </span>
                      )}
                      {c.phone && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-600">
                          <Phone className="size-2.5 shrink-0 text-slate-400" />
                          {c.phone}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
