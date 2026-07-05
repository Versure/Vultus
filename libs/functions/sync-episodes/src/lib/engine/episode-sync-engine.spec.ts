import { describe, expect, it, vi } from 'vitest';
import type { Episode, EpisodeDoc, WatchStatus } from '@vultus/shared/domain';
import { createEpisodeSyncEngine } from './episode-sync-engine';
import type {
  EpisodeStore,
  TmdbEpisodeSource,
  WatchlistStatusStore,
  WatchlistTvShow,
  WatchlistTvSource,
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

/** A TMDB source backed by an in-memory map of season -> episodes (or null). */
function fakeTmdb(opts: {
  count: number | null;
  seasons?: Record<number, Episode[] | null>;
  throwOnSeason?: number;
}): TmdbEpisodeSource {
  return {
    getSeasonCount: vi.fn(() => Promise.resolve(opts.count)),
    getSeasonEpisodes: vi.fn((_tmdbId: number, season: number) => {
      if (opts.throwOnSeason === season) {
        return Promise.reject(new Error('TMDB boom'));
      }
      const eps = opts.seasons?.[season];
      return Promise.resolve(eps === undefined ? [] : eps);
    }),
  };
}

/** An episode store with a scripted set of existing ids; records writes. */
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

function fakeWatchlist(shows: WatchlistTvShow[]): WatchlistTvSource {
  return { listAllTvShows: vi.fn(() => Promise.resolve(shows)) };
}

/** A watchlist-status store seeded with a current status; records setStatus. */
function fakeStatusStore(current: WatchStatus | null) {
  const getStatus = vi.fn(
    (): Promise<WatchStatus | null> => Promise.resolve(current),
  );
  const setStatus = vi.fn((): Promise<void> => Promise.resolve());
  const store: WatchlistStatusStore = { getStatus, setStatus };
  return { store, getStatus, setStatus };
}

// --- syncOne -------------------------------------------------------------

describe('createEpisodeSyncEngine.syncOne', () => {
  it('fresh show with no existing episodes writes all fetched episodes as unwatched', async () => {
    const tmdb = fakeTmdb({
      count: 2,
      seasons: { 1: [ep(1, 1), ep(1, 2)], 2: [ep(2, 1)] },
    });
    const { store, writes } = fakeEpisodeStore([]);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.outcome).toBe('synced');
    expect(result.seasonsFetched).toBe(2);
    expect(result.episodesWritten).toBe(3);
    expect(writes).toHaveLength(1);
    expect(writes[0].uid).toBe('u1');
    expect(writes[0].titleId).toBe('title-1');

    const byId = Object.fromEntries(writes[0].docs.map((d) => [d.id, d.doc]));
    expect(Object.keys(byId).sort()).toEqual(['s01e001', 's01e002', 's02e001']);
    for (const doc of writes[0].docs) {
      expect(doc.doc.watched).toBe(false);
      expect(doc.doc.watchedAt).toBeNull();
    }
    expect(byId['s01e001'].title).toBe('t1-1');
    expect(byId['s01e001'].airDate).toBe('2026-01-01T00:00:00.000Z');
    expect(byId['s02e001'].season).toBe(2);
    expect(byId['s02e001'].episode).toBe(1);
  });

  it('inserts only the missing episodes when some already exist', async () => {
    const tmdb = fakeTmdb({
      count: 1,
      seasons: { 1: [ep(1, 1), ep(1, 2), ep(1, 3)] },
    });
    const { store, writes } = fakeEpisodeStore(['s01e001', 's01e002']);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(1);
    expect(writes[0].docs.map((d) => d.id)).toEqual(['s01e003']);
  });

  it('never includes an existing id in the write payload (merge safety)', async () => {
    const tmdb = fakeTmdb({
      count: 2,
      seasons: { 1: [ep(1, 1), ep(1, 2)], 2: [ep(2, 1), ep(2, 2)] },
    });
    const existing = ['s01e001', 's02e002'];
    const { store, writes } = fakeEpisodeStore(existing);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    await engine.syncOne('u1', 'title-1', 100);

    const writtenIds = writes[0].docs.map((d) => d.id);
    for (const id of existing) {
      expect(writtenIds).not.toContain(id);
    }
    expect(writtenIds.sort()).toEqual(['s01e002', 's02e001']);
  });

  it('all episodes already present → writeEpisodes called with [] and episodesWritten 0', async () => {
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
    const { store, writes, writeEpisodes } = fakeEpisodeStore([
      's01e001',
      's01e002',
    ]);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(0);
    expect(writeEpisodes).toHaveBeenCalledTimes(1);
    expect(writes[0].docs).toEqual([]);
  });

  it('show not found in TMDB (null season count) → skipped, no store reads/writes', async () => {
    const tmdb = fakeTmdb({ count: null });
    const { store, getExistingEpisodeIds, writeEpisodes } = fakeEpisodeStore(
      [],
    );
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('show not found in TMDB');
    expect(getExistingEpisodeIds).not.toHaveBeenCalled();
    expect(writeEpisodes).not.toHaveBeenCalled();
  });

  it('a null season fetch contributes zero episodes; other seasons still upsert', async () => {
    const tmdb = fakeTmdb({ count: 2, seasons: { 1: null, 2: [ep(2, 1)] } });
    const { store, writes } = fakeEpisodeStore([]);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.outcome).toBe('synced');
    expect(result.episodesWritten).toBe(1);
    expect(writes[0].docs.map((d) => d.id)).toEqual(['s02e001']);
  });

  it('newly written docs never carry a non-null watchedAt (clock determinism)', async () => {
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
    const { store, writes } = fakeEpisodeStore([]);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    await engine.syncOne('u1', 'title-1', 100);

    for (const { doc } of writes[0].docs) {
      expect(doc.watchedAt).toBeNull();
    }
  });
});

