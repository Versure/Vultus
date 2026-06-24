---
number: 0020
slug: capacitor-android-build
title: Wire the Capacitor Android platform — add android/, app icon + splash, FCM plumbing, and Nx sync/open targets so the app builds and runs as a debug APK on a device
status: done
slices: []
scopes: [scope:mobile]
created: 2026-06-24
---

# Wire the Capacitor Android platform — add `android/`, app icon + splash, FCM plumbing, and Nx sync/open targets so the app builds and runs as a debug APK on a device

## Context

PLAN §6 item 21 — **Capacitor Android build** — is the polish task that turns the
web-only Ionic + Angular app into something installable on a physical Android
device. Every mobile slice now exists (specs 0010–0019: the tabs shell with
AngularFire init + anonymous auth, the settings / search / watchlist /
title-detail slices, and the e2e harness), but **the app has never been built or
run natively**. The Capacitor _config_ exists at the repo root
(`capacitor.config.ts`: `appId: 'app.vultus.mobile'`, `appName: 'Vultus'`,
`webDir: 'dist/apps/mobile/browser'`) and `@capacitor/android` + `@capacitor/cli`
v8 are installed — but **`cap add android` has never been run**, so there is no
`android/` native project, no Gradle wrapper, no generated launcher icon or
splash, and no `google-services.json`. There is therefore no way to produce an
APK today.

This spec wires the Android side end-to-end so an APK can be built and
sideloaded:

- **Add the `android/` native project** (`npx cap add android`) and commit it.
- Generate a **launcher icon** and a **splash screen** (matching the Stitch
  design) from source assets via **`@capacitor/assets`**.
- Wire the **FCM / push-notifications** native plumbing: add the
  `@capacitor/push-notifications` Capacitor plugin (it is **not yet installed** —
  see Risks; the settings slice only writes `fcmTokens: []` and registers no
  token today), so `cap sync android` resolves it and `google-services.json`
  enables FCM on the device.
- Add **Nx targets** `mobile:sync` (`cap sync android`) and `mobile:open`
  (`cap open android`), both with `mobile:build` as a prerequisite, so agents and
  the user have a one-command native sync.
- **Document the manual prerequisites** the implementer/user must do by hand —
  primarily downloading `google-services.json` from the Firebase console for
  `vultus-cab62` and placing it at `apps/mobile/android/app/google-services.json`
  (committed — it carries no private key, see Data model / Risks), and having
  Android Studio + the Android SDK installed to assemble and install the debug
  APK.

Intended outcome: after this lands, `pnpm nx run mobile:build` produces the web
assets, `pnpm nx run mobile:sync` copies them into the `android/` project with
all Capacitor plugins resolving cleanly, and opening the project in Android
Studio (or `pnpm nx run mobile:open`) lets the user assemble a **debug APK** that
installs and **boots on a real Android device**: Firebase initialises without a
native crash, the Stitch-matched splash shows on launch, the launcher icon
appears, and the FCM plugin loads without error (so the settings slice's future
token registration continues to work).

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Debug APK only.** No signing config, no release flavour, no Play Store
   listing. Sideloading the debug APK via Android Studio / ADB is sufficient for
   v1. Do **not** add a keystore, `signingConfigs`, or a `release` build wiring.

2. **`google-services.json` is a MANUAL prerequisite (cannot be automated).** It
   must be downloaded from the **Firebase console** for project **`vultus-cab62`**
   (Project settings → Your apps → the Android app with package
   `app.vultus.mobile` → `google-services.json`) and placed at
   **`apps/mobile/android/app/google-services.json`**. The implementer registers
   the Android app in the console **only if it does not already exist** (package
   name **`app.vultus.mobile`**, matching `capacitor.config.ts` `appId`). **This
   file is NOT a secret** — it contains only public client identifiers (project
   id, app id, the public Android API key, the GCM sender id), **no private key**
   — so it **is committed to the repo** (do _not_ gitignore it; that is the
   normal, recommended Firebase Android setup). This is distinct from the
   service-account JSON (a real secret, used only by functions, never here).

3. **Splash screen matches the Stitch design.** The implementer **must fetch the
   relevant Stitch splash/launch screen** (project
   **`projects/13590348714018893783`** — "Vultus Android App Design") via the
   `stitch` MCP and implement the splash to match it, generated through
   **`@capacitor/assets`** from a source PNG plus the native splash plugin
   (`@capacitor/splash-screen`). See UI / Stitch screen refs — the Stitch screen
   ID could **not** be captured in this spec-authoring session (no `stitch` tool
   available here; consistent with spec 0013), so capturing it is a **blocking
   implementer step**, not a prose-only fallback.

