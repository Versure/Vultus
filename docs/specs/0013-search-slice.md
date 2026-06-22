---
number: 0013
slug: search-slice
title: Build the search slice — debounced TMDB search with inline add-to-watchlist
status: approved
slices: [slice:search]
scopes: [scope:mobile]
created: 2026-06-22
---

# Build the search slice — debounced TMDB search with inline add-to-watchlist

## Context

PLAN §6 item 17 — **`slice:search`** — is the second real mobile slice (after
`slice:settings`, spec 0011). It is how the user gets titles **into** the system:
search TMDB, see results, tap **Add** to put a title on the watchlist. Everything
downstream (the watchlist slice, the daily sync, the notification dispatcher)
operates on the `users/{uid}/watchlist/*` docs this slice creates — until search
exists the watchlist is always empty.

The Search tab and a placeholder `SearchPage` already exist: spec 0010 (PLAN §6
item 15, merged) generated the three stub mobile slice libs
(`libs/mobile/{watchlist,search,settings}`), Sheriff-tagged each
(`scope:mobile` + `slice:<slice>`), and lazy-routed them behind the Ionic tabs
shell. `apps/mobile/src/app/app.routes.ts` already lazy-loads
`SearchPage` from `@vultus/mobile/search` at the `search` tab, and the shell
provides the `AUTH_UID` injection token (`@vultus/shared/domain`) from its
`ShellAuthService.uid` signal (`apps/mobile/src/app/app.config.ts`). Firebase /
AngularFire `Firestore` is initialised in the shell against the emulators.

This spec **fleshes out `libs/mobile/search`** (it does **not** regenerate the
lib): live, debounced TMDB search; result cards with poster + title + year +
media-type badge; and an inline **Add** action that writes a `planned` watchlist
entry and flips the card to an "added" state. It reads the user's existing
watchlist to render already-added cards so the user can't double-add.

Intended outcome: opening the **Search** tab shows a prompt-only empty state;
typing debounces (~400 ms) and shows matching movies/TV shows; tapping **Add** on
a card writes `users/{uid}/watchlist/{titleId}` with `status: 'planned'` and the
card immediately shows a checked/"Added" state; titles already on the watchlist
render in the added state from the first render.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Live search-as-you-type, debounced ~400 ms.** The query input drives the
   search; each change (after the debounce) clears the prior results and
   re-triggers a fetch. No explicit search button. An empty/whitespace query does
   **no** fetch and shows the prompt-only empty state (decision 6).
2. **Result card content (no overview).** Each card shows: a **poster thumbnail**
   (TMDB image), **title**, **release/first-air year**, and a **media-type badge**
   ("Movie" / "TV Show"). **No overview snippet.** A result with no poster shows a
   placeholder (no broken image).
3. **Inline Add, user stays in results.** The **Add** button lives **on the card**.
   Tapping it adds the title and transitions that card in place to an
   "already-added"/checked state; the user is **not** navigated away and the
   results list is **not** cleared.
4. **Default status on add is `planned`.** The created watchlist entry has
   `status: 'planned'` (PLAN §4 `WatchStatus`).
5. **Already-added cards render in a distinct state.** Titles already in the
   watchlist (read live from `users/{uid}/watchlist`) render with a checkmark / a
   disabled-or-different button so the user **cannot** accidentally re-add. The
   Add action also guards against a duplicate write (decision in Public types).
6. **Empty-query state is prompt-only.** With no query, show a prompt screen
   ("Search for movies and TV shows") and **fetch nothing**.
7. **No-results state.** A query that returns zero results shows a friendly empty
   state (icon/illustration) with a "No results for '<query>'" message.
8. **The TMDB search client lives IN this slice — duplication of the
   `sync-titles` client is intentional.** `libs/functions/sync-titles` already has
   a TMDB client (spec 0006), but it is `scope:functions` and Sheriff forbids a
   `scope:mobile` slice from importing it. This slice implements its **own**
   lightweight TMDB search client (only `search/multi` — or `search/movie` +
   `search/tv`). This is **deliberate vertical-slice duplication** (CLAUDE.md /
   PLAN §3), not a candidate for `shared/` extraction (one consumer, far short of
   the 3+-slice rule).
9. **No new e2e in this spec.** e2e + emulator wiring is PLAN §6 item 20. The
   green gate here is **unit + component + build** (what `ci.yml` runs: `lint test
   build`). All Firebase and all TMDB HTTP access in tests is **mocked** — no live
   Firebase, no emulator (project memory: the emulator cannot run under Claude
   Code tools here), no real TMDB network, no secrets.

## Scope

In scope:

- A **slice-local TMDB search client** (`TmdbSearchClient`): a thin factory over
  injected `fetch` + injected config (base URL, image base URL, bearer/api key),
  calling TMDB `search/multi` (filtered to `movie`/`tv` results) and mapping the
  raw response to a slice-local `SearchResult[]` (decision 8). Zero Firebase, zero
  Angular-DI hard dependency on the shell; pure-ish and unit-testable with a fake
  `fetch`.
- A **search state/data-access service** (`SearchService`): owns the debounced
  query→results pipeline (decision 1), exposes results + loading + error +
  empty/no-results view-state as signals, reads the user's watchlist to mark
  already-added results (decision 5), and performs the **Add** write (decision 3/4)
  with a duplicate guard.
- The **real `SearchPage`** replacing the spec-0010 stub: a search input
  (`ion-searchbar`), the result list of cards (decision 2), the inline Add button
  with the added-state transition (decision 3/5), and the prompt / loading /
  no-results / error view states (decisions 6/7).
- **TMDB config plumbed through `environment.ts`** + a slice injection token
  (`TMDB_SEARCH_CONFIG`) so the client gets its base URL / image base URL / key by
  DI, never reading a secret directly (see Risks — the TMDB-key-in-client caveat).
