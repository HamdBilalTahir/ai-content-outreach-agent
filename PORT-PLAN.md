# Outbound agent port — plan of record

Porting `ai-sales-backend/outbound_agent` (a 37,241-line Django app; ~25,000 lines production,
~12,000 lines tests) to TypeScript under `outbound/`.

This file is the plan of record. It was reconstructed from the source tree and has been **revised nine
times** — every revision is recorded below, because the dependency facts that forced them are the
expensive part to rediscover.

**The port is complete.** Thirty-seven increments, 2,291 tests across 56 suites, thirty-two routes, and a
deferral ledger holding nothing but two permanently-unreachable functions.

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
- **A phase's own tests are suspect too.** Twelve increments had a failing test whose FIXTURE or
  EXPECTATION was invented rather than read from the source or the ported helper. Check which of the two
  is wrong before touching either — and note that the answer was sometimes "neither": in Phase 10e² a
  wrong fixture is what surfaced a genuine defect the port had introduced.
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
| 9a    | HubSpot client core + contacts                    | ~600         | `619623a` |
| 9b    | Stage sync + deals                                | ~500         | `b4a8f34` |
| 9c    | Meetings, slots, booking                          | ~350         | `580ded9` |
| 9d    | Audiences, lists, search                          | ~580         | `d1e3424` |
| 9e    | Discovery, meeting tools, `ensureMeetingHost`     | ~600         | `1fcc845` |
| 10a   | Route table, request adapter, webhook/cron views  | ~250         | `d75083c` |
| 10b   | Campaigns + chat pause/resume views               | ~227         | `ed263a7` |
| 10c¹  | HubSpot admin + audience-preview views            | ~270         | `f43228d` |
| 10c²  | Voice admin views + the DNC area-code registry    | ~370         | `da3b615` |
| 10d¹  | Deal-analytics read layer + the funnel view       | ~425         | `b06a316` |
| 10d²  | The attribution engine + its scan endpoint        | ~405         | `8808adc` |
| 10d³  | The deal timeline (upstream, landed 2026-08-03)   | ~440         | `fb383f1` |
|       | — **every route in `urls.py` is now live (32)**   |              |           |
| 10e¹  | Six backfills + the two operational runners       | ~571         | `532647f` |
| 10e²  | `backfill_website_verified_business`              | ~280         | `4bc47ee` |

Current: **2,308 tests / 56 suites**, `tsc` and `eslint` clean. **The port is complete.**

## Drift sync (the source kept moving)

The backend source advanced **30 commits, +2,417/−237 across 29 files** between 2026-08-04 and the scan.
This is not port work left undone — it is upstream change since. Same rhythm: one increment, one commit,
one changelog entry, verified before commit.

| Phase | Scope                                                                       | Commit    |
| ----- | --------------------------------------------------------------------------- | --------- |
| D1    | Three new modules: `contactRoles`, `companyFromDomain`, `escalateToHuman`   | `fe6c4cb` |
| D2    | The referral fork machinery + `resolveActiveOutboundChat`                   | `efd7ec1` |
| D3    | Review pipeline: contact resolution, escalation, re-home verify, prompts    | _pending_ |
| D4    | Services: `enroll`, `hubspot`, `chat`, `campaigns`, `stalledRecovery`, cron | _pending_ |
| D5    | Views/HTTP: cron auth, the three webhooks, campaigns view, `llm/run`        | _pending_ |
| D6    | UI drift since U7                                                           | _pending_ |

**D2 was re-split off the announced D3 scope.** The new review orchestrator calls
`handleReferralTransfer` with `force_same_line` and `archive_reason`, which this port's signature lacked
— so the fork machinery is a hard prerequisite and lands first rather than being stubbed.

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

8. **Phase 10 splits into five, and two files it never named turned up in the survey.** Surveying it
   before starting found `views/deal_conversion.py` and `management/commands/run_deal_attribution.py`
   absent from the plan entirely — the `management/commands/` line describes "7 backfills +
   `reconcile_stale_calls`", which is an accurate count of the `backfill_*` files and silently omits the
   ninth. A scope line written as a count is a scope line that cannot be checked against `ls`.

