import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  deleteDoc,
  doc,
  docData,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type EpisodeDoc,
  type Region,
  type TitleType,
  type WatchStatus,
  type WatchlistItem,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  dataToAvailability,
  dataToEpisode,
  dataToTitleCache,
  dataToUser,
  dataToWatchlistItem,
  episodePath,
  episodesPath,
  titleCacheDocPath,
  userPath,
  watchlistItemPath,
  watchlistItemToData,
} from '@vultus/shared/firestore-schema';
import type {
  EpisodeReadData,
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

/**
 * One episode row: the shared `EpisodeDoc` plus its Firestore document id
 * (needed to address `updateDoc` writes). Slice-local — the page + tests consume
 * it across the barrel (spec 0034). The doc id is the sync engine's
 * `s{NN}e{NN}` key; we never derive or write it here.
 */
export interface EpisodeRow extends EpisodeDoc {
  id: string; // Firestore doc id (idField)
}

/**
 * Episodes of one season, grouped + summarised for the collapsible season UI.
 * `watchedCount`/`total`/`allWatched` are derived from `episodes` (spec 0034).
 */
export interface SeasonGroup {
  season: number;
  episodes: EpisodeRow[]; // sorted by episode asc
  watchedCount: number;
  total: number;
  allWatched: boolean; // watchedCount === total && total > 0
}

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
   * Per-title memory of whether THIS slice auto-advanced `planned → watching`
   * (on the first episode mark). Lets `autoUpdateStatus` walk the status back to
   * `planned` when the user un-watches everything — but only if WE set it, never
   * clobbering a status the user picked manually (spec 0034 decision).
   */
  private readonly autoSetWatching = new Map<number, boolean>();

  /**
   * Resolve the detail view model for a tmdbId: title-cache first, live TMDB on
   * miss (decision 2). Emits `loading` first, then `loaded`/`not-found`. Needs
   * no uid — resolves even before the anon session.
   */
  detail$(tmdbId: number, typeHint?: TitleType): Observable<DetailViewState> {
    return from(this.resolveDetail(tmdbId, typeHint)).pipe(
      startWith<DetailViewState>({ kind: 'loading' }),
    );
  }

  private async resolveDetail(
    tmdbId: number,
    typeHint?: TitleType,
  ): Promise<DetailViewState> {
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
      const detail = await this.client.getDetail(tmdbId, typeHint);
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

  /**
   * Realtime, season-grouped episodes for a TV title (spec 0034). Reads
   * `users/{uid}/watchlist/{titleId}/episodes` (written by the sync engine),
   * groups by season ascending with episodes sorted ascending, and derives the
   * per-season watched counts. Non-tv type OR null uid → `of([])` (the empty
   * state). An empty subcollection emits `[]` (also the empty state).
   */
  episodes$(tmdbId: number, type: TitleType): Observable<SeasonGroup[]> {
    if (type !== 'tv') {
      return of([]);
    }
    const uid = this.uid();
    if (!uid) {
      return of([]);
    }
    return (
      collectionData(
        collection(this.firestore, episodesPath(uid, String(tmdbId))),
        { idField: 'id' },
      ) as Observable<(EpisodeReadData & { id: string })[]>
    ).pipe(map((items) => groupEpisodes(items)));
  }

  /**
   * Mark one episode watched/unwatched. `updateDoc` ONLY (the doc is pre-written
   * by the sync engine; we never create episode docs). Sets `watchedAt` to now
   * on watch, null on unwatch, then re-derives the title's status. No-op on null
   * uid.
   */
  async setEpisodeWatched(
    tmdbId: number,
    episodeId: string,
    watched: boolean,
  ): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    await updateDoc(
      doc(this.firestore, episodePath(uid, String(tmdbId), episodeId)),
      { watched, watchedAt: watched ? new Date() : null },
    );
    await this.autoUpdateStatus(tmdbId);
  }

  /**
   * Bulk mark every episode of a season watched/unwatched in one batch. Reads
   * the season's episode docs (one-shot, filtered by `season`) for their ids,
   * `updateDoc`s each via a `writeBatch`, then re-derives the title's status.
   * No-op on null uid.
   */
  async setSeasonWatched(
    tmdbId: number,
    season: number,
    watched: boolean,
  ): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    const snap = await getDocs(
      query(
        collection(this.firestore, episodesPath(uid, String(tmdbId))),
        where('season', '==', season),
      ),
    );
    const batch = writeBatch(this.firestore);
    const watchedAt = watched ? new Date() : null;
    for (const docSnap of snap.docs) {
      batch.update(docSnap.ref, { watched, watchedAt });
    }
    await batch.commit();
    await this.autoUpdateStatus(tmdbId);
  }

  /**
   * Movie "mark as watched" toggle (spec 0034). Reads the current tracked status
   * one-shot; a `dropped` movie is a no-op (we never clobber an explicit drop).
   * Otherwise watched → `completed`, unwatched → `watching`. No-op on null uid.
   */
  async setMovieWatched(tmdbId: number, watched: boolean): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    const status = await this.currentStatus(uid, tmdbId);
    if (status === 'dropped') {
      return;
    }
    await this.updateStatus(tmdbId, watched ? 'completed' : 'watching');
  }

  /**
   * Page-init auto-revert for TV (spec 0050, decision 4): if a `'completed'` TV
   * show's episodes subcollection contains at least one `watched: false` episode
   * (e.g. new episodes added by the spec-0047 sync), silently revert the status
   * to `'watching'`. No toast / no user-facing message — the tracked$ badge
   * updates reactively. No-op on movies, null uid, non-`'completed'` status, or
   * an empty subcollection. One-shot reads (the watchlist doc + episodes).
   */
  async revertIfNewEpisodes(tmdbId: number, type: TitleType): Promise<void> {
    if (type !== 'tv') {
      return;
    }
    const uid = this.uid();
    if (!uid) {
      return;
    }
    const status = await this.currentStatus(uid, tmdbId);
    if (status !== 'completed') {
      return;
    }
    const snap = await getDocs(
      collection(this.firestore, episodesPath(uid, String(tmdbId))),
    );
    if (snap.docs.length === 0) {
      return;
    }
    const hasUnwatched = snap.docs.some((d) => {
      const ep = dataToEpisode(d.data() as EpisodeReadData);
      return !ep.watched;
    });
    if (hasUnwatched) {
      await this.updateStatus(tmdbId, 'watching');
    }
  }

  /**
   * Re-derive the watchlist status from the episodes' current watched-state
   * after an episode/season write (spec 0034, refined by spec 0050). NEVER
   * touches a `dropped` title. The advance order matters (spec 0050 decision 3):
   * `planned → watching` is evaluated FIRST, so `completed` is only ever reached
   * from an effective `'watching'` status, never directly from `'planned'`.
   * - first episode watched while `planned` → `watching` (and remember WE did it)
   * - all episodes watched (total > 0) WHILE effective status is `'watching'` →
   *   `completed` (a `planned` title marked all-at-once converges in one pass:
   *   `planned → watching → completed`)
   * - back to zero watched, and WE auto-set `watching` earlier → `planned`
   * One-shot reads (episodes + the watchlist doc); no-op on null uid.
   */
  private async autoUpdateStatus(tmdbId: number): Promise<void> {
    const uid = this.uid();
    if (!uid) {
      return;
    }
    let status = await this.currentStatus(uid, tmdbId);
    if (status === null || status === 'dropped') {
      return;
    }
    const snap = await getDocs(
      collection(this.firestore, episodesPath(uid, String(tmdbId))),
    );
    let total = 0;
    let watchedCount = 0;
    for (const docSnap of snap.docs) {
      const ep = dataToEpisode(docSnap.data() as EpisodeReadData);
      total += 1;
      if (ep.watched) {
        watchedCount += 1;
      }
    }

    // Step 1: planned → watching (evaluate FIRST so completed comes via watching).
    if (watchedCount >= 1 && status === 'planned') {
      this.autoSetWatching.set(tmdbId, true);
      await this.updateStatus(tmdbId, 'watching');
      status = 'watching'; // effective status for the next check
    }
    // Step 2: watching + all watched → completed (only reachable from watching).
    if (total > 0 && watchedCount === total && status === 'watching') {
      await this.updateStatus(tmdbId, 'completed');
      return;
    }
    // Step 3: un-watch to zero → planned, but only if WE auto-set watching.
    if (watchedCount === 0 && this.autoSetWatching.get(tmdbId) === true) {
      this.autoSetWatching.delete(tmdbId);
      await this.updateStatus(tmdbId, 'planned');
    }
  }

  /** One-shot read of the tracked status; null when untracked / doc absent. */
  private async currentStatus(
    uid: string,
    tmdbId: number,
  ): Promise<WatchStatus | null> {
    const snap = await getDoc(
      doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
    );
    if (!snap.exists()) {
      return null;
    }
    return dataToWatchlistItem(snap.data() as WatchlistItemReadData).status;
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

/**
 * Group raw episode read-data into season-ordered `SeasonGroup`s: convert each
 * via `dataToEpisode` (keeping the doc id), bucket by season, sort seasons +
 * episodes ascending, and derive the per-season watched counts (spec 0034).
 */
function groupEpisodes(
  items: (EpisodeReadData & { id: string })[],
): SeasonGroup[] {
  const bySeason = new Map<number, EpisodeRow[]>();
  for (const item of items) {
    const row: EpisodeRow = { ...dataToEpisode(item), id: item.id };
    const list = bySeason.get(row.season);
    if (list) {
      list.push(row);
    } else {
      bySeason.set(row.season, [row]);
    }
  }
  return [...bySeason.keys()]
    .sort((a, b) => a - b)
    .map((season): SeasonGroup => {
      const episodes = (bySeason.get(season) ?? []).sort(
        (a, b) => a.episode - b.episode,
      );
      const total = episodes.length;
      const watchedCount = episodes.filter((e) => e.watched).length;
      return {
        season,
        episodes,
        watchedCount,
        total,
        allWatched: watchedCount === total && total > 0,
      };
    });
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
