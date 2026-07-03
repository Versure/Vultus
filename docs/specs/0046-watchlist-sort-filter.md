---
number: 0046
slug: watchlist-sort-filter
title: Add sort, status filter, text search, and provider filter to the watchlist
status: done
slices: [slice:watchlist, slice:search]
scopes: [scope:mobile, scope:shared]
created: 2026-06-30
---

# Add sort, status filter, text search, and provider filter to the watchlist

## Context

Spec 0014 (done) fleshed out the watchlist slice (`libs/mobile/watchlist`):
`WatchlistPage` reads `users/{uid}/watchlist` (realtime), groups the items by
status into the fixed order **Watching → Planned → Completed → Dropped** (all
non-empty groups always shown, via the slice-local `STATUS_DISPLAY_ORDER`
constant and the pure `groupByStatus` helper), offers a **type segment** (All /
Movies / TV Shows — the pure `filterByType` helper), and renders per-card poster,
title, type badge, vote-average percentage, a streaming-provider name chip, and
a delete overlay. The page is already wired with the type filter, the status
action-sheet, delete-confirm, pull-to-refresh, empty/loading/error states, and a
guarded tap-to-detail navigation.

This spec adds **four client-side capabilities** to that existing page — sort,
status filter chips, text search, and provider filter chips — plus the small
data-model and search-slice coordination needed to support sorting by release
date. **No new lib, no new route, no service-API change** beyond the shared
field addition. All four capabilities filter/sort the **already-subscribed**
`watchlist$` stream client-side; no new Firestore queries are issued.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Sort within groups.** A sort button in the toolbar (`IonButton`,
   `swap-vertical-outline` icon) opens an `IonActionSheet` with six options:
   Title A→Z, Title Z→A, Date added (newest first), Date added (oldest first),
   Release date (newest first), Release date (oldest first). Sort reorders cards
   **within** each status group; the status groups themselves stay in
   `STATUS_DISPLAY_ORDER`. **Default: Date added, newest first.** Sort state is
   component-local. A pure slice-local `sortItems(items, sort)` helper is added
   alongside the existing `groupByStatus` / `filterByType`.

2. **Single-status filter chips.** A horizontal row of filter chips below the
   type segment: an "All" chip plus one chip per **non-empty** status with an
   item count (e.g. "Watching 3"). Selecting a status chip narrows the view to
   that **one** status group only; "All" (default) shows every group. Combines
   with the type segment (both apply). Component-local state. Chips consume the
   `--vultus-status-*` color tokens from `shared/ui-kit`.

3. **Text search bar.** An `IonSearchbar` below the type segment + status chips.
   Client-side, **case-insensitive substring** match on `WatchlistItem.title`,
   **debounced 200ms**. Empty query shows all. Component-local state.

4. **Provider filter chips.** A horizontal row of provider-name chips below the
   search bar, derived from the already-loaded availability data aggregated
   across all displayed items. **Multi-select, OR logic** — show titles with ANY
   selected provider. **Default: none selected (= show all).** Provider chips are
   **hidden when no availability data is loaded.** Component-local state. New pure
   helper `getAvailableProviders(items, availabilityMap)` → `string[]` (unique,
   sorted).

5. **Release-date sort field (shared addition).** Sort options 5/6 need a
   `releaseDate`. Add `releaseDate?: string | null` (ISO 8601 date string) to
   `WatchlistItem` in `libs/shared/domain` — **optional + nullable**, the same
   backward-compat pattern as `posterPath` / `voteAverage` (spec 0014). Add the
   same field to `WatchlistItemReadData` / `WatchlistItemWriteData` and both
   converters (pass-through, `?? null`). The **search slice** writes `releaseDate`
   (from `release_date` for movies / `first_air_date` for TV) when adding a
   title, alongside the existing `posterPath` / `voteAverage` writes.

6. **Persistence: in-session only** — no localStorage, no Firestore. All
   filter/sort state resets on app restart.

7. **All filtering client-side** over the already-subscribed `watchlist$`
   stream. No new Firestore queries, no new index.

8. **Test gate: unit (pure helpers) + component (filter/sort UI states).** No new
   e2e flows (consistent with spec 0014 decision 6).

9. **No new lib, no new route.** Changes live in `libs/mobile/watchlist` (UI +
   new helpers) plus the `scope:shared` field addition and the search-slice
   `releaseDate` write coordination.

10. **Stitch screen:** reuse the same "Watchlist - Vultus" screen
    (`projects/13590348714018893783`) spec 0014 referenced. The new sort/filter
    controls may not exist in that screen — in that case derive them from the
    design-system tokens (`docs/design/vultus-design-system.md`) and **flag for
    human visual verification**.

11. **Filter composition order:** type → status → text search → provider → sort.
    All composed client-side over the raw `watchlist$` stream.

