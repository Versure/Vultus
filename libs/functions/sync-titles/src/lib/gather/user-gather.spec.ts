import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { watchlistPath } from '@vultus/shared/firestore-schema';
import { gatherUserWatchlistTitles } from './user-gather';

// A fake Admin-SDK Firestore that records the collection() path it was handed and
// returns a canned watchlist snapshot. Each doc exposes only the raw primitive
// fields the gather projects ({ tmdbId, type }), plus an extra Timestamp-like
// `addedAt` to prove it is NOT read (no converter).
function createFakeDb(docs: { tmdbId: number; type: 'movie' | 'tv' }[]) {
  const collection = vi.fn((path: string) => ({
    get: () =>
      Promise.resolve({
        docs: docs.map((d) => ({
          data: () => ({ ...d, addedAt: { toDate: () => new Date(0) } }),
        })),
      }),
    _path: path,
  }));
  return { db: { collection } as unknown as Firestore, collection };
}

describe('gatherUserWatchlistTitles', () => {
  it('reads watchlistPath(uid) and projects each doc to { tmdbId, type }', async () => {
    const { db, collection } = createFakeDb([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
    ]);

    const out = await gatherUserWatchlistTitles(db, 'user-1');

    expect(collection).toHaveBeenCalledWith(watchlistPath('user-1'));
    expect(collection).toHaveBeenCalledWith('users/user-1/watchlist');
    expect(out).toEqual([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
    ]);
  });

  it('dedupes by tmdbId, preserving first-seen order', async () => {
    const { db } = createFakeDb([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
      { tmdbId: 603, type: 'movie' },
    ]);

    const out = await gatherUserWatchlistTitles(db, 'user-1');

    expect(out).toEqual([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
    ]);
  });

  it('empty watchlist → []', async () => {
    const { db } = createFakeDb([]);
    const out = await gatherUserWatchlistTitles(db, 'user-1');
    expect(out).toEqual([]);
  });
});