4. **App icon from a 1024×1024 source PNG via `@capacitor/assets`.** A
   **placeholder is acceptable for now**: a simple `surface`-navy
   (`#0b1326`) square with a centred Emerald-on-navy "V" (or the Vultus mark if a
   real logo asset is supplied). `@capacitor/assets` generates the full Android
   mipmap/adaptive-icon set + the splash densities from the source assets. The
   _recipe_ (source asset paths, the generate command, the config) is specified;
   the exact glyph is the implementer's call within the design tokens.

5. **FCM plumbing only — no permission prompt, no token registration UI.** This
   spec ensures `@capacitor/push-notifications` is **installed and in
   `package.json`**, synced into the `android/` project, and that
   `google-services.json` enables FCM so the plugin **loads without error** on the
   device. It does **NOT** add the runtime permission-request flow, does **NOT**
   call `PushNotifications.register()`, and does **NOT** write to
   `users/{uid}.fcmTokens`. **The notification-permission prompt + actual token
   registration is deferred to spec 0021 (onboarding).** (Note: contrary to the
   interview's phrasing, the plugin is **not** already used by the settings slice
   — spec 0011 explicitly deferred all FCM work to this item; see Risks.)

6. **Nx targets `mobile:sync` and `mobile:open`, with `mobile:build` first.** Add
   `sync` (`npx cap sync android`) and `open` (`npx cap open android`) targets to
   `apps/mobile/project.json`, each declaring `dependsOn: ["build"]` so the web
   bundle is fresh before a native sync. Agents run `pnpm nx run mobile:sync` /
   `pnpm nx run mobile:open`.

7. **`scope:mobile` only.** No `scope:functions` or `scope:shared` lib changes; no
   slice logic changes. This is native-platform + root-config + `apps/mobile`
   config wiring. `slices: []` (no slice lib is touched); the descriptive scope is
   `scope:mobile`.

## Scope

In scope:

- **`android/` native project**: run `npx cap add android` (Capacitor 8) to
  generate the Gradle project, commit it. Set the **`versionCode` / `versionName`
  / `applicationId`** (must be `app.vultus.mobile`) and the **app label**
  ("Vultus") to match `capacitor.config.ts`.
