/**
 * The episode-aired airing-scan (spec 0089 / D3, Defect 2; sharded by spec 0101).
 *
 * Since spec 0101 the scan is one of the nightly pipeline's Cloud Tasks stages:
 * `airingScanWorker` (`onTaskDispatched`) runs the scan over a SHARD of uids (the
 * shard's `uids`, supplied by the coordinator's single consolidated gather — this
 * is what eliminates the pre-0101 third full `collectionGroup('watchlist')` scan).
 * `runEpisodeAiredScan` therefore takes a `uids` subset and RE-READS each uid's
 * watchlist docs for per-title status/title within its shard.
 *
 * It reads each tracked TV show's already-inserted episode docs and emits an
 * `episode-aired` notification for every episode whose `airDate` has crossed into
 * the recent window (`[now - EPISODE_RECENCY_WINDOW_DAYS, now]`) and that has not
 * already been notified. It reuses the per-user decision machinery in
 * `@vultus/functions/dispatch-notifications` (status/prefs/recency/flatrate gates,
 * delivery-window FCM, token prune, per-episode idempotency via
 * `NotificationStore.exists`) and the spec-0100 indexed tracking-user lookups.
 *
 * Why a scan, not an `onDocumentCreated` trigger: episodes are inserted with their
 * TMDB-scheduled (often future) `airDate` and never re-created, so a creation
 * trigger would fire once at insert time with `airDate > now` (rejected by the
 * window) and never fire again on the day it actually airs (Defect 2). The scan is
 * driven by the airing, not the doc creation.
 *
 * The core (`runEpisodeAiredScan` / `runAiringScanShard`) is SDK-agnostic via
 * injected `db`/`messaging`/deps so it is unit-testable without the SDK, network,
 * or secrets — mirroring `dispatch-notifications.ts` and the other shard workers.
 * `airingScanWorker` makes ZERO TMDB calls (Firestore + FCM only) so it binds NO
 * secrets. It does NOT import `@vultus/functions/sync-episodes`; it reads episode
 * docs directly via the Admin SDK (Sheriff rule 3).
 */