12. **Provider availability map:** `WatchlistService` gets **no new method** —
    `availability$` is unchanged. The page already subscribes to
    `availability$(tmdbId, region)` once per tmdbId (memoized in `providerCache`).
    For the provider filter the page builds a local `availabilityMap: Map<number,
string[]>` (tmdbId → all provider names) **from that same memoized
    subscription** — see "Provider stream reconciliation" in Public types / APIs.
    No second Firestore Listen channel per card is opened. The
    `getAvailableProviders` helper takes this map to derive the chip list.

## Scope

In scope:

- Add `releaseDate?: string | null` to the shared `WatchlistItem` + its
  read/write data shapes + both converters + the round-trip test.
- Thread `releaseDate` through the search slice's TMDB normalization
  (`SearchResult` + `searchMulti`) and write it on `add()`.
- Add two pure slice-local helpers to `libs/mobile/watchlist`:
  `sortItems(items, sort)` and `getAvailableProviders(items, availabilityMap)`.
- Extend `WatchlistPage`: a toolbar sort button + sort action-sheet; a
  status-filter chip row; an `IonSearchbar`; a provider-filter chip row; compose
  all four into the existing `vm$` pipeline (type → status → search → provider →
  sort).
- Update the watchlist unit + component tests, the barrel (no surface change
  expected — verify), and the watchlist + shared READMEs as needed.

Out of scope:

- **New Firestore query / index** — all four operations are client-side over the
  already-subscribed stream (decision 7). `firestore.indexes.json` is NOT touched.
- **Persisting filter/sort state** across restarts (decision 6) — no localStorage,
  no Firestore preference doc.
- **Sort across status groups / regrouping** — groups stay in
  `STATUS_DISPLAY_ORDER`; sort only reorders within a group (decision 1).
- **New `WatchlistService` methods** — the provider filter reuses the existing
  per-card `availability$` subscriptions (decision 12).
- **Any e2e flow** (decision 8) and any `ci.yml` / `playwright.config.ts` change.
- **`title-detail` route changes** — the existing guarded `navigateToDetail`
  (with the spec-0042/0043 `?type` hint) is unchanged.
- **Backfilling `releaseDate` on existing watchlist docs** — the field is
  optional/nullable; pre-existing docs sort to the end for release-date sort
  (see Risks). No migration.

## Affected slices & Sheriff tags

| Path                               | Scope / slice tag                 | Change                                                             |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `libs/shared/domain/src`           | `scope:shared`                    | add `releaseDate?: string \| null` to `WatchlistItem`              |
| `libs/shared/firestore-schema/src` | `scope:shared`                    | add field to read/write data + both converters + round-trip test   |
| `libs/mobile/watchlist/src`        | `scope:mobile`, `slice:watchlist` | new pure helpers + `WatchlistPage` sort/filter UI + tests + README |
| `libs/mobile/search/src`           | `scope:mobile`, `slice:search`    | write `releaseDate` when adding a title (additive)                 |

**No cross-slice import.** `slice:watchlist` and `slice:search` do **not** import
each other; the only shared touchpoint is the additive `WatchlistItem.releaseDate`
field in `scope:shared`, which both slices already import. The two new pure
helpers (`sortItems`, `getAvailableProviders`) have a **single consumer**
(`WatchlistPage`) — they stay slice-local in `libs/mobile/watchlist`, well short
of the "extract only at 3+ slices" rule (PLAN §3 / CLAUDE.md). `STATUS_DISPLAY_ORDER`
(already a slice-local constant in `watchlist.service.ts`) is reused for the
status-filter chip order — do **not** re-derive from `WATCH_STATUSES` (whose
order is `watching, completed, dropped, planned`, the wrong display order). The
uid continues to come from the `scope:shared` `AUTH_UID` token — never from an
`apps/mobile` import.

## Data model touchpoints

PLAN §4 `users/{uid}/watchlist/{titleId}` gains **one new denormalized field**:

