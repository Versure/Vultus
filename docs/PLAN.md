# Movie & TV Tracker — Project Plan

A personal Android app that tracks movies and TV shows you want to watch, knows
which streaming service they're on per region, and sends a push notification
when a new episode drops or a movie becomes available.

This document is the single source of truth for the project. It captures the
architecture decisions made during planning, the workspace structure, the
agentic workflow with Claude Code, and the initial task breakdown. Update it
as the project evolves.

---

## 1. Product scope (v1)

In scope:

- Track TV shows; notify the day a new episode is available on a streaming
  platform in your selected region.
- Track movies; notify the day they become available on a streaming platform.
- Show _which_ platform a title is on (Netflix, Prime, Disney+, etc.) for the
  user's selected region.
- Track watch progress (mark episodes/movies as watched). **Shipped** (specs
  0034 episode-watch-progress, 0050 auto-status-progression, 0053
  completed-marks-episodes-watched, 0056 title-detail-mark-watched).
- Manual "refresh now" from the app, rate-limited to once per 5 minutes. The
  5-minute limit on the app path is **client-side only**
  (`SYNC_COOLDOWN_MS = 300_000` at
  `libs/shared/ui-kit/src/lib/sync-state.service.ts:9`, on the `triggerSync`
  callable path). Server-side rate limiting (`RATE_LIMIT_MS` at
  `apps/functions/src/main.ts:85`) exists only on the HTTP `syncTitles` user
  path, which the app does not use — a deliberate decision (spec 0025 non-goal).

Out of scope for v1:

- Multiple users (data model supports it, UI does not expose it).
- iOS (would require Apple Developer Program at €99/year — revisit later).
- Recommendations, social features, ratings, reviews.
- Offline mode beyond what Firestore's local cache gives for free.

User scope: single user (you), but the data model is keyed by `userId` from
day one so multi-user is a UI change later, not a migration.

> **Note (scope of record):** §1 records the ORIGINAL v1 planning scope. The
> spec ledger (`docs/specs/STATUS.md`) is the live scope record. The shipped
> product now exceeds the original 5-item list (onboarding 0022, notifications
> inbox 0042, quiet hours 0051, sync health 0049, provider preferences 0060,
> watchlist sort/filter 0046/0054) without violating the out-of-scope list.

---

## 2. Architecture decisions

| Decision           | Choice                                                                                 | Rationale                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend           | Ionic + Angular (Capacitor)                                                            | Stated constraint. Native Android via Capacitor.                                                                                                                                 |
| Monorepo           | Nx workspace                                                                           | Stated constraint. Shared types between mobile + functions.                                                                                                                      |
| Architecture style | Vertical slice (Nx-enforced via Sheriff)                                               | Each feature owns its UI, state, data, and types.                                                                                                                                |
| Backend            | Firebase (Firestore + Auth + Cloud Functions + FCM)                                    | Single integrated platform; .NET dropped.                                                                                                                                        |
| Functions runtime  | TypeScript                                                                             | End-to-end TS enables shared types via `libs/shared/domain`.                                                                                                                     |
| Database           | Firestore                                                                              | Free tier covers personal use ~1000x over; real-time sync to client.                                                                                                             |
| Auth               | Firebase Auth (anonymous in v1, email/password later)                                  | Userid scoping from day one.                                                                                                                                                     |
| Push               | FCM directly (Android only)                                                            | Free, full control, simplest stack.                                                                                                                                              |
| Daily sync trigger | GitHub Actions cron → HTTP Cloud Function                                              | Cron POSTs the shared-secret HTTP `syncTitles` function; runs on Blaze within the free tier.                                                                                     |
| Manual refresh     | App calls a separate `triggerSync` Gen2 callable                                       | The app uses a dedicated auth-gated callable (specs 0025; 0044 CORS; 0048 error surfacing), NOT the HTTP path.                                                                   |
| Region scope       | Multi-region from day one                                                              | Trivial in data model, painful to add later.                                                                                                                                     |
| Data sources       | TMDB (metadata, watch providers, episode airing) + Trakt (traktId resolution, tv only) | Both free for non-commercial. In the shipped sync engine Trakt only resolves `traktId` (`getShowTraktId`, tv only); `getCalendar` has no production caller.                      |
| UI design source   | Google Stitch — "Vultus Android App Design"                                            | Canonical screens + design system; accessed via Stitch MCP.                                                                                                                      |
| Hosting cost       | ~€0/month target, on Blaze                                                             | Blaze pay-as-you-go (required to deploy Cloud Functions), engineered to stay within free-tier allowances; budget **alert** recommended. + GitHub Actions + TMDB/Trakt free tier. |

