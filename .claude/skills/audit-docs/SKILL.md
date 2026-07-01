---
name: audit-docs
description: Audit Vultus documentation for drift against the codebase. Runs spec 0058's deterministic doc-integrity guards as a floor, then adds an LLM-judgment pass over PLAN.md, libs/** READMEs, and CLAUDE.md for stale code references and PLAN-narrative-vs-reality contradictions. Report-only — never edits docs. Interactive runs print the report; headless/scheduled runs open a draft PR with the report only when drift is found. Use when the user wants to audit/verify documentation, check for doc drift, or on a scheduled documentation-health routine.
---

# Audit Docs

Catch documentation that has fallen out of step with reality — a README naming a
file that was deleted, a PLAN section describing a workflow that was replaced —
and surface it as a categorized, report-only audit. You run **spec 0058's
deterministic guards as a floor**, then add a **two-class judgment layer** on top.
The exact per-class procedure, report layout, and mode-detection rule live in
`CHECKLIST.md` (this dir) — read it and follow it verbatim; this file wires the
steps. (Project-wide rules — shell, secrets, branches — are in `CLAUDE.md`.)

Invocation:

```
/audit-docs [--mode <interactive|headless>] [--scope <all|plan|readmes|claude>]
```

- **`--mode`** (optional) — forces delivery mode, overriding auto-detection. The
  scheduled routine passes `--mode headless`. Absent → auto-detect.
- **`--scope`** (optional, default `all`) — limits the **judgment layer** to PLAN
  only / READMEs only / CLAUDE.md only. The **deterministic floor always runs**
  regardless of `--scope`.

## Conventions

- **Report-only — hard rule.** The audited docs (`docs/PLAN.md`,
  `libs/**/README.md`, `CLAUDE.md`) are **read-only**. Never edit them, never
  auto-fix, never DRY. The only file this skill may ever write is
  `docs/DRIFT-REPORT.md` (headless drift path) — a **new report file, never an
  edit to an audited doc**. Fixes are for a human or a follow-up spec.
- **Reuse 0058's floor — never reimplement it.** Shell
  `pnpm nx test doc-integrity-test` and
  `node tools/scripts/gen-spec-status.mjs --check`. Do not duplicate the guards'
  logic.
- **0058 implementation dependency.** This skill's floor shells 0058's built
  artifacts (`tools/doc-integrity-test/`, `tools/scripts/gen-spec-status.mjs`).
  **0059 cannot run until spec 0058 is implemented and merged.** If either
  artifact is absent, **fail loudly** (step 1) — never silently skip the floor.
- **Headless-safety hard constraints — MUST hold (requirements, not choices):**
  - **MUST be model-invocable** — this frontmatter does **not** set
    `disable-model-invocation`. A scheduled routine only fires skills Claude may
    invoke on its own; disabling model invocation would break the scheduled use
    case.
  - **MUST NOT** use `AskUserQuestion` or any interactive prompt in the
    **headless path** — there is no human to answer. Reading `AskUserQuestion`
    availability as a mode signal (step 4) is **not** prompting; the skill never
    actually asks a question in either path.
  - **MUST NOT** depend on any interactively-authenticated MCP (e.g. Stitch) —
    git + file reads (+ `gh` for the PR) only, so the skill survives a fresh
    headless cloud run. No Stitch, no design-system fetch.
  - **MUST NOT** read or write secrets or `.env.local` (CLAUDE.md).
    (Background: scheduled routines run headless from a fresh clone; committed
    `.claude/skills/` and committed docs are the only durable state.)
- **Branch / label conventions (headless drift path).** Branch
  `claude/audit-docs-<YYYYMMDD>` (UTC), off current `main`; on same-day collision
  reuse and overwrite. Draft PR titled
  `docs: documentation drift audit (<UTC-date>)`. Label `docs-drift`, best-effort
  (never blocking). Never merge, never force-push.
- **Shell is PowerShell** (Windows). Use PS-safe syntax (`2>$null`,
  `$LASTEXITCODE`).

## Steps

### 1. Prerequisite gate + deterministic floor

