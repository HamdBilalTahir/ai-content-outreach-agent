/**
 * Chat, memory, task, label and message persistence for the outbound flow.
 *
 * This is the outbound app's own data layer. Everything the flow needs to read or write about a
 * conversation lives here: the `chats/{chatId}` document, its `memory` bag, its `tasks`
 * subcollection (what the cron selects from), its `messages` history, labels, the rapid-queue soft
 * lock, pending-call records, and LLM usage logs.
 *
 * Behavior notes that are load-bearing and easy to "clean up" wrongly:
 *
 *  - **`setMemory` writes dot-paths, not a merged object.** `memory.foo` updates one nested key
 *    without touching its siblings. A read-modify-write of the whole `memory` map would lose
 *    concurrent writes, and many independent writers touch memory during a single turn.
 *  - **Almost every function swallows its error and returns a falsy value.** That is deliberate:
 *    persistence is best-effort throughout this flow, and a write fault must never abort a turn
 *    mid-way and leave a call placed but unrecorded. The exceptions are documented inline.
 *  - **Firestore `update()` rejects on a missing document** (unlike `set(..., {merge:true})`).
 *    Several functions rely on that to return `false` for a chat/task that no longer exists.
 *
 * ## Deliberate omission: `messages_v2`
 *
 * The source also maintained a `messages_v2` collection. It is **not** ported, because for outbound
 * it was strictly redundant: every field it carried exists in `messages_v3`, and its one unique
 * feature — a `tool: {tool_name, input, output}` envelope stored alongside the message — is exactly
 * what the `activities.toolCall` document replaced. Dropping it also removes three defects that
 * were live in the source:
 *
 *   1. `unread_count` was incremented twice for one inbound customer message (once by the v2
 *      writer, once by the v3 writer), so every unread figure was doubled.
 *   2. The v2 writer computed its own `datetime.utcnow()` instead of accepting the turn's
 *      `base_timestamp`, so its rows drifted from `messages`/`messages_v3` by the turn's duration
 *      (15-45s) — defeating the reason `base_timestamp` is threaded through at all.
 *   3. A `toolResult` block whose `toolUse` was missing raised inside the v2 writer and abandoned
 *      the entire batch; the v3 writer tolerates the same input.
 *
 * The read models that remain are `messages` (LLM history), `messages_v3` (UI cards), `activities`
 * (every tool call) and `notifications` (failures) — see `./outboundChatMessages`.
 */

import {
  BATCH_LIMIT,
  FieldValue,
  db,
  toDate,
  type DocumentData,
  type Query,
} from './db';
import type {
  BedrockContentBlock,
  BedrockMessage,
  ChatMemory,
  TaskDoc,
  ToolResult,
} from '../types';

const CHATS = 'chats';

function chatRef(chatId: string) {
  return db.collection(CHATS).doc(chatId);
}

