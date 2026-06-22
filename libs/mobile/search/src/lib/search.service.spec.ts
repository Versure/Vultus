import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SearchService } from './search.service';
import { AUTH_UID } from '@vultus/shared/domain';
import { TMDB_SEARCH_CONFIG } from './tokens';
import { Firestore } from '@angular/fire/firestore';

// Mock AngularFire Firestore — collectionData yields an empty watchlist by
// default; setDoc is a resolved spy. collection/doc are inert.
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class {},
  collection: vi.fn(() => ({})),
  collectionData: vi.fn(() => of([])),
  doc: vi.fn(() => ({ path: 'users/uid1/watchlist/1' })),
  setDoc: vi.fn().mockResolvedValue(undefined),
}));

interface ClientHandle {
  _client: { searchMulti: ReturnType<typeof vi.fn> };
}
interface AddedHandle {
  _addedIds: ReturnType<typeof signal<Set<string>>>;
}

describe('SearchService', () => {
  let service: SearchService;
  let mockSetDoc: ReturnType<typeof vi.fn>;
  const uidSignal = signal<string | null>('uid1');

  // Construct the service. Call AFTER configuring the per-test collectionData
  // mock, since the watchlist subscription emits eagerly on construction.
  async function createService(): Promise<SearchService> {
    await TestBed.configureTestingModule({
      providers: [
        SearchService,
        { provide: AUTH_UID, useValue: uidSignal },
        {
          provide: TMDB_SEARCH_CONFIG,
          useValue: {
            apiBaseUrl: 'https://api.tmdb.org/3',
            imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
            auth: { kind: 'apiKey', apiKey: 'test' },
          },
        },
        { provide: Firestore, useValue: {} },
      ],
    }).compileComponents();
    service = TestBed.inject(SearchService);
    return service;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    uidSignal.set('uid1');
    const { setDoc, collectionData } = await import('@angular/fire/firestore');
    mockSetDoc = setDoc as unknown as ReturnType<typeof vi.fn>;
    mockSetDoc.mockClear();
    // Default: empty watchlist. Individual tests override before createService.
    (collectionData as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      of([]),
    );
    await createService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in prompt state', () => {
    expect(service.viewState()).toBe('prompt');
    expect(service.results()).toHaveLength(0);
  });

  it('empty/whitespace query stays prompt, no fetch', async () => {
    service.setQuery('   ');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.viewState()).toBe('prompt');
  });

  it('debounces rapid inputs', async () => {
    const searchSpy = vi.fn().mockResolvedValue([]);
    (service as unknown as ClientHandle)._client.searchMulti = searchSpy;
    service.setQuery('a');
    service.setQuery('ab');
    service.setQuery('abc');
    await vi.advanceTimersByTimeAsync(500);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith('abc');
  });

  it('shows no-results state when results are empty', async () => {
    (service as unknown as ClientHandle)._client.searchMulti = vi
      .fn()
      .mockResolvedValue([]);
    service.setQuery('unknown title xyz');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.viewState()).toBe('no-results');
  });

  it('shows results state when results found', async () => {
    const mockResults = [
      {
        tmdbId: 1,
        type: 'movie' as const,
        title: 'Film',
        year: 2020,
        posterUrl: null,
      },
    ];
    (service as unknown as ClientHandle)._client.searchMulti = vi
      .fn()
      .mockResolvedValue(mockResults);
    service.setQuery('film');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.viewState()).toBe('results');
    expect(service.results()[0].title).toBe('Film');
    expect(service.results()[0].added).toBe(false);
  });

  it('marks results as added based on watchlist', async () => {
    // The watchlist subscription is the source of truth for the added set, so
    // seed it through the mocked collectionData (which emits on construction)
    // rather than poking the private signal. Reset the TestBed and rebuild the
    // service so its subscription captures the seeded watchlist.
    TestBed.resetTestingModule();
    const { collectionData } = await import('@angular/fire/firestore');
    (collectionData as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      of([{ id: '1' }]),
    );
    await createService();
    const mockResults = [
      {
        tmdbId: 1,
        type: 'movie' as const,
        title: 'Film',
        year: 2020,
        posterUrl: null,
      },
      {
        tmdbId: 2,
        type: 'tv' as const,
        title: 'Show',
        year: 2021,
        posterUrl: null,
      },
    ];
    (service as unknown as ClientHandle)._client.searchMulti = vi
      .fn()
      .mockResolvedValue(mockResults);
    service.setQuery('test');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.results()[0].added).toBe(true);
    expect(service.results()[1].added).toBe(false);
  });

  it('add() writes to correct path with planned status', async () => {
    const result = {
      tmdbId: 42,
      type: 'movie' as const,
      title: 'Movie X',
      year: 2021,
      posterUrl: null,
    };
    await service.add(result);
    expect(mockSetDoc).toHaveBeenCalled();
    const writeData = mockSetDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(writeData['status']).toBe('planned');
    expect(writeData['traktId']).toBeNull();
  });

  it('add() is no-op when uid is null', async () => {
    uidSignal.set(null);
    const result = {
      tmdbId: 99,
      type: 'movie' as const,
      title: 'X',
      year: 2020,
      posterUrl: null,
    };
    await service.add(result);
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('add() is no-op for duplicate', async () => {
    (service as unknown as AddedHandle)._addedIds.set(new Set(['99']));
    const result = {
      tmdbId: 99,
      type: 'movie' as const,
      title: 'X',
      year: 2020,
      posterUrl: null,
    };
    await service.add(result);
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('shows error state on client error', async () => {
    (service as unknown as ClientHandle)._client.searchMulti = vi
      .fn()
      .mockRejectedValue(new Error('fetch error'));
    service.setQuery('bad query');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.viewState()).toBe('error');
  });
});
