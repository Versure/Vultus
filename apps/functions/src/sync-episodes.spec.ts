import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  EpisodeCacheEngine,
  EpisodeSyncEngine,
  EpisodeUpsertResult,
} from '@vultus/functions/sync-episodes';
import {
  episodePath,
  episodesPath,
  episodeToData,
  titleCacheEpisodeDocPath,
  titleCacheEpisodesPath,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import type { CachedEpisodeReadData } from '@vultus/shared/firestore-schema';
import type { Episode, EpisodeDoc, WatchStatus } from '@vultus/shared/domain';
import {
  handleWatchlistCreate,
  createEpisodeUpsertStore,
  createWatchlistStatusStoreAdapter,
  createNextWatchableStoreAdapter,
  createTitleCacheEpisodeStore,
  runEpisodeCacheShard,
  runEpisodeFanoutShard,
  enqueueFanoutAndAiringStages,
  type WatchlistCreateEvent,
} from './sync-episodes';
import type { EpisodeCacheTask, EpisodeFanoutTask } from './lib/task-queue';

// --- Wiring-shape seam (spec 0074) ---------------------------------------
//
// The two deployed entry points both build their engine by calling
// `createEpisodeSyncEngine(config)`; the ONLY intended difference is that the
// daily pass (entry point B, `syncTitles.createEpisodeEngine` in main.ts)
// supplies a `watchlistStatus` port (so the engine can revert completed → watching)
// while the on-add trigger (entry point A, `syncWatchlistEpisodes` here) does NOT.
// That config object is an inline literal inside each SDK-wrapped handler, so the
// only seam to observe its shape is `createEpisodeSyncEngine` itself. We spy on
// it (keeping every other barrel export real via `importOriginal`) and record the
// config each entry point passes, then invoke each real handler and assert the
// presence/absence of `watchlistStatus`. Existing tests never call
// `createEpisodeSyncEngine`, so the spy is inert for them.
const { engineConfigSpy, cacheEngineConfigSpy } = vi.hoisted(() => ({
  engineConfigSpy: vi.fn<
    (config: Record<string, unknown>) => EpisodeSyncEngine
  >(
    (): EpisodeSyncEngine => ({
      syncOne: vi.fn(() => Promise.resolve({}) as never),
      syncAll: vi.fn(() => Promise.resolve([])),
    }),
  ),
  // Spy on the cache-backed engine factory too (spec 0101 T6) so the deployable
  // `episodeCacheWorker` / `episodeFanoutWorker` config shapes can be asserted
  // (fan-out must be built WITHOUT a `tmdb` source — zero TMDB by construction).
  cacheEngineConfigSpy: vi.fn<
    (config: Record<string, unknown>) => EpisodeCacheEngine
  >(
    (): EpisodeCacheEngine => ({
      cacheShowEpisodes: vi.fn(
        () =>
          Promise.resolve({
            tmdbId: 0,
            seasonsFetched: 0,
            episodesCached: 0,
            outcome: 'cached',
          }) as never,
      ),
      fanoutUserEpisodes: vi.fn(() => Promise.resolve({}) as never),
    }),
  ),
}));

vi.mock('@vultus/functions/sync-episodes', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@vultus/functions/sync-episodes')>();
  return {
    ...actual,
    createEpisodeSyncEngine: engineConfigSpy,
    createEpisodeCacheEngine: cacheEngineConfigSpy,
  };
});

// Neutralize the shard-completion barrier so invoking the deployable workers
// (which call the real `recordShardResult`) does not need a live Firestore
// transaction. Path builders + staged reads stay real. The worker CORE tests
// below inject their own `recordShard`/staged fakes and are unaffected.
vi.mock('./lib/sync-run-tracker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/sync-run-tracker')>();
  return {
    ...actual,
    recordShardResult: vi.fn(() =>
      Promise.resolve({ isLastShardOfStage: false, finalized: false }),
    ),
  };
});

// Neutralize the SDK surface the handler modules touch at load / invoke time so
// the handlers run in-process without a live Firebase environment or secrets.
vi.mock('@vultus/functions/sync-titles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@vultus/functions/sync-titles')>();
  return {
    ...actual,
    createTmdbClient: vi.fn(() => ({}) as never),
    createTraktClient: vi.fn(() => ({}) as never),
    createSyncEngine: vi.fn(
      () => ({ sync: () => Promise.resolve([]) }) as never,
    ),
  };
});

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(
    () =>
      ({
        // The cron path enumerates the global watchlist union (empty here).
        collectionGroup: () => ({ get: () => Promise.resolve({ docs: [] }) }),
      }) as never,
  ),
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: vi.fn(() => ({ value: () => 'test-secret', name: 'X' })),
  defineString: vi.fn(() => ({ value: () => 'test-string', name: 'X' })),
}));

