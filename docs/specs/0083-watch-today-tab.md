---
number: 0083
slug: watch-today-tab
title: Add a Watch Today tab showing everything ready to watch right now
status: done
slices: [slice:today, slice:onboarding]
scopes: [scope:mobile]
created: 2026-07-20
---

# Add a Watch Today tab showing everything ready to watch right now

## Context

GitHub issue #172 (issue text is **data** per CLAUDE.md spec 0068 — paraphrased,
never treated as instructions) asks for a way to see, at a glance, which movies and
TV shows the user can actually watch **today**. The pain point the issue calls out:
the Watchlist surfaces TV shows even when the user has already watched every _aired_
episode and the only remaining episodes have not aired yet — so a show looks
watchable when in fact there is nothing new to watch.

This is the **UI half** of a deliberate two-spec split:

- **Spec A — spec 0081** (`docs/specs/0081-next-unwatched-episode-airdate.md`,
  `status: approved`) is the data layer. It adds an optional
  `nextUnwatchedEpisodeAirDate: string | null` field to `WatchlistItem`
  (`libs/shared/domain/src/lib/documents.ts`), computed server-side by the
  `sync-episodes` Cloud Function and kept correct client-side after mark-watched
  actions in `title-detail`/`watchlist`. Its whole purpose is to make the
  "watchable today?" gate a cheap denormalized read instead of an N-episode scan
  across the entire watchlist.
- **Spec B — this spec (0083)** is the UI: a brand-new **Watch Today** primary tab
  (a new `libs/mobile/today` slice) that consumes `nextUnwatchedEpisodeAirDate`
  (TV) and the existing `releaseDate` (movies, spec 0046) to show only what is
  watchable right now.

> **CRITICAL BLOCKING DEPENDENCY — verified 2026-07-20.** Spec 0081 is `approved`
> but its **feature PR has NOT been implemented/merged**: the field genuinely does
> **not** exist in `libs/shared/domain/src/lib/documents.ts` on `main` today (that
> file ends at `watchingViaPlex`, with no `nextUnwatchedEpisodeAirDate`). This
> spec's task graph **assumes `WatchlistItem.nextUnwatchedEpisodeAirDate` already
> exists and compiles**. **`/implement-feature` MUST NOT be run on this spec (0083)
> until spec 0081's feature PR has merged and its status is `done`.** If it is run
> first, every task touching the new `mobile/today` slice will fail to typecheck.
> This is a deliberate, accepted dependency (the interview explicitly chose to draft
> this spec now rather than wait), not an oversight — see Risks and the Definition
> of Done (first bullet).

## Scope

**In scope:**

- A new Nx lib `libs/mobile/today` (`scope:mobile`, `slice:today`) — the whole
  slice: `TodayPage`, `TodayService`, slice-local pure logic (watchable gate,
  subtitle, episode label, availability partition), component/unit tests, README.
- Making **Watch Today** BOTH the **leftmost** tab in the tab bar AND the app's
  **default launch route** (D1). Tab bar order becomes **Today → Watchlist →
  Search → Settings**; the default landing route changes from `/tabs/watchlist` to
  `/tabs/today`.
- Re-pointing every hardcoded `/tabs/watchlist` default/redirect target to
  `/tabs/today` (app routes + both onboarding redirect surfaces), and updating the
  unit/e2e tests that assert the old route/tab-count/tab-order.
- Showing, per `watching`/`planned` item that is watchable today: poster, title,
  type label, a provider-availability pill (D3), a "Ready to watch" tag, and — for
  TV — a "S{season}E{episode} available" label (D4). Grouped into a **Movies**
  section and a **TV Shows** section (each rendered only when non-empty), with a
  dynamic subtitle ("N things ready to watch"). Loading/error/empty states reuse
  the shared `shared/ui-kit` atoms.

**Out of scope:**

- **"View All" links.** The Stitch reference screens render a "View All" link per
  section; this spec **OMITS them entirely** (not even a disabled/no-op
  placeholder). Intentional deviation from the reference screens — flag in the PR.
- **Gated titles with a "waiting" marker.** A watching/planned title that is NOT
  watchable today (future/absent date) is simply **absent** from this tab — no
  "waiting" badge, per the interview's explicit hide-don't-mark choice (D2).
- **`dropped`/`completed` items** — never shown here (only `watching`/`planned`
  are considered).