import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import type { Messaging } from 'firebase-admin/messaging';
import {
  createNotificationDispatcher,
  hasFlatrate,
  isEpisodeRecentlyAired,
  EPISODE_RECENCY_WINDOW_DAYS,
} from '@vultus/functions/dispatch-notifications';
import type { EpisodeAiredChange } from '@vultus/functions/dispatch-notifications';
import {
  availabilityDocPath,
  dataToEpisode,
  episodesPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type { EpisodeReadData } from '@vultus/shared/firestore-schema';
import type {
  FcmToken,
  NotificationPrefs,
  Region,
  TitleType,
  WatchProvider,
  WatchStatus,
} from '@vultus/shared/domain';
import {
  createFirestoreNotificationStore,
  createFirestoreWatchlistStore,
  createMessagingFcmSender,
} from './dispatch/adapters';
import { recordShardResult } from './lib/sync-run-tracker';
import type {
  RecordShardResultOutcome,
  RecordShardResultParams,
} from './lib/sync-run-tracker';
import type { AiringScanTask } from './lib/task-queue';

// Initialize the Admin SDK eagerly at module load, not lazily inside the task
// handler — see main.ts for why (a cold-start race can otherwise leave
// getFirestore()/getMessaging() called before initializeApp() ran).
if (getApps().length === 0) {
  initializeApp();
}

function ensureAdminForAiringScan(): { db: Firestore; messaging: Messaging } {
  return { db: getFirestore(), messaging: getMessaging() };
}

/** Cap an accumulating shard-error list at the staging-doc limit (≤10). */
const SHARD_ERROR_CAP = 10;

/** A tracked TV show gathered from the `watchlist` collection group. */
interface TrackedShow {
  uid: string;
  titleId: string;
  tmdbId: number;
  status: WatchStatus;
  title: string;
}

/** The subset of a `users/{uid}` doc the scan reads. */
interface UserDoc {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
}

/** Aggregate outcome of one airing-scan pass over a shard's uids. */
export interface AiringScanResult {
  /** Episodes for which an `episode-aired` dispatch was attempted (== synced). */
  dispatched: number;
  /** Per-uid / per-show / per-episode errors caught (isolated, not fatal). */
  errored: number;
  /** Capped (≤10), credential-free error reasons for the shard subdoc. */
  errors: string[];
}

/**
 * Core airing-scan flow over a SUBSET of `uids`, SDK-agnostic via injected `db` +
 * `messaging` (spec 0101). For each uid it RE-READS that uid's own watchlist
 * collection (`users/{uid}/watchlist`) — NOT a full `collectionGroup('watchlist')`
 * gather — filters to `type === 'tv'`, and scans each show's episodes. Writes ONLY
 * `users/{uid}/notifications/**` (via the dispatcher) and prunes only
 * `users/{uid}.fcmTokens` — never `title-cache`, `sync-runs`, or `system`.
 *
 * Per-uid error isolation: a failure reading one uid's watchlist (or dispatching
 * one of its episodes) is caught, counted, and does not abort the rest of the
 * shard — so `runAiringScanShard` can always record an accurate shard result and
 * the stage still reaches `shardCount`. Returns the aggregate counters.
 */
export async function runEpisodeAiredScan(
  db: Firestore,
  messaging: Messaging,
  uids: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<AiringScanResult> {
  // Shared, title-independent adapters (built once). The FCM sender/dispatcher
  // are built PER-TITLE below so each episode's OS-notification body carries its
  // own show name (NB4).
  const notifications = createFirestoreNotificationStore(db);
  const watchlist = createFirestoreWatchlistStore(db);

  let dispatched = 0;
  let errored = 0;
  const errors: string[] = [];
  const recordError = (message: string) => {
    errored++;
    if (errors.length < SHARD_ERROR_CAP) errors.push(message);
  };

  // Caches across shows: user docs per uid, availability hasFlatrate per
  // (tmdbId, region). A `null` cache entry means "read, and it did not exist".
  const userCache = new Map<string, UserDoc | null>();
  const flatrateCache = new Map<string, boolean>();

  async function readUser(uid: string): Promise<UserDoc | null> {
    if (userCache.has(uid)) return userCache.get(uid) ?? null;
    const userSnap = await db.doc('users/' + uid).get();
    const data = userSnap.exists
      ? (userSnap.data() as
          | {
              region?: Region;
              notificationPrefs?: NotificationPrefs;
              fcmTokens?: FcmToken[];
            }
          | undefined)
      : undefined;
    const user: UserDoc | null =
      data?.region && data.notificationPrefs
        ? {
            region: data.region,
            notificationPrefs: data.notificationPrefs,
            fcmTokens: data.fcmTokens ?? [],
          }
        : null;
    userCache.set(uid, user);
    return user;
  }

  async function readHasFlatrate(
    tmdbId: number,
    region: Region,
  ): Promise<boolean> {
    const key = `${tmdbId}::${region}`;
    const cached = flatrateCache.get(key);
    if (cached !== undefined) return cached;
    const availSnap = await db.doc(availabilityDocPath(tmdbId, region)).get();
    const providers = availSnap.exists
      ? ((availSnap.data() as { providers?: WatchProvider[] } | undefined)
          ?.providers ?? [])
      : [];
    const result = hasFlatrate(providers);
    flatrateCache.set(key, result);
    return result;
  }

  for (const uid of uids) {
    let shows: TrackedShow[];
    try {
      // 1. RE-READ this uid's OWN watchlist collection (subset scan — NOT a full
      //    `collectionGroup('watchlist')` gather); in-memory filter to `type ===
      //    'tv'`. The doc id is the titleId; the uid is known from the shard.
      const wlSnap = await db.collection(watchlistPath(uid)).get();
      shows = [];
      for (const doc of wlSnap.docs) {
        const data = doc.data() as {
          tmdbId?: number;
          type?: TitleType;
          status?: WatchStatus;
          title?: string;
        };
        if (data.type !== 'tv') continue;
        if (typeof data.tmdbId !== 'number') continue;
        shows.push({
          uid,
          titleId: doc.id,
          tmdbId: data.tmdbId,
          // legacy/malformed doc missing status → notifiable (spec 0088)
          status: data.status ?? 'watching',
          title: data.title ?? '',
        });
      }
    } catch (err) {
      recordError(
        err instanceof Error ? err.message : `watchlist read failed for ${uid}`,
      );
      logger.error('[episodeAiredScan] failed reading watchlist (continuing)', {
        uid,
        err,
      });
      continue;
    }

    for (const show of shows) {
      try {
        const user = await readUser(show.uid);
        if (!user) continue;

        // 2. Read the show's episodes; convert each stored `airDate` Timestamp →
        //    ISO via `dataToEpisode` (NB5 — NOT a raw `data.airDate` read), then
        //    filter to the recency window before any per-episode work.
        const episodesSnap = await db
          .collection(episodesPath(show.uid, show.titleId))
          .get();
        const recent = episodesSnap.docs
          .map((d) => ({
            episodeId: d.id,
            airDate: dataToEpisode(d.data() as EpisodeReadData).airDate,
          }))
          .filter((e) =>
            isEpisodeRecentlyAired(
              e.airDate,
              now(),
              EPISODE_RECENCY_WINDOW_DAYS,
            ),
          );

        if (recent.length === 0) continue;

        // 3. hasFlatrate in the user's region (cached per tmdbId+region).
        const hasFlatrateNow = await readHasFlatrate(show.tmdbId, user.region);

        // 4. Per-title dispatcher: the FCM sender binds this show's title so the
        //    OS-rendered body names the right show (NB4).
        const dispatcher = createNotificationDispatcher({
          watchlist,
          notifications,
          fcm: createMessagingFcmSender(messaging, show.title),
          now,
        });

        for (const ep of recent) {
          const change: EpisodeAiredChange = {
            tmdbId: show.tmdbId,
            region: user.region,
            uid: show.uid,
            titleId: show.titleId,
            status: show.status,
            notificationPrefs: user.notificationPrefs,
            fcmTokens: user.fcmTokens,
            episodeId: ep.episodeId,
            airDate: ep.airDate,
            hasFlatrateNow,
          };
          try {
            await dispatcher.dispatchEpisodeAired(change);
            dispatched++;
          } catch (err) {
            recordError(
              err instanceof Error
                ? err.message
                : `dispatch failed for ${show.uid}/${show.titleId}/${ep.episodeId}`,
            );
            logger.error('[episodeAiredScan] dispatch failed for episode', {
              uid: show.uid,
              titleId: show.titleId,
              episodeId: ep.episodeId,
              err,
            });
          }
        }
      } catch (err) {
        recordError(
          err instanceof Error
            ? err.message
            : `scan failed for ${show.uid}/${show.titleId}`,
        );
        logger.error('[episodeAiredScan] failed for show (continuing)', {
          uid: show.uid,
          titleId: show.titleId,
          err,
        });
      }
    }
  }

  return { dispatched, errored, errors };
}

/** Dependencies injected into `runAiringScanShard` (fakes in tests). */
export interface RunAiringScanShardDeps {
  /** Clock in epoch ms; injected for deterministic shard timing. */
  now: () => number;
  /** Run the aired scan over the shard's uids (`runEpisodeAiredScan` bound to the
   *  Admin SDK `db`/`messaging` in prod; a fake in tests). */
  scan: (uids: readonly string[]) => Promise<AiringScanResult>;
  /** Record this shard's result (`recordShardResult` bound to `db` in prod). */
  recordShard: (
    params: RecordShardResultParams,
  ) => Promise<RecordShardResultOutcome>;
}

/**
 * Airing-scan shard worker core (spec 0101). Runs the aired scan over the shard's
 * `uids` (per-uid error isolation lives in `runEpisodeAiredScan`), then ALWAYS
 * records the shard result under stage `airingScan`. A whole-shard failure (the
 * scan throwing before it could isolate) is CAUGHT and recorded as fully-errored —
 * the task does not crash — so the stage still reaches its `shardCount` and the run
 * can finalize with accurate error counts (an uncaught infra loss is the watchdog's
 * concern, spec 0101 Risks).
 *
 * `airingScan` is a TERMINAL stage: finalization (writing the `sync-runs/{runId}`
 * summary + flipping `finalized`) is handled INSIDE `recordShardResult`'s barrier
 * transaction once every stage is complete — this worker makes NO explicit finalize
 * call and enqueues nothing downstream.
 */
export async function runAiringScanShard(
  deps: RunAiringScanShardDeps,
  task: AiringScanTask,
): Promise<void> {
  const start = deps.now();

  let synced = 0;
  let errored = 0;
  let errors: string[] = [];
  try {
    const result = await deps.scan(task.uids);
    synced = result.dispatched;
    errored = result.errored;
    errors = result.errors;
  } catch (err) {
    // Whole-shard failure → record as fully-errored (do NOT crash the task) so
    // the stage still advances and the run finalizes with an accurate count.
    errored = task.uids.length;
    errors = [err instanceof Error ? err.message : 'airing scan shard failed'];
    logger.error('[airingScanWorker] shard failed (recorded as errored)', {
      runId: task.runId,
      shardIndex: task.shardIndex,
    });
  }

  await deps.recordShard({
    runId: task.runId,
    stage: 'airingScan',
    shardIndex: task.shardIndex,
    startedAt: start,
    completedAt: deps.now(),
    synced,
    skipped: 0,
    errored,
    errors,
  });
}

/**
 * The deployable `airing-scan` shard worker (spec 0101, `onTaskDispatched`). The
 * backing Cloud Tasks queue is auto-created on deploy with the code-declared
 * `rateLimits`/`retryConfig` below — the queue name equals this FUNCTION name
 * (`airingScanWorker`, see `QUEUE_NAMES.airingScan`). Makes ZERO TMDB calls
 * (Firestore + FCM only) so it binds NO secrets. Concurrency 20; the run is
 * finalized by the terminal barrier in `recordShardResult` once both terminal
 * stages (`episodeFanout` + `airingScan`) have drained.
 */
export const airingScanWorker = onTaskDispatched<AiringScanTask>(
  {
    // Explicit — this module's top-level `onTaskDispatched` call runs before
    // `main.ts`'s `setGlobalOptions({ region: 'europe-west1' })` (ES module
    // import hoisting: `main.ts`'s `export { airingScanWorker } from
    // './dispatch-episode-aired'` evaluates this module first). Without this,
    // the function silently falls back to the SDK default region
    // (us-central1), stranding it outside the `europe-west1` queue set.
    region: 'europe-west1',
    retryConfig: {
      maxAttempts: 3,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxRetrySeconds: 3600,
    },
    rateLimits: { maxConcurrentDispatches: 20 },
    maxInstances: 20,
    timeoutSeconds: 540,
  },
  async (request) => {
    const { db, messaging } = ensureAdminForAiringScan();
    await runAiringScanShard(
      {
        now: () => Date.now(),
        scan: (uids) => runEpisodeAiredScan(db, messaging, uids),
        recordShard: (params) => recordShardResult(db, params),
      },
      request.data,
    );
  },
);
