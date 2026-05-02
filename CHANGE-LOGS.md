## 🗓️ **2026-05-03**

---

### ✨ Features

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
