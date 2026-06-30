# sync-episodes (`@vultus/functions/sync-episodes`)

The pure, Firebase-free episode-upsert engine (spec 0047). Given a TMDB show id
it fetches every season's episodes, diffs them against the episodes already in a
user's `users/{uid}/watchlist/{titleId}/episodes` subcollection, and inserts
**only the missing ones**. It is the core logic behind two entry points wired in
`apps/functions`:

- **Entry point A — on-add trigger** (`syncWatchlistEpisodes`): a Firestore
  `onDocumentCreated` on `users/{uid}/watchlist/{titleId}` calls `syncOne` so a
  newly tracked show is backfilled immediately.
- **Entry point B — daily-sync extension** (`runSync` in `main.ts`): after the
  title-cache pass, `syncAll` walks every TV show on every watchlist and upserts
  new episodes, isolating per-show errors.

## Public surface (barrel)

- `createEpisodeSyncEngine(config)` → `EpisodeSyncEngine` with
  `syncOne(uid, titleId, tmdbId)` and `syncAll()`.
- `EpisodeSyncEngine`, `EpisodeSyncConfig`, `EpisodeUpsertResult` — contract
  types.
- `episodeId(season, episode)` / `newEpisodeDoc(ep)` — id + doc helpers.
- Ports: `TmdbEpisodeSource`, `EpisodeStore`, `WatchlistTvSource`,
  `WatchlistTvShow`, `WatchlistDocRef`.

## Usage

```ts
import { createEpisodeSyncEngine } from '@vultus/functions/sync-episodes';

const engine = createEpisodeSyncEngine({ tmdb, episodes, watchlist });
const result = await engine.syncOne(uid, titleId, tmdbId); // entry point A
const results = await engine.syncAll(); // entry point B (needs `watchlist`)
```

`tmdb`, `episodes`, and `watchlist` are **ports** — the lib never imports the
Firebase SDK or the sync-titles `TmdbClient`. Their concrete adapters
(`createTmdbEpisodeSourceAdapter`, `createEpisodeUpsertStore`,
`createWatchlistTvSourceAdapter`) live in `apps/functions/src/sync-episodes.ts`,
the only place where the Admin SDK and `@vultus/functions/sync-titles` enter.

## Behavior contract

- **Episode id format `s${SS}e${EEE}`** — season padded to 2 digits, episode to
  3 (e.g. `s01e001`). Padding is a floor: larger numbers keep their full digits
  (`s10e100`). The id is the Firestore doc id, which makes both the merge diff
  and a re-sync idempotent.
- **Insert-only / never overwrite.** The engine reads existing episode ids and
  filters the fetched set down to ids not yet present, so `writeEpisodes` only
  ever receives new docs. A user's `watched` / `watchedAt` state is never
  disturbed by a sync.
- **TV-only.** Movies have no episodes; the on-add trigger no-ops on a
  `type: 'movie'` doc and the daily source only lists `type: 'tv'` shows. The
  engine itself is type-agnostic — TV filtering happens in the adapters/trigger.
- **`airDate` null-skip (Data-model option (b), spec 0047).** `Episode.airDate`
  is a required string; the upstream TMDB mapper drops any episode with a
  null/missing air date, so such episodes are never produced and therefore never
  inserted. The engine does not special-case them.
- **404 → skip, not error.** `getSeasonCount` returning `null` (show not in
  TMDB) yields `{ outcome: 'skipped' }`; a `null` from `getSeasonEpisodes`
  silently drops that one season but the rest of the show still upserts.
- **Per-show error isolation in `syncAll`.** A thrown error for one show is
  captured as `{ outcome: 'error', reason }`; `syncAll` never rejects.

## Sheriff boundaries

- Tags: `scope:functions`, `slice:sync-episodes` (resolved by the path glob
  `libs/functions/<slice>/src`; `project.json` keeps `"tags": []`).
- Imports `@vultus/shared/domain` only. **Must not** import
  `@vultus/functions/sync-titles` (`slice:sync-titles`), `@vultus/functions/*`
  siblings, `scope:mobile`, or any Firebase SDK — those wires live exclusively in
  `apps/functions`.
