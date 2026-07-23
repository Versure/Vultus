---
number: 0101
slug: sync-pipeline-sharding
title: Shard the nightly sync pipeline (Cloud Tasks) and dedupe episode fetching
status: done
slices: []
scopes: [scope:functions]
created: 2026-07-22
---

# Shard the nightly sync pipeline (Cloud Tasks) and dedupe episode fetching

## Context

The nightly sync is a single serial HTTPS invocation and does not scale. Verified
in code on this worktree:

1. **One serial invocation for the whole pipeline.**
   `setGlobalOptions({ region: 'europe-west1', maxInstances: 1 })`
   (`apps/functions/src/main.ts:70`) applies to **every** function. `syncTitles`
   (`main.ts:353-405`) runs the entire pipeline inside one `onRequest` under
   `timeoutSeconds: 540`: `runSync` (`main.ts:159-342`) gathers + dedupes, runs the
   title-cache engine, then the episode pass, then the airing scan — all serial. The
   TMDB client self-throttles to one request per **250 ms**
   (`libs/functions/sync-titles/src/lib/tmdb/tmdb-client.ts:77`
   `DEFAULT_MIN_REQUEST_INTERVAL_MS = 250`, enforced in
   `libs/functions/sync-titles/src/lib/shared/http.ts:90-95`) — an effective ~4
   req/s, far below TMDB's ~50 req/s ceiling. At ~2 TMDB calls/title (~0.5 s/title)
   the title pass alone hits the 540 s wall around ~1,000 distinct titles. The
   timeout history (60 → 300 → 540, comments at `main.ts:354-360`) shows the ceiling
   is already being ridden.

2. **The episode pass is per-user, not deduped.**
   `createWatchlistTvSourceAdapter.listAllTvShows()`
   (`apps/functions/src/sync-episodes.ts:100-121`) enumerates **one entry per
   (uid, titleId)** from a full `collectionGroup('watchlist')` scan, and the engine
   (`libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts:100-125`)
   calls `getSeasonCount` + `getSeasonEpisodes` per season **per user** — the same
   show is re-fetched once per tracking user. This is O(users × shows × seasons) TMDB
   calls, the dominant cost term at scale.

3. **Three full watchlist collection-group gathers per run.** The title gather
   (`apps/functions/src/lib/firestore-io.ts:35-43`), the episode pass
   (`sync-episodes.ts:105`), and the airing scan
   (`apps/functions/src/dispatch-episode-aired.ts:93`) each read **every** watchlist
   doc of every user. At 100k users that is ~5M reads × 3, nightly.

**Design target (user-approved):** the nightly sync must complete for **~100,000
users / ~20,000 distinct tracked titles**, comfortably within per-invocation
timeouts, with aggregate TMDB throughput staying **≤ ~40 req/s** (headroom under
TMDB's ~50 req/s) and **no O(users × shows)** TMDB term.

**Approved mechanism — Cloud Tasks fan-out (firebase-functions v2 native).** The
repo is on `firebase-functions@7.2.5` / `firebase-admin@13.10.0`, which provide
`onTaskDispatched` (`firebase-functions/v2/tasks`) and enqueue via
`getFunctions().taskQueue(name, extension?)` (`firebase-admin/functions`) — **no new
dependency is required**. The `syncTitles` entry function gathers + dedupes **once**,
opens a `sync-run-progress/{runId}` staging doc (the `sync-runs/{runId}` summary doc is
written only at finalization — see Data model), splits work into shards, and enqueues
one Cloud Task per shard to region-`europe-west1` queues consumed by `onTaskDispatched`
workers that run in parallel under queue-enforced rate limits. Episode data is fetched
**once per distinct show per night** into the global `title-cache`, then fanned out as
cheap per-user Firestore writes.

**Phasing (one spec, one feature PR).** The task graph (§7) is split into **Phase 1**
(sharded title pass, queue infra, `sync-run-progress` staging + completion tracking,
workflow, per-function `maxInstances`) and **Phase 2** (episode dedup cache, per-user
fan-out, gather consolidation, sharded airing scan, stage barriers), each sized to one
implementation session. The phase split is **task-graph sequencing within the single
PR**, not separate PRs — by the end of implementation the whole pipeline is sharded and
deduped. Phase 1 alone does **not** meet the 100k-user target (the O(users×shows)
episode term is untouched); Phase 2 is required for the target.

**Soft dependency on spec 0100.** Spec 0100 (indexed dispatch lookups, drafted the
same day) touches the dispatch adapter path this spec's sharded airing scan reuses.
**Implement 0100 first and rebase**; this spec must **not** duplicate or revert
0100's change. If 0100 has not merged when Phase 2 starts, coordinate as a rebase (do
not re-derive the dispatch adapters from pre-0100 line numbers).

Intended outcome: the nightly run completes well within timeouts at the design
scale; TMDB is called at most once per distinct title (title pass) and once per
distinct show (episode cache) per night; and the `sync-runs/{runId}` summary doc is
still written **once, complete, with accurate stats** (at asynchronous finalization,
or force-finalized with an error outcome by the watchdog) — so the settings sync-health
consumer is unaffected.

## Scope

In:

- **Cloud Tasks queues (europe-west1):** `title-sync`, `episode-cache`,
  `episode-fanout`, `airing-scan`, `sync-watchdog` — **auto-created on deploy** by
  firebase-functions v2 `onTaskDispatched`, whose code-declared `rateLimits`/
  `retryConfig` options ARE the queue config. `firebase.json` is **not** touched for
  queue config. The only manual prereq (PLAN §7 style) is the **IAM bindings**
  (`roles/cloudtasks.enqueuer` for the coordinator's runtime service account, plus
  the queue/worker `run.invoker` binding). NB: code-declared rate limits **overwrite**
  any manually-tuned queue config on each deploy — the code is the source of truth.
- **`syncTitles` entry function** becomes an enqueue coordinator: ONE consolidated
  `collectionGroup('watchlist')` gather, dedupe distinct titles, staleness filter,
  open a **staging progress doc `sync-run-progress/{runId}`** (`finalized: false`,
  per-stage `shardCount`) — **NOT** the `sync-runs/{runId}` summary doc, which is
  written only at finalization (see Data model). It also **enqueues a delayed
  watchdog task** (see below), enqueues Phase-1 title shards, and returns
  `{ ok, runId, shardCount, gathered }` (success = enqueue success). No pipeline work
  runs inline anymore.
- **`titleSyncWorker` (`onTaskDispatched`)** — runs the existing title-cache sync
  engine over its shard's title subset; records its shard result into
  `sync-run-progress/{runId}`.
- **`episodeCacheWorker` (`onTaskDispatched`)** — fetches each distinct TV show's
  seasons/episodes ONCE and upserts the global `title-cache/{tmdbId}/episodes` cache
  (new PLAN §4 addition).
- **`episodeFanoutWorker` (`onTaskDispatched`)** — writes per-user episode docs from
  the cache (insert-only, `s{SS}e{EEE}` ids preserved exactly), plus the spec-0074
  `completed→watching` revert and spec-0081 `nextUnwatchedEpisodeAirDate` recompute.
  **No TMDB calls.**
- **`airingScanWorker` (`onTaskDispatched`)** — the spec-0089 `runEpisodeAiredScan`
  logic, sharded by user. The consolidated gather supplies the **uid list** (this is
  what eliminates the third full `collectionGroup('watchlist')` scan); the worker
  **re-reads each uid's watchlist docs** for per-title status/title within its shard.
- **`syncWatchdog` (`onTaskDispatched`)** — a dead-run detector. The coordinator
  enqueues one delayed watchdog task per run (`scheduleDelaySeconds ≈ 2×` worst-case
  run duration, e.g. `7200` s). When it fires, if `sync-run-progress/{runId}` is not
  finalized, it **writes the `sync-runs/{runId}` summary doc with an error outcome**
  (making the dead run visible in the existing sync-health card) and marks the staging
  doc finalized. Idempotent: if finalization already happened, it no-ops.