### Why the .NET backend was dropped

Original constraint was ".NET if needed." Once Firebase was chosen as the
BaaS, the Cloud Functions runtime is TypeScript or Python — no .NET runtime.
Going all-in on TypeScript means:

- Shared types between frontend and backend through one Nx lib.
- One package manager, one lint config, one build pipeline.
- Firebase Admin SDK is first-class in Node.

If you want to add .NET to the project later for learning purposes, the right
shape is a separate worker (Azure Functions or GitHub Actions) that reads
from / writes to Firestore via the Firebase Admin .NET SDK. Not part of v1.

### Data source reliability — the open risk

The hardest part of this app is reliable per-region streaming-availability
data. TMDB's `watch/providers` endpoint is JustWatch-powered and decent for
NL but has known accuracy gaps for licensed (non-original) content. Trakt's
calendar gives you upcoming episodes but does not include streaming
availability per region. Mitigations baked into the design:

- Cache TMDB watch-provider data in Firestore so we can detect _transitions_
  (yesterday: not on Netflix NL; today: on Netflix NL → notify).
- Treat the notification as "available now on X" rather than "first episode
  ever" — the transition is what matters.
- If accuracy turns out to be poor in practice, Watchmode is the layered
  fallback (1,000 calls/month free tier, more accurate transitions). The
  data-source clients are encapsulated per slice, so swapping is local.

### Design reference (Stitch)

The canonical UI design for this app lives in **Google Stitch** as the project
**"Vultus Android App Design"** (mobile / Android, text-to-UI). It is the
visual source of truth for screens, layout, and the design system; the Ionic +
Angular implementation should match it.

- **Stitch project ID:** `projects/13590348714018893783`
- **Access:** via the Stitch MCP server (configured in Claude Code as `stitch`).
  Useful tools: `list_projects`, `get_project`, `list_screens`, `get_screen`,
  `list_design_systems` / `get` the design system, `generate_screen_from_text`,
  `generate_variants`, `edit_screens`.
- **Design system:** "Vultus Design System" — dark-first, **Inter** typography,
  8px grid, 0.5rem default radius. The core tokens (source of truth:
  `libs/shared/ui-kit/src/lib/theme.scss`, whose `--vultus-*` vars are exported
  from `docs/design/vultus-design-system.md`):

  | Token             | Hex       |
  | ----------------- | --------- |
  | primary           | `#4edea3` |
  | primary-container | `#10b981` |
  | background        | `#0b1326` |
  | surface-container | `#171f33` |
  | surface-highest   | `#2d3449` |
  | on-surface        | `#dae2fd` |
  | status-watching   | `#3b82f6` |
  | status-completed  | `#10b981` |
  | status-dropped    | `#ef4444` |
  | status-planned    | `#94a3b8` |

  The four `status-*` colors map directly to the watchlist `status` field
  (watching → blue, completed → emerald, dropped → red, planned → slate).

When building a mobile slice, pull the relevant Stitch screen first and align
component structure, spacing, and the design-system tokens above. Treat the
Stitch design system as the contract for `shared/ui-kit` theming.

---

## 3. Nx workspace structure

