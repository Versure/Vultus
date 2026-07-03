import { describe, expect, it } from 'vitest';

import type {
  CatalogProvider,
  EpisodeDoc,
  NotificationDoc,
  ProviderCatalogDoc,
  RegionAvailability,
  SyncRun,
  TitleCacheEntry,
  User,
  WatchlistItem,
} from '@vultus/shared/domain';

import type { FirestoreTimestampLike } from './data-types';
import {
  availabilityToData,
  dataToAvailability,
  dataToEpisode,
  dataToNotification,
  dataToProviderCatalog,
  dataToSyncRun,
  dataToTitleCache,
  dataToUser,
  dataToWatchlistItem,
  episodeToData,
  notificationToData,
  providerCatalogToData,
  syncRunToData,
  titleCacheToData,
  userToData,
  watchlistItemToData,
} from './converters';
import {
  availabilityDocPath,
  availabilityPath,
  episodePath,
  episodesPath,
  notificationPath,
  notificationsPath,
  providerCatalogDocPath,
  providerCatalogPath,
  syncRunDocPath,
  syncRunsCollection,
  titleCacheDocPath,
  titleCachePath,
  userPath,
  watchlistItemPath,
  watchlistPath,
} from './paths';

// Fake Timestamp for the read side — structurally satisfies FirestoreTimestampLike.
// No SDK is needed: this is exactly the shape both Firebase SDKs' Timestamp expose.
const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });

// Models what Firestore does to a write payload: each JS `Date` becomes a stored
// value that, on read back, exposes toDate(). Walks the write-data object (incl.
// nested fcmTokens[].createdAt), replacing each Date with fakeTs(date).
function simulateStored(value: unknown): unknown {
  if (value instanceof Date) {
    return fakeTs(value);
  }
  if (Array.isArray(value)) {
    return value.map(simulateStored);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, simulateStored(v)]),
    );
  }
  return value;
}

