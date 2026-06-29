import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  notificationPath,
  notificationsPath,
  titleCacheDocPath,
} from '@vultus/shared/firestore-schema';
import type { FirestoreTimestampLike } from '@vultus/shared/firestore-schema';
import { type Observable, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsService } from './notifications.service';

// Mock AngularFire free functions. `doc`/`collection` echo the path so we can
// assert which document each read/write targets; query helpers thread a tagged
// object so we can assert orderBy/limit were applied.
interface Ref {
  path: string;
}
interface QueryRef {
  ref: Ref;
  constraints: unknown[];
}

const collectionMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const collectionDataMock =
  vi.fn<(ref: QueryRef, opts: unknown) => Observable<unknown>>();
const docDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
const deleteDocMock = vi.fn<(ref: Ref) => Promise<void>>();
const batchUpdateMock = vi.fn<(ref: Ref, payload: unknown) => void>();
const batchCommitMock = vi.fn<() => Promise<void>>();
const writeBatchMock = vi.fn(() => ({
  update: batchUpdateMock,
  commit: batchCommitMock,
}));

const orderByMock = vi.fn((field: string, dir: string) => ({
  kind: 'orderBy',
  field,
  dir,
}));
const limitMock = vi.fn((n: number) => ({ kind: 'limit', n }));
const queryMock = vi.fn(
  (ref: Ref, ...constraints: unknown[]): QueryRef => ({ ref, constraints }),
);

class FakeTimestamp {
  static now() {
    return new FakeTimestamp();
  }
}

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  Timestamp: { now: () => FakeTimestamp.now() },
  collection: (fs: unknown, path: string): Ref => collectionMock(fs, path),
  collectionData: (ref: QueryRef, opts: unknown): Observable<unknown> =>
    collectionDataMock(ref, opts),
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  docData: (ref: Ref): Observable<unknown> => docDataMock(ref),
  updateDoc: (ref: Ref, payload: unknown): Promise<void> =>
    updateDocMock(ref, payload),
  deleteDoc: (ref: Ref): Promise<void> => deleteDocMock(ref),
  writeBatch: () => writeBatchMock(),
  orderBy: (field: string, dir: string) => orderByMock(field, dir),
  limit: (n: number) => limitMock(n),
  query: (ref: Ref, ...c: unknown[]): QueryRef => queryMock(ref, ...c),
}));

const UID = 'user-123';
const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });

function notifReadDoc(over: Partial<{ id: string; readAt: Date | null }> = {}) {
  return {
    id: over.id ?? 'n1',
    titleId: '603',
    kind: 'episode-aired',
    payload: { tmdbId: 603, titleId: '603', title: 'The Matrix', region: 'NL' },
    sentAt: fakeTs(new Date('2026-06-24T10:00:00.000Z')),
    readAt:
      over.readAt === undefined ? null : over.readAt && fakeTs(over.readAt),
  };
}

function makeService(uid: string | null): NotificationsService {
  TestBed.configureTestingModule({
    providers: [
      NotificationsService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal(uid) },
    ],
  });
  return TestBed.inject(NotificationsService);
}

