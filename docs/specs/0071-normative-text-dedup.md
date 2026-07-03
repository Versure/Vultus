---
number: 0071
slug: normative-text-dedup
title: De-duplicate copy-pasted normative rules (Stitch recipe, worktree snippet, design hexes, Windows E-notes)
status: done # draft | approved | implementing | done
slices: []
scopes: []
created: 2026-07-02
---

# De-duplicate copy-pasted normative rules

## Context

The audit found four normative rule clusters copy-pasted across many artifacts, with
divergence already visible in one. Hand-synced duplication is a drift setup: a fix to one
copy misses the others, and the copies already differ in completeness. This is the classic
maintainability failure the setup otherwise guards against.

1. **Stitch screen-fetch recipe ×3 (plus 3 distinct verify contracts — do NOT collapse
   those)** — the actual fetch procedure (`get_screen` → `htmlCode.downloadUrl` → raw GET,
   not WebFetch → retry → blocked/needs-human) appears in only **three** files:
   `CLAUDE.md:32-47`, `frontend-engineer.md:48-66`, and `spec-author.md:81-103` (markers
   at :86-88). Only frontend-engineer has the full numbered version — those three already
   diverge in completeness. The other three files often lumped in DO NOT contain the
   fetch recipe and must be left alone: `spec-reviewer.md:56-64` is a **review contract**
   ("does the spec reference a real screen ID / is it a checkable UI-fidelity contract"),
   `qa-runner.md:38-49` is a **visual-verify contract** (render / serve-mock / compare),
   and `implement-feature/SKILL.md:306-315` is an **orchestrator-verify note** (confirm the
   implementer fetched a screen). Reducing those to a recipe pointer would delete
   role-specific content and change meaning — the exact hazard Risk 1 warns against.
2. **Worktree path-resolution snippet ×5** — the `git rev-parse --git-common-dir` /
   `GetFullPath` PowerShell snippet appears in `create-spec:70-73`, `rework-spec:24-27`,
   `implement-feature:94-97`, `rework-feature:28-31`, `cleanup-feature:37-40`. Four use
   `-replace '\.git$',''`; **cleanup-feature uses `-replace '\.git[\\/]?$',''`** — a silent
   divergence proving the copies drift independently, while implement-feature warns
   "do not re-derive the paths a different way".
3. **Design-system hexes reprinted unguarded** — `CLAUDE.md:25-27` and
   `frontend-engineer.md:78-88` hand-reprint `#4edea3`/`#10B981`/`#0b1326` etc.
   _immediately after_ commanding "never hand-transcribe a hex from memory or prose". The
   deterministic guard (`tools/doc-integrity-test/src/plan-theme-hex.spec.ts`) only checks
   PLAN §2 vs `theme.scss` — these copies are unguarded, so a theme change re-creates the
   exact stale-palette bug the guard was built for, inside the instructions agents read first.
4. **Windows E-notes ×4-6** — E1 (`pnpm exec cap` + build-web-first), E2 (prettier
   `--write` changed files), and the cold-hook-timeout rule are each restated in 4-6 files
   (`CLAUDE.md`, the implementer agents, `qa-runner.md`, `implement-feature/SKILL.md`).
   Currently consistent, but each has 4-6 hand-synced homes.

**Intended outcome.** Establish one canonical home per rule and reduce the other copies to
a pointer plus only their role-specific delta — and extend the hex guard (or trim the hex
copies) so the "never hand-transcribe" rule is actually enforceable.

## Scope

