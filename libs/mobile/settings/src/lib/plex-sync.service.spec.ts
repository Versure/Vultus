import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type {
  PlexClient,
  PlexEpisodeItem,
  PlexLibraryItem,
  PlexServer,
  PlexUnmatchedTitle,
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
import type { TmdbDetailConfig } from './tmdb-detail.client';
import { SETTINGS_TMDB_CONFIG } from './tokens';

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

// --- TMDB detail fetch mock (spec 0086) ------------------------------------
// PlexSyncService builds its slice-local TMDB client from SETTINGS_TMDB_CONFIG,
// which carries a `fetchImpl`. We inject a controllable fetch mock as that
// impl, so we exercise the REAL client (getDetail → HTTP → mapping) end-to-end
// and can (a) resolve poster/vote payloads, (b) simulate non-2xx/network
// failures, and (c) assert the client was NOT called (backfill skip).
const tmdbFetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const TMDB_CONFIG: TmdbDetailConfig = {
  apiBaseUrl: 'https://api.themoviedb.org/3',
  imageBaseUrl: 'https://image.tmdb.org/t/p/w780',
  auth: { kind: 'apiKey', apiKey: 'test-key' },
  fetchImpl: tmdbFetchMock as unknown as typeof fetch,
};

/** Build a minimal TMDB `Response` (only `.ok`/`.status`/`.json()` are read). */
function tmdbResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** The write payload `episodeToData` produces (what a create `setDoc` carries). */
interface EpisodeWriteLike {
  season: number;
  episode: number;
  title: string | null;
  airDate: Date;
  watched: boolean;
  watchedAt: Date | null;
}

/** A raw `/tv/{id}/season/{n}` episode entry (only the mapper's fields). */
function rawEp(
  episode: number,
  over: {
    season_number?: number;
    name?: string | null;
    air_date?: string | null;
  } = {},
): {
  episode_number: number;
  season_number: number;
  name: string | null;
  air_date: string | null;
} {
  return {
    episode_number: episode,
    season_number: over.season_number ?? 1,
    name: 'name' in over ? (over.name ?? null) : `Ep ${episode}`,
    air_date: 'air_date' in over ? (over.air_date ?? null) : '2008-01-20',
  };
}

/**
 * Route the injected TMDB fetch by URL for the on-device episode-creation path
 * (spec 0098): `/tv/{id}/season/{n}` → the season episode list; `/tv/{id}` →
 * the detail (which also carries `number_of_seasons`, consumed by
 * `getTvSeasonCount`). `seasons` maps a season number → its raw episodes array;
 * `seasonCount` populates `number_of_seasons` (null → omitted → getTvSeasonCount
 * returns null). Any other URL → a generic 200 detail. Season is matched BEFORE
 * the generic `/tv/{id}` so a season URL never falls through to the detail stub.
 */
function routeTmdbTv(opts: {
  seasonCount: number | null;
  seasons?: Record<number, unknown[]>;
  detailStatus?: number;
  seasonStatus?: number;
}): void {
  const seasons = opts.seasons ?? {};
  tmdbFetchMock.mockImplementation((url: string) => {
    const seasonMatch = /\/tv\/\d+\/season\/(\d+)/.exec(url);
    if (seasonMatch) {
      if (opts.seasonStatus && opts.seasonStatus !== 200) {
        return Promise.resolve(tmdbResponse({}, false, opts.seasonStatus));
      }
      const n = Number(seasonMatch[1]);
      return Promise.resolve(tmdbResponse({ episodes: seasons[n] ?? [] }));
    }
    if (/\/tv\/\d+/.test(url)) {
      if (opts.detailStatus && opts.detailStatus !== 200) {
        return Promise.resolve(tmdbResponse({}, false, opts.detailStatus));
      }
      return Promise.resolve(
        tmdbResponse({
          id: 1396,
          name: 'Breaking Bad',
          poster_path: '/bb.jpg',
          vote_average: 9,
          number_of_seasons: opts.seasonCount ?? undefined,
        }),
      );
    }
    return Promise.resolve(
      tmdbResponse({
        id: 0,
        title: 'X',
        poster_path: '/d.jpg',
        vote_average: 7,
      }),
    );
  });
}

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

/** A watchlist read-data shape carrying the given status + stored posterPath
 *  (addedAt is a Timestamp-like so `dataToWatchlistItem` can `.toDate()` it).
 *  posterPath defaults to a NON-NULL value so status-focused tests don't trigger
 *  the spec-0086 poster backfill; backfill tests pass `null` explicitly. */
function watchlistReadData(
  status: string,
  posterPath: string | null = '/existing.jpg',
) {
  return {
    type: 'movie',
    tmdbId: 0,
    title: 'X',
    addedAt: { toDate: () => new Date(0) },
    status,
    posterPath,
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
  // A titleId maps to either a status string (→ default non-null stored
  // posterPath, no backfill) or a { status, posterPath } pair for the spec-0086
  // backfill cases (posterPath: null = the issue #229 broken state).
  watchlist?: Record<
    string,
    string | { status: string; posterPath: string | null }
  >;
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
      const entry = watchlist[wlMatch[1]];
      if (entry === undefined) {
        return Promise.resolve(snap(undefined));
      }
      const status = typeof entry === 'string' ? entry : entry.status;
      const posterPath =
        typeof entry === 'string' ? '/existing.jpg' : entry.posterPath;
      return Promise.resolve(snap(watchlistReadData(status, posterPath)));
    }
    return Promise.resolve(snap(undefined));
  });

  // getDocs over the episodes subcollection: return existing episode docs for
  // that title as { id, data: () => ({ watched }) } snapshots (reflects live
  // store). `id` is the `s{SS}e{EEE}` doc id — read by ensureEpisodeDocs for the
  // gap-guard + insert-only diff, as real QueryDocumentSnapshot.id would be.
  getDocsMock.mockImplementation((ref: Ref) => {
    const collMatch = /\/watchlist\/(\d+)\/episodes$/.exec(ref.path);
    const titleId = collMatch?.[1];
    const docs = Object.entries(episodes)
      .filter(([key]) => key.startsWith(`${titleId}/`))
      .map(([key, ep]) => ({ id: key.split('/')[1], data: () => ({ ...ep }) }));
    return Promise.resolve({ docs });
  });

  // ensureEpisodeDocs' insert-only create: a setDoc at an episode path adds the
  // new doc to the in-memory store (starting `watched: false`, as
  // episodeToData's payload carries) so the subsequent mirror getDoc/updateDoc
  // and status-derivation getDocs read it back (Firestore read-your-writes).
  // Non-episode setDocs (watchlist adds) are asserted from the call log only.
  setDocMock.mockImplementation((ref: Ref, payload: unknown) => {
    const epMatch = /\/watchlist\/(\d+)\/episodes\/(s\d+e\d+)$/.exec(ref.path);
    if (epMatch) {
      const key = `${epMatch[1]}/${epMatch[2]}`;
      episodes[key] = { watched: (payload as { watched: boolean }).watched };
    }
    return Promise.resolve();
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
      { provide: SETTINGS_TMDB_CONFIG, useValue: TMDB_CONFIG },
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

/** The `plexSync.unmatched` array persisted by the pass's single userPath write. */
function readPersistedUnmatched(): PlexUnmatchedTitle[] {
  const write = updateDocMock.mock.calls.find(
    ([ref, payload]) =>
      ref.path === userPath(UID) &&
      Object.prototype.hasOwnProperty.call(payload, 'plexSync.unmatched'),
  );
  return (write?.[1] as Record<string, PlexUnmatchedTitle[]>)[
    'plexSync.unmatched'
  ];
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
    // Default TMDB detail resolves a generic poster/vote so add/backfill paths
    // that don't assert on the poster still succeed; per-test overrides below
    // pin specific values or simulate failures.
    tmdbFetchMock.mockResolvedValue(
      tmdbResponse({
        id: 0,
        title: 'X',
        poster_path: '/default.jpg',
        vote_average: 7,
      }),
    );
  });

  describe('plexEpisodeId', () => {
    it('pads season to 2 and episode to 3 digits (s01e001, NOT s01e01)', () => {
      expect(plexEpisodeId(1, 1)).toBe('s01e001');
      expect(plexEpisodeId(1, 12)).toBe('s01e012');
      expect(plexEpisodeId(10, 100)).toBe('s10e100');
    });
  });

  it('adds a new unwatched library movie as planned, watchingViaPlex', async () => {
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
    };
    expect(payload.status).toBe('planned');
    expect(payload.watchingViaPlex).toBe(true);
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

  it('no-guid: an item with no tmdb/tvdb/imdb id is UNMATCHED (no-guid), not skipped, no write', async () => {
    seedFirestore({});
    const service = makeService(
      mockClient([movieItem(0, { tmdbId: null, viewCount: 1 })]),
    );
    const summary = await syncOk(service);

    // Moved from summary.skipped → summary.unmatched (spec 0097 T3).
    expect(summary.unmatched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.added).toBe(0);
    expect(setDocMock).not.toHaveBeenCalled();
    expect(readPersistedUnmatched()).toEqual([
      { title: 'Movie 0', reason: 'no-guid' },
    ]);
  });

  it('/find fallback: a tvdb-only show resolves via /find and is added like a tmdb item', async () => {
    seedFirestore({});
    tmdbFetchMock.mockImplementation((url: string) => {
      if (url.includes('/find/')) {
        return Promise.resolve(
          tmdbResponse({ tv_results: [{ id: 1396 }], movie_results: [] }),
        );
      }
      return Promise.resolve(
        tmdbResponse({
          id: 1396,
          name: 'Breaking Bad',
          poster_path: '/bb.jpg',
          vote_average: 8.9,
        }),
      );
    });
    const service = makeService(
      mockClient([tvItem(0, { tmdbId: null, tvdbId: 81189 })], { 'rk-0': [] }),
    );
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    expect(summary.unmatched).toBe(0);
    // Written at the RESOLVED tmdb id, exactly as a tmdb:// item would be.
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
    );
    expect(call).toBeTruthy();
    expect((call?.[1] as { status: string }).status).toBe('planned');
    expect(readPersistedUnmatched()).toEqual([]);
  });

  it('guid-unresolved: a tvdb-only show whose /find returns no matching-type result is recorded guid-unresolved', async () => {
    seedFirestore({});
    // Default tmdbFetchMock body carries NO tv_results → findByExternalId null.
    const service = makeService(
      mockClient([tvItem(0, { tmdbId: null, tvdbId: 81189 })], { 'rk-0': [] }),
    );
    const summary = await syncOk(service);

    expect(summary.unmatched).toBe(1);
    expect(summary.added).toBe(0);
    expect(setDocMock).not.toHaveBeenCalled();
    expect(readPersistedUnmatched()).toEqual([
      { title: 'Show 0', reason: 'guid-unresolved' },
    ]);
  });

  it('guid-unresolved: a MOVIE with ONLY a tvdb id is guid-unresolved, not no-guid (tvdb is show-only, /find never called)', async () => {
    seedFirestore({});
    const service = makeService(
      mockClient([movieItem(0, { tmdbId: null, tvdbId: 12345 })]),
    );
    const summary = await syncOk(service);

    expect(summary.unmatched).toBe(1);
    expect(readPersistedUnmatched()).toEqual([
      { title: 'Movie 0', reason: 'guid-unresolved' },
    ]);
    // A movie never sends its tvdb id to /find (tvdb is show-only) and has no
    // imdb id, so /find is not called at all.
    expect(tmdbFetchMock).not.toHaveBeenCalled();
  });

  it('per-item isolation: one item throwing is recorded "error" and LATER items still process', async () => {
    seedFirestore({});
    // The show's episode fetch throws; the movie after it must still be added.
    const client = mockClient([tvItem(1396, { viewCount: 1 }), movieItem(550)]);
    client.listEpisodes = vi
      .fn()
      .mockRejectedValue(new Error('listEpisodes 404'));
    const service = makeService(client);
    const summary = await syncOk(service);

    expect(summary.unmatched).toBe(1);
    expect(summary.added).toBe(1);
    // The subsequent movie's write happened despite the earlier item throwing.
    const movieWrite = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '550'),
    );
    expect(movieWrite).toBeTruthy();
    expect(readPersistedUnmatched()).toEqual([
      { title: 'Show 1396', reason: 'error' },
    ]);
  });

  it('cursor advances on completion WITH item errors (plexSync.lastSyncAt still written)', async () => {
    seedFirestore({});
    const client = mockClient([tvItem(1396, { viewCount: 1 })]);
    client.listEpisodes = vi.fn().mockRejectedValue(new Error('boom'));
    const service = makeService(client);
    const summary = await syncOk(service);

    expect(summary.unmatched).toBe(1);
    const cursorWrite = updateDocMock.mock.calls.find(
      ([ref, payload]) =>
        ref.path === userPath(UID) &&
        Object.prototype.hasOwnProperty.call(payload, 'plexSync.lastSyncAt'),
    );
    expect(cursorWrite).toBeTruthy();
  });

  it('missing addedAt: an unwatched item with addedAt null is added planned (not skip-forever)', async () => {
    seedFirestore({});
    const service = makeService(
      mockClient([movieItem(550, { addedAt: null })]),
    );
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '550'),
    );
    expect((call?.[1] as { status: string }).status).toBe('planned');
  });

  it('unmatched persistence: a >50 pass truncates plexSync.unmatched to 50 (capped)', async () => {
    seedFirestore({});
    const items = Array.from({ length: 60 }, (_v, i) =>
      movieItem(0, {
        tmdbId: null,
        title: `No ${i}`,
        ratingKey: `rk-none-${i}`,
      }),
    );
    const service = makeService(mockClient(items));
    const summary = await syncOk(service);

    expect(summary.unmatched).toBe(60);
    expect(readPersistedUnmatched().length).toBe(50);
  });

  it('unmatched persistence: a clean pass writes [] (clears the list)', async () => {
    seedFirestore({});
    const service = makeService(mockClient([movieItem(550)]));
    await syncOk(service);

    expect(readPersistedUnmatched()).toEqual([]);
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

  it('watch-implies-add: a watched, untracked show with an unwatched episode doc is added watching', async () => {
    // A watched Plex episode (s01e001) plus a present-but-unwatched episode doc
    // (s01e002, e.g. a scheduled/future episode) → watched < total → 'watching'.
    seedFirestore({
      episodes: {
        '1396/s01e001': { watched: false },
        '1396/s01e002': { watched: false },
      },
    });
    const service = makeService(
      mockClient([tvItem(1396, { viewCount: 1 })], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
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

  it('watch-implies-add (#277 fix): a watched, untracked show with ALL episode docs watched is added completed on the FIRST sync', async () => {
    // Ended show, no future episodes: both episode docs already present + both
    // watched in Plex → after the same-pass mirror, watched === total > 0, so the
    // derived initial status is 'completed' on the very first sync (not the old
    // hardcoded 'watching' that only self-healed on a later sync).
    seedFirestore({
      episodes: {
        '1396/s01e001': { watched: false },
        '1396/s01e002': { watched: false },
      },
    });
    const service = makeService(
      mockClient([tvItem(1396, { viewCount: 1 })], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          { season: 1, episode: 2, viewCount: 1, lastViewedAt: null },
        ],
      }),
    );
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
    );
    expect((call?.[1] as { status: string }).status).toBe('completed');
  });

  it('watch-implies-add: a watched, untracked show PARTIALLY watched is added watching (not completed)', async () => {
    // Three episode docs, only one watched in Plex → watched < total → 'watching'.
    seedFirestore({
      episodes: {
        '1396/s01e001': { watched: false },
        '1396/s01e002': { watched: false },
        '1396/s01e003': { watched: false },
      },
    });
    const service = makeService(
      mockClient([tvItem(1396, { viewCount: 1 })], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
          { season: 1, episode: 3, viewCount: 0, lastViewedAt: null },
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

  it('watch-implies-add: an unwatched-new, untracked show is added planned (unchanged regression guard)', async () => {
    // No watched episode → not the watch-implies-add branch → the isNewAddition
    // (planned) branch. The #277 fix must not touch this path.
    seedFirestore({
      episodes: { '1396/s01e001': { watched: false } },
    });
    const service = makeService(
      mockClient([tvItem(1396)], {
        'rk-1396': [
          { season: 1, episode: 1, viewCount: 0, lastViewedAt: null },
        ],
      }),
    );
    const summary = await syncOk(service);

    expect(summary.added).toBe(1);
    const call = setDocMock.mock.calls.find(
      ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
    );
    expect((call?.[1] as { status: string }).status).toBe('planned');
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

  describe('TMDB poster fetch + backfill (spec 0086)', () => {
    /** Find the setDoc/updateDoc call to a watchlist doc carrying a given key. */
    function findWatchlistWrite(
      calls: [Ref, unknown][],
      titleId: string,
      key: string,
    ) {
      return calls.find(
        ([ref, payload]) =>
          ref.path === watchlistItemPath(UID, titleId) &&
          Object.prototype.hasOwnProperty.call(payload, key),
      );
    }

    it('add: populates posterPath/voteAverage from the fetched TMDB detail', async () => {
      seedFirestore({});
      tmdbFetchMock.mockResolvedValue(
        tmdbResponse({
          id: 550,
          title: 'Fight Club',
          poster_path: '/x.jpg',
          vote_average: 8.4,
        }),
      );
      const service = makeService(mockClient([movieItem(550)]));
      const summary = await syncOk(service);

      expect(summary.added).toBe(1);
      const call = setDocMock.mock.calls.find(
        ([ref]) => ref.path === watchlistItemPath(UID, '550'),
      );
      const payload = call?.[1] as {
        posterPath: string | null;
        voteAverage: number | null;
      };
      expect(payload.posterPath).toBe('/x.jpg');
      expect(payload.voteAverage).toBe(8.4);
    });

    // Per-item error isolation: a TMDB failure of ANY shape must not throw out
    // of addItem, must leave both fields null, and must NOT fail the sync pass.
    it.each([
      [
        'network error',
        () => tmdbFetchMock.mockRejectedValue(new Error('network down')),
      ],
      [
        'HTTP 404',
        () => tmdbFetchMock.mockResolvedValue(tmdbResponse({}, false, 404)),
      ],
      [
        'HTTP 500',
        () => tmdbFetchMock.mockResolvedValue(tmdbResponse({}, false, 500)),
      ],
    ])(
      'add: succeeds with null poster/vote when TMDB fails (%s); sync stays ok',
      async (_label, arrange) => {
        seedFirestore({});
        arrange();
        const service = makeService(mockClient([movieItem(550)]));
        const result = await service.sync();

        expect(result.status).toBe('ok');
        const call = setDocMock.mock.calls.find(
          ([ref]) => ref.path === watchlistItemPath(UID, '550'),
        );
        expect(call).toBeTruthy();
        const payload = call?.[1] as {
          posterPath: string | null;
          voteAverage: number | null;
        };
        expect(payload.posterPath).toBeNull();
        expect(payload.voteAverage).toBeNull();
      },
    );

    it('backfill: a tracked item with stored posterPath null gets posterPath/voteAverage updated', async () => {
      seedFirestore({
        watchlist: { '550': { status: 'planned', posterPath: null } },
      });
      tmdbFetchMock.mockResolvedValue(
        tmdbResponse({
          id: 550,
          title: 'Fight Club',
          poster_path: '/bf.jpg',
          vote_average: 6.6,
        }),
      );
      const service = makeService(mockClient([movieItem(550)]));
      const summary = await syncOk(service);

      const posterWrite = findWatchlistWrite(
        updateDocMock.mock.calls,
        '550',
        'posterPath',
      );
      expect(posterWrite).toBeTruthy();
      const payload = posterWrite?.[1] as {
        posterPath: string | null;
        voteAverage: number | null;
      };
      expect(payload.posterPath).toBe('/bf.jpg');
      expect(payload.voteAverage).toBe(6.6);
      // A pure poster backfill is NOT a status change (summary semantics).
      expect(summary.updated).toBe(0);
    });

    it('backfill: skipped when the tracked item already has a non-null posterPath (no TMDB call)', async () => {
      seedFirestore({
        watchlist: { '550': { status: 'planned', posterPath: '/have.jpg' } },
      });
      const service = makeService(mockClient([movieItem(550)]));
      await syncOk(service);

      // Strict !== null skip: no redundant fetch, no poster write.
      expect(tmdbFetchMock).not.toHaveBeenCalled();
      expect(
        findWatchlistWrite(updateDocMock.mock.calls, '550', 'posterPath'),
      ).toBeFalsy();
    });

    it('backfill: a sticky-dropped item with posterPath null still gets its poster healed (status untouched)', async () => {
      seedFirestore({
        watchlist: { '550': { status: 'dropped', posterPath: null } },
      });
      tmdbFetchMock.mockResolvedValue(
        tmdbResponse({
          id: 550,
          title: 'Fight Club',
          poster_path: '/heal.jpg',
          vote_average: 7.7,
        }),
      );
      const service = makeService(
        mockClient([movieItem(550, { viewCount: 1 })]),
      );
      const summary = await syncOk(service);

      // Poster backfill fires even for a dropped item.
      const posterWrite = findWatchlistWrite(
        updateDocMock.mock.calls,
        '550',
        'posterPath',
      );
      expect(posterWrite).toBeTruthy();
      expect((posterWrite?.[1] as { posterPath: string }).posterPath).toBe(
        '/heal.jpg',
      );
      // Status is untouched (sticky-dropped): no status write.
      expect(
        findWatchlistWrite(updateDocMock.mock.calls, '550', 'status'),
      ).toBeFalsy();
      expect(summary.updated).toBe(0);
      expect(summary.skipped).toBe(1);
    });
  });

  describe('on-device episode-doc creation (spec 0098, issue #255)', () => {
    it('creation: writes s01e001 + s01e002 with episodeToData fields (watched:false, watchedAt:null, season/episode/title/airDate)', async () => {
      seedFirestore({ watchlist: { '1396': 'watching' }, episodes: {} });
      routeTmdbTv({
        seasonCount: 1,
        seasons: {
          1: [
            rawEp(1, { name: 'Pilot', air_date: '2008-01-20' }),
            rawEp(2, { name: 'Cat in the Bag', air_date: '2008-01-27' }),
          ],
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
      await syncOk(service);

      const e1 = setDocMock.mock.calls.find(
        ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
      )?.[1] as EpisodeWriteLike;
      expect(e1).toBeTruthy();
      expect(e1.season).toBe(1);
      expect(e1.episode).toBe(1);
      expect(e1.title).toBe('Pilot');
      expect(e1.watched).toBe(false);
      expect(e1.watchedAt).toBeNull();
      expect(e1.airDate).toBeInstanceOf(Date);

      const e2 = setDocMock.mock.calls.find(
        ([ref]) => ref.path === episodePath(UID, '1396', 's01e002'),
      )?.[1] as EpisodeWriteLike;
      expect(e2).toBeTruthy();
      expect(e2.episode).toBe(2);
      expect(e2.title).toBe('Cat in the Bag');
      expect(e2.watched).toBe(false);
      expect(e2.watchedAt).toBeNull();
    });

    it('insert-only: an existing watched s01e001 is NOT re-created; only the missing s01e002 is setDoc', async () => {
      seedFirestore({
        watchlist: { '1396': 'watching' },
        episodes: { '1396/s01e001': { watched: true } },
      });
      routeTmdbTv({ seasonCount: 1, seasons: { 1: [rawEp(1), rawEp(2)] } });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
            { season: 1, episode: 2, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      // The already-present watched doc is never re-created (its watched:true
      // survives — no create clobbers it).
      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
        ),
      ).toBe(false);
      // Only the genuinely-missing id is created.
      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === episodePath(UID, '1396', 's01e002'),
        ),
      ).toBe(true);
    });

    it('skips existing ids: the create diff excludes any id already in the episodes subcollection', async () => {
      seedFirestore({
        watchlist: { '1396': 'watching' },
        episodes: { '1396/s01e002': { watched: false } },
      });
      routeTmdbTv({
        seasonCount: 1,
        seasons: { 1: [rawEp(1), rawEp(2), rawEp(3)] },
      });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 3, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      const created = setDocMock.mock.calls
        .filter(([ref]) => ref.path.includes('/1396/episodes/'))
        .map(([ref]) => ref.path.split('/').pop());
      expect(created).toContain('s01e001');
      expect(created).toContain('s01e003');
      expect(created).not.toContain('s01e002'); // already present → skipped
    });

    it('null-air_date episode is skipped (no doc created for it)', async () => {
      seedFirestore({ watchlist: { '1396': 'watching' }, episodes: {} });
      routeTmdbTv({
        seasonCount: 1,
        seasons: {
          1: [
            rawEp(1, { air_date: '2008-01-20' }),
            rawEp(2, { air_date: null }),
          ],
        },
      });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
        ),
      ).toBe(true);
      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === episodePath(UID, '1396', 's01e002'),
        ),
      ).toBe(false);
    });

    it('gap-guard: NO TMDB fetch (or episode setDoc) when all watched Plex episodes already have local docs', async () => {
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
            { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      // No backfill (posterPath non-null) and no ensure fetch → no TMDB call.
      expect(tmdbFetchMock).not.toHaveBeenCalled();
      expect(
        setDocMock.mock.calls.some(([ref]) => ref.path.includes('/episodes/')),
      ).toBe(false);
    });

    it('gap-guard: fetches TMDB + creates the doc only when a watched Plex episode lacks a local doc', async () => {
      seedFirestore({ watchlist: { '1396': 'watching' }, episodes: {} });
      routeTmdbTv({ seasonCount: 1, seasons: { 1: [rawEp(1)] } });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      expect(tmdbFetchMock).toHaveBeenCalled();
      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
        ),
      ).toBe(true);
    });

    it('mirror-after-create: the created s01e001 is updateDoc watched:true with watchedAt from lastViewedAt', async () => {
      const lastViewed = new Date(Date.now() - 3 * 60_000).toISOString();
      seedFirestore({ watchlist: { '1396': 'watching' }, episodes: {} });
      routeTmdbTv({ seasonCount: 1, seasons: { 1: [rawEp(1), rawEp(2)] } });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: lastViewed },
            { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      const e1 = updateDocMock.mock.calls.find(
        ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
      )?.[1] as { watched: boolean; watchedAt: Date | null };
      expect(e1.watched).toBe(true);
      expect(e1.watchedAt).toBeInstanceOf(Date);
    });

    it('status: a tracked planned show with a created+watched episode reaches watching', async () => {
      seedFirestore({ watchlist: { '1396': 'planned' }, episodes: {} });
      routeTmdbTv({ seasonCount: 1, seasons: { 1: [rawEp(1), rawEp(2)] } });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
            { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
          ],
        }),
      );
      const summary = await syncOk(service);

      expect(summary.updated).toBe(1);
      const statusWrite = updateDocMock.mock.calls.find(
        ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
      );
      expect((statusWrite?.[1] as { status: string }).status).toBe('watching');
    });

    it('status: a tracked watching show with ALL created episodes watched reaches completed', async () => {
      seedFirestore({ watchlist: { '1396': 'watching' }, episodes: {} });
      routeTmdbTv({ seasonCount: 1, seasons: { 1: [rawEp(1), rawEp(2)] } });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
            { season: 1, episode: 2, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      const summary = await syncOk(service);

      expect(summary.updated).toBe(1);
      const statusWrite = updateDocMock.mock.calls.find(
        ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
      );
      expect((statusWrite?.[1] as { status: string }).status).toBe('completed');
    });

    it('sticky-dropped: still creates + mirrors episode docs but writes NO status change', async () => {
      seedFirestore({ watchlist: { '1396': 'dropped' }, episodes: {} });
      routeTmdbTv({ seasonCount: 1, seasons: { 1: [rawEp(1), rawEp(2)] } });
      const service = makeService(
        mockClient([tvItem(1396, { viewCount: 1 })], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
            { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
          ],
        }),
      );
      const summary = await syncOk(service);

      // Docs created …
      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
        ),
      ).toBe(true);
      // … and mirrored to watched:true …
      const e1 = updateDocMock.mock.calls.find(
        ([ref]) => ref.path === episodePath(UID, '1396', 's01e001'),
      )?.[1] as { watched: boolean };
      expect(e1.watched).toBe(true);
      // … but NO status write (dropped is sticky).
      expect(
        updateDocMock.mock.calls.some(
          ([ref]) => ref.path === watchlistItemPath(UID, '1396'),
        ),
      ).toBe(false);
      expect(summary.updated).toBe(0);
    });

    it('TMDB-failure isolation: a rejecting season fetch keeps sync ok, creates no docs, and the rest of the loop runs', async () => {
      seedFirestore({ watchlist: { '1396': 'planned' } });
      tmdbFetchMock.mockRejectedValue(new Error('network down'));
      const service = makeService(
        mockClient([tvItem(1396), movieItem(603, { viewCount: 1 })], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      const result = await service.sync();

      expect(result.status).toBe('ok');
      // No episode docs created for the failing show.
      expect(
        setDocMock.mock.calls.some(([ref]) =>
          ref.path.includes('/1396/episodes/'),
        ),
      ).toBe(false);
      // The rest of the loop still ran: the watched untracked movie was added.
      expect(
        setDocMock.mock.calls.some(
          ([ref]) => ref.path === watchlistItemPath(UID, '603'),
        ),
      ).toBe(true);
    });

    it('null season count: a real gap but TMDB reports no season count → nothing created', async () => {
      seedFirestore({ watchlist: { '1396': 'planned' }, episodes: {} });
      routeTmdbTv({ seasonCount: null });
      const service = makeService(
        mockClient([tvItem(1396)], {
          'rk-1396': [
            { season: 1, episode: 1, viewCount: 1, lastViewedAt: null },
          ],
        }),
      );
      await syncOk(service);

      expect(
        setDocMock.mock.calls.some(([ref]) => ref.path.includes('/episodes/')),
      ).toBe(false);
    });
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
