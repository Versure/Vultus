/**
 * `sync-run-progress/{runId}` staging + stage-barrier finalization for the sharded
 * nightly sync pipeline (spec 0101, T1).
 *
 * Responsibilities:
 *  - `openRun` — write the in-flight staging doc (`finalized: false`, per-stage
 *    shard progress). It does NOT write the `sync-runs/{runId}` summary doc; that
 *    is written ONCE, at finalization, preserving the mobile sync-health invariant
 *    (every `sync-runs` doc is complete-with-`completedAt`).
 *  - `recordShardResult` — a Firestore TRANSACTION that reads the shard subdoc
 *    first and no-ops on a duplicate delivery (Cloud Tasks is at-least-once),
 *    otherwise writes the shard subdoc + rolls its counters into the stage. The
 *    shard that completes the LAST stage (`airingScan`) writes the summary doc.
 *  - `finalizeAsDead` — the watchdog path: transactional on `finalized`; force-write
 *    an error summary for a run that never finalized, else no-op.
 *
 * Firestore access is injected (`Firestore`) so every path is unit-tested with a
 * fake — no Admin SDK, no emulator (CLAUDE.md / project memory).
 *
 * The `sync-run-progress/*` paths are functions-only vocabulary, so they live here
 * as local constants (NOT in `shared/firestore-schema`). The `sync-runs/{runId}`
 * summary is written via the shared converter/path so its shape stays spec-0049
 * exact.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { syncRunDocPath, syncRunToData } from '@vultus/shared/firestore-schema';
import type { SyncStage } from './task-queue';

/** Top-level staging collection (functions-write-only; clients default-deny). */
export const SYNC_RUN_PROGRESS_COLLECTION = 'sync-run-progress';

/** `sync-run-progress/{runId}` — the in-flight staging doc. */
export function syncRunProgressDocPath(runId: string): string {
  return `${SYNC_RUN_PROGRESS_COLLECTION}/${runId}`;
}

/** `sync-run-progress/{runId}/shards` — per-shard result subcollection. */
export function syncRunProgressShardsCollection(runId: string): string {
  return `${syncRunProgressDocPath(runId)}/shards`;
}

/** `sync-run-progress/{runId}/shards/{stage}-{shardIndex}` — one shard's result. */
export function syncRunProgressShardDocPath(
  runId: string,
  stage: SyncStage,
  shardIndex: number,
): string {
  return `${syncRunProgressShardsCollection(runId)}/${stage}-${shardIndex}`;
}

/** The pipeline stages in barrier order; `airingScan` is the final barrier. */
export const SYNC_STAGES: readonly SyncStage[] = [
  'titleSync',
  'episodeCache',
  'episodeFanout',
  'airingScan',
];

/**
 * The TERMINAL stages of the pipeline DAG. Since spec 0101 T6 the pipeline is a
 * fork, not a line: `episodeCache`'s last shard enqueues BOTH `episodeFanout` and
 * `airingScan`, which run in PARALLEL. The run is done only when BOTH terminal
 * stages have drained, so finalization keys off "all stages complete", triggered
 * from whichever terminal shard finishes last (see `recordShardResult`).
 */
export const TERMINAL_STAGES: readonly SyncStage[] = [
  'episodeFanout',
  'airingScan',
];

/**
 * The nominal final stage (`airingScan`). Retained for reference/observability;
 * finalization no longer keys strictly off it (a fork means `episodeFanout` can
 * finish after `airingScan`) — see `TERMINAL_STAGES` / `recordShardResult`.
 */
export const LAST_STAGE: SyncStage = 'airingScan';

/** Max errors retained on the staging doc (and each shard subdoc). */
export const MAX_ERRORS = 10;

/** Per-stage progress on the staging doc. Stage-specific counters are optional. */
export interface StageProgress {
  shardCount: number;
  completedShards: number;
  errorCount: number;
  /** titleSync */ titlesGathered?: number;
  /** titleSync */ titlesUpdated?: number;
  /** episodeCache */ showsCached?: number;
  /** episodeFanout */ episodesWritten?: number;
}

