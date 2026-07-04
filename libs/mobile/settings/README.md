# mobile-settings

Region picker, global notifications toggle, eager `users/{uid}` init, the "My
Providers" catalog, and the **Plex link + one-way sync** for the Vultus settings
tab (PLAN §6 item 16; specs 0011 / 0049 / 0051 / 0060 / 0061 / 0073).

## Public API

The barrel (`@vultus/mobile/settings`) exports:

- `SettingsPage` — standalone Ionic page (selector `lib-settings`); lazy-loaded
  by the tabs shell in `apps/mobile` via
  `loadComponent: () => import('@vultus/mobile/settings').then(m => m.SettingsPage)`.
- `PlexConnectPage` (spec 0073) — standalone Ionic page (selector
  `lib-plex-connect`) for the `/tabs/settings/plex` pushed sub-route; lazy-loaded
  by the shell the same way.
- `PlexLinkService`, `PlexSyncService` (spec 0073) — **`providedIn: 'root'`**
  singletons. Exported so the shell's `app.config.ts` can wire `PLEX_SYNC_TRIGGER`
  over `PlexSyncService.sync()` from the ROOT injector and both pages can share
  that instance. **Do NOT list them in `SETTINGS_PROVIDERS`** (page-scoping would
  fork the state from the boot/resume trigger's instance).
- `CapacitorHttpPlexClient`, `MockPlexClient` (spec 0073) — the two `PlexClient`
  impls, exported so the shell's `PLEX_CLIENT` factory selects between them
  (`Capacitor.isNativePlatform()` → real, else mock). There is **no
  `PLEX_PROVIDERS`** export and **no `plex.providers.ts`** — the shell factory is
  the single client selector.
- `PlexSyncSummary` (type) — the `{ added, updated, skipped }` outcome of a sync.

`SettingsService` and `SyncStatusService` are internal data-access services used
only by `SettingsPage` / its cards and are intentionally **not** barrel-exported
(keeps the public surface minimal). `SyncStatusCardComponent`
(selector `lib-sync-status-card`) is likewise an internal component composed into
`SettingsPage` only.

## Plex link + one-way sync (spec 0073)

One-way import from the user's self-hosted Plex Media Server (PMS): new PMS
library items become watchlist entries and PMS watch state drives Vultus's
`status` + episode-watched machinery. On-device, LAN, `scope:mobile` +
`scope:shared` only — **no Cloud Function change**. Stitch screens:
Settings Plex card `0e2bb1f198f04186b39e4a2604413417`; Connect page
`398cde766832491e92e1c0c5cc09ab4e`.

### `PlexClient` (real + mock)

`PlexClient` is a `scope:shared` interface (`@vultus/shared/domain`) describing
the plex.tv / PMS surface (PIN-link, resources discovery, paged library + episode
reads). Two impls live in this slice:

- `CapacitorHttpPlexClient` — the NATIVE impl; every plex.tv / PMS call goes
  through `CapacitorHttp` (`@capacitor/core`) because the PMS sends no CORS
  headers. **Only works on-device** (verified post-merge via `android-usb`).
  **`CapacitorHttp` RESOLVES non-2xx responses** (it rejects only on transport
  failures), so every method checks `res.status` and throws a typed error
  (`PlexHttpError`, or `PlexPinGoneError` for a `GET /pins/{id}` 404) — otherwise
  a 401/404/429 error body silently coerces to `[]`/`{}` and masquerades as "no
  servers" / "not yet authorized". It sends a **per-install**
  `X-Plex-Client-Identifier` (a UUID generated once and persisted to Preferences
  under `plex_client_id`) — a constant shared by all installs collides in the
  account's plex.tv device registry — and passes `includeIPv6=1` to discovery so
  an IPv6-only LAN still exposes a `local` connection.
- `MockPlexClient` — deterministic fixtures (pin auto-authorizes; a small library
  with a watched tmdb-GUID movie, a planned tmdb-GUID movie, a partially-watched
  tmdb-GUID show, and one GUID-less item; a two-episode show with the first
  watched). Selected for every non-native surface (web / dev / e2e / serve-mock).

### `PlexLinkService` (`providedIn: 'root'`)

Owns the plex.tv PIN-link state machine, on-device token persistence, server
discovery, and the `hasPlex` / `plexSync` Firestore link metadata. Surface:

- signals `stage` (`idle`|`code`|`waiting`|`connected`|`error`), `errorReason`
  (`expired`|`no-server`|`network`|`null`), `code`, `server`, `expiresInSeconds`,
  `countdown` (mm:ss), plus the settings-card state `linked`, `serverName`,
  `lastSyncAt`;
- `requestCode()` (→ `code`, starts the countdown + polling), `regenerateCode()`,
  `cancel()`, `isLinked()`, `loadState()` (loads the card state), `unlink()`.

On a successful poll it **discovers the server FIRST, then** persists the token
to `@capacitor/preferences` (key `plex_token`), then `updateDoc(userPath(uid),
{ hasPlex: true, plexSync: { linkedAt, lastSyncAt, serverName } })`. This
ordering + a token roll-back if the Firestore write throws is a hard invariant:
a failed link must never leave the device **half-linked** (token present but no
`plexSync`), which would make the Settings card claim "Connected" while the
connect page reports a failure. `loadState()` **self-heals** any half-linked
state left by an older build (or an unlink performed on another device): a token
with no `plexSync` metadata is dropped.

**Error surfacing (spec 0073 Risks).** The `error` stage carries a distinct
`errorReason` so a post-authorization failure is not mislabeled as an expired
code (the original bug): `expired` (local wall-clock deadline OR a plex.tv
`PlexPinGoneError` 404), `no-server` (auth succeeded but discovery found no
local server), `network` (a plex.tv/Firestore/HTTP call failed). The connect
page renders reason-specific copy from it. The polling loop tolerates up to 5
consecutive transient `checkPin` transport failures before giving up (Android
can kill an in-flight request's socket while the app is backgrounded at
plex.tv/link), and the expiry countdown is **wall-clock anchored** (a deadline
timestamp, not a decrement-per-tick counter) because Android throttles WebView
timers while backgrounded. The merged `PlexPin` carries no `expiresIn`, so the
~15-minute PIN TTL deadline is owned locally at code issue.

**Unlink** clears the Preferences token + `plexSync` (`deleteField()`), KEEPS
`hasPlex` + all synced data, and touches no watchlist/episode doc.

### `PlexSyncService` (`providedIn: 'root'`)

`sync()` runs one-way import: an **additions** pass (cursor-gated on
`plexSync.lastSyncAt ?? linkedAt`) + a **watched-mirror** pass (full mirror for
matched titles), then advances `plexSync.lastSyncAt`. `running` (signal) drives
the "Sync now" spinner/disabled state. No-op when uid null, not linked (no
Preferences token), or already running (concurrent guard, claimed synchronously).

Key invariants:

- **GUID matching**: `tmdb://603` → tmdbId 603; a GUID-less item is SKIPPED
  (counted, never fuzzy-matched, no write).
- **Status derivation is REPLICATED locally** (the slice cannot import
  `TitleDetailService`): movie `viewCount > 0` → `completed`; show `planned →
watching` on ≥1 watched episode, `watching → completed` when all present
  episodes watched. **Sticky-`dropped`**: a dropped title keeps its status (no
  status write) but STILL receives the episode mirror.
- **Watch-implies-add**: a watched, untracked tmdb-GUID item is added (movie →
  `completed`, show → `watching`), `watchingViaPlex: true`, `traktId: null`.
- **Episode mirror writes EXISTING docs only** (`updateDoc`); it NEVER creates an
  episode doc — a Plex-watched episode with no local doc is a no-op. The doc id is
  `s{SS}e{EEE}` (season padded to 2, episode to 3, e.g. `s01e001`) — replicated
  from `sync-episodes`' `episode-id.ts` (a `scope:functions` lib this slice cannot
  import), derived from Plex `parentIndex` (season) + `index` (episode).