- **Any `shared/**`change** — spec 0081 already added the consumed field; this
spec adds no`shared/domain`or`shared/firestore-schema` change (verify-and-record).
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`** — no change
  (verify-and-record; §Data-model touchpoints, §Affected slices).
- **Any change to the data-layer computation of `nextUnwatchedEpisodeAirDate`** —
  that is spec 0081's job; this spec only READS it.

## Affected slices & Sheriff tags

This adds a **new mobile slice** plus small, literal navigation-default edits in
the app shell and the onboarding slice. No cross-slice import is introduced (the
new slice reads only `scope:shared` schema/domain; it does **not** import
`slice:watchlist`).

| Project                | Path                     | Sheriff tags                       | Change                                                                                                                                                              |
| ---------------------- | ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mobile-today** (NEW) | `libs/mobile/today`      | `scope:mobile`, `slice:today`      | Whole new slice: `TodayPage`, `TodayService`, pure logic, tests, README                                                                                             |
| mobile (app)           | `apps/mobile`            | `scope:mobile`                     | `app.routes.ts` (new `today` child + both redirect targets); `tabs.page.html`+`.ts` (4th tab, reorder, icon); `app.spec.ts` + `tabs.page.spec.ts` assertion updates |
| mobile-onboarding      | `libs/mobile/onboarding` | `scope:mobile`, `slice:onboarding` | `onboarding.guard.ts` + `onboarding.page.ts` redirect targets; their specs; README                                                                                  |
| mobile-e2e             | `apps/mobile-e2e`        | (not a Sheriff slice)              | `app.boot.spec.ts` + `app.smoke.spec.ts` + `onboarding.spec.ts` assertion updates; new `watch-today.spec.ts` fixme stubs                                            |

- **No `sheriff.config.ts` change — VERIFY and RECORD.** The new lib's source path
  `libs/mobile/today/src` is already matched by the existing glob
  `'libs/mobile/<slice>/src': ['scope:mobile', 'slice:<slice>']`
  (`sheriff.config.ts:56`), so it inherits `scope:mobile` + `slice:today`
  automatically on generation. Confirmed against `sheriff.config.ts` on `main`. Do
  NOT edit `sheriff.config.ts`. (Note the MEMORY "Sheriff barrel src tagging" rule:
  the tag targets `libs/mobile/today/src`, the barrel module — a barrel-less
  `src/index.ts` makes `src` the module.)
- **No cross-slice import.** `slice:today` reads `WatchlistItem` / `EpisodeDoc` /
  `RegionAvailability` / `Region` / `TitleType` / `WatchStatus` from
  `@vultus/shared/domain`, `AUTH_UID` from `@vultus/shared/domain/tokens`, and
  paths/converters from `@vultus/shared/firestore-schema`; it imports the shared
  atoms `VultusEmptyState` / `VultusErrorState` / `VultusSkeletonCard` from
  `@vultus/shared/ui-kit`. It does **not** import `@vultus/mobile/watchlist` (Rule
  2 forbids it). The availability-pill + provider-memoization logic is
  **deliberately duplicated** from `libs/mobile/watchlist` (see D3) — this is the
  **2nd** slice doing this (watchlist is the 1st), **below** the PLAN §3 "extract
  only at 3+ slices with the same reason to change" threshold. Do NOT extract a
  shared helper; a reviewer should NOT flag this duplication as a mistake.
- **Cross-slice navigation is by string segments, not import** (mirrors
  watchlist's `navigateToDetail`): the card tap navigates
  `['tabs', 'title-detail', titleId]` with `{ queryParams: { type } }` — no import
  of `@vultus/mobile/title-detail`.

## Data model touchpoints

PLAN §4 paths. **This spec READS only; it adds no field, collection, rule, or
index.**

| PLAN §4 path                                            | Access              | By                                                                                                     |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `users/{uid}/watchlist` (collection)                    | **read** (realtime) | `TodayService.watchlist$` → `dataToWatchlistItem` (incl. `releaseDate`, `nextUnwatchedEpisodeAirDate`) |
| `users/{uid}` (doc)                                     | **read** (region)   | `TodayService.userRegion$` → `dataToUser` (memoized, one listener)                                     |
| `title-cache/{tmdbId}/availability/{region}` (doc)      | **read**            | `TodayService.availability$` → `dataToAvailability` (memoized per `tmdbId\|region`)                    |
| `users/{uid}/watchlist/{titleId}/episodes` (collection) | **read** (one-shot) | D4 bounded enrichment — `getDocs` → `dataToEpisode`, ONLY for TV items that pass the D2 gate           |

- **No `firestore.rules` change — VERIFY and RECORD.** Every read is of a
  collection/doc the client already reads under existing rules: the owner-only
  `users/{userId}/{document=**}` rule covers `watchlist`, the user doc, and the
  `episodes` subcollection; `title-cache/*/availability/{region}` is covered by its
  existing authenticated-read rule (the same paths Watchlist reads today). No new
  access pattern → no rule change. Do NOT edit `firestore.rules`; record "no change
  needed" in the PR.
- **No `firestore.indexes.json` change — VERIFY and RECORD.** No new query: the
  watchlist read is the existing full-collection `collectionData` (no
  `where`/`orderBy`; watchable filtering is client-side, mirroring Watchlist's
  index-free approach), the availability/user reads are per-doc `docData`, and the
  episodes read is a full-subcollection `getDocs` (no `where`). Record "no index
  change needed" in the PR.

## Public types / APIs

No HTTP endpoint, no callable, no `shared/**` change. All new types are
**slice-local** to `libs/mobile/today`. Signatures below are the contract.

### `TodayService` (`libs/mobile/today/src/lib/today.service.ts`)

Injects AngularFire `Firestore` and the `scope:shared` `AUTH_UID` token (never
`apps/mobile`), keyed on the resolved uid; null uid → empty stream / no-op.
Mirrors — does not import — `WatchlistService`'s shape.

```ts
watchlist$(uid: string | null): Observable<WatchlistItem[]>;            // users/{uid}/watchlist realtime
userRegion$(uid: string | null): Observable<Region | null>;            // memoized users/{uid} → region
availability$(tmdbId: number, region: Region | null): Observable<RegionAvailability | null>;
readEpisodes(uid: string, titleId: string): Promise<EpisodeDoc[]>;     // one-shot getDocs, D4 enrichment
```

### Slice-local pure logic (`libs/mobile/today/src/lib/today.logic.ts`)

Deterministic — "now" is **injected**, never read inside these functions (so unit
tests need no clock mocking). Types are slice-local.

```ts
/** A movie is watchable today iff status ∈ {watching,planned}, releaseDate is
 *  present, and releaseDate <= todayDateOnly (a YYYY-MM-DD date-only string). */
export function isMovieWatchableToday(
  item: WatchlistItem,
  todayDateOnly: string,
): boolean;

/** A TV show is watchable today iff status ∈ {watching,planned},
 *  nextUnwatchedEpisodeAirDate is non-null, and nextUnwatchedEpisodeAirDate <= nowISO
 *  (a full ISO 8601 datetime string). */
export function isTvWatchableToday(
  item: WatchlistItem,
  nowISO: string,
): boolean;

/** Partitions the full watching+planned set into the two rendered sections,
 *  applying the type-specific gate above. dropped/completed are excluded. */
export function partitionWatchableToday(
  items: WatchlistItem[],
  nowISO: string,
  todayDateOnly: string,
): { movies: WatchlistItem[]; tvShows: WatchlistItem[] };

/** Subtitle copy from the TOTAL watchable count (movies + tvShows).
 *  EXACT strings: 1 → "1 thing ready to watch"; N → "N things ready to watch". */
export function watchableSubtitle(count: number): string;

/** The "S{season}E{episode} available" label for a TV card, from the earliest
 *  currently-unwatched episode (min airDate via ISO lexical compare; tie-break by
 *  (season, episode) ascending). null when no unwatched episode is found. Season
 *  and episode are rendered UNPADDED (e.g. "S3E5 available", NOT "S03E005"). */
