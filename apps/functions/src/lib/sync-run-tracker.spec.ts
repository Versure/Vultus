import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  finalizeAsDead,
  finalizeHealthyRun,
  openRun,
  recordShardResult,
  setStageShardCount,
  syncRunProgressDocPath,
  syncRunProgressShardDocPath,
} from './sync-run-tracker';
import type { SyncRunProgress } from './sync-run-tracker';

// --- In-memory fake Firestore (no Admin SDK, no emulator). ---------------------
// Supports `db.doc(path).get()/.set(data, { merge })` and a `runTransaction` whose
// reads see committed state and whose writes commit atomically after the callback
// resolves (mirrors firebase-admin: reads-before-writes, buffered commit).

interface FakeDb {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Date) &&
    !Array.isArray(v)
  );
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] = isPlainObject(v) && isPlainObject(prev) ? deepMerge(prev, v) : v;
  }
  return out;
}

function makeDb(): FakeDb {
  const store = new Map<string, Record<string, unknown>>();

  const snap = (path: string) => {
    const data = store.get(path);
    return {
      exists: data !== undefined,
      data: () => data,
      id: path.split('/').pop() ?? path,
    };
  };

  const write = (
    path: string,
    data: Record<string, unknown>,
    opts?: { merge?: boolean },
  ) => {
    const cloned = structuredClone(data);
    const prev = store.get(path);
    if (opts?.merge && prev) {
      store.set(path, deepMerge(prev, cloned));
    } else {
      store.set(path, cloned);
    }
  };

  const docRef = (path: string) => ({
    path,
    get: () => Promise.resolve(snap(path)),
    set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      write(path, data, opts);
      return Promise.resolve();
    },
  });

  const db = {
    doc: (path: string) => docRef(path),
    runTransaction: async <T>(
      fn: (tx: {
        get: (ref: { path: string }) => Promise<ReturnType<typeof snap>>;
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          opts?: { merge?: boolean },
        ) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      const buffered: {
        path: string;
        data: Record<string, unknown>;
        opts?: { merge?: boolean };
      }[] = [];
      const tx = {
        get: (ref: { path: string }) => Promise.resolve(snap(ref.path)),
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          opts?: { merge?: boolean },
        ) => {
          buffered.push({ path: ref.path, data, opts });
        },
      };
      const result = await fn(tx);
      for (const w of buffered) write(w.path, w.data, w.opts);
      return result;
    },
  };

  return { db: db as unknown as Firestore, store };
}

const T0 = Date.parse('2026-07-23T02:00:00.000Z');

/** Read a stored doc, asserting it exists (test helper — avoids `!`/`as`). */
function docAt(
  store: Map<string, Record<string, unknown>>,
  path: string,
): Record<string, unknown> {
  const data = store.get(path);
  if (!data) {
    throw new Error(`expected a doc at ${path}`);
  }
  return data;
}

function progressOf(
  store: Map<string, Record<string, unknown>>,
  runId: string,
) {
  return docAt(
    store,
    syncRunProgressDocPath(runId),
  ) as unknown as SyncRunProgress;
}

describe('openRun', () => {
  it('writes the staging doc with finalized:false, all four stages, carried metadata', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 40 },
    });

    const p = progressOf(store, 'r1');
    expect(p.finalized).toBe(false);
    expect(p.runId).toBe('r1');
    expect(p.kind).toBe('cron');
    expect(p.userId).toBeNull();
    expect(p.startedAt).toBe(T0);
    expect(p.errors).toEqual([]);
    expect(p.stages.titleSync.shardCount).toBe(40);
    expect(p.stages.titleSync.completedShards).toBe(0);
    // Unspecified stages initialize to 0.
    expect(p.stages.episodeCache.shardCount).toBe(0);
    expect(p.stages.episodeFanout.shardCount).toBe(0);
    expect(p.stages.airingScan.shardCount).toBe(0);
  });

  it('does NOT write any sync-runs summary doc at open', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 1 },
    });
    expect(store.has('sync-runs/r1')).toBe(false);
    expect([...store.keys()].some((k) => k.startsWith('sync-runs/'))).toBe(
      false,
    );
  });
});

