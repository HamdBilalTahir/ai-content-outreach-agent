# Outbound agent port — plan of record

Porting `ai-sales-backend/outbound_agent` (a 37,241-line Django app; ~25,000 lines production,
~12,000 lines tests) to TypeScript under `outbound/`.

This file is the plan of record. It was reconstructed from the source tree and has been **revised
twice from reading the source** — both revisions are recorded below, because the dependency facts
that forced them are the expensive part to rediscover.

## Ground rules

- **One phase = one commit = one CHANGE-LOGS.md entry.** Verified before commit: `tsc --noEmit`
  clean, `eslint outbound/` clean, full Jest suite green.
- **Nothing is stubbed.** A function whose dependency lands in a later phase is left _absent_ and
  recorded under that phase's "arrives with" list. A dynamic import of a module that does not exist
  yet would degrade silently through the source's own best-effort `catch`, which is worse than a
  visible gap.
- **Fail directions are preserved verbatim and documented per function.** They are deliberately
  inconsistent across modules (see below) and a later "consistency" cleanup would break one.
- **Behaviour is preserved over tidiness.** Where the source does something surprising, the port
  pins it with a test and records _why_ on the function. Two such cases so far, both listed below.

## Status

| Phase | Scope                                      | Source lines | Commit    |
| ----- | ------------------------------------------ | ------------ | --------- |
| 0     | Scaffolding, config, types, Firestore seam | —            | `ac2e775` |
| 1     | Data-access layer (`outbound/firebase/*`)  | —            | `c939110` |
| 2     | Deterministic gating layer                 | ~2,200       | `535b545` |
| 3     | Outbound chat state & gate layer           | 1,508        | `82cee65` |
| 4     | Compliance & guard services                | ~1,740       | `efe5e34` |
| 5     | Campaign lifecycle                         | ~2,050       | `PHASE5`  |
| 6     | Email pipeline                             | ~2,500       | —         |
| 7     | Voice                                      | ~5,000       | —         |
| 8     | LLM turn engine                            | ~4,400       | —         |
| 9     | HubSpot / CRM                              | ~2,700       | —         |
| 10    | HTTP surface & backfills                   | ~1,500       | —         |

Current: **783 tests / 18 suites**, `tsc` and `eslint` clean.

## Plan revisions (and why)

1. **`services/chat.py` was missing entirely.** The original plan folded the guard services into
   Phase 3. Reading `not_interested.py` showed it imports `outbound_agent/services/chat.py` — 1,508
   lines that are the dependency root for the cron, the campaign pacer, and every send tool. It
   became Phase 3 on its own and everything after shifted by one.
2. **`conversation_summary.py` cannot ship with Phase 5.** It calls
   `outbound_agent.llm.ask.generate_text`, so it moves to Phase 8 with the LLM layer.
3. **`finalizeUnresolvedCall` / `reconcileStalePendingCalls` arrived in Phase 5, not Phase 7.** Both
   were deferred out of Phase 3 pending `voiceConcurrency` (which landed in Phase 4) and
   `stalledRecovery` (Phase 5), so by Phase 5 both dependencies existed. They also moved OUT of
   `services/chat.ts` into `stalledRecovery.ts`: they are mutually dependent with
   `ensureNextStepAfterCall`, a cycle the source breaks with lazy imports and co-location removes.

Expect more of these. The source's import graph is not the directory structure.

## Remaining phases

### Phase 5 — campaign lifecycle (~2,050 lines) — ✅ DONE

`campaigns.py` (687) · `enroll.py` (432) · `cron.py` (423) · `stalled_recovery.py` (288) ·
`reminders.py` (216)

Dependencies are all satisfied except the HubSpot seam. `reminders.py` is fully portable now
(`scheduling`, `chat`, `firebase/chat`, and the skills resolver are all in place).

**The enroll HubSpot seam.** `enroll_contact` makes five HubSpot calls — `ensure_meeting_host`,
`resolve_hubspot_config`, `stamp_contact_number_type`, `stamp_contact_campaign`,
`sync_hubspot_stage` — plus `mark_contacted` calls `stamp_contact_contacted`. Every one is
`try/except`-wrapped best-effort CRM _mirroring_: none affects the enrollment outcome (chat created,
memory seeded, gates applied, lane resolved, task scheduled). Port enrollment complete without them
and add them in Phase 9. This is a real seam, not a shortcut.

`conversation_summary.py` → Phase 8.