export function nextEpisodeLabel(episodes: EpisodeDoc[]): string | null;

/** Slice-local copy of watchlist's partitionAvailabilityPill (D3). mine → the
 *  first flatrate provider whose id ∈ myProviderIds; elsewhere → the first
 *  flatrate provider; null → no flatrate → no pill. */
export type AvailabilityPill =
  | { kind: 'mine'; name: string }
  | { kind: 'elsewhere'; name: string };
export function partitionAvailabilityPill(
  availability: RegionAvailability | null,
  myProviderIds: readonly number[],
): AvailabilityPill | null;
```

> **D5 — date-comparison mechanics (a real correctness trap; follow exactly).**
> Two DIFFERENT string formats are compared against "now" and must not be conflated:
>
> - `WatchlistItem.releaseDate` (movies) is a **date-only** ISO string, e.g.
>   `'2024-03-15'` (per its `documents.ts` doc-comment "plain ISO date").
> - `WatchlistItem.nextUnwatchedEpisodeAirDate` (TV, spec 0081) and
>   `EpisodeDoc.airDate` are **full ISO 8601 datetime** strings, e.g.
>   `'2026-01-02T00:00:00.000Z'`.
>
> The `TodayPage` computes **two separate "now" representations** at subscription
> time and passes them into the pure functions — do **NOT** derive one from the
> other inconsistently, and do **NOT** slice one format to match the other:
>
> ```ts
> const nowISO = new Date().toISOString(); // full datetime, UTC → TV comparison
> const todayDateOnly = nowISO.slice(0, 10); // YYYY-MM-DD, UTC calendar date → movie comparison
> ```
>
> Comparison is **lexical string** `<=` (the precedented idiom at
> `libs/functions/dispatch-notifications/src/lib/transitions.ts:62-68`; ISO strings
> sort correctly as strings). Using UTC via `toISOString()` (rather than
> device-local time) is the **deliberate, precedented** choice — it matches how
> `dispatch-notifications` computes "now"; a few hours' skew near local midnight
> (NL is UTC+1/+2) is an accepted, low-stakes tradeoff for personal-use scale, not
> a bug (see Risks — do not "fix" it to device-local time).

### `TodayPage` (`libs/mobile/today/src/lib/today.page.ts`)

Standalone Ionic page (selector `lib-today`), lazy-loaded via the barrel
`@vultus/mobile/today`. Composes a `vm$` from `watchlist$` + `userRegion$` + a
fixed `now` (computed once per subscription), applying `partitionWatchableToday`.
Provider pills use a memoized `availability$` per `tmdbId|region`
(`shareReplay({ bufferSize: 1, refCount: false })`) — exactly the reason
Watchlist memoizes (a fresh Observable per change-detection pass would reopen a
Firestore listener every cycle). D4 episode labels use a memoized
`Map<string, Observable<string | null>>` keyed by `titleId`, each a one-shot
`from(readEpisodes(...))` → `nextEpisodeLabel`, **invoked only for TV items that
already pass the D2 gate** (bounded set — see D4).

## UI / Stitch screen refs

**Stitch screens captured (raw HTML read per CLAUDE.md recipe — `get_screen` →
`htmlCode.downloadUrl` → raw GET, not WebFetch):**

- **PRIMARY (authoritative):**
  `projects/13590348714018893783/screens/812340847a604f8a968021183690bf54`
  ("Watch Today - Vultus"). Raw markup read in full; unambiguous.
- **Secondary/alternate cross-reference:**
  `projects/13590348714018893783/screens/0ae965383638469882be94351c140699`
  (same prompt). Primary was unambiguous, so the secondary was not needed to
  resolve any point.

All colors/type/spacing below reference **`docs/design/vultus-design-system.md`**
(the authoritative token set) and are consumed as `--vultus-*` / `--ion-*` vars
from `shared/ui-kit` `theme.scss` — **no hand-transcribed hex** in the SCSS. Token
_names_ below are cited from the screen's Tailwind config, which mirrors the design
doc's YAML frontmatter. The **Inter web-font must be loaded** (Google Fonts link in
`apps/mobile/src/index.html`, already present app-wide) — a named-only family stack
silently falls back to system-ui.

**Icon mapping (Material Symbols → Ionicons; implementer registers via `addIcons`
and cites the exact registered name in the PR):**

| Element                    | Screen glyph (Material)                        | Ionicon to register                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Today tab** (bottom nav) | `today` (calendar)                             | `today-outline` (faithful to the screen's `today` glyph; decision record's `flash`/`play-circle`/`checkmark-circle` alternatives are acceptable only if the implementer cites a closer match — default to `today-outline`) |
| "Ready to watch" tag       | `play_circle` (filled)                         | `play-circle`                                                                                                                                                                                                              |
| Availability pill (mine)   | `check_circle` (filled)                        | `checkmark-circle` (matches watchlist's pill icon)                                                                                                                                                                         |
| Header brand mark          | `movie_filter` (Material-only, no 1:1 ionicon) | `film-outline` — **keep consistent with the existing app header** (`watchlist.page.html:5` brand-mark uses `film-outline`); flag the deviation from the screen's `movie_filter` in the PR                                  |
| Header account button      | `account_circle`                               | `person-circle-outline` (matches `watchlist.page.html:41`)                                                                                                                                                                 |

### Layout contract (pinned from the primary screen)

**Header** — `ion-header` > `ion-toolbar`. The screen's AppBar is `h-16` (64px),
`bg-surface` (`--vultus-surface`), bottom border `outline-variant`
(`--vultus-outline-variant`), horizontal inset 16px (`margin-mobile`).

- **Left (`ion-title`):** a brand mark — `film-outline` icon in `--vultus-primary`
  - the text "Vultus" in `--vultus-primary`, `display-lg-mobile` role (28px / 700).
    Mirror the existing `watchlist.page.html` brand-mark markup/structure.
- **Right (`slot="end"`):** a single **account** button (`person-circle-outline`,
  `--vultus-on-surface-variant`). Non-interactive placeholder, consistent with the
  existing watchlist header's account button (no handler / no route). The Today
  header has **NO** refresh button and **NO** notifications bell (the screen shows
  neither — do not add them).

**Hero (in `ion-content`, above the sections)** — a block with 40px bottom margin
(`mb-10`):

- **`<h1>` "Watch Today"** — `display-lg-mobile` role (28px / 700), `--vultus-on-surface`,
  ~4px bottom margin (`mb-1`).
- **`<p>` subtitle** — `body-lg` role (16px / 400), `--vultus-on-surface-variant`.
  EXACT text from `watchableSubtitle(count)`: "3 things ready to watch" /
  "1 thing ready to watch".

**Section (Movies / TV Shows)** — each 40px bottom margin (`mb-10`), rendered
**only when its list is non-empty**:

- **Section header row:** `<h2>` label — `label-md` role (12px / 600, +0.05em),
  **uppercase**, `--vultus-on-surface-variant`, wide tracking. Text "Movies" /
  "TV Shows". **NO "View All" button** (omitted per D2 — the screen has one; we
  do not).
- **Card list:** vertical stack, **16px** gap between cards (`space-y-4`).

**Card** — an interactive container (`role="button"`, `tabindex="0"`):

| Property   | Value (from screen)                                                                             | Token / note                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Height     | **176px** (`h-44`)                                                                              | fixed                                                                                   |
| Background | `surface-container-low`                                                                         | `--vultus-surface-container-low`                                                        |
| Border     | 1px `outline-variant`                                                                           | `--vultus-outline-variant`                                                              |
| Radius     | **0.75rem** (`rounded-xl`; = design `rounded.md`)                                               | `--vultus-radius-md` (or `0.75rem`)                                                     |
| Layout     | flex row, `items-stretch`, `overflow-hidden`                                                    |                                                                                         |
| Poster     | left, **128px** wide (`w-32`), full height, `object-cover`; fallback block when no `posterPath` | poster URL base `https://image.tmdb.org/t/p/w185` (mirror watchlist `TMDB_POSTER_BASE`) |
| Body       | `p-4` (16px), flex column, `justify-between`, `flex-grow`                                       |                                                                                         |

