---
number: 0032
slug: fix-settings-load-reactive
title: Fix settings page not loading when uid resolves after ngOnInit
status: approved
slices: [slice:settings]
scopes: [scope:mobile]
created: 2026-06-26
---

# 0032 — Fix settings page not loading when uid resolves after ngOnInit

## 1. Context

GitHub issue #68: on a real device, opening the **Settings** tab shows
"Something went wrong — try again", and the **Try again** button does not recover
the page.

Root cause (confirmed from code in `libs/mobile/settings/src/lib/`):

`SettingsPage.ngOnInit()` calls `void this.service.load()` exactly **once**, on
component init. `SettingsService.load()` reads the `uid` signal once at the top
and branches:

```ts
async load(): Promise<void> {
  const uid = this.uid();
  if (uid === null) {
    return;            // Scenario B: silent early-return, page hangs on skeleton
  }
  this._loadFailed.set(false);
  try {
    /* getDoc(...) */
    this._loaded.set(true);
  } catch {
    this._loadFailed.set(true);   // Scenario A: "Something went wrong"
  }
}
```

There are two distinct failure shapes:

- **Scenario A — error state shown.** `uid` is non-null (auth succeeded) but the
  Firestore `getDoc(ref)` throws (network timeout / connectivity). `_loadFailed`
  is set → the page shows "Something went wrong — try again". `retryLoad()` →
  `load()` re-attempts; for a **transient** failure this recovers. For a
  **persistent** network failure it keeps failing — that is a connectivity issue,
  **out of scope** for this fix (see §10).
- **Scenario B — page hangs (the load race, this fix's target).** `uid` is
  `null` when `ngOnInit()` runs because anonymous sign-in is async and lags on
  first launch. `load()` returns early **silently**: `_loaded` stays `false`,
  `_loadFailed` stays `false`. The page renders the skeleton **forever**, even
  after auth resolves and `uid` becomes non-null — because nothing calls `load()`
  again. The "Try again" button is not even shown (the template gates the error
  state on `loadFailed`), so the user has no recovery path.

The one-shot `ngOnInit` call has no reactive coupling to the `uid` signal, so a
uid that arrives **after** init is never observed. The page-scoped
`SettingsService` already injects `AUTH_UID` as a **signal** (`this.uid`), so the
fix is to react to it.

**Intended outcome:** when anonymous auth resolves after the settings page has
mounted, the page automatically loads the user doc and renders — no permanent
skeleton, no manual interaction required. The fast path (uid already available at
init) is unchanged, and the existing transient-failure retry continues to work.

## 2. Scope

In scope:

- Add a reactive `effect()` in the `SettingsService` constructor that calls
  `load()` when `uid` transitions from `null` to non-null (and only when the page
  has neither loaded nor entered a failed/retrying state).
- Unit tests reproducing the uid-late race (effect fires `load()` on transition)
  and asserting no double-load when uid is available from the start.

Out of scope:

- `SettingsPage.ngOnInit()` — the one-shot `load()` call **stays** as the fast
  path for the uid-already-available case. No change to `settings.page.ts`.
- The retry flow / `retryLoad()` — already correct (clears `_loadFailed`,
  re-attempts; the template falls back to the skeleton while awaiting). Confirmed
  working; no change.
- The persistent-Firestore-failure scenario (retry keeps failing on a dead
  connection) — a network/connectivity concern, not the load race; no backoff or
  offline-cache work here (see §10).
- Any visual/markup change, region picker, notifications toggle, persistence
  writes, data model, Firestore security rules, or Sheriff config.

## 3. Affected slices & Sheriff tags

All changes are within **`scope:mobile`**, **`slice:settings`**.

| File                                                    | Tags                          | Change                                                                                        |
| ------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `libs/mobile/settings/src/lib/settings.service.ts`      | scope:mobile / slice:settings | add a reactive `effect()` in the constructor that calls `load()` when `uid` becomes available |
| `libs/mobile/settings/src/lib/settings.service.spec.ts` | scope:mobile / slice:settings | add tests for reactive load on uid transition + no double-load                                |

No cross-slice imports. `effect` is from `@angular/core` (the file already
imports `Injectable, inject, signal` from `@angular/core` — `effect` is added to
that same import). No shared code is introduced, so the "extract only at 3+
slices" rule does not apply. **No `sheriff.config.ts` change** — the existing path
glob already tags `libs/mobile/settings/src`. No public-API/barrel change, so no
README update is required.

## 4. Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security-rule
change. The read involved (`users/{uid}`, PLAN §4, via the existing
`@vultus/shared/firestore-schema` `userPath`/`dataToUser`/`userToData`
converters) is unchanged; the fix only changes **when** the existing `load()`
runs, not what it reads or writes.

## 5. Public types / APIs

**None.** No new or changed exported types, function signatures, endpoints, or
callable shapes. `SettingsService`'s public surface (`regions`, `region`,
`notificationsEnabled`, `loaded`, `loadFailed`, `load()`, `retryLoad()`,
`setRegion()`, `setNotificationsEnabled()`) is unchanged. The added `effect()` is
a private side-effect set up in the constructor; it exports nothing.

