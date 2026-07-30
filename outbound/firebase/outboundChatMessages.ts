/**
 * The UI read models: `messages_v3` (conversation cards), `activities` (every tool call), and
 * `notifications` (failures worth surfacing).
 *
 * These are derived from the same Bedrock-format messages that go into `messages`. The split is the
 * point: `messages` is what the LLM re-reads every turn, while these three are what a human looks
 * at, and they answer different questions.
 *
 *   - `messages_v3` — only tools that produce something a *customer* saw (see `MESSAGE_TOOLS`).
 *   - `activities`  — **every** tool call, successful or not, with its input and result.
 *   - `notifications` — the subset a human should be told about: failed calls and tool errors.
 *
 * ## The one rule that is outbound-specific
 *
 * A `make_phone_call` card is written to `messages_v3` **only when the call was actually placed** —
 * `status === 'in_progress'` and a truthy `call_id`. A deferred / skipped / blocked / errored call
 * produces no conversation card, because nothing happened that the prospect experienced. It is
 * still recorded as an `activity`, so the attempt and its reason stay fully auditable. This mirrors
 * how the email tool already behaved (no card when `deferred`/`skipped`).
 *
 * ## Why deterministic gating gets its own activity statuses
 *
 * `skipped` / `blocked` / `deferred` are distinct from `failed` on purpose. They mean the flow
 * decided *by design* not to act — outside business hours, opted out, rate-limited. Rolling them
 * into `failed` would make an Activities tab that reads as broken when it is in fact working, and
 * collapsing them into `success` would hide the reason nothing happened. For those outcomes the
 * activity also carries a `reasoning` string (the assistant's own words for the turn plus the
 * deterministic explanation), so dropping the dead turn from the LLM history loses no context.
 */

import { FieldValue, db } from './db';
import {
  deriveMessageStatus,
  extractInfo,
  getFileTypeFromUrl,
  getKnowledgeSource,
  getMemory,
  incrementUnreadCount,
  normalizeBedrockMessage,
} from './chat';
import type {
  Activity,
  BedrockMessage,
  MessageAttachment,
  MessageV3,
  Notification,
  ToolResult,
} from '../types';

function chatRef(chatId: string) {
  return db.collection('chats').doc(chatId);
}

/**
 * Tools that produce a UI-visible message in `messages_v3`.
 *
 * Ported verbatim as a **name set**, not a set of implementations. It is the allowlist that decides
 * card-vs-activity-only, so it has to stay complete even for channels this app has not bound yet —
 * trimming it would silently turn a future WhatsApp/SMS send into an activity with no conversation
 * card.
 */
export const MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  'send_whatsapp_message',
  'send_whatsapp_message_twilio',
  'send_whatsapp_message_official',
  'send_whatsapp_message_using_twilio',
  'send_whatsapp_message_with_attachment',
  'send_whatsapp_message_with_attachments_using_official',
  'send_whatsapp_message_with_attachments_using_twilio',
  'send_whatsapp_message_to_admin',
  'send_whatsapp_message_to_admin_twilio',
  'send_whatsapp_message_to_admin_official',
  'send_whatsapp_voice_note',
  'send_whatsapp_voice_note_using_twilio',
  'send_whatsapp_voice_note_using_official',
  'send_web_message_to_admin',
  'send_whatsapp_message_by_human',
  'send_sms_message_using_twilio',
  'send_sms_message_by_human',
  'send_web_message',
  'make_phone_call',
  'make_phone_call_from_number',
  'received_phone_call',
]);

const CALL_TOOLS = new Set([
  'make_phone_call',
  'make_phone_call_from_number',
  'received_phone_call',
]);

/**
 * Build a notification document if the tool result warrants telling a human.
 * Returns `null` for ordinary successful calls — this collection is meant to stay sparse.
 */
