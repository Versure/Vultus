# mobile-watchlist

The **Watchlist** tab slice — a `scope:mobile` vertical slice owning the
watchlist tab's UI, state, data, and slice-local types (spec 0014, PLAN §6
item 18). It renders the user's watchlist as a realtime, status-grouped list of
poster cards with a type filter, per-item status changes, and removal. A
**toolbar refresh button** (spec 0025) triggers a manual, client-side
rate-limited sync of the user's tracked titles.

Spec 0046 adds four **client-side** view controls over the already-subscribed
`watchlist$` stream (no new Firestore query/index): sort, a **status-filter**
chip row, a **text-search** bar, and a **provider-filter** multi-select. All
filter/sort state is component-local and **in-session only** (resets on
restart). Composition order is **type → text search → [derive provider chips] →
status → provider → sort**; sort reorders within each status group while the
group order stays Watching → Planned → Completed → Dropped.

Spec 0054 **restyles/reorganizes** these controls to the "Advanced Watchlist"
Stitch design (presentation only — no logic, sort-mode, or Firestore change).
Top-to-bottom the tab now shows a **status-filter chip row** (the fixed four
All / Watching / Planned / Completed, each with a live count badge including 0),
then an **underline type-tab row** (All / Movies / TV Shows), then a **search
bar** with a single `tune` trigger at its right edge. The `tune` button opens one
combined **"Sort & Filter" bottom sheet** holding the sort chips and the provider
filter. The old toolbar sort button and the sort action-sheet are gone; the
inline provider-chip row moved into the sheet. See "Sort / filter / search
controls" below for the current control set.

## Public surface (barrel `@vultus/mobile/watchlist`)

- **`WatchlistPage`** — a standalone Ionic page component (selector
  `lib-watchlist`) rendering the Watchlist tab: status-filter chip row (fixed
  four with live counts), underline type tabs (All / Movies / TV Shows), a search
  bar with a `tune` trigger opening the combined "Sort & Filter" bottom sheet,
  status-grouped sections (Watching → Planned → Completed → Dropped),
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
    **Next-unwatched-air-date null-write (spec 0081):** because the completed→tv
    path marks every episode watched, the same status `updateDoc` also sets
    `nextUnwatchedEpisodeAirDate: null` — keeping the denormalized watchlist-doc
    field correct client-side without waiting for the next server-side sync.
    Movies and non-`completed` transitions never touch the field.
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
  - `myProviderIds$(uid)` — the user's selected TMDB provider ids from
    `users/{uid}.myProviderIds` (spec 0060), default `[]` (a legacy doc missing
    the field coalesces to `[]` via `dataToUser`). Null uid / missing doc → `[]`.
    Reads the **same single** memoized `users/{uid}` `docData` stream as
    `userRegion$` (both are projections of one shared `user$` source) — so region
    and provider ids do **not** open two Firestore listeners on the same doc.
  - `availability$(tmdbId, region)` — provider availability from
    `title-cache/{tmdbId}/availability/{region}` for the availability pill. Null
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

