# Outbound agent port — plan of record

Porting `ai-sales-backend/outbound_agent` (a 37,241-line Django app; ~25,000 lines production,
~12,000 lines tests) to TypeScript under `outbound/`.

This file is the plan of record. It was reconstructed from the source tree and has been **revised seven
times from reading the source** — every revision is recorded below, because the dependency facts that
forced them are the expensive part to rediscover.

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
  pins it with a test and records _why_ on the function. The bar for changing behaviour is not "this
  looks wrong" but "this does not do what it _says_ it does" — see the bug-fix section.
- **A phase's own tests are suspect too.** Eight increments so far had a failing test whose FIXTURE was
  invented rather than read from the source or the ported helper. Check which of the two is wrong
  before touching either.
- **A mock that does not honour its real contract makes a test that proves nothing.** `generateText`
  MUTATES the caller's message list (`messages.push(cleaned)` is the documented loop contract); a plain
  value mock produced a history the loop never sees in production, and a passing test that asserted
  nothing. When mocking a collaborator, port its side effects too, not just its return value.

## Status

| Phase | Scope                                             | Source lines | Commit    |
| ----- | ------------------------------------------------- | ------------ | --------- |
| 0     | Scaffolding, config, types, Firestore seam        | —            | `ac2e775` |
| 1     | Data-access layer (`outbound/firebase/*`)         | —            | `c939110` |
| 2     | Deterministic gating layer                        | ~2,200       | `535b545` |
| 3     | Outbound chat state & gate layer                  | 1,508        | `82cee65` |
| 4     | Compliance & guard services                       | ~1,740       | `efe5e34` |
| 5     | Campaign lifecycle                                | ~2,050       | `c725948` |
| 6     | Email send path (choke point)                     | ~660         | `4a0ef4d` |
| 6b¹   | Send tool, text contracts, reinit ladder          | ~750         | `8c0e61a` |
| 6b²a  | Email compliance (SendGrid events, unsubscribe)   | ~278         | `5871c96` |
| 6b²b  | Inbound email-reply webhook handler               | ~471         | `8185ea3` |
| 7a    | Voice foundation                                  | ~470         | `3711843` |
| 7b¹   | Review toolkit (LLM analysis helpers)             | ~600         | `17c4817` |
| 7b²a  | make_phone_call (the call tool)                   | ~1,975       | `847c2a2` |
| 7b²b¹ | Post-call classifiers + review actions            | ~470         | `366bd09` |
| 7b²b² | Review orchestrator (`review_call_transcript`)    | ~700         | `3ed032f` |
| 7b²c  | ElevenLabs agent provisioning                     | ~1,189       | `cacf6b4` |
| 7b²d  | Voice webhook handlers, dial-by-number            | ~500         | `6a78220` |
| 8a    | Model layer (`llm/ask`, provider, registry)       | ~1,400       | `64b5276` |
| 8b¹   | Task + lifecycle tools                            | ~776         | `4129a45` |
| 8b²   | Turn-engine helpers, guardrails, prompt injection | ~370         | `c30f9a3` |
| 8b³   | The tool-dispatch loop (`with_tools`)             | ~1,370       | `c5219b9` |
| 8b⁴   | Turn entry (`call_llm_outbound`) + cron hookup    | ~1,105       | `3567aa5` |
| 9a    | HubSpot client core + contacts                    | ~600         | PENDING   |
| 9b    | Stage sync + deals                                | ~500         | —         |
| 9c    | Meetings, slots, booking                          | ~350         | —         |
| 9d    | Audiences, lists, search                          | ~500         | —         |
| 9e    | Analytics, discovery, tools + views               | ~750         | —         |
| 10    | HTTP surface & backfills                          | ~1,500       | —         |

Current: **1,537 tests / 35 suites**, `tsc` and `eslint` clean.

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

4. **Phase 6 split at the choke-point boundary.** `emailSender` is what every other email module
   calls, and is independently complete and verifiable, so it shipped as Phase 6. The
   conversation-handling half became Phase 6b.

