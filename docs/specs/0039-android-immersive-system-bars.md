---
number: 0039
slug: android-immersive-system-bars
title: Auto-hide the Android status & navigation bars (sticky immersive mode)
status: approved
slices: []
scopes: [scope:mobile]
created: 2026-06-29
---

# Auto-hide the Android status & navigation bars (sticky immersive mode)

## Context

GitHub issue #91: "The native status and navigation bars are still visible on
Android. When using the app the Android status bar on top and the android
navigation bar on the bottom of the screen are visible. I want them to only
appear when swiping up or down and disappear after a few seconds."

**Relationship to prior work.** This is a direct follow-on to merged spec
`docs/specs/0029-android-edge-to-edge.md` (status: done). Spec 0029 made the web
view render **edge-to-edge** — it added a `StatusBar` plugin config
(`overlaysWebView: true`, `style: 'DARK'`, `backgroundColor: '#0b1326'`) in
`capacitor.config.ts` and a guarded `StatusBar.setOverlaysWebView` /
`setStyle(Style.Dark)` init in `apps/mobile/src/app/app.ts`, so content now draws
**under** the system chrome. But 0029 only makes the app draw under the bars; it
does **not** hide them — both the status bar (top) and the navigation bar
(bottom) remain **visible**. 0029 is "draw under the bars"; **0039 is "hide the
bars, reveal them transiently on swipe."**

The two specs are **complementary, not overlapping**: 0039 does **not** undo or
alter any 0029 config. The 0029 overlay/dark-style setup stays exactly as-is, so
that when a bar transiently reappears on swipe it still renders dark with light
icons.

