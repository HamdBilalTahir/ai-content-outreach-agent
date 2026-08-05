'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldBan, X, ChevronDown, Check } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { inputCls } from '../../shared';

interface AreaCodeRow {
  area_code: string;
  status?: string;
  is_expired?: boolean;
  is_active?: boolean;
}

// A code is selectable only while the SAN covering it is active and unexpired.
// The DNC GET returns `status` + `is_expired` today (no `is_active`), so derive.
function isActive(row: AreaCodeRow): boolean {
  return row.is_active ?? (row.status === 'active' && !row.is_expired);
}

export default function AreaCodeSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/outbound/dnc/area-codes', {
          cache: 'no-store',
        });
        const data = await res.json();
        if (!res.ok || data?.success === false)
          throw new Error(data?.error || 'Failed to load area codes');
        const active = (
          Array.isArray(data.area_codes)
            ? (data.area_codes as AreaCodeRow[])
            : []
        )
          .filter(isActive)
          .map((r) => r.area_code)
          .sort();
        if (!cancelled) setCodes(active);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load area codes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(
    () => (search ? codes.filter((c) => c.includes(search.trim())) : codes),
    [codes, search]
  );

  const toggle = (code: string) => {
    if (selected.has(code)) onChange(value.filter((c) => c !== code));
    else onChange([...value, code].sort());
  };
  const selectAll = () => onChange([...codes]);
  const clear = () => onChange([]);

  // In-list "Select all" toggle — operates on the currently visible (filtered)
  // codes, so it also works as "select all matching" while searching.
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c));
  const toggleAllFiltered = () => {
    if (allFilteredSelected)
      onChange(value.filter((c) => !filtered.includes(c)));
    else onChange(Array.from(new Set([...value, ...filtered])).sort());
  };

  return (
    <div className="space-y-1.5">
      <label className="block text-[13px] font-medium text-gray-700">
        Area codes{' '}
        <span className="font-normal text-gray-400">(DNC-authorized)</span>
      </label>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              inputCls,
              'flex min-h-[42px] items-center justify-between gap-2 text-left'
            )}
          >
            <span className="flex flex-1 flex-wrap items-center gap-1">
              {value.length === 0 ? (
                <span className="text-gray-400">
                  All area codes (no restriction)
                </span>
              ) : (
                value.map((code) => (
                  <span
                    key={code}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-700"
                  >
                    {code}
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(code);
                      }}
                      className="rounded text-slate-400 hover:text-slate-700"
                      aria-label={`Remove ${code}`}
                    >
                      <X className="size-3" />
                    </span>
                  </span>
                ))
              )}
            </span>
            <ChevronDown className="size-4 shrink-0 text-gray-400" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[280px] p-0">
          <div className="border-b border-gray-100 p-2">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search codes…"
              className={inputCls + ' h-8 py-0'}
              inputMode="numeric"
            />
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <button
                type="button"
                onClick={selectAll}
                disabled={loading || codes.length === 0}
                className="font-medium text-slate-700 hover:text-slate-900 disabled:opacity-40"
              >
                Select all active
              </button>
              <button
                type="button"
                onClick={clear}
                disabled={value.length === 0}
                className="font-medium text-gray-400 hover:text-red-500 disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="max-h-[220px] overflow-y-auto p-1">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-gray-400">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            ) : error ? (
              <div className="px-2 py-3 text-[12px] text-amber-600">
                {error}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-2 py-6 text-center text-[12px] text-gray-400">
                <ShieldBan className="size-5 text-gray-300" />
                {codes.length === 0
                  ? 'No active area codes registered'
                  : 'No matches'}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleAllFiltered}
                  className="mb-1 flex w-full items-center justify-between rounded-md border-b border-gray-100 px-2 py-1.5 text-left text-[12px] hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-700">
                    {search ? `Select all matching` : 'Select all'}
                  </span>
                  {allFilteredSelected && (
                    <Check className="size-3.5 text-slate-700" />
                  )}
                </button>
                {filtered.map((code) => {
                  const on = selected.has(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => toggle(code)}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-gray-50"
                    >
                      <span className="font-mono text-gray-800">{code}</span>
                      {on && <Check className="size-3.5 text-slate-700" />}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <p className="text-[11px] leading-relaxed text-gray-400">
        Only records whose phone area code is selected will enroll. Leave empty
        for no restriction — email-only records always enroll.
      </p>
    </div>
  );
}