Body top block:

- **Meta row** (flex, 8px gap `gap-2`, 4px bottom margin): **type label** —
  `label-sm` role (11px / 500), uppercase, `--vultus-on-surface-variant`; text
  "Movie" / "TV Show". Followed by the **availability pill** (below).
- **Title** `<h3>` — `headline-sm` role (20px / 600), `--vultus-on-surface`. Movie
  card: ~8px bottom margin (`mb-2`); TV card: ~2px (`mb-0.5`).
- **TV only — episode label** `<p>` — `body-md` role (14px / 400),
  `--vultus-on-surface-variant`. EXACT text from `nextEpisodeLabel`, e.g.
  "S3E5 available". Rendered only when the enrichment resolves a label.

Body bottom block — **"Ready to watch" tag** (present on every card, since every
card shown IS watchable): flex, 8px gap, `--vultus-status-completed` color,
semibold; a filled `play-circle` icon + the text "Ready to watch" in `label-md`
role (12px / 600).

**Availability pill** (D3) — a single partitioned pill per card, from
`partitionAvailabilityPill`:

- **`mine`** ("On {name}"): pill background `--vultus-primary-container` at ~20%
  alpha, text + a leading filled `checkmark-circle` icon in
  `--vultus-status-completed`; `rounded-full`; `px-2 py-0.5`; `label-md`-ish weight
  (semibold). EXACT text: `"On " + name` (e.g. "On Netflix"). Cited from the
  screen's `bg-primary-container/20 text-status-completed` pill.
