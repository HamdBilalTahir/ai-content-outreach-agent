# Outbound admin UI port — plan of record

Replicating the six `Outbound` routes from `ui-admin-panel/app/admin/outbound/` into this repo, on top of
the outbound backend ported in `PORT-PLAN.md`.

Companion to `PORT-PLAN.md`, same ground rules, separate plan because this is a different kind of work:
that one ported logic with behaviour to preserve, this one ports an interface with a look to preserve.

## Scope

| Route                | Source lines | What it needs                              |
| -------------------- | ------------ | ------------------------------------------ |
| Campaigns (+ detail) | ~3,400       | ported backend ✅                          |
| Funnel               | ~2,030       | ported backend ✅ + `campaigns/[id]/chats` |
| Attribution Timeline | ~1,030       | ported backend ✅                          |
| E2E Test             | ~3,840       | chat-detail suite + 4 new routes           |
| Parked Test Chats    | ~10 + suite  | chat-detail suite + `park-chat`            |
| DNC Area Codes       | ~506         | ported backend ✅                          |

Plus, not visible as routes:

- **12 shadcn/ui primitives** (~744 lines) — `alert-dialog`, `badge`, `button`, `calendar`, `input`,
  `label`, `popover`, `sheet`, `skeleton`, `table`, `tabs`, `textarea`. The source imports them from
  `@/components/ui/new-york/ui/*`; only twelve of its thirty-nine are actually used.
- **`lib/utils.ts`** (196) and `lib/chat-utils.ts` (10).
- **The chat-detail suite** (~1,657 across 9 files) — `ChatDetailView`, `MessageBubble`, `TaskCard`,
  `StageFunnel`, `EmailBody`, `field-view`, `helpers`, `types`, `useComposerHistory`. Shared by E2E Test
  and Parked Test Chats.

**~14,500 lines.**

## Ground rules

Inherited from `PORT-PLAN.md`, plus three specific to a UI port.

- **One phase = one commit = one CHANGE-LOGS.md entry.** Verified before commit: `tsc --noEmit` clean,
  `eslint` clean, `next build` succeeds, existing Jest suites still green.
- **Nothing is stubbed.** A sidebar entry appears only when its route exists — the same rule the backend
  route table follows. A nav link to a 404 is the UI equivalent of a stubbed function.
- **The look is the spec.** Where the source's markup looks redundant, it is preserved. A UI port has no
  test that catches "this is now 4px off", so the diff is the only evidence, and rewriting markup to taste
  destroys it.
- **Fetch calls are repointed, not rewritten.** The source's URLs mostly match the ported backend's
  verbatim (Phase 10a preserved every path). Where they differ, the difference is recorded below rather
  than papered over with a rewrite of the calling component.

## Version gap — the substrate's real problem

|          | `ui-admin-panel` | here |
| -------- | ---------------- | ---- |
| Next     | 14               | 16   |
| React    | 18               | 19   |
| Tailwind | 3                | 4    |

React 18 → 19 is nearly free (`forwardRef` still works). Next 14 → 16 changes route-handler `params` to a
Promise, already handled in backend Phase 10a.

**Tailwind 3 → 4 is the risk.** The source declares the entire shadcn colour system in
`tailwind.config.ts` under `theme.extend.colors`, mapping `bg-background`, `text-muted-foreground`,
`border-border` and ~25 more onto `hsl(var(--token))` pairs. Tailwind 4 has no `tailwind.config.ts` — those
tokens must be declared as `@theme` custom properties in `globals.css`.

Get this wrong and nothing errors: `tsc` passes, the build passes, and every page renders with unstyled
elements because `bg-card` resolves to nothing. So the substrate phase migrates the tokens explicitly and
its verification is visual, not just green.

The source is also **dark-themed by a `.dark` class on the root**, which is where the screenshot's look
comes from. This repo's `globals.css` currently drives light/dark off `prefers-color-scheme`. The dark
token set has to come across and be applied deliberately, or the pages render light against a dark shell.

## The five missing endpoints

The admin panel calls these; the ported outbound app has no equivalent, because they are admin-panel
routes that read Firestore directly rather than proxying Django.

