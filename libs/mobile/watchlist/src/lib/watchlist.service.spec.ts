import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type RegionAvailability,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  episodesPath,
  notificationsPath,
  userPath,
  watchlistItemPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type { FirestoreTimestampLike } from '@vultus/shared/firestore-schema';
import { type Observable, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WatchlistService,
  filterByType,
  getAvailableProviders,
  groupByStatus,
  sortItems,
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
const getDocsMock = vi.fn<(ref: Ref) => Promise<unknown>>();
const batchUpdateMock = vi.fn();
const batchCommitMock = vi.fn(() => Promise.resolve());
const writeBatchMock = vi.fn(() => ({
  update: batchUpdateMock,
  commit: batchCommitMock,
}));

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  collection: (fs: unknown, path: string): Ref => collectionMock(fs, path),
  collectionData: (ref: Ref): Observable<unknown> => collectionDataMock(ref),
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  docData: (ref: Ref): Observable<unknown> => docDataMock(ref),
  updateDoc: (ref: Ref, payload: unknown): void => updateDocMock(ref, payload),
  deleteDoc: (ref: Ref): void => deleteDocMock(ref),
  getDocs: (ref: Ref): Promise<unknown> => getDocsMock(ref),
  writeBatch: (): unknown => writeBatchMock(),
}));

const UID = 'user-123';
const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });

// --- Episode fixtures (read-data shape: airDate/watchedAt are Timestamp-like) ---
interface EpFixture {
  id: string;
  season: number;
  episode: number;
  watched: boolean;
}
function epReadData(e: EpFixture) {
  return {
    season: e.season,
    episode: e.episode,
    title: null,
    airDate: fakeTs(new Date('2008-01-20T00:00:00Z')),
    watched: e.watched,
    watchedAt: e.watched ? fakeTs(new Date('2026-06-24T10:00:00Z')) : null,
  };
}
/** A getDocs() snapshot: { docs: [{ id, ref, data() }] }. */
function docsSnap(eps: EpFixture[]) {
  return {
    docs: eps.map((e) => ({
      id: e.id,
      ref: { path: `ep/${e.id}` },
      data: () => epReadData(e),
    })),
  };
}

function readDoc(
  over: Partial<{ tmdbId: number; type: string; status: string }>,
) {
  return {
    type: over.type ?? 'movie',
    tmdbId: over.tmdbId ?? 1,
    title: 'T' + (over.tmdbId ?? 1),
    addedAt: fakeTs(new Date('2026-03-04T05:06:07.000Z')),
    status: over.status ?? 'watching',
  };
}

