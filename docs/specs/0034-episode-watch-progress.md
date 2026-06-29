---
number: 0034
slug: episode-watch-progress
title: Add episode list and watch-progress tracking to the title-detail slice
status: implementing
slices: [slice:title-detail]
scopes: [scope:mobile, scope:shared]
created: 2026-06-26
---

# Add episode list and watch-progress tracking to the title-detail slice

## Context

Spec 0016 built the `slice:title-detail` per-title detail page (metadata,
regional providers, watchlist actions) but its **locked decision #6 explicitly
deferred episodes + per-episode mark-watched to a future spec**. This is that
spec. PLAN §6 item 19 always scoped `slice:title-detail` to include "an episode
list + per-episode mark-watched"; 0016 carried the metadata/providers/actions
portion and parked the episode portion. This spec completes item 19.

The user need: when a user opens the detail page for a **TV show** they are
tracking, they want to see the show's episodes (grouped by season) and tick off
the ones they've watched, with per-season progress ("Season 1 — 3/10 watched")
and a bulk "mark all" toggle. For a **movie** there are no episodes — they want a
single "Mark as watched" toggle. Marking watch progress should keep the
watchlist **status** in sync automatically (first episode watched → Watching;
all episodes watched → Completed), so the user never has to hand-edit status to
match reality.

Intended outcome: the existing `TitleDetailPage` gains an expanding **Episodes
section** at the bottom (TV only), reading
`users/{uid}/watchlist/{titleId}/episodes/{episodeId}` and writing the
per-episode `watched` field; movies get a **Mark as watched** toggle in the
existing action area that flips the watchlist `status`. This is a **vertical
extension of `libs/mobile/title-detail`** — no new lib, no new route. The only
`scope:shared` change is adding the episode `title` field (the episode subcollection
type already exists in `shared/domain` / `shared/firestore-schema`; only `title`
is missing).

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Episode list lives IN the title-detail page.** An expanding/collapsible
   "Episodes" section at the bottom of the existing `TitleDetailPage`. **No new
   route, no new lib.** A vertical extension of `libs/mobile/title-detail`.

