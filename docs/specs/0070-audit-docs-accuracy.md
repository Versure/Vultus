---
number: 0070
slug: audit-docs-accuracy
title: Fix the audit-docs skill — stale "must-detect" example and the phantom scheduled runner
status: done # draft | approved | implementing | done
slices: []
scopes: []
created: 2026-07-02
---

# Fix the audit-docs skill's accuracy

## Context

The `/audit-docs` skill (spec 0059) has two self-defeating issues that undermine the very
doc-health regime it polices:

1. **Stale "must be detected" worked example.** `audit-docs/CHECKLIST.md:99-125` instructs
   ("**must be detected**", "the expected entry against the current repo", "**Do not**
   second-guess") that PLAN §5-§6 still carries an "issue-driven" heading and the verbatim
   quote "Every task is a GitHub issue. The issue is the unit of work; the PR closes the
   issue." `SKILL.md:94-96` repeats it as "the expected entry against the current repo".
   But that drift was **already fixed** — `grep "Every task is a GitHub issue" docs/PLAN.md`
   returns nothing; PLAN §5 is now "Task management — spec-driven" (`PLAN.md:289-297`) and
   §6 is marked "Historical" (`PLAN.md:361`). An agent following the checklist verbatim is
   told to expect and confidently report drift whose quoted prose no longer exists — on the
   headless path that fabricates a `DRIFT FOUND` and a draft PR, the exact alert-fatigue the
   design says it avoids (`CHECKLIST.md:220-224`).
2. **Phantom scheduled runner.** `SKILL.md:23` describes a headless/scheduled path that
   "opens a draft PR with the report only when drift is found", but **nothing in
   `.github/` invokes it** (verified: no CI reference to audit-docs). The scheduled path is
   aspirational — the skill only runs on manual `/audit-docs`.

**Intended outcome.** Make the worked example historical (or replace it with a still-true
one) so scheduled runs don't manufacture false positives, and reconcile the scheduled-path
description with reality — either wire an actual scheduled workflow or reword the skill to
say invocation is manual.

## Scope

In scope:

- **`.claude/skills/audit-docs/CHECKLIST.md`** — (i) rewrite §3's worked example
  (`:99-125`) so it is a **historical illustration of the class** ("this specific drift was
  fixed on 2026-07-01; do not expect it against the current repo"), or replace it with a
  currently-true example — including neutralizing the "Report it confidently…" / "Do **not**
  second-guess" prose at `:118-125` that instructs asserting the removed drift; (ii) fix the
  **§4 Report-layout note at `:142-143`** ("The §3 canonical example is the expected entry
  against the current repo") which makes the identical false assertion; (iii) reconcile the
  **scheduled-routine language in §5 (`:164`, `:201-202`) and §6 "How to schedule this"
  (`:207-224`)** with reality per the resolved decision below. Never phrase an example as
  "must be detected" against a mutable repo state.
- **`.claude/skills/audit-docs/SKILL.md`** — reconcile the scheduled/headless language at
  the frontmatter `description:` (`:3`), `:23`, `:45`, and `:56`, and the `:94-96` example
  sentence, per the resolved decision below.

Out of scope:

- Changing the deterministic doc-integrity floor (spec 0058 tooling) — it verifies
  cleanly and is unaffected.
- The other stale-content fixes (PLAN §3 slices, Spark→Blaze, etc.) — those are spec 0067;
  this spec only fixes audit-docs' _own_ accuracy.

## Resolved decision (scheduled path): reword to manual, option (b)

The scheduled-path reconciliation is **resolved to option (b): reword, do not wire**.
Rationale: nothing in `.github/` invokes a skill headlessly today — only `daily-sync.yml`
uses a `schedule:` cron, and it calls an HTTP function, not a skill. Option (a) (adding
`.github/workflows/audit-docs.yml`) has an unverified precondition (headless skill
invocation in CI), and shipping a described-but-absent automation is exactly the drift
audit-docs exists to catch. So this spec does **not** add a workflow.

Concretely, reword the scheduled/headless language across the files above to state that
invocation is **manual** (`/audit-docs`), while **preserving** the draft-PR-on-drift
behavior as "when run headless" (the DRIFT-REPORT.md draft-PR lifecycle is a real, exercised
path — precedent #154/#155, memory `audit-docs-report-pr-lifecycle`); the reword must not
imply an existing scheduler, and must not delete the headless-report behavior itself. `§6
"How to schedule this"` becomes documentation of an _optional, not-yet-wired_ routine (or is
reframed as "to schedule this, add a workflow — none exists today"), not an implied active one.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). Skill markdown (+ optionally one workflow YAML),
outside the Nx/TS/Sheriff graph.

## Data model touchpoints

**None.**

## Public types / APIs

No types. Concrete required behavior:

- `CHECKLIST.md` §3's example no longer asserts the removed PLAN issue-workflow prose as a
  current expectation; it is framed as historical (with the fix date) or replaced by a
  live-true example. `SKILL.md:94-96` matches.
- `SKILL.md`'s scheduled/headless language (`:3`, `:23`, `:45`, `:56`) states manual
  invocation while preserving the "when run headless" draft-PR behavior; no `audit-docs.yml`
  is added.

## UI / Stitch screen refs

**Not applicable.**

## Implementation task graph

Route to **infrastructure-engineer**. Two files, disjoint manifests; no CI workflow is
added (decision resolved to reword). Both may run in parallel.

- **T1** — `.claude/skills/audit-docs/CHECKLIST.md`: rewrite §3 (`:99-125`, incl. the
  "report confidently / do not second-guess" prose at `:118-125`) to historical/true; fix
  the §4 note at `:142-143`; reframe §5 (`:164`, `:201-202`) and §6 "How to schedule this"
  (`:207-224`) as an optional, not-yet-wired routine.
- **T2** — `.claude/skills/audit-docs/SKILL.md`: reword the scheduled/headless language at
  `:3`, `:23`, `:45`, `:56` to manual invocation (preserving the "when run headless"
  draft-PR behavior), and align the `:94-96` example sentence with T1's §3 rewrite.

## Test plan

Prompt/docs change; no executable surface. `nx affected` shows no project.

- **Inspection:** no CHECKLIST/SKILL location still calls the §3 example "the expected entry
  against the current repo" (grep the phrase); no scheduled-routine language implies an
  existing scheduler; §6 reads as optional/not-yet-wired; the headless draft-PR behavior is
  preserved.
- **Sanity (primary gate):** a `/audit-docs` run against the current repo no longer emits
  the phantom PLAN §5-§6 finding — this directly exercises the bug.

## Definition of done

- [ ] Every "expected entry against the current repo" assertion is gone — §3 example
      (`:99-125`), the `:118-125` "report confidently/do not second-guess" prose, **and** the
      §4 note at `CHECKLIST.md:142-143` — reworded to historical/true; `SKILL.md:94-96` matches.
- [ ] Scheduled/headless language at `SKILL.md:3/23/45/56` and `CHECKLIST.md` §5-§6 states
      manual invocation and reframes §6 as optional/not-yet-wired, **without** deleting the
      "when run headless" draft-PR behavior; **no** `audit-docs.yml` is added.
- [ ] No doc-integrity-floor (spec 0058) change; no product-code change; `nx affected` empty.

## Risks

1. **Don't over-correct the example away entirely** — keep an illustrative example of the
   _class_ of drift audit-docs targets; just stop asserting a removed instance as current.
2. **Preserve the headless draft-PR behavior.** The reword removes the implication of an
   existing _scheduler_, not the DRIFT-REPORT.md draft-PR-on-drift path (exercised, memory
   `audit-docs-report-pr-lifecycle`). A reviewer rejects any reword that deletes the headless
   report behavior itself.
3. **No architecture/PLAN conflict** — skill-accuracy reword only; no CI addition, no
   doc-integrity-floor change.
