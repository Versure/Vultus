/**
 * Firebase Cloud Functions entry point for Vultus.
 *
 * This file is the deployable barrel: every exported symbol becomes a Cloud
 * Function. It exposes the single HTTPS `syncTitles` function (spec 0009) that
 * wraps the spec-0008 sync engine: it authenticates the caller (cron shared
 * secret OR Firebase ID token), rate-limits the user path, gathers + dedupes the
 * global union of tracked titles, applies the staleness window, runs one sync
 * pass, and returns a JSON summary.
 *
 * The Firebase Admin SDK + `firebase-functions/params` enter ONLY at the
 * `onRequest` wiring below; the core flow (`runSync`) is a pure-ish function
 * driven by injected dependencies so it can be unit-tested without the SDK,
 * network, or secrets.
 */
import { logger, setGlobalOptions } from 'firebase-functions';
import { onRequest, onCall, HttpsError } from 'firebase-functions/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  createSyncEngine,
  createTmdbClient,
  createTraktClient,
  createFirestoreTitleCacheStore,
  gatherUserWatchlistTitles,
} from '@vultus/functions/sync-titles';
import type {
  GatheredUserTitle,
  SyncEngine,
  SyncResult,
  SyncTitleInput,
  TmdbClient,
} from '@vultus/functions/sync-titles';
import { REGIONS } from '@vultus/shared/domain';
import type { CatalogProvider, Region } from '@vultus/shared/domain';
import {
  providerCatalogDocPath,
  providerCatalogToData,
  dataToProviderCatalog,
} from '@vultus/shared/firestore-schema';
import type { ProviderCatalogReadData } from '@vultus/shared/firestore-schema';
import { createEpisodeSyncEngine } from '@vultus/functions/sync-episodes';
import type { EpisodeSyncEngine } from '@vultus/functions/sync-episodes';
import {
  createTmdbEpisodeSourceAdapter,
  createEpisodeUpsertStore,
  createWatchlistTvSourceAdapter,
} from './sync-episodes';
import { classifyAuth } from './lib/auth';
import type { VerifyToken } from './lib/auth';
import { dedupeTitles } from './lib/gather';
import type { GatheredTitle } from './lib/gather';
import { filterStale } from './lib/staleness';
import { isRateLimited } from './lib/rate-limit';
import {
  gatherWatchlistTitles,
  readSyncState,
  writeSyncState,
  writeSyncRun,
  verifyIdToken,
} from './lib/firestore-io';

// Keep deployments in a single region (free-tier friendly, PLAN §2).
setGlobalOptions({ region: 'europe-west1', maxInstances: 1 });

// --- Config / secrets (declared by NAME only; values read via .value() inside
// the handler, never at module load, never from .env.local, never logged). ---
const SYNC_SHARED_SECRET = defineSecret('SYNC_SHARED_SECRET');
const TMDB_READ_TOKEN = defineSecret('TMDB_READ_TOKEN');
const TRAKT_CLIENT_ID = defineString('TRAKT_CLIENT_ID');

/** User-path rate-limit window: reject a second user run within 5 minutes. */
export const RATE_LIMIT_MS = 5 * 60 * 1000;
/** Staleness window (~20h): skip a title synced more recently, unless forced. */
export const STALENESS_WINDOW_MS = 20 * 60 * 60 * 1000;

/** The JSON summary returned on a 200. Never includes a secret, token, or raw
 *  per-title reason — aggregate counts only. */
export interface SyncRunResponse {
  ok: true;
  trigger: 'cron' | 'user';
  gathered: number; // distinct titles before the staleness filter
  synced: number; // engine results with outcome 'synced'
  skipped: number; // staleness-skipped + engine 'skipped'
  errored: number; // engine results with outcome 'error'
  forced: boolean;
  durationMs: number;
}

