import { describe, expect, it, vi } from 'vitest';
import type {
  SyncEngine,
  SyncResult,
  SyncTitleInput,
} from '@vultus/functions/sync-titles';
import {
  QUEUE_NAMES,
  type EnqueueOptions,
  type SyncWatchdogTask,
  type TaskEnqueuer,
  type TitleSyncTask,
} from './lib/task-queue';
import type {
  OpenRunParams,
  RecordShardResultParams,
} from './lib/sync-run-tracker';
import {
  RATE_LIMIT_MS,
  STALENESS_WINDOW_MS,
  WATCHDOG_DELAY_SECONDS,
  runSync,
  runSyncWatchdog,
  runTitleSyncShard,
  type RunSyncDeps,
  type RunTitleSyncShardDeps,
  type SyncEnqueueResponse,
  type SyncRequest,
} from './main';

const SECRET = 'cron-secret';
const NOW = Date.parse('2026-06-19T12:00:00.000Z');
const RUN_ID = 'run-1';

// --- A fake Firestore that records every write path and answers the reads the
// coordinator performs (collectionGroup watchlist, title-cache getEntry for the
// staleness filter, system/sync for the user-path rate limit). ---
interface FakeDoc {
  // For title-cache reads via the store's getEntry (data.lastSyncedAt.toDate()).
  lastSyncedAtMs?: number;
}

