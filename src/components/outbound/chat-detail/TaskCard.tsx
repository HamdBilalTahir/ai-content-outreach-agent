'use client';

import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatTask } from './types';
import { fmtRelative, fmtTs, isEmpty } from './helpers';
import { FieldList } from './field-view';

export function TaskCard({
  task,
  expanded,
  onToggle,
}: {
  task: ChatTask;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-gray-50"
      >
        <span className="flex min-w-0 items-start gap-2">
          <ChevronDown
            className={cn(
              'mt-0.5 size-3.5 shrink-0 text-gray-400 transition-transform',
              expanded && 'rotate-180'
            )}
          />
          <span className="break-all font-mono text-[12px] font-medium text-gray-800">
            {task.type ?? '—'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            title={fmtTs(task.created_at ?? task.execute_at)}
            className="hidden text-[11px] tabular-nums text-gray-400 sm:inline"
          >
            {fmtRelative(task.created_at ?? task.execute_at)}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              task.permanent_failure
                ? 'bg-red-100 text-red-700'
                : task.executed
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700'
            )}
          >
            {task.permanent_failure
              ? 'failed'
              : task.executed
                ? 'done'
                : 'pending'}
          </span>
        </span>
      </button>
      {/* Collapsed preview: surface the 1-2 most important variables at a glance
          (what it does + when it runs) without needing to expand. */}
      {!expanded &&
        (task.instructions || (!task.executed && task.execute_at)) && (
          <div
            onClick={onToggle}
            className="-mt-1 cursor-pointer space-y-0.5 px-3.5 pb-2.5"
          >
            {task.instructions && (
              <p className="line-clamp-2 text-[12px] leading-relaxed text-gray-600">
                {task.instructions}
              </p>
            )}
            {!task.executed && task.execute_at && (
              <p
                title={fmtTs(task.execute_at)}
                className="text-[11px] text-gray-400"
              >
                Executes {fmtRelative(task.execute_at)}
              </p>
            )}
          </div>
        )}
      {expanded && (
        <div className="space-y-3 border-t border-gray-200 bg-white px-3.5 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Created
              </p>
              <p className="mt-0.5 text-[12px] tabular-nums text-gray-700">
                {fmtTs(task.created_at)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Executes
              </p>
              <p className="mt-0.5 text-[12px] tabular-nums text-gray-700">
                {fmtTs(task.execute_at)}
              </p>
            </div>
          </div>
          {task.instructions && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Instructions
              </p>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700">
                {task.instructions}
              </p>
            </div>
          )}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Input
            </p>
            <FieldList value={task.taskData} />
          </div>
          {/* The backend doesn't write an output on outbound tasks — the call/
              email result lands in Messages/Activities — so only show Output
              when it's actually present. */}
          {!isEmpty(task.output) && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Output
              </p>
              <FieldList value={task.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