5. **The rest of email conversation handling is blocked by LATER phases, so it was re-sequenced.**
   `email_review`'s remaining half is four LLM intent checks whose helpers all live in
   `tools/review_call_transcript.py` (Phase 7), plus a summary refresh needing the model layer
   (Phase 8). Porting them now would mean stubbing five functions, which the ground rules forbid — so
   they moved to Phase 8 and the deterministic half shipped alone.

6. **Phase 6b²'s two SERVICES turned out to be inbound features, and are not ported at all.**
   `inbound_email_nudge.py` (422) and `inbound_booking_email.py` (233) both open with a gate that
   REFUSES outbound chats — `if chat_data.get("type") == "outbound": return`, with the booking email
   even commenting "outbound emails are the outbound skill's job". Their only production callers are
   `inbound_agent/views/call_llm_web.py` (the inbound web turn) and the outbound email webhook's
   FALLBACK path for a web chat. Their genuinely shared parts were already extracted in Phase 6b¹ as
   `services/emailText.ts` (the opt-out regex, the quoted-reply stripper), and `_recent_transcript` is
   only needed by Phase 9's HubSpot notes. So ~655 of Phase 6b²'s ~1,400 lines are out of scope, and
   6b² is really just its two webhook handlers. Same lesson as revision 5, from the other direction: the
   directory an outbound file lives in does not make it outbound code.

7. **The model layer moved AHEAD of Phase 7b²'s review chain.** Checking
   `review_call_transcript`'s imports before committing to an order showed its helpers need
   `llm.ask.generate_text`, so Phase 8a shipped first and the review chain followed. This is the payoff
   for writing "verify the dependencies before starting" into the plan rather than trusting the numbering.

Expect more of these. The source's import graph is not the directory structure. Note the direction of
revision 5: a phase can be blocked by a phase that comes _after_ it, and the fix is to re-sequence, not
to stub.

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

### Phase 6 — email send path (~660 lines) — ✅ DONE

`sendgrid_mail.py` (168) · `email_sender.py` (495)

Also closed `reputation.emailDailySummary` (deferred out of Phase 4) and wired it into the cron.

### Phase 6b¹ — send tool, text contracts, reinitiation ladder (~750 lines) — ✅ DONE

`tools/email.py` (385) · the deterministic half of `email_review.py`

The shared text contracts (PEWC constants, quote stripper, opt-out and auto-reply matchers, the three
copy classifiers) now live in `services/emailText.ts` — one owner, rather than split across the tool
and the nudge with the review importing from both. That resolves the shared-contract question this
plan previously flagged.

### Phase 6b² — the email webhook handlers (~750 lines)

**Revised down from ~1,400 after reading the sources — see revision 7.** `inbound_email_nudge.py` (422)
and `inbound_booking_email.py` (233) are INBOUND web-widget features that refuse outbound chats
outright, and are not ported. What remains is the two webhook handlers, which are genuinely outbound.

#### 6b²a — email compliance (~278 lines) — ✅ DONE

`views/email_compliance.py` → `services/emailCompliance.ts`. The SendGrid event webhook (bounce,
spam report, unsubscribe, group unsubscribe, dropped) and the unsubscribe endpoint. Handlers only; the
HTTP routes are Phase 10, which also reuses `flagChatsForEmailEvent`'s `only_if_missing` mode for its
backfill.

#### 6b²b — the inbound email-reply webhook (~471 lines) — ✅ DONE

`views/email_webhook.py` → `services/emailWebhook.ts`. An ordered chain of SEVEN exits, where the order
is the design — opt-out precedes any reply, and the calendar decline precedes the normal reply because
a decline's body is usually empty. The web-chat fallback is omitted (unported inbound nudge service);
an unmatched address falls through to the no-match exit, which is what the source does when no web chat
matches either.

**Phase 6b² is complete, and with it the email side of the port.**

The LLM half of `email_review` is NOT here — it landed in Phase 7b¹.

### Phase 7a — voice foundation (~470 lines) — ✅ DONE

