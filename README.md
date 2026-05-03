# AI Content Outreach Agent

An autonomous, multi-tenant AI outreach system that discovers, qualifies, and contacts brand leads across defined niches using intelligent scraping, visual content auditing, and automated WhatsApp dispatching.

Built on **Next.js 16 (App Router)** and **Firebase**, orchestrated via **LangGraph**, and powered by **Gemini 2.5/3.1** models.

## Features

- **Multi-Pipeline Architecture**: Manage multiple, independent autonomous workflows safely. Each pipeline runs in isolation, avoiding target collisions through a global deduplication engine.
- **Intelligent Prospecting Pipeline**:
  - Scrapes target websites via Firecrawl JS.
  - Audits brand Instagram profiles via Apify.
  - Evaluates brand visual content poverty using Gemini (`gemini-3.1-pro-preview`).
- **Autonomous Playbooks (Simple RAG)**: The AI agents (Strategist, Scraper, Auditor, Copywriter) consult raw Markdown Playbooks stored in Vercel Blob before taking action.
- **Sandbox Training Environment**: Test pipelines safely inside a manual diagnostic UI. Human interactions (like explicitly rejecting targets or modifying drafted text) are stored in an isolated Quarantine Zone. At the end of the run, a Learner Agent synthesizes these implicit human signals and physically rewrites the Markdown Playbooks, enabling organic AI adaptation without manual tuning.
- **Continuous Feedback Loop**: Tracks real-world CRM outcomes (Closed, Rejected, Ghosted) to continuously hardcode Niche priority adjustments and build market-specific blacklists via the Data Scientist Feedback Loop agent.
- **Targeted WhatsApp Dispatch**: Features native integration with Unipile. Automatically provisions hosted WhatsApp connections and manages dynamic, throttled payload dispatching.
- **Global Guardrails**: Centrally managed API keys and automated Niche-level throttle caps ensure API cost protection and minimum pitch quality thresholds.

## Architecture

Please review [Architecture.md](Architecture.md) for a comprehensive deep dive into the system's structure, multi-pipeline containment logic, and AI module relations.

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19
- **Database / Auth**: Firebase Admin SDK & Firebase Auth
- **Memory Storage**: Vercel Blob (`@vercel/blob`)
- **AI Models**: Google Gemini via `@langchain/google-genai`
- **Orchestration**: LangGraph (`@langchain/langgraph`)
- **Scraping Tools**: FireCrawl (`@mendable/firecrawl-js`) & Apify Client
- **Messaging Integration**: Unipile API
- **Styling**: Tailwind CSS v4

## Getting Started

### Prerequisites

- Node.js ≥20
- Yarn package manager
- Firebase Project (Firestore + Authentication)
- API Keys for Google Gemini, Apify, Firecrawl, Unipile, and Vercel Blob Read/Write tokens.

### Environment Setup

1. Copy the example environment file:
   ```bash
   cp .env_example .env.local
   ```
2. Fill in all required keys in `.env.local`:
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`
   - `GEMINI_API_KEY`
   - `FIRECRAWL_API_KEY`
   - `APIFY_API_TOKEN`
   - `UNIPILE_API_KEY` & `UNIPILE_DSN`
   - `BLOB_READ_WRITE_TOKEN`
   - `CRON_SECRET`

### Installation & Execution

```bash
yarn install
yarn dev
```

The application will start at `http://localhost:3000`, automatically redirecting to the `/login` portal.

### Code Quality & Maintenance

We enforce strict TypeScript configurations and automated linting.

```bash
yarn typecheck   # Type checking via tsc
yarn lint        # Lint files
yarn test        # Run Jest testing suite
```