The empty and error states carry a page-local **`fill-state`** marker class
(spec 0076, issue #159): `ion-content::part(scroll)` is a flex column and
`vultus-empty-state.fill-state` / `vultus-error-state.fill-state` set
`flex: 1 1 auto; min-height: 0`, so the state fills the space **below** the
persistent status chips / type tabs / search row and centers there (the shared
atom's own `justify/align-center` does the centering; only its
`:host { min-height: 100% }` is overridden — via element+class specificity, no
`!important`). The skeleton keeps its natural block height and does **not** carry
the class. This class is slice-local (not shared/importable — spec 0076 D1).
Because that flex-column scroll part makes every light-DOM `ion-content` child a
flex item, the closed "Sort & Filter" bottom sheet is now clipped with
`overflow: hidden` on `.filter-sheet` (spec 0082) so its off-screen
`translateY(100%)` panel cannot leak ~277px of scrollable overflow into
`ion-content` and let the empty page scroll. The sheet's **open**-state
declarations (`opacity: 1` / `translateY(0)`) are bound directly on
`.filter-sheet-backdrop`/`.filter-sheet-panel` via their own `[class.open]`
bindings — **not** via a nested `.filter-sheet.open` descendant selector, which
failed to win the cascade in-browser (spec 0087, issue #230) — so the open panel
reliably reaches `translateY(0)` and is not clipped by the 0082
`overflow: hidden`.

The slice-local grouping/filtering/sort helpers (`groupByStatus`, `filterByType`,
`sortItems`, `getAvailableProviders`, the `WatchlistSort` type,
`STATUS_DISPLAY_ORDER`, `STATUS_LABELS`, `StatusGroup`) live in
`watchlist.service.ts` and are **not** exported from the barrel — they are
slice-internal (a single consumer, `WatchlistPage`, imports them intra-slice; no
3+-slice reuse, so they stay slice-local per PLAN §3). The barrel
(`@vultus/mobile/watchlist`) exposes only `WatchlistPage` and `WatchlistService`.

## Sort / filter / search controls (spec 0046, restyled by spec 0054)

All are component-local, in-session, and operate client-side over the
already-subscribed `watchlist$` stream — **no new Firestore read/write/index**.
The provider filter reuses a **memoized per-card `availability$` subscription**
(`providerCache`, `Observable<string[]>` of provider names). The per-card
availability **pill** (spec 0060, see below) reads the full `RegionAvailability`
via a sibling memoized cache (`availabilityCache`, `Observable<RegionAvailability
| null>`) so it can see each provider's `type` + `providerId`; both caches
`shareReplay` per `tmdbId|region` so no extra Firestore Listen channel is opened
per change-detection cycle.

The controls render top-to-bottom as: **status-filter chip row → underline
type-tab row → search bar (with `tune` trigger)**, above the grouped list. The
`tune` trigger opens the combined **"Sort & Filter" bottom sheet** (an overlay
`div` toggled by `filterSheetOpen`) that holds the sort chips and the provider
filter.

- **Status filter** — a chip row (`onStatusChipClick(status | null)`) rendering the
  **fixed four** chips (All / Watching / Planned / Completed) **unconditionally**,
  each with a live count badge — **including 0** (spec 0054). No "Dropped" chip
  (the design has none; dropped items still group under "All"). The "All" chip is
  active by default; each count reflects the same type+search+provider-filtered
  set `groupByStatus` sees, so selecting a chip shows exactly that many cards.
  Driven by `statusChips$` (now a `{ status, label, count }[]` of the four fixed
  chips).
- **Type tabs** — three **underline tabs** (All / Movies / TV Shows), plain
  `<button>`s (not `ion-segment`, not pills), same `onFilterClick(type)` behavior
  (All = `undefined`, Movies = `'movie'`, TV Shows = `'tv'`). Active tab shows the
  primary color + a 2px primary underline.
- **Text search** — an `IonSearchbar` (`onSearchInput(term)`, placeholder
  "Search watchlist..."), case-insensitive substring match on `title`, debounced
  **200ms** via RxJS `debounceTime` (the Ionic `debounce` is `0` to avoid
  double-debounce). Empty/cleared term restores the full list. A `tune`
  (`options-outline`) button at the right edge (`aria-label="Sort and filter"`,
  `openFilterSheet()`) opens the combined sheet.
- **Sort & Filter sheet** — one combined bottom sheet (`filterSheetOpen`;
  `openFilterSheet()` / `closeFilterSheet()`). Closes via "Done", a backdrop tap,
  or the **Android hardware back button** (a document-level `ionBackButton`
  handler registered at priority 150 dismisses the sheet before any route
  navigation). It contains:
  - **Sort By** — three chips (**Date Added / Name / Release date**) mapping onto
    the existing six `WatchlistSort` modes with **tap-to-toggle direction**
    (`onSortChipClick('added' | 'name' | 'release')`): an inactive chip applies
    its default direction, tapping the active chip flips it. Mapping: Date Added
    → `addedDesc`/`addedAsc` (default `addedDesc`, newest-added), Name →
    `titleAsc`/`titleDesc`, Release date → `releaseDesc`/`releaseAsc`. The active
    chip shows an up/down arrow direction affordance (`sortChipDirection`). The
    **"Release date"** chip is the Stitch **"Rating"** chip relabelled — the
    watchlist doc has no rating field and there is no rating sort mode, so it maps
    to the existing release-date pair rather than adding a mode (spec 0054 Public
    types / APIs). `onSortSelected(sort)` applies it via the pure
    `sortItems(items, sort)` helper, reordering **within** each group;
    release-date sorts push null/absent `releaseDate` items to the **end**.
  - **Provider** — a multi-select chip row derived from the live `availabilityMap`
    (`getAvailableProviders(...)`), **OR** logic (`toggleProvider(name)` /
    `isProviderSelected(name)`). When no availability is loaded the section shows a
    muted "No providers available yet" line (the sheet stays usable). A stale
    selection is reconciled against the currently-available names so a vanished
    provider can't strand a hidden filter.

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

## Availability pill — "on your provider" framing (spec 0060)

Each card renders **one** partitioned availability pill instead of the old flat
provider badge. Given the title's `title-cache/{tmdbId}/availability/{region}`
providers and the user's `myProviderIds` (`users/{uid}.myProviderIds`), the pure
slice-local `partitionAvailabilityPill(availability, myProviderIds)` filters to
**flatrate** providers only (subscription coverage is a flatrate concept —
spec 0060 decision 4) and yields:

- **`{ kind: 'mine'; name }`** — ≥1 flatrate provider whose `providerId` is in
  `myProviderIds`; `name` is the **first** such provider's name. Rendered as a
  highlighted pill (`--ion-color-primary` ~10% fill, primary text) with a leading
  `checkmark-circle` icon and the copy **"On {name}"**.
- **`{ kind: 'elsewhere'; name }`** — no owned flatrate, but ≥1 flatrate provider
  exists; `name` is the **first** flatrate provider's name. Rendered as a muted
  pill (`--vultus-surface-container-highest` ~40% fill = the design's
  `surface-variant`, `--vultus-on-surface-variant` text), **no** icon, copy
  **"Also on {name}"**.
- **`null`** — no flatrate provider at all (including rent/buy-only availability,
  which is never a compact-card pill). No pill is rendered (the existing no-chip
  treatment). A rent/buy provider whose id happens to be in `myProviderIds` is
  **never** `mine` — only flatrate can be "yours".

The pill is **presentational / non-interactive** (the card is the tap target); no
new hover/focus states. Text is `label-sm` (the card's meta scale); all colors
via `--vultus-*` / `--ion-*` vars (no hand-set hex). The page memoizes the full
per-`tmdbId|region` availability stream (`shareReplay`) — like the existing
`providerCache` — so binding `availabilityPill$(...) | async` never opens a fresh
Firestore listener per change-detection cycle. This partition logic is
deliberately **duplicated** with the title-detail slice's two-group split
(2 slices, short of the 3+-slice extract rule — no shared helper is extracted).

## Read-only Plex badge (spec 0061)

When a title is manually tagged as "watching via Plex" on title-detail, its
watchlist card renders a small **read-only Plex badge** — a compact, neutral
tile holding the bundled Plex wordmark (`/assets/plex-logo.svg`) — **alongside**
0060's availability pill. It is driven purely by `item.watchingViaPlex`, which
arrives on every `WatchlistItem` via the **existing `watchlist$` stream**
(`dataToWatchlistItem` now carries the field): there is **no new service
method, no new Firestore listener, and no new stream** for it (contrast 0060's
`myProviderIds$`, which lives on `users/{uid}` — the Plex flag lives on the item
itself, so it is already in hand). The badge is **additive, never a
replacement**: when `watchingViaPlex` is false/absent the pill renders exactly
as 0060 defines it, and the badge's presence/absence never affects the pill
(decision 4). It is **presentational / non-interactive** — no click/hover/focus
handler; the card remains the tap target and the toggle lives only in
title-detail (decision 5). Because this branch does not yet carry 0060's
`items-end gap-sm` card corner slot, the badge is placed **inline in
`.card-meta`** next to the availability pill (per the spec's "0060 composition
note (T5)"). Brand colour lives in the logo image; all badge chrome uses
`--vultus-*` tokens (no hand-set hex).

## Data access

- **Reads:** `users/{uid}/watchlist` (realtime list), `users/{uid}` (region +
  `myProviderIds`, one shared listener),
  `title-cache/{tmdbId}/availability/{region}` (provider badges), and — on the
  `completed` + `tv` path only — a one-shot read of the whole
  `users/{uid}/watchlist/{titleId}/episodes` subcollection (spec 0053).
- **Writes:** `users/{uid}/watchlist/{titleId}` — status update (on the
  `completed` + `tv` path the same write also nulls `nextUnwatchedEpisodeAirDate`,
  spec 0081) and delete — plus, on the `completed` + `tv` path, a batched
  `{ watched, watchedAt }` update onto the currently-unwatched docs of
  `users/{uid}/watchlist/{titleId}/episodes` (own-user episode docs, an
  already-permitted write shape). Never writes to `users/{uid}`, `title-cache`,
  or any other path.

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
