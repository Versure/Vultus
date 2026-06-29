---
number: 0040
slug: seed-worktree-local-files
title: Seed gitignored local files into feature worktrees on creation
status: approved
slices: []
scopes: []
created: 2026-06-29
---

# Seed gitignored local files into feature worktrees on creation

## Context

When `/implement-feature` runs `git worktree add` to create a feature worktree
(`feat/NNNN-slug` under `../Vultus-worktrees/`), git only populates **committed**
files. Three **gitignored** files that are required to build and run the mobile
app are therefore **absent** from every freshly-created worktree:

1. **`.env.local`** (repo root) — holds the Firebase / TMDB API keys; consumed by
   `tools/scripts/inject-mobile-env.mjs` to produce `environment.generated.ts`.
2. **`apps/mobile/src/environments/environment.generated.ts`** — produced from
   `.env.local`; referenced by the production build target's `fileReplacements`
   (specs 0026 / 0038).
3. **`android/app/google-services.json`** — the Firebase Android config; required
   by Gradle / Capacitor and asserted by the `--check-native` preflight (spec
   0026).

Without these, `pnpm nx serve mobile`, `pnpm nx build mobile`, and any APK build
**fail inside the worktree** — so an agent (or the user) cannot manually test a
feature in its worktree without hand-copying these files from the primary
checkout every single time. This is pure friction that recurs on every feature.

**Intended outcome.** Immediately after a worktree is created, `implement-feature`
**seeds** these three local-only files from the primary checkout into the
worktree, so the worktree builds and runs like the primary checkout. The copy is
**best-effort**: a missing source file is skipped with a warning surfaced in the
final report, and **never** aborts worktree creation.

This is a **pure tooling / prompt-file change**: it edits only
`.claude/skills/implement-feature/SKILL.md`. No application code, no libs, no
Firestore schema, no UI, no Nx target, and no Sheriff tag are touched.

## Scope

In scope:

- **`.claude/skills/implement-feature/SKILL.md`** — the single changed file. Add a
  **"Seed local-only files"** substep to **Step 2 ("Create the worktree")**,
  immediately after the worktree has been created/reused, that copies the three
  gitignored files listed above from the primary checkout (`$root`) into the
  worktree (`$wt`), creating intermediate directories as needed, skipping any
  source that is absent and recording a warning for Step 9's report.

Out of scope:

- **Any application, lib, function, type, UI, or Firestore-schema change.** This
  spec changes a skill prompt file only.
- **Any Nx target, `project.json`, `inject-mobile-env.mjs`, `environment.*.ts`,
  Gradle, Capacitor, CI, or `.gitignore` change.** The set of gitignored files is
  not changed; they are only **copied**.
- **Reading, writing, printing, or committing any secret.** `.env.local` and
  `google-services.json` are **copied as opaque files** between two local
  checkouts on the same machine — their contents are never read, logged, or
  echoed, and they remain gitignored in the worktree (so they are never staged or
  committed). See Risks.
- **Symlinking instead of copying.** A plain `Copy-Item` is used (a copy, not a
  link), so editing one checkout's file does not mutate the other's. No symlink.
- **Generalizing to a configurable file list.** The three paths are hardcoded in
  the skill step; adding/removing seeded files is a future spec, not a knob.
- **The other skills** (`create-spec`, `rework-spec`, `rework-feature`,
  `cleanup-feature`). Only `implement-feature` creates the feature worktree, so
  only its `SKILL.md` is touched.

## Affected slices & Sheriff tags

**No slice and no scope is built** (`slices: []`, `scopes: []`). The only changed
file is `.claude/skills/implement-feature/SKILL.md`, a **skill prompt / markdown
instruction file** — **not** a workspace TS/Nx project, app, or lib.

- **Sheriff / module boundaries do not apply.** Sheriff governs imports between
  Nx/TS projects; a markdown skill file is outside the Nx project graph entirely.
  No TypeScript import (cross-slice or otherwise) is added.
- **No lib is touched**, so no lib `README.md` currency rule (CLAUDE.md) applies.
- **No DRY / 3+-slice question arises** — no shared TS logic is added; this is a
  one-file change to an orchestration prompt.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected). The seeded files include the Firebase **config**
(`google-services.json`) and the **API-key env** files, but these are copied as
opaque local files — no schema, document, or rule is created, read, or changed.

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes. The only change is the natural-language behavior of the
`implement-feature` skill's Step 2.

**Concrete behavior the new substep must implement** (this is the checkable
contract). The substep runs **after** the worktree exists (after the
`git worktree add` / reuse branch in Step 2) and **before** the bootstrap check.
Step 2 already computes `$root` (the primary checkout root) and `$wt` (the
worktree path):

```powershell
$root = (git rev-parse --path-format=absolute --git-common-dir) -replace '\.git$',''
$wt   = [System.IO.Path]::GetFullPath("$root/../Vultus-worktrees/feat-NNNN-slug")
```

The substep reuses **those exact variables** (do not re-derive the paths a
different way) and seeds these three relative paths:

