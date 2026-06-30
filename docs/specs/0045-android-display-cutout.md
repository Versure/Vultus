---
number: 0045
slug: android-display-cutout
title: Draw under the camera notch on Android (display-cutout mode)
status: done
slices: []
scopes: [scope:mobile]
created: 2026-06-30
---

# Draw under the camera notch on Android (display-cutout mode)

## Context

GitHub issue #91. The issue's **original** request (auto-hide both system bars,
transient reveal on swipe) was already delivered by merged spec
`docs/specs/0039-android-immersive-system-bars.md` (status: done):
`MainActivity.java` now hides both bars with
`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`. And merged spec
`docs/specs/0029-android-edge-to-edge.md` (status: done) made the web view render
edge-to-edge via the `@capacitor/status-bar` `overlaysWebView: true` config + a
guarded `StatusBar` init in `apps/mobile/src/app/app.ts`, and wired the
`--ion-safe-area-*` CSS vars (`env(safe-area-inset-*)`) in
`libs/shared/ui-kit/src/lib/theme.scss`.

The **remaining open item** is the issue's **follow-up comment** (by the owner,
2026-06-29): "After the fix the top navigation bar is not visible, but the app
does not display right to the top when a camera indent is there, whilst having
configured Android to display apps to the top of the screen."

**Root cause (confirmed by code analysis).** The app window never opts into
Android's display-cutout layout mode. There is **no**
`android:windowLayoutInDisplayCutoutMode` anywhere:
`android/app/src/main/res/values/styles.xml` defines `AppTheme`,
`AppTheme.NoActionBar`, and `AppTheme.NoActionBarLaunch`, and **none** of them set
it; `MainActivity.java` never sets
`getWindow().getAttributes().layoutInDisplayCutoutMode`. With the system bars
hidden (0039) and edge-to-edge on (0029), Android's **default** cutout behavior
**letterboxes** the app — content does not render into the display-cutout (camera
notch) region, leaving a **black band** at the top where the notch is, even when
the user has enabled the device-level "display this app full screen / use the
cutout area" setting. The app's own window must explicitly opt in; the per-app
system setting **cannot override a window that has not opted in**.

**Intended outcome.** On a device with a camera cutout/notch, the app draws all
the way to the top edge: the app's dark surface fills **behind** the camera notch
(no black letterbox band), while the actual UI chrome (`IonHeader`/toolbar) is
inset **below** the notch via the already-wired `env(safe-area-inset-top)` →
`--ion-safe-area-top` (which, once cutout mode is enabled, includes the cutout
height). This is a **one-attribute native-theme configuration change** — **not** a
layout/design change and **not** a TS/JS change.

## Scope

In scope:

- **`android/app/src/main/res/values/styles.xml`** — the single changed file. Add
  `<item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>` to:
  - **`AppTheme.NoActionBar`** (the post-splash **running** theme), and
  - **`AppTheme.NoActionBarLaunch`** (the **launch/splash** theme the activity
    starts under, per `AndroidManifest`
    `android:theme="@style/AppTheme.NoActionBarLaunch"`).

  Rationale for setting it on **both**: `layoutInDisplayCutoutMode` is a per-window
  layout param re-applied when a theme is applied; the manifest launches the
  activity under the **Launch** theme and there is **no** `postSplashScreenTheme`
  redirect in `styles.xml`, so setting it on both themes guarantees the cutout area
  is used from the **first frame** through the running app, regardless of exactly
  when/if Capacitor's splash flow swaps themes.

Out of scope:

- **iOS.** The issue is Android-only; iOS safe-area/notch handling is unaffected.
  No iOS file changes.
- **Any settings-slice change / toggle / persistence / Firestore field.** Behavior
  is **always-on, app-wide, no user control** — no settings toggle, no
  persistence, no Firestore field.
- **`MainActivity.java`.** **Not** modified. The 0039 immersive logic stays exactly
  as-is and is complementary.
