import { AsyncPipe, DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ActionSheetButton, AlertButton } from '@ionic/angular/standalone';
import {
  IonActionSheet,
  IonAlert,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addCircleOutline,
  calendarOutline,
  checkmarkCircle,
  chevronDownOutline,
  documentTextOutline,
  filmOutline,
  listOutline,
  peopleOutline,
  personCircleOutline,
  squareOutline,
  star,
  timeOutline,
  trashOutline,
  tvOutline,
} from 'ionicons/icons';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type Region,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  BehaviorSubject,
  type Observable,
  combineLatest,
  distinctUntilChanged,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs';
import {
  SyncStateService,
  VultusEmptyState,
  VultusErrorState,
  VultusSkeletonHero,
} from '@vultus/shared/ui-kit';
import { type GroupedProviders, type TitleDetail } from './tmdb-detail.client';
import {
  STATUS_DISPLAY_ORDER,
  STATUS_LABELS,
  type DetailViewState,
  type EpisodeRow,
  type SeasonGroup,
  TitleDetailService,
} from './title-detail.service';

interface DetailVm {
  state: DetailViewState;
  region: Region | null;
  providers: GroupedProviders;
  tracked: WatchlistItem | null;
}

const EMPTY_PROVIDERS: GroupedProviders = { flatrate: [], rent: [], buy: [] };

