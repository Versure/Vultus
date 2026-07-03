---
number: 0065
slug: worktree-dependency-bootstrap
title: Bootstrap dependencies in the implement-feature worktree (fresh worktrees have no node_modules)
status: implementing # draft | approved | implementing | done
slices: [] # tooling / prompt-file change — touches no product slice
scopes: [] # .claude/** prompt files + CLAUDE.md; no Sheriff scope tag applies
created: 2026-07-02
---

# Bootstrap dependencies in the implement-feature worktree

## Context

`/implement-feature` creates a **fresh git worktree** under `../Vultus-worktrees/feat-NNNN-slug`
(`.claude/skills/implement-feature/SKILL.md:91`, Step 2; the `git worktree add` recipe
is at `:92-101`) and seeds three gitignored files into it (spec 0040), but **no step
anywhere establishes dependencies in that worktree**. `node_modules` is gitignored
(`.gitignore:15`), so a fresh worktree has none — yet later steps assume it exists:

- `.husky/pre-commit` is literally `pnpm exec lint-staged`, and
  `lint-staged.config.mjs:24-29` resolves `eslint` / `prettier` from `node_modules`.
- `pnpm exec prettier --write` (SKILL.md group E2), `pnpm nx run-many -t typecheck`
  (Step 4), and every `qa-runner` gate all require installed dependencies.

The knowledge to handle this lives **only in maintainer memory**, not in any repo
file — a repo-wide grep for `bin-links` returns **zero** matches — violating CLAUDE.md's
contract that each skill's mechanics live entirely in its `SKILL.md`. Four memory items
capture it, and — importantly — they describe a **conditional** procedure, not a blanket
install:

- `worktree-no-node-modules-commit`: for a **zero-code (prompt/config/docs-only) spec**
  (`nx affected` empty, no test surface), a full worktree `pnpm install` (~11 min +
  Windows traps) is **disproportionate**; run the pre-commit hook's substantive steps
  via the **primary checkout's** tooling instead, and **never junction** the primary
  `node_modules` into the worktree (the `pnpm exec` dep-status check can _purge_ it,
  deleting the primary checkout's real `node_modules` — observed on spec 0063).
- `worktree-pnpm-semver-bin`: for a **code-bearing spec** that does need a real install,
  the first `pnpm install` on Windows can fail on the firebase-tools nested `semver`
  bin-link (`ENOENT … semver.js.EXE`); the recovery is to **re-run** with
  `--config.bin-links=false` (~11 min, succeeds). `re2: false` / `sharp: true` in
  `pnpm-workspace.yaml:17-18` are prerequisites (already landed).

Spec 0063 ("harden the implement-feature workflow") shipped without closing this gap;
the `qa-runner`/pre-commit cold-timeout notes (0063 group C) implicitly assume the hook
_runs_, which presupposes dependencies no step establishes.

**Intended outcome.** Encode a **spec-class-conditional** worktree-bootstrap step into
`implement-feature` (and `rework-feature`): a **code-bearing** spec gets a real, trap-aware
worktree install; a **docs-only** spec (this spec's own family, 0065–0071, is exactly
this class) uses the primary-checkout tooling shortcut and **skips** the 11-min install;
and **neither** junctions `node_modules`. Pure prompt-file change that moves the memory
procedure into the repo.

## Scope

In scope:

- **`.claude/skills/implement-feature/SKILL.md`** — add a spec-class-conditional
  worktree-bootstrap substep to Step 2 (after `git worktree add` + the spec-0040 seed,
  before any `pnpm exec` / commit / gate).
- **`.claude/skills/rework-feature/SKILL.md`** — Step 1 reuses or recreates the worktree
  under the same assumption; add the same bootstrap-if-missing note.
- **`CLAUDE.md`** — a short note (beside the E1/E2/E3 Windows notes or the cold-hook note)
  recording the conditional recipe, the ~11-min cost, and the junction hazard.

Out of scope:

- Any application, lib, function, type, UI, Firestore, Nx-target, CI, or
  `pnpm-workspace.yaml` change. The `allowBuilds` entries (`re2: false`, `sharp: true`)
  are already in `pnpm-workspace.yaml` and are not re-litigated here.
- Changing the seed-copy behavior (spec 0040) or the cold-hook timeout handling (spec
  0063 group C) — those stand; this spec only establishes the dependencies (or the
  documented no-install shortcut) that make them reachable.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). Every changed file is a skill/standing-instruction
