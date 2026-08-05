'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle, Eye } from 'lucide-react';
import { AudienceOnChange, HubspotList } from '../../shared';
import { SearchableSelect } from '../SearchableSelect';
import AudiencePreview, { contactId } from './AudiencePreview';

const PAGE_SIZE = 50;

export default function HubspotListTab({
  agentId,
  onChange,
  areaCodes,
}: {
  agentId: string;
  onChange: AudienceOnChange;
  areaCodes: string[];
}) {
  const [lists, setLists] = useState<HubspotList[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');

  const [members, setMembers] = useState<any[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  // Opt-in: only hand-picked contacts enroll (sent as include_contact_ids).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // "Select first N" loads pages as needed, so track its in-flight state.
  const [selectingN, setSelectingN] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch('/api/outbound/hubspot/lists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId }),
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(data?.error || `Request failed (${res.status})`);
        if (!cancelled) setLists(data?.lists ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not load HubSpot lists');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const selectedList = lists.find((l) => l.id === selected);
  const sourceLabel = selectedList
    ? `HubSpot list · ${selectedList.name}`
    : 'HubSpot list';

  // Report the opt-in audience: only the hand-picked contacts enroll, sent as
  // `include_contact_ids` (HubSpot contact ids). list_id rides along as the
  // picker but is ignored by the backend when the id list is present. Nothing
  // selected → no audience (fire stays disabled).
  const reportAudience = (sel: Set<string>, list: any[]) => {
    const ids = list
      .filter((m, i) => sel.has(contactId(m, i)))
      .map((m) => m?.id)
      .filter(Boolean)
      .map(String);
    if (ids.length === 0) {
      onChange(null, 0, sourceLabel);
      return;
    }
    onChange(
      { type: 'hubspot_list', list_id: selected, include_contact_ids: ids },
      ids.length,
      sourceLabel
    );
  };

  const resetPreview = () => {
    setMembers([]);
    setTotal(null);
    setNextCursor(null);
    setPreviewError(null);
    setPreviewed(false);
    setSelectedIds(new Set());
  };

  // Picking a list clears any prior selection; records are hand-picked from the
  // preview (opt-in), so there's no audience until the operator selects some.
  const handleSelect = (id: string) => {
    setSelected(id);
    resetPreview();
    onChange(null, null);
  };

  // Changing the area-code filter invalidates a prior preview.
  useEffect(() => {
    if (previewed) resetPreview();
    // The source disables `react-hooks/exhaustive-deps` here — a deliberate dependency omission, so the
    // effect fires only on the state change it names. This repo's eslint config does not include the
    // react-hooks plugin, so the directive itself errored as an unknown rule; kept as a plain comment so
    // the intent survives if the plugin is ever added.
  }, [areaCodes.join(',')]);

  const fetchPage = async (cursor?: string) => {
    const res = await fetch('/api/outbound/hubspot/list-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        list_id: selected,
        limit: PAGE_SIZE,
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

  const preview = async () => {
    if (!selected) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const data = await fetchPage();
      const m = Array.isArray(data.members) ? data.members : [];
      const t =
        typeof data.total === 'number'
          ? data.total
          : (selectedList?.size ?? null);
      const cursor = data.next_cursor ?? null;
      setMembers(m);
      setTotal(t);
      setNextCursor(cursor);
      setSelectedIds(new Set());
      setPreviewed(true);
      // Default: nothing selected → no audience yet.
      onChange(null, 0, sourceLabel);
      previewRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    } catch (e: any) {
      setPreviewError(e?.message || 'Preview failed');
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

  return (
    <div className="space-y-3">
      <label
        htmlFor="hs-list-select"
        className="block text-[13px] font-medium text-gray-700"
      >
        HubSpot list
      </label>
      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-gray-400">
          <Loader2 className="size-4 animate-spin" /> Loading lists…
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="text-[12px] leading-relaxed text-amber-700">{error}</p>
        </div>
      ) : (
        <SearchableSelect
          id="hs-list-select"
          value={selected}
          onChange={handleSelect}
          options={lists.map((l) => ({
            value: l.id,
            label:
              typeof l.size === 'number'
                ? `${l.name} · ${l.size.toLocaleString()}`
                : l.name,
          }))}
          placeholder="Select a list"
          searchPlaceholder="Search lists…"
          emptyText="No lists found."
        />
      )}

      {selected && (
        <div
          ref={previewRef}
          className="flex items-center justify-between pt-1"
        >
          <button
            type="button"
            onClick={preview}
            disabled={previewing}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Eye className="size-3.5" />
            )}
            Preview records
          </button>
          {typeof selectedList?.size === 'number' && (
            <span className="text-[12px] text-gray-500">
              <span className="font-semibold text-gray-900">
                {selectedList.size.toLocaleString()}
              </span>{' '}
              in list
              {areaCodes.length > 0 && (
                <span className="text-gray-400">
                  {' '}
                  · before area-code filter
                </span>
              )}
            </span>
          )}
        </div>
      )}

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
