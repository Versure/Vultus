---
number: 0055
slug: android-cutout-runtime-theme
title: Instrument the Android running-window theme to diagnose the still-visible camera-cutout letterbox, then apply the data-indicated fix
status: done
slices: []
scopes: [scope:mobile]
created: 2026-07-01
---

# Instrument the Android running-window theme to diagnose the still-visible camera-cutout letterbox, then apply the data-indicated fix

## Context

GitHub issue #91: "The native status and navigation bars are still visible on
Android." The issue's original ask (auto-hide both system bars, transient reveal
on swipe) and its 2026-06-29 follow-up (draw the app content all the way under the
camera cutout/notch) have each been the subject of a merged fix. Yet a **2026-07-01
comment on the issue** (screenshot attached) reports: "This still has not been
resolved... The cause should be analyzed carefully, since we've tried to solve
this issue multiple times now."

**This is not a "the fix never landed" situation — it is a "the fix landed and the
bug is still reported" situation.** All three prior specs are merged
(`status: done`) and **confirmed present in the code right now**:

- `docs/specs/0029-android-edge-to-edge.md` — added the `@capacitor/status-bar`
  overlay config (`capacitor.config.ts` `StatusBar` block: `style: 'DARK'`,
  `backgroundColor: '#0b1326'`, `overlaysWebView: true`), a guarded `StatusBar`
  init in `apps/mobile/src/app/app.ts`, and the `--ion-safe-area-*`
  (`env(safe-area-inset-*)`) wiring in `libs/shared/ui-kit/src/lib/theme.scss`.
- `docs/specs/0039-android-immersive-system-bars.md` — added `hideSystemBars()`
  (AndroidX `WindowInsetsControllerCompat`, hide `systemBars()`,
  `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`, re-applied in `onWindowFocusChanged`) in
  `android/app/src/main/java/app/vultus/mobile/MainActivity.java`. **This bars
  behavior is NOT reported as regressed** and is out of scope for this spec (see
  Scope).
- `docs/specs/0045-android-display-cutout.md` — added
  `android:windowLayoutInDisplayCutoutMode = shortEdges` to **both**
  `AppTheme.NoActionBar` and `AppTheme.NoActionBarLaunch` in
  `android/app/src/main/res/values/styles.xml` (both confirmed present, lines
  16 and 22 of the current file).

**Why a follow-on investigation, not a fourth guess.** Spec 0045 assumed
`AppTheme.NoActionBar` is "the running theme" and patched it. Code inspection now
surfaces a plausible reason that assumption may be wrong — and that three
"should-work" attempts have not visibly fixed the cutout:

- `android/app/src/main/AndroidManifest.xml` declares
  `<application android:theme="@style/AppTheme">` — the **plain** `AppTheme`
  (parent `Theme.AppCompat.Light.DarkActionBar`), which has **no**
  `windowLayoutInDisplayCutoutMode` and is **not** a NoActionBar variant.
- The activity declares `android:theme="@style/AppTheme.NoActionBarLaunch"`, whose
  parent is `Theme.SplashScreen` (from `androidx.core:core-splashscreen`, on the
  classpath per `android/app/build.gradle` / `variables.gradle`), and which **does**
  carry the cutout attribute (from 0045).
- There is **no** `postSplashScreenTheme` item on `AppTheme.NoActionBarLaunch`, and
  **no** `installSplashScreen()` call anywhere in `MainActivity.java` (grep: zero
  matches) or elsewhere under `android/`. Capacitor's splash here is the **legacy
  bitmap-based `@capacitor/splash-screen` plugin** (present under `node_modules`),
  which draws a splash view over the activity rather than using the AndroidX
  SplashScreen API's theme-swap. So **nothing in this app's own code ever explicitly
  re-applies `AppTheme.NoActionBar` to the running activity window**; the activity's
  theme for its entire lifetime is `AppTheme.NoActionBarLaunch`, inheriting from
  `Theme.SplashScreen` — a theme family designed to be transient, not a persistent
  app theme. The AndroidX base style defaults `postSplashScreenTheme` to
  `?android:attr/theme` when unset — i.e. back to the `<application>` theme, the
  plain cutout-less `AppTheme`.

