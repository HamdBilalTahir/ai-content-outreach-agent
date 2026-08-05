'use client';

import { useCallback, useEffect, useState } from 'react';
import { Building2, Scale } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutboundAgent {
  id: string;
  name: string;
  company_id?: string | number;
  dealers_id?: string;
  dealer_name?: string;
}

export type RecordType = 'Real' | 'Test';

export type AudienceType =
  | 'hubspot_list'
  | 'hubspot_search'
  | 'csv'
  | 'contact_ids';

export interface HubspotList {
  id: string;
  name: string;
  size?: number;
}

export interface HubspotProperty {
  name: string;
  label: string;
  type?: string;
  options?: { label: string; value: string }[];
}

// FE filter-builder shapes (UI state) ----------------------------------------
// One property row: several values combined with ANY (OR) or ALL (AND).
export interface SearchFilter {
  property: string;
  operator: string;
  values: string[];
  match: 'any' | 'all';
}
// A group of rows combined by the group's match; groups combine by group_match.
export interface FilterGroup {
  match: 'any' | 'all';
  filters: SearchFilter[];
}

// HubSpot-ready shapes (what we send) -----------------------------------------
// The FE compiles the group expression to disjunctive normal form: filterGroups
// are OR'd, filters within a group are AND'd — HubSpot Search's native model, so
// the backend just forwards `filterGroups` to HubSpot.
export interface HsFilter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
}
export interface HsFilterGroup {
  filters: HsFilter[];
}

// A parsed CSV/Excel row shaped for the campaigns contract.
export interface CsvContact {
  contact_information: {
    email?: string | null;
    phone_number?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  };
  input_data: {
    company?: string;
    zip?: string;
  };
}

// `area_codes` restricts enrollment to records whose phone area code is in the
// set (empty = no restriction; email-only records always enroll).
// `exclude_contact_ids` are HubSpot contact ids to drop; `include_contact_ids`
// is the opt-in allow-list — when present and non-empty, the backend enrolls
// exactly those ids and the filter/list is just the picker.
export type Audience =
  | {
      type: 'hubspot_list';
      list_id: string;
      area_codes?: string[];
      exclude_contact_ids?: string[];
      include_contact_ids?: string[];
    }
  | {
      type: 'hubspot_search';
      filterGroups: HsFilterGroup[];
      area_codes?: string[];
      exclude_contact_ids?: string[];
      include_contact_ids?: string[];
    }
  | {
      type: 'csv';
      contacts: CsvContact[];
      area_codes?: string[];
      exclude_contact_ids?: string[];
    };

// Each audience tab reports its selection up to the sheet: the payload to fire,
// a preview count (null while unknown), and a short human-readable source label
// for the preview card (e.g. "HubSpot list · Q3 dormant").
export type AudienceOnChange = (
  audience: Audience | null,
  previewCount: number | null,
  sourceLabel?: string | null
) => void;

// The backend list/detail payloads are lightly specified; keep the shape
// permissive and read defensively at the call sites.
export interface Campaign {
  campaign_id?: string;
  id?: string;
  name: string;
  agent_id?: string;
  record_type?: RecordType;
  per_day?: number;
  source?: AudienceType | string;
  audience_size?: number;
  total?: number;
  enrolled_count?: number;
  counts?: { contacted?: number; engaged?: number; booked?: number };
  remaining?: number;
  status: string;
  business_only?: boolean;
  litigator_only?: boolean;
  created_at?: string | number;
  paused_at?: string | number;
}

export const campaignId = (c: Campaign): string =>
  (c.campaign_id ?? c.id ?? '') as string;

// ─── Style tokens (matched to the Outbound E2E screen) ───────────────────────

export const inputCls =
  'w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] text-gray-800 placeholder-gray-400 transition-colors focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10';
export const sectionCard =
  'rounded-2xl border border-gray-100 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.03),0_6px_20px_rgba(16,24,40,0.05)]';

