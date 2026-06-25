---
number: 0026
slug: debug-android-prod-parity
title: Inject real config/secrets at build time so a debug-signed Android APK has full production parity, keeping committed files key-free
status: implementing
slices: []
scopes: [scope:mobile]
created: 2026-06-25
---

# Inject real config/secrets at build time so a debug-signed Android APK has full production parity, keeping committed files key-free

## Context

A locally-built debug-signed Android APK currently **cannot behave like
production**: the mobile production build (which the APK uses) file-replaces
`environment.ts` → `environment.prod.ts`, but that file ships
**placeholders only** — Firebase web config `REPLACE_WITH_REAL_*` and TMDB key
`REPLACE_WITH_REAL_TMDB_API_KEY` (`apps/mobile/src/environments/environment.prod.ts`).
Separately, **`android/app/google-services.json` is already committed** (added by
spec 0020, status done) and currently holds a **real key-shaped** Firebase Android
`api_key` (`AIzaSy…`) + `mobilesdk_app_id` for `vultus-cab62`, package
`app.vultus.mobile`. So the repo is **not** currently key-free: a tracked file holds
a key-shaped value, and the web `environment.prod.ts` would still ship a
broken-search / broken-Firebase bundle because its values are placeholders.

The goal of this spec is **functional parity for a debug APK**: built locally (or
in CI) it must search real TMDB, add-to-watchlist against the real Firebase
project, populate provider-availability badges, and receive push — i.e. behave
like the production app — **while every committed file stays 100% free of
secrets and key-shaped values going forward.** "Key-free going forward" is the
precise goal: the env web config + TMDB key are injected at build time, and the
already-committed `android/app/google-services.json` is **untracked** (removed from
the index, added to `.gitignore`) and re-sourced per-machine / in CI. The public
Firebase Android `api_key` value **remains in past git history** — by deliberate,
documented decision we do **not** scrub history and do **not** rotate the key
(rationale below).

The pattern already exists in one place: spec 0015 injects the TMDB key **in CI**
via an ephemeral `sed` of `environment.prod.ts` in the runner working copy plus a
grep guard (`.github/workflows/ci.yml` lines ~64–82); the committed file always
keeps the placeholder. This spec **generalizes and unifies** that idea so the
**same mechanism** injects all real values — TMDB key, Firebase web config, and
`android/app/google-services.json` — for **both local and CI** builds, via a
**gitignored generated file** consumed through Angular `fileReplacements` (so we
never mutate a tracked file in place locally, which risks a commit leak). A **loud
build guard** must fail the build if any `REPLACE_WITH_*` placeholder or empty
required value survives into the build output, matching the "fail loud, never
silent" theme of specs 0021/0023.

For `google-services.json` the work is **untracking, not introducing**: the file is
already committed, so this spec runs `git rm --cached android/app/google-services.json`,
adds it to `.gitignore`, and re-sources it per-machine + in CI. `git rm --cached`
leaves each contributor's **working-copy** file in place (so local builds keep
working); CI writes it from a base64 secret before the native build; and the Gradle
plugin's existing **silent** "file absent → degrade" path is reconciled with our
loud-guard requirement (see §Public types and Task 3).

This spec is **pure infrastructure / native-build / config**. It changes **no
slice, no library public API, no Sheriff config, and no Firestore data model**.
It depends on onboarding spec **0022** (FCM token registration via
`@capacitor/push-notifications`, writing `users/{uid}.fcmTokens`) for the **push
parity** leg only. **0022 is now merged to `main`** (the `libs/mobile/onboarding`
slice ships the native registration path), so this dependency is **satisfied** —
the push leg is unblocked; device push verification remains a human/post-merge
on-device check.

### Decisions (already made — do not re-open)

1. **Backend: reuse prod `vultus-cab62`.** The debug APK talks to the same
   Firebase project the deployed functions (`syncTitles`, `dispatchNotifications`)
   live in. Debug data mixing into prod Firestore is **accepted** (personal
   single-user tracker). **No separate dev Firebase project.**
2. **Full push parity is in scope**, with a **hard dependency on spec 0022** (the
   native FCM registration path). **0022 is merged** — the dependency is satisfied;
   device push verification is a human/post-merge on-device check.
