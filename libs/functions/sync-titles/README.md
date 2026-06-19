# functions-sync-titles

The `sync-titles` functions slice (`scope:functions`, `slice:sync-titles`) — the
first `libs/functions/*` slice. It currently contains a typed TMDB v3 REST
client. The Trakt calendar client and the sync engine are follow-on specs
(PLAN §6 items 10–12) that will live in this same slice.

## Public API

Imported from `@vultus/functions/sync-titles`:

- `createTmdbClient(config: TmdbClientConfig): TmdbClient` — factory returning a
  client with four methods:
  - `getMovie(tmdbId)` → `Promise<TitleMetadata | null>`
  - `getTvShow(tmdbId)` → `Promise<TitleMetadata | null>`
  - `getWatchProviders(tmdbId, type)` → `Promise<RegionProviders | null>`
  - `getSeasonEpisodes(tmdbId, seasonNumber)` → `Promise<Episode[] | null>`
- Types: `TmdbClientConfig`, `TmdbClient`, `RegionProviders`.
- `TmdbError`.

Return types are `@vultus/shared/domain` types (`TitleMetadata`,
`WatchProvider`, `Episode`). A `404` response maps to `null`. `TmdbError` is
thrown for `401`, any `5xx`, transport/network failures, and a `429` whose
retries are exhausted.

## Usage

```ts
import { createTmdbClient } from '@vultus/functions/sync-titles';

const client = createTmdbClient({ readAccessToken });
const fightClub = await client.getMovie(603);
```

The TMDB v4 read-access token is **injected by the caller** — this library never
reads it from env or any secret. `fetch` is also injectable via
`config.fetch` (defaults to global `fetch`) so tests can mock HTTP.

## Boundaries

- Imports only `@vultus/shared/domain`.
- No persistence, no `firebase-functions`, no secret access.

## Future work

The generic HTTP transport in `src/lib/http.ts` (min-interval throttle,
`429`/`Retry-After` retry, `404` sentinel, status → `TmdbError` mapping) is
reusable in-slice by the upcoming Trakt client. It will be generalized (auth
header made parameterizable) when that client lands — and stay in this slice
rather than be extracted to `shared/`, per the vertical-slice 3+-consumers rule.

## Testing

```
nx test functions-sync-titles
```

Vitest, with `fetch` mocked.