/** Dependencies injected into `runSync`, so tests drive it with fakes. */
export interface RunSyncDeps {
  db: Firestore;
  /** Builds the credentialed engine for the gathered store. Injected so the
   *  handler test can supply a fake engine without the real clients. */
  createEngine: (db: Firestore) => SyncEngine;
  /** Verifies a Firebase ID token (Admin SDK in production). */
  verifyToken: VerifyToken;
  /** The shared secret value (`SYNC_SHARED_SECRET.value()`). */
  secret: string;
  /** Clock in epoch ms; injected for deterministic tests. */
  now: () => number;
  rateLimitMs: number;
  stalenessWindowMs: number;
  /** Factory for the episode sync engine (best-effort daily pass, entry point B).
   *  Optional — omit to skip the episode pass (existing tests remain green). */
  createEpisodeEngine?: (db: Firestore) => EpisodeSyncEngine;
}

/** A minimal view of the request `runSync` needs — satisfied by the real
 *  `firebase-functions` Request and by test fakes. */
export interface SyncRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The result of `runSync`: an HTTP status + a JSON body to send. */
export interface RunSyncOutput {
  status: number;
  body: unknown;
}

function parseForce(body: unknown): boolean {
  if (body && typeof body === 'object' && 'force' in body) {
    return (body as { force?: unknown }).force === true;
  }
  return false;
}

/**
 * Core sync flow, SDK-agnostic via injected deps. Returns the status + body the
 * caller should send. Best-effort: per-title engine errors still yield 200.
 */
