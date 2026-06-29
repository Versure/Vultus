# mobile-watchlist

The **Watchlist** tab slice — a `scope:mobile` vertical slice owning the
watchlist tab's UI, state, data, and slice-local types (spec 0014, PLAN §6
item 18). It renders the user's watchlist as a realtime, status-grouped list of
poster cards with a type filter, per-item status changes, and removal. A
**toolbar refresh button** (spec 0025) triggers a manual, client-side
rate-limited sync of the user's tracked titles.

## Public surface (barrel `@vultus/mobile/watchlist`)

- **`WatchlistPage`** — a standalone Ionic page component (selector
  `lib-watchlist`) rendering the Watchlist tab: type segment (All / Movies / TV
  Shows), status-grouped sections (Watching → Planned → Completed → Dropped),
  poster cards with type/vote/provider badges, a long-press/secondary status
  action sheet, a delete-confirm alert, pull-to-refresh, and shared
  loading / empty / error states (see below). Tapping a card calls
  `navigateToDetail(titleId, type)`, which navigates to the title-detail route
  with `queryParams: { type }` so it receives `?type=tv|movie`. The known media
  type (`WatchlistItem.type`) is threaded through because TMDB ids collide
  across the movie and tv namespaces (e.g. id 84773), and the hint disambiguates
  which title to resolve (spec 0043).
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

## Loading / empty / error states

The page's `vm$` is a single stream of
`{ groups: StatusGroup[] | null; error: boolean }` that drives all four list
states, rendered with the shared atoms from **`@vultus/shared/ui-kit`** (spec
0024):

- **error** (`error: true`) → `<vultus-error-state>` with a retry button wired to
  `onRetry()` (re-pushes the current type filter to re-subscribe the stream). A
  thrown Firestore error is caught in the `vm$` pipe via `catchError` and mapped
  to `{ groups: null, error: true }` — it never propagates and tears down the
  stream. The error branch is checked **first**, because on error `groups` is also
  `null`.
- **loading** (`groups === null`, no error) → `<vultus-skeleton-card [count]="5">`.
- **empty** (`groups.length === 0`) → `<vultus-empty-state>` (`film-outline` icon,
  registered in this page via `addIcons`).
- **populated** → the status-grouped sections.

The slice-local grouping/filtering helpers (`groupByStatus`, `filterByType`,
`STATUS_DISPLAY_ORDER`, `STATUS_LABELS`, `StatusGroup`) live in
`watchlist.service.ts` and are **not** exported from the barrel — they are
slice-internal.

`SyncStateService` (`providedIn: 'root'`, slice-internal — **not** barrel-
exported) owns the **manual-sync cooldown** behind the toolbar refresh button
(spec 0025). It reads/writes the `localStorage` key **`vultus_last_sync_at`**
(ISO string), exposes a `canSync` signal (false while inside the 5-minute /
`300_000` ms cooldown, auto re-enabled by a timer at the exact expiry) and a
`syncing` signal, and a `triggerSync()` method that guards both signals, calls
the injected **`TRIGGER_SYNC`** thunk, records a fresh timestamp + restarts the
cooldown on success, and re-throws (without advancing the timestamp) on failure
so the page can show an error toast. On failure, `triggerSync()` logs at
`console.error` level with distinct messages for `functions/not-found` (callable
not deployed / wrong region) and `functions/unauthenticated` (auth not
established) — visible in Chrome remote-debugging / `adb logcat` for on-device
diagnosis (spec 0033). `localStorage` access is guarded — if it is
unavailable or throws, the service degrades to "always allowed". `WatchlistPage`
maps the resolve/reject to a "Watchlist synced" / "Sync failed — try again
later" `ToastController` toast.

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
- **Manual sync constraint (spec 0025):** the toolbar refresh button reaches the
  `triggerSync` callable **only** via the `scope:shared` `TRIGGER_SYNC` injection
  token (provided by the shell). The slice has **no** `@angular/fire/functions`
  import, **no** `@vultus/functions/*` import, and **no** `apps/mobile` import —
  mirroring the `AUTH_UID` pattern.

## Running unit tests

Run `nx test mobile-watchlist` to execute the unit tests via [Vitest](https://vitest.dev).
