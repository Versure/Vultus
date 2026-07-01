# Documentation Drift Audit

- **Run timestamp (UTC):** 2026-07-01T13:28:49Z
- **Mode:** headless (forced via `--mode headless`)
- **Scope:** all

## Deterministic floor

`Deterministic floor: PASS`

- `pnpm nx test doc-integrity-test` — 3 test files, 67 tests passed (`lib-readme.spec.ts`, `plan-theme-hex.spec.ts`, `spec-status-ledger.spec.ts`).
- `node tools/scripts/gen-spec-status.mjs --check` — `docs\specs\STATUS.md is fresh (62 spec(s))`.

## Stale references

Type for this section: **descriptive / safe-to-fix**.

| doc location (file:line or section)              | claimed artifact                                               | kind   | verdict               | evidence                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------- | ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/PLAN.md` §3 (workspace tree, ~line 154)    | `docs/decisions/`                                              | path   | MISSING (HIGH)        | `docs/decisions/` does not exist anywhere in the repo (glob returns no matches).                                                                                                                                                                                                                                                                                                 |
| `docs/PLAN.md` §5 "Setup repo files" (~line 279) | `.github/ISSUE_TEMPLATE/feature.md`                            | path   | MISSING (HIGH)        | `.github/ISSUE_TEMPLATE/` does not exist (glob returns no matches).                                                                                                                                                                                                                                                                                                              |
| `docs/PLAN.md` §5 "Setup repo files" (~line 280) | `.github/ISSUE_TEMPLATE/bug.md`                                | path   | MISSING (HIGH)        | Same as above — the directory itself is absent.                                                                                                                                                                                                                                                                                                                                  |
| `docs/PLAN.md` §5 "Setup repo files" (~line 282) | `.github/ISSUE_TEMPLATE/chore.md`                              | path   | MISSING (HIGH)        | Same as above.                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/PLAN.md` §5 "Setup repo files" (~line 285) | `.github/PULL_REQUEST_TEMPLATE.md`                             | path   | MISSING (HIGH)        | Glob for `.github/PULL_REQUEST_TEMPLATE.md` returns no match.                                                                                                                                                                                                                                                                                                                    |
| `libs/mobile/notifications/README.md:32`         | `NotificationRow` (described as exported for cross-barrel use) | symbol | OK-but-moved (MEDIUM) | `NotificationRow` is defined in `notifications.service.ts` but is **not** re-exported from the lib's `index.ts` barrel; the one existing consumer (a test) imports it directly from the service file, not the barrel. The README's "exported only if a consumer/test needs it" phrasing is ambiguous rather than confirmed wrong, so this is reported as ambiguous, not missing. |

All other artifacts checked across `docs/PLAN.md`, `CLAUDE.md`, and the remaining 11 `libs/**/README.md` files (paths, symbols, Nx targets, CLI flags, config keys) verified cleanly and are not listed.

Note: the five `docs/PLAN.md` MISSING findings above all belong to the same obsolete issue-driven workflow described in PLAN §5 — see the narrative finding below, which is the root cause these paths were never created.

## PLAN narrative vs reality

Type for this section: **prescriptive / needs-a-decision**, severity **HIGH**.

**Finding:** `docs/PLAN.md` §5 "The agentic workflow" and §6 "Initial task breakdown" still describe the **GitHub-issue task-management model** — every task is a GitHub issue, `.github/ISSUE_TEMPLATE/` templates, PR "references issue", branch convention `feat/<issue-number>-<slug>` — as the live process. For example, PLAN §5 "Task management — issue-driven" states:

> Every task is a GitHub issue. The issue is the unit of work; the PR closes the issue.

and §6 opens with:

> These are the GitHub issues to create on day one.

**Higher authority that contradicts it:** `docs/specs/README.md` (top) states: "This **spec-file workflow supersedes the GitHub-issue task management described in `docs/PLAN.md` §5–§6`** — there are no GitHub issues; the spec file (reviewed and merged as a PR) is the unit of work." PLAN's own in-place "Superseded note (2026-06-16)" at `docs/PLAN.md:252-260` says the same thing.

**Why this is drift, reported confidently:** the finding **is the retained contradictory body content** — the obsolete issue-workflow prose remains **verbatim** in PLAN §5–§6 below the superseded note, not the absence of an annotation. The annotation exists but does not resolve the drift; the obsolete body (task management section, initial task breakdown as "GitHub issues", `.github/ISSUE_TEMPLATE/` and `PULL_REQUEST_TEMPLATE.md` setup instructions, `docs/decisions/` as an issue-comment alternative) is still there and is exactly why the five paths above were never created — the workflow they belong to was replaced before those setup steps ran. This is reported for a human or a follow-up spec to resolve (e.g. trim/rewrite PLAN §5–§6 to reference the spec workflow only); this audit does not rewrite PLAN.

## Summary

**By severity:**

- BLOCKER: 0
- HIGH: 6 (5 stale-reference MISSING findings + 1 PLAN-narrative-vs-reality finding)
- MEDIUM: 1 (1 stale-reference OK-but-moved finding)

**By type:**

- descriptive / safe-to-fix: 6 (5 MISSING + 1 OK-but-moved)
- prescriptive / needs-a-decision: 1

**Verdict: DRIFT FOUND**