describe('NotificationsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateDocMock.mockResolvedValue(undefined);
    deleteDocMock.mockResolvedValue(undefined);
    batchCommitMock.mockResolvedValue(undefined);
    TestBed.resetTestingModule();
  });

  describe('notifications$', () => {
    it('builds the query with orderBy(sentAt desc) + limit(50), carries idField, maps via dataToNotification', async () => {
      collectionDataMock.mockReturnValue(of([notifReadDoc({ id: 'abc' })]));
      const service = makeService(UID);

      const rows = await firstValueFrom(service.notifications$());

      expect(collectionMock).toHaveBeenCalledWith({}, notificationsPath(UID));
      expect(orderByMock).toHaveBeenCalledWith('sentAt', 'desc');
      expect(limitMock).toHaveBeenCalledWith(50);
      // idField requested so each row gets its real doc id.
      expect(collectionDataMock).toHaveBeenCalledWith(expect.anything(), {
        idField: 'id',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('abc');
      expect(rows[0].payload.title).toBe('The Matrix');
      // dataToNotification converted the Timestamp → ISO string.
      expect(rows[0].sentAt).toBe('2026-06-24T10:00:00.000Z');
      expect(rows[0].readAt).toBeNull();
    });

    it('null uid → of([]) and builds no collection ref', async () => {
      const service = makeService(null);
      const rows = await firstValueFrom(service.notifications$());
      expect(rows).toEqual([]);
      expect(collectionMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  describe('posterUrl$', () => {
    it('composes TMDB_POSTER_BASE + posterPath on a cache hit', async () => {
      docDataMock.mockReturnValue(
        of({
          type: 'movie',
          traktId: null,
          metadata: {
            title: 'The Matrix',
            overview: '',
            posterPath: '/poster.jpg',
            releaseDate: null,
          },
          lastSyncedAt: fakeTs(new Date('2026-06-24T10:00:00.000Z')),
        }),
      );
      const service = makeService(UID);
      const url = await firstValueFrom(service.posterUrl$(603));
      expect(docMock).toHaveBeenCalledWith({}, titleCacheDocPath(603));
      expect(url).toBe('https://image.tmdb.org/t/p/w185/poster.jpg');
    });

    it('null on a missing cache doc', async () => {
      docDataMock.mockReturnValue(of(undefined));
      const service = makeService(UID);
      expect(await firstValueFrom(service.posterUrl$(603))).toBeNull();
    });

    it('null when posterPath is null', async () => {
      docDataMock.mockReturnValue(
        of({
          type: 'movie',
          traktId: null,
          metadata: {
            title: 'X',
            overview: '',
            posterPath: null,
            releaseDate: null,
          },
          lastSyncedAt: fakeTs(new Date('2026-06-24T10:00:00.000Z')),
        }),
      );
      const service = makeService(UID);
      expect(await firstValueFrom(service.posterUrl$(603))).toBeNull();
    });
  });

  describe('markRead', () => {
    it('updates notificationPath(uid,id) with a Timestamp readAt', async () => {
      const service = makeService(UID);
      await service.markRead('n9');
      expect(docMock).toHaveBeenCalledWith({}, notificationPath(UID, 'n9'));
      const [, payload] = updateDocMock.mock.calls[0];
      expect(payload).toHaveProperty('readAt');
      expect((payload as { readAt: unknown }).readAt).toBeInstanceOf(
        FakeTimestamp,
      );
    });

    it('null uid → no write', async () => {
      const service = makeService(null);
      await service.markRead('n9');
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('catches a rejected updateDoc (non-fatal)', async () => {
      updateDocMock.mockRejectedValueOnce(new Error('offline'));
      const service = makeService(UID);
      await expect(service.markRead('n9')).resolves.toBeUndefined();
    });
  });

  describe('markAllRead', () => {
    it('opens a writeBatch, one update per id, then commits', async () => {
      const service = makeService(UID);
      await service.markAllRead(['a', 'b', 'c']);
      expect(writeBatchMock).toHaveBeenCalledTimes(1);
      expect(batchUpdateMock).toHaveBeenCalledTimes(3);
      expect(docMock).toHaveBeenCalledWith({}, notificationPath(UID, 'a'));
      expect(docMock).toHaveBeenCalledWith({}, notificationPath(UID, 'c'));
      expect(batchCommitMock).toHaveBeenCalledTimes(1);
    });

    it('empty array → no commit', async () => {
      const service = makeService(UID);
      await service.markAllRead([]);
      expect(writeBatchMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
    });

    it('null uid → no-op', async () => {
      const service = makeService(null);
      await service.markAllRead(['a']);
      expect(writeBatchMock).not.toHaveBeenCalled();
    });

    it('catches a rejected commit (non-fatal)', async () => {
      batchCommitMock.mockRejectedValueOnce(new Error('offline'));
      const service = makeService(UID);
      await expect(service.markAllRead(['a'])).resolves.toBeUndefined();
    });
  });

  describe('remove', () => {
    it('deletes notificationPath(uid,id)', async () => {
      const service = makeService(UID);
      await service.remove('n9');
      expect(docMock).toHaveBeenCalledWith({}, notificationPath(UID, 'n9'));
      expect(deleteDocMock).toHaveBeenCalledTimes(1);
    });

    it('null uid → no-op', async () => {
      const service = makeService(null);
      await service.remove('n9');
      expect(deleteDocMock).not.toHaveBeenCalled();
    });

    it('catches a rejected deleteDoc (non-fatal)', async () => {
      deleteDocMock.mockRejectedValueOnce(new Error('offline'));
      const service = makeService(UID);
      await expect(service.remove('n9')).resolves.toBeUndefined();
    });
  });
});