export async function runSync(
  deps: RunSyncDeps,
  req: SyncRequest,
): Promise<RunSyncOutput> {
  const start = deps.now();

  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }

  const auth = await classifyAuth(req.headers, deps.secret, deps.verifyToken);
  if (auth.kind === 'unauthenticated') {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  if (auth.kind === 'forbidden') {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const trigger: 'cron' | 'user' = auth.kind;
  // `force` is honored only on the privileged cron path; ignored for users.
  const forced = trigger === 'cron' && parseForce(req.body);

  // Rate limit applies to the user path only; cron bypasses it.
  if (trigger === 'user') {
    const { lastRunAt } = await readSyncState(deps.db);
    if (isRateLimited(lastRunAt, start, deps.rateLimitMs)) {
      const retryAfterMs =
        lastRunAt === null ? 0 : deps.rateLimitMs - (start - lastRunAt);
      return {
        status: 429,
        body: { error: 'rate_limited', retryAfterMs },
      };
    }
  }

  // Gather the global union and dedupe to distinct titles.
  const gatheredRaw = await gatherWatchlistTitles(deps.db);
  const distinct = dedupeTitles(gatheredRaw);
  const gathered = distinct.length;

  // Build the engine (also gives us the store for the staleness reads).
  const engine = deps.createEngine(deps.db);
  const store = createFirestoreTitleCacheStore(deps.db);

  // Apply the staleness window unless forced.
  let toSync: GatheredTitle[];
  if (forced) {
    toSync = distinct;
  } else {
    const lastSyncedByTmdbId = new Map<number, string | null>();
    await Promise.all(
      distinct.map(async (title) => {
        const entry = await store.getEntry(title.tmdbId);
        lastSyncedByTmdbId.set(title.tmdbId, entry?.lastSyncedAt ?? null);
      }),
    );
    toSync = filterStale(
      distinct,
      lastSyncedByTmdbId,
      start,
      deps.stalenessWindowMs,
      false,
    );
  }

  const stalenessSkipped = gathered - toSync.length;
  const inputs: SyncTitleInput[] = toSync.map((t) => ({
    tmdbId: t.tmdbId,
    type: t.type,
  }));

  const results: SyncResult[] = await engine.sync(inputs);

  const synced = results.filter((r) => r.outcome === 'synced').length;
  const engineSkipped = results.filter((r) => r.outcome === 'skipped').length;
  const errored = results.filter((r) => r.outcome === 'error').length;

  // Episode sync pass (entry point B) — best-effort. `syncAll()` isolates
  // per-show errors, but watchlist enumeration (and engine construction) run
  // before that loop and can reject on a transient Firestore error; a wrapping
  // try/catch keeps the title-cache result, sync-state persistence, and the
  // returned SyncRunResponse unaffected by any episode-pass failure (R9 / DoD e).
  if (deps.createEpisodeEngine) {
    try {
      const episodeEngine = deps.createEpisodeEngine(deps.db);
      const episodeResults = await episodeEngine.syncAll();
      const episodesSynced = episodeResults.filter(
        (r) => r.outcome === 'synced',
      ).length;
      const episodesErrored = episodeResults.filter(
        (r) => r.outcome === 'error',
      ).length;
      logger.info('episode sync pass complete', {
        episodesSynced,
        episodesErrored,
      });
    } catch (err) {
      logger.error('episode sync pass failed (best-effort, continuing)', err);
    }
  }

  const end = deps.now();
  await writeSyncState(deps.db, end, start);

  // Best-effort sync-run record (observability only). A write failure is logged
  // and NEVER alters or fails the run — the sync already succeeded above. The
  // SyncRunResponse below is byte-for-byte unchanged regardless of this write.
  const errors = results
    .filter((r) => r.outcome === 'error')
    .map((r) => r.reason)
    .filter((s): s is string => !!s)
    .slice(0, 10);
  try {
    await writeSyncRun(deps.db, {
      kind: 'cron',
      userId: null,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(end).toISOString(),
      durationMs: end - start,
      titlesGathered: gathered,
      titlesUpdated: synced,
      errorCount: errored,
      errors,
    });
  } catch (err) {
    logger.error('[syncRun] failed to record run', err);
  }

  const response: SyncRunResponse = {
    ok: true,
    trigger,
    gathered,
    synced,
    skipped: stalenessSkipped + engineSkipped,
    errored,
    forced,
    durationMs: end - start,
  };
  logger.info('syncTitles run complete', {
    trigger,
    gathered,
    synced,
    skipped: response.skipped,
    errored,
    forced,
    durationMs: response.durationMs,
  });
  return { status: 200, body: response };
}

let adminInitialized = false;
function ensureAdmin(): Firestore {
  if (!adminInitialized && getApps().length === 0) {
    initializeApp();
  }
  adminInitialized = true;
  return getFirestore();
}

/**
 * The deployable HTTPS sync function. Binds the secrets it reads (`secrets: [...]`)
 * so the runtime injects them, wires the real Admin SDK + credentialed clients
 * into `runSync`, and sends its status + JSON body.
 */
export const syncTitles = onRequest(
  { secrets: [SYNC_SHARED_SECRET, TMDB_READ_TOKEN] },
  async (req, res) => {
    const db = ensureAdmin();
    const createEngine = (firestore: Firestore): SyncEngine =>
      createSyncEngine({
        tmdb: createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
        trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),
        store: createFirestoreTitleCacheStore(firestore),
      });

    const output = await runSync(
      {
        db,
        createEngine,
        createEpisodeEngine: (firestore: Firestore): EpisodeSyncEngine =>
          createEpisodeSyncEngine({
            tmdb: createTmdbEpisodeSourceAdapter(
              createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
            ),
            episodes: createEpisodeUpsertStore(firestore),
            watchlist: createWatchlistTvSourceAdapter(firestore),
          }),
        verifyToken: verifyIdToken,
        secret: SYNC_SHARED_SECRET.value(),
        now: () => Date.now(),
        rateLimitMs: RATE_LIMIT_MS,
        stalenessWindowMs: STALENESS_WINDOW_MS,
      },
      { method: req.method, headers: req.headers, body: req.body },
    );

    res.status(output.status).json(output.body);
  },
);

/** The response the manual `triggerSync` callable resolves with (spec 0025). */
export interface TriggerSyncResponse {
  /** ISO 8601 timestamp of when the manual sync pass completed. */
  syncedAt: string;
}

/** Dependencies injected into `runTriggerSync`, so tests drive it with fakes. */
export interface RunTriggerSyncDeps {
  db: Firestore;
  /** Builds the credentialed engine for the gathered store. Injected so the
   *  handler test can supply a fake engine without the real clients. */
  createEngine: (db: Firestore) => SyncEngine;
  /** Clock in epoch ms; injected for deterministic `startedAt`/`durationMs`
   *  tests (mirrors `RunSyncDeps.now`). Defaults to `Date.now()`. */
  now?: () => number;
}

/**
 * Core manual-sync flow, SDK-agnostic via injected deps. Validates the caller's
 * identity (`uid` must be present), gathers ONLY that user's watchlist titles
 * (deduped to `{ tmdbId, type }`), runs ONE force-fresh engine pass (no staleness
 * filter — manual = always refresh), and resolves `{ syncedAt }`. Best-effort:
 * per-title engine errors do NOT fail the callable (spec 0008 isolation). Writes
 * ONLY `title-cache/**` via the engine port — no `users/**`, no `system/sync`.
 */
