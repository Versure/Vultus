import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  docData,
  getDocs,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type EpisodeDoc,
  type Region,
  type RegionAvailability,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  dataToAvailability,
  dataToEpisode,
  dataToUser,
  dataToWatchlistItem,
  episodesPath,
  userPath,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import type {
  EpisodeReadData,
  RegionAvailabilityReadData,
  UserReadData,
  WatchlistItemReadData,
} from '@vultus/shared/firestore-schema';
import { Observable, map, of, shareReplay } from 'rxjs';

/**
 * Data-access for the Watch Today tab (spec 0083). Reads only — it adds no field,
 * collection, rule, or index:
 *   - `users/{uid}/watchlist` (realtime) → the full watching/planned set.
 *   - `users/{uid}` (memoized, one listener) → the user's region.
 *   - `title-cache/{tmdbId}/availability/{region}` (memoized per `tmdbId|region`)
 *     → the provider-availability pill.
 *   - `users/{uid}/watchlist/{titleId}/episodes` (one-shot `getDocs`) → D4
 *     bounded enrichment for the "S{season}E{episode} available" label, invoked
 *     ONLY for TV items that already pass the watchable-today gate.
 *
 * SHERIFF: MIRRORS — does NOT import — `WatchlistService`'s shape. The uid comes
 * from the `scope:shared` `AUTH_UID` token (provided by the shell), never from
 * `apps/mobile`. AngularFire `Firestore` (third-party) is injected directly. All
 * reads are keyed on the resolved uid; a null uid is a no-op / empty stream. The
 * memoized-availability pattern is a DELIBERATE 2-slice duplication of watchlist
 * (D3), below the PLAN §3 3+-slice extract threshold — no shared helper.
 */
@Injectable({ providedIn: 'root' })
export class TodayService {
  private readonly firestore = inject(Firestore);
  // Injected so the service is self-contained; the page passes the uid value
  // explicitly to keep the streams re-subscribable (mirrors WatchlistService).
  private readonly uid = inject(AUTH_UID);

  /** Realtime `users/{uid}/watchlist`, mapped to domain `WatchlistItem`s (incl.
   *  `releaseDate` + `nextUnwatchedEpisodeAirDate`). Null uid → empty stream. */
  watchlist$(uid: string | null): Observable<WatchlistItem[]> {
    if (!uid) {
      return of([]);
    }
    const col = collection(this.firestore, watchlistPath(uid));
    return (collectionData(col) as Observable<WatchlistItemReadData[]>).pipe(
      map((docs) => docs.map((d) => dataToWatchlistItem(d))),
    );
  }

  /**
   * Memoized `users/{uid}` docData streams, keyed by uid, so only ONE Firestore
   * Listen channel is opened per user doc even as the page's `| async`
   * re-subscribes. `shareReplay({ refCount: false })` keeps the underlying
   * listener alive and stable (mirrors WatchlistService).
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

  /** The user's persisted region; null uid / missing doc → null. Memoized. */
  userRegion$(uid: string | null): Observable<Region | null> {
    if (!uid) {
      return of(null);
    }
    return this.user$(uid).pipe(
      map((data) => (data ? dataToUser(data).region : null)),
    );
  }

  /**
   * The user's subscribed TMDB provider ids (`users/{uid}.myProviderIds`, spec
   * 0060), for the availability pill's `mine` partition (D3). Reads the SAME
   * memoized `user$` listener `userRegion$` uses (no second Firestore Listen
   * channel). Null uid / missing doc → `[]` (via `dataToUser`'s `?? []`
   * coalescing). Mirrors — does NOT import — `WatchlistService.myProviderIds$`.
   */
  myProviderIds$(uid: string | null): Observable<number[]> {
    if (!uid) {
      return of([]);
    }
    return this.user$(uid).pipe(
      map((data) => (data ? dataToUser(data).myProviderIds : [])),
    );
  }

  /**
   * Memoized full-availability streams keyed by `tmdbId|region`, feeding the
   * partitioned availability pill. Memoized for the same reason WatchlistService
   * memoizes: the template binds `availability$(...) | async`, which Angular
   * re-invokes every change-detection pass — a fresh Observable each time would
   * reopen a Firestore listener every cycle.
   */
  private readonly availabilityCache = new Map<
    string,
    Observable<RegionAvailability | null>
  >();

  /** Provider availability for a title in a region (for the pill). Null region /
   *  missing doc → null. Memoized per `tmdbId|region`. */
  availability$(
    tmdbId: number,
    region: Region | null,
  ): Observable<RegionAvailability | null> {
    if (!region) {
      return of(null);
    }
    const key = `${tmdbId}|${region}`;
    let stream = this.availabilityCache.get(key);
    if (!stream) {
      stream = (
        docData(
          doc(this.firestore, availabilityDocPath(tmdbId, region)),
        ) as Observable<RegionAvailabilityReadData | undefined>
      ).pipe(
        map((data) => (data ? dataToAvailability(data) : null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.availabilityCache.set(key, stream);
    }
    return stream;
  }

  /**
   * ONE-SHOT `getDocs` read of the whole `users/{uid}/watchlist/{titleId}/episodes`
   * subcollection, mapped via `dataToEpisode` (D4 bounded enrichment). Invoked
   * by the page ONLY for TV items that already pass the watchable-today gate — so
   * the read count is bounded, preserving spec 0081's cheap-denormalized-gate
   * purpose. Null uid → empty array (no read).
   */
  async readEpisodes(uid: string, titleId: string): Promise<EpisodeDoc[]> {
    if (!uid) {
      return [];
    }
    const snap = await getDocs(
      collection(this.firestore, episodesPath(uid, titleId)),
    );
    return snap.docs.map((docSnap) =>
      dataToEpisode(docSnap.data() as EpisodeReadData),
    );
  }
}