| PLAN §4 path                      | Access                                   | Field                                                 |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}` | **write** (search), **read** (watchlist) | `releaseDate?: string \| null` — ISO 8601 date string |

**Binding: `releaseDate` MUST be optional (`?`) and nullable**, exactly like
`posterPath` / `voteAverage` (spec 0014), so documents written before this spec
(and any concurrent search write not yet updated) remain valid `WatchlistItem`s.
A search-added title written before the field lands, or one whose TMDB result has
no release/air date, simply has `releaseDate: null` and sorts to the **end** for
release-date sort (see Public types / APIs and Risks).

Companion edits in `shared/firestore-schema`:

- `WatchlistItemReadData` / `WatchlistItemWriteData` (`data-types.ts`) gain
  `releaseDate?: string | null` — a **non-timestamp** field (it is a plain ISO
  date string, not a Firestore Timestamp), so it passes straight through with
  **no `Date` coercion** (unlike `addedAt`).
- `watchlistItemToData` maps `releaseDate: item.releaseDate ?? null` (never emit
  `undefined`); `dataToWatchlistItem` passes it through (`data.releaseDate ?? null`).
- `firestore-schema.spec.ts` round-trip assertions extend to cover `releaseDate`
  present and absent/null.

**No `firestore.rules` change** (owner-only read/write on `users/{uid}/**`
already covers the field — verify and record in the PR). **No
`firestore.indexes.json` change** (no new compound query — sort/filter is
client-side, decision 7).

## Public types / APIs

### Shared domain (additive)

```ts
// libs/shared/domain/src/lib/documents.ts — add to WatchlistItem
export interface WatchlistItem {
  type: TitleType;
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
  posterPath?: string | null;
  voteAverage?: number | null;
  releaseDate?: string | null; // NEW — ISO 8601 date (movie release_date / tv first_air_date); null when unknown
}
```

### Search slice (additive)

```ts
// libs/mobile/search/src/lib/tmdb-search.client.ts — add to SearchResult
export interface SearchResult {
  // ...existing fields...
  releaseDate: string | null; // NEW — raw TMDB release_date (movie) / first_air_date (tv); null when unknown
}
```

`searchMulti` already reads `r.release_date` / `r.first_air_date` to compute
`year`; map the same raw value into `releaseDate` (movie → `r.release_date`, tv →
`r.first_air_date`, `?? null`; an empty string coerces to `null`). `SearchService.add`
then sets `releaseDate: result.releaseDate ?? null` on the `WatchlistItem` it
writes (alongside the existing `posterPath` / `voteAverage`). No other search
behavior changes.

### Watchlist slice — new pure helpers (slice-local, unit-tested)

```ts
// libs/mobile/watchlist/src/lib/watchlist.service.ts (or a sibling helpers file)

/** The six sort modes the toolbar offers. Default is 'addedDesc'. */
export type WatchlistSort =
  | 'titleAsc'
  | 'titleDesc'
  | 'addedDesc' // newest first (DEFAULT)
  | 'addedAsc' // oldest first
  | 'releaseDesc' // newest release first
  | 'releaseAsc'; // oldest release first

/**
 * Pure, stable sort of a single status group's items. Does NOT mutate the input
 * (return a copy). Binding tie-breaks:
 * - title sorts: case-insensitive locale compare on `title`.
 * - added sorts: compare `addedAt` (ISO string) ascending/descending.
 * - release sorts: items with `releaseDate` null/absent sort to the END in BOTH
 *   directions (a missing date is never "newest" or "oldest"); present dates
 *   compare by ISO string.
 */
export function sortItems(
  items: WatchlistItem[],
  sort: WatchlistSort,
): WatchlistItem[];

/**
 * Unique, sorted (case-insensitive A→Z) list of provider names present across
 * the given items, looked up by tmdbId in the availability map. Items with no
 * entry (or an empty array) contribute nothing. Returns [] when the map yields
 * no providers (→ the page hides the provider chip row).
 *
 * Binding: the page calls this with the **post-type-and-search-filtered** items
 * (after type + text-search filtering, but BEFORE the status and provider
 * filters and before sort). The chips therefore reflect what the user can
 * actually reach, and the chip set stays consistent with the visible list. The
 * composition order is: type → search → [derive provider chips from this set] →
 * status → provider → sort.
 */
export function getAvailableProviders(
  items: WatchlistItem[],
  availabilityMap: Map<number, string[]>,
): string[];
```

`WatchlistService`'s public surface is **unchanged** — no new method (decision
12). `groupByStatus`, `filterByType`, `STATUS_DISPLAY_ORDER`, `STATUS_LABELS`,
`StatusGroup` remain as-is and are reused.

### `WatchlistPage` composition (binding behavior, not exact code)

The existing `vm$` pipeline is `typeFilter$ → watchlist$(uid, type) →
groupByStatus`. Extend it so the full client-side composition order is
**type → status → text search → provider → sort** (decision 11). Concretely:

- Add component-local reactive state for: `selectedStatus: WatchStatus | null`
  (null = All), `searchTerm$` (debounced 200ms — reuse the existing `BehaviorSubject`
  pattern or `IonSearchbar`'s `ionInput` + a debounce), `selectedProviders:
Set<string>`, and `selectedSort: WatchlistSort` (default `'addedDesc'`).
- The vm pipeline applies, **in order**: the type filter (existing
  `watchlist$(uid, type)` re-subscribe), then over the emitted `WatchlistItem[]`:
  text-search filter (case-insensitive `title.includes`), then **derive the
  provider-chip set** via `getAvailableProviders(<type+search-filtered items>,
availabilityMap)` (so the chips reflect exactly what type+search left visible),
  then the provider filter (keep an item if `selectedProviders` is empty OR the
  item's providers — looked up in `availabilityMap` — intersect
  `selectedProviders`), then `groupByStatus`, then narrow to `selectedStatus` if
  set (drop the other groups), then `sortItems` **per group**. Concrete order:
  **type → search → [provider chips derived here] → status → provider → sort.**
- The status-chip counts reflect the **type + search + provider** filtered set
  (i.e. the same set `groupByStatus` sees), so a chip's count matches what
  selecting it shows. The "All" chip is always present; per-status chips render
  only for non-empty (post-filter) groups.
- **Provider stream reconciliation.** Refactor the existing `providerCache` —
  today `Map<number, Observable<string | null>>` (actually keyed by
  `` `${tmdbId}|${region}` ``) producing only the **first** provider name
  (`a?.providers[0]?.name`) — to cache `Observable<string[]>`: the **full** list
  of provider names for a tmdbId, `availability$(tmdbId, region).pipe(map(a =>
a?.providers.map(p => p.name) ?? []), shareReplay(...))`. This is a **pure
  internal refactor of the same memoized subscription**: `availability$` is still
  called **once per tmdbId** and memoized via `shareReplay`, so **no second
  Firestore Listen channel per card is opened**. `WatchlistService.availability$`
  is unchanged.
  - The existing **per-card provider badge** derives its single display name from
    the same cached stream: `providerNames$(item, region).pipe(map(names =>
names[0] ?? null))` (preserving today's `getProviderName$` behavior — first
    name only — on top of the widened cache).
  - The **`availabilityMap: Map<number, string[]>`** consumed by
    `getAvailableProviders` and the provider filter is built by combining the
    active per-item `Observable<string[]>` streams (one per displayed item) into a
    single `combineLatest`-derived signal/observable the page maintains as the
    displayed item set changes; each emission updates the map entry for its
    tmdbId. The provider-chip row and provider filter are driven from this map.
    **Hide the provider-chip row when `getAvailableProviders(...)` returns `[]`**
    (decision 4). No new Firestore reads — only the refactored memoized cache.

Expose the new interactive entry points as **public methods** (bound from the
template, invokable by the component test without simulating gestures), mirroring
the existing `openStatusSheet`: e.g. `openSortSheet()`, `onSortSelected(sort)`,
`onStatusChipClick(status | null)`, `onSearchInput(term)`,
`toggleProvider(name)`.

## UI / Stitch screen refs

This is a `scope:mobile` slice. The base layout is the existing "Watchlist -
Vultus" Stitch screen in project **`projects/13590348714018893783`** that spec
0014 implemented. The implementer **must** pull it via the `stitch` MCP:
`list_screens` → find **"Watchlist - Vultus"** → `get_screen`, then fetch the
screen's `htmlCode.downloadUrl` as **raw HTML** (a plain GET / `Invoke-WebRequest`,
**not** WebFetch) and read the Tailwind config + element markup; also grab
`screenshot.downloadUrl` for a visual compare. **Reference the screen ID in the
PR.** Retry on MCP failure (project memory: the MCP is reachable from the
orchestrator — a sub-agent "unreachable" is a retry, not a reason to ship
token-only UI). If the screen HTML genuinely can't be read, this UI task is
**blocked / `needs-human`** — do not fall back to tokens silently.

> **New controls likely absent from the Stitch screen.** The sort button, status
> chips, search bar, and provider chips extend beyond what the 0014 screen
> shows. For any control with **no Stitch counterpart**, derive it from the
> design-system tokens below (the authoritative set lives at
> `docs/design/vultus-design-system.md` — do **not** reprint hex values in code
> from memory; consume the `--vultus-*` / `--ion-*` vars `theme.scss` exposes)
> and **flag those controls for human visual verification** in the PR (a green
> build does not prove the UI looks right — CLAUDE.md UI-fidelity rule).

Token references (cite `docs/design/vultus-design-system.md`, consume
`shared/ui-kit` vars — do not transcribe hex):

- **Filter / status / provider chips** — the design system's **Filter / Tab
  Pills** pattern: a **flex row of individually-rounded `full`-radius pills**
  (not a segmented container). The existing type filter already implements this
  as `.filter-pill` / `.filter-pill.active` in `watchlist.page.scss` — **reuse
  that pill style** for the new chip rows for visual consistency.
  - Active pill: `primary` fill (`#4edea3`) + `on-primary` text (`#003824`).
  - Inactive pill: `surface-container-high` (`#222a3d`) fill +
    `on-surface-variant` text (`#bbcabf`).
  - Type role: pill label = **`label-md`** (12/600, +0.05em). Count suffix on a
    status chip uses the same `label-md`.
  - **Status chips** use the `--vultus-status-*` tokens for their status accent
    (Watching `status-watching`, Planned `status-planned`, Completed
    `status-completed`, Dropped `status-dropped`) — match the per-status color
    already applied to the section headers / `.status-chip` in 0014. Order the
    status chips by `STATUS_DISPLAY_ORDER`.
