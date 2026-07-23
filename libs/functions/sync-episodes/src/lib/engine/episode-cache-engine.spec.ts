import { describe, expect, it, vi } from 'vitest';
import type { Episode, EpisodeDoc, WatchStatus } from '@vultus/shared/domain';
import { createEpisodeCacheEngine } from './episode-cache-engine';
import type {
  EpisodeStore,
  TitleCacheEpisodeStore,
  TmdbEpisodeSource,
  WatchlistNextWatchableStore,
  WatchlistStatusStore,
} from '../ports';

// --- Fakes (no Firebase, no network) -------------------------------------

function ep(
  season: number,
  episode: number,
  title = `t${season}-${episode}`,
): Episode {
  return {
    season,
    episode,
    title,
    airDate: `2026-0${season}-0${episode}T00:00:00.000Z`,
  };
}

/** A TMDB source backed by an in-memory map of season -> episodes (or null).
 *  Returns the individual spies so assertions reference them directly (avoids
 *  the unbound-method rule that firing off `tmdb.getSeasonCount` would trip). */
function fakeTmdb(opts: {
  count: number | null;
  seasons?: Record<number, Episode[] | null>;
}) {
  const getSeasonCount = vi.fn(() => Promise.resolve(opts.count));
  const getSeasonEpisodes = vi.fn((_tmdbId: number, season: number) => {
    const eps = opts.seasons?.[season];
    return Promise.resolve(eps === undefined ? [] : eps);
  });
  const tmdb: TmdbEpisodeSource = { getSeasonCount, getSeasonEpisodes };
  return { tmdb, getSeasonCount, getSeasonEpisodes };
}

/** An in-memory global episode cache store keyed by tmdbId → id → Episode.
 *  `upsertCachedEpisodes` overwrites by id (idempotent on re-run). */
function fakeCacheStore(
  seed: Record<number, { id: string; episode: Episode }[]> = {},
) {
  const store = new Map<number, Map<string, Episode>>();
  for (const [tmdbId, entries] of Object.entries(seed)) {
    const m = new Map<string, Episode>();
    for (const { id, episode } of entries) m.set(id, episode);
    store.set(Number(tmdbId), m);
  }
  const getCachedEpisodes = vi.fn((tmdbId: number): Promise<Episode[]> => {
    const m = store.get(tmdbId);
    return Promise.resolve(m ? [...m.values()] : []);
  });
  const upsertCachedEpisodes = vi.fn(
    (
      tmdbId: number,
      episodes: { id: string; episode: Episode }[],
    ): Promise<void> => {
      const m = store.get(tmdbId) ?? new Map<string, Episode>();
      for (const { id, episode } of episodes) m.set(id, episode);
      store.set(tmdbId, m);
      return Promise.resolve();
    },
  );
  const cache: TitleCacheEpisodeStore = {
    getCachedEpisodes,
    upsertCachedEpisodes,
  };
  return { cache, store, getCachedEpisodes, upsertCachedEpisodes };
}

/** A per-user episode store with a scripted set of existing ids; records writes. */
function fakeEpisodeStore(existing: string[] = []) {
  const writes: {
    uid: string;
    titleId: string;
    docs: { id: string; doc: EpisodeDoc }[];
  }[] = [];
  const getExistingEpisodeIds = vi.fn(
    (): Promise<Set<string>> => Promise.resolve(new Set(existing)),
  );
  const writeEpisodes = vi.fn(
    (
      uid: string,
      titleId: string,
      docs: { id: string; doc: EpisodeDoc }[],
    ): Promise<void> => {
      writes.push({ uid, titleId, docs });
      return Promise.resolve();
    },
  );
  const store: EpisodeStore = { getExistingEpisodeIds, writeEpisodes };
  return { store, writes, getExistingEpisodeIds, writeEpisodes };
}

function fakeStatusStore(current: WatchStatus | null) {
  const getStatus = vi.fn(
    (): Promise<WatchStatus | null> => Promise.resolve(current),
  );
  const setStatus = vi.fn((): Promise<void> => Promise.resolve());
  const store: WatchlistStatusStore = { getStatus, setStatus };
  return { store, getStatus, setStatus };
}

function fakeNextWatchableStore(
  watchState: { airDate: string; watched: boolean }[] = [],
) {
  const readEpisodeWatchState = vi.fn(
    (): Promise<{ airDate: string; watched: boolean }[]> =>
      Promise.resolve(watchState),
  );
  const setNextUnwatchedEpisodeAirDate = vi.fn(
    (): Promise<void> => Promise.resolve(),
  );
  const store: WatchlistNextWatchableStore = {
    readEpisodeWatchState,
    setNextUnwatchedEpisodeAirDate,
  };
  return { store, readEpisodeWatchState, setNextUnwatchedEpisodeAirDate };
}

