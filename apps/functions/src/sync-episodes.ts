/**
 * Episode-sync wiring (spec 0047). This file is the ONLY place where the Admin
 * SDK + the sync-titles `TmdbClient` enter the episode-sync flow: it implements
 * the `@vultus/functions/sync-episodes` ports against firebase-admin Firestore
 * and the TMDB client, and exposes the on-add trigger (entry point A). The
 * daily-sync extension (entry point B) reuses these adapters from `main.ts`.
 *
 * The engine itself stays Firebase-free and never imports `slice:sync-titles`.
 */
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { createTmdbClient } from '@vultus/functions/sync-titles';
import type { TmdbClient } from '@vultus/functions/sync-titles';
import {
  createEpisodeSyncEngine,
  createEpisodeCacheEngine,
  type EpisodeCacheEngine,
  type EpisodeStore,
  type EpisodeSyncEngine,
  type TitleCacheEpisodeStore,
  type TmdbEpisodeSource,
  type WatchlistNextWatchableStore,
  type WatchlistStatusStore,
} from '@vultus/functions/sync-episodes';
import {
  cachedEpisodeToData,
  dataToCachedEpisode,
  dataToEpisode,
  episodePath,
  episodesPath,
  episodeToData,
  titleCacheEpisodesPath,
  titleCacheEpisodeDocPath,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import type {
  CachedEpisodeReadData,
  EpisodeReadData,
} from '@vultus/shared/firestore-schema';
import type { Episode, WatchStatus } from '@vultus/shared/domain';
import {
  chunk,
  createTaskEnqueuer,
  shardTaskName,
  QUEUE_NAMES,
  SHARD_SIZE_ASSIGNMENTS,
  SHARD_SIZE_USERS,
} from './lib/task-queue';
import type {
  AiringScanTask,
  EpisodeCacheTask,
  EpisodeFanoutTask,
  SyncStage,
  TaskEnqueuer,
} from './lib/task-queue';
import {
  finalizeHealthyRun,
  readStagedAssignments,
  readStagedUids,
  recordShardResult,
  setStageShardCount,
} from './lib/sync-run-tracker';
import type {
  RecordShardResultOutcome,
  RecordShardResultParams,
} from './lib/sync-run-tracker';

// `TMDB_READ_TOKEN` is a singleton-by-name param: declaring it here with the
// same name as in `main.ts` references the SAME secret (Firebase de-dupes by
// name). The on-add trigger binds it so the runtime injects it.
const TMDB_READ_TOKEN = defineSecret('TMDB_READ_TOKEN');

// Initialize the Admin SDK eagerly at module load, not lazily inside the
// trigger handler — see main.ts for why (a cold-start race can otherwise
// leave getFirestore() called before initializeApp() ran).
if (getApps().length === 0) {
  initializeApp();
}

function ensureAdminForEpisodes(): Firestore {
  return getFirestore();
}

// --- Admin-SDK port adapters --------------------------------------------

/** Bridges the sync-titles `TmdbClient` to the episode engine's read-only
 *  `TmdbEpisodeSource` port. The SDK-free engine never sees the TmdbClient. */
export function createTmdbEpisodeSourceAdapter(
  tmdb: TmdbClient,
): TmdbEpisodeSource {
  return {
    getSeasonCount: (tmdbId) => tmdb.getTvSeasonCount(tmdbId),
    getSeasonEpisodes: (tmdbId, seasonNumber) =>
      tmdb.getSeasonEpisodes(tmdbId, seasonNumber),
  };
}

/**
 * Insert-only episode store over `users/{uid}/watchlist/{titleId}/episodes`.
 * Reads existing doc ids for the engine's diff, then writes ONLY the new docs
 * the engine hands back (batched at the Firestore 500-op limit). Existing docs
 * are never targeted, so a user's `watched`/`watchedAt` state is untouched.
 *
 * Named `createEpisodeUpsertStore` — distinct from the read-only
 * `createFirestoreEpisodeStore` in `dispatch/adapters.ts` (notification flow).
 */
export function createEpisodeUpsertStore(db: Firestore): EpisodeStore {
  const BATCH_SIZE = 500;
  return {
    async getExistingEpisodeIds(uid, titleId): Promise<Set<string>> {
      const snap = await db.collection(episodesPath(uid, titleId)).get();
      return new Set(snap.docs.map((d) => d.id));
    },
    async writeEpisodes(uid, titleId, docs): Promise<void> {
      if (docs.length === 0) return;
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const chunk = docs.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        for (const { id, doc } of chunk) {
          batch.set(db.doc(episodePath(uid, titleId, id)), episodeToData(doc));
        }
        await batch.commit();
      }
    },
  };
}

