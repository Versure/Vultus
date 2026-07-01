---
number: 0053
slug: completed-marks-episodes-watched
title: Mark all episodes watched when a TV show is manually set to Completed
status: approved
slices: [slice:title-detail, slice:watchlist]
scopes: [scope:mobile]
created: 2026-07-01
---

# Mark all episodes watched when a TV show is manually set to Completed

## Context

When a user manually sets a TV show's watchlist `status` to **Completed** — from
either the **Watchlist** tab's status action sheet (`slice:watchlist`) or the
**title-detail** page's status action sheet (`slice:title-detail`) — the show's
per-episode watched flags are left **exactly as they were**. A show finished off
the watchlist tab therefore ends up "Completed" while its Episodes section still
shows some/all episodes unwatched (GitHub issue #131). The user's expectation is
that declaring a show Completed means every episode is watched.

Two independent action sheets can write `status: 'completed'`, each backed by its
own slice-local data-access service (vertical slice, no shared code — CLAUDE.md /
PLAN §3):

- `slice:watchlist` — `WatchlistPage.onStatusSelected` (watchlist.page.ts:484)
  calls `WatchlistService.updateStatus(uid, titleId, status)`
  (watchlist.service.ts:249), currently a bare `updateDoc(..., { status })` with
  **no** episode write and **no** episode imports at all.
- `slice:title-detail` — `TitleDetailPage.actionSheetButtons` handler
  (title-detail.page.ts:172) calls `TitleDetailService.updateStatus(tmdbId,
  status)` (title-detail.service.ts:280), also a bare `updateDoc(..., { status })`.

Intended outcome: when the **new** status being written is `'completed'` **and**
the item is a **TV** show, batch-mark every currently-**unwatched** episode under
`users/{uid}/watchlist/{titleId}/episodes` as `{ watched: true, watchedAt: <now> }`
before/with the status write. Movies (no episode subcollection) and TV shows whose
episodes are all already watched or not-yet-synced are cheap no-ops. **This is a
`scope:mobile`-only, two-slice, data-write side-effect change — no new UI, no new
route, no `scope:shared` change, no Cloud Functions change, no sync-engine change.**

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Fix both manual status-change entry points.** Both `WatchlistService.updateStatus`
   and `TitleDetailService.updateStatus` gain the same behavior: when the new
   status is `'completed'` and `type === 'tv'`, batch-write `{ watched: true,
   watchedAt: <now> }` to every episode doc that is currently `watched !== true`.
   Each slice implements it **independently** in its own service file — this is a
   small (2-slice) duplication, well short of the 3+-slice extract-to-`shared` rule
   and consistent with the slices already each owning their own copy of
   `STATUS_DISPLAY_ORDER` / `STATUS_LABELS` today (watchlist.service.ts:42-55,
   title-detail.service.ts:60-73). **Do NOT extract a shared helper.**

2. **Minimize writes — only unwatched docs.** Read the whole episodes
   subcollection one-shot; include in the `writeBatch` **only** docs where
   `watched !== true`. If there are **zero** unwatched docs, **skip the batch
   commit entirely** and just write the status. (Mirrors the write-minimizing
   intent while reusing the existing `writeBatch` shape of
   `TitleDetailService.setSeasonWatched`, title-detail.service.ts:342-364.)

3. **Empty / not-yet-synced subcollection → no-op batch.** If the episodes
   subcollection is empty (spec 0047 sync has not run for this title, or it is a
   brand-new watchlist entry), there is nothing to batch — just write the status.
   (Mirrors the `total > 0` / `docs.length === 0` guards in
   `autoUpdateStatus` / `revertIfNewEpisodes`, specs 0034 / 0050.)

4. **Null uid → no-op** (keep the existing guard in both services).

5. **Movies → no episode write** (`type !== 'tv'` short-circuits to a bare status
   write). Movies have no episode subcollection.

6. **Forward direction only.** Moving status **away** from `'completed'`
   (`completed → watching` / `planned` / `dropped`) does **not** touch episodes —
   leave them exactly as they are. Only the transition **to** `'completed'` via
   manual status selection triggers the episode batch-watch.

7. **Fires on every write of `'completed'`, not just a transition.** Because the
   batch only touches currently-unwatched docs and is skipped when there are none,
   re-selecting "Completed" on an already-completed show is a cheap no-op (no
   unwatched docs found → no batch). **Do not add "was it already completed" guard
   logic** — the emptiness check IS the guard. This keeps the two services free of
   a `getDoc` read of the current status on the completed path.

8. **Signature widening, not a new public method.** Both `updateStatus`
   implementations need the item's `type` to decide TV-vs-movie. Add a
   `type: TitleType` parameter to `updateStatus` in **both** services (a
   behavior-preserving widening) and update the call sites. Do **not** introduce a
   new public method for the completed path — the branch lives inside `updateStatus`.
   - `WatchlistService.updateStatus(uid, titleId, status, type)` — the call site
     `watchlist.page.ts:489` has `item: WatchlistItem` in scope (`item.type`).
   - `TitleDetailService.updateStatus(tmdbId, status, type)` — the call site
     `title-detail.page.ts:172` (`actionSheetButtons`) currently only tracks
     `currentTmdbId`; thread a synchronously-readable `currentType` alongside it
     (see Public types / APIs). **Internal callers of `TitleDetailService.updateStatus`
     that already know the type must pass it** (see the migration note in Public
     types / APIs — `setMovieWatched`, `autoUpdateStatus`, `revertIfNewEpisodes`).

9. **e2e:** add exactly **one** new `test.fixme` alongside the existing
   spec-0034/0050 `test.fixme` stubs inside the
   `test.describe('title-detail F4 …', …)` block in
   `apps/mobile-e2e/src/title-detail.spec.ts` (the `test.describe` is at line 160,
   the existing `test.fixme(...)` stubs at lines 275-330 — there is no
   `describe.fixme` block; do not go looking for one): "set a TV show to Completed via the
   status action sheet → all episodes show watched." The watchlist-page entry point
   to the same underlying write does **not** get a second e2e stub — one flow
   covers the behavior; the watchlist page's action-sheet → service effect is
   covered by watchlist unit + component tests. **No `playwright.config.ts` change.**

## Scope

**In:**

- `TitleDetailService.updateStatus` — add `type` param; on `completed` + `tv`
  batch-mark unwatched episodes watched. Extract a small **private** helper
  `markAllEpisodesWatched(uid, tmdbId): Promise<void>` (reads the whole
  subcollection, batches unwatched docs) reused only from the completed path. All
  needed imports already exist in this file.
- `WatchlistService.updateStatus` — add `type` param; same behavior, implemented
  independently in a slice-local private helper. **Adds** the episode-related
  `scope:shared` imports + AngularFire `collection`/`getDocs`/`writeBatch` this
  file does not yet have.
- `TitleDetailPage` — track `currentType` (mirroring `currentTmdbId`) so the
  action-sheet handler passes the resolved type; update the `updateStatus` call
  site.
- `WatchlistPage.onStatusSelected` — pass `item.type` to `updateStatus`.
- Update the internal `TitleDetailService.updateStatus` callers to pass `type`
  (see Public types / APIs migration note).
- One new e2e `test.fixme` stub (title-detail.spec.ts).
- README updates for both libs.
- Unit + component tests per Test plan.

**Out of scope:**

- Any `scope:shared` change (`libs/shared/domain`, `libs/shared/firestore-schema`).
  Verified: `EpisodeDoc` (documents.ts:45), `WatchlistItem` (documents.ts:32),
  `TitleType` (enums.ts:35), `episodesPath` / `dataToEpisode` / `EpisodeReadData`
  (firestore-schema) all exist and are consumed as-is — **no change needed**.
- Any `scope:functions` change / sync-engine change. The sync engine writes
  episode docs; this spec only re-writes their `watched`/`watchedAt` fields.
- `firestore.rules` — **no change needed** (writing `watched`/`watchedAt` on an
  own-user episode doc is already the permitted write shape spec 0034 relies on).
- `firestore.indexes.json` — **no change needed** (no new query; the completed
  path reads the whole subcollection with no `where`, exactly like
  `revertIfNewEpisodes`/`autoUpdateStatus`).
- `sheriff.config.ts` — **no change needed** (no new lib, no new tag; the new
  watchlist import is `scope:shared`, already allowed — see Sheriff section).
- `.github/workflows/ci.yml` — **no change needed**.
- `apps/mobile-e2e/playwright.config.ts` — **no change needed**.
- **Any new UI / Stitch screen** — this is a pure data-write side effect. When the
  episode docs flip to `watched: true`, the existing episode-watched checkmark UI
  (spec 0034, `episodes$` realtime stream → `SeasonGroup` derivation) re-renders
  reactively. No new visual element.
- **Reverse direction** (leaving `'completed'`) touching episodes (decision 6).
- Auto-status re-derivation on the completed path: the completed write is terminal;
  do **not** call `autoUpdateStatus` after it (that method is for episode-first
  writes, and running it here would be a redundant read). Spec 0050's page-init
  `revertIfNewEpisodes` is untouched and will simply find nothing unwatched after
  this fix runs.

## Affected slices & Sheriff tags

| Slice / lib                 | Tags                                    | Change                                                                 |
| --------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `libs/mobile/title-detail`  | `scope:mobile`, `slice:title-detail`    | `updateStatus` gains `type` + `markAllEpisodesWatched` helper; page tracks `currentType`; README; e2e stub |
| `libs/mobile/watchlist`     | `scope:mobile`, `slice:watchlist`       | `updateStatus` gains `type` + completed-path helper + new `scope:shared` episode imports; page passes `item.type`; README |

**No cross-slice import is introduced.** Each slice imports only its own slice +
`scope:shared`. Specifically, `libs/mobile/watchlist` adds imports of
`episodesPath` / `dataToEpisode` (`@vultus/shared/firestore-schema`),
`EpisodeReadData` (`@vultus/shared/firestore-schema` type) and `EpisodeDoc` /
`TitleType` (`@vultus/shared/domain`) plus AngularFire `collection` / `getDocs` /
`writeBatch`. These are all `scope:shared` (importable by anyone — Sheriff rule 4)
and third-party (AngularFire, not policed), **not** a `slice:watchlist →
slice:title-detail` edge. `libs/mobile/title-detail` already imports every needed
symbol (title-detail.service.ts:1-45), so it adds no new import.

The completed-path helper is duplicated across the two slices (conceptually
similar, implemented independently per file). Justified against the "extract only
at 3+ slices" rule: **2 slices**, with precedent (each slice already duplicates
`STATUS_DISPLAY_ORDER`/`STATUS_LABELS`). Do not extract.