/** The `sync-run-progress/{runId}` staging document shape. */
export interface SyncRunProgress {
  runId: string;
  kind: 'cron' | 'manual';
  userId: string | null;
  /** Epoch ms — carried so finalization can build the summary. */
  startedAt: number;
  finalized: boolean;
  stages: Record<SyncStage, StageProgress>;
  errors: string[];
}

/** One shard's completion record (`shards/{stage}-{shardIndex}`). */
export interface ShardRecord {
  stage: SyncStage;
  shardIndex: number;
  /** Epoch ms. */ startedAt: number;
  /** Epoch ms. */ completedAt: number;
  synced: number;
  skipped: number;
  errored: number;
  errors: string[];
}

function emptyStage(shardCount: number): StageProgress {
  return {
    shardCount,
    completedShards: 0,
    errorCount: 0,
    titlesGathered: 0,
    titlesUpdated: 0,
    showsCached: 0,
    episodesWritten: 0,
  };
}

/** Parameters for opening a run's staging doc. */
export interface OpenRunParams {
  runId: string;
  kind: 'cron' | 'manual';
  userId: string | null;
  /** Epoch ms of run start. */
  startedAt: number;
  /**
   * Known shard counts at open time. Typically only `titleSync` is known (Phase 1
   * enqueues title shards); downstream stage counts are set by
   * `setStageShardCount` when that stage is enqueued. Unspecified stages start at 0.
   */
  shardCounts: Partial<Record<SyncStage, number>>;
}

/**
 * Open a run: write the `sync-run-progress/{runId}` staging doc with
 * `finalized: false`, all four stages initialized, and the carried run metadata.
 * Writes NOTHING to `sync-runs/{runId}` (finalization-only invariant).
 */
export async function openRun(
  db: Firestore,
  params: OpenRunParams,
): Promise<void> {
  const stages = {} as Record<SyncStage, StageProgress>;
  for (const stage of SYNC_STAGES) {
    stages[stage] = emptyStage(params.shardCounts[stage] ?? 0);
  }
  const progress: SyncRunProgress = {
    runId: params.runId,
    kind: params.kind,
    userId: params.userId,
    startedAt: params.startedAt,
    finalized: false,
    stages,
    errors: [],
  };
  await db.doc(syncRunProgressDocPath(params.runId)).set(progress);
}

/**
 * Set (or update) a stage's shard count. Used when a stage is enqueued after the
 * previous stage's barrier (the downstream shard counts are unknown at open). A
 * plain merge write — no transaction needed (a single writer per stage-open).
 */
export async function setStageShardCount(
  db: Firestore,
  runId: string,
  stage: SyncStage,
  shardCount: number,
): Promise<void> {
  await db
    .doc(syncRunProgressDocPath(runId))
    .set({ stages: { [stage]: { shardCount } } }, { merge: true } as Record<
      string,
      unknown
    >);
}

/** Stage-specific counter deltas to roll up on the staging doc. */
export interface StageCounterDeltas {
  titlesGathered?: number;
  titlesUpdated?: number;
  showsCached?: number;
  episodesWritten?: number;
}

/** Parameters for recording one shard's result. */
export interface RecordShardResultParams {
  runId: string;
  stage: SyncStage;
  shardIndex: number;
  /** Epoch ms shard start. */ startedAt: number;
  /** Epoch ms shard end. */ completedAt: number;
  synced: number;
  skipped: number;
  errored: number;
  /** Per-shard error reasons (credential-free); capped ≤ MAX_ERRORS on write. */
  errors: string[];
  /** Rolled-up stage-specific counter deltas (errorCount derives from `errored`). */
  counters?: StageCounterDeltas;
}

/** Outcome of `recordShardResult`. */
export interface RecordShardResultOutcome {
  /** True only on the shard that brings `completedShards === shardCount`. */
  isLastShardOfStage: boolean;
  /**
   * True when this call finalized the run (wrote the `sync-runs/{runId}` summary +
   * flipped `finalized`). Only ever true for the last shard of the LAST stage.
   */
  finalized: boolean;
}

