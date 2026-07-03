---
name: cleanup-feature
description: Clean up after a merged Vultus feature PR — remove its git worktree and on-disk directory, fast-forward main, and delete the merged local + remote-tracking branch. Use after a feat/NNNN-slug PR created by implement-feature/rework-feature has been merged, when the user asks to clean up / tear down a feature worktree.
---

# Cleanup Feature

Tear down the per-feature worktree and branch once its PR is merged, and bring
the primary `main` checkout up to date. The mirror image of `implement-feature`
step 2 (which created the worktree) — run it after merge. (Project-wide rules —
shell, branches — are in `CLAUDE.md`.)

## Safety rules (read first)

- **Only act on a branch whose PR is confirmed `MERGED`.** Never delete a
  worktree/branch for an open or closed-unmerged PR — verify first, refuse
  otherwise. Deleting an unmerged branch loses work.
- **Only remove the worktree directory that belongs to the target feature.** Do
  **not** touch sibling directories under `Vultus-worktrees/` you didn't create
  this run — they may be other in-flight features. **Surface** orphaned
  leftovers; don't delete them unless the user confirms (see step 6).
- **Shell is PowerShell** (Windows). Use PS-safe syntax (`2>$null`, `$LASTEXITCODE`).
- This skill **only deletes** local artifacts — it never force-pushes, reopens,
  or mutates the remote beyond pruning stale tracking refs.

## Steps

### 1. Identify the feature + resolve paths

- From `$ARGUMENTS` (a PR number, or `NNNN`/slug, or `feat/NNNN-slug`). If
  absent, infer from the **current branch** if it is a `feat/NNNN-slug`; else
  list recently merged feature PRs (`gh pr list --state merged --limit 10
--json number,headRefName,title`) and ask which one.
- Resolve the worktree path the same way `implement-feature` did (run from the
  **primary** checkout, not the worktree — the common-dir formula is
  worktree-invariant):
  ```powershell
  $root = (git rev-parse --path-format=absolute --git-common-dir) -replace '\.git[\\/]?$',''
  $wt   = [System.IO.Path]::GetFullPath("$root/../Vultus-worktrees/feat-NNNN-slug")
  ```

### 2. Verify the PR is merged (gate)

- `gh pr view <pr-or-branch> --json state,mergedAt,headRefName,mergeCommit`.
- Proceed **only** if `state == "MERGED"`. If `OPEN` → stop and tell the user to
  merge first (or run `/rework-feature`). If `CLOSED` (unmerged) → stop and
  surface it; do not delete anything.

### 3. Fast-forward the primary checkout

- Make sure the shell is in the **primary** checkout (you cannot delete the
  branch/worktree you are standing in). `cd $root` (the primary repo path).
- `git checkout main` (if not already on it), then `git pull --ff-only`. This
  pulls in the squash-merge commit so the merged code is on local `main`.

### 4. Remove the worktree (registration + directory)

- `git worktree prune` first (clears any already-deleted registrations).
- If `$wt` is still registered (`git worktree list`):
  `git worktree remove --force $wt`.
- **Windows gotcha:** `git worktree remove` often fails with `Directory not
empty` because of the worktree's `node_modules`. On any failure, fall back:
  ```powershell
  git worktree prune
  if (Test-Path $wt) { Remove-Item -Recurse -Force $wt }
  ```
  Deleting `node_modules` can take a minute or two — run it in the background and
  confirm the directory is gone before reporting. Finish with `git worktree prune`.

### 5. Delete the branch + prune tracking refs

- `git branch -d feat/NNNN-slug`. **Squash-merge gotcha:** because the repo
  squash-merges (CLAUDE.md), the feature commits are _not_ ancestors of `main`,
  so `-d` may refuse with _"not fully merged"_. Since step 2 already confirmed
  the PR is `MERGED`, it is safe to then run `git branch -D feat/NNNN-slug`.
- `git remote prune origin` (or `git fetch --prune`) to drop the stale
  `origin/feat/NNNN-slug` tracking ref.

### 6. Report + flag orphans

- Confirm: `git worktree list` (should no longer list the feature), local branch
  gone, `main` at the merge commit (`git log --oneline -1`).
- **Detect orphaned leftovers:** list directories under `Vultus-worktrees/` that
  are **not** in `git worktree list` (leftover dirs from earlier features whose
  cleanup was skipped). Report them with their apparent branch. **Do not delete
  them** — ask the user whether to remove each (and only after confirming its PR
  is merged). If the `Vultus-worktrees/` parent is now empty, offer to remove it.
- **Orphans hold seeded secrets (spec 0068).** Every feature worktree is seeded
  with **unencrypted copies** of three secret files (spec 0040 seed):
  - `.env.local`
  - `apps/mobile/src/environments/environment.generated.ts`
  - `android/app/google-services.json`

  Orphaned worktrees are deliberately never auto-deleted, so these copies
  **accumulate on disk unencrypted**. Flag this in the orphan report.

- **Cheap "purge seeds" option.** For each orphan, offer to delete **just those
  three seeded files** (by path) while leaving the rest of the worktree intact.
  This is **safe even for unmerged work** — the seeds are regenerable local
  copies, not the orphan's real changes — so it does **not** require the
  merged-PR gate that removing the whole worktree does. Delete by path only; **do
  not read or print the contents** of these files. Example (PowerShell):
  ```powershell
  foreach ($f in @(
    "$orphan/.env.local",
    "$orphan/apps/mobile/src/environments/environment.generated.ts",
    "$orphan/android/app/google-services.json"
  )) { if (Test-Path $f) { Remove-Item -Force $f } }
  ```
- Summarize what was removed and anything left for the user to decide.
