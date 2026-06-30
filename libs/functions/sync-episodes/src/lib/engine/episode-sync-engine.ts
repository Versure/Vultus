// The episode-upsert engine (spec 0047). Pure orchestration over the injected
// ports: fetch TMDB seasons → episodes, diff against the user's existing
// episode ids, insert ONLY the missing ones (never overwriting watched state).
// Firebase-free; no `slice:sync-titles` import — all I/O is a port.

import type { Episode, EpisodeDoc } from '@vultus/shared/domain';
import { episodeId, newEpisodeDoc } from './episode-id';
import type {
  EpisodeSyncConfig,
  EpisodeSyncEngine,
  EpisodeUpsertResult,
} from './types';

export function createEpisodeSyncEngine(
  config: EpisodeSyncConfig,
): EpisodeSyncEngine {
  const { tmdb, episodes, watchlist } = config;

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
    const toWrite: { id: string; doc: EpisodeDoc }[] = fetched
      .filter((e) => !existing.has(episodeId(e.season, e.episode)))
      .map((e) => ({
        id: episodeId(e.season, e.episode),
        doc: newEpisodeDoc(e),
      }));

    await episodes.writeEpisodes(uid, titleId, toWrite);

    return {
      uid,
      titleId,
      tmdbId,
      seasonsFetched: count,
      episodesWritten: toWrite.length,
      outcome: 'synced',
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
