# mobile-watchlist

The **Watchlist** tab slice — a `scope:mobile` vertical slice owning the
watchlist tab's UI, state, data, and slice-local types (spec 0014, PLAN §6
item 18). It renders the user's watchlist as a realtime, status-grouped list of
poster cards with a type filter, per-item status changes, and removal.

## Public surface (barrel `@vultus/mobile/watchlist`)

- **`WatchlistPage`** — a standalone Ionic page component (selector
  `lib-watchlist`) rendering the Watchlist tab: type segment (All / Movies / TV
  Shows), status-grouped sections (Watching → Planned → Completed → Dropped),
  poster cards with type/vote/provider badges, a long-press/secondary status
  action sheet, a delete-confirm alert, pull-to-refresh, loading skeletons, and
  an empty state.
- **`WatchlistService`** — `providedIn: 'root'` data-access service:
  - `watchlist$(uid, type?)` — realtime `users/{uid}/watchlist`, mapped to
    domain `WatchlistItem`s, optionally filtered by `TitleType`. Null uid →
    `of([])`.
  - `updateStatus(uid, titleId, status)` — updates only the `status` field on a
    watchlist item. Null uid → no-op.
  - `removeTitle(uid, titleId)` — deletes a watchlist item. Null uid → no-op.
  - `userRegion$(uid)` — the user's persisted region from `users/{uid}`. Null
    uid / missing doc → `null`.
  - `availability$(tmdbId, region)` — provider availability from
    `title-cache/{tmdbId}/availability/{region}` for the provider badge. Null
    region / missing doc → `null`.

The slice-local grouping/filtering helpers (`groupByStatus`, `filterByType`,
`STATUS_DISPLAY_ORDER`, `STATUS_LABELS`, `StatusGroup`) live in
`watchlist.service.ts` and are **not** exported from the barrel — they are
slice-internal.

## Data access

- **Reads:** `users/{uid}/watchlist` (realtime list), `users/{uid}` (region),
  `title-cache/{tmdbId}/availability/{region}` (provider badges).
- **Writes:** only `users/{uid}/watchlist/{titleId}` — status update and delete.
  Never writes to `users/{uid}`, `title-cache`, or any other path.

The watchlist doc id is `String(tmdbId)` (e.g. `1399`), matching spec 0013's write binding.

## Usage

Lazy-loaded by the `apps/mobile` tabs shell as the default landing tab:

```ts
{
  path: 'watchlist',
  loadComponent: () =>
    import('@vultus/mobile/watchlist').then((m) => m.WatchlistPage),
}
```

## Boundaries (Sheriff)

- Tags: **`scope:mobile`**, **`slice:watchlist`** (applied by path glob in
  `sheriff.config.ts`).
- May import **`scope:shared`** (e.g. `@vultus/shared/domain`,
  `@vultus/shared/firestore-schema`) and its **own slice** only — never another
  slice and never `scope:functions`. Third-party imports (`@ionic/*`,
  `@angular/fire`, `firebase`, `ionicons`) are not policed by Sheriff.
- **Key constraint:** the current user's uid is obtained **only** via the
  `scope:shared` `AUTH_UID` injection token (provided by the shell), never by
  importing `ShellAuthService` from `apps/mobile`.

## Running unit tests

Run `nx test mobile-watchlist` to execute the unit tests via [Vitest](https://vitest.dev).
