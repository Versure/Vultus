/**
 * Automated, emulator-backed integration test for the `syncTitles` flow
 * (spec 0009, Test plan "Automated emulator integration gate").
 *
 * It wires the REAL `createSyncEngine` to the REAL
 * `createFirestoreTitleCacheStore(db)` + the REAL `collectionGroup('watchlist')`
 * gather + the REAL `runSync` handler core, against a REAL Firestore emulator.
 * Only the TMDB/Trakt HTTP transport is faked (plain objects implementing the
 * `TmdbClient` / `TraktClient` method shapes) — there is NO live network and NO
 * secret: the engine never constructs the real `createTmdbClient` /
 * `createTraktClient`, so no read token / client id is needed.
 *
 * This suite is EXCLUDED from the default `nx test functions` run (see
 * `vite.config.mts`'s `exclude`) and runs only via the dedicated
 * `test-integration` target behind the emulator. It additionally guards on
 * `FIRESTORE_EMULATOR_HOST` so that, even if the default runner ever picked it
 * up, it self-skips rather than hanging trying to reach a missing emulator.
 *
 * The Firestore emulator (a Java NIO loopback server) CANNOT run under the
 * Claude Code tools in this environment (loopback blocked) — so this test is
 * verified locally in the user's terminal and in CI, not in the agent session.
 * The intended invocation is:
 *
 *   pnpm exec firebase emulators:exec --only firestore --project vultus-cab62 \
 *     "pnpm nx test-integration functions"
 *
 * `firebase emulators:exec` sets `FIRESTORE_EMULATOR_HOST` (e.g. 127.0.0.1:8080)
 * for the wrapped command; the Admin SDK then talks to the emulator with no
 * credentials.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { App } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  RegionAvailability,
  TitleCacheEntry,
  TitleMetadata,
  TitleType,
  WatchProvider,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  dataToAvailability,
  dataToTitleCache,
  titleCacheDocPath,
  watchlistItemPath,
  watchlistItemToData,
  type RegionAvailabilityReadData,
  type TitleCacheReadData,
} from '@vultus/shared/firestore-schema';
import {
  createFirestoreTitleCacheStore,
  createSyncEngine,
} from '@vultus/functions/sync-titles';
import type {
  RegionProviders,
  SyncEngine,
  TmdbClient,
  TraktClient,
} from '@vultus/functions/sync-titles';
import { runSync, type RunSyncDeps, type SyncRunResponse } from './main';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'vultus-cab62';
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const SECRET = 'integration-cron-secret';

// --- Canned TMDB/Trakt data, controllable per pass so test (c) can mutate
// providers between two sequential runs. ---

/** A movie (tmdbId 603) and a tv show (tmdbId 1396) seeded across users. */
const MOVIE_ID = 603;
const TV_ID = 1396;
const TV_TRAKT_ID = 1390; // what the fake getShowTraktId resolves the tv to.

const MOVIE_META: TitleMetadata = {
  title: 'The Matrix',
  overview: 'A hacker learns the truth.',
  posterPath: '/matrix.jpg',
  releaseDate: '1999-03-31',
};
const TV_META: TitleMetadata = {
  title: 'Breaking Bad',
  overview: 'A teacher turns to crime.',
  posterPath: '/bb.jpg',
  releaseDate: '2008-01-20',
};

const NETFLIX: WatchProvider = {
  providerId: 8,
  name: 'Netflix',
  type: 'flatrate',
};
const PRIME: WatchProvider = {
  providerId: 9,
  name: 'Amazon Prime Video',
  type: 'flatrate',
};

/** Mutable holder so test (c) can change the providers returned per pass. */
interface FakeState {
  providersByTmdbId: Record<number, RegionProviders | null>;
}

/** Plain object implementing the TmdbClient shape — NO network. */
function fakeTmdb(state: FakeState): TmdbClient {
  return {
    getMovie: (tmdbId) =>
      Promise.resolve(tmdbId === MOVIE_ID ? MOVIE_META : null),
    getTvShow: (tmdbId) => Promise.resolve(tmdbId === TV_ID ? TV_META : null),
    getWatchProviders: (tmdbId: number) =>
      Promise.resolve(state.providersByTmdbId[tmdbId] ?? null),
    // Not exercised by the sync engine (episodes are out of scope) — present to
    // satisfy the TmdbClient shape.
    getSeasonEpisodes: () => Promise.resolve(null),
  };
}