// --- cacheShowEpisodes ---------------------------------------------------

describe('createEpisodeCacheEngine.cacheShowEpisodes', () => {
  it('fetches each season once and upserts all episodes keyed by episodeId', async () => {
    const { tmdb, getSeasonEpisodes } = fakeTmdb({
      count: 2,
      seasons: { 1: [ep(1, 1), ep(1, 2)], 2: [ep(2, 1)] },
    });
    const { cache, store, upsertCachedEpisodes } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ tmdb, cache });

    const result = await engine.cacheShowEpisodes(100);

    expect(result.outcome).toBe('cached');
    expect(result.seasonsFetched).toBe(2);
    expect(result.episodesCached).toBe(3);
    // getSeasonEpisodes called exactly once per season (fetch-once).
    expect(getSeasonEpisodes).toHaveBeenCalledTimes(2);
    expect(upsertCachedEpisodes).toHaveBeenCalledTimes(1);
    const cachedIds = [...(store.get(100)?.keys() ?? [])].sort();
    expect(cachedIds).toEqual(['s01e001', 's01e002', 's02e001']);
  });

  it('is idempotent — a re-run upserts the SAME ids (no duplicate keys)', async () => {
    const { tmdb } = fakeTmdb({
      count: 1,
      seasons: { 1: [ep(1, 1), ep(1, 2)] },
    });
    const { cache, store } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ tmdb, cache });

    const first = await engine.cacheShowEpisodes(100);
    const idsAfterFirst = [...(store.get(100)?.keys() ?? [])].sort();
    const second = await engine.cacheShowEpisodes(100);
    const idsAfterSecond = [...(store.get(100)?.keys() ?? [])].sort();

    expect(first.episodesCached).toBe(2);
    expect(second.episodesCached).toBe(2);
    expect(idsAfterFirst).toEqual(['s01e001', 's01e002']);
    // Re-run keyed the same ids — no growth, no duplicates.
    expect(idsAfterSecond).toEqual(idsAfterFirst);
  });

  it('show not found in TMDB (null season count) → skipped, cache untouched', async () => {
    const { tmdb } = fakeTmdb({ count: null });
    const { cache, upsertCachedEpisodes } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ tmdb, cache });

    const result = await engine.cacheShowEpisodes(100);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('show not found in TMDB');
    expect(upsertCachedEpisodes).not.toHaveBeenCalled();
  });

  it('a null season fetch contributes zero; other seasons still cache', async () => {
    const { tmdb } = fakeTmdb({
      count: 2,
      seasons: { 1: null, 2: [ep(2, 1)] },
    });
    const { cache, store } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ tmdb, cache });

    const result = await engine.cacheShowEpisodes(100);

    expect(result.outcome).toBe('cached');
    expect(result.episodesCached).toBe(1);
    expect([...(store.get(100)?.keys() ?? [])]).toEqual(['s02e001']);
  });

  it('skips null-air-date episodes (spec 0047) — never cached', async () => {
    const nullAir = { ...ep(1, 2), airDate: null as unknown as string };
    const { tmdb } = fakeTmdb({
      count: 1,
      seasons: { 1: [ep(1, 1), nullAir] },
    });
    const { cache, store } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ tmdb, cache });

    const result = await engine.cacheShowEpisodes(100);

    expect(result.episodesCached).toBe(1);
    expect([...(store.get(100)?.keys() ?? [])]).toEqual(['s01e001']);
  });

  it('throws if cacheShowEpisodes is called without a tmdb source', async () => {
    const { cache } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ cache });

    await expect(engine.cacheShowEpisodes(100)).rejects.toThrow(/tmdb/);
  });
});

// --- fanoutUserEpisodes --------------------------------------------------