// --- syncOne: completed → watching revert (spec 0074) --------------------

describe('createEpisodeSyncEngine.syncOne — completed → watching revert', () => {
  it('inserts ≥1 new episode into a completed show → setStatus(watching), statusRevertedToWatching true', async () => {
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
    const { store } = fakeEpisodeStore(['s01e001']); // s01e002 is new
    const {
      store: statusStore,
      getStatus,
      setStatus,
    } = fakeStatusStore('completed');
    const engine = createEpisodeSyncEngine({
      tmdb,
      episodes: store,
      watchlistStatus: statusStore,
    });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(1);
    expect(getStatus).toHaveBeenCalledWith('u1', 'title-1');
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith('u1', 'title-1', 'watching');
    expect(result.statusRevertedToWatching).toBe(true);
  });

  it.each<WatchStatus | null>(['watching', 'planned', 'dropped', null])(
    'inserts ≥1 new episode but status is %s → NO setStatus, no revert',
    async (current) => {
      const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
      const { store } = fakeEpisodeStore(['s01e001']); // s01e002 is new
      const { store: statusStore, setStatus } = fakeStatusStore(current);
      const engine = createEpisodeSyncEngine({
        tmdb,
        episodes: store,
        watchlistStatus: statusStore,
      });

      const result = await engine.syncOne('u1', 'title-1', 100);

      expect(result.episodesWritten).toBe(1);
      expect(setStatus).not.toHaveBeenCalled();
      expect(result.statusRevertedToWatching).toBe(false);
    },
  );

  it('inserts ZERO new episodes (all already existed) → NO getStatus/setStatus even for a completed show', async () => {
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
    const { store } = fakeEpisodeStore(['s01e001', 's01e002']); // nothing new
    const {
      store: statusStore,
      getStatus,
      setStatus,
    } = fakeStatusStore('completed');
    const engine = createEpisodeSyncEngine({
      tmdb,
      episodes: store,
      watchlistStatus: statusStore,
    });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.episodesWritten).toBe(0);
    expect(getStatus).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(result.statusRevertedToWatching).toBe(false);
  });

  it('watchlistStatus port ABSENT (entry-point-A shape) → no revert, no throw, statusRevertedToWatching false', async () => {
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
    const { store } = fakeEpisodeStore(['s01e001']); // s01e002 is new
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    const result = await engine.syncOne('u1', 'title-1', 100);

    expect(result.outcome).toBe('synced');
    expect(result.episodesWritten).toBe(1);
    expect(result.statusRevertedToWatching).toBe(false);
  });

  it('insert-only invariant unchanged — the revert never touches episode docs (only new ids written)', async () => {
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1), ep(1, 2)] } });
    const { store, writes } = fakeEpisodeStore(['s01e001']);
    const { store: statusStore } = fakeStatusStore('completed');
    const engine = createEpisodeSyncEngine({
      tmdb,
      episodes: store,
      watchlistStatus: statusStore,
    });

    await engine.syncOne('u1', 'title-1', 100);

    // writeEpisodes still receives ONLY the new id; the status revert is a
    // separate watchlist write that does not affect the episode payload.
    expect(writes[0].docs.map((d) => d.id)).toEqual(['s01e002']);
    expect(writes[0].docs.map((d) => d.id)).not.toContain('s01e001');
  });
});