- **`elsewhere`** ("Also on {name}"): muted variant — `--vultus-on-surface-variant`
  text, **no icon**, same shape (mirrors watchlist's muted "Also on" pill). EXACT
  text: `"Also on " + name`.
- **`null`** (no flatrate provider): **no pill rendered** (the existing no-chip
  treatment).

**Bottom navigation** — the shared app-shell tab bar
(`apps/mobile/src/app/tabs/tabs.page.html`), NOT part of the new lib. Add a 4th
`<ion-tab-button tab="today">` as the **FIRST** button (before `watchlist`), icon
`today-outline`, label "Today". **Tab-ORDER deviation from the reference screen:**
the screen renders Today as the **3rd** button (Watchlist / Search / Today-active /
Settings); D1 requires it **leftmost** — so implement order **Today / Watchlist /
Search / Settings**. Flag this ORDER deviation in the PR; everything else about the
active-tab visual treatment matches the existing shell.

- **Active-tab treatment:** match the **existing three tabs'** active-state styling
  already in `apps/mobile/src/app/tabs/tabs.page.scss` (the shared shell governs
  the real rendering) — the new Today button inherits it. The screen's embellished
  "emerald capsule + `pill-shadow`" for the active tab (`bg-secondary-container`
  `text-on-secondary-container` + emerald box-shadow) and the design doc's Bottom
  Navigation note ("icon sits within a subtle emerald-tinted pill; label becomes
  Emerald, heavier weight") are the **reference intent**; if the existing shell
  does not already render a capsule, treat the capsule as a screen embellishment
  **flagged for human review**, not a required change to the shared shell in this
  spec.

**Interactive states (per-element acceptance list — reviewer/human ticks off):**

- **Card — default:** `surface-container-low` bg, `outline-variant` border.
- **Card — hover:** bg steps up to `surface-container` (screen
  `hover:bg-surface-container`).
- **Card — active/press:** `transform: scale(0.98)` with a ~0.1s ease transition
  (screen's `mousedown`/`mouseup` micro-interaction). On touch, Ionic's default
  press ripple/overlay is acceptable if scale is impractical — pin one and cite it.
- **Card — focus (keyboard):** a visible `:focus-visible` ring (the card is a
  `role="button"`/`tabindex="0"`); `Enter` triggers navigate-to-detail.
- **Card — disabled:** N/A (cards are always actionable when shown).
- **Today tab — default vs selected:** default `--vultus-on-surface-variant`;
  selected uses the existing shell's active treatment (see above).
- **Empty/loading/error:** see D6 below (shared atoms; states are mutually
  exclusive).

### D6 — header/subtitle/section/state summary

- Header: brand mark + account button (above). Hero: title + dynamic subtitle.
- Sections: "Movies" (only when non-empty) then "TV Shows" (only when non-empty).
- **Loading:** `<vultus-skeleton-card [count]="…">` (same atom as Watchlist),
  shown until the watchlist stream's first emission.
- **Error:** `<vultus-error-state (retry)="onRetry()">` with a message
  (e.g. "Couldn't load what's ready to watch.") and a retry that re-subscribes the
  stream (same atom/pattern as Watchlist).
- **Empty** (zero watchable across BOTH sections): `<vultus-empty-state>` (same
  atom as Watchlist/Search, specs 0024/0076) with an icon the page registers
  (e.g. `today-outline` or `film-outline`) and copy consistent with the app voice —
  e.g. title "Nothing to watch today", subtitle "Nothing on your watchlist has a
  new episode or release available yet." **The primary Stitch screen does NOT
  include an empty state** (it shows 3 populated cards); this copy is **authored to
  match the existing empty-state pattern**, NOT Stitch-sourced — record that
  distinction in the PR.

## Implementation task graph

**Wave A is sequential (same new lib). Wave B fans out three parallel tasks with
pairwise-disjoint manifests** (`apps/mobile/**`, `libs/mobile/onboarding/**`,
`apps/mobile-e2e/**`). Prerequisite for ALL tasks: **spec 0081's feature is merged
(`status: done`)** so `WatchlistItem.nextUnwatchedEpisodeAirDate` exists.

- **Task 1 — Generate `libs/mobile/today`; `TodayService` + pure logic + barrel +
  unit tests + README [sequential]** (frontend-engineer).
  Manifest: `libs/mobile/today/**` (all of: `project.json`, `src/index.ts`,
  `src/lib/today.service.ts`, `src/lib/today.service.spec.ts`,
  `src/lib/today.logic.ts`, `src/lib/today.logic.spec.ts`, `README.md`, and the
  generated tsconfig/eslint files under the lib), plus `tsconfig.base.json` (the
  `@vultus/mobile/today` path mapping the Nx generator adds).
  1. Generate the Angular lib (`nx g @nx/angular:library` with the mobile-slice
     preset used by existing `libs/mobile/*` slices; buildable/standalone matching
     watchlist/search). **Verify** it inherits `scope:mobile` + `slice:today` from
     the Sheriff glob (no `sheriff.config.ts` edit).
  2. `TodayService`: `watchlist$`, `userRegion$` (memoized user doc), `availability$`,
     `readEpisodes` (one-shot). Firebase via injected AngularFire `Firestore`; uid
     via `AUTH_UID`.
  3. `today.logic.ts`: `isMovieWatchableToday`, `isTvWatchableToday`,
     `partitionWatchableToday`, `watchableSubtitle`, `nextEpisodeLabel`,
     `partitionAvailabilityPill` + `AvailabilityPill` type (D2/D4/D5/D3).
  4. Barrel `src/index.ts`: export `TodayService` (and, after Task 2, `TodayPage`).
  5. Unit tests (see Test plan). README: what the lib is, public surface,
     Sheriff scope/slice, and the deliberate watchlist duplication note (D3).

- **Task 2 — `TodayPage` component + template + styles + component tests
  [sequential, after 1]** (frontend-engineer).
  Manifest: `libs/mobile/today/src/lib/today.page.ts`,
  `libs/mobile/today/src/lib/today.page.html`,
  `libs/mobile/today/src/lib/today.page.scss`,
  `libs/mobile/today/src/lib/today.page.spec.ts`,
  `libs/mobile/today/src/index.ts` (add `TodayPage` export),
  `libs/mobile/today/README.md` (component note).
  1. Build `TodayPage` per §UI: header, hero, Movies/TV sections, cards, pills,
     "Ready to watch" tag, TV episode label, loading/error/empty states.
  2. Compute `nowISO` + `todayDateOnly` once per subscription (D5); memoize
     `availability$` per `tmdbId|region` and episode-label streams per `titleId`
     (bounded to gated TV items).
  3. Card tap → `router.navigate(['tabs','title-detail', titleId], { queryParams: { type } })`.
  4. Register icons via `addIcons` (cite exact names). Consume `--vultus-*` tokens
     in SCSS (no hex).
  5. Component tests (see Test plan). Update README with the page's public surface.

- **Task 3 — App-shell wiring: default route + 4th tab [parallel, after 2]**
  (frontend-engineer).
  Manifest: `apps/mobile/src/app/app.routes.ts`,
  `apps/mobile/src/app/tabs/tabs.page.html`,
  `apps/mobile/src/app/tabs/tabs.page.ts`,
  `apps/mobile/src/app/app.spec.ts`,
  `apps/mobile/src/app/tabs/tabs.page.spec.ts`.
  1. `app.routes.ts`: add a `today` child route lazy-loading
     `@vultus/mobile/today` → `TodayPage` (alongside `watchlist`/`search`/
     `settings`/`title-detail`/`notifications`/`settings/plex`); change the inner
     `{ path: '', redirectTo: 'watchlist' }` (line ~71) → `redirectTo: 'today'`;
     change the outer `{ path: '', redirectTo: 'tabs/watchlist' }` (line ~74) →
     `redirectTo: 'tabs/today'`; update the file doc-comment (lines ~7–15) that
     names Watchlist as the default landing tab.
  2. `tabs.page.html`: add `<ion-tab-button tab="today">` as the **FIRST** button
     (icon `today-outline`, label "Today"), before `watchlist`.
  3. `tabs.page.ts`: import + `addIcons({ today… })` the chosen Today icon; update
     the doc-comment (lines ~12–19) to reflect 4 tabs with Today default.
  4. `app.spec.ts` (line ~155): `expect(last?.redirectTo).toBe('watchlist')` →
     `'today'`.
  5. `tabs.page.spec.ts` — **THREE breaking assertions** (verified against the real
     file), all of which must flip, plus two stale test titles: - **Line 21** (test `'renders an ion-tabs with three tab buttons'`, line 14):
     `expect(buttons.length).toBe(3)` → `.toBe(4)`. Also update the now-stale test
     title, e.g. `'renders an ion-tabs with four tab buttons'`. - **Line 32** (test `'targets the watchlist / search / settings routes in order'`,
     line 24): `expect(tabs).toEqual(['watchlist','search','settings'])` →
     `['today','watchlist','search','settings']`. (Its title is also stale — update
     to include `today`, e.g. `'targets the today / watchlist / search / settings
routes in order'`.) - **Line 43** (test `'labels the tabs Watchlist / Search / Settings'`, line 35):
     `expect(labels).toEqual(['Watchlist', 'Search', 'Settings'])` must **prepend**
     `'Today'` → `['Today', 'Watchlist', 'Search', 'Settings']`. Also update the
     stale test title, e.g. `'labels the tabs Today / Watchlist / Search / Settings'`.
     Leaving any of the three assertions on the old count/order/labels fails
     `mobile`'s unit suite.
  6. (Optional) `apps/mobile/src/app/splash/splash.component.spec.ts:27` — the
     `new NavigationEnd(1, '/', '/tabs/watchlist')` payload is an **arbitrary
     sample URL, not a functional dependency** on the default route (verified); it
     does not require changing. Update to `/tabs/today` only for cosmetic
     consistency if desired — it is within this task's `apps/mobile` scope.

- **Task 4 — Onboarding redirect targets + tests + README [parallel, after 2]**
  (frontend-engineer).
  Manifest: `libs/mobile/onboarding/src/lib/onboarding.guard.ts`,
  `libs/mobile/onboarding/src/lib/onboarding.page.ts`,
  `libs/mobile/onboarding/src/lib/onboarding.guard.spec.ts`,
  `libs/mobile/onboarding/src/lib/onboarding.page.spec.ts`,
  `libs/mobile/onboarding/README.md`.
  1. `onboarding.guard.ts`: `reverseOnboardingGuard` redirect (line ~47)
     `createUrlTree(['/tabs/watchlist'])` → `['/tabs/today']`; update its
     doc-comment (line ~34).
  2. `onboarding.page.ts`: BOTH `router.navigate(['/tabs/watchlist'], …)` calls
     (lines ~52 and ~57) → `['/tabs/today']`.
  3. `onboarding.guard.spec.ts`: the test name (line ~99) and assertion (line ~108)
     `toHaveBeenCalledWith(['/tabs/watchlist'])` → `['/tabs/today']`.
  4. `onboarding.page.spec.ts`: both `navigateMock` assertions (lines ~114 and
     ~128) → `['/tabs/today']`.
  5. `README.md`: update the `/tabs/watchlist` references (lines ~20, ~44, ~49) to
     `/tabs/today`.

- **Task 5 — e2e updates + new fixme stubs [parallel, after 2]** (frontend-engineer).
  Manifest: `apps/mobile-e2e/src/app.boot.spec.ts`,
  `apps/mobile-e2e/src/app.smoke.spec.ts`,
  `apps/mobile-e2e/src/onboarding.spec.ts`,
  `apps/mobile-e2e/src/watch-today.spec.ts` (NEW).
  1. `app.boot.spec.ts`: both `toHaveURL(/\/tabs\/watchlist$/)` (lines ~34, ~46) →
     `/\/tabs\/today$/`; `toHaveCount(3)` (line ~49) → `4`; add a `today` tab
     visible + active (selected) assertion coexisting with the existing three. Also
     update the stale default-route **comment** (line ~32) to name `/tabs/today`
     (cosmetic; no assertion-logic change).
  2. `app.smoke.spec.ts`: `toHaveURL(/\/tabs\/watchlist$/)` (line ~29) →
     `/\/tabs\/today$/`; `toHaveCount(3)` (line ~32) → `4`; add `today` visible. Also
     update the stale test **title** `'boots into the tabs shell and lands on
Watchlist'` (line ~25) and the `-> 'tabs/watchlist'` **comment** (line ~28) to
     reflect the new default route (cosmetic; no assertion-logic change) — mirroring
     how this task already updates onboarding's stale names/comments.
  3. `onboarding.spec.ts`: F-onboard-2 `toHaveURL(/\/tabs\/watchlist$/)` (line ~89)
     → `/\/tabs\/today$/`; F-onboard-3 `toHaveURL(/\/tabs\/watchlist$/)` (line ~120)
     → `/\/tabs\/today$/` and `toHaveCount(3)` (line ~123) → `4`; update the test
     names/comments (lines ~60, ~66, ~107, ~109) that say `/tabs/watchlist`.
  4. NEW `watch-today.spec.ts` — `test.fixme` stubs (NOT full tests) for the
     critical Today flows, with the fixme reason inline (mirroring the
     `title-detail.spec.ts` precedent, specs 0034/0047): (a) app boots into
     `/tabs/today` by default with Today active; (b) empty state renders when
     nothing is watchable; (c) a watchable card taps through to title-detail.
     Comment: fixme because exercising real "watchable" data needs emulator seed
     data with synced episodes (spec 0081's `nextUnwatchedEpisodeAirDate` +
     `episodes`), which the current e2e seed fixtures do not provide.

> **Explicit-tab-click e2e specs are NOT affected** (verified): `mark-watched`,
> `title-detail`, `provider-preferences`, `plex-sync`, `plex-provider`, `search`,
> `settings` all click `ion-tab-button[tab="watchlist"]` **explicitly** — the
> watchlist tab still exists, so those clicks still work regardless of the new
> default. Do NOT touch them.

## Test plan

Per the PLAN §5 pyramid. Unit tests run on **Vitest + Analog**; component tests use
Angular TestBed + Ionic with mocked Firestore/service. All Firebase mocked (no
emulator, no network, no secrets).

**Rendered-text assertions (F3 convention):** every component/unit assertion on
rendered UI text asserts the **exact string** — do **NOT** whitespace-normalize
(no `.replace(/\s+/g,' ').trim()`), which would mask a stray-space rendering
defect. Keep component and e2e assertions consistent on the same text.

**Unit — `today.logic.spec.ts`** (deterministic; "now" injected):

- `isMovieWatchableToday`: watching/planned movie with `releaseDate <= todayDateOnly`
  → true; future `releaseDate` → false; `null`/absent `releaseDate` → false;
  `dropped`/`completed` → false regardless of date.
- `isTvWatchableToday`: watching/planned TV with `nextUnwatchedEpisodeAirDate <= nowISO`
  → true; future date → false; `null` → false; `dropped`/`completed` → false.
- **D5 boundary/format guard:** a movie whose `releaseDate` (`'2024-03-15'`) equals
  `todayDateOnly` → watchable (`<=`); a TV `nextUnwatchedEpisodeAirDate`
  (`'2026-01-02T00:00:00.000Z'`) compared against the **full** `nowISO` (not a
  sliced date) — assert a case that would FLIP if the formats were conflated (e.g.
  a TV date earlier today vs a `nowISO` later today).
- `partitionWatchableToday`: mixed set → correct `{ movies, tvShows }`, excluding
  gated/dropped/completed.
- `watchableSubtitle`: `watchableSubtitle(1)` === `'1 thing ready to watch'`;
  `watchableSubtitle(3)` === `'3 things ready to watch'`;
  `watchableSubtitle(0)` === `'0 things ready to watch'` (exact strings).
- `nextEpisodeLabel`: earliest unwatched episode → `'S3E5 available'` (UNPADDED);
  tie on airDate broken by (season, episode) ascending; all-watched / empty →
  `null`.
- `partitionAvailabilityPill`: mine / elsewhere / null cases (mirror watchlist's
  tests).

**Unit — `today.service.spec.ts`** (mocked AngularFire + `AUTH_UID`): `watchlist$`
maps read data → `WatchlistItem[]`; null uid → empty; `userRegion$` maps the user
doc → region; `availability$` maps the availability doc; `readEpisodes` maps
`getDocs` snapshot → `EpisodeDoc[]`.

**Component — `today.page.spec.ts`** (TestBed + mocked service). Assert exact
rendered text throughout:

- Movies section renders only when ≥1 watchable movie; TV section only when ≥1
  watchable TV show; neither → the empty state.
- D2 gate end-to-end: a watching TV show with a **past** `nextUnwatchedEpisodeAirDate`
  is shown; one with a **future** date or `null` is NOT; a watching movie with a
  **past** `releaseDate` is shown; one with a future/missing `releaseDate` is NOT.
- Subtitle shows the exact computed string (e.g. `'3 things ready to watch'`).
- Provider pill (D3): `mine` renders exact `'On Netflix'` + check icon; `elsewhere`
  renders exact `'Also on Netflix'`; `null` renders no pill.
- D4 label (bounded enrichment): a shown TV card renders exact `'S3E5 available'`;
  the enrichment read is invoked **only** for gated TV items (assert
  `readEpisodes` is NOT called for a gated-out or movie item).
- "Ready to watch" tag renders exact `'Ready to watch'` on every shown card.
- Loading → skeleton atom; error → error atom (retry re-subscribes); empty → empty
  atom with the exact authored title/subtitle.
- Card tap navigates to `['tabs','title-detail', titleId]` with `{ queryParams: { type } }`.
- Deterministic clock: fix `now` via `vi.setSystemTime(...)` (or inject a fixed
  now) so the past/future gates are stable.

**Unit — onboarding (Task 4):** `onboarding.guard.spec.ts` asserts
`createUrlTree(['/tabs/today'])`; `onboarding.page.spec.ts` asserts both
`router.navigate` calls use `['/tabs/today']`.

**Unit — app shell (Task 3):** `app.spec.ts` asserts the tabs catch-all
`redirectTo === 'today'`; `tabs.page.spec.ts` asserts **all three** flipped
assertions — tab **count** `4` (was 3, line ~21), tab **order**
`['today','watchlist','search','settings']` (line ~32), and tab **labels**
`['Today','Watchlist','Search','Settings']` (line ~43) — with the two/three stale
test titles updated to name the Today tab.

**e2e (Task 5) — per the rubric this is a `scope:mobile` feature introducing a new
primary route + default landing, so named flows ARE required; but the data-bearing
flows depend on spec 0081 + emulator seed data that doesn't exist yet, so:**

- **REAL (non-fixme) updates** in existing specs — no 0081 data dependency:
  `app.boot`/`app.smoke` (default route now `/tabs/today`; 4 tabs; Today active)
  and `onboarding` (post-onboarding + reverse-guard land on `/tabs/today`; 4 tabs).
  These become DoD gates enforced in CI.
- **Fixme-gated** in new `watch-today.spec.ts`: boots-into-Today, empty-state, and
  card→title-detail flows are `test.fixme` with an inline reason naming spec 0081 +
  the missing emulator "watchable" seed data. The implementer un-skips them when
  that seed data lands (follow-up).
- **Never omitted silently** — this section states all three outcomes.

> **Emulator note (project MEMORY):** the Playwright e2e gate CANNOT run in-session
> (Firestore emulator can't run under Claude Code tools here) but **DOES run in CI**
> against the emulator and is a real PR check — the updated `app.boot`/`app.smoke`/
> `onboarding` assertions must be correct or CI fails. The specs must at minimum
> typecheck/build (`mobile-e2e`).

## Definition of done

Tailored from PLAN §5. Every checkbox maps to a task above (or is an explicit
verify-and-record).

- [ ] **BLOCKING DEPENDENCY (do this first):** confirm spec **0081's feature PR is
      merged and its status is `done`** so `WatchlistItem.nextUnwatchedEpisodeAirDate`
      exists in `libs/shared/domain/src/lib/documents.ts`. **`/implement-feature`
      must NOT start on 0083 before this holds** — otherwise every `mobile/today`
      task fails to typecheck. (Prerequisite for Tasks 1–5.)
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set includes `mobile-today` (new), `mobile` (app), `mobile-onboarding`, and
      `mobile-e2e` (build/typecheck). (Tasks 1–5)
- [ ] **Sheriff clean** (in the lint above): `slice:today` imports only
      `scope:shared` (+ its own slice); **no import of `@vultus/mobile/watchlist`**
      or any other slice; uid via `AUTH_UID`. (Tasks 1, 2)
- [ ] **Unit tests** per the Test plan: logic gate + subtitle + episode label +
      availability partition (Task 1); service mapping (Task 1); page conditional
      rendering + D2 gate + D3 pill + D4 bounded enrichment + states + navigation
      (Task 2); onboarding redirect targets (Task 4); app-shell route + tab-order
      (Task 3). (Tasks 1–4)
- [ ] **Component test** for `TodayPage` (non-trivial state/branching). (Task 2)
- [ ] **e2e:** updated real assertions in `app.boot`/`app.smoke`/`onboarding`
      (default route `/tabs/today`, 4 tabs, Today active); new `watch-today.spec.ts`
      fixme stubs present with inline reasons. `mobile-e2e` typechecks/builds.
      (Task 5)
- [ ] **UI fidelity:** `TodayPage` matches the primary Stitch screen
      (`812340847a604f8a968021183690bf54`) — pinned card/pill/tag/section values,
      all interactive states, `--vultus-*` tokens only (no hex), Inter loaded.
      Visually verify via `pnpm nx run mobile:serve-mock` or explicitly flag
      unverified for a human eyeball (a green build does not prove UI fidelity).
      (Task 2)
- [ ] **READMEs updated:** new `libs/mobile/today/README.md`; updated
      `libs/mobile/onboarding/README.md`. (Tasks 1, 2, 4)
- [ ] **Verify-and-record NO change:** `firestore.rules`, `firestore.indexes.json`
      (reads only, existing rules/no new query), `sheriff.config.ts` (glob
      auto-tags the new lib), `libs/shared/**` (0081 already added the field) — NOT
      modified. Record each as "no change needed" in the PR.
- [ ] **PR description records:** (a) the **blocking 0081 dependency**; (b) the
      verify-and-record no-change items; (c) the two reference Stitch screen IDs and
      which values were screen-pinned vs. token-derived vs. empty-state-authored;
      (d) the intentional deviations — **"View All" omitted** and **tab-ORDER moved
      to leftmost** vs. the reference screen; (e) the **D5 UTC-vs-local** date
      comparison choice; (f) no secret read/written.

## Risks

- **Spec 0081 not yet implemented (the primary risk — state prominently).** This
  spec compiles only once `WatchlistItem.nextUnwatchedEpisodeAirDate` exists on
  `main`. Running `/implement-feature` on 0083 before 0081's feature merges will
  fail typecheck across the new slice. Deliberate, accepted split (interview
  choice), not an oversight. Mitigation: DoD first bullet gates it.
- **D5 date-format trap (the single easiest correctness bug).** `releaseDate` is
  **date-only** (`'2024-03-15'`); `nextUnwatchedEpisodeAirDate` / `EpisodeDoc.airDate`
  are **full datetime** (`'2026-01-02T00:00:00.000Z'`). Slicing one to match the
  other, or deriving one "now" from the other inconsistently, silently mis-gates
  titles near midnight. Mitigation: two separate `now` values (`nowISO` +
  `todayDateOnly = nowISO.slice(0,10)`), lexical `<=`, and a logic test that flips
  if the formats are conflated.
- **D5 UTC vs device-local.** "Now" is UTC (`toISOString()`), matching
  `dispatch-notifications`. A few hours' skew near local midnight (NL UTC+1/+2) is
  an **accepted** tradeoff, not a bug — do not "fix" it to device-local time.
- **D4 two-tier gate-then-enrich.** Use `nextUnwatchedEpisodeAirDate` as the cheap
  bulk gate over the whole watching/planned set (NO per-title episode read), then
  do ONE `episodes` read **only** for the (bounded) TV items that pass the gate, to
  get the S/E label. Two plausible implementer mistakes: (a) skipping the second
  tier (no label), or (b) reading every TV title's episodes (defeating 0081's whole
  reason for existing). The component test asserts `readEpisodes` is called only for
  gated TV items.
- **Deliberate duplication of watchlist's availability logic (D3).** `slice:today`
  re-implements `partitionAvailabilityPill` + the memoized `availability$` pattern
  rather than importing `slice:watchlist` (Sheriff forbids it). This is the **2nd**
  slice doing this — **below** the 3+-slice extract threshold. Do NOT extract to
  `shared/`; a reviewer should not flag the duplication.
- **The e2e ripple is REAL and spans THREE files** (verified current assertions):
  `app.boot.spec.ts` (`/\/tabs\/watchlist$/` ×2, `toHaveCount(3)`),
  `app.smoke.spec.ts` (`/\/tabs\/watchlist$/`, `toHaveCount(3)`), and
  `onboarding.spec.ts` (F-onboard-2 `/\/tabs\/watchlist$/`, F-onboard-3
  `/\/tabs\/watchlist$/` + `toHaveCount(3)`). Leaving any asserting the old route/
  count fails CI once implemented (CI runs e2e against the emulator — a real PR
  check). The decision record enumerated only the first two; `onboarding.spec.ts`
  is the additional one.
- **Five+ hardcoded default/redirect call sites — easy to miss one.** Beyond the
  route file: `app.routes.ts` (inner + outer redirect + comment), `onboarding.guard.ts`
  (+ comment), `onboarding.page.ts` (×2). Plus the **unit-test** assertions the
  decision record did not enumerate: `apps/mobile/src/app/app.spec.ts:155`
  (`redirectTo` === `'watchlist'`) and **THREE** assertions in
  `apps/mobile/src/app/tabs/tabs.page.spec.ts` — tab count `toBe(3)` (line ~21), tab
  order array (line ~32), and tab labels array (line ~43) — all MUST flip (plus their
  stale test titles), or `mobile`'s unit suite fails. The
  `splash.component.spec.ts:27` reference is an arbitrary `NavigationEnd` payload,
  **not** a functional dependency (verified) — no change required.
- **Active-tab capsule embellishment.** The screen renders the active tab as an
  emerald capsule with a shadow; the existing shared shell may render active tabs
  differently. This spec requires matching the **existing** shell treatment (add
  the 4th tab consistently) and flags the capsule as reference intent for human
  review — not a mandated rework of the shared tab bar.
- **No PLAN conflict.** Squarely within the existing PLAN §4 data model
  (`users/{uid}/watchlist` + `episodes` + `title-cache/*/availability`) — a new
  mobile slice + navigation-default re-point, reads only, no new collection/field/
  rule/index/Sheriff change.
