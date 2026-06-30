# @vultus/mobile/title-detail

The **pushed per-title detail page** for Vultus (PLAN §6 item 19, spec 0016). It
is **not** a tab — it is reached from the watchlist or a search result and
lazy-routed at **`tabs/title-detail/:titleId`** (where `:titleId === String(tmdbId)`).
It shows the title's metadata (poster, title, year, rating, synopsis), the
streaming providers that carry it in the user's region (text-only, grouped), the
watchlist action area (add / change status / remove), and — for **TV** titles —
a season-grouped **Episodes** section; for **movies** a **Mark as watched**
toggle (spec 0034).

## Barrel exports (`@vultus/mobile/title-detail`)

| Export               | Kind                 | Purpose                                                           |
| -------------------- | -------------------- | ----------------------------------------------------------------- |
| `TitleDetailPage`    | standalone component | the route's `loadComponent` target                                |
| `TMDB_DETAIL_CONFIG` | `InjectionToken`     | TMDB base URLs + auth, provided at root by `apps/mobile`          |
| `TmdbDetailConfig`   | type                 | the shape `TMDB_DETAIL_CONFIG` carries (so the shell can wire it) |
| `SeasonGroup`        | type                 | a season's episodes + derived watched counts (spec 0034)          |
| `EpisodeRow`         | type                 | `EpisodeDoc` + its Firestore doc `id` (spec 0034)                 |

`TitleDetailService`, `TmdbDetailClient`, `TitleDetail`, `GroupedProviders`, and
`DetailViewState` are **slice-internal** (not exported) — no consumer needs them
across the barrel. `SeasonGroup` / `EpisodeRow` are exported only because the
component test (and any future consumer) needs the shapes; they remain
slice-local data.

## TV Episodes section + movie watched toggle (spec 0034)

- **TV titles** render an **Episodes** card below Where-to-Watch: episodes are
  **grouped by season** (ascending), each season **collapsible** (UI-only local
  state) with a `watchedCount/total watched` summary and a **bulk toggle**
  (mark all watched / unwatched). Each episode row has a per-episode watched
  toggle. While the realtime episodes stream has not emitted yet a **skeleton**
  shows; an empty subcollection shows "Episodes will appear after the next sync."
- **Movie titles** render a **Mark as watched** toggle in the action area
  (completed ↔ watching; disabled when the title is `dropped`).
- **Auto status** (service-derived after each episode/season write): first episode
  watched while `planned` → `watching` (advance evaluated first); all episodes
  watched **while status is `'watching'`** → `completed` (spec 0050 refinement —
  `completed` is only reached from `'watching'`, never directly from `'planned'`);
  walking back to zero watched → `planned` **only if this slice auto-set
  `watching`** (a manually chosen status is never clobbered). A `dropped` title is
  never auto-changed.
- **Auto-revert on page init** (spec 0050, decision 4): when `TitleDetailPage`
  loads a `'completed'` TV show whose episodes subcollection contains at least one
  `watched: false` episode (e.g. new episodes added by the spec-0047 sync), the
  status is silently reverted to `'watching'` — no toast, no user-facing message.
  The existing `tracked$` status badge updates reactively. No-op on movies, null
  uid, non-`completed` status, or empty subcollection.
- **No dedicated Stitch screen** for the episode list (spec 0034 decision 8) — its
  design is derived from the in-repo design system (`docs/design/vultus-design-system.md`)
  and is **flagged for human visual verification**.

### New service methods (spec 0034)

- `episodes$(tmdbId, type): Observable<SeasonGroup[]>` — realtime, season-grouped
  episodes; `of([])` for non-tv / null uid / empty subcollection.
- `setEpisodeWatched(tmdbId, episodeId, watched): Promise<void>` — `updateDoc` the
  episode doc, then re-derive status.
- `setSeasonWatched(tmdbId, season, watched): Promise<void>` — batch-update every
  episode of a season, then re-derive status.
- `setMovieWatched(tmdbId, watched): Promise<void>` — completed ↔ watching
  (dropped is a no-op).
- `revertIfNewEpisodes(tmdbId, type): Promise<void>` — **(spec 0050)** page-init
  auto-revert for TV: if status is `'completed'` and at least one episode is
  `watched: false`, silently writes `status: 'watching'`. No-op on movie / null
  uid / empty subcollection / non-`'completed'` status.

## Usage

`apps/mobile` registers the lazy route and provides the config token at root:

```ts
// app.routes.ts (child of `tabs`)
{ path: 'title-detail/:titleId',
  loadComponent: () => import('@vultus/mobile/title-detail').then(m => m.TitleDetailPage) }

// app.config.ts
{ provide: TMDB_DETAIL_CONFIG, useValue: environment.tmdb }
```

The page derives its `:titleId` from **`ActivatedRoute.paramMap`** (reactive
Observable, not snapshot), so Ionic page-reuse re-derives the id in place and
`detail$` automatically re-resolves the new title. An id of `0` or `NaN` (absent
or non-numeric param) short-circuits to `{ kind: 'not-found' }` without a TMDB
call.

