---
number: 0019
slug: e2e-setup
title: Set up Playwright e2e infrastructure against the Firebase emulators and wire 8 critical flows into CI
status: done
slices: []
scopes: [scope:mobile]
created: 2026-06-24
---

# Set up Playwright e2e infrastructure against the Firebase emulators and wire 8 critical flows into CI

## Context

PLAN §6 item 20 — **e2e test setup + 5–10 critical flows** — is the last
foundation gate the project still owes. The pieces exist in isolation but nothing
ties them together into a real end-to-end gate:

- `apps/mobile-e2e` is the default Nx Playwright scaffold: a `playwright.config.ts`
  whose `webServer` runs `npx nx run mobile:serve` (the **dev** config →
  `useEmulators: true`, Auth `9099` / Firestore `8080`, project `vultus-cab62`)
  with **no Firebase backend started**, three browser projects (chromium / firefox
  / webkit), and one **no-emulator smoke** spec (`src/app.smoke.spec.ts`, spec 0010)
  that asserts only that the tabs shell renders and Watchlist is the landing route.
- The Firebase emulators (Firestore `8080`, Auth `9099`, UI `4000`) are configured
  in `firebase.json` (spec 0004), with `firestore.rules` enforcing the PLAN §4
  owner-only/`title-cache` model. The mobile shell (spec 0010) signs in
  **anonymously** on launch and connects AngularFire to those emulators in dev.
- `ci.yml` (specs 0002/0015 + the later typecheck/emulator additions) runs
  `nx affected -t typecheck lint test build` on PRs and a Firestore-emulator
  **functions integration** gate via `firebase emulators:exec --only firestore`,
  but **runs no `e2e` target at all** — every prior spec that mentioned e2e
  (0002, 0004, 0010) explicitly **deferred the emulator-backed Playwright gate to
  this spec**.

This spec delivers that gate: a Playwright e2e harness that boots `apps/mobile`
(web-served) **against the Auth + Firestore emulators**, drives **8 approved
critical user flows**, and adds an **`e2e` job/step to `ci.yml`** so
`nx affected -t e2e` becomes a real PR gate. TMDB is **intercepted at the network
layer** (`page.route`) with committed fixtures, so e2e needs **no `TMDB_API_KEY`**
and makes **no real external call**. Firestore state is controlled by the emulator
**import/export** mechanism with committed seed fixtures.

> **Two decision-record flows depend on behavior that does NOT exist in the
> implemented app yet (verified in this worktree).** This is the single most
> important thing for the implementer to read before starting — see **Risks R1
> (title-detail not implemented)** and **R2 (pull-to-refresh is not an HTTP sync
> call)**. The spec does **not** silently invent that behavior: the flows that
> depend on it are authored as **`test.fixme`-gated, clearly-annotated** specs
> that ship red-pending and are un-skipped by the slice that lands the behavior.
> Do not "make the test pass" by faking a route or a sync call.

Intended outcome: `nx e2e mobile-e2e` (locally, and `nx affected -t e2e` in CI)
boots the app against the emulators, runs the runnable critical flows green
against committed seed + TMDB fixtures with **no secret and no live network**, and
the deferred flows are explicitly pending on their owning slice.

## Scope

In scope:

- **Rework `apps/mobile-e2e/playwright.config.ts`** for emulator-backed web mode:
  `baseURL` `http://localhost:4200`, **chromium-only** (drop firefox/webkit — see
  Risks R6; they materially slow CI and add no fidelity for this app), the
  `webServer` kept on `nx run mobile:serve` (dev config → emulators), a
  `globalSetup`, retries/trace tuned for CI, and the emulator host/ports surfaced
  as documented env (`FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST`)
  **for the Node-side `globalSetup`/support helpers only** (the browser app does
  **not** read these — see the **Emulator-port invariant** below).
