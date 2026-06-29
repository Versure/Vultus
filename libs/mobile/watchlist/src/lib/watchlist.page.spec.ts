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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncStateService } from './watchlist.sync-state.service';

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
  unreadNotificationCount$: ReturnType<typeof of>;
}

// The page calls watchlist$(uid, type) and applies groupByStatus itself, but the
// type filter lives in the service (filterByType). Replicate that here so the
// segment-switch test exercises real filtering.
function mockService(items: WatchlistItem[], unreadCount = 0): MockService {
  return {
    watchlist$: vi.fn((_uid: string | null, type?: 'movie' | 'tv') =>
      of(filterByType(items, type)),
    ),
    updateStatus: vi.fn(),
    removeTitle: vi.fn(),
    userRegion$: vi.fn(() => of(null)),
    availability$: vi.fn(() => of(null)),
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
    'ion-buttons[slot="end"] ion-button',
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
      '1',
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
