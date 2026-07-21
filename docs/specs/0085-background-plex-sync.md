---
number: 0085
slug: background-plex-sync
title: Background Plex sync (periodic on-device sync while backgrounded)
status: done
slices: [slice:settings]
scopes: [scope:mobile, scope:shared]
created: 2026-07-20
---

# Background Plex sync (periodic on-device sync while backgrounded)

## Context

GitHub #231: spec 0073 ("One-way Plex → Vultus sync", status **done**) added an
on-device, LAN, `scope:mobile` Plex sync engine — `PlexSyncService.sync()` reads
the user's self-hosted Plex Media Server (PMS) over the local network
(`CapacitorHttp` → `http://<ip>:32400`), imports library additions (cursor-based),
and mirrors watched state into the watchlist/episode docs. 0073 wires that engine
to fire at exactly **three** moments (locked decision 4): app boot, foreground
resume (`appStateChange → isActive`), and the manual "Sync now" button.

There is **no periodic sync while the app is backgrounded or closed**. Because the
PMS lives on the user's LAN and is reachable **only from the device** (the daily
Cloud Function cannot see it — it has no route to the home network, and the
X-Plex-Token is per-device in Preferences, never in Firestore per 0073 decision
2), the only place a periodic sync can run is **on the phone while it is on the
home Wi-Fi**. This spec adds that missing periodic trigger.

This spec is **purely additive on top of 0073** — it **reuses 0073's sync
machinery entirely** and must not re-litigate any of 0073's decisions. It adds a
community background-fetch plugin whose OS-scheduled callback invokes the
**existing** `PlexSyncService.sync()`; 0073's concurrent-sync guard, cursor-based
additions, watched-mirror, sticky-`dropped` invariant, and all Firestore writes
are unchanged and un-reimplemented. It touches only `slice:settings`
(`libs/mobile/settings`), the app shell (`apps/mobile`), and one additive
`scope:shared` DI token.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Approach: the community plugin `@transistorsoft/capacitor-background-fetch`.**
   The OS wakes the app's JS periodically (Android WorkManager, ~15-minute floor)
   and the plugin's `onFetch(taskId)` callback invokes the **existing**
   `PlexSyncService.sync()` — reusing all of 0073's engine. **No sync logic is
   reimplemented.** _Rejected alternatives:_ `@capacitor/background-runner` runs
   JS in an **isolated runtime with no DOM / Angular / Firestore SDK /
   CapacitorHttp**, which would force a full reimplementation of the sync engine
   and break the "reuse 0073's machinery" mandate; a **custom Kotlin WorkManager
   bridge** is far more native code, waking the WebView from a Worker is
   non-trivial, and it is much harder to unit-test. The community plugin lets us
   run the real Angular service in the app's JS context.
2. **Reliability envelope — honest, not over-promised.** The **reliable**
   guarantee is: periodic sync while the app process is **alive/backgrounded**,
   and when Android **relaunches the app in the background** for a scheduled task.
   Configure `stopOnTerminate: false`, `startOnBoot: true`, `enableHeadless: true`.
   The **fully-terminated / swiped-away headless path is best-effort only** — a
   headless JS task must be registered in `main.ts` **before** Angular bootstrap
   and runs in a minimal context where the Angular `PlexSyncService` may not be
   available, so it is a **safe, task-finishing stub**. Meaningful
   terminated-state sync is flagged **on-device-verify-only** and a possible
   future enhancement. **Do NOT claim guaranteed sync while fully terminated.**
