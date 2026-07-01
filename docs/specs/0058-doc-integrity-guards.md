---
number: 0058
slug: doc-integrity-guards
title: 'Deterministic documentation integrity: spec-status ledger + CI drift guards'
status: done # draft | approved | implementing | done
slices: [] # foundation / tooling + docs — touches no product slice
scopes: [] # tools/* is intentionally NOT Sheriff-tagged (see §3); no scope tag applies
created: 2026-07-01
---

## 1. Context

The repo's documentation drifts silently from its code. Two concrete symptoms
motivate this spec:

1. **State is expensive to read.** Project status lives across ~57
   `docs/specs/NNNN-*.md` files; learning "what is approved / done / where" today
   means opening dozens of specs by hand. There is no machine-generated index.
2. **Prose contradicts the wired source of truth.** `docs/PLAN.md` §2 says the
   primary color is `#10B981`, but `libs/shared/ui-kit/src/lib/theme.scss` (the
   runtime source of truth, per CLAUDE.md) and `CLAUDE.md` both say primary is
   **`#4edea3`** and that `#10B981` is only `primary-container` /
   `status-completed`. PLAN §2's surface hexes (`#0F172A` / `#1E293B`) likewise
   do not appear in the actual ramp. A reader trusting PLAN §2 ships the wrong
   brand color.

This spec is the **foundation** of a two-spec effort on documentation drift. It
delivers only the **deterministic** (no-LLM) pieces: a generated status ledger
and two CI drift guards, packaged so the existing `nx test` gate runs them
automatically. A **follow-up spec (not this one)** will add a headless-safe
`/audit-docs` skill that reuses these deterministic guards as its floor and adds
the LLM-judgment prose audit (e.g. barrel-export-vs-README reconciliation, prose
quality). The boundary is intentional: nothing in this spec invokes an LLM, and
nothing here specs the skill.

Intended outcome: after this lands, (a) `docs/specs/STATUS.md` is a committed,
always-fresh table of every spec's frontmatter, (b) a PLAN-vs-theme hex mismatch
turns CI red, and (c) a `libs/**/README.md` left as Nx scaffold or missing its
mandated sections turns CI red.

## 2. Scope

In scope:

- **Deliverable 1 — generated spec-status ledger.** A committed
  `docs/specs/STATUS.md` generated from every `docs/specs/NNNN-*.md` spec's
  frontmatter, plus a generator script `tools/scripts/gen-spec-status.mjs` with a
  `--check` (staleness) mode.
- **Deliverable 2 — PLAN-vs-theme hex guard.** A vitest guard that parses a new
  structured key-token table in PLAN §2 and the corresponding CSS custom
  properties in `theme.scss` and asserts each key token's hex matches (theme.scss
  is the source of truth).
- **Deliverable 3 — lib-README guard.** A vitest guard over every
  `libs/**/README.md` that fails on the Nx scaffold sentinel and asserts the
  CLAUDE.md-mandated section structure is present.
- **PLAN §2 fix (required to make deliverable 2 pass).** Reformat _only_ the PLAN
  §2 "Design system" paragraph into a structured `token-name: #hex` table with the
  correct hexes drawn from `theme.scss`. This is the minimum edit needed so the
  new hex guard is green on the same PR.
- **Packaging.** Guards #2 and #3 and the #1 staleness check ship as vitest specs
  in one new Nx test project under `tools/`, picked up by the existing
  `nx affected -t test` CI gate.

Out of scope (explicitly not in this spec):

- The `/audit-docs` skill and any LLM-judgment prose audit (follow-up spec).
- Barrel-export-list-vs-actual-exports reconciliation in READMEs (follow-up
  `/audit-docs`).
- Reconciling PLAN's superseded §5–§6 GitHub-issue workflow sections, or any
  broader PLAN sweep beyond the §2 design paragraph.
- Any full-repo hex scan (the hex guard is deliberately targeted key-tokens only).
- Any scheduled-routine / cron wiring; the guards run only via `nx test` / CI.
- Any change to product slices (`libs/mobile/*`, `libs/functions/*`, `apps/*`).

## 3. Affected slices & Sheriff tags

- **No product slice is touched.** `slices: []`. This is foundation/tooling +
  docs work. It introduces **no cross-slice imports** and no slice code.
