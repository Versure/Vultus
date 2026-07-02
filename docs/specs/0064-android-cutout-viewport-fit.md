---
number: 0064
slug: android-cutout-viewport-fit
title: Extend the WebView under the Android display cutout via viewport-fit=cover, with a dark window background fallback
status: done
slices: []
scopes: [scope:mobile]
created: 2026-07-02
---

# Extend the WebView under the Android display cutout via `viewport-fit=cover`, with a dark window background fallback

## Context

Direct follow-up to spec 0062 (`docs/specs/0062-android-webview-cutout-background.md`)
and GitHub issue #91. This is the spec that 0062's **Risk 4** explicitly
anticipated: _"if the human reports the color is right but a bar of the wrong
size/position remains, that indicates the gap is elsewhere (window background,
or a further WebView surface quirk) — a fast-follow."_ The color is now right
(0062 painted the WebView surface `#0b1326` via `PR #152`), **but the strip
remains** — a gray band exactly the height of the camera cutout still renders
above the app header on a notched Android device (screenshot on issue #91,
2026-07-01), and a second complaint reports the app "does not display right to
the top."

**Prior lineage (all merged, all confirmed present in the code):**

- `docs/specs/0029-android-edge-to-edge.md` — StatusBar overlay config, guarded
  `StatusBar` init, and the `--ion-safe-area-*` (`env(safe-area-inset-*)`)
  wiring in `libs/shared/ui-kit/src/lib/theme.scss` (lines 183–186 map
  `env(safe-area-inset-*)` → `--ion-safe-area-*`, so Ionic pads
  `IonHeader`/`IonContent` automatically).
- `docs/specs/0039-android-immersive-system-bars.md` — `hideSystemBars()`
  (AndroidX `WindowInsetsControllerCompat`, hide `systemBars()`, transient
  swipe-reveal) in `MainActivity.java`.
- `docs/specs/0045-android-display-cutout.md` — added
  `android:windowLayoutInDisplayCutoutMode=shortEdges` to both
  `AppTheme.NoActionBar` and `AppTheme.NoActionBarLaunch` in `styles.xml`.
- `docs/specs/0055-android-cutout-runtime-theme.md` — instrumented the running
  window, human captured Logcat on a real notched device, and confirmed
  **Candidate C**: the native theme _mode_ layer is correct (running window
  carries `shortEdges`/`SHORT_EDGES`; `getDisplayCutout()` returns real,
  non-empty insets). 0055 deferred the residual artifact to the WebView/Ionic
  safe-area layer.
- `docs/specs/0062-android-webview-cutout-background.md` (`PR #152`) — added
  top-level `backgroundColor: '#0b1326'` to `capacitor.config.ts` so
  `Bridge.setBackgroundColor` paints the WebView surface dark navy.

**Root cause (established this session by direct inspection of the installed
packages — cite these, do not re-derive from memory):**

1. Capacitor 8.4.0's built-in **SystemBars** plugin
   (`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java`)
   registers an `OnApplyWindowInsetsListener` on the **WebView's parent** view
   (line 199). Line 200:
   `boolean shouldPassthroughInsets = getWebViewMajorVersion() >= WEBVIEW_VERSION_WITH_SAFE_AREA_FIX && hasViewportCover;`
   where `WEBVIEW_VERSION_WITH_SAFE_AREA_FIX = 140` (line 41, chromium issue 40699457) and `hasViewportCover` is determined by injecting JS that checks
   the page's **last** `meta[name=viewport]` tag for the substring
   `"viewport-fit=cover"` (`viewportMetaJSFunction`, lines 45–56, invoked from
   `onDOMReady` lines 155–166).
2. When `shouldPassthroughInsets` is **false**, the else-branch (lines 228–233)
   calls `v.setPadding(...)` on the WebView parent with insets of type
   `systemBars() | displayCutout()`. `MainActivity.hideSystemBars()` (spec 0039)
   zeroes the `systemBars()` insets, but the `displayCutout()` inset never goes
   away → top padding exactly the cutout height → the WebView is laid out
   **below** the notch.