/**
 * Reads/updates the watchlist doc's `status` for a (uid, titleId) over
 * `users/{uid}/watchlist/{titleId}` (via `watchlistItemPath`). Backs the
 * daily-pass `completed → watching` revert (spec 0074, D5): the engine calls
 * `getStatus` after inserting new episodes and, if the show is `'completed'`,
 * `setStatus(..., 'watching')`. Admin SDK enters ONLY here; the engine stays
 * Firebase-free. Wired into entry point B (main.ts) only — NOT the on-add
 * trigger (entry point A), which needs no revert for a freshly-added show.
 */
export function createWatchlistStatusStoreAdapter(
  db: Firestore,
): WatchlistStatusStore {
  return {
    async getStatus(uid, titleId): Promise<WatchStatus | null> {
      const snap = await db.doc(watchlistItemPath(uid, titleId)).get();
      const data = snap.data() as { status?: WatchStatus } | undefined;
      return data?.status ?? null;
    },
    async setStatus(uid, titleId, status): Promise<void> {
      await db.doc(watchlistItemPath(uid, titleId)).update({ status });
    },
  };
}

/**
 * Reads full episode watch-state and writes the parent watchlist doc's
 * `nextUnwatchedEpisodeAirDate` for a (uid, titleId), backing the sync-episodes
 * `WatchlistNextWatchableStore` port (spec 0081). Admin SDK enters ONLY here; the
 * engine stays Firebase-free. `readEpisodeWatchState` does a fresh full read over
 * the episodes subcollection AFTER `writeEpisodes`, so it sees pre-existing docs'
 * real `watched` state PLUS the just-inserted docs (the id-only
 * `getExistingEpisodeIds` cannot report watched state). Reuses `dataToEpisode` to
 * convert the stored `airDate` Timestamp → ISO string. Wired into BOTH entry
 * points (deliberate deviation from spec 0074's entry-A omission): a freshly-added
 * TV show must get its field set on first sync (entry A) as well as on the daily
 * pass (entry B).
 */
export function createNextWatchableStoreAdapter(
  db: Firestore,
): WatchlistNextWatchableStore {
  return {
    async readEpisodeWatchState(uid, titleId) {
      const snap = await db.collection(episodesPath(uid, titleId)).get();
      return snap.docs.map((d) => {
        const ep = dataToEpisode(d.data() as EpisodeReadData);
        return { airDate: ep.airDate, watched: ep.watched };
      });
    },
    async setNextUnwatchedEpisodeAirDate(uid, titleId, airDate) {
      await db
        .doc(watchlistItemPath(uid, titleId))
        .update({ nextUnwatchedEpisodeAirDate: airDate });
    },
  };
}

/**
 * Admin-SDK adapter for the global episode cache
 * (`title-cache/{tmdbId}/episodes/*`, spec 0101). Backs the fetch-once/fan-out
 * model: `episodeCacheWorker` upserts each distinct show's episodes ONCE per
 * night via `upsertCachedEpisodes`; `episodeFanoutWorker` reads them via
 * `getCachedEpisodes` (no TMDB) and writes the per-user docs. Reads/writes are by
 * document id over `titleCacheEpisodeDocPath(tmdbId, episodeId)`, so upserts are
 * idempotent (a re-run rewrites the same ids). The `lastSyncedAt` stamp is THIS
 * adapter's responsibility (the engine only supplies TMDB facts) — one stamp per
 * upsert call, via `cachedEpisodeToData`. The cache stores ONLY TMDB facts; the
 * per-user `watched`/`watchedAt` never touch it. Admin SDK enters ONLY here; the
 * engine stays Firebase-free.
 */