- **`capacitor.config.ts`, `apps/mobile/src/app/app.ts`, `theme.scss`, or any
  TS/JS file.** **Not** modified. The 0029 `StatusBar` overlay/dark config and the
  already-wired `--ion-safe-area-*` vars stay as-is and are **relied upon** (with
  cutout mode on, the top safe-area inset now includes the notch height, so the
  header insets below the notch automatically — **no new inset code**).
- **Undoing or altering 0029 or 0039.** They stay; this is purely **additive and
  complementary**.
- **Any new dependency, Gradle dependency edit, or `capacitor.config.ts` change.**
  `npx cap sync android` is **not required** — the edited file is a committed
  native Android resource compiled directly by Gradle; `cap sync` does not generate
  or clobber `styles.xml`. If an implementer runs `cap sync`, it must **not** be
  relied upon to apply this change.
- **Any Firestore data-model / index / security-rule / domain-type / function /
  Sheriff-config change.**

## Affected slices & Sheriff tags

**No slice is built** (`slices: []`). The only changed file is a **native Android
resource file**, `android/app/src/main/res/values/styles.xml`, **not** a workspace
TS/Nx project. **Sheriff/module boundaries do not apply to it** — Sheriff governs
imports between Nx/TS projects; an Android resource compiled directly by Gradle is
outside that graph. `scopes: [scope:mobile]` is **descriptive** (it is part of the
mobile app's native shell) and drives no slice Sheriff rule.

- **No cross-slice or cross-scope import is introduced.** A theme attribute in an
  XML resource is not a workspace-project import.
- **No lib is touched**, so no lib `README.md` update applies.
- **No DRY / 3+-slice question arises** — no shared TS logic is added; this is a
  one-attribute native theme change in a single Android resource file, the correct
  single home for native window/theme config.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected). No persistence of any kind (no settings field).

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes. The only change is the native theme attribute.

**Chosen approach (decided): declarative theme attribute, value `shortEdges`.** Add
`android:windowLayoutInDisplayCutoutMode` to the running-window theme(s) in
`styles.xml`. `shortEdges` is Google's recommended value for fullscreen/immersive
apps — content extends into the cutout on the **short edges** (the top notch in
portrait), which is exactly the issue's case, while **avoiding** drawing under side
notches in landscape.

`android:windowLayoutInDisplayCutoutMode` is an **API-28+** theme attribute and is
simply **ignored** on older API levels; `minSdk` is **24** (confirmed in
`android/app/build.gradle` / the merged manifest), so it degrades safely with **no
crash** and **no `Build.VERSION` guard** is needed. There is **no** `MainActivity`
change.

**Concrete `styles.xml` diff (the checkable contract).** Existing parents and items
are preserved; only the two `<item>` lines below are added. `AppTheme` (the unused
`Theme.AppCompat.Light.DarkActionBar` base) is **left untouched**.

```xml
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
    </style>


    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
    </style>
```

**Rejected approaches** (do not implement):

- **Value `always` instead of `shortEdges`** — more aggressive: it places content
  under **side** notches in landscape (not wanted here), and the `always` value
  itself requires **API 30+**. `shortEdges` is the recommended fit for the issue.
- **Programmatic `MainActivity` change**
  (`getWindow().getAttributes().layoutInDisplayCutoutMode = …`) — rejected in favor
  of the declarative theme attribute, which is cleaner, applies **before the first
  frame**, and needs **no version guard**. `MainActivity.java` is left exactly as
  0039 wrote it.

## UI / Stitch screen refs

**No Stitch screen fetch required.** This spec introduces **no new screen,
component, or design token** — it changes a **native Android window/theme
attribute**, not any in-app pixel. There is nothing to pull from Stitch and **no
`--vultus-*` token added or transcribed**.

With cutout mode enabled, the existing dark `--vultus-surface` (`#0b1326`) navy
fills **behind** the notch, and the existing 0029 safe-area wiring
(`--ion-safe-area-top: env(safe-area-inset-top)`) insets the header **below** the
notch. No token is added or transcribed here; the surface color and inset behavior
are the contract of specs 0029/0039 (governed by
`docs/design/vultus-design-system.md` and `theme.scss`), not re-specified in this
file — this spec only enables the window to use the cutout region. Visual
correctness is verified on a real notched device (Test plan), not against a Stitch
screen.

