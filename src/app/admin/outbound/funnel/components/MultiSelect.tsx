'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MultiOption {
  value: string;
  label: string;
}

// Multi-select with search + "All"/"None" quick actions. Selection is the array
// of chosen values (empty = none). "All selected" is just every value checked —
// the parent decides what that means for its query. Styling/behavior mirror
// SearchableSelect (in-flow absolute dropdown, closes on outside click / Esc).
export function MultiSelect({
  selected,
  onChange,
  options,
  allLabel = 'All',
  noneLabel = 'None',
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No results.',
  disabled,
  triggerClassName,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  options: MultiOption[];
  allLabel?: string;
  noneLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = search
    ? options.filter((o) =>
        o.label.toLowerCase().includes(search.toLowerCase())
      )
    : options;

  // Summary shown on the trigger.
  const summary = useMemo(() => {
    if (options.length > 0 && selected.length === options.length)
      return allLabel;
    if (selected.length === 0) return noneLabel;
    if (selected.length === 1) {
      return (
        options.find((o) => o.value === selected[0])?.label ?? '1 selected'
      );
    }
    return `${selected.length} selected`;
  }, [selected, options, allLabel, noneLabel]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    if (selectedSet.has(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };

  const isNone = selected.length === 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setSearch('');
        }}
        className={cn(
          'flex h-10 w-full items-center justify-between rounded-xl border border-gray-200 bg-white px-3.5 text-left text-[13px] text-gray-800 transition-colors hover:border-gray-300 focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10 disabled:cursor-not-allowed disabled:opacity-50',
          triggerClassName
        )}
      >
        <span className={cn('truncate', isNone && 'text-gray-400')}>
          {options.length === 0 ? placeholder : summary}
        </span>
        <ChevronsUpDown className="ml-2 size-4 shrink-0 text-gray-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-max min-w-full max-w-[340px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-gray-100 p-2">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-[12px] text-gray-800 placeholder-gray-400 focus:border-slate-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onChange(options.map((o) => o.value))}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              All
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              None
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-gray-400">{emptyText}</p>
            ) : (
              filtered.map((o) => {
                const on = selectedSet.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-gray-50',
                      on ? 'font-medium text-slate-900' : 'text-gray-800'
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border',
                        on
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-gray-300 bg-white'
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
