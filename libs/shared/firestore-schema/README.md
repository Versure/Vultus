# shared-firestore-schema

`@vultus/shared/firestore-schema` — Firestore wire-type definitions, read/write
converters, and path helpers for Vultus. Bridges the persistence-agnostic domain
types (`@vultus/shared/domain`) to the Firestore wire format: ISO 8601 strings ↔
`Timestamp`, `Date` write coercion.

## Public surface (barrel exports)

### Data types (`./lib/data-types`)

Per-document read/write shapes for the Firestore wire boundary:

| Interface                     | Direction | Notes                                                                                                                                                                                              |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FirestoreTimestampLike`      | read      | Structural — satisfied by both SDK `Timestamp`s                                                                                                                                                    |
| `EpisodeReadData`             | read      | `title?: string \| null` (optional — pre-0034 docs lack the field)                                                                                                                                 |
| `EpisodeWriteData`            | write     | `title: string \| null`                                                                                                                                                                            |
| `WatchlistItemReadData`       | read      | `watchingViaPlex?: boolean` (optional — legacy docs pre-0061 lack it); `nextUnwatchedEpisodeAirDate?: string \| null` (plain ISO string, NOT a Timestamp; optional — legacy docs pre-0081 lack it) |
| `WatchlistItemWriteData`      | write     | `watchingViaPlex: boolean` (required); `nextUnwatchedEpisodeAirDate?: string \| null` (plain ISO string, NOT a Timestamp)                                                                          |
| `UserReadData`                | read      | `myProviderIds?: number[]` (pre-0060); `hasPlex?: boolean` (pre-0061); `plexSync?: PlexSyncMeta \| null` (pre-0073) optional                                                                       |
| `UserWriteData`               | write     | `myProviderIds: number[]`; `hasPlex: boolean` required; `plexSync?: PlexSyncMeta \| null` optional (coalesce supplies it)                                                                          |
| `NotificationReadData`        | read      |                                                                                                                                                                                                    |
| `NotificationWriteData`       | write     |                                                                                                                                                                                                    |
| `TitleCacheReadData`          | read      |                                                                                                                                                                                                    |
| `TitleCacheWriteData`         | write     |                                                                                                                                                                                                    |
| `SyncRunReadData`             | read      | `startedAt`/`completedAt` as `FirestoreTimestampLike`                                                                                                                                              |
| `SyncRunWriteData`            | write     | `startedAt`/`completedAt` as `Date`                                                                                                                                                                |
| `RegionAvailabilityReadData`  | read      |                                                                                                                                                                                                    |
| `RegionAvailabilityWriteData` | write     |                                                                                                                                                                                                    |
| `ProviderCatalogReadData`     | read      | `lastSyncedAt` as `FirestoreTimestampLike`; `providers` pass through (spec 0060)                                                                                                                   |
| `ProviderCatalogWriteData`    | write     | `lastSyncedAt` as `Date`                                                                                                                                                                           |

### Converters (`./lib/converters`)

Pure functions mapping domain types to/from their Firestore wire shapes:

- `episodeToData` / `dataToEpisode` — `EpisodeDoc` ↔ `EpisodeWriteData`/`EpisodeReadData`. `title` passes through; `?? null` default handles stored docs missing the field (backward-compat, spec 0034).
- `watchlistItemToData` / `dataToWatchlistItem` — `watchingViaPlex` passes through on write (`?? false`); `dataToWatchlistItem` coalesces a missing field to `false` (backward-compat, spec 0061). `nextUnwatchedEpisodeAirDate` is a plain ISO date string (no Timestamp mapping — like `releaseDate`): both directions coalesce `?? null`, so an absent source field writes `null` and a legacy doc missing the field reads back as `null` (backward-compat, spec 0081).
- `userToData` / `dataToUser` — `myProviderIds` passes through on write; `dataToUser` coalesces a missing field to `[]` (backward-compat, spec 0060). `hasPlex` passes through on write; `dataToUser` coalesces a missing field to `false` (backward-compat, spec 0061). `plexSync` is a plain nested object of ISO strings (no Timestamp mapping — passes through like `notificationPrefs`): `userToData` writes `user.plexSync ?? null`, `dataToUser` reads `data.plexSync ?? null` (a legacy doc lacking the field → `null`, backward-compat, spec 0073). The nested `plexSync.unmatched` diagnostics array (`PlexUnmatchedTitle[]`, spec 0097) rides through this same pass-through with **no converter change and no Timestamp mapping** — its `{ title, reason }` entries are plain strings/enums, so it round-trips unchanged; a legacy `plexSync` without `unmatched` stays absent (it is **not** coalesced to `null`/`[]`).
- `notificationToData` / `dataToNotification`
- `titleCacheToData` / `dataToTitleCache` — `watchmodeId` (the cached Watchmode title id, spec 0099) coalesces `?? null` in both directions: an unset domain field writes `null`, and a legacy doc missing the field reads back as `null` (backward-compat).
- `syncRunToData` / `dataToSyncRun` — `SyncRun` ↔ `SyncRunWriteData`/`SyncRunReadData`; only `startedAt`/`completedAt` cross the Timestamp boundary, all other fields pass through (spec 0049).
- `availabilityToData` / `dataToAvailability` — `source` (`AvailabilitySource`, which data source produced `providers` this pass, spec 0099) coalesces `?? 'tmdb'` in both directions: an unset domain field writes `'tmdb'`, and a legacy doc missing the field reads back as `'tmdb'` (legacy availability docs predate the field → they were TMDB-sourced).
- `providerCatalogToData` / `dataToProviderCatalog` — `ProviderCatalogDoc` ↔ `ProviderCatalogWriteData`/`ProviderCatalogReadData`; only `lastSyncedAt` crosses the Timestamp boundary, `providers` passes through (spec 0060).

### Paths (`./lib/paths`)

Path-builder functions for every PLAN §4 Firestore path:

`userPath`, `watchlistPath`, `watchlistItemPath`, `episodesPath`, `episodePath`,
`notificationsPath`, `notificationPath`, `titleCachePath`, `titleCacheDocPath`,
`availabilityPath`, `availabilityDocPath`, `syncRunsCollection`, `syncRunDocPath`,
`providerCatalogPath`, `providerCatalogDocPath` (`provider-catalog/{region}`, id = Region code; spec 0060).

## Usage

```ts
import {
  episodeToData,
  dataToEpisode,
  episodesPath,
  episodePath,
} from '@vultus/shared/firestore-schema';
import type { EpisodeReadData } from '@vultus/shared/firestore-schema';
```

## Boundaries (Sheriff)

- **Scope:** `scope:shared` — importable by any slice.
- No Firebase SDK import: the read side is structural (`FirestoreTimestampLike`),
  the write side uses plain `Date`. The SDK's own `Timestamp` satisfies the
  structural read type at the call site; this lib never constructs one.

## Running unit tests

Run `nx test shared-firestore-schema` to execute the unit tests via [Vitest](https://vitest.dev).
