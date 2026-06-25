import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  deleteDoc,
  doc,
  docData,
  getDoc,
  setDoc,
  updateDoc,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type Region,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  dataToAvailability,
  dataToTitleCache,
  dataToUser,
  dataToWatchlistItem,
  titleCacheDocPath,
  userPath,
  watchlistItemPath,
  watchlistItemToData,
} from '@vultus/shared/firestore-schema';
import type {
  RegionAvailabilityReadData,
  TitleCacheReadData,
  UserReadData,
  WatchlistItemReadData,
} from '@vultus/shared/firestore-schema';
import { type Observable, catchError, from, map, of, startWith } from 'rxjs';
import {
  type GroupedProviders,
  type TitleDetail,
  TmdbDetailError,
  createTmdbDetailClient,
} from './tmdb-detail.client';
import { TMDB_DETAIL_CONFIG } from './tokens';

/**
 * Display order for the status-change action sheet. Deliberately NOT the
 * `WATCH_STATUSES` order — the UI groups Watching → Planned → Completed →
 * Dropped. Slice-local by design (mirrors 0014's watchlist slice; NOT shared).
 */
export const STATUS_DISPLAY_ORDER: WatchStatus[] = [
  'watching',
  'planned',
  'completed',
  'dropped',
];

/** Human-readable label per status (slice-local UI vocabulary). */
export const STATUS_LABELS: Record<WatchStatus, string> = {
  watching: 'Watching',
  planned: 'Planned',
  completed: 'Completed',
  dropped: 'Dropped',
};

/** The page's detail view-state (decision 2 + UI states). */
export type DetailViewState =
  | { kind: 'loading' }
  | { kind: 'loaded'; source: 'cache' | 'live'; detail: TitleDetail }
  | { kind: 'not-found' } // genuine cache-miss AND live TMDB 404
  | { kind: 'error' }; // network/Firestore fetch failure (≠ 404), recoverable

/** Empty grouped-providers value (no availability / null region). */
const EMPTY_PROVIDERS: GroupedProviders = { flatrate: [], rent: [], buy: [] };

/**
 * Detail data-access for the title-detail slice (spec 0016, PLAN §6 item 19).
 *
 * Resolution is **cache-first**: read `title-cache/{tmdbId}`; on a hit render
 * from the cached metadata, on a miss fall back to a **live, display-only** TMDB
 * fetch via the slice-local `TmdbDetailClient`. The client NEVER writes
 * `title-cache` (functions-only). Region resolves from `users/{uid}.region`;
 * providers come from `title-cache/{tmdbId}/availability/{region}` on the cache
 * path or the live client on the live path. Tracked state is a realtime
 * subscription on `users/{uid}/watchlist/{titleId}`; add/updateStatus/removeTitle
 * write ONLY that doc.
 *
 * SHERIFF: uid via the `scope:shared` `AUTH_UID` token (never `apps/mobile`);
 * `Firestore` injected directly (third-party). Null uid is a no-op / null stream.
 */
@Injectable({ providedIn: 'root' })
export class TitleDetailService {
  private readonly firestore = inject(Firestore);
  private readonly uid = inject(AUTH_UID);
  private readonly config = inject(TMDB_DETAIL_CONFIG);
  private readonly client = createTmdbDetailClient(this.config);

  /**
   * Resolve the detail view model for a tmdbId: title-cache first, live TMDB on
   * miss (decision 2). Emits `loading` first, then `loaded`/`not-found`. Needs
   * no uid — resolves even before the anon session.
   */
  detail$(tmdbId: number): Observable<DetailViewState> {
    return from(this.resolveDetail(tmdbId)).pipe(
      startWith<DetailViewState>({ kind: 'loading' }),
    );
  }

  private async resolveDetail(tmdbId: number): Promise<DetailViewState> {
    // Cache path — if Firestore fails, surface the error (don't swallow it).
    try {
      const cacheRef = doc(this.firestore, titleCacheDocPath(tmdbId));
      const snap = await getDoc(cacheRef);
      if (snap.exists()) {
        const entry = dataToTitleCache(snap.data() as TitleCacheReadData);
        const meta = entry.metadata;
        const detail: TitleDetail = {
          tmdbId,
          type: entry.type,
          title: meta.title,
          year: parseYear(meta.releaseDate),
          overview: meta.overview,
          posterUrl: meta.posterPath
            ? this.config.imageBaseUrl + meta.posterPath
            : null,
          posterPath: meta.posterPath,
          // Not carried on the cached metadata (recon C) — null/omitted.
          voteAverage: null,
        };
        return { kind: 'loaded', source: 'cache', detail };
      }
    } catch {
      // Firestore error on the cache read → surface as a recoverable error,
      // NOT a silent cache miss (the title may well exist; we just couldn't read).
      return { kind: 'error' };
    }
    // Cache miss → live, display-only fallback. Discriminate a genuine 404
    // (title doesn't exist → not-found) from a transient failure (network /
    // 5xx → error, recoverable via retry).
    try {
      const detail = await this.client.getDetail(tmdbId);
      return { kind: 'loaded', source: 'live', detail };
    } catch (err) {
      if (err instanceof TmdbDetailError && err.status === 404) {
        return { kind: 'not-found' };
      }
      return { kind: 'error' };
    }
  }