Implementation contract — add to the `SettingsService` constructor:

```ts
constructor() {
  // Reactively load once a uid resolves. ngOnInit's load() is the fast path
  // when uid is already available; this effect handles the slow path where
  // anonymous auth resolves AFTER the page has mounted (uid was null at init).
  // The guard prevents a redundant re-load (effect re-running after a
  // successful fast-path load) and avoids fighting a user-driven retry.
  effect(() => {
    const uid = this.uid();
    if (uid !== null && !this._loaded() && !this._loadFailed()) {
      void this.load();
    }
  });
}
```

Notes for the implementer:

- `SettingsService` is `@Injectable()` and **page-scoped** (provided via
  `SETTINGS_PROVIDERS` on `SettingsPage`, not `providedIn: 'root'`). The
  constructor therefore runs inside the component's injection context, so
  `effect()` is valid here and its lifetime is tied to the page — it is torn down
  with the component, no manual cleanup needed.
- The effect reads `this.uid()`, `this._loaded()`, and `this._loadFailed()` —
  all signals it already owns. Because `load()` sets `_loaded`/`_loadFailed`, the
  guard makes the effect idempotent: after a successful load the condition is
  `false`; while a load is in-flight the condition is still `true` (signals flip
  only on completion), but `load()` itself first reads `uid` and is safe to enter
  — keep the guard as written (a second concurrent `load()` from the same
  effect run will not occur because effects coalesce, and the fast-path
  `ngOnInit` load + the effect are reconciled by the guard once either sets
  `_loaded`/`_loadFailed`).
- Effects run **asynchronously** after change detection (Angular 17+), so there
  is a brief window between uid becoming non-null and the effect firing; this is
  acceptable — it only adds latency to the slow path, and the fast path is still
  handled synchronously by `ngOnInit`.

## 6. UI / Stitch screen refs

**Not applicable — no visual or markup change.** This is a state/timing fix in
the service. The settings page's existing skeleton / error / loaded markup
(specs 0011, 0018, 0024) is unchanged; the fix only makes the already-existing
loaded state actually appear when uid arrives late. No Stitch fetch required.

## 7. Implementation task graph

A single, tightly-scoped, in-slice change. **One sequential task** — no parallel
fan-out value, so no disjoint file manifests are needed.

### 1. [sequential] Add reactive load effect + tests

Owner: **frontend-engineer**. Files:

- `libs/mobile/settings/src/lib/settings.service.ts`
- `libs/mobile/settings/src/lib/settings.service.spec.ts`

- In `settings.service.ts`: add `effect` to the existing `@angular/core` import,
  and add the constructor `effect()` per §5. Do **not** modify `load()`,
  `retryLoad()`, or any other method.
- In `settings.service.spec.ts`: add the tests in §8. The effect runs in the
  injection context, so the existing `TestBed.inject(SettingsService)` setup
  already provides one; to drive the uid transition, the `AUTH_UID` provider must
  be a **writable** `signal<string | null>` the test can `.set(...)`, and the
  test must flush the effect (e.g. `TestBed.tickEffects()` / `flushEffects`, or
  `TestBed.inject(ApplicationRef).tick()`, plus draining microtasks for the async
  `load()`), matching the microtask-drain pattern already used by the existing
  `retryLoad` test.

## 8. Test plan

Per the PLAN §5 pyramid — this is a service-logic fix, so the surface is
unit-level (Vitest), extending the existing
`libs/mobile/settings/src/lib/settings.service.spec.ts` harness (which already
mocks `@angular/fire/firestore` and provides `AUTH_UID` as a signal).

- **Unit — uid available at construction (fast path, existing behavior holds):**
  with `uid = UID` from the start, `ngOnInit`-equivalent `load()` reads-creates /
  reads the doc once and sets `_loaded`. The existing `read-creates-doc-with-defaults`
  and `read-uses-existing` tests cover this; confirm they stay green and that the
  effect does **not** trigger a **second** `getDoc` (assert `getDocMock` call
  count is 1 after a manual `load()` + effect flush). This is the no-double-load
  guard.
