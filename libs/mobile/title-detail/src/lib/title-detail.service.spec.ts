import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { type WatchlistItem } from '@vultus/shared/domain';
import {
  availabilityDocPath,
  episodePath,
  episodesPath,
  titleCacheDocPath,
  userPath,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import type { FirestoreTimestampLike } from '@vultus/shared/firestore-schema';
import { type Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TmdbDetailError, type TitleDetail } from './tmdb-detail.client';
import {
  type DetailViewState,
  type SeasonGroup,
  TitleDetailService,
} from './title-detail.service';
import { TMDB_DETAIL_CONFIG } from './tokens';

// --- AngularFire mock (echo path on doc()/collection(); per-test emitters) ---
interface Ref {
  path: string;
}
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const collectionMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const docDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const collectionDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const getDocMock = vi.fn<(ref: Ref) => Promise<unknown>>();
const getDocsMock = vi.fn<(q: unknown) => Promise<unknown>>();
const setDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
const deleteDocMock = vi.fn<(ref: Ref) => Promise<void>>();
// query() echoes the collection ref through; where() returns a marker the fake
// query carries so the season filter can be asserted/applied in-test.
const queryMock = vi.fn((ref: Ref, ...constraints: unknown[]) => ({
  ref,
  constraints,
}));
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({
  field,
  op,
  value,
}));
const batchUpdateMock = vi.fn();
const batchCommitMock = vi.fn(() => Promise.resolve());
const writeBatchMock = vi.fn(() => ({
  update: batchUpdateMock,
  commit: batchCommitMock,
}));

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  collection: (fs: unknown, path: string): Ref => collectionMock(fs, path),
  docData: (ref: Ref): Observable<unknown> => docDataMock(ref),
  collectionData: (ref: Ref): Observable<unknown> => collectionDataMock(ref),
  getDoc: (ref: Ref): Promise<unknown> => getDocMock(ref),
  getDocs: (q: unknown): Promise<unknown> => getDocsMock(q),
  query: (ref: Ref, ...c: unknown[]): unknown => queryMock(ref, ...c),
  where: (field: string, op: string, value: unknown): unknown =>
    whereMock(field, op, value),
  writeBatch: (): unknown => writeBatchMock(),
  setDoc: (ref: Ref, payload: unknown): Promise<void> =>
    setDocMock(ref, payload),
  updateDoc: (ref: Ref, payload: unknown): Promise<void> =>
    updateDocMock(ref, payload),
  deleteDoc: (ref: Ref): Promise<void> => deleteDocMock(ref),
}));

