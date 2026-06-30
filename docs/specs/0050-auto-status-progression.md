---
number: 0050
slug: auto-status-progression
title: Auto-progress TV watchlist status between watching and completed in title-detail
status: approved
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-06-30
---

# Auto-progress TV watchlist status between watching and completed in title-detail

## Context

Spec 0034 (merged, `done`) built the season-grouped **Episodes** section in
`slice:title-detail`: the user marks episodes watched, and a service-side
`autoUpdateStatus` re-derives the watchlist `status` after each episode/season
write (`planned → watching` on the first watch; `→ completed` when all watched;
back to `planned` when the slice itself auto-set `watching`). Spec 0047
(`approved`) teaches the sync engine to **insert newly-aired episode docs** into
`users/{uid}/watchlist/{titleId}/episodes` — including episodes added to a show
**after** the user already finished and the title was marked `completed`.

That sync behaviour exposes a gap: once spec 0047 adds a new (unwatched) episode
to a show the user had completed, the title is **silently left at `completed`**
even though there is now something unwatched to watch. Nothing walks the status
back. The user need: a completed show that gets a new episode should re-surface
as **Watching**, and finishing the last episode of a show they are watching
should mark it **Completed** — without the user hand-editing status to match
reality.

This spec closes both halves of the `watching ⇄ completed` loop for **TV shows**,
entirely **client-side in `libs/mobile/title-detail`** (`scope:mobile`):

- **Auto-advance** (`watching → completed`): when the user marks the **last**
  unwatched episode watched, advance the status. This **refines** spec 0034's
  existing `autoUpdateStatus` (see "Relationship to spec 0034" below) so the
  advance to `completed` fires specifically from `'watching'`.