- **New Nx project:** `tools/doc-integrity-test` (a vitest test project, mirroring
  `tools/sheriff-test` / `tools/firestore-rules-test`).
- **Sheriff scope:** `tools/**` is **intentionally not tagged** by
  `sheriff.config.ts` — that file's `modules` map covers only `apps/*`,
  `libs/shared/*/src`, `libs/mobile|functions/<slice>/src`, and
  `tools/sheriff-fixtures/*`. Everything under `tools/` therefore resolves to
  Sheriff's `noTag`, whose dep-rule (`noTag: () => true`) permits any dependency.
  So the new tools project needs **no** `sheriff.config.ts` change and crosses no
  boundary. `scopes: []` is correct — there is no fitting scope tag for `tools/`
  tooling, matching `tools/sheriff-test` / `tools/scripts` (their `project.json`
  `tags` are `[]`). The guards read `.md`/`.scss`/`.mjs` files off disk with
  `node:fs`; they import no product code, so no scope boundary is exercised.
- **Files edited outside `tools/`:** `docs/PLAN.md` (§2 paragraph only) and the
  generated `docs/specs/STATUS.md`. Neither is a Sheriff module.

## 4. Data model touchpoints

None. No Firestore collections, fields, converters, or security rules are touched
or added (PLAN §4 unaffected). This is a docs/tooling change only.

## 5. Public types / APIs

No product/runtime types, HTTP endpoints, or callables change. The only new
surface is the generator script's module contract (kept pure-function-first so
the vitest guard can import it without executing the CLI, mirroring
`inject-mobile-env.mjs`):

`tools/scripts/gen-spec-status.mjs` (ESM, Windows/PowerShell-safe) exports:

- `SPEC_GLOB` — the spec-file selector, `docs/specs/NNNN-*.md`
  (`/^\d{4}-.*\.md$/` on basename; `README.md` and `STATUS.md` excluded).
- `parseSpecFrontmatter(markdown: string): { number, slug, title, status,
slices: string[], scopes: string[] }` — pure. Reads the leading `---` YAML
  frontmatter block; tolerates missing optional `slices`/`scopes` (default `[]`).
  Throws a clear error naming the file if `number`/`slug`/`title`/`status` is
  absent. **The scalar parse MUST be robust to the real frontmatter shapes in
  this repo (a naive `split(':')[1].trim()` corrupts the ledger — and because
  `--check` compares a committed render to a fresh render from the SAME parser,
  corruption is byte-identical on both sides and the freshness guard stays GREEN
  while the data is wrong). Specifically the parser MUST:**
  - **(a) Strip trailing `# …` inline comments from scalar values** before
    trimming — e.g. `status: approved # draft | approved | implementing | done`
    parses to exactly `approved`, not `approved # draft | ...`. (This spec's own
    frontmatter, and any spec's, may carry such comments on `status`/`slices`/
    `scopes` lines.) Guard the strip so a `#` inside a quoted string is not
    treated as a comment.
  - **(b) Unquote single- or double-quoted scalars** — e.g. a single-quoted
    `title: 'Deterministic documentation integrity: …'` parses to the bare
    string without the surrounding quotes (other specs' titles are bare; both
    forms must yield the same value). Note the title legitimately contains a
    `:` inside the quotes, so split on the **first** `key:` colon only.
  - **(c) Parse `[a, b]` flow-sequence arrays** for `slices`/`scopes`, where
    values may themselves contain colons (`scope:functions`, `slice:settings`).
    An empty `[]` (with or without a trailing inline comment) parses to `[]`.
    Split the inner list on commas, then trim each element — do **not** split
    array elements on `:`.
- `renderStatusMarkdown(entries): string` — pure. Produces the full STATUS.md
  text: a generated-file banner (a comment noting it is generated by
  `tools/scripts/gen-spec-status.mjs` and must not be hand-edited), a per-status
  count summary, then a table sorted ascending by `number` with columns
  `# | slug | title | status | slices | scopes`. Deterministic (stable sort,
  fixed column order, trailing newline) so `--check` diffs are byte-exact.
- `readAllSpecs(specsDir: string): entries[]` — impure helper: lists + reads the
  spec files and maps them through `parseSpecFrontmatter`.
