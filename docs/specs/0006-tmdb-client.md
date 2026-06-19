---
number: 0006
slug: tmdb-client
title: Add a typed TMDB API client to the sync-titles functions slice
status: implementing
slices: [slice:sync-titles]
scopes: [scope:functions]
created: 2026-06-18
---

# Add a typed TMDB API client to the sync-titles functions slice

## Context

PLAN §6 item 9 calls for a TMDB client living in `functions/sync-titles`:
"Auth, rate-limiting, `getMovie`, `getTvShow`, `getWatchProviders`,
`getSeasonEpisodes`. Unit tests with mocked HTTP." TMDB is the project's source
of title metadata and per-region streaming availability (PLAN §2 — its
`watch/providers` endpoint is JustWatch-powered).

This spec is the **first of a three-way split** of the `sync-titles` slice. It
delivers **only the TMDB client**. The two follow-on specs will add the **Trakt
calendar client** (PLAN §6 item 10) and then the **sync engine + HTTP function**
(PLAN §6 items 11–12) that orchestrate both clients, compute transitions against
`previousSnapshot`, and persist to `title-cache`. This client therefore **only
fetches and maps**; it does not persist, orchestrate, detect transitions, wire
secrets/config, or expose any HTTP/callable function.

It is also the **first `libs/functions/*` slice** — `libs/functions/` does not
exist yet. Task 1 generates `libs/functions/sync-titles`, which Sheriff
auto-tags `scope:functions` + `slice:sync-titles` by path-glob (no
`sheriff.config.ts` edit needed; see Affected slices). The lib uses the same
Vitest/tsconfig conventions as the shared libs, but node-targeted.

Intended outcome: an agent implementing the Trakt client or the sync engine can
`import { createTmdbClient, TmdbError } from '@vultus/functions/sync-titles'`
and fetch a movie/show's `TitleMetadata`, a title's per-region
`WatchProvider[]` map, and a season's `Episode[]` — all backed by
`@vultus/shared/domain` types — without touching HTTP, secrets, or Firestore
themselves.

## Scope

In scope:

- Generate the **first functions slice lib** `libs/functions/sync-titles`
  (node-targeted, Vitest unit tests, no build target — see Implementation task
  graph task 1).
- A **typed TMDB v3 REST client** in that lib, exposed via a factory
  `createTmdbClient(config)` returning a client object with four methods:
  `getMovie`, `getTvShow`, `getWatchProviders`, `getSeasonEpisodes`.
- **HTTP via the native global `fetch`** (Node 20+), **injectable** for tests:
  the config accepts an optional `fetch` (default: global `fetch`). **Zero
  runtime HTTP dependencies** — no axios/undici/nock/msw.
- **Auth via an injected TMDB v4 read-access bearer token** sent as
  `Authorization: Bearer <token>`. The token is a **config parameter**, never
  read from env/secret by this client.
- **Resilience**: retry on HTTP `429` honoring the `Retry-After` header (capped
  retries + simple backoff), plus a light throttle (a min-interval between
  requests / effective concurrency of ~1). Right-sized for a personal daily
  sync — no exponential-backoff-on-5xx machinery.
- **Mapping TMDB JSON → domain types**: raw TMDB response shapes are
  **slice-internal DTOs** (not exported, not domain types); the methods return
  `@vultus/shared/domain` types (`TitleMetadata`, `WatchProvider`, `Episode`).
- A **slice-internal `TmdbError`** type carrying the HTTP status.
- **Pure Vitest unit tests** with an injected mock `fetch` (no live network, no
  emulator, no secrets).
- Export the client factory, its config type, the result types that form the
  sync-engine contract, and `TmdbError` from the lib barrel `src/index.ts`.

Out of scope (each belongs to a later spec):

- **Persistence.** No write to `title-cache` / `availability`, no import of
  `@vultus/shared/firestore-schema`. (Spec 0005 / the sync engine own that.)
- **Orchestration & transition detection.** No "given a list of tmdbIds" loop,
  no diff against `previousSnapshot`. (Sync engine, PLAN §6 item 11.)