export function buildNotification(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResults: ToolResult | null,
  activityStatus: string,
  timestamp: Date
): Notification | null {
  // A call that reached the network but did not connect.
  if (CALL_TOOLS.has(toolName)) {
    const outcome = String(toolResults?.status ?? '');
    if (['failed', 'no-answer', 'busy'].includes(outcome)) {
      const phoneNumber = String(toolResults?.phone_number ?? '');
      const callId = String(toolResults?.call_id ?? '');
      return {
        timestamp,
        type: 'call_failed',
        severity: 'warning',
        title: `Call failed — ${outcome}`,
        detail:
          `${toolName !== 'received_phone_call' ? 'Outbound' : 'Inbound'} call to ` +
          `${phoneNumber} ended with status: ${outcome}.`,
        meta: { callId, phoneNumber, outcome, toolName },
        read: false,
      };
    }
  }

  if (activityStatus === 'failed') {
    const errorMsg = toolResults
      ? String(toolResults.error ?? '') || String(toolResults.message ?? '')
      : '';
    return {
      timestamp,
      type: 'tool_error',
      severity: 'error',
      title: `Tool error — ${toolName}`,
      detail: errorMsg
        ? String(errorMsg).slice(0, 500)
        : `${toolName} returned an error.`,
      meta: { toolName, input: toolInput },
      read: false,
    };
  }

  return null;
}

/**
 * Build a `messages_v3` card from a tool call and its result, or `null` when the tool should not
 * produce one.
 */
