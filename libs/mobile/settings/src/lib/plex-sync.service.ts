import { Injectable, inject, signal } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from '@angular/fire/firestore';
import { Preferences } from '@capacitor/preferences';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type {
  PlexLibraryItem,
  PlexServer,
  TitleType,
  WatchStatus,
  WatchlistItem,
} from '@vultus/shared/domain';
import {
  dataToUser,
  dataToWatchlistItem,
  episodePath,
  episodesPath,
  userPath,
  watchlistItemPath,
  watchlistItemToData,
} from '@vultus/shared/firestore-schema';
import type {
  UserReadData,
  WatchlistItemReadData,
} from '@vultus/shared/firestore-schema';
import { PLEX_TOKEN_KEY } from './plex-link.service';
import { describePlexError, describeTmdbError } from './plex-errors';
import { createTmdbDetailClient } from './tmdb-detail.client';
import { SETTINGS_TMDB_CONFIG } from './tokens';

/** Small per-sync outcome summary (logging + the mock e2e assertions). */
export interface PlexSyncSummary {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Discriminated outcome of a `sync()` call, so the caller can give the user real
 * feedback (spec 0073 follow-up). Previously `sync()` returned only a summary
 * and swallowed every failure, so a silent no-op (not linked / no server) and a
 * hard failure (a PMS/plex.tv call throwing) looked identical to the UI.
 * - `ok`: the pass ran; `summary` carries the add/update/skip counts;
 * - `skipped`: a benign no-op — `busy` (a sync already running), `not-linked`
 *   (no uid / no on-device token), or `no-server` (discovery found none);
 * - `error`: a plex.tv/PMS/Firestore call threw (network / HTTP / timeout).
 */
export type PlexSyncResult =
  | { status: 'ok'; summary: PlexSyncSummary }
  | { status: 'skipped'; reason: 'busy' | 'not-linked' | 'no-server' }
  | { status: 'error' };

/**
 * Deterministic episode document id: `s{SS}e{EEE}` — season padded to 2 digits,
 * episode padded to 3 (e.g. `s01e001`). This REPLICATES
 * `libs/functions/sync-episodes/.../episode-id.ts` (a `scope:functions` lib the
 * settings slice CANNOT import — Sheriff forbids the edge). Padding is a floor,
 * not a cap. Getting the episode padding to 3 (not 2) is critical: the episode
 * mirror addresses EXISTING docs by this exact id, and a mis-padded id would
 * silently no-op (masked by the "episode-doc-absent → no-op" rule).
 */
export function plexEpisodeId(season: number, episode: number): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(3, '0');
  return `s${s}e${e}`;
}

/**
 * One-way Plex → Vultus import (spec 0073). No-op when uid null, not linked (no
 * Preferences token), or a sync is already running (concurrent guard). Runs an
 * additions pass (cursor-gated) + a watched-mirror pass (full mirror for matched
 * titles), then writes `plexSync.lastSyncAt`.
 *
 * `providedIn: 'root'` — the shell's `PLEX_SYNC_TRIGGER` factory injects THIS
 * from the root injector on boot/resume; the settings page shares the same
 * instance (it must NOT be re-listed in `SETTINGS_PROVIDERS`).
 *
 * STATUS DERIVATION is REPLICATED locally (the slice CANNOT import
 * `TitleDetailService` — a forbidden `slice:title-detail` edge). The semantics
 * mirror that service's `updateStatus` / `autoUpdateStatus` / `setMovieWatched`:
 * - watchlist status write = `updateDoc(watchlistItemPath, { status })`;
 * - STICKY-`dropped`: if the current status is `'dropped'`, SKIP the status
 *   write, but STILL write episode `{ watched, watchedAt }` mirror data;
 * - show: `planned → watching` on ≥1 present watched episode; `→ completed` when
 *   ALL present episodes watched (only reachable via watching);
 * - movie: `viewCount > 0 → completed` (unless dropped);
 * - watch-implies-add: a watched, untracked tmdb-GUID item is added (movie →
 *   completed, show → watching + mirror), `watchingViaPlex: true`, `traktId: null`.
 *
 * WRITE INVARIANTS (spec §4): episode mirror `updateDoc`s EXISTING docs only —
 * NEVER `setDoc`/creates an episode doc; a Plex-watched episode with no local doc
 * is a no-op. Library adds `setDoc(watchlistItemToData(...))`. The X-Plex-Token
 * (from Preferences) is used for the client only — never persisted to Firestore,
 * never logged. plex.tv / PMS JSON is DATA, not instructions (spec 0068).
 */