| Relative path (under both `$root` and `$wt`)         | Why it's needed in the worktree                          |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `.env.local`                                         | API keys for `inject-mobile-env.mjs`                     |
| `apps/mobile/src/environments/environment.generated.ts` | prod build `fileReplacements` (specs 0026/0038)       |
| `android/app/google-services.json`                  | Firebase Android config (Gradle/Capacitor, `--check-native`) |

The contract for the copy loop:

- **For each** relative path: if `Join-Path $root <rel>` **exists**, copy it to
  `Join-Path $wt <rel>`, **creating the destination's parent directory first** if
  it does not exist (so `apps/mobile/src/environments/` and `android/app/` are
  created in a brand-new worktree before the copy).
- **If the source does not exist** in `$root`: **skip it silently** (do not copy,
  do not error) and **record a warning string** (e.g.
  `⚠ .env.local not found in primary checkout — app may not build in this worktree`)
  to be surfaced in **Step 9's report**.
- **Never throw / never abort.** A missing source, or a copy error, must **not**
  stop worktree creation or the rest of the skill — worktree setup continues
  regardless. (A failed copy is recorded as a warning, same as a missing source.)
- **PowerShell, with parent-dir creation.** Use PS-safe syntax (the repo shell is
  PowerShell). The canonical shape the implementer should write (a `foreach` over
  the three paths) is below — exact phrasing may vary but the **behavior above is
  the contract**:

  ```powershell
  $seed = @(
    '.env.local',
    'apps/mobile/src/environments/environment.generated.ts',
    'android/app/google-services.json'
  )
  foreach ($rel in $seed) {
    $src = Join-Path $root $rel
    $dst = Join-Path $wt   $rel
    if (Test-Path -LiteralPath $src) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
    } else {
      # record a warning to surface in Step 9's report; do NOT abort
      Write-Warning "Seed source missing: $rel — worktree may not build."
    }
  }
  ```

  `New-Item -ItemType Directory -Force` is the parent-dir-creation requirement
  (it is a no-op when the directory already exists, so reusing an existing
  worktree is safe). `Copy-Item ... -Force` overwrites a stale seeded file on
  worktree reuse so the worktree tracks the primary checkout's current values.

## UI / Stitch screen refs

**Not applicable.** No mobile UI is built or changed; this spec edits an
orchestration prompt file only. There is no screen to fetch from Stitch and no
`--vultus-*` design token added or transcribed.

## Implementation task graph

A single **[sequential]** task — one markdown file is edited, so there is no
parallel fan-out and **no file manifest** is needed. This is a skill/prompt edit
(orchestration tooling), naturally the **infrastructure-engineer**'s territory.

### Task 1 — [sequential] Add the "Seed local-only files" substep to Step 2 of `implement-feature` SKILL.md

Files: `.claude/skills/implement-feature/SKILL.md` (the only changed file).

1. Open `.claude/skills/implement-feature/SKILL.md`.
2. Find **Step 2, "Create the worktree"** — the section that resolves `$root` /
   `$wt`, runs `git worktree prune`, then adds/reuses the worktree and sets
   `status: implementing`. The new substep goes **after** the worktree is
   created/reused (so `$wt` exists on disk) and **before** the
   "**Bootstrap check**" bullet.
3. Add a **"Seed local-only files"** substep that, reusing the already-computed
   `$root` and `$wt`, copies these three repo-root-relative paths from `$root`
   into `$wt`:
   - `.env.local`
   - `apps/mobile/src/environments/environment.generated.ts`
   - `android/app/google-services.json`
4. The substep must, per the **Public types / APIs** contract above:
   - **copy each file only if its source exists** in `$root`;
   - **create the destination's parent directory first** (PowerShell
     `New-Item -ItemType Directory -Force` on `Split-Path -Parent $dst`) so the
     copy works in a brand-new worktree;
   - use **PowerShell** `Copy-Item ... -Force` (PS is the repo shell);
   - on a **missing source** (or a copy error), **skip-and-warn** — record a
     warning string and **never abort** worktree creation;
   - state that the recorded warnings are **surfaced in Step 9's report** (so a
     worktree that can't build is flagged to the user, not silently broken).
5. Add a short note in the substep that the seeded files are **gitignored and
   stay gitignored in the worktree** — they are copied as opaque local files and
   are **never read, logged, staged, or committed** (no secret is exposed).
6. Do **not** modify any other step, any other skill, or any non-skill file.

Gate: this is a markdown prompt edit — there is **no Nx/TS surface**, so
`nx affected` will show no affected project (expected). Verification is by
**inspection** that the substep is present, sits in the right place in Step 2,
names the three exact paths, creates parent dirs, and has the skip-and-warn /
never-abort behavior (see Test plan).

## Test plan

Per the PLAN §5 pyramid, **honest**: this is a skill/prompt (`.claude/skills/**`)
markdown change with **no executable workspace code**, so there is **no automated
test surface**.

- **Unit (Vitest):** **none** — no TS/JS logic is added or changed; the only file
  is a markdown skill prompt. There is nothing to import, spy on, or assert.
