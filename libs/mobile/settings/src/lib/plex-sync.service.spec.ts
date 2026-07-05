import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type {
  PlexClient,
  PlexEpisodeItem,
  PlexLibraryItem,
  PlexServer,
} from '@vultus/shared/domain';
import {
  episodePath,
  userPath,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlexSyncService,
  plexEpisodeId,
  type PlexSyncSummary,
} from './plex-sync.service';

// --- AngularFire mock (echo path on doc()/collection(); per-test doc store) ---
interface Ref {
  path: string;
}
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const collectionMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const getDocMock = vi.fn<(ref: Ref) => Promise<unknown>>();
const getDocsMock = vi.fn<(ref: Ref) => Promise<unknown>>();
const setDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  collection: (fs: unknown, path: string): Ref => collectionMock(fs, path),
  getDoc: (ref: Ref): Promise<unknown> => getDocMock(ref),
  getDocs: (ref: Ref): Promise<unknown> => getDocsMock(ref),
  setDoc: (ref: Ref, payload: unknown): Promise<void> =>
    setDocMock(ref, payload),
  updateDoc: (ref: Ref, payload: unknown): Promise<void> =>
    updateDocMock(ref, payload),
}));

// --- @capacitor/preferences mock (linked by default) ---
const prefsGetMock = vi.fn<() => Promise<{ value: string | null }>>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (): Promise<{ value: string | null }> => prefsGetMock(),
  },
}));

const UID = 'user-123';
const SERVER: PlexServer = {
  name: 'Test PMS',
  baseUrl: 'http://192.168.1.20:32400',
  accessToken: 'srv-token',
};

// A recent cursor (30 min ago) so items added after it are "new".
const CURSOR_ISO = new Date(Date.now() - 30 * 60_000).toISOString();
const AFTER_CURSOR = new Date(Date.now() - 5 * 60_000).toISOString();
const BEFORE_CURSOR = new Date(Date.now() - 60 * 60_000).toISOString();

function snap(data: unknown) {
  return { exists: () => data !== undefined, data: () => data };
}

/** A watchlist read-data shape carrying the given status (addedAt is a
 *  Timestamp-like so `dataToWatchlistItem` can `.toDate()` it). */
function watchlistReadData(status: string) {
  return {
    type: 'movie',
    tmdbId: 0,
    traktId: null,
    title: 'X',
    addedAt: { toDate: () => new Date(0) },
    status,
    posterPath: null,
    voteAverage: null,
    watchingViaPlex: true,
  };
}

/** Build a mock PlexClient returning the given library + episodes. */
function mockClient(
  library: PlexLibraryItem[],
  episodesByRatingKey: Record<string, PlexEpisodeItem[]> = {},
): PlexClient {
  return {
    requestPin: vi.fn(),
    checkPin: vi.fn(),
    discoverServer: vi.fn().mockResolvedValue(SERVER),
    listLibrary: vi.fn().mockResolvedValue(library),
    listEpisodes: vi
      .fn()
      .mockImplementation((_s: PlexServer, ratingKey: string) =>
        Promise.resolve(episodesByRatingKey[ratingKey] ?? []),
      ),
  };
}

/**
 * Configure the Firestore doc store. `userPlexSync` seeds the user doc's
 * plexSync (for the cursor read); `watchlist` maps titleId → status (undefined
 * = untracked); `episodes` maps `${titleId}/${epId}` → { watched } for existing
 * episode docs.
 */
