---
number: 0023
slug: functions-deploy-env-asset
title: Fix the CI Functions deploy — stage the .env.vultus-cab62 param file into dist in preflight and guard it loudly
status: approved
slices: []
scopes: [scope:functions]
created: 2026-06-25
---

# Fix the CI Functions deploy — stage the .env.vultus-cab62 param file into dist in preflight and guard it loudly

## Context

The first CI Cloud Functions deploy via `.github/workflows/deploy-functions.yml`
**failed**. GitHub Actions run `28161213149` (manual `workflow_dispatch` on
`main`, 2026-06-25) cleared `Deploy preflight` but then failed at the
`Deploy to Firebase` step with:

```
Error: In non-interactive mode but have no value for the following environment variables: TRAKT_CLIENT_ID
```

Root cause, confirmed empirically by cleaning `dist/apps/functions` and running
`pnpm nx build functions --configuration=production --skip-nx-cache`:

- `apps/functions/project.json`'s production build config lists
  `.env.vultus-cab62` as a copied asset
  (`{ "input": "apps/functions", "output": ".", "glob": ".env.vultus-cab62" }`),
  **but Nx's asset globber (globby/fast-glob) skips dotfiles by default**, so the
  file is **silently never copied** into `dist/apps/functions/`.
- The sibling **non-dotfile** asset entries (`package.json` from `apps/functions`,
  `pnpm-workspace.yaml` from `apps/functions/deploy/`) copy fine — proving asset
  copying works and the **dotfile glob** is the specific failure.
- `firebase deploy` reads function params (`defineString('TRAKT_CLIENT_ID')` —
  `apps/functions/src/main.ts:53`) from dotenv files in the functions **source
  dir**, which `firebase.json` points at `dist/apps/functions`. With the file
  absent there, the non-interactive deploy has no value for `TRAKT_CLIENT_ID` and
  aborts.
- It "worked" on **local** deploys only because Nx's esbuild build does **not**
  wipe `dist/` between runs, so a stale, manually-placed
  `dist/apps/functions/.env.vultus-cab62` from an earlier session persisted on the
  developer machine. A fresh CI checkout has no pre-existing dist, so it breaks —
  exactly the class of "works locally, breaks in CI" the deploy-preflight target
  exists to catch.

`TRAKT_CLIENT_ID` is a **non-secret public param** (the public Trakt API client
id), **not** a secret. In CI, `deploy-functions.yml`'s
`Write functions env (TRAKT_CLIENT_ID)` step writes
`apps/functions/.env.vultus-cab62` from the `vars.TRAKT_CLIENT_ID` Actions
**variable** (a `printf`, gitignored file) **before** the preflight build runs.
The two real secrets `SYNC_SHARED_SECRET` / `TMDB_READ_TOKEN` (`defineSecret`)
live in Secret Manager, are **not** in this env file, and are out of scope.

Intended outcome: the deployable artifact (`dist/apps/functions`) reliably
contains `.env.vultus-cab62` so `firebase deploy` resolves `TRAKT_CLIENT_ID`
non-interactively, and the deploy-preflight gate **fails loudly** if it ever does
not — so this class of "param file missing from dist" deploy bug can never again
surface a day later on a real deploy. This spec is **pure infrastructure** — it
changes **no function TypeScript** (`apps/functions/src/**`).

## Scope

In scope:

- **Stage the param file into dist (the fix).** Modify
  `tools/scripts/functions-deploy-preflight.mjs` so that, after confirming
  `dist/apps/functions` exists and **before** the artifact checks that depend on
  it, it copies `apps/functions/.env.vultus-cab62` →
  `dist/apps/functions/.env.vultus-cab62` **when the source file exists**. This is
  the single command both deploy paths already run (CI's `Deploy preflight` step
  and the local `/deploy-functions` skill), so one fix covers both; the preflight
  already mutates dist (it runs `pnpm install --frozen-lockfile` there), so
  staging an asset is consistent with what it does.
