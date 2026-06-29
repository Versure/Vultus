---
number: 0043
slug: fix-media-type-hint-navigation
title: 'Fix: thread media-type hint through navigation to prevent wrong-title TMDB collision'
status: done
slices: [slice:search, slice:watchlist, slice:title-detail]
scopes: [scope:mobile]
created: 2026-06-29
---

# 0043 — Fix: thread media-type hint through navigation to prevent wrong-title TMDB collision

## Context

GitHub issue #79 (continued): navigating to the title-detail page from **either**
the Search tab or the Watchlist tab can still open the **wrong** title — e.g.
"Detective Kitty O'Day" instead of "The Lord of the Rings: The Rings of Power."

Spec 0037 (merged today, `feat/0037`) fixed two contributing defects: the stale
snapshot under Ionic page reuse (reactive `tmdbId$` from `paramMap`), and the
no-hint live fallback's blanket `catch` (narrowed to fall through to `/tv/{id}`
**only on a genuine 404**). But 0037 explicitly flagged the remaining hole in its
Risks: the no-hint path **still prefers movie on a real collision** — a valid
movie id that is also a valid tv id resolves as the movie, because `/movie/{id}`
returns **200**, not 404, so the 404-only fall-through never triggers. 0037 named
the durable fix and deferred it: "thread a type hint from the navigation source
(out of scope here)."

That collision is now observed in practice. TMDB id **84773** is a different title
in each namespace:

- `GET /movie/84773` → HTTP **200** "Detective Kitty O'Day"
- `GET /tv/84773` → HTTP **200** "The Lord of the Rings: The Rings of Power"

A user tapping the **tv** show from Search or Watchlist hits the no-hint live
path, which calls `/movie/84773` first, gets a 200 with the wrong title, and never
falls through. The id is correct end-to-end; what's missing is the **media type**,
which is already known at navigation time:

- Search: `SearchResultView extends SearchResult { type: TitleType; … }` —
  `result.type` is in hand at `search.page.ts:87-89` (`openDetail`).
- Watchlist: `item.type` (`WatchlistItem.type`) is in hand at the template
  `(click)` that calls `navigateToDetail` (`watchlist.page.ts:250-254`).

`TmdbDetailClient.getDetail(tmdbId, typeHint?, signal?)` **already** accepts a
`typeHint` and, when given, calls the right endpoint directly (no fall-through).
`TitleDetailService.detail$` / `resolveDetail` and `TitleDetailPage.detail$` simply
never pass one (`title-detail.service.ts:142,148,180`).

**Intended outcome:** tapping a title from Search or Watchlist threads its known
media type through the navigation as a `?type=tv|movie` query param → the detail
page reads it → the service passes it to the client → the client calls the correct
TMDB endpoint directly, so a movie/tv id collision can no longer render the wrong
title. Absent or invalid `?type` falls back to the existing no-hint behaviour
(unchanged), so deep links and the cache-first path are untouched.

## Scope

In scope (all `scope:mobile`):

- **Search → pass `?type`.** `search.page.ts` `openDetail(result)` adds
  `queryParams: { type: result.type }` to the existing `router.navigate`.
- **Watchlist → pass `?type`.** `watchlist.page.ts` `navigateToDetail` takes a
  `type: TitleType` arg and adds `queryParams: { type }`; the template's **both**
  `(click)` **and** `(keyup.enter)` bindings on the card pass `item.type`
  (`watchlist.page.html:90-91`).
- **Title-detail → read `?type` and thread it.** `title-detail.page.ts` adds a
  `typeHint$` stream from `route.queryParamMap` (validating to `'movie' | 'tv' |
undefined`), `combineLatest`s it into `detail$`, and passes it to
  `service.detail$(tmdbId, typeHint)`. `title-detail.service.ts` `detail$` /
  `resolveDetail` accept an optional `typeHint` and pass it to
  `client.getDetail(tmdbId, typeHint)`.
- Tests: unit (service threads the hint to the client; no-hint behaviour
  unchanged), component (page derives the hint from `queryParamMap`, invalid →
  undefined), and updated navigate assertions on the search/watchlist page specs.
- A new e2e flow: search → tap the **tv** result → detail hero shows the **tv**
  title (exercises the live path where the collision bites, with `/tv/{id}`
  interception).