### Phase 6 — email pipeline (~2,500 lines)

`email_sender.py` (495) · `email_review.py` (361) · `inbound_email_nudge.py` (422) ·
`inbound_booking_email.py` (233) · `sendgrid_mail.py` (168) · `tools/email.py` (385) ·
`views/email_webhook.py` (471) · `views/email_compliance.py` (278)

**Arrives with this phase:** `reputation.emailDailySummary` — deferred out of Phase 4 because it
needs `sendgrid_mail.resolve_sendgrid_config` to read each domain's per-agent warm-up ramp.

### Phase 7 — voice (~5,000 lines)

`tools/make_phone_call.py` (1,975) · `tools/review_call_transcript.py` (1,683) ·
`elevenlabs_agent_service.py` (1,189) · `elevenlabs.py` (96) · `referral_transfer.py` (162) ·
`views/elevenlabs_webhook.py` (242) · `views/conversation_init_webhook.py` (207) ·
`views/voice_settings.py` (150) · `views/voice_connect.py` (53)

**Arrives with this phase**, deferred out of Phase 3 (both need `voice_concurrency.releaseVoiceSlot`
and `stalled_recovery.ensureNextStepAfterCall`):

- `chat.finalizeUnresolvedCall`
- `chat.reconcileStalePendingCalls`

Their pure predicate `callAwaitingReview` is already ported and tested.

Also the deferred half of `services/call_scope.py` — everything except
`buildPhoneConsentAskLine`, which shipped in Phase 2. The remainder is voice-prompt assembly
(`build_outbound_call_scope`, `build_voice_scheduling_block`, `outbound_call_context`, and the
inbound-scope twins).

### Phase 8 — LLM turn engine (~4,400 lines)

`llm/run.py` (1,892) · `llm/ask.py` (1,350) · `call_llm_outbound.py` (1,105) · the task/stage tools
(`create_custom_task` 260, `update_custom_task` 120, `delete_custom_task` 57,
`mark_prospect_lost` 180, `mark_cadence_complete` 103, `clear_not_interested` 56)

**Arrives with this phase:** `conversation_summary.py`, moved out of Phase 5.

### Phase 9 — HubSpot / CRM (~2,700 lines)

`services/hubspot.py` (2,235) · `views/hubspot_discovery.py` (256) · `views/deal_funnel.py` (84) ·
`tools/schedule_hubspot_meeting.py` (109) · `tools/get_hubspot_available_slots.py` (45)

**Arrives with this phase:**

- `chat.ensureMeetingHost`, deferred out of Phase 3. Its pure half `meetingHostFact` is ported.
- The six enrollment/contacted CRM stamps deferred out of Phase 5 (see the enroll seam above).

### Phase 10 — HTTP surface & backfills (~1,500 lines)

`urls.py` (99) · `serializers.py` (90) · remaining `views/` (`campaigns` 227,
`dnc_area_codes` 78, `task_cron_job` 40, `initiate_outbound_webhook` 43, `__init__` 52) ·
`management/commands/` (7 backfills + `reconcile_stale_calls`)

Thin once everything beneath it exists, which is why it is last.

## Deferral ledger

Every function knowingly absent from the port, and where it lands. Nothing else is missing.

| Deferred                              | Out of | Into | Blocked on                                         |
| ------------------------------------- | ------ | ---- | -------------------------------------------------- |
| `chat.ensureMeetingHost`              | 3      | 9    | `hubspot.resolveHubspotConfig`, `resolveOwnerName` |
| ~~`chat.finalizeUnresolvedCall`~~     | 3      | 5 ✅ | landed early — deps arrived in Phase 4/5           |
| ~~`chat.reconcileStalePendingCalls`~~ | 3      | 5 ✅ | landed early, same reason                          |
| `callScope` (voice-prompt half)       | 2      | 7    | voice prompt assembly                              |
| `reputation.emailDailySummary`        | 4      | 6    | `sendgridMail.resolveSendgridConfig`               |
| `conversationSummary`                 | 5      | 8    | `llm.ask.generateText`                             |
| enroll's 6 HubSpot stamps             | 5      | 9    | `services/hubspot`                                 |
| `cron` email daily summary            | 5      | 6    | `sendgridMail.resolveSendgridConfig`               |
| `cron` turn runner (injected)         | 5      | 8    | `llm.run.runOutboundLlm` — a parameter, not absent |
| `resolveAudiencePage` HubSpot sources | 5      | 9    | HubSpot contact-fetch layer                        |

