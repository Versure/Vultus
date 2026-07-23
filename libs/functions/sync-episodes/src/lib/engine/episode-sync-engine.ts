// The episode-upsert engine (spec 0047). Pure orchestration over the injected
// ports: fetch TMDB seasons → episodes, diff against the user's existing
// episode ids, insert ONLY the missing ones (never overwriting watched state).
// Firebase-free; no `slice:sync-titles` import — all I/O is a port.

import type { Episode } from '@vultus/shared/domain';
import {
  applyCompletedRevert,
  applyNextWatchableRecompute,
  computeInserts,
} from './episode-write-helpers';
import type {
  EpisodeSyncConfig,
  EpisodeSyncEngine,
  EpisodeUpsertResult,
} from './types';

export function createEpisodeSyncEngine(
  config: EpisodeSyncConfig,
): EpisodeSyncEngine {
  const { tmdb, episodes, watchlist, watchlistStatus, nextWatchable } = config;

  async function syncOne(
    uid: string,
    titleId: string,
    tmdbId: number,
  ): Promise<EpisodeUpsertResult> {
    const count = await tmdb.getSeasonCount(tmdbId);
    if (count === null) {
      return {
        uid,
        titleId,
        tmdbId,
        seasonsFetched: 0,
        episodesWritten: 0,
        outcome: 'skipped',
        reason: 'show not found in TMDB',
      };
    }

    // Fetch every season; a null season (TMDB 404 for that season) contributes
    // nothing but does not fail the show.
    const fetched: Episode[] = [];
    for (let season = 1; season <= count; season++) {
      const eps = await tmdb.getSeasonEpisodes(tmdbId, season);
      if (eps === null) continue;
      fetched.push(...eps);
    }

    const existing = await episodes.getExistingEpisodeIds(uid, titleId);
    const toWrite = computeInserts(fetched, existing);

    await episodes.writeEpisodes(uid, titleId, toWrite);

    // Source-of-truth revert (spec 0074, D4): the daily pass (entry point B)
    // wires `watchlistStatus`; when ≥1 NEW episode was inserted this run and the
    // show's watchlist status is 'completed', revert it to 'watching' so every
    // surface (Watchlist tab, detail page, notifications) is correct without the
    // user re-opening the detail page. This is a SEPARATE watchlist-doc write —
    // episode docs are never touched (insert-only invariant of spec 0047).
    const statusRevertedToWatching = await applyCompletedRevert(
      watchlistStatus,
      uid,
      titleId,
      toWrite.length,
    );

    // Denormalized "earliest unwatched air date" recompute (spec 0081). Wired
    // into BOTH entry points (deviation from 0074's entry-A omission — a fresh
    // TV add must get this field on its first sync). Independent of the
    // watchlistStatus block above (both may fire in the same run). Reads full
    // watch-state AFTER writeEpisodes so it sees pre-existing docs' real watched
    // state plus the just-inserted (watched: false) docs — getExistingEpisodeIds
    // (ids only) can't supply that.
    await applyNextWatchableRecompute(
      nextWatchable,
      uid,
      titleId,
      toWrite.length,
    );

    return {
      uid,
      titleId,
      tmdbId,
      seasonsFetched: count,
      episodesWritten: toWrite.length,
      outcome: 'synced',
      statusRevertedToWatching,
    };
  }

  async function syncAll(): Promise<EpisodeUpsertResult[]> {
    if (!watchlist) {
      throw new Error(
        'createEpisodeSyncEngine: `watchlist` is required for syncAll()',
      );
    }
    const shows = await watchlist.listAllTvShows();
    const results: EpisodeUpsertResult[] = [];
    // Per-show error isolation: one show's failure never aborts the pass.
    for (const show of shows) {
      try {
        results.push(await syncOne(show.uid, show.titleId, show.tmdbId));
      } catch (err) {
        results.push({
          uid: show.uid,
          titleId: show.titleId,
          tmdbId: show.tmdbId,
          seasonsFetched: 0,
          episodesWritten: 0,
          outcome: 'error',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  return { syncOne, syncAll };
}
