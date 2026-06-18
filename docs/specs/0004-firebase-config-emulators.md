---
number: 0004
slug: firebase-config-emulators
title: Commit version-controlled Firebase config and wire up the local Emulator Suite
status: approved
slices: []
scopes: [scope:shared]
created: 2026-06-18
---

# Commit version-controlled Firebase config and wire up the local Emulator Suite

## Context

The Nx workspace exists (spec 0001) and CI gates run on every PR (spec 0002),
but the repository has **no Firebase configuration at all** — there is no
`firebase.json`, `.firebaserc`, `firestore.rules`, or `firestore.indexes.json`
anywhere in the tree. `apps/functions` is a deployable stub (`healthcheck`
placeholder only), and CLAUDE.md already promises `firebase emulators:start`
"once Firebase is configured in a later spec." **This is that spec.**

This implements **PLAN §6 foundation item 4** ("Firebase project + emulators"):
the manual one-time console step (create the project, enable Firestore / Auth /
FCM) is the human's job (PLAN §7 — already provisioned, real project id
`vultus-cab62`); this spec commits the **version-controlled Firebase config**
and **wires the local Firebase Emulator Suite** so any contributor can run
Firestore + Auth locally and so the PLAN §4 data-model access rules are codified
and **tested against the emulator**.

This is **foundation infrastructure, not a slice**, and is owned end-to-end by
the **infrastructure-engineer**. It is independent of the open `shared/domain`
types PR (PLAN §6 item 5) — no domain type or converter is touched here. The
security rules enforce **access control** per PLAN §4 (who can read/write which
path); **schema/field validation is deliberately deferred** to the
`shared/firestore-schema` converters (PLAN §6 item 6).

The intended outcome: `firebase emulators:start` boots Firestore + Auth + the
Emulator UI on documented ports against `vultus-cab62`; the committed
`firestore.rules` lock the database to the PLAN §4 ownership model; and an
automated `@firebase/rules-unit-testing` suite proves the key allow/deny cases
against the Firestore emulator via a single reproducible command.

## Scope

In scope:

- **`.firebaserc`** — default project alias pointing at the real Firebase
  project id **`vultus-cab62`**. This id is **not a secret** (it appears in
  client config and URLs); it is committed deliberately.
- **`firebase.json`** — emulator configuration (Firestore, Auth, Emulator UI;
  ports below) plus the `firestore` block referencing `firestore.rules` and
  `firestore.indexes.json`, and the emulator data import/export wiring (see Seed
  data below).
- **`firestore.rules`** — production-mode security rules implementing the full
  PLAN §4 access-control lockdown (see **Data model touchpoints** for the exact
  rule contract).
- **`firestore.indexes.json`** — **empty skeleton** (`{"indexes": [],
  "fieldOverrides": []}`). Composite indexes are added **per slice** when a real
  query needs one; this spec ships none and says so explicitly so slice authors
  know to add their own.
- **Emulator Suite wiring** for local dev: **Firestore + Auth + Emulator UI
  only**. The **Functions emulator is intentionally NOT configured** here
  (`apps/functions` is a stub — it is added in the functions specs, PLAN §6
  items 9-14).
- **Automated rules tests** (`@firebase/rules-unit-testing`, Vitest) in a
  dedicated Nx project run against the Firestore emulator via
  `firebase emulators:exec` (see **Implementation task graph** and **Test
  plan**).
- **`firebase-tools`** pinned as a workspace **devDependency** (cleaner and more
  reproducible than `npx` for CI), plus convenience pnpm scripts and the
  canonical commands documented.
- **`.gitignore`** entry for the local, gitignored emulator data dir
  (`.emulator-data/`).

Out of scope (each is its own later spec / manual step):

- **The manual Firebase console setup** (create project, enable Firestore / Auth
  Anonymous / FCM / Functions) — PLAN §7, the human's one-time step. Already
  provisioned; this spec only commits config that targets it.
- **The Functions emulator** and any Cloud Functions emulator wiring — deferred
  to the functions specs (PLAN §6 items 9-14), when there are real handlers.
- **Composite Firestore indexes** — `firestore.indexes.json` ships empty;
  per-slice index additions belong to each slice's own spec when its queries
  exist.