- READMEs for all three changed libs.

Out of scope (explicitly):

- **No route-definition change.** The `tabs/title-detail/:titleId` route is
  unchanged; the hint rides as a query param, not a path segment. No
  `app.routes`/route-config edit.
- **No change to `TmdbDetailClient.getDetail`'s implementation or signature.** It
  already accepts `typeHint?` and uses it; this spec only starts **passing** one.
  The no-hint branch (404-only fall-through from spec 0037) is unchanged and
  remains the documented fallback for absent/invalid `?type`.
- **No change to the cache-first path.** `resolveDetail` resolves from
  `title-cache/{tmdbId}` first regardless of the hint; the hint only affects the
  **live** `client.getDetail` call on a cache miss. (The cached entry already
  carries its own `type`.)
- **No new collision heuristic / TMDB `find` lookup / search-by-type.** The fix is
  to thread the **already-known** type, not to discover it.
- Data model, Firestore rules/indexes, `sheriff.config.ts`, episode/watch-progress
  (0034), sync, settings — untouched.

## Affected slices & Sheriff tags

| Project             | Path                                                            | Sheriff tags                         | Change                                                                                                                                   |
| ------------------- | --------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-search       | `libs/mobile/search/src/lib/search.page.ts`                     | `scope:mobile`, `slice:search`       | `openDetail` adds `queryParams: { type: result.type }`                                                                                   |
| mobile-search       | `libs/mobile/search/src/lib/search.page.spec.ts`                | `scope:mobile`, `slice:search`       | update the two `navigate` assertions to include `queryParams`                                                                            |
| mobile-search       | `libs/mobile/search/README.md`                                  | `scope:mobile`, `slice:search`       | note the `?type` query param now passed on navigate                                                                                      |
| mobile-watchlist    | `libs/mobile/watchlist/src/lib/watchlist.page.ts`               | `scope:mobile`, `slice:watchlist`    | `navigateToDetail(titleId, type)` adds `queryParams: { type }`                                                                           |
| mobile-watchlist    | `libs/mobile/watchlist/src/lib/watchlist.page.html`             | `scope:mobile`, `slice:watchlist`    | **both** `(click)` and `(keyup.enter)` pass `item.type` (lines 90-91)                                                                    |
| mobile-watchlist    | `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`          | `scope:mobile`, `slice:watchlist`    | **add a new** navigate assertion for click and keyup.enter (none exists today)                                                           |
| mobile-watchlist    | `libs/mobile/watchlist/README.md`                               | `scope:mobile`, `slice:watchlist`    | note `navigateToDetail` now passes `?type`                                                                                               |
| mobile-title-detail | `libs/mobile/title-detail/src/lib/title-detail.page.ts`         | `scope:mobile`, `slice:title-detail` | `typeHint$` from `queryParamMap`; `combineLatest` into `detail$`; pass hint                                                              |
| mobile-title-detail | `libs/mobile/title-detail/src/lib/title-detail.service.ts`      | `scope:mobile`, `slice:title-detail` | `detail$` / `resolveDetail` accept + thread `typeHint?` to `client.getDetail`                                                            |
| mobile-title-detail | `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`    | `scope:mobile`, `slice:title-detail` | `queryParamMap`-driven hint cases; shim existing specs                                                                                   |
| mobile-title-detail | `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts` | `scope:mobile`, `slice:title-detail` | hint threaded to client; no-hint unchanged                                                                                               |
| mobile-title-detail | `libs/mobile/title-detail/README.md`                            | `scope:mobile`, `slice:title-detail` | note the route accepts an optional `?type=tv\|movie` typeHint                                                                            |
| mobile-e2e          | `apps/mobile-e2e/src/search.spec.ts`                            | _(untagged — black-box)_             | new tv flow asserts tv title; **and** fix the existing movie test's `$`-anchored URL regex (line 177) for the new `?type=movie`          |
| mobile-e2e          | `apps/mobile-e2e/fixtures/tmdb-tv-detail-1396.json`             | _(untagged — fixture)_               | new detail-shaped fixture for `GET /tv/1396` (Breaking Bad)                                                                              |
| mobile-e2e          | `apps/mobile-e2e/src/support/tmdb.ts`                           | _(untagged — black-box)_             | add a `routeTmdbTV(page, tvId, tvFixture)` helper for `**/${tvId}**` tv detail (existing `routeTmdb`/`routeTmdbDiscriminated` unchanged) |

