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
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  filmOutline,
  personCircleOutline,
  refreshOutline,
  trashOutline,
} from 'ionicons/icons';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { SyncStateService } from './watchlist.sync-state.service';
import {
  type Region,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  VultusEmptyState,
  VultusErrorState,
  VultusSkeletonCard,
} from '@vultus/shared/ui-kit';
import {
  BehaviorSubject,
  type Observable,
  catchError,
  map,
  of,
  shareReplay,
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
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    IonAlert,
    IonActionSheet,
    VultusSkeletonCard,
    VultusEmptyState,
    VultusErrorState,
  ],
  templateUrl: './watchlist.page.html',
  styleUrl: './watchlist.page.scss',
})
export class WatchlistPage {
  private readonly watchlistService = inject(WatchlistService);
  private readonly router = inject(Router);
  private readonly toastCtrl = inject(ToastController);

  /** Client-side cooldown state for the toolbar refresh button (spec 0025). */
  readonly syncState = inject(SyncStateService);

  /** Exposed for template bindings (status chip label). */
  readonly STATUS_LABELS = STATUS_LABELS;

  /** Resolved auth uid (Signal); null before the anonymous session resolves. */
  readonly uid = inject(AUTH_UID);

  /** Selected type filter — undefined = All, 'movie' = Movies, 'tv' = TV. */
  selectedType: TitleType | undefined = undefined;

  // Drives re-subscription when the type filter changes.
  private readonly typeFilter$ = new BehaviorSubject<TitleType | undefined>(
    undefined,
  );

  /**
   * View model for the list. `groups` is null until the first emission of the
   * realtime stream → the template renders skeletons; once it emits (even `[]`)
   * the empty state / grouped sections take over. A stream error maps to
   * `{ groups: null, error: true }` (caught here, not propagated) so the
   * template renders the error state with a retry. Modelled as a stream (not a
   * mutated `loading` flag) so nothing changes component state during change
   * detection.
   */
  readonly vm$: Observable<{ groups: StatusGroup[] | null; error: boolean }> =
    this.typeFilter$.pipe(
      switchMap((type) =>
        this.watchlistService.watchlist$(this.uid(), type).pipe(
          map((items) => ({ groups: groupByStatus(items), error: false })),
          catchError(() => of({ groups: null, error: true })),
        ),
      ),
      startWith({ groups: null, error: false }),
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
    { text: 'Cancel', role: 'cancel', cssClass: 'vultus-alert-cancel' },
    {
      text: 'Remove',
      role: 'destructive',
      cssClass: 'vultus-alert-remove',
      handler: () => {
        this.onDeleteItem();
      },
    },
  ];

  constructor() {
    addIcons({
      filmOutline,
      personCircleOutline,
      refreshOutline,
      trashOutline,
    });
  }

  /**
   * Toolbar refresh button: triggers a manual sync and surfaces the outcome as a
   * toast. The `SyncStateService` owns the guard/cooldown; this method only maps
   * resolve/reject to the success/error toast.
   */
  async onSync(): Promise<void> {
    try {
      await this.syncState.triggerSync();
      const toast = await this.toastCtrl.create({
        message: 'Watchlist synced',
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
    }
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

  /** Plain-button filter click — updates selectedType and re-subscribes the stream. */
  onFilterClick(type: TitleType | undefined): void {
    this.selectedType = type;
    this.typeFilter$.next(type);
  }

  /** @deprecated kept for test backward-compat; use onFilterClick for new code. */
  onTypeChange(event: CustomEvent): void {
    const value = (event.detail as { value: string }).value;
    this.onFilterClick(value === 'movie' || value === 'tv' ? value : undefined);
  }

  /** Pull-to-refresh: re-subscribe the realtime stream, then complete. */
  onRefresh(event: CustomEvent): void {
    this.typeFilter$.next(this.selectedType);
    (event.detail as { complete: () => void }).complete();
  }

  /** Error-state retry: re-subscribe the realtime stream for the current filter. */
  onRetry(): void {
    this.typeFilter$.next(this.selectedType);
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
    this.router.navigate(['tabs', 'title-detail', titleId]).catch(() => {
      // title-detail route not registered yet — graceful no-op.
    });
  }

  /**
   * Memoized provider-name streams, keyed by `tmdbId|region`. The template binds
   * `getProviderName$(...) | async`, which Angular re-invokes on every change
   * detection pass — returning a fresh Observable each time would make the async
   * pipe resubscribe (and open a new Firestore `docData` listener) every cycle,
   * an unbounded Listen-channel loop. Caching one shared instance per key keeps
   * the reference (and the underlying listener) stable across CD.
   */
  private readonly providerCache = new Map<string, Observable<string | null>>();

  /** First provider name for an item, in the user's region (badge). */
  getProviderName$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<string | null> {
    const key = `${item.tmdbId}|${region ?? ''}`;
    let stream = this.providerCache.get(key);
    if (!stream) {
      stream = this.watchlistService.availability$(item.tmdbId, region).pipe(
        map((a) => a?.providers[0]?.name ?? null),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.providerCache.set(key, stream);
    }
    return stream;
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

  /** The watchlist doc id for an item — matches spec 0013's binding: String(tmdbId). */
  titleId(item: WatchlistItem): string {
    return String(item.tmdbId);
  }
}