- **`apps/mobile-e2e/global-setup.ts`** — the seed-reset mechanism (clear Firestore
  - Auth via the emulators' REST **clear** endpoints, then load the chosen fixture
    via the Firestore emulator's REST API). See **Public types / APIs → Seed
    mechanism** for the exact, single prescribed approach.
- **Committed seed fixtures** under `apps/mobile-e2e/emulator-data/`:
  - **`empty/`** — no watchlist entries (flows 1–3).
  - **`seeded/`** — one **TV** watchlist entry + the `users/{uid}` doc (region) for
    a **fixed deterministic test uid** (flows 4–8).
- **Committed TMDB fixtures** under `apps/mobile-e2e/fixtures/tmdb-*.json` — static
  JSON for `search/multi`, intercepted by `page.route('**/api.themoviedb.org/**')`.
- **The 8 spec files** (Test plan enumerates the per-flow assertions):
  - `src/app.boot.spec.ts` — flow 1.
  - `src/search.spec.ts` — flows 2–3.
  - `src/title-detail.spec.ts` — flows 4–6 (**`test.fixme`-gated**, R1).
  - `src/settings.spec.ts` — flow 7.
  - `src/watchlist-refresh.spec.ts` — flow 8 (**reframed**, R2).
- **`apps/mobile-e2e/project.json`** — a correctly-configured **`e2e`** target
  (env vars, the seed/emulator wiring) so `nx e2e mobile-e2e` and
  `nx affected -t e2e` resolve it; keep the existing `open` target.
- **`.github/workflows/ci.yml`** — add an **`e2e` step** that runs the Playwright
  suite **wrapped in `firebase emulators:exec --only firestore,auth`** (so both
  emulators are up for the run and torn down after), needing **no `TMDB_API_KEY`**.
  Java is already set up in the job (the functions integration gate uses it).
- **`firebase.json`** — confirm/extend so the Auth + Firestore emulators expose the
  ports the harness expects (8080 / 9099 already present); add nothing the existing
  config already provides (verify-then-edit).
- **A short `apps/mobile-e2e/README.md`** documenting how to run the suite locally
  (the Java/emulator prereq, the `nx e2e` command, where fixtures live, and the
  emulator-loopback caveat from project memory).
- **Update the AI agent/skill tooling (`.claude/`)** so future feature specs
  reliably include e2e coverage where needed. Six files require targeted edits (see
  task 7 in the task graph for the exact changes per file):
  - `.claude/agents/spec-author.md` — add an e2e decision rubric (required /
    fixme-gated / not-required, never silent) to the Test plan section.
  - `.claude/skills/create-spec/SKILL.md` — add an e2e probe to the interview
    step so the architect asks about critical flows for mobile UI features.
  - `.claude/agents/spec-reviewer.md` — add a check that a new UI route/action
    without e2e coverage must be explicitly justified; silent omission is blocking.
  - `.claude/agents/qa-runner.md` — tighten the "not bootstrapped" skip: once
    `apps/mobile-e2e/playwright.config.ts` exists, e2e is bootstrapped for
    `scope:mobile` work; `test.fixme` flows are pending, not failures.
  - `.claude/agents/feature-reviewer.md` — add a check for `test.fixme`-gated
    flows whose blocking dependency this PR delivers; leaving them fixme after
    the dependency lands is a blocking finding.
  - `.claude/skills/implement-feature/SKILL.md` — add a step to grep
    `apps/mobile-e2e/src/` for fixme annotations referencing the spec being
    implemented, and include un-skipping them as an explicit task.

Out of scope (decision record + PLAN-consistent):

- **Native Android e2e (Appium)** — web mode only.
- **FCM / push-notification pipeline e2e** — covered by `dispatch-notifications`
  unit tests (PLAN §6 item 14); no device/FCM flow here.
- **Starting the Functions emulator** — flow 8's "refresh" is stubbed at the
  network layer (R2); no `functions` emulator block is added.
- **More than 8 flows / visual-regression testing** — a later spec.
- **Real prod Firebase / real TMDB key in e2e** — the suite is emulator + fixture
  only; **no secret is introduced** (see invariant).
- **Implementing the `title-detail` slice or an HTTP sync callable** — those are
  PLAN §6 items 19 / 11–12 (their own specs). This spec only authors the e2e specs
  that will exercise them once they land (R1/R2).

### €0 / no-new-secret invariant

The suite runs against **local emulators with no real credentials** and
**intercepts every TMDB call** with committed fixtures, so it needs **no
`TMDB_API_KEY`**, no Firebase service account, and **no `.env.local`** (CLAUDE.md
rule). The CI `e2e` step must **not** add any secret. If a step appears to need
one, the implementer **stops and flags it** in the PR rather than wiring one.

### Emulator-port invariant (the browser app's endpoints are NOT runtime-configurable)

`apps/mobile/src/app/firebase/emulators.ts` **hardcodes** the emulator endpoints —
`AUTH_EMULATOR_URL = 'http://localhost:9099'` and
`FIRESTORE_EMULATOR_HOST/PORT = 'localhost' / 8080` — gated only on
`!production && useEmulators` (the dev AngularFire config sets `useEmulators: true`).
This is **browser-side** code; it **cannot read process env vars** (`FIRESTORE_EMULATOR_HOST`
etc.) at all. The suite works only because `firebase emulators:exec` starts the
emulators on the **same Firebase default ports** the app hardcodes.

**Invariant:** the e2e run **must** use the default Firebase emulator ports
(Firestore **8080**, Auth **9099**). The browser app's endpoints are not
configurable at runtime, so if a future change caused `emulators:exec` to bind
non-default ports, the **browser app would silently miss the emulator** (anon
sign-in / Firestore would hit nothing) with no error surfaced by the env wiring.
Keep `firebase.json` on 8080/9099 and do **not** introduce per-run port overrides.

## Affected slices & Sheriff tags

No slice is built (`slices: []`). This is cross-cutting test infrastructure living
in the **untagged** `apps/mobile-e2e` project plus root config.

| Touched         | Path                       | Sheriff tags                   | Change                                                                                           |
| --------------- | -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| e2e project     | `apps/mobile-e2e`          | none (e2e project, `tags: []`) | playwright config, global-setup, 8 specs, fixtures, seed data, project.json `e2e` target, README |
| CI workflow     | `.github/workflows/ci.yml` | none (not an Nx project)       | add the `e2e` step wrapped in `emulators:exec`                                                   |
| Firebase config | `firebase.json`            | none (not an Nx project)       | verify Auth/Firestore emulator ports (edit only if a gap)                                        |

- `apps/mobile-e2e` carries `tags: []`; per `sheriff.config.ts` it matches the
  `apps/*` module glob but it is a **black-box browser-driving** project — it
  imports **no workspace source** (it drives the running app over HTTP and talks to
  the emulator REST API). It depends on `mobile` only via `implicitDependencies`
  (already set) so `nx affected` schedules it when the app changes. **No
  cross-slice / cross-scope import is introduced** — the specs reference the app's
  **DOM and routes**, not its TypeScript, so no Sheriff boundary applies.
- **No `scope:functions` and no slice lib is touched.** `firebase.json` and
  `ci.yml` are not Nx projects (same as specs 0002/0004) — no boundary rule applies.
- **Not a `shared/` extraction.** Fixtures and seed data are e2e-local test assets,
  shared with nothing (CLAUDE.md 3+-slice rule does not apply).

## Data model touchpoints

The e2e suite **reads and writes the real PLAN §4 paths against the Firestore
emulator** through the running app (and seeds them directly via the emulator REST
API in `globalSetup`). No production data, no rules change beyond what spec 0004
already enforces.

| PLAN §4 path                      | e2e access                                                                                              | Note                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Firebase Auth (anon session)      | created by the app on boot; **seeded** for the fixed test uid                                           | The `seeded/` fixture pins a deterministic uid so the app's anon session and the seeded docs line up (see Public types / APIs → Fixed test uid) |
| `users/{uid}`                     | seeded (`seeded/`) + written by the **settings** flow (region)                                          | Flow 7 writes `region`                                                                                                                          |
| `users/{uid}/watchlist/{titleId}` | seeded (`seeded/`); written by **search add** (flow 3) and **remove** (flow 6); status updated (flow 5) | TV entry in `seeded/`; `status: "planned"` after add per PLAN §4                                                                                |
| `title-cache/**`                  | read-only by the app for provider badges; **not required** by these flows                               | flows assert title/status, not provider badges (avoids depending on synced availability)                                                        |

- **`firestore.rules` is NOT changed.** Spec 0004's owner-only `users/**` +
  authenticated-read `title-cache` already cover every path these flows touch,
  **including anonymous uids**. The seed writes go through the emulator REST API,
  which (like the Admin SDK) **bypasses rules** — so seeding does not depend on a
  rule allowance, and the in-app writes are all owner-scoped to the signed-in uid.
- **`firestore.indexes.json` is NOT changed** — the flows issue only the queries
  the watchlist/search/settings slices already make (no new composite index).
- **The anon uid ↔ seed-uid coupling is the one non-obvious correctness point**:
  the app boots a **fresh anonymous** session, so its uid is non-deterministic
  unless pinned. The seed mechanism (Public types / APIs) resolves this by either
  (a) seeding under the **uid the app reports after boot** (read it from the page,
  then seed before the assertions), or (b) using the Auth emulator's ability to
  import a **fixed anonymous account** so the app re-uses that uid. **(a) is the
  prescribed default** (deterministic, no Auth-import fragility); see Public types.

## Public types / APIs

No domain types, function signatures, or callable shapes are introduced. The
stable surfaces this spec fixes for the harness and CI to depend on:

### Nx targets / commands (names fixed)

- **`mobile-e2e:e2e`** — the Playwright run; invokable as `pnpm nx e2e mobile-e2e`
  and selected by `pnpm nx affected -t e2e`. (The existing `open` target stays.)
  **No `ci` Nx configuration is needed** for the `e2e` target — the CI step invokes
  it as a **plain `nx affected -t e2e`** (CI-specific tuning lives in
  `playwright.config.ts` via the `CI` env Playwright sets, not in an Nx
  `--configuration`). Do **not** fold `e2e` into the existing
  `--configuration=ci` target list (see CI invocation).
- **CI invocation** — the suite runs **wrapped** in
  `firebase emulators:exec --only firestore,auth --project vultus-cab62 "<the nx e2e command>"`
  so Auth **and** Firestore are up for the run; `emulators:exec` exports
  `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` into the **Node-side**
  process env.
  - The **browser app** does **not** read those env vars — it connects to the
    **hardcoded** `localhost:9099` (Auth) / `localhost:8080` (Firestore) endpoints
    in `apps/mobile/src/app/firebase/emulators.ts`, gated by `useEmulators: true`
    in the dev AngularFire config (it is browser code; it cannot see process env).
  - Only the **Node-side `globalSetup` / support helpers** read
    `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST`, **falling back to
    `localhost:8080` / `localhost:9099`** when unset (e.g. a local `nx e2e` run
    against already-running emulators).
  - Per the **Emulator-port invariant** (Scope), the run must stay on the default
    8080/9099 ports because the browser app's endpoints are not runtime-configurable.

### Emulator endpoints (Firebase defaults, from `firebase.json`)

- Firestore: **`localhost:8080`** — clear: `DELETE /emulator/v1/projects/vultus-cab62/databases/(default)/documents`; seed via the Firestore REST `documents` write API.
- Auth: **`localhost:9099`** — clear: `DELETE /emulator/v1/projects/vultus-cab62/accounts`.
- Emulator UI: 4000 (unused by the harness).

### Fixed test uid

`globalSetup`/`beforeEach` use a single **fixed test uid constant** (e.g.
`E2E_TEST_UID`) so seeded docs and the app's session reconcile (Data model note).
The binding requirement is determinism, not the literal value: the **default
prescribed mechanism (a)** is — for `seeded`-fixture specs, let the app boot, read
the resolved anon uid from the page (via the shell's exposed uid signal surfaced to
the DOM, or `localStorage`/IndexedDB the Auth SDK persists), then seed
`users/{uid}/...` under **that** uid before driving the flow. If the implementer
finds reading the uid from the page brittle, the **documented fallback** is to
import a fixed anonymous Auth account so the uid is known up front — but that is a
fallback, recorded in the PR, not the default.

### Seed mechanism (single prescribed approach)

`apps/mobile-e2e/global-setup.ts` (Playwright `globalSetup`) and a per-suite
`beforeEach` reset:

1. **Clear** Auth + Firestore via the emulator REST clear endpoints above (no
   restart — fast, deterministic between tests).
2. **Load** the fixture for the suite: write the fixture docs to Firestore via the
   emulator REST `documents` API under the resolved test uid.

**Fixture encoding (the transform layer is explicit, not inferred):** the committed
`emulator-data/{empty,seeded}/` files are **plain domain JSON** (e.g.
`{ "status": "planned", "mediaType": "tv", … }`) — the human-readable PLAN §4
shapes. The **support helper encodes** them to the Firestore REST typed-value
format on write (e.g. `{ "fields": { "status": { "stringValue": "planned" } } }`).
The implementer writes that plain-JSON → REST-`fields` encoder in `src/support/*`;
do **not** commit pre-encoded REST payloads (they are unreadable and drift from the
domain types).

The `emulator-data/{empty,seeded}/` fixtures are the **source of truth for the
documents** (committed JSON describing the docs to write); the decision-record's
`--import`/`--export-on-exit` wording is satisfied by committing those fixtures and
loading them via REST — **REST clear+load between tests is the prescribed path**
(decision-record's "or via emulator REST API clear endpoint between tests"),
because `--import` only re-seeds at emulator **start**, not between tests, and
restarting the emulator per test is too slow for CI. The implementer MAY
additionally generate the `seeded/` fixture as a real emulator **export** (run the
app, add a title, `--export-on-exit`) and commit it for fidelity, but the runtime
mechanism the specs rely on is **REST clear + load**.

### TMDB interception contract

Every spec that searches calls
`page.route('**/api.themoviedb.org/**', route => route.fulfill({ json: <fixture> }))`
**before** navigating to Search, returning `apps/mobile-e2e/fixtures/tmdb-search-*.json`.
The fixture shape matches the real TMDB `search/multi` response the
`tmdb-search.client` parses (`results: [{ id, media_type, title|name,
poster_path, release_date|first_air_date, ... }]`). **No real key, no live call.**

## UI / Stitch screen refs

**Not applicable.** No UI is built or changed — this spec authors e2e tests that
drive the **already-implemented** Watchlist / Search / Settings pages (specs 0010,
0011, 0013, 0014). The specs assert against those pages' existing DOM (enumerated
in the Test plan): `ion-tab-button[tab="…"]`, `ion-searchbar`, the search result
`.result-card` / `.add-btn` (→ swapped for the disabled `.added-btn` /
`ion-icon[name="checkmark-circle"]` once added — a separate element, not an
in-place change), the watchlist `.watchlist-card` / `.empty-state`, the
settings `ion-select` region picker. No Stitch screen is consumed and no design
token is touched. (If any flow's assertion needs a stable hook the page lacks, the
implementer adds a minimal `data-testid` **in that page's own slice** as part of
this work and records it — but prefer the existing selectors above; none of the
8 flows currently appears to need a new hook.)

## Implementation task graph

The seed/emulator wiring, the Playwright config, and the CI step are **shared
foundation** every spec depends on, so they are **[sequential]** and land first.
The 8 flow specs live in **distinct files** and are **[parallel]** (pairwise
disjoint manifests). The fixtures (`emulator-data/`, `fixtures/`) are written in
the sequential foundation task so the parallel spec tasks consume a stable set.

1. **[sequential] Emulator/seed foundation, Playwright config, fixtures, CI, README.**
   (infrastructure-engineer + qa-runner territory — shared root + e2e-project
   scaffolding everything else imports/depends on.)
   - Rework `apps/mobile-e2e/playwright.config.ts`: chromium-only (R6), `baseURL`
     `http://localhost:4200`, keep the `nx run mobile:serve` `webServer`
     (`reuseExistingServer: true`), wire `globalSetup`, set CI retries + `trace:
'on-first-retry'`. The **Node-side `globalSetup`/support** read
     `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` from `emulators:exec`
     (falling back to `localhost:8080` / `localhost:9099`); the **browser app reads
     neither** — it hits the hardcoded 8080/9099 endpoints, so the run must stay on
     the default ports (Emulator-port invariant).
   - Write `apps/mobile-e2e/global-setup.ts` and a shared test helper
     (`src/support/*`) implementing the **Seed mechanism** (including the
     **plain-domain-JSON → Firestore REST `fields` encoder**) + the **TMDB
     interception** + the **fixed test uid** resolution (Public types / APIs).
   - Write the committed fixtures: `apps/mobile-e2e/emulator-data/empty/**`,
     `apps/mobile-e2e/emulator-data/seeded/**` (one TV watchlist entry + a
     `users/{uid}` region doc), and `apps/mobile-e2e/fixtures/tmdb-search-*.json`.
   - Add the `e2e` target to `apps/mobile-e2e/project.json` (env, command) so
     `nx e2e mobile-e2e` / `nx affected -t e2e` resolve it; keep `open`.
   - Verify-then-edit `firebase.json`: confirm Auth `9099` + Firestore `8080`
     (already present) — edit only if a gap; record "no change needed" if so.
   - Add the `e2e` step to `.github/workflows/ci.yml` as a **separate `run:`
     entry** — **not** folded into the existing
     `nx affected -t typecheck lint test build … --configuration=ci` line (ci.yml
     line ~86), precisely so the e2e run is **not** entangled with
     `--configuration=ci` (which the e2e target does not define). The new step runs
     **plain `nx affected -t e2e`** (no `--configuration`), wrapped in
     `firebase emulators:exec --only firestore,auth --project vultus-cab62`,
     installing the Playwright browser (chromium) in the job, needing **no
     secret**. Place it after the existing functions integration gate; ensure it
     runs on `pull_request` (so it gates) and on `push`. Optionally cache
     `~/.cache/ms-playwright` keyed on the Playwright version to skip re-downloading
     chromium (non-critical — see CI note below).
   - Write `apps/mobile-e2e/README.md` (run locally, Java/emulator prereq, fixtures
     location, the emulator-loopback caveat from project memory).
   - Files: `apps/mobile-e2e/playwright.config.ts`, `apps/mobile-e2e/global-setup.ts`,
     `apps/mobile-e2e/src/support/**`, `apps/mobile-e2e/emulator-data/empty/**`,
     `apps/mobile-e2e/emulator-data/seeded/**`, `apps/mobile-e2e/fixtures/tmdb-search-*.json`,
     `apps/mobile-e2e/project.json`, `apps/mobile-e2e/README.md`,
     `.github/workflows/ci.yml`, `firebase.json` (only if a gap).

2. **[parallel] Flow 1 — app boot + anon auth + empty watchlist (`app.boot.spec.ts`).**
   - Uses the **`empty`** fixture. Assertions per Test plan F1.
   - Files: `apps/mobile-e2e/src/app.boot.spec.ts`.

3. **[parallel] Flows 2–3 — search + add to watchlist (`search.spec.ts`).**
   - Uses the **`empty`** fixture + TMDB interception. Assertions per Test plan F2–F3.
   - Files: `apps/mobile-e2e/src/search.spec.ts`.

4. **[parallel] Flows 4–6 — title-detail open / change status / remove (`title-detail.spec.ts`).**
   - Uses the **`seeded`** fixture. **`test.fixme`-gated pending the title-detail
     slice (R1)** — authored fully but marked `test.fixme` (or `test.describe.skip`
     with a `// TODO(spec 0016/PLAN §6 item 19)` annotation) so the suite is green
     and the specs un-skip when the slice + `tabs/title-detail/:titleId` route land.
   - Files: `apps/mobile-e2e/src/title-detail.spec.ts`.

5. **[parallel] Flow 7 — settings region persists (`settings.spec.ts`).**
   - Uses the **`seeded`** fixture. Assertions per Test plan F7.
   - Files: `apps/mobile-e2e/src/settings.spec.ts`.

6. **[parallel] Flow 8 — watchlist pull-to-refresh (`watchlist-refresh.spec.ts`).**
   - Uses the **`seeded`** fixture. **Reframed (R2):** the implemented
     pull-to-refresh **re-subscribes the Firestore stream**, it does **not** call an
     HTTP sync function. The spec asserts the **actual** behavior (refresher
     completes; the list re-renders from the emulator stream) and the
     **decision-record's HTTP-sync assertion is authored `test.fixme`** with a
     `// TODO(PLAN §6 items 11–12: manual sync callable)` annotation + a
     `page.route` stub of the sync endpoint **ready** for when the callable is
     wired. Do **not** assert an HTTP call the app never makes.
   - Files: `apps/mobile-e2e/src/watchlist-refresh.spec.ts`.

(The existing `src/app.smoke.spec.ts` no-emulator smoke spec is **kept as-is** —
it is a fast guard that needs no emulator; flow 1's `app.boot.spec.ts` is the
emulator-backed superset. The implementer MAY note the overlap in the PR; do not
delete the smoke spec, it still runs under the no-backend `webServer` path.)

7. **[sequential] Update AI agent/skill tooling (`.claude/`).**
   (infrastructure-engineer territory — these are root config files, not Nx
   projects; no Sheriff boundary applies. Run after task 1 so the e2e harness
   exists before the tooling refers to it.)

   Apply the following targeted edits. Each change is minimal — add only what is
   described; do not rewrite surrounding content.

   - **`.claude/agents/spec-author.md` — Test plan section (item 8).**
     After `e2e (which named flows, if any)`, append the following rubric
     as a new indented block:

     > **e2e decision rubric** (apply before writing this section):
     >
     > - **Required** — any `scope:mobile` feature that introduces or substantially
     >   changes a primary user-facing navigation route or critical action (new page,
     >   add-to-watchlist, status change, settings persistence). Name each flow
     >   explicitly; they become DoD gates enforced by `qa-runner` and
     >   `feature-reviewer`.
     > - **Fixme-gated** — if a flow depends on a spec not yet merged (e.g. a new
     >   route that another slice provides), mark it `test.fixme` with a comment
     >   naming the blocking spec/PLAN item. Include the stub in the task graph so
     >   the implementer un-skips it when the dependency lands.
     > - **Not required** — `scope:functions`-only changes, pure refactors with no
     >   route/action change, infra/CI/config specs. State "No e2e flows required —
     >   backend/infra change only." explicitly so the omission is intentional.
     > - **Never omit silently.** Always include this section with one of the three
     >   outcomes above.

   - **`.claude/skills/create-spec/SKILL.md` — Step 1 (Interview), after the
     "present options with a recommendation" bullet.**
     Insert:

     > - **e2e probe (mobile UI features):** if the feature introduces a new
     >   page/route or a critical user action (add, remove, status change,
     >   navigation), ask which flows should be covered by e2e and whether any
     >   depend on unmerged specs (→ `test.fixme`). Record the approved flows in
     >   the decision record so `spec-author` names them explicitly in the Test
     >   plan section.

   - **`.claude/agents/spec-reviewer.md` — Review checklist item 5
     (Testability), after the existing sentence.**
     Append:

     > For a `scope:mobile` spec that adds a new route or critical user action:
     > the absence of e2e flows must be **explicitly justified** (e.g. "No e2e
     > flows required — backend-only change"). If it is a new page or primary
     > action with no e2e coverage and no explanation, that is a **blocking
     > finding** — the spec-author must either add named flows or document why e2e
     > is not required. A `test.fixme`-gated flow (blocked on an unmerged spec) is
     > acceptable, but the blocking dependency must be named.

   - **`.claude/agents/qa-runner.md` — Degradation section, after the first
     bullet ("If a gate's tooling genuinely isn't bootstrapped yet …").**
     Insert a new bullet before the "But if the spec explicitly required …" bullet:

     > - **e2e is bootstrapped once `apps/mobile-e2e/playwright.config.ts`
     >   exists** — check for that file before deciding to skip. After spec 0019
     >   merges, e2e is never "not bootstrapped" for `scope:mobile` work; skipping
     >   it requires an explicit spec justification. `test.fixme`-gated flows are
     >   expected and do not count as failures — they are scaffolded pending stubs;
     >   the suite still runs and marks them pending, not failing.

   - **`.claude/agents/feature-reviewer.md` — Review dimension 4 (Tests),
     after the existing sentences.**
     Append:

     > Also check `apps/mobile-e2e/src/` for any `test.fixme`-gated flows that
     > were blocked on the spec being reviewed. If this PR delivers the dependency
     > they name (e.g. a new route, a new component selector), those flows must be
     > **un-skipped** — leaving them as `test.fixme` after the dependency lands is
     > a **blocking finding**.

   - **`.claude/skills/implement-feature/SKILL.md` — Step 4 (Implement), after
     the "Lib README currency is part of done" bullet.**
     Insert:
     > - **e2e fixme un-skip (mobile UI specs):** before fanning out, grep
     >   `apps/mobile-e2e/src/` for `test.fixme` annotations that reference this
     >   spec number or slug. If any exist, include un-skipping them as an explicit
     >   task in the foundation or the relevant parallel task — the implementer
     >   removes the `test.fixme` wrapper and verifies the flow passes. The
     >   `feature-reviewer` enforces this; flag it if you discover it late.

   Files: `.claude/agents/spec-author.md`, `.claude/skills/create-spec/SKILL.md`,
   `.claude/agents/spec-reviewer.md`, `.claude/agents/qa-runner.md`,
   `.claude/agents/feature-reviewer.md`, `.claude/skills/implement-feature/SKILL.md`.

Manifests 2–6 are pairwise disjoint (distinct spec files); the shared
`support/`, fixtures, and config are all written by task 1. Task 7 touches only
`.claude/` files, which are disjoint from everything in tasks 2–6.

## Test plan

The deliverable **is** the test suite. Per PLAN §5 the pyramid's **e2e** tier is
"5–10 named critical flows, Playwright against the Firebase emulators" — this spec
fills exactly that tier (8 flows). No new unit/component tests are added (the
slices they exercise already carry their own — specs 0011/0013/0014).

**e2e flows (chromium, emulator-backed, TMDB intercepted):**

- **F1 — boot → anon auth → empty watchlist** (`empty`): `goto('/')` → URL
  `/tabs/watchlist`; the three `ion-tab-button`s render; the **empty state** shows
  (`.empty-state` / "Your watchlist is empty"); the app reports a non-null anon uid
  (auth resolved against the emulator).
- **F2 — search → result cards** (`empty`, TMDB stubbed): tab to Search; type a
  query into `ion-searchbar` (`(ionInput)`); the fixture results render as
  `.result-card` with the expected title(s); the prompt/loading/no-results states
  behave (assert at least the results state).
- **F3 — search → add → appears as "planned"** (`empty`, TMDB stubbed): from F2
  results, click `.add-btn` (`onAdd`). The added state is a **separate element
  swap**, not an in-place mutation: assert the disabled `.added-btn`
  (`ion-icon[name="checkmark-circle"]`) **appears** AND the `.add-btn`
  **disappears** (the `@if (result.added)` branch replaces the button). Then
  navigate to Watchlist; the added title renders in a `.watchlist-card`
  under the **Planned** section (PLAN §4 default `status: "planned"`), persisted in
  the Firestore emulator.
- **F4 — watchlist → tap title → title-detail opens** (`seeded`) — **`test.fixme`
  (R1)**: tap the seeded `.watchlist-card` (`navigateToDetail` →
  `tabs/title-detail/:titleId`); the title-detail page opens showing the seeded
  entry's metadata. _Un-skips when spec 0016 lands._
- **F5 — title-detail → change status (planned → watching) → watchlist reflects**
  (`seeded`) — **`test.fixme` (R1)**: change status on the detail page; return to
  Watchlist; the card now sits under the **Watching** section. _(Watchlist's own
  status-change via the action sheet — `openStatusSheet`/`updateStatus` — is
  already runnable and MAY be asserted here as the non-fixme part if the implementer
  wants F5 partially green; the title-detail-originated change is the fixme part.)_
- **F6 — title-detail → remove → watchlist empty** (`seeded`) — **`test.fixme`
  (R1)**: remove from the detail page; Watchlist shows the empty state. _(Watchlist's
  own swipe/alert remove — `onDeleteConfirm`/`onDeleteItem` — is already runnable
  and MAY be the non-fixme part.)_
- **F7 — settings → change region → persists across navigation** (`seeded`): tab to
  Settings; change the region `ion-select` (`onRegionChange`); navigate away
  (Watchlist) and back; the select still shows the new region; assert it persisted
  to `users/{uid}.region` in the emulator.
- **F8 — watchlist → pull-to-refresh → success** (`seeded`) — **reframed (R2)**:
  trigger `ion-refresher` (`onRefresh`); assert the refresher **completes** and the
  list re-renders from the emulator stream (no error). The decision-record's
  "**sync HTTP function call is triggered and returns success**" assertion is
  authored **`test.fixme`** with a `page.route` **stub of the sync endpoint** wired
  and ready — un-skips when the manual sync callable (PLAN §6 items 11–12) is wired
  into pull-to-refresh.

**Determinism guards (apply to every spec):** seed reset in `beforeEach`
(clear+load), TMDB `page.route` registered before navigation, await Ionic
transitions/`networkidle` rather than fixed sleeps, and a single fixed test uid.

## Definition of done

Tailored from the PLAN §5 checklist for an e2e-infrastructure spec:

- [ ] `apps/mobile-e2e/playwright.config.ts` runs **chromium**, `baseURL`
      `localhost:4200`, keeps the `nx run mobile:serve` `webServer`, wires
      `globalSetup`, and reads the emulator host env from `emulators:exec`.
- [ ] `global-setup.ts` + `src/support/**` implement the **clear+load REST seed**,
      the **fixed test uid** resolution, and the **TMDB `page.route` interception** —
      with **no `TMDB_API_KEY`, no secret, no live network**.
- [ ] Committed fixtures exist: `emulator-data/empty/**`, `emulator-data/seeded/**`
      (one TV watchlist entry + region doc), `fixtures/tmdb-search-*.json`.
- [ ] All 8 flow spec files exist; the **runnable** flows (F1, F2, F3, F7, F8's
      re-subscribe assertion, and any non-fixme parts of F5/F6) pass **green
      against the emulators**; the **deferred** flows (F4, F5/F6 title-detail parts,
      F8's HTTP-sync assertion) are **`test.fixme`** with a `// TODO` referencing
      the owning spec (R1/R2) — the suite is green, not red, with them pending.
- [ ] `apps/mobile-e2e/project.json` exposes a working **`e2e`** target;
      `pnpm nx affected -t e2e` selects it when `mobile`/`mobile-e2e` change.
- [ ] `.github/workflows/ci.yml` runs the e2e suite as a **separate `run:` step**
      (plain `nx affected -t e2e`, **not** folded into the `--configuration=ci`
      target line) **wrapped in `firebase emulators:exec --only firestore,auth`** on
      `pull_request` and `push`, installs the chromium browser, **adds no secret**,
      and does **not** start the Functions emulator (Java is already set up in the
      job).
- [ ] `firebase.json` Auth/Firestore ports confirmed (edit only if a gap; PR records
      "no change needed" if not).
- [ ] `nx lint mobile-e2e` passes; the e2e project imports **no workspace source**
      and introduces **no Sheriff boundary violation**.
- [ ] `apps/mobile-e2e/README.md` documents the local run, the Java/emulator
      prereq, the fixtures, and the loopback caveat.
- [ ] PR records: the resolved seed mechanism (default vs uid-import fallback),
      that **no secret was added**, that the **Functions emulator is not started**
      (flow 8 stubbed), and that **F4–F6 + F8's sync assertion are `test.fixme`
      pending specs 0016 / PLAN §6 items 11–12** (R1/R2) — so a green suite is not
      mistaken for full coverage of those flows.
- [ ] All 6 AI tooling files updated per task 7 with the exact insertions described
      (no rewrites of surrounding content). Future `/create-spec` runs probe for e2e
      flows; future `spec-reviewer` runs flag missing coverage; `qa-runner` treats
      e2e as bootstrapped once `playwright.config.ts` exists; `feature-reviewer`
      catches un-skipped `test.fixme` flows; `implement-feature` greps for them
      before fan-out.

## Risks

- **R1 — `title-detail` slice is NOT implemented in this base; flows 4–6 (and the
  navigation in flow 4) cannot pass yet. (PLAN/decision conflict — surfaced, not
  designed around.)** Verified in this worktree: `libs/mobile/title-detail/` is
  **empty**, there is **no `@vultus/mobile/title-detail` tsconfig path**, and
  **`app.routes.ts` registers no `tabs/title-detail/:titleId` route**. The watchlist
  card's `navigateToDetail` deliberately **catches and no-ops** when that route is
  absent (spec 0014). Spec **0016** (title-detail) is **spec-merged on `main` but
  the feature is unimplemented** — flows 4–6 depend on it. **Resolution:** author
  `title-detail.spec.ts` fully but `test.fixme`-gate it with a `// TODO(spec 0016 /
PLAN §6 item 19)` so the suite stays green and the specs un-skip the moment the
  slice + route land. **Do NOT** fake a route or stub a detail page to "make it
  pass" — that would hide the missing slice. The runnable status-change/remove
  behavior the **watchlist** page already owns (action sheet / swipe-alert) MAY be
  asserted as the non-fixme parts of F5/F6.
- **R2 — pull-to-refresh does NOT call an HTTP sync function; flow 8 as written in
  the decision record asserts behavior the app does not have. (PLAN/decision
  conflict — surfaced.)** The implemented `WatchlistPage.onRefresh` **re-subscribes
  the Firestore stream and completes the refresher** — it makes **no HTTP/callable
  sync call** (spec 0014 explicitly deferred the manual rate-limited sync callable;
  PLAN §6 items 11–12 / item 18). **Resolution:** F8 asserts the **real** behavior
  (refresher completes, list re-renders from the emulator) as the runnable part, and
  the decision-record's "sync HTTP function call is triggered and returns success"
  is authored **`test.fixme`** with the `page.route` sync-endpoint stub wired and
  ready, annotated `// TODO(PLAN §6 items 11–12)`. The Functions emulator is **not**
  started (consistent with the decision record's "function NOT actually called").
- **R3 — anon uid ↔ seed uid coupling.** The app boots a fresh anonymous session
  with a non-deterministic uid, but the `seeded` docs must live under the uid the
  app uses. Mitigated by the **prescribed seed mechanism** (Public types / APIs):
  read the resolved uid from the page after boot and seed under it (default), or
  import a fixed anon Auth account (fallback). A naive "seed under a hardcoded uid"
  would silently show an **empty** watchlist (owner mismatch) — the implementer must
  verify the seeded entry actually renders for F4–F8's setup.
- **R4 — emulator loopback under Claude Code tools (project memory).** Per project
  memory, the **Firestore/Auth emulators cannot run via Claude Code's tools here
  (loopback blocked)**, so the implementing agent **cannot execute the full
  emulator-backed e2e in-session** — it verifies config/lint/typecheck and the spec
  authoring, and the **emulator-backed run is validated in CI and by the user's own
  terminal** (same posture specs 0004/0009 took). The PR must state this explicitly
  rather than claim a green local e2e run that the sandbox cannot produce.
- **R5 — render gating vs no-backend webServer.** The `webServer` runs
  `nx serve mobile` (dev → emulators); under `emulators:exec` the emulators **are**
  up, so anon sign-in resolves and the shell renders normally. The shell already
  degrades gracefully if sign-in fails (spec 0010), so even a transient emulator
  hiccup won't hang the boot. No `webServer` change is needed beyond `globalSetup`.
- **R6 — chromium-only is a deliberate narrowing of the scaffold.** The Nx scaffold
  lists chromium/firefox/webkit; running three browsers triples CI e2e time for an
  app whose only target is **Android WebView (Capacitor)** — chromium is the closest
  proxy and the right single gate. Documented so a reviewer doesn't read the dropped
  projects as an omission; adding more browsers later is a config one-liner.
- **R7 — Java + chromium install in CI.** `emulators:exec` needs Java (already set
  up in the `main` job for the functions integration gate) and Playwright needs its
  chromium binary installed in the job. Mitigated by reusing the existing Java setup
  and adding a `playwright install --with-deps chromium` step before the e2e run;
  the Nx cache keeps the rest cheap. **No new secret** is involved. _(Optional, non-
  critical: cache `~/.cache/ms-playwright` keyed on the installed Playwright version
  to avoid re-downloading chromium on every run — skip if it complicates the job.)_
- **No TMDB/Trakt accuracy caveat applies** — all external data is **intercepted
  fixtures**, so data-source flakiness (PLAN §2/§9) is irrelevant to this gate by
  construction.