- **Unit — uid transitions null → non-null (the regression, Scenario B):**
  construct the service with `AUTH_UID` = a writable `signal<string|null>(null)`.
  Call `load()` (mimicking `ngOnInit`) → assert it no-ops (`getDocMock` not
  called, `loaded()` false, `loadFailed()` false — the silent early return).
  Then `uidSignal.set(UID)` and flush effects + microtasks → assert `load()` ran
  automatically: `getDocMock` called once and `loaded()` is now `true`. This test
  **fails against the unfixed code** (no effect ⇒ load never re-runs) and passes
  with the fix.
- **Unit — effect does not load while in a failed/retry state:** with `uid` non-null
  and `getDoc` rejecting, after `load()` sets `loadFailed()` true, flushing the
  effect must **not** auto-call `load()` again (the `!_loadFailed()` guard) — the
  user-driven `retryLoad()` remains the only re-entry, preserving the existing
  retry semantics.
- **No regressions:** all existing `SettingsService` specs continue to pass
  (read-creates-doc, read-uses-existing, load-failure, retryLoad, setRegion,
  setNotifications true/false, null-uid guard, write-path targeting). In
  particular the `null-uid guard` test must still hold: with uid permanently
  null, the effect never fires `load()` (its `uid !== null` guard), so no
  Firestore access occurs.
- **Component:** none — no component state or markup change; `settings.page.ts` is
  untouched.

### e2e

**No new e2e flow required.** Per the §5 rubric this is a `scope:mobile` change,
but it introduces **no new route or user action** — it fixes the load timing of
the existing Settings page, already exercised by the spec-0011/0019 settings
flow. The regression (uid resolving after init) only manifests against real
async anonymous auth + a real Firestore stream, not the synchronous test doubles,
so it is gated by the unit tests above; there is no faithful Playwright (web)
reproduction of the device first-launch auth race. Recorded explicitly so the
reviewer does not flag a missing e2e. Manual device verification below covers the
device-only path.

- **Human device verification (post-merge, physical device, cold start):**
  1. Force-stop / clear the app so anonymous auth must re-run on launch.
  2. Open the app and navigate to **Settings** quickly (before/while auth
     resolves) → the page shows the skeleton, then **loads** (region +
     notifications render) without showing "Something went wrong" and without
     hanging on the skeleton.
  3. Confirm the region/notifications values are correct and persist on revisit.

## 9. Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist (only the `settings` lib is
affected):

- [ ] `settings.service.ts` constructor adds the reactive `effect()` per §5;
      `effect` imported from `@angular/core`; `load()`/`retryLoad()` unchanged.
- [ ] Unit tests cover: no double-load when uid is present at init; auto-load on
      uid null→non-null transition (the regression); no auto-load while in a
      failed state; and the existing null-uid guard still holds. All green.
- [ ] All existing `SettingsService` specs remain green.
- [ ] No cross-slice import; no `sheriff.config.ts` change; no Firestore /
      data-model / security-rule change; no public-API or barrel change (no
      README update needed, and none is made).
- [ ] Standard gates green for affected projects:
      `nx affected -t typecheck lint build test --base=main` (lint includes
      Sheriff).
- [ ] e2e: no new automated flow — explicitly recorded; the load-race path
      verified via the human device checklist post-merge.

## 10. Risks

- **Effect timing window.** Angular effects run asynchronously after change
  detection, so there is a short gap between `uid` becoming non-null and the
  effect firing `load()`. This only adds latency to the **slow path**; the fast
  path (uid already set at init) is handled synchronously by `ngOnInit`. The skeleton
  is the correct visual during that gap. Acceptable and intended.
- **Double-load guard correctness.** If `ngOnInit`'s `load()` succeeds before the
  effect first runs, the `!_loaded()` guard suppresses the effect's call — no
  redundant Firestore read. If `ngOnInit` returns early (uid null) and the effect
  later fires with a non-null uid, the guard passes and `load()` proceeds — the
  intended fix. The guard also reads `_loaded`/`_loadFailed`, so the effect
  re-evaluates whenever those flip; this is by design and bounded (a successful
  load sets `_loaded` true → guard closes permanently for that page instance).
- **Page-scoped injection context.** The `effect()` relies on `SettingsService`
  being constructed within the component's injection context (it is page-scoped
  via `SETTINGS_PROVIDERS`, not `providedIn: 'root'`). If a future change moves
  the service to root scope, the effect would need an explicit `Injector`/cleanup
  — call this out in the PR if the provider scope ever changes. No change here.
- **Out of scope: persistent Firestore failure.** This spec fixes the **load
  race** (uid late), not a dead connection. If `getDoc` keeps throwing on a
  genuinely offline device, the page still shows "Something went wrong" and retry
  keeps failing — that is a connectivity/offline-cache concern for a separate
  spec (no backoff, no offline persistence work here).
- **No architecture conflict.** No new slice, no cross-slice import, no shared
  code, no data-model change; the fix stays within the vertical slice and the
  existing Firestore data model (PLAN §3–§4).