- **Auto-revert** (`completed → watching`): when the title-detail page loads a
  `'completed'` TV show whose episodes subcollection now contains **at least one
  unwatched** episode (e.g. new episodes from spec 0047's sync), silently revert
  the status to `'watching'`. **This is new** — spec 0034 has no page-init revert.

Intended outcome: a vertical extension of `TitleDetailService` (the auto-advance
refinement + a new `revertIfNewEpisodes` page-init check) and a one-line wire-up
in `TitleDetailPage`'s init. **No new lib, no new route, no Cloud Functions
change, no `scope:shared` change, no sync-engine change.**

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **TV shows only.** Movies already have a one-tap watched toggle (spec 0034's
   `setMovieWatched`, `completed ⇄ watching`); auto-advancing a movie adds no
   value. The auto-advance and auto-revert here are **no-ops for `type !== 'tv'`**.

2. **All logic is client-side, in `libs/mobile/title-detail`** (`scope:mobile`,
   `slice:title-detail`). **No Cloud Functions change. No change to spec 0047's
   sync-episodes engine.** The sync **writes** episode docs; this slice **reads**
   them and re-derives the watchlist `status`.

3. **Auto-advance (`watching → completed`)** — triggered inside the existing
   `setEpisodeWatched(tmdbId, episodeId, true)` write path (and, for the bulk
   case, `setSeasonWatched`), via the existing private `autoUpdateStatus(tmdbId)`
   helper invoked **after** the episode `{ watched: true }` write resolves:
   - After the write, count episodes in `users/{uid}/watchlist/{titleId}/episodes`.
   - **All** episodes now `watched: true` **AND** the current status is
     **`'watching'`** → write `status: 'completed'` to
     `users/{uid}/watchlist/{titleId}`.
   - Advances **only** from `'watching'`. Does **not** touch `'planned'`,
     `'dropped'`, or an already-`'completed'` title.
   - **Empty-subcollection edge case:** if the episodes subcollection is **empty**
     (no episodes synced yet — spec 0047 not yet run for this title), do **NOT**
     auto-advance. "All watched" is undefined over zero episodes (the `total > 0`
     guard).

4. **Auto-revert (`completed → watching`)** — triggered when `TitleDetailPage`
   initialises for a TV show (on `ngOnInit` / the page's first resolved-detail +
   episodes emission):
   - If the title's status is **`'completed'`** **AND** the episodes list contains
     **at least one** `watched: false` episode → write `status: 'watching'` to
     `users/{uid}/watchlist/{titleId}`.
   - A **silent background write** — **no toast, no user-facing message**. The
     status badge updates reactively via the existing realtime `tracked$` stream.
   - Reverts **only** from `'completed'`. Does **not** touch `'planned'`,
     `'dropped'`, or a `'watching'` title (already correct).
   - **No-op** when the subcollection is empty, when `type !== 'tv'`, or when uid
     is null.

5. **No user preference to disable.** Auto-progression is **always on** for TV
   shows. There is no settings flag.

6. **Out of scope** (each a future spec if ever wanted): movies (already toggled),
   per-season progress as a status, partial-season completion ("Season 1
   complete"), an undo affordance, and any change to the sync engine /
   `scope:functions` / `scope:shared`.

7. **No new Stitch screen.** This is a **reactive side-effect on the existing
   title-detail page** — it changes the watchlist `status` value, which the
   existing status badge (spec 0016/0034) already renders reactively via
   `tracked$`. There is **no new visual element**. The existing episode-list UI
   (spec 0034) and status badge are unchanged. See UI section.

8. **Sheriff / scope.** All logic stays within `slice:title-detail`. **No
   cross-slice import, no `scope:functions` import, no `apps/mobile` deep import**
   (uid still via the `scope:shared` `AUTH_UID` token). No `scope:shared` change
   (no new field — `EpisodeDoc` and `WatchlistItem` already carry everything).

### Relationship to spec 0034 (important — this REFINES existing behaviour)

Spec 0034's `autoUpdateStatus` (in `title-detail.service.ts`) **already** writes
`completed` when all episodes are watched — but from **any** non-`dropped` status
(`planned` or `watching`), and it has **no page-init revert**. This spec makes
two precise changes to the existing logic; the implementer **extends, does not
rewrite**, and **must preserve** every other spec-0034 transition and its tests:

- **Tighten the `→ completed` advance to fire from `'watching'`** (decision 3).
  Today the all-watched branch fires before the `planned → watching` branch, so a
  user marking the only/last episode of a `planned` show jumps straight to
  `completed`. Per decision 3 the advance to `completed` is **only** from
  `'watching'`. The net effect of the refined order:
  - `planned` + first episode watched → `watching` (unchanged from 0034).
  - `watching` + last episode watched → `completed` (the auto-advance).
  - A `planned` title where the user marks **all** episodes in one action: the
    `planned → watching` step runs; reaching `completed` then requires the title
    to be `'watching'` (it becomes so on the same pass only if the implementer
    keeps a single `autoUpdateStatus` pass converging — see Data model for the
    exact ordering). **Decision 3 is the contract: `completed` is reached from
    `'watching'`.** No existing spec-0034 test asserts `planned + all-watched →
    completed` in one shot (the 0034 suite's "all watched" test already uses status
    `'watching'` and survives unchanged). A **new convergence test** is **added** to
    pin the decision-3 semantics (advance lands on `watching`, then `completed`
    because the effective status is `watching`).
- **Add a page-init `completed → watching` revert** (decision 4) — entirely new;
  spec 0034 has none.

The `autoSetWatching` in-service memory (spec 0034, walk-back to `planned` on
un-watch-to-zero) is **untouched** by this spec and keeps working.

## Scope

In scope:

- **`TitleDetailService` refinement + addition** (`libs/mobile/title-detail`):
  - Refine the existing private `autoUpdateStatus(tmdbId)` so the `→ completed`
    advance fires from **`'watching'`** (decision 3), preserving the
    `planned → watching` and `→ planned` (un-watch-to-zero) transitions and the
    `dropped`/empty/null-uid no-ops.
  - Add a new public method **`revertIfNewEpisodes(tmdbId, type)`** (decision 4):
    one-shot read the watchlist status + episodes; if TV, `status === 'completed'`,
    and ≥1 episode is `watched: false`, `updateStatus(tmdbId, 'watching')`. No-op
    on movie / null uid / empty subcollection / non-`completed` status.
- **`TitleDetailPage` wire-up** (`libs/mobile/title-detail`): call
  `revertIfNewEpisodes(tmdbId, type)` once per resolved TV detail on page init
  (decision 4), driven off the existing `detail$` stream (no new template, no new
  visual element).
- Tests: service unit (auto-advance from `watching`; no advance from
  `planned`/`dropped`/`completed`; empty-subcollection no-advance; auto-revert
  fires only for completed-TV-with-unwatched; movie/null-uid/empty no-ops) and a
  component test (page init calls `revertIfNewEpisodes` for TV, not for movie).
- Update `libs/mobile/title-detail/README.md` (the auto-status section).

Out of scope:

- **Movies** (already have a watched toggle — decision 1).
- **Per-season progress as status, partial-season completion, undo** (decision 6).
- **Any `scope:functions` / sync-engine change** — this slice **reads** the
  subcollection spec 0047 writes; it never writes or creates episode docs.
- **Any `scope:shared` change** — no new `EpisodeDoc` / `WatchlistItem` field
  (decision 8); both shapes already carry `watched` and `status`.
- **Any `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `ci.yml`, `playwright.config.ts` change** (verify-and-record; see Data model).
- **A new Stitch screen / new visual element** (decision 7) — the status badge
  updates reactively via the existing `tracked$` stream.

## Affected slices & Sheriff tags

| Project             | Path                       | Sheriff tags                         | Change                                                                                                                                                |
| ------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-title-detail | `libs/mobile/title-detail` | `scope:mobile`, `slice:title-detail` | Refine `autoUpdateStatus` (advance from `'watching'`); add `revertIfNewEpisodes`; wire it into `TitleDetailPage` init; README + service/page tests |

- **Import boundaries (verified against the merged slice).** The change reuses
  imports the slice **already has**: `EpisodeDoc` / `TitleType` / `WatchStatus`
  (`@vultus/shared/domain`), `episodesPath` / `dataToEpisode` / `watchlistItemPath`
  / `dataToWatchlistItem` (`@vultus/shared/firestore-schema`), AngularFire
  (`getDocs`, `getDoc`, `collection`, `doc`, `updateDoc`), and `AUTH_UID`
  (`@vultus/shared/domain/tokens`). **No new import** of another slice, of
  `apps/mobile`, or of `scope:functions`. AngularFire / `@ionic/*` / `rxjs` are
  third-party (not policed by Sheriff).
- **No `shared/` extraction.** The auto-advance and auto-revert rules live
  **inside** `libs/mobile/title-detail` — one consumer (this slice), far short of
  the 3+-slice rule (CLAUDE.md / PLAN §3). No new shared module, no new shared
  field.
- **No `sheriff.config.ts` change.** No new lib is generated; the existing
  `libs/mobile/<slice>/src` glob already tags `libs/mobile/title-detail/src`.
  Record "no `sheriff.config.ts` change needed" in the PR.

## Data model touchpoints

PLAN §4 paths. **No new field anywhere.** All access reuses spec-0016/0034
shapes.

| PLAN §4 path                                            | Access by this slice                            | Fields / note                                                                       |
| ------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}/episodes` (collection) | **read (one-shot)** in `autoUpdateStatus` + `revertIfNewEpisodes` | count `watched` over `EpisodeDoc`; **never written** by this spec                     |
| `users/{uid}/watchlist/{titleId}` (doc)                 | **read (one-shot status)**, **update (`status`)** | auto-advance writes `{ status: 'completed' }`; auto-revert writes `{ status: 'watching' }` |
| `title-cache/**`                                        | **none**                                        | unchanged                                                                           |

- **Auto-advance read+write (decision 3).** Reuses spec 0034's
  `autoUpdateStatus(tmdbId)`: after the episode `{ watched }` write, one-shot
  `getDocs(collection(...episodesPath(uid, String(tmdbId))))`, count `total` and
  `watchedCount` via `dataToEpisode`, read the current `status` via the existing
  private `currentStatus(uid, tmdbId)`. **Refined ordering so `completed` is
  reached from `'watching'`:** the helper must converge so that
  - `status === 'planned'` & `watchedCount >= 1` → `updateStatus(tmdbId,
'watching')` (and remember `autoSetWatching`), and
  - `status === 'watching'` (including just-set this pass) & `total > 0` &
    `watchedCount === total` → `updateStatus(tmdbId, 'completed')`.
    Concretely: evaluate the `planned → watching` advance **first**, derive the
    effective post-advance status, then evaluate the all-watched `→ completed`
    branch against that effective `'watching'` status. `dropped` / `null` status →
    **no write**. Empty subcollection (`total === 0`) → **no advance** (the
    `total > 0` guard already present in 0034). The un-watch-to-zero `→ planned`
    branch (0034) is preserved unchanged.
- **Auto-revert read+write (decision 4).** New `revertIfNewEpisodes(tmdbId,
type)`: no-op when `type !== 'tv'` or uid is null. One-shot read the watchlist
  doc status (reuse `currentStatus`) and the episodes (`getDocs` over
  `episodesPath`). If `status === 'completed'` **and** at least one episode has
  `watched === false`, `updateStatus(tmdbId, 'watching')`. **No write** when the
  subcollection is empty, the status is not `'completed'`, or no unwatched episode
  exists. Reuses the existing `updateStatus` write path — **no new write target,
  no episode-doc write/create.** Note: the existing private `currentStatus(uid,
  tmdbId)` helper takes `uid` as its first parameter — pass the resolved uid (via
  `AUTH_UID`) explicitly; do not rely on a captured closure.
- **No `firestore.rules` change — VERIFY and RECORD.** The merged rules grant
  **owner-only read/write** on `users/{userId}/{document=**}`, which already
  covers the episodes read and the watchlist `status` update. The implementer
  **verifies** the recursive `users/{userId}/{document=**}` match is present and
  **records "no `firestore.rules` change needed"** in the PR. Do **NOT** edit it.
- **No `firestore.indexes.json` change.** Both reads are single-collection reads
  with **no compound `where`/`orderBy`** (the auto-advance counts in memory; the
  auto-revert reads the whole subcollection and checks `.some(e => !e.watched)`).
  Record "no index change needed". Do **NOT** edit it.

## Public types / APIs

No HTTP endpoint, no callable, **no shared-type change**. One new slice-local
public service method; one refined private helper.

### `TitleDetailService` (`src/lib/title-detail.service.ts`)

Refine the existing private helper and add one public method (signatures are
**binding intent**; the `autoUpdateStatus` name + the `revertIfNewEpisodes`
name are recommendations — the contracts are decisions 3 and 4):

```ts
class TitleDetailService {
  /**
   * (REFINED — spec 0050.) Re-derive status after an episode/season write.
   * Unchanged from 0034 EXCEPT the `→ completed` advance now fires only from
   * `'watching'` (evaluate the planned→watching advance first, then the
   * all-watched →completed branch against the effective status). Preserves the
   * planned→watching, un-watch-to-zero→planned, and dropped/empty/null no-ops.
   */
  private autoUpdateStatus(tmdbId: number): Promise<void>;

  /**
   * (NEW — spec 0050, decision 4.) Page-init auto-revert for TV. One-shot reads
   * the watchlist status + episodes; if TV, status === 'completed', and ≥1
   * episode is watched:false → updateStatus(tmdbId, 'watching') (silent — the
   * status badge updates via the realtime tracked$). No-op on movie / null uid /
   * empty subcollection / non-'completed' status. Never writes/creates episodes.
   */
  revertIfNewEpisodes(tmdbId: number, type: TitleType): Promise<void>;
}
```

- `revertIfNewEpisodes` is **public** (template/component-invokable) so the
  component test can assert the page calls it; the barrel surface (`index.ts`) is
  otherwise **unchanged** (it exports `SeasonGroup` / `EpisodeRow` /
  `TitleDetailPage` / `TMDB_DETAIL_CONFIG` / `TmdbDetailConfig` — none change). It
  is **not** added to the barrel unless a cross-barrel consumer needs it (it does
  not — the page imports the service directly within the slice).
- No change to the public shapes of `episodes$`, `setEpisodeWatched`,
  `setSeasonWatched`, `setMovieWatched`, `updateStatus`, `tracked$`, `detail$`.

### `TitleDetailPage` (`src/lib/title-detail.page.ts`)

- The page calls `revertIfNewEpisodes(tmdbId, type)` **once per resolved TV
  detail** on init. Recommended wiring: a `takeUntilDestroyed`-scoped subscription
  off the existing `detail$` stream that, on each `loaded` TV detail, fire-and-
  forgets `void this.service.revertIfNewEpisodes(detail.tmdbId, 'tv')`. This
  mirrors the existing constructor `tmdbId$.subscribe(...)` pattern (no new
  lifecycle hook is strictly required, but `ngOnInit` is acceptable if the
  implementer prefers `implements OnInit`). Guard against re-firing on every
  re-emission of the same title (e.g. dedupe by tmdbId or use the already-present
  `currentTmdbId`); a redundant call is **idempotent** (a non-`completed` status
  is a no-op) but the dedupe avoids a write storm if `detail$` re-emits.

## UI / Stitch screen refs

**No new Stitch screen and no new visual element** (decision 7). This spec changes
the watchlist `status` **value**; the **existing** status badge on
`TitleDetailPage` (spec 0016 tracked-status control; styled with
`--vultus-status-*` tokens, spec 0034) renders the new value **reactively** via
the already-wired realtime `tracked$` stream. There is **nothing new to render**.

- **Auto-advance:** when the last episode is marked watched, the existing status
  control re-renders from `Watching` to `Completed` (the `--vultus-status-completed`
  accent, `#10B981` — that is the completed status accent, **not** the
  primary `#4edea3`). No toast.
