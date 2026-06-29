---
number: 0035
slug: fix-watchlist-poster-image
title: Fix watchlist — denormalize posterPath and voteAverage on add
status: approved
slices: [slice:search]
scopes: [scope:mobile]
created: 2026-06-29
---

## Context

The watchlist list view shows the fallback placeholder instead of a poster
image for every title added via search (GitHub issue #80). The root cause is a
**missing denormalization on write**: when a user adds a title,
`SearchService.add()` constructs a `WatchlistItem` but omits `posterPath` and
`voteAverage`, so the document persisted to Firestore has those fields written
as `null` (the `watchlistItemToData` converter defaults absent fields to
`null`). `WatchlistPage.posterUrl()` derives its image URL from the stored
`posterPath`; with a null path it always returns null and the template renders
the `poster-fallback` div.

The data needed to fix this is already fetched from TMDB on every search hit —
the client computes the full `posterUrl` from `poster_path` but discards the raw
path, and never captures `vote_average` at all. The fix is to carry
`posterPath` and `voteAverage` through `SearchResult` so `add()` can denormalize
them onto the `WatchlistItem`. The shared domain type and the Firestore
converter already model both fields correctly — only the search slice needs to
populate them.

Intended outcome: titles added to the watchlist after this change store their
TMDB `posterPath` and `voteAverage`, so the watchlist renders real poster
artwork.

## Scope

In:

- Add `posterPath: string | null` and `voteAverage: number | null` to the
  `SearchResult` interface (`tmdb-search.client.ts`).
- Capture `poster_path` and `vote_average` from the raw TMDB response into the
  mapped `SearchResult` (and add those two optional fields to `RawTmdbResult`).
- Populate `posterPath` and `voteAverage` on the `WatchlistItem` written by
  `SearchService.add()`.
- Update the two affected unit-test fixtures/assertions.

Out of scope:

- **No backfill / migration.** Items already in Firestore without `posterPath`
  keep rendering the existing `poster-fallback` div. This is acceptable (decision
  record §4).
- **No watchlist-slice changes.** `WatchlistPage` already reads `posterPath` and
  renders the poster when present; it needs no edits.
- **No shared-lib changes.** `WatchlistItem` (`shared/domain`) and
  `watchlistItemToData` (`shared/firestore-schema`) already model and persist
  both fields.
- **No UI / template / styling changes** in any slice.
- **No new types in `shared/domain`** — `SearchResult` is search-slice-local and
  stays so.

## Affected slices & Sheriff tags

- `libs/mobile/search` — tags `scope:mobile`, `slice:search`. The only slice
  touched.

No cross-slice imports are introduced. `SearchService` already imports
`WatchlistItem` from `@vultus/shared/domain` and `watchlistItemToData` /
`watchlistItemPath` from `@vultus/shared/firestore-schema` (both `scope:shared`)
— this change only sets two already-modeled fields and adds no new import. The
"extract only at 3+ slices" rule is not engaged: nothing new is shared.

## Data model touchpoints

No schema or security-rule changes. The two fields already exist in PLAN §4's
watchlist item shape and in code:

- `libs/shared/domain/src/lib/documents.ts` — `WatchlistItem.posterPath?:
  string | null` and `WatchlistItem.voteAverage?: number | null` (already
  defined).
- `libs/shared/firestore-schema/src/lib/converters.ts` — `watchlistItemToData`
  already writes `posterPath: item.posterPath ?? null` and `voteAverage:
  item.voteAverage ?? null`.

This spec only changes which values reach those fields at write time:
previously always `null`, now the real TMDB values when present. Firestore
collection path is unchanged (`users/{uid}/watchlist/{tmdbId}` via
`watchlistItemPath`).

## Public types / APIs

Changed type — `SearchResult` (`libs/mobile/search/src/lib/tmdb-search.client.ts`):

```ts
export interface SearchResult {
  tmdbId: number;
  type: TitleType; // 'movie' | 'tv'
  title: string;
  year: number | null;
  posterUrl: string | null;
  posterPath: string | null; // NEW — raw TMDB poster_path, e.g. '/abc.jpg'; null when unknown
  voteAverage: number | null; // NEW — TMDB vote_average 0–10; null when unknown
}
```

`SearchResultView extends SearchResult` (in `search.service.ts`) inherits both
new fields automatically — no separate edit needed there.

Changed internal type — `RawTmdbResult` (same file) gains:

```ts
  poster_path?: string | null; // already present
  vote_average?: number | null; // NEW
```

No callable, HTTP, or endpoint shapes change.

## UI / Stitch screen refs

Not applicable. This is a data-write fix with no template, layout, or styling
change in any slice. The watchlist poster rendering and its `poster-fallback`
are already implemented in `WatchlistPage`; no Stitch screen is touched, so no
screen capture is required.

## Implementation task graph

Single slice, single sequential thread — there is no parallel fan-out (every
change is in `libs/mobile/search` and the steps share files).

1. **[sequential] Extend the TMDB client mapping** —
   `libs/mobile/search/src/lib/tmdb-search.client.ts`:
   - Add `posterPath: string | null` and `voteAverage: number | null` to the
     `SearchResult` interface.
   - Add `vote_average?: number | null` to the `RawTmdbResult` interface
     (`poster_path` already present).
   - In the `.map((r) => { ... })` that builds the `SearchResult`, add:
     - `posterPath: r.poster_path ?? null`
     - `voteAverage: r.vote_average ?? null`
   - Leave the existing `posterUrl` computation unchanged.

2. **[sequential] Denormalize on write** —
   `libs/mobile/search/src/lib/search.service.ts`, the `add()` method (the
   `const item: WatchlistItem = { ... }` literal, ~line 130): add
   - `posterPath: result.posterPath ?? null`
   - `voteAverage: result.voteAverage ?? null`

   No other `add()` logic (optimistic update, rollback, duplicate guard,
   re-throw) changes.

3. **[sequential] Update unit tests** — see Test plan. Touches
   `tmdb-search.client.spec.ts` and `search.service.spec.ts`.

4. **[sequential] Update README** — `libs/mobile/search/README.md` **line 29**.
   It enumerates the normalized TMDB hit fields and currently reads:
   `Normalized TMDB hit: tmdbId, type, title, year, posterUrl`. Add the two new
   `SearchResult` fields so it reads:
   `Normalized TMDB hit: tmdbId, type, title, year, posterUrl, posterPath, voteAverage`.
   This edit is required (CLAUDE.md: "Library READMEs stay current — update its
   README.md in the same change").

## Test plan

Unit (Vitest + Analog) — the only tier required; logic-only change.

`libs/mobile/search/src/lib/tmdb-search.client.spec.ts`:

- Add `vote_average: 7.5` to the `movieResult` fixture (it already has
  `poster_path: '/poster.jpg'`).
- In the "maps movie + tv results" test, extend the `results[0]`
  `toMatchObject` assertion to include `posterPath: '/poster.jpg'` and
  `voteAverage: 7.5`.
- For `tvResult` (`poster_path: null`, no `vote_average`), assert `results[1]`
  has `posterPath: null` and `voteAverage: null` — confirms the `?? null`
  fallbacks.

`libs/mobile/search/src/lib/search.service.spec.ts`:

- In the existing `add() writes to correct path with planned status` test, add
  `posterPath: '/movie-x.jpg'` and `voteAverage: 6.4` to the `result` object,
  and extend the write-data assertion:
  `expect(writeData['posterPath']).toBe('/movie-x.jpg')` and
  `expect(writeData['voteAverage']).toBe(6.4)`.
- Add a focused case asserting that when a `SearchResult` has
  `posterPath: null` / `voteAverage: null`, the written doc carries both as
  `null` (guards the `?? null` path through `add()` → `watchlistItemToData`).

> Note: the other `add()` fixtures in `search.service.spec.ts` (optimistic,
> rollback, re-throw, no-op cases) construct `result` literals without the new
> fields. Since `posterPath`/`voteAverage` are required on `SearchResult`, those
> literals must be updated to include both fields (e.g. `posterPath: null,
> voteAverage: null`) or TypeScript will fail to compile the spec. Update all
> `SearchResult` literals across the two spec files for type-correctness; only
> the assertions above need new expectations. The 8 affected literals are: in
> `tmdb-search.client.spec.ts`, the `movieResult` and `tvResult` fixtures; in
> `search.service.spec.ts`, the literals at approximately lines 106, 136, 162,
> 183, 209, 230, 242, 254 (the `mockResults` arrays are easy to miss).

Component: none — no component with non-trivial state changes.

e2e: **No new e2e flows required — data-write fix, no new page/route or action.**
No existing e2e flow is modified by this spec.

## Definition of done

- `pnpm nx lint search` green (ESLint + Sheriff; no new cross-slice import, no
  boundary change).
- `pnpm nx test search` green, including the updated client and service specs
  and the new null-fallback assertions.
- `pnpm nx build search` (and affected `apps/mobile`) typechecks — all
  `SearchResult` literals in tests and source satisfy the two new required
  fields.
- `nx affected -t lint test build --base=main` green for the affected graph.
- The search slice has tests for the changed logic (client mapping + `add()`
  denormalization) — satisfied by the Test plan.
- `libs/mobile/search/README.md` line 29 updated to add `posterPath` and
  `voteAverage` to the enumerated normalized-hit fields (required).
- No e2e flow regressions; no new e2e required (justified above).

## Risks

- **Existing items show no poster (by design).** Documents written before this
  change have `posterPath: null` and keep the fallback. There is no backfill;
  acceptable per decision record §4. If a backfill is later wanted, it is a
  separate spec.
- **TMDB field accuracy.** `vote_average` is a TMDB-provided float 0–10 and may
  be `0` for unrated/new titles (distinct from `null`). The `?? null` mapping
  preserves a real `0` as `0` and only substitutes `null` when the field is
  absent — correct, but consumers must not treat `0` as "missing". `poster_path`
  can legitimately be `null` (no artwork on TMDB), in which case the fallback is
  still the correct render.
- **Required-field ripple in tests.** Making `posterPath`/`voteAverage` required
  on `SearchResult` forces every `SearchResult` literal in the spec files (and
  any other in-slice construction) to provide them; the Test plan calls this out
  so the implementer updates all literals rather than only the asserted ones.
- No PLAN conflict: the change stays within `slice:search`, touches no shared
  lib, and uses fields already in the PLAN §4 data model.