- **Secret / config provisioning.** No reading of `.env.local`, no
  `firebase-functions` config/params, no env access. The bearer token is
  injected by the caller. (HTTP-function/sync-engine spec, PLAN §6 item 12.)
- **HTTP / callable function surface.** No `firebase-functions` handler. This is
  a library only.
- **The Trakt client.** (PLAN §6 item 10, next spec.)
- **TMDB search, discover, credits, images-config, or any endpoint beyond the
  four methods listed.** Search is the mobile `slice:search`'s concern
  (PLAN §6 item 17), not this functions client.
- **A Watchmode fallback** for NL accuracy (PLAN §9) — a later, separate
  concern; this client only wraps TMDB.

## Affected slices & Sheriff tags

| Project (nx name TBD — see below) | Path                         | Sheriff tags                           |
| --------------------------------- | ---------------------------- | -------------------------------------- |
| sync-titles functions slice (new) | `libs/functions/sync-titles` | `scope:functions`, `slice:sync-titles` |

- The tags are assigned **automatically by `sheriff.config.ts`** via the
  existing path-glob key `'libs/functions/<slice>': ['scope:functions',
'slice:<slice>']`. This spec **does not edit `sheriff.config.ts`** — generating
  the lib at exactly `libs/functions/sync-titles` is what makes the glob match
  and tag it. (The `slice:sync-titles` tag is already declared in the Sheriff
  vocabulary; no lib carries it yet — this lib is the first.)