export async function runTriggerSync(
  deps: RunTriggerSyncDeps,
  uid: string | undefined,
): Promise<TriggerSyncResponse> {
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required');
  }

  const start = deps.now?.() ?? Date.now();

  let rawTitles: GatheredUserTitle[];
  try {
    rawTitles = await gatherUserWatchlistTitles(deps.db, uid);
  } catch (err) {
    logger.error('[triggerSync] gather failed', err);
    throw new HttpsError('internal', 'Failed to read watchlist');
  }

  const inputs: SyncTitleInput[] = rawTitles.map((t) => ({
    tmdbId: t.tmdbId,
    type: t.type,
  }));
  const engine = deps.createEngine(deps.db);
  const results: SyncResult[] = await engine.sync(inputs);

  const synced = results.filter((r) => r.outcome === 'synced').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const errored = results.filter((r) => r.outcome === 'error').length;
  logger.info('[triggerSync] sync complete', {
    gathered: inputs.length,
    synced,
    skipped,
    errored,
  });

  // Best-effort sync-run record (observability only). A write failure is logged
  // and NEVER alters or fails the callable — the `{ syncedAt }` return below is
  // unchanged regardless of this write.
  const end = deps.now?.() ?? Date.now();
  const errors = results
    .filter((r) => r.outcome === 'error')
    .map((r) => r.reason)
    .filter((s): s is string => !!s)
    .slice(0, 10);
  try {
    await writeSyncRun(deps.db, {
      kind: 'manual',
      userId: uid,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(end).toISOString(),
      durationMs: end - start,
      titlesGathered: inputs.length,
      titlesUpdated: synced,
      errorCount: errored,
      errors,
    });
  } catch (err) {
    logger.error('[syncRun] failed to record run', err);
  }

  return { syncedAt: new Date().toISOString() };
}

/**
 * The deployable manual-sync callable (spec 0025). Verified Firebase Auth context
 * is supplied by the callable framework; we only assert an identity is present
 * (`request.auth.uid`, never a client-supplied payload). Binds `TMDB_READ_TOKEN`
 * so the runtime injects it; reuses the SAME engine wiring as `syncTitles`.
 */
export const triggerSync = onCall<unknown, Promise<TriggerSyncResponse>>(
  {
    secrets: [TMDB_READ_TOKEN],
    cors: [
      'https://vultus-cab62.web.app',
      'https://vultus-cab62.firebaseapp.com',
      'http://localhost', // Capacitor Android WebView (production native app)
      'http://localhost:4200', // Angular dev server (serve-prod-debug)
    ],
  },
  async (request) => {
    try {
      const db = ensureAdmin();
      const createEngine = (firestore: Firestore): SyncEngine =>
        createSyncEngine({
          tmdb: createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
          trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),
          store: createFirestoreTitleCacheStore(firestore),
        });
      return await runTriggerSync({ db, createEngine }, request.auth?.uid);
    } catch (err) {
      logger.error('[triggerSync] unhandled error', err);
      throw err;
    }
  },
);

/** The `getWatchProviders` callable request (spec 0060). */
export interface GetWatchProvidersRequest {
  region: Region;
}

/** The `getWatchProviders` callable response (spec 0060). */
export interface GetWatchProvidersResponse {
  providers: CatalogProvider[];
}

/** Dependencies injected into `runGetWatchProviders`, so tests drive it with
 *  fakes (fake `db`, fake TMDB client, injected clock). */
export interface RunGetWatchProvidersDeps {
  db: Firestore;
  /** Builds the credentialed TMDB client (injected so tests use a fake). */
  createTmdb: () => TmdbClient;
  /** Clock in epoch ms; injected for deterministic staleness tests. */
  now?: () => number;
  /** Cache staleness window; defaults to 7 days in ms. */
  stalenessMs?: number;
}

/** Default provider-catalog staleness window: 7 days (spec 0060, decision 2). */
export const PROVIDER_CATALOG_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

function isRegion(value: unknown): value is Region {
  return (
    typeof value === 'string' && (REGIONS as readonly string[]).includes(value)
  );
}

