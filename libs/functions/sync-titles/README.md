# functions-sync-titles

The `sync-titles` functions slice (`scope:functions`, `slice:sync-titles`) — the
first `libs/functions/*` slice. It contains two typed REST clients: a TMDB v3
client (streaming availability + metadata + episodes) and a Trakt API v2
calendar client (upcoming/aired episodes). Both run over a single in-slice HTTP
transport. The sync engine that orchestrates them is a follow-on spec
(PLAN §6 items 11–12) that will live in this same slice.

## Public API

Imported from `@vultus/functions/sync-titles`:

- `createTmdbClient(config: TmdbClientConfig): TmdbClient` — factory returning a
  client with four methods:
  - `getMovie(tmdbId)` → `Promise<TitleMetadata | null>`
  - `getTvShow(tmdbId)` → `Promise<TitleMetadata | null>`
  - `getWatchProviders(tmdbId, type)` → `Promise<RegionProviders | null>`
  - `getSeasonEpisodes(tmdbId, seasonNumber)` → `Promise<Episode[] | null>`
- `createTraktClient(config: TraktClientConfig): TraktClient` — factory returning
  a client with two methods:
  - `getCalendar(startDate, days)` → `Promise<TraktCalendarEntry[]>` — every show
    airing in `[startDate, startDate + days)` (the all-shows calendar; filtering
    to tracked titles is the sync engine's job).
  - `getShowTraktId(tmdbId)` → `Promise<number | null>` — resolve a TMDB show id
    to its Trakt show id (no match / `404` → `null`).
- Types: `TmdbClientConfig`, `TmdbClient`, `RegionProviders`, `TraktClientConfig`,
  `TraktClient`, `TraktCalendarEntry`.
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

## Boundaries

- Imports only `@vultus/shared/domain` (`Episode`, etc.).
- No persistence, no `@vultus/shared/firestore-schema`, no `firebase-functions`,
  no secret access. No HTTP runtime dependency (native `fetch` only).

## Future work

The in-slice HTTP transport in `src/lib/http.ts` (min-interval throttle,
`429`/`Retry-After` retry, `404` sentinel, status → injected-error mapping) is
now **auth-agnostic** and shared by both clients in this slice — headers, base
URL, and error factory are injected per client. It stays in this slice rather
than being extracted to `shared/`, per the vertical-slice 3+-consumers rule
(there is still exactly one consuming slice). The remaining follow-on is the
**sync engine + HTTP function** (PLAN §6 items 11–12): orchestrate both clients,
compute transitions against `previousSnapshot`, and persist to `title-cache`.

## Testing

```
nx test functions-sync-titles
```

Vitest, with `fetch` mocked.