9. **The source repo is a MOVING TARGET, and Phase 10d's real scope is ~1,270 lines, not ~330.** Reading
   `views/deal_funnel.py` before starting 10d surfaced a whole deal-analytics subsystem the plan never
   enumerated: `services/deal_attribution.py` (311) with `views/deal_conversion.py` (55) and ~340 lines of
   analytics reads inside `services/hubspot.py`, plus `services/deal_timeline.py` (393) with
   `views/deal_timeline.py` (47) and an `analytics/deal-timeline/` route.

   This one is **not** a survey failure like revision 8. `git log` on the source dates the attribution
   commit to **2026-07-31** and the timeline commit to **2026-08-03** — both landed upstream _while this
   port was in flight_, after the plan's Phase 10 scope line was written. Three days earlier, neither
   file existed. `urls.py` itself grew from 101 to 104 lines between two reads in the same session.

   **Decision: port what the source contains now**, rather than freezing at the snapshot the plan was
   written against. Freezing would ship a port missing a live dashboard endpoint the FE already calls,
   and "the plan is older than the code" is not a reason to omit working features. 10d splits into three.

   The general lesson is different from every earlier revision: those were about reading the source more
   carefully. This one is about the source not holding still. A line count in a plan is a snapshot, and a
   long port needs to re-survey the tree at each phase boundary rather than trusting a figure written
   weeks earlier. Re-checked at 10d; worth re-checking before 10e.

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

#### 9b — stage sync + deals (~500 lines) — ✅ DONE

`sync_hubspot_stage` (216 lines on its own), deal create/stage-update, company association, and the
deal-brief note. **Seams wired at all six call sites** — the review orchestrator (deal note, Engaged
sync, secondary email), the email webhook, the conversation-init webhook, and `mark_prospect_lost`.

`sync_hubspot_inbound_lead` (~156 lines) is NOT ported: it bails on `type == "outbound"` and its
production caller is the inbound web turn — the THIRD module inside `outbound_agent/` to do this (see
revision 7).

#### 9c — meetings, slots, booking (~350 lines) — ✅ DONE

Availability fetch and formatting, booking, the ICS invite, `finalize_meeting_booking`, the review's
slot matcher, and a shared availability block. **All three seams closed and wired**: the review's
`resolveBookingSlot` defaults to the real matcher (still injectable, which keeps its tests off a live
CRM), and both voice availability injections are live — the outbound dial skips it for an already-booked
reminder call, which must never offer new times.

#### 9d — audiences, lists, search (~580 lines) — ✅ DONE

Contact lists, contact search with filter groups, the enrollment stamps, area-code annotation, and the
contact → lead-payload mapping. Closes `resolveAudiencePage`'s HubSpot sources and enroll's three
contact stamps (`stampContactNumberType`, `stampContactContacted`, `stampContactCampaign`) — the
remaining three of enroll's six are the stage/deal calls already closed in 9b.

#### 9e — discovery, the meeting tools, and `ensureMeetingHost` (~600 lines) — ✅ DONE

Owners, meeting links, property options, deal pipelines, `discover_hubspot_config`, both meeting tools
(registered in the dispatch table, now twelve), and `ensureMeetingHost` — the port's OLDEST seam, open
since Phase 3, wired at all four call sites.

**The deal-funnel analytics move to Phase 10** with `views/deal_funnel.py`, their only consumer, as does
`views/hubspot_discovery.py`. Consistent with every other view.

**Phase 9 is complete. The deferral ledger has no real work left** — only `fetchCallFromVapi` and the
provisioner's `getToolsForAgent`, both permanently unreachable.

**Arrives with this phase:**

- `chat.ensureMeetingHost`, deferred out of Phase 3. Its pure half `meetingHostFact` is ported.
- The six enrollment/contacted CRM stamps deferred out of Phase 5 (see the enroll seam above).
- `resolveAudiencePage`'s HubSpot contact sources (Phase 5). ~~and `referralTransfer`'s CRM lookup
  (Phase 7a)~~ — **this half was NOT delivered here; the claim was wrong.** `referralTransfer.ts` was
  last touched at Phase 7b¹ and left `contactId` hardcoded `null`. Found and closed during drift sync
  D2, where it stopped being cosmetic: the same-line fork keys the new chat's doc id on the contact id.
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