export function createTitleCacheEpisodeStore(
  db: Firestore,
): TitleCacheEpisodeStore {
  const BATCH_SIZE = 500;
  return {
    async getCachedEpisodes(tmdbId): Promise<Episode[]> {
      const snap = await db.collection(titleCacheEpisodesPath(tmdbId)).get();
      return snap.docs.map((d) => {
        const cached = dataToCachedEpisode(d.data() as CachedEpisodeReadData);
        // Strip the cache-only `lastSyncedAt` back to the bare `Episode` shape.
        return {
          season: cached.season,
          episode: cached.episode,
          title: cached.title,
          airDate: cached.airDate,
        };
      });
    },
    async upsertCachedEpisodes(tmdbId, episodes): Promise<void> {
      if (episodes.length === 0) return;
      // One stamp for the whole upsert — this cache doc was (re)fetched now.
      const lastSyncedAt = new Date().toISOString();
      for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const { id, episode } of episodes.slice(i, i + BATCH_SIZE)) {
          batch.set(
            db.doc(titleCacheEpisodeDocPath(tmdbId, id)),
            cachedEpisodeToData(episode, lastSyncedAt),
          );
        }
        await batch.commit();
      }
    },
  };
}

// --- Entry point A: on-add trigger --------------------------------------

/** The minimal created-doc event shape the core consumes — satisfied by the
 *  real `onDocumentCreated` event and by test fakes. */
export interface WatchlistCreateEvent {
  params: { uid: string; titleId: string };
  data?: {
    data(): Record<string, unknown> | undefined;
  };
}

/**
 * Core of the on-add trigger, engine-injected so it is unit-testable without
 * the SDK, network, or secrets. No-ops on a movie (no episodes) or a malformed
 * doc; otherwise upserts the show's episodes (insert-only via the engine diff).
 */
export async function handleWatchlistCreate(
  event: WatchlistCreateEvent,
  engine: EpisodeSyncEngine,
): Promise<void> {
  const data = event.data?.data() as
    | { type?: string; tmdbId?: number }
    | undefined;
  if (data?.type !== 'tv' || data?.tmdbId == null) return;

  const { uid, titleId } = event.params;
  const tmdbId = data.tmdbId;
  const result = await engine.syncOne(uid, titleId, tmdbId);
  logger.info('[syncWatchlistEpisodes] episode sync complete', result);
}

/**
 * Backfills episodes when a TV title is added to a watchlist. Wires the real
 * Admin SDK + TMDB client into `handleWatchlistCreate`. Best-effort.
 */
export const syncWatchlistEpisodes = onDocumentCreated(
  {
    document: 'users/{uid}/watchlist/{titleId}',
    secrets: [TMDB_READ_TOKEN],
    // Per-function cap (spec 0101 §5): the old global maxInstances:1 is gone.
    // User-driven on-add; bounds any burst to ≤ 20 TMDB req/s worst case.
    maxInstances: 5,
  },
  async (event) => {
    const db = ensureAdminForEpisodes();
    const engine = createEpisodeSyncEngine({
      tmdb: createTmdbEpisodeSourceAdapter(
        createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
      ),
      episodes: createEpisodeUpsertStore(db),
      // Wired on the on-add trigger too (spec 0081 — deliberate deviation from
      // 0074's entry-A omission): a freshly-added TV show must get its
      // nextUnwatchedEpisodeAirDate set on its first episode sync, not 24h later.
      nextWatchable: createNextWatchableStoreAdapter(db),
    });
    const snap = event.data;
    await handleWatchlistCreate(
      {
        params: event.params,
        data: snap ? { data: () => snap.data() } : undefined,
      },
      engine,
    );
  },
);

