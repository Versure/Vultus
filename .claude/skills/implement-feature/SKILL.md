---
name: implement-feature
description: Implement an approved Vultus spec autonomously in an isolated git worktree. Reads the spec, decomposes it into a task graph, routes work to specialist implementer agents by Sheriff scope tag (running shared/config work sequentially and slice-internal work in parallel), auto-reviews and reworks via feature-reviewer, runs QA via qa-runner, opens a code PR, and watches/fixes the CI pipeline — stopping at the PR for manual review. Use when the user wants to implement, build, or code a feature from a merged spec.
---

# Implement Feature

Take an approved spec from `docs/specs/` to a green, review-ready PR — mostly
autonomously. You orchestrate; the specialist implementers, **feature-reviewer**,
and **qa-runner** do the work, all in one dedicated worktree so the user keeps
working on `main`. (Project-wide rules — shell, secrets, architecture, DoD — are
in `CLAUDE.md`.)

## Conventions

- Feature branch `feat/NNNN-slug`, one worktree per feature.
- Auto-fix loops (review, QA, pipeline) bounded to **2 retries** (override via
  `$ARGUMENTS`); state "Attempt N/2" before each retry. On exhaustion, make the
  PR a **draft** + `needs-human` label, unresolved items atop the body. Never
  merge — human gates are PR review + merge.

## Concurrency model (read before fanning out)

Parallel agents in one worktree are safe only on **physically disjoint files**.
Sheriff is an import linter — it does **not** make files disjoint. Therefore:

- **You (orchestrator), not the agents, own every shared/root file**:
  `package.json`+lockfile, `nx.json`, `tsconfig*.json`, `project.json`,
  `firestore.rules`/`indexes`, `.github/workflows/*`, registration barrels, and
  the `apps/*` route/export registration. Edit these **sequentially**. Run all
  `npm install` / `nx generate` yourself, serially (they race the lockfile + Nx
  cache). **Populating a shared lib** (`shared/domain`, `shared/firestore-schema`,
  `shared/ui-kit`) — its source _and_ barrel — is foundation work, run by one
  agent alone, never fanned out.
- **Disjointness assertion (mechanical, not judgment):** each `[parallel]` task
  in the spec carries a **file manifest** (prefer one slice dir per task). Before
  fan-out assert (a) manifests are pairwise disjoint and (b) none claims a
  shared/root path above. On any failure, fail closed — pull it into foundation
  or run those tasks sequentially.

## Steps

### 1. Select & read the spec

- From `$ARGUMENTS` (`NNNN`/slug) or list `main` specs with `status: approved`
  (treat a merged spec missing the field as approved). Read it fully — Scope,
  Affected slices, Public types, Data model, **task graph + manifests**, Test
  plan, DoD.

### 2. Create the worktree

- Branch→dir `/`→`-`. Resolve an absolute, worktree-invariant path:
  ```powershell
  $root = (git rev-parse --path-format=absolute --git-common-dir) -replace '\.git$',''
  $wt   = [System.IO.Path]::GetFullPath("$root/../Vultus-worktrees/feat-NNNN-slug")
  ```
  `git worktree prune`; if `$wt` registered → reuse; elif branch exists →
  `git worktree add --force $wt feat/NNNN-slug`; else
  `git worktree add -b feat/NNNN-slug $wt main`. Branch must not be active in the
  primary checkout. Set `status: implementing` **in the worktree** (worktree-local
  only — `main` advances `approved → done`).
- **Bootstrap check:** if no `nx.json` exists, go to step 3a.

### 3. Decompose & route (you)

- Split tasks into **[sequential foundation]** — new-slice `nx generate`,
  installs, root/config wiring, `firestore.rules`/`indexes`, CI, shared-lib
  population, `apps/*` registration — and **[parallel]** slice-internal source
  - tests (per the manifests).
- **Route by Sheriff scope tag:** `scope:functions` source → **backend-engineer**;
  `scope:mobile` source + in-app Capacitor _plugin usage_ + `shared/ui-kit` →
  **frontend-engineer**; Nx/Sheriff/CI/Firebase config + _native_ Capacitor
  (`capacitor.config.ts`, icon/splash, APK) → **infrastructure-engineer**;
  `scope:shared` non-UI (`shared/domain`, `shared/firestore-schema`) + glue →
  **feature-implementer**. _Tiebreakers:_ a change spanning `firestore.rules`
  (infra) + schema/converters runs as sequential foundation; native Capacitor →
  infra, plugin calls in a component → frontend. Each agent gets the spec path,
  the absolute `$wt`, and its task subset (+ manifest).

### 3a. Bootstrap mode (first features only)

- Workspace bootstrap (Nx/Sheriff/CI/Firebase, PLAN §6.1–6.4) is sequential and
  all shared/root files: run a **single infrastructure-engineer**, no fan-out.
- Commit hygiene: ensure `.gitignore` (incl. `node_modules/`, `.nx/`) exists
  **before** any install; **commit the lockfile**; don't commit `node_modules`.
