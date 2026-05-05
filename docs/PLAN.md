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
- Show *which* platform a title is on (Netflix, Prime, Disney+, etc.) for the
  user's selected region.
- Track watch progress (mark episodes/movies as watched). Treated as v1.1 —
  built last, after the notification pipeline is working end-to-end.
- Manual "refresh now" from the app, rate-limited to once per 5 minutes.

Out of scope for v1:

- Multiple users (data model supports it, UI does not expose it).
- iOS (would require Apple Developer Program at €99/year — revisit later).
- Recommendations, social features, ratings, reviews.
- Offline mode beyond what Firestore's local cache gives for free.

User scope: single user (you), but the data model is keyed by `userId` from
day one so multi-user is a UI change later, not a migration.

---

## 2. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Frontend | Ionic + Angular (Capacitor) | Stated constraint. Native Android via Capacitor. |
| Monorepo | Nx workspace | Stated constraint. Shared types between mobile + functions. |
| Architecture style | Vertical slice (Nx-enforced via Sheriff) | Each feature owns its UI, state, data, and types. |
| Backend | Firebase (Firestore + Auth + Cloud Functions + FCM) | Single integrated platform; .NET dropped. |
| Functions runtime | TypeScript | End-to-end TS enables shared types via `libs/shared/domain`. |
| Database | Firestore | Free tier covers personal use ~1000x over; real-time sync to client. |
| Auth | Firebase Auth (anonymous in v1, email/password later) | Userid scoping from day one. |
| Push | FCM directly (Android only) | Free, full control, simplest stack. |
| Daily sync trigger | GitHub Actions cron → HTTP Cloud Function | Stays on Spark plan, no credit card. |
| Manual refresh | App calls same HTTP Cloud Function (rate-limited) | Single code path for sync logic. |
| Region scope | Multi-region from day one | Trivial in data model, painful to add later. |
| Data sources | TMDB (metadata + watch providers) + Trakt (calendar) | Both free for non-commercial; complementary. |
| Hosting cost | €0/month | Firebase Spark + GitHub Actions free tier + TMDB/Trakt free tier. |

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

- Cache TMDB watch-provider data in Firestore so we can detect *transitions*
  (yesterday: not on Netflix NL; today: on Netflix NL → notify).
- Treat the notification as "available now on X" rather than "first episode
  ever" — the transition is what matters.
- If accuracy turns out to be poor in practice, Watchmode is the layered
  fallback (1,000 calls/month free tier, more accurate transitions). The
  data-source clients are encapsulated per slice, so swapping is local.

---

## 3. Nx workspace structure

Vertical slice within Nx. Each slice owns its UI, state, data access, and
types. Cross-slice imports are forbidden by Sheriff. Things move into
`shared/` only when 2+ slices need them; premature sharing is the failure
mode to avoid.

```
movie-tracker/
├── apps/
│   ├── mobile/                           # Ionic shell, routing, app module
│   └── functions/                        # Cloud Functions entry points
├── libs/
│   ├── shared/                           # Cross-slice ONLY
│   │   ├── domain/                       # Show, Movie, Episode, WatchProvider, Region
│   │   ├── firestore-schema/             # Collection paths, converters
│   │   └── ui-kit/                       # Truly shared Ionic components (atoms)
│   ├── mobile/
│   │   ├── watchlist/                    # Slice
│   │   ├── search/                       # Slice
│   │   ├── title-detail/                 # Slice (episodes, providers, mark watched)
│   │   └── settings/                     # Slice (region, notification prefs)
│   └── functions/
│       ├── sync-titles/                  # Slice: TMDB+Trakt clients, sync, HTTP handler
│       └── dispatch-notifications/       # Slice: Firestore trigger, FCM, dispatch
├── docs/
│   ├── PLAN.md                           # This document
│   └── decisions/                        # ADR-style design notes per non-trivial task
├── .github/
│   └── workflows/                        # CI + scheduled sync trigger
├── firebase.json
├── firestore.rules                       # Version-controlled security rules
├── firestore.indexes.json
├── sheriff.config.ts                     # Module boundary rules
├── nx.json
├── package.json
└── CLAUDE.md                             # Standing instructions for Claude Code
```

### Sheriff tags (enforced by lint, gated in CI)

Each lib gets exactly one scope tag and zero or more type tags.

- `scope:shared` — anything in `libs/shared/*`. Importable by anyone.
- `scope:mobile` — `apps/mobile` and `libs/mobile/*`.
- `scope:functions` — `apps/functions` and `libs/functions/*`.
- `slice:watchlist`, `slice:search`, `slice:title-detail`, `slice:settings`,
  `slice:sync-titles`, `slice:dispatch-notifications` — one per slice lib.

Rules:

