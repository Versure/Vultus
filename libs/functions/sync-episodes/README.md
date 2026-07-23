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
  new episodes, isolating per-show errors. _(Legacy per-user path — being
  superseded by the sharded cache/fan-out model below; retained until the workers
  wire the new engine.)_
- **Entry point B' — sharded cache + fan-out** (spec 0101): the daily pass is
  split so TMDB is hit **at most once per distinct show per night**.
  `episodeCacheWorker` calls `cacheShowEpisodes(tmdbId)` to fetch each show's
  seasons ONCE and upsert them into the global
  `title-cache/{tmdbId}/episodes` cache; `episodeFanoutWorker` then calls
  `fanoutUserEpisodes(uid, titleId, tmdbId)` to write the per-user episode docs
  **from the cache with zero TMDB calls**.

### Cache-backed fetch-once / fan-out model (spec 0101)

`createEpisodeCacheEngine(config)` returns two operations that together replace
the O(users × shows) TMDB cost of the old per-user `syncAll`:

- **`cacheShowEpisodes(tmdbId)`** — fetch the show's seasons ONCE via the
  `tmdb` port (`getSeasonCount` + `getSeasonEpisodes` per season, same per-season
  loop + null-season tolerance as the on-add engine), skip null-air-date episodes
  (spec 0047), and upsert them into the shared cache via the
  `TitleCacheEpisodeStore` port, keyed by `episodeId(season, episode)`
  (`s{SS}e{EEE}`). **Idempotent** — a re-run upserts the same doc ids. Stores
  ONLY TMDB facts (no per-user `watched`/`watchedAt`).
- **`fanoutUserEpisodes(uid, titleId, tmdbId)`** — read the show's episodes from
  the cache (`TitleCacheEpisodeStore.getCachedEpisodes`, **zero TMDB calls**),
  then do the exact per-user work the on-add engine does after fetching:
  insert-only per-user episode docs, the spec-0074 `completed→watching` revert,
  and the spec-0081 `nextUnwatchedEpisodeAirDate` recompute. The insert-only
  diff + both post-write steps are shared with `createEpisodeSyncEngine` via
  `engine/episode-write-helpers.ts`, so fan-out behaves identically to the
  per-user path and **entry point A's behavior is unchanged**.

The config carries `cache` (required by both), `tmdb` (only `cacheShowEpisodes`
needs it), `episodes` (only `fanoutUserEpisodes` needs it), and the optional
`watchlistStatus` / `nextWatchable` ports — so a cache-only worker or a
fan-out-only worker constructs the engine with just the ports it uses (calling
the other operation without its port throws, like `syncAll` without `watchlist`).

## Public surface (barrel)

- `createEpisodeSyncEngine(config)` → `EpisodeSyncEngine` with
  `syncOne(uid, titleId, tmdbId)` and `syncAll()`.
- `createEpisodeCacheEngine(config)` → `EpisodeCacheEngine` with
  `cacheShowEpisodes(tmdbId)` and `fanoutUserEpisodes(uid, titleId, tmdbId)`
  (spec 0101, cache-backed fetch-once / fan-out — see below).
- `EpisodeSyncEngine`, `EpisodeSyncConfig`, `EpisodeUpsertResult` — contract
  types. `EpisodeSyncConfig` carries an optional `watchlistStatus` port (spec 0074) and an optional `nextWatchable` port (spec 0081); `EpisodeUpsertResult`
  carries an optional `statusRevertedToWatching` flag (spec 0074).
- `EpisodeCacheEngine`, `EpisodeCacheEngineConfig`, `CacheShowResult` — cache/
  fan-out contract types (spec 0101). `fanoutUserEpisodes` returns the same
  `EpisodeUpsertResult` shape as the on-add engine (`seasonsFetched: 0`, since
  fan-out makes no TMDB call).
- `episodeId(season, episode)` / `newEpisodeDoc(ep)` — id + doc helpers.
- Ports: `TmdbEpisodeSource`, `EpisodeStore`, `TitleCacheEpisodeStore`,
  `WatchlistTvSource`, `WatchlistTvShow`, `WatchlistDocRef`,
  `WatchlistStatusStore`, `WatchlistNextWatchableStore`.

## Usage

```ts
import {
  createEpisodeSyncEngine,
  createEpisodeCacheEngine,
} from '@vultus/functions/sync-episodes';

// Entry point A (on-add trigger) / legacy entry B (per-user daily pass):
const engine = createEpisodeSyncEngine({ tmdb, episodes, watchlist });
const result = await engine.syncOne(uid, titleId, tmdbId); // entry point A
const results = await engine.syncAll(); // legacy entry B (needs `watchlist`)

// Sharded daily pass (spec 0101), split across two workers:
const cacheEngine = createEpisodeCacheEngine({ tmdb, cache }); // episodeCacheWorker
await cacheEngine.cacheShowEpisodes(tmdbId); // fetch TMDB once → global cache

const fanoutEngine = createEpisodeCacheEngine({
  cache,
  episodes,
  watchlistStatus,
  nextWatchable,
}); // episodeFanoutWorker
await fanoutEngine.fanoutUserEpisodes(uid, titleId, tmdbId); // zero TMDB
```

