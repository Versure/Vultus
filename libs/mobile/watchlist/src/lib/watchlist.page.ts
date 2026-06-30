import { AsyncPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonActionSheet,
  IonAlert,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  filmOutline,
  notificationsOutline,
  personCircleOutline,
  refreshOutline,
  swapVerticalOutline,
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
  combineLatest,
  debounceTime,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
} from 'rxjs';
import {
  STATUS_DISPLAY_ORDER,
  STATUS_LABELS,
  type StatusGroup,
  type WatchlistSort,
  WatchlistService,
  getAvailableProviders,
  groupByStatus,
  sortItems,
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
    IonBadge,
    IonIcon,
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    IonSearchbar,
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

  /** Selected status-filter chip — null = All (default, show every group). */
  selectedStatus: WatchStatus | null = null;

  /** Selected sort mode (component-local, in-session only). Default newest-added. */
  selectedSort: WatchlistSort = 'addedDesc';

  /** Sort action-sheet open state. */
  sortSheetOpen = false;

  /**
   * Selected provider names (multi-select, OR logic). Empty = show all
   * (default). Component-local; never persisted.
   */
  selectedProviders = new Set<string>();

  /**
   * Latest snapshot of tmdbId → full provider-name list, filled in
   * asynchronously as each card's `availability$` resolves (built from the SAME
   * memoized `providerCache` streams — no new Firestore reads). Kept in sync by
   * `availabilityMap$` for synchronous reads (tests / non-stream callers); the
   * reactive pipeline consumes `availabilityMap$` directly.
   */
  availabilityMap = new Map<number, string[]>();

  // Drives re-subscription when the type filter changes.
  private readonly typeFilter$ = new BehaviorSubject<TitleType | undefined>(
    undefined,
  );

  // Debounced free-text search term (case-insensitive title substring).
  private readonly searchTerm$ = new BehaviorSubject<string>('');

  // Drives recomputation when status / provider / sort selections change.
  private readonly filters$ = new BehaviorSubject<void>(undefined);

  /** The user's region (for provider availability lookups). */
  readonly region$: Observable<Region | null> = this.watchlistService
    .userRegion$(this.uid())
    .pipe(shareReplay({ bufferSize: 1, refCount: false }));

  /**
   * Type + text-search filtered items (no status/provider/sort applied yet),
   * shared so both the provider-chip derivation and the final `vm$` pipeline
   * read the same set. The provider chips and the `availabilityMap` are built
   * from the cards in THIS set, so the chips reflect exactly what type+search
   * leaves visible (composition order: type → search → [chips] → status →
   * provider → sort).
   */
  private readonly typeSearchFiltered$: Observable<WatchlistItem[]> =
    this.typeFilter$.pipe(
      switchMap((type) =>
        combineLatest([
          this.watchlistService.watchlist$(this.uid(), type),
          this.searchTerm$.pipe(debounceTime(200), startWith('')),
        ]).pipe(
          map(([items, term]) => {
            const q = term.trim().toLowerCase();
            return q
              ? items.filter((i) => i.title.toLowerCase().includes(q))
              : items;
          }),
        ),
      ),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  /**
   * Live `availabilityMap` keyed by tmdbId, derived by combining the
   * per-displayed-item `Observable<string[]>` streams (from the memoized
   * `providerCache`) for the current type+search set. Each emission rebuilds
   * the map; emits the same Map reference the page reads synchronously.
   * Region-aware (re-derives when the user region resolves/changes).
   */
  private readonly availabilityMap$: Observable<Map<number, string[]>> =
    combineLatest([this.typeSearchFiltered$, this.region$]).pipe(
      switchMap(([items, region]) => {
        if (items.length === 0) {
          return of(new Map<number, string[]>());
        }
        return combineLatest(
          items.map((item) =>
            this.providerNames$(item, region).pipe(
              map((names) => [item.tmdbId, names] as const),
            ),
          ),
        ).pipe(map((entries) => new Map<number, string[]>(entries)));
      }),
      tap((map) => {
        this.availabilityMap = map;
      }),
      // A watchlist-stream error is rendered by `vm$` (its own catchError);
      // this auxiliary chip/availability stream just degrades to an empty map
      // so the error never propagates uncaught from this parallel subscriber.
      catchError(() => of(new Map<number, string[]>())),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  /**
   * Sorted, A→Z provider names available across the (type+search-filtered)
   * cards — drives the provider-chip row. `[]` → the row is hidden.
   */
  readonly availableProviders$: Observable<string[]> = combineLatest([
    this.typeSearchFiltered$,
    this.availabilityMap$,
  ]).pipe(
    map(([items, map]) => getAvailableProviders(items, map)),
    // Error → no chips (vm$ owns the error UI); never propagate uncaught.
    catchError(() => of<string[]>([])),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * Status-filter chip data: the non-empty groups of the
   * type+search+provider-filtered set (BEFORE status narrowing), in
   * `STATUS_DISPLAY_ORDER`, each with its count. The "All" chip is rendered
   * unconditionally by the template; per-status chips render from this list.
   * Counts therefore match what selecting the chip shows.
   */
  readonly statusChips$: Observable<StatusGroup[]> = combineLatest([
    this.typeSearchFiltered$,
    this.availabilityMap$,
    this.filters$,
  ]).pipe(
    map(([items, availabilityMap]) =>
      groupByStatus(this.applyProviderFilter(items, availabilityMap)),
    ),
    // Error → no chips (vm$ owns the error UI); never propagate uncaught.
    catchError(() => of<StatusGroup[]>([])),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * View model for the list. `groups` is null until the first emission of the
   * realtime stream → the template renders skeletons; once it emits (even `[]`)
   * the empty state / grouped sections take over. A stream error maps to
   * `{ groups: null, error: true }` (caught here, not propagated) so the
   * template renders the error state with a retry. Modelled as a stream (not a
   * mutated `loading` flag) so nothing changes component state during change
   * detection.
   *
   * Composition order (binding): type → search → [provider chips derived] →
   * status → provider → sort. Status-chip counts reflect the
   * type+search+provider-filtered set (i.e. what `groupByStatus` sees), so a
   * chip's count matches what selecting it shows. Sort is applied PER group.
   */
  readonly vm$: Observable<{ groups: StatusGroup[] | null; error: boolean }> =
    combineLatest([
      this.typeSearchFiltered$,
      this.availabilityMap$,
      this.filters$,
    ]).pipe(
      map(([items, availabilityMap]) => {
        // Reconcile a stale selection against what's actually available so a
        // provider that disappeared from the map can't strand a hidden filter.
        const providerFiltered = this.applyProviderFilter(
          items,
          availabilityMap,
        );
        let groups = groupByStatus(providerFiltered);
        if (this.selectedStatus !== null) {
          groups = groups.filter((g) => g.status === this.selectedStatus);
        }
        groups = groups.map((g) => ({
          ...g,
          items: sortItems(g.items, this.selectedSort),
        }));
        return { groups, error: false };
      }),
      catchError(() => of({ groups: null, error: true })),
      startWith({ groups: null, error: false }),
    );

  /**
   * Unread-notification count for the header bell badge (spec 0042, decision 3).
   * Reactive to the `AUTH_UID` null → uid transition via the service stream;
   * counts `readAt === null` client-side (index-free). Null uid → `0`.
   */
  readonly unreadCount$: Observable<number> =
    this.watchlistService.unreadNotificationCount$;

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
      notificationsOutline,
      personCircleOutline,
      refreshOutline,
      swapVerticalOutline,
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

  /** Sort action-sheet buttons: the six modes + Cancel. */
  get sortSheetButtons() {
    const options: { sort: WatchlistSort; text: string }[] = [
      { sort: 'titleAsc', text: 'Title A → Z' },
      { sort: 'titleDesc', text: 'Title Z → A' },
      { sort: 'addedDesc', text: 'Date added (newest first)' },
      { sort: 'addedAsc', text: 'Date added (oldest first)' },
      { sort: 'releaseDesc', text: 'Release date (newest first)' },
      { sort: 'releaseAsc', text: 'Release date (oldest first)' },
    ];
    return [
      ...options.map((o) => ({
        text: o.text,
        handler: () => {
          this.onSortSelected(o.sort);
        },
      })),
      { text: 'Cancel', role: 'cancel' },
    ];
  }

  /** Opens the sort action sheet (public — bound + tested). */
  openSortSheet(): void {
    this.sortSheetOpen = true;
  }

  /** Applies the chosen sort mode and re-runs the pipeline. */
  onSortSelected(sort: WatchlistSort): void {
    this.selectedSort = sort;
    this.filters$.next();
  }

  /** Status-chip click — null = All; narrows the list to one group otherwise. */
  onStatusChipClick(status: WatchStatus | null): void {
    this.selectedStatus = status;
    this.filters$.next();
  }

  /** Pushes a new search term into the debounced search stream. */
  onSearchInput(term: string): void {
    this.searchTerm$.next(term ?? '');
  }

  /** Toggles a provider in the multi-select filter and re-runs the pipeline. */
  toggleProvider(name: string): void {
    if (this.selectedProviders.has(name)) {
      this.selectedProviders.delete(name);
    } else {
      this.selectedProviders.add(name);
    }
    this.filters$.next();
  }

  /** True when a provider chip is currently selected (template binding). */
  isProviderSelected(name: string): boolean {
    return this.selectedProviders.has(name);
  }

  /**
   * Keeps an item when no provider is selected, OR when its providers (looked
   * up by tmdbId in the availability map) intersect the selected set (OR logic).
   * Reconciles `selectedProviders` against the currently-available names first
   * so a provider that vanished from the map can't strand a hidden filter.
   */
  private applyProviderFilter(
    items: WatchlistItem[],
    availabilityMap: Map<number, string[]>,
  ): WatchlistItem[] {
    if (this.selectedProviders.size === 0) {
      return items;
    }
    const available = getAvailableProviders(items, availabilityMap);
    const reconciled = new Set(
      [...this.selectedProviders].filter((p) => available.includes(p)),
    );
    if (reconciled.size !== this.selectedProviders.size) {
      this.selectedProviders = reconciled;
    }
    if (reconciled.size === 0) {
      return items;
    }
    return items.filter((item) => {
      const names = availabilityMap.get(item.tmdbId) ?? [];
      return names.some((n) => reconciled.has(n));
    });
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

  /** Opens the notifications inbox (spec 0042). Navigates by string segments —
   *  NO import of `@vultus/mobile/notifications` (Sheriff-clean cross-slice nav). */
  openNotifications(): void {
    this.router.navigate(['tabs', 'notifications']).catch(() => {
      // notifications route not registered yet — graceful no-op.
    });
  }

  /** Bell-badge display string: "9+" when count > 9, else the number. */
  badgeLabel(count: number): string {
    return count > 9 ? '9+' : String(count);
  }

  /**
   * Navigates toward the title-detail route; never crashes. Threads the known
   * media `type` as `?type=tv|movie` so title-detail resolves the right TMDB
   * namespace (ids collide across movie/tv — spec 0043).
   */
  navigateToDetail(titleId: string, type: TitleType): void {
    this.router
      .navigate(['tabs', 'title-detail', titleId], { queryParams: { type } })
      .catch(() => {
        /* graceful no-op */
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
  private readonly providerCache = new Map<string, Observable<string[]>>();

  /**
   * FULL provider-name list for an item, in the user's region — the single
   * memoized source behind both the per-card badge (first name) and the
   * `availabilityMap` (all names). `availability$` is called once per
   * `tmdbId|region` and `shareReplay`'d, so no second Firestore Listen channel
   * is opened (decision 12).
   */
  providerNames$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<string[]> {
    const key = `${item.tmdbId}|${region ?? ''}`;
    let stream = this.providerCache.get(key);
    if (!stream) {
      stream = this.watchlistService.availability$(item.tmdbId, region).pipe(
        map((a) => a?.providers.map((p) => p.name) ?? []),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.providerCache.set(key, stream);
    }
    return stream;
  }

  /** First provider name for an item, in the user's region (badge). Derived
   *  from the same widened memoized cache (`names[0] ?? null`). */
  getProviderName$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<string | null> {
    return this.providerNames$(item, region).pipe(
      map((names) => names[0] ?? null),
    );
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
