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

> **You are the orchestrator, not the implementer.** Across this entire skill you
> dispatch agents and edit only foundation/shared/root files — you never write
> slice source yourself, and you never run the review (Step 5) or QA (Step 6)
> gates by hand instead of via `feature-reviewer` / `qa-runner`. **If this skill
> resumes after a context compaction**, the summary may read as though you were
> implementing directly — re-read this SKILL.md and re-establish the orchestrator
> role before continuing. Confirm which agent steps (implement / review / QA)
> actually ran; any step done by the orchestrator instead of its agent is unmet
> and must be (re-)dispatched before opening — or before merging — the PR.

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

## Known environment behaviors (group G)

These are observations of the **current** harness — not in-repo bugs and not
fixable here. They **may change**; they are recorded so the orchestrator plans
around them rather than being surprised.

- **The Agent tool runs async here.** With `run_in_background` omitted the Agent
  tool **still returns immediately** ("Async agent launched") with an `agentId`;
  the actual completion arrives **later** as a `<task-notification>`. So
  **dispatch, then await notifications** — use `ScheduleWakeup` to resume — do
  **not** expect an inline synchronous result from an Agent call. (One real run
  needed ~15 wakeups to drain its fan-out.)
- **Bash cwd resets** to the primary checkout between calls. Never rely on a
  persisted working directory — always use **absolute paths** / `git -C $wt` /
  `cd $wt && …` **within the same call**.
- **Permission-classifier context sensitivity.** An earlier denied action (e.g.
  the Step-2 `.env.local` seed copy) has been observed to influence the
  classifier's judgment on **later, unrelated actions** in the same session (even
  a benign markdown `Edit`). If a clearly-legitimate action is unexpectedly
  blocked, the honest move is to **surface it to the user** for a decision rather
  than looping. (See group D-fallback: a blocked seed is skip-and-warn, not an
  abort.)

## Steps

### 1. Select & read the spec

- From `$ARGUMENTS` (`NNNN`/slug) or list `main` specs with `status: approved`
  (treat a merged spec missing the field as approved). Read it fully — Scope,
  Affected slices, Public types, Data model, **task graph + manifests**, Test
  plan, DoD.
