---
number: 0037
slug: fix-title-detail-navigation
title: Fix title-detail page showing the wrong title on navigation from watchlist/search
status: approved
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-06-29
---

# 0037 — Fix title-detail page showing the wrong title on navigation from watchlist/search

## Context

GitHub issue #79: navigating to the title-detail page from **either** the
Watchlist tab or the Search tab always opens the **wrong** title — it
consistently shows "Detective Kitty O'Day" instead of the tapped title.

The title-detail page (`tabs/title-detail/:titleId`, spec 0016) derives the
numeric TMDB id from the route **once, at construction time, from the snapshot**:

```ts
// libs/mobile/title-detail/src/lib/title-detail.page.ts:103
readonly tmdbId = Number(this.route.snapshot.paramMap.get('titleId'));
```

Two distinct defects flow from that line and the live-fallback client:

1. **Stale snapshot under Ionic page reuse (primary).** `tmdbId` is a `readonly`
   field bound to `route.snapshot` at the moment the component is constructed.
   Ionic's `ion-router-outlet` **caches and reuses** page component instances
   across navigations to the same component with a different param. When the page
   instance is reused, `route.snapshot.paramMap` is **stale**, `tmdbId` is never
   re-derived, and every downstream stream (`detail$`, `vm$`) keeps resolving the
   id from the **first** navigation. The reactive `route.paramMap` Observable is
   the supported way to react to in-place param changes; the snapshot is not.

2. **Wrong title from the no-hint live fallback (secondary, contributes to the
   exact symptom).** When the title is **not** in `title-cache`, the service
   calls `TmdbDetailClient.getDetail(tmdbId)` with **no `typeHint`**. The current
   no-hint path (`tmdb-detail.client.ts:210-216`) does:

   ```ts
   try {
     return await fetchDetailFor(tmdbId, 'movie', signal); // GET /movie/{id}
   } catch {
     return fetchDetailFor(tmdbId, 'tv', signal); // GET /tv/{id} on ANY error
   }
   ```

   The blanket `catch` falls through to the **tv** endpoint on **every** error,
   not just a genuine 404. So a transient/5xx/network failure on `/movie/{id}` —
   **or a `/movie/{id}` response for an id that is actually a tv id** — silently
   resolves to a different title from `/tv/{id}` (a TMDB id is **not** unique
   across the movie and tv namespaces; the same integer is a different title in
   each). "Detective Kitty O'Day" is the `/movie/{id}` result for an id that the
   user expected to resolve as a tv show — the movie call returns 200 with the
   wrong title and the page renders it. The fall-through also masks real errors
   (a 5xx that should surface `{ kind: 'error' }` instead returns a bogus title).

A third, related guard gap: when the snapshot param is absent (pre-activation /
malformed route), `Number(null)` is `0` and `Number('abc')` is `NaN`; the page
then hits TMDB with an invalid id rather than short-circuiting to not-found.

The two navigation entry points are **already correct** and out of scope to
change: the watchlist card navigates with
`router.navigate(['tabs','title-detail', titleId])` where
`titleId === String(item.tmdbId)` (`watchlist.page.ts:250-252`), and the search
card with `router.navigate(['tabs','title-detail', String(result.tmdbId)])`
(`search.page.ts:88`). Both pass the right id; the bug is entirely in how the
detail page **consumes** it and how the no-hint client **resolves** it.

**Intended outcome:** tapping any title from Watchlist or Search opens the
detail page for **that** title — including when Ionic reuses the page instance
for a second navigation — and an invalid/unknown id renders the existing
not-found state rather than a wrong title.

## Scope

In scope (all `scope:mobile`, `slice:title-detail`):

- **Reactive tmdbId.** Replace the snapshot-derived `readonly tmdbId` field with
  a reactive derivation from `this.route.paramMap`, and drive `detail$` (and
  therefore `vm$`) from that stream so a reused page instance reloads the correct
  title when the `:titleId` param changes in place.
- **Invalid-id guard.** When the parsed id is `NaN` or `0`, emit
  `{ kind: 'not-found' }` immediately without calling the service / TMDB.
- **Targeted no-hint fallback.** In `TmdbDetailClient.getDetail()`, only fall
  through from the `/movie/{id}` endpoint to the `/tv/{id}` endpoint on a genuine
  **404** (`TmdbDetailError` with `status === 404`); re-throw any other error so
  the service maps it to the recoverable `{ kind: 'error' }` state instead of
  silently returning a wrong title.