- **Auto-revert:** on page load of a `completed` TV show with new unwatched
  episodes, the status control re-renders from `Completed` to `Watching`
  (`--vultus-status-watching`). **Silent — no toast, no message** (decision 4).
- **Token wiring:** consume the existing `--vultus-status-*` / `--ion-*` vars from
  `shared/ui-kit` `theme.scss`; **do not hardcode a hex**. No new icon, no new
  font. The status badge already maps `var(--vultus-status-${status})` via the
  page's `statusColorVar` (unchanged).

**Stitch screen note (for the implementer):** because this spec adds **no new
visual element**, no Stitch screen capture is required for new UI. The host page's
existing visual contract remains the spec-0016/0034 screen **"Movie Detail -
Vultus"** (`208cb8d7a679490b8d13672c6943d6d3`, project
`projects/13590348714018893783`); the implementer need not re-fetch it for this
change (no markup changes). **Visual verification is limited to confirming the
status badge transitions reactively** (mark last episode → badge flips to
Completed; load a completed show with an unwatched episode → badge flips to
Watching) via `pnpm nx run mobile:serve-mock` or the component test — there is no
static-pixel fidelity item here. Record "no new UI element — reactive status
transition only; no Stitch capture required" in the PR.

## Implementation task graph

This is a **single-slice change with no shared/parallel work**: all edits are
within `libs/mobile/title-detail`. There is **no [parallel] task** (and therefore
no parallel file manifest to disjoint-check). The tasks below are **[sequential]**
because tasks 2–3 build on task 1's service surface and they share
`title-detail.service.ts` / the page / the spec files.

