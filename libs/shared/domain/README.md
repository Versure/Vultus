# shared-domain

`@vultus/shared/domain` — the cross-slice domain vocabulary for Vultus. Pure
TypeScript types plus `as const` literal arrays and cross-scope DI tokens. It
maps the Firestore data model from PLAN §4 one-to-one in a persistence-agnostic
way: **no Firebase import, no `Date`/`Timestamp`** — all timestamps are ISO 8601
strings. The ISO ↔ Firestore `Timestamp` mapping lives in
`@vultus/shared/firestore-schema`.

## Public surface (barrel exports)

The barrel (`src/index.ts`) re-exports:

- **`./lib/enums`** — union types and their `as const` source arrays:
  `Region`/`REGIONS`, `WatchStatus`/`WATCH_STATUSES`,
  `NotificationKind`/`NOTIFICATION_KINDS` (members: `episode-aired`,
  `movie-available`, `show-came-to-platform`, plus `movie-leaving-platform` /
  `show-leaving-platform` — a tracked movie/show losing all flatrate providers
  in the user's region, spec 0057), `TitleType`. Also
  `REGION_DISPLAY_NAMES: Record<Region, string>` and
  `regionDisplayName(region: Region): string` (spec 0079) — the human-readable
  native endonym for each region (`NL → Nederland`, `DE → Deutschland`,
  `GB → United Kingdom`, …), for display only. The persisted `region` field keeps
  the raw ISO code; the `Record<Region, string>` typing makes a future `REGIONS`
  addition a compile error until its display name is added. Also
  `AvailabilitySource` (`'tmdb' | 'watchmode'`) — which data source produced the
  current providers on an availability doc (spec 0099); provenance/diagnostics
  only, not a transition input.
- **`./lib/entities`** — non-document domain entities: `Title` (movie/tv
  discriminated union), `WatchProvider`, `CatalogProvider` (one provider in a
  region's TMDB watch-provider catalog — `providerId`, `name`, `logoPath`;
  narrower than `WatchProvider`, no per-title `type`, carries the TMDB logo path,
  spec 0060), `Episode` (fields: `season`, `episode`, `title` (nullable, spec
  0047), `airDate`).
- **`./lib/documents`** — Firestore document shapes (PLAN §4):
  - `User` (fields: `region`, `notificationPrefs`, `fcmTokens`, plus
    `myProviderIds: number[]` — the TMDB provider ids the user subscribes to;
    open `number[]` so a later manual provider (Plex, spec 0061) can be layered
    in without a migration; default `[]`, legacy docs missing it coalesce to `[]`
    via the converter, spec 0060 — and `hasPlex: boolean` — whether the user uses
    a self-hosted Plex server (spec 0061); a separate boolean, NOT a member of
    `myProviderIds` (Plex has no TMDB id); set `true` on Plex link (spec 0073);
    gates the per-title "watching via Plex" toggle; default `false`, legacy docs
    missing it coalesce to `false` via the converter — and `plexSync?:
PlexSyncMeta | null` — the per-user Plex sync cursor + link metadata (spec
    0073); OPTIONAL/nullable so legacy docs and never-linked users need no
    migration; absent/`null` = never linked or unlinked; coalesced `?? null` via
    the converter), `NotificationPrefs` (per-kind opt-in booleans `episodeAired` / `movieAvailable` / `cameToPlatform`, plus `movieLeavingPlatform` / `showLeavingPlatform` — the leaving-your-platform opt-ins, spec 0057; both required, default `true`, legacy docs missing them coalesce to `true` via the converter — plus `deliveryHour: number | null` — quiet-hours delivery preference, spec 0051; `null` = any time, a number 0–23 = that UTC hour), `FcmToken`
  - `PlexSyncMeta` — per-user Plex sync cursor + link metadata (spec 0073):
    `linkedAt` (ISO 8601 link time), `lastSyncAt: string | null` (ISO 8601 — the
    additions cursor; `null` until the first sync completes), `serverName: string
| null`, plus `unmatched?: PlexUnmatchedTitle[]` — the titles the most recent
    completed sync pass could not match to a TMDB id (spec 0097); capped at 50,
    replaced wholesale each pass (never appended), `[]` clears the UI; OPTIONAL
    so legacy/pre-0097 `plexSync` docs need no migration (absent = no
    diagnostics yet). The X-Plex-Token is NOT stored here — it lives on-device
    in `@capacitor/preferences`.
  - `PlexUnmatchedTitle` — one title a completed Plex sync pass could not match
    (spec 0097): `title` (display only) + `reason: 'no-guid' | 'guid-unresolved'
| 'error'`. Diagnostic output for the Settings "couldn't match" list, NOT a
    user preference.
  - `WatchlistItem` (fields: `type`, `tmdbId`, `traktId`, `title`, `addedAt`,
    `status`, `posterPath`/`voteAverage`/`releaseDate` (all nullable/optional),
    plus `nextUnwatchedEpisodeAirDate?: string | null` — the air date (ISO 8601,
    same format as `EpisodeDoc.airDate`) of the EARLIEST currently-unwatched
    episode of a TV show (spec 0081); `null` for movies, an empty episodes
    subcollection, or an all-watched show; denormalized (written server-side on
    sync by Cloud Functions and client-side after the user's own mark-watched
    actions); legacy docs missing it coalesce to `null` via the converter; never
    meaningfully set for movies — plus `watchingViaPlex: boolean` — a manual
    per-title override that the user watches THIS title via their Plex server,
    additive to and never replacing the TMDB availability framing (spec 0061,
    GitHub #140); default `false`, legacy docs missing it coalesce to `false` via
    the converter), `EpisodeDoc` (fields: `season`, `episode`, `title` (nullable, spec 0034), `airDate`, `watched`, `watchedAt`)
  - `NotificationDoc`, `NotificationPayload`
  - `SyncRun` — one completed sync-pipeline run (global `sync-runs/{runId}`); written by Cloud Functions, read by the settings slice (spec 0049)
  - `TitleCacheEntry` (fields: `type`, `traktId`, `metadata`, `lastSyncedAt`,
    plus `watchmodeId?: number | null` — the cached Watchmode title id resolved
    once from the TMDB id so subsequent daily syncs skip the id-resolution call,
    spec 0099; `null` = not resolved / no Watchmode match; optional, legacy docs
    missing it coalesce to `null` via the converter), `TitleMetadata`,
    `RegionAvailability` (fields: `providers`, `lastSyncedAt`, `previousSnapshot`,
    plus `source?: AvailabilitySource` — which source produced `providers` this
    pass, spec 0099; optional, legacy docs missing it coalesce to `'tmdb'` via the
    converter)
  - `ProviderCatalogDoc` — the global, function-written `provider-catalog/{region}` cache (`providers: CatalogProvider[]`, `lastSyncedAt` ISO 8601); mirrors `title-cache` as a shared, function-written cache (spec 0060)
- **`./lib/plex`** — protocol-agnostic Plex vocabulary (spec 0073). Pure
  structural types describing the PMS / plex.tv surface Vultus consumes, so both
  the real (CapacitorHttp) and mock client impls — and the `PLEX_CLIENT` token —
  are typed without importing the settings slice. **No CapacitorHttp/Capacitor/
  Firebase import** — shared owns the vocabulary, the slice owns the protocol.
  - `PlexPin` (`id`, `code` — 4-char link code, `authToken: string | null`),
    `PlexServer` (`name`, `baseUrl`, `accessToken`), `PlexLibraryItem` (`type`
    'movie' | 'tv', `tmdbId: number | null` — `tmdb://` GUID, `null` → try
    tvdb/imdb via TMDB `/find`; `tvdbId?: number | null` / `imdbId?: string |
null` — the `tvdb://` / `imdb://` GUID ids, optional/nullable, spec 0097;
    `title`, `addedAt: string | null` — ISO 8601, `null` when Plex reports none
    (spec 0097), `viewCount`, `lastViewedAt: string | null`, `ratingKey`),
    `PlexEpisodeItem` (`season`, `episode`, `viewCount`, `lastViewedAt`).
  - `PlexClient` — the interface both client impls implement: `requestPin`,
    `checkPin`, `discoverServer`, `listLibrary`, `listEpisodes`.
- **`./lib/tokens`** — cross-scope dependency-injection tokens. **Not re-exported
  from the main barrel** — import via the dedicated subpath
  `@vultus/shared/domain/tokens` (mobile-only; keeps `@angular/core` out of the
  Cloud Functions build).
  - `AUTH_UID` — `Signal<string | null>` provided by the shell; slices inject
    this instead of importing `apps/mobile`.
  - `TRIGGER_SYNC` — `() => Promise<{ syncedAt: string }>` thunk provided by the
    shell; slices call this to trigger a manual sync via `triggerSync` callable
    without importing `@angular/fire/functions` or `apps/mobile` (spec 0025).
  - `GET_WATCH_PROVIDERS` — `(region: Region) => Promise<CatalogProvider[]>`
    thunk provided by the shell; the settings slice calls this to fetch the
    region's TMDB watch-provider catalog via the `getWatchProviders` callable
    without importing `@angular/fire/functions` or `apps/mobile`; mirrors
    `TRIGGER_SYNC` (spec 0060).
  - `PLEX_CLIENT` — `PlexClient` provided by the shell (real CapacitorHttp on
    native; a deterministic mock on web/dev/e2e); the settings slice injects it
    without importing `apps/mobile` (spec 0073).
  - `PLEX_SYNC_TRIGGER` — `() => Promise<void>` thunk the shell calls on boot +
    resume to run one Plex sync (no-op when not linked / not native / already
    running); the shell wires it over the settings slice's `PlexSyncService`
    (spec 0073).
  - `PLEX_BACKGROUND_INIT` — `() => Promise<void>` thunk the shell calls once on
    boot to initialize periodic on-device background Plex sync (Android
    WorkManager via `@transistorsoft/capacitor-background-fetch`); a
    native-guarded no-op off native / when not linked. The shell wires it over
    the settings slice's `PlexBackgroundService`; mirrors `PLEX_SYNC_TRIGGER`
    (spec 0085).

`NotificationPayload` carries the data a notification renders from:
`tmdbId: number` (the TMDB id of the affected title), `titleId`, `title`,
`region`, and an optional `providerName` (present for availability/platform
kinds).

`src/lib/type-assertions.ts` is a compile-time-only type gate (representative
document literals + union exhaustiveness checks); it is intentionally **not**
re-exported from the barrel and has no runtime behavior.

## Usage

```ts
import type {
  NotificationDoc,
  NotificationPayload,
} from '@vultus/shared/domain';
import { REGIONS, type Region } from '@vultus/shared/domain';

const payload: NotificationPayload = {
  tmdbId: 1399,
  titleId: 'tmdb-1399',
  title: 'Game of Thrones',
  region: 'NL',
};
```

## Boundaries (Sheriff)

- **Scope:** `scope:shared` — importable by any slice (`scope:mobile`,
  `scope:functions`, and other `scope:shared` libs).
- Must stay free of Firebase, platform, and slice-specific imports so both the
  mobile app and Cloud Functions can depend on it.

## Running unit tests

Run `nx test shared-domain` to execute the unit tests via [Vitest](https://vitest.dev).