function taskRef(chatId: string, taskId: string) {
  return chatRef(chatId).collection('tasks').doc(taskId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an admin instruction payload that embeds a dict-like substring, returning
 * `{ original_datetime, timezone, notes }`.
 *
 * The source tried `json.loads` on the substring with single quotes swapped for double, then fell
 * back to `ast.literal_eval` for true Python literal syntax. TS has no `literal_eval`, so the
 * fallback normalizes Python literals (`True`/`False`/`None`) into JSON before a second parse —
 * which covers the shapes `literal_eval` was actually accepting here.
 *
 * Throws on unparseable input, matching the source's `ValueError`. Callers wrap it: the
 * messages_v3 builder falls back to the raw text when this throws, so an admin note is never lost.
 */
export function extractInfo(s: string): {
  original_datetime: Date;
  timezone: string;
  notes: string;
} {
  const m = /\{[\s\S]*\}/.exec(String(s ?? ''));
  if (!m) throw new Error('No dictionary-like substring found in input');
  const dictPart = m[0];

  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(dictPart.replace(/'/g, '"')) as Record<string, unknown>;
  } catch {
    try {
      const pythonised = dictPart
        .replace(/'/g, '"')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null');
      obj = JSON.parse(pythonised) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `Could not parse dict substring: ${(e as Error).message}\nSubstring was:\n${dictPart}`
      );
    }
  }

  for (const key of ['original_date', 'original_time', 'timezone', 'notes']) {
    if (!(key in obj))
      throw new Error(`Missing key \`${key}\` in parsed dict: ${dictPart}`);
  }

  const dateStr = String(obj.original_date);
  const timeStr = String(obj.original_time);
  const dt = parseNaiveDateTime(dateStr, timeStr);
  if (!dt)
    throw new Error(`Could not parse date/time \`${dateStr} ${timeStr}\``);

  return {
    original_datetime: dt,
    timezone: String(obj.timezone),
    notes: String(obj.notes),
  };
}

/**
 * `"YYYY-MM-DD"` + `"HH:MM"` (or `"HH:MM:SS"`) → a `Date`.
 *
 * The source's `strptime` produced a *naive* datetime — no zone. There is no naive instant in JS,
 * so this builds the equivalent in UTC rather than local time: the value is only ever read back as
 * a wall-clock reading, and anchoring it to UTC keeps it stable regardless of where the server runs
 * (interpreting it as local time would silently shift it by the host offset).
 */
function parseNaiveDateTime(dateStr: string, timeStr: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr).trim());
  if (!dm || !tm) return null;
  const d = new Date(
    Date.UTC(
      Number(dm[1]),
      Number(dm[2]) - 1,
      Number(dm[3]),
      Number(tm[1]),
      Number(tm[2]),
      tm[3] ? Number(tm[3]) : 0
    )
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'webp',
  'svg',
  'ico',
  'tiff',
  'tif',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'avi',
  'mov',
  'wmv',
  'flv',
  'webm',
  'mkv',
  '3gp',
  'm4v',
]);
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'ogg',
  'aac',
  'flac',
  'm4a',
  'wma',
  'opus',
]);
const DOC_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'txt',
  'rtf',
  'odt',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'zip',
  'rar',
  '7z',
]);

/** Classify an attachment URL by extension into image/video/audio/doc, else `'unknown'`. */
export function getFileTypeFromUrl(fileUrl: unknown): string {
  if (!fileUrl) return 'unknown';
  let path = String(fileUrl);
  try {
    path = new URL(path).pathname;
  } catch {
    // Not an absolute URL — fall back to treating the whole value as a path, as urlparse does.
    path = path.split('?')[0].split('#')[0];
  }
  const dot = path.toLowerCase().lastIndexOf('.');
  if (dot < 0) return 'unknown';
  const ext = path.toLowerCase().slice(dot + 1);

  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Bedrock message normalization
// ─────────────────────────────────────────────────────────────────────────────

function randomToolUseId(): string {
  // Matches the source's `f"tooluse_{uuid4().hex[:24]}"` shape.
  let hex = '';
  while (hex.length < 24) hex += Math.floor(Math.random() * 16).toString(16);
  return `tooluse_${hex.slice(0, 24)}`;
}

/**
 * Canonical Bedrock shape for `toolResult.content`: a list of `{json}` / `{text}` blocks.
 * An empty/absent content becomes `[{json:{}}]` — never an empty array, which some providers reject.
 */
export function normalizeToolResultContent(
  content: unknown
): Array<Record<string, unknown>> {
  if (content === null || content === undefined) return [{ json: {} }];

  const sourceItems = Array.isArray(content) ? content : [content];
  const normalized: Array<Record<string, unknown>> = [];

  for (const item of sourceItems) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if ('json' in rec) normalized.push({ json: rec.json });
      else if ('text' in rec) normalized.push({ text: String(rec.text ?? '') });
      else normalized.push({ json: rec });
    } else {
      normalized.push({ text: String(item) });
    }
  }

  return normalized.length ? normalized : [{ json: {} }];
}

/**
 * Normalize a content list to Bedrock-compatible blocks, dropping incompatible keys.
 *
 * Handles the historical shapes the store still contains: `toolUse` blocks carrying extra keys
 * (like `type`), and flat tool results (`{toolUseId, content}`) that were never wrapped in
 * `toolResult`. Returns `[{text:''}]` for empty input, because a message with zero content blocks
 * is rejected by every provider.
 */
