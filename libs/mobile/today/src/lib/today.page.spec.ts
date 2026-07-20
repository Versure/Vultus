import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type EpisodeDoc,
  type RegionAvailability,
  type WatchlistItem,
} from '@vultus/shared/domain';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the data-access service module so the page test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks the
// jsdom transform). The page composes its view model from the pure
// `today.logic` helpers (imported for real — they have no Firebase dependency)
// over data the mocked service returns. The factory is hoisted, so it must be
// fully self-contained (no outer references) — a bare class used as the DI
// token.
vi.mock('./today.service', () => ({
  TodayService: class TodayService {},
}));

import { TodayPage } from './today.page';
import { TodayService } from './today.service';

// A fixed "now" so the past/future gates are deterministic (D5). Faking ONLY
// `Date` (not timers) keeps promise microtasks / `whenStable` real.
const FIXED_NOW = '2026-01-02T15:00:00.000Z';

function item(over: Partial<WatchlistItem>): WatchlistItem {
  return {
    type: 'movie',
    tmdbId: 1,
    traktId: null,
    title: 'Title',
    addedAt: '2026-01-01T00:00:00.000Z',
    status: 'watching',
    watchingViaPlex: false,
    ...over,
  };
}

interface ProviderShape {
  providerId: number;
  name: string;
  type: 'flatrate' | 'rent' | 'buy';
}

function availability(providers: ProviderShape[]): RegionAvailability {
  return {
    providers,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    previousSnapshot: [],
  };
}

function episode(over: Partial<EpisodeDoc>): EpisodeDoc {
  return {
    season: 1,
    episode: 1,
    title: null,
    airDate: '2026-01-01T00:00:00.000Z',
    watched: false,
    watchedAt: null,
    ...over,
  };
}

interface MockService {
  watchlist$: ReturnType<typeof vi.fn>;
  userRegion$: ReturnType<typeof vi.fn>;
  myProviderIds$: ReturnType<typeof vi.fn>;
  availability$: ReturnType<typeof vi.fn>;
  readEpisodes: ReturnType<typeof vi.fn>;
}

interface MockOpts {
  region?: string | null;
  myProviderIds?: number[];
  availabilityByTmdbId?: Record<number, ProviderShape[]>;
  episodesByTitleId?: Record<string, EpisodeDoc[]>;
  watchlistError?: boolean;
}

function mockService(items: WatchlistItem[], opts: MockOpts = {}): MockService {
  const {
    region = 'NL',
    myProviderIds = [],
    availabilityByTmdbId = {},
    episodesByTitleId = {},
    watchlistError = false,
  } = opts;
  return {
    watchlist$: vi.fn(() =>
      watchlistError ? throwError(() => new Error('boom')) : of(items),
    ),
    userRegion$: vi.fn(() => of(region)),
    myProviderIds$: vi.fn(() => of(myProviderIds)),
    availability$: vi.fn((tmdbId: number) => {
      const providers = availabilityByTmdbId[tmdbId];
      return of(providers ? availability(providers) : null);
    }),
    readEpisodes: vi.fn((_uid: string, titleId: string) =>
      Promise.resolve(episodesByTitleId[titleId] ?? []),
    ),
  };
}

function mockRouter() {
  return { navigate: vi.fn(() => Promise.resolve(true)) };
}

async function setup(
  service: MockService,
  uid: string | null = 'uid-123',
  router = mockRouter(),
) {
  await TestBed.configureTestingModule({
    imports: [TodayPage],
    providers: [
      provideIonicAngular(),
      { provide: TodayService, useValue: service },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: Router, useValue: router },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(TodayPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, router };
}

async function settle(fixture: {
  detectChanges: () => void;
  whenStable: () => Promise<unknown>;
}): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** Section titles in DOM order (uppercased-by-CSS text is unaffected in the DOM). */
function sectionTitles(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.section-title')).map(
    (s) => s.textContent ?? '',
  );
}

/** Card titles across all rendered sections, in DOM order. */
function cardTitles(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.card-title')).map(
    (h) => h.textContent ?? '',
  );
}