function capErrors(errors: string[]): string[] {
  return errors.slice(0, MAX_ERRORS);
}

/**
 * Record a shard's result inside a Firestore transaction.
 *
 * 1. READS the shard subdoc `shards/{stage}-{shardIndex}` in the transaction; if it
 *    is already complete → NO-OP (duplicate at-least-once delivery of a succeeded
 *    shard) — no counter change, `isLastShardOfStage: false`.
 * 2. Otherwise writes the shard subdoc AND increments the stage's `completedShards`
 *    + rolled-up counters, all in the one transaction.
 * 3. If this is the last shard of the LAST stage and the run is not yet finalized,
 *    writes the `sync-runs/{runId}` summary doc ONCE and flips `finalized: true`
 *    (transactional against `finalized` — self-heals against a racing watchdog).
 */
export async function recordShardResult(
  db: Firestore,
  params: RecordShardResultParams,
): Promise<RecordShardResultOutcome> {
  const progressRef = db.doc(syncRunProgressDocPath(params.runId));
  const shardRef = db.doc(
    syncRunProgressShardDocPath(params.runId, params.stage, params.shardIndex),
  );
  const summaryRef = db.doc(syncRunDocPath(params.runId));

  return db.runTransaction(async (tx) => {
    // READ shard subdoc first (duplicate-delivery guard) — reads before writes.
    const shardSnap = await tx.get(shardRef);
    if (shardSnap.exists) {
      const existing = shardSnap.data() as ShardRecord | undefined;
      if (existing?.completedAt != null) {
        // Genuine second delivery of an already-completed shard → no-op.
        return { isLastShardOfStage: false, finalized: false };
      }
    }

    const progressSnap = await tx.get(progressRef);
    const progress = progressSnap.data() as SyncRunProgress;

    const stage = progress.stages[params.stage];
    const nextCompleted = stage.completedShards + 1;
    const counters = params.counters ?? {};

    const updatedStage: StageProgress = {
      ...stage,
      completedShards: nextCompleted,
      errorCount: stage.errorCount + params.errored,
      titlesGathered:
        (stage.titlesGathered ?? 0) + (counters.titlesGathered ?? 0),
      titlesUpdated: (stage.titlesUpdated ?? 0) + (counters.titlesUpdated ?? 0),
      showsCached: (stage.showsCached ?? 0) + (counters.showsCached ?? 0),
      episodesWritten:
        (stage.episodesWritten ?? 0) + (counters.episodesWritten ?? 0),
    };

    const errors = capErrors([...progress.errors, ...params.errors]);
    const isLastShardOfStage = nextCompleted === stage.shardCount;

    // Finalization fires when EVERY stage is complete (`completedShards ===
    // shardCount`; a 0-shard stage is trivially complete), but ONLY from a
    // TERMINAL shard (`episodeFanout`/`airingScan`). Rationale: the non-terminal
    // stages (titleSync/episodeCache) enqueue their successor stage(s) in the
    // worker's `onLastShard` AFTER this transaction returns, so at the instant a
    // non-terminal stage completes the downstream shardCounts are still 0 and
    // would spuriously read as "complete" — the terminal-stage guard suppresses
    // that premature finalization. By the time any terminal shard runs, all
    // upstream + both terminal shardCounts are already set (the cache stage sets
    // BOTH before enqueueing either), so `allStagesComplete` is authoritative and
    // the LAST of {episodeFanout, airingScan} to finish finalizes the run exactly
    // once (the read-in-txn duplicate guard keeps it once under at-least-once).
    const stagesAfter: Record<SyncStage, StageProgress> = {
      ...progress.stages,
      [params.stage]: updatedStage,
    };
    const allStagesComplete = SYNC_STAGES.every(
      (s) => stagesAfter[s].completedShards === stagesAfter[s].shardCount,
    );
    const isTerminalStage = TERMINAL_STAGES.includes(params.stage);
    const shouldFinalize =
      isTerminalStage && allStagesComplete && !progress.finalized;

    // Write shard subdoc.
    const shardRecord: ShardRecord = {
      stage: params.stage,
      shardIndex: params.shardIndex,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      synced: params.synced,
      skipped: params.skipped,
      errored: params.errored,
      errors: capErrors(params.errors),
    };
    tx.set(shardRef, shardRecord);

    // Write updated staging doc (full overwrite — consistent within the txn).
    const updatedProgress: SyncRunProgress = {
      ...progress,
      stages: { ...progress.stages, [params.stage]: updatedStage },
      errors,
      finalized: shouldFinalize ? true : progress.finalized,
    };
    tx.set(progressRef, updatedProgress);

    if (shouldFinalize) {
      const titleStage = updatedProgress.stages.titleSync;
      const errorCount = SYNC_STAGES.reduce(
        (sum, s) => sum + updatedProgress.stages[s].errorCount,
        0,
      );
      tx.set(
        summaryRef,
        syncRunToData({
          runId: progress.runId,
          kind: progress.kind,
          userId: progress.userId,
          startedAt: new Date(progress.startedAt).toISOString(),
          completedAt: new Date(params.completedAt).toISOString(),
          durationMs: params.completedAt - progress.startedAt,
          titlesGathered: titleStage.titlesGathered ?? 0,
          titlesUpdated: titleStage.titlesUpdated ?? 0,
          errorCount,
          errors,
        }),
      );
    }

    return { isLastShardOfStage, finalized: shouldFinalize };
  });
}