## Data model touchpoints

PLAN §4 — no schema addition, no new collection/field, no converter change.

- **Read (one-shot):** `users/{uid}/watchlist/{titleId}/episodes` via
  `episodesPath(uid, String(tmdbId))` + `collection(...)` + `getDocs(...)` — the
  whole subcollection, no `where` filter (every season, since "completed" means
  the entire show). Each doc mapped via `dataToEpisode(d.data() as
  EpisodeReadData)` to read its current `watched` flag.
- **Write (batched):** for each episode doc with `watched !== true`,
  `batch.update(docSnap.ref, { watched: true, watchedAt: <now> })`. `watchedAt`
  uses the same value convention as `setSeasonWatched`/`setEpisodeWatched`: a JS
  `Date` (`new Date()`), which the AngularFire converter stores as a Firestore
  Timestamp (spec 0034 EpisodeReadData shape). No `setDoc` — episode docs are
  created by the sync engine and must pre-exist (spec 0034 invariant preserved).
- **Write (status):** unchanged — `updateDoc(watchlistItemPath(uid,
  String(tmdbId)), { status })`.

## Public types / APIs

No `scope:shared` type changes. Two slice-local signature widenings:

- **`WatchlistService.updateStatus`**
  - Before: `updateStatus(uid: string | null, titleId: string, status: WatchStatus): void`
  - After: `updateStatus(uid: string | null, titleId: string, status: WatchStatus, type: TitleType): Promise<void>`
  - Rationale for `Promise<void>`: the completed path now awaits a `getDocs` +
    `batch.commit`. The existing body was fire-and-forget (`void updateDoc(...)`);
    returning a promise lets tests await the effect and lets the page keep calling
    it fire-and-forget (`void this.watchlistService.updateStatus(...)`). If the
    implementer prefers to keep the return type `void` and remain fully
    fire-and-forget internally, that is acceptable **provided** the unit tests can
    still deterministically await the Firestore mock calls (e.g. the helper is a
    separately-testable private method). Prefer `Promise<void>` for testability.
  - Only call site: `watchlist.page.ts:489` (`onStatusSelected`) — pass
    `item.type` (the `actionSheetItem: WatchlistItem` already in scope, page.ts:292/485).

