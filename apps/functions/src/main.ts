/**
 * Firebase Cloud Functions entry point for Vultus.
 *
 * This file is the deployable barrel: every exported symbol becomes a Cloud
 * Function. Since spec 0101 the nightly sync is SHARDED over Cloud Tasks:
 *  - `syncTitles` (HTTPS) is an **enqueue coordinator** — it authenticates the
 *    caller (cron shared secret OR Firebase ID token), rate-limits the user path,
 *    runs ONE consolidated `collectionGroup('watchlist')` gather, dedupes to the
 *    distinct title union, applies the staleness window, opens the
 *    `sync-run-progress/{runId}` staging doc, enqueues a delayed dead-run
 *    watchdog, fans the title work out into `title-sync` shards, and returns a
 *    `SyncEnqueueResponse`. It runs NO pipeline work inline and writes NO
 *    `sync-runs/{runId}` summary — that is written only at finalization.
 *  - `titleSyncWorker` (`onTaskDispatched`) runs the spec-0008 title-cache engine
 *    over one shard's titles and records its shard result.
 *  - `syncWatchdog` (`onTaskDispatched`) force-finalizes a dead run.
 *  - `triggerSync` (per-user manual) stays a single synchronous, unsharded pass.
 *
 * The Firebase Admin SDK + `firebase-functions/params` enter ONLY at the trigger
 * wiring below; the core flows (`runSync`, `runTitleSyncShard`, `runSyncWatchdog`,
 * `runTriggerSync`, `runGetWatchProviders`) are driven by injected dependencies so
 * they can be unit-tested without the SDK, network, or secrets.
 */
import { logger, setGlobalOptions } from 'firebase-functions';
import { onRequest, onCall, HttpsError } from 'firebase-functions/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { defineSecret, defineString } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import {
  createSyncEngine,
  createTmdbClient,
  createTraktClient,
  createFirestoreTitleCacheStore,
  gatherUserWatchlistTitles,
} from '@vultus/functions/sync-titles';
import type {
  GatheredUserTitle,
  SyncEngine,
  SyncResult,
  SyncTitleInput,
  TmdbClient,
} from '@vultus/functions/sync-titles';
import { REGIONS } from '@vultus/shared/domain';
import type { CatalogProvider, Region } from '@vultus/shared/domain';
import {
  providerCatalogDocPath,
  providerCatalogToData,
  dataToProviderCatalog,
} from '@vultus/shared/firestore-schema';
import type { ProviderCatalogReadData } from '@vultus/shared/firestore-schema';
import { classifyAuth } from './lib/auth';
import type { VerifyToken } from './lib/auth';
import { dedupeTitles } from './lib/gather';
import type { GatheredTitle } from './lib/gather';
import { filterStale } from './lib/staleness';
import { isRateLimited } from './lib/rate-limit';
import {
  gatherWatchlistTitles,
  readSyncState,
  writeSyncState,
  writeSyncRun,
  verifyIdToken,
} from './lib/firestore-io';
import {
  createTaskEnqueuer,
  chunk,
  shardTaskName,
  watchdogTaskName,
  QUEUE_NAMES,
  SHARD_SIZE_TITLES,
} from './lib/task-queue';
import type {
  TaskEnqueuer,
  TitleSyncTask,
  SyncWatchdogTask,
} from './lib/task-queue';
import {
  openRun as trackerOpenRun,
  recordShardResult,
  finalizeHealthyRun,
  finalizeAsDead,
} from './lib/sync-run-tracker';
import type {
  OpenRunParams,
  RecordShardResultParams,
  RecordShardResultOutcome,
} from './lib/sync-run-tracker';

// Keep deployments in a single region (free-tier friendly, PLAN §2). Concurrency
// is now set PER-FUNCTION (spec 0101 §5) — the old global `maxInstances: 1`
// serialized the whole deployment and is gone.
setGlobalOptions({ region: 'europe-west1' });

