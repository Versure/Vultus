---
number: 0059
slug: audit-docs-skill
title: '/audit-docs skill: LLM-judgment documentation drift audit'
status: done # draft | approved | implementing | done
slices: [] # tooling + docs — touches no product slice
scopes: [] # delivers a .claude/skills/ skill + docs; no Sheriff scope tag applies (see §3)
created: 2026-07-01
---

## 1. Context

Vultus documentation drifts silently from its code. Spec **0058
(doc-integrity-guards)** delivered the **deterministic floor**: a generated
`docs/specs/STATUS.md` ledger, a PLAN-vs-`theme.scss` hex guard, and a
`libs/**/README.md` structure guard, all wired into the `nx test` / CI gate. By
design 0058 stopped there — it invokes no LLM and specs no skill.

This spec is the **follow-up 0058 named**: a user-invocable, headless-safe
`/audit-docs` skill that **runs 0058's deterministic guards as its floor** and
then adds a **judgment layer** on top — the drift a fixed guard cannot express,
which needs an LLM to read prose against the codebase. It does **not**
re-implement 0058's guards; it shells them and adds two judgment checks.

The user need: a periodic (and on-demand) sanity pass that catches
documentation which has fallen out of step with reality — a README naming a file
that was deleted, a PLAN section describing a workflow that was replaced — and
surfaces it as a categorized report a human (or a follow-up spec) acts on. The
canonical live example the skill must catch is already in the repo:
`docs/PLAN.md` §5–§6 still describe the GitHub-issue task workflow, while
`docs/specs/README.md` (and PLAN's own 2026-06-16 "Superseded note") state that
workflow is **replaced** by the spec-file workflow. That contradiction is a true
positive the dry-run in §8 must reproduce.

**IMPLEMENTATION DEPENDENCY (hard).** 0058 is **spec-merged but NOT yet
implemented** — its artifacts do **not exist on disk** at authoring time:

- `tools/doc-integrity-test/` (the three vitest guards, run via
  `pnpm nx test doc-integrity-test`),
- `tools/scripts/gen-spec-status.mjs` (the ledger generator, with `--check`),
- `docs/specs/STATUS.md` (the committed ledger).

This skill **shells** those artifacts as its deterministic floor. Therefore
**0059 cannot be implemented until 0058 is implemented and merged.** The skill
must fail loudly with a clear "spec 0058 must be implemented first" message if
they are absent (see §5), never silently skip its floor. This dependency is
restated in §10 Risks.

Intended outcome: after this lands, running `/audit-docs` (a) re-runs 0058's
deterministic guards and reports failures at the highest severity, (b) reports
stale references and PLAN-narrative contradictions as categorized findings, and
(c) in a headless/scheduled run opens a draft PR carrying the report **only when
drift is found** — never editing any doc itself.

## 2. Scope

In scope:

- **A new skill** at `.claude/skills/audit-docs/SKILL.md`, user-invocable as
  `/audit-docs`, **model-invocable** (so a scheduled routine may fire it), and
  **headless-safe** (survives a fresh headless clone: git + file reads only).
- **A supporting checklist/reference doc** under the skill dir
  (`.claude/skills/audit-docs/CHECKLIST.md`) that pins the exact per-drift-class
  audit procedure the skill follows, the report format, and the mode-detection
  rule — so the prose skill is a repeatable contract, not improvisation.
- **Deterministic floor (reuse 0058, do not reimplement).** As its **first**
  step the skill runs `pnpm nx test doc-integrity-test` and
  `node tools/scripts/gen-spec-status.mjs --check`, and surfaces any failure as
  the **highest-severity** findings before any judgment work.
- **Judgment layer — exactly two drift classes in v1:**
  1. **Stale references** — PLAN.md, `libs/**/README.md`, and CLAUDE.md name a
     concrete code artifact (file path, symbol/function, npm/`nx` command, CLI
     flag, config key) that no longer exists in the codebase. For each such
     claim, verify the target still exists (grep/glob/read) and report each
     miss with the doc location + the missing target.
  2. **PLAN narrative vs reality** — PLAN prose that contradicts what is
     actually built or what a higher-authority doc (`docs/specs/README.md`, the
     specs, the code) says. The skill **reports** the contradiction; it does not
     rewrite PLAN (authority flows code/specs → PLAN is a prescriptive contract;
     a human or follow-up spec decides the fix).
- **Report-only output**, categorized by **type** (descriptive/safe-to-fix vs
  prescriptive/needs-a-decision) and **severity** (deterministic-guard failures
  highest).
- **Adaptive delivery** by run context (§5): interactive → print the report;
  headless/scheduled → open a **draft PR** with the report committed, **only
  when drift is found**; clean run → no-op (say so in the transcript).
- **A short "how to schedule this" note** (in the skill's docs) describing the
  intended weekly-routine invocation — **documentation only**, no cron wiring.

Out of scope (explicitly not in v1):

- **README barrel-export-vs-actual-exports reconciliation** (comparing a
  README's listed barrel exports to the lib's real `index.ts` surface).
- **README "what it is" description-accuracy judgment** (whether the intro prose
  correctly describes the lib).
- **Any Stitch / design-system fidelity check.** The wired hex tokens are
  already covered by 0058's deterministic PLAN-vs-`theme.scss` guard, and the
  Stitch MCP is **not reliably available in a headless run** — so this skill
  audits `docs/PLAN.md` + `libs/**/README.md` + `CLAUDE.md` **only** and
  **never pulls Stitch**.
- **Auto-fixing anything.** The skill never edits docs (hard rule, §5).
- **Reimplementing 0058's deterministic guards** — the skill runs them, does not
  duplicate their logic.
- **Any product-slice change** (`libs/mobile/*`, `libs/functions/*`, `apps/*`).
- **Actual cron / GitHub Actions scheduling wiring** — only a how-to note.

## 3. Affected slices & Sheriff tags

- **No product slice is touched.** `slices: []`. This is tooling + docs work. It
  introduces **no cross-slice imports** and no slice source.
- **The skill lives at `.claude/skills/audit-docs/`** (SKILL.md + CHECKLIST.md).
  `.claude/**` is a Claude Code configuration tree, **not a Sheriff module** —
  `sheriff.config.ts`'s `modules` map covers only `apps/*`,
  `libs/shared/*/src`, `libs/{mobile,functions}/<slice>/src`, and
  `tools/sheriff-fixtures/*`; everything else (incl. `.claude/**` and `docs/**`)
  resolves to Sheriff's `noTag` (dep-rule permits any dependency). So **no
  `sheriff.config.ts` change is needed** and no boundary is crossed. `scopes: []`
  is correct — there is no fitting scope tag for a `.claude/skills/` skill, the
  same rationale spec 0058 recorded for `tools/**` (its `tools/*` projects carry
  `tags: []`). Verified against the current config: the skill is not code and is
  not added to `sheriff.config.ts`.
- **Files edited:** `.claude/skills/audit-docs/SKILL.md`,
  `.claude/skills/audit-docs/CHECKLIST.md`. No product code, no barrels, no
  `apps/*` registration, no root config.
- **Implementation dependency (restated):** the skill's deterministic floor
  shells 0058's built artifacts (`tools/doc-integrity-test/`,
  `tools/scripts/gen-spec-status.mjs`). Those must exist for the skill to run its
  floor; 0059 cannot be implemented until 0058 is implemented (§1, §10).

## 4. Data model touchpoints

None. No Firestore collections, fields, converters, or security rules are
touched or added (PLAN §4 unaffected). This is a docs/tooling change only. The
skill reads `.md` docs and the codebase; it writes nothing to Firestore and
accesses no secrets (CLAUDE.md).

## 5. Public types / APIs

**No runtime types, HTTP endpoints, or callables.** The public surface is the
**skill's contract** — its frontmatter, invocation, report format, and delivery
behavior. Concrete enough to implement without further questions:

### 5.1 Skill frontmatter (`.claude/skills/audit-docs/SKILL.md`)

```yaml
---
name: audit-docs
description: Audit Vultus documentation for drift against the codebase. Runs
  spec 0058's deterministic doc-integrity guards as a floor, then adds an
  LLM-judgment pass over PLAN.md, libs/** READMEs, and CLAUDE.md for stale
  code references and PLAN-narrative-vs-reality contradictions. Report-only —
  never edits docs. Interactive runs print the report; headless/scheduled runs
  open a draft PR with the report only when drift is found. Use when the user
  wants to audit/verify documentation, check for doc drift, or on a scheduled
  documentation-health routine.
---
```

**Headless-safety hard constraints — MUST hold (requirements, not choices):**

- **MUST be model-invocable** — do **NOT** set `disable-model-invocation: true`.
  A scheduled fire only runs skills Claude may invoke on its own; disabling model
  invocation would break the scheduled use case.
- **MUST NOT** use `AskUserQuestion` or any interactive prompt in the **headless
  path** (no human to answer). Any input-gathering step is **interactive-only**.
- **MUST NOT** depend on any interactively-authenticated MCP (e.g. Stitch) — git
  - file reads (+ `gh` for the PR) only, so the skill survives a fresh headless
    cloud run.
- **MUST NOT** read or write secrets or `.env.local` (CLAUDE.md).

These constraints and their rationale MUST be stated verbatim-in-spirit in
SKILL.md so an implementer cannot accidentally violate them. (Background:
scheduled routines run headless from a fresh clone; committed `.claude/skills/`
**are** available in that clone; committed docs are the only durable state.)

### 5.2 Invocation

`/audit-docs [--mode <interactive|headless>] [--scope <all|plan|readmes|claude>]`

- **`--mode`** (optional): forces the delivery mode, overriding auto-detection
  (§5.4). The scheduled routine passes `--mode headless`. Absent → auto-detect.
- **`--scope`** (optional, default `all`): limits the judgment layer's doc set
  to PLAN only / READMEs only / CLAUDE.md only, for a faster targeted run. The
  deterministic floor always runs regardless of `--scope`.
- No other arguments. No positional args. No interactive prompt is required to
  run (so the headless path never blocks).

### 5.3 Report format (the exact sections the skill emits)

The report is markdown with these sections in order:

1. **Header** — title `# Documentation Drift Audit`, the run timestamp, the
   detected/forced mode, and the `--scope`.
2. **Deterministic floor** — the result of `pnpm nx test doc-integrity-test`
   and `node tools/scripts/gen-spec-status.mjs --check`. On any failure, one
   finding per failing guard at severity **BLOCKER** (highest), quoting the
   failing assertion / hint (e.g. the ledger's
   `run \`node tools/scripts/gen-spec-status.mjs\` to update`). On pass, one
   line "Deterministic floor: PASS".
3. **Stale references** (judgment class 1) — a table: `doc location (file:line
or section) | claimed artifact | kind (path/symbol/command/flag) | verdict
(MISSING/OK-but-moved) | evidence`. Type = **descriptive/safe-to-fix**.
   Severity **HIGH** for a confirmed missing target, **MEDIUM** for
   OK-but-moved / ambiguous.
4. **PLAN narrative vs reality** (judgment class 2) — a list: each entry names
   the PLAN section, quotes the contradicting prose, names the
   higher-authority source that contradicts it (doc path/section or code), and
   states the contradiction. Type = **prescriptive/needs-a-decision**. Severity
   **HIGH**. (The PLAN §5–§6 issue-workflow contradiction is the canonical
   entry — see §8.)
5. **Summary** — counts by severity and by type; an explicit overall verdict
   line: **`DRIFT FOUND`** or **`CLEAN`**. This verdict drives delivery (§5.4).

Every finding carries **both** a **type** (descriptive/safe-to-fix |
prescriptive/needs-a-decision) and a **severity** (BLOCKER > HIGH > MEDIUM), so
the reader knows what is safe to fix directly vs what needs a decision. LLM
findings are prose and may be worded differently across runs — acceptable for a
report (§10).

### 5.4 Delivery + mode detection

**Auto-detection signal (load-bearing — specified precisely, not hand-waved).**
The skill decides interactive vs headless using the **`--mode` override first**,
then a capability probe, then a safe default:

1. **If `--mode` is passed, honor it.** This is the reliable, explicit signal
   the scheduled routine uses (`--mode headless`); the how-to note (§7) instructs
   the routine to always pass it. This makes the scheduled case deterministic and
   removes reliance on any fuzzy probe for the path that matters most.
2. **Else probe interactivity via `AskUserQuestion` availability** — the same
   signal the `create-spec` skill uses to gate its interview
   (`.claude/skills/create-spec/SKILL.md` step 1: "Requires an interactive
   session (`AskUserQuestion`). If questioning isn't available (autonomous
   loop/scheduler)…"). If `AskUserQuestion` is available → **interactive**; if it
   is unavailable (autonomous loop / scheduler) → **headless**. The skill does
   **not** actually prompt via `AskUserQuestion` in either path — it only reads
   the tool's presence as the interactivity signal. (This keeps the headless
   MUST-NOT-prompt constraint intact.) **The "probe" is NOT a claim of a
   programmatic is-tool-available boolean API** — it is the same judgment the
   model makes about its own run context (interactive session vs autonomous
   loop/scheduler) that `create-spec` already relies on; an implementer should
   not over-engineer it into a capability-inspection call. **When in doubt, take
   the interactive branch.** The reliability-critical scheduled path bypasses the
   probe entirely via explicit `--mode headless` (step 1).