/** Plain object implementing the TraktClient shape — NO network. tv → a number,
 *  everything else → null (movies never call this). */
function fakeTrakt(): TraktClient {
  return {
    getCalendar: () => Promise.resolve([]),
    getShowTraktId: (tmdbId) =>
      Promise.resolve(tmdbId === TV_ID ? TV_TRAKT_ID : null),
  };
}

/** Deterministic clock for the engine + the handler (epoch ms / ISO). */
const NOW_MS = Date.parse('2026-06-19T12:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

function makeDeps(db: Firestore, state: FakeState): RunSyncDeps {
  return {
    db,
    createEngine: (firestore): SyncEngine =>
      createSyncEngine({
        tmdb: fakeTmdb(state),
        trakt: fakeTrakt(),
        store: createFirestoreTitleCacheStore(firestore),
        now: () => NOW_ISO,
      }),
    // No user-token path is exercised here; cron path uses the secret only.
    verifyToken: () => Promise.reject(new Error('not used')),
    secret: SECRET,
    now: () => NOW_MS,
    rateLimitMs: 5 * 60 * 1000,
    stalenessWindowMs: 20 * 60 * 60 * 1000,
  };
}

/** A cron request with the shared secret; `force` keeps the staleness filter
 *  from dropping the already-synced titles between passes. */
function cronReq(force = true) {
  return {
    method: 'POST',
    headers: { 'x-vultus-sync-secret': SECRET },
    body: { force },
  };
}

function seedWatchlistItem(
  db: Firestore,
  userId: string,
  titleId: string,
  type: TitleType,
  tmdbId: number,
): Promise<FirebaseFirestore.WriteResult> {
  return db.doc(watchlistItemPath(userId, titleId)).set(
    watchlistItemToData({
      type,
      tmdbId,
      traktId: null,
      title: titleId,
      addedAt: NOW_ISO,
      status: 'watching',
    }),
  );
}

/** Recursively delete every doc under the collections the flow touches so the
 *  four assertions are independent. */
async function clearAll(db: Firestore): Promise<void> {
  await db.recursiveDelete(db.collection('users'));
  await db.recursiveDelete(db.collection('title-cache'));
  await db.recursiveDelete(db.collection('system'));
}

describe.skipIf(!EMULATOR)(
  'syncTitles integration (Firestore emulator)',
  () => {
    let app: App;
    let db: Firestore;
    let state: FakeState;

    beforeAll(() => {
      // When FIRESTORE_EMULATOR_HOST is set (the suite only runs then), the
      // Admin SDK targets the emulator with no credentials — projectId only.
      app =
        getApps().length > 0
          ? getApps()[0]
          : initializeApp({ projectId: PROJECT_ID });
      db = getFirestore(app);
    });

    afterAll(async () => {
      await deleteApp(app);
    });

    beforeEach(async () => {
      await clearAll(db);
      state = {
        providersByTmdbId: {
          [MOVIE_ID]: { NL: [NETFLIX] },
          [TV_ID]: { NL: [NETFLIX] },
        },
      };
    });

    // (a) Gather + dedupe across users.
    it('gathers + dedupes the watchlist across users (a shared title syncs once)', async () => {
      // u1 and u2 both track the same movie 603; u2 also tracks tv 1396.
      await seedWatchlistItem(db, 'u1', 'm603', 'movie', MOVIE_ID);
      await seedWatchlistItem(db, 'u2', 'm603', 'movie', MOVIE_ID);
      await seedWatchlistItem(db, 'u2', 't1396', 'tv', TV_ID);

      const out = await runSync(makeDeps(db, state), cronReq());
      const body = out.body as SyncRunResponse;

      expect(out.status).toBe(200);
      // Two DISTINCT titles gathered (603 deduped from two users).
      expect(body.gathered).toBe(2);
      expect(body.synced).toBe(2);

      // The shared movie was written exactly once.
      const movieSnap = await db.doc(titleCacheDocPath(MOVIE_ID)).get();
      expect(movieSnap.exists).toBe(true);
    });

    // (b) Real converter round-trip incl. traktId (number for tv, null for movie).
    it('round-trips title-cache + availability through the spec-0005 converters', async () => {
      await seedWatchlistItem(db, 'u1', 'm603', 'movie', MOVIE_ID);
      await seedWatchlistItem(db, 'u1', 't1396', 'tv', TV_ID);

      await runSync(makeDeps(db, state), cronReq());

      // Movie entry: traktId null.
      const movieSnap = await db.doc(titleCacheDocPath(MOVIE_ID)).get();
      const movieEntry = dataToTitleCache(
        movieSnap.data() as TitleCacheReadData,
      );
      const expectedMovie: TitleCacheEntry = {
        type: 'movie',
        traktId: null,
        metadata: MOVIE_META,
        lastSyncedAt: NOW_ISO,
      };
      expect(movieEntry).toEqual(expectedMovie);

      // Tv entry: traktId resolved to a number via the fake getShowTraktId.
      const tvSnap = await db.doc(titleCacheDocPath(TV_ID)).get();
      const tvEntry = dataToTitleCache(tvSnap.data() as TitleCacheReadData);
      const expectedTv: TitleCacheEntry = {
        type: 'tv',
        traktId: TV_TRAKT_ID,
        metadata: TV_META,
        lastSyncedAt: NOW_ISO,
      };
      expect(tvEntry).toEqual(expectedTv);

      // Availability round-trip (NL → Netflix), previousSnapshot empty on first pass.
      const availSnap = await db.doc(availabilityDocPath(MOVIE_ID, 'NL')).get();
      const avail = dataToAvailability(
        availSnap.data() as RegionAvailabilityReadData,
      );
      const expectedAvail: RegionAvailability = {
        providers: [NETFLIX],
        previousSnapshot: [],
        lastSyncedAt: NOW_ISO,
      };
      expect(avail).toEqual(expectedAvail);
    });

    // (c) Snapshot roll across two sequential passes.
    it('rolls pass 1 providers into previousSnapshot on pass 2', async () => {
      await seedWatchlistItem(db, 'u1', 'm603', 'movie', MOVIE_ID);

      // Pass 1: NL = [Netflix].
      state.providersByTmdbId[MOVIE_ID] = { NL: [NETFLIX] };
      await runSync(makeDeps(db, state), cronReq());

      // Pass 2: NL = [Prime] — providers change between passes.
      state.providersByTmdbId[MOVIE_ID] = { NL: [PRIME] };
      await runSync(makeDeps(db, state), cronReq());

      const availSnap = await db.doc(availabilityDocPath(MOVIE_ID, 'NL')).get();
      const avail = dataToAvailability(
        availSnap.data() as RegionAvailabilityReadData,
      );

      // Pass 2 current providers = Prime; previousSnapshot = pass 1's Netflix.
      expect(avail.providers).toEqual([PRIME]);
      expect(avail.previousSnapshot).toEqual([NETFLIX]);
    });

    // (d) Boundary, for real: no users/** mutated, system/sync written.
    it('writes no users/** doc and updates system/sync', async () => {
      await seedWatchlistItem(db, 'u1', 'm603', 'movie', MOVIE_ID);
      await seedWatchlistItem(db, 'u2', 't1396', 'tv', TV_ID);

      // Capture the seeded watchlist docs verbatim before the run.
      const beforeU1 = (
        await db.doc(watchlistItemPath('u1', 'm603')).get()
      ).data();
      const beforeU2 = (
        await db.doc(watchlistItemPath('u2', 't1396')).get()
      ).data();

      await runSync(makeDeps(db, state), cronReq());

      // The seeded watchlist docs are unchanged.
      expect(
        (await db.doc(watchlistItemPath('u1', 'm603')).get()).data(),
      ).toEqual(beforeU1);
      expect(
        (await db.doc(watchlistItemPath('u2', 't1396')).get()).data(),
      ).toEqual(beforeU2);

      // No extra docs under any user beyond the two seeded watchlist docs: each
      // user has exactly one watchlist doc and no notifications/other writes.
      const u1Watchlist = await db.collectionGroup('watchlist').get();
      expect(u1Watchlist.size).toBe(2);
      const notifications = await db.collectionGroup('notifications').get();
      expect(notifications.size).toBe(0);

      // system/sync WAS updated with a lastRunAt.
      const syncSnap = await db.doc('system/sync').get();
      expect(syncSnap.exists).toBe(true);
      expect((syncSnap.data() as { lastRunAt?: number }).lastRunAt).toBe(
        NOW_MS,
      );
    });
  },
);