- Update `libs/mobile/search/README.md` to the real public surface (no Nx/stub
  scaffold text).
- Tests (see Test plan): unit for the client + service, component for the page.

Out of scope (each its own later spec):

- **Title-detail page** (`slice:title-detail`, PLAN §6 item 19) — tapping a card
  to view metadata / providers / episodes. This spec's card is search-result-only;
  navigation to a detail page is not wired here.
- **The watchlist list/management UI** (`slice:watchlist`, PLAN §6 item 18) —
  removing/changing status, pull-to-refresh. This slice only **creates** entries
  and **reads** the watchlist to mark added state.
- **Fetching/seeding episodes on add** — the daily sync (specs 0008/0009) and the
  title-detail slice own episodes. The Add write creates **only** the
  `watchlist/{titleId}` doc, no `episodes` subcollection, no `title-cache` write.
- **`traktId` resolution** — set to `null` on add (PLAN §4 allows it; the sync
  engine / Trakt client resolve it later). No Trakt call here.
- **Search filters / pagination / infinite scroll** — v1 shows TMDB page-1
  multi-search results only. Paging is a later enhancement.
- **Emulator-backed e2e** — PLAN §6 item 20 (decision 9). No `ci.yml` /
  `playwright.config.ts` / `apps/mobile-e2e` change.
- **`firestore.rules` / `firestore.indexes.json` changes** — the existing rules
  already grant owner-only read/write to `users/{uid}/**`; the watchlist read is a
  single collection query needing no composite index (see Data model touchpoints).
- **CI key-injection wiring** — substituting the real TMDB key into
  `environment.prod.ts` at build time from the `TMDB_API_KEY` GitHub Actions secret is
  a **prerequisite/follow-up**, owned by a CI spec (see Implementation notes + Risks).
  This spec only lands the placeholder; it does not edit `ci.yml`.

### Implementation notes — TMDB key injection

The TMDB key is delivered to the bundle by environment injection, never committed
(user-confirmed option 2; see Risks):

- **`environment.ts` (dev)** carries an **empty/placeholder** TMDB key (like the
  existing `demo-` Firebase placeholders). The **real** dev key lives in **`.env.local`**
  (gitignored). At dev time the implementer populates `environment.ts`'s `tmdb.auth`
  value from `.env.local` — **manually, or via an `ng build` pre-hook** — and slice code
  **never reads or writes `.env.local` programmatically**. Document the chosen dev-setup
  step (manual copy vs. pre-hook) in the slice/app README so a fresh checkout can run
  search against TMDB locally.
- **`environment.prod.ts`** carries a **`REPLACE_WITH_REAL_TMDB_API_KEY`** placeholder.
  The existing/future **GitHub Actions** workflow substitutes it (e.g. `sed`/`envsubst`)
  from the **`TMDB_API_KEY`** secret **before** `nx build mobile --configuration=production`.
  That CI step is a **prerequisite/follow-up — NOT in this spec's Definition of done**;
  the implementer flags it in the PR description and the CI change is a separate spec.

## Affected slices & Sheriff tags

| Project       | Path                       | Sheriff tags                 | Change                                                                                            |
| ------------- | -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| mobile-search | `libs/mobile/search`       | `scope:mobile`, `slice:search` | flesh out `SearchPage`; add `TmdbSearchClient` + `SearchService` + config token; README; tests   |
| mobile (app)  | `apps/mobile`              | `scope:mobile`               | add TMDB config to `environment.ts`/`environment.prod.ts`; provide `TMDB_SEARCH_CONFIG` at root   |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (spec 0010): the search lib
  already inherits `['scope:mobile', 'slice:search']` from the
  `libs/mobile/<slice>/src` glob, and `apps/mobile` is `scope:mobile`. **This spec
  does NOT edit `sheriff.config.ts`.**
- **Import boundaries (verified against the spec-0010 Sheriff rules):**
  - `libs/mobile/search` (`slice:search`) is governed by `'slice:*': ['scope:shared',
    sameTag]` — it may import **only** `scope:shared` and other `slice:search`
    modules. It imports `@vultus/shared/domain` (`WatchlistItem`, `WatchStatus`,
    `TitleType`, `AUTH_UID`) and `@vultus/shared/firestore-schema`
    (`watchlistPath`/`watchlistItemPath`, `watchlistItemToData`) — **both
    `scope:shared`, allowed (rule 4)**. It imports **no other slice** (not
    `slice:watchlist`, not `slice:settings`) and — critically — **not**
    `libs/functions/sync-titles` (that is `scope:functions`; a `scope:mobile`
    slice importing it is a **double** violation: rule 1 cross-scope **and** rule 2
    cross-slice). The slice's own `TmdbSearchClient` exists precisely to avoid that
    import (decision 8).
  - The slice injects AngularFire `Firestore` and the `AUTH_UID` token. **AngularFire
    (`@angular/fire`), `firebase`, `@ionic/*`, and the global `fetch` are
    third-party** — not policed by Sheriff. **It must NOT import `ShellAuthService`
    from `apps/mobile`** (even type-only — that creates a forbidden
    `slice:search → scope:mobile` Sheriff edge). It obtains the uid via the
    **`AUTH_UID` injection token** from `@vultus/shared/domain`, which the shell
    already provides at root (`apps/mobile/src/app/app.config.ts:67`,
    `{ provide: AUTH_UID, useFactory: () => inject(ShellAuthService).uid }`) — a
    `scope:shared` import, allowed by rule 4. The TMDB config likewise arrives via
    the slice-exported `TMDB_SEARCH_CONFIG` token, **provided by the shell** at
    root from `environment.ts` (the token type lives in the slice, so the shell's
    root provider imports the slice barrel — `apps/mobile` importing a
    `slice:search` it owns is **rule 3, allowed**).
  - **No `scope:functions` file is touched.**