vi.mock('./lib/firestore-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/firestore-io')>();
  return {
    ...actual,
    verifyIdToken: vi.fn(() => Promise.resolve({ uid: 'u1' })),
    readSyncState: vi.fn(() => Promise.resolve({ lastRunAt: null })),
    writeSyncState: vi.fn(() => Promise.resolve()),
    writeSyncRun: vi.fn(() => Promise.resolve()),
  };
});

// --- Fake engine ---------------------------------------------------------

function fakeEngine() {
  const syncOne = vi.fn(
    (
      uid: string,
      titleId: string,
      tmdbId: number,
    ): Promise<EpisodeUpsertResult> =>
      Promise.resolve({
        uid,
        titleId,
        tmdbId,
        seasonsFetched: 1,
        episodesWritten: 0,
        outcome: 'synced',
      }),
  );
  const engine: EpisodeSyncEngine = {
    syncOne,
    syncAll: vi.fn(() => Promise.resolve([])),
  };
  return { engine, syncOne };
}

function event(
  data: Record<string, unknown> | undefined,
  params = { uid: 'u1', titleId: 'title-1' },
): WatchlistCreateEvent {
  return {
    params,
    data: data === undefined ? undefined : { data: () => data },
  };
}

// --- handleWatchlistCreate ----------------------------------------------

