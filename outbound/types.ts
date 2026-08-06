/**
 * Shared types for the outbound flow.
 *
 * These describe the Firestore documents the flow reads and writes. **Field names are snake_case
 * on purpose** — they are the stored data contract, ported verbatim from the source, and drifting
 * them would silently break every gate that reads them (`execute_at`, `phone_opt_out`,
 * `outreach_lane`, `permanent_failure`, …).
 *
 * Most shapes are deliberately open (`[k: string]: unknown`): the source treats `memory` and
 * `task_data` as free-form bags that many independent writers extend, and pinning them to a closed
 * type would reject data the flow legitimately stores. The named fields are the ones the logic
 * actually branches on.
 */

import type { FirestoreTimestamp } from './firebase/db';

/** A datetime as it may appear coming out of Firestore or going in. */
export type FirestoreDate = Date | FirestoreTimestamp | null | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Chat
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle status on the chat doc. `null`/absent is treated as `active` by the cron query. */
export type ChatStatus = 'active' | 'paused' | 'archived' | null;

/** The single mutually-exclusive outreach lane resolved at enrollment. */
export type OutreachLane = 'phone' | 'email';

/** Test records bypass business hours and jump the cron queue; Real records do not. */
export type RecordType = 'Real' | 'Test';

/**
 * `chats/{chatId}.memory` — the free-form prospect/context bag.
 *
 * Underscore-prefixed keys are code-owned internal markers (the enrollment loop explicitly skips
 * copying `_`-prefixed input fields into memory, so they cannot be spoofed from a webhook payload).
 */
export interface ChatMemory {
  customer_email?: string;
  email?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  agent_id?: string;
  sales_agent_name?: string;
  record_type?: string;
  timezone?: string;
  state?: string;
  /** `null` when a chat was created outside a campaign — the referral fork writes it explicitly. */
  campaign_id?: string | null;
  dealers_id?: string;
  hubspot_contact_id?: string;
  meeting_host?: string;
  business_only?: boolean;

  /** Consent/opt-out. Phone and SMS use the string `"Y"`; email uses a boolean. */
  phone_opt_out?: string | boolean;
  sms_opt_out?: string | boolean;
  block_phone?: string | boolean;
  _email_opt_out?: boolean;
  _email_invalid?: boolean;

  /** Internal state markers. */
  _ob_state?: string;
  _outreach_lane?: OutreachLane;
  _email_fallback_available?: boolean;
  _no_reachable_channel?: boolean;
  _phone_optout_reason?: string;
  _not_interested?: boolean;
  _not_interested_at?: string;
  _not_interested_reason?: string;
  _not_interested_source?: string;

  /** Cadence counters. */
  email_followup_count?: number;
  call_followup_count?: number;

  /** SMS handoff / sub-agent linkage. */
  is_sms_agent?: boolean;
  parent_chat_id?: string;
  sms_handoff_active?: boolean;

  [k: string]: unknown;
}

/** `chats/{chatId}` — the conversation root. */
export interface ChatDoc {
  id?: string;
  /** `"outbound"` selects this chat into the outbound cron; anything else is ignored by it. */
  type?: string;
  agentId?: string;
  status?: ChatStatus;
  archived?: boolean;
  archive_reason?: string | null;
  status_changed_at?: string;
  paused_at?: string | null;
  paused_by?: string | null;

  /** Code-owned, trustworthy gate flags. The gates read these, not `memory`. */
  labels?: string[];
  record_type?: string;
  campaign_id?: string;
  outreach_lane?: OutreachLane;
  email_fallback_available?: boolean;
  phone_opt_out?: boolean;
  email_opt_out?: boolean;
  sms_opt_out?: boolean;
  email_invalid?: boolean;
  cadence_complete?: boolean;

  caller_type?: string;
  caller_type_checked_at?: FirestoreDate;

  memory?: ChatMemory;
  updatedAt?: FirestoreDate;

  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proactive-outreach task types — the "next proactive touch" family.
 * INVARIANT: a chat has AT MOST ONE of these pending at any time (0 or 1).
 * Reminders, `book_meeting`, `check_if_call_succeeded` and `call_completion_continuation` are
 * deliberately excluded — they are operational/transactional, not a proactive touch, and a booked
 * chat legitimately has several reminders pending.
 */
export const PROACTIVE_TASK_TYPES = [
  'outbound_outreach',
  'followup',
  'followup_if_no_reply',
  'call_followup',
  'callback',
] as const;

export type ProactiveTaskType = (typeof PROACTIVE_TASK_TYPES)[number];

/**
 * Task types whose sole purpose is to CONTACT the prospect. The cron's business-hours pre-gate
 * defers these at the task level (reschedule, no LLM turn) when outside the prospect's window.
 * Review / continuation / watchdog / booking tasks are intentionally absent — they process results
 * without contacting anyone and may run at any time.
 */
export const OUTREACH_TASK_TYPES = [
  'outbound_outreach',
  'outbound_sms',
  'followup_if_no_reply',
  'call_followup',
  'callback',
] as const;

/** `chats/{chatId}/tasks/{taskId}` — a scheduled unit of work for the cron. */
export interface TaskDoc {
  id?: string;
  type?: string;
  task_type?: string;
  execute_at?: FirestoreDate;

