import { inject, Injectable, Signal, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { of, switchMap } from 'rxjs';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { WatchlistItem } from '@vultus/shared/domain';
import {
  watchlistItemPath,
  watchlistItemToData,
  watchlistPath,
} from '@vultus/shared/firestore-schema';
import {
  collection,
  collectionData,
  doc,
  Firestore,
  setDoc,
} from '@angular/fire/firestore';
import { TMDB_SEARCH_CONFIG } from './tokens';
import {
  createTmdbSearchClient,
  SearchResult,
  TmdbSearchClient,
} from './tmdb-search.client';

/** A search result decorated with whether it is already on the watchlist. */
export interface SearchResultView extends SearchResult {
  added: boolean;
}

export type SearchViewState =
  | 'prompt'
  | 'loading'
  | 'results'
  | 'no-results'
  | 'error';

/**
 * Owns the search slice's state: debounced TMDB queries, the result list, and
 * the live "already added" set derived from the user's watchlist. Provided in
 * `SearchPage` (NOT root) so its lifecycle is tied to the page.
 */
@Injectable()
export class SearchService {
  private readonly _config = inject(TMDB_SEARCH_CONFIG);
  private readonly _uid = inject(AUTH_UID);
  private readonly _firestore = inject(Firestore);

  private readonly _client: TmdbSearchClient = createTmdbSearchClient(
    this._config,
  );

  private readonly _results = signal<SearchResultView[]>([]);
  private readonly _viewState = signal<SearchViewState>('prompt');
  private readonly _query = signal<string>('');
  private readonly _addedIds = signal<Set<string>>(new Set());

  readonly results: Signal<SearchResultView[]> = this._results.asReadonly();
  readonly viewState: Signal<SearchViewState> = this._viewState.asReadonly();

  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _lastQuery = signal<string>('');

  readonly lastQuery: Signal<string> = this._lastQuery.asReadonly();

  constructor() {
    // Subscribe to the user's watchlist (live) to keep the added set current.
    // `toObservable` requires an injection context — the constructor provides
    // one. The subscription re-runs whenever the uid signal changes.
    toObservable(this._uid)
      .pipe(
        switchMap((uid) => {
          if (!uid) return of([] as { id: string }[]);
          return collectionData(
            collection(this._firestore, watchlistPath(uid)),
            { idField: 'id' },
          );
        }),
      )
      .subscribe((docs) => {
        const ids = new Set((docs as { id: string }[]).map((d) => d.id));
        this._addedIds.set(ids);
        const current = this._results();
        if (current.length > 0) {
          this._results.set(
            current.map((r) => ({ ...r, added: ids.has(String(r.tmdbId)) })),
          );
        }
      });
  }

  setQuery(query: string): void {
    this._query.set(query);
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const trimmed = query.trim();
    if (!trimmed) {
      this._viewState.set('prompt');
      this._results.set([]);
      return;
    }
    this._debounceTimer = setTimeout(() => this._runSearch(trimmed), 400);
  }

  retrySearch(): void {
    const q = this._lastQuery();
    if (q) void this._runSearch(q);
  }

  /**
   * Adds a result to the user's watchlist with an optimistic local update.
   *
   * - No-op when there is no signed-in uid, or when the title is already added.
   * - Applies the optimistic update (flip `_addedIds` + the result's `added`
   *   flag) BEFORE awaiting the Firestore write, so the button reflects the add
   *   immediately.
   * - On write failure: rolls back BOTH the optimistic signal updates, then
   *   RE-THROWS so the caller (SearchPage) can present an error toast.
   */
  async add(result: SearchResult): Promise<void> {
    const uid = this._uid();
    if (!uid) return;
    const titleId = String(result.tmdbId);
    if (this._addedIds().has(titleId)) return; // duplicate guard

    // Optimistic update FIRST — the button flips to "added" immediately.
    this._addedIds.update((s) => new Set([...s, titleId]));
    this._results.update((rs) =>
      rs.map((r) => (r.tmdbId === result.tmdbId ? { ...r, added: true } : r)),
    );

    const item: WatchlistItem = {
      type: result.type,
      tmdbId: result.tmdbId,
      traktId: null,
      title: result.title,
      addedAt: new Date().toISOString(),
      status: 'planned',
      posterPath: result.posterPath ?? null,
      voteAverage: result.voteAverage ?? null,
      releaseDate: result.releaseDate ?? null,
      // Belt-and-suspenders init (spec 0081): the converter coalesces `?? null`
      // anyway, and the Cloud Functions on-add trigger populates the real value
      // shortly after for TV shows.
      nextUnwatchedEpisodeAirDate: null,
      watchingViaPlex: false,
    };

    try {
      await setDoc(
        doc(this._firestore, watchlistItemPath(uid, titleId)),
        watchlistItemToData(item),
      );
    } catch (err) {
      // Roll back BOTH optimistic updates.
      this._addedIds.update((s) => {
        const n = new Set(s);
        n.delete(titleId);
        return n;
      });
      this._results.update((rs) =>
        rs.map((r) =>
          r.tmdbId === result.tmdbId ? { ...r, added: false } : r,
        ),
      );
      throw err; // re-throw so SearchPage can show the toast
    }
  }

  private async _runSearch(query: string): Promise<void> {
    this._lastQuery.set(query);
    this._viewState.set('loading');
    this._results.set([]);
    try {
      const raw = await this._client.searchMulti(query);
      const added = this._addedIds();
      const results = raw.map((r) => ({
        ...r,
        added: added.has(String(r.tmdbId)),
      }));
      this._results.set(results);
      this._viewState.set(results.length === 0 ? 'no-results' : 'results');
    } catch {
      this._viewState.set('error');
    }
  }
}