3. `apps/mobile/src/index.html` line 7 currently has
   `<meta name="viewport" content="width=device-width, initial-scale=1" />` —
   **no** `viewport-fit=cover` — so `hasViewportCover` is **false on every
   device** and the passthrough branch can never activate.
4. The **gray strip** is the theme **window background** showing through that
   padding gap. The runtime theme is `AppTheme.NoActionBar` (Capacitor's
   `BridgeActivity.java` lines 25–26 call `setTheme(R.style.AppTheme_NoActionBar)`,
   overriding the manifest's launch theme), which parents
   `Theme.AppCompat.DayNight.NoActionBar` with **no** `android:windowBackground`
   override (`android/app/src/main/res/values/styles.xml` lines 12–17) —
   AppCompat's DayNight default window background is material gray
   (`#303030` dark / `#fafafa` light). **That is the strip.**
5. **Why 0062 could not fully work:** `Bridge.java` lines 602–605 apply the
   config `backgroundColor` via `webView.setBackgroundColor()` — it paints the
   **WebView itself**, but the strip is **outside** the WebView (the parent
   padding area from step 2), so the value never reaches those pixels. 0062 was
   correct and is kept (it still paints the WebView surface — overscroll glow,
   pre-first-paint); it simply cannot reach a region the WebView does not cover.

**Decided fix (two committed files).**

1. **`apps/mobile/src/index.html`** — change the viewport meta to include
   `viewport-fit=cover`, e.g.
   `<meta name="viewport" content="viewport-fit=cover, width=device-width, initial-scale=1" />`.
   This flips `hasViewportCover` **true**; on devices with WebView **≥ 140** the
   SystemBars plugin stops padding (passthrough branch ~lines 206–224: parent
   padding 0, insets forwarded, safe-area CSS injected), the WebView extends
   **under** the cutout, and `env(safe-area-inset-*)` reports real values —
   which `theme.scss` lines 183–186 already map to `--ion-safe-area-*`, so
   Ionic headers pad themselves **below** the camera automatically (0029 wiring,
   unchanged).
2. **`android/app/src/main/res/values/styles.xml`** — add
   `<item name="android:windowBackground">#0b1326</item>` to
   **`AppTheme.NoActionBar` only** (user decision — **not** the base `AppTheme`,
   **not** `AppTheme.NoActionBarLaunch`; the launch theme keeps its splash
   drawable, and the base `AppTheme` is unused at runtime). This is the
   **fallback**: on devices with WebView **< 140** Capacitor still pads, and the
   padded strip then paints dark navy instead of AppCompat gray; it also removes
   the gray flash between splash dismissal and first WebView paint. `#0b1326` =
   `--vultus-surface` / `--ion-background-color`, the same single source of
   truth as 0062 — **copy it from `capacitor.config.ts`, never hand-transcribe
   from memory.** Leave the existing `android:background=@null` and
   `android:windowLayoutInDisplayCutoutMode=shortEdges` items on that style
   exactly as-is.

**Why this does not contradict 0062.** 0062 forbade touching `styles.xml`
because 0055 had device-confirmed the cutout/theme **_mode_** layer correct.
That is unchanged here — this spec does **not** touch
`windowLayoutInDisplayCutoutMode` or the theme parents; it adds a
`windowBackground` **color**, which was **never in 0055's or 0062's scope**. The
mode layer stays exactly as 0045/0055 left it. So this is an additive color
fallback, not a re-litigation of the confirmed-correct mode layer.

**`capacitor.config.ts` is NOT changed by this spec.** The top-level
`backgroundColor: '#0b1326'` from 0062 is **kept** — it still paints the WebView
surface itself (overscroll glow, pre-first-paint), which matters more once the
WebView extends under the cutout.

**Intended outcome.** After this spec: on WebView ≥ 140 devices the app content
extends to the physical top edge with the header padded below the camera via the
safe-area inset (resolving both complaints — the strip and "does not display
right to the top"); on WebView < 140 devices the strip that remains paints dark
navy `#0b1326` instead of AppCompat gray (acceptable degraded mode). 0029/0039/
0045/0055/0062 all remain intact.

## Scope

In scope:

- **`apps/mobile/src/index.html`** — change the single `meta[name=viewport]` tag
  to include `viewport-fit=cover` (e.g.
  `content="viewport-fit=cover, width=device-width, initial-scale=1"`). This is
  the load-bearing token: SystemBars keys `hasViewportCover` off the exact
  substring `viewport-fit=cover` in the page's **last** viewport meta tag, so
  the token must be present and must not be dropped by a future edit.
- **A Vitest guard test** intentionally colocated with `index.html` at
  `apps/mobile/src/index-html.spec.ts` — the vite `include` glob
  `src/**/*.{test,spec}.{...}` matches it, and a `__dirname`-relative read of
  `index.html` resolves from that location. (The existing mobile specs live
  under `src/app/**` — `apps/mobile/src/app/app.spec.ts` and
  `apps/mobile/src/app/firebase/emulators.spec.ts` — not directly in `src/`;
  this new spec sits alongside `index.html` in `src/` on purpose so the
  on-disk read is a simple sibling path.) It reads `apps/mobile/src/index.html`
  from disk and asserts the viewport meta content includes the **exact
  substring** `viewport-fit=cover`, so a future refactor cannot silently drop
  the load-bearing token. Runnable in-session by `pnpm nx test mobile`
  (Vitest + Analog).
- **`android/app/src/main/res/values/styles.xml`** — add
  `<item name="android:windowBackground">#0b1326</item>` to
  **`AppTheme.NoActionBar` only**. `#0b1326` = `--vultus-surface` /
  `--ion-background-color`, copied from `capacitor.config.ts`.

Out of scope (explicit):

- **`capacitor.config.ts`.** Not changed. The 0062 top-level
  `backgroundColor: '#0b1326'` and the `StatusBar` / `SplashScreen` blocks stay
  exactly as they are.
- **The base `AppTheme` and `AppTheme.NoActionBarLaunch` styles.** No
  `windowBackground` (or any) change to them. `AppTheme.NoActionBarLaunch` keeps
  its `@drawable/splash` background; the base `AppTheme` is unused at runtime and
  is left untouched. Only `AppTheme.NoActionBar` gets the new item.
- **`windowLayoutInDisplayCutoutMode` and the theme parents / existing
  `android:background=@null` item on `AppTheme.NoActionBar`.** All unchanged —
  the confirmed-correct cutout _mode_ layer (0045/0055) is not touched.
- **`MainActivity.java` / `hideSystemBars()` (0039).** Not modified. The
  passthrough vs padding branch is decided inside Capacitor's SystemBars plugin
  from `hasViewportCover`; no `MainActivity` change is needed or made.
- **`theme.scss` / any `--vultus-*` / `--ion-*` token / `app.ts`.** Not
  modified. The `--ion-safe-area-*` wiring (0029) already exists and is relied
  upon unchanged.
- **`AndroidManifest.xml`.** Not modified.
- **iOS.** Issue #91 is Android-only. `viewport-fit=cover` is a standard web
  attribute and is inert where there is no inset (desktop, no-notch), but no iOS
  platform work is done or verified.
- **Any settings toggle / persistence / Firestore field / domain type /
  function / Sheriff-config / dependency / Gradle change.** None.

## Affected slices & Sheriff tags

**No slice is built** (`slices: []`). The committed changes are (a) the mobile
app's static `index.html`, (b) a colocated Vitest guard spec in
`apps/mobile/src`, and (c) a native Android resource (`styles.xml`) — this is
Android app-shell / native-config work, matching the posture of
0029/0039/0045/0055/0062. `scopes: [scope:mobile]` is **descriptive** (part of
the mobile app's shell) and drives no slice Sheriff rule.

- **No cross-slice or cross-scope import is introduced.** `index.html` is a
  static asset; the guard spec imports only `node:fs`/`node:path` (and Vitest
  globals) to read the file — no workspace project. `styles.xml` is a native
  resource compiled by Gradle, outside the Nx/TS/Sheriff graph. No Nx project
  graph edge changes.
- **No lib is touched**, so no lib `README.md` update applies.
- **No DRY / 3+-slice question arises** — no shared TS logic is added; the
  single viewport token lives in its correct single home (the app's `index.html`)
  and the window-background color in the app's native resources.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected). No persistence of any kind. **There are no
`firestore.rules` or `firestore.indexes.json` touchpoints for this spec** —
stated explicitly so the DoD ⇄ task cross-check has nothing orphaned.

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes — and **no `shared/domain` change**, so there is **no repo-wide ripple**
to enumerate.

The only "API" interactions are:

- **The `meta[name=viewport]` content string** in `apps/mobile/src/index.html` —
  a standard HTML attribute Capacitor's SystemBars plugin reads (via injected JS)
  for the substring `viewport-fit=cover`. **Exact edit** — change line 7 from:

  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ```

  to (order within the content string is not significant to the plugin's
  substring check, but keep `viewport-fit=cover` present):

  ```html
  <meta
    name="viewport"
    content="viewport-fit=cover, width=device-width, initial-scale=1"
  />
  ```

  This must remain the page's **last** (here: only) viewport meta tag, since
  `viewportMetaJSFunction` checks the last one.

  **Robustness note (guard test vs. runtime check).** At runtime Capacitor
  reads the DOM-parsed meta element's `.content` **string** and does
  `.includes("viewport-fit=cover")` on it; the guard test instead does a raw
  substring assertion on the on-disk `index.html`. The two are therefore a
  faithful **proxy**, not an identical operation — but for the value here they
  agree: comma-separated tokens inside `content` are fine (the runtime
  substring check does not care about token order or the surrounding
  `width=device-width, initial-scale=1`), so the raw-file substring the guard
  asserts is present in the DOM-parsed `.content` string as well.

- **The `AppTheme.NoActionBar` style** in `styles.xml` — add one item; the style
  becomes:

  ```xml
  <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
      <item name="windowActionBar">false</item>
      <item name="windowNoTitle">true</item>
      <item name="android:background">@null</item>
      <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
      <item name="android:windowBackground">#0b1326</item>
  </style>
  ```

  `#0b1326` = `--vultus-surface` / `--ion-background-color` (copy from
  `capacitor.config.ts`; do not hand-transcribe from memory). The existing
  `android:background=@null` and `windowLayoutInDisplayCutoutMode=shortEdges`
  items are left exactly as-is.

## UI / Stitch screen refs

**No Stitch screen fetch required — and no `get_screen` call is warranted for
this spec** (same reasoning as 0062). This change introduces **no new screen,
component, layout, or design token**. It (a) adds the standard
`viewport-fit=cover` attribute so the existing WebView extends under the cutout
and the **already-wired** 0029 `--ion-safe-area-*` insets take effect, and (b)
sets a native window-background color to `#0b1326`, which is the
**already-established** `--vultus-surface` / `--ion-background-color` (spec 0029),
not a new or transcribed color. There is no in-app pixel, control, state, or
type role to pin against a Stitch screen — the affected surfaces are the native
window background (behind the DOM) and the WebView's layout position, not any
rendered component.

The intended visual end-state (app content to the physical top edge, header
inset below the notch via the safe-area inset; any residual strip on old WebView
dark `#0b1326`) is the **contract of specs 0029/0045/0055/0062** — governed by
`docs/design/vultus-design-system.md` and `libs/shared/ui-kit/src/lib/theme.scss`,
not re-specified or re-transcribed here. **No hex is hand-transcribed from
memory** — `#0b1326` is copied from the existing `capacitor.config.ts` value and
is `--vultus-surface` per the design doc. Visual correctness is verified on a
real notched device (Test plan), not against a Stitch screen.

## Implementation task graph

Two small **[sequential]** tasks (no parallel fan-out, no file manifests
needed — the tasks touch disjoint, explicitly-named files and are ordered only
for review clarity, not shared-dependency reasons). Both are additive shell
config.

### 1. [sequential] `index.html` viewport meta + Vitest guard test (frontend-engineer)

Committed files changed:

- `apps/mobile/src/index.html`
- `apps/mobile/src/index-html.spec.ts` (new; colocated guard test — final
  filename is the implementer's call as long as it is under `apps/mobile/src`
  and matched by the vite config's `include: ['src/**/*.{test,spec}.{...}']`).

Steps:

- Edit `apps/mobile/src/index.html` line 7 so the `meta[name=viewport]` content
  includes `viewport-fit=cover`, exactly per **Public types / APIs**. Keep it the
  page's only/last viewport meta tag. Do not touch the Inter font links or any
  other head element.
- Add the guard test: read `apps/mobile/src/index.html` from disk (e.g.
  `readFileSync(join(__dirname, 'index.html'), 'utf8')` — the vite config `root`
  is `apps/mobile`, and the spec is colocated, so `__dirname` resolves the file;
  or resolve via an absolute path from the workspace) and assert the viewport
  meta content includes the **exact substring** `'viewport-fit=cover'`. **Do not
  whitespace-normalize** the read content before asserting (F3) — assert the raw
  substring so a stray/rewrapped token defect is not masked. Use the existing
  Vitest global style (`describe`/`it`/`expect`, per
  `apps/mobile/src/app/firebase/emulators.spec.ts`).
- Run `pnpm nx test mobile` — the new spec (and the existing mobile unit specs)
  must pass on Vitest + Analog.
- After the `index.html` edit, a human MAY run `pnpm nx build mobile` then
  `pnpm exec cap sync android` (per CLAUDE.md E1: build the web app first, use
  `pnpm exec` not `npx`) to refresh `dist` assets. **No committed native file
  other than `styles.xml` (Task 2) may change** as a result; if `cap sync`
  touches any other committed file, **revert it and flag** (0062 precedent). The
  regenerated `android/app/src/main/assets/capacitor.config.json` is git-ignored
  and its regeneration is expected/ignored.
- **E2 (Windows):** after editing, run `pnpm exec prettier --write` on the
  changed files before staging (Edit/Write can emit CRLF, tripping
  `prettier --check`).

### 2. [sequential] `styles.xml` `windowBackground` on `AppTheme.NoActionBar` (infrastructure-engineer)

Committed file changed: `android/app/src/main/res/values/styles.xml` (the only
committed native file this spec changes — deliberately, unlike 0062, which
forbade touching `styles.xml`; the difference is that 0062 protected the
confirmed-correct cutout _mode_ layer, whereas this adds a `windowBackground`
_color_ that was never in 0055's/0062's scope — see Context "Why this does not
contradict 0062").

Steps:

- Add `<item name="android:windowBackground">#0b1326</item>` to
  **`AppTheme.NoActionBar` only**, exactly per **Public types / APIs**. Copy
  `#0b1326` from `capacitor.config.ts` (`--vultus-surface`); do not
  hand-transcribe from memory.
- Do **not** add the item to the base `AppTheme` or to
  `AppTheme.NoActionBarLaunch`. Do **not** alter the existing
  `android:background=@null` or `windowLayoutInDisplayCutoutMode=shortEdges`
  items, the theme parents, or `AndroidManifest.xml`.
- `styles.xml` is a native resource compiled directly by Gradle; it is **not**
  in any Nx project and `cap sync` neither generates nor clobbers it. `npx`/`cap
sync` is **not required** to apply this change and must not be relied upon.
- **Human/device gate (cannot run in-session):** the load-bearing verification is
  the on-device check (see Test plan). Native Gradle compile of the resource and
  the visual result cannot run in-session (documented device/build tooling
  limitation). Flagged human / post-merge.

## Test plan

Per the PLAN §5 pyramid. Unlike 0062 (a repo-root-only change), the `index.html`
edit **is** inside the mobile app project, so the mobile Vitest suite and build
**are** affected — and a real, runnable unit gate exists.

- **Unit (Vitest — runnable in-session):** the **guard test** from Task 1. It
  reads `apps/mobile/src/index.html` from disk and asserts the viewport meta
  content contains the **exact substring** `viewport-fit=cover`. **No
  whitespace-normalization** is applied before the assertion (F3) — the raw file
  content is asserted so a rewrapped/dropped token is caught. Runs under
  `pnpm nx test mobile` (Vitest + Analog). This is the one automated defense of
  the load-bearing token; there is no e2e or component counterpart asserting the
  same rendered text, so no consistency concern arises.
- **Component tests:** **none** — no slice component is added or changed.
- **e2e tests:** **No e2e flows required — native/shell Android-only change; no
  new navigation route and no new user action.** Per the PLAN §5 e2e rubric,
  `viewport-fit=cover` is inert on desktop browsers (`env()` insets resolve to 0) and the native window background / WebView-under-cutout layout **cannot be
  exercised by the web Playwright suite** (serve-mock / e2e are unaffected).
  Existing flows are untouched and nothing is un-skipped. Stated explicitly so
  the omission is intentional.
- **Automated gate (workspace):** `nx affected -t typecheck lint test build
--base=main`. Because `index.html` **is** inside the `mobile` Nx project, the
  mobile **build and test targets WILL be affected** (contrast 0062, whose
  repo-root file was not an Nx build target). `styles.xml` is **not** in any Nx
  project — the pre-commit hook still Prettier-formats staged files, but
  `nx affected` will not build it. **`nx affected` compiles no Java/Android
  resources and does not run `cap sync`**, so a green run does **not** prove the
  native window-background color took effect or that the WebView extends under
  the cutout — do not report the visual fix as done off it.
- **Android Gradle compile / native build** is verified during the native build
  step, which **cannot run in-session** (documented device/build tooling
  limitation). **Flagged human / post-merge.**
- **Human device verification — the load-bearing gate (cannot run in-session;
  needs a physical Android device WITH A CAMERA NOTCH/CUTOUT + a native build).**
  A green build does **not** prove the visual result. On the same notched device
  as 0055/0062, after the edits + `pnpm nx build mobile` + `pnpm exec cap sync
android` + rebuild + install:
  1. The strip above the header now paints `#0b1326` / reads as part of the app
     (on WebView < 140 the padded strip is dark navy; on WebView ≥ 140 there is
     no strip because the WebView extends under the cutout).
  2. App content extends to the **physical top** of the screen with the header
     padded below the camera via the safe-area inset (the issue's second
     complaint: "the app does not display right to the top").
  3. **No regression** to 0039 transient system bars, 0045/0055 cutout behavior,
     or 0029 insets.
  4. Status-bar swipe-reveal still overlays correctly.
  5. With passthrough active (WebView ≥ 140), **eyeball each top-level page**
     (watchlist, title detail, settings, etc.) to confirm no page that lacks an
     `ion-header` / `--ion-safe-area-top` renders content behind the camera
     (see Risks). Post findings to the PR.

## Definition of done

Tailored from the PLAN §5 checklist. The affected artifacts are the mobile app's
`index.html` (+ its guard test) and the native Android `styles.xml`.

- [ ] **`apps/mobile/src/index.html` viewport meta includes `viewport-fit=cover`**
      (the page's last/only viewport meta tag), the Inter font links and other
      head elements unchanged. _(Task 1)_
- [ ] **Vitest guard test added** under `apps/mobile/src` asserting the viewport
      meta content contains the **exact substring** `viewport-fit=cover` with **no
      whitespace-normalization**; `pnpm nx test mobile` green. _(Task 1)_
- [ ] **`android:windowBackground` = `#0b1326` added to `AppTheme.NoActionBar`
      only** in `styles.xml`; base `AppTheme` and `AppTheme.NoActionBarLaunch`
      unchanged; existing `android:background=@null` and
      `windowLayoutInDisplayCutoutMode=shortEdges` items unchanged; `#0b1326`
      copied from `capacitor.config.ts` (`--vultus-surface`). _(Task 2)_
- [ ] **`capacitor.config.ts`, `MainActivity.java`, `AndroidManifest.xml`,
      `theme.scss`, `app.ts` untouched** — 0029/0039/0045/0055/0062 intact; no
      new dependency / Gradle edit. _(Tasks 1 & 2 — verified by `git status`)_
- [ ] **`nx affected -t typecheck lint test build --base=main` green** — the
      mobile build + test targets are affected by the `index.html`/guard-test
      change and pass; with the accurate expectation that `nx affected` does not
      compile Android resources or prove the native/visual result. _(Task 1)_
- [ ] **`cap sync` (if run) touched no committed file other than `styles.xml`**;
      any other committed-file touch reverted and flagged (0062 precedent);
      git-ignored `capacitor.config.json` regeneration ignored. _(Task 1)_
- [ ] **Prettier / lint pass** on the changed files (`index.html` guard-test spec
      formatted, no CRLF — E2). _(Task 1)_
- [ ] **Native Gradle compile / native build verified during the native build
      step** — flagged human / post-merge (cannot run in-session; `nx affected`
      compiles no Java/resources). _(Task 2)_
- [ ] **No new automated e2e flow** — explicitly recorded (native/shell-only
      change; no new route/action; `viewport-fit=cover` inert on desktop, so the
      web Playwright run is unaffected). _(Test plan)_
- [ ] **Human device verification recorded** on the notched device — strip now
      dark navy / gone; content to the physical top with header inset below the
      notch; 0039 bars, 0045/0055 cutout, 0029 insets all sane; swipe-reveal
      correct; each top-level page eyeballed for content-behind-camera. **Flagged
      human / post-merge (load-bearing gate).** _(Tasks 1 & 2)_
- [ ] **No Firestore data-model / index / rule change** (none exist for this
      spec); **no secret** read or written; **no settings toggle / persistence**
      added. _(All tasks)_

## Risks

1. **The root cause is code/package-inspection-established, not
   device-confirmed.** The `SystemBars.java` passthrough analysis
   (`hasViewportCover` + WebView ≥ 140 → no padding; else pad with
   `displayCutout()`) and the AppCompat DayNight gray window-background
   attribution are inference from the installed packages + 0055's confirmed
   theme-mode layer — not yet device fact for _this_ fix. Following 0055/0062
   precedent, the fix is applied but the **human on-device check is the
   confirming gate**; do not report it working off code inspection alone.
2. **WebView < 140 devices keep the padded layout.** On such devices
   `shouldPassthroughInsets` stays false, Capacitor still pads the WebView
   parent by the cutout inset, and the WebView does **not** extend under the
   notch. The `styles.xml` `windowBackground` fallback makes the remaining strip
   paint dark navy `#0b1326` instead of AppCompat gray. This is an **acceptable
   degraded mode, not a failure** — the strip reads as part of the app even
   where the passthrough path is unavailable.
3. **With passthrough active, a page not using `ion-header` /
   `--ion-safe-area-top` could render content behind the camera.** Once the
   WebView extends under the cutout, only elements that consume the safe-area
   inset are pushed clear of the notch. The on-device check must eyeball each
   top-level page (watchlist, title detail, settings, etc.); if a page renders
   content behind the camera, that page needs a safe-area inset — a targeted
   fast-follow, not a spec 0064 failure.
4. **`viewport-fit=cover` is inert on desktop / no-notch environments.**
   `env(safe-area-inset-*)` resolves to 0 where there is no inset, so
   `serve-mock`, the e2e web server, and no-notch phones are unaffected. This is
   why the guard test asserts the token's _presence_ (the only in-session-checkable
   fact) rather than any rendered geometry.
5. **`styles.xml` is edited here even though 0062 forbade it.** This is
   **not** a contradiction: 0062 protected the confirmed-correct cutout _mode_
   layer (0055 Candidate C); this spec touches only the `windowBackground`
   _color_ on `AppTheme.NoActionBar`, leaving `windowLayoutInDisplayCutoutMode`,
   the theme parents, and `android:background=@null` untouched. Do not "clean up"
   or consolidate any existing style item; the edit is a single additive line.
6. **`capacitor.config.ts` must stay unchanged.** The 0062 top-level
   `backgroundColor: '#0b1326'` is kept (it still paints the WebView surface —
   overscroll glow, pre-first-paint). Do not remove or move it, and do not add
   `android.backgroundColor`.
7. **No architecture / PLAN conflict.** This adds **no slice, no cross-slice or
   cross-scope import, no shared logic, and no data-model change.** It is a
   static viewport token in the app's `index.html` (with a colocated guard test)
   plus a single native window-background color — the correct single home for
   each, consistent with 0029/0039/0045/0055/0062.