3. **If the probe is inconclusive, default to `interactive`** (print-only, no
   repo writes). Rationale in §5.5.

**Interactive mode:** print the categorized report (§5.3) to the user as
markdown. **No repo writes. No branch. No PR.** Even when drift is found, an
interactive run only prints.

**Headless / scheduled mode:**

- **Clean run (verdict `CLEAN`): no-op.** Open nothing; write nothing. State in
  the transcript "audit clean — no PR opened". Rationale: a weekly routine that
  PRs every week trains the user to ignore it; PR only on signal.
- **Drift run (verdict `DRIFT FOUND`): open a DRAFT PR** carrying the report as
  a committed file. Exact shape:
  - **Branch:** `claude/audit-docs-<UTC-date>` (a `claude/`-prefixed branch, per
    the headless-routine convention; date suffix `YYYYMMDD` keeps successive
    weekly PRs from colliding). Created off current `main`. **Same-day collision:**
    if `claude/audit-docs-<YYYYMMDD>` already exists (e.g. a second run the same
    UTC day), **reuse it and overwrite the report file on it** (idempotent) rather
    than failing on branch creation.
  - **File:** the report is written to `docs/DRIFT-REPORT.md` (single, overwritten
    each run — a living report, not an accumulating pile). This is the **only**
    file the skill writes, and it is a **new report file, never an edit to an
    audited doc** (report-only invariant holds: PLAN/README/CLAUDE are read-only).
  - **PR:** `gh pr create --base main --draft --title
"docs: documentation drift audit (<UTC-date>)"`, body = the report summary
    (§5.3 section 5) + a link/pointer to `docs/DRIFT-REPORT.md`, plus a line
    stating the fixes are for a human/follow-up spec (report-only). Label
    best-effort (never blocking): `gh label create docs-drift --force 2>$null`
    then `gh pr edit <pr> --add-label docs-drift 2>$null`.
  - **Never merges, never force-pushes, never auto-fixes.** Draft only.