- **Stage barriers + completion tracking** on the staging doc `sync-run-progress/{runId}`:
  per-shard subdocs + transactional per-stage counters; the last shard of a stage
  enqueues the next stage; the last shard of the final stage writes the
  `sync-runs/{runId}` **summary doc** (with `completedAt`/`durationMs` and all
  spec-0049 stats) **exactly once, exactly as today** — the summary doc is never
  written in a `running` state, preserving the sync-health invariant.
- **Gather consolidation:** ONE watchlist collection-group gather per run (in the
  entry function), whose tuples feed title dedupe, episode fan-out assignments, and
  airing-scan sharding. The three separate gathers are removed.
- **Replace global `maxInstances: 1`** with explicit per-function options (§5).
- **Update `.github/workflows/daily-sync.yml`** to assert enqueue success instead of
  synchronous run completion (§5).
- **Update READMEs** for `libs/functions/sync-titles` (and `libs/functions/sync-episodes`
  if its ports change) — DoD requirement.

Out of scope:

- **No Firestore emulator / Cloud Tasks emulator run in-session** (CLAUDE.md /
  project memory). Emulator-dependent gates (rules tests, e2e) run in CI / the user's
  terminal.
- **No mobile (`scope:mobile`) change.** Mobile continues to read its per-user
  episode docs and `sync-runs` for sync-health; it never reads the new global episode
  cache.
- **No change to the title-cache engine's per-title TMDB logic** (spec 0008), the
  staleness window semantics, or the auth/rate-limit gate — only where/how they run.
- **No dead-letter queue / Pub/Sub migration** — Cloud Tasks retry + `sync-runs`
  error aggregation is the failure model (see Risks).
