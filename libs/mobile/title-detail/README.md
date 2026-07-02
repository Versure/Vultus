# @vultus/mobile/title-detail

The **pushed per-title detail page** for Vultus (PLAN §6 item 19, spec 0016). It
is **not** a tab — it is reached from the watchlist or a search result and
lazy-routed at **`tabs/title-detail/:titleId`** (where `:titleId === String(tmdbId)`).
It shows the title's metadata (poster, title, year, rating, synopsis), the
streaming providers that carry it in the user's region — split into **"On Your
Providers"** vs **"Also Available On"** (spec 0060, see below) — the watchlist
action area (add / change status / remove), and — for **TV** titles — a
season-grouped **Episodes** section; for **movies** a **Mark as watched** toggle
(spec 0034). While a title is **untracked**, the action area offers a one-step
**"Mark as Watched"** add alongside "Add to Watchlist" (spec 0056).

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

## "Where to Watch" — two-group split (spec 0060)

The "Where to Watch" card partitions **all** of the title's providers (flatrate +
rent + buy) for the resolved region into **two labelled subgroups**, driven by the
user's selected provider ids (`users/{uid}.myProviderIds`, read via
`TitleDetailService.myProviderIds$()`, default `[]`):

- **"On Your Providers"** — the user's selected **flatrate** providers only
  (`providerId ∈ myProviderIds`). "Yours" is a subscription concept, so a rent/buy
  provider is **never** in this group even if its id happens to be selected. Each
  row shows a bold provider name, a "Yours" tag, and a "Subscription" caption.
- **"Also Available On"** — **every other** provider: non-selected flatrate + **all**
  rent + **all** buy. Rows show a muted (non-bold) provider name and a per-type
  caption (flatrate → "Subscription", rent/buy → "Rent/Buy").

The split is computed by the exported **pure** helper
`partitionProviders(providers: WatchProvider[], myProviderIds: number[]):
{ mine; elsewhere }` (the per-row `type` is preserved for the caption). This logic
is **deliberately duplicated** vs the watchlist slice's own flatrate-only pill
partition — two slices with different presentations, short of the 3+-slice extract
rule (CLAUDE.md / PLAN §3); do not extract a shared helper.

**Rendering rules:** only non-empty subgroups render (no empty header/divider);
order is **"On Your Providers"** first, then **"Also Available On"**, with a
hairline divider between them when both are present, and — below them — the
spec-0061 **"Personal Tracking"** Plex subsection (see below). When there
are **no** providers at all, the existing "Not available to stream in your region"
copy is shown unchanged; the null-region prompt is likewise unchanged.

## "Personal Tracking" — manual Plex override (spec 0061)

A **"Personal Tracking"** subsection sits at the **bottom** of the "Where to
Watch" card, below 0060's provider groups, separated by the same
`border-t outline-variant/10` divider convention. It is a **manual,
presentation-only** flag — Vultus cannot query a self-hosted Plex server, so this
is not sync/availability data (GitHub #140).

- **Visibility gate:** the whole subsection renders **only when `vm.hasPlex` is
  true** (the user uses Plex, read from `users/{uid}.hasPlex` via
  `TitleDetailService.hasPlex$()`, default `false`) **and** the title is tracked
  (there is a watchlist doc to write the flag onto). When `hasPlex` is false the
  subsection is omitted entirely (not even an empty-state row). The **read** of
  the per-title flag is not otherwise gated — a title tagged before the user
  unchecked "I use Plex" still displays correctly wherever the item is streamed.
- **State (exactly one row renders):** driven by `vm.tracked.watchingViaPlex`.
  - **Active** (`true`): a `surface-container` row with a 40×40
    `surface-container-highest` tile holding the bundled Plex wordmark
    (`/assets/plex-logo.svg`, `object-fit: contain` — the asset is a WIDE
    wordmark, so `contain` keeps it uncropped), a bold **"Watching via Plex"**
    title, a muted **"Local Server"** caption, and a text-only **"Change"**
    affordance. Tapping the row unsets the flag.
  - **Empty** (`false`): a dashed `outline-variant/30` row with a muted `add`
    glyph tile and **"Mark as watching via Plex"**; the whole row taps to set the
    flag (border shifts to `primary/50` on hover).
- **Toggle:** both states call `TitleDetailPage.togglePlex(tracked)` →
  `service.toggleWatchingViaPlex(tracked.tmdbId, !tracked.watchingViaPlex)`, a
  single-field scalar `updateDoc({ watchingViaPlex })`. The realtime `tracked$`
  subscription then swaps the row in place.
- **Additive, never a replacement (decision 4):** this subsection renders **in
  addition to** 0060's "On Your Providers" / "Also Available On" groups — the
  TMDB availability framing is unchanged whether `watchingViaPlex` is true or
  false (asserted in the component tests). The Plex brand colour lives entirely
  in the image asset; every chrome colour consumes `--vultus-*` / `--ion-*`
  tokens (no hard-coded hex).

The bundled `/assets/plex-logo.svg` is a **shared static asset** consumed by URL
(also used by the settings chip and the watchlist badge in their own slices) —
it is not a lib import, so it creates no cross-slice Sheriff edge.

The 40×40 logo tile shows the provider's **initials** (the per-title
`WatchProvider` carries no logo path — unlike the catalog's `CatalogProvider`).
The trailing `open-outline` glyph is a **decorative hover affordance only**: this
app has **no per-provider deep-link URL**, so the row is presentational — no
`href`, no click handler, no navigation (the row raises `surface-container` →
`surface-container-high` and the glyph shifts to primary on hover).

Visual contract from the canonical Stitch screen **"Movie Detail - Personal
Tracking - Vultus"** (`562019f29ce2412d90c757a7e45a98bf`, project
`13590348714018893783`). All colours consume `--vultus-*` / `--ion-*` tokens
(`theme.scss`); no hard-coded hex.

