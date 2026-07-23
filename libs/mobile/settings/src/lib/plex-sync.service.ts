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
  Episode,
  EpisodeDoc,
  PlexEpisodeItem,
  PlexLibraryItem,
  PlexServer,
  PlexUnmatchedTitle,
  TitleType,
  WatchStatus,
  WatchlistItem,
} from '@vultus/shared/domain';
import {
  dataToUser,
  dataToWatchlistItem,
  episodePath,
  episodesPath,
  episodeToData,
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

/** Small per-sync outcome summary (logging + the mock e2e assertions).
 *  `unmatched` (spec 0097) = titles this pass could NOT resolve to a TMDB id (no
 *  GUID at all, an unresolvable tvdb/imdb GUID, or a per-item error); `skipped`
 *  keeps its 0073/0086 meaning (old-cursor unwatched + sticky-dropped). */
export interface PlexSyncSummary {
  added: number;
  updated: number;
  skipped: number;
  unmatched: number;
}

/** Result of resolving a Plex item to a TMDB id (spec 0097): the id when found,
 *  else a classification for the unmatched list. */
type ItemResolution =
  | { tmdbId: number }
  | { tmdbId: null; reason: PlexUnmatchedTitle['reason'] };

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
 * - watch-implies-add: a watched, untracked tmdb-GUID item is added + mirrored
 *   (movie → completed; show → the DERIVED status: completed when all present
 *   episode docs are watched, else watching), `watchingViaPlex: true`,
 *   `traktId: null`.
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
      const { summary, unmatched } = await this.processLibrary(
        uid,
        server,
        library,
        cursor,
      );
      // Advance the cursor on completion (nested field-path update; leave
      // linkedAt / serverName intact) AND persist this pass's unmatched titles
      // (spec 0097): capped at 50, REPLACED wholesale each pass, [] when the pass
      // matched everything (which clears the Settings "couldn't match" list).
      await updateDoc(doc(this.firestore, userPath(uid)), {
        'plexSync.lastSyncAt': new Date().toISOString(),
        'plexSync.unmatched': unmatched.slice(0, 50),
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
  ): Promise<{ summary: PlexSyncSummary; unmatched: PlexUnmatchedTitle[] }> {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const unmatched: PlexUnmatchedTitle[] = [];

    for (const item of library) {
      // Per-item error isolation (spec 0097): a single failing item (e.g. a
      // listEpisodes 404, a TMDB episode fetch or Firestore write throwing) must
      // NOT abort the rest of the pass. It is recorded reason 'error' and the
      // loop continues so the cursor still advances and later items still
      // process. The spec 0098 on-device episode-doc creation + mirror runs
      // INSIDE this try, so a TMDB/episode-fetch failure for one show is isolated
      // to that show (spec 0098 decision 6, reinforcing 0097's per-item guard).
      try {
        // Resolve a TMDB id: the item's tmdb:// GUID, else the tvdb/imdb /find
        // external-id fallback. An unresolved item is recorded (with a reason)
        // and skipped — never fuzzy-matched (0073's no-fuzzy rule stands).
        const resolution = await this.resolveTmdbId(item);
        if (resolution.tmdbId === null) {
          unmatched.push({ title: item.title, reason: resolution.reason });
          continue;
        }
        const tmdbId = resolution.tmdbId;
        const current = await this.currentTracked(uid, tmdbId);
        // For a tv item, fetch the Plex episode list ONCE, then in the SAME pass:
        // (1) create any MISSING episode docs on-device from TMDB (insert-only,
        // gap-guarded — spec 0098 / issue #255), so (2) the watched-mirror can
        // mark them immediately instead of waiting for the server's async episode
        // trigger/cron. Status derivation then reads fresh watched-counts. A
        // movie's "watched" is its own viewCount (no episode subcollection).
        let watched: boolean;
        if (item.type === 'movie') {
          watched = item.viewCount > 0;
        } else {
          const plexEpisodes = await this.listPlexEpisodes(server, item);
          await this.ensureEpisodeDocsSafe(uid, tmdbId, plexEpisodes);
          watched = (
            await this.mirrorEpisodes(uid, server, item, tmdbId, plexEpisodes)
          ).anyWatched;
        }

        if (current === null) {
          // Not tracked yet. A MISSING addedAt is treated as "new" (spec 0097):
          // a data gap is not evidence the item is old, and erring toward
          // inclusion matches the bug's intent (do not silently drop).
          const isNewAddition =
            item.addedAt === null
              ? true
              : new Date(item.addedAt).getTime() > cursor;
          if (watched) {
            // Watch-implies-add (NOT cursor-gated): a watched, untracked item is
            // added. Movie → completed. TV → the DERIVED status from the existing
            // completion predicate: 'completed' iff every present episode doc is
            // watched (total > 0 && watched === total), else 'watching'. Episode
            // docs are already created on-device + mirrored above in this same
            // pass (spec 0098), so the counts are fresh — this removes the
            // two-sync latency where a fully-watched ended show landed at
            // 'watching' on the first sync and only healed on a later sync (issue
            // #277). A show with any unwatched (incl. scheduled/future) episode
            // doc keeps watched < total → stays 'watching'.
            let status: WatchStatus;
            if (item.type === 'movie') {
              status = 'completed';
            } else {
              const counts = await this.episodeCounts(uid, tmdbId);
              status =
                counts.total > 0 && counts.watched === counts.total
                  ? 'completed'
                  : 'watching';
            }
            await this.addItem(uid, item, tmdbId, status);
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
      } catch (err) {
        // A plex.tv/PMS/Firestore call threw for THIS item. Log a REDACTED
        // diagnostic (never the raw error — may echo secrets, spec 0068) and
        // record it as reason 'error' so the pass continues (per-item isolation).
        console.error(
          `[plex-sync] item "${item.title}" failed: ${describePlexError(err)}`,
        );
        unmatched.push({ title: item.title, reason: 'error' });
      }
    }

    return {
      summary: { added, updated, skipped, unmatched: unmatched.length },
      unmatched,
    };
  }

  /**
   * Resolve a Plex item to a TMDB id (spec 0097). Order: the item's tmdb:// GUID
   * first; else the tvdb:// GUID (shows only — tvdb is show-only) via TMDB /find;
   * else the imdb:// GUID via /find. Returns the id when found, else a reason:
   * - 'no-guid': no tmdb/tvdb/imdb id at all → nothing to resolve;
   * - 'guid-unresolved': had a tvdb/imdb id but /find returned no matching-media-
   *   type result — INCLUDING a movie whose only external id is a tvdb id (never
   *   sent to /find, since tvdb is show-only), classified deliberately here;
   * - 'error': a /find call threw (network / HTTP / timeout), via
   *   `findExternalIdSafe`.
   */
  private async resolveTmdbId(item: PlexLibraryItem): Promise<ItemResolution> {
    if (item.tmdbId !== null) {
      return { tmdbId: item.tmdbId };
    }
    const tvdbId = item.tvdbId ?? null;
    const imdbId = item.imdbId ?? null;
    if (tvdbId === null && imdbId === null) {
      return { tmdbId: null, reason: 'no-guid' };
    }
    // tvdb is show-only: use it only for shows, preferred over imdb.
    if (item.type === 'tv' && tvdbId !== null) {
      const found = await this.findExternalIdSafe(
        String(tvdbId),
        'tvdb_id',
        'tv',
      );
      if (found.status === 'error') {
        return { tmdbId: null, reason: 'error' };
      }
      if (found.id !== null) {
        return { tmdbId: found.id };
      }
    }
    if (imdbId !== null) {
      const found = await this.findExternalIdSafe(imdbId, 'imdb_id', item.type);
      if (found.status === 'error') {
        return { tmdbId: null, reason: 'error' };
      }
      if (found.id !== null) {
        return { tmdbId: found.id };
      }
    }
    // Had a tvdb/imdb id but nothing resolved to a matching-type TMDB result.
    return { tmdbId: null, reason: 'guid-unresolved' };
  }

  /**
   * Wrap `findByExternalId` mirroring `fetchDetailSafe`: a thrown /find call is
   * caught and reported as `{ status: 'error' }` (→ reason 'error'), distinct
   * from a successful call returning `null` (→ 'guid-unresolved'). Logs a REDACTED
   * diagnostic via `describeTmdbError` — NEVER the raw error (may echo the
   * `api_key` query param or a header token, spec 0068).
   */
  private async findExternalIdSafe(
    externalId: string,
    source: 'tvdb_id' | 'imdb_id',
    type: TitleType,
  ): Promise<{ status: 'ok'; id: number | null } | { status: 'error' }> {
    try {
      const id = await this.tmdbClient.findByExternalId(
        externalId,
        source,
        type,
      );
      return { status: 'ok', id };
    } catch (err) {
      console.error(
        `[plex-sync] tmdb find ${source} ${externalId} failed: ${describeTmdbError(err)}`,
      );
      return { status: 'error' };
    }
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
   * Fetch a tv item's Plex episode list ONCE (single PMS call) so both the
   * on-device ensure-step (`ensureEpisodeDocs`) and the watched-mirror
   * (`mirrorEpisodes`) consume the SAME list without double-calling the PMS. A
   * non-tv item has no episodes.
   */
  private async listPlexEpisodes(
    server: PlexServer,
    item: PlexLibraryItem,
  ): Promise<PlexEpisodeItem[]> {
    if (item.type !== 'tv') {
      return [];
    }
    return this.client.listEpisodes(server, item.ratingKey);
  }

  /**
   * Create the episode docs a Plex-imported show is MISSING, on-device, from
   * TMDB — so the watched-mirror can mark them in the SAME sync pass instead of
   * waiting for the server's async episode trigger/cron (issue #255, spec 0098).
   *
   * This DELIBERATELY RELAXES the app-wide "episode docs are created only by
   * Cloud Functions" invariant (specs 0034/0050/0053) for the Plex path ONLY.
   * Safety: it uses the SAME TMDB source, the SAME `episodeToData` converter, and
   * the SAME `s{SS}e{EEE}` id scheme as the functions, so the docs it writes are
   * byte-for-byte what the functions would write; it is INSERT-ONLY (skips ids
   * that already have a local doc, never overwrites a doc's `watched`/
   * `watchedAt`); it is therefore idempotent + race-safe with the server's
   * insert-only on-create trigger / daily cron (whichever writes a given id
   * first, the other's existing-id filter skips it).
   *
   * GAP-GUARD (self-limiting, decision 5): it reaches for TMDB ONLY when a
   * WATCHED Plex episode (`viewCount > 0`) has no local doc. A show whose watched
   * episodes already have docs is never re-fetched — no per-show TMDB
   * episode-list fetch on every sync.
   *
   * It does NOT write watched state — inserts start `watched: false`, and the
   * existing `mirrorEpisodes` flips them to `watched: true` in the same pass.
   * Keeping the insert-only-creation vs mirror-update separation is exactly what
   * the idempotency / race-safety argument (decision 2) rests on — do NOT
   * collapse it by writing the watched state here.
   */
  private async ensureEpisodeDocs(
    uid: string,
    tmdbId: number,
    plexEpisodes: PlexEpisodeItem[],
  ): Promise<void> {
    // Existing episode-id set — drives both the gap-guard and the insert-only
    // diff (a one-shot subcollection read; no query, no index).
    const existing = await getDocs(
      collection(this.firestore, episodesPath(uid, String(tmdbId))),
    );
    const existingIds = new Set<string>(existing.docs.map((d) => d.id));
    // Gap-guard: only fetch TMDB when a WATCHED Plex episode lacks a local doc.
    const hasGap = plexEpisodes.some(
      (ep) =>
        ep.viewCount > 0 &&
        !existingIds.has(plexEpisodeId(ep.season, ep.episode)),
    );
    if (!hasGap) {
      return;
    }
    // On a gap: replicate the functions' episode-sync — season count, then the
    // full episode set season 1..count (a null count / null season = nothing to
    // create). null-air_date episodes are already skipped by the client's mapper.
    const seasonCount = await this.tmdbClient.getTvSeasonCount(tmdbId);
    if (seasonCount === null) {
      return;
    }
    const episodes: Episode[] = [];
    for (let season = 1; season <= seasonCount; season += 1) {
      const seasonEpisodes = await this.tmdbClient.getSeasonEpisodes(
        tmdbId,
        season,
      );
      if (seasonEpisodes === null) {
        continue;
      }
      episodes.push(...seasonEpisodes);
    }
    // Insert-only: write ONLY ids not already present, each a fresh
    // `watched: false` doc (the mirror flips watched next), via the SAME
    // converter chain the functions use so the persisted doc is identical.
    for (const ep of episodes) {
      const epId = plexEpisodeId(ep.season, ep.episode);
      if (existingIds.has(epId)) {
        continue;
      }
      const episodeDoc: EpisodeDoc = {
        season: ep.season,
        episode: ep.episode,
        title: ep.title,
        airDate: ep.airDate,
        watched: false,
        watchedAt: null,
      };
      await setDoc(
        doc(this.firestore, episodePath(uid, String(tmdbId), epId)),
        episodeToData(episodeDoc),
      );
    }
  }

  /**
   * Wrap `ensureEpisodeDocs` so a TMDB/Firestore failure during on-device
   * episode creation is isolated (mirrors `fetchDetailSafe`, spec 0086): on ANY
   * failure (network / non-404 non-2xx / timeout / abort / Firestore) log a
   * REDACTED diagnostic via `describeTmdbError` — NEVER the raw error object
   * (which may echo the query-param `api_key`, spec 0068) — and return without
   * throwing, so a TMDB outage never fails the mirror, the status write, or the
   * rest of the sync loop.
   */
  private async ensureEpisodeDocsSafe(
    uid: string,
    tmdbId: number,
    plexEpisodes: PlexEpisodeItem[],
  ): Promise<void> {
    try {
      await this.ensureEpisodeDocs(uid, tmdbId, plexEpisodes);
    } catch (err) {
      console.error(
        `[plex-sync] ensure episodes ${tmdbId} failed: ${describeTmdbError(err)}`,
      );
    }
  }

  /**
   * Mirror a show's Plex watch state onto its (now-existing) episode docs. For
   * each Plex episode, derive the `s{SS}e{EEE}` id, read the local doc, and if it
   * EXISTS `updateDoc({ watched, watchedAt })`. NEVER creates a doc — an absent
   * local doc is a no-op (creation is `ensureEpisodeDocs`' job, run just before
   * this in the same pass). `watchedAt` = `new Date(lastViewedAt)` or null.
   * Takes the already-fetched `plexEpisodes` (fetched once by `listPlexEpisodes`)
   * so the PMS is not double-called. Returns whether any present episode is
   * watched (per Plex).
   */
  private async mirrorEpisodes(
    uid: string,
    server: PlexServer,
    item: PlexLibraryItem,
    tmdbId: number,
    plexEpisodes: PlexEpisodeItem[],
  ): Promise<{ anyWatched: boolean }> {
    if (item.type !== 'tv') {
      return { anyWatched: false };
    }
    let anyWatched = false;
    for (const ep of plexEpisodes) {
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
