---
number: 0038
slug: consolidate-mobile-targets
title: Consolidate mobile Nx run/build targets into 5 named scenarios
status: approved
slices: []
scopes: [scope:mobile]
created: 2026-06-29
---

# Consolidate mobile Nx run/build targets into 5 named scenarios

## Context

`apps/mobile/project.json` has grown to **9 targets** (`build`, `serve`,
`serve-emulator`, `serve-static`, `android`, `android-debug`, `sync`, `open`,
`inject-env`) **plus the `build` / `serve` configurations**. The set is sprawling and
hard to discover: a contributor reading the file cannot tell which command runs
"mock offline" vs "against prod Firebase" vs "on my phone" without tracing every
`commands` array. Two real capability gaps hide in the sprawl:

1. **No dev/unoptimized build against REAL prod Firebase.** The `build`
   `development` configuration only flips `optimization`/`sourceMap`; it does
   **not** apply the production `fileReplacements`, so it keeps the tracked
   `apps/mobile/src/environments/environment.ts`, which is hardcoded
   `useEmulators: true` with `demo-` Firebase placeholders (see that file). A dev
   build therefore **always** targets the emulators, never prod. There is no way
   to run a debuggable, sourcemapped build wired to real `vultus-cab62` data —
   which is exactly what the user needs to debug a prod-data issue with full
   debug info.
2. **The Android device path stops one step short.** `android-debug` runs
   `node tools/scripts/gradlew.mjs assembleDebug` (the prod-parity debug APK,
   spec 0026) but never installs/launches it. The user wants a one-command
   "deploy to my tethered phone over USB".

Intended outcome: replace the sprawl with **exactly 5 self-documenting named
scenario targets** plus a small set of kept primitives, close both gaps, and
remove three verified-unused targets — without regressing the e2e web-server
contract or spec 0027's `serve-emulator` build dependency. This is an
infrastructure/tooling change (owned by the **infrastructure-engineer**),
`scope:mobile`, config + docs only.

## Scope

In scope:

- **`apps/mobile/project.json`** — add a `prod-debug` build configuration; add a
  `prod-debug` serve configuration; add the five scenario targets `serve-mock`,
  `serve-prod-debug`, `serve-prod`, `android-usb` (and keep `serve-emulator`
  unchanged); rename `android-debug` → `android-usb` with the new device-install
  sequence; delete `serve-static`, `android`, `open`.
- **`docs/setup/debug-apk-setup.md`** — update the build command + behavior from
  `mobile:android-debug` to `mobile:android-usb`, and document the
  install-on-device step + USB device prerequisites.
- **`README.md`** (root) — replace the single generic `pnpm nx serve mobile` row
  in the "Common commands" table with the 5 named scenario targets so the root
  README is the canonical "how do I run this" reference; keep the build/lint/
  test/e2e rows.
- **`apps/mobile/README.md`** — fix the `mobile:open` reference in the Android
  build flow (target is being removed) **and** add/update a "Run / build targets"
  section documenting the same 5 scenario targets + the kept primitives.
- **`CLAUDE.md`** (root) — update the "Commands & definition of done (PLAN §5)"
  section so an agent (and Claude) knows **which** run target to use **when**.
  The section currently lists only the generic `pnpm nx serve`; augment it with
  the 5 named scenario targets and a one-line "use when" for each, keeping the
  existing test/lint/build/e2e command lines.

Out of scope:

- The mock build config and `--configuration=mock` semantics — `serve-mock` is a
  thin **alias** over the existing `mobile:build:mock` config; the config itself
  is unchanged. Other specs that say `--configuration=mock` stay valid — **do not
  churn them.**
- The `inject-mobile-env.mjs` script, `environment.*.ts` files, `firebase.json`,
  Gradle/Capacitor config, CI workflows. No behavior of the inject script
  changes.
- `apps/mobile-e2e/*` — the e2e web-server contract is preserved by keeping
  `serve` + its `development` default unchanged (see "Data model touchpoints" is
  N/A; see the e2e constraint in Test plan).
- Any application/runtime code, types, or UI. No new logic.

## Affected slices & Sheriff tags

No slice is built (`slices: []`). The change touches one Nx project config
(`apps/mobile/project.json`) and two docs, all under `scope:mobile`
(frontmatter `scopes: [scope:mobile]`). It introduces **no TypeScript import**
(cross-slice or otherwise), so no Sheriff module boundary is affected.