export function normalizeMessageContent(
  content: unknown
): BedrockContentBlock[] {
  let sourceItems: unknown[];
  if (
    content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content)
  ) {
    sourceItems = [content];
  } else if (typeof content === 'string') {
    sourceItems = [{ text: content }];
  } else if (Array.isArray(content)) {
    sourceItems = content;
  } else {
    sourceItems = [];
  }

  const normalized: BedrockContentBlock[] = [];

  for (const item of sourceItems) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;

      if (
        rec.toolUse !== null &&
        typeof rec.toolUse === 'object' &&
        !Array.isArray(rec.toolUse)
      ) {
        const tu = rec.toolUse as Record<string, unknown>;
        normalized.push({
          toolUse: {
            toolUseId: String(tu.toolUseId || randomToolUseId()),
            name: String(tu.name ?? ''),
            input: (tu.input ?? {}) as Record<string, unknown>,
          },
        });
        continue;
      }

      if (
        rec.toolResult !== null &&
        typeof rec.toolResult === 'object' &&
        !Array.isArray(rec.toolResult)
      ) {
        const tr = rec.toolResult as Record<string, unknown>;
        normalized.push({
          toolResult: {
            toolUseId: String(tr.toolUseId || randomToolUseId()),
            content: normalizeToolResultContent(tr.content),
          },
        });
        continue;
      }

      // Legacy/flat tool-result support.
      if ('toolUseId' in rec) {
        normalized.push({
          toolResult: {
            toolUseId: String(rec.toolUseId || randomToolUseId()),
            content: normalizeToolResultContent(rec.content),
          },
        });
        continue;
      }

      if ('text' in rec) {
        normalized.push({ text: String(rec.text ?? '') });
        continue;
      }

      normalized.push({ text: JSON.stringify(rec) });
      continue;
    }

    normalized.push({ text: String(item) });
  }

  return normalized.length ? normalized : [{ text: '' }];
}

/** Normalize a whole message before persistence so the stored format stays Bedrock-compatible. */
export function normalizeBedrockMessage(messageData: unknown): BedrockMessage {
  if (
    messageData === null ||
    typeof messageData !== 'object' ||
    Array.isArray(messageData)
  ) {
    return { role: 'assistant', content: [{ text: String(messageData) }] };
  }
  const rec = messageData as Record<string, unknown>;
  return {
    role: (rec.role as BedrockMessage['role']) ?? 'assistant',
    content: normalizeMessageContent(rec.content ?? []),
  };
}

/** Alias kept for the read path, where the source called this `_clean_tool_use_content`. */
export const cleanToolUseContent = normalizeMessageContent;

/**
 * Derive a message delivery status from a tool result: `'failed'` or `'delivered'`.
 *
 * Three distinct failure encodings have to be recognized because three different senders produce
 * them: an explicit `'error'`, Twilio's `'failed'`/`'undelivered'`, and a bare numeric HTTP status
 * ≥ 400 (from the Unipile send path). Anything else counts as delivered.
 */