- CLI behavior, guarded by an `import.meta.url === pathToFileURL(argv[1]).href`
  check (so a vitest import does not run it):
  - default: writes/overwrites `docs/specs/STATUS.md`, prints the path + count.
  - `--check`: regenerates in-memory, compares to the committed
    `docs/specs/STATUS.md`, and on any difference exits non-zero with the hint
    `run \`node tools/scripts/gen-spec-status.mjs\` to update`; exits 0 when fresh.

Signatures are illustrative of the contract; the implementer may adjust names but
must keep (a) a pure parse function, (b) a pure render function, and (c) a
`--check` mode with the exact staleness hint above, because the vitest guard
depends on all three.

## 6. UI / Stitch screen refs

**N/A — not a mobile UI feature.** This spec introduces no page, route, component,
or user-facing action. No Stitch screen applies and none is pulled. The only
design-token contact is _reading_ `theme.scss` values to fix PLAN §2 prose (see
§7 task S4), which uses the committed `theme.scss` as the source of truth — no
hex is hand-transcribed from memory.

## 7. Implementation task graph

Legend: `[sequential]` must complete before dependents; `[parallel]` tasks have
disjoint file manifests and may run concurrently.

**S1 [sequential] — Scaffold the `tools/doc-integrity-test` Nx project.**
Mirror `tools/sheriff-test`: create `project.json` (name `doc-integrity-test`,
`projectType: library`, `tags: []`, a `test` target using `@nx/vitest:test` with
`outputs: ["{workspaceRoot}/coverage/{projectRoot}"]`), `vite.config.mts` (root
`__dirname`, `cacheDir '../../node_modules/.vite/tools/doc-integrity-test'`,
`test.name: 'doc-integrity-test'`, `environment: 'node'`, `include
['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']`, v8 coverage),
`tsconfig.json` + `tsconfig.spec.json` (copy sheriff-test's, retargeting paths).
Add an `inputs` list on the `test` target that includes the guard's read
dependencies so Nx caches/invalidates correctly (see note below). This task
establishes shared config, so it is sequential.

> **Why a new project rather than colocating in `tools/scripts` (finding 4):**
> `tools/scripts` is already an Nx project with a `test` target and the
> repo's colocated-test convention (`inject-mobile-env.test.mjs` sits next to
> `inject-mobile-env.mjs`). We nonetheless put all three guards in a **new**
> `tools/doc-integrity-test` project (mirroring `tools/sheriff-test` /
> `tools/firestore-rules-test`) because: (1) the hex + README guards read PLAN /
> theme / READMEs and belong with the ledger guard as one cohesive "doc
> integrity" gate, not scattered into the env-injection script's project; (2)
> keeping them separate lets this project declare the cross-repo `inputs` (below)
> without widening `tools/scripts`'s cache key for every doc edit; (3) it matches
> the established `tools/*-test` project pattern the reviewer expects. The ledger
> guard **cross-imports** the generator via a raw relative path
> `../../scripts/gen-spec-status.mjs` (an ESM `import` of the `.mjs` — no barrel,
> no path alias; `tools/**` is untagged so Sheriff permits it). The S1 `inputs`
> glob **`{workspaceRoot}/tools/scripts/gen-spec-status.mjs`** covers that raw
> import for cache invalidation, so editing the generator re-runs the guard.
> _Manifest:_ `tools/doc-integrity-test/project.json`,
> `tools/doc-integrity-test/vite.config.mts`,
> `tools/doc-integrity-test/tsconfig.json`,
> `tools/doc-integrity-test/tsconfig.spec.json`.

> **Nx `inputs` note (S1):** unlike a lib whose test only depends on its own
> `src`, these guards read files across the repo, so the `test` target must
> declare those as inputs or Nx will serve a stale cached pass after
> PLAN/README/theme/spec edits. Set:
> `inputs: ["default", "{workspaceRoot}/docs/PLAN.md",
"{workspaceRoot}/docs/specs/**/*.md", "{workspaceRoot}/libs/**/README.md",
"{workspaceRoot}/libs/shared/ui-kit/src/lib/theme.scss",
"{workspaceRoot}/tools/scripts/gen-spec-status.mjs"]`.
> (This matches how `tools/sheriff-test` adds `sheriff.config.ts` +
> `tools/sheriff-fixtures/**` to its `test` inputs.)
> **Note:** this explicit per-target `inputs` array intentionally **replaces**
> nx.json's `@nx/vitest:test` default (`["default", "^production"]`), dropping
> `^production` — matching the `tools/sheriff-test` precedent. That is fine for a
> tools project: it has no product-code dependents whose production build should
> gate its test cache; the cross-repo doc/theme/spec globs above are the real
> invalidation triggers.