describe('setStageShardCount', () => {
  it('sets a downstream stage shard count without clobbering other fields', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 2 },
    });
    await setStageShardCount(db, 'r1', 'episodeCache', 67);

    const p = progressOf(store, 'r1');
    expect(p.stages.episodeCache.shardCount).toBe(67);
    expect(p.stages.titleSync.shardCount).toBe(2);
    expect(p.finalized).toBe(false);
  });
});

async function open1PerStage(db: Firestore, runId = 'r1') {
  await openRun(db, {
    runId,
    kind: 'cron',
    userId: null,
    startedAt: T0,
    shardCounts: {
      titleSync: 1,
      episodeCache: 1,
      episodeFanout: 1,
      airingScan: 1,
    },
  });
}

describe('recordShardResult — read-modify-write', () => {
  it('increments completedShards and rolls up stage counters transactionally', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 3 },
    });

    const out = await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 1000,
      synced: 7,
      skipped: 2,
      errored: 1,
      errors: ['tmdb 500 for 42'],
      counters: { titlesGathered: 10, titlesUpdated: 7 },
    });

    expect(out).toEqual({ isLastShardOfStage: false, finalized: false });
    const p = progressOf(store, 'r1');
    expect(p.stages.titleSync.completedShards).toBe(1);
    expect(p.stages.titleSync.titlesGathered).toBe(10);
    expect(p.stages.titleSync.titlesUpdated).toBe(7);
    expect(p.stages.titleSync.errorCount).toBe(1);
    expect(p.errors).toEqual(['tmdb 500 for 42']);

    // Shard subdoc persisted with its own capped fields.
    const shard = docAt(
      store,
      syncRunProgressShardDocPath('r1', 'titleSync', 0),
    );
    expect(shard.synced).toBe(7);
    expect(shard.skipped).toBe(2);
    expect(shard.errored).toBe(1);
    expect(shard.completedAt).toBe(T0 + 1000);
  });

  it('caps aggregated errors at 10', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 1 },
    });
    const errors = Array.from({ length: 15 }, (_, i) => `e${i}`);
    await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 1,
      synced: 0,
      skipped: 0,
      errored: 15,
      errors,
    });
    expect(progressOf(store, 'r1').errors).toHaveLength(10);
  });
});

describe('recordShardResult — at-least-once duplicate delivery', () => {
  it('no-ops a second delivery of an already-completed shard (no counter change, no stage advance)', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 2 },
    });

    const first = await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 100,
      synced: 5,
      skipped: 0,
      errored: 0,
      errors: [],
      counters: { titlesGathered: 5, titlesUpdated: 5 },
    });
    expect(first.isLastShardOfStage).toBe(false);
    expect(progressOf(store, 'r1').stages.titleSync.completedShards).toBe(1);

    // DUPLICATE delivery of shard 0 → no-op.
    const dup = await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 200,
      synced: 5,
      skipped: 0,
      errored: 0,
      errors: [],
      counters: { titlesGathered: 5, titlesUpdated: 5 },
    });
    expect(dup).toEqual({ isLastShardOfStage: false, finalized: false });
    const p = progressOf(store, 'r1');
    // Unchanged — no double count.
    expect(p.stages.titleSync.completedShards).toBe(1);
    expect(p.stages.titleSync.titlesGathered).toBe(5);
  });

  it('returns isLastShardOfStage true only on the shard bringing completedShards === shardCount', async () => {
    const { db } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 2 },
    });

    const s0 = await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 1,
      synced: 1,
      skipped: 0,
      errored: 0,
      errors: [],
    });
    const s1 = await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 1,
      startedAt: T0,
      completedAt: T0 + 2,
      synced: 1,
      skipped: 0,
      errored: 0,
      errors: [],
    });
    expect(s0.isLastShardOfStage).toBe(false);
    expect(s1.isLastShardOfStage).toBe(true);
  });
});

