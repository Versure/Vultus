/**
 * Thin Firestore/Admin-SDK glue for the `syncTitles` handler. Logic-free: the
 * pure helpers (auth/gather/staleness/rate-limit) carry the testable logic; this
 * file only touches the SDK.
 *
 *  - `gatherWatchlistTitles` — `collectionGroup('watchlist')` scan projecting
 *    each doc to `{ tmdbId, type }` (raw fields, no converter — avoids the
 *    `addedAt` Timestamp). NO where/orderBy → needs no composite index.
 *  - `readSyncState` / `writeSyncState` — the `system/sync` rate-limit doc.
 *  - `verifyIdToken` — wraps `getAuth().verifyIdToken` for the injected verifier.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { COLLECTIONS } from '@vultus/shared/firestore-schema';
import type { GatheredTitle } from './gather';

/** Top-level rate-limit / idempotency doc path (`system/sync`). */
export const SYNC_STATE_DOC = 'system/sync';

export interface SyncState {
  /** Epoch ms of the last completed run, or null if never run. */
  lastRunAt: number | null;
}

/**
 * Gather every tracked title across ALL users via a collection-group scan,
 * projecting each watchlist doc to its raw `{ tmdbId, type }` fields. Not
 * deduped here — `dedupeTitles` handles that downstream.
 */
export async function gatherWatchlistTitles(
  db: Firestore,
): Promise<GatheredTitle[]> {
  const snap = await db.collectionGroup(COLLECTIONS.watchlist).get();
  return snap.docs.map((doc) => {
    const data = doc.data() as { tmdbId: number; type: GatheredTitle['type'] };
    return { tmdbId: data.tmdbId, type: data.type };
  });
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
