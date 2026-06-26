---
number: 0029
slug: android-edge-to-edge
title: Enable edge-to-edge / fullscreen rendering on Android via the StatusBar plugin
status: approved
slices: []
scopes: [scope:mobile]
created: 2026-06-26
---

# Enable edge-to-edge / fullscreen rendering on Android via the StatusBar plugin

## Context

GitHub issue #66: "The app is not full screen on mobile devices, the top bar
with time, provider, etc. and bottom controls of the device are always visible."

**Root cause (confirmed by code analysis).** `@capacitor/status-bar` is installed
(`package.json`) but **never configured or initialized**, so the web view renders
within the Android system chrome (status bar + navigation bar) instead of
edge-to-edge:

- `capacitor.config.ts` declares only the `SplashScreen` plugin — there is **no
  `StatusBar` plugin config** (confirmed: the `plugins` object has a single
  `SplashScreen` entry).
- `apps/mobile/src/app/app.ts` (the root `App` shell component) is a bare
  `IonApp`/`IonRouterOutlet` host with no lifecycle hook and **no StatusBar
  initialization** — there is no `StatusBar.setOverlaysWebView(...)` call anywhere
  in the codebase (grep confirms zero matches for `setOverlaysWebView`).
- `libs/shared/ui-kit/src/lib/theme.scss` sets the Ionic/`--vultus-*` token ramp
  but does **not** set `--ion-safe-area-top` / `--ion-safe-area-bottom` (grep:
  zero `safe-area` matches in `apps/mobile/src` and `libs/shared/ui-kit`).

**Intended outcome.** The app renders edge-to-edge on Android: the web view
extends under the status bar (and, on button-nav devices, under the navigation
bar), the status-bar background matches the app's dark surface so there is no
flash, and Ionic's `IonHeader`/`IonContent` inset their content by the system
safe areas so no app chrome is occluded by system UI. This is a
configuration + startup-initialization fix — **not** a design/layout change.

## Scope

In scope:

- **`capacitor.config.ts`** — add a `StatusBar` plugin config block enabling
  overlay mode with a dark style and the app's dark-navy surface background.
- **`apps/mobile/src/app/app.ts`** — initialize the StatusBar at app startup
  (overlay + dark style), **guarded by `Capacitor.isNativePlatform()`** so it is a
  no-op in web/serve/mock/e2e builds.
- **`apps/mobile/src/app/app.spec.ts`** — extend the existing shell test so the
  guarded init does not break `App` creation in the (web) test environment, and
  assert the guard makes it a no-op there.
- **`libs/shared/ui-kit/src/lib/theme.scss`** — verify `--ion-safe-area-top` /
  `--ion-safe-area-bottom` are wired; add them (mapped to `env(safe-area-inset-*)`)
  only if Ionic is not already setting them, so `IonHeader`/`IonContent` inset
  correctly under the now-overlaid system bars.
- **`npx cap sync android`** — run after the config change so the native Android
  project picks up the new `StatusBar` plugin config (a prerequisite for the
  native side; not a committed file change, but a required implementation step).

Out of scope:

- **Per-page / per-screen layout redesign.** No slice page (search, watchlist,
  title-detail, settings, onboarding) changes its template or styles. Ionic's
  existing `IonHeader`/`IonContent` safe-area handling does the insetting; if a
  specific page is found to need a bespoke inset, that is a follow-up spec, not
  this one.
