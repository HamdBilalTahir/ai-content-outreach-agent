import {
  Circle,
  CalendarCheck,
  GitBranch,
  Mail,
  MailOpen,
  MessageSquare,
  MousePointerClick,
  PhoneIncoming,
  PhoneOutgoing,
  Reply,
  Star,
  StickyNote,
  UserPlus,
  FileCheck,
  type LucideIcon,
} from 'lucide-react';

// One touchpoint on a deal's attribution timeline. Shape is source-agnostic so
// the Phase-1 Firestore derivation and the Phase-2 backend deal-timeline endpoint
// produce the same events. `at` is an ISO string; events render ascending by `at`.
export interface TimelineEvent {
  at: string;
  source: 'ai' | 'hubspot' | 'syc';
  channel:
    | 'email'
    | 'call'
    | 'sms'
    | 'meeting'
    | 'note'
    | 'stage'
    | 'deal'
    | 'certificate';
  direction?: 'in' | 'out' | null;
  type: string;
  title: string;
  status?: string | null;
  meta?: Record<string, any>;
}

// Visual mapping per event type: dot colour (hex, for inline style) + lucide icon.
// Colour + icon + label together — never colour alone.
export const EVENT_STYLE: Record<string, { color: string; icon: LucideIcon }> =
  {
    chat_created: { color: '#0f172a', icon: UserPlus },
    deal_created: { color: '#334155', icon: UserPlus },
    ai_call: { color: '#0d9488', icon: PhoneOutgoing },
    customer_call: { color: '#0f766e', icon: PhoneIncoming },
    ai_sms: { color: '#0284c7', icon: MessageSquare },
    customer_sms: { color: '#0369a1', icon: MessageSquare },
    email_sent: { color: '#7c3aed', icon: Mail },
    email_opened: { color: '#d97706', icon: MailOpen },
    email_clicked: { color: '#ea580c', icon: MousePointerClick },
    email_reply: { color: '#16a34a', icon: Reply },
    meeting: { color: '#4f46e5', icon: CalendarCheck },
    note: { color: '#64748b', icon: StickyNote },
    stage_change: { color: '#9333ea', icon: GitBranch },
    certificate: { color: '#2563eb', icon: FileCheck },
    acquired: { color: '#059669', icon: Star },
  };

export function eventStyle(type: string) {
  return EVENT_STYLE[type] ?? { color: '#94a3b8', icon: Circle };
}

// Fallback label when an event has no title (e.g. the backend returns null for
// some types). Keeps the rail readable without depending on backend copy.
const TYPE_LABEL: Record<string, string> = {
  chat_created: 'Enrolled',
  deal_created: 'Deal created',
  ai_call: 'AI call',
  customer_call: 'Inbound call',
  ai_sms: 'AI SMS',
  customer_sms: 'Customer SMS',
  email_sent: 'Email sent',
  email_opened: 'Email opened',
  email_clicked: 'Email clicked',
  email_reply: 'Email reply',
  meeting: 'Meeting',
  note: 'Note',
  stage_change: 'Stage change',
  certificate: 'Certificate',
  acquired: 'Acquired',
};

export function eventTitle(e: TimelineEvent): string {
  // The win dot always reads "Acquired"; the raw HubSpot stage (e.g. "Active")
  // is surfaced as its meta detail instead, so it isn't mistaken for the label.
  if (e.type === 'acquired') return 'Acquired';
  const t = (e.title ?? '').trim();
  if (t && t.toLowerCase() !== 'none') return t;
  return TYPE_LABEL[e.type] ?? 'Touchpoint';
}

// The raw HubSpot stage behind an "acquired" event (from meta.stage or the
// backend's title), shown as a detail so "Active" is explained, not the headline.
export function acquiredStage(e: TimelineEvent): string | null {
  const s = e.meta?.stage ?? e.title;
  if (!s) return null;
  const str = String(s).trim();
  return str && str.toLowerCase() !== 'acquired' ? str : null;
}

// Only successful AI outreach belongs on the attribution timeline — a failed
// call or a bounced email isn't a real touchpoint. This gates AI call/email/sms
// events only; HubSpot events (deal created, stage change, notes), the win
// marker, and inbound replies/calls are always kept.
//   - Call: successful = outcome 'completed' (a call that actually finished).
//     'blocked' / 'in_progress' / no-answer / missing are dropped.
//   - Email/SMS: dropped only on a known failure status (bounce/undelivered/…);
//     'sent'/'delivered' and unknown/legacy statuses are kept.
const FAILED_MESSAGE_STATUS = new Set([
  'failed',
  'undelivered',
  'undeliverable',
  'not_delivered',
  'bounce',
  'bounced',
  'rejected',
  'error',
  'dropped',
  'spam',
]);

