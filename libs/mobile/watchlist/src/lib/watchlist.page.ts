import { AsyncPipe } from '@angular/common';
import { Component, DestroyRef, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonActionSheet,
  IonAlert,
  IonBadge,
  IonButton,
  IonContent,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSpinner,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowDownOutline,
  arrowUpOutline,
  checkmarkCircle,
  notificationsOutline,
  optionsOutline,
  personCircleOutline,
  refreshOutline,
  trashOutline,
} from 'ionicons/icons';
/**
 * Minimal shape of the `ionBackButton` custom event detail (Ionic dispatches it
 * on `document`). Declared locally to avoid a deep `@ionic/core` type import —
 * the slice only needs `register(priority, handler)`.
 */
interface IonBackButtonDetail {
  register(
    priority: number,
    handler: (processNextHandler: () => void) => void,
  ): void;
}
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type Region,
  type RegionAvailability,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  SyncStateService,
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

/**
 * A "Sort & Filter" sort chip — one visible chip per (default, toggled) pair of
 * the six existing `WatchlistSort` modes (decision 3). "release" is the Stitch
 * "Rating" chip relabelled "Release date" (Public types / APIs — the watchlist
 * doc has no rating field, so it maps to the existing releaseDesc/releaseAsc
 * pair rather than adding a sort mode).
 */
type SortChip = 'added' | 'name' | 'release';

/** The four fixed status chips rendered unconditionally (no "Dropped" chip). */
type StatusChipStatus = 'watching' | 'planned' | 'completed';

/** A rendered status filter chip — All (`status: null`) + the three fixed ones. */
interface StatusFilterChip {
  status: StatusChipStatus | null;
  label: string;
  count: number;
}

/**
 * The partitioned availability pill for a card (spec 0060, UI section B).
 * - `mine` — ≥1 flatrate provider whose id ∈ the user's `myProviderIds`
 *   (highlighted "On {name}" pill + check icon + logo ring); `name` is the FIRST
 *   such provider's name.
 * - `elsewhere` — no mine, but ≥1 flatrate provider (muted "Also on {name}" pill,
 *   no icon); `name` is the FIRST flatrate provider's name.
 * - `null` (not this type) — no flatrate provider at all → the page renders no
 *   pill (the existing no-chip treatment). Modelled as a nullable stream value.
 */
export type AvailabilityPill =
  | { kind: 'mine'; name: string }
  | { kind: 'elsewhere'; name: string };

/**
 * Pure partition of a title's availability into the compact-card pill view
 * (spec 0060). Filters to FLATRATE providers only (subscription coverage is a
 * flatrate concept — decision 4), then:
 *   - if any flatrate provider's id ∈ `myProviderIds` → `mine` (first such name);
 *   - else if any flatrate provider exists → `elsewhere` (first flatrate name);
 *   - else `null` (no flatrate availability → no pill).
 * Rent/buy-only availability yields `null` (they are never a compact-card pill).
 * Slice-local and deliberately duplicated with the title-detail slice's split
 * (2-slice, short of the 3+-slice extract rule — spec §"Affected slices").
 */
export function partitionAvailabilityPill(
  availability: RegionAvailability | null,
  myProviderIds: readonly number[],
): AvailabilityPill | null {
  const flatrate = (availability?.providers ?? []).filter(
    (p) => p.type === 'flatrate',
  );
  if (flatrate.length === 0) {
    return null;
  }
  const mine = flatrate.find((p) => myProviderIds.includes(p.providerId));
  if (mine) {
    return { kind: 'mine', name: mine.name };
  }
  return { kind: 'elsewhere', name: flatrate[0].name };
}

