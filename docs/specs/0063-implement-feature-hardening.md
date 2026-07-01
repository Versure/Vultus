---
number: 0063
slug: implement-feature-hardening
title: Harden the implement-feature workflow against observed friction (specs 0060/0062)
status: implementing
slices: []
scopes: []
created: 2026-07-01
---

# Harden the implement-feature workflow against observed friction (specs 0060/0062)

## Context

Two real `/implement-feature` runs surfaced recurring, avoidable friction that
cost round-trips and manual intervention. The friction logs are recorded in
GitHub issues:

- **#153** (spec 0062 — Android WebView cutout background run).
- **#157** (spec 0060 — provider-catalog / shared-`User` widening run).

The problems cluster into eight groups (A–H). None is an application, lib,
Firestore, or UI defect — every one is a gap or ambiguity in the **orchestration
prompt files** (`.claude/skills/**`, `.claude/agents/**`), the standing
conventions (`CLAUDE.md`), or the permission config (`.claude/settings.json`).
Left unfixed they recur on every feature run: a stale `STATUS.md` ledger fails
the pre-commit hook and CI three times per run (A), the feature-reviewer returns
a bogus `NEEDS_REWORK` on an empty diff (B), the cold pre-commit hook is
SIGKILLed by the default Bash timeout (C), the worktree seed copy is denied by
the permission classifier which then poisons later benign actions (D), Windows
`cap`/CRLF/cwd friction stalls the run (E), a DoD requirement in no task manifest
and a widened shared-type ripple both escape until final reconciliation (F), and
spec-vs-implementation PR ambiguity forces a manual verification at the next
session (H). Group G is a set of harness-level behaviors that cannot be fixed
in-repo but must be **documented** so future runs plan around them.

**Intended outcome.** Turn every deterministic lesson from #153/#157 into an
explicit, checkable instruction in the relevant prompt/config file, so the next
`/implement-feature` run does not re-hit them. Where a lesson is genuinely
harness-level (the auto-mode permission classifier's LLM judgment and its
"poisoning"; async Agent dispatch; Bash cwd reset), **document it honestly** as a
known behavior rather than overclaiming a fix.

This is a **pure tooling / prompt-file + config change** in the same family as
spec 0040 (`0040-seed-worktree-local-files.md`). It edits only `.claude/**`
prompt files, `CLAUDE.md`, and `.claude/settings.json`. No application code, no
libs, no Firestore schema, no UI, no Nx target, and no Sheriff tag are touched.
`nx affected` shows nothing (expected) and verification is **by inspection** per
changed file.

## Scope

In scope — the following files, each edited per the group(s) noted:

- **`.claude/skills/implement-feature/SKILL.md`** — groups A, B, C, D (skill
  fallback), E1, E2, F1, F2, G, H.
- **`.claude/skills/create-spec/SKILL.md`** — group F (interview must surface
  DoD→task-graph coverage, shared-type repo-wide ripple, and exact-string test
  assertions).
- **`.claude/agents/spec-author.md`** — group F (author-time rigor).
- **`.claude/agents/spec-reviewer.md`** — group F (blocking review checks).
- **`.claude/agents/feature-reviewer.md`** — groups B (uncommitted-diff guard)
  and F3 (whitespace-normalized rendered-text assertion smell).
- **`.claude/agents/qa-runner.md`** — groups C (cold-worktree timeouts) and E1
  (`cap sync` needs a prior web build; pnpm `cap` binary).
- **`CLAUDE.md`** — group D (secrets-rule clarification), C (cold-hook timeout
  note), E1/E2/E3 (Windows conventions).
- **`.claude/settings.json`** — group D (best-effort scoped permission allow
  entry for the seed copy). Must remain valid JSON.
- **`.claude/agents/infrastructure-engineer.md`** — group E1 (`cap sync` recipe,
  native Capacitor territory) and E2 (prettier-normalize note), minimal.
- **`.claude/agents/frontend-engineer.md`** and
  **`.claude/agents/backend-engineer.md`** — group E2 (prettier-normalize note),
  one line each, only if the E2 guidance is not fully covered by
  implement-feature. Keep minimal.

Out of scope:

- **Any application, lib, function, type, UI, or Firestore-schema change.** This
  spec changes prompt/config files only.
- **Any Nx target, `project.json`, `inject-mobile-env.mjs`, Gradle, Capacitor
  config, CI workflow, or `.gitignore` change.**
- **`.gitattributes` repo-wide renormalization.** Group E2's CRLF fix is a
  per-file `prettier --write` **normalize step in the workflow**, not a
  `.gitattributes` change. The existing `.gitattributes` deliberately pins only
  `*.gradle` and `/docs/specs/STATUS.md` to LF and explicitly avoids repo-wide
  renormalization — that comment stands unchanged.
