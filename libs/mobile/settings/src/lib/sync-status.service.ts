import { Injectable, inject, signal } from '@angular/core';
import {
  Firestore,
  collection,
  getDocs,
  limit,
  orderBy,
  query,
} from '@angular/fire/firestore';
import type { SyncRun } from '@vultus/shared/domain';
import {
  dataToSyncRun,
  syncRunsCollection,
  type SyncRunReadData,
} from '@vultus/shared/firestore-schema';

/**
 * Read-only data-access for the Settings "Last synced" card (spec 0049).
 *
 * One-shot reads the single most-recent run from the global `sync-runs`
 * collection (`orderBy('startedAt','desc')`, `limit(1)`) and maps it through
 * the shared `dataToSyncRun` converter. A fresh read on page open is enough —
 * the card is informational, so no live subscription is kept.
 *
 * The query is NOT uid-scoped: a cron run records `userId: null` (covers all
 * users) and the card just answers "did the pipeline run?", so this slice needs
 * no uid at all.
 *
 * SHERIFF: this slice injects AngularFire `Firestore` (third-party) directly and
 * imports only `@vultus/shared/domain` (`SyncRun`) + `@vultus/shared/firestore-schema`
 * (`syncRunsCollection`, `dataToSyncRun`) — both `scope:shared`. It imports no
 * other slice, no `apps/mobile`, and no `scope:functions` code. It only READS
 * `sync-runs`; client writes are denied by `firestore.rules`.
 */
@Injectable()
export class SyncStatusService {
  private readonly firestore = inject(Firestore);

  private readonly _lastRun = signal<SyncRun | null>(null);
  private readonly _loaded = signal<boolean>(false);
  private readonly _loadFailed = signal<boolean>(false);

  /** The most-recent sync run, or null when none has happened (never-synced). */
  readonly lastRun = this._lastRun.asReadonly();
  /**
   * True once a `load()` attempt has settled — render-gate for the card.
   * Resolves on BOTH success and failure (see `load()`'s `finally`), so a
   * failed read never leaves the card stuck on its skeleton.
   */
  readonly loaded = this._loaded.asReadonly();
  /**
   * True when the last `load()` attempt threw (e.g. Firestore offline / read
   * denied). This is non-essential observability: the card silently falls back
   * to the never-synced display, so a failure never surfaces to the user.
   */
  readonly loadFailed = this._loadFailed.asReadonly();

  /** One-shot read of the single most-recent `sync-runs` document. */
  async load(): Promise<void> {
    this._loadFailed.set(false);

    try {
      const q = query(
        collection(this.firestore, syncRunsCollection()),
        orderBy('startedAt', 'desc'),
        limit(1),
      );
      const snap = await getDocs(q);

      const first = snap.docs[0];
      this._lastRun.set(
        first ? dataToSyncRun(first.data() as SyncRunReadData) : null,
      );
    } catch (error) {
      // Best-effort: the "Last synced" card is non-blocking observability. A
      // failed read leaves `lastRun` null (renders as never-synced) and never
      // surfaces an error. `_loadFailed` is set for observability only.
      console.error('[SyncStatusService] load() failed:', error);
      this._loadFailed.set(true);
    } finally {
      // ALWAYS resolve the render-gate — on success AND on failure. With
      // `lastRun` left null on a failed read, the card then renders identically
      // to never-synced (sync-outline / "Never synced"), never a perpetual
      // skeleton. This is the spec's pinned contract: loadFailed renders the
      // same as never-synced.
      this._loaded.set(true);
    }
  }
}
