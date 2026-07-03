---
number: 0067
slug: ai-setup-instruction-corrections
title: Correct drifted/incorrect standing-instruction content in agents, PLAN.md, and CLAUDE.md
status: approved # draft | approved | implementing | done
slices: []
scopes: []
created: 2026-07-02
---

# Correct drifted standing-instruction content

## Context

An audit of the Claude Code setup found a cluster of **factually wrong or stale**
statements in the standing instructions that agents read first. Each will actively
misdirect an agent (wrong test runner, wrong CI model, a tool an agent is told to use
but isn't granted, wrong billing plan, an incomplete slice list used for validation).
None is an application/lib/UI/Firestore defect — all are corrections to
`.claude/agents/**`, `docs/PLAN.md`, and `CLAUDE.md`, verified by inspection.

**Intended outcome.** Make every checkable claim in the standing instructions match
the repo's actual state, with special priority on the two that break agent behavior
(e2e-CI-gate falsehood; spec-author's missing Stitch tools).

## Scope

In scope (each file edited per the item(s) noted):

- **`.claude/agents/infrastructure-engineer.md`** — items **A** (e2e-is-a-CI-gate),
  **F** (Spark→Blaze).
- **`.claude/agents/spec-author.md`** — item **B** (Stitch MCP tool grant / contract).
- **`.claude/agents/backend-engineer.md`** — items **C** (Jest→Vitest), **D**
  (emulator-can't-run-locally).
- **`.claude/agents/qa-runner.md`**, **`.claude/agents/frontend-engineer.md`** — item
  **G** (raw `nx serve --configuration=mock` → named scenario target); frontend-engineer
  also item **H** (PowerShell-only Stitch fetch recipe → shell-agnostic).
- **`docs/PLAN.md`** — items **E** (§3 slice inventory 6→9 / make pattern-based),
  **F** (Spark→Blaze in §2/§7), **I** ("2+" vs "3+" shared-extraction threshold),
  **J** (§5 DoD dead items).
- **`CLAUDE.md`** — item **D** (emulator caveat on `firebase emulators:start`), item
  **K** (garbled `.env.local` bullet), item **L** (audit-docs + deploy-functions missing
  from the skill inventory), item **M** ("supersedes PLAN §5–§6" stale framing).
- **`.claude/skills/implement-feature/SKILL.md`** — item **N** (`npm install` →
  `pnpm install` in the concurrency note, line 41).

Out of scope:

- Any code/CI/Nx/Firestore change. The e2e gate, Blaze billing, and slice set are
  already true in reality — only the _descriptions_ are being corrected.
- Granting the Stitch MCP repo-wide (that is spec 0068's `.mcp.json` concern if
  pursued) — item B only fixes spec-author's own `tools:` allowlist or contract.
- De-duplicating the repeated rules (Stitch recipe, hexes, E-notes) — that is spec 0071. This spec fixes _wrong_ content; 0071 removes _duplicated_ content.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). All files are prompt/standing-instruction
markdown outside the Nx/TS/Sheriff graph.

## Data model touchpoints

**None.**

## Public types / APIs

No types/signatures. Concrete corrections (each has a verified source cite):

- **A — e2e IS a CI gate.** `infrastructure-engineer.md:43` says "e2e is not a CI
  gate (it runs via qa-runner locally)". False: `.github/workflows/ci.yml:125-131`
  runs the Playwright e2e gate via `firebase emulators:exec` on every PR (spec 0019),
  and `qa-runner.md:36` says CI is the authoritative e2e validator, while e2e cannot
  run in-session locally (memory `emulator-tooling-limitation`, `ci-runs-e2e-emulator`).
  Rewrite to: CI runs typecheck/lint/test/build + the emulator integration gate + the
  Playwright e2e gate (firestore+auth emulators) + `functions:deploy-preflight`; e2e is
  a required PR gate that cannot run inside a Claude Code session.
- **B — spec-author Stitch tools.** `spec-author.md:4` grants no `mcp__stitch__*`, yet
  `spec-author.md:86-91` requires `get_screen` and makes "Stitch screen NOT captured" a
  blocking open item → every mobile-UI spec forced onto the blocking path. Fix: add
  `mcp__stitch__get_screen, mcp__stitch__list_screens, mcp__stitch__get_project` to the
  `tools:` list. `frontend-engineer.md:4` grants **four** Stitch tools (also
  `mcp__stitch__list_design_systems`); spec-author needs only these three, so the fourth is
  intentionally omitted (not "mirrored"). **Chosen fix: the tool grant** (simpler,
  self-contained). The contract-change alternative (create-spec fetches the screen and passes
  the ID + downloadUrl + saved raw-HTML path into the decision record) is noted but not taken
  here.
- **C — Jest→Vitest.** `backend-engineer.md:57` says "heavy unit coverage (Jest)".
  Workspace is Vitest-only (CLAUDE.md; `apps/functions` uses `@nx/vitest`; specs import
  from `vitest`). Change "(Jest)" → "(Vitest)".
- **D — emulator can't run in-session.** Add to `backend-engineer.md` hard-rules and a
  one-line caveat to `CLAUDE.md:56`'s command list: the Firestore emulator / any Java
  NIO loopback server **cannot run under Claude Code tools here** (memory
  `emulator-tooling-limitation`); emulator-dependent gates run in CI or the user's own
  terminal, not in-session.
- **E — §3 slice inventory stale.** `PLAN.md:145-151, 173-174` list 6 slices; 9 exist
  on disk (`libs/mobile/{onboarding,notifications,search,settings,title-detail,watchlist}`,
  `libs/functions/{dispatch-notifications,sync-episodes,sync-titles}`). spec-reviewer
  validates Sheriff tags "against PLAN §3". Fix: state the _pattern_ ("one `slice:` tag
  per lib under `libs/{mobile,functions}/*`; authoritative list = `sheriff.config.ts`")
  rather than a hand-enumerated list that drifts with every new slice.
- **F — Spark→Blaze.** `PLAN.md:51,56,490-491` say Spark; `PLAN.md:459-478` and memory
  `firebase-project-setup` confirm **Blaze** with deployed Cloud Functions.
  `infrastructure-engineer.md:49-50` repeats the stale Spark claim. Correct both to
  Blaze; delete the "confirm you do not want Blaze" §7 item.
- **G — named serve target.** `qa-runner.md:47` and `frontend-engineer.md:128-130` use raw
  `nx serve mobile --configuration=mock`; CLAUDE.md mandates `pnpm nx run mobile:serve-mock`.
  Replace with the named target. Also normalize the **second** raw reference at
  `qa-runner.md:37` ("launch the app via `nx serve` (background)") to a named scenario target
  (e.g. `mobile:serve-mock`) so no raw-`nx serve` mention lingers against the same rule.
- **H — shell-agnostic Stitch fetch.** `frontend-engineer.md:54-57` mandates
  `Invoke-WebRequest` (PowerShell) but the agent is granted only `Bash` (Git Bash).
  Make the recipe shell-agnostic (`curl -sSL -o <scratch>.html <url>` from Bash, or
  `Invoke-WebRequest -UseBasicParsing` if PowerShell is available), keeping the
  "not WebFetch" warning.
- **I — extraction threshold.** `PLAN.md:131` says "2+ slices"; `PLAN.md:186-187`,
  CLAUDE.md, and all four implementer agents say "3+ slices". Fix `PLAN.md:132` to
  "3+" so PLAN agrees with itself and every other artifact.
- **J — §5 DoD dead items.** `PLAN.md:325-326` retain "PR description per template"
  (no PR template exists under `.github/`) and "Design note exists" (the spec file now
  _is_ the design note). Update to current reality ("PR references the merged spec").
- **K — garbled `.env.local` bullet.** `CLAUDE.md:70-73` has broken emphasis, "exit 1"
  split into a list item, and `FIREBASE\__`. Rewrite cleanly: "…runs first and **fails
  loudly (exit 1, naming the missing key)** if any `TMDB_API_KEY` / `FIREBASE_*` value
  is absent." Verify Prettier doesn't re-mangle it.
- **L — skill inventory.** `CLAUDE.md:133` says "Five skills drive it" and omits
  `/audit-docs` (spec 0059) and `/deploy-functions`. Add a line: two maintenance skills
  sit outside the spec loop — `/deploy-functions` and `/audit-docs`.
- **M — supersession framing.** `CLAUDE.md:130` says the spec workflow "supersedes the
  issue-driven model in PLAN §5–§6", but PLAN was already rewritten (`PLAN.md:252-260,
289-297`). Reword to reflect that PLAN §5 already describes the spec-driven model.
- **N — pnpm.** `implement-feature/SKILL.md:41` says "`npm install`" in a pnpm-only
  workspace; change to `pnpm install` / `pnpm add`.

## UI / Stitch screen refs

**Not applicable** — no UI built; item H edits _how_ the fetch recipe is written, not a
screen.

## Implementation task graph

All edits are inspection-verified prompt/doc corrections; route to
**infrastructure-engineer**. Group by file so manifests are disjoint.

- **T1 [parallel]** — `infrastructure-engineer.md` (A, F).
- **T2 [parallel]** — `spec-author.md` (B).
- **T3 [parallel]** — `backend-engineer.md` (C, D).
- **T4 [parallel]** — `qa-runner.md` (G); **T5 [parallel]** — `frontend-engineer.md`
  (G, H).
- **T6 [parallel]** — `docs/PLAN.md` (E, F, I, J).
- **T7 [parallel]** — `CLAUDE.md` (D-caveat, K, L, M).
- **T8 [parallel]** — `implement-feature/SKILL.md` (N).

## Test plan

Prompt/doc change; no executable surface. `nx affected` shows no project (the
`doc-integrity-test` `plan-theme-hex`/`lib-readme` guards are unaffected — no hex or
lib-README content changes).

Verification **by inspection**, one assertion per item A–N (as stated above). Cross-
check the two highs specifically: `infrastructure-engineer.md` no longer says "e2e is
not a CI gate"; `spec-author.md` `tools:` includes the three `mcp__stitch__*` entries
(or the contract change is present in create-spec).

## Definition of done

- [ ] Items **A** and **B** (the behavior-breaking highs) fixed and inspected.
- [ ] Items **C, D, E, F, G, H, I, J, K, L, M, N** applied per the cites above.
- [ ] No code/CI/Nx/Firestore change; `nx affected` shows no affected project.
- [ ] Prettier does not re-mangle the corrected `CLAUDE.md` `.env.local` bullet
      (run `pnpm exec prettier --check CLAUDE.md`).

## Risks

1. **These are descriptions of already-true reality** (e2e gate, Blaze, 9 slices) — the
   risk is a _wrong correction_, so each edit must cite the source of truth it's
   matching. A reviewer verifies each against the cited file/line.
2. **Item B alternative.** If the tool grant is chosen, confirm an agent `tools:` list
   is an exact allowlist (docs-verified: MCP tools require explicit listing); if the
   contract change is chosen instead, ensure create-spec actually fetches and passes the
   screen so spec-author isn't still blocked.
3. **No architecture/PLAN conflict** — corrections align artifacts with reality; the §3
   pattern-based rewrite (item E) makes the slice list self-maintaining.
