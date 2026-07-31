## 🗓️ **2026-07-30**

---

### ✨ Features

---

> ### Outbound agent port — Phase 7b²a: the call tool
>
> - **What changed:** Ported `tools/make_phone_call.py` — the outbound voice dial — as `outbound/tools/makePhoneCall.ts`, with its four-gate chain, the dial payload assembly, and the post-dial bookkeeping. Registers itself with the model layer's tool registry.
> - **Why the gate ORDER is the design, not incidental.** Four gates run before anything is dialed, each cheaper or more terminal than the next:
>   1. **Phone opt-out** — terminal `blocked`, no retry task, and **never bypassed**. Consent is not a pacing concern.
>   2. **Business hours** — DEFERS rather than dropping: schedules a retry at the next business morning and surfaces the reason in both the task notes and the tool result, so the agent re-attempts in-hours instead of the model deciding to cold-call at 2am local.
>   3. **The per-chat dial guard** — the structural stop for the repeat-dial storm. Placed BEFORE scope-building, so a refusal wastes no scope work.
>   4. **The voice concurrency cap** — reserved LAST, because it is the only gate that consumes a resource.
>
>   **The bypasses are narrow and consistent:** a `Test` record and a human `@ai` override bypass the two PACING gates; `Test` also bypasses business hours; neither ever bypasses opt-out. And `isHotProspect` bypasses **nothing** — the source records that the old count-then-write cap let hot prospects through and that two concurrent dials raced past it, so the cap is now absolute and an engaged prospect is called sooner by being _scheduled_ sooner.
>
>   **Slot accounting is directional:** a live call keeps its slot until the completion webhook (or the TTL sweep); a FAILED dial releases immediately, because otherwise a failure would hold capacity until the TTL expires.
>
> - **Files:**
>   - `outbound/tools/makePhoneCall.ts`
>   - `outbound/__tests__/tools/makePhoneCall.test.ts`
> - **Verification:** 1,054 tests across 24 suites (37 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **The gate order was confirmed by a test failure, and that is worth recording.** Five tests for gates 3 and 4 failed with `deferred` instead of their expected status: with a `Real` record, the clock-dependent business-hours gate fired first and the pacing gates were never reached. That is CORRECT — a `Real` record outside the window genuinely cannot reach them — so rather than weaken the assertions I mocked `checkBusinessHours` to report "inside hours" by default, which isolates each gate, and added an explicit test that an out-of-hours chat which is ALSO inside the dial-recency floor defers on hours and reserves no slot. The ordering is now asserted directly instead of being an accident of the test clock.
> - **Deferred:** the **Vapi provider path** is not ported. Note the source defaults `voice_ai_provider` to `"vapi"`, so this is a behaviour change for a Vapi-configured agent — it now returns a `failed` result **naming the unsupported provider** rather than silently doing nothing, which is diagnosable instead of an unexplained no-op. Also deferred: the HubSpot availability injection and `ensureMeetingHost` (HubSpot phase), and `make_phone_call_from_number` plus the recording upload (with the rest of the voice phase).
>
> ---
>
> ### Outbound agent port — Phase 7b¹: the review toolkit, and three deferrals closed
>
> - **What changed:** Ported the LLM-analysis toolkit the review tools share, and used it to close three open deferrals in one go.
>   - `tools/reviewHelpers.ts` — `llmText`, `parseJsonResponse`, `resolveStageAndSkills`, `extractFromTranscriptWithSchema`, `detectChannelPreferences`, and `classifyCallOutcome`. Extracted from `review_call_transcript.py`, which the source also imports from `email_review` — porting them as their own module makes that shared surface explicit.
>   - `services/conversationSummary.ts` — **deferred out of Phase 5.** Needed the model layer.
>   - `services/emailReview.ts` — **the LLM half, deferred out of Phase 6b**: `emailOptOutDetected`, `capturePhoneConsentFromReply`, and `reviewEmail` with its schema extraction, referral/decline detection, and summary refresh.
> - **Why: every one of these fails toward the conservative answer, and the directions are deliberately NOT uniform.** They are asserted individually because normalizing them is the likely mistake:
>   - `llmText` → `''`, so a caller sees "no verdict" rather than a wrong one.
>   - `detectChannelPreferences` → safe defaults, in which **every flag is false**, so an unparseable verdict changes nothing.
>   - `classifyCallOutcome` → `no_commitment`, so a bad read **never auto-books a meeting**. The prompt's tie-break pushes the same way: when genuinely unsure whether a prospect committed to ATTEND a demo or merely arranged a callback, choose callback.
>   - `emailOptOutDetected` → **TRUE** on a missing verdict. The regex already matched, so failing toward honouring a possible opt-out is never weaker than regex-only, and is compliance-safe.
>   - The callback-number check → **FALSE**. TCPA stakes: the phone channel is never opened on a guess.
>
>   Those last two point in opposite directions, and each is correct for its own stake.
>
> - **The PEWC distinction is the sharpest edge in this increment.** `capturePhoneConsentFromReply` reopens the phone channel either way, but only schedules an automated call when OUR outbound email carried the disclosure — that is prior express _written_ consent. Without it the channel reopens for MANUAL follow-up and **no automated call is placed**. Getting it backwards would place an AI voice call without written consent, so both branches are tested explicitly, and this is why the disclosure marker has to stay byte-stable.
> - **Two prompt rules preserved verbatim, with tests asserting they are still present**, because both encode a lesson: "declining is NOT an opt-out" (conflating them opts a prospect out of a channel they never asked to leave), and "a referral OUTRANKS `followup_email`" — the source records that a deterministic backstop once promoted the prospect's OWN address to a referral whenever a loose regex matched, forking a duplicate chat and stranding a booked demo. That backstop was removed; classification is the model's job alone.
> - **Files:**
>   - `outbound/tools/reviewHelpers.ts`
>   - `outbound/services/{conversationSummary,emailReview,referralTransfer}.ts`
>   - `outbound/__tests__/tools/reviewHelpers.test.ts`
> - **Verification:** 1,017 tests across 23 suites (39 new, all passing on the first run), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Deliberate divergence in `resolveStageAndSkills`:** the source resolves the stage from an `appraisals` subcollection before falling back to the chat document, and loads skills through the INBOUND (unfiltered) resolver. Neither applies here. `appraisals` has no outbound equivalent — outbound contacts are vehicle-less B2B prospects, which is why Phase 1 did not port that subsystem — so the appraisal branch would be permanently inert; and an outbound review wants the skills active for an OUTBOUND chat, which is what the outbound-filtered resolver returns. Reading stage and labels straight off the chat document produces the same value the source's own fallback does.
>
> ---
>
> ### Outbound agent port — Phase 8a: the model layer
>
> - **What changed:** Ported the multi-provider model layer. **This was done ahead of Phase 7b on purpose** — see the sequencing note below.
>   - `llm/ask.ts` — `generateText` and its routing, the three provider paths (Bedrock Converse, direct Anthropic, Groq), the format converters in both directions for each, the empty-text sanitizer, and `textOf` for the one-shot callers.
>   - `llm/provider.ts` — the global `LLM_PROVIDER` switch and the Bedrock → Anthropic model mapping.
>   - `llm/toolRegistry.ts` — the tool-description registry.
> - **Why this phase moved, and it is a genuine plan correction:** Phase 7a's note said to lead Phase 7b with `review_call_transcript` because it holds the LLM helpers the email work needs, but to **check its imports before committing to that order**. Checking them settled it the other way: `review_call_transcript` imports `llm.ask.generate_text` at MODULE level. So the model layer is the real bottleneck — it gates `review_call_transcript`, `conversation_summary`, AND the four re-sequenced email-review LLM checks. Doing it first unblocks all three; doing 7b first would have blocked immediately. Checking rather than assuming is what caught this.
> - **The design decisions worth recording:**
>   - **Three providers, ONE wire format.** Bedrock Converse shape is canonical; Groq and Anthropic requests are converted out of it and their responses converted back. That is why nothing downstream deals in anything but Bedrock-shaped messages, and why switching provider changes nothing for callers.
>   - **Models map by TIER, not by exact snapshot.** Several snapshots that still work on Bedrock are RETIRED on the direct Anthropic API and 404 there — the source names four verified cases. Exact-snapshot mapping would look more faithful and fail in production, so the tests assert the retired ids specifically map _forward_.
>   - **Every Groq route is FORCED onto one allowed model,** with a warning. This deployment permits exactly one for tool-call reliability, so an unexpected Groq model is corrected rather than attempted.
>   - **A registry replaces ~20 direct tool-schema imports.** The source imports each tool's schema into the model layer, which works in Python where every tool module exists; here the tools land across several phases, so a direct-import model layer would not compile until the last one arrived. Inverting the dependency means the model layer is complete now and a tool becomes available the moment it is ported, with no edit to the layer. The behaviour that matters is preserved: an enabled function with no registered schema is SKIPPED with a warning, so a partial tool set degrades to a smaller tool list rather than a failed turn.
> - **Files:**
>   - `outbound/llm/{ask,provider,toolRegistry}.ts`
>   - `outbound/tools/email.ts` (registers itself at module load)
>   - `outbound/__tests__/llm/modelLayer.test.ts`
> - **Verification:** 978 tests across 22 suites (46 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **A bug of mine, caught by its own test:** the empty-text sanitizer compared `kept.length !== content.length` **after** substituting the placeholder, so the single-empty-block case never spliced — one block replaced by one placeholder, lengths equal, no write. The source compares the filtered list against the original by value; comparing lengths is a valid proxy only _before_ substitution. Now it compares the filter result and returns early when nothing was removed. Worth noting the sanitizer is exactly where this matters: Bedrock rejects an empty text block anywhere in the history, so a message that should have become `(no content)` would have failed the whole request.
>
> ---
>
> ### Outbound agent port — Phase 7a: the voice foundation
>
> - **What changed:** Ported the voice modules that other things depend on, and closed the oldest open deferral in the ledger.
>   - `services/callScope.ts` — **the voice half, deferred out of Phase 2 and now closed.** `buildOutboundCallScope`, `buildInboundCallScope`, the two context scanners, `buildVoiceSchedulingBlock`, and `hubspotContextLine`. Phase 2 shipped only the deterministic consent-ask line; this completes the module.
>   - `services/elevenlabs.ts` — the provider webhook attach.
>   - `services/referralTransfer.ts` — the wrong-or-departed-contact re-route.
>   - `services/notInterested.ts` — `cancelPendingTasks` is now exported rather than module-private, because the referral transfer needs exactly the same sweep on its source chat and duplicating it would let the two drift.
> - **Why each of these three exists is worth stating, because none is obvious from its name:**
>   - **The call scope is a FACTS FEED with no scripting.** It emits what is true — `call_type`, `prospect_stage`, contact on file, prior-contact counts, cadence position, today's date in the prospect's zone — and the voice agent's own prompt decides how to run the call. That separation is what lets the prompt be edited without touching code, so the suite asserts both that the facts are present and that no behavioural instruction leaks in. The `today` line is a scheduling fact specifically: it states that the earliest bookable demo is tomorrow, which is what stops the agent offering a slot it cannot honour.
>   - **The webhook attach exists because connecting an agent from the front end only stores its id.** It never pushes platform settings, so the agent has no post-call webhook and the provider never calls back — a placed call completes and nothing downstream learns the outcome. The PATCH is strictly ADDITIVE, reading current settings and merging, so it can never clobber the agent's prompt, voice, or tools. A test asserts a pre-existing prompt survives the write.
>   - **Referral transfer is NOT a decline, and the asymmetry between its two chats is the whole design.** The NEW chat gets warm identity and a `referral` HIGHLIGHT label that is deliberately not a proactive-stop label — comms still go out. The SOURCE gets only the stop label and its pending tasks cancelled, with **no referral-identity keys at all** so a later reader cannot mistake it for the referred contact, and with its stage and opt-outs untouched because a referral says nothing about that person's consent. It also rewrites the enrolled first-touch notes **in place** rather than recreating the task, so the ≤1-proactive invariant is never disturbed — otherwise a warm referral would get the cold-pitch opener enrollment scheduled.
> - **Files:**
>   - `outbound/services/{callScope,elevenlabs,referralTransfer,notInterested}.ts`
>   - `outbound/__tests__/services/voiceFoundation.test.ts`
> - **Verification:** 932 tests across 21 suites (40 new, all passing on the first run), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Deferred:** the CRM contact lookup-or-create in the referral transfer arrives with the HubSpot phase. It is best-effort in the source — when it fails, `contact_id` stays null and the transfer proceeds: the new chat is still created, seeded warm, and scheduled. So the transfer is complete without it.
> - **Phase scope note:** Phase 7 is ~5,500 source lines, the largest in the plan. This increment is the ~470-line foundation the rest builds on. The remainder — `make_phone_call` (1,975), `review_call_transcript` (1,683), `elevenlabs_agent_service` (1,189), and the four voice views (652) — becomes **Phase 7b**. `review_call_transcript` is on the critical path twice over: it holds the LLM helpers that Phase 8's re-sequenced email work needs, so it should lead that phase.
>
> ---
>
> ### Outbound agent port — Phase 6b: the send tool, the shared text contracts, and the reinitiation ladder
>
> - **What changed:** Ported the email modules that are genuinely unblocked, and established the shared text contract the plan flagged as needing an owner.
>   - `services/emailText.ts` — **the shared deterministic email-text contracts**, in one module. The PEWC disclosure and its marker, the quoted-reply stripper, the opt-out and auto-reply matchers, the three outbound-copy classifiers, and the phone/subject helpers. In the source these are split across `tools/email.py` and `inbound_email_nudge.py` with the review importing from both; co-locating them makes the contract explicit and removes a cycle the port would otherwise have to reproduce.
>   - `tools/email.ts` — the `send_email` tool, complete, with all three of its deterministic gates on the model's copy.
>   - `services/emailReview.ts` — the deterministic half: the suppression-reinitiation ladder, the thread readers, and `pewcDisclosureOnRecord`.
> - **Why:** The three gates in the send tool all exist because the model composes the body and will otherwise assert things we cannot back — and in each case a **false positive is the expensive direction**, because it would block ordinary cold outreach. So each classifier is tested for what it must NOT match as carefully as for what it must:
>   1. **Booking confirmation** — an email claiming a confirmed meeting only goes out when a booking actually succeeded. Generic outreach ("would you be open to a demo?", proposing times) must not match.
>   2. **No-answer premise** — a "couldn't reach you" email requires a FRESH unanswered call on record, and fails CLOSED on a missing or unparseable stamp, because the alternative is an email whose stated premise never happened. Generic "book a call" / "hop on a call" language must not match, and email-only contacts are exempt entirely since there is no call to tie it to.
>   3. **Missing join link** — appended deterministically. The link must never depend on the model remembering to paste it, or the customer gets a "Demo confirmed" email they cannot act on even though the booking set the link in the same turn.
>
>   The **`stripQuotedReply` → `OPT_OUT_RE` ordering is load-bearing and now pinned by a test that asserts both directions**: our own CAN-SPAM footer contains the words "opt out", so an unstripped reply quoting it matches the opt-out matcher. The test shows the raw reply matching and the stripped reply not matching, which is the actual bug being prevented.
>
>   The **reinitiation ladder is three-way** because the right response to a suppressed address emailing us depends entirely on why it was suppressed: consent lifts (a direct inquiry is an express invitation), complaint NEVER auto-lifts (a wrong automated guess is expensive, so it escalates), and deliverability re-verifies — their ability to SEND is not evidence of our ability to DELIVER — lifting only on `valid`, or probing once with a label that makes a later bounce permanent.
>
> - **Files:**
>   - `outbound/services/{emailText,emailReview}.ts`
>   - `outbound/tools/email.ts`
>   - `outbound/__tests__/services/emailConversation.test.ts`
> - **Verification:** 892 tests across 20 suites (70 new, all passing on the first run), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Plan revision — the rest of the email conversation work is blocked by phases that come AFTER it, so it is re-sequenced rather than stubbed.** `email_review`'s remaining half is four LLM intent checks, and every helper they call (`_llm_text`, `_parse_json_response`, `extract_from_transcript_with_schema`, `detect_channel_preferences`, `_resolve_stage_and_skills`) lives in `tools/review_call_transcript.py` — **Phase 7** — while the summary refresh needs the model layer in **Phase 8**. Porting them now would mean stubbing five functions, which the ground rules forbid. So the opt-out intent confirmation, the callback-number confirmation, schema extraction, referral/not-interested detection, and the summary refresh move to Phase 8, and `PORT-PLAN.md` records each in the deferral ledger. The still-portable remainder — the inbound nudge, the booking email, and the two email views — stays as Phase 6b.
> - **Note:** The PEWC disclosure wording is flagged in the source as pending counsel approval and is transcribed **verbatim**, with a test asserting the text still contains its own marker and the three required TCPA elements. Code keys on the marker, not the full text, so the marker must stay byte-stable: the send tool counts a consent ask only when the body contains it, and the review distinguishes written from mere prior-express consent by finding it in our own sent copy.
>
> ---
>
> ### Outbound agent port — Phase 6: the email send path
>
> - **What changed:** Ported the email choke point and its transport, and closed the one deferral left open by Phase 4.
>   - `services/sendgridMail.ts` — the transport plus `resolveSendgridConfig`, which reads the per-agent SendGrid action. There is deliberately **no hardcoded from-address and no env fallback for the API key**: outbound runs on a dedicated warming domain, so sending from the main domain or via a shared key would burn it, and an unconfigured agent gets a refusal rather than a default.
>   - `services/emailSender.ts` — **the unified choke point.** Every outbound email passes through `sendEmail`; direct transport calls are forbidden and the suite asserts it. The LLM and skills decide _what to say_, this module decides _what every email carries_ and _who never receives one_.
>   - `reputation.emailDailySummary` — **deferred out of Phase 4**, unblocked here because it needs `resolveSendgridConfig` to read each domain's own ramp configuration. Now wired into the cron tick, which was the other half of that deferral.
> - **Why:** Two properties in this module are order-dependent, and a plausible-looking reordering breaks either one silently — so both are asserted explicitly rather than assumed:
>   1. **The gate order.** The business-hours gate sits **after** the address-quality skips, so a suppressed or invalid address is TERMINALLY skipped and never converted into a retry task — retrying a dead address later is the exact failure the module exists to prevent. And it sits **before** the consuming gates, so an after-hours send burns neither a bucket token nor domain budget. The per-recipient cap is last of the consumers and **releases the domain budget** when it skips, so a terminal skip never costs the day's budget.
>   2. **The two axes, which were one axis once — and that caused silent drops.** `gate_profile` (which gates apply) is chosen by **state, not by the caller**: a stale thread keeps its threading headers but gates as cold outreach, because class privileges are earned by state. `origin` (who owns a deferral) is fixed at the call site, and every deferred send has an owner — a retry task for `llm_tool`, a self-rescheduling service for `nudge_service`, and an assertion-log for `transactional_service`, which should never reach a deferring gate at all.
>
>   The **fail directions are again deliberately mixed** and asserted individually: local suppression fails CLOSED on its own data, the provider's live list fails OPEN on API errors, the domain budget fails CLOSED because it is a reputation control, and the hourly bucket and recipient cap fail OPEN because they are rate controls.
>
> - **Files:**
>   - `outbound/services/{sendgridMail,emailSender}.ts`
>   - `outbound/services/reputation.ts` (`emailDailySummary`)
>   - `outbound/services/cron.ts` (summary hookup)
>   - `outbound/config.ts`
>   - `outbound/__tests__/services/emailSender.test.ts`
> - **Bug fixed — a Phase 0 config defect with real consequences:** `emailsPerHour` defaulted to **60**; the source's default is **10**. That would have let a warming domain send six times the source's hourly rate — precisely the failure the entire reputation layer exists to prevent, and invisible until an agent left `per_hour` unset on its SendGrid action. `emailsPerRecipientPerDay` was also wrong (3 vs the source's 5), in the harmless direction. Both corrected, with the reasoning recorded on the export so the value is not "tidied" back.
> - **Verification:** 822 tests across 19 suites (39 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Phase scope note:** Phase 6 was planned as the whole email pipeline. It is split at the choke-point boundary, because `emailSender` is what every other email module calls and is independently complete and verifiable. The conversation-handling half — `email_review` (361), `inbound_email_nudge` (422), `inbound_booking_email` (233), `tools/email` (385), and the two email views (749) — becomes **Phase 6b**, recorded in `PORT-PLAN.md` with its dependencies. Nothing is silently dropped: the deferral ledger tracks it.
>
> ---
>
> ### Outbound agent port — Phase 5: the campaign lifecycle
>
> - **What changed:** Ported the five modules that drive a campaign from creation to completion — the enrollment path, the campaign engine, the cadence safety net, booking reminders, and the cron that advances all of it.
>   - `services/enroll.ts` — `enrollContact`, the single entry point into the flow: creates or dedupes the chat, seeds memory, applies the four-stage phone gate chain, resolves the outreach lane, sets stage `New`, and schedules the channel-neutral outreach task. Plus `resolveLocation` and `markContacted`.
>   - `services/campaigns.ts` — the status machine (`enrolling → running`, with `paused`/`stopped` cascades), the two pacing bases, the four cursor-driven chat sweeps, `enrollCampaignBatch` with enrollment-time verification and the area-code gate, and the cron's campaign-id selectors.
>   - `services/stalledRecovery.ts` — `recoverOrCollapseChat`, the deterministic `reviewChat`, `fallbackToEmailLane`, `ensureNextStepAfterCall`, **plus** `finalizeUnresolvedCall` and `reconcileStalePendingCalls` pulled forward from Phase 7 (see below).
>   - `services/reminders.ts` — the lead-time-aware pre-demo plan, scheduled in CODE rather than by the model.
>   - `services/cron.ts` — `processOutboundTasks` and the overdue-safe `filterDueOutboundTasks`.
> - **Why:** This phase is where the four independent layers that stop a task running twice finally sit together, and each exists because the one before it is insufficient — which is why the suite asserts them separately rather than as one behaviour:
>   1. **the wide lookback** (14 days) guarantees an overdue task is still _found_ — the shared query's `now - 2·window` lower bound would strand anything overdue by more than a few minutes;
>   2. **per-chat serialization** keeps only the oldest due task per chat, because two DIFFERENT due tasks on one chat race past the non-atomic processing lock and the per-task claim cannot stop them — the task ids differ;
>   3. **the atomic dispatch claim** marks the task executed _at dispatch_, before the 15–45s turn;
>   4. **the per-chat dial guard**, inside the call tool.
>
>   Two other decisions carry their own reasoning. The **business-hours pre-gate sits at the task level**: an out-of-hours outreach task is rescheduled and no turn runs at all, because gating inside the turn would burn a turn, produce reasoning, and leak a "deferred" card into the customer-visible conversation. And **phone-lane contacts do not consume email `per_day` slots** — the separate `email_paced_count` base exists precisely to prevent that, since phone contacts fire today within business hours under voice-concurrency throttling rather than being day-bucketed.
>
> - **Files:**
>   - `outbound/services/{enroll,campaigns,stalledRecovery,reminders,cron}.ts`
>   - `outbound/__tests__/services/{enroll,campaigns,cadenceRecovery}.test.ts`
> - **Plan revision — two functions arrived three phases early.** `finalizeUnresolvedCall` and `reconcileStalePendingCalls` were deferred out of Phase 3 to Phase 7 pending `voiceConcurrency` and `stalledRecovery`. `voiceConcurrency` landed in Phase 4 and `stalledRecovery` is this phase, so both are now unblocked and ported here rather than left absent for two more phases. They also **do not live in `services/chat.ts`** as the source has them: `finalizeUnresolvedCall` calls `ensureNextStepAfterCall` while `reviewChat` calls back into it — a module-level cycle the source breaks with lazy imports inside function bodies. Co-locating the two halves removes the cycle outright instead of reproducing it; `chat.ts` keeps the pure predicate `callAwaitingReview` that both rely on.
> - **Two deliberate seams, both documented in the module docstrings:**
>   - **The cron takes its LLM turn runner as a parameter.** The source lazily imports `run_outbound_llm` inside the function to break a circular import; the LLM layer is Phase 8. Injecting it makes the entire orchestration — claim, gates, serialization, priority split, retry — testable now, with Phase 8 supplying the real runner and Phase 10 wiring it. The email daily summary the cron also emits arrives with the email phase.
>   - **`resolveAudiencePage` supports the `csv` source only.** The HubSpot list/search/allow-list sources need the contact-fetch layer and are one function's worth of surface. An unported type returns an _empty page_ rather than throwing, so the worker settles the campaign instead of spinning on it every tick. Everything else — the status machine, pacing, cursors, batching, the lane split, verification, the area-code gate, the stats breakdown — is complete and exercised against a CSV audience today.
> - **Verification:** 783 tests across 18 suites (125 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **A latent inconsistency found and deliberately NOT fixed:** `scheduling.taskChannel` reads a **top-level** `channel`, but `createTaskWithId` nests the caller's payload under `data` (verified against the inbound source — Phase 1 is faithful). So the channel tag that `stalledRecovery`'s scheduler writes lands at `data.channel` and is never seen; such a task falls through to type inference instead. It is currently harmless, because every call site that writes the tag also passes `perChannel = false`, so the grouping is never consulted for those tasks. Reading `data.channel` too would newly group a dual test chat's tasks by channel — a live behaviour change nothing has asked for — so the behaviour is preserved and the reasoning recorded on the function. This is the same bar applied in Phase 4: change behaviour when the code does not do what it says it does, not when it merely looks wrong.
>
> ---
>
> ### Outbound agent port — Phase 4: the compliance and guard services
>
> - **What changed:** Ported the eleven services that decide whether a specific contact may be reached at all, plus three small native replacements for inbound lookups they depend on.
>   - `services/suppression.ts` — the `email_suppression` store: three classes (deliverability / consent / complaint), the SendGrid live-list mirror, and the versioned-HMAC unsubscribe token.
>   - `services/dncFullScrub.ts` — the DNCScrub consolidated Full Scrub client, with the clean-code **allowlist** (`C W X E O H V F G`) so an undocumented or newly-introduced result code can never accidentally pass.
>   - `services/phoneScreening.ts` — the enrollment-time phone gate. `decide()` (the CNAM business/consumer matrix) is ported and tested but **not called**: CNAM returned `"unknown"` for very nearly every number, which in `business_only` mode blocked almost every DNC-clean lead. It is kept intact so re-enabling is one line.
>   - `services/twilioCallerType.ts` — the CNAM client and its 180-day cache, sharing `phone_lookups` with the inbound line-type cache under distinct keys so neither clobbers the other.
>   - `services/verification.ts` — layered email verification (syntax → disposable → role → MX → optional provider), using Node's `dns.promises` rather than a DNS dependency.
>   - `services/reputation.ts` — the domain circuit breaker, the warm-up ramp, the transactional daily budget, and the `email_send_log` writers.
>   - `services/voiceConcurrency.ts` — the atomic reserved-slot ledger for voice calls.
>   - `services/chatPause.ts` — the reversible freeze, and the overdue-task repair that resume has to perform.
>   - `services/notInterested.ts` — the decline handler.
>   - `services/voiceRouting.ts` — durable post-call chat resolution.
>   - `firebase/{featureFlags,phoneNumbers,twilio}.ts` — the three inbound reads these needed, ported native.
> - **Why:** This is the layer that answers "may we contact this person, on this channel, right now" — the consent and reputation gates. Its defining characteristic is that the **fail directions are all different and each is chosen for a specific asymmetric cost**, which is why they are asserted individually in the suites rather than assumed consistent:
>   - `suppression.isSuppressed` fails **CLOSED** — a storage error returns a synthetic `deliverability` entry, because mailing an address whose state we could not read is worse than not mailing it.
>   - `voiceConcurrency.tryReserveVoiceSlot` fails **CLOSED** and has **no bypass** — the cap is absolute; a skipped dial simply reschedules.
>   - `reputation.consumeDomainBudget` fails **CLOSED** — this is a reputation control, not a rate control, so an over-send against a cold domain costs far more than a deferral.
>   - `dncFullScrub` and `verification` fail **OPEN** on transport — a vendor outage must not halt all outreach; note `is_clean: null` (inconclusive) is deliberately distinct from `false` (a scrub that ran and said no).
>   - `featureFlags.isEnabled` fails **CLOSED**, which in `phoneScreening` means screening is _skipped_ rather than every lead blocked — the same direction producing the permissive outcome, because the call-time gate is the backstop.
>   - `verification` with **no provider key configured treats an MX pass as a pass**: the provider is a quality upgrade, never a prerequisite, so a missing key cannot halt all mail.
> - **Files:**
>   - `outbound/services/{suppression,dncFullScrub,phoneScreening,twilioCallerType,verification,reputation,voiceConcurrency,chatPause,notInterested,voiceRouting}.ts`
>   - `outbound/firebase/{featureFlags,phoneNumbers,twilio}.ts`
>   - `outbound/__tests__/services/{suppression,reputation,guardServices}.test.ts`
> - **Bug fixed in the port (with the source's own stated intent as the spec):** `voiceConcurrency` wrote its whole live-slot map back with `set(..., merge=True)` and commented that this "purges expired slots atomically too". It does not — Firestore merges map fields **recursively**, so keys absent from the payload survive. The `active_slots` map therefore accumulated one dead entry per chat ever dialed, growing without bound toward the 1MB document limit. The cap itself was never wrong (the live-slot filter runs on read), which is exactly why the defect was invisible. Both the reserve path and `reconcileVoiceSlots` now use dot-path `FieldValue.delete()`, which achieves what the comment intended. `releaseVoiceSlot` uses the same mechanism, which additionally means a release can no longer clobber a concurrent reserve for a different chat.
> - **Deferred:** `reputation.email_daily_summary` needs `sendgrid_mail.resolve_sendgrid_config` to read each domain's per-agent ramp configuration, so it lands with the email phase. Everything the breaker and budget need is here.
> - **Verification:** 658 tests across 15 suites (117 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Second non-obvious behaviour pinned by test:** `reputation.inWarmup` is `rampCap(days) < configuredCap`, and the ramp's last rung is 50 — so any configured cap **above 50 is never reached and the domain stays permanently "in warm-up"**, keeping the stricter first-complaint-halts rule in force forever. An initial test asserted it would eventually go false. That reading is the conservative one for a domain configured beyond what the ramp will ever authorize, so the behaviour is preserved and now documented on the function.

---

> ### Outbound agent port — Phase 3: the outbound chat state & gate layer
>
> - **What changed:** Ported `outbound_agent/services/chat.py` (1,508 lines) to `outbound/services/chat.ts`. This module was **not in the original phase plan** — it surfaced while reading Phase 3's intended contents, because `not_interested.py` (and, transitively, the cron, the campaign pacer, and every send tool) imports from it. It is the dependency root for everything downstream, so it was pulled out into its own phase and the guard services shifted to Phase 4. What landed:
>   - **The consent gate matrix** — `phoneOptedOut`, `emailOptedOut`, `smsOptedOut`, `emailInvalid`, `hasReachableChannel`, and the `isOptedOutValue` normalizer that accepts every type this flag has been written as across the codebase's history (real booleans, the DNC `"Y"`/`"N"` string form, textual booleans, numerics).
>   - **The proactive-stop labels** — `not_interested` / `referral_transferred`, `stopsProactive`, and the cadence-complete marker (`setCadenceComplete` / `clearCadenceComplete` / `isCadenceComplete` / `isTerminalStage`).
>   - **`taskChannelOpen`** — the deterministic gate on task CREATION (not just execution), so a task that would use an opted-out channel never exists; plus `markTaskSkipped` and `failOutboundTask`.
>   - **`repairOutboundHistory`** — the Bedrock history self-heal, with `mergeConsecutiveRoles` and `stripUnpairedToolBlocks`.
>   - **The turn-outcome scans** — `notesForFailedActions`, `turnIsByDesignGated`, `assistantTextIfNoTool`, `recentConversationContext`.
>   - **Chat lifecycle** — `getOrCreateOutboundChat` (namespaced deterministic doc id + the migrated-chat re-enroll dedup), `buildDeterministicChatId`, `setChatType`, `getOutboundChatByEmail` / `getWebChatByEmail`.
>   - **Cadence state** — the follow-up counters, the caps, `cadenceExhausted`, `shouldFallbackToEmail`, `hasEmailFallback`.
>   - **The dial guard** — `recentDialBlocks` and `callAwaitingReview`.
>   - **Persona resolution** — `resolveOutboundName`, `nameSlug`, `contactedMarkerKey` / `contactedMarkerValue`, `pronouncePhoneNumber`.
>   - **Logging and indices** — `logEmailMessage`, `logInboundEmailToHistory`, `logEmailActivity`, `logInternalNote`, `updateEmailMeta`, the durable `outbound_call_index` (`save`/`get`/`delete`/`countActive`), `markCallCompletedInActivities` / `markCallCompletedInMessages`, `findInProgressCallId`.
> - **Why:** This is the module that every later phase reads before doing anything irreversible, and its central invariant is a **trust split** that has to survive the port intact: consent gates read the code-owned **top-level** chat keys, never the LLM-writable `memory`. Channel _presence_ is read from `memory` precisely because clearing it only makes a channel look absent, which is the more restrictive direction. A gate that read consent from `memory` could be talked out of blocking by the model itself. Equally load-bearing is the three-way distinction the source is careful about and a "simplification" would collapse: opt-out flags encode the customer's **consent**, the `Lost` stage is our terminal **business outcome**, and the `not_interested` label is our **read of the conversation** — it stops proactive outreach but leaves inbound replies answerable, so a prospect who declines can still re-open the deal.
> - **Files:**
>   - `outbound/services/chat.ts`
>   - `outbound/testSupport/mockFirestore.ts`
>   - `outbound/__tests__/services/chatGates.test.ts`
>   - `outbound/__tests__/services/chatState.test.ts`
> - **Deferred to their own phases** (absent rather than stubbed, because a dynamic import of a module that does not exist yet would degrade silently through the source's own best-effort `catch`):
>   - `ensure_meeting_host` — resolves the HubSpot contact owner; lands with the HubSpot phase. Its pure half, `meetingHostFact`, is ported now.
>   - `finalize_unresolved_call` and `reconcile_stale_pending_calls` — need `voice_concurrency.release_voice_slot` and `stalled_recovery.ensure_next_step_after_call`; they land with the voice phase. Their pure predicate, `callAwaitingReview`, is ported now.
> - **Verification:** 541 tests across 12 suites (185 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **One non-obvious behaviour pinned by test rather than "fixed":** `phoneOptedOut` consults **two** independent top-level keys, each with its own memory fallback — and chat creation seeds `phone_opt_out`/`email_opt_out` but **not** `block_phone`. So top-level `block_phone` is absent on every chat, its memory fallback is permanently live, and a memory `block_phone: "Y"` blocks even when top-level `phone_opt_out` is `false`. An initial test asserted the opposite (that the top-level `false` wins outright) and failed against a faithful port. The source's behaviour errs toward **blocking**, which is the safe direction for a consent gate — tidying the second check away would un-gate contacts the DNC path had blocked — so the test now pins the real semantics and the reason is recorded on the function.
> - **Note:** Two further gaps in the Phase 1 Firestore double surfaced and were closed: `collection().listDocuments()` (added in Phase 2) and now `doc().create()`, whose absence made `getOrCreateOutboundChat` write nothing at all — the missing method threw, and the source's own concurrent-create-race `catch` swallowed it as expected. Both are cases where a fail-soft code path made a silent test-double gap look like passing code.

---

> ### Outbound agent port — Phase 2: the deterministic gating layer
>
> - **What changed:** Ported the nine source modules that decide _whether_ and _when_ an outbound touch may happen. Every one is pure logic or a single Firestore transaction — no integration keys, no LLM — so the whole layer is exhaustively testable and runs on a machine with nothing configured.
>   - `utils/timezoneLookup.ts` + `utils/timezoneTables.ts` — US area-code/ZIP → IANA timezone and state. The 981-line source is split into generated data (332 area-code→timezone, 331 area-code→state, 52 state→timezone, 56 ZIP3 SCF ranges, 37 ZIP3 overrides) and the derivation logic, so the tables can be regenerated without re-reviewing the code.
>   - `services/businessHours.ts` — the calls-only send window: **9:00–18:55** in the prospect's local zone, or the deliberately tighter **11:00–16:55 ET** cross-coast fallback when the zone is unknown, plus weekend/federal/state-holiday blocking. Also the schedulers `clampToBusinessHours`, `businessHoursStartAfter`, `businessHoursSlot` (deterministic, no RNG — which is what makes a paused campaign resumable to the same schedule) and `nextBusinessHoursStart`.
>   - `services/scheduling.ts` — `computeExecuteAt` and the **≤1 pending proactive task per chat** invariant (`enforceSingleProactiveTask`, `hasPendingProactiveTask`, the three `deletePending*` sweeps), including the `perChannel` mode that lets a dual test chat hold one phone and one email touch.
>   - `services/taskDispatch.ts` — the at-most-once dispatch guard: `claimTask` flips `executed = true` in a transaction **at dispatch**, before the 15–45s turn runs, which is what closes the duplicate-call/email/review storm the source calls the "@AI-trigger storm".
>   - `services/rateLimit.ts` — the Firestore fixed-window token bucket, plus `secondsUntilReset`, which exists to fix a real starvation bug: a bucket-deferred email that merely "retries soon" lands back in the still-full window and most of a campaign's email never sends.
>   - `services/dncAreaCodes.ts` — the FTC SAN area-code registry: validation, expiry normalization, batched upsert, and the `effectiveAllowed`/`phonePasses` gate.
>   - `services/skillsResolver.ts` — stage → system prompt + tool set, narrowed to `outbound`/`both` skills, including the outbound-only base-prompt **wipe** (and therefore `restoreWipedInjections`) and the exclusion of `voice_skill` entries from the text prompt.
>   - `services/emailFormat.ts` — the dependency-free Markdown → `multipart/alternative` renderer. The `*` in its trailing-punctuation set is load-bearing: without it Gmail's auto-linker swallows a trailing `**` into the href and corrupts every bold link.
>   - `services/callScope.ts` — **partial by design**: only `buildPhoneConsentAskLine`, the deterministic TCPA/PEWC consent-ask cadence (hard ≤2 asks, skipped entirely for `business_only` campaigns, and the counter bumps only when the disclosure actually went out so a failed send does not consume an ask). The rest of `call_scope.py` is voice-prompt assembly and lands with Phase 6.
> - **Why:** These modules are what the campaign, email, and voice phases all call before doing anything irreversible, so they have to exist first — and they are the layer where a subtle port error is most expensive, since a wrong answer is a call placed at 6am, a prospect called twice, or a consent disclosure that never went out. Each module's **fail direction** is preserved verbatim from the source and documented in its docstring, because the two directions are deliberately opposite and a later "consistency" cleanup would silently break one of them: `claimTask` fails **closed** (skipping a tick is cheap, a duplicate call is not), `rateLimit.tryConsume` fails **open** (a limiter fault must never stop sending), the business-hours guard fails **open** except that an unknown timezone _tightens_ the window, and `hasPendingProactiveTask` fails **closed** because its caller reads `false` as "cadence stalled, schedule another touch".
> - **Files:**
>   - `outbound/services/{businessHours,scheduling,taskDispatch,rateLimit,dncAreaCodes,skillsResolver,emailFormat,callScope}.ts`
>   - `outbound/utils/{timezoneLookup,timezoneTables}.ts`
>   - `outbound/testSupport/fixtures/zip3FromPythonSource.json`
>   - `outbound/testSupport/mockFirestore.ts`
>   - `outbound/__tests__/services/{businessHours,guards,compliance}.test.ts`
>   - `outbound/__tests__/utils/timezoneLookup.test.ts`
> - **Deliberate divergence from the source:** holiday detection uses `date-holidays`, not the Python `holidays` package. The fail-open contract and the federal/state split are preserved, but exact date parity between the two libraries is not guaranteed and is not asserted.
> - **Verification:** 356 tests across 10 suites, `tsc --noEmit` clean. The ZIP3 derivations are checked against a fixture captured from the Python source's actual output rather than re-derived in the test, so a transcription error in the tables cannot pass by matching a bug in both places.
> - **Note:** Adding these suites surfaced a gap in the Phase 1 Firestore double — `collection().listDocuments()` was not implemented, so `upsertAreaCodes`' existing-ID scan hit its `catch` and restamped `created_at` on every write. Because that scan is deliberately fail-soft, the mock's silence looked like passing code; the double now implements it.

---

> ### Outbound agent port — Phase 1: the data-access layer
>
> - **What changed:** Replaced all 128 `inbound_agent` imports the source relied on with five native modules under `outbound/firebase/`, plus an in-memory Firestore double for the test suites.
>   - `chat.ts` — memory, tasks, labels, the rapid-queue soft lock, pending-call records, LLM usage logs, message history, and the Bedrock-format normalizers (`normalizeMessageContent` / `normalizeBedrockMessage` / `normalizeToolResultContent`, plus `extractInfo` and `getFileTypeFromUrl`).
>   - `outboundChatMessages.ts` — the `messages_v3` / `activities` / `notifications` writers, including the outbound-specific rule that a `make_phone_call` card is written **only** when the call was actually placed (`status === 'in_progress'` _and_ a truthy `call_id`); a deferred/skipped/blocked/errored call becomes an activity with no conversation card.
>   - `agent.ts` — `getAgent`, `getAgentActions` (batched shared-action resolution), `getEnabledFunctionsForAgent`, `getAgentDataForPrompt`, `getVoiceAgentConfig`, with the `subagent → lead_ai` and `oversee_agent → parent_agent` inheritance rules.
>   - `skills.ts` — `getSkillsForAgent` with by-**name** parent inheritance (an override with `status: 'inactive'` is how an operator disables an inherited skill), `getAvailableStages`, `withCanonicalStages`.
>   - `prospect.ts` — the stage machine: forward-only transitions, `Lost` terminal, the **Lead lock** (once a chat reaches `Lead` its `stage` never changes; everything after is a `sub_stage`), and promote-then-substage for a post-Lead value arriving at a pre-Lead chat.
>   - `outbound/testSupport/mockFirestore.ts` — an in-memory Firestore double modelling the semantics the ported code depends on: `update()` rejects on a missing document, dot-path field updates, and resolved `serverTimestamp`/`increment`/`arrayUnion`/`arrayRemove`/`delete` sentinels.
> - **Why:** The source's outbound package is not self-contained — it reaches into the sibling inbound Django app in 128 places. Collapsing that into five native modules is what makes the rest of the port possible without importing a second app's schema. The behavioural _why_ in the source comments is preserved as TSDoc, because it documents non-obvious invariants (why `setMemory` writes dot-paths rather than merging a map, why `claim_task` fails closed while `try_consume` fails open) that a later "simplification" would quietly break.
> - **Files:**
>   - `outbound/firebase/chat.ts`
>   - `outbound/firebase/outboundChatMessages.ts`
>   - `outbound/firebase/agent.ts`
>   - `outbound/firebase/skills.ts`
>   - `outbound/firebase/prospect.ts`
>   - `outbound/firebase/db.ts`
>   - `outbound/types.ts`
>   - `outbound/testSupport/mockFirestore.ts`
>   - `outbound/__tests__/firebase/{chat,normalize,messageCards,prospect,skills}.test.ts`
> - **Deliberate divergences from the source** (each recorded in the relevant module docstring):
>   - **`messages_v2` is not ported.** For outbound it was strictly redundant — every field exists in `messages_v3`, and its unique `tool: {tool_name, input, output}` envelope is what `activities.toolCall` replaced. Dropping it also removed three live defects: `unread_count` was incremented **twice** per inbound customer message (the v2 and v3 writers each bumped it), the v2 writer computed its own timestamp instead of taking the turn's `base_timestamp` so its rows drifted by the turn duration (15–45s), and a `toolResult` with no matching `toolUse` raised inside it and abandoned the whole batch.
>   - **The dealer-analytics subsystem behind `set_prospect_stage` is not ported** — `update_stage_analytics`, `record_lead_origin_source`, `decrement_crm_won_count`, `update_prospect_stage_on_metrics`, and the `appraisals` mirroring. That is the inbound product's per-dealer/per-vehicle reporting layer; `appraisals` has no outbound equivalent (outbound contacts are vehicle-less B2B prospects) and no outbound code path reads any of it. The `dealersId`/`companyId` arguments are still accepted and recorded on each transition, so call sites match the source and `stage_history` remains complete enough to build outbound reporting on later.
>   - **`filter_tasks_within_window` is not ported** — it appears only in source comments; the outbound cron implements its own overdue-safe `_filter_due_outbound_tasks`.
> - **Verification:** 198 tests across 6 suites, `tsc --noEmit` clean, `eslint outbound/` clean. One real type bug surfaced and was fixed: `ToolResult.status` was typed `string`, which made `deriveMessageStatus`'s numeric-HTTP-code branch (the Unipile send path returns a bare status) unreachable from typed callers.

---

> ### Outbound agent port — Phase 0: scaffolding, config, and Firestore seam
>
> - **What changed:** First phase of porting `ai-sales-backend/outbound_agent` (a 26,571-line Django app) to TypeScript under a new top-level `outbound/` directory. This phase lands the foundation only:
>   - `outbound/config.ts` — one module replacing the source's two config sources (Django `settings.*` and scattered `os.getenv`). Every value is read lazily inside a function so tests can set `process.env` directly, and the source's **two opposite boolean conventions are preserved as separate functions**: `flagDefaultOn` (kill-switches — `getenv(X, "1")` off only for `0/false/off/no`, so any unexpected value stays ON) and `flagDefaultOff` (explicit opt-ins — ON only for the literal `"true"`). Integration credentials go through `requireEnv`, which throws `OutboundIntegrationNotConfigured` naming every missing key at once.
>   - `outbound/types.ts` — the Firestore document shapes (`ChatDoc`, `ChatMemory`, `TaskDoc`, `CampaignDoc`), the Bedrock Converse wire format, tool-result statuses, and the `messages_v3`/`activities`/`notifications` card types. Field names are snake_case verbatim (`execute_at`, `phone_opt_out`, `outreach_lane`) because they are the stored data contract.
>   - `outbound/firebase/db.ts` — the single Firestore seam (all outbound modules import `db` from here, so tests mock one place), plus `toDate` for the three shapes a stored datetime can arrive in, `getAllChunked` (the batched parent-doc read the source needed to stop blowing the gRPC stream deadline), and `runWithConcurrency` standing in for `ThreadPoolExecutor`.
>   - Dependencies for the later phases, all inert until configured: `luxon` + `@types/luxon` and `date-holidays` (replacing `pytz`/`holidays`), `@anthropic-ai/sdk`, `groq-sdk`, `@aws-sdk/client-bedrock-runtime`, `twilio`, `@sendgrid/mail`, `@hubspot/api-client`.
>   - ~90 commented env placeholders in `.env_example` covering LLM providers, voice, email, CRM, compliance providers, and every `OUTBOUND_*` tunable.
> - **Why:** The flow being replicated (campaign enrollment → paced cadence → LLM turns that call/email prospects → transcript review → CRM sync) is not self-contained in the source: it imports 128 distinct `inbound_agent` modules. Establishing the config, type, and Firestore seams first is what lets the remaining phases port module-for-module without each one re-deciding how it reaches the database or reads a flag. The whole thing must load and run its deterministic gating on a machine with no integration keys set, which is why nothing throws at import.
> - **Files:**
>   - `outbound/config.ts`
>   - `outbound/types.ts`
>   - `outbound/firebase/db.ts`
>   - `outbound/__tests__/config.test.ts`
>   - `.env_example`
>   - `package.json`
> - **Note:** Outbound is server code, so its Jest suites declare `@jest-environment node`. That pragma only works from the **leading** docblock — an earlier revision put an `eslint-disable` comment above it, which silently dropped the file back to the project's jsdom default (verified: `typeof window` was `object`). The disable comment now sits below the docblock.

---

### 🐛 Fixes

---

> ### Restore `dotenv` as a direct devDependency to unblock `tsc --noEmit`
>
> - **What changed:** Added `dotenv` to `devDependencies` and resynced `yarn.lock` with `package.json` (a `yarn install` pruned the stale `@browserbasehq/stagehand` / `@anthropic-ai/sdk` / `@ibm-cloud/watsonx-ai` trees that the lockfile still pinned, plus added the platform-specific `sharp` binaries for this machine).
> - **Why:** `dotenv` was only ever present transitively via `@browserbasehq/stagehand`. Once the lockfile was resynced and that tree pruned, the tracked `test-unipile.ts` script — which does `import dotenv from 'dotenv'` — failed typecheck with `TS2307: Cannot find module 'dotenv'`, and the husky pre-commit hook blocked every commit. Declaring it directly makes the dependency explicit rather than incidental.
> - **Files:**
>   - `package.json`
>   - `yarn.lock`

---

> ### Suppress three `no-undef` false positives inline and drop an unused catch binding
>
> - **What changed:** Added a single `// eslint-disable-next-line no-undef` above the one `React.*` type annotation in each of `AuthProvider` (`React.ReactNode`), `SettingsManager` (`React.ChangeEvent`), and the login page (`React.FormEvent`), and changed the playbook-fetch `catch (e)` in the Intelligence Hub page to a bare `catch`.
> - **Why:** `js.configs.recommended` enables `no-undef`, which flags those three annotations as undefined — false positives, since they are type-only references to the React UMD namespace that TypeScript resolves and ESLint's scope analysis cannot. Together with the unused `e`, these four errors were failing the `lint-staged` pre-commit hook on the files in this batch. Suppressed per-line rather than turning `no-undef` off repo-wide in `eslint.config.mjs`, so the rule keeps catching genuinely undefined identifiers everywhere else.
> - **Files:**
>   - `src/app/AuthProvider.tsx`
>   - `src/app/admin/settings/SettingsManager.tsx`
>   - `src/app/login/page.tsx`
>   - `src/app/admin/intelligence/page.tsx`

---

## 🗓️ **2026-06-17**

---

### ✨ Features

---

> ### Pipeline Search Instructions / ICP threaded through search, qualification, and learning
>
> - **What changed:** Added a "Search Instructions / Ideal Customer Profile" textarea to both the **create** and **edit** pipeline forms (saved to `pipeline.description`), wired through the POST and PATCH `/api/admin/pipelines` handlers. The pipeline `description` now flows into three more places beyond niche discovery: (1) the **lead qualification** prompt — `generatePitchNode` fetches the pipeline and passes `icp` into `generatePitch`, which injects an "Ideal Customer Profile" block into the Gemini system prompt so each lead is judged against the ICP; (2) the **learner agent** — both `runLearnerAgent` and `runBatchLearnerAgent` fetch the pipeline goal and inject it into their router and playbook-update prompts so learned rules stay aligned with the ICP; (3) the **Intelligence Hub** page and the **pipeline cards**, which now display the saved ICP. Also relabeled the card's "Control Room →" link to "Edit / Control Room →".
> - **Why:** The pipeline `description` was previously only consumed by `crawlStrategyAgent` (niche/search generation). Surfacing it as an explicit ICP field and threading it through qualification and learning lets a single instruction block steer the whole pipeline.
> - **Files:**
>   - `src/app/admin/pipelines/PipelinesManager.tsx`
>   - `src/app/api/admin/pipelines/route.ts`
>   - `lib/services/geminiPitchGenerator.ts`
>   - `lib/pipeline/runPipeline.ts`
>   - `lib/agents/learnerAgent.ts`
>   - `src/app/admin/intelligence/page.tsx`

---

> ### Prioritize location, customer type, and demographics in crawl strategy generation
>
> - **What changed:** Added a "TARGETING PRIORITY" step 0 to the `crawlStrategyAgent` prompt instructing the model to first extract, in strict order of importance, (a) location/geography, (b) customer types/personas, and (c) demographics & firmographics from the pipeline goal — inferring a reasonable value when the goal omits one. Steps 1–3 were rewritten to consume those filters: every synthesized niche must reflect them, every `tavilyQuery` must combine customer type/demographic with the target location (`"<customer type> in <location>"`), `firecrawlMaps` should prefer location-specific directories, and each `marketHypothesis`/`confidenceScore` must explicitly reference them. Also changed the Tavily market-trends query from `market trends <goal> high margin industries <seedUrls>` to `target customer segments, demographics and locations with highest buying intent for: <goal> <seedUrls>`.
> - **Why:** The agent was generating niches from broad market-trend signals, so geographically-scoped pipeline goals produced global queries and off-region leads. Location is the strongest disqualifier for a lead, so it now gates niche selection and every generated query instead of being one signal among many. The Tavily query was retuned to surface buyer segments rather than high-margin industries so the search results feed the same targeting decision.
> - **Files:**
>   - `lib/agents/crawlStrategyAgent.ts`

---

> ### Add "Use environment variables" toggle for global API keys
>
> - **What changed:** Added a `useEnvKeys` boolean to `SystemSettings` and a checkbox in the Settings → Global Integrations section. When checked, the four API-key inputs (OpenAI, Gemini, Firecrawl/Apify, Unipile) are disabled and dimmed with a "Using env variable" placeholder. The flag persists via the existing settings PATCH route (which spreads the body), so no route change was needed.
> - **Why:** To make explicit that the server's environment variables are the key source. Note: the backend services already read `process.env.*` directly and never consumed `settings.apiKeys`, so this toggle currently documents/locks the intended behavior rather than switching a live code path.
> - **Files:**
>   - `lib/types/index.ts`
>   - `src/app/admin/settings/SettingsManager.tsx`

---

> ### Add Google sign-in to the login page
>
> - **What changed:** Added a "Continue with Google" button to the login page using Firebase's `GoogleAuthProvider` and `signInWithPopup`, with an "or" divider separating it from the existing email/password and magic-link forms. The `handleGoogleSignIn` handler intentionally does **not** call `router.push('/admin')` after the popup resolves — navigation, profile creation, and the `auth_token` cookie are all handled by the existing `AuthProvider` `onAuthStateChanged` listener.
> - **Why:** To give users a one-click sign-in option alongside the existing email/password, sign-up, and magic-link flows. Navigating from the handler raced ahead of `AuthProvider` setting the `auth_token` cookie, so the server-component `/admin` guard (`getAuthenticatedUserId()` → `redirect('/login')`) saw no cookie and bounced the user back to `/login`. Letting `AuthProvider` set the cookie and then redirect removes the race. (An interim `signInWithRedirect` attempt was reverted: it fails to persist on `localhost` with the default `*.firebaseapp.com` authDomain due to Chrome's third-party storage partitioning.)
> - **Files:**
>   - `src/app/login/page.tsx`
> - **Note:** Requires enabling the Google provider in the Firebase Console (Authentication → Sign-in method) for the `ai-content-outreach-agent` project; otherwise sign-in returns `auth/operation-not-allowed`.

---

### 🐛 Fixes

---

> ### Fix "Rendered more hooks than during the previous render" on magic-link login
>
> - **What changed:** Changed `AuthProvider` to render its route subtree unconditionally (`{children}`) instead of gating it behind the client-only `loading` flag (`{!loading && children}`).
> - **Why:** Magic links point to `origin + '/admin'`, so clicking one lands on `/admin?oobCode=…`. There, `loading` flipped `true → false` mid-navigation, toggling whether the gated route subtree rendered and producing React's "Rendered more hooks than during the previous render" runtime error on first load. Rendering `children` unconditionally keeps the tree consistent across server render, hydration, and the auth-state transition. Protected pages remain safe because they already enforce auth server-side via `getAuthenticatedUserId()` → `redirect('/login')`, and pages now server-render properly instead of being client-only.
> - **Files:**
>   - `src/app/AuthProvider.tsx`

---

## 🗓️ **2026-05-03**

---

### 🐛 Fixes

---

> ### Fix Unipile DSN parsing not matching numbered subdomains + plain base URL support
>
> - **What changed:** Broadened the DSN check in `getUnipileConfig` from `dsn.includes('api.unipile.com')` to `dsn.includes('.unipile.com')` so numbered subdomains like `api29.unipile.com` are handled. Added logic to distinguish a plain base URL (3 colon-segments, e.g. `https://api29.unipile.com:15975/`) from an embedded-token DSN (4+ segments, e.g. `https://api29.unipile.com:15975:TOKEN`) — plain base URLs now use it as `UNIPILE_BASE_URL` and fall back to `UNIPILE_TOKEN` for the key. Also added trailing-slash stripping so `https://api29.unipile.com:15975/` resolves cleanly. Corrected `UNIPILE_BASE_URL` in `.env` to use the full `https://` URL with trailing slash, and fixed a stray `m` prefix in `UNIPILE_TOKEN`.
> - **Why:** The too-narrow `api.unipile.com` check caused DSN parsing to be silently skipped for `api29`-style instances, leaving `baseUrl` unset and causing connection timeouts or config errors. The token typo (`muzzlbHfz` vs `uzzlbHfz`) was causing 401s independently.
> - **Files:**
>   - `lib/services/unipile.ts`
>   - `.env`

---

> ### Fix Unipile 401 caused by DSN token not being parsed in all functions
>
> - **What changed:** Extracted a shared `getUnipileConfig()` helper in `unipile.ts` that parses both plain token and DSN formats (`https://api.unipile.com:PORT:TOKEN`). All four functions — `createUnipileHostedAuthLink`, `getConnectedAccounts`, `deleteUnipileAccount`, and `sendWhatsappMessage` — now use it. Previously only `sendWhatsappMessage` did the DSN parsing; the other three sent the full DSN string as the `X-API-KEY` header, causing a 401 "Missing credentials" from Unipile.
> - **Why:** When `UNIPILE_TOKEN` is set to a DSN string, `createUnipileHostedAuthLink` was forwarding the entire DSN as the API key rather than extracting the token segment, producing a 401 on every connect-link generation attempt.
> - **Files:**
>   - `lib/services/unipile.ts`

---

> ### Fix `disconnectConnection` silently failing due to wrong Firestore doc ID
>
> - **What changed:** `disconnectConnection` now tries to find the document by the passed ID first, then falls back to querying `where('instanceId', '==', docId)` if nothing is found. All callers updated to pass `conn.id` (the actual Firestore doc ID) instead of `conn.instanceId`. Added credentials-mismatch detection in `ConnectPage`: when Unipile loads successfully but the stored `instanceId` isn't in the returned accounts, a `credentialsMismatch` flag is passed to `ConnectManager` which renders an amber warning banner prompting the user to disconnect and reconnect.
> - **Why:** The `connections` document in Firestore uses the userId as its doc ID (not the Unipile `instanceId`). Calling `db.collection('connections').doc(instanceId)` resolved to a non-existent path, so `doc.exists` was always false and the status update was a silent no-op — the DB was never marked `disconnected` on disconnect. The credentials-mismatch detection covers the case where Unipile API succeeds but with new credentials that don't have the previously connected account.
> - **Files:**
>   - `lib/db/connections.ts`
>   - `src/app/api/admin/connections/route.ts`
>   - `src/app/admin/connections/page.tsx`
>   - `src/app/admin/connections/ConnectManager.tsx`

---

> ### Gracefully handle Unipile API errors during fetch and disconnect
>
> - **What changed:** Updated `getConnectedAccounts` to throw errors and log via `console.warn` on failure instead of returning an empty array, and updated the UI (`ConnectManager` and `ConnectPage`) to display the error. Added logic to `ConnectPage` to automatically soft-delete (status: 'disconnected') active connections in the DB when API credentials change or fail (e.g. 401). Updated the DELETE connection endpoint to catch Unipile API errors and proceed with DB soft-deletion regardless. Finally, changed `ConnectManager` to correctly fallback to the empty input state if the connection object status reads 'disconnected'.
> - **Why:** When the Unipile API goes down or credentials are bad, it previously caused a hard server crash and aggressive `console.error` logs during account rendering, and prevented users from removing broken DB connections. The automatic DB cleanup keeps state synced when API keys rotate, while preserving historical connection data via soft-deletes. Furthermore, the UI previously got stuck rendering an empty "Active Connection" card for soft-deleted documents, blocking reconnection attempts.
> - **Files:**
>   - `lib/services/unipile.ts`
>   - `src/app/admin/connections/page.tsx`
>   - `src/app/admin/connections/ConnectManager.tsx`
>   - `src/app/api/admin/connections/route.ts`

---

### 📚 Docs

---

> ### Full Architecture & README Rewrite with DB Schema
>
> - **What changed:** Rewrote `Architecture.md` with a complete Database Schema & Relationships section covering all 12 Firestore collections (field names, types, FK annotations, and a full relationship map). Fixed the stale sandbox path description (old `pipelines/{pipelineId}/sandbox_runs/...` → correct `leads/sandbox_{pipelineId}_{runId}/items/`), added the `NicheHealthEvaluator` agent, Tavily to the integrations table, and all missing `lib/db/` modules to the project structure. Updated `README.md` to fix incorrect env var names (`APIFY_TOKEN`, `UNIPILE_TOKEN`, `UNIPILE_BASE_URL`), add the Niche Health Monitoring feature, Tavily to the stack, and the `Number Invalid` dispatch behavior.
> - **Why:** Documentation was missing the full DB schema, had a stale sandbox storage path, incorrect env var names, and was missing agents and integrations added since the initial write.
> - **Files:**
>   - `Architecture.md`
>   - `README.md`

---

### 🧹 Refactors

---

> ### Remove unused `getConnectedAccounts` import
>
> - **What changed:** Removed the unused `getConnectedAccounts` named import from `whatsappDispatcher.ts`.
> - **Why:** Eliminated an ESLint `no-unused-vars` error; the function was imported but never called in this file.
> - **Files:**
>   - `lib/services/whatsappDispatcher.ts`

---

> ### Clear remaining ESLint errors in the scraper, crawl route, and strategy agent
>
> - **What changed:** In `websiteScraper.ts`, added a file-level `/* eslint-disable no-useless-escape */` (the phone/handle regexes need the escapes) and gave the five bare `catch {}` blocks a `//` body to satisfy `no-empty`. Removed the unused `MAX_CONCURRENCY` constant from the `run-crawl` route (the limit is passed in per call). Added an `eslint-disable-next-line @typescript-eslint/no-unused-vars` above the playbook-fetch `catch (e)` in `crawlStrategyAgent.ts`, where the error is intentionally not logged.
> - **Why:** To clear the lint failures in the files touched by the Unipile/connections work so `yarn lint` no longer flags them. All are no-op suppressions or dead-code removals — no behavior changed. (Unrelated `no-undef` / `no-unused-vars` errors remain elsewhere in the repo and were left alone.)
> - **Files:**
>   - `lib/services/websiteScraper.ts`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `lib/agents/crawlStrategyAgent.ts`

---

> ### Update Unipile credentials in `.env_example`
>
> - **What changed:** Replaced the `UNIPILE_TOKEN` / `UNIPILE_BASE_URL` example values with the current `api29` instance (`https://api29.unipile.com:15975/`, full scheme + trailing slash) and commented out the previous `api41` pair for reference.
> - **Why:** To keep the example file aligned with the working configuration after the Unipile instance change, and to document the full-URL form that the broadened DSN parser expects.
> - **Files:**
>   - `.env_example`

---

### 🐛 Fixes

---

> ### Fix undefined dispatchStatus in triage-lead
>
> - **What changed:** Removed undefined dispatchStatus assignment in update payload.
> - **Why:** Firestore requires either a defined value or the field omitted instead of undefined.
> - **Files:**
>   - `src/app/api/admin/triage-lead/route.ts`

## 🗓️ **2026-05-03**

---

### ⚡ Performance

---

> ### Replaced `<img>` tags with `next/image`
>
> - **What changed:** Replaced native HTML `<img>` elements with `next/image` components.
> - **Why:** Prevent ESLint warnings and optimize image loading and bandwidth.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/admin/leads/[id]/page.tsx`
>   - `src/app/admin/leads/outcomes/OutcomeCard.tsx`

---

### ✨ Features

---

> ### Empty Learner Agent Synthesis State Check
>
> - **What changed:** Added an early exit guard inside `runBatchLearnerAgent` to gracefully bypass LLM playbook analysis if no actionable feedback (0 approved, 0 rejected, 0 edits) was provided by the user during the Sandbox review.
> - **Why:** Prevents unnecessary and potentially confusing Gemini agent executions that would otherwise attempt to generate feedback intelligence from an empty payload, saving API costs and maintaining clean logs.
> - **Files:**
>   - `lib/agents/learnerAgent.ts`

---

> ### Improved Sandbox Finalization UX & Stability
>
> - **What changed:** Replaced the blocking browser `alert()` with a smooth, non-intrusive auto-dismissing green toast notification for successful sandbox finalizations. Fixed a UI bug where finalized sessions didn't properly clear from the dropdown context, causing visual state anomalies. Re-wired the `sessionStatus` update in `/api/admin/finalize-sandbox` to write `Ended` instead of `Completed`, and updated the UI to clear local state optimistically.
> - **Why:** Solves issues where the green success alert remained stuck due to unmount race conditions or incomplete state resets. Ensures the sandbox tray robustly returns to a clean, empty state ready for the next test run without lingering pipelines.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/finalize-sandbox/route.ts`

---

> ### Status filter added to Sandbox Review Tray
>
> - **What changed:** Added a dropdown to filter leads by their processing status in the Sandbox Review Tray.
> - **Why:** Allows users to easily sort and manage qualified, incomplete, or failed leads during sandbox review.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

### 🐛 Fixes

---

> ### Fixed auto-scroll bug in Sandbox Diagnostics Terminal
>
> - **What changed:** Implemented a suspension period for user-scroll detection during programmatic auto-scrolling.
> - **Why:** Prevents smooth scrolling mechanics from erroneously disabling the auto-scroll feature when new messages push the terminal up.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

### 🧹 Refactors

---

> ### Hard filtering for missing contact information
>
> - **What changed:** Bypassed all downstream AI nodes for leads that lack a phone number immediately after scraping.
> - **Why:** Saves compute and accurately discards incomplete targets without wasting processing resources.
> - **Files:**
>   - `lib/pipeline/runPipeline.ts`

---

### 🐛 Fixes

---

> ### Unipile Dispatcher Migration & Strict Target Rules
>
> - **What changed:** Swapped the custom webhook out for Unipile's `/chats` API within `whatsappDispatcher`. Implemented `getPrimaryConnection` to accurately route outgoing messages from the user's active connection instance ID. Added E.164 phone number formatting with the strict Unipile `@s.whatsapp.net` suffix and explicit backend/frontend logging for message sending. Filtered dispatch leads more strictly to include `dispatchStatus === 'approved'` or purely `status === 'Qualified'` while explicitly screening out anything marked `'rejected'`. Added UNIPILE_DSN parsing support, and captured explicit 404 "Number not on WhatsApp" error throws for invalid leads.
> - **Why:** The legacy webhook was failing on valid WhatsApp numbers due to missing variables and custom schema expectations, so standardizing around Unipile creates a reliable delivery layer. Calling `/chats` accurately opens new DMs. Lead filtering was leaky, potentially allowing rejected sandbox profiles to occasionally squeeze through cron batches. Explicit logs and "Number Invalid" categorizations provide better visibility into dispatch successes and errors.
> - **Files:**
>   - `lib/services/whatsappDispatcher.ts`
>   - `lib/services/unipile.ts`

---

### ✨ Features

---

> ### Leads Collection Restructure — Per-Run Sandbox Subcollections
>
> - **What changed:** Sandbox leads are now stored under `leads/sandbox_{pipelineId}_{runId}/items/{docId}` — one isolated subcollection per sandbox run. Automation/cron leads remain at `leads/{docId}`. Sandbox lead IDs are now encoded as `sandbox:{pipelineId}:{runId}:{docId}` (replaces the broken `sandbox_candidate:...` scheme). `getLeadDocRef` routes both formats to the correct Firestore path. `getSandboxLeadsByRun` added as a typed helper. The real-time subscription in `<ManualTriggers />` and the `synthesize-run` route were updated to the new paths.
> - **Why:** All sandbox runs previously shared a single `leads/sandbox/leads` collection. Querying leads for a specific run required an extra `where('crawlSessionId')` filter, and deduplication bled across runs. The new structure makes each run's leads fully self-contained and removes the fragile composite-ID encoding.
> - **Files:**
>   - `lib/db/leads.ts`
>   - `lib/types/index.ts`
>   - `src/app/api/admin/synthesize-run/route.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

> ### WhatsApp Dispatch Status Persisted to Lead Document
>
> - **What changed:** After each WhatsApp send attempt, the dispatcher now writes `lastMessageSent` (the exact pitch text), `lastMessageSentAt` (timestamp), and `dispatchSuccess` (bool) directly onto the lead document in a single atomic `updateLead` call — replacing the narrower `updateLeadStatus` call that only flipped the status field.
> - **Why:** There was no way to see what message was actually sent to a lead or whether the dispatch succeeded without cross-referencing the separate `dispatchLogs` collection. All dispatch context is now on the lead doc itself.
> - **Files:**
>   - `lib/services/whatsappDispatcher.ts`
>   - `lib/types/index.ts`

---

> ### Autonomous Niche Rotation & Self-Healing Protocol
>
> - **What changed:** After every crawl session (sandbox or cron), a new `NicheHealthEvaluator` agent calculates the success rate (qualified / total) for each niche. If a niche scores under 5% for 3 consecutive sessions, its status is automatically set to `cool-down` in Firestore with a human-readable reason. The agent then fires a **Lateral Pivot**: it uses Tavily to research an adjacent market, asks Gemini to invent a replacement niche, and inserts it as a new active niche with `replacedNicheId` / `replacedNicheName` set. All steps emit logs to the sandbox diagnostic terminal. Cool-down niches are excluded from the Crawl Strategy Agent's selection and the cron runner's active set. The Niche Intelligence page now shows a pipeline selector dropdown, per-niche health bars (green/yellow/red), last-crawled timestamps, a red "Cool-Down" badge + reason row, and an amber "Auto-Added" badge for AI-generated replacements.
> - **Why:** Previously, a failing niche would silently waste API budget across every run with no corrective action. The system now detects exhausted markets autonomously, pauses them, and self-heals by sourcing a replacement without any Overseer intervention.
> - **Files:**
>   - `lib/agents/nicheHealthEvaluator.ts` _(new)_
>   - `lib/types/index.ts`
>   - `lib/db/niches.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/cron/crawl/route.ts`
>   - `src/app/admin/niches/NichesManager.tsx`
>   - `src/app/admin/niches/page.tsx`

---

> ### Sandbox Rejected Leads Tab & Advanced Triage Selection
>
> - **What changed:** Added a "Rejected" tab to the Sandbox Review Tray in `<ManualTriggers />` to separately house leads that the human Overseer has manually rejected. Implemented "Select All/Deselect All" logic bound per tab, and re-wired the "Finalize Session" endpoint to _only_ dispatch those explicitly selected leads.
> - **Why:** Cleans up the main review tray by removing grayed-out rejected leads from the main list, and provides precise bulk-dispatch capabilities for approved leads while retaining the rejected ones for Learner Agent synthesis.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/finalize-sandbox/route.ts`

---

> ### Lead Inspector Context Data Binding & Analyst Narrative Persistence
>
> - **What changed:** Added the `analystNarrative` property directly to the `Lead` schema and successfully mapped it through the LangGraph pipeline's `saveLeadNode` to persist to Firestore. In the `<LeadInspectorModal />`, swapped out the rigid placeholder for a dynamic "Lead Context" block that displays the target's niche mapping, organic discovery source, and explicitly states how/why the AI determined their visual poverty gap score.
> - **Why:** Prevents AI context loss by ensuring the Gemini Analyst's exact reasoning survives the graph orchestrator to reach the database, ultimately allowing human operators to instantly audit _why_ the AI believes this prospect is a perfect fit.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/pipeline/runPipeline.ts`
>   - `src/app/admin/sessions/LeadInspectorModal.tsx`

---

> ### LearnerAgent live terminal logging on lead rejection
>
> - **What changed:** `runLearnerAgent` now accepts a `sessionId` and emits step-by-step layman-friendly logs to the Sandbox diagnostic terminal at every stage — feedback received, agents identified, playbook rewrite in progress, and completion. The triage-lead route now fires the learner agent as a background task on every rejection.
> - **Why:** Previously only one log line appeared when a lead was rejected; the full LLM synthesis was happening silently. Users now see the AI learning process in real time.
> - **Files:**
>   - `lib/agents/learnerAgent.ts`
>   - `src/app/api/admin/triage-lead/route.ts`

---

> ### Playbook last change note
>
> - **What changed:** `updateIntelligenceRegistry` now accepts and stores a `lastChangeNote` (first line of Gemini's dissection reasoning, capped at 200 chars) and `createdAt` on new documents.
> - **Why:** The Active Playbooks UI was showing "Auto-updated from latest synthesis run" for every agent — the actual reason for the update is now stored and displayed instead.
> - **Files:**
>   - `lib/db/intelligence.ts`

---

> ### Live Sandbox Triage Logging
>
> - **What changed:** Added a `/api/admin/triage-lead` endpoint and hooked it up to the Sandbox Inspector. When a user approves or rejects a lead, the system now logs this action to both the backend terminal and the Sandbox diagnostic UI terminal in real-time.
> - **Why:** Provides immediate visual feedback to the user that their triage decision was registered by the system prior to finalization, fulfilling the expectation of live tracking.
> - **Files:**
>   - `src/app/api/admin/triage-lead/route.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

> ### Article & News URL Filtering in Prospector
>
> - **What changed:** Expanded `LISTICLE_REGEX` in `autoprospector.ts` to also catch `/news/`, `/articles/`, `/press/`, `/press-release/`, and `/pr/` paths. URLs matching these patterns are now routed through the Listicle Extractor (Firecrawl + Gemini) rather than being treated as brand leads.
> - **Why:** News article URLs (e.g. wardsauto.com/news/...) were slipping through as leads, resulting in media outlets appearing in the audit queue.
> - **Files:**
>   - `lib/services/autoprospector.ts`

---

> ### Phone Number Country Code Normalization
>
> - **What changed:** Fixed `normalizePhone` in `websiteScraper.ts` (was logically broken — stripped `+` before checking for it). Fixed the `tel:` path to use `libphonenumber-js` with a TLD-derived country heuristic before falling back to raw digit normalization, ensuring local-format numbers get the correct international prefix. The LLM extraction layer already instructs Gemini to prepend the country code from address context.
> - **Why:** Phone numbers in lead details were being stored without a `+` country code prefix, making them unusable for WhatsApp dispatch.
> - **Files:**
>   - `lib/services/websiteScraper.ts`

---

> ### The "Publisher vs. Business" Gate & Listicle Extractor
>
> - **What changed:** Inserted a Regex routing node in `autoprospector.ts` immediately after Tavily URL extraction. If a URL is identified as a listicle or magazine (via `/blog/`, `/story/`, `/article/`, `/features/`, `/list/`), the system uses Firecrawl and Gemini to read the Markdown, extract all actual brand websites mentioned within, and inject them back into the main pipeline queue while discarding the original magazine URL.
> - **Why:** Prevents the pipeline from mistakenly targeting media outlets while actively harvesting highly valuable grouped brand targets found inside "Top 10" style listicles.
> - **Files:**
>   - `lib/services/autoprospector.ts`

---

> ### Sandbox Finalization & Intelligence Synthesis
>
> - **What changed:** Built an unstoppable batch operation endpoint (`/api/admin/finalize-sandbox`) that replaces the old dispatch flow. When finalized, the system now dispatches all explicitly approved leads via WhatsApp, promotes them from the Sandbox to the main CRM, and forces the AI Learner Agent to analyze human rejections to update Vercel Blob Strategy Playbooks, before formally closing the session.
> - **Why:** Transitions the Sandbox from a simple testing ground into a closed-loop intelligence machine where human triage directly and autonomously rewrites future AI behavior.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/finalize-sandbox/route.ts`

---

> ### "Inspect Draft" Modal & Soft Triage UI
>
> - **What changed:** Replaced the direct Firestore mutations on the Sandbox Tray with local React state management via a new `<LeadInspectorModal />`. Users can now edit contact info, manually rewrite pitches, or prompt Gemini to regenerate them on the fly. Actions like "Approve" and "Reject" are now "Soft Decisions" that visually alter the UI (Green/Red badges) with full undo capabilities until the session is finalized.
> - **Why:** Provides a safe, forgiving interface for the Overseer to manually adjust AI outputs and triage leads without risking accidental, permanent database changes.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/admin/sessions/LeadInspectorModal.tsx`
>   - `src/app/api/admin/regenerate-pitch/route.ts`

---

> ### Explicit Lead Rejection Reasoning for AI Training
>
> - **What changed:** Added an optional "Reason for Rejection" text input to the `<LeadInspectorModal />` which captures the user's rationale when discarding a sandbox candidate. Updated the `/api/admin/finalize-sandbox` endpoint to persist this `sandboxRejectionReason` to the database, and modified the `runBatchLearnerAgent` prompt to directly inject these human-provided reasons into the Sandbox batch synthesis process.
> - **Why:** Allows the Overseer to explicitly tell the AI _why_ a lead was bad (e.g., "Not a relevant business"), ensuring the Learner Agent updates the Strategist Playbook with precise negative constraints rather than blindly guessing why a lead failed.
> - **Files:**
>   - `src/app/admin/sessions/LeadInspectorModal.tsx`
>   - `src/app/api/admin/finalize-sandbox/route.ts`
>   - `lib/types/index.ts`
>   - `lib/agents/learnerAgent.ts`

---

> ### Full-Pipeline LLM Intelligence Routing & Layman Terminal Logs
>
> - **What changed:** Completely restructured the `LearnerAgent` to use a sophisticated two-node architecture (Rejection Understanding Node -> Update Intelligence Node) for both Sandbox batch learning and continuous Outcome feedback. The initial LLM pass dynamically dissects the human's explicit feedback, figures out the expanded reasoning, and routes the new constraints only to the specific agent(s) responsible for the failure (Strategist, Scraper, Auditor, Analyst, or Copywriter). Live, layman-friendly terminal logs were also added to the Sandbox Diagnostics UI so the Overseer can watch the agents dissect feedback and update their Vercel Blob Playbooks in real-time.
> - **Why:** Transitions the intelligence layer from a rigid, hardcoded update structure into a surgical, self-routing learning mechanism. This ensures that one piece of feedback can dynamically teach multiple different AI personas simultaneously, while explicitly building trust with the Overseer by making the entire reasoning and update process visible.
> - **Files:**
>   - `lib/agents/learnerAgent.ts`
>   - `src/app/api/admin/finalize-sandbox/route.ts`

---

> ### Aggressive Phone Number Extraction Engine
>
> - **What changed:** Integrated `libphonenumber-js` to scan raw Markdown and deployed a Multi-Page Fallback Logic inside the Scraper. If no phone number is found on the homepage, the scraper actively hunts for URLs containing `/contact`, `/about`, or `/reach-us`, fires a secondary Firecrawl request, and extracts numbers from those nested pages.
> - **Why:** Significantly increases the pipeline's conversion rate by successfully discovering contact data for targets that bury their phone numbers away from the main landing page.
> - **Files:**
>   - `lib/services/websiteScraper.ts`

---

### 💅 Styling and UI Improvements

---

> ### Inline Playbook Viewer
>
> - **What changed:** Updated the "Active Playbooks" modal to render markdown documents inline with a back button, instead of defaulting to downloading the document. Display the Playbook's `lastUpdated` and `lastChangeNote` as UI metadata elements below the text preview.
> - **Why:** Eliminates friction when reviewing the AI's internal logic, allowing the Overseer to read updated playbooks directly in the dashboard and track the AI's synthesis history natively.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

> ### Disqualification Transparency & "Incomplete" UI State
>
> - **What changed:** Altered the pipeline to push narrative terminal logs when leads are discarded (e.g., missing phone numbers). Bypassed the drop rule specifically for Sandbox runs, allowing highly qualified leads with missing contact info to persist into the `sandbox_candidates` subcollection under an `incomplete` status. Rendered these leads in the UI with a yellow "Missing Contact Info" warning and added mutation support to manually fill the gap.
> - **Why:** Eliminates the UX disconnect where users see zero results without knowing why, and allows the Overseer to manually salvage highly-scored leads that just need a quick Google search for a phone number.
> - **Files:**
>   - `lib/pipeline/runPipeline.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/admin/sessions/LeadInspectorModal.tsx`

---

### ⚡ Performance

---

> ### Pipeline "Fail Fast" Reordering
>
> - **What changed:** Injected a conditional routing edge into the LangGraph pipeline immediately after the `scrapeWebsiteNode`. If no phone number is extracted, the pipeline now aborts analysis and bypasses the expensive Auditor and Pitch Generation steps (unless running in Sandbox mode).
> - **Why:** Saves substantial LLM compute costs and processing time by immediately dropping useless targets before invoking paid APIs.
> - **Files:**
>   - `lib/pipeline/runPipeline.ts`

---

### 🐛 Fixes

---

> ### Phone Number Processing Fallback & Normalization Fix
>
> - **What changed:** Modified the `websiteScraper` to fall back to passing the raw matched string (like `telMatch[1]` or the raw LLM output) to the next pipeline stage if `libphonenumber-js` fails to parse a valid E.164 number. Also updated the deduplication logic in `runPipeline` to use `replace(/[^\d+]/g, '')` instead of `replace(/\D/g, '')`, ensuring that correctly formatted numbers with a leading `+` aren't mangled by the global duplicate scanner.
> - **Why:** The pipeline was losing partially formed or non-standard phone numbers during the analysis step, rendering the `whatsappNumber` field completely empty in the UI. Additionally, the deduplicator was improperly stripping the `+` sign from numbers, causing downstream validation or formatting errors.
> - **Files:**
>   - `lib/services/websiteScraper.ts`
>   - `lib/pipeline/runPipeline.ts`

---

> ### Proper Niche Name Display in Lead Inspector
>
> - **What changed:** Passed the `pipelines` array down to `LeadInspectorModal` and added a dynamic Firestore `getDoc` fallback to fetch the `nicheName` if the ID is missing from the static props.
> - **Why:** When the Sandbox agent autonomously creates a new niche during a live session, the client-side `ManualTriggers` component (and thus the Inspector Modal) had stale props and was displaying the raw niche ID instead of the human-readable name. The dynamic lookup ensures newly created niches render correctly.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/admin/sessions/LeadInspectorModal.tsx`

---

> ### Backward-Compatible Sandbox Lead Routing
>
> - **What changed:** Added backward-compatible routing in `getLeadDocRef` to correctly map legacy `sandbox:{docId}` and `sandbox_candidate:{docId}` ID formats to their old Firestore paths (`leads/sandbox/leads/{docId}`). Added a fallback mechanism in `getLeadById`, `updateLeadStatus`, and `updateLead` to automatically retry fetching the document from the old path if it isn't found at the new location.
> - **Why:** The recent subcollection refactor broke routing for older sandbox leads, causing updates and reads to fail with "Not found or unauthorized" errors because the system was looking in the new paths for old data.
> - **Files:**
>   - `lib/db/leads.ts`

---

> ### Apify Actor Upgrade & Precision IG Extraction
>
> - **What changed:** Upgraded the `apify-client` payload to use `directUrls` and set `resultsType: 'posts'` to fix silent failures. Revamped Instagram link extraction to heuristically filter out generic pages (`/p/`, `/explore/`, `?share=`), applying fuzzy string similarity against the brand/domain to identify the true corporate profile. Added a Gemini LLM fallback if fuzzy matching scores are too low.
> - **Why:** Prevents the Auditor from crashing or analyzing the wrong profiles (e.g., journalists instead of the brand), ensuring the AI evaluates the actual target's visual poverty.
> - **Files:**
>   - `lib/services/instagramAuditor.ts`
>   - `lib/services/websiteScraper.ts`

---

> ### Vision API Base64 Image Pre-Processing (The Gemini Fix)
>
> - **What changed:** Created `fetchAndEncodeImage` to autonomously download sanitized remote images (skipping heavy files > 4MB), encode them as base64 data URLs, and map them properly into the `HumanMessage` payload. Wrapped the fetch in a try/catch to absorb 403 Forbidden errors.
> - **Why:** Patches a major leak where Gemini Vision would outright crash the pitch generation pipeline because it couldn't reliably fetch remote URLs itself.
> - **Files:**
>   - `lib/services/geminiPitchGenerator.ts`

---

### 💅 Styling and UI Improvements

---

> ### Sandbox Terminal Status and Logging Polish
>
> - **What changed:** Removed unnecessary window control icons from the terminal header. Added dynamic color-coded background badges for the sandbox status indicator (Green for success, Red for failure). Modified the crawl orchestrator to append explicit final logs upon completion or failure, and updated the terminal UI to visually distinguish system errors with a ❌ icon and red text.
> - **Why:** Makes the live status of the sandbox run instantly obvious to the user and provides a clear, distinct visual cue when errors occur during the pipeline execution.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/run-crawl/route.ts`

---

### ✨ Features

---

> ### Multi-Niche Array Processing & Schema Update
>
> - **What changed:** Updated the Strategist JSON output schema to return `targetNiches` as a strict array, instructing the LLM to select 2-3 high-confidence niches per run. The Prospector pipeline now iterates over all selected niches, updating/creating them concurrently in Firestore, and mapped discoveries are automatically tagged with their respective `niche_id`.
> - **Why:** Prevents the silent loss of valuable AI research when multiple viable niches are found, heavily boosting the discovery throughput per run and ensuring diverse CRM populating.
> - **Files:**
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `lib/services/autoprospector.ts`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/cron/crawl/route.ts`

---

> ### Hybrid Lead Discovery Engine (Tavily + Firecrawl Map)
>
> - **What changed:** Replaced the pure Firecrawl Map discovery engine with a hybrid system that runs Tavily semantic searches and Firecrawl mapping in parallel. The Prospector now merges and deduplicates results from both sources. If a mapped directory profile is found, the new DirectoryResolver uses an LLM to "click in" and extract the external brand link automatically. If 0 leads are found after resolution, the orchestrator triggers an immediate Self-Correction Loop for the Strategist to try new queries (up to 2 times).
> - **Why:** Maximizes lead volume by leveraging both open-web search intelligence and deep aggregator directory structures, while automatically filtering out generic junk domains and gracefully failing back to the Strategist when discovery queries are too broad.
> - **Files:**
>   - `lib/services/autoprospector.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/cron/crawl/route.ts`

---

> ### Data-Driven Niche Ideation (The Strategist's Research Phase)
>
> - **What changed:** Upgraded the Strategist Agent to perform a live web search via Tavily using the pipeline goal and best client seed URLs. The agent now evaluates market trends, synthesizes potential niches, and assigns a Confidence Score with a detailed Market Hypothesis. The UI now supports adding "Look-alike" client URLs during Sandbox init and displays the resulting hypothesis, score, and research citations in the Niches Manager.
> - **Why:** Transitions the AI from randomly guessing niches to backing its strategic choices with hard search data and explicitly logging its reasoning for human oversight.
> - **Files:**
>   - `lib/types/index.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/init-pipeline/route.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `src/app/admin/niches/NichesManager.tsx`

---

### 🐛 Fixes

---

> ### LearnerAgent Playbook Updates & Triage Logging
>
> - **What changed:** Fixed multiple critical bugs blocking the LearnerAgent from updating playbooks and rendering logs. In `/api/admin/synthesize-run`, explicitly passed `runId` down to the `runBatchLearnerAgent` so terminal logs can stream, and updated the endpoint to merge frontend manual triage overrides (`candidates`) so the agent actually receives the rejected leads. In `/api/admin/feedback`, fixed hardcoded `'default-pipeline'` string to correctly use `lead.pipelineId`, ensuring continuous learning updates the correct pipeline's Playbooks and timestamp.
> - **Why:** Ensures that the newly built LLM Intelligence Routing and Dynamic Dissection logic actually receives the feedback data, processes it, and successfully updates the active pipeline's playbooks with visible logs and accurate timestamps.
> - **Files:**
>   - `src/app/api/admin/synthesize-run/route.ts`
>   - `src/app/api/admin/feedback/route.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

> ### Gracefully handle expired Firebase ID tokens
>
> - **What changed:** Updated the `getAuthenticatedUserId` utility to silently catch and return null for `auth/id-token-expired` errors instead of logging them to `console.error`.
> - **Why:** Prevents Next.js 500 error overlays and noisy terminal logs when a user's session expires, allowing the app to smoothly redirect them to the login page.
> - **Files:**
>   - `lib/utils/auth.ts`

---

> ### Prevent empty pipelines execution
>
> - **What changed:** Added guard clauses to `run-crawl` and `cron/crawl` routes to skip pipeline execution when `leadsDiscovered === 0`. Appends an agent log asking the strategist to adjust targets. Also prevents pipeline execution completely when in Sandbox mode.
> - **Why:** Eliminates console spam ("Executing 0 pipelines") and prevents empty operations on both manual runs and background cron crawls while explicitly feeding 0-lead failure context back into the AI logs.
> - **Files:**
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/cron/crawl/route.ts`

---

### ✨ Features

---

> ### Sandbox Resume Runs & Checkpointing
>
> - **What changed:** Implemented checkpointing for sandbox sessions by tracking `processedBrands` in the database. Added a "Resume Failed Run" option in the UI that appears when a selected pipeline's latest run is stalled, calling the backend with a `resumeSessionId` parameter to skip already-processed URLs.
> - **Why:** Prevents data waste and API cost leakage when third-party services fail mid-run, allowing users to pick up exactly where they left off.
> - **Files:**
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `lib/db/crawlSessions.ts`
>   - `lib/types/index.ts`

---

> ### API Resiliency & Graceful Degradation
>
> - **What changed:** Built indefinite retry loops with intelligent backoffs around Firecrawl's scraping and mapping functions to gracefully handle `429 Rate limit exceeded` errors without crashing the crawler.
> - **Why:** Creates a resilient extraction pipeline that doesn't immediately fail when external vendors throttle requests, guaranteeing smoother operations.
> - **Files:**
>   - `lib/services/autoprospector.ts`
>   - `lib/services/websiteScraper.ts`

---

> ### Robust Crawl Strategy Generation
>
> - **What changed:** Upgraded the `crawlStrategyAgent` to utilize `@langchain/google-genai` with `withStructuredOutput()`. Ensures all AI-suggested niches are captured by parsing them via `.join(', ')` rather than incorrectly discarding all but the first array element.
> - **Why:** Prevents the silent loss of multiple niche targets due to strict array bounds, and fortifies the JSON output against schema drift.
> - **Files:**
>   - `lib/agents/crawlStrategyAgent.ts`

---

> ### Live Agent Diagnostics Loader
>
> - **What changed:** Introduced a smooth "Agent is thinking..." pulsing status loader at the tail-end of the Sandbox diagnostics terminal while the orchestrator is in a Running state. Altered scroll tracking to intelligently suspend auto-scroll when the user scrolls up.
> - **Why:** Enhances the real-time observer experience so users aren't left wondering if the process froze during long LLM evaluations, and doesn't forcefully yank them down while reading older logs.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

> ### Multi-Pipeline Architecture & Cross-Pipeline Deduplication
>
> - **What changed:** Introduced a "Pipelines Control Room" where users can manage independent autonomous workflows. Core entities (Niches, Leads, Sessions, Feedback) now require a `pipelineId`. Background cron jobs strictly execute only for pipelines in the `running` state. Added a LangGraph node `globalDeduplicationNode` to inherently skip targets previously contacted by ANY pipeline unless `overrideGlobalDeduplication` is explicitly enabled in the Pipeline settings.
> - **Why:** Allows users to run multiple isolated campaigns (e.g. "Roofing" vs "SaaS") without crossing wires, while structurally preventing spam through global collision avoidance.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/pipelines.ts`
>   - `src/app/admin/pipelines/page.tsx`
>   - `src/app/admin/pipelines/PipelinesManager.tsx`
>   - `src/app/api/admin/pipelines/route.ts`
>   - `src/app/api/cron/crawl/route.ts`
>   - `src/app/api/cron/dispatch/route.ts`
>   - `lib/pipeline/runPipeline.ts`

---

> ### Global Integrations & Pipeline Guardrails
>
> - **What changed:** Added Global API Keys (OpenAI, Gemini, Firecrawl, Unipile) to SystemSettings. Introduced Pipeline Guardrails (Max Daily Crawls, Max Daily Dispatches, Min AI Gap Score) configurable per Niche. Updated cron jobs (`crawl` and `dispatch`) to strictly enforce these volume limits and quality thresholds before any execution.
> - **Why:** Protects against runaway API costs, ensures minimum pitch quality, and enables flexible system-wide integration management.
> - **Files:**
>   - `lib/types/index.ts`
>   - `src/app/admin/settings/SettingsManager.tsx`
>   - `src/app/admin/niches/NichesManager.tsx`
>   - `src/app/api/admin/niches/route.ts`
>   - `src/app/api/cron/crawl/route.ts`
>   - `src/app/api/cron/dispatch/route.ts`
>   - `lib/services/whatsappDispatcher.ts`

---

> ### Global Connections Manager & Health Checks
>
> - **What changed:** Updated the Connections database and UI to support multiple Unipile accounts, displaying all active outreach numbers and their status. Implemented a `/api/cron/health` background utility to ping Unipile and sync disconnected states back to Firestore.
> - **Why:** Allows managing multiple sender identities globally and provides an automated health-check to handle token invalidations or connection drops seamlessly.
> - **Files:**
>   - `lib/db/connections.ts`
>   - `src/app/api/admin/connections/route.ts`
>   - `src/app/api/cron/health/route.ts`

---

> ### Read-Only Leads Table with Inline Feedback
>
> - **What changed:** Updated the Leads workspace to include a "Teach AI" column featuring quick-action badge buttons (Closed, Rejected, Ghosted). Clicking a badge opens an inline 3-second disappearing popover where users can type contextual notes. Uses the `/api/admin/feedback` endpoint to instantly log FeedbackSignals without page redirects.
> - **Why:** Makes the process of logging outcomes and providing contextual feedback frictionless for users, building up the data required by the Feedback Loop agent.
> - **Files:**
>   - `src/app/admin/leads/page.tsx`
>   - `src/app/admin/leads/LeadRow.tsx`

---

> ### Niche Intelligence Dashboard & Feedback Audit Ledger
>
> - **What changed:** Exposed the AI's reasoning directly in the UI. The Niches Manager now displays a textual "AI Strategy Note" for every niche, explaining its priority. The Outcomes Logger now includes a "Feedback Audit Ledger" at the bottom of the page, showing the timeline of manual signals vs explicit AI adjustments (like decreased priorities and added blacklisted signals).
> - **Why:** Creates transparency in an autonomous pipeline, letting the Overseer understand exactly why the system is targeting a market, and proving that human inputs directly alter agent behaviors.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `lib/agents/feedbackLoopAgent.ts`
>   - `src/app/admin/niches/NichesManager.tsx`
>   - `src/app/admin/leads/outcomes/page.tsx`

---

> ### Agent Playbooks (Vercel Blob Simple RAG)
>
> - **What changed:** Introduced autonomous Agent Playbooks stored as raw Markdown in Vercel Blob. A new Learner Agent (`learnerAgent.ts`) triggers in the background after every manual FeedbackSignal to synthesize the feedback and rewrite the specific playbook files. The LangGraph orchestrator (`runPipeline.ts`) fetches these playbooks at execution time and injects them directly into the agent prompts as "Simple RAG". Created an "Intelligence Hub" UI (`/admin/intelligence`) for the Overseer to read these living documents.
> - **Why:** Replaces rigid database logic with a flexible, self-improving memory bank that allows specific agent personas to continuously adapt their strategies to human feedback without bloating the database.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/intelligence.ts`
>   - `lib/services/blobStorage.ts`
>   - `lib/agents/learnerAgent.ts`
>   - `lib/pipeline/runPipeline.ts`
>   - `lib/services/geminiPitchGenerator.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `src/app/api/admin/feedback/route.ts`
>   - `src/app/admin/intelligence/page.tsx`
>   - `src/app/admin/intelligence/PlaybookViewer.tsx`

---

> ### Sandbox Initialization, Pipeline Binding & Inspection Modals
>
> - **What changed:** Added a setup modal to create a Pipeline before Sandbox runs, bound all AI operations to the pipelineId, and built inspection modals for active playbooks and full message drafts.
> - **Why:** Allows users to clearly organize memory per campaign, inspect AI logic visually, and safely override generated pitches before dispatches.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/admin/pipelines/route.ts`
>   - `lib/types/index.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `lib/agents/feedbackLoopAgent.ts`

---

> ### The "Self-Crawl" Genesis Prompt & Strategy Review Gate
>
> - **What changed:** Built a multi-step Sandbox initialization flow. Users input seed links and a rough goal, which triggers a background Firecrawl and Gemini synthesis to output a polished "Detailed Goal" and "Concept Strategy". Users review and approve this generated strategy in the UI. Upon approval, the `/api/admin/init-pipeline` endpoint natively bootstraps all underlying Agent Playbooks (Strategist, Scraper, Auditor, Analyst, Copywriter) via LLM generation and saves them to Vercel Blob before seamlessly routing the user into the live Sandbox loop.
> - **Why:** Solves the "garbage in, garbage out" problem by having the AI act as its own prompt engineer, deeply contextualizing the user's business before creating the pipeline instructions.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/generate-strategy-preview/route.ts`
>   - `src/app/api/admin/init-pipeline/route.ts`
>   - `src/app/admin/pipelines/PipelinesManager.tsx`

---

> ### Sandbox UI Upgrades & Multimodal Strategy Generation
>
> - **What changed:** Beautified the Sandbox initialization modal with a sleek, drag-and-drop image upload interface using Tailwind CSS. Shifted the `/api/admin/generate-strategy-preview` endpoint to use `@langchain/google-genai` for full multimodal support, allowing users to upload up to 10 images alongside their rough goal. Added dropdown functionality to switch between attached pipelines seamlessly within the Sandbox terminal, and implemented graceful LLM degradation if the primary URL scrape fails on protected domains (like Instagram).
> - **Why:** Drastically improves the Overseer's experience by offering intuitive image context uploading, empowering the Gemini model to analyze visual assets natively during strategy generation, and resolving critical UI nesting bugs.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/admin/sessions/page.tsx`
>   - `src/app/api/admin/generate-strategy-preview/route.ts`

---

> ### Sandbox Lead Promotion & Database Cleanliness
>
> - **What changed:** Restructured database logic using compound IDs so Sandbox Candidates write to an isolated subcollection (`pipelines/{pipelineId}/sandbox_runs/{runId}/sandbox_candidates`) by default, keeping the main leads list pristine. Updated the `/api/admin/dispatch-manual` endpoint so explicitly approved candidates are dynamically promoted into the main `leads` collection before dispatching, while unapproved "junk" candidates stay in the quarantine zone purely for backend AI Learner training via the End-of-Run Synthesizer endpoint.
> - **Why:** Maintains absolute data integrity. Prevents thousands of failed or unapproved Sandbox "junk" leads from cluttering the primary CRM, while preserving them implicitly as valuable negative-action training data.
> - **Files:**
>   - `lib/db/leads.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/dispatch-manual/route.ts`
>   - `src/app/api/admin/synthesize-run/route.ts`

---

> ### Sandbox Data Hierarchy & End-of-Run Intelligence Synthesis
>
> - **What changed:** Re-architected Sandbox data to write to a dedicated subcollection (`pipelines/{pipelineId}/sandbox_runs/{runId}`) instead of mixing with automated crawl sessions. Added implicit feedback UI inside the Sandbox (Reject button, Edit drafts) and built a `/api/admin/synthesize-run` endpoint. This triggers the Learner Agent to batch process all human actions (approvals, rejections, copy edits) and explicitly rewrite Vercel Blob Playbooks at the end of the run.
> - **Why:** Closes the Sandbox training loop. Instead of just testing, user actions implicitly teach the AI what targets to avoid and how to write better pitches, continuously improving the Playbooks via a cost-effective batch RAG update.
> - **Files:**
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/api/admin/synthesize-run/route.ts`
>   - `lib/db/crawlSessions.ts`
>   - `lib/types/index.ts`
>   - `lib/agents/learnerAgent.ts`

## 🗓️ **2026-05-02**

---

### 💅 Styling and UI Improvements

---

> ### Sidebar & Navigation Overhaul
>
> - **What changed:** Reorganized the sidebar into "Analytics", "AI Strategy", and "The Engine Room". Consolidated "Outcome Logger" into the Leads workspace. Created separate navigation items for "Manual Test Crawl" (`/admin/sessions`), "Connections" (`/admin/connections`), and "Settings & Integrations" (`/admin/settings`). Renamed specific links like "Niches" to "Niche Intelligence".
> - **Why:** Reflects the workflow of an Overseer managing an autonomous system, making navigation more intuitive and logically grouped.
> - **Files:**
>   - `src/app/admin/layout.tsx`
>   - `src/app/admin/SidebarNav.tsx`
>   - `src/app/admin/leads/page.tsx`
>   - `src/app/admin/sessions/page.tsx`
>   - `src/app/admin/sessions/ManualTriggers.tsx`
>   - `src/app/admin/connections/page.tsx`
>   - `src/app/admin/connections/ConnectManager.tsx`
>   - `src/app/admin/settings/SettingsManager.tsx`

---

### ✨ Features

---

> ### Multi-Agent Sandbox Diagnostics Interface
>
> - **What changed:** Upgraded the `/admin/sessions` UI to visualize the LangGraph pipeline as a collaborative workspace of AI personas (The Strategist, Scraper, Auditor, Analyst, and Copywriter). Logs are now structured by `agentRole` and `narrative` rather than generic strings. Prompt engineering was updated to output distinct narrative rationales. The Results Tray now holds Sandbox leads in a `pending_approval` state, allowing the Overseer to manually select and dispatch them via a new `/api/admin/dispatch-manual` endpoint.
> - **Why:** Builds deep trust by exposing the "why" behind the AI's logic through narrative personas, while creating a safe manual review loop for generated pitches before dispatch.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/leads.ts`
>   - `lib/db/crawlSessions.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `lib/pipeline/runPipeline.ts`
>   - `lib/services/geminiPitchGenerator.ts`
>   - `lib/services/whatsappDispatcher.ts`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/cron/dispatch/route.ts`
>   - `src/app/api/admin/dispatch-manual/route.ts`
>   - `src/app/admin/sessions/ManualTriggers.tsx`

---

> ### Unipile WhatsApp Connection Integration
>
> - **What changed:** Implemented Unipile service and integrated it into the frontend to generate hosted auth links. Updated connection management to list connected accounts directly from Unipile, supporting both connection mapping to the local database and clean disconnections from the Unipile server itself. Refactored the UI to robustly handle the E.164 standard phone format and present active connection details clearly.
> - **Why:** Allows users to easily connect their WhatsApp accounts without directly touching WhatsApp APIs, bridging the pipeline securely for message dispatch operations.
> - **Files:**
>   - `lib/services/unipile.ts`
>   - `src/app/api/admin/unipile/connect/route.ts`
>   - `src/app/api/admin/connections/route.ts`
>   - `src/app/admin/connect/page.tsx`
>   - `src/app/admin/connect/ConnectManager.tsx`
>   - `src/app/admin/settings/page.tsx`
>   - `src/app/admin/settings/SettingsManager.tsx`

---

> ### Multi-Tenant Database Architecture
>
> - **What changed:** Converted entire application data layer to be fully Multi-Tenant, injecting `userId` into all database operations, cron jobs, background workers, pipelines, and server-side components. Refactored `SystemSettings` to provide a system-wide default configuration while enabling user-specific configuration overrides via a `resetSettings` function.
> - **Why:** Ensures all scraped data, niches, settings, dispatch logs, and generated pitches are explicitly scoped and securely partitioned for every user on the platform.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/settings.ts`
>   - `lib/db/userProfiles.ts`
>   - `lib/db/niches.ts`
>   - `lib/db/leads.ts`
>   - `lib/db/crawlSessions.ts`
>   - `lib/db/feedbackSignals.ts`
>   - `lib/db/connections.ts`
>   - `src/app/api/cron/crawl/route.ts`
>   - `src/app/api/cron/dispatch/route.ts`
>   - `src/app/api/admin/run-dispatch/route.ts`
>   - `src/app/api/admin/run-crawl/route.ts`
>   - `src/app/api/admin/settings/route.ts`
>   - `lib/pipeline/runPipeline.ts`
>   - `lib/agents/crawlStrategyAgent.ts`
>   - `lib/agents/feedbackLoopAgent.ts`

---

> ### User Profile Upgrades
>
> - **What changed:** Updated `userProfiles` schema to accept an optional `name` parameter, extracting the user's `displayName` from Firebase Auth.
> - **Why:** Personalizes the dashboard and stores user context for eventual UI presentation.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/userProfiles.ts`
>   - `src/app/AuthProvider.tsx`
>   - `src/app/api/auth/profile/route.ts`

---

> ### Auth Login Upgrades & Fixes
>
> - **What changed:** Handled `Rendered more hooks than during the previous render` runtime error on the `/` route caused by a conditional hook. Also added Email/Password Sign Up and Sign In methods (with name capability) while keeping the original Magic Link method accessible via intuitive tab buttons.
> - **Why:** Fixes critical bugs and extends login options so users don't have to rely purely on email token verification.
> - **Files:**
>   - `src/app/page.tsx`
>   - `src/app/login/page.tsx`

---

### ✨ Features

---

> ### The "Listicle & Article Extractor" Node
>
> - **What changed:** Upgraded the pipeline's routing logic to detect "Top 10" blog posts and magazine articles (via `/blog/`, `/article/`, `/guides/`, `/features/`, `/top-` patterns in the URL). When identified, the new `ListicleExtractorNode` uses Firecrawl to download the article's Markdown and Gemini to extract the names and direct outbound website links of every independent brand mentioned. These extracted URLs are then re-injected into the main scraper queue.
> - **Why:** The previous `DirectoryResolver` expected a single "Visit Website" button and failed on long-form articles. This upgrade allows the system to harvest multiple new targets from a single listicle (e.g., extracting 10 brands from one Vogue article), significantly expanding the discovery yield and dynamically feeding the prospector.
> - **Files:**
>   - `lib/services/autoprospector.ts`

---

> ### App: Firebase Authentication
>
> - **What changed:** Implemented Firebase Email Link Authentication, including a `/login` page, a global `AuthProvider` to protect routes, and a `/api/auth/profile` endpoint to create a singleton `userProfiles` document upon initial login. Added a logout button to the Admin Sidebar. Also added a `userId` field to all shared TypeScript domain interfaces to support multi-tenancy.
> - **Why:** Secures the admin dashboard so only authenticated users can access the system, tracks user creation, and sets the foundation for a multi-tenant database schema.
> - **Files:**
>   - `lib/firebase/client.ts`
>   - `src/app/AuthProvider.tsx`
>   - `src/app/login/page.tsx`
>   - `src/components/LogoutButton.tsx`
>   - `src/app/admin/layout.tsx`
>   - `lib/db/userProfiles.ts`
>   - `src/app/api/auth/profile/route.ts`
>   - `lib/types/index.ts`

---

> ### Admin UI: Connect WhatsApp
>
> - **What changed:** Refactored the Connect page to use its own `connections` collection in Firestore. This completely separates the WhatsApp integration logic from `SystemSettings`, capturing `countryCode`, `phoneNumber`, `status`, and tracking connection timestamps.
> - **Why:** Provides a structured `Connection` entity in the DB to easily store additional data like instance IDs, API keys, or webhooks when the full integration is built, rather than just appending strings to system settings.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/connections.ts`
>   - `src/app/api/admin/connections/route.ts`
>   - `src/app/admin/connect/page.tsx`
>   - `src/app/admin/connect/ConnectManager.tsx`

---

> ### Admin UI: Config Settings
>
> - **What changed:** Added `/admin/settings` page to allow managing pipeline execution parameters like `crawlEnabled`, `dispatchEnabled`, `maxConcurrentPipelines`, and `dispatchBatchSize`. Updated the Crawl and Dispatch API endpoints to respect these database-driven limits.
> - **Why:** Allows users to throttle the pipeline (e.g. adjust WhatsApp dispatch batches or concurrency limits) and manually toggle the crawlers on or off without redeploying code.
> - **Files:**
>   - `lib/types/index.ts`
>   - `lib/db/settings.ts`
>   - `src/app/admin/settings/page.tsx`
>   - `src/app/admin/settings/SettingsManager.tsx`
>   - `src/app/api/admin/settings/route.ts`
>   - `src/app/api/cron/crawl/route.ts`
>   - `lib/services/whatsappDispatcher.ts`

---

> ### Admin UI: Niches Manager
>
> - **What changed:** Added `/admin/niches` page and `/api/admin/niches` API route to list, create, and edit niches. Added `/api/admin/feedback/run-loop` to manually trigger the `runFeedbackLoop()` agent, with a trigger button in the UI.
> - **Why:** Allows overriding agent decisions by manually adjusting crawl priorities and seeding new target URLs, and provides a way to trigger the feedback loop on demand.
> - **Files:**
>   - `src/app/admin/niches/page.tsx`
>   - `src/app/admin/niches/NichesManager.tsx`
>   - `src/app/api/admin/niches/route.ts`
>   - `src/app/api/admin/feedback/run-loop/route.ts`

---

> ### Admin UI: Outcome Logger
>
> - **What changed:** Added `/admin/outcomes` page and `/api/admin/feedback` API route. Displays a queue of leads that were pitched but lack an outcome, allowing the user to select Closed, Negotiating, Ghosted, or Rejected with optional notes.
> - **Why:** Closes the loop on the outreach process by collecting real-world conversion data that the Feedback Loop Agent uses to optimize future strategy.
> - **Files:**
>   - `src/app/admin/outcomes/page.tsx`
>   - `src/app/admin/outcomes/OutcomeCard.tsx`
>   - `src/app/api/admin/feedback/route.ts`

---

> ### Admin UI: Leads Page & Lead Detail
>
> - **What changed:** Added `/admin/leads` and `/admin/leads/[id]` pages. The leads list is searchable/filterable by status and shows core brand data. The detail page shows the generated pitch, AI evaluation context, and the full history of dispatch logs for the lead.
> - **Why:** Provides a way to inspect scraped data, pitches, and current status for any specific lead.
> - **Files:**
>   - `src/app/admin/leads/page.tsx`
>   - `src/app/admin/leads/[id]/page.tsx`
>   - `lib/db/leads.ts`

---

> ### Admin UI: Dashboard Page
>
> - **What changed:** Added the main Admin Dashboard page with metrics cards (leads created today, leads dispatched today, qualified today, and leads by status), a niche performance table, and a recent crawl sessions table.
> - **Why:** Provides an at-a-glance view of how the AI pipeline is performing and which niches are generating the best results.
> - **Files:**
>   - `src/app/admin/page.tsx`

---

> ### Cron API — dispatch
>
> - **What changed:** Added a secured GET endpoint that triggers the daily WhatsApp dispatch batch, validated via `CRON_SECRET`, and configured in `vercel.json` to run at 9:00 AM UTC.
> - **Why:** Automates the daily outreach sends without manual intervention.
> - **Files:**
>   - `src/app/api/cron/dispatch/route.ts`
>   - `vercel.json`

---

> ### Cron API — crawl
>
> - **What changed:** Added a secured GET endpoint that runs the full crawl pipeline — strategy agent, prospector, and per-brand qualification — with max 5 concurrent pipelines, updating the CrawlSession on completion. Scheduled at 6:00 AM UTC so fresh leads are ready before dispatch.
> - **Why:** Automates daily lead generation ahead of the dispatch window.
> - **Files:**
>   - `src/app/api/cron/crawl/route.ts`
>   - `vercel.json`

---

> ### LangGraph pipeline orchestrator
>
> - **What changed:** Added a LangGraph state machine that wires scraping, image sanitization, Instagram audit, Gemini evaluation, and lead persistence into a single declarative pipeline with a conditional discard edge.
> - **Why:** Makes the full brand qualification flow explicit, debuggable, and easy to extend with new nodes.
> - **Files:**
>   - `lib/pipeline/runPipeline.ts`

---

> ### Gemini pitch generator
>
> - **What changed:** Added a LangChain service that sends multimodal brand data to Gemini 2.0 Flash and returns a structured pitch with gap score, pitch angle, product name, image URL, and WhatsApp opener — validated via Zod.
> - **Why:** Automates the commercial director evaluation step so every qualified lead gets a personalized, structured pitch.
> - **Files:**
>   - `lib/services/geminiPitchGenerator.ts`

---

> ### WhatsApp dispatch service
>
> - **What changed:** Added a service that sends personalized pitches to up to 20 qualified leads via a webhook, logs each attempt, updates lead status, and throttles sends with a 5–10s random delay.
> - **Why:** Drives the outreach step of the pipeline while mimicking human send cadence to avoid bans.
> - **Files:**
>   - `lib/services/whatsappDispatcher.ts`

---

> ### Firebase Admin singleton
>
> - **What changed:** Added a server-side Firebase Admin SDK singleton with Firestore and Auth exports.
> - **Why:** Provides a single, reusable Admin instance across all server code, preventing duplicate initializations during Next.js hot-reloads.
> - **Files:**
>   - `lib/firebase/admin.ts`

---

> ### Shared TypeScript interfaces
>
> - **What changed:** Defined typed interfaces for all core domain entities — Niche, Lead, PitchEvaluation, CrawlSession, DispatchLog, and FeedbackSignal.
> - **Why:** Single source of truth for data shapes across every service, agent, and API route.
> - **Files:**
>   - `lib/types/index.ts`

---

> ### Firestore DAL — Leads
>
> - **What changed:** Added a data access layer for the leads collection with create (with dedup), query-by-status, and update functions.
> - **Why:** Keeps all Firestore query logic out of business logic and in one maintainable place.
> - **Files:**
>   - `lib/db/leads.ts`

---

> ### Firestore DAL — Niches, CrawlSessions, PitchEvaluations, DispatchLogs, FeedbackSignals
>
> - **What changed:** Added data access layers for all remaining Firestore collections.
> - **Why:** Completes the DAL layer so every pipeline service has a typed, centralised interface to Firestore.
> - **Files:**
>   - `lib/db/niches.ts`
>   - `lib/db/crawlSessions.ts`
>   - `lib/db/pitchEvaluations.ts`
>   - `lib/db/dispatchLogs.ts`
>   - `lib/db/feedbackSignals.ts`

---

> ### Crawl Strategy Agent
>
> - **What changed:** Added a gemini-3.1-flashpowered agent that reads niche performance and feedback data, then returns a prioritised list of niches and crawl targets for the day.
> - **Why:** Directs prospecting effort toward the highest-converting niches rather than crawling blindly.
> - **Files:**
>   - `lib/agents/crawlStrategyAgent.ts`

---

> ### Brand website scraper
>
> - **What changed:** Added a service that scrapes a brand's homepage (and /contact if needed) via Firecrawl and extracts page text, images, WhatsApp number, Instagram URL, brand name, and product price.
> - **Why:** Feeds structured brand data to the AI evaluator without manual effort.
> - **Files:**
>   - `lib/services/websiteScraper.ts`

---

> ### Image sanitization utility
>
> - **What changed:** Added a utility that filters raw Firecrawl image arrays down to likely product photos, removing icons, logos, SVGs, and junk URLs.
> - **Why:** Prevents noise images from polluting the Gemini evaluation prompt.
> - **Files:**
>   - `lib/utils/sanitizeImages.ts`

---

> ### Auto-Prospector service
>
> - **What changed:** Added a service that visits crawl target URLs via Firecrawl, extracts brand website links, deduplicates against existing leads, and updates the active CrawlSession.
> - **Why:** Automates the top-of-funnel brand discovery step of the pipeline.
> - **Files:**
>   - `lib/services/autoprospector.ts`

---

## 🗓️ **2026-03-12**

---

### ✨ Features

---

> ### Setup Next.js App
>
> - **What changed:** Initialized Next.js app with Tailwind, ESLint, Husky, lint-staged, and Jest.
> - **Why:** To setup the frontend application as requested.
> - **Files:**
>   - `package.json`
>   - `eslint.config.mjs`
>   - `jest.config.ts`
>   - `src/app/page.test.tsx`
