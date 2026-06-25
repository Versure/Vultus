---
number: 0016
slug: title-detail-slice
title: Build the title-detail slice — per-title detail page with metadata, regional providers, and watchlist actions
status: done
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-06-22
---

# Build the title-detail slice — per-title detail page with metadata, regional providers, and watchlist actions

## Context

PLAN §6 item 19 — **`slice:title-detail`** — is the **last remaining mobile
slice**. It is the per-title page the user reaches by tapping a title in the
watchlist (spec 0014) or a search result (spec 0013): it shows the title's
metadata, which streaming providers carry it in the user's region, and the
watchlist actions (add / change status / remove).

Unlike `watchlist` / `search` / `settings`, **the shell (spec 0010) did NOT stub
this slice** — decision 2 of 0010 explicitly created only the three tab libs and
noted "`title-detail` is NOT a tab and is NOT created here — it is pushed from
watchlist/search later (PLAN §6 item 19, its own spec)." So unlike specs
0011/0013/0014 (which fleshed out an existing stub), **this spec creates a brand
new lib `libs/mobile/title-detail` from scratch**, Sheriff-tags it
(`scope:mobile` + `slice:title-detail`), and registers its **lazy, pushed route**
at `tabs/title-detail/:titleId`. It is **not** a tab-bar item — it is reached via
the back-button flow from the two entry points.

Spec 0014's watchlist already calls
`router.navigate(['tabs','title-detail', titleId])` (degrading gracefully today
because the route does not yet exist); this spec makes that navigation land
somewhere. It **also** wires the **search slice** (spec 0013, merged) so tapping a
search **result card** (not the inline Add button) navigates to the same route.

Intended outcome: tapping a title (from the watchlist or a search result) opens a
detail page keyed on the TMDB id from the route. The page reads
`title-cache/{tmdbId}` for metadata and
`title-cache/{tmdbId}/availability/{region}` for providers; on a **cache miss**
(the common case — `title-cache` is written only by the daily-sync function, so a
freshly-searched or just-added title is not cached until the next cron) it falls
back to a **live, display-only TMDB fetch**. The page shows the poster, title,
year, overview, the region's providers grouped by type (text only), and a
watchlist action area: **Add to watchlist** when the title is untracked, or the
**current status + a change-status control + remove** when it is tracked. The page
subscribes to `users/{uid}/watchlist/{titleId}` so tracked/untracked state stays
live.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Route param `:titleId === String(tmdbId)`.** The doc-id convention
   established by spec 0013 is `titleId = String(tmdbId)` for
   `users/{uid}/watchlist/{titleId}`, and `title-cache/{tmdbId}` is keyed by the
   numeric TMDB id. This page reads `:titleId` from the route, parses it to a
   number, and keys straight into `title-cache/{tmdbId}` and
   `users/{uid}/watchlist/{titleId}`. The uid comes from the **`AUTH_UID`** token
   (anonymous auth, shell-provided — specs 0010/0011/0013/0014), never from
   importing `apps/mobile`.

2. **Data source = `title-cache` first, **live TMDB fallback** on cache miss.**
   Read `title-cache/{tmdbId}` (metadata via `titleCacheDocPath` +
   `dataToTitleCache`) and `title-cache/{tmdbId}/availability/{region}` (providers
   via `availabilityDocPath` + `dataToAvailability`) — the **same shared helpers
   spec 0014 uses; reuse them, do NOT re-implement**. Because `title-cache` is
   **functions-only** (daily sync) and **empty for any not-yet-synced title**
   (everything reached from search, and freshly-added titles before the next
   cron), a cache miss is **normal**, not an error. On a cache miss, fetch the
   detail **live from TMDB** via a **slice-local TMDB client** (movie + tv detail
   endpoints + watch/providers). This duplicates the search slice's client
   pattern; **that duplication is CORRECT** per vertical-slice / no-cross-slice-DRY
   (`slice:search` cannot be imported — Sheriff). The live fallback is
   **display-only and ephemeral**: the client **cannot and must not write
   `title-cache`** (functions-only per `firestore.rules`). Region resolves from
   `users/{uid}.region` (settings slice, spec 0011); a **null/unset region** is
   handled (no providers section, a prompt to set a region — see UI).

3. **TMDB key dependency (flagged, not duplicated).** The slice-local TMDB client
   reads its API key from the mobile environment the same way the search slice
   does (`environment.tmdb.auth`, provided at root). Spec 0015
   (`tmdb-ci-key-injection`, currently **draft**) wires that key for CI/prod and a
   local dev script. **Production live-fallback only works once 0015 lands**;
   local dev needs the env key synced (manually or via 0015's script). This is
   called out in Risks. **This spec does NOT duplicate 0015's CI work** and does
   not edit `ci.yml`.

4. **Page actions = add / change-status / remove.**
   - **Untracked** (no `users/{uid}/watchlist/{titleId}` doc): an **Add to
     watchlist** action that **creates** the doc with `status: 'planned'` via
     `watchlistItemPath(uid, String(tmdbId))` + `watchlistItemToData(...)` —
     **exactly as spec 0013 does** — denormalizing the **same fields 0014
     expects**: `type`, `tmdbId`, `traktId: null`, `title`, `addedAt` (client-now
     ISO), `status: 'planned'`, **plus** the denormalized `posterPath` +
     `voteAverage` that spec 0014 (decision 4) added to the watchlist doc. Stay
     consistent with 0014's widened `WatchlistItem` / converter shape (see Public
     types — cross-spec coordination).
   - **Tracked**: show the **current status** and offer a **change-status**
     control (the four statuses in a **slice-local `STATUS_DISPLAY_ORDER`** —
     Watching → Planned → Completed → Dropped, mirroring 0014's action-sheet
     pattern, **not** an iteration of `WATCH_STATUSES`) and a **remove** action.
   - These writes are **slice-local** and **duplicate** search/watchlist write
     logic — **allowed, do NOT extract to shared** (one consumer per slice, far
     short of the 3+-slice rule). The page **subscribes** to
     `users/{uid}/watchlist/{titleId}` to reactively reflect tracked/untracked
     state (a just-added title flips the action area without a reload).

5. **Providers = text-only, grouped by type.** The `WatchProvider` shape has
   **no** logo/image field (confirmed in 0014 — `{ providerId, name, type }`).
   Render `provider.name` as **text chips/badges only**, **grouped by type**
   (flatrate / rent / buy), matching 0014's text-only provider treatment. No
   provider logos, no image URLs (TMDB does carry logos, but they are out of scope
   to match the existing domain shape and 0014).

6. **Episodes + mark-watched = OUT OF SCOPE.** PLAN §6 item 19 also lists an
   episode list + per-episode mark-watched. The episodes subcollection
   (`users/{uid}/watchlist/{titleId}/episodes/{episodeId}`) is populated only by
   the sync engine for tracked TV. **Defer to a future spec (0017).** This spec is
   **metadata + providers + watchlist actions only**.

7. **Entry points = both search and watchlist navigate into detail.** Watchlist
   (0014) already navigates to `tabs/title-detail/:titleId`. This spec **also**
   wires the **search slice** (`libs/mobile/search`, `slice:search`) so tapping a
   search **result card** (not the inline Add control) navigates to
   `tabs/title-detail/:titleId`, **preserving 0013's inline-add behavior** on the
   Add button. And it adds the new **lazy route registration** in
   `apps/mobile/src/app/app.routes.ts` (the same place 0010 registers tab routes).
   The search-slice edit and the app-routing edit touch files **outside**
   `libs/mobile/title-detail`, so their manifests stay **disjoint** from the
   new-lib tasks and from each other (see Implementation task graph).

8. **No new e2e in this spec.** e2e + emulator wiring is PLAN §6 item 20. The
   green gate here is **unit + component + build** (what `ci.yml` runs: `lint test
build`). All Firebase and all TMDB HTTP access in tests is **mocked** — no live
   Firebase, no emulator (project memory: the emulator cannot run under Claude Code
   tools here), no real TMDB network, no secrets. (Consistent with specs
   0010/0011/0013/0014.)

## Scope

In scope:

- A **new lib `libs/mobile/title-detail`**, generated with the repo's Angular
  library generator, Sheriff-tagged `scope:mobile` + `slice:title-detail` (by the
  `libs/mobile/<slice>/src` path glob — verify it covers the new slice; see
  Affected slices), with a `@vultus/mobile/title-detail` tsconfig path alias.
- A **slice-local TMDB detail client** (`TmdbDetailClient`): a thin factory over
  injected `fetch` + injected config (reusing the shape of `environment.tmdb`),
  calling TMDB **movie** detail (`/movie/{id}`), **tv** detail (`/tv/{id}`), and
  **watch/providers** (`/movie|tv/{id}/watch/providers`), mapping the raw response
  to a slice-local `TitleDetail` view model. Pure-ish, unit-testable with a fake
  `fetch`. **Display-only — never writes Firestore.**
- A **detail data-access service** (`TitleDetailService`): keyed on the
  `:titleId` route param + the `AUTH_UID` uid, it resolves a `TitleDetail` view
  model from **`title-cache` first, live TMDB on miss**; resolves the region from
  `users/{uid}.region`; subscribes to `users/{uid}/watchlist/{titleId}` for
  tracked state; and performs the **add / updateStatus / removeTitle** writes
  (decision 4) with a null-uid guard.
- The **real `TitleDetailPage`**: poster + title + year + overview, the
  providers-by-type section, and the watchlist action area, across all view-states
  (loading skeleton / loaded-from-cache / loaded-from-live-TMDB / not-found-error /
  empty-providers / null-region).
- A **slice config token** (`TMDB_DETAIL_CONFIG`) provided at root by `apps/mobile`
  from `environment.tmdb` (so the client gets its base URLs / key by DI, never
  reading a secret directly), mirroring `TMDB_SEARCH_CONFIG` (spec 0013).
- The **lazy route** `tabs/title-detail/:titleId` in
  `apps/mobile/src/app/app.routes.ts` (as a sibling child of the tabs shell, so the
  tab bar stays visible — same nesting level as `watchlist`/`search`/`settings`).