- **Fixing the auto-mode permission classifier or the async Agent dispatch
  model.** These are harness-level (group G) and are **documented**, not
  changed — the in-repo levers (CLAUDE.md wording, settings allowlist,
  skip-and-warn fallback) are best-effort mitigations, stated as such.
- **Weakening the real secret prohibition.** The group D CLAUDE.md reword
  preserves "never expose secret VALUES"; it only carves out the opaque
  file-to-file seed copy already sanctioned by spec 0040.
- **`tools/scripts/gen-spec-status.mjs`** — the generator (spec 0058) is not
  changed; group A only invokes it more disciplinedly from the skill.

## Affected slices & Sheriff tags

**No slice and no scope is built** (`slices: []`, `scopes: []`). Every changed
file is a **skill prompt / agent prompt / standing-instruction markdown** or a
**JSON config file** — none is a workspace TS/Nx project, app, or lib.

- **Sheriff / module boundaries do not apply.** Sheriff governs imports between
  Nx/TS projects; these files are outside the Nx project graph entirely. No
  TypeScript import (cross-slice or otherwise) is added.
- **No lib is touched**, so no lib `README.md` currency rule (CLAUDE.md) applies.
- **No DRY / 3+-slice question arises** — no shared TS logic is added.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected). Group A invokes the `STATUS.md` **ledger
generator** and group D references the seeded **config/secret files**, but these
are docs/config artifacts — no schema, document, or rule is created, read, or
changed.

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes. The only changes are the natural-language behavior of the listed prompt
files and one JSON permission entry. The concrete, checkable behavior per group
is specified below (this is the contract an implementer follows and a reviewer
verifies by inspection).

### Group A — main-sync & STATUS.md staleness (issues #153-1, #153-4, #157-8)

**Root cause.** The worktree branches off `main` at Step 2; `main` advances
during the run; the committed `docs/specs/STATUS.md` ledger (generated by
`tools/scripts/gen-spec-status.mjs`, spec 0058) goes stale relative to a fresh
render, failing (a) the local pre-commit hook (`gen-spec-status.mjs --check`)
every time a `docs/specs/*.md` file is committed, and (b) CI's
`doc-integrity-test` freshness guard. Separately, clicking GitHub's "Update
branch" button adds a `Merge branch 'main'` commit to the **remote** branch that
the local worktree lacks, so the next local push is rejected non-fast-forward.

**Fix — `implement-feature/SKILL.md`:**

1. **Regenerate + stage the ledger on every status flip.** Whenever the skill
   changes a spec's `status:` — Step 2 (`approved → implementing`) and Step 7
   (`→ done`) — it must immediately run
   `node tools/scripts/gen-spec-status.mjs` **in the worktree** and stage the
   regenerated `docs/specs/STATUS.md` **in the same commit** as the status change.
   This removes the manual regenerate-and-recommit loop that recurred 3× in
   #153-4 (the pre-commit hook's `--check` otherwise fails the commit).
2. **Sync-with-main before opening the PR.** Add a new substep at the top of
   Step 7, **before** the commit/push: `git -C $wt fetch origin main`, then
   `git -C $wt merge origin/main` into the feature branch (**merge, not rebase** —
   the PR is squash-merged so a merge commit is harmless, and merge cleanly
   absorbs the "Update branch" divergence). Resolve any `STATUS.md` conflict by
   **regenerating** (`node tools/scripts/gen-spec-status.mjs`) and staging the
   regenerated file, not by hand-editing the ledger.
3. **Reconcile with the remote head before pushing.** In Step 7, before
   `git push`, if the PR already exists, run
   `gh pr view <pr> --json headRefOid` and compare to the local `HEAD`; if the
   remote is ahead (someone clicked "Update branch"),
   `git -C $wt fetch origin feat/NNNN-slug` and merge/fast-forward the remote
   branch into local **before** pushing, so the push is never rejected
   non-fast-forward. This substep applies **only on a re-push into an existing
   PR** (a `/rework-feature` or resumed run) — on the initial `gh pr create`
   there is no PR yet, so it is a **no-op** (skip it). Cross-reference the
   standing memory items
   `spec-status-ledger-ci-race` and `audit-docs-report-pr-lifecycle`
   (same ledger-staleness family) in a one-line note.
4. **Step 8 (pipeline watch):** add a note that a `STATUS.md` **freshness**
   failure in CI is treated as "regenerate the ledger + push," **not** as a code
   failure requiring a specialist fix.

### Group B — commit-before-review ordering (issue #153-7)