- **Action handlers that read `this.tmdbId`.** The status action-sheet, remove
  alert/handler, and remove-confirm currently call `this.service.updateStatus(
  this.tmdbId, …)` / `this.service.removeTitle(this.tmdbId)` using the old field.
  These must read the **current** reactive id so a reused page acts on the title
  on screen, not the first one opened.
- Component tests reproducing (a) the stale-param reuse → wrong title, (b) the
  invalid-id guard, and a unit test for (c) the no-hint 404-only fall-through.
- e2e: a watchlist → detail and a search → detail flow that assert the detail
  page shows the **tapped** title.

Out of scope (explicitly):

- **Any change to the watchlist or search navigation code.** Both already pass
  the correct id (`String(tmdbId)`); they are read-only verification only. If
  verification reveals a defect, that is a new finding, not a silent edit here.
- **Any change to `TitleDetailService`'s public surface, the cache-first
  resolution order, providers/region/tracked streams, or the `add` /
  `updateStatus` / `removeTitle` write paths.** Only the page's id derivation and
  the client's no-hint branch change; the service's `detail$`/`resolveDetail`
  already map a `TmdbDetailError.status === 404` to `not-found` and other errors
  to `error` (`title-detail.service.ts:140-145`) and are unchanged.
- **The not-found template.** It **already exists** (`title-detail.page.html:27-38`:
  `<vultus-empty-state data-test="not-found" icon="film-outline" title="Title not
  found" subtitle="This title no longer exists." />` plus a `fill="clear"
  routerLink="/tabs/watchlist"` "Go back" button) — so the invalid-id guard's
  `{ kind: 'not-found' }` renders the existing card with no new markup. The
  `VultusEmptyState` token wiring is the design-system component already imported
  by the page; tokens live at `docs/design/vultus-design-system.md` (do not
  re-print hex values). Stated explicitly so the absent UI section is understood as
  intentional, not an omission.
- Episode list / watch-progress (spec 0034), settings, sync, data model,
  Firestore rules/indexes, Sheriff config.

## Affected slices & Sheriff tags

| Project              | Path                                                                | Sheriff tags                          | Change                                                                          |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/title-detail.page.ts`             | `scope:mobile`, `slice:title-detail`  | reactive `tmdbId$` from `route.paramMap`; invalid-id guard; handlers read it    |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/tmdb-detail.client.ts`            | `scope:mobile`, `slice:title-detail`  | no-hint `getDetail` falls through to tv **only on 404**; re-throws otherwise    |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`        | `scope:mobile`, `slice:title-detail`  | reproduce stale-param-reuse + invalid-id; keep existing specs green             |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/tmdb-detail.client.spec.ts`       | `scope:mobile`, `slice:title-detail`  | no-hint 404 fall-through vs non-404 re-throw                                     |
| mobile-watchlist     | `libs/mobile/watchlist/src/lib/watchlist.page.ts`                   | `scope:mobile`, `slice:watchlist`     | **verify only** — `navigateToDetail(String(tmdbId))` already correct            |
| mobile-search        | `libs/mobile/search/src/lib/search.page.ts`                         | `scope:mobile`, `slice:search`        | **verify only** — `navigate([... , String(result.tmdbId)])` already correct     |
| mobile-e2e           | `apps/mobile-e2e/src/title-detail.spec.ts`                          | _(untagged — black-box)_              | un-skip/replace the `test.fixme` F4 watchlist → detail flow as a real assertion |
| mobile-e2e           | `apps/mobile-e2e/emulator-data/seeded/docs.json`                    | _(untagged — fixture)_                | add a `title-cache/2` doc so watchlist → detail resolves cache-first (no TMDB)  |
| mobile-e2e           | `apps/mobile-e2e/src/search.spec.ts`                                | _(untagged — black-box)_              | add a search → detail flow asserting the tapped title renders                   |
| mobile-e2e           | `apps/mobile-e2e/fixtures/tmdb-movie-detail-603.json`               | _(untagged — fixture)_                | new detail-shaped fixture for `GET /movie/603` (The Matrix)                     |
| mobile-e2e           | `apps/mobile-e2e/src/support/tmdb.ts`                               | _(untagged — black-box)_              | path-discriminate TMDB interception: `search/multi` vs `movie/603`              |