**S2 [sequential] — Generator script `gen-spec-status.mjs`.**
Implement per §5 in `tools/scripts/gen-spec-status.mjs`. Style modeled on
`tools/scripts/inject-mobile-env.mjs` (ESM, numbered helpers, synchronous
`node:fs`, `import.meta.url` CLI guard, pure functions exported for test). Depends
on nothing but must land before the ledger guard (S5a) imports it.
_Manifest:_ `tools/scripts/gen-spec-status.mjs`.

**S3 [sequential] — (moved) Generate the committed ledger LAST.**
The ledger generation is deliberately **NOT** done here mid-graph. Because 0058
lands as `approved` in the spec PR and this feature PR's diff itself flips 0058's
status to its landing value (per `docs/specs/README.md` lifecycle), regenerating
STATUS.md before that flip would immediately make the committed ledger stale and
turn S5a's freshness guard RED at the end of its own PR. Ledger regeneration is
therefore the **final** implementation step — see **S7**. (S3 retained as a
placeholder to preserve numbering; no file writes here.)

**S4 [parallel] — Fix PLAN design-system paragraph.**
The target is the **"Design system:" bullet at `docs/PLAN.md` ~lines 100–107**,
under the **`### Design reference (Stitch)`** subsection (there is no heading
literally titled "Design system" — it is the bullet whose text begins
`- **Design system:** "Vultus Design System" …`). Replace that bullet's prose
hexes with a structured `token-name: #hex` table for the key tokens in the §8
mapping, taking every hex from `theme.scss`. Correct `#10B981`→`#4edea3` for
primary, add `primary-container #10B981`, replace `#0F172A`/`#1E293B` with the
real ramp (`background #0b1326`, `surface-container #171f33`, `overlay/highest
#2d3449`), add `on-surface #dae2fd`, and keep the four status colors.
**Casing:** PLAN currently uses uppercase (`#10B981`, `#3B82F6`) while
theme.scss is lowercase (`#10b981`, `#3b82f6`). The **hex compare is
case-insensitive** (both the guard parser in S5b and this edit normalize to
lower-case before comparing), so the exact casing written into the PLAN table is
not load-bearing for the guard — but write the PLAN table in **lower-case** to
match theme.scss and avoid a misleading uppercase/lowercase mismatch on the page.
S4's edit and S5b's parser MUST agree on this case-insensitive-compare rule.
Leave the rest of PLAN untouched. Independent of the tools project.
_Manifest:_ `docs/PLAN.md`.

**S5a [parallel] — Ledger freshness guard.**
`tools/doc-integrity-test/src/spec-status-ledger.spec.ts`: import the generator's
pure/`readAllSpecs` functions, assert the committed `docs/specs/STATUS.md` byte-
equals `renderStatusMarkdown(readAllSpecs(...))`; add a fixture case proving
`--check`-style comparison FAILS when an entry is mutated (see §8). Depends on S2
(import); its **live** byte-equality assertion against the committed STATUS.md is
only valid once **S7** has (re)generated that file as the final step — the spec
file itself may be authored earlier, but the guard passes GREEN only after S7.
It writes only its own spec file, disjoint from S5b/S5c, so the three guard specs
are mutually parallel.
_Manifest:_ `tools/doc-integrity-test/src/spec-status-ledger.spec.ts`.

**S5b [parallel] — PLAN-vs-theme hex guard.**
`tools/doc-integrity-test/src/plan-theme-hex.spec.ts`: parse the PLAN §2 token
table and the mapped `--vultus-*` / `--ion-*` vars from `theme.scss`, assert each
key token matches (§8 mapping); add a case proving a mismatched token fails (§8).
Depends on S4 landing (else red), but writes only its own spec file.
_Manifest:_ `tools/doc-integrity-test/src/plan-theme-hex.spec.ts`.

**S5c [parallel] — Lib-README guard.**
`tools/doc-integrity-test/src/lib-readme.spec.ts`: over every
`libs/**/README.md`, assert (a) the Nx scaffold sentinel is absent and (b) the
mandated structure markers are present (§8). Add fixture cases for
scaffold-present and missing-section. Writes only its own spec file.
_Manifest:_ `tools/doc-integrity-test/src/lib-readme.spec.ts`.