`elevenlabs.py` (96) · `referral_transfer.py` (162) · the deferred voice half of `call_scope.py` (~215)

Closed the `callScope` deferral that had been open since Phase 2.

### Phase 7b¹ — the review toolkit (~600 lines) — ✅ DONE

The six LLM-analysis helpers from `review_call_transcript.py`, plus `conversation_summary.py` and the
LLM half of `email_review.py`. Closed FOUR ledger rows at once.

### Phase 7b² — the call tools and the agent service (~4,430 lines)

Split into four increments, because `make_phone_call` and the review chain are independently complete
and verifiable and the review chain itself has three natural layers (classifiers → actions →
orchestrator). Everything they need already existed: the voice concurrency ledger (Phase 4), the dial
guard and call index (Phase 3), the call scope (Phase 7a), the model layer (Phase 8a), and the review
toolkit (Phase 7b¹).

#### 7b²a — `make_phone_call` (1,975 lines) — ✅ DONE

The four-gate dial chain. Its HubSpot availability injection and `ensureMeetingHost` defer to Phase 9.

#### 7b²b¹ — post-call classifiers and actions (~470 lines) — ✅ DONE

`classifyAnswerer`, `detectVoicemail`, `llmDetectVoicemail`, `hadMeaningfulEngagement`, and the five
actions a review takes from them. The two classifiers' OPPOSITE defaults are the load-bearing property.

#### 7b²b² — the review orchestrator (~700 lines) — ✅ DONE

`parse_and_run_review_call_transcript` plus the ElevenLabs transcript fetch and the unmatched-demo
booking fallback. Fetch the transcript, classify, then act on the outcome (book, schedule a callback,
transfer a referral, mark not-interested, finalize an unresolved call). Four HubSpot calls deferred to
Phase 9, one of them (`resolveBookingSlot`) as an injected parameter rather than an absence.

#### 7b²c — ElevenLabs agent provisioning (1,189 lines) — ✅ DONE

`services/elevenlabs_agent_service.py` — the write side of the voice stack. Fixed a KB name/id
misalignment; collapsed two verbatim source duplications; flagged a conversation-init URL that points
at the inbound app.

#### 7b²d — the voice webhook handlers and dial-by-number (~500 lines) — ✅ DONE

`views/elevenlabs_webhook.py` (242) · `views/conversation_init_webhook.py` (207) ·
`make_phone_call_from_number`

Ported as framework-free handlers in `services/voiceWebhooks.ts`; the HTTP routes that call them are
Phase 10. `views/voice_settings.py` (150) and `views/voice_connect.py` (53) are thin admin CRUD over the
provisioner and were re-assigned to **Phase 10**.

`make_phone_call_from_number` became a thin wrapper rather than a second 373-line dialer — its own
docstring states the contract ("same logic, hardcoded number") that the copy had drifted away from. See
the bug-fix section.

**This closes the voice phase.** Placement (7b²a), review (7b¹, 7b²b¹, 7b²b²), provisioning (7b²c), and
both inbound event paths (7b²d) are all in.

### Phase 8a — the model layer (~1,400 lines) — ✅ DONE

`llm/ask.py` (1,350) · the `provider` switch it depends on

Unblocks `review_call_transcript`, `conversation_summary`, and the four email-review LLM checks
re-sequenced out of Phase 6b.

**The tool registry.** The source imports ~20 tool schemas directly into the model layer. This port
inverts that: each tool calls `registerTool` at module load, and `llm/toolRegistry.ts` is the only
thing the model layer knows. So a tool becomes available the moment it is ported, with no edit to the
model layer. `send_email` is registered; every later tool should do the same in its own module.

### Phase 8b — the turn engine (~3,620 lines)

`llm/run.py` (1,892) · `call_llm_outbound.py` (1,105) · the task/stage tools
(`create_custom_task` 260, `update_custom_task` 120, `delete_custom_task` 57,
`mark_prospect_lost` 180, `mark_cadence_complete` 103, `clear_not_interested` 56)