- **No `shared/` extraction.** The TMDB search client, the result mapping, the
  debounce pipeline, and the add/duplicate-guard logic all live **inside**
  `libs/mobile/search` — one consumer, far short of the 3+-slice rule (CLAUDE.md /
  PLAN §3). Only the **types** (`WatchlistItem`, `WatchStatus`, `TitleType`,
  `AUTH_UID`) and the **path/converter** helpers are shared, and those **already
  exist** in `shared/domain` + `shared/firestore-schema`; this spec adds **no** new
  shared surface.

## Data model touchpoints

PLAN §4 `users/{uid}/watchlist/{titleId}` is the only Firestore location touched.
The shape is **already defined and converter-backed** (`@vultus/shared/domain`
`WatchlistItem`, `@vultus/shared/firestore-schema` `watchlistItemToData` /
`dataToWatchlistItem` + `watchlistPath` / `watchlistItemPath`) — this spec
**reuses** it, it does not redefine it. TMDB is read over HTTP (not Firestore).

| PLAN §4 path                          | Access by this slice           | Fields                                                                  |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `users/{uid}/watchlist`               | **read** (collection)          | snapshot the user's items to compute the already-added set (by `tmdbId`/`titleId`) |
| `users/{uid}/watchlist/{titleId}`     | **create**                     | `type`, `tmdbId`, `traktId: null`, `title`, `addedAt`, `status: 'planned'` |
| `users/{uid}/watchlist/{titleId}/**`  | **none**                       | episodes subcollection NOT written on add                               |
| `title-cache/**`                      | **none**                       | not read, not written by this slice                                     |
| `users/{uid}` (root doc)              | **none**                       | settings slice owns it (spec 0011); search does not touch it            |

- **Document id (`titleId`).** Use the **TMDB id as the doc id**:
  `titleId = String(tmdbId)`. This makes the doc deterministic per title (a natural
  duplicate guard — a second add to the same id is the same path), and matches the
  `tmdbId` field. **Binding:** the doc id is the stringified TMDB id; write via
  `watchlistItemPath(uid, String(tmdbId))`.
- **Add write (decisions 3/4).** Build a `WatchlistItem`:
  `{ type, tmdbId, traktId: null, title, addedAt: <now ISO>, status: 'planned' }`,
  pass it through `watchlistItemToData(item)` (the converter coerces `addedAt` to a
  `Date` the SDK persists as a `Timestamp`), and `setDoc` it at
  `watchlistItemPath(uid, String(tmdbId))`. **Use the shared converter — do not
  hand-roll the wire mapping.** `addedAt` is `serverTimestamp()`-equivalent in
  intent; the converter takes an ISO string → `Date`, so pass the client clock's
  ISO `now` (a true Firestore `serverTimestamp()` is acceptable if the implementer
  prefers, but then bypass the converter's `addedAt` and document it — the
  converter path with a client `now` is the recommended, test-simpler default).
- **Already-added read (decision 5).** Read `users/{uid}/watchlist` (collection)
  once / reactively and build a `Set` of added ids (the doc ids, i.e. stringified
  `tmdbId`). A result is "added" when its id is in that set. Prefer a live
  `collectionData`/`onSnapshot` subscription so a just-added card stays added and
  cross-session adds reflect immediately; a one-shot read on page enter is an
  acceptable simpler alternative if the just-added id is also tracked locally
  (state which is chosen in the README).
- **No `firestore.rules` change.** Spec 0004's rules grant the owner read/write to
  `users/{uid}/**` for any authenticated uid (anonymous counts). The watchlist read
  + the `watchlist/{titleId}` create are owner operations on the user's own subtree
  — already permitted. **Do NOT edit `firestore.rules`.**
- **No `firestore.indexes.json` change** — the watchlist read is a single
  collection read (no `where`/`orderBy` compound query). **Do NOT edit it.**

## Public types / APIs

All new public surface is exported (as needed) from the slice barrel
`libs/mobile/search/src/index.ts`. **No HTTP endpoint, no callable, no new shared
domain type** — `WatchlistItem`, `WatchStatus`, `TitleType` already exist in
`@vultus/shared/domain`; `watchlistPath`/`watchlistItemPath`/`watchlistItemToData`
already exist in `@vultus/shared/firestore-schema`. **Reuse them — do not
duplicate.**

### Slice-local TMDB search types + client (`src/lib/tmdb-search.client.ts`)

```ts
import type { TitleType } from '@vultus/shared/domain';

/** One mapped TMDB multi-search result the UI renders (decision 2). */
export interface SearchResult {
  tmdbId: number;
  type: TitleType; // 'movie' | 'tv' — TMDB 'person' results are dropped
  title: string; // movie.title | tv.name
  year: number | null; // from release_date (movie) / first_air_date (tv); null if absent
  posterUrl: string | null; // full image URL (config.imageBaseUrl + poster_path) or null
}

/** Injected config — base URLs + auth. NEVER read from a secret by the client. */
export interface TmdbSearchConfig {
  apiBaseUrl: string; // e.g. https://api.themoviedb.org/3
  imageBaseUrl: string; // e.g. https://image.tmdb.org/t/p/w185
  /** TMDB auth: a v4 bearer token (Authorization: Bearer …) OR a v3 api_key
   *  query param — the implementer picks one and documents it. See Risks. */
  auth:
    | { kind: 'bearer'; token: string }
    | { kind: 'apiKey'; apiKey: string };
}

export interface TmdbSearchClient {
  /** GET search/multi?query=… ; maps movie+tv results to SearchResult[] (page 1).
   *  Drops 'person' results and any result missing an id/title. Throws/raises a
   *  typed error on non-2xx so the service can surface an error view-state. */
  searchMulti(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export function createTmdbSearchClient(
  config: TmdbSearchConfig,
  fetchImpl?: typeof fetch, // default: global fetch — injected for tests
): TmdbSearchClient;
```

