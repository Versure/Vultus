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
import { TmdbError } from '../tmdb/tmdb-error';
import type {
  WatchmodeClient,
  WatchmodeSource,
} from '../watchmode/watchmode-client';

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
  getEntry: ReturnType<typeof vi.fn>;
} {
  const entries = new Map<number, TitleCacheEntry>();
  const availability = new Map<
    number,
    Partial<Record<Region, RegionAvailability>>
  >();
  const getEntry = vi.fn((tmdbId: number) =>
    Promise.resolve(entries.get(tmdbId) ?? null),
  );
  return {
    entries,
    availability,
    getEntry,
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

function createWatchmodeMock(overrides: Partial<WatchmodeClient> = {}) {
  const resolveTitleId =
    overrides.resolveTitleId ??
    vi.fn(() => Promise.resolve<number | null>(555));
  const getTitleSources =
    overrides.getTitleSources ??
    vi.fn(() => Promise.resolve<WatchmodeSource[] | null>([]));
  const client: WatchmodeClient = { resolveTitleId, getTitleSources };
  return { client, resolveTitleId, getTitleSources };
}

// Crosswalk source_id 203 → TMDB Netflix (providerId 8); 372 → Disney Plus (337).
const wmNetflixSource: WatchmodeSource = {
  sourceId: 203,
  type: 'sub',
  region: 'NL',
};

describe('createSyncEngine', () => {
  let store: ReturnType<typeof createFakeStore>;

  beforeEach(() => {
    store = createFakeStore();
  });

  it('syncs a movie: writes entry and availability', async () => {
    const tmdb = createTmdbMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(store.entries.get(603)).toEqual({
      type: 'movie',
      metadata: movieMeta,
      lastSyncedAt: FIXED_NOW,
      // The engine always writes watchmodeId (preserving any cached id; null
      // here — no Watchmode configured). Spec 0099.
      watchmodeId: null,
    });
    expect(store.availability.get(603)?.NL).toEqual({
      providers: [netflix],
      previousSnapshot: [],
      lastSyncedAt: FIXED_NOW,
      // Provenance marker written on every availability doc (spec 0099).
      source: 'tmdb',
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

  it('syncs a tv show: writes entry + availability with only tmdb + store in the config', async () => {
    const tmdb = createTmdbMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 1396, type: 'tv' }]);

    expect(tmdb.getTvShow).toHaveBeenCalledWith(1396);
    expect(store.entries.get(1396)).toEqual({
      type: 'tv',
      metadata: tvMeta,
      lastSyncedAt: FIXED_NOW,
      watchmodeId: null,
    });
    expect(store.availability.get(1396)?.NL?.source).toBe('tmdb');
    expect(results[0].outcome).toBe('synced');
  });

  it('does NOT load the cache entry for a tv title when no Watchmode client is configured', async () => {
    const tmdb = createTmdbMock();
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
    });

    await engine.sync([{ tmdbId: 1396, type: 'tv' }]);

    // A tv title no longer needs the entry loaded unless Watchmode is
    // configured for watchmodeId reuse.
    expect(store.getEntry).not.toHaveBeenCalled();
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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

  it('maps a TmdbError status into errorStatus', async () => {
    const tmdb = createTmdbMock({
      getMovie: vi.fn(() =>
        Promise.reject(new TmdbError('unauthorized', 401, '/movie/603')),
      ),
    });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(results[0].outcome).toBe('error');
    expect(results[0].errorStatus).toBe(401);
    expect(results[0].reason).toContain('TmdbError');
  });

  it('records an error when getWatchProviders throws after the entry was written', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.reject(
          new TmdbError('boom', 503, '/movie/603/watch/providers'),
        ),
      ),
    });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
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
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
    });

    const results = await engine.sync([]);

    expect(results).toEqual([]);
    expect(tmdb.getMovie).not.toHaveBeenCalled();
    expect(tmdb.getTvShow).not.toHaveBeenCalled();
    expect(tmdb.getWatchProviders).not.toHaveBeenCalled();
    expect(store.entries.size).toBe(0);
  });
});

