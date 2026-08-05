'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  fmtRelative,
  formatDuration,
  humanize,
  statusPill,
} from '@/components/outbound/chat-detail/helpers';
import {
  acquiredStage,
  eventStyle,
  eventTitle,
  type TimelineEvent,
} from './timeline';

// Full date incl. year — dropping the year is misleading when a deal spans years.
const fullDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const fullDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

// Short meta line under each touchpoint (outcome / duration / stage move / etc.).
const metaLine = (e: TimelineEvent): string => {
  const m = e.meta ?? {};
  const parts: string[] = [];
  if (e.type === 'acquired') {
    parts.push('Won');
    if (m.amount != null) parts.push(`$${Number(m.amount).toLocaleString()}`);
  } else if (e.channel === 'call') {
    if (m.outcome) parts.push(String(m.outcome));
    if (m.duration) parts.push(formatDuration(Number(m.duration)));
  } else if (e.channel === 'stage') {
    if (m.from || m.to) parts.push(`${m.from ?? '—'} → ${m.to ?? '—'}`);
  } else if (e.channel === 'email' || e.channel === 'sms') {
    if (m.subject) parts.push(String(m.subject));
    else if (m.text) parts.push(String(m.text));
  }
  return parts.filter(Boolean).join(' · ');
};

// Label for the win dot: it's the deal entering a won-type stage, so show it as a
// stage update ("Stage → Active"), not the ambiguous word "Acquired".
const railTitle = (e: TimelineEvent): string => {
  if (e.type === 'acquired') {
    const st = acquiredStage(e);
    return st ? `Stage → ${st}` : 'Won';
  }
  return eventTitle(e);
};

// Full key/value details for the selected touchpoint.
function detailRows(e: TimelineEvent): [string, string][] {
  const rows: [string, string][] = [];
  const push = (k: string, v: any) => {
    if (v == null || v === '') return;
    rows.push([k, typeof v === 'number' ? v.toLocaleString() : String(v)]);
  };
  push('When', fullDateTime(e.at));
  push('Channel', humanize(e.channel));
  if (e.direction)
    push('Direction', e.direction === 'in' ? 'Inbound' : 'Outbound');
  if (e.status) push('Status', e.status);
  const m = e.meta ?? {};
  if (e.type === 'acquired') push('HubSpot stage', acquiredStage(e));
  for (const [k, v] of Object.entries(m)) {
    if (k === 'duration') push('Duration', formatDuration(Number(v)));
    else if (k === 'amount')
      push('Amount', v == null ? null : `$${Number(v).toLocaleString()}`);
    else push(humanize(k), v);
  }
  return rows;
}

// Horizontal left→right attribution timeline. Every touchpoint is always shown as
// a coloured dot (colour + icon + label); click a dot for its full details.
export function DealTimelineRail({ events }: { events: TimelineEvent[] }) {
  const [selected, setSelected] = useState<number | null>(null);

  if (events.length === 0) {
    return (
      <p className="py-6 text-center text-[12px] text-slate-400">
        No touchpoints recorded for this deal.
      </p>
    );
  }

  const sel = selected != null ? events[selected] : null;

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <div
          className="relative flex items-stretch"
          style={{ minWidth: `${Math.max(events.length * 190, 320)}px` }}
        >
          <div className="pointer-events-none absolute inset-x-[95px] top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-slate-200" />

          {events.map((e, i) => {
            const { color, icon: Icon } = eventStyle(e.type);
            const above = i % 2 === 0;
            const isAcquired = e.type === 'acquired';
            const meta = metaLine(e);
            const title = railTitle(e);
            const isSel = selected === i;
            return (
              <button
                type="button"
                key={`${e.at}-${i}`}
                onClick={() => setSelected(isSel ? null : i)}
                className="relative flex w-[190px] shrink-0 cursor-pointer flex-col items-center justify-center focus:outline-none"
                style={{ minHeight: 300 }}
                title={`${fullDate(e.at)} — ${title}${meta ? ` · ${meta}` : ''}`}
              >
                <div
                  className={cn(
                    'absolute w-[178px] px-1 text-center',
                    above ? 'bottom-1/2 mb-8' : 'top-1/2 mt-8'
                  )}
                >
                  <p className="text-[11px] font-semibold leading-tight text-slate-700">
                    {fullDate(e.at)}
                  </p>
                  <p className="mt-0.5 line-clamp-3 break-words text-[11px] leading-snug text-slate-600">
                    {title}
                  </p>
                  {meta && (
                    <p className="mt-0.5 line-clamp-2 break-words text-[10px] leading-snug text-slate-400">
                      {meta}
                    </p>
                  )}
                  <p className="mt-0.5 text-[10px] leading-tight text-slate-400">
                    {fmtRelative(e.at)}
                  </p>
                </div>

                <span
                  className={cn(
                    'z-10 flex items-center justify-center rounded-full text-white transition-shadow',
                    isAcquired ? 'size-11' : 'size-9',
                    isSel
                      ? 'ring-4 ring-slate-300'
                      : 'ring-4 ring-white hover:ring-slate-100'
                  )}
                  style={{ backgroundColor: color }}
                >
                  <Icon className={isAcquired ? 'size-5' : 'size-4'} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail panel for the clicked touchpoint. */}
      {sel && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-[13px] font-semibold text-slate-800">
              {railTitle(sel)}
            </p>
            {sel.status && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  statusPill(sel.status)
                )}
              >
                {sel.status}
              </span>
            )}
            <span className="ml-auto text-[11px] text-slate-400">
              {fullDateTime(sel.at)}
            </span>
          </div>
          {/* Note bodies / long text live in the title — show in full here. */}
          {eventTitle(sel).length > 40 && (
            <p className="mb-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-600">
              {eventTitle(sel)}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {detailRows(sel).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[12px]">
                <dt className="shrink-0 font-medium text-slate-500">{k}:</dt>
                <dd className="min-w-0 break-words text-slate-700">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
