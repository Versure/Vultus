# mobile-settings

Region picker, global notifications toggle, and eager `users/{uid}` init for the
Vultus settings tab (PLAN §6 item 16, spec 0011).

## Public API

The barrel (`@vultus/mobile/settings`) exports:

- `SettingsPage` — standalone Ionic page (selector `lib-settings`); lazy-loaded
  by the tabs shell in `apps/mobile` via
  `loadComponent: () => import('@vultus/mobile/settings').then(m => m.SettingsPage)`.

`SettingsService` and `SyncStatusService` are internal data-access services used
only by `SettingsPage` / its cards and are intentionally **not** barrel-exported
(keeps the public surface minimal). `SyncStatusCardComponent`
(selector `lib-sync-status-card`) is likewise an internal component composed into
`SettingsPage` only.

### Last-synced card (spec 0049)

`SyncStatusCardComponent` is a **read-only** "Last synced" status card rendered as
a sibling `.settings-card` below the Region / Notifications controls. It is backed
by `SyncStatusService`, which **one-shot** reads the single most-recent run from the
global `sync-runs` collection
(`query(collection(firestore, syncRunsCollection()), orderBy('startedAt','desc'), limit(1))`)
via `getDocs` and maps it through `@vultus/shared/firestore-schema`'s `dataToSyncRun`.
The query is **not** uid-scoped (a cron run records `userId: null`; the card answers
"did the pipeline run?"), so the slice needs no uid for it. The service exposes
`lastRun: Signal<SyncRun | null>`, `loaded`, and `loadFailed` signals plus `load()`,
mirroring `SettingsService`'s loaded/loadFailed idiom.

The card is **non-interactive** (no click handler, no focus ring, no control) and
renders these states:

- **loading** — an `ion-skeleton-text` card placeholder; never stale/blank content.
- **never-synced** (`lastRun() === null`) — `sync-outline` icon, "Never synced", no
  counts, no chip.
- **load-failed** — the service leaves `lastRun` null and the card renders
  **identically to never-synced**: no error banner/toast/string (a failed read of
  this non-essential observability data must not surface to the user).
- **success** (`errorCount === 0`) — `sync-outline`; a relative timestamp
  ("Last synced 3 hours ago" / "just now", computed by the pure `relativeTime`
  helper) + "{titlesGathered} gathered · {titlesUpdated} updated"; no chip.
- **with-errors** (`errorCount > 0`) — `alert-circle-outline` in the design `error`
  color + a danger "{n} error(s)" chip; **count only — no specific error strings**
  (decision 3).

The `mock` build profile provides a structural `SyncStatusService` (no Firebase)
seeded with a recent success run so `mobile:serve-mock` renders the success state;
flip `SEEDED_RUN` / `errorCount` in `settings.providers.mock.ts` to eyeball the
never-synced / with-errors states.

## Behaviour

On mount, `SettingsPage` calls `SettingsService.load()`, which reads
`users/{uid}` (path + wire mapping via `@vultus/shared/firestore-schema`'s
`userPath` / `dataToUser` / `userToData`). If the doc is absent it is created
with defaults `{ region: 'NL', notificationPrefs: { episodeAired: true,
movieAvailable: true, cameToPlatform: true }, fcmTokens: [] }`, guaranteeing
downstream slices can assume it exists.

The page exposes:

- a **Region** `ion-select` over the shared `REGIONS` list, writing
  `users/{uid}.region` on change;
- a global **Notifications** `ion-toggle` — a UI projection over the three
  `notificationPrefs` booleans (reads on when all three are true; writing sets
  all three at once). No `notificationsEnabled` field is persisted; per-type
  toggles are a later spec.