describe('createSyncEngine — second-pass retry (D2)', () => {
  let store: ReturnType<typeof createFakeStore>;

  beforeEach(() => {
    store = createFakeStore();
  });

  it('re-runs a retryable (429) error on a second pass and ends synced, writing availability', async () => {
    const getMovie = vi
      .fn()
      .mockRejectedValueOnce(new TmdbError('rate limit', 429, '/movie/1'))
      .mockResolvedValueOnce(movieMeta);
    const tmdb = createTmdbMock({ getMovie });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
      retryErroredPasses: 1,
      retryDelayMs: 0,
    });

    const results = await engine.sync([{ tmdbId: 1, type: 'movie' }]);

    expect(getMovie).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('synced');
    // The availability write that the first pass never reached now happened.
    expect(store.availability.get(1)?.NL).toBeDefined();
  });

  it('does NOT re-run a non-retryable (401) error even with retry passes enabled', async () => {
    const getMovie = vi
      .fn()
      .mockRejectedValue(new TmdbError('unauthorized', 401, '/movie/1'));
    const tmdb = createTmdbMock({ getMovie });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
      retryErroredPasses: 2,
      retryDelayMs: 0,
    });

    const results = await engine.sync([{ tmdbId: 1, type: 'movie' }]);

    expect(getMovie).toHaveBeenCalledTimes(1); // never re-tried
    expect(results[0].outcome).toBe('error');
    expect(results[0].errorStatus).toBe(401);
  });

  it('retryErroredPasses: 0 (default) reproduces current behavior — a 429 stays error, not re-tried', async () => {
    const getMovie = vi
      .fn()
      .mockRejectedValue(new TmdbError('rate limit', 429, '/movie/1'));
    const tmdb = createTmdbMock({ getMovie });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
      // retryErroredPasses omitted → default 0
    });

    const results = await engine.sync([{ tmdbId: 1, type: 'movie' }]);

    expect(getMovie).toHaveBeenCalledTimes(1);
    expect(results[0].outcome).toBe('error');
    expect(results[0].errorStatus).toBe(429);
  });

  it('preserves input order and one result per title while retrying a subset', async () => {
    // title 1 always ok; title 2 429s then succeeds; title 3 ok.
    const getMovie = vi
      .fn()
      .mockResolvedValueOnce(movieMeta) // pass1 title1
      .mockRejectedValueOnce(new TmdbError('rate', 429, '/movie/2')) // pass1 title2
      .mockResolvedValueOnce(movieMeta) // pass1 title3
      .mockResolvedValueOnce(movieMeta); // pass2 title2 retry
    const tmdb = createTmdbMock({ getMovie });
    const engine = createSyncEngine({
      tmdb: tmdb.client,
      store,
      now: () => FIXED_NOW,
      retryErroredPasses: 1,
      retryDelayMs: 0,
    });

    const results = await engine.sync([
      { tmdbId: 1, type: 'movie' },
      { tmdbId: 2, type: 'movie' },
      { tmdbId: 3, type: 'movie' },
    ]);

    expect(results.map((r) => r.tmdbId)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.outcome)).toEqual([
      'synced',
      'synced',
      'synced',
    ]);
  });
});

