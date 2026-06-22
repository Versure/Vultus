import { AsyncPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonActionSheet,
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItemDivider,
  IonLabel,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { personCircleOutline, trashOutline } from 'ionicons/icons';
import {
  AUTH_UID,
  type Region,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  BehaviorSubject,
  type Observable,
  map,
  startWith,
  switchMap,
} from 'rxjs';
import {
  STATUS_DISPLAY_ORDER,
  STATUS_LABELS,
  type StatusGroup,
  WatchlistService,
  groupByStatus,
} from './watchlist.service';

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

@Component({
  selector: 'lib-watchlist',
  imports: [
    AsyncPipe,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonButton,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonRefresher,
    IonRefresherContent,
    IonItemDivider,
    IonSkeletonText,
    IonAlert,
    IonActionSheet,
  ],
  templateUrl: './watchlist.page.html',
  styleUrl: './watchlist.page.scss',
})
export class WatchlistPage {
  private readonly watchlistService = inject(WatchlistService);
  private readonly router = inject(Router);

  /** Resolved auth uid (Signal); null before the anonymous session resolves. */
  readonly uid = inject(AUTH_UID);

  /** Selected type filter — undefined = All, 'movie' = Movies, 'tv' = TV. */
  selectedType: TitleType | undefined = undefined;

  /** Skeleton placeholder rows while loading. */
  readonly skeletons = [0, 1, 2, 3, 4];

  // Drives re-subscription when the type filter changes.
  private readonly typeFilter$ = new BehaviorSubject<TitleType | undefined>(
    undefined,
  );

  /**
   * View model for the list. `groups` is null until the first emission of the
   * realtime stream → the template renders skeletons; once it emits (even `[]`)
   * the empty state / grouped sections take over. Modelled as a stream (not a
   * mutated `loading` flag) so nothing changes component state during change
   * detection.
   */
  readonly vm$: Observable<{ groups: StatusGroup[] | null }> =
    this.typeFilter$.pipe(
      switchMap((type) =>
        this.watchlistService
          .watchlist$(this.uid(), type)
          .pipe(map((items) => ({ groups: groupByStatus(items) }))),
      ),
      startWith({ groups: null }),
    );

  /** The user's region (for provider-badge availability lookups). */
  readonly region$: Observable<Region | null> =
    this.watchlistService.userRegion$(this.uid());

  // Status action-sheet state.
  actionSheetItem: WatchlistItem | null = null;
  actionSheetOpen = false;

  // Delete-confirm alert state.
  alertDeleteItem: WatchlistItem | null = null;
  alertOpen = false;

  readonly alertButtons = [
    { text: 'Cancel', role: 'cancel' },
    {
      text: 'Remove',
      role: 'destructive',
      handler: () => {
        this.onDeleteItem();
      },
    },
  ];

  constructor() {
    addIcons({ personCircleOutline, trashOutline });
  }

  /** Action-sheet buttons generated from the display order + a Cancel row. */
  get actionSheetButtons() {
    return [
      ...STATUS_DISPLAY_ORDER.map((status) => ({
        text: STATUS_LABELS[status],
        handler: () => {
          this.onStatusSelected(status);
        },
      })),
      { text: 'Cancel', role: 'cancel' },
    ];
  }

  /** Opens the status action sheet for an item (public — bound + tested). */
  openStatusSheet(item: WatchlistItem): void {
    this.actionSheetItem = item;
    this.actionSheetOpen = true;
  }

  /** Type segment change → update filter and re-subscribe the stream. */
  onTypeChange(event: CustomEvent): void {
    const value = (event.detail as { value: string }).value;
    this.selectedType = value === 'movie' || value === 'tv' ? value : undefined;
    this.typeFilter$.next(this.selectedType);
  }

  /** Pull-to-refresh: re-subscribe the realtime stream, then complete. */
  onRefresh(event: CustomEvent): void {
    this.typeFilter$.next(this.selectedType);
    (event.detail as { complete: () => void }).complete();
  }

  /** Opens the delete-confirm alert for an item. */
  onDeleteConfirm(item: WatchlistItem): void {
    this.alertDeleteItem = item;
    this.alertOpen = true;
  }

  /** Applies the chosen status to the action-sheet item. */
  onStatusSelected(status: WatchStatus): void {
    const item = this.actionSheetItem;
    if (!item) {
      return;
    }
    this.watchlistService.updateStatus(this.uid(), this.titleId(item), status);
  }

  /** Removes the alert's target item from the watchlist. */
  onDeleteItem(): void {
    const item = this.alertDeleteItem;
    if (!item) {
      return;
    }
    this.watchlistService.removeTitle(this.uid(), this.titleId(item));
  }

  /** Navigates toward the (not-yet-existing) title-detail route; never crashes. */
  navigateToDetail(titleId: string): void {
    try {
      void this.router.navigate(['tabs', 'title-detail', titleId]);
    } catch {
      // title-detail route not registered yet — graceful no-op.
    }
  }

  /** First provider name for an item, in the user's region (badge). */
  getProviderName$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<string | null> {
    return this.watchlistService
      .availability$(item.tmdbId, region)
      .pipe(map((a) => a?.providers[0]?.name ?? null));
  }

  /** Full poster URL or null when no posterPath is cached. */
  posterUrl(item: WatchlistItem): string | null {
    return item.posterPath ? TMDB_POSTER_BASE + item.posterPath : null;
  }

  /** Vote percentage (0–100) or null when no vote is cached. */
  votePercent(item: WatchlistItem): number | null {
    if (item.voteAverage === null || item.voteAverage === undefined) {
      return null;
    }
    return Math.round(item.voteAverage * 10);
  }

  /** The watchlist doc id for an item (tmdbId + type discriminant). */
  titleId(item: WatchlistItem): string {
    return `${item.tmdbId}-${item.type}`;
  }
}