### 5.5 Failure / no-op behavior (exit posture)

- **0058 artifacts absent** (`tools/doc-integrity-test/` or
  `tools/scripts/gen-spec-status.mjs` missing): **fail loudly** with
  "Deterministic floor unavailable — spec 0058 must be implemented and merged
  first (expected `tools/doc-integrity-test/` + `tools/scripts/gen-spec-status.mjs`)."
  Do **not** silently skip the floor and proceed to judgment-only; do not open a
  PR. In headless mode this failure is reported in the transcript (no PR).
- **Deterministic guard failure** (artifacts present but a guard is red): this is
  **drift** — a BLOCKER finding — and in headless mode triggers the draft PR.
- **Clean everywhere:** interactive prints "CLEAN"; headless no-ops (nothing
  written, nothing opened).

**Which mode-detection failure is safer (feeds the §5.4 default).** A false
**headless** in an interactive run would open an **unwanted draft PR** (visible
noise the user must close). A false **interactive** in a scheduled routine would
**print to a transcript nobody reads and lose the finding** (silent miss). The
scheduled routine eliminates this risk entirely by **always passing
`--mode headless`** (step 1). For the residual ambiguous case where no `--mode`
is given and the probe is inconclusive, the skill defaults to **interactive**:
the failure there is a harmless printed report, not a lost finding, and it never
produces an unwanted PR from a human's manual run. The load-bearing scheduled
path does not depend on the probe at all.