Vertical slice within Nx. Each slice owns its UI, state, data access, and
types. Cross-slice imports are forbidden by Sheriff. Things move into
`shared/` only when 3+ slices need them; premature sharing is the failure
mode to avoid.

The tree below is **illustrative, not exhaustive**: every subfolder under
`libs/mobile/*` and `libs/functions/*` is one slice lib, and slices are added
over time. The **authoritative, current slice list lives in
`sheriff.config.ts`** (its tag definitions) — do not treat any hand-enumerated
list here as complete.

```
vultus/
├── apps/
│   ├── mobile/                           # Ionic shell, routing, app config (standalone)
│   ├── functions/                        # Cloud Functions entry points
│   └── mobile-e2e/                       # Playwright e2e suite (spec 0019)
├── libs/
│   ├── shared/                           # Cross-slice ONLY
│   │   ├── domain/                       # Show, Movie, Episode, WatchProvider, Region
│   │   ├── firestore-schema/             # Collection paths, converters
│   │   └── ui-kit/                       # Truly shared Ionic components (atoms)
│   ├── mobile/                           # One slice lib per subfolder (see below)
│   │   ├── watchlist/                    # Slice (illustrative — not the full set)
│   │   ├── search/                       # Slice
│   │   ├── title-detail/                 # Slice
│   │   ├── settings/                     # Slice
│   │   ├── onboarding/                   # Slice (spec 0022)
│   │   └── notifications/                # Slice (spec 0042)
│   └── functions/                        # One slice lib per subfolder (see below)
│       ├── sync-titles/                  # Slice: TMDB+Trakt clients, sync, HTTP handler
│       ├── sync-episodes/                # Slice (spec 0047)
│       └── dispatch-notifications/       # Slice
├── android/                              # Capacitor Android platform (spec 0020)
├── tools/                                # doc-integrity-test, firestore-rules-test, scripts, sheriff-fixtures/-test
├── docs/
│   ├── PLAN.md                           # This document
│   ├── design/                           # vultus-design-system.md — authoritative token set
│   ├── setup/                            # Manual setup guides (Firebase, secrets)
│   └── specs/                            # Spec-file workflow unit of work (see §5)
├── .github/
│   └── workflows/                        # CI + scheduled sync trigger + deploy
├── .claude/                              # agents/hooks/skills/settings driving the §5 workflow
├── firebase.json
├── firestore.rules                       # Version-controlled security rules
├── firestore.indexes.json
├── sheriff.config.ts                     # Module boundary rules
├── capacitor.config.ts                   # Capacitor app config
├── pnpm-workspace.yaml
├── nx.json
├── package.json
└── CLAUDE.md                             # Standing instructions for Claude Code
```

### Sheriff tags (enforced by lint, gated in CI)

Each lib gets exactly one scope tag and zero or more slice tags.

- `scope:shared` — anything in `libs/shared/*`. Importable by anyone.
- `scope:mobile` — `apps/mobile` and `libs/mobile/*`.
- `scope:functions` — `apps/functions` and `libs/functions/*`.
- `slice:<name>` — assigned by PATH GLOB in `sheriff.config.ts` (one
  `slice:<name>` per `libs/{mobile,functions}/<slice>`), so every slice lib
  that exists inherits its tag automatically. The slices in use today are
  `slice:watchlist`, `slice:search`, `slice:title-detail`, `slice:settings`,
  `slice:onboarding`, `slice:notifications` (mobile) and `slice:sync-titles`,
  `slice:dispatch-notifications`, `slice:sync-episodes` (functions). The
  authoritative set is glob-derived in `sheriff.config.ts`, not this list (it
  grows with each new slice).

Rules:

1. `scope:mobile` cannot import `scope:functions` and vice versa.
2. Slices cannot import other slices. A `slice:watchlist` lib cannot import
   anything tagged `slice:search`. They communicate via `scope:shared` only.