/**
 * Core `getWatchProviders` flow, SDK-agnostic via injected deps (spec 0060).
 *
 * Validates the caller (`uid` present) and the client-supplied region (must be a
 * member of `REGIONS`), then reads `provider-catalog/{region}`:
 * - fresh cache (age ≤ stalenessMs) → return its providers, DO NOT call TMDB;
 * - else fetch the region catalog from TMDB:
 *   - `null` (both TMDB endpoints 404/unexpected): a stale cached doc, if any, is
 *     returned instead of throwing (stale beats none); otherwise `unavailable`;
 *   - success: best-effort write the fresh `{ providers, lastSyncedAt }` doc (a
 *     write failure is logged but still returns the freshly-fetched providers),
 *     then return the fresh providers.
 *
 * Reads + writes ONLY `provider-catalog/{region}` (Admin SDK bypasses rules).
 */
export async function runGetWatchProviders(
  deps: RunGetWatchProvidersDeps,
  uid: string | undefined,
  input: unknown,
): Promise<GetWatchProvidersResponse> {
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required');
  }

  const region: unknown =
    input && typeof input === 'object'
      ? (input as { region?: unknown }).region
      : undefined;
  if (!isRegion(region)) {
    throw new HttpsError('invalid-argument', 'Unknown region');
  }

  const now = deps.now?.() ?? Date.now();
  const stalenessMs = deps.stalenessMs ?? PROVIDER_CATALOG_STALENESS_MS;
  const docPath = providerCatalogDocPath(region);

  // Read the cached catalog (if any). A read failure here is a real error the
  // client should see — it is not the best-effort WRITE path below.
  const snap = await deps.db.doc(docPath).get();
  const cached = snap.exists
    ? dataToProviderCatalog(snap.data() as ProviderCatalogReadData)
    : null;

  if (cached) {
    const ageMs = now - Date.parse(cached.lastSyncedAt);
    if (ageMs <= stalenessMs) {
      return { providers: cached.providers };
    }
  }

  // Cache missing or stale → refetch from TMDB.
  const fetched = await deps.createTmdb().getRegionWatchProviders(region);

  if (fetched === null) {
    // Both TMDB endpoints 404/unexpected. A stale cached catalog beats none.
    if (cached) {
      logger.warn(
        '[getWatchProviders] TMDB returned null; serving stale cache',
        { region },
      );
      return { providers: cached.providers };
    }
    throw new HttpsError('unavailable', 'Provider catalog unavailable');
  }

  // Best-effort cache write: a failure logs and still returns the fresh fetch.
  try {
    await deps.db.doc(docPath).set(
      providerCatalogToData({
        providers: fetched,
        lastSyncedAt: new Date(now).toISOString(),
      }),
    );
  } catch (err) {
    logger.error('[getWatchProviders] failed to write provider-catalog', err);
  }

  return { providers: fetched };
}

/**
 * The deployable `getWatchProviders` callable (spec 0060). Verified Firebase Auth
 * context is supplied by the callable framework; we only assert an identity is
 * present (`request.auth.uid`). Binds `TMDB_READ_TOKEN` so the runtime injects it
 * (read via `.value()` ONLY inside the handler, never at module load / logged) and
 * reuses the SAME `cors` array as `triggerSync`.
 */
export const getWatchProviders = onCall<
  unknown,
  Promise<GetWatchProvidersResponse>
>(
  {
    secrets: [TMDB_READ_TOKEN],
    cors: [
      'https://vultus-cab62.web.app',
      'https://vultus-cab62.firebaseapp.com',
      'http://localhost', // Capacitor Android WebView (production native app)
      'http://localhost:4200', // Angular dev server (serve-prod-debug)
    ],
  },
  async (request) => {
    try {
      const db = ensureAdmin();
      return await runGetWatchProviders(
        {
          db,
          createTmdb: () =>
            createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
        },
        request.auth?.uid,
        request.data,
      );
    } catch (err) {
      logger.error('[getWatchProviders] unhandled error', err);
      throw err;
    }
  },
);

export { dispatchNotifications } from './dispatch-notifications';
export { syncWatchlistEpisodes } from './sync-episodes';
