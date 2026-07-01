---
number: 0056
slug: title-detail-mark-watched
title: Add a "Mark as Watched" action for untracked titles on the title-detail page
status: done
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-07-01
---

# Add a "Mark as Watched" action for untracked titles on the title-detail page

## Context

GitHub issue [Versure/Vultus#132](https://github.com/Versure/Vultus/issues/132) —
_"Missing the option Mark as watched on search detail screen"_:

> When searching a tv show or movie and going to the search detail page i can
> only add an item to the watchlist, but cannot mark the show or movie directly
> as watched.

There is **no separate "search detail" page**. Search and watchlist both navigate
to the **same** shared page — `libs/mobile/title-detail/src/lib/title-detail.page.ts`
(+ `.html`, `.service.ts`), route `tabs/title-detail/:titleId` (with an optional
`?type=movie|tv` hint). The issue reproduces whenever that page is opened for a
title that is **not yet in the watchlist** (`vm.tracked === null`) — which is
exactly the state when arriving from a search result. In that untracked state the
page's `action-area` (`title-detail.page.html` ~line 84) renders **only** an "Add
to Watchlist" button, which always adds the title with `status: 'planned'`
(`TitleDetailService.add(detail)`, `title-detail.service.ts` ~line 258). There is
currently **no one-step path** to add a title as `completed` — so a user who has
already seen the movie/show has to add it, then open it again and change status.

Once a title **is** tracked, the page already supports marking it watched
(`movie-watched-control` toggling via `setMovieWatched` for movies; per-episode /
per-season toggles for TV, specs 0034/0050). This gap is specifically about the
**untracked (pre-add) entry point**.

Intended outcome: the untracked `action-area` gains a second explicit **"Mark as
Watched"** button alongside "Add to Watchlist". Tapping it adds the watchlist doc
directly with `status: 'completed'` (skipping `planned`/`watching`), for **both**
movies and TV shows.

### Locked decisions (from the interview — do NOT re-litigate)

1. **Second explicit button, not a status picker.** Add a **"Mark as Watched"**
   button in the untracked `action-area` **next to** the existing "Add to
   Watchlist" button. **Do NOT** replace "Add to Watchlist" with a status-picker
   action sheet — that is explicitly **out of scope** (bigger than this issue).
   Mirror the **existing two-sibling-control pattern already in this same file**:
   the tracked-state `action-area` already renders `status-control` +
   `remove-control` as siblings (`title-detail.page.html` lines 95–115), styled by
   the existing `.status-control` / `.remove-control` / `.add-cta` /
   `.movie-watched-control` classes in `title-detail.page.scss`. **Reuse the
   existing button/control CSS + the Stitch-derived visual language already present
   in the file** — do NOT invent new styles and do NOT re-fetch the Stitch screen
   (this is a small addition to an already-implemented, Stitch-aligned screen, not
   a new screen).

2. **Behavior — both movie and TV: add directly as `completed`.** Tapping "Mark
   as Watched" on an **untracked** title writes the watchlist doc directly with
   `status: 'completed'`, skipping `planned`/`watching`, for **both** movies and TV
   shows. This requires **generalizing `TitleDetailService.add()`** (or adding a
   sibling method) to accept the target status instead of hardcoding `'planned'`.
   **Icon/label:** reuse the `checkmark-circle` / `square-outline` iconography
   already used by `movie-watched-control` (`title-detail.page.html` line 130) for
   consistency.

   **TV — also bulk-mark any already-known episodes watched (updated
   requirement).** For a TV title, "Mark as Watched" must ALSO mark **all** of the
   title's episode docs `watched: true` **when episode docs already exist** for
   this `tmdbId` in `users/{uid}/watchlist/{titleId}/episodes/*` (e.g. the show was
   tracked before, removed, and is being re-added — the episode subcollection can
   survive a watchlist-doc delete). Mirror the existing bulk pattern in
   `TitleDetailService.setSeasonWatched` (`getDocs` over the episodes collection +
   a `writeBatch` of per-doc `updateDoc { watched: true, watchedAt }`), but over
   **ALL** seasons/episodes of the title (no `where('season', ...)` filter).
   - **If no episode docs exist yet** (the normal case for a brand-new,
     never-before-tracked show — episodes are only populated by the backend sync
     engine), there is **nothing to bulk-write at add time**; the status is set to
     `'completed'` and that is the accepted behavior. When the next sync populates
     episode docs (written **unwatched** by default), the existing **spec-0050
     page-init auto-revert** flips the status back to `'watching'` because it
     detects an unwatched episode. **That reversion is correct and expected** here
     — episode state cannot be marked before the docs exist — **not a bug or an
     oversight.** Documented plainly in Risks/edge-cases and Non-goals below so a
     reviewer does not treat it as a defect.

3. **Tests.** Unit tests for the generalized service method (status param,
   default preserved, both movie/tv). Component tests for the new button's
   presence / click / disabled-state in the untracked action-area. **e2e — two
   named flows:** (a) movie: search → open untracked detail → tap "Mark as
   Watched" → watchlist shows it Completed; (b) TV: same flow for a TV title →
   watchlist shows it Completed (episode docs not required for the assertion, since
   they don't exist until sync).

## Scope

In scope:

- **Generalize `TitleDetailService.add()`** (`title-detail.service.ts` ~line 258)
  to accept an optional target `status: WatchStatus` (default `'planned'`, so
  every existing caller and the existing "Add to Watchlist" behavior is preserved)
  and stamp that status onto the new `WatchlistItem` instead of the hardcoded
  `'planned'`. **OR** add a sibling method (e.g. `addWatched(detail)`) that calls
  the same write path with `'completed'` — implementer's choice; the binding
  contract is a **single-step add with a caller-chosen status**, reusing the
  existing `watchlistItemToData` + `setDoc` at `watchlistItemPath(uid,
String(tmdbId))` write (no new write target).
- **TV — bulk-mark already-known episodes watched (updated requirement).** For a
  `type === 'tv'` add-as-watched, after (or as part of) writing the watchlist doc
  as `'completed'`, `getDocs` the title's episodes collection
  (`episodesPath(uid, String(tmdbId))`, **no season filter**) and, if any docs
  exist, `writeBatch` each to `{ watched: true, watchedAt: <now Date> }` — mirroring
  `setSeasonWatched`'s `getDocs` + `writeBatch` pattern but across all seasons. When
  the collection is empty (the normal brand-new case), this is a no-op and the
  spec-0050 auto-revert handles later sync (decision 2).
- **Add a "Mark as Watched" button** to the **untracked** branch of the
  `action-area` in `title-detail.page.html` (inside the `@if (vm.tracked === null)`
  block, lines 84–94), as a **sibling** of the existing "Add to Watchlist" button —
  mirroring the tracked-state two-control layout. New public handler on
  `TitleDetailPage` (e.g. `markAsWatched(detail)`) that calls the generalized
  service method with `'completed'`.
- **Styling:** reuse the existing `.action-area` flex row + the existing
  button/control classes and `--vultus-*` tokens already in
  `title-detail.page.scss`. The `checkmark-circle` / `square-outline` glyphs are
  already registered on the page (used by `movie-watched-control`).
- **Tests:** service unit (status param + default), component (button presence /
  click / disabled), and **two named e2e flows** (movie + TV) in
  `apps/mobile-e2e`.
- **README:** update `libs/mobile/title-detail/README.md` to note the untracked
  action-area now offers a one-step "Mark as Watched" add and the generalized
  service add signature.

Out of scope (non-goals — do NOT do these):

- **No change to `libs/mobile/search`.** Search only **navigates** to
  title-detail (a string route); it never rendered the add/watched actions. It
  needs **zero** changes. (Confirm-and-record: no search-slice edit.)
- **No change to the tracked-state UI** — the tracked `status-control` /
  `remove-control` / `movie-watched-control` / episode toggles are already
  correct (specs 0016/0034/0050); this spec does not touch them.
- **No new Stitch screen fetch** — reuses the existing implemented, Stitch-aligned
  `title-detail.page` screen (decision 1). No re-derivation of tokens.
- **No creation of episode docs, and no bulk-mark when the subcollection is
  empty.** The TV bulk-mark (decision 2) only `updateDoc`s **already-existing**
  episode docs (via `writeBatch`) — it **never creates** episode docs (those are
  the sync engine's job). For a brand-new show with no episode docs yet, add-as-
  watched writes only the `'completed'` watchlist doc; the next sync populates
  episodes unwatched and the existing spec-0050 auto-revert flips the status to
  `'watching'` — **accepted/expected behavior**, not an oversight (see Risks).
- **No status-picker / action-sheet replacement** of "Add to Watchlist" (decision
  1. — that is a larger change than this issue warrants.
- **No `shared/domain` / `shared/firestore-schema` change** — the write reuses the
  merged `WatchlistItem` shape + `watchlistItemToData` converter unchanged; the
  only new value is `status: 'completed'`, an existing `WatchStatus`.
- **No `firestore.rules` / `firestore.indexes.json` / `sheriff.config.ts` /
  `ci.yml` / `playwright.config.ts` / `scope:functions` change** (verify-and-record).

## Affected slices & Sheriff tags

| Project             | Path                       | Sheriff tags                         | Change                                                                                                                                   |
| ------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-title-detail | `libs/mobile/title-detail` | `scope:mobile`, `slice:title-detail` | Generalize `TitleDetailService.add()` (status param); add "Mark as Watched" button + handler to the untracked action-area; tests; README |
| mobile-e2e          | `apps/mobile-e2e`          | (e2e; not Sheriff-policed lib)       | Two named e2e flows (movie + TV "mark as watched" from search)                                                                           |

- **Entirely within `slice:title-detail`.** The change touches only
  `libs/mobile/title-detail/**` (service + page + tests + README) and the e2e
  project. **No cross-slice import**, **no `shared/` change**, **no `scope:functions`
  touch**, **no `apps/mobile` shell change** (the route + config providers already
  exist from spec 0016; the uid still arrives via the `scope:shared` `AUTH_UID`
  token, never via a deep import of `apps/mobile`).
- **Import boundaries (verified against spec-0010/0016 Sheriff rules):** the slice
  keeps importing only `@vultus/shared/domain` (`WatchlistItem`, `WatchStatus`,
  `TitleType` — already imported) and `@vultus/shared/firestore-schema`
  (`watchlistItemPath`, `watchlistItemToData` — already imported), plus AngularFire
  / `@ionic/*` / `ionicons` (third-party). This spec adds **no new import** of any
  kind — it reuses symbols the slice already imports. **No `slice:search`,
  `slice:watchlist`, `slice:settings`, or `scope:functions` import.**
- **No `shared/` extraction.** The add-with-status write stays inside
  `libs/mobile/title-detail` — one consumer, far short of the 3+-slice rule
  (CLAUDE.md / PLAN §3).
- **No `sheriff.config.ts` change.** No new lib; the existing `libs/mobile/*/src`
  glob already tags this slice. Record "no `sheriff.config.ts` change needed" in
  the PR.

## Data model touchpoints

PLAN §4 paths. **No new field, no shared-type change.** The only new behavior is
writing an existing `WatchStatus` value (`'completed'`) at add time.

| PLAN §4 path                                  | Access by this slice                                       | Fields / note                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}` (doc)       | **create** (new: `status:'completed'`)                     | one-step add-as-watched; same shape as the existing `add()` (`type`, `tmdbId`, `traktId:null`, `title`, `addedAt`, `posterPath`, `voteAverage`) with `status: 'completed'`            |
| `users/{uid}/watchlist/{titleId}` (doc)       | **read (realtime, already wired)**                         | `tracked$` — the existing subscription flips the action-area to tracked once the doc lands (no reload)                                                                                |
| `users/{uid}/watchlist/{titleId}/episodes/**` | **read (one-shot) + update (bulk, TV only, if any exist)** | on a TV add-as-watched: `getDocs` all episode docs; `writeBatch` each to `{ watched: true, watchedAt }`. **Never creates docs**; a no-op when the subcollection is empty (decision 2) |
| `title-cache/**`                              | **none**                                                   | unchanged — read-only elsewhere; not touched here                                                                                                                                     |

- **Add-as-completed write (decision 2).** Build the **same** `WatchlistItem`
  the existing `add()` builds (`title-detail.service.ts` lines 263–272), but with
  `status: 'completed'` instead of `'planned'`; pass it through
  `watchlistItemToData(item)` (the merged converter already coerces
  `posterPath`/`voteAverage` via `?? null` and `addedAt` → Date) and `setDoc` it at
  `watchlistItemPath(uid, String(detail.tmdbId))`. **Reuse the shared converter and
  the exact existing write path — do not hand-roll the wire mapping or add a new
  write target.** The doc id is `String(tmdbId)` (the natural duplicate guard,
  matching 0013/0014/0016). **Null-uid guard** stays (no-op when uid null), exactly
  as the existing `add()` does.
- **TV bulk episode-mark (decision 2, updated).** On a TV add-as-watched, after
  (or in the same flow as) the `'completed'` watchlist write, `getDocs` the title's
  episode collection `episodesPath(uid, String(tmdbId))` (**no `where('season',
...)` filter — all seasons**), and for **each** returned doc `batch.update(ref,
{ watched: true, watchedAt })` via a `writeBatch`, then commit — the exact
  pattern of `setSeasonWatched` (`title-detail.service.ts` lines 342–364) minus the
  season filter. `watchedAt = new Date()`. **Uses `updateDoc`/`batch.update` on
  existing docs only — NEVER `setDoc`, NEVER creates episode docs** (that is the
  sync engine's job). When the collection is **empty** (the brand-new-show case),
  the batch has no ops and this is a no-op.
- **No-episodes-yet is accepted (decision 2).** For a brand-new show with no
  episode docs, add-as-watched writes only the `'completed'` watchlist doc. When
  the functions sync engine later populates the subcollection with **unwatched**
  episodes, the **existing spec-0050 page-init auto-revert** (`revertIfNewEpisodes`,
  `title-detail.service.ts` lines 391–416) flips the status to `'watching'` on the
  next page-init because it detects an unwatched episode. This spec adds **no** new
  correction code and relies on that safety net — the reversion is **correct and
  expected**, documented in Risks.
- **No `firestore.rules` change — VERIFY and RECORD.** The merged rules already
  grant owner-only read/write on `users/{userId}/{document=**}`, which covers this
  create. Verify the block is present and record "no `firestore.rules` change
  needed" in the PR. Do **NOT** edit it.
- **No `firestore.indexes.json` change** — the watchlist write is a single-document
  `setDoc`, and the TV episode bulk read is a **whole-collection `getDocs`** (no
  `where`/`orderBy`, no compound query — same read shape `setSeasonWatched` already
  uses without an index, minus even its single-field `where`). Record "no index
  change needed". Do **NOT** edit it.

## Public types / APIs

No HTTP endpoint, no callable, **no new shared type**. The only public-surface
change is the **generalized `TitleDetailService.add()` signature** (or a sibling
method) inside `libs/mobile/title-detail`.

### `TitleDetailService.add()` generalization (`src/lib/title-detail.service.ts`)

**Binding intent** (exact name/shape is the implementer's choice between an
optional param and a sibling method — pick the one that reads cleanest and keeps
all existing callers behaving identically):

```ts
/**
 * Create `users/{uid}/watchlist/{titleId}` with the denormalized posterPath +
 * voteAverage from `detail`. The target `status` defaults to 'planned' (the
 * existing "Add to Watchlist" behavior — every current caller is unchanged);
 * pass 'completed' for the one-step "Mark as Watched" add (spec 0056).
 *
 * When status is 'completed' AND detail.type === 'tv', ALSO bulk-mark every
 * already-existing episode doc watched: getDocs episodesPath(uid, id) (all
 * seasons), writeBatch each { watched: true, watchedAt }. NEVER creates episode
 * docs — a no-op when the subcollection is empty (the brand-new-show case; the
 * spec-0050 auto-revert handles later sync). No-op entirely when uid null.
 */
async add(detail: TitleDetail, status: WatchStatus = 'planned'): Promise<void>;
```

- **The `status` default MUST be `'planned'`** so the existing `addToWatchlist`
  path and any other current caller keep adding as `planned` with no code change.
- **TV bulk episode-mark (decision 2, updated).** When `status === 'completed'`
  and `detail.type === 'tv'`, the method (or its sibling) also `getDocs` the
  title's episodes collection and `writeBatch`-updates every existing doc to
  `{ watched: true, watchedAt: new Date() }` — mirroring `setSeasonWatched`
  (lines 342–364) without the season filter. **Never `setDoc`, never creates docs;
  no-op on an empty collection.** For a movie or a `'planned'` add, no episode read
  or write happens.
- If a **sibling method** is chosen instead (e.g.
  `async addWatched(detail: TitleDetail): Promise<void>`), it MUST route through
  the **same** `watchlistItemToData` + `setDoc` write with `status: 'completed'`
  (no duplicated write logic beyond the status value), perform the same TV
  bulk episode-mark, and keep the null-uid guard.
- **No barrel-surface change** is required — `add` is already a method on the
  service; the page composes it. The barrel from 0016/0034
  (`TitleDetailPage`, `TMDB_DETAIL_CONFIG`, `TmdbDetailConfig`) is otherwise
  unchanged.

### `TitleDetailPage` handler (`src/lib/title-detail.page.ts`)

Add a public, template-bound method mirroring the existing `addToWatchlist`
(page ~line 310) and `toggleMovieWatched` (~line 367) so the component test can
invoke it deterministically:

```ts
/** Adds the currently-resolved detail to the watchlist directly as 'completed'
 *  (spec 0056 — one-step "Mark as Watched" from the untracked action-area). */
markAsWatched(detail: TitleDetail): void {
  void this.service.add(detail, 'completed'); // or this.service.addWatched(detail)
}
```

Keep `addToWatchlist`, `openStatusSheet`, `openRemoveAlert`, `toggleMovieWatched`
and every other existing handler unchanged.

## UI / Stitch screen refs

This is a mobile slice, but it is a **small addition to an already-implemented,
Stitch-aligned screen** — the "Movie Detail - Vultus" screen
(`208cb8d7a679490b8d13672c6943d6d3`, project `projects/13590348714018893783`)
pinned by specs 0016/0034/0050. **Per decision 1, do NOT re-fetch or re-derive the
screen** for this change: the untracked action-area is already built and styled
against it; this spec only adds a second sibling button reusing the **existing**
control styles. **The implementer should still eyeball-verify the built result**
(render/screenshot or `pnpm nx run mobile:serve-mock`) across the states below —
a green build alone does not prove UI fidelity (CLAUDE.md UI-fidelity rule) — but
there is **no new Stitch capture** and this is **not** a blocking open item.

**Token source of truth:** consume the wired `--vultus-*` / `--ion-*` CSS custom
properties already used by the sibling controls in `title-detail.page.scss`;
**never hardcode a hex.** (`docs/design/vultus-design-system.md` is the
authoritative token set; primary is `#4edea3` via `--ion-color-primary`, **not**
`#10B981`.)

### Structure & concrete contract (each row a checkable acceptance item)

The change lives **only in the untracked branch** of the `.action-area`
(`title-detail.page.html`, the `@if (vm.tracked === null)` block, lines 84–94).
The `.action-area` is already a horizontal flex row (`display: flex; flex-direction:
row; gap: var(--vultus-space-md)`, scss line 174). Add the "Mark as Watched"
button as a **second child** of that row, so the two untracked actions sit side by
side exactly like the tracked-state `status-control` + `remove-control` pair.

1. **"Add to Watchlist" button (unchanged).** The existing filled
   `ion-button color="primary"` `.add-cta` (`flex: 1`, **height 56px**,
   `--border-radius: var(--vultus-radius-md)`, bold, text
   `--ion-color-primary-contrast`), `add-circle-outline` glyph, label "Add to
   Watchlist", `data-test="add-btn"`, `(click)="addToWatchlist(detail)"`. **Do not
   restyle or move it** beyond it now sharing the row with a sibling.
2. **"Mark as Watched" button (NEW).** A sibling control in the same row. Match the
   **outlined** treatment of the existing `.status-control` /
   `.movie-watched-control` (NOT a second filled CTA — the design keeps a single
   filled primary CTA per FIX-1 in spec 0016): **height 56px**, `border: 2px solid
var(--ion-color-primary)`, `border-radius: var(--vultus-radius-md)`,
   `background: transparent`, text/icon `--ion-color-primary`, `font-family:
var(--vultus-font-family)`, `font-weight: 700`; **hover** →
   `background: color-mix(in srgb, var(--ion-color-primary) 10%, transparent)`;
   **active/pressed** → `transform: scale(0.98)`; **focus** → Ionic/browser default
   `:focus-visible` ring. Icon: **`checkmark-circle`** (the same glyph
   `movie-watched-control` uses when watched — page line 130), label **"Mark as
   Watched"**, `data-test="mark-watched-btn"`, `(click)="markAsWatched(detail)"`.
   **Reuse the existing `.status-control` / `.movie-watched-control` class (or a
   thin new class that composes the same tokens) — do NOT introduce new hex or new
   spacing.** The button sits inside the content-canvas action-area; keep both
   buttons a consistent height (56px) and the row gap `--vultus-space-md` so the two
   siblings align exactly (sibling-inset agreement).
3. **Layout / sizing:** if both untracked buttons carry `flex: 1` they split the
   row evenly; if "Mark as Watched" is a fixed-width secondary affordance, it must
   still be **height 56px** and vertically centered with `.add-cta`. Choose one and
   keep the two heights and vertical alignment identical (the tracked-state pattern,
   where `status-control` is `flex: 1` and `remove-control` is auto-width, is an
   acceptable model to mirror).

### View / interactive states (each a checkable acceptance item)

| Element                         | default                                                                                                                                  | focus                                       | hover                                                    | active/pressed           | disabled                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| **Add to Watchlist** (existing) | filled `ion-button color="primary"`, h-56px, `--vultus-radius-md`, `add-circle-outline`                                                  | Ionic default `:focus-visible` ring         | Ionic default                                            | Ionic default            | n/a                                                                   |
| **Mark as Watched** (NEW)       | outlined-primary (border-2 `--ion-color-primary`, text `--ion-color-primary`), h-56px, `checkmark-circle` glyph, label "Mark as Watched" | Ionic/browser default `:focus-visible` ring | `bg color-mix(primary 10%)` (matching `.status-control`) | `transform: scale(0.98)` | not applicable in the untracked state (both actions always available) |

- **Untracked (`vm.tracked === null`):** BOTH "Add to Watchlist" **and** "Mark as
  Watched" render, side by side. (Assert in the component test.)
- **Tracked (`vm.tracked !== null`):** the untracked branch is **not** rendered —
  neither new button appears; the existing `status-control` + `remove-control`
  (and, for movies, `movie-watched-control`) render exactly as today. **This spec
  does not touch that branch.** (Assert the new button is absent when tracked.)
- **After tapping "Mark as Watched":** the service writes the doc; the existing
  realtime `tracked$` subscription re-emits the new tracked item and the action-area
  swaps to the tracked layout with status **Completed** — **no reload**, same
  reactive flip the existing "Add to Watchlist" already gets.
- **Icon/font wiring (easy to miss):** the `checkmark-circle` glyph is **already
  registered** on the page (used by `movie-watched-control`); confirm it is in the
  page's `addIcons(...)` set (it is) so it renders. Inter is already loaded by
  `apps/mobile/src/index.html` (spec 0016). No new font/icon load is needed.

## Implementation task graph

All work is within `slice:title-detail` plus the e2e project. The service change
is a prerequisite for the page handler, and both share files with the page/tests,
so the graph is **sequential** — there is **no [parallel] task** in this spec.

> **Manifest disjointness assertion (for the orchestrator):** no [parallel] task.
> Tasks 1–3 write only `libs/mobile/title-detail/**`; task 4 writes only
> `apps/mobile-e2e/src/**` (+ possibly a seeded fixture). File sets do not overlap,
> but tasks 2–4 depend on task 1, so the whole graph runs sequentially. No two
> tasks write the same file.

1. **[sequential] Generalize `TitleDetailService.add()` (status param) + TV bulk
   episode-mark.** frontend-engineer.
   - `title-detail.service.ts`: add an optional `status: WatchStatus = 'planned'`
     param to `add()` (or add an `addWatched()` sibling routing through the same
     `watchlistItemToData` + `setDoc` write), stamping the chosen status onto the
     `WatchlistItem`. Preserve the null-uid guard and the exact write path
     (`watchlistItemPath(uid, String(detail.tmdbId))`).
   - When `status === 'completed'` and `detail.type === 'tv'`, also `getDocs` the
     title's episodes collection (`episodesPath(uid, String(detail.tmdbId))`, no
     season filter) and `writeBatch`-update every existing doc to `{ watched: true,
watchedAt: new Date() }` — reuse the `setSeasonWatched` pattern (`getDocs` +
     `writeBatch`, lines 342–364) minus `where('season', ...)`. Never `setDoc`;
     no-op on an empty collection.
   - Files: `libs/mobile/title-detail/src/lib/title-detail.service.ts`.

2. **[sequential] Add the "Mark as Watched" button + page handler. Depends on
   task 1.** frontend-engineer.
   - `title-detail.page.ts`: add public `markAsWatched(detail)` calling the task-1
     method with `'completed'` (mirror `addToWatchlist`). No other handler changes.
   - `title-detail.page.html`: inside the untracked `@if (vm.tracked === null)`
     block (lines 84–94), add the sibling "Mark as Watched" button
     (`data-test="mark-watched-btn"`, `checkmark-circle` glyph,
     `(click)="markAsWatched(detail)"`) next to `add-btn`.
   - `title-detail.page.scss`: reuse the existing `.status-control` /
     `.movie-watched-control` outlined-primary style (or a thin composing class);
     ensure the two untracked buttons align at height 56px within `.action-area`.
     **No new hex; consume `--vultus-*` / `--ion-*` tokens.**
   - Files: `libs/mobile/title-detail/src/lib/title-detail.page.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.html`,
     `libs/mobile/title-detail/src/lib/title-detail.page.scss`.

3. **[sequential] Unit + component tests + README. Depends on tasks 1–2.**
   frontend-engineer / qa-runner.
   - `title-detail.service.spec.ts`: `add(detail)` (default) still writes
     `status: 'planned'`; `add(detail, 'completed')` (or `addWatched`) writes
     `status: 'completed'`; both for a **movie** and a **tv** `detail`; the write
     targets `watchlistItemPath(uid, String(tmdbId))` via `watchlistItemToData`
     (never a new path, never `title-cache`); null-uid → no-op. **TV bulk episode
     tests (alongside the existing `setSeasonWatched` tests):** with **existing**
     episode docs mocked for the tmdbId, `add(tvDetail, 'completed')` flips **all**
     of them to `watched: true` via a batch; with **no** episode docs, no episode
     write occurs (empty-collection no-op) and only the watchlist doc is written;
     a **movie** add-as-completed performs **no** episode read/write.
   - `title-detail.page.spec.ts`: untracked `loaded` state renders BOTH `add-btn`
     and `mark-watched-btn`; tapping `mark-watched-btn` calls `markAsWatched` →
     `service.add(detail, 'completed')`; the tracked `loaded` state renders
     **neither** untracked button (the existing tracked controls render instead).
   - `libs/mobile/title-detail/README.md`: note the untracked action-area now
     offers a one-step "Mark as Watched" add and the generalized `add(detail,
status?)` signature; Sheriff tags unchanged; still no shared extraction.
   - Files: `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`,
     `libs/mobile/title-detail/README.md`.

4. **[sequential] Two named e2e flows. Depends on tasks 1–3.** qa-runner.
   - `apps/mobile-e2e/src/`: two Playwright flows (see Test plan for exact names)
     — movie and TV: search → open untracked detail → tap "Mark as Watched" →
     watchlist shows the title as **Completed**. Author them alongside the existing
     title-detail / search e2e specs, following that project's fixture + emulator
     conventions. If the flows depend on the emulator (which cannot run under
     Claude Code tools — project memory), gate them **`test.fixme`** with a comment
     naming the blocker, and add any needed seed docs to the seeded fixture
     (`apps/mobile-e2e/emulator-data/seeded/docs.json`).
   - Files: `apps/mobile-e2e/src/**` (the title-detail or a new mark-watched spec),
     and — if seed data is needed — `apps/mobile-e2e/emulator-data/seeded/docs.json`.
     **No `playwright.config.ts` change.**

(All slice internals stay under `libs/mobile/title-detail/**`; the only
`apps/mobile-e2e` touches are the two flows + optional seed docs. **No
`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`, `ci.yml`,
`playwright.config.ts`, `libs/functions/**`, `libs/shared/**`, `apps/mobile`shell, or`libs/mobile/search` file is touched.** Symbol/file names are
recommendations; the binding contract is the one-step add-with-status write + the
untracked "Mark as Watched" button + the no-episode-write / no-cross-slice /
no-shared-change guardrails.)

## Test plan

Per the PLAN §5 pyramid — real logic (a new write path + a new UI control), so
**unit** (service), a **component** test (the new button's presence/click/absence),
and **two named e2e flows** (this is a `scope:mobile` feature adding a critical
action — a one-step add-as-watched — so e2e is **required** per the rubric). All
Firebase access in unit/component is **mocked** (no live Firebase, no network, no
secrets). The green CI gate is **lint + typecheck + unit + component + build**.

**Unit — `TitleDetailService` (`title-detail.service.spec.ts`, Vitest, mocked
AngularFire + mocked `AUTH_UID`):**

- **Default status preserved:** `add(detail)` (no status arg) writes a
  `WatchlistItem` with `status: 'planned'` at `watchlistItemPath(uid,
String(tmdbId))` via `watchlistItemToData` (existing behavior — assert it did NOT
  regress).
- **Add as completed — movie:** `add(movieDetail, 'completed')` (or
  `addWatched(movieDetail)`) writes `status: 'completed'`, same path/converter,
  with `type: 'movie'` and the denormalized `posterPath`/`voteAverage` carried
  through.
- **Add as completed — tv, existing episodes:** with episode docs already mocked
  for the tmdbId (e.g. a re-add), `add(tvDetail, 'completed')` writes `status:
'completed'` **and** flips **every** existing episode doc to `watched: true`
  (+ `watchedAt`) via a `writeBatch` (assert each `batch.update` targets an
  episode doc ref, over all seasons — mirrors the `setSeasonWatched` test).
- **Add as completed — tv, no episodes (brand-new show):** with the episodes
  collection mocked **empty**, `add(tvDetail, 'completed')` writes only the
  `'completed'` watchlist doc; **no episode write** occurs (empty-collection
  no-op); **never `setDoc` on an episode path, never `title-cache`**.
- **Add as completed — movie:** performs **no** episode read/write at all (only
  the watchlist doc).
- **Null-uid no-op:** with uid null, no write is attempted (mirrors the existing
  `add()` guard).

**Component (`title-detail.page.spec.ts`, Angular TestBed + Ionic; service mocked;
`ActivatedRoute` providing a `:titleId`):**

- **Untracked → both buttons:** a `loaded` untracked (`tracked === null`) state
  renders **both** `data-test="add-btn"` and `data-test="mark-watched-btn"`.
- **Tap "Mark as Watched":** clicking `mark-watched-btn` calls `markAsWatched`,
  which calls the service add with `'completed'` (assert on the mocked service).
- **Tap "Add to Watchlist" unchanged:** clicking `add-btn` still calls
  `addToWatchlist` → service add with the default (`'planned'`).
- **Tracked → neither untracked button:** a `loaded` tracked (`tracked !== null`)
  state renders **neither** `add-btn` nor `mark-watched-btn` (the existing
  `status-control`/`remove-control` render instead — the tracked branch is
  untouched).

**e2e — TWO named flows (required; `test.fixme`-gated if emulator-dependent):**
authored in `apps/mobile-e2e/src` following the existing title-detail/search e2e
conventions. Both stay `test.fixme` if they require the Firestore emulator (which
cannot run under Claude Code tools — project memory; CI runs the emulator-backed
e2e gate), each with a comment naming the blocker; add episode-free seed data as
needed to `apps/mobile-e2e/emulator-data/seeded/docs.json`.

- **Flow 1 — "movie: mark as watched from search":** search a movie → tap the
  result to open its (untracked) title-detail page → tap **"Mark as Watched"** →
  navigate to the watchlist → the title appears with status **Completed**.
- **Flow 2 — "tv: mark as watched from search":** search a TV show → open its
  (untracked) title-detail page → tap **"Mark as Watched"** → navigate to the
  watchlist → the title appears with status **Completed**. (Episode docs are NOT
  required for this assertion — they don't exist until sync.)

## Definition of done

Tailored from the PLAN §5 checklist. Green gate is **lint + typecheck + unit +
component + build**; the two e2e flows are a DoD gate enforced by `qa-runner` /
`feature-reviewer` (run against the emulator in CI / the user's terminal;
`test.fixme` only if emulator-blocked, with the blocker named).

- [ ] `pnpm nx run-many -t lint test -p mobile-title-detail` passes **with Sheriff
      active**: the slice imports only `@vultus/shared/domain` + `@vultus/shared/
    firestore-schema` (both already imported) + AngularFire/Ionic/ionicons
      (third-party) — **no new import, no cross-slice import, no `apps/mobile` deep
      import (uid via `AUTH_UID`), no `scope:functions` import.**
- [ ] `pnpm nx typecheck mobile-title-detail mobile` passes — the generalized
      `add(detail, status?)` signature + the new page handler compile; every
      existing `add()` caller still type-checks (the default keeps them valid).
- [ ] `pnpm nx build mobile` passes (production configuration) within budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green.
- [ ] **Unit tests** cover: default `add()` still writes `'planned'`; add-as-
      `'completed'` for **movie** and **tv**; **TV add with existing episode docs
      bulk-flips them all to `watched: true`** via a batch; **TV add with an empty
      episodes collection writes no episode doc** (never `setDoc`, never
      `title-cache`); movie add does no episode read/write; null-uid no-op.
- [ ] **Component test** asserts: untracked renders BOTH `add-btn` +
      `mark-watched-btn`; tapping `mark-watched-btn` → service add with
      `'completed'`; tapping `add-btn` → service add with the default; tracked
      renders **neither** untracked button.
- [ ] **e2e:** two named flows present — "movie: mark as watched from search" and
      "tv: mark as watched from search" — each asserting the title lands in the
      watchlist as **Completed**. If emulator-blocked, `test.fixme` with the
      blocker named; otherwise green.
- [ ] `libs/mobile/title-detail/README.md` updated: the untracked action-area now
      offers a one-step "Mark as Watched" add; the generalized `add(detail,
    status?)` signature; Sheriff tags unchanged — **no stale text** (CLAUDE.md
      lib-README rule).
- [ ] **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
      `ci.yml`, `playwright.config.ts`, `libs/functions/**`, `libs/shared/**`,
    `libs/mobile/search/**`, and the `apps/mobile` shell are NOT modified\*\*
      (verified-and-recorded in the PR).
- [ ] **Guardrail verifications (review-checked):** (a) the add write reuses the
      existing `watchlistItemToData` + `setDoc` at `watchlistItemPath` (no new write
      target); (b) the TV bulk episode-mark uses `getDocs` + `writeBatch.update` on
      **existing** docs only — **never `setDoc`, never creates episode docs**, and
      is a **no-op on an empty collection**; (c) **no `title-cache`
      write**; (d) the uid arrives via **`AUTH_UID`** (no `ShellAuthService` /
      `apps/mobile` deep import); (e) **no cross-slice import** and **no
      `scope:functions` import**; (f) the tracked-state branch and the search slice
      are **untouched**; (g) **no secret read/written.**
- [ ] **UI verification (no new Stitch capture — decision 1).** The new button
      reuses the existing implemented, Stitch-aligned action-area styles; the
      implementer **eyeball-verifies** the untracked action-area (render/screenshot
      or `pnpm nx run mobile:serve-mock`) — both buttons present, aligned at 56px,
      outlined "Mark as Watched" using `--ion-color-primary` (`#4edea3`, **not**
      `#10B981`), the `checkmark-circle` glyph rendering, hover/active states — and
      the tracked-state layout unchanged. A green build alone does NOT satisfy this
      item (CLAUDE.md UI-fidelity rule). **No Stitch re-fetch required.**
- [ ] PR description records: the reused Stitch screen id
      (`208cb8d7a679490b8d13672c6943d6d3`) + that no re-fetch/new capture was needed
      (small addition to an existing screen), the verification commands, the
      guardrail confirmations above, the no-`firestore.rules`/`indexes`/
      `sheriff.config`/search-slice/shell change verification, and the two e2e flow
      names (+ `test.fixme` status if emulator-blocked).

## Risks

- **TV add-as-watched has two cases; the no-episodes case relies on the spec-0050
  auto-revert (decision 2) — expected, not a bug.**
  - **Episode docs already exist** (e.g. the show was tracked before, removed, and
    is being re-added — the episode subcollection can outlive the watchlist doc):
    the add-as-watched flow bulk-flips **all** of them to `watched: true` in a
    `writeBatch`, so the completed status is backed by real per-episode state.
  - **No episode docs yet** (the normal brand-new-show case — episodes are written
    only by the functions sync engine, and per spec 0034's Risks the sync engine
    currently writes **no** episodes in production): there is nothing to bulk-write
    at add time, so the status is set to `'completed'` and stays there until the
    next sync. When that sync populates episodes **unwatched**, spec 0050's
    **page-init auto-revert** (`revertIfNewEpisodes`) silently flips the status to
    `'watching'` because it detects an unwatched episode. **This reversion is
    correct and expected** — episode state cannot be marked before the docs exist —
    **not a bug or an oversight.** This spec adds **no** new correction code and
    **never creates** episode docs. **Flag prominently in the PR** so a reviewer
    understands the brand-new-TV completed status is auto-corrected once episodes
    sync in, and that the re-add case marks episodes at add time. **Not a PLAN
    conflict** — it is the intended interaction with the existing safety net.
- **Editing a merged slice (spec 0016/0034/0050, all `done`).** This extends
  `libs/mobile/title-detail` (service + page). **Mitigations:** the service change
  is **additive + backward-compatible** (the `status` param defaults to `'planned'`,
  so every existing caller is unchanged); the page change is **additive** (a new
  button in the untracked branch only; the tracked branch and every other handler
  are untouched); extend (not rewrite) the existing service/page specs. Run
  `nx affected` to confirm no regression.
- **`AUTH_UID` can be null briefly.** The uid signal is null before the anon
  session resolves; the add write is guarded (no-op on null uid), reusing the
  existing `add()` guard. The slice obtains the uid via the `scope:shared`
  `AUTH_UID` token, never by importing `ShellAuthService`.
- **e2e emulator dependency.** The two flows need the Firestore emulator, which
  cannot run under Claude Code tools (project memory) — CI runs the emulator-backed
  e2e gate, so the flows are real PR checks. If they must be authored as
  `test.fixme` locally, un-skip once the emulator runs in the user's terminal / CI;
  the comment must name the blocker (and any seed docs added).
- **No PLAN conflict.** This closes the issue-#132 gap using the existing PLAN §4
  `users/{uid}/watchlist/{titleId}` doc, the merged `WatchlistItem` shape +
  `watchlistItemToData` converter (unchanged), an existing `WatchStatus` value
  (`'completed'`), and the spec-0010 `AUTH_UID`/AngularFire DI contract. No new
  architecture, no new shared surface, no cross-slice edge.