3. `apps/*` can import `scope:shared` and any slice within their scope.
4. Anything can import `scope:shared`.
5. `scope:shared` may import ONLY `scope:shared` — it stays self-contained and
   never depends on a mobile/functions scope or a slice (`sheriff.config.ts:81`,
   `'scope:shared': 'scope:shared'`). (The `root`/`noTag` escape hatch at
   `sheriff.config.ts:67-68` lets the virtual root and untagged barrels depend
   on anything, keeping generated scaffolding green.)

### When to extract to `shared/`

Default answer: **don't**. Duplication is fine inside slices. Only extract
when the _same_ logic appears in **3+ slices** AND has the **same reason to
change**. Two date formatters that both happen to format dates today but
might diverge tomorrow are not duplication — they're independent.

This rule exists in `CLAUDE.md` because the agent's natural tendency is to
DRY up code, which kills vertical slice. The agent must be told explicitly.

---

## 4. Data model (Firestore)

All collections are keyed by `userId` even with one user. Use
`users/{userId}/...` subcollections rather than top-level + `userId` field
where possible — security rules become trivial.

```
users/{userId}
  region: "NL" | "DE" | ...
  notificationPrefs: { ... }
  fcmTokens: [ { token, deviceId, createdAt } ]
  myProviderIds: number[]                  # TMDB provider ids the user subscribes to (spec 0060); default []

users/{userId}/watchlist/{titleId}
  type: "movie" | "tv"
  tmdbId: number
  traktId: number | null
  title: string
  addedAt: timestamp
  status: "watching" | "completed" | "dropped" | "planned"
  posterPath?: string | null              # denormalized TMDB poster path (spec 0035)
  voteAverage?: number | null             # denormalized TMDB vote average (spec 0035)
  releaseDate?: string | null             # denormalized release date, plain ISO (spec 0046)

users/{userId}/watchlist/{titleId}/episodes/{episodeId}    # tv only
  season: number
  episode: number
  title: string | null                    # episode name; null when unknown (specs 0034/0047)
  airDate: timestamp
  watched: boolean
  watchedAt: timestamp | null

users/{userId}/notifications/{notificationId}
  titleId: string
  kind: "episode-aired" | "movie-available" | "show-came-to-platform"
  payload: { ... }
  sentAt: timestamp
  readAt: timestamp | null

# Global (read-only from client, written by functions only)
title-cache/{tmdbId}
  type: "movie" | "tv"
  traktId: number | null                  # top-level Trakt show id, tv only (spec 0008)
  metadata: { ... }                       # Cached TMDB metadata
  lastSyncedAt: timestamp

title-cache/{tmdbId}/availability/{region}
  providers: [ { providerId, name, type } ]   # type: "flatrate" | "rent" | "buy"
  lastSyncedAt: timestamp
  previousSnapshot: [ ... ]               # For transition detection

# Global provider catalog (authenticated read, written by functions only; spec 0060)
provider-catalog/{region}
  providers: [ { providerId, name, logoPath } ]
  lastSyncedAt: timestamp

sync-runs/{runId}                         # One doc per full sync run (spec 0049); authenticated read, Admin-SDK-only write
  runId, kind, userId, startedAt, completedAt, durationMs, titlesGathered, titlesUpdated, errorCount, errors
```

`title-cache` is shared across users — if you and a future user both track
_Severance_, we sync it once. This is also what makes the daily sync cheap.

---

## 5. The agentic workflow

> **Superseded note (2026-06-16):** The task-management model below (§5 "issue-
> driven", §6 issue breakdown, `feat/<issue-number>-<slug>` branches, issue
> templates) has been **replaced by the spec-file workflow** in
> `docs/specs/README.md` and the `.claude/` skills (`create-spec`, `rework-spec`,
> `implement-feature`, `rework-feature`). **There are no GitHub issues** — a spec
> file in `docs/specs/NNNN-slug.md`, reviewed and merged as a PR, is the unit of
> work, and branches are `spec/NNNN-slug` / `feat/NNNN-slug`. The architecture,
> definition of done, test pyramid, and secrets guidance in this section remain
> authoritative; only the issue-based task tracking is obsolete.

