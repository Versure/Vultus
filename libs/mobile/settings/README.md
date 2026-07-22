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
- `PlexBackgroundService` (spec 0085) — **`providedIn: 'root'`** singleton for
  periodic on-device background Plex sync (Android WorkManager via
  `@transistorsoft/capacitor-background-fetch`). Exported so the shell's
  `app.config.ts` can wire `PLEX_BACKGROUND_INIT` over `PlexBackgroundService.init()`
  from the ROOT injector. **Do NOT list it in `SETTINGS_PROVIDERS`** (page-scoping
  would fork it from the boot/link trigger). See the dedicated section below.
- `CapacitorHttpPlexClient`, `MockPlexClient` (spec 0073) — the two `PlexClient`
  impls, exported so the shell's `PLEX_CLIENT` factory selects between them
  (`Capacitor.isNativePlatform()` → real, else mock). There is **no
  `PLEX_PROVIDERS`** export and **no `plex.providers.ts`** — the shell factory is
  the single client selector.
- `PlexSyncSummary` (type) — the `{ added, updated, skipped, unmatched }` outcome
  of a sync (`unmatched` added in spec 0097 = titles that couldn't be resolved to
  a TMDB id this pass).
- `SETTINGS_TMDB_CONFIG` (token, spec 0086) — an
  `InjectionToken<TmdbDetailConfig>` the shell's `app.config.ts` wires from
  `environment.tmdb` (the same value `TMDB_SEARCH_CONFIG` / `TMDB_DETAIL_CONFIG`
  receive). It configures the slice-local TMDB detail client `PlexSyncService`
  uses to fetch `posterPath` / `voteAverage`. Named `SETTINGS_TMDB_CONFIG` (not
  `TMDB_DETAIL_CONFIG`) to avoid a symbol collision with the title-detail
  slice's token already imported into the shell.
- `TmdbDetailConfig` (type, spec 0086) — the config shape the token carries
  (`apiBaseUrl`, `imageBaseUrl`, `auth`, optional `fetchImpl`).