The X-Plex-Token is stored ONLY in `@capacitor/preferences`, NEVER written to any
Firestore path, and NEVER logged/echoed (CLAUDE.md secrets rule).

### Plex Server card (in `SettingsPage`)

Between "My Providers" and the Notification cards (spec 0073 §6A). Gated on
`plexLink.linked()`: a disconnected "Connect Plex Server" nav row →
`/tabs/settings/plex`; or a connected block with the server name, an emerald
"Connected" dot, "Last synced — {relative}" (or "Not synced yet"), a "Sync now"
text button (disabled + "Syncing…" while `plexSync.running()`), and a
"Disconnect" text button (confirm alert → `unlink()`). The logo tile uses a
`--vultus-*` surface token; the Plex brand colour lives only in
`/assets/plex-logo.svg`.

The `mock` build profile provides page-scoped mock mirrors of the root
`PlexLinkService` / `PlexSyncService` (seeded CONNECTED) so `mobile:serve-mock`
renders the connected card + the connect stages with no Preferences / plex.tv.

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
  `SyncRun`, `CatalogProvider`, and the Plex vocabulary `PlexClient` / `PlexPin` /
  `PlexServer` / `PlexLibraryItem` / `PlexEpisodeItem`; `@vultus/shared/domain/tokens`
  — `AUTH_UID`, `GET_WATCH_PROVIDERS`, `PLEX_CLIENT`; `@vultus/shared/firestore-schema`
  — `userPath`/`dataToUser`/`userToData`, `watchlistItemPath`/`watchlistItemToData`,
  `episodePath`/`episodesPath`, `dataToWatchlistItem`,
  `syncRunsCollection`/`dataToSyncRun`) and third-party packages (Ionic,
  AngularFire, `@capacitor/core`, `@capacitor/preferences`).
- Must not import: other slices (`slice:search` / `slice:watchlist` /
  `slice:title-detail`), `apps/mobile`, or any `scope:functions` code. The Plex
  sync engine writes watchlist/episode docs by PATH via the shared
  `firestore-schema` converters (data-level cross-slice communication, like 0061)
  — it never imports `slice:watchlist` / `slice:title-detail`, and the
  `s{SS}e{EEE}` episode-id logic is **replicated** locally rather than imported
  from the `scope:functions` `sync-episodes` lib. The `sync-runs` collection is a
  cross-scope persistence contract: `apps/functions` writes it, this slice only
  **reads** it — the two scopes share only the `scope:shared` data shape.
- The provider catalog is reached only through the `scope:shared`
  `GET_WATCH_PROVIDERS` token; the Plex client only through the `scope:shared`
  `PLEX_CLIENT` token (both provided by the shell) — so this slice never imports
  `@angular/fire/functions` and there is **no `scope:mobile` ↔ `scope:functions`
  edge** anywhere in the Plex sync path.