**The consequence (hypothesis, NOT yet device-confirmed):** (a) `AppTheme.NoActionBar`
— the theme 0045 patched — may be **completely dead / never applied**, and (b) the
actual running theme's cutout/inset behavior is governed by whatever the
`Theme.SplashScreen` / `<application>`-`AppTheme` inheritance resolves to at runtime,
which has **not** been verified to propagate `windowLayoutInDisplayCutoutMode` the
way a normal `Theme.AppCompat.DayNight.NoActionBar`-rooted theme would. This
inheritance ambiguity is a plausible reason the cutout still letterboxes.

**This hypothesis has NOT been confirmed on a device.** No emulator/device tooling
is available in-session (documented recurring project limitation). Per the
architect's binding decision, **this spec does not prescribe a blind theme/manifest
edit as the fix.** It **instruments first** — adds temporary, clearly-marked
diagnostic logging so a human can capture, from a real notched device, the actual
running theme and the actual `WindowInsets` cutout values — **then** applies the
concrete fix the Logcat data indicates, and removes the diagnostics before merge.

**Intended outcome.** After this spec: (1) the true runtime theme + cutout-inset
behavior is captured from a real device and recorded on the issue/PR; (2) the app
window reliably uses the display-cutout region (dark surface behind the notch, no
black letterbox band, header inset below the notch), no longer depending on
ambiguous theme inheritance; (3) no diagnostic logging remains in the merged code.

## Scope

In scope (spread across **two sequential steps** — see Implementation task graph):

- **Step 1 (diagnostic):** temporary, clearly-marked-for-removal diagnostic logging
  in `android/app/src/main/java/app/vultus/mobile/MainActivity.java`, under a single
  Logcat tag (`VultusCutoutDiag`), capturing at runtime:
  - **which theme is actually resolved/active on the activity window** (e.g. the
    resolved theme resource id / name via `getTheme()` /
    `getWindow().getContext().getThemeResId()`-style lookup, or the current theme's
    resolved attributes), so we can tell whether `AppTheme.NoActionBar`,
    `AppTheme.NoActionBarLaunch`, or the plain `AppTheme` is in force;
  - the **resolved `layoutInDisplayCutoutMode`** on the running window
    (`getWindow().getAttributes().layoutInDisplayCutoutMode`);
  - the actual **`WindowInsets` display-cutout bounds** —
    `WindowInsetsCompat.getDisplayCutout()` / `DisplayCutout.getBoundingRects()` and
    the cutout safe insets (top/left/right/bottom) — read once insets are available
    (e.g. via a `setOnApplyWindowInsetsListener` on the decor view, logged then).
  - A brief sanity note that the **0039 bars behavior** (hidden + swipe-reveal)
    still looks sane — **as a secondary sanity check only, not a primary target**;
    do not touch/re-verify `hideSystemBars()` semantics.
- **Step 1 (human/device):** a human builds + installs on a **real notched Android
  device**, captures the `VultusCutoutDiag` Logcat output, and reports the findings
  on the issue/PR. This step **cannot run in-session** (device/emulator limitation).
