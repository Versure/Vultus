import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AUTH_UID, type WatchlistItem } from '@vultus/shared/domain';
import { NEVER, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the data-access service module so the page test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks the
// jsdom transform). The page also imports `groupByStatus`/`STATUS_*` from this
// module, so the factory re-provides pure stand-ins (no Firebase) alongside a
// bare service class used purely as the DI token. The factory is hoisted, so it
// must be fully self-contained (no outer references).
vi.mock('./watchlist.service', () => {
  const order = ['watching', 'planned', 'completed', 'dropped'] as const;
  const labels: Record<string, string> = {
    watching: 'Watching',
    planned: 'Planned',
    completed: 'Completed',
    dropped: 'Dropped',
  };
  return {
    WatchlistService: class WatchlistService {},
    STATUS_DISPLAY_ORDER: [...order],
    STATUS_LABELS: labels,
    filterByType: (items: { type: string }[], type?: 'movie' | 'tv') =>
      type ? items.filter((i) => i.type === type) : items,
    groupByStatus: (items: { status: string }[]) =>
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

interface MockService {
  watchlist$: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  removeTitle: ReturnType<typeof vi.fn>;
  userRegion$: ReturnType<typeof vi.fn>;
  availability$: ReturnType<typeof vi.fn>;
}

// The page calls watchlist$(uid, type) and applies groupByStatus itself, but the
// type filter lives in the service (filterByType). Replicate that here so the
// segment-switch test exercises real filtering.
function mockService(items: WatchlistItem[]): MockService {
  return {
    watchlist$: vi.fn((_uid: string | null, type?: 'movie' | 'tv') =>
      of(filterByType(items, type)),
    ),
    updateStatus: vi.fn(),
    removeTitle: vi.fn(),
    userRegion$: vi.fn(() => of(null)),
    availability$: vi.fn(() => of(null)),
  };
}

async function setup(service: MockService, uid: string | null = 'uid-123') {
  await TestBed.configureTestingModule({
    imports: [WatchlistPage],
    providers: [
      provideIonicAngular(),
      { provide: WatchlistService, useValue: service },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: Router, useValue: { navigate: vi.fn() } },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(WatchlistPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el };
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
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Movie A');
    expect(el.textContent).not.toContain('Show B');

    component.onTypeChange(
      new CustomEvent('ionChange', { detail: { value: 'tv' } }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Movie A');
    expect(el.textContent).toContain('Show B');
  });

  it('renders empty state when the stream emits []', async () => {
    const service = mockService([]);
    const { el } = await setup(service);
    expect(el.textContent).toContain('Your watchlist is empty');
    expect(el.textContent).toContain('Search for a title to get started');
    expect(el.querySelector('.watchlist-card')).toBeFalsy();
  });

  it('shows skeleton while loading, not the empty state', async () => {
    // A stream that never emits keeps loading=true past first change detection.
    const service = mockService([]);
    service.watchlist$ = vi.fn(() => NEVER);
    const { el } = await setup(service);
    expect(el.querySelector('ion-skeleton-text')).toBeTruthy();
    expect(el.textContent).not.toContain('Your watchlist is empty');
  });

  it('openStatusSheet opens the action sheet; selecting a status calls updateStatus', async () => {
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
      '1-movie',
      'completed',
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
    expect(service.removeTitle).toHaveBeenCalledWith('uid-123', '9-tv');
  });

  it('renders status section headers in display order with counts', async () => {
    const service = mockService([
      item({ tmdbId: 1, status: 'completed', title: 'C1' }),
      item({ tmdbId: 2, status: 'watching', title: 'W1' }),
      item({ tmdbId: 3, status: 'planned', title: 'P1' }),
    ]);
    const { el } = await setup(service);
    const dividers = Array.from(el.querySelectorAll('ion-item-divider')).map(
      (d) => d.textContent?.trim() ?? '',
    );
    expect(dividers[0]).toContain('Watching');
    expect(dividers[1]).toContain('Planned');
    expect(dividers[2]).toContain('Completed');
    expect(dividers[0]).toContain('1 items');
  });
});