// --- Entry point B': sharded fetch-once cache + per-user fan-out (spec 0101) ---
//
// The old per-user `syncAll` (O(users × shows) TMDB calls) is replaced by two
// sharded stages that run under Cloud Tasks queue rate limits:
//   1. `episodeCacheWorker` — fetch each distinct show's episodes from TMDB ONCE
//      into the global cache; when its last shard drains it enqueues the parallel
//      terminal stages (`episodeFanout` + `airingScan`).
//   2. `episodeFanoutWorker` — read the cache (ZERO TMDB) and write per-user docs.
// The stage-barrier finalization lives in `sync-run-tracker.recordShardResult`.

/** Cap an accumulating error list at the staging-doc limit (≤10). */
const SHARD_ERROR_CAP = 10;

/** Dependencies injected into `runEpisodeCacheShard` (fakes in tests). */
export interface RunEpisodeCacheShardDeps {
  db: Firestore;
  /** Builds a cache-only engine (`cache` + `tmdb`, NO per-user `episodes`). */
  createEngine: (db: Firestore) => EpisodeCacheEngine;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
  /** Record this shard's result (tracker.recordShardResult bound to db). */
  recordShard: (
    params: RecordShardResultParams,
  ) => Promise<RecordShardResultOutcome>;
  /** Called ONCE on the shard that completes the episode-cache stage: enqueue the
   *  parallel `episodeFanout` + `airingScan` terminal stages. */
  onLastShard: (runId: string) => Promise<void>;
}

/**
 * Episode-cache shard worker core. Caches each of the shard's distinct shows ONCE
 * into the global `title-cache/{tmdbId}/episodes` store, with PER-SHOW error
 * isolation — a failed show is counted into the shard's error total and never
 * crashes the task, so the stage still reaches `shardCount` and the run finalizes
 * with accurate counts (an uncaught infra loss is the watchdog's concern). ALWAYS
 * records the shard result. On the shard that completes the stage it invokes
 * `onLastShard` (the fan-out/airing cascade).
 */
export async function runEpisodeCacheShard(
  deps: RunEpisodeCacheShardDeps,
  task: EpisodeCacheTask,
): Promise<void> {
  const start = deps.now();
  const engine = deps.createEngine(deps.db);

  let cached = 0;
  let skipped = 0;
  let errored = 0;
  const errors: string[] = [];
  for (const tmdbId of task.shows) {
    try {
      const res = await engine.cacheShowEpisodes(tmdbId);
      if (res.outcome === 'cached') cached++;
      else skipped++;
    } catch (err) {
      errored++;
      if (errors.length < SHARD_ERROR_CAP) {
        errors.push(
          err instanceof Error
            ? err.message
            : `cache failed for show ${tmdbId}`,
        );
      }
      logger.error('[episodeCacheWorker] show errored', {
        runId: task.runId,
        shardIndex: task.shardIndex,
        tmdbId,
      });
    }
  }

  const outcome = await deps.recordShard({
    runId: task.runId,
    stage: 'episodeCache',
    shardIndex: task.shardIndex,
    startedAt: start,
    completedAt: deps.now(),
    synced: cached,
    skipped,
    errored,
    errors,
    counters: { showsCached: cached },
  });

  if (outcome.isLastShardOfStage) {
    await deps.onLastShard(task.runId);
  }
}

/** Dependencies injected into `enqueueFanoutAndAiringStages` (fakes in tests). */
export interface FanoutAiringCascadeDeps {
  enqueuer: TaskEnqueuer;
  /** Read the run's staged TV fan-out assignments (T8-persisted). */
  readStagedAssignments: (
    runId: string,
  ) => Promise<{ uid: string; titleId: string; tmdbId: number }[]>;
  /** Read the run's staged distinct uids (T8-persisted). */
  readStagedUids: (runId: string) => Promise<string[]>;
  /** Set a downstream stage's shard count on the staging doc. */
  setStageShardCount: (
    runId: string,
    stage: SyncStage,
    shardCount: number,
  ) => Promise<void>;
  /** Finalize a run with no per-user work left (tracker.finalizeHealthyRun). */
  finalizeHealthyRun: (runId: string, now: number) => Promise<void>;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
}

