import { describe, expect, it } from 'vitest';
import { HttpsError } from 'firebase-functions/https';
import type {
  SyncEngine,
  SyncResult,
  SyncTitleInput,
} from '@vultus/functions/sync-titles';
import {
  runTriggerSync,
  type RunTriggerSyncDeps,
  // Regression: the existing exports must remain present + unchanged.
  syncTitles,
  dispatchNotifications,
} from './main';

// --- A fake Firestore that records every write path and answers the per-user
// watchlist read (`collection(watchlistPath(uid)).get()`). The manual path must
// touch ONLY the caller's watchlist (read) + title-cache (write via the engine
// store) — never users/** writes, never system/sync. ---
function createFakeDb(opts: {
  watchlist: { tmdbId: number; type: 'movie' | 'tv' }[];
}) {
  const writes: { path: string; data: unknown }[] = [];
  const collectionPaths: string[] = [];

  const db = {
    collection: (path: string) => {
      collectionPaths.push(path);
      return {
        get: () =>
          Promise.resolve({
            docs: opts.watchlist.map((w) => ({ data: () => w })),
          }),
      };
    },
    doc: (path: string) => ({
      get: () => Promise.resolve({ exists: false, data: () => undefined }),
      set: (data: unknown) => {
        writes.push({ path, data });
        return Promise.resolve();
      },
    }),
  };

  return {
    db: db as unknown as RunTriggerSyncDeps['db'],
    writes,
    collectionPaths,
  };
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

describe('runTriggerSync handler wiring', () => {
  it('no auth uid → throws HttpsError(unauthenticated); engine NOT called', async () => {
    const { db, writes } = createFakeDb({ watchlist: [] });
    const factory = createFakeEngine((inputs) => inputs.map(syncedResult));

    await expect(
      runTriggerSync({ db, createEngine: () => factory.engine }, undefined),
    ).rejects.toBeInstanceOf(HttpsError);
    await expect(
      runTriggerSync({ db, createEngine: () => factory.engine }, undefined),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    expect(factory.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('gather rejects → throws HttpsError(internal, "Failed to read watchlist"); engine NOT called', async () => {
    const rejectingDb = {
      collection: () => ({
        get: () => Promise.reject(new Error('permission-denied')),
      }),
      doc: () => ({
        get: () => Promise.resolve({ exists: false, data: () => undefined }),
        set: () => Promise.resolve(),
      }),
    } as unknown as RunTriggerSyncDeps['db'];

    const factory = createFakeEngine((inputs) => inputs.map(syncedResult));

    const err: unknown = await runTriggerSync(
      { db: rejectingDb, createEngine: () => factory.engine },
      'user-1',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe('internal');
    expect((err as HttpsError).message).toBe('Failed to read watchlist');
    expect(factory.calls).toHaveLength(0); // engine never reached
  });

  it('valid uid → engine called with the deduped per-user titles; resolves { syncedAt }', async () => {
    const { db, collectionPaths } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 603, type: 'movie' }, // dupe → collapsed
        { tmdbId: 1396, type: 'tv' },
      ],
    });
    const factory = createFakeEngine((inputs) => inputs.map(syncedResult));

    const body = await runTriggerSync(
      { db, createEngine: () => factory.engine },
      'user-1',
    );

    // Reads the caller's own watchlist subcollection.
    expect(collectionPaths).toContain('users/user-1/watchlist');
    // Engine sees the deduped per-user titles.
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]).toEqual([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
    ]);
    // Resolves an ISO 8601 timestamp.
    expect(typeof body.syncedAt).toBe('string');
    expect(new Date(body.syncedAt).toISOString()).toBe(body.syncedAt);
  });

  it('BOUNDARY: no users/** write and no system/sync write across all paths', async () => {
    const { db, writes } = createFakeDb({
      watchlist: [
        { tmdbId: 603, type: 'movie' },
        { tmdbId: 1396, type: 'tv' },
      ],
    });
    const factory = createFakeEngine((inputs) => inputs.map(syncedResult));

    await runTriggerSync({ db, createEngine: () => factory.engine }, 'user-1');

    // The fake engine writes nothing through the store; assert NOTHING under
    // users/** and NOTHING to system/sync is written by the manual path.
    for (const w of writes) {
      expect(w.path.startsWith('users/')).toBe(false);
      expect(w.path).not.toBe('system/sync');
      expect(w.path).not.toContain('notifications');
    }
    expect(writes.some((w) => w.path === 'system/sync')).toBe(false);
  });

  it('partial engine error (one title outcome: error) still resolves { syncedAt }', async () => {
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

    const body = await runTriggerSync(
      { db, createEngine: () => mixed.engine },
      'user-1',
    );

    expect(typeof body.syncedAt).toBe('string');
    // The per-title reason never leaks into the response.
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('REGRESSION: syncTitles and dispatchNotifications remain exported', () => {
    expect(syncTitles).toBeDefined();
    expect(dispatchNotifications).toBeDefined();
  });
});
