'use client';

import { useRef, useState } from 'react';
import { Loader2, Eye, Upload, AlertTriangle } from 'lucide-react';
import { AudienceOnChange } from '../../shared';
import AudiencePreview, { contactId } from './AudiencePreview';

// Count the numeric HubSpot ids in a raw paste (comma / space / newline /
// semicolon separated) — used only for the button label + empty-guard. The
// backend does the authoritative split, so we send the raw text through.
const countIds = (raw: string): number => (raw.match(/\d+/g) ?? []).length;

export default function ContactIdsTab({
  agentId,
  onChange,
}: {
  agentId: string;
  onChange: AudienceOnChange;
}) {
  const [raw, setRaw] = useState('');
  const [members, setMembers] = useState<any[]>([]);
  const [notFound, setNotFound] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const idCount = countIds(raw);

  // Report the opt-in audience: exactly the checked contacts enroll, sent as
  // `include_contact_ids` (authoritative — the backend enrolls precisely these
  // and ignores the picker, so type/filterGroups are just a valid placeholder).
  const reportAudience = (sel: Set<string>, list: any[]) => {
    const ids = list
      .filter((m, i) => sel.has(contactId(m, i)))
      .map((m) => m?.id)
      .filter(Boolean)
      .map(String);
    if (ids.length === 0) {
      onChange(null, 0, 'Contact IDs');
      return;
    }
    onChange(
      { type: 'hubspot_search', filterGroups: [], include_contact_ids: ids },
      ids.length,
      `Contact IDs · ${ids.length.toLocaleString()} selected`
    );
  };

  const resetPreview = () => {
    setMembers([]);
    setNotFound([]);
    setPreviewError(null);
    setPreviewed(false);
    setSelectedIds(new Set());
    onChange(null, null);
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      // Append to whatever is already pasted, so upload + paste compose.
      setRaw((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
      resetPreview();
    } catch {
      setPreviewError('Could not read that file');
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const preview = async () => {
    if (!agentId || idCount === 0) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch('/api/outbound/hubspot/contacts-by-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, contact_ids: raw }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      const m: any[] = Array.isArray(data.members) ? data.members : [];
      setMembers(m);
      setNotFound(Array.isArray(data.not_found) ? data.not_found : []);
      setPreviewed(true);
      // The operator explicitly listed these ids, so pre-select every found one
      // (they can still deselect). Nothing found → no audience.
      const all = new Set<string>(
        m.map((x: any, i: number) => contactId(x, i))
      );
      setSelectedIds(all);
      reportAudience(all, m);
    } catch (e: any) {
      setPreviewError(e?.message || 'Preview failed');
      setPreviewed(false);
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
  // All ids are fetched in one preview call (no pagination), so "select first N"
  // just slices the loaded set.
  const selectFirstN = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return;
    const next = new Set(
      members
        .slice(0, Math.min(n, members.length))
        .map((m, i) => contactId(m, i))
    );
    setSelectedIds(next);
    reportAudience(next, members);
  };

  return (
    <div className="space-y-3">
      <label
        htmlFor="contact-ids-input"
        className="block text-[13px] font-medium text-gray-700"
      >
        HubSpot contact IDs
      </label>
      <textarea
        id="contact-ids-input"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          if (previewed) resetPreview();
        }}
        rows={4}
        placeholder="Paste contact IDs — commas, spaces, or new lines: 101, 202 303"
        className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 font-mono text-[12px] text-gray-800 placeholder-gray-400 transition-colors focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10"
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={preview}
            disabled={previewing || idCount === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Eye className="size-3.5" />
            )}
            Preview records
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
          >
            <Upload className="size-3.5" />
            Upload .txt / .csv
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </div>
        {idCount > 0 && (
          <span className="text-[12px] text-gray-500">
            <span className="font-semibold text-gray-900">
              {idCount.toLocaleString()}
            </span>{' '}
            ID{idCount === 1 ? '' : 's'} pasted
          </span>
        )}
      </div>

      {previewError && (
        <p className="text-[12px] text-red-500">{previewError}</p>
      )}

      {previewed && notFound.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="text-[12px] leading-relaxed text-amber-700">
            <span className="font-semibold">
              {notFound.length.toLocaleString()} ID
              {notFound.length === 1 ? '' : 's'} not found
            </span>{' '}
            in HubSpot (deleted or mistyped) and will be skipped:{' '}
            <span className="break-all font-mono">{notFound.join(', ')}</span>
          </p>
        </div>
      )}

      {previewed && !previewError && (
        <AudiencePreview
          members={members}
          total={members.length}
          nextCursor={null}
          loadingMore={false}
          selectedIds={selectedIds}
          selectingN={false}
          onToggleSelected={toggleSelected}
          onSelectAll={selectAll}
          onUnselectAll={unselectAll}
          onSelectFirstN={selectFirstN}
          onLoadMore={() => {}}
        />
      )}
    </div>
  );
}