**Split four ways.** Surveying first showed the bulk is TWO enormous functions — `with_tools` is a
single 1,370-line dispatch loop and `OutboundCallLLMView.post` is ~1,030 — so the split follows the
natural seams rather than file boundaries:

#### 8b¹ — the task and lifecycle tools (~776 lines) — ✅ DONE

The leaves: six tools the dispatch loop calls. Independent of the loop, so they land first. Fixed a
fail-open gate the port had inverted; see the bug-fix section.

#### 8b² — the helpers, guardrails, and prompt injection (~370 lines) — ✅ DONE

`run.py`'s functions ahead of `with_tools`: provider resolution, the two system-prompt injections, the
terminal-block kill switch, and the toolResult plumbing. The vehicle-summary injection is NOT ported —
it reads inbound `appraisals` and is gated on an inbound-only tool, so it could never produce output.

**Open question raised here, needing evals rather than a port decision:** the guardrail block enumerates
inbound channel tools only, so a pure outbound agent is told "Enabled outbound messaging tools: none"
while also being told it MUST call one every response — and neither channel switch has an `email`
branch. Ported verbatim with a test pinning the wording.

#### 8b³ — the tool-dispatch loop (~1,370 lines) — ✅ DONE

`with_tools` itself, the largest single function in the source.

**Ported as a dispatch TABLE, not the source's 96-branch `elif` chain** — about 85 of those branches
call inbound tools out of scope for this port, so reproducing the chain would mean porting or stubbing
them. Unknown names take the source's own "not implemented by this runtime" fallthrough, so an inbound
tool leaked in by an agent config behaves identically. The table holds ten tools today and grows as
tools land, which is what the Phase 8a registry inversion was for.

#### 8b⁴ — the turn entry and the cron hookup (~1,105 lines) — ✅ DONE

`call_llm_outbound.py`'s outbound turn assembly plus `run_outbound_llm`. **The cron's `runTurn` now
defaults to the real implementation** — that seam is closed, leaving only Phase 9's HubSpot slot
resolver open.

Ported framework-free: the source fuses the turn logic into a DRF view and then invokes that view
in-process through a request shim. Here the logic is a function, the cron calls it directly, and Phase
10's route is a thin adapter — the shim disappears.

The inbound halves are NOT ported: WhatsApp/Unipile/Twilio account resolution, attachment analysis, the
VIN protocol, appraisal confirmed-fields, the inbound SMS local scope, per-vehicle windowing, the TCPA
gate, and the notification-engine escalation gate. None has an outbound code path.

**Phase 8b is complete.** The turn engine runs end to end: helpers (8b²) → dispatch loop (8b³) → turn
entry (8b⁴), with the tools it dispatches to from 8b¹.

**Arrives with this phase:**

- The cron's `runTurn` parameter gets its real implementation (`runOutboundLlm`) — the last open
  injected seam apart from the review's `resolveBookingSlot` (Phase 9).

Both items previously listed here already landed in Phase 7b¹: `conversationSummary` and the four
`emailReview` LLM checks shipped alongside `review_call_transcript`'s helpers, which is what they were
actually waiting on.

### Phase 9 — HubSpot / CRM (~2,700 lines)

`services/hubspot.py` (2,235) · `views/hubspot_discovery.py` (256) · `views/deal_funnel.py` (84) ·
`tools/schedule_hubspot_meeting.py` (109) · `tools/get_hubspot_available_slots.py` (45)

**Split five ways along the module's natural layers** — 2,235 lines and ~90 functions is too much for
one increment, and the layers have clean boundaries:

#### 9a — client core + contacts (~600 lines) — ✅ DONE

Config resolution, OAuth/Private-App auth, contact matching and writes, notes, deletion. Closes the
`preservePriorEmailOnContact` seam from 7b²b².

#### 9b — stage sync + deals (~500 lines)