export async function buildV3MessageFromTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResults: ToolResult | null,
  timestamp: Date
): Promise<MessageV3 | null> {
  const body = String(toolInput?.body ?? '');

  // ── WhatsApp text ──
  if (
    [
      'send_whatsapp_message',
      'send_whatsapp_message_twilio',
      'send_whatsapp_message_official',
      'send_whatsapp_message_using_twilio',
    ].includes(toolName)
  ) {
    return {
      timestamp,
      type: 'text',
      direction: 'outbound',
      sender: { kind: 'ai' },
      recipient: 'customer',
      content: { body },
      status: deriveMessageStatus(toolResults),
      attachments: [],
      source: 'whatsapp',
    };
  }

  // ── WhatsApp to admin ──
  if (
    [
      'send_whatsapp_message_to_admin',
      'send_whatsapp_message_to_admin_twilio',
      'send_whatsapp_message_to_admin_official',
    ].includes(toolName)
  ) {
    return {
      timestamp,
      type: 'text',
      direction: 'internal',
      sender: { kind: 'ai' },
      recipient: 'admin',
      content: { body },
      status: 'delivered',
      attachments: [],
      source: 'whatsapp',
    };
  }

  // ── Web message to admin ──
  if (toolName === 'send_web_message_to_admin') {
    return {
      timestamp,
      type: 'text',
      direction: 'internal',
      sender: { kind: 'ai' },
      recipient: 'admin',
      content: { body },
      status: 'delivered',
      attachments: [],
      source: 'web',
    };
  }

  // ── WhatsApp with attachments ──
  if (
    [
      'send_whatsapp_message_with_attachment',
      'send_whatsapp_message_with_attachments_using_official',
      'send_whatsapp_message_with_attachments_using_twilio',
    ].includes(toolName)
  ) {
    const attachments: MessageAttachment[] = [];
    for (const attachmentId of (toolInput?.attachment_ids as string[]) ?? []) {
      const knowledgeSource = await getKnowledgeSource(attachmentId);
      if (knowledgeSource) {
        const fileUrl = (knowledgeSource.data ?? {}).content;
        attachments.push({
          type: getFileTypeFromUrl(fileUrl),
          caption: '',
          url: String(fileUrl ?? ''),
        });
      }
    }
    return {
      timestamp,
      type: 'text',
      direction: 'outbound',
      sender: { kind: 'ai' },
      recipient: 'customer',
      content: { body },
      status: deriveMessageStatus(toolResults),
      attachments,
      source: 'whatsapp',
    };
  }

  // ── WhatsApp sent by a human admin ──
  if (toolName === 'send_whatsapp_message_by_human') {
    const attachments: MessageAttachment[] = [];
    const voiceNoteUrl = String(toolInput?.voice_note_url ?? '');
    if (voiceNoteUrl)
      attachments.push({ type: 'audio', caption: '', url: voiceNoteUrl });
    for (const attUrl of (toolInput?.attachment as string[]) ?? []) {
      attachments.push({
        type: getFileTypeFromUrl(attUrl),
        caption: '',
        url: attUrl,
      });
    }
    return {
      timestamp,
      type: 'text',
      direction: 'outbound',
      sender: { kind: 'admin' },
      recipient: 'customer',
      content: { body },
      status: deriveMessageStatus(toolResults),
      attachments,
      source: 'whatsapp',
    };
  }

  // ── SMS ──
  if (
    ['send_sms_message_using_twilio', 'send_sms_message_by_human'].includes(
      toolName
    )
  ) {
    const attachments: MessageAttachment[] = [];
    for (const url of (toolInput?.media_urls as string[]) ?? []) {
      attachments.push({ type: getFileTypeFromUrl(url), caption: '', url });
    }
    return {
      timestamp,
      type: 'text',
      direction: 'outbound',
      sender: {
        kind: toolName === 'send_sms_message_by_human' ? 'admin' : 'ai',
      },
      recipient: 'customer',
      content: { body },
      status: deriveMessageStatus(toolResults),
      attachments,
      source: 'sms',
    };
  }

  // ── Web message to customer ──
  if (toolName === 'send_web_message') {
    return {
      timestamp,
      type: 'text',
      direction: 'outbound',
      sender: { kind: 'ai' },
      recipient: 'customer',
      content: { body },
      status: 'delivered',
      attachments: [],
      source: 'web',
    };
  }

  // ── WhatsApp voice notes ──
  if (
    [
      'send_whatsapp_voice_note',
      'send_whatsapp_voice_note_using_twilio',
      'send_whatsapp_voice_note_using_official',
    ].includes(toolName)
  ) {
    const voiceNoteUrl = String(toolResults?.voice_note_url ?? '');
    return {
      timestamp,
      type: 'text',
      direction: 'outbound',
      sender: { kind: 'ai' },
      recipient: 'customer',
      content: { body: '' },
      status: 'delivered',
      attachments: [{ type: 'audio', caption: '', url: voiceNoteUrl }],
      source: 'whatsapp',
    };
  }

  // ── Outbound phone call ──
  // THE OUTBOUND-SPECIFIC RULE (see the module docstring): only emit a card when the call was
  // truly PLACED. A deferred / skipped / blocked / errored call returns null so no conversation
  // card is created; it is still captured as an activity by the caller.
  if (
    toolName === 'make_phone_call' ||
    toolName === 'make_phone_call_from_number'
  ) {
    const callId = String(toolResults?.call_id ?? '');
    const statusVal = String(toolResults?.status ?? '');
    if (!(statusVal === 'in_progress' && callId)) return null;

    const phoneNumber = String(toolResults?.phone_number ?? '');
    const summary = String(toolResults?.summary ?? '');
    const recordingUrl = String(toolResults?.recording_url ?? '');
    const attachments: MessageAttachment[] = [];
    if (recordingUrl) {
      attachments.push({
        type: 'audio',
        caption: 'Call recording',
        url: recordingUrl,
      });
    }
    return {
      timestamp,
      type: 'call',
      direction: 'outbound',
      sender: { kind: 'ai' },
      recipient: 'customer',
      content: {
        callId,
        summary,
        phoneNumber,
        outcome: statusVal || 'initiated',
        duration: null,
        attemptNumber: null,
        recordingUrl,
      },
      status: 'delivered',
      attachments,
      source: 'call',
    };
  }

  // ── Received phone call ──
  if (toolName === 'received_phone_call') {
    const callId = String(toolResults?.call_id ?? '');
    const phoneNumber = String(toolResults?.phone_number ?? '');
    const summary = String(toolResults?.summary ?? '');
    const recordingUrl = String(toolResults?.recording_url ?? '');
    const statusVal = String(toolResults?.status ?? '');
    const attachments: MessageAttachment[] = [];
    if (recordingUrl) {
      attachments.push({
        type: 'audio',
        caption: 'Call recording',
        url: recordingUrl,
      });
    }
    return {
      timestamp,
      type: 'call',
      direction: 'inbound',
      sender: { kind: 'customer' },
      recipient: 'ai',
      content: {
        callId,
        summary,
        phoneNumber,
        outcome: statusVal || 'received',
        duration: null,
        attemptNumber: null,
        recordingUrl,
      },
      status: 'delivered',
      attachments,
      source: 'call',
    };
  }

  return null;
}

