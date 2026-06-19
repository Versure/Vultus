/**
 * Pure staleness filter (spec 0009 "Staleness filter"). The engine is
 * staleness-agnostic (the 0008 contract); this filter lives in the function.
 *
 * A title is DROPPED only when its stored `title-cache.lastSyncedAt` is younger
 * than `windowMs` (i.e. `now - Date.parse(lastSyncedAt) < windowMs`). A
 * never-synced title (null/absent in the map) is always KEPT. `force: true`
 * (the privileged/cron path) keeps ALL titles regardless of freshness.
 */
import type { GatheredTitle } from './gather';

/**
 * @param titles               Deduped candidate titles.
 * @param lastSyncedByTmdbId   tmdbId → stored ISO `lastSyncedAt` (or null when
 *                             never synced / absent).
 * @param now                  Current time in epoch ms.
 * @param windowMs             Freshness window; titles synced within it are dropped.
 * @param force                When true, keep every title (cron override).
 * @returns                    The subset of `titles` to sync.
 */
export function filterStale(
  titles: GatheredTitle[],
  lastSyncedByTmdbId: Map<number, string | null>,
  now: number,
  windowMs: number,
  force: boolean,
): GatheredTitle[] {
  if (force) {
    return [...titles];
  }
  return titles.filter((title) => {
    const lastSyncedAt = lastSyncedByTmdbId.get(title.tmdbId) ?? null;
    if (lastSyncedAt === null) {
      // Never synced → always sync.
      return true;
    }
    const parsed = Date.parse(lastSyncedAt);
    if (Number.isNaN(parsed)) {
      // Unparseable timestamp → treat as stale (sync it).
      return true;
    }
    const age = now - parsed;
    // Younger than the window → fresh → drop. Otherwise keep.
    return age >= windowMs;
  });
}