- **Import boundaries (verified against `sheriff.config.ts`):**
  - The Sheriff rule `'scope:functions': ['scope:shared', 'scope:functions']`
    permits this lib to import `@vultus/shared/domain` (`scope:shared`). It
    **must NOT** import `scope:mobile` (rule 1) — there is no reason to.
  - The rule `'slice:*': ['scope:shared', sameTag]` permits importing only
    `scope:shared` and the same slice. This client imports **only
    `@vultus/shared/domain`**; it must **not** import any other slice and must
    **not** import `@vultus/shared/firestore-schema` (no persistence here — that
    is allowed by Sheriff as `scope:shared` but is **deliberately excluded** by
    this spec's scope; a reviewer should flag any such import).
- **Not a premature `shared/` extraction.** All TMDB DTOs, the
  fetch/retry/throttle core, the mappers, and `TmdbError` are **slice-owned**
  and live inside `libs/functions/sync-titles`. The Trakt client (next spec)
  will be a separate concern in the **same slice** — duplication within the
  slice is acceptable per PLAN §3; nothing is hoisted to `shared/` (the
  "extract only at 3+ slices" rule is respected — there is exactly one consumer).

## Data model touchpoints

**None written.** This spec persists nothing and creates no Firestore
collections, indexes, converters, or rules.

It does, however, **produce values shaped to fit** the PLAN §4 model so the
later sync engine can persist them directly:

| PLAN §4 target (written LATER by the sync engine)                          | This client returns                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `title-cache/{tmdbId}.metadata` (`TitleMetadata`)                          | `getMovie` / `getTvShow` → `TitleMetadata`                                                              |
| `title-cache/{tmdbId}/availability/{region}.providers` (`WatchProvider[]`) | `getWatchProviders` → per-`Region` `WatchProvider[]`                                                    |
| `users/{userId}/watchlist/{titleId}/episodes/*` (`EpisodeDoc`)             | `getSeasonEpisodes` → `Episode[]` (the persistence-agnostic value subset: `season`/`episode`/`airDate`) |

`getMovie`/`getTvShow` return **`TitleMetadata`** specifically because that is
exactly the shape `title-cache.metadata` stores (the caller already knows
`tmdbId`, the `TitleType`, and that `traktId` is `null` until the Trakt step
fills it). The client does **not** invent any new persisted shape.

## Public types / APIs

All public surface is exported through the lib barrel
`libs/functions/sync-titles/src/index.ts`. The new path alias
**`@vultus/functions/sync-titles`** is added to `tsconfig.base.json` `paths` by
the generator (matching the existing slash-separated `@vultus/shared/<name>`
convention — see Implementation task graph task 1).

### Config + factory

```ts
import type {
  TitleType,
  Region,
  WatchProvider,
  Episode,
} from '@vultus/shared/domain';
import type { TitleMetadata } from '@vultus/shared/domain';

export interface TmdbClientConfig {
  /** TMDB v4 read-access token, sent as `Authorization: Bearer <token>`.
   *  INJECTED by the caller — the client NEVER reads it from env/secret. */
  readAccessToken: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to 'https://api.themoviedb.org/3'. */
  baseUrl?: string;
  /** Metadata language for overview/title/poster selection. Defaults to 'en-US'.
   *  (watch/providers returns all regions regardless of language.) */
  language?: string;
  /** Resilience knobs — all optional with conservative personal-sync defaults
   *  (see Resilience below). */
  maxRetries?: number; // 429 retry cap; default 3
  minRequestIntervalMs?: number; // throttle floor between requests; default ~250ms
}

export interface TmdbClient {
  getMovie(tmdbId: number): Promise<TitleMetadata | null>;
  getTvShow(tmdbId: number): Promise<TitleMetadata | null>;
  getWatchProviders(
    tmdbId: number,
    type: TitleType,
  ): Promise<Partial<Record<Region, WatchProvider[]>> | null>;
  getSeasonEpisodes(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<Episode[] | null>;
}

export function createTmdbClient(config: TmdbClientConfig): TmdbClient;
```

(A class implementing the same surface is an acceptable alternative to the
factory, provided the constructor takes the same `TmdbClientConfig` with an
injectable `fetch` and an injected token, and the barrel exports it. The
factory form is recommended.)

### Error type (slice-internal, exported from the barrel)

```ts
export class TmdbError extends Error {
  /** HTTP status that caused the failure, or 0 for a network/transport error. */
  readonly status: number;
  /** The endpoint path that failed (e.g. '/movie/603'), for diagnostics — must
   *  NOT include the bearer token. */
  readonly endpoint: string;
  constructor(message: string, status: number, endpoint: string);
}
```

`TmdbError` is a **slice-internal** error (not a domain type). It is exported so
the sync engine can `instanceof`-check it.

### Method semantics

> The endpoint contracts and field mappings below were verified against the
> current TMDB v3 API reference on 2026-06-19.

- **`getMovie(tmdbId)`** → `GET /movie/{tmdbId}?language=<language>`. Map
  `title`→`title`, `overview`→`overview`, `poster_path`→`posterPath`
  (`string | null`), `release_date`→`releaseDate` (normalized per air-date rule
  below; empty string `""` → `null`). Returns `TitleMetadata`. **404 → `null`.**
- **`getTvShow(tmdbId)`** → `GET /tv/{tmdbId}?language=<language>`. Same as
  `getMovie` but TV uses **`name`** (not `title`) → `title`, and
  **`first_air_date`** → `releaseDate`. Returns `TitleMetadata`. **404 → `null`.**
- **`getWatchProviders(tmdbId, type)`** → `GET /movie/{tmdbId}/watch/providers`
  or `GET /tv/{tmdbId}/watch/providers` (chosen by `type`). TMDB returns
  `results` keyed by ISO-3166 country code, each with `flatrate` / `rent` / `buy`
  arrays of `{ provider_id, provider_name, display_priority, logo_path }`.
  Mapping (see decision below): keep only countries in `REGIONS`; within each
  kept region, flatten the `flatrate`/`rent`/`buy` buckets into
  `WatchProvider[]` where the **bucket name becomes `WatchProvider.type`**,
  `provider_id`→`providerId`, `provider_name`→`name`. **Buckets other than
  `flatrate`/`rent`/`buy` (TMDB also returns `ads`/`free`) are dropped** —
  `WatchProviderType` has no member for them. `display_priority`/`logo_path` are
  ignored; likewise the response's top-level `id` and each country's `link` field
  are present in the TMDB response but are **not modeled** by the internal DTO.
  Returns `Partial<Record<Region, WatchProvider[]>>`. **404 → `null`.**
- **`getSeasonEpisodes(tmdbId, seasonNumber)`** →
  `GET /tv/{tmdbId}/season/{seasonNumber}?language=<language>`. Map each entry in
  `episodes[]` to `Episode`: prefer `season_number` for `season` (fall back to
  the `seasonNumber` argument if absent), `episode_number`→`episode`,
  `air_date`→`airDate` (normalized per air-date rule). Returns `Episode[]`
  (**empty array** if the season has no episodes). **404 → `null`.**

### Not-found vs error (decision 4)

- **`404` → `null`** for every method (title/providers/season not found). The
  engine can skip a `null` cleanly.
- **Throw `TmdbError`** for: `401` (bad/expired token), any `5xx`, a network /
  transport failure (`fetch` rejects → `TmdbError` with `status: 0`), and
  `429` after retries are exhausted. The `TmdbError.status` carries the HTTP
  status (or `0` for transport).

### getWatchProviders region-map representation (decision 5)

- Return type is **`Partial<Record<Region, WatchProvider[]>>`**: include a key
  **only for regions in `REGIONS` that TMDB actually returned**. A region TMDB
  did not return is **absent** (no key) rather than mapped to `[]`. Rationale:
  the sync engine iterates the returned regions and writes availability per
  region; "TMDB returned this country with zero matching providers" (key present,
  empty array — e.g. all its providers were `ads`/`free`) is **distinct** from
  "TMDB had nothing for this country" (key absent). Both are representable:
  - country in `REGIONS`, has ≥1 flatrate/rent/buy provider → key present,
    non-empty array;
  - country in `REGIONS`, present but only `ads`/`free` providers → key present,
    **empty array**;
  - country in `REGIONS`, absent from TMDB `results` → **key absent**;
  - country **not** in `REGIONS` (e.g. `IT`, `CA`) → **dropped entirely**.

### air_date / release_date normalization (decision)

TMDB date fields (`air_date`, `release_date`, `first_air_date`) are **date-only
`"YYYY-MM-DD"`**, and may be `null`, missing, or empty string `""` for unaired
/ unreleased content.

- **Normalize a present, non-empty date-only string to a full ISO-8601 UTC
  instant: `"YYYY-MM-DD"` → `"YYYY-MM-DDT00:00:00.000Z"`** (i.e. `new
Date(`${d}T00:00:00.000Z`).toISOString()`). This is consistent across all
  three fields and round-trips through spec 0005's `new Date(iso)` converter.
- **`releaseDate`** (movie/tv metadata) is `string | null` in `TitleMetadata`,
  so a `null`/missing/empty date → **`null`**.
- **`Episode.airDate` is a required `string`** in the domain (no `null`
  allowed). Therefore **episodes with a `null`/missing/empty `air_date` are
  SKIPPED** (omitted from the returned `Episode[]`) — an unaired episode has no
  air date to track, and the sync engine notifies on _aired_ episodes. This is
  stated explicitly so the behavior is contractual, not incidental. (Alternative
  considered: widen `Episode.airDate` to `string | null` in `shared/domain` —
  rejected here to avoid changing the merged domain type for a follow-on
  concern; revisit in the sync-engine spec if unaired episodes must be tracked.)

### Internal DTOs (NOT exported, NOT domain types)

The raw TMDB JSON shapes (`TmdbMovieResponse`, `TmdbTvResponse`,
`TmdbWatchProvidersResponse`, `TmdbSeasonResponse`, `TmdbProviderEntry`, etc.)
are declared inside the lib (e.g. `src/lib/tmdb-dtos.ts`) and are **not**
re-exported from the barrel. They model `snake_case` TMDB fields; the mappers
convert them to the `camelCase` domain types. Keeping them internal preserves
the vertical-slice contract (the public surface is domain-typed only).

## UI / Stitch screen refs

Not applicable. This is a `scope:functions` library — no mobile slice, no
screen, no design-system tokens.

## Implementation task graph

Single slice, single `backend-engineer`. **All tasks `[sequential]`** — there is
one lib and the tasks share `src/index.ts`, the DTOs, and the core, so there is
no safe parallel fan-out. Task 1 is a **foundation/root operation** (it mutates
`tsconfig.base.json` and the Nx project graph) and must complete before any code
is written.

1. **[sequential] Generate the `libs/functions/sync-titles` lib (foundation —
   touches root config + project graph).**
   - Run the Nx JS-library generator (the workspace has `@nx/js` 23.0.0 and uses
     Vitest), node-targeted, landing at exactly `libs/functions/sync-titles`:

     ```
     pnpm nx g @nx/js:library sync-titles \
       --directory=libs/functions/sync-titles \
       --unitTestRunner=vitest \
       --bundler=none \
       --linter=eslint \
       --importPath=@vultus/functions/sync-titles
     ```

     (`--bundler=none` so the lib gets **no build target** — matching the shared
     libs, which expose only `lint`/`typecheck`/`test` via the inferred
     `@nx/vite` / `@nx/eslint` / `@nx/vitest` plugins. Confirm the generated
     `project.json` has empty/absent `targets` like `libs/shared/domain`.)

   - **Verify / adjust** the generated lib to match the shared-lib conventions:
     - `vite.config.mts` with `test.name: '<nx project name>'`,
       `environment: 'node'`, `passWithNoTests: true`, the same `include` glob
       (`src/**/*.{test,spec}.…`), coverage dir under
       `coverage/libs/functions/sync-titles`.
     - `tsconfig.lib.json` extends `tsconfig.json`, `types: ["node"]`, excludes
       `*.spec.ts`/`*.test.ts`/`vite.config.mts`; `tsconfig.spec.json` includes
       `vitest/globals` + `node` types. Match `libs/shared/domain`'s trio.
     - `eslint.config.mjs` re-exports the root config (`[...baseConfig]`).
   - **Do NOT add Sheriff tags to `project.json`** — Sheriff path-glob
     (`libs/functions/<slice>`) tags the lib automatically; assert this rather
     than re-asserting tags in `project.json` (consistent with spec 0001).
   - Confirm the generator added the `@vultus/functions/sync-titles` →
     `libs/functions/sync-titles/src/index.ts` entry to `tsconfig.base.json`
     `paths`. If the generator emits a different alias form, **rename it to the
     slash form `@vultus/functions/sync-titles`** to match the
     `@vultus/shared/<name>` convention.
   - **Determine and record the nx project name** the generator assigns (likely
     `functions-sync-titles`; `@nx/js` derives the name from the directory).
     Verify with `pnpm nx show projects` / `pnpm nx show project
functions-sync-titles`. Use that exact name in all `nx` target invocations
     (Definition of done). Remove any placeholder `lib.ts`/`*.spec.ts` the
     generator scaffolds once real code lands.
   - Files: `libs/functions/sync-titles/**`, `tsconfig.base.json` (`paths`),
     and Nx graph state (no `sheriff.config.ts` edit).

2. **[sequential] Internal DTOs + `TmdbError`.**
   - Add `src/lib/tmdb-dtos.ts` (internal, non-exported `snake_case` response
     interfaces for movie, tv, watch/providers, season/episodes, provider entry).
   - Add `src/lib/tmdb-error.ts` exporting `TmdbError` (status + endpoint;
     endpoint string must never embed the token).
   - Files: `libs/functions/sync-titles/src/lib/tmdb-dtos.ts`,
     `libs/functions/sync-titles/src/lib/tmdb-error.ts`.

3. **[sequential] Fetch / retry / throttle core.**
   - Add `src/lib/http.ts` (or similar): a small internal `request<T>(path,
init)` that injects `Authorization: Bearer <token>` + `Accept:
application/json`, applies the language query param where relevant, enforces
     `minRequestIntervalMs` (serialize requests / effective concurrency ~1),
     retries `429` up to `maxRetries` honoring `Retry-After`
     (seconds → ms; cap), returns parsed JSON on 2xx, returns a sentinel for
     `404`, and throws `TmdbError` for `401`/`5xx`/transport/`429`-exhausted. The
     token must **never** be logged or placed in error messages/endpoint strings.
   - Files: `libs/functions/sync-titles/src/lib/http.ts`.

4. **[sequential] The four methods + mappers + factory.**
   - Add `src/lib/mappers.ts` (DTO→domain: metadata mapping incl. tv `name`→
     `title`, the date normalization + skip/null rules, watch-provider region
     filtering + bucket→`type` mapping dropping `ads`/`free` and non-`REGIONS`
     countries, episode mapping).
   - Add `src/lib/tmdb-client.ts` exporting `createTmdbClient(config)` /
     `TmdbClientConfig` / `TmdbClient`, wiring the core + mappers into the four
     methods with the 404→null semantics.
   - Files: `libs/functions/sync-titles/src/lib/mappers.ts`,
     `libs/functions/sync-titles/src/lib/tmdb-client.ts`.

5. **[sequential] Barrel exports.**
   - `src/index.ts` re-exports `createTmdbClient`, `TmdbClientConfig`,
     `TmdbClient`, `TmdbError`, and any result type aliases that form the
     sync-engine contract (the per-region map type alias if one is named).
     Internal DTOs and the http/mapper internals are **not** exported.
   - Files: `libs/functions/sync-titles/src/index.ts`.

6. **[sequential] Unit tests (mock `fetch`).**
   - Per Test plan. Co-located `*.spec.ts` under `src/lib/`.
   - Files: `libs/functions/sync-titles/src/lib/*.spec.ts`.

## Test plan

Per the PLAN §5 pyramid — this is a logic-heavy library, so the surface is
**unit tests only**: pure Vitest with an **injected mock `fetch`**. **No live
network, no Firebase emulator, no secrets** (tests pass a dummy token like
`'test-token'`). The mock `fetch` returns `Response`-like objects (status,
`headers.get('Retry-After')`, `json()`).

Unit tests (lots) must cover:

- **`getMovie` happy path**: maps `title`/`overview`, `poster_path`→`posterPath`,
  `release_date`→`releaseDate` normalized to `…T00:00:00.000Z`.
- **`getTvShow` happy path**: maps **`name`→`title`** (not `title`),
  `first_air_date`→`releaseDate`.
- **Null metadata fields**: `poster_path: null` → `posterPath: null`;
  empty/missing `release_date`/`first_air_date` → `releaseDate: null`.
- **`getWatchProviders` mapping**: a `results` payload with several countries —
  assert (a) `flatrate`/`rent`/`buy` each map to the right `WatchProvider.type`,
  `provider_id`→`providerId`, `provider_name`→`name`; (b) a **non-`REGIONS`
  country (e.g. `IT`) is dropped**; (c) a **`REGIONS` country present with only
  `ads`/`free` buckets yields an empty array** (key present, empty); (d) a
  `REGIONS` country **absent** from the payload yields **no key**; (e)
  `display_priority`/`logo_path` are ignored.
- **`getSeasonEpisodes` mapping**: `episode_number`→`episode`,
  `season_number`→`season`, `air_date` normalized; **an episode with
  `air_date: null`/`""`/missing is skipped**; a season with `episodes: []`
  returns `[]`.
- **404 → `null`** for each of the four methods.
- **Errors throw `TmdbError`** with the right `status`: `401`, a `5xx`, and a
  **transport failure** (mock `fetch` rejects) → `status: 0`.
- **Retry/throttle**:
  - `429` **with `Retry-After`** then `200` → resolves with the mapped value
    (assert the retry happened, e.g. `fetch` called twice).
  - `429` repeated past `maxRetries` → **throws `TmdbError`** with `status: 429`.
  - (Keep timing assertions fast — inject a small `minRequestIntervalMs` /
    short `Retry-After`, or fake timers, so tests do not actually sleep long.)
- **Auth header**: assert every request sends
  `Authorization: Bearer <token>` and `Accept: application/json`.
- **Token never logged / leaked**: assert the token does not appear in any
  `TmdbError.message`/`.endpoint`, and (if a console spy is used) is not logged.

Component tests: **none** (no UI). e2e tests: **none** (no flow, no emulator, no
Playwright, no secrets).

## Definition of done

Tailored from the PLAN §5 checklist (no component/e2e/build/emulator — a
node library with no UI, no flow, and no build target):

- [ ] `pnpm nx typecheck <project>` passes (`<project>` = the nx name from task
      1, e.g. `functions-sync-titles`) — `tsc --noEmit -p tsconfig.lib.json`.
- [ ] `pnpm nx lint <project>` passes **with Sheriff active**: the new lib is
      tagged `scope:functions` + `slice:sync-titles` by path-glob and imports
      **only `@vultus/shared/domain`** — no `scope:mobile`, no other slice, no
      `@vultus/shared/firestore-schema`.
- [ ] `pnpm nx test <project>` passes (all unit tests green).
- [ ] **No build target is invoked** — confirm the lib has none (generated with
      `--bundler=none`, like the shared libs). If the generator unexpectedly
      added one, remove it to match convention.
- [ ] `pnpm nx affected -t lint typecheck test --base=main` is green (the
      affected set for this change is the new lib; `tsconfig.base.json` `paths`
      changes may also pull in projects that resolve the alias — all must stay
      green).
- [ ] The barrel `@vultus/functions/sync-titles` exports `createTmdbClient`,
      `TmdbClientConfig`, `TmdbClient`, and `TmdbError`; internal DTOs and
      http/mapper internals are **not** exported.
- [ ] **No secret is read or written** — no `.env.local`/env/`firebase-functions`
      config access; the token is an injected config param and tests use a dummy.
      No HTTP dependency was added to `package.json` (native `fetch` only).
- [ ] No `@vultus/shared/firestore-schema` import; nothing persisted.
- [ ] PR description records the exact verification commands and the resolved nx
      project name + alias.

## Risks

- **TMDB watch-provider NL accuracy (PLAN §9).** TMDB/JustWatch availability is
  known to have gaps for licensed (non-original) content in NL. This is a
  **data-quality risk handled later** (Watchmode fallback, encapsulated per
  slice per PLAN §2/§9), **not this client's concern** — the client faithfully
  surfaces whatever TMDB returns. Flagged so a reviewer does not expect accuracy
  handling here.
- **Provider buckets beyond flatrate/rent/buy.** TMDB also returns `ads` and
  `free` buckets; `WatchProviderType` has no member for them, so they are
  **dropped** (decided above). If the product later wants to surface ad-supported
  availability, that is a `shared/domain` change (add a `WatchProviderType`
  member) plus a mapper update — out of scope here.
- **Date-only → ISO-instant normalization.** Coercing date-only
  `"YYYY-MM-DD"` to `…T00:00:00.000Z` fixes the timezone interpretation at UTC
  midnight. Spec 0005's converter does `new Date(iso)`, which parses it fine; the
  trade-off is that a release "date" carries a spurious midnight-UTC time. Stated
  and accepted (consistent across all three date fields).
- **Unaired episodes are skipped.** Because `Episode.airDate` is a required
  `string`, episodes lacking an `air_date` are omitted. If the sync engine later
  needs to know about scheduled-but-unaired episodes, widening
  `Episode.airDate` to `string | null` in `shared/domain` is the follow-on path
  (noted, not done here).
- **Rate-limit assumptions.** The throttle/retry is sized for a personal **daily
  sync of a small watchlist**, not high throughput. `429` is retried with
  `Retry-After`; `5xx` is **not** retried (fail fast, the daily cron re-runs
  tomorrow). If TMDB tightens limits or the watchlist grows large, revisit in the
  sync-engine spec. TMDB's `append_to_response` could fold `watch/providers`
  into the detail call to cut request count, but is **deliberately not used** —
  each method issues one focused request, which is fine at personal-daily-sync
  scale.
- **nx project name / alias drift.** The generator derives the project name from
  the directory (expected `functions-sync-titles`) and may emit a non-slash
  import alias; both are pinned above (verify the name via `nx show projects`,
  normalize the alias to `@vultus/functions/sync-titles`). Not a PLAN conflict —
  consistent with PLAN §3 paths and the `@vultus/shared/<name>` alias convention.
- **No PLAN conflict.** This implements PLAN §6 item 9 as the first third of the
  sync-titles slice; the only deviations from item 9's one-liner are the
  deliberate deferrals (no rate-limiting _config wiring_, no orchestration) to
  the sync-engine spec, which §6 separates into items 11–12.