// Initialize the Admin SDK eagerly at module load, not lazily inside a
// handler: a lazy `getApps().length === 0` check race can leave a cold-start
// invocation calling `getFirestore()` before `initializeApp()` has run,
// throwing "the default Firebase app does not exist" (observed in prod on a
// getWatchProviders cold start). Module-load code always runs before the
// Functions Framework starts dispatching requests, so this ordering is safe.
if (getApps().length === 0) {
  initializeApp();
}

// --- Config / secrets (declared by NAME only; values read via .value() inside
// the handler, never at module load, never from .env.local, never logged). ---
const SYNC_SHARED_SECRET = defineSecret('SYNC_SHARED_SECRET');
const TMDB_READ_TOKEN = defineSecret('TMDB_READ_TOKEN');
const TRAKT_CLIENT_ID = defineString('TRAKT_CLIENT_ID');

/** User-path rate-limit window: reject a second user run within 5 minutes. */
export const RATE_LIMIT_MS = 5 * 60 * 1000;
/** Staleness window (~20h): skip a title synced more recently, unless forced. */
export const STALENESS_WINDOW_MS = 20 * 60 * 60 * 1000;
/**
 * Dead-run watchdog delay (seconds). ~2× the worst-case (non-retry) run duration
 * (spec 0101 Risks): the coordinator enqueues one delayed watchdog per run; if the
 * run has not finalized by then it is force-finalized into an error summary.
 */
export const WATCHDOG_DELAY_SECONDS = 7200;

/**
 * The JSON body `syncTitles` returns on a 2xx — the run has been ENQUEUED, not
 * completed. Never includes a secret or token. Per-title outcome counts
 * (synced/skipped/errored) are NOT known at enqueue time; they land in
 * `sync-runs/{runId}` at finalization (settings sync-health, spec 0049).
 */
export interface SyncEnqueueResponse {
  ok: true;
  trigger: 'cron' | 'user';
  /** The `sync-runs` doc id — observe the run's outcome there. */
  runId: string;
  /** Distinct titles after dedupe, before the staleness filter. */
  gathered: number;
  /** Distinct titles that passed the staleness filter (== title-sync work). */
  toSync: number;
  /** Phase-1 title-sync shards enqueued (0 ⇒ healthy no-op). */
  shardCount: number;
  forced: boolean;
}

/** Dependencies injected into `runSync`, so tests drive it with fakes. */
export interface RunSyncDeps {
  db: Firestore;
  /** Verifies a Firebase ID token (Admin SDK in production). */
  verifyToken: VerifyToken;
  /** The shared secret value (`SYNC_SHARED_SECRET.value()`). */
  secret: string;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
  rateLimitMs: number;
  stalenessWindowMs: number;
  /** Cloud Tasks enqueuer (real in prod; fake in tests). */
  enqueuer: TaskEnqueuer;
  /** Fresh runId per invocation (uuid in prod; fixed in tests). */
  generateRunId: () => string;
  /** Open the run's `sync-run-progress/{runId}` staging doc (tracker.openRun,
   *  bound to `db`, in prod). Injected so tests assert it without a transaction. */
  openRun: (params: OpenRunParams) => Promise<void>;
  /** Finalize a healthy 0-shard run (tracker.finalizeHealthyRun in prod). */
  finalizeHealthyRun: (runId: string, now: number) => Promise<void>;
  /** Watchdog schedule delay, seconds (default `WATCHDOG_DELAY_SECONDS`). */
  watchdogDelaySeconds?: number;
}

/** A minimal view of the request `runSync` needs — satisfied by the real
 *  `firebase-functions` Request and by test fakes. */
export interface SyncRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The result of `runSync`: an HTTP status + a JSON body to send. */
export interface RunSyncOutput {
  status: number;
  body: unknown;
}

function parseForce(body: unknown): boolean {
  if (body && typeof body === 'object' && 'force' in body) {
    return (body as { force?: unknown }).force === true;
  }
  return false;
}