- **Tags already exist** (spec 0016 for `slice:title-detail`; 0013/0014 for
  search/watchlist) — verify by path glob in `sheriff.config.ts`; **do not edit
  `sheriff.config.ts`**.
- **No cross-slice / cross-scope import.** The page already imports
  `ActivatedRoute` (`@angular/router`), the RxJS operators it needs
  (`switchMap`, `map`, `combineLatest`, `of`, `startWith`, `shareReplay`,
  `distinctUntilChanged`), `@vultus/shared/domain`, `@vultus/shared/domain/tokens`,
  and `@vultus/shared/ui-kit`. The fix adds **no** new import target outside what
  the slice already uses (`distinctUntilChanged` is a new RxJS operator import
  from the same `rxjs` package). The two navigation files are read-only.
- **`apps/mobile-e2e`** imports no workspace source (black-box browser + emulator
  REST), so no Sheriff scope/slice boundary applies to the e2e edits (per spec
  0019 / `support.ts` header).
- **Not a `shared/` extraction.** The fix is confined to one slice; the
  "extract only at 3+ slices" rule does not apply (reactive-route consumption is
  a single-slice concern here, not duplicated logic).

## Data model touchpoints

**None.** No Firestore collection, field, converter, security rule, or index is
added or changed. The reads involved are exactly those spec 0016 defined —
`title-cache/{tmdbId}` (cache-first), `title-cache/{tmdbId}/availability/{region}`,
`users/{uid}.region`, `users/{uid}/watchlist/{titleId}` (PLAN §4) — and they are
unchanged. The fix is purely (a) which `tmdbId` the page feeds those reads and
(b) the live TMDB client's no-hint endpoint selection. Record "no
`firestore.rules` / `firestore.indexes.json` change" in the PR. The new
`title-cache/2` document added in task 3 is **e2e seed data only**
(`apps/mobile-e2e/emulator-data/seeded/docs.json`), populating the existing
`title-cache` collection in the emulator — it adds no field, converter, or
schema, and matches the existing `TitleCacheWriteData` shape.

## Public types / APIs

**No new or changed public/exported type, token, callable, or HTTP shape.**

- `TitleDetailPage` is a routed component (no public method-signature contract
  beyond the existing template-bound handlers). The change is internal: the
  `readonly tmdbId: number` **field** becomes a reactive `tmdbId$:
  Observable<number>` (and a value read where handlers need it — see below). The
  barrel export (`TitleDetailPage`) is unchanged.
- `TmdbDetailClient.getDetail(tmdbId, typeHint?, signal?): Promise<TitleDetail>`
  — **signature unchanged.** Only the no-hint branch's catch is narrowed to a
  404 check. The `TmdbDetailError { status }` class it throws is unchanged and is
  what the narrowing keys on.
- `DetailViewState` (`title-detail.service.ts`) — unchanged; `{ kind:
  'not-found' }` already exists and is what the invalid-id guard emits.
- `TitleDetailService` public surface — **unchanged** (no README API change for
  the service). The page README's route description (`tabs/title-detail/:titleId`)
  is unchanged.

### The page change (the contract for the implementer)

Derive the id reactively and feed every consumer from it. Illustrative — wording
may be tuned, the **behaviour** is the contract:

```ts
private readonly route = inject(ActivatedRoute);

/** Current numeric tmdb id from the live :titleId param (re-emits on reuse). */
readonly tmdbId$: Observable<number> = this.route.paramMap.pipe(
  map((p) => Number(p.get('titleId'))),
  distinctUntilChanged(),
  shareReplay({ bufferSize: 1, refCount: true }),
);

private readonly detail$: Observable<DetailViewState> = combineLatest([
  this.tmdbId$,
  this.retryTrigger$,
]).pipe(
  switchMap(([tmdbId]) =>
    Number.isNaN(tmdbId) || tmdbId === 0
      ? of<DetailViewState>({ kind: 'not-found' }) // invalid id → not-found, no fetch
      : this.service.detail$(tmdbId),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);
```

- `detail$` must combine `tmdbId$` with the existing `retryTrigger$` so both a
  param change **and** a retry re-run resolution through `switchMap` (which
  cancels the prior inner subscription — important so a reused page does not
  briefly show the previous title).