## 6. UI / Stitch screen refs

**N/A — not a mobile UI feature.** This spec introduces no page, route,
component, or user-facing app action. No Stitch screen applies and **none is
pulled** — indeed the skill is explicitly forbidden from touching Stitch (§2,
§5.1) so it stays headless-safe. No design tokens are consumed.

## 7. Implementation task graph

Legend: `[sequential]` must complete before dependents; `[parallel]` tasks have
disjoint file manifests and may run concurrently. A skill is prose, so most
"verification" is the §8 dry-run, not automated tests.

> **Prerequisite gate (blocks the whole graph):** confirm spec 0058 is
> implemented and merged — `tools/doc-integrity-test/`,
> `tools/scripts/gen-spec-status.mjs`, and `docs/specs/STATUS.md` exist on disk.
> If not, **halt as `needs-human`** (0058 must land first). This is not a task
> that writes files; it is the go/no-go check the implementer runs before T1.

**T1 [sequential] — Author the CHECKLIST reference doc.**
Write `.claude/skills/audit-docs/CHECKLIST.md`: the pinned per-class audit
procedure that SKILL.md references. It contains (a) the deterministic-floor
commands and how to interpret their output as BLOCKER findings; (b) the
**stale-reference** procedure — enumerate concrete artifacts named in PLAN.md /
`libs/**/README.md` / CLAUDE.md (paths, symbols, `nx`/`pnpm` commands, CLI
flags, config keys), and for each verify existence via glob/grep/read, marking
MISSING vs OK-but-moved; (c) the **PLAN-narrative** procedure — read PLAN prose
against `docs/specs/README.md`, the specs, and code, and record contradictions
(with the PLAN §5–§6 issue-workflow case as the worked example — where the
finding is the **retained contradictory body content** still present verbatim,
NOT the absence of an annotation, since PLAN §5's in-place "Superseded note
(2026-06-16)" does not remove the obsolete body it annotates); (d) the exact
report section layout (§5.3); (e) the mode-detection rule (§5.4) and the
report-only invariant. Sequential because SKILL.md references it.
_Manifest:_ `.claude/skills/audit-docs/CHECKLIST.md`.

**T2 [sequential] — Author SKILL.md.**
Write `.claude/skills/audit-docs/SKILL.md` in the house style of
`.claude/skills/create-spec/SKILL.md` / `cleanup-feature/SKILL.md`: frontmatter
per §5.1 (name/description; **no `disable-model-invocation`**), a short intro, a
**"## Conventions"** block (report-only hard rule; headless-safety MUSTs from
§5.1 with rationale; branch/label conventions), a **"## Steps"** block, and a
**"## Safety rules"** block. Steps, in order, wire the other tasks:

1. **Prerequisite/floor** — verify 0058 artifacts exist (else fail loudly per
   §5.5), then run `pnpm nx test doc-integrity-test` and
   `node tools/scripts/gen-spec-status.mjs --check`; capture results as the
   report's floor section (T3).
2. **Judgment layer** — run the stale-reference and PLAN-narrative procedures
   from CHECKLIST.md over the `--scope` doc set (T4).
3. **Assemble** the categorized report per §5.3.
4. **Detect mode** (§5.4) and **deliver** (§5.5): interactive → print; headless
   → draft PR on drift, no-op on clean.

This task assembles the contract but does not itself add new files beyond
SKILL.md.
_Manifest:_ `.claude/skills/audit-docs/SKILL.md`.

**T3 [sequential, folded into T2] — Deterministic-floor wiring.**
Not a separate file; the floor invocation is written into SKILL.md step 1 and
detailed in CHECKLIST.md. Listed to make explicit that the floor **reuses**
0058's commands and never reimplements the guards. No separate manifest.

**T4 [sequential, folded into T1] — The two judgment procedures.**
The stale-reference and PLAN-narrative procedures live in CHECKLIST.md (authored
in T1) and are invoked by SKILL.md step 2. No separate manifest.

**T5 [sequential, folded into T2] — Adaptive delivery + mode detection.**
The `--mode` override → `AskUserQuestion`-availability probe → interactive-safe
default (§5.4), and the interactive-print / headless-draft-PR / clean-no-op
delivery, are written into SKILL.md steps + Conventions. No separate manifest.

**T6 [sequential] — "How to schedule this" note (docs only).**
Add a short section to `.claude/skills/audit-docs/CHECKLIST.md` (or a brief note
in SKILL.md) describing the intended weekly-routine invocation
(`/audit-docs --mode headless`) from a fresh headless clone, and stating that
**actual cron/GHA wiring is out of scope** (a human sets up the schedule). Since
this edits CHECKLIST.md, it is folded into T1's file (authored together) or a
follow-on edit to the same file — **no new manifest path**, sequential after T1.
_Manifest:_ `.claude/skills/audit-docs/CHECKLIST.md` (same file as T1).

> **Why no `[parallel]` tasks:** the deliverable is two prose files that
> reference each other, and there is no independent-slice work. Everything is
> sequential; there are no disjoint manifests to fan out. This is intentional
> and correct for a docs/skill change.

## 8. Test plan

A skill is prose, not code — it is **not unit-testable** like a lib. Per the
CLAUDE.md "green build ≠ done" spirit, **skill correctness cannot be proven by a
green typecheck/lint/build**; it is **demonstrated by a manual dry-run and
human review**. Per PLAN §5 pyramid: **no unit tests** (no shippable code),
**no component tests** (no UI), and **no e2e flows required** — this is a
docs/skill change with no route and no user-facing app action (the e2e rubric's
"not required — infra/config" branch applies). State this explicitly in the PR.

**Correctness is demonstrated by a dry-run against the CURRENT repo:**

- **(a) True-positive detection — the load-bearing check.** A dry-run must
  surface the **known real drift**: PLAN §5–§6 describe the GitHub-issue task
  workflow while `docs/specs/README.md` (and PLAN's own 2026-06-16 "Superseded
  note") say that workflow is **replaced** by the spec-file workflow. The audit
  must report this as a **PLAN narrative vs reality** finding (type
  prescriptive/needs-a-decision, severity HIGH), naming PLAN §5/§6, quoting the
  issue-workflow prose, and citing `docs/specs/README.md` as the contradicting
  authority. **The finding IS the retained contradictory body content** — the
  obsolete issue-workflow prose that still lives verbatim in PLAN §5–§6 — **NOT
  the absence of an annotation.** PLAN §5 already carries its own in-place
  "Superseded note (2026-06-16)" (around `docs/PLAN.md:240–248`), yet the
  contradicting body text remains; the audit must report the drift **confidently**
  (the stale body is the drift) rather than second-guess whether the existing
  "superseded" note already resolves it — it does not. This proves the judgment
  layer detects a genuine true positive, not just runs.
- **(b) Report-only invariant (interactive).** An interactive dry-run produces
  the report and makes **zero repo writes** — verify `git status` is clean after
  the run (no doc edited, no `docs/DRIFT-REPORT.md`, no branch). This proves the
  hard report-only + interactive-print rules.
- **(c) Headless path traceable.** The headless PR-open logic is described
  concretely enough (§5.4: branch name, `docs/DRIFT-REPORT.md`, draft PR title,
  clean-run no-op) that a reviewer can trace it end-to-end from SKILL.md +
  CHECKLIST.md without running a scheduler. (A live scheduled run is not required
  to accept the spec; the traceable description is the acceptance bar.)
- **(d) Deterministic-floor reuse.** Confirm the dry-run's floor step invokes
  0058's `pnpm nx test doc-integrity-test` + `gen-spec-status.mjs --check` and
  does **not** reimplement their logic; and that with 0058 present the floor runs
  (or, if 0058 is absent at dry-run time, the skill **fails loudly** per §5.5
  rather than skipping — verify the loud-fail message).

Keep the check surface to what is actually verifiable: a dry-run transcript +
`git status` + a read of the two prose files. LLM-judgment wording varies run to
run (§10); the acceptance bar is that the true positive in (a) is **detected**,
not that its wording is byte-stable.

## 9. Definition of done

Tailored PLAN §5 checklist (most code gates are N/A for a prose skill — stated
per line):

- [ ] `.claude/skills/audit-docs/SKILL.md` and
      `.claude/skills/audit-docs/CHECKLIST.md` exist and are **well-formed**:
      valid frontmatter (name/description present; **no
      `disable-model-invocation`**), the `## Conventions` / `## Steps` /
      `## Safety rules` structure matching the existing skills' house style.
- [ ] **Manual dry-run against the current repo produces the expected findings**,
      including the PLAN §5–§6-vs-`specs/README.md` **true positive** as a
      PLAN-narrative finding (§8a). Human-verified from the dry-run transcript —
      **not** claimed done off a green build.
- [ ] **Report-only invariant holds** — the interactive dry-run edits **no** doc
      and writes no repo file (`git status` clean); PLAN/README/CLAUDE are
      read-only (§8b).
- [ ] **Headless-safety constraints satisfied** (§5.1): model-invocable (no
      `disable-model-invocation`); **no `AskUserQuestion`/interactive prompt in
      the headless path**; **no Stitch/MCP dependency**; **no secrets access**.
- [ ] **Deterministic floor reuses 0058** — shells `nx test doc-integrity-test` + `gen-spec-status.mjs --check`; does not reimplement the guards; **fails
      loudly** if 0058's artifacts are absent (§5.5, §8d).
- [ ] **Adaptive delivery** implemented per §5.4: interactive prints; headless
      opens a draft PR **only on drift** (branch `claude/audit-docs-<date>`,
      `docs/DRIFT-REPORT.md`, draft title); clean headless run no-ops.
- [ ] The **0058 implementation dependency is documented** in the spec and in
      SKILL.md (0059 cannot be implemented until 0058 is implemented/merged).
- [ ] Typecheck / lint / Sheriff / build: **N/A for the two prose files**
      (`.claude/**` is not compiled or Sheriff-tagged); confirm `nx lint`/build
      remain green (unchanged — the change touches no project). If the pre-commit
      hook's markdown Prettier runs on the new files, they must be
      Prettier-clean.
- [ ] Component tests: **N/A** (no UI).
- [ ] e2e: **N/A** (docs/skill change; no route or user action).
- [ ] PR description filled out per template, stating the manual-dry-run
      verification and that automated gates do not prove skill correctness.

## 10. Risks

- **0058 implementation dependency (blocking).** 0059's deterministic floor
  shells 0058's `tools/doc-integrity-test/` guards + `gen-spec-status.mjs`, which
  are **spec-merged but not yet built**. 0059 **cannot be implemented until 0058
  is implemented and merged**; the implementer must gate on this (§7 prerequisite)
  and the skill must fail loudly if the artifacts are absent (§5.5) rather than
  silently skip its floor.
- **Mode-detection reliability.** The interactive/headless signal
  (`AskUserQuestion` availability) is a proxy, not a guarantee. A false
  **headless** in a human's interactive run opens an **unwanted draft PR**
  (visible noise); a false **interactive** in a scheduled routine **prints to a
  transcript nobody reads and loses the finding** (silent miss). Mitigation: the
  scheduled routine **always passes `--mode headless`** (deterministic, no probe
  needed for the path that matters), and for the residual ambiguous case the skill
  **defaults to interactive** — the safer failure (a harmless printed report, no
  unwanted PR). See §5.4/§5.5.
- **False positives in stale-reference detection.** A doc may name a symbol/path
  that still exists but was **moved/renamed**, or reference a command in prose
  that the grep can't resolve. Mitigation: report such cases as **OK-but-moved /
  ambiguous** (MEDIUM), distinct from confirmed MISSING (HIGH), and since the
  skill is **report-only** a false positive costs a human a glance, never a bad
  edit.
- **Report-only means drift is surfaced, not fixed (accepted).** The skill never
  edits docs; a human or a follow-up spec applies fixes. This is a deliberate
  design rule (prescriptive docs must not be auto-rewritten; unattended runs stay
  safe), accepted as the v1 posture.
- **LLM-judgment nondeterminism (accepted).** Two runs may word the same finding
  differently or vary borderline calls. Acceptable for a human-read report; the
  acceptance bar (§8) is that the known true positive is **detected**, not that
  wording is byte-stable. This is why the deterministic floor (0058) carries the
  hard, byte-stable guarantees and the judgment layer sits on top.
- **PLAN conflict check.** This spec introduces no cross-slice import and no data
  shape outside PLAN §4; it audits PLAN rather than changing architecture. The
  one PLAN interaction is that the skill will **report** PLAN §5–§6 as
  contradicted by `docs/specs/README.md` (a known, intended true positive), not
  resolve it — resolution is a separate human/spec decision, consistent with the
  report-only rule.
