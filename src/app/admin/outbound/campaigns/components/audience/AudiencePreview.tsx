'use client';

import { useMemo, useState } from 'react';
import { Loader2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Flatten a record into leaf key/value rows ───────────────────────────────
export function flattenRecord(
  obj: any,
  out = new Map<string, string>()
): Map<string, string> {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (!out.has(k))
        out.set(
          k,
          v
            .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
            .join(', ')
        );
    } else if (typeof v === 'object') {
      flattenRecord(v, out);
    } else if (!out.has(k)) {
      out.set(k, String(v));
    }
  }
  return out;
}

export function recordTitle(m: any, i: number): string {
  const ci = m?.contact_information ?? m ?? {};
  return (
    ci.email ||
    ci.phone_number ||
    [ci.first_name, ci.last_name].filter(Boolean).join(' ') ||
    `Record ${i + 1}`
  );
}

// Stable UI key for a member; also the HubSpot contact id when present (which is
// what we send in include_contact_ids).
export function contactId(m: any, i: number): string {
  return String(m?.id ?? m?.contact_information?.email ?? `idx-${i}`);
}

// ── Collapsible preview card ────────────────────────────────────────────────
function RecordCard({
  member,
  index,
  filteredProps,
  selected,
  onToggleSelected,
}: {
  member: any;
  index: number;
  filteredProps: Set<string>;
  selected: boolean;
  onToggleSelected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const raw =
    member?.properties &&
    typeof member.properties === 'object' &&
    Object.keys(member.properties).length
      ? member.properties
      : member;
  const rows = Array.from(flattenRecord(raw).entries());

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-white',
        selected ? 'border-slate-300 bg-slate-50/40' : 'border-gray-100'
      )}
    >
      <div className="flex items-center gap-2 p-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          onClick={(e) => e.stopPropagation()}
          className="size-4 shrink-0 accent-slate-900"
          aria-label={
            selected ? 'Deselect this contact' : 'Select this contact'
          }
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-gray-400 transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="flex-1 truncate text-[12px] font-semibold text-gray-900">
            {recordTitle(member, index)}
          </span>
          <span className="shrink-0 text-[11px] text-gray-400">
            {rows.length} field{rows.length === 1 ? '' : 's'}
          </span>
        </button>
      </div>
      {open && (
        <div className="space-y-0.5 px-3 pb-3">
          {rows.map(([key, value]) => {
            const filtered = filteredProps.has(key);
            return (
              <div
                key={key}
                className={cn(
                  'flex gap-2 rounded px-1 text-[11px]',
                  filtered && 'bg-[#800000]/10'
                )}
              >
                <span
                  className={cn(
                    'w-1/3 shrink-0 truncate',
                    filtered ? 'font-semibold text-[#800000]' : 'text-gray-400'
                  )}
                >
                  {key}
                </span>
                <span
                  className={cn(
                    'flex-1 truncate',
                    filtered ? 'font-medium text-[#800000]' : 'text-gray-700'
                  )}
                >
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Group the flat members list by their annotated `area_code`, preserving each
// member's flat index (so selection ids stay aligned with the parent). Numeric
// codes ascending; the email-only ("") group sorts last.
function groupByAreaCode(
  members: any[]
): [string, { member: any; index: number }[]][] {
  const map = new Map<string, { member: any; index: number }[]>();
  members.forEach((member, index) => {
    const ac = typeof member?.area_code === 'string' ? member.area_code : '';
    if (!map.has(ac)) map.set(ac, []);
    map.get(ac)!.push({ member, index });
  });
  return Array.from(map.entries()).sort((a, b) => {
    if (a[0] === '') return 1;
    if (b[0] === '') return -1;
    return a[0].localeCompare(b[0]);
  });
}

export default function AudiencePreview({
  members,
  total,
  nextCursor,
  loadingMore,
  selectedIds,
  filteredProps,
  subtitle,
  selectingN,
  onToggleSelected,
  onSelectAll,
  onUnselectAll,
  onSelectFirstN,
  onLoadMore,
}: {
  members: any[];
  total: number | null;
  nextCursor: string | null;
  loadingMore: boolean;
  selectedIds: Set<string>;
  filteredProps?: Set<string>;
  subtitle?: string;
  selectingN: boolean;
  onToggleSelected: (id: string) => void;
  onSelectAll: () => void;
  onUnselectAll: () => void;
  onSelectFirstN: (n: number) => void;
  onLoadMore: () => void;
}) {
  const emptyFilteredProps = useMemo(() => new Set<string>(), []);
  const props = filteredProps ?? emptyFilteredProps;

  const [countInput, setCountInput] = useState('');
  const parsedN = countInput ? parseInt(countInput, 10) : 0;
  const submitFirstN = () => {
    if (parsedN > 0 && !selectingN) onSelectFirstN(parsedN);
  };

  const hasAreaData = members.some((m) => m?.area_code);
  const groups = useMemo(() => groupByAreaCode(members), [members]);

  const denom = total ?? members.length;
  const allLoadedSelected =
    members.length > 0 &&
    members.every((m, i) => selectedIds.has(contactId(m, i)));

  const renderCard = (member: any, index: number) => {
    const id = contactId(member, index);
    return (
      <RecordCard
        key={id + ':' + index}
        member={member}
        index={index}
        filteredProps={props}
        selected={selectedIds.has(id)}
        onToggleSelected={() => onToggleSelected(id)}
      />
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-gray-400">
          Showing {members.length.toLocaleString()}
          {total != null ? ` of ${total.toLocaleString()}` : ''} record
          {members.length === 1 ? '' : 's'}
          {subtitle ? ` · ${subtitle}` : ''}
        </p>
        {members.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px]">
            <span
              className={cn(
                'font-medium',
                selectedIds.size > 0 ? 'text-slate-900' : 'text-gray-400'
              )}
            >
              {selectedIds.size.toLocaleString()} of {denom.toLocaleString()}{' '}
              selected
            </span>
            <span className="text-gray-300">·</span>
            <div className="flex items-center gap-1">
              <span className="text-gray-400">Select first</span>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={countInput}
                onChange={(e) =>
                  setCountInput(e.target.value.replace(/[^0-9]/g, ''))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitFirstN();
                }}
                placeholder={String(Math.min(50, denom))}
                aria-label="Number of records to select"
                className="w-14 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-900 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
              />
              <button
                type="button"
                onClick={submitFirstN}
                disabled={parsedN <= 0 || selectingN}
                className="flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900 disabled:opacity-40"
              >
                {selectingN ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                Select
              </button>
            </div>
            <span className="text-gray-300">·</span>
            <button
              type="button"
              onClick={onSelectAll}
              disabled={allLoadedSelected || selectingN}
              className="font-medium text-slate-700 hover:text-slate-900 disabled:opacity-40"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={onUnselectAll}
              disabled={selectedIds.size === 0 || selectingN}
              className="font-medium text-gray-400 hover:text-red-500 disabled:opacity-40"
            >
              Unselect all
            </button>
          </div>
        )}
      </div>

      {members.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-5 text-center text-[12px] text-gray-400">
          No matching records.
        </div>
      ) : (
        <div className="max-h-[480px] space-y-2 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50/50 p-2">
          {hasAreaData
            ? groups.map(([code, items]) => (
                <div key={code || '__none'} className="space-y-2">
                  <div className="flex items-center gap-2 px-1 pt-1">
                    <span className="text-[11px] font-semibold text-gray-600">
                      {code ? `Area code ${code}` : 'Email-only · no phone'}
                    </span>
                    <span className="text-[11px] text-gray-400">
                      {items.length.toLocaleString()}
                    </span>
                  </div>
                  {items.map(({ member, index }) => renderCard(member, index))}
                </div>
              ))
            : members.map((m, i) => renderCard(m, i))}

          {nextCursor && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore || selectingN}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white py-2 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