describe('TodayPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the Movies section only when there is ≥1 watchable movie', async () => {
    const service = mockService([
      item({
        tmdbId: 1,
        type: 'movie',
        title: 'Dune',
        releaseDate: '2024-03-15',
      }),
    ]);
    const { el } = await setup(service);
    expect(sectionTitles(el)).toEqual(['Movies']);
    expect(cardTitles(el)).toEqual(['Dune']);
  });

  it('renders the TV Shows section only when there is ≥1 watchable TV show', async () => {
    const service = mockService([
      item({
        tmdbId: 2,
        type: 'tv',
        title: 'The Bear',
        nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
      }),
    ]);
    const { el } = await setup(service);
    expect(sectionTitles(el)).toEqual(['TV Shows']);
    expect(cardTitles(el)).toEqual(['The Bear']);
  });

  it('renders both sections (Movies before TV Shows) when both are non-empty', async () => {
    const service = mockService([
      item({
        tmdbId: 2,
        type: 'tv',
        title: 'The Bear',
        nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
      }),
      item({
        tmdbId: 1,
        type: 'movie',
        title: 'Dune',
        releaseDate: '2024-03-15',
      }),
    ]);
    const { el } = await setup(service);
    expect(sectionTitles(el)).toEqual(['Movies', 'TV Shows']);
    expect(cardTitles(el)).toEqual(['Dune', 'The Bear']);
  });

  it('renders the empty state (exact copy) when nothing is watchable', async () => {
    const service = mockService([
      item({ tmdbId: 1, type: 'movie', releaseDate: '2099-01-01' }), // future
      item({ tmdbId: 2, type: 'tv', nextUnwatchedEpisodeAirDate: null }), // no date
    ]);
    const { el } = await setup(service);
    expect(el.querySelector('vultus-empty-state')).not.toBeNull();
    expect(el.querySelector('.section-title')).toBeNull();
    const empty = el.querySelector<HTMLElement>('vultus-empty-state');
    expect(
      empty?.querySelector('.vultus-empty-state__title')?.textContent,
    ).toBe('Nothing to watch today');
    expect(
      empty?.querySelector('.vultus-empty-state__subtitle')?.textContent,
    ).toBe(
      'Nothing on your watchlist has a new episode or release available yet.',
    );
  });

  it('D2 gate: shows past-dated titles, hides future/null-dated titles (movie + TV)', async () => {
    const service = mockService([
      item({
        tmdbId: 1,
        type: 'movie',
        title: 'PastMovie',
        releaseDate: '2024-01-01',
      }),
      item({
        tmdbId: 2,
        type: 'movie',
        title: 'FutureMovie',
        releaseDate: '2099-01-01',
      }),
      item({
        tmdbId: 3,
        type: 'movie',
        title: 'NoDateMovie',
        releaseDate: null,
      }),
      item({
        tmdbId: 4,
        type: 'tv',
        title: 'PastTv',
        nextUnwatchedEpisodeAirDate: '2025-01-01T00:00:00.000Z',
      }),
      item({
        tmdbId: 5,
        type: 'tv',
        title: 'FutureTv',
        nextUnwatchedEpisodeAirDate: '2099-01-01T00:00:00.000Z',
      }),
      item({
        tmdbId: 6,
        type: 'tv',
        title: 'NoDateTv',
        nextUnwatchedEpisodeAirDate: null,
      }),
    ]);
    const { el } = await setup(service);
    expect(cardTitles(el)).toEqual(['PastMovie', 'PastTv']);
  });

  it('excludes dropped/completed titles even when their date is in the past', async () => {
    const service = mockService([
      item({
        tmdbId: 1,
        type: 'movie',
        title: 'Dropped',
        status: 'dropped',
        releaseDate: '2024-01-01',
      }),
      item({
        tmdbId: 2,
        type: 'movie',
        title: 'Completed',
        status: 'completed',
        releaseDate: '2024-01-01',
      }),
    ]);
    const { el } = await setup(service);
    expect(el.querySelector('vultus-empty-state')).not.toBeNull();
  });

  it('renders the exact subtitle from the total watchable count', async () => {
    const service = mockService([
      item({ tmdbId: 1, type: 'movie', releaseDate: '2024-01-01' }),
      item({
        tmdbId: 2,
        type: 'tv',
        nextUnwatchedEpisodeAirDate: '2025-01-01T00:00:00.000Z',
      }),
      item({
        tmdbId: 3,
        type: 'tv',
        nextUnwatchedEpisodeAirDate: '2025-02-01T00:00:00.000Z',
      }),
    ]);
    const { el } = await setup(service);
    expect(el.querySelector('.hero-subtitle')?.textContent).toBe(
      '3 things ready to watch',
    );
  });

  it('renders the exact singular subtitle for a single watchable title', async () => {
    const service = mockService([
      item({ tmdbId: 1, type: 'movie', releaseDate: '2024-01-01' }),
    ]);
    const { el } = await setup(service);
    expect(el.querySelector('.hero-subtitle')?.textContent).toBe(
      '1 thing ready to watch',
    );
  });

  it('D3 pill: renders exact "On Netflix" + check icon for a mine provider', async () => {
    const service = mockService(
      [item({ tmdbId: 1, type: 'movie', releaseDate: '2024-01-01' })],
      {
        myProviderIds: [8],
        availabilityByTmdbId: {
          1: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
        },
      },
    );
    const { el } = await setup(service);
    const pill = el.querySelector<HTMLElement>('.availability-pill');
    expect(pill).not.toBeNull();
    expect(pill?.classList.contains('is-mine')).toBe(true);
    expect(pill?.querySelector('.availability-pill__text')?.textContent).toBe(
      'On Netflix',
    );
    expect(
      pill?.querySelector('ion-icon[name="checkmark-circle"]'),
    ).not.toBeNull();
  });

  it('D3 pill: renders exact "Also on Netflix" (no icon) for an elsewhere provider', async () => {
    const service = mockService(
      [item({ tmdbId: 1, type: 'movie', releaseDate: '2024-01-01' })],
      {
        myProviderIds: [999], // none of the flatrate providers are mine
        availabilityByTmdbId: {
          1: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
        },
      },
    );
    const { el } = await setup(service);
    const pill = el.querySelector<HTMLElement>('.availability-pill');
    expect(pill).not.toBeNull();
    expect(pill?.classList.contains('is-mine')).toBe(false);
    expect(pill?.querySelector('.availability-pill__text')?.textContent).toBe(
      'Also on Netflix',
    );
    expect(pill?.querySelector('ion-icon')).toBeNull();
  });

  it('D3 pill: renders no pill when there is no flatrate availability', async () => {
    const service = mockService(
      [item({ tmdbId: 1, type: 'movie', releaseDate: '2024-01-01' })],
      { availabilityByTmdbId: {} },
    );
    const { el } = await setup(service);
    expect(el.querySelector('.availability-pill')).toBeNull();
  });

  it('D4: renders the exact episode label for a shown TV card', async () => {
    const service = mockService(
      [
        item({
          tmdbId: 2,
          type: 'tv',
          title: 'The Bear',
          nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
        }),
      ],
      {
        episodesByTitleId: {
          '2': [
            episode({
              season: 3,
              episode: 5,
              airDate: '2025-06-01T00:00:00.000Z',
              watched: false,
            }),
            episode({
              season: 3,
              episode: 4,
              airDate: '2025-05-01T00:00:00.000Z',
              watched: true,
            }),
          ],
        },
      },
    );
    const { el } = await setup(service);
    expect(el.querySelector('.episode-label')?.textContent).toBe(
      'S3E5 available',
    );
  });

  it('D4: readEpisodes is invoked ONLY for gated-in TV items (not movies / gated-out)', async () => {
    const service = mockService([
      item({
        tmdbId: 1,
        type: 'movie',
        title: 'Movie',
        releaseDate: '2024-01-01',
      }),
      item({
        tmdbId: 2,
        type: 'tv',
        title: 'ShownTv',
        nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
      }),
      item({
        tmdbId: 3,
        type: 'tv',
        title: 'GatedTv',
        nextUnwatchedEpisodeAirDate: '2099-01-01T00:00:00.000Z',
      }),
    ]);
    const { el } = await setup(service);
    // Only the single gated-in TV item's episodes are read.
    expect(service.readEpisodes).toHaveBeenCalledTimes(1);
    expect(service.readEpisodes).toHaveBeenCalledWith('uid-123', '2');
    // Neither the movie (tmdbId 1) nor the gated-out TV (tmdbId 3) triggered a read.
    const readTitleIds = service.readEpisodes.mock.calls.map((args) =>
      String(args[1]),
    );
    expect(readTitleIds).not.toContain('1');
    expect(readTitleIds).not.toContain('3');
    expect(el).toBeTruthy();
  });

  it('renders the exact "Ready to watch" tag on every shown card', async () => {
    const service = mockService([
      item({ tmdbId: 1, type: 'movie', releaseDate: '2024-01-01' }),
      item({
        tmdbId: 2,
        type: 'tv',
        nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
      }),
    ]);
    const { el } = await setup(service);
    const tags = Array.from(
      el.querySelectorAll<HTMLElement>('.ready-tag__text'),
    ).map((t) => t.textContent);
    expect(tags).toEqual(['Ready to watch', 'Ready to watch']);
  });

  it('shows the skeleton loader before the first stream emission', async () => {
    const service = mockService([]);
    // NEVER-emitting stream so the vm stays in the loading (startWith null) state.
    service.watchlist$ = vi.fn(() => NEVER);
    const { el } = await setup(service);
    expect(el.querySelector('vultus-skeleton-card')).not.toBeNull();
    expect(el.querySelector('vultus-empty-state')).toBeNull();
  });

  it('renders the error state on a stream error and re-subscribes on retry', async () => {
    const service = mockService([], { watchlistError: true });
    const { fixture, el } = await setup(service);
    expect(el.querySelector('vultus-error-state')).not.toBeNull();
    expect(service.watchlist$).toHaveBeenCalledTimes(1);

    // Retry re-subscribes the realtime stream (calls watchlist$ again).
    const component = fixture.componentInstance;
    component.onRetry();
    await settle(fixture);
    expect(service.watchlist$).toHaveBeenCalledTimes(2);
  });

  it('navigates to title-detail with the type query param on card tap', async () => {
    const router = mockRouter();
    const service = mockService([
      item({
        tmdbId: 42,
        type: 'tv',
        title: 'Severance',
        nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
      }),
    ]);
    const { el } = await setup(service, 'uid-123', router);
    const card = el.querySelector<HTMLElement>('.today-card');
    expect(card).not.toBeNull();
    card?.click();
    expect(router.navigate).toHaveBeenCalledWith(
      ['tabs', 'title-detail', '42'],
      { queryParams: { type: 'tv' } },
    );
  });
});
