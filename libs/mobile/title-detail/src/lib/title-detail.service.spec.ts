import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID, type WatchlistItem } from '@vultus/shared/domain';
import {
  availabilityDocPath,
  titleCacheDocPath,
  userPath,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import type { FirestoreTimestampLike } from '@vultus/shared/firestore-schema';
import { type Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleDetail } from './tmdb-detail.client';
import {
  type DetailViewState,
  TitleDetailService,
} from './title-detail.service';
import { TMDB_DETAIL_CONFIG } from './tokens';

// --- AngularFire mock (echo path on doc(); per-test data emitters) ---
interface Ref {
  path: string;
}
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const docDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const getDocMock = vi.fn<(ref: Ref) => Promise<unknown>>();
const setDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
const deleteDocMock = vi.fn<(ref: Ref) => Promise<void>>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  docData: (ref: Ref): Observable<unknown> => docDataMock(ref),
  getDoc: (ref: Ref): Promise<unknown> => getDocMock(ref),
  setDoc: (ref: Ref, payload: unknown): Promise<void> =>
    setDocMock(ref, payload),
  updateDoc: (ref: Ref, payload: unknown): Promise<void> =>
    updateDocMock(ref, payload),
  deleteDoc: (ref: Ref): Promise<void> => deleteDocMock(ref),
}));

// --- Slice-local TMDB client mock ---
const getDetailMock = vi.fn<() => Promise<TitleDetail>>();
const getProvidersMock = vi.fn();
vi.mock('./tmdb-detail.client', () => ({
  TmdbDetailError: class extends Error {},
  createTmdbDetailClient: () => ({
    getDetail: getDetailMock,
    getProviders: getProvidersMock,
  }),
}));

const UID = 'user-123';
const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });
const CONFIG = {
  apiBaseUrl: 'https://api.tmdb.org/3',
  imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
  auth: { kind: 'apiKey' as const, apiKey: 'k' },
};

function snap(data: unknown) {
  return { exists: () => data !== undefined, data: () => data };
}

function liveDetail(over: Partial<TitleDetail> = {}): TitleDetail {
  return {
    tmdbId: 27205,
    type: 'movie',
    title: 'Inception',
    year: 2010,
    overview: 'dream heist',
    posterUrl: 'https://image.tmdb.org/t/p/w185/p.jpg',
    posterPath: '/p.jpg',
    voteAverage: 8.8,
    ...over,
  };
}

function createService(uid: string | null): TitleDetailService {
  TestBed.configureTestingModule({
    providers: [
      TitleDetailService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: TMDB_DETAIL_CONFIG, useValue: CONFIG },
    ],
  });
  return TestBed.inject(TitleDetailService);
}

function lastState(
  service: TitleDetailService,
  id: number,
): Promise<DetailViewState> {
  return new Promise((resolve) => {
    let latest: DetailViewState = { kind: 'loading' };
    service.detail$(id).subscribe({
      next: (s) => (latest = s),
      complete: () => resolve(latest),
    });
  });
}

