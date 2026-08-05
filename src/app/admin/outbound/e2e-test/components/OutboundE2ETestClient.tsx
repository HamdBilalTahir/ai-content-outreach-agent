'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Rocket,
  ChevronRight,
  Bot,
  Phone,
  Mail,
  Plus,
  X,
  RefreshCw,
  Pause,
  Play,
  ChevronDown,
  AlertTriangle,
  UserRound,
  Archive,
  Copy,
  Check,
  FileText,
  Send,
  Loader2,
  CheckCircle2,
  Circle,
  MinusCircle,
  Eraser,
  Download,
  Database,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useComposerHistory } from '@/components/outbound/chat-detail/useComposerHistory';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OverseeAgent {
  id: string;
  name: string;
  company_id?: string | number;
  dealers_id?: string;
  dealer_name?: string;
}

// A saved test prospect — the full person, so picking any one field's value
// re-populates all the others.
interface ProspectProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  zipCode: string;
}

interface ChatMessage {
  id: string;
  timestamp: string | null;
  type: string;
  direction: string | null;
  sender: { kind?: string } | null;
  content: Record<string, any> | null;
  status: string | null;
  source: string | null;
  attachments: any[];
}

interface ChatTask {
  id: string;
  type: string | null;
  executed: boolean;
  permanent_failure?: boolean;
  execute_at: string | null;
  created_at: string | null;
  instructions: string | null;
  taskData: any;
  output: any;
}

interface ChatData {
  messages: ChatMessage[];
  tasks: ChatTask[];
  activities: Record<string, any>[];
  notifications: Record<string, any>[];
  chatFields: Record<string, any>;
}

interface FireResult {
  chat_id: string;
  task_id?: string;
  channel_key?: string;
  started_at?: number;
  stage?: string | null;
  name?: string | null;
}

const MAX_RUNS = 100;