function createFakeDb(opts: {
  watchlist: { tmdbId: number; type: 'movie' | 'tv' }[];
  titleCache?: Record<string, FakeDoc>; // keyed by full doc path
  syncState?: { lastRunAt: number } | null;
}) {
  const writes: { path: string; data: unknown }[] = [];
  const titleCache = opts.titleCache ?? {};

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
    doc: (path: string) => ({
      get: () => Promise.resolve(makeSnapshot(path)),
      set: (data: unknown) => {
        writes.push({ path, data });
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as RunSyncDeps['db'], writes };
}

// A fake Cloud Tasks enqueuer: records every enqueue (queue, payload, options).
function createFakeEnqueuer() {
  const calls: {
    queueName: string;
    payload: unknown;
    options?: EnqueueOptions;
  }[] = [];
  const enqueuer: TaskEnqueuer = {
    enqueue: (queueName, payload, options) => {
      calls.push({ queueName, payload, options });
      return Promise.resolve();
    },
  };
  return { enqueuer, calls };
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

function coordinatorDeps(
  overrides: Partial<RunSyncDeps> & { db: RunSyncDeps['db'] },
): {
  deps: RunSyncDeps;
  openRunCalls: OpenRunParams[];
  finalizeHealthyRunCalls: { runId: string; now: number }[];
} {
  const openRunCalls: OpenRunParams[] = [];
  const finalizeHealthyRunCalls: { runId: string; now: number }[] = [];
  const deps: RunSyncDeps = {
    verifyToken: vi.fn(() => Promise.resolve({ uid: 'u1' })),
    secret: SECRET,
    now: () => NOW,
    rateLimitMs: RATE_LIMIT_MS,
    stalenessWindowMs: STALENESS_WINDOW_MS,
    enqueuer: createFakeEnqueuer().enqueuer,
    generateRunId: () => RUN_ID,
    openRun: (params) => {
      openRunCalls.push(params);
      return Promise.resolve();
    },
    finalizeHealthyRun: (runId, now) => {
      finalizeHealthyRunCalls.push({ runId, now });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, openRunCalls, finalizeHealthyRunCalls };
}

function req(over: Partial<SyncRequest> = {}): SyncRequest {
  return { method: 'POST', headers: {}, body: undefined, ...over };
}

describe('runSync — enqueue coordinator', () => {
  it('cron+force: opens staging doc, enqueues watchdog + one title shard, returns SyncEnqueueResponse, writes NO sync-runs doc', async () => {
    const recentMs = NOW - 60 * 1000; // fresh — but force keeps it
    const { db, writes } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 603, type: 'movie' }, // dup — deduped
        { tmdbId: 1396, type: 'tv' },
      ],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
      syncState: { lastRunAt: NOW - 1000 }, // cron bypasses the rate limit
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls, finalizeHealthyRunCalls } = coordinatorDeps({
      db,
      enqueuer,
    });

    const out = await runSync(
      deps,
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    expect(out.status).toBe(200);
    const body = out.body as SyncEnqueueResponse;
    expect(body).toEqual({
      ok: true,
      trigger: 'cron',
      runId: RUN_ID,
      gathered: 2, // deduped
      toSync: 2, // force keeps the fresh 1396 too
      shardCount: 1,
      forced: true,
    });

    // Staging doc opened with the title-sync shard count; no summary at enqueue.
    expect(openRunCalls).toEqual([
      {
        runId: RUN_ID,
        kind: 'cron',
        userId: null,
        startedAt: NOW,
        shardCounts: { titleSync: 1 },
      },
    ]);
    expect(finalizeHealthyRunCalls).toHaveLength(0);
    expect(writes.some((w) => w.path.startsWith('sync-runs/'))).toBe(false);
    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);

    // Watchdog first, then the single title shard.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      queueName: QUEUE_NAMES.watchdog,
      payload: { runId: RUN_ID } satisfies SyncWatchdogTask,
      options: {
        name: 'run-1-watchdog',
        scheduleDelaySeconds: WATCHDOG_DELAY_SECONDS,
      },
    });
    expect(calls[1]).toEqual({
      queueName: QUEUE_NAMES.titleSync,
      payload: {
        runId: RUN_ID,
        shardIndex: 0,
        titles: [
          { tmdbId: 603, type: 'movie' },
          { tmdbId: 1396, type: 'tv' },
        ],
        forced: true,
      } satisfies TitleSyncTask,
      options: { name: 'run-1-titleSync-0' },
    });
  });

  it('cron without force applies the staleness filter to the sharded titles', async () => {
    const recentMs = NOW - 60 * 1000; // fresh → dropped
    const { db } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' }, // never synced → kept
        { tmdbId: 1396, type: 'tv' }, // fresh → dropped
      ],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.gathered).toBe(2);
    expect(body.toSync).toBe(1); // 1396 filtered
    expect(body.shardCount).toBe(1);
    expect(body.forced).toBe(false);
    // The title shard carries ONLY the surviving title.
    const shard = calls.find((c) => c.queueName === QUEUE_NAMES.titleSync)
      ?.payload as TitleSyncTask;
    expect(shard.titles).toEqual([{ tmdbId: 603, type: 'movie' }]);
    expect(shard.forced).toBe(false);
  });

  it('healthy no-op (0 toSync): opens staging, enqueues ONLY the watchdog, finalizes immediately, shardCount 0', async () => {
    const recentMs = NOW - 60 * 1000; // every title fresh → filtered
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 1396, type: 'tv' }],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls, finalizeHealthyRunCalls } = coordinatorDeps({
      db,
      enqueuer,
    });

    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.gathered).toBe(1);
    expect(body.toSync).toBe(0);
    expect(body.shardCount).toBe(0);

    expect(openRunCalls[0].shardCounts).toEqual({ titleSync: 0 });
    // Immediate healthy finalization (not a watchdog error summary).
    expect(finalizeHealthyRunCalls).toEqual([{ runId: RUN_ID, now: NOW }]);
    // Only the watchdog is enqueued — no title shards.
    expect(calls).toHaveLength(1);
    expect(calls[0].queueName).toBe(QUEUE_NAMES.watchdog);
    expect(writes.some((w) => w.path.startsWith('sync-runs/'))).toBe(false);
  });

  it('empty watchlist is also a healthy no-op (gathered 0, shardCount 0, finalized immediately)', async () => {
    const { db } = createFakeDb({ watchlist: [] });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, finalizeHealthyRunCalls } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.gathered).toBe(0);
    expect(body.toSync).toBe(0);
    expect(body.shardCount).toBe(0);
    expect(finalizeHealthyRunCalls).toHaveLength(1);
    expect(calls).toHaveLength(1); // watchdog only
  });

  it('fans a large title union into ceil(N / SHARD_SIZE_TITLES) shards', async () => {
    // 1200 distinct titles → 3 shards of 500/500/200 (SHARD_SIZE_TITLES = 500).
    const watchlist = Array.from({ length: 1200 }, (_, i) => ({
      tmdbId: i + 1,
      type: 'movie' as const,
    }));
    const { db } = createFakeDb({ watchlist });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.shardCount).toBe(3);
    expect(openRunCalls[0].shardCounts).toEqual({ titleSync: 3 });
    const shardCalls = calls.filter(
      (c) => c.queueName === QUEUE_NAMES.titleSync,
    );
    expect(shardCalls).toHaveLength(3);
    expect((shardCalls[0].payload as TitleSyncTask).titles).toHaveLength(500);
    expect((shardCalls[2].payload as TitleSyncTask).titles).toHaveLength(200);
    // Shard task names are deterministic + distinct per index.
    expect(shardCalls.map((c) => c.options?.name)).toEqual([
      'run-1-titleSync-0',
      'run-1-titleSync-1',
      'run-1-titleSync-2',
    ]);
  });

  it('user path: valid token, last run > 5 min ago → enqueues (trigger user)', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
      syncState: { lastRunAt: NOW - (RATE_LIMIT_MS + 1000) },
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { authorization: 'Bearer good' } }),
    );

    expect(out.status).toBe(200);
    expect((out.body as SyncEnqueueResponse).trigger).toBe('user');
    expect(calls.some((c) => c.queueName === QUEUE_NAMES.titleSync)).toBe(true);
    expect(writes.some((w) => w.path === 'system/sync')).toBe(true);
  });

  it('user path ignores force (force only on cron)', async () => {
    const recentMs = NOW - 60 * 1000; // fresh → dropped for user
    const { db } = createFakeDb({
      watchlist: [{ tmdbId: 1396, type: 'tv' }],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
      syncState: { lastRunAt: NOW - (RATE_LIMIT_MS + 1000) },
    });
    const { enqueuer } = createFakeEnqueuer();
    const { deps, finalizeHealthyRunCalls } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { authorization: 'Bearer good' }, body: { force: true } }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.forced).toBe(false);
    expect(body.toSync).toBe(0); // fresh title filtered despite force
    expect(finalizeHealthyRunCalls).toHaveLength(1);
  });

  it('user path: last run < 5 min ago → 429, nothing opened or enqueued', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
      syncState: { lastRunAt: NOW - 1000 },
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { authorization: 'Bearer good' } }),
    );

    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      error: 'rate_limited',
      retryAfterMs: RATE_LIMIT_MS - 1000,
    });
    expect(openRunCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('no auth → 401; nothing opened or enqueued', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls } = coordinatorDeps({ db, enqueuer });
    const out = await runSync(deps, req());
    expect(out.status).toBe(401);
    expect(openRunCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('bad secret → 403; nothing opened or enqueued', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls } = coordinatorDeps({ db, enqueuer });
    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': 'wrong' } }),
    );
    expect(out.status).toBe(403);
    expect(openRunCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('bad token → 403', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls } = coordinatorDeps({
      db,
      enqueuer,
      verifyToken: vi.fn(() => Promise.reject(new Error('bad'))),
    });
    const out = await runSync(
      deps,
      req({ headers: { authorization: 'Bearer bad' } }),
    );
    expect(out.status).toBe(403);
    expect(openRunCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('non-POST → 405', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const { enqueuer, calls } = createFakeEnqueuer();
    const { deps, openRunCalls } = coordinatorDeps({ db, enqueuer });
    const out = await runSync(
      deps,
      req({ method: 'GET', headers: { 'x-vultus-sync-secret': SECRET } }),
    );
    expect(out.status).toBe(405);
    expect(openRunCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('response never leaks a secret/token', async () => {
    const { db } = createFakeDb({ watchlist: [{ tmdbId: 1, type: 'movie' }] });
    const { enqueuer } = createFakeEnqueuer();
    const { deps } = coordinatorDeps({ db, enqueuer });
    const out = await runSync(
      deps,
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );
    expect(JSON.stringify(out.body)).not.toMatch(/secret|token|bearer/i);
  });
});

// --- titleSyncWorker core ------------------------------------------------------

describe('runTitleSyncShard — title-sync worker core', () => {
  const task: TitleSyncTask = {
    runId: RUN_ID,
    shardIndex: 2,
    titles: [
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
      { tmdbId: 1399, type: 'tv' },
    ],
    forced: false,
  };

  it('runs the engine over the shard titles and records the shard result (non-last shard → onLastShard NOT called)', async () => {
    const engineFactory = createFakeEngine((inputs) =>
      inputs.map((input, i) =>
        i === 2
          ? { ...input, outcome: 'error', transitions: [], reason: 'boom' }
          : syncedResult(input),
      ),
    );
    const recordShardCalls: RecordShardResultParams[] = [];
    const onLastShardCalls: string[] = [];
    await runTitleSyncShard(
      {
        db: {} as RunTitleSyncShardDeps['db'],
        now: () => NOW,
        createEngine: () => engineFactory.engine,
        recordShard: (params) => {
          recordShardCalls.push(params);
          return Promise.resolve({
            isLastShardOfStage: false,
            finalized: false,
          });
        },
        onLastShard: (runId) => {
          onLastShardCalls.push(runId);
          return Promise.resolve();
        },
      },
      task,
    );

    // Engine ran over exactly the shard's titles.
    expect(engineFactory.calls[0]).toEqual([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
      { tmdbId: 1399, type: 'tv' },
    ]);
    expect(recordShardCalls).toHaveLength(1);
    expect(recordShardCalls[0]).toMatchObject({
      runId: RUN_ID,
      stage: 'titleSync',
      shardIndex: 2,
      synced: 2,
      skipped: 0,
      errored: 1,
      errors: ['boom'],
      counters: { titlesGathered: 3, titlesUpdated: 2 },
    });
    expect(onLastShardCalls).toHaveLength(0);
  });

  it('last shard of the stage → onLastShard(runId) is invoked (interim finalize hook)', async () => {
    const engineFactory = createFakeEngine((inputs) =>
      inputs.map(syncedResult),
    );
    const onLastShardCalls: string[] = [];
    await runTitleSyncShard(
      {
        db: {} as RunTitleSyncShardDeps['db'],
        now: () => NOW,
        createEngine: () => engineFactory.engine,
        recordShard: () =>
          Promise.resolve({ isLastShardOfStage: true, finalized: false }),
        onLastShard: (runId) => {
          onLastShardCalls.push(runId);
          return Promise.resolve();
        },
      },
      task,
    );
    expect(onLastShardCalls).toEqual([RUN_ID]);
  });

  it('a whole-shard engine failure is caught and recorded as fully-errored (task does not throw)', async () => {
    const recordShardCalls: RecordShardResultParams[] = [];
    await runTitleSyncShard(
      {
        db: {} as RunTitleSyncShardDeps['db'],
        now: () => NOW,
        createEngine: (): SyncEngine => ({
          sync: () => Promise.reject(new Error('enumeration blew up')),
        }),
        recordShard: (params) => {
          recordShardCalls.push(params);
          return Promise.resolve({
            isLastShardOfStage: false,
            finalized: false,
          });
        },
        onLastShard: () => Promise.resolve(),
      },
      task,
    );

    expect(recordShardCalls[0]).toMatchObject({
      runId: RUN_ID,
      stage: 'titleSync',
      shardIndex: 2,
      synced: 0,
      errored: 3, // all titles in the shard
      errors: ['enumeration blew up'],
      counters: { titlesGathered: 3, titlesUpdated: 0 },
    });
  });
});

// --- syncWatchdog core ---------------------------------------------------------

describe('runSyncWatchdog — dead-run watchdog core', () => {
  const task: SyncWatchdogTask = { runId: RUN_ID };

  it('non-finalized run → finalizeAsDead is invoked with the runId (writes the error summary)', async () => {
    const calls: { runId: string; now: number }[] = [];
    const finalizeAsDead = vi.fn(
      (_db: RunSyncDeps['db'], runId: string, now: number) => {
        calls.push({ runId, now });
        return Promise.resolve({ wroteSummary: true });
      },
    );
    await runSyncWatchdog(
      { db: {} as RunSyncDeps['db'], now: () => NOW, finalizeAsDead },
      task,
    );
    expect(calls).toEqual([{ runId: RUN_ID, now: NOW }]);
  });

  it('already-finalized run → finalizeAsDead no-ops (wroteSummary false), watchdog still resolves', async () => {
    const finalizeAsDead = vi.fn(() =>
      Promise.resolve({ wroteSummary: false }),
    );
    await expect(
      runSyncWatchdog(
        { db: {} as RunSyncDeps['db'], now: () => NOW, finalizeAsDead },
        task,
      ),
    ).resolves.toBeUndefined();
    expect(finalizeAsDead).toHaveBeenCalledWith(expect.anything(), RUN_ID, NOW);
  });
});