- a **Notification time** `ion-select` (spec 0051) — the quiet-hours delivery
  preference over `notificationPrefs.deliveryHour`. Options are "Any time"
  (`null`) plus the 24 UTC hours `00:00 UTC`..`23:00 UTC` (`deliveryHours`,
  zero-padded by the page's `formatHour` helper). It is **disabled** while the
  global Notifications toggle is off (no pushes to schedule). Pushes are only
  sent during the chosen UTC hour; notifications still appear in the in-app
  inbox.
- a **My Providers** card (spec 0060) — a wrapping grid of tappable provider
  chips (a `<button>` per catalog entry, `aria-pressed`, NOT an
  `ion-segment`/`ion-select`) placed **between** the Region and Notifications
  cards. Each chip shows the provider logo + name; a **selected** chip (its id
  in `myProviderIds`) gets a primary border + `checkmark-circle` badge + full
  opacity, an **unselected** one an outline-variant border at 60% opacity.
  Tapping a chip persists the toggled `users/{uid}.myProviderIds` array. A footer
  reads "N of M selected · Region: {region}". While the catalog is fetching, a
  spinner renders in place of the chips (never an empty card). The grid's LAST
  chip is the **Plex** chip (spec 0061 — see below); it is NOT a catalog entry.
  Stitch reference:
  `projects/13590348714018893783/screens/cebdfd02c7d44023b0e0019dd4907d48`
  ("Settings - My Providers - Vultus").
- a **Plex** chip (spec 0061) — the 7th chip in the same "My Providers" grid,
  rendered from its OWN template block (not a member of `providerCatalog()`) and
  backed by the SEPARATE `hasPlex` boolean (NOT `myProviderIds` — Plex has no
  TMDB id). It shares the sibling chips' footprint, border/badge/opacity
  treatment; its neutral logo tile holds the bundled Plex wordmark image
  (`/assets/plex-logo.svg`, `object-fit: contain` so the wide wordmark isn't
  cropped), and it carries a Plex-only "Manual" secondary caption. Tapping it
  calls `onPlexToggle` → `SettingsService.toggleHasPlex()`.

### My Providers — data flow (spec 0060)

`myProviderIds: number[]` is an **open** list of TMDB provider ids on
`users/{uid}` (default `[]`; legacy docs missing it read as `[]` via the
converter). `SettingsService`:

- reads `myProviderIds` in `load()` and writes `myProviderIds: []` in the
  eager-create `User` literal;
- exposes `providerCatalog: Signal<CatalogProvider[]>`,
  `myProviderIds: Signal<number[]>`, `catalogLoading: Signal<boolean>`, and
  `lastPrunedCount: Signal<number>` (readonly);
- `loadProviderCatalog()` loads the current region's catalog via the
  `scope:shared` `GET_WATCH_PROVIDERS` token (a thunk over the `getWatchProviders`
  callable, provided by the shell — this slice never imports
  `@angular/fire/functions`). It no-ops when the catalog is already loaded for the
  current region;
- `toggleProvider(id)` adds/removes one id and persists the WHOLE array;
- `setRegion(region)` performs **two sequential** `users/{uid}` writes — first
  the region, then (once the new region's catalog loads) the pruned
  `myProviderIds` (ids not in the new catalog are dropped). It reports the dropped
  count via `lastPrunedCount`; the page reacts to a `>0` value to raise a
  `ToastController` toast. **Guard:** if the new catalog fails to load, the prune
  is **skipped** (the provider list is never destroyed on a failed read) and
  `lastPrunedCount` stays 0.

The `mock` build profile seeds a full `providerCatalog` (Netflix, Disney Plus,
Max, Amazon Prime Video) and `myProviderIds: [8]` (Netflix) so `mobile:serve-mock`
renders a selected + unselected chip mix without a callable.

### Plex — hasPlex (spec 0061)

`hasPlex: boolean` on `users/{uid}` (default `false`; legacy docs missing it read
as `false` via the converter) records whether the user uses a self-hosted Plex
server. It is a **separate boolean, never a member of `myProviderIds`** (Plex has
no TMDB id). `SettingsService`:

- reads `hasPlex` in `load()` and writes `hasPlex: false` in the eager-create
  `User` literal;
- exposes `hasPlex: Signal<boolean>` (readonly);
- `toggleHasPlex()` flips the value and persists a **scalar**
  `updateDoc(..., { hasPlex })` (like `setRegion`'s `{ region }`), null-uid
  guarded. It NEVER touches `myProviderIds`.

The `mock` build profile seeds `hasPlex: true` so `mobile:serve-mock` renders the
Plex chip selected. The Plex chip toggle is wired through `onPlexToggle()` on the
page (distinct from 0060's `onProviderToggle`).

### Preserve-other-prefs write rule (spec 0051)

`notificationPrefs` now has four fields (`episodeAired`, `movieAvailable`,
`cameToPlatform`, `deliveryHour`). The service tracks the full object in state so
**both** setters rebuild and write the WHOLE `notificationPrefs` object,
preserving the other setter's data:

- `setNotificationsEnabled(enabled)` sets the three booleans to `enabled` while
  preserving the current `deliveryHour`.
- `setDeliveryHour(hour)` sets `deliveryHour` (a number 0–23, or `null` for "Any
  time") while preserving the three booleans.

Neither setter touches `fcmTokens`. The eager-create default writes
`deliveryHour: null`.

Writes happen on user interaction (no Save button). The form is render-gated on
`load()`:

- **Loading** (default): a form-shaped skeleton (two stacked
  `ion-skeleton-text` placeholder cards) shows until the doc resolves.
- **Loaded** (`loaded()` true): the Region / Notifications cards render.
- **Error** (`loadFailed()` true): if `load()` throws (e.g. Firestore offline)
  the page renders `VultusErrorState` (from `@vultus/shared/ui-kit`) with a
  retry button wired to `SettingsService.retryLoad()`. `loadFailed` is checked
  **before** `loaded`, so a failure never leaves the skeleton hanging.

`SettingsService` exposes `region`, `notificationsEnabled`, `deliveryHour`
(readonly signals), the `regions` / `deliveryHours` option lists, `loaded`,
`loadFailed` (readonly signals) and `retryLoad()` (resets `loadFailed` and
re-runs `load()`) for this gate.
`fcmTokens` is never written beyond the `[]` default (FCM registration is
PLAN §6 item 21).

The current uid is obtained via the `scope:shared` `AUTH_UID` injection token
(provided at the app root by the shell), so this slice never imports
`apps/mobile`.

## Sheriff boundaries

- Tags: `scope:mobile`, `slice:settings` (by path glob in `sheriff.config.ts`).
- May import: `scope:shared` libs (`@vultus/shared/domain` — `Region`, `User`,
  `SyncRun`, `CatalogProvider`; `@vultus/shared/domain/tokens` — `AUTH_UID`,
  `GET_WATCH_PROVIDERS`; `@vultus/shared/firestore-schema` —
  `userPath`/`dataToUser`/`userToData`, `syncRunsCollection`/`dataToSyncRun`) and
  third-party packages (Ionic, AngularFire).
- Must not import: other slices (`slice:search` / `slice:watchlist`),
  `apps/mobile`, or any `scope:functions` code. The `sync-runs` collection is a
  cross-scope persistence contract: `apps/functions` writes it, this slice only
  **reads** it (client writes are denied by `firestore.rules`) — the two scopes
  share only the `scope:shared` data shape, never each other's code.
- The provider catalog is reached only through the `scope:shared`
  `GET_WATCH_PROVIDERS` token (a thunk the shell provides over the
  `getWatchProviders` callable, mirroring `TRIGGER_SYNC`), so this slice never
  imports `@angular/fire/functions` — no `scope:mobile` ↔ `scope:functions` edge.