## Pull-to-refresh (spec 0052)

The page's `<ion-content>` carries an `ion-refresher` (`slot="fixed"`). Pulling
down calls `onRefresh`, which triggers a **whole-watchlist sync** via the shared
**`SyncStateService.triggerSync()`** (`@vultus/shared/ui-kit`) — the same service
the watchlist tab's refresh button uses. The page's Firestore streams (`tracked$`,
`episodes$`) re-emit reactively once the sync writes land, so there is no
detail-scoped refetch. A successful sync surfaces a **"Refreshed"** success toast;
a failure surfaces an error toast. The **5-minute cooldown** is shared with the
watchlist tab: inside the cooldown (`canSync()` is false) the pull is a silent
no-op (no sync, no toast) — the refresher spinner is always dismissed via
`event.detail.complete()`.

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
- **Manually completing a TV show marks all episodes watched** (spec 0053, issue
  #131): when the user sets a **TV** show's status to `'completed'` via the
  title-detail status action sheet, every currently-**unwatched** episode under
  `users/{uid}/watchlist/{titleId}/episodes` is batch-written
  `{ watched: true, watchedAt: <now> }` **before** the status write — declaring a
  show completed means every episode is watched. Only docs where `watched !== true`
  are batched; if there are none (all already watched, or an empty/not-yet-synced
  subcollection) the batch commit is **skipped**. Movies write status only (no
  episode subcollection). Moving status **away** from `'completed'` never touches
  episodes (forward-direction only). The existing episode checkmarks re-render
  reactively off the `episodes$` stream.
- **Auto-revert on page init** (spec 0050, decision 4): when `TitleDetailPage`
  loads a `'completed'` TV show whose episodes subcollection contains at least one
  `watched: false` episode (e.g. new episodes added by the spec-0047 sync), the
  status is silently reverted to `'watching'` — no toast, no user-facing message.
  The existing `tracked$` status badge updates reactively. No-op on movies, null
  uid, non-`completed` status, or empty subcollection.
- **No dedicated Stitch screen** for the episode list (spec 0034 decision 8) — its
  design is derived from the in-repo design system (`docs/design/vultus-design-system.md`)
  and is **flagged for human visual verification**.

## Untracked "Mark as Watched" one-step add (spec 0056)

When a title is **not yet tracked** (`vm.tracked === null` — the state on arriving
from a search result), the action area renders two sibling buttons: the existing
filled **"Add to Watchlist"** CTA (adds as `'planned'`) and a second, **outlined-
primary** **"Mark as Watched"** button (`checkmark-circle` glyph). Tapping the
latter calls `TitleDetailPage.markAsWatched(detail)` → `service.add(detail,
'completed')`, adding the watchlist doc directly as `'completed'` for **both**
movies and TV shows — no intermediate `planned`/`watching` step. The realtime
`tracked$` subscription then flips the action area to the tracked layout with
status **Completed** (no reload). The tracked branch and every other handler are
untouched.

For a **TV** add-as-`completed`, `add` also bulk-marks any **already-existing**
episode docs watched (see the `add` signature below). For a brand-new show with
**no** episode docs yet, only the `'completed'` watchlist doc is written; once the
sync engine later populates episodes **unwatched**, the existing spec-0050
page-init auto-revert flips the status to `'watching'` — this reversion is
**correct and expected** (episode state cannot be marked before the docs exist),
not a bug.

### Service methods

- `add(detail, status?): Promise<void>` — **(spec 0016 / generalized in 0056)**
  creates `users/{uid}/watchlist/{titleId}` with the denormalized `posterPath` +
  `voteAverage`. `status` defaults to `'planned'` (preserving every existing
  caller, incl. "Add to Watchlist"); pass `'completed'` for the one-step "Mark as
  Watched" add. When `status === 'completed'` **and** `detail.type === 'tv'`, it
  additionally `getDocs` the whole episodes subcollection (all seasons, no `where`
  filter) and `writeBatch`-updates every **existing** doc to
  `{ watched: true, watchedAt: <now> }` — mirroring `setSeasonWatched` minus the
  season filter. It **never `setDoc`s / never creates** episode docs and is a
  no-op on an empty subcollection; a movie or a `'planned'` add performs no episode
  read/write. No-op on null uid.
- `updateStatus(tmdbId, status, type): Promise<void>` — writes the watchlist
  item's `status`. **(spec 0053)** the signature carries the item's `type`: when
  `status === 'completed'` **and** `type === 'tv'`, it first batch-marks every
  unwatched episode watched (see above) before the status write; movies and
  non-`'completed'` statuses write status only. Internal callers pass the known
  type (`setMovieWatched` → `'movie'`; `autoUpdateStatus` / `revertIfNewEpisodes`
  → `'tv'`). The TV-completed helper is a terminal leaf (never re-derives status),
  so there is no recursion.
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
- `hasPlex$(): Observable<boolean>` — **(spec 0061)** whether the user uses Plex
  (`users/{uid}.hasPlex`, read via `docData` + `dataToUser`, default `false` —
  legacy docs missing it → `false`). Gates the "Personal Tracking" toggle
  control's visibility. Null uid / missing doc → `false`.
- `toggleWatchingViaPlex(tmdbId, watchingViaPlex): Promise<void>` — **(spec 0061)** persists the per-title Plex override with a single-field scalar
  `updateDoc({ watchingViaPlex })` at the watchlist item path (like
  `updateStatus`'s `{ status }`). Never touches `myProviderIds` / `hasPlex`.
  No-op on null uid. The current value is read off the existing `tracked$` stream
  (no new read stream).

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
- **Reads** `users/{uid}.region` for the providers region, `users/{uid}.myProviderIds`
  (spec 0060) for the Where-to-Watch split, and `users/{uid}.hasPlex` (spec 0061,
  via `hasPlex$()`) to gate the "Personal Tracking" control.
- **Subscribes** to `users/{uid}/watchlist/{titleId}` (realtime) for tracked state
  (which now also carries `watchingViaPlex`, spec 0061).
- **Subscribes** to `users/{uid}/watchlist/{titleId}/episodes` (realtime,
  `idField: 'id'`) for the TV Episodes section (spec 0034).
- **Writes** `users/{uid}/watchlist/{titleId}`: `add` (default `status:
'planned'`, or `'completed'` for the spec-0056 "Mark as Watched" add, with
  denormalized `posterPath` + `voteAverage`), `updateStatus`, `removeTitle`,
  `toggleWatchingViaPlex` (spec 0061 — single-field `{ watchingViaPlex }`), plus
  the auto-status re-derivation after an episode/season write.
- **Writes** `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`: only the
  `{ watched, watchedAt }` fields, via **`updateDoc` / `writeBatch` (never
  `setDoc`)** — episode docs are created by the sync engine and must pre-exist.
  This includes the spec-0053 completed-path batch (`updateStatus` on a TV show
  set to `'completed'` marks all unwatched episodes watched) and the spec-0056 TV
  add-as-`completed` bulk-mark (`add(detail, 'completed')` on a TV title flips
  every already-existing episode doc watched; a no-op on an empty subcollection).
  Never `title-cache`, never `users/{uid}`.

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
- `SyncStateService` (`@vultus/shared/ui-kit`) + `ToastController` (`@ionic/*`) —
  injected for pull-to-refresh (spec 0052).

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