## Implementation task graph

A single **[sequential]** task. This is **infrastructure-engineer** territory:
native Android build/theme config is the infrastructure-engineer's domain per
CLAUDE.md, and the only file is a native Android resource. There is **no parallel
fan-out** and thus **no file manifests** needed.

### 1. [sequential] Enable display-cutout layout mode on both running-window themes

Files: `android/app/src/main/res/values/styles.xml` (the only changed file).

- Add `<item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>` to
  **both** `AppTheme.NoActionBar` and `AppTheme.NoActionBarLaunch`, exactly as in
  **Public types / APIs** above, **preserving** each style's existing parent and
  items. Do **not** add it to the unused `AppTheme` base.
- Do **not** modify `MainActivity.java`, `capacitor.config.ts`,
  `apps/mobile/src/app/app.ts`, `theme.scss`, or any TS/JS file. The 0029 + 0039
  setups stay as-is.
- Do **not** add any npm package, edit Gradle dependency declarations, or change
  `capacitor.config.ts`.
- **`npx cap sync android` is not required** — `styles.xml` is a committed native
  Android resource compiled directly by Gradle; `cap sync` neither generates nor
  clobbers it. If the implementer runs `cap sync`, it must **not** be relied upon
  to apply this change.
- Gate: the Android resource build of `styles.xml` is verified **during the native
  build step** — **flagged human / post-merge** (it cannot run in-session and
  `nx affected` will not compile/package Android resources). A green `nx affected`
  does **not** prove the theme change took effect (see Test plan).

## Test plan

Per the PLAN §5 pyramid, **honest**: there is **no automated test surface** for
this change. The display-cutout mode is a **device-only native theme attribute**
with no TS/JS code and no slice logic, so there is **no unit or component test to
add**.

- **Unit (Vitest):** **none** — no TS/JS logic is added or changed; the only file
  is a native Android resource. There is nothing to spy on or assert.
- **Component tests:** **none** — no slice component is added or changed.
- **e2e tests:** **No new e2e flow required — native-only theme change, invisible
  to the web Playwright run.** Per the PLAN §5 e2e rubric, this introduces **no new
  navigation route and no new user action**; the web build is unchanged and the
  native cutout layout cannot be exercised by the web Playwright suite. Existing
  flows are untouched and nothing is un-skipped. Stated explicitly so the omission
  is intentional.
- **Automated gate (workspace):** `nx affected -t typecheck lint test build
  --base=main` will likely show **no affected TS project** (no workspace TS file
  changed); that is **expected and acceptable** here. **`nx affected` does not
  compile/package the Android resources**, so a green `nx affected` does **not**
  prove the theme change took effect — do not report it as done off that.
