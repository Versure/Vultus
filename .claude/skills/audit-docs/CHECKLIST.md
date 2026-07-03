# /audit-docs — audit checklist & report contract

This is the pinned, repeatable procedure `SKILL.md` follows. It defines the
**deterministic floor**, the **two judgment procedures** (the only drift classes
in v1), the exact **report layout**, the **mode-detection rule**, the
**report-only invariant**, and the **how-to-schedule** note. Follow it verbatim
so the audit is a contract, not improvisation.

Two things this audit is, and is not:

- It **is** a floor (reuse spec 0058's guards) + a judgment layer (two classes).
- It is **not** a fixer. It never edits an audited doc, never DRYs, never touches
  Stitch, and never reconciles README barrel exports or judges README "what it
  is" prose — those are explicitly out of scope for v1.

## 0. Prerequisite gate (run before anything else)

The deterministic floor **shells spec 0058's built artifacts**. Confirm they
exist on disk (in the current worktree):

- `tools/doc-integrity-test/` (the three vitest guards)
- `tools/scripts/gen-spec-status.mjs` (the ledger generator, with `--check`)

If **either** is absent, **fail loudly** and stop — do not proceed to a
judgment-only run, do not open a PR. Emit exactly:

> Deterministic floor unavailable — spec 0058 must be implemented and merged
> first (expected `tools/doc-integrity-test/` +
> `tools/scripts/gen-spec-status.mjs`).

In headless mode this failure is reported in the transcript only (no PR).

## 1. Deterministic floor (reuse 0058 — never reimplement)

Always runs, regardless of `--scope`. Shell these two commands exactly; never
re-derive their logic:

- `pnpm nx test doc-integrity-test` — runs the three guards at
  `tools/doc-integrity-test/src/{lib-readme,plan-theme-hex,spec-status-ledger}.spec.ts`.
- `node tools/scripts/gen-spec-status.mjs --check` — verifies the committed
  ledger `docs/specs/STATUS.md` is up to date.

Interpret the output:

- **Both pass** → one report line: `Deterministic floor: PASS`.
- **Any failure** → one finding **per failing guard** at severity **BLOCKER**
  (the highest severity). Quote the failing assertion / hint verbatim (e.g. the
  ledger check's `run \`node tools/scripts/gen-spec-status.mjs\` to update`). A
  red floor is drift — in headless mode it triggers the draft PR.

## 2. Judgment class 1 — Stale references (descriptive / safe-to-fix)

Goal: catch a doc that names a **concrete code artifact that no longer exists**.

Audited docs (limited by `--scope`): `docs/PLAN.md`, every `libs/**/README.md`,
and `CLAUDE.md`.

Procedure:

1. Enumerate the concrete artifacts each doc names — only checkable ones:
   - **file/dir paths** (e.g. `tools/scripts/gen-spec-status.mjs`);
   - **symbols / function names** (exported identifiers, class/type names);
   - **commands** (`nx`, `pnpm`, `node`, `firebase` invocations and named Nx
     targets, e.g. `mobile:serve-mock`);
   - **CLI flags** (e.g. `--configuration=mock`, `--check`);
   - **config keys** (e.g. a `pnpm-workspace.yaml` `allowBuilds` entry).
     Skip prose that names no checkable artifact — do not invent targets to check.
2. For each artifact, verify it still exists via glob / grep / read:
   - path → glob it; symbol → grep the codebase; command/target → grep
     `project.json` / `package.json` / config; flag → grep its handler; key →
     read the config file.
3. Record a verdict per artifact:
   - **MISSING** (severity **HIGH**) — confirmed absent (path gone, symbol not
     found, target/flag/key not defined anywhere).
   - **OK-but-moved / ambiguous** (severity **MEDIUM**) — the target still
     exists but under a different path/name, or the grep can't disambiguate a
     prose mention. This is the false-positive-safety valve: report it as MEDIUM,
     never as MISSING.
   - Artifacts that verify cleanly are **not** findings — do not list them.

Type for every class-1 finding: **descriptive / safe-to-fix**.

## 3. Judgment class 2 — PLAN narrative vs reality (prescriptive / needs-a-decision)

Goal: catch **PLAN prose that contradicts what is actually built** or what a
**higher-authority** doc says. Authority flows code / specs → PLAN (PLAN is a
prescriptive contract), so the audit **reports** the contradiction and **never
rewrites PLAN** — a human or a follow-up spec decides the fix.

Procedure:

1. Read `docs/PLAN.md` prose against the higher-authority sources:
   `docs/specs/README.md`, the merged specs under `docs/specs/`, and the code.
2. Record each contradiction with: the **PLAN section**, the **quoted
   contradicting prose**, the **higher-authority source** (doc path/section or
   code) that contradicts it, and a one-line statement of the contradiction.
3. Type = **prescriptive / needs-a-decision**, severity **HIGH**.

### Illustrative example of the class (historical — do not expect against the current repo)

The following is a **historical illustration** of what a class-2 finding looks
like — it is **not** a current expectation. **This specific PLAN §5–§6
issue-workflow drift was fixed on 2026-07-01** (`grep "Every task is a GitHub
issue" docs/PLAN.md` now returns nothing; PLAN §5 is now "Task management —
spec-driven" and §6 is marked "Historical"). **Do not expect this instance
against the current repo** — an agent that reports it today is fabricating a
false positive. It is retained only to show the _shape_ of a class-2 finding.

_As it stood before the fix,_ the finding read: PLAN §5 and §6 still described
the **GitHub-issue task-management model** — every task is a GitHub issue,
issues sized to one session, `.github/ISSUE_TEMPLATE/` templates, PR "references
issue", branch convention `feat/<issue-number>-<slug>` — as the live process.
For example, PLAN §5 "Task management — issue-driven" stated:

> Every task is a GitHub issue. The issue is the unit of work; the PR closes the
> issue.

**Higher authority that contradicted it:** `docs/specs/README.md` (top): "This
**spec-file workflow supersedes the GitHub-issue task management described in
`docs/PLAN.md` §5–§6** — there are no GitHub issues; the spec file (reviewed and
merged as a PR) is the unit of work."

**What made it a class-2 finding (the general teaching):** a class-2 finding is
the **retained contradictory body content** — obsolete prose still present
**verbatim** in PLAN that contradicts a higher-authority source — **NOT the
absence of an annotation**. In the historical case, PLAN §5 already carried a
"Superseded note", yet the contradicting body text still remained below it; the
existing annotation did **not** resolve the drift — the obsolete body was the
drift. When you find a _live_ instance of this class, record it as a class-2
finding (type prescriptive/needs-a-decision, severity HIGH), naming the PLAN
section, quoting the contradicting prose, and citing the higher-authority
source — and never rewrite PLAN. But only report a class-2 finding you have
**verified against the current repo**; do not assert this now-removed instance
as current.

## 4. Report layout (emit these sections in this order)

Markdown. The same layout whether printed (interactive) or written to
`docs/DRIFT-REPORT.md` (headless).

1. **Header** — title `# Documentation Drift Audit`; the run timestamp (UTC);
   the detected/forced **mode**; and the `--scope`.
2. **Deterministic floor** — the result of the two floor commands (§1). Either
   `Deterministic floor: PASS` or one BLOCKER finding per failing guard with the
   quoted assertion/hint.
3. **Stale references** — a table with columns:
   `doc location (file:line or section) | claimed artifact | kind (path/symbol/command/flag/key) | verdict (MISSING/OK-but-moved) | evidence`.
   Type for the whole section: descriptive/safe-to-fix.
4. **PLAN narrative vs reality** — a list; each entry names the PLAN section,
   quotes the contradicting prose, names the higher-authority source, and states
   the contradiction. Type: prescriptive/needs-a-decision. (The §3 example is a
   **historical illustration of the class**, not an expected entry — its PLAN
   §5–§6 instance was fixed on 2026-07-01 and must **not** be expected against
   the current repo. Only list class-2 findings you verify against the repo as
   it stands.)
5. **Summary** — counts **by severity** (BLOCKER > HIGH > MEDIUM) and **by type**
   (descriptive/safe-to-fix | prescriptive/needs-a-decision), plus an explicit
   overall verdict line: **`DRIFT FOUND`** or **`CLEAN`**. This verdict drives
   delivery (§5).

Every finding carries **both** a **type** and a **severity**. LLM-judgment prose
may be worded differently across runs — acceptable for a human-read report; the
bar is that a true positive is detected, not that wording is byte-stable.

## 5. Mode detection + delivery + report-only invariant

**Report-only invariant (hard rule).** The audited docs — `docs/PLAN.md`,
`libs/**/README.md`, `CLAUDE.md` — are **read-only**. The skill never edits them,
never auto-fixes. The **only** file it may ever write is `docs/DRIFT-REPORT.md`
(headless drift path), and that is a **new report file, never an edit to an
audited doc**.

**Mode detection** — decide interactive vs headless in this order:

1. **`--mode` override first.** If `--mode interactive` or `--mode headless` is
   passed, honor it. A headless run — e.g. a not-yet-wired scheduled routine —
   should pass `--mode headless`, so the load-bearing path never depends on a
   probe.
2. **Else read `AskUserQuestion`-availability as the interactivity signal** — the
   same judgment `create-spec` step 1 makes about its run context (interactive
   session vs autonomous loop/scheduler). This is **NOT** a programmatic
   is-tool-available API call, and the skill **never actually prompts** via
   `AskUserQuestion` — it only reads the tool's presence as the signal (keeping
   the headless MUST-NOT-prompt constraint intact). Available → interactive;
   unavailable (autonomous loop/scheduler) → headless.
3. **Else default to `interactive`.** When in doubt, take the interactive branch:
   its failure mode (a harmless printed report, no PR) is safer than a false
   headless (an unwanted draft PR). See "Which failure is safer" below.

**Delivery:**

- **Interactive** — print the categorized report (§4) as markdown. **Zero repo
  writes. No branch. No PR.** Even when the verdict is `DRIFT FOUND`, an
  interactive run only prints.
- **Headless + `CLEAN`** — no-op. Write nothing, open nothing. State in the
  transcript: `audit clean — no PR opened`.
- **Headless + `DRIFT FOUND`** — open a **draft PR** carrying the report:
  - **Branch:** `claude/audit-docs-<YYYYMMDD>` (UTC date), created off current
    `main`. **Same-day collision:** if it already exists, reuse it and overwrite
    the report file on it (idempotent) rather than failing on branch creation.
  - **File:** write the report to `docs/DRIFT-REPORT.md` (single, overwritten
    each run — a living report, not an accumulating pile). This is the **only**
    file written.
  - **PR:** `gh pr create --base main --draft --title "docs: documentation drift audit (<UTC-date>)"`.
    Body = the Summary section (§4.5) + a pointer to `docs/DRIFT-REPORT.md` + a
    line stating the fixes are for a human / follow-up spec (report-only).
  - **Label (best-effort, never blocking):**
    `gh label create docs-drift --force 2>$null` then
    `gh pr edit <pr> --add-label docs-drift 2>$null`.
  - **Never merge, never force-push, never auto-fix.** Draft only.

**Which mode-detection failure is safer.** A false **headless** in a human's
interactive run opens an **unwanted draft PR** (visible noise the user must
close). A false **interactive** in a headless run **prints to a transcript
nobody reads and loses the finding** (silent miss). A headless run eliminates
this risk by passing `--mode headless` explicitly. For the residual ambiguous
case (no `--mode`, inconclusive signal), default to **interactive** — the
harmless failure.

## 6. How to schedule this (optional, not-yet-wired — documentation only)

**No scheduled workflow exists today.** Nothing in `.github/` invokes this
skill headlessly — invocation is **manual** (`/audit-docs`). This section
documents how one _could_ optionally wire a headless routine; it does not
describe an active one. To actually schedule it, a human would add a workflow
(none exists).

The optional headless invocation, from a fresh headless clone, would be:

```
/audit-docs --mode headless
```

The committed `.claude/skills/audit-docs/` files are available in that fresh
clone, and committed docs are the only durable state — so the skill survives
headless with git + file reads (+ `gh` for the PR) only. Passing `--mode
headless` explicitly makes the headless path deterministic (it never depends on
the interactivity probe). On a clean run it no-ops (no PR); it PRs only when
drift is found, so a periodic routine would not train the user to ignore it.

**Actual cron / GitHub Actions scheduling wiring does not exist and is out of
scope** — to set up such a schedule a human would add a workflow (none exists
today) that invokes the command above. This note only documents the intended
invocation, not any plumbing.