- **iOS.** Android-only fix (issue #66 is Android). The same plugin config is
  iOS-compatible and harmless, but iOS verification is not claimed here.
- **Dynamic / per-route status-bar styling** (e.g. light style on a light hero).
  The app is dark-first; a single global dark style is set.
- **Light-mode theming**, splash-screen behavior, or any `--vultus-*` token
  change beyond the safe-area variables.
- **Any Firestore data-model, function, type, or Sheriff-config change.**

## Affected slices & Sheriff tags

**No slice is built** (`slices: []`). This touches the mobile **shell** and root
config only; `scopes: [scope:mobile]` is descriptive (the mobile app's
shell/config leg) and drives no slice Sheriff rule.

Files and their Sheriff posture:

- `apps/mobile/src/app/app.ts` / `app.spec.ts` — the mobile **shell**
  (`scope:mobile`). Importing `@capacitor/core` and `@capacitor/status-bar`
  (third-party packages) crosses **no** scope/slice boundary — Sheriff governs
  imports between **workspace projects**, and these are external deps already
  present in `package.json`. No cross-slice or cross-scope import is introduced.
- `libs/shared/ui-kit/src/lib/theme.scss` — `scope:shared`, importable by anyone;
  it is plain CSS custom properties (no TS import), so no boundary is crossed. Its
  public surface is unchanged (CSS vars only); the lib's barrel exports are
  untouched.
- `capacitor.config.ts` — repo-root Capacitor config; no Sheriff scope applies.

**No DRY / 3+-slice question** arises: no shared logic is added across slices. The
StatusBar init lives in the shell (the single app-entry point), which is the
correct home for one-time native-platform setup — not extracted to `shared/`.

## Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security rule is
touched (PLAN §4 unaffected).

## Public types / APIs

**No** new/changed domain types, function signatures, HTTP endpoints, or callable
shapes. The only changes are:

1. **`capacitor.config.ts` — new `StatusBar` plugin config** (sibling to the
   existing `SplashScreen` block; do not remove or alter `SplashScreen`):

   ```ts
   plugins: {
     SplashScreen: {
       /* existing — unchanged */
     },
     StatusBar: {
       style: 'DARK',
       backgroundColor: '#0b1326', // = --vultus-surface / --ion-background-color (dark navy)
       overlaysWebView: true,
     },
   },
   ```

   `overlaysWebView: true` is what enables edge-to-edge: the web view draws under
   the status bar. `backgroundColor` matches the app surface so there is no color
   flash where the status bar sits. `style: 'DARK'` is the Capacitor StatusBar
   config string meaning **dark UI background → light status-bar icons** (it maps
   to `Style.Dark`), correct for the dark-navy surface. The `#0b1326` literal is
   the one place this value must appear in native config; it equals
   `--vultus-surface` / `--ion-background-color` in
   `libs/shared/ui-kit/src/lib/theme.scss` (do not transcribe a different navy).

2. **`apps/mobile/src/app/app.ts` — guarded startup init.** Add `OnInit` (or use
   the constructor) to the existing `App` component and initialize the StatusBar
   only on a native platform so overlay mode is active from the first frame:

   ```ts
   import { Component, OnInit } from '@angular/core';
   import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
   import { Capacitor } from '@capacitor/core';
   import { StatusBar, Style } from '@capacitor/status-bar';

   @Component({
     imports: [IonApp, IonRouterOutlet],
     selector: 'app-root',
     templateUrl: './app.html',
     styleUrl: './app.scss',
   })
   export class App implements OnInit {
     protected title = 'mobile';

     async ngOnInit(): Promise<void> {
       if (!Capacitor.isNativePlatform()) {
         return;
       }
       await StatusBar.setOverlaysWebView({ overlay: true });
       await StatusBar.setStyle({ style: Style.Dark });
     }
   }
   ```

   The `Capacitor.isNativePlatform()` guard makes this a **no-op** in web/serve,
   `--configuration=mock`, and Playwright e2e runs (where the StatusBar native
   bridge is absent and the calls would otherwise reject). The two calls are
   intentionally redundant with the `capacitor.config.ts` defaults — the config is
   the native-side default, the runtime calls guarantee overlay/style even if the
   config is not honored on a given OS version, and they keep the behavior visible
   in app code.

3. **`libs/shared/ui-kit/src/lib/theme.scss` — safe-area variables (only if
   missing).** With `overlaysWebView: true`, web content sits under the status bar
   and Ionic insets `IonHeader`/`IonContent`/footer via
   `--ion-safe-area-top` / `--ion-safe-area-bottom`, which Ionic derives from the
   CSS `env(safe-area-inset-*)` values. If verification (Task 1) shows these are
   **not** resolving, add to `:root` in `theme.scss`:

   ```scss
   --ion-safe-area-top: env(safe-area-inset-top);
   --ion-safe-area-right: env(safe-area-inset-right);
   --ion-safe-area-bottom: env(safe-area-inset-bottom);
   --ion-safe-area-left: env(safe-area-inset-left);
   ```

   These reference the standard CSS env vars (no hand-coded pixel values), so they
   degrade to `0` where there is no inset and never hard-code a device-specific
   number.

## UI / Stitch screen refs

**No Stitch screen fetch required.** This spec introduces **no new screen,
component, or design token** — it makes the existing, already-designed pages
render edge-to-edge rather than letterboxed inside the system chrome. The only
token-adjacent change is wiring Ionic's `--ion-safe-area-*` vars and reusing the
existing `--vultus-surface` navy (`#0b1326`) for the native status-bar background;
both reference values already governed by
`docs/design/vultus-design-system.md` and `theme.scss` (no new palette value is
introduced, none is hand-transcribed). Visual correctness is verified on a real
device (Test plan), not against a Stitch screen.

## Implementation task graph

All tasks are **frontend-engineer** territory (mobile shell + ui-kit). The edits
are tightly coupled (the safe-area wiring is only correct once overlay mode is on)
and are verified together on a device, so they are **[sequential]**; there is no
parallel fan-out value and thus no parallel file manifests.

### 1. [sequential] StatusBar config + guarded shell init + safe-area verification

Files:
`capacitor.config.ts`,
`apps/mobile/src/app/app.ts`,
`apps/mobile/src/app/app.spec.ts`,
`libs/shared/ui-kit/src/lib/theme.scss` (conditional — see below),
`libs/shared/ui-kit/README.md` (only if `theme.scss` public CSS surface changes).

- Add the `StatusBar` plugin config to `capacitor.config.ts` exactly as in
  Public types §1 (keep `SplashScreen` untouched; reuse `#0b1326`).
- Add the guarded `ngOnInit` StatusBar init to `App` in
  `apps/mobile/src/app/app.ts` as in Public types §2 (import `Capacitor` from
  `@capacitor/core` and `StatusBar`, `Style` from `@capacitor/status-bar`; guard
  with `Capacitor.isNativePlatform()`).
- **Verify safe-area wiring before editing `theme.scss`.** Check whether Ionic
  already resolves `--ion-safe-area-top`/`-bottom` on-device with overlay on
  (the framework normally derives them from `env(safe-area-inset-*)`). Only if a
  device check shows app chrome overlapping the status/navigation bar, add the
  `--ion-safe-area-*` block from Public types §3 to `:root` in
  `libs/shared/ui-kit/src/lib/theme.scss`. If `theme.scss`'s documented CSS
  surface changes, update `libs/shared/ui-kit/README.md` in the same change
  (CLAUDE.md lib-README rule).
- Run `npx cap sync android` so the native Android project picks up the new
  `StatusBar` config (prerequisite for the config to take effect on-device; not a
  committed source change).
- Gates: `pnpm nx build mobile` compiles; `nx affected -t typecheck lint test build
--base=main` green for `mobile` and `shared-ui-kit`.

## Test plan

Per the PLAN §5 pyramid, pragmatic — the substantive behavior is **device-only
native StatusBar config** with no slice/business logic, so the automated surface
is limited to the shell guard and the build gate.

- **Unit (Vitest), the shell guard.** Extend the existing
  `apps/mobile/src/app/app.spec.ts` (which runs in the web/jsdom test env, where
  `Capacitor.isNativePlatform()` is `false`):
  - the `App` component **still creates** with the `IonApp`/`IonRouterOutlet`
    shell (the existing assertion must keep passing — `ngOnInit` must not throw in
    the web env);
  - the StatusBar native calls are **not** made when `isNativePlatform()` is false
    — spy on `StatusBar.setOverlaysWebView`/`setStyle` (or mock the
    `@capacitor/status-bar` module) and assert they are **not** called, proving the
    guard. The on-device native call paths are **not** unit-testable (device-only
    Capacitor APIs); their correctness is covered by the human device check.
- **Component tests:** none — no slice component with non-trivial state is added
  or changed; the only UI surface is the unchanged shell.
- **e2e tests:** **No new automated e2e flow.** Per the PLAN §5 e2e rubric this is
  a shell/config change that introduces **no new navigation route or user action**
  — existing flows (search, add-to-watchlist, etc., spec 0019) are untouched, and
  the `Capacitor.isNativePlatform()` guard makes the StatusBar init a **no-op** in
  the Playwright (web) run, so no flow changes and nothing is un-skipped.
  Edge-to-edge rendering is a **native-only visual property** that cannot be
  asserted by the web e2e suite. Stated explicitly so the omission is intentional.
- **Human device verification (the real functional gate — cannot run in-session;
  needs a physical Android device + a native build, per the emulator/device
  tooling limitation).** Record a before/after on a real Android device:
  1. Build + install the Android app (debug APK via the existing native build flow
     after `npx cap sync android`).
  2. **Before/after screenshot:** the app content **extends under the status bar**
     (time/provider icons sit over the app's dark surface, not over a separate OS
     band), and the status-bar icons are light (readable on the dark navy).
  3. The top `IonHeader`/toolbar content is **not occluded** by the status bar
     (safe-area top inset applied); on a button-navigation device the bottom
     content is **not occluded** by the navigation bar (safe-area bottom inset
     applied); on a gesture-navigation device there is no visible button bar.
  4. No color **flash** in the status-bar region during launch/navigation (the
     `#0b1326` background matches the app surface).
  5. The web `pnpm nx serve mobile` / mock / e2e runs are visually unchanged (the
     guard no-ops off-device).

## Definition of done

Tailored from the PLAN §5 checklist. `mobile` and `shared-ui-kit` are the affected
projects.

- [ ] `capacitor.config.ts` declares the `StatusBar` plugin config
      (`style: 'DARK'`, `backgroundColor: '#0b1326'`, `overlaysWebView: true`),
      with the existing `SplashScreen` block unchanged.
- [ ] `apps/mobile/src/app/app.ts` initializes the StatusBar
      (`setOverlaysWebView({ overlay: true })` + `setStyle({ style: Style.Dark })`)
      at startup, **guarded by `Capacitor.isNativePlatform()`** so it no-ops in
      web/serve/mock/e2e.
- [ ] `--ion-safe-area-top`/`-bottom` are confirmed resolving on-device (Ionic
      default or the `theme.scss` addition); app chrome is not occluded by system
      bars.
- [ ] `npx cap sync android` has been run so the native project carries the new
      StatusBar config (recorded in the PR).
- [ ] **Unit test green:** the shell still creates and the StatusBar native calls
      are **not** invoked when `isNativePlatform()` is false (guard proven).
- [ ] **No new automated e2e flow** — explicitly recorded (shell/config change; no
      new route/action; native-only visual property; guard no-ops in the web run).
- [ ] **Human device verification recorded** — before/after Android screenshot
      showing the app extends under the system bars with no occlusion or flash
      (flagged human/post-merge, per the device-tooling limitation).
- [ ] If `theme.scss` changed, `libs/shared/ui-kit/README.md` is updated in the
      same change.
- [ ] Standard gates green: `nx affected -t typecheck lint build --base=main`
      (incl. Sheriff) for `mobile` + `shared-ui-kit`; `pnpm nx build mobile`
      compiles.
- [ ] No Firestore data-model / index / rule change; no secret read or written; no
      new dependency added (`@capacitor/status-bar` is already in `package.json`).

## Risks

- **Safe-area insets are the common pitfall.** With `overlaysWebView: true`, the
  status bar area is no longer "owned" by the OS — the web view fills the screen
  and Ionic must inset `IonHeader`/`IonContent` via `env(safe-area-inset-top)`.
  If `--ion-safe-area-top` does not resolve to the correct value on the device,
  the header/toolbar will **overlap** the system clock/icons. This is the most
  likely failure mode; the device check (Test plan step 3) is the gate for it, and
  the `theme.scss` safe-area block is the remedy if Ionic's default does not apply.
  `env(safe-area-inset-*)` only yields non-zero values on Android **once overlay
  mode is on**, so the wiring and the overlay change must land together.
- **`cap sync` is required.** `@capacitor/status-bar` config is consumed by the
  native Android project; the new `capacitor.config.ts` block does nothing on-device
  until `npx cap sync android` regenerates the native config. Omitting it makes the
  fix look ineffective. It is an explicit task step + DoD item.
- **Guard against native-API rejection off-device.** `StatusBar.setOverlaysWebView`
  / `setStyle` reject when the native bridge is absent (web/serve/mock/e2e); the
  `Capacitor.isNativePlatform()` guard is mandatory so the shell does not throw at
  startup in those environments (and so the unit test and Playwright suite stay
  green). The unit test asserts the no-op explicitly.
- **Bottom navigation bar (button-nav devices).** On Android 10+ with gesture
  navigation there is no visible button bar; with button navigation the navigation
  bar overlays the web view once overlay mode is on, and Ionic insets the bottom
  via `--ion-safe-area-bottom` (the same mechanism as the top — no extra code).
  Verified on a button-nav device in Test plan step 3.
- **`style: 'DARK'` semantics.** Capacitor's `Style.Dark` means _dark background →
  light icons_. Pairing it with the dark-navy surface is correct; a future
  light-mode would need a dynamic style (explicitly out of scope here).
- **No architecture / PLAN conflict.** This adds no slice, no cross-slice or
  cross-scope import, no shared logic across slices, and no data-model change. The
  StatusBar init lives in the shell (the correct single home for one-time native
  setup); the `#0b1326` background reuses the existing `--vultus-surface` token
  rather than introducing or hand-copying a hex.
