import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import {
  NavController,
  ToastController,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { SyncStateService } from '@vultus/shared/ui-kit';
import { BehaviorSubject, NEVER, type Observable, concat, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchProvider } from '@vultus/shared/domain';
import type { GroupedProviders, TitleDetail } from './tmdb-detail.client';
import {
  type DetailViewState,
  type SeasonGroup,
  TitleDetailService,
} from './title-detail.service';
import { partitionProviders } from './title-detail.page';

// Keep @angular/fire/firestore (rxfire ESM) out of the graph — the service is
// mocked via DI, so a hollow module mock is enough.
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class {},
  doc: vi.fn(),
  collection: vi.fn(),
  docData: vi.fn(),
  collectionData: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));

import { TitleDetailPage } from './title-detail.page';

const movieDetail: TitleDetail = {
  tmdbId: 27205,
  type: 'movie',
  title: 'Inception',
  year: 2010,
  overview: 'A thief who steals corporate secrets via dream-sharing.',
  posterUrl: 'https://image.tmdb.org/t/p/w185/p.jpg',
  posterPath: '/p.jpg',
  voteAverage: 8.8,
};
const tvDetail: TitleDetail = {
  ...movieDetail,
  tmdbId: 1396,
  type: 'tv',
  title: 'Breaking Bad',
  year: 2008,
};
const emptyProviders: GroupedProviders = { flatrate: [], rent: [], buy: [] };

const sampleSeasons: SeasonGroup[] = [
  {
    season: 1,
    total: 3,
    watchedCount: 1,
    allWatched: false,
    episodes: [
      {
        id: 's01e01',
        season: 1,
        episode: 1,
        title: 'Pilot',
        airDate: '2008-01-20T00:00:00.000Z',
        watched: true,
        watchedAt: '2026-06-24T10:00:00.000Z',
      },
      {
        id: 's01e02',
        season: 1,
        episode: 2,
        title: "Cat's in the Bag",
        airDate: '2008-01-27T00:00:00.000Z',
        watched: false,
        watchedAt: null,
      },
      {
        id: 's01e03',
        season: 1,
        episode: 3,
        title: null,
        airDate: '2008-02-10T00:00:00.000Z',
        watched: false,
        watchedAt: null,
      },
    ],
  },
];

interface SvcOpts {
  detail?: DetailViewState | 'loading';
  region?: string | null;
  /** When true, region$ returns NEVER (simulates pending Firestore docData). */
  regionPending?: boolean;
  providers?: GroupedProviders;
  tracked?: unknown;
  /** When true, tracked$ returns NEVER (simulates pending Firestore docData). */
  trackedPending?: boolean;
  /**
   * episodes$ emissions. `undefined` (default) → NEVER (the skeleton/null
   * sentinel state, since the page seeds `startWith(null)`); an array → that
   * value (e.g. [] for the empty state, or season groups).
   */
  episodes?: SeasonGroup[];
  /** The user's selected provider ids (spec 0060); default []. */
  myProviderIds?: number[];
  /** Whether the user uses Plex (spec 0061); default false. */
  hasPlex?: boolean;
}