The TMDB detail client itself (`createTmdbDetailClient`, `TmdbDetailClient`,
`TmdbDetail`, `TmdbDetailError` in `tmdb-detail.client.ts`) is
**slice-internal** — not barrel-exported. It is a **deliberate per-slice
duplicate** of the search / title-detail clients (spec 0016 decision 2,
reaffirmed by spec 0086); the settings slice must not import
`@vultus/mobile/search` or `@vultus/mobile/title-detail`.

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
  an IPv6-only LAN still exposes a `local` connection. For the chosen local
  connection (`pickLocalConnection`, IPv4-preferred) it builds the base URL as a
  **raw-IP `http://<address>:<port>`** from the connection's fields
  (`localBaseUrl`), **discarding** Plex's reported `uri`: with `includeHttps=1`
  that local `uri` is a `*.plex.direct` HTTPS hostname whose public DNS resolves
  the LAN IP, which **DNS-rebind-protected routers** (e.g. a FritzBox) refuse to
  answer ("Unable to resolve host ….plex.direct") — so the raw IP is used to skip
  DNS entirely (issue #171). Reaching the raw-IP URL needs **cleartext-to-LAN**,
  enabled by `android/app/src/main/res/xml/network_security_config.xml`
  (base-config `cleartextTrafficPermitted`, wired via the manifest's
  `networkSecurityConfig`); all other traffic (Firebase / TMDB / plex.tv) stays
  HTTPS. This assumes the PMS serves plain HTTP on the LAN (Plex default); with
  "Secure connections: Required" it does not, and that network must instead
  whitelist `plex.direct` in the router's DNS-rebind config. The library listing
  (`/library/sections/{id}/all`) is fetched with **`includeGuids=1`** — WITHOUT
  it Plex omits the external `Guid[]` (`tmdb://`) and every `tmdbId` parses as
  `null`, so every item is skipped and nothing ever syncs (the original
  episodes-not-marked bug); `externalIdsFromGuids` parses `tmdb://`, `tvdb://`
  (spec 0097) and `imdb://` ids (plus the legacy `themoviedb://<id>` agent GUID
  for TMDB) — a `tvdb`/`imdb`-only item has `tmdbId: null` and is resolved by
  `PlexSyncService` via the TMDB `/find` external-id fallback. A missing `addedAt`
  maps to `null` (spec 0097 — NO epoch-0 fallback, which used to make an unwatched
  addition skip-forever), and pagination keeps going when PMS omits `totalSize`
  (until a short/empty page) instead of stopping after page 1. Every native call
  carries a connect/read
  **timeout** so a stale/black-holed local connection URI can't hang the request
  and wedge the sync's `running` guard.
- `MockPlexClient` — deterministic fixtures (pin auto-authorizes; a small library
  with a watched tmdb-GUID movie, a planned tmdb-GUID movie, a partially-watched
  tmdb-GUID show, a **tvdb-only** show — `tmdbId: null`, `tvdbId` set — to exercise
  the spec 0097 `/find` fallback, and one fully GUID-less item → a `no-guid`
  unmatched entry; a two-episode show with the first watched). Selected for every
  non-native surface (web / dev / e2e / serve-mock).

### `PlexLinkService` (`providedIn: 'root'`)

Owns the plex.tv PIN-link state machine, on-device token persistence, server
discovery, and the `hasPlex` / `plexSync` Firestore link metadata. Surface:

- signals `stage` (`idle`|`code`|`waiting`|`connected`|`error`), `errorReason`
  (`expired`|`no-server`|`network`|`null`), `code`, `server`, `expiresInSeconds`,
  `countdown` (mm:ss), plus the settings-card state `linked`, `serverName`,
  `lastSyncAt`, and `unmatched` (spec 0097 — the `PlexUnmatchedTitle[]` read from
  `plexSync.unmatched`, `[]` when clean; reset on `unlink()` AND on `loadState()`'s
  half-linked self-heal branch so a self-healed device shows no stale diagnostics);
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
~15-minute PIN TTL deadline is owned locally at code issue. Every swallowed
link/sync failure logs a **redacted diagnostic** via `describePlexError`
(`plex-errors.ts`) to `console.error` (issue #171) — the HTTP status + endpoint
path, or a transport error's `name`/`message`, **never** the error object or any
header (the X-Plex-Token rides in a header, never the URL/message), so the real
cause is visible in logcat without leaking the token.

**Unlink** clears the Preferences token + `plexSync` (`deleteField()`), KEEPS
`hasPlex` + all synced data, and touches no watchlist/episode doc.

### `PlexSyncService` (`providedIn: 'root'`)

`sync()` runs one-way import: an **additions** pass (cursor-gated on
`plexSync.lastSyncAt ?? linkedAt`) + a **watched-mirror** pass (full mirror for
matched titles), then advances `plexSync.lastSyncAt`. `running` (signal) drives
the "Sync now" spinner/disabled state.

`sync()` returns a discriminated **`PlexSyncResult`** and **never throws** — so
the caller can give real feedback (the settings page toasts it; the boot/resume
trigger ignores it): `ok` (with the `{ added, updated, skipped, unmatched }`
summary), `skipped` with a reason (`busy` = a sync already running, `not-linked` =
uid null or no Preferences token, `no-server` = discovery found none), or `error`
(a plex.tv/PMS/Firestore call threw — network / HTTP / timeout). Previously it
returned only a summary and swallowed every failure, so a silent skip and a hard
failure were indistinguishable and the "Sync now" button gave no feedback. The
cursor (`plexSync.lastSyncAt`) advances whenever the library pass runs to
**completion** (spec 0097 — with per-item isolation, item errors no longer abort
the pass, so a completed-with-errors pass still advances the cursor).

Key invariants:

- **GUID matching + TMDB `/find` fallback (spec 0097)**: `tmdb://603` → tmdbId
  603 (used directly). An item with NO `tmdb://` id but a `tvdb://`/`imdb://` id
  is resolved deterministically **ID→ID** via TMDB `GET /find/{id}
?external_source=tvdb_id|imdb_id` (tvdb preferred for shows; the `/find` result
  must be of the MATCHING media type — `tv_results` for shows, `movie_results`
  for movies). This is NOT fuzzy title matching (0073's rule stands). An item that
  still can't be resolved is recorded in the pass's `unmatched` list with a reason
  — `no-guid` (no tmdb/tvdb/imdb id at all), `guid-unresolved` (had a tvdb/imdb id
  but `/find` returned no matching-type result — INCLUDING a movie carrying only a
  tvdb id, which is show-only), or `error` (a `/find` call threw) — never
  fuzzy-matched, no write. `findExternalIdSafe` mirrors `fetchDetailSafe`: a thrown
  `/find` is caught and counted `error`, distinct from a resolved `null`
  (`guid-unresolved`).
- **Per-item error isolation (spec 0097)**: each item's processing is wrapped in
  try/catch; a single failing item (e.g. a `listEpisodes` 404) is recorded reason
  `error` and the loop continues — it no longer aborts every later item.
- **Unmatched-titles diagnostics (spec 0097)**: on pass completion the engine
  persists `plexSync.unmatched` (capped 50 via `slice(0, 50)`, REPLACED wholesale
  each pass — `[]` when the pass matched everything) alongside
  `plexSync.lastSyncAt` in the single `updateDoc`. `PlexLinkService.loadState()`
  reads it into the `unmatched` signal; the Settings connected card renders a
  "Couldn't match N titles" list from it. `summary.unmatched` = the count pushed
  this pass; `skipped` keeps its 0073/0086 meaning (old-cursor unwatched +
  sticky-dropped).
- **Missing `addedAt` (spec 0097)**: a missing Plex `addedAt` (client returns
  `null`) is treated as **new** for the cursor comparison (admitted as a `planned`
  addition), not epoch-0/skip-forever.
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

**Poster / rating denormalization (spec 0086, issue #229).** Plex GUIDs yield
only a `tmdbId`, so the sync fetches `posterPath` / `voteAverage` from TMDB via
the slice-local detail client (`createTmdbDetailClient`, configured by
`SETTINGS_TMDB_CONFIG`) and denormalizes them onto the watchlist doc — matching
the search / title-detail add paths (spec 0035). On a **new add**, `addItem`
fetches the detail before the `setDoc`. On an **already-tracked** item whose
stored `posterPath` is still `null`, the sync **self-heals**: it fetches TMDB
and `updateDoc`s `posterPath` / `voteAverage`. The backfill runs
**unconditionally of status** — a sticky-`dropped` item still gets its poster
(display enrichment, not a status change) — and is **skipped** when
`posterPath` is already non-null (strict `=== null` guard, never a falsy check,
so an empty-string path is not treated as absent). Every TMDB call is wrapped
per-item in try/catch (`describeTmdbError`, `plex-errors.ts`): a TMDB failure is
non-fatal (poster stays `null`, the item self-heals next sync) and never fails
the surrounding status write or the rest of the sync loop, and never marks the
pass `error`. A pure poster backfill is NOT counted as an `updated` status
change. The client performs NO Firestore access and never reads/writes
`title-cache`.

The X-Plex-Token is stored ONLY in `@capacitor/preferences`, NEVER written to any
Firestore path, and NEVER logged/echoed (CLAUDE.md secrets rule).

### `PlexBackgroundService` (`providedIn: 'root'`, spec 0085)

Adds the periodic **background** trigger missing from 0073 (which fires only on
boot, foreground resume, and manual "Sync now"). Because the PMS lives on the
user's LAN, the only place a periodic sync can run is on the phone while on the
home Wi-Fi — so the OS (Android WorkManager, via the community
`@transistorsoft/capacitor-background-fetch` plugin) wakes the app's JS on the
user's interval and the plugin's `onFetch` callback reruns the **existing**
`PlexSyncService.sync()`. **No sync logic is reimplemented** — this is purely a
new trigger. **Android-only**; on iOS/web every plugin call is a native-guarded
no-op.

Public surface:

- signals `enabled: Signal<boolean>` (default `true`) and
  `intervalMinutes: Signal<number>` (default `60`), mirroring the device-local
  config persisted in `@capacitor/preferences` (keys `plex_bg_enabled` /
  `plex_bg_interval_min` — **not** Firestore; background execution is inherently
  per-device);
- `init()` — boot/link init: native-guard FIRST (off-native returns, so the
  signals stay at defaults), then load the config and `BackgroundFetch.configure`
  (`minimumFetchInterval` = interval; `NETWORK_TYPE_UNMETERED`; battery-not-low;
  no charging requirement; `stopOnTerminate:false`, `startOnBoot:true`,
  `enableHeadless:true`) + register `onFetch`/`onTimeout`. If disabled, stops the
  plugin so nothing schedules;
- `setEnabled(enabled)` / `setIntervalMinutes(min)` — persist the key
  **unconditionally**, then (native only) reconfigure/start or stop. Interval
  options are `[15, 30, 60, 180, 360]` minutes; any value `< 15` is clamped to 15
  (the WorkManager floor);
- `stop()` — clear both bg Preferences keys **unconditionally**, then (native
  only) `BackgroundFetch.stop()`.

**`onFetch` gating:** runs `sync()` only when `enabled()` AND the device is linked
(a non-empty `plex_token` in Preferences); `sync()` failures are swallowed (fail
quietly, reusing 0073's handling — no new error UI); the task is **always**
finished in a `finally`.

**Circular-DI avoidance (hard rule):** `PlexBackgroundService` **MUST NOT** inject
`PlexLinkService` — the dependency is one-directional (`PlexLinkService →
PlexBackgroundService`). It reads the on-device token key **directly** (importing
the exported `PLEX_TOKEN_KEY`) for the linked check; a back-injection would cycle
(`NG0200`, both being `providedIn: 'root'`). Only the token's **presence** is
tested — the VALUE is never logged or exposed (CLAUDE.md secrets).

**Reliability envelope (do NOT over-promise):** reliable while the app is
alive/backgrounded and when Android relaunches the app in the background for a
task. The fully-terminated / swiped-away path is **best-effort only** (a headless
finishing stub in the shell's `main.ts`); meaningful terminated-state sync is
on-device-verify-only.

**Lifecycle integration:**

- `PlexLinkService.unlink()` calls `PlexBackgroundService.stop()` — disconnecting
  stops the scheduled task and clears the bg config.
- `PlexConnectPage.done()` (on successful link) calls `PlexBackgroundService.init()`
  (fire-and-forget) so a freshly-linked device schedules its periodic task
  immediately (default ON) without waiting for the next boot.
- The Settings connected Plex card renders a "Sync in background" toggle + a "Sync
  frequency" interval `ion-select` (see the card section below).

### Plex Server card (in `SettingsPage`)

Between "My Providers" and the Notification cards (spec 0073 §6A). Gated on
`plexLink.linked()`: a disconnected "Connect Plex Server" nav row →
`/tabs/settings/plex`; or a connected block with the server name, an emerald
"Connected" dot, "Last synced — {relative}" (or "Not synced yet"), a "Sync now"
text button (disabled + "Syncing…" while `plexSync.running()`), and a
"Disconnect" text button (confirm alert → `unlink()`). The logo tile uses a
`--vultus-*` surface token; the Plex brand colour lives only in
`/assets/plex-logo.svg`.

The connected block also carries an **unmatched-titles list** (spec 0097), placed
after the background-sync controls and before the Disconnect footer, gated on
`@if (plexLink.unmatched().length > 0)` (hidden when empty). It is a
static/non-interactive `<ul>`: a muted heading (reusing `settings-row__helper`)
reading "Couldn't match N titles" (singular "Couldn't match 1 title"), then one
row per entry — the Plex `title` (body-md, ellipsized) + a trailing reason label
(label-sm, `--vultus-on-surface-variant`) mapping `no-guid` → "Not identified",
`guid-unresolved` → "No TMDB match", `error` → "Sync error". Tokens only, no new
hex. The "Sync now" completion toast also appends an "N couldn't be matched" count
when `summary.unmatched > 0`.

The connected block also carries the background-sync controls (spec 0085),
between the sync-row and the footer: a "Sync in background" `ion-toggle` bound to
`plexBackground.enabled()` (→ `setEnabled`) and a "Sync frequency" `ion-select`
bound to `plexBackground.intervalMinutes()` (→ `setIntervalMinutes`, disabled when
the toggle is off), reusing the tokenized `settings-row*` classes (no new colours).
`PlexBackgroundService` is the ROOT singleton (not a page-scoped mock), so on
`serve-mock` (off-native) `init()` no-ops before loading Preferences and the
controls render their DEFAULT values (enabled ON / "Every hour").

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
movieAvailable: true, cameToPlatform: true, movieLeavingPlatform: true,
showLeavingPlatform: true, deliveryHour: null }, fcmTokens: [], myProviderIds:
[], hasPlex: false }`, guaranteeing downstream slices can assume it exists.

The page exposes:

- a **Region** `ion-select` over the shared `REGIONS` list, writing
  `users/{uid}.region` on change. Each option's visible **label** is the region's
  human-readable native endonym (`regionDisplayName` from `@vultus/shared/domain`,
  e.g. `NL → Nederland`, spec 0079) while its `[value]` — the code persisted to
  `users/{uid}.region` — stays the raw ISO `Region` code. The substitution is
  presentation-only; no value use of `region` changes;
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
- two **leaving-platform** `ion-toggle` rows (spec 0057) — "Movie leaving your
  platform" and "Show leaving your platform", the per-kind opt-ins over
  `notificationPrefs.movieLeavingPlatform` / `showLeavingPlatform` (both default
  `true`; legacy docs missing them read as `true` via the converter). They are
  **independent per-kind rows**, NOT folded into the global Notifications
  projection, and stay enabled regardless of the global toggle. Each row reuses
  the Notifications row's `.settings-card` / `.settings-row*` silhouette
  (film / tv icon tile → `body-lg` label → `body-md` helper); changing one calls
  `SettingsService.setMovieLeavingPlatform` / `setShowLeavingPlatform` (wired via
  the page's `onMovieLeavingPlatformChange` / `onShowLeavingPlatformChange`
  handlers). Grouped with the Notifications and Notification-time cards. Stitch
  screen `projects/13590348714018893783/screens/81945ff3381e453dafcc4e5ce896fcfa`.
- a **My Providers** card (spec 0060) — a wrapping grid of tappable provider
  chips (a `<button>` per catalog entry, `aria-pressed`, NOT an
  `ion-segment`/`ion-select`) placed **between** the Region and Notifications
  cards. Each chip shows the provider logo + name; a **selected** chip (its id
  in `myProviderIds`) gets a primary border + `checkmark-circle` badge + full
  opacity, an **unselected** one an outline-variant border at 60% opacity.
  Tapping a chip persists the toggled `users/{uid}.myProviderIds` array. A footer
  reads "N of M selected · Region: {region}", where the region is shown by its
  display-name endonym (`regionDisplayName`, spec 0079 — e.g. `Nederland`) while
  the persisted value stays the raw ISO code. While the catalog is fetching, a
  spinner renders in place of the chips (never an empty card). The grid's LAST
  chip is the **Plex** chip (spec 0061 — see below); it is NOT a catalog entry.
  Stitch reference:
  `projects/13590348714018893783/screens/cebdfd02c7d44023b0e0019dd4907d48`
  ("Settings - My Providers - Vultus").
  - **Collapsible (spec 0075 #166).** The card header is a tappable disclosure
    `<button>` (`aria-expanded`, rotating `chevron-down-outline`); the chip grid
    is **collapsed by default** and gated out of the DOM (`@if`) until expanded.
    The expand state is an **in-memory, ephemeral** `providersExpanded` signal on
    the page — it resets to collapsed on every visit and is **not persisted**
    (no localStorage / Preferences / Firestore). The **footer count is visible
    in both states** (collapsed and expanded), gated only by `!catalogLoading()`.
    Collapsed screen: `projects/13590348714018893783/screens/7daf6b0bf7d44447bae3217b36dbcb49`.
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
  current region. **In-flight guard (spec 0075 #165 B1):** the region is claimed
  synchronously (into `loadedCatalogRegion`) **before** the `await`, so a
  concurrent same-region caller short-circuits instead of double-fetching; on a
  fetch **failure** the claim is reset to `null` and the error re-thrown, so a
  failed fetch stays retryable and `setRegion` still skips its prune;
- **Load-on-entry (spec 0075 #165).** `load()` chains
  `void this.loadProviderCatalog()` at the end of its success branch (after the
  region resolves), so the catalog loads on the **first** Settings visit — the
  footer reads "N of M" (never "N of 0") **without** a region switch. The page's
  `ngOnInit` no longer calls `loadProviderCatalog()` eagerly (that raced the
  not-yet-resolved `null` region and never fetched);
- `toggleProvider(id)` adds/removes one id and persists the WHOLE array;
- `setRegion(region)` performs **two sequential** `users/{uid}` writes — first
  the region, then (once the new region's catalog loads) the pruned
  `myProviderIds` (ids not in the new catalog are dropped). It reports the dropped
  count via `lastPrunedCount`; the page reacts to a `>0` value to raise a
  `ToastController` toast that names the region by its display-name endonym
  (`regionDisplayName`, spec 0079), not the raw ISO code. **Guard:** if the new
  catalog fails to load, the prune
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

### Preserve-other-prefs write rule (spec 0051 / 0057)

`notificationPrefs` now has **six** fields (`episodeAired`, `movieAvailable`,
`cameToPlatform`, `movieLeavingPlatform`, `showLeavingPlatform`, `deliveryHour`).
The service tracks the full object in `_prefs` state so **every** setter rebuilds
and writes the WHOLE `notificationPrefs` object, preserving the other setters'
data — no setter clobbers another's fields:

- `setNotificationsEnabled(enabled)` sets the three original booleans to
  `enabled` while preserving the current `deliveryHour` **and** the two
  leaving-platform opt-ins. The global toggle is a projection over the three
  original booleans only; the two leaving-platform prefs are carried through
  unchanged, never reset (spec 0057).
- `setDeliveryHour(hour)` sets `deliveryHour` (a number 0–23, or `null` for "Any
  time") while preserving the three original booleans **and** the two
  leaving-platform opt-ins.
- `setMovieLeavingPlatform(enabled)` / `setShowLeavingPlatform(enabled)`
  (spec 0057) each set their one field while preserving the three original
  booleans, `deliveryHour`, and the sibling leaving-platform pref. Null-uid
  guarded.

No setter touches `fcmTokens`. The eager-create default writes
`movieLeavingPlatform: true, showLeavingPlatform: true, deliveryHour: null`.

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
