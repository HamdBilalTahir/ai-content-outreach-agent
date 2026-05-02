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
8. [Database & Data Models](#8-database--data-models)
9. [Developer Workflow](#9-developer-workflow)

---

## 1. System Overview

This application is an **AI-driven Content Outreach Agent**. It automates the discovery, qualification, and outreach of brand leads across specific niches by evaluating their content (website & Instagram) and generating highly personalized pitch messages to be delivered via WhatsApp. It is built as a multi-tenant, multi-pipeline system, allowing an "Overseer" to run fully automated parallel campaigns and test isolated strategies safely.

### What's Included Out of the Box

| Area                | Status   | Details                                                                     |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| Framework           | ✅ Ready | Next.js 16 with App Router + React 19                                       |
| AI Integration      | ✅ Ready | Gemini Models (`gemini-3.1-flash-live-preview`) via `@google/generative-ai` |
| Agent Orchestration | ✅ Ready | `@langchain/langgraph` for pipelined task execution                         |
| Web Scraping        | ✅ Ready | FireCrawl JS + Apify Client                                                 |
| Messaging           | ✅ Ready | Unipile Integration for WhatsApp Dispatch                                   |
| Database            | ✅ Ready | Firebase Firestore                                                          |
| Memory Bank         | ✅ Ready | Vercel Blob for Markdown Playbooks (Simple RAG)                             |
| Authentication      | ✅ Ready | Firebase Auth (Email/Password & Magic Link)                                 |
| Styling             | ✅ Ready | Tailwind CSS v4 + dark mode                                                 |

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

| Layer               | Technology                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Main LLM            | Gemini (`gemini-3.1-flash-live-preview`) via `@google/generative-ai` & `@langchain/google-genai` |
| Agent Orchestration | `@langchain/langgraph`                                                                           |
| Web Scraping        | `@mendable/firecrawl-js`, `apify-client`                                                         |
| Integrations        | Unipile (WhatsApp), Vercel Blob (Playbooks)                                                      |

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
    └─────────────┘   └────────────────┘   │  Firecrawl)    │
                                           └────────────────┘
```

---

## 4. Project Structure & Module Relations

```text
ai-content-outreach-agent/
│
├── lib/
│   ├── agents/                   # Core AI agents (Brain of the system)
│   │   ├── crawlStrategyAgent.ts # (Cron/Manual) Plans crawl targets per Niche. Uses Strategist playbook.
│   │   ├── feedbackLoopAgent.ts  # (Cron/Manual) Tunes global niche priorities and updates database metrics.
│   │   └── learnerAgent.ts       # (Sandbox End-of-Run) Analyzes human edits/rejections to rewrite blob playbooks.
│   ├── db/                       # Firestore data access layer (DAL)
│   │   ├── connections.ts        # Maps Unipile integration accounts
│   │   ├── crawlSessions.ts      # Automated run logs and sandbox routing
│   │   ├── intelligence.ts       # Registry mapping pipelines to Vercel Blob Playbooks
│   │   ├── leads.ts              # Stores both pristine leads and isolated sandbox candidates
│   │   ├── niches.ts             # Target market data
│   │   ├── pipelines.ts          # Central isolated workflow containers
│   │   ├── settings.ts           # Global integration API keys & execution flags
│   │   └── userProfiles.ts       # Multi-tenant auth records
│   ├── pipeline/                 # The LangGraph Orchestrator
│   │   └── runPipeline.ts        # Plugs Scraper -> Auditor -> Evaluator -> DB. Skips DB globally if isSandbox=true.
│   ├── services/                 # External service wrappers
│   │   ├── autoprospector.ts     # Mass-discovery from Google searches
│   │   ├── blobStorage.ts        # Vercel Blob read/write/delete (Memory Bank)
│   │   ├── geminiPitchGenerator.ts # Generates the payload text
│   │   ├── instagramAuditor.ts   # Apify wrapper
│   │   ├── unipile.ts            # Unipile connect link generator
│   │   ├── websiteScraper.ts     # Firecrawl wrapper
│   │   └── whatsappDispatcher.ts # WhatsApp sending and throttling
│   └── types/                    # Shared TypeScript interfaces
│
├── src/
│   ├── app/
│   │   ├── admin/                # Frontend Modules
│   │   │   ├── connections/      # Global WhatsApp connection management
│   │   │   ├── intelligence/     # Intelligence Hub (Reading Blob Playbooks)
│   │   │   ├── leads/            # Pristine global CRM with inline feedback teaching
│   │   │   ├── niches/           # Config and AI strategy note hub
│   │   │   ├── pipelines/        # Pipeline orchestration control room
│   │   │   ├── sessions/         # The Sandbox Diagnostics workspace (ManualTriggers)
│   │   │   └── settings/         # API key and guardrail management
│   │   ├── api/
│   │   │   ├── admin/            # Authorized management hooks (synthesize-run, dispatch-manual, run-crawl)
│   │   │   ├── auth/             # Firebase session auth
│   │   │   ├── cron/             # Scheduled tasks (health, dispatch, crawl)
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
2. **Scraper Node**: (`The Web Scraper`) Uses Firecrawl to pull website DOMs and structured contact data.
3. **Auditor Node**: (`The Social Auditor`) Uses Apify to pull Instagram KPIs.
4. **Generator Node**: (`The Copywriter` & `Lead Analyst`) Pushes sanitized data through Gemini to calculate a 1-10 "Visual Poverty Gap Score" and writes the final WhatsApp pitch, referencing the Copywriter Playbook.
5. **Persistence Node**: Routes outputs to the Database. If it's a Sandbox Run, it segregates the target into an isolated `sandbox_candidates` subcollection.

### 3. Learner Agent (`learnerAgent.ts`)

- **Role**: The Memory Synthesizer.
- **Process**: At the end of a Sandbox Run, it analyzes a batch payload of explicit human actions (what leads were approved, what leads were rejected, and how the human explicitly edited the drafted text). It rewrites the underlying Markdown Playbook files hosted in Vercel Blob and re-registers the updated versions, allowing the AI to organically adapt without complex ML fine-tuning.

### 4. Feedback Loop Agent (`feedbackLoopAgent.ts`)

- **Role**: The Data Scientist.
- **Process**: Sweeps manual feedback signals (Closed, Rejected, Ghosted) logged from the CRM to hardcode Niche priority values and expand Niche-level blacklists algorithmically.

---

## 6. Data Hierarchy & Multi-Pipeline Structure

The application supports multiple concurrent "Pipelines". Each Pipeline acts as an isolated container to test different market segments safely.

### The Sandbox Quarantine Zone

A Sandbox run operates entirely manually and is disconnected from automated chron jobs.

1. **Initialization**: Starting a Sandbox run seamlessly initializes a new Pipeline.
2. **Quarantine Write**: Targets found during the run are stored safely in an isolated subcollection (`pipelines/{pipelineId}/sandbox_runs/{runId}/sandbox_candidates`). They do not pollute the main CRM (`leads`).
3. **Promotion**: When the Overseer clicks "Dispatch" on a Lead Card from the Sandbox Tray, the `dispatch-manual` endpoint promotes the Sandbox Candidate out of quarantine by copying its data into a pristine global `leads` document, and explicitly firing the WhatsApp payload.
4. **Junk Retention**: Ignored or explicitly rejected sandbox candidates stay permanently in quarantine so that the `synthesize-run` endpoint can securely read them to teach the Learner Agent what the human decided to avoid.

---

## 7. API, Webhooks & Integrations

- **Unipile Integration**: WhatsApp connectivity is managed natively using Unipile hosted links. The system checks connection health via a `/api/cron/health` daemon to flag invalid sessions. The `whatsappDispatcher` executes outbound REST calls securely through Unipile's engine.
- **Simple RAG via Vercel Blob**: Instead of bloated vector databases, the intelligence "Playbooks" for the AI personas are just raw Markdown files stored in Vercel Blob. These are fetched inline during runtime and passed directly into the agent prompt context.

---

## 8. Database & Data Models

All structured entity data is stored in Firebase Firestore using a multi-tenant design pattern (requiring a `userId`).

- **`SystemSettings`**: Global AI integrations (API keys) and pipeline guardrails (dispatch batch sizes, concurrency limits).
- **`UserProfile`**: Auth-linked identity contexts.
- **`Pipeline`**: The primary organizational container.
- **`Niche`**: Structured market definitions tied to a specific Pipeline.
- **`IntelligenceRegistry`**: Map routing Pipeline/Agent permutations to their live Vercel Blob playbooks.
- **`Lead`**: Promoted, fully-qualified targets ready for or processed by the dispatch worker.
- **`Connection`**: External session tracking (Unipile IDs, statuses).

---

## 9. Developer Workflow

### Environment Requirements

You need Firebase Admin Credentials, Gemini API keys, FireCrawl API keys, Vercel Blob Read/Write tokens, and Unipile API access configured in your `.env.local`.

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