`sync_hubspot_stage` (216 lines on its own), `sync_hubspot_inbound_lead`, deal create/stage-update,
company association, and the deal-brief note. Closes `maybeAddDealConversationNote` and
`syncHubspotStage` — five call sites across the review, the webhook, the stage tools, and enroll.

#### 9c — meetings, slots, booking (~350 lines)

Availability fetch and formatting, booking, the ICS invite, `finalize_meeting_booking`. Closes the
review's injected `resolveBookingSlot`, `makePhoneCall`'s availability injection, and the
conversation-init slot injection.

#### 9d — audiences, lists, search (~500 lines)

List members, contact search with filter groups, area-code annotation, the contacted-exclusion filter.
Closes `resolveAudiencePage`'s HubSpot sources.

#### 9e — analytics, discovery, tools and views (~750 lines)

Deal funnel counts, owners, meeting links, property options, `discover_hubspot_config`, plus
`tools/schedule_hubspot_meeting.py`, `tools/get_hubspot_available_slots.py`, and the two views (which
may move to Phase 10 — verify their imports first).

**Arrives with this phase:**

- `chat.ensureMeetingHost`, deferred out of Phase 3. Its pure half `meetingHostFact` is ported.
- The six enrollment/contacted CRM stamps deferred out of Phase 5 (see the enroll seam above).
- `resolveAudiencePage`'s HubSpot contact sources (Phase 5) and `referralTransfer`'s CRM lookup
  (Phase 7a).
- `makePhoneCall`'s availability injection and `tools/email`'s stage sync (Phase 7b²a, 6b¹).
- The review's four HubSpot calls (Phase 7b²b²) — `resolveBookingSlot` fills the injected parameter;
  `maybeAddDealConversationNote`, `preservePriorEmailOnContact`, and `syncHubspotStage` were each
  best-effort and non-blocking in the source.

Nothing in this phase changes an outcome that already works — every deferred call is CRM _mirroring_,
which is why the seam held for nine increments.

### Phase 10 — HTTP surface & backfills (~1,500 lines)

`urls.py` (99) · `serializers.py` (90) · remaining `views/` (`campaigns` 227,
`dnc_area_codes` 78, `task_cron_job` 40, `initiate_outbound_webhook` 43, `__init__` 52,
plus `voice_settings` 150 and `voice_connect` 53 re-assigned from Phase 7b²c) ·
`management/commands/` (7 backfills + `reconcile_stale_calls`)

Thin once everything beneath it exists, which is why it is last.

**One open question to settle here:** the provisioner points agents at the INBOUND conversation-init
path while the outbound app mounts its own equivalent (see `CONVERSATION_INIT_PATH` in
`elevenlabsAgentService.ts`). The correct value is only knowable once the route exists.

## Deferral ledger

Every function knowingly absent from the port, and where it lands. Nothing else is missing.

| Deferred                                   | Out of | Into   | Blocked on                                               |
| ------------------------------------------ | ------ | ------ | -------------------------------------------------------- |
| `chat.ensureMeetingHost`                   | 3      | 9      | `hubspot.resolveHubspotConfig`, `resolveOwnerName`       |
| ~~`chat.finalizeUnresolvedCall`~~          | 3      | 5 ✅   | landed early — deps arrived in Phase 4/5                 |
| ~~`chat.reconcileStalePendingCalls`~~      | 3      | 5 ✅   | landed early, same reason                                |
| `callScope` (voice-prompt half)            | 2      | 7      | voice prompt assembly                                    |
| `reputation.emailDailySummary`             | 4      | 6      | `sendgridMail.resolveSendgridConfig`                     |
| `conversationSummary`                      | 5      | 8      | `llm.ask.generateText`                                   |
| enroll's 6 HubSpot stamps                  | 5      | 9      | `services/hubspot`                                       |
| `cron` email daily summary                 | 5      | 6      | `sendgridMail.resolveSendgridConfig`                     |
| ~~`cron` turn runner (injected)~~          | 5      | 8b⁴ ✅ | closed — defaults to `runOutboundLlm`, still overridable |
| `resolveAudiencePage` HubSpot sources      | 5      | 9      | HubSpot contact-fetch layer                              |
| review's `resolveBookingSlot` (injected)   | 7b²b²  | 9      | `hubspot.getHubspotSlots` — a parameter, not absent      |
| review's `maybeAddDealConversationNote`    | 7b²b²  | 9      | `services/hubspot` — best-effort in the source           |
| ~~review's `preservePriorEmailOnContact`~~ | 7b²b²  | 9a ✅  | closed — appends a secondary, keeps the prior address    |
| review's `syncHubspotStage`                | 7b²b²  | 9      | `services/hubspot` — best-effort in the source           |
| `fetchCallFromVapi`                        | 7b²b²  | —      | unreachable: no Vapi dialer exists in this port          |
| provisioner's `getToolsForAgent`           | 7b²c   | —      | inbound tools-mapper; best-effort in the source          |

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

