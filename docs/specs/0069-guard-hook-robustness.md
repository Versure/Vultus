---
number: 0069
slug: guard-hook-robustness
title: Harden the slice-edit guard hook — crash-safety, self-test, exemptions, and documented bypass
status: implementing # draft | approved | implementing | done
slices: []
scopes: []
created: 2026-07-02
---

# Harden the slice-edit guard hook

## Context

`.claude/hooks/guard-slice-edits.mjs` is the setup's one mechanical enforcement of the
orchestrator/subagent boundary. It **works** — verified live: a main-thread Write to a
`Vultus-worktrees/feat-*/libs/**/src/**` path is denied with the hook's message, and
the `command`+`args` exec-form and `agent_id` discriminator are documented, valid Claude
Code behavior. But the audit found robustness and coverage gaps around an otherwise-sound
core:

1. **`null` stdin crashes it.** `echo null | node guard-slice-edits.mjs` →
   `TypeError: Cannot read properties of null (reading 'agent_id')`, exit 1.
   `JSON.parse('null')` succeeds, so the `try/catch` (lines 43-47) doesn't cover it, and
   line 51 uses `input.agent_id` while line 53 uses `input?.tool_input` — inconsistent
   optional chaining. Violates the file's own fail-OPEN contract (lines 19-21).
2. **Zero self-test / observability.** Every failure mode (node missing, wrong path,
   hook-input schema drift, `agent_id` renamed) produces the same externally observable
   behavior as a legitimate allow: silence. A repo-wide grep for `guard-slice-edits`
   matches only `settings.json` — nothing exercises the hook. Since the hook exists
   _because_ prose rules failed once (its header cites spec 0047), a silently-broken
   guard is a real regression risk.
3. **Exemption list narrower than the orchestrator's ownership.** The hook exempts lib
   barrels, `apps/functions/src/main.ts`, and `apps/mobile/src/**/*.routes.ts`
   (lines 73-77), but `implement-feature/SKILL.md:37-41` makes the orchestrator the
   owner of "registration barrels and apps/\* route/export registration". Real
   registration files fall outside: `apps/mobile/src/app/app.config.ts` (Angular provider
   registration) and `apps/mobile/src/main.ts` (bootstrap). An orchestrator-owned edit to
   those is hook-denied → deadlock (dispatch a specialist for a file the skill says agents
   must not own, or a spurious `needs-human`).
4. **Matcher is `Edit|Write` only.** An orchestrator writing slice files via PowerShell
   `Set-Content`/heredoc (the mandated primary shell) or a Bash heredoc bypasses the guard
   entirely; the hole is documented nowhere (the header only discusses fail-open on parse
   surprises).
5. **`../Vultus-worktrees` not granted in settings.** The whole workflow operates in that
   sibling dir but `.claude/settings.json` has no directory grant for it — likely
   permission friction on the dir the workflow lives in. (Needs live confirmation of
   whether the harness auto-grants git-worktree paths; a grant is cheap insurance.)

**Intended outcome.** Keep the sound core; fix the crash, add a self-test so silent
breakage is caught, align the exemptions with the ownership matrix, and honestly document
the shell-write bypass.

## Scope

In scope:

- **`.claude/hooks/guard-slice-edits.mjs`** — item 1 (crash-safety + drop unused `relPath`
  param), item 3 (add `app.config.ts` + `apps/mobile/src/main.ts` to exemptions — **chosen
  resolution**, see below), item 4 (document the Edit|Write-only / shell-write bypass in the
  header).
- **`tools/scripts/guard-slice-edits.test.mjs`** (new) — item 2 (self-test). Placed in the
  existing `tools/scripts` Nx project (which already runs `.mjs` tests via `@nx/vitest:test`,
  e.g. `inject-mobile-env.test.mjs`), so it is picked up by the existing `nx affected -t test`
  CI gate with **no `ci.yml` surgery**. It spawns the hook at its `.claude/hooks/` absolute
  path via `child_process` and asserts on stdout/exit.
- **`.claude/settings.json`** — item 5 (add the `../Vultus-worktrees` directory grant).

Out of scope:

- Changing the fail-open philosophy (correct for a workflow-integrity, non-security
  guard) or the `agent_id` discriminator (verified correct).
- Extending the matcher to Bash/PowerShell with write-heuristics — documented as a known
  gap here; only build the heuristic if orchestrator shell-writes are actually observed.
- The item-3 **routing alternative** (routing `app.config.ts`/`main.ts` to frontend-engineer)
  is explicitly **not** taken — the exemption keeps the hook aligned with the orchestrator
  ownership matrix (see below) with a two-line regex change; the routing alternative would
  push orchestrator-owned wiring onto a specialist, inverting the skill's model.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). The hook is a `.claude/hooks/*` Node script outside
the Nx/TS/Sheriff graph; `tools/*` is intentionally not Sheriff-tagged (spec 0058), and the
new self-test lives in the existing `tools/scripts` Nx project alongside
`inject-mobile-env.test.mjs`.

## Data model touchpoints

**None.**

## Public types / APIs

No types. Concrete required behavior:

- **Item 1 (crash-safety):** the **preferred** fix is a post-parse object guard —
  immediately after `JSON.parse`, `if (typeof input !== 'object' || input === null) allow();`
  — which is more defensive than only patching line 51 (it protects every later non-`?.`
  access, present and future). Changing line 51 to `if (input?.agent_id) allow();` is the
  minimal alternative and is sufficient today (line 53 is already `?.`-guarded), but the
  post-parse guard is the chosen form. Acceptance: `echo null | node guard-slice-edits.mjs`
  exits 0 with empty stdout. Also remove the unused `relPath` first parameter of `deny()`.
