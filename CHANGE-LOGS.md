## 🗓️ **2026-07-30**

---

### ✨ Features

---

> ### Outbound agent port — Phase 10d²: the attribution engine and its scan endpoint
>
> - **What changed:** Ported `services/deal_attribution.py` as `outbound/services/dealAttribution.ts`, `views/deal_conversion.py` into `analyticsViews.ts`, and `require_api_key` as `outbound/http/apiAuth.ts`. Thirty-one routes. This is the scan that _writes_ the attribution 10d¹'s funnel reads.
> - **The two write paths are gated differently, and reversing either one breaks it.** Activities and the memory write-back are **change**-gated, tracked in `memory._attributed_deals` as `{dealId: stageId}` — state-gating them would add another "converted to deal" card to the same chat on every hourly run. The funnel-stage sync is **state**-gated and runs on every scan, comparing the chat's _current_ stage/sub_stage against the target the deal implies rather than reacting to a deal-stage change. That is what makes it self-healing: an already-attributed chat whose promotion was missed — deal sitting at an intermediate stage while the chat still says `Contacted` — is corrected on the next scan instead of waiting for the deal to move again. A change-gated sync could never heal; a state-gated card writer would duplicate forever. Both directions are asserted.
> - **An unwritten activity card is not recorded as logged, but the memory facts still land.** The source gates the write-back on `activities > 0` **or** `changed`, so a first attribution writes its deal id and stage even when the card failed, while `_attributed_deals` stays empty so the next scan re-cards it. My first test asserted the opposite and the port was right — the deal facts are worth more than the card, and the card catches up.
> - **A won deal gates on `sub_stage`, not on the stage name.** The Lead-lock means a won prospect stays at stage `Lead` with `sub_stage: crm_won`, so gating on the stage would re-apply the transition forever.
> - **The primary deal is the most-advanced one**, tie-broken by the latest stage entry, and a deal in an unknown stage ranks below every known one so a deal in another pipeline can never outrank ours. Activities are still written for _every_ deal, so the history stays complete even though the summary fields name one.
> - **A never-contacted chat is skipped before any HubSpot call.** No write-back, no card, no sync — a deal on that contact was a rep's own work, and attributing it would be false attribution. The filters run in cost order generally, so a page of chats that mostly do not qualify costs almost nothing.
> - **Each agent's context is resolved once per call, including a FAILED one.** A page of a hundred chats on one agent would otherwise refresh the same OAuth token a hundred times, and a broken agent would be retried per chat.
> - **`next_cursor` comes back only when the page was FULL.** A short page means the collection is exhausted, which is what lets the caller stop rather than probing one more empty page. `limit` is clamped to 500 and floored at 1 — an unbounded limit from a caller is exactly how the five-minute cron cap gets hit.
> - **`dry_run` truthiness is spelled out, not inferred.** The string `"false"` is truthy in JS, so a `?dry_run=false` query would otherwise turn the scan into a no-op that reported success — and nobody would notice attribution had stopped. Only `1`/`true`/`yes` enable it, matching the source; asserted across twelve inputs.
> - **Only the internal-key path of `api_auth` is ported.** The source's second credential is a per-company key resolved through the inbound product's multi-tenant key store; this port has no company registry and no outbound endpoint is company-scoped, so that branch would be an unreachable lookup against a collection that does not exist. It **fails closed, including when the key is unset** — the source is explicit that "open when unconfigured" is how several webhooks in that codebase ended up with their auth commented out. The length check precedes `timingSafeEqual`, which throws on unequal-length buffers, so a short key 401s rather than 500ing.
> - **The test double now models cursor paging for real.** `startAfter` was a documented no-op and `orderBy('__name__')` sorted on a field that is not in the document data — so a resume test would have looped forever or silently passed on a single page. Both are implemented, with the cursor positioned by **value comparison** rather than by locating the document, so a cursor id deleted between pages still positions the next page correctly. Anything other than `__name__` ordering now **throws**, per the double's rule that an unsupported operation must fail loudly rather than look like passing code.
> - **Files:**
>   - `outbound/services/dealAttribution.ts`, `outbound/http/apiAuth.ts`
>   - `outbound/http/analyticsViews.ts` (adds the scan view), `outbound/http/routes.ts` (one route)
>   - `outbound/testSupport/mockFirestore.ts` (real cursor paging + `__name__` ordering)
>   - `outbound/__tests__/services/dealAttribution.test.ts`, `outbound/__tests__/http/apiAuth.test.ts`, `outbound/__tests__/http/analyticsViews.test.ts`, `outbound/__tests__/http/routes.test.ts`
> - **Verification:** 2,110 tests across 51 suites (79 new), `tsc --noEmit` clean, `eslint` clean.
>
> ---
>
> ### Outbound agent port — Phase 10d¹: the deal-analytics read layer and the funnel view
>
> - **What changed:** Ported the analytics half of `services/hubspot.py` as `outbound/services/dealAnalytics.ts` and `views/deal_funnel.py` as `outbound/http/analyticsViews.ts`. Thirty routes. The dashboard funnel works.
> - **The source repo is a moving target, and Phase 10d turned out to be ~1,270 lines rather than ~330.** Surveying before starting found a whole deal-analytics subsystem the plan never enumerated: `services/deal_attribution.py` (311) with `views/deal_conversion.py` (55) and ~340 lines of analytics reads inside `services/hubspot.py`, plus `services/deal_timeline.py` (393), `views/deal_timeline.py` (47), and an `analytics/deal-timeline/` route. **`git log` on the source dates the attribution commit to 2026-07-31 and the timeline commit to 2026-08-03** — both landed upstream _while this port was in flight_. `urls.py` itself grew from 101 to 104 lines between two reads in the same session. **Decision: port what the source contains now**, rather than freezing at the snapshot the plan was written against — freezing would ship a port missing a live dashboard endpoint the FE already calls. 10d splits into three; this is the first.
> - **The funnel's counts come from FIRESTORE, not from a HubSpot deal search.** This is the design decision the whole module turns on and it is counter-intuitive enough to state plainly: a prospect the agent engaged may convert via **another rep**, so a deal is created on the same contact but **without** the agent's `lead_source` tag. A tag-filtered deal search therefore misses it and the funnel reads zero for work the agent actually caused. Only the stage **shape** — labels, order, won/lost typing, `is_entry` — is read live from HubSpot. The consequence worth knowing: the counts are as of the last attribution scan, not as of this instant.
> - **Three exclusions, each of which would otherwise inflate the funnel.** A **never-contacted** chat is never counted — `stage` becomes `Contacted` the moment `make_phone_call` or `send_email` fires, so anything still at `New`/absent is local proof the AI never reached out, and a deal on that contact was created by a rep directly. An **archived** chat is never counted — it is dead, and the FE already drops it from the inbox and the drill-down lists, so counting it here would disagree with the UI. And **duplicate deals** count once: one contact can map to several chats and therefore to the same deal, so the scan dedupes by `deal_id`.
> - **Won/lost is classified by LABEL, in exactly one place.** `stageType` reads `"closed won"`/`"closed lost"` case-insensitively, and the funnel, the timeline, and the attribution stage sync all derive won/lost from it — so getting the classification right fixes three consumers at once, and getting it wrong breaks all three identically. Notably it does **not** read `metadata.isClosed`; asserted.
> - **Every funnel failure is a reported `error`, never an empty chart.** An empty funnel and an unreachable pipeline are indistinguishable to whoever is looking at the dashboard, so auth failure, a missing `pipeline_id`, and an unreadable pipeline each come back as a message.
> - **`source: 'inbound'` returns nothing, and that is correct rather than a gap.** The attributed set is outbound-origin by construction — every row comes from an outbound chat — so an inbound filter over it is empty by definition. Recorded on the function, because it reads like a bug otherwise.
> - **A date-bounded query DROPS rows whose conversion timestamp cannot be parsed.** The strict reading: a date-bounded question cannot honestly include a row whose date is unknown. Without a bound the same row counts.
> - **The date filter is an inclusive DAY range in UTC.** The end bound is that day's `23:59:59.999`, not its midnight — midnight would silently drop everything that happened on the last day of the range the user picked, which surfaces as "the dashboard is missing today's conversions" and reads as a data problem rather than a bounds problem. A malformed date is treated as **unbounded**, because a bad query param should widen a dashboard's view rather than blank it, and the pattern check is strict (`new Date('2026-1-5')` quietly parses, so loose input would make two differently-typed queries return different ranges).
> - **A failing batch-read chunk is skipped, not fatal.** A partial result is useful to every caller, and losing one page of a 400-deal scan is better than losing the scan.
> - **Files:**
>   - `outbound/services/dealAnalytics.ts`, `outbound/http/analyticsViews.ts`
>   - `outbound/http/routes.ts` (one route added)
>   - `outbound/__tests__/services/dealAnalytics.test.ts`, `outbound/__tests__/http/analyticsViews.test.ts`, `outbound/__tests__/http/routes.test.ts`
> - **Verification:** 2,031 tests across 49 suites (72 new), `tsc --noEmit` clean, `eslint` clean.
>
> ---
>
> ### Outbound agent port — Phase 10c²: the voice admin views and the DNC area-code registry
>
> - **What changed:** Ported `views/voice_settings.py`, `views/voice_connect.py`, `views/dnc_area_codes.py`, and `serializers.py` — as `outbound/http/voiceViews.ts`, `dncViews.ts`, and `serializers.ts`. Four routes join the table, now twenty-nine. **Every route in `urls.py` is live except the two `analytics/` endpoints**, which land with the funnel in 10d.
> - **`serializers.py` is not ported as a DRF framework.** The two serializers it defines become two validation functions. What IS reproduced faithfully, because the FE reads it: the error **shape** (`{field: [message]}`, DRF's `serializer.errors`, so the form can attach a message to an input) and the two-pass **order** — field validation first, and the object-level pass only if every field passed. That order matters: a body with both a malformed expiry and no area codes reports the date alone, rather than sending the form chasing two problems when it has one. Building a generic `Serializer`/`Field` layer would have been a large amount of speculative code in service of one endpoint.
> - **The DNC registry REPORTS invalid codes; the campaign audience validator REJECTS them — and both are right.** This is the most interesting thing in the increment. Same input shape, opposite fail direction, because the cost is asymmetric in opposite directions: this endpoint _registers_ which area codes may be scrubbed, so a dropped token **narrows** the registry and is safe. In 10b a dropped token would have **widened** the dialled audience past what was actually scrubbed. Recorded on both modules so a future "consistency" pass cannot quietly align them.
> - **The bulk paste is the real input.** The admin form's area codes arrive as a copy-paste out of a spreadsheet or an email, so any run of non-digits separates them — comma, space, newline, semicolon, pipe. If this regressed to comma-only, half a paste would land as one unparseable token and the registry would silently under-register, which means the scrub would silently stop covering codes someone believes are covered.
> - **There is no status field, on purpose.** Active/inactive is derived from `san_expiry_date` at read time. A stored flag would need someone to remember to flip it the day a subscription lapsed; a derived one cannot drift.
> - **DELETE answers 400 for a code that was not in the registry.** Unusual — a delete of something absent is normally idempotent — and preserved, because the caller asked to withdraw authorization for a code and "there was nothing to withdraw" means their model of the registry is wrong.
> - **The voice views sync BEFORE they write.** If ElevenLabs refuses the prompt, the agent doc is left untouched, so it never claims a prompt the provider is not actually serving. The failure is a **502**, not a 500: the fault was upstream, which is what the FE needs in order to decide whether retrying is worth anything. Asserted by checking the doc is still empty after a refused sync.
> - **The webhook re-attach is best-effort, for the opposite reason.** `createElevenlabsAgent`/`updateElevenlabsAgent` are clones of the inbound provisioner and may set the INBOUND webhook, so both sync paths attach the outbound one afterwards — but failing the whole request over something the next sync will fix would strand the user's edit.
> - **The default snapshot is taken on the FIRST save**, because reset has nothing to restore to otherwise. A **blank** stored default counts as no default — otherwise reset would faithfully restore an empty prompt. And an explicitly empty `voice_prompt` is refused rather than falling back to the stored one: `is None`, not falsiness, or an edit that cleared the prompt would report success while being silently undone.
> - **Reset writes only the two fields it changes**, leaving `voice_settings` alone so a concurrent settings save cannot lose.
> - **`voice-agent/connect/` works with no `agent_id` at all**, because attaching the webhook is useful on its own and the FE sometimes connects a voice agent before it has an outbound agent to bind it to. `post_call_webhook_synced` is **`null`** for a non-ElevenLabs provider — nothing was attempted, which is a different fact from an attach that was tried and failed.
> - **Files:**
>   - `outbound/http/serializers.ts`, `outbound/http/dncViews.ts`, `outbound/http/voiceViews.ts`
>   - `outbound/http/routes.ts` (four routes added)
>   - `outbound/__tests__/http/{serializers,dncViews,voiceViews}.test.ts`, `outbound/__tests__/http/routes.test.ts`
> - **Verification:** 1,959 tests across 47 suites (78 new), `tsc --noEmit` clean, `eslint` clean.
>
> ---
>
> ### Outbound agent port — Phase 10c¹: the HubSpot admin and audience-preview views
>
> - **What changed:** Ported `views/hubspot_discovery.py` — all seven views (discovery, property-option, delete-records, lists, list-members, contact-properties, search-contacts) — as `outbound/http/hubspotViews.ts`, and added `deleteHubspotRecords` to `services/hubspot.ts`. The route table is now twenty-five. The FE can complete HubSpot setup, build a filter UI, preview an audience, and tear down its own E2E records.
> - **The two token resolvers prefer OPPOSITE sources, and both preferences are correct.** `resolveToken` prefers a directly-supplied `access_token` — step 1 of setup has no saved action at all, and the FE holds a Private-App token the user just pasted. `resolveConfig` prefers `agent_id` — the list and search helpers refresh the token internally, and a bare `access_token` cannot be refreshed. Reading this as an inconsistency and normalizing it breaks one caller or the other, so both are asserted with the reason on the module.
> - **The audience preview excludes on two different keys, because one cannot see what the other catches.** Contact ids hide contacts already enrolled in the campaign. But a shared dealership line means a **distinct** contact carries the **same** phone — an id-based exclusion misses it, and enrollment would silently collapse it onto the existing chat, so the preview count would not match what firing actually creates. The id exclusions go _into_ the search query so `total` reflects them; the channel-key pass runs _after_, because the HubSpot API has no way to express "a different contact sharing this phone".
> - **`delete-records` is gated twice, and both gates are hard.** The caller must declare `record_type: "Test"`, and when a `chat_id` is given the chat's own `memory.record_type` must also be Test. A missing or unreadable chat reads as **not** Test and is refused — the only safe direction for a delete. No payload can reach a real prospect's CRM records through this route.
> - **The memory cleanup is conditional on the delete having succeeded**, which is why `deleteHubspotRecords` reports tri-state per object: `null` (never asked) must not collapse into `false` (asked and failed). Clearing an id after a failed delete would leave a live CRM record with nothing in Firestore pointing at it — invisible until someone went looking for the duplicate.
> - **`bool(data.get("exclude_contacted", True))` again**, this time on contact search — the second place in the port where `??` would have read an explicit `null` as "unset" and quietly turned cross-campaign dedup back on. Handled identically to the campaign create view, and asserted across all five input shapes.
> - **`all_properties` is best-effort and falls through**, because rendering fewer columns beats failing the whole preview; and the channel-key lookup fails **open** to an empty set, because a preview that errors leaves the picker blank, which is worse than a count that is slightly high.
> - **Survey finding: `delete_hubspot_records` was never ported.** Phase 9a's entry says "deletion", and it did deliver `deleteObject` — the generic primitive — but not the 13-line orchestrator that resolves the agent's token and calls it twice. Nothing referenced it until this view existed, so the gap was invisible. Landed here in the source's own module with its own tests.
> - **A fixture was wrong again, and this is the ninth increment where that happened.** `provider` and `auth` live on the **agent's own** action document; the shared `actions/{id}` doc contributes only `type`, `action_prompt`, and `functions`. Seeding auth on the shared doc makes `resolveHubspotConfig` see an unconnected agent. `updateAgentActionAuth` writing the refreshed token to the per-agent doc is the definitive answer, and the corrected helper now says so.
> - **Files:**
>   - `outbound/http/hubspotViews.ts`
>   - `outbound/services/hubspot.ts` (adds `deleteHubspotRecords`)
>   - `outbound/http/routes.ts` (seven routes added)
>   - `outbound/__tests__/http/hubspotViews.test.ts`, `outbound/__tests__/services/hubspot.test.ts`, `outbound/__tests__/http/routes.test.ts`
> - **Verification:** 1,881 tests across 44 suites (54 new), `tsc --noEmit` clean, `eslint` clean.
>
> ---
>
> ### Outbound agent port — Phase 10b: campaigns and chat pause/resume
>
> - **What changed:** Ported `views/campaigns.py` — the twelve campaign and chat-lifecycle views plus the audience validator — as `outbound/http/campaignViews.ts`, and wired ten routes into the table (now eighteen). The FE can now fire a campaign, poll it, pause/resume/stop it, add records to a live one, and pause or resume chats individually or in bulk.
> - **`validateAudience` is the substance of the phase**, because it is the only gate between an FE payload and a campaign that will enroll thousands of contacts. Everything else here is a status projection or a lifecycle flip.
> - **Emptiness, not presence, decides each per-type check.** The source reads `audience.get("contacts") or []`, so a `contacts: []` csv campaign is **rejected** rather than created to do nothing — and the same for an empty `include_contact_ids`. Asserted in both directions.
> - **Any invalid area code rejects the whole request.** Not "drop the bad ones": an area-code selection is a DNC-scrubbability claim, so enrolling only the codes that happened to parse would dial the remainder **unscrubbed** — the precise thing the selection exists to prevent. Valid codes are normalized and deduped in place, and the view copies the audience first so the rewrite cannot reach back into the parsed request body.
> - **`include_contact_ids` is authoritative and self-sufficient**, satisfying the per-type picker requirement for all three sources. That is what lets the FE preview a list, let the user deselect rows, and fire the campaign with the survivors — without re-sending a `list_id` that no longer describes the audience.
> - **`bool(data.get(k, default))` is translated in the view, not left to the service.** The default fires only on an ABSENT key and a present value is then coerced, so `exclude_contacted: null` from the FE means **off**. `??` would have read it as "unset" and quietly turned cross-campaign dedup back on. This is the same absent-vs-null distinction the port has tracked since Phase 2, arriving through an HTTP body instead of a Firestore read.
> - **`remaining` is `null`, not `0`, while `total` is uncounted.** The enrollment worker counts the audience asynchronously and leaves `total: null` until it has; reporting `0 remaining` would render a campaign that has barely started as finished. It also floors at 0 when enrollment overshot the count.
> - **Status codes are preserved exactly, and they are what these tests protect.** Create answers **201** — the FE distinguishes "the campaign now exists and the worker will enroll it" from a 200 that could be a status read. Every lifecycle path returns parseable JSON: 400 for a bad action or missing id, 404 for a missing campaign, 500 with an `error` key for a backend fault. The source's own docstring calls this out — an unhandled HTML 500 is a failure the FE cannot show the user.
> - **`add-records` answers 400 even for "campaign not found".** The service funnels every refusal — not found, paused, stopped — through one status, and reclassifying by error message would be guesswork. Preserved as-is.
> - **`paused: false` is a normal 200.** The service refuses an already-paused or **archived** chat, and archive is terminal — pausing it would imply it could be resumed. That refusal is an answer, not an error. Bulk pause/resume 400 an empty or non-array `chat_ids`, so an empty selection cannot read as a success, and `by` defaults to `'manual'` for single and `'bulk'` for bulk — which is how the audit trail tells them apart.
> - **The table gained two structural tests**: no duplicate `name` and no duplicate `(path, method)` pair — a duplicate under first-match resolution is a route that can never be reached, silently — and the declaration order is asserted, with the campaign detail route declared LAST after every sub-action exactly as `urls.py` declares it.
> - **Files:**
>   - `outbound/http/campaignViews.ts`
>   - `outbound/http/routes.ts` (ten routes added)
>   - `outbound/__tests__/http/campaignViews.test.ts`, `outbound/__tests__/http/routes.test.ts`
> - **Verification:** 1,827 tests across 43 suites (59 new), `tsc --noEmit` clean, `eslint` clean. The routes suite needed updating for the expanded table, which is what that suite is for; its parameter-capture test now exercises real parameterised routes instead of a stand-in.
>
> ---
>
> ### Outbound agent port — Phase 10a: the route table, the request adapter, and the landed views
>
> - **What changed:** Ported `urls.py`, `views/__init__.py`, `views/task_cron_job.py`, `views/initiate_outbound_webhook.py`, and the view classes of the four webhook modules plus `OutboundCallLLMView` — as `outbound/http/{types,request,routes,webhookViews}.ts`, with a single Next.js catch-all adapter at `src/app/api/outbound/[...path]/route.ts`. The outbound app now has an HTTP surface. Phase 10 is split into five increments; this is the first.
> - **`urls.py` becomes an ordered TABLE, not thirty route directories.** Django resolves `urlpatterns` first-match, and keeping it a list keeps that ordering explicit and testable; file-based routing would bury the same information in the framework's own precedence rules. Every path is preserved **verbatim** under the `/api/outbound/` mount, trailing slashes included — including the two ElevenLabs paths that have no trailing slash in the source. These are published contracts: the provider webhook URLs are typed into the ElevenLabs and SendGrid consoles by hand, and **the unsubscribe links inside already-delivered mail point at `/unsub/` forever**. The source's `name=` values are kept for the same reason. The paths and names are asserted, not trusted.
> - **The open question from Phase 7b²c is settled: `CONVERSATION_INIT_PATH` now points at the outbound route.** The source provisions agents against `/inbound_agent/voice-agent/elevenlabs/conversation-init` while the outbound app mounts its own handler. In a deployment running both apps that is a judgement call about someone else's live agents. Here it is not — **this port has no inbound app**, so the source's value resolves to a 404 and a provisioned agent would fetch no pre-call context at all, which is worse than fetching the wrong context. There is exactly one conversation-init handler in this codebase and the caller's own log line says it is attaching _the_ one.
> - **Four endpoints answer 200 on failure, each because its caller retries non-2xx.** The cron has already fired real touches by the time it faults, so a replay would repeat them. The two ElevenLabs webhooks describe a call that already happened, and no retry can make an unmatched `conversation_id` match. The email webhook returns 200 for "matched nothing" because an address that matched nothing will not match on the retry either. The two that _do_ fail loudly are the two where a retry is the right answer: the SendGrid event webhook (401) and lead intake (400).
> - **The conversation-init view cannot error, even if the handler throws.** A pre-call hook that returns an error leaves the provider without the payload it is waiting on and the call does not connect, so the fallback is the same `{dynamic_variables: {}}` the handler's own failure paths return. Answering the phone without context beats not answering it.
> - **`window` is parsed with Python's `int()` semantics, not `parseInt`.** `int("2.5")` and `int("2abc")` both raise and reach the source's fallback; `parseInt` returns `2` for each — the right answer for the wrong reason — and `NaN` for `"abc"`, which would then flow into the query as a NaN window. Tested across all four malformed shapes.
> - **`leads: []` is a 400, not a fallback to the single-lead form.** The source tests `leads is None`, not falsiness. An explicit empty array is a caller saying "enroll these zero contacts", and answering `success` to that would hide an empty import. One lead throwing does not fail the batch — its error lands in `results[i]` and the rest still enroll.
> - **`call-llm-outbound` derives the NAMESPACED outbound chat id from `phone_number`.** This is the one piece of view logic Phase 8b⁴ could not absorb, and the source flags it in its own comment: the FE posts the same payload it posts to the inbound endpoint, so the view builds `outbound__{agent}__{number}` — the id `initiate-outbound` created — rather than minting a fresh inbound-shaped `{agent}__{number}` chat for a prospect who already has one. An explicit `chat_id` wins, which is how the cron and the email webhook invoke it.
> - **`rawBody` travels with the request, always.** Three endpoints HMAC the exact bytes received (ElevenLabs over `"{t}.{body}"`, SendGrid over `timestamp + body`), and a re-serialized body changes whitespace and key order and breaks every one of them — surfacing as "the provider's signature is wrong". Multipart parsing is not optional either: SendGrid Inbound Parse posts the email webhook as `multipart/form-data`, so without it that route would answer "could not parse sender" to every reply.
> - **A body with an unsupported `Content-Type` parses as JSON or yields `{}`**, where DRF would raise 415. Providers misdeclare content types routinely, and a 415 returned to a webhook is retried — retrying a body that will never parse is a loop, not a recovery. Repeated query keys resolve LAST-wins, because that is what Django's `QueryDict.get` returns and `URLSearchParams.get` would hand back the first.
> - **The table lists only routes whose views exist.** An absent path 404s, which is honest; a stubbed one would answer 200 with a lie. A known path under the wrong method gets a real 405 rather than a 404, because "you used GET on a POST endpoint" is the harder of the two to diagnose from outside.
> - **The survey found two files the plan never named:** `views/deal_conversion.py` and `management/commands/run_deal_attribution.py`. The plan's scope line reads "7 backfills + `reconcile_stale_calls`" — an accurate count of the `backfill_*` files that silently omits the ninth. A scope line written as a count is one that cannot be checked against `ls`. Both land in 10d with the funnel, the only thing that reads what they write.
> - **Files:**
>   - `outbound/http/types.ts`, `outbound/http/request.ts`, `outbound/http/routes.ts`, `outbound/http/webhookViews.ts`
>   - `src/app/api/outbound/[...path]/route.ts` (the only Next.js-aware file in the phase)
>   - `outbound/services/elevenlabsAgentService.ts` (`CONVERSATION_INIT_PATH` settled)
>   - `outbound/__tests__/http/{request,routes,webhookViews}.test.ts`
> - **Verification:** 1,768 tests across 42 suites (54 new), `tsc --noEmit` clean, `eslint` clean over both `outbound/` and the new route directory. No existing test needed changing.
>
> ---
>
> ### Outbound agent port — Phase 9e: discovery, the meeting tools, and `ensureMeetingHost`
>
> - **What changed:** Ported HubSpot owners, meeting links, property options, deal pipelines, and config discovery as `outbound/services/hubspotDiscovery.ts`; the two meeting tools as `outbound/tools/hubspotMeetingTools.ts`; and `ensureMeetingHost` into `services/chat.ts`. **Phase 9 is complete**, and the deferral ledger now has no real work left — only the two permanently-unreachable entries.
> - **`ensureMeetingHost` closes the oldest seam in the port**, deferred out of Phase 3 and open for eleven increments. It resolves the HubSpot contact owner's name so the agent can tell a prospect _who_ they will be meeting, and it is wired at all four call sites (the outbound dial, the inbound conversation-init, and the turn entry). Idempotent — a cached name short-circuits before any CRM call — and a Test record resolves `owner_id_test`, so the host named is the owner of the calendar actually being booked.
> - **A meeting link's organizer is a USER id, not an owner id**, and conflating them would silently break the binding Phase 9a depends on. A link names its organizer by `organizerUserId`; contacts and deals are stamped with `hubspot_owner_id`. The mapping goes through `user_id`, and an unmatched organizer leaves the owner fields _undefined_ rather than wrong.
> - **`schedule_hubspot_meeting` prefers the RESOLVED slot over whatever the model supplies.** `memory._agreed_slot` — the exact millis the review's matcher extracted from the transcript — beats the `start_time_ms` in the tool input, because turning "Friday at 10:45" into an epoch is precisely the arithmetic a model gets wrong, and **a booking at the wrong time is worse than no booking**. The model's value is the fallback.
> - **Reminders are scheduled deterministically, not by the model.** The source records the model silently skipping them and producing booked demos with _zero_ reminders. On success the tool also captures the address the customer booked with (when the chat had none) and clears `_agreed_slot`, so a later turn cannot re-book the same time. A reminder failure does not fail the booking — the meeting exists.
> - **`addPropertyOption` is allowlisted and idempotent**, because it edits someone else's CRM schema. Only `hs_lead_status` and `lead_source` may be touched, and an option matching on value **or** label returns `added: false` — HubSpot accepts duplicate labels which then render as an unremovable duplicate in its own UI.
> - **Both paginators carry a hard page cap** (10 for links, 20 for owners): a malformed `paging.next` that never clears would otherwise loop forever against a live API, and a truncated result plus a log line is the better failure.
> - **Config comes from the agent's ACTIONS, not the skill's tool scoping.** Both tools resolve the HubSpot v2 action directly, so the action needs no `functions` list — connecting HubSpot is enough, and a skill author cannot accidentally scope the CRM out of existence.
> - **Deferred deliberately:** the deal-funnel analytics (`deal_funnel_counts` and its attribution scan) move to Phase 10 alongside `views/deal_funnel.py`, the endpoint that is their only consumer — consistent with how every other view has been handled.
> - **Files:**
>   - `outbound/services/hubspotDiscovery.ts`, `outbound/tools/hubspotMeetingTools.ts`
>   - `outbound/services/chat.ts` (adds `ensureMeetingHost`)
>   - `outbound/llm/run.ts` (both tools registered in the dispatch table, now twelve), `outbound/llm/turn.ts`, `outbound/tools/makePhoneCall.ts`, `outbound/services/voiceWebhooks.ts` (host resolution wired)
>   - `outbound/__tests__/services/hubspotDiscovery.test.ts`
> - **Verification:** 1,714 tests across 39 suites (36 new), `tsc --noEmit` clean, `eslint outbound/` clean. One existing test needed updating — the dispatch-table assertion, which is exactly what that test is for.
>
> ---
>
> ### Outbound agent port — Phase 9d: audiences, lists, and search
>
> - **What changed:** Ported the audience-selection layer as `outbound/services/hubspotAudiences.ts` (~580 source lines) — contact lists, contact search with filter groups, the enrollment stamps, area-code annotation, and the HubSpot-contact → lead-payload mapping. This is what turns a HubSpot portal into a campaign audience, and it closes `resolveAudiencePage`'s HubSpot sources plus enroll's three contact stamps.
> - **An exclusion has to be added to EVERY filter group, and getting this wrong changes who gets dialled.** HubSpot evaluates `filterGroups` as a disjunction, so adding the contacted-exclusion (or the area-code constraint) to only the first group leaves every other branch completely unfiltered. Both helpers distribute across the whole DNF, and a filter with no groups to attach to becomes a lone group rather than being silently dropped. Tested by asserting the exclusion appears in _each_ group.
> - **An explicitly-empty area-code selection must match NOTHING.** If the caller selected area codes and none survive validation, the filter becomes `IN [""]` — a sentinel matching no contact. Returning everything instead would dial an **unscrubbed audience**, the exact opposite of what an area-code selection is for. Tested directly.
> - **Email-only members are always kept.** They have no area code to judge, so filtering them out would silence a reachable channel over a phone-shaped rule. True on both the server-side search path and the client-side list path.
> - **The channel-key exclusion exists for a case the id-based one cannot see.** A shared dealership line means the _same_ phone appears under a _different_ contact id, so an id-based exclude misses it and the campaign collapses two members onto one chat. Excluding on `p:<last-10>` / `e:<email>` catches it.
> - **Operator normalization drops rather than sends a broken row.** A value-requiring operator with no value is discarded, because sending it 400s the whole query and loses the entire audience instead of one row. Cardinality is also normalized in both directions: several values with `EQ` become `IN`, one value with `IN` collapses to `EQ`. Unknown operators pass through upper-cased, so the friendly-label map is a convenience layer and not a whitelist.
> - **Cross-campaign dedup is permanent by design.** `ava_last_contacted` is stamped at enrollment and never cleared — the whole point is that a contact this system has already worked is not silently re-enrolled by the next campaign. Each search ensures the property exists first, because HubSpot 400s a filter naming an unknown one.
> - **`stampContactCampaign` writes ONLY the fields it was given.** Setting the campaign END later must not wipe the id or the start, so it patches a partial map rather than a whole object. Asserted.
> - **Two smaller decisions preserved:** an unrecognised CNAM value normalizes to `unknown` rather than being rejected, because a vendor's surprise value should read as "we do not know" instead of corrupting a property the filters match on; and `total` is HubSpot's raw pre-area-filter count, not the returned page length — worth knowing when reading the number.
> - **Files:**
>   - `outbound/services/hubspotAudiences.ts`
>   - `outbound/__tests__/services/hubspotAudiences.test.ts`
> - **Verification:** 1,678 tests across 38 suites (62 new), `tsc --noEmit` clean, `eslint outbound/` clean.
>
> ---
>
> ### Outbound agent port — Phase 9c: meetings, slots, and booking
>
> - **What changed:** Ported the meeting layer as `outbound/services/hubspotMeetings.ts` — availability fetch and formatting, booking, the `.ics` invite, `finalizeMeetingBooking`, the review's slot matcher, and a shared availability block. **Three seams close and are wired:** the review's `resolveBookingSlot` now defaults to the real matcher, and both voice availability injections (outbound dial and inbound conversation-init) are live.
> - **Three filters decide what may be offered, and each fixes a bug the source names.** They get individual tests because each would silently regress:
>   1. **15-minute durations only** — the outbound demo is a 15-minute meeting, so the link's 30- and 60-minute availability is ignored entirely. Both what is shown and what is booked stay 15.
>   2. **A 30-minute lead buffer** — without it the agent offered slots starting _now_ (the source records a "Thu 3:15/3:30" bug). There has to be time to actually place the call.
>   3. **Never TODAY** — `d <= today` excludes the current day completely, because same-day calls put the customer on the spot and read as sloppy. The source records a "Monday July 6 = today" bug here.
> - **Booking THROWS; everything after it does not.** `bookMeeting` raises on a non-2xx, because a failed booking must never read as success — the caller has to tell the customer. But every step of `finalizeMeetingBooking` is individually wrapped, because by then **the meeting exists in HubSpot**: a local write failure must neither undo nor hide it. Tested by failing the Lead sync and asserting the meeting record and link survive.
> - **`finalizeMeetingBooking` deliberately sends NO confirmation email**, and that is the fix for a real duplicate. The skill sends exactly one, as its last step, once `hubspot_meeting_link` is in memory. Sending here too would produce either a duplicate or — worse — a linkless email arriving _before_ the link is known. The link is guaranteed non-empty (falling back to the scheduling page) precisely because that email waits on it.
> - **The join link is checked under four different names.** HubSpot names it `webConferenceUrl`, `conferenceUrl`, `joinUrl`, or `location` depending on the meeting type; missing one blanks the confirmation link whenever a conference URL exists under a different key. All four asserted.
> - **The slot matcher is a pure MATCHER and must never re-judge the outcome.** `classifyCallOutcome` already decided the call was a demo. This only answers "which offered slot did they agree to", and matching is deliberately lenient — closest slot on the agreed day — because the agent read times aloud and the prospect answered in prose. Demanding exactness would fail most real bookings. `resolved: false` still books: a demo is never downgraded to a callback.
> - **`formatSlotsForVoice` lists every time, not a selection**, because the voice agent has no tool to fetch slots mid-call. Capping there would silently narrow the prospect's options; the prompt decides which few to suggest.
> - **A second month is fetched only when the window actually crosses one.** The endpoint is per-month, so checking first keeps the common case at a single request.
> - **Files:**
>   - `outbound/services/hubspotMeetings.ts`
>   - `outbound/tools/reviewCallTranscript.ts` (resolver now defaults to the real matcher, still injectable), `outbound/tools/makePhoneCall.ts` and `outbound/services/voiceWebhooks.ts` (availability injected; the dial skips it for an already-booked reminder call, which must never offer new times)
>   - `outbound/__tests__/services/hubspotMeetings.test.ts`
> - **Verification:** 1,616 tests across 37 suites (37 new), `tsc --noEmit` clean, `eslint outbound/` clean. Wiring three more live CRM seams again broke nothing, for the same reason as 9b.
>
> ---
>
> ### Outbound agent port — Phase 9b: stage sync, deals, and the deal brief
>
> - **What changed:** Ported `sync_hubspot_stage` (216 lines on its own), the deal create/stage-update path, the company association, and the rep-facing deal brief as `outbound/services/hubspotDeals.ts` — **and wired the closed seams into all six call sites**: the review orchestrator (deal note, Engaged sync, secondary email), the email webhook, the conversation-init webhook, and `mark_prospect_lost`. Three ledger rows close: `syncHubspotStage`, `maybeAddDealConversationNote`, and 9a's `preservePriorEmailOnContact` is now actually called.
> - **A third instance of plan revision 7's pattern, saving ~156 lines.** `sync_hubspot_inbound_lead` bails on `type == "outbound"` and its production caller is the INBOUND web turn. Not ported. That is now three separate modules inside `outbound_agent/` that refuse outbound chats outright — the directory an outbound file lives in genuinely does not make it outbound code.
> - **The forward-only guard has two halves that catch different failures.** `_hubspot_synced_stage == stage` is the IDEMPOTENCE half, and it is what lets every caller fire the sync unconditionally after a stage write. The rank comparison is the NEVER-DOWNGRADE half: a backward or equal move is refused, so a stray path cannot overwrite `hs_lead_status` with a lower value or log a backward "stage updated to" Note. Firestore is already forward-only; this stops a regression _there_ from reaching the CRM. **`Lost` is deliberately absent from the rank** so it always syncs — it is terminal, and blocking it would leave a closed prospect looking open in the CRM. All three behaviours tested separately.
> - **MINIMAL WRITES, and this is a deliberate restraint rather than an omission.** Core contact fields — name, company, phone, source, record type, state, timezone — are written **once**, at creation. An existing contact is _not_ re-enriched on every transition, and the outbound path creates no separate Company object. Only the Ava-owned stage key is touched per transition, so a human's edits in HubSpot are not overwritten by a bot on every stage change.
> - **Create and LINK are logged as different activities.** A genuine create logs `hubspot_contact_created`; matching an existing HubSpot record logs `hubspot_contact_updated`. Without the distinction, a campaign run against records that already existed would report having _created_ a database it actually just matched.
> - **Two small things with real money attached.** A `Test` record gets `hs_marketable_status: "false"` on creation, because E2E runs create genuine HubSpot contacts and marketing contacts are billed. And campaign attribution is stamped on the **deal**, not just the contact — HubSpot cannot filter a deal by its contact's property, so the funnel would otherwise need an N+1 walk instead of one native search.
> - **The deal brief prefers an LLM but is guaranteed non-empty.** The model call is evidence-only and omits any field it cannot support, and it is retried once because the note is written exactly once per deal — a transient failure would otherwise cost the rep their only prep note. When it still fails, the deterministic fallback builds from what outbound actually has: name, company, meeting time, source, cached summary, or a transcript excerpt. That fallback exists because the source records outbound Notes arriving thin or empty; outbound populates _none_ of the inbound qualification keys the original brief was written against.
> - **The summary gap is filled but never overwritten.** A missing `_conversation_summary` is generated before building the brief; a cached one is left alone, because reviews refresh it across the deal's life and regenerating would discard newer context.
> - **Files:**
>   - `outbound/services/hubspotDeals.ts`
>   - `outbound/tools/reviewCallTranscript.ts`, `outbound/tools/stageTools.ts`, `outbound/services/emailWebhook.ts`, `outbound/services/voiceWebhooks.ts` (seams wired)
>   - `outbound/__tests__/services/hubspotDeals.test.ts`
> - **Verification:** 1,579 tests across 36 suites (42 new), `tsc --noEmit` clean, `eslint outbound/` clean. **Wiring six live CRM call sites broke nothing** — because an unconfigured agent makes every one a no-op, which is exactly the "connecting the action IS the on-switch" design working as intended.
> - **A test helper of mine was quietly wrong in a way worth naming.** `bodyOf('/objects/contacts')` matched the **search** request, whose body's `properties` is a string array — so five assertions were reading `["email"]` and comparing it against an object. The helper now filters to POST and excludes `search`. A substring match against URLs that nest is a trap: `/objects/contacts/search` contains `/objects/contacts`.
>
> ---
>
> ### Outbound agent port — Phase 9a: the HubSpot client core
>
> - **What changed:** Ported the first layer of `services/hubspot.py` (2,235 lines, ~90 functions) as `outbound/services/hubspot.ts` — config resolution, authentication, contact matching and writes, notes, and object deletion. Phase 9 is split five ways along its natural layers: **9a** client core + contacts, **9b** stage sync + deals, **9c** meetings and slots, **9d** audiences and search, **9e** analytics, discovery, and the tools/views. Closes the `preservePriorEmailOnContact` seam that Phase 7b²b² left open.
> - **Everything in this layer is best-effort by design, and that is not laziness.** Every function returns a falsy result rather than throwing, because each is called from inside a `try` block whose entire purpose is _"the outcome already happened — record it if you can"_. The outbound flow's own state lives in Firestore; a HubSpot outage must never stop outreach. Asserted throughout, including that a note failure never throws into a sync.
> - **Only the v2 action counts, and it is keyed on `provider` for a specific reason.** `resolveHubspotConfig` matches `provider == "hubspot_v2"` and ignores the legacy `provider == "hubspot"` action entirely — the one behind `create_hubspot_lead` / `update_hubspot_lead`. It reads `provider` rather than `type` because `getAgentActions` blanks `type` and `functions` for actions with no `action_id`, so `provider` is the robust identifier and `type` is only a secondary check. Both paths tested, along with the legacy action being ignored.
> - **Two authentication modes with different operational shapes.** A `refresh_token` means OAuth: refresh on every call, and persist the result — including the **rotated** refresh token, defaulting to the one we sent, since HubSpot may issue a new one and invalidate the old. An `access_token` alone is a Private App token: non-expiring, no OAuth flow, no client credentials, used directly with no round-trip. Neither means "not connected", which is exactly what makes the whole CRM layer a silent no-op for an unconfigured agent.
> - **Test records get their own owner AND meeting link, and the two must stay in step.** Both resolvers branch on `record_type == "Test"` so that the CRM record owner is the owner of the calendar being booked — otherwise an E2E contact is assigned to one rep while the meeting lands on another's calendar. Tested as a pair, including the fallback when no test values are configured.
> - **Contact matching is ordered by trustworthiness, and one guard prevents merging strangers.** Email (exact) → phone → first AND last name. The phone search checks both `phone` and `mobilephone` via two filter _groups_ (HubSpot ORs groups, ANDs filters within one) on the last-10 NANP digits, because a real CRM stores the same number in half a dozen formats — and anything that does not normalize to 10 digits is not searched at all. The name match requires **both** parts: matching on a first name alone would merge different people.
> - **An email change ADDS; it never replaces.** `addContactSecondaryEmail` appends to `hs_additional_emails` while preserving the primary and every existing secondary, mirroring the chat's append-only `_email_history`. The old address is how prior threads, bounces, and suppression entries stay attributable. An address already on the contact returns `true` — the goal is met, and reporting failure would make an idempotent call look broken.
> - **Two small recoveries worth keeping:** a **409** on contact creation is recovered by looking the id up by email rather than failed, so a race between two turns cannot lose the contact; and a **404** on delete counts as success, because already-gone meets the goal. Empty property values are dropped everywhere, since HubSpot reads an empty string as "clear this property".
> - **Notes exist for something a PATCH cannot do:** a plain property PATCH does not update HubSpot's _last activity_ date, but a Note engagement does — so every push writes one, which keeps the CRM timeline honest and leaves an audit trail.
> - **Files:**
>   - `outbound/services/hubspot.ts`
>   - `outbound/firebase/agent.ts` (adds `updateAgentActionAuth`, so rotated OAuth credentials survive)
>   - `outbound/__tests__/services/hubspot.test.ts`
> - **Verification:** 1,537 tests across 35 suites (55 new), `tsc --noEmit` clean, `eslint outbound/` clean.
>
> ---
>
> ### Outbound agent port — Phase 6b²b: the inbound email-reply webhook
>
> - **What changed:** Ported `views/email_webhook.py` as `outbound/services/emailWebhook.ts` — how a prospect's email reply actually reaches the agent. Handler only; the HTTP route is Phase 10. **Phase 6b² is complete**, and with it the email side of the port.
> - **The module is an ordered chain of seven exits, and the ORDER is the design.** Each must be checked before the next, because the later step would do the wrong thing for a message the earlier one owns. Two placements are worth calling out specifically:
>   - **Opt-out precedes any reply**, so an unsubscribe never receives an LLM answer. Obvious in hindsight, easy to break by moving the check.
>   - **The decline precedes the normal reply**, because a calendar decline's body is usually **empty**. Replying to blank text produces nothing useful, so that branch drives the turn with an `@AI` instruction naming the declined slot instead of the (blank) reply body.
> - **A paused chat is a TOTAL freeze**, including the thing that looks like an oversight: no nudge cancellation. Every other path cancels pending email follow-ups when the customer engages, but a paused chat stays exactly as it was until someone resumes it explicitly. Asserted directly, because "helpfully" cancelling there would silently change what resuming does.
> - **"No matching chat" is a 200, not a 404.** SendGrid retries non-2xx deliveries, and an address that matched nothing will never match on a retry — so an error status would just generate load. Only an unparseable sender is a 400.
> - **Sender resolution exists because forwarded mail hides the prospect.** On forwarded or redirected mail the top-level `from` is rewritten to the mailbox address, so the real sender appears only in `Reply-To`, the SMTP envelope, or the raw headers. All are collected into an ordered, de-duplicated candidate list, and matching by `memory.customer_email` drops the non-prospect addresses naturally.
> - **The unsub mailbox is a content-independent opt-out trigger.** A List-Unsubscribe one-click `mailto:` frequently carries no opt-out words at all, so body matching alone would miss it entirely. Delivery to the mailbox is its own signal, with a local-part convention (`unsub@` / `unsubscribe@`) as the fallback for an agent with none configured.
> - **Only the webhook writes the threading anchor.** `_last_inbound_email_message_id` and `_last_inbound_email_at` are set here and nowhere else — if the send path wrote them, a follow-up with no customer reply would thread as a reply and claim the reply gate's exemptions. The FIRST `Message-ID` in a preserved chain wins, since a forwarder prepends its own; tested with both present.
> - **Header parsing had to be written, not imported.** Node has no `email.parser`, so `parseRawHeaders` returns a multimap — the headers that matter here (`Message-ID`, `Delivered-To`) legitimately repeat, and RFC 822 continuation lines are folded back onto their header.
> - **Files:**
>   - `outbound/services/emailWebhook.ts`
>   - `outbound/__tests__/services/emailWebhook.test.ts`
> - **Verification:** 1,482 tests across 34 suites (37 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **One test taught me something about the code.** I wrote EXIT 3 (the "not an outbound chat" guard) expecting to reach it with a `type: 'web'` chat — but the matcher is already outbound-strict, so such a chat never resolves and the request falls to EXIT 2 instead. The guard is genuinely unreachable through this path, which is exactly what defence in depth means; the test now asserts what actually happens and records why.
>
> ---
>
> ### Outbound agent port — Phase 6b²a: email compliance
>
> - **What changed:** Ported `views/email_compliance.py` as `outbound/services/emailCompliance.ts` — the SendGrid event webhook (bounce, spam report, unsubscribe, group unsubscribe, dropped) and the unsubscribe endpoint, as framework-free handlers. The HTTP routes arrive with Phase 10, which also reuses this module's `only_if_missing` flagging mode for its backfill.
> - **A plan revision first, because it is the bigger finding: ~655 of Phase 6b²'s ~1,400 lines are not outbound code at all.** `inbound_email_nudge.py` (422) and `inbound_booking_email.py` (233) both open with a gate that REFUSES outbound chats — `if chat_data.get("type") == "outbound": return`, with the booking email even commenting _"outbound emails are the outbound skill's job"_. Their only production callers are the **inbound** web turn (`inbound_agent/views/call_llm_web.py`) and the outbound email webhook's fallback path for a web chat. Their genuinely shared parts were already extracted in Phase 6b¹ into `services/emailText.ts`. So they are not ported, and Phase 6b² is really just its two webhook handlers. Recorded as plan revision 7 — the same lesson as revision 5 from the other direction: **the directory an outbound file lives in does not make it outbound code.**
> - **GET must never unsubscribe anyone, and that is the whole design of the endpoint.** Corporate mail scanners — SafeLinks, Proofpoint, Mimecast — fetch every URL in a message, so a GET that suppressed would let a single corporate link-scan mass-unsubscribe an entire domain. GET renders a confirmation page and does nothing else; only POST suppresses, covering both the page button and RFC 8058 one-click (empty body, no login). Tested by asserting GET leaves the chat flag untouched.
> - **This module fails CLOSED, which is the opposite of the port's usual default.** Almost every gate in this codebase fails open so a fault cannot stop outreach. Here an unverifiable event is REJECTED: a forged event could suppress an arbitrary address and silence a real prospect permanently. No public key configured means reject unless `SENDGRID_WEBHOOK_ALLOW_UNSIGNED=true` says otherwise, and only the literal `"true"` counts. The ECDSA P-256 verification is tested against a real generated key pair, including a tampered body and a swapped timestamp.
> - **Every one of these events closes the EMAIL channel only.** A bounce, an unsubscribe, or a spam report never marks the prospect Lost, never touches `phone_opt_out`, and deliberately leaves `call_followup` tasks standing — a bad address or a withdrawn email consent says nothing about whether the person can be called, and treating it as terminal would discard workable leads at scale. Asserted directly, including that a pending call task survives an unsubscribe.
> - **Suppression stops the mail; the chat flag is what makes it explicable.** `suppress()` is global and invisible. The chat-level work — the trustworthy top-level `email_opt_out` / `email_invalid` keys, the memory mirror, the label, the activity row, and the visible `@ai` note naming the prospect — exists so a human can see WHY mail stopped instead of finding a silently dead thread. `dropped` is deliberately suppress-only: a drop is usually a downstream effect of an already-suppressed address, so flagging the chat off it would be a false signal.
> - **`only_if_missing` makes the backfill re-runnable.** It reads the chat first and skips it entirely when the target flags are already set, so a second run posts no duplicate notes. Both directions tested.
> - **Files:**
>   - `outbound/services/emailCompliance.ts`
>   - `outbound/__tests__/services/emailCompliance.test.ts`
> - **Verification:** 1,445 tests across 33 suites (35 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **One fixture of mine was wrong again:** the visible `@ai` note is written to `messages_v3`, not `messages`, so my assertions were reading an empty collection. Corrected against `logInternalNote` rather than adjusting the code.
>
> ---
>
> ### Outbound agent port — Phase 8b⁴: the turn entry, and the cron seam closes
>
> - **What changed:** Ported `call_llm_outbound.py`'s outbound turn assembly as `outbound/llm/turn.ts` — `runOutboundTurn` (prompt assembly, the concurrency lock, the dispatch loop, persistence) and `runOutboundLlm`, the in-process runner the cron and email webhook call. Added `firebase/agent.getAgentPrompt`. **The cron's injected `runTurn` now defaults to the real implementation**, closing the seam Phase 5 opened — the last open seam outside Phase 9's HubSpot resolver.
> - **Framework-free, which un-fuses two things the source had welded together.** The source drives all of this through a DRF view and then invokes that view in-process via a `_SimpleRequest` shim, so the turn logic and the HTTP endpoint are the same object. Here the logic is a function, the cron calls it directly, and Phase 10's route will be a thin adapter — the shim disappears entirely.
> - **Only a HUMAN `@ai` trigger is authoritative on timing, and this is the load-bearing distinction.** A human-typed `@ai` arrives over HTTP and may bypass the normal delays and the business-hours clamp; "asap"/"immediately"/"right away"/"right now" forces the action now. The cron and email webhook pass `admin_trigger_source: 'internal'` and get **no** such authority — an automated trigger firing "immediately" is how a scheduler stampedes. Both flags (`admin_override`, `admin_asap`) flow to the tools through `metaData`, which is exactly what `create_custom_task`'s override path reads. Tested from both directions, including that the cron saying "asap" changes nothing.
> - **The rapid-status lock is cleared in EVERY exit path, and that is not defensive tidiness.** It is a per-chat lock: `true` means a turn is already running, so a new message is queued rather than starting a second concurrent turn against the same history. A leaked `true` silently queues every future message for that chat and it goes quiet **with no error anywhere** — the worst kind of failure to diagnose. Cleared in a `finally`, with tests for the success path, the throwing path, and the queue-instead-of-race path.
> - **An outbound chat DISCARDS its base prompt**, so the lead context has to be re-injected after skills or the agent never learns who it is contacting. `applySkillsToPrompt` empties the base prompt for `type: 'outbound'` and uses the skill text as the whole prompt; the OUTBOUND LEAD CONTEXT and AVAILABILITY blocks, the conversation summary, template variables, and `restoreWipedInjections` all run after it. That last one is what makes "@ai read the inbound email and reply" work — the meeting-host fact is added before skills and would otherwise be wiped.
> - **The AVAILABILITY block is computed, never delegated to the model.** Two lines earn their place: the **no-answer email gate** is a "within 24 hours" judgement, and models are unreliable at time arithmetic — getting it wrong means either a wasted turn the send guard blocks anyway or an email whose premise is false. And the **STATUS line** exists because a prospect can be reopened by ops while the message history is never rewritten, so without an authoritative current-status line the agent re-reads its own old "marked Lost, cannot be reactivated" text and refuses to act. Both directions tested, including that an unparseable timestamp fails CLOSED.
> - **The seam stayed injectable after being wired up.** `CronOptions.runTurn` now defaults to `runOutboundLlm` but is still overridable, which is what keeps the cron's own tests from driving a live model. The seam earned its keep and remains.
> - **Files:**
>   - `outbound/llm/turn.ts`
>   - `outbound/firebase/agent.ts` (adds `getAgentPrompt`: the four headed sections are emitted even when empty because the headings are part of the contract prompts are written against, plus the oversee-inherits-parent and subagent-appends-workflow rules, with a depth cap so a misconfigured cycle cannot hang a turn)
>   - `outbound/services/cron.ts` (the seam default)
>   - `outbound/__tests__/llm/turn.test.ts`
> - **Verification:** 1,410 tests across 32 suites (36 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Four of my own fixtures were wrong, all in the same way — inventing a shape instead of reading the real one.** `enabled_functions` is not a field on the agent doc: it comes from the `actions` subcollection, where each entry must be `status: 'active'` AND point at a shared `actions/{id}` doc holding the function list. A skill without `type: 'outbound'` is correctly SKIPPED on an outbound chat, so my skill fixture vanished from the prompt. And I asserted `admin_asap` on "@ai call her now" — a bare "now" is deliberately not in the source's urgency list, so the source would not have matched it either. Each fixture corrected against the real reader, not the code.
> - **One naming collision worth knowing about:** `resolveStageAndSkills` exists in BOTH `skillsResolver` (returns an object) and `reviewHelpers` (returns a tuple). Same name, two contracts. Noted at the call site.
>
> ---
>
> ### Outbound agent port — Phase 8b³: the tool-dispatch loop
>
> - **What changed:** Ported `with_tools` — the single largest function in the source at ~1,370 lines — as `outbound/llm/run.ts`. One call is one agent TURN: ask the model, run the tools it requested, feed the results back, repeat until it stops.
> - **The one structural departure, and why it is forced: the dispatch is a TABLE, not a 96-branch `elif` chain.** The source dispatches 96 tool names, of which about 85 are INBOUND tools — WhatsApp, Zoho, Xtime, hotel booking, dealership appointments — belonging to the product this port is a clean break from. Reproducing the chain would mean porting or stubbing ~85 out-of-scope modules, and the ground rules forbid stubbing. So the table holds the ten tools that exist here, and an unrecognised name takes the source's OWN fallthrough: the "not implemented by this runtime" error toolResult it produces whenever `message` is still `None` after the chain. An inbound tool leaked in by an agent config, or one the model invents, therefore behaves exactly as in the source — one error result, and the turn continues so the model can react. This is also the payoff for Phase 8a inverting ~20 direct schema imports into a registry: a tool becomes dispatchable the moment it is ported, with no edit to this file.
> - **The rapid queue is drained TWICE, and the second drain is a race fix.** A customer can send another message while the model is thinking. Drain 1 sits between `generateText` and the dispatch; drain 2 runs at `end_turn`, because a message landing between those two points would otherwise be answered only on the NEXT turn — or never. Both re-open the turn rather than replying to a stale view of the conversation.
> - **The two drains differ deliberately, and the difference is sharper than it first looks.** Drain 1 POPS a trailing assistant message; because it runs BEFORE dispatch, that means a message arriving in that window **abandons the model's pending tool call** rather than executing it against a conversation the customer has already moved on from. Drain 2 does not pop, because the assistant turn there is the completed answer. Tested by asserting the email was never sent and the abandoned `toolUse` turn is absent from the history.
> - **A generation failure PERSISTS what already ran, then re-raises.** If the model call fails after tools have executed in earlier iterations, their results are written to the chat before the error propagates — the side effects already happened, so the record has to survive a provider blip. Also asserted: a persistence failure does not mask the original error.
> - **The short-circuit ends only fully-gated `@ai` turns.** When every tool in an iteration returned a deterministic BY-DESIGN gate and none succeeded or genuinely failed, the turn ends without another round-trip whose only output would be a discarded acknowledgement. A genuine FAILURE is deliberately not short-circuited — the loop continues so the model can react and the failure reaches the chat — and customer-facing turns are excluded entirely. All three cases tested, plus the kill switch.
> - **The source's loop condition is vestigial, and the type checker proved it.** `while stop_reason != 'end_turn'` never actually terminates the loop: the end_turn branch always breaks first, an unexpected stop reason returns, and the queue drains reset the variable and continue. TypeScript flagged the comparison as unreachable-by-narrowing, which is a correct proof that every exit is a `break` or `return` — so the port writes `for (;;)` and says so. Behaviour identical; the shape is now honest.
> - **An unexpected stop reason returns UNDEFINED, not a result.** The source `return`s bare from inside the loop, so callers get `None` rather than a tuple. Preserved, and Phase 8b⁴ will have to handle it.
> - **Files:**
>   - `outbound/llm/run.ts`
>   - `outbound/tools/stageTools.ts` (widened `company_id` to `string | number` to match the turn's meta shape — the source reads it loosely and stringifies)
>   - `outbound/__tests__/llm/run.test.ts`
> - **Verification:** 1,374 tests across 31 suites (27 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **A weak test I caught and rewrote, worth recording as a method note.** My first suite mocked `generateText` as a plain value — but the real one MUTATES the caller's message array, pushing the assistant turn (`messages.push(cleaned)` is the documented loop contract). With a value mock the history never contained the `toolUse` block, so `stampEmailOutcomeOnToolCall` had nothing to find and the stamp test passed while proving nothing. Rewriting the mock to honour the contract made the whole suite exercise the real history shape — and immediately surfaced a genuine gotcha: the stamp mutates the very input object the handler received, so jest's recorded call arguments gain `email_label` after the fact. Harmless in production, fatal to exact-match assertions.
>
> ---
>
> ### Outbound agent port — Phase 8b²: the turn engine's helper layer
>
> - **What changed:** Ported `llm/run.py`'s helper layer — everything ahead of the dispatch loop — as `outbound/llm/turnHelpers.ts` (~370 source lines): the two system-prompt injections, provider resolution for a turn, the terminal-block kill switch, and the toolResult plumbing.
> - **Both prompt injections are idempotent and PREPEND, and both matter.** Each block is added only if its header is not already present, so re-entering a turn cannot stack a second copy of the guardrails. They go at the FRONT because they are non-negotiable — a prompt cannot override an instruction it has not reached yet. The tool lists inside them are SORTED, which is not cosmetic: an unordered set would change the prompt prefix every turn and lose prompt caching. Tests pin idempotence, position, and stability under reordered input.
> - **A contradiction in the guardrail text, ported verbatim and flagged rather than fixed.** `OUTBOUND_MESSAGE_TOOL_NAMES` is a set of WhatsApp, web, and SMS tool names — "outbound" there means _agent-to-customer_, not "the outbound product". None of them exist in this port, whose customer-facing tools are `send_email` and the voice dial. So a pure outbound agent gets a block that says "Enabled outbound messaging tools: **none**" while also insisting the model MUST call one for every response. There is also no `email` branch in either channel switch, so an outbound email turn takes the generic hint. Prompt text drives model behaviour in ways the code cannot tell me, so rewriting it mid-port would be changing the product's voice on a guess — it needs evals and a deliberate decision. A test asserts the current wording so the change is visible when someone makes it.
> - **`stampEmailOutcomeOnToolCall` looks redundant until you know why it exists.** It copies a send outcome from the toolResult back onto the assistant's `toolUse` **input**. The messages-based inbox transformer reads each tool-call document in ISOLATION — it sees `toolUse.input` and never the paired toolResult — so without this stamp every attempted email renders as delivered, including the ones that deferred, were blocked, or failed. Tested with a deferred send specifically, plus that an explicit `email_label` is filled in rather than overwritten, and that the search stops at the LATEST matching turn.
> - **`appendToolResultMessage` groups on purpose.** Bedrock requires toolResult blocks to follow their toolUse immediately, so several tools called in one assistant turn must come back as ONE user message; appending them separately produces a history the provider rejects.
> - **Two deliberate fail-safe defaults.** `terminalBlockShortcircuitEnabled` treats ONLY the explicit off-values as off, so a typo leaves the optimization on instead of silently reverting behaviour (tested with five typos). `extractToolStatusAndMessage` returns `['', '']` — a non-verdict — for anything malformed, because the dispatch loop reads it to decide whether a tool terminally blocked and a bad payload must not crash the turn mid-flight; ten malformed shapes are asserted.
> - **One helper deliberately NOT ported.** `_inject_vehicle_summary` reads a chat's `appraisals` subcollection and is gated on the `switch_to_next_vehicle` tool. Both are inbound-only — outbound chats have no appraisals and that tool is not in this port — so the injection could never produce output. Recorded rather than ported dead, consistent with the dealer-analytics divergence from Phase 1. `_safe_int_env` is already `config.envInt`.
> - **Files:**
>   - `outbound/llm/turnHelpers.ts`
>   - `outbound/__tests__/llm/turnHelpers.test.ts`
> - **Verification:** 1,347 tests across 30 suites (41 new), `tsc --noEmit` clean, `eslint outbound/` clean.
>
> ---
>
> ### Outbound agent port — Phase 8b¹: the task and lifecycle tools
>
> - **What changed:** Ported the six tools the turn engine dispatches to, as `outbound/tools/taskTools.ts` (`create_custom_task`, `update_custom_task`, `delete_custom_task`) and `outbound/tools/stageTools.ts` (`mark_prospect_lost`, `mark_cadence_complete`, `clear_not_interested`) — ~776 source lines. These are the leaves of Phase 8b: the agent uses them to schedule its own next touch and to close prospects, so they land before the dispatch loop that calls them.
> - **A port bug I introduced and my own test caught: a fail-open gate turned fail-CLOSED.** `create_custom_task`'s channel gate reads `if _doc and not task_channel_open(...)`. The source's `load_chat_doc` returns `{}` for a missing chat **and for a read failure**, and `{}` is FALSY in Python — so an unreadable doc SKIPS the gate and the task is still created. A JS `{}` is truthy, so my first version fired the gate on an empty doc and refused to schedule anything. A Firestore blip would have silently stalled every cadence in the system while reporting a clean `skipped` to the agent. Now checks emptiness, with the reasoning on the line.
> - **Why the type coercion is not cosmetic.** `callback` and `outbound_call` are rewritten to `outbound_outreach` because the INBOUND cron fetches those two type names separately and would CONSUME the task — a call scheduled under either name leaks out of the outbound lane and never dials.
> - **Two gates that refuse to schedule, both protecting a cadence from advancing on nothing.** An email follow-up requires `_first_outbound_email_at`, which is stamped only on a REAL send: a deferred send already queued its own retry, so a follow-up on top would double-touch while no email ever goes out. And single-pending replacement means nudges never stack — `outbound_outreach` additionally clears pending follow-ups, because a queued first touch means no follow-up should exist yet.
> - **`mark_prospect_lost` refuses to close a prospect two ways, and both prevent losing a workable lead.** A stated decline routes to the `not_interested` LABEL, never the Lost stage, so the outcome is identical whether the review auto-detected it or the agent called the tool. And a call-channel dead end (`wrong_contact`, `unable_to_reach`, `no_response`) with EMAIL still reachable stands down the phone and keeps the prospect active — the phone failing to reach someone is not grounds for closing a contact we can still email. `customer_opted_out` and `customer_not_interested` are deliberately absent from that set, because those are statements from the person rather than failures of the channel; a test asserts the exclusion.
> - **`mark_cadence_complete` can decline to complete.** A spent PHONE cadence with an email fallback available flips the lane and schedules the first email instead of closing — routing the skill's completion through the same decision the deterministic safety net uses, so the fallback fires either way. Fails OPEN.
> - **An inconsistency preserved and made visible.** `create` clamps four voice types into business hours including `call_followup`; `update` clamps only three and OMITS it. So creating a phone-cadence bump lands in-hours but RESCHEDULING one does not. The two sets are named separately (`VOICE_TASK_TYPES_CREATE` / `_UPDATE`) with a test asserting the difference, so it reads as intentional rather than a typo. Changing it would move when live calls are placed.
> - **A misleading message documented rather than fixed.** `clear_not_interested`'s "no label was set — nothing to remove" branch is reached only when the WRITE FAILED: `removeLabelFromChat` returns true whenever the arrayRemove update succeeds, label present or not. So an absent label reports "removed" and a Firestore error reports "nothing to remove". Both are `success` and no caller branches on the wording, so it stands — with the real cause recorded on the function and pinned by a test.
> - **Files:**
>   - `outbound/tools/taskTools.ts`, `outbound/tools/stageTools.ts`
>   - `outbound/__tests__/tools/taskStageTools.test.ts`
>   - `outbound/__tests__/services/emailSender.test.ts` (see below)
> - **Verification:** 1,306 tests across 29 suites (45 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **A pre-existing weekend-only failure in the email suite, found because the date rolled over mid-session.** Four `emailSender` tests never mocked the clock-dependent G0b business-hours gate, and because that gate sits BEFORE the consuming gates, a `Real` record on a Saturday defers with `outside_business_hours` and can never reach the bucket or budget it was asserting on. Not caused by this phase — it would have failed on any weekend. Fixed the same way Phase 7b²a did: the gate reports "inside hours" by default and an explicit G0b test now drives it both ways, asserting that an after-hours send is audited as `deferred` but spends no domain budget. Two further traps found while fixing it: `jest.clearAllMocks()` drops recorded calls but NOT queued implementations, so an unconsumed `mockReturnValueOnce` leaks into the following test — and a Test record never consults that gate, so the queued value was never consumed. Both now use a plain `mockReturnValue` that `beforeEach` re-establishes.
> - **And one bug in my own test helper**, worth noting because it is easy to repeat: `seedChat` spread `...over` AFTER the merged `memory` key, so overriding a single memory field silently dropped every default in it. Fixed by destructuring `memory` out first.
>
> ---
>
> ### Outbound agent port — Phase 7b²d: the voice webhook handlers and dial-by-number
>
> - **What changed:** Ported both ElevenLabs voice webhooks as framework-free handlers in `outbound/services/voiceWebhooks.ts` — POST-CALL (a call finished) and CONVERSATION-INIT (a call is about to connect and needs context) — plus the `make_phone_call_from_number` variant. This closes the voice phase: placement, review, provisioning, and now the two inbound event paths.
> - **Why the two webhooks have OPPOSITE signature policies, and why that is correct.** Post-call **verifies and refuses**, because it mutates: it flips call cards, schedules a review turn, and releases a concurrency slot. Conversation-init **never blocks**, because it only reads and returns context — and the provider signs it with a _different_ secret than the post-call one, so hard-failing returned an empty payload, the agent fell back to its generic opener, and every caller lost their context and bookable slots. That was a real production bug. A test asserts each policy with a deliberately invalid signature, so a later "let's make these consistent" cleanup fails loudly.
> - **Three resolution tiers, ordered by durability, and the last one never mints a chat.** `pending_calls` is the fast path and is usually already gone by webhook time (the place-call turn deletes it). The `outbound_call_index` written at placement survives that cleanup and is the ONLY reliable resolver when the dialed number differs from the chat key — an admin "@ai call this other number". The final tier reconstructs the deterministic id from agent + customer number and must confirm the chat EXISTS; an unmatched webhook is a no-op, never a new conversation. Tested at each tier, including that an unknown number creates nothing.
> - **The transcript is stored from the webhook's OWN payload, before the review is scheduled.** That ordering is the point: a live re-fetch can race an empty turn array, which scores as zero human turns and false-flags a real conversation as voicemail — the source records that this lost a booked demo. Storing what the webhook already received removes the race, and scheduling the review immediately after enforces "only review once the transcript has landed".
> - **Every response is a 200-shaped body.** None of these failures are retryable, so an error status would only make the provider redeliver. Failures are reported in the body and `matched` tells the caller whether anything happened.
> - **A deliberate behaviour change on `make_phone_call_from_number`, with the reasoning.** The source implements it as a separate 373-line function whose docstring says "Same logic as make_phone_call but uses a hardcoded phone number ID". That is **not true** — it is a copy taken earlier that then drifted behind the original (now 480 lines). Diffing the two, normalized for log prefixes, the variant is missing: the `call_type` and `prospect_stage` variables, the meeting-host fact, the voice-skills injection, the HubSpot availability injection, and the oversee-agent phone-number deactivation check. So a call placed through it reached the prospect with materially less context, and a deactivated oversee number was not blocked. The port's bar for changing behaviour is "the source does not do what it SAYS it does", and here the docstring states the contract explicitly — so the port implements that contract as a thin wrapper over the real dialer, and the drift does not survive. The one thing not inherited is the variant's extra `instructions` validation, which is a real caller contract and is preserved even though the content is never forwarded anywhere.
> - **Note this resolves the OPPOSITE way to the stale docstring in Phase 7b²c, for the same reason.** There the CODE was newer than its comment, so the code was the spec. Here the comment states the intended contract and the code is the stale artifact. The question each time is which artifact is the later statement of intent — not a blanket rule that comments or code always win.
> - **Files:**
>   - `outbound/services/voiceWebhooks.ts`
>   - `outbound/services/elevenlabs.ts` (adds the raw `fetchConversationFromElevenlabs`, deliberately distinct from the review's normalized reader — the webhook is what WRITES the stored transcript, so it must read from the provider)
>   - `outbound/firebase/outboundChatMessages.ts` (adds `updateMessagesV3ForPhoneCall`; summary and recording are only written when non-empty, so a webhook carrying no transcript cannot blank a summary the review already filled in)
>   - `outbound/tools/makePhoneCall.ts` (the `phoneNumberIdOverride` seam plus the variant, applied AFTER routing so the oversee deactivation check still runs)
>   - `outbound/__tests__/services/voiceWebhooks.test.ts`, `outbound/__tests__/tools/makePhoneCall.test.ts`
> - **Verification:** 1,261 tests across 28 suites (38 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Three of my own tests were wrong before the code was.** One asserted the raw `received_phone_call` tool name appears in the stored card, but the v3 builder correctly converts it into a typed inbound call card (`direction: inbound`, `sender.kind: customer`) — I was asserting an implementation detail instead of the outcome, and the replacement checks the card's shape and adds a re-delivery dedup test. One called an `unwrap` helper that does not exist in that suite; it is `payloadOf`. One read `dynamic_variables` at the top level of the dial payload when it is nested under `conversation_initiation_client_data`.
>
> ---
>
> ### Outbound agent port — Phase 7b²c: ElevenLabs agent provisioning
>
> - **What changed:** Ported `services/elevenlabs_agent_service.py` (1,189 lines) as `outbound/services/elevenlabsAgentService.ts` — the write side of the voice stack. Where `elevenlabs.ts` (Phase 7a) patches a webhook onto an agent someone else built, this module builds the whole agent from the Firestore `voice_settings` document: prompt template blocks, voice, turn-taking, system tools, dynamic-variable placeholders, and knowledge-base sync.
> - **Why the two `voiceSettings` fallbacks are NOT interchangeable, and both had to be ported exactly.** Every field is read twice (Firestore holds a mix of snake_case and camelCase), but the source uses two different fallback mechanisms that disagree about zero:
>   - `a or b(default)` — Python's `or`, so any **falsy** value falls through. `optimize_streaming_latency`, `turn_timeout`, `max_conversation_duration`, and `silence_end_call_timeout` all work this way: a configured `0` becomes the default, not zero.
>   - `a.get(key, default)` — a dict default, which only fires when the key is **absent**. `stability`, `similarity`, and `speed` work this way: a configured `0` stays zero.
>
>   So `stability: 0` is honoured while `turn_timeout: 0` is silently replaced by 7. These values reach the provider verbatim, so normalizing the two would change how every existing agent behaves. `||` versus `??` in the port is load-bearing, not stylistic, and the two sides are asserted in adjacent tests.
>
> - **A bug fixed: knowledge-base names were paired to the wrong documents.** Both KB functions built their result by walking the **filtered** id list and indexing `sources[i]` for the name. The filter removes failed uploads — so the moment any one upload failed, every later entry was paired with a _different_ source's name, silently mislabelling the agent's knowledge bases. Nothing errors and the count is right, which is exactly why it would never be noticed. The port carries each name with its own id and only then drops the failures. A regression test fails one upload of three and asserts no survivor took the failed source's name.
> - **The source module docstring is stale, so the code was treated as the spec.** It claims the `{% if skills %}` block is NOT injected and that "skills never drive voice" — but the code injects both the block and its placeholder, in two places, each with a comment explaining that outbound voice _does_ inject voice-labelled skills. The code is newer and internally consistent; the false claim is not carried over. The port documents which one won and why.
> - **Two duplications collapsed, because they were in the code I was writing rather than the code I was reading.** `create_elevenlabs_agent` and `update_elevenlabs_agent` duplicate an identical ~130-line payload build (only the HTTP verb and log wording differ) — one shared builder here, with a test asserting the two send byte-identical payloads. The ~45-line KB text extractor is inlined verbatim in both KB functions — one `extractKbText`.
> - **The KB sync order is a safety property, and it is preserved.** Old documents are deleted only _after_ the agent has been successfully re-pointed at the new set. A failed re-point returns the new ids with `success: false` and leaves the old KBs intact, so the agent keeps working on its previous set instead of being left with none. The one exception is the no-sources case, which deletes the old set and reports success — that IS the intended end state. Three tests pin the ordering, including that a total upload failure destroys nothing.
> - **A deliberate divergence on timeouts.** The source passes `timeout=30` on its five agent calls and omits it entirely on the three knowledge-base calls; `fetch` has no default either, so porting that omission would let a KB upload or delete hang a whole serverless invocation. There is no stated intent to preserve and the module's own other calls establish 30s, so it is applied uniformly.
> - **A cross-wiring flagged, not silently fixed.** The provisioner points agents at `/inbound_agent/voice-agent/elevenlabs/conversation-init` — the **inbound** app — even though the outbound app mounts its own handler at the equivalent outbound path, wired to outbound services for exactly this purpose. So an outbound-provisioned agent fetches inbound context and the outbound handler is never reached. It looks like a survivor of the original clone, but the path is inert until the route exists, and re-pointing live agents is not a port's call. Preserved verbatim as an overridable constant and recorded as an open question for Phase 10.
> - **The four voice views are NOT in this phase.** They are DRF `APIView` classes and this repo is a Next.js App Router app, so the HTTP binding belongs with the Phase 10 surface. Checking their imports first is what settled it — the same check that moved the model layer ahead of the review chain.
> - **Files:**
>   - `outbound/services/elevenlabsAgentService.ts`
>   - `outbound/services/elevenlabs.ts` (exports `outboundPostCallWebhookId`, so provisioning and the webhook patch resolve the same id)
>   - `outbound/__tests__/services/elevenlabsAgentService.test.ts`
> - **Verification:** 1,223 tests across 27 suites (68 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **A blind spot in the voice-id heuristic, pinned rather than smoothed over.** An input over 15 characters that is alphanumeric once dashes and underscores are stripped is treated as a raw provider id and passed through — so `nonexistent-voice` (17 chars) never reaches the name mapping, and the Rachel fallback only protects names of 15 characters or fewer. My first test asserted the fallback applied and failed against a faithful port. Widening the heuristic would start mangling real ids, so the behaviour stands and a test now documents the boundary.
>
> ---
>
> ### Outbound agent port — Phase 7b²b²: the post-call review orchestrator
>
> - **What changed:** Ported `parse_and_run_review_call_transcript` — the post-call orchestrator every voice call funnels through exactly once — as `outbound/tools/reviewCallTranscript.ts`, with the ElevenLabs transcript fetch (`fetchCallFromElevenlabs`, `formatElevenlabsTranscript`) and the unmatched-demo booking fallback. This closes the review chain begun in Phases 7b¹ and 7b²b¹: almost every downstream decision about a prospect — what was said, who answered, whether a demo was agreed, whether outreach moves to a different person, whether the chat advances to Engaged — is made in this one pass.
> - **Why the four early exits are NOT interchangeable.** Each one encodes a different claim about what is knowable, and collapsing any two of them loses real calls:
>   1. **No `call_id`** — a plain failure; there is nothing to review.
>   2. **The provider has no such conversation** — TERMINAL. Retrying cannot help, so the attempt is FINALIZED (`finalizeUnresolvedCall`): the dial guard's awaiting-review block clears, the in-progress card flips to failed, the voice slot is released, the watchdog is cancelled. This is precisely what lets the 20-minute `check_if_call_succeeded` fallback self-heal a stale in-flight call instead of freezing the chat forever.
>   3. **An empty transcript** — "still processing", and deliberately **not** terminal and **not** read as a voicemail. Concluding "nobody spoke" from a transcript that has not landed yet would discard a real conversation. Asserted directly: the answerer classifier is never even reached, and nothing is finalized.
>   4. **This `call_id` was already reviewed** — an idempotent no-op success. Without it a re-fired review re-evaluates engagement and re-writes the stage, which is the **Lost↔Engaged flapping seen in production**. The test asserts the whole mutating pipeline is skipped by comparing the serialized chat doc before and after.
> - **`classifyCallOutcome` is the single authority on demo-versus-callback, and a demo is HARMONIZED across the output.** Booking, the callback task, `_customer_wants_callback`, and the hot-prospect signal all derive from that one call. But the channel-preference detector still labels a demo-slot agreement in callback-flavoured terms (`customer_requested_call`, `ending_reason=customer_asked_callback`, `conversation_status=deferred`), so a demo explicitly OVERWRITES those signals before the result goes out — a booked demo must never read as a callback anywhere downstream, including in the persisted `_customer_wants_callback` that `makePhoneCall`'s hot-prospect check reads to decide whether to re-dial. And a demo that cannot be slot-matched **still schedules a booking task**: it is never downgraded to a callback, because the booking turn resolves the exact time against live availability.
> - **The referral fork's two guards are load-bearing, so each is tested on its own.** A false positive here forks a duplicate chat AND stops the source chat's outreach — the source records that it stranded a booked demo once. So: **DEMO WINS** (a referral signal co-firing with a demo agreement is spurious) and **DIFFERENT PERSON ONLY** (the referred email/phone must differ from the prospect's own — including the address given on _this_ call, since "email me at my other address instead" is an email update, not a referral). Both suppressions record _why_ in `memory_changes` rather than failing silently.
> - **Opt-out mirroring sets on an opt-out and clears ONLY on an explicit opt-in — never on absence.** A prior opt-out has to survive a later call that simply did not mention it, so the absence case gets its own test rather than being left implicit.
> - **Engagement trusts hard signals over the heuristic, and refuses to guess when there are none.** A booked slot or captured schema fields mean the call was engaged BY DEFINITION; `hadMeaningfulEngagement` is only consulted when there is no hard signal, because it has misjudged clearly-engaged demo-booking calls and defaults false on error. When there is no engagement, "no engagement" is explicitly **not** "voicemail": blindly retrying re-dialed a fully engaged demo-booking call, and blindly not retrying misses a genuine voicemail that slipped past the turn-count gate — so the ambiguity is resolved with the voicemail classifier, and skipped entirely when a callback was already scheduled, because that IS the touch.
> - **A latent source bug the port cannot express.** The deal-note retry reads `agent_id`, which in Python only exists when `meta_data` carried one; otherwise it raises `NameError` inside the function-wide handler — silently skipping booking, the callback, the stage advance, AND the idempotency stamp, after every earlier side effect has already run. The port resolves `agentId` once into a plain string at the top, so the condition simply reads falsy. Documented at the call site.
> - **One piece of source dead code not ported, rather than ported dead.** The summary step falls back to the recent stored transcript when the formatted one is empty — but an empty transcript already returned at step 1, so that branch is unreachable. Recorded in the module comment.
> - **The HubSpot slot matcher is injected, not stubbed.** `resolveBookingSlot` is a typed seam (the same pattern as the cron turn runner). With no resolver the demo takes the source's own unmatched path — which is byte-for-byte what the source does when HubSpot is not configured, so the absence changes no behaviour rather than approximating it. `maybeAddDealConversationNote`, `preservePriorEmailOnContact`, and `syncHubspotStage` were each best-effort and non-blocking in the source; they are recorded in the deferral ledger for Phase 9. The Vapi fetcher is not ported, matching `makePhoneCall`: no Vapi dialer exists in this deployment, so no Vapi call can be under review — and that path deliberately does **not** finalize, because an unsupported provider is a deployment gap, not evidence the conversation is gone.
> - **Files:**
>   - `outbound/tools/reviewCallTranscript.ts`
>   - `outbound/services/callScope.ts` (exports `scanPriorInteractions`, so the reported `voice_attempts` is the same count the scope block shows the agent)
>   - `outbound/__tests__/tools/reviewCallTranscript.test.ts`
> - **Verification:** 1,155 tests across 26 suites (56 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **Two tests that were wrong before the port was.** The card-flip test seeded a flat `{call_id, status}` activity doc, but `markCallCompletedInActivities` matches on the nested `toolCall.result.call_id` with a call-tool name — the port was faithful and the fixture was invented. The cadence-reset test asserted `memory._followup_count`; the real counters are the top-level `email_followup_count` / `call_followup_count`. Both fixtures corrected rather than the code.
>
> ---
>
> ### Outbound agent port — Phase 7b²b¹: post-call classification and the review's actions
>
> - **What changed:** Ported the post-call classifiers and the five actions a review takes from them, as `outbound/tools/reviewActions.ts`: `classifyAnswerer`, `detectVoicemail`, `llmDetectVoicemail`, `hadMeaningfulEngagement`, `scheduleRetryCall`, `scheduleCallback`, `scheduleFollowupEmail`, `classifyEmail`, and `markCallReviewed`.
> - **Why the two classifiers have OPPOSITE defaults, each chosen for recoverability.** This is the load-bearing property, and normalizing it would be a real regression:
>   - `classifyAnswerer` defaults to **`"human"`** on any error. A wrong `human` leaves the chat at Contacted and the cadence re-dials — recoverable. Discarding a REAL call as voicemail is not.
>   - `hadMeaningfulEngagement` defaults to **`false`**. Not advancing a stage is recoverable; a wrong advance corrupts the funnel.
>
>   A test asserts both directions side by side, from the same induced failure.
>
> - **There are deliberately NO deterministic phrase pre-checks, and the source explains the trade.** A phrase pre-check scanned the WHOLE transcript and fired on ANY machine phrase — so a call that OPENED with a machine segment (a call-screening "record your name", hold music, even a voicemail greeting) and THEN had a live person pick up was wrongly discarded. The pre-check guarded one thing, the model's weakness on very short machine greetings, which is a RECOVERABLE error — but it CAUSED the unrecoverable one. Review runs once per call off the hot path, so the extra model call is free. The single non-model shortcut is the FACTUAL zero-human-turns case, which needs no model call at all. Both prompts also state that turn counts must not be trusted, because an automated menu produces many turns and used to drive chats to Engaged.
> - **`detectVoicemail` deliberately excludes IVR.** An IVR reached no person but is a DISTINCT outcome the caller handles separately; conflating the two would take the wrong follow-up action. Asserted directly.
> - **Two things the follow-up email gets right that are easy to break:** a captured address is recorded as a SECONDARY entry and **never overwrites the primary `customer_email`** — a receptionist's shared inbox is not the prospect's address, and overwriting would silently redirect the whole cadence. And the wording is classification-aware: a department inbox gets a polite FORWARD request naming the prospect, a personal address is addressed directly, and both explicitly forbid no-answer and booking-confirmation wording because neither premise is true.
> - **Files:**
>   - `outbound/tools/reviewActions.ts`
>   - `outbound/__tests__/tools/reviewActions.test.ts`
> - **Verification:** 1,099 tests across 25 suites (45 new), `tsc --noEmit` clean, `eslint outbound/` clean.
> - **`MAX_VOICE_RETRIES` is ZERO in the source, which disables the auto-retry entirely** — `attempts >= 0` always trips on the first check. Ported at 0 deliberately, with the code path intact, so restoring the behaviour is one constant change rather than a rewrite. Raising it during the port would have silently turned a disabled feature back on. A test pins the constant.
> - **A source laxness preserved rather than tightened:** the follow-up-email validation is only "contains `@`, and the domain contains a dot", so `@nolocal.com` — an empty local part — passes. My first test asserted it would be rejected and failed against a faithful port. Left as-is: this call only schedules a TASK, and the send tool's own verification gate rejects an undeliverable address before anything is mailed, so there is no failure to justify a behaviour change. Also noted in the module: `scheduleFollowupEmail` reads the email opt-out from `memory` rather than the trustworthy top-level key the phone gates use — an inconsistency in the source, preserved because changing it would alter which contacts get a follow-up.
>
> ---
>
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