- The client is **framework-light** (no Angular decorator required) so it can be
  unit-tested with a fake `fetch`. The service wraps/constructs it.
- **Config token (exported from the barrel):**
  ```ts
  import { InjectionToken } from '@angular/core';
  /** Provided at root by apps/mobile from environment.ts. */
  export const TMDB_SEARCH_CONFIG = new InjectionToken<TmdbSearchConfig>(
    'TMDB_SEARCH_CONFIG',
  );
  ```

### Search service (`src/lib/search.service.ts`)

```ts
@Injectable() // providedIn: 'root' OR page-scoped — implementer's call
export class SearchService {
  /** Bound to the searchbar; setting it (debounced ~400ms) drives the search. */
  setQuery(query: string): void;

  /** Current results (already-added flag applied), empty until a query runs. */
  readonly results: Signal<SearchResultView[]>;
  /** View-state for the page: 'prompt' | 'loading' | 'results' | 'no-results' | 'error'. */
  readonly viewState: Signal<SearchViewState>;

  /** Add a result to the watchlist as 'planned' (decisions 3/4); idempotent
   *  duplicate guard (decision 5) — a no-op if already added. */
  add(result: SearchResult): Promise<void>;
}

/** A SearchResult plus whether it is already on the user's watchlist. */
export interface SearchResultView extends SearchResult {
  added: boolean;
}
export type SearchViewState =
  | 'prompt' // empty/whitespace query (decision 6)
  | 'loading'
  | 'results'
  | 'no-results' // query ran, zero results (decision 7)
  | 'error';
```