- **Step 2 (corrective, gated on Step 1's data):** apply the **one** candidate fix
  the Logcat signature indicates (candidates enumerated in Public types / APIs),
  touching only the native file(s) that fix requires — most likely
  `android/app/src/main/AndroidManifest.xml` and/or
  `android/app/src/main/res/values/styles.xml` — **and remove all `VultusCutoutDiag`
  diagnostic logging** from `MainActivity.java`.

Out of scope:

- **The 0039 bars auto-hide / transient-reveal behavior.** It is **not** reported as
  regressed. Do **not** re-scope this spec to re-verify or modify
  `hideSystemBars()` / immersive-bar behavior — only note (Step 1 human check) that
  bars-hidden-and-swipe-reveal still looks sane. `hideSystemBars()` semantics are
  left as 0039 wrote them.
- **iOS.** Issue #91 is Android-only; iOS notch/safe-area handling is unaffected. No
  iOS file changes.
- **Any settings-slice change / toggle / persistence / Firestore field.** Behavior
  is **always-on, app-wide, no user control** — no settings toggle, no persistence,
  no Firestore field.
- **Undoing 0029 / 0039 / 0045.** They stay; this is additive-diagnostic-then-
  corrective. In particular the `@capacitor/status-bar` overlay/dark config and the
  `--ion-safe-area-*` wiring (0029) are **relied upon** and unchanged.
- **`capacitor.config.ts`, `apps/mobile/src/app/app.ts`, `theme.scss`, or any TS/JS
  file.** Not modified (Step 2 candidate fixes are native-only; the one candidate
  that points at the WebView/Ionic safe-area layer is a **report-back**, not an edit
  in this spec — see Public types / APIs).
- **Any new npm/Gradle dependency, `capacitor.config.ts` change, or new AndroidX
  library.** The diagnostics use AndroidX classes already on the classpath
  (`androidx.core.view.*`) transitively via Capacitor.
- **Any Firestore data-model / index / security-rule / domain-type / function /
  Sheriff-config change.**

## Affected slices & Sheriff tags

**No slice is built** (`slices: []`). The changed files are **native Android
sources/resources** (`MainActivity.java`, and in Step 2 likely
`AndroidManifest.xml` and/or `styles.xml`), **not** workspace TS/Nx projects.
**Sheriff/module boundaries do not apply to them** — Sheriff governs imports
between Nx/TS projects; Java/XML compiled directly by Gradle is outside that graph.
`scopes: [scope:mobile]` is **descriptive** (part of the mobile app's native shell)
and drives no slice Sheriff rule. This matches the posture of specs 0029/0039/0045.

- **No cross-slice or cross-scope import is introduced.** The AndroidX
  `androidx.core.view.*` imports are platform/library classes already on the Android
  classpath (transitive via Capacitor), not workspace-project imports. XML theme
  attributes are not imports.
- **No lib is touched**, so no lib `README.md` update applies.
- **No DRY / 3+-slice question arises** — no shared TS logic is added; this is a
  native window/theme diagnosis-then-config change in the app's native shell, the
  correct single home for it.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected). No persistence of any kind (no settings field).

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes. The changes are (Step 1) temporary native diagnostic logging and (Step 2) a
native theme/manifest configuration change.

**Approach (decided by the architect): "instrument first, then fix."** Do **not**
ship a blind theme/manifest edit as the fix. The exact Step 2 code change is
**contingent on data this session cannot obtain** (no device tooling), so this spec
describes **candidate** fixes keyed to specific Logcat signatures rather than a
single prescribed diff. The implementer applies exactly the candidate the captured
`VultusCutoutDiag` output points to.

### Step 1 — diagnostic logging contract (temporary, remove before merge)

Add to `MainActivity.java`, under the single Logcat tag `VultusCutoutDiag`,
**clearly commented as diagnostic-only and to be removed** (e.g. a
`// TODO(0055): DIAGNOSTIC — remove before merge` banner around the block). The
diagnostics must, at minimum, log:

1. **The actually-resolved running theme** on the activity window — enough to
   distinguish `AppTheme.NoActionBar` vs `AppTheme.NoActionBarLaunch` vs the plain
   `AppTheme`. Acceptable techniques: resolve the theme resource name from the
   activity's current theme, and/or log the resolved value of key theme attributes
   (e.g. whether the running theme carries `windowLayoutInDisplayCutoutMode`).
2. **The window's resolved `layoutInDisplayCutoutMode`** —
   `getWindow().getAttributes().layoutInDisplayCutoutMode` (log both `onCreate` and,
   after focus, `onWindowFocusChanged`, since the value may change if the theme
   swaps).
3. **The actual display-cutout insets/bounds** once `WindowInsets` are available:
   attach a `setOnApplyWindowInsetsListener` (via `WindowCompat`/
   `ViewCompat.setOnApplyWindowInsetsListener` on the decor/root view) and log
   `WindowInsetsCompat.getDisplayCutout()` (null vs non-null),
   `DisplayCutout.getBoundingRects()`, and the cutout safe insets
   (top/left/right/bottom). **Return the insets unconsumed** from the listener so
   the diagnostic does not alter inset propagation.

The diagnostics must **not** change window behavior: do **not** consume insets, do
**not** call `setDecorFitsSystemViews`, do **not** alter `hideSystemBars()` — the
existing 0039 logic stays exactly as-is; the diagnostic code is purely additive
logging alongside it. Guard against API-level differences where needed (cutout APIs
are API-28+; `minSdk` is 24 per `android/app/build.gradle`) so the diagnostic build
does not crash on older devices.

### Step 1 — human/device capture (the gate for Step 2)

A human builds + installs on a **real notched device** with the device-level
full-screen / use-cutout setting enabled, reproduces the reported letterbox, and
captures the `VultusCutoutDiag` Logcat output (`adb logcat -s VultusCutoutDiag`),
posting it to the issue/PR. **Cannot run in-session** (device/emulator limitation).

### Step 2 — candidate fixes, keyed to the Logcat signature

Apply the **one** candidate the captured data supports; do not stack blind changes.

- **Candidate A — running theme resolves away from a cutout-carrying theme / loses
  the `windowLayoutInDisplayCutoutMode` attribute** (e.g. Logcat shows the running
  theme is the plain `AppTheme`, or `layoutInDisplayCutoutMode` resolves to `DEFAULT`
  / `0` rather than `shortEdges`/`2`): **stop depending on ambiguous inheritance.**
  Set the running app theme **explicitly** to a cutout-carrying theme —
  set `android:theme="@style/AppTheme.NoActionBar"` on `<application>` in
  `AndroidManifest.xml` (currently the plain `AppTheme`), so the persistent
  post-splash window theme is a NoActionBar theme that carries the cutout attribute.
  Optionally also add a `postSplashScreenTheme` redirect
  (`<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>`) on
  `AppTheme.NoActionBarLaunch` so the theme swap is explicit. Whether to keep the
  cutout attribute on `NoActionBarLaunch` as well (belt-and-suspenders, as 0045 did)
  is the **implementer's call once the data is in** — but the goal is that the app
  **never** relies on `Theme.SplashScreen`'s implicit `?android:attr/theme` default
  to carry the cutout. Confirm the fix on-device (re-capture without the black band)
  before removing diagnostics.
- **Candidate B — cutout attribute IS correctly active but `WindowInsets` cutout is
  empty/zero** (Logcat shows the running theme carries `shortEdges` /
  `layoutInDisplayCutoutMode == shortEdges` **and** `getDisplayCutout()` is null or
  bounds are empty): the issue is **not** the theme — it is elsewhere (e.g. the
  OS-level "display cutout area" per-app/system setting not actually engaged on the
  test device, or a `fitsSystemWindows` remnant consuming the inset). **Do not guess
  further** — the implementer **reports back** the finding on the issue/PR
  (needs-human / new investigation) rather than applying a speculative edit.
- **Candidate C — correct theme + correct non-empty insets, but the safe-area CSS
  still doesn't reflect it** (Logcat shows the running theme carries the cutout mode
  and `getDisplayCutout()` returns non-empty bounds, yet the app still letterboxes
  or the header overlaps the notch): the gap is in the **WebView/Ionic safe-area
  layer** (0029's territory — `env(safe-area-inset-top)` →
  `--ion-safe-area-top`), **not** the native theme. **Report back** with the inset
  values; a targeted 0029-layer follow-up spec (not a native change here) is the
  remedy. Do **not** edit `theme.scss` / TS blindly under this spec.

