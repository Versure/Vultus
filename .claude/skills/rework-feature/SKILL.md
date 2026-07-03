---
name: rework-feature
description: Apply review feedback to a Vultus feature PR. Pulls the PR review comments, reworks the code via the same specialist implementer/feature-reviewer/qa-runner agents used by implement-feature, pushes to the same PR branch, and re-watches the CI pipeline until green. Use after the user has left comments on a feature PR created by implement-feature.
---

# Rework Feature

Apply PR feedback to an open feature PR and get it green again. Same pipeline as
`implement-feature`, reusing the specialist implementers, **feature-reviewer**,
and **qa-runner** — driven by PR comments (or a surfaced `needs-human` draft)
instead of a fresh spec. (Project-wide rules are in `CLAUDE.md`.)

## Conventions

- Operates on a `feat/NNNN-slug` branch / its PR; pushes to the same branch.
- The **concurrency model is identical to implement-feature**: you own all
  shared/root files; parallel agents are confined to disjoint slice files and
  never run install/generate. Auto-fix loops bounded to **2** (override via
  `$ARGUMENTS`); state "Attempt N/2" before each retry. Never merge.

## Steps

### 1. Identify the PR + worktree

- From `$ARGUMENTS` (PR number/branch) or the current branch; else list open
  feature PRs (`gh pr list`) and ask.
- Resolve the absolute worktree path (`$wt`, dir `feat-NNNN-slug`):
  ```powershell
  $root = (git rev-parse --path-format=absolute --git-common-dir) -replace '\.git$',''
  $wt   = [System.IO.Path]::GetFullPath("$root/../Vultus-worktrees/feat-NNNN-slug")
  ```
  `git worktree prune`; if `$wt` is registered (implement-feature leaves it in
  place), reuse it (`git -C $wt checkout feat/NNNN-slug; git -C $wt pull`); elif
  the branch exists, `git worktree add --force $wt feat/NNNN-slug`.
- **Bootstrap dependencies if missing (spec 0065).** If the worktree is being
  **recreated** (`git worktree add`), or a **code-bearing** rework reuses a worktree
  that has no `node_modules` (mechanical check:
  `if (-not (Test-Path "$wt/node_modules"))`), run the **same class-conditional
  bootstrap** as implement-feature's Step 2 **before any gate**: code-bearing →
  `pnpm install` in `$wt` with the semver fail-then-`--config.bin-links=false`
  retry (~11 min, long/backgrounded timeout); docs-only → skip the install and run
  prettier / `gen-spec-status` via the primary checkout's tooling. If reusing an
  existing worktree that **already has `node_modules`**, skip the install. **Never
  junction** the primary checkout's `node_modules` into the worktree — `pnpm exec`
  runs a dep-status check that can purge it, deleting the primary checkout's real
  `node_modules` (a hard prohibition).

### 2. Pull the work to do — two sources

- (a) Human feedback: `gh pr view <pr> --json comments,reviews,body` plus
  `gh api "repos/{owner}/{repo}/pulls/<pr>/comments"` for inline threads
  (substitute the real PR number).
- (b) If the PR is a **draft carrying `needs-human`** (an implement-feature loop
  exhausted its bound), the unresolved findings at the top of the PR body. This
  skill is the re-entry point for those, not just commented PRs.
- Consolidate into a concrete change list; ask the user if anything is ambiguous.

### 3. Implement the fixes

- Map each item to the slice/file it affects and **route by scope tag** (same
  routing + tiebreakers as implement-feature §3): `scope:functions` →
  **backend-engineer**, `scope:mobile`/`shared/ui-kit` → **frontend-engineer**,
  config/CI/Firebase/native-Capacitor → **infrastructure-engineer**,
  `scope:shared` non-UI/glue → **feature-implementer**. **You** apply shared/root
  fixes yourself. Parallel only across disjoint slices (assert manifests first);
  sequential where they share files.
- **Keep lib READMEs current** (CLAUDE.md DoD): if a fix changes a lib's public
  API/behavior/boundaries, update that lib's `README.md` in the same change —
  never leave the generated Nx scaffold text.

### 4. Auto-review → bounded rework

- Spawn **feature-reviewer** on the updated diff; dispatch the relevant specialist
  for blocking findings, re-review, up to the bound.

### 5. QA → bounded fix

- Spawn **qa-runner**; **you make the skip-vs-fail call** against the spec's DoD.
  On `FAIL`/unmet gate, dispatch the relevant specialist with details, re-run, up
  to the bound.

### 6. Push & watch the pipeline

- Commit and push to the **same** `feat/NNNN-slug` branch.
- `gh pr checks <pr>` (exit `0` pass / `8` pending / `1` fail-or-none —
  disambiguate via "no checks reported" / `4`+network = auth, stop). If checks
  exist, `gh pr checks <pr> --watch --interval 30`; on a real failure fetch
  `gh run view <id> --log-failed` (id via `gh run list --branch feat/NNNN-slug
-L 1 --json databaseId`), fix via the relevant specialist, push, re-watch — up
  to the bound. Optionally reply to / resolve addressed threads.

### 7. Report

- If the PR was a draft and everything now passes, mark it ready and clear the
  flag: `gh pr ready <pr>`; `gh pr edit <pr> --remove-label needs-human 2>$null`.
  If a loop hit its bound again, keep it a draft with `needs-human`.
- Report the PR URL, what changed, QA result, unresolved items. The user merges
  manually. The spec is already `status: done` (flipped by implement-feature) —
  verify and set it if missing.