/** Outcome of a direct finalizer (`finalizeAsDead` / `finalizeHealthyRun`). */
export interface FinalizeAsDeadOutcome {
  /** True when this call wrote the summary (run was not yet finalized). */
  wroteSummary: boolean;
}

/**
 * Healthy direct finalizer for a run whose completion is NOT signalled by the
 * `recordShardResult` terminal-stage barrier (which needs at least one terminal
 * shard to fire). Two cases use it:
 *  - the coordinator's 0-toSync path — a title pass that filtered every title as
 *    fresh, a healthy no-op with **no shards at all** (nothing to record, so the
 *    barrier never fires); and
 *  - the fan-out/airing cascade's no-per-user-work path — when the run has 0 TV
 *    fan-out assignments AND 0 airing uids, both terminal stages have 0 shards, so
 *    no terminal shard runs to fire the barrier (`enqueueFanoutAndAiringStages`).
 *
 * Transactional on `finalized` (mirrors `finalizeAsDead` / the barrier): a run
 * already finalized (normally, or by the watchdog) → NO-OP; otherwise it writes the
 * `sync-runs/{runId}` summary from the staging doc's rolled-up counters with a
 * **normal (non-error) outcome** and flips `finalized: true`. Because it targets
 * the same `sync-runs/{runId}` doc id as the other finalizers, a racing watchdog
 * self-heals to a single summary.
 */
export async function finalizeHealthyRun(
  db: Firestore,
  runId: string,
  now: number,
): Promise<FinalizeAsDeadOutcome> {
  const progressRef = db.doc(syncRunProgressDocPath(runId));
  const summaryRef = db.doc(syncRunDocPath(runId));

  return db.runTransaction(async (tx) => {
    const progressSnap = await tx.get(progressRef);
    if (!progressSnap.exists) {
      return { wroteSummary: false };
    }
    const progress = progressSnap.data() as SyncRunProgress;
    if (progress.finalized) {
      return { wroteSummary: false };
    }

    const titleStage = progress.stages.titleSync;
    const errorCount = SYNC_STAGES.reduce(
      (sum, s) => sum + progress.stages[s].errorCount,
      0,
    );

    tx.set(
      summaryRef,
      syncRunToData({
        runId: progress.runId,
        kind: progress.kind,
        userId: progress.userId,
        startedAt: new Date(progress.startedAt).toISOString(),
        completedAt: new Date(now).toISOString(),
        durationMs: now - progress.startedAt,
        titlesGathered: titleStage.titlesGathered ?? 0,
        titlesUpdated: titleStage.titlesUpdated ?? 0,
        errorCount,
        errors: progress.errors,
      }),
    );
    tx.set(progressRef, { ...progress, finalized: true });

    return { wroteSummary: true };
  });
}