Note (cite spec 0027): **Sheriff governs module imports only, not Nx targets.**
The scenario targets are `nx:run-commands` wrappers and Nx task-graph edges, not
imports, so none of them cross the `scope:mobile` ↔ `scope:functions`
no-import boundary. `serve-emulator`'s existing cross-project `dependsOn` on
`functions:build` (spec 0027) is likewise a task-ordering edge and stays exactly
as-is.

## Data model touchpoints

None. No Firestore collections, fields, converters, or security rules are touched
(PLAN §4 unaffected). The only "data" concern is which Firebase backend each
scenario points at (emulator vs real `vultus-cab62`), governed entirely by the
`useEmulators` flag baked into the selected `environment.*.ts` via
`fileReplacements` — not a schema change.

## Public types / APIs

No domain types, function signatures, HTTP endpoints, or callable shapes change.

The observable surface change is the **Nx target list** for `apps/mobile`. After
this spec the project exposes exactly these run/build targets:

| Target            | Kind                  | What it does                                                                  |
| ----------------- | --------------------- | ----------------------------------------------------------------------------- |
| `build`           | primitive (kept)      | `@angular/build:application`; configs production / development / mock / **prod-debug** |
| `serve`           | primitive (kept)      | `@angular/build:dev-server`; default `development` (e2e contract) — unchanged  |
| `serve-mock`      | scenario (new)        | mock build, **no Firebase**; alias of `serve mobile -c mock`                   |
| `serve-emulator`  | scenario (kept as-is) | dev build vs **emulated** Firebase (spec 0027 `dependsOn` preserved)           |
| `serve-prod-debug`| scenario (new)        | **unoptimized + sourcemaps** vs **real prod** Firebase; injects env first      |
| `serve-prod`      | scenario (new)        | **optimized** prod build vs real prod Firebase; injects env first              |
| `android-usb`     | scenario (rename of `android-debug`) | inject env → check-native → prod build → cap sync → **cap run** (install + launch on USB device) |
| `sync`            | primitive (kept)      | `npx cap sync android`, `dependsOn: ["build"]` — unchanged                     |
| `inject-env`      | primitive (kept)      | `node tools/scripts/inject-mobile-env.mjs` — unchanged                         |

Removed: `serve-static`, `android`, `open`.

## UI / Stitch screen refs

Not applicable. No mobile UI is built or changed; this is Nx/tooling
configuration plus docs only.

## Implementation task graph

All tasks edit the single file `apps/mobile/project.json` (plus two docs), so the
JSON edits are **[sequential]** with respect to each other (one file, no
parallelism). The doc edits touch separate files and could in principle parallel,
but the whole spec is small — run it as one ordered sequence by the
**infrastructure-engineer**. The exact before/after JSON below is the contract.

### Task 1 — [sequential] Add the `prod-debug` build configuration

In the `build` target's `configurations` object, add a `prod-debug` config. It
**reuses the SAME `fileReplacements` as `production`** (environment.ts →
environment.generated.ts → `useEmulators: false` + real prod web config), and the
**only** differences from `production` are: optimization off, sourcemaps on,
licenses not extracted, **no budgets, no `outputHashing`**.

Add (sibling to `production` / `development` / `mock`):

```json
"prod-debug": {
  "fileReplacements": [
    {
      "replace": "apps/mobile/src/environments/environment.ts",
      "with": "apps/mobile/src/environments/environment.generated.ts"
    }
  ],
  "optimization": false,
  "extractLicenses": false,
  "sourceMap": true
}
```

Leave `production`, `development`, `mock`, and `defaultConfiguration: "production"`
unchanged. Files: `apps/mobile/project.json`.

### Task 2 — [sequential] Add the `prod-debug` serve configuration

In the `serve` target's `configurations`, add a `prod-debug` entry pointing at the
new build config. **Do not touch `defaultConfiguration: "development"`** or the
existing `production` / `development` / `mock` / `emulator` serve configs (the
`development` default is the e2e web-server contract — see Test plan).

Add (sibling to the existing serve configs):

```json
"prod-debug": {
  "buildTarget": "mobile:build:prod-debug"
}
```

Files: `apps/mobile/project.json`.

### Task 3 — [sequential] Add `serve-mock`

Thin `run-commands` alias over the existing mock build config. No Firebase
dependency (offline SDK + fixtures), works offline / with no emulator.