export function isSuccessfulTouchpoint(e: TimelineEvent): boolean {
  if (e.source !== 'ai') return true; // HubSpot deal/stage/note + win marker
  if (e.direction === 'in') return true; // an inbound reply/call is a real contact
  const status = String(e.status ?? '')
    .trim()
    .toLowerCase();
  if (e.channel === 'call') {
    const outcome = String(e.meta?.outcome ?? '')
      .trim()
      .toLowerCase();
    return outcome === 'completed' || status === 'completed';
  }
  if (e.channel === 'email' || e.channel === 'sms') {
    return !FAILED_MESSAGE_STATUS.has(status);
  }
  return true; // ai stage-sync and other non call/email channels
}

const toIso = (v: any): string | null => {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
};

const snippet = (v: any, n = 60): string => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Phase-1 derivation: build the timeline from what Firestore already has —
// conversation touchpoints (messages_v3) + tool activities (conversion, stage
// sync, meetings, email replies). The Phase-2 endpoint replaces this with the
// full HubSpot-merged event list.
export function deriveEventsFromChat(
  chat: Record<string, any>,
  messages: Record<string, any>[],
  activities: Record<string, any>[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  const createdAt = toIso(chat.createdAt ?? chat.created_at);
  if (createdAt) {
    events.push({
      at: createdAt,
      source: 'ai',
      channel: 'deal',
      type: 'chat_created',
      title: 'Prospect enrolled',
    });
  }

  // Conversation touchpoints from messages_v3.
  for (const m of messages) {
    const at = toIso(m.timestamp ?? m.created_at ?? m.createdAt);
    if (!at) continue;
    const dir =
      m.direction === 'in' || m.sender?.kind === 'customer' ? 'in' : 'out';
    if (m.direction === 'internal') continue; // admin note, not a touchpoint
    const src = String(m.source ?? m.type ?? '').toLowerCase();
    const content = m.content;
    if (m.type === 'call' || src === 'call') {
      const outcome =
        content?.outcome ?? content?.summary ?? m.status ?? 'Call';
      events.push({
        at,
        source: 'ai',
        channel: 'call',
        direction: dir,
        type: dir === 'in' ? 'customer_call' : 'ai_call',
        title: dir === 'in' ? 'Inbound call' : 'AI call',
        status: m.status ?? null,
        meta: { outcome: snippet(outcome), duration: content?.duration },
      });
    } else if (src === 'sms') {
      events.push({
        at,
        source: 'ai',
        channel: 'sms',
        direction: dir,
        type: dir === 'in' ? 'customer_sms' : 'ai_sms',
        title: dir === 'in' ? 'Customer SMS' : 'AI SMS',
        meta: { text: snippet(content?.text ?? content) },
      });
    } else if (src === 'email') {
      events.push({
        at,
        source: 'ai',
        channel: 'email',
        direction: dir,
        type: dir === 'in' ? 'email_reply' : 'email_sent',
        title: dir === 'in' ? 'Email reply' : 'Email sent',
        meta: {
          subject: snippet(content?.subject ?? content?.text ?? content),
        },
      });
    }
  }

  // Deal / stage / meeting events from tool activities.
  for (const a of activities) {
    const tc = a.toolCall ?? a.tool_call ?? {};
    const name = String(
      tc.toolName ?? tc.tool_name ?? a.kind ?? ''
    ).toLowerCase();
    const at = toIso(a.timestamp ?? a.created_at ?? a.createdAt);
    if (!at) continue;
    const input = tc.input ?? tc.args ?? tc.arguments ?? {};
    if (name === 'prospect_converted_to_deal') {
      events.push({
        at,
        source: 'ai',
        channel: 'deal',
        type: 'acquired',
        title: `Converted — ${input.stage ?? 'deal'}`,
        status: 'success',
        meta: {
          stage: input.stage,
          deal_id: input.deal_id,
          amount: input.amount,
        },
      });
    } else if (name === 'hubspot_stage_synced') {
      events.push({
        at,
        source: 'hubspot',
        channel: 'stage',
        type: 'stage_change',
        title: `Stage → ${input.to_stage ?? input.hubspot_stage ?? 'updated'}`,
        meta: { from: input.from_stage, to: input.to_stage },
      });
    } else if (name === 'schedule_hubspot_meeting') {
      events.push({
        at,
        source: 'hubspot',
        channel: 'meeting',
        type: 'meeting',
        title: 'Meeting scheduled',
        status: tc.result?.status ?? null,
      });
    } else if (name === 'email_reply_received') {
      events.push({
        at,
        source: 'ai',
        channel: 'email',
        direction: 'in',
        type: 'email_reply',
        title: 'Email reply',
      });
    }
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}