/**
 * Build a `messages_v3` card from a user text content block.
 *
 * The channels deliver a **double-nested** payload: the block's `text` is JSON, and for a customer
 * that JSON's own `text` field is JSON again. Returns `null` on a parse failure so one malformed
 * block cannot take down the turn's whole write.
 */
export function buildV3MessageFromUserText(
  contentItem: { text?: unknown },
  timestamp: Date
): MessageV3 | null {
  let parsed: Record<string, unknown>;
  let userType: string;
  try {
    parsed = JSON.parse(String(contentItem.text)) as Record<string, unknown>;
    userType = String(parsed.userType ?? 'customer');
  } catch {
    return null;
  }

  if (userType === 'admin') {
    let text: string;
    try {
      text = extractInfo(String(parsed.text)).notes;
    } catch {
      // Admin text is often a plain string rather than the structured payload — keep it.
      text = String(parsed.text ?? '');
    }
    return {
      timestamp,
      type: 'text',
      direction: 'internal',
      sender: { kind: 'admin' },
      recipient: 'ai',
      content: { body: text },
      status: 'delivered',
      attachments: [],
      source: 'virtuans',
    };
  }

  if (userType === 'customer') {
    let customerPayload: Record<string, unknown>;
    try {
      customerPayload = JSON.parse(String(parsed.text)) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }

    const text = String(customerPayload.text ?? '');
    const voiceNoteUrl = customerPayload.voice_note_url as string | undefined;
    let attachmentList = customerPayload.attachment as
      | string[]
      | string
      | undefined;
    const source = String(customerPayload.source ?? 'whatsapp');
    const caption = String(customerPayload.caption ?? '');

    const attachments: MessageAttachment[] = [];
    if (voiceNoteUrl)
      attachments.push({ type: 'audio', caption, url: voiceNoteUrl });
    if (attachmentList) {
      if (!Array.isArray(attachmentList)) attachmentList = [attachmentList];
      for (const att of attachmentList) {
        attachments.push({ type: getFileTypeFromUrl(att), caption, url: att });
      }
    }

    return {
      timestamp,
      type: 'text',
      direction: 'inbound',
      sender: { kind: 'customer' },
      recipient: 'ai',
      content: { body: text },
      status: 'delivered',
      attachments,
      source,
    };
  }

  // Unknown userType: keep the raw text rather than dropping the message.
  return {
    timestamp,
    type: 'text',
    direction: 'inbound',
    sender: { kind: 'customer' },
    recipient: 'ai',
    content: { body: String(parsed.text ?? '') },
    status: 'delivered',
    attachments: [],
    source: 'whatsapp',
  };
}

/**
 * Roll a tool result up into an activity status.
 *
 * `in_progress` becomes `pending`; the deterministic by-design outcomes keep their own names; an
 * explicit error becomes `failed`; everything else is `success`. Note `success === 'false'` is
 * checked as a **string** — that is what some tools actually return.
 */