The route also accepts an optional **`?type=tv|movie`** query param (spec 0043).
Search and Watchlist already know each result's media type, so they navigate with
it; the page reads it from **`ActivatedRoute.queryParamMap`**, validates it
(anything other than `tv`/`movie` → `undefined`), and threads it to
`TitleDetailService.detail$(tmdbId, typeHint?)` → `TmdbDetailClient.getDetail`.
This **only affects the live TMDB fallback** (cache hits ignore it): without a
hint the client falls through `/movie/{id}` → `/tv/{id}` on a 404, which can
resolve the wrong title when a movie and a tv title share a tmdb id (e.g. 84773).
A correct hint pins the right namespace; an absent/invalid hint preserves the old
fallthrough behavior. The page renders view-states: loading skeleton, loaded (cache or live —
identical for the same data), not-found, **error** (recoverable), empty-providers,
and null-region. The loading / not-found / error states are rendered by the shared
`@vultus/shared/ui-kit` atoms (`vultus-skeleton-hero`, `vultus-empty-state`,
`vultus-error-state`); the error state's "Try again" re-resolves the title via a
retry trigger (`onRetry()`).

### `DetailViewState` (slice-internal) and error handling

`resolveDetail` discriminates failures instead of swallowing them:

- **`loaded`** — cache hit, or live TMDB fallback succeeded.
- **`not-found`** — a genuine cache-miss **and** a live TMDB **404** (the title
  does not exist). An invalid/absent `:titleId` also maps here (no TMDB call).
  Only a 404 lands here.
- **`error`** — a recoverable transient failure: a **Firestore error on the cache
  read** (no longer silently treated as a cache miss), or a live TMDB failure that
  is **not** a 404 (network error, 5xx). Surfaced as the retryable error state.
  The no-hint client path falls through from `/movie/{id}` to `/tv/{id}` **only
  on a genuine 404**; all other errors propagate so they reach `error` instead of
  silently resolving a wrong title.
- **`loading`** — emitted first while resolving.

## Data access

- **Reads** `title-cache/{tmdbId}` (metadata) and
  `title-cache/{tmdbId}/availability/{region}` (providers) via the shared
  `@vultus/shared/firestore-schema` paths + converters — **cache-first**.
- On a cache **miss** (the common case — `title-cache` is functions-only and
  empty until the daily sync), it falls back to a **live, display-only** TMDB
  fetch via a **slice-local `TmdbDetailClient`**. The client **never writes
  `title-cache`** (functions-only per `firestore.rules`).
- **Reads** `users/{uid}.region` for the providers region.
- **Subscribes** to `users/{uid}/watchlist/{titleId}` (realtime) for tracked state.
- **Subscribes** to `users/{uid}/watchlist/{titleId}/episodes` (realtime,
  `idField: 'id'`) for the TV Episodes section (spec 0034).
- **Writes** `users/{uid}/watchlist/{titleId}`: `add` (`status: 'planned'`,
  with denormalized `posterPath` + `voteAverage`), `updateStatus`, `removeTitle`,
  plus the auto-status re-derivation after an episode/season write.
- **Writes** `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`: only the
  `{ watched, watchedAt }` fields, via **`updateDoc` (never `setDoc`)** — episode
  docs are created by the sync engine and must pre-exist. Never `title-cache`,
  never `users/{uid}`.

### Slice-local by design (NOT shared)

The slice owns its **TMDB detail client** and its **watchlist write helpers**.
These deliberately duplicate the search/watchlist slices' patterns — vertical
slice / no-cross-slice-DRY (CLAUDE.md, PLAN §3): one consumer each, far short of
the 3+-slice rule, and importing another slice is a Sheriff violation. Only the
shared **types** (`@vultus/shared/domain`) and **path/converter** helpers
(`@vultus/shared/firestore-schema`) are reused.

## DI contract

- `AUTH_UID` (`@vultus/shared/domain`) — the anonymous-auth uid signal, provided
  by the shell. A null uid is guarded everywhere (null stream / no-op write).
- `TMDB_DETAIL_CONFIG` — base URLs + auth, provided by `apps/mobile` from
  `environment.tmdb`. The slice never reads `environment` or a secret directly.
- AngularFire `Firestore` — injected (third-party, not policed by Sheriff).

The slice obtains the uid via the `AUTH_UID` token, **never** by importing
`ShellAuthService` / `apps/mobile` (a forbidden `slice:title-detail → scope:mobile`
edge).

## Sheriff

Tags: **`scope:mobile`**, **`slice:title-detail`** (by the
`libs/mobile/<slice>/src` path glob). It may import only `scope:shared`
(`@vultus/shared/domain`, `@vultus/shared/firestore-schema`) and third-party
(AngularFire, `@ionic/*`, `ionicons`, `@angular/router`, `rxjs`, global `fetch`).
**No other slice import** (`slice:search`/`slice:watchlist`/`slice:settings`) and
**no `scope:functions` import**.
