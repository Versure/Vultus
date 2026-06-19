import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Region,
  RegionAvailability,
  TitleCacheEntry,
  TitleMetadata,
  WatchProvider,
} from '@vultus/shared/domain';
import { createSyncEngine } from './sync-engine';
import type { TitleCacheStore } from './store';
import type { RegionProviders, TmdbClient } from '../tmdb/tmdb-client';
import type { TraktClient } from '../trakt/trakt-client';
import { TmdbError } from '../tmdb/tmdb-error';

const FIXED_NOW = '2026-06-19T00:00:00.000Z';

const movieMeta: TitleMetadata = {
  title: 'Fight Club',
  overview: 'A man and his alter ego.',
  posterPath: '/poster.jpg',
  releaseDate: '1999-10-15T00:00:00.000Z',
};
const tvMeta: TitleMetadata = {
  title: 'Breaking Bad',
  overview: 'A teacher cooks.',
  posterPath: '/bb.jpg',
  releaseDate: '2008-01-20T00:00:00.000Z',
};

const netflix: WatchProvider = {
  providerId: 8,
  name: 'Netflix',
  type: 'flatrate',
};
const disney: WatchProvider = {
  providerId: 337,
  name: 'Disney Plus',
  type: 'flatrate',
};
const apple: WatchProvider = {
  providerId: 350,
  name: 'Apple TV',
  type: 'rent',
};

// In-memory fake store keyed by tmdbId.
function createFakeStore(): TitleCacheStore & {
  entries: Map<number, TitleCacheEntry>;
  availability: Map<number, Partial<Record<Region, RegionAvailability>>>;
} {
  const entries = new Map<number, TitleCacheEntry>();
  const availability = new Map<
    number,
    Partial<Record<Region, RegionAvailability>>
  >();
  return {
    entries,
    availability,
    getEntry: (tmdbId) => Promise.resolve(entries.get(tmdbId) ?? null),
    getAvailability: (tmdbId) =>
      Promise.resolve(availability.get(tmdbId) ?? {}),
    putEntry: (tmdbId, entry) => {
      entries.set(tmdbId, entry);
      return Promise.resolve();
    },
    putAvailability: (tmdbId, region, av) => {
      const existing = availability.get(tmdbId) ?? {};
      existing[region] = av;
      availability.set(tmdbId, existing);
      return Promise.resolve();
    },
  };
}

// Build a TmdbClient whose methods are standalone spies, returned alongside the
// client so assertions reference the spy directly (avoids unbound-method lint).
function createTmdbMock(overrides: Partial<TmdbClient> = {}) {
  const getMovie =
    overrides.getMovie ??
    vi.fn(() => Promise.resolve<TitleMetadata | null>(movieMeta));
  const getTvShow =
    overrides.getTvShow ??
    vi.fn(() => Promise.resolve<TitleMetadata | null>(tvMeta));
  const getWatchProviders =
    overrides.getWatchProviders ??
    vi.fn(() => Promise.resolve<RegionProviders | null>({ NL: [netflix] }));
  const getSeasonEpisodes =
    overrides.getSeasonEpisodes ?? vi.fn(() => Promise.resolve(null));
  const client: TmdbClient = {
    getMovie,
    getTvShow,
    getWatchProviders,
    getSeasonEpisodes,
  };
  return { client, getMovie, getTvShow, getWatchProviders };
}

function createTraktMock(overrides: Partial<TraktClient> = {}) {
  const getCalendar = overrides.getCalendar ?? vi.fn(() => Promise.resolve([]));
  const getShowTraktId =
    overrides.getShowTraktId ?? vi.fn(() => Promise.resolve<number | null>(42));
  const client: TraktClient = { getCalendar, getShowTraktId };
  return { client, getShowTraktId };
}

