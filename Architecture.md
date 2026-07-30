# AI Content Outreach Agent - Comprehensive System Architecture

> **Purpose**: Deep-dive architecture document based on full codebase analysis. Use this as the blueprint for understanding the agent or extending it into further features.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [High-Level Architecture Diagram](#3-high-level-architecture-diagram)
4. [Project Structure](#4-project-structure)
5. [AI Agents & Pipeline Architecture](#5-ai-agents--pipeline-architecture)
6. [Data Hierarchy & Multi-Pipeline Structure](#6-data-hierarchy--multi-pipeline-structure)
7. [API, Webhooks & Integrations](#7-api-webhooks--integrations)
8. [Database Schema & Relationships](#8-database-schema--relationships)
9. [Developer Workflow](#9-developer-workflow)

---

## 1. System Overview

This application is an **AI-driven Content Outreach Agent**. It automates the discovery, qualification, and outreach of brand leads across specific niches by evaluating their content (website & Instagram) and generating highly personalized pitch messages to be delivered via WhatsApp. It is built as a multi-tenant, multi-pipeline system, allowing an "Overseer" to run fully automated parallel campaigns and test isolated strategies safely.

### What's Included Out of the Box

| Area                | Status   | Details                                                              |
| ------------------- | -------- | -------------------------------------------------------------------- |
| Framework           | ✅ Ready | Next.js 16 with App Router + React 19                                |
| AI Integration      | ✅ Ready | Gemini Models (`gemini-3.1-pro-preview`) via `@google/generative-ai` |
| Agent Orchestration | ✅ Ready | `@langchain/langgraph` for pipelined task execution                  |
| Web Scraping        | ✅ Ready | FireCrawl JS + Apify Client                                          |
| Messaging           | ✅ Ready | Unipile Integration for WhatsApp Dispatch                            |
| Database            | ✅ Ready | Firebase Firestore                                                   |
| Memory Bank         | ✅ Ready | Vercel Blob for Markdown Playbooks (Simple RAG)                      |
| Authentication      | ✅ Ready | Firebase Auth (Email/Password & Magic Link)                          |
| Styling             | ✅ Ready | Tailwind CSS v4 + dark mode                                          |

---

## 2. Technology Stack

### Framework & Runtime

| Layer      | Technology           | Version |
| ---------- | -------------------- | ------- |
| Framework  | Next.js (App Router) | 16.1.6  |
| UI Library | React                | 19.2.3  |
| Language   | TypeScript           | ^5      |
| Runtime    | Node.js              | ≥20     |

### AI & Agent Tooling

| Layer               | Technology                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Main LLM            | Gemini (`gemini-3.1-pro-preview`) via `@google/generative-ai` & `@langchain/google-genai` |
| Agent Orchestration | `@langchain/langgraph`                                                                    |
| Web Scraping        | `@mendable/firecrawl-js`, `apify-client`                                                  |
| Web Discovery       | `@tavily/core` semantic search                                                            |
| Integrations        | Unipile (WhatsApp), Vercel Blob (Playbooks)                                               |

### Database & Auth

| Layer          | Technology                                        |
| -------------- | ------------------------------------------------- |
| Database       | Firebase Firestore (`firebase-admin`, `firebase`) |
| Memory Storage | Vercel Blob (`@vercel/blob`)                      |
| Authentication | Firebase Auth                                     |

---

## 3. High-Level Architecture Diagram

```
┌────────────────────────────────────────────────────────────┐
│                    BROWSER (Admin UI)                      │
│ - Pipelines Control Room  - Sandbox Diagnostics & Inspect  │
│ - Leads & Outcomes Logger - Intelligence Hub (Playbooks)   │
└─────────────────────────────┬──────────────────────────────┘
                              │ HTTP / Firebase Auth Cookies
┌─────────────────────────────▼──────────────────────────────┐
│                NEXT.JS SERVER (API Routes & Cron)          │
│                                                            │
│  ┌─────────────────────┐   ┌────────────────────────┐      │
│  │  Admin APIs         │   │  Cron/Webhook Routes   │      │
│  │  /api/admin/*       │   │  /api/cron/*           │      │
│  └──────────┬──────────┘   └───────────┬────────────┘      │
│             │                          │                   │
│  ┌──────────▼──────────────────────────▼───────────────┐   │
│  │                  AI Agents                          │   │
│  │ - Crawl Strategy (Gemini) - Plans Targets           │   │
│  │ - LangGraph Lead Pipeline (Scrape, Audit, Pitch)    │   │
│  │ - Niche Health Evaluator - Cool-down / Replacement  │   │
│  │ - Feedback Loop Agent - General Optimization        │   │
│  │ - Learner Agent - Playbook Synthesizer (RAG)        │   │
│  └──────────────────────────┬──────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────┘
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
    ┌─────▼───────┐   ┌───────▼────────┐   ┌───────▼────────┐
    │ Firestore   │   │ Vercel Blob    │   │ Integrations   │
    │ (Databases) │   │ (Playbook RAG) │   │ (Unipile,      │
    └─────────────┘   └────────────────┘   │  Firecrawl,    │
                                           │  Tavily, Apify)│
                                           └────────────────┘
```

---

## 4. Project Structure & Module Relations

```text
ai-content-outreach-agent/
│
├── lib/
│   ├── agents/                      # Core AI agents (Brain of the system)
│   │   ├── crawlStrategyAgent.ts    # (Cron/Manual) Plans crawl targets per Niche. Uses Strategist playbook.
│   │   ├── feedbackLoopAgent.ts     # (Cron/Manual) Tunes global niche priorities and updates database metrics.
│   │   ├── learnerAgent.ts          # (Sandbox End-of-Run) Analyzes human edits/rejections to rewrite blob playbooks.
│   │   └── nicheHealthEvaluator.ts  # (Post-Crawl) Flags underperforming niches for cool-down or replacement.
│   ├── db/                          # Firestore data access layer (DAL)
│   │   ├── connections.ts           # Maps Unipile integration accounts
│   │   ├── crawlSessions.ts         # Automated run logs and sandbox routing
│   │   ├── dispatchLogs.ts          # WhatsApp send attempt records
│   │   ├── feedbackSignals.ts       # CRM outcome feedback records
│   │   ├── intelligence.ts          # Registry mapping pipelines to Vercel Blob Playbooks
│   │   ├── leads.ts                 # Stores both pristine leads and isolated sandbox candidates
│   │   ├── niches.ts                # Target market data
│   │   ├── pipelines.ts             # Central isolated workflow containers
│   │   ├── pitchEvaluations.ts      # Per-lead Gemini analysis records
│   │   ├── settings.ts              # Global integration API keys & execution flags
│   │   └── userProfiles.ts          # Multi-tenant auth records
│   ├── pipeline/                    # The LangGraph Orchestrator
│   │   └── runPipeline.ts           # Plugs Scraper -> Auditor -> Evaluator -> DB. Skips DB globally if isSandbox=true.
│   ├── services/                    # External service wrappers
│   │   ├── autoprospector.ts        # Mass-discovery from Tavily semantic search + Firecrawl directory maps
│   │   ├── blobStorage.ts           # Vercel Blob read/write/delete (Memory Bank)
│   │   ├── geminiPitchGenerator.ts  # Generates the payload text and gap score
│   │   ├── instagramAuditor.ts      # Apify Instagram KPI wrapper
│   │   ├── unipile.ts               # Unipile WhatsApp send + account management
│   │   ├── websiteScraper.ts        # Firecrawl wrapper with phone/brand detection
│   │   └── whatsappDispatcher.ts    # Batch dispatch with niche guardrails and throttling
│   ├── types/                       # Shared TypeScript interfaces
│   └── utils/                       # Auth helpers, misc utilities
│
├── src/
│   ├── app/
│   │   ├── admin/                   # Frontend Modules
│   │   │   ├── connections/         # Global WhatsApp connection management
│   │   │   ├── intelligence/        # Intelligence Hub (Reading Blob Playbooks)
│   │   │   ├── leads/               # Pristine global CRM with inline feedback teaching
│   │   │   ├── niches/              # Config and AI strategy note hub
│   │   │   ├── pipelines/           # Pipeline orchestration control room
│   │   │   ├── sessions/            # The Sandbox Diagnostics workspace (ManualTriggers)
│   │   │   └── settings/            # API key and guardrail management
│   │   ├── api/
│   │   │   ├── admin/               # Authorized management hooks
│   │   │   │   ├── connections/     # Unipile OAuth + connection health
│   │   │   │   ├── dispatch-manual/ # Manual sandbox dispatch
│   │   │   │   ├── feedback/        # Signal ingestion + feedback loop runner
│   │   │   │   ├── finalize-sandbox/# End-of-run sandbox close
│   │   │   │   ├── init-pipeline/   # Pipeline init + playbook generation
│   │   │   │   ├── niches/          # Niche CRUD
│   │   │   │   ├── pipelines/       # Pipeline CRUD
│   │   │   │   ├── regenerate-pitch/# Re-run pitch generation for a lead
│   │   │   │   ├── run-crawl/       # Manual crawl trigger
│   │   │   │   ├── run-dispatch/    # Manual dispatch trigger
│   │   │   │   ├── settings/        # Settings management
│   │   │   │   ├── synthesize-run/  # End-of-run Learner Agent trigger
│   │   │   │   ├── triage-lead/     # Sandbox lead approval/rejection
│   │   │   │   └── unipile/connect/ # Hosted auth link generation
│   │   │   ├── auth/profile/        # Firebase session auth
│   │   │   └── cron/                # Scheduled tasks (crawl, dispatch, health)
```

---

## 5. AI Agents & Pipeline Architecture

The system mimics a full outreach team composed of isolated "Agent Personas".

### 1. Crawl Strategy Agent (`The Strategist`)

- **Role**: Decides _who_ to target today.
- **Process**: Looks at global performance metrics (close rate, gap scores) across Niches and dictates targets for the `autoProspector`. Reads from the Strategist Playbook via Simple RAG.

### 2. The LangGraph Pipeline Orchestrator (`runPipeline.ts`)

The execution engine that runs per target URL.

1. **Deduplication Node**: Skips targets previously contacted across the system (unless explicitly overridden in Pipeline settings).
2. **Scraper Node** (`The Web Scraper`): Uses Firecrawl to pull website DOMs and structured contact data. Falls back to the `/contact` page if no phone is found on the homepage.
3. **Auditor Node** (`The Social Auditor`): Uses Apify to pull Instagram KPIs (post count, engagement, video presence, last post date).
4. **Generator Node** (`The Copywriter` & `Lead Analyst`): Pushes sanitized data through Gemini to calculate a 1–10 "Visual Poverty Gap Score" and writes the final WhatsApp pitch using one of four pitch angles (`noVideo`, `badVideo`, `costPain`, `volumeHungry`). References the Copywriter Playbook.
5. **Persistence Node**: Routes outputs to the Database. Sandbox runs are segregated into an isolated per-run subcollection under `leads/`.

### 3. Niche Health Evaluator (`nicheHealthEvaluator.ts`)

- **Role**: The Market Watchdog.
- **Process**: Evaluates each niche after a crawl session completes. If the success rate falls below 5% for 3 consecutive sessions, the niche is flagged `cool-down` and the agent suggests a replacement niche. Health scores (0–100) are written back to the `niches` collection.

### 4. Learner Agent (`learnerAgent.ts`)

- **Role**: The Memory Synthesizer.
- **Process**: At the end of a Sandbox Run, it analyzes a batch payload of explicit human actions (approved leads, rejected leads, and human-edited pitch text). It rewrites the underlying Markdown Playbook files hosted in Vercel Blob and re-registers the updated versions, allowing the AI to organically adapt without complex ML fine-tuning.

### 5. Feedback Loop Agent (`feedbackLoopAgent.ts`)

- **Role**: The Data Scientist.
- **Process**: Sweeps manual feedback signals (Closed, Rejected, Ghosted) logged from the CRM to hardcode Niche priority values and expand Niche-level blacklists algorithmically.

---

## 6. Data Hierarchy & Multi-Pipeline Structure

The application supports multiple concurrent "Pipelines". Each Pipeline acts as an isolated container to test different market segments safely.

### The Sandbox Quarantine Zone

A Sandbox run operates entirely manually and is disconnected from automated cron jobs.

1. **Initialization**: Starting a Sandbox run seamlessly initializes a new Pipeline.
2. **Quarantine Write**: Targets found during the run are stored in an isolated per-run subcollection at `leads/sandbox_{pipelineId}_{runId}/items/{docId}`. They do not pollute the main CRM (`leads`). Composite IDs are encoded as `sandbox:{pipelineId}:{runId}:{docId}` so all DB helpers route them correctly.
3. **Promotion**: When the Overseer clicks "Dispatch" on a Lead Card from the Sandbox Tray, the `dispatch-manual` endpoint fires the WhatsApp payload directly and updates the lead in-place with its dispatch outcome.
4. **Junk Retention**: Ignored or explicitly rejected sandbox candidates stay permanently in quarantine so that the `synthesize-run` endpoint can securely read them to teach the Learner Agent what the human decided to avoid.

---

## 7. API, Webhooks & Integrations

### Cron Endpoints

| Route                    | Schedule (UTC)                                   | Function                                                    |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------- |
| `GET /api/cron/crawl`    | Hourly; fires when hour = `crawlScheduleHour`    | Strategy → Auto-Prospector → Pipeline for all active niches |
| `GET /api/cron/dispatch` | Hourly; fires when hour = `dispatchScheduleHour` | Batch dispatch of `Qualified` leads via WhatsApp            |
| `GET /api/cron/health`   | On-demand                                        | System health check                                         |

All cron routes require `Authorization: Bearer {CRON_SECRET}`.

### External Integrations

| Integration     | Purpose                                        | SDK / Endpoint                    |
| --------------- | ---------------------------------------------- | --------------------------------- |
| **Unipile**     | WhatsApp account management + message dispatch | Custom fetch → `UNIPILE_BASE_URL` |
| **Firecrawl**   | Website scraping (markdown, links, images)     | `@mendable/firecrawl-js`          |
| **Tavily**      | Semantic web search for brand discovery        | `@tavily/core`                    |
| **Apify**       | Instagram profile KPI scraping                 | `apify-client`                    |
| **Gemini**      | LLM for all agents (strategy, pitch, feedback) | `@langchain/google-genai`         |
| **Vercel Blob** | Playbook Markdown storage (Simple RAG)         | `@vercel/blob`                    |
| **Firebase**    | Auth + Firestore persistence                   | `firebase-admin`, `firebase`      |

### Simple RAG via Vercel Blob

Instead of bloated vector databases, the intelligence "Playbooks" for the AI personas are raw Markdown files stored in Vercel Blob. These are fetched inline during runtime and passed directly into the agent prompt context. The `intelligence` Firestore collection acts as a registry mapping each `(userId, pipelineId, agentRole)` tuple to a versioned Blob URL.

---

## 8. Database Schema & Relationships

All structured entity data is stored in Firebase Firestore using a **multi-tenant design** (all documents require `userId`). Deduplication for production leads uses `(userId, dedupHash)`. Sandbox leads dedup within their run only.

---

### Collection Map

```
userProfiles/{userId}
settings/{userId}
connections/{instanceId}
pipelines/{pipelineId}
niches/{nicheId}
leads/{leadId}                                     ← production leads
leads/sandbox_{pipelineId}_{runId}/items/{docId}   ← sandbox leads (per-run subcollection)
crawlSessions/{sessionId}
pitchEvaluations/{evalId}
dispatchLogs/{logId}
feedbackSignals/{signalId}
intelligence/{registryId}
```

---

### Schemas

#### `userProfiles/{userId}`

| Field     | Type      | Description        |
| --------- | --------- | ------------------ |
| email     | string    | User email address |
| name      | string    | Display name       |
| createdAt | Timestamp |                    |
| updatedAt | Timestamp |                    |

---

#### `settings/{userId}`

| Field                  | Type      | Description                                    |
| ---------------------- | --------- | ---------------------------------------------- |
| userId                 | string    |                                                |
| crawlEnabled           | boolean   | Master toggle for cron crawl jobs              |
| dispatchEnabled        | boolean   | Master toggle for cron dispatch jobs           |
| maxConcurrentPipelines | number    | Max parallel crawl operations (default 5)      |
| dispatchBatchSize      | number    | Max leads dispatched per cron run (default 20) |
| crawlScheduleHour      | number    | UTC hour (0–23) to run crawl cron              |
| dispatchScheduleHour   | number    | UTC hour (0–23) to run dispatch cron           |
| apiKeys                | object    | `{ openAi?, gemini?, firecrawl?, unipile? }`   |
| updatedAt              | Timestamp |                                                |

---

#### `connections/{instanceId}`

| Field       | Type      | Description                       |
| ----------- | --------- | --------------------------------- |
| userId      | string    |                                   |
| provider    | string    | Always `'whatsapp'`               |
| phoneNumber | string    | Connected WhatsApp number         |
| countryCode | string    |                                   |
| status      | string    | `'connected'` \| `'disconnected'` |
| webhookUrl  | string?   |                                   |
| instanceId  | string    | Unipile account ID (doc ID)       |
| apiKey      | string?   | Unipile API key for this account  |
| connectedAt | Timestamp |                                   |
| updatedAt   | Timestamp |                                   |

---

#### `pipelines/{pipelineId}`

| Field          | Type      | Description                              |
| -------------- | --------- | ---------------------------------------- |
| userId         | string    |                                          |
| name           | string    |                                          |
| description    | string    |                                          |
| clientSeedUrls | string[]  | Seed URLs to bootstrap crawl strategy    |
| status         | string    | `'running'` \| `'paused'` \| `'stopped'` |
| connectionId   | string?   | FK → `connections/{instanceId}`          |
| settings       | object?   | Pipeline-level overrides                 |
| createdAt      | Timestamp |                                          |
| updatedAt      | Timestamp |                                          |

---

#### `niches/{nicheId}`

| Field                | Type       | Description                                                     |
| -------------------- | ---------- | --------------------------------------------------------------- |
| userId               | string     |                                                                 |
| pipelineId           | string     | FK → `pipelines/{pipelineId}`                                   |
| nicheName            | string     |                                                                 |
| crawlPriority        | number     | Relative crawl weight (updated by feedback loop agent)          |
| avgGapScore          | number     | Rolling average gap score across leads in this niche            |
| closeRate            | number     | Fraction of pitched leads that closed                           |
| avgProductPrice      | number     | Average product price across leads                              |
| seedUrls             | string[]   | Starting discovery URLs for this niche                          |
| blacklistedSignals   | string[]   | Keywords/signals that disqualify a lead                         |
| health_score         | number     | 0–100 composite health score                                    |
| consecutive_failures | number     | Consecutive crawl sessions with <5% success; triggers cool-down |
| status               | string     | `'active'` \| `'cool-down'`                                     |
| coolDownReason       | string?    |                                                                 |
| replacedNicheId      | string?    | FK → `niches/{nicheId}` of the niche that replaced this one     |
| replacedNicheName    | string?    |                                                                 |
| pipelineGuardrails   | object?    | `{ minAiGapScore?: number, maxDailyDispatches?: number }`       |
| lastCrawled          | Timestamp? |                                                                 |
| createdAt            | Timestamp  |                                                                 |
| updatedAt            | Timestamp  |                                                                 |

---

#### `leads/{leadId}` and `leads/sandbox_{pipelineId}_{runId}/items/{docId}`

Sandbox leads share the same schema but are stored in a per-run subcollection. Their composite ID is encoded as `sandbox:{pipelineId}:{runId}:{docId}`.

| Field                  | Type       | Description                                                                                                                                        |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| userId                 | string     |                                                                                                                                                    |
| pipelineId             | string     | FK → `pipelines/{pipelineId}`                                                                                                                      |
| nicheId                | string     | FK → `niches/{nicheId}`                                                                                                                            |
| crawlSessionId         | string     | FK → `crawlSessions/{sessionId}`                                                                                                                   |
| brandName              | string?    |                                                                                                                                                    |
| websiteUrl             | string     |                                                                                                                                                    |
| whatsappNumber         | string?    |                                                                                                                                                    |
| instagramUrl           | string?    |                                                                                                                                                    |
| targetProductName      | string?    |                                                                                                                                                    |
| targetProductImageUrl  | string?    |                                                                                                                                                    |
| generatedPitch         | string?    | Final pitch text (may be human-edited in sandbox)                                                                                                  |
| originalGeneratedPitch | string?    | Stored when a human edits the pitch; preserves the original AI draft                                                                               |
| pitchAngle             | string?    | `'noVideo'` \| `'badVideo'` \| `'costPain'` \| `'volumeHungry'`                                                                                    |
| crawlSource            | string     | Discovery method (e.g. `'tavily'`, `'firecrawl'`)                                                                                                  |
| dedupHash              | string     | SHA256 of `(userId + websiteUrl)` — global dedup for production leads                                                                              |
| socialMediaGapScore    | number     | 1–10 visual content poverty score from Gemini                                                                                                      |
| status                 | string     | `'Qualified'` \| `'Pitched'` \| `'Failed'` \| `'incomplete'` \| `'Closed'` \| `'Rejected'` \| `'Ghosted'` \| `'Negotiating'` \| `'Number Invalid'` |
| isSandbox              | boolean    |                                                                                                                                                    |
| dispatchStatus         | string?    | `'approved'` \| `'rejected'` (sandbox triage result)                                                                                               |
| triageStatus           | string?    | `'approved'` \| `'rejected'` (used by synthesize-run)                                                                                              |
| sandboxRejected        | boolean?   |                                                                                                                                                    |
| lastMessageSent        | string?    |                                                                                                                                                    |
| lastMessageSentAt      | Timestamp? |                                                                                                                                                    |
| dispatchSuccess        | boolean?   |                                                                                                                                                    |
| analystNarrative       | string?    | Analyst agent's reasoning for the gap score                                                                                                        |
| createdAt              | Timestamp  |                                                                                                                                                    |
| updatedAt              | Timestamp  |                                                                                                                                                    |

---

#### `crawlSessions/{sessionId}`

| Field            | Type       | Description                                               |
| ---------------- | ---------- | --------------------------------------------------------- |
| userId           | string     |                                                           |
| pipelineId       | string     | FK → `pipelines/{pipelineId}`                             |
| nicheId          | string     | FK → `niches/{nicheId}`                                   |
| targetUrls       | string[]   | URLs passed into the pipeline in this session             |
| discoveredBrands | number     |                                                           |
| processedBrands  | string[]   | URLs already scraped (dedup within session)               |
| leadsCreated     | number     |                                                           |
| leadsQualified   | number     |                                                           |
| agentReasoning   | string?    | Strategist's text rationale for target selection          |
| sessionStatus    | string     | `'Running'` \| `'Completed'` \| `'Failed'` \| `'Stopped'` |
| startedAt        | Timestamp  |                                                           |
| completedAt      | Timestamp? |                                                           |
| agentLogs        | AgentLog[] | Append-only log of per-agent narrative entries            |
| isSandbox        | boolean    |                                                           |

**AgentLog sub-object:**

| Field     | Type   | Description                                                                                 |
| --------- | ------ | ------------------------------------------------------------------------------------------- |
| timestamp | string |                                                                                             |
| agentRole | string | `'strategist'` \| `'scraper'` \| `'auditor'` \| `'analyst'` \| `'copywriter'` \| `'system'` |
| narrative | string | Human-readable activity log                                                                 |

---

#### `pitchEvaluations/{evalId}`

| Field              | Type      | Description                         |
| ------------------ | --------- | ----------------------------------- |
| userId             | string    |                                     |
| leadId             | string    | FK → `leads/{leadId}`               |
| gapScore           | number    | 1–10 visual poverty score           |
| pitchAngle         | string    |                                     |
| sanitizedImages    | string[]  | Image URLs used for Gemini analysis |
| websiteTextSummary | string?   |                                     |
| igPostSummary      | string?   |                                     |
| rawGeminiResponse  | string?   |                                     |
| createdAt          | Timestamp |                                     |

---

#### `dispatchLogs/{logId}`

| Field          | Type      | Description           |
| -------------- | --------- | --------------------- |
| userId         | string    |                       |
| leadId         | string    | FK → `leads/{leadId}` |
| whatsappNumber | string    |                       |
| messageSent    | string    |                       |
| success        | boolean   |                       |
| errorMessage   | string?   |                       |
| attemptNumber  | number    |                       |
| dispatchedAt   | Timestamp |                       |

---

#### `feedbackSignals/{signalId}`

| Field           | Type      | Description                                                  |
| --------------- | --------- | ------------------------------------------------------------ |
| userId          | string    |                                                              |
| pipelineId      | string    | FK → `pipelines/{pipelineId}`                                |
| leadId          | string    | FK → `leads/{leadId}`                                        |
| nicheId         | string    | FK → `niches/{nicheId}`                                      |
| outcome         | string    | `'Closed'` \| `'Rejected'` \| `'Ghosted'` \| `'Negotiating'` |
| pitchAngleUsed  | string?   |                                                              |
| productPrice    | number?   |                                                              |
| gapScoreAtPitch | number?   |                                                              |
| notes           | string?   |                                                              |
| aiAdjustmentLog | string?   |                                                              |
| recordedAt      | Timestamp |                                                              |

---

#### `intelligence/{registryId}`

| Field       | Type      | Description                                                                   |
| ----------- | --------- | ----------------------------------------------------------------------------- |
| userId      | string    |                                                                               |
| pipelineId  | string    | FK → `pipelines/{pipelineId}`                                                 |
| agentRole   | string    | `'strategist'` \| `'scraper'` \| `'auditor'` \| `'analyst'` \| `'copywriter'` |
| blobUrl     | string    | Vercel Blob URL of the Markdown playbook                                      |
| version     | number    | Incremented each time the Learner Agent rewrites the playbook                 |
| lastUpdated | Timestamp |                                                                               |

---

### Relationships

```
userProfiles ──(1:N)──> pipelines          via userId
userProfiles ──(1:1)──> settings           via userId

pipelines ──(1:N)──> niches               via pipelineId
pipelines ──(1:N)──> crawlSessions        via pipelineId
pipelines ──(1:N)──> intelligence         via pipelineId
pipelines ──(1:N)──> leads                via pipelineId
pipelines ──(1:N)──> feedbackSignals      via pipelineId
pipelines ──(N:1)──> connections          via connectionId on Pipeline

niches ──(1:N)──> leads                   via nicheId
niches ──(1:N)──> crawlSessions           via nicheId
niches ──(1:N)──> feedbackSignals         via nicheId

leads ──(1:1)──> pitchEvaluations         via leadId
leads ──(1:N)──> dispatchLogs             via leadId
leads ──(1:N)──> feedbackSignals          via leadId

crawlSessions ──(implicit 1:N)──> leads   via crawlSessionId on Lead
```

**Sandbox path routing** — `getLeadDocRef` in `lib/db/leads.ts` routes composite IDs transparently:

| ID Format                              | Firestore Path                                     |
| -------------------------------------- | -------------------------------------------------- |
| `{plainDocId}`                         | `leads/{plainDocId}`                               |
| `sandbox:{pipelineId}:{runId}:{docId}` | `leads/sandbox_{pipelineId}_{runId}/items/{docId}` |
| `sandbox:{docId}` _(legacy)_           | `leads/sandbox/leads/{docId}`                      |
| `sandbox_candidate:{docId}` _(legacy)_ | `leads/sandbox/leads/{docId}`                      |

---

## 9. Developer Workflow

### Environment Requirements

Copy `.env_example` to `.env.local` and populate the following:

| Variable                 | Purpose                         |
| ------------------------ | ------------------------------- |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase client config (Auth)   |
| `FIREBASE_CLIENT_EMAIL`  | Firebase Admin SDK              |
| `FIREBASE_PRIVATE_KEY`   | Firebase Admin SDK              |
| `GEMINI_API_KEY`         | Gemini LLM for all agents       |
| `FIRECRAWL_API_KEY`      | Website scraping                |
| `TAVILY_API_KEY`         | Semantic web search / discovery |
| `APIFY_TOKEN`            | Instagram KPI scraping          |
| `UNIPILE_TOKEN`          | Unipile API authentication      |
| `UNIPILE_BASE_URL`       | Unipile API base URL            |
| `BLOB_READ_WRITE_TOKEN`  | Vercel Blob for agent playbooks |
| `CRON_SECRET`            | Bearer token for cron endpoints |

### Running the App

```bash
yarn install            # Install dependencies
yarn dev                # Start Next.js development server
```

### Type Checking & Linting

```bash
yarn typecheck          # Run strict TypeScript validation
yarn lint               # Run ESLint
```
