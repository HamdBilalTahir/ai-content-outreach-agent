/**
 * Outbound phone-screening gate at enrollment — Full Scrub, and (nominally) CNAM.
 *
 * Called once per contact from the enrollment loop. Decides whether the phone (voice) channel must be
 * blocked, and persists the evidence on the chat ROOT document so the decision is auditable later.
 *
 * Decision, after the DNC scrub:
 *  1. Full Scrub NOT clean (DNC / litigator / internal / blocked / invalid / VoIP) → BLOCK.
 *  2. Clean → ALLOW, on any line type.
 *
 * ## The CNAM gate is disabled, on purpose
 *
 * `decide()` is ported and tested, but `screenPhoneAtEnroll` does not call it. CNAM returned
 * `"unknown"` for very nearly every number, which — especially in `business_only` mode, where unknown
 * fails closed — blocked almost every DNC-clean lead. It is kept intact rather than deleted so
 * re-enabling is a one-line change once CNAM coverage is reliable. The DNC/litigator/VoIP suppression
 * from the Full Scrub is unaffected and is doing the real work.
 *
 * `record_type == "test"` bypasses everything. Fail-open throughout: this never throws and returns
 * `false` (allow) on any error, because the call-time gate is the backstop.
 */

import { isEnabled } from '../firebase/featureFlags';
import { db } from '../firebase/db';
import * as dncFullScrub from './dncFullScrub';
import type { LineType } from './dncFullScrub';
import type { CallerType } from './twilioCallerType';

export const FULL_SCRUB_FLAG = 'full_scrub_gate';

/**
 * Optional agent scope. Empty means all outbound enrollments, which is the current configuration;
 * populate with agent ids to narrow the gate to specific senders.
 */
export const SCOPED_OUTBOUND_AGENT_IDS: ReadonlySet<string> = new Set();

/** Line types on which an `unknown` caller type is still allowed — business not required. */
const UNKNOWN_ALLOWED_LINE_TYPES: ReadonlySet<string> = new Set(['landline']);

function nowIso(): string {
  return new Date().toISOString();
}

/** Merge flat fields onto the chat ROOT document. Best-effort. */
async function persist(
  chatId: string,
  fields: Record<string, unknown>
): Promise<void> {
  try {
    await db.collection('chats').doc(chatId).set(fields, { merge: true });
  } catch (e) {
    console.warn(`[PHONE_SCREEN] persist failed for ${chatId}: ${e}`);
  }
}

/**
 * True iff the phone must be BLOCKED, given a CLEAN DNC result.
 *
 * `businessOnly` fails CLOSED: a number passes only if it is a confirmed business — CNAM
 * `caller_type === 'business'`, or listed on the company website. Line type is NOT consulted in that
 * mode, because a business number on any line type is fine. Consumer or unknown, and not on the
 * website, blocks.
 *
 * Outside `businessOnly`, `unknown` is allowed on a landline only — a mobile or VoIP number with no
 * name on file is the shape most likely to be a private individual.
 *
 * Currently unused by `screenPhoneAtEnroll`; see the module docstring.
 */
export function decide(
  lineType: LineType | string | null | undefined,
  callerType: CallerType | string | null | undefined,
  businessOnly = false,
  websiteVerified = false
): boolean {
  if (businessOnly) {
    if (callerType === 'business') return false;
    if (websiteVerified) return false; // listed on the company website, any line type
    return true;
  }
  if (callerType === 'business') return false;
  if (callerType === 'consumer') return true;
  return !UNKNOWN_ALLOWED_LINE_TYPES.has(String(lineType ?? ''));
}

export interface ScreenOptions {
  recordType?: string;
  companyId?: string;
  /**
   * A per-campaign toggle: run the gate REGARDLESS of the global `full_scrub_gate` flag, and require
   * a confirmed-business decision. The campaign toggle is itself the kill-switch, which is why the
   * flag check is skipped for it.
   */
  businessOnly?: boolean;
  /** This phone was found on the company website — passes regardless of line type. */
  websiteVerified?: boolean;
}

/**
 * Screen a phone at enrollment. Returns `true` iff the phone channel must be BLOCKED, at which point
 * the caller sets `phone_opt_out`.
 *
 * Persists `dnc_scrub_output` plus the scalar signals on the chat root. Never throws — fail-open to
 * `false`.
 */
export async function screenPhoneAtEnroll(
  chatId: string,
  phone: string,
  agentId: string,
  opts: ScreenOptions = {}
): Promise<boolean> {
  const { recordType = 'Real', businessOnly = false } = opts;

  try {
    // Kill-switch, skipped for business_only campaigns — the campaign toggle IS the switch.
    // A flag that cannot be read counts as off: skip screening rather than block every lead.
    if (!businessOnly) {
      if (!(await isEnabled(FULL_SCRUB_FLAG))) return false;
    }

    // Test records bypass all real scrubbing.
    if (
      String(recordType ?? '')
        .trim()
        .toLowerCase() === 'test'
    ) {
      await persist(chatId, {
        dnc_scrub_output: { skipped: 'test' },
        dnc_scrub_checked_at: nowIso(),
      });
      return false;
    }

    const p = dncFullScrub.normalizePhone(phone ?? '');
    if (p.length !== 10) return false;

    // Optional agent scope.
    if (
      SCOPED_OUTBOUND_AGENT_IDS.size > 0 &&
      !SCOPED_OUTBOUND_AGENT_IDS.has(String(agentId ?? ''))
    ) {
      return false;
    }

    // Full Scrub — DNC, litigator, line type, and the raw output.
    const scrub = await dncFullScrub.fullScrub(p);
    const fields: Record<string, unknown> = {
      dnc_scrub_output: scrub.raw,
      dnc_result_code: scrub.result_code,
      dnc_reason: scrub.reason,
      line_type: scrub.line_type,
      dnc_scrub_checked_at: nowIso(),
    };
    // Mark litigator status only when the scrub was actually conclusive — an inconclusive scrub must
    // not record a litigator PASS it never established.
    if (scrub.is_clean !== null || scrub.result_code) {
      fields.litigator_passed = !scrub.is_litigator;
      fields.litigator_checked_at = nowIso();
    }

    // Not clean → block. Short-circuits before CNAM, which also saves the lookup spend.
    if (scrub.is_clean === false) {
      await persist(chatId, fields);
      console.log(
        `[PHONE_SCREEN] BLOCK chat=${chatId} ***${p.slice(-4)} dnc=${scrub.result_code} reason=${scrub.reason}`
      );
      return true;
    }

    // Clean → ALLOW on any line type. The CNAM gate is disabled; see the module docstring.
    const blocked = false;
    await persist(chatId, fields);
    console.log(
      `[PHONE_SCREEN] ALLOW (clean; CNAM disabled) chat=${chatId} ***${p.slice(-4)} line=${scrub.line_type}`
    );
    return blocked;
  } catch (e) {
    console.warn(`[PHONE_SCREEN] screening skipped for ${chatId}: ${e}`);
    return false;
  }
}
