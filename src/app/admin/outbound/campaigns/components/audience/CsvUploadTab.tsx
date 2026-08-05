'use client';

// Namespace import as well: the file annotates handlers with `React.DragEvent`, and this repo's eslint
// flags the ambient namespace as `no-undef`.
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { UploadCloud, FileSpreadsheet, X, AlertTriangle } from 'lucide-react';
import { AudienceOnChange } from '../../shared';
import { SearchableSelect } from '../SearchableSelect';
import {
  buildContacts,
  CONTACT_FIELDS,
  ContactField,
  guessMapping,
  parseAudienceFile,
  ParsedFile,
} from './parse-file';

const NONE = '__none__';

export default function CsvUploadTab({
  onChange,
}: {
  onChange: AudienceOnChange;
}) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ContactField, string>>>(
    {}
  );
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const built = useMemo(
    () => (parsed ? buildContacts(parsed.rows, mapping) : null),
    [parsed, mapping]
  );

  // Push the usable contacts + count up whenever the mapping/result changes.
  useEffect(() => {
    if (built && built.usable > 0) {
      onChange(
        { type: 'csv', contacts: built.contacts },
        built.usable,
        `CSV / Excel · ${fileName}`
      );
    } else {
      onChange(null, null);
    }
    // The source disables `react-hooks/exhaustive-deps` here — a deliberate dependency omission, so the
    // effect fires only on the state change it names. This repo's eslint config does not include the
    // react-hooks plugin, so the directive itself errored as an unknown rule; kept as a plain comment so
    // the intent survives if the plugin is ever added.
  }, [built]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    try {
      const result = await parseAudienceFile(file);
      if (result.headers.length === 0) {
        setError('Could not read any columns from this file.');
        setParsed(null);
        return;
      }
      setParsed(result);
      setMapping(guessMapping(result.headers));
    } catch (e: any) {
      setError(e?.message || 'Failed to parse file');
      setParsed(null);
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const reset = () => {
    setFileName('');
    setParsed(null);
    setMapping({});
    setError(null);
    onChange(null, null);
  };

  const sample = parsed?.rows.slice(0, 3) ?? [];

  return (
    <div className="space-y-4">
      {!parsed ? (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ' +
            (dragging
              ? 'border-slate-400 bg-slate-100/50'
              : 'border-gray-200 bg-gray-50/50 hover:border-slate-300')
          }
        >
          <UploadCloud className="size-7 text-gray-400" />
          <p className="text-[13px] font-medium text-gray-700">
            Drop a CSV or Excel file, or click to browse
          </p>
          <p className="text-[11px] text-gray-400">.csv, .xlsx, .xls</p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </label>
      ) : (
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-3.5 py-2.5">
          <div className="flex items-center gap-2 text-[13px] text-gray-700">
            <FileSpreadsheet className="size-4 text-slate-700" />
            <span className="font-medium">{fileName}</span>
            <span className="text-gray-400">· {parsed.rows.length} rows</span>
          </div>
          <button
            type="button"
            onClick={reset}
            className="flex size-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Remove file"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
          <p className="text-[12px] leading-relaxed text-red-700">{error}</p>
        </div>
      )}

      {parsed && (
        <>
          {/* Column mapping */}
          <div>
            <p className="mb-2 text-[13px] font-medium text-gray-700">
              Map columns
            </p>
            <div className="grid grid-cols-2 gap-3">
              {CONTACT_FIELDS.map(({ key, label }) => (
                <div key={key}>
                  <label
                    htmlFor={`map-${key}`}
                    className="mb-1 block text-[11px] text-gray-500"
                  >
                    {label}
                    {(key === 'email' || key === 'phone_number') && (
                      <span className="text-gray-300"> (one required)</span>
                    )}
                  </label>
                  <SearchableSelect
                    id={`map-${key}`}
                    value={mapping[key] ?? NONE}
                    onChange={(v) =>
                      setMapping((prev) => ({
                        ...prev,
                        [key]: v === NONE ? undefined : v,
                      }))
                    }
                    options={[
                      { value: NONE, label: '— none —' },
                      ...parsed.headers.map((h) => ({ value: h, label: h })),
                    ]}
                    placeholder="—"
                    searchPlaceholder="Search columns…"
                    emptyText="No columns."
                    triggerClassName="h-9 rounded-lg text-[12px]"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Validation summary */}
          {built && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-gray-50 px-3.5 py-2.5 text-[12px]">
              <span className="font-medium text-gray-700">
                {built.usable.toLocaleString()} usable
              </span>
              {built.unusable > 0 && (
                <span className="text-amber-600">
                  {built.unusable.toLocaleString()} skipped (no email or phone)
                </span>
              )}
              {built.usable === 0 && (
                <span className="text-red-500">
                  Map an email or phone column to continue.
                </span>
              )}
            </div>
          )}

          {/* Sample rows */}
          {sample.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="w-full text-[11px]">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    {parsed.headers.slice(0, 6).map((h) => (
                      <th
                        key={h}
                        className="whitespace-nowrap px-3 py-2 text-left font-medium"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sample.map((row, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      {parsed.headers.slice(0, 6).map((h) => (
                        <td
                          key={h}
                          className="max-w-[140px] truncate px-3 py-1.5 text-gray-600"
                        >
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