## Deliberate divergences from the source

Recorded here and in the relevant module docstring.

- **`messages_v2` is not ported** (Phase 1). Redundant for outbound — every field exists in
  `messages_v3`. Dropping it removed three live defects: a double `unread_count` increment, a v2
  timestamp that drifted from the turn's `base_timestamp` by the turn duration, and a `toolResult`
  with no matching `toolUse` raising and abandoning the whole batch.
- **The dealer-analytics subsystem behind `set_prospect_stage` is not ported** (Phase 1). It is the
  inbound product's per-dealer reporting layer; `appraisals` has no outbound equivalent and no
  outbound path reads any of it. The `dealersId`/`companyId` arguments are still accepted and
  recorded, so call sites match and `stage_history` stays complete.
- **`filter_tasks_within_window` is not ported** (Phase 1). It appears only in source comments; the
  cron implements its own overdue-safe filter.
- **Holiday detection uses `date-holidays`**, not the Python `holidays` package (Phase 2). Fail-open
  contract and federal/state split preserved; exact date parity is not guaranteed and not asserted.
- **The CNAM gate is ported but not called** (Phase 4). `phoneScreening.decide` is intact and tested;
  CNAM returned `"unknown"` for very nearly every number, which in `business_only` mode blocked
  almost every DNC-clean lead. Re-enabling is one line.

## Bug fixed in the port

`voiceConcurrency` (Phase 4) wrote its whole live-slot map back with `set(..., merge=True)` and
commented that this "purges expired slots atomically too". It does not — Firestore merges map fields
**recursively**, so keys absent from the payload survive. `active_slots` accumulated one dead entry
per chat ever dialed, growing without bound toward the 1MB document limit. The cap was never wrong
(the live-slot filter runs on read), which is exactly why it was invisible. Reserve and reconcile now
use dot-path `FieldValue.delete()`, achieving what the comment intended.

The source's own stated intent was the spec. That is the bar for changing behaviour: not "this looks
wrong" but "this does not do what it says it does".

## Fail directions

These are inconsistent **on purpose**, each chosen for an asymmetric cost. Asserted individually in
the suites. Do not normalize them.

| Function                               | Direction | Why                                                                                                              |
| -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `taskDispatch.claimTask`               | CLOSED    | A skipped tick is cheap; a duplicate outbound call is not.                                                       |
| `scheduling.hasPendingProactiveTask`   | CLOSED    | Callers read `false` as "cadence stalled, schedule another touch".                                               |
| `suppression.isSuppressed`             | CLOSED    | Mailing an address whose state we could not read is worse than not mailing.                                      |
| `voiceConcurrency.tryReserveVoiceSlot` | CLOSED    | The cap is absolute; a skipped dial reschedules. No bypass.                                                      |
| `reputation.consumeDomainBudget`       | CLOSED    | A reputation control, not a rate control.                                                                        |
| `rateLimit.tryConsume`                 | OPEN      | A limiter fault must never stop the flow from sending.                                                           |
| `businessHours.checkBusinessHours`     | OPEN\*    | A guard that throws stops all outreach. \*Except: an unknown timezone **tightens** the window.                   |
| `dncFullScrub`, `verification`         | OPEN      | A vendor outage must not halt outreach. Note `is_clean: null` (inconclusive) ≠ `false` (scrubbed, blocked).      |
| `featureFlags.isEnabled`               | CLOSED    | In `phoneScreening` this _skips_ screening rather than blocking every lead — the call-time gate is the backstop. |

`verification` with **no provider key configured treats an MX pass as a pass**. The provider is a
quality upgrade, never a prerequisite: a missing key cannot halt all mail.

## Test-double notes

`outbound/testSupport/mockFirestore.ts` implements only the operations the ported code uses and
throws on anything else, so an unsupported call fails loudly. Three gaps have surfaced, each found
because a **fail-soft code path made the missing method look like passing code**:

- `collection().listDocuments()` — absence made `upsertAreaCodes` restamp `created_at` on every write.
- `doc().create()` — absence made `getOrCreateOutboundChat` write nothing at all; the throw was
  swallowed by the source's concurrent-create-race `catch`.
- Map-field merge semantics — the double's faithful recursive `deepMerge` is what exposed the
  `voiceConcurrency` defect above.

When a new phase's suite passes suspiciously easily against a best-effort function, check the double
first.