- **`TitleDetailService.updateStatus`**
  - Before: `updateStatus(tmdbId: number, status: WatchStatus): Promise<void>`
  - After: `updateStatus(tmdbId: number, status: WatchStatus, type: TitleType): Promise<void>`
  - **Migration note — internal callers must pass `type`:** `updateStatus` is
    called internally by `setMovieWatched` (title-detail.service.ts:380 — always a
    movie, pass `'movie'`), and by `autoUpdateStatus` (lines 456/461/467) and
    `revertIfNewEpisodes` (line 414). The auto-status callers only ever run for the
    context they were invoked in; `autoUpdateStatus`/`revertIfNewEpisodes` are
    entered from episode writes / page-init that already know `type` is `'tv'`
    (`autoUpdateStatus` is only reached via `setEpisodeWatched`/`setSeasonWatched`,
    which are TV-only in practice, and `revertIfNewEpisodes` early-returns on
    non-tv). **Thread the correct `type` to each internal call.** IMPORTANT: the
    completed-episode batch must **not** re-fire from these internal callers in a
    way that loops — `autoUpdateStatus` writing `'completed'` for a fully-watched
    TV show would call the new helper, which then finds **zero** unwatched docs (it
    just watched them) → no batch, no loop. This is safe by decision 2's emptiness
    guard, but the implementer must verify no infinite recursion (the helper does
    NOT call `autoUpdateStatus`; `autoUpdateStatus` calls `updateStatus` which may
    call the helper, which is terminal — one level, no cycle).