function seedFirestore(opts: {
  watchlist?: Record<string, string>;
  episodes?: Record<string, { watched: boolean }>;
  userPlexSync?: { linkedAt: string; lastSyncAt: string | null } | null;
}) {
  const watchlist = opts.watchlist ?? {};
  const episodes = opts.episodes ?? {};
  const userDoc = {
    region: 'NL',
    notificationPrefs: {
      episodeAired: true,
      movieAvailable: true,
      cameToPlatform: true,
      deliveryHour: null,
    },
    fcmTokens: [],
    myProviderIds: [],
    hasPlex: true,
    plexSync: opts.userPlexSync ?? { linkedAt: CURSOR_ISO, lastSyncAt: null },
  };

  getDocMock.mockImplementation((ref: Ref) => {
    if (ref.path === userPath(UID)) {
      return Promise.resolve(snap(userDoc));
    }
    // Episode doc: users/{uid}/watchlist/{titleId}/episodes/{epId}
    const epMatch = /\/watchlist\/(\d+)\/episodes\/(s\d+e\d+)$/.exec(ref.path);
    if (epMatch) {
      const key = `${epMatch[1]}/${epMatch[2]}`;
      return Promise.resolve(snap(episodes[key]));
    }
    // Watchlist item: users/{uid}/watchlist/{titleId}
    const wlMatch = /\/watchlist\/(\d+)$/.exec(ref.path);
    if (wlMatch) {
      const status = watchlist[wlMatch[1]];
      return Promise.resolve(
        snap(status === undefined ? undefined : watchlistReadData(status)),
      );
    }
    return Promise.resolve(snap(undefined));
  });

  // getDocs over the episodes subcollection: return existing episode docs for
  // that title as { data: () => ({ watched }) } snapshots (reflects live store).
  getDocsMock.mockImplementation((ref: Ref) => {
    const collMatch = /\/watchlist\/(\d+)\/episodes$/.exec(ref.path);
    const titleId = collMatch?.[1];
    const docs = Object.entries(episodes)
      .filter(([key]) => key.startsWith(`${titleId}/`))
      .map(([, ep]) => ({ data: () => ({ ...ep }) }));
    return Promise.resolve({ docs });
  });

  // The episode mirror's updateDoc mutates the in-memory episode store so a
  // subsequent status derivation reads fresh watched-counts (as real Firestore
  // would). Watchlist status writes are asserted from the mock's call log, not
  // re-read, so they need not mutate the store.
  updateDocMock.mockImplementation((ref: Ref, payload: unknown) => {
    const epMatch = /\/watchlist\/(\d+)\/episodes\/(s\d+e\d+)$/.exec(ref.path);
    if (epMatch) {
      const key = `${epMatch[1]}/${epMatch[2]}`;
      if (episodes[key] !== undefined) {
        episodes[key] = {
          watched: (payload as { watched: boolean }).watched,
        };
      }
    }
    return Promise.resolve();
  });
}

function makeService(client: PlexClient, uid: string | null = UID) {
  TestBed.configureTestingModule({
    providers: [
      PlexSyncService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: PLEX_CLIENT, useValue: client },
    ],
  });
  return TestBed.inject(PlexSyncService);
}

/** Run a sync expected to succeed and return its summary (asserts `ok`). */
async function syncOk(service: PlexSyncService): Promise<PlexSyncSummary> {
  const result = await service.sync();
  expect(result.status).toBe('ok');
  return (result as { status: 'ok'; summary: PlexSyncSummary }).summary;
}

/** dataToWatchlistItem reads `status`; the read-data shape only needs it here. */
function movieItem(
  tmdbId: number,
  over: Partial<PlexLibraryItem> = {},
): PlexLibraryItem {
  return {
    type: 'movie',
    tmdbId,
    title: `Movie ${tmdbId}`,
    addedAt: AFTER_CURSOR,
    viewCount: 0,
    lastViewedAt: null,
    ratingKey: `rk-${tmdbId}`,
    ...over,
  };
}
function tvItem(
  tmdbId: number,
  over: Partial<PlexLibraryItem> = {},
): PlexLibraryItem {
  return {
    type: 'tv',
    tmdbId,
    title: `Show ${tmdbId}`,
    addedAt: AFTER_CURSOR,
    viewCount: 0,
    lastViewedAt: null,
    ratingKey: `rk-${tmdbId}`,
    ...over,
  };
}