// Campaign status → pill colours.
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600 border-gray-200',
  enrolling: 'bg-blue-100 text-blue-700 border-blue-200',
  running: 'bg-green-100 text-green-700 border-green-200',
  paused: 'bg-amber-100 text-amber-700 border-amber-200',
  done: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};
export const statusColor = (s: string) =>
  STATUS_COLORS[String(s).toLowerCase()] ??
  'bg-gray-100 text-gray-600 border-gray-200';

export const TERMINAL_STATUSES = new Set(['done', 'completed', 'stopped']);

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize',
        statusColor(status)
      )}
    >
      {status || 'unknown'}
    </span>
  );
}

// Shown on campaigns created with the "Business numbers only" gate on.
export function BusinessOnlyBadge({ show }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700"
      title="Only numbers confirmed as business lines were enrolled (allowed area code → DNC Full Scrub clean → business caller-ID, or listed on the company website)."
    >
      <Building2 className="size-3" />
      Business-only
    </span>
  );
}

// Shown on campaigns created with the "Litigator only" gate on. Amber, because
// it's the lightest-touch screen (litigator list only — no DNC registry check).
export function LitigatorOnlyBadge({ show }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-700"
      title="Only known TCPA litigators were screened out. The DNC registry was NOT checked — every other number (including DNC-listed ones) was enrolled."
    >
      <Scale className="size-3" />
      Litigator-only
    </span>
  );
}

// ─── Agent loading (mirrors the Outbound E2E screen) ─────────────────────────

async function fetchAllAgents(companyId: string): Promise<OutboundAgent[]> {
  const res = await fetch(`/api/agents/list?companyId=${companyId}`);
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

// Loads the company's agents, narrows to those owning an outbound-typed skill
// (falls back to all agents if that query fails), and defaults the selection to
// Ava — the same behaviour as the E2E screen.
// Persist the operator's agent choice so it survives reloads / page switches.
const AGENT_STORAGE_KEY = 'outbound:selectedAgentId';

export function useOutboundAgents(companyId: string) {
  const [agents, setAgents] = useState<OutboundAgent[]>([]);
  const [outboundIds, setOutboundIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedIdState] = useState('');

  // Persist every explicit choice so it's restored next time.
  const setSelectedId = useCallback((id: string) => {
    setSelectedIdState(id);
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem(AGENT_STORAGE_KEY, id);
    } catch {
      /* storage unavailable (private mode) — non-fatal */
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAllAgents(companyId)
      .then(setAgents)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Via the Admin-SDK route — the client SDK collectionGroup query fails
        // in some environments (and needs its own index).
        const res = await fetch('/api/outbound/agents');
        const data = await res.json();
        if (!res.ok)
          throw new Error(data?.error || `Request failed (${res.status})`);
        if (!cancelled) setOutboundIds(new Set<string>(data?.agent_ids ?? []));
      } catch (e) {
        console.error('[campaigns] outbound agents query failed', e);
        if (!cancelled) setOutboundIds(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const outboundAgents = outboundIds
    ? agents.filter((a) => outboundIds.has(a.id))
    : agents;

  // Initial selection, once: the operator's saved choice if it's still a valid
  // outbound agent, else default to "Lily" (match by stable id, then name),
  // else the first agent. Restoring doesn't re-persist — only explicit picks do.
  const LILY_AGENT_ID = 'k31pCNgXdYCW0wDs7vZY';
  useEffect(() => {
    if (selectedId || loading || outboundAgents.length === 0) return;
    let saved: string | null = null;
    try {
      if (typeof window !== 'undefined')
        saved = window.localStorage.getItem(AGENT_STORAGE_KEY);
    } catch {
      /* storage unavailable — fall through to the default */
    }
    const preferred =
      (saved && outboundAgents.find((a) => a.id === saved)) ||
      outboundAgents.find((a) => a.id === LILY_AGENT_ID) ||
      outboundAgents.find((a) => a.name === 'Lily') ||
      outboundAgents[0];
    setSelectedIdState(preferred.id);
  }, [loading, outboundAgents, selectedId]);

  return { outboundAgents, loading, selectedId, setSelectedId };
}