/**
 * Enqueue-coordinator core, SDK-agnostic via injected deps. Authenticates + rate-
 * limits, runs ONE consolidated gather → dedupe → staleness filter, opens the
 * `sync-run-progress/{runId}` staging doc, enqueues the delayed watchdog, and fans
 * the surviving titles out into `title-sync` shards. Runs NO pipeline work inline
 * and writes NO `sync-runs/{runId}` summary (finalization-only invariant). Returns
 * the status + `SyncEnqueueResponse` body the caller should send.
 */
export async function runSync(
  deps: RunSyncDeps,
  req: SyncRequest,
): Promise<RunSyncOutput> {
  const start = deps.now();

  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }

  const auth = await classifyAuth(req.headers, deps.secret, deps.verifyToken);
  if (auth.kind === 'unauthenticated') {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  if (auth.kind === 'forbidden') {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const trigger: 'cron' | 'user' = auth.kind;
  // `force` is honored only on the privileged cron path; ignored for users.
  const forced = trigger === 'cron' && parseForce(req.body);

  // Rate limit applies to the user path only; cron bypasses it.
  if (trigger === 'user') {
    const { lastRunAt } = await readSyncState(deps.db);
    if (isRateLimited(lastRunAt, start, deps.rateLimitMs)) {
      const retryAfterMs =
        lastRunAt === null ? 0 : deps.rateLimitMs - (start - lastRunAt);
      return {
        status: 429,
        body: { error: 'rate_limited', retryAfterMs },
      };
    }
  }

  // ONE consolidated gather + dedupe to the distinct title union.
  const gatheredRaw = await gatherWatchlistTitles(deps.db);
  const distinct = dedupeTitles(gatheredRaw);
  const gathered = distinct.length;

  // Apply the staleness window unless forced (reads `title-cache.lastSyncedAt`).
  let toSyncTitles: GatheredTitle[];
  if (forced) {
    toSyncTitles = distinct;
  } else {
    const store = createFirestoreTitleCacheStore(deps.db);
    const lastSyncedByTmdbId = new Map<number, string | null>();
    await Promise.all(
      distinct.map(async (title) => {
        const entry = await store.getEntry(title.tmdbId);
        lastSyncedByTmdbId.set(title.tmdbId, entry?.lastSyncedAt ?? null);
      }),
    );
    toSyncTitles = filterStale(
      distinct,
      lastSyncedByTmdbId,
      start,
      deps.stalenessWindowMs,
      false,
    );
  }

  const shards = chunk(toSyncTitles, SHARD_SIZE_TITLES);
  const shardCount = shards.length;
  const toSync = toSyncTitles.length;
  const runId = deps.generateRunId();

  // Open the in-flight staging doc (`sync-run-progress/{runId}`) — NEVER the
  // `sync-runs/{runId}` summary, which is written only at finalization so the
  // settings sync-health card's "newest-by-startedAt is always complete"
  // invariant holds (spec 0101 Data model). syncTitles is the GLOBAL sync, so
  // the staging kind is always `cron`/`userId: null` (the per-USER manual pass
  // is `triggerSync`); the response `trigger` still distinguishes cron vs user.
  await deps.openRun({
    runId,
    kind: 'cron',
    userId: null,
    startedAt: start,
    shardCounts: { titleSync: shardCount },
  });

  // Enqueue the delayed dead-run watchdog ONCE. The task name is deterministic,
  // so a retried enqueue of the same run cannot double-create it.
  const watchdogPayload: SyncWatchdogTask = { runId };
  await deps.enqueuer.enqueue(QUEUE_NAMES.watchdog, watchdogPayload, {
    name: watchdogTaskName(runId),
    scheduleDelaySeconds: deps.watchdogDelaySeconds ?? WATCHDOG_DELAY_SECONDS,
  });

  if (shardCount === 0) {
    // Healthy no-op: the staleness filter dropped every title (or none were
    // tracked). There is no title-sync work and no shard to advance the run, so
    // FINALIZE IMMEDIATELY into a normal (zero-stats) `sync-runs/{runId}` summary
    // — a healthy empty night yields a complete summary doc, never a watchdog
    // error summary and never a permanent "Never synced". The already-enqueued
    // watchdog will find the run finalized and no-op. (Choice per spec 0101 T2:
    // prefer immediate healthy finalization over letting the watchdog fire.)
    await deps.finalizeHealthyRun(runId, deps.now());
  } else {
    // Fan out one `title-sync` task per shard. Named → Cloud Tasks de-dupes a
    // retried enqueue of the same run/shard.
    for (let i = 0; i < shards.length; i++) {
      const payload: TitleSyncTask = {
        runId,
        shardIndex: i,
        titles: shards[i],
        forced,
      };
      await deps.enqueuer.enqueue(QUEUE_NAMES.titleSync, payload, {
        name: shardTaskName(runId, 'titleSync', i),
      });
    }
  }

  // Persist the run on `system/sync` so the user-path rate limit still works
  // (behavior unchanged from the pre-sharding coordinator; last-run == last
  // enqueue). Not the `sync-runs` summary.
  await writeSyncState(deps.db, deps.now(), start);

  const response: SyncEnqueueResponse = {
    ok: true,
    trigger,
    runId,
    gathered,
    toSync,
    shardCount,
    forced,
  };
  logger.info('syncTitles enqueue complete', {
    trigger,
    runId,
    gathered,
    toSync,
    shardCount,
    forced,
  });
  return { status: 200, body: response };
}

function ensureAdmin(): Firestore {
  return getFirestore();
}

/** Dependencies injected into `runTitleSyncShard`, so tests drive it with fakes. */
export interface RunTitleSyncShardDeps {
  db: Firestore;
  /** Builds the credentialed title-cache engine (fake in tests). */
  createEngine: (db: Firestore) => SyncEngine;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
  /** Record this shard's result (tracker.recordShardResult, bound to db, in prod). */
  recordShard: (
    params: RecordShardResultParams,
  ) => Promise<RecordShardResultOutcome>;
  /**
   * Called ONCE, on the shard that completes the title stage. INTERIM (Phase 1,
   * spec 0101 T2): finalize the run — the title stage is the only stage with
   * shards, so its completion completes the run. T6 replaces this with the
   * episode-cache stage enqueue (`setStageShardCount` + enqueue `episode-cache`
   * shards, done BEFORE recording the last shard so the barrier does not finalize
   * early), after which the airing-scan barrier writes the summary instead.
   */
  onLastShard: (runId: string) => Promise<void>;
}

/**
 * Title-sync shard worker core. Runs the spec-0008 title-cache engine over the
 * shard's titles, then ALWAYS records the shard result. A whole-shard failure
 * (engine construction / transient enumeration) is CAUGHT and recorded as
 * fully-errored — the task does not crash — so the stage still reaches its
 * `shardCount` and the run can finalize with accurate error counts (an uncaught
 * infra loss is the watchdog's concern, spec 0101 Risks). On the shard that
 * completes the stage it invokes `onLastShard`.
 *
 * Staleness/force are applied UPSTREAM in the coordinator; by the time titles
 * reach a shard they are already the set to sync, so the engine syncs them all.
 * `payload.forced` is carried for observability/parity, not re-applied here.
 */
export async function runTitleSyncShard(
  deps: RunTitleSyncShardDeps,
  task: TitleSyncTask,
): Promise<void> {
  const start = deps.now();
  const inputs: SyncTitleInput[] = task.titles.map((t) => ({
    tmdbId: t.tmdbId,
    type: t.type,
  }));

  let synced = 0;
  let skipped = 0;
  let errored = 0;
  let errors: string[] = [];
  try {
    const engine = deps.createEngine(deps.db);
    const results: SyncResult[] = await engine.sync(inputs);
    synced = results.filter((r) => r.outcome === 'synced').length;
    skipped = results.filter((r) => r.outcome === 'skipped').length;
    errored = results.filter((r) => r.outcome === 'error').length;
    errors = results
      .filter((r) => r.outcome === 'error')
      .map((r) => r.reason)
      .filter((s): s is string => !!s)
      .slice(0, 10);
    // Per-title error visibility (spec 0089 / D4): each errored title's
    // (credential-free) reason, now scoped to its run + shard.
    for (const r of results) {
      if (r.outcome === 'error') {
        logger.error('[titleSyncWorker] title errored', {
          runId: task.runId,
          shardIndex: task.shardIndex,
          tmdbId: r.tmdbId,
          type: r.type,
          reason: r.reason,
        });
      }
    }
  } catch (err) {
    // Whole-shard failure → record as fully-errored (do NOT crash the task) so
    // the stage still advances and the run finalizes with an accurate count.
    errored = inputs.length;
    errors = [err instanceof Error ? err.message : 'title shard failed'];
    logger.error('[titleSyncWorker] shard failed (recorded as errored)', {
      runId: task.runId,
      shardIndex: task.shardIndex,
    });
  }

  const outcome = await deps.recordShard({
    runId: task.runId,
    stage: 'titleSync',
    shardIndex: task.shardIndex,
    startedAt: start,
    completedAt: deps.now(),
    synced,
    skipped,
    errored,
    errors,
    counters: { titlesGathered: inputs.length, titlesUpdated: synced },
  });

  if (outcome.isLastShardOfStage) {
    await deps.onLastShard(task.runId);
  }
}

/** Dependencies injected into `runSyncWatchdog`, so tests drive it with fakes. */
export interface RunSyncWatchdogDeps {
  db: Firestore;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
  /** Force-finalize a dead run (tracker.finalizeAsDead in prod). */
  finalizeAsDead: (
    db: Firestore,
    runId: string,
    now: number,
  ) => Promise<{ wroteSummary: boolean }>;
}

/**
 * Dead-run watchdog core. Delegates to `finalizeAsDead`: if the run already
 * finalized (normal completion or a prior watchdog) it no-ops; otherwise it
 * force-writes the `sync-runs/{runId}` error summary. Idempotent by construction
 * (the finalizer transacts on `finalized`).
 */
export async function runSyncWatchdog(
  deps: RunSyncWatchdogDeps,
  task: SyncWatchdogTask,
): Promise<void> {
  await deps.finalizeAsDead(deps.db, task.runId, deps.now());
}

/**
 * The deployable HTTPS enqueue coordinator (spec 0101). Binds `SYNC_SHARED_SECRET`
 * (auth) + `TMDB_READ_TOKEN` (bound for continuity; the coordinator itself makes no
 * TMDB call — the title work runs in `titleSyncWorker`). `timeoutSeconds: 540`
 * covers the single big gather + staleness reads; `maxInstances: 2`.
 */
export const syncTitles = onRequest(
  {
    secrets: [SYNC_SHARED_SECRET, TMDB_READ_TOKEN],
    timeoutSeconds: 540,
    maxInstances: 2,
  },
  async (req, res) => {
    const db = ensureAdmin();
    const output = await runSync(
      {
        db,
        enqueuer: createTaskEnqueuer(),
        generateRunId: () => randomUUID(),
        openRun: (params) => trackerOpenRun(db, params),
        finalizeHealthyRun: (runId, now) =>
          finalizeHealthyRun(db, runId, now).then(() => undefined),
        verifyToken: verifyIdToken,
        secret: SYNC_SHARED_SECRET.value(),
        now: () => Date.now(),
        rateLimitMs: RATE_LIMIT_MS,
        stalenessWindowMs: STALENESS_WINDOW_MS,
      },
      { method: req.method, headers: req.headers, body: req.body },
    );

    res.status(output.status).json(output.body);
  },
);

/**
 * The deployable `title-sync` shard worker (spec 0101, `onTaskDispatched`). The
 * backing Cloud Tasks queue is auto-created on deploy with the code-declared
 * `rateLimits`/`retryConfig` below — the queue name equals this FUNCTION name
 * (`titleSyncWorker`, see `QUEUE_NAMES.titleSync`). Title-stage aggregate TMDB
 * throughput = maxConcurrentDispatches(10) × 4 req/s = 40 req/s (spec 0101). Binds
 * `TMDB_READ_TOKEN` (+ the `TRAKT_CLIENT_ID` param) exactly as the pre-sharding
 * `syncTitles` engine wiring did.
 */
export const titleSyncWorker = onTaskDispatched<TitleSyncTask>(
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
    const db = ensureAdmin();
    await runTitleSyncShard(
      {
        db,
        now: () => Date.now(),
        createEngine: (firestore: Firestore): SyncEngine =>
          createSyncEngine({
            tmdb: createTmdbClient({
              readAccessToken: TMDB_READ_TOKEN.value(),
            }),
            trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),
            store: createFirestoreTitleCacheStore(firestore),
            // Spec 0089 / D2: one extra pass over retryable-errored titles.
            retryErroredPasses: 1,
            retryDelayMs: 2000,
          }),
        recordShard: (params) => recordShardResult(db, params),
        // INTERIM (spec 0101 T2): the title stage is the only stage with shards,
        // so its completion finalizes the run. T6 replaces this with the
        // episode-cache stage enqueue.
        onLastShard: (runId) =>
          finalizeHealthyRun(db, runId, Date.now()).then(() => undefined),
      },
      request.data,
    );
  },
);