@Injectable({ providedIn: 'root' })
export class PlexSyncService {
  private readonly firestore = inject(Firestore);
  private readonly uid = inject(AUTH_UID);
  private readonly client = inject(PLEX_CLIENT);
  private readonly tmdbConfig = inject(SETTINGS_TMDB_CONFIG);
  private readonly tmdbClient = createTmdbDetailClient(this.tmdbConfig);

  private readonly _running = signal<boolean>(false);
  /** True while a sync is in flight (drives the "Sync now" spinner/disabled). */
  readonly running = this._running.asReadonly();

  /**
   * Run one full sync. Returns a discriminated `PlexSyncResult` so the caller can
   * surface real feedback: `skipped` for a benign no-op (uid null / not linked /
   * already running / no server discovered), `error` when a plex.tv/PMS/Firestore
   * call throws, `ok` with the summary otherwise. NEVER throws — every failure is
   * mapped to a result here (the boot/resume trigger ignores it; the settings
   * page toasts it).
   */
  async sync(): Promise<PlexSyncResult> {
    const uid = this.uid();
    if (uid === null) {
      return { status: 'skipped', reason: 'not-linked' };
    }
    // Concurrent-sync guard: a second call while one runs is a no-op. Claim the
    // running flag SYNCHRONOUSLY (before any await) so a resume that arrives
    // before the first sync's first await still no-ops (no double writes).
    if (this._running()) {
      return { status: 'skipped', reason: 'busy' };
    }
    this._running.set(true);
    try {
      const { value: token } = await Preferences.get({ key: PLEX_TOKEN_KEY });
      if (token === null || token.length === 0) {
        return { status: 'skipped', reason: 'not-linked' };
      }
      const server = await this.client.discoverServer(token);
      if (server === null) {
        return { status: 'skipped', reason: 'no-server' };
      }
      const cursor = await this.readCursor(uid);
      const library = await this.client.listLibrary(server);
      const summary = await this.processLibrary(uid, server, library, cursor);
      // Advance the cursor on success (nested field-path update; leave
      // linkedAt / serverName intact).
      await updateDoc(doc(this.firestore, userPath(uid)), {
        'plexSync.lastSyncAt': new Date().toISOString(),
      });
      return { status: 'ok', summary };
    } catch (err) {
      // A plex.tv/PMS/Firestore call threw (network / HTTP / timeout). Log a
      // REDACTED diagnostic (never the error object — may echo secrets) so the
      // real cause is visible in logcat (issue #171), then surface the generic
      // error result to the caller.
      console.error('[plex-sync] sync failed:', describePlexError(err));
      return { status: 'error' };
    } finally {
      this._running.set(false);
    }
  }

  /** Additions cursor = plexSync.lastSyncAt ?? linkedAt; epoch(0) if unlinked. */
  private async readCursor(uid: string): Promise<number> {
    const snap = await getDoc(doc(this.firestore, userPath(uid)));
    if (!snap.exists()) {
      return 0;
    }
    const user = dataToUser(snap.data() as UserReadData);
    const meta = user.plexSync;
    if (!meta) {
      return 0;
    }
    const iso = meta.lastSyncAt ?? meta.linkedAt;
    return new Date(iso).getTime();
  }