> **Manifest disjointness assertion (for the orchestrator):** no [parallel] task.
> Every task writes only files under `libs/mobile/title-detail/**`. No two tasks
> write the same file (task 1: service; task 2: page; task 3: the two spec files +
> README). No `libs/shared/**`, `apps/functions/**`, `apps/mobile-e2e/**`,
> `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`, `ci.yml`, or
> `playwright.config.ts` file is touched.

1. **[sequential] `TitleDetailService` — refine `autoUpdateStatus` + add
   `revertIfNewEpisodes`.** frontend-engineer.
   - Refine `autoUpdateStatus(tmdbId)` so the `→ completed` advance fires from the
     effective `'watching'` status (evaluate `planned → watching` first, then the
     all-watched `→ completed` branch against that), preserving the un-watch-to-
     zero `→ planned`, `dropped`, empty (`total > 0` guard), and null-uid no-ops
     (decision 3). Keep the `autoSetWatching` memory intact.
   - Add `revertIfNewEpisodes(tmdbId, type)` (decision 4): no-op on `type !== 'tv'`
     / null uid; one-shot read status (`currentStatus`) + episodes (`getDocs` over
     `episodesPath`); if `status === 'completed'` and any episode `watched === false`
     → `updateStatus(tmdbId, 'watching')`.
   - Files: `libs/mobile/title-detail/src/lib/title-detail.service.ts`.