**S6 [sequential] — README for the new tools project (if required) + CI check.**
Confirm no `.github/workflows/ci.yml` change is needed (see §8 CI note) and record
the finding. `tools/` projects carry no `README.md` mandate (the CLAUDE.md README
rule applies to `libs/**`), so none is added. Sequential wrap-up.
_Manifest:_ (verification only; no file writes expected — if the finding is that
ci.yml _does_ need a step, this task edits `.github/workflows/ci.yml`.)

**S7 [sequential] — Generate the committed ledger (FINAL step; finding 3).**
Only after every other task is done **and 0058's own frontmatter `status` is set
to its landing value** (`approved` in the spec PR that already merged;
unchanged/`approved` here unless this feature PR's diff flips it), run
`node tools/scripts/gen-spec-status.mjs` and commit the produced
`docs/specs/STATUS.md`. This must be the last write so the committed ledger
reflects 0058's final status and S5a's freshness guard is GREEN at PR tip.
Thereafter the pre-commit hook (`gen-spec-status.mjs --check`, via lint-staged /
husky) and the CI `nx test` freshness gate enforce that any later spec add/edit
regenerates STATUS.md.
_Manifest:_ `docs/specs/STATUS.md`.

Ordering summary: **S1 → S2**, then **S5a/S5b/S5c in parallel**; **S4** runs any
time (independent leaf, but must land in the same PR so S5b is green); **S6**
verifies CI; then **S7 last** — the ledger is regenerated only after 0058's own
status is at its landing value and all other edits are done, so the committed
STATUS.md is fresh at PR tip and S5a is green. (S3 is now a numbering
placeholder; the ledger it once produced is generated by S7.) S5b/S5c do not
import S2, but scheduling them after S1 gives them the project scaffold to live
in. **S5a's freshness assertion is validated only after S7 commits STATUS.md.**

## 8. Test plan

Per PLAN §5 pyramid this is **unit-level only**. **No component tests** (no UI).
**No e2e flows required — this is a docs/tooling change only** (no route, no
user-facing action; the e2e rubric's "not required" branch applies). The guards
_are_ the tests.

**Ledger freshness (`spec-status-ledger.spec.ts`) — unit.**

- `parseSpecFrontmatter` extracts number/slug/title/status and defaults
  slices/scopes to `[]` when absent; throws a file-named error on a missing
  required key (feed an in-string fixture).
- **Inline-comment stripping (finding 1a):** a fixture with
  `status: approved # draft | approved | implementing | done` parses to `status`
  === exactly `'approved'` (not `'approved # draft | approved | implementing |
done'`), and `slices: [] # foundation / tooling` parses to `slices` === `[]`.
- **Quote stripping (finding 1b):** a fixture with a single-quoted
  `title: 'Deterministic documentation integrity: spec-status ledger + CI drift
guards'` parses to `title` with NO surrounding quotes and the inner `:`
  preserved; a bare (unquoted) title fixture yields the identical string.
- **Flow-sequence arrays (finding 1c):** `scopes: [scope:functions,
scope:shared]` parses to `['scope:functions', 'scope:shared']` (each element
  intact, not split on its `:`); `slices: []` parses to `[]`.
- `renderStatusMarkdown` is deterministic: sorted by number, stable columns,
  per-status counts correct for a small fixture set.
- **Freshness:** the committed `docs/specs/STATUS.md` byte-equals a fresh render
  of the real `docs/specs/*.md`. **Staleness proof:** take the committed content,
  render from a fixture entry list with one mutated field (e.g. a flipped
  status), and assert the two differ (i.e. the comparison the guard/`--check`
  performs would fail) — proving a forgotten regenerate goes red.

**PLAN-vs-theme hex guard (`plan-theme-hex.spec.ts`) — unit.**

- Parse the PLAN §2 table into `{ token: hex }`; parse the mapped vars from
  `theme.scss` into `{ token: hex }`; assert equality per the mapping below
  (case-insensitive hex compare, normalized to lower-case).
- **Mismatch proof:** feed a copy of the PLAN table string with `primary` set to
  `#10B981` and assert the comparison fails for `primary` — reproducing today's
  real bug and proving the guard would have caught it.
- Guard against silent no-op: assert every token in the mapping is actually found
  in _both_ sources (a missing token fails, so renaming a var can't hide a drift).

**Key token → var mapping (the guard's contract; theme.scss is source of truth):**

| Token (PLAN §2 table)  | theme.scss var                       | Expected hex |
| ---------------------- | ------------------------------------ | ------------ |
| `primary`              | `--vultus-primary`                   | `#4edea3`    |
| `primary-container`    | `--vultus-primary-container`         | `#10b981`    |
| `background` (surface) | `--vultus-surface`                   | `#0b1326`    |
| `surface-container`    | `--vultus-surface-container`         | `#171f33`    |
| `surface-highest`      | `--vultus-surface-container-highest` | `#2d3449`    |
| `on-surface`           | `--vultus-on-surface`                | `#dae2fd`    |
| `status-watching`      | `--vultus-status-watching`           | `#3b82f6`    |
| `status-completed`     | `--vultus-status-completed`          | `#10b981`    |
| `status-dropped`       | `--vultus-status-dropped`            | `#ef4444`    |
| `status-planned`       | `--vultus-status-planned`            | `#94a3b8`    |

(The "deep-navy surface ramp background→cards→overlays" is represented by
`background` / `surface-container` / `surface-highest`. `--ion-color-primary`
equals `--vultus-primary`; the guard keys on the `--vultus-*` var to avoid
duplicate assertions.)

**Lib-README guard (`lib-readme.spec.ts`) — unit.**

- **Scaffold sentinel:** fail if a `libs/**/README.md` contains the Nx
  library-generator scaffold text. The `@nx/js`/`@nx/angular` library generator
  emits a `README.md` whose body is a single line of the form
  `This library was generated with [Nx](https://nx.dev).` The guard matches the
  case-insensitive pattern `/generated with \[?Nx\]?/i` (also catches the shorter
  `# <name>\n\nThis library was generated with Nx.` variant). The implementer must
  confirm the exact sentinel by generating a throwaway lib (or inspecting
  `node_modules/@nx/*` generator templates / `files/README.md`) and pin the
  matched string in a code comment; if the observed sentinel differs, widen the
  regex to cover both the observed and the documented forms.
- **Structure markers — EMPIRICALLY RE-DERIVED from all 12 current READMEs so
  the live guard passes on every one with ZERO README edits (finding 2).** A
  heading survey of the real files rules out an over-strict set: 5 READMEs
  (`libs/mobile/{search,settings,notifications,onboarding}` and
  `libs/functions/dispatch-notifications`) have **no `/usage/i` heading**, and
  `dispatch-notifications` uses "Barrel exports" (not
  "public surface/api/components/data access") for its public surface. A guard
  that mandated a `usage` heading or the narrow public-surface vocabulary would
  false-positive on those compliant, product-slice READMEs and force undisclosed
  edits — exactly the churn this guard must prevent. The **final marker set** is
  therefore the title + public-surface/barrel + Sheriff-boundary **trio**, all
  case-insensitive heading-presence checks:
  - a top-level `# ` title heading (line 1) — "what the lib is" intro follows it
    (all 12 have this);
  - a public-surface heading matching **`/barrel|public/i`** — widened to accept
    "Barrel exports" (covers `dispatch-notifications` + `title-detail`) alongside
    "Public surface" / "Public API" (all 12 have one of these);
  - a boundary heading matching **`/sheriff|boundar/i`** — matches "Sheriff
    scope", "Sheriff boundaries", "Boundaries (Sheriff)", "Boundaries" (all 12
    have one of these).

  The **`/usage/i` marker is dropped** (not all 12 have it; requiring it would
  fail 5 compliant READMEs). Keep it heading-presence only — no prose-quality
  judgment (that is the follow-up `/audit-docs` skill's job).

- **Live-guard assertion:** run the predicate over the **real**
  `libs/**/README.md` set (all 12) and assert every one passes **with zero
  edits**. Re-derivation confirms no current README must change; therefore **no
  README appears in any task manifest** (S5c writes only its own spec file).
- **Fixture cases** (against the guard's pure predicate, not the live files, so
  negatives are provable without planting a bad file): (a) an in-string README
  containing the scaffold sentinel → fails; (b) an in-string README missing the
  Sheriff/boundary heading → fails; (c) an in-string README missing the
  public-surface/barrel heading → fails; (d) a well-formed README using ONLY
  "Barrel exports" for its public surface (mirroring
  `libs/functions/dispatch-notifications`) → passes, proving the widened
  `/barrel|public/i` marker.

**CI note (verify in S6):** `tools/sheriff-test` has no bespoke CI step — the
`nx affected -t ... test ...` gate (ci.yml **line 87**, the `pull_request` path;
and the `run-many --all` gate at **line 91**, the `push`-to-main path) discovers
it as an Nx project and runs its `test` target. A new `tools/doc-integrity-test` project with
a `test` target is picked up the same way, on both the PR `affected` path and the
`push`-to-main `run-many --all` path. **Expected finding: no ci.yml change
needed.** The `inputs` from S1 make the guards part of the affected graph when
PLAN/READMEs/theme/specs change, so a doc edit alone still triggers the guard.
State this explicitly in S6; only add a CI step if the affected wiring is proven
insufficient.

## 9. Definition of done

Tailored PLAN §5 checklist:

- [ ] Typecheck passes (`nx affected -t typecheck`).
- [ ] Lint passes including Sheriff module boundaries (the new `tools/` project
      resolves to `noTag` and crosses no boundary; confirm `nx lint` is green).
- [ ] Unit tests pass — the three new guard specs (`spec-status-ledger`,
      `plan-theme-hex`, `lib-readme`) all pass under `nx test doc-integrity-test`,
      including the staleness / mismatch / scaffold / missing-section negative
      cases.
- [ ] The new guards pass against the **real** repo state — i.e. PLAN §2 has been
      fixed to match `theme.scss`, and all 12 existing `libs/**/README.md` already
      satisfy the structure/scaffold checks with **zero README edits** (the marker
      set was re-derived from those 12 for exactly this reason — see §8). No
      product-slice README is edited in this PR; if the guard fails on any README,
      the fix is to correct the guard's marker set, not to edit the README.
- [ ] `docs/specs/STATUS.md` is committed and **fresh** — regenerated as the
      **final** step (S7, after 0058's own status is at its landing value) so
      `node tools/scripts/gen-spec-status.mjs --check` exits 0 at PR tip;
      equivalently S5a's ledger guard is green. The pre-commit hook + CI `nx test`
      gate keep it fresh thereafter.
- [ ] Component tests: **N/A** (no UI).
- [ ] e2e: **N/A** (docs/tooling change; no route or user action).
- [ ] Build passes for all affected projects.
- [ ] No `libs/**` lib API changed, so no lib README update is otherwise due; the
      new `tools/doc-integrity-test` project carries no README mandate.
- [ ] PR description filled out per template.

## 10. Risks

- **PLAN formatting is now coupled to the hex guard.** Reformatting §2 into a
  parseable `token: #hex` table means a future free-form edit of that table can
  break the guard's parser. Accepted (decided): the guard reads a _structured_
  table, not prose, precisely to avoid brittle prose-parsing; the parser should
  fail loudly (missing-token assertion) rather than silently skip, so drift is
  visible, not hidden.
- **Nx caching can mask drift.** Because the guards read files outside their own
  project, the `test` target MUST declare those files as `inputs` (S1 note) or Nx
  will replay a stale cached pass after a PLAN/README/theme/spec edit. This is the
  single most likely way the guard "passes" while actually stale — call it out in
  review.
- **Sheriff boundaries for a new tools project.** `tools/**` is untagged
  (`noTag`), so no boundary is crossed and no `sheriff.config.ts` edit is needed —
  but the implementer must NOT add the project to `sheriff.config.ts` `modules`
  (doing so would start enforcing a scope it has no business having). Verified
  against the current config in §3.
- **Nx scaffold sentinel exact string.** The guard's scaffold-detection depends
  on the exact text the Nx generator emits, which can vary by generator/version.
  Mitigated by pinning the observed string in S5c after generating a throwaway lib
  and by matching a lenient `/generated with \[?Nx\]?/i` pattern that covers the
  known variants.
- **Windows-shell safety.** `gen-spec-status.mjs` must be PowerShell/Windows-safe:
  use `node:path` join (no hard-coded `/`), `node:url` `pathToFileURL` for the CLI
  guard (a bare `argv[1]` string compare fails on Windows paths), and write
  STATUS.md with `\n` newlines (the render function fixes newline style so
  `--check` is byte-exact regardless of the checkout's autocrlf).