/**
 * The deployable dead-run watchdog (spec 0101, `onTaskDispatched`). Enqueued once
 * per run by `syncTitles` with `scheduleDelaySeconds ≈ WATCHDOG_DELAY_SECONDS`.
 * Makes NO TMDB calls (needs no secrets). Queue name == this function name
 * (`syncWatchdog`, see `QUEUE_NAMES.watchdog`).
 */
export const syncWatchdog = onTaskDispatched<SyncWatchdogTask>(
  {
    retryConfig: {
      maxAttempts: 3,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxRetrySeconds: 3600,
    },
    rateLimits: { maxConcurrentDispatches: 2 },
    maxInstances: 2,
    timeoutSeconds: 120,
  },
  async (request) => {
    const db = ensureAdmin();
    await runSyncWatchdog(
      { db, now: () => Date.now(), finalizeAsDead },
      request.data,
    );
  },
);

/** The response the manual `triggerSync` callable resolves with (spec 0025). */
export interface TriggerSyncResponse {
  /** ISO 8601 timestamp of when the manual sync pass completed. */
  syncedAt: string;
}

/** Dependencies injected into `runTriggerSync`, so tests drive it with fakes. */
export interface RunTriggerSyncDeps {
  db: Firestore;
  /** Builds the credentialed engine for the gathered store. Injected so the
   *  handler test can supply a fake engine without the real clients. */
  createEngine: (db: Firestore) => SyncEngine;
  /** Clock in epoch ms; injected for deterministic `startedAt`/`durationMs`
   *  tests (mirrors `RunSyncDeps.now`). Defaults to `Date.now()`. */
  now?: () => number;
}