### Setup repo files

- **`CLAUDE.md`** at repo root — auto-loaded every Claude Code session.
  Contents:
  - Architecture decisions (link to this PLAN.md).
  - Vertical slice rules (no cross-slice imports, no premature DRY).
  - Project commands: `nx test`, `nx lint`, `nx e2e`,
    `firebase emulators:start`, and serving via the five named scenario targets
    (`mobile:serve-mock` / `serve-emulator` / `serve-prod-debug` / `serve-prod`
    / `android-usb`, spec 0038) — not raw `nx serve`, which the e2e web server
    owns.
  - Definition of done: typecheck + lint + Sheriff + unit tests + e2e green
    locally before pushing.
  - Secrets convention: `.env.local` (gitignored), GitHub Actions secrets
    for CI, Firebase config for deployed functions. Never commit secrets.
  - Branch convention: `spec/NNNN-slug` (spec PRs), `feat/NNNN-slug` (feature
    PRs).
  - Spec-first rule (see below).

- **`.github/workflows/ci.yml`** — runs on every PR:
  - `nx affected -t typecheck`
  - `nx affected -t lint` (includes Sheriff)
  - `nx affected -t test`
  - `nx affected -t build`
  - `nx affected -t e2e`
  - All must pass to merge.

- **`.github/workflows/daily-sync.yml`** — cron-triggered, calls the HTTP
  Cloud Function with the shared secret.

### Task management — spec-driven

There are no GitHub issues. A spec file (`docs/specs/NNNN-slug.md`), reviewed
and merged as a PR, is the unit of work — this is the same "design note before
code" control this section originally proposed per-issue, now formalized as
its own reviewed artifact. See `docs/specs/README.md` for the spec format and
status lifecycle, and CLAUDE.md's "Development workflow — spec-driven" for the
skill sequence (`create-spec` → review → `rework-spec` → merge →
`implement-feature` → review → `rework-feature` → merge → `cleanup-feature`).

This is the single most effective control on agent quality. It catches
"about to spend 600 lines going the wrong way" before the lines get written.

For trivial tasks (typo fix, dependency bump, one-line bug), a full spec is
overhead — Claude Code can skip straight to the PR.

### Branching and PR review

- `main` is always deployable.
- Claude Code works on `spec/NNNN-slug` / `feat/NNNN-slug` branches and opens
  PRs.
- You review every PR. CI must be green. Merge via squash so each spec/feature
  maps to one commit on `main`.
- After merge, the deploy workflow (`.github/workflows/deploy-functions.yml`)
  ships the Cloud Functions.

### Definition of done

A PR is mergeable only when _all_ of:

- [ ] Typecheck passes (`nx affected -t typecheck`).
- [ ] Lint passes including Sheriff module boundaries.
- [ ] Unit tests pass and the changed slice has tests for its logic.
- [ ] Component tests pass for non-trivial UI (state branching, conditional
      rendering tied to logic).
- [ ] e2e tests pass for affected critical flows.
- [ ] Build passes for all affected projects.
- [ ] PR references the merged spec.

### Test layering — the pyramid

- **Unit tests (lots):** All logic. Sync engine, FCM dispatch, Firestore
  query builders, region resolvers, transition detectors. Vitest + Analog. Fast.
- **Component tests (some):** Components with non-trivial state, branching,
  or conditional rendering. Angular Testing Library (on Vitest). Skip pure
  presentational components.
- **e2e tests (named critical flows, currently 13):** Critical user flows only.
  Playwright against Firebase emulators. The suite in `apps/mobile-e2e/src`
  covers `app.boot`, `app.smoke`, `manual-sync-trigger`, `mark-watched`,
  `notification-deep-links`, `notifications`, `onboarding`, `plex-provider`,
  `provider-preferences`, `search`, `settings`, `title-detail`,
  `watchlist-refresh`.

