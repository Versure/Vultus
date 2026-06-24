import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { NEVER, type Observable, concat, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupedProviders, TitleDetail } from './tmdb-detail.client';
import {
  type DetailViewState,
  TitleDetailService,
} from './title-detail.service';

// Keep @angular/fire/firestore (rxfire ESM) out of the graph — the service is
// mocked via DI, so a hollow module mock is enough.
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class {},
  doc: vi.fn(),
  docData: vi.fn(),
  getDoc: vi.fn(),
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

interface SvcOpts {
  detail?: DetailViewState | 'loading';
  region?: string | null;
  providers?: GroupedProviders;
  tracked?: unknown;
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
  return {
    detail$: vi.fn(() => detail$),
    region$: vi.fn(() => of(o.region === undefined ? 'NL' : o.region)),
    providers$: vi.fn(() => of(o.providers ?? emptyProviders)),
    tracked$: vi.fn(() => of(o.tracked ?? null)),
    add: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    removeTitle: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup(o: SvcOpts = {}) {
  const svc = makeService(o);
  await TestBed.configureTestingModule({
    imports: [TitleDetailPage],
    providers: [
      provideIonicAngular(),
      { provide: TitleDetailService, useValue: svc },
      { provide: AUTH_UID, useValue: signal<string | null>('user-123') },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: new Map([['titleId', '27205']]) } },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(TitleDetailPage);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, svc };
}

describe('TitleDetailPage', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads :titleId from the route', async () => {
    const { fixture } = await setup();
    expect(fixture.componentInstance.tmdbId).toBe(27205);
  });

  it('shows the loading skeleton before the first emission (no not-found copy)', async () => {
    const { fixture } = await setup({ detail: 'loading' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="loading"]')).toBeTruthy();
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

  it('shows the not-found state and no action area', async () => {
    const { fixture } = await setup({ detail: { kind: 'not-found' } });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="not-found"]')).toBeTruthy();
    expect(el.textContent).toContain('Title not found');
    expect(el.querySelector('[data-test="action-area"]')).toBeFalsy();
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

    // Selecting a status row invokes updateStatus.
    const watchingBtn = cmp.actionSheetButtons.find(
      (b) => b.text === 'Watching',
    );
    void watchingBtn?.handler?.();
    expect(svc.updateStatus).toHaveBeenCalledWith(27205, 'watching');
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
});