/**
 * Enqueue the two PARALLEL terminal stages — `episodeFanout` (per-user cache
 * writes) and `airingScan` (per-uid aired scan) — from the run's staged data.
 * Called by the episode-cache stage's last shard, AND by the title stage's last
 * shard on the no-TV-shows fast path (main.ts). It chunks the staged assignments
 * / uids, sets BOTH stage shard counts BEFORE enqueueing EITHER shard (so a fast
 * terminal shard cannot observe the other stage's count as still-0 and finalize
 * the run prematurely — see `recordShardResult`), then fans the shards out.
 *
 * If there is NO per-user work at all (0 assignments AND 0 uids) no terminal shard
 * will ever run to fire the finalization barrier, so the run is finalized
 * healthily right here — a genuinely complete, zero-per-user-work night.
 */
export async function enqueueFanoutAndAiringStages(
  deps: FanoutAiringCascadeDeps,
  runId: string,
): Promise<void> {
  const [assignments, uids] = await Promise.all([
    deps.readStagedAssignments(runId),
    deps.readStagedUids(runId),
  ]);
  const fanoutShards = chunk(assignments, SHARD_SIZE_ASSIGNMENTS);
  const airingShards = chunk(uids, SHARD_SIZE_USERS);

  await deps.setStageShardCount(runId, 'episodeFanout', fanoutShards.length);
  await deps.setStageShardCount(runId, 'airingScan', airingShards.length);

  if (fanoutShards.length === 0 && airingShards.length === 0) {
    await deps.finalizeHealthyRun(runId, deps.now());
    return;
  }

  for (let i = 0; i < fanoutShards.length; i++) {
    const payload: EpisodeFanoutTask = {
      runId,
      shardIndex: i,
      assignments: fanoutShards[i],
    };
    await deps.enqueuer.enqueue(QUEUE_NAMES.episodeFanout, payload, {
      name: shardTaskName(runId, 'episodeFanout', i),
    });
  }
  for (let i = 0; i < airingShards.length; i++) {
    const payload: AiringScanTask = {
      runId,
      shardIndex: i,
      uids: airingShards[i],
    };
    await deps.enqueuer.enqueue(QUEUE_NAMES.airingScan, payload, {
      name: shardTaskName(runId, 'airingScan', i),
    });
  }
}

/** Dependencies injected into `runEpisodeFanoutShard` (fakes in tests). */
export interface RunEpisodeFanoutShardDeps {
  db: Firestore;
  /** Builds a fan-out engine (`cache` + `episodes`, NO `tmdb` — fan-out is
   *  incapable of a TMDB call by construction). */
  createEngine: (db: Firestore) => EpisodeCacheEngine;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
  /** Record this shard's result (tracker.recordShardResult bound to db). */
  recordShard: (
    params: RecordShardResultParams,
  ) => Promise<RecordShardResultOutcome>;
}

/**
 * Episode-fanout shard worker core. For each of the shard's (uid, titleId, tmdbId)
 * assignments, writes the per-user episode docs FROM THE CACHE (zero TMDB) plus
 * the spec-0074 revert + spec-0081 recompute, with PER-ASSIGNMENT error isolation.
 * ALWAYS records the shard result. Does NOT enqueue anything — the terminal
 * barrier in `recordShardResult` finalizes the run once BOTH `episodeFanout` and
 * `airingScan` have drained.
 */