- **`@capacitor/push-notifications`** added to the **root `package.json`**
  `dependencies` (there is no `apps/mobile/package.json`; deps live only in the
  root manifest) — Capacitor-8-compatible version, pinned, lockfile updated, synced into
  `android/` (so the plugin's Gradle module + manifest entries are present).
- **`@capacitor/splash-screen`** added to `dependencies` (Capacitor-8-compatible,
  pinned) to drive the native splash; `@capacitor/assets` added to
  `devDependencies` to generate icon + splash assets.
- **Source assets** under `apps/mobile/resources/` (`icon.png` 1024×1024,
  `splash.png` 2732×2732 and/or `splash-dark.png`) and the generated Android
  assets under `apps/mobile/android/app/src/main/res/**`.
- **Splash configuration** in `capacitor.config.ts` (the `SplashScreen` plugin
  block: background colour from the design tokens, show/hide behaviour) matching
  the Stitch splash.
- **Nx targets** `mobile:sync` and `mobile:open` in `apps/mobile/project.json`,
  both `dependsOn: ["build"]`.
- **`google-services.json`** committed at `apps/mobile/android/app/` (the file
  itself is the manual prereq — see Data model / Risks; the spec documents the
  exact path + that it is committed).
- **Documentation**: update `apps/mobile/README.md` with the native-build recipe
  (the manual prereqs: Android Studio + SDK, `google-services.json` download +
  placement; the `nx build → nx sync → nx open → assemble debug APK → install`
  flow). Update `docs/PLAN.md` §7 manual-prereqs checklist with the
  `google-services.json` step if it is not already captured.

Out of scope (each its own later spec / explicitly excluded):

- **Notification permission request + token registration** (`PushNotifications.
requestPermissions()` / `.register()` / writing `users/{uid}.fcmTokens`) — **spec
  0021 (onboarding)** (decision 5).
- **Onboarding flow** (first-run region pick + notification permission) — spec 0021.
- **Release / signed APK, keystore, Play Store listing, app bundle (.aab)** —
  explicitly out (decision 1).
- **iOS** (no `ios/` platform; PLAN §1 puts iOS out of v1 scope).
- **CI pipeline changes to build the APK** — explicitly out (too expensive for
  personal use; native build stays a local Android-Studio step). **No `ci.yml`
  change.**
- **Any slice logic / UI change** — the slices are done (specs 0010–0019); this
  spec touches no `libs/**` source.
- **`firestore.rules` / `firestore.indexes.json` / `firebase.json` functions
  config** — untouched.

## Affected slices & Sheriff tags

This spec touches **no slice lib** (`slices: []`) — it is native-platform +
`apps/mobile` config + root dependency wiring, all `scope:mobile` or untagged
root/config files. **No `shared/` extraction** is involved (CLAUDE.md 3+-slice
rule is not engaged — no logic is shared or duplicated).

| Project / area   | Path                                                    | Sheriff tags   | Change                                                                                     |
| ---------------- | ------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| mobile (app)     | `apps/mobile`                                           | `scope:mobile` | new `android/` native project; `project.json` `sync`/`open` targets; `resources/`; README  |
| Capacitor config | `capacitor.config.ts` (repo root)                       | none (root)    | add the `SplashScreen` plugin block (background/behaviour)                                 |
| Root deps        | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | none (root)    | add `@capacitor/push-notifications`, `@capacitor/splash-screen`, `@capacitor/assets` (dev) |
| Docs             | `apps/mobile/README.md`, `docs/PLAN.md` §7              | none (docs)    | native-build recipe + manual-prereq checklist                                              |

- **Sheriff / module boundaries:** Sheriff governs only `scope:`/`slice:` import
  edges **between workspace TypeScript projects**. The `android/` native project,
  `capacitor.config.ts`, the Capacitor plugin packages, and `google-services.json`
  are **not** workspace TS projects and create **no** Sheriff edge. No
  `scope:functions` or other-slice import is introduced anywhere. **Do NOT edit
  `sheriff.config.ts`.**
- **`@capacitor/*` packages are third-party** — not policed by Sheriff. Adding the
  push-notifications / splash-screen / assets packages is a dependency change, not
  a boundary change.
- **`apps/mobile` keeps `tags: []` in `project.json`** (per spec 0010 — Sheriff
  tags are applied by path-glob in `sheriff.config.ts`, not via `project.json`).
  Do not add `tags` to `project.json`.

## Data model touchpoints

This spec writes **no Firestore document** and changes **no collection, field,
converter, or security rule**. PLAN §4 paths are untouched:

| PLAN §4 path     | Access by this spec | Note                                                                   |
| ---------------- | ------------------- | ---------------------------------------------------------------------- |
| `users/{uid}`    | **none**            | `fcmTokens` is written by spec 0021 (token registration), **not here** |
| `users/{uid}/**` | **none**            | not touched                                                            |
| `title-cache/**` | **none**            | not touched                                                            |

- **`google-services.json` is a native Firebase config artifact, NOT Firestore
  data and NOT a secret.** It carries public client identifiers (`project_id`,
  `mobilesdk_app_id`, the public Android `current_key`/api key, the GCM/FCM sender
  id) — **no private key, no service-account credential**. It is the standard,
  recommended-to-commit Firebase Android setup file. It enables the FCM client on
  the device (so the plugin loads) and lets the Firebase Android SDK initialise.
  **Committed at `apps/mobile/android/app/google-services.json`** (decision 2).
  Distinguish it from the **service-account JSON** (a real secret used only by
  Cloud Functions / Admin SDK — never read or written here; per CLAUDE.md the
  implementer never touches secrets).
- **No `firestore.rules` / `firestore.indexes.json` change** — no query, no write.

## Public types / APIs

- **No TypeScript types, function signatures, HTTP endpoints, or callable shapes
  change.** `@vultus/shared/domain`, `@vultus/shared/firestore-schema`, and all
  slice barrels are untouched.
- **Nx target surface (the only "API" this spec adds)** — in
  `apps/mobile/project.json`:
  ```jsonc
  "sync": {
    "executor": "nx:run-commands",
    "options": { "command": "npx cap sync android" },
    "dependsOn": ["build"]
  },
  "open": {
    "executor": "nx:run-commands",
    "options": { "command": "npx cap open android" },
    "dependsOn": ["build"]
  }
  ```
  Target/executor shape is a **recommendation**; what is **binding** is: a
  `mobile:sync` target running `cap sync android`, a `mobile:open` target running
  `cap open android`, both with `mobile:build` as a prerequisite (`dependsOn:
["build"]`), invocable as `pnpm nx run mobile:sync` / `pnpm nx run mobile:open`.
  (Capacitor reads `webDir: 'dist/apps/mobile/browser'` from the root
  `capacitor.config.ts`, which is exactly what `mobile:build` produces.)
- **`capacitor.config.ts` gains a `plugins.SplashScreen` block** — concrete values
  pinned in UI / Stitch screen refs (background colour = `surface` `#0b1326`,
  launch-auto-hide behaviour). `appId`/`appName`/`webDir` are unchanged.

## UI / Stitch screen refs

This spec ships **native launcher-icon and splash-screen assets**, which are a
UI-fidelity contract (CLAUDE.md: "UI fidelity is a contract, not a vibe"). The
authoritative design tokens live at **`docs/design/vultus-design-system.md`**
(consumed by `shared/ui-kit` `theme.scss`) — **reference that file; do not
reprint or hand-transcribe hex values.** The splash must match the **Stitch
splash/launch screen** of project **`projects/13590348714018893783`** ("Vultus
Android App Design").

> **BLOCKING OPEN ITEM — Stitch splash screen NOT captured in this spec session.**
> The `stitch` MCP / `get_screen` tool was **not available in the spec-authoring
> session** (consistent with spec 0013), so the splash screen's ID and concrete
> markup could not be captured here. Per CLAUDE.md and project memory ("a
> sub-agent's 'MCP unreachable' is a retry, not a reason to ship token-only UI"),
> the implementer **MUST**, before implementing the splash:
>
> 1. `list_screens` on `projects/13590348714018893783` and find the **splash /
>    launch / loading** screen (the branded launch screen, not a content tab).
>    **Retry on MCP failure** — the MCP is reachable from the orchestrator.
> 2. `get_screen` on it to obtain `htmlCode.downloadUrl` and
>    `screenshot.downloadUrl`. **Fetch the raw HTML via a plain GET /
>    `Invoke-WebRequest` (NOT WebFetch — WebFetch summarises away the CSS)** and
>    read the Tailwind config + element markup for the concrete background, the
>    logo/wordmark placement, glyph colour, and any animation. Grab the screenshot
>    for a visual compare.
> 3. **Record the resolved Stitch screen ID in the PR** and align the generated
>    splash to it.
> 4. If, after retries, the screen genuinely cannot be read, mark the splash task
>    **`needs-human` / blocked** in the PR and do **not** ship a guessed splash —
>    the icon + the rest of the spec can still land; the splash visual must be
>    human-verified.

**Concrete contract the implementer must satisfy** (token references, not copied
hexes — pull the exact values from `docs/design/vultus-design-system.md`):

- **App icon (`@capacitor/assets` from `apps/mobile/resources/icon.png`, 1024×1024
  PNG):**
  - Background: `surface` token (`#0b1326`, deep navy) — full-bleed; the adaptive
    icon's background layer is this navy.
  - Foreground glyph: a centred "V" wordmark in the `primary` Emerald token
    (`#4edea3`), `Inter` 700 weight (matching the design-system display type), or
    a supplied Vultus logo if one is provided. Glyph occupies the central ~60% so
    Android's adaptive-icon safe-zone mask never clips it.
  - Output: the full Android mipmap density set + `mipmap-anydpi-v26` adaptive
    icon (`ic_launcher`, `ic_launcher_round`, `ic_launcher_foreground`,
    `ic_launcher_background`) generated under
    `apps/mobile/android/app/src/main/res/`.
  - Acceptance: the icon appears on the device launcher (not the default Capacitor
    bird), is not clipped by the adaptive mask, and uses the navy + Emerald tokens.
- **Splash (`@capacitor/assets` from `apps/mobile/resources/splash.png`
  2732×2732, plus optional `splash-dark.png`; `@capacitor/splash-screen` plugin):**
  - Background: `surface` `#0b1326` (the app is **dark-first** per the design
    system) — wired in two places that must agree: the generated splash drawable
    background **and** the `capacitor.config.ts` `plugins.SplashScreen.
backgroundColor` (and `androidSplashResourceName` if customised).
  - Centred Vultus mark/wordmark in `primary` Emerald `#4edea3` on the navy, per
    the Stitch splash (exact mark/wordmark + any fade/scale animation taken from
    the captured screen — see the blocking item above).
  - `capacitor.config.ts` `SplashScreen` config (pin these): `launchShowDuration`
    short (e.g. ~500ms) or auto-hide on app-ready; `backgroundColor: "#0b1326"`;
    `showSpinner: false`; `launchAutoHide: true`. The splash hides once the web
    layer is ready (the Ionic app's first paint). **The ~500ms figure is a
    starting point to be verified empirically on-device — acceptance (c) (no
    flash of an unstyled/white screen) is the real target the implementer tunes
    against, not the 500ms number itself.** If a flash persists with
    `launchAutoHide: true`, the alternative pattern is `launchAutoHide: false` +
    an explicit `SplashScreen.hide()` call once the app is ready — **noted as a
    fallback only; keep it out of scope for this spec** (no token-registration /
    app-ready wiring is added here).
  - Acceptance (tickable): (a) splash background is the navy `surface` token, not
    white/black default; (b) the Vultus mark renders centred and is not stretched
    across aspect ratios (portrait phone); (c) the splash dismisses to the tabs
    shell with no flash of an unstyled/white screen; (d) matches the captured
    Stitch splash (logo, colour, animation) — human-verified per the blocking
    item.
- **Token wiring caveat:** these are **native** assets — the web-font `Inter`
  loaded in `index.html` (spec 0010) does **not** apply to a rasterised splash
  PNG. If the splash wordmark uses Inter, it must be **baked into the source PNG**
  at generation time (the implementer renders the wordmark into `splash.png`), not
  relied upon from the web font. State which approach was used in the PR.

**Visual verification (CLAUDE.md): a green build does NOT prove the icon/splash
look right.** The implementer must visually verify on a device/emulator (the
launcher icon + the splash on cold boot) or, if no device is available in-session,
**explicitly flag the icon/splash as unverified for a human eyeball** in the PR
(alongside the Stitch-screen capture status).

## Implementation task graph

This is a native-platform wiring spec: dependency + native-project generation is
a hard prerequisite for everything else, so the chain is **mostly sequential**.
Two leaf tasks (the README/PLAN docs, and the icon/splash asset generation) are
independent of each other once the platform exists, but both write into files the
sequential chain also touches or depends on, so they are ordered conservatively.
Because there is only one app project and one native folder, **all file
manifests overlap on `apps/mobile/**`/`android/**` — so tasks are
[sequential]; there is no safe parallel fan-out here.** infrastructure-engineer
owns the platform/Gradle/deps tasks; frontend-engineer owns the asset/Stitch
tasks.

1. **[sequential] Add Capacitor plugins + asset tooling; pin + lock.**
   infrastructure-engineer.
   - Add to the **root `package.json` `dependencies`** (there is **no
     `apps/mobile/package.json`** — all deps live in the root manifest):
     **`@capacitor/push-notifications`** and **`@capacitor/splash-screen`** at the
     **Capacitor-8-compatible** versions (verify peer range against
     `@capacitor/core` 8.4.0 — Risks); add **`@capacitor/assets`** to
     `devDependencies`. Pin exact versions (repo convention: pinned, no `^`).
     Update `pnpm-lock.yaml`.
   - **Fresh-install guard (project memory):** confirm the worktree `pnpm install`
     does not get wedged by the `re2` allowBuilds placeholder — `pnpm-workspace.yaml`
     should already carry `re2: false` (memory: worktree-pnpm-re2-build); if a new
     Capacitor plugin introduces another native postinstall that pnpm blocks, add
     it to `allowBuilds`/`onlyBuiltDependencies` so install completes (record it).
   - Files: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (only if a new
     allowBuilds entry is genuinely needed).

2. **[sequential] Generate and commit the `android/` native project. Depends on
   task 1.** infrastructure-engineer.
   - Run `pnpm nx run mobile:build` (produces `dist/apps/mobile/browser`) then
     `npx cap add android` (Capacitor 8) from the repo root so it reads the root
     `capacitor.config.ts`. Commit the generated `android/` Gradle project.
   - Verify the generated `android/app/build.gradle` `applicationId` is
     **`app.vultus.mobile`** and the app label is **"Vultus"**; set an initial
     `versionCode 1` / `versionName "1.0.0"`. Confirm the Firebase
     **google-services** Gradle plugin is applied (Capacitor's Firebase-aware
     plugins / the push-notifications plugin pull it in; if not auto-applied, add
     the `com.google.gms.google-services` classpath + `apply plugin` so
     `google-services.json` is consumed). **Match whichever Gradle
     plugin-application style `cap add android` generates (plugins DSL /
     `pluginManagement` vs legacy `buildscript classpath` + `apply plugin`); do
     not mix styles.** **The `.gitignore` must NOT exclude
     `google-services.json`** — verify and adjust any generated `android/.gitignore`
     so the committed config file is tracked.
   - Run `npx cap sync android` and confirm **all plugins resolve** (`@capacitor/
app|haptics|keyboard|status-bar|push-notifications|splash-screen`) with no
     unresolved-plugin error.
   - **Native-toolchain caveat (project memory: loopback/JVM tooling can't run
     under Claude Code tools here).** If `cap add android` / Gradle cannot be
     executed in-session, the implementer commits the generated project from a
     local run (or flags the step **`needs-human`**: "run `nx build` →
     `cap add android` → `cap sync android` locally, commit `android/`"). Do not
     hand-fabricate the Gradle project.
   - Files: `apps/mobile/android/**` (the full generated native project),
     `capacitor.config.ts` (only if `cap add` rewrites it — keep `appId`/`appName`/
     `webDir` intact).

3. **[sequential] Manual prereq: register the Android app + place
   `google-services.json`. Depends on task 2.** infrastructure-engineer / **user
   (manual)**.
   - **Manual (documented, may require the user):** in the Firebase console for
     **`vultus-cab62`**, register the Android app with package **`app.vultus.mobile`**
     if it does not exist, download **`google-services.json`**, and place it at
     **`apps/mobile/android/app/google-services.json`**. **Commit it** (decision 2;
     not a secret — Data model / Risks).
   - If the implementing agent cannot access the console, mark this step
     **`needs-human`** in the PR with the exact path + package name, and proceed
     with the rest (the APK build then fails only on the device-Firebase-init step
     until the file is in place — call that out explicitly).
   - Files: `apps/mobile/android/app/google-services.json`.

4. **[sequential] Generate the launcher icon + splash assets (Stitch-matched).
   Depends on task 2.** frontend-engineer.
   - **First** resolve the Stitch splash screen per the blocking open item in UI /
     Stitch screen refs (`list_screens` → `get_screen` → raw-HTML fetch; record
     the screen ID or flag blocked).
   - Author `apps/mobile/resources/icon.png` (1024×1024) and
     `apps/mobile/resources/splash.png` (2732×2732, + optional `splash-dark.png`)
     to the icon/splash contract (navy `surface` + Emerald `primary` mark; tokens
     from `docs/design/vultus-design-system.md`; splash matched to the captured
     Stitch screen).
   - Run **`npx @capacitor/assets generate --android`** to emit the Android mipmap
     / adaptive-icon set and the splash drawables under
     `apps/mobile/android/app/src/main/res/**`.
   - Add the `plugins.SplashScreen` block to `capacitor.config.ts`
     (`backgroundColor: "#0b1326"`, `launchAutoHide: true`, `showSpinner: false`,
     short `launchShowDuration`); re-run `npx cap sync android`.
   - **Visually verify** the icon + splash on a device/emulator, or flag
     **unverified for a human eyeball** in the PR (UI / Stitch screen refs).
   - Files: `apps/mobile/resources/icon.png`, `apps/mobile/resources/splash.png`
     (+ `splash-dark.png` if used), `apps/mobile/android/app/src/main/res/**`
     (generated), `capacitor.config.ts` (SplashScreen block).

5. **[sequential] Add the `mobile:sync` / `mobile:open` Nx targets. Depends on
   task 2.** infrastructure-engineer.
   - Add the two targets to `apps/mobile/project.json` (Public types / APIs),
     each `dependsOn: ["build"]`. Verify `pnpm nx run mobile:sync` runs `cap sync
android` after a build and `pnpm nx run mobile:open` opens Android Studio.
   - Files: `apps/mobile/project.json`.

6. **[sequential] Documentation: native-build recipe + manual-prereq checklist.
   Depends on tasks 2–5.** infrastructure-engineer.
   - Rewrite/extend `apps/mobile/README.md` with the native-build recipe: prereqs
     (Android Studio + SDK; `google-services.json` download + exact placement),
     and the flow `pnpm nx run mobile:build` → `pnpm nx run mobile:sync` →
     `pnpm nx run mobile:open` → assemble **debug** APK in Android Studio (Build →
     Build APK, or `./gradlew assembleDebug`) → install via ADB / Android Studio
     on a device. Note: debug-only, no signing (decision 1).
   - Add/confirm the `google-services.json` step in `docs/PLAN.md` §7 manual
     prerequisites (it lists Android Studio + Firebase project already; add the
     explicit "download `google-services.json` for `vultus-cab62`, place at
     `apps/mobile/android/app/`, commit" line if absent).
   - Files: `apps/mobile/README.md`, `docs/PLAN.md`.

(All work is under `apps/mobile/**`, `android/**`, the root `capacitor.config.ts`,
root deps, and `docs/`. No `libs/**` source, no `sheriff.config.ts`, no
`firestore.rules`, no `scope:functions` file, no `ci.yml` is touched. Because
every task writes into the single `apps/mobile`/`android` tree, there is **no
disjoint parallel manifest** — the orchestrator runs these sequentially.)

## Test plan

This spec adds **no application logic** — it is native-platform + config + asset
wiring — so per the PLAN §5 pyramid there are **no new unit / component / e2e
tests**, and that is the correct outcome (writing a unit test for a Gradle
project or a generated PNG would be theatre). The verification is **build- and
device-level**, and the existing suites must stay green:

- **Existing unit + component suites stay green.** `pnpm nx run-many -t lint test
-p mobile` (and `nx affected -t lint test --base=main`) pass unchanged — no slice
  source changed, so the existing tests neither change nor regress. Adding the
  push-notifications / splash-screen deps must not break the web build's type
  resolution.
- **Web build.** `pnpm nx run mobile:build` (production configuration) succeeds and
  produces `dist/apps/mobile/browser` (acceptance criterion 1).
- **Capacitor sync.** `pnpm nx run mobile:sync` (== `cap sync android` after build)
  completes with **all Capacitor plugins resolving** and **no error** (acceptance
  criterion 2). This is the primary new gate.
- **Native build + device boot (manual / device-level, NOT in CI — decision: out
  of scope for CI):** assemble the **debug APK** in Android Studio
  (`assembleDebug`) and install on a real Android device. Verify on-device:
  (a) the app **boots** with no native crash; (b) **Firebase initialises** (no
  "missing/invalid google-services" or `FirebaseApp` init error in `adb logcat`);
  (c) the **Stitch-matched splash** shows on cold launch and dismisses cleanly;
  (d) the **launcher icon** appears (not the default Capacitor bird); (e) the
  **FCM plugin loads without error** (no plugin-load exception in logcat — token
  registration itself is spec 0021). These are checked manually on the device and
  recorded in the PR (no automated e2e — native device testing is not wired and is
  explicitly out of CI scope).
- **No `apps/mobile-e2e` change.** The Playwright web smoke (spec 0010 / 0019) is
  unaffected; this spec adds no e2e and changes neither `playwright.config.ts` nor
  `ci.yml`.

## Definition of done

Tailored from PLAN §5. The automated green gate is \*\*lint + test + the web build

- `cap sync`**; the on-device checks are **manual\*\* (native APK build/install is
  out of CI scope — decision-aligned with the out-of-scope list).

* [ ] `pnpm nx run-many -t lint test -p mobile` passes **with Sheriff active**
      (lint includes Sheriff) — no new boundary edge is introduced (the Capacitor
      plugins are third-party; `android/` is not a TS workspace project); no slice
      source changed, so existing unit/component tests stay green.
* [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors CI; the
      affected set is `mobile` (root dep + config change). The web build still
      passes within the existing bundle budgets.
* [ ] `pnpm nx run mobile:build` succeeds and produces `dist/apps/mobile/browser`
      (acceptance criterion 1).
* [ ] `pnpm nx run mobile:sync` completes with **all Capacitor plugins resolving**
      and no error (acceptance criterion 2) — i.e. `@capacitor/push-notifications`
      and `@capacitor/splash-screen` are installed, in `package.json`, and synced
      into `android/`. **`cap sync` is a Node-level step (it copies the web bundle + resolves plugin packages; it does NOT invoke Gradle), so it is expected to
      run in-session as an automated gate.** Only `cap add android` (which runs
      `npx cap add`), the Gradle `assembleDebug`, and the device-install steps may
      fall to `needs-human` if the shell can't run them (see Risks) — `cap sync`
      itself should not.
* [ ] The **`android/` native project is committed**, `applicationId` is
      `app.vultus.mobile`, app label "Vultus", and **`google-services.json` is
      present and committed** at `apps/mobile/android/app/google-services.json`
      (or the step is flagged `needs-human` with the exact path + package name if
      console access was unavailable).
* [ ] `mobile:sync` and `mobile:open` Nx targets exist with `dependsOn: ["build"]`
      and run `cap sync android` / `cap open android` respectively.
* [ ] **Icon + splash generated via `@capacitor/assets`** from committed
      `apps/mobile/resources/{icon,splash}.png`, using the navy `surface` +
      Emerald `primary` tokens from `docs/design/vultus-design-system.md`; the
      `capacitor.config.ts` `SplashScreen.backgroundColor` agrees with the splash
      drawable background. **No hex hand-transcribed** — tokens cited.
* [ ] **Stitch splash screen ID recorded in the PR** (resolved via `list_screens`/
      `get_screen` on `projects/13590348714018893783`), or — if the MCP was
      genuinely unreachable after retries — the splash task flagged blocked /
      `needs-human` (UI / Stitch screen refs), **not** shipped as a guessed splash.
* [ ] **On-device verification recorded in the PR** (or explicitly flagged
      unverified / `needs-human` if no device available): boots without crash,
      Firebase initialises (no google-services error in logcat), splash matches
      Stitch + dismisses cleanly, launcher icon appears, FCM plugin loads without
      error. (Acceptance criteria 3–7.)
* [ ] `apps/mobile/README.md` documents the native-build recipe (prereqs +
      build/sync/open/assemble-debug-APK/install flow); `docs/PLAN.md` §7 lists the
      `google-services.json` manual step. **No leftover Nx scaffold text** in the
      README (CLAUDE.md README rule).
* [ ] **Guardrail verifications (review-checked):** (a) **no Firestore write / no
      `users/**`access** —`fcmTokens`registration is deferred to spec 0021;
    (b) **no permission-prompt / no`PushNotifications.register()`call** added
    (decision 5); (c) **no signing config / release flavour / keystore /`.aab`**
    (decision 1); (d) **no `scope:functions`, no other-slice, no
    `sheriff.config.ts`, no `firestore.rules`, no `ci.yml`change**; (e) **no
    secret read or written** —`google-services.json`is a **public** client
    config (committed by design), and the service-account JSON is never touched
    (per CLAUDE.md the implementer never reads/writes`.env.local`or secrets);
    (f) no`ios/` platform added.
* [ ] PR description records: the chosen `@capacitor/push-notifications` /
      `@capacitor/splash-screen` / `@capacitor/assets` versions + their Capacitor-8
      compatibility check, the resolved **Stitch splash screen ID** (or MCP-
      unreachable + blocked), the `cap sync` plugin-resolution result, the on-device
      verification result (or unverified flag), the `google-services.json` placement
      (or `needs-human`), and the "no token registration / no permission prompt /
      debug-only / no CI native build" boundary confirmations.

## Risks

- **Interview claim "the `@capacitor/push-notifications` plugin is already used in
  the settings slice (spec 0011)" is INACCURATE (corrected in-spec — decision 5).**
  Verified against the repo: `@capacitor/push-notifications` appears **only in spec
  markdown** (0011, 0012), is **not** in `package.json`, and the settings slice
  (`libs/mobile/settings/src/lib/settings.service.ts`) only writes `fcmTokens: []`
  on eager create and **never registers a token or imports the plugin** — spec 0011
  explicitly deferred all FCM work to **this** item. **Resolution:** this spec
  **adds** the plugin (it does not merely "sync an existing one"). The plumbing is
  wired here; the actual `register()` + `fcmTokens` write stays in spec 0021. This
  is a correction toward the merged code, not a redesign.

- **Native toolchain cannot run under Claude Code tools here (project memory:
  emulator-tooling-limitation — loopback/JVM-NIO blocked).** `cap add android`
  (via `npx cap add`), Gradle `assembleDebug`, and a device install may not be
  runnable from the agent tools — these are the steps that may fall to
  `needs-human`. **`cap sync android` (== `mobile:sync`) is a Node-level
  step — it copies the web bundle and resolves plugin packages, invoking no
  Gradle and no JVM-NIO server — so it is NOT covered by this limitation and is
  expected to run in-session** (it is an automated DoD gate, not a `needs-human`
  candidate). **Mitigation:** the agent commits the generated `android/` project and the
  generated assets, runs the **web** build + `cap sync` where possible, and for any
  step that genuinely cannot run in-session (native Gradle / device install) flags
  it **`needs-human`** with the exact commands — it does **not** hand-fabricate the
  Gradle project or claim an unrun device test as passed. The on-device acceptance
  criteria are explicitly manual.

- **`google-services.json` must be the right artifact (public config, not the
  service-account secret).** The committed file is the **public** Firebase Android
  client config (project id, app id, public api key, sender id — no private key);
  committing it is the recommended Firebase Android setup, **not** a secrets
  violation. The **service-account** JSON (used by functions/Admin SDK) is a real
  secret and is **never** placed here or read by this spec. If the implementer is
  ever handed a file containing a `private_key` to put under `android/`, **stop and
  flag it** — that is the wrong file.

- **Capacitor-8 plugin version compatibility (verify before installing).**
  `@capacitor/push-notifications` and `@capacitor/splash-screen` must match the
  installed `@capacitor/core` 8.4.0 peer range; `@capacitor/assets` must support
  Capacitor 8. The implementer **verifies the compatible versions** (peer deps /
  release notes) and pins them; if no compatible release exists for a plugin,
  **stop and flag it** rather than forcing a mismatched install.

- **`pnpm install` wedge on fresh worktree (project memory:
  worktree-pnpm-re2-build).** Adding native plugins re-runs install in the
  worktree; the `re2` allowBuilds placeholder can abort install (exit 1). Confirm
  `pnpm-workspace.yaml` carries `re2: false`; if a new plugin adds another blocked
  native postinstall, allow/deny it explicitly so install completes — record any
  change.

- **Splash font is native, not the web `Inter`.** The web-font loaded in
  `index.html` (spec 0010) does **not** style a rasterised splash PNG. A wordmark
  splash must bake the type into the source PNG at generation time; relying on the
  web font for the splash would silently fall back to a system font on the native
  launch screen. Called out in UI / Stitch screen refs.

- **Stitch splash screen ID not captured in this session (BLOCKING for the splash
  task — see UI / Stitch screen refs).** The `stitch` MCP was unavailable to the
  spec author (consistent with spec 0013); the implementer **must** capture it
  (retry — the MCP is reachable from the orchestrator per project memory) and
  record the screen ID, or flag the splash blocked / `needs-human`. The icon + the
  rest of the spec are not blocked by this.

- **No PLAN conflict.** This implements PLAN §6 item 21 as written (app icon,
  splash, FCM push setup, `capacitor.config.ts`, build APK locally), defers the
  permission prompt to onboarding (PLAN §6 item 22 / spec 0021), and keeps the
  native APK build a **local** step (PLAN/specs README both note deployment +
  Capacitor APK build are manual / out of the skill-driven CI workflow). The
  committed `google-services.json` aligns with PLAN §7's Firebase-project +
  Android-Studio manual prereqs.