- The inner `vm$` `switchMap` already reads `state.detail.tmdbId` for
  `providers$`/`tracked$`, so providers/tracked follow the resolved detail
  automatically — **no change needed there** beyond `detail$` now being
  param-driven.
- **Handlers must read the current id, not a stale field.** `updateStatus`,
  `removeTitle`, and the `alertButtons` remove `handler` currently close over
  `this.tmdbId`. Replace with a synchronously-readable current value — e.g. keep
  a private `currentTmdbId` updated from `tmdbId$` (subscribe with
  `takeUntilDestroyed`, or read the last `shareReplay` value), and have the
  handlers and `actionSheetButtons` use it. The action-sheet/alert are only
  reachable from the `loaded` state, so `currentTmdbId` is the resolved title's
  id; do **not** regress the existing status-change / remove behaviour.
- **One source of truth.** `currentTmdbId` is a **cached projection of `tmdbId$`**
  (the synchronous read for imperative handlers), not a second derivation — it must
  only ever be assigned from the `tmdbId$` subscription, never re-parsed from the
  route. Pick ONE mechanism (a `takeUntilDestroyed` subscription that assigns the
  field, or read the `shareReplay` last value) and do not maintain both a separate
  field and the stream as independent sources.
- Keep `Number(...)` parsing centralised in `tmdbId$` so there is one source of
  truth for the id (the old line 103 derivation is removed).

### The client change

In `tmdb-detail.client.ts`, narrow the no-hint catch:

```ts
// No hint: try movie, fall back to tv ONLY on a genuine 404.
try {
  return await fetchDetailFor(tmdbId, 'movie', signal);
} catch (err) {
  if (err instanceof TmdbDetailError && err.status === 404) {
    return fetchDetailFor(tmdbId, 'tv', signal);
  }
  throw err; // 5xx / network / abort → surface as error, not a wrong title
}
```

- A non-404 on `/movie/{id}` now propagates; `TitleDetailService.resolveDetail`
  maps a `TmdbDetailError` with `status === 404` to `not-found` and everything
  else to `error` (unchanged), so the recoverable error UI (with retry) shows
  instead of a bogus title.
- An `AbortError` (signal-cancelled fetch) is **not** a `TmdbDetailError`, so it
  re-throws — correct: a cancelled request must not resolve to a tv title.

## UI / Stitch screen refs

**No UI/markup change, and no Stitch screen fetch required for this spec.**

This is a navigation/data-resolution bug fix. The detail page's hero, synopsis,
where-to-watch, loading skeleton, error, and **not-found** states are all
unchanged (spec 0016 + 0024 + 0030 own them). The decision record's "verify the
not-found state exists; add `VultusEmptyState` if not" is resolved by
**verification: it already exists** at `title-detail.page.html:27-38` —
`<vultus-empty-state data-test="not-found" icon="film-outline" title="Title not
found" subtitle="This title no longer exists." />` plus a `fill="clear"
routerLink="/tabs/watchlist"` "Go back" button — so the invalid-id guard's
`{ kind: 'not-found' }` renders the existing card with no new markup. The
`VultusEmptyState` token wiring is the design-system component already imported
by the page; tokens live at `docs/design/vultus-design-system.md` (do not
re-print hex values). Stated explicitly so the absent UI section is understood as
intentional, not an omission.

## Implementation task graph

Two code tasks touch the **same** title-detail files (the page change and the
client change both live in `libs/mobile/title-detail/src/lib/**`, and the page
spec exercises both), so they are **sequential** — one feature-implementer owns
the slice change end to end. The verification tasks are read-only and the two
e2e flows touch disjoint files; they can run in parallel after the slice fix
lands in the worktree.

### Sequential (the slice fix — single owner)

