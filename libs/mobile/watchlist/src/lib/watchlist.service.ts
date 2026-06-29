import { Injectable, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Firestore,
  collection,
  collectionData,
  deleteDoc,
  doc,
  docData,
  updateDoc,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type Region,
  type RegionAvailability,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  dataToAvailability,
  dataToUser,
  dataToWatchlistItem,
  notificationsPath,
  userPath,
  watchlistItemPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type {
  RegionAvailabilityReadData,
  UserReadData,
  WatchlistItemReadData,
} from '@vultus/shared/firestore-schema';
import { Observable, map, of, switchMap } from 'rxjs';

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

  /** Updates only the `status` field on a watchlist item. Null uid → no-op. */
  updateStatus(uid: string | null, titleId: string, status: WatchStatus): void {
    if (!uid) {
      return;
    }
    void updateDoc(doc(this.firestore, watchlistItemPath(uid, titleId)), {
      status,
    });
  }

  /** Deletes a watchlist item. Null uid → no-op. */
  removeTitle(uid: string | null, titleId: string): void {
    if (!uid) {
      return;
    }
    void deleteDoc(doc(this.firestore, watchlistItemPath(uid, titleId)));
  }

  /** The user's persisted region; null uid / missing doc → null. */
  userRegion$(uid: string | null): Observable<Region | null> {
    if (!uid) {
      return of(null);
    }
    return (
      docData(doc(this.firestore, userPath(uid))) as Observable<
        UserReadData | undefined
      >
    ).pipe(map((data) => (data ? dataToUser(data).region : null)));
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