describe('createSyncEngine — Watchmode fallback (spec 0099)', () => {
  let store: ReturnType<typeof createFakeStore>;

  beforeEach(() => {
    store = createFakeStore();
  });

  function engineWith(
    tmdb: TmdbClient,
    watchmode: WatchmodeClient | undefined,
    activeRegions: Region[],
  ) {
    return createSyncEngine({
      tmdb,
      store,
      now: () => FIXED_NOW,
      watchmode,
      activeRegions,
    });
  }

  it('NO GAP: TMDB flatrate in the active region → Watchmode is NOT called; source tmdb', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [netflix] }),
      ),
    });
    const wm = createWatchmodeMock();
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(wm.resolveTitleId).not.toHaveBeenCalled();
    expect(wm.getTitleSources).not.toHaveBeenCalled();
    expect(store.availability.get(603)?.NL?.providers).toEqual([netflix]);
    expect(store.availability.get(603)?.NL?.source).toBe('tmdb');
    expect(results[0].outcome).toBe('synced');
  });

  it('GAP FILLED: TMDB empty in active region, Watchmode returns a sub → merged, source watchmode, added transition', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    const written = store.availability.get(603)?.NL;
    expect(written?.providers).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
    expect(written?.source).toBe('watchmode');
    expect(results[0].transitions).toContainEqual({
      region: 'NL',
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate',
      kind: 'added',
    });
  });

  it('GAP, Watchmode returns an unmapped source_id → drop is logged (decision 3), title still filled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const tmdb = createTmdbMock({
        getWatchProviders: vi.fn(() =>
          Promise.resolve<RegionProviders | null>({ NL: [] }),
        ),
      });
      const wm = createWatchmodeMock({
        getTitleSources: vi.fn(() =>
          Promise.resolve<WatchmodeSource[] | null>([
            wmNetflixSource,
            // sourceId 999 has no crosswalk entry → dropped, must be logged.
            { sourceId: 999, type: 'sub', region: 'NL' },
          ]),
        ),
      });
      const engine = engineWith(tmdb.client, wm.client, ['NL']);

      await engine.sync([{ tmdbId: 603, type: 'movie' }]);

      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0]);
      expect(msg).toContain('603');
      expect(msg).toContain('1');
    } finally {
      warn.mockRestore();
    }
  });

  it('GAP, rent/buy-only still counts as a gap → Watchmode fills flatrate on top', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(
        () => Promise.resolve<RegionProviders | null>({ NL: [apple] }), // rent only
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    const written = store.availability.get(603)?.NL;
    // TMDB rent entry preserved; Watchmode flatrate appended.
    expect(written?.providers).toEqual([
      apple,
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
    expect(written?.source).toBe('watchmode');
  });

  it('GAP, Watchmode CONFIRMS empty (no sub) → TMDB-only written, removed fires when prev had flatrate', async () => {
    store.availability.set(603, {
      NL: { providers: [netflix], previousSnapshot: [], lastSyncedAt: 'old' },
    });
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>([]),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    const written = store.availability.get(603)?.NL;
    expect(written?.providers).toEqual([]); // TMDB-only (empty)
    expect(written?.source).toBe('tmdb');
    expect(results[0].transitions).toContainEqual({
      region: 'NL',
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate',
      kind: 'removed',
    });
  });

  it('GAP, Watchmode UNAVAILABLE (getTitleSources → null) → write SKIPPED, no false removed', async () => {
    store.availability.set(603, {
      NL: { providers: [netflix], previousSnapshot: [], lastSyncedAt: 'old' },
    });
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>(null),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    // The stored providers carry forward unchanged (no overwrite with []).
    expect(store.availability.get(603)?.NL?.providers).toEqual([netflix]);
    expect(store.availability.get(603)?.NL?.lastSyncedAt).toBe('old');
    expect(results[0].transitions).toEqual([]);
    expect(results[0].outcome).toBe('synced');
  });

  it('GAP, Watchmode UNAVAILABLE (resolveTitleId → null) → write SKIPPED, no removed', async () => {
    store.availability.set(603, {
      NL: { providers: [netflix], previousSnapshot: [], lastSyncedAt: 'old' },
    });
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const getTitleSources = vi.fn(() =>
      Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
    );
    const wm = createWatchmodeMock({
      resolveTitleId: vi.fn(() => Promise.resolve<number | null>(null)),
      getTitleSources,
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    // Unresolved id → getTitleSources never called, write skipped.
    expect(getTitleSources).not.toHaveBeenCalled();
    expect(store.availability.get(603)?.NL?.providers).toEqual([netflix]);
    expect(results[0].transitions).toEqual([]);
  });

  it('GAP, Watchmode UNAVAILABLE (getTitleSources throws) → write SKIPPED, title does NOT error', async () => {
    store.availability.set(603, {
      NL: { providers: [netflix], previousSnapshot: [], lastSyncedAt: 'old' },
    });
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() => Promise.reject(new Error('watchmode down'))),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(store.availability.get(603)?.NL?.providers).toEqual([netflix]);
    expect(results[0].outcome).toBe('synced'); // NOT 'error'
    expect(results[0].transitions).toEqual([]);
  });

  it('NEVER OVERRIDE: a Watchmode sub with the same providerId as a TMDB rent entry does not duplicate/replace it', async () => {
    // TMDB rent Netflix (id 8); Watchmode sub also maps to Netflix (id 8).
    const tmdbNetflixRent: WatchProvider = {
      providerId: 8,
      name: 'Netflix',
      type: 'rent',
    };
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [tmdbNetflixRent] }),
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    const written = store.availability.get(603)?.NL;
    // The TMDB rent entry wins (kept, not replaced by the Watchmode flatrate).
    expect(written?.providers).toEqual([tmdbNetflixRent]);
  });

  it('CACHING: a cached watchmodeId is reused (no resolveTitleId call)', async () => {
    store.entries.set(603, {
      type: 'movie',
      metadata: movieMeta,
      lastSyncedAt: 'old',
      watchmodeId: 777,
    });
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const getTitleSources = vi.fn(() =>
      Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
    );
    const wm = createWatchmodeMock({ getTitleSources });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(wm.resolveTitleId).not.toHaveBeenCalled();
    expect(getTitleSources).toHaveBeenCalledWith(777, ['NL']);
    // Cached id preserved on the entry.
    expect(store.entries.get(603)?.watchmodeId).toBe(777);
  });

  it('CACHING: a freshly resolved watchmodeId is written back to the entry', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [] }),
      ),
    });
    const wm = createWatchmodeMock({
      resolveTitleId: vi.fn(() => Promise.resolve<number | null>(888)),
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(wm.resolveTitleId).toHaveBeenCalledTimes(1);
    expect(store.entries.get(603)?.watchmodeId).toBe(888);
  });

  it('BATCHING: multiple gap regions produce a SINGLE getTitleSources call', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [], DE: [] }),
      ),
    });
    const getTitleSources = vi.fn(() =>
      Promise.resolve<WatchmodeSource[] | null>([
        { sourceId: 203, type: 'sub', region: 'NL' },
        { sourceId: 372, type: 'sub', region: 'DE' },
      ]),
    );
    const wm = createWatchmodeMock({ getTitleSources });
    const engine = engineWith(tmdb.client, wm.client, ['NL', 'DE']);

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(getTitleSources).toHaveBeenCalledTimes(1);
    const [, regionsArg] = getTitleSources.mock.calls[0];
    expect(new Set(regionsArg)).toEqual(new Set(['NL', 'DE']));
    expect(store.availability.get(603)?.NL?.source).toBe('watchmode');
    expect(store.availability.get(603)?.DE?.source).toBe('watchmode');
  });

  it('NON-ACTIVE region is written exactly as today (source tmdb), never gap-filled', async () => {
    // NL (active) HAS flatrate → no gap → Watchmode never called; US is
    // non-active and empty → written as TMDB, never gap-filled.
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>({ NL: [netflix], US: [] }),
      ),
    });
    const wm = createWatchmodeMock();
    const engine = engineWith(tmdb.client, wm.client, ['NL']); // active NL only

    await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    // US (non-active) written as TMDB-empty; Watchmode not consulted at all.
    expect(store.availability.get(603)?.US?.providers).toEqual([]);
    expect(store.availability.get(603)?.US?.source).toBe('tmdb');
    expect(store.availability.get(603)?.NL?.source).toBe('tmdb');
    expect(wm.getTitleSources).not.toHaveBeenCalled();
  });

  it('NULL TMDB + active region + Watchmode → gap-filled (early return removed)', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>(null),
      ),
    });
    const wm = createWatchmodeMock({
      getTitleSources: vi.fn(() =>
        Promise.resolve<WatchmodeSource[] | null>([wmNetflixSource]),
      ),
    });
    const engine = engineWith(tmdb.client, wm.client, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(store.availability.get(603)?.NL?.providers).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
    expect(store.availability.get(603)?.NL?.source).toBe('watchmode');
    expect(results[0].outcome).toBe('synced');
  });

  it('NULL TMDB + no active region → nothing written, synced / no watch providers', async () => {
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>(null),
      ),
    });
    const wm = createWatchmodeMock();
    const engine = engineWith(tmdb.client, wm.client, []); // no active regions

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    expect(store.availability.get(603)).toBeUndefined();
    expect(wm.getTitleSources).not.toHaveBeenCalled();
    expect(results[0].outcome).toBe('synced');
    expect(results[0].reason).toBe('no watch providers');
  });

  it('NO CLIENT (no key): active-region gap is NOT expanded — behaves byte-for-byte as today', async () => {
    store.availability.set(603, {
      NL: { providers: [netflix], previousSnapshot: [], lastSyncedAt: 'old' },
    });
    // TMDB returns NL absent (null block) → with no Watchmode client and no
    // union expansion, NL is not iterated → its stored doc is untouched.
    const tmdb = createTmdbMock({
      getWatchProviders: vi.fn(() =>
        Promise.resolve<RegionProviders | null>(null),
      ),
    });
    const engine = engineWith(tmdb.client, undefined, ['NL']);

    const results = await engine.sync([{ tmdbId: 603, type: 'movie' }]);

    // No overwrite, no false removed — exactly today's no-fallback behavior.
    expect(store.availability.get(603)?.NL?.providers).toEqual([netflix]);
    expect(results[0].transitions).toEqual([]);
    expect(results[0].outcome).toBe('synced');
  });
});