- A **minimal edit to the merged search slice** (`libs/mobile/search`): tapping a
  result **card** navigates to `tabs/title-detail/:titleId`, preserving the inline
  Add control's behavior.
- A real `README.md` for the new lib.
- Tests: unit for the client + service, component for the page (Test plan).

Out of scope (each its own later spec):

- **Episode list + per-episode mark-watched** — **deferred to a future spec
  (0017)**. The `users/{uid}/watchlist/{titleId}/episodes/**` subcollection is
  written only by the sync engine for tracked TV; this page does **not** read or
  write it. (PLAN §6 item 19's episode portion is explicitly carried forward.)
- **Writing `title-cache`** — functions-only (`firestore.rules` `write: if false`).
  The live TMDB fallback is display-only and **never** persists to the cache. A
  client write would be both a rules violation and an architecture violation.
- **Provider logos / images** — the `WatchProvider` shape has no logo field; text
  chips only (decision 5).
- **A manual "refresh now" / HTTP sync call** — PLAN §6 items 11–12; not consumed
  here. The page reflects function-driven cache updates via its realtime
  subscription, and uses the live TMDB fallback for cache misses.
- **Trakt data** — `traktId` is set to `null` on add (the sync engine resolves it
  later); no Trakt call here.
- **Emulator-backed e2e** — PLAN §6 item 20 (decision 8). No `ci.yml` /
  `playwright.config.ts` / `apps/mobile-e2e` change.
- **CI key-injection wiring** — owned by spec 0015 (decision 3); this spec reuses
  the existing `environment.tmdb` plumbing and does not edit `ci.yml`.
- **Tab-bar entry** — title-detail is a **pushed** route, not a tab (decision 7 /
  spec 0010 decision 2). No `tabs.page` tab button is added.

## Affected slices & Sheriff tags

| Project             | Path                       | Sheriff tags                         | Change                                                                                                              |
| ------------------- | -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| mobile-title-detail | `libs/mobile/title-detail` | `scope:mobile`, `slice:title-detail` | **NEW** lib: `TitleDetailPage` + `TitleDetailService` + `TmdbDetailClient` + config token; README; tests            |
| mobile-search       | `libs/mobile/search`       | `scope:mobile`, `slice:search`       | **minimal** edit: tap a result **card** → navigate to `tabs/title-detail/:titleId` (Add control behavior preserved) |
| mobile (app)        | `apps/mobile`              | `scope:mobile`                       | register the lazy `tabs/title-detail/:titleId` route; provide `TMDB_DETAIL_CONFIG` at root from `environment.tmdb`  |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (spec 0010): the existing
  config declares `'libs/mobile/<slice>': ['scope:mobile', 'slice:<slice>']`, so a
  newly-generated `libs/mobile/title-detail/src` **inherits** `scope:mobile` +
  `slice:title-detail` automatically **provided** `slice:title-detail` is in the
  slice-tag vocabulary. PLAN §3 already lists `slice:title-detail` as a declared
  tag. **Verify-then-edit `sheriff.config.ts` once**: confirm the glob covers the
  new lib and the vocabulary lists `slice:title-detail`; **edit only if a gap
  exists** (e.g. the vocabulary list omits it), and record "no `sheriff.config.ts`
  change needed" in the PR if the verification passes. Generated `project.json`
  keeps `tags: []` (correct — tagging is by glob). **Per project memory, the glob
  targets `libs/**/src`(the barrel module), not the lib root — confirm the new
lib's`src` is matched so runtime barrel imports resolve.\*\*
- **Import boundaries (verified against the spec-0010 Sheriff rules 1–4):**
  - `libs/mobile/title-detail` (`slice:title-detail`) is governed by
    `'slice:*': ['scope:shared', sameTag]` — it may import **only** `scope:shared`
    and other `slice:title-detail` modules. It imports `@vultus/shared/domain`
    (`WatchlistItem`, `WatchStatus`, `TitleType`, `Region`, `WatchProvider`,
    `RegionAvailability`, `TitleCacheEntry`, `TitleMetadata`, `AUTH_UID`) and
    `@vultus/shared/firestore-schema` (`titleCacheDocPath`, `availabilityDocPath`,
    `dataToTitleCache`, `dataToAvailability`, `userPath`, `dataToUser`,
    `watchlistItemPath`, `watchlistItemToData`, `dataToWatchlistItem`) — **both
    `scope:shared`, allowed (rule 4)**. It imports **no other slice** (not
    `slice:search`, not `slice:watchlist`, not `slice:settings`) and **not**
    `libs/functions/sync-titles` (that is `scope:functions` — a double violation).
    Its own `TmdbDetailClient` exists precisely to avoid the `scope:functions`
    import (decision 2).
  - The slice injects AngularFire `Firestore` and the `AUTH_UID` token.
    **AngularFire (`@angular/fire`), `firebase`, `@ionic/*`, `ionicons`, the global
    `fetch` are third-party** — not policed by Sheriff. **It must NOT import
    `ShellAuthService` from `apps/mobile`** (even type-only — a forbidden
    `slice:title-detail → scope:mobile` edge). It obtains the uid via the
    **`AUTH_UID`** token, and the TMDB config via the slice-exported
    **`TMDB_DETAIL_CONFIG`** token (the shell's root provider imports the slice
    barrel — `apps/mobile` importing a slice it owns is **rule 3, allowed**).
  - **The search-slice edit stays within `slice:search`'s allowances** — it adds a
    `router.navigate(...)` (`@angular/router` is third-party) and changes no
    imports that would create a new Sheriff edge. It must **not** import
    `slice:title-detail` (no cross-slice import — the navigation is a string route,
    not a symbol import).
  - **No `scope:functions` file is touched.**
- **No `shared/` extraction.** The TMDB detail client, the cache-or-live
  resolution, the provider grouping, and the add/status/remove writes all live
  **inside** `libs/mobile/title-detail` — one consumer, far short of the
  3+-slice rule (CLAUDE.md / PLAN §3). Only the **types** and the
  **path/converter** helpers are shared, and those **already exist**; this spec
  adds **no** new shared surface.

## Data model touchpoints

PLAN §4 paths. **No new field is added to any shared type** (the watchlist
denormalized fields `posterPath`/`voteAverage` were added by spec 0014, which is now
**merged** — they are **already present on main** in `WatchlistItem` and the
`watchlistItemToData`/`dataToWatchlistItem` converters, and this spec **consumes them
directly**). All `title-cache` access is **read-only**.

| PLAN §4 path                                  | Access by this slice                                            | Fields / note                                                                    |
| --------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `title-cache/{tmdbId}` (doc)                  | **read** (cache-first metadata)                                 | `type`, `metadata` (`title`, `overview`, `posterPath`, `releaseDate`), `traktId` |
| `title-cache/{tmdbId}/availability/{region}`  | **read** (cache-first providers)                                | `providers: WatchProvider[]` — grouped by `type` for the providers section       |
| `users/{uid}` (doc)                           | **read**                                                        | `region: Region` (settings slice owns the write — spec 0011)                     |
| `users/{uid}/watchlist/{titleId}`             | **read (realtime)**, **create**, **update(status)**, **delete** | tracked state subscription; add (`status:'planned'`); change status; remove      |
| `users/{uid}/watchlist/{titleId}/episodes/**` | **none**                                                        | **OUT OF SCOPE** (decision 6) — not read, not written                            |
| `title-cache/**` (write)                      | **none**                                                        | functions-only (`write: if false`) — the live TMDB fallback is display-only      |

- **Cache-first read (decision 2).** Read `title-cache/{tmdbId}` via
  `titleCacheDocPath(tmdbId)` + `dataToTitleCache`. If the doc **exists**, render
  metadata from `TitleCacheEntry.metadata` and read providers from
  `availabilityDocPath(tmdbId, region)` via `dataToAvailability`. If the metadata
  doc is **absent** (cache miss — the common case), fall back to the **live TMDB
  client** (decision 2) for both metadata and providers. A cache hit on metadata
  but a missing/unsynced **availability** doc renders an **empty-providers** state
  (not an error) — same graceful treatment as 0014 decision 5.
- **Live TMDB fallback (decision 2).** The slice-local `TmdbDetailClient` calls
  `/movie/{id}` or `/tv/{id}` (driven by which endpoint resolves, or by a watchlist
  `type` hint when tracked) plus `/movie|tv/{id}/watch/providers` filtered to the
  user's region, mapping to the same `TitleDetail` view model the cache path
  produces. **It never writes `title-cache`** — the fetched data is held in the
  service's signal for the page render only.
- **Region resolution (decision 2).** Read `users/{uid}.region` via `userPath(uid)`
  - `dataToUser`. A **null/unset** region (user doc absent, or read before
    settings has been visited) → the providers section is **omitted** and replaced
    by a "Set your region in Settings to see availability" prompt; the rest of the
    page still renders.
- **Add write (decision 4).** Build a `WatchlistItem`
  `{ type, tmdbId, traktId: null, title, addedAt: <now ISO>, status: 'planned',
posterPath, voteAverage }`, pass it through `watchlistItemToData(item)` (the
  merged-0014 converter already coerces the two denormalized fields via `?? null` and
  `addedAt` → Date), and `setDoc` it at `watchlistItemPath(uid, String(tmdbId))`.
  **Use the shared converter — do not hand-roll the wire mapping.**
  `posterPath`/`voteAverage` come from the resolved `TitleDetail` (cache or live);
  when unknown, pass `null` (the fields are optional + nullable, present on main). The
  doc id is `String(tmdbId)`, matching 0013/0014 (the natural duplicate guard).
- **Change status / remove (decision 4).** `updateDoc` `{ status }` at
  `watchlistItemPath(uid, String(tmdbId))`; `deleteDoc` at the same path. Mirrors
  0014's `updateStatus` / `removeTitle`.
- **No `firestore.rules` change — VERIFY and RECORD.** The merged rules already
  grant: (a) **owner-only read/write** on `users/{userId}` and **every**
  subcollection (`users/{userId}/{document=**}`) — covers the realtime watchlist
  read, the add/update/delete, and the `users/{uid}` region read; (b)
  **authenticated read (incl. anonymous)** on `title-cache/{tmdbId}` **and** its
  `availability/{region}` subcollection, with **`write: if false`** — covers the
  cache-first metadata + availability reads and confirms the client cannot write
  the cache. The implementer must **verify these blocks are present** (they are —
  `firestore.rules` lines 25–31 and 46–54) and **record "no `firestore.rules`
  change needed"** in the PR. Do **NOT** edit `firestore.rules`.
- **No `firestore.indexes.json` change** — the only Firestore reads are
  single-document gets and one single-document realtime subscription
  (`watchlistItemPath`); no compound `where`/`orderBy` query. **Do NOT edit it.**

## Public types / APIs

All new public surface is exported (as needed) from the slice barrel
`libs/mobile/title-detail/src/index.ts`. **No HTTP endpoint, no callable, no new
shared domain type** — `WatchlistItem`, `WatchStatus`, `WATCH_STATUSES`,
`TitleType`, `Region`, `WatchProvider`, `RegionAvailability`, `TitleCacheEntry`,
`TitleMetadata`, `AUTH_UID` already exist in `@vultus/shared/domain`;
`titleCacheDocPath`, `availabilityDocPath`, `userPath`, `watchlistItemPath`,
`watchlistItemToData`, `dataToWatchlistItem`, `dataToTitleCache`,
`dataToAvailability`, `dataToUser` already exist in
`@vultus/shared/firestore-schema`. **Reuse them — do not duplicate.**

### Slice-local TMDB detail types + client (`src/lib/tmdb-detail.client.ts`)

```ts
import type { TitleType, WatchProvider } from '@vultus/shared/domain';

/** The resolved detail view model the page renders — produced by EITHER the
 *  title-cache read OR the live TMDB fallback (decision 2), so both paths share
 *  one shape. */
export interface TitleDetail {
  tmdbId: number;
  type: TitleType; // 'movie' | 'tv'
  title: string;
  year: number | null; // from release_date (movie) / first_air_date (tv)
  overview: string;
  posterUrl: string | null; // full image URL or null
  posterPath: string | null; // raw TMDB poster path (for the watchlist denormalized field)
  voteAverage: number | null; // TMDB 0–10 vote average (for the watchlist denormalized field), null if unknown
}

/** Providers for one region, grouped by type (decision 5). Each WatchProvider
 *  is rendered as a TEXT chip (provider.name) — there is no logo field. */
export interface GroupedProviders {
  flatrate: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
}

/** Injected config — base URLs + auth. NEVER read from a secret by the client.
 *  Same shape as the search slice's TmdbSearchConfig (deliberate per-slice
 *  duplication — decision 2). */
export interface TmdbDetailConfig {
  apiBaseUrl: string; // e.g. https://api.themoviedb.org/3
  imageBaseUrl: string; // e.g. https://image.tmdb.org/t/p/w185
  auth: { kind: 'bearer'; token: string } | { kind: 'apiKey'; apiKey: string };
  fetchImpl?: typeof fetch; // mock/dev override; prod uses global fetch
}

export interface TmdbDetailClient {
  /** GET /movie/{id} or /tv/{id}; maps to TitleDetail. `typeHint` (from the
   *  watchlist doc when tracked) picks the endpoint; absent → try movie then tv,
   *  or use TMDB's media_type. Throws a typed error on non-2xx so the service can
   *  surface a not-found/error view-state. */
  getDetail(
    tmdbId: number,
    typeHint?: TitleType,
    signal?: AbortSignal,
  ): Promise<TitleDetail>;

  /** GET /{type}/{id}/watch/providers; returns the providers for `region`
   *  grouped by type, or empty groups when the region is absent in the response. */
  getProviders(
    tmdbId: number,
    type: TitleType,
    region: Region,
    signal?: AbortSignal,
  ): Promise<GroupedProviders>;
}

export function createTmdbDetailClient(
  config: TmdbDetailConfig,
  fetchImpl?: typeof fetch,
): TmdbDetailClient;
```

- The client is **framework-light** (no Angular decorator) so it is unit-testable
  with a fake `fetch`. **It performs NO Firestore access** and **never writes
  `title-cache`** (decision 2).
- **TMDB watch/providers mapping note:** TMDB returns providers under
  `results[region].{flatrate,rent,buy}` with each entry carrying
  `provider_id`/`provider_name`. Map to `WatchProvider`
  `{ providerId: provider_id, name: provider_name, type }` — **dropping the logo
  field** to match the domain shape (decision 5). A region key absent from
  `results` → empty groups (empty-providers state).
- **Config token (exported from the barrel):**
  ```ts
  import { InjectionToken } from '@angular/core';
  /** Provided at root by apps/mobile from environment.tmdb (same value the
   *  search slice's TMDB_SEARCH_CONFIG receives). */
  export const TMDB_DETAIL_CONFIG = new InjectionToken<TmdbDetailConfig>(
    'TMDB_DETAIL_CONFIG',
  );
  ```
  The two TMDB config tokens (`TMDB_SEARCH_CONFIG`, `TMDB_DETAIL_CONFIG`) read the
  **same `environment.tmdb` value** — keeping them as separate tokens preserves
  slice isolation (neither slice imports the other's token) at the cost of one
  extra one-line provider; this is the correct vertical-slice trade.

### Detail service (`src/lib/title-detail.service.ts`)

```ts
@Injectable() // page-scoped (provided in the page's `providers`) OR providedIn:'root'
export class TitleDetailService {
  /** Resolve the detail view model for a tmdbId: title-cache first, live TMDB on
   *  miss (decision 2). Emits a discriminated view-state. */
  detail$(tmdbId: number): Observable<DetailViewState>;

  /** The user's region from users/{uid}.region (null until resolved / uid null). */
  region$(): Observable<Region | null>;

  /** Realtime tracked state: the watchlist doc for {uid}/{titleId}, or null when
   *  untracked / uid null (decision 4). */
  tracked$(tmdbId: number): Observable<WatchlistItem | null>;

  /** Create users/{uid}/watchlist/{titleId} as 'planned' with the denormalized
   *  posterPath + voteAverage from `detail` (decision 4). No-op when uid null. */
  add(detail: TitleDetail): Promise<void>;

  /** Update status at watchlistItemPath(uid, String(tmdbId)). No-op when uid null. */
  updateStatus(tmdbId: number, status: WatchStatus): Promise<void>;

  /** Delete watchlistItemPath(uid, String(tmdbId)). No-op when uid null. */
  removeTitle(tmdbId: number): Promise<void>;
}

/** The page's detail view-state (decision 2 + UI states). */
export type DetailViewState =
  | { kind: 'loading' }
  | { kind: 'loaded'; source: 'cache' | 'live'; detail: TitleDetail }
  | { kind: 'not-found' }; // both cache miss AND live TMDB 404/error
```

Method/signal names are a **recommendation**; what is **binding**: cache-first
resolution via `titleCacheDocPath` + `dataToTitleCache` (then `availabilityDocPath`

- `dataToAvailability` for providers), **live TMDB fallback on cache miss** via the
  slice-local client (decision 2), region read from `users/{uid}` via `userPath` +
  `dataToUser`, **realtime** tracked-state subscription on
  `watchlistItemPath(uid, String(tmdbId))` via `dataToWatchlistItem`, the add write
  via `watchlistItemToData` + `setDoc` (decision 4, with denormalized
  `posterPath`/`voteAverage`), `updateStatus`/`removeTitle` targeting the same path;
  a **null-uid guard** before any uid-keyed Firestore call (emit `null` / no-op,
  never throw on an undefined path); **never write `title-cache`**; **never read or
  write the `episodes` subcollection** (decision 6).

### Status display order (binding — mirror 0014)

```ts
const STATUS_DISPLAY_ORDER: WatchStatus[] = [
  'watching',
  'planned',
  'completed',
  'dropped',
];
```

The change-status control MUST iterate `STATUS_DISPLAY_ORDER` (Watching → Planned
→ Completed → Dropped), **NOT** `WATCH_STATUSES` (which is ordered
`['watching','completed','dropped','planned']` — the wrong display order). This is
the same slice-local array 0014 uses; **duplicating it here is correct** (each
slice owns its display order; not a shared extraction).

### Barrel surface

Export `TitleDetailPage` (the route's `loadComponent` target), `TMDB_DETAIL_CONFIG`,
and `TmdbDetailConfig` (the shell's root provider needs both to wire the token).
`TitleDetailService`, `TmdbDetailClient`, `TitleDetail`, `GroupedProviders`,
`DetailViewState` are exported **only if** a test or the page composition needs
them across the barrel; otherwise keep them slice-internal. Document whatever is
exported in the README.

### Shell wiring (`apps/mobile`)

- **Route (`app.routes.ts`).** Add a child of the `tabs` route (so the tab bar
  stays visible), lazy-loading the page:
  ```ts
  {
    path: 'title-detail/:titleId',
    loadComponent: () =>
      import('@vultus/mobile/title-detail').then((m) => m.TitleDetailPage),
  },
  ```
  placed alongside the existing `watchlist`/`search`/`settings` children, **before**
  the `{ path: '', redirectTo: 'watchlist', pathMatch: 'full' }` catch-all. (Both
  0014's existing navigation and 0013's new card-tap navigation target
  `['tabs','title-detail', titleId]`, which resolves here.)
- **Config provider (`app.config.ts`).** Add
  `{ provide: TMDB_DETAIL_CONFIG, useValue: environment.tmdb }` (importing
  `TMDB_DETAIL_CONFIG` from `@vultus/mobile/title-detail` — rule 3, allowed),
  alongside the existing `TMDB_SEARCH_CONFIG` provider. Leave `AUTH_UID` + Firebase
  providers unchanged. **No `environment.ts` change** is required — the existing
  `environment.tmdb` block (spec 0013) already carries `apiBaseUrl`, `imageBaseUrl`,
  and `auth`, and is reused as-is.

### Search-slice edit (`libs/mobile/search`)

- In `search.page.html` make the result **card body** (the poster + text block,
  **not** the trailing Add control) tappable — bind a `(click)` to a new
  `openDetail(result)` handler. The existing `onAdd(result, $event)` already calls
  `event.stopPropagation()`, so tapping Add will **not** trigger navigation
  (preserving 0013's inline-add behavior — verify this guard is intact).
- In `search.page.ts` add
  `openDetail(result: SearchResultView): void { this.router.navigate(['tabs','title-detail', String(result.tmdbId)]); }`
  injecting `Router` from `@angular/router` (third-party — no Sheriff edge). Keep
  `onAdd`/`onSearch`/`retry`/`trackByTmdbId` unchanged. This is the **only** change
  to the search slice; it adds **no** import of `slice:title-detail` (navigation is
  a string route).

## UI / Stitch screen refs

This is a mobile slice — the visual contract is the Stitch screen
**"Movie Detail - Vultus"**, screen id
**`208cb8d7a679490b8d13672c6943d6d3`**
(full path `projects/13590348714018893783/screens/208cb8d7a679490b8d13672c6943d6d3`,
"Vultus Android App Design"). **This screen was fetched and pinned by the
orchestrator** — the concrete values below come from its Tailwind config + markup,
so the prior "Stitch screen unverified — BLOCKING" open item is **RESOLVED**. The
implementer **MUST still `get_screen` this exact id** (retry on MCP failure — the
Stitch MCP IS reachable here) to **visually verify** the built page against it and
**record the screen id in the PR**, but the visual contract is **no longer an
unknown** — it is pinned below.

> **NOTE — screen captured + pinned.** The "Movie Detail - Vultus" screen
> (`208cb8d7a679490b8d13672c6943d6d3`) was fetched by the orchestrator and its
> concrete tokens/dimensions/states are encoded below as the authoritative
> contract. The implementer re-fetches only to **eyeball-verify the rendered page**
> (render/screenshot or `--configuration=mock` serve), not to discover the spec. A
> green build alone does NOT prove fidelity (CLAUDE.md UI-fidelity rule).

The Stitch screen is **maximal** (it draws a full TMDB detail page); **our scope +
data model are deliberately narrower**. The four **reconciliations (A–D)** below
encode where we intentionally deviate from the mock so the implementer does **not**
blindly build it. Consume the `shared/ui-kit` CSS custom properties / Tailwind
tokens — **do not hard-code hex**; the hex values below are pinned only so the
implementer can confirm the token wiring matches the screen.

### Design tokens — element → role → CSS var (source of truth: `docs/design/vultus-design-system.md`)

**`docs/design/vultus-design-system.md` is the authoritative token set; consume the
wired `--vultus-*` / `--ion-*` CSS custom properties from `shared/ui-kit`
`theme.scss` — never hardcode a hex.** The mapping below pins each page element to
its design role and the var that carries it (hex values live only in the design doc

- theme.scss; do not re-transcribe them here).

| Page element                                | Design role                 | CSS var to consume                                                                  |
| ------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| page background                             | `surface`                   | `--vultus-surface` / `--ion-background-color`                                       |
| section headings, accents, icons            | `primary`                   | `--ion-color-primary` / `--vultus-primary`                                          |
| outlined status-control text + border       | `primary`                   | `--ion-color-primary` / `--vultus-primary`                                          |
| **filled Add CTA background**               | `primary`                   | `--ion-color-primary` (see FIX-1 deviation note below)                              |
| **filled Add CTA text/icon**                | `on-primary`                | `--ion-color-primary-contrast`                                                      |
| genre chip text/icon                        | `on-primary-container`      | `--vultus-on-primary-container`                                                     |
| title + primary text                        | `on-surface`                | `--vultus-on-surface` / `--ion-text-color`                                          |
| synopsis, meta row, provider-type labels    | `on-surface-variant`        | `--vultus-on-surface-variant`                                                       |
| back-button bg, low cards                   | `surface-container`         | `--vultus-surface-container`                                                        |
| raised chips / surfaces                     | `surface-container-high`    | `--vultus-surface-container-high`                                                   |
| secondary hero chip (quality — see recon D) | `surface-container-highest` | `--vultus-surface-container-highest`                                                |
| Level-1 cards / raised surfaces             | tonal ramp                  | `--vultus-surface-container` (L1) → `--vultus-surface-container-highest` (overlays) |
| dividers / scrolled app-bar border          | `outline-variant`           | `--vultus-outline-variant`                                                          |
| tracked status colors                       | semantic status             | `--vultus-status-watching` / `-completed` / `-dropped` / `-planned`                 |

> **Deliberate-deviation note (FIX 1):** the fetched Movie-Detail screen rendered the
> filled CTA with `primary-container` `#10B981`, but the in-repo design-system Button
> contract (`docs/design/vultus-design-system.md` → Components → Buttons: "Primary:
> Solid `primary` #4edea3 with `on-primary` #003824") and its theme.scss wiring
> (`--ion-color-primary: #4edea3`, contrast `#003824`) are higher authority, so the
> filled CTA uses **`primary` `#4edea3`** (`ion-button color="primary"`), not the
> screen's `primary-container`. `#10B981` survives on this page **only** as
> `--vultus-status-completed`.

- **Typography — Inter, and it MUST be LOADED as a web-font** (the weights
  `apps/mobile/src/index.html` loads, 400–700), not merely named in the family
  stack; **icons via Material Symbols Outlined** (Ionic's `ionicons` is an acceptable
  substitute — reconcile the glyph names, but the icon font must actually load).
  Confirm `shared/ui-kit` `theme.scss` + `index.html` load Inter; this page must
  render in Inter, not a system fallback. Type roles → vars (px parenthetical sourced
  from `docs/design/vultus-design-system.md`, not the contract):
  - display-lg-mobile → `--vultus-text-display-lg-mobile-size`/`-line` (28/36, 700) — the title in the hero
  - headline-sm → `--vultus-text-headline-sm-size`/`-weight`/`-line` (20/28/600) — section headings (in `primary`)
  - body-lg → `--vultus-text-body-lg-size`/`-weight`/`-line` (16/24/400) — the synopsis
  - body-md → `--vultus-text-body-md-size`/`-weight`/`-line` (14/20/400) — base text + provider name rows
  - label-md → `--vultus-text-label-md-size`/`-weight`/`-line`/`-spacing` (12/16/600, +0.05em), **uppercase** — chips / meta row
  - label-sm → `--vultus-text-label-sm-size`/`-weight`/`-line` (11/16/500) — cast role, fine print
- **Spacing scale (8px grid):** `--vultus-space-xs` `4`, `-sm` `8`, `-md`/gutter
  `16`, `-lg` `24`, `-xl` `32`; **mobile side margin `16px`**. **Radius:**
  `--vultus-radius-sm` `0.25rem`, `--vultus-radius` `0.5rem`, `--vultus-radius-md`
  `0.75rem` (`rounded-xl` — buttons + cards), `--vultus-radius-pill` `9999px`
  (chips, back button).

### Layout & components (Ionic, top → bottom — each row a checkable acceptance item)

1. **Top app bar (`IonHeader`/`IonToolbar`).** **Height 64px** (`h-16`),
   **back-button ONLY** — **no title, no tabs** (confirms a focused pushed
   sub-page; the tab bar **and any FAB are suppressed here**). Back control: a
   **40px circle** (`w-10 h-10`, `--vultus-radius-pill`), bg `surface-container`
   at 40% + `backdrop-blur-md`, `arrow_back` glyph, **hover** → `surface-container`
   (full opacity), **active → `scale-95`**. Use `IonBackButton`
   (`slot="start"`, `defaultHref="tabs/watchlist"`) — decision 7.
   - **Scroll micro-interaction:** transparent at the top; when `scrollY > 50px`
     the bar gains bg `surface` at 80% + `backdrop-blur-xl` + a bottom border
     (`outline-variant` at 20%). Pin this as a stated interactive behavior. **If
     Ionic's `ion-header collapse="condense"` / default toolbar is used instead of
     a custom scroll listener, that is an acceptable simplification — note it
     explicitly in the PR.**
2. **Hero / backdrop.** Full-width backdrop image, **height 530px** on mobile,
   `object-cover`, with a **bottom-up gradient overlay**
   `linear-gradient(to top, #0b1326 0%, rgba(11,19,38,0.8) 40%, rgba(11,19,38,0) 100%)`.
   **Placeholder** film glyph when no image (no broken image). A **floating title
   block** pinned to the bottom (side padding `16`, bottom padding `32`, internal
   gap `16`), top → bottom:
   - a **row of chips**: a **genre chip** (bg `primary-container`, text
     `on-primary-container`, **uppercase label-md**) rendering the **first genre IF
     present, else omitted** (recon D); and a **secondary chip** (bg
     `surface-container-highest`) which in the mock is "4K Ultra HD" — **DROP it or
     make it conditional: there is no backing quality field** (recon D).
   - the **title** — display-lg-mobile (28/36/700), `on-surface` `#dae2fd`.
   - a **meta row** (gap `24`, label-md, `on-surface-variant`): **star** glyph
     (filled, `primary`, 18px) + **vote average** (bold) · **calendar** glyph +
     **year** · **schedule** glyph + **runtime**. Render **each meta item only when
     its field is present** (recon C): `year` from `release_date`/`first_air_date`;
     `voteAverage` and `runtime` may be **absent on the cached path** — omit that
     item rather than show `0`/blank. The **always-present core** is the title +
     overview; rating/year/runtime/genre are best-effort.
3. **Primary actions — a row reconciled per recon A (NOT two static buttons).**
   The mock draws a **filled** "Add to Watchlist" (action A) **and** an **outlined**
   "Mark as Watched" (action B). **Action B is OUT OF SCOPE** (mark-watched is
   deferred to 0017, decision 6) and is **REPLACED by the slice's status control**
   (recon A). Both buttons are **height 56px** (`h-14`), **`rounded-xl`**
   (`0.75rem`):
   - **Filled button** = `ion-button color="primary"`: bg `--ion-color-primary`
     (`#4edea3`), text/icon `--ion-color-primary-contrast` (`#003824`), bold,
     `playlist_add` glyph, **hover → `opacity-90`**, **active → `scale-[0.98]`**.
     **The only filled CTA on the page** (see the FIX-1 deviation note above — the
     screen drew `primary-container`, but the design-system Button contract wins).
   - **Outlined button** = outlined-primary: `border-2` + text on
     `--ion-color-primary` (`--vultus-primary`), **hover → `bg primary/10`**, **active
     → `scale-[0.98]`**.
   - **Untracked** (`tracked$ === null`): show **only the filled** "Add to
     Watchlist" button → `add(detail)` (`status: 'planned'`).
   - **Tracked** (`tracked$ !== null`): the **outlined** button becomes the
     **status control**, surfacing the **current status** (label + status-colored
     accent) and opening the **status-change `IonActionSheet`** (the four statuses
     in slice-local `STATUS_DISPLAY_ORDER` — Watching → Planned → Completed →
     Dropped, mirroring 0014); plus a **Remove** affordance (`IonAlert` confirm →
     `removeTitle`, danger `status-dropped` `#EF4444`).
4. **Bento content — `glass-panel` cards.** Each card: a translucent glass surface
   (`backdrop-filter: blur(12px)`), **1px border**, **padding 24px** (`--vultus-space-lg`),
   **`rounded-xl`** (`--vultus-radius-md`); **hover lifts `translateY(-2px)`**.
   **The glass fill/border are screen-specific glass-effect values NOT in the token
   set** (the screen used `rgba(30,41,59,0.7)` fill / `rgba(51,65,85,0.5)` border) —
   **do NOT hardcode raw rgba in the slice.** Derive them from
   `--vultus-surface-dark` / `--vultus-outline-variant` with an alpha channel, or add
   a `--vultus-glass-bg` / `--vultus-glass-border` token to `shared/ui-kit` (ui-kit
   owner) and consume that. **Flag this explicitly in the PR.** Section headings:
   headline-sm (`--vultus-text-headline-sm-*`), text `--ion-color-primary`, with a
   leading Material/ionicon glyph.
   - **Synopsis** card — the `overview` paragraph, body-lg (16/24/400),
     `on-surface-variant`. **Always present** (core field).
   - **Cast** card (**conditional — recon C**): a **horizontal snap-scroll** of
     **96px round avatars**, each with a **name** (label-md bold) + **role**
     (label-sm) and a **"View All"** link. **Render the whole card ONLY when cast
     data is present** in the resolved `TitleDetail`; **omit the entire card when
     absent** (do not show placeholder avatars). Per recon C the **cached path will
     NOT carry cast** (the stored `TitleMetadata` has only title/overview/poster/
     releaseDate — verified), so this card appears **only on the live-TMDB path**
     and only if the implementer surfaces TMDB `credits.cast` on that path.
   - **Where to Watch** card (decision 5 + **recon B — TEXT ONLY**): a heading +
     **provider rows grouped by type** (Streaming/Rent/Buy ← `flatrate`/`rent`/
     `buy`). The mock draws a **colored logo square**, a "Subscription"/"Rent/Buy"
     subtitle, and an `open_in_new` deep-link icon — **our `WatchProvider` has no
     logo and no URL** (`{ providerId, name, type }`). So each row renders the
     provider **name** (body-md, bold/`on-surface`) + a **type label derived from
     `provider.type`** (`flatrate` → "Subscription"; `rent`/`buy` → "Rent"/"Buy",
     `on-surface-variant`). **OMIT the logo image** (a text-monogram tile is
     acceptable but not required) and **OMIT the `open_in_new` link/icon** (no URL
     to open). A group with no providers is **omitted**; when **all** groups are
     empty → the **empty-providers** state.
   - **Metadata** sub-block (**conditional per-row — recon C**): label↔value rows
     for **Director / Budget / Language**. **Render each row ONLY when its field is
     present**; **omit the row when absent** (no "—"/placeholder). As with Cast, the
     verified stored `TitleMetadata` does **NOT** carry director/budget/language, so
     these rows appear **only on the live-TMDB path** and only if the implementer
     surfaces them there. **Widening the stored `TitleMetadata` shape to persist
     cast/director/budget/language/runtime/genres is OUT OF SCOPE for this spec — it
     is a sync-engine concern** (do NOT modify `shared/domain` /
     `shared/firestore-schema`). Keep **Synopsis + the hero core meta** as the
     always-present contract; treat **Cast + extended Metadata as best-effort** and
     **runtime/voteAverage/genre as conditional** on the cache vs. live path.

### Reconciliations (A–D) — encoded above, summarized as binding deviations

- **A. "Mark as Watched" (Stitch outlined action B) → REPLACED by the status
  control.** Reason: episodes / mark-watched are deferred to **0017** (decision 6).
  Untracked shows only the filled Add CTA; tracked turns the outlined button into
  the current-status control (status-change `IonActionSheet` over
  `STATUS_DISPLAY_ORDER`) + a Remove affordance. **Intentional deviation from the
  mock.**
- **B. Provider rows = TEXT ONLY** (decision 5). Name + a type label derived from
  `provider.type`; **no logo image, no `open_in_new`/deep-link** (no logo/URL field
  on `WatchProvider`). Grouped by type; includes the **empty-providers** state.
  **Deliberate data-driven simplification.**
- \*\*C. Cast + extended Metadata (Director/Budget/Language) + runtime + voteAverage
  - genre are CONDITIONAL.** Render each **only when the field is present** in the
    resolved data; **omit the whole panel/row/item when absent** (no placeholders).
    **Verified:** the stored `TitleMetadata` is only
    `{ title, overview, posterPath, releaseDate }`, so the **cached path omits**
    cast/director/budget/language/runtime/genre/voteAverage; the **live-TMDB path
    MAY** surface them. **Widening the stored shape is OUT OF SCOPE\*\* (sync-engine
    concern). Synopsis + title + year are the always-present core.
- **D. Hero "quality" chip (mock "4K Ultra HD") has no backing field → DROP or make
  conditional.** The **genre chip** renders the **first genre if present, else
  omit**.

### View-states (each a checkable acceptance item)

- **loading skeleton** (`{ kind: 'loading' }`, before first emission **and** during
  the live-fetch transition): `ion-skeleton-text` placeholders for the hero, title,
  meta row, synopsis lines, and the provider area — **not** the empty/not-found copy.
- **loaded-from-cache** (`source: 'cache'`) and **cache-miss-live-fetched**
  (`source: 'live'`) render **identically** for any given `TitleDetail` (`source`
  is telemetry/test-only and **MUST NOT** change the visual — assert in the
  component test). Note the cache path will naturally show **fewer** panels (no
  cast/extended-metadata/runtime) per recon C — that difference is **data-driven**,
  not `source`-driven: with the **same** `TitleDetail` the DOM is identical.
- **not-found-or-TMDB-error** (`{ kind: 'not-found' }`, cache miss **and** live
  fetch 404/errors): a centred muted icon + "Title not found" copy + a back
  affordance. No hero, no action area.
- **empty-providers** (loaded, region resolved, but no availability doc / empty
  providers array for the region): the Where-to-Watch card shows a muted "Not
  available to stream in your region" line instead of rows — **not** an error.
- **null-region** (`region$ === null`): the Where-to-Watch card is replaced by a
  muted "Set your region in Settings to see availability" prompt; the rest of the
  page (hero/title/synopsis/action area) still renders.

### Interactive-state contract (per element — verify each against the fetched screen; tick off in review)

| Element                                | default                                                                                                                                                                              | focus                               | hover                                  | active/pressed                              | disabled                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| **Add to Watchlist** (filled)          | `ion-button color="primary"`: bg `--ion-color-primary`, text `--ion-color-primary-contrast`, bold, h-14, `rounded-xl`, `playlist_add`                                                | Ionic default `:focus-visible` ring | `opacity-90`                           | **`scale-[0.98]`**                          | n/a while untracked (becomes status control) |
| **Status control** (outlined, tracked) | outlined-primary: `border-2` + text on `--ion-color-primary`, status-colored accent for current status, h-14, `rounded-xl`                                                           | Ionic default `:focus-visible` ring | `bg primary/10`                        | **`scale-[0.98]`** → opens `IonActionSheet` | n/a                                          |
| **Action-sheet status rows**           | one row per status in `STATUS_DISPLAY_ORDER`, status-color accent (`--vultus-status-*`)                                                                                              | row focus highlight                 | row hover highlight                    | selection → `updateStatus`                  | current status row marked selected           |
| **Remove** affordance                  | danger `--vultus-status-dropped` text/icon                                                                                                                                           | Ionic default `:focus-visible` ring | brightness shift                       | opens `IonAlert` → `removeTitle`            | n/a                                          |
| **Back button**                        | 40px circle, bg `--vultus-surface-container`/40 + `backdrop-blur-md`, `arrow_back`                                                                                                   | Ionic default `:focus-visible` ring | `bg --vultus-surface-container` (full) | **`active:scale-95`** → navigates back      | —                                            |
| **Glass-panel card**                   | glass fill + `blur(12px)`, 1px border (derived from `--vultus-surface-dark`/`--vultus-outline-variant` with alpha, or a `--vultus-glass-*` token — NOT raw rgba), p-24, `rounded-xl` | —                                   | **`translateY(-2px)`** lift            | —                                           | —                                            |
| **Cast avatar (snap-scroll)**          | 96px round, name label-md / role label-sm                                                                                                                                            | focus ring on "View All"            | —                                      | "View All" → (future)                       | — (whole card omitted if no cast — recon C)  |

- **Top app-bar scroll behavior:** transparent at top → at `scrollY > 50px`, bg
  `surface`/80% + `backdrop-blur-xl` + `outline-variant`/20% bottom border (or the
  Ionic `ion-header` collapse equivalent — note the simplification if used).
- **Animations/transitions:** page push/back uses Ionic's default route transition;
  the loading→loaded swap must **not flash** (gate on first emission); button
  `scale-[0.98]` / `scale-95` press feedback and the card `translateY(-2px)` hover
  lift match the screen unless Ionic defaults override.
- **Token wiring (easy to miss):** `docs/design/vultus-design-system.md` is the
  authoritative token source — consume the wired `--vultus-*` / `--ion-*` CSS custom
  properties from `shared/ui-kit` `theme.scss`; **never hardcode a hex.** **Inter
  must be LOADED as a web-font** (the weights `apps/mobile/src/index.html` loads,
  400–700), not merely named — confirm `shared/ui-kit` `theme.scss` + `index.html`
  load it and the page renders in Inter, not a system fallback; **icon font must
  load** too. On the **two emeralds** (now resolved per FIX 1): the filled CTA + all
  accents/headings/outline use `--ion-color-primary` (`#4edea3`); `#10B981`
  (`primary-container`) is **not** used as a fill here — it survives only as
  `--vultus-status-completed`. Use the `--vultus-status-*` tokens for status colors.
  For focus, rely on Ionic's default `:focus-visible` focus ring (theme.scss has no
  `--vultus-focus*` token; ui-kit owns adding a `--vultus-focus-*` token if a custom
  ring is wanted — not invented inline in this slice).

## Implementation task graph

The new lib must **exist and be tagged/routed** before its internals or the
search edit are meaningful. Task 1 (lib generation + Sheriff verify-then-edit +
**root route registration** + config provider) is the **[sequential]**
prerequisite. Once it lands, the slice internals (tasks 2–3) are **[sequential]**
relative to each other (they share `src/index.ts` + the page composition), and the
**search-slice edit** (task 4) is **[parallel]** — its manifest
(`libs/mobile/search/**`) is disjoint from the new-lib files and from task 1's
`apps/mobile` files. Tests (task 5) depend on 2–3.

> **Manifest disjointness assertion (for the orchestrator):** the only **parallel**
> task is task 4 (`libs/mobile/search/**`). Task 1's app-routing/config edit
> (`apps/mobile/src/app/app.routes.ts`, `apps/mobile/src/app/app.config.ts`) and
> the new-lib tasks (`libs/mobile/title-detail/**`) are **sequential** and own
> disjoint paths. Task 4's manifest is **pairwise disjoint** from task 1's
> `apps/mobile` files and from `libs/mobile/title-detail/**`. No two tasks write the
> same file.

1. **[sequential] Generate the `title-detail` lib + Sheriff verify-then-edit +
   register the lazy route + provide the config token.** (frontend-engineer +
   infrastructure-engineer territory — root/config touchpoints; everything depends
   on it.)
   - Generate `libs/mobile/title-detail` with the repo's Angular library generator
     (`@nx/angular:library`, Vitest unit runner per `nx.json` defaults), producing
     `project.json` (`tags: []` — correct), `tsconfig.*`, `vite.config.mts`,
     `eslint.config.mjs`, the barrel `src/index.ts`, and the
     `@vultus/mobile/title-detail` path alias in `tsconfig.base.json`. **Delete the
     generator's default scaffold component + its `*.spec.ts`** so tasks 2–3 start
     from a clean slate.
   - **Verify-then-edit `sheriff.config.ts` once:** confirm the
     `'libs/mobile/<slice>/src'` glob covers `libs/mobile/title-detail/src` and the
     slice-tag vocabulary lists `slice:title-detail`; edit only if a gap exists
     (record "no change needed" if not). **Confirm the glob targets `…/src`** (the
     barrel module — project memory).
   - **Register the route** in `apps/mobile/src/app/app.routes.ts`: add the
     `title-detail/:titleId` child of `tabs` (Public types → Shell wiring),
     **before** the `redirectTo: 'watchlist'` catch-all.
   - **Provide the config token** in `apps/mobile/src/app/app.config.ts`:
     `{ provide: TMDB_DETAIL_CONFIG, useValue: environment.tmdb }` (import from
     `@vultus/mobile/title-detail`). Leave `AUTH_UID`, Firebase, and
     `TMDB_SEARCH_CONFIG` providers unchanged. **No `environment.ts` edit** (reuse
     `environment.tmdb`).
   - Files: `tsconfig.base.json`, `sheriff.config.ts` (only if a gap),
     `apps/mobile/src/app/app.routes.ts`, `apps/mobile/src/app/app.config.ts`, and
     the **generator-scaffolded** project files for `libs/mobile/title-detail/**`
     (`project.json` / `tsconfig` / `vite.config` / `eslint.config` / barrel). The
     page/service/client/README/tests are written in tasks 2–3, 5.

2. **[sequential] Slice-local TMDB detail client + config token + service.
   Depends on task 1.** frontend-engineer.
   - `src/lib/tmdb-detail.client.ts`: `TitleDetail`, `GroupedProviders`,
     `TmdbDetailConfig`, `TmdbDetailClient`, `createTmdbDetailClient(...)` —
     `/movie/{id}` + `/tv/{id}` detail mapping, `/watch/providers` → region-grouped
     `WatchProvider[]` (drop logos), year extraction, poster URL build, typed
     non-2xx error. Injected `fetch` for tests; **no Firebase, never writes
     `title-cache`**.
   - `TMDB_DETAIL_CONFIG` `InjectionToken` (same file or `src/lib/tokens.ts`).
   - `src/lib/title-detail.service.ts`: inject `TMDB_DETAIL_CONFIG`, `AUTH_UID`,
     AngularFire `Firestore`. Implement cache-first `detail$` with live-TMDB
     fallback (decision 2), `region$`, realtime `tracked$`, and
     `add`/`updateStatus`/`removeTitle` (decision 4 via the shared converters +
     paths; null-uid guard; `STATUS_DISPLAY_ORDER`). Export the necessary symbols
     from `src/index.ts` (at least `TitleDetailPage` later, `TMDB_DETAIL_CONFIG`,
     `TmdbDetailConfig`).
   - Files: `libs/mobile/title-detail/src/lib/tmdb-detail.client.ts`,
     `libs/mobile/title-detail/src/lib/tokens.ts` (optional),
     `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
     `libs/mobile/title-detail/src/index.ts`.

3. **[sequential] Real `TitleDetailPage` (template + styles) + README. Depends on
   task 2.** frontend-engineer.
   - The page (UI section): back button, hero/poster/title/year/type badge,
     overview, providers-by-type text chips, the watchlist action area
     (untracked → Add; tracked → status indicator + change-status `IonActionSheet`
     - remove `IonAlert`), and all view-states (loading skeleton / loaded
       cache==live / not-found / empty-providers / null-region). Wire to
       `TitleDetailService`; read `:titleId` from the route
       (`ActivatedRoute`/`input`), parse to a number, resolve uid via `AUTH_UID`.
       Expose the change-status trigger as a **public method**
       (e.g. `openStatusSheet()`) bound from the template — **not** an inline
       anonymous handler — so the component test invokes it deterministically.
       Consume the `--vultus-*` / `--ion-*` vars from `shared/ui-kit` `theme.scss`
       (authoritative source: `docs/design/vultus-design-system.md`; no hard-coded hex).
       The filled Add CTA uses `--ion-color-primary` (`#4edea3`) per the FIX-1 deviation
       note — `#10B981` (`primary-container`) is **not** a fill here, it survives only as
       `--vultus-status-completed`. **Re-fetch the Stitch screen `208cb8d7a679490b8d13672c6943d6d3`
       to visually verify** the built page against the pinned UI contract (the screen
       is already captured + reconciled in the UI section — recon A–D apply); the
       filled CTA, the tracked status control (NOT a "Mark as Watched" button), the
       text-only provider rows, and the conditional Cast/Metadata panels must match
       the encoded contract.
   - Rewrite the generated `README.md` to the real public surface: what the lib is
     (the pushed per-title detail page), barrel exports (`TitleDetailPage`,
     `TMDB_DETAIL_CONFIG`, `TmdbDetailConfig`), a usage note (lazy-routed at
     `tabs/title-detail/:titleId`; reads `title-cache/*` + `users/{uid}.region` +
     `users/{uid}/watchlist/{titleId}` via the shared converters, owns a
     **slice-local TMDB detail client** by design and **slice-local watchlist
     write helpers** — neither is shared), the `TMDB_DETAIL_CONFIG`/`AUTH_UID` DI
     contract, and Sheriff tags `scope:mobile` + `slice:title-detail`. **No Nx
     scaffold text.**
   - Files: `libs/mobile/title-detail/src/lib/title-detail.page.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.html`,
     `libs/mobile/title-detail/src/lib/title-detail.page.scss`,
     `libs/mobile/title-detail/src/index.ts` (export `TitleDetailPage`),
     `libs/mobile/title-detail/README.md`.

4. **[parallel] Search-slice card-tap navigation (`slice:search`). Depends on
   task 1** (the route must exist for navigation to land — but the edit writes only
   `libs/mobile/search` files, disjoint from tasks 1–3). frontend-engineer.
   - `search.page.ts`: inject `Router`; add
     `openDetail(result): router.navigate(['tabs','title-detail', String(result.tmdbId)])`.
   - `search.page.html`: bind a `(click)="openDetail(result)"` on the card **body**
     (poster + text block), **not** the Add control; confirm `onAdd`'s
     `event.stopPropagation()` keeps the inline-add behavior (0013) intact.
   - `search.page.spec.ts`: extend the existing component test — tapping the card
     body navigates with `['tabs','title-detail', String(tmdbId)]`; tapping Add does
     **not** navigate (still calls `add`).
   - **Manifest (disjoint from tasks 1–3, 5):**
     `libs/mobile/search/src/lib/search.page.ts`,
     `libs/mobile/search/src/lib/search.page.html`,
     `libs/mobile/search/src/lib/search.page.spec.ts`.

5. **[sequential] Tests (`slice:title-detail`). Depends on tasks 2–3.**
   frontend-engineer / qa-runner.
   - Client unit + service unit + page component tests (Test plan). All Firebase +
     TMDB HTTP mocked.
   - Files: `libs/mobile/title-detail/src/lib/tmdb-detail.client.spec.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`.

(All slice internals live under `libs/mobile/title-detail/**`; task 1's
`apps/mobile` route/config edit and `tsconfig.base.json`/`sheriff.config.ts` are
root files; task 4 is the only `libs/mobile/search` edit. **No `firestore.rules`,
`firestore.indexes.json`, `libs/functions/**`, `ci.yml`, `playwright.config.ts`, or
any `scope:functions` file is touched.** The page/service/client/symbol/file names
above are recommendations; the binding contracts are the cache-first-then-live
resolution, the realtime tracked state, the add/status/remove via the shared
converters, the new route + token, and the no-`title-cache`-write / no-episodes /
no-cross-slice / no-`scope:functions` guardrails.)

## Test plan

Per the PLAN §5 pyramid — a slice with real logic, so **unit** tests (the client +
the service) and a **component** test (the page across its non-trivial states).
**No emulator-backed e2e** (decision 8). All TMDB HTTP and all Firebase access is
**mocked** (no live Firebase, no network, no secrets). The green gate is **unit +
component + build** (what `ci.yml` runs: `lint test build`).

**Unit — TMDB detail client (`tmdb-detail.client.spec.ts`, Vitest, fake `fetch`):**

- **Movie detail mapping:** a fake `fetch` returning a `/movie/{id}` payload →
  `getDetail(id, 'movie')` yields a `TitleDetail` with `type:'movie'`, `title` from
  `title`, `year` from `release_date`, `overview`, `posterUrl` =
  `imageBaseUrl + poster_path` (or hero size), `posterPath` raw, `voteAverage` from
  `vote_average`.
- **TV detail mapping:** a `/tv/{id}` payload → `type:'tv'`, `title` from `name`,
  `year` from `first_air_date`.
- **Null poster / null date:** missing `poster_path` → `posterUrl`/`posterPath`
  null; blank date → `year: null` (no `NaN`); missing `vote_average` →
  `voteAverage: null`.
- **Providers mapping + grouping (decision 5):** a `/watch/providers` payload with
  `results[region].{flatrate,rent,buy}` → `GroupedProviders` mapping
  `provider_id`/`provider_name` to `WatchProvider` (**logo dropped**); a **region
  absent** from `results` → all-empty groups (empty-providers).
- **Request shape:** the URL hits the correct endpoint, carries the auth (bearer
  header **or** `api_key` param per `auth.kind`), and uses the **injected** `fetch`.
- **Error handling:** a non-2xx (or `fetch` reject) on `getDetail` surfaces a typed
  error (→ the service's `not-found`), not an unhandled rejection. **The client
  performs NO Firestore call and NEVER writes `title-cache`** (assert no write API
  is invoked — trivially, the client has no Firestore dependency).

**Unit — detail service (`title-detail.service.spec.ts`, Vitest, fake client +
mocked AngularFire `Firestore` + mocked `AUTH_UID` signal):**

- **Cache hit:** with the `title-cache/{tmdbId}` doc present (mocked), `detail$`
  emits `{ kind:'loaded', source:'cache', detail }` mapped via `dataToTitleCache`,
  and the **live client is NOT called**; providers come from the mocked
  `availability/{region}` doc via `dataToAvailability`.
- **Cache miss → live fallback (movie + tv):** with the cache doc **absent**,
  `detail$` calls the **live** `TmdbDetailClient.getDetail`
  (`source:'live'`) for both a movie and a tv id; **no `title-cache` write occurs**
  (assert no `setDoc`/`updateDoc` targets `title-cache`).
- **not-found:** cache miss **and** the live client throws/404s → `{ kind:'not-found' }`.
- **Region resolution incl. null:** `region$` emits the `users/{uid}.region` via
  `dataToUser`; when the user doc is absent or uid is null → emits `null` (drives
  the null-region UI); providers are not fetched for a null region.
- **Tracked-state subscription (decision 4):** `tracked$` emits the mapped
  `WatchlistItem` when `users/{uid}/watchlist/{titleId}` exists and **`null`** when
  absent; a just-`add`ed doc flips it to non-null (realtime).
- **add() write shape (decision 4):** `add(detail)` writes to
  `watchlistItemPath(uid, String(detail.tmdbId))` a payload equal to
  `watchlistItemToData({ type, tmdbId, traktId:null, title, addedAt, status:'planned',
posterPath, voteAverage })` — assert `status==='planned'`, `traktId===null`, id =
  stringified tmdbId, and the **denormalized `posterPath`/`voteAverage`** are carried
  from `detail`.
- **updateStatus / removeTitle:** `updateStatus(tmdbId, status)` updates `{ status }`
  at `watchlistItemPath`; `removeTitle(tmdbId)` deletes that path.
- **Null-uid guard:** with `AUTH_UID` `null`, `region$`/`tracked$` emit `null`,
  `add`/`updateStatus`/`removeTitle` are **no-ops** (no Firestore call, no throw on
  an undefined path); `detail$` (which needs no uid) **still resolves** (cache or
  live).
- **No write outside the watchlist doc:** every mocked write targets
  `watchlistItemPath(uid, …)` — **never `title-cache`, never `users/{uid}`, never
  the `episodes` subcollection, never another slice's data.**

**Component (`title-detail.page.spec.ts`, Angular TestBed + Ionic test setup;
`TitleDetailService` mocked; `ActivatedRoute` providing a `:titleId`):**

- **Loading skeleton:** before the first `detail$` emission, `ion-skeleton-text`
  placeholders render and the not-found/empty copy is **not** shown.
- **Loaded movie / loaded tv:** the page renders poster (placeholder when null),
  title, year, the correct type badge (`Movie` / `TV Series`), and the overview.
- **cache == live render parity:** `source:'cache'` and `source:'live'` with the
  **same `TitleDetail`** render an **identical** DOM (assert `source` itself does not
  change the visual). Any panel difference between the two paths is **data-driven**
  (the cache path carries no cast/extended-metadata/runtime per recon C), not
  `source`-driven — assert this by feeding **identical** `TitleDetail` values.
- **not-found / error:** `{ kind:'not-found' }` shows the "Title not found" state
  and no action area.
- **Provider grouping (decision 5):** given grouped providers, the page renders the
  Streaming/Rent/Buy groups as **text chips** (`provider.name`), omits empty groups,
  and shows the **empty-providers** copy when all groups are empty.
- **null-region:** `region$` null → the "Set your region in Settings" prompt
  replaces the providers section; the rest of the page still renders.
- **Action area — untracked → Add:** `tracked$` null renders the Emerald **Add**
  button; tapping it calls the mocked `add` with the resolved `TitleDetail`.
- **Action area — tracked → status + remove:** `tracked$` non-null renders the
  status indicator (status-colored), the change-status control, and the remove
  control. Invoking the public `openStatusSheet()` opens the `IonActionSheet`
  (statuses in `STATUS_DISPLAY_ORDER`); selecting one calls `updateStatus`. Tapping
  remove opens the `IonAlert`; confirming calls `removeTitle`.

**e2e:** **descoped to PLAN §6 item 20** (decision 8). No new Playwright spec; no
change to `apps/mobile-e2e`, `playwright.config.ts`, or `ci.yml`. The full
emulator-backed open-detail / add / change-status / remove flow is owned by the
e2e-setup spec.

## Definition of done

Tailored from the PLAN §5 checklist to the projects touched. This spec's green
gate is **unit + component + build** (what `ci.yml` runs: `lint test build`);
emulator-backed e2e is descoped to PLAN §6 item 20 (decision 8). Expected Nx
targets: `mobile-title-detail` and `mobile-search` have `lint`/`test`/`typecheck`
(no `build` — non-app libs); `mobile` has `lint`/`test`/`build`/`typecheck`.

- [ ] `pnpm nx run-many -t lint test -p mobile-title-detail mobile-search` passes
      **with Sheriff active** (lint includes Sheriff): the title-detail slice
      imports `@vultus/shared/domain`, `@vultus/shared/firestore-schema`,
      AngularFire/Ionic/`@angular/router`/`fetch` (third-party), and the uid + TMDB
      config **only** via the `AUTH_UID` / `TMDB_DETAIL_CONFIG` tokens — **no other
      slice import, no `apps/mobile` deep import (no `ShellAuthService`), no
      `libs/functions/sync-titles` / `scope:functions` import**. The search edit
      adds only a `Router` navigation (no `slice:title-detail` import). Client +
      service unit tests and the page component test are green (no emulator, no
      network, no secrets; AngularFire + `fetch` + `AUTH_UID` mocked).
- [ ] `pnpm nx typecheck mobile-title-detail mobile-search mobile` passes — the new
      client/service/page, the search edit, and the shell's route + token provider
      compile against the merged shared types/converters (incl. the **0014-widened
      `WatchlistItem`** with `posterPath`/`voteAverage`, already on main).
- [ ] `pnpm nx build mobile` passes (production configuration) — the new slice
      lazy-loads cleanly at `tabs/title-detail/:titleId` and the bundle stays within
      existing budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green — mirrors
      CI. The affected set is `mobile-title-detail`, `mobile-search`, and `mobile`.
- [ ] **Component test** asserts the loading skeleton, loaded movie/tv, cache==live
      render parity, not-found, provider grouping + empty-providers, null-region, and
      the untracked→Add / tracked→status+remove action area (PLAN §5: component tests
      for non-trivial UI).
- [ ] `libs/mobile/title-detail/README.md` is a **real** README (purpose, barrel
      exports, the slice-local TMDB client + watchlist write helpers documented as
      **slice-internal, not shared**, the DI contract, Sheriff tags) — **no Nx
      scaffold text** (CLAUDE.md lib-README rule).
- [ ] **`firestore.rules`, `firestore.indexes.json`, `ci.yml`,
      `playwright.config.ts` are NOT modified** (existing owner-only + `title-cache`
      read rules cover this slice; only single-doc reads/subscription — verified and
      recorded in the PR). `sheriff.config.ts` touched **at most once**
      (verify-then-edit; PR records "edit" or "no change needed").
- [ ] **Guardrail verifications (review-checked):** (a) **no client write to
      `title-cache`** — the live fallback is display-only; every Firestore write
      targets `users/{uid}/watchlist/{titleId}` (create `planned`, update `status`,
      delete); (b) **no `episodes` read/write** (decision 6 — out of scope); (c) the
      uid arrives via **`AUTH_UID`** (no `ShellAuthService`/`apps/mobile` deep
      import); (d) **no cross-slice import** (no `slice:search`/`slice:watchlist`/
      `slice:settings`) and **no `scope:functions` import**; (e) a **null uid** and a
      **null/unset region** are guarded everywhere (no throw, graceful UI); (f) the
      add write carries the **denormalized `posterPath`/`voteAverage`** (0014
      consistency); (g) **no secret read/written** — the slice reuses the shell's
      `environment.tmdb` via `TMDB_DETAIL_CONFIG`, never touches `.env.local`.
- [ ] **UI fidelity — the page matches the pinned Stitch contract (screen
      `208cb8d7a679490b8d13672c6943d6d3`, "Movie Detail - Vultus", already captured + reconciled in the UI section).** The implementer **re-fetched** the screen
      via the MCP (retried on failure) to **visually verify**, and the PR records the
      **screen id**. The page honors **recon A–D**: filled Add CTA (`ion-button
  color="primary"` → `--ion-color-primary` `#4edea3` / `--ion-color-primary-contrast`
      `#003824` per the FIX-1 deviation note — NOT the screen's `primary-container`)
      is the only filled button and the
      **tracked state shows the status control, NOT a "Mark as Watched" button**;
      provider rows are **text-only** (name + type label, no logo, no `open_in_new`);
      Cast + Director/Budget/Language + runtime/voteAverage/genre are **conditional**
      (omitted when absent — verified the cached `TitleMetadata` omits them, no
      `shared/*` widening). The **two emeralds** are wired to distinct tokens (not
      collapsed). UI fidelity is **visually verified** (render/screenshot, or
      `nx serve mobile --configuration=mock`) across the documented states (loading /
      loaded-from-cache / cache-miss-live-fetched / not-found-or-TMDB-error /
      empty-providers / null-region) — or, if a human eyeball is still needed, the PR
      **explicitly flags the page "UI unverified — needs human eyeball."** **A green
      build alone does NOT satisfy this item.** Inter is confirmed **loaded**
      (web-font, the weights `apps/mobile/src/index.html` loads, 400–700) and the
      icon font loaded, not just named.
- [ ] PR description records: the **Stitch screen id** used (`208cb8d7…`), the exact
      verification commands, the no-`title-cache`-write / no-episodes /
      writes-only-to-`users/{uid}/watchlist` / uid-via-`AUTH_UID` / no-cross-slice /
      no-`scope:functions` / no-secret confirmations, the **no-`firestore.rules`-/-
      `indexes`-change** verification, the **TMDB-key dependency on spec 0015**
      (prod live-fallback + local dev), the cross-spec dependency on 0014's
      `WatchlistItem` widening, and that **emulator-backed e2e is descoped to PLAN §6
      item 20** (decision 8).

## Risks

- **TMDB key dependency on spec 0015 (prod + local dev).** The slice-local TMDB
  client reads `environment.tmdb.auth` (provided via `TMDB_DETAIL_CONFIG`). Today
  `environment.ts` ships an **empty** `auth.apiKey: ''` (spec 0013) and
  `environment.prod.ts` a `REPLACE_WITH_REAL_TMDB_API_KEY` placeholder. **The live
  cache-miss fallback therefore does not actually reach TMDB until spec 0015
  (`tmdb-ci-key-injection`, currently draft) lands** the CI substitution + local
  dev script. **Mitigations:** (a) the **cache-hit path needs no TMDB key** (it
  reads Firestore), so a synced title renders fully without 0015; (b) the live path
  degrades to the **not-found** state (a non-2xx with an empty/placeholder key) —
  no crash; (c) local dev needs the env key synced (manually or via 0015's script).
  **This spec does NOT duplicate 0015's CI work** and does not edit `ci.yml`; it
  reuses the existing `environment.tmdb` plumbing. Flag the 0015 dependency in the
  PR. (If the reviewer wants live fallback working in CI now, that is 0015's scope,
  not a silent addition here.)
- **TMDB data accuracy gaps (PLAN §2 / §9 open risk).** TMDB `watch/providers` is
  JustWatch-powered with **known accuracy gaps** for licensed (non-original)
  content in NL. The detail page surfaces whatever TMDB returns; an empty or
  inaccurate providers set is **possible and is not an error** (empty-providers
  state). This is the same open risk PLAN §9 tracks (Watchmode as a future layered
  fallback) — **not** introduced by this slice. Noted so a reviewer does not treat a
  thin providers list as a bug.
- **Live-fallback latency / N+1.** The cache-miss path makes **2 live TMDB calls**
  (detail + providers) on page open, serially or in parallel. For a single
  per-title page this is acceptable (one title, user-initiated); there is **no N+1
  over a list** here (unlike 0014's per-card availability). Use the loading skeleton
  during the live fetch; consider firing detail + providers in parallel
  (`Promise.all`) and aborting via `AbortSignal` on navigation away. Not a
  correctness risk; flagged so the implementer keeps the UX responsive.
- **The search-slice edit touches a merged slice (spec 0013, `done`).** Task 4 edits
  `libs/mobile/search/{search.page.ts,search.page.html,search.page.spec.ts}` — a
  **minimal** card-tap navigation that **preserves** the inline-add behavior (Add's
  `event.stopPropagation()` already guards it). **Mitigations:** keep the edit to a
  `Router.navigate` + a `(click)` on the card body; add **no** `slice:title-detail`
  import (navigation is a string route — no cross-slice Sheriff edge); extend (not
  rewrite) the existing component test. The change is additive; the risk is purely
  "don't regress 0013's add flow" — covered by the test asserting Add does **not**
  navigate.
- **`title-cache` eventual-consistency window after add.** Adding a title creates
  only `users/{uid}/watchlist/{titleId}` — it does **not** trigger a `title-cache`
  write (functions-only, daily cron). So immediately after adding, the title is
  tracked but **still uncached**; reopening the detail page uses the **live TMDB
  fallback** until the next sync populates `title-cache`. This is **by design**
  (decision 2) and handled gracefully (cache-first, live on miss). The realtime
  `tracked$` subscription reflects the add instantly; the metadata/providers may lag
  the cache by up to one sync cycle. Noted so a reviewer does not expect an
  immediate cache write on add (which would violate `firestore.rules`).
- **Consumes spec 0014's `WatchlistItem` widening (0014 is MERGED).** The add write
  carries the denormalized **`posterPath` + `voteAverage`**. **0014 is merged** — the
  widened `WatchlistItem` (`posterPath?: string | null`, `voteAverage?: number | null`)
  and the converters' `?? null` handling (`watchlistItemToData` /
  `dataToWatchlistItem`) are **on main** and **consumed directly** here. **Binding:**
  do **NOT** modify `shared/domain` or `shared/firestore-schema` in this spec — only
  **consume** the merged shared surface.
- **`AUTH_UID` can be null briefly / cross-boundary DI.** The uid signal is `null`
  before the anon session resolves (spec 0010) and, in the no-emulator dev/test
  context, may never resolve. **Mitigations:** the service guards a null uid on
  every uid-keyed call (emit `null`/no-op, tested); `detail$` needs no uid and still
  resolves (cache or live), so the page shows metadata even pre-session. The slice
  obtains the uid via the `scope:shared` `AUTH_UID` token (Sheriff rule 4), **never**
  by importing `ShellAuthService` (a forbidden `slice:title-detail → scope:mobile`
  edge) — mirrors specs 0011/0013/0014.
- **Injecting AngularFire `Firestore` is third-party, not a Sheriff violation.**
  Sheriff governs only `scope:`/`slice:` edges between workspace projects;
  `@angular/fire`, `firebase`, `@ionic/*`, `@angular/router`, `rxjs`, and the global
  `fetch` are external. The slice uses the shell's already-initialised Firebase (DI
  of `Firestore`) and **never** calls `initializeApp` / `signInAnonymously`.
- **New lib generation touches root config — keep it minimal + verify.** Unlike the
  fleshing-out specs (0011/0013/0014), this spec **generates a new lib** and edits
  **root** files (`tsconfig.base.json` path alias, possibly `sheriff.config.ts`,
  `app.routes.ts`, `app.config.ts`). These are all in **task 1 [sequential]** and
  are **additive**. **Mitigation:** verify-then-edit `sheriff.config.ts` (record "no
  change needed" if the glob+vocabulary already cover the slice); add the route as a
  new child (do not reshuffle existing routes); add the token provider alongside the
  existing `TMDB_SEARCH_CONFIG` (do not touch `AUTH_UID`/Firebase). Confirm the
  Sheriff glob targets `libs/mobile/title-detail/src` (project memory: tag the
  barrel module, not the lib root).
- **Stitch screen captured + pinned; data model is narrower than the mock (recon
  A–D).** Screen `208cb8d7a679490b8d13672c6943d6d3` ("Movie Detail - Vultus") **was
  fetched by the orchestrator** and its concrete tokens/dimensions/states are
  encoded in the UI section — the prior "unverified — BLOCKING" item is **resolved**.
  The standing risk is that the **mock is maximal** (cast, extended metadata,
  runtime, quality chip, provider logos + deep-links, a "Mark as Watched" button)
  while our **scope + stored `TitleMetadata` are narrower**: mark-watched is **0017**
  (recon A), providers are **text-only** with no logo/URL field (recon B), and
  **cast/director/budget/language/runtime/voteAverage/genre are not persisted** in
  `title-cache` (verified `TitleMetadata = { title, overview, posterPath,
releaseDate }`) so they render **only on the live-TMDB path and only when present**
  (recon C). **Mitigation:** the implementer must build the **reconciled** contract,
  not the raw mock — omit absent panels/rows rather than show placeholders, and must
  **NOT widen `shared/domain`/`shared/firestore-schema`** to persist the extra fields
  (sync-engine concern, out of scope). The implementer still **re-fetches the screen
  to visually verify** (render/screenshot or `--configuration=mock` serve) or
  explicitly flags it "unverified — needs human eyeball"; a green build does **not**
  prove fidelity.
- **No PLAN conflict.** This implements the **metadata + providers + watchlist
  actions** portion of PLAN §6 item 19 using the PLAN §4 `title-cache` +
  `users/{uid}/watchlist` shapes and the spec-0010 AngularFire/`AUTH_UID` DI
  contract. The **episode list + per-episode mark-watched** portion of item 19 is
  **deferred to a future spec (0017)** (decision 6) — a deliberate, recorded
  narrowing, not a silent omission. The **live TMDB fallback on cache miss**
  (decision 2) extends — does not fork — the PLAN §4 model: it reads, never writes,
  the functions-only `title-cache`, and surfaces TMDB directly only for display when
  the cache is empty.