/**
 * Watchdog dead-run finalizer. Transactional on `finalized`:
 *  - already finalized (or no staging doc) → NO-OP (`wroteSummary: false`);
 *  - otherwise write the `sync-runs/{runId}` summary with an ERROR outcome
 *    (incomplete-stages message, `errorCount > 0`, `completedAt` = now) and flip
 *    `finalized: true`.
 *
 * Because both finalization paths target the same `sync-runs/{runId}` doc id, a
 * late real finalization racing this watchdog write self-heals to one summary.
 */
export async function finalizeAsDead(
  db: Firestore,
  runId: string,
  now: number,
): Promise<FinalizeAsDeadOutcome> {
  const progressRef = db.doc(syncRunProgressDocPath(runId));
  const summaryRef = db.doc(syncRunDocPath(runId));

  return db.runTransaction(async (tx) => {
    const progressSnap = await tx.get(progressRef);
    if (!progressSnap.exists) {
      return { wroteSummary: false };
    }
    const progress = progressSnap.data() as SyncRunProgress;
    if (progress.finalized) {
      return { wroteSummary: false };
    }

    const incomplete = SYNC_STAGES.filter(
      (s) => progress.stages[s].completedShards < progress.stages[s].shardCount,
    ).map(
      (s) =>
        `${s} ${progress.stages[s].completedShards}/${progress.stages[s].shardCount}`,
    );
    const deadMessage = `run did not complete: ${incomplete.join(', ')}`;

    const stageErrorCount = SYNC_STAGES.reduce(
      (sum, s) => sum + progress.stages[s].errorCount,
      0,
    );
    // Guarantee a nonzero error count so the dead run is visibly errored, even
    // when no per-item errors were recorded before the run stalled.
    const errorCount = stageErrorCount + incomplete.length;
    const errors = capErrors([...progress.errors, deadMessage]);
    const titleStage = progress.stages.titleSync;

    tx.set(
      summaryRef,
      syncRunToData({
        runId: progress.runId,
        kind: progress.kind,
        userId: progress.userId,
        startedAt: new Date(progress.startedAt).toISOString(),
        completedAt: new Date(now).toISOString(),
        durationMs: now - progress.startedAt,
        titlesGathered: titleStage.titlesGathered ?? 0,
        titlesUpdated: titleStage.titlesUpdated ?? 0,
        errorCount,
        errors,
      }),
    );
    tx.set(progressRef, { ...progress, finalized: true });

    return { wroteSummary: true };
  });
}

// --- Staged fan-out data (`sync-run-progress/{runId}/staged/*`) ---------------
//
// The single consolidated coordinator gather (T8) emits, besides the distinct
// titles it shards for `titleSync`, the downstream stages' inputs: the TV episode
// fan-out ASSIGNMENTS `{ uid, titleId, tmdbId }`, the distinct SHOW tmdbIds, and
// the distinct UIDs. At design scale (100k users × shows) these sets can exceed
// the 1 MB Firestore doc limit even chunked, so they live in their OWN
// subcollection (like `shards/*`) — NOT as fields on the progress doc — one
// bounded chunk per doc. `episodeCacheWorker` reads `shows`; the fan-out cascade
// reads `assignments` + `uids`. `persistStagedData` is the WRITE helper T8 calls
// from the coordinator; the `read*` helpers are what the workers consume here.

/** `sync-run-progress/{runId}/staged` — the chunked staged-input subcollection. */
export function syncRunProgressStagedCollection(runId: string): string {
  return `${syncRunProgressDocPath(runId)}/staged`;
}

/** The discriminator distinguishing the three staged input kinds. */
export type StagedKind = 'assignments' | 'shows' | 'uids';

/** `sync-run-progress/{runId}/staged/{kind}-{index}` — one bounded chunk doc. */
export function syncRunProgressStagedDocPath(
  runId: string,
  kind: StagedKind,
  index: number,
): string {
  return `${syncRunProgressStagedCollection(runId)}/${kind}-${index}`;
}