- **Spec-file-only-diff guard (group H).** Before proceeding, verify the selected
  spec is genuinely _approved-but-unimplemented_, not already implemented: confirm
  its merge landed a **spec-file-only diff** — e.g. `git show <merge-sha> --stat`
  (or `git log --stat` for the spec's merge) shows **only** `docs/specs/NNNN-*.md`
  changed. If the merge diff includes app/lib/config changes, the spec is likely
  already implemented — stop and confirm before re-implementing. (Commit-subject
  convention aside: spec PRs read `docs(spec 00NN): …`, feature PRs read
  `feat(00NN): …` — a small disambiguation aid, not a rename effort.)

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
- **Regenerate + stage the ledger on this status flip (group A.1).** The
  `approved → implementing` change edits a `docs/specs/*.md` file, so the local
  pre-commit hook's `gen-spec-status.mjs --check` will fail unless the ledger is
  fresh. Immediately after flipping `status:`, run
  `node tools/scripts/gen-spec-status.mjs` **in the worktree** (`-C $wt` / from
  `$wt`) and stage the regenerated `docs/specs/STATUS.md` **in the same commit** as
  the status change. This removes the manual regenerate-and-recommit loop.
- **Seed local-only files.** Immediately after the worktree is created or reused
  (so `$wt` exists on disk), copy these three gitignored files from the primary
  checkout (`$root`) into the worktree at the same relative paths. They are
  required to build and run the mobile app but are absent from a fresh worktree
  because git only populates committed files.

  | Relative path                                           | Why needed                                                   |
  | ------------------------------------------------------- | ------------------------------------------------------------ |
  | `.env.local`                                            | API keys for `inject-mobile-env.mjs`                         |
  | `apps/mobile/src/environments/environment.generated.ts` | prod build `fileReplacements` (specs 0026/0038)              |
  | `android/app/google-services.json`                      | Firebase Android config (Gradle/Capacitor, `--check-native`) |

  Reuse the `$root` and `$wt` variables already computed above — do **not**
  re-derive the paths a different way. Use the following PowerShell pattern (exact
  phrasing may vary; the behavior is the contract):

  ```powershell
  $seed = @(
    '.env.local',
    'apps/mobile/src/environments/environment.generated.ts',
    'android/app/google-services.json'
  )
  $seedWarnings = @()
  foreach ($rel in $seed) {
    $src = Join-Path $root $rel
    $dst = Join-Path $wt   $rel
    if (Test-Path -LiteralPath $src) {
      try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
      } catch {
        $seedWarnings += "⚠ Failed to copy $rel — worktree may not build: $_"
      }
    } else {
      $seedWarnings += "⚠ $rel not found in primary checkout — app may not build in this worktree"
    }
  }
  ```

  Rules:
  - **Create the destination's parent directory first** (`New-Item -ItemType
Directory -Force`) — required for brand-new worktrees where
    `apps/mobile/src/environments/` and `android/app/` do not yet exist. The flag
    is a no-op when the directory already exists, so worktree reuse is safe.
  - **`Copy-Item -Force`** overwrites a stale seeded file on reuse so the
    worktree tracks the primary checkout's current values.
  - **On a missing source** (or a copy error): **skip it** — do **not** throw or
    abort. Record a warning string in `$seedWarnings` (or equivalent) to be
    **surfaced in Step 9's report** so a worktree that cannot build is flagged to
    the user, not silently broken.
  - The seeded files are **gitignored and remain gitignored** in the worktree —
    they are copied as opaque local files and are **never read, logged, staged, or
    committed**. A reviewer must not "improve" this step by printing or templating
    their contents.
  - **A blocked/denied copy is skip-and-warn, never an abort (group D-fallback).**
    Treat a copy the permission classifier **denies** exactly like a missing source:
    skip it, record a `$seedWarnings` string, and **surface it in Step 9's report** —
    do **not** abort the run. The mock / emulator / typecheck / lint / test / build /
    e2e paths do **not** need `.env.local` (only `serve-prod-debug` / `serve-prod` /
    `android-usb` do), so a blocked seed is **not** a blocker for the DoD gates — it
    only blocks on-device / real-prod manual testing. If the classifier
    **persistently** blocks the copy, surface to the user the **manual fallback**:
    run the three `Copy-Item` copies once in their own terminal. (The classifier's
    LLM judgment sits above the settings allowlist — see the "Known environment
    behaviors" section on poisoning.)

- **Bootstrap check:** if no `nx.json` exists, go to step 3a.

### 3. Decompose & route (you)

- **DoD ⇄ task-manifest reconciliation pre-flight (group F1).** Before fan-out,
  list every DoD requirement and assert each maps to at least one task in the task
  graph (present in some task's file manifest). Any **orphan** — a DoD requirement
  in no task's manifest, especially `firestore.rules`, `firestore.indexes.json`,
  and rules-tests — becomes a **foundation task** (added to the sequential
  foundation, owned by the orchestrator or routed to infrastructure-engineer). This
  is a belt to spec-reviewer's suspenders: catch the orphan here, at plan time, not
  at final reconciliation.
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

- **The orchestrator never writes slice source/test files** — anything under
  `libs/**/src/` or `apps/**/src/` (excluding the shared/root files Step 3 lists:
  registration barrels, `apps/*` route/export registration). That work goes to a
  specialist subagent, always. You own only foundation/shared/root edits. A
  `PreToolUse` hook enforces this from inside a `feat-*` worktree; if you find
  yourself reaching for Edit/Write on a slice file, that is the signal you've
  dropped the orchestrator role — dispatch the agent instead.
- **Agent failure is never a license to implement manually.** If a routed
  specialist fails, returns null, dies, or reports success but wrote nothing,
  **re-dispatch it** (state "Attempt N/2"). If it still fails after the 2-retry
  bound, **halt that slice as `needs-human`** (draft PR, unresolved item atop the
  body per the Conventions block) — taking the work over by hand is **not** the
  fallback and defeats the independent-implementer guarantee.
- Do **foundation** first, sequentially. Then run the disjointness assertion and
  **fan out** routed specialists in parallel (all calls in one message), each
  confined to its manifest and forbidden from shared/root files or
  install/generate.
- **Workspace-wide typecheck after any `shared/domain` foundation change
  (group F2).** After **any** `shared/domain` foundation change (e.g. widening a
  required field on a shared type), run a **workspace-wide** typecheck —
  `pnpm nx run-many -t typecheck` (or affected with the shared lib as base) — **not**
  just per-task typechecks. A widened required field breaks consumers **outside**
  every task's scope (e.g. an object literal in a slice not listed in "Affected
  slices"), which per-task typechecks miss.
- On fan-in, **capture each agent's reported file list** and reconcile against
  its manifest: re-dispatch any slice whose agent failed/returned null or
  reported success but wrote nothing. (A global `git status` can't attribute
  files per slice or catch a clobber — trust the manifests + reported lists.)
- **Normalize line endings before staging (group E2).** On Windows the `Edit`/
  `Write` tools write CRLF, which trips Prettier's `endOfLine: lf` (`prettier
--check`) and produces a phantom whole-file CRLF diff. After **any** `Edit`/`Write`
  on a source file (including the orchestrator's own foundation edits), run
  `pnpm exec prettier --write <changed files>` — **only the changed files** —
  **before** staging. No whole-file EOL churn, and **no** `.gitattributes`
  renormalization.
- **The orchestrator commits at fan-in (group B) — implementers do not
  self-commit.** After reconciling each agent's reported file list against its
  manifest (and E2-normalizing), the orchestrator **commits all implemented work**
  itself. A WIP commit is fine — the PR is squash-merged. Implementer subagents do
  **not** self-commit: they would race the git index in a shared worktree. This
  committed diff is an explicit **precondition of Step 5** — feature-reviewer
  computes `git -C $wt diff main...HEAD`, so it **must run against a committed
  diff**; if the working tree is dirty at Step 5, commit first.
- **First commit of a cold/fresh worktree needs a long/backgrounded timeout
  (group C).** On the **first commit of a fresh worktree**, husky + lint-staged
  (eslint `--fix`, prettier `--write`, `gen-spec-status --check`) run cold and can
  far exceed the default 2-min Bash timeout, SIGKILLing `git commit` (exit 143)
  mid-hook. For that first commit use a **long timeout — `600000` ms (the Bash
  tool's maximum**, so use that value, not a longer one) — and **prefer
  `run_in_background: true`**, which sidesteps the ceiling entirely when the hook may
  run past 10 min. **Recovery check before retrying:** lint-staged stashes and, on
  kill, its stash-revert may be mid-flight, leaving the tree needing
  re-verification. Before re-committing, inspect `git status --short` **and**
  `git stash list`; if lint-staged left a stash, **restore it** before
  re-committing.
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

- **Precondition (group B): feature-reviewer must run against a committed diff.**
  The reviewer computes `git -C $wt diff main...HEAD`; if the work is still in the
  working tree, that diff is empty and the reviewer returns a bogus blocking
  `NEEDS_REWORK`. If the working tree is dirty at this point, **commit first**
  (Step 4 already commits at fan-in).
- Spawn **feature-reviewer** on the diff (`git -C $wt diff main...HEAD`). For
  `NEEDS_REWORK`, dispatch the appropriate specialist(s) by scope tag (you handle
  shared-file fixes), re-review, up to the bound; then record open findings.

### 6. QA → bounded fix

- Spawn **qa-runner**; it returns each gate's raw result. **You make the
  skip-vs-fail call:** a gate the spec _required_ (e.g. named e2e flows) that was
  `SKIPPED` is a **blocking** unmet DoD gate, not an acceptable skip (only
  genuinely-not-bootstrapped tooling is an OK skip). For `FAIL`/unmet, dispatch
  the relevant specialist with details, re-run QA, up to the bound.
- **`cap sync` on Windows (group E1).** Use `pnpm exec cap sync android` (not
  `npx cap …` — `npx` can't resolve the `cap` binary in the pnpm workspace).
  `cap sync`'s copy step **aborts without a prior web build** ("Could not find the
  web assets directory: `dist/apps/mobile/browser`"), so when a spec's DoD requires
  `cap sync`, run **`pnpm nx build mobile` first**, then `pnpm exec cap sync
android` (or `pnpm exec cap copy android`).
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

- **Sync with `origin/main` first (group A.2).** Before the commit/push, the
  worktree branched off `main` at Step 2 and `main` has likely advanced (its
  committed `docs/specs/STATUS.md` ledger is now stale relative to a fresh render).
  Run `git -C $wt fetch origin main`, then `git -C $wt merge origin/main` into the
  feature branch — **merge, not rebase** (the PR is squash-merged, so a merge
  commit is harmless, and merge cleanly absorbs a "Update branch" divergence).
  Resolve any `STATUS.md` conflict by **regenerating** the ledger
  (`node tools/scripts/gen-spec-status.mjs` in `$wt`) and staging the regenerated
  file — **not** by hand-editing the ledger.
- Flip the spec to `status: done` **in the diff** by reading the frontmatter and
  setting `status:` (inserting it if absent — don't assume a line exists).
  Merging marks it done. **Regenerate + stage the ledger on this status flip
  (group A.1):** the `→ done` change edits a `docs/specs/*.md` file, so run
  `node tools/scripts/gen-spec-status.mjs` in `$wt` and stage the regenerated
  `docs/specs/STATUS.md` **in the same commit** as the status change (else the
  pre-commit hook's `--check` fails). Commit all work, push `feat/NNNN-slug`.
- **Reconcile with the remote head before pushing (group A.3) — only when the PR
  already exists.** On a `/rework-feature` or resumed run (a re-push into an
  existing PR), run `gh pr view <pr> --json headRefOid` and compare to local
  `HEAD`; if the remote is **ahead** (someone clicked GitHub's "Update branch"
  button, adding a `Merge branch 'main'` commit the local worktree lacks),
  `git -C $wt fetch origin feat/NNNN-slug` and merge / fast-forward the remote
  branch into local **before** pushing, so the push is never rejected
  non-fast-forward. On the **initial `gh pr create`** there is no PR yet, so this
  is a **no-op — skip it**. (Cross-ref the standing memory items
  `spec-status-ledger-ci-race` and `audit-docs-report-pr-lifecycle` — same
  ledger-staleness family.)
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
- **A `STATUS.md` freshness failure is not a code failure (group A.4).** If CI's
  `doc-integrity-test` (ledger freshness guard) fails because `docs/specs/STATUS.md`
  is stale, treat it as **"regenerate the ledger + push"** — run
  `node tools/scripts/gen-spec-status.mjs` in `$wt`, stage the regenerated ledger,
  commit, push — **not** as a code failure requiring a specialist fix. (This is the
  CI-side counterpart of the A.1/A.2 regenerate discipline.)

### 9. Report

- Report the PR URL, what was built, QA result, unresolved items. The user
  reviews and merges manually; comments or a `needs-human` draft → `/rework-feature`.
- Leave the worktree for rework; remove after merge: `git worktree remove --force $wt`.