**Root cause.** `feature-reviewer` computes `git -C $wt diff main...HEAD`; the
implementer subagents leave changes in the **working tree** uncommitted, so the
diff is empty and the reviewer returns a bogus blocking `NEEDS_REWORK`.

**Fix — `implement-feature/SKILL.md`:** the **orchestrator commits at fan-in**,
before dispatching feature-reviewer. Add to Step 4 (fan-in) an explicit substep:
after reconciling each agent's reported file list against its manifest, **commit
all implemented work** (a WIP commit is fine — it is squash-merged), so
`main...HEAD` reflects the changes. State it as an explicit **precondition of
Step 5**: "feature-reviewer must run against a committed diff; if the working
tree is dirty, commit first." Implementer subagents do **not** self-commit (they
would race the git index in a shared worktree) — the note must say so.

**Fix — `feature-reviewer.md`:** add a guard in the "Inputs" / review flow — if
`git diff main...HEAD` is empty **but** the working tree is dirty
(`git status --porcelain` non-empty), report that as
`"changes uncommitted — orchestrator must commit before review"` (a process
note), **not** as a `NEEDS_REWORK` verdict. This prevents the false-negative even
if the ordering slips.

### Group C — pre-commit hook cold-start exceeds tool timeouts (issues #153-5, #157-9)

**Root cause.** husky + lint-staged (eslint `--fix`, prettier `--write`,
`gen-spec-status --check`) on a **cold** worktree takes far longer than the
default 2-min Bash timeout, so the `git commit` Bash call is SIGKILLed
(exit 143) mid-hook; lint-staged's stash-revert may be mid-flight, leaving the
tree needing re-verification. A subagent's `pnpm nx lint` similarly blew its
3-min timeout.

