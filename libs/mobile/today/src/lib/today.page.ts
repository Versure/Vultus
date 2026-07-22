import { AsyncPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  checkmarkCircle,
  personCircleOutline,
  playCircle,
  todayOutline,
} from 'ionicons/icons';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type RegionAvailability,
  type Region,
  type TitleType,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  VultusAppHeader,
  VultusEmptyState,
  VultusErrorState,
  VultusSkeletonCard,
} from '@vultus/shared/ui-kit';
import {
  BehaviorSubject,
  type Observable,
  catchError,
  combineLatest,
  from,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs';
import { TodayService } from './today.service';
import {
  type AvailabilityPill,
  nextEpisodeLabel,
  partitionAvailabilityPill,
  partitionWatchableToday,
  watchableSubtitle,
} from './today.logic';

/** TMDB poster CDN base (w185 rendition) — mirrors watchlist's `TMDB_POSTER_BASE`
 *  (deliberate 2-slice duplication; below the 3+-slice extract threshold). */
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

/** The partitioned "watchable today" view model (spec 0083). `null` until the
 *  realtime watchlist stream's first emission (→ skeletons). `isEmpty` collapses
 *  both sections being empty into the single shared empty state. */
interface TodayVm {
  movies: WatchlistItem[];
  tvShows: WatchlistItem[];
  /** EXACT copy from `watchableSubtitle(total)`, e.g. "3 things ready to watch". */
  subtitle: string;
  isEmpty: boolean;
}

/**
 * The **Watch Today** tab page (spec 0083). Surfaces everything on the user's
 * watchlist that is watchable RIGHT NOW — watching/planned movies whose
 * `releaseDate` has passed and watching/planned TV shows whose
 * `nextUnwatchedEpisodeAirDate` (spec 0081) has aired — grouped into a Movies
 * section and a TV Shows section (each rendered only when non-empty).
 *
 * D5 (date-comparison trap): `nowISO` (full ISO datetime, UTC) and
 * `todayDateOnly` (its `YYYY-MM-DD` slice) are computed ONCE per subscription
 * (inside the `vm$` switchMap) and passed into `partitionWatchableToday` — the
 * two formats are never conflated.
 *
 * D4 (bounded enrichment): the "S{season}E{episode} available" label uses a
 * memoized per-`titleId` one-shot `readEpisodes` stream, invoked ONLY for TV
 * items that already pass the gate (they are the only ones the template binds
 * `episodeLabel$` for) — preserving spec 0081's cheap-denormalized-gate purpose.
 *
 * SHERIFF: `scope:mobile` / `slice:today`. Reads only `@vultus/shared/*` + this
 * slice; the availability-pill logic is a DELIBERATE copy of watchlist (D3, 2nd
 * slice, below the 3+-slice extract threshold — no `@vultus/mobile/watchlist`
 * import). Cross-slice navigation to title-detail is by string segments, not an
 * import. The uid comes from the `scope:shared` `AUTH_UID` token, never
 * `apps/mobile`.
 */
@Component({
  selector: 'lib-today',
  imports: [
    AsyncPipe,
    IonContent,
    IonButton,
    IonIcon,
    VultusAppHeader,
    VultusEmptyState,
    VultusErrorState,
    VultusSkeletonCard,
  ],
  templateUrl: './today.page.html',
  styleUrl: './today.page.scss',
})
export class TodayPage {
  private readonly today = inject(TodayService);
  private readonly router = inject(Router);

  /** Resolved auth uid (Signal); null before the anonymous session resolves. */
  readonly uid = inject(AUTH_UID);

  /** Drives re-subscription of the realtime stream (error-state retry). */
  private readonly reload$ = new BehaviorSubject<void>(undefined);

  /** The user's region (for provider-availability lookups). Shared so every
   *  card's pill reads one value without re-reading the user doc. */
  readonly region$: Observable<Region | null> = this.today
    .userRegion$(this.uid())
    .pipe(shareReplay({ bufferSize: 1, refCount: false }));

  /** The user's subscribed provider ids (spec 0060) for the pill's `mine`
   *  partition. Shared; reads the SAME memoized user-doc listener as `region$`. */
  readonly myProviderIds$: Observable<number[]> = this.today
    .myProviderIds$(this.uid())
    .pipe(shareReplay({ bufferSize: 1, refCount: false }));

  /**
   * View model for the tab. `vm` is null until the realtime watchlist stream
   * first emits → the template renders skeletons; once it emits (even `[]`) the
   * empty state / sections take over. A stream error maps to `{ vm: null,
   * error: true }` (caught here, not propagated) so the template renders the
   * error state with a retry. Modelled as a stream so nothing mutates component
   * state during change detection.
   */
  readonly vm$: Observable<{ vm: TodayVm | null; error: boolean }> =
    this.reload$.pipe(
      switchMap(() => {
        // D5: compute BOTH "now" representations ONCE per subscription, never
        // per pure-function call — full ISO for TV, its date-only slice for
        // movies. UTC (`toISOString()`) matches `dispatch-notifications`.
        const nowISO = new Date().toISOString();
        const todayDateOnly = nowISO.slice(0, 10);
        return this.today.watchlist$(this.uid()).pipe(
          map((items) => {
            const { movies, tvShows } = partitionWatchableToday(
              items,
              nowISO,
              todayDateOnly,
            );
            const total = movies.length + tvShows.length;
            return {
              vm: {
                movies,
                tvShows,
                subtitle: watchableSubtitle(total),
                isEmpty: total === 0,
              },
              error: false,
            };
          }),
          catchError(() => of({ vm: null, error: true })),
          startWith({ vm: null, error: false }),
        );
      }),
    );

  constructor() {
    addIcons({
      checkmarkCircle,
      personCircleOutline,
      playCircle,
      todayOutline,
    });
  }

  /** Error-state retry: re-subscribe the realtime stream (recomputes `now`). */
  onRetry(): void {
    this.reload$.next();
  }

  /**
   * Navigates toward the title-detail route; never crashes. Threads the media
   * `type` as `?type=tv|movie` so title-detail resolves the right TMDB namespace
   * (ids collide across movie/tv). String-segment navigation — NO import of
   * `@vultus/mobile/title-detail` (Sheriff-clean cross-slice nav).
   */
  navigateToDetail(titleId: string, type: TitleType): void {
    this.router
      .navigate(['tabs', 'title-detail', titleId], {
        queryParams: { type, origin: 'today' },
      })
      .catch(() => {
        /* graceful no-op — route may not be registered in isolation */
      });
  }

  // ---------------------------------------------------------------------------
  // Availability pill (D3) — memoized per `tmdbId|region` for the same reason
  // watchlist memoizes: the template binds `availabilityPill$(...) | async`,
  // which Angular re-invokes every change-detection pass; a fresh Observable
  // each time would reopen a Firestore listener every cycle. One shared
  // `shareReplay` instance per key keeps the reference (and listener) stable.
  // ---------------------------------------------------------------------------
  private readonly availabilityCache = new Map<
    string,
    Observable<RegionAvailability | null>
  >();

  private availabilityFor(
    tmdbId: number,
    region: Region | null,
  ): Observable<RegionAvailability | null> {
    const key = `${tmdbId}|${region ?? ''}`;
    let stream = this.availabilityCache.get(key);
    if (!stream) {
      stream = this.today
        .availability$(tmdbId, region)
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
      this.availabilityCache.set(key, stream);
    }
    return stream;
  }

  /**
   * The partitioned availability pill for a card (D3): `{ kind: 'mine' }` /
   * `{ kind: 'elsewhere' }` / `null`. Combines the memoized per-`tmdbId|region`
   * availability with the user's `myProviderIds` via the pure
   * `partitionAvailabilityPill` (deliberate watchlist duplication).
   */
  availabilityPill$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<AvailabilityPill | null> {
    return combineLatest([
      this.availabilityFor(item.tmdbId, region),
      this.myProviderIds$,
    ]).pipe(
      map(([availability, myProviderIds]) =>
        partitionAvailabilityPill(availability, myProviderIds),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // D4 episode label — memoized per `titleId` one-shot `readEpisodes` stream.
  // Bound by the template ONLY on TV cards (which are, by construction, the
  // gated-in TV items), so `readEpisodes` is never called for a movie or a
  // gated-out title. Memoized so Angular's per-CD method call doesn't refire the
  // read.
  // ---------------------------------------------------------------------------
  private readonly episodeLabelCache = new Map<
    string,
    Observable<string | null>
  >();

  episodeLabel$(item: WatchlistItem): Observable<string | null> {
    const key = this.titleId(item);
    let stream = this.episodeLabelCache.get(key);
    if (!stream) {
      const uid = this.uid();
      stream = (uid ? from(this.today.readEpisodes(uid, key)) : of([])).pipe(
        map((episodes) => nextEpisodeLabel(episodes)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.episodeLabelCache.set(key, stream);
    }
    return stream;
  }

  /** Full poster URL, or null when no `posterPath` is cached (→ fallback block). */
  posterUrl(item: WatchlistItem): string | null {
    return item.posterPath ? TMDB_POSTER_BASE + item.posterPath : null;
  }

  /** The watchlist doc id for an item (spec 0013 binding: `String(tmdbId)`). */
  titleId(item: WatchlistItem): string {
    return String(item.tmdbId);
  }
}
