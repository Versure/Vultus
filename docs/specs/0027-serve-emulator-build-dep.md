---
number: 0027
slug: serve-emulator-build-dep
title: Make mobile:serve-emulator build functions before starting the emulator
status: done
slices: []
scopes: [scope:mobile]
created: 2026-06-25
---

# Make mobile:serve-emulator build functions before starting the emulator

## Context

On a clean checkout, `pnpm nx run mobile:serve-emulator` fails immediately:

```
!! functions: Failed to load function definition from source: FirebaseError:
could not deploy functions because the "dist\apps\functions" directory was not found.
```

The `serve-emulator` target (`apps/mobile/project.json`) starts the Firebase
emulator suite and the Angular dev server **in parallel**, but it has no
dependency on `functions:build`. The Functions emulator loads its function
definitions from the compiled `dist/apps/functions` output, which does not exist
on a fresh tree until the developer manually runs `pnpm nx build functions`
first. The failure is non-obvious — a contributor running the one documented
local-dev command hits a confusing Firebase error with no indication that a
prior build step was implied.

Intended outcome: `pnpm nx run mobile:serve-emulator` works end-to-end on a clean
checkout (or after `dist/apps/functions` is deleted) without any manual
pre-build, by declaring `functions:build` as a task dependency. This is a
config-only change to one file. Tracks GitHub issue #61.

## Scope

In scope:

- **`apps/mobile/project.json`** — add a `dependsOn` to the `serve-emulator`
  target so Nx builds `functions` (development configuration) before the target's
  commands run.

Out of scope:

- `apps/mobile-e2e/project.json` — its `e2e-local` target starts the emulator
  with `--only firestore,auth` (no Functions emulator), so it does **not** need
  `dist/apps/functions` and is **deliberately left unchanged**.
- The plain `mobile:serve` / `mobile:serve-static` targets — they run only the
  Angular dev server, no emulator, and need no functions build.
- Any change to `functions:build` itself, to the emulator/Firebase config
  (`firebase.json`), or to the function source. No new logic, files, types, or
  runtime behavior.

## Affected slices & Sheriff tags

No slice is built (`slices: []`). This touches a single Nx project config file in
`apps/mobile`, which carries the `scope:mobile` tag (frontmatter
`scopes: [scope:mobile]`). The change is purely the Nx task graph for one target;
it introduces **no import** (cross-slice or otherwise), so no Sheriff boundary is
affected. The `functions:build` reference is an Nx **task dependency**, not a
TypeScript import, so it does not cross the `scope:mobile` ↔ `scope:functions`
no-import boundary (PLAN §3) — Nx `dependsOn` across projects is the supported,
boundary-neutral way to order tasks, and `serve-emulator` already orchestrates
both the mobile dev server and the Firebase emulator (which itself hosts the
functions) in one developer convenience target.

## Data model touchpoints

None. No Firestore collections, fields, converters, or security rules are touched
(PLAN §4 unaffected).

## Public types / APIs

No domain types, function signatures, HTTP endpoints, or callable shapes change.
The only observable surface change is the `mobile:serve-emulator` Nx target's
task graph: it now has an ordered dependency on `functions:build:development`.
The target name, executor, and the two commands it runs are unchanged.

## UI / Stitch screen refs

Not applicable. No mobile UI is built or changed; this is Nx/tooling
configuration only.

## Implementation task graph

A single config edit; no parallelism. One task, run by the
**infrastructure-engineer**.

1. **[sequential] Add the `functions:build` dependency to `serve-emulator`.**
   - In `apps/mobile/project.json`, add to the `serve-emulator` target (currently
     `executor` + `options.commands` + `parallel: true`, no `dependsOn`) a
     `dependsOn` declaring the functions development build:

     ```json
     "serve-emulator": {
       "executor": "nx:run-commands",
       "dependsOn": [
         { "target": "build", "projects": ["functions"], "configuration": "development" }
       ],
       "options": {
         "commands": [
           "npx firebase emulators:start --project vultus-cab62",
           "pnpm nx serve mobile --configuration=emulator"
         ],
         "parallel": true
       }
     }
     ```

   - Rationale for `configuration: "development"`: confirmed — `apps/functions/project.json`
     defines `"development": {}` (inherits base options: `bundle: false`,
     `generatePackageJson: true`, sourcemaps on). This unbundled, package.json-generating
     output is exactly what the Functions emulator needs to discover and load function
     definitions. It is also faster than the production build (no bundling step).
   - Nx's computation cache makes this a no-op when `dist/apps/functions` is
     already up-to-date, so steady-state `serve-emulator` startup is not slowed.
   - Files: `apps/mobile/project.json`.

