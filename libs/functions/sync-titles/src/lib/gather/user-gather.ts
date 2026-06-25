/**
 * Per-user watchlist gather for the manual `triggerSync` callable (spec 0025).
 *
 * Unlike the cron's global `collectionGroup('watchlist')` scan (spec 0009), this
 * reads ONLY the calling user's `users/{uid}/watchlist` collection — a single
 * `.get()` with no `where`/`orderBy` (so no composite index), projecting each doc
 * to its two raw primitive fields `{ tmdbId, type }` (no converter — avoids the
 * `addedAt` Timestamp). Dedupes by `tmdbId` (a single user is unlikely to dupe,
 * but kept defensive and consistent with the cron path).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { watchlistPath } from '@vultus/shared/firestore-schema';
import type { TitleType } from '@vultus/shared/domain';

export interface GatheredUserTitle {
  tmdbId: number;
  type: TitleType;
}

/** Read one user's watchlist and project to distinct {tmdbId,type}. No converter
 *  (reads two raw primitive fields; avoids the addedAt Timestamp). */
export async function gatherUserWatchlistTitles(
  db: Firestore,
  uid: string,
): Promise<GatheredUserTitle[]> {
  const snap = await db.collection(watchlistPath(uid)).get();
  const seen = new Map<number, GatheredUserTitle>();
  for (const doc of snap.docs) {
    const data = doc.data() as { tmdbId: number; type: TitleType };
    if (!seen.has(data.tmdbId)) {
      seen.set(data.tmdbId, { tmdbId: data.tmdbId, type: data.type });
    }
  }
  return [...seen.values()];
}