```json
"serve-mock": {
  "executor": "nx:run-commands",
  "options": {
    "command": "pnpm nx serve mobile --configuration=mock"
  }
}
```

Files: `apps/mobile/project.json`.

### Task 4 — [sequential] Keep `serve-emulator` exactly as-is

**Do not modify** the `serve-emulator` target. It must retain its
`dependsOn: [{ "target": "build", "projects": ["functions"], "configuration": "development" }]`
(spec 0027), its two parallel commands (`firebase emulators:start` +
`serve mobile -c emulator`), and `parallel: true`. This task is a verification
step only — confirm the target is byte-for-byte the spec-0027 shape after all
other edits.

### Task 5 — [sequential] Add `serve-prod-debug` (NEW)

Unoptimized + sourcemapped build wired to **real prod Firebase**. Because the
`prod-debug` build config's `fileReplacements` target
`environment.generated.ts` (gitignored, produced by the inject script, spec
0026), this target **must run inject-env FIRST**, then serve. `parallel: false`
so injection completes before the serve build reads the generated file.

```json
"serve-prod-debug": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "node tools/scripts/inject-mobile-env.mjs",
      "pnpm nx serve mobile --configuration=prod-debug"
    ],
    "parallel": false
  }
}
```

If `.env.local` is missing/incomplete, the first command **fails loudly (exit 1)
naming the exact missing key** — that is the intended guard, not a bug (see
Risks). Files: `apps/mobile/project.json`.

### Task 6 — [sequential] Add `serve-prod` (NEW)

Optimized production build vs real prod Firebase, for final pre-deploy checks.
Same inject-first pattern, `parallel: false`, but serves the existing
`production` config.

```json
"serve-prod": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "node tools/scripts/inject-mobile-env.mjs",
      "pnpm nx serve mobile --configuration=production"
    ],
    "parallel": false
  }
}
```

Because `serve-prod` serves the **full `production` build config**, the
production **budgets and `outputHashing`** apply — a bundle-size budget
warning/error can surface on this dev serve exactly as it would in a CI
production build. That is expected (pre-empts "why did a serve fail a budget?"),
not a bug. Files: `apps/mobile/project.json`.

### Task 7 — [sequential] Rename `android-debug` → `android-usb` with the device-install sequence

**Delete the `android-debug` target name** and replace it with `android-usb`. The
new sequence builds the prod-parity APK and then **installs + launches it on the
USB-connected device** via `npx cap run android` (which builds → installs →
launches). `parallel: false` (strict ordering). The trailing
`node tools/scripts/gradlew.mjs assembleDebug` of the old target is replaced by
`npx cap sync android` + `npx cap run android`.

```json
"android-usb": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "node tools/scripts/inject-mobile-env.mjs",
      "node tools/scripts/inject-mobile-env.mjs --check-native",
      "pnpm nx run mobile:build",
      "npx cap sync android",
      "npx cap run android"
    ],
    "parallel": false
  }
}
```

Notes the implementer must preserve:
- Keep the `--check-native` preflight (asserts `android/app/google-services.json`,
  spec 0026) **before** the build/sync/run.
- `pnpm nx run mobile:build` uses the **default `production`** configuration
  (prod-parity APK, spec 0026) — do **not** add `--configuration`.
- `npx cap run android` replaces the previous assemble-only `gradlew` step; it is
  what adds the install + launch behavior.

Files: `apps/mobile/project.json`.

### Task 8 — [sequential] Remove `serve-static`, `android`, `open`

Delete all three target blocks from `apps/mobile/project.json`:
- `serve-static` (`@nx/web:file-server` over dist) — not referenced by CI, e2e,
  or any documented run path.
- `android` (`build` → `sync` → `open`) — redundant now that `android-usb`
  covers the device path.
- `open` (`npx cap open android`) — only consumed by the removed `android`
  target. Opening Android Studio remains a trivial one-liner
  `npx cap open android` if ever needed, so removing the target loses **no real
  capability** (state this in the docs edit too).

Files: `apps/mobile/project.json`.

### Task 9 — [sequential] Update `docs/setup/debug-apk-setup.md`