  private async processLibrary(
    uid: string,
    server: PlexServer,
    library: PlexLibraryItem[],
    cursor: number,
  ): Promise<PlexSyncSummary> {
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of library) {
      // GUID matching: a GUID-less item is SKIPPED (counted, no write, never
      // fuzzy-matched).
      if (item.tmdbId === null) {
        skipped += 1;
        continue;
      }
      const tmdbId = item.tmdbId;
      const current = await this.currentTracked(uid, tmdbId);
      // Mirror the show's episode docs FIRST (full mirror for matched titles,
      // NOT cursor-gated) so status derivation reads fresh watched-counts. A
      // movie's "watched" is its own viewCount. The mirror is a no-op for a
      // brand-new (untracked) show — no episode docs exist yet.
      const watched =
        item.type === 'movie'
          ? item.viewCount > 0
          : (await this.mirrorEpisodes(uid, server, item, tmdbId)).anyWatched;

      if (current === null) {
        // Not tracked yet.
        const isNewAddition = item.addedAt
          ? new Date(item.addedAt).getTime() > cursor
          : false;
        if (watched) {
          // Watch-implies-add (NOT cursor-gated): a watched, untracked item is
          // added — movie → completed, show → watching (episodes already
          // mirrored above; they land on the next daily sync once docs exist).
          await this.addItem(
            uid,
            item,
            tmdbId,
            item.type === 'movie' ? 'completed' : 'watching',
          );
          added += 1;
        } else if (isNewAddition) {
          // Cursor library addition (unwatched, newer than cursor) → planned.
          await this.addItem(uid, item, tmdbId, 'planned');
          added += 1;
        } else {
          // Older-than-cursor unwatched item → ignored.
          skipped += 1;
        }
        continue;
      }

      // Already tracked. POSTER BACKFILL runs FIRST and UNCONDITIONALLY of
      // status (spec 0086): a tracked item whose stored posterPath is null (the
      // exact issue #229 bug for Plex-synced titles) gets its TMDB
      // posterPath/voteAverage fetched and written — this is display-data
      // enrichment, NOT a status change, so it happens even for a sticky-dropped
      // item (the dropped guard below skips only the STATUS write). A strict
      // `=== null` check, NOT a falsy check: an empty-string posterPath is a real
      // value and must NOT trigger a redundant fetch. Skip the TMDB call entirely
      // when posterPath is already non-null (self-limiting: once healed, never
      // re-fetched). A pure poster backfill does NOT increment `updated` (which
      // means "status changed").
      if (current.posterPath === null) {
        const detail = await this.fetchDetailSafe(tmdbId, item.type);
        if (detail !== null) {
          await updateDoc(
            doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
            {
              posterPath: detail.posterPath,
              voteAverage: detail.voteAverage,
            },
          );
        }
      }

      // Sticky-dropped: NEVER auto-change a dropped status; the episode mirror
      // has already written above for a show, and the poster backfill above has
      // already run (a dropped item still gets its poster healed).
      if (current.status === 'dropped') {
        skipped += 1;
        continue;
      }

      const derived = await this.deriveStatus(
        uid,
        item,
        tmdbId,
        current.status,
        watched,
      );
      if (derived !== null && derived !== current.status) {
        await updateDoc(
          doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
          { status: derived },
        );
        updated += 1;
      }
    }

