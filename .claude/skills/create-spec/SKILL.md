---
name: create-spec
description: Kick off the Vultus specification process for a new feature. Interviews the user as an architect, drafts a spec file (docs/specs/NNNN-slug.md) via the spec-author agent, auto-reviews and reworks it via spec-reviewer, then opens a PR for manual review. Use when the user wants to spec a new feature, start a spec, or write a specification before implementation.
---

# Create Spec

Turn a feature idea into a reviewed `docs/specs/NNNN-slug.md` spec and open a PR
for the user to review. You orchestrate; the `spec-author` and `spec-reviewer`
agents do the writing and reviewing. (Project-wide rules — shell, secrets,
branches, architecture — are in `CLAUDE.md`.)

## Conventions

- Specs: `docs/specs/NNNN-slug.md` (zero-padded). Spec branch `spec/NNNN-slug`,
  PR targets `main`. Status lifecycle `draft → approved → implementing → done`
  (no `in-review`; the open spec PR _is_ the review).
- Next number: enumerate the highest `NNNN` from the **union of three sources**
  and take `max + 1` (start at `0001`):
  1. `docs/specs/*.md` filenames on `main` (the `NNNN` prefix);
  2. every **open PR head branch** matching `spec/NNNN-*` **or** `feat/NNNN-*`
     — `gh pr list --state open --json headRefName` with **no `--label` filter**;
  3. local + remote branches matching the same patterns (`git branch -a`).
     The `spec` label is **cosmetic only and must never gate the scan** — the label
     is applied best-effort/silent-on-failure (step 5), so a label-filtered scan can
     miss an unlabeled open spec PR and reuse its number. Truly simultaneous runs can
     still collide — serialize bulk spec creation.
- Auto-review↔rework loop bounded to **2** (override via `$ARGUMENTS`); state
  "Attempt N/2" before each retry. On exhaustion, open the PR as a **draft** with
  a `needs-human` label and unresolved findings at the top of the body.

## Steps

### 1. Interview (you, interactively — this is the point of the skill)

- **Requires an interactive session** (`AskUserQuestion`). If questioning isn't
  available (autonomous loop/scheduler), don't draft from nothing: require a
  written feature brief in `$ARGUMENTS`, else stop and ask for one.
- Read `docs/PLAN.md` (architecture §3, data model §4, DoD §5) and skim
  `docs/specs/*` for context.
- Act as a software architect: draw out the user-facing capability, target
  slice(s), acceptance criteria, data-model touchpoints, edge cases, UI screens.
  **Present options with a recommendation**, but let the user decide each call.
- **e2e probe (mobile UI features):** if the feature introduces a new
  page/route or a critical user action (add, remove, status change,
  navigation), ask which flows should be covered by e2e and whether any
  depend on unmerged specs (→ `test.fixme`). Record the approved flows in
  the decision record so `spec-author` names them explicitly in the Test
  plan section.
- **DoD → task-graph coverage probe (F1):** as acceptance criteria firm up,
  check that **every** DoD checkbox maps to at least one task/manifest — surface
  any **orphan** requirement that no task would own, **especially**
  `firestore.rules`, `firestore.indexes.json`, and rules-tests (these were
  authored into the DoD but into no task manifest and escaped until final
  reconciliation). Record each DoD item's owning task in the decision record so
  `spec-author` leaves no orphan.
- **Shared-type ripple probe (F2):** if the change makes a `shared/domain` field
  **required** (or otherwise breaks existing consumers), treat it as a
  **repo-wide ripple** — grep for the type / its object literals across the whole
  repo and enumerate **all** affected slices, not just the obviously related
  ones. Record every affected slice in the decision record so `spec-author`
  lists them all under "Affected slices."
- **Rendered-text assertion probe (F3):** for any assertion on **rendered UI
  text**, agree that component/unit tests assert the **exact string**, not a
  whitespace-normalized one that can mask a rendering defect (e.g. a stray space),
  and that component and e2e assertions stay **consistent** on the same text.
  Record this in the decision record so `spec-author` reflects it in the Test
  plan.
- **Onboarding ↔ User-field parity probe (F4):** as acceptance criteria firm up,
  if the feature adds a new field to the `User` domain type
  (`@vultus/shared/domain`'s `documents.ts`) or changes the meaning/shape of an
  existing one, ask the user (architect-interview style, via `AskUserQuestion` in
  an interactive session) whether that preference belongs in **first-launch
  onboarding** or is **deliberately Settings-only**. Record which — and, for
  Settings-only, the one-line justification — in the decision record so
  `spec-author` states the resolution explicitly (silence is a blocking
  spec-reviewer finding).
- If the feature is too big for one PR/session (PLAN §6), propose a split.
- Record the decisions into a concise decision record for `spec-author`.

### 2. Create the worktree + branch

- Determine `NNNN` and `slug`. Branch→dir maps `/`→`-` (so `spec/NNNN-slug` →
  dir `spec-NNNN-slug`). Resolve an absolute, worktree-invariant path once:
  ```powershell
  # Single deriver of $root/$wt (tools/scripts/resolve-worktree.mjs, spec 0071).
  # Prints two lines: $root (primary checkout) then $wt (this worktree).
  $resolved = node tools/scripts/resolve-worktree.mjs spec-NNNN-slug
  $root = $resolved[0]
  $wt   = $resolved[1]
  ```
- Create idempotently: `git worktree prune`; if `$wt` is already registered,
  reuse it (`git -C $wt checkout spec/NNNN-slug; git -C $wt pull`); elif the
  branch exists, `git worktree add --force $wt spec/NNNN-slug`; else
  `git worktree add -b spec/NNNN-slug $wt main`. The branch must not be active in
  the primary checkout. Use `git -C $wt ...` throughout.

### 3. Draft the spec

- Spawn **spec-author** in _draft_ mode. Pass: the decision record, the absolute
  path `$wt/docs/specs/NNNN-slug.md`, today's date, and `status: approved`
  (merging the spec PR is the approval — written in the diff so the no-comment
  path still lands `approved` on `main`).

### 4. Auto-review → bounded rework

- Spawn **spec-reviewer** on the draft. If `NEEDS_REWORK`, spawn **spec-author**
  in _revise_ mode with the blocking findings, then re-review. Up to the bound.

### 5. Open the PR

- Commit the spec in the worktree, push, and `gh pr create --base main --title
"<spec title>"` (add `--draft` if the review bound was hit). Body summarizes
  Context/Scope and lists any open review notes.
- Label best-effort (never blocking): `gh label create spec --color BFD4F2
--force 2>$null`, then `gh pr edit <pr> --add-label spec 2>$null`.
- Report the PR URL. Tell the user: review on the PR, comment, run `/rework-spec`
  to apply comments, **merge when satisfied** (merge lands `approved` on `main`).
  After merge the `spec-NNNN-slug` worktree can be removed
  (`git worktree remove --force $wt`).