describe('TitleDetailService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    docMock.mockClear();
    docDataMock.mockReset();
    getDocMock.mockReset();
    setDocMock.mockReset().mockResolvedValue(undefined);
    updateDocMock.mockReset().mockResolvedValue(undefined);
    deleteDocMock.mockReset().mockResolvedValue(undefined);
    getDetailMock.mockReset();
    getProvidersMock.mockReset();
  });

  it('cache hit → source:cache, live client NOT called, mapped via dataToTitleCache', async () => {
    getDocMock.mockResolvedValue(
      snap({
        type: 'movie',
        traktId: null,
        metadata: {
          title: 'Inception',
          overview: 'dream heist',
          posterPath: '/p.jpg',
          releaseDate: '2010-07-16',
        },
        lastSyncedAt: fakeTs(new Date('2026-06-01T00:00:00Z')),
      }),
    );
    const service = createService(UID);
    const state = await lastState(service, 27205);
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.source).toBe('cache');
      expect(state.detail.title).toBe('Inception');
      expect(state.detail.year).toBe(2010);
      expect(state.detail.posterUrl).toBe(
        'https://image.tmdb.org/t/p/w185/p.jpg',
      );
      expect(state.detail.voteAverage).toBeNull(); // recon C — not on cached metadata
    }
    expect(getDetailMock).not.toHaveBeenCalled();
    expect(docMock).toHaveBeenCalledWith({}, titleCacheDocPath(27205));
  });

  it('cache hit → providers come from the availability doc via dataToAvailability', async () => {
    docDataMock.mockReturnValue(
      of({
        providers: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
        lastSyncedAt: fakeTs(new Date('2026-06-01T00:00:00Z')),
        previousSnapshot: [],
      }),
    );
    const service = createService(UID);
    const groups = await new Promise((resolve) =>
      service.providers$(27205, 'movie', 'NL', 'cache').subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, availabilityDocPath(27205, 'NL'));
    expect(groups).toEqual({
      flatrate: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
      rent: [],
      buy: [],
    });
    expect(getProvidersMock).not.toHaveBeenCalled();
  });

  it('cache miss → live fallback for a movie (source:live, no title-cache write)', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockResolvedValue(liveDetail({ type: 'movie' }));
    const service = createService(UID);
    const state = await lastState(service, 27205);
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.source).toBe('live');
      expect(state.detail.type).toBe('movie');
    }
    expect(getDetailMock).toHaveBeenCalledTimes(1);
    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('cache miss → live fallback for a tv title', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockResolvedValue(liveDetail({ type: 'tv', tmdbId: 1396 }));
    const service = createService(UID);
    const state = await lastState(service, 1396);
    if (state.kind === 'loaded') {
      expect(state.source).toBe('live');
      expect(state.detail.type).toBe('tv');
    }
  });

  it('cache miss + live throws → not-found', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockRejectedValue(new Error('404'));
    const service = createService(UID);
    const state = await lastState(service, 999);
    expect(state.kind).toBe('not-found');
  });

  it('region$ emits the user region, and null when the doc is absent', async () => {
    docDataMock.mockReturnValue(
      of({ region: 'NL', notificationPrefs: {}, fcmTokens: [] }),
    );
    const service = createService(UID);
    const region = await new Promise((resolve) =>
      service.region$().subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, userPath(UID));
    expect(region).toBe('NL');

    docDataMock.mockReturnValue(of(undefined));
    TestBed.resetTestingModule();
    const service2 = createService(UID);
    const none = await new Promise((resolve) =>
      service2.region$().subscribe(resolve),
    );
    expect(none).toBeNull();
  });

  it('null region → providers not fetched, empty groups', async () => {
    const service = createService(UID);
    const groups = await new Promise((resolve) =>
      service.providers$(1, 'movie', null, 'cache').subscribe(resolve),
    );
    expect(groups).toEqual({ flatrate: [], rent: [], buy: [] });
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('tracked$ emits the mapped item, and null when absent', async () => {
    docDataMock.mockReturnValue(
      of({
        type: 'movie',
        tmdbId: 27205,
        traktId: null,
        title: 'Inception',
        addedAt: fakeTs(new Date('2026-03-04T05:06:07Z')),
        status: 'planned',
      }),
    );
    const service = createService(UID);
    const item = await new Promise<WatchlistItem | null>((resolve) =>
      service.tracked$(27205).subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, watchlistItemPath(UID, '27205'));
    expect(item?.status).toBe('planned');

    docDataMock.mockReturnValue(of(undefined));
    TestBed.resetTestingModule();
    const service2 = createService(UID);
    const none = await new Promise((resolve) =>
      service2.tracked$(27205).subscribe(resolve),
    );
    expect(none).toBeNull();
  });

  it('add() writes status planned, traktId null, id=String(tmdbId), denormalized fields', async () => {
    const service = createService(UID);
    await service.add(
      liveDetail({ tmdbId: 27205, posterPath: '/p.jpg', voteAverage: 8.8 }),
    );
    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = setDocMock.mock.calls[0];
    expect(ref).toEqual({ path: watchlistItemPath(UID, '27205') });
    const p = payload as Record<string, unknown>;
    expect(p['status']).toBe('planned');
    expect(p['traktId']).toBeNull();
    expect(p['tmdbId']).toBe(27205);
    expect(p['posterPath']).toBe('/p.jpg');
    expect(p['voteAverage']).toBe(8.8);
  });

  it('updateStatus / removeTitle target the watchlist item path', async () => {
    const service = createService(UID);
    await service.updateStatus(27205, 'completed');
    expect(updateDocMock.mock.calls[0][0]).toEqual({
      path: watchlistItemPath(UID, '27205'),
    });
    expect(updateDocMock.mock.calls[0][1]).toEqual({ status: 'completed' });
    await service.removeTitle(27205);
    expect(deleteDocMock.mock.calls[0][0]).toEqual({
      path: watchlistItemPath(UID, '27205'),
    });
  });

  it('null-uid guard: region$/tracked$ → null; add/updateStatus/removeTitle no-op; detail$ still resolves', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockResolvedValue(liveDetail());
    const service = createService(null);

    const region = await new Promise((resolve) =>
      service.region$().subscribe(resolve),
    );
    const tracked = await new Promise((resolve) =>
      service.tracked$(1).subscribe(resolve),
    );
    expect(region).toBeNull();
    expect(tracked).toBeNull();

    await service.add(liveDetail());
    await service.updateStatus(1, 'completed');
    await service.removeTitle(1);
    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(deleteDocMock).not.toHaveBeenCalled();

    const state = await lastState(service, 1);
    expect(state.kind).toBe('loaded');
  });

  it('no write targets anything but the watchlist item doc', async () => {
    const service = createService(UID);
    await service.add(liveDetail({ tmdbId: 1 }));
    await service.updateStatus(2, 'dropped');
    await service.removeTitle(3);
    const writtenPaths = [
      ...setDocMock.mock.calls,
      ...updateDocMock.mock.calls,
      ...deleteDocMock.mock.calls,
    ].map(([ref]) => ref.path);
    for (const path of writtenPaths) {
      expect(path).toMatch(new RegExp(`^${userPath(UID)}/watchlist/\\d+$`));
      expect(path).not.toContain('title-cache');
      expect(path).not.toContain('episodes');
    }
  });
});