- **Tags already exist** (0013 search, 0014 watchlist, 0016 title-detail) — verify
  by path glob in `sheriff.config.ts`; **do not edit `sheriff.config.ts`**.
- **No cross-slice / cross-scope import is added.** Each slice gets the type from
  its **own** existing data:
  - search: `result.type` (already on `SearchResultView`, derived in-slice).
  - watchlist: `item.type` (already on `WatchlistItem`); `TitleType` is **already
    imported** from `@vultus/shared/domain` (`watchlist.page.ts:30`) — no new
    import.
  - title-detail: `this.route.queryParamMap` (`@angular/router`, already imported);
    `TitleType` must be **added to the existing `@vultus/shared/domain` import**
    (the file already imports `Region`/`WatchStatus`/`WatchlistItem` from it at
    `title-detail.page.ts:37-41` — `scope:shared`, already allowed). All RxJS
    operators needed (`combineLatest`, `map`, `distinctUntilChanged`, `shareReplay`,
    `switchMap`, `of`, `startWith`) are already imported (`title-detail.page.ts:42-52`).
- **No `shared/` extraction.** This is pure plumbing of an existing query param +
  existing type fields — no logic is duplicated across slices, so the "extract only
  at 3+ slices" rule does not apply. (The three slices independently format/read the
  same `?type` convention; that's a URL contract, not shared code.)
- **`apps/mobile-e2e`** imports no workspace source (black-box browser + emulator
  REST per spec 0019), so no Sheriff boundary applies to the e2e edits.

## Data model touchpoints

**None.** No Firestore collection, field, converter, security rule, or index is
added or changed. The reads are exactly those spec 0016 defined
(`title-cache/{tmdbId}` cache-first, `users/{uid}.region`, the watchlist doc); the
fix only adds a transient **URL query param** (`?type`) consumed in memory and a
function argument threaded to the existing TMDB client. The e2e fixture
(`tmdb-tv-detail-1396.json`) is mock HTTP-response data, not a Firestore document.
Record "no `firestore.rules` / `firestore.indexes.json` change" in the PR.

## Public types / APIs

No **new exported** type, token, callable, or HTTP shape. Two internal slice
signatures change (illustrative — behaviour is the contract):

- **`TitleDetailService.detail$`** (`title-detail.service.ts:142`) — add an optional
  hint:

  ```ts
  detail$(tmdbId: number, typeHint?: TitleType): Observable<DetailViewState> {
    return from(this.resolveDetail(tmdbId, typeHint)).pipe(
      startWith<DetailViewState>({ kind: 'loading' }),
    );
  }
  ```

  `resolveDetail(tmdbId, typeHint?)` threads the hint to the **live** call only:

  ```ts
  // Cache path UNCHANGED (title-cache/{tmdbId} first; cached entry carries type).
  // Live fallback — pass the hint so the client hits the right endpoint directly:
  const detail = await this.client.getDetail(tmdbId, typeHint);
  ```

  The `try/catch` (404 → `not-found`, else → `error`) from spec 0037 is unchanged.
  `TitleType` is imported from `@vultus/shared/domain` (verify it's in the existing
  import list; add if absent — `scope:shared`, already allowed).

- **`TitleDetailPage`** — add a validated `typeHint$` and combine it into `detail$`:

  ```ts
  /** Type hint from ?type=tv|movie — passed by search/watchlist to avoid TMDB id collision. */
  private readonly typeHint$: Observable<TitleType | undefined> =
    this.route.queryParamMap.pipe(
      map((p) => {
        const v = p.get('type');
        return v === 'movie' || v === 'tv' ? v : undefined; // invalid → no hint
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  private readonly detail$: Observable<DetailViewState> = combineLatest([
    this.tmdbId$,
    this.typeHint$,
    this.retryTrigger$,
  ]).pipe(
    switchMap(([tmdbId, typeHint]) =>
      Number.isNaN(tmdbId) || tmdbId === 0
        ? of<DetailViewState>({ kind: 'not-found' })
        : this.service.detail$(tmdbId, typeHint),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
  ```

  The `NaN`/`0` invalid-id guard (spec 0037) is preserved. `typeHint$` reuses the
  same `queryParamMap` Observable Angular re-emits on in-place param change, so a
  reused Ionic page picks up a new `?type` the same way it picks up a new `:titleId`.

