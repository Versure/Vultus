# @vultus/mobile/title-detail

The **pushed per-title detail page** for Vultus (PLAN §6 item 19, spec 0016). It
is **not** a tab — it is reached from the watchlist or a search result and
lazy-routed at **`tabs/title-detail/:titleId`** (where `:titleId === String(tmdbId)`).
It shows the title's metadata (poster, title, year, rating, synopsis), the
streaming providers that carry it in the user's region (text-only, grouped), and
the watchlist action area (add / change status / remove).

## Barrel exports (`@vultus/mobile/title-detail`)

| Export               | Kind                 | Purpose                                                           |
| -------------------- | -------------------- | ----------------------------------------------------------------- |
| `TitleDetailPage`    | standalone component | the route's `loadComponent` target                                |
| `TMDB_DETAIL_CONFIG` | `InjectionToken`     | TMDB base URLs + auth, provided at root by `apps/mobile`          |
| `TmdbDetailConfig`   | type                 | the shape `TMDB_DETAIL_CONFIG` carries (so the shell can wire it) |

`TitleDetailService`, `TmdbDetailClient`, `TitleDetail`, `GroupedProviders`, and
`DetailViewState` are **slice-internal** (not exported) — no consumer needs them
across the barrel.

## Usage

`apps/mobile` registers the lazy route and provides the config token at root:

```ts
// app.routes.ts (child of `tabs`)
{ path: 'title-detail/:titleId',
  loadComponent: () => import('@vultus/mobile/title-detail').then(m => m.TitleDetailPage) }

// app.config.ts
{ provide: TMDB_DETAIL_CONFIG, useValue: environment.tmdb }
```

The page reads its `:titleId`, resolves the uid via `AUTH_UID`, and renders the
view-states: loading skeleton, loaded (cache or live — identical for the same
data), not-found, empty-providers, and null-region.

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
- **Writes** ONLY `users/{uid}/watchlist/{titleId}`: `add` (`status: 'planned'`,
  with denormalized `posterPath` + `voteAverage`), `updateStatus`, `removeTitle`.
  Never the `episodes` subcollection, never `title-cache`, never `users/{uid}`.

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
