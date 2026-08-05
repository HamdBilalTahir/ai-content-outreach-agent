'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  Plus,
  X,
  Eye,
  Save,
  Trash2,
} from 'lucide-react';
import {
  AudienceOnChange,
  FilterGroup,
  HubspotProperty,
  SearchFilter,
  inputCls,
} from '../../shared';
import { SearchableSelect } from '../SearchableSelect';
import { cn } from '@/lib/utils';
import AudiencePreview, { contactId } from './AudiencePreview';
import {
  compileFilterGroups,
  hasAnyFilter,
  IN_OPERATORS,
  VALUELESS_OPERATORS,
} from './compile-filters';
import {
  getSavedFilters,
  saveFilter,
  updateSavedFilter,
  deleteFilter,
  SavedFilter,
} from './saved-filters';

// HubSpot search operators (common subset). EQ works for text + enum.
const OPERATORS: { value: string; label: string }[] = [
  { value: 'EQ', label: 'is' },
  { value: 'NEQ', label: 'is not' },
  { value: 'is in', label: 'is in' },
  { value: 'is not in', label: 'is not in' },
  { value: 'CONTAINS_TOKEN', label: 'contains' },
  { value: 'HAS_PROPERTY', label: 'is known' },
  { value: 'NOT_HAS_PROPERTY', label: 'is unknown' },
  { value: 'GT', label: 'greater than' },
  { value: 'LT', label: 'less than' },
];

const PAGE_SIZE = 50;

const blankRow = (): SearchFilter => ({
  property: '',
  operator: 'EQ',
  values: [],
  match: 'any',
});
const blankGroup = (): FilterGroup => ({ match: 'all', filters: [blankRow()] });