- **Schema / field-shape validation in rules** — rules enforce access control
  only; field-level schema is enforced by `shared/firestore-schema` converters
  (PLAN §6 item 6). A note in the rules marks deeper validation as deferred.
- **Committed seed data / fixtures** — none shipped. The emulator can
  export/import to a **local, gitignored** dir; no fixtures land in git.
- **Running the rules tests in the existing CI workflow** — see **CI story**
  below; the decision is to make them reproducible locally now and defer CI
  integration to a noted follow-up (PLAN §6 item 20 e2e/emulator spec), rather
  than silently claim CI covers them.
- **Deploying rules** (`firebase deploy --only firestore:rules`) — deployment is
  a separate manual/ops step; the specs workflow ends at a merged PR (specs
  README).

### €0 / no-secret invariant

The emulators run with **no real credentials** — `@firebase/rules-unit-testing`
talks to the local Firestore emulator over a fake project id, and the only
project identifier committed is the **non-secret** `vultus-cab62` in
`.firebaserc`. This spec **reads and writes no secret** (CLAUDE.md rule): no
TMDB/Trakt key, no FCM service account, no `.env.local`. If any step appears to
need a secret (it should not), the implementer must **stop and flag it** in the
PR rather than invent or wire one.

## Affected slices & Sheriff tags

No slice is built (`slices: []`). The work is **root config files** plus one
small **tools-level test project**, owned by the infrastructure-engineer.

**Frontmatter `scopes: [scope:shared]` is intentional** (not the full
`scope:mobile`/`scope:functions` triple of 0001/0002): this spec touches **no
scoped lib**, and the `tools/firestore-rules-test` project is **untagged** at the
Nx/Sheriff level (see below). The single `scope:shared` tag reflects that the
only thing it produces is workspace-root infra usable by anyone, with no
mobile/functions code in play.