- **`TitleDetailPage`** — add a `private currentType: TitleType = 'movie'` field
  (or `'tv'` default — pick a safe default; it is overwritten before any status
  write since the action sheet only opens on a loaded title), kept in sync from
  `detail$` in the constructor exactly like `currentTmdbId` is synced from
  `tmdbId$` (page.ts:276-278). The `actionSheetButtons` handler (page.ts:172)
  becomes `void this.service.updateStatus(this.currentTmdbId, status, this.currentType)`.

- **New private helper** (both services, implemented independently):
  `markAllEpisodesWatched(uid: string, tmdbId: number): Promise<void>` — reads the
  full episodes subcollection, batches `{ watched: true, watchedAt: new Date() }`
  onto every `watched !== true` doc, commits only if ≥1 unwatched, else returns
  without a commit. No status write inside the helper (the caller owns the status
  write). No barrel export (slice-internal).

## UI / Stitch screen refs

**No new Stitch screen and no new visual element.** This is a data-write side
effect. The existing episode-watched checkmark UI built in spec 0034 (the
`episodes$` realtime stream → `groupEpisodes` → `SeasonGroup.watchedCount/allWatched`
→ template checkmarks) re-renders reactively when the episode docs flip to
`watched: true`. If the title-detail page's Episodes section is on screen when a
show is set Completed, the checkmarks and per-season counts update themselves with
no additional wiring. Nothing to design, fetch, or pin. (Per spec 0034 decision 8,
the episode list had no dedicated Stitch screen to begin with.)

## Implementation task graph

The two slice changes touch **disjoint files in disjoint libs** and share no
source file, so they run in **[parallel]**, followed by a **[sequential]** final
task for the e2e stub (single shared e2e file) — READMEs are per-lib and folded
into each parallel task.

### Manifest disjointness assertion

Task A writes only under `libs/mobile/title-detail/**`; Task B writes only under
`libs/mobile/watchlist/**`; Task C writes only `apps/mobile-e2e/src/title-detail.spec.ts`
(no `docs.json` change — the seed already provides unwatched S1 episodes for
tmdbId 2; see Test plan). The three manifests are pairwise disjoint. Task C is sequential (depends on A for
the DOM contract it will eventually assert, though the stub is fixme so it does
not execute).

- **Task A — title-detail slice [parallel]**
  Manifest: `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.page.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`,
  `libs/mobile/title-detail/README.md`
  (create the `.spec.ts` files if the exact names differ — glob
  `libs/mobile/title-detail/src/**` bounds it).
  1. Add `type: TitleType` to `updateStatus`; branch to `markAllEpisodesWatched`
     on `completed` + `tv`.
  2. Add the private `markAllEpisodesWatched` helper (reuse the `setSeasonWatched`
     batch shape, but read the WHOLE subcollection unfiltered and batch only
     `watched !== true` docs; skip commit when none).
  3. Thread `type` through every internal `updateStatus` caller
     (`setMovieWatched` → `'movie'`; `autoUpdateStatus` / `revertIfNewEpisodes`
     → `'tv'`). Verify no recursion (see Public types migration note).
  4. `TitleDetailPage`: add + sync `currentType`; update the action-sheet call site.
  5. Unit + component tests (Test plan).
  6. README: document the new completed-marks-episodes behavior + the widened
     `updateStatus` signature.