Also lands here from Phase 9e: `views/deal_funnel.py` (84) and `views/hubspot_discovery.py` (256), plus
the deal-funnel ANALYTICS the funnel view is the only consumer of (`deal_funnel_counts`, the
stage-attribution scan, and the deal-read helpers — roughly 190 lines of `services/hubspot.py`), and
`views/deal_conversion.py` (55) with its paired `management/commands/run_deal_attribution.py` (45) —
which the survey found had never been assigned a phase at all. The plan's `management/commands/` line
says "7 backfills + `reconcile_stale_calls`", and there are indeed exactly seven `backfill_*` commands;
`run_deal_attribution` is a ninth file that is neither, so it fell through the description. Both go to
10d with the funnel, which is the only thing that reads what they write.

Split into five increments, because the views have nothing in common with each other beyond being
views: the routes and the already-landed handlers (10a), campaigns (10b), the FE admin surface —
HubSpot config, voice prompts, the DNC registry (10c), the funnel and its analytics (10d), and the
backfill commands (10e).

#### 10a — the route table, the request adapter, and the landed handlers' views (~250 lines) — ✅ DONE

`urls.py` (99) · `views/__init__.py` (52) · `views/task_cron_job.py` (40) ·
`views/initiate_outbound_webhook.py` (43) · the view classes of `elevenlabs_webhook.py`,
`conversation_init_webhook.py`, `email_webhook.py`, `email_compliance.py`, and
`OutboundCallLLMView` from `call_llm_outbound.py`.

`urls.py` becomes a first-match ORDERED TABLE in `outbound/http/routes.ts` plus one Next.js catch-all
adapter, rather than thirty route directories. Keeping it a list keeps Django's own resolution order
explicit and testable; file-based routing would bury the same information in framework precedence
rules. Every path is preserved verbatim under the `/api/outbound/` mount, trailing slashes included —
the provider webhook URLs are configured against them by hand and the unsubscribe links in
already-delivered mail point at `/unsub/` permanently.

**The table lists only routes whose views exist.** An absent path 404s, which is honest; a stubbed one
would answer 200 with a lie. The remaining entries land with their views in 10b–10e.

**The open question is settled: `CONVERSATION_INIT_PATH` now points at the outbound route.** In a
deployment running both apps the source's inbound path is a judgement call. Here it is not — this port
has no inbound app, so the source's value resolves to a 404 at `baseUrl()` and a provisioned agent
would get no pre-call context at all. See the deliberate-divergences section.

#### 10b — campaigns and chat pause/resume (~227 lines) — ✅ DONE

`views/campaigns.py` — the twelve campaign and chat-lifecycle views, plus `validateAudience`, as
`outbound/http/campaignViews.ts`. Ten routes join the table, which is now eighteen.

`validateAudience` is the substance: it is the only gate between an FE payload and a campaign that will
enroll thousands of contacts. Two decisions in it are worth restating. **Emptiness, not presence,**
decides each per-type check — the source reads `audience.get("contacts") or []`, so a `contacts: []`
csv campaign is rejected rather than created to do nothing. And **any invalid area code rejects the
whole request**: an area-code selection is a DNC-scrubbability claim, so enrolling only the codes that
happened to parse would dial the remainder unscrubbed, which is the precise thing the selection exists
to prevent.

`bool(data.get(k, default))` is translated in the view, not left to the service: the default fires only
on an ABSENT key and a present value is then coerced, so `exclude_contacted: null` from the FE means
OFF. `??` would have read it as "unset" and turned dedup back on — the same absent-vs-null distinction
the port has been tracking since Phase 2, arriving here through an HTTP body instead of a Firestore
read.

#### 10c¹ — the HubSpot admin and audience-preview views (~270 lines) — ✅ DONE

`views/hubspot_discovery.py` — the seven views (discovery, property-option, delete-records, lists,
list-members, contact-properties, search-contacts) as `outbound/http/hubspotViews.ts`, plus
`deleteHubspotRecords` added to `services/hubspot.ts`. The table is now twenty-five routes.

**The two token resolvers prefer OPPOSITE sources, and both preferences are correct.** `resolveToken`
prefers a directly-supplied `access_token`, because step 1 of setup has no saved action and the FE holds
a Private-App token the user just pasted. `resolveConfig` prefers `agent_id`, because the list/search
helpers refresh the token internally and a bare `access_token` cannot be refreshed. Normalizing them
breaks one caller or the other, so both are asserted.

**The audience preview excludes on two different keys** because one cannot see what the other catches.
Contact ids hide contacts already enrolled; a shared dealership line means a _distinct_ contact carries
the same phone, which an id-based exclusion misses and enrollment would collapse onto the existing chat.
The channel-key pass runs AFTER the search — the HubSpot API has no way to express it — while the id
exclusions go into the query so `total` reflects them.