3. **Inject EVERYTHING; committed files stay key-free.** Committed env files keep
   placeholders only. At build time, real values are injected into a **gitignored
   generated file** consumed via Angular `fileReplacements` — **never** `sed` a
   tracked file in place locally. Local value source = a gitignored
   `.env.local`-style file; CI value source = GitHub Actions secrets/variables.
   Injected values: (a) **TMDB API key** (a real secret), (b) **Firebase web
   config** (public but key-shaped — inject it too for repo cleanliness),
   (c) **`google-services.json`** (decision 4). A **loud build guard** FAILS the
   build if any `REPLACE_WITH_*` placeholder or empty required value survives into
   the build output. The existing 0015 CI TMDB injection is **unified** into this
   single mechanism so local and CI share one path.
4. **`google-services.json`: untrack + inject — a DELIBERATE DEVIATION from
   PLAN §7.** The file is **already committed** (spec 0020). PLAN §7 (lines ~497–503)
   explicitly instructs **committing** `google-services.json` as public client
   config. This spec **overrides** that to keep the repo uniformly key-free going
   forward (user preference: no key-shaped values in the working tree). The committed
   value is a Firebase Android `api_key` — **public-by-design** client config (unlike
   the Firebase **web** `apiKey`, it is equally public; neither is a private
   credential) — so this is a **repo-uniformity preference, not a security
   necessity**. The work: `git rm --cached android/app/google-services.json`, add it
   to `.gitignore`, then re-source it per-machine (from local config) and in CI from a
   base64 secret before the Gradle / `cap sync` build, with a **loud guard if absent**.
   The existing Gradle conditional apply (which **silently degrades** when the file is
   absent) is reconciled with the loud guard in Task 3.
5. **Untrack going forward only — do NOT scrub history, do NOT rotate the key.**
   (Settled user decision.) Because the value is a public-by-design Firebase Android
   `api_key`, a history rewrite has **low security value** and would **disrupt
   other open branches** (e.g. the in-flight 0024 PR; 0022 has since merged).
   "Key-free repo" here means key-free **going
   forward in the working tree**, with the deliberate, documented acceptance that the
   public value **remains in past history**. History-scrub (e.g. `filter-repo`) and
   key rotation are **explicitly out of scope** (see Scope, DoD, Risks).
6. **Debug build only.** Debug-signed APK. Release signing / Play Store are out of
   scope.
7. **Secrets rule (CLAUDE.md):** the implementer/Claude **never reads or writes**
   `.env.local` or any secret. This spec **defines slot/key NAMES only**; the user
   supplies values. Reuse the existing CI secret name `TMDB_API_KEY`.

## Scope

In scope:

- **A single, unified injection mechanism** (local + CI) that writes real values
  into a **gitignored generated env file** consumed via Angular `fileReplacements`.
- **Generated env file + `fileReplacements` wiring** into the production build so
  the APK build (which uses `mobile:build` → defaultConfiguration `production`)
  consumes the injected values, not the placeholder `environment.prod.ts`.
- **Inject the TMDB key + Firebase web config** into that generated file from the
  local source (gitignored) and from CI secrets/variables.
- **`google-services.json` untracking + provisioning:** `git rm --cached
android/app/google-services.json`, add it to `.gitignore`, keep the local
  working-copy file per-machine, and in CI decode it from a base64 secret to
  `android/app/google-services.json` before the Gradle / `cap sync` build;
  **verify/keep** the existing Gradle `com.google.gms.google-services` plugin wiring;
  **loud guard** that hard-fails the debug-APK build if the file is absent (so the
  Gradle silent-degrade path is never reached).
- **Loud build guard(s):** fail the build if any `REPLACE_WITH_*` placeholder or
  empty required value survives into the build output (env injection), and if
  `android/app/google-services.json` is missing at native build time.
- **`.gitignore` entries** for the generated env file + `android/app/google-services.json`.
- **A debug-APK build flow / Nx target** (debug-signed) that runs the injection,
  the guard, the production web build, `cap sync`, and the Gradle debug assemble.
- **Unify the existing 0015 CI TMDB injection** into this mechanism (edit
  `.github/workflows/ci.yml` so it writes the generated file instead of `sed`-ing
  the tracked `environment.prod.ts`).
- **Manual-prereq documentation** (the slot/key names the user must populate) and a
  **human device-verification checklist**.

Out of scope (each stated explicitly):

- **Git history scrub + key rotation** (decision 5). The public Firebase Android
  `api_key` already in committed history is **left as-is** — no `filter-repo`/BFG
  rewrite, no key rotation. "Key-free" is **going-forward in the working tree**.
