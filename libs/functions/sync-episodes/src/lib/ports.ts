// Ports for the episode-sync engine (spec 0047). The engine depends ONLY on
// these interfaces; the concrete Admin-SDK + sync-titles TmdbClient adapters
// that satisfy them live in `apps/functions`. Keeping these abstract is what
// lets the lib stay Firebase-free and free of any `slice:sync-titles` import.

import type {
  Episode,
  EpisodeDoc,
  TitleType,
  WatchStatus,
} from '@vultus/shared/domain';

/** A single TV show pulled from the global watchlist for the daily pass (entry
 *  point B). Not deduped by `tmdbId` — episodes are written per (uid, titleId). */
export interface WatchlistTvShow {
  uid: string;
  titleId: string;
  tmdbId: number;
}

/** The minimal watchlist-doc projection the on-add trigger (entry point A)
 *  inspects to decide whether to sync episodes (tv only). */
export interface WatchlistDocRef {
  type: TitleType;
  tmdbId: number;
}

/** Source of all TV shows across every user's watchlist (entry point B). */
export interface WatchlistTvSource {
  listAllTvShows(): Promise<WatchlistTvShow[]>;
}

/** Read-only TMDB episode source. `null` signals "show/season not found in
 *  TMDB" (404) so the engine can skip rather than error. */
export interface TmdbEpisodeSource {
  /** Total season count, or null when the show is not found in TMDB. */
  getSeasonCount(tmdbId: number): Promise<number | null>;
  /** The season's episodes, or null when the season is not found in TMDB.
   *  Episodes with no air date are never produced by the upstream mapper. */
  getSeasonEpisodes(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<Episode[] | null>;
}

/** Per-user episode subcollection store. Insert-only: the engine pre-filters
 *  against `getExistingEpisodeIds`, so `writeEpisodes` only ever receives new
 *  ids — existing docs (and their `watched`/`watchedAt` state) are never
 *  overwritten. */
export interface EpisodeStore {
  getExistingEpisodeIds(uid: string, titleId: string): Promise<Set<string>>;
  writeEpisodes(
    uid: string,
    titleId: string,
    docs: { id: string; doc: EpisodeDoc }[],
  ): Promise<void>;
}

/** Reads and updates the watchlist doc's `status` for a (uid, titleId). Used by
 *  the daily pass to revert a `'completed'` show to `'watching'` when new
 *  episodes are inserted (spec 0074). Admin-SDK-backed in apps/functions; faked
 *  in tests. Firebase-free interface. */
export interface WatchlistStatusStore {
  getStatus(uid: string, titleId: string): Promise<WatchStatus | null>;
  setStatus(uid: string, titleId: string, status: WatchStatus): Promise<void>;
}

/** Reads episode watch-state and writes the parent watchlist doc's
 *  `nextUnwatchedEpisodeAirDate` for a (uid, titleId). Used by `syncOne` after
 *  inserting new episodes to keep the denormalized "earliest unwatched air date"
 *  correct on BOTH the on-add trigger (entry A) and the daily pass (entry B)
 *  (spec 0081). Admin-SDK-backed in apps/functions; faked in tests. Firebase-free
 *  interface. */
export interface WatchlistNextWatchableStore {
  /** Reads (airDate, watched) for every episode under
   *  users/{uid}/watchlist/{titleId}/episodes. Called AFTER writeEpisodes so it
   *  sees pre-existing docs' real watched state PLUS the just-inserted docs.
   *  `airDate` is an ISO 8601 string. */
  readEpisodeWatchState(
    uid: string,
    titleId: string,
  ): Promise<{ airDate: string; watched: boolean }[]>;
  /** Writes nextUnwatchedEpisodeAirDate (plain ISO string, or null) onto
   *  users/{uid}/watchlist/{titleId}. */
  setNextUnwatchedEpisodeAirDate(
    uid: string,
    titleId: string,
    airDate: string | null,
  ): Promise<void>;
}