/**
 * Core manual-sync flow, SDK-agnostic via injected deps. Validates the caller's
 * identity (`uid` must be present), gathers ONLY that user's watchlist titles
 * (deduped to `{ tmdbId, type }`), runs ONE force-fresh engine pass (no staleness
 * filter — manual = always refresh), and resolves `{ syncedAt }`. Best-effort:
 * per-title engine errors do NOT fail the callable (spec 0008 isolation). Writes
 * ONLY `title-cache/**` via the engine port — no `users/**`, no `system/sync`.
 */
export async function runTriggerSync(
  deps: RunTriggerSyncDeps,
  uid: string | undefined,
): Promise<TriggerSyncResponse> {
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required');
  }

  const start = deps.now?.() ?? Date.now();

  let rawTitles: GatheredUserTitle[];
  try {
    rawTitles = await gatherUserWatchlistTitles(deps.db, uid);
  } catch (err) {
    logger.error('[triggerSync] gather failed', err);
    throw new HttpsError('internal', 'Failed to read watchlist');
  }

  const inputs: SyncTitleInput[] = rawTitles.map((t) => ({
    tmdbId: t.tmdbId,
    type: t.type,
  }));
  const engine = deps.createEngine(deps.db);
  const results: SyncResult[] = await engine.sync(inputs);

  const synced = results.filter((r) => r.outcome === 'synced').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const errored = results.filter((r) => r.outcome === 'error').length;
  logger.info('[triggerSync] sync complete', {
    gathered: inputs.length,
    synced,
    skipped,
    errored,
  });

  // Best-effort sync-run record (observability only). A write failure is logged
  // and NEVER alters or fails the callable — the `{ syncedAt }` return below is
  // unchanged regardless of this write.
  const end = deps.now?.() ?? Date.now();
  const errors = results
    .filter((r) => r.outcome === 'error')
    .map((r) => r.reason)
    .filter((s): s is string => !!s)
    .slice(0, 10);
  try {
    await writeSyncRun(deps.db, {
      kind: 'manual',
      userId: uid,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(end).toISOString(),
      durationMs: end - start,
      titlesGathered: inputs.length,
      titlesUpdated: synced,
      errorCount: errored,
      errors,
    });
  } catch (err) {
    logger.error('[syncRun] failed to record run', err);
  }

  return { syncedAt: new Date().toISOString() };
}