- **Add a loud guard.** Add a new numbered preflight check that **fails fast**
  (`fail(...)`, exit 1) if `dist/apps/functions/.env.vultus-cab62` is **absent
  after staging** — i.e. neither the build asset nor the staging copy produced it.
  This is the "fail loud, never silent" guard (matching spec 0021's theme): the
  param file's presence in dist becomes a verified gate, not an assumption.
- **Remove the dead glob.** Remove the misleading `.env.vultus-cab62` dotfile
  asset entry from `apps/functions/project.json`'s **production** `assets` array
  (it never copied anything and implies it does). Leave the `package.json` and
  `pnpm-workspace.yaml` asset entries untouched.

Out of scope (each stated explicitly):

- **The Secret Manager IAM grant** (deploy SA `secretmanager.admin` on
  `SYNC_SHARED_SECRET` / `TMDB_READ_TOKEN`) — a manual/human step **already
  applied 2026-06-25**, not part of this spec.
- **Any change to `SYNC_SHARED_SECRET` / `TMDB_READ_TOKEN` secret handling** —
  those are `defineSecret`, live in Secret Manager, and are never in this env file.
- **Any function TypeScript** (`apps/functions/src/**`), the `defineString`
  declaration, or the `firebase.json` source dir.
- **No change to `.github/workflows/deploy-functions.yml` or the
  `/deploy-functions` skill.** Both already run `functions:deploy-preflight`, so
  the fix is intentionally placed where neither needs editing. (Called out
  explicitly below.)
- **The spec-0021 smoke gate / daily-sync diagnostic.** The
  "Verify syncTitles is publicly invokable" smoke step is **downstream** of
  `Deploy to Firebase`; once the deploy succeeds it will finally run — but that is
  spec 0021's concern, not a change here.
- **Generalizing** to multiple env files, other projects, or other params — single
  project `vultus-cab62`, single file `.env.<projectId>`.
- **Re-running or replaying the historical failed deploy** run `28161213149` — this
  spec prevents recurrence; it does not replay the run.

## Affected slices & Sheriff tags

**None.** This spec touches only:

- `tools/scripts/functions-deploy-preflight.mjs` (a workspace-root Node ESM tool
  script, not a project/lib/app), and
- `apps/functions/project.json` (an Nx project config — the `assets` array of the
  production build configuration).

Sheriff governs **workspace import boundaries between projects** — it does not
police a root `tools/` script or an Nx `project.json` `assets` list, and no
TypeScript import is added or crossed. There is **no slice, no library, no
function source, and no `sheriff.config.ts` change**. `slices: []`;
`scopes: [scope:functions]` is **descriptive only** (this is the deploy leg of the
`scope:functions` backend) and drives no Sheriff rule. There is **no
DRY/3+-slice** question because no shared logic is added across slices.

`apps/functions/project.json` is edited, so `functions` **is** in the `nx affected`
set for this spec (unlike spec 0021, which touched no project.json).

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule
changes. `firestore.rules` / `firestore.indexes.json` are untouched. The preflight
copies a build asset and the project.json edit removes a non-functioning glob;
neither reads or writes any database, and neither triggers a sync.

## Public types / APIs

**None.** No new or changed types, function signatures, callable shapes, or HTTP
endpoints. The `defineString('TRAKT_CLIENT_ID')` param (`main.ts:53`) and the
deployed `syncTitles` HTTP contract are **fixed input**, unchanged. The only
"interface" touched is internal tooling:

- **`functions-deploy-preflight.mjs` invariant (new):** after a successful run,
  `dist/apps/functions/.env.vultus-cab62` **exists** (the param file Firebase reads
  to resolve `TRAKT_CLIENT_ID` non-interactively). The script gains one numbered
  check and a staging step; its CLI surface (`node
  tools/scripts/functions-deploy-preflight.mjs`, invoked via `nx run
  functions:deploy-preflight`) and exit semantics (0 = all pass, 1 = first fail)
  are unchanged.
- The env filename is `.env.<projectId>` with `projectId = vultus-cab62` (the
  single deploy target, per `setGlobalOptions` / `firebase.json`). The script may
  hardcode the literal `.env.vultus-cab62` (single project; do **not** generalize).

## UI / Stitch screen refs

**Not applicable.** This is CI/infrastructure tooling work. There is no mobile
slice, screen, or design token.

## Implementation task graph

Two tasks, both **infrastructure-engineer** territory; neither touches a Sheriff
slice. They edit **disjoint files** and are logically independent, but the change
is small and the verification (Task 3) exercises both together — keep them
**[sequential]** for simplicity (no parallel fan-out value in two small edits).

### 1. [sequential] Stage the param file + add the loud guard (preflight script)

File: `tools/scripts/functions-deploy-preflight.mjs` (the only file).

Read the existing script first — it is a well-documented 6-check Node ESM script
with numbered checks and `ok()` / `fail()` helpers. **Match its style exactly**:
numbered comment blocks, `ok(msg)` on success, `fail(msg)` (which prints
`✗ deploy-preflight failed:` and `process.exit(1)`) with an **actionable**
message.

Introduce these, placed **immediately after check 1** ("Artifact present", which
confirms `DIST` exists and the core files are present) and **before** check 2, so
the staged file is guaranteed present for everything downstream:

- **Stage step.** Define the source and dest paths
  (`SRC = resolve(process.cwd(), 'apps/functions/.env.vultus-cab62')`,
  `dest = join(DIST, '.env.vultus-cab62')`). If `existsSync(SRC)`, `copyFileSync`
  it to `dest` (import `copyFileSync` from `node:fs`) and `ok('staged
  .env.vultus-cab62 into dist (TRAKT_CLIENT_ID param file)')`. If the **source
  does not exist**, emit a **warning, not a fail** — print a clear advisory (e.g.
  `console.warn`) that `apps/functions/.env.vultus-cab62` was not found at the
  source, that it normally carries the non-secret `TRAKT_CLIENT_ID` param and is
  produced by the CI `Write functions env (TRAKT_CLIENT_ID)` step from
  `vars.TRAKT_CLIENT_ID` (and, locally, is the gitignored project env file), and
  that a real deploy will fail without it. **Rationale (pin in the spec/PR):**
  preflight can legitimately be run purely to validate the artifact bundle without
  intending to deploy, so a missing *source* is a warning; the **dist presence**
  check below is the hard gate.
- **New numbered check (the loud guard) — "param env file present in dist".**
  After the stage step, `if (!existsSync(dest)) fail(...)`. The message must
  explain that `dist/apps/functions/.env.vultus-cab62` is missing — that
  `firebase deploy` reads `TRAKT_CLIENT_ID` (a non-secret `defineString` param)
  from this file in the functions source dir (`dist/apps/functions` per
  `firebase.json`), that the Nx production build's dotfile asset glob **does not
  copy it** (fast-glob skips dotfiles), and that it is normally produced by the CI
  `Write functions env (TRAKT_CLIENT_ID)` step (from `vars.TRAKT_CLIENT_ID`) /
  locally the gitignored file. On success: `ok('.env.vultus-cab62 present in dist
  (TRAKT_CLIENT_ID resolves non-interactively)')`.
- **Renumber** the trailing comment headers if the implementer numbers the new
  check inline (the existing checks are 1–6; the staging/guard slots logically as
  "1b"/"2" or a renumber to 7 checks — pick whichever keeps the file's numbered
  style coherent and update the top-of-file docstring's checklist accordingly).
- Keep the new logic synchronous (`existsSync`/`copyFileSync`), matching the
  script's existing synchronous style; no new dependency is added.

Update the **top-of-file docstring** checklist (the `Checks (...)` comment block)
to include the new staging + presence behavior, in the same terse style as the
existing entries.

### 2. [sequential] Remove the dead dotfile asset glob (project.json)

File: `apps/functions/project.json` (the only file).

In the **production** build configuration's `assets` array
(`targets.build.configurations.production.assets`), remove the trailing object
entry:

```json
{
  "input": "apps/functions",
  "output": ".",
  "glob": ".env.vultus-cab62"
}
```

Leave the other three entries untouched (`apps/functions/src/assets`, the
`package.json` entry, and the `pnpm-workspace.yaml` entry). This entry never
copied anything (dotfile glob silently skipped) and its presence falsely implies
the file is shipped by the build — removing it makes the preflight stage step the
single, honest source of the staged param file.

### 3. [sequential] Integration verification (run in-session)

No separate file. The implementing agent runs the concrete green gate described in
the Test plan: clean dist, run `functions:deploy-preflight` with a dummy
`apps/functions/.env.vultus-cab62`, and assert the staged file lands in dist and
preflight passes.

(No workspace lib is touched, so no lib-`README.md` update applies. The
`deploy-functions.yml` workflow and `/deploy-functions` skill are **unchanged** —
both already run `functions:deploy-preflight`, so the fix reaches them without
edits.)

## Test plan

Per the PLAN §5 pyramid. The deliverable is a Node preflight-script change plus an
Nx `project.json` asset edit — there is **no slice/component/e2e** surface.

- **Unit (recommended, pragmatic).** Add a small **Vitest** test for the staging +
  guard logic. The preflight is currently a top-level ESM script (side-effecting,
  not exported functions), so to make it testable **refactor the stage/guard into
  a small pure-ish exported helper** (e.g. `export function stageEnvFile(distDir,
  srcEnvPath)` returning `{ staged: boolean }` and a guard that throws/returns when
  the dist file is absent) that the top-level script calls, then unit-test:
  (a) source present → file copied into the dist dir and reported staged;
  (b) source absent → no throw, warning path (no copy);
  (c) dist file absent after staging → guard fails.
  Use a temp dir (`node:os` `tmpdir` + `node:fs`) as the fake dist. **Keep it
  small** — do not over-engineer the refactor; if exporting a helper meaningfully
  distorts the script's shape, fall back to (b) below and record why. Place the
  test where tools/scripts tests live (or alongside the script as
  `functions-deploy-preflight.spec.mjs`), consistent with the repo's Vitest setup.
  **Caution:** the current script is **side-effecting at import** — it runs all
  checks and may `process.exit(1)` on load — so any extracted `stageEnvFile`-style
  helper must be importable **without triggering the top-level preflight run** (e.g.
  guard the script body behind an `if (import.meta.url === \`file://${process.argv[1]}\`)`
  main check, or split the helper into a sibling `.mjs` module). Otherwise a Vitest
  import executes the whole preflight against the real cwd. (As hedged below, the
  integration gate remains the primary verification.)
- **Integration verification (the concrete green gate — agent CAN run in-session):**
  1. Ensure `apps/functions/.env.vultus-cab62` exists with a **dummy non-secret**
     value, e.g. `printf 'TRAKT_CLIENT_ID=dummy\n' > apps/functions/.env.vultus-cab62`
     (PowerShell: `Set-Content` / a here-string — the value is a non-secret
     placeholder, safe to write).
  2. Remove `dist/apps/functions` (e.g. `Remove-Item -Recurse -Force
     dist/apps/functions` if present) to force a fresh build, mirroring CI.
  3. Run `pnpm nx run functions:deploy-preflight` (it builds + prunes first).
  4. Assert it **passes** and that `dist/apps/functions/.env.vultus-cab62`
     **exists** afterward (the staged file).
  5. Confirm the production build no longer references the dead glob — inspect
     `apps/functions/project.json` and confirm the dotfile asset entry is gone; the
     build's own behavior is covered transitively (the file is in dist via the
     preflight stage step, not the build asset).
- **Standard gates (DoD):** `nx affected -t typecheck lint build --base=main` for
  the `functions` project and the tools test (Vitest unit if added). **actionlint
  N/A** — no workflow YAML changed this time.
- **Human post-merge verification (agent cannot run — live creds):** a real
  `workflow_dispatch` of `deploy-functions.yml` should now clear the
  `Deploy to Firebase` step (`TRAKT_CLIENT_ID` resolves) and reach the spec-0021
  "Verify syncTitles is publicly invokable" smoke gate. Flag this as
  human/post-merge (needs live Firebase creds + the `vars.TRAKT_CLIENT_ID` Actions
  variable), as specs 0017/0021 did.

## Definition of done

Tailored from the PLAN §5 checklist. The `functions` project **is** affected
(project.json edit), so its `nx affected` targets apply.

- [ ] `tools/scripts/functions-deploy-preflight.mjs` stages
      `apps/functions/.env.vultus-cab62` → `dist/apps/functions/.env.vultus-cab62`
      when the source exists, placed right after the artifact-present check and
      before the downstream checks.
- [ ] The script **warns (does not fail)** when the **source** env file is absent,
      with an actionable message naming `TRAKT_CLIENT_ID`, the CI write-step, and
      the gitignored local file.
- [ ] The script has a new numbered check that **fails fast** (`fail(...)`, exit 1)
      when `dist/apps/functions/.env.vultus-cab62` is **absent after staging**,
      with an actionable message (why Firebase needs it, why the build's dotfile
      glob doesn't copy it, how it's normally produced). Top-of-file docstring
      checklist updated to match.
- [ ] `apps/functions/project.json` production `assets` no longer contains the
      `.env.vultus-cab62` dotfile glob entry; the `package.json` and
      `pnpm-workspace.yaml` entries are **untouched**.
- [ ] **No function TypeScript changed** (`apps/functions/src/**` untouched); the
      `defineString('TRAKT_CLIENT_ID')` declaration and `firebase.json` source dir
      are unchanged.
- [ ] **No change** to `.github/workflows/deploy-functions.yml` or
      `.claude/skills/deploy-functions/SKILL.md` (both already run preflight) — the
      PR notes this is intentional placement.
- [ ] Integration gate green: from a **cleaned** `dist`, with a dummy
      `apps/functions/.env.vultus-cab62` present, `pnpm nx run
      functions:deploy-preflight` **passes** and `dist/apps/functions/.env.vultus-cab62`
      **exists** afterward.
- [ ] Unit test (if added per the recommendation) green; if the testable-refactor
      was deliberately skipped, the PR records why and relies on the integration
      gate.
- [ ] `nx affected -t typecheck lint build --base=main` green for `functions`
      (and the tools test target if added). **actionlint N/A** (no workflow YAML
      changed) — noted in the PR.
- [ ] No secret committed: the env file is gitignored; only a **dummy non-secret**
      `TRAKT_CLIENT_ID` value is used for the in-session gate, and it is not
      committed.
- [ ] The **real `workflow_dispatch` deploy dry-run** (clears `Deploy to Firebase`,
      reaches the spec-0021 smoke gate) is **flagged for human post-merge
      verification** — the agent cannot run it in-session (live creds + Actions
      variable required). The PR records this as the real functional verification.

## Risks

- **Dotfiles silently skipped is the root failure class.** The whole bug is that
  Nx's fast-glob asset copier ignores dotfiles by default, so the env file never
  shipped. Staging it in the preflight (which runs on **both** CI and local deploy
  paths) is the durable fix; the loud guard ensures any future regression (e.g.
  someone removes the stage step, or a path changes) fails the deploy gate instead
  of `firebase deploy` aborting later. There is a residual brittleness: the
  filename `.env.vultus-cab62` is hardcoded to the single project id — acceptable
  for a single-target deploy (noted; revisit if a second project id is ever added).
- **Missing-source = warning, not fail (Decision 2 nuance).** Running preflight to
  validate only the artifact bundle (no intent to deploy, no source env file)
  remains valid and warns rather than fails; the **dist-presence** check is the
  hard gate. If a future caller expects preflight to *guarantee* a deployable env
  on a machine that never wrote the source file, that expectation is wrong by
  design — the warning explains how the file is produced.
- **Testability refactor is minor scope creep.** Exporting a small helper to unit
  test the stage/guard is the recommended path, but the **real** verification is
  the integration gate; if the refactor distorts the script, skipping the unit test
  (recorded in the PR) is acceptable per the pragmatic-pyramid guidance.
- **Downstream dependency, not a conflict.** Once this fix lands and a deploy
  succeeds past `Deploy to Firebase`, the spec-0021 smoke gate and the daily-sync
  flow finally exercise — but those are owned by specs 0021/0017 and are **not**
  changed here.
- **No PLAN conflict.** This aligns with PLAN §2/§5 (pruned `dist/apps/functions`
  is the deployable artifact; `deploy-preflight` is the gate that validates it the
  way Cloud Build will) and the `functions-deploy-pnpm-recipe` memo (ship the right
  files into dist). It adds no architecture; it makes the preflight honestly
  guarantee the param file the artifact needs. The stale §7 "Spark"/§2 "Spark plan"
  lines noted by specs 0017/0021 remain (project is on **Blaze**) — this spec does
  not depend on or reword them.