2. **TV shows — season-grouped episode list.**
   - All seasons **expanded by default**; each season individually collapsible.
   - Season heading: **"Season N — X/Y watched"** (e.g. "Season 1 — 3/10
     watched").
   - Per-season bulk **"Mark all watched / Mark all unwatched"** toggle action.
   - Each episode row shows: **episode number, episode title (`title` field),
     air date, and a watched toggle** (checkbox/icon button).
   - Episodes read from `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`.

3. **Movies — single "Mark as watched" toggle.**
   - A **Mark as watched** button/toggle in the existing watchlist action area.
   - Mark watched → `status: 'completed'`; unmark → `status: 'watching'`. **No
     new Firestore fields.**
   - **No-op if current status is `'dropped'`.**
   - The episode section is **hidden** for movies (`type === 'movie'`).

4. **Auto-status update (TV only) — client-side, in `TitleDetailService`,
   AFTER writing the episode `watched` field.**
   - First episode marked watched **AND** current status is `'planned'` → set
     `'watching'`.
   - **All** episodes marked watched **AND** current status is not `'dropped'` →
     set `'completed'`.
   - Unmarking an episode: if **no** episodes remain watched → set `'planned'`
     (only when the slice auto-set it to `'watching'`); otherwise leave as-is.
   - **No-op when status is `'dropped'`** (a dropped title's status is never
     auto-changed by watch progress).

5. **Empty episodes state.** When the episodes subcollection is empty (title not
   yet synced), show a **non-error** empty state in the section:
   "Episodes will appear after the next sync."

6. **e2e flows — emulator-dependent, `test.fixme`-gated.** The Playwright +
   emulator harness **already exists** (spec 0019, `done`): `apps/mobile-e2e`
   has the `webServer`, emulator wiring, and `seeded`/`empty` fixtures. The new
   episode flows are authored in `apps/mobile-e2e/src/title-detail.spec.ts`,
   **extending the existing `describe.fixme` block** there (the title-detail e2e
   block already gated on the episode feature landing). They stay `test.fixme`
   because: (a) the Firestore emulator **cannot run under Claude Code tools**
   (project memory — it must run in the user's own terminal), and (b) the seeded
   fixture (`apps/mobile-e2e/emulator-data/seeded/docs.json`) currently has **no
   episode docs** and needs episode seed data added before the flows can run.
   Named flows:
   - Mark an episode watched → the row shows watched + the season count updates.
   - Season progress display after marking multiple episodes.
   - Mark a movie as watched → status changes to `'completed'`.

7. **Shared domain / firestore-schema — reuse what exists; add only `title`.**
   **Verified against main:** `EpisodeDoc`, `EpisodeReadData`/`EpisodeWriteData`,
   the `episodeToData`/`dataToEpisode` converters, and the `episodesPath` /
   `episodePath` path helpers **already exist** in `@vultus/shared/domain` and
   `@vultus/shared/firestore-schema` (added by spec 0005). **Do NOT duplicate
   them.** The **only** gap: `EpisodeDoc` carries `{ season, episode, airDate,
watched, watchedAt }` but **no `title`** — decision 2 needs the per-episode
   title. So this spec adds a **single nullable field `title: string | null`** to
   `EpisodeDoc` + its read/write data types + both converters (`scope:shared`).
   No other shared change.

8. **Stitch screen.** The relevant detail screen is **"Movie Detail - Vultus"**
   (`208cb8d7a679490b8d13672c6943d6d3`, project
   `projects/13590348714018893783`) — the same screen 0016 pinned. **It does NOT
   contain a season-grouped episode list** (it is a movie-detail mock). There is
   **no dedicated episode-list Stitch screen** in the project. Per the brief's
   decision 8 ("if the Stitch screen doesn't have an episode list, describe the
   component structure concisely and flag it for human visual verification"), the
   episode section UI below is **derived from the in-repo design system**
   (`docs/design/vultus-design-system.md`) and the existing `glass-panel` /
   collapsible patterns already in `title-detail.page.scss`, and is **flagged for
   human visual verification** (see UI section + DoD). The Stitch MCP is reachable
   from the orchestrator (project memory); the implementer **MUST still re-fetch
   `208cb8d7a679490b8d13672c6943d6d3`** to confirm the hero/action-area tokens the
   episode section inherits, and **record the screen id in the PR**.

9. **Sheriff / scope.** All episode-read and episode-write logic stays within
   `slice:title-detail`. **No cross-slice import.** The `EpisodeDoc.title`
   addition + converter change are `scope:shared` (importable by anyone — rule 4).

10. **Out of scope** (each a future spec):
    - Notification deep-link into the episode list.
    - In-app notification inbox.
    - Provider logos.
    - Any new route/page for episodes (the section is in-page).
    - **Any change to the sync engine or `scope:functions`** — including
      populating the episode subcollection or backfilling `EpisodeDoc.title`
      (see Risks: the subcollection is currently un-written; this spec **reads**
      it and degrades to the empty state).

## Scope

In scope:

- A **single `scope:shared` field addition:** `EpisodeDoc.title: string | null`
  in `libs/shared/domain` + `EpisodeReadData`/`EpisodeWriteData.title` in
  `libs/shared/firestore-schema` + the `episodeToData`/`dataToEpisode` converter
  mappings (pass-through, default `null`). Update both lib READMEs + the schema
  unit test.
- **`TitleDetailService` extension** (`libs/mobile/title-detail`): a realtime
  `episodes$(tmdbId)` stream over `users/{uid}/watchlist/{titleId}/episodes`, a
  `setEpisodeWatched(...)` write (single episode), a `setSeasonWatched(...)` bulk
  write, the **TV auto-status logic** (decision 4) run after the episode write,
  and a **movie `setMovieWatched(...)`** that flips the watchlist `status`
  (decision 3). All uid-guarded; no cross-slice import; no `title-cache` /
  functions write.
- **`TitleDetailPage` extension** (`libs/mobile/title-detail`): an expanding
  **Episodes section** (TV only) — season groups (collapsible, expanded by
  default), per-season "Season N — X/Y watched" heading + bulk toggle, per-
  episode rows (number, title, air date, watched toggle), the **empty** state,
  and a **loading skeleton** for the section; plus a **Mark as watched** toggle
  in the action area for **movies**. The episode section is **hidden** for
  movies and **omitted** for the not-found/error/loading detail states.
- Tests: shared converter unit (the new `title` field), service unit (episode
  stream + writes + auto-status + movie-watched), page component (episode
  section states + movie toggle), and the three `test.fixme` e2e stubs.

Out of scope:

- **Writing/backfilling the episode subcollection or `EpisodeDoc.title` from the
  sync engine** — `scope:functions` / sync-engine concern (a separate spec). The
  sync engine **currently writes NO episodes** (verified — see Risks); this spec
  **reads** the subcollection and shows the empty state when it is empty.
- **A new route/page for episodes** — the section is in the existing page.
- **Notification deep-link / inbox, provider logos** — future specs.
- **Any `scope:functions`, `firestore.rules`, `firestore.indexes.json`,
  `ci.yml`, `playwright.config.ts` change** (verify-and-record; see Data model).

## Affected slices & Sheriff tags

| Project                 | Path                           | Sheriff tags                         | Change                                                                                                                                   |
| ----------------------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| shared-domain           | `libs/shared/domain`           | `scope:shared`                       | Add `title: string \| null` to `EpisodeDoc`; README + spec update                                                                        |
| shared-firestore-schema | `libs/shared/firestore-schema` | `scope:shared`                       | Add `title` to `EpisodeReadData`/`EpisodeWriteData`; map it in `episodeToData`/`dataToEpisode`; README + spec update                     |
| mobile-title-detail     | `libs/mobile/title-detail`     | `scope:mobile`, `slice:title-detail` | Extend `TitleDetailService` (episodes stream + writes + auto-status + movie-watched), `TitleDetailPage` (episode section + movie toggle) |

- **Import boundaries (verified against the spec-0010/0016 Sheriff rules):**
  - `libs/mobile/title-detail` (`slice:title-detail`) is governed by
    `'slice:*': ['scope:shared', sameTag]` — it imports **only** `scope:shared`
    and its own slice. The episode work adds imports of `EpisodeDoc`
    (`@vultus/shared/domain`) and `episodesPath` / `episodePath` /
    `dataToEpisode` / `episodeToData` (`@vultus/shared/firestore-schema`) — **both
    `scope:shared`, allowed (rule 4)**. AngularFire (`collectionData`, `setDoc`,
    `updateDoc`, `writeBatch`), `@ionic/*`, `ionicons`, `rxjs` are third-party,
    not policed by Sheriff. **No new slice import** (`slice:search`/`watchlist`/
    `settings`), **no `apps/mobile` deep import** (uid still via `AUTH_UID`), **no
    `scope:functions` import**.
  - The `shared/domain` + `shared/firestore-schema` additions are `scope:shared`
    — importable by anyone, no new boundary.
- **No `shared/` extraction of slice logic.** The episode stream, the watched
  writes, the per-season grouping/counting, and the auto-status rules live
  **inside** `libs/mobile/title-detail` — one consumer (this slice), far short of
  the 3+-slice rule (CLAUDE.md / PLAN §3). Only the **`EpisodeDoc` type + its
  converter** are shared, and they already exist; this spec adds **one field** to
  them, not a new shared module.
- **No `sheriff.config.ts` change.** No new lib is generated; the existing globs
  already tag `libs/mobile/title-detail/src` and both `libs/shared/*/src`. Record
  "no `sheriff.config.ts` change needed" in the PR.

## Data model touchpoints

PLAN §4 paths. The **only** new field anywhere is `EpisodeDoc.title`; all other
access reuses merged shapes.

| PLAN §4 path                                            | Access by this slice                                   | Fields / note                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}/episodes` (collection) | **read (realtime, TV only)**                           | each `EpisodeDoc`: `season`, `episode`, **`title` (NEW)**, `airDate`, `watched`, `watchedAt`              |
| `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`  | **update** (single), **update** (bulk per-season)      | write only `{ watched, watchedAt }` (`watchedAt = now ISO` on mark, `null` on unmark) via `episodeToData` |
| `users/{uid}/watchlist/{titleId}` (doc)                 | **read (realtime, already wired)**, **update(status)** | tracked state (0016's `tracked$`); auto-status (TV) + movie mark-watched write `{ status }`               |
| `title-cache/**`                                        | **none new**                                           | unchanged from 0016 (read-only metadata/providers)                                                        |

- **Episode read (decision 2, TV only).** Subscribe to `episodesPath(uid,
String(tmdbId))` via AngularFire `collectionData` (with `idField` for the
  episode doc id), map each doc with `dataToEpisode`, **group by `season`**, and
  **sort by `episode`** within a season (and seasons ascending). The episode doc
  id convention written by the (future) sync engine is **not relied on for
  ordering** — order by the `season`/`episode` fields, not the doc id. A
  **null/unset uid** or **non-TV** title → the stream emits `[]` (drives the
  hidden/empty UI).
- **Episode write (decisions 2–4).** A single episode toggle writes
  `{ watched, watchedAt }` at `episodePath(uid, String(tmdbId), episodeId)` via
  `updateDoc` (not `setDoc` — the doc already exists from sync; **do not create
  episode docs from the client**). `watchedAt = new Date().toISOString()` on
  mark, `null` on unmark. The bulk per-season toggle writes the same shape to
  **every episode doc in that season** — use a **`writeBatch`** so the season
  flips atomically (decision 2's "Mark all"). **Build the wire payload via
  `episodeToData` on a full `EpisodeDoc`**, or write the two coerced fields
  directly (`watched`, `watchedAt: Date | null`) — do not hand-roll a Timestamp.
- **Auto-status write (decision 4, TV only).** After the episode write resolves,
  compute the new watched-count across the just-written state and read the
  current `status` from the realtime `tracked$`/last-known watchlist doc:
  - 0 → ≥1 watched and `status === 'planned'` → `updateStatus(tmdbId,
'watching')`.
  - all episodes watched and `status !== 'dropped'` → `updateStatus(tmdbId,
'completed')`.
  - back to 0 watched, and the slice had auto-set `'watching'` → `updateStatus(tmdbId,
'planned')`; else leave as-is.
  - `status === 'dropped'` → **no auto-status write**.
    Reuse the **existing `updateStatus`** write path (0016); do not add a new write
    target. "Whether the slice auto-set watching" is tracked **in-service** (a
    flag / derivation from prior state) — it does **not** add a Firestore field.
- **Movie mark-watched write (decision 3).** `updateStatus(tmdbId, 'completed')`
  on mark, `updateStatus(tmdbId, 'watching')` on unmark, **no-op when the current
  status is `'dropped'`**. No new field; reuses 0016's `updateStatus`.
- **No `firestore.rules` change — VERIFY and RECORD.** The merged rules grant
  **owner-only read/write** on `users/{userId}/{document=**}`, which already
  covers the `episodes` subcollection read + the per-episode `watched` updates
  and the status update. The implementer **verifies** this block is present
  (`firestore.rules` — the `users/{userId}/{document=**}` recursive match) and
  **records "no `firestore.rules` change needed"** in the PR. Do **NOT** edit it.
- **No `firestore.indexes.json` change.** The episode read is a single-collection
  subscription with **no compound `where`/`orderBy`** (grouping + sorting happen
  client-side, in memory, over one show's episodes). Record "no index change
  needed". Do **NOT** edit it.

## Public types / APIs

No HTTP endpoint, no callable. **One shared field addition; the rest is
slice-local service surface.**

### Shared change — `EpisodeDoc.title` (`@vultus/shared/domain` + `@vultus/shared/firestore-schema`)

`libs/shared/domain/src/lib/documents.ts` — add `title` to `EpisodeDoc`:

```ts
// users/{userId}/watchlist/{titleId}/episodes/{episodeId} — tv only.
export interface EpisodeDoc {
  season: number;
  episode: number;
  title: string | null; // NEW (spec 0034) — episode title; null when unknown / not yet synced
  airDate: string; // ISO 8601
  watched: boolean;
  watchedAt: string | null; // ISO 8601 or null
}
```

`libs/shared/firestore-schema/src/lib/data-types.ts` — add `title` to **both**
`EpisodeReadData` and `EpisodeWriteData` (`title: string | null`).

`libs/shared/firestore-schema/src/lib/converters.ts` — map `title` (pass-through,
default `null`) in **both** directions:

```ts
export function episodeToData(ep: EpisodeDoc): EpisodeWriteData {
  return {
    season: ep.season,
    episode: ep.episode,
    title: ep.title ?? null,
    airDate: new Date(ep.airDate),
    watched: ep.watched,
    watchedAt: ep.watchedAt === null ? null : new Date(ep.watchedAt),
  };
}
export function dataToEpisode(data: EpisodeReadData): EpisodeDoc {
  return {
    season: data.season,
    episode: data.episode,
    title: data.title ?? null,
    airDate: data.airDate.toDate().toISOString(),
    watched: data.watched,
    watchedAt:
      data.watchedAt === null ? null : data.watchedAt.toDate().toISOString(),
  };
}
```

- **Backward-compatible:** `title` is nullable and defaulted via `?? null`, so a
  stored episode doc **without** a `title` field (everything written before this
  spec — though nothing writes episodes yet, see Risks) reads back as
  `title: null`. **No migration, no functions change.**

### Slice-local additions — `TitleDetailService` (`src/lib/title-detail.service.ts`)

Append these to the existing service (signatures are **binding intent**; exact
names are a recommendation):

```ts
/** A season group for the episode list: episodes for one season, sorted by
 *  episode number, with a derived watched count. Slice-local view model. */
export interface SeasonGroup {
  season: number;
  episodes: EpisodeRow[]; // sorted by episode asc
  watchedCount: number; // episodes.filter(e => e.watched).length
  total: number; // episodes.length
  allWatched: boolean; // watchedCount === total && total > 0
}

/** One episode row (the EpisodeDoc + its Firestore doc id for the write). */
export interface EpisodeRow extends EpisodeDoc {
  id: string; // the episode doc id (idField) — the write target
}

class TitleDetailService {
  /** Realtime episodes for a TV title, grouped by season (ascending) and sorted
   *  by episode within a season. Emits [] for a movie, a null uid, or an empty
   *  subcollection (drives the hidden/empty UI). Never creates docs. */
  episodes$(tmdbId: number, type: TitleType): Observable<SeasonGroup[]>;

  /** Mark/unmark a single episode: update { watched, watchedAt } at
   *  episodePath(uid, String(tmdbId), episodeId). Then run the TV auto-status
   *  rules (decision 4). No-op when uid null. */
  setEpisodeWatched(
    tmdbId: number,
    episodeId: string,
    watched: boolean,
  ): Promise<void>;

  /** Bulk mark/unmark every episode in a season (writeBatch). Then run the TV
   *  auto-status rules (decision 4). No-op when uid null. */
  setSeasonWatched(
    tmdbId: number,
    season: number,
    watched: boolean,
  ): Promise<void>;

  /** Movie mark-watched (decision 3): updateStatus 'completed' (mark) /
   *  'watching' (unmark). No-op when uid null OR current status is 'dropped'. */
  setMovieWatched(tmdbId: number, watched: boolean): Promise<void>;
}
```

- **Auto-status (decision 4) is a private helper** invoked after the episode
  write resolves; it reuses the existing `updateStatus(tmdbId, status)` write
  path and is a **no-op when status is `'dropped'`**. The "slice auto-set
  watching" memory is held **in-service** (a per-title flag), not a Firestore
  field.
- **`SeasonGroup` / `EpisodeRow` are exported from the barrel only if** the page
  composition or a test needs them across the barrel; otherwise keep them
  slice-internal. The barrel surface from 0016 (`TitleDetailPage`,
  `TMDB_DETAIL_CONFIG`, `TmdbDetailConfig`) is otherwise **unchanged**.

### `TitleDetailPage` additions (`src/lib/title-detail.page.*`)

- A `episodes$` view stream (TV only) folded into the existing `vm$` (or a
  sibling async pipe), plus public, template-bound methods:
  `toggleEpisode(row, watched)`, `toggleSeason(group)`,
  `toggleSeasonCollapsed(season)` (UI-only collapse state), and
  `toggleMovieWatched(tracked)` — **public methods, not inline handlers**, so the
  component test invokes them deterministically (the 0016 `openStatusSheet`
  convention).
- Per-season **collapse state** is **UI-only local state** (a `Set<number>` of
  collapsed seasons) — it is **not** persisted to Firestore.

## UI / Stitch screen refs

This is a mobile slice; the host page's visual contract is the Stitch screen
**"Movie Detail - Vultus"** (`208cb8d7a679490b8d13672c6943d6d3`, project
`projects/13590348714018893783`) — the screen 0016 pinned. **That screen does
NOT contain a season-grouped episode list** (it is a movie mock), and **no
dedicated episode-list screen exists** in the project (decision 8). The episode
section below is therefore **derived from the in-repo design system**
(`docs/design/vultus-design-system.md`, the authoritative token set) and the
**existing `glass-panel` card pattern already in `title-detail.page.scss`**, and
is **flagged for human visual verification** (DoD). **Stitch screen NOT captured
for the episode list — not blocking** (no such screen to capture; the structure
below is design-system-derived). The implementer **MUST still re-fetch
`208cb8d7a679490b8d13672c6943d6d3`** (retry on MCP failure — the MCP is reachable
per project memory) to confirm the hero/action-area tokens the section inherits,
and **record the screen id in the PR**.

**Token source of truth:** consume the wired `--vultus-*` / `--ion-*` CSS custom
properties from `shared/ui-kit` `theme.scss`; **never hardcode a hex.** The
existing page already consumes these (e.g. `--vultus-status-*`, `glass-panel`).

### Episode section — structure & concrete contract (each row a checkable item)

The Episodes section is a **`glass-panel` card** matching the existing Synopsis /
Where-to-Watch cards (same fill/border/`blur(12px)`/`padding 24px`
(`--vultus-space-lg`)/`--vultus-radius-md`), placed **after** the Where-to-Watch
card, **rendered only when `detail.type === 'tv'`** and the detail state is
`loaded`.

1. **Card heading** — `headline-sm` (20/600/28), text `--ion-color-primary`,
   leading list/film ionicon (reuse `list-outline` or similar), label "Episodes".
   Matches the existing `.card-heading` style.
2. **Season group** — one per season, ascending. Each group:
   - **Season heading row** (tappable, toggles collapse): left = **"Season N"**
     (`body-lg` 16/600, `--vultus-on-surface`); right = **"X/Y watched"**
     (`label-md` 12/600 +0.05em uppercase, `--vultus-on-surface-variant`) + a
     **chevron** glyph that rotates on collapse (`chevron-down-outline` →
     rotated when expanded). **Row min-height 48px** (touch target), horizontal
     padding aligned to the card padding (no extra inset beyond the card's 24px).
   - A **per-season bulk toggle**: a small text/icon control reading **"Mark all
     watched"** when not all watched, **"Mark all unwatched"** when
     `group.allWatched`. `label-md`, `--ion-color-primary` text. Placed in the
     season heading row (right of the count, before the chevron) or directly
     under it — must be a **distinct tap target** from the collapse chevron
     (its `(click)` calls `$event.stopPropagation()` so it does not also toggle
     collapse).
3. **Episode rows** (shown when the season is expanded) — each a flex row,
   **min-height 56px**, vertical padding `--vultus-space-sm` (8px), aligned to
   the season heading's left edge (sibling alignment — episode number, title,
   and date all start at the same inset; the watched toggle is right-aligned):
   - **Episode number** — a fixed-width lead (`body-md` 14/600,
     `--vultus-on-surface-variant`), e.g. "E3" or "3".
   - **Episode title** (`row.title`) — `body-md` (14/400/20),
     `--vultus-on-surface`, ellipsised on overflow; **fallback "Episode N"** when
     `title` is null.
   - **Air date** — `label-sm` (11/500/16), `--vultus-on-surface-variant`,
     formatted from `airDate` (e.g. "Jan 5, 2026"); **omit** when `airDate` is
     blank.
   - **Watched toggle** — a 24px square checkbox/icon button, right-aligned.
     **Unchecked:** outline glyph (`square-outline` / `ellipse-outline`), border
     `--vultus-outline-variant`. **Checked:** filled glyph
     (`checkbox` / `checkmark-circle`), `--ion-color-primary` (`#4edea3`).
     `aria-label` "Mark episode N watched/unwatched". Tap → `toggleEpisode(row,
!row.watched)`.

### View / interactive states (each a checkable acceptance item)

- **Hidden (movie):** when `detail.type === 'movie'`, the **entire Episodes
  section is not rendered** (no empty card). Verify in the component test.
- **Loading skeleton (episode section):** while `episodes$` has not emitted (and
  the detail is `loaded` + TV), render `ion-skeleton-text` rows inside the card
  (a season heading + ~3 episode-row skeletons) — **not** the empty copy. Reuse
  `ion-skeleton-text` (the page already uses the ui-kit skeleton for the hero).
- **Empty (decision 5):** TV title, `episodes$` emitted `[]` (subcollection
  empty / not yet synced) → a muted line **"Episodes will appear after the next
  sync."** (`body-md`, `--vultus-on-surface-variant`) inside the card. **Not an
  error.**
- **Collapsed / expanded season:** expanded by default; tapping the season
  heading toggles. Collapsed → episode rows hidden, chevron points down/right;
  expanded → rows shown, chevron rotated. **UI-only state** (a `Set<number>`),
  not persisted.
- **Unchecked episode → checked:** tapping the toggle calls `toggleEpisode`; the
  realtime `episodes$` re-emits with `watched: true` and the row + the season
  count update (X→X+1). Pressed feedback: the toggle uses the page's existing
  button press affordance (`active:scale-[0.98]` convention) — note as a
  simplification if Ionic defaults override.
- **Bulk "Mark all watched/unwatched":** tapping flips every episode in the
  season (writeBatch); the season count jumps to Y/Y (or 0/Y) and the label
  swaps. The control's `(click)` **stops propagation** so collapse does not also
  toggle.
- **Movie "Mark as watched" toggle (action area):** rendered **only for
  `type === 'movie'`** alongside the existing tracked status control. **Off**
  (status ≠ `'completed'`): label "Mark as watched", outlined/`--ion-color-primary`.
  **On** (status === `'completed'`): label "Watched" / filled-primary check.
  **Disabled when status is `'dropped'`** (decision 3 no-op) — show it disabled
  (reduced opacity, no tap), do not silently swallow taps. Tap →
  `toggleMovieWatched(tracked)`.

### Token wiring (easy to miss)

- Consume `--vultus-*` / `--ion-*` from `theme.scss`; the checked toggle is
  `--ion-color-primary` (`#4edea3`), **not** `#10B981` (that is
  `--vultus-status-completed`, used only for the completed status accent).
- **Inter must be LOADED** (already loaded by `apps/mobile/src/index.html` per 0016) and the **icon font loaded** — the new chevron/checkbox glyphs must
  actually render, not just be named.
- For focus, rely on Ionic's default `:focus-visible` ring (no `--vultus-focus*`
  token exists — ui-kit owns adding one; do not invent inline).

## Implementation task graph

The shared `EpisodeDoc.title` addition is a **prerequisite** for the slice's
episode mapping (the service `dataToEpisode` consumes the new field and the row
renders `title`). Task 1 (`scope:shared`) is **[sequential]** and must land
first. Tasks 2–3 (the slice service + page) **share `title-detail.service.ts` /
the page composition / `index.ts`** and are **[sequential]** relative to each
other. Tests (task 4) depend on 1–3.

> **Manifest disjointness assertion (for the orchestrator):** there is **no
> [parallel] task** in this spec. Task 1 writes only `libs/shared/domain/**` +
> `libs/shared/firestore-schema/**`; tasks 2–4 write only
> `libs/mobile/title-detail/**` plus (task 4) `apps/mobile-e2e/src/title-detail.spec.ts`
>
> - `apps/mobile-e2e/emulator-data/seeded/docs.json`. The file sets are disjoint,
>   but tasks 2–4 depend on task 1's shared field, so the whole graph is sequential.
>   No two tasks write the same file.

1. **[sequential] Shared `EpisodeDoc.title` field (`scope:shared`).**
   backend-engineer / shared-types owner.
   - `libs/shared/domain/src/lib/documents.ts`: add `title: string | null` to
     `EpisodeDoc`.
   - `libs/shared/firestore-schema/src/lib/data-types.ts`: add `title: string |
null` to `EpisodeReadData` + `EpisodeWriteData`.
   - `libs/shared/firestore-schema/src/lib/converters.ts`: map `title` (`?? null`)
     in `episodeToData` + `dataToEpisode`.
   - Update `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts` (and
     the domain spec if it asserts the episode shape) to cover the round-trip of
     `title` (incl. the `null` default for a doc missing the field).
   - Update `libs/shared/domain/README.md` + `libs/shared/firestore-schema/README.md`
     if they enumerate `EpisodeDoc`'s fields.
   - Files: `libs/shared/domain/src/lib/documents.ts`,
     `libs/shared/domain/README.md`,
     `libs/shared/firestore-schema/src/lib/data-types.ts`,
     `libs/shared/firestore-schema/src/lib/converters.ts`,
     `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
     `libs/shared/firestore-schema/README.md`,
     (optionally `libs/shared/domain/src/lib/domain.spec.ts`).

2. **[sequential] `TitleDetailService` episode + movie-watched logic. Depends on
   task 1.** frontend-engineer.
   - Add `episodes$(tmdbId, type)` (realtime `collectionData` over
     `episodesPath`, `idField` for the doc id, `dataToEpisode` map, group by
     season + sort by episode, derive `watchedCount`/`total`/`allWatched`; `[]`
     for movie / null uid / empty).
   - Add `setEpisodeWatched` (single `updateDoc` of `{ watched, watchedAt }`),
     `setSeasonWatched` (`writeBatch` over the season), and the private
     **auto-status** helper (decision 4, reusing `updateStatus`, no-op on
     `'dropped'`, in-service "auto-set watching" memory).
   - Add `setMovieWatched` (decision 3: `updateStatus` 'completed'/'watching',
     no-op on `'dropped'`/null uid).
   - Export `SeasonGroup`/`EpisodeRow` from `src/index.ts` only if the page/test
     needs them across the barrel.
   - Files: `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
     `libs/mobile/title-detail/src/index.ts`.

3. **[sequential] `TitleDetailPage` episode section + movie toggle + README.
   Depends on task 2.** frontend-engineer.
   - Template (`title-detail.page.html`): the TV-only Episodes `glass-panel`
     (season groups, collapsible, per-season heading + count + bulk toggle,
     episode rows with number/title/airDate/watched toggle), the section
     **loading skeleton** + **empty** state; the movie **Mark as watched** toggle
     in the action area (disabled on `'dropped'`).
   - Component (`title-detail.page.ts`): fold `episodes$` into the vm; add public
     `toggleEpisode`, `toggleSeason`, `toggleSeasonCollapsed`,
     `toggleMovieWatched`; the UI-only collapsed-season `Set<number>`; register
     the new ionicons (chevron/checkbox/list glyphs).
   - Styles (`title-detail.page.scss`): episode-section rows, season heading,
     toggle states (unchecked/checked), chevron rotation — consuming `--vultus-*`
     tokens, reusing the `glass-panel` pattern.
   - Update `libs/mobile/title-detail/README.md`: the page now also shows a TV
     episode list + per-episode watched + a movie mark-watched toggle; the
     service's new episode/movie-watched surface; still **no shared extraction**
     of episode logic; Sheriff tags unchanged.
   - **Re-fetch the Stitch screen `208cb8d7a679490b8d13672c6943d6d3`** to confirm
     the inherited hero/action-area tokens, and **visually verify** the episode
     section (render/screenshot or `nx serve mobile --configuration=mock`) — the
     episode list has no Stitch screen, so this is **flagged for human eyeball**
     (DoD).
   - Files: `libs/mobile/title-detail/src/lib/title-detail.page.html`,
     `libs/mobile/title-detail/src/lib/title-detail.page.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.scss`,
     `libs/mobile/title-detail/README.md`.

4. **[sequential] Tests. Depends on tasks 1–3.** frontend-engineer / qa-runner.
   - Shared converter unit (task 1's spec file — covered in task 1, re-verified
     here).
   - Service unit (`title-detail.service.spec.ts`): episode grouping/sorting/
     counts, single + bulk writes, auto-status transitions (incl. dropped no-op
     - back-to-planned), movie mark-watched (incl. dropped no-op), null-uid /
       movie → `[]`.
   - Component (`title-detail.page.spec.ts`): episode section hidden for movie,
     loading skeleton, empty state, collapse toggle, episode toggle calls
     `setEpisodeWatched`, season bulk calls `setSeasonWatched` (and does not
     toggle collapse), movie toggle calls `setMovieWatched` + disabled on
     dropped.
   - `apps/mobile-e2e`: **three `test.fixme`** stubs (decision 6) — mark episode
     watched + count update; multi-episode season progress; movie mark-watched →
     completed — authored in `apps/mobile-e2e/src/title-detail.spec.ts` by
     **extending the existing `describe.fixme` block** (the pattern to follow is
     the current `describe.fixme` in that file, ~line 167). Each carries a comment
     stating the un-skip blockers: (a) the emulator must run in the user's own
     terminal (cannot run under Claude Code tools), and (b) episode seed docs must
     be added to `apps/mobile-e2e/emulator-data/seeded/docs.json`.
   - Add the episode seed docs to `apps/mobile-e2e/emulator-data/seeded/docs.json`
     (the seeded fixture has no episode docs today) so the flows can run once the
     emulator is started locally.
   - Files: `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`,
     `apps/mobile-e2e/src/title-detail.spec.ts` (extend the existing
     `describe.fixme` block — `test.fixme` stubs only; **no `playwright.config.ts`
     change**),
     `apps/mobile-e2e/emulator-data/seeded/docs.json` (add episode seed docs).

(All slice internals stay under `libs/mobile/title-detail/**`; the shared field
is the only `libs/shared/**` touch; the only `apps/mobile-e2e` touches are the
`test.fixme` stubs in `src/title-detail.spec.ts` and the episode seed docs added
to `emulator-data/seeded/docs.json`. **No `firestore.rules`, `firestore.indexes.json`,
`sheriff.config.ts`, `ci.yml`, `playwright.config.ts`, `libs/functions/**`, or any
`scope:functions`file is touched.** Symbol/file names are recommendations; the
binding contracts are the`EpisodeDoc.title`field, the realtime episode read +
client`watched` writes, the TV auto-status rules, the movie mark-watched status
flip, and the no-functions-write / no-cross-slice / no-episode-doc-create
guardrails.)

## Test plan

Per the PLAN §5 pyramid — real logic, so **unit** (shared converter + service),
a **component** test (the page's episode section + movie toggle states), and
**`test.fixme`-gated e2e** (decision 6). All Firebase access is **mocked** (no
live Firebase, no emulator, no network, no secrets). The green CI gate is
**lint + typecheck + unit + component + build** (what `ci.yml` runs).

**Unit — shared converter (`firestore-schema.spec.ts`, Vitest):**

- `episodeToData` carries `title` through; `dataToEpisode` reads it back; a
  read-data **missing** `title` → `dataToEpisode` yields `title: null`
  (backward-compat). The existing `season`/`episode`/`airDate`/`watched`/
  `watchedAt` round-trips remain green.

**Unit — `TitleDetailService` (`title-detail.service.spec.ts`, Vitest, mocked
AngularFire + mocked `AUTH_UID`):**

- **Episode grouping:** a mocked `collectionData` over `episodesPath` with mixed
  seasons/episodes → `episodes$` emits `SeasonGroup[]` ordered by season asc,
  episodes by `episode` asc, with correct `watchedCount`/`total`/`allWatched`.
- **Movie / null-uid / empty → `[]`:** `episodes$(tmdbId, 'movie')` emits `[]`
  (no subscription); null uid → `[]`; empty subcollection → `[]`.
- **Single write:** `setEpisodeWatched(tmdbId, episodeId, true)` updates
  `{ watched: true, watchedAt: <Date> }` at `episodePath(...)`; `false` →
  `watchedAt: null`. **Uses `updateDoc`, never `setDoc`** (no doc creation).
- **Bulk write:** `setSeasonWatched(tmdbId, season, true)` writes every episode
  doc in that season via a **batch**; the count flips to Y/Y.
- **Auto-status (decision 4):** from `planned` + first episode marked →
  `updateStatus(..., 'watching')`; all watched (not dropped) →
  `updateStatus(..., 'completed')`; back to 0 watched after the slice auto-set
  watching → `updateStatus(..., 'planned')`; **`dropped` → NO `updateStatus`
  call** (assert not called).
- **Movie mark-watched (decision 3):** `setMovieWatched(tmdbId, true)` →
  `updateStatus(..., 'completed')`; `false` → `'watching'`; current status
  `'dropped'` → **no-op** (assert `updateStatus` not called); null uid → no-op.
- **No write outside the episodes/watchlist docs:** every mocked write targets
  `episodePath(uid, …)` (watched) or `watchlistItemPath(uid, …)` (status) —
  **never `title-cache`, never another slice's data, never an episode doc
  create.**

**Component (`title-detail.page.spec.ts`, Angular TestBed + Ionic; service
mocked; `ActivatedRoute` providing a `:titleId`):**

- **Movie → section hidden:** a `loaded` movie renders **no** Episodes card; the
  **Mark as watched** toggle renders in the action area.
- **TV → section shown:** a `loaded` tv with `episodes$` season groups renders
  the card, season headings ("Season N — X/Y watched"), and episode rows
  (number, title-or-"Episode N" fallback, air date, toggle).
- **Loading skeleton:** TV `loaded`, `episodes$` not yet emitted → skeleton rows,
  not the empty copy.
- **Empty state (decision 5):** TV `loaded`, `episodes$` → `[]` → "Episodes will
  appear after the next sync." (not an error).
- **Episode toggle:** tapping a row's toggle calls `setEpisodeWatched(row.id,
!watched)`.
- **Season bulk + collapse:** the bulk control calls `setSeasonWatched(season,
…)` and does **not** toggle collapse (stopPropagation); the heading tap toggles
  collapse (rows hide/show) and persists nothing to Firestore.
- **Movie toggle:** tapping calls `setMovieWatched`; when the tracked status is
  `'dropped'` the toggle is **disabled** (no call).

**e2e (`test.fixme` — decision 6):** three Playwright stubs authored in
`apps/mobile-e2e/src/title-detail.spec.ts`, **extending the existing
`describe.fixme` block** in that file (~line 167 — that block is the pattern to
follow). The Playwright + emulator harness already exists (spec 0019, `done`):
`webServer`, emulator wiring, and `seeded`/`empty` fixtures are in place. The
stubs stay `test.fixme` for two reasons, named in each comment: (a) the Firestore
emulator **cannot run under Claude Code tools** (must run in the user's own
terminal — project memory), and (b) the seeded fixture
(`apps/mobile-e2e/emulator-data/seeded/docs.json`) has **no episode docs** and
needs episode seed data added.

- Mark an episode watched → the row shows watched + the season count updates.
- Season progress display after marking multiple episodes.
- Mark a movie as watched → status changes to `'completed'`.

To un-skip: add the episode seed docs to
`apps/mobile-e2e/emulator-data/seeded/docs.json` (included in task 4), then run
the suite against the emulator in a local terminal. **No `playwright.config.ts`
change here.**

## Definition of done

Tailored from the PLAN §5 checklist. Green gate is **lint + typecheck + unit +
component + build** (what `ci.yml` runs); the emulator-backed episode e2e flows
are `test.fixme` because the emulator cannot run under Claude Code tools and the
seeded fixture needs episode docs added (decision 6).

- [ ] `pnpm nx run-many -t lint test -p shared-domain shared-firestore-schema
  mobile-title-detail` passes **with Sheriff active**: the slice imports
      `@vultus/shared/domain` (`EpisodeDoc`, `TitleType`, `WatchStatus`,
      `WatchlistItem`) + `@vultus/shared/firestore-schema` (`episodesPath`,
      `episodePath`, `dataToEpisode`, `episodeToData`) + AngularFire/Ionic/rxjs
      (third-party) **only** — **no other slice import, no `apps/mobile` deep
      import (uid still via `AUTH_UID`), no `scope:functions` import.**
- [ ] `pnpm nx typecheck shared-domain shared-firestore-schema mobile-title-detail
  mobile` passes — the new `EpisodeDoc.title` + converter mapping + the
      service/page episode surface compile against the merged shared types.
- [ ] `pnpm nx build mobile` passes (production configuration) within existing
      budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green —
      affected set includes `shared-domain`, `shared-firestore-schema`,
      `mobile-title-detail`, and `mobile` (and any other affected consumer of the
      shared change).
- [ ] **Unit tests** cover: the `EpisodeDoc.title` converter round-trip (+ null
      default); episode grouping/sorting/counts; single + bulk watched writes
      (`updateDoc`/`writeBatch`, never `setDoc`); the TV auto-status transitions
      (planned→watching, →completed, →planned, **dropped no-op**); movie
      mark-watched (**dropped no-op**, null-uid no-op); movie/null-uid/empty → `[]`.
- [ ] **Component test** asserts: section hidden for movie + movie toggle present;
      TV section + season headings + episode rows; loading skeleton; empty state;
      episode toggle → `setEpisodeWatched`; season bulk → `setSeasonWatched` +
      collapse independence; movie toggle → `setMovieWatched` + disabled on
      dropped (PLAN §5: component tests for non-trivial UI).
- [ ] **e2e:** three `test.fixme` stubs present in
      `apps/mobile-e2e/src/title-detail.spec.ts`, extending the existing
      `describe.fixme` block (~line 167), each commented with the un-skip
      blockers — (a) emulator must run in the user's own terminal, (b) episode
      seed docs added to `apps/mobile-e2e/emulator-data/seeded/docs.json`
      (decision 6). The seed docs are added to that fixture. **No
      `playwright.config.ts` change.**
- [ ] `libs/shared/domain/README.md`, `libs/shared/firestore-schema/README.md`,
      and `libs/mobile/title-detail/README.md` are updated to reflect the new
      `EpisodeDoc.title` field and the page's new episode/movie-watched surface —
      **no stale text** (CLAUDE.md lib-README rule).
- [ ] **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
      `ci.yml`, `playwright.config.ts`, and all `scope:functions` files are NOT
      modified** (verified-and-recorded in the PR: owner-only
      `users/{userId}/{document=**}` rule already covers the episode read/write +
      status update; single-collection read needs no index; the existing globs
      already tag the touched libs).
- [ ] **Guardrail verifications (review-checked):** (a) **no functions/sync-engine
      change** — this spec only **reads** the episode subcollection and **never
      creates** episode docs (single/bulk writes are `updateDoc`/`writeBatch` on
      existing docs); (b) **no `title-cache` write**; (c) the uid arrives via
      **`AUTH_UID`** (no `ShellAuthService`/`apps/mobile` deep import); (d) **no
      cross-slice import** and **no `scope:functions` import**; (e) a **null uid**
      and a **non-TV / empty subcollection** are guarded (`[]` / no-op, no throw);
      (f) the **`'dropped'` no-op** holds for both TV auto-status and the movie
      toggle; (g) **no secret read/written.**
- [ ] **UI fidelity — episode list has NO Stitch screen → human-verify.** The
      Episodes section structure is **design-system-derived** (no Stitch episode
      screen exists — decision 8); the implementer **re-fetched
      `208cb8d7a679490b8d13672c6943d6d3`** to confirm the inherited
      hero/action-area tokens (records the screen id in the PR) and **visually
      verified** the episode section + movie toggle (render/screenshot or
      `nx serve mobile --configuration=mock`) across the documented states
      (hidden-for-movie / loading / empty / collapsed-expanded / unchecked-checked
      / bulk / movie-toggle incl. disabled-on-dropped). Because no mock exists for
      the list, the PR **explicitly flags the episode section "UI design-system-
      derived — needs human eyeball."** **A green build alone does NOT satisfy
      this item.** The checked toggle uses `--ion-color-primary` (`#4edea3`), not
      `#10B981`; Inter + the icon font are confirmed **loaded**.
- [ ] PR description records: the **Stitch screen id** (`208cb8d7…`) + that no
      episode-list screen exists (UI design-system-derived, human-eyeball flagged),
      the exact verification commands, the no-functions-change / no-`title-cache`-
      write / reads-episodes-and-never-creates-docs / uid-via-`AUTH_UID` /
      no-cross-slice / no-`scope:functions` / no-secret confirmations, the
      no-`firestore.rules`-/`indexes`-/`sheriff.config`-change verification, and
      that the **episode e2e flows are `test.fixme`** (emulator must run in the
      user's own terminal + episode seed docs added to the seeded fixture).

## Risks

- **The episode subcollection is currently NEVER written (verified) — the empty
  state is the only state in production today.** The sync engine
  (`libs/functions/sync-titles/src/lib/engine/sync-engine.ts`) explicitly "Writes
  NO notifications and **NO episodes** (hard boundary)" — verified by grep.
  Decision 2 reads `users/{uid}/watchlist/{titleId}/episodes`, but **nothing
  populates it yet**, so for every real title the section shows the **empty
  state** (decision 5) until a future `scope:functions` spec teaches the sync
  engine to write episodes (incl. the new `EpisodeDoc.title`). **This is NOT a
  PLAN conflict** — PLAN §6 item 19's episode-write is a sync-engine concern, and
  populating the subcollection is **explicitly out of scope** here (decision 10).
  **Mitigation:** the read path + empty state are built and tested now, so when
  the sync engine starts writing episodes the UI lights up with **no further
  client change**; the component/service tests exercise the populated path with
  mocked docs. **Flag this dependency prominently in the PR** so a reviewer does
  not treat the always-empty production section as a bug.
- **`EpisodeDoc.title` is added but not yet populated.** The new field is read
  client-side and falls back to "Episode N" when null (UI) / `null` (converter).
  The sync engine must later write it; **backfilling/writing `title` is out of
  scope** (sync-engine spec). The nullable default keeps the change backward-
  compatible and migration-free.
- **Auto-status "auto-set watching" memory is in-service, not persisted.** The
  "unmark back to planned only if the slice auto-set watching" rule (decision 4)
  relies on in-service state, which **resets on page reload / navigation**. The
  conservative fallback when the memory is absent (e.g. fresh page load) is to
  **leave the status as-is** on unmark-to-zero (never demote a status the user may
  have set manually). This matches decision 4's "or leave as-is if manually set"
  and avoids a Firestore field. Noted so a reviewer does not expect persistent
  demote-on-unmark across reloads.
- **Bulk season write is multi-doc.** "Mark all watched" writes every episode doc
  in a season. Use a **`writeBatch`** (atomic, one round-trip) rather than N
  parallel `updateDoc`s, and run the auto-status check **once** after the batch
  resolves (not per episode). For very large seasons (>500 docs, Firestore's batch
  limit) this is a non-issue at v1 scale (a season is tens of episodes) but is
  noted; chunk only if a real show exceeds it.
- **Editing a merged slice (spec 0016, `done`) + a merged shared lib (spec 0005,
  `done`).** This spec extends `libs/mobile/title-detail` and adds a field to
  `EpisodeDoc`/its converter. **Mitigations:** the shared change is **additive +
  nullable** (no breaking change to existing `EpisodeDoc` consumers — there are
  none beyond the converter + schema test today); the slice change is **additive**
  (new section + service methods, existing detail/providers/action paths
  untouched); extend (not rewrite) the existing service/page specs. Run
  `nx affected` to confirm no other consumer of `EpisodeDoc` regresses.
- **No dedicated Stitch screen for the episode list (decision 8).** The Movie-
  Detail screen has no season-grouped episode list, and no episode screen exists
  in the project. The section is **design-system-derived** and **flagged for
  human visual verification** — a green build does **not** prove fidelity
  (CLAUDE.md UI-fidelity rule). The implementer still re-fetches
  `208cb8d7a679490b8d13672c6943d6d3` to confirm inherited tokens and records the
  screen id. If the orchestrator can surface an episode-list mock later, that
  refines the section; it is not a blocker for this spec.
- **`AUTH_UID` can be null briefly.** The uid signal is null before the anon
  session resolves; every uid-keyed call (episode read/write, status) is guarded
  (`[]`/no-op), mirroring 0016. The slice obtains the uid via the `scope:shared`
  `AUTH_UID` token, never by importing `ShellAuthService`.
- **No PLAN conflict.** This completes the **episode list + per-episode
  mark-watched** portion of PLAN §6 item 19 that spec 0016 deferred, using the
  existing PLAN §4 `users/{uid}/watchlist/{titleId}/episodes` path and the
  spec-0010 `AUTH_UID`/AngularFire DI contract. The single shared addition
  (`EpisodeDoc.title`) fits the PLAN §4 episode shape (a nullable metadata field)
  and is additive. Populating the subcollection remains a sync-engine concern (a
  future `scope:functions` spec), explicitly out of scope here.