- §4 "Build the debug APK": change `pnpm nx run mobile:android-debug` →
  `pnpm nx run mobile:android-usb`, and rewrite the numbered step list to match
  the new sequence (inject env → `--check-native` → `mobile:build` →
  `cap sync android` → **`cap run android`** which builds, installs, and launches
  on the connected device — no separate manual install/Android-Studio step). Keep
  the existing ` ```powershell ` fence language on the command block (repo
  PowerShell convention).
- Add a **USB device prerequisite** note: the phone must be in developer mode
  with **USB debugging enabled**, connected over USB, and visible to
  `adb devices` before running `android-usb`.
- §5 device-verification checklist: change the
  `pnpm nx run mobile:android-debug` reference to `mobile:android-usb` and adjust
  the "install it on the device" line (the target now installs + launches
  directly; no manual sideload step).

Files: `docs/setup/debug-apk-setup.md`.

### Task 10 — [sequential] Update root `README.md` "Common commands" table

In `README.md` (repo root) "Common commands" table (~line 38), **replace the
single generic `pnpm nx serve mobile` row** with the 5 named scenario targets so
the root README is the canonical "how do I run this" reference. **Keep** the
build / lint / test / e2e rows. The new scenario rows (use this exact wording for
the "What it does / when to use" column):

| Command                              | What it does                                                              |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `pnpm nx run mobile:serve-mock`      | Mock data, **no Firebase dependency** — works offline; quickest UI loop   |
| `pnpm nx run mobile:serve-emulator`  | Dev build vs **emulated** Firebase (offline-capable); starts emulators    |
| `pnpm nx run mobile:serve-prod-debug`| Dev/**debuggable** build vs **REAL prod** Firebase — diagnose prod data    |
| `pnpm nx run mobile:serve-prod`      | **Optimized** prod build vs prod Firebase — final pre-deploy check         |
| `pnpm nx run mobile:android-usb`     | Build + **install + launch** on a USB-tethered phone                       |

Keep the existing `build` (`pnpm nx build mobile` / `functions`), lint, test, and
`e2e` rows. Files: `README.md`.

### Task 11 — [sequential] Update `apps/mobile/README.md`

Two edits to `apps/mobile/README.md`:

1. **Fix the removed `mobile:open` reference.** The "Android native build" flow
   lists `pnpm nx run mobile:open` (step 3) for opening Android Studio. Since
   `open` is removed, replace that step: point the one-command device path at
   `pnpm nx run mobile:android-usb`, and note that to open the project in Android
   Studio manually you can run the raw `npx cap open android` (no dedicated Nx
   target). Keep the rest of the section (prereqs, `google-services.json`,
   `mobile:sync`) intact.
2. **Add/update a "Run / build targets" section** with the **same 5-target
   table** as the root README (scenario + when to use it), plus:
   - a one-line note on the **kept primitives**: `build` (Angular application
     build; default `production`), `serve` (raw dev-server, default
     `development` — used by the e2e web server), `sync` (`cap sync android`),
     `inject-env` (generate `environment.generated.ts`);
   - a one-line note that `serve-prod-debug` / `serve-prod` / `android-usb`
     **require a populated `.env.local`** — `inject-mobile-env.mjs` runs first and
     **fails loudly (exit 1) naming the missing key** if any
     `TMDB_API_KEY` / `FIREBASE_*` value is absent.

`apps/mobile` is an app, not a lib, but CLAUDE.md's "READMEs stay current"
currency expectation applies here because this spec changes its public target
surface. Files: `apps/mobile/README.md`.

### Task 12 — [sequential] Update `CLAUDE.md` "Commands & definition of done (PLAN §5)"

In `CLAUDE.md` (root), the "Commands & definition of done (PLAN §5)" section
(~line 49) currently lists only the generic `pnpm nx serve` in its "Commands:"
line (~line 55–56). Augment it so an agent (and Claude) knows **which** run
target to use **when** — add the 5 named scenario targets with a one-line "use
when" for each, while **keeping the existing `pnpm nx test` / `pnpm nx lint` /
`pnpm nx build` / `pnpm nx e2e` / `firebase emulators:start` command lines**:

- `serve-mock` — UI/feature work with **no backend dependency** (offline; mocked
  Firebase + TMDB fixtures).
- `serve-emulator` — feature work against **emulated** Firebase / offline-capable.
- `serve-prod-debug` — diagnosing a **prod data** issue with a debuggable
  (unminified, sourcemapped) build against **REAL prod** Firebase.
- `serve-prod` — final **optimized** pre-deploy smoke check against prod Firebase.
- `android-usb` — on-device testing over USB (build + install + launch).

Add a one-line note that `serve-prod-debug` / `serve-prod` / `android-usb`
require a populated `.env.local` — `inject-mobile-env.mjs` runs first and **fails
loudly (exit 1) naming the missing key** if any `TMDB_API_KEY` / `FIREBASE_*`
value is absent. Files: `CLAUDE.md`.

> Reference sweep (verified at spec time): the only remaining references to the
> removed/renamed names are `apps/mobile/README.md:82` (`mobile:open`),
> `docs/setup/debug-apk-setup.md` (`android-debug`), and the root `README.md`
> "Common commands" `pnpm nx serve mobile` row, all handled above.
> `docs/specs/0020-*.md` and `docs/specs/0026-*.md` mention `mobile:open` /
> `mobile:android` / `android-debug` only as **historical record** of those
> specs' decisions — leave merged specs unedited (they describe the state at the
> time they shipped). The implementer should re-grep
> (`serve-static`, `mobile:android`, `android-debug`, `mobile:open`) across
> `docs/` and `**/README.md` to confirm nothing new appeared, and fix any
> non-historical run-path reference found.

## Test plan

Per PLAN §5 — this is a tooling/config change with no application logic, so the
pyramid surface is the build/serve/lint gates, not unit/component code.

- **Unit tests:** none — no logic added or changed. `inject-mobile-env.mjs` and
  its existing tests are untouched.
- **Component tests:** none — no UI changed.
- **e2e tests:** **No e2e flows required — tooling/config change only.** No
  user-facing route or action changes. **Critical regression guard:**
  `apps/mobile-e2e/playwright.config.ts` launches the web server via
  `npx nx run mobile:serve` with the **default `development`** configuration. The
  `serve` target, its `defaultConfiguration: "development"`, and the `development`
  build config (`useEmulators: true`, hardcoded emulator ports) **must remain
  unchanged** so e2e is not regressed — verify this explicitly. (No e2e flow is
  added or un-skipped; the existing affected e2e suite, run in the user's own
  terminal, must still pass.)
- **Automated gates the implementing agent can run:**
  1. `pnpm nx lint` (incl. Sheriff) — `apps/mobile/project.json` stays valid JSON
     and no module boundary is affected.
  2. `pnpm nx run mobile:build --configuration=prod-debug` — **only meaningful
     when `environment.generated.ts` already exists** (it is gitignored). The
     chicken/egg: the `prod-debug` build config alone assumes the generated file
     is present (which is why `serve-prod-debug` runs inject-env first). To
     exercise the config end-to-end the agent must first run
     `node tools/scripts/inject-mobile-env.mjs` (requires a populated
     `.env.local`); if `.env.local` is absent in this environment, record the
     prod-debug build as **verified-by-inspection only** (config block matches
     `production` except optimization/sourcemap/budgets/hashing) and flag the
     full build for the user's local run.
  3. `pnpm nx run mobile:build` (default `production`) still succeeds (likewise
     requires the generated env / `.env.local`; same fallback note).
- **Manual / needs-human verification (cannot run in CI or via Claude Code tools
  here):**
  - `pnpm nx run mobile:serve-prod-debug` and `mobile:serve-prod` against real
    `vultus-cab62` with a populated `.env.local` — confirm the served app has
    `useEmulators:false` and talks to real Firebase, and that `serve-prod-debug`
    is unoptimized + sourcemapped while `serve-prod` is optimized.
  - **`pnpm nx run mobile:android-usb` with a tethered phone — the device
    install + launch step CANNOT be verified in CI or via Claude Code tools
    (needs a physical USB-connected Android device, `adb devices` visible).
    Explicitly flag this as `needs-human` manual verification.**
  - The emulator/e2e gates run in the **user's own terminal** (the Firestore
    emulator / any Java NIO server cannot run via Claude Code tools in this
    environment).

## Definition of done

Tailored from the PLAN §5 checklist (no unit/component/e2e added — config + docs):

- [ ] `apps/mobile/project.json` has **exactly** these run/build targets:
      `build`, `serve`, `serve-mock`, `serve-emulator`, `serve-prod-debug`,
      `serve-prod`, `android-usb`, `sync`, `inject-env`. (`serve-static`,
      `android`, `open`, `android-debug` are **gone**.)
- [ ] `build` has a `prod-debug` configuration with the **same `fileReplacements`
      as `production`** (environment.ts → environment.generated.ts) and
      `optimization:false`, `extractLicenses:false`, `sourceMap:true`, **no
      budgets, no `outputHashing`**.
- [ ] `serve` has a `prod-debug` configuration → `mobile:build:prod-debug`, and
      its `defaultConfiguration` is **still `development`** with the `development`
      build config unchanged (e2e contract intact).
- [ ] The `serve` target's **`emulator` configuration**
      (`buildTarget: mobile:build:development`) is **unchanged** — deleting it
      would silently break `serve-emulator`.
- [ ] `serve-prod-debug` and `serve-prod` are `run-commands`, `parallel:false`,
      and run `node tools/scripts/inject-mobile-env.mjs` **before** the serve.
- [ ] `serve-emulator` is **unchanged** (spec 0027 `dependsOn` + parallel
      commands preserved).
- [ ] `android-usb` runs inject-env → `--check-native` → `mobile:build` (default
      production) → `cap sync android` → `cap run android`, `parallel:false`.
- [ ] `pnpm nx run mobile:serve` (default `development`) still serves for e2e —
      unchanged.
- [ ] `docs/setup/debug-apk-setup.md` and `apps/mobile/README.md` reference
      `mobile:android-usb` (not `android-debug`/`open`) and document the
      install-on-device behavior + USB prerequisites.
- [ ] Root `README.md` "Common commands" table has the **5 scenario rows**
      (`serve-mock`, `serve-emulator`, `serve-prod-debug`, `serve-prod`,
      `android-usb`) in place of the single `pnpm nx serve mobile` row, with the
      build/lint/test/e2e rows kept.
- [ ] `apps/mobile/README.md` has a "Run / build targets" section with the same
      5-scenario table, a note on the kept primitives (`build`, `serve`, `sync`,
      `inject-env`), and a note that `serve-prod-debug` / `serve-prod` /
      `android-usb` require a populated `.env.local` (inject runs first, fails
      loudly on a missing key).
- [ ] `CLAUDE.md`'s "Commands & definition of done (PLAN §5)" section names the
      5 scenario targets with a one-line "use when" for each (mock / emulator /
      prod-debug / prod / android-usb) and the `.env.local` requirement note,
      with the existing test/lint/build/e2e/emulator command lines kept.
- [ ] `pnpm nx lint` (incl. Sheriff) passes; `project.json` remains valid JSON.
      Typecheck/build green for affected projects (build subject to the
      `.env.local` caveat above; flag if it can't run here).
- [ ] No secret is read or written; no new dependency, file, type, or runtime
      behavior is added.
- [ ] **`android-usb` device install/launch flagged `needs-human`** (physical
      device); emulator/e2e gates flagged for the user's own terminal.

## Risks

- **Chicken/egg on the generated env file (intended, not a bug).**
  `environment.generated.ts` is gitignored and produced by
  `inject-mobile-env.mjs` from CI env vars or repo-root `.env.local` (spec 0026).
  The `prod-debug` and `production` build configs `fileReplacement` it, so a bare
  `nx build --configuration=prod-debug`/`production` **assumes it already
  exists**. `serve-prod-debug` / `serve-prod` / `android-usb` therefore inject
  first; if `.env.local` is missing/incomplete the inject script exits 1 naming
  the exact missing key — **this loud failure is the intended guard.** A reviewer
  must not "fix" it by removing the inject step or making the build tolerate a
  missing generated file.
- **e2e regression surface.** The single biggest risk is accidentally changing
  the `serve` default or `development` build config — that would silently break
  the Playwright web server (`npx nx run mobile:serve`). The spec keeps both
  untouched; DoD gates it explicitly.
- **`cap run android` device requirement.** `npx cap run android` needs a
  detected target (USB device or running emulator). With none attached it errors;
  this is expected and is why device verification is `needs-human`. It is **not**
  a CI gate.
- **No PLAN conflicts.** This is a tooling-only consolidation: no architecture,
  data model, public type, or slice boundary changes. Sheriff governs imports,
  not Nx targets (spec 0027). TMDB/Trakt data-source accuracy is unrelated to
  this change.
- **Historical spec references.** Merged specs 0020/0026 mention the
  removed/renamed targets as a record of their own decisions; deliberately left
  unedited so they remain accurate to when they shipped.