**`delete-records` is gated twice**, and the memory cleanup afterwards is conditional on the delete
having SUCCEEDED. That is why `deleteHubspotRecords` returns tri-state per object: `null` (never asked)
must not collapse into `false` (asked and failed), because clearing an id on a failure orphans a live
CRM record.

**Survey finding:** `delete_hubspot_records` (13 lines) was never ported. Phase 9a's entry says
"deletion", and it delivered `deleteObject` — the generic primitive — but not the orchestrator that
resolves the agent's token and calls it twice. Nothing referenced it until this view, so the gap was
invisible. Landed here, in the source's own module, with its own tests.

#### 10c² — the voice admin views and the DNC area-code registry (~370 lines) — ✅ DONE

`views/voice_settings.py` (150) · `views/voice_connect.py` (53) · `views/dnc_area_codes.py` (78) ·
`serializers.py` (90) — as `outbound/http/voiceViews.ts`, `dncViews.ts`, and `serializers.ts`. Four
routes join the table, which is now twenty-nine. **Every route in `urls.py` is live except the two
`analytics/` endpoints**, which land with the funnel in 10d.

**`serializers.py` is NOT ported as a DRF framework.** The two serializers it defines are ported as two
validation functions, reproducing the error SHAPE (`{field: [message]}`) and the two-pass ORDER (field
validation first; the object-level pass only if every field passed) because the FE reads both. Building a
generic `Serializer`/`Field` layer would be a large amount of speculative code in service of one endpoint.

**The DNC registry REPORTS invalid codes; the campaign audience validator REJECTS them.** Both are
correct, and the asymmetry is the interesting part: this endpoint _registers_ which codes may be
scrubbed, so a dropped token narrows the registry and is safe. In 10b a dropped token would have widened
the dialled audience past what was actually scrubbed. Same input shape, opposite fail direction, because
the cost is asymmetric in opposite directions. Recorded on both modules.

**The voice views sync BEFORE they write.** If ElevenLabs refuses the prompt, the agent doc is left
untouched, so it never claims a prompt the provider is not serving — and the failure is a 502, not a 500,
because the fault was upstream and that is what tells the FE whether a retry is worth anything. The
webhook re-attach after the sync is best-effort for the opposite reason: the prompt is saved and the
agent exists either way, and the next sync fixes it.

#### 10d¹ — the deal-analytics read layer and the funnel view (~425 lines) — ✅ DONE

The analytics half of `services/hubspot.py` as `outbound/services/dealAnalytics.ts`, plus
`views/deal_funnel.py` as `outbound/http/analyticsViews.ts`. Thirty routes.

Its own module rather than more of `hubspot.ts`: this is a read-only reporting layer, nothing in it
writes to HubSpot, and its consumers are dashboard endpoints rather than the agent.

**The funnel's counts come from FIRESTORE, not from a HubSpot deal search.** A prospect the agent engaged
may convert via ANOTHER rep — the deal is created on the same contact but without the agent's
`lead_source` tag, so a tag-filtered search reads zero for work the agent caused. Only the stage SHAPE
(labels, order, won/lost, `is_entry`) is read live from HubSpot. The consequence to know: the counts are
as of the last attribution scan, not as of this instant.

**Three exclusions, each of which would otherwise inflate the funnel.** A never-contacted chat (a deal on
that contact was made by a rep directly — `stage` becomes `Contacted` the moment a call or email fires,
so anything still at `New`/absent is local proof the AI never reached out); an archived chat (dead, and
the FE already drops it from the inbox and drill lists); and duplicate deals (one contact can map to
several chats, so the scan dedupes by `deal_id` before counting).

**Won/lost is classified by LABEL, in one place.** The funnel, the timeline, and the attribution stage
sync all derive it from `stageType`, so getting it right fixes three consumers — and getting it wrong
breaks all three identically.

**Every funnel failure is a reported `error`, never an empty chart**, because an empty funnel and an
unreachable pipeline look the same to whoever is reading the dashboard.

#### 10d² — the attribution engine and its scan endpoint (~405 lines) — ✅ DONE