- **Task B — watchlist slice [parallel]**
  Manifest: `libs/mobile/watchlist/src/lib/watchlist.service.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.page.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.service.spec.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/README.md`
  (glob `libs/mobile/watchlist/src/**` bounds it).
  1. Add the new `scope:shared` + AngularFire imports (`episodesPath`,
     `dataToEpisode`, `EpisodeReadData`, `TitleType`; `collection`, `getDocs`,
     `writeBatch`).
  2. Add `type: TitleType` to `updateStatus` (widen to `Promise<void>`); branch to
     a slice-local `markAllEpisodesWatched` on `completed` + `tv`.
  3. Add the private `markAllEpisodesWatched` helper (independent copy).
  4. `WatchlistPage.onStatusSelected`: pass `item.type`.
  5. Unit + component tests (Test plan).
  6. README: document the new completed-marks-episodes behavior + the widened
     `updateStatus` signature.

- **Task C — e2e stub [sequential, after A]**
  Manifest: `apps/mobile-e2e/src/title-detail.spec.ts` (this task touches ONLY
  this file — no `docs.json` change, see below).
  Add one `test.fixme` alongside the existing spec-0034/0050 `test.fixme` stubs
  (lines 275-330) inside the `test.describe('title-detail F4 …', …)` block
  (line 160) — there is no `describe.fixme` block. Match the spec-0034/0050 stub
  style, with the standard one-blocker comment (the emulator cannot run under
  Claude Code tools — run in the user's own terminal / CI emulator).
  **Seed data is already sufficient — no `docs.json` change:** verified, the
  spec-0034 seed already provides three unwatched S1 episodes for tmdbId 2
  (`apps/mobile-e2e/emulator-data/seeded/docs.json` lines 44-74 seed
  `s01e01|02|03` all with `"watched": false`, and that watchlist entry has
  `status: "planned"`). No seed-data change is needed for this spec's new e2e stub.

## Test plan

Per PLAN §5 pyramid. All unit/component tests run on **Vitest + Analog**.

**Unit — `TitleDetailService.updateStatus` (title-detail.service.spec.ts):**

- TV + some unwatched episodes → status written **and** a `writeBatch` commits
  `{ watched: true, watchedAt }` for **only** the unwatched docs (assert the
  already-watched docs are not in the batch).
- TV + all episodes already watched → status written, **no** batch commit.
- TV + empty subcollection → status written, **no** batch commit.
- Movie (`type === 'movie'`) → status written, **no** episode read/batch.
- Null uid → no-op (no status write, no episode read).
- Setting a status **other than** `'completed'` (e.g. `'watching'`/`'planned'`/
  `'dropped'`) on a TV show → status written, **no** episode read/batch (forward
  direction only, decision 6).
- Regression / recursion-safety: internal callers still work — `setMovieWatched`
  writes `'completed'` for a watched movie without touching episodes;
  `autoUpdateStatus` advancing an already-fully-watched TV show to `'completed'`
  reaches `markAllEpisodesWatched` but finds zero unwatched docs, so
  `writeBatch.commit` is called **zero times** in that path (assert
  `commit`/`writeBatch` is never invoked — the observable proof there is no
  double-batch-write and no loop/recursion).

**Unit — `WatchlistService.updateStatus` (watchlist.service.spec.ts):** the same
matrix (TV+unwatched → batch; TV+all-watched → no batch; TV+empty → no batch;
movie → no-op; null uid → no-op; non-completed status → no episode write).

**Component — `TitleDetailPage` (title-detail.page.spec.ts):** selecting
"Completed" from the status action sheet invokes `service.updateStatus(currentTmdbId,
'completed', 'tv')` (assert via the mocked service — the component test does not
inspect Firestore). Also assert `currentType` is synced from `detail$` (a loaded TV
detail → the handler passes `'tv'`; a loaded movie detail → passes `'movie'`).

**Component — `WatchlistPage` (watchlist.page.spec.ts):** selecting "Completed"
from an item's status action sheet invokes `watchlistService.updateStatus(uid,
titleId, 'completed', item.type)` (assert via the mocked service).

**e2e (Playwright) — Fixme-gated (one flow):**
Per the e2e rubric this is a `scope:mobile` change to a **critical action**
(status change), so an e2e flow is warranted — but it depends on the Firestore
emulator (which cannot run under Claude Code tools) and possibly seed data, so it
is `test.fixme`:

- **`completed-marks-episodes-watched`** — boot + seed, open the seeded TV title
  (tmdbId 2) detail page, set status to **Completed** via the status action sheet,
  assert every episode row shows the watched state and each season count shows
  `N/N`. Added as a new `test.fixme` alongside the existing spec-0034/0050
  `test.fixme` stubs (lines 275-330) inside the
  `test.describe('title-detail F4 …', …)` block (line 160) in
  `apps/mobile-e2e/src/title-detail.spec.ts` — there is no `describe.fixme` block.
  Standard one-blocker comment. The seed fixture already has three unwatched S1
  episodes for tmdbId 2 (docs.json lines 44-74), so un-skip when the emulator gate
  runs (user's terminal / CI emulator) — no seed change required.

No second e2e stub for the watchlist entry point (decision 9) — one flow covers the
underlying write; the watchlist path is covered by its unit + component tests.

## Definition of done

Tailored PLAN §5 checklist:

- `pnpm nx test mobile-title-detail` and `pnpm nx test mobile-watchlist` green,
  including the new unit + component tests above.
- `pnpm nx lint mobile-title-detail` and `pnpm nx lint mobile-watchlist` green
  (Sheriff module boundaries clean — the new watchlist episode imports are
  `scope:shared`, allowed).
- `pnpm nx typecheck` / affected build green (both widened signatures + all call
  sites updated; no `any`).
- `pnpm nx build mobile` green.
- e2e: the new `test.fixme` stub is present and does not fail the suite; affected
  runnable e2e flows stay green. The fixme flow is a DoD gate only once un-skipped
  against the emulator.
- Both changed libs have tests for the new logic **and** an updated `README.md`
  (CLAUDE.md lib-README rule) describing "manually completing a TV show marks all
  unwatched episodes watched."
- Verified: no change to `libs/shared/**`, `apps/functions/**`, `firestore.rules`,
  `firestore.indexes.json`, `sheriff.config.ts`, `.github/workflows/ci.yml`,
  `apps/mobile-e2e/playwright.config.ts`.

## Risks

- **Auto-status recursion (title-detail).** Widening `updateStatus` with a
  TV-completed branch means internal callers (`autoUpdateStatus`,
  `setMovieWatched`, `revertIfNewEpisodes`) now also hit the branch. The emptiness
  guard (decision 2) prevents a loop — after `autoUpdateStatus` marks the last
  episode and writes `'completed'`, the helper finds zero unwatched docs and does
  nothing. The implementer **must** confirm the helper never calls back into
  `autoUpdateStatus` (it must not) so there is no cycle. Covered by the regression
  unit test.
- **Fire-and-forget vs. awaitable.** `WatchlistService.updateStatus` was `void`
  fire-and-forget; widening to `Promise<void>` for testability must not change the
  page's UX (the page keeps calling it fire-and-forget with `void`). Verify the
  action sheet still closes immediately and does not block on the batch.
- **Write cost on large shows.** A show with hundreds of unwatched episodes issues
  one `writeBatch`. Firestore batches cap at 500 ops; a very long-running series
  could exceed that. This mirrors the existing `setSeasonWatched` behavior (which
  is per-season, so smaller) — spec 0034/0050 did not chunk batches either. Flagged
  as a known limitation; **not** in scope to chunk here (personal-scale watchlists,
  and no current show approaches 500 episodes in one subcollection). If it becomes
  real, chunk at 500 in a follow-up.
- **Seed-data availability for the e2e fixme.** Resolved — no risk. The spec-0034
  seed already provides three unwatched S1 episodes for tmdbId 2
  (`apps/mobile-e2e/emulator-data/seeded/docs.json` lines 44-74, all
  `"watched": false`; watchlist entry `status: "planned"`), so the fixme stub needs
  no `docs.json` change.
- **TMDB/data-source accuracy.** N/A — this spec writes only user-owned
  `watched`/`watchedAt` flags on already-synced episode docs; it does not read or
  trust any TMDB/Trakt field.