- **Search bar** — the design system's **Search Bar** component: `surface-container`
  (`#171f33`) fill, **`0.5rem` (`rounded.DEFAULT`) radius**, magnifying-glass icon
  left, placeholder text in `on-surface-variant`. **On focus, the border
  transitions to `primary` Emerald.** Use `IonSearchbar` styled to these tokens
  (override the Ionic search vars rather than re-theming from scratch); placeholder
  e.g. "Search your watchlist".
- **Sort button** — a toolbar `IonButton fill="clear"` in `ion-buttons slot="end"`
  next to the existing refresh/bell/account buttons, icon `swap-vertical-outline`,
  `aria-label="Sort watchlist"`, opening the sort `IonActionSheet`. Icon color
  follows the toolbar icon color already in use.
- **Layout / spacing** — the chip rows and search bar stack between the existing
  `.type-filter` row and the grouped list, each separated by the **8px grid**
  (`spacing.sm` 8px between sibling rows, `spacing.md` 16px before the list),
  with the **same 16px side margins (`margin-mobile`)** as the type filter so all
  filter rows are left-aligned consistently. Chip rows scroll horizontally if
  they overflow (no wrap), like the type filter.
- **Inter web-font** is already loaded by the shell (spec 0010) — no font-loading
  change; just keep the type roles above.

Per-state acceptance contract (tick each — feature-reviewer + human):

- [ ] **Status chip — default:** "All" chip present and **active** on first
      render; per-status chips render only for non-empty (post-type/search/provider)
      groups, each showing its count; inactive chips use the inactive pill style.
- [ ] **Status chip — selected:** clicking a status chip makes it active (primary
      fill), narrows the list to that one group; clicking "All" restores all groups.
- [ ] **Search bar — default / typing / clear:** default placeholder visible; typing
      filters case-insensitively after the **200ms** debounce; clearing restores the
      full (other-filters-applied) list. **Focus** state shows the primary-Emerald
      border transition.
- [ ] **Provider chips — hidden / shown / multi-select:** the row is **hidden** when
      no availability data is loaded (`getAvailableProviders` → `[]`); when shown,
      chips are unselected by default; selecting two providers shows titles matching
      **either** (OR); deselecting all restores the full list.
- [ ] **Sort button / sheet:** the toolbar sort button opens the action sheet with
      the six options + Cancel; the **default** ordering is Date-added-newest;
      selecting an option reorders **within each group** while group order stays
      Watching → Planned → Completed → Dropped; release-date sorts push
      null-`releaseDate` items to the end.
- [ ] Each new control's **default / focus / hover / active / disabled** states
      match the design tokens; controls absent from the Stitch screen are noted as
      token-derived and visually verified by a human.

## Implementation task graph

Task 1 is the shared prerequisite. Tasks 2 and 3 touch **disjoint** file trees
(`libs/mobile/search/**` vs `libs/mobile/watchlist/**`) and may run **in
parallel** after task 1. Task 4 extends the page (depends on 3). Task 5 finishes
tests + README (depends on 2–4).

### Task 1 — [sequential] Add `releaseDate` to shared `WatchlistItem` + converters

Prerequisite for all (both slices import the widened type). frontend-engineer /
domain.

- `libs/shared/domain/src/lib/documents.ts`: add `releaseDate?: string | null`
  to `WatchlistItem` (optional + nullable — binding).
- `libs/shared/firestore-schema/src/lib/data-types.ts`: add `releaseDate?: string
| null` to `WatchlistItemReadData` and `WatchlistItemWriteData` (pass-through,
  **no `Date` coercion** — it is a plain ISO string, not a Timestamp).
- `libs/shared/firestore-schema/src/lib/converters.ts`: map `releaseDate` in
  `watchlistItemToData` (`?? null`, never `undefined`) and `dataToWatchlistItem`
  (`?? null`).
- `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`: extend the
  `WatchlistItem` round-trip test to cover `releaseDate` set and null/absent.
- Update `libs/shared/domain/README.md` / `libs/shared/firestore-schema/README.md`
  **only if** they enumerate `WatchlistItem`'s fields.
- **File manifest:** `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/firestore-schema/src/lib/data-types.ts`,
  `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/domain/README.md`, `libs/shared/firestore-schema/README.md`.

### Task 2 — [parallel] Write `releaseDate` from the search slice

Depends on task 1. Additive — same pattern as `posterPath` / `voteAverage`.
frontend-engineer.