describe('PlexSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
    prefsGetMock.mockResolvedValue({ value: 'device-token' });
  });

  describe('plexEpisodeId', () => {
    it('pads season to 2 and episode to 3 digits (s01e001, NOT s01e01)', () => {
      expect(plexEpisodeId(1, 1)).toBe('s01e001');
      expect(plexEpisodeId(1, 12)).toBe('s01e012');
      expect(plexEpisodeId(10, 100)).toBe('s10e100');
    });
  });

  it('adds a new unwatched library movie as planned, watchingViaPlex, traktId null', async () => {
    seedFirestore({});
    const service = makeService(mockClient([movieItem(550)]));
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '550'),
    );
    expect(call).toBeTruthy();
    const payload = call?.[1] as {
      status: string;
      watchingViaPlex: boolean;
      traktId: number | null;
    };
    expect(payload.status).toBe('planned');
    expect(payload.watchingViaPlex).toBe(true);
    expect(payload.traktId).toBeNull();
  });

  it('cursor filtering: an older-than-cursor unwatched item is NOT added', async () => {
    seedFirestore({});
    const service = makeService(
      mockClient([movieItem(550, { addedAt: BEFORE_CURSOR })]),
    );
    const summary = await syncOk(service);

    expect(summary.added).toBe(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(
      setDocMock.mock.calls.some(
        ([ref]) => ref.path === watchlistItemPath(UID, '550'),
      ),
    ).toBe(false);
  });

  it('GUID-less item is skipped: counted, no write, never fuzzy-matched', async () => {
    seedFirestore({});
    const service = makeService(
      mockClient([movieItem(0, { tmdbId: null, viewCount: 1 })]),
    );
    const summary = await syncOk(service);

    expect(summary.skipped).toBe(1);
    expect(summary.added).toBe(0);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('watch-implies-add: a watched, untracked movie is added completed', async () => {
    seedFirestore({});
    const service = makeService(mockClient([movieItem(603, { viewCount: 1 })]));
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '603'),
    );
    expect((call?.[1] as { status: string }).status).toBe('completed');
  });

  it('watch-implies-add: a watched, untracked show is added watching', async () => {
    seedFirestore({});
    const service = makeService(
      mockClient([tvItem(1396, { viewCount: 1 })], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
        ],
      }),
    );
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
    );
    expect((call?.[1] as { status: string }).status).toBe('watching');
  });

  it('status mapping: a watched movie already tracked (planned) flips to completed', async () => {
    seedFirestore({ watchlist: { '550': 'planned' } });
    const service = makeService(mockClient([movieItem(550, { viewCount: 1 })]));
    const summary = await syncOk(service);

    expect(summary.updated).toBe(1);
    const call = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '550'),
    );
    expect((call?.[1] as { status: string }).status).toBe('completed');
  });

  it('first-episode flip: first watched episode of a planned show → watching', async () => {
    seedFirestore({
      watchlist: { '1396': 'planned' },
      episodes: {
        '1396/s01e001': { watched: false },
        '1396/s01e002': { watched: false },
      },
    });
    const service = makeService(
      mockClient([tvItem(1396)], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
        ],
      }),
    );
    const summary = await syncOk(service);

    // Episode mirror wrote s01e001 watched.
    const epWrite = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
    );
    expect((epWrite?.[1] as { watched: boolean }).watched).toBe(true);
    // Status flipped planned → watching.
    expect(summary.updated).toBe(1);
    const statusWrite = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
    );
    expect((statusWrite?.[1] as { status: string }).status).toBe('watching');
  });

  it('all present episodes watched → completed (from watching)', async () => {
    seedFirestore({
      watchlist: { '1396': 'watching' },
      episodes: {
        '1396/s01e001': { watched: true },
        '1396/s01e002': { watched: false },
      },
    });
    const service = makeService(
      mockClient([tvItem(1396)], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          { season: 1, episode: 2, viewCount: 1, lastViewedAt: null },
        ],
      }),
    );
    const summary = await syncOk(service);

    // Both episodes mirrored watched, so status → completed.
    expect(summary.updated).toBe(1);
    const statusWrite = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
    );
    expect((statusWrite?.[1] as { status: string }).status).toBe('completed');
  });

  it('sticky-dropped: keeps dropped (no status write) but STILL mirrors episodes', async () => {
    seedFirestore({
      watchlist: { '1396': 'dropped' },
      episodes: { '1396/s01e001': { watched: false } },
    });
    const service = makeService(
      mockClient([tvItem(1396, { viewCount: 1 })], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
        ],
      }),
    );
    const summary = await syncOk(service);

    // Episode mirror STILL wrote the episode doc.
    const epWrite = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
    );
    expect(epWrite).toBeTruthy();
    expect((epWrite?.[1] as { watched: boolean }).watched).toBe(true);
    // NO status write to the watchlist doc (dropped is sticky).
    expect(
      updateDocMock.mock.calls.some(
        ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
      ),
    ).toBe(false);
    expect(summary.updated).toBe(0);
  });

  it('sticky-dropped movie: keeps dropped, no status write', async () => {
    seedFirestore({ watchlist: { '550': 'dropped' } });
    const service = makeService(mockClient([movieItem(550, { viewCount: 1 })]));
    await service.sync();

    expect(
      updateDocMock.mock.calls.some(
        ([ref]) => ref.path === watchlistItemPath(UID, '550'),
      ),
    ).toBe(false);
  });

  it('episode-doc-absent: a Plex-watched episode with no local doc is a no-op (never creates)', async () => {
    // Show tracked planned, but NO local episode docs exist.
    seedFirestore({ watchlist: { '1396': 'planned' } });
    const service = makeService(
      mockClient([tvItem(1396)], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
        ],
      }),
    );
    await service.sync();

    // No episode setDoc/updateDoc at the episode path (doc absent).
    expect(
      updateDocMock.mock.calls.some(
        ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
      ),
    ).toBe(false);
    expect(
      setDocMock.mock.calls.some(([ref]) => ref.path.includes('/episodes/')),
    ).toBe(false);
  });

  it('episode mirror writes watchedAt from lastViewedAt (Date), null when unwatched', async () => {
    const lastViewed = new Date(Date.now() - 2 * 60_000).toISOString();
    seedFirestore({
      watchlist: { '1396': 'watching' },
      episodes: {
        '1396/s01e001': { watched: false },
        '1396/s01e002': { watched: false },
      },
    });
    const service = makeService(
      mockClient([tvItem(1396)], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: lastViewed },
          { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
        ],
      }),
    );
    await service.sync();

    const e1 = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
    )?.[1] as { watched: boolean; watchedAt: Date | null };
    expect(e1.watched).toBe(true);
    expect(e1.watchedAt).toBeInstanceOf(Date);
    const e2 = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === episodePath(UID, '1396', 's01e002'),
    )?.[1] as { watched: boolean; watchedAt: Date | null };
    expect(e2.watched).toBe(false);
    expect(e2.watchedAt).toBeNull();
  });

  it('concurrent-sync guard: a second sync() while one runs is a no-op', async () => {
    seedFirestore({});
    // A client whose listLibrary never resolves until we release it.
    let release: (v: PlexLibraryItem[]) => void = () => undefined;
    const gated = new Promise<PlexLibraryItem[]>((r) => (release = r));
    const listLibrary = vi.fn().mockReturnValue(gated);
    const client = mockClient([]);
    client.listLibrary = listLibrary;
    const service = makeService(client);

    const first = service.sync();
    // The running flag is claimed synchronously at the top of sync().
    expect(service.running()).toBe(true);
    // While the first sync is mid-flight (gated on listLibrary), a second call
    // is a no-op — no duplicate work, no double writes.
    const second = await service.sync();
    expect(second).toEqual({ status: 'skipped', reason: 'busy' });

    release([]);
    await first;
    // The gated listLibrary was reached only once (by the first sync); the
    // second short-circuited on the running guard before any Firestore access.
    expect(listLibrary).toHaveBeenCalledTimes(1);
    expect(setDocMock).not.toHaveBeenCalled();
    expect(service.running()).toBe(false);
  });

  it('advances the cursor: writes plexSync.lastSyncAt on success', async () => {
    seedFirestore({});
    const service = makeService(mockClient([]));
    await service.sync();

    const cursorWrite = updateDocMock.mock.calls.find(
      ([ref, payload]) =>
        ref.path === userPath(UID) &&
        Object.prototype.hasOwnProperty.call(payload, 'plexSync.lastSyncAt'),
    );
    expect(cursorWrite).toBeTruthy();
  });

  it('no-op when uid is null (skipped not-linked, no writes)', async () => {
    seedFirestore({});
    const service = makeService(mockClient([movieItem(550)]), null);
    const result = await service.sync();

    expect(result).toEqual({ status: 'skipped', reason: 'not-linked' });
    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('no-op when not linked (no Preferences token → skipped not-linked)', async () => {
    seedFirestore({});
    prefsGetMock.mockResolvedValue({ value: null });
    const service = makeService(mockClient([movieItem(550)]));
    const result = await service.sync();

    expect(result).toEqual({ status: 'skipped', reason: 'not-linked' });
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('skipped no-server when discovery finds none (no writes)', async () => {
    seedFirestore({});
    const client = mockClient([movieItem(550)]);
    client.discoverServer = vi.fn().mockResolvedValue(null);
    const service = makeService(client);
    const result = await service.sync();

    expect(result).toEqual({ status: 'skipped', reason: 'no-server' });
    expect(setDocMock).not.toHaveBeenCalled();
    // The cursor is NOT advanced on a no-op.
    expect(
      updateDocMock.mock.calls.some(([ref]) => ref.path === userPath(UID)),
    ).toBe(false);
  });

  it('error result when discoverServer throws (never throws out of sync)', async () => {
    seedFirestore({});
    const client = mockClient([movieItem(550)]);
    client.discoverServer = vi.fn().mockRejectedValue(new Error('http 401'));
    const service = makeService(client);
    const result = await service.sync();

    expect(result).toEqual({ status: 'error' });
    expect(service.running()).toBe(false);
  });

  it('error result when listLibrary throws (PMS unreachable)', async () => {
    seedFirestore({});
    const client = mockClient([]);
    client.listLibrary = vi.fn().mockRejectedValue(new Error('timeout'));
    const service = makeService(client);
    const result = await service.sync();

    expect(result).toEqual({ status: 'error' });
    // The cursor is NOT advanced on a failed pass.
    expect(
      updateDocMock.mock.calls.some(([ref]) => ref.path === userPath(UID)),
    ).toBe(false);
  });
});