1. **[sequential] Reactive id + invalid-id guard + no-hint 404-only fallback
   (`libs/mobile/title-detail`, `scope:mobile`/`slice:title-detail`).**
   frontend-engineer. Must finish before the e2e flows are un-skipped.
   - `title-detail.page.ts`: replace `readonly tmdbId = Number(snapshot…)` with
     `tmdbId$` from `route.paramMap` (`map` → `distinctUntilChanged` →
     `shareReplay`); drive `detail$` off `combineLatest([tmdbId$, retryTrigger$])`
     with the `NaN`/`0` → `{ kind: 'not-found' }` short-circuit; maintain a
     synchronously-readable `currentTmdbId` (via `takeUntilDestroyed`) and point
     `updateStatus` / `removeTitle` / `alertButtons` handler / `actionSheetButtons`
     at it. Remove the old `tmdbId` field and its lingering reads.
   - `tmdb-detail.client.ts`: narrow the no-hint `catch` to fall through to tv
     **only** when `err instanceof TmdbDetailError && err.status === 404`; re-throw
     otherwise.
   - `title-detail.page.spec.ts`: add the stale-param-reuse and invalid-id
     regressions (see Test plan); keep all existing specs green. The existing
     test double provides `ActivatedRoute` via `snapshot` only — extend it to
     supply a **mutable** `paramMap` Observable (e.g. a `BehaviorSubject<ParamMap>`)
     so a second emission can reproduce the reuse bug; keep a `snapshot` shim if
     any other code path still reads it.
   - `tmdb-detail.client.spec.ts`: add no-hint 404 fall-through vs non-404
     re-throw cases (mock `fetch` via the factory's `fetchImpl`).
   - Update `libs/mobile/title-detail/README.md` **only if** it documents the
     snapshot-based id derivation — note the page now reacts to `route.paramMap`
     (Ionic page reuse). No barrel/public-API change.
   - **File manifest (creates/modifies):**
     - `libs/mobile/title-detail/src/lib/title-detail.page.ts`
     - `libs/mobile/title-detail/src/lib/tmdb-detail.client.ts`
     - `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`
     - `libs/mobile/title-detail/src/lib/tmdb-detail.client.spec.ts`
     - `libs/mobile/title-detail/README.md`

### Parallel (after task 1 — disjoint manifests)

2. **[parallel] Verify the two navigation entry points (`libs/mobile/watchlist`,
   `libs/mobile/search`).** frontend-engineer. **Read-only.**
   - Confirm `watchlist.page.ts:250-252` `navigateToDetail(titleId)` is called
     with `titleId(item) === String(item.tmdbId)`, and `search.page.ts:88` uses
     `String(result.tmdbId)`. Both pass the correct id — **expected: no change.**
     If a defect is found, record it and flag to the orchestrator (would make this
     task non-read-only and require its own manifest entry).
   - **File manifest:** none expected (verification only).

3. **[parallel] e2e: watchlist → detail shows the tapped title
   (`apps/mobile-e2e/src/title-detail.spec.ts` + the `seeded` fixture).**
   qa-runner / frontend-engineer.
   - **Seed a `title-cache/2` doc so detail resolves cache-first, no network.**
     `title-detail.spec.ts` uses `bootAndSeed` and does **not** import `routeTmdb`,
     so a cache miss on tmdbId `2` would call the live TMDB client over the real
     network (no `TMDB_API_KEY` in e2e) → the page renders `error`/`not-found`, not
     the hero. The seeded watchlist entry (`tmdbId: 2`, "Breaking Bad") has **no**
     matching `title-cache/2` doc. Add one to the `seeded` fixture
     (`apps/mobile-e2e/emulator-data/seeded/docs.json`) so `resolveDetail(2)`
     resolves from cache and never hits TMDB. The doc must match
     `TitleCacheWriteData` (`libs/shared/firestore-schema`): `type: "tv"`,
     `traktId: null`, `metadata: { title: "Breaking Bad", overview: <mock>,
     posterPath: "/breaking-bad-poster.jpg", releaseDate: null }`, and
     `lastSyncedAt: { "__timestamp": "..." }` (the same `__timestamp` marker the
     seed encoder uses for `addedAt`). Path: `title-cache/2` (top-level, **not**
     under `users/{uid}` — `title-cache` is not user-scoped).
   - **Un-skip the `test.fixme` F4 flow.** It already navigates the seeded
     "Breaking Bad" card → asserts `\/tabs\/title-detail\/2$`. Remove the
     `test.describe.fixme` gate for F4 (keep F5/F6 status/remove flows as they are
     unless trivially un-skippable); tighten the title assertion to the seeded
     title via the detail hero (`[data-test="hero"] .hero-title`).
   - **File manifest (creates/modifies):**
     - `apps/mobile-e2e/src/title-detail.spec.ts`
     - `apps/mobile-e2e/emulator-data/seeded/docs.json` (add the `title-cache/2` doc)

4. **[parallel] e2e: search → detail shows the tapped title
   (`apps/mobile-e2e/src/search.spec.ts` + a new detail fixture +
   `apps/mobile-e2e/src/support/tmdb.ts`).** qa-runner / frontend-engineer.
   - **Path-discriminate the TMDB interception.** Today `routeTmdb` intercepts
     **every** `**/api.themoviedb.org/**` request and returns the single
     `tmdb-search-multi.json` (shape `{ results: [...] }`). The search→detail flow
     fires **two** TMDB calls: `search/multi` (search) **and** `GET /movie/603`
     (the detail page's `getDetail(603)` on a cache miss). With the current helper
     the detail call gets the search-multi JSON; `mapDetail` reads top-level
     `raw.title`/`raw.overview`, none of which exist on a `{ results }` object, so
     the hero renders empty and the title assertion fails regardless of the fix.
   - **New fixture** `apps/mobile-e2e/fixtures/tmdb-movie-detail-603.json` (mock
     data, detail shape — not real TMDB output):
     `{ "id": 603, "title": "The Matrix", "release_date": "1999-03-31",
     "overview": "A computer hacker learns...", "poster_path": null,
     "vote_average": 8.7 }`.
   - **Extend `routeTmdb`** in `apps/mobile-e2e/src/support/tmdb.ts` to
     **path-discriminate** (or add a sibling helper, e.g. `routeTmdbDetail`):
     requests matching `**/search/multi**` → `tmdb-search-multi.json`; requests
     matching `**/movie/603**` → `tmdb-movie-detail-603.json`. Both handlers must
     be **registered in the test** before navigating to Search (Playwright applies
     the most-specifically-matched route; keep the existing single-fixture call
     signature working so other specs are unaffected). Preserve the no-secret /
     no-live-call invariant (spec 0019 header).
   - **The flow:** register the discriminated routes → search "matrix" → wait for
     `.result-card` → tap the movie result card body → assert
     `\/tabs\/title-detail\/603$` (The Matrix, id 603 in `tmdb-search-multi.json`)
     → assert the detail hero (`[data-test="hero"] .hero-title`) shows "The Matrix"
     (the **tapped** title, served by the `/movie/603` detail fixture — not a
     fall-through title). This exercises the live-fallback path (no cache seeded),
     which is exactly where the wrong-title bug bit.
   - **File manifest (creates/modifies):**
     - `apps/mobile-e2e/src/search.spec.ts`
     - `apps/mobile-e2e/fixtures/tmdb-movie-detail-603.json` (new)
     - `apps/mobile-e2e/src/support/tmdb.ts` (path-discriminating routing)

> Tasks 3 and 4 write disjoint files and may run concurrently; both depend on
> task 1's fix being present in the worktree (otherwise they assert the bug).
> Per user memory (`emulator-tooling-limitation`), the Firestore/Auth emulator
> cannot run under Claude Code tools here — the e2e gate **degrades gracefully**
> (authored + committed, run in the user's terminal). The component/unit tests in
> task 1 are the in-CI gate that proves the fix.

## Test plan

Per the PLAN §5 pyramid: **unit** for the client branch, **component** for the
page's reactive id + guard, **e2e** for the two named navigation flows.

**Unit — `tmdb-detail.client.spec.ts` (mock `fetch` via `fetchImpl`):**

- **No-hint 404 fall-through (correct behaviour preserved):** `/movie/{id}`
  responds 404 → client calls `/tv/{id}` and returns the tv title. Asserts both
  endpoints were called in order.
- **No-hint non-404 re-throw (the fix):** `/movie/{id}` responds 500 (or the
  fetch rejects / a network error) → `getDetail(id)` **rejects** (does **not**
  call `/tv/{id}`, does **not** return a title). Before the fix this returned the
  tv title — the regression assertion.
- **Hinted path unchanged:** `getDetail(id, 'tv')` calls only `/tv/{id}`;
  `getDetail(id, 'movie')` calls only `/movie/{id}` (no fall-through with a hint).
- Existing `getDetail`/`getProviders` mapping tests stay green.

**Component — `title-detail.page.spec.ts` (Angular Testing Library on Vitest;
service mocked via DI; `ActivatedRoute.paramMap` driven by a `BehaviorSubject`):**

- **Stale-param reuse → correct title (primary regression):** mount the page with
  `paramMap` emitting `titleId=1396` (Breaking Bad); assert the hero shows
  Breaking Bad. Then push a **new** `paramMap` value `titleId=27205` (Inception)
  **on the same component instance** (simulating Ionic reuse) and assert the hero
  re-renders **Inception** — and that the service's `detail$` was called with
  `27205`. Before the fix (snapshot-bound field) the page keeps showing the first
  title; this assertion fails against the unfixed code. (The existing double must
  be extended to a mutable `paramMap`; a synchronous `of(...)` snapshot cannot
  reproduce reuse.)
- **Invalid id → not-found (guard):** `paramMap` emits `titleId` absent (→
  `Number(null)===0`) and separately `titleId='abc'` (→ `NaN`); assert the page
  renders `[data-test="not-found"]` and that the service `detail$` was **not**
  called (no TMDB hit on an invalid id).
- **Handlers act on the current title:** with the page reused from id A to id B
  (loaded), invoking the status change / remove calls
  `service.updateStatus(B, …)` / `service.removeTitle(B)` — **not** A. Guards the
  stale-field handler regression.
- **No regressions:** all existing `TitleDetailPage` specs remain green (loading
  skeleton, not-found, error+retry, loaded movie/tv, poster placeholder, provider
  groups, null-region, tracked/untracked actions, cache/live parity). The retry
  trigger still re-runs resolution (now via `combineLatest([tmdbId$,
  retryTrigger$])`).

**e2e — REQUIRED (per the rubric).** This is a `scope:mobile` fix to the primary
title-detail navigation route and the exact user-facing symptom is a navigation
defect, so named flows are required and become DoD gates (`qa-runner` /
`feature-reviewer`). Two flows, against the emulator-backed harness (spec 0019:
`clearAll` / `resolveAnonUid` / `seedFor` / `routeTmdb`):

- **`watchlist-to-detail-correct-title`** (`title-detail.spec.ts`, un-skipped from
  F4): seed one watchlist entry **plus a `title-cache/2` doc** → tap its card → URL
  is `tabs/title-detail/2` → the detail hero shows the seeded title. The
  `title-cache/2` seed makes detail resolve **cache-first** so the flow needs **no**
  TMDB interception (`title-detail.spec.ts` does not import `routeTmdb`); without it
  the cache-miss live call would hit the real network (no `TMDB_API_KEY`) and the
  page would render `error`/`not-found` instead of the hero.
- **`search-to-detail-correct-title`** (`search.spec.ts`, new): register the
  **path-discriminating** TMDB routes (`search/multi` → `tmdb-search-multi.json`,
  `movie/603` → the new `tmdb-movie-detail-603.json`) → search → tap the movie
  result (The Matrix, id 603) → URL is `tabs/title-detail/603` → the detail hero
  shows "The Matrix" (the tapped title). The detail call here is a **cache miss**
  (nothing seeded), so it exercises the live `getDetail` path the bug bit — which is
  why the `/movie/603` interception (detail shape, not `{ results }`) is required.

> **Synthetic-id note.** The e2e seed uses a **synthetic `tmdbId: 2`** for "Breaking
> Bad" (`emulator-data/seeded/docs.json`), whereas the component tests use the
> **real** TMDB id `1396`. These id spaces are independent and need **not** match:
> e2e asserts `tabs/title-detail/2` against the seeded `title-cache/2`, while the
> component test asserts reuse `1396` → `27205` against a mocked service. Do not
> "reconcile" them.

> **Decision-record note (resolved):** the record said "use the
> `--configuration=mock` serve target" for e2e. The repo's actual e2e harness
> (spec 0019, `playwright.config.ts`, `support.ts`) runs against the **Firebase
> emulator with `routeTmdb` interception**, not a `mock` serve configuration.
> These flows therefore follow the established harness — there is no separate
> `mock` Playwright target to wire up, and inventing one would diverge from spec
> 0019. The flows are **fixme-free** (no dependency on an unmerged spec; the route
> and both entry points already exist).

## Definition of done

Tailored from PLAN §5 / CLAUDE.md to this navigation/data-resolution fix.

- [ ] `pnpm nx typecheck mobile-title-detail` passes — `tmdbId$`, the
      `distinctUntilChanged` import, the guard, and the narrowed client catch
      compile.
- [ ] `pnpm nx lint mobile-title-detail` passes **with Sheriff active** — the
      slice imports only `@angular/*`, `@ionic/*`, `ionicons`, `rxjs`,
      `@vultus/shared/{domain,domain/tokens,ui-kit}`; **no other-slice import, no
      `apps/mobile` import.**
- [ ] `pnpm nx test mobile-title-detail` passes — the new stale-param-reuse,
      invalid-id, and handlers-act-on-current-title component tests are green; the
      no-hint 404-vs-non-404 client tests are green; all pre-existing
      title-detail specs still pass.
- [ ] `pnpm nx build mobile` passes within budgets.
- [ ] **Navigation entry points verified read-only:** watchlist
      (`String(tmdbId)`) and search (`String(result.tmdbId)`) confirmed correct —
      **no change** (or, if a defect was found, the minimal fix + why, recorded in
      the PR).
- [ ] **e2e authored + committed:** `watchlist-to-detail-correct-title` (un-skipped
      F4) and `search-to-detail-correct-title` (new) assert the **tapped** title.
      Run green where the emulator gate is runnable; degrade gracefully if the
      emulator tooling is absent here (user memory `emulator-tooling-limitation`) —
      flag for a run in the user's terminal rather than reporting them passed.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green (affected:
      `mobile-title-detail`, `mobile`; `mobile-e2e` if its config marks it
      affected).
- [ ] **No data-model / `firestore.rules` / `firestore.indexes.json` /
      `sheriff.config.ts` change** — verified, recorded in the PR.
- [ ] **No secret read/written** (CLAUDE.md hard rule).
- [ ] **README updated in the same change** if it documented the snapshot-based
      id (`libs/mobile/title-detail/README.md`).
- [ ] PR description records: the two defects fixed (stale snapshot under Ionic
      reuse; no-hint blanket-catch), how the handlers now read the current id, the
      navigation-verification result, and the e2e run status (run here vs deferred
      to the user's terminal).

## Risks

- **TMDB ids are namespace-collision-prone.** The same integer id is a different
  title under `/movie/{id}` vs `/tv/{id}`. The no-hint fall-through is the root of
  the wrong-title symptom: narrowing it to 404-only stops a 200-but-wrong movie
  result from leaking through, but the no-hint path **still** prefers movie on a
  real collision (a valid movie id that is also a valid tv id resolves as the
  movie). This is acceptable for the **untracked/uncached** live path (we have no
  type hint); the **tracked** path already passes `typeHint` from the watchlist
  doc and is unaffected. If a specific collision is observed in practice, the
  durable fix is to thread a type hint from the navigation source (out of scope
  here) — recorded so it is not silently assumed solved.
- **Ionic page-reuse behaviour is environment-sensitive.** The component test
  simulates reuse by re-emitting on `paramMap`; the real on-device reuse depends
  on `ion-router-outlet` caching. The e2e flows exercise distinct first
  navigations (watchlist and search) but a single-session A→B→A reuse on device is
  not asserted by Playwright here. The reactive `paramMap` derivation is the
  Angular-supported fix for in-place param changes regardless of whether Ionic
  reuses or recreates the instance; the component test pins the reuse contract.
- **`takeUntilDestroyed` / current-id subscription.** Maintaining a synchronous
  `currentTmdbId` for the handlers must use `takeUntilDestroyed` (injection
  context) to avoid a leak; if read instead from the `shareReplay` last value, the
  handler must tolerate the (unreachable-from-loaded) pre-emission state. Either
  way the action-sheet/alert are only reachable from `loaded`, so the id is
  always the resolved title's.
- **Test-double timing.** The bug is invisible to a synchronous `of(snapshot)` /
  static `paramMap` double; the reproduction **must** drive `paramMap` from a
  mutable source (`BehaviorSubject`) and emit a second value, or the new test
  passes against the unfixed code and provides no regression coverage. Called out
  in the test plan.
- **Emulator gate not runnable here** (user memory `emulator-tooling-limitation`)
  — the two e2e flows are authored/committed and gate in CI / the user's terminal;
  the component + unit tests are the in-tool proof of the fix. Do not report the
  e2e flows green off a build alone.
- **No PLAN conflict.** The fix stays within the `slice:title-detail` vertical
  slice and the existing Firestore data model (PLAN §3–§4); it introduces no
  cross-slice/cross-scope import and no shared extraction.