`services/deal_attribution.py` as `outbound/services/dealAttribution.ts`, `views/deal_conversion.py` as
the second half of `analyticsViews.ts`, and `require_api_key` as `outbound/http/apiAuth.ts`. Thirty-one
routes. This writes the attribution 10d¹'s funnel reads.

**The two write paths are gated differently, and reversing either breaks it.** Activities and the memory
write-back are CHANGE-gated, tracked in `memory._attributed_deals` as `{dealId: stageId}` — state-gating
them would re-card the same deal on every hourly run. The funnel-stage sync is STATE-gated and runs on
every scan, comparing the chat's current stage against the target the deal implies — change-gating it
would leave an already-attributed chat whose promotion was missed wrong until the deal happened to move
again. A change-gated sync could never heal; a state-gated card writer would duplicate forever.

**An unwritten activity card is not recorded as logged, but the memory facts still land.** The source
gates the write-back on `activities > 0 OR changed`, so a first attribution writes its deal id and stage
even when the card failed — and `_attributed_deals` stays empty, so the next scan re-cards it. Both
halves are deliberate.

**Only the internal-key path of `api_auth` is ported.** The source's second credential is a per-company
key resolved through the inbound product's multi-tenant key store; this port has no company registry and
no outbound endpoint is company-scoped, so that branch would be an unreachable lookup. It fails CLOSED,
including when the key is unset — the source is explicit that "open when unconfigured" is how several
webhooks in that codebase ended up with their auth commented out.

**The test double now models cursor paging for real.** `startAfter` was a documented no-op and
`orderBy('__name__')` sorted on a field that does not exist in the data, so a resume test would have
looped forever or silently passed on one page. Both are implemented, positioned by VALUE comparison so a
cursor id deleted between pages still positions correctly — and anything other than `__name__` ordering
now THROWS, per the double's rule that an unsupported operation must fail loudly.

#### 10d³ — the deal timeline (~440 lines) — ✅ DONE

`services/deal_timeline.py` as `outbound/services/dealTimeline.ts`, `views/deal_timeline.py` into
`analyticsViews.ts`, plus `fetchDealDetail` and `getDealEngagements` into `dealAnalytics.ts` — the two
per-deal reads whose only consumer is the timeline. **Thirty-two routes: every route the source declares
is now live.**

The increment that only exists because the source moved. It merges HubSpot's view of a deal with ours
into one date-ascending event list, and follows the attribution linkage 10d² writes — which is why the
three sub-increments had to land in this order.

**De-duplication with HubSpot preferred, and the loser DONATING its fields.** The two systems both see
the same email and the same acquisition, so without this every touchpoint count doubles on exactly the
deals the view exists to explain. The buckets are deliberately fuzzy — two-minute windows for email, a
day for meetings — because the two stamp the same touch seconds apart and an exact-match key would
collapse nothing. Calls and notes are never de-duped: two calls two minutes apart are two calls.

**Stage changes are never fabricated.** `hs_date_entered_<id>` is sparse on older or manually-staged
deals, and only stages with a real timestamp emit an event — so the timeline shows what HubSpot recorded
rather than a plausible reconstruction. The acquisition is the deliberate exception, falling back to
`closedate` (which HubSpot stamps reliably on close) so a won deal always shows the event the whole view
is for.

**An AI `acquired` on an OPEN deal is dropped.** `prospect_converted_to_deal` is written for any
attributed deal; on an open one it is an attribution marker, and keeping it would report an open deal as
won — the one thing a conversion dashboard must never do.

