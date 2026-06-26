import { AsyncPipe, DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
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
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addCircleOutline,
  calendarOutline,
  documentTextOutline,
  filmOutline,
  peopleOutline,
  personCircleOutline,
  star,
  timeOutline,
  trashOutline,
  tvOutline,
} from 'ionicons/icons';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type Region,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  BehaviorSubject,
  type Observable,
  combineLatest,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs';
import {
  VultusEmptyState,
  VultusErrorState,
  VultusSkeletonHero,
} from '@vultus/shared/ui-kit';
import { type GroupedProviders, type TitleDetail } from './tmdb-detail.client';
import {
  STATUS_DISPLAY_ORDER,
  STATUS_LABELS,
  type DetailViewState,
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
    IonButton,
    IonTitle,
    IonIcon,
    IonActionSheet,
    IonAlert,
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

  /** Resolved auth uid (Signal); null before the anonymous session resolves. */
  readonly uid = inject(AUTH_UID);

  /** Exposed for template bindings. */
  readonly STATUS_LABELS = STATUS_LABELS;
  readonly statusOrder = STATUS_DISPLAY_ORDER;

  /** The numeric tmdb id parsed from the `:titleId` route param. */
  readonly tmdbId = Number(this.route.snapshot.paramMap.get('titleId'));

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
        void this.service.removeTitle(this.tmdbId);
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
            void this.service.updateStatus(this.tmdbId, status);
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

  private readonly detail$: Observable<DetailViewState> =
    this.retryTrigger$.pipe(
      switchMap(() => this.service.detail$(this.tmdbId)),
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
    });
  }

  /** Re-resolves the title after a recoverable error (bound to error-state retry). */
  onRetry(): void {
    this.retryTrigger$.next();
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
}