### Secrets

| Secret                           | Lives in                                                                                                 | Used by                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `TMDB_API_KEY`                   | `.env.local` (local dev via `pnpm env:tmdb`), `TMDB_API_KEY` GitHub Actions secret (CI production build) | Mobile client (injected at build time by CI) |
| Trakt client ID                  | `.env.local`, GitHub secret, Firebase functions config                                                   | Functions only                               |
| FCM service account              | Firebase functions config                                                                                | Functions only                               |
| Sync HTTP function shared secret | GitHub secret + Firebase functions config                                                                | GitHub Actions cron + Function               |

**Required GitHub Actions secrets for production builds:**

| Secret name    | Description                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMDB_API_KEY` | TMDB Developer API key. The CI workflow injects it into `environment.prod.ts` before `nx build`. Without it the CI build fails fast (explicit check). Get one at themoviedb.org/settings/api. |

`CLAUDE.md` instructs the agent to never read or write `.env.local` and to
flag any time it would need a secret in a place it shouldn't be.

---

## 6. Initial task breakdown

**Historical — this v1 breakdown is complete.** It predates the spec-driven
workflow (§5) and was originally scoped as GitHub issues; all remaining items
below have since shipped as specs (`docs/specs/0001-*` onward), except item 7
(`CLAUDE.md`, authored in the pre-spec bootstrap commit, not a spec) and item 8
(issue/PR templates, superseded and struck through) — 21 of the 23 map cleanly
to specs. Kept as a record of the original build order, not a live backlog.
Roughly ordered by dependency; each was sized to ~one Claude Code session.

### Foundation (must be done first, in order)

1. **Bootstrap Nx workspace** — Create Nx workspace, add Ionic/Angular
   preset, add Firebase Functions setup, configure TypeScript paths.
2. **Add Sheriff and configure tags** — Install Sheriff, define scope/slice
   tags from §3, add lint rule, write a failing-on-purpose test to verify
   it works.
3. **CI pipeline** — `.github/workflows/ci.yml` runs typecheck/lint/test/
   build/e2e. Branch protection on `main` requires passing CI.
4. **Firebase project + emulators** — Create Firebase project (manual
   one-time step you do), commit `firebase.json` and `firestore.rules`,
   wire up emulators for local dev.
5. **Domain types in `shared/domain`** — Define `Show`, `Movie`, `Episode`,
   `WatchProvider`, `Region`, `NotificationKind`. No logic, just types.
6. **Firestore schema lib** — Collection paths, converters, type-safe query
   helpers. Tests for converters.
7. **`CLAUDE.md`** — Author standing instructions per §5.
8. ~~Issue + PR templates~~ — superseded before this ran; the spec-driven
   workflow (§5) replaced issue/PR templates with the spec-file format in
   `docs/specs/README.md`.

### Backend slices

9. **TMDB client (in `functions/sync-titles`)** — Auth, rate-limiting,
   `getMovie`, `getTvShow`, `getWatchProviders`, `getSeasonEpisodes`. Unit
   tests with mocked HTTP.
10. **Trakt client (in `functions/sync-titles`)** — Auth, `getCalendar`.
    Unit tests with mocked HTTP.
11. **Sync engine** — Given a list of `tmdbId`s, fetch metadata + providers
    - episodes, compute transitions vs `previousSnapshot`, write to
      `title-cache`. Unit tests for transition detection.
12. **HTTP sync function with shared-secret auth** — Wrap sync engine in
    HTTPS callable, validate secret header, idempotent.
13. **Daily-sync GitHub Action** — Cron schedule, calls HTTP function with
    secret.
14. **Notification dispatcher (Firestore trigger)** — On `title-cache/*/
availability/*` write, diff against previous snapshot, find users
    tracking that title in matching region, write to `users/*/