**Two failure shapes, and the FE relies on the difference:** `{success: false, error}` for a bad request
or an unusable config (the caller's problem), and `{success: true, reason}` with an empty list for a deal
that legitimately has nothing to show. A deal with no source chat is not an error — a rep can create one
from scratch.

#### 10e¹ — the backfills and the operational runners (~571 lines) — ✅ DONE

Eight of the nine `management/commands/`, as `outbound/commands/{optoutBackfills,hubspotBackfills,index}.ts`.
Re-surveyed the directory first per revision 9's lesson: nine commands, 851 lines, unchanged since 10d³.

**The Django command wrapper is not ported, and the arguments are.** `add_arguments` defaults, clamps, and
`--dry-run` semantics are the substance and live in the function signatures; `BaseCommand`, argv parsing,
and the `manage.py` entry are dropped, because Django supplies a runner and this repo has none — taking a
`tsx` dependency to invent one is outside a port of the application. `commands` in `index.ts` is the
registry that replaces `manage.py <name>`, keyed on the source's own names so the set stays greppable
against `ls management/commands/`.

**Every backfill is idempotent and SET-ONLY.** `backfillOptoutFlags` seeds a missing key and raises a
false to true, and **never clears a top-level opt-out** — the chat doc is the trustworthy record, so if it
says the customer opted out and memory disagrees, the chat doc wins. Reversing that would let a stale
memory field silently re-open a closed channel.

**A `dryRun` reports the counters a real run would produce.** The read path is identical and only the write
is skipped. `backfillEmailOptoutChatFlags` goes further and resolves the chat during a dry run, so its
count reflects real pending writes rather than every suppression entry — a dry run that overcounted or
undercounted would be worse than none, because it would be trusted.

**Each HubSpot backfill writes exactly ONE property.** A batch update replaces the properties it is given,
so including a second field read slightly stale would overwrite a rep's edit. `backfillAaaiAreaCode` pages
by SEEK on `hs_object_id` rather than by offset, because HubSpot caps `after` at 10,000 results and an
offset walk truncates a larger audience _while reporting success_; the last id comes back so a killed run
resumes where it stopped. Its dry run creates nothing — not even the property — and its real output is the
area-code distribution, which is what tells you whether the phone data is good enough for the filter.

**`run_deal_attribution` pages to EXHAUSTION**, the opposite bound to the HTTP endpoint running the same
scan. Deliberate: a scheduler wants a bounded slice, an operator wants the job finished.

`backfill_website_verified_business` is deferred to 10e² — it carries a Playwright/scraping-provider fetch
engine that needs its own decision.

#### 10e² — the website-verified-business backfill (~280 lines) — ✅ DONE

`backfill_website_verified_business` as `outbound/commands/websiteVerifiedBusiness.ts`. **The last file.
Every phase is done.**

**Playwright is not ported; the scraping-provider path is, in full.** The source picks a fetch engine three
ways — a configured scraping API, else headless Chromium when installed, else plain requests. Playwright is
a ~300MB browser download plus a process lifecycle (a page counter, a recycle every 25 pages, a teardown,
because Chromium wedges after 25–50 pages on the author's machine), which is a large operational dependency
in service of one backfill. The consequence is stated rather than hidden: a JS-rendered or
Cloudflare-protected site yields `false`, exactly as the source's own `SCRAPER_ENGINE=requests` mode does.
`fetchPage` is an injectable seam, so a Playwright fetcher can be added later without touching anything
else.

**A real divergence was caught and closed, and it is the most interesting thing in the increment.** A
`mailto:a@b.com` in a contact's website field has no `://`, so both the source and a direct translation
prefix it to `http://mailto:a@b.com`. Python's `urlparse` reads that as host `mailto:a@b.com` — garbage
that fails to fetch. **WHATWG `URL` reads it as userinfo `mailto:a` plus host `b.com`**, so the port would
have fetched a real, unrelated domain and could have verified a lead against a phone number on somebody
else's website. That is a wrong answer rather than a missing one, so `normalizeUrl` refuses any URL that
parses with a username or password. Pinned by test with the reasoning.

`agentId` is required, where the source defaults to a hardcoded production agent id — same decision as the
area-code backfill in 10e¹. A literal id in a port is a value that silently rots, and a script that writes
to a customer's CRM should not have a default target.

## Deferral ledger

Every function knowingly absent from the port, and where it lands. Nothing else is missing.

| Deferred                                    | Out of | Into     | Blocked on                                               |
| ------------------------------------------- | ------ | -------- | -------------------------------------------------------- |
| ~~`chat.ensureMeetingHost`~~                | 3      | 9e ✅    | closed — resolves the CRM owner name, wired at 4 sites   |
| ~~`chat.finalizeUnresolvedCall`~~           | 3      | 5 ✅     | landed early — deps arrived in Phase 4/5                 |
| ~~`chat.reconcileStalePendingCalls`~~       | 3      | 5 ✅     | landed early, same reason                                |
| ~~`callScope` (voice-prompt half)~~         | 2      | 7a ✅    | closed — the voice half landed with the foundation       |
| ~~`reputation.emailDailySummary`~~          | 4      | 6 ✅     | closed — landed with the send path                       |
| ~~`conversationSummary`~~                   | 5      | 7b¹ ✅   | closed — landed with the review toolkit, not Phase 8     |
| ~~enroll's 6 HubSpot stamps~~               | 5      | 9b/9d ✅ | closed — stage/deal in 9b, the 3 contact stamps in 9d    |
| ~~`cron` email daily summary~~              | 5      | 6 ✅     | closed — wired into the cron with the send path          |
| ~~`cron` turn runner (injected)~~           | 5      | 8b⁴ ✅   | closed — defaults to `runOutboundLlm`, still overridable |
| ~~`resolveAudiencePage` HubSpot sources~~   | 5      | 9d ✅    | closed — lists + search return lead payloads directly    |
| ~~review's `resolveBookingSlot`~~           | 7b²b²  | 9c ✅    | closed — defaults to the real matcher, still injectable  |
| ~~review's `maybeAddDealConversationNote`~~ | 7b²b²  | 9b ✅    | closed — retried after the summary caches                |
| ~~review's `preservePriorEmailOnContact`~~  | 7b²b²  | 9a ✅    | closed — appends a secondary, keeps the prior address    |
| ~~review's `syncHubspotStage`~~             | 7b²b²  | 9b ✅    | closed — wired at all six call sites                     |
| `fetchCallFromVapi`                         | 7b²b²  | —        | unreachable: no Vapi dialer exists in this port          |
| provisioner's `getToolsForAgent`            | 7b²c   | —        | inbound tools-mapper; best-effort in the source          |

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
- **`CONVERSATION_INIT_PATH` points at the OUTBOUND route** (Phase 10a), where the source points at
  `/inbound_agent/voice-agent/elevenlabs/conversation-init`. This port has no inbound app, so the
  source's value is a guaranteed 404 at `baseUrl()` and a provisioned agent would fetch no pre-call
  context at all — worse than the source's own working-but-wrong endpoint. There is exactly one
  conversation-init handler here, and the caller's log line says it is attaching _the_ one.
- **`urls.py` becomes an ordered route table plus one catch-all adapter** (Phase 10a), not thirty
  Next.js route directories. Django resolves `urlpatterns` first-match; a list preserves that ordering
  as something a reader and a test can check. Paths and `name=` values are verbatim.
- **A non-empty body with an unsupported `Content-Type` parses as JSON or yields `{}`** (Phase 10a),
  where DRF raises `UnsupportedMediaType` → 415. Providers misdeclare content types routinely, and a
  415 returned to a webhook is retried — retrying a body that will never parse is a loop, not a
  recovery. Every view already handles a field it cannot find.
- **Playwright is not ported** (Phase 10e²), so the website-verification backfill falls back to a direct
  fetch unless `SCRAPER_PROVIDER` is configured. A JS-rendered or Cloudflare-protected site therefore
  yields `false` — identical to the source's own `SCRAPER_ENGINE=requests` mode. The provider path is
  ported in full, and `fetchPage` is an injectable seam.
- **`normalizeUrl` refuses a URL that parses with credentials** (Phase 10e²), which the source does not.
  See the bug-fix section: WHATWG `URL` and Python `urlparse` disagree about `http://mailto:a@b.com`, and
  the JS reading is the dangerous one.
- **The Django management-command wrapper is not ported** (Phase 10e). `add_arguments` defaults, clamps,
  and `--dry-run` semantics live in the function signatures; `BaseCommand`, argv parsing, and the
  `manage.py` entry are dropped, because Django supplies a runner and this repo has none. `commands` is
  the registry that replaces `manage.py <name>`.
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

`normalizeUrl` (Phase 10e²) is a defect the port would have INTRODUCED, caught by a test whose fixture was
itself wrong. A `mailto:a@b.com` in a contact's website field has no `://`, so the source prefixes it to
`http://mailto:a@b.com`; Python's `urlparse` reads host `mailto:a@b.com` and the fetch simply fails.
**WHATWG `URL` parses the same string as userinfo `mailto:a` plus host `b.com`** — so the direct translation
would have fetched a real, unrelated domain, and a phone number listed there would have marked the lead
website-verified. A wrong answer, not a missing one, and invisible: the property is a boolean and nothing
records which URL produced it. The port refuses any URL parsing with a username or password.

This is a new shape worth naming: not a Python-vs-JS truthiness difference but a **library-semantics**
difference, where two standard URL parsers disagree about a malformed input. `int()` vs `parseInt` (Phase
10a) was the same family and benign; this one was not.

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