- `tmdb-search.client.ts`: add `releaseDate: string | null` to `SearchResult`;
  in `searchMulti`'s `.map`, set `releaseDate: (isMovie ? r.release_date :
r.first_air_date) ?? null` (empty string → `null`).
- `search.service.ts`: in `add()`, set `releaseDate: result.releaseDate ?? null`
  on the `WatchlistItem` it writes.
- Extend `tmdb-search.client.spec.ts` (releaseDate normalization for movie/tv and
  the null/empty case) and `search.service.spec.ts` (the written item includes
  `releaseDate`).
- Update `libs/mobile/search/README.md` only if it enumerates the written
  watchlist fields.
- **File manifest:** `libs/mobile/search/src/lib/tmdb-search.client.ts`,
  `libs/mobile/search/src/lib/tmdb-search.client.spec.ts`,
  `libs/mobile/search/src/lib/search.service.ts`,
  `libs/mobile/search/src/lib/search.service.spec.ts`,
  `libs/mobile/search/README.md`.

### Task 3 — [parallel] Add pure helpers `sortItems` + `getAvailableProviders`

Depends on task 1. Slice-local helpers in `libs/mobile/watchlist`.
frontend-engineer. (Disjoint from task 2's `libs/mobile/search/**` manifest.)

- Add `WatchlistSort` type + `sortItems(items, sort)` and
  `getAvailableProviders(items, availabilityMap)` to `watchlist.service.ts`
  (alongside the existing `groupByStatus` / `filterByType`) — or a sibling
  `watchlist.helpers.ts` (implementer's choice; keep slice-local). Export from
  the lib barrel **only if** the page imports them across the file boundary;
  otherwise keep them module-local.
- Add `sortItems` + `getAvailableProviders` unit tests (see Test plan).
- **File manifest:** `libs/mobile/watchlist/src/lib/watchlist.service.ts` (and,
  if the implementer separates them, `libs/mobile/watchlist/src/lib/watchlist.helpers.ts`),
  `libs/mobile/watchlist/src/lib/watchlist.service.spec.ts` (or a
  `watchlist.helpers.spec.ts`).

> Note: Task 3 writes `watchlist.service.ts` and Task 4 writes `watchlist.page.*`.
> If the implementer keeps the helpers in `watchlist.service.ts` (which Task 4
> does not edit) and the page tests in `watchlist.page.spec.ts`, Tasks 3 and 4
> touch disjoint files and Task 4 can follow without conflict. If the helpers
> instead land in a `watchlist.helpers.ts`, that file is also disjoint from
> Task 4's manifest. Either way Task 4 imports Task 3's helpers, so **Task 4 is
> sequential after Task 3.**

### Task 4 — [sequential] Extend `WatchlistPage` with the four controls

Depends on task 3 (imports `sortItems` / `getAvailableProviders`).
frontend-engineer.

- Add component-local state + public methods (`openSortSheet`, `onSortSelected`,
  `onStatusChipClick`, `onSearchInput`, `toggleProvider`) and fold the four
  filters + sort into the `vm$` pipeline in the order type → search → [derive
  provider chips] → status → provider → sort (see Public types / APIs).
- **Refactor `providerCache` from `Observable<string | null>` to
  `Observable<string[]>`** (full provider-name list per tmdbId) and build the
  `availabilityMap: Map<number, string[]>` by combining the active per-item
  `string[]` streams (see "Provider stream reconciliation" in Public types /
  APIs). The per-card badge keeps its first-name display by mapping
  `names[0] ?? null` over the same cached stream. **No new Firestore reads** —
  `availability$` is still called once per tmdbId and memoized.
- Template (`watchlist.page.html`): add the sort `IonButton` to the toolbar, the
  sort `IonActionSheet`, the status-chip row, the `IonSearchbar`, and the
  provider-chip row (hidden when no providers). Reuse the `.filter-pill` style.
- Styles (`watchlist.page.scss`): style the new rows per the UI section
  (token-derived; consume `shared/ui-kit` vars). Add the `IonSearchbar` focus →
  primary-border override and the `--vultus-status-*` accents on status chips.
- Register any new ionicons (`swapVerticalOutline`, `searchOutline` if needed).
- **Keep the selector `lib-watchlist`** and all existing behavior (type filter,
  delete, status sheet, pull-to-refresh, detail nav).
- **File manifest:** `libs/mobile/watchlist/src/lib/watchlist.page.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.page.html`,
  `libs/mobile/watchlist/src/lib/watchlist.page.scss`.

### Task 5 — [sequential] Watchlist component tests + barrel/README

Depends on tasks 2–4. frontend-engineer / qa-runner.

- Update `watchlist.page.spec.ts` for the new control states (see Test plan).
- Verify `src/index.ts` (likely unchanged); add the helper export only if Task 3
  required it.
- Update `libs/mobile/watchlist/README.md` to mention the new sort/filter
  capabilities + the slice-local helpers — no leftover stub text.
- **File manifest:** `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/src/index.ts`, `libs/mobile/watchlist/README.md`.

(No `apps/mobile`, `sheriff.config.ts`, `firestore.rules`,
`firestore.indexes.json`, `ci.yml`, `playwright.config.ts`, or `scope:functions`
file is touched.)

## Test plan

Per the PLAN §5 pyramid: **unit** (the new pure helpers + the search write) and
**component** (the page's new control states). All Firebase access **mocked** (no
emulator, no network, no secrets). **No e2e flows** (decision 8).

**Unit — watchlist helpers (`sortItems`, `getAvailableProviders`; Vitest):**

- `sortItems` — `titleAsc` / `titleDesc` sort case-insensitively; `addedDesc`
  (default) newest-first and `addedAsc` oldest-first by `addedAt`; `releaseDesc` /
  `releaseAsc` order by `releaseDate` and push **null/absent `releaseDate` items
  to the END in both directions**. Assert the input array is **not mutated**
  (returns a copy).
- `getAvailableProviders` — returns the **unique, A→Z (case-insensitive) sorted**
  union of provider names across items via the map; items with no map entry or an
  empty array contribute nothing; returns `[]` when the map is empty (drives the
  hidden chip row).

**Unit — search slice (`tmdb-search.client.spec.ts`, `search.service.spec.ts`):**

- `searchMulti` maps `release_date` (movie) / `first_air_date` (tv) into
  `releaseDate`, and `null` when the raw value is absent/empty.
- `SearchService.add` writes a `WatchlistItem` whose `releaseDate` equals the
  result's `releaseDate` (and `null` when absent) — assert via the mocked
  `setDoc` payload / `watchlistItemToData` output.

**Unit — shared converters (`firestore-schema.spec.ts`):**

- `WatchlistItem` round-trips `releaseDate` set and null/absent; the write
  converter emits `null` (never `undefined`) when the field is absent.

**Component (`watchlist.page.spec.ts`, Angular TestBed + Ionic setup;
`WatchlistService` mocked):**

- **Status filter:** with a mixed-status stream, the "All" chip shows all groups;
  clicking a status chip narrows to that one group; chip counts match the visible
  cards; only non-empty groups render a chip.
- **Text search:** invoking `onSearchInput('term')` filters cards
  case-insensitively (after debounce — fake timers); an empty term restores the
  full list.
- **Provider filter:** with an `availabilityMap` yielding providers, the chip row
  renders; `toggleProvider` selecting two providers shows items matching either
  (OR); the row is **absent** when `getAvailableProviders` returns `[]`.
- **Sort:** invoking `openSortSheet()` opens the action sheet; `onSortSelected`
  reorders within each group while group order stays Watching → Planned →
  Completed → Dropped; default ordering is Date-added-newest.
- **Composition + regression:** the existing type-segment / empty / loading /
  skeleton / delete-confirm / status-action-sheet behaviors still pass.
- **Provider-badge mock shape (regression):** the existing per-card provider
  badge test mocks the availability stream. With `providerCache` refactored from
  `Observable<string | null>` to `Observable<string[]>`, any test that mocks the
  single-name stream directly must update its mock from `string | null` to
  `string[]` (the badge now maps `names[0] ?? null` over the widened stream). The
  rendered badge text is unchanged.

**e2e:** **No e2e flows required** — this is a client-side filter/sort extension
of an existing page with no new route or backend change, and the project gate for
the watchlist slice is unit + component (decision 8, consistent with spec 0014
decision 6). No new Playwright spec; no `apps/mobile-e2e` / `playwright.config.ts`
/ `ci.yml` change.

## Definition of done

Green gate is **typecheck + lint/Sheriff + unit + component + build** (what CI
runs); e2e is not required (decision 8).

- [ ] `pnpm nx run-many -t lint test typecheck -p mobile-watchlist mobile-search
shared-domain shared-firestore-schema` passes **with Sheriff active**: the
      additive `releaseDate` field compiles in both slices; **no cross-slice import**
      (watchlist ↔ search), no `apps/mobile` deep import, no `scope:functions`
      import; the new helpers stay slice-local; the uid is obtained only via
      `AUTH_UID`.
- [ ] `pnpm nx build mobile` passes (production config) — the extended page
      lazy-loads cleanly and the bundle stays within budget.
- [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors CI
      (affected: `mobile-watchlist`, `mobile-search`, `shared-domain`,
      `shared-firestore-schema`, `mobile`).
- [ ] `releaseDate` is **optional + nullable** in `WatchlistItem` and both data
      shapes; the `firestore-schema` round-trip test covers set + null/absent; the
      write converter never emits `undefined`.
- [ ] **Component test** asserts the four new control states (status filter, text
      search, provider filter, sort) plus the preserved 0014 behaviors.
- [ ] **Unit tests** cover `sortItems` (all six modes + null-`releaseDate`
      tail + no-mutation) and `getAvailableProviders` (unique/sorted/empty), the
      search `releaseDate` normalization + write.
- [ ] `libs/mobile/watchlist/README.md` (and `libs/mobile/search/README.md` /
      shared READMEs if they enumerate fields) updated — no stub/Nx scaffold text.
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`,
      `ci.yml`, `playwright.config.ts` are NOT modified** — recorded in the PR
      (no new query/index; client-side filter/sort only).
- [ ] **Guardrail verifications (review-checked):** (a) no new Firestore read or
      write — the provider filter reuses existing per-card `availability$`
      subscriptions; (b) all filter/sort state is **in-session component-local**
      (no localStorage / Firestore persistence); (c) no cross-slice import; (d) no
      secret read/written.
- [ ] PR records: the **Stitch Watchlist screen ID** used (or MCP-unreachable +
      retried + token-derived), which new controls are **token-derived / flagged for
      human visual verification**, and the cross-spec coordination note (the search
      slice now writes `releaseDate`; pre-existing docs without it sort to the end).

## Risks

- **Cross-spec coordination on `releaseDate` (mirrors spec 0014's
  `posterPath`/`voteAverage`).** The field is added **optional + nullable** so
  existing watchlist docs — and any search write not yet updated — stay valid.
  Task 1 (shared) and Task 2 (search write) land in the **same PR** here, so
  search-added titles get `releaseDate` immediately; **pre-existing** watchlist
  docs (added before this spec) have no `releaseDate` and **sort to the end** for
  release-date sort until they are re-added or a future backfill runs. Do **not**
  make the field required (would break older docs) and do **not** reach into the
  search slice from watchlist (forbidden cross-slice import) — the only shared
  touchpoint is the `scope:shared` field.

- **`IonSearchbar` debounce vs `ionInput`.** `IonSearchbar` has its own
  `debounce` input. Use **either** the component's `debounce="200"` **or** an
  RxJS `debounceTime(200)` over an event subject — not both (double-debounce).
  Pick one and assert the 200ms behavior in the component test with fake timers.
  Default-export: clearing the searchbar must reset to the full (other-filters)
  list, not leave a stale term.

- **Provider chip set is built from realtime per-card availability.** The
  `availabilityMap` fills in asynchronously as each card's `availability$`
  resolves, so the provider-chip row may **appear/expand after first render**;
  this is acceptable (no flicker beyond chips populating). The existing
  `providerCache` keeps the per-key listener stable across change detection —
  reuse it; do **not** open a second Listen channel per card for the filter.
  Deselecting a provider that subsequently disappears from the map must not
  strand a hidden filter — recompute `selectedProviders ∩ available` so a stale
  selection cannot hide everything.

- **`providerCache` type refactor (badge test mock).** Today `providerCache` is
  `Observable<string | null>` (first provider name only); the filter needs the
  full `string[]` per title, and decision 12 forbids a second Listen channel.
  These reconcile by **widening the same memoized cache** to
  `Observable<string[]>` (all names) and mapping `names[0] ?? null` for the
  existing badge — `availability$` is still called once per tmdbId and memoized,
  so **no second channel is opened**. This is a **pure internal change**;
  `WatchlistService.availability$`'s signature is **unchanged**. Consequence: the
  badge test must update its mock from `string | null` to `string[]` (see Test
  plan). There is no first-name-only source to derive the chip `string[]` from,
  so the cache widening — not a parallel new stream — is the binding approach.

- **Sort stability / locale.** Use a stable comparator (return a copy; never
  mutate the stream's array — Angular re-renders from the same reference).
  Title sort is case-insensitive locale compare; date sorts compare ISO strings
  (lexicographic ISO order == chronological order, safe for full ISO timestamps).

- **UI fidelity for token-derived controls.** The sort button, status chips,
  search bar, and provider chips likely have **no Stitch counterpart** (decision
  10). They are token-derived and must be **flagged for human visual
  verification** — a green typecheck/lint/test/build does not prove they look
  right (CLAUDE.md). Reuse the existing `.filter-pill` style for chips so they
  match the type filter exactly.

- **No PLAN conflict.** This extends PLAN §6 item 18 (the watchlist) with
  client-side sort/filter over the existing `users/{uid}/watchlist` stream and one
  additive PLAN §4 field (`releaseDate`), issuing no new query/index and adding no
  cross-slice edge. All four capabilities and the in-session-only persistence are
  the locked architect decisions, not silent departures.