The root Firebase config files (`.firebaserc`, `firebase.json`,
`firestore.rules`, `firestore.indexes.json`, `.gitignore`) are **not inside any
Nx project** and carry **no Sheriff tag** — no boundary rule applies to them
(same as spec 0002's `.github/workflows/ci.yml`).

The rules-test project **does** become an Nx project. It is modeled exactly on
the existing `tools/sheriff-test` precedent (spec 0001): a `tools/`-level Vitest
project with **`tags: []`** in `project.json`. Per `sheriff.config.ts`, Sheriff
tags **by path glob**, and `tools/firestore-rules-test` matches **no** module
glob (`apps/*`, `libs/shared/*`, `libs/mobile/*`, `libs/functions/*`), so it is
**untagged** to Sheriff and falls under the `noTag: () => true` dep rule — it may
import `@firebase/rules-unit-testing` and node built-ins freely without violating
any boundary, and it imports **no slice and no scope lib** (it reads the root
`firestore.rules` file at runtime, it does not import workspace code). This is
**infra test tooling, not a slice** — it does not participate in the
vertical-slice architecture, exactly like `tools/sheriff-test`.

| Touched | Path | Sheriff tags |
|---|---|---|
| Firebase root config | `.firebaserc`, `firebase.json`, `firestore.rules`, `firestore.indexes.json` | none (not an Nx project) |
| Rules-test project | `tools/firestore-rules-test/**` | none (`tools/*` matches no module glob → untagged) |
| `.gitignore` | repo root | none |

**Why a new `tools/` project and not a slice:** these are emulator-backed
integration tests for root infra config. They are not mobile or functions code,
share no logic with any slice, and must not be importable by slices. The
`tools/sheriff-test` pattern (already in the repo) is the established home for
"workspace-level guard tests that aren't a slice." This is **not** a premature
`shared/` extraction (CLAUDE.md 3+-slice rule) — it shares nothing.

## Data model touchpoints

This spec **codifies access control over the entire PLAN §4 data model** in
`firestore.rules`. No collections or fields are *created* (Firestore is
schemaless; documents appear when written by later specs), but every path in
PLAN §4 gets an explicit rule. The rule contract, exactly:

**Default: deny all.** A top-level `match /{document=**}` with
`allow read, write: if false;` so anything not explicitly allowed below is
denied.

**User-owned data — owner-only.** For `users/{userId}` **and all its
subcollections**, allow `read, write` **only** when
`request.auth != null && request.auth.uid == userId`:

- `users/{userId}`
- `users/{userId}/watchlist/{titleId}`
- `users/{userId}/watchlist/{titleId}/episodes/{episodeId}`
- `users/{userId}/notifications/{notificationId}`

Implement with a `match /users/{userId} { ... match /{document=**} { allow
read, write: if isOwner(userId); } }` recursive-wildcard pattern, plus the
`users/{userId}` doc itself, so every current and future subcollection under a
user is owner-locked by default. **Anonymous auth counts:** Firebase Auth sets
`request.auth.uid` for anonymous users (PLAN §2 uses anonymous auth in v1), so
`request.auth.uid == userId` is satisfied by the signed-in anonymous user — note
this in a rules comment so nobody "adds an anonymous exception."

**Global cache — authenticated read, never client-write.** For
`title-cache/{tmdbId}` **and** its `availability/{region}` subcollection:

- `allow read: if request.auth != null;` (any authenticated user, incl.
  anonymous, may read the shared cache)
- `allow write: if false;` (clients may **never** write)

**Critical correctness note (must be a comment in `firestore.rules`):** all
writes to `title-cache` come from **Cloud Functions via the Firebase Admin
SDK**, and the **Admin SDK bypasses Firestore security rules entirely**.
Therefore the correct client rule is `write: if false` **always** — do **not**
add a "functions can write" allowance, because functions don't go through rules
at all. A future contributor's instinct to "add a write rule for the sync
function" would be wrong and is pre-empted by this comment.

**Field/schema validation: deferred.** Rules stay focused on access control;
they do **not** validate `status` enums, timestamp shapes, etc. A short comment
records that field-level validation lives in `shared/firestore-schema`
converters (PLAN §6 item 6), not here.

`firestore.indexes.json` ships **empty** — no composite indexes. Per-slice query
indexes are each slice spec's responsibility.

## Public types / APIs

No domain types, function signatures, HTTP endpoints, or callable shapes are
introduced (the `shared/domain` PR is independent and untouched). The stable
"public surface" this spec fixes for later specs to depend on:

- **Firebase project alias:** `default` → `vultus-cab62` (in `.firebaserc`).
- **Emulator ports** (Firebase defaults, pinned explicitly in `firebase.json`):
  - Firestore: **8080**
  - Auth: **9099**
  - Emulator UI: **4000** (`ui.enabled: true`)
  - (Functions emulator: **not configured** — added later.)
- **Emulator data dir:** `./.emulator-data` (gitignored), used by
  `--import` / `--export-on-exit`.
- **pnpm scripts** (in root `package.json`), names fixed so later specs/CI can
  call them:
  - `emulators` → `firebase emulators:start --import ./.emulator-data
    --export-on-exit ./.emulator-data`
  - `emulators:clean` → `firebase emulators:start` (no import/export — fresh
    state)
  - `test:rules` → the `firebase emulators:exec` rules-test command (see task
    graph) — the canonical way to run the rules tests.
- **Nx target:** `tools/firestore-rules-test` exposes a `test-rules` target that
  runs the `emulators:exec` command, so it is invokable as
  `pnpm nx run firestore-rules-test:test-rules`. Its auto-inferred (`@nx/vitest`)
  `test` target uses the project's **default** vite config, whose `include` is
  set so it matches **zero** files (it must **not** match `*.rules.spec.ts`) —
  so the bare `test` target collects no specs and is a no-op in CI (see the
  **Required test-isolation mechanism** below).

### Required test-isolation mechanism (single, prescribed)

This is the **one required mechanism** — not an alternative to `passWithNoTests`.
`@nx/vitest` auto-infers a `test` target for any project with a vite config, and
`nx.json` `targetDefaults` sets `passWithNoTests: true` **globally**. CI runs
`nx affected -t lint test build` and `nx run-many -t test --all`, so the inferred
`test` target for `tools/firestore-rules-test` **will** be invoked in CI with no
emulator and no Java. `passWithNoTests` only short-circuits when **zero** files
match the Vitest `include`; it does **not** skip files that **do** match. So the
rules specs must be named such that the **default `test` target's `include` does
not match them at all**, otherwise they get collected and executed bare in CI and
fail/hang.

Therefore, all four of the following are **required** and must be mutually
consistent everywhere they appear:

1. **Rules spec filenames use a distinct pattern:**
   `tools/firestore-rules-test/src/**/*.rules.spec.ts` (concretely the single
   file `tools/firestore-rules-test/src/firestore-rules.rules.spec.ts`). Do **not**
   use a bare `*.spec.ts` — that is exactly what the default include picks up.
2. **The default `vite.config.mts` `include` does NOT match `*.rules.spec.ts`.**
   Set the default `test.include` to a pattern that cannot catch the rules specs
   (e.g. exclude `**/*.rules.spec.ts`, or set `include` to a sentinel that no
   file matches). The bare `nx test` / `nx run-many -t test` graph must collect
   **zero** rules specs so CI stays green with no emulator.
3. **A separate rules vitest config** (e.g.
   `tools/firestore-rules-test/vitest.rules.config.mts`) has its own `include`
   that **does** match `**/*.rules.spec.ts`.
4. **The `test-rules` target runs the emulator-only command** —
   `firebase emulators:exec --only firestore "vitest run -c
   vitest.rules.config.mts"` — so the rules specs only ever execute with the
   Firestore emulator up.

`passWithNoTests` alone is **insufficient** here, because the rules spec files
would match the default include and be collected/run.

## UI / Stitch screen refs

Not applicable. No mobile UI is built; this is Firebase/infra configuration and
emulator-backed tests only.

## Implementation task graph

All work is root config plus one tools-level test project; each step depends on
the previous (config files must exist before the emulator can run; the emulator
config must exist before the rules tests can exec against it). There is **no
genuinely parallel work** — do not invent any. All tasks are **[sequential]** and
run by a single **infrastructure-engineer**.

1. **[sequential] Add `firebase-tools` and the project config files.**
   - Add `firebase-tools` as a pinned **devDependency** (latest stable at
     implementation time, then lock the resolved version + `pnpm-lock.yaml`,
     matching the spec-0001 "latest-then-pin" convention). Note **Java is a
     runtime prereq** for the Firestore emulator (document it; see Risks).
   - Write `.firebaserc` with `{"projects": {"default": "vultus-cab62"}}`.
   - Write `firestore.indexes.json` as the empty skeleton
     `{"indexes": [], "fieldOverrides": []}` with a comment/PR note that
     per-slice indexes are added later.
   - Write `firebase.json`:
     - `firestore`: `{ "rules": "firestore.rules", "indexes":
       "firestore.indexes.json" }`.
     - `emulators`: `firestore` (port 8080), `auth` (port 9099),
       `ui` (`enabled: true`, port 4000), and `singleProjectMode` as
       appropriate. **No `functions` emulator block.**
   - Files: `package.json` (devDep + scripts), `pnpm-lock.yaml`, `.firebaserc`,
     `firebase.json`, `firestore.indexes.json`.

2. **[sequential] Author `firestore.rules` per the Data model touchpoints
   contract.**
   - `rules_version = '2';` Default deny-all; owner-only `users/**` (recursive
     wildcard, anonymous-uid note); `title-cache/**` authenticated-read +
     client-write-deny with the **Admin-SDK-bypasses-rules** comment; the
     field-validation-deferred comment.
   - Files: `firestore.rules`.

3. **[sequential] Scaffold the `tools/firestore-rules-test` Nx project.**
   - Model on `tools/sheriff-test`: `project.json` (`tags: []`,
     `projectType: "library"`), `tsconfig.json` / `tsconfig.spec.json`,
     `vite.config.mts` (Vitest, `environment: 'node'`).
   - Add `@firebase/rules-unit-testing` as a pinned devDependency.
   - **Apply the required test-isolation mechanism (Public types / APIs):**
     - The **default** `vite.config.mts` `test.include` must **not** match
       `*.rules.spec.ts` (e.g. set `include` to a sentinel no file matches, or
       add `exclude: ['**/*.rules.spec.ts']`). This is what keeps the
       auto-inferred `test` target — which CI **does** invoke — collecting
       **zero** specs, so it is a no-op despite the global
       `passWithNoTests: true`. `passWithNoTests` alone is insufficient because
       the rules specs would otherwise match the default `src/**/*.spec.ts`
       include and run bare in CI with no emulator.
     - Add a **separate** rules vitest config
       (`tools/firestore-rules-test/vitest.rules.config.mts`, `environment:
       'node'`) whose `include` is `['src/**/*.rules.spec.ts']`.
     - Define the `test-rules` target whose command is the `emulators:exec`
       invocation in task 5 (so `pnpm nx run firestore-rules-test:test-rules`
       works), pointing the inner `vitest run -c vitest.rules.config.mts`.
     - Verify `nx affected -t test` / `nx run-many -t test --all` stay green
       with the new project present (the inferred `test` target collects no
       rules specs). Document this in the PR.
   - Files: `tools/firestore-rules-test/project.json`,
     `tools/firestore-rules-test/tsconfig.json`,
     `tools/firestore-rules-test/tsconfig.spec.json`,
     `tools/firestore-rules-test/vite.config.mts`,
     `tools/firestore-rules-test/vitest.rules.config.mts`, `package.json`,
     `pnpm-lock.yaml`.

4. **[sequential] Write the rules-test specs.**
   - `@firebase/rules-unit-testing` `initializeTestEnvironment` against the
     Firestore emulator, loading the committed `firestore.rules`. `firebase
     emulators:exec` sets `FIRESTORE_EMULATOR_HOST`, which
     `initializeTestEnvironment` reads **automatically**; do **not** hardcode a
     host — the pinned `8080` is only a documented **fallback** so a contributor
     who customizes the port in `firebase.json` is not overridden by a divergent
     hardcoded value. Prove the cases in **Test plan**. Use `assertSucceeds` /
     `assertFails` helpers.
   - Files: `tools/firestore-rules-test/src/firestore-rules.rules.spec.ts`.

5. **[sequential] Wire the invocation + scripts and `.gitignore`.**
   - Canonical command (Firestore-only emulator, since rules tests need just
     Firestore): `firebase emulators:exec --only firestore "vitest run -c
     tools/firestore-rules-test/vitest.rules.config.mts"` — i.e.
     `emulators:exec` boots the Firestore emulator (setting
     `FIRESTORE_EMULATOR_HOST`), runs Vitest against the **rules** config (whose
     `include` matches `*.rules.spec.ts`), and tears the emulator down. The exact
     inner runner is the implementer's choice, but it **must** target the rules
     config — never the default `test` target — so the `*.rules.spec.ts` files
     are the ones collected. Pin it and record it. Expose it as the root
     `test:rules` pnpm script **and** the `tools/firestore-rules-test:test-rules`
     Nx target so both work.
   - Add `.emulator-data/` to `.gitignore`.
   - Document in the PR (and a short `README` note alongside `firebase.json` is
     acceptable) the dev commands: `pnpm emulators`
     (`firebase emulators:start --import ./.emulator-data --export-on-exit
     ./.emulator-data`) and `pnpm test:rules`.
   - Files: `package.json` (scripts), `.gitignore`,
     `tools/firestore-rules-test/project.json` (target).

6. **[sequential] Verify locally.**
   - `pnpm install` clean; `firebase emulators:start` boots Firestore + Auth +
     UI on 8080/9099/4000 with no Functions emulator; `pnpm test:rules` passes
     all allow/deny cases. Validate `firestore.rules`/`firebase.json` are valid
     (the emulator **refuses to start on invalid rules**, so a clean
     `emulators:exec` run is itself the validity check — note this in the PR).
     Verify the `--import`/`--export-on-exit` round-trip: `pnpm emulators`,
     write a doc, exit, restart, confirm the doc re-imports. Confirm no secret
     was read/written. Record the commands + Firebase CLI / Java versions in the
     PR.

## Test plan

Per the PLAN §5 pyramid, tailored — this is infra config, so the test surface is
a focused set of emulator-backed rules integration tests (not pure unit tests,
and explicitly **not** part of the normal `nx test` graph because they require a
running Firestore emulator + Java).

- **Rules integration tests (the centerpiece)** — in
  `tools/firestore-rules-test/src/firestore-rules.rules.spec.ts` (the
  `*.rules.spec.ts` pattern the **default** `test` target ignores; only the
  emulator-only `test-rules` / rules vitest config collects it),
  `@firebase/rules-unit-testing` against the Firestore emulator, run via
  `firebase emulators:exec --only firestore`. `emulators:exec` exports
  `FIRESTORE_EMULATOR_HOST`, which `initializeTestEnvironment` reads
  automatically (the `8080` in `firebase.json` is only a fallback — do not
  hardcode the host). Prove at minimum:
  1. **Owner can read+write own watchlist** — auth uid `userA` can read and
     write `users/userA/watchlist/{titleId}` (and an episode under it):
     `assertSucceeds`.
  2. **Other user denied** — auth uid `userB` cannot read or write
     `users/userA/watchlist/{titleId}`: `assertFails`.
  3. **Unauthenticated denied** — an unauthenticated context cannot read or
     write any `users/**` path: `assertFails`.
  4. **Anonymous owner allowed** — an authenticated (anonymous-style) context
     whose uid equals the doc owner succeeds (documents the "anonymous uid
     counts" rule).
  5. **Client can read `title-cache`** — an authenticated user can read
     `title-cache/{tmdbId}` and `title-cache/{tmdbId}/availability/{region}`:
     `assertSucceeds`.
  6. **Client cannot write `title-cache`** — an authenticated user writing
     `title-cache/{tmdbId}` (or its `availability` subdoc) is denied:
     `assertFails`.
  7. **Default deny** — a write to an unrelated/undeclared top-level path is
     denied: `assertFails`.
- **Unit tests:** none beyond the above (no workspace logic is added).
- **Component tests:** none — no UI.
- **e2e tests:** none here. Playwright + full emulator e2e is PLAN §6 item 20, a
  later spec; that spec will also be the natural home for adding the emulator
  job to CI (see Risks / CI story).

### CI story (decision)

**Decision: rules tests are reproducible locally now; CI integration is
deferred to a noted follow-up — they do NOT run in spec 0002's `ci.yml` as part
of this spec.** Rationale: the existing CI workflow (spec 0002) intentionally
runs **lint/test/build only** and installs neither **Java** nor a running
**Firestore emulator** — both are hard prerequisites for `emulators:exec`. Wiring
a Java setup + `firebase-tools` emulator step into CI is real, separable work
that belongs with the **same follow-up that adds the Playwright/emulator e2e job**
(PLAN §6 item 20), which also needs the emulator running in CI — doing it once,
there, avoids two half-baked emulator-in-CI setups. To keep the definition of
done **honest**, this spec:
  - provides the **exact local command** (`pnpm test:rules`) and makes it pass
    locally as a hard DoD item;
  - ensures the bare `nx test` graph (what CI runs today) **does not** attempt to
    run the emulator-backed specs (task 3), so CI stays green and is **not**
    falsely claimed to cover the rules;
  - records the CI-integration gap as a **Risk** + an explicit follow-up note,
    so the next maintainer adds a `firestore-rules` CI job (Java + firebase-tools
    + `emulators:exec`) alongside the e2e job rather than discovering the gap.

(If the implementer judges it low-cost to add a dedicated CI job now —
`setup-java` + `firebase-tools` + `emulators:exec --only firestore` — that is an
**allowed enhancement**, but it must be a *separate job* that does not block the
existing required `main` check, and the PR must document it. The default,
honest-DoD path is local-only-for-now.)

## Definition of done

Tailored from the PLAN §5 checklist (e2e excluded; rules-tests-in-CI explicitly
deferred per the CI story above):

- [ ] `.firebaserc` commits `default` → `vultus-cab62` (the non-secret project
      id).
- [ ] `firebase.json` configures **Firestore (8080) + Auth (9099) + UI (4000)**
      emulators and references `firestore.rules` + `firestore.indexes.json`;
      **no Functions emulator** block.
- [ ] `firestore.rules` implements default-deny, owner-only `users/**` (with the
      anonymous-uid note), `title-cache` authenticated-read + client-write-deny
      (with the Admin-SDK-bypasses-rules note), and the field-validation-deferred
      note.
- [ ] `firestore.indexes.json` is the **empty skeleton** and the PR notes
      per-slice indexes are added later.
- [ ] `firebase emulators:start` boots Firestore + Auth + UI on the documented
      ports locally with no errors (this also validates the rules/config —
      invalid rules abort startup).
- [ ] `pnpm test:rules` runs the `@firebase/rules-unit-testing` suite via
      `firebase emulators:exec --only firestore` and **all** allow/deny cases in
      the Test plan pass.
- [ ] The normal `nx test` / `nx affected -t test` graph (spec 0002 CI)
      **does not** try to run the emulator-backed specs bare and stays green;
      `nx lint` passes; the new `tools/firestore-rules-test` project lints clean.
- [ ] `firebase-tools` and `@firebase/rules-unit-testing` are pinned
      devDependencies; `pnpm-lock.yaml` is updated; the dev/test commands are
      documented (PR + a short note by `firebase.json`).
- [ ] The `--import ./.emulator-data --export-on-exit ./.emulator-data`
      round-trip works: with `pnpm emulators`, write a doc, exit the emulator
      (data exports), restart, and confirm the written doc is re-imported
      (verified locally; record in the PR).
- [ ] `.emulator-data/` is gitignored; **no seed fixtures are committed**.
- [ ] **No secret is read or written;** if a step appeared to need one, it is
      flagged in the PR, not worked around.
- [ ] The PR description records: Firebase CLI + Java versions, the exact
      `emulators:exec` command, that rules-tests-in-CI is a documented follow-up
      (not covered yet), and the per-slice-index note.

## Risks

- **Java is a hard runtime prerequisite for the Firestore emulator.** The
  Firestore emulator runs on the JVM; without Java on `PATH`, both
  `emulators:start` and `emulators:exec` fail. It is present on the dev machine
  (PLAN §7 toolchain), but **not on the spec-0002 CI runner**. Mitigation: this
  spec documents the Java prereq and keeps the rules tests **local-only for now**
  (CI story above). Adding them to CI requires `setup-java` + `firebase-tools`,
  done in the follow-up emulator/e2e job.
- **CI does not cover the rules tests yet (explicit, documented gap).** Per the
  CI story, the existing `ci.yml` runs lint/test/build with no Java/emulator, so
  the rules tests are **not** gated in CI by this spec. This is deliberate to
  keep the DoD honest; the follow-up that adds the Playwright/emulator e2e job
  (PLAN §6 item 20) should add a `firestore-rules` CI job at the same time. Until
  then, the rules tests are a local gate (`pnpm test:rules`) and a reviewer must
  run them.
- **`title-cache` client-write-deny relies on the Admin SDK bypassing rules.**
  The rule `allow write: if false` for `title-cache` is correct **only because**
  Cloud Functions write via the Firebase Admin SDK, which bypasses security
  rules entirely (it is not subject to `request.auth`/rules). This is the
  intended design (PLAN §4 "written by functions only"), but it is a non-obvious
  invariant: a contributor who later tries to write `title-cache` from the client
  will be denied (correct), and one who "fixes" it by adding a client write rule
  would open the shared cache to tampering. Mitigated by an explicit comment in
  `firestore.rules` (Data model touchpoints) — do not remove it.
- **Emulator-backed specs must be kept out of the bare `nx test` graph.** The
  `@nx/vitest` plugin auto-infers a `test` target for the new project, and CI
  (spec 0002) runs `nx affected -t test` / `nx run-many -t test --all`, so that
  target **is** invoked with no emulator/Java. `passWithNoTests: true` (set
  globally in `nx.json`) is **insufficient** because it does not skip files that
  match the include — it only short-circuits when **zero** match. Mitigated by
  the **required test-isolation mechanism** (Public types / APIs + task 3):
  rules specs use `*.rules.spec.ts`, the default `vite.config.mts` `include` does
  **not** match that pattern (so the inferred `test` target collects zero specs),
  and a separate rules vitest config + `test-rules`/`emulators:exec` is the only
  thing that runs them. The implementer must verify `nx affected -t test` /
  `nx run-many -t test --all` stay green with the new project present. This
  mirrors the care spec 0001 took to isolate the Sheriff negative-test fixture.
- **Port collisions.** 8080/9099/4000 are the Firebase defaults but may clash
  with other local services. They are pinned explicitly in `firebase.json` so a
  contributor can change them in one place; documented in the PR.
- **No PLAN conflicts.** This implements PLAN §6 item 4 and PLAN §4 as written.
  The only deviations from a naive reading are deliberate and bounded: Functions
  emulator deferred (stub backend), indexes empty (per-slice later), rules-tests
  CI deferred (no Java/emulator in current CI) — each documented above. Data-
  source accuracy risks (TMDB/Trakt) are **not relevant** to this infra spec.
