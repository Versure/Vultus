---
name: rework-spec
description: Apply review feedback to a Vultus spec PR. Pulls the review comments from the spec's pull request, reworks the spec file via the spec-author agent, and pushes back to the same PR branch for the user to re-review and merge. Use after the user has left comments on a spec PR created by create-spec.
---

# Rework Spec

Pull review feedback from a spec PR, revise the spec, and push it back to the
same PR. Reuses the **spec-author** agent (revise mode). (Project-wide rules are
in `CLAUDE.md`.)

## Conventions
- Operates on a `spec/NNNN-slug` branch / its PR; pushes to the same branch.
- Sanity re-review loop bound **2** (override via `$ARGUMENTS`); state
  "Attempt N/2" before each retry.

## Steps

### 1. Identify the spec PR + worktree
- From `$ARGUMENTS` (PR number/branch) or the current branch
  (`git branch --show-current`); if not on a `spec/*` branch, list open spec PRs
  (`gh pr list --label spec`) and ask which.
- Resolve the absolute worktree path (`$wt`, dir `spec-NNNN-slug`):
  ```powershell
  $root = (git rev-parse --path-format=absolute --git-common-dir) -replace '\.git$',''
  $wt   = [System.IO.Path]::GetFullPath("$root/../Vultus-worktrees/spec-NNNN-slug")
  ```
  `git worktree prune`; if `$wt` is registered, reuse it
  (`git -C $wt checkout spec/NNNN-slug; git -C $wt pull`); elif the branch exists,
  `git worktree add --force $wt spec/NNNN-slug`.

### 2. Pull the review feedback
- `gh pr view <pr> --json comments,reviews,body` for PR-level + review bodies,
  and `gh api "repos/{owner}/{repo}/pulls/<pr>/comments"` for inline review-thread
  comments (substitute the real PR number; brace placeholders, not `:owner`).
- Consolidate into a clear change list. Ask the user if anything is ambiguous.

### 3. Rework
- Spawn **spec-author** in *revise* mode with the spec path and consolidated
  comments. It edits in place, addressing each comment and noting any it
  intentionally doesn't apply.

### 4. Optional sanity re-review
- For non-trivial changes, spawn **spec-reviewer** once; fix blocking findings via
  spec-author up to the loop bound.

### 5. Push
- Confirm the spec keeps `status: approved` (re-set it if spec-author's revision
  dropped it). Commit and push to the **same** `spec/NNNN-slug` branch. If the PR
  was a draft and review now passes, mark it ready (`gh pr ready <pr>`).
- Optionally reply to / resolve addressed PR threads.
- Report what changed. The user re-reviews and **merges manually** — merging
  lands `approved` on `main` for `/implement-feature`. Don't merge it yourself;
  after merge the `spec-NNNN-slug` worktree can be removed.