markdown file outside the Nx/TS/Sheriff project graph. No import, no lib, no
DRY/3+-slice question.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or rule (PLAN §4 unaffected).

## Public types / APIs

**None.** The change is the natural-language behavior of two `SKILL.md` files and one
`CLAUDE.md` note. Concrete required behavior:

### Bootstrap step (implement-feature Step 2)

After `git worktree add` and the spec-0040 seed, before any `pnpm exec`, gate, or commit,
the orchestrator MUST **classify the spec and bootstrap accordingly**:

- **Classify.** A spec is **code-bearing** if any changed path is inside the Nx/TS graph
  (`apps/**`, `libs/**`, `tools/**` executable code) or `nx affected` is non-empty;
  otherwise it is **docs-only** (`slices: []`/`scopes: []`, changes confined to
  `.claude/**`, `docs/**`, root config markdown). When unsure, treat as code-bearing.

- **Code-bearing → real worktree install**, run with `-C $wt` / `cd $wt` in the same call
  (per the E3 no-persisted-cwd rule) and a **long/backgrounded timeout** (~11 min; use the
  Bash-tool max or `run_in_background`):
  1. Attempt `pnpm install` in `$wt`.
  2. **If** it fails on the Windows firebase-tools `semver` bin-link
     (`ENOENT … semver.js.EXE`, exit ~4294963238), **re-run** `pnpm install --config.bin-links=false`
     (this succeeds and creates all package symlinks + `.bin` entries).
     Document the traps inline: the semver bin-link fail-then-retry; the `re2`/`sharp`
     `allowBuilds` prerequisites (already in `pnpm-workspace.yaml`, but a fresh placeholder
     on future dep changes aborts install and must be set).

- **Docs-only → skip the install; use the primary-checkout shortcut** (per
  `worktree-no-node-modules-commit`): run the hook's substantive steps with the primary
  checkout's tooling — `node <repoRoot>/node_modules/prettier/bin/prettier.cjs --write <changed files>`
  (invoked from the worktree cwd so config/ignore resolve) and
  `node tools/scripts/gen-spec-status.mjs` (zero-dep) — then commit. Without `node_modules`
  the `pnpm exec lint-staged` pre-commit hook effectively no-ops, and CI's full install is
  the authoritative gate.

- **Never junction** the primary checkout's `node_modules` into the worktree: `pnpm exec`
  runs a dep-status check that can **purge** the modules dir, deleting the primary
  checkout's real `node_modules`. State this as a hard prohibition in both branches.

- On a **code-bearing** install failure that isn't the documented semver mode, halt the
  run as `needs-human` with the install output — do not proceed to gates that will
  cascade-fail on missing deps.

### rework-feature Step 1

Add: if the worktree is being **recreated**, or a **code-bearing** rework finds no
`node_modules` (mechanical check: `if (-not (Test-Path "$wt/node_modules"))`), run the same
class-conditional bootstrap before any gate; if reusing an existing worktree that already
has `node_modules`, skip. Never junction.

### CLAUDE.md

A short note, e.g.: "A **fresh feature worktree has no `node_modules`** (gitignored).
For a **code-bearing** spec, install in the worktree — `pnpm install`, and on the Windows
firebase-tools `semver` bin-link failure re-run with `--config.bin-links=false` (~11 min).
For a **docs-only** spec, skip the install and run prettier/`gen-spec-status` via the
primary checkout's tooling (`worktree-no-node-modules-commit`). **Never junction the
primary `node_modules` into a worktree** — `pnpm exec` can purge it."

