// Shared insert-only write internals for the episode-sync engine (spec 0047)
// and the cache-backed fan-out engine (spec 0101). Both entry points compute
// the same insert-only diff, then apply the same spec-0074 completed→watching
// revert and spec-0081 nextUnwatchedEpisodeAirDate recompute AFTER the write —
// so those steps live here once instead of being duplicated per engine.
// Firebase-free; no `slice:sync-titles` import — all I/O stays behind ports.

import type { Episode, EpisodeDoc } from '@vultus/shared/domain';
import { episodeId, newEpisodeDoc } from './episode-id';
import type {
  WatchlistNextWatchableStore,
  WatchlistStatusStore,
} from '../ports';

/** Diff the fetched episodes against the ids already present, returning ONLY
 *  the new docs (insert-only invariant, spec 0047). Keyed by
 *  `episodeId(season, episode)` so existing docs — and their `watched`/
 *  `watchedAt` state — are never included and therefore never overwritten. */
export function computeInserts(
  fetched: Episode[],
  existing: Set<string>,
): { id: string; doc: EpisodeDoc }[] {
  return fetched
    .filter((e) => !existing.has(episodeId(e.season, e.episode)))
    .map((e) => ({
      id: episodeId(e.season, e.episode),
      doc: newEpisodeDoc(e),
    }));
}

/** Spec 0074 source-of-truth revert. When ≥1 NEW episode was inserted this run
 *  AND the `watchlistStatus` port is present AND the show's current status is
 *  `'completed'`, revert it to `'watching'` (a SEPARATE watchlist-doc write —
 *  episode docs are never touched). Returns whether a revert happened. No-ops
 *  safely when the port is absent or nothing was inserted. */
export async function applyCompletedRevert(
  watchlistStatus: WatchlistStatusStore | undefined,
  uid: string,
  titleId: string,
  insertedCount: number,
): Promise<boolean> {
  if (insertedCount > 0 && watchlistStatus) {
    const current = await watchlistStatus.getStatus(uid, titleId);
    if (current === 'completed') {
      await watchlistStatus.setStatus(uid, titleId, 'watching');
      return true;
    }
  }
  return false;
}

/** Spec 0081 denormalized recompute. When ≥1 NEW episode was inserted this run
 *  AND the `nextWatchable` port is present, read the FULL episode watch-state
 *  AFTER the write (so it sees pre-existing docs' real `watched` state plus the
 *  just-inserted `watched: false` docs), compute the MIN `airDate` over
 *  unwatched episodes (ISO lexical comparison, the `transitions.ts` idiom) — or
 *  `null` when nothing is unwatched — and write it. No-ops safely when the port
 *  is absent or nothing was inserted. */
export async function applyNextWatchableRecompute(
  nextWatchable: WatchlistNextWatchableStore | undefined,
  uid: string,
  titleId: string,
  insertedCount: number,
): Promise<void> {
  if (insertedCount > 0 && nextWatchable) {
    const eps = await nextWatchable.readEpisodeWatchState(uid, titleId);
    const unwatched = eps.filter((e) => !e.watched).map((e) => e.airDate);
    const next =
      unwatched.length > 0
        ? unwatched.reduce((min, d) => (d < min ? d : min))
        : null;
    await nextWatchable.setNextUnwatchedEpisodeAirDate(uid, titleId, next);
  }
}
