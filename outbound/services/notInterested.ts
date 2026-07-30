/**
 * The outbound "not interested" handler — the customer declined the deal.
 *
 * This is deliberately distinct from BOTH of the things it is most likely to be confused with:
 *  - the **`Lost` stage** (terminal, set by the stage tools) — the stage is NOT touched here; and
 *  - the **consent opt-out flags** (`phone_opt_out` / `email_opt_out` / `sms_opt_out` /
 *    `block_phone`) — those encode the customer's consent to be contacted, not our business read of
 *    the conversation, so they are left alone. Declining a deal is NOT an opt-out.
 *
 * "Not interested" is a LABEL on the chat document (`chat.labels[]`, code-owned and therefore
 * trustworthy). It stops PROACTIVE outreach only: the cron skips a labelled chat and no new proactive
 * task is created. An inbound reply is intentionally still answerable — the send tools are NOT gated
 * on this label — so the customer can re-open the conversation themselves.
 *
 * Triggered deterministically from the review tools when they detect the decline signal, not by the
 * model deciding to call it.
 */

import { db } from '../firebase/db';
import { addLabelToChat, deleteTask, setMemory } from '../firebase/chat';
import { NOT_INTERESTED_LABEL, isNotInterested, loadChatDoc } from './chat';

export interface NotInterestedResult {
  ok: boolean;
  error?: string;
  chat_id?: string;
  labelled?: boolean;
  cancelled_tasks?: number;
  already?: boolean;
  reason?: string;
  source?: string;
}

/**
 * Delete every not-yet-executed task so the cron fires nothing further — including a retrying
 * close-out email. Best-effort; returns the count deleted.
 */
async function cancelPendingTasks(chatId: string): Promise<number> {
  let n = 0;
  try {
    const snap = await db
      .collection('chats')
      .doc(chatId)
      .collection('tasks')
      .where('executed', '==', false)
      .get();
    for (const t of snap.docs) {
      try {
        if (await deleteTask(chatId, t.id)) n += 1;
      } catch (e) {
        console.warn(
          `[NOT_INTERESTED] deleteTask ${t.id} failed for ${chatId}: ${e}`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[NOT_INTERESTED] listing pending tasks failed for ${chatId}: ${e}`
    );
  }
  return n;
}

/**
 * Label the chat `not_interested` and stop proactive outreach.
 *
 * Idempotent and best-effort: each side effect is wrapped so one failure never blocks the rest. Does
 * NOT change the prospect stage, does NOT mark the prospect lost, and does NOT set any opt-out flag.
 */
export async function handleNotInterested(
  chatId: string,
  reason = 'customer_said_not_interested',
  source = 'review'
): Promise<NotInterestedResult> {
  if (!chatId) return { ok: false, error: 'no chat_id' };

  let already = false;
  try {
    already = isNotInterested(await loadChatDoc(chatId));
  } catch {
    // Reporting `already` is informational; failing to read it must not block the handler.
  }

  // 1. The label — the marker AND the gate source. ArrayUnion makes it idempotent.
  let labelled = false;
  try {
    await addLabelToChat(chatId, NOT_INTERESTED_LABEL);
    labelled = true;
  } catch (e) {
    console.warn(`[NOT_INTERESTED] addLabel failed for ${chatId}: ${e}`);
  }

  // 2. Cancel anything already queued, stopping the in-flight proactive cadence immediately.
  const cancelled = await cancelPendingTasks(chatId);

  // 3. A memory marker for prompt/UI visibility. NOT a gate — the label is the gate.
  try {
    await setMemory(chatId, {
      _not_interested: true,
      _not_interested_at: new Date().toISOString(),
      _not_interested_reason: reason,
      _not_interested_source: source,
    });
  } catch (e) {
    console.warn(
      `[NOT_INTERESTED] memory marker write failed for ${chatId}: ${e}`
    );
  }

  console.log(
    `[NOT_INTERESTED] chat=${chatId} labelled=${labelled} cancelled_tasks=${cancelled} ` +
      `reason=${reason} source=${source} (stage + opt-outs untouched)`
  );
  return {
    ok: true,
    chat_id: chatId,
    labelled,
    cancelled_tasks: cancelled,
    already,
    reason,
    source,
  };
}