notifications/*` and send via FCM. Unit tests.

### Mobile slices

15. **App shell + routing + Firebase init** — Ionic tabs (Watchlist,
    Search, Settings), Firebase init in `apps/mobile`, anonymous auth on
    first launch.
16. **`slice:settings`** — Region picker, notification prefs, FCM token
    registration.
17. **`slice:search`** — Search TMDB, view result, "Add to watchlist"
    action.
18. **`slice:watchlist`** — List of tracked titles with status, swipe to
    remove, pull-to-refresh (calls HTTP sync function).
19. **`slice:title-detail`** — Per-title page: metadata, current providers
    in region, episode list (for TV), mark-watched toggle.
20. **e2e test setup + 5–10 critical flows** — Playwright + Firebase
    emulators. Claude Code proposes the flows in a design note; you
    approve.

### Polish

21. **Capacitor Android build** — App icon, splash, FCM push setup,
    `capacitor.config.ts`, build APK locally.
22. **Onboarding flow** — First-launch screen: pick region, grant
    notification permission.
23. **Empty states + loading states** — Across all slices.

This was ~23 items; realistically v1 grew to 60+ specs by the time small
fixes and adjustments accumulated. That's fine — the workflow scales.

---

## 7. Manual prerequisites (you, not Claude Code)

These you have to do yourself; Claude Code can't.

- [ ] Create GitHub repo (private), enable branch protection on `main` once
      CI workflow is in place.
- [x] Create Firebase project at console.firebase.google.com. Enable
      Firestore, Authentication (Anonymous), Cloud Messaging, Cloud
      Functions. (project `vultus-cab62`, Blaze, provisioned 2026-06-18)
- [x] Sign up for TMDB API at themoviedb.org/settings/api → request
      Developer key. Free, instant. Add the key as a GitHub Actions secret
      named `TMDB_API_KEY` (repo → Settings → Secrets → Actions → New
      repository secret) so CI can inject it into the production build.
- [ ] Sign up for Trakt API at trakt.tv/oauth/applications → create
      application, get client ID. Free, instant.
- [x] Add the deployed `syncTitles` endpoint URL as a GitHub Actions
      **variable** named `VULTUS_SYNC_URL` (repo → Settings → Secrets and
      variables → Actions → Variables) so the daily-sync cron knows where to
      POST. Public value, so a variable, not a secret. (Referenced by
      `.github/workflows/daily-sync.yml`; the project runs on Blaze with the
      function deployed.)
- [x] Add the sync shared secret as a GitHub Actions **secret** named
      `SYNC_SHARED_SECRET` (the value sent in the `X-Vultus-Sync-Secret`
      header by the daily-sync cron) — see PLAN §5's secrets table row
      "Sync HTTP function shared secret". (Referenced by
      `.github/workflows/daily-sync.yml`.)
- [ ] Set the **matching** `SYNC_SHARED_SECRET` param on the Cloud Function
      side (same value as the GitHub secret) so the header comparison passes;
      rotating one without the other breaks the cron. _(console step — not
      repo-verifiable; the daily-sync cron running proves it is set.)_
- [x] Grant **public invokability** to the `synctitles` Cloud Run service
      (spec 0021, applied + verified 2026-06-24) — run:
      `gcloud run services add-iam-policy-binding synctitles --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=vultus-cab62`
      **Why:** gen2 `onRequest` functions are Cloud Run services, **private by
      default**. `syncTitles` self-authenticates via the `X-Vultus-Sync-Secret`
      shared secret (spec 0009), so the service must be **publicly invokable**
      — the shared secret is the security gate, not Cloud Run IAM. Without this
      binding, the Google Front End blocks every request with an HTML 403 before
      it ever reaches the function. The service name is the **lowercased**
      function name `synctitles`. **This is the fix for the 2026-06-24
      first-run failure** (the daily-sync cron received a Google Front End HTML
      403 because the service was private). The `deploy-functions.yml` pipeline
      now verifies invokability after each deploy (smoke gate); it does **not**
      auto-grant it — this is a one-time manual step, like the secrets above.
- [ ] Install Claude Code locally (`npm install -g @anthropic-ai/claude-code`),
      authenticate.
- [ ] Install Node.js LTS, Android Studio (for Capacitor builds), Firebase
      CLI (`npm install -g firebase-tools`).
- [x] **Download `google-services.json`** from the Firebase console for project
      **`vultus-cab62`**: Project settings → Your apps → Android app
      (package `app.vultus.mobile`; register it if not listed yet) →
      Download `google-services.json` → place at
      **`android/app/google-services.json`**. This file is **gitignored, not
      committed** (spec 0026 decision 4; `android/.gitignore:67`) — public client
      config (no private key), provisioned per-machine once from the console. The
      local on-device build (`mobile:android-usb`) asserts its presence via
      `tools/scripts/inject-mobile-env.mjs --check-native` (spec 0038); the web
      CI build does not use it. Without this file the app boots but Firebase + FCM
      will not initialise on-device.

---

## 8. Open questions (revisit as we go)

- Streaming-availability accuracy in NL: monitor for the first month after
  v1 ships. If <90% of "appeared on Netflix NL today" notifications are
  actually correct, layer in Watchmode.
- iOS: revisit only after v1 is stable on Android for a month.
- Multi-user UX: revisit only when there's a second user who actually wants
  to use the app.
- ~~Watch progress as v1.1 vs v2~~ **Resolved:** watch progress shipped (specs
  0034/0050/0053/0056); it was built as its own set of specs, not deferred to a
  v2 milestone.

---

## 9. Risk register

| Risk                                           | Mitigation                                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TMDB watch-provider data is wrong/stale for NL | Watchmode as layered fallback, encapsulated per slice                                                                                                                                                          |
| Free-tier limits hit                           | All chosen tiers have ~1000x headroom for personal use                                                                                                                                                         |
| FCM token expires/changes                      | Re-register on every app launch, store array of tokens                                                                                                                                                         |
| Background daily sync fails silently           | Sync-health (spec 0049) surfaces last-run status in settings from `sync-runs`; `deploy-functions.yml` smoke gate verifies invokability post-deploy                                                             |
| Sheriff/Nx version mismatch breaks CI          | Pin versions in `package.json` (no automated updater configured)                                                                                                                                               |
| Agent over-DRYs and breaks slices              | Explicit rule in CLAUDE.md; Sheriff catches cross-slice imports                                                                                                                                                |
| Agent commits secrets                          | `.env.local` gitignored; CLAUDE.md rule; husky pre-commit hook runs lint-staged (ESLint `--fix` + Prettier + `gen-spec-status --check`). No gitleaks scan configured (a recommended-but-unimplemented add-on). |

---

## 10. Definition of v1 shipped

- [x] APK installs on your Android phone. (specs 0020 + 0026; `android/` exists
      on disk)
- [x] You can search for a show, add it to your watchlist. (spec 0013)
- [x] You can see which streaming service it's on in NL. (specs 0014/0016)
- [ ] When a new episode airs and is on a service in NL, you get a push
      notification within 24h. _(shipped; end-to-end prod delivery pending
      re-verification)_
- [ ] When a movie on your list becomes available on a service in NL, you
      get a push notification within 24h. _(shipped; end-to-end prod delivery
      pending re-verification)_
- [x] Manual refresh works. (spec 0025 + fixes 0033/0044/0048)
- [x] All CI gates green on `main`. (verified 2026-07-02)
- [ ] Bill stays at €0/month. On the **Blaze** plan (required to deploy Cloud
      Functions), engineered to stay within free-tier allowances; set a budget
      **alert** as a guard. See §2 and `docs/setup/firebase-and-secrets.md`.
