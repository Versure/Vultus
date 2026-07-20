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
  // ISO date; defaults to a fixed fixture date. Overridden per-episode by the
  // spec-0081 min-airDate tests, which need distinct air dates.
  airDate?: string;
}
function epReadData(e: EpFixture) {
  return {
    season: e.season,
    episode: e.episode,
    title: e.title,
    airDate: fakeTs(new Date(e.airDate ?? '2008-01-20T00:00:00Z')),
    watched: e.watched,
    watchedAt: e.watched ? fakeTs(new Date('2026-06-24T10:00:00Z')) : null,
  };
}
/** The ISO string a given fixture airDate round-trips to via dataToEpisode. */
function iso(airDate: string): string {
  return new Date(airDate).toISOString();
}
/** spec 0081: updateDoc calls carrying the denormalized next-unwatched field. */
function fieldWrites() {
  return updateDocMock.mock.calls.filter(
    (c) => 'nextUnwatchedEpisodeAirDate' in (c[1] as Record<string, unknown>),
  );
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

  it('myProviderIds$ emits the user provider ids, [] for a legacy doc missing the field, [] when absent (spec 0060)', async () => {
    // Populated field.
    docDataMock.mockReturnValue(
      of({
        region: 'NL',
        notificationPrefs: {},
        fcmTokens: [],
        myProviderIds: [8, 337],
      }),
    );
    const service = createService(UID);
    const ids = await new Promise((resolve) =>
      service.myProviderIds$().subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, userPath(UID));
    expect(ids).toEqual([8, 337]);

    // Legacy doc missing myProviderIds → [] via dataToUser (?? []).
    docDataMock.mockReturnValue(
      of({ region: 'NL', notificationPrefs: {}, fcmTokens: [] }),
    );
    TestBed.resetTestingModule();
    const legacy = createService(UID);
    const legacyIds = await new Promise((resolve) =>
      legacy.myProviderIds$().subscribe(resolve),
    );
    expect(legacyIds).toEqual([]);

    // Absent doc → [].
    docDataMock.mockReturnValue(of(undefined));
    TestBed.resetTestingModule();
    const none = createService(UID);
    const noneIds = await new Promise((resolve) =>
      none.myProviderIds$().subscribe(resolve),
    );
    expect(noneIds).toEqual([]);
  });

  it('null-uid guard: myProviderIds$ → [] (spec 0060)', async () => {
    const service = createService(null);
    const ids = await new Promise((resolve) =>
      service.myProviderIds$().subscribe(resolve),
    );
    expect(ids).toEqual([]);
  });

  // --- spec 0061: hasPlex$ / toggleWatchingViaPlex ---

  it('hasPlex$ maps users/{uid}.hasPlex; false for a legacy doc missing it, false when absent (spec 0061)', async () => {
    // Populated true.
    docDataMock.mockReturnValue(
      of({
        region: 'NL',
        notificationPrefs: {},
        fcmTokens: [],
        hasPlex: true,
      }),
    );
    const service = createService(UID);
    const on = await new Promise((resolve) =>
      service.hasPlex$().subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, userPath(UID));
    expect(on).toBe(true);

    // Populated false.
    docDataMock.mockReturnValue(
      of({
        region: 'NL',
        notificationPrefs: {},
        fcmTokens: [],
        hasPlex: false,
      }),
    );
    TestBed.resetTestingModule();
    const svcFalse = createService(UID);
    const off = await new Promise((resolve) =>
      svcFalse.hasPlex$().subscribe(resolve),
    );
    expect(off).toBe(false);

    // Legacy doc missing hasPlex → false via dataToUser (?? false).
    docDataMock.mockReturnValue(
      of({ region: 'NL', notificationPrefs: {}, fcmTokens: [] }),
    );
    TestBed.resetTestingModule();
    const legacy = createService(UID);
    const legacyVal = await new Promise((resolve) =>
      legacy.hasPlex$().subscribe(resolve),
    );
    expect(legacyVal).toBe(false);

    // Absent doc → false.
    docDataMock.mockReturnValue(of(undefined));
    TestBed.resetTestingModule();
    const none = createService(UID);
    const noneVal = await new Promise((resolve) =>
      none.hasPlex$().subscribe(resolve),
    );
    expect(noneVal).toBe(false);
  });

  it('null-uid guard: hasPlex$ → false (spec 0061)', async () => {
    const service = createService(null);
    const val = await new Promise((resolve) =>
      service.hasPlex$().subscribe(resolve),
    );
    expect(val).toBe(false);
    // No doc read attempted on a null uid.
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('toggleWatchingViaPlex writes the scalar { watchingViaPlex } to the watchlist item path (spec 0061)', async () => {
    const service = createService(UID);
    await service.toggleWatchingViaPlex(27205, true);
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: watchlistItemPath(UID, '27205') });
    expect(payload).toEqual({ watchingViaPlex: true });

    updateDocMock.mockClear();
    await service.toggleWatchingViaPlex(27205, false);
    expect(updateDocMock.mock.calls[0][1]).toEqual({ watchingViaPlex: false });
  });

  it('toggleWatchingViaPlex with null uid → no-op (no write) (spec 0061)', async () => {
    const service = createService(null);
    await service.toggleWatchingViaPlex(27205, true);
    expect(updateDocMock).not.toHaveBeenCalled();
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

  // --- spec 0056: add(detail, status?) — one-step "Mark as Watched" ---

  describe('add(detail, status?) — spec 0056', () => {
    it('add(detail) with NO status arg still writes status: planned (default preserved)', async () => {
      const service = createService(UID);
      await service.add(liveDetail({ type: 'movie', tmdbId: 27205 }));
      expect(setDocMock).toHaveBeenCalledTimes(1);
      const [ref, payload] = setDocMock.mock.calls[0];
      expect(ref).toEqual({ path: watchlistItemPath(UID, '27205') });
      expect((payload as Record<string, unknown>)['status']).toBe('planned');
      // Default add never reads or writes episodes.
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
    });

    it('add(movieDetail, "completed") writes status: completed with NO episode read/write', async () => {
      const service = createService(UID);
      await service.add(
        liveDetail({
          type: 'movie',
          tmdbId: 27205,
          posterPath: '/p.jpg',
          voteAverage: 8.8,
        }),
        'completed',
      );
      expect(setDocMock).toHaveBeenCalledTimes(1);
      const [ref, payload] = setDocMock.mock.calls[0];
      expect(ref).toEqual({ path: watchlistItemPath(UID, '27205') });
      const p = payload as Record<string, unknown>;
      expect(p['status']).toBe('completed');
      expect(p['type']).toBe('movie');
      expect(p['posterPath']).toBe('/p.jpg');
      expect(p['voteAverage']).toBe(8.8);
      // Movie → no episode read/write at all.
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
    });

    it('add(tvDetail, "completed") with existing episode docs flips ALL of them to watched:true via a batch (all seasons, no season filter)', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
          { id: 's02e01', season: 2, episode: 1, title: 'c', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.add(liveDetail({ type: 'tv', tmdbId: 1396 }), 'completed');

      // Watchlist doc written as completed.
      const [ref, payload] = setDocMock.mock.calls[0];
      expect(ref).toEqual({ path: watchlistItemPath(UID, '1396') });
      expect((payload as Record<string, unknown>)['status']).toBe('completed');

      // Whole subcollection read, NO where() season filter.
      expect(collectionMock).toHaveBeenCalledWith(
        {},
        episodesPath(UID, '1396'),
      );
      expect(whereMock).not.toHaveBeenCalled();

      // EVERY existing episode doc (across all seasons) batched to watched:true.
      expect(batchUpdateMock).toHaveBeenCalledTimes(3);
      const batchedPaths = batchUpdateMock.mock.calls.map(
        (c) => (c[0] as { path: string }).path,
      );
      expect(batchedPaths).toEqual(['ep/s01e01', 'ep/s01e02', 'ep/s02e01']);
      for (const call of batchUpdateMock.mock.calls) {
        const p = call[1] as { watched: boolean; watchedAt: unknown };
        expect(p.watched).toBe(true);
        expect(p.watchedAt).toBeInstanceOf(Date);
      }
      expect(batchCommitMock).toHaveBeenCalledTimes(1);
    });

    it('add(tvDetail, "completed") with an EMPTY episodes collection writes only the watchlist doc, no episode write, never title-cache', async () => {
      getDocsMock.mockResolvedValue(docsSnap([]));
      const service = createService(UID);
      await service.add(liveDetail({ type: 'tv', tmdbId: 1396 }), 'completed');

      // Only the watchlist doc is setDoc'd (never an episode path, never cache).
      expect(setDocMock).toHaveBeenCalledTimes(1);
      expect(setDocMock.mock.calls[0][0]).toEqual({
        path: watchlistItemPath(UID, '1396'),
      });
      // Empty subcollection → no batch write/commit (no-op).
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      // Never touches title-cache.
      const writtenPaths = setDocMock.mock.calls.map(([r]) => r.path);
      for (const path of writtenPaths) {
        expect(path).not.toContain('title-cache');
        expect(path).not.toContain('episodes');
      }
    });

    it('add(tvDetail, "completed") never setDocs an episode doc (updates existing only)', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.add(liveDetail({ type: 'tv', tmdbId: 1396 }), 'completed');
      // Exactly one setDoc — the watchlist doc — never an episode path.
      expect(setDocMock).toHaveBeenCalledTimes(1);
      expect(setDocMock.mock.calls[0][0].path).toBe(
        watchlistItemPath(UID, '1396'),
      );
    });

    it('add(tvDetail, "completed") with null uid → no-op (no write, no episode read)', async () => {
      const service = createService(null);
      await service.add(liveDetail({ type: 'tv', tmdbId: 1396 }), 'completed');
      expect(setDocMock).not.toHaveBeenCalled();
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
    });
  });

  it('updateStatus / removeTitle target the watchlist item path', async () => {
    const service = createService(UID);
    // Movie completed → bare status write (no episode read/batch).
    await service.updateStatus(27205, 'completed', 'movie');
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
    await service.updateStatus(1, 'completed', 'movie');
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
    await service.updateStatus(2, 'dropped', 'tv');
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
      )
      // third getDocs: autoUpdateStatus advances watching→completed, which now
      // (spec 0053) calls markAllEpisodesWatched — it re-reads ALL episodes
      // (still all watched) and finds nothing to batch (recursion-safe no-op).
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
    // Only the season batch commits; the completed-path helper adds no ops.
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
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
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
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
    );
    // spec 0081: the advance-to-completed write also clears the field.
    expect(statusCall?.[1]).toEqual({
      status: 'completed',
      nextUnwatchedEpisodeAirDate: null,
    });
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
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
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
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
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

  it('auto-status: planned + last episode watched in one action → converges to completed (decision-3: via watching first)', async () => {
    // All episodes end up watched, but status starts as 'planned'.
    // Decision-3: planned→watching fires first, then watching+all→completed. Final: completed.
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('planned'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', true);
    const statusCalls = updateDocMock.mock.calls.filter(
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
    );
    // Both writes happen in a single autoUpdateStatus pass: watching, then completed.
    expect(statusCalls.length).toBe(2);
    expect(statusCalls[0][1]).toEqual({ status: 'watching' });
    // spec 0081: the completed write also clears the denormalized field.
    expect(statusCalls[1][1]).toEqual({
      status: 'completed',
      nextUnwatchedEpisodeAirDate: null,
    });
  });

  it('auto-status: planned + only one of multiple episodes marked → watching (NOT completed)', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('planned'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', true);
    const statusCalls = updateDocMock.mock.calls.filter(
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
    );
    // Only watching, not completed.
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0][1]).toEqual({ status: 'watching' });
  });

  it('auto-status: completed already + episode re-marked → NO redundant completed write', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
      ]),
    );
    getDocMock.mockResolvedValue(watchlistSnap('completed'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', true);
    const statusCalls = updateDocMock.mock.calls.filter(
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
    );
    expect(statusCalls.length).toBe(0);
  });

  it('auto-status: empty subcollection → NO completed write (total=0 guard)', async () => {
    getDocsMock.mockResolvedValue(docsSnap([]));
    getDocMock.mockResolvedValue(watchlistSnap('watching'));
    const service = createService(UID);
    await service.setEpisodeWatched(2, 's01e01', true);
    const statusCalls = updateDocMock.mock.calls.filter(
      (c) =>
        c[0].path === watchlistItemPath(UID, '2') &&
        'status' in (c[1] as Record<string, unknown>),
    );
    expect(statusCalls.length).toBe(0);
  });

  // --- spec 0053: completing a TV show marks all unwatched episodes watched ---

  describe('updateStatus completed → markAllEpisodesWatched (spec 0053)', () => {
    it('TV + completed + some unwatched → status written AND batch commits {watched:true, watchedAt} for ONLY the unwatched docs', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
          { id: 's01e03', season: 1, episode: 3, title: 'c', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.updateStatus(2, 'completed', 'tv');

      // Whole subcollection read, no where() filter.
      expect(collectionMock).toHaveBeenCalledWith({}, episodesPath(UID, '2'));
      expect(whereMock).not.toHaveBeenCalled();

      // Only the two unwatched docs are batched (s01e01 already watched → excluded).
      expect(batchUpdateMock).toHaveBeenCalledTimes(2);
      const batchedPaths = batchUpdateMock.mock.calls.map(
        (c) => (c[0] as { path: string }).path,
      );
      expect(batchedPaths).toEqual(['ep/s01e02', 'ep/s01e03']);
      for (const call of batchUpdateMock.mock.calls) {
        const payload = call[1] as { watched: boolean; watchedAt: unknown };
        expect(payload.watched).toBe(true);
        expect(payload.watchedAt).toBeInstanceOf(Date);
      }
      expect(batchCommitMock).toHaveBeenCalledTimes(1);

      // Status write still happens (spec 0081: TV-completed also clears the field).
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { status: 'completed', nextUnwatchedEpisodeAirDate: null },
      );
    });

    it('TV + completed + all episodes already watched → status written, NO batch commit', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
        ]),
      );
      const service = createService(UID);
      await service.updateStatus(2, 'completed', 'tv');
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { status: 'completed', nextUnwatchedEpisodeAirDate: null },
      );
    });

    it('TV + completed + empty subcollection → status written, NO batch commit', async () => {
      getDocsMock.mockResolvedValue(docsSnap([]));
      const service = createService(UID);
      await service.updateStatus(2, 'completed', 'tv');
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { status: 'completed', nextUnwatchedEpisodeAirDate: null },
      );
    });

    it('movie + completed → status written, NO episode read/batch at all', async () => {
      const service = createService(UID);
      await service.updateStatus(27205, 'completed', 'movie');
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '27205') },
        { status: 'completed' },
      );
    });

    it('null uid → no-op: no status write, no episode read', async () => {
      const service = createService(null);
      await service.updateStatus(2, 'completed', 'tv');
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it.each(['watching', 'planned', 'dropped'] as const)(
      'TV + non-completed status (%s) → status written, NO episode read/batch (forward-direction only)',
      async (status) => {
        const service = createService(UID);
        await service.updateStatus(2, status, 'tv');
        expect(getDocsMock).not.toHaveBeenCalled();
        expect(batchUpdateMock).not.toHaveBeenCalled();
        expect(batchCommitMock).not.toHaveBeenCalled();
        expect(updateDocMock).toHaveBeenCalledWith(
          { path: watchlistItemPath(UID, '2') },
          { status },
        );
      },
    );

    it('regression: setMovieWatched writes completed for a watched movie WITHOUT touching episodes', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      const service = createService(UID);
      await service.setMovieWatched(2, true);
      // currentStatus getDoc is expected; but NO episodes getDocs / batch.
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { status: 'completed' },
      );
    });

    it('recursion-safety: autoUpdateStatus advancing an already-fully-watched TV show to completed hits markAllEpisodesWatched but finds zero unwatched → writeBatch/commit invoked ZERO times', async () => {
      // Marking the last episode watched: autoUpdateStatus reads all-watched
      // episodes, writes 'completed' via updateStatus, which calls the helper —
      // which re-reads the same all-watched docs and finds nothing to batch.
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e02', true);

      // Status advanced to completed exactly once.
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      expect(statusCalls.length).toBe(1);
      // spec 0081: the completed write also clears the denormalized field.
      expect(statusCalls[0][1]).toEqual({
        status: 'completed',
        nextUnwatchedEpisodeAirDate: null,
      });

      // The completed path's helper found zero unwatched → no batch write/commit.
      // (Proof there is no double-batch-write and no recursion/loop.) The helper
      // may allocate a writeBatch() but never adds an op or commits it.
      expect(batchUpdateMock).not.toHaveBeenCalled();
      expect(batchCommitMock).not.toHaveBeenCalled();
    });
  });

  // --- spec 0074: completed → watching revert on uncheck (D2/D3) ---

  describe('autoUpdateStatus completed → watching revert (spec 0074)', () => {
    it('completed + uncheck one of several watched episodes (watchedCount < total, total > 0) → updateDoc { status: watching }', async () => {
      // 3 episodes, one now unwatched (the uncheck target) → not all-watched.
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
          { id: 's01e03', season: 1, episode: 3, title: 'c', watched: true },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e02', false);
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0][1]).toEqual({ status: 'watching' });
    });

    it('completed + uncheck ALL episodes (watchedCount === 0, total > 0) → { status: watching } NOT planned', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e01', false);
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0][1]).toEqual({ status: 'watching' });
      // Must NOT be planned (the new branch precedes Step 3).
      expect(statusCalls[0][1]).not.toEqual({ status: 'planned' });
    });

    it('completed + uncheck ALL episodes with autoSetWatching memory TRUE (auto-advanced lineage) → watching, NOT planned (new branch precedes Step 3)', async () => {
      const service = createService(UID);
      // 1) planned + first watch → the slice auto-sets watching (memory := true).
      getDocMock.mockResolvedValue(watchlistSnap('planned'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        ]),
      );
      await service.setEpisodeWatched(2, 's01e01', true);
      // The single episode being watched also advances watching→completed in that
      // same pass; the autoSetWatching memory for tmdbId 2 remains true.

      // 2) Now the show is 'completed' (auto-advanced lineage) and the user
      // unchecks the only episode → watchedCount === 0, total > 0.
      updateDocMock.mockClear();
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      await service.setEpisodeWatched(2, 's01e01', false);
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      // The new completed→watching branch fires FIRST and short-circuits the
      // Step 3 zero-watched → planned branch, even with memory still true.
      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0][1]).toEqual({ status: 'watching' });
    });

    it('completed + empty subcollection (total === 0) → NO status write (total > 0 guard)', async () => {
      getDocsMock.mockResolvedValue(docsSnap([]));
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e01', false);
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      expect(statusCalls.length).toBe(0);
    });

    it('completed + uncheck a season (setSeasonWatched false) leaving some unwatched → { status: watching }', async () => {
      getDocsMock
        // first getDocs: setSeasonWatched reads season 1's docs
        .mockResolvedValueOnce(
          docsSnap([
            { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
            { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
          ]),
        )
        // second getDocs: autoUpdateStatus reads ALL episodes (season 1 now
        // unwatched, season 2 still watched) → not all-watched.
        .mockResolvedValueOnce(
          docsSnap([
            { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
            { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
            { id: 's02e01', season: 2, episode: 1, title: 'c', watched: true },
          ]),
        );
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setSeasonWatched(2, 1, false);
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0][1]).toEqual({ status: 'watching' });
    });

    it('completed + still all-watched (re-mark watched) → NO revert (branch needs watchedCount < total)', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e01', true);
      const statusCalls = updateDocMock.mock.calls.filter(
        (c) =>
          c[0].path === watchlistItemPath(UID, '2') &&
          'status' in (c[1] as Record<string, unknown>),
      );
      // Already completed + still all-watched → no status write (existing 0050 case).
      expect(statusCalls.length).toBe(0);
    });
  });

  describe('revertIfNewEpisodes', () => {
    it('completed TV + ≥1 unwatched episode → writes watching', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'tv');
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { status: 'watching' },
      );
    });

    it('completed TV + all episodes watched → NO write', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
        ]),
      );
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'tv');
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('watching status → NO write (only reverts from completed)', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'tv');
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('planned status → NO write', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('planned'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'tv');
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('movie type → no-op (no getDocs, no updateDoc)', async () => {
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'movie');
      expect(getDocMock).not.toHaveBeenCalled();
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('null uid → no-op', async () => {
      const service = createService(null);
      await service.revertIfNewEpisodes(2, 'tv');
      expect(getDocMock).not.toHaveBeenCalled();
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('completed TV + empty subcollection → NO write', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      getDocsMock.mockResolvedValue(docsSnap([]));
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'tv');
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('no write targets anything but the watchlist doc (never episodes, never title-cache)', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.revertIfNewEpisodes(2, 'tv');
      for (const [ref] of updateDocMock.mock.calls) {
        expect(ref.path).toMatch(
          new RegExp(`^${userPath(UID)}/watchlist/\\d+$`),
        );
        expect(ref.path).not.toContain('episodes');
        expect(ref.path).not.toContain('title-cache');
      }
    });
  });

  // --- spec 0081: denormalized nextUnwatchedEpisodeAirDate recompute ---

  describe('nextUnwatchedEpisodeAirDate recompute (spec 0081)', () => {
    it('marking the LAST unwatched episode watched → a watchlist write clears the field to null', async () => {
      // Post-uncheck-mark snapshot autoUpdateStatus reads: every episode watched.
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e02', true);

      // The recompute writes null (nothing unwatched) to the watchlist doc.
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { nextUnwatchedEpisodeAirDate: null },
      );
      // Every field write in this pass is null (advance-to-completed also null).
      for (const c of fieldWrites()) {
        expect(
          (c[1] as Record<string, unknown>)['nextUnwatchedEpisodeAirDate'],
        ).toBeNull();
      }
    });

    it('unchecking a watched episode on an otherwise fully-watched show → field becomes that episode air date', async () => {
      // After the uncheck, only s01e02 (airDate 2021-05-05) is unwatched.
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
          {
            id: 's01e02',
            season: 1,
            episode: 2,
            title: 'b',
            watched: false,
            airDate: '2021-05-05T00:00:00Z',
          },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e02', false);

      // The single now-unwatched episode's air date is the min → written.
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { nextUnwatchedEpisodeAirDate: iso('2021-05-05T00:00:00Z') },
      );
    });

    it('marking one of several unwatched episodes → field is the MIN air date of the REMAINING unwatched (not the one just marked)', async () => {
      // s01e02 (2019 — the earliest) is the one just marked watched; the
      // remaining unwatched are s01e01 (2020) and s01e03 (2021) → min is 2020.
      getDocsMock.mockResolvedValue(
        docsSnap([
          {
            id: 's01e01',
            season: 1,
            episode: 1,
            title: 'a',
            watched: false,
            airDate: '2020-01-01T00:00:00Z',
          },
          {
            id: 's01e02',
            season: 1,
            episode: 2,
            title: 'b',
            watched: true,
            airDate: '2019-01-01T00:00:00Z',
          },
          {
            id: 's01e03',
            season: 1,
            episode: 3,
            title: 'c',
            watched: false,
            airDate: '2021-01-01T00:00:00Z',
          },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e02', true);

      const fw = fieldWrites();
      expect(fw.length).toBe(1);
      const value = (fw[0][1] as Record<string, unknown>)[
        'nextUnwatchedEpisodeAirDate'
      ];
      expect(value).toBe(iso('2020-01-01T00:00:00Z'));
      // NOT the earliest overall (that episode is now watched).
      expect(value).not.toBe(iso('2019-01-01T00:00:00Z'));
    });

    it('setSeasonWatched(true) drives the recompute → clears the field to null when everything is watched', async () => {
      getDocsMock
        // 1) setSeasonWatched reads the season's docs for the batch
        .mockResolvedValueOnce(
          docsSnap([
            { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
            { id: 's01e02', season: 1, episode: 2, title: 'b', watched: false },
          ]),
        )
        // 2) autoUpdateStatus reads ALL episodes (now all watched)
        .mockResolvedValueOnce(
          docsSnap([
            { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
            { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
          ]),
        )
        // 3) the completed-path helper re-reads (all watched, nothing to batch)
        .mockResolvedValueOnce(
          docsSnap([
            { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
            { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
          ]),
        );
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      const service = createService(UID);
      await service.setSeasonWatched(2, 1, true);
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { nextUnwatchedEpisodeAirDate: null },
      );
    });

    it('setSeasonWatched(false) drives the recompute → field becomes the min unwatched air date', async () => {
      getDocsMock
        // 1) setSeasonWatched reads season 1's docs for the batch
        .mockResolvedValueOnce(
          docsSnap([
            { id: 's01e01', season: 1, episode: 1, title: 'a', watched: true },
            { id: 's01e02', season: 1, episode: 2, title: 'b', watched: true },
          ]),
        )
        // 2) autoUpdateStatus reads ALL episodes (season 1 now unwatched,
        //    season 2 still watched) → min unwatched is s01e01 (2020).
        .mockResolvedValueOnce(
          docsSnap([
            {
              id: 's01e01',
              season: 1,
              episode: 1,
              title: 'a',
              watched: false,
              airDate: '2020-01-01T00:00:00Z',
            },
            {
              id: 's01e02',
              season: 1,
              episode: 2,
              title: 'b',
              watched: false,
              airDate: '2020-02-02T00:00:00Z',
            },
            {
              id: 's02e01',
              season: 2,
              episode: 1,
              title: 'c',
              watched: true,
              airDate: '2021-01-01T00:00:00Z',
            },
          ]),
        );
      getDocMock.mockResolvedValue(watchlistSnap('completed'));
      const service = createService(UID);
      await service.setSeasonWatched(2, 1, false);
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { nextUnwatchedEpisodeAirDate: iso('2020-01-01T00:00:00Z') },
      );
    });

    it('updateStatus(tmdbId, "completed", "tv") direct → status write also clears the field to null', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      const service = createService(UID);
      await service.updateStatus(2, 'completed', 'tv');
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '2') },
        { status: 'completed', nextUnwatchedEpisodeAirDate: null },
      );
    });

    it('dropped show → NO recompute write (accepted client-side gap)', async () => {
      getDocsMock.mockResolvedValue(
        docsSnap([
          { id: 's01e01', season: 1, episode: 1, title: 'a', watched: false },
        ]),
      );
      getDocMock.mockResolvedValue(watchlistSnap('dropped'));
      const service = createService(UID);
      await service.setEpisodeWatched(2, 's01e01', true);
      // Early-returns before the recompute; no field write.
      expect(fieldWrites()).toHaveLength(0);
    });

    it('movie setMovieWatched → NO episode read, NO field write (stays null for movies)', async () => {
      getDocMock.mockResolvedValue(watchlistSnap('watching'));
      const service = createService(UID);
      await service.setMovieWatched(2, true);
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(fieldWrites()).toHaveLength(0);
    });

    it('movie updateStatus(..., "movie") → NO episode read, NO field write', async () => {
      const service = createService(UID);
      await service.updateStatus(27205, 'completed', 'movie');
      expect(getDocsMock).not.toHaveBeenCalled();
      expect(fieldWrites()).toHaveLength(0);
      // Movie status write is bare status (no field key).
      expect(updateDocMock).toHaveBeenCalledWith(
        { path: watchlistItemPath(UID, '27205') },
        { status: 'completed' },
      );
    });
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
