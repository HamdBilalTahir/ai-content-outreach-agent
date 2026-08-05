'use client';

import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fmtRelative,
  formatLeaf,
  humanize,
  isPlainObject,
  statusPill,
} from './helpers';
import { FieldList } from './field-view';

// Readable activity row: tool name + status + message, raw JSON behind a toggle.
export function ActivityCard({
  activity,
  expanded,
  onToggle,
}: {
  activity: Record<string, any>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tc = activity.toolCall ?? activity.tool_call ?? {};
  const toolName =
    tc.toolName ?? tc.tool_name ?? activity.kind ?? activity.type ?? 'Activity';
  const status = tc.result?.status ?? tc.status ?? activity.status ?? null;
  const message = tc.result?.message ?? activity.message ?? null;
  const ts = activity.timestamp || activity.created_at || activity.createdAt;
  // `id` is destructured to EXCLUDE it from `rest`, which is rendered as a field list below — dropping
  // it would print the document id as a field. This repo's rule config does not enable
  // `ignoreRestSiblings`, so the omit-by-destructure idiom has to be spelled out for the linter.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, ...rest } = activity;

  // Collapsed preview: surface the 1-2 most important variables inline so key
  // values are visible without expanding. Pull scalar fields from the tool call's
  // args + result, drop the noise already shown elsewhere (status/message), and
  // rank meaningful keys first.
  const argsObj = tc.args ?? tc.arguments ?? tc.input ?? tc.parameters;
  const resultObj =
    tc.result && isPlainObject(tc.result) ? tc.result : undefined;
  const previewSource = {
    ...(isPlainObject(argsObj) ? argsObj : {}),
    ...(resultObj ?? {}),
  };
  const PREVIEW_SKIP = new Set([
    'status',
    'message',
    'ok',
    'success',
    'error',
    'result',
    'output',
  ]);
  const PREVIEW_PRIORITY = [
    'phone_number',
    'phone',
    'to',
    'email',
    'customer_email',
    'subject',
    'stage',
    'from_stage',
    'to_stage',
    'new_stage',
    'name',
    'task_type',
    'type',
    'execute_at',
    'scheduled_for',
    'contact_id',
    'deal_id',
    'call_id',
    'amount',
    'duration',
  ];
  const previewFields = Object.entries(previewSource)
    .filter(
      ([k, v]) =>
        !PREVIEW_SKIP.has(k.toLowerCase()) &&
        (typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean') &&
        String(v).trim() !== ''
    )
    .sort((a, b) => {
      const ia = PREVIEW_PRIORITY.indexOf(a[0].toLowerCase());
      const ib = PREVIEW_PRIORITY.indexOf(b[0].toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .slice(0, 2);
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/60">
      {/* Header (name + status + message) — click anywhere to expand/collapse */}
      <div
        onClick={onToggle}
        className="cursor-pointer transition-colors hover:bg-gray-50"
      >
        <div className="flex items-start justify-between gap-2 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all font-mono text-[12px] font-medium text-gray-800">
              {toolName}
            </span>
            {status && (
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                  statusPill(status)
                )}
              >
                {status}
              </span>
            )}
          </div>
          <span
            title={ts ? new Date(ts).toLocaleString() : ''}
            className="shrink-0 text-[10px] tabular-nums text-gray-400"
          >
            {fmtRelative(ts)}
          </span>
        </div>
        {message && (
          <p className="px-3.5 pb-2 text-[12px] leading-relaxed text-gray-600">
            {message}
          </p>
        )}
        {!expanded && previewFields.length > 0 && (
          <div className="space-y-0.5 px-3.5 pb-2.5">
            {previewFields.map(([k, v]) => (
              <p key={k} className="truncate text-[11px] leading-relaxed">
                <span className="text-gray-400">{humanize(k)}: </span>
                <span className="text-gray-600">{formatLeaf(v)}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 border-t border-gray-200 px-3.5 py-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-50"
      >
        <ChevronDown
          className={cn(
            'size-3 transition-transform',
            expanded && 'rotate-180'
          )}
        />
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && (
        <div className="border-t border-gray-200 bg-white p-2.5">
          <FieldList value={rest} />
        </div>
      )}
    </div>
  );
}
