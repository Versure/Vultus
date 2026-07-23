import { describe, expect, it, vi } from 'vitest';
import type {
  SyncEngine,
  SyncResult,
  SyncTitleInput,
} from '@vultus/functions/sync-titles';
import {
  QUEUE_NAMES,
  type EnqueueOptions,
  type EpisodeCacheTask,
  type SyncStage,
  type SyncWatchdogTask,
  type TaskEnqueuer,
  type TitleSyncTask,
} from './lib/task-queue';
import type {
  OpenRunParams,
  RecordShardResultParams,
  StagedData,
} from './lib/sync-run-tracker';
import {
  RATE_LIMIT_MS,
  STALENESS_WINDOW_MS,
  WATCHDOG_DELAY_SECONDS,
  enqueueEpisodeCacheStage,
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
  // `uid`/`titleId` default when omitted, so existing single-user tests need not
  // spell them out; the consolidation tests set them to assert the tuples.
  watchlist: {
    tmdbId: number;
    type: 'movie' | 'tv';
    uid?: string;
    titleId?: string;
  }[];
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
          // Each doc exposes `data()` (raw tmdbId/type) AND a `ref` from which the
          // rich gather derives `uid` (parent user doc id) + `titleId` (doc id).
          docs: opts.watchlist.map((w) => ({
            data: () => ({ tmdbId: w.tmdbId, type: w.type }),
            ref: {
              id: w.titleId ?? `title-${w.tmdbId}`,
              parent: { parent: { id: w.uid ?? 'u-default' } },
            },
          })),
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
  persistStagedCalls: { runId: string; data: StagedData }[];
  enqueueEpisodeCacheStageCalls: string[];
} {
  const openRunCalls: OpenRunParams[] = [];
  const finalizeHealthyRunCalls: { runId: string; now: number }[] = [];
  const persistStagedCalls: { runId: string; data: StagedData }[] = [];
  const enqueueEpisodeCacheStageCalls: string[] = [];
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
    persistStagedData: (runId, data) => {
      persistStagedCalls.push({ runId, data });
      return Promise.resolve();
    },
    finalizeHealthyRun: (runId, now) => {
      finalizeHealthyRunCalls.push({ runId, now });
      return Promise.resolve();
    },
    enqueueEpisodeCacheStage: (runId) => {
      enqueueEpisodeCacheStageCalls.push(runId);
      return Promise.resolve();
    },
    gatherActiveRegions: () => Promise.resolve([]),
    ...overrides,
  };
  return {
    deps,
    openRunCalls,
    finalizeHealthyRunCalls,
    persistStagedCalls,
    enqueueEpisodeCacheStageCalls,
  };
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
        activeRegions: [],
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

  it('gathers the active-regions union ONCE and carries it on every title shard payload (spec 0099)', async () => {
    const { db } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 1396, type: 'tv' },
      ],
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    let gatherCount = 0;
    const { deps } = coordinatorDeps({
      db,
      enqueuer,
      gatherActiveRegions: () => {
        gatherCount += 1;
        return Promise.resolve(['US', 'NL']);
      },
    });

    await runSync(
      deps,
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    // Gathered exactly once (one users scan per run), then carried on the shard.
    expect(gatherCount).toBe(1);
    const shard = calls.find((c) => c.queueName === QUEUE_NAMES.titleSync)
      ?.payload as TitleSyncTask;
    expect(shard.activeRegions).toEqual(['US', 'NL']);
  });

  it('does NOT scan for active regions when there is no title-sync work (0 shards)', async () => {
    // All titles fresh → staleness drops them → 0 title shards; the region scan
    // is only needed by the title-cache engine (which runs inside title shards),
    // so an all-fresh night skips it.
    const recentMs = NOW - 60 * 1000;
    const { db } = createFakeDb({
      watchlist: [{ tmdbId: 1396, type: 'tv' }],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
    });
    let gatherCount = 0;
    const { deps } = coordinatorDeps({
      db,
      gatherActiveRegions: () => {
        gatherCount += 1;
        return Promise.resolve(['US']);
      },
    });

    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    expect((out.body as SyncEnqueueResponse).shardCount).toBe(0);
    expect(gatherCount).toBe(0);
  });

  it('consolidated gather: emits distinct titles, TV assignments, distinct shows + uids, and persists staged data BEFORE any enqueue', async () => {
    // Two users share movie 603 + tv 1396; u2 also tracks tv 1399; u3 tracks a
    // movie only. force=true keeps every title (no staleness drop) so `gathered`
    // reflects the distinct union.
    const { db } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie', uid: 'u1', titleId: 'm1' },
        { tmdbId: 1396, type: 'tv', uid: 'u1', titleId: 't1' },
        { tmdbId: 603, type: 'movie', uid: 'u2', titleId: 'm2' },
        { tmdbId: 1396, type: 'tv', uid: 'u2', titleId: 't2' },
        { tmdbId: 1399, type: 'tv', uid: 'u2', titleId: 't3' },
        { tmdbId: 550, type: 'movie', uid: 'u3', titleId: 'm4' },
      ],
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    // Capture how many enqueues had happened at persist time — must be 0, proving
    // staged data is persisted before the watchdog + any title shard.
    let enqueueCountAtPersist = -1;
    const persistStagedCalls: { runId: string; data: StagedData }[] = [];
    const { deps } = coordinatorDeps({
      db,
      enqueuer,
      persistStagedData: (runId, data) => {
        enqueueCountAtPersist = calls.length;
        persistStagedCalls.push({ runId, data });
        return Promise.resolve();
      },
    });

    const out = await runSync(
      deps,
      req({
        headers: { 'x-vultus-sync-secret': SECRET },
        body: { force: true },
      }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.gathered).toBe(4); // 603, 1396, 1399, 550 distinct

    expect(persistStagedCalls).toHaveLength(1);
    expect(persistStagedCalls[0].runId).toBe(RUN_ID);
    expect(persistStagedCalls[0].data).toEqual({
      // One assignment per (uid, titleId) TV entry — movies excluded.
      assignments: [
        { uid: 'u1', titleId: 't1', tmdbId: 1396 },
        { uid: 'u2', titleId: 't2', tmdbId: 1396 },
        { uid: 'u2', titleId: 't3', tmdbId: 1399 },
      ],
      // Distinct TV show tmdbIds (fetch each once).
      shows: [1396, 1399],
      // Distinct uids that track ≥1 TV title — u3 (movie only) is excluded.
      uids: ['u1', 'u2'],
    });
    expect(enqueueCountAtPersist).toBe(0);

    // The title shard still carries the full distinct union (movies + tv).
    const shard = calls.find((c) => c.queueName === QUEUE_NAMES.titleSync)
      ?.payload as TitleSyncTask;
    expect(shard.titles).toEqual([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
      { tmdbId: 1399, type: 'tv' },
      { tmdbId: 550, type: 'movie' },
    ]);
  });

  it('healthy no-op (0 toSync, no TV content): opens staging, enqueues ONLY the watchdog, finalizes immediately, shardCount 0', async () => {
    const recentMs = NOW - 60 * 1000; // every title fresh → filtered
    // A MOVIE (no episode work) that is fresh → 0 title-sync work AND 0 TV shows,
    // so this is a genuine healthy no-op (contrast the TV case below).
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
      titleCache: { 'title-cache/603': { lastSyncedAtMs: recentMs } },
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const {
      deps,
      openRunCalls,
      finalizeHealthyRunCalls,
      enqueueEpisodeCacheStageCalls,
    } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.gathered).toBe(1);
    expect(body.toSync).toBe(0);
    expect(body.shardCount).toBe(0);

    expect(openRunCalls[0].shardCounts).toEqual({ titleSync: 0 });
    // Immediate healthy finalization (not a watchdog error summary); no episode
    // cascade because there is no TV content.
    expect(finalizeHealthyRunCalls).toEqual([{ runId: RUN_ID, now: NOW }]);
    expect(enqueueEpisodeCacheStageCalls).toHaveLength(0);
    // Only the watchdog is enqueued — no title shards.
    expect(calls).toHaveLength(1);
    expect(calls[0].queueName).toBe(QUEUE_NAMES.watchdog);
    expect(writes.some((w) => w.path.startsWith('sync-runs/'))).toBe(false);
  });

  it('0 toSync but TV shows present: skips title shards + healthy finalize, cascades DIRECTLY into the episode-cache stage', async () => {
    const recentMs = NOW - 60 * 1000; // the TV title is fresh → 0 title-sync work
    // The show is fresh (no title-sync work) but its episodes still must be
    // cached/fanned-out/scanned this night — so the coordinator kicks off the
    // episode-cache stage directly rather than finalizing healthy.
    const { db, writes } = createFakeDb({
      watchlist: [{ tmdbId: 1396, type: 'tv', uid: 'u1', titleId: 't1' }],
      titleCache: { 'title-cache/1396': { lastSyncedAtMs: recentMs } },
    });
    const { enqueuer, calls } = createFakeEnqueuer();
    const {
      deps,
      openRunCalls,
      finalizeHealthyRunCalls,
      persistStagedCalls,
      enqueueEpisodeCacheStageCalls,
    } = coordinatorDeps({ db, enqueuer });

    const out = await runSync(
      deps,
      req({ headers: { 'x-vultus-sync-secret': SECRET } }),
    );

    const body = out.body as SyncEnqueueResponse;
    expect(body.gathered).toBe(1);
    expect(body.toSync).toBe(0);
    expect(body.shardCount).toBe(0);
    expect(openRunCalls[0].shardCounts).toEqual({ titleSync: 0 });

    // Staged data was persisted (with the TV show) so the cache stage can read it.
    expect(persistStagedCalls).toEqual([
      {
        runId: RUN_ID,
        data: {
          assignments: [{ uid: 'u1', titleId: 't1', tmdbId: 1396 }],
          shows: [1396],
          uids: ['u1'],
        },
      },
    ]);
    // Cascade to the episode-cache stage; NOT a healthy finalize.
    expect(enqueueEpisodeCacheStageCalls).toEqual([RUN_ID]);
    expect(finalizeHealthyRunCalls).toHaveLength(0);
    // No title shards; only the watchdog was enqueued directly by the coordinator.
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
    // A fresh MOVIE so the run is a true 0-work no-op (no TV episode cascade to
    // muddy the "force is ignored on the user path" assertion).
    const { db } = createFakeDb({
      watchlist: [{ tmdbId: 603, type: 'movie' }],
      titleCache: { 'title-cache/603': { lastSyncedAtMs: recentMs } },
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
    activeRegions: ['US', 'NL'],
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

  it('passes the shard payload activeRegions through to the engine factory (spec 0099)', async () => {
    const engineFactory = createFakeEngine((inputs) =>
      inputs.map(syncedResult),
    );
    const createEngineArgs: string[][] = [];
    await runTitleSyncShard(
      {
        db: {} as RunTitleSyncShardDeps['db'],
        now: () => NOW,
        createEngine: (_db, activeRegions) => {
          createEngineArgs.push(activeRegions);
          return engineFactory.engine;
        },
        recordShard: () =>
          Promise.resolve({ isLastShardOfStage: false, finalized: false }),
        onLastShard: () => Promise.resolve(),
      },
      task,
    );
    expect(createEngineArgs).toEqual([['US', 'NL']]);
  });

  it('last shard of the stage → onLastShard(runId) is invoked (episode-cache stage handoff)', async () => {
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

// --- enqueueEpisodeCacheStage — title→episode-cache handoff (spec 0101 T6) -----

describe('enqueueEpisodeCacheStage', () => {
  interface RecordedEnqueue {
    queue: string;
    payload: unknown;
    name?: string;
  }

  function fakeEnqueuer() {
    const calls: RecordedEnqueue[] = [];
    const enqueuer: TaskEnqueuer = {
      enqueue: <T>(queue: string, payload: T, options?: EnqueueOptions) => {
        calls.push({ queue, payload, name: options?.name });
        return Promise.resolve();
      },
    };
    return { enqueuer, calls };
  }

  it('chunks the staged shows, sets the episodeCache shard count, and enqueues one cache task per shard', async () => {
    const { enqueuer, calls } = fakeEnqueuer();
    const setCounts: { stage: SyncStage; n: number }[] = [];
    const fanoutCalls: string[] = [];
    // 301 shows @ SHARD_SIZE_SHOWS=150 → 3 shards (150 + 150 + 1).
    const shows = Array.from({ length: 301 }, (_v, i) => 1000 + i);
    await enqueueEpisodeCacheStage(
      {
        enqueuer,
        readStagedShows: () => Promise.resolve(shows),
        setStageShardCount: (_runId, stage, n) => {
          setCounts.push({ stage, n });
          return Promise.resolve();
        },
        enqueueFanoutAndAiring: (runId) => {
          fanoutCalls.push(runId);
          return Promise.resolve();
        },
      },
      RUN_ID,
    );

    expect(setCounts).toEqual([{ stage: 'episodeCache', n: 3 }]);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.queue === QUEUE_NAMES.episodeCache)).toBe(true);
    expect(calls.map((c) => c.name)).toEqual([
      'run-1-episodeCache-0',
      'run-1-episodeCache-1',
      'run-1-episodeCache-2',
    ]);
    const last = calls[2].payload as EpisodeCacheTask;
    expect(last.shows).toHaveLength(1);
    // No fan-out cascade when there ARE shows to cache.
    expect(fanoutCalls).toHaveLength(0);
  });

  it('no staged shows → sets episodeCache 0 and cascades to fan-out/airing (no cache enqueue)', async () => {
    const { enqueuer, calls } = fakeEnqueuer();
    const setCounts: { stage: SyncStage; n: number }[] = [];
    const fanoutCalls: string[] = [];
    await enqueueEpisodeCacheStage(
      {
        enqueuer,
        readStagedShows: () => Promise.resolve([]),
        setStageShardCount: (_runId, stage, n) => {
          setCounts.push({ stage, n });
          return Promise.resolve();
        },
        enqueueFanoutAndAiring: (runId) => {
          fanoutCalls.push(runId);
          return Promise.resolve();
        },
      },
      RUN_ID,
    );
    expect(setCounts).toEqual([{ stage: 'episodeCache', n: 0 }]);
    expect(calls).toHaveLength(0);
    expect(fanoutCalls).toEqual([RUN_ID]);
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
