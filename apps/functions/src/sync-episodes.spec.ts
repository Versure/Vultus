import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  EpisodeSyncEngine,
  EpisodeUpsertResult,
} from '@vultus/functions/sync-episodes';
import {
  episodePath,
  episodesPath,
  episodeToData,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import type { EpisodeDoc, WatchStatus } from '@vultus/shared/domain';
import {
  handleWatchlistCreate,
  createEpisodeUpsertStore,
  createWatchlistStatusStoreAdapter,
  createNextWatchableStoreAdapter,
  type WatchlistCreateEvent,
} from './sync-episodes';

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
const { engineConfigSpy } = vi.hoisted(() => ({
  engineConfigSpy: vi.fn<
    (config: Record<string, unknown>) => EpisodeSyncEngine
  >(
    (): EpisodeSyncEngine => ({
      syncOne: vi.fn(() => Promise.resolve({}) as never),
      syncAll: vi.fn(() => Promise.resolve([])),
    }),
  ),
}));

vi.mock('@vultus/functions/sync-episodes', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@vultus/functions/sync-episodes')>();
  return { ...actual, createEpisodeSyncEngine: engineConfigSpy };
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

  it('entry point B (syncTitles.createEpisodeEngine) builds the engine WITH a watchlistStatus port', async () => {
    const { syncTitles } = await import('./main');

    const res = {
      status: () => res,
      json: () => res,
      send: () => res,
      headersSent: false,
    };
    const req = {
      method: 'POST',
      // Matches the mocked SYNC_SHARED_SECRET.value() so the cron path runs.
      headers: { 'x-vultus-sync-secret': 'test-secret' },
      body: { force: true },
    };

    await (
      syncTitles as unknown as (rq: unknown, rs: unknown) => Promise<void>
    )(req, res);

    const config = capturedConfig();
    // The daily pass supplies the revert port (spec 0074, D5).
    expect('watchlistStatus' in config).toBe(true);
    expect(config.watchlistStatus).toBeDefined();
    // And the nextWatchable port (spec 0081), alongside watchlistStatus.
    expect('nextWatchable' in config).toBe(true);
    expect(config.nextWatchable).toBeDefined();
    // And the shared episode-backfill ports it has in common with entry point A.
    expect(config.tmdb).toBeDefined();
    expect(config.episodes).toBeDefined();
  });
});
