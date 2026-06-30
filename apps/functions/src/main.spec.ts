import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SyncEngine,
  SyncResult,
  SyncTitleInput,
} from '@vultus/functions/sync-titles';
import type {
  EpisodeSyncEngine,
  EpisodeUpsertResult,
} from '@vultus/functions/sync-episodes';
import {
  RATE_LIMIT_MS,
  STALENESS_WINDOW_MS,
  runSync,
  type RunSyncDeps,
  type SyncRequest,
  type SyncRunResponse,
} from './main';

const SECRET = 'cron-secret';
const NOW = Date.parse('2026-06-19T12:00:00.000Z');

// --- A fake Firestore that records every write path and answers the reads the
// flow performs (collectionGroup watchlist, title-cache getEntry, system/sync). ---
interface FakeDoc {
  // For title-cache reads via the store's getEntry (data.lastSyncedAt.toDate()).
  lastSyncedAtMs?: number;
  // For system/sync reads.
  lastRunAt?: number;
}

function createFakeDb(opts: {
  watchlist: { tmdbId: number; type: 'movie' | 'tv' }[];
  titleCache?: Record<string, FakeDoc>; // keyed by full doc path
  syncState?: { lastRunAt: number } | null;
}) {
  const writes: { path: string; data: unknown }[] = [];
  const titleCache = opts.titleCache ?? {};

  const docRef = (path: string) => ({
    get: () => Promise.resolve(makeSnapshot(path)),
    set: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
  });

  function makeSnapshot(path: string) {
    if (path === 'system/sync') {
      const state = opts.syncState ?? null;
      return {
        exists: state !== null,
        data: () =>
          state === null ? undefined : { lastRunAt: state.lastRunAt },
      };
    }
    const entry = titleCache[path];
    if (!entry) {
      return { exists: false, data: () => undefined };
    }
    return {
      exists: true,
      data: () => ({
        type: 'movie',
        traktId: null,
        metadata: {
          title: 't',
          overview: 'o',
          posterPath: null,
          releaseDate: null,
        },
        lastSyncedAt: { toDate: () => new Date(entry.lastSyncedAtMs ?? 0) },
      }),
    };
  }

  const db = {
    collectionGroup: (id: string) => ({
      get: () => {
        expect(id).toBe('watchlist');
        return Promise.resolve({
          docs: opts.watchlist.map((w) => ({ data: () => w })),
        });
      },
    }),
    doc: (path: string) => docRef(path),
    collection: (path: string) => ({
      get: () =>
        Promise.resolve({ docs: [] as { id: string; data: () => unknown }[] }),
      _path: path,
    }),
  };

  return { db: db as unknown as RunSyncDeps['db'], writes };
}

// A fake engine: records the inputs it was given and returns scripted results.
function createFakeEngine(results: (inputs: SyncTitleInput[]) => SyncResult[]) {
  const calls: SyncTitleInput[][] = [];
  const engine: SyncEngine = {
    sync: (titles) => {
      calls.push(titles);
      return Promise.resolve(results(titles));
    },
  };
  return { engine, calls };
}

function syncedResult(input: SyncTitleInput): SyncResult {
  return { ...input, outcome: 'synced', transitions: [] };
}

function baseDeps(
  overrides: Partial<RunSyncDeps> & {
    db: RunSyncDeps['db'];
    createEngine: RunSyncDeps['createEngine'];
  },
): RunSyncDeps {
  return {
    verifyToken: vi.fn(() => Promise.resolve({ uid: 'u1' })),
    secret: SECRET,
    now: () => NOW,
    rateLimitMs: RATE_LIMIT_MS,
    stalenessWindowMs: STALENESS_WINDOW_MS,
    ...overrides,
  };
}

function req(over: Partial<SyncRequest> = {}): SyncRequest {
  return { method: 'POST', headers: {}, body: undefined, ...over };
}