- Confirm 0058's artifacts exist in the current worktree:
  `tools/doc-integrity-test/` **and** `tools/scripts/gen-spec-status.mjs`. If
  **either** is absent, **fail loudly** and stop (no judgment run, no PR) with:
  > Deterministic floor unavailable — spec 0058 must be implemented and merged
  > first (expected `tools/doc-integrity-test/` +
  > `tools/scripts/gen-spec-status.mjs`).
- Otherwise shell the floor (always, regardless of `--scope`):
  `pnpm nx test doc-integrity-test` and
  `node tools/scripts/gen-spec-status.mjs --check`. Capture the results as the
  report's **Deterministic floor** section — `PASS`, or one **BLOCKER** finding
  per failing guard quoting the failing assertion/hint (see `CHECKLIST.md` §1).

### 2. Judgment layer

- Run the **two judgment procedures** from `CHECKLIST.md` over the `--scope` doc
  set:
  1. **Stale references** (§2) — enumerate concrete artifacts named in the docs
     (paths, symbols, `nx`/`pnpm`/`node` commands + Nx targets, CLI flags, config
     keys) and verify each via glob/grep/read; mark **MISSING** (HIGH) vs
     **OK-but-moved / ambiguous** (MEDIUM). Type: descriptive/safe-to-fix.
  2. **PLAN narrative vs reality** (§3) — read PLAN prose against
     `docs/specs/README.md`, the specs, and code; record each contradiction
     (PLAN section + quoted prose + higher-authority source + the contradiction).
     Type: prescriptive/needs-a-decision, severity HIGH. Report the drift
     confidently — **do not rewrite PLAN**. The canonical PLAN §5–§6 issue-vs-
     spec-workflow contradiction (the retained obsolete body content, not a
     missing annotation) is the expected entry against the current repo.

### 3. Assemble the report

- Build the categorized markdown report with the sections in the exact order of
  `CHECKLIST.md` §4: Header → Deterministic floor → Stale references (table) →
  PLAN narrative vs reality (list) → Summary. Every finding carries **both** a
  type and a severity. The Summary gives counts by severity (BLOCKER > HIGH >
  MEDIUM) and by type, and an explicit verdict line **`DRIFT FOUND`** or
  **`CLEAN`** — this verdict drives delivery.

### 4. Detect mode + deliver

- **Detect mode** per `CHECKLIST.md` §5: `--mode` override first → else read
  `AskUserQuestion`-availability as the interactivity signal (the same judgment
  `create-spec` step 1 makes about its run context; **not** a programmatic
  tool-inspection call, and the skill never actually prompts) → else default
  **interactive**.
- **Deliver:**
  - **Interactive** — print the report as markdown. **Zero repo writes, no
    branch, no PR** — even when the verdict is `DRIFT FOUND`.
  - **Headless + `CLEAN`** — no-op; write nothing, open nothing. State in the
    transcript: `audit clean — no PR opened`.
  - **Headless + `DRIFT FOUND`** — write the report to `docs/DRIFT-REPORT.md`
    (the only file written), create/reuse branch `claude/audit-docs-<YYYYMMDD>`
    off `main`, and open a draft PR:
    `gh pr create --base main --draft --title "docs: documentation drift audit (<UTC-date>)"`
    with body = the Summary section + a pointer to `docs/DRIFT-REPORT.md` + a
    report-only line. Label best-effort:
    `gh label create docs-drift --force 2>$null` then
    `gh pr edit <pr> --add-label docs-drift 2>$null`. Never merge, never
    force-push, never auto-fix.

## Safety rules

- **Never edit an audited doc.** `docs/PLAN.md`, `libs/**/README.md`, and
  `CLAUDE.md` are read-only. The one writable output is `docs/DRIFT-REPORT.md`,
  and only on the headless drift path. Report drift; do not fix it.
- **Never silently skip the floor.** If 0058's artifacts are absent, fail loudly
  (step 1) and stop — do not proceed to a judgment-only run, do not open a PR.
- **Never prompt in the headless path**, never touch Stitch or any interactively
  authenticated MCP, never read or write secrets or `.env.local`.
- **In an interactive run, make zero repo writes** — no doc edited, no
  `docs/DRIFT-REPORT.md`, no branch, no PR. `git status` must be clean after the
  run.
- **A green floor is not proof the docs are correct.** The judgment layer is
  LLM prose that a human reads; the deterministic floor (0058) carries the hard,
  byte-stable guarantees.
