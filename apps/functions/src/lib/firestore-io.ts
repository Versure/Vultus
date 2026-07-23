/**
 * Thin Firestore/Admin-SDK glue for the `syncTitles` handler. Logic-free: the
 * pure helpers (auth/gather/staleness/rate-limit) carry the testable logic; this
 * file only touches the SDK.
 *
 *  - `gatherWatchlistEntries` — the ONE consolidated `collectionGroup('watchlist')`
 *    scan (spec 0101) projecting each doc to `{ uid, titleId, tmdbId, type }` (raw
 *    fields, no converter — avoids the `addedAt` Timestamp; `uid` = the parent user
 *    doc id, `titleId` = the watchlist doc id). NO where/orderBy → needs no composite
 *    index. Feeds `consolidateGather`, which folds it into the title / episode-cache /
 *    fan-out / airing-scan stage inputs — the pipeline's single per-run gather.
 *  - `readSyncState` / `writeSyncState` — the `system/sync` rate-limit doc.
 *  - `verifyIdToken` — wraps `getAuth().verifyIdToken` for the injected verifier.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import {
  COLLECTIONS,
  syncRunsCollection,
  syncRunToData,
} from '@vultus/shared/firestore-schema';
import type { SyncRun } from '@vultus/shared/domain';
import type { GatheredEntry } from './gather';

/** Top-level rate-limit / idempotency doc path (`system/sync`). */
export const SYNC_STATE_DOC = 'system/sync';

export interface SyncState {
  /** Epoch ms of the last completed run, or null if never run. */
  lastRunAt: number | null;
}

/**
 * The ONE consolidated nightly gather (spec 0101): enumerate every tracked title
 * across ALL users via a single collection-group scan, projecting each watchlist doc
 * to its raw `{ uid, titleId, tmdbId, type }` (no converter — avoids the `addedAt`
 * Timestamp). `uid` is the parent user doc id; `titleId` is the watchlist doc id.
 * Not deduped/consolidated here — `consolidateGather` folds these entries into the
 * per-stage inputs downstream. A malformed doc (missing `tmdbId`/`type`, or an
 * unexpected top-level doc with no parent user) is skipped.
 */
export async function gatherWatchlistEntries(
  db: Firestore,
): Promise<GatheredEntry[]> {
  const snap = await db.collectionGroup(COLLECTIONS.watchlist).get();
  const entries: GatheredEntry[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as {
      tmdbId?: number;
      type?: GatheredEntry['type'];
    };
    if (typeof data.tmdbId !== 'number') continue;
    if (data.type !== 'movie' && data.type !== 'tv') continue;
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    entries.push({
      uid,
      titleId: doc.ref.id,
      tmdbId: data.tmdbId,
      type: data.type,
    });
  }
  return entries;
}

/** Read the `system/sync` rate-limit doc; absent → `lastRunAt: null`. */
export async function readSyncState(db: Firestore): Promise<SyncState> {
  const snap = await db.doc(SYNC_STATE_DOC).get();
  if (!snap.exists) {
    return { lastRunAt: null };
  }
  const data = snap.data() as { lastRunAt?: number } | undefined;
  return { lastRunAt: data?.lastRunAt ?? null };
}

/** Record this run on `system/sync` (`lastRunAt` end, `lastRunStartedAt` start). */
export async function writeSyncState(
  db: Firestore,
  lastRunAt: number,
  lastRunStartedAt: number,
): Promise<void> {
  await db.doc(SYNC_STATE_DOC).set({ lastRunAt, lastRunStartedAt });
}

/** Verify a Firebase Auth ID token via the Admin SDK. Rejects on invalid. */
export async function verifyIdToken(token: string): Promise<unknown> {
  return getAuth().verifyIdToken(token);
}

/** Write one completed sync run to `sync-runs/{runId}` (auto-id == runId). */
export async function writeSyncRun(
  db: Firestore,
  run: Omit<SyncRun, 'runId'>,
): Promise<string> {
  const ref = db.collection(syncRunsCollection()).doc(); // auto-id
  const runId = ref.id;
  await ref.set(syncRunToData({ ...run, runId }));
  return runId;
}
