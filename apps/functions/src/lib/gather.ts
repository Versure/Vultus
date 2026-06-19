/**
 * Pure dedupe of the gathered watchlist titles (spec 0009 "Gather").
 *
 * The `collectionGroup('watchlist')` scan yields one entry per (user, title);
 * a title tracked by N users appears N times. The engine syncs the GLOBAL union
 * of distinct titles — a title is synced once regardless of how many users track
 * it — so we dedupe by `tmdbId`. Distinct tmdbIds and the movie/tv mix are
 * preserved; an empty input → `[]`.
 */
import type { TitleType } from '@vultus/shared/domain';

export interface GatheredTitle {
  tmdbId: number;
  type: TitleType;
}

/** Distinct `{ tmdbId, type }` keyed by `tmdbId`, preserving first-seen order. */
export function dedupeTitles(items: GatheredTitle[]): GatheredTitle[] {
  const seen = new Map<number, GatheredTitle>();
  for (const item of items) {
    if (!seen.has(item.tmdbId)) {
      seen.set(item.tmdbId, { tmdbId: item.tmdbId, type: item.type });
    }
  }
  return [...seen.values()];
}