- **The onboarding / FCM token feature itself** — that is spec **0022**; this spec
  only makes the on-device push path _reachable_ by re-sourcing
  `android/app/google-services.json` + native Firebase config.
- **Any new app feature, slice, page, component, or UI** — search / watchlist /
  title-detail / onboarding screens already exist; this spec only makes them reach
  real services on-device.
- **A separate dev Firebase project** (decision 1: reuse `vultus-cab62`).
- **Release signing / Play Store / app-bundle (.aab)** (decision 5: debug only).
- **iOS** — Android only.
- **Any Firestore data-model, index, converter, or security-rule change.**
- **Changing the emulator-first dev `environment.ts`** — it stays
  `useEmulators: true` with the `demo-` placeholders, untouched.
- **The CI emulator integration / e2e / functions deploy-preflight gates** — left
  as-is except for the unified TMDB injection step.

## Affected slices & Sheriff tags

**None.** This is infrastructure / tooling / native-build + config. It adds **no
slice, no library, no lib public-API change, no cross-slice import, and no
`sheriff.config.ts` change.** `slices: []`; `scopes: [scope:mobile]` is
**descriptive only** (this is the mobile app's build/config leg) and drives no
Sheriff rule. There is **no DRY / 3+-slice** question because no shared logic is
added across slices.

Files touched (no slice library among them):

- `apps/mobile/src/environments/*` — keep placeholder `environment.prod.ts`
  untouched; add the **generated** (gitignored) env file as the new
  `fileReplacements` target (see Public types / APIs).
- `apps/mobile/project.json` — Nx targets (`fileReplacements` wiring + new debug
  build target/flow; do **not** touch the `mock`/`development` configs).
- `android/app/build.gradle`, `android/build.gradle` — **verify/keep** the existing
  `com.google.gms.google-services` plugin wiring (classpath + conditional apply,
  already present); reconcile its silent-degrade path with the loud guard (Task 3).
  No new classpath is needed — it already declares
  `com.google.gms:google-services:4.4.4`.
- `android/app/google-services.json` — **untracked** (`git rm --cached`), gitignored,
  re-sourced per-machine + in CI.
- `android/.gitignore` (and/or root `.gitignore`) — un-comment / add the
  `google-services.json` entry (the `android/.gitignore` template ships it
  **commented out**: `# google-services.json`).
- `.github/workflows/ci.yml` — unify the TMDB injection into the generated-file
  mechanism (and inject Firebase web config); possibly a new/extended step for the
  generated file. (A separate APK-build workflow is **optional** and may be
  deferred — see task graph.)
- `tools/scripts/*` — a new injection + guard script (root Node ESM tool, sibling
  in style to `functions-deploy-preflight.mjs`).
- `.gitignore` (root) — entries for the generated env file (the local env source is
  already covered by the existing `.env.local` / `.env*.local` rules at lines 18–19).

Sheriff governs **import boundaries between projects**; it does not police a root
`tools/` script, an Nx `project.json`, repo-root `android/` Gradle files, a workflow
YAML, or `.gitignore`. `mobile` **is** in the `nx affected` set (its `project.json`
is edited). Routes to **infrastructure-engineer** at implementation time.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security-rule
change. The debug APK **reuses existing, already-defined** data:

- `users/{uid}` (+ `fcmTokens`, written by spec 0022's native registration path),
- `users/{uid}/watchlist` (add-to-watchlist),
- `title-cache/{tmdbId}/availability/{region}` (provider-availability badges,
  refreshed by the deployed `syncTitles`).

All are already defined (PLAN §4). `firestore.rules` / `firestore.indexes.json`
are **untouched** — confirm (do not change) that the existing rules already permit
the anonymous owner's `users/{uid}/watchlist` writes; if they did not, that would
be a separate spec, not this one.

## Public types / APIs

**None** in the application sense — no new/changed TypeScript types, function
signatures, callable shapes, or HTTP endpoints. `environment.prod.ts`'s exported
`environment` **shape is unchanged**; the generated file is a value-substituted
copy of that exact shape.

The only new "interfaces" are **build-time contracts**:

1. **Generated env file (gitignored).** A file (recommended name
   `apps/mobile/src/environments/environment.generated.ts`) exporting the **same
   `environment` object shape** as `environment.prod.ts`, with real values
   substituted. The production build's `fileReplacements` is rewired to use this
   file as the `with:` target so the placeholder `environment.prod.ts` is never the
   built source. The generated file is produced by the injection script (below) and
   is **never committed**.

2. **Injection-source slot/key NAMES** (the user supplies values; the implementer
   defines only the names). Recommended:
   - **Local source:** a gitignored env file (e.g. `.env.local` at repo root, or a
     dedicated `apps/mobile/.env.local`) holding the keys below. The implementer
     picks one location and documents it; it must be covered by `.gitignore`.
   - **CI source:** GitHub Actions **secrets**/**variables**.
   - Keys (refine names if needed, but keep them explicit and documented):
     - `TMDB_API_KEY` — **reuse** the existing CI secret name (a real secret).
     - `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_STORAGE_BUCKET`,
       `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID` — Firebase web config
       (public but key-shaped; injected for repo cleanliness).
     - `projectId` is **fixed** to `vultus-cab62` (not injected — hardcoded, matching
       both committed env files).
     - `GOOGLE_SERVICES_JSON` — a **base64-encoded** `google-services.json`, decoded
       to `android/app/google-services.json` (repo-root `android/`) in CI.

3. **Loud-guard invariant (the hard contract).** After a successful build:
   - the generated env file and the built web bundle contain **zero**
     `REPLACE_WITH_*` placeholders and **no empty required value**
     (`apiKey`/`authDomain`/`storageBucket`/`messagingSenderId`/`appId`/TMDB
     `apiKey` are all non-empty), and
   - `android/app/google-services.json` **exists** at native-build time.
     Any violation **fails the build with an actionable message** (which key is
     missing, where to set it locally vs. CI).

4. **Injection script CLI** (new `tools/scripts/*.mjs`): a node ESM script,
   invokable via an Nx target, that (a) reads the value source (local env file or
   CI env vars), (b) writes the generated env file by substituting into the
   `environment.prod.ts` shape, (c) runs the placeholder/empty guard. Exit `0` =
   all values present and written; exit `1` = first missing/empty value, with an
   actionable message. **Side-effect-on-import must be guarded** (an
   `import.meta.url === \`file://${process.argv[1]}\`` main check, or a sibling pure
   helper) so a Vitest import does not run the script against the real cwd — same
   caution as spec 0023.

## UI / Stitch screen refs

**Not applicable.** No new screens, components, or design tokens. The existing
search / watchlist / title-detail / onboarding screens render unchanged; this spec
only makes them reach real services on-device. No Stitch fetch is required. (Visual
fidelity of those screens is the concern of their own specs, not this one.)

## Implementation task graph

All tasks are **infrastructure-engineer** territory; none touches a Sheriff slice.
The edits are small, interdependent config changes verified together at the end, so
they are **[sequential]** (no parallel fan-out value — consistent with how 0023
framed it). No `[parallel]` tasks, so no file manifests for disjointness; per-task
files are listed for clarity.

### 1. [sequential] Injection script + loud guard + generated-file `fileReplacements` wiring

Files: `tools/scripts/<inject-mobile-env>.mjs` (new),
`tools/scripts/<inject-mobile-env>.spec.mjs` (new, if unit-tested — see Test plan),
`apps/mobile/project.json` (`fileReplacements`), `.gitignore`.

- Write the injection script (node ESM, style modeled on
  `tools/scripts/functions-deploy-preflight.mjs`: numbered steps, `ok()`/`fail()`
  helpers, synchronous `fs`, actionable failure messages). It:
  - resolves the value source — **CI env vars take precedence**; otherwise read the
    gitignored local env file (decide and document a single local location). If a
    required value is missing/empty from both, `fail(...)` with a message naming the
    exact key and **both** where to set it (local file vs. GitHub secret/variable).
  - generates `apps/mobile/src/environments/environment.generated.ts` by
    substituting real values into the **exact `environment.prod.ts` shape**
    (`production: true`, `useEmulators: false`, fixed `projectId: 'vultus-cab62'`).
  - runs the **placeholder/empty guard**: assert the generated content contains no
    `REPLACE_WITH_*` and no empty required value; `fail(...)` otherwise.
- Rewire `apps/mobile/project.json` **production** `fileReplacements` to use the
  **generated** file as the `with:` target (placeholder `environment.prod.ts` stays
  in the repo as the documented template; the generated file is what builds). Leave
  `mock` and `development` configs **untouched**.
- Add `.gitignore` entries: the generated env file
  (`apps/mobile/src/environments/environment.generated.ts`) in the root `.gitignore`.
  The local env source location is **already covered** by the existing
  `.env.local` / `.env*.local` rules (root `.gitignore` lines 18–19) — confirm, don't
  duplicate. The `android/app/google-services.json` untrack + gitignore is handled in
  **Task 3** (un-comment the `# google-services.json` line in `android/.gitignore`).

### 2. [sequential] Wire injection into the build + unify the CI TMDB step

Files: `apps/mobile/project.json` (run injection before build), `.github/workflows/ci.yml`.

- Make the production build run the injection script **first** (e.g. an Nx target
  that runs the script then `mobile:build`, or `dependsOn`/`run-commands` wiring) so
  `environment.generated.ts` exists before Angular's `fileReplacements` reads it. A
  build with a missing generated file (or a guard failure) **fails loudly**.
- **Unify the CI injection.** In `.github/workflows/ci.yml` **replace** the
  `Inject TMDB API key for production build` step (lines ~64–82, which `sed`s the
  tracked `environment.prod.ts`) with a step that runs the **same injection script**
  from CI env, sourcing `TMDB_API_KEY` (secret) and the `FIREBASE_*` web-config
  values (secrets/variables). The committed `environment.prod.ts` is **no longer
  mutated** in CI. Keep the fail-fast behavior (the script's guard already fails if
  a value is absent). Run `actionlint` on the changed workflow as part of the gate.
  - Note: CI's `build` gate builds the web bundle (no APK), so CI exercises the **env
    injection + guard** path. `google-services.json` (Task 3) is a **native-build**
    artifact and is **not** needed by the CI web build — but the CI build proves the
    generated env file + guard work end-to-end.

### 3. [sequential] `google-services.json` untrack + gitignore + Gradle reconcile + guard

Files: `android/app/google-services.json` (`git rm --cached`),
`android/.gitignore` (un-comment the `# google-services.json` line),
`android/app/build.gradle` + `android/build.gradle` (**verify/keep** — see below),
`.github/workflows/*` (CI decode step — extend `ci.yml` or a new APK workflow).

- **Untrack the already-committed file.** Run
  `git rm --cached android/app/google-services.json` (index-only removal — the
  contributor's **working-copy file is preserved**, so existing clones keep building).
  Then un-comment the `# google-services.json` line in `android/.gitignore` (the
  Android template ships it commented out) so it is ignored going forward. Verify
  `git status` shows the file untracked + ignored (not deleted from disk). **Do NOT**
  rewrite history or rotate the key (decision 5).
- **Verify/keep the existing Gradle wiring (do NOT re-add).** `android/build.gradle`
  already declares `classpath 'com.google.gms:google-services:4.4.4'` (~line 11) and
  `android/app/build.gradle` already **conditionally** applies
  `com.google.gms.google-services` gated on `file('google-services.json')` existing
  (~lines 47–54). Confirm both are present; change nothing in the Gradle conditional.
- **Reconcile the silent-degrade vs. the loud guard.** The existing Gradle conditional
  **silently degrades** (logs "Push Notifications won't work" and skips the plugin)
  when the file is absent — this conflicts with our fail-loud requirement. **Chosen
  approach:** _keep_ the Gradle conditional apply as-is (it is the upstream
  Capacitor-generated default; making it unconditional would only swap a soft skip for
  an opaque Gradle error and fight every `cap sync` regeneration), and add a
  **separate pre-build preflight guard** in the Nx debug-APK flow (Task 4) that
  **hard-fails before Gradle runs** when `android/app/google-services.json` is missing.
  In the debug-APK flow the silent-degrade branch is therefore **never reached** —
  the preflight stops the build first with an actionable message. (Rationale: the guard
  owns the loud contract; Gradle stays survivable for non-APK / IDE flows.)
- **Local:** the contributor keeps their working-copy `android/app/google-services.json`
  per-machine; new clones obtain it from the Firebase console (documented prereq —
  Task 5). The file is gitignored (this task).
- **CI:** add a step (in the build workflow that produces the APK — see Task 4)
  that decodes the `GOOGLE_SERVICES_JSON` base64 secret to
  `android/app/google-services.json` **before** `cap sync` / the Gradle build.
- **Capacitor note:** `npx cap sync android` copies web assets + plugin config into
  the native project; it does **not** generate, clobber, or re-add
  `google-services.json`. Confirm a `cap sync` after untracking leaves the
  working-copy / CI-decoded file intact.
- **Loud guard:** before the native build, assert
  `android/app/google-services.json` exists; if absent, **fail with an actionable
  message** (where to download it for `vultus-cab62`, package `app.vultus.mobile`, the
  base64 CI secret name `GOOGLE_SERVICES_JSON`, and that it is gitignored per
  decision 4). This may live in the injection script (a `--native` mode) or a tiny
  dedicated guard invoked by the debug build target — the implementer picks one and
  documents it.

### 4. [sequential] Debug-APK build flow / Nx target

Files: `apps/mobile/project.json` (new target, e.g. `android-debug` or
`build-apk-debug`), optionally `.github/workflows/<build-android-debug>.yml` (new,
`workflow_dispatch`).

- Add an Nx target that, in order: runs the **env injection + guard** (Task 1),
  asserts `android/app/google-services.json` present (Task 3 preflight guard — this is
  what makes the Gradle silent-degrade branch unreachable in this flow), runs
  `pnpm nx run mobile:build` (production web), `npx cap sync android`, then the
  **Gradle debug assemble** (`assembleDebug`) producing a debug-signed APK. (The
  existing `mobile:android` target ends at `cap open`; this new target produces the
  installable debug APK headlessly.)
- The CI APK workflow is **optional and may be deferred** — the device-verification
  flow is human/local. If added, it is `workflow_dispatch`, decodes
  `GOOGLE_SERVICES_JSON`, runs the injection from secrets, and uploads the debug APK
  as an artifact. Mark it explicitly if deferred.

### 5. [sequential] Docs (manual prereqs) + human device-verification checklist

Files: a doc under `docs/setup/*` (or extend the existing firebase-and-secrets
doc), and the spec's own checklist (below).

- Document the **manual prereqs**: the local env file location + the exact keys
  (`TMDB_API_KEY`, `FIREBASE_*`), where to obtain the Firebase web config (console →
  Project settings → web app SDK config), where to obtain `google-services.json`
  (console → Android app `app.vultus.mobile`) **for new clones** (existing clones
  already have the working-copy file after the index-only untrack), and the GitHub
  secret/variable names for CI (`TMDB_API_KEY`, `FIREBASE_*`, `GOOGLE_SERVICES_JSON`
  base64).
- Document the **PLAN §7 deviation** (google-services **untracked + gitignored**, not
  committed) and the build-time provisioning, so PLAN §7's "commit it" instruction is
  not followed by a later reader. Also document the **decision 5** acceptance: the
  public Android `api_key` remains in past history (no scrub, no rotation) — so a
  reader who finds it in `git log` knows it is intentional and harmless.
- Record the **human device-verification checklist** (Test plan below) as the real
  post-merge functional verification.

(No workspace lib is touched, so **no lib `README.md` update** applies.)

## Test plan

Per the PLAN §5 pyramid, pragmatic — the deliverable is build/config/native
tooling, so there is **no slice / component surface**.

- **Unit (Vitest), the injection script + guard.** Following the spec-0023
  precedent (`functions-deploy-preflight.mjs` is side-effecting at import, has no
  unit wiring), refactor the substitution + guard into a small **importable helper**
  guarded from running on import (an
  `import.meta.url === \`file://${process.argv[1]}\`` main check or a sibling pure
  module). Then test:
  - **(a)** all values present → generated content has real values, **no**
    `REPLACE_WITH_*`, no empty required field;
  - **(b)** a missing/empty required value (e.g. blank `FIREBASE_API_KEY`) → guard
    **fails** with an actionable message naming the key;
  - **(c)** missing local source **and** missing CI env → **fails** with an
    actionable "set it locally or in GitHub" message;
  - **(d)** the `google-services.json` presence guard **fails** when the file is
    absent (use a temp dir as the fake `android/app`).
    Use `node:os` `tmpdir` + `node:fs`. **Keep it small**; if exporting the helper
    meaningfully distorts the script, fall back to the build gate below and **record
    why in the PR** (same hedge as 0023).
- **Build gate (CI-runnable, the concrete green gate):**
  1. with the injection sourcing values (CI secrets, or local file), run the
     production build (`pnpm nx run mobile:build`);
  2. assert it **succeeds** and a guard confirms the built bundle (under
     `dist/apps/mobile`) contains **no** `REPLACE_WITH_*` placeholder and no empty
     required config value;
  3. `nx affected -t typecheck lint build --base=main` green for `mobile`;
  4. `actionlint` green on the changed `ci.yml` (and any new workflow).
- **e2e: NO new automated e2e flows.** Search / add-to-watchlist are **already
  covered** by the spec-0019 Playwright suite (run against the Auth + Firestore
  emulators with committed TMDB fixtures); this spec changes only _config injection_,
  not those routes/actions, so it adds **no new flow and un-skips nothing**. **Device
  push cannot run in CI** (needs a real Android device + real creds + merged 0022).
  Stated explicitly so the reviewer does not flag a missing e2e — per the
  PLAN §5 e2e rubric this is "Not required — build/config/native change only; no new
  route or action introduced."
- **Human device verification (cannot run in-session — needs a physical Android
  device + real creds + merged 0022).** This is the **real functional
  verification** (flagged human/post-merge, as specs 0017/0021/0023 did):
  1. Populate the local env file (`TMDB_API_KEY`, `FIREBASE_*`) and ensure
     `android/app/google-services.json` (repo-root `android/`) for `vultus-cab62` is
     present in the working tree (existing clones already have it post-untrack; new
     clones download it from the console).
  2. Build the **debug APK** via the new target (injection + guards run) and install
     it on the device.
  3. App **boots** against real `vultus-cab62` (anonymous sign-in succeeds).
  4. **Onboarding (0022):** pick region + grant push permission → FCM token written
     to `users/{uid}.fcmTokens`.
  5. **Search** returns **real TMDB** results.
  6. **Add to watchlist** persists (visible in `users/{uid}/watchlist`).
  7. Trigger a sync (manual spec-0025 trigger if merged, else the daily cron) →
     **provider-availability badges populate** from
     `title-cache/{tmdbId}/availability/{region}`.
  8. An **availability change delivers a real push** on the device (via the deployed
     `dispatchNotifications`).

## Definition of done

Tailored from the PLAN §5 checklist. `mobile` **is** affected (its `project.json`
is edited), so its `nx affected` targets apply.

- [ ] **Working tree contains zero secrets / key-shaped values going forward** —
      `environment.prod.ts` keeps its `REPLACE_WITH_*` placeholders (untouched), the
      generated env file is **gitignored**, `android/app/google-services.json` is
      **untracked + gitignored**, and CI no longer `sed`s the tracked
      `environment.prod.ts`.
- [ ] **`android/app/google-services.json` untracked** — `git rm --cached` run, the
      file added to `.gitignore` (`android/.gitignore` line un-commented), the
      working-copy file **preserved on disk** (not deleted), and `git ls-files
    android/app/google-services.json` returns **nothing**.
- [ ] **History scrub + key rotation explicitly NOT done** (decision 5) — the public
      Android `api_key` in past history is left as-is; this is documented as
      intentional (no `filter-repo`/BFG, no rotation), avoiding disruption to open
      branches (e.g. the in-flight 0024 PR; 0022 has since merged).
- [ ] **A single unified injection mechanism** produces the gitignored generated env
      file for **both** local and CI builds (the 0015 CI TMDB step is replaced by it).
- [ ] The production build's `fileReplacements` uses the **generated** file; the
      `mock`/`development` configs are untouched; dev `environment.ts` (emulator-first)
      is unchanged.
- [ ] **Loud env guard:** the build **fails** if any `REPLACE_WITH_*` placeholder or
      empty required value survives into the build output, with an actionable message.
- [ ] **`google-services.json` provisioning:** untracked + gitignored, working-copy
      preserved locally, decoded from `GOOGLE_SERVICES_JSON` in CI, existing Gradle
      `com.google.gms.google-services` wiring **verified/kept** (classpath +
      conditional apply unchanged), and a **separate pre-build preflight guard**
      hard-fails the debug-APK build if the file is absent (so the Gradle
      silent-degrade path is never reached). `cap sync` confirmed not to clobber it.
- [ ] A **debug-signed APK** builds (via the new Nx target) with real config injected.
- [ ] **Manual prereqs documented** (local env file location + key names + where to get
      the Firebase web config and `google-services.json` + the CI secret/variable
      names) and the **human device checklist** recorded and flagged human/post-merge.
- [ ] The **PLAN §7 google-services deviation** (untrack + gitignore, not commit) is
      **explicitly noted and justified** — the committed value is a public-by-design
      Firebase Android `api_key`, so the deviation is **repo uniformity/preference, not
      security necessity**.
- [ ] The **dependency on spec 0022** (push parity) is stated; device push verification
      is gated on 0022 merge.
- [ ] **No Firestore data-model / index / rule change**; `firestore.rules` /
      `firestore.indexes.json` untouched.
- [ ] **No secret committed** — only slot/key NAMES are defined; the user supplies
      values. Any in-session build gate uses dummy non-secret placeholders, not
      committed.
- [ ] Standard gates green: `nx affected -t typecheck lint build --base=main` for
      `mobile`; `actionlint` on the changed workflow(s); the build guard asserts no
      placeholder/empty value in `dist/apps/mobile`; unit test green (or its skip
      recorded per the pragmatic-pyramid hedge).
- [ ] **No new automated e2e flow** — explicitly recorded (config/native change; search + add already covered by 0019; device push is human-only).

## Risks

- **PLAN §7 deviation (google-services untracked + gitignored).** PLAN §7 (~497–503)
  instructs **committing** `google-services.json`; the file is in fact **already
  committed** (spec 0020). This spec **overrides** that and **untracks** it for a
  uniformly-key-free-going-forward repo. The committed value is a public-by-design
  Firebase Android `api_key` (no private key), so the deviation is a **preference, not
  a security requirement** — the cost is that every machine + CI must provision the
  file before a native build (mitigated by the loud guard + documented prereq).
  Reviewers should weigh this as a stated, justified override, not an accident.
- **History retains the public key (accepted, decision 5).** Because we untrack
  **going forward only** (no `filter-repo`/BFG, no key rotation), the public Android
  `api_key` remains reachable in `git log`. Accepted: the value is public-by-design,
  so a rewrite has low security value and would disrupt **open branches** (e.g. the
  in-flight **0024** PR; **0022** has since merged) by rebasing every contributor onto
  rewritten history. Documented so no one mistakes the historical value for a leak
  requiring remediation.
- **`git rm --cached` must not delete working copies.** The index-only removal keeps
  each contributor's on-disk file so local builds keep working; the implementer must
  verify the file still exists on disk after the command and that `git status` shows
  it untracked/ignored (not staged-for-deletion). New clones get nothing and must
  fetch the file from the console (documented prereq) — the loud guard catches the
  "new clone forgot it" case.
- **Debug APK writes into prod Firestore.** Accepted (decision 1; single-user
  personal tracker). No data isolation is added; debug + real data coexist in
  `vultus-cab62`.
- **Local injection must not dirty or leak into tracked files.** The whole mechanism
  exists to avoid the 0015 `sed`-the-tracked-file commit-leak risk. The mitigation is
  the **gitignored generated file** (the placeholder `environment.prod.ts` is never
  mutated) plus the `.gitignore` entries; the implementer must verify a clean
  `git status` after a local build (no generated/secret file shows as tracked).
- **Firebase web `apiKey` is public-by-design.** Injecting the `FIREBASE_*` web config
  is a **repo-cleanliness choice**, not a security requirement — these values ship in
  every client. Called out so the reviewer understands why a "public" value is treated
  like a secret here (uniform key-free repo), and so no one concludes the app's
  security depends on hiding them (it does not — Firestore rules are the gate).
- **`google-services.json` absence → silent feature loss, not a loud failure (if
  unguarded).** The existing Gradle conditional **silently skips** the
  `com.google.gms.google-services` plugin when the file is absent (logging only "Push
  Notifications won't work"), so an unguarded build would produce a push-broken APK
  with no error. Mitigated by the **separate pre-build preflight guard** (Task 3/4)
  that hard-fails the debug-APK flow before Gradle runs, with an actionable message —
  so the silent-degrade branch is never reached in this flow.
- **Push leg depends on spec 0022 (now merged).** The push leg (FCM token
  registration) is owned by spec 0022, which is **merged to `main`** (the
  `libs/mobile/onboarding` slice), so the dependency is **satisfied** and the
  device checklist's push/onboarding steps can be exercised once this spec lands.
  This was always a **dependency, not a conflict** — the injection + guard +
  APK-build legs are independently verifiable regardless.
- **Testability refactor is minor scope creep.** Exporting a small helper to unit-test
  the substitution/guard is recommended, but the **build gate is the primary
  verification**; skipping the unit test (recorded in the PR) is acceptable per the
  pragmatic-pyramid guidance, exactly as spec 0023 hedged.
- **No architecture conflict (besides the noted §7 override).** This adds no slice, no
  cross-slice import, no shared code, and no data-model change; it generalizes the
  existing 0015 build-time-injection pattern. The stale PLAN §7 "Spark plan" lines
  (project is on **Blaze**) are unrelated and untouched.
