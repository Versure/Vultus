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
  `NotificationKind`/`NOTIFICATION_KINDS`, `TitleType`.
- **`./lib/entities`** — non-document domain entities: `Title` (movie/tv
  discriminated union), `WatchProvider`, `Episode` (fields: `season`, `episode`,
  `title` (nullable, spec 0047), `airDate`).
- **`./lib/documents`** — Firestore document shapes (PLAN §4):
  - `User`, `NotificationPrefs` (per-kind opt-in toggles plus `deliveryHour: number | null` — quiet-hours delivery preference, spec 0051; `null` = any time, a number 0–23 = that UTC hour), `FcmToken`
  - `WatchlistItem`, `EpisodeDoc` (fields: `season`, `episode`, `title` (nullable, spec 0034), `airDate`, `watched`, `watchedAt`)
  - `NotificationDoc`, `NotificationPayload`
  - `SyncRun` — one completed sync-pipeline run (global `sync-runs/{runId}`); written by Cloud Functions, read by the settings slice (spec 0049)
  - `TitleCacheEntry`, `TitleMetadata`, `RegionAvailability`
- **`./lib/tokens`** — cross-scope dependency-injection tokens. **Not re-exported
  from the main barrel** — import via the dedicated subpath
  `@vultus/shared/domain/tokens` (mobile-only; keeps `@angular/core` out of the
  Cloud Functions build).
  - `AUTH_UID` — `Signal<string | null>` provided by the shell; slices inject
    this instead of importing `apps/mobile`.
  - `TRIGGER_SYNC` — `() => Promise<{ syncedAt: string }>` thunk provided by the
    shell; slices call this to trigger a manual sync via `triggerSync` callable
    without importing `@angular/fire/functions` or `apps/mobile` (spec 0025).

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