describe('converters — round-trip identity', () => {
  it('User: multi-element fcmTokens + notificationPrefs pass-through', () => {
    const user: User = {
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: false,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [
        {
          token: 'tok-1',
          deviceId: 'dev-1',
          createdAt: '2026-01-02T03:04:05.000Z',
        },
        {
          token: 'tok-2',
          deviceId: 'dev-2',
          createdAt: '2026-06-18T12:00:00.000Z',
        },
      ],
      myProviderIds: [8, 337],
      hasPlex: false,
      plexSync: null,
    };
    expect(dataToUser(simulateStored(userToData(user)) as never)).toEqual(user);
  });

  it('User: deliveryHour set (8) round-trips correctly', () => {
    const user: User = {
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: false,
        deliveryHour: 8,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: false,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.notificationPrefs.deliveryHour).toBe(8);
  });

  it('User: deliveryHour null round-trips as null', () => {
    const user: User = {
      region: 'DE',
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: false,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [],
      hasPlex: false,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.notificationPrefs.deliveryHour).toBeNull();
  });

  it('User: backward-compat — legacy notificationPrefs missing deliveryHour maps to null', () => {
    // Simulates a doc written before spec 0051 (no deliveryHour in stored prefs).
    const user: User = {
      region: 'GB',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: false,
        cameToPlatform: true,
        deliveryHour: 14,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: false,
    };
    const stored = simulateStored(userToData(user)) as Record<string, unknown>;
    // Delete deliveryHour to simulate a pre-0051 stored doc.
    delete (stored['notificationPrefs'] as Record<string, unknown>)[
      'deliveryHour'
    ];
    const result = dataToUser(stored as never);
    expect(result.notificationPrefs.deliveryHour).toBeNull();
  });

  it('User: myProviderIds populated round-trips', () => {
    const user: User = {
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [8, 337, 119],
      hasPlex: false,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.myProviderIds).toEqual([8, 337, 119]);
  });

  it('User: myProviderIds empty array round-trips', () => {
    const user: User = {
      region: 'DE',
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: false,
        cameToPlatform: false,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [],
      hasPlex: false,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.myProviderIds).toEqual([]);
  });

  it('User: backward-compat — legacy doc missing myProviderIds maps to []', () => {
    // Simulates a doc written before spec 0060 (no myProviderIds field stored).
    const user: User = {
      region: 'GB',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: false,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: false,
    };
    const stored = simulateStored(userToData(user)) as Record<string, unknown>;
    // Delete myProviderIds to simulate a pre-0060 stored doc.
    delete stored['myProviderIds'];
    const result = dataToUser(stored as never);
    expect(result.myProviderIds).toEqual([]);
  });

  it('User: hasPlex true round-trips', () => {
    const user: User = {
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: true,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.hasPlex).toBe(true);
  });

  it('User: hasPlex false round-trips', () => {
    const user: User = {
      region: 'DE',
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: false,
        cameToPlatform: false,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [],
      hasPlex: false,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.hasPlex).toBe(false);
  });

  it('User: backward-compat — legacy doc missing hasPlex maps to false', () => {
    // Simulates a doc written before spec 0061 (no hasPlex field stored).
    const user: User = {
      region: 'GB',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: false,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: true,
    };
    const stored = simulateStored(userToData(user)) as Record<string, unknown>;
    // Delete hasPlex to simulate a pre-0061 stored doc.
    delete stored['hasPlex'];
    const result = dataToUser(stored as never);
    expect(result.hasPlex).toBe(false);
  });

  it('User: plexSync populated (linkedAt/lastSyncAt/serverName) round-trips', () => {
    const user: User = {
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: true,
      plexSync: {
        linkedAt: '2026-07-03T10:00:00.000Z',
        lastSyncAt: '2026-07-03T11:30:00.000Z',
        serverName: 'Home PMS',
      },
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    // plexSync is a plain nested object of ISO strings — no Timestamp coercion.
    expect(result.plexSync).toEqual({
      linkedAt: '2026-07-03T10:00:00.000Z',
      lastSyncAt: '2026-07-03T11:30:00.000Z',
      serverName: 'Home PMS',
    });
  });

  it('User: plexSync null round-trips as null', () => {
    const user: User = {
      region: 'DE',
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: false,
        cameToPlatform: false,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [],
      hasPlex: false,
      plexSync: null,
    };
    const result = dataToUser(simulateStored(userToData(user)) as never);
    expect(result).toEqual(user);
    expect(result.plexSync).toBeNull();
  });

  it('User: backward-compat — legacy doc missing plexSync maps to null', () => {
    // Simulates a doc written before spec 0073 (no plexSync field stored).
    const user: User = {
      region: 'GB',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: false,
        cameToPlatform: true,
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: true,
      plexSync: {
        linkedAt: '2026-07-03T10:00:00.000Z',
        lastSyncAt: null,
        serverName: 'Home PMS',
      },
    };
    const stored = simulateStored(userToData(user)) as Record<string, unknown>;
    // Delete plexSync to simulate a pre-0073 stored doc.
    delete stored['plexSync'];
    const result = dataToUser(stored as never);
    expect(result.plexSync).toBeNull();
  });

  it('WatchlistItem: addedAt round-trips; traktId null survives', () => {
    const item: WatchlistItem = {
      type: 'tv',
      tmdbId: 1399,
      traktId: null,
      title: 'Game of Thrones',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'watching',
      watchingViaPlex: false,
    };
    // posterPath/voteAverage/releaseDate are absent on the source item; the write
    // converter coerces them to null (never undefined), so the round-trip reads
    // them back as null.
    expect(
      dataToWatchlistItem(simulateStored(watchlistItemToData(item)) as never),
    ).toEqual({
      ...item,
      posterPath: null,
      voteAverage: null,
      releaseDate: null,
    });
  });

  it('WatchlistItem: posterPath + voteAverage + releaseDate set round-trip', () => {
    const item: WatchlistItem = {
      type: 'movie',
      tmdbId: 603,
      traktId: 1,
      title: 'The Matrix',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'completed',
      posterPath: '/matrix.jpg',
      voteAverage: 8.2,
      releaseDate: '1999-03-31',
      watchingViaPlex: false,
    };
    expect(
      dataToWatchlistItem(simulateStored(watchlistItemToData(item)) as never),
    ).toEqual(item);
  });

  it('WatchlistItem: posterPath + voteAverage + releaseDate explicit null round-trip', () => {
    const item: WatchlistItem = {
      type: 'tv',
      tmdbId: 1396,
      traktId: null,
      title: 'Breaking Bad',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'planned',
      posterPath: null,
      voteAverage: null,
      releaseDate: null,
      watchingViaPlex: false,
    };
    expect(
      dataToWatchlistItem(simulateStored(watchlistItemToData(item)) as never),
    ).toEqual(item);
  });

  it('WatchlistItem: posterPath/voteAverage/releaseDate absent are written as null (never undefined)', () => {
    const item: WatchlistItem = {
      type: 'movie',
      tmdbId: 27205,
      traktId: 5,
      title: 'Inception',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'watching',
      watchingViaPlex: false,
    };
    const write = watchlistItemToData(item);
    expect(write.posterPath).toBeNull();
    expect(write.voteAverage).toBeNull();
    expect(write.releaseDate).toBeNull();
    // releaseDate key is present and null, never undefined.
    expect('releaseDate' in write).toBe(true);
    expect(write.releaseDate).not.toBeUndefined();
    // Round-trip reads them back as null.
    const read = dataToWatchlistItem(simulateStored(write) as never);
    expect(read.posterPath).toBeNull();
    expect(read.voteAverage).toBeNull();
    expect(read.releaseDate).toBeNull();
  });

  it('WatchlistItem: releaseDate is a plain ISO date string (no Timestamp coercion)', () => {
    const item: WatchlistItem = {
      type: 'movie',
      tmdbId: 1891,
      traktId: 9,
      title: 'The Empire Strikes Back',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'completed',
      releaseDate: '1980-05-21',
      watchingViaPlex: false,
    };
    const write = watchlistItemToData(item);
    // Stored as the raw string, NOT a Date/Timestamp.
    expect(write.releaseDate).toBe('1980-05-21');
    expect(write.releaseDate).not.toBeInstanceOf(Date);
  });

  it('WatchlistItem: watchingViaPlex true round-trips', () => {
    const item: WatchlistItem = {
      type: 'tv',
      tmdbId: 76479,
      traktId: 11,
      title: 'The Boys',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'watching',
      posterPath: null,
      voteAverage: null,
      releaseDate: null,
      watchingViaPlex: true,
    };
    const result = dataToWatchlistItem(
      simulateStored(watchlistItemToData(item)) as never,
    );
    expect(result).toEqual(item);
    expect(result.watchingViaPlex).toBe(true);
  });

  it('WatchlistItem: watchingViaPlex false round-trips', () => {
    const item: WatchlistItem = {
      type: 'movie',
      tmdbId: 603,
      traktId: 1,
      title: 'The Matrix',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'completed',
      posterPath: null,
      voteAverage: null,
      releaseDate: null,
      watchingViaPlex: false,
    };
    const result = dataToWatchlistItem(
      simulateStored(watchlistItemToData(item)) as never,
    );
    expect(result).toEqual(item);
    expect(result.watchingViaPlex).toBe(false);
  });

  it('WatchlistItem: backward-compat — legacy item missing watchingViaPlex maps to false', () => {
    // Simulates a doc written before spec 0061 (no watchingViaPlex field stored).
    const item: WatchlistItem = {
      type: 'tv',
      tmdbId: 1396,
      traktId: null,
      title: 'Breaking Bad',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'planned',
      posterPath: null,
      voteAverage: null,
      releaseDate: null,
      watchingViaPlex: true,
    };
    const stored = simulateStored(watchlistItemToData(item)) as Record<
      string,
      unknown
    >;
    // Delete watchingViaPlex to simulate a pre-0061 stored doc.
    delete stored['watchingViaPlex'];
    const result = dataToWatchlistItem(stored as never);
    expect(result.watchingViaPlex).toBe(false);
  });

  it('EpisodeDoc: watchedAt set (watched true), title present', () => {
    const ep: EpisodeDoc = {
      season: 2,
      episode: 5,
      title: 'Ozymandias',
      airDate: '2026-04-01T20:00:00.000Z',
      watched: true,
      watchedAt: '2026-04-02T21:30:00.000Z',
    };
    expect(dataToEpisode(simulateStored(episodeToData(ep)) as never)).toEqual(
      ep,
    );
  });

  it('EpisodeDoc: watchedAt null (watched false), title null', () => {
    const ep: EpisodeDoc = {
      season: 1,
      episode: 1,
      title: null,
      airDate: '2026-04-01T20:00:00.000Z',
      watched: false,
      watchedAt: null,
    };
    expect(dataToEpisode(simulateStored(episodeToData(ep)) as never)).toEqual(
      ep,
    );
  });

  it('EpisodeDoc: backward-compat — stored doc missing title field reads back as null', () => {
    // Simulates a doc written before spec 0034 (no title field in stored data).
    const ep: EpisodeDoc = {
      season: 3,
      episode: 7,
      title: null,
      airDate: '2026-05-10T20:00:00.000Z',
      watched: false,
      watchedAt: null,
    };
    const stored = simulateStored(episodeToData(ep));
    // Delete the title field to simulate a pre-0034 stored doc.
    delete (stored as Record<string, unknown>)['title'];
    expect(dataToEpisode(stored as never)).toEqual(ep);
  });

  it('NotificationDoc: readAt set; payload incl optional providerName', () => {
    const n: NotificationDoc = {
      titleId: 'title-9',
      kind: 'show-came-to-platform',
      payload: {
        tmdbId: 98765,
        titleId: 'title-9',
        title: 'The Bear',
        region: 'NL',
        providerName: 'Disney+',
      },
      sentAt: '2026-05-01T10:00:00.000Z',
      readAt: '2026-05-01T11:00:00.000Z',
    };
    const result = dataToNotification(
      simulateStored(notificationToData(n)) as never,
    );
    expect(result).toEqual(n);
    expect(result.payload.tmdbId).toBe(98765);
  });

  it('NotificationDoc: readAt null; payload without providerName', () => {
    const n: NotificationDoc = {
      titleId: 'title-3',
      kind: 'episode-aired',
      payload: {
        tmdbId: 11111,
        titleId: 'title-3',
        title: 'Severance',
        region: 'US',
      },
      sentAt: '2026-05-02T10:00:00.000Z',
      readAt: null,
    };
    const result = dataToNotification(
      simulateStored(notificationToData(n)) as never,
    );
    expect(result).toEqual(n);
    expect(result.payload.tmdbId).toBe(11111);
  });

  it('TitleCacheEntry: lastSyncedAt; metadata posterPath/releaseDate null; traktId null', () => {
    const t: TitleCacheEntry = {
      type: 'movie',
      traktId: null,
      metadata: {
        title: 'Dune',
        overview: 'A boy.',
        posterPath: null,
        releaseDate: null,
      },
      lastSyncedAt: '2026-06-01T00:00:00.000Z',
    };
    const result = dataToTitleCache(
      simulateStored(titleCacheToData(t)) as never,
    );
    expect(result).toEqual(t);
    expect(result.traktId).toBeNull();
  });

  it('TitleCacheEntry: traktId number round-trips', () => {
    const t: TitleCacheEntry = {
      type: 'tv',
      traktId: 42,
      metadata: {
        title: 'Severance',
        overview: 'A mysterious job.',
        posterPath: '/poster.jpg',
        releaseDate: '2022-02-18T00:00:00.000Z',
      },
      lastSyncedAt: '2026-06-01T00:00:00.000Z',
    };
    const result = dataToTitleCache(
      simulateStored(titleCacheToData(t)) as never,
    );
    expect(result).toEqual(t);
    expect(result.traktId).toBe(42);
  });

  it('RegionAvailability: providers + previousSnapshot pass through', () => {
    const a: RegionAvailability = {
      providers: [
        { providerId: 8, name: 'Netflix', type: 'flatrate' },
        { providerId: 337, name: 'Disney+', type: 'flatrate' },
      ],
      lastSyncedAt: '2026-06-10T00:00:00.000Z',
      previousSnapshot: [{ providerId: 8, name: 'Netflix', type: 'rent' }],
    };
    expect(
      dataToAvailability(simulateStored(availabilityToData(a)) as never),
    ).toEqual(a);
  });

  it('RegionAvailability: empty previousSnapshot', () => {
    const a: RegionAvailability = {
      providers: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
      lastSyncedAt: '2026-06-10T00:00:00.000Z',
      previousSnapshot: [],
    };
    expect(
      dataToAvailability(simulateStored(availabilityToData(a)) as never),
    ).toEqual(a);
  });

  it('ProviderCatalogDoc: lastSyncedAt ISO↔Timestamp; providers pass through', () => {
    const doc: ProviderCatalogDoc = {
      providers: [
        { providerId: 8, name: 'Netflix', logoPath: '/netflix.jpg' },
        { providerId: 337, name: 'Disney Plus', logoPath: null },
      ],
      lastSyncedAt: '2026-06-25T00:00:00.000Z',
    };
    const result = dataToProviderCatalog(
      simulateStored(providerCatalogToData(doc)) as never,
    );
    expect(result).toEqual(doc);
  });

  it('ProviderCatalogDoc: empty providers array round-trips', () => {
    const doc: ProviderCatalogDoc = {
      providers: [],
      lastSyncedAt: '2026-06-25T00:00:00.000Z',
    };
    const result = dataToProviderCatalog(
      simulateStored(providerCatalogToData(doc)) as never,
    );
    expect(result).toEqual(doc);
    expect(result.providers).toEqual([]);
  });

  it('ProviderCatalogDoc: write emits Date on lastSyncedAt; providers unchanged', () => {
    const providers: CatalogProvider[] = [
      { providerId: 8, name: 'Netflix', logoPath: '/netflix.jpg' },
    ];
    const doc: ProviderCatalogDoc = {
      providers,
      lastSyncedAt: '2026-06-25T00:00:00.000Z',
    };
    const write = providerCatalogToData(doc);
    expect(write.lastSyncedAt).toBeInstanceOf(Date);
    expect(write.providers).toBe(providers);
  });

  it('SyncRun: cron run, userId null, empty errors', () => {
    const run: SyncRun = {
      runId: 'run-1',
      kind: 'cron',
      userId: null,
      startedAt: '2026-06-30T01:00:00.000Z',
      completedAt: '2026-06-30T01:02:30.000Z',
      durationMs: 150000,
      titlesGathered: 12,
      titlesUpdated: 3,
      errorCount: 0,
      errors: [],
    };
    expect(dataToSyncRun(simulateStored(syncRunToData(run)) as never)).toEqual(
      run,
    );
  });

  it('SyncRun: manual run, userId string, populated errors', () => {
    const run: SyncRun = {
      runId: 'run-2',
      kind: 'manual',
      userId: 'uid-abc',
      startedAt: '2026-06-30T10:15:00.000Z',
      completedAt: '2026-06-30T10:15:08.000Z',
      durationMs: 8000,
      titlesGathered: 5,
      titlesUpdated: 4,
      errorCount: 2,
      errors: ['TMDB 429 for 603', 'Trakt timeout for 1399'],
    };
    expect(dataToSyncRun(simulateStored(syncRunToData(run)) as never)).toEqual(
      run,
    );
  });
});

describe('converters — directional spot-checks', () => {
  it('write emits Date (not string)', () => {
    const item: WatchlistItem = {
      type: 'movie',
      tmdbId: 603,
      traktId: 1,
      title: 'The Matrix',
      addedAt: '2026-03-04T05:06:07.000Z',
      status: 'planned',
      watchingViaPlex: false,
    };
    expect(watchlistItemToData(item).addedAt).toBeInstanceOf(Date);

    const ep: EpisodeDoc = {
      season: 1,
      episode: 1,
      title: 'Pilot',
      airDate: '2026-04-01T20:00:00.000Z',
      watched: true,
      watchedAt: '2026-04-02T21:30:00.000Z',
    };
    expect(episodeToData(ep).airDate).toBeInstanceOf(Date);
    expect(episodeToData(ep).watchedAt).toBeInstanceOf(Date);

    const run: SyncRun = {
      runId: 'run-3',
      kind: 'cron',
      userId: null,
      startedAt: '2026-06-30T01:00:00.000Z',
      completedAt: '2026-06-30T01:02:30.000Z',
      durationMs: 150000,
      titlesGathered: 0,
      titlesUpdated: 0,
      errorCount: 0,
      errors: [],
    };
    expect(syncRunToData(run).startedAt).toBeInstanceOf(Date);
    expect(syncRunToData(run).completedAt).toBeInstanceOf(Date);
  });

  it('read emits ISO string', () => {
    const iso = '2026-03-04T05:06:07.000Z';
    const item = dataToWatchlistItem({
      type: 'movie',
      tmdbId: 603,
      traktId: 1,
      title: 'The Matrix',
      addedAt: fakeTs(new Date(iso)),
      status: 'planned',
    });
    expect(item.addedAt).toBe(iso);
  });
});

describe('path builders — equality', () => {
  it('produces every PLAN §4 path', () => {
    expect(userPath('u1')).toBe('users/u1');
    expect(watchlistPath('u1')).toBe('users/u1/watchlist');
    expect(watchlistItemPath('u1', 't9')).toBe('users/u1/watchlist/t9');
    expect(episodesPath('u1', 't9')).toBe('users/u1/watchlist/t9/episodes');
    expect(episodePath('u1', 't9', 'e3')).toBe(
      'users/u1/watchlist/t9/episodes/e3',
    );
    expect(notificationsPath('u1')).toBe('users/u1/notifications');
    expect(notificationPath('u1', 'n2')).toBe('users/u1/notifications/n2');
    expect(titleCachePath()).toBe('title-cache');
    expect(titleCacheDocPath(603)).toBe('title-cache/603');
    expect(availabilityPath(603)).toBe('title-cache/603/availability');
    expect(availabilityDocPath(603, 'NL')).toBe(
      'title-cache/603/availability/NL',
    );
    expect(syncRunsCollection()).toBe('sync-runs');
    expect(syncRunDocPath('abc')).toBe('sync-runs/abc');
    expect(providerCatalogPath()).toBe('provider-catalog');
    expect(providerCatalogDocPath('NL')).toBe('provider-catalog/NL');
  });

  it('document paths have even segment counts; collection paths odd', () => {
    const segs = (p: string) => p.split('/').length;

    const collectionPaths = [
      watchlistPath('u1'),
      episodesPath('u1', 't9'),
      notificationsPath('u1'),
      titleCachePath(),
      availabilityPath(603),
      syncRunsCollection(),
      providerCatalogPath(),
    ];
    const documentPaths = [
      userPath('u1'),
      watchlistItemPath('u1', 't9'),
      episodePath('u1', 't9', 'e3'),
      notificationPath('u1', 'n2'),
      titleCacheDocPath(603),
      availabilityDocPath(603, 'NL'),
      syncRunDocPath('abc'),
      providerCatalogDocPath('NL'),
    ];

    for (const p of collectionPaths) {
      expect(segs(p) % 2).toBe(1);
    }
    for (const p of documentPaths) {
      expect(segs(p) % 2).toBe(0);
    }
  });
});
