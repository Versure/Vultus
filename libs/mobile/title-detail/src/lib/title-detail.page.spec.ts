import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import {
  ToastController,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { SyncStateService } from '@vultus/shared/ui-kit';
import { BehaviorSubject, NEVER, type Observable, concat, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupedProviders, TitleDetail } from './tmdb-detail.client';
import {
  type DetailViewState,
  type SeasonGroup,
  TitleDetailService,
} from './title-detail.service';

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
    providers$: vi.fn(() => of(o.providers ?? emptyProviders)),
    tracked$: vi.fn(() => tracked$),
    episodes$: vi.fn(() => episodes$),
    add: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    removeTitle: vi.fn().mockResolvedValue(undefined),
    setEpisodeWatched: vi.fn().mockResolvedValue(undefined),
    setSeasonWatched: vi.fn().mockResolvedValue(undefined),
    setMovieWatched: vi.fn().mockResolvedValue(undefined),
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
) {
  paramMap$ = new BehaviorSubject(
    convertToParamMap({ titleId: initialTitleId }),
  );
  queryParamMap$ = new BehaviorSubject(
    initialType
      ? convertToParamMap({ type: initialType })
      : convertToParamMap({}),
  );
  const svc = makeService(o);
  await TestBed.configureTestingModule({
    imports: [TitleDetailPage],
    providers: [
      provideIonicAngular(),
      { provide: TitleDetailService, useValue: svc },
      { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
      { provide: SyncStateService, useValue: syncState },
      { provide: ToastController, useValue: toast },
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
  return { fixture, svc, syncState, toast };
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

  it('renders provider groups as text chips, omitting empty groups', async () => {
    const { fixture } = await setup({
      providers: {
        flatrate: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
        rent: [],
        buy: [{ providerId: 2, name: 'Apple TV', type: 'buy' }],
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="group-flatrate"]')).toBeTruthy();
    expect(el.querySelector('[data-test="group-rent"]')).toBeFalsy();
    expect(el.querySelector('[data-test="group-buy"]')).toBeTruthy();
    expect(el.textContent).toContain('Netflix');
    expect(el.textContent).toContain('Apple TV');
    expect(el.querySelector('img.provider-logo')).toBeFalsy();
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

  it('tracked → renders the status control + remove; openStatusSheet opens the action sheet; selecting calls updateStatus', async () => {
    const { fixture, svc } = await setup({
      tracked: {
        type: 'movie',
        tmdbId: 27205,
        traktId: null,
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
        traktId: null,
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
      providers$: vi.fn(() => of(emptyProviders)),
      tracked$: vi.fn(() => of(null)),
      episodes$: vi.fn(() => NEVER),
      add: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      removeTitle: vi.fn().mockResolvedValue(undefined),
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
      providers$: vi.fn(() => of(emptyProviders)),
      tracked$: vi.fn(() =>
        of({
          type: 'tv',
          tmdbId: 27205,
          traktId: null,
          title: 'Inception',
          addedAt: '2026-01-01T00:00:00Z',
          status: 'planned',
        }),
      ),
      episodes$: vi.fn(() => NEVER),
      add: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      removeTitle: vi.fn().mockResolvedValue(undefined),
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
        traktId: null,
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
        traktId: null,
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
        traktId: null,
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
          traktId: null,
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
          traktId: null,
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