  /**
   * The at-most-once dispatch marker. Set to `true` inside a transaction AT DISPATCH — before the
   * turn runs, not after — which is what stops the same task re-dispatching on every overlapping
   * tick during its 15-45s run. There is no lease: this flag alone is the marker.
   */
  executed?: boolean;
  dispatched_at?: FirestoreDate;

  /** Terminal states. A task in either is never claimable again. */
  skipped?: boolean;
  skip_reason?: string;
  permanent_failure?: boolean;

  failure_count?: number;
  failure_reason?: string;

  /** Channel tag, used for per-channel enforcement on dual (test) chats. */
  channel?: OutreachLane;
  /** A human `@ai` trigger set an explicit time — honor it even outside business hours. */
  admin_override?: boolean;

  agent_id?: string;
  campaign_id?: string;
  notes?: string;
  data?: Record<string, unknown>;

  [k: string]: unknown;
}

/** The row shape the cron's due-task fetch hands to the runner. */
export interface DueTask {
  task_id: string;
  chat_id: string;
  agent_id: string;
  chat_type?: string;
  record_type?: string;
  task_data: TaskDoc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaigns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `outbound_campaigns/{id}.status` state machine. `pausing`/`resuming` are transient: the cron
 * cascades the change across the campaign's chats in bounded batches, then settles the status.
 */
export type CampaignStatus =
  | 'enrolling'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopped'
  | 'archived'
  | 'done';

export interface CampaignDoc {
  id?: string;
  name?: string;
  agent_id?: string;
  record_type?: string;
  status?: CampaignStatus;
  per_day?: number;
  audience?: Record<string, unknown>;
  exclude_contacted?: boolean;
  enrolled?: number;
  cursor?: unknown;
  archive_cursor?: unknown;
  pause_cursor?: unknown;
  resume_cursor?: unknown;
  stalled_cursor?: unknown;
  started_at?: string;
  stopped_at?: string;
  start_ms?: number;

  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM — Bedrock Converse wire format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The message format every provider adapter converts to and from. Bedrock Converse is the
 * canonical shape in the source: Groq and Anthropic payloads are translated in and their responses
 * translated back, so the persistence layer and the tool loop only ever see this.
 */
export interface BedrockToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BedrockToolResult {
  toolUseId: string;
  content: Array<{ json?: unknown; text?: string } | Record<string, unknown>>;
  status?: 'success' | 'error';
}

export type BedrockContentBlock =
  | { text: string }
  | { toolUse: BedrockToolUse }
  | { toolResult: BedrockToolResult }
  | Record<string, unknown>;

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

/** Tool declaration in Bedrock Converse form. */
export interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

/** Per-turn context threaded through the LLM layer (provider choice, channel, ids). */
export interface MetaData {
  llm_provider?: string;
  assigned_model?: string;
  channel?: string;
  chat_id?: string;
  agent_id?: string;
  record_type?: string;
  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool outcome status. The deterministic by-design outcomes (`skipped`/`blocked`/`deferred`) are
 * distinct from `failed` on purpose: they roll up into the Activities tab so it shows *why* nothing
 * happened, and they suppress the messages_v3 conversation card that a real send would produce.
 */
export type ToolStatus =
  | 'success'
  | 'in_progress'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'deferred';

export interface ToolResult {
  /**
   * A named status, or a bare numeric HTTP code. The number is not an accident: the Unipile send
   * path returns the raw response status, and `deriveMessageStatus` treats `>= 400` as a failed
   * delivery. Narrowing this to `string` would make that branch unreachable from typed callers.
   */
  status?: ToolStatus | string | number;
  success?: boolean | string;
  message?: string;
  reason?: string;
  error?: string;
  guidance?: string;
  retry_at?: string;
  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// messages_v3 conversation cards
// ─────────────────────────────────────────────────────────────────────────────

export type MessageDirection = 'inbound' | 'outbound' | 'internal';
export type MessageSenderKind = 'ai' | 'admin' | 'customer';

export interface MessageAttachment {
  type: string;
  caption: string;
  url: string;
}

/** `chats/{chatId}/messages_v3/{id}` — a UI-visible conversation card. */
export interface MessageV3 {
  timestamp: Date;
  type: 'text' | 'call';
  direction: MessageDirection;
  sender: { kind: MessageSenderKind };
  recipient: 'customer' | 'admin' | 'ai';
  content: Record<string, unknown>;
  status: string;
  attachments: MessageAttachment[];
  source: string;
  sms_owner?: 'oversee' | 'sms_agent';
}

/** `chats/{chatId}/activities/{id}` — every tool call, success or not. */
export interface Activity {
  timestamp: Date;
  kind: 'tool_call';
  toolCall: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    result: ToolResult;
    status: string;
    /** Ava's reasoning + the outcome explanation, attached only to non-success activities. */
    reasoning?: string;
  };
}

/** `chats/{chatId}/notifications/{id}` — raised for failed calls and tool errors only. */
export interface Notification {
  timestamp: Date;
  type: 'call_failed' | 'tool_error';
  severity: 'warning' | 'error';
  title: string;
  detail: string;
  meta: Record<string, unknown>;
  read: boolean;
}