export function deriveMessageStatus(
  toolResults: unknown
): 'failed' | 'delivered' {
  if (
    !toolResults ||
    typeof toolResults !== 'object' ||
    Array.isArray(toolResults)
  ) {
    return 'delivered';
  }
  const status = (toolResults as ToolResult).status;
  if (status === 'error') return 'failed';
  if (status === 'failed' || status === 'undelivered') return 'failed';
  if (typeof status === 'number' && status >= 400) return 'failed';
  return 'delivered';
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a chat's `memory` map, creating it as `{}` when the field is absent.
 * Returns `{}` for a missing chat or on error — callers treat an empty bag as "nothing known",
 * which is the safe reading for every gate that consults memory.
 */
export async function getMemory(chatId: string): Promise<ChatMemory> {
  try {
    const ref = chatRef(chatId);
    const chat = await ref.get();

    if (!chat.exists) {
      console.log(`Chat with ID ${chatId} does not exist`);
      return {};
    }

    const chatData = (chat.data() ?? {}) as DocumentData;
    if ('memory' in chatData) return (chatData.memory ?? {}) as ChatMemory;

    // Create the field directly rather than routing through setMemory.
    const emptyMemory: ChatMemory = {};
    await ref.set(
      { memory: emptyMemory, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`Created empty memory for chat ${chatId}`);
    return emptyMemory;
  } catch (e) {
    console.log(`Error getting memory: ${e}`);
    return {};
  }
}

/**
 * Merge keys into a chat's `memory`, leaving siblings untouched.
 *
 * Uses Firestore dot-path updates (`memory.key`) rather than reading the map, mutating it and
 * writing it back. That read-modify-write would drop any concurrent write, and during one turn
 * several independent writers (enrollment, screening, the lane resolver, the tools) all touch
 * memory. Do not "simplify" this into a `set({memory}, {merge:true})` of a whole object.
 */
export async function setMemory(
  chatId: string,
  memoryData: ChatMemory
): Promise<boolean> {
  try {
    const updateFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(memoryData ?? {})) {
      updateFields[`memory.${k}`] = v;
    }
    updateFields.updatedAt = FieldValue.serverTimestamp();
    await chatRef(chatId).update(updateFields);
    return true;
  } catch (e) {
    console.log(`Error setting memory: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a task in `chats/{chatId}/tasks` and return its id (or `null` on failure).
 *
 * `executed: false` and `permanent_failure: false` are seeded explicitly because the cron's
 * due-task query filters on `executed == false` — a task without the field would never be selected.
 */
export async function createTaskWithId(
  chatId: string,
  taskType: string,
  executeAt: Date,
  data: Record<string, unknown> = {}
): Promise<string | null> {
  try {
    const ref = chatRef(chatId).collection('tasks').doc();
    await ref.set({
      type: taskType,
      execute_at: executeAt,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      executed: false,
      permanent_failure: false,
      data: data ?? {},
    });
    console.log(`Created task ${ref.id} in chat ${chatId}`);
    return ref.id;
  } catch (e) {
    console.log(`Error creating task with ID: ${e}`);
    return null;
  }
}

/** Fetch one task, with `task_id` attached. Returns `{}` when missing or on error. */
export async function getTask(
  chatId: string,
  taskId: string
): Promise<TaskDoc> {
  try {
    const snap = await taskRef(chatId, taskId).get();
    if (!snap.exists) {
      console.log(`Task ${taskId} not found in chat ${chatId}`);
      return {};
    }
    return { ...(snap.data() as TaskDoc), task_id: taskId } as TaskDoc;
  } catch (e) {
    console.log(`Error getting task: ${e}`);
    return {};
  }
}

/** Update arbitrary task fields, stamping `updated_at`. `false` if the task is gone or on error. */
export async function updateTask(
  chatId: string,
  taskId: string,
  updates: Record<string, unknown>
): Promise<boolean> {
  try {
    const ref = taskRef(chatId, taskId);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`Task ${taskId} not found in chat ${chatId}`);
      return false;
    }
    await ref.update({ ...updates, updated_at: FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    console.log(`Error updating task: ${e}`);
    return false;
  }
}

/** Flip a task's `executed` flag. Used only on the dispatch-claim-disabled path. */
export async function updateTaskStatus(
  chatId: string,
  taskId: string,
  executed: boolean
): Promise<boolean> {
  try {
    await taskRef(chatId, taskId).update({
      executed,
      updated_at: FieldValue.serverTimestamp(),
    });
    console.log(
      `Updated task ${taskId} in chat ${chatId} to executed=${executed}`
    );
    return true;
  } catch (e) {
    console.log(`Error updating task status: ${e}`);
    return false;
  }
}

/**
 * Mark a task failed, with retry backoff.
 *
 * Permanent (explicitly, or once `retry_count >= maxRetries`) sets `executed: true` **and**
 * `permanent_failure: true` — the pair is what lets later queries tell "ran successfully"
 * (`executed && !permanent_failure`) from "gave up" (`executed && permanent_failure`). Otherwise
 * the task is rescheduled with exponential backoff: `backoffMinutes * 2^(retryCount-1)`, i.e.
 * 10 → 20 → 40 minutes.
 */
export async function updateTaskFailure(
  chatId: string,
  taskId: string,
  failureReason: string,
  permanent = false,
  maxRetries = 3,
  backoffMinutes = 10
): Promise<boolean> {
  try {
    const ref = taskRef(chatId, taskId);
    const snap = await ref.get();
    const currentRetryCount = snap.exists
      ? Number((snap.data() ?? {}).retry_count ?? 0)
      : 0;
    const newRetryCount = currentRetryCount + 1;
    const isPermanent = permanent || newRetryCount >= maxRetries;

    if (isPermanent) {
      await ref.update({
        executed: true,
        permanent_failure: true,
        failed: true,
        status: 'permanently_failed',
        failure_reason: failureReason,
        retry_count: newRetryCount,
        failed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
      console.log(
        `Task ${taskId} permanently failed after ${newRetryCount} attempts: ${failureReason}`
      );
    } else {
      const actualBackoff = backoffMinutes * 2 ** (newRetryCount - 1);
      const nextExecuteAt = new Date(Date.now() + actualBackoff * 60_000);
      await ref.update({
        failed: true,
        failure_reason: failureReason,
        retry_count: newRetryCount,
        execute_at: nextExecuteAt,
        failed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
      console.log(
        `Task ${taskId} failed (attempt ${newRetryCount}/${maxRetries}), will retry in ` +
          `${actualBackoff} min at ${nextExecuteAt.toISOString()}: ${failureReason}`
      );
    }
    return true;
  } catch (e) {
    console.log(`Error updating task failure: ${e}`);
    return false;
  }
}

/** Delete a task. `false` when it does not exist or on error. */
export async function deleteTask(
  chatId: string,
  taskId: string
): Promise<boolean> {
  try {
    const ref = taskRef(chatId, taskId);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`Task ${taskId} not found in chat ${chatId}`);
      return false;
    }
    await ref.delete();
    console.log(`Deleted task ${taskId} from chat ${chatId}`);
    return true;
  } catch (e) {
    console.log(`Error deleting task: ${e}`);
    return false;
  }
}

/**
 * Delete every non-executed task of one type on a chat, returning the count deleted.
 * Each delete is individually guarded so one failure does not abandon the rest of the sweep.
 */
export async function deleteUnexecutedTasksByType(
  chatId: string,
  taskType: string
): Promise<number> {
  try {
    let deletedCount = 0;
    const snap = await chatRef(chatId)
      .collection('tasks')
      .where('type', '==', taskType)
      .where('executed', '==', false)
      .get();

    for (const task of snap.docs) {
      try {
        await task.ref.delete();
        deletedCount += 1;
      } catch (e) {
        console.log(`Error deleting task ${task.id}: ${e}`);
      }
    }

    if (deletedCount > 0) {
      console.log(
        `Deleted ${deletedCount} non-executed ${taskType} task(s) from chat ${chatId}`
      );
    }
    return deletedCount;
  } catch (e) {
    console.log(`Error deleting ${taskType} tasks for chat ${chatId}: ${e}`);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a label to `chat.labels`. `arrayUnion` makes this idempotent, which the callers rely on —
 * `not_interested` and `cadence_complete` may be applied repeatedly from different code paths.
 */
/**
 * Set (or clear) the chat's escalated flag — the field the FE's "escalated" tab filters on, and the one
 * every proactive path checks before scheduling anything.
 *
 * Best-effort: `false` on error rather than throwing, because every caller sets this alongside other
 * side effects it does not want to lose.
 */
export async function setEscalate(
  chatId: string,
  escalateStatus: boolean
): Promise<boolean> {
  if (!chatId) return false;
  try {
    await db
      .collection('chats')
      .doc(chatId)
      .set({ escalate: Boolean(escalateStatus) }, { merge: true });
    return true;
  } catch (e) {
    console.warn(`[chat] setEscalate failed for ${chatId}: ${e}`);
    return false;
  }
}

export async function addLabelToChat(
  chatId: string,
  label: string
): Promise<boolean> {
  try {
    await chatRef(chatId).update({
      labels: FieldValue.arrayUnion(label),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`Added label '${label}' to chat ${chatId}`);
    return true;
  } catch (e) {
    console.log(`Error adding label to chat: ${e}`);
    return false;
  }
}

/** Remove a label from `chat.labels`. */
export async function removeLabelFromChat(
  chatId: string,
  label: string
): Promise<boolean> {
  try {
    await chatRef(chatId).update({
      labels: FieldValue.arrayRemove(label),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`Removed label '${label}' from chat ${chatId}`);
    return true;
  } catch (e) {
    console.log(`Error removing label from chat: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unread count / knowledge sources
// ─────────────────────────────────────────────────────────────────────────────

/** Atomically bump `unread_count` when a customer message arrives. */
export async function incrementUnreadCount(chatId: string): Promise<boolean> {
  try {
    await chatRef(chatId).update({
      unread_count: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error(`Error incrementing unread count for chat ${chatId}: ${e}`);
    return false;
  }
}

/** Fetch a knowledge source doc by id, or `null`. Used to resolve attachment URLs. */
export async function getKnowledgeSource(
  knowledgeSourceId: string
): Promise<DocumentData | null> {
  try {
    const snap = await db
      .collection('knowledge_sources')
      .doc(knowledgeSourceId)
      .get();
    return snap.exists ? (snap.data() ?? null) : null;
  } catch (e) {
    console.log(`Error getting knowledge source: ${e}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rapid queue — the per-chat "a turn is already running" soft lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * These four are a *soft* lock: read-then-write, not a transaction, so two concurrent readers can
 * both see `is_processing == false`. The cron does not depend on it for correctness — that is what
 * the atomic dispatch claim and the one-task-per-chat-per-tick collapse are for. This only smooths
 * rapid inbound bursts.
 */
export async function getRapidQueue(chatId: string): Promise<unknown[]> {
  try {
    const snap = await chatRef(chatId).get();
    return snap.exists ? ((snap.data() ?? {}).rapid_queue ?? []) : [];
  } catch (e) {
    console.log(`Error getting rapid queue: ${e}`);
    return [];
  }
}

export async function clearRapidQueue(chatId: string): Promise<boolean> {
  try {
    await chatRef(chatId).update({
      rapid_queue: [],
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.log(`Error clearing rapid queue: ${e}`);
    return false;
  }
}

export async function addToRapidQueue(
  chatId: string,
  messageData: Record<string, unknown>
): Promise<boolean> {
  try {
    await chatRef(chatId).update({
      rapid_queue: FieldValue.arrayUnion(messageData),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.log(`Error adding to rapid queue: ${e}`);
    return false;
  }
}

export async function getRapidStatus(chatId: string): Promise<boolean> {
  try {
    const snap = await chatRef(chatId).get();
    return snap.exists ? Boolean((snap.data() ?? {}).is_processing) : false;
  } catch (e) {
    console.log(`Error getting rapid status: ${e}`);
    return false;
  }
}

export async function setRapidStatus(
  chatId: string,
  isProcessing: boolean
): Promise<boolean> {
  try {
    await chatRef(chatId).update({
      is_processing: isProcessing,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.log(`Error setting rapid status: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM usage log
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmUsageLog {
  agent_id: string;
  chat_id: string;
  action: string;
  processing_time_ms: number;
  system_prompt: string;
  chat_history: unknown[];
  tool_call_params?: Record<string, unknown>;
  tool_call_response?: Record<string, unknown>;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  model_version?: string;
  channel?: string;
}

/** Append a row to `llm_usage`. Optional tool fields are omitted when absent, as in the source. */
export async function logLlmUsage(entry: LlmUsageLog): Promise<boolean> {
  try {
    const logData: Record<string, unknown> = {
      agent_id: entry.agent_id,
      chat_id: entry.chat_id,
      action: entry.action,
      timestamp: FieldValue.serverTimestamp(),
      processing_time_ms: entry.processing_time_ms,
      system_prompt: entry.system_prompt,
      chat_history: entry.chat_history,
      input_tokens: entry.input_tokens ?? 0,
      output_tokens: entry.output_tokens ?? 0,
      total_tokens: entry.total_tokens ?? 0,
      cache_read_input_tokens: entry.cache_read_input_tokens ?? 0,
      cache_write_input_tokens: entry.cache_write_input_tokens ?? 0,
      model_version:
        entry.model_version ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      channel: entry.channel ?? 'unknown',
    };
    if (entry.tool_call_params)
      logData.tool_call_params = entry.tool_call_params;
    if (entry.tool_call_response)
      logData.tool_call_response = entry.tool_call_response;

    await db.collection('llm_usage').doc().set(logData);
    return true;
  } catch (e) {
    console.log(`Error logging LLM usage: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending calls — closes the race between placing a call and its webhook arriving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a call the instant it is placed, keyed by the provider's conversation id.
 *
 * Without this the post-call webhook can arrive before the turn has finished writing its messages,
 * and would have no way to find the conversation the call belongs to. `stage_at_time` is captured
 * here so the outcome lands in the right by-stage metric bucket even if the stage moves on.
 */
export async function savePendingCall(
  callId: string,
  chatId: string,
  agentId: string,
  toolUseId: string,
  phoneNumber: string,
  stageAtTime?: string
): Promise<void> {
  try {
    const data: Record<string, unknown> = {
      chat_id: chatId,
      agent_id: agentId,
      tool_use_id: toolUseId,
      phone_number: phoneNumber,
      created_at: new Date(),
    };
    if (stageAtTime) data.stage_at_time = stageAtTime;
    await db.collection('pending_calls').doc(callId).set(data);
    console.log(
      `[PENDING_CALLS] Saved pending call ${callId} for chat ${chatId} (stage=${stageAtTime})`
    );
  } catch (e) {
    console.error(`[PENDING_CALLS] Error saving pending call ${callId}: ${e}`);
  }
}

/** Look up a pending call by the provider conversation id. */
export async function getPendingCall(
  callId: string
): Promise<DocumentData | null> {
  try {
    const snap = await db.collection('pending_calls').doc(callId).get();
    return snap.exists ? (snap.data() ?? null) : null;
  } catch (e) {
    console.error(`[PENDING_CALLS] Error getting pending call ${callId}: ${e}`);
    return null;
  }
}

/** Delete a pending call once its outcome has been processed. */
export async function deletePendingCall(callId: string): Promise<void> {
  try {
    await db.collection('pending_calls').doc(callId).delete();
    console.log(`[PENDING_CALLS] Deleted pending call ${callId}`);
  } catch (e) {
    console.error(
      `[PENDING_CALLS] Error deleting pending call ${callId}: ${e}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a chat's `messages` in chronological order, normalized to canonical Bedrock blocks.
 *
 * With `limit`, fetches the most recent N **descending** and then reverses — the cheap way to get
 * the tail of a long history. Ordering survives because the writers stamp strictly increasing
 * millisecond timestamps within a batch.
 */
export async function getChatMessages(
  chatId: string,
  limit?: number,
  startAfterTimestamp?: Date
): Promise<BedrockMessage[]> {
  try {
    let query: Query = chatRef(chatId).collection('messages');

    if (startAfterTimestamp) {
      query = query.where('timestamp', '>=', startAfterTimestamp);
    }

    let docs;
    if (limit && Number.isInteger(limit) && limit > 0) {
      const snap = await query.orderBy('timestamp', 'desc').limit(limit).get();
      docs = snap.docs.slice().reverse();
    } else {
      const snap = await query.orderBy('timestamp').get();
      docs = snap.docs;
    }

    return docs.map((msg) => {
      const data = msg.data() ?? {};
      return {
        role: data.role as BedrockMessage['role'],
        content: cleanToolUseContent(data.content ?? []),
      };
    });
  } catch (e) {
    console.log(`Error getting messages: ${e}`);
    return [];
  }
}

/**
 * Write a turn's messages to `messages` and (unless `playground`) to the `messages_v3` /
 * `activities` / `notifications` read models.
 *
 * `messages` is the LLM-visible history; the others are what the UI renders. Both share one
 * `baseTimestamp` so the collections interleave consistently, and each message gets
 * `base + index` milliseconds so ordering is total.
 *
 * `baseTimestamp` exists so an inbound message keeps its true arrival time even when the turn it
 * triggers (plus nested tool calls) takes tens of seconds.
 *
 * Returns the written `messages` ids, or `null` if that batch failed.
 */
export async function addMessagesToChat(
  chatId: string,
  messagesDataList: unknown[],
  playground = false,
  baseTimestamp?: Date
): Promise<string[] | null> {
  try {
    const normalized = (messagesDataList ?? []).map((m) =>
      normalizeBedrockMessage(m)
    );
    const ref = chatRef(chatId);
    const messageIds: string[] = [];

    // N message writes + 1 chat update must fit one batch.
    const totalOperations = normalized.length + 1;
    if (totalOperations > BATCH_LIMIT) {
      throw new Error(
        `Cannot batch write more than ${BATCH_LIMIT} operations. Got ${totalOperations} ` +
          `operations (${normalized.length} messages + 1 update).`
      );
    }

    const base = baseTimestamp ?? new Date();
    const batch = db.batch();

    normalized.forEach((messageData, index) => {
      const messageDoc = ref.collection('messages').doc();
      batch.set(messageDoc, {
        role: messageData.role,
        content: messageData.content,
        timestamp: new Date(base.getTime() + index),
      });
      messageIds.push(messageDoc.id);
    });

    batch.update(ref, { updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();

    if (!playground) {
      // messages_v3 + activities + notifications. Guarded separately: a read-model fault must not
      // make the caller think the turn failed to persist, since `messages` is already committed.
      try {
        const { addMessagesV3AndActivities } =
          await import('./outboundChatMessages');
        await addMessagesV3AndActivities(chatId, normalized, base);
      } catch (e) {
        console.log(`[V3] Error writing messages_v3/activities: ${e}`);
      }
    }

    return messageIds;
  } catch (e) {
    console.log(`Error adding messages: ${e}`);
    return null;
  }
}

export { toDate };
