import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type RegionAvailability,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  watchlistItemPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type { FirestoreTimestampLike } from '@vultus/shared/firestore-schema';
import { type Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WatchlistService,
  filterByType,
  groupByStatus,
} from './watchlist.service';

// Mock AngularFire's free functions. `doc`/`collection` echo the path so we can
// assert which document each read/write targets; data emitters are stubbed
// per-test.
interface Ref {
  path: string;
}

const collectionMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const collectionDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const docDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => void>();
const deleteDocMock = vi.fn<(ref: Ref) => void>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  collection: (fs: unknown, path: string): Ref => collectionMock(fs, path),
  collectionData: (ref: Ref): Observable<unknown> => collectionDataMock(ref),
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  docData: (ref: Ref): Observable<unknown> => docDataMock(ref),
  updateDoc: (ref: Ref, payload: unknown): void => updateDocMock(ref, payload),
  deleteDoc: (ref: Ref): void => deleteDocMock(ref),
}));

const UID = 'user-123';
const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });

function readDoc(
  over: Partial<{ tmdbId: number; type: string; status: string }>,
) {
  return {
    type: over.type ?? 'movie',
    tmdbId: over.tmdbId ?? 1,
    traktId: null,
    title: 'T' + (over.tmdbId ?? 1),
    addedAt: fakeTs(new Date('2026-03-04T05:06:07.000Z')),
    status: over.status ?? 'watching',
  };
}

function item(over: Partial<WatchlistItem>): WatchlistItem {
  return {
    type: 'movie',
    tmdbId: 1,
    traktId: null,
    title: 'Title',
    addedAt: '2026-03-04T05:06:07.000Z',
    status: 'watching',
    ...over,
  };
}

function createService(uid: string | null): WatchlistService {
  TestBed.configureTestingModule({
    providers: [
      WatchlistService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
    ],
  });
  return TestBed.inject(WatchlistService);
}

describe('groupByStatus', () => {
  it('groups in display order (watching → planned → completed → dropped), omits empty, correct counts', () => {
    const items = [
      item({ tmdbId: 1, status: 'completed' }),
      item({ tmdbId: 2, status: 'watching' }),
      item({ tmdbId: 3, status: 'watching' }),
      item({ tmdbId: 4, status: 'planned' }),
      // no 'dropped' → group omitted
    ];
    const groups = groupByStatus(items);
    expect(groups.map((g) => g.status)).toEqual([
      'watching',
      'planned',
      'completed',
    ]);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(groups[0].label).toBe('Watching');
  });
});

describe('filterByType', () => {
  const items = [
    item({ tmdbId: 1, type: 'movie' }),
    item({ tmdbId: 2, type: 'tv' }),
    item({ tmdbId: 3, type: 'movie' }),
  ];
  it('returns only movies for movie', () => {
    expect(filterByType(items, 'movie').map((i) => i.tmdbId)).toEqual([1, 3]);
  });
  it('returns only tv for tv', () => {
    expect(filterByType(items, 'tv').map((i) => i.tmdbId)).toEqual([2]);
  });
  it('returns all for undefined', () => {
    expect(filterByType(items, undefined)).toHaveLength(3);
  });
});

