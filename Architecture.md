# AI Content Outreach Agent — Comprehensive System Architecture

> **Purpose**: Deep-dive architecture document based on full codebase analysis. Use this as the blueprint for understanding the agent or extending it into further features.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [High-Level Architecture Diagram](#3-high-level-architecture-diagram)
4. [Project Structure](#4-project-structure)
5. [AI Agents & Pipeline Architecture](#5-ai-agents--pipeline-architecture)
6. [API & Cron Layer](#6-api--cron-layer)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [Database & Data Models](#8-database--data-models)
9. [Developer Workflow](#9-developer-workflow)

---

## 1. System Overview

This application is an **AI-driven Content Outreach Agent**. It automates the discovery, qualification, and outreach of brand leads across specific niches by evaluating their content (website & Instagram) and generating highly personalized pitch messages to be delivered via WhatsApp.

### What's Included Out of the Box

| Area                | Status   | Details                                                                     |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| Framework           | ✅ Ready | Next.js 16 with App Router + React 19                                       |
| AI Integration      | ✅ Ready | Gemini Models (`gemini-3.1-flash-live-preview`) via `@google/generative-ai` |
| Agent Orchestration | ✅ Ready | `@langchain/langgraph` for pipelined task execution                         |
| Web Scraping        | ✅ Ready | FireCrawl JS + Apify Client                                                 |
| Database            | ✅ Ready | Firebase Firestore                                                          |
| Authentication      | ✅ Ready | Firebase Auth (Client + Session Cookies)                                    |
| Styling             | ✅ Ready | Tailwind CSS v4 + dark mode                                                 |
| Testing             | ✅ Ready | Jest + React Testing Library                                                |

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

### Database & Auth

| Layer          | Technology                                        |
| -------------- | ------------------------------------------------- |
| Database       | Firebase Firestore (`firebase-admin`, `firebase`) |
| Authentication | Firebase Auth                                     |

### Styling & Code Quality

| Layer            | Technology          |
| ---------------- | ------------------- |
| CSS Framework    | Tailwind CSS v4     |
| Linter/Formatter | ESLint 9 + Prettier |
| Git Hooks        | Husky + lint-staged |

---

## 3. High-Level Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                    BROWSER                            │
│  React 19 + Next.js App Router (Admin Dashboard)     │
└──────────────────────────┬───────────────────────────┘
                           │ HTTP / Auth Token Cookies
┌──────────────────────────▼───────────────────────────┐
│            NEXT.JS SERVER (API & Cron Jobs)          │
│                                                       │
│  ┌─────────────────┐   ┌────────────────────────┐    │
│  │  Admin APIs      │   │  Cron API Routes       │    │
│  │  /api/admin/*    │   │  /api/cron/*           │    │
│  └────────┬────────┘   └──────────┬─────────────┘    │
│           │                       │                   │
│  ┌────────▼───────────────────────▼────────────┐     │
│  │                  AI Agents                  │     │
│  │ - Crawl Strategy (Gemini)                   │     │
│  │ - LangGraph Lead Pipeline (Scrape & Audit)  │     │
│  │ - Feedback Loop Agent                       │     │
│  └────────────────────────┬────────────────────┘     │
└───────────────────────────┼──────────────────────────┘
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
    ┌─────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
    │ Firestore  │  │  Firecrawl/  │  │ WhatsApp     │
    │ Database   │  │  Apify APIs  │  │ Webhook API  │
    └─────────────┘  └─────────────┘  └──────────────┘
```

---

## 4. Project Structure

```text
ai-content-outreach-agent/
│
├── lib/
│   ├── agents/                   # Core AI agents
│   │   ├── crawlStrategyAgent.ts # Decides what/where to crawl
│   │   └── feedbackLoopAgent.ts  # Optimizes strategy based on success
│   ├── db/                       # Firestore data access layer
│   │   ├── connections.ts
│   │   ├── crawlSessions.ts
│   │   ├── dispatchLogs.ts
│   │   ├── feedbackSignals.ts
│   │   ├── leads.ts
│   │   ├── niches.ts
│   │   ├── pitchEvaluations.ts
│   │   ├── settings.ts
│   │   └── userProfiles.ts
│   ├── firebase/                 # Firebase init & config
│   │   ├── admin.ts
│   │   └── client.ts
│   ├── pipeline/                 # LangGraph pipeline execution
│   │   └── runPipeline.ts
│   ├── services/                 # External service integrations
│   │   ├── autoprospector.ts
│   │   ├── geminiPitchGenerator.ts
│   │   ├── instagramAuditor.ts
│   │   ├── websiteScraper.ts
│   │   └── whatsappDispatcher.ts
│   ├── types/                    # TypeScript interfaces
│   │   └── index.ts
│   └── utils/
│       ├── auth.ts               # Auth & Cookie utilities
│       └── sanitizeImages.ts
│
├── src/
│   ├── app/                      # Next.js App Router root
│   │   ├── admin/                # Admin Dashboard Routes
│   │   ├── api/                  # API endpoints
│   │   ├── login/                # Authentication UI
│   │   ├── AuthProvider.tsx      # Context provider for user session
│   │   ├── globals.css           # Tailwind v4 import + CSS variables
│   │   ├── layout.tsx            # Root layout
│   │   └── page.tsx              # Index route (redirects to admin)
│   └── components/               # Reusable React components
│
├── .env_example                  # Environment variables template
├── next.config.ts                # Next.js config
├── tsconfig.json                 # TypeScript config
├── eslint.config.mjs             # ESLint flat config
├── jest.config.ts                # Jest config
└── package.json
```

---

## 5. AI Agents & Pipeline Architecture

The outreach system is composed of specialized AI agents working together in a pipeline:

### Crawl Strategy Agent (`crawlStrategyAgent.ts`)

- Utilizes the `gemini-3.1-flash-live-preview` model.
- Evaluates existing niches and previous feedback signals.
- Generates a strategic JSON output containing URLs and target signals to look for, prioritizing high-converting niches.

### The LangGraph Pipeline (`runPipeline.ts`)

A state-machine pipeline that processes each target:

1. **`scrapeWebsiteNode`**: Uses `websiteScraper.ts` (FireCrawl API) to gather website text, brand names, and images.
2. **`sanitizeImagesNode`**: Cleans image URLs.
3. **`auditInstagramNode`**: Uses `instagramAuditor.ts` (Apify Client) to fetch Instagram engagement and post stats.
4. **`generatePitchNode`**: Uses `geminiPitchGenerator.ts` to analyze the collected data and create a 1-10 "visual poverty" gap score and a targeted WhatsApp opener.
5. **`saveLeadNode`**: If the score is >= 8 and a WhatsApp number exists, it qualifies the lead and saves it to Firestore.

### Feedback Loop Agent (`feedbackLoopAgent.ts`)

- Analyzes closing rates, rejection notes, and gap scores.
- Updates the `crawlPriority` of niches and blacklists poor signals automatically.

---

## 6. API & Cron Layer

The application heavily relies on background execution and scheduled cron jobs.

### Cron Routes

Located in `src/app/api/cron/*`, these are secured using `CRON_SECRET` in the `Authorization: Bearer` header.

- **`GET /api/cron/crawl`**: Kicks off the `crawlStrategyAgent`, initiates auto-prospecting, and queues LangGraph pipelines in batches.
- **`GET /api/cron/dispatch`**: Checks qualified leads and calls `whatsappDispatcher.ts` to push WhatsApp messages via external webhooks.

### Admin Routes

Located in `src/app/api/admin/*`, these endpoints allow the frontend dashboard to trigger runs manually or manage database entities.

- Secured using Firebase ID Tokens passed as `auth_token` cookies, parsed by `lib/utils/auth.ts`.
- Endpoints: `/connections`, `/feedback`, `/feedback/run-loop`, `/niches`, `/settings`, `/run-crawl`, `/run-dispatch`.

---

## 7. Authentication & Authorization

Authentication is managed by Firebase.

1. The user logs in via `src/app/login/page.tsx` using Firebase Client SDK.
2. The `AuthProvider.tsx` context listens for auth state changes. On success, it extracts the Firebase ID token and stores it as an HTTP cookie (`auth_token`).
3. Server Components and API Routes extract this cookie and verify it using `adminAuth.verifyIdToken(token)` via the `getAuthenticatedUserId()` utility.
4. For automated cron jobs, `userId` context is extracted implicitly from the associated data models (e.g. `userId` saved on `Niche` objects) rather than relying on a logged-in session.

---

## 8. Database & Data Models

All data is stored in Firebase Firestore. The core models (defined in `lib/types/index.ts`) include:

- **`SystemSettings`**: Global system configs including cron schedules and concurrency limits.
- **`UserProfile`**: Basic profile data for authenticated users.
- **`Niche`**: The targeted market sector (e.g., "Roofers in Texas"), storing crawl priority, seed URLs, and historical analytics.
- **`CrawlSession`**: A single instance of an automated crawl agent run.
- **`Lead`**: Discovered brands that have been qualified, including their WhatsApp number, website, pitch angle, and processing status.
- **`PitchEvaluation`**: Comprehensive AI feedback about a lead's visual content poverty.
- **`DispatchLog`**: Audit trails for dispatched WhatsApp messages.
- **`FeedbackSignal`**: Manual or automated outcomes (Closed, Rejected, Ghosted) linked to a specific lead and niche.
- **`Connection`**: Integration settings for external dispatch services (e.g., WhatsApp Webhook configuration).

All data interactions are compartmentalized in `lib/db/*` accessor functions.

---

## 9. Developer Workflow

### Environment Requirements

You need Firebase Admin Credentials, Gemini API keys, FireCrawl API keys, and Apify API tokens configured in your `.env.local` to run the agent pipelines effectively.

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
