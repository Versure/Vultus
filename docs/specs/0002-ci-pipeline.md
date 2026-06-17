---
number: 0002
slug: ci-pipeline
title: Add GitHub Actions CI pipeline running the definition-of-done gates on PRs
status: approved
slices: []
scopes: [scope:shared, scope:mobile, scope:functions]
created: 2026-06-17
---

# Add GitHub Actions CI pipeline running the definition-of-done gates on PRs

## Context

The Nx workspace exists and the definition-of-done gates (lint/Sheriff, unit
test, build) run locally (spec 0001), but **CI was explicitly out of scope
there** — there is no `.github/workflows/*`. Every later feature, produced by
`/implement-feature`, ends at "a green, merged PR" (specs README), and the
feature/QA skills expect a real pipeline to watch and gate the merge. Without
CI, "green" is only ever asserted on the contributor's Windows machine, and a
boundary violation or broken build could land on `main` unchecked.

This spec implements **PLAN §6 foundation item 3** ("CI pipeline —
`.github/workflows/ci.yml`"): a GitHub Actions workflow that runs the Vultus
gates on every PR to `main`, and a full-baseline run on push to `main`. The
intended outcome: opening a PR to `main` triggers lint (Sheriff included), unit
test, and build over the affected projects, and `main` always carries a complete
green baseline so `nx affected` has correct SHAs going forward.

Two deliberate deviations from PLAN §6's literal wording are resolved here and
documented in **Risks**: (1) PLAN §6 lists a `typecheck` target, but the
bootstrapped workspace has **no standalone `typecheck` target** — type errors
are caught by `build` (both `@angular/build:application` for mobile and
`@nx/esbuild:esbuild` for functions compile through their `tsConfig`), so this
spec uses the targets that actually exist rather than inventing one; (2) PLAN §6
lists `e2e` in CI, but e2e is **deferred entirely** (see Scope → Out of scope).

## Scope

In scope:

- Author `.github/workflows/ci.yml` — the sole deliverable — running the Vultus
  definition-of-done gates that exist as Nx targets in the workspace today:
  **lint** (Sheriff included, via `@softarc/eslint-plugin-sheriff` in
  `eslint.config.mjs`), **test** (Vitest, run in the `ci` configuration), and
  **build** (which also performs the TypeScript compile/typecheck — see
  Context). These are the actual target names: `lint`, `test`, `build`.
- **Pull-request runs (`pull_request` → `main`):** run the gates with
  `nx affected` against the PR's merge base, so only projects affected by the
  branch are checked. Base/head SHAs are computed by `nrwl/nx-set-shas` (pinned),
  which resolves `--base` to the merge base with `main`.
- **Push runs (`push` → `main`):** run the gates across **all projects**
  (`nx run-many` / `nx affected` degenerating to a full run) so `main` always has
  a complete green baseline and `nx affected` has a correct last-successful SHA
  for subsequent PRs.
- Use **pnpm** (the workspace package manager; `pnpm-lock.yaml` v9 is committed)
  with `--frozen-lockfile`, and **Node 20 LTS** (the workspace targets Node 20 —
  `@types/node@20.19.9`, the Firebase Functions runtime). Pin all action
  versions and the Node/pnpm versions.
- **Caching via the GitHub Actions cache only:** the pnpm store and the Nx local
  cache (`.nx/cache`). No Nx Cloud, no `NX_CLOUD_ACCESS_TOKEN`, no new secret of
  any kind — see the €0/no-secret invariant below.
- Use `actions/checkout` with **`fetch-depth: 0`** so `nx affected` /
  `nx-set-shas` can resolve the merge base (a shallow clone breaks affected).
- A **manual-prerequisite note** (in this spec, mirrored into the PR
  description) listing the status checks the user should mark **required** on
  `main` in GitHub branch-protection settings once the workflow lands.

Out of scope (each is its own later spec / manual step):

- **e2e in CI — deferred entirely.** `ci.yml` runs lint/test/build only. There is
  **no e2e job, not even a non-blocking one.** Playwright (`apps/mobile-e2e`,
  spec 0001) plus the Firebase emulators it will need belong to the later
  Playwright/emulator spec (**PLAN §6 item 20**, depending on the Firebase
  emulator setup of **PLAN §6 item 4**). The e2e job will be added to this same
  `ci.yml` by that spec; it is not authored here because it has no green
  emulator+Playwright harness to run against yet.
- **A standalone `typecheck` target.** Not created here. If a future spec adds an
  explicit `typecheck` target (e.g. `tsc --noEmit` per project), wiring it into
  CI as a fourth gate is that spec's job; today `build` covers it.
- **Branch protection configuration.** The workflow is the deliverable; marking
  the checks "required" on `main` is a **manual prerequisite** (PLAN §7) the
  human does in GitHub settings — it cannot be set from a workflow file. See the
  Manual prerequisite note.
- **Deploy / release workflows** (Firebase Functions deploy, the daily-sync
  GitHub Actions cron of PLAN §6 item 16, Capacitor APK build). The specs
  workflow "ends at a green, merged PR" (specs README); deployment is separate.
- **Nx Cloud / distributed task execution, third-party CI cost, any new
  secret.** Explicitly excluded — see the invariant below.
- **Renovate/dependabot** version-update automation (a possible later spec).

### €0 / no-new-secret invariant

CLAUDE.md and PLAN §7/§5 fix the secrets convention: secrets live in
`.env.local` (gitignored), GitHub Actions secrets, and Firebase functions
config — and the project's hosting cost is **€0/month** (PLAN §1, "Firebase
Spark + GitHub Actions free tier"). This workflow introduces **no new secret**
and uses **no Nx Cloud token**: it relies only on the committed
`pnpm-lock.yaml`, the GitHub-hosted runner, and the GitHub Actions cache (all
free-tier). The implementer **must not** add `NX_CLOUD_ACCESS_TOKEN`,
`nxCloudId`, or any other secret/credential. If any step appears to require a
secret (it should not — lint/test/build need no external services at this
stage), the implementer must **stop and flag it** in the PR rather than invent
or wire one.

## Affected slices & Sheriff tags

No slice is built (`slices: []`). This is foundation/infra: a single CI config
file at the repo root. At the CI level it exercises all three scopes — the
workflow lints/tests/builds `scope:mobile` (`apps/mobile`), `scope:functions`
(`apps/functions`), and `scope:shared` (`libs/shared/*`) projects via Nx — but
it **builds no slice and adds no slice/scope lib**. Sheriff itself is invoked
indirectly: `nx affected -t lint` already runs `@softarc/eslint-plugin-sheriff`
(spec 0001), so the CI lint gate is what enforces the cross-scope/cross-slice
import ban on every PR. No `sheriff.config.ts` change and no cross-slice import
is introduced.

| Touched at CI level | Path | Sheriff tags |
|---|---|---|
| mobile app | `apps/mobile` | `scope:mobile` |
| functions app | `apps/functions` | `scope:functions` |
| shared libs | `libs/shared/*` | `scope:shared` |

The only file written is `.github/workflows/ci.yml` (plus, if needed, a tiny
`.nvmrc` — see task graph), neither of which is a Sheriff-governed project, so
no boundary rule applies to the change itself.

## Data model touchpoints

None. No Firestore collections, fields, converters, or security rules. PLAN §4
is untouched.

## Public types / APIs

No domain types, function signatures, HTTP endpoints, or callable shapes. The
only "public surface" introduced is the **CI workflow file and its job/check
names**, which branch protection and future specs (the deferred e2e job) will
reference. Fix these names so they are stable to depend on:

- **Workflow name:** `CI`
- **Job:** a single job named `main` (display name "Lint, test, build"). Using
  one job keeps `pnpm install` + Nx cache warm-up shared across the three gates
  and minimizes runner minutes. The required-status-check name surfaced to
  branch protection will be `CI / main` (GitHub renders it `<workflow> /
  <job>`). The Manual prerequisite note and the PR description must record the
  exact check string the user marks required.

(If the implementer finds splitting into parallel per-gate jobs materially
faster, that is an allowed refinement, but then the workflow MUST list every
resulting `CI / <job>` check name in the PR description so the human marks the
correct set required. The default and simplest contract is the single `main`
job above.)

## UI / Stitch screen refs

Not applicable. No UI is built; this is CI configuration only.

## Implementation task graph

All work is a single root config file plus verification. There is **no
parallel work** — the deliverable is one `.github/workflows/ci.yml`. All tasks
are `[sequential]` and run by a single infrastructure engineer
(`scope:` n/a — root/`.github` file, no Sheriff project). Local authoring is on
Windows/PowerShell, but the workflow targets **`ubuntu-latest`** runners (the
standard, fast, free-tier-friendly choice; the YAML's shell steps are Linux/bash,
not PowerShell).

1. **[sequential] Author `.github/workflows/ci.yml`.**
   - **Triggers:** `pull_request` with `branches: [main]`, and `push` with
     `branches: [main]`. Set workflow-level `concurrency` keyed on the ref with
     `cancel-in-progress: true` so superseded PR pushes don't pile up runner
     minutes.
   - **Permissions:** set top-level `permissions: contents: read` (least
     privilege; `nx-set-shas` needs only read).
   - **Runner:** `ubuntu-latest`.
   - **Steps, in order:**
     1. `actions/checkout` (pinned, e.g. `@v4`) with `fetch-depth: 0` — required
        so the merge base is reachable for affected/`nx-set-shas`.
     2. `pnpm/action-setup` (pinned) installing the pnpm major matching the
        committed lockfile (lockfile v9 ⇒ pnpm 9+; the repo was authored with
        pnpm 11). Pin a concrete version (e.g. `version: 9` or the exact
        resolved major) rather than floating.
     3. `actions/setup-node` (pinned, e.g. `@v4`) with `node-version: 20` (or
        read from `.nvmrc` if task 2 adds one) and `cache: pnpm` so the pnpm
        store is cached by the action's built-in mechanism.
     4. `pnpm install --frozen-lockfile`.
     5. `nrwl/nx-set-shas` (pinned) to compute `NX_BASE`/`NX_HEAD`. On
        `pull_request` the base is the merge base with `main`; on `push` to
        `main` it resolves to the last successful run's SHA.
     6. **Cache the Nx local cache** (`.nx/cache`) via `actions/cache` (pinned),
        keyed on lockfile hash + a run identifier, with a restore fallback key —
        unless `setup-node`'s pnpm cache plus Nx's own cache strategy is judged
        sufficient; at minimum the pnpm store MUST be cached. **No Nx Cloud.**
     7. **Run the gates.** Two paths, selected by event:
        - On `pull_request`: `pnpm nx affected -t lint test build --base=$NX_BASE
          --head=$NX_HEAD` (run the test target in its `ci` configuration — e.g.
          `--configuration=ci` for `test`, which sets `watch: false` and
          coverage per `nx.json`). The implementer MAY split into separate
          `nx affected` invocations per target if clearer, keeping all three.
        - On `push` to `main`: `pnpm nx run-many -t lint test build --all`
          (full run across every project) so `main` carries a complete green
          baseline. (Equivalently `nx affected` against the prior successful SHA;
          either MUST result in a full pass on a fresh `main`.)
     - Use the **exact existing target names**: `lint`, `test`, `build`. Do
       **not** reference a `typecheck` target (none exists) and do **not** add an
       `e2e` step (deferred).
   - Files: `.github/workflows/ci.yml`.

2. **[sequential] (Optional) Pin the Node version source.**
   - If the implementer wants `setup-node` to read `node-version-file`, add a
     repo-root `.nvmrc` containing `20` and have `setup-node` use it; otherwise
     hardcode `node-version: 20` in the workflow. Either is acceptable; pick one
     and keep it consistent. Do not change `package.json` engines (out of scope).
   - Files: `.nvmrc` (only if this option is taken).

3. **[sequential] Verify on the introducing PR (self-validating).**
   - Push the branch and open the PR to `main`. Confirm the workflow triggers on
     `pull_request`, the affected logic resolves a non-empty base SHA (no
     shallow-clone failure), and **lint + test + build all pass green** on this
     PR. Record in the PR description: the runner OS, Node/pnpm versions, the
     resolved `NX_BASE`/`NX_HEAD`, which projects were affected, and that no
     secret was added.
   - Confirm the cache steps populate on first run and restore on a re-run (a
     second push or re-run shows cache hits) — note this in the PR.

4. **[sequential] Record the branch-protection manual prerequisite.**
   - The implementer does **not** configure branch protection (cannot, from a
     workflow). Copy the Manual prerequisite note (below) verbatim into the PR
     description so the human knows exactly which check(s) to mark required.
   - Files: none (PR description only).

### Manual prerequisite note (PLAN §7) — for the human

Once this PR merges and the workflow has run on `main` at least once:

1. GitHub repo → **Settings → Branches → Branch protection rules** → add/edit a
   rule for `main`.
2. Enable **"Require status checks to pass before merging"** and **"Require
   branches to be up to date before merging."**
3. In the status-checks search box, select **`CI / main`** (the single job from
   this spec). If the implementer split the workflow into multiple jobs, select
   **every** `CI / <job>` check listed in the PR description instead.
4. (Recommended) Enable "Do not allow bypassing the above settings."

This is a one-time checkbox in GitHub settings; it is not, and cannot be,
automated by the workflow file.

## Test plan

This is CI configuration, so the "test" is the workflow validating itself —
keep it realistic; do not build a meta-test harness.

- **Self-validation (the centerpiece):** the PR that introduces `ci.yml` is the
  test. On `pull_request` the workflow must trigger and run **lint + test +
  build to green** over the affected projects, with `nx-set-shas`/`fetch-depth:
  0` resolving a valid base (no "shallow clone" / "cannot find base" error).
- **Affected-logic check:** because this PR touches a root config file
  (`.github/**`, not inside a project), confirm `nx affected` behaves sensibly —
  either it correctly scopes to affected projects, or (since root config can be a
  global input) it runs broadly; record which in the PR. The substantive proof
  of the affected path comes when the next feature PR (a real slice change)
  triggers a scoped run. No artificial "deliberately break a file" test is
  required, but the implementer MAY note, as a one-line sanity observation, that
  a trivial change to one project would scope the run to that project.
- **Baseline check:** after merge, the `push`-to-`main` run executes the full
  `run-many --all` and passes, establishing the green baseline.
- **Unit / component / e2e:** none authored here. e2e is deferred (Out of
  scope). The workspace's existing unit tests are run **by** this pipeline, not
  added by it.

## Definition of done

Tailored from the PLAN §5 checklist (e2e and standalone typecheck deliberately
excluded — see Context/Scope):

- [ ] `.github/workflows/ci.yml` is present and **valid YAML** that GitHub
      Actions parses and runs.
- [ ] The workflow runs **lint (Sheriff included), test, and build** using the
      workspace's real Nx target names; no `typecheck` and no `e2e` step.
- [ ] On `pull_request` → `main`, the gates run via `nx affected` against the
      merge base, with `nrwl/nx-set-shas` and `actions/checkout` `fetch-depth:
      0` wired correctly (no shallow-clone affected failure).
- [ ] On `push` → `main`, the gates run across **all** projects (full baseline).
- [ ] Caching uses the **GitHub Actions cache only** (pnpm store + `.nx/cache`);
      **no Nx Cloud, no new secret** of any kind. If a step seemed to need a
      secret, it is flagged in the PR, not worked around.
- [ ] Runner is `ubuntu-latest`; Node 20 LTS and pnpm (matching lockfile v9) and
      all actions are **pinned**; `pnpm install --frozen-lockfile` is used.
- [ ] All three gates pass green **on this introducing PR** (self-validating).
- [ ] The **branch-protection manual note** is included in this spec and copied
      into the PR description, listing the exact required check name(s).
- [ ] The PR description records what was verified: runner/Node/pnpm versions,
      resolved base/head SHAs, affected projects, cache hit/miss, and
      no-secret-added confirmation.

## Risks

- **Sheriff/Nx version mismatch breaks CI** (PLAN §9). Mitigation: the workflow
  installs nothing it doesn't lock — `pnpm install --frozen-lockfile` against the
  committed `pnpm-lock.yaml` (v9) reproduces exactly the Nx 23 / `@softarc`
  0.19.6 / Angular 21 set that spec 0001 resolved. All GitHub Actions are pinned
  to fixed versions, and Node is pinned to 20. Tool/version bumps come through
  explicit update PRs (the renovate-style flow PLAN §9 anticipates), never via a
  floating CI install.
- **`nx affected` base-SHA pitfall on shallow clones.** GitHub's default checkout
  is shallow (`fetch-depth: 1`), which makes the merge base unreachable and
  `nx affected` either error or behave as "everything affected." Mitigation:
  `actions/checkout` with `fetch-depth: 0` **and** `nrwl/nx-set-shas` to compute
  `NX_BASE`/`NX_HEAD`. The introducing PR's self-validation explicitly checks
  that a valid base SHA resolves.
- **PLAN §6 names a `typecheck` target that does not exist.** Resolved, not
  worked around: the bootstrap (spec 0001) created `lint`/`test`/`build` but no
  `typecheck`; `build` performs the TS compile for both apps. This spec uses the
  real targets and notes the gap. Not a PLAN architecture conflict — PLAN §6's
  `typecheck` line is aspirational tooling, and the definition-of-done is still
  enforced (a type error fails `build`). A dedicated `typecheck` target can be
  added by a later spec and slotted in as a fourth gate.
- **PLAN §6 lists `e2e` in CI; this spec omits it.** Deliberate (Scope → Out of
  scope): there is no Firebase-emulator + Playwright harness yet (PLAN §6 items
  4/20), so an e2e job would have nothing green to run. Adding it now would
  either be a perpetually-red gate or dead config. The deferred spec adds the
  e2e job to this same `ci.yml`. Documented so it is a known, intentional gap,
  not an oversight.
- **Required-check name coupling.** Branch protection references the check by its
  rendered `CI / <job>` name; if a later refactor renames the workflow or job,
  the required check silently stops matching and PRs can merge ungated. Mitigated
  by fixing the names in Public types / APIs and recording them in the PR; any
  future rename must update branch protection in the same change.
- **No new secret is needed and none is added** — consistent with the €0 /
  no-new-secret invariant (PLAN §5/§7, CLAUDE.md). The only residual cost is
  GitHub Actions runner minutes on the free tier, bounded by `concurrency`
  cancellation and `nx affected` scoping on PRs.