describe('WatchlistService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    collectionMock.mockClear();
    docMock.mockClear();
    collectionDataMock.mockReset();
    docDataMock.mockReset();
    updateDocMock.mockReset();
    deleteDocMock.mockReset();
  });

  it('watchlist$ maps docs through dataToWatchlistItem', async () => {
    collectionDataMock.mockReturnValue(
      of([
        readDoc({ tmdbId: 1, type: 'movie' }),
        readDoc({ tmdbId: 2, type: 'tv' }),
      ]),
    );
    const service = createService(UID);
    const items = await new Promise<WatchlistItem[]>((resolve) =>
      service.watchlist$(UID).subscribe(resolve),
    );
    expect(collectionMock).toHaveBeenCalledWith({}, watchlistPath(UID));
    expect(items).toHaveLength(2);
    expect(items[0].addedAt).toBe('2026-03-04T05:06:07.000Z');
    expect(items[0].posterPath).toBeNull();
  });

  it('watchlist$ with type arg filters to that type', async () => {
    collectionDataMock.mockReturnValue(
      of([
        readDoc({ tmdbId: 1, type: 'movie' }),
        readDoc({ tmdbId: 2, type: 'tv' }),
      ]),
    );
    const service = createService(UID);
    const items = await new Promise<WatchlistItem[]>((resolve) =>
      service.watchlist$(UID, 'tv').subscribe(resolve),
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('tv');
  });

  it('updateStatus calls updateDoc with the item path + { status }', () => {
    const service = createService(UID);
    service.updateStatus(UID, '1', 'completed');
    expect(docMock).toHaveBeenCalledWith({}, watchlistItemPath(UID, '1'));
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: watchlistItemPath(UID, '1') });
    expect(payload).toEqual({ status: 'completed' });
  });

  it('removeTitle calls deleteDoc with the item path', () => {
    const service = createService(UID);
    service.removeTitle(UID, '7');
    expect(deleteDocMock).toHaveBeenCalledTimes(1);
    expect(deleteDocMock.mock.calls[0][0]).toEqual({
      path: watchlistItemPath(UID, '7'),
    });
  });

  it('userRegion$ emits region when doc exists', async () => {
    docDataMock.mockReturnValue(
      of({ region: 'DE', notificationPrefs: {}, fcmTokens: [] }),
    );
    const service = createService(UID);
    const region = await new Promise((resolve) =>
      service.userRegion$(UID).subscribe(resolve),
    );
    expect(region).toBe('DE');
  });

  it('availability$ maps RegionAvailability when doc exists, null when absent', async () => {
    docDataMock.mockReturnValue(
      of({
        providers: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
        lastSyncedAt: fakeTs(new Date('2026-06-10T00:00:00.000Z')),
        previousSnapshot: [],
      }),
    );
    const service = createService(UID);
    const present = await new Promise<RegionAvailability | null>((resolve) =>
      service.availability$(603, 'NL').subscribe(resolve),
    );
    expect(present).not.toBeNull();
    expect(present?.providers[0].name).toBe('Netflix');

    docDataMock.mockReturnValue(of(undefined));
    const absent = await new Promise((resolve) =>
      service.availability$(603, 'NL').subscribe(resolve),
    );
    expect(absent).toBeNull();
  });

  it('null-uid guard: watchlist$ → [], userRegion$ → null, mutations are no-ops', async () => {
    const service = createService(null);
    const items = await new Promise((resolve) =>
      service.watchlist$(null).subscribe(resolve),
    );
    expect(items).toEqual([]);
    const region = await new Promise((resolve) =>
      service.userRegion$(null).subscribe(resolve),
    );
    expect(region).toBeNull();

    service.updateStatus(null, '1', 'completed');
    service.removeTitle(null, '1');
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(deleteDocMock).not.toHaveBeenCalled();
    expect(collectionDataMock).not.toHaveBeenCalled();
  });

  it('availability$ with null region → null without touching Firestore', async () => {
    const service = createService(UID);
    const result = await new Promise((resolve) =>
      service.availability$(603, null).subscribe(resolve),
    );
    expect(result).toBeNull();
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('every write targets a watchlist item doc (never user/title-cache)', () => {
    const service = createService(UID);
    service.updateStatus(UID, '1', 'dropped');
    service.removeTitle(UID, '2');
    const writtenPaths = [
      ...updateDocMock.mock.calls,
      ...deleteDocMock.mock.calls,
    ].map(([ref]) => ref.path);
    for (const path of writtenPaths) {
      expect(path.startsWith(watchlistPath(UID) + '/')).toBe(true);
    }
  });
});