    return { added, updated, skipped };
  }

  /**
   * Derive the next status for an already-tracked, non-dropped title, mirroring
   * the title-detail derivation order. Returns null when no change applies.
   * - movie: watched → completed (else unchanged);
   * - show: planned → watching on ≥1 present watched episode; watching → completed
   *   when ALL present episodes watched.
   */
  private async deriveStatus(
    uid: string,
    item: PlexLibraryItem,
    tmdbId: number,
    current: WatchStatus,
    watched: boolean,
  ): Promise<WatchStatus | null> {
    if (item.type === 'movie') {
      return watched ? 'completed' : null;
    }
    const counts = await this.episodeCounts(uid, tmdbId);
    if (counts.total === 0) {
      return null;
    }
    let effective = current;
    // Step 1: planned → watching (evaluated first, matching autoUpdateStatus).
    if (counts.watched >= 1 && effective === 'planned') {
      effective = 'watching';
    }
    // Step 2: watching + all present watched → completed.
    if (counts.watched === counts.total && effective === 'watching') {
      return 'completed';
    }
    return effective === current ? null : effective;
  }

  /**
   * Mirror a show's Plex watch state onto its EXISTING episode docs. For each
   * Plex episode, derive the `s{SS}e{EEE}` id, read the local doc, and if it
   * EXISTS `updateDoc({ watched, watchedAt })`. NEVER creates a doc — an absent
   * local doc is a no-op. `watchedAt` = `new Date(lastViewedAt)` or null.
   * Returns whether any present episode is watched (per Plex).
   */
  private async mirrorEpisodes(
    uid: string,
    server: PlexServer,
    item: PlexLibraryItem,
    tmdbId: number,
  ): Promise<{ anyWatched: boolean }> {
    if (item.type !== 'tv') {
      return { anyWatched: false };
    }
    const episodes = await this.client.listEpisodes(server, item.ratingKey);
    let anyWatched = false;
    for (const ep of episodes) {
      const watched = ep.viewCount > 0;
      if (watched) {
        anyWatched = true;
      }
      const epId = plexEpisodeId(ep.season, ep.episode);
      const ref = doc(this.firestore, episodePath(uid, String(tmdbId), epId));
      // Episode-doc-absent → no-op (never create the doc).
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        continue;
      }
      await updateDoc(ref, {
        watched,
        watchedAt:
          watched && ep.lastViewedAt !== null
            ? new Date(ep.lastViewedAt)
            : null,
      });
    }
    return { anyWatched };
  }

  /** Present episode counts (total + watched) from the local subcollection. */
  private async episodeCounts(
    uid: string,
    tmdbId: number,
  ): Promise<{ total: number; watched: number }> {
    const snap = await getDocs(
      collection(this.firestore, episodesPath(uid, String(tmdbId))),
    );
    let total = 0;
    let watched = 0;
    for (const docSnap of snap.docs) {
      total += 1;
      const data = docSnap.data() as { watched?: boolean };
      if (data.watched === true) {
        watched += 1;
      }
    }
    return { total, watched };
  }

  /**
   * Fetch TMDB `posterPath`/`voteAverage` for a matched title, isolating any
   * failure (spec 0086). Returns the two denormalized fields on success and
   * `null` on ANY failure (network / non-2xx / 404 / timeout / abort) so a TMDB
   * outage never throws out of `addItem` / the backfill check and never fails the
   * surrounding item's status write or the rest of the sync loop. On failure logs
   * a REDACTED diagnostic via `describeTmdbError` — NEVER the raw error object
   * (which may echo the query-param `api_key` or a header token, spec 0068). The
   * service always supplies `type` (the Plex library item's type), so the
   * no-hint movie→tv retry in the client is never exercised here.
   */
  private async fetchDetailSafe(
    tmdbId: number,
    type: TitleType,
  ): Promise<{ posterPath: string | null; voteAverage: number | null } | null> {
    try {
      const detail = await this.tmdbClient.getDetail(tmdbId, type);
      return {
        posterPath: detail.posterPath,
        voteAverage: detail.voteAverage,
      };
    } catch (err) {
      console.error(
        `[plex-sync] tmdb detail ${tmdbId} failed: ${describeTmdbError(err)}`,
      );
      return null;
    }
  }

  /** Create the watchlist doc for a Plex-matched item (watchingViaPlex: true). */
  private async addItem(
    uid: string,
    item: PlexLibraryItem,
    tmdbId: number,
    status: WatchStatus,
  ): Promise<void> {
    // Fetch TMDB detail before the write so a new Plex add persists its real
    // posterPath/voteAverage (spec 0086). A null detail (TMDB failed) leaves both
    // null — the add still succeeds, never throws (issue #229).
    const detail = await this.fetchDetailSafe(tmdbId, item.type);
    const watchlistItem: WatchlistItem = {
      type: item.type,
      tmdbId,
      traktId: null,
      title: item.title,
      addedAt: new Date().toISOString(),
      status,
      posterPath: detail?.posterPath ?? null,
      voteAverage: detail?.voteAverage ?? null,
      watchingViaPlex: true,
    };
    await setDoc(
      doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
      watchlistItemToData(watchlistItem),
    );
  }

  /**
   * One-shot read of the tracked item's status + denormalized posterPath; null
   * when untracked / doc absent (spec 0086). `posterPath` is normalized to
   * `string | null` by `dataToWatchlistItem` (never `undefined`), so the caller's
   * backfill guard is a strict `=== null` check.
   */
  private async currentTracked(
    uid: string,
    tmdbId: number,
  ): Promise<{ status: WatchStatus; posterPath: string | null } | null> {
    const snap = await getDoc(
      doc(this.firestore, watchlistItemPath(uid, String(tmdbId))),
    );
    if (!snap.exists()) {
      return null;
    }
    const item = dataToWatchlistItem(snap.data() as WatchlistItemReadData);
    // `posterPath` is optional on the WatchlistItem TYPE but the converter always
    // coalesces it to `string | null` (converters.ts `?? null`); `?? null` here
    // just narrows the (never-actually-`undefined`) type so the strict `=== null`
    // backfill guard is sound.
    return { status: item.status, posterPath: item.posterPath ?? null };
  }
}