- **Item 2 (self-test):** `tools/scripts/guard-slice-edits.test.mjs`, a Vitest `.mjs` test
  that spawns the hook (`child_process.execFileSync('node', [hookAbsPath], { input })`) and
  asserts: (a) orchestrator slice edit in a `feat-*` worktree → deny JSON containing
  `"permissionDecision":"deny"`, nonzero not required (the hook exits 0 on deny); (b) subagent
  edit (`agent_id` present) → empty stdout, exit 0; (c) `null` / `{}` / malformed stdin →
  empty stdout, exit 0 (the regression lock: reverting item 1 makes case (c) exit 1 with a
  stderr TypeError, failing the assertion); (d) each exemption class (lib `src/index.ts`,
  `apps/functions/src/main.ts`, a `*.routes.ts`, and the newly-added `app.config.ts` /
  `apps/mobile/src/main.ts`) → empty stdout, exit 0. Runs under the existing
  `nx affected -t test` gate — no `ci.yml` edit needed. Optionally have the hook append one
  line to a gitignored log on deny/parse-failure for diagnosability.
- **Item 3 (chosen: exemption):** add `apps/mobile/src/main.ts` and
  `apps/mobile/src/app/app.config.ts` to the `isExempt` regex. They are bootstrap/provider
  **wiring** in the same class as the already-exempt `*.routes.ts` and lib barrels, and
  implement-feature/SKILL.md:37-40 puts "apps/\* route/export registration" in orchestrator
  ownership — so exempting them keeps the hook and the ownership matrix aligned. The routing
  alternative is not taken (see Scope).
- **Item 4:** add to the hook header a note that the guard only fires on `Edit|Write`; an
  orchestrator writing slice files via shell — **PowerShell `Set-Content`/here-string or a
  Bash heredoc** — bypasses it. Out of scope by design, named so a reviewer doesn't assume
  coverage it lacks.
- **Item 5 (chosen: add the grant):** add the `../Vultus-worktrees` directory grant to
  `settings.json` (valid JSON, existing `hooks`/`permissions` preserved). It is cheap
  insurance for the directory the whole workflow operates in; an autonomous run cannot
  reliably self-confirm the harness's auto-grant behavior, so the grant is added
  unconditionally rather than left pending.

## UI / Stitch screen refs

**Not applicable.**

## Implementation task graph

Route to **feature-implementer** (the hook + its test) and **infrastructure-engineer**
(settings). Manifests are pairwise disjoint by file.

- **T1** — Manifest: `.claude/hooks/guard-slice-edits.mjs`. Items 1 (post-parse object
  guard + drop `relPath`), 3 (exempt `app.config.ts` + `apps/mobile/src/main.ts`), 4 (header
  bypass note).
- **T2 [sequential after T1]** — Manifest: `tools/scripts/guard-slice-edits.test.mjs`
  (new; `tools/scripts/project.json` already provides the `@nx/vitest:test` target, so no new
  target and no `ci.yml`/`lint-staged` edit is required — confirm the glob picks up the new
  file). Item 2. Must go green against the T1 hook and fail if the item-1 guard is reverted.
- **T3** — Manifest: `.claude/settings.json`. Item 5 (`../Vultus-worktrees` grant), valid JSON.

## Test plan

- **Self-test (Vitest, new):** the fixture-payload matrix above, in
  `tools/scripts/guard-slice-edits.test.mjs`, run under the existing `nx affected -t test`
  gate (`pnpm nx test scripts`). This is the primary gate and the finding's core remedy.
- **Regression proof:** case (c) asserts `null` stdin → exit 0 + empty stdout; reverting the
  item-1 guard makes it exit 1 (TypeError), failing the test — the crash-safety is locked in.
- **Inspection:** exemptions include `app.config.ts` + `apps/mobile/src/main.ts`; header
  documents the shell-write bypass (PowerShell + Bash); `settings.json` valid JSON with the
  worktree grant.

## Definition of done

- [ ] A post-parse object guard makes `null`/malformed stdin fail open (exit 0, no output);
      unused `relPath` param removed.
- [ ] `tools/scripts/guard-slice-edits.test.mjs` exercises deny/allow/exemption/crash cases,
      runs under `nx affected -t test` (no `ci.yml` edit), and fails if the item-1 guard is
      reverted.
- [ ] `app.config.ts` + `apps/mobile/src/main.ts` are added to the hook's exemption regex
      (the routing alternative is not taken).
- [ ] The hook header documents the Edit|Write-only shell-write bypass (PowerShell + Bash).
- [ ] `../Vultus-worktrees` grant added to `settings.json`; file remains valid JSON.
- [ ] No product-slice/type/UI/Firestore change; `nx affected` covers only the new test.

## Risks

1. **Preserve fail-open + the working core.** The `agent_id` branch and path/exemption
   regex are verified correct; changes must not alter deny behavior for the confirmed
   cases (keep the live-tested matrix passing).
2. **Item 5 is conditional** — only add the directory grant if worktree ops actually
   prompt/fail; an unnecessary broad grant is its own risk. Confirm first.
3. **Self-test must run somewhere that fails the build** — a test nobody runs reproduces
   the exact invisibility this spec fixes. CI is the floor; lint-staged is a bonus.
4. **No architecture/PLAN conflict** — hook/CI/settings hardening only.
