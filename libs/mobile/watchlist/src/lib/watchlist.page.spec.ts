import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  ToastController,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { type WatchlistItem } from '@vultus/shared/domain';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncStateService } from '@vultus/shared/ui-kit';

// Mock the data-access service module so the page test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks the
// jsdom transform). The page also imports `groupByStatus` / `filterByType` /
// `sortItems` / `getAvailableProviders` / `STATUS_*` from this module, so the
// factory re-provides faithful pure stand-ins (no Firebase) alongside a bare
// service class used purely as the DI token. The factory is hoisted, so it must
// be fully self-contained (no outer references).
vi.mock('./watchlist.service', () => {
  const order = ['watching', 'planned', 'completed', 'dropped'] as const;
  const labels: Record<string, string> = {
    watching: 'Watching',
    planned: 'Planned',
    completed: 'Completed',
    dropped: 'Dropped',
  };
  interface Item {
    type: string;
    status: string;
    title: string;
    tmdbId: number;
    addedAt: string;
    releaseDate?: string | null;
  }
  return {
    WatchlistService: class WatchlistService {},
    STATUS_DISPLAY_ORDER: [...order],
    STATUS_LABELS: labels,
    filterByType: (items: { type: string }[], type?: 'movie' | 'tv') =>
      type ? items.filter((i) => i.type === type) : items,
    groupByStatus: (items: Item[]) =>
      order
        .map((status) => {
          const groupItems = items.filter((i) => i.status === status);
          return {
            status,
            label: labels[status],
            count: groupItems.length,
            items: groupItems,
          };
        })
        .filter((g) => g.count > 0),
    // Faithful pure stand-in mirroring the real helper's binding: stable,
    // non-mutating, null/absent releaseDate sorts to the END in both directions.
    sortItems: (items: Item[], sort: string) => {
      const copy = items.slice();
      const cmpStr = (a: string, b: string) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' });
      switch (sort) {
        case 'titleAsc':
          return copy.sort((a, b) => cmpStr(a.title, b.title));
        case 'titleDesc':
          return copy.sort((a, b) => cmpStr(b.title, a.title));
        case 'addedAsc':
          return copy.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
        case 'addedDesc':
          return copy.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
        case 'releaseDesc':
        case 'releaseAsc': {
          const desc = sort === 'releaseDesc';
          return copy.sort((a, b) => {
            const ra = a.releaseDate ?? null;
            const rb = b.releaseDate ?? null;
            if (ra === null && rb === null) return 0;
            if (ra === null) return 1; // nulls last
            if (rb === null) return -1;
            return desc ? rb.localeCompare(ra) : ra.localeCompare(rb);
          });
        }
        default:
          return copy;
      }
    },
    getAvailableProviders: (
      items: Item[],
      availabilityMap: Map<number, string[]>,
    ) => {
      const seen = new Set<string>();
      for (const item of items) {
        for (const name of availabilityMap.get(item.tmdbId) ?? []) {
          seen.add(name);
        }
      }
      return [...seen].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      );
    },
  };
});

import { WatchlistPage } from './watchlist.page';
import { WatchlistService, filterByType } from './watchlist.service';

function item(over: Partial<WatchlistItem>): WatchlistItem {
  return {
    type: 'movie',
    tmdbId: 1,
    traktId: null,
    title: 'Title',
    addedAt: '2026-03-04T05:06:07.000Z',
    status: 'watching',
    ...over,
  };
}

/** Availability doc shape the page maps via `a?.providers.map(p => p.name)`. */
function availability(names: string[]) {
  return { providers: names.map((name) => ({ name })) };
}

interface MockService {
  watchlist$: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  removeTitle: ReturnType<typeof vi.fn>;
  userRegion$: ReturnType<typeof vi.fn>;
  availability$: ReturnType<typeof vi.fn>;
  unreadNotificationCount$: ReturnType<typeof of>;
}

// The page calls watchlist$(uid, type) and applies groupByStatus itself, but the
// type filter lives in the service (filterByType). Replicate that here so the
// segment-switch test exercises real filtering.
//
// `providersByTmdbId` lets a test supply per-title availability so the provider
// chip row / provider filter / per-card badge can be exercised without opening a
// real Firestore listener.
function mockService(
  items: WatchlistItem[],
  unreadCount = 0,
  providersByTmdbId: Record<number, string[]> = {},
  region: string | null = null,
): MockService {
  return {
    watchlist$: vi.fn((_uid: string | null, type?: 'movie' | 'tv') =>
      of(filterByType(items, type)),
    ),
    updateStatus: vi.fn(),
    removeTitle: vi.fn(),
    userRegion$: vi.fn(() => of(region)),
    availability$: vi.fn((tmdbId: number) => {
      const names = providersByTmdbId[tmdbId];
      return of(names ? availability(names) : null);
    }),
    unreadNotificationCount$: of(unreadCount),
  };
}