describe('createEpisodeCacheEngine.fanoutUserEpisodes', () => {
  it('writes per-user docs from the cache and makes ZERO TMDB calls', async () => {
    const { tmdb, getSeasonCount, getSeasonEpisodes } = fakeTmdb({
      count: 5,
      seasons: {},
    });
    const { cache } = fakeCacheStore({
      100: [
        { id: 's01e001', episode: ep(1, 1) },
        { id: 's01e002', episode: ep(1, 2) },
      ],
    });
    const { store, writes } = fakeEpisodeStore([]);
    const engine = createEpisodeCacheEngine({ tmdb, cache, episodes: store });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(result.outcome).toBe('synced');
    expect(result.episodesWritten).toBe(2);
    expect(writes[0].docs.map((d) => d.id).sort()).toEqual([
      's01e001',
      's01e002',
    ]);
    // The whole point of the cache: fan-out never touches TMDB.
    expect(getSeasonCount).not.toHaveBeenCalled();
    expect(getSeasonEpisodes).not.toHaveBeenCalled();
  });

  it('is insert-only — never overwrites an already-watched doc', async () => {
    const { cache } = fakeCacheStore({
      100: [
        { id: 's01e001', episode: ep(1, 1) },
        { id: 's01e002', episode: ep(1, 2) },
        { id: 's01e003', episode: ep(1, 3) },
      ],
    });
    // s01e001 already exists (user watched it); only new ids may be written.
    const { store, writes } = fakeEpisodeStore(['s01e001', 's01e002']);
    const engine = createEpisodeCacheEngine({ cache, episodes: store });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(1);
    expect(writes[0].docs.map((d) => d.id)).toEqual(['s01e003']);
    // The pre-existing watched doc id is never in the write payload.
    expect(writes[0].docs.map((d) => d.id)).not.toContain('s01e001');
    const fresh = writes[0].docs[0].doc;
    expect(fresh.watched).toBe(false);
    expect(fresh.watchedAt).toBeNull();
  });

  it('empty cache → writes [] and episodesWritten 0 (no error)', async () => {
    const { cache } = fakeCacheStore(); // nothing cached for tmdbId 100
    const { store, writes, writeEpisodes } = fakeEpisodeStore([]);
    const engine = createEpisodeCacheEngine({ cache, episodes: store });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(0);
    expect(writeEpisodes).toHaveBeenCalledTimes(1);
    expect(writes[0].docs).toEqual([]);
  });

  it('skips null-air-date cache entries defensively (spec 0047)', async () => {
    const nullAir = { ...ep(1, 2), airDate: null as unknown as string };
    const { cache } = fakeCacheStore({
      100: [
        { id: 's01e001', episode: ep(1, 1) },
        { id: 's01e002', episode: nullAir },
      ],
    });
    const { store, writes } = fakeEpisodeStore([]);
    const engine = createEpisodeCacheEngine({ cache, episodes: store });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(1);
    expect(writes[0].docs.map((d) => d.id)).toEqual(['s01e001']);
  });

  it('reverts a completed show to watching when ≥1 new episode is inserted (spec 0074)', async () => {
    const { cache } = fakeCacheStore({
      100: [
        { id: 's01e001', episode: ep(1, 1) },
        { id: 's01e002', episode: ep(1, 2) },
      ],
    });
    const { store } = fakeEpisodeStore(['s01e001']); // s01e002 is new
    const { store: statusStore, setStatus } = fakeStatusStore('completed');
    const engine = createEpisodeCacheEngine({
      cache,
      episodes: store,
      watchlistStatus: statusStore,
    });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(1);
    expect(setStatus).toHaveBeenCalledWith('u1', 'title-1', 'watching');
    expect(result.statusRevertedToWatching).toBe(true);
  });

  it('does NOT revert when nothing new is inserted (spec 0074 gate)', async () => {
    const { cache } = fakeCacheStore({
      100: [{ id: 's01e001', episode: ep(1, 1) }],
    });
    const { store } = fakeEpisodeStore(['s01e001']); // nothing new
    const {
      store: statusStore,
      getStatus,
      setStatus,
    } = fakeStatusStore('completed');
    const engine = createEpisodeCacheEngine({
      cache,
      episodes: store,
      watchlistStatus: statusStore,
    });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(0);
    expect(getStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(result.statusRevertedToWatching).toBe(false);
  });

  it('recomputes nextUnwatchedEpisodeAirDate from cache-driven writes (spec 0081)', async () => {
    const { cache } = fakeCacheStore({
      100: [
        { id: 's01e001', episode: ep(1, 1) },
        { id: 's01e002', episode: ep(1, 2) },
      ],
    });
    const { store } = fakeEpisodeStore(['s01e001']); // s01e002 is new
    // Post-write read: one watched, two unwatched — min over unwatched wins.
    const { store: nextStore, setNextUnwatchedEpisodeAirDate } =
      fakeNextWatchableStore([
        { airDate: '2026-01-01T00:00:00.000Z', watched: true },
        { airDate: '2026-03-05T00:00:00.000Z', watched: false },
        { airDate: '2026-02-10T00:00:00.000Z', watched: false },
      ]);
    const engine = createEpisodeCacheEngine({
      cache,
      episodes: store,
      nextWatchable: nextStore,
    });

    await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(setNextUnwatchedEpisodeAirDate).toHaveBeenCalledWith(
      'u1',
      'title-1',
      '2026-02-10T00:00:00.000Z',
    );
  });

  it('does NOT recompute when nothing new is inserted (spec 0081 gate)', async () => {
    const { cache } = fakeCacheStore({
      100: [{ id: 's01e001', episode: ep(1, 1) }],
    });
    const { store } = fakeEpisodeStore(['s01e001']); // nothing new
    const {
      store: nextStore,
      readEpisodeWatchState,
      setNextUnwatchedEpisodeAirDate,
    } = fakeNextWatchableStore([
      { airDate: '2026-01-01T00:00:00.000Z', watched: false },
    ]);
    const engine = createEpisodeCacheEngine({
      cache,
      episodes: store,
      nextWatchable: nextStore,
    });

    await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(readEpisodeWatchState).not.toHaveBeenCalled();
    expect(setNextUnwatchedEpisodeAirDate).not.toHaveBeenCalled();
  });

  it('both spec-0074 and spec-0081 post-write steps fire independently in one run', async () => {
    const { cache } = fakeCacheStore({
      100: [
        { id: 's01e001', episode: ep(1, 1) },
        { id: 's01e002', episode: ep(1, 2) },
      ],
    });
    const { store } = fakeEpisodeStore(['s01e001']); // s01e002 is new
    const { store: statusStore, setStatus } = fakeStatusStore('completed');
    const { store: nextStore, setNextUnwatchedEpisodeAirDate } =
      fakeNextWatchableStore([
        { airDate: '2026-01-01T00:00:00.000Z', watched: true },
        { airDate: '2026-01-02T00:00:00.000Z', watched: false },
      ]);
    const engine = createEpisodeCacheEngine({
      cache,
      episodes: store,
      watchlistStatus: statusStore,
      nextWatchable: nextStore,
    });

    const result = await engine.fanoutUserEpisodes('u1', 'title-1', 100);

    expect(setStatus).toHaveBeenCalledWith('u1', 'title-1', 'watching');
    expect(result.statusRevertedToWatching).toBe(true);
    expect(setNextUnwatchedEpisodeAirDate).toHaveBeenCalledWith(
      'u1',
      'title-1',
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('throws if fanoutUserEpisodes is called without a per-user episode store', async () => {
    const { cache } = fakeCacheStore();
    const engine = createEpisodeCacheEngine({ cache });

    await expect(
      engine.fanoutUserEpisodes('u1', 'title-1', 100),
    ).rejects.toThrow(/episodes/);
  });
});

// --- cache → fan-out integration (fetch-once, share across users) --------

describe('createEpisodeCacheEngine — cache once, fan out to many users', () => {
  it('one cache fetch serves multiple users with zero further TMDB calls', async () => {
    const { tmdb, getSeasonCount, getSeasonEpisodes } = fakeTmdb({
      count: 1,
      seasons: { 1: [ep(1, 1), ep(1, 2)] },
    });
    const { cache } = fakeCacheStore();
    const cacheEngine = createEpisodeCacheEngine({ tmdb, cache });

    await cacheEngine.cacheShowEpisodes(100);
    const tmdbCallsAfterCache =
      getSeasonCount.mock.calls.length + getSeasonEpisodes.mock.calls.length;

    // Two users track the same show; each fans out from the shared cache.
    const u1 = fakeEpisodeStore([]);
    const u2 = fakeEpisodeStore([]);
    const fanU1 = createEpisodeCacheEngine({ cache, episodes: u1.store });
    const fanU2 = createEpisodeCacheEngine({ cache, episodes: u2.store });

    const r1 = await fanU1.fanoutUserEpisodes('u1', 'tA', 100);
    const r2 = await fanU2.fanoutUserEpisodes('u2', 'tA', 100);

    expect(r1.episodesWritten).toBe(2);
    expect(r2.episodesWritten).toBe(2);
    // No additional TMDB calls beyond the single cache fetch.
    const tmdbCallsAfterFanout =
      getSeasonCount.mock.calls.length + getSeasonEpisodes.mock.calls.length;
    expect(tmdbCallsAfterFanout).toBe(tmdbCallsAfterCache);
  });
});
