// Public contract types for the episode-sync engine (spec 0047).

import type {
  EpisodeStore,
  TmdbEpisodeSource,
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
