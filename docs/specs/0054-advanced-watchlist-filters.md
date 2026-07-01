---
number: 0054
slug: advanced-watchlist-filters
title: Restyle the watchlist filter/search controls to the Advanced Watchlist Stitch design
status: done
slices: [slice:watchlist]
scopes: [scope:mobile]
created: 2026-07-01
---

# Restyle the watchlist filter/search controls to the Advanced Watchlist Stitch design

## Context

The watchlist tab (`libs/mobile/watchlist`) already offers a full set of
client-side filter/sort/search controls, built by spec
[0014-watchlist-slice.md](./0014-watchlist-slice.md) (`status: done` — grouped
status list, type filter, provider badges, delete, status action-sheet) and spec
[0046-watchlist-sort-filter.md](./0046-watchlist-sort-filter.md) (`status: done`
— the six-mode sort, status-filter chips, text search, and multi-select provider
filter). Those two specs define the **business rules and composition semantics**
that this spec preserves verbatim.

The Stitch design has since evolved into the **"Advanced Watchlist - Vultus"**
screen, which reorganizes the same controls into a cleaner layout and folds the
sort action-sheet and inline provider chips into a **single combined bottom
sheet** opened from a `tune` button inside the search bar. This spec is a
**UI restyle / reorganization only** — a presentation-layer change. It does
**not** add or change filtering logic, composition order, state management, or
Firestore access. The one behavioral addition is **live count badges** on the
status chips, computed client-side from the already-grouped data (no new reads,
no new fields).

Intended outcome: opening the Watchlist tab shows, top to bottom, a **status
filter chip row** (All / Watching / Planned / Completed, each with a live count),
then a **type tab row** (All / Movies / TV Shows) restyled as underline tabs
(no longer pills), then a **search bar with a single `tune` trigger** at its
right edge that opens a **"Sort & Filter" bottom sheet** containing the sort
options and the provider filter — then the existing grouped status sections and
cards, unchanged. Which items show, and how filters/sort compose, is identical to
today's behavior.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **One combined trigger, one bottom sheet.** The sort options **and** the
   provider filter share ONE `tune`-icon button (inside the search bar's right
   edge) and ONE bottom sheet ("Sort & Filter"). This matches the Stitch screen
   exactly — **not** two separate buttons, despite the source issue's wording.
   The old **toolbar** sort `IonButton` (`swap-vertical-outline`) and the old
   `IonActionSheet` sort UI are **removed**; the inline provider-chip row moves
   into the sheet's Provider section.
2. **Live status counts.** Each status chip shows a count badge (e.g.
   "All 5", "Watching 3", "Planned 2", "Completed 0"), computed client-side from
   the existing grouped-by-status data. **No new Firestore reads/fields.** Unlike
   spec 0046 (where per-status chips rendered only for non-empty groups), the
   **four status chips render unconditionally** in the fixed order
   All → Watching → Planned → Completed, each with its count (0 shown, not
   hidden) — see decision 5 and the UI section. (The "Dropped" status has no chip
   in this design; see Risks.)
3. **Sort direction = tap-to-toggle.** The Stitch sheet shows sort as a single
   chip row (Date Added / Name / Rating) with no explicit asc/desc control. The
   **binding decision**: tapping an inactive sort chip selects it in its
   **default direction**; tapping the **already-active** chip **flips its
   direction**. Each chip therefore maps to a pair of the existing six
   `WatchlistSort` modes (see Public types / APIs). This is presentation over the
   existing sort modes — no new sort logic.
4. **Test gate: unit + component only.** Consistent with spec 0046 decision 8 and
   spec 0014 decision 6 for this client-side-only feature area. **No new e2e
   flow** — this is a restyle/reorg of an existing page, not a new route or
   critical user action. Stated explicitly so the omission is intentional (see
   Test plan).
5. **Single spec/PR** covers all four changes (status filter reorder + counts,
   type-tab restyle, combined sort/filter bottom sheet, search-bar trigger).

## Scope

In scope (all within `libs/mobile/watchlist`, presentation layer):

- **Reorder** the filter rows to status-chips → type-tabs → search bar (was
  type-tabs → status-chips → search bar → inline provider chips).
- **Restyle status chips** to the Advanced Watchlist pill style and render all
  four (All / Watching / Planned / Completed) **unconditionally** with a live
  count badge each (decision 2).
- **Restyle type tabs** from pills to the **underline-tab** style (decision from
  the issue), keeping the same three tabs and All/Movies/TV Shows order and the
  same `onFilterClick` behavior.
- **Add a `tune` trigger** inside the search bar's right edge that opens a new
  combined **"Sort & Filter" bottom sheet**; **remove** the toolbar sort button
  and the sort `IonActionSheet`.
- **Move** the sort options into the sheet's **Sort By** section (chip row,
  tap-to-toggle direction per decision 3) and the provider filter into the
  sheet's **Provider** section (multi-select chip row, same OR behavior). Remove
  the standalone inline `.provider-filter` row from the page body.
- Update `watchlist.page.html`, `watchlist.page.scss`, `watchlist.page.ts` (only
  the presentation wiring: sheet open/close state, sort-chip → `WatchlistSort`
  mapping, the status-chip data source), the component test, and the README.

Out of scope:

- **Any filtering/sort logic change.** `sortItems`, `getAvailableProviders`,
  `groupByStatus`, `filterByType`, `STATUS_DISPLAY_ORDER`, the composition order
  (type → search → [provider chips] → status → provider → sort), the 200ms search
  debounce, the `availabilityMap` derivation, and the `providerCache` refactor
  from spec 0046 are **all unchanged**. This spec re-skins the controls that drive
  them.
- **Firestore schema / data model.** No new field, converter, index, or rule.
  Status counts are derived client-side from the existing stream (decision 2).
  `shared/domain`, `shared/firestore-schema`, `firestore.rules`,
  `firestore.indexes.json` are **not** touched.
- **New Firestore reads/queries.** The provider chips in the sheet are still fed
  by the existing `availabilityMap` (no new listener; spec 0046 decision 12).
- **New sort modes.** The sheet's three sort chips map onto the **existing six**
  `WatchlistSort` modes (decision 3) — no new mode is added.
- **The type-filter behavior**, the delete overlay, the status action-sheet
  (long-press → change status), pull-to-refresh, the toolbar refresh/bell/account
  buttons, per-card badges, empty/loading/error states, and guarded detail
  navigation — all **unchanged** (visual tweaks only where the Stitch screen
  dictates; behavior identical).
- **Any e2e flow / `apps/mobile-e2e` / `playwright.config.ts` / `ci.yml`
  change** (decision 4).
- **A "Dropped" status chip** — the Advanced Watchlist design has no dropped
  chip; dropped items still group/sort as today when reachable via "All" (Risks).
- **Cross-slice work** — no `slice:search`, `slice:settings`,
  `slice:title-detail`, `scope:functions`, or `apps/mobile` change.

## Affected slices & Sheriff tags

| Path                        | Scope / slice tag                 | Change                                                                      |
| --------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `libs/mobile/watchlist/src` | `scope:mobile`, `slice:watchlist` | template + styles + presentation wiring in `watchlist.page.*`, test, README |

**No cross-slice import, no new shared surface.** All changes stay inside
`libs/mobile/watchlist`. The slice continues to import only
`@vultus/shared/domain`, `@vultus/shared/domain/tokens` (`AUTH_UID`),
`@vultus/shared/firestore-schema`, `@vultus/shared/ui-kit`, and third-party
(`@ionic/*`, `@angular/fire`, `rxjs`, `ionicons`). The uid is still obtained only
via the `AUTH_UID` token — never via an `apps/mobile` import. No new pure helper
is added (the status-count and sort-direction logic is trivial presentation
wiring in the page; well short of the "extract at 3+ slices" rule — PLAN §3 /
CLAUDE.md). No barrel surface change is expected (verify: `WatchlistPage` +
`WatchlistService` exports unchanged).

## Data model touchpoints

**None.** This spec touches **no** Firestore collection, field, converter, index,
or security rule. It re-renders data the page already reads:

- The status **counts** come from `groupByStatus(...)` over the already-subscribed
  `watchlist$` stream (PLAN §4 `users/{uid}/watchlist`) — **client-side**, no new
  read, no new field.
- The sheet's provider chips come from the existing `availabilityMap` derived from
  `title-cache/{tmdbId}/availability/{region}` (PLAN §4), reusing the memoized
  `providerCache` from spec 0046 — **no new listener** (spec 0046 decision 12).

The implementer must **record "no `firestore.rules` / `firestore.indexes.json` /
schema change"** in the PR.

## Public types / APIs

**No new or changed shared type, service method, or exported helper.** The
existing surfaces are reused as-is:

- `WatchlistSort` (`watchlist.service.ts`): the six existing modes remain
  `'titleAsc' | 'titleDesc' | 'addedDesc' | 'addedAsc' | 'releaseDesc' |
'releaseAsc'`. **Do not add a mode.** The three sheet sort chips map onto them:

  | Sheet sort chip | Default direction (first tap) | Toggled direction (tap active again) |
  | --------------- | ----------------------------- | ------------------------------------ |
  | **Date Added**  | `addedDesc` (newest first)    | `addedAsc` (oldest first)            |
  | **Name**        | `titleAsc` (A → Z)            | `titleDesc` (Z → A)                  |
  | **Rating**      | `releaseDesc` (newest first)  | `releaseAsc` (oldest first)          |

  **Binding note on "Rating":** the Stitch chip is labelled "Rating", but the
  watchlist doc has **no rating field** — `voteAverage` is the closest existing
  numeric, and there is **no `voteAverage` sort mode** among the six. Rather than
  add a sort mode (out of scope), the **"Rating" chip is relabelled "Release
  date"** and mapped to the existing `releaseDesc` / `releaseAsc` pair (which the
  UI already exposed via the old action-sheet). This keeps the sheet to the
  existing sort modes. Flag this relabel in the PR for human confirmation against
  the Stitch screen. (If the reviewer insists on a literal "Rating" sort, that is
  a new sort mode = a scope expansion needing a new spec, not a silent addition.)

- `WatchlistService`, `groupByStatus`, `filterByType`, `sortItems`,
  `getAvailableProviders`, `STATUS_DISPLAY_ORDER`, `STATUS_LABELS`, `StatusGroup`
  — **unchanged**.

### `WatchlistPage` presentation wiring (binding behavior, not exact code)