In scope (consolidation, not content change — the rules' meaning stays identical):

- **Cluster 1 (Stitch recipe — 3 recipe copies only):** make **one** copy canonical
  (natural home: CLAUDE.md's "UI fidelity is a contract" block, or a `docs/design/` recipe
  section); reduce the other **two recipe-bearing** copies (`frontend-engineer.md`,
  `spec-author.md`) to a one-line pointer + role-specific delta (spec-author: what to pin;
  frontend-engineer: the fetch step). **Leave `spec-reviewer.md:56-64`, `qa-runner.md:38-49`,
  and `implement-feature/SKILL.md:306-315` untouched** — they carry the distinct
  review/visual-verify/orchestrator-verify contracts described in Context §1, not the recipe.
- **Cluster 2 (worktree snippet):** pick one regex (the hardened `'\.git[\\/]?$'` from
  `cleanup-feature:38` is the intentional one), align all five copies, and extract the
  resolution into a committed `tools/scripts/resolve-worktree.ps1` (or `.mjs`) the skills
  call. The snippet sets **two** variables the skills consume (`$root` for seeding, `$wt`
  for `git -C $wt`), so the script's **output contract must emit both** (e.g. two lines the
  caller captures) — a script returning only `$wt` breaks the seed step
  (implement-feature/SKILL.md:110-124). Update implement-feature's "do not re-derive the
  paths a different way" note (SKILL.md:122-123) to name the script as the single deriver.
- **Cluster 3 (hexes):** **Prefer trimming** the unguarded copies in `CLAUDE.md:25-27` +
  `frontend-engineer.md:77-88` to token **names** + the one anti-confusion note (primary is
  emerald `#4edea3`; `#10B981` is `primary-container`), pointing at
  `docs/design/vultus-design-system.md` / `theme.scss`. Note that "extend
  `plan-theme-hex.spec.ts` to cover these files" is **not** a path-list tweak: the guard's
  `parsePlanTokenTable` matches only markdown **table rows** (`| token | \`#hex\` |`, the
PLAN §2 shape), whereas CLAUDE.md/frontend-engineer embed hexes in **prose** — so guarding
them requires authoring a **new prose-hex extractor** keyed to token names. Extend the
guard only for any hex that must remain (e.g. the deliberate primary/`#10B981` note);
  trimming is the lower-risk default.
- **Cluster 4 (E-notes):** declare CLAUDE.md the canonical home (it already labels them
  E1/E2/E3) and cut the agent/skill copies to "apply CLAUDE.md E1/E2" one-liners, keeping
  only genuinely role-specific additions (e.g. implement-feature's lint-staged stash
  recovery, spec 0063 group C).

Out of scope:

- Changing what any rule _says_ (this is dedup, not a behavior change). Where spec 0067
  corrects a rule's content or 0065 adds the worktree-install note, land those first; this
  spec consolidates the corrected text.
- Removing role-specific deltas that genuinely differ per agent.

## Sequencing note

This spec has a **hard dependency**: it MUST land after 0065 (worktree install) and 0067
(content corrections) are merged, because 0067 edits the very standing-instruction content
this spec canonicalizes and 0065 touches the worktree-bootstrap section adjacent to
Cluster 2. An implementer must not canonicalize text that 0067 is about to change. If for
any reason it runs earlier, treat it as blocked pending 0065/0067 merge and re-verify every
canonical copy against their edits before proceeding.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). Prompt/standing-instruction markdown, one
`docs/design` section, one `tools/scripts` helper, and the `doc-integrity-test` guard —
all outside the Nx/TS/Sheriff graph (`tools/*` not Sheriff-tagged, spec 0058).

## Data model touchpoints

**None.**

## Public types / APIs

No types. Concrete required behavior:

- One canonical Stitch recipe; **two** recipe-bearing copies (frontend-engineer, spec-author)
  reduced to pointers + role delta; the three verify contracts (spec-reviewer, qa-runner,
  implement-feature) preserved unchanged; no copy contradicts the canonical one.
- One worktree-path formula in a committed script; five call sites use it; a single regex
  everywhere (divergence removed).
- Hex values appear in at most the guarded locations (`theme.scss`, PLAN §2, and any file
  `plan-theme-hex.spec.ts` is extended to cover); CLAUDE.md/frontend-engineer use token
  names + the one primary-vs-primary-container note.
- E1/E2/cold-hook rules stated once (CLAUDE.md) with one-line pointers elsewhere + preserved
  role-specific deltas.

## UI / Stitch screen refs

