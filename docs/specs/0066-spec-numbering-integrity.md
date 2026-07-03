---
number: 0066
slug: spec-numbering-integrity
title: Fix spec-number allocation (branch-based scan), repair the landed 0043/0046 collision, and guard against recurrence
status: implementing # draft | approved | implementing | done
slices: [] # tooling + docs; tools/* is intentionally not Sheriff-tagged (spec 0058)
scopes: []
created: 2026-07-02
---

# Spec-numbering integrity

## Context

`/create-spec` allocates the next spec number with a **label-based** scan —
`gh pr list --label spec --json headRefName` (`.claude/skills/create-spec/SKILL.md:18-21`)
— but the same skill applies the `spec` label **best-effort and silent-on-failure**
(`SKILL.md:97-98`: `gh label create ... 2>$null`, `gh pr edit ... --add-label spec 2>$null`).
So an open spec PR that never got labeled is **invisible** to the scan, and the next
`/create-spec` run reuses its number. `docs/specs/README.md:37-39` declares the
intended rule differently: "**Spec numbering** scans `main` + open `spec/*` PRs for
the next `NNNN`" — branch-shaped, which the implemented command does not do.

**The failure already landed.** `docs/specs/0046-watchlist-sort-filter.md:2` carries
`number: 0043`, duplicating the real spec 0043
(`0043-fix-media-type-hint-navigation.md`). The generated ledger propagates it
silently: `docs/specs/STATUS.md:62-63` renders **two rows numbered "43"** and **no
row 46**. Maintainer memory (`spec-number-collision-unlabeled-prs`) documents this
exact gap and its fix ("enumerate branch names + all PRs instead"), but the skill was
never updated.

The generator has **no guard**: `tools/scripts/gen-spec-status.mjs:145-154` checks
only that `number`/`slug`/`title`/`status` are _present_, coerces `number` to a
Number, and sorts by it — it performs **no filename↔number cross-check and no
uniqueness check** — so the duplicate renders and the `spec-status-ledger` doc-integrity
guard passes.

**Intended outcome.** (1) Make allocation branch-based so it can't miss an unlabeled
PR; (2) repair the landed collision; (3) add a deterministic guard so a duplicate or
filename↔frontmatter mismatch fails CI instead of rendering silently.

## Scope

In scope:

- **`.claude/skills/create-spec/SKILL.md`** — replace the label-based next-number
  scan with a branch+disk+ledger enumeration; keep the `spec` label purely cosmetic.
- **`.claude/skills/rework-spec/SKILL.md`** — same label dependency exists for PR
  discovery (`SKILL.md:22`); lower stakes (it asks the user) but align the note.
- **`docs/specs/0046-watchlist-sort-filter.md`** — correct frontmatter `number: 0043`
  → `number: 0046`.
- **`docs/specs/STATUS.md`** — regenerate via `tools/scripts/gen-spec-status.mjs` after the
  frontmatter fix. The load-bearing corrections are the collapse of the duplicate row 43 and
  the new row 46; the regeneration will **also** add rows for any specs present at
  implementation time (e.g. 0065–0071) that post-date the last ledger render — that is normal
  ledger catch-up on a feature branch, not scope creep.
- **`tools/scripts/gen-spec-status.mjs`** (and/or
  `tools/doc-integrity-test/src/spec-status-ledger.spec.ts`) — add two assertions:
  frontmatter `number` must equal the filename `NNNN`, and numbers must be unique
  across `docs/specs/`.
- **`docs/specs/README.md`** — confirm/adjust the wording so the declared rule and
  the implementation agree.

Out of scope:

- Renumbering any other spec or renaming files (only 0046's frontmatter is wrong).
- Changing the ledger's column format or sort order.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). `tools/*` is intentionally not Sheriff-tagged
(spec 0058 §3); the skills and docs are outside the Nx/TS graph. `gen-spec-status.mjs`
is a Node script with an existing Vitest guard (`tools/doc-integrity-test`), which is
where the new assertions are tested.

## Data model touchpoints

**None.** `STATUS.md` is a generated docs artifact, not Firestore.

## Public types / APIs

No domain types or function signatures. Concrete required behavior:

### create-spec next-number allocation

Replace the label scan with an enumeration that unions three sources and takes
`max + 1`:

1. `docs/specs/*.md` filenames on `main` (the `NNNN` prefix);
2. every open PR head branch matching `spec/NNNN-*` **or** `feat/NNNN-*`
   (`gh pr list --state open --json headRefName` — **no `--label` filter**);
3. local + remote branches matching the same patterns (`git branch -a`).

State that the label is cosmetic only and must never gate the scan.

### gen-spec-status guards (fail-loud)

- **Filename↔number (numeric compare):** for each `docs/specs/NNNN-slug.md`, assert
  `Number(frontmatter.number) === Number(filenamePrefix)`. The comparison MUST be
  numeric on **both** sides — `docs/specs/0042-notifications-inbox.md` legitimately
  carries `number: 42` (unpadded), and a padded-string compare
  (`String(number).padStart(4,'0') === "0042"`, or raw `"42" === "0042"`) would
  spuriously fail it. This is a per-file check and naturally lives in / beside
  `parseSpecFrontmatter`, which already carries a filename `label` for error messages
  (`gen-spec-status.mjs:118-123`).
- **Uniqueness (cross-file):** assert no two specs share a `Number(number)`. Uniqueness
  cannot live in the per-file `parseSpecFrontmatter`; put it in `readAllSpecs`
  (`gen-spec-status.mjs:248-256`, which sees the whole dir) or a new exported
  `assertSpecIntegrity(entries)` helper called by both the write/check paths and the
  test — keeping the pure/exported-for-test shape the module already follows.

These must be exercised by `tools/doc-integrity-test/src/spec-status-ledger.spec.ts`
so the guard is a CI gate (the `doc-integrity-test` suite runs under `nx test`). The
"duplicate numbers throw" fixture must call the **cross-file** entry point
(`readAllSpecs` over a temp dir, or `assertSpecIntegrity`), not `parseSpecFrontmatter`
on a single string. Note this new **integrity** assertion (duplicate-number throw) is
distinct from the suite's pre-existing **freshness** byte-equality test
(`spec-status-ledger.spec.ts:246-250`); do not weaken the freshness test.

## UI / Stitch screen refs

**Not applicable.**

## Implementation task graph

Route to **infrastructure-engineer** / **feature-implementer** (tooling + docs).

- **T1 [sequential]** — `gen-spec-status.mjs` + `spec-status-ledger.spec.ts`: add the
  filename↔number and uniqueness assertions with test coverage. (Do this first so
  the guard exists before the data fix, proving it catches the current collision.)
- **T2 [sequential after T1]** — fix `0046-watchlist-sort-filter.md` frontmatter to
  `number: 0046`, then regenerate `STATUS.md` (`node tools/scripts/gen-spec-status.mjs`)
  and stage the regenerated ledger. (T1's new guard must go green on this fix.)
- **T3 [parallel]** — Manifest: `.claude/skills/create-spec/SKILL.md`. Branch-based
  next-number scan.
- **T4 [parallel]** — Manifest: `.claude/skills/rework-spec/SKILL.md`, `docs/specs/README.md`.
  Align the wording (a comment/wording alignment noting label-filtered discovery can miss an
  unlabeled PR — **not** a behavioral rewrite; rework-spec already asks the user which PR).

## Test plan

- **Unit (Vitest):** `tools/doc-integrity-test/src/spec-status-ledger.spec.ts` gains
  cases: (a) a fixture with a filename↔number mismatch throws; (b) a fixture with
  duplicate numbers throws; (c) the real `docs/specs/` tree passes **after** the 0046
  fix. Before the fix, (c) demonstrates the guard catching the live collision.
- **Automated gate:** `nx affected -t test --base=main` covers `doc-integrity-test`;
  `node tools/scripts/gen-spec-status.mjs --check` passes after regenerating.
- **Inspection:** `create-spec/SKILL.md` no longer filters by `--label`; STATUS.md has
  a single row 43 and a row 46.

## Definition of done

- [ ] `gen-spec-status.mjs` asserts filename↔number equality and number uniqueness,
      with Vitest coverage in `doc-integrity-test`.
- [ ] `0046-watchlist-sort-filter.md` frontmatter is `number: 0046`; `STATUS.md`
      regenerated (single 43, new 46); `gen-spec-status.mjs --check` green.
- [ ] `create-spec/SKILL.md` allocates numbers via branch+disk+ledger enumeration
      with no label dependency; `README.md`/`rework-spec` wording aligned.
- [ ] `nx affected -t test` green; no product-code change.

## Risks

1. **Guard order.** Land the guard (T1) before the data fix (T2) so it demonstrably
   catches the current collision, then goes green — proving the assertion, not just
   asserting the fixed state.
2. **Other latent mismatches.** The uniqueness/filename guard may surface additional
   pre-existing mismatches beyond 0046; if so, fix each frontmatter in T2 (do not
   loosen the guard). Only 0046 is known today.
3. **No architecture/PLAN conflict.** Tooling + docs only; no slice, import, or data
   model touched.