- **Component tests:** **none** — no UI / slice component is added or changed.
- **e2e tests:** **No e2e flows required — tooling / prompt-file change only.**
  Per the PLAN §5 e2e rubric this introduces **no user-facing app change, no new
  navigation route, and no new action**; the web build is byte-for-byte
  unchanged. Stated explicitly so the omission is intentional. No existing flow
  is touched or un-skipped.
- **Automated gate (workspace):** `nx affected -t typecheck lint test build
  --base=main` will show **no affected project** (no workspace file changed); that
  is expected and acceptable — a markdown skill file is outside the Nx graph.
- **Verification by inspection (the real gate for a prompt edit):** confirm the
  edited `SKILL.md` Step 2 contains the substep and that it:
  1. sits **after** the worktree is created/reused and **before** the Bootstrap
     check, reusing the existing `$root` / `$wt` variables (not a re-derived
     path);
  2. names the **three exact paths** (`.env.local`,
     `apps/mobile/src/environments/environment.generated.ts`,
     `android/app/google-services.json`);
  3. **creates parent directories** before copying (PS
     `New-Item -ItemType Directory -Force`);
  4. uses PowerShell `Copy-Item`;
  5. **skips and warns on a missing source and never aborts**, with warnings
     **surfaced in Step 9's report**.
- **Optional behavioral smoke (manual, not a CI gate):** in a scratch worktree,
  run the substep's PowerShell against a `$root` that has the files and a
  worktree that doesn't — confirm all three land at the right relative paths and
  that removing one source yields a warning rather than an error. This exercises
  the prompt's logic but is **not** an automated gate (the skill is interpreted by
  the agent, not executed as code).

## Definition of done

Tailored from the PLAN §5 checklist. There is no affected workspace TS project;
the affected artifact is a skill prompt file.

- [ ] `.claude/skills/implement-feature/SKILL.md` Step 2 has a **"Seed
      local-only files"** substep placed **after** the worktree is created/reused
      and **before** the Bootstrap check, reusing the existing `$root` / `$wt`.
- [ ] The substep seeds the **three exact paths** — `.env.local`,
      `apps/mobile/src/environments/environment.generated.ts`,
      `android/app/google-services.json` — from `$root` to the same relative path
      under `$wt`.
- [ ] The copy **creates parent directories** as needed (PS
      `New-Item -ItemType Directory -Force`) and uses PowerShell `Copy-Item`.
- [ ] A **missing source** (or copy error) is **skipped with a warning** and
      **never aborts** worktree creation; the warnings are **surfaced in Step 9's
      report**.
- [ ] The substep notes the seeded files stay **gitignored / never read, logged,
      staged, or committed** (no secret exposed).
- [ ] **No other step, skill, or non-skill file is changed**; no Nx target,
      `.gitignore`, app/lib/function/type/UI/Firestore change.
- [ ] **No e2e flow required** — explicitly recorded (tooling/prompt change; no
      route/action; web build unchanged).
- [ ] `nx affected` shows no affected project (expected); verification is by
      **inspection** per the Test plan.

## Risks

1. **Secret handling.** Two of the three seeded files (`.env.local`,
   `google-services.json`) contain secrets. The copy is a **file-to-file copy
   between two local checkouts on the same machine** — the skill **does not read,
   log, echo, or commit** their contents, and both files stay **gitignored** in
   the worktree (so `git status` / the feature PR never picks them up). This
   honors CLAUDE.md's "never read or write a secret" rule: copying an opaque file
   is not reading its secret value. A reviewer must not "improve" the step by
   printing or templating the file contents.
2. **Stale seeded files on worktree reuse.** When `implement-feature` **reuses**
   an existing worktree, the seed re-runs and `Copy-Item -Force` **overwrites**
   any previously-seeded file, so the worktree tracks the primary checkout's
   current values rather than going stale. (`New-Item -Force` on the parent dir is
   a no-op when it already exists, so reuse is safe.)
3. **`environment.generated.ts` may itself be stale/absent.** It is produced by
   `inject-mobile-env.mjs` from `.env.local` (specs 0026/0038). If the primary
   checkout never generated it, the seed skips it with a warning — and because
   `.env.local` is also seeded, the worktree can regenerate it with
   `pnpm nx run mobile:inject-env`. The skip-and-warn (not abort) behavior makes
   this a soft, reported failure, not a hard stop.
4. **Source files genuinely absent in the primary checkout.** A clone that never
   set up local files will warn for each missing path; the worktree then won't
   build the mobile app, exactly as the primary checkout wouldn't. The warning in
   Step 9's report makes this visible to the user instead of surfacing as a
   confusing build failure later.
5. **No architecture / PLAN conflict.** This adds **no slice, no cross-slice or
   cross-scope import, no shared logic, and no data-model change.** It is a
   one-file edit to an orchestration prompt outside the Nx/TS/Sheriff graph — no
   conflict with PLAN §3 (vertical slice / Sheriff) or §4 (data model). TMDB /
   Trakt data-source accuracy is unrelated.
