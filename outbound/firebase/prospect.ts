/**
 * Prospect stage machine — the funnel position every outbound gate reads.
 *
 * `chat.stage` drives real behavior across the flow: cadence exhaustion only applies while the
 * prospect shows no engagement (`'' | New | Contacted`), the campaign archive sweep spares
 * `Engaged`/`Lead` chats, and `Lost` is terminal for proactive outreach. So the *transition rules*
 * here are load-bearing, and they are ported exactly:
 *
 *  1. An empty stage is rejected.
 *  2. Setting the stage a chat is already in is a no-op that reports success.
 *  3. **Lead is a lock.** Once a chat reaches `Lead`, `stage` never changes again. Anything sent
 *     afterwards — `CRM Won`, `Lost`, a custom CRM stage, even a backwards `Contacted` — is
 *     recorded as `sub_stage` instead. This is what makes Lead counts monotonic.
 *  4. A post-Lead stage arriving at a chat that never reached `Lead` (a CRM sync delivering an
 *     already-won record) promotes to `Lead` first, then records the value as its sub-stage.
 *  5. Forward-only within the funnel, with `Lost` reachable from anywhere and terminal.
 *
 * ## Deliberately not ported: the dealer-analytics subsystem
 *
 * The source's `set_prospect_stage` also drove `update_stage_analytics`,
 * `record_lead_origin_source`, `decrement_crm_won_count`, `update_prospect_stage_on_metrics`, and
 * mirrored every write onto an `appraisals` subcollection. All of that is the inbound product's
 * per-dealer, per-vehicle reporting layer: it aggregates into dealer/company counter documents,
 * and `appraisals` is the vehicle-appraisal model, which has no outbound equivalent (outbound
 * contacts are vehicle-less B2B prospects). No outbound code path reads any of it.
 *
 * What that means in practice: the `dealersId` / `companyId` arguments are accepted so call sites
 * stay identical to the source, and they are recorded in the transition, but no counter documents
 * are written. If outbound reporting is wanted later it should be built against `stage_history`,
 * which this module does maintain in full.
 */

import { FieldValue, db } from './db';

/** Canonical funnel order. Forward-only enforcement and the Lead lock are defined against this. */
export const STAGE_ORDER: Readonly<Record<string, number>> = {
  New: 0,
  Contacted: 1,
  Engaged: 2,
  Lead: 3,
  'Pushed to CRM': 4,
  'CRM Won': 5,
};

export const VALID_STAGES: ReadonlySet<string> = new Set([
  ...Object.keys(STAGE_ORDER),
  'Lost',
]);

/**
 * Stages that only exist after `Lead`. Receiving one on a pre-Lead chat promotes to `Lead` first,
 * because "Lead and all its sub-stages belong to Lead".
 */
export const POST_LEAD_STAGES = [
  'Pushed to CRM',
  'CRM Won',
  'inspection_completed',
] as const;

/** The sub-stage stamped when a chat first becomes a Lead, so every Lead carries one. */
export const BASELINE_SUB_STAGE = 'new';

/**
 * Canonical value aliases applied when a sub-stage is WRITTEN, so no caller can fragment the
 * buckets — an older client's `"won"` becomes `crm_won`.
 */
export const SUB_STAGE_VALUE_ALIASES: Readonly<Record<string, string>> = {
  won: 'crm_won',
};

/**
 * Normalize a stage name into a Firestore-safe field key.
 * Field paths cannot contain spaces, so `"CRM Won"` must become `crm_won`. Single-word stages are
 * unchanged (`"New"` → `"new"`), which keeps this backward-compatible.
 */
export function stageKey(stage: unknown): string {
  return String(stage ?? '')
    .toLowerCase()
    .replace(/ /g, '_');
}

function chatRef(chatId: string) {
  return db.collection('chats').doc(chatId);
}