1. `scope:mobile` cannot import `scope:functions` and vice versa.
2. Slices cannot import other slices. A `slice:watchlist` lib cannot import
   anything tagged `slice:search`. They communicate via `scope:shared` only.
3. `apps/*` can import `scope:shared` and any slice within their scope.
4. Anything can import `scope:shared`.

### When to extract to `shared/`

Default answer: **don't**. Duplication is fine inside slices. Only extract
when the *same* logic appears in **3+ slices** AND has the **same reason to
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

users/{userId}/watchlist/{titleId}
  type: "movie" | "tv"
  tmdbId: number
  traktId: number | null
  title: string
  addedAt: timestamp
  status: "watching" | "completed" | "dropped" | "planned"

users/{userId}/watchlist/{titleId}/episodes/{episodeId}    # tv only
  season: number
  episode: number
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
  metadata: { ... }                       # Cached TMDB metadata
  lastSyncedAt: timestamp

title-cache/{tmdbId}/availability/{region}
  providers: [ { providerId, name, type } ]   # type: "flatrate" | "rent" | "buy"
  lastSyncedAt: timestamp
  previousSnapshot: [ ... ]               # For transition detection
```

`title-cache` is shared across users — if you and a future user both track
*Severance*, we sync it once. This is also what makes the daily sync cheap.

---

## 5. The agentic workflow

### Setup repo files

- **`CLAUDE.md`** at repo root — auto-loaded every Claude Code session.
  Contents:
  - Architecture decisions (link to this PLAN.md).
  - Vertical slice rules (no cross-slice imports, no premature DRY).
  - Project commands: `nx test`, `nx lint`, `nx e2e`, `nx serve`,
    `firebase emulators:start`.
  - Definition of done: typecheck + lint + Sheriff + unit tests + e2e green
    locally before pushing.
  - Secrets convention: `.env.local` (gitignored), GitHub Actions secrets
    for CI, Firebase config for deployed functions. Never commit secrets.
  - Branch convention: `feat/<issue-number>-<slug>`, `fix/<issue-number>-<slug>`.
  - PR convention: title references issue, description has design note for
    non-trivial work, includes screenshot for UI changes.
  - Spec-first rule (see below).

- **`.github/ISSUE_TEMPLATE/`** — three templates:
  - `feature.md` — what user-facing capability, acceptance criteria, slice
    it belongs to.
  - `bug.md` — repro steps, expected, actual.
  - `chore.md` — refactors, deps, infra.

- **`.github/PULL_REQUEST_TEMPLATE.md`** — checklist:
  - Linked issue
  - Design note (link or inline) for non-trivial PRs
  - All CI checks passing
  - Screenshot/recording for UI changes
  - Updated docs if behavior changed

- **`.github/workflows/ci.yml`** — runs on every PR:
  - `nx affected -t typecheck`
  - `nx affected -t lint` (includes Sheriff)
  - `nx affected -t test`
  - `nx affected -t build`
  - `nx affected -t e2e`
  - All must pass to merge.

- **`.github/workflows/daily-sync.yml`** — cron-triggered, calls the HTTP
  Cloud Function with the shared secret.

### Task management — issue-driven

Every task is a GitHub issue. The issue is the unit of work; the PR closes
the issue. Conventions:

- Issue title is imperative and scoped: "Add region picker to settings slice"
  not "settings stuff."
- Issue body uses the template: user-facing capability, acceptance criteria,
  affected slice(s), out-of-scope notes.
- Labels for slice (`slice:watchlist`), kind (`feat`/`fix`/`chore`), and
  priority.
- Issues are sized to fit one Claude Code session. If it doesn't, split it.

### Spec-first per task (for non-trivial work)

For any task larger than a one-file change:

1. Claude Code reads the issue.
2. Before writing code, it produces a design note as a comment on the issue
   (or as `docs/decisions/NNNN-<slug>.md` for architecturally significant
   decisions). The note covers: approach, files to change, new types/APIs,
   test plan, risks.
3. You review and approve (or redirect) the design note.
4. Only then does Claude Code start coding on a feature branch.

This is the single most effective control on agent quality. It catches
"about to spend 600 lines going the wrong way" before the lines get written.

For trivial tasks (typo fix, dependency bump, one-line bug), spec-first is
overhead — Claude Code can skip straight to the PR.

### Branching and PR review

- `main` is always deployable.
- Claude Code works on feature branches and opens PRs.
- You review every PR. CI must be green. Merge via squash so each issue maps
  to one commit on `main`.
- After merge, GitHub Action deploys (when we add deploy workflows).

### Definition of done

A PR is mergeable only when *all* of:

- [ ] Typecheck passes (`nx affected -t typecheck`).
- [ ] Lint passes including Sheriff module boundaries.
- [ ] Unit tests pass and the changed slice has tests for its logic.
- [ ] Component tests pass for non-trivial UI (state branching, conditional
      rendering tied to logic).
- [ ] e2e tests pass for affected critical flows.
- [ ] Build passes for all affected projects.
- [ ] PR description is filled out per template.
- [ ] Design note exists for non-trivial work.

### Test layering — the pyramid

- **Unit tests (lots):** All logic. Sync engine, FCM dispatch, Firestore
  query builders, region resolvers, transition detectors. Jest. Fast.
- **Component tests (some):** Components with non-trivial state, branching,
  or conditional rendering. Angular Testing Library. Skip pure presentational
  components.
- **e2e tests (5–10, named):** Critical user flows only. Playwright against
  Firebase emulators. Claude Code will propose the specific flows in a
  design note for the e2e setup task — you approve them there.

### Secrets

| Secret | Lives in | Used by |
|---|---|---|
| TMDB API key | `.env.local`, GitHub secret, Firebase functions config | Functions only |
| Trakt client ID | `.env.local`, GitHub secret, Firebase functions config | Functions only |
| FCM service account | Firebase functions config | Functions only |
| Sync HTTP function shared secret | GitHub secret + Firebase functions config | GitHub Actions cron + Function |

`CLAUDE.md` instructs the agent to never read or write `.env.local` and to
flag any time it would need a secret in a place it shouldn't be.

---

## 6. Initial task breakdown

These are the GitHub issues to create on day one. Roughly ordered by
dependency. Each is sized to ~one Claude Code session.

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
8. **Issue + PR templates** — Per §5.

### Backend slices

9. **TMDB client (in `functions/sync-titles`)** — Auth, rate-limiting,
   `getMovie`, `getTvShow`, `getWatchProviders`, `getSeasonEpisodes`. Unit
   tests with mocked HTTP.
10. **Trakt client (in `functions/sync-titles`)** — Auth, `getCalendar`.
    Unit tests with mocked HTTP.
11. **Sync engine** — Given a list of `tmdbId`s, fetch metadata + providers
    + episodes, compute transitions vs `previousSnapshot`, write to
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

This is ~23 issues. Realistically v1 is 30+ issues by the time small fixes
and adjustments accumulate. That's fine — the workflow scales.

---

## 7. Manual prerequisites (you, not Claude Code)

These you have to do yourself; Claude Code can't.

- [ ] Create GitHub repo (private), enable branch protection on `main` once
      CI workflow is in place.
- [ ] Create Firebase project at console.firebase.google.com. Enable
      Firestore, Authentication (Anonymous), Cloud Messaging, Cloud
      Functions.
- [ ] Sign up for TMDB API at themoviedb.org/settings/api → request
      Developer key. Free, instant.
- [ ] Sign up for Trakt API at trakt.tv/oauth/applications → create
      application, get client ID. Free, instant.
- [ ] Install Claude Code locally (`npm install -g @anthropic-ai/claude-code`),
      authenticate.
- [ ] Install Node.js LTS, Android Studio (for Capacitor builds), Firebase
      CLI (`npm install -g firebase-tools`).
- [ ] Add a credit card test: confirm you do *not* want to enable Blaze.
      Spark plan + GitHub Actions cron is the chosen path.

---

## 8. Open questions (revisit as we go)

- Streaming-availability accuracy in NL: monitor for the first month after
  v1 ships. If <90% of "appeared on Netflix NL today" notifications are
  actually correct, layer in Watchmode.
- iOS: revisit only after v1 is stable on Android for a month.
- Multi-user UX: revisit only when there's a second user who actually wants
  to use the app.
- Watch progress as v1.1 vs v2: build it after notifications are working;
  decide then whether it's its own milestone.

---

## 9. Risk register

| Risk | Mitigation |
|---|---|
| TMDB watch-provider data is wrong/stale for NL | Watchmode as layered fallback, encapsulated per slice |
| Free-tier limits hit | All chosen tiers have ~1000x headroom for personal use |
| FCM token expires/changes | Re-register on every app launch, store array of tokens |
| Background daily sync fails silently | Cloud Function logs to Firebase Logging; weekly sanity-check issue |
| Sheriff/Nx version mismatch breaks CI | Pin versions; renovate updates via PR |
| Agent over-DRYs and breaks slices | Explicit rule in CLAUDE.md; Sheriff catches cross-slice imports |
| Agent commits secrets | `.env.local` gitignored; CLAUDE.md rule; pre-commit hook with `gitleaks` |

---

## 10. Definition of v1 shipped

- [ ] APK installs on your Android phone.
- [ ] You can search for a show, add it to your watchlist.
- [ ] You can see which streaming service it's on in NL.
- [ ] When a new episode airs and is on a service in NL, you get a push
      notification within 24h.
- [ ] When a movie on your list becomes available on a service in NL, you
      get a push notification within 24h.
- [ ] Manual refresh works.
- [ ] All CI gates green on `main`.
- [ ] €0/month bill.