export async function runEpisodeFanoutShard(
  deps: RunEpisodeFanoutShardDeps,
  task: EpisodeFanoutTask,
): Promise<void> {
  const start = deps.now();
  const engine = deps.createEngine(deps.db);

  let synced = 0;
  let errored = 0;
  let episodesWritten = 0;
  const errors: string[] = [];
  for (const a of task.assignments) {
    try {
      const res = await engine.fanoutUserEpisodes(a.uid, a.titleId, a.tmdbId);
      synced++;
      episodesWritten += res.episodesWritten;
    } catch (err) {
      errored++;
      if (errors.length < SHARD_ERROR_CAP) {
        errors.push(
          err instanceof Error
            ? err.message
            : `fanout failed for ${a.uid}/${a.titleId}`,
        );
      }
      logger.error('[episodeFanoutWorker] assignment errored', {
        runId: task.runId,
        shardIndex: task.shardIndex,
        uid: a.uid,
        titleId: a.titleId,
      });
    }
  }

  await deps.recordShard({
    runId: task.runId,
    stage: 'episodeFanout',
    shardIndex: task.shardIndex,
    startedAt: start,
    completedAt: deps.now(),
    synced,
    skipped: 0,
    errored,
    errors,
    counters: { episodesWritten },
  });
}

/**
 * The deployable `episode-cache` shard worker (spec 0101, `onTaskDispatched`). The
 * backing Cloud Tasks queue is auto-created on deploy from the code-declared
 * `rateLimits`/`retryConfig`; queue name == this FUNCTION name
 * (`episodeCacheWorker`, see `QUEUE_NAMES.episodeCache`). Episode-cache aggregate
 * TMDB throughput = maxConcurrentDispatches(10) × 4 req/s = 40 req/s, and this
 * stage runs AFTER title-sync completes (stage barrier), so the two TMDB stages
 * never overlap. Binds `TMDB_READ_TOKEN`.
 */
export const episodeCacheWorker = onTaskDispatched<EpisodeCacheTask>(
  {
    secrets: [TMDB_READ_TOKEN],
    retryConfig: {
      maxAttempts: 3,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxRetrySeconds: 3600,
    },
    rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 10 },
    maxInstances: 10,
    timeoutSeconds: 540,
  },
  async (request) => {
    const db = ensureAdminForEpisodes();
    const enqueuer = createTaskEnqueuer();
    await runEpisodeCacheShard(
      {
        db,
        now: () => Date.now(),
        createEngine: (firestore: Firestore): EpisodeCacheEngine =>
          createEpisodeCacheEngine({
            cache: createTitleCacheEpisodeStore(firestore),
            tmdb: createTmdbEpisodeSourceAdapter(
              createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
            ),
          }),
        recordShard: (params) => recordShardResult(db, params),
        onLastShard: (runId) =>
          enqueueFanoutAndAiringStages(
            {
              enqueuer,
              readStagedAssignments: (r) => readStagedAssignments(db, r),
              readStagedUids: (r) => readStagedUids(db, r),
              setStageShardCount: (r, stage, n) =>
                setStageShardCount(db, r, stage, n),
              finalizeHealthyRun: (r, now) =>
                finalizeHealthyRun(db, r, now).then(() => undefined),
              now: () => Date.now(),
            },
            runId,
          ),
      },
      request.data,
    );
  },
);

/**
 * The deployable `episode-fanout` shard worker (spec 0101, `onTaskDispatched`).
 * Queue name == this FUNCTION name (`episodeFanoutWorker`, see
 * `QUEUE_NAMES.episodeFanout`). Makes ZERO TMDB calls — Firestore-bound, so it
 * binds NO secrets and its engine is built WITHOUT a `tmdb` source (calling
 * `cacheShowEpisodes` would throw by construction). Concurrency 20.
 */
export const episodeFanoutWorker = onTaskDispatched<EpisodeFanoutTask>(
  {
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
    const db = ensureAdminForEpisodes();
    await runEpisodeFanoutShard(
      {
        db,
        now: () => Date.now(),
        createEngine: (firestore: Firestore): EpisodeCacheEngine =>
          createEpisodeCacheEngine({
            // NO `tmdb` — fan-out is Firestore-only and cannot call TMDB.
            cache: createTitleCacheEpisodeStore(firestore),
            episodes: createEpisodeUpsertStore(firestore),
            watchlistStatus: createWatchlistStatusStoreAdapter(firestore),
            nextWatchable: createNextWatchableStoreAdapter(firestore),
          }),
        recordShard: (params) => recordShardResult(db, params),
      },
      request.data,
    );
  },
);