describe('handleWatchlistCreate (on-add trigger core)', () => {
  it('no-ops on a movie doc — syncOne is not called', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(event({ type: 'movie', tmdbId: 1 }), engine);
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('no-ops on a malformed doc (missing tmdbId)', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(event({ type: 'tv' }), engine);
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('no-ops on an empty event (no data)', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(event(undefined), engine);
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('calls syncOne(uid, titleId, tmdbId) once on a tv doc', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(
      event({ type: 'tv', tmdbId: 1399 }, { uid: 'uX', titleId: 'tY' }),
      engine,
    );
    expect(syncOne).toHaveBeenCalledTimes(1);
    expect(syncOne).toHaveBeenCalledWith('uX', 'tY', 1399);
  });
});

// --- createEpisodeUpsertStore (Admin-SDK adapter) ------------------------

interface RecordedSet {
  path: string;
  data: unknown;
}

/** A fake Firestore that serves existing episode ids for one collection and
 *  records every batch.set path so we can assert which docs were written. */
function fakeDb(existingEpisodeIds: string[]) {
  const sets: RecordedSet[] = [];
  let committed = 0;

  const db = {
    collection: (path: string) => ({
      _path: path,
      get: () =>
        Promise.resolve({
          docs: existingEpisodeIds.map((id) => ({ id })),
        }),
    }),
    doc: (path: string) => ({ _path: path }),
    batch: () => ({
      set: (ref: { _path: string }, data: unknown) => {
        sets.push({ path: ref._path, data });
      },
      commit: () => {
        committed++;
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as Firestore, sets, commits: () => committed };
}

function doc(season: number, episode: number): EpisodeDoc {
  return {
    season,
    episode,
    title: `e${season}-${episode}`,
    airDate: '2026-01-01T00:00:00.000Z',
    watched: false,
    watchedAt: null,
  };
}

describe('createEpisodeUpsertStore', () => {
  it('getExistingEpisodeIds returns the collection doc ids as a Set', async () => {
    const { db } = fakeDb(['s01e001', 's01e002']);
    const store = createEpisodeUpsertStore(db);
    const ids = await store.getExistingEpisodeIds('u1', 'title-1');
    expect(ids).toEqual(new Set(['s01e001', 's01e002']));
  });

  it('writeEpisodes batches each new doc to its episode path via set', async () => {
    const { db, sets, commits } = fakeDb([]);
    const store = createEpisodeUpsertStore(db);

    await store.writeEpisodes('u1', 'title-1', [
      { id: 's01e001', doc: doc(1, 1) },
      { id: 's01e002', doc: doc(1, 2) },
    ]);

    expect(sets).toHaveLength(2);
    expect(sets[0].path).toBe(episodePath('u1', 'title-1', 's01e001'));
    expect(sets[0].data).toEqual(episodeToData(doc(1, 1)));
    expect(commits()).toBe(1);
  });

  it('writeEpisodes is a no-op (no batch) when given an empty list', async () => {
    const { db, sets, commits } = fakeDb([]);
    const store = createEpisodeUpsertStore(db);
    await store.writeEpisodes('u1', 'title-1', []);
    expect(sets).toHaveLength(0);
    expect(commits()).toBe(0);
  });

  it('only the ids handed to writeEpisodes are written — existing-id docs never appear', async () => {
    // The engine pre-filters; the adapter writes exactly what it is given. Here
    // we hand it only the new id and assert the existing one is never set.
    const { db, sets } = fakeDb(['s01e001']);
    const store = createEpisodeUpsertStore(db);
    await store.writeEpisodes('u1', 'title-1', [
      { id: 's01e002', doc: doc(1, 2) },
    ]);
    const writtenPaths = sets.map((s) => s.path);
    expect(writtenPaths).toEqual([episodePath('u1', 'title-1', 's01e002')]);
    expect(writtenPaths).not.toContain(episodePath('u1', 'title-1', 's01e001'));
  });

  it('chunks writes at the 500-op Firestore batch limit', async () => {
    const { db, sets, commits } = fakeDb([]);
    const store = createEpisodeUpsertStore(db);
    const many = Array.from({ length: 501 }, (_v, i) => ({
      id: `s01e${String(i).padStart(3, '0')}`,
      doc: doc(1, i),
    }));
    await store.writeEpisodes('u1', 'title-1', many);
    expect(sets).toHaveLength(501);
    expect(commits()).toBe(2); // 500 + 1
  });
});

// --- createWatchlistStatusStoreAdapter (Admin-SDK adapter, spec 0074) -----

interface RecordedUpdate {
  path: string;
  data: unknown;
}

/** A fake Firestore backing a SINGLE watchlist doc: `get()` returns `docData`,
 *  and `update()` records the path + patch so the test can assert the write. */
function fakeStatusDb(docData: Record<string, unknown> | undefined) {
  const gets: string[] = [];
  const updates: RecordedUpdate[] = [];

  const db = {
    doc: (path: string) => ({
      get: () => {
        gets.push(path);
        return Promise.resolve({ data: () => docData });
      },
      update: (data: unknown) => {
        updates.push({ path, data });
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as Firestore, gets, updates };
}

describe('createWatchlistStatusStoreAdapter', () => {
  it('getStatus reads `status` from the watchlist doc at watchlistItemPath', async () => {
    const { db, gets } = fakeStatusDb({ status: 'completed' });
    const store = createWatchlistStatusStoreAdapter(db);
    const status = await store.getStatus('u1', 'title-1');
    expect(status).toBe('completed');
    expect(gets).toEqual([watchlistItemPath('u1', 'title-1')]);
  });

  it('getStatus returns null when the `status` field is absent', async () => {
    const { db } = fakeStatusDb({ tmdbId: 1396 });
    const store = createWatchlistStatusStoreAdapter(db);
    expect(await store.getStatus('u1', 'title-1')).toBeNull();
  });

  it('getStatus returns null when the doc does not exist (undefined data)', async () => {
    const { db } = fakeStatusDb(undefined);
    const store = createWatchlistStatusStoreAdapter(db);
    expect(await store.getStatus('u1', 'title-1')).toBeNull();
  });

  it('setStatus calls .update({ status }) on the doc at watchlistItemPath', async () => {
    const { db, updates } = fakeStatusDb({ status: 'completed' });
    const store = createWatchlistStatusStoreAdapter(db);
    const next: WatchStatus = 'watching';
    await store.setStatus('u1', 'title-1', next);
    expect(updates).toEqual([
      {
        path: watchlistItemPath('u1', 'title-1'),
        data: { status: 'watching' },
      },
    ]);
  });
});

// --- createNextWatchableStoreAdapter (Admin-SDK adapter, spec 0081) -------

/** A Firestore-Timestamp-like value: `dataToEpisode` calls `.toDate()` on it. */
function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

/** An `EpisodeReadData`-shaped stored doc (airDate/watchedAt as Timestamps). */
function episodeData(iso: string, watched: boolean) {
  return {
    season: 1,
    episode: 1,
    title: 'ep',
    airDate: ts(iso),
    watched,
    watchedAt: watched ? ts(iso) : null,
  };
}

/** A fake Firestore backing ONE episodes collection (its docs each expose
 *  `.data()`) plus ONE watchlist doc whose `.update()` patch is recorded. */
function fakeNextWatchableDb(episodes: { iso: string; watched: boolean }[]) {
  const collections: string[] = [];
  const updates: RecordedUpdate[] = [];

  const db = {
    collection: (path: string) => ({
      get: () => {
        collections.push(path);
        return Promise.resolve({
          docs: episodes.map((e) => ({
            data: () => episodeData(e.iso, e.watched),
          })),
        });
      },
    }),
    doc: (path: string) => ({
      update: (data: unknown) => {
        updates.push({ path, data });
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as Firestore, collections, updates };
}

describe('createNextWatchableStoreAdapter', () => {
  it('readEpisodeWatchState maps stored docs to { airDate, watched } via dataToEpisode', async () => {
    const { db, collections } = fakeNextWatchableDb([
      { iso: '2011-04-24T00:00:00.000Z', watched: true },
      { iso: '2011-05-01T00:00:00.000Z', watched: false },
    ]);
    const store = createNextWatchableStoreAdapter(db);
    const state = await store.readEpisodeWatchState('u1', 'title-1');

    expect(collections).toEqual([episodesPath('u1', 'title-1')]);
    expect(state).toEqual([
      { airDate: '2011-04-24T00:00:00.000Z', watched: true },
      { airDate: '2011-05-01T00:00:00.000Z', watched: false },
    ]);
    // airDate is a plain ISO string (NOT a Date/Timestamp).
    expect(typeof state[0].airDate).toBe('string');
    expect(state[0].airDate).not.toBeInstanceOf(Date);
  });

  it('setNextUnwatchedEpisodeAirDate issues .update({ nextUnwatchedEpisodeAirDate }) on watchlistItemPath', async () => {
    const { db, updates } = fakeNextWatchableDb([]);
    const store = createNextWatchableStoreAdapter(db);
    await store.setNextUnwatchedEpisodeAirDate(
      'u1',
      'title-1',
      '2011-05-01T00:00:00.000Z',
    );
    expect(updates).toEqual([
      {
        path: watchlistItemPath('u1', 'title-1'),
        data: { nextUnwatchedEpisodeAirDate: '2011-05-01T00:00:00.000Z' },
      },
    ]);
  });

  it('setNextUnwatchedEpisodeAirDate writes null through unchanged (all-watched/empty case)', async () => {
    const { db, updates } = fakeNextWatchableDb([]);
    const store = createNextWatchableStoreAdapter(db);
    await store.setNextUnwatchedEpisodeAirDate('u1', 'title-1', null);
    expect(updates).toEqual([
      {
        path: watchlistItemPath('u1', 'title-1'),
        data: { nextUnwatchedEpisodeAirDate: null },
      },
    ]);
  });
});

// --- Entry-point engine wiring shape (spec 0074, Test plan) --------------
//
// Closes the named "Unit — apps/functions adapter" assertion: entry-point-B
// `createEpisodeEngine` config includes `watchlistStatus`; entry-point-A
// `syncWatchlistEpisodes` config does NOT. Each real, SDK-wrapped handler is
// invoked (A via its CloudFunction `.run(event)`, B by calling the `onRequest`
// callable directly) and we assert the shape of the config it hands to
// `createEpisodeSyncEngine` via `engineConfigSpy`.
describe('entry-point engine config shape (spec 0074)', () => {
  beforeEach(() => engineConfigSpy.mockClear());

  /** The config object the handler passed to `createEpisodeSyncEngine`. */
  function capturedConfig(): Record<string, unknown> {
    expect(engineConfigSpy).toHaveBeenCalledTimes(1);
    return engineConfigSpy.mock.calls[0][0];
  }

  it('entry point A (syncWatchlistEpisodes) builds the engine WITHOUT a watchlistStatus port', async () => {
    const { syncWatchlistEpisodes } = await import('./sync-episodes');
    // v2 firestore triggers expose the raw user handler as `.run`.
    const run = (
      syncWatchlistEpisodes as unknown as {
        run: (event: unknown) => Promise<void>;
      }
    ).run;

    await run({
      params: { uid: 'u1', titleId: 'title-1' },
      data: { data: () => ({ type: 'tv', tmdbId: 1399 }) },
    });

    const config = capturedConfig();
    // The revert port is deliberately absent on the on-add trigger.
    expect('watchlistStatus' in config).toBe(false);
    expect(config.watchlistStatus).toBeUndefined();
    // But the nextWatchable port IS wired on entry A (spec 0081 — the deliberate
    // deviation from 0074): a freshly-added TV show must get its
    // nextUnwatchedEpisodeAirDate set on its first episode sync, not 24h later.
    // The natural mistake is to copy 0074's entry-A omission here — do NOT.
    expect('nextWatchable' in config).toBe(true);
    expect(config.nextWatchable).toBeDefined();
    // Sanity: it DOES wire the ports the on-add backfill needs.
    expect(config.tmdb).toBeDefined();
    expect(config.episodes).toBeDefined();
  });

  // NOTE (spec 0101 T2): the former "entry point B (syncTitles.createEpisodeEngine)"
  // test was removed here. Since 0101, `syncTitles` is an enqueue COORDINATOR and no
  // longer runs the episode pass inline — the episode fetch/fan-out moves to the
  // Phase-2 `episodeCacheWorker` / `episodeFanoutWorker` (`onTaskDispatched`, task
  // T6), which T6 adds tests for in this file. Entry point A (the on-add
  // `syncWatchlistEpisodes` trigger) is unchanged and still covered above.
});

// --- createTitleCacheEpisodeStore (global episode-cache adapter, spec 0101) ---

/** A Firestore-Timestamp-like value: `dataToCachedEpisode` calls `.toDate()`. */
function cacheTs(iso: string) {
  return { toDate: () => new Date(iso) };
}

/** A stored `title-cache/{tmdbId}/episodes/*` doc (airDate/lastSyncedAt as TS). */
function cachedData(
  season: number,
  episode: number,
  title: string | null,
  airIso: string,
): CachedEpisodeReadData {
  return {
    season,
    episode,
    title,
    airDate: cacheTs(airIso),
    lastSyncedAt: cacheTs('2026-07-23T02:00:00.000Z'),
  };
}

/** Fake Firestore for the cache store: one episodes collection whose docs expose
 *  `.data()`, plus `batch().set(...)`/`commit()` recording the written paths. */
function fakeCacheDb(stored: { id: string; data: CachedEpisodeReadData }[]) {
  const sets: RecordedSet[] = [];
  let committed = 0;
  const db = {
    collection: (path: string) => ({
      _path: path,
      get: () =>
        Promise.resolve({
          docs: stored.map((s) => ({ id: s.id, data: () => s.data })),
        }),
    }),
    doc: (path: string) => ({ _path: path }),
    batch: () => ({
      set: (ref: { _path: string }, data: unknown) => {
        sets.push({ path: ref._path, data });
      },
      commit: () => {
        committed++;
        return Promise.resolve();
      },
    }),
  };
  return { db: db as unknown as Firestore, sets, commits: () => committed };
}

function ep(
  season: number,
  episode: number,
  title: string | null,
  airDate: string,
): Episode {
  return { season, episode, title, airDate };
}

describe('createTitleCacheEpisodeStore', () => {
  it('getCachedEpisodes reads the show cache collection and strips lastSyncedAt to bare Episode[]', async () => {
    const { db } = fakeCacheDb([
      {
        id: 's01e001',
        data: cachedData(1, 1, 'Pilot', '2026-01-01T00:00:00.000Z'),
      },
      {
        id: 's01e002',
        data: cachedData(1, 2, null, '2026-01-08T00:00:00.000Z'),
      },
    ]);
    const store = createTitleCacheEpisodeStore(db);
    const episodes = await store.getCachedEpisodes(1396);
    expect(episodes).toEqual([
      {
        season: 1,
        episode: 1,
        title: 'Pilot',
        airDate: '2026-01-01T00:00:00.000Z',
      },
      {
        season: 1,
        episode: 2,
        title: null,
        airDate: '2026-01-08T00:00:00.000Z',
      },
    ]);
    // No cache-only field leaks into the bare Episode shape.
    expect('lastSyncedAt' in episodes[0]).toBe(false);
  });

  it('upsertCachedEpisodes writes each episode to titleCacheEpisodeDocPath via cachedEpisodeToData', async () => {
    const { db, sets, commits } = fakeCacheDb([]);
    const store = createTitleCacheEpisodeStore(db);
    await store.upsertCachedEpisodes(1396, [
      { id: 's01e001', episode: ep(1, 1, 'Pilot', '2026-01-01T00:00:00.000Z') },
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0].path).toBe(titleCacheEpisodeDocPath(1396, 's01e001'));
    // The written data is the CachedEpisode wire shape (airDate + lastSyncedAt
    // both crossed to Date); assert the TMDB facts round-trip.
    const written = sets[0].data as { season: number; title: string | null };
    expect(written.season).toBe(1);
    expect(written.title).toBe('Pilot');
    expect(commits()).toBe(1);
  });

  it('upsertCachedEpisodes is a no-op (no batch) for an empty list', async () => {
    const { db, sets, commits } = fakeCacheDb([]);
    const store = createTitleCacheEpisodeStore(db);
    await store.upsertCachedEpisodes(1396, []);
    expect(sets).toHaveLength(0);
    expect(commits()).toBe(0);
  });

  it('upsert is idempotent by doc id (same ids re-write the same paths)', async () => {
    const { db, sets } = fakeCacheDb([]);
    const store = createTitleCacheEpisodeStore(db);
    const one = [
      { id: 's01e001', episode: ep(1, 1, 'Pilot', '2026-01-01T00:00:00.000Z') },
    ];
    await store.upsertCachedEpisodes(1396, one);
    await store.upsertCachedEpisodes(1396, one);
    expect(sets.map((s) => s.path)).toEqual([
      titleCacheEpisodeDocPath(1396, 's01e001'),
      titleCacheEpisodeDocPath(1396, 's01e001'),
    ]);
  });

  it('reads from the show-scoped episodes collection path', async () => {
    const { db } = fakeCacheDb([]);
    const store = createTitleCacheEpisodeStore(db);
    // Collection path assertion via a spy on collection().
    const collectionSpy = vi.spyOn(
      db as unknown as { collection: (p: string) => unknown },
      'collection',
    );
    await store.getCachedEpisodes(1399);
    expect(collectionSpy).toHaveBeenCalledWith(titleCacheEpisodesPath(1399));
  });
});

// --- runEpisodeCacheShard (episode-cache worker core, spec 0101 T6) --------

function fakeCacheEngine(
  cacheImpl?: (
    tmdbId: number,
  ) => Promise<never> | ReturnType<EpisodeCacheEngine['cacheShowEpisodes']>,
) {
  const cacheShowEpisodes = vi.fn(
    cacheImpl ??
      ((tmdbId: number) =>
        Promise.resolve({
          tmdbId,
          seasonsFetched: 1,
          episodesCached: 2,
          outcome: 'cached' as const,
        })),
  );
  const fanoutUserEpisodes = vi.fn(
    (uid: string, titleId: string, tmdbId: number) =>
      Promise.resolve({
        uid,
        titleId,
        tmdbId,
        seasonsFetched: 0,
        episodesWritten: 3,
        outcome: 'synced' as const,
      }),
  );
  const engine = {
    cacheShowEpisodes,
    fanoutUserEpisodes,
  } as EpisodeCacheEngine;
  return { engine, cacheShowEpisodes, fanoutUserEpisodes };
}

const CACHE_TASK: EpisodeCacheTask = {
  runId: 'run-1',
  shardIndex: 3,
  shows: [1396, 1399, 66732],
};

describe('runEpisodeCacheShard', () => {
  it('caches each show once, records the shard result, and (last shard) invokes onLastShard', async () => {
    const { engine, cacheShowEpisodes } = fakeCacheEngine();
    const recordCalls: unknown[] = [];
    const lastShardCalls: string[] = [];
    await runEpisodeCacheShard(
      {
        db: {} as Firestore,
        now: () => 1000,
        createEngine: () => engine,
        recordShard: (params) => {
          recordCalls.push(params);
          return Promise.resolve({
            isLastShardOfStage: true,
            finalized: false,
          });
        },
        onLastShard: (runId) => {
          lastShardCalls.push(runId);
          return Promise.resolve();
        },
      },
      CACHE_TASK,
    );

    expect(cacheShowEpisodes.mock.calls.map((c) => c[0])).toEqual([
      1396, 1399, 66732,
    ]);
    expect(recordCalls[0]).toMatchObject({
      runId: 'run-1',
      stage: 'episodeCache',
      shardIndex: 3,
      synced: 3,
      skipped: 0,
      errored: 0,
      counters: { showsCached: 3 },
    });
    expect(lastShardCalls).toEqual(['run-1']);
  });

  it('non-last shard → onLastShard is NOT called', async () => {
    const { engine } = fakeCacheEngine();
    const lastShardCalls: string[] = [];
    await runEpisodeCacheShard(
      {
        db: {} as Firestore,
        now: () => 0,
        createEngine: () => engine,
        recordShard: () =>
          Promise.resolve({ isLastShardOfStage: false, finalized: false }),
        onLastShard: (runId) => {
          lastShardCalls.push(runId);
          return Promise.resolve();
        },
      },
      CACHE_TASK,
    );
    expect(lastShardCalls).toHaveLength(0);
  });

  it('isolates a per-show failure (counts it errored, task does not throw)', async () => {
    const { engine } = fakeCacheEngine((tmdbId: number) =>
      tmdbId === 1399
        ? Promise.reject(new Error('tmdb 500 for 1399'))
        : Promise.resolve({
            tmdbId,
            seasonsFetched: 1,
            episodesCached: 1,
            outcome: 'cached' as const,
          }),
    );
    const recordCalls: {
      synced: number;
      errored: number;
      errors: string[];
    }[] = [];
    await runEpisodeCacheShard(
      {
        db: {} as Firestore,
        now: () => 0,
        createEngine: () => engine,
        recordShard: (params) => {
          recordCalls.push(params);
          return Promise.resolve({
            isLastShardOfStage: false,
            finalized: false,
          });
        },
        onLastShard: () => Promise.resolve(),
      },
      CACHE_TASK,
    );
    expect(recordCalls[0]).toMatchObject({
      synced: 2,
      errored: 1,
      errors: ['tmdb 500 for 1399'],
    });
  });

  it('counts a skipped show (TMDB 404) as skipped, not errored', async () => {
    const { engine } = fakeCacheEngine((tmdbId: number) =>
      Promise.resolve({
        tmdbId,
        seasonsFetched: 0,
        episodesCached: 0,
        outcome: 'skipped' as const,
        reason: 'not found',
      }),
    );
    const recordCalls: { synced: number; skipped: number }[] = [];
    await runEpisodeCacheShard(
      {
        db: {} as Firestore,
        now: () => 0,
        createEngine: () => engine,
        recordShard: (params) => {
          recordCalls.push(params);
          return Promise.resolve({
            isLastShardOfStage: false,
            finalized: false,
          });
        },
        onLastShard: () => Promise.resolve(),
      },
      { runId: 'run-1', shardIndex: 0, shows: [1] },
    );
    expect(recordCalls[0]).toMatchObject({ synced: 0, skipped: 1 });
  });
});

// --- runEpisodeFanoutShard (episode-fanout worker core, spec 0101 T6) ------

const FANOUT_TASK: EpisodeFanoutTask = {
  runId: 'run-1',
  shardIndex: 1,
  assignments: [
    { uid: 'u1', titleId: 't1', tmdbId: 1396 },
    { uid: 'u2', titleId: 't2', tmdbId: 1399 },
  ],
};

describe('runEpisodeFanoutShard', () => {
  it('fans out each assignment from the cache (ZERO TMDB) and records the shard result', async () => {
    const { engine, cacheShowEpisodes, fanoutUserEpisodes } = fakeCacheEngine();
    const recordCalls: unknown[] = [];
    await runEpisodeFanoutShard(
      {
        db: {} as Firestore,
        now: () => 0,
        createEngine: () => engine,
        recordShard: (params) => {
          recordCalls.push(params);
          return Promise.resolve({ isLastShardOfStage: true, finalized: true });
        },
      },
      FANOUT_TASK,
    );
    // Zero TMDB: the cache-fetch operation is NEVER invoked on the fan-out path.
    expect(cacheShowEpisodes).not.toHaveBeenCalled();
    expect(fanoutUserEpisodes.mock.calls).toEqual([
      ['u1', 't1', 1396],
      ['u2', 't2', 1399],
    ]);
    expect(recordCalls[0]).toMatchObject({
      runId: 'run-1',
      stage: 'episodeFanout',
      shardIndex: 1,
      synced: 2,
      errored: 0,
      counters: { episodesWritten: 6 }, // 3 per assignment (fake)
    });
  });

  it('isolates a per-assignment failure and still records the shard', async () => {
    const fanoutUserEpisodes = vi.fn(
      (uid: string, titleId: string, tmdbId: number) =>
        uid === 'u2'
          ? Promise.reject(new Error('write failed for u2'))
          : Promise.resolve({
              uid,
              titleId,
              tmdbId,
              seasonsFetched: 0,
              episodesWritten: 2,
              outcome: 'synced' as const,
            }),
    );
    const engine = {
      cacheShowEpisodes: vi.fn(),
      fanoutUserEpisodes,
    } as unknown as EpisodeCacheEngine;
    const recordCalls: {
      synced: number;
      errored: number;
      errors: string[];
      counters?: { episodesWritten?: number };
    }[] = [];
    await runEpisodeFanoutShard(
      {
        db: {} as Firestore,
        now: () => 0,
        createEngine: () => engine,
        recordShard: (params) => {
          recordCalls.push(params);
          return Promise.resolve({
            isLastShardOfStage: false,
            finalized: false,
          });
        },
      },
      FANOUT_TASK,
    );
    expect(recordCalls[0]).toMatchObject({
      synced: 1,
      errored: 1,
      errors: ['write failed for u2'],
      counters: { episodesWritten: 2 },
    });
  });
});

// --- enqueueFanoutAndAiringStages (terminal-stage cascade, spec 0101 T6) ---

interface RecordedEnqueue {
  queue: string;
  payload: unknown;
  name?: string;
}

function fakeEnqueuer() {
  const calls: RecordedEnqueue[] = [];
  return {
    enqueuer: {
      enqueue: <T>(queue: string, payload: T, options?: { name?: string }) => {
        calls.push({ queue, payload, name: options?.name });
        return Promise.resolve();
      },
    },
    calls,
  };
}

describe('enqueueFanoutAndAiringStages', () => {
  it('sets BOTH terminal shard counts BEFORE enqueueing either, then fans out', async () => {
    const { enqueuer, calls } = fakeEnqueuer();
    const order: string[] = [];
    await enqueueFanoutAndAiringStages(
      {
        enqueuer,
        readStagedAssignments: () =>
          Promise.resolve([{ uid: 'u1', titleId: 't1', tmdbId: 1 }]),
        readStagedUids: () => Promise.resolve(['u1', 'u2']),
        setStageShardCount: (_r, stage, n) => {
          order.push(`set:${stage}=${n}`);
          return Promise.resolve();
        },
        finalizeHealthyRun: () => {
          order.push('finalize');
          return Promise.resolve();
        },
        now: () => 0,
      },
      'run-1',
    );
    // Both counts set (before any enqueue), no premature finalize.
    expect(order).toEqual(['set:episodeFanout=1', 'set:airingScan=1']);
    expect(calls.map((c) => c.queue)).toEqual([
      'episodeFanoutWorker',
      'airingScanWorker',
    ]);
    // Deterministic task names.
    expect(calls[0].name).toBe('run-1-episodeFanout-0');
    expect(calls[1].name).toBe('run-1-airingScan-0');
  });

  it('finalizes healthy (no enqueue) when there is no per-user work at all', async () => {
    const { enqueuer, calls } = fakeEnqueuer();
    const finalizeCalls: { runId: string; now: number }[] = [];
    const counts: string[] = [];
    await enqueueFanoutAndAiringStages(
      {
        enqueuer,
        readStagedAssignments: () => Promise.resolve([]),
        readStagedUids: () => Promise.resolve([]),
        setStageShardCount: (_r, stage, n) => {
          counts.push(`${stage}=${n}`);
          return Promise.resolve();
        },
        finalizeHealthyRun: (runId, now) => {
          finalizeCalls.push({ runId, now });
          return Promise.resolve();
        },
        now: () => 777,
      },
      'run-1',
    );
    // Both terminal stages set to 0, then a healthy finalize (no shards enqueued).
    expect(counts).toEqual(['episodeFanout=0', 'airingScan=0']);
    expect(calls).toHaveLength(0);
    expect(finalizeCalls).toEqual([{ runId: 'run-1', now: 777 }]);
  });

  it('enqueues airing-only when there are uids but no TV fan-out assignments', async () => {
    const { enqueuer, calls } = fakeEnqueuer();
    await enqueueFanoutAndAiringStages(
      {
        enqueuer,
        readStagedAssignments: () => Promise.resolve([]),
        readStagedUids: () => Promise.resolve(['u1', 'u2', 'u3']),
        setStageShardCount: () => Promise.resolve(),
        finalizeHealthyRun: () => Promise.resolve(),
        now: () => 0,
      },
      'run-1',
    );
    expect(calls.map((c) => c.queue)).toEqual(['airingScanWorker']);
  });
});

// --- Deployable worker engine-config shapes (spec 0101 T6) -----------------
//
// The fan-out worker MUST build its engine WITHOUT a `tmdb` source (zero TMDB by
// construction); the cache worker MUST build it WITH one. Each SDK-wrapped
// `onTaskDispatched` handler is invoked via its CloudFunction `.run(request)` and
// we assert the config it hands to the (spied) `createEpisodeCacheEngine`.
describe('deployable worker engine config shape (spec 0101 T6)', () => {
  beforeEach(() => cacheEngineConfigSpy.mockClear());

  function runWorker(fn: unknown, data: unknown): Promise<void> {
    return (fn as { run: (req: unknown) => Promise<void> }).run({ data });
  }

  it('episodeCacheWorker builds the engine WITH a tmdb source and cache (no per-user episodes)', async () => {
    const { episodeCacheWorker } = await import('./sync-episodes');
    await runWorker(episodeCacheWorker, {
      runId: 'run-1',
      shardIndex: 0,
      shows: [],
    });
    expect(cacheEngineConfigSpy).toHaveBeenCalledTimes(1);
    const config = cacheEngineConfigSpy.mock.calls[0][0];
    expect(config.cache).toBeDefined();
    expect(config.tmdb).toBeDefined();
    expect('episodes' in config).toBe(false);
  });

  it('episodeFanoutWorker builds the engine WITHOUT a tmdb source (cache + per-user ports only)', async () => {
    const { episodeFanoutWorker } = await import('./sync-episodes');
    await runWorker(episodeFanoutWorker, {
      runId: 'run-1',
      shardIndex: 0,
      assignments: [],
    });
    expect(cacheEngineConfigSpy).toHaveBeenCalledTimes(1);
    const config = cacheEngineConfigSpy.mock.calls[0][0];
    expect(config.cache).toBeDefined();
    expect(config.episodes).toBeDefined();
    expect(config.watchlistStatus).toBeDefined();
    expect(config.nextWatchable).toBeDefined();
    // The critical invariant: fan-out is incapable of a TMDB call.
    expect('tmdb' in config).toBe(false);
    expect(config.tmdb).toBeUndefined();
  });
});