function makeService(o: SvcOpts = {}) {
  // 'loading' = mirror the real service: emit { kind:'loading' } then stay
  // pending (concat with NEVER so the loaded value never arrives in-test).
  const detail$: Observable<DetailViewState> =
    o.detail === 'loading'
      ? concat(of<DetailViewState>({ kind: 'loading' }), NEVER)
      : of(
          o.detail ?? { kind: 'loaded', source: 'cache', detail: movieDetail },
        );
  const region$: Observable<string | null> = o.regionPending
    ? NEVER
    : of(o.region === undefined ? 'NL' : o.region);
  const tracked$: Observable<unknown> = o.trackedPending
    ? NEVER
    : of(o.tracked ?? null);
  // episodes$ on the SERVICE returns the seed (NEVER → page's startWith(null)
  // keeps the skeleton; array → loaded). The page wraps this with startWith.
  const episodes$: Observable<SeasonGroup[]> =
    o.episodes === undefined ? NEVER : of(o.episodes);
  return {
    detail$: vi.fn(() => detail$),
    region$: vi.fn(() => region$),
    myProviderIds$: vi.fn(() => of<number[]>(o.myProviderIds ?? [])),
    hasPlex$: vi.fn(() => of<boolean>(o.hasPlex ?? false)),
    providers$: vi.fn(() => of(o.providers ?? emptyProviders)),
    tracked$: vi.fn(() => tracked$),
    episodes$: vi.fn(() => episodes$),
    add: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    removeTitle: vi.fn().mockResolvedValue(undefined),
    setEpisodeWatched: vi.fn().mockResolvedValue(undefined),
    setSeasonWatched: vi.fn().mockResolvedValue(undefined),
    setMovieWatched: vi.fn().mockResolvedValue(undefined),
    toggleWatchingViaPlex: vi.fn().mockResolvedValue(undefined),
    revertIfNewEpisodes: vi.fn().mockResolvedValue(undefined),
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

/** A NavController stub with a spied `navigateBack` (spec 0092 header back). */
function mockNavController() {
  return { navigateBack: vi.fn(() => Promise.resolve(true)) };
}

/** A pull-to-refresh `ionRefresh` CustomEvent with a spied `detail.complete`. */
function fakeRefreshEvent() {
  const complete = vi.fn();
  return {
    event: { detail: { complete } } as unknown as CustomEvent,
    complete,
  };
}

/**
 * Mutable paramMap — allows simulating Ionic page reuse by pushing a new value
 * on the same component instance. Starts with titleId='27205' (Inception).
 */
let paramMap$: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

/**
 * Mutable queryParamMap — source for the page's `typeHint$` (spec 0043). Seeded
 * by `setup`'s `initialType` (`?type=tv|movie`); defaults to `{}` (no hint).
 */
let queryParamMap$: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

async function setup(
  o: SvcOpts = {},
  initialTitleId = '27205',
  initialType?: string,
  syncState: MockSyncState = mockSyncState(),
  toast = mockToastCtrl(),
  initialOrigin?: string,
  nav = mockNavController(),
) {
  paramMap$ = new BehaviorSubject(
    convertToParamMap({ titleId: initialTitleId }),
  );
  const queryParams: Record<string, string> = {};
  if (initialType) queryParams['type'] = initialType;
  if (initialOrigin) queryParams['origin'] = initialOrigin;
  queryParamMap$ = new BehaviorSubject(convertToParamMap(queryParams));
  const svc = makeService(o);
  await TestBed.configureTestingModule({
    imports: [TitleDetailPage],
    providers: [
      provideIonicAngular(),
      { provide: TitleDetailService, useValue: svc },
      { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
      { provide: SyncStateService, useValue: syncState },
      { provide: ToastController, useValue: toast },
      { provide: NavController, useValue: nav },
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: paramMap$.asObservable(),
          queryParamMap: queryParamMap$.asObservable(),
          snapshot: {
            paramMap: convertToParamMap({ titleId: initialTitleId }),
          },
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(TitleDetailPage);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, svc, syncState, toast, nav };
}

describe('TitleDetailPage', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads :titleId from the route reactively', async () => {
    const { fixture } = await setup();
    let resolvedId: number | undefined;
    fixture.componentInstance.tmdbId$.subscribe((id) => (resolvedId = id));
    expect(resolvedId).toBe(27205);
  });

  describe('typeHint$ from queryParamMap (spec 0043)', () => {
    it('passes typeHint=tv to service.detail$ when ?type=tv', async () => {
      const { svc } = await setup({}, '27205', 'tv');
      expect(svc.detail$).toHaveBeenCalledWith(27205, 'tv');
    });

    it('passes typeHint=movie to service.detail$ when ?type=movie', async () => {
      const { svc } = await setup({}, '27205', 'movie');
      expect(svc.detail$).toHaveBeenCalledWith(27205, 'movie');
    });

    it('passes undefined to service.detail$ when ?type absent', async () => {
      const { svc } = await setup({});
      expect(svc.detail$).toHaveBeenCalledWith(27205, undefined);
    });

    it('passes undefined to service.detail$ when ?type is invalid (anime)', async () => {
      const { svc } = await setup({}, '27205', 'anime');
      expect(svc.detail$).toHaveBeenCalledWith(27205, undefined);
    });
  });

  // --- spec 0092: header back button resolves the origin tab (issue #253) ---
  describe('goBack() origin resolution (spec 0092)', () => {
    it('origin=watchlist → navigateBack("/tabs/watchlist")', async () => {
      const { fixture, nav } = await setup(
        {},
        '27205',
        undefined,
        mockSyncState(),
        mockToastCtrl(),
        'watchlist',
      );
      fixture.componentInstance.goBack();
      expect(nav.navigateBack).toHaveBeenCalledTimes(1);
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/watchlist');
    });

    it('origin=today → navigateBack("/tabs/today")', async () => {
      const { fixture, nav } = await setup(
        {},
        '27205',
        undefined,
        mockSyncState(),
        mockToastCtrl(),
        'today',
      );
      fixture.componentInstance.goBack();
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/today');
    });

    it('origin=search → navigateBack("/tabs/search")', async () => {
      const { fixture, nav } = await setup(
        {},
        '27205',
        undefined,
        mockSyncState(),
        mockToastCtrl(),
        'search',
      );
      fixture.componentInstance.goBack();
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/search');
    });

    it('origin absent → falls back to navigateBack("/tabs/watchlist")', async () => {
      const { fixture, nav } = await setup();
      fixture.componentInstance.goBack();
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/watchlist');
    });

    it('origin unrecognized (bogus) → falls back to navigateBack("/tabs/watchlist")', async () => {
      const { fixture, nav } = await setup(
        {},
        '27205',
        undefined,
        mockSyncState(),
        mockToastCtrl(),
        'bogus',
      );
      fixture.componentInstance.goBack();
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/watchlist');
    });

    it('the header back button click invokes goBack → navigateBack(origin target)', async () => {
      const { fixture, nav } = await setup(
        {},
        '27205',
        undefined,
        mockSyncState(),
        mockToastCtrl(),
        'today',
      );
      const el = fixture.nativeElement as HTMLElement;
      const backBtn = el.querySelector<HTMLElement>('.back-button');
      expect(backBtn).toBeTruthy();
      backBtn?.click();
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/today');
    });

    // Stale-snapshot guard (spec 0037): a later origin emission on the same
    // instance (Ionic page reuse) must resolve the CURRENT origin, not the first.
    it('re-emitting origin on the same instance uses the new origin', async () => {
      const { fixture, nav } = await setup(
        {},
        '27205',
        undefined,
        mockSyncState(),
        mockToastCtrl(),
        'watchlist',
      );
      queryParamMap$.next(convertToParamMap({ origin: 'search' }));
      await fixture.whenStable();
      fixture.detectChanges();
      fixture.componentInstance.goBack();
      expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/search');
      expect(nav.navigateBack).not.toHaveBeenCalledWith('/tabs/watchlist');
    });
  });

  it('shows the loading skeleton hero before the first emission (no not-found copy)', async () => {
    const { fixture } = await setup({ detail: 'loading' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="loading"]')).toBeTruthy();
    // The shared <vultus-skeleton-hero> atom renders the loading placeholder
    // (and still mounts ion-skeleton-text internally).
    expect(el.querySelector('vultus-skeleton-hero')).toBeTruthy();
    expect(el.querySelector('ion-skeleton-text')).toBeTruthy();
    expect(el.textContent).not.toContain('Title not found');
  });

  it('renders a loaded movie: title, year, type badge, overview', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Inception');
    expect(el.textContent).toContain('2010');
    expect(el.textContent).toContain('Movie');
    expect(el.textContent).toContain('A thief who steals');
    expect(el.querySelector('.hero-image')).toBeTruthy();
  });

  it('renders a loaded tv title with the TV Series badge', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'live', detail: tvDetail },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Breaking Bad');
    expect(el.textContent).toContain('TV Series');
  });

  it('shows the poster placeholder when posterUrl is null', async () => {
    const { fixture } = await setup({
      detail: {
        kind: 'loaded',
        source: 'cache',
        detail: { ...movieDetail, posterUrl: null },
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.hero-image')).toBeFalsy();
    expect(el.querySelector('[data-test="poster-placeholder"]')).toBeTruthy();
  });

  it('cache and live render an identical DOM for the same TitleDetail', async () => {
    const { fixture: cacheFx } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
    });
    TestBed.resetTestingModule();
    const { fixture: liveFx } = await setup({
      detail: { kind: 'loaded', source: 'live', detail: movieDetail },
    });
    const norm = (e: HTMLElement) =>
      (e.querySelector('.content-canvas')?.innerHTML ?? '').trim();
    expect(norm(cacheFx.nativeElement as HTMLElement)).toBe(
      norm(liveFx.nativeElement as HTMLElement),
    );
  });

  it('shows the not-found empty-state and no action area', async () => {
    const { fixture } = await setup({ detail: { kind: 'not-found' } });
    const el = fixture.nativeElement as HTMLElement;
    const empty = el.querySelector('[data-test="not-found"]');
    expect(empty).toBeTruthy();
    expect(empty?.tagName.toLowerCase()).toBe('vultus-empty-state');
    expect(el.textContent).toContain('Title not found');
    expect(el.querySelector('[data-test="action-area"]')).toBeFalsy();
  });

  it('shows the error-state on the recoverable error kind, and onRetry re-subscribes detail$', async () => {
    const { fixture, svc } = await setup({ detail: { kind: 'error' } });
    const el = fixture.nativeElement as HTMLElement;
    const errorEl = el.querySelector('[data-test="error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl?.tagName.toLowerCase()).toBe('vultus-error-state');
    expect(el.querySelector('[data-test="action-area"]')).toBeFalsy();

    // detail$ subscribed once for the initial render.
    const callsBefore = svc.detail$.mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(1);

    // Tapping "Try again" re-runs detail$(tmdbId) via the combined trigger.
    fixture.componentInstance.onRetry();
    fixture.detectChanges();
    expect(svc.detail$.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(svc.detail$).toHaveBeenLastCalledWith(27205, undefined);
  });

  // --- spec 0060: Where-to-Watch two-group split ---

  describe('Where to Watch two-group split (spec 0060)', () => {
    it('flatrate-mine present → "On Your Providers" lists it with a "Yours" tag + "Subscription" caption', async () => {
      const { fixture } = await setup({
        providers: {
          flatrate: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
          rent: [],
          buy: [],
        },
        myProviderIds: [8],
      });
      const el = fixture.nativeElement as HTMLElement;
      const mine = el.querySelector('[data-test="group-mine"]');
      expect(mine).toBeTruthy();
      expect(mine?.textContent).toContain('On Your Providers');
      expect(mine?.textContent).toContain('Netflix');
      expect(mine?.querySelector('[data-test="yours-tag"]')?.textContent).toBe(
        'Yours',
      );
      expect(mine?.textContent).toContain('Subscription');
      // Only the mine group renders (no elsewhere group, no divider).
      expect(el.querySelector('[data-test="group-elsewhere"]')).toBeFalsy();
      expect(el.querySelector('[data-test="group-divider"]')).toBeFalsy();
    });

    it('non-mine flatrate + rent + buy → all under "Also Available On" with correct type captions', async () => {
      const { fixture } = await setup({
        providers: {
          flatrate: [{ providerId: 9, name: 'Prime Video', type: 'flatrate' }],
          rent: [{ providerId: 10, name: 'Google Play', type: 'rent' }],
          buy: [{ providerId: 2, name: 'Apple TV', type: 'buy' }],
        },
        myProviderIds: [], // none selected
      });
      const el = fixture.nativeElement as HTMLElement;
      const elsewhere = el.querySelector('[data-test="group-elsewhere"]');
      expect(el.querySelector('[data-test="group-mine"]')).toBeFalsy();
      expect(elsewhere).toBeTruthy();
      expect(elsewhere?.textContent).toContain('Also Available On');
      expect(elsewhere?.textContent).toContain('Prime Video');
      expect(elsewhere?.textContent).toContain('Google Play');
      expect(elsewhere?.textContent).toContain('Apple TV');
      // Flatrate → "Subscription"; rent/buy → "Rent/Buy".
      expect(elsewhere?.textContent).toContain('Subscription');
      expect(elsewhere?.textContent).toContain('Rent/Buy');
      // No "Yours" tag anywhere in the elsewhere group.
      expect(elsewhere?.querySelector('[data-test="yours-tag"]')).toBeFalsy();
    });

    it('a rent/buy provider whose id is in myProviderIds still lands under "Also Available On" (never mine)', async () => {
      const { fixture } = await setup({
        providers: {
          flatrate: [],
          rent: [{ providerId: 8, name: 'Netflix Store', type: 'rent' }],
          buy: [{ providerId: 8, name: 'Netflix Store', type: 'buy' }],
        },
        // id 8 is "selected" but only appears as rent/buy here.
        myProviderIds: [8],
      });
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-test="group-mine"]')).toBeFalsy();
      const elsewhere = el.querySelector('[data-test="group-elsewhere"]');
      expect(elsewhere).toBeTruthy();
      expect(elsewhere?.textContent).toContain('Netflix Store');
      expect(el.querySelector('[data-test="yours-tag"]')).toBeFalsy();
    });

    it('mixed mine + elsewhere → both groups render, mine first, divider between', async () => {
      const { fixture } = await setup({
        providers: {
          flatrate: [
            { providerId: 8, name: 'Netflix', type: 'flatrate' },
            { providerId: 9, name: 'Prime Video', type: 'flatrate' },
          ],
          rent: [],
          buy: [],
        },
        myProviderIds: [8],
      });
      const el = fixture.nativeElement as HTMLElement;
      const mine = el.querySelector('[data-test="group-mine"]');
      const elsewhere = el.querySelector('[data-test="group-elsewhere"]');
      expect(mine).toBeTruthy();
      expect(elsewhere).toBeTruthy();
      const divider = el.querySelector('[data-test="group-divider"]');
      expect(divider).toBeTruthy();
      // Issue #252: the subgroup divider must be a DIRECT child of
      // `.provider-groups` — this is the precondition the scoped
      // `.provider-groups > .group-divider { margin-top: 0 }` fix relies on. If
      // a refactor moved it out, the fix would silently stop applying.
      expect(
        el.querySelector('.provider-groups > [data-test="group-divider"]'),
      ).toBeTruthy();
      expect(
        divider?.parentElement?.classList.contains('provider-groups'),
      ).toBe(true);
      // Mine group appears before elsewhere in DOM order.
      if (mine && elsewhere) {
        expect(
          mine.compareDocumentPosition(elsewhere) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      expect(mine?.textContent).toContain('Netflix');
      expect(elsewhere?.textContent).toContain('Prime Video');
    });

    it('the decorative trailing glyph triggers NO navigation (no href, no click handler, presentational)', async () => {
      const { fixture } = await setup({
        providers: {
          flatrate: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
          rent: [],
          buy: [],
        },
        myProviderIds: [8],
      });
      const el = fixture.nativeElement as HTMLElement;
      // No provider row is an anchor or button, and no trailing glyph is a link.
      const rows = el.querySelectorAll('[data-test="provider-row-mine"]');
      expect(rows.length).toBe(1);
      const trailing = el.querySelector('.provider-trailing');
      expect(trailing).toBeTruthy();
      expect(trailing?.closest('a')).toBeNull();
      expect(trailing?.closest('button')).toBeNull();
      expect(trailing?.hasAttribute('href')).toBe(false);
      expect(trailing?.getAttribute('routerlink')).toBeNull();
      // The row itself carries no interactive semantics.
      const row = rows[0];
      expect(row.tagName.toLowerCase()).toBe('div');
      expect(row.getAttribute('role')).toBeNull();
      expect(row.hasAttribute('href')).toBe(false);
    });
  });

  it('shows the empty-providers copy when all groups are empty', async () => {
    const { fixture } = await setup({ providers: emptyProviders });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="empty-providers"]')).toBeTruthy();
  });

  it('shows the null-region prompt when region is null', async () => {
    const { fixture } = await setup({ region: null });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="null-region"]')).toBeTruthy();
    expect(el.textContent).toContain('Set your region in Settings');
    // The rest of the page still renders.
    expect(el.textContent).toContain('Inception');
  });

  it('untracked → renders Add and calls add(detail) on tap', async () => {
    const { fixture, svc } = await setup({ tracked: null });
    const el = fixture.nativeElement as HTMLElement;
    const addBtn = el.querySelector<HTMLElement>('[data-test="add-btn"]');
    expect(addBtn).toBeTruthy();
    addBtn?.click();
    expect(svc.add).toHaveBeenCalledWith(movieDetail);
  });

  // --- spec 0056: untracked "Mark as Watched" one-step add ---

  it('untracked → renders BOTH the Add and the Mark-as-Watched buttons', async () => {
    const { fixture } = await setup({ tracked: null });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="add-btn"]')).toBeTruthy();
    expect(el.querySelector('[data-test="mark-watched-btn"]')).toBeTruthy();
    expect(el.textContent).toContain('Mark as Watched');
  });

  it('untracked → tapping "Mark as Watched" calls markAsWatched → service.add(detail, "completed")', async () => {
    const { fixture, svc } = await setup({ tracked: null });
    const el = fixture.nativeElement as HTMLElement;
    const markBtn = el.querySelector<HTMLElement>(
      '[data-test="mark-watched-btn"]',
    );
    expect(markBtn).toBeTruthy();
    markBtn?.click();
    expect(svc.add).toHaveBeenCalledWith(movieDetail, 'completed');
  });

  it('untracked → tapping "Add to Watchlist" calls add with the default (no "completed" arg)', async () => {
    const { fixture, svc } = await setup({ tracked: null });
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLElement>('[data-test="add-btn"]')?.click();
    // Default add — called with only the detail (status defaults to 'planned').
    expect(svc.add).toHaveBeenCalledWith(movieDetail);
    expect(svc.add).not.toHaveBeenCalledWith(movieDetail, 'completed');
  });

  it('tracked → renders NEITHER the Add nor the Mark-as-Watched button', async () => {
    const { fixture } = await setup({
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        title: 'Inception',
        addedAt: '2026-01-01T00:00:00Z',
        status: 'planned',
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="add-btn"]')).toBeFalsy();
    expect(el.querySelector('[data-test="mark-watched-btn"]')).toBeFalsy();
    // The existing tracked controls render instead (branch untouched).
    expect(el.querySelector('[data-test="status-control"]')).toBeTruthy();
    expect(el.querySelector('[data-test="remove-btn"]')).toBeTruthy();
  });

  it('tracked → renders the status control + remove; openStatusSheet opens the action sheet; selecting calls updateStatus', async () => {
    const { fixture, svc } = await setup({
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        title: 'Inception',
        addedAt: '2026-01-01T00:00:00Z',
        status: 'planned',
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="status-control"]')).toBeTruthy();
    expect(el.querySelector('[data-test="remove-btn"]')).toBeTruthy();
    expect(el.querySelector('[data-test="add-btn"]')).toBeFalsy();

    const cmp = fixture.componentInstance;
    cmp.openStatusSheet();
    expect(cmp.actionSheetOpen).toBe(true);

    // Selecting a status row invokes updateStatus (spec 0053: with the resolved
    // type — this tracked item is a movie).
    const watchingBtn = cmp.actionSheetButtons.find(
      (b) => b.text === 'Watching',
    );
    void watchingBtn?.handler?.();
    expect(svc.updateStatus).toHaveBeenCalledWith(27205, 'watching', 'movie');
  });

  it('tracked → remove opens the alert and confirming calls removeTitle', async () => {
    const { fixture, svc } = await setup({
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        title: 'Inception',
        addedAt: '2026-01-01T00:00:00Z',
        status: 'watching',
      },
    });
    const cmp = fixture.componentInstance;
    cmp.openRemoveAlert();
    expect(cmp.alertOpen).toBe(true);

    const removeBtn = cmp.alertButtons.find((b) => b.text === 'Remove');
    void (removeBtn?.handler as (() => void) | undefined)?.();
    expect(svc.removeTitle).toHaveBeenCalledWith(27205);
  });

  // Regression: skeleton must render immediately even when region$ is a
  // never-emitting Firestore stream (pending docData, no synchronous emission).
  it('shows loading skeleton while region$ is pending (primary regression)', async () => {
    const { fixture } = await setup({ detail: 'loading', regionPending: true });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="loading"]')).toBeTruthy();
    expect(el.querySelector('vultus-skeleton-hero')).toBeTruthy();
  });

  // Regression: loaded content must render immediately even when tracked$ is a
  // never-emitting Firestore stream (pending watchlist docData).
  it('shows loaded content while tracked$ is pending (secondary regression)', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
      trackedPending: true,
    });
    const el = fixture.nativeElement as HTMLElement;
    // The loaded state (hero title) must be visible.
    expect(el.textContent).toContain('Inception');
    // tracked is seeded as null by startWith, so the Add-to-Watchlist CTA shows.
    expect(el.querySelector('[data-test="add-btn"]')).toBeTruthy();
  });

  // Regression (spec 0037): Ionic page reuse — a second paramMap emission on the
  // same component instance must resolve the NEW title, not the first one.
  it('stale-param reuse: re-emitting paramMap loads the new title (0037 primary)', async () => {
    // Start with Breaking Bad (tmdbId 1396).
    const svc = {
      detail$: vi.fn((id: number) => {
        const detail: TitleDetail =
          id === 1396 ? tvDetail : { ...movieDetail, tmdbId: id };
        return of<DetailViewState>({ kind: 'loaded', source: 'cache', detail });
      }),
      region$: vi.fn(() => of('NL')),
      myProviderIds$: vi.fn(() => of<number[]>([])),
      hasPlex$: vi.fn(() => of<boolean>(false)),
      providers$: vi.fn(() => of(emptyProviders)),
      tracked$: vi.fn(() => of(null)),
      episodes$: vi.fn(() => NEVER),
      add: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      removeTitle: vi.fn().mockResolvedValue(undefined),
      toggleWatchingViaPlex: vi.fn().mockResolvedValue(undefined),
      revertIfNewEpisodes: vi.fn().mockResolvedValue(undefined),
    };

    paramMap$ = new BehaviorSubject(convertToParamMap({ titleId: '1396' }));
    await TestBed.configureTestingModule({
      imports: [TitleDetailPage],
      providers: [
        provideIonicAngular(),
        { provide: TitleDetailService, useValue: svc },
        { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
        { provide: SyncStateService, useValue: mockSyncState() },
        { provide: ToastController, useValue: mockToastCtrl() },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: paramMap$.asObservable(),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({ titleId: '1396' }) },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(TitleDetailPage);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Breaking Bad');
    expect(svc.detail$).toHaveBeenLastCalledWith(1396, undefined);

    // Simulate Ionic page reuse: same instance, new param.
    paramMap$.next(convertToParamMap({ titleId: '27205' }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.textContent).toContain('Inception');
    expect(svc.detail$).toHaveBeenLastCalledWith(27205, undefined);
  });

  // Regression (spec 0037): an invalid/absent :titleId must short-circuit to
  // not-found without calling the service.
  it('invalid-id guard: absent titleId → not-found, service not called (0037)', async () => {
    paramMap$ = new BehaviorSubject(convertToParamMap({})); // no titleId → Number(null) === 0
    const svc = makeService();
    await TestBed.configureTestingModule({
      imports: [TitleDetailPage],
      providers: [
        provideIonicAngular(),
        { provide: TitleDetailService, useValue: svc },
        { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
        { provide: SyncStateService, useValue: mockSyncState() },
        { provide: ToastController, useValue: mockToastCtrl() },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: paramMap$.asObservable(),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({}) },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(TitleDetailPage);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="not-found"]')).toBeTruthy();
    expect(svc.detail$).not.toHaveBeenCalled();
  });

  // Regression (spec 0037): NaN id (non-numeric string) also triggers not-found.
  it('invalid-id guard: non-numeric titleId → not-found, service not called (0037)', async () => {
    paramMap$ = new BehaviorSubject(convertToParamMap({ titleId: 'abc' }));
    const svc = makeService();
    await TestBed.configureTestingModule({
      imports: [TitleDetailPage],
      providers: [
        provideIonicAngular(),
        { provide: TitleDetailService, useValue: svc },
        { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
        { provide: SyncStateService, useValue: mockSyncState() },
        { provide: ToastController, useValue: mockToastCtrl() },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: paramMap$.asObservable(),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({ titleId: 'abc' }) },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(TitleDetailPage);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="not-found"]')).toBeTruthy();
    expect(svc.detail$).not.toHaveBeenCalled();
  });

  // Regression (spec 0037): handlers must act on the CURRENT title id after reuse.
  it('handlers act on the current title after param reuse (0037)', async () => {
    const svc = {
      detail$: vi.fn((id: number) => {
        const detail: TitleDetail =
          id === 1396 ? tvDetail : { ...movieDetail, tmdbId: id };
        return of<DetailViewState>({ kind: 'loaded', source: 'cache', detail });
      }),
      region$: vi.fn(() => of('NL')),
      myProviderIds$: vi.fn(() => of<number[]>([])),
      hasPlex$: vi.fn(() => of<boolean>(false)),
      providers$: vi.fn(() => of(emptyProviders)),
      tracked$: vi.fn(() =>
        of({
          type: 'tv',
          tmdbId: 27205,
          title: 'Inception',
          addedAt: '2026-01-01T00:00:00Z',
          status: 'planned',
        }),
      ),
      episodes$: vi.fn(() => NEVER),
      add: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      removeTitle: vi.fn().mockResolvedValue(undefined),
      toggleWatchingViaPlex: vi.fn().mockResolvedValue(undefined),
      revertIfNewEpisodes: vi.fn().mockResolvedValue(undefined),
    };

    // Start on title A (1396), then reuse to title B (27205).
    paramMap$ = new BehaviorSubject(convertToParamMap({ titleId: '1396' }));
    await TestBed.configureTestingModule({
      imports: [TitleDetailPage],
      providers: [
        provideIonicAngular(),
        { provide: TitleDetailService, useValue: svc },
        { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
        { provide: SyncStateService, useValue: mockSyncState() },
        { provide: ToastController, useValue: mockToastCtrl() },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: paramMap$.asObservable(),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({ titleId: '1396' }) },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(TitleDetailPage);
    await fixture.whenStable();
    fixture.detectChanges();

    // Reuse to title B (27205).
    paramMap$.next(convertToParamMap({ titleId: '27205' }));
    await fixture.whenStable();
    fixture.detectChanges();

    const cmp = fixture.componentInstance;

    // Status handler must use B's id (27205), not A's (1396).
    const watchingBtn = cmp.actionSheetButtons.find(
      (b) => b.text === 'Watching',
    );
    void watchingBtn?.handler?.();
    // Title B (27205) resolves as a movie in this mock → type threaded is 'movie'.
    expect(svc.updateStatus).toHaveBeenCalledWith(27205, 'watching', 'movie');

    // Remove handler must also use B's id.
    const removeBtn = cmp.alertButtons.find((b) => b.text === 'Remove');
    void (removeBtn?.handler as (() => void) | undefined)?.();
    expect(svc.removeTitle).toHaveBeenCalledWith(27205);
  });

  // --- spec 0034: Episodes section + movie mark-as-watched ---

  it('movie loaded → Episodes section NOT rendered; movie-watched toggle IS in the action area', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        title: 'Inception',
        addedAt: '2026-01-01T00:00:00Z',
        status: 'watching',
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="episodes-section"]')).toBeFalsy();
    expect(el.querySelector('[data-test="movie-watched-btn"]')).toBeTruthy();
    expect(el.textContent).toContain('Mark as watched');
  });

  it('tv loaded with season groups → Episodes section + season heading + episode rows', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      episodes: sampleSeasons,
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="episodes-section"]')).toBeTruthy();
    expect(el.querySelector('[data-test="season-group"]')).toBeTruthy();
    expect(el.textContent).toContain('Season 1');
    expect(
      el.querySelector('[data-test="season-count"]')?.textContent,
    ).toContain('1/3 watched');
    expect(el.querySelectorAll('[data-test="episode-row"]').length).toBe(3);
    expect(el.textContent).toContain('Pilot');
    // Null-title episode falls back to "Episode N".
    expect(el.textContent).toContain('Episode 3');
    // Movie toggle must NOT appear for a TV title.
    expect(el.querySelector('[data-test="movie-watched-btn"]')).toBeFalsy();
  });

  it('tv loaded + episodes$ not yet emitted → skeleton, no empty copy', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      // episodes undefined → NEVER → page stays on startWith(null) → skeleton.
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="episodes-skeleton"]')).toBeTruthy();
    expect(el.querySelector('[data-test="episodes-empty"]')).toBeFalsy();
  });

  it('tv loaded + episodes$ emits [] → empty message', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      episodes: [],
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="episodes-empty"]')).toBeTruthy();
    expect(el.textContent).toContain(
      'Episodes will appear after the next sync.',
    );
    expect(el.querySelector('[data-test="episodes-skeleton"]')).toBeFalsy();
  });

  it('episode toggle click → setEpisodeWatched(tmdbId, id, !watched)', async () => {
    const { fixture, svc } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      episodes: sampleSeasons,
    });
    const el = fixture.nativeElement as HTMLElement;
    const toggle = el.querySelector<HTMLElement>(
      '[data-test="episode-watched-toggle"]',
    );
    toggle?.click();
    // First episode (s01e01) is watched → click marks it unwatched.
    // tmdbId comes from the route param (27205), not the detail's tmdbId.
    expect(svc.setEpisodeWatched).toHaveBeenCalledWith(27205, 's01e01', false);
  });

  it('season bulk toggle click → setSeasonWatched; does NOT collapse the season', async () => {
    const { fixture, svc } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      episodes: sampleSeasons,
    });
    const cmp = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const bulk = el.querySelector<HTMLElement>('[data-test="bulk-toggle"]');
    bulk?.click();
    expect(svc.setSeasonWatched).toHaveBeenCalledWith(27205, 1, true);
    // stopPropagation must keep the season expanded.
    expect(cmp.isSeasonCollapsed(1)).toBe(false);
  });

  it('season heading click → toggles collapsed (episode rows hide)', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      episodes: sampleSeasons,
    });
    const cmp = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-test="episode-row"]').length).toBe(3);
    el.querySelector<HTMLElement>('.season-heading')?.click();
    fixture.detectChanges();
    expect(cmp.isSeasonCollapsed(1)).toBe(true);
    expect(el.querySelectorAll('[data-test="episode-row"]').length).toBe(0);
  });

  it('movie toggle click → setMovieWatched(tmdbId, status !== completed)', async () => {
    const { fixture, svc } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        title: 'Inception',
        addedAt: '2026-01-01T00:00:00Z',
        status: 'watching',
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLElement>('[data-test="movie-watched-btn"]')?.click();
    expect(svc.setMovieWatched).toHaveBeenCalledWith(27205, true);
  });

  it('movie toggle disabled when status is dropped', async () => {
    const { fixture } = await setup({
      detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        title: 'Inception',
        addedAt: '2026-01-01T00:00:00Z',
        status: 'dropped',
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    const btn = el.querySelector<HTMLButtonElement>(
      '[data-test="movie-watched-btn"]',
    );
    expect(btn?.disabled).toBe(true);
  });

  // --- spec 0061: "Personal Tracking" Plex subsection ---

  describe('Personal Tracking / Plex subsection (spec 0061)', () => {
    const trackedItem = (watchingViaPlex: boolean) => ({
      type: 'movie' as const,
      tmdbId: 27205,
      title: 'Inception',
      addedAt: '2026-01-01T00:00:00Z',
      status: 'planned' as const,
      watchingViaPlex,
    });

    it('hasPlex false → the Personal Tracking subsection is absent entirely', async () => {
      const { fixture } = await setup({
        hasPlex: false,
        tracked: trackedItem(false),
      });
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-test="personal-tracking"]')).toBeFalsy();
      expect(el.querySelector('[data-test="plex-empty-row"]')).toBeFalsy();
      expect(el.querySelector('[data-test="plex-active-row"]')).toBeFalsy();
    });

    it('hasPlex true + untracked → subsection absent (no watchlist doc to write to)', async () => {
      const { fixture } = await setup({ hasPlex: true, tracked: null });
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-test="personal-tracking"]')).toBeFalsy();
    });

    it('hasPlex true + watchingViaPlex false → empty affordance renders; tap → toggleWatchingViaPlex(id, true)', async () => {
      const { fixture, svc } = await setup({
        hasPlex: true,
        tracked: trackedItem(false),
      });
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-test="personal-tracking"]')).toBeTruthy();
      const empty = el.querySelector<HTMLElement>(
        '[data-test="plex-empty-row"]',
      );
      expect(empty).toBeTruthy();
      expect(el.textContent).toContain('Mark as watching via Plex');
      // The active row must NOT render.
      expect(el.querySelector('[data-test="plex-active-row"]')).toBeFalsy();

      empty?.click();
      expect(svc.toggleWatchingViaPlex).toHaveBeenCalledWith(27205, true);
    });

    it('hasPlex true + watchingViaPlex true → active row + Change button; tap Change → toggleWatchingViaPlex(id, false)', async () => {
      const { fixture, svc } = await setup({
        hasPlex: true,
        tracked: trackedItem(true),
      });
      const el = fixture.nativeElement as HTMLElement;
      const active = el.querySelector<HTMLElement>(
        '[data-test="plex-active-row"]',
      );
      expect(active).toBeTruthy();
      expect(el.textContent).toContain('Watching via Plex');
      expect(el.textContent).toContain('Local Server');
      // The empty affordance must NOT render.
      expect(el.querySelector('[data-test="plex-empty-row"]')).toBeFalsy();

      const change = el.querySelector<HTMLElement>('[data-test="plex-change"]');
      expect(change).toBeTruthy();
      expect(change?.textContent).toContain('Change');
      change?.click();
      expect(svc.toggleWatchingViaPlex).toHaveBeenCalledWith(27205, false);
    });

    it('renders the bundled Plex wordmark asset in the active tile (not a brand-hex tile)', async () => {
      const { fixture } = await setup({
        hasPlex: true,
        tracked: trackedItem(true),
      });
      const el = fixture.nativeElement as HTMLElement;
      const img = el.querySelector<HTMLImageElement>(
        '[data-test="plex-active-row"] img',
      );
      expect(img).toBeTruthy();
      expect(img?.getAttribute('src')).toBe('/assets/plex-logo.svg');
    });

    // Additivity (decision 4 / DoD): the 0060 provider groups render UNCHANGED
    // regardless of watchingViaPlex — the Plex subsection is additive, never a
    // replacement for the TMDB availability framing.
    it.each([true, false])(
      'additivity: the 0060 provider split renders unchanged when watchingViaPlex is %s',
      async (watchingViaPlex) => {
        const providers: GroupedProviders = {
          flatrate: [
            { providerId: 8, name: 'Netflix', type: 'flatrate' },
            { providerId: 9, name: 'Prime Video', type: 'flatrate' },
          ],
          rent: [],
          buy: [],
        };
        const { fixture } = await setup({
          hasPlex: true,
          myProviderIds: [8],
          providers,
          tracked: trackedItem(watchingViaPlex),
        });
        const el = fixture.nativeElement as HTMLElement;
        // Both 0060 groups still render, mine first, with the divider between.
        const mine = el.querySelector('[data-test="group-mine"]');
        const elsewhere = el.querySelector('[data-test="group-elsewhere"]');
        expect(mine).toBeTruthy();
        expect(elsewhere).toBeTruthy();
        expect(el.querySelector('[data-test="group-divider"]')).toBeTruthy();
        expect(mine?.textContent).toContain('Netflix');
        expect(mine?.querySelector('[data-test="yours-tag"]')).toBeTruthy();
        expect(elsewhere?.textContent).toContain('Prime Video');
        // …and the Plex subsection sits AFTER the provider groups in DOM order.
        const plex = el.querySelector('[data-test="personal-tracking"]');
        expect(plex).toBeTruthy();
        if (elsewhere && plex) {
          expect(
            elsewhere.compareDocumentPosition(plex) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }
      },
    );

    // Issue #252 regression guard: when BOTH the two-subgroup split and the
    // Plex "Personal Tracking" section render, the plex-divider reuses the same
    // `.group-divider` class but is a block-flow child of the `.glass-panel`
    // "Where to Watch" card — NOT a child of `.provider-groups`. This proves the
    // scoped `.provider-groups > .group-divider { margin-top: 0 }` fix does NOT
    // touch the plex-divider (which keeps the base margin-top on purpose).
    it('plex-divider is present but is NOT a child of .provider-groups (base margin-top preserved)', async () => {
      const { fixture } = await setup({
        hasPlex: true,
        myProviderIds: [8],
        providers: {
          flatrate: [
            { providerId: 8, name: 'Netflix', type: 'flatrate' },
            { providerId: 9, name: 'Prime Video', type: 'flatrate' },
          ],
          rent: [],
          buy: [],
        },
        tracked: trackedItem(false),
      });
      const el = fixture.nativeElement as HTMLElement;
      // The subgroup split AND the plex section both render.
      expect(el.querySelector('[data-test="group-mine"]')).toBeTruthy();
      expect(el.querySelector('[data-test="group-elsewhere"]')).toBeTruthy();
      // The subgroup divider IS a child of `.provider-groups`.
      expect(
        el.querySelector('.provider-groups > [data-test="group-divider"]'),
      ).toBeTruthy();
      // The plex-divider is present…
      const plexDivider = el.querySelector('[data-test="plex-divider"]');
      expect(plexDivider).toBeTruthy();
      // …but is NOT a child of `.provider-groups` (so the scoped fix skips it)…
      expect(
        el.querySelector('.provider-groups > [data-test="plex-divider"]'),
      ).toBeNull();
      expect(
        plexDivider?.parentElement?.classList.contains('provider-groups'),
      ).toBe(false);
      // …and it IS a descendant of the `.glass-panel` "Where to Watch" card.
      expect(plexDivider?.closest('[data-test="providers"]')).toBeTruthy();
      expect(plexDivider?.closest('.provider-groups')).toBeNull();
    });
  });

  describe('revertIfNewEpisodes page-init wire-up (spec 0050)', () => {
    it('TV detail on init → calls revertIfNewEpisodes(tmdbId, "tv") once', async () => {
      const { svc } = await setup({
        detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
      });
      expect(svc.revertIfNewEpisodes).toHaveBeenCalledWith(1396, 'tv');
      expect(svc.revertIfNewEpisodes).toHaveBeenCalledTimes(1);
    });

    it('movie detail on init → does NOT call revertIfNewEpisodes', async () => {
      const { svc } = await setup({
        detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
      });
      expect(svc.revertIfNewEpisodes).not.toHaveBeenCalled();
    });

    it('same TV title re-emitting → revertIfNewEpisodes called only once (dedupe by tmdbId)', async () => {
      // Use a BehaviorSubject so we can push a second emission of the same detail.
      const detailSubject = new BehaviorSubject<DetailViewState>({
        kind: 'loaded',
        source: 'cache',
        detail: tvDetail,
      });
      const svc = makeService();
      svc.detail$ = vi.fn(() => detailSubject.asObservable());

      await TestBed.configureTestingModule({
        imports: [TitleDetailPage],
        providers: [
          provideIonicAngular(),
          { provide: TitleDetailService, useValue: svc },
          { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
          { provide: SyncStateService, useValue: mockSyncState() },
          { provide: ToastController, useValue: mockToastCtrl() },
          {
            provide: ActivatedRoute,
            useValue: {
              paramMap: of(convertToParamMap({ titleId: '1396' })),
              queryParamMap: of(convertToParamMap({})),
              snapshot: { paramMap: convertToParamMap({ titleId: '1396' }) },
            },
          },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(TitleDetailPage);
      await fixture.whenStable();
      fixture.detectChanges();

      // Re-emit the same TV detail.
      detailSubject.next({
        kind: 'loaded',
        source: 'cache',
        detail: tvDetail,
      });
      await fixture.whenStable();
      fixture.detectChanges();

      // Still only called once (dedupe by tmdbId).
      expect(svc.revertIfNewEpisodes).toHaveBeenCalledTimes(1);
    });
  });

  // --- spec 0053: completed status threads the resolved type ---

  describe('updateStatus type threading (spec 0053)', () => {
    it('selecting "Completed" on a loaded TV detail invokes updateStatus(id, "completed", "tv")', async () => {
      const { fixture, svc } = await setup({
        detail: { kind: 'loaded', source: 'cache', detail: tvDetail },
        tracked: {
          type: 'tv',
          tmdbId: 1396,
          title: 'Breaking Bad',
          addedAt: '2026-01-01T00:00:00Z',
          status: 'watching',
        },
      });
      const cmp = fixture.componentInstance;
      const completedBtn = cmp.actionSheetButtons.find(
        (b) => b.text === 'Completed',
      );
      void completedBtn?.handler?.();
      // tmdbId comes from the route param (27205 by default), type from detail$.
      expect(svc.updateStatus).toHaveBeenCalledWith(27205, 'completed', 'tv');
    });

    it('currentType synced from detail$: a loaded movie detail → handler passes "movie"', async () => {
      const { fixture, svc } = await setup({
        detail: { kind: 'loaded', source: 'cache', detail: movieDetail },
        tracked: {
          type: 'movie',
          tmdbId: 27205,
          title: 'Inception',
          addedAt: '2026-01-01T00:00:00Z',
          status: 'watching',
        },
      });
      const cmp = fixture.componentInstance;
      const completedBtn = cmp.actionSheetButtons.find(
        (b) => b.text === 'Completed',
      );
      void completedBtn?.handler?.();
      expect(svc.updateStatus).toHaveBeenCalledWith(
        27205,
        'completed',
        'movie',
      );
    });
  });

  // --- spec 0052: pull-to-refresh ---

  describe('pull-to-refresh (spec 0052)', () => {
    it('renders an ion-refresher with slot="fixed" and not disabled', async () => {
      const { fixture } = await setup();
      const el = fixture.nativeElement as HTMLElement;
      const refresher = el.querySelector('ion-refresher');
      expect(refresher).toBeTruthy();
      expect(refresher?.getAttribute('slot')).toBe('fixed');
      // No `disabled` attribute — the refresher is always pullable; the
      // cooldown is enforced inside onRefresh, not by disabling the control.
      expect(refresher?.hasAttribute('disabled')).toBe(false);
      expect(refresher?.querySelector('ion-refresher-content')).toBeTruthy();
    });

    it('canSync true → triggers sync + success toast, then completes', async () => {
      const syncState = mockSyncState({
        canSync: signal(true),
        triggerSync: vi.fn(() => Promise.resolve(undefined)),
      });
      const toast = mockToastCtrl();
      const { fixture } = await setup({}, '27205', undefined, syncState, toast);
      const { event, complete } = fakeRefreshEvent();

      await fixture.componentInstance.onRefresh(event);

      expect(syncState.triggerSync).toHaveBeenCalledTimes(1);
      expect(toast.create).toHaveBeenCalledWith({
        message: 'Refreshed',
        duration: 2000,
        position: 'bottom',
        color: 'success',
      });
      expect(toast.present).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('canSync false → no-op: no sync, no toast, but still completes', async () => {
      const syncState = mockSyncState({ canSync: signal(false) });
      const toast = mockToastCtrl();
      const { fixture } = await setup({}, '27205', undefined, syncState, toast);
      const { event, complete } = fakeRefreshEvent();

      await fixture.componentInstance.onRefresh(event);

      expect(syncState.triggerSync).not.toHaveBeenCalled();
      expect(toast.create).not.toHaveBeenCalled();
      expect(toast.present).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('triggerSync rejects → error toast, then completes', async () => {
      const syncState = mockSyncState({
        canSync: signal(true),
        triggerSync: vi.fn(() => Promise.reject(new Error('boom'))),
      });
      const toast = mockToastCtrl();
      const { fixture } = await setup({}, '27205', undefined, syncState, toast);
      const { event, complete } = fakeRefreshEvent();

      await fixture.componentInstance.onRefresh(event);

      expect(toast.create).toHaveBeenCalledWith({
        message: 'Sync failed — try again later',
        duration: 3000,
        position: 'bottom',
        color: 'danger',
      });
      expect(toast.present).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });
});

// --- spec 0060: pure partitionProviders helper ---

describe('partitionProviders (spec 0060 — pure)', () => {
  const netflix: WatchProvider = {
    providerId: 8,
    name: 'Netflix',
    type: 'flatrate',
  };
  const prime: WatchProvider = {
    providerId: 9,
    name: 'Prime Video',
    type: 'flatrate',
  };
  const playRent: WatchProvider = {
    providerId: 10,
    name: 'Google Play',
    type: 'rent',
  };
  const appleBuy: WatchProvider = {
    providerId: 2,
    name: 'Apple TV',
    type: 'buy',
  };

  it('a selected flatrate provider → mine; others → elsewhere', () => {
    const { mine, elsewhere } = partitionProviders(
      [netflix, prime, playRent, appleBuy],
      [8],
    );
    expect(mine).toEqual([netflix]);
    expect(elsewhere).toEqual([prime, playRent, appleBuy]);
  });

  it('no selected ids → everything is elsewhere', () => {
    const { mine, elsewhere } = partitionProviders(
      [netflix, playRent, appleBuy],
      [],
    );
    expect(mine).toEqual([]);
    expect(elsewhere).toEqual([netflix, playRent, appleBuy]);
  });

  it('a rent/buy provider whose id is in myProviderIds stays in elsewhere (only flatrate can be mine)', () => {
    const rentWithSelectedId: WatchProvider = {
      providerId: 8,
      name: 'Netflix Store',
      type: 'rent',
    };
    const buyWithSelectedId: WatchProvider = {
      providerId: 8,
      name: 'Netflix Store',
      type: 'buy',
    };
    const { mine, elsewhere } = partitionProviders(
      [rentWithSelectedId, buyWithSelectedId],
      [8],
    );
    expect(mine).toEqual([]);
    expect(elsewhere).toEqual([rentWithSelectedId, buyWithSelectedId]);
  });

  it('all flatrate selected → all mine, elsewhere empty', () => {
    const { mine, elsewhere } = partitionProviders([netflix, prime], [8, 9]);
    expect(mine).toEqual([netflix, prime]);
    expect(elsewhere).toEqual([]);
  });

  it('empty input → both empty', () => {
    const { mine, elsewhere } = partitionProviders([], [8]);
    expect(mine).toEqual([]);
    expect(elsewhere).toEqual([]);
  });
});
