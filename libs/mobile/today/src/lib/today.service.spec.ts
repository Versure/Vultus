import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type EpisodeDoc,
  type RegionAvailability,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  episodesPath,
  userPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type { FirestoreTimestampLike } from '@vultus/shared/firestore-schema';
import { type Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TodayService } from './today.service';

// Mock AngularFire's free functions. `doc`/`collection` echo the path so we can
// assert which document each read targets; data emitters are stubbed per-test.
interface Ref {
  path: string;
}

const collectionMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const collectionDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const docDataMock = vi.fn<(ref: Ref) => Observable<unknown>>();
const getDocsMock = vi.fn<(ref: Ref) => Promise<unknown>>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  collection: (fs: unknown, path: string): Ref => collectionMock(fs, path),
  collectionData: (ref: Ref): Observable<unknown> => collectionDataMock(ref),
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  docData: (ref: Ref): Observable<unknown> => docDataMock(ref),
  getDocs: (ref: Ref): Promise<unknown> => getDocsMock(ref),
}));

const UID = 'user-123';
const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });

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

// A getDocs() snapshot: { docs: [{ data() }] } (read-data shape: airDate/
// watchedAt are Timestamp-like).
interface EpFixture {
  season: number;
  episode: number;
  watched: boolean;
}
function docsSnap(eps: EpFixture[]) {
  return {
    docs: eps.map((e) => ({
      data: () => ({
        season: e.season,
        episode: e.episode,
        title: null,
        airDate: fakeTs(new Date('2026-01-02T00:00:00.000Z')),
        watched: e.watched,
        watchedAt: e.watched ? fakeTs(new Date('2026-06-24T10:00:00Z')) : null,
      }),
    })),
  };
}

function createService(uid: string | null): TodayService {
  TestBed.configureTestingModule({
    providers: [
      TodayService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
    ],
  });
  return TestBed.inject(TodayService);
}

describe('TodayService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    collectionMock.mockClear();
    docMock.mockClear();
    collectionDataMock.mockReset();
    docDataMock.mockReset();
    getDocsMock.mockReset();
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
    expect(items[0].nextUnwatchedEpisodeAirDate).toBeNull();
    expect(items[1].type).toBe('tv');
  });

  it('watchlist$ with a null uid → empty stream without touching Firestore', async () => {
    const service = createService(null);
    const items = await new Promise<WatchlistItem[]>((resolve) =>
      service.watchlist$(null).subscribe(resolve),
    );
    expect(items).toEqual([]);
    expect(collectionMock).not.toHaveBeenCalled();
    expect(collectionDataMock).not.toHaveBeenCalled();
  });

  it('userRegion$ maps the user doc to its region', async () => {
    docDataMock.mockReturnValue(
      of({ region: 'DE', notificationPrefs: {}, fcmTokens: [] }),
    );
    const service = createService(UID);
    const region = await new Promise((resolve) =>
      service.userRegion$(UID).subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, userPath(UID));
    expect(region).toBe('DE');
  });

  it('userRegion$ → null with a null uid without touching Firestore', async () => {
    const service = createService(null);
    const region = await new Promise((resolve) =>
      service.userRegion$(null).subscribe(resolve),
    );
    expect(region).toBeNull();
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('myProviderIds$ maps the user doc to its myProviderIds', async () => {
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
      service.myProviderIds$(UID).subscribe(resolve),
    );
    expect(docMock).toHaveBeenCalledWith({}, userPath(UID));
    expect(ids).toEqual([8, 337]);
  });

  it('myProviderIds$ → [] with a null uid without touching Firestore', async () => {
    const service = createService(null);
    const ids = await new Promise((resolve) =>
      service.myProviderIds$(null).subscribe(resolve),
    );
    expect(ids).toEqual([]);
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('myProviderIds$ + userRegion$ share ONE memoized user listener', async () => {
    docDataMock.mockReturnValue(
      of({
        region: 'NL',
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
    const userCalls = docMock.mock.calls.filter(
      ([, path]) => path === userPath(UID),
    );
    expect(userCalls).toHaveLength(1);
    expect(docDataMock).toHaveBeenCalledTimes(1);
  });

  it('availability$ maps the availability doc, null when absent', async () => {
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
    expect(docMock).toHaveBeenCalledWith({}, availabilityDocPath(603, 'NL'));
    expect(present?.providers[0].name).toBe('Netflix');
  });

  it('availability$ → null (no doc read) with a null region', async () => {
    const service = createService(UID);
    const result = await new Promise((resolve) =>
      service.availability$(603, null).subscribe(resolve),
    );
    expect(result).toBeNull();
    expect(docDataMock).not.toHaveBeenCalled();
  });

  it('availability$ memoizes per tmdbId|region (one docData listener)', async () => {
    docDataMock.mockReturnValue(of(undefined));
    const service = createService(UID);
    await new Promise((resolve) =>
      service.availability$(603, 'NL').subscribe(resolve),
    );
    await new Promise((resolve) =>
      service.availability$(603, 'NL').subscribe(resolve),
    );
    const availCalls = docMock.mock.calls.filter(
      ([, path]) => path === availabilityDocPath(603, 'NL'),
    );
    expect(availCalls).toHaveLength(1);
    expect(docDataMock).toHaveBeenCalledTimes(1);
  });

  it('readEpisodes maps a getDocs snapshot to EpisodeDoc[]', async () => {
    getDocsMock.mockResolvedValue(
      docsSnap([
        { season: 1, episode: 1, watched: true },
        { season: 1, episode: 2, watched: false },
      ]),
    );
    const service = createService(UID);
    const episodes: EpisodeDoc[] = await service.readEpisodes(UID, '2');
    expect(collectionMock).toHaveBeenCalledWith({}, episodesPath(UID, '2'));
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].airDate).toBe('2026-01-02T00:00:00.000Z');
    expect(episodes[0].watched).toBe(true);
    expect(episodes[1].watched).toBe(false);
  });

  it('readEpisodes → [] with a null uid without touching Firestore', async () => {
    const service = createService(null);
    const episodes = await service.readEpisodes(null as unknown as string, '2');
    expect(episodes).toEqual([]);
    expect(getDocsMock).not.toHaveBeenCalled();
  });
});
