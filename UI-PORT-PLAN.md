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

| Phase | Scope                                             | Lines  | Commit    |
| ----- | ------------------------------------------------- | ------ | --------- |
| U0    | Substrate: deps, 12 primitives, Tailwind-4 tokens | ~950   | `65f7b26` |
| U1    | DNC Area Codes                                    | ~506   | `d698629` |
| U2    | The chat-detail suite (15 files)                  | ~2,741 | `af9a501` |
| U3    | Campaigns (list, detail, audience builder)        | ~3,400 | `2daba4c` |
| U4    | Funnel + chats drawer + `campaigns/[id]/chats`    | ~2,264 | `dac2b8e` |
| U5    | Attribution Timeline                              | ~1,127 | `f0006d3` |
| U6a   | E2E Test's nine API routes                        | ~709   | `8b4a2a6` |
| U6b   | E2E Test page + client (one 3,829-line file)      | ~3,868 | —         |
| U7    | Parked Test Chats                                 | ~100   | —         |

**~15,600 lines**, revised up from the first estimate — see revision 1.

## Plan revisions

1. **The chat-detail suite moved from U5 to U2, and it is 2,741 lines rather than 1,657.** Reading
   `CampaignDetailClient` before starting the campaigns phase showed it imports `ChatDetailView` and
   `ChatContactList`, so campaigns cannot land before the suite does. The suite is also **15 files, not
   9** — the first count came from the four modules the pages import by name and missed the nine those
   import in turn (`AccordionSection`, `ActivityCard`, `AiComposer`, `AudioPlayer`,
   `CallTranscriptModal`, and the rest).

   Same shape as backend revision 5: a phase blocked by a phase that comes after it, and the fix is to
   re-sequence rather than stub. Campaigns became U3a/U3b/U3c, and the list is split from the detail
   because only the detail needs the suite.