@Component({
  selector: 'lib-watchlist',
  imports: [
    AsyncPipe,
    IonContent,
    IonButton,
    IonBadge,
    IonIcon,
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    IonSearchbar,
    IonAlert,
    IonActionSheet,
    VultusAppHeader,
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

  /** Combined "Sort & Filter" bottom-sheet open state (component-local). */
  filterSheetOpen = false;

  /**
   * The fixed order the four status chips render in — All + the three real
   * statuses (no "Dropped" chip; the Advanced Watchlist design has none).
   */
  private readonly STATUS_CHIP_ORDER: StatusChipStatus[] = [
    'watching',
    'planned',
    'completed',
  ];

  /**
   * Maps a sheet Sort By chip to its (default, toggled) pair of the existing six
   * `WatchlistSort` modes (decision 3). Tapping an inactive chip selects its
   * `default`; tapping the already-active chip flips to `toggled`. Pure
   * presentation over `sortItems` — no new sort logic.
   */
  private readonly SORT_CHIP_MAP: Record<
    SortChip,
    { default: WatchlistSort; toggled: WatchlistSort }
  > = {
    added: { default: 'addedDesc', toggled: 'addedAsc' },
    name: { default: 'titleAsc', toggled: 'titleDesc' },
    release: { default: 'releaseDesc', toggled: 'releaseAsc' },
  };

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
   * The user's selected provider ids (`users/{uid}.myProviderIds`, spec 0060),
   * default `[]`. Shared (`shareReplay`) so every card's availability-pill stream
   * reads the same value without re-reading the user doc. Reads the same single
   * memoized `users/{uid}` listener the region stream uses (no second listener).
   */
  readonly myProviderIds$: Observable<number[]> = this.watchlistService
    .myProviderIds$(this.uid())
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
   * Status-filter chip data: the FIXED FOUR chips (All / Watching / Planned /
   * Completed) rendered unconditionally, each with a live count — INCLUDING zero
   * (decision 2). Counts are derived from the SAME type+search+provider-filtered
   * set `groupByStatus` sees (before status narrowing), so a chip's count equals
   * the number of cards selecting it shows; "All" is the sum. No "Dropped" chip
   * (the design has none); dropped items still group under "All". No new
   * Firestore read — this is client-side over the already-subscribed stream.
   */
  readonly statusChips$: Observable<StatusFilterChip[]> = combineLatest([
    this.typeSearchFiltered$,
    this.availabilityMap$,
    this.filters$,
  ]).pipe(
    map(([items, availabilityMap]) => {
      const filtered = this.applyProviderFilter(items, availabilityMap);
      const groups = groupByStatus(filtered);
      const countOf = (status: StatusChipStatus): number =>
        groups.find((g) => g.status === status)?.count ?? 0;
      const statusChips: StatusFilterChip[] = this.STATUS_CHIP_ORDER.map(
        (status) => ({
          status,
          label: STATUS_LABELS[status],
          count: countOf(status),
        }),
      );
      // "All" count = the full type+search+provider-filtered set (includes any
      // dropped items, which are reachable under "All" though they have no chip).
      const all: StatusFilterChip = {
        status: null,
        label: 'All',
        count: filtered.length,
      };
      return [all, ...statusChips];
    }),
    // Error → no chips (vm$ owns the error UI); never propagate uncaught.
    catchError(() => of<StatusFilterChip[]>([])),
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

  private readonly destroyRef = inject(DestroyRef);

  /**
   * Bound `ionBackButton` handler. While the combined sheet is open the Android
   * hardware back button closes the SHEET (high priority) instead of navigating;
   * otherwise it defers to Ionic's default routing. Registered on `document` (the
   * standalone-friendly path — no `@ionic/angular` `Platform` needed) and torn
   * down via `DestroyRef`.
   */
  private readonly onIonBackButton = (
    ev: CustomEvent<IonBackButtonDetail>,
  ): void => {
    if (this.filterSheetOpen) {
      // Priority 150 (> Ionic's default 100 route handler) so the sheet wins.
      ev.detail.register(150, (processNextHandler) => {
        if (this.filterSheetOpen) {
          this.closeFilterSheet();
        } else {
          processNextHandler();
        }
      });
    }
  };

  constructor() {
    addIcons({
      arrowDownOutline,
      arrowUpOutline,
      checkmarkCircle,
      notificationsOutline,
      optionsOutline,
      personCircleOutline,
      refreshOutline,
      trashOutline,
    });

    document.addEventListener(
      'ionBackButton',
      this.onIonBackButton as EventListener,
    );
    this.destroyRef.onDestroy(() => {
      document.removeEventListener(
        'ionBackButton',
        this.onIonBackButton as EventListener,
      );
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

  /** Opens the combined "Sort & Filter" bottom sheet (bound to the `tune` button). */
  openFilterSheet(): void {
    this.filterSheetOpen = true;
  }

  /**
   * Closes the combined "Sort & Filter" bottom sheet. Bound to the "Done"
   * button, a backdrop tap, and the Android hardware back handler.
   */
  closeFilterSheet(): void {
    this.filterSheetOpen = false;
  }

  /**
   * Applies the chosen sort mode and re-runs the pipeline. The underlying setter
   * behind both the sheet's Sort By chips (`onSortChipClick`) and the tests.
   */
  onSortSelected(sort: WatchlistSort): void {
    this.selectedSort = sort;
    this.filters$.next();
  }

  /**
   * Sheet Sort By chip tap (decision 3, tap-to-toggle direction): if the chip's
   * DEFAULT mode is already the active sort, flip to its TOGGLED mode; otherwise
   * apply its default. A pure mapping over the existing six `WatchlistSort` modes
   * — no new sort logic. Exposed for the component test to call directly.
   */
  onSortChipClick(chip: SortChip): void {
    const pair = this.SORT_CHIP_MAP[chip];
    const next =
      this.selectedSort === pair.default ? pair.toggled : pair.default;
    this.onSortSelected(next);
  }

  /** True when either mode of the given sort chip is the active sort (chip highlighted). */
  isSortChipActive(chip: SortChip): boolean {
    const pair = this.SORT_CHIP_MAP[chip];
    return (
      this.selectedSort === pair.default || this.selectedSort === pair.toggled
    );
  }

  /**
   * The direction affordance for the active sort chip: `'down'` for a descending
   * sort (Z→A / newest-first), `'up'` for ascending (A→Z / oldest-first), `null`
   * when the chip is inactive. Drives the arrow icon next to the active chip's
   * label (decision 3). Note: the Stitch markup did NOT express a direction
   * affordance — this arrow is added per the spec and flagged for human review.
   */
  sortChipDirection(chip: SortChip): 'up' | 'down' | null {
    if (!this.isSortChipActive(chip)) {
      return null;
    }
    const descending: WatchlistSort[] = [
      'addedDesc',
      'titleDesc',
      'releaseDesc',
    ];
    return descending.includes(this.selectedSort) ? 'down' : 'up';
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
    // Fire-and-forget: the action sheet closes immediately; the completed-path
    // episode batch (spec 0053) runs asynchronously in the service.
    void this.watchlistService.updateStatus(
      this.uid(),
      this.titleId(item),
      status,
      item.type,
    );
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
      .navigate(['tabs', 'title-detail', titleId], {
        queryParams: { type, origin: 'watchlist' },
      })
      .catch(() => {
        /* graceful no-op */
      });
  }

  /**
   * Memoized provider-name streams, keyed by `tmdbId|region`. These feed the
   * `availabilityMap` / provider-filter chip row (which need only names).
   * Memoized because a fresh Observable per change-detection pass would make an
   * `| async` binding resubscribe (and open a new Firestore `docData` listener)
   * every cycle, an unbounded Listen-channel loop. Caching one shared instance
   * per key keeps the reference (and the underlying listener) stable across CD.
   */
  private readonly providerCache = new Map<string, Observable<string[]>>();

  /**
   * FULL provider-name list for an item, in the user's region — the memoized
   * source behind the `availabilityMap` (all names) and the provider-filter
   * chips. `availability$` is subscribed once per `tmdbId|region` and
   * `shareReplay`'d, so no extra Firestore Listen channel is opened (decision
   * 12). The per-card availability PILL (spec 0060) uses a sibling cache
   * (`availabilityCache`) because it needs each provider's `type` + `providerId`.
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

  /**
   * Memoized FULL-availability streams keyed by `tmdbId|region`, feeding the
   * partitioned availability pill (spec 0060). Separate from `providerCache`
   * (which yields only `string[]` names for the chip/filter row): the pill needs
   * each provider's `type` + `providerId` to filter flatrate and match
   * `myProviderIds`. Memoized for the same reason as `providerCache` — the
   * template binds `availabilityPill$(...) | async`, which Angular re-invokes
   * every change-detection pass; returning a fresh Observable each time would
   * resubscribe (opening a new Firestore listener) every cycle. One shared
   * `shareReplay` instance per key keeps the reference (and listener) stable.
   */
  private readonly availabilityCache = new Map<
    string,
    Observable<RegionAvailability | null>
  >();

  private availability$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<RegionAvailability | null> {
    const key = `${item.tmdbId}|${region ?? ''}`;
    let stream = this.availabilityCache.get(key);
    if (!stream) {
      stream = this.watchlistService
        .availability$(item.tmdbId, region)
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
      this.availabilityCache.set(key, stream);
    }
    return stream;
  }

  /**
   * The partitioned availability pill for a card (spec 0060, UI section B):
   * `{ kind: 'mine' }` / `{ kind: 'elsewhere' }` / `null`. Combines the memoized
   * per-`tmdbId|region` availability with the user's `myProviderIds` via the pure
   * `partitionAvailabilityPill`. Replaces the old flat `getProviderName$` badge.
   * Memoized inputs → no fresh listener per change-detection cycle.
   */
  availabilityPill$(
    item: WatchlistItem,
    region: Region | null,
  ): Observable<AvailabilityPill | null> {
    return combineLatest([
      this.availability$(item, region),
      this.myProviderIds$,
    ]).pipe(
      map(([availability, myProviderIds]) =>
        partitionAvailabilityPill(availability, myProviderIds),
      ),
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