2. **[sequential] `TitleDetailPage` — wire the page-init auto-revert. Depends on
   task 1.** frontend-engineer.
   - Subscribe (or `ngOnInit`) off the existing `detail$`: for each `loaded` TV
     detail, fire-and-forget `void this.service.revertIfNewEpisodes(detail.tmdbId,
'tv')`, deduped by tmdbId so it does not re-fire on every re-emission. No
     template change (no new visual element).
   - Files: `libs/mobile/title-detail/src/lib/title-detail.page.ts`.

3. **[sequential] Tests + README. Depends on tasks 1–2.** frontend-engineer /
   qa-runner.
   - Service unit (`title-detail.service.spec.ts`): refine the existing
     `autoUpdateStatus` cases to the decision-3 semantics (advance lands on
     `watching`; `completed` only from `watching`) and add auto-revert cases (see
     Test plan). Preserve the surviving 0034 assertions (planned→watching,
     un-watch→planned, dropped/empty/null no-ops).
   - Component (`title-detail.page.spec.ts`): page init calls `revertIfNewEpisodes`
     with the resolved TV tmdbId + `'tv'`, and does **not** call it for a movie.
   - Update `libs/mobile/title-detail/README.md`: the auto-status section now also
     documents the page-init `completed → watching` auto-revert and the refined
     `→ completed`-from-`watching` advance; Sheriff tags unchanged; no shared
     extraction.
   - Files: `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
     `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`,
     `libs/mobile/title-detail/README.md`.

(All edits stay under `libs/mobile/title-detail/**`. **No `libs/shared/**`, no
`apps/functions/**`, no `apps/mobile-e2e/**`, no `firestore.rules`,
`firestore.indexes.json`, `sheriff.config.ts`, `ci.yml`, or `playwright.config.ts`
touch.** Symbol/file names are recommendations; the binding contracts are the
decision-3 `→ completed`-from-`watching` advance, the decision-4 page-init
`completed → watching` auto-revert, the TV-only / empty-subcollection / null-uid
no-ops, and the no-functions-write / no-cross-slice / no-episode-doc-write
guardrails.)

## Test plan

Per the PLAN §5 pyramid — real branching logic, so **unit** (the service's two
state machines) and a **component** test (the page-init wire-up). All Firebase
access is **mocked** (no live Firebase, no emulator, no network, no secrets). The
green CI gate is **lint + typecheck + unit + component + build** (what `ci.yml`
runs).

**Unit — `TitleDetailService` (`title-detail.service.spec.ts`, Vitest, mocked
AngularFire + mocked `AUTH_UID`):**

Auto-advance (`autoUpdateStatus`, exercised via `setEpisodeWatched` /
`setSeasonWatched`):

- **`watching` + last episode marked watched → `completed`:** all episodes
  `watched: true`, current status `'watching'` → asserts `updateDoc` on the
  watchlist doc with `{ status: 'completed' }`.
- **`watching` + a non-last episode marked → NO advance:** ≥1 still unwatched →
  **no** `{ status: 'completed' }` write (status stays `watching`).
- **`planned` + first episode → `watching` (not `completed`):** marking one of
  several episodes from `planned` lands on `watching`, **not** `completed`
  (decision-3 ordering; refines the 0034 single-shot case).
- **`planned` + all episodes marked in one bulk action:** converges to the
  decision-3 contract — the `planned → watching` step runs; assert the final
  written status per the implemented convergence (advance reaches `watching`, then
  `completed` only because the effective status is `watching`). The assertion
  pins the decision-3 semantics, not 0034's old `planned → completed` jump.
- **`completed` already + an episode re-marked watched → NO double-write:**
  current status `'completed'`, all watched → **no** redundant `{ status:
'completed' }` write (assert `updateStatus` not called for status — idempotence).
- **`dropped` → no auto-status write** at all (assert not called).
- **Empty subcollection → no advance:** `getDocs` returns zero episode docs →
  **no** `{ status: 'completed' }` write (`total > 0` guard).
- **Un-watch-to-zero → `planned`** (preserved 0034 behaviour, only when the slice
  auto-set `watching`).

Auto-revert (`revertIfNewEpisodes`):

- **`completed` TV + ≥1 unwatched episode → `watching`:** status `'completed'`,
  episodes include a `watched: false` → asserts `updateStatus(tmdbId, 'watching')`
  (`{ status: 'watching' }` write).
- **`completed` TV + ALL episodes watched → NO write:** no unwatched episode →
  `updateStatus` not called.
- **non-`completed` status → NO write:** `'watching'` / `'planned'` / `'dropped'`
  completed-status guard → no call.
- **Movie → no-op:** `revertIfNewEpisodes(tmdbId, 'movie')` reads nothing, writes
  nothing (assert no `getDocs` over episodes, no `updateStatus`).
- **Empty subcollection → no-op:** `completed` status but zero episode docs → no
  write (cannot conclude an unwatched episode exists).
- **null uid → no-op:** no read, no write.
- **No write outside the watchlist doc:** every status write targets
  `watchlistItemPath(uid, …)`; **never `title-cache`, never an episode doc, never
  another slice's data.**

**Component (`title-detail.page.spec.ts`, Angular TestBed + Ionic; service
mocked; `ActivatedRoute` providing a `:titleId`):**

- **TV detail → page init calls `revertIfNewEpisodes`:** a `loaded` **tv** detail
  → `revertIfNewEpisodes` is called once with the resolved tmdbId and `'tv'`.
- **Movie detail → NOT called:** a `loaded` **movie** detail → `revertIfNewEpisodes`
  is **not** called.
- **No re-fire on re-emission:** if `detail$` re-emits the same TV title,
  `revertIfNewEpisodes` is **not** called again (dedupe by tmdbId) — or, if the
  implementer relies on idempotence, assert the mock is only called once per
  distinct title. (Pick one; the test pins the chosen guard.)

**e2e:** **No new e2e flows required.** This is a **reactive status side-effect**,
not a new route or a new user-facing action. The existing title-detail episode-
interaction flows are already authored as `test.fixme` stubs in
`apps/mobile-e2e/src/title-detail.spec.ts` (spec 0019 harness + spec 0034 stubs);
the status-progression behaviour is a consequence of "mark an episode watched"
(already a named stub flow) and does not add a navigable route or a primary action
per the e2e rubric. **No `apps/mobile-e2e` change, no `playwright.config.ts`
change.** (If a future spec wants an explicit "finish last episode → badge shows
Completed" assertion, it can extend the existing `describe.fixme` block; it is not
required here.)

## Definition of done

Tailored from the PLAN §5 checklist. Green gate is **lint + typecheck + unit +
component + build** (what `ci.yml` runs).

- [ ] `pnpm nx run-many -t lint test -p mobile-title-detail` passes **with Sheriff
      active**: the slice imports `@vultus/shared/domain`
      (`EpisodeDoc`/`TitleType`/`WatchStatus`/`WatchlistItem`) +
      `@vultus/shared/firestore-schema` (`episodesPath`/`dataToEpisode`/
      `watchlistItemPath`/`dataToWatchlistItem`) + AngularFire/Ionic/rxjs
      (third-party) **only** — **no other slice import, no `apps/mobile` deep
      import (uid still via `AUTH_UID`), no `scope:functions` import.**
- [ ] `pnpm nx typecheck mobile-title-detail mobile` passes — the refined
      `autoUpdateStatus` + new `revertIfNewEpisodes` + the page wire-up compile.
- [ ] `pnpm nx build mobile` passes (production configuration) within budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green —
      affected set is `mobile-title-detail` (+ `mobile`); **no `scope:shared` /
      `scope:functions` project is affected** (no shared/functions edit).
- [ ] **Unit tests** cover: auto-advance from `'watching'` only (not from
      `'planned'`/`'dropped'`/already-`'completed'`); empty-subcollection
      no-advance; the preserved `planned → watching` and un-watch-to-zero
      `→ planned`; auto-revert `completed → watching` only for TV-completed-with-
      unwatched; movie/null-uid/empty/non-completed no-ops; no write outside the
      watchlist doc.
- [ ] **Component test** asserts: TV page init calls `revertIfNewEpisodes(tmdbId,
'tv')`; a movie does **not**; no double-fire on same-title re-emission (PLAN
      §5: component tests for non-trivial state).
- [ ] **No new e2e** — reactive status side-effect, not a route/action (rubric:
      "Not required" — stated explicitly here, not silently omitted). **No
      `apps/mobile-e2e` / `playwright.config.ts` change.**
- [ ] `libs/mobile/title-detail/README.md` updated: the auto-status section now
      documents the page-init `completed → watching` auto-revert and the refined
      `→ completed`-from-`'watching'` advance — **no stale text** (CLAUDE.md
      lib-README rule). **No other lib README changes** (no shared lib touched).
- [ ] **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
      `ci.yml`, `playwright.config.ts`, all `scope:functions` files, and all
      `scope:shared` files are NOT modified** (verified-and-recorded in the PR:
      owner-only `users/{userId}/{document=**}` rule already covers the
      episodes read + status update; single-collection reads need no index; the
      existing globs already tag the touched lib; no new shared field).
- [ ] **Guardrail verifications (review-checked):** (a) **no functions/sync-engine
      change** — this slice only **reads** the episode subcollection and **never
      writes/creates** episode docs (the only writes are the watchlist `status`
      `updateDoc`); (b) **no `title-cache` write**; (c) uid via **`AUTH_UID`** (no
      `ShellAuthService`/`apps/mobile` deep import); (d) **no cross-slice import**,
      **no `scope:functions` import**, **no `scope:shared` change**; (e) **null
      uid**, **non-TV**, **empty subcollection**, and **non-`completed`/non-
      `'watching'` status** are all guarded (no throw, no write); (f) auto-advance
      fires **only** from `'watching'`, auto-revert **only** from `'completed'`,
      and **neither touches `'dropped'`**; (g) the auto-revert is **silent** (no
      toast/message); (h) **no secret read/written.**
- [ ] **UI — reactive status transition only (no new element).** The status badge
      flips reactively (mark last episode → `Completed`; load a `completed` show
      with an unwatched episode → `Watching`), verified via `pnpm nx run
mobile:serve-mock` or the component test. **No new Stitch screen / no static-
      pixel fidelity item.** Record "no new UI element — reactive status transition
      only; no Stitch capture required" in the PR. (The badge uses
      `--vultus-status-*` tokens; `completed` is `#10B981`, **not** the primary
      `#4edea3`.)
- [ ] PR description records: the **reactive-status / no-new-element** UI note
      (no Stitch capture required), the exact verification commands, the
      no-functions-change / no-`title-cache`-write / reads-episodes-never-writes-
      them / uid-via-`AUTH_UID` / no-cross-slice / no-`scope:functions` /
      no-`scope:shared` / no-secret confirmations, the no-`firestore.rules`-/
      `indexes`-/`sheriff.config`-change verification, the **decision-3 refinement
      of spec 0034's `autoUpdateStatus`** (advance to `completed` now from
      `'watching'`, with the surviving 0034 transitions preserved), and the
      no-e2e-required rationale.

## Risks

- **This REFINES spec 0034's merged `autoUpdateStatus` (behaviour change, not
  purely additive).** Today the all-watched `→ completed` branch fires from any
  non-`dropped` status, so marking the only episode of a `planned` show jumps
  straight to `completed`. Decision 3 tightens this to advance to `completed`
  **from `'watching'`**. **Mitigation:** the implementer evaluates the
  `planned → watching` advance first and the all-watched branch against the
  effective status, so a single-action "mark everything" on a `planned` show still
  converges correctly (lands on `watching`, then `completed` because the effective
  status is `watching`); the surviving 0034 transitions
  (`planned → watching`, un-watch-to-zero `→ planned`, `dropped` no-op) are
  preserved and re-asserted, and a new convergence test for `planned + all-watched`
  is added with the decision-3 semantics (no existing 0034 test covers this
  single-shot case — the 0034 suite's "all watched" test uses `'watching'` and is
  unaffected). Run `nx affected` to confirm no other `EpisodeDoc`/`WatchlistItem`
  consumer regresses. **Flag the decision-3 semantics change in the 0034
  assertion explicitly in the PR** so a reviewer expects the new single-shot
  semantics.
- **Auto-revert depends on spec 0047's sync writing episodes.** The
  `completed → watching` revert only ever fires once spec 0047 (sync-episodes,
  `approved`) starts **adding** new episode docs to a completed show's
  subcollection. Until 0047 lands and runs, the subcollection of a completed show
  does not gain new episodes, so the revert is a no-op in practice (correct —
  there is nothing new to watch). **This is NOT a PLAN conflict:** reading the
  subcollection and reacting to its contents is squarely within `slice:title-
  detail`'s charter (PLAN §6 item 19); populating it is 0047's `scope:functions`
  concern, explicitly out of scope here (decision 2). **Flag this dependency in the
  PR** so a reviewer does not treat a no-op revert (empty/append-only
  subcollection in dev) as a bug.
- **Page-init revert timing / re-fire.** `revertIfNewEpisodes` runs on the page's
  first resolved TV detail; it must not re-fire a write on every `detail$`
  re-emission (Ionic page-reuse, retry). **Mitigation:** dedupe by tmdbId (the
  page already tracks `currentTmdbId`) — and the call is idempotent anyway (a
  non-`completed` status is a no-op), so a redundant call costs at most one extra
  one-shot read with no write. Noted so a reviewer expects the dedupe.
- **One-shot vs. realtime read in the revert.** The revert reads the episodes
  **one-shot** (`getDocs`) at page init, mirroring `autoUpdateStatus`. If episodes
  are synced **while the page is already open** on a completed show, the revert
  does not re-run (it is an init check, not a realtime watcher) — decision 4 scopes
  it to page init. The user revisiting the page (the normal flow after a sync)
  triggers it. Noted as the intended scope, not a gap.
- **Silent write, no undo.** The auto-revert is a silent background `status` write
  with no toast and no undo (decisions 4 + 6). A reviewer might expect a
  confirmation; decision 4 deliberately omits it — the status badge updating
  reactively is the only feedback. Noted so the absence is understood as
  intentional.
- **No PLAN conflict.** This completes the `watching ⇄ completed` auto-progression
  for the **episode list + per-episode mark-watched** portion of PLAN §6 item 19,
  using the existing PLAN §4 `users/{uid}/watchlist/{titleId}` `status` field and
  `…/episodes` subcollection and the spec-0010 `AUTH_UID`/AngularFire DI contract.
  No new field, no new collection, no new dependency.