// --- Slice-local TMDB client mock ---
const getDetailMock = vi.fn<() => Promise<TitleDetail>>();
const getProvidersMock = vi.fn();
// Mirror the real TmdbDetailError shape (carries an HTTP `status`) so the
// service's 404-vs-transient discrimination can be exercised. Defined inline in
// the (hoisted) factory to avoid any temporal-dead-zone on the class reference.
vi.mock('./tmdb-detail.client', () => ({
  TmdbDetailError: class TmdbDetailError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = 'TmdbDetailError';
    }
  },
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

// --- Episode fixtures (read-data shape: airDate/watchedAt are Timestamp-like) ---
interface EpFixture {
  id: string;
  season: number;
  episode: number;
  title: string | null;
  watched: boolean;
}
function epReadData(e: EpFixture) {
  return {
    season: e.season,
    episode: e.episode,
    title: e.title,
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
/** A watchlist-item read doc carrying a given status. */
function watchlistSnap(status: string | undefined) {
  if (status === undefined) {
    return snap(undefined);
  }
  return snap({
    type: 'tv',
    tmdbId: 2,
    traktId: null,
    title: 'Breaking Bad',
    addedAt: fakeTs(new Date('2026-06-24T10:00:00Z')),
    status,
  });
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

/** Like `lastState`, but threads the spec-0043 media-type hint. */
function lastState2(
  service: TitleDetailService,
  id: number,
  typeHint: 'movie' | 'tv',
): Promise<DetailViewState> {
  return new Promise((resolve) => {
    let latest: DetailViewState = { kind: 'loading' };
    service.detail$(id, typeHint).subscribe({
      next: (s) => (latest = s),
      complete: () => resolve(latest),
    });
  });
}

describe('TitleDetailService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    docMock.mockClear();
    collectionMock.mockClear();
    docDataMock.mockReset();
    collectionDataMock.mockReset();
    getDocMock.mockReset();
    getDocsMock.mockReset();
    setDocMock.mockReset().mockResolvedValue(undefined);
    updateDocMock.mockReset().mockResolvedValue(undefined);
    deleteDocMock.mockReset().mockResolvedValue(undefined);
    queryMock.mockClear();
    whereMock.mockClear();
    batchUpdateMock.mockReset();
    batchCommitMock.mockReset().mockResolvedValue(undefined);
    writeBatchMock.mockClear();
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

  it('cache miss + live TMDB 404 → not-found (genuine missing title)', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockRejectedValue(new TmdbDetailError('not found', 404));
    const service = createService(UID);
    const state = await lastState(service, 999);
    expect(state.kind).toBe('not-found');
  });

  it('cache miss + live TMDB non-404 error (5xx) → error, NOT not-found', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockRejectedValue(new TmdbDetailError('server error', 503));
    const service = createService(UID);
    const state = await lastState(service, 27205);
    expect(state.kind).toBe('error');
  });

  it('cache miss + live throws a plain network error → error (recoverable), NOT not-found', async () => {
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockRejectedValue(new Error('network down'));
    const service = createService(UID);
    const state = await lastState(service, 27205);
    expect(state.kind).toBe('error');
  });

  it('Firestore getDoc error (offline / unavailable) → error, NOT a silent cache-miss to the live path', async () => {
    getDocMock.mockRejectedValue(
      Object.assign(new Error('Could not reach Cloud Firestore backend'), {
        code: 'unavailable',
      }),
    );
    getDetailMock.mockResolvedValue(liveDetail({ type: 'movie' }));
    const service = createService(UID);
    const state = await lastState(service, 27205);
    expect(state.kind).toBe('error');
    // The cache read failed → surfaced as error; the live path is NOT attempted.
    expect(getDetailMock).not.toHaveBeenCalled();
  });

  // --- spec 0043: media-type hint threading to the live TMDB client ---

  describe('detail$ hint threading', () => {
    it('calls client.getDetail with typeHint=tv on cache miss', async () => {
      getDocMock.mockResolvedValue(snap(undefined));
      getDetailMock.mockResolvedValue(liveDetail({ type: 'tv', tmdbId: 1396 }));
      const service = createService(UID);
      await lastState2(service, 1396, 'tv');
      expect(getDetailMock).toHaveBeenCalledWith(1396, 'tv');
    });

    it('calls client.getDetail with typeHint=movie on cache miss', async () => {
      getDocMock.mockResolvedValue(snap(undefined));
      getDetailMock.mockResolvedValue(liveDetail({ type: 'movie' }));
      const service = createService(UID);
      await lastState2(service, 27205, 'movie');
      expect(getDetailMock).toHaveBeenCalledWith(27205, 'movie');
    });

    it('calls client.getDetail with undefined hint when no hint given', async () => {
      getDocMock.mockResolvedValue(snap(undefined));
      getDetailMock.mockResolvedValue(liveDetail({ type: 'movie' }));
      const service = createService(UID);
      await lastState(service, 27205);
      expect(getDetailMock).toHaveBeenCalledWith(27205, undefined);
    });

    it('does NOT call client.getDetail when cache hit (hint irrelevant)', async () => {
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
      await lastState2(service, 27205, 'movie');
      expect(getDetailMock).not.toHaveBeenCalled();
    });
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

  it('live path: getProviders rejects but getDetail resolves → detail$ stays loaded:live and providers$ degrades to empty (stream does NOT error)', async () => {
    // Cache miss → live detail resolves, but the /watch/providers call rejects.
    getDocMock.mockResolvedValue(snap(undefined));
    getDetailMock.mockResolvedValue(liveDetail({ type: 'movie' }));
    getProvidersMock.mockRejectedValue(new Error('providers 500'));
    const service = createService(UID);

    // detail$ still resolves to loaded:live (independent of providers).
    const state = await lastState(service, 27205);
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.source).toBe('live');
    }

    // providers$ degrades to empty groups and the stream completes without error.
    const result = await new Promise<{
      errored: boolean;
      last: unknown;
    }>((resolve) => {
      let last: unknown;
      service.providers$(27205, 'movie', 'NL', 'live').subscribe({
        next: (g) => (last = g),
        error: () => resolve({ errored: true, last }),
        complete: () => resolve({ errored: false, last }),
      });
    });
    expect(result.errored).toBe(false);
    expect(result.last).toEqual({ flatrate: [], rent: [], buy: [] });
    expect(getProvidersMock).toHaveBeenCalledTimes(1);
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

  // --- spec 0034: episodes$ / setEpisodeWatched / setSeasonWatched / movie ---

  it('episodes$ — movie type → emits [] (no collectionData read)', async () => {
    const service = createService(UID);
    const groups = await new Promise<SeasonGroup[]>((resolve) =>
      service.episodes$(2, 'movie').subscribe(resolve),
    );
    expect(groups).toEqual([]);
    expect(collectionDataMock).not.toHaveBeenCalled();
  });

  it('episodes$ — null uid → emits []', async () => {
    const service = createService(null);
    const groups = await new Promise<SeasonGroup[]>((resolve) =>
      service.episodes$(2, 'tv').subscribe(resolve),
    );
    expect(groups).toEqual([]);
    expect(collectionDataMock).not.toHaveBeenCalled();
  });

  it('episodes$ — tv: groups by season asc, episodes asc, derives counts/allWatched', async () => {
    collectionDataMock.mockReturnValue(
      of([
        { id: 's02e01', ...epReadData2({ season: 2, episode: 1, w: false }) },
        { id: 's01e02', ...epReadData2({ season: 1, episode: 2, w: false }) },
        { id: 's01e01', ...epReadData2({ season: 1, episode: 1, w: true }) },
      ]),
    );
    const service = createService(UID);
    const groups = await new Promise<SeasonGroup[]>((resolve) =>
      service.episodes$(2, 'tv').subscribe(resolve),
    );
    expect(collectionMock).toHaveBeenCalledWith({}, episodesPath(UID, '2'));
    expect(groups.map((g) => g.season)).toEqual([1, 2]);
    expect(groups[0].episodes.map((e) => e.episode)).toEqual([1, 2]);
    expect(groups[0].episodes[0].id).toBe('s01e01');
    expect(groups[0]).toMatchObject({
      total: 2,
      watchedCount: 1,
      allWatched: false,
    });
    expect(groups[1]).toMatchObject({
      total: 1,
      watchedCount: 0,
      allWatched: false,
    });
  });

  it('episodes$ — empty subcollection → []', async () => {
    collectionDataMock.mockReturnValue(of([]));
    const service = createService(UID);
    const groups = await new Promise<SeasonGroup[]>((resolve) =>
      service.episodes$(2, 'tv').subscribe(resolve),
    );
    expect(groups).toEqual([]);
  });

  it('setEpisodeWatched(true) → updateDoc {watched:true, watchedAt:Date} at episodePath', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'Pilot', watched: true },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', true);
    const epCall = updateDocMock.mock.calls.find(
      (c) => c[0].path === episodePath(UID, '2', 's01e01'),
    );
    expect(epCall).toBeDefined();
    const payload = epCall?.[1] as { watched: boolean; watchedAt: unknown };
    expect(payload.watched).toBe(true);
    expect(payload.watchedAt).toBeInstanceOf(Date);
  });

  it('setEpisodeWatched(false) → updateDoc {watched:false, watchedAt:null}', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'Pilot', watched: false },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', false);
    const epCall = updateDocMock.mock.calls.find(
      (c) => c[0].path === episodePath(UID, '2', 's01e01'),
    );
    expect(epCall?.[1]).toEqual({ watched: false, watchedAt: null });
  });

  it('setSeasonWatched(true) → batches an update per episode in that season + commits', async () => {
    getDocsMock
      // first getDocs: setSeasonWatched reads the season's docs
      .mockResolvedValueOnce(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
        ]),
      )
      // second getDocs: autoUpdateStatus reads ALL episodes (now all watched)
      .mockResolvedValueOnce(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
        ]),
      );
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    const service = createService(UID);
    await service.setSeasonWatched(2, 1, true);
    expect(whereMock).toHaveBeenCalledWith('season', '==', 1);
    expect(batchUpdateMock).toHaveBeenCalledTimes(2);
    expect(batchCommitMock).toHaveBeenCalledTimes(1);
    const payload = batchUpdateMock.mock.calls[0][1] as { watched: boolean };
    expect(payload.watched).toBe(true);
  });

  it('auto-status: planned + first episode watched → updateStatus watching', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('planned'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', true);
    const statusCall = updateDocMock.mock.calls.find(
      (c) => c[0].path === watchlistItemPath(UID, '2'),
    );
    expect(statusCall?.[1]).toEqual({ status: 'watching' });
  });

  it('auto-status: all watched (not dropped) → updateStatus completed', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e02', true);
    const statusCall = updateDocMock.mock.calls.find(
      (c) => c[0].path === watchlistItemPath(UID, '2'),
    );
    expect(statusCall?.[1]).toEqual({ status: 'completed' });
  });

  it('auto-status: back to 0 watched after a slice auto-set watching → updateStatus planned', async () => {
    const service = createService(UID);
    // 1) planned + first watch → auto-set watching (remembers it).
    getDocMock.mockResolvedValue(watchlistSnap('planned'));
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
      ]),
    );
    await service.setEpisodeWatched(2, 's01e01', true);

    // 2) un-watch the only watched one → 0 watched, status now 'watching'.
    updateDocMock.mockClear();
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
      ]),
    );
    await service.setEpisodeWatched(2, 's01e01', false);
    const statusCall = updateDocMock.mock.calls.find(
      (c) => c[0].path === watchlistItemPath(UID, '2'),
    );
    expect(statusCall?.[1]).toEqual({ status: 'planned' });
  });

  it('auto-status: dropped → NO status write', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('dropped'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e02', true);
    const statusCall = updateDocMock.mock.calls.find(
      (c) => c[0].path === watchlistItemPath(UID, '2'),
    );
    expect(statusCall).toBeUndefined();
  });

  it('setMovieWatched(true) → updateStatus completed', async () => {
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    const service = createService(UID);
    await service.setMovieWatched(2, true);
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: watchlistItemPath(UID, '2') },
      { status: 'completed' },
    );
  });

  it('setMovieWatched(false) → updateStatus watching', async () => {
    getDocMock.mockResolvedValue(watchlistSnap('completed'));
    const service = createService(UID);
    await service.setMovieWatched(2, false);
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: watchlistItemPath(UID, '2') },
      { status: 'watching' },
    );
  });

  it('setMovieWatched with dropped status → NO status write', async () => {
    getDocMock.mockResolvedValue(watchlistSnap('dropped'));
    const service = createService(UID);
    await service.setMovieWatched(2, true);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('setMovieWatched with null uid → no-op', async () => {
    const service = createService(null);
    await service.setMovieWatched(2, true);
    expect(getDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });
});

/** Episode read-data builder for episodes$ (collectionData) tests. */
function epReadData2(e: { season: number; episode: number; w: boolean }) {
  return {
    season: e.season,
    episode: e.episode,
    title: `S${e.season}E${e.episode}`,
    airDate: fakeTs(new Date('2008-01-20T00:00:00Z')),
    watched: e.w,
    watchedAt: e.w ? fakeTs(new Date('2026-06-24T10:00:00Z')) : null,
  };
}
