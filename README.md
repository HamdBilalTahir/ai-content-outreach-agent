# AI Content Outreach Agent

An autonomous, multi-tenant AI outreach system that discovers, qualifies, and contacts brand leads across defined niches using intelligent scraping, visual content auditing, and automated WhatsApp dispatching.

Built on **Next.js 16 (App Router)** and **Firebase**, orchestrated via **LangGraph**, and powered by **Gemini 2.5/3.1** models.

## Features

- **Automated Crawl Strategy**: AI agents dynamically select niches to crawl based on historical close rates, gap scores, and product pricing.
- **Intelligent Prospecting Pipeline**:
  - Scrapes target websites via Firecrawl JS.
  - Audits brand Instagram profiles via Apify.
  - Evaluates brand visual content poverty using Gemini (`gemini-3.1-flash-live-preview`).
- **Targeted WhatsApp Dispatch**: Generates customized WhatsApp openers and automatically queues them for dispatch.
- **Continuous Feedback Loop**: Tracks response outcomes (Closed, Rejected, Ghosted) to adjust crawl priorities and blacklist poor targeting signals.
- **Admin Dashboard**: Full UI to configure niches, track pipeline leads, assess AI evaluation reasoning, and review dispatch logs.
- **Multi-Tenant Ready**: Integrates Firebase Authentication with secure Session Cookie parsing to maintain partitioned lead tracking.

## Architecture

Please review [Architecture.md](Architecture.md) for a comprehensive deep dive into the system's structure, database schemas, and AI pipeline layouts.

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19
- **Database / Auth**: Firebase Admin SDK & Firebase Auth
- **AI Models**: Google Gemini via `@langchain/google-genai`
- **Orchestration**: LangGraph (`@langchain/langgraph`)
- **Scraping Tools**: FireCrawl (`@mendable/firecrawl-js`) & Apify Client
- **Styling**: Tailwind CSS v4

## Getting Started

### Prerequisites

- Node.js ≥20
- Yarn package manager
- Firebase Project (Firestore + Authentication)
- API Keys for Google Gemini, Apify, and Firecrawl

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
   - `CRON_SECRET`
   - `WHATSAPP_WEBHOOK_URL` & `WHATSAPP_WEBHOOK_SECRET`

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
