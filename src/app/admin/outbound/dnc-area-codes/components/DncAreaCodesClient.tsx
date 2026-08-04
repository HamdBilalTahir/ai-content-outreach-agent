'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  ShieldBan,
  Loader2,
  Pencil,
  Trash2,
  Calendar as CalendarIcon,
  RotateCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface AreaCodeRow {
  area_code: string;
  san_id: string;
  org_id: string;
  san_expiry_date: string | null;
  status: string;
  is_expired: boolean;
  created_at: string;
  updated_at: string;
}

const AREA_CODE_RE = /^[2-9]\d{2}$/;

// Prefilled defaults for the current SAN subscription — editable per batch.
const DEFAULT_SAN_ID = '10431280-531280-26';
const DEFAULT_ORG_ID = '10337195-60308';

// Split on any of comma / whitespace / semicolon / pipe, drop empties, dedup —
// mirrors the backend parser so the chip preview matches what will be saved.
function parseCodes(text: string): string[] {
  const tokens = text
    .split(/[\s,;|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

export default function DncAreaCodesClient() {
  const [rows, setRows] = useState<AreaCodeRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [sanId, setSanId] = useState(DEFAULT_SAN_ID);
  const [orgId, setOrgId] = useState(DEFAULT_ORG_ID);
  const [expiry, setExpiry] = useState<Date | undefined>();
  const [codesText, setCodesText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const parsed = useMemo(() => parseCodes(codesText), [codesText]);
  const validCodes = useMemo(
    () => parsed.filter((c) => AREA_CODE_RE.test(c)),
    [parsed]
  );

  async function loadRows() {
    setLoading(true);
    try {
      const res = await fetch('/api/outbound/dnc/area-codes', {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to load area codes');
      }
      setRows(Array.isArray(data.area_codes) ? data.area_codes : []);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load area codes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRows();
  }, []);

  function resetForm() {
    setSanId(DEFAULT_SAN_ID);
    setOrgId(DEFAULT_ORG_ID);
    setExpiry(undefined);
    setCodesText('');
  }

  async function handleSubmit() {
    if (validCodes.length === 0) return;
    setSubmitting(true);
    try {
      const body: Record<string, string> = {
        area_codes: codesText,
      };
      if (sanId.trim()) body.san_id = sanId.trim();
      if (orgId.trim()) body.org_id = orgId.trim();
      if (expiry) body.san_expiry_date = format(expiry, 'yyyy-MM-dd');

      const res = await fetch('/api/outbound/dnc/area-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok || data?.success === false) {
        const errors = data?.errors as Record<string, string[]> | undefined;
        const msg = errors
          ? Object.entries(errors)
              .map(([field, msgs]) => `${field}: ${(msgs || []).join(' ')}`)
              .join(' · ')
          : data?.error || 'Failed to save area codes';
        toast.error(msg);
        return;
      }

      const saved: string[] = Array.isArray(data.saved) ? data.saved : [];
      const invalid: string[] = Array.isArray(data.invalid) ? data.invalid : [];

      if (saved.length > 0) {
        toast.success(
          `Saved ${saved.length} area code${saved.length === 1 ? '' : 's'}`
        );
      }
      if (invalid.length > 0) {
        toast.warning(
          `Skipped ${invalid.length} invalid: ${invalid.join(', ')}`
        );
        // Keep the invalid tokens in the field so the user can fix them.
        setCodesText(invalid.join(', '));
      } else {
        setCodesText('');
      }
      await loadRows();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save area codes');
    } finally {
      setSubmitting(false);
    }
  }

  function handleEdit(row: AreaCodeRow) {
    setSanId(row.san_id || '');
    setOrgId(row.org_id || '');
    setExpiry(row.san_expiry_date ? new Date(row.san_expiry_date) : undefined);
    setCodesText(row.area_code);
    if (typeof window !== 'undefined')
      window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/outbound/dnc/area-codes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area_code: deleteTarget }),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        const errors = data?.errors as Record<string, string[]> | undefined;
        const msg = errors
          ? Object.entries(errors)
              .map(([field, msgs]) => `${field}: ${(msgs || []).join(' ')}`)
              .join(' · ')
          : data?.error || 'Failed to delete area code';
        throw new Error(msg);
      }
      toast.success(`Deleted area code ${deleteTarget}`);
      setDeleteTarget(null);
      await loadRows();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete area code');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-neutral-900 p-2 text-white">
          <ShieldBan className="size-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">
            FTC DNC Area Codes
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            Area codes our SAN subscription is authorized to scrub against the
            FTC DNC registry. The scrub only returns valid results for these
            codes — anything else is a false &ldquo;clean.&rdquo;
          </p>
        </div>
      </div>

      {/* Add / update form */}
      <div className="space-y-5 rounded-xl border border-neutral-200/70 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">
            Add or update codes
          </h2>
          <p className="text-xs text-neutral-500">
            The SAN details below apply to every area code in this batch.
            Re-saving an existing code updates it.
          </p>
        </div>

        {/* Shared SAN block */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="san-id">SAN ID</Label>
            <Input
              id="san-id"
              value={sanId}
              onChange={(e) => setSanId(e.target.value)}
              placeholder="SAN123"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="org-id">Org ID</Label>
            <Input
              id="org-id"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              placeholder="ORG456"
            />
          </div>
          <div className="space-y-1.5">
            <Label>SAN expiry</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'w-full justify-start text-left font-normal',
                    !expiry && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 size-4" />
                  {expiry ? format(expiry, 'PPP') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <CalendarComponent
                  // `autoFocus` in react-day-picker v9+; the source's `initialFocus` was renamed. Same
                  // v8 → v10 migration as the rename table on `components/ui/calendar.tsx`.
                  autoFocus
                  mode="single"
                  selected={expiry}
                  onSelect={setExpiry}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Smart codes field */}
        <div className="space-y-2">
          <Label htmlFor="codes">Area codes</Label>
          <Textarea
            id="codes"
            value={codesText}
            onChange={(e) => setCodesText(e.target.value)}
            placeholder="303, 770, 610&#10;972 415"
            rows={3}
            className="font-mono text-sm"
          />
          <p className="text-xs text-neutral-500">
            Area code = the first 3 digits after +1 in a phone number. Separate
            with commas, spaces, or new lines.
          </p>
          {parsed.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {parsed.map((code) => {
                const valid = AREA_CODE_RE.test(code);
                return (
                  <Badge
                    key={code}
                    variant="outline"
                    className={cn(
                      'font-mono',
                      valid
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-red-200 bg-red-50 text-red-700'
                    )}
                  >
                    {code}
                  </Badge>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={resetForm} disabled={submitting}>
            Clear
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || validCodes.length === 0}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            {validCodes.length > 0
              ? `Save ${validCodes.length} code${validCodes.length === 1 ? '' : 's'}`
              : 'Save codes'}
          </Button>
        </div>
      </div>

      {/* Registry table */}
      <div className="rounded-xl border border-neutral-200/70 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">
            Registered codes
            {!loading && (
              <span className="ml-2 text-xs font-normal text-neutral-400">
                {rows.length}
              </span>
            )}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadRows}
            disabled={loading}
          >
            <RotateCw
              className={cn('mr-1.5 size-3.5', loading && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-neutral-400" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-center">
            <ShieldBan className="mb-3 size-8 text-neutral-300" />
            <p className="text-sm text-neutral-500">
              No area codes registered yet
            </p>
            <p className="text-xs text-neutral-400">
              Add codes above to authorize DNC scrubbing for them.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Area code</TableHead>
                <TableHead>SAN ID</TableHead>
                <TableHead>Org ID</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[90px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.area_code}>
                  <TableCell className="font-mono font-medium">
                    {row.area_code}
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    {row.san_id || <span className="text-neutral-300">—</span>}
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    {row.org_id || <span className="text-neutral-300">—</span>}
                  </TableCell>
                  <TableCell>
                    {row.san_expiry_date ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-neutral-600">
                          {row.san_expiry_date}
                        </span>
                        {row.is_expired && (
                          <Badge
                            variant="outline"
                            className="border-red-200 bg-red-50 text-red-700"
                          >
                            Expired
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-neutral-300">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        row.status === 'active'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-neutral-200 bg-neutral-50 text-neutral-500'
                      )}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => handleEdit(row)}
                        aria-label={`Edit ${row.area_code}`}
                      >
                        <Pencil className="size-3.5 text-neutral-500" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setDeleteTarget(row.area_code)}
                        aria-label={`Delete ${row.area_code}`}
                      >
                        <Trash2 className="size-3.5 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete area code {deleteTarget}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              DNC scrubbing will no longer be trusted for numbers in this area
              code. You can re-add it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
