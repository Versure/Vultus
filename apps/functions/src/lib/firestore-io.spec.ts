import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { SyncRun } from '@vultus/shared/domain';
import { gatherActiveRegions, writeSyncRun } from './firestore-io';

// A fake Firestore that records the auto-id `.doc().set(...)` write the helper
// performs — no Admin SDK, no network.
function createFakeDb(autoId = 'generated-id') {
  const writes: { collection: string; id: string; data: unknown }[] = [];
  const db = {
    collection: (collectionPath: string) => ({
      doc: () => ({
        id: autoId,
        set: (data: unknown) => {
          writes.push({ collection: collectionPath, id: autoId, data });
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: db as unknown as Firestore, writes };
}

describe('writeSyncRun', () => {
  it('writes to sync-runs with an auto-id, sets runId == doc id, applies syncRunToData (timestamps → Date)', async () => {
    const { db, writes } = createFakeDb('abc123');
    const run: Omit<SyncRun, 'runId'> = {
      kind: 'cron',
      userId: null,
      startedAt: '2026-06-30T10:00:00.000Z',
      completedAt: '2026-06-30T10:00:05.000Z',
      durationMs: 5000,
      titlesGathered: 12,
      titlesUpdated: 3,
      errorCount: 0,
      errors: [],
    };

    const runId = await writeSyncRun(db, run);

    expect(runId).toBe('abc123');
    expect(writes).toHaveLength(1);
    expect(writes[0].collection).toBe('sync-runs');
    const data = writes[0].data as {
      runId: string;
      kind: string;
      userId: string | null;
      startedAt: Date;
      completedAt: Date;
      durationMs: number;
      titlesGathered: number;
      titlesUpdated: number;
      errorCount: number;
      errors: string[];
    };
    // runId == the doc id is stored into the document.
    expect(data.runId).toBe('abc123');
    expect(data.kind).toBe('cron');
    expect(data.userId).toBeNull();
    // syncRunToData crosses the ISO ↔ Timestamp boundary (Date on write).
    expect(data.startedAt).toBeInstanceOf(Date);
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(data.startedAt.toISOString()).toBe(run.startedAt);
    expect(data.completedAt.toISOString()).toBe(run.completedAt);
    expect(data.durationMs).toBe(5000);
    expect(data.titlesGathered).toBe(12);
    expect(data.titlesUpdated).toBe(3);
    expect(data.errorCount).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('carries a manual run with a userId and populated errors through', async () => {
    const { db, writes } = createFakeDb('run-9');
    await writeSyncRun(db, {
      kind: 'manual',
      userId: 'user-1',
      startedAt: '2026-06-30T11:00:00.000Z',
      completedAt: '2026-06-30T11:00:02.000Z',
      durationMs: 2000,
      titlesGathered: 4,
      titlesUpdated: 1,
      errorCount: 1,
      errors: ['tmdb 500'],
    });
    const data = writes[0].data as {
      kind: string;
      userId: string | null;
      errors: string[];
    };
    expect(data.kind).toBe('manual');
    expect(data.userId).toBe('user-1');
    expect(data.errors).toEqual(['tmdb 500']);
  });
});

// A fake Firestore whose users collection `.get()` yields the given raw docs.
function createUsersDb(userDocs: { region?: unknown }[]) {
  const collectionCalls: string[] = [];
  const db = {
    collection: (path: string) => {
      collectionCalls.push(path);
      return {
        get: () =>
          Promise.resolve({
            docs: userDocs.map((data) => ({ data: () => data })),
          }),
      };
    },
  };
  return { db: db as unknown as Firestore, collectionCalls };
}

describe('gatherActiveRegions (spec 0099)', () => {
  it('returns the distinct union of users[].region', async () => {
    const { db } = createUsersDb([
      { region: 'NL' },
      { region: 'DE' },
      { region: 'NL' }, // duplicate → deduped
    ]);
    const regions = await gatherActiveRegions(db);
    expect(new Set(regions)).toEqual(new Set(['NL', 'DE']));
    expect(regions).toHaveLength(2);
  });

  it('reads the `users` collection (COLLECTIONS.users constant, not a literal)', async () => {
    const { db, collectionCalls } = createUsersDb([{ region: 'NL' }]);
    await gatherActiveRegions(db);
    expect(collectionCalls).toEqual(['users']);
  });

  it('drops values not in REGIONS (and missing/non-string region fields)', async () => {
    const { db } = createUsersDb([
      { region: 'NL' },
      { region: 'ZZ' }, // not a REGIONS member
      { region: 123 }, // non-string
      {}, // missing region
    ]);
    const regions = await gatherActiveRegions(db);
    expect(regions).toEqual(['NL']);
  });

  it('returns [] for an empty users collection', async () => {
    const { db } = createUsersDb([]);
    expect(await gatherActiveRegions(db)).toEqual([]);
  });
});