describe('recordShardResult — finalization (last shard of last stage)', () => {
  async function drainToAiring(db: Firestore) {
    // titleSync with real counters + one errored shard-worth in episodeCache.
    await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 10,
      synced: 12,
      skipped: 0,
      errored: 0,
      errors: [],
      counters: { titlesGathered: 12, titlesUpdated: 12 },
    });
    await recordShardResult(db, {
      runId: 'r1',
      stage: 'episodeCache',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 20,
      synced: 0,
      skipped: 0,
      errored: 2,
      errors: ['tmdb 429 for show 7'],
      counters: { showsCached: 3 },
    });
    await recordShardResult(db, {
      runId: 'r1',
      stage: 'episodeFanout',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 30,
      synced: 0,
      skipped: 0,
      errored: 0,
      errors: [],
      counters: { episodesWritten: 50 },
    });
  }

  it('writes the sync-runs summary exactly once, spec-0049 shape, never in a running state', async () => {
    const { db, store } = makeDb();
    await open1PerStage(db);
    await drainToAiring(db);

    // No intermediate stage wrote a sync-runs doc.
    expect(store.has('sync-runs/r1')).toBe(false);

    const out = await recordShardResult(db, {
      runId: 'r1',
      stage: 'airingScan',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 40,
      synced: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    });

    expect(out).toEqual({ isLastShardOfStage: true, finalized: true });

    const summary = docAt(store, 'sync-runs/r1');
    expect(summary).toBeDefined();
    expect(summary.runId).toBe('r1');
    expect(summary.kind).toBe('cron');
    expect(summary.userId).toBeNull();
    // Timestamp boundary: converter emits Date for the summary write.
    expect(summary.startedAt).toBeInstanceOf(Date);
    expect(summary.completedAt).toBeInstanceOf(Date);
    expect((summary.completedAt as Date).toISOString()).toBe(
      new Date(T0 + 40).toISOString(),
    );
    expect(summary.durationMs).toBe(40);
    // titlesGathered/titlesUpdated from the titleSync stage.
    expect(summary.titlesGathered).toBe(12);
    expect(summary.titlesUpdated).toBe(12);
    // errorCount summed across stages (episodeCache contributed 2).
    expect(summary.errorCount).toBe(2);
    expect(summary.errors).toEqual(['tmdb 429 for show 7']);

    // Staging doc flipped finalized.
    expect(progressOf(store, 'r1').finalized).toBe(true);
  });

  it('does not double-write the summary if the last shard is delivered twice', async () => {
    const { db, store } = makeDb();
    await open1PerStage(db);
    await drainToAiring(db);

    await recordShardResult(db, {
      runId: 'r1',
      stage: 'airingScan',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 40,
      synced: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    });
    const firstSummary = structuredClone(store.get('sync-runs/r1'));

    // Duplicate delivery of the finalizing shard → guarded no-op.
    const dup = await recordShardResult(db, {
      runId: 'r1',
      stage: 'airingScan',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 99,
      synced: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    });
    expect(dup).toEqual({ isLastShardOfStage: false, finalized: false });
    expect(store.get('sync-runs/r1')).toEqual(firstSummary);
  });
});

describe('finalizeAsDead', () => {
  it('writes an error summary + flips finalized for a non-finalized run', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 40, episodeCache: 67 },
    });
    // 38 of 40 title shards done, 0 of 67 episode shards.
    for (let i = 0; i < 38; i++) {
      await recordShardResult(db, {
        runId: 'r1',
        stage: 'titleSync',
        shardIndex: i,
        startedAt: T0,
        completedAt: T0 + i,
        synced: 1,
        skipped: 0,
        errored: 0,
        errors: [],
        counters: { titlesGathered: 1, titlesUpdated: 1 },
      });
    }

    const fireAt = T0 + 7200 * 1000;
    const out = await finalizeAsDead(db, 'r1', fireAt);
    expect(out.wroteSummary).toBe(true);

    const summary = docAt(store, 'sync-runs/r1');
    expect(summary).toBeDefined();
    expect(summary.errorCount).toBeGreaterThan(0);
    expect((summary.errors as string[])[0]).toContain('run did not complete');
    expect((summary.errors as string[])[0]).toContain('titleSync 38/40');
    expect((summary.errors as string[])[0]).toContain('episodeCache 0/67');
    expect((summary.completedAt as Date).toISOString()).toBe(
      new Date(fireAt).toISOString(),
    );
    expect(summary.durationMs).toBe(fireAt - T0);
    expect(summary.titlesGathered).toBe(38);
    expect(progressOf(store, 'r1').finalized).toBe(true);
  });

  it('is a no-op on an already-finalized run (no second summary write)', async () => {
    const { db, store } = makeDb();
    await open1PerStage(db);
    // Drive to normal finalization.
    for (const stage of [
      'titleSync',
      'episodeCache',
      'episodeFanout',
      'airingScan',
    ] as const) {
      await recordShardResult(db, {
        runId: 'r1',
        stage,
        shardIndex: 0,
        startedAt: T0,
        completedAt: T0 + 10,
        synced: 0,
        skipped: 0,
        errored: 0,
        errors: [],
      });
    }
    const normalSummary = structuredClone(store.get('sync-runs/r1'));
    expect(progressOf(store, 'r1').finalized).toBe(true);

    const out = await finalizeAsDead(db, 'r1', T0 + 7200 * 1000);
    expect(out.wroteSummary).toBe(false);
    // Summary unchanged — no error overwrite of a healthy run.
    expect(store.get('sync-runs/r1')).toEqual(normalSummary);
  });

  it('is a no-op when no staging doc exists', async () => {
    const { db, store } = makeDb();
    const out = await finalizeAsDead(db, 'missing', T0);
    expect(out.wroteSummary).toBe(false);
    expect(store.has('sync-runs/missing')).toBe(false);
  });
});