/**
 * The deployable manual-sync callable (spec 0025). Verified Firebase Auth context
 * is supplied by the callable framework; we only assert an identity is present
 * (`request.auth.uid`, never a client-supplied payload). Binds `TMDB_READ_TOKEN`
 * so the runtime injects it; reuses the SAME engine wiring as `syncTitles`.
 */
export const triggerSync = onCall<unknown, Promise<TriggerSyncResponse>>(
  {
    secrets: [TMDB_READ_TOKEN],
    maxInstances: 3,
    cors: [
      'https://vultus-cab62.web.app',
      'https://vultus-cab62.firebaseapp.com',
      'https://localhost', // Capacitor Android WebView (default androidScheme is https)
      'http://localhost', // Capacitor Android WebView (legacy http scheme)
      'http://localhost:4200', // Angular dev server (serve-prod-debug)
    ],
  },
  async (request) => {
    try {
      const db = ensureAdmin();
      const createEngine = (firestore: Firestore): SyncEngine =>
        createSyncEngine({
          tmdb: createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
          trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),
          store: createFirestoreTitleCacheStore(firestore),
        });
      return await runTriggerSync({ db, createEngine }, request.auth?.uid);
    } catch (err) {
      logger.error('[triggerSync] unhandled error', err);
      throw err;
    }
  },
);