/**
 * Per-kind chunk sizes. Bounded so each staged chunk doc stays well under the 1 MB
 * Firestore doc limit: assignments carry three fields (a uid, a titleId, a number)
 * so they are chunked smaller than the scalar `shows`/`uids` lists.
 */
export const STAGED_ASSIGNMENTS_CHUNK = 2000;
export const STAGED_SHOWS_CHUNK = 5000;
export const STAGED_UIDS_CHUNK = 5000;

/** One TV episode fan-out assignment (TV only). */
export interface StagedAssignment {
  uid: string;
  titleId: string;
  tmdbId: number;
}

/** The consolidated gather's downstream-stage inputs (T8 persists these). */
export interface StagedData {
  assignments: StagedAssignment[];
  shows: number[];
  uids: string[];
}

/** The persisted shape of one staged chunk doc. */
interface StagedChunkDoc {
  kind: StagedKind;
  index: number;
  items: unknown[];
}

/** Firestore batched-write op limit. */
const STAGED_BATCH_LIMIT = 500;

/**
 * Persist the coordinator gather's downstream inputs for a run as chunked docs
 * under `sync-run-progress/{runId}/staged/*` (T8 calls this from `main.ts`). Each
 * kind is split into bounded chunks (`{ kind, index, items }`); an empty kind
 * writes no doc. Writes are batched at the 500-op Firestore limit. Idempotent by
 * doc id (`{kind}-{index}`) — a retried gather rewrites the same chunk docs.
 */
export async function persistStagedData(
  db: Firestore,
  runId: string,
  data: StagedData,
): Promise<void> {
  const docs: { path: string; doc: StagedChunkDoc }[] = [];
  const pushChunks = (kind: StagedKind, size: number, items: unknown[]) => {
    let index = 0;
    for (let i = 0; i < items.length; i += size) {
      docs.push({
        path: syncRunProgressStagedDocPath(runId, kind, index),
        doc: { kind, index, items: items.slice(i, i + size) },
      });
      index++;
    }
  };
  pushChunks('assignments', STAGED_ASSIGNMENTS_CHUNK, data.assignments);
  pushChunks('shows', STAGED_SHOWS_CHUNK, data.shows);
  pushChunks('uids', STAGED_UIDS_CHUNK, data.uids);

  for (let i = 0; i < docs.length; i += STAGED_BATCH_LIMIT) {
    const batch = db.batch();
    for (const { path, doc } of docs.slice(i, i + STAGED_BATCH_LIMIT)) {
      batch.set(db.doc(path), doc);
    }
    await batch.commit();
  }
}

/** Read + concatenate all chunk docs of one kind (ordered by chunk index). */
async function readStagedKind<T>(
  db: Firestore,
  runId: string,
  kind: StagedKind,
): Promise<T[]> {
  const snap = await db
    .collection(syncRunProgressStagedCollection(runId))
    .get();
  const chunks = snap.docs
    .map((d) => d.data() as StagedChunkDoc)
    .filter((c) => c?.kind === kind)
    .sort((a, b) => a.index - b.index);
  const out: T[] = [];
  for (const c of chunks) out.push(...(c.items as T[]));
  return out;
}

/** Distinct TV show tmdbIds staged for the run (empty when none/unpersisted). */
export function readStagedShows(
  db: Firestore,
  runId: string,
): Promise<number[]> {
  return readStagedKind<number>(db, runId, 'shows');
}

/** TV episode fan-out assignments staged for the run (empty when none). */
export function readStagedAssignments(
  db: Firestore,
  runId: string,
): Promise<StagedAssignment[]> {
  return readStagedKind<StagedAssignment>(db, runId, 'assignments');
}

/** Distinct uids staged for the run's airing scan (empty when none). */
export function readStagedUids(
  db: Firestore,
  runId: string,
): Promise<string[]> {
  return readStagedKind<string>(db, runId, 'uids');
}