- **`SearchPage.openDetail`** (`search.page.ts:87`):

  ```ts
  void this.router.navigate(['tabs', 'title-detail', String(result.tmdbId)], {
    queryParams: { type: result.type },
  });
  ```

- **`WatchlistPage.navigateToDetail`** (`watchlist.page.ts:250`):

  ```ts
  navigateToDetail(titleId: string, type: TitleType): void {
    this.router
      .navigate(['tabs', 'title-detail', titleId], { queryParams: { type } })
      .catch(() => { /* graceful no-op */ });
  }
  ```

  Template `(click)="navigateToDetail(titleId(item), item.type)"`. `TitleType` is
  already imported in `watchlist.page.ts` — no new import.

- **`TmdbDetailClient.getDetail(tmdbId, typeHint?, signal?)`** — **signature and
  implementation unchanged**; this spec only starts passing the existing
  `typeHint`. With a hint it calls the matching endpoint directly (no fall-through);
  without one it keeps the spec-0037 movie-first / 404-only fall-through.

## UI / Stitch screen refs

**No UI/markup change, and no Stitch screen fetch required.**

This is a navigation/data-resolution fix. The Search results list, the Watchlist
cards, and the title-detail hero/synopsis/where-to-watch/loading/error/not-found
states are all visually unchanged (specs 0013/0014/0016/0024/0030 own them). The
only change to a template is the **watchlist `(click)` handler argument**
(`navigateToDetail(titleId(item), item.type)`) — no new element, class, token, or
layout. Tokens (when referenced elsewhere) live at
`docs/design/vultus-design-system.md` (do not re-print hex values). Stated
explicitly so the absent UI section is understood as intentional, not an omission.

## Implementation task graph