/** The `getWatchProviders` callable request (spec 0060). */
export interface GetWatchProvidersRequest {
  region: Region;
}

/** The `getWatchProviders` callable response (spec 0060). */
export interface GetWatchProvidersResponse {
  providers: CatalogProvider[];
}

/** Dependencies injected into `runGetWatchProviders`, so tests drive it with
 *  fakes (fake `db`, fake TMDB client, injected clock). */
export interface RunGetWatchProvidersDeps {
  db: Firestore;
  /** Builds the credentialed TMDB client (injected so tests use a fake). */
  createTmdb: () => TmdbClient;
  /** Clock in epoch ms; injected for deterministic staleness tests. */
  now?: () => number;
  /** Cache staleness window; defaults to 7 days in ms. */
  stalenessMs?: number;
}

/** Default provider-catalog staleness window: 7 days (spec 0060, decision 2). */
export const PROVIDER_CATALOG_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

function isRegion(value: unknown): value is Region {
  return (
    typeof value === 'string' && (REGIONS as readonly string[]).includes(value)
  );
}

/**
 * Core `getWatchProviders` flow, SDK-agnostic via injected deps (spec 0060).
 *
 * Validates the caller (`uid` present) and the client-supplied region (must be a
 * member of `REGIONS`), then reads `provider-catalog/{region}`:
 * - fresh cache (age ≤ stalenessMs) → return its providers, DO NOT call TMDB;
 * - else fetch the region catalog from TMDB:
 *   - `null` (both TMDB endpoints 404/unexpected): a stale cached doc, if any, is
 *     returned instead of throwing (stale beats none); otherwise `unavailable`;
 *   - success: best-effort write the fresh `{ providers, lastSyncedAt }` doc (a
 *     write failure is logged but still returns the freshly-fetched providers),
 *     then return the fresh providers.
 *
 * Reads + writes ONLY `provider-catalog/{region}` (Admin SDK bypasses rules).
 */
