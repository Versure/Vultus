import { Injectable, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Firestore,
  collection,
  collectionData,
  deleteDoc,
  doc,
  docData,
  getDocs,
  updateDoc,
  writeBatch,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type EpisodeDoc,
  type Region,
  type RegionAvailability,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  dataToAvailability,
  dataToEpisode,
  dataToUser,
  dataToWatchlistItem,
  episodesPath,
  notificationsPath,
  userPath,
  watchlistItemPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type {
  EpisodeReadData,
  RegionAvailabilityReadData,
  UserReadData,
  WatchlistItemReadData,
} from '@vultus/shared/firestore-schema';
import { Observable, map, of, shareReplay, switchMap } from 'rxjs';

/**
 * Display order for status grouping / the status action-sheet. Deliberately
 * NOT the `WATCH_STATUSES` order — the UI groups Watching → Planned →
 * Completed → Dropped.
 */
export const STATUS_DISPLAY_ORDER: WatchStatus[] = [
  'watching',
  'planned',
  'completed',
  'dropped',
];

/** Human-readable label per status (slice-local UI vocabulary). */
export const STATUS_LABELS: Record<WatchStatus, string> = {
  watching: 'Watching',
  planned: 'Planned',
  completed: 'Completed',
  dropped: 'Dropped',
};

export interface StatusGroup {
  status: WatchStatus;
  label: string;
  count: number;
  items: WatchlistItem[];
}

/** Groups items by status in display order, omitting empty groups. */
export function groupByStatus(items: WatchlistItem[]): StatusGroup[] {
  return STATUS_DISPLAY_ORDER.map((status) => {
    const groupItems = items.filter((i) => i.status === status);
    return {
      status,
      label: STATUS_LABELS[status],
      count: groupItems.length,
      items: groupItems,
    };
  }).filter((g) => g.count > 0);
}

/** Filters items to a single title type; undefined → no filtering. */
export function filterByType(
  items: WatchlistItem[],
  type?: TitleType,
): WatchlistItem[] {
  if (!type) {
    return items;
  }
  return items.filter((i) => i.type === type);
}

/** The six sort modes the toolbar offers. Default is 'addedDesc'. */
export type WatchlistSort =
  | 'titleAsc'
  | 'titleDesc'
  | 'addedDesc' // newest first (DEFAULT)
  | 'addedAsc' // oldest first
  | 'releaseDesc' // newest release first
  | 'releaseAsc'; // oldest release first

/**
 * Pure, stable sort of a single status group's items (slice-local, used by
 * `WatchlistPage` per group). Does NOT mutate the input — returns a copy.
 * Binding tie-breaks:
 * - title sorts: case-insensitive locale compare on `title`.
 * - added sorts: compare `addedAt` (ISO string) ascending/descending.
 * - release sorts: items with `releaseDate` null/absent sort to the END in BOTH
 *   directions (a missing date is never "newest" or "oldest"); present dates
 *   compare by ISO string.
 */
export function sortItems(
  items: WatchlistItem[],
  sort: WatchlistSort,
): WatchlistItem[] {
  const copy = items.slice();
  switch (sort) {
    case 'titleAsc':
      return copy.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
    case 'titleDesc':
      return copy.sort((a, b) =>
        b.title.localeCompare(a.title, undefined, { sensitivity: 'base' }),
      );
    case 'addedDesc':
      return copy.sort((a, b) =>
        a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0,
      );
    case 'addedAsc':
      return copy.sort((a, b) =>
        a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0,
      );
    case 'releaseDesc':
      return copy.sort((a, b) => compareRelease(a, b, 'desc'));
    case 'releaseAsc':
      return copy.sort((a, b) => compareRelease(a, b, 'asc'));
  }
}

/**
 * Release-date comparator: null/absent `releaseDate` always sorts to the END
 * regardless of direction; two present dates compare by ISO string.
 */
function compareRelease(
  a: WatchlistItem,
  b: WatchlistItem,
  dir: 'asc' | 'desc',
): number {
  const ar = a.releaseDate ?? null;
  const br = b.releaseDate ?? null;
  if (ar === null && br === null) {
    return 0;
  }
  if (ar === null) {
    return 1; // a (missing) after b
  }
  if (br === null) {
    return -1; // b (missing) after a
  }
  const cmp = ar < br ? -1 : ar > br ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

/**
 * Unique, sorted (case-insensitive A→Z) list of provider names present across
 * the given items, looked up by tmdbId in the availability map. Items with no
 * entry (or an empty array) contribute nothing. Returns `[]` when the map yields
 * no providers (→ the page hides the provider chip row). Slice-local, pure.
 */
export function getAvailableProviders(
  items: WatchlistItem[],
  availabilityMap: Map<number, string[]>,
): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const names = availabilityMap.get(item.tmdbId);
    if (!names) {
      continue;
    }
    for (const name of names) {
      seen.add(name);
    }
  }
  return [...seen].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

/**
 * Watchlist data-access for the Vultus watchlist tab (spec 0014, PLAN §6 item
 * 18). Reads `users/{uid}/watchlist` (realtime), `users/{uid}` (region) and
 * `title-cache/{tmdbId}/availability/{region}` (provider badges); mutates only
 * `users/{uid}/watchlist/{titleId}` (status update / delete).
 *
 * SHERIFF: obtains the uid via the `scope:shared` `AUTH_UID` token (provided by
 * the shell), never by importing `apps/mobile`. Injects AngularFire `Firestore`
 * (third-party) directly. All reads/writes are keyed on the resolved uid; a
 * null uid is a no-op / empty stream.
 */
@Injectable({ providedIn: 'root' })
export class WatchlistService {
  private readonly firestore = inject(Firestore);
  // Injected so the service is self-contained; the page passes the uid value
  // explicitly to keep the stream re-subscribable on type change.
  private readonly uid = inject(AUTH_UID);

  /**
   * Realtime watchlist for `uid`, mapped to domain `WatchlistItem`s and
   * optionally filtered by `type`. Null uid → empty stream.
   */
  watchlist$(
    uid: string | null,
    type?: TitleType,
  ): Observable<WatchlistItem[]> {
    if (!uid) {
      return of([]);
    }
    const col = collection(this.firestore, watchlistPath(uid));
    return (collectionData(col) as Observable<WatchlistItemReadData[]>).pipe(
      map((docs) => docs.map((d) => dataToWatchlistItem(d))),
      map((items) => filterByType(items, type)),
    );
  }

  /**
   * Count of the user's UNREAD notifications (`readAt === null`), reactive to the
   * `AUTH_UID` signal transitioning null → uid as the anonymous session resolves.
   * Drives the watchlist header bell badge (spec 0042, decision 3 / §4 note).
   *
   * Reads `users/{uid}/notifications` (a `scope:shared` schema path via
   * `notificationsPath`, NOT a cross-slice import) and counts `readAt` null/absent
   * CLIENT-SIDE over the streamed collection — deliberately the index-free path
   * (no `where('readAt','==',null)` query, no `firestore.indexes.json` entry; §4
   * unread-count note). The wire `readAt` is a Timestamp-or-null, so "unread" =
   * `readAt == null` (covers both an explicit `null` and an absent field). Null
   * uid → `0`.
   */
  readonly unreadNotificationCount$: Observable<number> = toObservable(
    this.uid,
  ).pipe(
    switchMap((uid) => {
      if (!uid) {
        return of(0);
      }
      const col = collection(this.firestore, notificationsPath(uid));
      return (collectionData(col) as Observable<{ readAt?: unknown }[]>).pipe(
        map((docs) => docs.filter((d) => d.readAt == null).length),
      );
    }),
  );

  /**
   * Updates the `status` field on a watchlist item. Null uid → no-op.
   *
   * Completed-marks-episodes side effect (spec 0053): when the NEW status is
   * `'completed'` AND `type === 'tv'`, every currently-unwatched episode under
   * `users/{uid}/watchlist/{titleId}/episodes` is batch-marked
   * `{ watched: true, watchedAt: <now> }` before the status write. Movies and
   * TV shows whose episodes are all already watched / not-yet-synced are cheap
   * no-ops (the emptiness check IS the guard — no extra status read, decision 7).
   * Moving status AWAY from `'completed'` never touches episodes (decision 6).
   *
   * Returns a `Promise<void>` so tests can await the batch effect; the page
   * still calls it fire-and-forget (`void`).
   */
  async updateStatus(
    uid: string | null,
    titleId: string,
    status: WatchStatus,
    type: TitleType,
  ): Promise<void> {
    if (!uid) {
      return;
    }
    if (status === 'completed' && type === 'tv') {
      await this.markAllEpisodesWatched(uid, titleId);
    }
    await updateDoc(doc(this.firestore, watchlistItemPath(uid, titleId)), {
      status,
    });
  }

  /**
   * Batch-marks every currently-unwatched episode of a TV title watched
   * (spec 0053). Reads the WHOLE `users/{uid}/watchlist/{titleId}/episodes`
   * subcollection one-shot (no `where` — every season, since "completed" means
   * the entire show), then `writeBatch`-updates `{ watched: true, watchedAt:
   * <now> }` onto ONLY the docs currently `watched !== true`. If there are zero
   * unwatched docs (all already watched, or an empty / not-yet-synced
   * subcollection) the commit is skipped entirely. No `setDoc` — episode docs
   * are created by the sync engine and must pre-exist; this only updates them.
   *
   * Slice-local, deliberately independent of the equivalent title-detail helper
   * (2-slice duplication, short of the 3+-slice extract rule — spec decision 1).
   */
  private async markAllEpisodesWatched(
    uid: string,
    titleId: string,
  ): Promise<void> {
    const snap = await getDocs(
      collection(this.firestore, episodesPath(uid, titleId)),
    );
    const batch = writeBatch(this.firestore);
    const watchedAt = new Date();
    let unwatchedCount = 0;
    for (const docSnap of snap.docs) {
      const episode: EpisodeDoc = dataToEpisode(
        docSnap.data() as EpisodeReadData,
      );
      if (episode.watched !== true) {
        batch.update(docSnap.ref, { watched: true, watchedAt });
        unwatchedCount++;
      }
    }
    if (unwatchedCount === 0) {
      return;
    }
    await batch.commit();
  }

  /** Deletes a watchlist item. Null uid → no-op. */
  removeTitle(uid: string | null, titleId: string): void {
    if (!uid) {
      return;
    }
    void deleteDoc(doc(this.firestore, watchlistItemPath(uid, titleId)));
  }

  /**
   * Memoized `users/{uid}` docData streams, keyed by uid. Both `userRegion$` and
   * `myProviderIds$` derive from this single shared source so only ONE Firestore
   * Listen channel is opened per user doc — mapping to `region` and
   * `myProviderIds` are two projections of the same stream, not two listeners.
   * `shareReplay({ refCount: false })` keeps the underlying subscription (and its
   * listener) alive and stable across the page's `| async` re-subscriptions.
   */
  private readonly userCache = new Map<
    string,
    Observable<UserReadData | undefined>
  >();

  private user$(uid: string): Observable<UserReadData | undefined> {
    let stream = this.userCache.get(uid);
    if (!stream) {
      stream = (
        docData(doc(this.firestore, userPath(uid))) as Observable<
          UserReadData | undefined
        >
      ).pipe(shareReplay({ bufferSize: 1, refCount: false }));
      this.userCache.set(uid, stream);
    }
    return stream;
  }

  /** The user's persisted region; null uid / missing doc → null. */
  userRegion$(uid: string | null): Observable<Region | null> {
    if (!uid) {
      return of(null);
    }
    return this.user$(uid).pipe(
      map((data) => (data ? dataToUser(data).region : null)),
    );
  }

  /**
   * The user's selected provider ids (`users/{uid}.myProviderIds`, spec 0060),
   * default `[]` (via `dataToUser`, which coalesces a legacy doc missing the
   * field to `[]`). Null uid / missing doc → `[]`. Reads the SAME memoized
   * `user$` stream as `userRegion$` — no second listener on `users/{uid}`.
   */
  myProviderIds$(uid: string | null): Observable<number[]> {
    if (!uid) {
      return of<number[]>([]);
    }
    return this.user$(uid).pipe(
      map((data) => (data ? dataToUser(data).myProviderIds : [])),
    );
  }

  /**
   * Provider availability for a title in a region (for the provider badge).
   * Null region / missing doc → null.
   */
  availability$(
    tmdbId: number,
    region: Region | null,
  ): Observable<RegionAvailability | null> {
    if (!region) {
      return of(null);
    }
    return (
      docData(
        doc(this.firestore, availabilityDocPath(tmdbId, region)),
      ) as Observable<RegionAvailabilityReadData | undefined>
    ).pipe(map((data) => (data ? dataToAvailability(data) : null)));
  }
}