describe('runSync handler wiring', () => {
  let engineFactory: ReturnType<typeof createFakeEngine>;
  let createEngine: RunSyncDeps['createEngine'];

  beforeEach(() => {
    engineFactory = createFakeEngine((inputs) => inputs.map(syncedResult));
    createEngine = () => engineFactory.engine;
  });

  it('cron path: trigger cron, rate limit bypassed, force honored, deduped+filtered union, system/sync written, 200', async () => {
    // Two users track 603; 1396 fresh (would be filtered) — but force keeps all.
    const recentMs = NOW - 60 * 1000; // 1 min ago → fresh
    const { db, writes } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 1396, type: 'tv' },
      ],
      titleCache: {
        'title-cache/1396': { lastSyncedAtMs: recentMs },
      },
      // recent run → would 429 a user, but cron bypasses.
      syncState: { lastRunAt: NOW - 1000 },
    });

    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    expect(out.status).toBe(200);
    const body = out.body as SyncRunResponse;
    expect(body.trigger).toBe('cron');
    expect(body.forced).toBe(true);
    expect(body.gathered).toBe(2); // deduped
    // force keeps the fresh 1396 too:
    expect(engineFactory.calls).toHaveLength(1);
    expect(engineFactory.calls[0]).toEqual([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
    ]);
    expect(body.synced).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.errored).toBe(0);

    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);
  });

  it('cron path without force applies the staleness filter', async () => {
    const recentMs = NOW - 60 * 1000; // fresh → dropped
    const { db } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' }, // never synced → kept
        { tmdbId: 1396, type: 'tv' }, // fresh → dropped
      ],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
    });

    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    const body = out.body as SyncRunResponse;
    expect(body.gathered).toBe(2);
    expect(engineFactory.calls[0]).toEqual([{ tmdbId: 603, type: 'movie' }]);
    expect(body.synced).toBe(1);
    expect(body.skipped).toBe(1); // staleness-skipped
  });

  it('user path: valid token, last run > 5 min ago → runs', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
      syncState: { lastRunAt: NOW - (RATE_LIMIT_MS + 1000) },
    });

    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({ headers: { authorization: 'Bearer good' } }),
    );

    expect(out.status).toBe(200);
    expect((out.body as SyncRunResponse).trigger).toBe('user');
    expect(engineFactory.calls).toHaveLength(1);
    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);
  });

  it('user path: last run < 5 min ago → 429 and engine NOT called', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
      syncState: { lastRunAt: NOW - 1000 },
    });

    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({ headers: { authorization: 'Bearer good' } }),
    );

    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      error: 'rate_limited',
      retryAfterMs: RATE_LIMIT_MS - 1000,
    });
    expect(engineFactory.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('user path ignores force (force only on cron)', async () => {
    const recentMs = NOW - 60 * 1000; // fresh → dropped for user
    const { db } = createFakeDb({
      watchlist: [{ tmdbId: 1396, type: 'tv' }],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
      syncState: { lastRunAt: NOW - (RATE_LIMIT_MS + 1000) },
    });

    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({ headers: { authorization: 'Bearer good' }, body: { force: true } }),
    );

    const body = out.body as SyncRunResponse;
    expect(body.forced).toBe(false);
    expect(engineFactory.calls[0]).toEqual([]); // fresh title filtered despite force
    expect(body.skipped).toBe(1);
  });

  it('no auth → 401, engine not called, no writes', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const out = await runSync(baseDeps({ db, createEngine }), req());
    expect(out.status).toBe(401);
    expect(engineFactory.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('bad secret → 403', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({ headers: { 'x-vultus-sync-secret': 'wrong' } }),
    );
    expect(out.status).toBe(403);
    expect(engineFactory.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('bad token → 403', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const out = await runSync(
      baseDeps({
        db,
        createEngine,
        verifyToken: vi.fn(() => Promise.reject(new Error('bad'))),
      }),
      req({ headers: { authorization: 'Bearer bad' } }),
    );
    expect(out.status).toBe(403);
    expect(engineFactory.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('non-POST → 405', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({ method: 'GET', headers: { 'x-vultus-sync-secret': SECRET } }),
    );
    expect(out.status).toBe(405);
    expect(engineFactory.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('engine per-title errors are counted; handler still 200', async () => {
    const { db } = createFakeDb({
      watchlist: [
        { tmdbId: 1, type: 'movie' },
        { tmdbId: 2, type: 'movie' },
        { tmdbId: 3, type: 'movie' },
      ],
    });
    const mixed = createFakeEngine((inputs) =>
      inputs.map((input, i) =>
        i === 1
          ? { ...input, outcome: 'error', transitions: [], reason: 'boom' }
          : syncedResult(input),
      ),
    );
    const out = await runSync(
      baseDeps({ db, createEngine: () => mixed.engine }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    expect(out.status).toBe(200);
    const body = out.body as SyncRunResponse;
    expect(body.synced).toBe(2);
    expect(body.errored).toBe(1);
    // reason never leaks into the response.
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('runs the episode pass (syncAll) AFTER the title-cache pass when createEpisodeEngine is provided; SyncRunResponse shape is unchanged', async () => {
    const { db } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 1396, type: 'tv' },
      ],
    });

    const order: string[] = [];
    const titleEngine = createFakeEngine((inputs) => {
      order.push('title-sync');
      return inputs.map(syncedResult);
    });
    const syncAll = vi.fn((): Promise<EpisodeUpsertResult[]> => {
      order.push('episode-sync');
      return Promise.resolve([
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          seasonsFetched: 1,
          episodesWritten: 2,
          outcome: 'synced',
        },
      ]);
    });
    const episodeEngine: EpisodeSyncEngine = {
      syncOne: vi.fn(),
      syncAll,
    };

    const out = await runSync(
      baseDeps({
        db,
        createEngine: () => titleEngine.engine,
        createEpisodeEngine: () => episodeEngine,
      }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    expect(syncAll).toHaveBeenCalledTimes(1);
    // Episode pass runs after the title-cache sync.
    expect(order).toEqual(['title-sync', 'episode-sync']);

    // SyncRunResponse shape is UNCHANGED — exactly these keys, no episode fields.
    const body = out.body as SyncRunResponse;
    expect(Object.keys(body).sort()).toEqual(
      [
        'durationMs',
        'errored',
        'forced',
        'gathered',
        'ok',
        'skipped',
        'synced',
        'trigger',
      ].sort(),
    );
  });

  it('BEST-EFFORT: an episode-pass failure (syncAll rejects) does NOT fail the run — SyncRunResponse shape is unchanged and system/sync is still written (R9 / DoD e)', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 1396, type: 'tv' },
      ],
    });

    const episodeEngine: EpisodeSyncEngine = {
      syncOne: vi.fn(),
      syncAll: vi.fn(() =>
        Promise.reject(new Error('watchlist enumeration failed')),
      ),
    };

    const out = await runSync(
      baseDeps({
        db,
        createEngine,
        createEpisodeEngine: () => episodeEngine,
      }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    // The run still succeeds with the normal 200-shaped response.
    expect(out.status).toBe(200);
    const body = out.body as SyncRunResponse;
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      [
        'durationMs',
        'errored',
        'forced',
        'gathered',
        'ok',
        'skipped',
        'synced',
        'trigger',
      ].sort(),
    );
    // Sync-state persistence is unaffected by the episode-pass failure.
    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);
  });

  it('BEST-EFFORT: an episode engine whose syncAll throws synchronously is also swallowed — run still returns 200 and persists system/sync', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 1396, type: 'tv' }],
    });

    const episodeEngine: EpisodeSyncEngine = {
      syncOne: vi.fn(),
      syncAll: vi.fn((): Promise<EpisodeUpsertResult[]> => {
        throw new Error('engine construction / enumeration blew up');
      }),
    };

    const out = await runSync(
      baseDeps({
        db,
        createEngine,
        createEpisodeEngine: () => episodeEngine,
      }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    expect(out.status).toBe(200);
    expect((out.body as SyncRunResponse).ok).toBe(true);
    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);
  });

  it('omitting createEpisodeEngine skips the episode pass (existing-deps shape stays green)', async () => {
    const { db } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
    });
    const out = await runSync(
      baseDeps({ db, createEngine }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );
    expect(out.status).toBe(200);
    // No episode fields leak into the response.
    const body = out.body as SyncRunResponse;
    expect('episodesSynced' in body).toBe(false);
  });

  it('BOUNDARY: across all paths only title-cache/** and system/sync are written — never users/** or notifications', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 1396, type: 'tv' },
      ],
    });
    await runSync(
      baseDeps({ db, createEngine }),
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    // The fake engine writes nothing through the store, so the only write is
    // system/sync; assert NOTHING under users/** or notifications/** is written.
    for (const w of writes) {
      expect(w.path.startsWith('users/')).toBe(false);
      expect(w.path).not.toContain('notifications');
      expect(
        w.path === 'system/sync' || w.path.startsWith('title-cache/'),
      ).toBe(true);
    }
    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);
  });
});