## UI / Stitch screen refs

**Not applicable.** No UI is built or changed.

## Implementation task graph

The two skill files and CLAUDE.md are distinct files but the wording must stay consistent.
Route to **infrastructure-engineer** (tooling territory, per spec 0040/0063 precedent).
All three manifests are pairwise disjoint, so all may run in parallel; T1 is listed first
as the largest/highest-value change.

- **T1** — `implement-feature/SKILL.md`: add the Step-2 class-conditional bootstrap substep.
- **T2** — `rework-feature/SKILL.md`: add the bootstrap-if-missing note with the
  `Test-Path` check.
- **T3** — `CLAUDE.md`: add the conditional install note + junction prohibition.

## Test plan

Prompt/config change with **no executable workspace code** — no unit/component/e2e surface.
`nx affected` shows no project (expected). This spec is itself **docs-only**, so its own
implementation must follow the docs-only branch it defines (a useful dogfood check).

Verification **by inspection**:

1. `implement-feature/SKILL.md` Step 2 classifies code-bearing vs docs-only and specifies
   both branches (code-bearing: `pnpm install` then `--config.bin-links=false` on the
   semver failure; docs-only: primary-checkout prettier + `gen-spec-status`, skip install),
   placed before any `pnpm exec` / gate / commit.
2. Both branches, and `rework-feature`/`CLAUDE.md`, contain the **never-junction** hazard.
3. `rework-feature/SKILL.md` Step 1 bootstraps a missing/recreated worktree with the
   `Test-Path "$wt/node_modules"` check.
4. The `bin-links=false` fail-then-retry recipe, the docs-only shortcut, and the
   never-junction hazard now appear in-repo (grep succeeds), not only in maintainer memory.

## Definition of done

- [ ] `implement-feature/SKILL.md` Step 2 bootstraps **conditionally**: code-bearing →
      `pnpm install` with the semver fail-then-`--config.bin-links=false` retry; docs-only →
      primary-checkout prettier + `gen-spec-status`, no worktree install. Placed before any
      gate/commit; a `needs-human` halt on an undocumented code-bearing install failure.
- [ ] The **never-junction `node_modules`** prohibition is stated in
      `implement-feature/SKILL.md`, `rework-feature/SKILL.md`, and `CLAUDE.md`.
- [ ] `rework-feature/SKILL.md` bootstraps a missing/recreated worktree via the
      `Test-Path "$wt/node_modules"` check.
- [ ] `CLAUDE.md` has the conditional install note.
- [ ] No other file changed; no code/CI/`pnpm-workspace.yaml` change.
- [ ] `nx affected` shows no affected project (expected); verification by inspection.

## Risks

1. **Wrong classification is the main hazard.** Misclassifying a code-bearing spec as
   docs-only skips a needed install and cascade-fails the gates; the rule therefore
   defaults to **code-bearing when unsure**, and the docs-only shortcut is gated on
   `nx affected` being empty AND the diff being entirely outside the Nx/TS graph (matching
   `worktree-no-node-modules-commit`'s stated safety condition).
2. **The junction shortcut must never be offered.** Junctioning primary `node_modules` can
   delete it via `pnpm exec`'s purge (observed, spec 0063); the spec prohibits it in every
   branch rather than presenting it as a faster alternative.
3. **Install duration vs tool timeout.** ~11 min exceeds the default Bash timeout; the
   code-bearing branch mandates the Bash-tool max timeout or `run_in_background`, and a
   long-running install is not a failure (mirrors spec 0063 group C).
4. **`--config.bin-links=false` is a retry, not the first command.** Per
   `worktree-pnpm-semver-bin` the flag is the recovery after a plain `pnpm install` hits the
   semver bin-link error; the spec prescribes that observed sequence rather than asserting
   the flag as a verified cold-start first command.
5. **No architecture/PLAN conflict.** Prompt/config edit outside the Nx/TS/Sheriff graph;
   hardens the PLAN §5 workflow, changes no slice or data model.