@Component({
  selector: 'lib-title-detail',
  imports: [
    AsyncPipe,
    DecimalPipe,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonButton,
    IonTitle,
    IonIcon,
    IonActionSheet,
    IonAlert,
    IonSkeletonText,
    VultusSkeletonHero,
    VultusEmptyState,
    VultusErrorState,
  ],
  templateUrl: './title-detail.page.html',
  styleUrl: './title-detail.page.scss',
})
export class TitleDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly service = inject(TitleDetailService);

  /** Shared whole-watchlist sync state (cooldown/in-flight) — see `@vultus/shared/ui-kit`. */
  readonly syncState = inject(SyncStateService);
  private readonly toastCtrl = inject(ToastController);

  /** Resolved auth uid (Signal); null before the anonymous session resolves. */
  readonly uid = inject(AUTH_UID);

  /** Exposed for template bindings. */
  readonly STATUS_LABELS = STATUS_LABELS;
  readonly statusOrder = STATUS_DISPLAY_ORDER;

  /** Current numeric tmdb id from the live :titleId param (re-emits on Ionic page reuse). */
  readonly tmdbId$: Observable<number> = this.route.paramMap.pipe(
    map((p) => Number(p.get('titleId'))),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * Optional media-type hint from the `?type=tv|movie` query param (spec 0043).
   * Search/Watchlist navigate with the known type so the live TMDB fallback
   * hits the right namespace (movie vs. tv ids collide). Any other value (or
   * absence) → `undefined`, preserving the no-hint `/movie`→`/tv` 404 fallthrough.
   */
  private readonly typeHint$: Observable<TitleType | undefined> =
    this.route.queryParamMap.pipe(
      map((p) => {
        const v = p.get('type');
        return v === 'movie' || v === 'tv' ? v : undefined;
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  /**
   * Synchronously-readable current id for imperative handlers (action-sheet,
   * remove alert). Updated from tmdbId$ via takeUntilDestroyed so handlers
   * always act on the title currently on screen, not a stale first navigation.
   */
  private currentTmdbId = 0;

  /**
   * Synchronously-readable current title type for imperative handlers (spec
   * 0053). Kept in sync from `detail$` so the status action-sheet handler can
   * pass the resolved type to `updateStatus` (TV vs. movie decides whether
   * completing the show batch-marks its episodes watched). Default `'tv'` is a
   * safe placeholder — it is always overwritten by the loaded detail before the
   * action sheet can open (the sheet only appears on a loaded, tracked title).
   */
  private currentType: TitleType = 'tv';

  /**
   * Guard so the page-init auto-revert (spec 0050) fires at most once per
   * distinct tmdbId. Holds the last id `revertIfNewEpisodes` was called for.
   */
  private revertCheckedForId = 0;

  // Status action-sheet + remove-alert overlay state.
  actionSheetOpen = false;
  alertOpen = false;

  readonly alertButtons: AlertButton[] = [
    { text: 'Cancel', role: 'cancel', cssClass: 'vultus-alert-cancel' },
    {
      text: 'Remove',
      role: 'destructive',
      cssClass: 'vultus-alert-remove',
      handler: () => {
        void this.service.removeTitle(this.currentTmdbId);
      },
    },
  ];

  /** Action-sheet rows generated from the display order + a Cancel row. */
  get actionSheetButtons(): ActionSheetButton[] {
    return [
      ...STATUS_DISPLAY_ORDER.map(
        (status): ActionSheetButton => ({
          text: STATUS_LABELS[status],
          handler: () => {
            void this.service.updateStatus(
              this.currentTmdbId,
              status,
              this.currentType,
            );
          },
        }),
      ),
      { text: 'Cancel', role: 'cancel' },
    ];
  }

  /**
   * Retry trigger for the recoverable `error` state. Each `next()` re-runs the
   * service's `detail$(tmdbId)` (which re-emits `loading` then the fresh result)
   * through `switchMap`, so tapping "Try again" re-resolves the title.
   */
  private readonly retryTrigger$ = new BehaviorSubject<void>(undefined);

  private readonly detail$: Observable<DetailViewState> = combineLatest([
    this.tmdbId$,
    this.typeHint$,
    this.retryTrigger$,
  ]).pipe(
    switchMap(([tmdbId, typeHint]) =>
      Number.isNaN(tmdbId) || tmdbId === 0
        ? of<DetailViewState>({ kind: 'not-found' })
        : this.service.detail$(tmdbId, typeHint),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  private readonly region$ = this.service
    .region$()
    .pipe(
      startWith<Region | null>(null),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  readonly vm$: Observable<DetailVm> = combineLatest([
    this.detail$,
    this.region$,
  ]).pipe(
    switchMap(([state, region]): Observable<DetailVm> => {
      if (state.kind !== 'loaded') {
        return of<DetailVm>({
          state,
          region,
          providers: EMPTY_PROVIDERS,
          tracked: null,
        });
      }
      const providers$ = this.service
        .providers$(
          state.detail.tmdbId,
          state.detail.type,
          region,
          state.source,
        )
        .pipe(startWith<GroupedProviders>(EMPTY_PROVIDERS));
      const tracked$ = this.service
        .tracked$(state.detail.tmdbId)
        .pipe(startWith<WatchlistItem | null>(null));
      return combineLatest([providers$, tracked$]).pipe(
        map(([providers, tracked]) => ({ state, region, providers, tracked })),
      );
    }),
  );

  /**
   * Season-grouped episodes for the (TV-only) Episodes section. `null` is the
   * "not yet loaded" sentinel (the skeleton state) — `startWith(null)` seeds it
   * and AngularFire's first emission replaces it with `SeasonGroup[]` (possibly
   * empty → the empty-state copy). Non-tv / non-loaded states resolve to `null`
   * and the section isn't rendered anyway (guarded in the template).
   */
  readonly episodes$: Observable<SeasonGroup[] | null> = this.detail$.pipe(
    switchMap((state) =>
      state.kind === 'loaded' && state.detail.type === 'tv'
        ? this.service
            .episodes$(state.detail.tmdbId, 'tv')
            .pipe(startWith<SeasonGroup[] | null>(null))
        : of<SeasonGroup[] | null>(null),
    ),
  );

  /** UI-only: which seasons are collapsed (default expanded). */
  collapsedSeasons = new Set<number>();

  constructor() {
    addIcons({
      filmOutline,
      tvOutline,
      star,
      calendarOutline,
      timeOutline,
      documentTextOutline,
      peopleOutline,
      personCircleOutline,
      addCircleOutline,
      trashOutline,
      listOutline,
      chevronDownOutline,
      checkmarkCircle,
      squareOutline,
    });
    // Keep currentTmdbId in sync so imperative handlers always act on the
    // title currently on screen (not the first navigation's id).
    this.tmdbId$.pipe(takeUntilDestroyed()).subscribe((id) => {
      this.currentTmdbId = id;
    });
    // Page-init auto-revert (spec 0050): a 'completed' TV show whose episodes
    // gained an unwatched entry (new episodes synced) silently reverts to
    // 'watching'. Deduped to once per distinct tmdbId via revertCheckedForId.
    this.detail$.pipe(takeUntilDestroyed()).subscribe((state) => {
      if (state.kind === 'loaded') {
        // Keep currentType in sync so the status action-sheet handler passes the
        // resolved type to updateStatus (spec 0053: TV-completed batch-marks
        // episodes; movie-completed does not).
        this.currentType = state.detail.type;
      }
      if (
        state.kind === 'loaded' &&
        state.detail.type === 'tv' &&
        state.detail.tmdbId !== this.revertCheckedForId
      ) {
        this.revertCheckedForId = state.detail.tmdbId;
        void this.service.revertIfNewEpisodes(state.detail.tmdbId, 'tv');
      }
    });
  }

  /** Re-resolves the title after a recoverable error (bound to error-state retry). */
  onRetry(): void {
    this.retryTrigger$.next();
  }

  /**
   * Pull-to-refresh: triggers a whole-watchlist sync via the shared
   * `SyncStateService` (the page's Firestore streams re-emit reactively when the
   * sync writes land). The service owns the 5-minute cooldown shared with the
   * watchlist tab; inside the cooldown this is a silent no-op (no toast). On a
   * successful sync we surface a "Refreshed" toast, on failure an error toast.
   * The refresher spinner is always dismissed via `complete()` in `finally`.
   */
  async onRefresh(event: CustomEvent): Promise<void> {
    const complete = () =>
      (event.detail as { complete: () => void }).complete();
    if (!this.syncState.canSync()) {
      complete(); // recently synced — nothing to do, no toast
      return;
    }
    try {
      await this.syncState.triggerSync();
      const toast = await this.toastCtrl.create({
        message: 'Refreshed',
        duration: 2000,
        position: 'bottom',
        color: 'success',
      });
      await toast.present();
    } catch {
      const toast = await this.toastCtrl.create({
        message: 'Sync failed — try again later',
        duration: 3000,
        position: 'bottom',
        color: 'danger',
      });
      await toast.present();
    } finally {
      complete();
    }
  }

  /** Opens the status-change action sheet (public — bound + tested). */
  openStatusSheet(): void {
    this.actionSheetOpen = true;
  }

  /** Opens the remove-confirm alert. */
  openRemoveAlert(): void {
    this.alertOpen = true;
  }

  /** Adds the currently-resolved detail to the watchlist as 'planned'. */
  addToWatchlist(detail: TitleDetail): void {
    void this.service.add(detail);
  }

  /**
   * Adds the currently-resolved detail to the watchlist directly as 'completed'
   * (spec 0056 — one-step "Mark as Watched" from the untracked action-area). For
   * a TV title this also bulk-marks any already-existing episode docs watched
   * (handled by the service); a brand-new show with no episode docs is added as
   * 'completed' and the spec-0050 auto-revert corrects it once sync populates
   * unwatched episodes.
   */
  markAsWatched(detail: TitleDetail): void {
    void this.service.add(detail, 'completed');
  }

  /** Whether the where-to-watch card has any provider rows. */
  hasProviders(p: GroupedProviders): boolean {
    return p.flatrate.length > 0 || p.rent.length > 0 || p.buy.length > 0;
  }

  /** Type label for a watchlist provider type. */
  providerTypeLabel(type: 'flatrate' | 'rent' | 'buy'): string {
    return type === 'flatrate'
      ? 'Subscription'
      : type === 'rent'
        ? 'Rent'
        : 'Buy';
  }

  /** Human badge for the title type. */
  typeBadge(type: 'movie' | 'tv'): string {
    return type === 'movie' ? 'Movie' : 'TV Series';
  }

  /** Status accent color CSS var for the tracked status control. */
  statusColorVar(status: WatchStatus): string {
    return `var(--vultus-status-${status})`;
  }

  /** Toggle one episode's watched flag (fire-and-forget; stream re-emits). */
  toggleEpisode(row: EpisodeRow, watched: boolean): void {
    void this.service.setEpisodeWatched(this.currentTmdbId, row.id, watched);
  }

  /** Bulk toggle a whole season to the opposite of its current all-watched. */
  toggleSeason(group: SeasonGroup): void {
    void this.service.setSeasonWatched(
      this.currentTmdbId,
      group.season,
      !group.allWatched,
    );
  }

  /** Toggle a season's collapsed (UI-only) state. */
  toggleSeasonCollapsed(season: number): void {
    if (this.collapsedSeasons.has(season)) {
      this.collapsedSeasons.delete(season);
    } else {
      this.collapsedSeasons.add(season);
    }
  }

  /** Whether a season is currently collapsed. */
  isSeasonCollapsed(season: number): boolean {
    return this.collapsedSeasons.has(season);
  }

  /** Movie mark-as-watched toggle: completed ↔ watching (dropped is no-op). */
  toggleMovieWatched(tracked: WatchlistItem): void {
    void this.service.setMovieWatched(
      this.currentTmdbId,
      tracked.status !== 'completed',
    );
  }

  /** Format an ISO air date as e.g. "Jan 5, 2026". */
  formatAirDate(airDate: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(airDate));
  }
}