**Intended outcome.** On Android, both the status bar and the navigation bar are
**hidden everywhere in the app** from launch. A swipe from the top or bottom edge
**transiently reveals** the relevant bar, which then **auto-hides after a few
seconds** (Android's "sticky immersive" behavior). This is achieved purely
through a native window-behavior change in `MainActivity.java` — no new
dependency, no TS/JS change, no Firestore field.

## Scope

In scope:

- **`android/app/src/main/java/app/vultus/mobile/MainActivity.java`** — the single
  changed file. Currently a bare `public class MainActivity extends
  BridgeActivity {}`. Add:
  - an `onCreate(Bundle)` override that, after `super.onCreate(...)`, obtains the
    AndroidX insets controller and **hides the system bars** with
    **transient-show-on-swipe** behavior;
  - an `onWindowFocusChanged(boolean hasFocus)` override that **re-applies** the
    hide + behavior when focus is regained (after a dialog/keyboard/recents
    returns focus), so the bars re-hide.
- Imports from AndroidX `androidx.core.view` (`WindowCompat`,
  `WindowInsetsControllerCompat`, `WindowInsetsCompat`) plus `android.os.Bundle` —
  all already on the classpath transitively via Capacitor. **No new npm package,
  no Gradle dependency edit.**

Out of scope:

- **iOS.** Issue #91 is Android-only and iOS immersive behavior is out of scope.
  (iOS does have a status bar and home indicator; that is simply not part of this
  fix.) No iOS file changes.
- **Any settings-slice change.** The behavior is **always-on, app-wide**. There is
  **no settings toggle, no persistence, no Firestore field** — bars are hidden
  everywhere with no user control.
- **`capacitor.config.ts`, `apps/mobile/src/app/app.ts`, `theme.scss`, or any TS/JS
  file.** The 0029 `StatusBar` init stays as-is; it is **not** modified by this
  spec. No `--vultus-*` token change.
- **Undoing or altering the 0029 edge-to-edge config.** It stays and is
  complementary.
- **Any new dependency / Gradle dependency change / `capacitor.config.ts` change.**
- **Any Firestore data-model, function, type, security-rule, or Sheriff-config
  change.**

## Affected slices & Sheriff tags

**No slice is built** (`slices: []`). The only changed file is a **native Android
source file**, `android/app/src/main/java/app/vultus/mobile/MainActivity.java`,
**not** a workspace TS/Nx project. **Sheriff/module boundaries do not apply to
it** — Sheriff governs imports between Nx/TS projects; a Java source compiled
directly by Gradle is outside that graph. `scopes: [scope:mobile]` is
**descriptive** (it is part of the mobile app's native shell) and drives no slice
Sheriff rule.

- **No cross-slice or cross-scope import is introduced.** The AndroidX
  `androidx.core.view.*` imports are platform/library classes already on the
  Android classpath (transitive via Capacitor), not workspace-project imports.
- **No lib is touched**, so no lib `README.md` update applies.
- **No DRY / 3+-slice question arises** — no shared TS logic is added; this is a
  one-file native window-behavior change in the app's `MainActivity`, the correct
  single home for it.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected). No persistence of any kind (no settings field).

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes. The only change is the native `MainActivity` window behavior.

**Chosen approach (decided): native `MainActivity`, no new dependency.** Use the
AndroidX `WindowInsetsControllerCompat` to hide the system bars and set
`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` — the exact behavior the issue requests
(a swipe from the edge reveals the bars transiently; they auto-hide after a few
seconds). The compat layer maps this to immersive-sticky behavior across the
supported API range. `onWindowFocusChanged` re-applies on focus regain (standard
immersive practice) so the bars re-hide after a dialog/keyboard/recents returns
focus.

**Concrete `MainActivity.java` the implementer should write** (this is the
checkable contract; package and class name unchanged):

```java
package app.vultus.mobile;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    hideSystemBars();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) {
      // Re-hide after a dialog / keyboard / recents has stolen and returned focus.
      hideSystemBars();
    }
  }

  private void hideSystemBars() {
    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.hide(WindowInsetsCompat.Type.systemBars());
    controller.setSystemBarsBehavior(
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
  }
}
```

Notes on the contract:

- `controller.hide(WindowInsetsCompat.Type.systemBars())` hides **both** the
  status bar and the navigation bar (rejected `@capacitor/status-bar` `.hide()`
  hides only the top bar — see Risks/rejected approaches below).
- `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` is the literal "appear on swipe,
  auto-hide after a few seconds" behavior from the issue.
- The 0029 `StatusBar` config is **untouched**; the dark style / light icons it
  sets still apply, so a transiently-revealed bar renders dark with light icons.
- `WindowCompat.setDecorFitsSystemViews(window, false)` is **intentionally NOT
  called here** — the decor-fits / edge-to-edge state is already driven by spec
  0029's `@capacitor/status-bar` `overlaysWebView: true` config, and re-setting it
  here could conflict. Use `WindowCompat` only for `getInsetsController`; do
  **not** add a `setDecorFitsSystemViews` call.

**Rejected approaches** (do not implement): (a) `@capacitor/status-bar` `.hide()`
alone — hides only the top bar, not the navigation bar, so it does not satisfy the
issue; (b) adding a community navigation-bar/immersive Capacitor npm plugin —
extra dependency and no maintained plugin delivers the transient-swipe auto-hide
cleanly (it would still need these native flags anyway).

## UI / Stitch screen refs

**No Stitch screen fetch required.** This spec introduces **no new screen,
component, or design token** — it changes a **native Android window behavior**
(hiding the system bars), not any in-app pixel. There is nothing to pull from
Stitch and no `--vultus-*` token added or transcribed.

When a bar **transiently reappears** on swipe, it should still render with the
existing **dark style / light icons** from the 0029 `StatusBar` config
(complementary and unchanged here). That styling is the contract of spec 0029, not
re-specified in this file; this spec only ensures it is not disturbed. There is no
new layout/inset work — 0029 already insets app chrome by the safe areas.

## Implementation task graph

A single **[sequential]** task. This is **infrastructure-engineer** territory:
native Android build setup is the infrastructure-engineer's domain per CLAUDE.md,
and the only file is the native `MainActivity`. There is no parallel fan-out and
thus **no file manifests** needed.

### 1. [sequential] Hide system bars with sticky-immersive behavior in MainActivity

Files: `android/app/src/main/java/app/vultus/mobile/MainActivity.java` (the only
changed file).

- Replace the bare `MainActivity` class body with the `onCreate` +
  `onWindowFocusChanged` + `hideSystemBars()` implementation and the AndroidX
  imports exactly as in **Public types / APIs** above.
- Do **not** modify `capacitor.config.ts`, `apps/mobile/src/app/app.ts`,
  `theme.scss`, or any TS/JS file. The 0029 `StatusBar` setup stays as-is.
- Do **not** add any npm package or edit Gradle dependency declarations
  (`androidx.core.view.*` is already on the classpath via Capacitor).
- **`npx cap sync android` is not strictly required** (no `capacitor.config.ts`
  change; the edited `MainActivity.java` is a committed native source compiled
  directly by Gradle). **If** the implementer runs `npx cap sync android`, confirm
  it does **not** clobber the hand-edited `MainActivity.java` — `cap sync` does not
  overwrite `MainActivity.java`; it only regenerates plugin/config glue.
- Gate: the Android Gradle compile of `MainActivity.java` is verified **during the
  native build step** — **flagged human / post-merge** (it cannot run in-session
  and `nx affected` will not touch Java). No automated TS surface changes —
  `nx affected` will likely show no affected TS project; a green `nx affected`
  does **not** prove the Java compiles (see Test plan).

## Test plan

Per the PLAN §5 pyramid, **honest**: there is **no automated test surface** for
this change. Immersive mode is a **device-only native window behavior** with no
TS/JS code, no slice logic, and no guard, so there is **no unit or component test
to add**.

- **Unit (Vitest):** **none** — no TS/JS logic is added or changed; the only file
  is native Java. There is nothing to spy on or assert.
- **Component tests:** **none** — no slice component is added or changed.
- **e2e tests:** **No new e2e flow required — native-only change, invisible to the
  web Playwright run.** Per the PLAN §5 e2e rubric, this introduces **no new
  navigation route and no new user action**; the web build is unchanged, and the
  native window behavior cannot be exercised by the web Playwright suite. Existing
  flows are untouched and nothing is un-skipped. Stated explicitly so the omission
  is intentional.
- **Automated gate (workspace):** `nx affected -t typecheck lint test build
  --base=main` will likely show **no affected TS project** (no workspace TS file
  changed); that is expected and acceptable here. **`nx affected` does not compile
  Java**, so a green `nx affected` does **not** prove `MainActivity.java`
  compiles — do not report the Java compile as done off it.
- **Android Gradle compile of `MainActivity.java`** is verified **during the
  native build step**, which **cannot run in-session** (no native build /
  device tooling here, per the project's emulator/device limitation). **Flagged
  human / post-merge**, same gate as the device verification below.
- **Human device verification (the real functional gate — cannot run in-session;
  needs a physical Android device + a native build, per the project's
  emulator/device tooling limitation). Flagged human / post-merge.** On a real
  Android device, after build + install:
  1. On **launch**, both the status bar (top) and the navigation bar (bottom) are
     **hidden** — on **every screen** of the app.
  2. A **swipe from the top edge** transiently reveals the **status bar**; a swipe
     from the **bottom edge** transiently reveals the **navigation bar**.
  3. A transiently-revealed bar **auto-hides after a few seconds**.
  4. Transiently-revealed bars render **dark with light icons** (0029 `StatusBar`
     dark style intact — bars + overlay coexist).
  5. The **soft keyboard / IME** still works; when a dialog/keyboard/recents
     steals and returns focus, the bars **re-hide** (the `onWindowFocusChanged`
     re-apply).
  6. The app's own **bottom tab bar (`IonTabBar`)** is **not broken** by the
     hidden navigation bar. Pass condition: the transiently-revealed navigation
     bar may overlap the app's bottom `IonTabBar` **only while it is revealed**;
     once the bar auto-hides, the tab bar must be **fully visible and
     tappable/unobscured** (see Risks).

## Definition of done

Tailored from the PLAN §5 checklist. There is no affected workspace TS project;
the affected artifact is the native Android app.

- [ ] `android/app/src/main/java/app/vultus/mobile/MainActivity.java` **hides both
      system bars** (`controller.hide(WindowInsetsCompat.Type.systemBars())`) with
      `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`, and **re-applies on focus regain**
      via `onWindowFocusChanged(true)`.
- [ ] **No new dependency**, **no Gradle dependency edit**, **no
      `capacitor.config.ts` change**, and the **0029 setup is untouched**
      (`capacitor.config.ts`, `apps/mobile/src/app/app.ts`, `theme.scss` not
      modified).
- [ ] **Android Gradle compile of `MainActivity.java` verified during the native
      build step** (flagged human / post-merge, same gate as device verification —
      it cannot run in-session and `nx affected` will not touch Java).
- [ ] **No new automated e2e flow** — explicitly recorded (native-only change; no
      new route/action; invisible to the web Playwright run).
- [ ] **Human device verification recorded** — both bars hidden on launch on every
      screen; transient reveal on edge swipe; auto-hide after a few seconds;
      revealed bars dark with light icons (0029 intact); keyboard works and bars
      re-hide on focus return; app tab bar not broken. **Flagged human /
      post-merge** (per the device-tooling limitation).
- [ ] **No Firestore data-model / index / rule change**; **no secret** read or
      written; **no settings toggle / persistence** added.

## Risks

1. **Coexistence of the 0029 overlay/`StatusBar` config with the new insets
   controller.** 0029 makes the web view draw under the bars (overlay +
   edge-to-edge); 0039 hides the bars. They **coexist**: the bars are hidden, and
   on a transient reveal the still-configured dark styled bar shows. Make this a
   device-check item (Test plan step 4) to confirm no conflict. To avoid a
   conflict, `WindowCompat.setDecorFitsSystemViews(window, false)` is
   **intentionally not called** here — the decor-fits / edge-to-edge state is
   already owned by 0029's `overlaysWebView: true`; `WindowCompat` is used only
   for `getInsetsController`.
2. **Keyboard/IME and dialogs steal focus → bars reappear.** This is expected
   Android behavior; the `onWindowFocusChanged` re-hide is the remedy and is part
   of the contract. Verified in Test plan step 5.
3. **Transient nav bar overlays the app's own bottom `IonTabBar` on reveal.** Pass
   condition: the revealed navigation bar may overlap the `IonTabBar` **only while
   it is revealed**; once the bar auto-hides, the tab bar must be **fully visible
   and tappable/unobscured**. Noted so the transient overlap is not mistaken for a
   regression. Verified in Test plan step 6.
4. **Older-API compatibility.** Handled by AndroidX `WindowInsetsControllerCompat`
   (the compat layer maps the behavior across the supported API range); verify on
   the project's `minSdk` during device check.
5. **`cap sync` must not clobber `MainActivity`.** `npx cap sync android` does
   **not** overwrite `MainActivity.java` (it only regenerates plugin/config glue),
   and the change requires no `capacitor.config.ts` edit, so `cap sync` is not
   strictly required. Noted so the implementer does not lose the hand-edit.
6. **No architecture / PLAN conflict.** This adds **no slice, no cross-slice or
   cross-scope import, no shared logic, and no data-model change.** It is a
   native window-behavior change in a single Android source file outside the
   Nx/TS/Sheriff graph; the correct single home for one-time native window setup.
