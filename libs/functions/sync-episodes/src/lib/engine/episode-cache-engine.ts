// Cache-backed fetch-once / fan-out episode engine (spec 0101, sharded daily
// pass — entry point B'). Splits the old per-user `syncAll` into two stages so
// TMDB is hit at most ONCE per distinct show per night:
//
//   1. `cacheShowEpisodes(tmdbId)` — the `episodeCacheWorker` stage. Fetch a
//      show's seasons/episodes ONCE via the TMDB port and upsert them into the
//      shared global cache (`title-cache/{tmdbId}/episodes`). No per-user work.
//   2. `fanoutUserEpisodes(uid, titleId, tmdbId)` — the `episodeFanoutWorker`
//      stage. Read that show's episodes FROM THE CACHE (ZERO TMDB calls) and do
//      the exact per-user work the on-add engine does after fetching:
//      insert-only per-user episode docs + spec-0074 revert + spec-0081
//      recompute.
//
// The insert-only diff, the revert, and the recompute are shared with the
// on-add engine via `episode-write-helpers` — entry point A's observable
// behavior is unchanged. Firebase-free; no `slice:sync-titles` import.

import type { Episode } from '@vultus/shared/domain';
import { episodeId } from './episode-id';
import {
  applyCompletedRevert,
  applyNextWatchableRecompute,
  computeInserts,
} from './episode-write-helpers';
import type {
  CacheShowResult,
  EpisodeCacheEngine,
  EpisodeCacheEngineConfig,
  EpisodeUpsertResult,
} from './types';

/** An episode is cacheable/fannable only with a real air date. Domain typing
 *  makes `airDate` a required string and the upstream TMDB mapper already drops
 *  null-air-date episodes (spec 0047), but guard here too so the global cache
 *  never stores — and the fan-out never writes — a null-air-date episode. */
function hasAirDate(e: Episode): boolean {
  return e.airDate != null && e.airDate !== '';
}

export function createEpisodeCacheEngine(
  config: EpisodeCacheEngineConfig,
): EpisodeCacheEngine {
  const { cache, tmdb, episodes, watchlistStatus, nextWatchable } = config;

  async function cacheShowEpisodes(tmdbId: number): Promise<CacheShowResult> {
    if (!tmdb) {
      throw new Error(
        'createEpisodeCacheEngine: `tmdb` is required for cacheShowEpisodes()',
      );
    }

    const count = await tmdb.getSeasonCount(tmdbId);
    if (count === null) {
      return {
        tmdbId,
        seasonsFetched: 0,
        episodesCached: 0,
        outcome: 'skipped',
        reason: 'show not found in TMDB',
      };
    }

    // Fetch every season once; a null season (TMDB 404 for that season)
    // contributes nothing but does not fail the show — identical per-season loop
    // semantics to the on-add engine. Per-show error isolation is applied by the
    // worker loop (a thrown fetch propagates to the caller, exactly as `syncOne`
    // does for `syncAll`).
    const fetched: Episode[] = [];
    for (let season = 1; season <= count; season++) {
      const eps = await tmdb.getSeasonEpisodes(tmdbId, season);
      if (eps === null) continue;
      fetched.push(...eps);
    }

    const toCache = fetched.filter(hasAirDate).map((e) => ({
      id: episodeId(e.season, e.episode),
      episode: e,
    }));

    await cache.upsertCachedEpisodes(tmdbId, toCache);

    return {
      tmdbId,
      seasonsFetched: count,
      episodesCached: toCache.length,
      outcome: 'cached',
    };
  }

  async function fanoutUserEpisodes(
    uid: string,
    titleId: string,
    tmdbId: number,
  ): Promise<EpisodeUpsertResult> {
    if (!episodes) {
      throw new Error(
        'createEpisodeCacheEngine: `episodes` is required for fanoutUserEpisodes()',
      );
    }

    // Read the show's episodes from the GLOBAL CACHE — zero TMDB calls. The
    // cache-worker stage (`cacheShowEpisodes`) already did the single TMDB fetch
    // for this show earlier in the run.
    const cached = await cache.getCachedEpisodes(tmdbId);
    const fetched = cached.filter(hasAirDate);

    const existing = await episodes.getExistingEpisodeIds(uid, titleId);
    const toWrite = computeInserts(fetched, existing);

    await episodes.writeEpisodes(uid, titleId, toWrite);

    // Spec 0074 completed→watching revert + spec 0081 nextUnwatchedEpisodeAirDate
    // recompute — the SAME post-write steps the on-add engine applies, shared via
    // episode-write-helpers so fan-out behaves identically to the per-user path.
    const statusRevertedToWatching = await applyCompletedRevert(
      watchlistStatus,
      uid,
      titleId,
      toWrite.length,
    );
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
      // Fan-out does not fetch seasons (the cache stage did); 0 by construction.
      seasonsFetched: 0,
      episodesWritten: toWrite.length,
      outcome: 'synced',
      statusRevertedToWatching,
    };
  }

  return { cacheShowEpisodes, fanoutUserEpisodes };
}