// ── Fire sequence steps ──
// The fire button expands into a live stack of these three steps.
type FireStepId = 'cleanup' | 'park' | 'initiate';
type FireStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
interface FireStep {
  id: FireStepId;
  status: FireStepStatus;
  detail?: string;
}
const FIRE_STEP_META: Record<FireStepId, { title: string; hint: string }> = {
  cleanup: {
    title: 'Clean up HubSpot test records',
    hint: 'Remove the test contact & deal from a prior run',
  },
  park: {
    title: 'Reset chat history',
    hint: 'Archive & remove the existing chat so it starts fresh',
  },
  initiate: {
    title: 'Start outbound flow',
    hint: 'Fire the initiate-outbound webhook for this prospect',
  },
};
const INITIAL_FIRE_STEPS: FireStep[] = [
  { id: 'cleanup', status: 'pending' },
  { id: 'park', status: 'pending' },
  { id: 'initiate', status: 'pending' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────────

const STAGE_ORDER = [
  'New',
  'Contacted',
  'Engaged',
  'Lead',
  'Pushed to CRM',
  'CRM Won',
];
const TERMINAL_STAGES = new Set(['Lost', 'CRM Won']);
const POLL_INTERVAL_MS = 60 * 1000;
// Auto-refresh runs up to 15 min (outbound calls/emails can take a while),
// or stops early once the chat reaches a terminal stage.
const POLL_MAX_MS = 15 * 60 * 1000;

const STAGE_COLORS: Record<string, string> = {
  New: 'bg-blue-100 text-blue-700 border-blue-200',
  Contacted: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  Engaged: 'bg-green-100 text-green-700 border-green-200',
  Lead: 'bg-purple-100 text-purple-700 border-purple-200',
  'Pushed to CRM': 'bg-teal-100 text-teal-700 border-teal-200',
  'CRM Won': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Lost: 'bg-red-100 text-red-700 border-red-200',
};
const stageColor = (s: string) =>
  STAGE_COLORS[s] ?? 'bg-gray-100 text-gray-600 border-gray-200';

async function fetchAllAgents(companyId: string): Promise<OverseeAgent[]> {
  const res = await fetch(`/api/agents/list?companyId=${companyId}`);
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

// Advisory pre-flight: does the agent (or its parent) have an outbound-typed
// skill? Via the Admin-SDK route (client SDK reads are unreliable in some envs).
async function agentHasOutboundSkill(agentId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/outbound/agents/has-outbound-skill?agent_id=${encodeURIComponent(agentId)}`
    );
    if (!res.ok) return false;
    const data = await res.json();
    return !!data?.has_outbound;
  } catch {
    return false;
  }
}

function formatDuration(seconds?: number): string {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

const inputCls =
  'w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] text-gray-800 placeholder-gray-400 transition-colors focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10';
const sectionCard =
  'rounded-2xl border border-gray-100 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.03),0_6px_20px_rgba(16,24,40,0.05)]';
// Red halo for a required field that's still empty.
const inputErrorCls = 'border-red-400 ring-4 ring-red-500/10';

// First string value whose key matches any of `keys`, searched recursively.
function deepFindString(
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
function deepFindNumber(
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

// ─── Client ────────────────────────────────────────────────────────────────────

export default function OutboundE2ETestClient({
  companyId,
}: {
  companyId: string;
}) {
  const [allAgents, setAllAgents] = useState<OverseeAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);

  // Dealer filtering was removed from the E2E flow; kept as a constant so the
  // downstream dealers_id fallback still resolves from the selected agent.
  const [selectedDealerId] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');

  const [firstName, setFirstName] = useState('Hamd Bilal');
  const [lastName, setLastName] = useState('Tahir');
  const [email, setEmail] = useState('hamdb.tahir@gmail.com');
  const [phone, setPhone] = useState('+19083864637');

  // Outbound channels — both on by default; unchecking sends null for that field.
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(true);
  // Opt-out flags for testing the server-side gates (sent on initiate-outbound).
  const [phoneOptOutTest, setPhoneOptOutTest] = useState(false);
  const [emailOptOutTest, setEmailOptOutTest] = useState(false);
  // When off, initiate sends skip_hubspot_crud=true → backend defers all HubSpot
  // CRM writes (contact/deal/stage) but still books the meeting + returns the
  // meet link. On by default to preserve normal behavior.
  const [hubspotSyncTest, setHubspotSyncTest] = useState(true);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [company, setCompany] = useState('Auto Dealer HBT');
  // Optional prospect ZIP — the backend derives state + timezone from it, so the
  // voice date line + business hours are correct (vs. the phone area-code
  // fallback). Defaults to a NYC ZIP for the test prospect.
  const [zipCode, setZipCode] = useState('10001');

  // Quick-fill history for the prospect text fields, persisted in localStorage so
  // prior test values are one click away (native <datalist> dropdown).
  const HISTORY_LIMIT = 10;
  const histKey = (f: string) => `outbound-e2e:${f}`;
  const loadFieldHistory = (f: string): string[] => {
    if (typeof window === 'undefined') return [];
    try {
      const p = JSON.parse(localStorage.getItem(histKey(f)) || '[]');
      return Array.isArray(p)
        ? p.filter((x: unknown) => typeof x === 'string')
        : [];
    } catch {
      return [];
    }
  };
  const [fieldHistory, setFieldHistory] = useState<Record<string, string[]>>(
    {}
  );
  useEffect(() => {
    const h: Record<string, string[]> = {};
    for (const f of [
      'first_name',
      'last_name',
      'email',
      'phone',
      'company',
      'zip',
    ])
      h[f] = loadFieldHistory(f);
    setFieldHistory(h);
    // The source disables `react-hooks/exhaustive-deps` here — a deliberate dependency omission. This
    // repo's eslint config has no react-hooks plugin, so the directive errored as an unknown rule; kept as
    // prose so the intent survives if the plugin is ever added.
  }, []);
  const rememberField = (f: string, value: string) => {
    const v = value.trim();
    if (!v) return;
    setFieldHistory((prev) => {
      const next = [v, ...(prev[f] ?? []).filter((x) => x !== v)].slice(
        0,
        HISTORY_LIMIT
      );
      try {
        localStorage.setItem(histKey(f), JSON.stringify(next));
      } catch {
        /* ignore quota / unavailable storage */
      }
      return { ...prev, [f]: next };
    });
  };

  // Whole-prospect profiles: each fired run saves the full person, so picking a
  // saved value in ANY field (name / phone / email / company) auto-fills the
  // rest — no need to re-select each field one by one.
  const PROFILES_KEY = 'outbound-e2e:prospects';
  const [profiles, setProfiles] = useState<ProspectProfile[]>([]);
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
      if (Array.isArray(p))
        setProfiles(p.filter((x: any) => x && typeof x === 'object'));
    } catch {
      /* ignore malformed / unavailable storage */
    }
  }, []);
  const profileKey = (p: ProspectProfile) =>
    (p.phone || p.email || '').trim().toLowerCase();
  const rememberProfile = (p: ProspectProfile) => {
    const k = profileKey(p);
    if (!k) return;
    setProfiles((prev) => {
      const next = [p, ...prev.filter((x) => profileKey(x) !== k)].slice(
        0,
        HISTORY_LIMIT
      );
      try {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / unavailable storage */
      }
      return next;
    });
  };
  // When a saved value is chosen in one field, fill the rest of that person.
  const applyProfileByField = (field: keyof ProspectProfile, value: string) => {
    const v = value.trim().toLowerCase();
    if (!v) return;
    const match = profiles.find(
      (p) => (p[field] || '').trim().toLowerCase() === v
    );
    if (!match) return;
    setFirstName(match.firstName ?? '');
    setLastName(match.lastName ?? '');
    setEmail(match.email ?? '');
    setPhone(match.phone ?? '');
    setCompany(match.company ?? '');
    setZipCode(match.zipCode ?? '');
  };

  const [extraFields, setExtraFields] = useState<
    { key: string; value: string }[]
  >([]);

  // Full prospect-form draft — persisted to localStorage so the values entered
  // in the New-run drawer survive reloads WITHOUT firing a run (distinct from the
  // per-field quick-fill history above, which only records on a run). Restored on
  // mount; auto-saved on every change once hydrated.
  const DRAFT_KEY = 'outbound-e2e:draft';
  const [draftHydrated, setDraftHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (typeof d.firstName === 'string') setFirstName(d.firstName);
        if (typeof d.lastName === 'string') setLastName(d.lastName);
        if (typeof d.email === 'string') setEmail(d.email);
        if (typeof d.phone === 'string') setPhone(d.phone);
        if (typeof d.company === 'string') setCompany(d.company);
        if (typeof d.zipCode === 'string') setZipCode(d.zipCode);
        if (typeof d.voiceEnabled === 'boolean')
          setVoiceEnabled(d.voiceEnabled);
        if (typeof d.emailEnabled === 'boolean')
          setEmailEnabled(d.emailEnabled);
        if (typeof d.phoneOptOutTest === 'boolean')
          setPhoneOptOutTest(d.phoneOptOutTest);
        if (typeof d.emailOptOutTest === 'boolean')
          setEmailOptOutTest(d.emailOptOutTest);
        if (typeof d.hubspotSyncTest === 'boolean')
          setHubspotSyncTest(d.hubspotSyncTest);
        if (Array.isArray(d.extraFields))
          setExtraFields(
            d.extraFields.filter(
              (x: any) =>
                x && typeof x.key === 'string' && typeof x.value === 'string'
            )
          );
      }
    } catch {
      /* ignore malformed / unavailable storage */
    }
    setDraftHydrated(true);
    // The source disables `react-hooks/exhaustive-deps` here — a deliberate dependency omission. This
    // repo's eslint config has no react-hooks plugin, so the directive errored as an unknown rule; kept as
    // prose so the intent survives if the plugin is ever added.
  }, []);
  useEffect(() => {
    if (!draftHydrated) return; // don't clobber the saved draft with defaults on mount
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          company,
          zipCode,
          voiceEnabled,
          emailEnabled,
          phoneOptOutTest,
          emailOptOutTest,
          hubspotSyncTest,
          extraFields,
        })
      );
    } catch {
      /* ignore quota / unavailable storage */
    }
  }, [
    draftHydrated,
    firstName,
    lastName,
    email,
    phone,
    company,
    zipCode,
    voiceEnabled,
    emailEnabled,
    phoneOptOutTest,
    emailOptOutTest,
    hubspotSyncTest,
    extraFields,
  ]);

  const [outboundSkillOk, setOutboundSkillOk] = useState<boolean | null>(null);
  // Agents that own an outbound-typed skill (one collectionGroup query).
  // null = unknown/failed → fall back to showing all agents.
  const [outboundAgentIds, setOutboundAgentIds] = useState<Set<string> | null>(
    null
  );
  const [outboundReady, setOutboundReady] = useState(false);
  const autoSelectedRef = useRef(false);

  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  // Live progress of the multi-step fire sequence; null until the first fire, so
  // the plain "Fire" button shows initially and reappears only via "Run again".
  const [fireSteps, setFireSteps] = useState<FireStep[] | null>(null);
  // How many prior chats were parked+deleted on the last fire (0 = none).
  const [parkedCount, setParkedCount] = useState<number | null>(null);
  // Run history (latest first); the active one is expanded and live-polled.
  const [runs, setRuns] = useState<FireResult[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  // True until the agent's runs have been fetched (so we skeleton, not flash
  // "No run yet" prematurely).
  const [runsLoading, setRunsLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [chatData, setChatData] = useState<ChatData | null>(null);
  // Optimistic opt-out toggle state (per active chat); cleared once the refetched
  // chatData reflects the write, and reset when switching runs.
  const [optOptimistic, setOptOptimistic] = useState<{
    phone?: boolean;
    email?: boolean;
  }>({});
  // Setup form lives in a left slide-over drawer so the results (conversation +
  // activities) get the full canvas when it's closed.
  const [setupOpen, setSetupOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  // Inbox rail shows this many run cards; scrolling to the bottom reveals more.
  const [visibleRuns, setVisibleRuns] = useState(10);
  const [stopped, setStopped] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(
    new Set()
  );
  // CRM-style single-open accordion: one section expands and fills the sidebar;
  // clicking the open one collapses it. Headers stay visible always.
  const [activeSection, setActiveSection] = useState<string>('activities');
  const pollStartedRef = useRef<number | null>(null);

  // Refs so the polled loader reads fresh values without re-subscribing.
  const activeChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);
  const prevRunIdsRef = useRef<Set<string>>(new Set());

  // Conversation auto-scroll: stick to the newest message unless the user has
  // scrolled up.
  const convScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Switch which run is open + reset its live view.
  const switchActive = useCallback((id: string | null) => {
    setActiveChatId(id);
    stickToBottomRef.current = true;
    setChatData(null);
    setStopped(false);
    setOptOptimistic({});
    pollStartedRef.current = null;
  }, []);

  const toggleSection = useCallback((key: string) => {
    setActiveSection((prev) => (prev === key ? '' : key));
  }, []);

  // First load with no runs → open the setup drawer once (don't reopen after the
  // user closes it).
  useEffect(() => {
    if (!runsLoading && runs.length === 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setSetupOpen(true);
    }
  }, [runsLoading, runs.length]);

  // Pull the agent's outbound runs (type=="outbound" chats — live server-side,
  // not just this browser). Polled, so newly-created chats show up and the view
  // follows the latest when a new chat appears; the active one stays put
  // otherwise (unless it was parked away).
  const loadRuns = useCallback(
    async (initial = false) => {
      if (!selectedAgentId) return;
      if (initial) {
        setRunsLoading(true);
        prevRunIdsRef.current = new Set();
      }
      try {
        const res = await fetch(
          `/api/outbound/runs?agentId=${encodeURIComponent(selectedAgentId)}`
        );
        const data = res.ok ? await res.json() : { runs: [] };
        const list: FireResult[] = (data.runs ?? []).map((r: any) => ({
          chat_id: r.chat_id,
          started_at: r.started_at ?? undefined,
          stage: r.stage ?? null,
          name: r.name ?? null,
        }));
        setRuns(list);

        const prevIds = prevRunIdsRef.current;
        prevRunIdsRef.current = new Set(list.map((r) => r.chat_id));
        const latest = list[list.length - 1]?.chat_id ?? null;
        const active = activeChatIdRef.current;

        if (initial) {
          switchActive(latest);
        } else {
          const hasNew =
            prevIds.size > 0 && list.some((r) => !prevIds.has(r.chat_id));
          const activeGone =
            active != null && !list.some((r) => r.chat_id === active);
          // Follow a freshly-created chat, or recover if the active one was
          // parked/deleted; otherwise keep the user's current selection.
          if ((active == null || hasNew || activeGone) && latest !== active) {
            switchActive(latest);
          }
        }
      } catch {
        // ignore — a fired run still appears live via handleFire
      } finally {
        if (initial) setRunsLoading(false);
      }
    },
    [selectedAgentId, switchActive]
  );

  // Initial load on agent select.
  useEffect(() => {
    if (!selectedAgentId) {
      if (outboundReady) setRunsLoading(false);
      return;
    }
    loadRuns(true);
  }, [selectedAgentId, outboundReady, loadRuns]);

  // Keep the run list fresh so new chats appear without a reload.
  useEffect(() => {
    if (!selectedAgentId || stopped) return;
    const h = setInterval(() => loadRuns(false), POLL_INTERVAL_MS);
    return () => clearInterval(h);
  }, [selectedAgentId, stopped, loadRuns]);

  // Sync the open chat's live stage back into its rail card so the list reflects
  // the current stage immediately (the runs poll only refreshes every interval).
  useEffect(() => {
    const stage = chatData?.chatFields?.stage as string | undefined;
    if (!activeChatId || !stage) return;
    setRuns((prev) =>
      prev.map((r) =>
        r.chat_id === activeChatId && r.stage !== stage ? { ...r, stage } : r
      )
    );
  }, [activeChatId, chatData]);

  // Load agents for the company
  useEffect(() => {
    setLoadingAgents(true);
    fetchAllAgents(companyId)
      .then((agents) => {
        setAllAgents(agents);
      })
      .catch(console.error)
      .finally(() => setLoadingAgents(false));
  }, [companyId]);

  // Load the set of agents that own an outbound-typed skill (Admin-SDK route).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/outbound/agents');
        const data = await res.json();
        if (!res.ok)
          throw new Error(data?.error || `Request failed (${res.status})`);
        if (!cancelled)
          setOutboundAgentIds(new Set<string>(data?.agent_ids ?? []));
      } catch (e) {
        console.error('[outbound-e2e] outbound agents query failed', e);
        if (!cancelled) setOutboundAgentIds(null); // fall back to all agents
      } finally {
        if (!cancelled) setOutboundReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only outbound-capable agents (fall back to all if the query failed).
  const outboundAgents = outboundAgentIds
    ? allAgents.filter((a) => outboundAgentIds.has(a.id))
    : allAgents;
  const agentsForDealer = selectedDealerId
    ? outboundAgents.filter((a) => a.dealers_id === selectedDealerId)
    : outboundAgents;

  // Lock the AI Worker to Lily (fall back to the first outbound-capable agent
  // if Lily isn't found), once. The picker is disabled in the UI.
  useEffect(() => {
    if (
      autoSelectedRef.current ||
      selectedAgentId ||
      loadingAgents ||
      !outboundReady
    )
      return;
    if (outboundAgents.length === 0) return;
    // Lock to the "Lily" agent. Match by stable id first (names have churned:
    // Ava ⇄ Lily Outbound), then by name, then fall back to the first agent.
    const LILY_AGENT_ID = 'k31pCNgXdYCW0wDs7vZY';
    const lily =
      outboundAgents.find((a) => a.id === LILY_AGENT_ID) ??
      outboundAgents.find((a) => a.name === 'Lily') ??
      outboundAgents[0];
    autoSelectedRef.current = true;
    setSelectedAgentId(lily.id);
  }, [loadingAgents, outboundReady, outboundAgents, selectedAgentId]);

  // When agent changes: pre-fill dealers_id + run the outbound-skill pre-flight
  useEffect(() => {
    if (!selectedAgentId) {
      setOutboundSkillOk(null);
      return;
    }
    setOutboundSkillOk(null);
    let cancelled = false;
    agentHasOutboundSkill(selectedAgentId)
      .then((ok) => {
        if (!cancelled) setOutboundSkillOk(ok);
      })
      .catch(() => {
        if (!cancelled) setOutboundSkillOk(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, allAgents]);

  const chatId = activeChatId;

  // Switch which run is open (and live-polled), resetting the view.
  const openRun = (id: string) => {
    if (id !== activeChatId) switchActive(id);
  };

  const fetchChat = async (chatIdToFetch: string) => {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/admin/monitoring/chat?chatId=${encodeURIComponent(chatIdToFetch)}`
      );
      if (res.ok) {
        const data = (await res.json()) as ChatData;
        setChatData(data);
        setLastRefreshed(Date.now());
        const stage = data.chatFields?.stage as string | undefined;
        if (stage && TERMINAL_STAGES.has(stage)) setStopped(true);
      }
    } catch (e) {
      console.error('[outbound-e2e] fetchChat error', e);
    } finally {
      setRefreshing(false);
    }
  };

  // Per-channel opt-out flags for the active chat, with an optimistic override so
  // the checkbox flips instantly. Source of truth is the chat-doc TOP-LEVEL
  // booleans (phone_opt_out / email_opt_out / sms_opt_out / block_phone); we also
  // OR the legacy memory strings ("Y") + the "email_opted_out" label for compat.
  const activeFields = (chatData?.chatFields ?? {}) as Record<string, any>;
  const activeMemory = (activeFields.memory ?? {}) as Record<string, any>;
  const activeLabels: string[] = Array.isArray(activeFields.labels)
    ? (activeFields.labels as string[])
    : [];
  const phoneOptedOut =
    optOptimistic.phone ??
    (activeFields.phone_opt_out === true ||
      activeFields.block_phone === true ||
      String(activeMemory.block_phone ?? '').toUpperCase() === 'Y' ||
      String(activeMemory.phone_opt_out ?? '').toUpperCase() === 'Y');
  const emailOptedOut =
    optOptimistic.email ??
    (activeFields.email_opt_out === true ||
      activeMemory._email_opt_out === true ||
      activeLabels.includes('email_opted_out'));

  const setOptOut = async (kind: 'phone' | 'email', value: boolean) => {
    if (!activeChatId) return;
    setOptOptimistic((prev) => ({ ...prev, [kind]: value }));
    try {
      const res = await fetch('/api/outbound/opt-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: activeChatId,
          ...(kind === 'phone'
            ? { phone_opt_out: value }
            : { email_opt_out: value }),
        }),
      });
      if (!res.ok) throw new Error('opt-out update failed');
      await fetchChat(activeChatId);
      setOptOptimistic((prev) => ({ ...prev, [kind]: undefined }));
    } catch (e) {
      console.error('[outbound-e2e] opt-out error', e);
      // Revert the optimistic flip on failure.
      setOptOptimistic((prev) => ({ ...prev, [kind]: undefined }));
    }
  };

  // Live polling of the resulting chat
  useEffect(() => {
    if (!chatId || stopped) return;
    if (pollStartedRef.current === null) pollStartedRef.current = Date.now();

    const tick = () => {
      if (
        pollStartedRef.current !== null &&
        Date.now() - pollStartedRef.current > POLL_MAX_MS
      ) {
        setStopped(true);
        return;
      }
      fetchChat(chatId);
    };
    tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
    // The source disables `react-hooks/exhaustive-deps` here — a deliberate dependency omission. This
    // repo's eslint config has no react-hooks plugin, so the directive errored as an unknown rule; kept as
    // prose so the intent survives if the plugin is ever added.
  }, [chatId, stopped]);

  const canFire =
    !!selectedAgentId &&
    !!company.trim() &&
    ((voiceEnabled && !!phone.trim()) || (emailEnabled && !!email.trim())) &&
    !firing;

  // Show skeletons until agents + the outbound-skill filter have resolved.
  const formLoading = loadingAgents || !outboundReady;

  // Patch a single step in the live fire-progress stack.
  const setStep = (id: FireStepId, patch: Partial<Omit<FireStep, 'id'>>) =>
    setFireSteps((prev) =>
      (prev ?? INITIAL_FIRE_STEPS).map((s) =>
        s.id === id ? { ...s, ...patch } : s
      )
    );

  const handleFire = async () => {
    if (!canFire) return;
    // Slide the drawer back immediately so the new run/chat is visible as it lands.
    setSetupOpen(false);
    // Remember the values used this run for the quick-fill dropdowns.
    rememberField('first_name', firstName);
    rememberField('last_name', lastName);
    rememberField('email', email);
    rememberField('phone', phone);
    rememberField('company', company);
    rememberField('zip', zipCode);
    // Save the full person so any single field can recall them next time.
    rememberProfile({ firstName, lastName, email, phone, company, zipCode });
    setFiring(true);
    setFireError(null);
    setFireSteps(INITIAL_FIRE_STEPS);
    setParkedCount(null);
    setChatData(null);
    setStopped(false);
    pollStartedRef.current = null;

    // A disabled (or empty) channel is sent as null so the backend skips it.
    const contact_information: Record<string, string | null> = {
      email: emailEnabled && email.trim() ? email.trim() : null,
      phone_number: voiceEnabled && phone.trim() ? phone.trim() : null,
    };
    if (firstName.trim()) contact_information.first_name = firstName.trim();
    if (lastName.trim()) contact_information.last_name = lastName.trim();

    const input_data: Record<string, string | boolean> = {
      agent_id: selectedAgentId,
    };
    if (company.trim()) input_data.company = company.trim();
    // Recommended: pass dealers_id + company_id from the selected agent (falls
    // back to the dealer filter / page company) so upstream isn't left null.
    const selectedAgent = allAgents.find((a) => a.id === selectedAgentId);
    const dealersId = selectedAgent?.dealers_id || selectedDealerId;
    if (dealersId) input_data.dealers_id = String(dealersId);
    const companyIdVal = selectedAgent?.company_id ?? companyId;
    if (companyIdVal) input_data.company_id = String(companyIdVal);
    // Optional prospect ZIP → the backend derives state + timezone from it
    // (split-state aware), overriding the phone area-code fallback. Blank = fall
    // back to the area code.
    if (zipCode.trim()) input_data.zip_code = zipCode.trim();
    extraFields.forEach(({ key, value }) => {
      if (key.trim()) input_data[key.trim()] = value;
    });
    // Runs fired from the E2E test page are ALWAYS tagged as test records (set
    // last so it can't be overridden by an advanced field). Maps to the HubSpot
    // record_type property (default "Real").
    input_data.record_type = 'Test';
    // Opt-out testing flags — enroll_contact reads these from input_data (same
    // place as record_type), NOT the lead top level.
    input_data.phone_opt_out = phoneOptOutTest;
    input_data.email_opt_out = emailOptOutTest;
    // HubSpot CRM gate — when unchecked, backend skips all contact/deal/stage
    // writes but still books the meeting and returns the meet link.
    input_data.skip_hubspot_crud = !hubspotSyncTest;

    try {
      // ── Step 1: delete the prior run's HubSpot Test contact/deal ──
      // MUST run before park — the by-chat delete resolves ids from the chat's
      // memory, which park deletes. Best-effort; never blocks the fire.
      setStep('cleanup', { status: 'running' });
      try {
        // Same deterministic chat ids park-chat targets (full phone digits +
        // lowercased email). The endpoint is Test-gated + idempotent, so unknown
        // or record-less candidates return harmlessly.
        const digits = voiceEnabled ? phone.replace(/\D/g, '') : '';
        const emailKey =
          emailEnabled && email.trim() ? email.trim().toLowerCase() : '';
        const candidateIds = [
          digits && `outbound__${selectedAgentId}__${digits}`,
          emailKey && `outbound__${selectedAgentId}__${emailKey}`,
        ].filter(Boolean) as string[];

        let contactDeleted = false;
        let dealDeleted = false;
        for (const chat_id of candidateIds) {
          try {
            const dres = await fetch('/api/outbound/hubspot/delete-records', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id, record_type: 'Test' }),
            });
            if (dres.ok) {
              const ddata = await dres.json();
              if (ddata?.contact_deleted) contactDeleted = true;
              if (ddata?.deal_deleted) dealDeleted = true;
            }
          } catch {
            /* per-candidate failure is non-fatal */
          }
        }
        const removed = [
          contactDeleted && 'contact',
          dealDeleted && 'deal',
        ].filter(Boolean) as string[];
        setStep('cleanup', {
          status: 'done',
          detail: removed.length
            ? `Removed test ${removed.join(' & ')}`
            : 'No prior records',
        });
      } catch (e) {
        console.warn(
          '[outbound-e2e] hubspot delete-records failed (non-fatal)',
          e
        );
        setStep('cleanup', {
          status: 'skipped',
          detail: 'Skipped (unavailable)',
        });
      }

      // ── Step 2: park (archive + delete) the existing chat ──
      // Best-effort — never blocks the fire.
      setStep('park', { status: 'running' });
      try {
        const pres = await fetch('/api/outbound/park-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: selectedAgentId,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
          }),
        });
        if (pres.ok) {
          const pdata = await pres.json();
          const n = pdata?.parked_count ?? 0;
          setParkedCount(n);
          setStep('park', {
            status: 'done',
            detail: n
              ? `Parked ${n} previous chat${n === 1 ? '' : 's'}`
              : 'Nothing to reset',
          });
        } else {
          setStep('park', { status: 'skipped', detail: 'Skipped' });
        }
      } catch (e) {
        console.warn('[outbound-e2e] park-chat failed (non-fatal)', e);
        setStep('park', { status: 'skipped', detail: 'Skipped' });
      }

      // ── Step 3: initiate the outbound flow (critical) ──
      setStep('initiate', { status: 'running' });
      const res = await fetch('/api/outbound/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads: [{ contact_information, input_data }] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFireError(data?.error || `Request failed (${res.status})`);
        setStep('initiate', { status: 'error', detail: 'Failed to start' });
        return;
      }
      const lead = data?.results?.[0];
      if (!lead || lead.success === false || !lead.chat_id) {
        setFireError(
          lead?.error || 'Outbound flow could not start for this lead.'
        );
        setStep('initiate', { status: 'error', detail: 'Failed to start' });
        return;
      }
      setStep('initiate', { status: 'done', detail: 'Chat created' });
      const run: FireResult = {
        chat_id: lead.chat_id,
        task_id: lead.task_id,
        channel_key: lead.channel_key,
        started_at: Date.now(),
        stage: 'New',
        name:
          [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') || null,
      };
      setRuns((prev) =>
        [...prev.filter((r) => r.chat_id !== run.chat_id), run].slice(-MAX_RUNS)
      );
      setActiveChatId(run.chat_id);
      // Run created → close the setup drawer so the conversation takes the canvas.
      setSetupOpen(false);
      // Re-firing the same prospect reuses the deterministic chat id, so
      // activeChatId may not change and the poll effect won't re-trigger — load
      // the freshly-created chat explicitly, keeping the skeleton up until it's in.
      pollStartedRef.current = null;
      await fetchChat(run.chat_id);
      // Re-fetch the runs rail so the just-parked (server-deleted) previous chat
      // for this prospect drops out immediately instead of lingering until the
      // next ~1-min auto-poll. Won't switch away from the new chat.
      void loadRuns(false);
    } catch (e: any) {
      setFireError(e?.message || 'Failed to reach the outbound service.');
      setStep('initiate', { status: 'error', detail: 'Failed to start' });
    } finally {
      setFiring(false);
    }
  };

  const currentStage =
    (chatData?.chatFields?.stage as string | undefined) ?? null;
  const allMessages = chatData?.messages ?? [];

  // Keep the conversation pinned to the newest message unless the user scrolled up.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = convScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [allMessages.length, activeChatId]);
  const activityTime = (a: Record<string, any>) =>
    new Date(a.timestamp || a.created_at || a.createdAt || 0).getTime();
  const activities = [...(chatData?.activities ?? [])].sort(
    (a, b) => activityTime(b) - activityTime(a)
  );
  const notes = chatData?.notifications ?? [];

  // Map call_id → review_call_transcript result (for the transcript popup) and
  // call_id → recording_url so the call bubble can play the recording inline.
  // The recording_url can be nested anywhere in a tool result (make_phone_call /
  // review_call_transcript), so deep-scan each activity rather than guessing a path.
  const transcriptByCallId: Record<string, any> = {};
  const recordingByCallId: Record<string, string> = {};
  const durationByCallId: Record<string, number> = {};
  for (const a of activities) {
    const tc = a.toolCall ?? a.tool_call ?? {};
    const tool = (tc.toolName ?? tc.tool_name ?? '').toLowerCase();
    const res = tc.result ?? tc.output ?? {};
    const cid =
      res?.call_id ??
      res?.callId ??
      deepFindString(a, ['call_id', 'callId', 'conversation_id']);
    if (!cid) continue;
    if (tool.includes('transcript')) transcriptByCallId[cid] = res;
    const url = deepFindString(a, [
      'recording_url',
      'recordingUrl',
      'audio_url',
      'audioUrl',
    ]);
    if (url && !recordingByCallId[cid]) recordingByCallId[cid] = url;
    const durSec =
      deepFindNumber(a, [
        'call_duration_secs',
        'duration_secs',
        'call_duration',
      ]) ?? deepFindNumber(a, ['duration']);
    if (durSec && !durationByCallId[cid]) durationByCallId[cid] = durSec;
  }

  // The chat is reused per prospect (deterministic id), so re-firing the test
  // piles up duplicate tasks of the same type. Keep the latest task per type —
  // this collapses re-fire duplicates but preserves a real multi-step sequence
  // (outreach / follow-up / confirm use distinct types).
  const dedupeByType = (list: ChatTask[]): ChatTask[] => {
    const byType: Record<string, ChatTask> = {};
    for (const t of list) {
      const key = t.type ?? '—';
      const ts = t.created_at ?? t.execute_at ?? '';
      const cur = byType[key];
      if (!cur || (cur.created_at ?? cur.execute_at ?? '') < ts)
        byType[key] = t;
    }
    return Object.values(byType);
  };

  // A task is "scheduled" only if it's an upcoming follow-up: not yet run, not
  // permanently failed, and its execute_at is in the future. Everything else
  // (done / failed / pending-but-not-scheduled) belongs in the Activities feed.
  const nowMs = Date.now();
  const isScheduled = (t: ChatTask) =>
    !t.executed &&
    !t.permanent_failure &&
    !!t.execute_at &&
    new Date(t.execute_at).getTime() > nowMs;

  const rawTasks = chatData?.tasks ?? [];
  // Scheduled: soonest-up first.
  const scheduledTasks: ChatTask[] = dedupeByType(
    rawTasks.filter(isScheduled)
  ).sort((a, b) => (a.execute_at ?? '').localeCompare(b.execute_at ?? ''));
  // The rest fold into Activities (rendered as task cards, status = done/failed/pending).
  const activityTasks: ChatTask[] = dedupeByType(
    rawTasks.filter((t) => !isScheduled(t))
  );

  // Unified Activities feed: tool-call activities + non-scheduled tasks, newest first.
  const taskTime = (t: ChatTask) =>
    new Date(t.execute_at ?? t.created_at ?? 0).getTime();
  type FeedItem =
    | { kind: 'activity'; ts: number; id: string; data: Record<string, any> }
    | { kind: 'task'; ts: number; id: string; data: ChatTask };
  const activityFeed: FeedItem[] = [
    ...activities.map((a) => ({
      kind: 'activity' as const,
      ts: activityTime(a),
      id: a.id as string,
      data: a,
    })),
    ...activityTasks.map((t) => ({
      kind: 'task' as const,
      ts: taskTime(t),
      id: t.id,
      data: t,
    })),
  ].sort((a, b) => b.ts - a.ts);

  return (
    <div className="relative flex h-svh flex-col overflow-hidden bg-[#fbfbfc] px-8 py-6">
      {/* Header */}
      <div className="mb-5 flex shrink-0 items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg shadow-slate-900/25">
            <Rocket className="size-6" />
          </div>
          <div>
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-gray-900">
              Outbound · E2E Test
            </h1>
            <p className="mt-1 text-[14px] text-gray-500">
              Fire the outbound flow for a test prospect, then watch the calls
              and emails land.
            </p>
          </div>
        </div>
        <button
          onClick={() => setSetupOpen(true)}
          className="flex shrink-0 cursor-pointer items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm shadow-slate-900/25 transition-colors hover:bg-slate-800"
        >
          <Rocket className="size-4" />
          New run
        </button>
      </div>

      {/* Edge handle to slide the setup drawer open (always available when closed) */}
      {!setupOpen && (
        <button
          onClick={() => setSetupOpen(true)}
          aria-label="Open setup"
          className="group absolute left-0 top-1/2 z-30 flex h-56 w-5 -translate-y-1/2 items-center justify-center rounded-r-xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg shadow-slate-900/30 ring-1 ring-inset ring-white/10 transition-all duration-200 hover:w-6 hover:from-slate-600 hover:to-slate-800"
        >
          <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </button>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        {/* ── Setup drawer (slides in from the left, overlays the results only —
            anchored to the page content area so the app sidebar stays visible) ── */}
        {setupOpen && (
          <div
            className="absolute inset-0 z-40 bg-black/40"
            onClick={() => setSetupOpen(false)}
          />
        )}
        <div
          className={cn(
            'absolute inset-y-0 left-0 z-50 w-full max-w-[460px] space-y-5 overflow-y-auto border-r border-gray-200 bg-[#fbfbfc] p-6 shadow-2xl transition-transform duration-300',
            setupOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-gray-900">New run</h2>
            <button
              onClick={() => setSetupOpen(false)}
              aria-label="Close setup"
              className="flex cursor-pointer items-center justify-center rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100"
            >
              <X className="size-4" />
            </button>
          </div>
          {formLoading ? (
            <FormSkeleton />
          ) : (
            <>
              {/* Agent */}
              <div className={sectionCard}>
                <div className="mb-4 flex items-center gap-2.5">
                  <div className="flex size-7 items-center justify-center rounded-lg bg-slate-100 text-slate-900">
                    <Bot className="size-3.5" />
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-gray-900">
                      Agent
                    </p>
                    <p className="text-[11px] text-gray-400">
                      The AI Worker that will run the outbound sequence.
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] text-gray-500">
                      AI Worker
                    </label>
                    {/* Locked to the Lily agent for the E2E flow — disabled so
                        it can't be switched, and the dealer filter is
                        intentionally omitted. */}
                    <SearchableSelect
                      value={selectedAgentId}
                      onChange={setSelectedAgentId}
                      disabled
                      placeholder={loadingAgents ? 'Loading…' : 'Lily'}
                      options={agentsForDealer.map((a) => ({
                        value: a.id,
                        label: a.name,
                      }))}
                    />
                  </div>
                </div>

                {selectedAgentId && outboundSkillOk === false && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <p className="text-[12px] leading-relaxed text-amber-700">
                      This agent has no outbound-typed skill. The outbound flow
                      may not behave as expected — you can still fire.
                    </p>
                  </div>
                )}
              </div>

              {/* Prospect */}
              <div className={sectionCard}>
                <div className="mb-4 flex items-center gap-2.5">
                  <div className="flex size-7 items-center justify-center rounded-lg bg-slate-100 text-slate-900">
                    <UserRound className="size-3.5" />
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-gray-900">
                      Test prospect
                    </p>
                    <p className="text-[11px] text-gray-400">
                      Email or phone required — calls first if a phone is
                      present.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                      First name
                    </label>
                    <input
                      value={firstName}
                      onChange={(e) => {
                        setFirstName(e.target.value);
                        applyProfileByField('firstName', e.target.value);
                      }}
                      onBlur={() => rememberField('first_name', firstName)}
                      list="dl-first_name"
                      className={inputCls}
                    />
                    <datalist id="dl-first_name">
                      {(fieldHistory.first_name ?? []).map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                      Last name
                    </label>
                    <input
                      value={lastName}
                      onChange={(e) => {
                        setLastName(e.target.value);
                        applyProfileByField('lastName', e.target.value);
                      }}
                      onBlur={() => rememberField('last_name', lastName)}
                      list="dl-last_name"
                      className={inputCls}
                    />
                    <datalist id="dl-last_name">
                      {(fieldHistory.last_name ?? []).map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                      Email{' '}
                      <span className="font-normal text-gray-400">
                        {phone.trim() ? '(optional)' : '(required)'}
                      </span>
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        applyProfileByField('email', e.target.value);
                      }}
                      onBlur={() => rememberField('email', email)}
                      placeholder="lead@acme.com"
                      list="dl-email"
                      className={cn(
                        inputCls,
                        !email.trim() && !phone.trim() && inputErrorCls
                      )}
                    />
                    <datalist id="dl-email">
                      {(fieldHistory.email ?? []).map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                      Phone{' '}
                      <span className="font-normal text-gray-400">
                        {email.trim() ? '(optional)' : '(required)'}
                      </span>
                    </label>
                    <input
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        applyProfileByField('phone', e.target.value);
                      }}
                      onBlur={() => rememberField('phone', phone)}
                      placeholder="+14155550123"
                      list="dl-phone"
                      className={cn(
                        inputCls,
                        !email.trim() && !phone.trim() && inputErrorCls
                      )}
                    />
                    <datalist id="dl-phone">
                      {(fieldHistory.phone ?? []).map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </div>
                </div>

                <div className="mt-3">
                  <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                    Company
                  </label>
                  <input
                    value={company}
                    onChange={(e) => {
                      setCompany(e.target.value);
                      applyProfileByField('company', e.target.value);
                    }}
                    onBlur={() => rememberField('company', company)}
                    placeholder="Acme Inc"
                    list="dl-company"
                    className={cn(inputCls, !company.trim() && inputErrorCls)}
                  />
                  <datalist id="dl-company">
                    {(fieldHistory.company ?? []).map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </div>

                {/* Optional ZIP — the backend derives the prospect's state +
                    timezone from it (split-state aware), fixing the voice date
                    line + business hours vs. the phone area-code fallback. */}
                <div className="mt-3">
                  <label
                    htmlFor="prospect-zip"
                    className="mb-1.5 block text-[13px] font-medium text-gray-700"
                  >
                    ZIP{' '}
                    <span className="font-normal text-gray-400">
                      (optional)
                    </span>
                  </label>
                  <input
                    id="prospect-zip"
                    inputMode="numeric"
                    value={zipCode}
                    onChange={(e) => setZipCode(e.target.value)}
                    onBlur={() => rememberField('zip', zipCode)}
                    placeholder="90210"
                    list="dl-zip"
                    className={inputCls}
                  />
                  <datalist id="dl-zip">
                    {(fieldHistory.zip ?? []).map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
                    Sets the prospect&apos;s timezone (voice date line +
                    business hours). Leave blank to use the phone area code.
                  </p>
                </div>

                {/* Outbound channels */}
                <div className="mt-4">
                  <p className="mb-2 text-[13px] font-medium text-gray-700">
                    Outbound channels
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <ChannelToggle
                      icon={<Phone className="size-3.5" />}
                      label="Voice call"
                      checked={voiceEnabled}
                      onChange={setVoiceEnabled}
                    />
                    <ChannelToggle
                      icon={<Mail className="size-3.5" />}
                      label="Email"
                      checked={emailEnabled}
                      onChange={setEmailEnabled}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-gray-400">
                    Unchecked channels are sent as{' '}
                    <span className="font-mono text-gray-500">null</span> so the
                    flow skips them.
                  </p>
                </div>

                {/* Opt-out (testing) — sent on initiate-outbound to exercise the
                    server-side opt-out gates. */}
                <div className="mt-4">
                  <p className="mb-2 text-[13px] font-medium text-gray-700">
                    Opt-out{' '}
                    <span className="text-[11px] font-normal text-gray-400">
                      (testing — skips tasks/sends for that channel)
                    </span>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] font-medium text-gray-700">
                      <input
                        type="checkbox"
                        checked={phoneOptOutTest}
                        onChange={(e) => setPhoneOptOutTest(e.target.checked)}
                        className="size-3.5 accent-slate-900"
                      />
                      <Phone className="size-3.5" /> Phone opt-out
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] font-medium text-gray-700">
                      <input
                        type="checkbox"
                        checked={emailOptOutTest}
                        onChange={(e) => setEmailOptOutTest(e.target.checked)}
                        className="size-3.5 accent-slate-900"
                      />
                      <Mail className="size-3.5" /> Email opt-out
                    </label>
                  </div>
                </div>

                {/* HubSpot CRM (testing) — when unchecked, initiate sends
                    skip_hubspot_crud=true so the backend defers all contact /
                    deal / stage writes; the meeting still books + returns a link. */}
                <div className="mt-4">
                  <p className="mb-2 text-[13px] font-medium text-gray-700">
                    HubSpot CRM{' '}
                    <span className="text-[11px] font-normal text-gray-400">
                      (testing)
                    </span>
                  </p>
                  <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] font-medium text-gray-700">
                    <input
                      type="checkbox"
                      checked={hubspotSyncTest}
                      onChange={(e) => setHubspotSyncTest(e.target.checked)}
                      className="size-3.5 accent-slate-900"
                    />
                    <Database className="size-3.5" /> Sync contact &amp; deal to
                    HubSpot
                  </label>
                  <p className="mt-1.5 text-[11px] font-normal text-gray-400">
                    Uncheck to block all HubSpot contact / deal / stage writes
                    for this prospect (HubSpot sync not allowed). The meeting
                    still books and the meet link is returned.
                  </p>
                </div>

                {/* Advanced */}
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((o) => !o)}
                  className="mt-4 flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-gray-500 transition-colors hover:text-gray-700"
                >
                  <ChevronDown
                    className={cn(
                      'size-3.5 transition-transform',
                      advancedOpen && 'rotate-180'
                    )}
                  />
                  Advanced (optional)
                </button>
                {advancedOpen && (
                  <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
                    <div>
                      <p className="mb-2 text-[13px] font-medium text-gray-700">
                        Prospect context{' '}
                        <span className="text-[11px] font-normal text-gray-400">
                          (optional — e.g. website-scraped text or PDF contents;
                          copied into chat memory)
                        </span>
                      </p>
                      <div className="space-y-3">
                        {extraFields.map((entry, i) => (
                          <div
                            key={i}
                            className="rounded-xl border border-gray-200 bg-gray-50/60 p-2.5"
                          >
                            <div className="flex gap-2">
                              <input
                                value={entry.key}
                                onChange={(e) =>
                                  setExtraFields((prev) =>
                                    prev.map((x, j) =>
                                      j === i
                                        ? { ...x, key: e.target.value }
                                        : x
                                    )
                                  )
                                }
                                placeholder="field name (e.g. website_text)"
                                className={inputCls + ' flex-1 bg-white'}
                              />
                              <button
                                type="button"
                                aria-label="Remove field"
                                onClick={() =>
                                  setExtraFields((prev) =>
                                    prev.filter((_, j) => j !== i)
                                  )
                                }
                                className="cursor-pointer rounded-xl border border-gray-200 bg-white px-2.5 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                            <textarea
                              value={entry.value}
                              onChange={(e) =>
                                setExtraFields((prev) =>
                                  prev.map((x, j) =>
                                    j === i
                                      ? { ...x, value: e.target.value }
                                      : x
                                  )
                                )
                              }
                              placeholder="value — paste scraped text, PDF text, notes…"
                              rows={3}
                              className="mt-2 w-full resize-y rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] text-gray-800 placeholder-gray-400 transition-colors focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10"
                            />
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setExtraFields((prev) => [
                            ...prev,
                            { key: '', value: '' },
                          ])
                        }
                        className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-xl border border-dashed border-gray-300 px-3.5 py-2 text-[13px] text-gray-500 transition-colors hover:border-slate-300 hover:bg-slate-100/40 hover:text-slate-900"
                      >
                        <Plus className="size-3.5" />
                        Add context
                      </button>
                    </div>
                  </div>
                )}

                {fireError && (
                  <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
                    <p className="text-[12px] leading-relaxed text-red-700">
                      {fireError}
                    </p>
                  </div>
                )}

                {fireSteps === null ? (
                  <button
                    onClick={handleFire}
                    disabled={!canFire}
                    className="mt-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-[13px] font-semibold text-white shadow-sm shadow-slate-900/25 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Rocket className="size-4" />
                    Fire outbound flow
                  </button>
                ) : (
                  <div className="mt-4 space-y-2">
                    {fireSteps.map((step) => (
                      <StepCard key={step.id} step={step} />
                    ))}
                    {!firing && (
                      <button
                        onClick={handleFire}
                        disabled={!canFire}
                        className="mt-1 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-2 text-[13px] font-semibold text-slate-900 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshCw className="size-3.5" />
                        Run again
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Results column ── */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden pr-1">
          {parkedCount !== null && parkedCount > 0 && (
            <div className="flex shrink-0 items-start gap-2.5 rounded-2xl border border-slate-200 bg-slate-100/60 px-4 py-3">
              <Archive className="mt-0.5 size-4 shrink-0 text-slate-700" />
              <div className="text-[12px] leading-relaxed text-slate-900">
                Parked {parkedCount} previous chat
                {parkedCount === 1 ? '' : 's'} for this prospect — archived and
                removed so this run starts fresh.{' '}
                <a
                  href={`/admin/outbound/parked-test-chats?companyId=${encodeURIComponent(
                    companyId
                  )}`}
                  className="font-medium underline hover:text-slate-950"
                >
                  View in Parked Test Chats
                </a>
              </div>
            </div>
          )}
          {firing || runsLoading || formLoading ? (
            <ResultsSkeleton />
          ) : runs.length === 0 ? (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
              <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-100 to-gray-50 ring-1 ring-inset ring-slate-200/60">
                <Rocket className="size-7 text-slate-300" />
              </div>
              <p className="text-[15px] font-semibold text-gray-700">
                No run yet
              </p>
              <p className="mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-gray-400">
                Fill in a test prospect and fire the flow. The resulting call
                and email will show up here.
              </p>
              <button
                onClick={() => setSetupOpen(true)}
                className="mt-5 flex cursor-pointer items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm shadow-slate-900/25 transition-colors hover:bg-slate-800"
              >
                <Rocket className="size-4" />
                Fire your first run
              </button>
            </div>
          ) : (
            (() => {
              const renderRun = (run: FireResult) => {
                const isActive = run.chat_id === activeChatId;
                return (
                  <div
                    key={run.chat_id}
                    className={cn(
                      'flex flex-col gap-3',
                      isActive ? 'min-h-0 flex-1' : 'shrink-0'
                    )}
                  >
                    {/* Run header (accordion) */}
                    <div
                      onClick={() => openRun(run.chat_id)}
                      className={cn(
                        sectionCard,
                        // Thin header (both active + collapsed) → more room for the
                        // conversation window and activities panel below.
                        'group shrink-0 !py-3',
                        isActive && 'ring-1 ring-inset ring-slate-200',
                        !isActive &&
                          '!p-3 cursor-pointer transition-colors hover:bg-gray-50'
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-100 to-gray-200 text-[12px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                            {(run.name || 'Outbound run')
                              .split(/\s+/)
                              .map((w) => w[0])
                              .filter(Boolean)
                              .slice(0, 2)
                              .join('')
                              .toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-[13px] font-semibold text-gray-900">
                                {run.name || 'Outbound run'}
                              </p>
                              {(() => {
                                const s = isActive
                                  ? (currentStage ?? run.stage)
                                  : run.stage;
                                return s ? (
                                  <span
                                    className={cn(
                                      'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                                      stageColor(s)
                                    )}
                                  >
                                    {s}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                              <span className="truncate">
                                {run.started_at
                                  ? new Date(run.started_at).toLocaleString()
                                  : ''}
                                <span className="font-mono">
                                  {' '}
                                  · {run.chat_id}
                                </span>
                              </span>
                              <button
                                type="button"
                                aria-label="Copy chat id"
                                title={
                                  copiedId === run.chat_id
                                    ? 'Copied'
                                    : 'Copy chat id'
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard
                                    ?.writeText(run.chat_id)
                                    .then(() => {
                                      setCopiedId(run.chat_id);
                                      setTimeout(
                                        () =>
                                          setCopiedId((prev) =>
                                            prev === run.chat_id ? null : prev
                                          ),
                                        1500
                                      );
                                    })
                                    .catch(() => {});
                                }}
                                className="shrink-0 cursor-pointer rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                              >
                                {copiedId === run.chat_id ? (
                                  <Check className="size-3 text-emerald-600" />
                                ) : (
                                  <Copy className="size-3" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                        {!isActive && (
                          <ChevronRight className="size-4 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-400" />
                        )}
                        {isActive && (
                          <div
                            className="flex shrink-0 items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-gray-700">
                              <input
                                type="checkbox"
                                checked={phoneOptedOut}
                                onChange={(e) =>
                                  setOptOut('phone', e.target.checked)
                                }
                                className="size-3.5 accent-slate-900"
                              />
                              Phone opt-out
                            </label>
                            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-gray-700">
                              <input
                                type="checkbox"
                                checked={emailOptedOut}
                                onChange={(e) =>
                                  setOptOut('email', e.target.checked)
                                }
                                className="size-3.5 accent-slate-900"
                              />
                              Email opt-out
                            </label>
                            <button
                              onClick={() => fetchChat(run.chat_id)}
                              aria-label="Refresh"
                              className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                            >
                              <RefreshCw
                                className={cn(
                                  'size-3.5',
                                  refreshing && 'animate-spin'
                                )}
                              />
                              Refresh
                            </button>
                          </div>
                        )}
                      </div>
                      {isActive && (
                        <p className="mt-2 text-[11px] text-gray-400">
                          {stopped
                            ? 'Auto-refresh stopped. Use Refresh to check again.'
                            : `Auto-refreshing every ${
                                POLL_INTERVAL_MS >= 60000
                                  ? `${POLL_INTERVAL_MS / 60000}m`
                                  : `${POLL_INTERVAL_MS / 1000}s`
                              }…`}
                          {lastRefreshed && (
                            <>
                              {' · '}updated{' '}
                              {new Date(lastRefreshed).toLocaleTimeString()}
                            </>
                          )}
                        </p>
                      )}
                    </div>

                    {isActive &&
                      (chatData ? (
                        <>
                          {/* Conversation (always visible) + detail accordions sidebar */}
                          <div className="flex min-h-0 flex-1 flex-col gap-5 xl:flex-row">
                            <div
                              className={cn(
                                sectionCard,
                                '!p-0 flex min-h-0 min-w-0 flex-1 flex-col'
                              )}
                            >
                              <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-100 px-5 py-3 text-[12px] font-semibold text-gray-700">
                                Conversation
                                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                                  {allMessages.length}
                                </span>
                              </div>
                              <div
                                ref={convScrollRef}
                                onScroll={(e) => {
                                  const el = e.currentTarget;
                                  stickToBottomRef.current =
                                    el.scrollHeight -
                                      el.scrollTop -
                                      el.clientHeight <
                                    80;
                                }}
                                className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5"
                              >
                                {allMessages.length === 0 ? (
                                  <p className="py-2 text-[12px] text-gray-400">
                                    No messages yet.
                                  </p>
                                ) : (
                                  allMessages.map((m) => (
                                    <MessageBubble
                                      key={m.id}
                                      m={m}
                                      transcript={
                                        m.type === 'call'
                                          ? transcriptByCallId[
                                              m.content?.callId ??
                                                m.content?.call_id ??
                                                ''
                                            ]
                                          : undefined
                                      }
                                      recordingUrl={
                                        m.type === 'call'
                                          ? recordingByCallId[
                                              m.content?.callId ??
                                                m.content?.call_id ??
                                                ''
                                            ]
                                          : undefined
                                      }
                                      durationHint={
                                        m.type === 'call'
                                          ? durationByCallId[
                                              m.content?.callId ??
                                                m.content?.call_id ??
                                                ''
                                            ]
                                          : undefined
                                      }
                                    />
                                  ))
                                )}
                              </div>
                              <AiComposer
                                chatId={activeChatId}
                                onSent={() => loadRuns(false)}
                              />
                            </div>

                            <div
                              className={cn(
                                sectionCard,
                                '!p-0 flex w-full shrink-0 flex-col overflow-hidden xl:min-h-0 xl:w-96'
                              )}
                            >
                              <AccordionSection
                                title="Stage"
                                open={activeSection === 'stage'}
                                onToggle={() => toggleSection('stage')}
                              >
                                <StageFunnel currentStage={currentStage} />
                              </AccordionSection>

                              <AccordionSection
                                title="Activities"
                                count={activityFeed.length}
                                open={activeSection === 'activities'}
                                onToggle={() => toggleSection('activities')}
                              >
                                {activityFeed.length === 0 ? (
                                  <p className="py-1 text-[12px] text-gray-400">
                                    No activities yet.
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    {activityFeed.map((item) =>
                                      item.kind === 'activity' ? (
                                        <ActivityCard
                                          key={`a-${item.id}`}
                                          activity={item.data}
                                          expanded={expandedActivities.has(
                                            item.id
                                          )}
                                          onToggle={() =>
                                            setExpandedActivities((prev) => {
                                              const next = new Set(prev);
                                              next.has(item.id)
                                                ? next.delete(item.id)
                                                : next.add(item.id);
                                              return next;
                                            })
                                          }
                                        />
                                      ) : (
                                        <TaskCard
                                          key={`t-${item.id}`}
                                          task={item.data}
                                          expanded={expandedTasks.has(item.id)}
                                          onToggle={() =>
                                            setExpandedTasks((prev) => {
                                              const next = new Set(prev);
                                              next.has(item.id)
                                                ? next.delete(item.id)
                                                : next.add(item.id);
                                              return next;
                                            })
                                          }
                                        />
                                      )
                                    )}
                                  </div>
                                )}
                              </AccordionSection>

                              <AccordionSection
                                title="Scheduled"
                                count={scheduledTasks.length}
                                open={activeSection === 'scheduled'}
                                onToggle={() => toggleSection('scheduled')}
                              >
                                {scheduledTasks.length === 0 ? (
                                  <p className="py-1 text-[12px] text-gray-400">
                                    No scheduled tasks yet.
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    {scheduledTasks.map((t) => (
                                      <TaskCard
                                        key={t.id}
                                        task={t}
                                        expanded={expandedTasks.has(t.id)}
                                        onToggle={() =>
                                          setExpandedTasks((prev) => {
                                            const next = new Set(prev);
                                            next.has(t.id)
                                              ? next.delete(t.id)
                                              : next.add(t.id);
                                            return next;
                                          })
                                        }
                                      />
                                    ))}
                                  </div>
                                )}
                              </AccordionSection>

                              <AccordionSection
                                title="Notes"
                                count={notes.length}
                                open={activeSection === 'notes'}
                                onToggle={() => toggleSection('notes')}
                              >
                                {notes.length === 0 ? (
                                  <p className="py-1 text-[12px] text-gray-400">
                                    No notes yet.
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    {notes.map((n) => {
                                      const ts =
                                        n.timestamp ||
                                        n.created_at ||
                                        n.createdAt;
                                      const text =
                                        n.body ||
                                        n.message ||
                                        n.text ||
                                        n.content;
                                      return (
                                        <div
                                          key={n.id}
                                          className="rounded-xl border border-gray-200 bg-gray-50 p-3"
                                        >
                                          <div className="flex items-center justify-between gap-2 text-[11px]">
                                            <span className="font-medium text-gray-700">
                                              {n.title || n.type || 'Note'}
                                            </span>
                                            <span className="shrink-0 text-gray-400">
                                              {ts
                                                ? new Date(ts).toLocaleString()
                                                : ''}
                                            </span>
                                          </div>
                                          {text && typeof text === 'string' && (
                                            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-gray-600">
                                              {text}
                                            </p>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </AccordionSection>
                            </div>
                          </div>
                        </>
                      ) : (
                        <ResultsSkeleton />
                      ))}
                  </div>
                );
              };
              const activeRun = runs.find((r) => r.chat_id === activeChatId);
              // Compact inbox-list card (left rail). Selected run is highlighted;
              // its conversation + activities render in the main pane on the right.
              const renderRunCard = (run: FireResult) => {
                const active = run.chat_id === activeChatId;
                const s = active ? (currentStage ?? run.stage) : run.stage;
                return (
                  <button
                    key={run.chat_id}
                    onClick={() => openRun(run.chat_id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors',
                      active
                        ? 'border-slate-200 bg-slate-100 ring-1 ring-inset ring-slate-900/5'
                        : 'cursor-pointer border-transparent hover:bg-gray-50'
                    )}
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-100 to-gray-200 text-[12px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                      {(run.name || 'Outbound run')
                        .split(/\s+/)
                        .map((w) => w[0])
                        .filter(Boolean)
                        .slice(0, 2)
                        .join('')
                        .toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13px] font-semibold text-gray-900">
                          {run.name || 'Outbound run'}
                        </p>
                        {s ? (
                          <span
                            className={cn(
                              'shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
                              stageColor(s)
                            )}
                          >
                            {s}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-gray-400">
                        {run.started_at
                          ? new Date(run.started_at).toLocaleString()
                          : ''}
                      </p>
                    </div>
                  </button>
                );
              };
              return (
                <div className="flex min-h-0 flex-1 gap-4">
                  {/* Left rail — "Runs" inbox sidebar: titled header + scrollable list */}
                  <aside className="flex w-64 shrink-0 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03),0_6px_20px_rgba(16,24,40,0.05)]">
                    <div className="shrink-0 border-b border-gray-100 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <h2 className="text-[13px] font-semibold text-gray-900">
                          Runs
                        </h2>
                        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                          {runs.length}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-gray-400">
                        Fired test prospects — open one to see its calls, emails
                        and other activity.
                      </p>
                    </div>
                    <div
                      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2"
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        if (
                          el.scrollTop + el.clientHeight >=
                            el.scrollHeight - 48 &&
                          visibleRuns < runs.length
                        ) {
                          setVisibleRuns((v) => Math.min(v + 10, runs.length));
                        }
                      }}
                    >
                      {runs
                        .slice()
                        .reverse()
                        .slice(0, visibleRuns)
                        .map(renderRunCard)}
                      {visibleRuns < runs.length && (
                        <p className="py-2 text-center text-[11px] text-gray-400">
                          Scroll for {runs.length - visibleRuns} more
                        </p>
                      )}
                    </div>
                  </aside>
                  {/* Selected run — conversation + activities */}
                  <div className="flex min-h-0 flex-1 flex-col">
                    {activeRun ? (
                      renderRun(activeRun)
                    ) : (
                      <div className="grid flex-1 place-items-center text-[13px] text-gray-400">
                        Select a run from the list
                      </div>
                    )}
                  </div>
                </div>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────────────────────────

const fmtTs = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

// One row in the live fire-sequence progress stack (replaces the Fire button).
function StepCard({ step }: { step: FireStep }) {
  const meta = FIRE_STEP_META[step.id];
  const Icon =
    step.id === 'cleanup' ? Eraser : step.id === 'park' ? Archive : Rocket;

  // Left icon tile — slate once the step is active/complete, muted while pending.
  const active = step.status === 'running' || step.status === 'done';
  const tileCls = cn(
    'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
    step.status === 'error'
      ? 'bg-red-50 text-red-500'
      : active
        ? 'bg-slate-100 text-slate-900'
        : 'bg-gray-100 text-gray-400'
  );

  // Right status indicator.
  const indicator = {
    pending: <Circle className="size-4 text-gray-300" />,
    running: <Loader2 className="size-4 animate-spin text-slate-700" />,
    done: <CheckCircle2 className="size-4 text-emerald-500" />,
    skipped: <MinusCircle className="size-4 text-gray-400" />,
    error: <AlertTriangle className="size-4 text-red-500" />,
  }[step.status];

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5 transition-colors duration-200',
        step.status === 'running'
          ? 'border-slate-200 bg-slate-100/30'
          : step.status === 'error'
            ? 'border-red-200'
            : 'border-gray-200'
      )}
    >
      <div className={tileCls}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-gray-800">
          {meta.title}
        </p>
        <p className="truncate text-[11px] text-gray-400">
          {step.detail ?? meta.hint}
        </p>
      </div>
      <div className="shrink-0">{indicator}</div>
    </div>
  );
}

// Compact relative time ("1 minute ago", "in 2 hours") for collapsed cards —
// the exact timestamps are shown when the card is expanded.
const fmtRelative = (s?: string | null): string => {
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

const isEmpty = (v: any) =>
  v == null ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) ||
  (Array.isArray(v) && v.length === 0) ||
  v === '';

// Expandable scheduled-task row: type + status, with created/execution times,
// instructions, and input/output payloads on expand.
const statusPill = (status?: string | null) => {
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

// Readable activity row: tool name + status + message, raw JSON behind a toggle.
function ActivityCard({
  activity,
  expanded,
  onToggle,
}: {
  activity: Record<string, any>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tc = activity.toolCall ?? activity.tool_call ?? {};
  const toolName =
    tc.toolName ?? tc.tool_name ?? activity.kind ?? activity.type ?? 'Activity';
  const status = tc.result?.status ?? tc.status ?? activity.status ?? null;
  const message = tc.result?.message ?? activity.message ?? null;
  const ts = activity.timestamp || activity.created_at || activity.createdAt;
  // `id` is destructured to EXCLUDE it from `rest`, which is rendered as a field list — dropping it would
  // print the document id as a field. This repo's rule config does not enable `ignoreRestSiblings`, so the
  // omit-by-destructure idiom has to be spelled out. Same as `chat-detail/ActivityCard`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, ...rest } = activity;

  // Collapsed preview: surface the 1-2 most important variables inline so key
  // values are visible without expanding. Pull scalar fields from the tool call's
  // args + result, drop the noise already shown elsewhere (status/message), and
  // rank meaningful keys first.
  const argsObj = tc.args ?? tc.arguments ?? tc.input ?? tc.parameters;
  const resultObj =
    tc.result && isPlainObject(tc.result) ? tc.result : undefined;
  const previewSource = {
    ...(isPlainObject(argsObj) ? argsObj : {}),
    ...(resultObj ?? {}),
  };
  const PREVIEW_SKIP = new Set([
    'status',
    'message',
    'ok',
    'success',
    'error',
    'result',
    'output',
  ]);
  const PREVIEW_PRIORITY = [
    'phone_number',
    'phone',
    'to',
    'email',
    'customer_email',
    'subject',
    'stage',
    'from_stage',
    'to_stage',
    'new_stage',
    'name',
    'task_type',
    'type',
    'execute_at',
    'scheduled_for',
    'contact_id',
    'deal_id',
    'call_id',
    'amount',
    'duration',
  ];
  const previewFields = Object.entries(previewSource)
    .filter(
      ([k, v]) =>
        !PREVIEW_SKIP.has(k.toLowerCase()) &&
        (typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean') &&
        String(v).trim() !== ''
    )
    .sort((a, b) => {
      const ia = PREVIEW_PRIORITY.indexOf(a[0].toLowerCase());
      const ib = PREVIEW_PRIORITY.indexOf(b[0].toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .slice(0, 2);
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/60">
      {/* Header (name + status + message) — click anywhere to expand/collapse */}
      <div
        onClick={onToggle}
        className="cursor-pointer transition-colors hover:bg-gray-50"
      >
        <div className="flex items-start justify-between gap-2 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all font-mono text-[12px] font-medium text-gray-800">
              {toolName}
            </span>
            {status && (
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                  statusPill(status)
                )}
              >
                {status}
              </span>
            )}
          </div>
          <span
            title={ts ? new Date(ts).toLocaleString() : ''}
            className="shrink-0 text-[10px] tabular-nums text-gray-400"
          >
            {fmtRelative(ts)}
          </span>
        </div>
        {message && (
          <p className="px-3.5 pb-2 text-[12px] leading-relaxed text-gray-600">
            {message}
          </p>
        )}
        {!expanded && previewFields.length > 0 && (
          <div className="space-y-0.5 px-3.5 pb-2.5">
            {previewFields.map(([k, v]) => (
              <p key={k} className="truncate text-[11px] leading-relaxed">
                <span className="text-gray-400">{humanize(k)}: </span>
                <span className="text-gray-600">{formatLeaf(v)}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 border-t border-gray-200 px-3.5 py-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-50"
      >
        <ChevronDown
          className={cn(
            'size-3 transition-transform',
            expanded && 'rotate-180'
          )}
        />
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && (
        <div className="border-t border-gray-200 bg-white p-2.5">
          <FieldList value={rest} />
        </div>
      )}
    </div>
  );
}

function isPlainObject(v: any): boolean {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isPrimitiveArray(v: any): boolean {
  return Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object');
}

function fieldEntries(data: any): [string, any][] {
  if (Array.isArray(data)) return data.map((v, i) => [String(i + 1), v]);
  if (isPlainObject(data)) return Object.entries(data);
  return [];
}

function formatLeaf(v: any): string {
  if (v == null) return String(v);
  if (isPrimitiveArray(v)) return (v as any[]).join(', ');
  if (typeof v === 'object') return Object.keys(v).length === 0 ? '{}' : '';
  return String(v);
}

// Recursively render an object as elegant, borderless key/value rows. Nested
// objects/arrays become a small group title with their children indented under a
// subtle left guide rail (so same-named leaves under different parents stay
// distinct without box-in-box clutter). Leaves are quiet label-over-value pairs.
function FieldTree({ data, depth = 0 }: { data: any; depth?: number }) {
  return (
    <div
      className={cn(
        'space-y-2.5',
        depth > 0 && 'ml-0.5 border-l border-gray-100 pl-3'
      )}
    >
      {fieldEntries(data).map(([k, v]) => {
        const isGroup =
          (isPlainObject(v) && Object.keys(v).length > 0) ||
          (Array.isArray(v) && !isPrimitiveArray(v) && v.length > 0);
        if (isGroup) {
          return (
            <div key={k} className="space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-600">
                {humanize(k)}
              </div>
              <FieldTree data={v} depth={depth + 1} />
            </div>
          );
        }
        return (
          <div key={k}>
            <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
              {humanize(k)}
            </div>
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-gray-700">
              {formatLeaf(v)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Readable key/value pairs instead of a JSON blob.
function FieldList({ value }: { value: any }) {
  if (fieldEntries(value).length === 0)
    return <p className="text-[12px] text-gray-400">—</p>;
  return <FieldTree data={value} />;
}

// Highlight any "@AI" mention inside a message body with a purple chip.
function highlightMentions(text: string): ReactNode {
  return text.split(/(@ai)/gi).map((part, i) =>
    /^@ai$/i.test(part) ? (
      <span
        key={i}
        className="rounded bg-purple-200 px-1 font-semibold text-purple-800"
      >
        {part}
      </span>
    ) : (
      part
    )
  );
}

// Render an email body nicely: the new reply on top, and the quoted reply-chain
// (the "On … wrote:" attribution + ">"-prefixed lines) collapsed behind a
// Gmail-style toggle, shown as a muted blockquote with the ">" markers stripped.
function EmailBody({ body }: { body: string }) {
  const lines = body.split('\n');
  // Quote starts at the attribution line ("On … wrote:") or the first ">" line.
  let idx = lines.findIndex((l) => /\bwrote:\s*$/i.test(l.trim()));
  if (idx === -1) idx = lines.findIndex((l) => /^\s*>/.test(l));
  const reply = (idx === -1 ? body : lines.slice(0, idx).join('\n')).trim();
  const quoted = idx === -1 ? '' : lines.slice(idx).join('\n').trim();
  return (
    <div className="mt-1 min-w-0 space-y-1.5">
      {reply && (
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[12px] leading-relaxed text-gray-700">
          {reply}
        </p>
      )}
      {quoted && <EmailQuote text={quoted} />}
    </div>
  );
}

function EmailQuote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clean = text
    .split('\n')
    .map((l) => l.replace(/^\s*>+\s?/, ''))
    .join('\n')
    .trim();
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 transition-colors hover:bg-gray-100"
      >
        <ChevronDown
          className={cn('size-3 transition-transform', open && 'rotate-180')}
        />
        {open ? 'Hide quoted text' : 'Show quoted text'}
      </button>
      {open && (
        <div className="mt-1.5 min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border-l-2 border-slate-300 bg-slate-100/80 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-500">
          {clean}
        </div>
      )}
    </div>
  );
}

function humanize(k: string): string {
  return k
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Format transcript turns as chat-like plain text ("Agent (0:03): …").
function formatTranscriptTurns(turns: any[]): string {
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
async function fetchTranscriptText(callId: string): Promise<string> {
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

// Inline, beautified call-recording player (play/pause + seek + time + download)
// — plays in the bubble. Click-to-play, metadata preloaded only.
function AudioPlayer({
  src,
  durationHint,
}: {
  src: string;
  durationHint?: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const probedRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [downloading, setDownloading] = useState(false);

  // Fetch the audio as a blob and save it. Falls back to opening the URL in a
  // new tab if the fetch is blocked (e.g. a cross-origin recording without CORS).
  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'call-recording.mp3';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      window.open(src, '_blank', 'noopener');
    } finally {
      setDownloading(false);
    }
  };
  // Streamed audio often reports Infinity/NaN duration until fully buffered, so
  // fall back to the known call duration (hint) for the bar + total display.
  const total =
    Number.isFinite(dur) && dur > 0
      ? dur
      : durationHint && durationHint > 0
        ? durationHint
        : 0;
  const hasTotal = total > 0;

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  const captureDur = (a: HTMLAudioElement): boolean => {
    if (Number.isFinite(a.duration) && a.duration > 0) {
      setDur(a.duration);
      return true;
    }
    return false;
  };

  // Streamed / blob mp3 (the ElevenLabs proxy) reports duration === Infinity
  // until fully scanned, so the bar and total never show. Force the browser to
  // read to the end once — it then fires `durationchange` with the real value —
  // and jump back to the start.
  const onLoadedMeta = (a: HTMLAudioElement) => {
    if (captureDur(a)) return;
    if (a.duration === Infinity && !probedRef.current) {
      probedRef.current = true;
      const onSeeked = () => {
        a.removeEventListener('seeked', onSeeked);
        a.currentTime = 0;
        setCur(0);
      };
      a.addEventListener('seeked', onSeeked);
      try {
        a.currentTime = 1e101;
      } catch {
        /* non-seekable — duration resolves once fully buffered instead */
      }
    }
  };

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-2.5 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-800"
      >
        {playing ? (
          <Pause className="size-3.5" />
        ) : (
          <Play className="size-3.5 translate-x-px" />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={hasTotal ? total : 0}
        value={hasTotal ? Math.min(cur, total) : 0}
        step="any"
        disabled={!hasTotal}
        onChange={(e) => {
          const a = ref.current;
          if (a) {
            const t = Number(e.target.value);
            a.currentTime = t;
            setCur(t);
          }
        }}
        aria-label="Seek recording"
        className="h-1 flex-1 cursor-pointer accent-slate-900 disabled:cursor-default"
      />
      <span className="shrink-0 text-[10px] tabular-nums text-gray-500">
        {mmss(cur)} / {hasTotal ? mmss(total) : '--:--'}
      </span>
      <button
        type="button"
        onClick={download}
        disabled={downloading}
        aria-label="Download recording"
        title="Download recording"
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
      >
        {downloading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
      </button>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => onLoadedMeta(e.currentTarget)}
        onDurationChange={(e) => captureDur(e.currentTarget)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onEnded={() => {
          setPlaying(false);
          setCur(0);
        }}
      />
    </div>
  );
}

// Popup with the call transcript: the live turn-by-turn conversation (fetched
// from /api/voice-workers/transcript by call_id) plus the structured
// review_call_transcript result (summary, confirmed fields, changes, quotes).
function CallTranscriptModal({
  transcript,
  recordingUrl,
  callId,
  onClose,
}: {
  transcript?: any;
  recordingUrl?: string;
  callId?: string;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<any[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsError, setTurnsError] = useState<string | null>(null);
  const [apiSummary, setApiSummary] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    setTurnsLoading(true);
    setTurnsError(null);
    fetch(`/api/voice-workers/transcript?call_id=${encodeURIComponent(callId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load the live transcript.');
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setTurns(Array.isArray(data?.transcript) ? data.transcript : []);
        setApiSummary(typeof data?.summary === 'string' ? data.summary : '');
      })
      .catch((e) => {
        if (!cancelled)
          setTurnsError(e?.message || 'Failed to load transcript.');
      })
      .finally(() => {
        if (!cancelled) setTurnsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const t = transcript || {};
  const summary = apiSummary || t.summary || t.transcript_summary || '';
  const messages = turns.filter((turn) => (turn?.message ?? '').trim());
  const confirmed =
    t.confirmed_in_this_call && typeof t.confirmed_in_this_call === 'object'
      ? Object.entries(t.confirmed_in_this_call)
      : [];
  const changes = Array.isArray(t.memory_changes) ? t.memory_changes : [];
  const quotes =
    t.quotes && typeof t.quotes === 'object' ? Object.entries(t.quotes) : [];
  const empty =
    !summary &&
    messages.length === 0 &&
    confirmed.length === 0 &&
    changes.length === 0 &&
    !recordingUrl;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Phone className="size-4 text-teal-600" />
            <h3 className="text-sm font-semibold text-gray-900">
              Call transcript
            </h3>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(formatTranscriptTurns(messages))
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => {});
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium',
                  copied
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                )}
              >
                {copied ? (
                  <>
                    <Check className="size-3.5 text-emerald-600" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" /> Copy
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="space-y-4 px-5 py-4 text-[12px] text-gray-700">
          {recordingUrl && (
            <a
              href={recordingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-slate-900 hover:text-slate-700"
            >
              ▶ Play recording
            </a>
          )}
          {summary && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Summary
              </div>
              <p className="whitespace-pre-wrap leading-relaxed">{summary}</p>
            </div>
          )}
          {callId && (
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Transcript
              </div>
              {turnsLoading ? (
                <div className="flex items-center gap-2 py-3 text-gray-400">
                  <RefreshCw className="size-3.5 animate-spin" /> Loading
                  transcript…
                </div>
              ) : turnsError ? (
                <p className="py-2 text-rose-600">{turnsError}</p>
              ) : messages.length === 0 ? (
                <p className="py-2 text-gray-400">
                  No transcript turns available for this call yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {messages.map((turn, i) => {
                    const isAgent = turn.role === 'agent';
                    return (
                      <div
                        key={i}
                        className={cn(
                          'max-w-[88%] rounded-xl px-3 py-1.5',
                          isAgent
                            ? 'mr-auto bg-gray-100 text-gray-700'
                            : 'ml-auto bg-slate-100 text-slate-900'
                        )}
                      >
                        <div className="mb-0.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
                          <span
                            className={
                              isAgent ? 'text-gray-500' : 'text-slate-900'
                            }
                          >
                            {isAgent ? 'Agent' : 'User'}
                          </span>
                          {turn.time_in_call_secs != null && (
                            <span className="text-gray-400">
                              {mmss(turn.time_in_call_secs)}
                            </span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {turn.message}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {confirmed.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Confirmed in this call
              </div>
              <div className="space-y-1">
                {confirmed.map(([k, val]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <span className="text-gray-400">{humanize(k)}</span>
                    <span className="text-right font-medium text-gray-700">
                      {String(val)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {changes.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Memory changes
              </div>
              <ul className="list-disc space-y-0.5 pl-4">
                {changes.map((c: any, i: number) => (
                  <li key={i}>{String(c)}</li>
                ))}
              </ul>
            </div>
          )}
          {quotes.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Quotes
              </div>
              <div className="space-y-1">
                {quotes.map(([k, val]) => (
                  <p key={k} className="italic">
                    “{String(val)}”{' '}
                    <span className="not-italic text-gray-400">
                      — {humanize(k)}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          )}
          {empty && (
            <p className="text-gray-400">
              No transcript details captured for this call.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact stage funnel for the sidebar (wraps in the narrow column).
function StageFunnel({ currentStage }: { currentStage: string | null }) {
  if (currentStage === 'Lost')
    return (
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-[11px] font-medium',
          stageColor('Lost')
        )}
      >
        Lost
      </span>
    );
  const currentIdx = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER.map((stage, i) => {
        const reached = currentIdx >= i;
        return (
          <span key={stage} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-[11px] text-gray-300">→</span>}
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                reached
                  ? stageColor(stage)
                  : 'border-gray-200 bg-white text-gray-400'
              )}
            >
              {stage}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// One accordion section inside the single detail sidebar card. Open sections
// share the sidebar height (flex-1) and scroll internally; closed ones collapse
// to just their header. Mirrors the Parked Test Chats detail panel.
function AccordionSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col', open && 'min-h-0 flex-1')}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full shrink-0 cursor-pointer items-center justify-between gap-2 border-b border-gray-200 px-4 py-2.5 text-left text-[13px] font-medium transition-colors',
          open
            ? 'bg-gray-50 text-gray-900'
            : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
        )}
      >
        <span className="flex items-center gap-2">
          <span>{title}</span>
          {count != null && count > 0 && (
            <span
              className={cn(
                'inline-flex min-w-4 items-center justify-center rounded px-1 py-0.5 text-[10px] font-semibold',
                open ? 'bg-slate-900 text-white' : 'bg-gray-100 text-gray-500'
              )}
            >
              {count}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-gray-400 transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      {/* Content — fills remaining space and scrolls internally */}
      {open && (
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      )}
    </div>
  );
}

// Highlight "@AI" in composer text. Keeps the SAME font weight/metrics so the
// transparent textarea on top stays pixel-aligned with this backdrop — only the
// background + text color change (no layout shift).
function highlightAiInput(text: string): ReactNode {
  if (!text) return null;
  return text.split(/(@ai)/gi).map((part, i) =>
    /^@ai$/i.test(part) ? (
      // Same purple chip as the conversation @AI mention. px-1 widens the
      // background like the bubble; -mx-1 cancels its layout effect so the
      // transparent textarea on top stays pixel-aligned.
      <span
        key={i}
        className="-mx-1 rounded bg-purple-200 px-1 text-purple-800"
      >
        {part}
      </span>
    ) : (
      part
    )
  );
}

// Composer pinned to the bottom of the conversation: send an "@AI …" trigger
// message into the active chat (prefix added server-side if omitted).
function AiComposer({
  chatId,
  onSent,
}: {
  chatId: string | null;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const history = useComposerHistory();

  const send = async () => {
    const msg = text.trim();
    if (!msg || !chatId || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/outbound/trigger-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message: msg }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed (${res.status})`);
        return;
      }
      history.record(msg);
      setText('');
      onSent();
    } catch (e: any) {
      setError(e?.message || 'Failed to send the trigger.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-gray-100 p-3">
      {error && <p className="mb-1.5 text-[11px] text-red-600">{error}</p>}
      <div className="flex items-end gap-2">
        <div className="relative min-h-[40px] flex-1">
          {/* Highlight overlay: shows typed text with @AI marked as an admin
              command. The textarea on top has transparent text so this shows
              through; box metrics are kept identical for exact alignment. */}
          <div
            ref={backdropRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 max-h-32 overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-transparent px-3.5 py-2.5 text-[13px] leading-5 text-gray-800"
          >
            {highlightAiInput(text)}
          </div>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              history.resetNav();
              // Auto-space a leading "@ai" trigger so the next word is separated
              // (anchored to the start so mid-text emails like x@ai.com are safe).
              setText(e.target.value.replace(/^(@ai)(?=\S)/i, '$1 '));
            }}
            onScroll={() => {
              if (backdropRef.current && taRef.current)
                backdropRef.current.scrollTop = taRef.current.scrollTop;
            }}
            onKeyDown={(e) => {
              // ArrowUp/Down recall previously sent messages (shell-style).
              if (history.onKeyDown(e, text, setText)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              chatId ? 'Send an @AI trigger message…' : 'No active chat'
            }
            disabled={!chatId || sending}
            className="relative max-h-32 min-h-[40px] w-full resize-none rounded-xl border border-gray-200 bg-transparent px-3.5 py-2.5 text-[13px] leading-5 text-transparent caret-gray-800 placeholder-gray-400 transition-colors focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10 disabled:bg-gray-50"
          />
        </div>
        <button
          type="button"
          onClick={send}
          disabled={!chatId || sending || !text.trim()}
          className="flex h-[40px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          Send
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-gray-400">
        Prefixed with <span className="font-mono text-gray-500">@AI</span>{' '}
        automatically · Enter to send, Shift+Enter for a new line.
      </p>
    </div>
  );
}

// Conversation message rendered as a channel-colored bubble.
function MessageBubble({
  m,
  transcript,
  recordingUrl: recordingUrlProp,
  durationHint,
}: {
  m: ChatMessage;
  transcript?: any;
  recordingUrl?: string;
  durationHint?: number;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [copiedTx, setCopiedTx] = useState(false);
  const isCall = m.type === 'call';
  const src = (m.source || '').toLowerCase();
  const dir = (m.direction || '').toLowerCase();
  const internal = dir === 'internal';
  const aiText = (m.content?.body || '').trim().toLowerCase();
  const isAi = isCall ? false : aiText.startsWith('@ai');
  const variant =
    isAi || (internal && src === 'virtuans')
      ? 'ai'
      : internal && src === 'web'
        ? 'system'
        : internal
          ? 'internal'
          : isCall
            ? 'call'
            : src === 'email'
              ? 'email'
              : src === 'sms'
                ? 'sms'
                : src === 'whatsapp'
                  ? 'whatsapp'
                  : 'message';
  const VARIANTS: Record<
    string,
    { bubble: string; label: string; name: string }
  > = {
    ai: {
      bubble: 'border-purple-200 bg-purple-50',
      label: 'text-purple-700',
      name: 'AI',
    },
    system: {
      bubble: 'border-amber-200 bg-amber-50',
      label: 'text-amber-700',
      name: 'System',
    },
    internal: {
      bubble: 'border-slate-200 bg-slate-100',
      label: 'text-slate-600',
      name: 'Internal',
    },
    call: {
      bubble: 'border-teal-200 bg-teal-50',
      label: 'text-teal-700',
      name: 'Call',
    },
    email: {
      bubble: 'border-blue-200 bg-blue-50',
      label: 'text-blue-700',
      name: 'Email',
    },
    sms: {
      bubble: 'border-green-200 bg-green-50',
      label: 'text-green-700',
      name: 'SMS',
    },
    whatsapp: {
      bubble: 'border-emerald-200 bg-emerald-50',
      label: 'text-emerald-700',
      name: 'WhatsApp',
    },
    message: {
      bubble: 'border-gray-200 bg-gray-50',
      label: 'text-gray-600',
      name: src ? src.charAt(0).toUpperCase() + src.slice(1) : 'Message',
    },
  };
  const v = VARIANTS[variant];
  const tone = v.bubble;
  const labelTone = v.label;
  const label = v.name;
  const align = internal
    ? 'w-full'
    : dir === 'outbound'
      ? 'ml-auto'
      : 'mr-auto';
  const subject = m.content?.subject;
  // While a call is still in progress the message carries an in-progress marker
  // (e.g. summary/outcome === 'in_progress') rather than a real summary — treat
  // those as "no summary yet" so we never render an in-progress call as done.
  const IN_PROGRESS_MARKERS = [
    'in_progress',
    'in progress',
    'queued',
    'ringing',
    'initiated',
    'dialing',
    'calling',
    'pending',
    'running',
    'started',
  ];
  // The call message itself rarely carries a summary; the real post-call
  // summary comes from the review_call_transcript result (passed as `transcript`).
  const rawCallSummary = isCall
    ? (
        m.content?.summary ||
        transcript?.summary ||
        transcript?.transcript_summary ||
        m.content?.outcome ||
        ''
      )
        .toString()
        .trim()
    : '';
  const realSummary =
    rawCallSummary &&
    !IN_PROGRESS_MARKERS.includes(rawCallSummary.toLowerCase())
      ? rawCallSummary
      : '';
  const body = isCall ? realSummary : m.content?.body || '';
  const duration =
    isCall && m.content?.duration != null
      ? formatDuration(m.content.duration)
      : '';
  const callId = isCall
    ? (m.content?.callId ?? m.content?.call_id ?? m.content?.conversation_id)
    : undefined;
  // An explicit recording url from the tool result / transcript (as opposed to
  // the by-call_id proxy fallback below, which resolves for ANY callId even
  // mid-call).
  const explicitRecording = isCall
    ? recordingUrlProp ||
      m.content?.recordingUrl ||
      m.content?.recording_url ||
      transcript?.recording_url ||
      transcript?.recordingUrl ||
      ''
    : '';
  // A call is only "ready" (show transcript / summary / recording) once its
  // post-call artifacts exist. While none are present it's still in progress —
  // we show a lightweight indicator instead of the completed-call UI.
  const hasTranscriptData =
    isCall &&
    (!!transcript ||
      !!m.content?.transcript_summary ||
      !!m.content?.confirmed_in_this_call);
  const callReady =
    isCall && (hasTranscriptData || !!explicitRecording || !!realSummary);
  const callInProgress = isCall && !callReady;
  // Recording lives in the tool result (make_phone_call), not the call message.
  // Prefer any explicit URL; otherwise stream the ElevenLabs conversation audio
  // by call_id via our proxy — so a completed call always has a play button.
  // Only used inside the callReady block, so an in-progress call never shows it.
  const recordingUrl = isCall
    ? explicitRecording ||
      (callId
        ? `/api/elevenlabs/conversations/${encodeURIComponent(callId)}/audio`
        : undefined)
    : undefined;
  return (
    <div
      className={cn(
        'max-w-[85%] rounded-2xl border px-3.5 py-2.5',
        tone,
        align
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-[10px] font-semibold uppercase tracking-wide',
            labelTone
          )}
        >
          {label}
          {dir && dir !== 'internal' ? ` · ${dir}` : ''}
          {m.status ? ` · ${m.status}` : ''}
          {duration ? ` · ${duration}` : ''}
        </span>
        <span className="shrink-0 text-[10px] text-gray-400">
          {m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}
        </span>
      </div>
      {subject && (
        <p className="mt-1 text-[12px] font-medium text-gray-800">{subject}</p>
      )}
      {body &&
        (src === 'email' ? (
          <EmailBody body={body} />
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700">
            {highlightMentions(body)}
          </p>
        ))}
      {callInProgress && (
        <div className="mt-2 flex items-center gap-2 text-[11px] font-medium text-teal-700/80">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-teal-500" />
          </span>
          Call in progress — transcript &amp; recording will appear once it
          completes
        </div>
      )}
      {callReady && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowTranscript(true)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-teal-300 bg-white px-2 py-1 text-[11px] font-semibold text-teal-700 transition-colors hover:bg-teal-100"
            >
              <FileText className="size-3" /> View transcript
            </button>
            {callId && (
              <button
                type="button"
                title="Copy transcript"
                onClick={async () => {
                  try {
                    const text = await fetchTranscriptText(callId);
                    await navigator.clipboard?.writeText(text);
                    setCopiedTx(true);
                    setTimeout(() => setCopiedTx(false), 1500);
                  } catch {
                    /* no transcript to copy */
                  }
                }}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium',
                  copiedTx
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                )}
              >
                {copiedTx ? (
                  <>
                    <Check className="size-3 text-emerald-600" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" /> Copy
                  </>
                )}
              </button>
            )}
          </div>
          {recordingUrl && (
            <AudioPlayer
              src={recordingUrl}
              durationHint={m.content?.duration ?? durationHint}
            />
          )}
        </div>
      )}
      {showTranscript && (
        <CallTranscriptModal
          transcript={transcript ?? m.content}
          recordingUrl={recordingUrl}
          callId={callId}
          onClose={() => setShowTranscript(false)}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  expanded,
  onToggle,
}: {
  task: ChatTask;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-gray-50"
      >
        <span className="flex min-w-0 items-start gap-2">
          <ChevronDown
            className={cn(
              'mt-0.5 size-3.5 shrink-0 text-gray-400 transition-transform',
              expanded && 'rotate-180'
            )}
          />
          <span className="break-all font-mono text-[12px] font-medium text-gray-800">
            {task.type ?? '—'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            title={fmtTs(task.created_at ?? task.execute_at)}
            className="hidden text-[11px] tabular-nums text-gray-400 sm:inline"
          >
            {fmtRelative(task.created_at ?? task.execute_at)}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              task.permanent_failure
                ? 'bg-red-100 text-red-700'
                : task.executed
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700'
            )}
          >
            {task.permanent_failure
              ? 'failed'
              : task.executed
                ? 'done'
                : 'pending'}
          </span>
        </span>
      </button>
      {/* Collapsed preview: surface the 1-2 most important variables at a glance
          (what it does + when it runs) without needing to expand. */}
      {!expanded &&
        (task.instructions || (!task.executed && task.execute_at)) && (
          <div
            onClick={onToggle}
            className="-mt-1 cursor-pointer space-y-0.5 px-3.5 pb-2.5"
          >
            {task.instructions && (
              <p className="line-clamp-2 text-[12px] leading-relaxed text-gray-600">
                {task.instructions}
              </p>
            )}
            {!task.executed && task.execute_at && (
              <p
                title={fmtTs(task.execute_at)}
                className="text-[11px] text-gray-400"
              >
                Executes {fmtRelative(task.execute_at)}
              </p>
            )}
          </div>
        )}
      {expanded && (
        <div className="space-y-3 border-t border-gray-200 bg-white px-3.5 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Created
              </p>
              <p className="mt-0.5 text-[12px] tabular-nums text-gray-700">
                {fmtTs(task.created_at)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Executes
              </p>
              <p className="mt-0.5 text-[12px] tabular-nums text-gray-700">
                {fmtTs(task.execute_at)}
              </p>
            </div>
          </div>
          {task.instructions && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Instructions
              </p>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700">
                {task.instructions}
              </p>
            </div>
          )}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Input
            </p>
            <FieldList value={task.taskData} />
          </div>
          {/* The backend doesn't write an output on outbound tasks — the call/
              email result lands in Messages/Activities — so only show Output
              when it's actually present. */}
          {!isEmpty(task.output) && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Output
              </p>
              <FieldList value={task.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Checkbox styled as a selectable channel chip.
function ChannelToggle({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors',
        checked
          ? 'border-slate-300 bg-slate-100/60'
          : 'border-gray-200 bg-white hover:border-gray-300'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-slate-900"
      />
      <span
        className={cn(
          'flex items-center gap-1.5 text-[13px] font-medium',
          checked ? 'text-slate-900' : 'text-gray-500'
        )}
      >
        {icon}
        {label}
      </span>
    </label>
  );
}

// Loading placeholder for the form column — mirrors the Agent + Prospect cards.
// Loading placeholder for the active run's results (stage + call + email).
// Mirrors the live layout (conversation + accordion sidebar) so the shell holds
// steady while a new chat is being created / loaded.
function ResultsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 xl:flex-row">
      {/* Conversation */}
      <div
        className={cn(sectionCard, '!p-0 flex min-h-0 min-w-0 flex-1 flex-col')}
      >
        <div className="shrink-0 border-b border-gray-100 px-5 py-3">
          <div className="h-3 w-28 animate-pulse rounded bg-gray-200" />
        </div>
        <div className="min-h-0 flex-1 space-y-3 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className={cn(
                'max-w-[75%] space-y-2 rounded-2xl border border-gray-100 bg-gray-50/40 p-3',
                i % 2 === 1 && 'ml-auto'
              )}
            >
              <div className="h-2.5 w-20 animate-pulse rounded bg-gray-200" />
              <div className="h-3 w-full animate-pulse rounded bg-gray-100" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-gray-100" />
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-gray-100 p-3">
          <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
        </div>
      </div>
      {/* Detail sidebar */}
      <div
        className={cn(
          sectionCard,
          '!p-0 w-full shrink-0 overflow-hidden xl:w-96'
        )}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5"
          >
            <div className="h-3 w-20 animate-pulse rounded bg-gray-200" />
            <div className="size-4 animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <>
      <div className={sectionCard}>
        <div className="mb-4 flex items-center gap-2.5">
          <div className="size-7 animate-pulse rounded-lg bg-gray-200" />
          <div className="space-y-1.5">
            <div className="h-3 w-24 animate-pulse rounded bg-gray-200" />
            <div className="h-2.5 w-44 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
        <div className="space-y-3">
          <div className="h-[42px] w-full animate-pulse rounded-xl bg-gray-100" />
          <div className="h-[42px] w-full animate-pulse rounded-xl bg-gray-100" />
        </div>
      </div>
      <div className={sectionCard}>
        <div className="mb-4 flex items-center gap-2.5">
          <div className="size-7 animate-pulse rounded-lg bg-gray-200" />
          <div className="space-y-1.5">
            <div className="h-3 w-28 animate-pulse rounded bg-gray-200" />
            <div className="h-2.5 w-48 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-[42px] animate-pulse rounded-xl bg-gray-100"
            />
          ))}
        </div>
        <div className="mt-4 h-[46px] w-full animate-pulse rounded-xl bg-gray-100" />
      </div>
    </>
  );
}

function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setSearch('');
        }}
        className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-left text-[13px] text-gray-800 transition-colors hover:border-gray-300 focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10 disabled:opacity-50"
      >
        <span className={selected ? 'text-gray-800' : 'text-gray-400'}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 p-2">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[12px] text-gray-800 placeholder-gray-400 focus:border-slate-400 focus:outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-gray-400">No results.</p>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'w-full cursor-pointer px-3 py-2 text-left text-[12px] hover:bg-gray-50',
                    o.value === value
                      ? 'font-medium text-slate-900'
                      : 'text-gray-800'
                  )}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