`emailsPerHour` (Phase 6) defaulted to **60**; the source's default is **10**. That would have let a
warming domain send six times the source's hourly rate — the precise failure the reputation layer
exists to prevent, and invisible until an agent left `per_hour` unset on its SendGrid action.
`emailsPerRecipientPerDay` was also wrong (3 vs 5), in the harmless direction. Both corrected.

The source's own stated intent was the spec. That is the bar for changing behaviour: not "this looks
wrong" but "this does not do what it says it does". A default that silently disagrees with the source
is the same class of defect: the code does not do what the module it configures says it does.

The channel gate in `create_custom_task` (Phase 8b¹) is a bug the PORT introduced and its own test
caught, worth recording because the mechanism will recur. The source reads `if _doc and not
task_channel_open(...)`, and `load_chat_doc` returns `{}` for a missing chat AND for a read failure —
`{}` being FALSY in Python is exactly what makes the gate fail OPEN. A JS `{}` is truthy, so the direct
translation fired the gate on an unreadable doc and refused to schedule anything, turning a documented
fail-open into fail-closed: a Firestore blip would have stalled every cadence while reporting a clean
`skipped`. Any Python `if some_dict:` guard is a fail-direction decision, not a null check.

`make_phone_call_from_number` (Phase 7b²d) is the clearest case so far of the docstring being the spec
and the code being the stale artifact. Its docstring says "Same logic as make_phone_call but uses a
hardcoded phone number ID"; a normalized diff shows the copy had drifted behind the original by five
things — `call_type`/`prospect_stage`, the meeting-host fact, voice skills, the HubSpot availability
inject, and the oversee-agent deactivation check. Calls placed through it reached the prospect with less
context and a deactivated oversee number was not blocked. The port implements the STATED contract as a
wrapper, so the drift does not survive.

Note this resolves the opposite way to the stale docstring in Phase 7b²c, where the code was newer than
its comment and therefore won. The rule is not "comments win" or "code wins" — it is: work out which
artifact is the later statement of intent, and say so on the function.

`elevenlabsAgentService` (Phase 7b²c) built its knowledge-base result list by walking the **filtered**
id list while indexing `sources[i]` for the name. The filter drops failed uploads — so the moment any
one upload failed, every later entry was paired with a different source's name, silently mislabelling
the agent's knowledge bases. Nothing errors and the count is right, which is why it would never be
noticed. Both source KB functions had it; the port carries each name with its own id and drops failures
afterwards. This is the same shape as the other two: the failure was invisible because something
fail-soft absorbed it.

The review orchestrator (Phase 7b²b²) carries a latent defect the port cannot express rather than one
it fixes. Its deal-note retry reads `agent_id`, a name Python only binds when `meta_data` carried one;
otherwise the read raises `NameError` inside the function-wide handler — which skips booking, the
callback, the stage advance, AND the idempotency stamp, after every earlier side effect has already
run. That last part is what makes it costly: the chat is left mutated but unrecorded, so the next
review re-runs the pipeline. The port resolves `agentId` once into a plain string, so the condition
simply reads falsy; the failure mode has nowhere to live. Documented at the call site.

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