2. **Campaigns is ONE phase, not three — and the source repo is live.** Two findings, from mapping the
   campaigns import graph before starting rather than during.

   The split does not exist: `CampaignsClient` (the list) imports `NewCampaignSheet`, which imports all
   five audience tabs, which import `AudiencePreview`, `SearchableSelect`, and the three helper modules.
   The list alone pulls in essentially the whole tree, so U3a/U3b/U3c collapse into **U3**. Same reasoning
   as keeping the chat-detail suite whole: a split that ships a broken intermediate is not a split.

   More importantly, **`ui-admin-panel` is being edited while this port runs, including uncommitted
   working-tree changes.** Its HEAD moved to `b6fe7ee` (2026-08-05, "move entire Skills data layer to
   Admin SDK") mid-phase, and four files in scope carry ` M` status —
   `campaigns/shared.tsx`, `AttributionTimelineClient`, `FunnelChatsDrawer`, `FunnelDashboardClient` —
   while `app/api/outbound/{agents,attribution,funnel}/` are untracked entirely.

   This is backend revision 9 recurring, one degree worse: not just a moving HEAD but a dirty tree, so the
   snapshot being ported **cannot be reproduced from git**. Porting continues against the working tree —
   it is the live source of truth and the uncommitted changes are real improvements — but every phase
   re-surveys its own files first, and the divergence list records what was taken.

3. **E2E Test needs NINE endpoints, not four, so U6 splits in two.** The survey at U6 found the client
   references twelve API paths. Three are already served — `agents/list` and `outbound/agents` from U3, and
   `hubspot/delete-records` through the catch-all — leaving eight to write plus one to repoint
   (`outbound/initiate`, which the backend mounts at `webhook/initiate-outbound/`).

   The missing eight: `voice-workers/transcript`, `trigger-ai`, `runs`, `park-chat`, `opt-out`,
   `agents/has-outbound-skill`, `elevenlabs/conversations`, `admin/monitoring/chat` — 709 lines together.
   With the 3,868-line page and client that is ~4,577 for one phase, so **U6a** takes the routes and
   **U6b** the client. The client is a single 3,829-line file and cannot be split; the routes can be
   probed live on their own, which makes them the better first half.

   **This is the fourth phase where my endpoint estimate was low**, and the cause is consistent: estimating
   from the plan's original survey instead of re-surveying the phase's own files. The habit is now in place
   — this count came from a fresh multi-line-aware grep — but the plan's numbers should be read as
   provisional until each phase re-checks them.

4. **The Funnel and Attribution Timeline no longer call the Django analytics endpoints.** The re-survey
   at U3 found they now fetch `/api/outbound/funnel/chat-counts`, `/api/outbound/funnel/drill`, and
   `/api/outbound/attribution/*` — new, untracked routes that read Firestore directly through the Admin
   SDK, replacing `analytics/deal-funnel` and `analytics/deal-timeline`.

   Consequence worth stating plainly: **backend phases 10d¹ and 10d³ ported views the UI has since stopped
   using.** They are still correct and still mounted, but U4/U5 will port the Firestore-direct routes the
   UI actually calls rather than repointing it back at the Django-shaped ones. The endpoint table above is
   re-surveyed at U4.

   **Corrected twice — this was wrong in both halves.** At U4: the funnel did not stop calling
   `analytics/deal-funnel`; it ADDED `funnel/chat-counts` alongside it. At U5: the Attribution Timeline
   calls **both** `analytics/deal-timeline` and `analytics/deal-funnel`. So **neither 10d¹ nor 10d³ is dead
   code** — both are live, verified by live probe. The original claim came from a grep that missed every
   multi-line `fetch(` call, which is the actual lesson.

   The U4 half, for the record: The funnel did not stop calling `analytics/deal-funnel`; it
   ADDED `funnel/chat-counts` alongside it. The two halves of the dashboard have different sources: the
   chat-stage columns (New/Contacted/Engaged/Lost) count Firestore chats, while the deal-stage columns
   still come from the ported `dealFunnelView`. So **backend phase 10d¹ is used after all** — verified live,
   `/api/outbound/analytics/deal-funnel` returns its 400-for-missing-`agent_id` through the route table.
   Settled at U5: 10d³ is used too.

   The lesson stands even though the conclusion narrowed: a grep for `fetch('/api/...` missed both
   multi-line calls, and the correction came from re-reading the client rather than the survey. Endpoint
   surveys need to catch template literals and wrapped arguments, not just single-line string literals.

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
- **Auth is guarded PER PAGE, not by the layout** (U1). The source's pages carry a comment saying route
  protection is handled by the admin layout; this repo's `admin/layout.tsx` is presentational only and
  every existing admin route calls `getAuthenticatedUserId()` itself. Copying a page verbatim would
  therefore have shipped it unauthenticated — for DNC Area Codes, a registry anyone with the URL could
  read and write. Each ported page gets this repo's own guard rather than a second convention.
- **The API proxy routes are NOT ported** (U1 onward). Each `app/api/outbound/*/route.ts` in the source is
  a thin `miaProxy*` forward to Django. Here the handler is local, mounted by the backend's catch-all at
  the same path — so the client's existing `fetch('/api/outbound/dnc/area-codes')` reaches the ported view
  with no change at all. The five endpoints in the table above are the exception: they have no upstream to
  forward to and must be written.
- **`sonner.tsx` drops its `useTheme()`** (U1). It reads from `next-themes`, which this repo does not have
  and does not need. The `toastOptions` class map — the part that makes toasts use the shadcn surface
  tokens — is unchanged.
- **`initialFocus` → `autoFocus`** (U1) at the Calendar call site, the same v8 → v10 rename as the table on
  `components/ui/calendar.tsx`.
- **`checkbox.tsx` is reimplemented on a native input** (U2), dropping `@radix-ui/react-checkbox`. The
  ported UI uses exactly two checkboxes — the phone and email opt-out toggles in `ChatDetailView` — and
  both are plain controlled booleans. The reimplementation keeps Radix's PROP contract (`onCheckedChange`)
  and its STYLING contract (a `data-state` attribute), which is what lets both call sites stay
  byte-identical to the source. Lost: indeterminate state and `asChild`, neither of which is used, and
  `tsc` will say so if anyone reaches for them.
- **The suite's client-Firestore import repoints to this repo's own** (U2): `@/lib/firebase/firebase` →
  `lib/firebase/client`. Both export `db`, so it is a path change only.
- **`companyId` is threaded through as an empty string** (U3). The source resolves it by reading a
  `next-auth` session, pulling a `backendToken`, and calling a Django `campaign_maker` endpoint; none of
  those three exists here. The prop is kept and left empty rather than removed, because
  `/api/agents/list` is ported to IGNORE the parameter — so an empty value is correct, and threading it
  keeps three components byte-identical to the source instead of ripping a prop out to save one string.
- **`/api/agents/list` and `/api/outbound/agents` are written, not ported** (U3) — a sixth and seventh
  missing endpoint the first survey missed, both reached through `useOutboundAgents`. The list endpoint
  drops the source's company scoping for the reason above. Note `/api/outbound/agents` is a STATIC
  segment under the backend's catch-all: Next resolves static ahead of catch-all, so it wins for that one
  path and everything else still falls through to the ported route table. Verified live — `dnc` and
  `campaigns` still return 200 through the table.
- **`@types/papaparse` is declared locally instead of installed** (U3), in `src/types/papaparse.d.ts`.
  This repo has a PRE-EXISTING peer conflict — `dotenv@^17` against `@browserbasehq/stagehand`'s `^16`,
  via `@langchain/community` — which makes every `npm install` fail without `--legacy-peer-deps`. Forcing
  a repo-wide resolution change to get types for one CSV parser is the wrong trade. The declaration covers
  only the single `parse` overload actually called.
- **Three `react-hooks/exhaustive-deps` directives became plain comments** (U3). They document deliberate
  dependency omissions, but this repo's eslint has no react-hooks plugin, so the directives errored as
  unknown rules. The intent is preserved in prose so it survives if the plugin is ever added.
- **`/api/outbound/{funnel/chat-counts,funnel/drill,campaign-agents}` are written, not ported** (U4) —
  the eighth, ninth and tenth missing endpoints. All three are Admin-SDK Firestore reads with three
  mechanical substitutions: `auth()` → `getAuthenticatedUserId()`, `adminDb` → this repo's `db`, and
  `@/lib/chat-utils` → `@/lib/utils`. `campaign-agents` additionally drops its company filter — here it
  would exclude everything, since every agent would fail a comparison against an id that does not exist.
  The query shapes, filters and arithmetic are the source's.
- **`FirebaseFirestore.Query` → an imported `Query` type** (U4). The ambient namespace is declared by
  `firebase-admin`'s types, so `tsc` accepts it and eslint's `no-undef` does not. Importing the type is
  cleaner than a directive and works for both.
- **`analytics/deal-timeline` needed a real route, and U1's generalization fails here** (U5). U1
  established that the source's `/api/outbound/*` proxies need no porting, because the backend catch-all
  serves the same paths. That holds for AllowAny endpoints and **breaks for key-guarded ones**: backend
  10d³ put `dealTimelineView` behind `requireApiKey`, faithfully mirroring its Django view, and a browser
  fetch carries no key — so the page's main data call returned `401 API key is required`. The admin panel
  hits the same wall and solves it with a proxy whose only job is injecting `X-API-Key` server-side.

  The port calls `buildDealTimeline` directly instead, guarded by the session. The key guard authenticates
  SERVICE callers; here the caller is an authenticated browser session, a stronger check. Synthesizing a
  request with a key to satisfy a guard in the same process would prove only that the file can read its own
  environment variable.

  **The cost, recorded rather than glossed:** this static route shadows the catch-all for the path — the
  trailing-slash form included, which Next normalizes — so `dealTimelineView` is no longer reachable over
  HTTP. It stays correct and tested, but nothing calls it through the mount. Acceptable because no service
  caller exists; worth knowing if one ever needs it, because the path is taken.

- **Nine routes for E2E Test** (U6a), of which three needed real decisions rather than substitution:
  - **`voice-workers/transcript` is the one route whose source could not be ported.** It calls the INBOUND
    Django product, which this repo neither has nor is a port of, with a `backendToken` that does not
    exist here. Rewritten against `fetchConversationFromElevenlabs` (backend 7b²d) — the same conversation
    the inbound API was relaying, read from where it originates. The caveat is recorded on the route: the
    payload is ElevenLabs' verbatim, so a field the inbound service synthesized rather than relayed would
    show as a blank rather than an error.
  - **`trigger-ai` calls `runOutboundTurn` in-process** instead of POSTing to Django's
    `call-llm-outbound/` with a token. Chat resolution is unchanged; `adminTriggerSource: 'human'` matches
    what the HTTP endpoint defaulted to, and it matters — only a human trigger is authoritative on timing.
  - **`initiate` is a new route, NOT the repoint the plan called for.** The ported
    `initiateOutboundWebhookView` has no auth guard — correct for a webhook, `AllowAny` in Django — so
    pointing a browser button at `webhook/initiate-outbound/` would have put an unauthenticated
    lead-enrolment endpoint one fetch from the UI. **Verified: an unauthenticated POST to that path reaches
    the view and returns its own 400.** The new route adds the session guard for the browser path; the
    webhook path stays open, which is what an external lead source needs.
- **`FirebaseFirestore.*` → imported types** in `park-chat` too (U6a), same reason as U4.
- **The campaign DETAIL page answers 200 unauthenticated, and that is correct** (U3). Its `loading.tsx`
  forces a streamed response, so the status line is committed before the guard resolves — the body is an
  inert skeleton and the redirect travels in the RSC payload. The list page, which has no `loading.tsx`,
  307s normally. Verified: the detail body contains the skeleton plus a `/login` redirect and no data.
- **Two eslint accommodations in the suite** (U2). `AudioPlayer` annotates handlers with
  `React.PointerEvent` without importing the namespace; `ActivityCard` uses the omit-by-destructure idiom
  (`const { id, ...rest }`) that this repo's rule config does not exempt. Both are documented in place — a
  type import and one directive — rather than rewritten.

## Notes for later

- **This repo tracks two lockfiles** (`package-lock.json` and `yarn.lock`) and `vercel.json` declares no
  `installCommand`, so which one a deploy resolves against is Vercel's detection rather than a decision.
  U0 syncs both so the new dependencies are present either way, but the underlying ambiguity is worth
  settling — the `package-lock.json` in the tree arrived with backend Phase 0 and the repo was yarn before
  that.
- **`next-auth` is NOT ported.** The source's outbound pages import it for the session; this repo has its
  own auth (`src/app/AuthProvider.tsx`, `getAuthenticatedUserId`). Every page that reads a session gets
  repointed at this repo's helper as it lands, rather than pulling a second auth library in.