export function deriveActivityStatus(toolResults: ToolResult | null): string {
  const resStatus = String(toolResults?.status ?? '').toLowerCase();
  if (resStatus === 'in_progress') return 'pending';
  if (['skipped', 'blocked', 'deferred'].includes(resStatus)) return resStatus;
  if (toolResults?.success === 'false' || toolResults?.error) return 'failed';
  return 'success';
}

/**
 * Write `messages_v3`, `activities` and `notifications` for a turn.
 *
 * Each collection is committed in its own batch: they are independent read models, and a failure
 * writing one should not roll back another that already succeeded.
 *
 * @param activitiesOnly When true, record ONLY activities (and notifications) — skip the
 *   `messages_v3` cards and the parent-chat duplication. Used for a purely deterministic
 *   block/defer turn (an `@ai` trigger that got gated): the block stays auditable in Activities,
 *   but no conversation card is created and — via the caller — no `messages` history entry either,
 *   so the dead turn is never re-tokenized into a later prompt.
 *
 * @returns `[messageV3Ids, activityIds]`, or `[null, null]` on error.
 */
export async function addMessagesV3AndActivities(
  chatId: string,
  messagesDataList: BedrockMessage[],
  baseTimestamp?: Date,
  activitiesOnly = false
): Promise<[string[] | null, string[] | null]> {
  try {
    const ref = chatRef(chatId);
    const base = baseTimestamp ?? new Date();
    let tsCounter = 0;
    const nextTimestamp = () => new Date(base.getTime() + tsCounter++);

    const v3Pending: Array<{ id: string; data: MessageV3 }> = [];
    const activityPending: Array<{ id: string; data: Activity }> = [];
    const notificationPending: Array<{ id: string; data: Notification }> = [];

    // First pass: index the turn's assistant toolUse blocks, and collect the assistant's own
    // reasoning text. The reasoning is attached to non-success activities below, so dropping a
    // blocked/deferred turn from the LLM history does not lose the context it carried.
    const toolUses: Record<
      string,
      { tool_name: string; tool_use_input: Record<string, unknown> }
    > = {};
    const reasoningParts: string[] = [];

    for (const messageData of messagesDataList) {
      if (messageData.role !== 'assistant') continue;
      for (const block of messageData.content) {
        if (block === null || typeof block !== 'object') continue;
        const rec = block as Record<string, unknown>;
        const toolUse = rec.toolUse as
          | {
              toolUseId: string;
              name?: string;
              input?: Record<string, unknown>;
            }
          | undefined;
        if (toolUse) {
          toolUses[toolUse.toolUseId] = {
            tool_name: toolUse.name ?? '',
            tool_use_input: toolUse.input ?? {},
          };
        } else if ('text' in rec) {
          const t = String(rec.text ?? '').trim();
          if (t && t !== 'Done') reasoningParts.push(t);
        }
      }
    }
    const turnAssistantReasoning = reasoningParts.join('\n').trim();

    // Second pass: emit cards, activities and notifications.
    const unreadBumps: string[] = [];

    for (const messageData of messagesDataList) {
      if (messageData.role !== 'user') continue;
      if (!Array.isArray(messageData.content)) continue;

      for (const block of messageData.content) {
        if (block === null || typeof block !== 'object') continue;
        const rec = block as Record<string, unknown>;

        if ('toolResult' in rec) {
          const tr = rec.toolResult as {
            toolUseId?: string;
            content?: unknown;
          };
          const toolUseId = tr.toolUseId ?? '';
          const trContent = tr.content;

          let toolResults: ToolResult = {};
          if (Array.isArray(trContent) && trContent.length) {
            const first = trContent[0];
            if (first !== null && typeof first === 'object') {
              const f = first as Record<string, unknown>;
              toolResults = ('json' in f ? f.json : f) as ToolResult;
            }
          } else if (trContent !== null && typeof trContent === 'object') {
            toolResults = trContent as ToolResult;
          }

          // A toolResult with no matching toolUse resolves to an empty tool name. It yields no
          // card (the name is not in MESSAGE_TOOLS) but still produces an activity, so an orphan
          // block is auditable instead of fatal.
          const toolInfo = toolUses[toolUseId] ?? {
            tool_name: '',
            tool_use_input: {},
          };
          const toolName = toolInfo.tool_name;
          const toolInput = toolInfo.tool_use_input;

          const ts = nextTimestamp();
          const activityStatus = deriveActivityStatus(toolResults);

          const toolCall: Activity['toolCall'] = {
            toolUseId,
            toolName,
            input: toolInput,
            result: toolResults,
            status: activityStatus,
          };

          // Retain the context a conversation card would have carried, but only for non-success
          // outcomes — attaching it to routine successes would bloat every activity.
          if (
            ['failed', 'skipped', 'blocked', 'deferred'].includes(
              activityStatus
            )
          ) {
            const detail =
              toolResults.message ||
              toolResults.reason ||
              toolResults.error ||
              '';
            const rparts: string[] = [];
            if (turnAssistantReasoning)
              rparts.push(`Ava's reasoning: ${turnAssistantReasoning}`);
            if (detail) rparts.push(`Outcome: ${detail}`);
            if (toolResults.guidance)
              rparts.push(`Guidance: ${toolResults.guidance}`);
            if (toolResults.retry_at)
              rparts.push(`Retry at: ${toolResults.retry_at}`);
            if (rparts.length) toolCall.reasoning = rparts.join(' | ');
          }

          const activityDoc = ref.collection('activities').doc();
          activityPending.push({
            id: activityDoc.id,
            data: { timestamp: ts, kind: 'tool_call', toolCall },
          });

          const notification = buildNotification(
            toolName,
            toolInput,
            toolResults,
            activityStatus,
            ts
          );
          if (notification) {
            const notifDoc = ref.collection('notifications').doc();
            notificationPending.push({ id: notifDoc.id, data: notification });
          }

          if (MESSAGE_TOOLS.has(toolName)) {
            const v3Msg = await buildV3MessageFromTool(
              toolName,
              toolInput,
              toolResults,
              ts
            );
            if (v3Msg) {
              const msgDoc = ref.collection('messages_v3').doc();
              v3Pending.push({ id: msgDoc.id, data: v3Msg });
            }
          }
        } else if ('text' in rec) {
          const ts = nextTimestamp();
          const v3Msg = buildV3MessageFromUserText(
            rec as { text?: unknown },
            ts
          );
          if (v3Msg) {
            const msgDoc = ref.collection('messages_v3').doc();
            v3Pending.push({ id: msgDoc.id, data: v3Msg });
            if (v3Msg.sender.kind === 'customer') unreadBumps.push(chatId);
          }
        }
      }
    }

    // ── sms_owner tagging ──
    // Tag source:'sms' cards so we can tell which were handled by the oversee agent vs the SMS
    // sub-agent when building handoff context later.
    const chatMemoryForTag = await getMemory(chatId);
    const isSmsAgentChat = Boolean(
      chatMemoryForTag?.is_sms_agent && chatMemoryForTag?.parent_chat_id
    );
    if (!isSmsAgentChat) {
      // An oversee (or any non-SMS-agent) chat. Only tag as 'oversee' when handoff is NOT active —
      // while handoff is active these messages belong to the SMS agent's session.
      const handoffActive = chatMemoryForTag?.sms_handoff_active === true;
      const tag = handoffActive ? 'sms_agent' : 'oversee';
      for (const entry of v3Pending) {
        if (entry.data.source === 'sms') entry.data.sms_owner = tag;
      }
    }

    // ── batch writes ──
    const messageV3Ids: string[] = [];
    if (v3Pending.length && !activitiesOnly) {
      const batch = db.batch();
      for (const { id, data } of v3Pending) {
        batch.set(ref.collection('messages_v3').doc(id), data);
        messageV3Ids.push(id);
      }
      await batch.commit();
    }

    const activityIds: string[] = [];
    if (activityPending.length) {
      const batch = db.batch();
      for (const { id, data } of activityPending) {
        batch.set(ref.collection('activities').doc(id), data);
        activityIds.push(id);
      }
      await batch.commit();
    }

    const notificationIds: string[] = [];
    if (notificationPending.length) {
      const batch = db.batch();
      for (const { id, data } of notificationPending) {
        batch.set(ref.collection('notifications').doc(id), data);
        notificationIds.push(id);
      }
      await batch.commit();
    }

    // Bump unread once per inbound customer card, after the batch lands. This is the ONLY place
    // unread is incremented on the write path — the source also bumped it from its `messages_v2`
    // writer, which double-counted every inbound message. See the note in `./chat`.
    if (!activitiesOnly) {
      for (const id of unreadBumps) await incrementUnreadCount(id);
    }

    console.log(
      `[V3] Wrote ${messageV3Ids.length} messages_v3, ${activityIds.length} activities, ` +
        `${notificationIds.length} notifications for chat ${chatId}`
    );

    // Duplicate cards AND activities to the parent (oversee) chat when this is an SMS sub-agent
    // chat, so the human sees one continuous conversation. Guarded separately — a duplication
    // failure must not undo the primary writes.
    try {
      if (isSmsAgentChat) {
        const parentChatId = String(chatMemoryForTag.parent_chat_id);
        const parentRef = chatRef(parentChatId);

        if (v3Pending.length && !activitiesOnly) {
          const batch = db.batch();
          for (const { data } of v3Pending) {
            const parentData: MessageV3 = { ...data };
            if (parentData.source === 'sms') parentData.sms_owner = 'sms_agent';
            batch.set(parentRef.collection('messages_v3').doc(), parentData);
          }
          await batch.commit();
        }
        if (activityPending.length) {
          const batch = db.batch();
          for (const { data } of activityPending) {
            batch.set(parentRef.collection('activities').doc(), data);
          }
          await batch.commit();
        }
        if (notificationPending.length) {
          const batch = db.batch();
          for (const { data } of notificationPending) {
            batch.set(parentRef.collection('notifications').doc(), data);
          }
          await batch.commit();
        }
        console.log(
          `[V3] Duplicated ${v3Pending.length} messages + ${activityPending.length} activities + ` +
            `${notificationPending.length} notifications to parent chat ${parentChatId}`
        );
      }
    } catch (e) {
      console.log(`[V3] Error duplicating to parent chat: ${e}`);
    }

    return [messageV3Ids, activityIds];
  } catch (e) {
    console.error(
      `[V3] Error writing messages_v3/activities for chat ${chatId}: ${e}`
    );
    return [null, null];
  }
}

/**
 * Persist a turn as ACTIVITIES ONLY — no `messages` history and no `messages_v3` cards.
 *
 * Used when an `@ai`-trigger turn resolved to nothing but a deterministic by-design block or defer
 * (e.g. phone-lane-call-only). The block stays fully auditable in the Activities tab, but the dead
 * `toolUse`/`toolResult` pair never enters the history that is re-tokenized into the prompt on
 * every future turn. Bumps `chat.updatedAt`. Best-effort — never throws.
 */
export async function recordActivitiesOnly(
  chatId: string,
  messagesDataList: unknown[],
  baseTimestamp?: Date
): Promise<void> {
  try {
    const normalized = (messagesDataList ?? []).map((m) =>
      normalizeBedrockMessage(m)
    );
    await addMessagesV3AndActivities(chatId, normalized, baseTimestamp, true);
    try {
      await chatRef(chatId).update({ updatedAt: FieldValue.serverTimestamp() });
    } catch (updErr) {
      console.warn(
        `[V3] recordActivitiesOnly updatedAt bump failed chat=${chatId}: ${updErr}`
      );
    }
  } catch (e) {
    console.error(`[V3] recordActivitiesOnly failed for chat ${chatId}: ${e}`);
  }
}
