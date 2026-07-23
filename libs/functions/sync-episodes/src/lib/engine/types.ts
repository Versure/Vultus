// Public contract types for the episode-sync engine (spec 0047).

import type {
  EpisodeStore,
  TitleCacheEpisodeStore,
  TmdbEpisodeSource,
  WatchlistNextWatchableStore,
  WatchlistStatusStore,
  WatchlistTvSource,
} from '../ports';

export interface EpisodeSyncConfig {
  tmdb: TmdbEpisodeSource;
  episodes: EpisodeStore;
  /** Required only for `syncAll` (entry point B). Omitted by the on-add trigger
   *  (entry point A), which only ever calls `syncOne`. */
  watchlist?: WatchlistTvSource;
  /** Present only for the daily pass (entry point B). When present, `syncOne`
   *  reverts a `'completed'` show to `'watching'` after inserting ≥1 new episode
   *  (spec 0074). Omitted by the on-add trigger (entry point A). */
  watchlistStatus?: WatchlistStatusStore;
  /** Present on BOTH entry points (spec 0081 — deliberate deviation from 0074's
   *  entry-A omission). When present, `syncOne` recomputes and writes
   *  nextUnwatchedEpisodeAirDate after inserting ≥1 new episode. */
  nextWatchable?: WatchlistNextWatchableStore;
}

export interface EpisodeUpsertResult {
  uid: string;
  titleId: string;
  tmdbId: number;
  /** Seasons reported by TMDB (`getSeasonCount`); 0 when skipped/errored. */
  seasonsFetched: number;
  /** Count of NEW episode docs inserted this run (existing ids excluded). */
  episodesWritten: number;
  outcome: 'synced' | 'skipped' | 'error';
  /** Human-readable detail for 'skipped'/'error'; absent on 'synced'. */
  reason?: string;
  /** True when this run reverted the show from 'completed' to 'watching'
   *  (spec 0074). Optional — absent/false on runs that did not revert. */
  statusRevertedToWatching?: boolean;
}

export interface EpisodeSyncEngine {
  /** Upsert episodes for one (uid, titleId, tmdbId). Insert-only. */
  syncOne(
    uid: string,
    titleId: string,
    tmdbId: number,
  ): Promise<EpisodeUpsertResult>;
  /** Daily pass: iterate every TV show on every watchlist, isolating per-show
   *  errors. Requires `watchlist` in the config. */
  syncAll(): Promise<EpisodeUpsertResult[]>;
}

// --- Cache-backed fetch-once / fan-out engine (spec 0101, entry point B') ---

/** Ports for the cache-backed episode engine. The global cache store is
 *  required by both operations; the TMDB source is required only by
 *  `cacheShowEpisodes` and the per-user episode store only by
 *  `fanoutUserEpisodes`, so a cache-only or fan-out-only engine may omit the
 *  port it does not use (matching the optional-port idiom of `EpisodeSyncConfig`).
 *  `watchlistStatus`/`nextWatchable` are the same optional spec-0074/0081 ports
 *  the on-add engine uses. */
export interface EpisodeCacheEngineConfig {
  /** Global `title-cache/{tmdbId}/episodes` store — used by BOTH operations. */
  cache: TitleCacheEpisodeStore;
  /** TMDB source — required by `cacheShowEpisodes`; omit for a fan-out-only
   *  engine (the fan-out stage makes ZERO TMDB calls). */
  tmdb?: TmdbEpisodeSource;
  /** Per-user episode store — required by `fanoutUserEpisodes`; omit for a
   *  cache-only engine. */
  episodes?: EpisodeStore;
  /** Spec 0074 completed→watching revert (optional; fan-out only). */
  watchlistStatus?: WatchlistStatusStore;
  /** Spec 0081 nextUnwatchedEpisodeAirDate recompute (optional; fan-out only). */
  nextWatchable?: WatchlistNextWatchableStore;
}

/** Result of caching one show's episodes into the global cache. */
export interface CacheShowResult {
  tmdbId: number;
  /** Seasons reported by TMDB (`getSeasonCount`); 0 when skipped. */
  seasonsFetched: number;
  /** Count of episode docs upserted into the cache this run (null-air-date
   *  episodes excluded). */
  episodesCached: number;
  outcome: 'cached' | 'skipped';
  /** Human-readable detail for 'skipped'; absent on 'cached'. */
  reason?: string;
}

export interface EpisodeCacheEngine {
  /** Fetch a show's seasons/episodes from TMDB ONCE and upsert them into the
   *  global `title-cache/{tmdbId}/episodes` cache. Null-air-date episodes are
   *  skipped (spec 0047). Idempotent: re-running upserts the same doc ids.
   *  Requires `tmdb` + `cache` in the config. */
  cacheShowEpisodes(tmdbId: number): Promise<CacheShowResult>;
  /** Read a show's episodes FROM THE CACHE (zero TMDB calls) and write the
   *  per-user `users/{uid}/watchlist/{titleId}/episodes` docs insert-only, then
   *  apply the spec-0074 revert + spec-0081 recompute. Requires `cache` +
   *  `episodes` in the config. */
  fanoutUserEpisodes(
    uid: string,
    titleId: string,
    tmdbId: number,
  ): Promise<EpisodeUpsertResult>;
}