- **Status-chip data source.** Today `statusChips$` emits only **non-empty**
  groups (spec 0046). For this design the template must render **all four fixed
  chips** (All / Watching / Planned / Completed) with a live count each,
  **including zero**. The implementer either (a) derives a fixed
  `{ status, label, count }[]` for the three real statuses from the same
  type+search+provider-filtered set that `groupByStatus` sees (count = the group's
  length, `0` when absent) plus an "All" chip whose count is the sum, or (b)
  keeps `statusChips$` but changes the template to iterate the fixed
  `['watching','planned','completed']` order and look up each count (default `0`).
  **Binding:** the "All" count and each status count must equal the number of
  cards that selecting that chip shows (i.e. the counts reflect the same
  type+search+provider-filtered set `groupByStatus` sees, consistent with spec
  0046). The **"Dropped"** status is **not** rendered as a chip (design has no
  dropped chip) — dropped items remain reachable/grouped under "All" as today.

  > Note: `selectedStatus === null` already means "All". Selecting a status chip
  > sets `selectedStatus` to that status (existing `onStatusChipClick`). This
  > behavior is unchanged; only the chip set (fixed four, with counts incl. zero)
  > and styling change.

- **Sort-direction toggle (decision 3).** Add presentation state mapping the
  three sheet chips to `WatchlistSort` per the table above. Tapping an inactive
  chip applies its default direction; tapping the active chip flips to its
  toggled direction. This drives the existing `onSortSelected(sort)` /
  `selectedSort`. Expose a public method the component test invokes without
  simulating gestures, e.g. `onSortChipClick(chip: 'added' | 'name' | 'release')`;
  derive which sort mode to set from `selectedSort`'s current value (if the active
  chip's default mode is already selected, apply its toggled mode; else apply the
  default). Keep it a **pure mapping** — no change to `sortItems`.

