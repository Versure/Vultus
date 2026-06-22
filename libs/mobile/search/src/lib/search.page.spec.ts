import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { signal } from '@angular/core';
import { vi, describe, it, expect } from 'vitest';

// SearchService (a transitive import) pulls in @angular/fire/firestore, which
// re-exports rxfire — an ESM-in-CJS package that trips Vitest's loader. The
// SearchService instance is mocked via DI here, so a hollow module mock is
// enough to keep the real (untransformable) module out of the graph.
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class {},
  collection: vi.fn(),
  collectionData: vi.fn(),
  doc: vi.fn(),
  setDoc: vi.fn(),
}));

import { SearchPage } from './search.page';
import { SearchService } from './search.service';
import type { SearchResultView } from './search.service';

function makeService(
  overrides: Partial<{
    viewState: string;
    results: SearchResultView[];
    lastQuery: string;
  }> = {},
) {
  return {
    viewState: signal(overrides.viewState ?? 'prompt'),
    results: signal(overrides.results ?? []),
    lastQuery: signal(overrides.lastQuery ?? ''),
    setQuery: vi.fn(),
    add: vi.fn().mockResolvedValue(undefined),
    retrySearch: vi.fn(),
  };
}

describe('SearchPage', () => {
  const mockResult: SearchResultView = {
    tmdbId: 1,
    type: 'movie',
    title: 'Test Movie',
    year: 2023,
    posterUrl: 'https://image.tmdb.org/t/p/w185/test.jpg',
    added: false,
  };
  const addedResult: SearchResultView = {
    ...mockResult,
    tmdbId: 2,
    added: true,
    title: 'Added Movie',
  };

  async function setup(serviceOverrides = {}) {
    const svc = makeService(serviceOverrides);
    await TestBed.configureTestingModule({
      imports: [SearchPage],
      providers: [provideIonicAngular()],
    })
      // SearchPage declares `providers: [SearchService]` at the component level,
      // which shadows any module-level provider. Override it so the page uses
      // our mock instead of constructing the real (Firestore-bound) service.
      .overrideComponent(SearchPage, {
        set: { providers: [{ provide: SearchService, useValue: svc }] },
      })
      .compileComponents();
    const fixture = TestBed.createComponent(SearchPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, svc };
  }

  it('shows prompt state by default', async () => {
    const { fixture } = await setup({ viewState: 'prompt' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Search for movies and TV shows');
  });

  it('shows result cards in results state', async () => {
    const { fixture } = await setup({
      viewState: 'results',
      results: [mockResult],
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Test Movie');
    expect(el.textContent).toContain('Movie');
    expect(el.querySelector('img')).toBeTruthy();
  });

  it('shows poster placeholder when posterUrl is null', async () => {
    const noPoster = { ...mockResult, posterUrl: null };
    const { fixture } = await setup({
      viewState: 'results',
      results: [noPoster],
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('img')).toBeFalsy();
    expect(el.querySelector('.poster-placeholder')).toBeTruthy();
  });

  it('calls add when Add button tapped', async () => {
    const { fixture, svc } = await setup({
      viewState: 'results',
      results: [mockResult],
    });
    const el = fixture.nativeElement as HTMLElement;
    const addBtn = el.querySelector<HTMLElement>('.add-btn');
    addBtn?.click();
    expect(svc.add).toHaveBeenCalledWith(mockResult);
  });

  it('does not show Add button for added results', async () => {
    const { fixture } = await setup({
      viewState: 'results',
      results: [addedResult],
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.add-btn')).toBeFalsy();
    expect(el.querySelector('.added-btn')).toBeTruthy();
  });

  it('shows no-results state with query', async () => {
    const { fixture } = await setup({
      viewState: 'no-results',
      lastQuery: 'xyzzy',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain("No results for 'xyzzy'");
  });

  it('shows loading spinner', async () => {
    const { fixture } = await setup({ viewState: 'loading' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('ion-spinner')).toBeTruthy();
  });
});
