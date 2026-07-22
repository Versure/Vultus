import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NavController, provideIonicAngular } from '@ionic/angular/standalone';
import { NEVER, type Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow } from './notifications.service';

// Mock the data-access service module so the page test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks the
// jsdom transform). A bare class stands in as the DI token.
vi.mock('./notifications.service', () => ({
  NotificationsService: class NotificationsService {},
}));

// Empty the component-level providers array so the bare mock class above is the
// only `NotificationsService` provider (supplied at the TestBed level below).
vi.mock('./notifications.providers', () => ({
  NOTIFICATIONS_PROVIDERS: [],
}));

import { NotificationsPage } from './notifications.page';
import { NotificationsService } from './notifications.service';

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: over.id ?? 'n1',
    titleId: over.titleId ?? '603',
    kind: over.kind ?? 'episode-aired',
    payload: over.payload ?? {
      tmdbId: 603,
      titleId: '603',
      title: 'The Matrix',
      region: 'NL',
      providerName: 'Netflix',
    },
    sentAt:
      over.sentAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    readAt: over.readAt === undefined ? null : over.readAt,
  };
}

interface MockService {
  notifications$: ReturnType<typeof vi.fn>;
  posterUrl$: ReturnType<typeof vi.fn>;
  markRead: ReturnType<typeof vi.fn>;
  markAllRead: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function mockService(
  rows$: Observable<NotificationRow[]>,
  poster: string | null = null,
): MockService {
  return {
    notifications$: vi.fn(() => rows$),
    posterUrl$: vi.fn(() => of(poster)),
    markRead: vi.fn(() => Promise.resolve()),
    markAllRead: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  };
}

function mockRouter() {
  // `events` + `url` are read by Ionic internals; supply a never-emitting
  // stream so anything that subscribes can do so.
  return {
    navigate: vi.fn(() => Promise.resolve(true)),
    events: NEVER,
    url: '/tabs/notifications',
    createUrlTree: vi.fn(() => ({})),
    serializeUrl: vi.fn(() => '/'),
  };
}

function mockNav() {
  return {
    navigateBack: vi.fn(() => Promise.resolve(true)),
  };
}

async function setup(
  service: MockService,
  router = mockRouter(),
  nav = mockNav(),
) {
  await TestBed.configureTestingModule({
    imports: [NotificationsPage],
    providers: [
      provideIonicAngular(),
      { provide: NotificationsService, useValue: service },
      { provide: Router, useValue: router },
      { provide: NavController, useValue: nav },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(NotificationsPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, router, nav };
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders rows from notifications$ (count + first-row title/body/timestamp)', async () => {
    const service = mockService(
      of([
        row({ id: 'n1' }),
        row({
          id: 'n2',
          payload: {
            tmdbId: 2,
            titleId: '2',
            title: 'The Bear',
            region: 'NL',
            providerName: 'Hulu',
          },
          kind: 'show-came-to-platform',
        }),
      ]),
    );
    const { el } = await setup(service);

    expect(el.querySelectorAll('ion-item-sliding')).toHaveLength(2);
    const first = el.querySelector('.notification-card');
    expect(first?.textContent).toContain('The Matrix');
    expect(first?.textContent).toContain('New episode available on Netflix');
    expect(first?.querySelector('.notification-time')?.textContent).toContain(
      'h ago',
    );
  });

  it('unread row shows the dot + tint; read row is dimmed with no dot', async () => {
    const service = mockService(
      of([
        row({ id: 'unread', readAt: null }),
        row({ id: 'read', readAt: new Date().toISOString() }),
      ]),
    );
    const { el } = await setup(service);

    const cards = el.querySelectorAll('.notification-card');
    const unread = cards[0];
    const read = cards[1];
    expect(unread.classList.contains('notification-card--unread')).toBe(true);
    expect(unread.querySelector('.notification-dot')).toBeTruthy();
    expect(read.classList.contains('notification-card--read')).toBe(true);
    expect(read.querySelector('.notification-dot')).toBeNull();
  });

  it('empty stream → vultus-empty-state', async () => {
    const service = mockService(of([]));
    const { el } = await setup(service);
    expect(el.querySelector('vultus-empty-state')).toBeTruthy();
    expect(el.querySelector('ion-item-sliding')).toBeNull();
  });

  it('pre-emission → vultus-skeleton-card', async () => {
    // NEVER never emits → vm$ stays at the startWith({ rows: null }) branch.
    const service = mockService(NEVER);
    const { el } = await setup(service);
    expect(el.querySelector('vultus-skeleton-card')).toBeTruthy();
    expect(el.querySelector('vultus-empty-state')).toBeNull();
  });

  it('row tap → Router.navigate(title-detail) AND service.markRead(real id)', async () => {
    const service = mockService(of([row({ id: 'real-id-9' })]));
    const { el, router } = await setup(service);

    el.querySelector<HTMLElement>('.notification-card')?.click();

    expect(service.markRead).toHaveBeenCalledWith('real-id-9');
    expect(router.navigate).toHaveBeenCalledWith([
      'tabs',
      'title-detail',
      '603',
    ]);
  });

  it('header back button click → NavController.navigateBack("/tabs/watchlist")', async () => {
    const service = mockService(of([row()]));
    const { el, nav } = await setup(service);

    el.querySelector<HTMLElement>('.back-button')?.click();

    expect(nav.navigateBack).toHaveBeenCalledTimes(1);
    // F3 exact-target discipline: assert the literal string, not a partial.
    expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/watchlist');
  });

  it('goBack() → NavController.navigateBack("/tabs/watchlist")', async () => {
    const service = mockService(of([row()]));
    const { fixture, nav } = await setup(service);

    fixture.componentInstance.goBack();

    expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/watchlist');
  });

  it('"Mark all read" → service.markAllRead(unread ids); hidden when 0 unread', async () => {
    const service = mockService(
      of([
        row({ id: 'u1', readAt: null }),
        row({ id: 'r1', readAt: new Date().toISOString() }),
      ]),
    );
    const { el } = await setup(service);

    const btn = el.querySelector<HTMLElement>('.mark-all-read');
    expect(btn).toBeTruthy();
    btn?.click();
    expect(service.markAllRead).toHaveBeenCalledWith(['u1']);
  });

  it('"Mark all read" hidden when all rows are read', async () => {
    const service = mockService(
      of([row({ id: 'r1', readAt: new Date().toISOString() })]),
    );
    const { el } = await setup(service);
    expect(el.querySelector('.mark-all-read')).toBeNull();
  });

  it('swipe option → service.remove(id)', async () => {
    const service = mockService(of([row({ id: 'del-7' })]));
    const { el } = await setup(service);

    el.querySelector<HTMLElement>('.notification-delete')?.click();
    expect(service.remove).toHaveBeenCalledWith('del-7');
  });

  it('pull-to-refresh → event.target.complete() called', async () => {
    const service = mockService(of([row()]));
    const { fixture } = await setup(service);
    const complete = vi.fn();
    fixture.componentInstance.onRefresh({
      detail: { complete },
    } as unknown as CustomEvent);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