- **Combined sheet open/close.** Replace the two `IonActionSheet` sort UI (the
  sort one is removed) with a single bottom-sheet element. The implementer MAY
  implement the sheet as (a) an `IonModal` with `[breakpoints]` /
  `[initialBreakpoint]` sheet presentation, or (b) an in-template overlay `div`
  toggled via a `filterSheetOpen` boolean and CSS `translate-y` transition (as the
  Stitch markup does with `.hidden` + `translate-y-full`). **Pick one and pin the
  interactive states** (see UI section). Expose public methods for the test:
  `openFilterSheet()`, `closeFilterSheet()` (bound to the `tune` button, the
  "Done" button, and the backdrop). The status **action-sheet** (long-press →
  change a card's status) is a **separate** element and stays as-is.
  **Android back button:** while the sheet is open, the hardware back button
  MUST close the sheet (not navigate away). `IonModal` handles this natively; an
  in-template overlay MUST register an Ionic `BackButton` handler (or bind
  `ion-backdrop`/`IonModal` semantics) so back dismisses the sheet first.

- Everything else in `WatchlistPage` (`onFilterClick`, `onStatusChipClick`,
  `onSearchInput`, `toggleProvider`, `isProviderSelected`, `openStatusSheet`,
  `onDeleteConfirm`, `onSync`, `openNotifications`, the `vm$`/`availabilityMap$`/
  `statusChips$`/`availableProviders$` pipelines, `providerNames$`, `posterUrl`,
  `votePercent`, `titleId`) is **unchanged**. `openSortSheet()` /
  `sortSheetOpen` / `sortSheetButtons` are **removed** (replaced by the combined
  sheet). Keep the selector `lib-watchlist`.

## UI / Stitch screen refs

This is a `scope:mobile` slice — UI fidelity is a **contract**. The target is the
**"Advanced Watchlist - Vultus"** Stitch screen in project **"Vultus Android App
Design"**:

- **Stitch project:** `projects/13590348714018893783`
- **Screen ID:** `projects/13590348714018893783/screens/19f0eae3d6d24eaa90b3aa73ff44a59b`

**The implementer MUST pull this screen** via the `stitch` MCP recipe in
CLAUDE.md: `get_screen` on the screen ID → take `htmlCode.downloadUrl` and fetch
the **raw HTML** (a plain GET / `Invoke-WebRequest`, **not** WebFetch, which
summarizes away the CSS), read the Tailwind config (`colors` / `fontSize` /
`spacing`) + the element markup for the concrete class values, and also grab
`screenshot.downloadUrl` for a visual compare. **Reference the screen ID in the
PR.** **Retry on MCP failure** (project memory: the MCP is reachable from the
orchestrator; a sub-agent "unreachable" is a retry, not a reason to ship
token-only UI). If the screen HTML genuinely cannot be read after retry, this UI
task is **blocked / `needs-human`** — do **not** silently fall back to tokens.

> **Author's note on sourcing.** The concrete class/structure values pinned below
> come from the architect's own fetch of this screen's raw HTML during the
> interview (line references are approximate to that fetch). Treat them as the
> starting contract, but the implementer must re-fetch and verify against the live
> screen before finalizing (the fetched HTML is authoritative if it differs).

**All color/type/spacing tokens are cited from
`docs/design/vultus-design-system.md`** (the authoritative token set) and consumed
via the `--vultus-*` / `--ion-*` vars `shared/ui-kit` `theme.scss` exposes — do
**not** hand-transcribe hex values into the code. The relevant tokens: `primary`,
`on-primary`, `surface-container`, `surface-container-high`,
`surface-container-highest`, `on-surface`, `on-surface-variant`, `outline-variant`;
radii `full` (pills), `xl` (search bar + sheet top corners), `lg` (sort/provider
chips), `DEFAULT` (existing); type roles `label-md` (chip labels), `label-sm`
(section headings / count badge), `body-lg` (card title). **Inter** is already
loaded as a web-font by the shell — no font-loading change.

### Layout order (top → bottom in `ion-content`, above the grouped list)

1. **Status filter chip row** — was second; now **first**.
2. **Type tab row** (underline tabs) — was first; now **second**, directly below
   the status chips.
3. **Search bar** with the `tune` trigger at its right edge.
4. (removed) the standalone inline provider-chip row — now lives in the sheet.
5. The existing grouped status sections + cards (unchanged).

### Status filter chip row (per-state contract)

- **Structure:** a flex row (`flex gap-sm mb-lg` per the fetched HTML), four pill
  chips in fixed order **All → Watching → Planned → Completed**. Each chip label
  is `label-md`; each carries a small count badge — the Stitch markup uses a
  nested `<span class="opacity-70 text-[10px]">` (a `label-sm`-scale, reduced-
  opacity count suffix). All four render **unconditionally**, count `0` shown.
- **Radius:** `full` (pill). **Height:** match the fetched HTML control height
  (pin the concrete `py`/height from the raw markup; the sibling type tabs and
  these chips must share a consistent left inset — 16px `margin-mobile`, matching
  the existing rows).
- **Active state:** `primary` fill + `on-primary` text + `shadow-sm` (the fetched
  markup: `bg-primary text-on-primary shadow-sm`). The count badge keeps the same
  on-primary color at reduced opacity.
- **Inactive state:** `surface-container-high` fill + `on-surface-variant` text
  (`bg-surface-container-high text-on-surface-variant`).
- **Hover state:** `hover:bg-surface-variant/50` (per fetched markup) — a subtle
  fill lift on inactive chips.
- **Focus state:** visible keyboard focus ring (these are `<button>`s) — a
  `primary`-tinted outline consistent with the design's focus treatment; pin from
  the fetched markup or the design system if absent.
- **Transition:** background/color transition on state change (~120ms), matching
  the existing `.filter-pill`.

### Type tab row (underline tabs — restyle, per-state contract)

- **Structure:** a horizontally-scrollable row (`flex gap-md mb-lg overflow-x-auto
scrollbar-hide pb-1` per the fetched HTML), three tabs **All → Movies → TV
  Shows**. This is the design's **underline-tab** pattern — **NOT** pills and
  **NOT** an `ion-segment` container. Render as plain `<button>`s in a flex row
  (the current `.type-filter` uses `.filter-pill` buttons — reuse the buttons,
  swap the class/styling to the underline treatment).
- **Active state:** `text-primary`, `label-md` weight, a 2px bottom border in
  `primary` (`border-b-2 border-primary`), small vertical/horizontal padding
  (`pb-1 px-1` per fetched markup).
- **Inactive state:** `text-on-surface-variant`; **hover:** `hover:text-on-surface`
  (per fetched markup) — text brightens, no fill.
- **Focus state:** visible keyboard focus outline on the tab button.
- **Transition:** color + underline transition (~120ms).
- **Behavior unchanged:** clicking a tab calls the existing `onFilterClick(type)`;
  All = `undefined`, Movies = `'movie'`, TV Shows = `'tv'`.

### Search bar + `tune` trigger (per-state contract)

- **Structure:** a `relative` wrapper (`mb-lg`), a left-aligned search/magnifying
  icon, the input, and a **single** `tune`-icon button absolutely positioned
  inside the input's **right** edge (Stitch `id="filter-trigger"`).
- **Input styling (fetched markup):** `bg-surface-container-high`, no border,
  `rounded-xl` (radius `xl`), padding `py-3 pl-10 pr-4` (left inset clears the
  search icon; right inset clears the `tune` button). Placeholder
  **"Search watchlist..."** in `on-surface-variant`. Implement with the existing
  `IonSearchbar` styled to these tokens **or** a plain input — **pin the input
  height** from the fetched `py-3` so it does not drift; the `tune` button and the
  search icon must be **vertically centered** to that height.
- **Focus state:** `focus:ring-2 focus:ring-primary/50` (per fetched markup) — a
  2px primary-Emerald focus ring at ~50% opacity. (The current implementation used
  a `box-shadow` border on `.searchbar-has-focus`; keep an equivalent
  primary-Emerald focus treatment and pin it.)
- **`tune` button states:** default (icon in `on-surface-variant` or
  `on-surface`), hover (brighten to `on-surface` / subtle bg), active/pressed
  (primary tint), focus (visible outline). Register the `tune`
  (`options-outline` / an ionicon equivalent — pick the closest Ionicon and pin
  it) icon via `addIcons`. `aria-label="Sort and filter"`.
- **Search behavior unchanged:** the 200ms RxJS debounce and `onSearchInput`
  wiring from spec 0046 are kept; clearing the field restores the full
  (other-filters-applied) list.

### "Sort & Filter" bottom sheet (per-state contract)

- **Structure (fetched markup, `id="filter-sheet"`):** hidden by default; the
  `tune` button toggles it. A backdrop `bg-black/60 backdrop-blur-sm` behind a
  bottom-anchored panel `bg-surface-container-high` with `rounded-t-xl` (radius
  `xl` top corners) and `p-lg` padding. A **drag handle** at the top. A header
  row: **"Sort & Filter"** title (`headline-sm` / `body-lg` role — pin from the
  fetched markup) + a **"Done"** text button (`text-primary`) that closes the
  sheet. Two labelled sections, each with a heading in
  `text-label-sm text-on-surface-variant uppercase tracking-wider`:
  - **Sort By** — a chip row: **Date Added / Name / Release date** (relabelled
    from "Rating" — see Public types / APIs). Exactly **one** active at a time.
    Active chip: `bg-primary text-on-primary`. Inactive chip:
    `bg-surface-container text-on-surface border border-outline-variant/20`,
    radius `lg`. The active chip shows its **direction** (per decision 3 — e.g.
    an arrow/caret indicating asc vs desc, or the label appends ↑/↓); pin the
    direction affordance from the fetched markup, and if absent, add a small
    caret next to the active chip label and flag for human verification.
  - **Provider** — a multi-select chip row (Netflix, Disney+, Prime Video, Hulu
    in the static mockup; **at runtime the chips come from the existing
    `availableProviders$`** — the design's names are placeholders). Chips styled
    like the inactive Sort chips (radius `lg`,
    `bg-surface-container text-on-surface border border-outline-variant/20`);
    **selected** chip: `bg-primary text-on-primary` (or the design's selected
    treatment — pin from fetched markup). Multi-select, OR logic, wired to the
    existing `toggleProvider` / `isProviderSelected`.
- **Sheet visible / hidden animation:** slide up from the bottom
  (`translate-y-full` → `translate-y-0`) with the backdrop fading in; reverse on
  close. Pin the transition duration/easing from the fetched markup.
- **Close affordances (all three must work):** the **"Done"** button, a **tap on
  the backdrop**, and the **Android hardware back button** all dismiss the sheet
  (see Public types / APIs — back must dismiss the sheet, not navigate).
- **Empty-provider behavior:** when `availableProviders$` is `[]` (no availability
  loaded), the **Provider section renders no chips** — show a short muted
  "No providers available yet" line (or hide just the Provider section heading +
  row), so the sheet still opens with a usable Sort By section. This migrates the
  old "provider row hidden when empty" behavior (spec 0046 decision 4) into the
  sheet. Pin the chosen empty treatment.

### Per-state acceptance contract (tick each — feature-reviewer + human)

- [ ] **Layout order:** status chips → type tabs → search bar → grouped list, in
      that vertical order; the removed inline provider-chip row is gone; the
      removed toolbar sort button is gone.
- [ ] **Status chips — default:** four chips render (All / Watching / Planned /
      Completed) in that order, each with a live count (0 shown, not hidden);
      "All" active on first render (primary fill + shadow); no "Dropped" chip.
- [ ] **Status chips — selected / hover / focus:** selecting a status makes it
      active and narrows the list; "All" restores all groups; inactive chips show
      the hover fill; keyboard focus shows a visible ring.
- [ ] **Status counts correct:** each count equals the cards selecting that chip
      shows (reflecting type+search+provider filters); "All" = the sum; empty
      watchlist → all counts 0 (chips still render).
- [ ] **Type tabs — underline style:** All/Movies/TV Shows render as underline
      tabs (not pills, not `ion-segment`); active tab shows `text-primary` +
      2px primary underline; inactive tabs `on-surface-variant` with hover
      brighten; row scrolls horizontally without wrap; filtering behavior
      unchanged.
- [ ] **Search bar:** `bg-surface-container-high`, `rounded-xl`, left search icon,
      right `tune` button vertically centered to the pinned input height;
      placeholder "Search watchlist..."; **focus** shows the `primary/50` ring;
      200ms-debounced filtering still works; clearing restores the list.
- [ ] **`tune` → sheet:** tapping `tune` opens the "Sort & Filter" sheet
      (slide-up + backdrop); it shows a drag handle, title, "Done" button, a
      **Sort By** chip row and a **Provider** chip row.
- [ ] **Sheet close:** "Done", backdrop tap, and Android back button each dismiss
      the sheet.
- [ ] **Sort By chips:** exactly one active; tapping an inactive chip sorts in its
      default direction; tapping the **active** chip flips direction (decision 3);
      the active chip shows its direction affordance; default is Date Added /
      newest (`addedDesc`); groups stay Watching → Planned → Completed → (Dropped)
      order, sort reorders **within** each group.
- [ ] **Provider chips (sheet):** driven by `availableProviders$`; multi-select OR
      logic (two selected → items matching either); **empty** availability →
      no provider chips (muted "none" line or hidden section), sheet still usable.
- [ ] Every new/changed control's **default / focus / hover / active / disabled**
      states + the sheet slide animation match the fetched screen; any value the
      screen didn't express is token-derived and **flagged for human visual
      verification** (a green build does not prove fidelity — CLAUDE.md).

## Implementation task graph

All work is inside `libs/mobile/watchlist` and touches the same page files, so it
is a single **[sequential]** stream (no parallel fan-out; the `.ts`, `.html`,
`.scss`, and `.spec.ts` co-edit the page). No shared dep, no new-slice
generation, no root/config wiring.

### Task 1 — [sequential] Pull + verify the Advanced Watchlist Stitch screen

frontend-engineer. Prerequisite for the UI work.

- Pull screen `19f0eae3d6d24eaa90b3aa73ff44a59b` in project
  `13590348714018893783` via `get_screen`; fetch `htmlCode.downloadUrl` as raw
  HTML (plain GET, not WebFetch) and `screenshot.downloadUrl`. Retry on MCP
  failure. Record the screen ID + the concrete pinned values (chip height, input
  `py`, radii, transition timings, focus ring, direction affordance) for the PR.
  If unreadable after retry → **block / `needs-human`** (do not proceed
  token-only).
- **File manifest:** (research task — no file writes.)

### Task 2 — [sequential] Restyle template + wiring (`watchlist.page.html`, `watchlist.page.ts`)

Depends on task 1. frontend-engineer.

- **Template (`watchlist.page.html`):**
  - Reorder to: **status chip row → type tab row → search bar → grouped list.**
  - Status chips: render the fixed four (All / Watching / Planned / Completed)
    with live counts (incl. 0), in the new pill style; keep the existing
    `onStatusChipClick(status | null)` wiring; remove the "non-empty only"
    `@for` gating for the four fixed statuses (no Dropped chip).
  - Type tabs: keep the three `onFilterClick(...)` buttons; swap to the
    underline-tab structure/classes.
  - Search bar: wrap in the `relative` container; add the `tune` button
    (`id`/`aria-label="Sort and filter"`, `(click)="openFilterSheet()"`) at the
    right edge; keep the `IonSearchbar`/input + `onSearchInput` wiring; keep the
    placeholder text (or set "Search watchlist...").
  - Remove the standalone `.provider-filter` row and the toolbar sort
    `IonButton` (`swap-vertical-outline`) + the sort `IonActionSheet`.
  - Add the combined "Sort & Filter" bottom sheet (IonModal **or** overlay div —
    picked in the .ts): drag handle, "Sort & Filter" title, "Done"
    (`closeFilterSheet()`), a **Sort By** chip row (Date Added / Name / Release
    date, wired to `onSortChipClick(...)`, active/direction shown), and a
    **Provider** chip row (`@for` over `availableProviders$`, `toggleProvider` /
    `isProviderSelected`; empty → muted "none" line). Backdrop closes the sheet.
  - Keep the status action-sheet (long-press change status), delete alert,
    refresh/bell/account toolbar buttons, empty/loading/error states, cards, and
    guarded detail nav **unchanged**.
- **Wiring (`watchlist.page.ts`):**
  - Add `filterSheetOpen` state + `openFilterSheet()` / `closeFilterSheet()`;
    wire Android back to close-first (IonModal native, or a BackButton handler).
  - Add the sort-chip → `WatchlistSort` mapping + `onSortChipClick(chip)` per
    decision 3; keep `onSortSelected`/`selectedSort` as the underlying setter.
  - Provide the fixed-four status-chip data (All + three statuses with counts
    incl. 0) — either adapt `statusChips$` to emit all four or add a small
    derivation; counts reflect the type+search+provider-filtered set.
  - **Remove** `openSortSheet()` / `sortSheetOpen` / `sortSheetButtons` and the
    `swapVerticalOutline` icon registration; add the `tune`/`options` icon.
  - Register any new ionicons; keep the selector `lib-watchlist`; leave every
    pipeline (`vm$`, `availabilityMap$`, `availableProviders$`, `providerNames$`,
    etc.) and every other public method unchanged.
- **File manifest:** `libs/mobile/watchlist/src/lib/watchlist.page.html`,
  `libs/mobile/watchlist/src/lib/watchlist.page.ts`.

### Task 3 — [sequential] Restyle styles (`watchlist.page.scss`)

Depends on task 2. frontend-engineer.

- Add the new status-chip pill style (active `primary`/`on-primary`+shadow,
  inactive `surface-container-high`/`on-surface-variant`, hover, focus, count
  badge), the underline type-tab style (active `text-primary` + 2px underline,
  inactive/hover/focus), the search-bar `rounded-xl` + `surface-container-high` +
  `primary/50` focus ring + `tune` button positioning, and the bottom-sheet panel
  (backdrop, `rounded-t-xl`, drag handle, headings, Sort By / Provider chip
  styles, slide-up transition). Consume `--vultus-*` vars — **no hand-set hex**.
  Remove the now-dead `.provider-filter` and old sort-button styling if present.
- **File manifest:** `libs/mobile/watchlist/src/lib/watchlist.page.scss`.

### Task 4 — [sequential] Component test + README

Depends on tasks 2–3. frontend-engineer / qa-runner.

- Update `watchlist.page.spec.ts` for the new controls (see Test plan): the
  removed `sortButton`/`openSortSheet` assertions replaced by
  `openFilterSheet`/`closeFilterSheet` + `onSortChipClick`; status-chip tests
  updated to expect the fixed four chips with counts (incl. 0); provider tests
  updated to look inside the sheet; keep the preserved-behavior regressions.
- Update `libs/mobile/watchlist/README.md` to describe the restyled controls +
  the combined sort/filter sheet — no stale text; keep the public-surface section
  accurate (unchanged exports).
- **File manifest:** `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/README.md`.

(No `libs/shared/**`, `apps/mobile`, `sheriff.config.ts`, `firestore.rules`,
`firestore.indexes.json`, `ci.yml`, `playwright.config.ts`, or `scope:functions`
file is touched. `watchlist.service.ts` is **not** modified — the sort modes and
helpers are unchanged. `watchlist.service.spec.ts` is **not** touched.)

## Test plan

Per the PLAN §5 pyramid: **component** tests for the restyled controls +
regressions of preserved behavior; **no new unit tests** (no logic changed — the
pure helpers and service are untouched, already covered by spec 0046's unit
tests). All Firebase access **mocked** (no emulator, no network, no secrets).

**Component (`watchlist.page.spec.ts`, Angular TestBed + Ionic setup;
`WatchlistService` mocked — extend the existing suite):**

- **Layout order:** the status-chip row appears **before** the type-tab row in the
  DOM; the standalone `.provider-filter` row is **absent** (it moved into the
  sheet); the toolbar sort button (`aria-label="Sort watchlist"`) is **absent**.
- **Status chips — fixed four + counts:** with a mixed-status stream, exactly four
  chips render in order All / Watching / Planned / Completed, each with its count;
  a status with **zero** items still renders its chip showing `0`; **no Dropped
  chip** renders; "All" is active on first render; the "All" count equals the sum.
- **Status chips — empty watchlist:** with `[]`, all four chips still render with
  count `0`.
- **Status chip select:** `onStatusChipClick('planned')` narrows to the Planned
  group; `onStatusChipClick(null)` restores all groups (preserved from 0046).
- **Type tabs — behavior preserved + structure:** the three tabs render as
  underline tabs (assert they are plain buttons in the type-tab row, not an
  `ion-segment`); `onTypeChange`/`onFilterClick` still filter Movies/TV/All
  (preserved from 0014/0046).
- **Combined sheet open/close:** the `tune` button (`aria-label="Sort and
filter"`) calls `openFilterSheet()` → `filterSheetOpen === true`; the sheet
  renders a Sort By row and a Provider row; `closeFilterSheet()` (Done / backdrop)
  → `filterSheetOpen === false`.
- **Sort chip tap-to-toggle (decision 3):** starting at default (`addedDesc`),
  `onSortChipClick('added')` again flips to `addedAsc`; `onSortChipClick('name')`
  sets `titleAsc`, a second `onSortChipClick('name')` flips to `titleDesc`;
  `onSortChipClick('release')` sets `releaseDesc` then `releaseAsc`. Assert
  `selectedSort` after each, and that cards reorder within a group while group
  order stays Watching → Planned → Completed.
- **Provider chips in the sheet:** with an availability map yielding providers,
  the sheet's Provider row renders those names; `toggleProvider` selecting two
  shows items matching **either** (OR); with **no** availability, the Provider row
  shows no chips (muted "none" line / hidden section) but the sheet still opens.
- **Regression (preserved 0014/0046 behavior):** empty / loading (skeleton) /
  error states; delete-confirm alert → `removeTitle`; status action-sheet
  (`openStatusSheet` → `updateStatus`); the per-card provider badge (widened
  `string[]` cache, `names[0]`); the toolbar refresh (spec 0025) + bell/unread
  (spec 0042) behaviors; guarded detail navigation with `?type`.

**Unit:** **No new unit tests** — `sortItems`, `getAvailableProviders`,
`groupByStatus`, `filterByType`, and `WatchlistService` are unchanged (covered by
spec 0046 / 0014 unit tests, which must still pass). If the implementer adds a tiny
pure sort-direction-mapping helper, add a focused unit test for the
chip→`WatchlistSort` mapping (default + toggle); otherwise the mapping is exercised
by the component test above.

**e2e:** **No e2e flows required.** This is a **presentation-layer restyle /
reorganization** of an existing page — no new route, no new critical user action,
no backend/data change. Consistent with spec 0046 decision 8 and spec 0014
decision 6 (the watchlist filter/sort area's gate is unit + component). No new
Playwright spec; no `apps/mobile-e2e` / `playwright.config.ts` / `ci.yml` change.
(Recorded explicitly so a reviewer does not flag the absence as a gap.)

## Definition of done

Green gate is **typecheck + lint/Sheriff + component + build** (what CI runs);
e2e is not required (decision 4).

- [ ] `pnpm nx run-many -t lint test typecheck -p mobile-watchlist` passes **with
      Sheriff active**: no cross-slice import, no `apps/mobile` deep import, no
      `scope:functions` import; the uid is obtained only via `AUTH_UID`; no new
      shared surface; `watchlist.service.ts` unchanged.
- [ ] `pnpm nx build mobile` passes (production config) — the restyled page
      lazy-loads cleanly and the bundle stays within budget.
- [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors CI
      (affected: `mobile-watchlist`, `mobile`).
- [ ] **Component test** asserts: the new layout order; the fixed-four status
      chips with live counts (incl. 0, no Dropped chip); the underline type-tab
      structure + preserved filtering; the combined sheet open/close (Done +
      backdrop); the sort-chip tap-to-toggle mapping to the six `WatchlistSort`
      modes; the provider chips inside the sheet (OR + empty); and the preserved
      0014/0025/0042/0046 behaviors.
- [ ] **No logic change:** `sortItems` / `getAvailableProviders` / `groupByStatus`
      / `filterByType` / `WatchlistService` and the six `WatchlistSort` modes are
      unchanged; composition order (type → search → [chips] → status → provider →
      sort), the 200ms debounce, and the `providerCache`/`availabilityMap`
      reconciliation are unchanged.
- [ ] `libs/mobile/watchlist/README.md` updated to the restyled controls + the
      combined sheet — no stale text; exports unchanged.
- [ ] **`libs/shared/**`, `sheriff.config.ts`, `firestore.rules`,
    `firestore.indexes.json`, `ci.yml`, `playwright.config.ts`,
    `watchlist.service.ts`, `watchlist.service.spec.ts` are NOT modified\*\* —
      recorded in the PR (presentation-only restyle; no schema/logic/read change).
- [ ] **Guardrail verifications (review-checked):** (a) **no new Firestore
      read/write** — status counts are client-side from the existing stream, the
      sheet provider chips reuse the existing `availabilityMap`; (b) all
      filter/sort state remains **in-session component-local** (no localStorage /
      Firestore persistence); (c) no cross-slice import; (d) no secret
      read/written; (e) the Android **back button** closes the sheet before
      navigating.
- [ ] PR records: the **"Advanced Watchlist - Vultus" Stitch screen ID**
      (`19f0eae3d6d24eaa90b3aa73ff44a59b`) used (or MCP-unreachable + retried +
      `needs-human`), the concrete pinned values (chip height, input `py`, radii,
      focus ring, sheet transition, direction affordance), which values were
      token-derived / **flagged for human visual verification**, and the **"Rating"
      → "Release date" relabel** decision (Public types / APIs) for human
      confirmation against the screen.
- [ ] **UI fidelity flagged for a human eyeball** — a green build does not prove
      the restyle looks right (CLAUDE.md). Verify via the `mobile:serve-mock`
      target (render/screenshot) or explicitly flag unverified in the PR.

## Risks

- **UI fidelity is the primary risk.** This spec's entire value is matching the
  Advanced Watchlist screen. The implementer **must** fetch the raw screen HTML
  (not WebFetch), pin the concrete dimensions/states/animations, and either
  visually verify (`mobile:serve-mock` render/screenshot) or explicitly flag
  unverified. A green typecheck/lint/test/build does **not** prove the UI is
  right (CLAUDE.md UI-fidelity rule). The pinned values in the UI section come
  from the architect's fetch and are the **starting contract** — the live screen
  is authoritative if it differs.

- **"Rating" sort chip has no backing sort mode.** The Stitch "Rating" chip maps
  to no existing `WatchlistSort` mode and the watchlist doc has no rating sort.
  **Resolution (binding):** relabel the chip **"Release date"** and map it to the
  existing `releaseDesc`/`releaseAsc` pair (already exposed by the old
  action-sheet), keeping the six sort modes intact. Adding a real `voteAverage`
  ("Rating") sort mode is a **scope expansion** requiring a new spec — do **not**
  add it silently. Flag the relabel in the PR for human confirmation.

- **No "Dropped" chip while dropped items still exist.** The design has four
  status chips (no Dropped), but `WatchStatus`/`STATUS_DISPLAY_ORDER` still
  include `dropped`, and the status **action-sheet** can still set a card to
  Dropped. **Resolution:** dropped items remain grouped/sorted under **"All"** as
  today (the grouped list still renders a Dropped section when non-empty); only the
  **filter chip** for Dropped is omitted, matching the design. There is no way to
  filter _to_ Dropped from the chips — acceptable per the design; flag if the
  reviewer wants a Dropped chip added (that would be a design deviation).

- **Status counts including zero vs. spec 0046's "non-empty only" chips.** Spec
  0046 rendered per-status chips only for non-empty groups; this design renders all
  four with counts (0 shown). This is an intentional behavior change (decision 2),
  **not** a regression — the existing `statusChips$` (non-empty) must be adapted so
  a zero-count status still renders. Ensure the count still reflects the
  type+search+provider-filtered set so selecting a chip shows exactly that many
  cards (a 0-count chip selected → the empty grouped view; acceptable).

- **Bottom-sheet mechanism + Android back.** Whether the sheet is an `IonModal`
  (native back handling, breakpoints) or an in-template overlay (manual back
  handler + backdrop), **all three** close paths (Done / backdrop / hardware back)
  must work, and back must dismiss the **sheet** before any route navigation. The
  status **action-sheet** and the delete **alert** are separate overlays — opening
  the filter sheet must not conflict with them. Pin the chosen mechanism and its
  states; the component test invokes `openFilterSheet`/`closeFilterSheet` directly
  (not via gesture) for determinism.

- **Search-bar restyle vs. `IonSearchbar` internals.** The design's `rounded-xl`
  input with an inset `tune` button may not map 1:1 onto `IonSearchbar`'s shadow
  DOM. If the `IonSearchbar` overrides get fragile, a plain styled `<input>` with
  the search icon + `tune` button is acceptable (keep the `onSearchInput` +
  200ms-debounce wiring identical). Pin the input height so the `tune`/search
  icons stay vertically centered; keep the `primary/50` focus ring.

- **No PLAN conflict.** This restyles PLAN §6 item 18 (the watchlist) at the
  presentation layer only, over the existing `users/{uid}/watchlist` +
  `title-cache/*/availability/*` reads (PLAN §4), issuing no new query/index, no
  schema field, and no cross-slice edge. It preserves the spec 0014/0046 business
  rules and composition order verbatim; the only behavioral delta (status count
  badges including zero, the tap-to-toggle sort direction, and the combined sheet)
  are the locked architect decisions, not silent departures.