Method/signal names are a **recommendation**; what is **binding** is the
behaviour: debounced (~400 ms) query→`searchMulti`, prior results cleared on a new
query, the five view-states above, the already-added flag computed from the
watchlist read (by stringified `tmdbId`), and `add()` writing exactly the
decision-3/4 `WatchlistItem` via the shared converter with a duplicate guard
(decision 5). The **uid** comes from the injected `AUTH_UID` signal; if it is
`null`, `add()` is a guarded no-op / not-ready (mirrors spec 0011's null-uid guard)
and the search itself still works (search needs no uid).

### Barrel surface

Export `SearchPage` (keep the spec-0010 export), `TMDB_SEARCH_CONFIG`, and
`TmdbSearchConfig` (the shell's root provider needs both to wire the token).
`SearchService`, `TmdbSearchClient`, `SearchResult`, `SearchResultView`,
`SearchViewState` are exported **only if** a test or the page composition needs
them across the barrel; otherwise keep them slice-internal. Document whatever is
exported in the README.

### Shell wiring (`apps/mobile`)

- Add a `tmdb` block to `environment.ts` and `environment.prod.ts`:
  `{ apiBaseUrl, imageBaseUrl, auth }`. **The dev value uses an obvious
  placeholder/empty key** (like the existing `demo-` Firebase placeholders) —
  populated locally from `.env.local` (Implementation notes) — and
  `environment.prod.ts` uses a `REPLACE_WITH_REAL_TMDB_API_KEY` placeholder that the
  GitHub Actions workflow substitutes from the `TMDB_API_KEY` secret at build time
  (CI wiring is a follow-up, not this spec's DoD). Do **not** fabricate or commit a
  real key (see Risks + Implementation notes + Definition of done).
- In `app.config.ts`, add a root provider
  `{ provide: TMDB_SEARCH_CONFIG, useValue: environment.tmdb }` (importing
  `TMDB_SEARCH_CONFIG` from `@vultus/mobile/search` — `apps/mobile` importing a
  slice it owns is rule 3, allowed). Keep the existing `AUTH_UID` provider
  unchanged.

## UI / Stitch screen refs

This is a mobile slice — the implementer **must pull the Search screen** via the
`stitch` MCP from project **`projects/13590348714018893783`** ("Vultus Android App
Design"): run `list_screens`, find the **Search** screen, then `get_screen` on it;
**reference its screen ID in the PR** and align layout (searchbar placement, result
card structure, empty/no-results states, the added-state control) to it.

> **Stitch MCP status (spec-author, 2026-06-22):** the `stitch` MCP was **NOT
> reachable in the spec-authoring session** (no `stitch` server / `get_screen`
> tool available), so the specific Search screen ID could not be captured here.
> **Stitch Search screen not found in-session; PLAN §2 design tokens applied as
> fallback** — the layout and token contract below is derived from the canonical
> "Vultus Design System" tokens in PLAN §2, already seeded into `shared/ui-kit`
> by spec 0010 (`libs/shared/ui-kit/src/lib/theme.scss`). The implementer **must
> still attempt `list_screens` / `get_screen` for the Search screen when the MCP
> is reachable**, reconcile any layout/visual divergence against the tokens below,
> and **record the resolved Stitch screen ID (or "MCP unreachable") in the PR**. A
> Stitch outage must not block an otherwise-correct PR.

Layout (Ionic, consuming the spec-0010 `shared/ui-kit` theme tokens — use the
**seeded CSS custom properties**, do not hard-code hex):

- **Header / search bar.** `IonHeader` / `IonToolbar` / `IonTitle` ("Search") over
  an `IonSearchbar`. The searchbar sits on the **elevated surface**
  (`--vultus-surface-elevated` `#1E293B`) above the **`--vultus-surface` `#0F172A`**
  page background, **0.5rem** radius (`--vultus-radius`), muted placeholder text
  (`--vultus-text-muted` `#94A3B8`). Its `ionInput`/`debounce` drives
  `SearchService.setQuery`; Ionic's searchbar has a built-in `debounce` — set it to
  ~400 ms, **or** debounce in the service, not both.
- `IonContent` (page background `--vultus-surface` `#0F172A`) rendering one of the
  five view-states:
  - **prompt** (decision 6): a vertically-centered empty state — a large muted
    search/film icon (`--vultus-text-muted` `#94A3B8`) above the copy "Search for
    movies and TV shows" in muted text. No card list.
  - **loading**: an `IonSpinner` (Emerald accent, `--ion-color-primary` `#10B981`)
    or skeleton cards while a fetch is in flight.
  - **results**: an `IonList` (transparent over the page background) of result
    **cards** on the **elevated surface** (`--vultus-surface-elevated` `#1E293B`,
    `--vultus-radius` `0.5rem`, optional 1px `--vultus-border` `#334155` outline,
    `--vultus-space-2` `16px` internal padding, `--vultus-space-1` `8px` vertical
    gap between cards — 8px grid). **Card structure (decision 2), poster-left:**
    - **Poster thumbnail** on the leading edge: `posterUrl` (TMDB `w185`) in a
      fixed-ratio (2:3) rounded-corner (`--vultus-radius-sm` `0.25rem`) frame; a
      neutral slate placeholder with a film icon when `posterUrl === null` (no
      broken image).
    - **Text block** (trailing the poster): **title** in primary text
      (`--ion-text-color` `#F8FAFC`, Inter, ~`1rem`/16px, semibold, 1–2 lines
      truncated), **release/first-air year** beneath it in muted text
      (`--vultus-text-muted` `#94A3B8`, ~`0.875rem`/14px), and a **media-type
      badge** — an `IonBadge` reading **"Movie"** or **"TV Show"** in a low-emphasis
      slate fill (`--vultus-surface-overlay` `#2D3748` background, muted text),
      pill radius (`--vultus-radius-pill`). The badge is a neutral chip, **not**
      Emerald (Emerald is reserved for the primary Add affordance).
    - **Add control** on the trailing edge of the card:
      - **Not-added** (`added === false`): an active **Add** button — Emerald
        primary (`--ion-color-primary` `#10B981`, white contrast text/icon), a
        compact `IonButton` (or icon-button with a `+`/`add` icon), `--vultus-radius`
        `0.5rem`. This is the **only** Emerald-filled element on the card.
      - **Added** (`added === true`, decision 5): replace the active button with a
        **checked, non-actionable** state — a **checkmark** (`checkmark`/
        `checkmark-circle` icon) in Emerald (`#10B981`) with an "Added" label in
        muted text, rendered as a `disabled` button (or a plain checkmark chip) so
        it is visibly settled and **cannot** be tapped to re-add. Maps to the
        **Planned** status semantically, but the **added affirmation uses Emerald**
        (the "done/added" success accent); the `#94A3B8` Planned status color is a
        watchlist-slice concern and is **not** required on this search card.
  - **no-results** (decision 7): a vertically-centered empty state — a muted
    icon/illustration (`--vultus-text-muted` `#94A3B8`) above "No results for
    '<query>'" in muted text. Same visual family as the prompt state, different copy.
  - **error**: a friendly centered "Something went wrong" in muted text with a
    **retry** affordance — an outline/secondary `IonButton` (Emerald text/border,
    not a filled Emerald block) so it reads as a recovery action, not a primary CTA.
- **Token contract (PLAN §2, via `shared/ui-kit` CSS custom properties — do not
  redefine or hard-code):**
  - **dark-first**, **Inter** (`--vultus-font-family`).
  - **Primary Emerald `#10B981`** (`--ion-color-primary`): the Add button and the
    added-state checkmark accent — and **only** those, to keep the CTA unambiguous.
  - **Surfaces:** `--vultus-surface` `#0F172A` (page), `--vultus-surface-elevated`
    `#1E293B` (cards / searchbar / toolbar), `--vultus-surface-overlay` `#2D3748`
    (the media-type badge chip), `--vultus-border` `#334155` (card outline).
  - **Text:** `--ion-text-color` `#F8FAFC` (title), `--vultus-text-muted` `#94A3B8`
    (year, badge label, empty-state copy, placeholders).
  - **Spacing** on the **8px grid** (`--vultus-space-*`); **radius** `--vultus-radius`
    `0.5rem` (cards/buttons/searchbar), `--vultus-radius-sm` `0.25rem` (poster),
    `--vultus-radius-pill` (badge).
  - **Status colors** (`--vultus-status-*`): not surfaced on the search card in v1
    (search creates only a `planned` entry and shows a generic added affirmation);
    the full status-color map (Watching `#3B82F6`, Completed/`#10B981`, Dropped
    `#EF4444`, Planned `#94A3B8`) is the **watchlist slice's** concern (PLAN §6
    item 18). Noted here so the implementer does not invent a status legend on the
    search card.

## Implementation task graph

Single-slice spec with one shell-wiring task. The slice files share the lib's
`src/index.ts` + page composition, so the slice work is **sequential**. The shell
wiring (task 4) depends on the slice barrel exporting `TMDB_SEARCH_CONFIG` /
`TmdbSearchConfig` (task 1), but writes only `apps/mobile` files — its manifest is
disjoint from the slice's, so it **may run in parallel with tasks 2–3** once task 1
lands. To keep the fan-out unambiguous it is listed `[parallel]` with an explicit
manifest; tasks 2 and 3 stay `[sequential]` relative to task 1 and each other.

1. **[sequential] Slice-local TMDB search client + config token
   (`slice:search`).** frontend-engineer.
   - `src/lib/tmdb-search.client.ts`: `SearchResult`, `TmdbSearchConfig`,
     `TmdbSearchClient`, `createTmdbSearchClient(config, fetchImpl?)` — `search/multi`
     call, movie+tv mapping (drop `person`), year extraction, poster URL build,
     typed non-2xx error. Injected `fetch` for tests; no Firebase, no Angular hard
     dep.
   - `TMDB_SEARCH_CONFIG` `InjectionToken` (same file or `src/lib/tokens.ts`).
   - Export `TMDB_SEARCH_CONFIG` + `TmdbSearchConfig` (and `SearchResult` if the
     service barrel-imports it) from `src/index.ts`.
   - Files: `libs/mobile/search/src/lib/tmdb-search.client.ts`,
     `libs/mobile/search/src/lib/tokens.ts` (optional),
     `libs/mobile/search/src/index.ts`.

2. **[sequential] Search service (`slice:search`). Depends on task 1.**
   frontend-engineer.
   - `src/lib/search.service.ts`: inject `TMDB_SEARCH_CONFIG`, `AUTH_UID`,
     AngularFire `Firestore`. Build the debounced query→results pipeline (decision
     1, ~400 ms), the five `viewState`s, the watchlist read → already-added set
     (decision 5), and `add()` (decisions 3/4 via `watchlistItemToData` +
     `watchlistItemPath`, null-uid guard, duplicate guard).
   - Files: `libs/mobile/search/src/lib/search.service.ts`.

3. **[sequential] Real `SearchPage` + barrel + README. Depends on task 2.**
   frontend-engineer.
   - Replace the spec-0010 stub body: `IonSearchbar` + the five view-states + the
     result cards with inline Add / added-state (UI section). Keep `SearchPage`
     exported from `src/index.ts`.
   - Rewrite `libs/mobile/search/README.md` to the real public surface (what the
     lib is, barrel exports, that it reads `users/{uid}/watchlist` + creates
     `watchlist/{titleId}` via the shared converter, that it owns a slice-local
     TMDB client by design, the `TMDB_SEARCH_CONFIG`/`AUTH_UID` DI contract, and
     the Sheriff tags `scope:mobile` + `slice:search`). **No leftover stub text.**
   - Files: `libs/mobile/search/src/lib/search.page.ts`,
     `libs/mobile/search/src/lib/search.page.html`,
     `libs/mobile/search/src/lib/search.page.scss`,
     `libs/mobile/search/src/index.ts`,
     `libs/mobile/search/README.md`.

4. **[parallel] Shell TMDB config + root provider (`scope:mobile`, `apps/mobile`).
   Depends on task 1** (imports `TMDB_SEARCH_CONFIG`/`TmdbSearchConfig` from the
   slice barrel). frontend-engineer.
   - Add a `tmdb` block to `environment.ts` (dev placeholder/empty key, populated
     locally from `.env.local`) and `environment.prod.ts`
     (`REPLACE_WITH_REAL_TMDB_API_KEY` placeholder, CI-substituted from the
     `TMDB_API_KEY` secret — do not fabricate a real key). Add
     `{ provide: TMDB_SEARCH_CONFIG, useValue: environment.tmdb }`
     to `app.config.ts` providers; leave `AUTH_UID` + Firebase providers unchanged.
   - **Manifest (disjoint from tasks 1–3, 5):**
     `apps/mobile/src/environments/environment.ts`,
     `apps/mobile/src/environments/environment.prod.ts`,
     `apps/mobile/src/app/app.config.ts`.

5. **[sequential] Tests (`slice:search`). Depends on tasks 1–3.**
   frontend-engineer / qa-runner.
   - Client unit + service unit + page component tests (Test plan).
   - Files: `libs/mobile/search/src/lib/tmdb-search.client.spec.ts`,
     `libs/mobile/search/src/lib/search.service.spec.ts`,
     `libs/mobile/search/src/lib/search.page.spec.ts` (replacing the spec-0010 stub
     render test).

(All slice work lives under `libs/mobile/search/**`; task 4 is the only work
outside it, in `apps/mobile/src/**`. No `sheriff.config.ts`, `firestore.rules`,
`firestore.indexes.json`, `libs/functions/**`, or any `scope:functions` file is
touched. The four tasks' manifests under `libs/mobile/search` are sequential
because they share `src/index.ts`; task 4's `apps/mobile` manifest is disjoint.)

## Test plan

Per the PLAN §5 pyramid — a thin UI slice with real logic, so **unit** tests (the
client + the service) and a **component** test (the page). **No emulator-backed
e2e** (decision 9). All TMDB HTTP and all Firebase access is **mocked** (no live
Firebase, no network, no secrets).

**Unit — TMDB client (`tmdb-search.client.spec.ts`, Vitest, fake `fetch`):**

- **Maps a multi-search response:** a fake `fetch` returning a mixed
  `movie`/`tv`/`person` payload → `searchMulti` yields only the movie + tv results
  as `SearchResult[]`, with `title` from `title`/`name`, `year` parsed from
  `release_date`/`first_air_date`, `posterUrl` = `imageBaseUrl + poster_path`.
- **Null poster / null date:** a result missing `poster_path` → `posterUrl: null`;
  missing/blank date → `year: null` (no throw, no `NaN`).
- **Drops `person` + malformed results** (no id / unknown `media_type`).
- **Builds the request correctly:** the URL hits `search/multi`, carries the
  `query`, and the auth (bearer header **or** `api_key` param per the chosen
  `auth.kind`); the injected `fetch` (not the global) is used.
- **Error handling:** a non-2xx response (or `fetch` reject) surfaces a typed
  error (not an unhandled rejection); the empty/whitespace query path does **not**
  call `fetch`.

**Unit — search service (`search.service.spec.ts`, Vitest, fake client + mocked
AngularFire `Firestore` + mocked `AUTH_UID` signal):**

- **Debounce + clear-and-retrigger (decision 1):** rapid `setQuery` calls within
  the window result in **one** `searchMulti` call (the latest query) using fake
  timers; a new query clears prior results before the next resolves.
- **View-states (decisions 6/7):** empty/whitespace query → `'prompt'`, no fetch;
  a query in flight → `'loading'`; results present → `'results'`; zero results →
  `'no-results'`; client error → `'error'`.
- **Already-added flag (decision 5):** with the watchlist mock containing the
  stringified `tmdbId` of one result, that result's view has `added: true`, others
  `added: false`.
- **add() write shape (decisions 3/4):** `add(result)` writes to
  `watchlistItemPath(uid, String(result.tmdbId))` a payload equal to
  `watchlistItemToData({ type, tmdbId, traktId: null, title, addedAt, status:
  'planned' })` — assert `status === 'planned'`, `traktId === null`, the id is the
  stringified tmdbId.
- **Duplicate guard (decision 5):** `add()` on an already-added result is a no-op
  (no second write); after a successful add the result's `added` flips to `true`.
- **Null-uid guard:** with `AUTH_UID` signal `null`, `add()` does **not** call
  Firestore (search still works); a defined not-ready behaviour, no throw on an
  undefined path.
- **No write outside `users/{uid}/watchlist`:** every mocked write targets a
  `watchlist/{titleId}` doc — never `episodes`, never `title-cache`, never
  `users/{uid}` root.

**Component (`search.page.spec.ts`, Angular TestBed + Ionic test setup, mirroring
the spec-0010 stub render test; `SearchService` mocked):**

- **Prompt state:** with no query, the prompt copy renders and no card list shows
  (decision 6).
- **Results list:** given mock results, the page renders one card per result with
  the poster image when `posterUrl` is set, the **placeholder** when `posterUrl` is
  `null` (no broken `<img>`), the title, the muted year, and the correct media-type
  badge text ("Movie"/"TV Show") (decision 2, UI section).
- **Add interaction:** tapping a card's Emerald Add button calls `SearchService.add`
  with that result (decision 3).
- **Added-state (decision 5):** a result with `added: true` renders the
  checkmark/"Added" settled state (disabled / non-actionable) and **no** active Add
  button — tapping it does not call `add` again (can't re-add).
- **No-results + loading states:** the `'no-results'` view shows the "No results
  for '<query>'" copy (decision 7); the `'loading'` view shows the spinner.

**e2e:** **descoped to PLAN §6 item 20** (decision 9). No new Playwright spec; no
change to `apps/mobile-e2e`, `playwright.config.ts`, or `ci.yml`.

## Definition of done

Tailored from PLAN §5 to the projects touched. Green gate is **unit + component +
build** (what `ci.yml` runs: `lint test build`); emulator-backed e2e is descoped to
PLAN §6 item 20 (decision 9).

- [ ] `pnpm nx run-many -t lint test -p mobile-search` passes **with Sheriff
      active** (lint includes Sheriff): the slice imports `@vultus/shared/domain`,
      `@vultus/shared/firestore-schema`, AngularFire/Ionic (third-party), the
      `AUTH_UID` + `TMDB_SEARCH_CONFIG` tokens **by DI only** — **no other slice
      import, no `apps/mobile` deep import, no `libs/functions/sync-titles` /
      `scope:functions` import**. The client + service unit tests and the page
      component test are green (no emulator, no network, no secrets; AngularFire +
      `fetch` + `AUTH_UID` mocked).
- [ ] `pnpm nx lint mobile` passes with Sheriff: `apps/mobile` imports the
      `@vultus/mobile/search` barrel for `TMDB_SEARCH_CONFIG` (rule 3, allowed) and
      the existing `AUTH_UID` provider is unchanged.
- [ ] `pnpm nx typecheck mobile-search` and `pnpm nx typecheck mobile` pass — the
      client, service, page, and the shell's `TMDB_SEARCH_CONFIG` provider compile
      against the shared types/converter.
- [ ] `pnpm nx build mobile` passes (production configuration) — the fleshed-out
      slice lazy-loads cleanly into the shell at the `search` tab and the bundle
      stays within the existing budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green —
      mirrors CI. The affected set is `mobile-search` + `mobile`.
- [ ] **Component test** asserts the prompt / results / added / no-results /
      loading states and the Add interaction (PLAN §5: component tests for
      non-trivial UI).
- [ ] `libs/mobile/search/README.md` is rewritten to the real public surface — **no
      leftover stub/Nx scaffold text** (CLAUDE.md lib-README rule).
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json` are NOT
      modified** (existing tags + owner-only rules + single-collection read cover
      this slice).
- [ ] **Guardrail verifications (review-checked):** (a) **every Firestore write
      targets `users/{uid}/watchlist/{titleId}`** with `status: 'planned'`,
      `traktId: null`, id = stringified `tmdbId` — no `episodes`, no `title-cache`,
      no `users/{uid}` root, no other slice's data; (b) **no cross-slice / no
      `scope:functions` import** — the slice owns its TMDB client by design
      (decision 8); (c) the uid arrives via **`AUTH_UID`**, not a `ShellAuthService`
      import; (d) **no secret is committed** — `environment.ts` carries a placeholder
      key (populated locally from `.env.local`) and `environment.prod.ts` a
      `REPLACE_WITH_REAL_TMDB_API_KEY` placeholder (CI-substituted from the
      `TMDB_API_KEY` secret — that CI wiring is a follow-up, not this spec's DoD);
      `.env.local` is never read/written (see Risks on the TMDB-key-in-client caveat).
- [ ] **UI matches the Stitch design contract:** the page renders the
      poster-left result card (poster / title / muted year / neutral media-type
      badge / trailing Add control), the Emerald-only Add button, the
      checkmark/"Added" settled state, and the prompt / no-results / error empty
      states, using the **`shared/ui-kit` CSS custom properties** (no hard-coded
      hex) per the UI section. **Spec-authoring note:** the `stitch` MCP was
      unreachable in the spec session (Search screen ID not captured); the
      implementer pulls the Search screen when the MCP is reachable, reconciles any
      divergence, and records the resolved screen ID (or "MCP unreachable") in the PR.
- [ ] PR description records: the **Stitch Search screen ID** used (or that the MCP
      was unreachable and PLAN §2 tokens were applied), the exact verification
      commands, the writes-only-to-`users/{uid}/watchlist` / no-cross-slice /
      no-`scope:functions` / uid-via-`AUTH_UID` / no-secret-committed confirmations,
      and that **emulator-backed e2e is descoped to PLAN §6 item 20** (decision 9).

## Risks

- **TMDB key in a mobile client (resolved — option 2 chosen).** PLAN §5 lists the
  **TMDB API key** as a **Functions-only** secret; this slice, by the (now-confirmed)
  decision record, has the **mobile app** call TMDB **directly** with a key injected
  via environment config — which ships that key in the client bundle. The user has
  **confirmed option 2**: ship a TMDB v3 `api_key` (or v4 bearer) in the client. TMDB's
  read-only, free-tier key is low-sensitivity and easily rotated (many public web apps
  ship it); this is accepted as a deliberate, revocable v1 exposure. The proxy-through-
  a-Cloud-Function alternative (option 1) is **not** taken. The key is delivered to the
  bundle by **proper environment injection, never by committing a real value**:
  - **Local dev:** the real TMDB key lives in **`.env.local`** (gitignored, never read
    or written by slice code). `environment.ts` carries an **empty/placeholder** key;
    the implementer populates `environment.ts` from `.env.local` at dev time — manually
    or via an `ng build` pre-hook (see Scope / Implementation notes). The slice never
    touches `.env.local` programmatically.
  - **CI / production build:** the GitHub Actions workflow injects the key from the
    **`TMDB_API_KEY`** GitHub Actions secret into `environment.prod.ts` at build time
    (e.g. a `sed`/`envsubst` step replacing the `REPLACE_WITH_REAL_TMDB_API_KEY`
    placeholder before `nx build mobile --configuration=production`). **This CI wiring
    is a prerequisite/follow-up, not in this spec's DoD** — the implementer flags it in
    the PR description and the CI change is its own follow-up spec.
  The `TmdbSearchConfig.auth` union supports both a bearer token and a v3 api_key so the
  implementer picks one without reworking the client. **No real TMDB key is committed**
  (`environment.ts` placeholder/empty, `environment.prod.ts` a `REPLACE_WITH_REAL_TMDB_API_KEY`
  placeholder) and `.env.local` is never read or written by the slice.
- **Slice-local TMDB client duplicates `libs/functions/sync-titles` (intended —
  decision 8).** The duplication is **required** by vertical slice + Sheriff (a
  `scope:mobile` slice cannot import the `scope:functions` client) and is **far
  short of the 3+-slice extraction rule** (CLAUDE.md / PLAN §3). A reviewer should
  **not** ask for a `shared/` TMDB client — that would couple mobile and functions
  scopes. Stated so the instinct to DRY is resisted.
- **`AUTH_UID` can be null briefly / the slice must not import the shell.** The
  shell's uid signal is null before the anon session resolves (spec 0010), and in
  the no-emulator dev/test context sign-in may not complete. The service injects the
  `AUTH_UID` token (`@vultus/shared/domain`, provided at
  `apps/mobile/src/app/app.config.ts:67`) — **not** `ShellAuthService` (which is
  `scope:mobile` and would create a forbidden `slice:search → scope:mobile` Sheriff
  edge even type-only). `add()` guards a null uid; **search itself needs no uid** and
  works regardless. This is the same pattern spec 0011 established.
- **Already-added correctness depends on the doc-id convention.** Marking a result
  "added" matches the watchlist **doc id** to the stringified `tmdbId`. This only
  holds because **this slice writes the doc id as `String(tmdbId)`** (Data model).
  If a later slice ever writes a watchlist doc with a different id scheme for the
  same title, the added-state match would miss. v1 has one writer (this slice), so
  it holds; noted for the watchlist slice (PLAN §6 item 18) to keep the same id
  convention.
- **TMDB `search/multi` accuracy / `media_type` (PLAN §9 data-source caveat).**
  `search/multi` returns `person` results and occasionally items without a clean
  `media_type`; the client **drops** non-movie/tv and malformed results (tested).
  `search/multi` is page-1 only here (no pagination) — fine for v1's "find and add"
  flow; pagination is a later enhancement. The PLAN §9 streaming-availability
  accuracy risk is **not** in this slice's path (search returns titles, not
  providers; availability is the sync/dispatch pipeline's concern).
- **No `episodes` seeded on add (intended).** Adding a tv show creates only the
  `watchlist/{titleId}` doc; its `episodes` subcollection is populated by the sync
  engine / title-detail slice, not here. A reviewer should not expect an episode
  write on add.
- **Depends on spec 0010 + 0011 contracts being present.** This slice relies on the
  spec-0010 shell (the `search` lazy route, the AngularFire `Firestore` providers,
  the `AUTH_UID` root provider) and reuses the spec-0003/0005 `WatchlistItem` +
  converter. The implementer works in a worktree branched after those landed; if the
  `search` route, the `AUTH_UID` provider, or the AngularFire providers are absent,
  **stop and flag the missing dependency** rather than recreating shell scaffolding
  here.
- **No PLAN conflict beyond the TMDB-key caveat above.** This implements PLAN §6
  item 17 (search TMDB, view result, add-to-watchlist) using the PLAN §4
  `watchlist` shape and the spec-0010 DI contract. The only architecture tension —
  TMDB key location — was surfaced and **resolved with the user** (option 2: key in
  the client via `.env.local` locally + the `TMDB_API_KEY` GitHub Actions secret in
  CI/prod; see the TMDB-key risk above). No silent design-around.
</content>
</invoke>