**In all candidates:** once the corrective change (if any) is applied and confirmed,
**remove every `VultusCutoutDiag` diagnostic block** from `MainActivity.java`,
returning it to the 0039 shape plus only the intended Step-2 change (which for
Candidates B and C is _no code change_ — just a reported finding).

**Rejected approach** (do not implement): shipping a speculative
manifest/`styles.xml` edit **without** first capturing the runtime theme/inset data.
Three prior "should-work" edits have not fixed the user's device; a fourth blind
edit risks the same. The captured Logcat signature is the required gate for choosing
the change.

## UI / Stitch screen refs

**No Stitch screen fetch required.** This spec introduces **no new screen,
component, or design token** — Step 1 is native diagnostic logging and Step 2 (if it
edits anything) is a native Android window/theme attribute, not any in-app pixel.
There is nothing to pull from Stitch and **no `--vultus-*` token added or
transcribed**.

The intended visual end-state (dark `--vultus-surface` navy `#0b1326` filling
behind the notch; header inset below the notch via the 0029
`--ion-safe-area-top: env(safe-area-inset-top)` wiring) is the **contract of specs
0029/0045** — governed by `docs/design/vultus-design-system.md` and
`libs/shared/ui-kit/src/lib/theme.scss`, **not** re-specified here. Visual
correctness is verified on a real notched device (Test plan), not against a Stitch
screen. No hex is hand-transcribed in this spec.