## Test plan

This is a config-only change with no application logic, so the verification is a
manual reproduction of the bug and its fix (per the PLAN §5 pyramid, the test
surface here is the build/serve gate, not unit/component code).

- **Unit tests:** none — no logic added.
- **Component tests:** none — no UI changed.
- **e2e tests:** **No e2e flows required — tooling/config change only.** No
  user-facing route or action changes; `apps/mobile-e2e`'s `e2e-local` target is
  untouched and continues to start only the Firestore + Auth emulators.
- **Manual verification (human/local gate — must run in the user's own terminal;
  the Functions emulator cannot start via Claude Code tools in this environment):**
  1. From a clean state, delete `dist/apps/functions`.
  2. Run `pnpm nx run mobile:serve-emulator`. Confirm Nx builds `functions`
     **before** the emulator/dev-server commands start, that
     `dist/apps/functions` is produced, and that the Functions emulator loads the
     function definitions with **no** "directory was not found" error.
  3. Confirm `pnpm nx run mobile:serve-emulator` on a warm cache (output already
     up-to-date) skips the rebuild (cache hit) and starts as before — no added
     latency in the steady state.
  4. Confirm `pnpm nx lint` passes (the edited `project.json` stays valid).
     Steps 1–3 are a human gate; the implementing agent can complete step 4.

## Definition of done

Tailored from the PLAN §5 checklist (no unit/component/e2e added — config-only):

- [ ] `apps/mobile/project.json` `serve-emulator` target declares
      `dependsOn: [{ "target": "build", "projects": ["functions"], "configuration": "development" }]`
      (or the confirmed-correct configuration / default, per the implementation
      note), with the target's executor and commands otherwise unchanged.
- [ ] On a clean checkout (or with `dist/apps/functions` deleted),
      `pnpm nx run mobile:serve-emulator` auto-builds functions first and starts
      the emulators **without** the "dist\\apps\\functions directory was not
      found" error (verified locally; recorded in PR).
- [ ] Warm-cache `serve-emulator` is a no-op rebuild (Nx cache hit) — no added
      startup latency in the steady state (recorded in PR).
- [ ] `apps/mobile-e2e/project.json` is **unchanged** (its `e2e-local` runs
      `--only firestore,auth`, no Functions emulator).
- [ ] `pnpm nx lint` (incl. Sheriff) passes; `apps/mobile/project.json` remains
      valid JSON.
- [ ] No secret is read or written; no new dependency, file, or type is added.

## Risks

- **`functions:build` configuration name.** Confirmed — `apps/functions/project.json`
  defines `"development": {}` (inherits base options). No investigation needed;
  the `"configuration": "development"` reference is safe to ship as written.
- **Cross-project Nx dependency vs. Sheriff boundary.** Adding a `functions`
  dependency from a `scope:mobile` project's target could look like it crosses the
  `scope:mobile` ↔ `scope:functions` no-import rule (PLAN §3, CLAUDE.md). It does
  not: `dependsOn` is an Nx **task-ordering** edge, not a TypeScript import, and
  Sheriff governs module imports only. The `serve-emulator` target is an explicit
  local-dev orchestrator that already runs the Firebase emulator hosting the
  functions, so depending on the functions build is consistent with its purpose.
- **No PLAN conflicts.** This is a tooling-only fix to a local-dev convenience
  target; it changes no architecture, data model, or public surface. TMDB/Trakt
  data-source accuracy is not relevant to this infra change.