/**
 * Record a post-Lead state as `sub_stage`, leaving `stage` locked at `Lead`.
 *
 * Values are stored as slugs (`"CRM Won"` → `crm_won`). Writes `sub_stage`,
 * `sub_stage_entered_at`, `sub_stage_history` and `memory.sub_stage` (the last so LLM tools can
 * read it without a second lookup). `CRM Won` additionally stamps an entry time, which is what a
 * later net-count reversal would key on.
 *
 * @returns `true` when set or when it was a same-value no-op; `false` on error.
 */
export async function setProspectSubStage(
  chatId: string,
  subStage: string,
  trigger: string,
  lostReason?: string,
  chatData?: Record<string, unknown> | null
): Promise<boolean> {
  try {
    if (!subStage || !String(subStage).trim()) {
      console.log('[ProspectAnalytics] Empty sub_stage rejected');
      return false;
    }

    let key = stageKey(String(subStage).trim());
    key = SUB_STAGE_VALUE_ALIASES[key] ?? key;

    const ref = chatRef(chatId);
    let data = chatData;
    if (!data) {
      const snap = await ref.get();
      if (!snap.exists) {
        console.log(`[ProspectAnalytics] Chat ${chatId} not found`);
        return false;
      }
      data = snap.data() ?? {};
    }

    const memory = (data.memory ?? {}) as Record<string, unknown>;
    const prevSubStage =
      stageKey(String(data.sub_stage ?? memory.sub_stage ?? '')) || null;

    if (prevSubStage === key) {
      console.log(
        `[ProspectAnalytics] Chat ${chatId} already in sub_stage ${key}, skipping`
      );
      return true;
    }

    const now = new Date();
    const updateData: Record<string, unknown> = {
      sub_stage: key,
      sub_stage_entered_at: now,
      sub_stage_history: FieldValue.arrayUnion({
        from_sub_stage: prevSubStage,
        to_sub_stage: key,
        timestamp: now,
        trigger,
      }),
      'memory.sub_stage': key,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (key === 'lost') updateData.lost_reason = lostReason || 'unknown';

    // CRM Won entry/exit bookkeeping: stamp on enter, clear on leave.
    if (key === 'crm_won') updateData['memory.crm_won_entered_at'] = now;
    else if (prevSubStage === 'crm_won') {
      updateData['memory.crm_won_entered_at'] = FieldValue.delete();
    }

    await ref.update(updateData);
    console.log(
      `[ProspectAnalytics] Chat ${chatId} sub_stage: ${prevSubStage ?? '(none)'} → ${key} ` +
        `(trigger: ${trigger})`
    );
    return true;
  } catch (e) {
    console.log(
      `[ProspectAnalytics] Error setting sub_stage for chat ${chatId}: ${e}`
    );
    return false;
  }
}

/**
 * Set a prospect's stage, applying the transition rules in the module docstring.
 *
 * @param enforceForwardOnly When false, any transition is allowed except a same-stage no-op. Used
 *   by the internal promote-to-Lead step, which must be able to jump the funnel.
 * @returns `true` when set or skipped; `false` when the transition was rejected or errored.
 */
export async function setProspectStage(
  chatId: string,
  newStage: string,
  trigger: string,
  dealersId?: string | null,
  companyId?: string | null,
  lostReason?: string,
  enforceForwardOnly = true
): Promise<boolean> {
  try {
    // Any non-empty stage name is allowed: the frontend or an external CRM can push custom stages
    // beyond the built-in funnel. Forward-only ordering only applies to known stages.
    if (!newStage || !String(newStage).trim()) {
      console.log('[ProspectAnalytics] Empty stage rejected');
      return false;
    }

    const ref = chatRef(chatId);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`[ProspectAnalytics] Chat ${chatId} not found`);
      return false;
    }

    const chatData = snap.data() ?? {};
    const currentStage = String(chatData.stage ?? '');

    // Same stage = no-op.
    if (currentStage === newStage) {
      console.log(
        `[ProspectAnalytics] Chat ${chatId} already in ${newStage}, skipping`
      );
      return true;
    }

    // ── Lead stage lock ──
    // Once a chat is a Lead, `stage` never changes again; everything else becomes a sub-stage, so
    // the Lead count is never decremented.
    if (currentStage === 'Lead') {
      return setProspectSubStage(
        chatId,
        newStage,
        trigger,
        lostReason,
        chatData
      );
    }

    // A post-Lead state on a chat that never reached Lead: promote to Lead first (so the funnel
    // analytics are right), then record the value as its sub-stage.
    if ((POST_LEAD_STAGES as readonly string[]).includes(newStage)) {
      const promoted = await setProspectStage(
        chatId,
        'Lead',
        trigger,
        dealersId,
        companyId,
        undefined,
        false
      );
      if (!promoted) return false;
      return setProspectSubStage(chatId, newStage, trigger, lostReason);
    }

    if (enforceForwardOnly) {
      // Lost is terminal — reject everything out of it.
      if (currentStage === 'Lost') {
        console.log(
          `[ProspectAnalytics] Chat ${chatId} is Lost (terminal), rejecting → ${newStage}`
        );
        return false;
      }

      if (newStage === 'Lost') {
        // Always allowed from any funnel stage.
      } else if (
        currentStage &&
        currentStage in STAGE_ORDER &&
        newStage in STAGE_ORDER &&
        STAGE_ORDER[newStage] <= STAGE_ORDER[currentStage]
      ) {
        console.log(
          `[ProspectAnalytics] Rejected backward: ${currentStage} → ${newStage}`
        );
        return false;
      }
    }

    const now = new Date();
    const updateData: Record<string, unknown> = {
      stage: newStage,
      stage_entered_at: now,
      stage_history: FieldValue.arrayUnion({
        from_stage: currentStage || null,
        to_stage: newStage,
        timestamp: now,
        trigger,
        // Recorded on the transition rather than aggregated into counter documents — see the
        // module docstring on the omitted analytics subsystem.
        dealers_id: dealersId ?? null,
        company_id: companyId ?? null,
      }),
      updatedAt: FieldValue.serverTimestamp(),
      // Mirrored into memory so LLM tools can read the stage without a second lookup.
      'memory.current_stage': newStage,
    };

    if (newStage === 'Lost') updateData.lost_reason = lostReason || 'unknown';

    if (newStage === 'CRM Won') updateData['memory.crm_won_entered_at'] = now;
    else if (currentStage === 'CRM Won') {
      updateData['memory.crm_won_entered_at'] = FieldValue.delete();
    }

    await ref.update(updateData);
    console.log(
      `[ProspectAnalytics] Chat ${chatId}: ${currentStage || '(none)'} → ${newStage} ` +
        `(trigger: ${trigger})`
    );

    // Baseline sub_stage: every Lead carries one, so sub-stage occupancy always sums to the Lead
    // count regardless of which path made the chat a Lead. Non-blocking.
    try {
      const existingSub =
        chatData.sub_stage ??
        ((chatData.memory ?? {}) as Record<string, unknown>).sub_stage;
      if (newStage === 'Lead' && !existingSub) {
        await setProspectSubStage(chatId, BASELINE_SUB_STAGE, trigger);
      }
    } catch (e) {
      console.log(
        `[ProspectAnalytics] Baseline sub_stage stamp failed (non-blocking): ${e}`
      );
    }

    return true;
  } catch (e) {
    console.log(
      `[ProspectAnalytics] Error setting stage for chat ${chatId}: ${e}`
    );
    return false;
  }
}

/** Atomically increment `contact_attempts` on a chat. */
export async function incrementContactAttempts(chatId: string): Promise<void> {
  try {
    await chatRef(chatId).update({
      contact_attempts: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.log(
      `[ProspectAnalytics] Error incrementing contact_attempts: ${e}`
    );
  }
}
