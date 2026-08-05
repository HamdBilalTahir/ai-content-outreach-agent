// Pure helpers + consts for the outbound chat-detail view. Copied faithfully
// from the E2E test client (OutboundE2ETestClient.tsx) so behaviour matches.

// Normalise a raw Firestore value for display — Firestore Timestamp → ISO
// string, recursing arrays/plain objects. Mirrors the server monitoring route's
// serializeValue so live onSnapshot docs match the REST-fetched shape exactly
// (the downstream derivations do `new Date(...)` on ISO strings).
export function serializeValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

// ─── Stage funnel ───────────────────────────────────────────────────────────

export const STAGE_ORDER = [
  'New',
  'Contacted',
  'Engaged',
  'Lead',
  'Pushed to CRM',
  'CRM Won',
];
export const TERMINAL_STAGES = new Set(['Lost', 'CRM Won']);

export const STAGE_COLORS: Record<string, string> = {
  New: 'bg-blue-100 text-blue-700 border-blue-200',
  Contacted: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  Engaged: 'bg-green-100 text-green-700 border-green-200',
  Lead: 'bg-purple-100 text-purple-700 border-purple-200',
  'Pushed to CRM': 'bg-teal-100 text-teal-700 border-teal-200',
  'CRM Won': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Lost: 'bg-red-100 text-red-700 border-red-200',
};
export const stageColor = (s: string) =>
  STAGE_COLORS[s] ?? 'bg-gray-100 text-gray-600 border-gray-200';

// ─── Polling ────────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 60 * 1000;
// Auto-refresh runs up to 15 min (outbound calls/emails can take a while),
// or stops early once the chat reaches a terminal stage.
export const POLL_MAX_MS = 15 * 60 * 1000;

// ─── Layout ─────────────────────────────────────────────────────────────────

export const sectionCard =
  'rounded-2xl border border-gray-100 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.03),0_6px_20px_rgba(16,24,40,0.05)]';

// ─── Time formatting ────────────────────────────────────────────────────────

export function formatDuration(seconds?: number): string {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

export const fmtTs = (s: string | null) =>
  s ? new Date(s).toLocaleString() : '—';

// Compact relative time ("1 minute ago", "in 2 hours") for collapsed cards —
// the exact timestamps are shown when the card is expanded.
export const fmtRelative = (s?: string | null): string => {
  if (!s) return '';
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const past = diff >= 0;
  const abs = Math.abs(diff);
  const unit = (n: number, u: string) =>
    past
      ? `${n} ${u}${n === 1 ? '' : 's'} ago`
      : `in ${n} ${u}${n === 1 ? '' : 's'}`;
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return unit(mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return unit(hrs, 'hour');
  return unit(Math.round(hrs / 24), 'day');
};

export const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ─── Value helpers ──────────────────────────────────────────────────────────

export const isEmpty = (v: any) =>
  v == null ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) ||
  (Array.isArray(v) && v.length === 0) ||
  v === '';

export const statusPill = (status?: string | null) => {
  const s = (status ?? '').toLowerCase();
  if (
    [
      'success',
      'done',
      'completed',
      'delivered',
      'sent',
      'updated',
      'created',
    ].includes(s)
  )
    return 'bg-emerald-100 text-emerald-700';
  if (['failed', 'error', 'undelivered'].includes(s))
    return 'bg-red-100 text-red-700';
  if (['pending', 'in_progress', 'queued', 'running'].includes(s))
    return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-600';
};

export function humanize(k: string): string {
  return k
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function isPlainObject(v: any): boolean {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function isPrimitiveArray(v: any): boolean {
  return Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object');
}

export function fieldEntries(data: any): [string, any][] {
  if (Array.isArray(data)) return data.map((v, i) => [String(i + 1), v]);
  if (isPlainObject(data)) return Object.entries(data);
  return [];
}

export function formatLeaf(v: any): string {
  if (v == null) return String(v);
  if (isPrimitiveArray(v)) return (v as any[]).join(', ');
  if (typeof v === 'object') return Object.keys(v).length === 0 ? '{}' : '';
  return String(v);
}

// First string value whose key matches any of `keys`, searched recursively.
export function deepFindString(
  obj: any,
  keys: string[],
  depth = 0
): string | undefined {
  if (obj == null || typeof obj !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k) && typeof v === 'string' && v.trim()) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = deepFindString(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

// First finite positive number whose key matches any of `keys`, searched recursively.
export function deepFindNumber(
  obj: any,
  keys: string[],
  depth = 0
): number | undefined {
  if (obj == null || typeof obj !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = deepFindNumber(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

// ─── Transcript ─────────────────────────────────────────────────────────────

// Format transcript turns as chat-like plain text ("Agent (0:03): …").
export function formatTranscriptTurns(turns: any[]): string {
  return (turns ?? [])
    .filter((t) => (t?.message ?? '').trim())
    .map((t) => {
      const who = t.role === 'agent' ? 'Agent' : 'User';
      const time =
        t.time_in_call_secs != null ? ` (${mmss(t.time_in_call_secs)})` : '';
      return `${who}${time}: ${String(t.message).trim()}`;
    })
    .join('\n');
}

// Fetch the live transcript for a call and return it as chat-like text.
export async function fetchTranscriptText(callId: string): Promise<string> {
  const res = await fetch(
    `/api/voice-workers/transcript?call_id=${encodeURIComponent(callId)}`
  );
  if (!res.ok) throw new Error('Could not load transcript');
  const data = await res.json();
  const text = formatTranscriptTurns(
    Array.isArray(data?.transcript) ? data.transcript : []
  );
  if (!text) throw new Error('No transcript available');
  return text;
}
