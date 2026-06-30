/**
 * Episode-sync wiring (spec 0047). This file is the ONLY place where the Admin
 * SDK + the sync-titles `TmdbClient` enter the episode-sync flow: it implements
 * the `@vultus/functions/sync-episodes` ports against firebase-admin Firestore
 * and the TMDB client, and exposes the on-add trigger (entry point A). The
 * daily-sync extension (entry point B) reuses these adapters from `main.ts`.
 *
 * The engine itself stays Firebase-free and never imports `slice:sync-titles`.
 */
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { createTmdbClient } from '@vultus/functions/sync-titles';
import type { TmdbClient } from '@vultus/functions/sync-titles';
import {
  createEpisodeSyncEngine,
  type EpisodeStore,
  type EpisodeSyncEngine,
  type TmdbEpisodeSource,
  type WatchlistTvShow,
  type WatchlistTvSource,
} from '@vultus/functions/sync-episodes';
import {
  episodePath,
  episodesPath,
  episodeToData,
} from '@vultus/shared/firestore-schema';

// `TMDB_READ_TOKEN` is a singleton-by-name param: declaring it here with the
// same name as in `main.ts` references the SAME secret (Firebase de-dupes by
// name). The on-add trigger binds it so the runtime injects it.
const TMDB_READ_TOKEN = defineSecret('TMDB_READ_TOKEN');

function ensureAdminForEpisodes(): Firestore {
  if (getApps().length === 0) initializeApp();
  return getFirestore();
}

// --- Admin-SDK port adapters --------------------------------------------

/** Bridges the sync-titles `TmdbClient` to the episode engine's read-only
 *  `TmdbEpisodeSource` port. The SDK-free engine never sees the TmdbClient. */
export function createTmdbEpisodeSourceAdapter(
  tmdb: TmdbClient,
): TmdbEpisodeSource {
  return {
    getSeasonCount: (tmdbId) => tmdb.getTvSeasonCount(tmdbId),
    getSeasonEpisodes: (tmdbId, seasonNumber) =>
      tmdb.getSeasonEpisodes(tmdbId, seasonNumber),
  };
}

/**
 * Insert-only episode store over `users/{uid}/watchlist/{titleId}/episodes`.
 * Reads existing doc ids for the engine's diff, then writes ONLY the new docs
 * the engine hands back (batched at the Firestore 500-op limit). Existing docs
 * are never targeted, so a user's `watched`/`watchedAt` state is untouched.
 *
 * Named `createEpisodeUpsertStore` — distinct from the read-only
 * `createFirestoreEpisodeStore` in `dispatch/adapters.ts` (notification flow).
 */
export function createEpisodeUpsertStore(db: Firestore): EpisodeStore {
  const BATCH_SIZE = 500;
  return {
    async getExistingEpisodeIds(uid, titleId): Promise<Set<string>> {
      const snap = await db.collection(episodesPath(uid, titleId)).get();
      return new Set(snap.docs.map((d) => d.id));
    },
    async writeEpisodes(uid, titleId, docs): Promise<void> {
      if (docs.length === 0) return;
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const chunk = docs.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        for (const { id, doc } of chunk) {
          batch.set(db.doc(episodePath(uid, titleId, id)), episodeToData(doc));
        }
        await batch.commit();
      }
    },
  };
}

/** Lists every TV show across all users' watchlists for the daily pass (entry
 *  point B). Not deduped by `tmdbId` — one entry per (uid, titleId). */
export function createWatchlistTvSourceAdapter(
  db: Firestore,
): WatchlistTvSource {
  return {
    async listAllTvShows(): Promise<WatchlistTvShow[]> {
      const snap = await db.collectionGroup('watchlist').get();
      const shows: WatchlistTvShow[] = [];
      for (const doc of snap.docs) {
        const data = doc.data() as { type?: string; tmdbId?: number };
        if (data.type !== 'tv' || data.tmdbId == null) continue;
        const parent = doc.ref.parent.parent;
        if (!parent) continue;
        shows.push({
          uid: parent.id,
          titleId: doc.ref.id,
          tmdbId: data.tmdbId,
        });
      }
      return shows;
    },
  };
}

// --- Entry point A: on-add trigger --------------------------------------

/** The minimal created-doc event shape the core consumes — satisfied by the
 *  real `onDocumentCreated` event and by test fakes. */
export interface WatchlistCreateEvent {
  params: { uid: string; titleId: string };
  data?: {
    data(): Record<string, unknown> | undefined;
  };
}

/**
 * Core of the on-add trigger, engine-injected so it is unit-testable without
 * the SDK, network, or secrets. No-ops on a movie (no episodes) or a malformed
 * doc; otherwise upserts the show's episodes (insert-only via the engine diff).
 */
export async function handleWatchlistCreate(
  event: WatchlistCreateEvent,
  engine: EpisodeSyncEngine,
): Promise<void> {
  const data = event.data?.data() as
    | { type?: string; tmdbId?: number }
    | undefined;
  if (data?.type !== 'tv' || data?.tmdbId == null) return;

  const { uid, titleId } = event.params;
  const tmdbId = data.tmdbId;
  const result = await engine.syncOne(uid, titleId, tmdbId);
  logger.info('[syncWatchlistEpisodes] episode sync complete', result);
}

/**
 * Backfills episodes when a TV title is added to a watchlist. Wires the real
 * Admin SDK + TMDB client into `handleWatchlistCreate`. Best-effort.
 */
export const syncWatchlistEpisodes = onDocumentCreated(
  { document: 'users/{uid}/watchlist/{titleId}', secrets: [TMDB_READ_TOKEN] },
  async (event) => {
    const db = ensureAdminForEpisodes();
    const engine = createEpisodeSyncEngine({
      tmdb: createTmdbEpisodeSourceAdapter(
        createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
      ),
      episodes: createEpisodeUpsertStore(db),
    });
    const snap = event.data;
    await handleWatchlistCreate(
      {
        params: event.params,
        data: snap ? { data: () => snap.data() } : undefined,
      },
      engine,
    );
  },
);
