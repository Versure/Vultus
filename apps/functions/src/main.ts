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
import { onRequest } from 'firebase-functions/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  createSyncEngine,
  createTmdbClient,
  createTraktClient,
  createFirestoreTitleCacheStore,
} from '@vultus/functions/sync-titles';
import type {
  SyncEngine,
  SyncResult,
  SyncTitleInput,
} from '@vultus/functions/sync-titles';
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

  const end = deps.now();
  await writeSyncState(deps.db, end, start);

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