- Review/QA will be near-empty (no baseline; gates `SKIPPED (not bootstrapped)`)
  — that's expected; **proceed to step 7**, don't stall. Branch protection
  (PLAN §6.3) is manual, so step 8 is skipped until CI exists — remind the user
  to enable branch protection once the CI feature merges.

### 4. Implement

- Do **foundation** first, sequentially. Then run the disjointness assertion and
  **fan out** routed specialists in parallel (all calls in one message), each
  confined to its manifest and forbidden from shared/root files or
  install/generate.
- On fan-in, **capture each agent's reported file list** and reconcile against
  its manifest: re-dispatch any slice whose agent failed/returned null or
  reported success but wrote nothing. (A global `git status` can't attribute
  files per slice or catch a clobber — trust the manifests + reported lists.)
- **Lib README currency is part of done** (CLAUDE.md): any slice that creates a
  lib or changes a lib's public API/behavior/boundaries must update that lib's
  `README.md` in the same change — never leave the generated Nx scaffold text.
  Instruct each implementer accordingly and verify on fan-in; the feature-reviewer
  flags a stale/scaffold README as a finding.
- **e2e fixme un-skip (mobile UI specs):** before fanning out, grep
  `apps/mobile-e2e/src/` for `test.fixme` annotations that reference this
  spec number or slug. If any exist, include un-skipping them as an explicit
  task in the foundation or the relevant parallel task — the implementer
  removes the `test.fixme` wrapper and verifies the flow passes. The
  `feature-reviewer` enforces this; flag it if you discover it late.

### 5. Auto-review → bounded rework

- Spawn **feature-reviewer** on the diff (`git -C $wt diff main...HEAD`). For
  `NEEDS_REWORK`, dispatch the appropriate specialist(s) by scope tag (you handle
  shared-file fixes), re-review, up to the bound; then record open findings.

### 6. QA → bounded fix

- Spawn **qa-runner**; it returns each gate's raw result. **You make the
  skip-vs-fail call:** a gate the spec _required_ (e.g. named e2e flows) that was
  `SKIPPED` is a **blocking** unmet DoD gate, not an acceptable skip (only
  genuinely-not-bootstrapped tooling is an OK skip). For `FAIL`/unmet, dispatch
  the relevant specialist with details, re-run QA, up to the bound.
- **UI fidelity is not provable by the green gates.** typecheck/lint/test/build
  passing says nothing about whether a `scope:mobile` change _looks_ like the
  Stitch screen — that blind spot is what causes round-trip UI-rework passes. If
  qa-runner could render+compare, treat its visual result as a gate. If it
  reported `visual unverified` (this environment usually blocks a live dev
  server + browser), **carry that forward to the PR as an explicit human-eyeball
  ask** (next step) — do **not** report the UI as done. Confirm the implementer
  fetched the Stitch screen (has an ID) and wired the design font; a UI task that
  fell back to "tokens only, screen never seen" is an unmet contract worth a
  re-dispatch, not a pass.

### 7. Open the PR

- Flip the spec to `status: done` **in the diff** by reading the frontmatter and
  setting `status:` (inserting it if absent — don't assume a line exists).
  Merging marks it done. Commit all work, push `feat/NNNN-slug`.
- `gh pr create --base main` referencing the spec, summarizing the change
  (`--draft` if any loop hit its bound or a required gate is unmet). **For a UI
  change whose visual fidelity could not be auto-verified, the PR body must make
  the human eyeball easy and explicit:** the **Stitch screen ID** used, the exact
  view command (e.g. `pnpm nx serve mobile --configuration=mock`), and a
  per-item visual checklist (heights, focus/active states, font loaded, icon
  alignment, insets). State plainly that visual fidelity is _unverified by the
  automated gates_ — don't imply the UI is confirmed. Label best-effort:
  `gh label create needs-human --color D93F0B
--force 2>$null`; `gh pr edit <pr> --add-label needs-human 2>$null` when
  surfacing to the human.

### 8. Watch the pipeline → bounded fix

- `gh pr checks <pr>` exit codes: `0` pass; `8` pending (keep watching); `1` =
  a check failed **or** no checks exist — disambiguate via the stderr "no checks
  reported" message (none → CI not set up → **skip and note**; else a real
  failure); `4`/network → auth problem, **stop and surface**, don't assume green.
- To watch: `gh pr checks <pr> --watch --interval 30`. On a real failure, find
  the run id (`gh run list --branch feat/NNNN-slug -L 1 --json databaseId`),
  fetch `gh run view <id> --log-failed`, dispatch the relevant specialist to fix,
  commit, push. Up to the bound.

### 9. Report

- Report the PR URL, what was built, QA result, unresolved items. The user
  reviews and merges manually; comments or a `needs-human` draft → `/rework-feature`.
- Leave the worktree for rework; remove after merge: `git worktree remove --force $wt`.