// ── Small AND/OR segmented toggle ───────────────────────────────────────────
function AndOrToggle({
  value,
  onChange,
}: {
  value: 'any' | 'all';
  onChange: (v: 'any' | 'all') => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-[11px]">
      {(
        [
          ['all', 'AND'],
          ['any', 'OR'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'rounded-md px-2 py-0.5 font-medium transition-colors',
            value === v
              ? 'bg-slate-900 text-white'
              : 'text-gray-500 hover:text-gray-700'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Multi-value input: chips + adder ────────────────────────────────────────
function ValuesInput({
  values,
  onChange,
  options,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  options: { value: string; label: string }[];
}) {
  const [draft, setDraft] = useState('');
  const isEnum = options.length > 0;
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft('');
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));
  const labelFor = (v: string) =>
    options.find((o) => o.value === v)?.label ?? v;
  const remaining = options.filter((o) => !values.includes(o.value));

  return (
    <div className="space-y-1.5">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-[11px] text-slate-700"
            >
              {labelFor(v)}
              <button
                type="button"
                onClick={() => remove(v)}
                className="rounded text-slate-400 hover:text-slate-700"
                aria-label={`Remove ${labelFor(v)}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {isEnum ? (
        remaining.length > 0 && (
          <SearchableSelect
            value=""
            onChange={add}
            options={remaining}
            placeholder="Add value…"
            searchPlaceholder="Search values…"
            emptyText="No values."
            triggerClassName="h-9 rounded-lg text-[12px]"
          />
        )
      ) : (
        <input
          className={inputCls + ' h-9 py-0'}
          placeholder="Type a value — Enter or comma"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      )}
    </div>
  );
}

export default function HubspotSearchTab({
  agentId,
  onChange,
  excludeContacted,
  areaCodes,
  campaignId,
}: {
  agentId: string;
  onChange: AudienceOnChange;
  excludeContacted: boolean;
  areaCodes: string[];
  // When adding records to an existing campaign, exclude contacts already enrolled in
  // it (backend uses campaign_id) so the preview matches what will actually enroll.
  campaignId?: string;
}) {
  const [properties, setProperties] = useState<HubspotProperty[]>([]);
  const [loadingProps, setLoadingProps] = useState(false);
  const [propError, setPropError] = useState<string | null>(null);

  const [groups, setGroups] = useState<FilterGroup[]>([blankGroup()]);
  const [groupMatch, setGroupMatch] = useState<'any' | 'all'>('all');

  // Saved filters (localStorage) — load in an effect to avoid SSR mismatch.
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [loadedId, setLoadedId] = useState<string>('');
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState('');
  useEffect(() => setSaved(getSavedFilters()), []);

  const [members, setMembers] = useState<any[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  // Bumped on each successful preview to scroll the results into view.
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  // Opt-in: only hand-picked contacts enroll (sent as include_contact_ids).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // "Select first N" loads pages as needed, so track its in-flight state.
  const [selectingN, setSelectingN] = useState(false);
  useEffect(() => {
    if (previewNonce > 0)
      previewRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
  }, [previewNonce]);

  // Load contact properties for the filter dropdowns.
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoadingProps(true);
    setPropError(null);
    (async () => {
      try {
        const res = await fetch('/api/outbound/hubspot/contact-properties', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId }),
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(data?.error || `Request failed (${res.status})`);
        if (!cancelled) setProperties(data?.properties ?? []);
      } catch (e: any) {
        if (!cancelled) setPropError(e?.message || 'Could not load properties');
      } finally {
        if (!cancelled) setLoadingProps(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Compile the builder → HubSpot-ready filterGroups (OR of AND-groups).
  const { filterGroups, error: compileError } = compileFilterGroups(
    groups,
    groupMatch
  );

  const conditionCount = groups.reduce(
    (n, g) =>
      n +
      g.filters.filter(
        (f) =>
          f.property && (VALUELESS_OPERATORS.has(f.operator) || f.values.length)
      ).length,
    0
  );
  const searchLabel = conditionCount
    ? `Search · ${conditionCount} condition${conditionCount === 1 ? '' : 's'}`
    : 'Search · all contacts';

  // Property names being filtered on — tagged maroon in each preview card.
  const filteredProps = new Set(
    groups
      .flatMap((g) => g.filters)
      .filter(
        (f) =>
          f.property && (VALUELESS_OPERATORS.has(f.operator) || f.values.length)
      )
      .map((f) => f.property)
  );

  // Any change to the builder invalidates a prior preview — re-preview to fire.
  useEffect(() => {
    setMembers([]);
    setTotal(null);
    setNextCursor(null);
    setPreviewError(null);
    setPreviewed(false);
    setSelectedIds(new Set());
    onChange(null, null);
    // The source disables `react-hooks/exhaustive-deps` here — a deliberate dependency omission, so the
    // effect fires only on the state change it names. This repo's eslint config does not include the
    // react-hooks plugin, so the directive itself errored as an unknown rule; kept as a plain comment so
    // the intent survives if the plugin is ever added.
  }, [
    JSON.stringify(filterGroups),
    agentId,
    excludeContacted,
    areaCodes.join(','),
    campaignId,
  ]);

  const fetchPage = async (cursor?: string) => {
    const res = await fetch('/api/outbound/hubspot/search-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        filterGroups,
        limit: PAGE_SIZE,
        all_properties: true,
        exclude_contacted: excludeContacted,
        ...(campaignId ? { campaign_id: campaignId } : {}),
        ...(areaCodes.length ? { area_codes: areaCodes } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(data?.error || `Request failed (${res.status})`);
    return data as {
      members?: any[];
      total?: number;
      next_cursor?: string | null;
    };
  };

  // Report the opt-in audience: only the hand-picked contacts enroll, sent as
  // `include_contact_ids` (HubSpot contact ids). filterGroups rides along as the
  // picker but is ignored by the backend when the id list is present. Nothing
  // selected → no audience (fire stays disabled).
  const reportAudience = (selected: Set<string>, list: any[]) => {
    const ids = list
      .filter((m, i) => selected.has(contactId(m, i)))
      .map((m) => m?.id)
      .filter(Boolean)
      .map(String);
    if (ids.length === 0) {
      onChange(null, 0, searchLabel);
      return;
    }
    onChange(
      { type: 'hubspot_search', filterGroups, include_contact_ids: ids },
      ids.length,
      searchLabel
    );
  };

  const preview = async () => {
    if (compileError) {
      setPreviewError(compileError);
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    try {
      const data = await fetchPage();
      const m = Array.isArray(data.members) ? data.members : [];
      const cursor = data.next_cursor ?? null;
      setMembers(m);
      setTotal(typeof data.total === 'number' ? data.total : null);
      setNextCursor(cursor);
      setSelectedIds(new Set());
      setPreviewed(true);
      setPreviewNonce((n) => n + 1);
      // Default: nothing selected → no audience yet.
      onChange(null, 0, searchLabel);
    } catch (e: any) {
      setPreviewError(e?.message || 'Preview failed');
      onChange(null, null);
    } finally {
      setPreviewing(false);
    }
  };

  const toggleSelected = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    reportAudience(next, members);
  };
  const selectAll = () => {
    const next = new Set(members.map((m, i) => contactId(m, i)));
    setSelectedIds(next);
    reportAudience(next, members);
  };
  const unselectAll = () => {
    setSelectedIds(new Set());
    reportAudience(new Set(), members);
  };
  // Select the first N records, loading additional pages as needed to reach N.
  const selectFirstN = async (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return;
    setSelectingN(true);
    setPreviewError(null);
    try {
      let list = members;
      let cursor = nextCursor;
      while (list.length < n && cursor) {
        const data = await fetchPage(cursor);
        const m = Array.isArray(data.members) ? data.members : [];
        list = [...list, ...m];
        cursor = data.next_cursor ?? null;
      }
      const take = Math.min(n, list.length);
      const next = new Set(list.slice(0, take).map((m, i) => contactId(m, i)));
      setMembers(list);
      setNextCursor(cursor);
      setSelectedIds(next);
      reportAudience(next, list);
    } catch (e: any) {
      setPreviewError(e?.message || 'Could not select records');
    } finally {
      setSelectingN(false);
    }
  };
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setPreviewError(null);
    try {
      const data = await fetchPage(nextCursor);
      const m = Array.isArray(data.members) ? data.members : [];
      const merged = [...members, ...m];
      setMembers(merged);
      setNextCursor(data.next_cursor ?? null);
      reportAudience(selectedIds, merged);
    } catch (e: any) {
      setPreviewError(e?.message || 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Builder mutations ──
  const updateFilter = (gi: number, fi: number, patch: Partial<SearchFilter>) =>
    setGroups((prev) =>
      prev.map((g, i) =>
        i === gi
          ? {
              ...g,
              filters: g.filters.map((f, j) =>
                j === fi ? { ...f, ...patch } : f
              ),
            }
          : g
      )
    );
  const addFilter = (gi: number) =>
    setGroups((prev) =>
      prev.map((g, i) =>
        i === gi ? { ...g, filters: [...g.filters, blankRow()] } : g
      )
    );
  const removeFilter = (gi: number, fi: number) =>
    setGroups((prev) => {
      const next = prev.map((g, i) =>
        i === gi ? { ...g, filters: g.filters.filter((_, j) => j !== fi) } : g
      );
      const cleaned = next.filter((g) => g.filters.length > 0);
      return cleaned.length ? cleaned : [blankGroup()];
    });
  const setGroupInternalMatch = (gi: number, m: 'any' | 'all') =>
    setGroups((prev) =>
      prev.map((g, i) => (i === gi ? { ...g, match: m } : g))
    );
  const addGroup = () => setGroups((prev) => [...prev, blankGroup()]);
  const removeGroup = (gi: number) =>
    setGroups((prev) => {
      const next = prev.filter((_, i) => i !== gi);
      return next.length ? next : [blankGroup()];
    });

  // ── Saved filters ──
  const loadSaved = (id: string) => {
    const sf = saved.find((f) => f.id === id);
    if (!sf) return;
    setGroups(JSON.parse(JSON.stringify(sf.groups)));
    setGroupMatch(sf.groupMatch);
    setLoadedId(id);
  };
  const doSave = () => {
    const name = saveName.trim();
    if (!name) return;
    const { list, saved: item } = saveFilter(name, groups, groupMatch);
    setSaved(list);
    setLoadedId(item.id);
    setShowSave(false);
    setSaveName('');
  };
  // Overwrite the currently-loaded saved filter in place (supports rename).
  const doUpdate = () => {
    const name = saveName.trim();
    if (!name || !loadedId) return;
    const { list } = updateSavedFilter(loadedId, name, groups, groupMatch);
    setSaved(list);
    setShowSave(false);
    setSaveName('');
  };
  const loadedName = saved.find((f) => f.id === loadedId)?.name ?? '';
  const openSave = () => {
    setShowSave((s) => {
      const next = !s;
      // Prefill the loaded filter's name when opening, so Update can rename it.
      setSaveName(next && loadedId ? loadedName : '');
      return next;
    });
  };
  const doDelete = () => {
    if (!loadedId) return;
    setSaved(deleteFilter(loadedId));
    setLoadedId('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-gray-700">Contact filters</p>
        <div className="flex items-center gap-1.5">
          {saved.length > 0 && (
            <div className="w-[200px]">
              <SearchableSelect
                value={loadedId}
                onChange={loadSaved}
                options={saved.map((f) => ({ value: f.id, label: f.name }))}
                placeholder="Saved filters…"
                searchPlaceholder="Search saved…"
                emptyText="None saved."
                triggerClassName="h-8 rounded-lg text-[12px]"
              />
            </div>
          )}
          {loadedId && (
            <button
              type="button"
              onClick={doDelete}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-red-500"
              aria-label="Delete saved filter"
            >
              <Trash2 className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={openSave}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
          >
            <Save className="size-3.5" /> {loadedId ? 'Edit' : 'Save'}
          </button>
        </div>
      </div>

      {showSave && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            className={inputCls + ' h-8 flex-1 py-0'}
            placeholder="Name this filter…"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (loadedId) doUpdate();
                else doSave();
              }
            }}
          />
          {loadedId && (
            <button
              type="button"
              onClick={doUpdate}
              disabled={!saveName.trim()}
              className="inline-flex h-8 items-center rounded-lg bg-slate-900 px-3 text-[12px] font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
            >
              Update
            </button>
          )}
          <button
            type="button"
            onClick={doSave}
            disabled={!saveName.trim()}
            className="inline-flex h-8 items-center rounded-lg border border-gray-200 bg-white px-3 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {loadedId ? 'Save as new' : 'Save filter'}
          </button>
        </div>
      )}

      {loadingProps ? (
        <div className="flex items-center gap-2 text-[13px] text-gray-400">
          <Loader2 className="size-4 animate-spin" /> Loading properties…
        </div>
      ) : propError ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="text-[12px] leading-relaxed text-amber-700">
            {propError}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((g, gi) => (
            <div key={gi}>
              {gi > 0 && (
                <div className="flex items-center justify-center py-1.5">
                  <AndOrToggle value={groupMatch} onChange={setGroupMatch} />
                </div>
              )}
              <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50/60 p-2.5">
                {g.filters.map((f, fi) => {
                  const prop = properties.find((p) => p.name === f.property);
                  const valueOptions = (prop?.options ?? []).map((o) => ({
                    value: o.value,
                    label: o.label,
                  }));
                  const valueless = VALUELESS_OPERATORS.has(f.operator);
                  return (
                    <div
                      key={fi}
                      className="space-y-2 rounded-lg border border-gray-100 bg-white p-2"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <SearchableSelect
                            value={f.property}
                            onChange={(v) =>
                              updateFilter(gi, fi, { property: v, values: [] })
                            }
                            options={properties.map((p) => ({
                              value: p.name,
                              label: p.label || p.name,
                            }))}
                            placeholder="Property"
                            searchPlaceholder="Search properties…"
                            emptyText="No properties."
                            triggerClassName="h-9 rounded-lg text-[12px]"
                          />
                        </div>
                        <div className="w-[130px]">
                          <SearchableSelect
                            value={f.operator}
                            onChange={(v) =>
                              updateFilter(gi, fi, { operator: v })
                            }
                            options={OPERATORS}
                            searchPlaceholder="Search…"
                            triggerClassName="h-9 rounded-lg text-[12px]"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFilter(gi, fi)}
                          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                          aria-label="Remove filter"
                        >
                          <X className="size-4" />
                        </button>
                      </div>

                      {!valueless && (
                        <div className="space-y-2">
                          <ValuesInput
                            values={f.values}
                            onChange={(values) =>
                              updateFilter(gi, fi, { values })
                            }
                            options={valueOptions}
                          />
                          {f.values.length > 1 &&
                            !IN_OPERATORS.has(f.operator) && (
                              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                <span>Match</span>
                                <AndOrToggle
                                  value={f.match}
                                  onChange={(m) =>
                                    updateFilter(gi, fi, { match: m })
                                  }
                                />
                                <span className="text-gray-400">
                                  {f.match === 'any'
                                    ? 'any value (OR)'
                                    : 'all values (AND)'}
                                </span>
                              </div>
                            )}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => addFilter(gi)}
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-700 transition-colors hover:text-slate-900"
                  >
                    <Plus className="size-3.5" /> Add filter
                  </button>
                  <div className="flex items-center gap-2">
                    {g.filters.length > 1 && (
                      <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                        <span>Rows</span>
                        <AndOrToggle
                          value={g.match}
                          onChange={(m) => setGroupInternalMatch(gi, m)}
                        />
                      </div>
                    )}
                    {groups.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeGroup(gi)}
                        className="text-[11px] font-medium text-gray-400 transition-colors hover:text-red-500"
                      >
                        Remove group
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addGroup}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-700 transition-colors hover:text-slate-900"
          >
            <Plus className="size-3.5" /> Add group
          </button>
        </div>
      )}

      {compileError && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="text-[12px] leading-relaxed text-amber-700">
            {compileError}
          </p>
        </div>
      )}

      {/* Preview records */}
      <div
        ref={previewRef}
        className="flex items-center justify-between pt-1 scroll-mt-2"
      >
        <button
          type="button"
          onClick={preview}
          disabled={!agentId || previewing || !!compileError}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {previewing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Eye className="size-3.5" />
          )}
          Preview records
        </button>
        {previewed && total != null && (
          <span className="text-[12px] text-gray-500">
            <span className="font-semibold text-gray-900">
              {total.toLocaleString()}
            </span>{' '}
            match{total === 1 ? '' : 'es'}
            {areaCodes.length > 0 && (
              <span className="text-gray-400"> · before area-code filter</span>
            )}
            {excludeContacted && (
              <span className="text-gray-400"> · already-contacted hidden</span>
            )}
          </span>
        )}
      </div>

      {previewError && (
        <p className="text-[12px] text-red-500">{previewError}</p>
      )}

      {previewed && !previewError && (
        <AudiencePreview
          members={members}
          total={areaCodes.length > 0 ? null : total}
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          selectedIds={selectedIds}
          filteredProps={filteredProps}
          subtitle={!hasAnyFilter(groups) ? 'all contacts' : undefined}
          onToggleSelected={toggleSelected}
          onSelectAll={selectAll}
          onUnselectAll={unselectAll}
          onSelectFirstN={selectFirstN}
          selectingN={selectingN}
          onLoadMore={loadMore}
        />
      )}
    </div>
  );
}
