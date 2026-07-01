# mobile-watchlist

The **Watchlist** tab slice — a `scope:mobile` vertical slice owning the
watchlist tab's UI, state, data, and slice-local types (spec 0014, PLAN §6
item 18). It renders the user's watchlist as a realtime, status-grouped list of
poster cards with a type filter, per-item status changes, and removal. A
**toolbar refresh button** (spec 0025) triggers a manual, client-side
rate-limited sync of the user's tracked titles.

Spec 0046 adds four **client-side** view controls over the already-subscribed
`watchlist$` stream (no new Firestore query/index): a **sort** action sheet, a
**status-filter** chip row, a **text-search** bar, and a **provider-filter** chip
row. All filter/sort state is component-local and **in-session only** (resets on
restart). Composition order is **type → text search → [derive provider chips] →
status → provider → sort**; sort reorders within each status group while the
group order stays Watching → Planned → Completed → Dropped.

## Public surface (barrel `@vultus/mobile/watchlist`)

- **`WatchlistPage`** — a standalone Ionic page component (selector
  `lib-watchlist`) rendering the Watchlist tab: type segment (All / Movies / TV
  Shows), status-grouped sections (Watching → Planned → Completed → Dropped),
  poster cards with type/vote/provider badges, a long-press/secondary status
  action sheet, a delete-confirm alert, pull-to-refresh, a header
  **notifications bell** with an **unread badge** (see below), and shared
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
  - `updateStatus(uid, titleId, status, type)` — updates the `status` field on a
    watchlist item and returns `Promise<void>`. Null uid → no-op.
    **Completed-marks-episodes side effect (spec 0053):** when the new `status`
    is `'completed'` **and** `type === 'tv'`, every currently-unwatched episode
    under `users/{uid}/watchlist/{titleId}/episodes` is batch-marked
    `{ watched: true, watchedAt: <now> }` before the status write — so manually
    completing a TV show from the watchlist tab marks all its episodes watched
    (issue #131). Only the transition **to** `'completed'` triggers this; moving
    a status **away** from `'completed'` leaves episodes untouched (forward
    direction only). Movies short-circuit to a bare status write, and TV shows
    whose episodes are all already watched or not-yet-synced are cheap no-ops
    (the batch is skipped when there are zero unwatched docs — no extra status
    read, and re-selecting "Completed" on an already-completed show is a no-op).
    Episode docs are created by the sync engine and are only **updated** here
    (never created). The `type` is the slice-local decision input for TV-vs-movie
    and is passed from the caller's `WatchlistItem.type` — the private
    `markAllEpisodesWatched` helper is deliberately duplicated with the
    title-detail slice's copy (2-slice, short of the 3+-slice extract rule). The
    page calls it fire-and-forget (`void`), so the action sheet closes
    immediately and does not block on the batch.
  - `removeTitle(uid, titleId)` — deletes a watchlist item. Null uid → no-op.
  - `userRegion$(uid)` — the user's persisted region from `users/{uid}`. Null
    uid / missing doc → `null`.
  - `availability$(tmdbId, region)` — provider availability from
    `title-cache/{tmdbId}/availability/{region}` for the provider badge. Null
    region / missing doc → `null`.
  - `unreadNotificationCount$` — a realtime stream of the count of UNREAD
    notifications (spec 0042). Reactive to the `AUTH_UID` null → uid transition
    (`toObservable(uid) → switchMap`), it reads `users/{uid}/notifications` via
    the `scope:shared` `notificationsPath` helper and counts `readAt == null`
    **client-side** over the streamed collection — deliberately the index-free
    path (no `where('readAt','==',null)` query, no `firestore.indexes.json`
    entry). Null uid → `0`.

## Header notifications bell + unread badge (spec 0042)

The toolbar's `ion-buttons slot="end"` carries a **bell `ion-button`**
(`notifications-outline` ionicon) between the refresh and account buttons. An
overlaid `ion-badge` shows the unread-notification count from
`unreadNotificationCount$`: **hidden when the count is 0**, displaying the number
otherwise and **capped at "9+"** above 9 (`badgeLabel()`). Tapping it calls
`openNotifications()`, which navigates **by string segments**
(`Router.navigate(['tabs','notifications'])`) — the watchlist does **not** import
`@vultus/mobile/notifications` (Sheriff-clean cross-slice navigation; the
`tabs/notifications` route is owned by the shell). The badge is themed with the
`--ion-color-primary` (emerald) background and `--ion-color-primary-contrast`
text via theme tokens — no hand-set hex.

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

The slice-local grouping/filtering/sort helpers (`groupByStatus`, `filterByType`,
`sortItems`, `getAvailableProviders`, the `WatchlistSort` type,
`STATUS_DISPLAY_ORDER`, `STATUS_LABELS`, `StatusGroup`) live in
`watchlist.service.ts` and are **not** exported from the barrel — they are
slice-internal (a single consumer, `WatchlistPage`, imports them intra-slice; no
3+-slice reuse, so they stay slice-local per PLAN §3). The barrel
(`@vultus/mobile/watchlist`) exposes only `WatchlistPage` and `WatchlistService`.

## Sort / filter / search controls (spec 0046)

All four are component-local, in-session, and operate client-side over the
already-subscribed `watchlist$` stream — **no new Firestore read/write/index**.
The provider filter reuses the **same memoized per-card `availability$`
subscription** (`providerCache`, widened from `Observable<string | null>` to
`Observable<string[]>`); the per-card badge still shows the first name via
`names[0] ?? null`, so no second Listen channel is opened (decision 12).

- **Sort** — a toolbar `swap-vertical-outline` button (`openSortSheet()`) opens an
  `IonActionSheet` with six modes (`WatchlistSort`: `titleAsc` / `titleDesc` /
  `addedDesc` (default, newest-added) / `addedAsc` / `releaseDesc` / `releaseAsc`).
  `onSortSelected(sort)` applies it via the pure `sortItems(items, sort)` helper,
  reordering **within** each group; release-date sorts push null/absent
  `releaseDate` items to the **end** in both directions.
- **Status filter** — a chip row (`onStatusChipClick(status | null)`): an "All" chip
  (default) plus one chip per **non-empty** post-filter group, each with its count.
  Selecting a status narrows to that one group; counts match the visible cards.
- **Text search** — an `IonSearchbar` (`onSearchInput(term)`), case-insensitive
  substring match on `title`, debounced **200ms** via RxJS `debounceTime` (the
  Ionic `debounce` is set to `0` to avoid double-debounce). Empty/cleared term
  restores the full list.
- **Provider filter** — a chip row derived from the live `availabilityMap`
  (`getAvailableProviders(...)`). Multi-select **OR** logic (`toggleProvider(name)`);
  the row is **hidden** when no availability data is loaded. A stale selection is
  reconciled against the currently-available names so a vanished provider can't
  strand a hidden filter.

The auxiliary chip/availability streams (`statusChips$`, `availableProviders$`,
`availabilityMap$`) each `catchError` to an empty value so a watchlist-stream
error surfaces only through `vm$`'s error state, never as an uncaught error from a
parallel subscriber.

`SyncStateService` (`providedIn: 'root'`) owns the **manual-sync cooldown**
behind the toolbar refresh button (spec 0025). As of spec 0052 it **no longer
lives in this slice** — it was relocated to **`@vultus/shared/ui-kit`** and is
now shared with **`slice:title-detail`** (both slices inject the one singleton,
so a sync triggered from either gates the other). `WatchlistPage` imports it from
`@vultus/shared/ui-kit`. The service reads/writes the `localStorage` key
**`vultus_last_sync_at`** (ISO string), exposes a `canSync` signal (false while
inside the 5-minute / `300_000` ms cooldown, auto re-enabled by a timer at the
exact expiry) and a `syncing` signal, and a `triggerSync()` method that guards
both signals, calls the injected **`TRIGGER_SYNC`** thunk, records a fresh
timestamp + restarts the cooldown on success, and re-throws (without advancing
the timestamp) on failure so the page can show an error toast. On failure,
`triggerSync()` logs at `console.error` level with distinct messages for
`functions/not-found` (callable not deployed / wrong region) and
`functions/unauthenticated` (auth not established) — visible in Chrome
remote-debugging / `adb logcat` for on-device diagnosis (spec 0033).
`localStorage` access is guarded — if it is unavailable or throws, the service
degrades to "always allowed". `WatchlistPage` maps the resolve/reject to a
"Watchlist synced" / "Sync failed — try again later" `ToastController` toast.
See `@vultus/shared/ui-kit`'s README for the canonical service docs.

## Data access

- **Reads:** `users/{uid}/watchlist` (realtime list), `users/{uid}` (region),
  `title-cache/{tmdbId}/availability/{region}` (provider badges), and — on the
  `completed` + `tv` path only — a one-shot read of the whole
  `users/{uid}/watchlist/{titleId}/episodes` subcollection (spec 0053).
- **Writes:** `users/{uid}/watchlist/{titleId}` — status update and delete — plus,
  on the `completed` + `tv` path, a batched `{ watched, watchedAt }` update onto
  the currently-unwatched docs of `users/{uid}/watchlist/{titleId}/episodes`
  (own-user episode docs, an already-permitted write shape). Never writes to
  `users/{uid}`, `title-cache`, or any other path.

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
