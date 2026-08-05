'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send, Users, Settings2, CheckCircle2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Audience, AudienceType, RecordType, inputCls } from '../shared';
import type { ReactNode } from 'react';
import HubspotListTab from './audience/HubspotListTab';
import HubspotSearchTab from './audience/HubspotSearchTab';
import CsvUploadTab from './audience/CsvUploadTab';
import ContactIdsTab from './audience/ContactIdsTab';
import AreaCodeSelect from './audience/AreaCodeSelect';

interface Defaults {
  name?: string;
  recordType?: RecordType;
  perDay?: number;
}

// Small section header — icon chip + title + one-line hint, matching the
// Outbound E2E section idiom.
function SectionHeader({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <div className="flex size-7 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
        {icon}
      </div>
      <div>
        <p className="text-[13px] font-semibold text-gray-900">{title}</p>
        <p className="text-[11px] text-gray-400">{hint}</p>
      </div>
    </div>
  );
}

export default function NewCampaignSheet({
  open,
  onOpenChange,
  agentId,
  defaults,
  onCreated,
  mode = 'create',
  campaignId,
  campaignScreening,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  defaults?: Defaults;
  onCreated: (campaignId: string) => void;
  // 'add' enrolls into an existing live campaign via add-records; campaign
  // details (name/record type/per day) belong to that campaign and are hidden.
  mode?: 'create' | 'add';
  campaignId?: string;
  // In 'add' mode: the existing campaign's screening mode, shown read-only.
  // Screening is fixed at creation — add-records inherits it, can't override.
  campaignScreening?: { businessOnly?: boolean; litigatorOnly?: boolean };
}) {
  const isAdd = mode === 'add';
  const [name, setName] = useState(defaults?.name ?? '');
  const [recordType, setRecordType] = useState<RecordType>(
    defaults?.recordType ?? 'Real'
  );
  const [perDay, setPerDay] = useState<number>(defaults?.perDay ?? 50);
  const [excludeContacted, setExcludeContacted] = useState(true);
  // Screening mode — mutually exclusive gates. Only one can be on (the backend
  // makes litigator win if both are sent, but the FE sends at most one).
  // Litigator-only is the default screen for new campaigns.
  const [businessOnly, setBusinessOnly] = useState(false);
  const [litigatorOnly, setLitigatorOnly] = useState(true);
  const [tab, setTab] = useState<AudienceType>('hubspot_list');
  const [audience, setAudience] = useState<Audience | null>(null);
  const [areaCodes, setAreaCodes] = useState<string[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each audience tab reports its selection + preview count + source label here.
  const handleAudience = (
    a: Audience | null,
    count: number | null,
    label?: string | null
  ) => {
    setAudience(a);
    setPreviewCount(count);
    setSourceLabel(label ?? null);
  };

  // Only the active tab is mounted, so reset the shared audience on switch.
  const handleTabChange = (v: string) => {
    setTab(v as AudienceType);
    setAudience(null);
    setPreviewCount(null);
    setSourceLabel(null);
  };

  const nameEmpty = !name.trim();
  const canFire = (isAdd || !nameEmpty) && !!agentId && !!audience && !firing;
  const missing =
    !isAdd && nameEmpty
      ? 'Add a campaign name'
      : !audience
        ? 'Select an audience'
        : null;

  const fire = async () => {
    if (!canFire || !audience) return;
    // area_codes is a shared restriction applied to whichever source is active.
    const merged: Audience = { ...audience, area_codes: areaCodes };
    setFiring(true);
    setError(null);
    try {
      if (isAdd) {
        if (!campaignId) throw new Error('Missing campaign id');
        const res = await fetch(
          `/api/outbound/campaigns/${campaignId}/add-records`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audience: merged }),
          }
        );
        const data = await res.json();
        if (!res.ok || data?.ok === false)
          throw new Error(data?.error || `Request failed (${res.status})`);
        // The backend's `queued` is the number of PENDING BATCHES (0 when the batch is
        // promoted to run immediately), NOT a record count — so report the selected count.
        toast.success(
          previewCount != null
            ? `Adding ${previewCount.toLocaleString()} record${previewCount === 1 ? '' : 's'} to the campaign`
            : 'Records queued to enroll'
        );
        onCreated(campaignId);
        return;
      }
      const res = await fetch('/api/outbound/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          agent_id: agentId,
          record_type: recordType,
          per_day: perDay,
          audience: merged,
          exclude_contacted: excludeContacted,
          business_only: businessOnly,
          litigator_only: litigatorOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      const id = data?.campaign_id ?? data?.id;
      if (!id)
        throw new Error('Campaign did not start (no campaign_id returned)');
      toast.success('Campaign launched — enrolling contacts');
      onCreated(String(id));
    } catch (e: any) {
      setError(
        e?.message ||
          (isAdd ? 'Could not add records' : 'Could not launch campaign')
      );
    } finally {
      setFiring(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px] lg:max-w-[50vw]"
      >
        <SheetHeader className="border-b border-gray-100 px-6 py-5">
          <SheetTitle className="text-[18px] font-bold text-gray-900">
            {isAdd ? 'Add records' : 'New campaign'}
          </SheetTitle>
          <SheetDescription className="text-[13px] text-gray-500">
            {isAdd
              ? 'Preview an audience and enroll it into this campaign. The new batch runs after the current queue drains.'
              : 'Pick an audience and fire. The backend enrolls and paces it in the background.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Campaign details — only when creating a new campaign. */}
          {!isAdd && (
            <section>
              <SectionHeader
                icon={<Settings2 className="size-3.5" />}
                title="Campaign details"
                hint="Name it, and set how it runs."
              />
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="campaign-name"
                    className="mb-1.5 block text-[13px] font-medium text-gray-700"
                  >
                    Campaign name
                  </label>
                  <input
                    id="campaign-name"
                    className={inputCls}
                    placeholder="Q3 dormant leads"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium text-gray-700">
                      Record type
                    </span>
                    <div className="flex rounded-xl border border-gray-200 bg-gray-50 p-0.5">
                      {(['Real', 'Test'] as RecordType[]).map((rt) => (
                        <button
                          key={rt}
                          type="button"
                          aria-pressed={recordType === rt}
                          onClick={() => setRecordType(rt)}
                          className={cn(
                            'flex-1 rounded-lg py-1.5 text-[12px] font-medium transition-colors',
                            recordType === rt
                              ? rt === 'Test'
                                ? 'bg-amber-500 text-white shadow-sm'
                                : 'bg-white text-gray-900 shadow-sm'
                              : 'text-gray-500 hover:text-gray-700'
                          )}
                        >
                          {rt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="campaign-per-day"
                      className="mb-1.5 block text-[13px] font-medium text-gray-700"
                    >
                      Contacts / day
                    </label>
                    <input
                      id="campaign-per-day"
                      type="number"
                      min={1}
                      className={inputCls}
                      value={perDay}
                      onChange={(e) =>
                        setPerDay(Math.max(1, Number(e.target.value) || 0))
                      }
                    />
                  </div>
                </div>

                {recordType === 'Test' ? (
                  <p className="text-[11px] leading-relaxed text-amber-600">
                    Test bypasses business hours and fires immediately — use for
                    test runs only.
                  </p>
                ) : (
                  <p className="text-[11px] leading-relaxed text-gray-400">
                    Spread across business days, business-hours-only, in each
                    contact&apos;s timezone.
                  </p>
                )}

                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-gray-200 bg-gray-50/60 px-3.5 py-2.5">
                  <input
                    type="checkbox"
                    checked={businessOnly}
                    onChange={(e) => {
                      setBusinessOnly(e.target.checked);
                      if (e.target.checked) setLitigatorOnly(false);
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-slate-900"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-gray-800">
                      Business numbers only
                    </span>
                    <span className="block text-[11px] leading-relaxed text-gray-400">
                      Only enroll numbers confirmed as business lines. Each
                      number must pass: allowed area code → DNC Full Scrub clean
                      → Twilio caller-ID = business, or the number is listed on
                      the company website (any line type). Consumer/unknown
                      numbers not on the website are skipped (fail-closed). Off
                      = normal gating.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5">
                  <input
                    type="checkbox"
                    checked={litigatorOnly}
                    onChange={(e) => {
                      setLitigatorOnly(e.target.checked);
                      if (e.target.checked) setBusinessOnly(false);
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-amber-600"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-gray-800">
                      Litigator only
                    </span>
                    <span className="block text-[11px] font-medium leading-relaxed text-amber-700">
                      Screens out known litigators only. Does not check the DNC
                      registry — all other numbers, including DNC-listed ones,
                      will be contacted. Use only when that&apos;s intended.
                    </span>
                  </span>
                </label>
              </div>
            </section>
          )}

          {/* Add-records: screening mode is fixed at campaign creation and
              inherited by every added batch — show it read-only, no toggle. */}
          {isAdd &&
            (campaignScreening?.litigatorOnly ||
              campaignScreening?.businessOnly) && (
              <p
                className={cn(
                  'rounded-xl border px-3.5 py-2.5 text-[11px] font-medium leading-relaxed',
                  campaignScreening?.litigatorOnly
                    ? 'border-amber-200 bg-amber-50/60 text-amber-700'
                    : 'border-indigo-200 bg-indigo-50/60 text-indigo-700'
                )}
              >
                {campaignScreening?.litigatorOnly
                  ? 'This campaign screens Litigator only — added records skip the DNC registry and only known litigators are blocked.'
                  : 'This campaign screens Business numbers only — added records must pass the business-line gate.'}
              </p>
            )}

          {!isAdd && <div className="border-t border-gray-100" />}

          {/* Audience */}
          <section>
            <SectionHeader
              icon={<Users className="size-3.5" />}
              title="Audience"
              hint="Who should this campaign reach?"
            />

            <div className="mb-3">
              <AreaCodeSelect value={areaCodes} onChange={setAreaCodes} />
            </div>

            <label className="mb-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-gray-200 bg-gray-50/60 px-3.5 py-2.5">
              <input
                type="checkbox"
                checked={excludeContacted}
                onChange={(e) => setExcludeContacted(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-slate-900"
              />
              <span>
                <span className="block text-[13px] font-medium text-gray-800">
                  Exclude contacts already contacted by Ava
                </span>
                <span className="block text-[11px] leading-relaxed text-gray-400">
                  Skips anyone Ava has reached in a prior campaign. Turn off to
                  include them.
                </span>
              </span>
            </label>

            <Tabs value={tab} onValueChange={handleTabChange}>
              <TabsList className="grid h-10 w-full grid-cols-4 gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1">
                {(
                  [
                    ['hubspot_list', 'HubSpot list'],
                    ['hubspot_search', 'Search'],
                    ['csv', 'CSV / Excel'],
                    ['contact_ids', 'Contact IDs'],
                  ] as [AudienceType, string][]
                ).map(([val, lbl]) => (
                  <TabsTrigger
                    key={val}
                    value={val}
                    className="rounded-lg border border-transparent text-[12px] data-[state=active]:border-gray-200 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm"
                  >
                    {lbl}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="hubspot_list" className="mt-4">
                <HubspotListTab
                  agentId={agentId}
                  onChange={handleAudience}
                  areaCodes={areaCodes}
                />
              </TabsContent>
              <TabsContent value="hubspot_search" className="mt-4">
                <HubspotSearchTab
                  agentId={agentId}
                  onChange={handleAudience}
                  excludeContacted={excludeContacted}
                  areaCodes={areaCodes}
                  campaignId={isAdd ? campaignId : undefined}
                />
              </TabsContent>
              <TabsContent value="csv" className="mt-4">
                <CsvUploadTab onChange={handleAudience} />
              </TabsContent>
              <TabsContent value="contact_ids" className="mt-4">
                <ContactIdsTab agentId={agentId} onChange={handleAudience} />
              </TabsContent>
            </Tabs>

            {/* Audience preview / confirmation */}
            <div className="mt-4">
              {audience ? (
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <CheckCircle2 className="size-5 shrink-0 text-slate-700" />
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold leading-tight text-gray-900">
                      {previewCount != null
                        ? `${previewCount.toLocaleString()} contacts`
                        : 'Audience selected'}
                    </p>
                    <p className="truncate text-[12px] text-gray-500">
                      {sourceLabel ?? 'Ready to enroll'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-gray-200 px-4 py-5 text-center">
                  <p className="text-[12px] text-gray-400">
                    Choose a source above to preview your audience.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Footer: preview + fire */}
        <div className="border-t border-gray-100 px-6 py-4">
          {error && <p className="mb-2 text-[12px] text-red-500">{error}</p>}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-[13px]">
              <Users className="size-4 text-gray-400" />
              {missing ? (
                <span className="text-gray-400">{missing}</span>
              ) : (
                <span className="text-gray-600">
                  <span className="font-semibold text-gray-900">
                    {previewCount != null
                      ? previewCount.toLocaleString()
                      : 'Audience'}
                  </span>{' '}
                  {previewCount != null ? 'contacts ready' : 'ready'}
                </span>
              )}
            </div>
            <Button
              className="h-10 gap-1.5 rounded-xl bg-slate-900 text-white hover:bg-slate-800"
              disabled={!canFire}
              onClick={fire}
            >
              {firing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {isAdd ? 'Add records' : 'Fire campaign'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
