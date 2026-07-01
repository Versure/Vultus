import { describe, expect, it, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/https';
import type { CatalogProvider } from '@vultus/shared/domain';
import type { TmdbClient } from '@vultus/functions/sync-titles';
import {
  runGetWatchProviders,
  PROVIDER_CATALOG_STALENESS_MS,
  type RunGetWatchProvidersDeps,
  // Regression: the existing exports must remain present + unchanged.
  getWatchProviders,
  syncTitles,
  triggerSync,
} from './main';

const NETFLIX: CatalogProvider = {
  providerId: 8,
  name: 'Netflix',
  logoPath: '/netflix.jpg',
};
const DISNEY: CatalogProvider = {
  providerId: 337,
  name: 'Disney Plus',
  logoPath: '/disney.jpg',
};

// --- A fake Firestore that answers a single `doc(path).get()` for the
// provider-catalog doc and records every `doc(path).set()` write. The callable
// touches ONLY `provider-catalog/{region}` (read + best-effort write). ---
function createFakeDb(opts: {
  /** Stored provider-catalog doc as it would be READ back (Timestamp-like). */
  cached?: { providers: CatalogProvider[]; lastSyncedAtMs: number } | null;
  /** When set, `doc(path).set(...)` rejects with this error (best-effort). */
  failWrite?: Error;
  /** When set, `doc(path).get()` rejects with this error. */
  failRead?: Error;
}) {
  const writes: { path: string; data: unknown }[] = [];
  const reads: string[] = [];

  const db = {
    doc: (path: string) => ({
      get: () => {
        reads.push(path);
        if (opts.failRead) return Promise.reject(opts.failRead);
        if (!opts.cached) {
          return Promise.resolve({ exists: false, data: () => undefined });
        }
        return Promise.resolve({
          exists: true,
          data: () => ({
            providers: opts.cached?.providers,
            // Emulate the Firestore Timestamp `{ toDate() }` read shape.
            lastSyncedAt: {
              toDate: () => new Date(opts.cached?.lastSyncedAtMs ?? 0),
            },
          }),
        });
      },
      set: (data: unknown) => {
        if (opts.failWrite) return Promise.reject(opts.failWrite);
        writes.push({ path, data });
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as RunGetWatchProvidersDeps['db'], writes, reads };
}

// A fake TMDB client whose only exercised method is `getRegionWatchProviders`.
// It records how many times it was called so tests can assert TMDB was skipped.
function createFakeTmdb(
  result: CatalogProvider[] | null | (() => CatalogProvider[] | null),
) {
  const calls: string[] = [];
  const client = {
    getRegionWatchProviders: (region: string) => {
      calls.push(region);
      const value = typeof result === 'function' ? result() : result;
      return Promise.resolve(value);
    },
  } as unknown as TmdbClient;
  return { client, calls };
}

const NOW = Date.parse('2026-07-01T12:00:00.000Z');
const fixedNow = () => NOW;

describe('runGetWatchProviders handler wiring', () => {
  it('no auth uid → throws HttpsError(unauthenticated); TMDB NOT called', async () => {
    const { db } = createFakeDb({});
    const tmdb = createFakeTmdb([NETFLIX]);

    await expect(
      runGetWatchProviders(
        { db, createTmdb: () => tmdb.client, now: fixedNow },
        undefined,
        { region: 'NL' },
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(tmdb.calls).toHaveLength(0);
  });

  it('unknown region → throws HttpsError(invalid-argument); TMDB NOT called', async () => {
    const { db, reads } = createFakeDb({});
    const tmdb = createFakeTmdb([NETFLIX]);

    const err: unknown = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'ZZ' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe('invalid-argument');
    expect(tmdb.calls).toHaveLength(0);
    expect(reads).toHaveLength(0); // never touches Firestore on a bad region
  });

  it('missing/non-object input → invalid-argument', async () => {
    const { db } = createFakeDb({});
    const tmdb = createFakeTmdb([NETFLIX]);

    await expect(
      runGetWatchProviders(
        { db, createTmdb: () => tmdb.client, now: fixedNow },
        'user-1',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(tmdb.calls).toHaveLength(0);
  });

  it('fresh cache (age ≤ 7d) → returns cached providers; TMDB NOT called; no write', async () => {
    const { db, writes, reads } = createFakeDb({
      cached: {
        providers: [NETFLIX, DISNEY],
        // 1 day old — well within the 7-day window.
        lastSyncedAtMs: NOW - 24 * 60 * 60 * 1000,
      },
    });
    const tmdb = createFakeTmdb([NETFLIX]);

    const res = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    );

    expect(res.providers).toEqual([NETFLIX, DISNEY]);
    expect(tmdb.calls).toHaveLength(0); // cache hit → no TMDB
    expect(reads).toEqual(['provider-catalog/NL']);
    expect(writes).toHaveLength(0);
  });

  it('cache exactly at the 7d boundary (age === stalenessMs) → still fresh (≤)', async () => {
    const { db, writes } = createFakeDb({
      cached: {
        providers: [NETFLIX],
        lastSyncedAtMs: NOW - PROVIDER_CATALOG_STALENESS_MS,
      },
    });
    const tmdb = createFakeTmdb([DISNEY]);

    const res = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    );

    expect(res.providers).toEqual([NETFLIX]);
    expect(tmdb.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('absent cache → fetches from TMDB, writes provider-catalog/{region}, returns fetched', async () => {
    const { db, writes } = createFakeDb({ cached: null });
    const tmdb = createFakeTmdb([NETFLIX, DISNEY]);

    const res = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    );

    expect(res.providers).toEqual([NETFLIX, DISNEY]);
    expect(tmdb.calls).toEqual(['NL']);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('provider-catalog/NL');
    const written = writes[0].data as {
      providers: CatalogProvider[];
      lastSyncedAt: Date;
    };
    expect(written.providers).toEqual([NETFLIX, DISNEY]);
    // The converter maps the ISO now → a Date on write.
    expect(written.lastSyncedAt).toBeInstanceOf(Date);
    expect(written.lastSyncedAt.toISOString()).toBe(
      new Date(NOW).toISOString(),
    );
  });

  it('stale cache (age > 7d) → refetches, rewrites, returns fresh providers', async () => {
    const { db, writes } = createFakeDb({
      cached: {
        providers: [NETFLIX], // stale content
        lastSyncedAtMs: NOW - (PROVIDER_CATALOG_STALENESS_MS + 1),
      },
    });
    const tmdb = createFakeTmdb([DISNEY]); // fresh content

    const res = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    );

    expect(res.providers).toEqual([DISNEY]); // fresh, not the stale cache
    expect(tmdb.calls).toEqual(['NL']);
    expect(writes).toHaveLength(1);
    expect(
      (writes[0].data as { providers: CatalogProvider[] }).providers,
    ).toEqual([DISNEY]);
  });

  it('TMDB null + NO cache → throws HttpsError(unavailable); no write', async () => {
    const { db, writes } = createFakeDb({ cached: null });
    const tmdb = createFakeTmdb(null);

    const err: unknown = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe('unavailable');
    expect(writes).toHaveLength(0);
  });

  it('TMDB null + STALE cache → returns the stale providers (no throw); no write', async () => {
    const { db, writes } = createFakeDb({
      cached: {
        providers: [NETFLIX],
        lastSyncedAtMs: NOW - (PROVIDER_CATALOG_STALENESS_MS + 1),
      },
    });
    const tmdb = createFakeTmdb(null);

    const res = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    );

    expect(res.providers).toEqual([NETFLIX]); // stale beats none
    expect(tmdb.calls).toEqual(['NL']); // it did attempt a refetch
    expect(writes).toHaveLength(0); // null result → no overwrite
  });

  it('BEST-EFFORT: a failing cache write still returns the freshly-fetched providers', async () => {
    const { db } = createFakeDb({
      cached: null,
      failWrite: new Error('provider-catalog write boom'),
    });
    const tmdb = createFakeTmdb([NETFLIX, DISNEY]);

    const res = await runGetWatchProviders(
      { db, createTmdb: () => tmdb.client, now: fixedNow },
      'user-1',
      { region: 'NL' },
    );

    expect(res.providers).toEqual([NETFLIX, DISNEY]);
  });

  it('defaults to Date.now() + 7-day staleness when now/stalenessMs are omitted', async () => {
    const { db, writes } = createFakeDb({ cached: null });
    const tmdb = createFakeTmdb([NETFLIX]);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(NOW);

    try {
      const res = await runGetWatchProviders(
        { db, createTmdb: () => tmdb.client },
        'user-1',
        { region: 'DE' },
      );
      expect(res.providers).toEqual([NETFLIX]);
      expect(writes[0].path).toBe('provider-catalog/DE');
    } finally {
      spy.mockRestore();
    }
  });

  it('REGRESSION: getWatchProviders, syncTitles and triggerSync remain exported', () => {
    expect(getWatchProviders).toBeDefined();
    expect(syncTitles).toBeDefined();
    expect(triggerSync).toBeDefined();
  });
});
