// Public contract types for the episode-sync engine (spec 0047).

import type {
  EpisodeStore,
  TmdbEpisodeSource,
  WatchlistTvSource,
} from '../ports';

export interface EpisodeSyncConfig {
  tmdb: TmdbEpisodeSource;
  episodes: EpisodeStore;
  /** Required only for `syncAll` (entry point B). Omitted by the on-add trigger
   *  (entry point A), which only ever calls `syncOne`. */
  watchlist?: WatchlistTvSource;
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