export async function runGetWatchProviders(
  deps: RunGetWatchProvidersDeps,
  uid: string | undefined,
  input: unknown,
): Promise<GetWatchProvidersResponse> {
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required');
  }

  const region: unknown =
    input && typeof input === 'object'
      ? (input as { region?: unknown }).region
      : undefined;
  if (!isRegion(region)) {
    throw new HttpsError('invalid-argument', 'Unknown region');
  }

  const now = deps.now?.() ?? Date.now();
  const stalenessMs = deps.stalenessMs ?? PROVIDER_CATALOG_STALENESS_MS;
  const docPath = providerCatalogDocPath(region);

  // Read the cached catalog (if any). A read failure here is a real error the
  // client should see — it is not the best-effort WRITE path below.
  const snap = await deps.db.doc(docPath).get();
  const cached = snap.exists
    ? dataToProviderCatalog(snap.data() as ProviderCatalogReadData)
    : null;

  if (cached) {
    const ageMs = now - Date.parse(cached.lastSyncedAt);
    if (ageMs <= stalenessMs) {
      return { providers: cached.providers };
    }
  }

  // Cache missing or stale → refetch from TMDB.
  const fetched = await deps.createTmdb().getRegionWatchProviders(region);

  if (fetched === null) {
    // Both TMDB endpoints 404/unexpected. A stale cached catalog beats none.
    if (cached) {
      logger.warn(
        '[getWatchProviders] TMDB returned null; serving stale cache',
        { region },
      );
      return { providers: cached.providers };
    }
    throw new HttpsError('unavailable', 'Provider catalog unavailable');
  }

  // Best-effort cache write: a failure logs and still returns the fresh fetch.
  try {
    await deps.db.doc(docPath).set(
      providerCatalogToData({
        providers: fetched,
        lastSyncedAt: new Date(now).toISOString(),
      }),
    );
  } catch (err) {
    logger.error('[getWatchProviders] failed to write provider-catalog', err);
  }

  return { providers: fetched };
}

/**
 * The deployable `getWatchProviders` callable (spec 0060). Verified Firebase Auth
 * context is supplied by the callable framework; we only assert an identity is
 * present (`request.auth.uid`). Binds `TMDB_READ_TOKEN` so the runtime injects it
 * (read via `.value()` ONLY inside the handler, never at module load / logged) and
 * reuses the SAME `cors` array as `triggerSync`.
 */
export const getWatchProviders = onCall<
  unknown,
  Promise<GetWatchProvidersResponse>
>(
  {
    secrets: [TMDB_READ_TOKEN],
    maxInstances: 5,
    cors: [
      'https://vultus-cab62.web.app',
      'https://vultus-cab62.firebaseapp.com',
      'https://localhost', // Capacitor Android WebView (default androidScheme is https)
      'http://localhost', // Capacitor Android WebView (legacy http scheme)
      'http://localhost:4200', // Angular dev server (serve-prod-debug)
    ],
  },
  async (request) => {
    try {
      const db = ensureAdmin();
      return await runGetWatchProviders(
        {
          db,
          createTmdb: () =>
            createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
        },
        request.auth?.uid,
        request.data,
      );
    } catch (err) {
      logger.error('[getWatchProviders] unhandled error', err);
      throw err;
    }
  },
);

export { dispatchNotifications } from './dispatch-notifications';
export { syncWatchlistEpisodes } from './sync-episodes';
