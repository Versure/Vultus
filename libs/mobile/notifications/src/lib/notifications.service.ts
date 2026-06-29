import { Injectable, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Firestore,
  Timestamp,
  collection,
  collectionData,
  deleteDoc,
  doc,
  docData,
  limit,
  orderBy,
  query,
  updateDoc,
  writeBatch,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import type { NotificationDoc } from '@vultus/shared/domain';
import {
  dataToNotification,
  dataToTitleCache,
  notificationPath,
  notificationsPath,
  titleCacheDocPath,
} from '@vultus/shared/firestore-schema';
import type {
  NotificationReadData,
  TitleCacheReadData,
} from '@vultus/shared/firestore-schema';
import { type Observable, map, of, switchMap } from 'rxjs';

/** TMDB poster image base — copied from the watchlist slice (`watchlist.page.ts`
 *  line 57) per spec 0042 §6; NOT imported cross-slice. */
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

/** A list row = the domain doc + its real Firestore id (idField), for
 *  mark-read / delete (spec 0042 §5). */
export interface NotificationRow extends NotificationDoc {
  id: string;
}

/**
 * Notifications data-access for the in-app inbox (spec 0042). Reads
 * `users/{uid}/notifications` (realtime, `sentAt` desc, limit 50) and
 * `title-cache/{tmdbId}` (poster, read-only); mutates only
 * `users/{uid}/notifications/{id}` (`readAt` update on tap / mark-all-read, and
 * swipe-delete). It NEVER writes `title-cache`.
 *
 * SHERIFF: obtains the uid via the `scope:shared` `AUTH_UID` token (provided by
 * the shell), never by importing `apps/mobile`. Injects AngularFire `Firestore`
 * (third-party) directly. `AUTH_UID` starts `null` and transitions to the uid
 * when anonymous auth resolves, so the realtime stream reacts to it via
 * `toObservable(uid)` → `switchMap` (rather than reading it once); a null uid is
 * an empty stream / no-op write, never a throw on an undefined path.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly firestore = inject(Firestore);
  private readonly uid = inject(AUTH_UID);
  private readonly uid$ = toObservable(this.uid);

  /**
   * Realtime inbox: `users/{uid}/notifications`, `sentAt` desc, `limit(50)`,
   * each row carrying its real Firestore doc id (`idField`), mapped to
   * `NotificationRow`. Reacts to the null→uid transition; null uid → `of([])`
   * (no collection ref built).
   */
  notifications$(): Observable<NotificationRow[]> {
    return this.uid$.pipe(
      switchMap((uid) => {
        if (!uid) {
          return of<NotificationRow[]>([]);
        }
        const col = collection(this.firestore, notificationsPath(uid));
        const q = query(col, orderBy('sentAt', 'desc'), limit(50));
        return (
          collectionData(q, { idField: 'id' }) as Observable<
            (NotificationReadData & { id: string })[]
          >
        ).pipe(
          map((docs) =>
            docs.map((d) => ({ ...dataToNotification(d), id: d.id })),
          ),
        );
      }),
    );
  }

  /**
   * Full poster URL for a `tmdbId` from `title-cache`, or `null` (→ the
   * kind-based icon placeholder). Best-effort: a missing cache doc or a null
   * `posterPath` emits `null`, never throws.
   */
  posterUrl$(tmdbId: number): Observable<string | null> {
    return (
      docData(doc(this.firestore, titleCacheDocPath(tmdbId))) as Observable<
        TitleCacheReadData | undefined
      >
    ).pipe(
      map((data) => {
        if (!data) {
          return null;
        }
        const posterPath = dataToTitleCache(data).metadata.posterPath;
        return posterPath ? TMDB_POSTER_BASE + posterPath : null;
      }),
    );
  }

  /** Set `readAt` on one notification. Null uid → no-op; best-effort. */
  async markRead(id: string): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    try {
      await updateDoc(doc(this.firestore, notificationPath(uid, id)), {
        readAt: Timestamp.now(),
      });
    } catch {
      // Best-effort: a failed mark-read must not crash the page.
    }
  }

  /**
   * Batch-set `readAt` on all currently-unread ids via a `writeBatch`. Empty
   * array → no commit. Null uid → no-op; best-effort.
   */
  async markAllRead(unreadIds: string[]): Promise<void> {
    const uid = this.uid();
    if (!uid || unreadIds.length === 0) {
      return;
    }
    try {
      const batch = writeBatch(this.firestore);
      for (const id of unreadIds) {
        batch.update(doc(this.firestore, notificationPath(uid, id)), {
          readAt: Timestamp.now(),
        });
      }
      await batch.commit();
    } catch {
      // Best-effort.
    }
  }

  /** Delete one notification. Null uid → no-op; best-effort. */
  async remove(id: string): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    try {
      await deleteDoc(doc(this.firestore, notificationPath(uid, id)));
    } catch {
      // Best-effort.
    }
  }
}
