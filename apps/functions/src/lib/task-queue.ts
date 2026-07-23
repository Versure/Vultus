/**
 * Cloud Tasks enqueue adapter + shard-splitting helpers for the sharded nightly
 * sync pipeline (spec 0101, T1).
 *
 * This module is the ONLY place `apps/functions` talks to the Cloud Tasks fan-out
 * mechanism. It is deliberately thin and SDK-agnostic at its seams: the enqueuer
 * is a small port (`TaskEnqueuer`) over `getFunctions().taskQueue(name).enqueue`
 * (`firebase-admin/functions`), injectable so the coordinator/worker tests drive
 * it with a fake — no Admin SDK, no network, no emulator.
 *
 * Task NAMES are deterministic (`${runId}-${stage}-${shardIndex}`, watchdog
 * `${runId}-watchdog`) so a retried enqueue of the same run cannot double-create a
 * shard/watchdog task — Cloud Tasks de-dupes by the task `id`.
 */
import { getFunctions } from 'firebase-admin/functions';

/**
 * Named shard-size constants (spec 0101 "Shard-sizing arithmetic"). These are the
 * chosen defaults; kept as named module constants so they are tunable without
 * re-plumbing the callers.
 */
export const SHARD_SIZE_TITLES = 500;
export const SHARD_SIZE_SHOWS = 150;
export const SHARD_SIZE_ASSIGNMENTS = 1000;
export const SHARD_SIZE_USERS = 500;

/**
 * The pipeline stages, in barrier order. `airingScan` is the LAST stage — the
 * shard that completes it finalizes the run (writes the `sync-runs/{runId}`
 * summary; see `sync-run-tracker.ts`). Used as the `stage` token in both the task
 * name and the `sync-run-progress/{runId}/shards/{stage}-{shardIndex}` subdoc id.
 */
export type SyncStage =
  | 'titleSync'
  | 'episodeCache'
  | 'episodeFanout'
  | 'airingScan';

/**
 * Cloud Tasks queue names. firebase-functions v2 names each backing queue after
 * the `onTaskDispatched` FUNCTION it is created for (the queue name IS the
 * function name), and `getFunctions().taskQueue(name)` enqueues by that same
 * name. So these values are the deployed worker / watchdog function names — the
 * enqueuer MUST target the function's queue or the dispatch never routes.
 */
export const QUEUE_NAMES = {
  titleSync: 'titleSyncWorker',
  episodeCache: 'episodeCacheWorker',
  episodeFanout: 'episodeFanoutWorker',
  airingScan: 'airingScanWorker',
  watchdog: 'syncWatchdog',
} as const;

// --- Enqueue payloads (JSON, ≤ Cloud Tasks 100 KB/task — keep shards small). ---

/** One `title-sync` shard: a subset of distinct titles to run the engine over. */
export interface TitleSyncTask {
  runId: string;
  shardIndex: number;
  titles: { tmdbId: number; type: 'movie' | 'tv' }[];
  forced: boolean;
  /**
   * The distinct union of all users' regions for this run (spec 0099, reconciled
   * into the 0101 sharding). Gathered ONCE by the coordinator and carried on the
   * shard so the WORKER's title-cache engine can drive the Watchmode availability
   * gap-fill without re-scanning `users`. JSON-plain (`string[]`) to keep this
   * generic Cloud Tasks payload free of the domain `Region` type; the worker
   * hands it to `createSyncEngine`, which re-filters it against `REGIONS`.
   */
  activeRegions: string[];
}

/** One `episode-cache` shard: distinct TV tmdbIds to fetch + cache once. */
export interface EpisodeCacheTask {
  runId: string;
  shardIndex: number;
  shows: number[];
}

/** One `episode-fanout` shard: per-user (uid, titleId, tmdbId) TV assignments. */
export interface EpisodeFanoutTask {
  runId: string;
  shardIndex: number;
  assignments: { uid: string; titleId: string; tmdbId: number }[];
}

/** One `airing-scan` shard: uids to scan (worker re-reads each uid's watchlist). */
export interface AiringScanTask {
  runId: string;
  shardIndex: number;
  uids: string[];
}

/** The dead-run watchdog task — enqueued once per run with a long delay. */
export interface SyncWatchdogTask {
  runId: string;
}

/**
 * Split `items` into shards of at most `size`: N items → `ceil(N/size)` shards,
 * the last shard is the remainder, an empty input → `[]` (0 shards). Pure.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('chunk size must be a positive integer');
  }
  const shards: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    shards.push(items.slice(i, i + size));
  }
  return shards;
}

/**
 * The deterministic task name for a shard of a stage: `${runId}-${stage}-${shardIndex}`.
 * Same inputs → same name (Cloud Tasks de-dupes by it, so a retried enqueue of the
 * same run is a no-op rather than a double-create).
 */
export function shardTaskName(
  runId: string,
  stage: SyncStage,
  shardIndex: number,
): string {
  return `${runId}-${stage}-${shardIndex}`;
}

/** The deterministic watchdog task name for a run: `${runId}-watchdog`. */
export function watchdogTaskName(runId: string): string {
  return `${runId}-watchdog`;
}

/** Options for a single enqueue. `name` is the Cloud Tasks de-dupe id. */
export interface EnqueueOptions {
  /** Deterministic task name (Cloud Tasks `id`); enables de-duplication. */
  name?: string;
  /** Delay before dispatch, seconds (the watchdog uses ≈ 7200). */
  scheduleDelaySeconds?: number;
}

/**
 * Port: enqueue one JSON payload onto a named Cloud Tasks queue. Injectable so
 * the coordinator + worker tests supply a fake and assert queue/name/payload/delay
 * without the Admin SDK.
 */
export interface TaskEnqueuer {
  enqueue<T>(
    queueName: string,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<void>;
}

/** Minimal shape of a `firebase-admin/functions` task queue (the bit we use). */
export interface TaskQueueLike {
  enqueue(
    data: unknown,
    opts?: { id?: string; scheduleDelaySeconds?: number },
  ): Promise<void>;
}

/** Resolves a queue by name — defaults to the real `getFunctions().taskQueue`. */
export type TaskQueueFactory = (queueName: string) => TaskQueueLike;

/**
 * Build the production `TaskEnqueuer` over `getFunctions().taskQueue(name)`. The
 * queue factory is injectable so tests exercise the option mapping (name → `id`,
 * `scheduleDelaySeconds`) with a fake queue.
 */
export function createTaskEnqueuer(
  taskQueueFactory: TaskQueueFactory = (name) => getFunctions().taskQueue(name),
): TaskEnqueuer {
  return {
    async enqueue(queueName, payload, options) {
      const opts: { id?: string; scheduleDelaySeconds?: number } = {};
      if (options?.name !== undefined) {
        opts.id = options.name;
      }
      if (options?.scheduleDelaySeconds !== undefined) {
        opts.scheduleDelaySeconds = options.scheduleDelaySeconds;
      }
      await taskQueueFactory(queueName).enqueue(payload, opts);
    },
  };
}