describe('createSyncEngine', () => {
  let store: ReturnType<typeof createFakeStore>;

  beforeEach(() => {
    store = createFakeStore();
  });

  it('syncs a movie: writes entry with traktId null, never calls getShowTraktId', async () => {
    const tmdb = createTmdbMock();
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(trakt.getShowTraktId).not.toHaveBeenCalled();
    expect(store.entries.get(603)).toEqual({
      type: 'movie',
      traktId: null,
      metadata: movieMeta,
      lastSyncedAt: FIXED_NOW,
    });
    expect(store.availability.get(603)?.NL).toEqual({
      providers: [netflix],
      previousSnapshot: [],
      lastSyncedAt: FIXED_NOW,
    });
    expect(results[0].outcome).toBe('synced');
    expect(results[0].transitions).toEqual([
      {
        region: 'NL',
        providerId: 8,
        name: 'Netflix',
        type: 'flatrate',
        kind: 'added',
      },
    ]);
  });

  it('syncs a tv show: resolves and stores traktId, calls getShowTraktId once', async () => {
    const tmdb = createTmdbMock();
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    await engine.sync([{ tmdbId: 1396, type: 'tv' }]);

    expect(trakt.getShowTraktId).toHaveBeenCalledTimes(1);
    expect(trakt.getShowTraktId).toHaveBeenCalledWith(1396);
    expect(tmdb.getTvShow).toHaveBeenCalledWith(1396);
    expect(store.entries.get(1396)?.traktId).toBe(42);
  });

  it('stores traktId null when Trakt has no match but still syncs', async () => {
    const tmdb = createTmdbMock();
    const trakt = createTraktMock({
      getShowTraktId: vi.fn(() => Promise.resolve<number | null>(null)),
    });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 1396, type: 'tv' }]);

    expect(store.entries.get(1396)?.traktId).toBeNull();
    expect(results[0].outcome).toBe('synced');
  });

  it('rolls previousSnapshot to the prior providers, not the stored previousSnapshot', async () => {
    // Seed prior state: providers [A,B], previousSnapshot [X].
    store.availability.set(603, {
      NL: {
        providers: [netflix, disney], // A, B
        previousSnapshot: [apple], // X — must NOT become the new snapshot
        lastSyncedAt: 'old',
      },
    });
    const cinema: WatchProvider = {
      providerId: 99,
      name: 'Cinema',
      type: 'buy',
    };
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(
        () => Promise.resolve<RegionProviders | null>({ NL: [disney, cinema] }), // B, C
      ),
    });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    const written = store.availability.get(603)?.NL;
    expect(written?.providers).toEqual([disney, cinema]); // [B, C]
    expect(written?.previousSnapshot).toEqual([netflix, disney]); // [A, B], NOT [X]
    expect(written?.lastSyncedAt).toBe(FIXED_NOW);

    // Transitions: C added, A removed.
    expect(results[0].transitions).toHaveLength(2);
    expect(results[0].transitions).toContainEqual({
      region: 'NL',
      providerId: 99,
      name: 'Cinema',
      type: 'buy',
      kind: 'added',
    });
    expect(results[0].transitions).toContainEqual({
      region: 'NL',
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate',
      kind: 'removed',
    });
  });

  it('writes each region independently across a multi-region map', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({
          NL: [netflix],
          DE: [disney],
          US: [apple],
        }),
      ),
    });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    const av = store.availability.get(603) ?? {};
    expect(av.NL?.providers).toEqual([netflix]);
    expect(av.DE?.providers).toEqual([disney]);
    expect(av.US?.providers).toEqual([apple]);
    expect(av.GB).toBeUndefined(); // absent region → no write
    expect(results[0].transitions).toHaveLength(3);
  });

  it('writes the entry but no availability when getWatchProviders is null', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>(null),
      ),
    });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(store.entries.get(603)).toBeDefined();
    expect(store.availability.get(603)).toBeUndefined();
    expect(results[0].outcome).toBe('synced');
    expect(results[0].transitions).toEqual([]);
  });

  it('skips a title when metadata is null (TMDB 404), with no writes', async () => {
    const tmdb = createTmdbMock({
      getMovie: vi.fn(() => Promise.resolve<TitleMetadata | null>(null)),
    });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(store.entries.get(603)).toBeUndefined();
    expect(store.availability.get(603)).toBeUndefined();
    expect(tmdb.getWatchProviders).not.toHaveBeenCalled();
    expect(results[0]).toEqual({
      tmdbId: 603,
      type: 'movie',
      outcome: 'skipped',
      transitions: [],
      reason: 'title not found in TMDB',
    });
  });

  it('isolates a per-title error: middle title throws, others sync, no escape', async () => {
    const getMovie = vi
      .fn()
      .mockResolvedValueOnce(movieMeta)
      .mockRejectedValueOnce(new TmdbError('boom', 500, '/movie/2'))
      .mockResolvedValueOnce(movieMeta);
    const tmdb = createTmdbMock({ getMovie });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([
      { tmdbId: 1, type: 'movie' },
      { tmdbId: 2, type: 'movie' },
      { tmdbId: 3, type: 'movie' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].outcome).toBe('synced');
    expect(results[1].outcome).toBe('error');
    expect(results[1].errorStatus).toBe(500);
    expect(results[1].reason).toContain('TmdbError');
    expect(results[2].outcome).toBe('synced');
  });

  it('records an error when getWatchProviders throws after the entry was written', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.reject(
          new TmdbError('boom', 503, '/movie/603/watch/providers'),
        ),
      ),
    });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    // Entry was written before the throw (partial success), but outcome is error.
    expect(store.entries.get(603)).toBeDefined();
    expect(store.availability.get(603)).toBeUndefined();
    expect(results[0].outcome).toBe('error');
    expect(results[0].errorStatus).toBe(503);
  });

  it('never calls getShowTraktId for a movie but always does for tv', async () => {
    const tmdb = createTmdbMock();
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    await engine.sync([
      { tmdbId: 1, type: 'movie' },
      { tmdbId: 2, type: 'tv' },
    ]);

    expect(trakt.getShowTraktId).toHaveBeenCalledTimes(1);
    expect(trakt.getShowTraktId).toHaveBeenCalledWith(2);
  });

  it('uses the injected clock for every lastSyncedAt written', async () => {
    const stamps = ['t0', 't1', 't2', 't3'];
    let i = 0;
    const now = vi.fn(() => stamps[i++] ?? 'overflow');
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({
          NL: [netflix],
          DE: [disney],
        }),
      ),
    });
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now,
    });

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    // now() is read once per write: entry + two regions = 3 reads.
    expect(store.entries.get(603)?.lastSyncedAt).toBe('t0');
    expect(store.availability.get(603)?.NL?.lastSyncedAt).toBe('t1');
    expect(store.availability.get(603)?.DE?.lastSyncedAt).toBe('t2');
    expect(now).toHaveBeenCalledTimes(3);
  });

  it('returns [] and touches nothing for an empty batch', async () => {
    const tmdb = createTmdbMock();
    const trakt = createTraktMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      trakt: trakt.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([]);

    expect(results).toEqual([]);
    expect(tmdb.getMovie).not.toHaveBeenCalled();
    expect(tmdb.getTvShow).not.toHaveBeenCalled();
    expect(tmdb.getWatchProviders).not.toHaveBeenCalled();
    expect(trakt.getShowTraktId).not.toHaveBeenCalled();
    expect(store.entries.size).toBe(0);
  });
});