  /** The user's region from `users/{uid}.region`; null uid / missing doc → null. */
  region$(): Observable<Region | null> {
    const uid = this.uid();
    if (!uid) {
      return of(null);
    }
    return (
      docData(doc(this.firestore, userPath(uid))) as Observable<
        UserReadData | undefined
      >
    ).pipe(map((data) => (data ? dataToUser(data).region : null)));
  }

  /**
   * Grouped providers for a title in the resolved region. From the cached
   * `availability/{region}` doc when the title is cached, else from the live
   * client. Null region → never fetched (caller renders the null-region prompt).
   * Missing/empty availability → empty groups (empty-providers UI, not an error).
   */
  providers$(
    tmdbId: number,
    type: TitleDetail['type'],
    region: Region | null,
    source: 'cache' | 'live',
  ): Observable<GroupedProviders> {
    if (!region) {
      return of(EMPTY_PROVIDERS);
    }
    if (source === 'cache') {
      return (
        docData(
          doc(this.firestore, availabilityDocPath(tmdbId, region)),
        ) as Observable<RegionAvailabilityReadData | undefined>
      ).pipe(map((data) => groupProviders(data)));
    }
    return from(this.client.getProviders(tmdbId, type, region)).pipe(
      startWith(EMPTY_PROVIDERS),
      // A failed /watch/providers call (non-2xx → TmdbDetailError, or network
      // error) must NOT error the stream and tear down an already-loaded page;
      // degrade to the empty-providers state (spec 0016: empty/error providers
      // is NOT an error). The cache (docData) path is already safe.
      catchError(() => of(EMPTY_PROVIDERS)),
    );
  }

  /**
   * Realtime tracked state: the watchlist doc for `{uid}/{titleId}`, or null
   * when untracked / uid null (decision 4).
   */
  tracked$(tmdbId: number): Observable<WatchlistItem | null> {
    const uid = this.uid();
    if (!uid) {
      return of(null);
    }
    return (
      docData(
        doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
      ) as Observable<WatchlistItemReadData | undefined>
    ).pipe(map((data) => (data ? dataToWatchlistItem(data) : null)));
  }

  /**
   * Create `users/{uid}/watchlist/{titleId}` as 'planned' with the denormalized
   * posterPath + voteAverage from `detail` (decision 4). No-op when uid null.
   */
  async add(detail: TitleDetail): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    const item: WatchlistItem = {
      type: detail.type,
      tmdbId: detail.tmdbId,
      traktId: null,
      title: detail.title,
      addedAt: new Date().toISOString(),
      status: 'planned',
      posterPath: detail.posterPath,
      voteAverage: detail.voteAverage,
    };
    await setDoc(
      doc(this.firestore, watchlistItemPath(uid, String(detail.tmdbId))),
      watchlistItemToData(item),
    );
  }

  /** Update the `status` field at the watchlist item path. No-op when uid null. */
  async updateStatus(tmdbId: number, status: WatchStatus): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    await updateDoc(
      doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
      { status },
    );
  }

  /** Delete the watchlist item. No-op when uid null. */
  async removeTitle(tmdbId: number): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    await deleteDoc(
      doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
    );
  }
}

/** Map a stored availability doc (or absence) to grouped providers. */
function groupProviders(
  data: RegionAvailabilityReadData | undefined,
): GroupedProviders {
  if (!data) {
    return { flatrate: [], rent: [], buy: [] };
  }
  const providers = dataToAvailability(data).providers;
  return {
    flatrate: providers.filter((p) => p.type === 'flatrate'),
    rent: providers.filter((p) => p.type === 'rent'),
    buy: providers.filter((p) => p.type === 'buy'),
  };
}

/** Year from an ISO release date string; null on blank, no NaN. */
function parseYear(date: string | null): number | null {
  const raw = date?.substring(0, 4)?.trim();
  if (!raw) return null;
  const year = parseInt(raw, 10);
  return Number.isNaN(year) ? null : year;
}
