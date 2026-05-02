# NextJS Boilerplate — Comprehensive System Architecture

> **Purpose**: Deep-dive architecture document based on full codebase analysis. Use this as the blueprint for understanding the boilerplate or extending it into a full application.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [High-Level Architecture Diagram](#3-high-level-architecture-diagram)
4. [Project Structure](#4-project-structure)
5. [Rendering & Routing Architecture](#5-rendering--routing-architecture)
6. [Styling System](#6-styling-system)
7. [TypeScript Configuration](#7-typescript-configuration)
8. [Testing Architecture](#8-testing-architecture)
9. [Code Quality & Pre-commit Pipeline](#9-code-quality--pre-commit-pipeline)
10. [Build & Toolchain](#10-build--toolchain)
11. [State Management](#11-state-management)
12. [API Layer](#12-api-layer)
13. [Authentication & Authorization](#13-authentication--authorization)
14. [Database & Data Models](#14-database--data-models)
15. [Environment Configuration](#15-environment-configuration)
16. [CI/CD](#16-cicd)
17. [Developer Workflow](#17-developer-workflow)

---

## 1. System Overview

This is a **minimal, production-ready Next.js boilerplate** pre-configured with modern tooling so teams can skip setup and go straight to building features.

### What's Included Out of the Box

| Area | Status | Details |
|------|--------|---------|
| Framework | ✅ Ready | Next.js 16 with App Router + React 19 |
| Language | ✅ Ready | TypeScript (strict mode) |
| Styling | ✅ Ready | Tailwind CSS v4 + dark mode |
| Linting | ✅ Ready | ESLint 9 with Next.js + TypeScript rules |
| Formatting | ✅ Ready | Prettier with opinionated defaults |
| Testing | ✅ Ready | Jest 30 + React Testing Library |
| Git Hooks | ✅ Ready | Husky + lint-staged pre-commit pipeline |
| React Compiler | ✅ Ready | Babel React Compiler (auto-memoization) |
| Fonts | ✅ Ready | Geist Sans + Geist Mono via next/font |
| State Management | TBD | — |
| API Routes | TBD | — |
| Authentication | TBD | — |
| Database | TBD | — |
| CI/CD | TBD | — |

### Core Architectural Characteristics

| Property | Value |
|----------|-------|
| Rendering | Next.js App Router (RSC-first) |
| Package Manager | Yarn |
| Language | TypeScript (strict) |
| CSS Engine | Tailwind CSS v4 via PostCSS |
| Testing | Jest 30 + jsdom + Testing Library |
| Compiler | Babel + React Compiler (auto-memoization) |
| Path Alias | `@/*` → `./src/*` |
| Deployment Target | Vercel (default), any Node.js host |

---

## 2. Technology Stack

### Framework & Runtime
| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 16.1.6 |
| UI Library | React | 19.2.3 |
| Language | TypeScript | ^5 |
| Runtime | Node.js | ≥20 |

### Styling
| Layer | Technology | Version |
|-------|-----------|---------|
| CSS Framework | Tailwind CSS | ^4 |
| PostCSS Plugin | @tailwindcss/postcss | ^4 |
| Fonts | Geist Sans + Geist Mono | via next/font/google |

### Testing
| Layer | Technology | Version |
|-------|-----------|---------|
| Test Runner | Jest | ^30.3.0 |
| DOM Environment | jest-environment-jsdom | ^30.3.0 |
| Component Testing | @testing-library/react | ^16.3.2 |
| DOM Assertions | @testing-library/jest-dom | ^6.9.1 |
| TS Transform | ts-jest | ^29.4.6 |

### Code Quality
| Layer | Technology | Version |
|-------|-----------|---------|
| Linter | ESLint | ^9 |
| Next.js Rules | eslint-config-next | 16.1.6 |
| Formatter | Prettier | ^3.8.1 |
| Prettier ESLint Bridge | eslint-plugin-prettier | ^5.5.5 |
| Git Hooks | Husky | ^9.1.7 |
| Staged File Runner | lint-staged | ^16.3.3 |

### Compiler
| Layer | Technology | Version |
|-------|-----------|---------|
| React Compiler | babel-plugin-react-compiler | 1.0.0 |

### State Management
| Layer | Technology | Version |
|-------|-----------|---------|
| TBD | — | — |

### Database / ORM
| Layer | Technology | Version |
|-------|-----------|---------|
| TBD | — | — |

### Authentication
| Layer | Technology | Version |
|-------|-----------|---------|
| TBD | — | — |

---

## 3. High-Level Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                    BROWSER                            │
│  React 19 + Next.js App Router (RSC + Client Comps)  │
└──────────────────────────┬───────────────────────────┘
                           │ HTTP
┌──────────────────────────▼───────────────────────────┐
│            NEXT.JS SERVER (Vercel Serverless)         │
│                                                       │
│  ┌─────────────────┐   ┌────────────────────────┐    │
│  │  App Router      │   │  API Routes  (TBD)     │    │
│  │  (RSC pages +   │   │  /app/api/*             │    │
│  │   layouts)      │   │                         │    │
│  └────────┬────────┘   └────────────────────────┘    │
│           │                                           │
│  ┌────────▼────────────────────────────────────┐     │
│  │  next/font  │  next/image  │  Metadata API  │     │
│  └─────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┼──────────────────┐
         │                 │                  │
   ┌─────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
   │  DB layer   │  │  Auth layer  │  │  3rd-party   │
   │   (TBD)     │  │   (TBD)      │  │  APIs (TBD)  │
   └─────────────┘  └─────────────┘  └──────────────┘
```

---

## 4. Project Structure

```
NextJS-Boilerplate-Repo/
│
├── src/
│   └── app/                         # Next.js App Router root
│       ├── layout.tsx               # Root layout (HTML shell, fonts, metadata)
│       ├── page.tsx                 # Home route "/"
│       ├── page.test.tsx            # Unit test for home page
│       ├── globals.css              # Tailwind v4 import + CSS variables
│       └── favicon.ico
│
├── public/                          # Static assets (served at root URL)
│   ├── next.svg
│   ├── vercel.svg
│   ├── file.svg
│   ├── globe.svg
│   └── window.svg
│
├── .husky/
│   └── pre-commit                   # Runs typecheck + lint-staged on commit
│
├── next.config.ts                   # Next.js config (React Compiler enabled)
├── tsconfig.json                    # TypeScript config (strict, @/* alias)
├── postcss.config.mjs               # PostCSS config (Tailwind v4)
├── eslint.config.mjs                # ESLint flat config (ESLint 9)
├── .prettierrc                      # Prettier config
├── .lintstagedrc.json               # lint-staged config
├── jest.config.ts                   # Jest config (next/jest + jsdom)
├── jest.setup.ts                    # Jest global setup (@testing-library/jest-dom)
├── Makefile                         # Developer convenience commands
├── .env_example                     # Environment variable template (empty)
├── CHANGE-LOGS.md                   # Changelog
├── README.md
└── package.json
```

### Planned Structure (TBD — fill in as layers are added)

```
src/
├── app/                    # Next.js App Router (routes only)
│   ├── (auth)/             # TBD — Route group: auth pages
│   ├── (dashboard)/        # TBD — Route group: protected pages
│   └── api/                # TBD — API routes
├── components/
│   ├── ui/                 # TBD — Primitive UI components
│   └── features/           # TBD — Feature-specific components
├── lib/
│   ├── db.ts               # TBD — Database client
│   ├── auth.ts             # TBD — Auth config
│   └── utils.ts            # TBD — Shared utilities
├── hooks/                  # TBD — Custom React hooks
├── types/                  # TBD — Shared TypeScript types
└── store/                  # TBD — Client-side state
```

### Path Alias

```
@/* → ./src/*
```

---

## 5. Rendering & Routing Architecture

### App Router Model

This boilerplate uses the **Next.js App Router** exclusively. Key conventions:

| File | Purpose | Status |
|------|---------|--------|
| `layout.tsx` | Wraps children — persistent across navigations | ✅ exists at `src/app/layout.tsx` |
| `page.tsx` | Defines a route — rendered inside the nearest layout | ✅ exists at `src/app/page.tsx` |
| `loading.tsx` | Suspense boundary loading UI | TBD |
| `error.tsx` | Error boundary UI | TBD |
| `not-found.tsx` | 404 UI | TBD |
| `route.ts` | API endpoint | TBD |
| `middleware.ts` | Edge middleware (auth guards, redirects) | TBD |

### Server vs Client Components

By default, all components in `app/` are **React Server Components (RSC)**. To opt into client rendering:

```typescript
'use client'  // Add at top of file
```

**Rule of thumb**:
- Server Components: data fetching, layouts, static UI, SEO-sensitive content
- Client Components: interactivity, browser APIs, state, event handlers

### Root Layout

[src/app/layout.tsx](src/app/layout.tsx) sets up:
- `<html lang="en">` shell
- Geist Sans + Geist Mono fonts via `next/font/google` (zero-layout-shift, self-hosted)
- CSS variables injected via font `.variable` classes
- `antialiased` Tailwind class on `<body>`
- Default metadata (title + description)

---

## 6. Styling System

### Tailwind CSS v4

This boilerplate uses **Tailwind CSS v4** — a significant architectural shift from v3:

| Change | v3 | v4 |
|--------|----|----|
| Config file | `tailwind.config.js` | None needed (CSS-first) |
| PostCSS plugin | `tailwindcss` | `@tailwindcss/postcss` |
| Import in CSS | `@tailwind base/components/utilities` | `@import 'tailwindcss'` |
| Theme extension | JS config | `@theme` CSS block |

### CSS Variables & Dark Mode

[src/app/globals.css](src/app/globals.css):

```css
@import 'tailwindcss';

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}
```

Dark mode is handled via `prefers-color-scheme` media query — no class toggling needed by default.

### Font Setup

Fonts are loaded in [src/app/layout.tsx](src/app/layout.tsx) via `next/font/google`:
```typescript
const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })
```

These CSS variables are exposed via `@theme inline` in globals.css, making `font-sans` and `font-mono` Tailwind utilities resolve to the loaded fonts automatically.

---

## 7. TypeScript Configuration

[tsconfig.json](tsconfig.json) key settings:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "strict": true,
    "moduleResolution": "bundler",
    "paths": { "@/*": ["./src/*"] }
  }
}
```

| Setting | Value | Why |
|---------|-------|-----|
| `strict` | `true` | Full strict mode: null checks, no implicit any, etc. |
| `moduleResolution` | `bundler` | Modern resolution for bundlers (Next.js/webpack) |
| `noEmit` | `true` | TypeScript only for type checking; Next.js handles emit |
| `target` | `ES2017` | Broad browser compatibility baseline |
| `isolatedModules` | `true` | Required for transpile-only transforms (SWC, ts-jest) |
| `incremental` | `true` | Faster subsequent type checks |

---

## 8. Testing Architecture

### Stack

```
Jest 30 (test runner)
  └── next/jest (Next.js integration — auto-handles RSC, SWC, env)
       └── jsdom (browser DOM simulation)
            └── @testing-library/react (component rendering)
                 └── @testing-library/jest-dom (custom matchers)
```

### Configuration

[jest.config.ts](jest.config.ts):
```typescript
const createJestConfig = nextJest({ dir: './' })  // Picks up next.config.ts + .env

const config: Config = {
  coverageProvider: 'v8',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
}
```

[jest.setup.ts](jest.setup.ts):
```typescript
import '@testing-library/jest-dom'  // Extends expect() with .toBeInTheDocument(), etc.
```

### Writing Tests

Test files are co-located with the files they test (e.g., `page.test.tsx` beside `page.tsx`).

```typescript
// src/app/page.test.tsx — existing example
import { render } from '@testing-library/react'
import Home from './page'

describe('Home', () => {
  it('renders without crashing', () => {
    const { container } = render(<Home />)
    expect(container).toBeInTheDocument()
  })
})
```

Run tests:
```bash
yarn test           # Run all tests
yarn test --watch   # Watch mode
make test           # Via Makefile
```

---

## 9. Code Quality & Pre-commit Pipeline

### The Pre-commit Flow

Every `git commit` triggers:

```
git commit
     ↓
.husky/pre-commit runs:
     ↓
1. npm run typecheck (tsc --noEmit)
   → Fails commit if TypeScript errors found
     ↓
2. npx lint-staged
   → On staged *.{js,jsx,ts,tsx}: eslint --fix, prettier --write
   → On staged *.{json,md,css,scss}: prettier --write
   → Re-stages fixed files automatically
     ↓
Commit created (or aborted on error)
```

### ESLint Configuration

[eslint.config.mjs](eslint.config.mjs) (ESLint 9 flat config):

| Rule Set | What It Enforces |
|----------|-----------------|
| `js.configs.recommended` | Standard JS best practices |
| `@next/next` recommended | Next.js-specific rules (Image, Link, etc.) |
| `@next/next` core-web-vitals | Performance-critical rules |
| `@typescript-eslint/no-unused-vars` | Error on unused variables |
| `no-unused-vars: off` | Disabled in favor of TS version |

### Prettier Configuration

[.prettierrc](.prettierrc):
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

---

## 10. Build & Toolchain

### React Compiler

[next.config.ts](next.config.ts):
```typescript
const nextConfig: NextConfig = {
  reactCompiler: true,
}
```

The React Compiler (via `babel-plugin-react-compiler`) automatically applies memoization at compile time — no need to manually write `useMemo` / `useCallback` for performance.

### Build Scripts

```bash
yarn dev       # Start dev server (Next.js fast refresh)
yarn build     # Production build (next build)
yarn start     # Start production server (next start)
yarn lint      # Run ESLint
yarn test      # Run Jest
yarn typecheck # TypeScript type check (no emit)
```

### Makefile Commands

```bash
make help              # Show all commands
make lint              # ESLint with --fix
make format            # Prettier format
make check             # Lint + format (CI-safe, no --fix)
make test              # Jest
make install-hooks     # Install Husky hooks
make frontend-install  # yarn install
make frontend-dev      # yarn dev
make frontend-build    # yarn build
```

---

## 11. State Management

> **TBD** — No state management library is currently installed.
>
> When added, document here:
> - Library chosen and version
> - Store structure / atom layout
> - Where stores live (`src/store/` or `src/lib/store/`)
> - Which state is global vs local vs server

---

## 12. API Layer

> **TBD** — No API routes exist yet (`src/app/api/` does not exist).
>
> When added, document here:
> - Route map (method + path + purpose)
> - Request/response shapes
> - Validation library used (e.g. Zod)
> - Error response format
> - Auth middleware applied to routes

---

## 13. Authentication & Authorization

> **TBD** — No authentication is configured.
>
> When added, document here:
> - Auth library and version
> - Sign-in methods (email/password, OAuth providers, magic link, etc.)
> - Session strategy (JWT vs database sessions)
> - Protected route mechanism (middleware, layout guards)
> - Role/permission model if applicable

---

## 14. Database & Data Models

> **TBD** — No database is configured.
>
> When added, document here:
> - Database engine and hosting (e.g. PostgreSQL on Neon)
> - ORM / query builder and version
> - Schema file locations
> - Migration strategy
> - Key data models / tables with field descriptions

---

## 15. Environment Configuration

[.env_example](.env_example) is currently empty.

### Environment Variable Conventions

| Prefix | Exposed To | Use For |
|--------|-----------|---------|
| `NEXT_PUBLIC_` | Browser + Server | Non-sensitive config (app URL, feature flags) |
| _(no prefix)_ | Server only | Secrets, API keys, DB credentials |

**Never prefix secrets with `NEXT_PUBLIC_`** — they will be bundled into client JavaScript.

### Variables (TBD — populate as integrations are added)

```bash
# App
NEXT_PUBLIC_APP_URL=    # TBD

# Database
DATABASE_URL=           # TBD

# Auth
AUTH_SECRET=            # TBD

# External APIs
# TBD
```

---

## 16. CI/CD

> **TBD** — No CI/CD pipeline is configured (no `vercel.json`, no `.github/workflows/`).
>
> When added, document here:
> - CI provider (GitHub Actions, etc.)
> - Pipeline stages (lint → typecheck → test → build → deploy)
> - Environment promotion strategy (preview → production)
> - Secrets management

---

## 17. Developer Workflow

### First-time Setup

```bash
git clone <repo>
cd NextJS-Boilerplate-Repo
yarn install            # Install dependencies
make install-hooks      # Install Husky git hooks (runs once)
cp .env_example .env.local  # Set up environment
yarn dev                # Start development server → http://localhost:3000
```

### Day-to-day

```bash
yarn dev                # Dev server
yarn test --watch       # Tests in watch mode (while coding)
git add <files>
git commit -m "feat: ..."  # Pre-commit hook auto-runs typecheck + lint + format
```

### Before Merging

```bash
yarn typecheck          # Confirm no TS errors
make check              # ESLint + Prettier (no auto-fix, good for CI)
yarn test               # Full test suite
yarn build              # Confirm production build succeeds
```