## Implementation task graph

Two **[sequential]** steps; Step 2 is **gated on Step 1's human-provided Logcat
data**. This is **infrastructure-engineer** territory (native Android
build/theme/manifest is the infrastructure-engineer's domain per CLAUDE.md); the
files are native Java/XML. There is **no parallel fan-out** (Step 2 depends on Step
1's device output) and thus **no file manifests** needed.

### 1. [sequential] Add `VultusCutoutDiag` diagnostics + human captures Logcat on a notched device

Files: `android/app/src/main/java/app/vultus/mobile/MainActivity.java` (only file
changed in this step).

- Add the temporary, clearly-marked-for-removal `VultusCutoutDiag` diagnostic
  logging exactly per **Public types / APIs § Step 1**: log the resolved running
  theme, the window `layoutInDisplayCutoutMode`, and the actual `WindowInsets`
  display-cutout bounds/insets (via an unconsuming
  `setOnApplyWindowInsetsListener`). Do **not** alter `hideSystemBars()` or 0039
  behavior; do **not** consume insets or call `setDecorFitsSystemViews`.
- Do **not** modify `capacitor.config.ts`, `apps/mobile/src/app/app.ts`,
  `theme.scss`, `styles.xml`, `AndroidManifest.xml`, or any TS/JS file in this step.
- Do **not** add any npm/Gradle dependency (`androidx.core.view.*` is already on the
  classpath via Capacitor).
- **`npx cap sync android` is not required** (no `capacitor.config.ts` change;
  `MainActivity.java` is a committed native source compiled directly by Gradle). If
  run, confirm it does **not** clobber the hand-edited `MainActivity.java` (`cap
sync` regenerates only plugin/config glue).
- **Human/device gate (cannot run in-session):** a human builds + installs on a
  **real notched Android device** (device-level use-cutout setting enabled),
  reproduces the letterbox, captures `VultusCutoutDiag` Logcat output
  (`adb logcat -s VultusCutoutDiag`), and posts the theme, `layoutInDisplayCutoutMode`,
  and display-cutout inset/bounds values (and a bars-hidden sanity note) to the
  issue/PR. **This is the required input for Step 2.**

### 2. [sequential] Apply the data-indicated candidate fix + remove diagnostics — GATED on Step 1's Logcat

Files (depends on the chosen candidate): `AndroidManifest.xml` and/or
`android/app/src/main/res/values/styles.xml` (Candidate A);
`android/app/src/main/java/app/vultus/mobile/MainActivity.java` (diagnostics removal
in **all** candidates). Candidates B and C make **no** corrective code change — only
a reported finding — but still require the diagnostics removal.

- Read the Step-1 Logcat findings and select the **single** matching candidate from
  **Public types / APIs § Step 2** (A: explicit `<application>` theme →
  `AppTheme.NoActionBar` and/or `postSplashScreenTheme` redirect; B: report-back,
  issue is OS-setting / `fitsSystemWindows`, no blind edit; C: report-back, gap is
  the 0029 WebView safe-area layer, no `theme.scss` edit here).
- **Remove every `VultusCutoutDiag` diagnostic block** from `MainActivity.java`,
  returning it to the 0039 shape (plus, for Candidate A, no `MainActivity` change is
  needed — the fix is in the manifest/styles).
- For Candidate A: preserve existing style parents/items; do **not** touch the unused
  base if not required; keep 0029/0039/0045 config intact and complementary.
- Do **not** add any npm/Gradle dependency or change `capacitor.config.ts`.
- **`npx cap sync android` is not required** for a `styles.xml`/`AndroidManifest.xml`
  edit (committed native resources compiled directly by Gradle; `cap sync` neither
  generates nor clobbers them). If run, it must **not** be relied upon to apply the
  change.
- **Human/device gate (cannot run in-session):** re-build + install on the notched
  device; confirm the corrective change (Candidate A) removes the black letterbox
  band (dark surface behind the notch, header inset below it) and that 0039 bars
  behavior is still sane; for Candidates B/C confirm the reported finding and that
  no diagnostic logging remains. Recorded on the PR.
- Gate: `nx affected -t typecheck lint test build --base=main` will likely show **no
  affected TS project** (no workspace TS file changed); that is expected. **`nx
affected` does not compile Java or package Android resources**, so a green
  `nx affected` does **not** prove the Java compiles or the theme change took effect
  — do not report the native build as done off it (see Test plan).

## Test plan

Per the PLAN §5 pyramid, **honest**: there is **no automated test surface** for this
change. Both the diagnostic step and any corrective step are **device-only native
window/theme behavior** with no TS/JS code and no slice logic — so there is **no
unit or component test to add**, and the diagnostic Logcat capture is **itself a
human/device-only step that cannot run in-session** (recurring documented
emulator/device tooling limitation in this project). This matches the honest framing
of 0039/0045.

- **Unit (Vitest):** **none** — no TS/JS logic is added or changed; the only files
  are native Java/XML. There is nothing to spy on or assert.
- **Component tests:** **none** — no slice component is added or changed.
- **e2e tests:** **No e2e flows required — native/diagnostic Android-only change,
  invisible to the web Playwright run.** Per the PLAN §5 e2e rubric this introduces
  **no new navigation route and no new user action**; the web build is unchanged and
  the native cutout/theme behavior cannot be exercised by the web Playwright suite.
  Existing flows are untouched and nothing is un-skipped. Stated explicitly so the
  omission is intentional.
- **Automated gate (workspace):** `nx affected -t typecheck lint test build
--base=main` will likely show **no affected TS project**; **expected and
  acceptable**. **`nx affected` compiles neither Java nor Android resources**, so a
  green run does **not** prove `MainActivity.java` compiles or the theme change took
  effect — do not report the native build as done off it.
- **Android Gradle compile / resource build** is verified **during the native build
  step**, which **cannot run in-session** (no native build/device tooling here, per
  the project's emulator/device limitation). **Flagged human / post-merge.**
- **Human device capture — Step 1 (the diagnostic gate; cannot run in-session; needs
  a physical Android device WITH A CAMERA NOTCH/CUTOUT + a native build; per the
  project's emulator/device tooling limitation).** With the device-level
  full-screen / use-cutout setting enabled, after build + install:
  1. Reproduce the reported black letterbox band above the content.
  2. Capture `VultusCutoutDiag` Logcat (`adb logcat -s VultusCutoutDiag`) and record:
     the **resolved running theme**, the window **`layoutInDisplayCutoutMode`**, and
     the **display-cutout bounds/insets** (`getDisplayCutout()` null vs non-null,
     `getBoundingRects()`, safe insets). Post to the issue/PR.
  3. **Sanity only (not a primary target):** confirm the 0039 bars are still hidden
     with transient swipe-reveal — a regression note, not a verification goal.
- **Human device capture — Step 2 (the corrective gate; cannot run in-session; same
  device requirement). Flagged human / post-merge.** After the data-indicated change
  and diagnostics removal, re-build + install:
  1. **Candidate A:** the app's dark surface draws all the way to the top edge,
     filling **behind** the camera notch — **no black letterbox band**; the
     `IonHeader`/toolbar content is **not obscured** (inset below the notch); 0039
     bars behavior still sane.
  2. **Candidate B/C:** confirm the reported finding is consistent with a re-capture
     (no blind edit was made) and that **no `VultusCutoutDiag` logging remains**.
  3. In all candidates: **no diagnostic logging remains** in the merged
     `MainActivity.java`.

## Definition of done

Tailored from the PLAN §5 checklist. There is **no affected workspace TS project**;
the affected artifact is the **native Android app**.

- [ ] **Step 1 diagnostics added** to `MainActivity.java` under tag
      `VultusCutoutDiag`, logging the resolved running theme, the window
      `layoutInDisplayCutoutMode`, and the actual `WindowInsets` display-cutout
      bounds/insets (via an **unconsuming** apply-insets listener), **clearly marked
      for removal**, without altering 0039 `hideSystemBars()` behavior or consuming
      insets.
- [ ] **Step 1 human Logcat capture recorded** on the issue/PR from a **real notched
      device** — running theme + `layoutInDisplayCutoutMode` + display-cutout
      bounds/insets, plus a bars-hidden sanity note. **Flagged human / post-merge**
      (per the device-tooling limitation).
- [ ] **Step 2 applied per the captured signature** — exactly **one** candidate
      (A: explicit `<application>` theme → `AppTheme.NoActionBar` and/or
      `postSplashScreenTheme`; B or C: reported-back finding, **no blind edit**), not
      a stack of speculative changes.
- [ ] **All `VultusCutoutDiag` diagnostic logging removed** from `MainActivity.java`
      before merge (returned to the 0039 shape plus only the intended Step-2 change,
      if any).
- [ ] **0029 / 0039 / 0045 untouched and intact** (`capacitor.config.ts`,
      `apps/mobile/src/app/app.ts`, `theme.scss` not modified; `hideSystemBars()`
      semantics unchanged); **no new dependency / Gradle edit /
      `capacitor.config.ts` change**; **no `npx cap sync android` dependency**.
- [ ] **Native Gradle compile / resource build verified during the native build
      step** (flagged human / post-merge — it cannot run in-session and `nx affected`
      compiles neither Java nor Android resources).
- [ ] **No new automated e2e flow** — explicitly recorded (native/diagnostic-only
      change; no new route/action; invisible to the web Playwright run).
- [ ] **Step 2 human device verification recorded** on a notched device — Candidate
      A: no black band, header not obscured, 0039 bars sane; Candidate B/C: finding
      confirmed, no diagnostics remain. **Flagged human / post-merge.**
- [ ] **No Firestore data-model / index / rule change**; **no secret** read or
      written; **no settings toggle / persistence** added.

## Risks

1. **The root-cause hypothesis is unconfirmed on a device.** The theory that
   `AppTheme.NoActionBar` is dead and the running theme resolves (via
   `Theme.SplashScreen` → `?android:attr/theme` → the plain `AppTheme`) to a
   cutout-less theme is **inference from code, not device fact**. This is exactly why
   the spec **instruments first** — Step 1's Logcat is the gate; Step 2 must follow
   the data, not the hypothesis. Do **not** ship a Step-2 edit before Step 1's
   capture.
2. **Three prior "should-work" edits did not fix the user's device.** A fourth blind
   manifest/`styles.xml` edit risks the same failure. The captured runtime signature
   (Candidate A vs B vs C) is the required discriminator; Candidates B and C are
   deliberately **report-back**, not guess-and-edit, so the spec cannot devolve into
   a fourth blind attempt.
3. **Splash-theme inheritance ambiguity.** `AppTheme.NoActionBarLaunch` parents
   `Theme.SplashScreen` (AndroidX core-splashscreen) with no `postSplashScreenTheme`
   and no `installSplashScreen()` call, while Capacitor uses the **legacy bitmap**
   `@capacitor/splash-screen` plugin. Which theme governs the persistent window is
   the crux the diagnostics resolve; Candidate A (explicit `<application>` theme
   and/or `postSplashScreenTheme`) removes the dependence on that ambiguity if the
   data confirms it.
4. **Diagnostic code must not change behavior or ship.** The `VultusCutoutDiag`
   listener must return insets **unconsumed** and must not call
   `setDecorFitsSystemViews` / alter `hideSystemBars()`, or it could itself mask or
   change the very behavior being measured. It must be **fully removed** before merge
   (DoD gate) — a stray diagnostic log left in the shipped app is a defect.
5. **Cutout APIs are API-28+; `minSdk` is 24.** The diagnostic cutout reads (and any
   Candidate-A attribute) must degrade safely on API < 28 (attribute ignored;
   guard the cutout API reads) so the diagnostic build does not crash on older
   devices.
6. **`cap sync` must not clobber `MainActivity` / be relied on for resources.**
   `npx cap sync android` neither overwrites `MainActivity.java` nor generates
   `styles.xml`/`AndroidManifest.xml`; it is **not required** and must not be relied
   upon to apply (or lose) the hand-edits. Noted so the implementer does not lose
   work or expect `cap sync` to apply the fix.
7. **Bug scope is narrow (cutout only).** The 0039 bars behavior is **not** in scope;
   only a sanity note. Do not expand this spec to re-verify or modify immersive-bar
   behavior.
8. **No architecture / PLAN conflict.** This adds **no slice, no cross-slice or
   cross-scope import, no shared logic, and no data-model change.** It is a native
   diagnose-then-configure change in native Android sources outside the
   Nx/TS/Sheriff graph — the correct single home for native window/theme
   investigation and config.