**Not applicable** — this edits the _description_ of the Stitch fetch recipe, not any screen.

## Implementation task graph

Because three clusters touch the same shared files (CLAUDE.md by clusters 1/3/4;
frontend-engineer.md by 1/3/4; implement-feature/SKILL.md by 2/4), tasks are grouped
**by file** — each file is one task applying all its cluster edits — so no two tasks
race a file (the same rule spec 0063 used to fold all of implement-feature's groups into
one task). Route to **infrastructure-engineer** (prompt/docs) + **feature-implementer**
(the `resolve-worktree` helper + any guard test). Manifests are pairwise disjoint by file.

- **T1** — `CLAUDE.md`: canonicalize the Stitch recipe (cluster 1), trim hexes to names +
  the anti-confusion note (cluster 3), and make it the canonical E1/E2/cold-hook home
  (cluster 4). Largest; do first.
- **T2** — `frontend-engineer.md`: recipe → pointer (1), trim hexes (3), E-note one-liner (4).
- **T3** — `spec-author.md`: recipe → pointer (1).
- **T4** — `implement-feature/SKILL.md`: worktree snippet → `resolve-worktree` call and
  update the "do not re-derive" note (2), E-note one-liner (4). **Leave the cluster-1 verify
  note at :306-315 untouched.**
- **T5** — cluster 2 remaining sites + the helper: add `tools/scripts/resolve-worktree.ps1`
  and update `create-spec`, `rework-spec`, `rework-feature`, `cleanup-feature` to call it.
- **T6** — cluster 4 remaining agents: `backend-engineer.md`, `infrastructure-engineer.md`,
  `qa-runner.md` E-note one-liners. **Leave qa-runner's cluster-1 verify contract untouched.**
- **T7** (only if any hex is retained rather than fully trimmed) — author the prose-hex
  extractor + cases in `plan-theme-hex.spec.ts`.

T4 and T5 both belong to cluster 2 and must agree on the `resolve-worktree` output contract,
so land T5 (the helper) first or in the same pass; the rest are independent.

## Test plan

- **Unit (Vitest):** if `plan-theme-hex.spec.ts` is extended, add cases asserting the newly
  covered files' hex references match `theme.scss` (and fail on a mismatch). If a
  `resolve-worktree` helper is added, a tiny test that it returns the expected worktree path
  shape.
- **Automated gate:** `nx affected -t test` covers `doc-integrity-test`.
- **Inspection:** each cluster has one canonical source + pointers; the worktree regex is
  identical across all five sites (or replaced by the shared script); no hex remains in an
  unguarded file.

## Definition of done

- [ ] Stitch recipe canonical in one place; the **two** recipe-bearing copies
      (frontend-engineer, spec-author) reduced to pointers + deltas; the three verify
      contracts (spec-reviewer, qa-runner, implement-feature :306-315) left unchanged; none
      contradicts the canonical version.
- [ ] Worktree path formula lives in one committed helper; all five sites use it; single
      regex everywhere.
- [ ] Hexes only in guarded locations; CLAUDE.md/frontend-engineer use token names + the
      primary/primary-container note; `plan-theme-hex.spec.ts` extended for any remaining
      references.
- [ ] E1/E2/cold-hook rules canonical in CLAUDE.md; copies are one-line pointers + preserved
      role deltas.
- [ ] `nx affected -t test` green; no rule's meaning changed; no product-code change.

## Risks

1. **Dedup must not change meaning.** Each pointer must faithfully reference the canonical
   rule; a reviewer diffs the canonical text against every removed copy to confirm nothing
   was lost (especially role-specific deltas).
2. **Sequence after 0065/0067** (see note) or re-verify canonical copies against their edits.
3. **Guard vs trim tradeoff (cluster 3):** trimming removes the drift source and is
   preferred; only extend the guard for hex references that must remain (e.g. the deliberate
   primary/primary-container example).
4. **No architecture/PLAN conflict** — consolidation of prompt/docs text + one helper +
   one guard extension; no slice, import, or data model touched.