// --- syncAll -------------------------------------------------------------

describe('createEpisodeSyncEngine.syncAll', () => {
  it('runs syncOne per (uid, titleId) — not deduped by tmdbId', async () => {
    // Two users track the same tmdbId 100 plus a third distinct show.
    const shows: WatchlistTvShow[] = [
      { uid: 'u1', titleId: 'tA', tmdbId: 100 },
      { uid: 'u2', titleId: 'tA', tmdbId: 100 },
      { uid: 'u1', titleId: 'tB', tmdbId: 200 },
    ];
    const tmdb = fakeTmdb({ count: 1, seasons: { 1: [ep(1, 1)] } });
    const { store, getExistingEpisodeIds } = fakeEpisodeStore([]);
    const engine = createEpisodeSyncEngine({
      tmdb,
      episodes: store,
      watchlist: fakeWatchlist(shows),
    });

    const results = await engine.syncAll();

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.outcome === 'synced')).toBe(true);
    // syncOne ran once per show (not deduped by tmdbId).
    expect(getExistingEpisodeIds).toHaveBeenCalledTimes(3);
  });

  it('isolates a per-show error: the failing show is error, others synced, no reject', async () => {
    const shows: WatchlistTvShow[] = [
      { uid: 'u1', titleId: 'tA', tmdbId: 100 },
      { uid: 'u1', titleId: 'tB', tmdbId: 200 },
      { uid: 'u1', titleId: 'tC', tmdbId: 300 },
    ];
    // Throw while fetching season 1 for EVERY show — but the engine catches per
    // show, so we need the throw only for the middle one. Use a tmdb whose
    // getSeasonEpisodes throws only for tmdbId 200.
    const tmdb: TmdbEpisodeSource = {
      getSeasonCount: vi.fn(() => Promise.resolve(1)),
      getSeasonEpisodes: vi.fn((tmdbId: number) =>
        tmdbId === 200
          ? Promise.reject(new Error('mid show boom'))
          : Promise.resolve([ep(1, 1)]),
      ),
    };
    const { store } = fakeEpisodeStore([]);
    const engine = createEpisodeSyncEngine({
      tmdb,
      episodes: store,
      watchlist: fakeWatchlist(shows),
    });

    const results = await engine.syncAll();

    expect(results).toHaveLength(3);
    expect(results[0].outcome).toBe('synced');
    expect(results[1].outcome).toBe('error');
    expect(results[1].titleId).toBe('tB');
    expect(results[1].reason).toBe('mid show boom');
    expect(results[2].outcome).toBe('synced');
  });

  it('throws if syncAll is called without a watchlist source', async () => {
    const tmdb = fakeTmdb({ count: 1 });
    const { store } = fakeEpisodeStore([]);
    const engine = createEpisodeSyncEngine({ tmdb, episodes: store });

    await expect(engine.syncAll()).rejects.toThrow(/watchlist/);
  });
});