describe('finalizeHealthyRun', () => {
  it('writes a NORMAL summary from the staging counters + flips finalized (interim / 0-shard completion)', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 1 },
    });
    // A completed title shard rolls its counters up onto the staging doc.
    await recordShardResult(db, {
      runId: 'r1',
      stage: 'titleSync',
      shardIndex: 0,
      startedAt: T0,
      completedAt: T0 + 10,
      synced: 8,
      skipped: 0,
      errored: 0,
      errors: [],
      counters: { titlesGathered: 8, titlesUpdated: 8 },
    });

    const fireAt = T0 + 5000;
    const out = await finalizeHealthyRun(db, 'r1', fireAt);
    expect(out.wroteSummary).toBe(true);

    const summary = docAt(store, 'sync-runs/r1');
    expect(summary.runId).toBe('r1');
    expect(summary.kind).toBe('cron');
    expect(summary.userId).toBeNull();
    expect(summary.titlesGathered).toBe(8);
    expect(summary.titlesUpdated).toBe(8);
    expect(summary.errorCount).toBe(0); // healthy: no error outcome
    expect(summary.errors).toEqual([]);
    expect((summary.completedAt as Date).toISOString()).toBe(
      new Date(fireAt).toISOString(),
    );
    expect(summary.durationMs).toBe(fireAt - T0);
    expect(progressOf(store, 'r1').finalized).toBe(true);
  });

  it('writes a zero-stats summary for a 0-shard healthy no-op run', async () => {
    const { db, store } = makeDb();
    await openRun(db, {
      runId: 'r1',
      kind: 'cron',
      userId: null,
      startedAt: T0,
      shardCounts: { titleSync: 0 },
    });
    const out = await finalizeHealthyRun(db, 'r1', T0 + 1);
    expect(out.wroteSummary).toBe(true);
    const summary = docAt(store, 'sync-runs/r1');
    expect(summary.titlesGathered).toBe(0);
    expect(summary.titlesUpdated).toBe(0);
    expect(summary.errorCount).toBe(0);
  });

  it('is a no-op on an already-finalized run (no second summary write)', async () => {
    const { db, store } = makeDb();
    await open1PerStage(db);
    for (const stage of [
      'titleSync',
      'episodeCache',
      'episodeFanout',
      'airingScan',
    ] as const) {
      await recordShardResult(db, {
        runId: 'r1',
        stage,
        shardIndex: 0,
        startedAt: T0,
        completedAt: T0 + 10,
        synced: 0,
        skipped: 0,
        errored: 0,
        errors: [],
      });
    }
    const normalSummary = structuredClone(store.get('sync-runs/r1'));
    expect(progressOf(store, 'r1').finalized).toBe(true);

    const out = await finalizeHealthyRun(db, 'r1', T0 + 9999);
    expect(out.wroteSummary).toBe(false);
    expect(store.get('sync-runs/r1')).toEqual(normalSummary);
  });

  it('is a no-op when no staging doc exists', async () => {
    const { db, store } = makeDb();
    const out = await finalizeHealthyRun(db, 'missing', T0);
    expect(out.wroteSummary).toBe(false);
    expect(store.has('sync-runs/missing')).toBe(false);
  });
});