function item(over: Partial<WatchlistItem>): WatchlistItem {
  return {
    type: 'movie',
    tmdbId: 1,
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

describe('sortItems', () => {
  const A = item({
    tmdbId: 1,
    title: 'apple',
    addedAt: '2026-01-01T00:00:00.000Z',
    releaseDate: '2020-05-01',
  });
  const B = item({
    tmdbId: 2,
    title: 'Banana',
    addedAt: '2026-03-01T00:00:00.000Z',
    releaseDate: '2022-09-01',
  });
  const C = item({
    tmdbId: 3,
    title: 'cherry',
    addedAt: '2026-02-01T00:00:00.000Z',
    releaseDate: null,
  });
  const D = item({
    tmdbId: 4,
    title: 'Date',
    addedAt: '2026-04-01T00:00:00.000Z',
    // releaseDate absent
  });

  it('titleAsc / titleDesc sort case-insensitively', () => {
    const asc = sortItems([B, D, A, C], 'titleAsc').map((i) => i.tmdbId);
    expect(asc).toEqual([1, 2, 3, 4]); // apple, Banana, cherry, Date
    const desc = sortItems([B, D, A, C], 'titleDesc').map((i) => i.tmdbId);
    expect(desc).toEqual([4, 3, 2, 1]);
  });

  it('addedDesc is newest-first, addedAsc is oldest-first by addedAt', () => {
    const desc = sortItems([A, B, C, D], 'addedDesc').map((i) => i.tmdbId);
    expect(desc).toEqual([4, 2, 3, 1]); // 04, 03, 02, 01
    const asc = sortItems([A, B, C, D], 'addedAsc').map((i) => i.tmdbId);
    expect(asc).toEqual([1, 3, 2, 4]);
  });

  it('releaseDesc / releaseAsc push null/absent releaseDate to the END in both directions', () => {
    const desc = sortItems([A, B, C, D], 'releaseDesc').map((i) => i.tmdbId);
    // present sorted newest→oldest: B(2022) A(2020); then C(null) D(absent) at end
    expect(desc.slice(0, 2)).toEqual([2, 1]);
    expect(desc.slice(2).sort()).toEqual([3, 4]);

    const asc = sortItems([A, B, C, D], 'releaseAsc').map((i) => i.tmdbId);
    // present sorted oldest→newest: A(2020) B(2022); then C/D at end
    expect(asc.slice(0, 2)).toEqual([1, 2]);
    expect(asc.slice(2).sort()).toEqual([3, 4]);
  });

  it('does not mutate the input array (returns a copy)', () => {
    const input = [B, A, C, D];
    const snapshot = [...input];
    const out = sortItems(input, 'titleAsc');
    expect(input).toEqual(snapshot); // same order, untouched
    expect(out).not.toBe(input);
  });
});

describe('getAvailableProviders', () => {
  const i1 = item({ tmdbId: 1 });
  const i2 = item({ tmdbId: 2 });
  const i3 = item({ tmdbId: 3 });

  it('returns the unique, A→Z (case-insensitive) sorted union of provider names', () => {
    const map = new Map<number, string[]>([
      [1, ['Netflix', 'disney+']],
      [2, ['Netflix', 'Apple TV']],
    ]);
    expect(getAvailableProviders([i1, i2], map)).toEqual([
      'Apple TV',
      'disney+',
      'Netflix',
    ]);
  });

  it('items with no map entry or an empty array contribute nothing', () => {
    const map = new Map<number, string[]>([
      [1, ['Netflix']],
      [2, []], // empty → contributes nothing
      // i3 has no entry
    ]);
    expect(getAvailableProviders([i1, i2, i3], map)).toEqual(['Netflix']);
  });

  it('returns [] when the map yields no providers', () => {
    expect(getAvailableProviders([i1, i2], new Map())).toEqual([]);
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
    getDocsMock.mockReset();
    batchUpdateMock.mockReset();
    batchCommitMock.mockReset().mockResolvedValue(undefined);
    writeBatchMock.mockClear();
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

  it('updateStatus calls updateDoc with the item path + { status } (movie → no episode read)', async () => {
    const service = createService(UID);
    await service.updateStatus(UID, '1', 'completed', 'movie');
    expect(docMock).toHaveBeenCalledWith({}, watchlistItemPath(UID, '1'));
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: watchlistItemPath(UID, '1') });
    expect(payload).toEqual({ status: 'completed' });
    // Movie: the completed-episode branch is short-circuited entirely.
    expect(getDocsMock).not.toHaveBeenCalled();
    expect(writeBatchMock).not.toHaveBeenCalled();
  });

  describe('updateStatus — completed marks episodes watched (spec 0053)', () => {
    it('TV + some unwatched episodes → status written AND batch commits { watched, watchedAt } for ONLY the unwatched docs', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, watched: true }, // already watched
          { id: 's01e02', season: 1, episode: 2, watched: false }, // unwatched
          { id: 's01e03', season: 1, episode: 3, watched: false }, // unwatched
        ]),
      );
      const service = createService(UID);
      await service.updateStatus(UID, '2', 'completed', 'tv');

      // Read the WHOLE subcollection (no where filter).
      expect(collectionMock).toHaveBeenCalledWith({}, episodesPath(UID, '2'));
      expect(getDocsMock).toHaveBeenCalledTimes(1);

      // Only the two unwatched docs are batched — the already-watched one is not.
      expect(batchUpdateMock).toHaveBeenCalledTimes(2);
      const batchedPaths = batchUpdateMock.mock.calls.map(
        ([ref]) => (ref as { path: string }).path,
      );
      expect(batchedPaths.sort()).toEqual(['ep/s01e02', 'ep/s01e03']);
      for (const [, payload] of batchUpdateMock.mock.calls) {
        const p = payload as { watched: boolean; watchedAt: unknown };
        expect(p.watched).toBe(true);
        expect(p.watchedAt).toBeInstanceOf(Date);
      }
      expect(batchCommitMock).toHaveBeenCalledTimes(1);

      // Status is still written — with the next-unwatched field nulled (spec 0081).
      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({
        status: 'completed',
        nextUnwatchedEpisodeAirDate: null,
      });
    });

    it('TV + all episodes already watched → status written, NO batch commit', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, watched: true },
          { id: 's01e02', season: 1, episode: 2, watched: true },
        ]),
      );
      const service = createService(UID);
      await service.updateStatus(UID, '2', 'completed', 'tv');

      expect(getDocsMock).toHaveBeenCalledTimes(1);
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({
        status: 'completed',
        nextUnwatchedEpisodeAirDate: null,
      });
    });

    it('TV + empty subcollection → status written, NO batch commit', async () => {
      getDocsMock.mockResolvedValue(docsSnap([]));
      const service = createService(UID);
      await service.updateStatus(UID, '2', 'completed', 'tv');

      expect(getDocsMock).toHaveBeenCalledTimes(1);
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({
        status: 'completed',
        nextUnwatchedEpisodeAirDate: null,
      });
    });

    it('Movie → status written, NO episode read/batch at all', async () => {
      const service = createService(UID);
      await service.updateStatus(UID, '9', 'completed', 'movie');

      expect(getDocsMock).not.toHaveBeenCalled();
      expect(writeBatchMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({ status: 'completed' });
    });

    it('null uid → no-op (no status write, no episode read) with the widened signature', async () => {
      const service = createService(null);
      await service.updateStatus(null, '2', 'completed', 'tv');

      expect(updateDocMock).not.toHaveBeenCalled();
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(writeBatchMock).not.toHaveBeenCalled();
    });

    it.each(['watching', 'planned', 'dropped'] as const)(
      "non-'completed' status (%s) on a TV show → status written, NO episode read/batch (forward direction only, decision 6)",
      async (status) => {
        const service = createService(UID);
        await service.updateStatus(UID, '2', status, 'tv');

        expect(getDocsMock).not.toHaveBeenCalled();
        expect(writeBatchMock).not.toHaveBeenCalled();
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1]).toEqual({ status });
      },
    );
  });

  describe('updateStatus — nextUnwatchedEpisodeAirDate null-write (spec 0081)', () => {
    it('completed→tv → status write includes nextUnwatchedEpisodeAirDate: null (everything now watched)', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, watched: false },
          { id: 's01e02', season: 1, episode: 2, watched: false },
        ]),
      );
      const service = createService(UID);
      await service.updateStatus(UID, '2', 'completed', 'tv');

      expect(updateDocMock).toHaveBeenCalledTimes(1);
      const [, payload] = updateDocMock.mock.calls[0];
      expect(payload).toEqual({
        status: 'completed',
        nextUnwatchedEpisodeAirDate: null,
      });
    });

    it('completed→movie → NO nextUnwatchedEpisodeAirDate key in the write', async () => {
      const service = createService(UID);
      await service.updateStatus(UID, '1', 'completed', 'movie');

      expect(updateDocMock).toHaveBeenCalledTimes(1);
      const [, payload] = updateDocMock.mock.calls[0];
      expect(payload).toEqual({ status: 'completed' });
      expect(payload as Record<string, unknown>).not.toHaveProperty(
        'nextUnwatchedEpisodeAirDate',
      );
    });

    it.each(['watching', 'planned', 'dropped'] as const)(
      'non-completed status (%s) on a TV show → NO nextUnwatchedEpisodeAirDate key in the write',
      async (status) => {
        const service = createService(UID);
        await service.updateStatus(UID, '2', status, 'tv');

        expect(updateDocMock).toHaveBeenCalledTimes(1);
        const [, payload] = updateDocMock.mock.calls[0];
        expect(payload).toEqual({ status });
        expect(payload as Record<string, unknown>).not.toHaveProperty(
          'nextUnwatchedEpisodeAirDate',
        );
      },
    );
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

  it('myProviderIds$ emits the persisted array when the doc has it', async () => {
    docDataMock.mockReturnValue(
      of({
        region: 'NL',
        notificationPrefs: {},
        fcmTokens: [],
        myProviderIds: [8, 337],
      }),
    );
    const service = createService(UID);
    const ids = await new Promise<number[]>((resolve) =>
      service.myProviderIds$(UID).subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, userPath(UID));
    expect(ids).toEqual([8, 337]);
  });

  it('myProviderIds$ defaults to [] for a legacy user doc missing the field', async () => {
    docDataMock.mockReturnValue(
      of({ region: 'NL', notificationPrefs: {}, fcmTokens: [] }),
    );
    const service = createService(UID);
    const ids = await new Promise<number[]>((resolve) =>
      service.myProviderIds$(UID).subscribe(resolve),
    );
    expect(ids).toEqual([]);
  });

  it('myProviderIds$ → [] with a null uid without touching Firestore', async () => {
    const service = createService(null);
    const ids = await new Promise<number[]>((resolve) =>
      service.myProviderIds$(null).subscribe(resolve),
    );
    expect(ids).toEqual([]);
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('userRegion$ and myProviderIds$ share ONE users/{uid} listener (no duplicate docData)', async () => {
    docDataMock.mockReturnValue(
      of({
        region: 'DE',
        notificationPrefs: {},
        fcmTokens: [],
        myProviderIds: [8],
      }),
    );
    const service = createService(UID);
    await new Promise((resolve) => service.userRegion$(UID).subscribe(resolve));
    await new Promise((resolve) =>
      service.myProviderIds$(UID).subscribe(resolve),
    );
    // Only one docData subscription is opened on users/{uid} across both reads.
    const userDocCalls = docMock.mock.calls.filter(
      ([, path]) => path === userPath(UID),
    );
    expect(userDocCalls).toHaveLength(1);
    expect(docDataMock).toHaveBeenCalledTimes(1);
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

    void service.updateStatus(null, '1', 'completed', 'movie');
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

  it('unreadNotificationCount$ counts readAt === null over the streamed collection', async () => {
    collectionDataMock.mockReturnValue(
      of([
        { readAt: null },
        { readAt: fakeTs(new Date('2026-06-01T00:00:00.000Z')) },
        { readAt: null },
        {}, // absent readAt → also unread
      ]),
    );
    const service = createService(UID);
    const count = await firstValueFrom(service.unreadNotificationCount$);
    expect(collectionMock).toHaveBeenCalledWith({}, notificationsPath(UID));
    expect(count).toBe(3);
  });

  it('unreadNotificationCount$ → 0 with a null uid (no collection ref built)', async () => {
    const service = createService(null);
    const count = await firstValueFrom(service.unreadNotificationCount$);
    expect(count).toBe(0);
    expect(collectionMock).not.toHaveBeenCalled();
    expect(collectionDataMock).not.toHaveBeenCalled();
  });

  it('every write targets a watchlist item doc (never user/title-cache)', async () => {
    const service = createService(UID);
    await service.updateStatus(UID, '1', 'dropped', 'movie');
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