- **No `triggerSync` sharding** — the manual per-user callable stays a single
  synchronous pass (small, one user's watchlist).

## Affected slices & Sheriff tags

| Project (Nx name)         | Path                               | Sheriff tags                             | Change                                                                                                                                            |
| ------------------------- | ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions`               | `apps/functions`                   | `scope:functions`                        | Entry rewrite, 4 new `onTaskDispatched` workers + `syncWatchdog` dead-run detector, stage barriers, per-function `maxInstances`, enqueue adapters |
| `functions-sync-titles`   | `libs/functions/sync-titles`       | `scope:functions`, `slice:sync-titles`   | Optional shard-scoped entry point / helper if the engine needs to run over a title subset; README                                                 |
| `sync-episodes`           | `libs/functions/sync-episodes`     | `scope:functions`, `slice:sync-episodes` | New cache-backed episode source port + fan-out engine variant (fetch-once cache → per-user write); README                                         |
| `shared-firestore-schema` | `libs/shared/firestore-schema`     | `scope:shared`                           | Additive: `title-cache/{tmdbId}/episodes` path builders + cached-episode converter; README                                                        |
| `mobile-settings`         | `libs/mobile/settings`             | `scope:mobile`, `slice:settings`         | **No change — verified-unaffected `sync-runs` consumer (see note below)**                                                                         |
| (infra)                   | `.github/workflows/daily-sync.yml` | scope/root only                          | Workflow enqueue-success gate (`firebase.json` untouched — queue config is code-declared, finding (a))                                            |
| (infra)                   | `tools/firestore-rules-test`       | scope/root only                          | Rules tests: clients CANNOT read the episode cache subcollection OR the `sync-run-progress` staging collection                                    |
| (docs)                    | `docs/PLAN.md`                     | n/a                                      | §4 episode-cache addition; §7 manual **IAM** prereq (queues auto-created on deploy)                                                               |

- **No cross-slice import.** Workers live in `apps/functions` (`scope:functions`) and
  wire the `slice:sync-titles` / `slice:sync-episodes` engines through their existing
  ports (Admin-SDK adapters in `apps/functions`), exactly as `main.ts` does today. No
  `scope:mobile` ↔ `scope:functions` edge is introduced.
- **`shared/firestore-schema` additions are additive and functions-only-consumed.**
  Nothing in `libs/mobile/**` consumes the new episode-cache path builders/converter
  (F2 check below). This spec does **not** edit `sheriff.config.ts` (all touched
  projects already carry their tags).
- **`mobile-settings` is a verified-unaffected `sync-runs` consumer — no change, and
  the "no mobile change" claim is now true.** `libs/mobile/settings/src/lib/sync-status.service.ts`
  reads the newest run via `orderBy('startedAt','desc') limit(1)` and maps it through
  `dataToSyncRun` (`libs/shared/firestore-schema/src/lib/converters.ts:230`), which
  calls `data.completedAt.toDate()` — **a run doc with no `completedAt` throws and the
  card renders "Never synced"**. Because this spec writes the `sync-runs/{runId}`
  **summary doc only at finalization** (never in a `running` state — in-flight progress
  lives in the separate `sync-run-progress/{runId}` staging collection the mobile slice
  never reads), the "newest-by-`startedAt` is always complete" invariant the settings
  card relies on is **preserved unchanged**. No converter change, no mobile-code change.
  A run that dies is force-finalized by `syncWatchdog` (Data model / §7), so it too ends
  as a complete-with-error summary doc the card can render — never a permanent
  "Never synced".
- **Shared code justification (3+-slices rule):** the new episode-cache path builders
  - converter go in `shared/firestore-schema` because that is where **all** Firestore
    path/converter vocabulary already lives (PLAN §4) and it is `scope:shared` by
    design — this is not a new cross-slice extraction, it is an addition to the existing
    shared schema lib that both functions slices consume by path.

## Data model touchpoints

PLAN §4. **One new global collection** (functions-write-only), plus the existing
`sync-runs/{runId}` gains sharding sub-structure.

### New: global episode cache (PLAN §4 addition)

```
title-cache/{tmdbId}/episodes/{episodeId}     # tv only; episodeId = s{SS}e{EEE}
  season: number
  episode: number
  title: string | null                        # TMDB episode name; null when unknown
  airDate: timestamp                           # non-null (null-air-date episodes are skipped, spec 0047)
  lastSyncedAt: timestamp                      # when this cache doc was last fetched from TMDB
```

- **Purpose:** fetch each distinct show's episode list from TMDB **once per night**
  (`episodeCacheWorker`) into this shared cache; `episodeFanoutWorker` then reads the
  cache (no TMDB) and writes the per-user
  `users/{uid}/watchlist/{titleId}/episodes/{episodeId}` docs (insert-only, unchanged
  shape). The cache doc stores **only TMDB facts** — it has **no** `watched`/
  `watchedAt` (those are per-user).
- **`episodeId` = `s{SS}e{EEE}`** (season 2-digit floor, episode 3-digit floor) —
  identical to the per-user id scheme (`episode-id.ts:10-14`, project memory
  "Episode doc-id format"). Reuse the existing `episodeId(season, episode)` builder;
  do NOT re-pad differently. Mis-padding silently mis-keys the cache.
- **New converter (additive, `shared/firestore-schema`):** `cachedEpisodeToData` /
  `dataToCachedEpisode` converting the **existing** `Episode` domain type
  (`@vultus/shared/domain`, `{ season, episode, title, airDate }` — **unchanged, no
  new field**) plus a `lastSyncedAt`, crossing the `airDate`/`lastSyncedAt` Timestamp
  boundary exactly as `episodeToData` does for `airDate`. Add matching
  `CachedEpisodeReadData`/`CachedEpisodeWriteData` in `data-types.ts`.
- **New path builders (`paths.ts`):** `titleCacheEpisodesPath(tmdbId)` →
  `title-cache/{tmdbId}/episodes`; `titleCacheEpisodeDocPath(tmdbId, episodeId)` →
  `title-cache/{tmdbId}/episodes/{episodeId}`. Add `episodes` reuse of the existing
  `COLLECTIONS.episodes` constant.

### `firestore.rules` — NO change (state explicitly)

The new `title-cache/{tmdbId}/episodes/{episodeId}` subcollection is written **only by
Cloud Functions via the Admin SDK, which bypasses rules entirely** (see the existing
`title-cache` rule comment, `firestore.rules:38-45`), and **no client ever reads it**
(mobile reads its own per-user episode docs, not the global cache). The current
`title-cache/{tmdbId}` rule grants client read only on the doc and its
`availability/{region}` subcollection; the new `episodes/*` subcollection therefore
falls to the **default deny-all** (`firestore.rules:79-81`), which is exactly what we
want. **Adding a read allowance would be wrong** (it would expose the cache
needlessly). So: **no `firestore.rules` change**, and a **rules test is added**
asserting an authenticated client read of `title-cache/{tmdbId}/episodes/{id}` is
DENIED (locks the default-deny in place; guards against a future well-meaning
broadening). The **new `sync-run-progress/{runId}` staging collection** (and its
`shards/*` and `staged/*` subcollections — the in-flight progress + chunked staged
assignments store, below) is **not matched by any rule**, so it falls to the same
**default deny-all** (`firestore.rules:79-81`).
This is correct: clients read only the finalized `sync-runs/{runId}` summary doc (via
the existing `sync-runs/{runId}` allow-read rule, `firestore.rules:61-64`, unchanged),
never the staging progress. Add a rules test asserting an authenticated client read of
`sync-run-progress/{runId}` and `sync-run-progress/{runId}/shards/{id}` is DENIED, and
that `sync-runs/{runId}` read remains ALLOWED (regression guard). **No
`firestore.rules` change** for either the episode cache or the staging collection.

### `firestore.indexes.json` — NO change (state explicitly)

All watchlist reads remain a single **unindexed** `collectionGroup('watchlist').get()`
with no `where`/`orderBy` (see `firestore-io.ts:35-38` comment — "NO where/orderBy →
needs no composite index"). Cache reads/writes and per-user episode writes are by
document id. No new query is introduced, so `firestore.indexes.json` stays `{ indexes:
[], fieldOverrides: [] }`.

### `sync-runs/{runId}` — UNCHANGED shape, written ONLY at finalization

**Critical invariant (preserves the mobile sync-health consumer).** The
`sync-runs/{runId}` summary doc keeps its **exact** spec-0049 shape (`runId, kind,
userId, startedAt, completedAt, durationMs, titlesGathered, titlesUpdated, errorCount,
errors`) and is **written exactly once, at finalization, exactly as today** (the
current `writeSyncRun`, `apps/functions/src/main.ts:303-317`). It is **never** written
in a `running` state and gains **no** `status`/`stages` fields. This is deliberate:
`sync-status.service.ts` reads newest-by-`startedAt` and maps through `dataToSyncRun`,
which calls `data.completedAt.toDate()` — a doc without `completedAt` would throw and
render "Never synced". Keeping the summary doc finalization-only means every
`sync-runs` doc is always complete, so the settings card is unaffected and needs no
converter/mobile change.

### New: `sync-run-progress/{runId}` — in-flight staging (functions-write-only)

All in-flight shard/stage progress moves to a **separate staging collection** the
mobile app never reads. Written only by Cloud Functions via the Admin SDK (bypasses
rules); default-deny for clients (see rules note above).

```
sync-run-progress/{runId}
  runId, kind, userId, startedAt              # carried so finalization can build the summary
  finalized: boolean                          # false at open; true when summary doc written
  stages: {                                    # per-stage shard progress
    titleSync:    { shardCount, completedShards, titlesGathered, titlesUpdated, errorCount }
    episodeCache: { shardCount, completedShards, showsCached, errorCount }
    episodeFanout:{ shardCount, completedShards, episodesWritten, errorCount }
    airingScan:   { shardCount, completedShards, errorCount }
  }
  errors: string[]                            # capped ≤10, credential-free, aggregated across shards
sync-run-progress/{runId}/shards/{stage}-{shardIndex}  # subcollection — one per shard
  stage, shardIndex, startedAt, completedAt, synced, skipped, errored, errors (≤10)
sync-run-progress/{runId}/staged/{chunkId}   # subcollection — T8: chunked fan-out assignments / uids / show tmdbIds
  # NOT a doc field: at design scale (100k users × shows) the assignment set can exceed
  # the 1MB doc limit even chunked, so it lives in its own subcollection (like shards/*),
  # each doc a bounded chunk the episode-cache/fanout/airing-scan stages read back
```

**Finalization writes the `sync-runs/{runId}` summary from this staging doc.** When the
LAST shard of the LAST stage (airing scan) commits, the barrier reads the staging doc's
rolled-up counters and writes the `sync-runs/{runId}` summary once, in the shape above
(`titlesGathered`/`titlesUpdated` from the title-sync stage, `errorCount` summed across
stages, `errors` the capped sample), then flips `finalized: true` on the staging doc.
`titlesUpdated`/`errorCount` stay backward-compatible with spec 0049 / the spec-0089
error-rate consumers.

**Barrier idempotency under at-least-once delivery.** Cloud Tasks delivers
**at-least-once**, so a shard body can genuinely run twice (not only after a failed
retry). The shard-completion barrier (`sync-run-tracker.ts`) therefore runs a Firestore
**transaction** that: (1) READS the shard subdoc `shards/{stage}-{shardIndex}` **in the
same transaction**; (2) if it is already marked complete, **no-ops** (returns
`isLastShardOfStage: false`, no counter change) — guarding against double-counting and
premature stage advance from a duplicate delivery; (3) only otherwise writes the shard
subdoc AND increments that stage's `completedShards`/rolled-up counters in the same
transaction. Stage advance and finalization key off `completedShards === shardCount`, so
the read-in-transaction guard is what makes both exactly-once.

**Dead-run finalization (`syncWatchdog`).** The coordinator enqueues one delayed
watchdog task per run. When it fires (`scheduleDelaySeconds ≈ 7200`, ~2× worst-case),
it reads `sync-run-progress/{runId}`: if `finalized: true` it **no-ops** (the run
completed normally); otherwise it writes the `sync-runs/{runId}` summary with an
**error outcome** — `completedAt` = watchdog fire time, `durationMs` from `startedAt`,
`errorCount` marking the incomplete stages (e.g. `errors: ['run did not complete:
titleSync 38/40, episodeCache 0/67']`), `titlesGathered`/`titlesUpdated` from whatever
the staging doc rolled up — then flips `finalized: true`. This makes a dead run
**visible in the existing sync-health card** (a complete summary doc with a nonzero
`errorCount`) instead of a permanent "Never synced", **without** violating the
finalization-only invariant. **Both finalization paths transact on `finalized`.** The
watchdog write is transactional against `finalized`, and the **normal** finalization
path (the last-shard-of-last-stage barrier in `sync-run-tracker.ts`) is likewise
transactional against `finalized` — it reads `finalized` in the same transaction and,
if the watchdog already finalized the run, safely **no-ops or overwrites** rather than
double-writing. Because both paths target the **same `sync-runs/{runId}` doc id**, a
late real finalization racing (or following) the watchdog error summary **self-heals**
to a single, consistent summary doc regardless of ordering.

## Public types / APIs

**No `shared/domain` change.** The `Episode` type is reused as-is; no field is added
or made required, so **F2 (shared-type ripple) is N/A** — grep confirms no
`libs/mobile/**` file constructs a new/changed shared type (the episode-cache
converter is new but functions-only-consumed). **F4 (onboarding parity) is N/A** — no
`User` domain field is added or changed.

### Queue provisioning — code-declared, NOT `firebase.json`

firebase-functions v2 `onTaskDispatched` **auto-creates the backing Cloud Tasks queue
on deploy** using the function's code-declared `rateLimits`/`retryConfig` options — the
queue name is the function name, and the option block IS the queue config. Therefore:

- **`firebase.json` is NOT touched for queue config** (there is no Cloud Tasks queue
  block; the existing `functions`/`firestore`/`emulators` blocks are unchanged). Do not
  add gcloud `queues create` steps — the deploy creates them.
- The **only manual prereq** (PLAN §7) is the **IAM bindings**: grant the coordinator's
  runtime service account `roles/cloudtasks.enqueuer` (to enqueue), and the
  `run.invoker` binding on each worker's Cloud Run service (as applicable to the gen2
  `onTaskDispatched` service) so Cloud Tasks may dispatch to it.
- **Deploy overwrites manual tuning.** Because the code-declared `rateLimits` overwrite
  any hand-tuned queue config on every deploy, the `onTaskDispatched` options in code
  are the single source of truth — never tune these queues in the console.

Document the queue names + config in the function options and the README.

### Entry function response (changed shape)

`syncTitles` returns, on a 2xx enqueue:

```ts
export interface SyncEnqueueResponse {
  ok: true;
  trigger: 'cron' | 'user';
  runId: string; // the sync-runs doc id — observe run outcome there
  gathered: number; // distinct titles after dedupe, before staleness
  toSync: number; // distinct titles that passed the staleness filter (== title-sync work)
  shardCount: number; // Phase-1 title-sync shards enqueued (0 ⇒ healthy no-op)
  forced: boolean;
}
```

The old `SyncRunResponse` (`gathered/synced/skipped/errored/errorSample`) is
**removed from the synchronous response** — those counts are not known at enqueue
time. They live in `sync-runs/{runId}` (read by settings sync-health, spec 0049) once
the run finalizes. Auth (401/403), method (405), and user-path rate-limit (429)
behavior are unchanged.

### Worker function options (per-function `maxInstances` + queue rate limits)

Replace `setGlobalOptions({ region: 'europe-west1', maxInstances: 1 })` with
`setGlobalOptions({ region: 'europe-west1' })` (region only) and set explicit
`maxInstances` per function:

| Function                | Trigger             | maxInstances | Queue rateLimits / notes                                                                                                                          |
| ----------------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncTitles`            | `onRequest`         | 2            | Coordinator only; timeout 540 s (the single big gather + staleness reads still run here)                                                          |
| `titleSyncWorker`       | `onTaskDispatched`  | 10           | `title-sync`: maxConcurrentDispatches 10, maxDispatchesPerSecond 10; timeout 540 s                                                                |
| `episodeCacheWorker`    | `onTaskDispatched`  | 10           | `episode-cache`: maxConcurrentDispatches 10, maxDispatchesPerSecond 10; timeout 540 s                                                             |
| `episodeFanoutWorker`   | `onTaskDispatched`  | 20           | `episode-fanout`: maxConcurrentDispatches 20 (no TMDB, Firestore-bound); timeout 540 s                                                            |
| `airingScanWorker`      | `onTaskDispatched`  | 20           | `airing-scan`: maxConcurrentDispatches 20 (no TMDB); timeout 540 s                                                                                |
| `syncWatchdog`          | `onTaskDispatched`  | 2            | `sync-watchdog`: maxConcurrentDispatches 2; timeout 120 s; dead-run finalizer (no TMDB), enqueued once per run with `scheduleDelaySeconds ≈ 7200` |
| `triggerSync`           | `onCall`            | 3            | Unchanged behavior                                                                                                                                |
| `getWatchProviders`     | `onCall`            | 5            | Unchanged behavior                                                                                                                                |
| `syncWatchlistEpisodes` | `onDocumentCreated` | 5            | User-driven on-add; calls TMDB but rare in the nightly window (see arithmetic)                                                                    |
| `dispatchNotifications` | (existing trigger)  | 5            | Unchanged behavior                                                                                                                                |

All `onTaskDispatched` `retryConfig`: `maxAttempts: 3`, `minBackoffSeconds: 30`,
`maxBackoffSeconds: 300`, `maxRetryDuration: 3600` (1h). All worker functions bind the
same secrets they need (`TMDB_READ_TOKEN`, and `TRAKT_CLIENT_ID` string param for the
title worker).

### TMDB-throughput arithmetic (must appear in the spec — here it is)

- **Per-worker throughput** = 1 req / 250 ms = **4 req/s** (existing TMDB client
  default `minRequestIntervalMs`, unchanged).
- **Title stage aggregate** = `maxConcurrentDispatches(title-sync) × 4` = `10 × 4` =
  **40 req/s** ≤ target 40, headroom under TMDB ~50. ✓
- **Episode-cache stage aggregate** = `10 × 4` = **40 req/s**. The episode-cache stage
  runs **after** the title stage completes (stage barrier), so the two TMDB-bound
  stages **never overlap** → aggregate stays ≤ 40 req/s at all times. ✓
- `episodeFanoutWorker` / `airingScanWorker` make **zero TMDB calls** (Firestore/FCM
  only), so their concurrency does not consume the TMDB budget.
- `syncWatchlistEpisodes` (on-add) is user-driven; its nightly-window overlap is
  negligible (a handful of adds/min), and its `maxInstances: 5` bounds any burst to
  ≤ 20 req/s worst case — but it is not scheduled against the nightly window. Noted in
  Risks.

### Shard-sizing arithmetic

- **Title shards:** `SHARD_SIZE_TITLES = 500`. 20,000 distinct titles ⇒ **40 shards**.
  Per shard: 500 titles × ~2 TMDB calls × 0.25 s ≈ **250 s** < 540 s timeout. ✓
  Wall clock (throughput-bound): 40,000 calls / 40 req/s ≈ **1,000 s** total, spread
  over 40 shards × up to 10 concurrent — no single invocation exceeds ~250 s.
- **Episode-cache shards:** `SHARD_SIZE_SHOWS = 150`. ~10,000 distinct TV shows ⇒ ~67
  shards. Per shard: 150 shows × ~4 calls (1 season-count + ~3 seasons) × 0.25 s ≈
  **150 s** < 540 s. ✓ A show with an unusually large season count is isolated
  per-show (existing engine loop); a shard that would exceed its timeout is a Risk
  (below) — the `maxRetryDuration` retry re-runs it and cache upserts are idempotent.
- **Episode-fanout shards:** `SHARD_SIZE_ASSIGNMENTS = 1000` (uid,titleId) TV tuples
  per shard. Firestore-write-bound; no TMDB. Concurrency 20.
- **Airing-scan shards:** `SHARD_SIZE_USERS = 500` users per shard. No TMDB.

These constants are the chosen defaults; keep them as named module constants so they
are tunable without re-plumbing.

### Enqueue payloads (JSON, ≤ Cloud Tasks 100 KB/task; keep shards small)

```ts
interface TitleSyncTask {
  runId: string;
  shardIndex: number;
  titles: { tmdbId: number; type: 'movie' | 'tv' }[];
  forced: boolean;
}
interface EpisodeCacheTask {
  runId: string;
  shardIndex: number;
  shows: number[];
} // distinct TV tmdbIds
interface EpisodeFanoutTask {
  runId: string;
  shardIndex: number;
  assignments: { uid: string; titleId: string; tmdbId: number }[];
}
interface AiringScanTask {
  runId: string;
  shardIndex: number;
  uids: string[];
} // worker re-reads each uid's watchlist for status/title
interface SyncWatchdogTask {
  runId: string;
} // enqueued once with scheduleDelaySeconds ≈ 7200; dead-run finalizer
```

Task **names** are set to `${runId}-${stage}-${shardIndex}` (watchdog: `${runId}-watchdog`)
so a retried enqueue with the same `runId` cannot double-create a shard/watchdog task
(Cloud Tasks de-dupes by name).

## UI / Stitch screen refs

**Not applicable — backend/infra only.** No mobile route, page, component, template,
or design token is touched. No Stitch screen is involved.

## Implementation task graph

> Two phases; each phase is one implementation session. All within the single feature
> PR. Phase-2 tasks are `[sequential]` **after** Phase 1 because they wire into the
> stage-barrier + `sync-run-progress` staging structures Phase 1 establishes and depend
> on the `shared/firestore-schema` additions. Within a phase, `[parallel]` tasks carry
> disjoint file manifests.

### Phase 0 — shared schema additions (`[sequential]`, must finish first)

**T0 — episode-cache path builders + converter (`shared/firestore-schema`).**

- `libs/shared/firestore-schema/src/lib/paths.ts` (MODIFIED) — add
  `titleCacheEpisodesPath`, `titleCacheEpisodeDocPath`.
- `libs/shared/firestore-schema/src/lib/data-types.ts` (MODIFIED) — add
  `CachedEpisodeReadData` / `CachedEpisodeWriteData`.
- `libs/shared/firestore-schema/src/lib/converters.ts` (MODIFIED) — add
  `cachedEpisodeToData` / `dataToCachedEpisode` (reuse the `Episode` domain type; no
  domain change).
- `libs/shared/firestore-schema/src/index.ts` (MODIFIED) — export the new symbols.
- `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts` (MODIFIED) — round-trip
  tests for the new converter (Timestamp boundary on `airDate` + `lastSyncedAt`).
- `libs/shared/firestore-schema/README.md` (MODIFIED) — document the new path builders
  - converter + boundary.

### Phase 1 — sharded title pass + queue infra + completion tracking

**T1 [sequential, after T0] — Cloud Tasks enqueue adapter + `sync-run-progress` stage
helpers (`apps/functions`).** Shared dep for the workers and the entry.

File manifest:

- `apps/functions/src/lib/task-queue.ts` (NEW) — thin `getFunctions().taskQueue(name)`
  enqueue wrapper (injectable for tests; supports `scheduleDelaySeconds` for the
  watchdog), shard-splitting helper `chunk(items, size)`, and the task-name builder
  `${runId}-${stage}-${shardIndex}` (+ `${runId}-watchdog`).
- `apps/functions/src/lib/sync-run-tracker.ts` (NEW) — (a) **open a run** = write the
  staging doc `sync-run-progress/{runId}` (`finalized: false`, per-stage `shardCount`s,
  carried `kind/userId/startedAt`); **NOT** the `sync-runs/{runId}` summary. (b)
  **record a shard result** in a transaction that **READS the shard subdoc
  `sync-run-progress/{runId}/shards/{stage}-{shardIndex}` first and no-ops if already
  complete** (at-least-once duplicate guard), else writes the subdoc + increments the
  stage counters — all in the one transaction. (c) the **stage-barrier finalizer**:
  when `completedShards === shardCount` for a stage, return whether this shard is the
  last; the last shard of the **last** stage reads the staging doc's rolled-up counters
  and writes the `sync-runs/{runId}` **summary doc** (spec-0049 shape, `completedAt`/
  `durationMs`) **once**, then flips `finalized: true`. (d) a **`finalizeAsDead(runId)`
  helper** used by the watchdog: transactional on `finalized` — if already finalized,
  no-op; else write the `sync-runs/{runId}` summary with an error outcome and flip
  `finalized: true`.
- `apps/functions/src/lib/*.spec.ts` (NEW) — unit tests for shard math, task-name
  determinism, payload shape, the completion/barrier transaction logic incl. the
  **read-in-transaction duplicate-delivery no-op**, the finalize-only-writes-summary
  invariant, and `finalizeAsDead` idempotency (fakes).

**T2 [sequential, after T1] — entry-function rewrite + `titleSyncWorker` + `syncWatchdog`
(`apps/functions/src/main.ts`).** These live in the same file / are tightly coupled,
so one task.

File manifest:

- `apps/functions/src/main.ts` (MODIFIED) — (a) `setGlobalOptions` region-only +
  per-function `maxInstances`; (b) rewrite `syncTitles` to: consolidated gather →
  dedupe → staleness filter → open **`sync-run-progress/{runId}`** (staging, via T1)
  → **enqueue the `sync-watchdog` task with `scheduleDelaySeconds ≈ 7200`** → enqueue
  `title-sync` shards → return `SyncEnqueueResponse`. It does **NOT** write the
  `sync-runs/{runId}` summary. (c) add `titleSyncWorker` (`onTaskDispatched`) running
  `createSyncEngine` over the shard's titles, recording its shard result, and — if it
  is the last title shard — enqueuing the Phase-2 `episode-cache` stage. (d) add
  `syncWatchdog` (`onTaskDispatched`) that calls `finalizeAsDead(runId)` (T1) —
  no-op if the run already finalized, else force-writes the error summary. Remove the
  inline episode pass + airing-scan calls from the old `runSync` (they move to
  workers). Keep `runSync` as a testable pure core where practical (coordinator
  logic), driven by injected deps.
- `apps/functions/src/main.spec.ts` (MODIFIED) — update/replace the `runSync` tests
  for the enqueue-coordinator shape (asserts a staging doc is opened + a watchdog task
  is enqueued with the delay, and that **no `sync-runs` summary is written at enqueue**);
  add `titleSyncWorker` tests (fake engine + fake enqueue + fake tracker); add
  `syncWatchdog` tests: fires → not finalized → writes error summary; fires → already
  finalized → no-op. Assert `SyncEnqueueResponse`, shard count, and last-shard →
  next-stage enqueue.

**T3 [parallel, after T1] — daily-sync workflow enqueue-success gate.**

File manifest:

- `.github/workflows/daily-sync.yml` (MODIFIED) — the entry now returns after
  enqueue, so gate on: 2xx **and** a parseable `runId` **and** (`shardCount > 0` OR
  `gathered == 0` healthy no-op). Drop the synchronous per-title error-rate gate
  (`errored`/`errorSample` are no longer in the response); replace the comment block
  to explain that run **outcome** is now observable in `sync-runs/{runId}` (settings
  sync-health, spec 0049), not the enqueue response. Keep the GFE-403 / 401 / 403
  branching (the shared-secret auth path is unchanged). Keep `--max-time` generous
  (the coordinator's big gather can still take tens of seconds) but the job no longer
  needs to wait for the whole pipeline.

**T4 [parallel, after T1] — rules test + PLAN §4/§7 docs (no `firebase.json` change).**

File manifest:

- `tools/firestore-rules-test/src/firestore-rules.rules.spec.ts` (MODIFIED) — add:
  authenticated client read of `title-cache/{tmdbId}/episodes/{id}` is **denied**;
  authenticated client read of `sync-run-progress/{runId}` is **denied**;
  authenticated client read of `sync-run-progress/{runId}/shards/{id}` is **denied**;
  authenticated client read of `sync-runs/{runId}` still **allowed** (regression guard).
  (No `firestore.rules` edit — all denials are the existing default-deny.)
- `docs/PLAN.md` (MODIFIED) — §4: add the `title-cache/{tmdbId}/episodes/{episodeId}`
  cache block **and** the `sync-run-progress/{runId}` staging collection note (in-flight
  progress; functions-write-only; `sync-runs` stays finalization-only). §7: add a manual
  prereq that the Cloud Tasks queues are **auto-created on deploy** by `onTaskDispatched`
  (no gcloud `queues create` step) and the **only** manual step is the IAM bindings —
  grant the functions' runtime service account `roles/cloudtasks.enqueuer` and the
  per-worker `run.invoker` binding for `onTaskDispatched` dispatch — mirroring the
  existing gcloud-prereq style. Note that code-declared `rateLimits` overwrite any
  console-tuned queue config on each deploy.

> **No `firebase.json` change** (finding (a)): queue config is code-declared via the
> `onTaskDispatched` options in T2/T6/T7; `firebase.json` is untouched.

### Phase 2 — episode dedup cache + fan-out + gather consolidation + airing scan

**T5 [sequential, after T2] — cache-backed episode engine (`libs/functions/sync-episodes`).**

File manifest:

- `libs/functions/sync-episodes/src/lib/ports.ts` (MODIFIED) — add a
  `TitleCacheEpisodeStore` port (read/upsert the global cache episodes for a tmdbId)
  and a fan-out variant that consumes cached episodes instead of TMDB. Keep the
  existing ports for the on-add trigger (entry point A, unchanged).
- `libs/functions/sync-episodes/src/lib/engine/*.ts` (MODIFIED/NEW) — a
  `cacheShowEpisodes(tmdbId)` operation (fetch seasons once → upsert cache;
  insert/refresh by `episodeId`) and a `fanoutUserEpisodes(uid, titleId, tmdbId)`
  operation (read cache → insert-only per-user writes → spec-0074 revert + spec-0081
  `nextUnwatchedEpisodeAirDate` recompute). Reuse `episodeId` / `newEpisodeDoc`.
- `libs/functions/sync-episodes/src/lib/**/*.spec.ts` (MODIFIED/NEW) — unit tests:
  cache upsert idempotency, fan-out insert-only (never overwrites `watched`), revert +
  next-watchable recompute driven from cache, null-air-date skip.
- `libs/functions/sync-episodes/README.md` (MODIFIED) — document the cache-backed
  fetch-once/fan-out model and the new ports.

**T6 [sequential, after T5] — `episodeCacheWorker` + `episodeFanoutWorker`
(`apps/functions`).**

File manifest:

- `apps/functions/src/sync-episodes.ts` (MODIFIED) — add the `TitleCacheEpisodeStore`
  Admin-SDK adapter (over `titleCacheEpisodesPath`); add `episodeCacheWorker`
  (`onTaskDispatched`: cache each show once, record shard result, last shard →
  enqueue `episode-fanout` + `airing-scan` stages using the fan-out assignments +
  uids the entry persisted for the run — see T8) and `episodeFanoutWorker`
  (`onTaskDispatched`: per-user writes from cache, no TMDB, record shard result).
- `apps/functions/src/sync-episodes.spec.ts` (MODIFIED/NEW) — worker unit tests
  (fake cache store, fake enqueue, fake tracker).

**T7 [sequential, after T6] — `airingScanWorker` (`apps/functions`).** Soft-depends on
spec 0100 (dispatch adapters); rebase onto 0100, do not duplicate.

File manifest:

- `apps/functions/src/dispatch-episode-aired.ts` (MODIFIED) — parameterize
  `runEpisodeAiredScan` to scan a **subset of uids** (the shard's `uids`, supplied by
  the consolidated gather) instead of a full `collectionGroup` gather — the worker
  **re-reads each uid's watchlist docs** for per-title status/title; add
  `airingScanWorker` (`onTaskDispatched`) that runs the scan for its shard and records
  its shard result; the **last airing-scan shard** is the final barrier — it writes the
  `sync-runs/{runId}` **summary doc** (spec-0049 shape, `completedAt`/`durationMs`) once
  and flips the staging doc's `finalized: true` (via T1's finalizer).
- `apps/functions/src/dispatch-episode-aired.spec.ts` (MODIFIED) — subset-scan tests +
  final-barrier finalize test.

**T8 [sequential, after T2 and T6] — gather consolidation + assignment persistence.**
Wire the ONE consolidated gather (from the entry, T2) to also produce the episode
fan-out assignments `{ uid, titleId, tmdbId }` (TV only) and the distinct uid list,
persist them for the run under the **`sync-run-progress/{runId}/staged/*` subcollection**
(one doc per bounded chunk — **NOT** a `staged` field on the progress doc, which at
design scale can exceed the 1MB doc limit even chunked) so the
`episode-cache`/`fanout`/`airing-scan` stages consume them without re-gathering. Remove the two extra `collectionGroup('watchlist')` gathers
(`sync-episodes.ts` `listAllTvShows`, and the airing-scan's own gather). NB: the
airing-scan worker still re-reads each shard uid's watchlist for status/title — the
gather only removes the redundant full-collection **uid enumeration**, not the per-uid
reads.

File manifest:

- `apps/functions/src/main.ts` (MODIFIED) — extend the entry's single gather to emit
  the TV assignments + distinct show tmdbIds + distinct uids and persist them for the
  run as chunked docs under the `sync-run-progress/{runId}/staged/*` subcollection (not
  a doc field — stays under the 1MB doc limit at scale).
- `apps/functions/src/lib/sync-run-tracker.ts` (MODIFIED) — helpers to persist/read the
  staged assignment/uids/show lists per run under the
  `sync-run-progress/{runId}/staged/*` subcollection.
- `apps/functions/src/lib/*.spec.ts` (MODIFIED) — tests for the consolidation + staged
  reads.
- `libs/functions/sync-titles/README.md` (MODIFIED) — document that the daily gather is
  now single-pass and feeds all downstream stages.

**T9 [sequential, after T7] — `functions:deploy-preflight` + integration wiring
verification.**

File manifest:

- (no new files) — run `pnpm nx run functions:deploy-preflight` (also a CI gate): a new
  trigger type (`onTaskDispatched`) and any `apps/functions` build/dep change MUST pass
  it (gen2 discovery loads `main.js`; the **five** new `onTaskDispatched` functions —
  the four stage workers + `syncWatchdog` — must be discoverable). If a dep is added
  (none expected — enqueue uses `firebase-admin/functions`), re-run the pnpm-pruned
  preflight. Record the result in the PR.

> **Disjointness note.** Only T3 and T4 run `[parallel]` (in Phase 1), and their
> manifests are disjoint (`.github/workflows/daily-sync.yml` vs
> `tools/firestore-rules-test/**` + `docs/PLAN.md`; T4 does **not** touch
> `firebase.json`). All other tasks are `[sequential]` because they share
> `apps/functions/src/main.ts` / `sync-episodes.ts` / `sync-run-tracker.ts` or depend on
> the prior task's runtime contract. Do not fan these out concurrently.

## Test plan

Per the PLAN §5 pyramid. **Backend-only; e2e: N/A** (see rubric below). The Firestore
emulator and Cloud Tasks emulator cannot run under Claude Code tools (CLAUDE.md /
project memory); all logic is tested with **unit tests + fakes**, and emulator-gated
checks (rules tests, `deploy-preflight`'s emulator-independent parts run locally; the
rules test itself runs in CI / the user's terminal).

**Unit — shard math + payloads (`apps/functions/src/lib/*.spec.ts`):**

- `chunk(items, size)` splits N items into `ceil(N/size)` shards, last shard is the
  remainder, empty input → `[]` (0 shards).
- Task-name builder is deterministic: same `(runId, stage, shardIndex)` → same name;
  different shardIndex → different name (double-enqueue idempotency).
- Payload shape matches the `TitleSyncTask` / `EpisodeCacheTask` / `EpisodeFanoutTask`
  / `AiringScanTask` interfaces exactly.

**Unit — completion tracking + stage barriers (`sync-run-tracker.spec.ts`):**

- Opening a run writes the **`sync-run-progress/{runId}` staging doc** (`finalized:
false` + each stage's `shardCount`) and does **NOT** write any `sync-runs/{runId}`
  summary doc (assert the summary collection is untouched at open).
- Recording a shard result increments that stage's `completedShards` and rolls up its
  counters (transactional; a fake transaction verifies read-modify-write).
- **At-least-once duplicate delivery:** the barrier transaction **READS the shard
  subdoc in the same transaction** and, if already marked complete, **no-ops** — no
  counter increment, no stage advance, `isLastShardOfStage === false`. Verify with a
  fake transaction where the subdoc read returns an already-complete doc: assert
  `completedShards` is unchanged and no next-stage enqueue is triggered. (Distinct from
  a retry of a _failed_ shard — this guards a genuine second delivery of a _succeeded_
  shard.)
- The barrier returns `isLastShardOfStage === true` only on the shard that brings
  `completedShards === shardCount`.
- **Finalization writes the summary exactly once:** only the last shard of the LAST
  stage (airing scan) writes the `sync-runs/{runId}` **summary doc** (spec-0049 shape,
  `completedAt`/`durationMs` present) and flips staging `finalized: true`. Assert no
  intermediate stage writes a `sync-runs` doc, and the summary is never in a `running`
  state (invariant: newest-by-`startedAt` `sync-runs` doc always has `completedAt`).
- **`finalizeAsDead(runId)`:** on a non-finalized run writes a `sync-runs/{runId}`
  summary with an error outcome (`errorCount > 0`, incomplete-stages message,
  `completedAt` set) and flips `finalized: true`; on an already-finalized run is a
  **no-op** (asserts idempotency — no second summary write).

**Unit — dedupe + consolidation (`main.spec.ts`, `gather` reused):**

- `dedupeTitles` unchanged (existing tests stay green).
- The consolidated gather emits distinct titles, TV fan-out assignments, distinct show
  tmdbIds, and distinct uids from one fake `collectionGroup` snapshot.

**Unit — workers (`main.spec.ts`, `sync-episodes.spec.ts`, `dispatch-episode-aired.spec.ts`):**

- `titleSyncWorker` runs the (fake) engine over its shard, records the shard result,
  and the last shard enqueues the `episode-cache` stage (fake enqueue asserts the
  shard count).
- `episodeCacheWorker` upserts the cache once per show (fake TMDB source + fake cache
  store); idempotent on a re-run (same ids); records shard result.
- `episodeFanoutWorker` writes per-user episode docs **insert-only** from the cache
  (never overwrites an existing `watched: true` doc), applies the spec-0074
  `completed→watching` revert and the spec-0081 `nextUnwatchedEpisodeAirDate`
  recompute, and makes **zero TMDB calls** (assert the fake TMDB source is never
  invoked).
- `airingScanWorker` scans only its shard's uids (re-reads each uid's watchlist), and
  the last shard finalizes the run (writes the `sync-runs/{runId}` summary once).
- `syncWatchdog` fires against a **non-finalized** staging doc → writes the error
  summary (`finalizeAsDead`); fires against an **already-finalized** run → no-op (fake
  tracker asserts no second summary write).

**Unit — converter (`firestore-schema.spec.ts`):**

- `cachedEpisodeToData` → `dataToCachedEpisode` round-trips `season/episode/title/
airDate/lastSyncedAt` across the Timestamp boundary; `title: null` preserved.

**Rules tests (`tools/firestore-rules-test`, CI / user terminal — NOT in-session):**

- Authenticated client read of `title-cache/{tmdbId}/episodes/{id}` is **denied**.
- Authenticated client read of `sync-run-progress/{runId}` is **denied**.
- Authenticated client read of `sync-run-progress/{runId}/shards/{id}` is **denied**.
- Authenticated client read of `sync-runs/{runId}` remains **allowed** (regression
  guard).

**Rendered-text assertions:** N/A (no UI / rendered copy in this spec).

> **e2e decision rubric — Not required.** This is a `scope:functions`-only /
> infra change with **no `scope:mobile` route or action change**. State explicitly:
> **"No e2e flows required — backend/infra change only."** Verification is unit tests
>
> - the CI rules-test + `functions:deploy-preflight` (gen2 discovery of the new
>   `onTaskDispatched` workers + `syncWatchdog`) + the post-deploy manual observation of a
>   real nightly run's `sync-runs/{runId}` summary doc being written at finalization with
>   accurate stats (and the settings sync-health card rendering it) (Risks / manual).

## Definition of done

- [ ] **Typecheck** passes (`pnpm nx run-many -t typecheck -p functions functions-sync-titles sync-episodes` and `nx affected -t typecheck --base=main`) — entry, workers, engines, and the new converter compile. (T0, T2, T5, T6, T7, T8)
- [ ] **Lint + Sheriff** pass — no `scope:mobile` ↔ `scope:functions` edge; no cross-slice import; workers wire engines via existing ports; no `sheriff.config.ts` change. (all tasks)
- [ ] **Unit tests** pass and each changed lib/app has tests for its logic: `pnpm nx test functions`, `pnpm nx test functions-sync-titles`, `pnpm nx test sync-episodes`, `pnpm nx test shared-firestore-schema` — shard math, task-name determinism, payload shapes, completion/barrier transactions (incl. the read-in-transaction duplicate-delivery no-op and finalize-only-writes-summary invariant), `finalizeAsDead` idempotency, dedupe/consolidation, all four workers + `syncWatchdog`, and the cached-episode converter round-trip. (T0–T8)
- [ ] **Component tests** — none required (no UI). Stated in the PR.
- [ ] **e2e** — none required; **"No e2e flows required — backend/infra change only."** Stated in the PR. (rubric §8)
- [ ] **Build** passes for affected projects (`nx affected -t build --base=main`), including `functions`. (T2, T6, T7)
- [ ] **`functions:deploy-preflight`** passes — the pruned `dist/apps/functions` bundle installs and gen2 discovery loads `main.js` with the **five** new `onTaskDispatched` functions (four stage workers + `syncWatchdog`) discoverable; `firebase-admin` still satisfies `firebase-functions`' peer range (no new dep expected). (`pnpm nx run functions:deploy-preflight`) (T9)
- [ ] **`firestore.rules`** — **no change**; the new `title-cache/{tmdbId}/episodes/*` cache and the `sync-run-progress/{runId}` staging collection (+ its `shards/*` subdocs) are functions-write-only + client-read-denied by default-deny, and `sync-runs/{runId}` read stays allowed. Confirmed by the added rules tests (`pnpm test:rules`, CI / user terminal — NOT in-session). Stated in the PR. (T4)
- [ ] **`firestore.indexes.json`** — **no change**; all watchlist reads stay unindexed `collectionGroup` `.get()`, all cache/episode/staging access by doc id. Stated in the PR. (verified in T2/T5/T6)
- [ ] **PLAN.md updated** — §4 gains the `title-cache/{tmdbId}/episodes/{episodeId}` cache block + the `sync-run-progress/{runId}` staging note; §7 gains the Cloud Tasks **IAM** manual prereq (queues auto-created on deploy; no `firebase.json`/gcloud queue-create). (T4)
- [ ] **`firebase.json`** — **no change** (queue config is code-declared via `onTaskDispatched` options; finding (a)). Stated in the PR.
- [ ] **Dead-run visibility (`syncWatchdog`)** — the coordinator enqueues a delayed watchdog task per run; a run that dies before finalization is force-finalized into a `sync-runs/{runId}` error summary (visible in the sync-health card), never a permanent "Never synced". Covered by unit tests. (T1, T2)
- [ ] **sync-health invariant preserved** — the `sync-runs/{runId}` summary doc is written ONLY at finalization (never `running`), so `mobile-settings`' newest-by-`startedAt` read + `dataToSyncRun` (`completedAt.toDate()`) is unaffected; no converter/mobile change. (T1, T2, T7)
- [ ] **READMEs updated** — `libs/shared/firestore-schema` (new path builders + converter), `libs/functions/sync-titles` (single-pass gather + enqueue coordinator), `libs/functions/sync-episodes` (cache-backed fetch-once/fan-out model + new ports). (T0, T5, T8)
- [ ] **`.github/workflows/daily-sync.yml`** gates on enqueue success (2xx + `runId` + `shardCount > 0` or `gathered == 0`), with the GFE-403/401/403 branching preserved and run outcome documented as observable in `sync-runs`. (T3)
- [ ] **No `shared/domain` change** (F2 N/A) and **no `User` field change** (F4 N/A). Stated in the PR.
- [ ] **PR references this spec (0101)** and notes the spec-0100 rebase order (0100 first).
- [ ] **POST-MERGE / POST-DEPLOY manual verification (required — the real Cloud Tasks + nightly path is only verifiable deployed).** After `/deploy-functions` and applying the IAM bindings (PLAN §7; queues auto-create on deploy), trigger the daily-sync workflow (`workflow_dispatch`) and confirm: the entry returns a `runId` + `shardCount`; the `title-sync`/`episode-cache`/`episode-fanout`/`airing-scan` queues drain; the `sync-runs/{runId}` **summary doc is written once at finalization** with accurate `titlesGathered`/`titlesUpdated`/`errorCount` within the timeout budget; and the settings sync-health card renders it. The emulator/Cloud-Tasks path cannot run in-session (CLAUDE.md).

## Risks

- **Partial-run semantics + dead-run detection (handled IN THIS SPEC).** A shard can
  fail after Cloud Tasks exhausts `maxAttempts` (3). Design: each worker wraps its body
  so it **always records its shard result** (success or caught-error, with
  per-title/per-show errors aggregated into the shard subdoc + stage `errorCount`), so
  `completedShards` still reaches `shardCount` and the run finalizes normally with
  accurate error counts. A worker lost to an **uncaught crash / infra failure** on all
  3 attempts leaves its stage short of `shardCount` → the `sync-run-progress/{runId}`
  staging doc never reaches finalization. **This is caught by `syncWatchdog`** (not a
  deferred follow-up): the delayed watchdog task (`scheduleDelaySeconds ≈ 7200`) fires,
  sees `finalized: false`, and force-writes a `sync-runs/{runId}` **error summary**
  (`errorCount > 0`, incomplete-stages message) — so the dead run is **visible in the
  existing sync-health card** as a completed-with-error run, and because the summary doc
  is only ever written complete, the settings card never renders a spurious "Never
  synced" during a healthy in-flight window either. The watchdog is idempotent (no-ops
  if a normal finalization already happened). This is the exact silent-failure mode
  project memory records; it is closed in this spec, not punted.
- **Watchdog timing residual (named, acceptable).** Per-shard `retryConfig.maxRetryDuration
= 3600` s (1h) across the **two serial TMDB stages** (title-sync then episode-cache) can
  sum to ~7,200 s, **equal to the watchdog's `scheduleDelaySeconds ≈ 7200`**. Under a
  doubly-pathological retry-exhaustion tail (both TMDB stages riding their full retry
  duration back-to-back) the watchdog can fire **while the run is still legitimately
  progressing**, force-writing an error summary for a run that would have finalized
  cleanly. The **non-retry** worst case is only ~2,500 s (title ~1,000 s wall + episode
  ~1,000 s + fan-out/airing overhead), so the watchdog fires far after a healthy run
  completes; the residual only materializes when retries are also near-maximal. Because
  both finalization paths transact on `finalized` and target the same
  `sync-runs/{runId}` doc (Data model), a late real finalization racing the watchdog
  **self-heals** to a single consistent summary — the worst outcome is a transiently
  pessimistic error summary that a subsequent real finalization overwrites. Acceptable
  residual; if it ever manifests, raise `scheduleDelaySeconds` or lower
  `maxRetryDuration` (both tuning changes, no re-plumb).
- **Lost-watchdog residual (named, acceptable).** If the watchdog task itself is lost on
  all attempts (uncaught crash / infra failure across every retry), a dead run writes
  **only** to `sync-run-progress/{runId}` (never `sync-runs/{runId}`). The previous
  night's completed run therefore remains the **newest-by-`startedAt`** `sync-runs` doc,
  so the settings sync-health card shows a **stale-but-valid last-sync** — not a "Never
  synced" and not a crash. Acceptable residual, named.
- **Double-enqueue idempotency.** Two overlapping entry calls produce two `runId`s
  (two independent runs). The existing per-title **staleness window** (`STALENESS_WINDOW_MS
= 20h`, `main.ts:91`) still suppresses redundant TMDB work across overlapping runs;
  the `force` flag now applies **per title-sync shard** (carried in the payload). Task
  names `${runId}-${stage}-${shardIndex}` prevent a **retried enqueue of the same run**
  from double-creating a shard. Cross-run overlap is bounded by staleness, not
  prevented — acceptable (same as today).
- **Episode-cache staleness vs per-user backfill.** The global cache is refreshed each
  night by `episodeCacheWorker`; `episodeFanoutWorker` reads whatever the cache holds.
  A show added mid-day still gets its first episodes via the unchanged on-add trigger
  (`syncWatchlistEpisodes`, entry point A, per-user TMDB) — that path is **not** routed
  through the cache (it is rare and user-latency-sensitive). The nightly fan-out then
  keeps it in sync. No correctness gap; noted so the two episode-creation paths are not
  mistaken for a conflict (both insert-only, same `s{SS}e{EEE}` ids → race-safe, per
  project memory "Episode doc-id format").
- **A show with many seasons can overrun an episode-cache shard's budget.** With
  `SHARD_SIZE_SHOWS = 150` and ~4 calls/show the shard is ~150 s, but a pathological
  100-season show alone is ~25 s. Per-show error isolation (existing engine loop) plus
  Cloud Tasks retry (idempotent cache upsert) contain it; if it becomes real, lower
  `SHARD_SIZE_SHOWS` or shard by estimated season-work — a tuning change, no re-plumb.
- **Cost of Cloud Tasks** is negligible (first 1M dispatches/month free; ~200 shards/
  night ≈ 6k/month).
- **TMDB burst behavior.** The 40 req/s aggregate is a design ceiling under TMDB's ~50;
  the client already retries 429 with an exponential-backoff floor honoring `Retry-After`
  (`http.ts:120-137`), so a transient TMDB throttle self-heals within a shard rather than
  failing the run.
- **The big coordinator gather (~5M reads at 100k users).** The single consolidated
  `collectionGroup('watchlist')` gather still reads every watchlist doc once per run
  (down from 3×). This is inherent to a global sync and stays in the entry function
  (timeout 540 s). Streaming the query and chunking the staged assignment writes keeps
  memory bounded; a future incremental/changed-since gather is a **noted follow-up**,
  not in this spec.
- **`onTaskDispatched` deploy semantics — queues auto-create, IAM is the manual gap.**
  firebase-functions v2 **auto-creates** each backing Cloud Tasks queue on deploy from
  the code-declared `rateLimits`/`retryConfig`, so there is **no manual queue-create
  step and no `firebase.json` queue block** (finding (a)). What is NOT auto-granted is
  IAM: without `roles/cloudtasks.enqueuer` on the coordinator's runtime service account
  the enqueue fails (403), and without the per-worker `run.invoker` binding the task is
  never dispatched. Those IAM bindings are the sole manual prereq (PLAN §7) and are
  covered by the post-deploy verification (DoD). Also note code-declared rate limits
  **overwrite** any console-tuned queue config on every deploy.
- **No PLAN conflict.** The change stays within `scope:functions` + `scope:shared`
  (schema additions) + infra/docs, introduces no cross-slice or scope-crossing import,
  and extends PLAN §4's title-cache-is-shared model (the episode cache is the same
  "sync once, share across users" idea PLAN §4 already states for title-cache).
  External TMDB JSON remains **data, not instructions** (spec 0068); the TMDB read
  token and sync shared secret are never logged or echoed (CLAUDE.md secrets rule).