`tmdb`, `episodes`, `cache`, and `watchlist` are **ports** — the lib never
imports the Firebase SDK or the sync-titles `TmdbClient`. Their concrete
adapters (`createTmdbEpisodeSourceAdapter`, `createEpisodeUpsertStore`,
`createWatchlistTvSourceAdapter`, and the spec-0101 `TitleCacheEpisodeStore`
Admin-SDK adapter over `titleCacheEpisodesPath`) live in
`apps/functions/src/sync-episodes.ts`, the only place where the Admin SDK and
`@vultus/functions/sync-titles` enter.

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
- **Completed → Watching source-of-truth revert (spec 0074).** The optional
  `watchlistStatus` port (`WatchlistStatusStore`, backed by the Admin SDK in
  `apps/functions`) lets the engine fix a stale `'completed'` status at the
  source. In `syncOne`, **after** `writeEpisodes`, when **≥1 new episode was
  inserted this run** (`toWrite.length > 0`) **and** the port is present **and**
  the show's current status is `'completed'`, the engine calls
  `setStatus(uid, titleId, 'watching')` and sets
  `statusRevertedToWatching: true` on the `'synced'` result. This is a
  **separate watchlist-doc write** — episode docs are never touched, so the
  insert-only invariant above still holds. It fixes every surface (Watchlist
  tab, detail page, notifications) without the user re-opening the detail page.
  - **Entry point A (on-add trigger) omits the port by design.** A freshly-added
    show never needs a completed→watching revert, so the on-add trigger wires
    only `tmdb` + `episodes`; the engine no-ops the revert safely when
    `watchlistStatus` is absent (and `statusRevertedToWatching` is `false`).
    Only the daily pass (entry point B) wires `watchlistStatus`.
- **Next-unwatched-episode air date recompute (spec 0081).** The optional
  `nextWatchable` port (`WatchlistNextWatchableStore`, Admin-SDK-backed in
  `apps/functions`) keeps the denormalized `nextUnwatchedEpisodeAirDate` field on
  `users/{uid}/watchlist/{titleId}` correct. In `syncOne`, **after**
  `writeEpisodes`, when **≥1 new episode was inserted this run**
  (`toWrite.length > 0`) **and** the port is present, the engine calls
  `readEpisodeWatchState(uid, titleId)` — a **fresh full read AFTER the write**,
  so it sees pre-existing docs' real `watched` state PLUS the just-inserted
  (`watched: false`) docs (the existing `getExistingEpisodeIds` returns ids only,
  with no watched state, so it cannot supply this). It then computes the **min
  `airDate` over episodes with `watched === false`** (ISO **lexical** comparison,
  the `transitions.ts` idiom), or `null` when nothing is unwatched, and writes it
  via `setNextUnwatchedEpisodeAirDate`. This is a **separate watchlist-doc write**
  and is **independent of the `watchlistStatus` revert block** — both may fire in
  the same run; episode docs are never touched (insert-only invariant preserved).
  - **Wired into BOTH entry points — the deliberate deviation from the 0074
    `watchlistStatus` port** (which is entry-B-only). Unlike a completed→watching
    revert (structurally impossible for a brand-new title), a freshly-added TV
    show **does** need `nextUnwatchedEpisodeAirDate` set on its first sync (entry
    A) — otherwise it stays `null` until the next daily pass and the show looks
    like "nothing to watch" for up to 24h. So `apps/functions` wires
    `nextWatchable` into **both** the on-add trigger (entry A) and the daily pass
    (entry B). The engine still no-ops safely when the port is absent (optional
    backward compatibility).

- **Two episode-creation paths, both race-safe (spec 0101).** The on-add trigger
  (**entry point A**, `syncOne`) still fetches directly from TMDB per user — it is
  rare and user-latency-sensitive, so it is deliberately NOT routed through the
  global cache. The nightly sharded pass (**entry point B'**) fetches each show
  once into the cache (`cacheShowEpisodes`) and fans it out per user
  (`fanoutUserEpisodes`). Both paths are insert-only and use the identical
  `s{SS}e{EEE}` ids, so a show added mid-day (entry A) and later refreshed by the
  nightly fan-out never conflict — no correctness gap.

## Sheriff boundaries

- Tags: `scope:functions`, `slice:sync-episodes` (resolved by the path glob
  `libs/functions/<slice>/src`; `project.json` keeps `"tags": []`).
- Imports `@vultus/shared/domain` only. **Must not** import
  `@vultus/functions/sync-titles` (`slice:sync-titles`), `@vultus/functions/*`
  siblings, `scope:mobile`, or any Firebase SDK — those wires live exclusively in
  `apps/functions`.