interface MockSyncState {
  canSync: WritableSignal<boolean>;
  syncing: WritableSignal<boolean>;
  triggerSync: ReturnType<typeof vi.fn>;
}

function mockSyncState(over: Partial<MockSyncState> = {}): MockSyncState {
  return {
    canSync: over.canSync ?? signal(true),
    syncing: over.syncing ?? signal(false),
    triggerSync: over.triggerSync ?? vi.fn(() => Promise.resolve(undefined)),
  };
}

function mockToastCtrl() {
  const present = vi.fn(() => Promise.resolve(undefined));
  const create = vi.fn(() => Promise.resolve({ present }));
  return { create, present };
}

function mockRouter() {
  return { navigate: vi.fn(() => Promise.resolve(true)) };
}

async function setup(
  service: MockService,
  uid: string | null = 'uid-123',
  syncState: MockSyncState = mockSyncState(),
  toast = mockToastCtrl(),
  router = mockRouter(),
) {
  await TestBed.configureTestingModule({
    imports: [WatchlistPage],
    providers: [
      provideIonicAngular(),
      { provide: WatchlistService, useValue: service },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: Router, useValue: router },
      { provide: SyncStateService, useValue: syncState },
      { provide: ToastController, useValue: toast },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(WatchlistPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, syncState, toast, router };
}

/** The refresh button is the first ion-button in the toolbar's slot="end". */
function refreshButton(el: HTMLElement): HTMLElement {
  const btn = el.querySelector<HTMLElement>(
    'ion-buttons[slot="end"] ion-button[aria-label="Refresh watchlist"], ion-buttons[slot="end"] ion-button[aria-label="Syncing…"], ion-buttons[slot="end"] ion-button[aria-label="Synced just now"]',
  );
  if (!btn) {
    throw new Error('refresh button not found');
  }
  return btn;
}

/** The notifications bell button (aria-label="Notifications"). */
function bellButton(el: HTMLElement): HTMLElement {
  const btn = el.querySelector<HTMLElement>(
    'ion-buttons[slot="end"] ion-button[aria-label="Notifications"]',
  );
  if (!btn) {
    throw new Error('bell button not found');
  }
  return btn;
}

/** The combined sort/filter trigger button (aria-label="Sort and filter"). */
function filterTrigger(el: HTMLElement): HTMLElement {
  const btn = el.querySelector<HTMLElement>(
    '.search-row .filter-trigger[aria-label="Sort and filter"]',
  );
  if (!btn) {
    throw new Error('filter trigger not found');
  }
  return btn;
}

/** All status-filter chip buttons (the fixed four: All + three statuses). */
function statusChips(el: HTMLElement): HTMLElement[] {
  return Array.from(
    el.querySelectorAll<HTMLElement>('.status-filter .status-chip-btn'),
  );
}

/** Status-chip label + count as a normalized "Label N" string, in DOM order. */
function statusChipTexts(el: HTMLElement): string[] {
  return statusChips(el).map((c) =>
    (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

/** Type-tab buttons in the underline type-tab row. */
function typeTabs(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.type-tabs .type-tab'));
}

/** Provider chip labels inside the sheet (empty when no chips render). */
function providerChips(el: HTMLElement): string[] {
  return Array.from(
    el.querySelectorAll<HTMLElement>(
      '.filter-sheet .provider-filter .filter-chip',
    ),
  ).map((b) => b.textContent?.trim() ?? '');
}

/** Card titles, in DOM order, across all rendered status sections. */
function cardTitles(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.card-title')).map(
    (p) => p.textContent?.trim() ?? '',
  );
}

/** Rendered status section labels in DOM order. */
function sectionLabels(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.section-title')).map(
    (s) => s.textContent?.trim() ?? '',
  );
}

/**
 * IonButton's `disabled` is a property bound via Angular, not an attribute that
 * reflects to the host in jsdom — read the property (falling back to the attr).
 */
function isDisabled(btn: HTMLElement): boolean {
  return (
    (btn as { disabled?: boolean }).disabled === true ||
    btn.hasAttribute('disabled')
  );
}

/** Re-run change detection + microtasks so async-pipe streams settle. */
async function settle(fixture: {
  detectChanges: () => void;
  whenStable: () => Promise<unknown>;
}): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/**
 * Opens the combined sheet by clicking its `tune` trigger, then settles. Uses
 * the trigger's `(click)="openFilterSheet()"` binding — an Angular-driven event
 * tick that commits the `filterSheetOpen` styling binding cleanly (a bare
 * `component.openFilterSheet()` + manual detectChanges races the dev-mode
 * checkNoChanges verification pass on `[class.open]`). The direct-method
 * contract is still asserted separately by the tune-trigger open/close test.
 */
async function openSheet(fixture: {
  nativeElement: HTMLElement;
  detectChanges: () => void;
  whenStable: () => Promise<unknown>;
}): Promise<void> {
  await settle(fixture);
  filterTrigger(fixture.nativeElement).click();
  await settle(fixture);
}

describe('WatchlistPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('type segment switching filters cards without re-querying', async () => {
    const service = mockService([
      item({ tmdbId: 1, type: 'movie', title: 'Movie A' }),
      item({ tmdbId: 2, type: 'tv', title: 'Show B' }),
    ]);
    const { fixture, el } = await setup(service);

    // All → both render.
    expect(el.textContent).toContain('Movie A');
    expect(el.textContent).toContain('Show B');

    const component = fixture.componentInstance;
    component.onTypeChange(
      new CustomEvent('ionChange', { detail: { value: 'movie' } }),
    );
    await settle(fixture);
    expect(el.textContent).toContain('Movie A');
    expect(el.textContent).not.toContain('Show B');

    component.onTypeChange(
      new CustomEvent('ionChange', { detail: { value: 'tv' } }),
    );
    await settle(fixture);
    expect(el.textContent).not.toContain('Movie A');
    expect(el.textContent).toContain('Show B');
  });

  it('navigates to title-detail with ?type when card is clicked', async () => {
    const svc = mockService([
      item({
        tmdbId: 603,
        type: 'movie',
        title: 'The Matrix',
        status: 'watching',
      }),
    ]);
    const { el } = await setup(svc);
    const { navigate } = TestBed.inject(Router) as {
      navigate: ReturnType<typeof vi.fn>;
    };
    const card = el.querySelector<HTMLElement>('.watchlist-card');
    card?.click();
    expect(navigate).toHaveBeenCalledWith(['tabs', 'title-detail', '603'], {
      queryParams: { type: 'movie' },
    });
  });

  it('navigates to title-detail with ?type on keyup.enter', async () => {
    const svc = mockService([
      item({
        tmdbId: 1396,
        type: 'tv',
        title: 'Breaking Bad',
        status: 'planned',
      }),
    ]);
    const { el } = await setup(svc);
    const { navigate } = TestBed.inject(Router) as {
      navigate: ReturnType<typeof vi.fn>;
    };
    const card = el.querySelector<HTMLElement>('.watchlist-card');
    card?.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }),
    );
    expect(navigate).toHaveBeenCalledWith(['tabs', 'title-detail', '1396'], {
      queryParams: { type: 'tv' },
    });
  });

  it('renders empty state when the stream emits []', async () => {
    const service = mockService([]);
    const { el } = await setup(service);
    expect(el.querySelector('vultus-empty-state')).toBeTruthy();
    expect(el.textContent).toContain('Your watchlist is empty');
    expect(el.textContent).toContain('Search for a title to get started');
    expect(el.querySelector('.watchlist-card')).toBeFalsy();
  });

  it('shows skeleton while loading, not the empty state', async () => {
    // A stream that never emits keeps loading=true past first change detection.
    const service = mockService([]);
    service.watchlist$ = vi.fn(() => NEVER);
    const { el } = await setup(service);
    expect(el.querySelector('vultus-skeleton-card')).toBeTruthy();
    expect(el.textContent).not.toContain('Your watchlist is empty');
  });

  it('shows error state when the stream errors', async () => {
    const service = mockService([]);
    service.watchlist$ = vi.fn(() =>
      throwError(() => new Error('Firestore error')),
    );
    const { el } = await setup(service);
    expect(el.querySelector('vultus-error-state')).toBeTruthy();
    expect(el.querySelector('vultus-skeleton-card')).toBeFalsy();
    expect(el.textContent).not.toContain('Your watchlist is empty');
  });

  it('openStatusSheet opens the action sheet; selecting a status calls updateStatus with the item type', async () => {
    const service = mockService([item({ tmdbId: 1, type: 'movie' })]);
    const { fixture, el } = await setup(service);
    const component = fixture.componentInstance;

    // The action-sheet element is always present; opening flips its [isOpen].
    expect(el.querySelector('ion-action-sheet')).toBeTruthy();
    component.openStatusSheet(
      item({ tmdbId: 1, type: 'movie', status: 'watching' }),
    );
    expect(component.actionSheetOpen).toBe(true);

    component.onStatusSelected('completed');
    expect(service.updateStatus).toHaveBeenCalledWith(
      'uid-123',
      '1',
      'completed',
      'movie',
    );
  });

  it('selecting "Completed" for a TV item passes item.type ("tv") to updateStatus (spec 0053)', async () => {
    const service = mockService([item({ tmdbId: 2, type: 'tv' })]);
    const { fixture } = await setup(service);
    const component = fixture.componentInstance;

    component.openStatusSheet(
      item({ tmdbId: 2, type: 'tv', status: 'watching' }),
    );
    component.onStatusSelected('completed');

    expect(service.updateStatus).toHaveBeenCalledWith(
      'uid-123',
      '2',
      'completed',
      'tv',
    );
  });

  it('delete confirm opens the alert; confirming calls removeTitle', async () => {
    const service = mockService([item({ tmdbId: 9, type: 'tv' })]);
    const { fixture, el } = await setup(service);
    const component = fixture.componentInstance;

    expect(el.querySelector('ion-alert')).toBeTruthy();
    component.onDeleteConfirm(item({ tmdbId: 9, type: 'tv' }));
    expect(component.alertOpen).toBe(true);

    component.onDeleteItem();
    expect(service.removeTitle).toHaveBeenCalledWith('uid-123', '9');
  });

  it('renders status section headers in display order with counts', async () => {
    const service = mockService([
      item({ tmdbId: 1, status: 'completed', title: 'C1' }),
      item({ tmdbId: 2, status: 'watching', title: 'W1' }),
      item({ tmdbId: 3, status: 'planned', title: 'P1' }),
    ]);
    const { el } = await setup(service);
    const headers = Array.from(el.querySelectorAll('.section-header')).map(
      (d) => d.textContent?.trim() ?? '',
    );
    expect(headers[0]).toContain('Watching');
    expect(headers[1]).toContain('Planned');
    expect(headers[2]).toContain('Completed');
    expect(headers[0]).toContain('1 Items');
  });

  // ── Layout order ───────────────────────────────────────────────────────────

  describe('layout order', () => {
    it('renders status chips before type tabs, before the search bar', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
      ]);
      const { el } = await setup(service);

      // Collect the three rows in DOM order and assert their class sequence.
      const rows = Array.from(
        el.querySelectorAll('.status-filter, .type-tabs, .search-row'),
      ).map((n) =>
        n.classList.contains('status-filter')
          ? 'status'
          : n.classList.contains('type-tabs')
            ? 'type'
            : 'search',
      );
      expect(rows).toEqual(['status', 'type', 'search']);
    });

    it('has no standalone inline provider-filter row and no toolbar sort button', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
      ]);
      const { el } = await setup(service);

      // The provider filter lives ONLY inside the sheet now.
      expect(el.querySelector('ion-content > .provider-filter')).toBeFalsy();
      // The old toolbar sort button is gone.
      expect(
        el.querySelector(
          'ion-buttons[slot="end"] ion-button[aria-label="Sort watchlist"]',
        ),
      ).toBeFalsy();
      // The removed sort action-sheet had header="Sort by"; only the status
      // action-sheet ("Set status") remains.
      const sheets = Array.from(el.querySelectorAll('ion-action-sheet'));
      expect(sheets).toHaveLength(1);
    });
  });

  // ── Status filter chips ──────────────────────────────────────────────────

  describe('status filter chips', () => {
    it('renders the fixed four chips (All / Watching / Planned / Completed) with live counts, All active', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
        item({ tmdbId: 2, status: 'watching', title: 'W2' }),
        item({ tmdbId: 3, status: 'watching', title: 'W3' }),
        item({ tmdbId: 4, status: 'planned', title: 'P1' }),
        item({ tmdbId: 5, status: 'planned', title: 'P2' }),
        // No 'completed' item → Completed chip still renders with count 0.
        // No 'dropped' item and no dropped chip in any case.
      ]);
      const { el } = await setup(service);
      const chips = statusChipTexts(el);

      // Exactly four chips, in fixed order; Completed shows 0 (rendered, not hidden).
      expect(chips).toEqual([
        'All 5',
        'Watching 3',
        'Planned 2',
        'Completed 0',
      ]);
      expect(chips.some((c) => c.startsWith('Dropped'))).toBe(false);
      // "All" count = the sum of the visible cards.
      expect(chips[0]).toBe('All 5');

      // "All" chip is active by default.
      expect(statusChips(el)[0].classList.contains('active')).toBe(true);
    });

    it('renders all four chips with count 0 for an empty watchlist', async () => {
      const service = mockService([]);
      const { el } = await setup(service);
      expect(statusChipTexts(el)).toEqual([
        'All 0',
        'Watching 0',
        'Planned 0',
        'Completed 0',
      ]);
    });

    it('clicking a status chip narrows the displayed groups to that one status', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
        item({ tmdbId: 2, status: 'planned', title: 'P1' }),
        item({ tmdbId: 3, status: 'completed', title: 'C1' }),
      ]);
      const { fixture, el } = await setup(service);

      fixture.componentInstance.onStatusChipClick('planned');
      await settle(fixture);

      expect(sectionLabels(el)).toEqual(['Planned']);
      expect(cardTitles(el)).toEqual(['P1']);
      expect(el.textContent).not.toContain('W1');
      expect(el.textContent).not.toContain('C1');
    });

    it('clicking "All" restores every group', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
        item({ tmdbId: 2, status: 'planned', title: 'P1' }),
      ]);
      const { fixture, el } = await setup(service);

      fixture.componentInstance.onStatusChipClick('watching');
      await settle(fixture);
      expect(sectionLabels(el)).toEqual(['Watching']);

      fixture.componentInstance.onStatusChipClick(null);
      await settle(fixture);
      expect(sectionLabels(el)).toEqual(['Watching', 'Planned']);
    });

    it('chip counts match the visible cards', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
        item({ tmdbId: 2, status: 'watching', title: 'W2' }),
        item({ tmdbId: 3, status: 'watching', title: 'W3' }),
        item({ tmdbId: 4, status: 'planned', title: 'P1' }),
      ]);
      const { el } = await setup(service);
      const chips = statusChipTexts(el);
      expect(chips).toContain('Watching 3');
      expect(chips).toContain('Planned 1');
      expect(chips).toContain('Completed 0');
      expect(chips[0]).toBe('All 4');
    });
  });

  // ── Type tabs (underline restyle; behavior preserved) ────────────────────────

  describe('type tabs (underline)', () => {
    it('renders three plain-button underline tabs, not an ion-segment', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'W1' }),
      ]);
      const { el } = await setup(service);

      // No ion-segment container anywhere on the page.
      expect(el.querySelector('ion-segment')).toBeFalsy();

      const tabs = typeTabs(el);
      expect(tabs).toHaveLength(3);
      expect(tabs.map((t) => t.textContent?.trim())).toEqual([
        'All',
        'Movies',
        'TV Shows',
      ]);
      // All tabs are plain <button>s.
      expect(tabs.every((t) => t.tagName.toLowerCase() === 'button')).toBe(
        true,
      );
      // "All" active on first render.
      expect(tabs[0].classList.contains('active')).toBe(true);
    });

    it('clicking a type tab still filters (onFilterClick preserved)', async () => {
      const service = mockService([
        item({ tmdbId: 1, type: 'movie', title: 'Movie A' }),
        item({ tmdbId: 2, type: 'tv', title: 'Show B' }),
      ]);
      const { fixture, el } = await setup(service);

      typeTabs(el)[1].click(); // Movies
      await settle(fixture);
      expect(fixture.componentInstance.selectedType).toBe('movie');
      expect(cardTitles(el)).toEqual(['Movie A']);
      expect(typeTabs(el)[1].classList.contains('active')).toBe(true);

      typeTabs(el)[2].click(); // TV Shows
      await settle(fixture);
      expect(fixture.componentInstance.selectedType).toBe('tv');
      expect(cardTitles(el)).toEqual(['Show B']);
    });
  });

  // ── Text search ──────────────────────────────────────────────────────────

  describe('text search', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('filters cards case-insensitively after the 200ms debounce', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'The Matrix' }),
        item({ tmdbId: 2, status: 'watching', title: 'Inception' }),
      ]);
      const { fixture, el } = await setup(service);

      // Both render before any search.
      expect(cardTitles(el)).toEqual(['The Matrix', 'Inception']);

      // Case-insensitive term — not applied until the debounce elapses.
      fixture.componentInstance.onSearchInput('MATRIX');
      vi.advanceTimersByTime(199);
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['The Matrix', 'Inception']);

      vi.advanceTimersByTime(1);
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['The Matrix']);
      expect(el.textContent).not.toContain('Inception');
    });

    it('an empty term restores the full list', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'The Matrix' }),
        item({ tmdbId: 2, status: 'watching', title: 'Inception' }),
      ]);
      const { fixture, el } = await setup(service);

      fixture.componentInstance.onSearchInput('matrix');
      vi.advanceTimersByTime(200);
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['The Matrix']);

      // Clearing → same path as an empty onSearchInput('').
      fixture.componentInstance.onSearchInput('');
      vi.advanceTimersByTime(200);
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['The Matrix', 'Inception']);
    });
  });

  // ── Combined "Sort & Filter" sheet (open/close) ──────────────────────────────

  describe('combined sort/filter sheet', () => {
    it('tune trigger opens the sheet; Done closes it', async () => {
      const service = mockService([item({ tmdbId: 1, status: 'watching' })]);
      const { fixture, el } = await setup(service);
      const component = fixture.componentInstance;

      expect(component.filterSheetOpen).toBe(false);
      filterTrigger(el).click();
      await settle(fixture);
      expect(component.filterSheetOpen).toBe(true);

      // The sheet shows a Sort By section and a Provider section.
      const headings = Array.from(
        el.querySelectorAll('.filter-sheet .filter-section-heading'),
      ).map((h) => h.textContent?.trim());
      expect(headings).toEqual(['Sort By', 'Provider']);

      // "Done" closes the sheet.
      const done = el.querySelector<HTMLElement>('.filter-sheet-done');
      done?.click();
      await settle(fixture);
      expect(component.filterSheetOpen).toBe(false);
    });

    it('backdrop tap closes the sheet', async () => {
      const service = mockService([item({ tmdbId: 1, status: 'watching' })]);
      const { fixture, el } = await setup(service);

      await openSheet(fixture);
      const backdrop = el.querySelector<HTMLElement>('.filter-sheet-backdrop');
      backdrop?.click();
      await settle(fixture);
      expect(fixture.componentInstance.filterSheetOpen).toBe(false);
    });

    it('shows the three Sort By chips (Date Added / Name / Release date)', async () => {
      const service = mockService([item({ tmdbId: 1, status: 'watching' })]);
      const { fixture, el } = await setup(service);
      await openSheet(fixture);

      const sortChips = Array.from(
        el.querySelectorAll<HTMLElement>(
          '.filter-sheet .filter-section:first-child .filter-chip',
        ),
      ).map((c) => c.textContent?.trim() ?? '');
      expect(sortChips).toEqual(['Date Added', 'Name', 'Release date']);
    });
  });

  // ── Provider filter chips (inside the sheet) ─────────────────────────────────

  describe('provider filter chips (in sheet)', () => {
    it('renders the provider chips from the availability map', async () => {
      const service = mockService(
        [
          item({ tmdbId: 1, status: 'watching', title: 'A' }),
          item({ tmdbId: 2, status: 'watching', title: 'B' }),
        ],
        0,
        { 1: ['Netflix'], 2: ['Max'] },
      );
      const { fixture, el } = await setup(service);
      await openSheet(fixture);
      // A→Z sorted union of provider names.
      expect(providerChips(el)).toEqual(['Max', 'Netflix']);
    });

    it('toggleProvider with two providers shows items matching either (OR)', async () => {
      const service = mockService(
        [
          item({ tmdbId: 1, status: 'watching', title: 'A' }),
          item({ tmdbId: 2, status: 'watching', title: 'B' }),
          item({ tmdbId: 3, status: 'watching', title: 'C' }),
        ],
        0,
        { 1: ['Netflix'], 2: ['Max'], 3: ['Disney+'] },
      );
      const { fixture, el } = await setup(service);

      fixture.componentInstance.toggleProvider('Netflix');
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['A']);

      fixture.componentInstance.toggleProvider('Max');
      await settle(fixture);
      // OR logic — both A (Netflix) and B (Max), but not C (Disney+).
      expect(cardTitles(el).sort()).toEqual(['A', 'B']);
    });

    it('deselecting all providers restores the full list', async () => {
      const service = mockService(
        [
          item({ tmdbId: 1, status: 'watching', title: 'A' }),
          item({ tmdbId: 2, status: 'watching', title: 'B' }),
        ],
        0,
        { 1: ['Netflix'], 2: ['Max'] },
      );
      const { fixture, el } = await setup(service);

      fixture.componentInstance.toggleProvider('Netflix');
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['A']);

      fixture.componentInstance.toggleProvider('Netflix');
      await settle(fixture);
      expect(cardTitles(el).sort()).toEqual(['A', 'B']);
    });

    it('shows a muted "none" line and no chips when no availability is loaded', async () => {
      // availability$ returns null for every tmdbId → getAvailableProviders → [].
      const service = mockService([
        item({ tmdbId: 1, status: 'watching', title: 'A' }),
      ]);
      const { fixture, el } = await setup(service);
      await openSheet(fixture);

      expect(providerChips(el)).toEqual([]);
      // The Provider section still renders (with the muted empty line) and the
      // sheet remains usable (Sort By section present).
      const empty = el.querySelector('.filter-sheet .filter-empty');
      expect(empty?.textContent?.trim()).toBe('No providers available yet');
    });
  });

  // ── Sort (tap-to-toggle direction) ───────────────────────────────────────────

  describe('sort', () => {
    it('onSortChipClick maps the three chips to all six WatchlistSort modes (tap-to-toggle)', async () => {
      const service = mockService([item({ tmdbId: 1, status: 'watching' })]);
      const { fixture } = await setup(service);
      const c = fixture.componentInstance;

      // Default is addedDesc.
      expect(c.selectedSort).toBe('addedDesc');
      // Active chip tapped again flips direction.
      c.onSortChipClick('added');
      expect(c.selectedSort).toBe('addedAsc');
      // Tapping again flips back.
      c.onSortChipClick('added');
      expect(c.selectedSort).toBe('addedDesc');

      // Name: default titleAsc, toggle titleDesc.
      c.onSortChipClick('name');
      expect(c.selectedSort).toBe('titleAsc');
      c.onSortChipClick('name');
      expect(c.selectedSort).toBe('titleDesc');

      // Release date: default releaseDesc, toggle releaseAsc.
      c.onSortChipClick('release');
      expect(c.selectedSort).toBe('releaseDesc');
      c.onSortChipClick('release');
      expect(c.selectedSort).toBe('releaseAsc');
    });

    it('defaults to addedDesc (date-added newest first)', async () => {
      const service = mockService([
        item({
          tmdbId: 1,
          status: 'watching',
          title: 'Old',
          addedAt: '2026-01-01T00:00:00.000Z',
        }),
        item({
          tmdbId: 2,
          status: 'watching',
          title: 'New',
          addedAt: '2026-06-01T00:00:00.000Z',
        }),
      ]);
      const { fixture, el } = await setup(service);
      expect(fixture.componentInstance.selectedSort).toBe('addedDesc');
      // Newest (New) first.
      expect(cardTitles(el)).toEqual(['New', 'Old']);
    });

    it('onSortSelected("titleAsc") reorders within each group, groups stay in display order', async () => {
      const service = mockService([
        item({ tmdbId: 1, status: 'completed', title: 'Zelda' }),
        item({ tmdbId: 2, status: 'completed', title: 'Alpha' }),
        item({ tmdbId: 3, status: 'watching', title: 'Mango' }),
        item({ tmdbId: 4, status: 'watching', title: 'Banana' }),
      ]);
      const { fixture, el } = await setup(service);

      fixture.componentInstance.onSortSelected('titleAsc');
      await settle(fixture);

      // Group order stays Watching → Completed; items sorted A→Z within each.
      expect(sectionLabels(el)).toEqual(['Watching', 'Completed']);
      expect(cardTitles(el)).toEqual(['Banana', 'Mango', 'Alpha', 'Zelda']);
    });

    it('release-date sorts push null-releaseDate items to the end', async () => {
      const service = mockService([
        item({
          tmdbId: 1,
          status: 'watching',
          title: 'NoDate',
          releaseDate: null,
        }),
        item({
          tmdbId: 2,
          status: 'watching',
          title: 'Older',
          releaseDate: '2010-01-01',
        }),
        item({
          tmdbId: 3,
          status: 'watching',
          title: 'Newer',
          releaseDate: '2024-01-01',
        }),
      ]);
      const { fixture, el } = await setup(service);

      fixture.componentInstance.onSortSelected('releaseDesc');
      await settle(fixture);
      expect(cardTitles(el)).toEqual(['Newer', 'Older', 'NoDate']);

      fixture.componentInstance.onSortSelected('releaseAsc');
      await settle(fixture);
      // Nulls still last even ascending.
      expect(cardTitles(el)).toEqual(['Older', 'Newer', 'NoDate']);
    });
  });

  // ── Provider badge (regression — widened cache mock shape) ──────────────────

  describe('per-card provider badge (widened cache)', () => {
    it('shows the first provider name on a planned card from the string[] stream', async () => {
      // The cache is now Observable<string[]>; the badge maps names[0] ?? null.
      const service = mockService(
        [item({ tmdbId: 1, status: 'planned', title: 'P1' })],
        0,
        { 1: ['Netflix', 'Max'] },
        'US',
      );
      const { el } = await setup(service);
      const badge = el.querySelector<HTMLElement>('.availability-badge');
      expect(badge?.textContent?.trim()).toBe('Netflix');
    });

    it('shows the first provider name on a non-planned card', async () => {
      const service = mockService(
        [item({ tmdbId: 7, status: 'watching', title: 'W1' })],
        0,
        { 7: ['Disney+'] },
        'US',
      );
      const { el } = await setup(service);
      const badge = el.querySelector<HTMLElement>('.provider-badge');
      expect(badge?.textContent?.trim()).toBe('Disney+');
    });
  });

  describe('toolbar refresh button (spec 0025)', () => {
    it('idle: renders in slot="end", enabled, aria-label="Refresh watchlist"', async () => {
      const service = mockService([]);
      const { el } = await setup(service);
      const btn = refreshButton(el);

      expect(btn.getAttribute('aria-label')).toBe('Refresh watchlist');
      expect(isDisabled(btn)).toBe(false);
      // Idle shows the refresh icon, not the spinner.
      expect(
        btn.querySelector('ion-icon[name="refresh-outline"]'),
      ).toBeTruthy();
      expect(btn.querySelector('ion-spinner')).toBeFalsy();
    });

    it('click calls syncState.triggerSync; while syncing the button shows the spinner and is disabled', async () => {
      const service = mockService([]);
      const syncState = mockSyncState();
      const { fixture, el } = await setup(service, 'uid-123', syncState);

      await fixture.componentInstance.onSync();
      expect(syncState.triggerSync).toHaveBeenCalledTimes(1);

      // Simulate the in-flight state the service would set.
      syncState.syncing.set(true);
      fixture.detectChanges();

      const btn = refreshButton(el);
      expect(isDisabled(btn)).toBe(true);
      expect(btn.getAttribute('aria-label')).toBe('Syncing…');
      expect(btn.querySelector('ion-spinner[name="crescent"]')).toBeTruthy();
      expect(btn.querySelector('ion-icon[name="refresh-outline"]')).toBeFalsy();
    });

    it('success presents the "Watchlist synced" toast', async () => {
      const service = mockService([]);
      const syncState = mockSyncState({
        triggerSync: vi.fn(() => Promise.resolve(undefined)),
      });
      const toast = mockToastCtrl();
      const { fixture } = await setup(service, 'uid-123', syncState, toast);

      await fixture.componentInstance.onSync();

      expect(toast.create).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Watchlist synced',
          color: 'success',
          duration: 2000,
          position: 'bottom',
        }),
      );
      expect(toast.present).toHaveBeenCalled();
    });

    it('failure presents the error toast (color: danger)', async () => {
      const service = mockService([]);
      const syncState = mockSyncState({
        triggerSync: vi.fn(() => Promise.reject(new Error('boom'))),
      });
      const toast = mockToastCtrl();
      const { fixture } = await setup(service, 'uid-123', syncState, toast);

      await fixture.componentInstance.onSync();

      expect(toast.create).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Sync failed — try again later',
          color: 'danger',
          duration: 3000,
          position: 'bottom',
        }),
      );
      expect(toast.present).toHaveBeenCalled();
    });

    it('cooldown (canSync false): button disabled with aria-label="Synced just now"', async () => {
      const service = mockService([]);
      const syncState = mockSyncState({ canSync: signal(false) });
      const { el } = await setup(service, 'uid-123', syncState);
      const btn = refreshButton(el);

      expect(isDisabled(btn)).toBe(true);
      expect(btn.getAttribute('aria-label')).toBe('Synced just now');
      // Cooldown still shows the refresh icon (at Ionic's disabled opacity).
      expect(
        btn.querySelector('ion-icon[name="refresh-outline"]'),
      ).toBeTruthy();
    });
  });

  describe('notifications bell + unread badge (spec 0042)', () => {
    it('renders the bell button with the notifications-outline icon', async () => {
      const service = mockService([]);
      const { el } = await setup(service);
      const btn = bellButton(el);
      expect(
        btn.querySelector('ion-icon[name="notifications-outline"]'),
      ).toBeTruthy();
    });

    it('hides the badge when the unread count is 0', async () => {
      const service = mockService([], 0);
      const { el } = await setup(service);
      const btn = bellButton(el);
      expect(btn.querySelector('ion-badge')).toBeFalsy();
    });

    it('shows the unread count on the badge when > 0', async () => {
      const service = mockService([], 3);
      const { el } = await setup(service);
      const badge = bellButton(el).querySelector('ion-badge');
      expect(badge).toBeTruthy();
      expect(badge?.textContent?.trim()).toBe('3');
    });

    it('caps the badge display at "9+" above 9', async () => {
      const service = mockService([], 42);
      const { el } = await setup(service);
      const badge = bellButton(el).querySelector('ion-badge');
      expect(badge?.textContent?.trim()).toBe('9+');
    });

    it('shows "9" (not "9+") exactly at 9', async () => {
      const service = mockService([], 9);
      const { el } = await setup(service);
      const badge = bellButton(el).querySelector('ion-badge');
      expect(badge?.textContent?.trim()).toBe('9');
    });

    it('tapping the bell navigates to tabs/notifications', async () => {
      const service = mockService([]);
      const router = mockRouter();
      const { fixture } = await setup(
        service,
        'uid-123',
        mockSyncState(),
        mockToastCtrl(),
        router,
      );

      fixture.componentInstance.openNotifications();

      expect(router.navigate).toHaveBeenCalledWith(['tabs', 'notifications']);
    });

    it('badgeLabel: number ≤ 9 verbatim, > 9 → "9+"', async () => {
      const service = mockService([]);
      const { fixture } = await setup(service);
      const c = fixture.componentInstance;
      expect(c.badgeLabel(0)).toBe('0');
      expect(c.badgeLabel(5)).toBe('5');
      expect(c.badgeLabel(9)).toBe('9');
      expect(c.badgeLabel(10)).toBe('9+');
      expect(c.badgeLabel(99)).toBe('9+');
    });
  });
});