**Fix — `implement-feature/SKILL.md`:** on the **first commit of a fresh
worktree** (cold hook), run `git commit` with a long timeout
(600000 ms — the Bash tool's **maximum**, so use that value, not a longer one);
prefer `run_in_background: true` for that first commit (backgrounding sidesteps
the ceiling entirely when the hook may run past 10 min).
Add a note on the lint-staged stash-revert behavior on kill and a **recovery
check** before retrying: inspect `git status --short` and `git stash list`, and
if lint-staged left a stash, restore it before re-committing.

**Fix — `qa-runner.md`:** in the Gates / Degradation guidance, raise the timeout
for the `nx affected -t typecheck | lint | test | build` gates on a **cold
worktree (first run)** — use the tool's long/max timeout — and state that a
**timeout is NOT a gate `FAIL`**: report it as
`"could-not-complete — re-run with a longer timeout"`, distinct from a real
failure.

**Fix — `CLAUDE.md` (Commands & DoD section):** a one-line note that the
pre-commit hook (husky + lint-staged) is **slow on cold start** and that commits
in a **fresh worktree** should use a long timeout (and may be backgrounded).

### Group D — secret-seeding blocked by the permission classifier (issues #153-2, #157-1, #157-2)

**Root cause.** Spec 0040's Step-2 seed copies `.env.local`,
`environment.generated.ts`, and `google-services.json` into the worktree as an
**opaque copy**. The auto-mode permission classifier denies it as "Credential
Leakage," explicitly quoting the CLAUDE.md rule "never read or write
`.env.local` or any secret," and then **poisons** later unrelated actions
(e.g. a markdown `Edit`) by citing the earlier `.env.local` attempt.

**Fix — `CLAUDE.md` (Conventions → Secrets bullet), reword to preserve the real
prohibition while carving out the opaque copy.** Replace the current wording
("never read or write `.env.local` or any secret") with wording equivalent to:

> **Secrets:** never **read, print, log, echo, or commit** the **contents** of
> `.env.local` or any secret. Note: the `implement-feature` worktree seed
> (spec 0040) **copies** `.env.local` and `google-services.json` as **opaque
> files** between two local checkouts on the same machine — a file-to-file copy
> is **not** reading a secret and is explicitly permitted. The prohibition is on
> exposing secret **VALUES**. Secrets live in `.env.local` (gitignored), GitHub
> Actions secrets, and Firebase functions config. Flag if a secret would be
> needed somewhere it shouldn't be.

The reword must keep the "never expose secret values" intent intact and stay
consistent with spec 0040's Risks §1. It must **not** delete the "flag if a
secret would be needed somewhere it shouldn't be" clause.

**Fix — `.claude/settings.json` — add a best-effort scoped `permissions.allow`
entry** so the deterministic allowlist pre-authorizes the seed copy before it
reaches the classifier. The file currently has only a `hooks` block; the
implementer adds a sibling `permissions` object with an `allow` array, keeping
the file **valid JSON**. Recommended entry shape (the implementer may adjust the
matcher to the harness's actual matching semantics, but must keep it **narrow**):

```json
{
  "hooks": { "...": "unchanged" },
  "permissions": {
    "allow": [
      "Bash(*Copy-Item*google-services.json*)",
      "Bash(*Copy-Item*.env.local*)",
      "Bash(*Copy-Item*environment.generated.ts*)"
    ]
  }
}
```

State **in the spec and in the DoD** that this is **best-effort**: the seed runs
as a multi-line PowerShell `Copy-Item` invoked via the shell tool, which is hard
to match with one narrow pattern, and the auto-mode LLM classifier sits **above**
the allowlist — so this may not fully suppress the denial. Do **not** broaden the
allowlist to a dangerously general pattern (e.g. bare `Bash(*)`).

**Fix — `implement-feature/SKILL.md` fallback (make explicit).** The existing
Step-2 seed already treats a failed copy as **skip-and-warn** (spec 0040). Add a
sentence that:

- a **blocked/denied** seed copy is the same as a missing source — skip, warn,
  surface in Step 9's report, never abort; and
- the mock / emulator / typecheck / lint / test / build / e2e paths do **not**
  need `.env.local` (only `serve-prod-debug` / `serve-prod` / `android-usb`
  do), so a blocked seed is **not** a blocker for the DoD gates — it only blocks
  on-device / real-prod manual testing. If the classifier persistently blocks
  the copy, surface to the user the **manual fallback**: run the three copies
  once in their own terminal.

**Honest residual risk (see Risks §1):** the deterministic parts (CLAUDE.md
wording, allowlist entry, skip-and-warn fallback) are in-repo; the classifier's
LLM judgment and its poisoning are **harness-level** and only **documented**
(group G), not fixed.

### Group E — Windows friction (issues #153-3, #153-6, #157-4)

**E1 — `cap` fails in a fresh pnpm worktree (#153-3).**
`implement-feature/SKILL.md` (E-note), `qa-runner.md`, and
`infrastructure-engineer.md` (native Capacitor territory) get guidance:

- use `pnpm exec cap sync android` (not `npx cap …` — `npx` can't resolve the
  `cap` binary in the pnpm workspace); and
- `cap sync`'s copy step aborts without a prior web build ("Could not find the
  web assets directory: `dist/apps/mobile/browser`") — so when a spec's DoD
  requires `cap sync`, run **`pnpm nx build mobile` first**, then
  `pnpm exec cap sync android` (or `pnpm exec cap copy android`, which
  serializes `capacitor.config.ts` regardless of web-asset contents).

One line in `CLAUDE.md` Commands is acceptable.

**E2 — the Edit tool writes CRLF, tripping Prettier `endOfLine: lf` (#153-6).**
`implement-feature/SKILL.md` (and, minimally, the implementer agents'
guidance — infrastructure/frontend/backend): after `Edit`/`Write` on a source
file on Windows, run `pnpm exec prettier --write <changed files>` **before
staging**, so a phantom CRLF diff doesn't fail `prettier --check`. Keep it to
**only the changed files** — no whole-file EOL churn, and **no** repo-wide
`.gitattributes` renormalization.

**E3 — Bash cwd resets between calls on Windows (#157-4).** Documented behavior
(also in group G): the shell cwd is reset to the primary checkout between Bash
calls in this environment. Reinforce the **existing** CLAUDE.md preference —
always use **absolute paths** / `git -C $wt` / `cd $wt && …` in the same call;
never rely on a persisted cwd. This is a documentation reinforcement, not a code
fix.

### Group F — spec-authoring & review rigor (issues #157-5, #157-6, #157-7)

**F1 — a DoD requirement was in no task's manifest (#157-5).** Spec 0060's DoD
required a `provider-catalog/{region}` `firestore.rules` rule + rules-test, but
none of the T1–T9 task manifests listed `firestore.rules`; discovered only at
final reconciliation.

- `spec-author.md`: every DoD checkbox MUST map to at least one task in the task
  graph; before finishing, cross-check **DoD ⇄ task manifests** and add a task
  (or add the file to a manifest) for any orphan requirement — especially
  `firestore.rules`, `firestore.indexes.json`, and rules-tests.
- `spec-reviewer.md`: add a **blocking** check — "every DoD item is covered by a
  task/manifest; flag any DoD requirement (rules, indexes, tests, config) not
  present in any task's file manifest."
- `implement-feature/SKILL.md`: add a **"DoD ⇄ task-manifest reconciliation"
  pre-flight** in Step 3 (before fan-out) — the orchestrator lists the DoD
  requirements and asserts each maps to a task; any orphan becomes a
  **foundation task**. (Belt to spec-reviewer's suspenders.)

**F2 — widening a required field on a shared type broke an unlisted slice
(#157-6).** Spec 0060 made `myProviderIds: number[]` **required** on the shared
`User` type; a `User` object literal in `mobile-onboarding` (not in the spec's
"Affected slices") broke app-wide typecheck, caught only because a T5 agent
proactively ran a workspace-wide typecheck.

- `spec-author.md`: when a spec change makes a `shared/domain` field **required**
  (or otherwise breaks existing consumers), enumerate **all** consumers repo-wide
  (grep for the type / object literals) and list **every** affected slice in
  "Affected slices" — not just the obviously related ones. Widening a required
  field is a repo-wide ripple.
- `spec-reviewer.md`: flag a shared-type change whose "Affected slices" omits a
  discoverable consumer.
- `implement-feature/SKILL.md`: after **any** `shared/domain` foundation change
  (Step 4 foundation), the orchestrator runs a **workspace-wide** typecheck
  (`pnpm nx run-many -t typecheck`, or affected with the shared lib as base) —
  **not** just per-task typechecks — because a widened required field breaks
  consumers outside every task's scope.

**F3 — whitespace-normalized test assertion hid a rendered-text bug (#157-7).**
`watchlist.page.spec.ts` normalized rendered text with
`.replace(/\s+/g,' ').trim()` before asserting, masking a stray-space bug
(`" On Netflix "`) that the e2e's exact-match (`toHaveText(/^On Netflix$/)`)
later caught.

- `create-spec/SKILL.md` (interview note) + `spec-author.md`: Test-plan guidance
  — component/unit assertions on **rendered UI text** should assert the **exact
  string**, not a whitespace-normalized one that can mask rendering defects; keep
  component and e2e assertions **consistent** on the same text.
- `feature-reviewer.md`: flag a component/unit test that **normalizes
  whitespace** on a rendered-text assertion (a likely masked-defect smell), and
  flag **component-vs-e2e assertion divergence** on the same text.

### Group G — harness-only behaviors (document, don't fix) (issues #157-3, plus D-poisoning, E3)

Add a short **"Known environment behaviors"** section to
`implement-feature/SKILL.md` (near the top, after "Conventions" or "Concurrency
model") so future runs aren't surprised. Purely documentation — these are
harness-level and cannot be fixed in-repo:

- **Agent tool runs async here.** With `run_in_background` omitted the Agent tool
  still returns immediately ("Async agent launched") with an `agentId`;
  completion arrives later as a `<task-notification>`. The orchestrator should
  **dispatch, then await notifications** (using `ScheduleWakeup` to resume) — not
  expect an inline synchronous result. (#157-3 needed ~15 wakeups.)
- **Bash cwd resets** to the primary checkout between calls (E3) — always use
  absolute paths / `-C $wt`.
- **Permission-classifier "poisoning"** (D): a denial can be cited against later
  unrelated actions; retry via a **different tool path** (e.g. a different
  invocation shape) and, if still blocked, surface to the user.

State plainly these are observations of the **current** harness, may change, and
are recorded so the orchestrator plans around them.

### Group H — spec-vs-implementation PR naming ambiguity (issue #153-8, minor)

The squash-merge commit of spec PR #150 ("spec 0062: fix Android WebView…") read
like an **implementation** commit though its diff was the spec markdown only,
forcing a `git show <sha> --stat` at the next session's start.

- `implement-feature/SKILL.md` Step 1: when selecting a spec, add a **one-line
  guard** — verify the spec is only **approved**, not already implemented, by
  confirming its merge landed a **spec-file-only diff** (e.g. `git show` shows
  only `docs/specs/NNNN-*.md`) before proceeding.
- Optionally note a **commit-subject convention** distinguishing spec PRs from
  feature PRs (e.g. `docs(spec 00NN): …` vs `feat(00NN): …`) — a small guard,
  not a rename effort. Do not overbuild.

## UI / Stitch screen refs

**Not applicable.** No mobile UI is built or changed; this spec edits
orchestration prompt/config files only. There is no Stitch screen to fetch and
no `--vultus-*` design token added or transcribed.

## Implementation task graph

Every task edits a **distinct file** (or, for E2's minimal one-liners, a small
set of distinct agent files), so the file manifests are naturally disjoint.
**Tasks that touch the same file are `[sequential]`** — in particular
`implement-feature/SKILL.md` is touched by many groups, so all of its edits are
folded into **one** sequential task (T1) to avoid two agents racing the same
file. Independent files run **`[parallel]`** with per-file manifests. All tasks
are **orchestration-tooling** edits — the natural territory of the
**infrastructure-engineer** (per spec 0040's task-graph note); route each task
there.

### T1 — [sequential] `implement-feature/SKILL.md` (groups A, B, C, D-fallback, E1, E2, F1, F2, G, H)

Manifest: `.claude/skills/implement-feature/SKILL.md`

This single file carries the most edits; do it first and in one pass so the
group edits don't collide. Apply, by step:

- **Step 1:** add the group **H** spec-file-only-diff guard.
- **Step 2:** add group **A.1** (regenerate + stage `STATUS.md` on the
  `approved → implementing` flip, same commit) and group **D-fallback** (a
  blocked seed copy = skip-and-warn, not a blocker for DoD gates; manual
  fallback note).
- **Step 3:** add the group **F1** "DoD ⇄ task-manifest reconciliation"
  pre-flight (orphan DoD requirement → foundation task).
- **Step 4:** add group **B** (orchestrator commits at fan-in; implementers do
  not self-commit; committed diff is a precondition of Step 5), group **F2**
  (workspace-wide typecheck after any `shared/domain` foundation change), group
  **C** (first cold-worktree commit uses a long/backgrounded timeout + stash
  recovery check), and group **E2** (prettier `--write` changed files before
  staging).
- **Step 7:** add group **A.1** again for the `→ done` flip, plus **A.2**
  (`fetch`/`merge origin/main` before commit/push, regenerate `STATUS.md` on
  conflict) and **A.3** (reconcile `gh pr view --json headRefOid` vs local HEAD
  before push).
- **Step 8:** add group **A.4** (a `STATUS.md` freshness CI failure → regenerate
  - push, not a code fix).
- **New "Known environment behaviors" section** (group **G**): async Agent
  dispatch, Bash cwd reset, classifier poisoning.
- Add a compact group **E1** note (build web before `pnpm exec cap sync`).

### T2 — [parallel] `create-spec/SKILL.md` (group F)

Manifest: `.claude/skills/create-spec/SKILL.md`

In Step 1 (Interview): add interview probes so the decision record surfaces
(F1) DoD → task-graph coverage, (F2) shared-type repo-wide ripple / all affected
slices, and (F3) exact-string rendered-text assertions kept consistent with e2e.

### T3 — [parallel] `spec-author.md` (group F)

Manifest: `.claude/agents/spec-author.md`

Add: DoD ⇄ task-manifest cross-check before finishing (F1); enumerate all
repo-wide consumers and list every affected slice when widening a required
`shared/domain` field (F2); Test-plan guidance to assert exact rendered strings
(F3).

### T4 — [parallel] `spec-reviewer.md` (group F)

Manifest: `.claude/agents/spec-reviewer.md`

Add blocking checks: every DoD item covered by a task/manifest (F1); a
shared-type change whose "Affected slices" omits a discoverable consumer (F2).

### T5 — [parallel] `feature-reviewer.md` (groups B, F3)

Manifest: `.claude/agents/feature-reviewer.md`

Add: the empty-diff-but-dirty-tree guard → process note, not `NEEDS_REWORK` (B);
flag whitespace-normalized rendered-text assertions and component-vs-e2e
divergence (F3).

### T6 — [parallel] `qa-runner.md` (groups C, E1)

Manifest: `.claude/agents/qa-runner.md`

Add: cold-worktree long timeouts for typecheck/lint/test/build and
"timeout ≠ FAIL" (C); `pnpm exec cap` + build-web-first `cap sync` guidance (E1).

### T7 — [parallel] `CLAUDE.md` (groups D, C, E1, E2, E3)

Manifest: `CLAUDE.md`

Reword the Secrets bullet (D, preserving the real prohibition); add the cold-hook
long-timeout note in Commands (C); add one-line Windows notes for `pnpm exec cap`

- build-first (E1), prettier-normalize changed files (E2), and reinforce
  absolute-paths / no-persisted-cwd (E3).

### T8 — [parallel] `.claude/settings.json` (group D)

Manifest: `.claude/settings.json`

Add a `permissions.allow` array with the narrow seed-copy matchers alongside the
existing `hooks` block. **File must remain valid JSON** (parse-check gate).

### T9 — [parallel] `infrastructure-engineer.md`, `frontend-engineer.md`, `backend-engineer.md` (group E)

Manifest: `.claude/agents/infrastructure-engineer.md`,
`.claude/agents/frontend-engineer.md`, `.claude/agents/backend-engineer.md`

Add minimal E-notes: `cap sync` recipe (build web first, `pnpm exec cap`) to
infrastructure-engineer (E1); prettier-normalize-changed-files-before-staging
one-liner to all three (E2). Note: T1 covers E2 only for the **orchestrator's own
edits** in `implement-feature/SKILL.md` — these are **different files** (the
implementer agent prompts), so the agent-file E2 notes are **always added** here;
there is no overlap to dedupe against. Keep each to a line or two.

> All nine manifests are pairwise disjoint. T2–T9 may run in parallel; T1 has no
> shared file with any other task, so it may also run concurrently, but is listed
> first because it is the largest and highest-value change. If an implementer
> prefers, T1 can run alone first, then T2–T9 fan out.

## Test plan

Per the PLAN §5 pyramid, **honest**: this is a `.claude/**` / `CLAUDE.md` /
`.claude/settings.json` markdown-and-JSON change with **no executable workspace
code**, so there is **no automated test surface**.

- **Unit (Vitest):** **none** — no TS/JS logic is added or changed. There is
  nothing to import, spy on, or assert.
- **Component tests:** **none** — no UI / slice component is added or changed.
- **e2e tests:** **No e2e flows required — tooling / prompt / config change
  only.** Per the PLAN §5 e2e rubric this introduces **no user-facing app
  change, no new navigation route, and no new action**; the web build is
  byte-for-byte unchanged. Stated explicitly so the omission is intentional. No
  existing flow is touched or un-skipped.
- **Automated gate (workspace):**
  `nx affected -t typecheck lint test build --base=main` will show **no affected
  project** (no workspace file changed); expected and acceptable — these files
  are outside the Nx graph.
- **JSON validity gate (`.claude/settings.json`):** after the group D edit, the
  file **must parse as valid JSON**. A fair CI/local gate is
  `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`
  exiting 0, and the existing `hooks` block preserved unchanged.
- **Verification by inspection (the real gate for prompt/config edits):** confirm
  each changed file contains the specified behavior, one assertion per group:
  1. **A** — `implement-feature/SKILL.md` Step 2 & Step 7 regenerate + stage
     `STATUS.md` on each status flip; Step 7 has a `fetch`/`merge origin/main`
     substep before push; Step 7 reconciles `gh pr view --json headRefOid`
     before push; Step 8 treats a freshness failure as regenerate-not-fix.
  2. **B** — `implement-feature/SKILL.md` Step 4 commits at fan-in (implementers
     don't self-commit) as a Step 5 precondition; `feature-reviewer.md` returns a
     process note (not `NEEDS_REWORK`) for empty-diff-but-dirty-tree.
  3. **C** — `implement-feature/SKILL.md` first cold commit uses a long/
     backgrounded timeout + stash-recovery check; `qa-runner.md` raises
     cold-worktree gate timeouts and states "timeout ≠ FAIL"; `CLAUDE.md`
     Commands has the cold-hook note.
  4. **D** — `CLAUDE.md` Secrets bullet reworded to carve out the opaque seed
     copy **while retaining** "never expose secret values" and the
     "flag if a secret would be needed" clause; `.claude/settings.json` has a
     **narrow** `permissions.allow` seed-copy entry and is valid JSON;
     `implement-feature/SKILL.md` states a blocked seed is skip-and-warn / not a
     DoD blocker with a manual fallback; residual risk documented (G).
  5. **E** — `pnpm exec cap` + build-web-first guidance present in
     `implement-feature/SKILL.md`, `qa-runner.md`, and
     `infrastructure-engineer.md` (E1); prettier-normalize-changed-files note in
     `implement-feature/SKILL.md` and the implementer agents (E2); no
     `.gitattributes` change; absolute-path / no-persisted-cwd reinforcement in
     `CLAUDE.md` and the G section (E3).
  6. **F** — F1 checks present in `spec-author.md`, `spec-reviewer.md` (blocking),
     `implement-feature/SKILL.md` Step 3, and `create-spec/SKILL.md`; F2 checks
     present in `spec-author.md`, `spec-reviewer.md`, `implement-feature/SKILL.md`
     Step 4 (workspace-wide typecheck); F3 guidance in `create-spec/SKILL.md`,
     `spec-author.md`, and `feature-reviewer.md`.
  7. **G** — `implement-feature/SKILL.md` has a "Known environment behaviors"
     section covering async Agent dispatch, Bash cwd reset, and classifier
     poisoning, framed as current-harness observations.
  8. **H** — `implement-feature/SKILL.md` Step 1 has the spec-file-only-diff
     guard.

## Definition of done

Tailored from the PLAN §5 checklist. There is no affected workspace TS project;
the affected artifacts are prompt/config files.

- [ ] **A** — `implement-feature/SKILL.md` regenerates + stages `STATUS.md` on
      every status flip and merges `origin/main` (regenerating on conflict) and
      reconciles the remote head before pushing; Step 8 treats a freshness
      failure as regenerate-not-fix.
- [ ] **B** — the orchestrator commits at fan-in (Step 4) as a precondition of
      Step 5, and `feature-reviewer.md` no longer returns `NEEDS_REWORK` for an
      empty diff over a dirty tree.
- [ ] **C** — first cold-worktree commit uses a long/backgrounded timeout with a
      stash-recovery check; `qa-runner.md` raises cold-worktree gate timeouts and
      states a timeout is not a `FAIL`; `CLAUDE.md` notes the slow cold hook.
- [ ] **D** — `CLAUDE.md` Secrets bullet is reworded to carve out the opaque seed
      copy **without weakening** "never expose secret values";
      `.claude/settings.json` has a **narrow** seed-copy `permissions.allow`
      entry and remains valid JSON; the skill states a blocked seed is
      skip-and-warn / not a DoD blocker; the best-effort residual risk is
      documented.
- [ ] **E** — `pnpm exec cap` + build-web-first `cap sync` (E1) and
      prettier-normalize-changed-files (E2) guidance is present in the relevant
      files; absolute-path / no-persisted-cwd is reinforced (E3); **no**
      `.gitattributes` change.
- [ ] **F** — DoD ⇄ task-manifest coverage (F1) and shared-type repo-wide ripple
      / workspace-wide typecheck (F2) and exact-string rendered-text assertions
      (F3) are wired into `create-spec/SKILL.md`, `spec-author.md`,
      `spec-reviewer.md`, `feature-reviewer.md`, and `implement-feature/SKILL.md`
      as specified.
- [ ] **G** — a "Known environment behaviors" section documents async Agent
      dispatch, Bash cwd reset, and classifier poisoning as current-harness
      observations.
- [ ] **H** — `implement-feature/SKILL.md` Step 1 has the spec-file-only-diff
      guard.
- [ ] **No other file is changed**; no Nx target, `.gitignore`, `.gitattributes`,
      CI, app/lib/function/type/UI/Firestore change.
- [ ] **No e2e flow required** — explicitly recorded (tooling/prompt/config
      change; no route/action; web build unchanged).
- [ ] `nx affected` shows no affected project (expected); `.claude/settings.json`
      remains valid JSON; verification is **by inspection** per the Test plan.

## Risks

1. **Group D is best-effort — honest residual risk.** The in-repo levers
   (CLAUDE.md reword, the narrow `settings.json` allowlist entry, and the
   skip-and-warn fallback) are deterministic, but the **auto-mode permission
   classifier's LLM judgment and its "poisoning"** sit **above** the allowlist and
   are **harness-level** — they are **documented** (group G), **not fixed**. The
   allowlist matcher may not fully suppress the denial because the seed is a
   multi-line PowerShell `Copy-Item`. This spec does not claim to eliminate the
   denial; it reduces its likelihood and makes the fallback explicit.
2. **The secrets reword must not weaken the real prohibition.** The group D
   CLAUDE.md change carves out only the **opaque file-to-file seed copy** (already
   sanctioned by spec 0040 Risks §1). It must retain "never read, print, log,
   echo, or commit secret **values**" and the "flag if a secret would be needed
   somewhere it shouldn't be" clause. A reviewer must reject any reword that lets
   an agent read or print secret contents.
3. **The `settings.json` allowlist must stay narrow.** The `permissions.allow`
   entry is scoped to the three seed filenames via `Copy-Item`. It must **not** be
   broadened to a general `Bash(*)` or any pattern that would pre-authorize
   arbitrary shell commands. If a narrow matcher can't be expressed in the
   harness's matching syntax, prefer leaving the allowlist out and relying on the
   CLAUDE.md wording + fallback over a dangerously broad entry.
4. **Group E2's CRLF fix is deliberately not a `.gitattributes` change.** The
   existing `.gitattributes` pins only `*.gradle` and `/docs/specs/STATUS.md` to
   LF and explicitly avoids repo-wide renormalization; the per-file
   `prettier --write` normalize step preserves that decision. Do not "improve"
   this by adding a repo-wide `* text=auto eol=lf` rule.
5. **Group G documents, doesn't fix.** The async-dispatch, cwd-reset, and
   classifier-poisoning notes are observations of the **current** harness and may
   change; they are recorded so the orchestrator plans around them, not as
   guarantees.
6. **No architecture / PLAN conflict.** This adds **no slice, no cross-slice or
   cross-scope import, no shared logic, and no data-model change.** It is a
   prompt/config edit outside the Nx/TS/Sheriff graph (like spec 0040) — no
   conflict with PLAN §3 (vertical slice / Sheriff) or §4 (data model). It
   **hardens** the PLAN §5 DoD process and the spec-driven workflow described in
   `CLAUDE.md`. TMDB / Trakt data-source accuracy is unrelated.
