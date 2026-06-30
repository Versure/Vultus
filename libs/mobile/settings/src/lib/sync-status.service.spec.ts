import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import type { SyncRunReadData } from '@vultus/shared/firestore-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the AngularFire Firestore free functions. Each builder echoes a tagged
// marker so we can assert the query was assembled with orderBy('startedAt',
// 'desc') + limit(1); getDocs is stubbed per-test.
interface SnapDocLike {
  data: () => unknown;
}
interface QuerySnapLike {
  docs: SnapDocLike[];
}

const collectionMock = vi.fn((_firestore: unknown, path: string) => ({
  kind: 'collection',
  path,
}));
const orderByMock = vi.fn((field: string, dir: string) => ({
  kind: 'orderBy',
  field,
  dir,
}));
const limitMock = vi.fn((n: number) => ({ kind: 'limit', n }));
const queryMock = vi.fn((...args: unknown[]) => ({ kind: 'query', args }));
const getDocsMock = vi.fn<(q: unknown) => Promise<QuerySnapLike>>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  collection: (firestore: unknown, path: string) =>
    collectionMock(firestore, path),
  query: (...args: unknown[]) => queryMock(...args),
  orderBy: (field: string, dir: string) => orderByMock(field, dir),
  limit: (n: number) => limitMock(n),
  getDocs: (q: unknown) => getDocsMock(q),
}));

import { SyncStatusService } from './sync-status.service';

const READ_DATA: SyncRunReadData = {
  runId: 'run-abc',
  kind: 'cron',
  userId: null,
  startedAt: { toDate: () => new Date('2026-06-30T10:00:00.000Z') },
  completedAt: { toDate: () => new Date('2026-06-30T10:00:45.000Z') },
  durationMs: 45_000,
  titlesGathered: 12,
  titlesUpdated: 3,
  errorCount: 0,
  errors: [],
};

function createService(): SyncStatusService {
  TestBed.configureTestingModule({
    providers: [SyncStatusService, { provide: Firestore, useValue: {} }],
  });
  return TestBed.inject(SyncStatusService);
}

describe('SyncStatusService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    collectionMock.mockClear();
    orderByMock.mockClear();
    limitMock.mockClear();
    queryMock.mockClear();
    getDocsMock.mockReset();
  });

  it('maps the single most-recent doc via dataToSyncRun', async () => {
    getDocsMock.mockResolvedValue({ docs: [{ data: () => READ_DATA }] });
    const service = createService();

    await service.load();

    expect(service.lastRun()).toEqual({
      runId: 'run-abc',
      kind: 'cron',
      userId: null,
      startedAt: '2026-06-30T10:00:00.000Z',
      completedAt: '2026-06-30T10:00:45.000Z',
      durationMs: 45_000,
      titlesGathered: 12,
      titlesUpdated: 3,
      errorCount: 0,
      errors: [],
    });
    expect(service.loaded()).toBe(true);
    expect(service.loadFailed()).toBe(false);
  });

  it('empty result → lastRun() is null (never-synced)', async () => {
    getDocsMock.mockResolvedValue({ docs: [] });
    const service = createService();

    await service.load();

    expect(service.lastRun()).toBeNull();
    expect(service.loaded()).toBe(true);
  });

  it('builds the query with orderBy(startedAt,desc) + limit(1) on sync-runs', async () => {
    getDocsMock.mockResolvedValue({ docs: [] });
    const service = createService();

    await service.load();

    expect(collectionMock).toHaveBeenCalledWith(expect.anything(), 'sync-runs');
    expect(orderByMock).toHaveBeenCalledWith('startedAt', 'desc');
    expect(limitMock).toHaveBeenCalledWith(1);
    // The query is assembled from the collection ref + the two constraints.
    expect(queryMock).toHaveBeenCalledWith(
      { kind: 'collection', path: 'sync-runs' },
      { kind: 'orderBy', field: 'startedAt', dir: 'desc' },
      { kind: 'limit', n: 1 },
    );
  });

  it('a rejecting read → loadFailed() true, lastRun() stays null', async () => {
    getDocsMock.mockRejectedValue(new Error('permission-denied'));
    const service = createService();

    await service.load();

    expect(service.loadFailed()).toBe(true);
    expect(service.lastRun()).toBeNull();
    expect(service.loaded()).toBe(false);
  });
});