| Endpoint                  | Needed by                   |
| ------------------------- | --------------------------- |
| `campaigns/[id]/chats`    | Funnel's chat drawer        |
| `park-chat`               | Parked Test Chats, E2E Test |
| `trigger-ai`              | E2E Test                    |
| `opt-out`                 | E2E Test                    |
| `hubspot/contacts-by-ids` | Campaigns audience builder  |

One more differs rather than missing: the UI posts to `/api/outbound/initiate`, where the ported backend
mounts the same handler at `/api/outbound/webhook/initiate-outbound/`. Recorded as a repoint, not a new
route — the path the port preserved is the Django one, and the admin panel's proxy had its own shorter
name.

## Phases

| Phase | Scope                                             | Lines  | Commit |
| ----- | ------------------------------------------------- | ------ | ------ |
| U0    | Substrate: deps, 12 primitives, Tailwind-4 tokens | ~950   | —      |
|       | _verified with a real `next build`, not just tsc_ |        |        |
| U1    | DNC Area Codes                                    | ~506   | —      |
| U2a   | Campaigns list + detail                           | ~1,160 | —      |
| U2b   | The audience builder (7 components)               | ~2,240 | —      |
| U3    | Funnel + chats drawer + `campaigns/[id]/chats`    | ~2,100 | —      |
| U4    | Attribution Timeline                              | ~1,030 | —      |
| U5    | The chat-detail suite                             | ~1,657 | —      |
| U6    | E2E Test + its four routes                        | ~3,900 | —      |
| U7    | Parked Test Chats                                 | ~100   | —      |

**U1 first on purpose.** It is the smallest page, it is fully served by the ported backend, and it
exercises the whole stack — a primitive, a client component, a server page, a sidebar entry, and a live
call to a Phase 10c² route. If the Tailwind token migration is wrong, U1 is where it shows, on 506 lines
rather than 3,840.

**U5 before U6/U7** because both depend on the chat-detail suite; porting it inside U6 would bury 1,657
lines of shared code in the largest phase.

## Divergences from the source

Recorded here as they land.

- **`calendar.tsx` is adapted, not copied** (U0) — the only primitive that could not come across verbatim.
  The source pins `react-day-picker` v8, whose peer range stops at React 18; this repo is on React 19, so
  installing v8 would mean a version that does not support the runtime it renders into. v9 renamed every
  `classNames` part and collapsed the two icon components into one `Chevron`. The keys are translated and
  the Tailwind classes — the actual look — carried across unchanged; the full rename table is on the
  component so the next reader can diff it against a v8 shadcn calendar elsewhere.
- **`--background` / `--foreground` were already taken** (U0). This repo's `body` rule used those two names
  as HEX values flipped by `prefers-color-scheme`, and `bg-background` compiles to the first of them. The
  pre-existing pair is renamed `--app-background` / `--app-foreground` rather than overwritten, so the
  eight pre-existing admin pages keep the look they had. Nothing outside the ported components reads the
  shadcn scale, so the two coexist.
- **`import type * as React from 'react'` added where the source omits it** (U0). The source leans on the
  ambient `React` namespace for prop types; this repo's eslint flags that as `no-undef`. A one-line import
  per affected file, noted in place.
- **Only `cn` and `isArchivedChat` came from `lib/utils`** (U0). The source's is 196 lines of assorted
  helpers and the ported UI imports two of them. Same rule as the backend port: build what is used.

## Notes for later

- **This repo tracks two lockfiles** (`package-lock.json` and `yarn.lock`) and `vercel.json` declares no
  `installCommand`, so which one a deploy resolves against is Vercel's detection rather than a decision.
  U0 syncs both so the new dependencies are present either way, but the underlying ambiguity is worth
  settling — the `package-lock.json` in the tree arrived with backend Phase 0 and the repo was yarn before
  that.
- **`next-auth` is NOT ported.** The source's outbound pages import it for the session; this repo has its
  own auth (`src/app/AuthProvider.tsx`, `getAuthenticatedUserId`). Every page that reads a session gets
  repointed at this repo's helper as it lands, rather than pulling a second auth library in.