- **Android resource build of `styles.xml`** is verified **during the native build
  step**, which **cannot run in-session** (no native build / device tooling here,
  per the project's emulator/device limitation). **Flagged human / post-merge**,
  same gate as the device verification below.
- **Human device verification (the real functional gate — cannot run in-session;
  needs a physical Android device WITH A CAMERA NOTCH/CUTOUT + a native build, per
  the project's emulator/device tooling limitation). Flagged human / post-merge.**
  After build + install, with the device-level full-screen / use-cutout setting
  enabled:
  1. The app's **dark surface draws all the way to the top edge**, filling
     **behind** the camera notch — **no black letterbox band** above the content.
  2. The `IonHeader`/toolbar content is **not obscured** by the camera — it is
     inset **just below** the notch (safe-area top now includes the cutout height).
  3. The **0039 behavior still holds**: both system bars hidden on launch;
     transient reveal on edge swipe; auto-hide after a few seconds; revealed bars
     dark with light icons (**0029 intact**).
  4. **Rotate to landscape:** with `shortEdges`, content is **not** placed under a
     side notch — the left/right edges letterbox in landscape, which is
     **acceptable/expected** for `shortEdges` (sanity check, not a regression).
  5. **No color flash** at the top during launch/navigation (`#0b1326` fills the
     cutout region).

## Definition of done

Tailored from the PLAN §5 checklist. There is **no affected workspace TS project**;
the affected artifact is the **native Android app**.

- [ ] `android/app/src/main/res/values/styles.xml`: **both** `AppTheme.NoActionBar`
      and `AppTheme.NoActionBarLaunch` carry
      `android:windowLayoutInDisplayCutoutMode = shortEdges`; existing parents and
      items preserved.
- [ ] **No `MainActivity` change**; **no `Build.VERSION` guard**; **no new
      dependency / Gradle edit / `capacitor.config.ts` change**; **0029 + 0039
      untouched** (`MainActivity.java`, `capacitor.config.ts`,
      `apps/mobile/src/app/app.ts`, `theme.scss` not modified).
- [ ] **No `npx cap sync android` dependency** — `styles.xml` is a committed native
      resource (`cap sync` neither generates nor clobbers it); recorded in the PR.
- [ ] **Android resource build of `styles.xml` verified during the native build
      step** (flagged human / post-merge — it cannot run in-session and
      `nx affected` will not compile/package Android resources).
- [ ] **No new automated e2e flow** — explicitly recorded (native-only theme
      change; no new route/action; invisible to the web Playwright run).
- [ ] **Human device verification recorded on a notched device** — app fills behind
      the notch (no black band); header not obscured (inset below notch); 0039 bars
      still hidden + transient reveal + dark/light icons; landscape sanity
      (`shortEdges` letterboxes side notches); no color flash. **Flagged human /
      post-merge** (per the device-tooling limitation).
- [ ] **No Firestore data-model / index / rule change**; **no secret** read or
      written; **no settings toggle / persistence** added.

## Risks

1. **Which theme governs the running window.** The activity launches under
   `AppTheme.NoActionBarLaunch` and there is no `postSplashScreenTheme` redirect in
   `styles.xml`, so it is not perfectly clear when (or if) Capacitor's splash flow
   swaps to `AppTheme.NoActionBar`. **Mitigated** by setting the attribute on
   **both** themes, so the cutout area is used from the first frame onward.
   Verified in device-check step 1.
2. **Coexistence with 0029 (edge-to-edge overlay) and 0039 (hidden bars).** Purely
   **additive**: cutout mode + hidden bars + safe-area inset **compose** — the dark
   surface fills the notch region while the header insets below it. Verified in
   device-check steps 1–3.
3. **Safe-area top must now include the cutout.** This relies on the already-wired
   `--ion-safe-area-top: env(safe-area-inset-top)` (0029). On Android,
   `env(safe-area-inset-top)` only includes the cutout **once the window opts into
   cutout layout** — which is exactly what this spec enables — so the two compose
   correctly. **No new inset code is added here.** If the header is found
   overlapping the camera on-device, that is the gate (device-check step 2).
4. **`shortEdges` covers short edges only** — the top notch in portrait (the
   issue's case). **Side notches in landscape remain letterboxed by design**; noted
   so the landscape behavior is **not** mistaken for a regression (device-check
   step 4).
5. **Older-API safety.** `android:windowLayoutInDisplayCutoutMode` is an API-28+
   attribute and is **ignored** on API < 28; `minSdk` is **24**, so it degrades
   gracefully with **no crash** and **no version guard**.
6. **`cap sync` must not be relied upon.** `styles.xml` is a hand-edited committed
   native resource; `npx cap sync android` neither generates nor clobbers it, and
   the change requires no `capacitor.config.ts` edit. Noted so the implementer does
   not expect `cap sync` to apply (or lose) the change.
7. **No architecture / PLAN conflict.** This adds **no slice, no cross-slice or
   cross-scope import, no shared logic, and no data-model change.** It is a
   one-attribute native theme change in a single Android resource file outside the
   Nx/TS/Sheriff graph — the correct home for native window/theme config.
