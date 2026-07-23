# functions-sync-titles

The `sync-titles` functions slice (`scope:functions`, `slice:sync-titles`) — the
first `libs/functions/*` slice. It contains two typed REST clients — a TMDB v3
client (streaming availability + metadata + episodes) and a Trakt API v2
calendar client (upcoming/aired episodes), both over a single in-slice HTTP
transport — and the **title-cache sync engine** (spec 0008) that orchestrates
them: it refreshes `title-cache` metadata + per-region availability and detects
provider transitions against the previous snapshot, writing through an injected,
Firebase-free persistence port, plus the **Admin-SDK adapter** (spec 0009) that
implements that port against `firebase-admin` Firestore — the one place the SDK
enters the slice. The HTTP `onRequest` function that wires the engine + adapter
lives in `apps/functions` (spec 0009).

## Public API

Imported from `@vultus/functions/sync-titles`:

- `createTmdbClient(config: TmdbClientConfig): TmdbClient` — factory returning a
  client with six methods:
  - `getMovie(tmdbId)` → `Promise<TitleMetadata | null>`
  - `getTvShow(tmdbId)` → `Promise<TitleMetadata | null>`
  - `getTvSeasonCount(tmdbId)` → `Promise<number | null>` — total season count for a TV show (TMDB 404 → null); added for the episode-sync consumer (spec 0047)
  - `getWatchProviders(tmdbId, type)` → `Promise<RegionProviders | null>`
  - `getSeasonEpisodes(tmdbId, seasonNumber)` → `Promise<Episode[] | null>` — each returned `Episode` now carries `title: string | null` (spec 0047)
  - `getRegionWatchProviders(region)` → `Promise<CatalogProvider[] | null>` — the region-wide watch-provider **catalog** (spec 0060). Fetches `GET /watch/providers/movie` and `GET /watch/providers/tv` with `watch_region={region}`, then merges the two lists into one `CatalogProvider[]` (deduped by `providerId`, first occurrence wins; sorted by `name`, case-insensitive) via the pure `mergeCatalogProviders` mapper. The real TMDB "Plex" provider (name matched case-insensitive, trimmed, **exact** `'plex'`) is excluded from the merged catalog (spec 0077 / #195) so it never collides with the manual "I use Plex" chip (spec 0061). `logoPath` is `logo_path ?? null`. Per-side 404 → that side treated as `[]`; **only** when **both** endpoints 404 → `null` (mirrors the other methods' 404 → null contract). An empty catalog → `[]`. This is a region catalog (not per-title flatrate/rent/buy), so `CatalogProvider` has no `type` field. Consumed by the `getWatchProviders` callable (spec 0060), NOT the daily sync.
- `createTraktClient(config: TraktClientConfig): TraktClient` — factory returning
  a client with two methods:
  - `getCalendar(startDate, days)` → `Promise<TraktCalendarEntry[]>` — every show
    airing in `[startDate, startDate + days)` (the all-shows calendar; filtering
    to tracked titles is the sync engine's job).
  - `getShowTraktId(tmdbId)` → `Promise<number | null>` — resolve a TMDB show id
    to its Trakt show id (no match / `404` → `null`).
- `createSyncEngine(config: SyncEngineConfig): SyncEngine` — factory returning a
  sync engine with one method:
  - `sync(titles: SyncTitleInput[])` → `Promise<SyncResult[]>` — runs one sync
    pass over the caller-supplied `{ tmdbId, type }[]`, writing refreshed
    metadata + per-region availability and returning a structured per-title
    result with the detected transitions. When `retryErroredPasses > 0` it then
    re-runs only the titles whose outcome was a **retryable** error (`429` or a
    `0` transport failure) for up to that many extra passes, so a transient rate
    limit never permanently skips a title's availability write for the day
    (spec 0089 / D2). Returns exactly one result per input title, in input order.
- `createFirestoreTitleCacheStore(db: Firestore): TitleCacheStore` — the
  Admin-SDK adapter (spec 0009) implementing the engine's `TitleCacheStore` port
  against `firebase-admin` Firestore. A thin map onto the spec-0005
  `@vultus/shared/firestore-schema` path builders + converters — **no business
  logic** (transition detection + the snapshot roll stay in the engine). Pass it
  the `Firestore` instance from `firebase-admin/firestore`; it is the only place
  `firebase-admin` enters the slice.
- `gatherUserWatchlistTitles(db: Firestore, uid: string): Promise<GatheredUserTitle[]>`
  — the **per-user** watchlist gather for the manual `triggerSync` callable (spec
  0025). Reads ONLY the calling user's `users/{uid}/watchlist` collection (a single
  `.get()` via the `@vultus/shared/firestore-schema` `watchlistPath(uid)` builder —
  no `where`/`orderBy`, so no composite index), projects each doc to its two raw
  primitive fields `{ tmdbId, type }` (no converter — avoids the `addedAt`
  Timestamp), and dedupes by `tmdbId`. Distinct from the cron's global
  `collectionGroup('watchlist')` scan in `apps/functions`. The `triggerSync`
  callable (`apps/functions/src/main.ts`) **consumes** this to gather the caller's
  own titles before running one force-fresh engine pass.
- Types: `TmdbClientConfig`, `TmdbClient`, `RegionProviders`, `TraktClientConfig`,
  `TraktClient`, `TraktCalendarEntry`, `SyncEngine`, `SyncEngineConfig`,
  `SyncTitleInput`, `TitleCacheStore`, `SyncResult`, `ProviderTransition`,
  `SyncOutcome`, `GatheredUserTitle`.
- Errors: `TmdbError`, `TraktError` (kept distinct — each carries `status` +
  `endpoint`, neither embeds its credential).

Return types are `@vultus/shared/domain` types where one exists (`TitleMetadata`,
`WatchProvider`, `Episode`); `RegionProviders` and `TraktCalendarEntry` are thin
slice-internal contract types added only where the domain has no matching shape.
`TraktCalendarEntry` nests a domain `Episode` alongside the show identity
(`traktId`, `tmdbId | null`, `showTitle`) so the sync engine can join a calendar
entry to a tracked title by id. A `404` maps to `null` (TMDB methods,
`getShowTraktId`) or `[]` (`getCalendar`); `TmdbError`/`TraktError` is thrown for
`401`/`403`, any `5xx`, transport/network failures, and a `429` whose retries are
exhausted.

## Usage

```ts
import {
  createTmdbClient,
  createTraktClient,
} from '@vultus/functions/sync-titles';

const tmdb = createTmdbClient({ readAccessToken });
const fightClub = await tmdb.getMovie(603);

const trakt = createTraktClient({ clientId });
const traktId = await trakt.getShowTraktId(1396);
const airing = await trakt.getCalendar('2026-06-20', 7);
```

Each credential — the TMDB v4 read-access token and the Trakt Client ID — is
**injected by the caller**; this library never reads either from env or any
secret. `fetch` is injectable via `config.fetch` (defaults to global `fetch`) so
tests can mock HTTP. The Trakt client uses the **api-key-only** all-shows
calendar — no OAuth, no user access token.

### Date handling: Trakt vs TMDB

TMDB returns **date-only** `"YYYY-MM-DD"` values that the TMDB mappers normalize
to a full ISO-8601 UTC instant (`…T00:00:00.000Z`). Trakt's `first_aired` is
**already a full ISO-8601 UTC instant**, so the Trakt mapper passes it through to
`Episode.airDate` **unchanged** — no midnight synthesis, no truncation. A
calendar entry missing `first_aired`/`episode.season`/`episode.number` is
**skipped** (those map to required `Episode` fields).

`getCalendar` validates `startDate` against `^\d{4}-\d{2}-\d{2}$` (a malformed
string throws a plain `TypeError` before any fetch — a programming error, not an
HTTP failure) and clamps `days` into `[1, 33]` (`Math.trunc` first).

### The sync engine

`createSyncEngine({ tmdb, trakt, store, now? })` runs one sync pass. All
dependencies are **injected**, mirroring the client factories:

- `tmdb` / `trakt` — the `TmdbClient` / `TraktClient` above (or any object with
  the same method shapes).
- `store` — a `TitleCacheStore`: the Firebase-free persistence port the engine
  writes through. It is **domain-typed** (`@vultus/shared/domain`) and keys on
  `tmdbId` / `Region` — the exact PLAN §4 `title-cache` keys — with four methods:
  `getEntry(tmdbId)`, `getAvailability(tmdbId)`, `putEntry(tmdbId, entry)`,
  `putAvailability(tmdbId, region, availability)`. The engine imports **no**
  Firebase SDK; the real Admin-SDK adapter is the HTTP-function spec's (#12) thin
  wiring layer over `titleCacheDocPath` / `availabilityDocPath` + the spec-0005
  converters.
- `now?` — an injectable clock for deterministic `lastSyncedAt` and transition
  timestamps. Defaults to `() => new Date().toISOString()`.
- `retryErroredPasses?` — extra passes re-running only the titles whose outcome
  was a **retryable** error (`429` or `0` transport). Default `0` (current
  behavior, so existing callers are unaffected). Spec 0089 / D2.
- `retryDelayMs?` — cooldown (ms) slept before each retry pass. Default `0`.

Per input `{ tmdbId, type }`, in order: fetch metadata (`getMovie` for movies,
`getTvShow` for tv) — a `null` (TMDB 404) is a clean **skip** (no write); for
**tv only**, resolve the show's `traktId` — but **reuse a cached non-null
`traktId`** from `store.getEntry(tmdbId)` (traktId is stable, so re-resolving it
every run is pure Trakt-call waste, spec 0089 / D2) and only call
`getShowTraktId(tmdbId)` when the cache has a `null`/absent traktId; movies never
resolve a traktId (`traktId` stays `null`); write the entry; then fetch
`getWatchProviders` and, per returned region, detect transitions and write the
rolled availability.

**Second-pass retry (D2).** After the initial pass, up to `retryErroredPasses`
additional passes re-run only the subset of titles whose result is
`outcome: 'error'` with a **retryable** `errorStatus` (`429` rate limit or `0`
transport/network), sleeping `retryDelayMs` between passes. A later pass's
`synced`/`skipped` (or newer error) supersedes the earlier error; non-retryable
errors (`401`/`403`/`5xx`) are never re-tried. The result array always has one
entry per input title, in input order.

**Transition baseline + snapshot roll.** Transitions are detected by diffing the
freshly fetched providers (`next`) against the **stored current `providers`**
(`prev`; absent → `[]`), keyed by `providerId`: a `providerId` only in `next` is
`added`, only in `prev` is `removed`, in both is unchanged (presence only — a
bucket change like flatrate→rent yields no transition in v1). The written
`previousSnapshot` is set to **that prior `providers`** (not the stored
`previousSnapshot`), so the snapshot rolls forward by exactly one pass. The
first-ever sync uses `prev = []` (every provider `added`, `previousSnapshot`
written `[]`).

**Per-title error isolation.** Any throw for one title (`TmdbError`/`TraktError`
— `errorStatus` captured from its `status` — or any other error, including a
store-write failure) is caught and recorded as that title's
`outcome: 'error'` with a credential-free `reason`; the batch continues. A title
that errors after its entry write is a partial success recorded as `'error'`.

**Boundary: no notifications, no episodes.** The engine writes **only**
`title-cache` entry + availability through the port. It writes no `users/**`
document, no notification, and does not fetch the Trakt calendar or season
episodes — those are #12 (HTTP function) / #14 (`dispatch-notifications`)
concerns that **consume** the availability writes this engine makes.

```ts
import { createSyncEngine } from '@vultus/functions/sync-titles';

const engine = createSyncEngine({ tmdb, trakt, store });
const results = await engine.sync([
  { tmdbId: 603, type: 'movie' },
  { tmdbId: 1396, type: 'tv' },
]);
```

## Boundaries

- The clients + engine import only `@vultus/shared/domain` (`Episode`,
  `WatchProvider`, `Region`, `TitleCacheEntry`, `RegionAvailability`,
  `TitleType`, `WatchProviderType`, etc.).
- **No persistence SDK in the engine** — it writes through the injected,
  domain-typed `TitleCacheStore` port: no `firebase-admin`,
  `@google-cloud/firestore`, `firebase-functions`, no
  `@vultus/shared/firestore-schema`, no secret access, no HTTP runtime
  dependency (native `fetch` only).
- **`firebase-admin` enters the slice in exactly one file** —
  `store/firestore-title-cache-store.ts`, the Admin-SDK adapter (spec 0009),
  which also imports `@vultus/shared/firestore-schema` (path builders +
  converters). Nothing else in the slice imports a Firebase SDK; the engine
  stays SDK-free.

## Internal layout

`src/lib/` is grouped by data source, behind the single `src/index.ts` barrel
(the only public surface):

- `tmdb/` — TMDB v3 client (`tmdb-client.ts`), its DTOs (`tmdb-dtos.ts`), mappers
  (`tmdb-mappers.ts`), and error (`tmdb-error.ts`) plus their specs.
- `trakt/` — Trakt API v2 client (`trakt-client.ts`), DTOs (`trakt-dtos.ts`),
  mappers (`trakt-mappers.ts`), and error (`trakt-error.ts`) plus their specs.
- `shared/` — the auth-agnostic HTTP transport (`http.ts`) consumed by both
  clients (imported as `../shared/http`).
- `engine/` — the title-cache sync engine: the factory + orchestration
  (`sync-engine.ts`), the pure transition-detection function (`transitions.ts`),
  the `TitleCacheStore` port (`store.ts`), and the contract types (`types.ts`)
  plus their specs. Depends on the `tmdb/` + `trakt/` client types in-slice and
  on `@vultus/shared/domain`; imports no Firebase SDK.
- `store/` — the Admin-SDK persistence adapter (`firestore-title-cache-store.ts`)
  implementing the engine's `TitleCacheStore` port against `firebase-admin`
  Firestore via the spec-0005 `@vultus/shared/firestore-schema` path builders +
  converters, plus its spec. The only file in the slice that does `title-cache`
  reads/writes via `firebase-admin`; it adds no business logic.
- `gather/` — the per-user watchlist gather (`user-gather.ts`,
  `gatherUserWatchlistTitles`) for the manual `triggerSync` callable (spec 0025),
  plus its spec. Reads one user's `users/{uid}/watchlist` via the
  `@vultus/shared/firestore-schema` `watchlistPath(uid)` builder, projecting raw
  `{ tmdbId, type }` and deduping by `tmdbId`. Takes a `firebase-admin` `Firestore`
  but only as a typed parameter (no SDK init/import beyond the `Firestore` type).

Only the symbols re-exported from `src/index.ts` are public; DTOs, mappers, and
the http transport are slice-internal.

## Future work

The in-slice HTTP transport in `src/lib/shared/http.ts` (min-interval throttle,
`429`/`Retry-After` retry with an exponential-backoff-with-jitter **floor**,
`404` sentinel, status → injected-error mapping) is now **auth-agnostic** and
shared by both clients in this slice — headers, base URL, and error factory are
injected per client. It stays in this slice rather than being extracted to
`shared/`, per the vertical-slice 3+-consumers rule (there is still exactly one
consuming slice).

**429 backoff (spec 0089 / D2).** On a `429` the transport waits
`max(Retry-After, backoffBaseMs * 2^attempt + jitter)`, capped at 60s
(`MAX_RETRY_AFTER_MS`), for up to `maxRetries` attempts. `Retry-After` is still
honored when present; the exponential **floor** only bites the no-header case,
which previously retried immediately. `HttpCoreConfig` gains
`backoffBaseMs?` (default 500; `0` disables the floor) and an injectable
`sleep?` (default `setTimeout`-based) so tests can assert the wait values.
`DEFAULT_MAX_RETRIES` in both clients is **5** (was 3); both accept a
`backoffBaseMs?` config passed through to the transport.

The HTTP sync function (PLAN §6 item 12) is **built** in spec 0009 and **sharded
over Cloud Tasks** in spec 0101: the `apps/functions` `syncTitles` `onRequest`
handler is now an **enqueue coordinator**, not an inline pipeline. It authenticates
(shared-secret / Firebase-Auth dual auth), rate-limits the user path, runs **ONE
consolidated `collectionGroup('watchlist')` gather per run** — down from three
separate gathers — and folds that single read into every downstream stage's input
(`apps/functions/src/lib/gather.ts` `consolidateGather`): the distinct title union
(deduped by `tmdbId`, staleness-filtered) for the **title-sync** stage, the per-user
TV episode fan-out assignments, the distinct TV show `tmdbId`s for the
**episode-cache** stage, and the distinct TV-tracking uids for the **airing-scan**
stage. It opens a `sync-run-progress/{runId}` staging doc, persists the downstream
inputs under that doc's `staged/*` subcollection, enqueues a delayed dead-run
watchdog, and fans the title work out into `title-sync` Cloud Tasks shards — no
pipeline work runs inline. `titleSyncWorker` (`onTaskDispatched`) is where **this
lib's `createSyncEngine` + `createFirestoreTitleCacheStore(db)` actually run**, over
one shard's title subset; its last shard hands off to the episode-cache stage. The
lib's public surface (engine, clients, `gatherUserWatchlistTitles`) is **unchanged**
by the sharding — only where/how the engine is invoked moved.

Related pieces (other slices / apps, not this lib):

- **daily-sync cron** (`.github/workflows/daily-sync.yml`) — a GitHub Actions
  schedule that `POST`s to `syncTitles` with the shared secret; since spec 0101 it
  gates on **enqueue success** (the run's outcome is observed later in
  `sync-runs/{runId}`), not synchronous pipeline completion.
- **dispatch-notifications** — a separate slice that reacts to the `title-cache`
  availability writes this engine makes, fanning out per-user notifications.

## Testing

```
nx test functions-sync-titles
```

Vitest, with `fetch` mocked.
