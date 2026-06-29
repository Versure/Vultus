# shared-firestore-schema

`@vultus/shared/firestore-schema` — Firestore wire-type definitions, read/write
converters, and path helpers for Vultus. Bridges the persistence-agnostic domain
types (`@vultus/shared/domain`) to the Firestore wire format: ISO 8601 strings ↔
`Timestamp`, `Date` write coercion.

## Public surface (barrel exports)

### Data types (`./lib/data-types`)

Per-document read/write shapes for the Firestore wire boundary:

| Interface                     | Direction | Notes                                                              |
| ----------------------------- | --------- | ------------------------------------------------------------------ |
| `FirestoreTimestampLike`      | read      | Structural — satisfied by both SDK `Timestamp`s                    |
| `EpisodeReadData`             | read      | `title?: string \| null` (optional — pre-0034 docs lack the field) |
| `EpisodeWriteData`            | write     | `title: string \| null`                                            |
| `WatchlistItemReadData`       | read      |                                                                    |
| `WatchlistItemWriteData`      | write     |                                                                    |
| `UserReadData`                | read      |                                                                    |
| `UserWriteData`               | write     |                                                                    |
| `NotificationReadData`        | read      |                                                                    |
| `NotificationWriteData`       | write     |                                                                    |
| `TitleCacheReadData`          | read      |                                                                    |
| `TitleCacheWriteData`         | write     |                                                                    |
| `RegionAvailabilityReadData`  | read      |                                                                    |
| `RegionAvailabilityWriteData` | write     |                                                                    |

### Converters (`./lib/converters`)

Pure functions mapping domain types to/from their Firestore wire shapes:

- `episodeToData` / `dataToEpisode` — `EpisodeDoc` ↔ `EpisodeWriteData`/`EpisodeReadData`. `title` passes through; `?? null` default handles stored docs missing the field (backward-compat, spec 0034).
- `watchlistItemToData` / `dataToWatchlistItem`
- `userToData` / `dataToUser`
- `notificationToData` / `dataToNotification`
- `titleCacheToData` / `dataToTitleCache`
- `availabilityToData` / `dataToAvailability`

### Paths (`./lib/paths`)

Path-builder functions for every PLAN §4 Firestore path:

`userPath`, `watchlistPath`, `watchlistItemPath`, `episodesPath`, `episodePath`,
`notificationsPath`, `notificationPath`, `titleCachePath`, `titleCacheDocPath`,
`availabilityPath`, `availabilityDocPath`.

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
