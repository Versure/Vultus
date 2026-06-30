# mobile-search

The **Search** tab slice of the Vultus mobile app. It provides live, debounced TMDB search with inline add-to-watchlist. It owns the UI, state, data access, and types for the search feature.

## What it does

- Accepts a search query from `IonSearchbar`, debounces it ~400 ms, and calls the TMDB `search/multi` endpoint via the slice-local `TmdbSearchClient`.
- Displays result cards: poster thumbnail, title, release/first-air year, and a Movie/TV Show badge.
- Inline **Add** button writes a `planned` watchlist entry at `users/{uid}/watchlist/{titleId}` via `@vultus/shared/firestore-schema` converters.

## Behavior

- **Optimistic add.** Tapping **Add** flips the button to its added/checkmark state **immediately** — the optimistic local update (`_addedIds` + the result's `added` flag) is applied **before** the Firestore `setDoc` write is awaited.
- **Rollback on failure.** If the write rejects (offline, permission denied, transient network error), `SearchService.add()` **rolls back both** signals (the button reverts to its add state) and **re-throws** so the page can react.
- **Error feedback.** `SearchPage.onAdd()` is `async`, awaits `service.add()` in a `try/catch`, and on failure presents a `color: 'danger'` Ionic toast ("Failed to add — try again later", bottom, 3000ms). `ToastController` (from `@ionic/angular/standalone`) is therefore a page dependency. There is **no success toast** — the button → checkmark transition is the success affordance. The live `collectionData` subscription reconciles the optimistic set against what actually landed in Firestore.
- **Navigation carries the media type.** Tapping a result card (`openDetail`) navigates to `tabs/title-detail/{tmdbId}` with `queryParams: { type: result.type }`, so the title-detail route receives `?type=tv|movie`. This disambiguates TMDB ids that collide across the movie and tv namespaces (e.g. id `84773` maps to different titles per type), preventing the detail page from resolving the wrong title.
- Reads the user's existing watchlist live and marks already-added results as settled/non-actionable (cannot double-add).
- Five view-states: `prompt` (empty query), `loading`, `results`, `no-results`, `error`. The non-`results` states render via the shared `@vultus/shared/ui-kit` state atoms — `<vultus-skeleton-card>` (loading; replaces the old `ion-spinner`), `<vultus-empty-state>` (prompt + no-results), and `<vultus-error-state>` (error, with built-in retry). The page registers `filmOutline` / `search` (consumed by `vultus-empty-state`); `vultus-error-state` registers its own icons.
- Handles null `AUTH_UID` gracefully: search works without uid; `add()` is a no-op when uid is null.

## Public surface

The barrel (`@vultus/mobile/search`) exports:

| Export               | Description                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SearchPage`         | Standalone Ionic page component for the Search tab                                                                   |
| `TMDB_SEARCH_CONFIG` | `InjectionToken<TmdbSearchConfig>` — provided at root by `apps/mobile`                                               |
| `TmdbSearchConfig`   | Config type: `apiBaseUrl`, `imageBaseUrl`, `auth` (bearer or apiKey), optional `fetchImpl` (mock/dev fetch override) |
| `SearchResult`       | Normalized TMDB hit: `tmdbId`, `type`, `title`, `year`, `posterUrl`, `posterPath`, `voteAverage`, `releaseDate`      |

## DI contract

Two tokens must be provided above this slice:

1. **`AUTH_UID`** (from `@vultus/shared/domain`) — a `Signal<string | null>` provided at root by `apps/mobile` from `ShellAuthService.uid`.
2. **`TMDB_SEARCH_CONFIG`** (exported from this barrel) — provided at root by `apps/mobile` from `environment.tmdb`.

`SearchService` is provided **in `SearchPage`** (not root), so its lifecycle and the live watchlist subscription are scoped to the page.

## TMDB key

- **Local dev:** `environment.ts` carries an empty placeholder by default. To populate it from `.env.local` (gitignored) run `pnpm env:tmdb` from the repo root — see `apps/mobile/README.md` for the full setup steps.
- **Production:** `environment.prod.ts` carries `REPLACE_WITH_REAL_TMDB_API_KEY`, which the CI workflow substitutes from the `TMDB_API_KEY` GitHub Actions secret before `nx build` runs (see `.github/workflows/ci.yml`).

## Mock / local dev

To test all search states locally **without a real TMDB API key**, run:

```sh
pnpm nx serve mobile --configuration=mock
```

The mock environment intercepts TMDB fetch calls and returns fixture data based on the search query:

| Query contains | State shown                       |
| -------------- | --------------------------------- |
| `error`        | Error state                       |
| `empty`        | No-results                        |
| `slow`         | Loading (2 s delay, then results) |
| anything else  | 5 fixture results                 |

Poster thumbnails are omitted from mock data (placeholder shown). Firebase still uses the emulator (same as dev). No real API key needed.

## Data access

- **Reads:** `users/{uid}/watchlist` (collection snapshot) — to compute the already-added set.
- **Writes:** `users/{uid}/watchlist/{titleId}` (set doc) — `status: 'planned'`, `traktId: null`, `titleId = String(tmdbId)`, plus `posterPath`, `voteAverage`, and `releaseDate` (raw TMDB `release_date`/`first_air_date`, or `null`).
- Uses `watchlistPath`, `watchlistItemPath`, `watchlistItemToData` from `@vultus/shared/firestore-schema`.
- Does **not** touch `episodes`, `title-cache`, or the `users/{uid}` root doc.

## Sheriff scope / slice boundaries

Tags: **`scope:mobile`**, **`slice:search`**.

This lib may import **only `scope:shared`** and its own slice-internal modules, plus third-party packages (`@ionic/*`, `@angular/*`, `@angular/fire`, `rxjs`). It must **never** import another slice (`slice:watchlist`, `slice:settings`) or `scope:functions`. The slice-local `TmdbSearchClient` is intentional — importing `libs/functions/sync-titles` would be a double Sheriff violation (cross-scope + cross-slice).