The title-detail page and service change together (the page passes a new arg the
service must accept), and the page spec exercises both, so task **1** owns the
`libs/mobile/title-detail` slice end to end. The search and watchlist edits are
**independent slices with disjoint manifests** and may run in parallel with task 1
(they don't depend on it — the URL contract is fixed by this spec). The e2e task
asserts the full chain and must run **after** task 1's page/service change is in the
worktree, so it is last.

### Parallel — the three slice edits (disjoint manifests)

1. **[parallel] Title-detail: read `?type` and thread the hint
   (`libs/mobile/title-detail`, `slice:title-detail`).** frontend-engineer.
   - `title-detail.page.ts`: add `typeHint$` from `route.queryParamMap`
     (`map` validate to `'movie'|'tv'|undefined` → `distinctUntilChanged` →
     `shareReplay`); add `typeHint$` to the `detail$` `combineLatest` and pass it to
     `service.detail$(tmdbId, typeHint)`; preserve the `NaN`/`0` guard. Add
     `TitleType` to the existing `@vultus/shared/domain` import if absent.
   - `title-detail.service.ts`: `detail$(tmdbId, typeHint?)` and
     `resolveDetail(tmdbId, typeHint?)` accept the hint and pass it to
     `client.getDetail(tmdbId, typeHint)`; cache path and 404/error mapping
     unchanged. Add `TitleType` import if absent.
   - `title-detail.page.spec.ts`: add the `queryParamMap` hint cases (see Test
     plan); add a minimal `queryParamMap` shim (`convertToParamMap({})` /
     `BehaviorSubject<ParamMap>`) to existing specs so they stay green.
   - `title-detail.service.spec.ts`: assert the hint is forwarded to the mocked
     `client.getDetail`; assert no-hint behaviour unchanged.
   - `libs/mobile/title-detail/README.md`: note the route accepts an optional
     `?type=tv|movie` query param threaded to the TMDB client to avoid the
     movie/tv id collision on the live fallback.
   - **File manifest (creates/modifies):**
     - `libs/mobile/title-detail/src/lib/title-detail.page.ts`
     - `libs/mobile/title-detail/src/lib/title-detail.service.ts`
     - `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`
     - `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`
     - `libs/mobile/title-detail/README.md`

2. **[parallel] Search: pass `?type` on navigate (`libs/mobile/search`,
   `slice:search`).** frontend-engineer.
   - `search.page.ts`: `openDetail` adds `queryParams: { type: result.type }`.
   - `search.page.spec.ts`: update both `navigate` assertions (lines 133-161,
     "card body tapped" + "poster tapped") to include
     `{ queryParams: { type: mockResult.type } }`. Both tests use the **same**
     single `mockResult` fixture, so assert against its `.type` field — no second
     mock is needed.
   - `libs/mobile/search/README.md`: note `?type` is passed on navigate.
   - **File manifest (creates/modifies):**
     - `libs/mobile/search/src/lib/search.page.ts`
     - `libs/mobile/search/src/lib/search.page.spec.ts`
     - `libs/mobile/search/README.md`

3. **[parallel] Watchlist: pass `?type` on navigate (`libs/mobile/watchlist`,
   `slice:watchlist`).** frontend-engineer.
   - `watchlist.page.ts`: `navigateToDetail(titleId, type)` adds
     `queryParams: { type }` (`TitleType` already imported).
   - `watchlist.page.html`: update **both** card bindings (lines 90-91) —
     `(click)="navigateToDetail(titleId(item), item.type)"` **and**
     `(keyup.enter)="navigateToDetail(titleId(item), item.type)"`. Leaving the
     `(keyup.enter)` binding on the old one-arg signature breaks the template
     compile (or passes `undefined`).
   - `watchlist.page.spec.ts`: **add a new** test (no existing test invokes
     `navigateToDetail` or asserts `router.navigate`). It clicks the card
     (`.watchlist-card`) **and** dispatches a `keyup.enter`, and asserts
     `router.navigate` was called with
     `['tabs', 'title-detail', <id>], { queryParams: { type: <item.type> } }`.
     (The existing `setup` already provides a `Router` mock,
     `{ navigate: vi.fn() }` — destructure it as `router` like the search spec.)
   - `libs/mobile/watchlist/README.md`: note `navigateToDetail` passes `?type`.
   - **File manifest (creates/modifies):**
     - `libs/mobile/watchlist/src/lib/watchlist.page.ts`
     - `libs/mobile/watchlist/src/lib/watchlist.page.html`
     - `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`
     - `libs/mobile/watchlist/README.md`

### Sequential — e2e (after task 1)

4. **[sequential] e2e: search → tv result → detail shows the tv title
   (`apps/mobile-e2e`).** qa-runner / frontend-engineer. Runs after task 1's
   page/service change is in the worktree (otherwise it asserts the bug).
   - **Fixture has a tv result.** `apps/mobile-e2e/fixtures/tmdb-search-multi.json`
     already contains `{ "id": 1396, "media_type": "tv", "name": "Breaking Bad", … }`
     (verified). Use id **1396** as the tv-show target — no fixture change to
     `tmdb-search-multi.json` needed.
   - **media_type → type → query-param mapping (no fixture change).** The
     search-multi fixture entry for id 1396 carries `"media_type": "tv"`, which
     `TmdbSearchClient.searchMulti` maps to `SearchResult.type === 'tv'` (verified
     at `libs/mobile/search/src/lib/tmdb-search.client.ts:104-105` —
     `isMovie = r.media_type === 'movie'`, `type = isMovie ? 'movie' : 'tv'`). So
     `openDetail(result)` sends `?type=tv` for this row without any fixture edit.
   - **New fixture** `apps/mobile-e2e/fixtures/tmdb-tv-detail-1396.json` (mock,
     detail shape — note the **tv** detail uses `name`/`first_air_date`, mirroring
     how `mapDetail` reads a tv response):
     `{ "id": 1396, "name": "Breaking Bad", "first_air_date": "2008-01-20",
"overview": "A high-school chemistry teacher turned meth manufacturer.",
"poster_path": null, "vote_average": 8.9 }` (confirm the exact field names
     `mapDetail` reads for `type: 'tv'` against `tmdb-detail.client.ts` and match
     them — the fixture must produce a non-empty hero title).
   - **TMDB interception — add a `routeTmdbTV` helper** in
     `apps/mobile-e2e/src/support/tmdb.ts` (do **not** change the existing
     `routeTmdb` / `routeTmdbDiscriminated` signatures — the existing movie test at
     `search.spec.ts:156` calls `routeTmdbDiscriminated(page, 'tmdb-movie-detail-603.json')`
     and must keep working). Add a sibling:
     `routeTmdbTV(page, tvId: number, tvFixture: TmdbFixtureName)` that registers a
     `**/${tvId}**`-scoped handler fulfilling with the tv detail fixture (the
     existing `routeTmdbDiscriminated`'s `**/movie/**` handler does **not** match a
     `/tv/{id}` URL, so the two compose cleanly). The new tv test registers the
     search/multi route (via `routeTmdb` or the search half of `routeTmdbDiscriminated`)
     **plus** `routeTmdbTV(page, 1396, 'tmdb-tv-detail-1396.json')`. Do **not**
     intercept `/movie/1396` — the type hint must make the client call `/tv/1396`
     **directly**, so the absence of a `/movie/1396` route proves the hint
     short-circuited the movie-first path. Preserve the no-secret / no-live-call
     invariant (spec 0019).
   - **Fix the existing movie test's URL assertion** (`search.spec.ts:177`): once
     Search appends `?type=movie`, the `$`-anchored regex
     `/\/tabs\/title-detail\/603$/` no longer matches `…/603?type=movie`. Change it
     to `/\/tabs\/title-detail\/603\?type=movie/` (or
     `{ pathname: '/tabs/title-detail/603' }`). This is a **required** edit, not
     optional — without it the existing movie test breaks.
   - **The flow** (`search.spec.ts`, new `search-to-detail-correct-title`):
     register the search/multi route **and** `routeTmdbTV(page, 1396, …)` → search
     "breaking" (or whatever matches the fixture) → wait for `.result-card` → tap the
     **tv** result (Breaking Bad, id 1396) → assert URL is
     `\/tabs\/title-detail\/1396\?type=tv` → assert the detail hero
     (`[data-test="hero"] .hero-title`) shows "Breaking Bad" (the tapped **tv**
     title, served by `/tv/1396` — proving the hint forced the tv endpoint, not a
     movie fall-through). This is a **cache miss** (nothing seeded), so it exercises
     the live path the collision bites.
   - **File manifest (creates/modifies):**
     - `apps/mobile-e2e/src/search.spec.ts` (new tv flow **and** fix the existing
       movie test's line-177 URL regex)
     - `apps/mobile-e2e/fixtures/tmdb-tv-detail-1396.json` (new)
     - `apps/mobile-e2e/src/support/tmdb.ts` (add `routeTmdbTV` helper)

> Tasks 1–3 write disjoint manifests across three slices and run concurrently.
> Task 4 depends on task 1's page/service change being present. Per user memory
> (`emulator-tooling-limitation`), the Firestore/Auth emulator cannot run under
> Claude Code tools here — the e2e gate **degrades gracefully** (authored +
> committed, run in the user's terminal / CI). The component + unit tests in tasks
> 1–3 are the in-tool proof of the fix.

## Test plan

Per the PLAN §5 pyramid: **unit** for the service threading, **component** for the
page's hint derivation, plus updated navigate assertions, and **e2e** for the named
search→detail flow.

**Unit — `title-detail.service.spec.ts` (mock `TmdbDetailClient`):**

- `detail$(id, 'tv')` → `client.getDetail` called with `(id, 'tv')` → loaded from
  the tv response.
- `detail$(id, 'movie')` → `client.getDetail` called with `(id, 'movie')`.
- `detail$(id)` / `detail$(id, undefined)` → `client.getDetail` called with
  `(id, undefined)` — existing no-hint behaviour unchanged.
- **Cache-first unaffected by the hint:** with a seeded `title-cache/{id}` mock,
  `detail$(id, 'movie')` resolves from cache and **does not** call
  `client.getDetail` (the hint only affects the live fallback). Keeps the existing
  cache/404/error mapping specs green.

**Component — `title-detail.page.spec.ts` (Angular Testing Library on Vitest;
service mocked via DI; `ActivatedRoute.queryParamMap` driven):**

- **`?type=tv` → hint threaded:** mount with `queryParamMap` providing `type=tv`;
  assert `service.detail$` was called with `('<id>', 'tv')`.
- **`?type=movie` → hint threaded:** same with `type=movie` → `(<id>, 'movie')`.
- **Absent `?type` → undefined:** `queryParamMap` with no `type` → `service.detail$`
  called with `(<id>, undefined)` (existing no-hint behaviour).
- **Invalid `?type` → undefined (not passed through):** `queryParamMap` with
  `type=anime` → `service.detail$` called with `(<id>, undefined)` — the validation
  collapses any non-`movie`/`tv` value to `undefined`.
- **No regressions:** all existing `TitleDetailPage` specs stay green. Add a minimal
  `queryParamMap` shim (`convertToParamMap({})` or a `BehaviorSubject<ParamMap>`) to
  the existing test double so `typeHint$` has a source; existing specs that don't set
  `?type` must behave exactly as before (hint `undefined`).

**Search page — `search.page.spec.ts` (update existing):**

- Update both `navigate` assertions (lines 133-161, "card body tapped" + "poster
  tapped") to include `{ queryParams: { type: mockResult.type } }` — both tests use
  the **same** single `mockResult` fixture, so the assertion simply matches that
  mock's `.type` field. No second mock is needed.

**Watchlist page — `watchlist.page.spec.ts` (add new — there is none to update):**

- **Add a new** test (today the spec has a `Router` mock but **zero** tests that
  invoke `navigateToDetail` or assert `router.navigate`). The new test clicks a card
  (`.watchlist-card`) **and** dispatches a `keyup.enter` on it, asserting in both
  cases that `router.navigate` was called with
  `['tabs', 'title-detail', <id>], { queryParams: { type: <item.type> } }`.
  Destructure the existing `Router` mock as `router` (as the search spec does).

**e2e — REQUIRED (per the rubric).** This is a `scope:mobile` change to the primary
title-detail navigation route and the user-facing symptom is a navigation defect, so
a named flow is required and becomes a DoD gate (`qa-runner` / `feature-reviewer`).
One new flow against the emulator-backed harness (spec 0019):

- **`search-to-detail-correct-title`** (`search.spec.ts`, new): register the
  search/multi route (`tmdb-search-multi.json`) **and** the new
  `routeTmdbTV(page, 1396, 'tmdb-tv-detail-1396.json')` tv-detail helper → search →
  tap the **tv** result (Breaking Bad, id 1396) → URL is
  `tabs/title-detail/1396?type=tv` → the detail hero shows "Breaking Bad" (the tapped
  tv title). The detail call is a **cache miss**, so it exercises the live
  `getDetail` path the collision bites; the `/tv/1396` interception (with **no**
  `/movie/1396` route) proves the `?type=tv` hint forced the tv endpoint directly
  instead of the movie-first fall-through. The `media_type: "tv"` →
  `SearchResult.type === 'tv'` → `?type=tv` mapping is verified in
  `tmdb-search.client.ts:104-105` (no fixture change). **Fixme-free** — the route and
  both entry points already exist.
- **Existing movie test fix (not a new flow):** the existing
  search→movie-detail test (`search.spec.ts:177`) now navigates to
  `…/603?type=movie`, so its `$`-anchored URL assertion
  `/\/tabs\/title-detail\/603$/` must change to
  `/\/tabs\/title-detail\/603\?type=movie/` (or
  `{ pathname: '/tabs/title-detail/603' }`) or it breaks.

> **e2e harness note (carried from spec 0037):** the repo's e2e runs against the
> Firebase emulator with `routeTmdb` interception (spec 0019,
> `playwright.config.ts`, `support.ts`), **not** a `--configuration=mock` Playwright
> target. This flow follows the established harness; do not invent a `mock` e2e
> target.

> **e2e run note:** per user memory `emulator-tooling-limitation`, the emulator
> cannot run under Claude Code tools here. The flow is **authored + committed** and
> runs green in the user's terminal / CI; the component + unit tests are the in-tool
> proof. Do **not** report the e2e flow green off a build alone.

## Definition of done

Tailored from PLAN §5 / CLAUDE.md to this navigation/data-resolution fix.

- [ ] `pnpm nx typecheck mobile-search mobile-watchlist mobile-title-detail` passes —
      the `?type` query param, the `typeHint$` stream, the new
      `detail$`/`resolveDetail` arg, and the updated `navigateToDetail` signature
      compile.
- [ ] `pnpm nx lint mobile-search mobile-watchlist mobile-title-detail` passes **with
      Sheriff active** — no other-slice import, no cross-scope import; `TitleType`
      only ever from `@vultus/shared/domain` (`scope:shared`).
- [ ] `pnpm nx test mobile-search mobile-watchlist mobile-title-detail` passes — the
      new service hint-threading tests, the page `queryParamMap` hint cases (tv /
      movie / absent / invalid), and the updated search + watchlist navigate
      assertions are green; **all pre-existing specs in the three slices still pass**.
- [ ] `pnpm nx build mobile` passes within budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green (affected:
      `mobile-search`, `mobile-watchlist`, `mobile-title-detail`, `mobile`;
      `mobile-e2e` if its config marks it affected).
- [ ] **No cross-slice / cross-scope import added** — verified, recorded in the PR
      (each slice reads its own `type`; the title-detail page reads
      `route.queryParamMap`).
- [ ] **No data-model / `firestore.rules` / `firestore.indexes.json` /
      `sheriff.config.ts` change** — verified, recorded in the PR.
- [ ] **e2e authored + committed:** `search-to-detail-correct-title` asserts
      `tabs/title-detail/1396?type=tv` and the **tv** hero title; run green where the
      emulator gate is runnable, otherwise flag for a run in the user's terminal
      (user memory `emulator-tooling-limitation`) — do not report it passed off a
      build alone.
- [ ] **No secret read/written** (CLAUDE.md hard rule).
- [ ] **READMEs for all three changed libs updated in the same change**
      (`libs/mobile/{search,watchlist,title-detail}/README.md`).
- [ ] PR description records: the typeHint chain (query param → page `typeHint$` →
      `service.detail$` → `client.getDetail`), the collision (id 84773) it fixes,
      which existing spec/fixture was extended for e2e, and the e2e run status (run
      here vs deferred to the user's terminal).

## Risks

- **Deep links / external navigation have no `?type`.** A title-detail URL opened
  without `?type` (deep link, browser refresh, back/forward to a param-only URL)
  falls back to the no-hint live path — i.e. the spec-0037 movie-first / 404-only
  behaviour, which still mis-resolves a movie/tv collision (84773 → movie). This is
  the **documented, accepted** fallback (0037 Risks): the in-app Search/Watchlist
  taps — the reported symptom — are fixed because they always carry `?type`. A fully
  durable fix for hint-less entry would require persisting the type (e.g. in
  `title-cache`) or a TMDB `find`/discriminating lookup, which is out of scope here.
  Recorded so it is not silently assumed solved.
- **`?type` validation is strict by design.** Any value other than the exact strings
  `movie`/`tv` collapses to `undefined` (no hint) rather than erroring — so a
  malformed/legacy URL degrades to the existing behaviour instead of throwing. The
  component test pins the invalid-value case (`type=anime` → `undefined`).
- **Cache-first wins over the hint.** The hint only affects the live fallback; a
  title already in `title-cache` resolves from cache (which carries its own `type`)
  regardless of `?type`. If a cached entry's `type` were ever wrong, the hint would
  not correct it — but that is a cache-population concern (sync), out of scope here.
  The unit test asserts the cache path does not call `client.getDetail`.
- **Search/watchlist `type` field accuracy.** The hint is only as good as
  `SearchResult.type` (from TMDB `media_type` on `search/multi`) and
  `WatchlistItem.type` (set at add time). These are the same fields already driving
  the search filter and watchlist grouping; this spec assumes their existing
  accuracy and adds no new derivation.
- **Emulator gate not runnable here** (user memory `emulator-tooling-limitation`) —
  the e2e flow is authored/committed and gates in CI / the user's terminal; the
  component + unit tests are the in-tool proof. Do not report the e2e flow green off
  a build alone.
- **No PLAN conflict.** The fix stays within the three existing vertical slices and
  the existing Firestore data model (PLAN §3–§4); it adds no cross-slice/cross-scope
  import and no shared extraction, and threads only an already-known type through a
  query param — exactly the durable fix spec 0037 deferred.