3. **Cadence is a USER SETTING, 1-hour default.** Interval options (all ≥
   Android's 15-min WorkManager floor): **15 min, 30 min, 1 hour (default), 3
   hours, 6 hours.** The chosen interval maps to the plugin's
   `minimumFetchInterval` (minutes). Sub-15 values are not offered (the OS clamps
   them anyway).
4. **Constraints: Wi-Fi (unmetered) only + battery-not-low; NO charging
   requirement.** Wi-Fi is a natural proxy for "on the home LAN where the PMS is
   reachable"; battery-not-low limits drain. Map to `requiredNetworkType:
BackgroundFetch.NETWORK_TYPE_UNMETERED` and `requiresBatteryNotLow: true`; do
   **NOT** set `requiresCharging`. If Wi-Fi/PMS is unreachable when a fetch fires,
   the sync fails **quietly**, reusing 0073's existing timeout + `no-server` /
   `error` handling — **no new error UI**.
5. **User control: a "Sync in background" toggle (default ON) + an interval
   selector**, both in the **CONNECTED-state** Plex Server card in Settings.
   Persisted **device-locally** in `@capacitor/preferences` (background execution
   is inherently per-device — same rationale 0073 used for the per-device
   X-Plex-Token). Keys: `plex_bg_enabled` (boolean, default `true`) and
   `plex_bg_interval_min` (number, default `60`). **NO Firestore / `PlexSyncMeta`
   change** for this config — it is device-local. The interval selector is only
   enabled when the toggle is ON.
6. **Platform: Android-only. iOS explicitly OUT of scope** (iOS BGTaskScheduler is
   opaque/unpredictable — a separate future spec). On iOS/web the background init
   is a **native-guarded no-op**, exactly like 0073's `PLEX_SYNC_TRIGGER` and
   `initStatusBar`.
7. **Wiring mirrors 0073's `PLEX_SYNC_TRIGGER` pattern EXACTLY.** A new
   `scope:shared` DI token `PLEX_BACKGROUND_INIT: InjectionToken<() =>
Promise<void>>` is added to `libs/shared/domain/src/lib/tokens.ts` alongside
   `PLEX_SYNC_TRIGGER`. The shell (`app.config.ts`) provides it as a thunk over
   `inject(PlexBackgroundService).init()`, native-guarded to a no-op off-native
   (mirroring the existing `PLEX_SYNC_TRIGGER` factory at `app.config.ts:165-174`
   and `PLEX_CLIENT` factory at `:150-156`). `app.ts` injects the token and calls
   it once in `ngOnInit` (fire-and-forget, `void`), right after the existing
   `void this.plexSyncTrigger();` boot call at `app.ts:34`. The `onFetch` callback
   inside the service calls the **same** `PlexSyncService.sync()`; the
   concurrent-sync guard makes a background fetch overlapping a boot/resume sync a
   safe no-op.

## Scope

In scope:

- **A `PlexBackgroundService`** in the settings slice
  (`libs/mobile/settings/src/lib/plex-background.service.ts`),
  `@Injectable({ providedIn: 'root' })`, owning: the persisted background config
  (enabled + interval, in Preferences), `init()` (configure the plugin +
  register `onFetch`/`onTimeout`), `setEnabled()`, `setIntervalMinutes()`, and
  `stop()`. The `onFetch` callback invokes the existing `PlexSyncService.sync()`.
- **A new `scope:shared` DI token `PLEX_BACKGROUND_INIT`** in
  `libs/shared/domain/src/lib/tokens.ts` (additive vocabulary; mirrors
  `PLEX_SYNC_TRIGGER`).
- **App-shell wiring** (`apps/mobile`): `app.config.ts` provides
  `PLEX_BACKGROUND_INIT` (native-guarded thunk over
  `PlexBackgroundService.init()`); `app.ts` calls it once on boot; `main.ts`
  registers the best-effort headless task before `bootstrapApplication`.
- **The new dependency** `@transistorsoft/capacitor-background-fetch`
  (`package.json` + `pnpm-lock.yaml` written with **pnpm 9**; `pnpm-workspace.yaml`
  `allowBuilds` entry if the plugin needs a build script), plus the
  `pnpm exec cap sync android` note.
- **Settings connected-block UI**: a "Sync in background" toggle + an interval
  `ion-select`, inserted into the existing CONNECTED block of the Plex Server card
  (`settings.page.html`), mirroring the sibling Notifications toggle + delivery-hour
  select patterns.
- **Lifecycle integration**: `PlexLinkService.unlink()` (0073) also calls
  `PlexBackgroundService.stop()`; on successful **link**, background sync is
  configured (default ON) so a freshly-linked device starts its periodic task
  without waiting for the next boot.
- Mock providers mirrored where needed; unit + component + app-shell tests;
  READMEs (`shared/domain`, `mobile/settings`).

Out of scope (explicitly):

- **iOS background sync** (BGTaskScheduler is opaque; separate future spec). On
  iOS/web the init is a native-guarded no-op.
- **Guaranteed sync while fully terminated / swiped away** — the headless path is
  best-effort only (locked decision 2); meaningful terminated-state sync is a
  possible future enhancement.
- **Any change to 0073's sync engine, cursor, watched-mirror, or its Firestore
  writes** — this spec only adds a new _trigger_; it does not touch
  `plex-sync.service.ts`'s sync algorithm.
- **Any Firestore / `PlexSyncMeta` / domain-document change** — the config is
  device-local Preferences (see §4).
- **Any `scope:functions` change**, notifications, or new error UI (a failed
  background fetch fails quietly reusing 0073's handling).
- **A dedicated Stitch screen** — there is none for these two controls; they
  reuse the established sibling settings control patterns (see §6).

## Affected slices & Sheriff tags

| Project                | Path                   | Sheriff tags                     | Change                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared-domain (edit)   | `libs/shared/domain`   | `scope:shared`                   | **add** the `PLEX_BACKGROUND_INIT` DI token to the `tokens` entrypoint (`tokens.ts`); export it; README. **No document/type change.**                                                                                                                     |
| mobile-settings (edit) | `libs/mobile/settings` | `scope:mobile`, `slice:settings` | **add** `PlexBackgroundService` (`providedIn: 'root'`) + spec; the connected-block toggle + interval UI in `settings.page.{html,scss,ts}` + specs; `PlexLinkService.unlink()` calls `stop()`; connect "Done" configures background; barrel export; README |
| mobile (edit)          | `apps/mobile`          | `scope:mobile`                   | `app.config.ts` provides `PLEX_BACKGROUND_INIT`; `app.ts` boot call; `main.ts` headless registration; `app.spec.ts` assertion; add the `@transistorsoft/capacitor-background-fetch` dep (package.json + lockfile + `pnpm-workspace.yaml` allowBuilds)     |
| mobile-e2e (edit)      | `apps/mobile-e2e`      | untagged                         | (optional/light) extend `plex-sync.spec.ts` to assert the new controls render in the connected state (mock). No background-firing e2e (native-only).                                                                                                      |

- **No `sheriff.config.ts` change.** Every touched path already carries its tags
  (specs 0010/0012/0051): `libs/mobile/settings/src` = `scope:mobile` +
  `slice:settings`; `apps/mobile` = `scope:mobile`; `libs/shared/domain/src` =
  `scope:shared`.
- **No cross-slice import.** `PlexBackgroundService` lives in `slice:settings`
  alongside `PlexSyncService` and `PlexLinkService` (0073) — it depends on both as
  **same-slice** services, and on the plugin + `@capacitor/preferences` directly
  (allowed in `scope:mobile`). The shell obtains the service only through the
  additive `scope:shared` `PLEX_BACKGROUND_INIT` token — never importing the slice
  the wrong way, exactly as `PLEX_SYNC_TRIGGER` (0073).
- **No `scope:functions` edge.** No callable, HTTP function, or functions source
  is touched. The new plugin is a **mobile-only** dependency — the functions
  bundle must not pick it up (`functions:deploy-preflight` unaffected; verify in
  the infra task).
- **`shared/` addition is additive vocabulary only** (one DI token) — the
  shell-token pattern (like `AUTH_UID` / `PLEX_SYNC_TRIGGER`), not a logic
  extraction. All background-fetch logic lives in the settings slice.

## Data model touchpoints

**NO new Firestore surface. NO domain-document change.** The background config is
**device-local**, persisted in `@capacitor/preferences` (not Firestore), because
background execution is inherently per-device — the same rationale 0073 used for
storing the per-device X-Plex-Token in Preferences rather than in Firestore.

Preferences keys (device-local, NOT Firestore):

| Key                    | Type      | Default | Meaning                                        |
| ---------------------- | --------- | ------- | ---------------------------------------------- |
| `plex_bg_enabled`      | `boolean` | `true`  | Whether periodic background sync is scheduled. |
| `plex_bg_interval_min` | `number`  | `60`    | The `minimumFetchInterval`, in minutes (≥ 15). |

- **`firestore.rules`: NO change** — this spec writes nothing to Firestore. (The
  `onFetch` callback invokes 0073's `PlexSyncService.sync()`, whose watchlist/
  episode writes are already covered by the existing `users/{userId}` recursive
  owner rule; 0073 verified this and it is unchanged here.) **State explicitly in
  the PR: no `firestore.rules` change, and no rules-test change.**
- **`firestore.indexes.json`: NO change** — no new query is introduced. **State
  explicitly in the PR.**
- **No `PlexSyncMeta` / `User` change** — the 0073 domain document is untouched;
  there is therefore **no shared/domain required-field change and no F2
  full-`User`-write-literal ripple** (see §10). The only `shared/domain` edit is
  the additive `PLEX_BACKGROUND_INIT` **token** (no field on any converted type).

## Public types / APIs

### Shared domain (additive — one DI token)

`libs/shared/domain/src/lib/tokens.ts` — add alongside `PLEX_SYNC_TRIGGER`
(copy that token's doc-comment style):

```ts
/** A thunk the shell calls once on boot to initialize periodic on-device
 *  background Plex sync (Android WorkManager via
 *  @transistorsoft/capacitor-background-fetch). No-op when not native / not
 *  linked. scope:shared so the shell wires it over the settings slice's
 *  PlexBackgroundService without importing the slice the wrong way — mirrors
 *  PLEX_SYNC_TRIGGER (spec 0073 / 0085). */
export const PLEX_BACKGROUND_INIT = new InjectionToken<() => Promise<void>>(
  'PLEX_BACKGROUND_INIT',
);
```

Export it from the domain `tokens` entrypoint barrel. **No `documents.ts` /
`entities.ts` / `plex.ts` change; no converter change; no `type-assertions.ts`
change** (no field is added to any converted type).

### Settings slice surface (`libs/mobile/settings`)

New file `libs/mobile/settings/src/lib/plex-background.service.ts` —
`PlexBackgroundService`, `@Injectable({ providedIn: 'root' })`. **`providedIn:
'root'` is REQUIRED**: the shell's root `PLEX_BACKGROUND_INIT` factory
`inject(PlexBackgroundService)` resolves from the **root injector**, exactly as
`PlexSyncService` is root-provided per 0073. **Do NOT list it in
`SETTINGS_PROVIDERS`** — a page-scoped provide would fork the singleton and the
Settings page would drive a different instance from the boot trigger (the same
trap 0073 documented for `PlexSyncService`/`PlexLinkService`).

Public surface (pin):

```ts
/** Persisted device-local config (Preferences), signals mirror it for the UI. */
readonly enabled: Signal<boolean>;          // default true
readonly intervalMinutes: Signal<number>;   // default 60

/** Boot init: native-guard; if not native return. Load config from Preferences.
 *  Configure the plugin (minimumFetchInterval = intervalMinutes; UNMETERED;
 *  battery-not-low; stopOnTerminate:false; startOnBoot:true; enableHeadless:true)
 *  and register onFetch/onTimeout. If disabled, BackgroundFetch.stop() so no task
 *  schedules. Called once on boot via PLEX_BACKGROUND_INIT, and on link. */
init(): Promise<void>;

/** Persist plex_bg_enabled unconditionally; then, ONLY when native, reconfigure:
 *  enabled → configure/start; disabled → BackgroundFetch.stop(). Off-native the
 *  plugin call is skipped (the Preferences write still happens). */
setEnabled(enabled: boolean): Promise<void>;

/** Persist plex_bg_interval_min unconditionally; then, ONLY when native,
 *  reconfigure with the new minimumFetchInterval. */
setIntervalMinutes(min: number): Promise<void>;

/** Clear the bg Preferences keys unconditionally; then, ONLY when native, call
 *  BackgroundFetch.stop(). Called from unlink. */
stop(): Promise<void>;
```

Dependencies (all `scope:mobile`-allowed): `PlexSyncService` (root singleton,
0073), `Preferences` (`@capacitor/preferences`), and
`@transistorsoft/capacitor-background-fetch` (imported directly — allowed in
`scope:mobile`).

**`PlexBackgroundService` must NOT inject `PlexLinkService`.** Doing so would
create a **circular DI** (`NG0200: Circular dependency in DI`):
`PlexLinkService.unlink()` calls `PlexBackgroundService.stop()` (see the lifecycle
integration below), and both are `providedIn: 'root'`, so a mutual `inject()`
would cycle when `SettingsPage` resolves both. To determine "linked on this
device" inside `onFetch` **without injecting `PlexLinkService`**, the service
reads the on-device token Preferences key **directly** — it already imports
`Preferences`, and the key is `PLEX_TOKEN_KEY = 'plex_token'` (exported from
`plex-link.service.ts:17`; import the exported constant, don't re-declare the
string). "Linked on this device" ⇔ a non-empty `plex_token` value in Preferences.
This token-key read is used **precisely to keep the dependency one-directional**
(`PlexLinkService → PlexBackgroundService` only), avoiding the cycle. **Reading
the token's _presence_ is fine; the token VALUE is never logged, echoed, or
otherwise exposed** (CLAUDE.md secrets — the `onFetch` check only tests
non-emptiness).

**`init()` behavior (pin):**

- Native-guard first: `if (!Capacitor.isNativePlatform()) return;`. **Because the
  guard precedes the Preferences load, on web/e2e/serve-mock the `enabled()` /
  `intervalMinutes()` signals stay at their defaults (`true` / `60`)** — the
  serve-mock screenshot therefore shows the DEFAULT control values, not any
  persisted state.
- Load config from Preferences (defaults: enabled `true`, interval `60`).
- Interval options offered: `[15, 30, 60, 180, 360]` minutes (`60` default). Any
  loaded/set value below `15` is clamped to `15` (the WorkManager floor).
- Call `BackgroundFetch.configure({ minimumFetchInterval: <intervalMinutes>,
requiredNetworkType: BackgroundFetch.NETWORK_TYPE_UNMETERED,
requiresBatteryNotLow: true, requiresCharging: false, stopOnTerminate: false,
startOnBoot: true, enableHeadless: true }, onFetch, onTimeout)`.
- `onFetch(taskId)`: **if `enabled()` AND the `plex_token` Preferences value is
  non-empty** (the linked-on-this-device check, read directly — NOT via
  `PlexLinkService`), `await this.plexSync.sync()` wrapped in try/catch (swallow
  errors — fail quietly, reusing 0073's `no-server`/`error`/timeout handling; NO
  new error UI). **ALWAYS** `BackgroundFetch.finish(taskId)` in a `finally` (an
  unfinished task is penalized by the OS).
- `onTimeout(taskId)`: `BackgroundFetch.finish(taskId)`.
- If `!enabled()`: `await BackgroundFetch.stop()` (or configure then stop) so no
  task is scheduled.

**Web-guard invariant (pin):** `setEnabled()` / `setIntervalMinutes()` / `stop()`
**always** persist/clear their Preferences keys, but **only touch
`BackgroundFetch.*` when `Capacitor.isNativePlatform()`**. So a toggle/select tick
on serve-mock updates the signal + Preferences but cannot throw against the
plugin's web stub. (The Preferences-key clearing in `stop()` is intentionally
**always-run**, outside the native guard; only the `BackgroundFetch.stop()` plugin
call is guarded.)

**Barrel** (`libs/mobile/settings/src/index.ts`): export `PlexBackgroundService`
(the shell factory `inject`s it, and the type must be importable from the
`@vultus/mobile/settings` barrel like `PlexSyncService` is today).

### Lifecycle integrations (settings slice)

- **`PlexLinkService.unlink()`** (0073, `plex-link.service.ts:202`) gains a call to
  `PlexBackgroundService.stop()` so disconnecting stops the scheduled background
  task and clears the bg Preferences keys. This is a **one-directional** dependency
  (`PlexLinkService` → `PlexBackgroundService`); `PlexBackgroundService` does NOT
  inject `PlexLinkService` back (see §5's circular-DI note — that is exactly why
  `onFetch` reads the `plex_token` key directly). `stop()` clears its Preferences
  keys **unconditionally** and native-guards only the `BackgroundFetch.stop()`
  plugin call, so unlink on web/serve-mock still clears the bg config and stays a
  safe no-op against the plugin.
- **On successful LINK**: the connect page's `done()` handler
  (`plex-connect.page.ts:161-165`) already kicks an initial `PlexSyncService.sync()`;
  add a `PlexBackgroundService.init()` call there (fire-and-forget `void`) so a
  freshly-linked device schedules its periodic task immediately (default ON)
  without waiting for the next app boot. (`init()` reads the default enabled=true,
  interval=60 config from empty Preferences on first link.)

### App shell (`apps/mobile`)

- **`app.config.ts`**: provide `PLEX_BACKGROUND_INIT` with a factory mirroring the
  existing `PLEX_SYNC_TRIGGER` factory (`:165-174`) — inject
  `PlexBackgroundService` from the root injector and return a thunk that is a
  native-guarded no-op off-native:

  ```ts
  {
    provide: PLEX_BACKGROUND_INIT,
    useFactory: () => {
      const svc = inject(PlexBackgroundService);
      return () =>
        Capacitor.isNativePlatform() ? svc.init() : Promise.resolve();
    },
  },
  ```

  Import `PlexBackgroundService` from `@vultus/mobile/settings` (add to the
  existing settings import at `app.config.ts:35-39`) and `PLEX_BACKGROUND_INIT`
  from `@vultus/shared/domain/tokens` (add to `:25-31`).

- **`app.ts`** (`App`): inject `PLEX_BACKGROUND_INIT` (mirror the
  `plexSyncTrigger` field at `:23`) and call it once in `ngOnInit`, fire-and-forget,
  **right after** the existing `void this.plexSyncTrigger();` boot call at `:34`:

  ```ts
  // Initialize periodic on-device background Plex sync (Android only; a
  // native-guarded no-op on web). Registers the WorkManager task that reruns
  // PlexSyncService.sync() on the user's chosen interval (spec 0085).
  void this.plexBackgroundInit();
  ```

  No resume-listener registration is needed for background init (unlike 0073's
  `registerPlexResumeSync`) — the plugin schedules the OS task itself; a single
  boot `init()` (plus the on-link `init()`) is sufficient.

- **`main.ts`**: register a best-effort headless task **before**
  `bootstrapApplication(App, appConfig)`:

  ```ts
  // Best-effort terminated-state task (spec 0085, locked decision 2). Runs in a
  // minimal JS context where Angular's PlexSyncService may be unavailable, so it
  // only finishes the task safely — meaningful terminated-state sync is
  // on-device-verify-only and a possible future enhancement. Native-guarded.
  if (Capacitor.isNativePlatform()) {
    BackgroundFetch.registerHeadlessTask(async ({ taskId }) => {
      BackgroundFetch.finish(taskId);
    });
  }
  ```

  (Import `Capacitor` from `@capacitor/core` and `BackgroundFetch` from the
  plugin. Keep the guard so web/e2e bootstrap is unaffected.)

  > **Web-bundle import safety (pin).** `main.ts` is ALSO the web/e2e entry, so
  > this top-level `import { BackgroundFetch } from
'@transistorsoft/capacitor-background-fetch'` is **bundled and evaluated in
  > web builds** even though `registerHeadlessTask` is native-guarded at runtime.
  > The plugin's web entry MUST be a **safe no-op at import time** (no top-level
  > throw / native-only side effect). Verify after adding the dep that
  > `mobile:serve-mock` and the e2e web bootstrap **still start** (bundle loads,
  > app renders) — see the DoD gate. If the web entry is not import-safe, isolate
  > the import behind a native dynamic `import()` inside the guard rather than at
  > module top level.

- **`capacitor.config.ts`** (repo root): **NO plugin block needed** — the
  transistorsoft plugin is configured at **runtime** via `BackgroundFetch.configure`.
  `pnpm exec cap sync android` registers the plugin natively; the plugin ships
  its own AndroidManifest permissions, so **no manual manifest edit is expected**.

## UI / Stitch screen refs

**There is NO dedicated Stitch screen for these two new controls.** This section
is **spec-authored, consistent with the sibling settings controls already on the
same page** — flag it as such in the PR, and it is NOT a green-build-only
sign-off (CLAUDE.md UI-fidelity rule): require visual verification on
`mobile:serve-mock` (the mock seeds a linked state per 0073) — screenshot the
connected Plex card showing the toggle + interval selector.

> **Before relying on "spec-authored, no screen":** the implementer MUST
> **re-fetch the canonical settings Stitch screen `0e2bb1f198f04186b39e4a2604413417`**
> (the settings screen cited by 0073, per the CLAUDE.md recipe: `get_screen` →
> `htmlCode.downloadUrl` → raw GET) and confirm it does **NOT** already depict
> background-sync controls. If the screen turns out to include such controls,
> match them (they become the contract) instead of the spec-authored patterns
> below. Only if the screen has no background-sync affordance does the
> "spec-authored, consistent with sibling controls" justification apply.

**Authoritative tokens** live in `docs/design/vultus-design-system.md`, consumed
via the wired `--vultus-*` / `--ion-*` vars in `theme.scss`. **Never
hand-transcribe a hex.** Both new controls reuse **existing, fully-tokenized
markup patterns on the same page** — no new colours, no brand hex.

**Placement**: inside the CONNECTED block (`@else` at `settings.page.html:229-267`),
**between** the existing `plex-connected__sync-row` (ends `:257`) and the
`plex-connected__footer` (starts `:258`). Read that block to match the surrounding
markup + `--vultus-*` tokens (it is fully tokenized already — no brand hex).

### Control (A) — "Sync in background" toggle

Mirror the existing Notifications `ion-toggle` row at `settings.page.html:271-291`:
an `ion-toggle class="settings-row__toggle" justify="space-between"` bound to the
service's `enabled()` signal, with a `settings-row__helper` caption. Reuse the
same `settings-row` / `settings-row__body` / `settings-row__helper` classes so it
visually matches the Notifications toggle (no new SCSS values invented; add only
scoping selectors if the connected block needs them).

| Element        | Spec (checkable contract)                                                                                                                       | Token / class                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Toggle label   | EXACT string **"Sync in background"** — same type role as the "Notifications" toggle label (body text, `on-surface`).                           | `--vultus-on-surface`             |
| Toggle control | `ion-toggle justify="space-between"`, `[checked]="plexBackground.enabled()"`, `(ionChange)` → `setEnabled($event.detail.checked)`.              | `settings-row__toggle` (existing) |
| Helper caption | EXACT string **"Periodically sync your Plex library while on Wi-Fi. Android only."** — `settings-row__helper` (label-sm, `on-surface-variant`). | `--vultus-on-surface-variant`     |

### Control (B) — interval `ion-select`

Mirror the existing delivery-hour `ion-select` (`settings.page.html:304-319`) — the
same `settings-row__select`, `interface="popover"`, `labelPlacement="start"`
pattern — and **disable it when the background toggle is OFF**, exactly as the
delivery-hour select is disabled when Notifications is off
(`[disabled]="!service.notificationsEnabled()"` → here
`[disabled]="!plexBackground.enabled()"`).

| Element        | Spec (checkable contract)                                                                                                                                                                                 | Token / class                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Select label   | EXACT string **"Sync frequency"** — `labelPlacement="start"` (matches the "Notification time" select).                                                                                                    | `--vultus-on-surface`             |
| Select control | `ion-select class="settings-row__select" interface="popover"`, `[value]="plexBackground.intervalMinutes()"`, `(ionChange)` → `setIntervalMinutes(+$event.detail.value)`.                                  | `settings-row__select` (existing) |
| Options        | Exactly five `ion-select-option`s (value = minutes → EXACT label): `15`→**"Every 15 minutes"**, `30`→**"Every 30 minutes"**, `60`→**"Every hour"**, `180`→**"Every 3 hours"**, `360`→**"Every 6 hours"**. | —                                 |
| Disabled state | `[disabled]="!plexBackground.enabled()"` — greyed/non-interactive when the toggle is OFF (identical to the delivery-hour select when Notifications is off).                                               | (Ionic default disabled styling)  |
| Helper caption | EXACT string **"How often to check Plex in the background (minimum 15 minutes)."** — `settings-row__helper`.                                                                                              | `--vultus-on-surface-variant`     |

### Interactive states (tick each)

- **Toggle**: default (reflects `enabled()`), pressed/checked (emerald track —
  Ionic `--ion-color-primary`), focus-visible ring, disabled (n/a — always
  interactive in the connected block).
- **Interval select**: default (shows current interval label), open (popover
  lists the five options, current one checked), **disabled** (toggle OFF → greyed,
  non-interactive), focus-visible ring, changing → `setIntervalMinutes` + the
  label updates.
- **Font loading**: no new icons introduced (both controls are text + Ionic
  primitives). Inter is already loaded app-wide (spec 0010) — no new web-font
  wiring.

## Implementation task graph

T1 (shared/domain token) is a shared-root edit the shell compiles against —
sequential, first. T2 (settings slice: service + UI + lifecycle) depends on T1's
token only indirectly (it defines the service the shell wires). T3 (app shell +
dependency) depends on the settings barrel export T2 adds (`PlexBackgroundService`)
and on T1's token — sequential after T2. T4 (light e2e) is after T2/T3. **No
backend path.**

**T1 — shared/domain: `PLEX_BACKGROUND_INIT` token [sequential, first]** (backend-engineer / domain)

- `libs/shared/domain/src/lib/tokens.ts`: add `PLEX_BACKGROUND_INIT` (mirror the
  `PLEX_SYNC_TRIGGER` doc-comment + shape).
- Export it from the domain `tokens` entrypoint barrel (same barrel that exports
  `PLEX_SYNC_TRIGGER`).
- Update `libs/shared/domain/README.md` (the new token in the public surface).
- **No document/type/converter/assertion change.**
- Files (manifest): `libs/shared/domain/src/lib/tokens.ts`,
  `libs/shared/domain/src/index.ts` (only if the tokens entrypoint re-exports via
  it), `libs/shared/domain/README.md`.

**T2 — settings slice: `PlexBackgroundService` + connected-block UI + lifecycle [sequential, after T1]** (frontend-engineer)

- `plex-background.service.ts` (`PlexBackgroundService`, `providedIn: 'root'`) +
  `plex-background.service.spec.ts` — per §5 (config defaults/load, `init()`
  native-guard + configure args, `onFetch` enabled-and-linked gating + always
  `finish`, `onTimeout` finish, `setEnabled`, `setIntervalMinutes`, `stop`).
- `settings.page.html`: insert the toggle + interval `ion-select` into the
  connected block between `:257` and `:258` per §6.
- `settings.page.ts`: inject `PlexBackgroundService` (mirror the `plexLink` /
  `plexSync` root-singleton injects at `:75-76`; **not** via `SETTINGS_PROVIDERS`);
  add `onBackgroundToggleChange` / `onBackgroundIntervalChange` handlers; import
  `IonToggle`/`IonSelect` are already in the component imports (`:59-61`).
- `settings.page.scss`: only if the two rows need scoping selectors — reuse
  existing tokenized classes; add no new colour values.
- `settings.page.spec.ts` additions: connected-state renders the toggle (EXACT
  "Sync in background") reflecting `enabled()`; toggling calls `setEnabled`; the
  interval select renders the current interval and is `disabled` when the toggle is
  OFF; changing it calls `setIntervalMinutes`. EXACT rendered strings (no
  whitespace-normalization).
- `plex-link.service.ts`: `unlink()` also calls `PlexBackgroundService.stop()`
  (same-slice dep). Update `plex-link.service.spec.ts` to assert `stop()` is
  called on unlink.
- `plex-connect.page.ts`: `done()` also calls `PlexBackgroundService.init()`
  (fire-and-forget). Update `plex-connect.page.spec.ts` to assert it on "Done".
- `settings.providers.mock.ts`: since `PlexBackgroundService` is `providedIn:
'root'` and the page injects the real root singleton (like `PlexSyncService` /
  `PlexLinkService` per the serve-mock memory note), **no page-provider mock is
  required**; only add one if a component test needs a stub (the specs mock the
  service directly via TestBed providers). State this in the PR.
- Barrel `libs/mobile/settings/src/index.ts`: export `PlexBackgroundService`.
- Update `libs/mobile/settings/README.md` (new service + its public surface +
  boundaries; the unlink/link/onFetch integration).
- Files (manifest): `libs/mobile/settings/src/lib/plex-background.service.ts`,
  `plex-background.service.spec.ts`, `settings.page.html`, `settings.page.ts`,
  `settings.page.scss`, `settings.page.spec.ts`, `plex-link.service.ts`,
  `plex-link.service.spec.ts`, `plex-connect.page.ts`, `plex-connect.page.spec.ts`,
  `settings.providers.mock.ts` (only if a mock stub is needed),
  `libs/mobile/settings/src/index.ts`, `libs/mobile/settings/README.md`.

**T3 — app shell + dependency [sequential, after T2]** (split: infrastructure-engineer for the dep/lockfile/allowBuilds; frontend-engineer for the TS wiring)

- **Dependency (infrastructure-engineer):** add
  `@transistorsoft/capacitor-background-fetch` to `package.json`; write
  `pnpm-lock.yaml` with **pnpm 9** (the CI-pinned major — e.g. `corepack pnpm@9
install`; do NOT write the lockfile with local pnpm 11, which reformats the v9
  lockfile ~-6900 lines and risks CI frozen-install rejection — see §10). If the
  plugin has a build/postinstall script pnpm blocks with an `allowBuilds`
  placeholder in `pnpm-workspace.yaml` (as with `re2`/`sharp`), add the needed
  `allowBuilds` entry set to `true`, otherwise the fresh-worktree install aborts
  (exit 1). **Verify `pnpm nx run functions:deploy-preflight` is unaffected** —
  this is a mobile-only dep; the functions bundle must not pick it up.
- **TS wiring (frontend-engineer):** `app.config.ts` provides `PLEX_BACKGROUND_INIT`
  (native-guarded thunk over `PlexBackgroundService.init()`, mirroring the
  `PLEX_SYNC_TRIGGER` factory); `app.ts` injects the token and calls it on boot
  after `void this.plexSyncTrigger();`; `main.ts` registers the best-effort
  headless task before `bootstrapApplication` (per §5). Note in the PR:
  `pnpm nx build mobile` then `pnpm exec cap sync android` registers the plugin
  natively (per CLAUDE.md Windows tooling; not runnable in-session without a
  device, so it is a documented step).
- `app.spec.ts` additions: `PLEX_BACKGROUND_INIT` is provided and
  `App.ngOnInit` calls it on boot — supply a spy, mirror the existing
  `PLEX_SYNC_TRIGGER` boot-call test at `app.spec.ts:77-95`.
- Files (manifest): `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
  (allowBuilds, only if needed), `apps/mobile/src/app/app.config.ts`,
  `apps/mobile/src/app/app.ts`, `apps/mobile/src/main.ts`,
  `apps/mobile/src/app/app.spec.ts`.

**T4 — e2e (optional/light) [sequential, after T2/T3]** (frontend-engineer / qa)

- Extend `apps/mobile-e2e/src/plex-sync.spec.ts` (0073) to assert that, in the
  connected state (mock, non-native → the background service is a native-guarded
  no-op but the UI + Preferences state still render), the "Sync in background"
  toggle and the "Sync frequency" interval control **render** (EXACT strings,
  consistent with the component specs). **Do NOT write a background-firing e2e** —
  background execution is native-only and cannot be exercised in web/e2e or
  in-session (no device; OS scheduling). If extending is not cheap, note that e2e
  coverage is limited to control render and the real background behavior is
  on-device-verify-only.
- Files (manifest): `apps/mobile-e2e/src/plex-sync.spec.ts`.

**Disjointness:** T1 writes only `libs/shared/domain/**`. T2 writes only
`libs/mobile/settings/**`. T3 writes only `apps/mobile/**` + the three root
dependency files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`). T4
writes only `apps/mobile-e2e/**`. No two tasks write the same file. (T3's TS
wiring and dependency work touch disjoint files within `apps/mobile/**` + root,
but are assigned to two agents on the SAME sequential task — they do not run in
parallel with each other; the split is a role assignment, not a fan-out.)

## Test plan

Per the PLAN §5 pyramid. All plugin / Preferences / Firebase / Plex access in
unit/component tests is **mocked**; no emulator (project memory: the emulator
cannot run under Claude Code tools; the e2e gate runs in CI). **Rendered-text
assertions use the EXACT string** — no whitespace-normalization — and the
component and any e2e assertions stay consistent on the same copy ("Sync in
background", "Sync frequency", "Every hour").

**Unit (`plex-background.service.spec.ts` — mock `@transistorsoft/capacitor-background-fetch` + `Preferences` + `PlexSyncService`; NO `PlexLinkService` — the service does not inject it):**

- Config defaults: empty Preferences → `enabled()` true, `intervalMinutes()` 60.
- Loaded config overrides defaults: Preferences `plex_bg_enabled=false` /
  `plex_bg_interval_min=180` → `enabled()` false, `intervalMinutes()` 180.
- `init()` on native calls `BackgroundFetch.configure` with the persisted
  `minimumFetchInterval` + `requiredNetworkType: NETWORK_TYPE_UNMETERED` +
  `requiresBatteryNotLow: true` + `requiresCharging: false` +
  `stopOnTerminate: false` + `startOnBoot: true` + `enableHeadless: true`.
- `init()` off-native is a **no-op** (Capacitor mocked non-native → no `configure`
  call; the signals stay at defaults `true`/`60` because the guard precedes the
  Preferences load).
- `onFetch` calls `PlexSyncService.sync()` **only when** `enabled()` is true **AND
  the `plex_token` Preferences value is non-empty** (linked-on-this-device, read
  directly — NOT via `PlexLinkService`); when disabled OR `plex_token` is
  empty/absent it does NOT call `sync()`; and it **ALWAYS** calls
  `BackgroundFetch.finish(taskId)` — **including when `sync()` throws** (fail
  quietly; assert `finish` still called).
- `onTimeout` calls `BackgroundFetch.finish(taskId)`.
- **Web-guard:** with Capacitor mocked non-native, `setEnabled(false)` /
  `setIntervalMinutes(180)` / `stop()` still write/clear their Preferences keys but
  make **no** `BackgroundFetch.*` call (assert the plugin methods are NOT invoked
  off-native — a serve-mock tick can't throw against the web stub).
- `setEnabled(false)` (native) persists `plex_bg_enabled=false` and calls
  `BackgroundFetch.stop()`; `setEnabled(true)` (native) persists true and
  configures/starts.
- `setIntervalMinutes(180)` (native) persists `plex_bg_interval_min=180` and
  reconfigures with `minimumFetchInterval: 180`; a value < 15 is clamped to 15.
- `stop()` clears the bg Preferences keys **unconditionally** (assert cleared even
  off-native) and calls `BackgroundFetch.stop()` **only when native**.
- Unlink path (`plex-link.service.spec.ts` addition): `unlink()` calls
  `PlexBackgroundService.stop()`.
- Link path (`plex-connect.page.spec.ts` addition): `done()` calls
  `PlexBackgroundService.init()`.

**Component (`settings.page.spec.ts` additions — mocked services):**

- Connected state: the "Sync in background" toggle renders (EXACT
  "Sync in background") and `[checked]` reflects the service `enabled()` signal;
  toggling it calls `setEnabled` with the new value.
- The interval `ion-select` renders with the current `intervalMinutes()` value and
  the EXACT option labels; it is `disabled` when the toggle is OFF; changing it
  calls `setIntervalMinutes`.
- Assert EXACT rendered strings (no whitespace-normalization); keep component +
  any e2e text consistent.

**App shell (`app.spec.ts` additions):**

- `PLEX_BACKGROUND_INIT` is provided (spy) and `App.ngOnInit` calls it on boot —
  mirror the existing `PLEX_SYNC_TRIGGER` boot-call test at `app.spec.ts:77-95`
  (the barrel already pulls in the Plex services; the existing
  `@capacitor/preferences` mock at `:63-69` covers `PlexBackgroundService`'s
  Preferences import — extend it if the service calls a Preferences method the
  stub lacks).

**e2e (rubric): Not a background-firing flow — control-render only.** Background
execution is native-only and CANNOT be exercised in web/e2e or in-session (no
device; OS scheduling / WorkManager). This spec does **not** introduce a new
user-facing route or a critical navigation action (the toggle + selector live on
the existing Settings connected card, added by 0073's route), so a new e2e flow is
**not required** by the rubric. If cheap, extend 0073's
`apps/mobile-e2e/src/plex-sync.spec.ts` to assert the two controls **render** in
the connected state (mock, non-native → background service is a no-op, UI still
renders). Otherwise state explicitly that e2e coverage is limited to control
render and the real background behavior is on-device-verify-only. **Never a
background-firing e2e.**

**Post-merge human verification (CLAUDE.md — green CI ≠ verified):** on a real
Android device on Wi-Fi (`pnpm nx run mobile:android-usb`), verify a periodic
background sync actually fires — add a title in Plex while the app is backgrounded,
wait for the chosen interval, and confirm it appears in Vultus. The real-PMS +
background/WorkManager path is NOT verifiable in-session (same posture as 0073's
real-PMS note); flag it as an explicit post-merge human step in the PR.

## Definition of done

Tailored from PLAN §5. Affected: `shared-domain`, `mobile-settings`, `mobile`
(shell), `mobile-e2e`.

- [ ] `pnpm nx typecheck` passes for all affected projects — the
      `PLEX_BACKGROUND_INIT` token, `PlexBackgroundService`, the settings UI +
      lifecycle edits, and the shell wiring compile. (T1, T2, T3)
- [ ] `pnpm nx lint <affected>` passes **with Sheriff active**: `PlexBackgroundService`
      stays in `slice:settings`; the shell obtains it only via the `scope:shared`
      `PLEX_BACKGROUND_INIT` token (no `apps/mobile` import into the slice); **no
      `scope:mobile` ↔ `scope:functions` edge**; no premature `shared/` extraction.
      (T1, T2, T3)
- [ ] `pnpm nx test shared-domain` — the token is exported and typed. (T1)
- [ ] `pnpm nx test mobile-settings` — `PlexBackgroundService` (defaults/load,
      `init` configure args + native-guard, `onFetch` gating + always-`finish` incl.
      when `sync()` throws, `onTimeout` finish, `setEnabled`, `setIntervalMinutes`
      clamp, `stop`); unlink calls `stop()`; connect "Done" calls `init()`; the
      connected-card toggle + interval control (EXACT strings, disabled-when-off).
      (T2)
- [ ] `pnpm nx test mobile` (shell) — `PLEX_BACKGROUND_INIT` is provided and the
      boot trigger fires in `ngOnInit`. (T3)
- [ ] `pnpm nx build mobile` passes. (T3)
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green. (all)
- [ ] **Dependency added correctly:** `@transistorsoft/capacitor-background-fetch`
      in `package.json`; `pnpm-lock.yaml` written with **pnpm 9** (no v9→v11
      reformat); `pnpm-workspace.yaml` `allowBuilds` entry added **iff** the plugin
      needs a build script; a fresh-worktree `pnpm install` succeeds (exit 0). (T3)
- [ ] **Web-bundle import safety:** after adding the dep, the plugin's web entry is
      a safe no-op at import time — `mobile:serve-mock` and the e2e web bootstrap
      **still start** (bundle loads, app renders); no top-level throw from the
      `main.ts` plugin import in a web build. If not import-safe, the import is
      isolated behind a native dynamic `import()`. (T3)
- [ ] **Circular-DI avoided:** `PlexBackgroundService` does NOT inject
      `PlexLinkService`; `onFetch` reads the `plex_token` Preferences key directly
      for the linked check; `SettingsPage` injects both root services without
      `NG0200`. (T2)
- [ ] **`functions:deploy-preflight` unaffected** — the new plugin is mobile-only
      and does not enter the functions bundle; run
      `pnpm nx run functions:deploy-preflight` and confirm green. **State
      explicitly in the PR.** (T3)
- [ ] **`firestore.rules`: NO change** and **no rules-test change** — this spec
      writes nothing to Firestore. **Stated explicitly in the PR.** (§4)
- [ ] **`firestore.indexes.json`: NO change** — no new query. **Stated explicitly
      in the PR.** (§4)
- [ ] **e2e:** if extended, `plex-sync.spec.ts` asserts the two new controls render
      in the connected state (mock); otherwise the PR states e2e is limited to
      control render (real background behavior is on-device-verify-only). No
      background-firing e2e. (Runs in CI, not under Claude Code tools locally.) (T4)
- [ ] **Canonical settings Stitch screen re-fetched:** the implementer re-fetched
      `0e2bb1f198f04186b39e4a2604413417` (0073's settings screen, per the CLAUDE.md
      recipe) and confirmed it does NOT already depict background-sync controls,
      BEFORE relying on the "spec-authored, no screen" justification. If it does
      depict them, they are matched instead. (T2)
- [ ] **UI fidelity verified** (`mobile:serve-mock` / screenshot of the connected
      Plex card showing the toggle + interval selector), OR explicitly flagged
      unverified for a human — a green build does not prove fidelity (CLAUDE.md).
      The section is **spec-authored (no Stitch screen), consistent with the
      sibling Notifications toggle + delivery-hour select** (contingent on the
      screen re-fetch above). The serve-mock screenshot shows DEFAULT control
      values (`enabled` ON / "Every hour") because `init()` no-ops off-native
      before loading Preferences. (T2)
- [ ] **No hard-coded hex** in any new/edited template/SCSS — the two controls
      reuse the existing tokenized `settings-row*` classes; every colour is a
      `--vultus-*` / `--ion-*` var. (T2)
- [ ] **Reliability honesty:** the PR / UI does NOT claim guaranteed sync while
      fully terminated; the headless task is a best-effort finishing stub and the
      terminated path is flagged on-device-verify-only. (T2, T3)
- [ ] **Secrets:** `PlexBackgroundService` never touches, reads, or logs the
      X-Plex-Token; the bg config in Preferences is boolean + number only. (T2)
- [ ] READMEs updated: `shared/domain` (new token), `mobile/settings` (new
      service + lifecycle). (T1, T2)
- [ ] **Boundary verifications (review-checked):** (a) `scope:mobile` +
      `scope:shared` ONLY — no functions edit; (b) `PlexBackgroundService` is
      `providedIn: 'root'` and NOT in `SETTINGS_PROVIDERS` (shared singleton with
      the boot trigger); (c) Android-only — iOS/web init is a native-guarded no-op;
      (d) the `onFetch` callback reuses the EXISTING `PlexSyncService.sync()` (no
      reimplemented sync logic); (e) config is device-local Preferences, no
      Firestore/domain change. (all)
- [ ] **POST-MERGE HUMAN VERIFICATION (CLAUDE.md — green CI ≠ verified):** on a
      real Android device on Wi-Fi (`mobile:android-usb`), confirm a periodic
      background sync actually fires (add a Plex title while backgrounded, wait the
      interval, see it appear). The PR MUST flag this as an explicit post-merge
      human step — CI exercises only the non-native no-op path. (T3)
- [ ] PR description records: verification commands, the "no Stitch screen —
      spec-authored controls" note + the serve-mock screenshot, the boundary
      confirmations, the explicit "no functions / no rules / no index change"
      statements, the pnpm-9 lockfile note, and the post-merge on-device step.

## Risks

- **Reliability envelope — do NOT over-promise (lead risk).** Android WorkManager
  gives **no exact-time guarantee**: it enforces a ~15-minute floor and defers
  tasks under Doze / battery optimization / app-standby buckets, so "every hour"
  is a _minimum interval_, not a schedule. The **reliable** path is periodic sync
  while the app is alive/backgrounded and when Android relaunches the app in the
  background for a task (`stopOnTerminate:false`, `startOnBoot:true`,
  `enableHeadless:true`). The **fully-terminated / swiped-away** path is
  **best-effort only** (the headless stub just finishes the task; the Angular
  `PlexSyncService` may be unavailable in that minimal context) — **do NOT claim
  guaranteed terminated-state sync** in copy or the PR. Meaningful terminated-state
  sync is a possible future enhancement and is **on-device-verify-only**.
- **pnpm-9 lockfile write (CI frozen-install).** Per project memory, CI pins pnpm
  major **9** while the local env is pnpm **11**; a local pnpm-11 lockfile write
  **reformats the v9 lockfile (~-6900 lines)** and risks CI frozen-install
  rejection, and a local pnpm-11 frozen-install is not a CI proxy. The
  `pnpm-lock.yaml` for this new dep **MUST be written with pnpm 9** (e.g. `corepack
pnpm@9 install`), assigned to the infrastructure-engineer in T3. A local pnpm-11
  frozen-install passing does not prove CI will accept the lockfile.
- **`allowBuilds` placeholder abort.** If
  `@transistorsoft/capacitor-background-fetch` ships a build/postinstall script,
  pnpm blocks it with an `allowBuilds` placeholder in `pnpm-workspace.yaml` and a
  **fresh-worktree `pnpm install` aborts (exit 1)** — exactly the `re2`/`sharp`
  trap in memory. T3 must add the required `allowBuilds` entry (set to `true`) so
  the install completes; verify a clean worktree install exits 0.
- **The real background path is only verifiable on-device.** WorkManager
  scheduling, the Wi-Fi/battery constraints, the plugin's native bridge, and an
  actual background `PlexSyncService.sync()` against a real PMS all require a
  native build + a real device on the home LAN — none run under Claude Code tools
  or in web CI. Mitigation: the native guard makes every unit/component/e2e/
  serve-mock path a deterministic no-op; the DoD carries an explicit post-merge
  `android-usb` human-verification gate. Green CI is necessary but NOT sufficient
  (CLAUDE.md).
- **Community plugin dependency + web-bundle import safety.**
  `@transistorsoft/capacitor-background-fetch` is a third-party plugin; its native
  behavior + Capacitor 8 compatibility are an external contract. If it lags a
  Capacitor major, `cap sync android` or the native build could break — a
  maintenance risk flagged for the reviewer; its released version + Capacitor-8
  support should be confirmed at implementation. **Additionally, `main.ts` is the
  web/e2e entry too**, so the top-level `import { BackgroundFetch } from
'@transistorsoft/capacitor-background-fetch'` is bundled and **evaluated in web
  builds** even though `registerHeadlessTask` is native-guarded. The plugin's web
  entry must be a **safe no-op at import time** (no top-level throw / native-only
  side effect); if it is not, isolate the import behind a native dynamic
  `import()` inside the guard. Mitigation + gate: the DoD requires verifying
  `mobile:serve-mock` and the e2e web bootstrap still start after the dep lands.
- **Circular DI (resolved by design).** `PlexLinkService.unlink()` →
  `PlexBackgroundService.stop()` is one-directional; `PlexBackgroundService` does
  NOT inject `PlexLinkService` back (which would cycle, both being
  `providedIn:'root'` → `NG0200`). The linked-on-this-device check in `onFetch`
  therefore reads the `plex_token` Preferences key directly rather than calling
  `PlexLinkService.isLinked()`. Reviewer confirms no back-injection reintroduces
  the cycle and the token VALUE is never logged.
- **Battery / OEM aggressiveness.** Some Android OEMs (e.g. aggressive battery
  managers) kill background tasks harder than stock Android; the user may need to
  exempt Vultus from battery optimization for reliable background sync. This is an
  OS/OEM behavior, not a bug — worth a one-line note in the connected-card helper
  or docs, but no in-app battery-optimization prompt is in scope here.
- **No shared/domain required-field change → no F2 ripple.** The only
  `shared/domain` edit is the additive `PLEX_BACKGROUND_INIT` **token**; **no
  field is added to `User` or any converted type**, so there is **no full-`User`
  write-literal ripple** and no `.toEqual` write-payload breakage (unlike 0073's
  `plexSync` add). **State this explicitly.**
- **No PLAN conflict.** This is a purely additive trigger on top of 0073's merged,
  on-device Plex sync — reusing its engine, adding one `scope:shared` shell token
  (the `PLEX_SYNC_TRIGGER` pattern) and device-local Preferences config. No new
  collection, no rules change, no index, no function, no cross-slice import. It
  extends PLAN §1's watch-tracking scope to "keep your Plex import fresh
  periodically in the background (Android, best-effort)."
