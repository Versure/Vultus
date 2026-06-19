---
number: 0007
slug: trakt-client
title: Add a typed Trakt calendar client to the sync-titles functions slice
status: approved
slices: [slice:sync-titles]
scopes: [scope:functions]
created: 2026-06-19
---

# Add a typed Trakt calendar client to the sync-titles functions slice

## Context

PLAN §6 item 10 calls for a Trakt client living in `functions/sync-titles`:
"Trakt client (in functions/sync-titles) — Auth, getCalendar. Unit tests with
mocked HTTP." Trakt is the project's source of **upcoming-episode / calendar
data** (PLAN §2 — Trakt supplies what's airing and when; it explicitly does
**not** provide streaming availability, which is TMDB's role).

This spec is the **second of a three-way split** of the `sync-titles` slice.
Spec 0006 (merged, `done`) delivered the typed **TMDB client** in this same
slice. This spec adds the **Trakt calendar client** alongside it. The third
follow-on spec (PLAN §6 items 11–12) will add the **sync engine + HTTP
function** that orchestrates both clients, computes transitions against
`previousSnapshot`, and persists to `title-cache`. This client therefore **only
fetches and maps**; it does not persist, orchestrate, detect transitions, wire
secrets/config, filter to tracked titles, or expose any HTTP/callable function.

It is the twin of the TMDB client: same "inject a credential, never read a
secret" shape, same slice-internal DTO/error/transport discipline, same
unit-tests-only surface. The one structural change it introduces is
**generalizing the existing in-slice HTTP transport** (`src/lib/http.ts`) so the
identifying/auth headers and base URL are injectable — exactly the reuse the
0006 transport's header comment anticipated ("the Trakt calendar client … can
reuse this transport by making the Authorization header injectable").

Intended outcome: an agent implementing the sync engine can
`import { createTraktClient, TraktError } from '@vultus/functions/sync-titles'`
and (a) resolve a TMDB id to a Trakt show id (filling `Title.traktId`, which
0006 left `null` "until the Trakt step fills it"), and (b) fetch every show
airing in a date window as `TraktCalendarEntry[]` — backed by
`@vultus/shared/domain` `Episode` values — without touching HTTP, secrets, or
Firestore itself.

## Scope

In scope:

- A **typed Trakt API v2 client** in the existing `libs/functions/sync-titles`
  lib, exposed via a factory `createTraktClient(config)` returning a client
  object with two methods: `getCalendar` and `getShowTraktId`.
- **Generalize the existing in-slice HTTP transport** `src/lib/http.ts` so the
  auth/identifying headers and base URL are **injectable per client**, while the
  throttle / `429`+`Retry-After` retry / `404` sentinel / status→error core
  stays a single in-slice implementation reused by both the TMDB and Trakt
  clients. **The TMDB client and its tests MUST remain green** after this
  refactor (hard constraint — see Definition of done and Risks).
- **Trakt auth via an injected client id (api key)**: requests send
  `trakt-api-key: <clientId>` + `trakt-api-version: 2` + `Content-Type:
  application/json`. The client id is a **config parameter**, never read from
  env/secret by this client. **No OAuth** (no user access token, no Trakt-side
  user watchlist).
- **HTTP via the native global `fetch`** (Node 20+), **injectable** for tests
  (config accepts an optional `fetch`, default: global `fetch`). **Zero runtime
  HTTP dependencies** — carried forward from 0006.
- **Resilience** reused from the generalized core: serialized requests
  (effective concurrency ~1), retry on `429` honoring `Retry-After` (capped),
  no `5xx` retry. Right-sized for a personal daily sync.
- **Mapping Trakt JSON → domain/contract types**: raw Trakt response shapes are
  **slice-internal DTOs** (`snake_case`, not exported, not domain types). The
  calendar method returns `TraktCalendarEntry[]`, a **slice-internal contract
  type** (exported for the sync engine) that associates a show identity with a
  `@vultus/shared/domain` `Episode`.
- A **slice-internal `TraktError`** type carrying the HTTP status + endpoint,
  kept **distinct** from `TmdbError`.
- **Pure Vitest unit tests** with an injected mock `fetch` (no live network, no
  emulator, no secrets; dummy client id like `'test-client-id'`).
- Export the Trakt factory, its config type, `TraktClient`,
  `TraktCalendarEntry`, and `TraktError` from the lib barrel `src/index.ts`,
  alongside **all existing TMDB exports** — `createTmdbClient`,
  `TmdbClientConfig`, `TmdbClient`, `TmdbError`, and the named result alias
  `RegionProviders` (the 0006 analogue of `TraktCalendarEntry`). None of these
  may be dropped.

Out of scope (each belongs to a later spec or another source):

- **The OAuth calendar variant** `GET /calendars/my/shows/...` and any OAuth
  flow (device code, token exchange, refresh). This client uses the **api-key
  only** all-shows calendar.
- **Movie / DVD calendars** (`/calendars/all/movies`, `/calendars/all/dvd`).
  Movie availability/release is TMDB's job (PLAN §2) and overlaps TMDB's
  `release_date`; only the **TV upcoming-episode** calendar is in scope.
- **Filtering the calendar to tracked titles.** The all-shows calendar returns
  every show airing in the window; matching entries to the user's watchlist is
  the **sync engine's** job (PLAN §6 item 11), not this client's.
- **Persistence.** No write to `title-cache`, no import of
  `@vultus/shared/firestore-schema`.
- **Orchestration & transition detection.** No diff against `previousSnapshot`.
- **Secret / config provisioning.** No `.env.local`/env/`firebase-functions`
  config access. The client id is injected by the caller.
- **HTTP / callable function surface.** Library only.
- **Any Trakt endpoint beyond the two methods** (no `/shows/{id}/seasons`, no
  user lists, no scrobble, no ratings, no `/sync/*`).

## Affected slices & Sheriff tags

| Project              | Path                         | Sheriff tags                           |
| -------------------- | ---------------------------- | -------------------------------------- |
| functions-sync-titles | `libs/functions/sync-titles` | `scope:functions`, `slice:sync-titles` |

- The lib **already exists** (created by spec 0006) and is tagged
  `scope:functions` + `slice:sync-titles` **automatically by
  `sheriff.config.ts`** via the path-glob `'libs/functions/<slice>'`. This spec
  **does not edit `sheriff.config.ts`** and **does not add a path alias** — the
  `@vultus/functions/sync-titles` → `…/src/index.ts` entry already exists in
  `tsconfig.base.json` from 0006.
- **Import boundaries (verified against `sheriff.config.ts`):**
  - The Trakt client imports **only `@vultus/shared/domain`** (`Episode`, and
    `TitleType` only if a method needs it). Sheriff rule
    `'scope:functions': ['scope:shared', 'scope:functions']` and
    `'slice:*': ['scope:shared', sameTag]` permit this.
  - It must **NOT** import `scope:mobile`, any other slice, or
    `@vultus/shared/firestore-schema` (no persistence — deliberately excluded by
    this spec's scope; a reviewer should flag any such import).
- **Not a premature `shared/` extraction.** The generalized transport, the
  Trakt DTOs, the mappers, and `TraktError` all stay **inside
  `libs/functions/sync-titles`**. Generalizing `http.ts` to serve **two clients
  in the same slice** does **not** trigger the "extract only at 3+ slices" rule
  — there is still exactly **one** consuming slice. The transport stays in-slice
  (not hoisted to `shared/`).

## Data model touchpoints

**None written.** This spec persists nothing and creates no Firestore
collections, indexes, converters, or rules. It does not import
`@vultus/shared/firestore-schema`.

It produces values shaped to feed the PLAN §4 model so the later sync engine can
use them:

| PLAN §4 / sync-engine need                                                       | This client returns                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Fill `title-cache/{tmdbId}.metadata.traktId` (`Title.traktId`, `number \| null`) | `getShowTraktId(tmdbId)` → `number \| null`                                          |
| Detect newly-aired episodes for tracked shows (the `episode-aired` notification) | `getCalendar(startDate, days)` → `TraktCalendarEntry[]` (show identity + `Episode`)  |

The calendar entries carry a **show identity** (`traktId`, optional `tmdbId`,
`showTitle`) so the sync engine can match an entry to a tracked title by id, and
a domain `Episode` (`season`/`episode`/`airDate`) so it knows which episode
aired and when. The client does **not** invent any new persisted shape; show
identity is a slice-internal contract type, not a domain entity.

## Public types / APIs

All new public surface is exported through the existing lib barrel
`libs/functions/sync-titles/src/index.ts`. No new path alias is added. The
barrel must continue to export the full 0006 TMDB surface — `createTmdbClient`,
`TmdbClientConfig`, `TmdbClient`, `RegionProviders`, `TmdbError` — **and** add
the Trakt surface below. `RegionProviders` (the named per-region result alias
in `tmdb-client.ts`) is the 0006 analogue of `TraktCalendarEntry` and must NOT
be dropped.

### Config + factory

```ts
import type { Episode } from '@vultus/shared/domain';

export interface TraktClientConfig {
  /** Trakt application Client ID, sent as the `trakt-api-key` header.
   *  INJECTED by the caller — the client NEVER reads it from env/secret. */
  clientId: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to 'https://api.trakt.tv'. */
  baseUrl?: string;
  /** 429 retry cap; default 3. */
  maxRetries?: number;
  /** Throttle floor between requests in ms; default 250. */
  minRequestIntervalMs?: number;
}

export interface TraktClient {
  /** Every show airing in [startDate, startDate + days). Filtering to tracked
   *  titles is the sync engine's job. */
  getCalendar(startDate: string, days: number): Promise<TraktCalendarEntry[]>;
  /** Resolve a TMDB show id to its Trakt show id. No match / 404 → null. */
  getShowTraktId(tmdbId: number): Promise<number | null>;
}

export function createTraktClient(config: TraktClientConfig): TraktClient;
```

(A class implementing the same surface is an acceptable alternative, provided
its constructor takes the same `TraktClientConfig` with an injectable `fetch`
and injected `clientId`, and the barrel exports it. The factory form is
recommended, matching `createTmdbClient`.)

### Calendar contract type (slice-internal, exported from the barrel)

```ts
/** A single show episode airing in the calendar window. Slice-internal contract
 *  for the sync engine — NOT a `@vultus/shared/domain` type (the domain
 *  `Episode` carries no show identity). */
export interface TraktCalendarEntry {
  /** Trakt show id (the all-shows calendar is keyed by it). */
  traktId: number;
  /** Show's TMDB id from Trakt's `show.ids.tmdb`; null when Trakt has none. */
  tmdbId: number | null;
  /** Show title (diagnostics / fallback display). */
  showTitle: string;
  /** The airing episode as the domain value type. */
  episode: Episode;
}
```

**Decision — flattened-vs-nested shape.** `TraktCalendarEntry` keeps the show
identity at the top level and **nests the domain `Episode`** rather than
flattening `season`/`episode`/`airDate`. Rationale: the nested `Episode` is the
exact domain value the sync engine already persists to
`users/{userId}/watchlist/{titleId}/episodes/*`, so it passes through untouched;
the surrounding `traktId`/`tmdbId`/`showTitle` is the join key the engine needs
to match an entry to a tracked title. This mirrors how 0006 returned domain
types directly (`Episode[]`, `TitleMetadata`) and added a thin slice-internal
alias (`RegionProviders`) only where the domain had no matching shape.

### Error type (slice-internal, exported from the barrel)

```ts
export class TraktError extends Error {
  /** HTTP status that caused the failure, or 0 for a network/transport error. */
  readonly status: number;
  /** The endpoint path that failed (e.g. '/search/tmdb/603?type=show'), for
   *  diagnostics — MUST NOT include the client id. */
  readonly endpoint: string;
  constructor(message: string, status: number, endpoint: string);
}
```

**Decision — `TraktError` and `TmdbError` stay separate.** They are kept as two
distinct slice-internal classes (no shared base), mirroring 0006's `TmdbError`
exactly. Rationale: the sync engine `instanceof`-checks each per its source, and
a shared base would be premature abstraction for two tiny error types within one
slice. Both never embed the credential in `message`/`endpoint`.

### Method semantics

> The endpoint paths, required headers, and response field names below were
> **verified against the current Trakt API v2 documentation on 2026-06-19**
> (`trakt.docs.apiary.io`; the all-shows calendar and id-search endpoints). All
> Trakt dates are UTC. The all-shows calendar requires only the `trakt-api-key`
> (Client ID) header — no OAuth. Where a field's exact presence could not be
> re-confirmed live, the assumption is stated inline.

- **`getCalendar(startDate, days)`** →
  `GET /calendars/all/shows/{start_date}/{days}`.
  - **Headers (required):** `trakt-api-key: <clientId>`,
    `trakt-api-version: 2`, `Content-Type: application/json`. **No
    `Authorization` header** (no OAuth).
  - **Path params:** `start_date` is a `YYYY-MM-DD` date; `days` is an integer.
    Trakt documents `days` max **33** and defaults `start_date`=today,
    `days`=7. **Validation/defaults (decision):** validate `startDate` matches
    `^\d{4}-\d{2}-\d{2}$` (throw a plain `TypeError`/`Error` on a malformed
    string — a programming error, not an HTTP failure); clamp `days` into
    `[1, 33]` (coerce a non-integer via `Math.trunc`, clamp out-of-range). The
    client does **not** inject its own default window — the caller (sync engine)
    passes the window explicitly.
  - **Response:** an array of entries, each
    `{ first_aired, episode: { season, number, title, ids }, show: { title,
    year, ids: { trakt, slug, tvdb, imdb, tmdb } } }`.
  - **Mapping → `TraktCalendarEntry`:** `show.ids.trakt`→`traktId`,
    `show.ids.tmdb`→`tmdbId` (`number | null`; Trakt may return `null`),
    `show.title`→`showTitle`, and `{ episode.season → season,
    episode.number → episode, first_aired → airDate }` → the domain `Episode`.
    Returns `TraktCalendarEntry[]` (**empty array** when nothing airs in the
    window). This method does **not** 404 in normal operation; a `404` (if
    Trakt ever returns one for this path) maps to **`[]`**.
- **`getShowTraktId(tmdbId)`** → `GET /search/tmdb/{tmdbId}?type=show`.
  - **Headers:** same three as above.
  - **Credential-in-header-only (invariant):** exactly as 0006, the http core
    receives **only the path** (e.g. `/search/tmdb/603?type=show`); the Trakt
    `clientId` lives **solely** in the `trakt-api-key` header and never appears
    in the path, the request URL, or the `TraktError.endpoint` string. The
    "credential never in path" guarantee carried over from 0006 therefore
    transfers unchanged to the Trakt path.
  - **Response:** an array of search results, each
    `{ type: 'show', score, show: { title, year, ids: { trakt, tmdb, … } } }`.
    A TMDB id with no Trakt match returns an **empty array** (`200 []`), and an
    unknown id type can return `404`.
  - **Mapping (decision):** take the **first** result whose `type === 'show'`
    and return its `show.ids.trakt` (a `number`). If the array is empty, has no
    `type === 'show'` entry, or the response is `404` → return **`null`**.
    (Trakt's `score`-ordered results put the best match first; a TMDB id is a
    near-exact lookup, so first-match is the right pick — matching the
    "resolve one id" intent rather than fuzzy search.)

### Date handling (decision)

Trakt's `first_aired` is a **full ISO-8601 UTC instant** (e.g.
`"2026-06-20T01:00:00.000Z"`), **unlike TMDB's date-only `"YYYY-MM-DD"`** that
0006 had to normalize to `…T00:00:00.000Z`. Therefore:

- **`first_aired` maps to `Episode.airDate` directly with no synthesis** — pass
  it through unchanged (it already round-trips through spec 0005's
  `new Date(iso)` converter). State this contrast with 0006 in the README.
- **`Episode.airDate` is a required `string`** in the domain. A calendar entry
  with a **missing / `null` / empty `first_aired`** is therefore **SKIPPED**
  (omitted from the returned array), mirroring 0006's skip-an-episode-without-an-
  air-date rule. (In practice the calendar only lists scheduled airings, so this
  is defensive; stated so the behavior is contractual.) Likewise an entry
  missing `episode.season` or `episode.number` is skipped.

### Internal DTOs (NOT exported, NOT domain types)

The raw Trakt JSON shapes (`TraktCalendarEntryDto`, `TraktEpisodeDto`,
`TraktShowDto`, `TraktShowIdsDto`, `TraktSearchResultDto`) live inside the lib
(e.g. `src/lib/trakt-dtos.ts`) and are **not** re-exported. Only the fields the
client reads are modeled (Trakt returns much more); they model the `snake_case`
Trakt fields, and the mappers convert them to the `camelCase` contract/domain
types. Same discipline as 0006's `tmdb-dtos.ts`.

### Generalized HTTP transport (refactor of `src/lib/http.ts`)

The single in-slice transport core gains **injectable identifying headers and
base URL** while keeping its throttle / `429`+`Retry-After` retry / `404`
sentinel / status→error behavior. Concretely:

- Replace the TMDB-specific `Authorization: Bearer <token>` construction with a
  **caller-supplied header set** (e.g. `headers: Record<string, string>` on the
  core config, or a `buildHeaders()` hook). TMDB passes
  `{ Authorization: 'Bearer <token>', Accept: 'application/json' }`; Trakt passes
  `{ 'trakt-api-key': '<clientId>', 'trakt-api-version': '2', 'Content-Type':
  'application/json' }`.
- The core must accept an **injectable error constructor / error factory** so it
  throws `TmdbError` for the TMDB client and `TraktError` for the Trakt client
  (the core stays error-type-agnostic), OR keep the throw at the client layer by
  having the core surface a status and the client map it — implementer's choice,
  provided **both** clients end up throwing their own error type with the
  correct `status` + `endpoint`.
- **The credential must never appear** in the URL/path, in any error
  `message`/`endpoint`, or in logs — for **both** auth shapes (carry forward
  0006's token-never-leaks guarantee to the Trakt `trakt-api-key` path).
- **Hard constraint:** the existing TMDB client's public behavior and all its
  tests stay **unchanged and green** after this refactor. The TMDB client's
  wiring is adjusted to the generalized core; its method signatures, return
  values, and error semantics do not change.

## UI / Stitch screen refs

Not applicable. This is a `scope:functions` library — no mobile slice, no
screen, no design-system tokens.

## Implementation task graph

Single slice, single `backend-engineer`. **All tasks `[sequential]`** — there is
one lib and the tasks share `src/lib/http.ts`, the barrel `src/index.ts`, and
the DTO/mapper modules, so there is no safe parallel fan-out. (File manifests are
listed per 0006 convention even though disjointness is moot here.) Task 1 (the
transport generalization) is the shared dependency and must land first.

1. **[sequential] Generalize `src/lib/http.ts` to injectable headers + base
   URL; keep the TMDB client + its tests green.**
   - Refactor the core so identifying/auth headers and base URL are supplied by
     the caller, and the thrown error type is parameterizable (or surfaced for
     the client to map). Adjust the TMDB client's wiring (`tmdb-client.ts`) to
     pass its `Authorization`/`Accept` headers + base URL through the
     generalized core. Update `http.ts`'s header comment to describe the now-
     two-consumer (TMDB + Trakt) in-slice transport.
   - **Should (not a hard gate): neutralize the TMDB-specific names** left over
     from 0006 now that the core has two consumers — rename the `NOT_FOUND`
     sentinel (currently `Symbol('tmdb-not-found')`) to a client-agnostic value
     (e.g. `Symbol('http-not-found')`), de-TMDB the `HttpCoreConfig` field
     naming, and reword the request/throttle comments so the core reads cleanly
     for both clients. (The `NOT_FOUND` rename is internal to the slice — both
     `tmdb-client.ts` and the new `trakt-client.ts` import the sentinel from
     `http.ts`, so update those imports; it is not part of the barrel.)
   - Confirm the TMDB client's `http.spec.ts` / `tmdb-client.spec.ts`
     behavior is unchanged.
   - Files: `libs/functions/sync-titles/src/lib/http.ts`,
     `libs/functions/sync-titles/src/lib/tmdb-client.ts`.

2. **[sequential] Trakt internal DTOs + `TraktError`.**
   - Add `src/lib/trakt-dtos.ts` (internal, non-exported `snake_case` interfaces
     for the calendar entry, episode, show, show-ids, and search result).
   - Add `src/lib/trakt-error.ts` exporting `TraktError` (status + endpoint;
     endpoint string must never embed the client id) — modeled on `tmdb-error.ts`.
   - Files: `libs/functions/sync-titles/src/lib/trakt-dtos.ts`,
     `libs/functions/sync-titles/src/lib/trakt-error.ts`.

3. **[sequential] Trakt mappers.**
   - Add `src/lib/trakt-mappers.ts` (DTO→`Episode`/`TraktCalendarEntry`:
     `first_aired` pass-through, the skip rule for missing
     `first_aired`/`season`/`number`, `show.ids` extraction with
     `tmdbId: number | null`, and the first-`type==='show'`-match extraction for
     the id lookup).
   - Files: `libs/functions/sync-titles/src/lib/trakt-mappers.ts`.

4. **[sequential] The Trakt client factory + methods.**
   - Add `src/lib/trakt-client.ts` exporting `createTraktClient(config)` /
     `TraktClientConfig` / `TraktClient` / `TraktCalendarEntry`, wiring the
     generalized core + Trakt mappers into `getCalendar` and `getShowTraktId`,
     with the `startDate`/`days` validation/clamping and the `404`/empty →
     `[]`/`null` semantics.
   - Files: `libs/functions/sync-titles/src/lib/trakt-client.ts`.

5. **[sequential] Barrel exports + README.**
   - `src/index.ts` adds `createTraktClient`, `TraktClientConfig`,
     `TraktClient`, `TraktCalendarEntry`, and `TraktError` — keeping **all**
     existing TMDB exports (`createTmdbClient`, `TmdbClientConfig`, `TmdbClient`,
     `RegionProviders`, `TmdbError`; the named `RegionProviders` alias in
     particular must NOT be dropped). Internal DTOs and http/mapper internals
     stay unexported.
   - Update `libs/functions/sync-titles/README.md`: add the Trakt client to the
     **Public API** section; rewrite **Future work** (the transport is now
     generalized and shared by both clients in-slice — only the sync engine
     remains); note the `first_aired`-is-already-an-instant contrast with TMDB;
     keep **Boundaries** accurate (still imports only `@vultus/shared/domain`).
   - Files: `libs/functions/sync-titles/src/index.ts`,
     `libs/functions/sync-titles/README.md`.

6. **[sequential] Unit tests (mock `fetch`).**
   - Per Test plan. Co-located `*.spec.ts` under `src/lib/`.
   - Files: `libs/functions/sync-titles/src/lib/trakt-client.spec.ts`,
     `libs/functions/sync-titles/src/lib/trakt-mappers.spec.ts`.

## Test plan

Per the PLAN §5 pyramid — a logic-heavy library, so the surface is **unit tests
only**: pure Vitest with an **injected mock `fetch`**. **No live network, no
Firebase emulator, no secrets** (tests pass a dummy `clientId: 'test-client-id'`).
The mock `fetch` returns `Response`-like objects (status,
`headers.get('Retry-After')`, `json()`).

Trakt unit tests (lots) must cover:

- **`getCalendar` happy path**: a multi-entry payload maps each entry's
  `show.ids.trakt`→`traktId`, `show.ids.tmdb`→`tmdbId`, `show.title`→`showTitle`,
  and `episode.season`/`episode.number`/`first_aired` → the nested `Episode`.
- **Date pass-through**: `first_aired` (a full ISO-8601 UTC instant) is carried
  to `Episode.airDate` **unchanged** — assert **no** `T00:00:00.000Z` synthesis
  and no truncation.
- **Skip rules**: an entry with `first_aired` missing/`null`/`""` is **omitted**;
  an entry missing `episode.season` or `episode.number` is omitted; remaining
  entries still map.
- **`tmdbId` null**: an entry whose `show.ids.tmdb` is `null`/absent yields
  `tmdbId: null` (not dropped).
- **Empty calendar**: `200 []` → `[]`.
- **`getCalendar` input validation** (matches the §"Method semantics"
  validation/defaults decision):
  - A **malformed `startDate`** (e.g. `'2026/06/20'`, `'June 20'`, `''`)
    **throws** synchronously/rejects — assert the thrown value is a plain
    `Error`/`TypeError` and explicitly **NOT** an `instanceof TraktError` (it's
    a programming error, not an HTTP failure), and that **no `fetch` call is
    made**.
  - **`days` clamping/validation**: assert a non-integer `days` is coerced via
    `Math.trunc` and an out-of-range `days` is clamped into `[1, 33]` — e.g.
    `days: 0` → `1`, `days: 50` → `33`, `days: 7.9` → `7` — by asserting the
    clamped value appears in the request path (`/calendars/all/shows/{date}/{n}`)
    that the mock `fetch` receives.
- **`getShowTraktId` happy path**: a search payload's first `type === 'show'`
  result → its `show.ids.trakt` (a number).
- **`getShowTraktId` no match**: `200 []` → `null`; a payload with no
  `type === 'show'` entry → `null`.
- **404 semantics**: `getShowTraktId` `404` → `null`; `getCalendar` `404` → `[]`.
- **Errors throw `TraktError`** with the right `status`: `401`, `403`, a `5xx`,
  and a **transport failure** (mock `fetch` rejects) → `status: 0`.
- **Retry/throttle** (reused core):
  - `429` **with `Retry-After`** then `200` → resolves with the mapped value
    (assert `fetch` called twice).
  - `429` repeated past `maxRetries` → **throws `TraktError`** with `status: 429`.
  - Keep timing fast (small `minRequestIntervalMs` / short `Retry-After` / fake
    timers).
- **Required headers**: assert every Trakt request sends `trakt-api-key:
  <clientId>` **and** `trakt-api-version: 2` (and `Content-Type:
  application/json`), and **no** `Authorization` header.
- **Client id never leaked**: assert the client id does not appear in any
  `TraktError.message`/`.endpoint`, the request URL/path, and (if a console spy
  is used) is not logged.
- **TMDB regression assertion**: after the `http.ts` generalization, assert the
  **TMDB client still behaves** — its existing tests pass unchanged, and add at
  least one explicit assertion that a TMDB request still sends
  `Authorization: Bearer <token>` + `Accept: application/json` (and no Trakt
  headers) through the generalized core. (May live in the existing TMDB spec.)

Component tests: **none** (no UI). e2e tests: **none** (no flow, no emulator, no
Playwright, no secrets).

## Definition of done

Tailored from the PLAN §5 checklist (no component/e2e/build/emulator — a node
library with no UI, no flow, and no build target). `<project>` is the existing
nx name `functions-sync-titles`.

- [ ] `pnpm nx typecheck functions-sync-titles` passes
      (`tsc --noEmit -p tsconfig.lib.json`).
- [ ] `pnpm nx lint functions-sync-titles` passes **with Sheriff active**: the
      lib still imports **only `@vultus/shared/domain`** — no `scope:mobile`, no
      other slice, no `@vultus/shared/firestore-schema`.
- [ ] `pnpm nx test functions-sync-titles` passes (all unit tests green).
- [ ] **The TMDB client + all its existing tests remain green after the
      `http.ts` generalization** — its public behavior, signatures, and error
      semantics are unchanged (explicit gate; see Risks).
- [ ] **No build target is invoked** — the lib still has none.
- [ ] `pnpm nx affected -t lint typecheck test --base=main` is green.
- [ ] The barrel `@vultus/functions/sync-titles` exports `createTraktClient`,
      `TraktClientConfig`, `TraktClient`, `TraktCalendarEntry`, and `TraktError`
      **in addition to** all existing TMDB exports (`createTmdbClient`,
      `TmdbClientConfig`, `TmdbClient`, `RegionProviders`, `TmdbError` — the
      named `RegionProviders` alias must NOT be dropped); internal DTOs and
      http/mapper internals are **not** exported.
- [ ] **No secret is read or written** — no `.env.local`/env/`firebase-functions`
      config access; the client id is an injected config param and tests use a
      dummy. **No HTTP dependency added** to `package.json` (native `fetch`
      only); **no OAuth** flow/token.
- [ ] No `@vultus/shared/firestore-schema` import; nothing persisted.
- [ ] `libs/functions/sync-titles/README.md` is updated **in the same change**
      (Public API + Future work + boundaries + the `first_aired` instant note),
      per CLAUDE.md's lib-README rule.
- [ ] PR description records the exact verification commands and confirms the
      TMDB-stays-green check.

## Risks

- **The `http.ts` generalization could regress the TMDB client.** Mitigated by
  keeping the TMDB client's public surface unchanged, retaining all its existing
  tests, and adding an explicit regression assertion (TMDB still sends
  `Authorization: Bearer`, no Trakt headers). Called out as a DoD gate.
- **All-shows calendar payload size / Trakt rate limits.** The all-shows
  calendar returns every show airing in the window; at personal-daily-sync scale
  the window is small (a few days, max 33) and **filtering to tracked titles is
  the sync engine's job**, so the payload is bounded and the client just maps
  it. Trakt enforces documented rate limits; this client retries `429` honoring
  `Retry-After` and does **not** retry `5xx` (fail fast; the daily cron re-runs).
- **Trakt id ≠ TMDB id; a TMDB id may have no Trakt match.** `getShowTraktId`
  returns `null` for an empty search result or `404`; the sync engine must
  tolerate a `null` `traktId` (a tracked title simply won't be matchable against
  the Trakt-keyed calendar until a match exists).
- **`tmdbId` on a calendar entry may be `null`.** Trakt's `show.ids.tmdb` is not
  guaranteed present; the mapper sets `tmdbId: null` and keeps the entry (the
  engine can still match on `traktId`). Handled gracefully, not dropped.
- **Trakt response-shape verification.** Paths, headers, and field names were
  verified against the Trakt API v2 docs on 2026-06-19; the v2 calendar/search
  shapes (`first_aired`, `episode.{season,number,title,ids}`,
  `show.ids.{trakt,tmdb,slug,…}`, search `[{type, score, show}]`) are stable.
  Where a field's exact presence could not be re-confirmed live, the mapper
  treats it defensively (skip on missing required fields, `null` on missing
  optional ids) rather than assuming.
- **No PLAN conflict.** This implements PLAN §6 item 10 as the **second third**
  of the `sync-titles` slice; the deferrals (no orchestration, no persistence,
  no OAuth, no tracked-title filtering) are pushed to the sync-engine spec
  (PLAN §6 items 11–12), consistent with §2 (Trakt = calendar only, no streaming
  availability) and §3 (vertical slice; transport stays in-slice).
