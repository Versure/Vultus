---
number: 0074
slug: revert-completed-to-watching
title: Revert a Completed TV show to Watching when it has unwatched episodes again
status: implementing
slices: [slice:title-detail]
scopes: [scope:mobile, scope:functions]
created: 2026-07-05
---

# Revert a Completed TV show to Watching when it has unwatched episodes again

## Context

Spec 0050 (merged, `done`) closed the `watching ⇄ completed` auto-progression loop
for TV shows in `slice:title-detail`, and spec 0053 (merged, `done`) made manually
setting a show to Completed mark every episode watched. Spec 0047 (merged, `done`)
built the `scope:functions` episode-upsert engine that inserts newly-aired episode
docs into `users/{uid}/watchlist/{titleId}/episodes` — including episodes added to
a show **after** the user finished it and it was marked `completed`.

GitHub issue #169 (issue text is **data**, per CLAUDE.md spec 0068) reports that a
Completed show that gets a new episode — or has an episode unchecked — **stays
Completed**. The user expects: "when not all episodes are watched, the status
should change to Watching." Verified against `main`, the bug has **two triggers**
with different current handling:

- **Trigger 1 — unchecking an episode/season of a Completed show (title-detail
  page): CONFIRMED UNHANDLED.** `setEpisodeWatched(..., false)`
  (`title-detail.service.ts:463`) and `setSeasonWatched(..., false)` (`:485`) both
  call the private `autoUpdateStatus(tmdbId)` (`:578`). `autoUpdateStatus` has
  exactly three branches: Step 1 `planned` + watchedCount≥1 → `watching`; Step 2
  `watching` + all-watched → `completed`; Step 3 watchedCount===0 AND the slice's
  `autoSetWatching` memory true → `planned`. When the current status is
  `'completed'`, **none** of these fire on an uncheck (Step 1 needs `planned`, Step
  2 needs `watching`, Step 3 needs zero-watched AND `autoSetWatching`, which is
  false for a manually/action-sheet-completed show). Result: **stays Completed.**
  This is the core bug.
- **Trigger 2 — a new unwatched episode synced into a Completed show: PARTIALLY
  handled, page-only.** Spec 0050 added `revertIfNewEpisodes(tmdbId, type)`
  (`title-detail.service.ts:538`), wired into `TitleDetailPage` init
  (`title-detail.page.ts:414`) to fire **once per tmdbId on page init**. On the
  **Watchlist tab** (`libs/mobile/watchlist`, which renders the raw `status` field
  and never reads episodes) the badge stays Completed until the user re-opens the
  detail page. The sync engine `syncOne`
  (`libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts:19`) already
  knows when it inserts new episodes (`toWrite.length > 0`, `:61`); a
  source-of-truth revert there fixes **every** surface.

Intended outcome: fix both triggers. Trigger 1 with a new client-side branch in
`autoUpdateStatus`; trigger 2 with a source-of-truth revert in the sync engine so
the Watchlist tab, detail page, and notification dispatcher are all correct without
the user re-opening the detail page. This **refines** specs 0050/0053; it leaves
their working code (including the page-init `revertIfNewEpisodes`) intact.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Fix BOTH triggers** (both are named in issue #169).

**D2. Trigger 1 fix — client-side, in `slice:title-detail`'s `autoUpdateStatus`.**
Add a new branch, evaluated **FIRST** (before the existing Step 1/2/3), that fires
when the effective current status is `'completed'` **AND** `total > 0` **AND**
`watchedCount < total` (the show is no longer all-watched) →
`updateStatus(tmdbId, 'watching', 'tv')` and **RETURN**. It must short-circuit
**before** the existing Step 3 (see D3).

- Guard `total > 0`: an empty subcollection cannot conclude "not all watched" → no
  revert (mirrors the existing `total > 0` guard on Step 2).
- `dropped`/`null` status untouched (the early-return at the top of
  `autoUpdateStatus`, `:584`, already handles `null`/`dropped`).
- Covers both `setEpisodeWatched(..., false)` and `setSeasonWatched(..., false)`
  because both call `autoUpdateStatus`.

**D3. Uncheck target status = ALWAYS `'watching'`.** A Completed show that loses
all-watched becomes `'watching'`, **even if the user unchecks every episode**
(watchedCount === 0). This matches issue #169 ("when not all episodes are watched →
Watching"). This is **why** the new `completed → watching` branch (D2) must be
evaluated **before** the existing Step 3 zero-watched → planned branch: a show that
was auto-advanced (its `autoSetWatching` memory can still be `true` after Step 2
set `completed`) and then fully unchecked must land on `'watching'`, not
`'planned'`. The new branch does **NOT** modify the `autoSetWatching` map (leave
the memory untouched; it is the planned→watching lineage's concern, not this
revert's).

**D4. Trigger 2 fix — sync engine (`scope:functions`), source-of-truth revert.** In
`syncOne` (`episode-sync-engine.ts:19`), **AFTER** `episodes.writeEpisodes(...)`
(`:54`), when `toWrite.length > 0` (≥1 NEW episode inserted this run) **AND** a new
optional `watchlistStatus` port is present, read the show's current watchlist
status; if it is `'completed'`, set it to `'watching'`. This fixes status at the
source so every surface (Watchlist tab, detail page, notifications) is correct
without depending on the user opening the detail page.

- New optional port `WatchlistStatusStore` in
  `libs/functions/sync-episodes/src/lib/ports.ts`:
  `getStatus(uid, titleId): Promise<WatchStatus | null>` and
  `setStatus(uid, titleId, status: WatchStatus): Promise<void>`. Import
  `WatchStatus` from `@vultus/shared/domain` (`scope:shared` — allowed). Export the
  new type from the lib barrel `src/index.ts`.
- Add optional `watchlistStatus?: WatchlistStatusStore` to `EpisodeSyncConfig`
  (`engine/types.ts`). It is **OPTIONAL by design**: entry point A (the on-add
  `onDocumentCreated` trigger in `apps/functions/src/sync-episodes.ts`) **OMITS**
  it (a freshly-added show never needs a completed→watching revert), exactly as it
  already omits the `watchlist` port. Only the daily pass (entry point B,
  `apps/functions/src/main.ts:320-327`) wires it.
- The revert only fires when `toWrite.length > 0` (a run that inserts nothing does
  not touch status). Insert-only invariant preserved — the engine never overwrites
  episode `watched`/`watchedAt` (spec 0047), and the status write is a **separate
  watchlist-doc write**.
- **Optional observability field (INCLUDED):** add an optional
  `statusRevertedToWatching?: boolean` to `EpisodeUpsertResult`
  (`engine/types.ts`), set `true` on the `'synced'` result when the daily-pass
  revert fired. It is optional so existing consumers/tests are unaffected. **Its
  one consumer is `main.ts`'s episode-sync-pass log** (Task C step 3): the
  aggregate `episode sync pass complete` log line (`main.ts:238`, which already
  reports `episodesSynced`/`episodesErrored`) also surfaces a
  `revertedToWatching` count derived from
  `episodeResults.filter((r) => r.statusRevertedToWatching).length`. Keep the
  field optional; the log addition is the only reader.

**D5. Adapter + wiring (`apps/functions`).** Add
`createWatchlistStatusStoreAdapter(db: Firestore): WatchlistStatusStore` in
`apps/functions/src/sync-episodes.ts`, implemented against firebase-admin Firestore
using `watchlistItemPath(uid, titleId)` (from `@vultus/shared/firestore-schema`,
`users/{uid}/watchlist/{titleId}`): `getStatus` reads the doc and returns
`data.status ?? null`; `setStatus` does
`db.doc(watchlistItemPath(...)).update({ status })`. Wire it into the entry-point-B
engine config in `apps/functions/src/main.ts:320-327` (alongside
`tmdb`/`episodes`/`watchlist`). Do **NOT** wire it into the entry-point-A on-add
trigger (`syncWatchlistEpisodes`, `sync-episodes.ts:152`) — that stays as-is. The
Admin SDK bypasses Firestore security rules, so **no `firestore.rules` change** is
needed for this write.

**D6. Keep the spec-0050 client-side `revertIfNewEpisodes` as-is
(belt-and-suspenders).** After D4, the sync reverts at the source, so the page-init
`revertIfNewEpisodes` (`title-detail.service.ts:538`, wired at
`title-detail.page.ts:414`) becomes largely redundant but is harmless and
idempotent (it will usually find status already `'watching'` → no-op). Do **NOT**
remove or modify it. The two are **defense-in-depth, not a conflict** — the sync
fixes the source, the page-init revert is a fallback for any interim state.

**D7. No `scope:shared` change.** `WatchStatus`, `TitleType`, `WatchlistItem`,
`EpisodeDoc`, `episodesPath`, `watchlistItemPath`, `dataToEpisode`,
`dataToWatchlistItem` all already exist and are consumed as-is (verified:
`WatchStatus` at `libs/shared/domain/src/lib/enums.ts:11`, exported from
`@vultus/shared/domain`; `watchlistItemPath` at
`libs/shared/firestore-schema/src/lib/paths.ts:34`). **No new shared field**, so no
F2 shared-type ripple.

**D8. No cross-scope import.** `scope:mobile` (title-detail) and `scope:functions`
(sync-episodes) changes are independent — no import crosses between them (CLAUDE.md
hard rule). The functions lib stays Firebase-free (all I/O via the new port); the
Admin-SDK adapter lives only in `apps/functions`.

**D9. `firestore.rules` / `firestore.indexes.json` / `sheriff.config.ts` /
`ci.yml` / `playwright.config.ts` — NO change (verify-and-record).** Owner-only
`users/{userId}/{document=**}` already covers the client status write; the
functions write uses the Admin SDK (rules-exempt). The functions status read is a
single-doc `get` (`watchlistItemPath`) — no query, no index. No new lib/tag.
Record each as "no change needed" in the PR.

**D10. Cloud Functions deploy gate applies.** Because `apps/functions` **and** a
`scope:functions` lib's engine/ports change, the DoD MUST include
`pnpm nx run functions:deploy-preflight` (a CI gate) and note that shipping
requires `/deploy-functions` (do **NOT** deploy from the spec/implement flow —
leave it to the maintainer). See CLAUDE.md "Cloud Functions deploy gate."

## Scope

**In scope:**

- **`slice:title-detail` — new `completed → watching` branch in
  `autoUpdateStatus`** (D2/D3), evaluated before the existing Step 1/2/3; unit
  tests; README auto-status section.
- **`slice:sync-episodes` — new `WatchlistStatusStore` port**, optional
  `watchlistStatus` config on `EpisodeSyncConfig`, optional
  `statusRevertedToWatching` on `EpisodeUpsertResult`, the `syncOne` revert logic
  (D4), barrel export; unit tests; README.
- **`apps/functions` — `createWatchlistStatusStoreAdapter`** + wiring into
  entry-point-B (`main.ts`) only (D5); unit tests.
- **One new e2e `test.fixme` stub** in `apps/mobile-e2e/src/title-detail.spec.ts`.
- README updates for both changed libs (title-detail + sync-episodes).

**Out of scope:**

- **`scope:shared` change** (D7): `WatchStatus`/`TitleType`/`WatchlistItem`/
  `EpisodeDoc`/`episodesPath`/`watchlistItemPath`/`dataToEpisode`/
  `dataToWatchlistItem` all exist and are consumed as-is — no new field.
- **Removing/modifying the spec-0050 `revertIfNewEpisodes`** (D6) — kept as
  defense-in-depth.
- **Any `slice:watchlist` change** — the Watchlist tab renders `status` reactively;
  the sync-side revert (D4) fixes the value it reads, no watchlist-slice code
  change.
- **Entry-point-A (on-add trigger) revert** — a freshly-added show never needs a
  completed→watching revert (D4); the trigger omits the port, unchanged.
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `.github/workflows/ci.yml`, `apps/mobile-e2e/playwright.config.ts`** — no change
  (D9; verify-and-record).
- **Un-skipping any e2e** / emulator seed change — the new flow is `test.fixme`
  (emulator cannot run under Claude Code tools — project memory).
- **New UI / Stitch screen** — this is a reactive status side-effect (no new
  element). See UI section.

## Affected slices & Sheriff tags

| Project                 | Path                           | Sheriff tags                             | Change                                                                                                                                         |
| ----------------------- | ------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-title-detail     | `libs/mobile/title-detail`     | `scope:mobile`, `slice:title-detail`     | New `completed → watching` branch in `autoUpdateStatus` (D2/D3, evaluated before Step 3); service unit tests; README                           |
| functions-sync-episodes | `libs/functions/sync-episodes` | `scope:functions`, `slice:sync-episodes` | New `WatchlistStatusStore` port; optional `watchlistStatus` config + `statusRevertedToWatching` result field; `syncOne` revert; barrel; README |
| functions (app)         | `apps/functions`               | `scope:functions`                        | `createWatchlistStatusStoreAdapter`; wire into entry-point-B `main.ts` config only; adapter/handler unit tests                                 |
| mobile-e2e              | `apps/mobile-e2e`              | (e2e app)                                | One new `test.fixme` stub in `title-detail.spec.ts`                                                                                            |

- **No cross-slice / cross-scope import (D8).** `slice:title-detail` reuses imports
  it already has (`WatchStatus`/`TitleType` from `@vultus/shared/domain`,
  `episodesPath`/`watchlistItemPath`/`dataToEpisode`/`dataToWatchlistItem` from
  `@vultus/shared/firestore-schema`, AngularFire) — **no new import**. The
  `sync-episodes` lib adds one import: `WatchStatus` from `@vultus/shared/domain`
  (`scope:shared`, importable by anyone — Sheriff rule 4); it stays Firebase-free
  and imports no other slice. `apps/functions` may import `@vultus/functions/*` +
  `@vultus/shared/*` + Firebase (rule 3). **No `scope:mobile ↔ scope:functions`
  edge is introduced.**
- **No `shared/` extraction.** The `completed → watching` revert lives inside
  `slice:title-detail`; the sync-side revert inside `slice:sync-episodes`. Two
  independent surfaces (not the same logic), far short of the 3+-slice rule.
- **No `sheriff.config.ts` change.** No new lib; the existing path globs already
  tag `libs/mobile/title-detail/src`, `libs/functions/sync-episodes/src`, and
  `apps/functions`. Record "no `sheriff.config.ts` change needed" in the PR.

## Data model touchpoints

PLAN §4 paths. **No new field, no new collection, no converter change** (D7).

| PLAN §4 path                                            | Access                                            | By                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}/episodes` (collection) | **read (one-shot, in-memory count)**              | `autoUpdateStatus` (title-detail) — existing read, unchanged; the new branch uses the same `total`/`watchedCount` |
| `users/{uid}/watchlist/{titleId}` (doc)                 | **read (status) + update (`status`)** — client    | `autoUpdateStatus` writes `{ status: 'watching' }` via the existing `updateStatus`/`updateDoc`                    |
| `users/{uid}/watchlist/{titleId}` (doc)                 | **read (status) + update (`status`)** — functions | new `WatchlistStatusStore` adapter (`getStatus`/`setStatus`) via `watchlistItemPath`, Admin SDK                   |

- **Trigger 1 (client, `slice:title-detail`).** The new branch reuses
  `autoUpdateStatus`'s already-computed `total`/`watchedCount` (from the one-shot
  `getDocs` over `episodesPath`, `:587`) and the effective `status` (from
  `currentStatus`, `:583`). No new read. The revert write is the **existing**
  `updateStatus(tmdbId, 'watching', 'tv')` write path (a bare
  `updateDoc(watchlistItemPath, { status })`, `:394`) — **no new write target, no
  episode-doc write.**
- **Trigger 2 (functions, `slice:sync-episodes` + `apps/functions`).** After
  `writeEpisodes`, when `toWrite.length > 0`, the engine calls
  `watchlistStatus.getStatus(uid, titleId)`; if `'completed'` → `setStatus(uid,
titleId, 'watching')`. The adapter (`apps/functions`) reads/updates
  `users/{uid}/watchlist/{titleId}` via `watchlistItemPath`. This is a **separate
  watchlist-doc write** — it never touches episode docs (insert-only invariant of
  spec 0047 preserved).
- **No `firestore.rules` change — VERIFY and RECORD (D9).** Owner-only
  `users/{userId}/{document=**}` already covers the client's `status` update; the
  functions write uses the **Admin SDK** (bypasses rules). Do **NOT** edit
  `firestore.rules`.
- **No `firestore.indexes.json` change — VERIFY and RECORD (D9).** The client read
  is the existing episodes subcollection read (no `where`/`orderBy`); the functions
  read is a single-doc `get` (`watchlistItemPath`) — no query. Record "no index
  change needed."

## Public types / APIs

No HTTP endpoint, no callable, **no `scope:shared` type change** (D7).

### `slice:title-detail` — `TitleDetailService.autoUpdateStatus` (private)

No signature change. A new branch is prepended (binding intent; the branch
placement is the contract, per D2/D3):

```ts
// (existing early-returns: null uid, then null/dropped status — unchanged)
// (existing one-shot episodes read → total, watchedCount — unchanged)

// NEW (spec 0074, D2/D3) — evaluate FIRST, before Step 1/2/3.
// A Completed show that is no longer all-watched reverts to 'watching'
// (ALWAYS 'watching', even at watchedCount === 0 — D3), short-circuiting the
// Step 3 zero-watched → planned branch. Does NOT touch the autoSetWatching map.
if (status === 'completed' && total > 0 && watchedCount < total) {
  await this.updateStatus(tmdbId, 'watching', 'tv');
  return;
}

// Step 1: planned → watching  (unchanged)
// Step 2: watching + all watched → completed  (unchanged)
// Step 3: zero watched + autoSetWatching → planned  (unchanged)
```

No change to `setEpisodeWatched`, `setSeasonWatched`, `updateStatus`,
`revertIfNewEpisodes`, `tracked$`, `episodes$`, or the barrel surface.

### `slice:sync-episodes` — new port + config/result additions

`src/lib/ports.ts` — new port (exported from the barrel):

```ts
import type {
  Episode,
  EpisodeDoc,
  TitleType,
  WatchStatus,
} from '@vultus/shared/domain';

/** Reads and updates the watchlist doc's `status` for a (uid, titleId). Used by
 *  the daily pass to revert a `'completed'` show to `'watching'` when new
 *  episodes are inserted (spec 0074). Admin-SDK-backed in apps/functions; faked
 *  in tests. Firebase-free interface. */
export interface WatchlistStatusStore {
  getStatus(uid: string, titleId: string): Promise<WatchStatus | null>;
  setStatus(uid: string, titleId: string, status: WatchStatus): Promise<void>;
}
```

`src/lib/engine/types.ts` — additive, both optional:

```ts
export interface EpisodeSyncConfig {
  tmdb: TmdbEpisodeSource;
  episodes: EpisodeStore;
  watchlist?: WatchlistTvSource;
  /** Present only for the daily pass (entry point B). When present, `syncOne`
   *  reverts a `'completed'` show to `'watching'` after inserting ≥1 new episode
   *  (spec 0074). Omitted by the on-add trigger (entry point A). */
  watchlistStatus?: WatchlistStatusStore;
}

export interface EpisodeUpsertResult {
  // …existing fields unchanged…
  /** True when this run reverted the show from 'completed' to 'watching'
   *  (spec 0074). Optional — absent on runs that did not revert. */
  statusRevertedToWatching?: boolean;
}
```

`src/lib/engine/episode-sync-engine.ts` — `syncOne`, after
`await episodes.writeEpisodes(uid, titleId, toWrite);` (`:54`):

```ts
let statusRevertedToWatching = false;
if (toWrite.length > 0 && watchlistStatus) {
  const current = await watchlistStatus.getStatus(uid, titleId);
  if (current === 'completed') {
    await watchlistStatus.setStatus(uid, titleId, 'watching');
    statusRevertedToWatching = true;
  }
}
// include `statusRevertedToWatching` on the returned 'synced' result.
```

Binding contract: the revert fires only when `toWrite.length > 0` **and** the port
is present **and** the current status is `'completed'`; it is a **separate**
watchlist write (episode docs untouched). Destructure `watchlistStatus` from
`config` alongside `{ tmdb, episodes, watchlist }` (`:17`).

`src/index.ts` — add `WatchlistStatusStore` to the exported ports.

### `apps/functions` — `createWatchlistStatusStoreAdapter` (D5)

`apps/functions/src/sync-episodes.ts` — new exported adapter (SDK enters only here):

```ts
import { watchlistItemPath } from '@vultus/shared/firestore-schema';
import type { WatchStatus } from '@vultus/shared/domain';
import type { WatchlistStatusStore } from '@vultus/functions/sync-episodes';

export function createWatchlistStatusStoreAdapter(
  db: Firestore,
): WatchlistStatusStore {
  return {
    async getStatus(uid, titleId): Promise<WatchStatus | null> {
      const snap = await db.doc(watchlistItemPath(uid, titleId)).get();
      const data = snap.data() as { status?: WatchStatus } | undefined;
      return data?.status ?? null;
    },
    async setStatus(uid, titleId, status): Promise<void> {
      await db.doc(watchlistItemPath(uid, titleId)).update({ status });
    },
  };
}
```

`apps/functions/src/main.ts:320-327` — wire it into the entry-point-B config
alongside `tmdb`/`episodes`/`watchlist`:

```ts
createEpisodeEngine: (firestore: Firestore): EpisodeSyncEngine =>
  createEpisodeSyncEngine({
    tmdb: createTmdbEpisodeSourceAdapter(/* … */),
    episodes: createEpisodeUpsertStore(firestore),
    watchlist: createWatchlistTvSourceAdapter(firestore),
    watchlistStatus: createWatchlistStatusStoreAdapter(firestore), // NEW (spec 0074)
  }),
```

Do **NOT** add `watchlistStatus` to the entry-point-A trigger
(`syncWatchlistEpisodes`, `sync-episodes.ts:152-171`) — it keeps its current
two-port config (`tmdb`, `episodes`).

## UI / Stitch screen refs

**No new Stitch screen and no new visual element.** This is a `status`-value
change on the existing watchlist doc. Both surfaces already render `status`
reactively:

- **Title-detail page:** the status badge (spec 0016/0034) re-renders from
  `Completed` to `Watching` via the already-wired realtime `tracked$` stream
  (`title-detail.service.ts:300`) — the spec-0050 precedent that this badge is
  reactive holds. No new wiring.
- **Watchlist tab:** the card's status badge re-renders when the sync-side revert
  (D4) writes `{ status: 'watching' }` — the existing realtime watchlist stream
  drives it. No `slice:watchlist` code change.

Token wiring: the badge consumes the existing `--vultus-status-*` / `--ion-*` vars
from `shared/ui-kit` `theme.scss`; **do not hardcode a hex**. Per
`docs/design/vultus-design-system.md`, `--vultus-status-watching` /
`--vultus-status-completed` are the status accents (do not transcribe hexes here).
No new icon, no new font.

Record "no new UI element — reactive status transition only; no Stitch capture
required" in the PR (mirroring the spec-0050 precedent). Visual verification is
limited to confirming the badge transitions (uncheck an episode of a Completed show
→ badge flips to Watching) via `pnpm nx run mobile:serve-mock` or the component
test.

## Implementation task graph

Three implementation areas. **Task A (title-detail, `scope:mobile`) is independent
of Tasks B+C (functions).** Task B (sync-episodes lib) and Task C (apps/functions
adapter+wiring) share the functions flow: **C depends on B's new port type.** Task
D (e2e stub) depends on A.

### Manifest disjointness assertion (for the orchestrator)

- **Task A** writes only under `libs/mobile/title-detail/src/lib/**` +
  `libs/mobile/title-detail/README.md`.
- **Task B** writes only under `libs/functions/sync-episodes/src/**` +
  `libs/functions/sync-episodes/README.md`.
- **Task C** writes only `apps/functions/src/sync-episodes.ts`,
  `apps/functions/src/main.ts`, and the matching `.spec.ts`
  (`apps/functions/src/sync-episodes.spec.ts` and/or `main.spec.ts`).
- **Task D** writes only `apps/mobile-e2e/src/title-detail.spec.ts`.

The four manifests are **pairwise disjoint**. Only A and D can safely run in
parallel with the functions work; **B → C is sequential** (C imports B's
`WatchlistStatusStore` type). A is independent of B/C. No file appears in two
manifests. No `libs/shared/**`, `firestore.rules`, `firestore.indexes.json`,
`sheriff.config.ts`, `ci.yml`, or `playwright.config.ts` is touched.

- **Task A — title-detail slice [parallel]** (frontend-engineer).
  Manifest: `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
  `libs/mobile/title-detail/README.md`.
  1. Add the `completed → watching` branch in `autoUpdateStatus`, evaluated FIRST
     (before Step 1/2/3), firing on `status === 'completed' && total > 0 &&
watchedCount < total` → `updateStatus(tmdbId, 'watching', 'tv')` + `return`
     (D2/D3). Do NOT touch the `autoSetWatching` map.
  2. Preserve every surviving 0034/0050 transition (planned→watching;
     watching+last→completed; watching+non-last→no advance; dropped→no write;
     un-watch-to-zero→planned only in the `watching`/autoSetWatching lineage; no
     double-write when already completed and re-marked watched).
  3. Service unit tests (Test plan).
  4. README: document the new `completed → watching` revert-on-uncheck branch.
  - **No page-template change** — `setEpisodeWatched`/`setSeasonWatched` already
    route through `autoUpdateStatus`; confirm the page needs no edit.

- **Task B — sync-episodes lib [sequential, before C]** (backend-engineer).
  Manifest: `libs/functions/sync-episodes/src/lib/ports.ts`,
  `libs/functions/sync-episodes/src/lib/engine/types.ts`,
  `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts`,
  `libs/functions/sync-episodes/src/index.ts`,
  `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.spec.ts`,
  `libs/functions/sync-episodes/README.md`.
  1. `ports.ts`: add `WatchlistStatusStore` (import `WatchStatus` from
     `@vultus/shared/domain`).
  2. `engine/types.ts`: add optional `watchlistStatus?: WatchlistStatusStore` to
     `EpisodeSyncConfig`; add optional `statusRevertedToWatching?: boolean` to
     `EpisodeUpsertResult`.
  3. `engine/episode-sync-engine.ts`: after `writeEpisodes`, when `toWrite.length
     > 0 && watchlistStatus`, read status; if `'completed'`→`setStatus(...,
     > 'watching')`and set`statusRevertedToWatching`on the result. Destructure`watchlistStatus` from config.
  4. `src/index.ts`: export `WatchlistStatusStore`.
  5. Unit tests (Test plan).
  6. README: document the new port, the daily-pass source-of-truth revert, and that
     entry point A omits the port by design.

- **Task C — apps/functions adapter + wiring [sequential, after B]**
  (backend-engineer).
  Manifest: `apps/functions/src/sync-episodes.ts`, `apps/functions/src/main.ts`,
  `apps/functions/src/sync-episodes.spec.ts` and/or `apps/functions/src/main.spec.ts`.
  1. `sync-episodes.ts`: add `createWatchlistStatusStoreAdapter(db)` (D5). Do NOT
     wire it into `syncWatchlistEpisodes` (entry point A).
  2. `main.ts`: add `watchlistStatus: createWatchlistStatusStoreAdapter(firestore)`
     to the entry-point-B `createEpisodeEngine` config (`:320-327`).
  3. `main.ts`: extend the `episode sync pass complete` log (`:238`) with a
     `revertedToWatching` count derived from
     `episodeResults.filter((r) => r.statusRevertedToWatching).length` — the sole
     consumer of the D4 observability field.
  4. Unit tests (Test plan): the adapter reads/updates `status`; entry-point-B
     config includes `watchlistStatus`; entry-point-A trigger does NOT.

- **Task D — e2e stub [sequential, after A]** (frontend-engineer / qa-runner).
  Manifest: `apps/mobile-e2e/src/title-detail.spec.ts` (ONLY this file).
  Add ONE `test.fixme` inside the `test.describe('title-detail F4 …', …)` block,
  next to the **spec-0053** Completed-status fixme (which targets the same
  `[data-test="status-control"]` locator this new assertion needs) — "uncheck an
  episode of a Completed TV show → status badge shows Watching." (The spec-0034
  episode-watch fixmes live in a separate later `describe` block; place this one
  in the F4 block by the 0053 stub, not there.) Match the existing stub style +
  the standard one-blocker emulator comment (the Firestore emulator cannot
  run under Claude Code tools — runs in CI / the user's own terminal). **No
  `playwright.config.ts` change.**
  - **Seed:** prefer **no `docs.json` change**. The existing seed's tmdbId 2 is
    `status: 'planned'` with three unwatched S1 episodes (docs.json). The fixme can
    set up the Completed state via the UI (mark all episodes watched → auto-advances
    to Completed, or set Completed via the action sheet → episodes batch-marked),
    then uncheck one episode and assert the badge shows Watching. If the
    implementer finds the UI setup infeasible, note (don't perform) whether a
    Completed-with-watched-episodes seed addition would be needed; the stub is
    fixme so it does not execute in CI-less runs.

## Test plan

Per the PLAN §5 pyramid. All unit tests run on **Vitest + Analog**; all Firebase
access is mocked/faked (no live Firebase, no emulator, no network, no secrets).
**Rendered-text note (F3):** the e2e badge assertion below asserts the exact string
`^Watching$`; no component test asserts rendered copy here (Task A is service-only),
so there is no whitespace-normalization risk to guard.

**Unit — `TitleDetailService.autoUpdateStatus`
(`title-detail.service.spec.ts`, Vitest, mocked AngularFire + `AUTH_UID`), exercised
via `setEpisodeWatched` / `setSeasonWatched`:**

- **`completed` + uncheck one of several watched episodes** (watchedCount < total,
  total > 0) → `updateDoc` on the watchlist doc with `{ status: 'watching' }`.
- **`completed` + uncheck ALL episodes** (watchedCount === 0, total > 0) → `{
status: 'watching' }` (D3 — **NOT** `'planned'`), **including** the case where
  `autoSetWatching` memory is `true` (auto-advanced lineage) — this asserts the new
  branch precedes Step 3.
- **`completed` + empty subcollection** (total === 0) → **NO** status write (the
  `total > 0` guard).
- **PRESERVE all surviving 0034/0050 cases:** `planned` + first → `watching`;
  `watching` + last → `completed`; `watching` + non-last → no advance; `dropped` →
  no write; un-watch-to-zero → `planned` **only** in the auto-set-`watching`
  (planned lineage) case, i.e. status was `'watching'` not `'completed'`; no
  double-write when already `completed` and re-marked watched.

**Unit — `episode-sync-engine.spec.ts` (Vitest, in-memory fake ports):**

- `syncOne` inserts ≥1 new episode into a show whose `watchlistStatus.getStatus`
  returns `'completed'` → calls `setStatus(uid, titleId, 'watching')`; result has
  `statusRevertedToWatching: true`.
- inserts ≥1 new episode, status `'watching'` / `'planned'` / `'dropped'` / `null`
  → **NO** `setStatus` call; `statusRevertedToWatching` absent/false.
- inserts **ZERO** new episodes (all already existed) → **NO** `setStatus` call
  (pin: no status write regardless of `getStatus`).
- `watchlistStatus` port **ABSENT** (entry-point-A shape) → no revert, no throw.
- **Insert-only invariant unchanged** — the existing 0047 assertions (never
  overwrite existing ids, `writeEpisodes` receives only new docs) still pass.

**Unit — `apps/functions` adapter (`sync-episodes.spec.ts` / `main.spec.ts`,
fake `db`):**

- `createWatchlistStatusStoreAdapter` reads `status` from the watchlist doc
  (`getStatus`) and `.update({ status })` (`setStatus`).
- entry-point-B `createEpisodeEngine` config includes `watchlistStatus`;
  entry-point-A `syncWatchlistEpisodes` config does **NOT**.

**Component:** **none required.** Task A is a service-only change (no template
change; the reactive `tracked$` badge already re-renders — spec 0050 precedent that
the badge is reactive). Stated explicitly rather than omitted.

**e2e (Playwright) — one new `test.fixme` stub (Task D).** Per the rubric this is a
`scope:mobile` critical-action behavior (status change), so a flow is warranted, but
it depends on the Firestore emulator (cannot run under Claude Code tools) → it is
`test.fixme`: **"uncheck an episode of a Completed TV show → status badge shows
Watching"** (`toHaveText(/^Watching$/)` on the status control). One new fixme stub,
added alongside the existing spec-0034/0050/0053 stubs; standard one-blocker comment.

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to a task above.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set is `mobile-title-detail` (+ `mobile`), `functions-sync-episodes`, and
      `functions`. (Tasks A, B, C)
- [ ] **Sheriff clean** (in the lint above): no cross-scope import
      (`scope:mobile ↔ scope:functions`), title-detail uid via `AUTH_UID`, the
      `sync-episodes` lib stays Firebase-free (the new port is the only new import,
      `WatchStatus` from `@vultus/shared/domain`). (Tasks A, B)
- [ ] `pnpm nx run functions:deploy-preflight` green (D10 — CI gate for the
      `apps/functions`/lib change). (Task C)
- [ ] **Unit tests** as in the Test plan: title-detail `completed → watching`
      revert (uncheck-one, uncheck-all-→-watching-not-planned, empty-subcollection
      guard, all surviving 0034/0050 transitions); engine revert (completed→watching
      only, other statuses no-op, zero-insert no-op, port-absent no-op, insert-only
      preserved); adapter read/update + entry-point wiring. (Tasks A, B, C)
- [ ] **e2e fixme present** — one new `test.fixme` in
      `apps/mobile-e2e/src/title-detail.spec.ts`; suite stays green (pending, not
      failing); no `playwright.config.ts` change. (Task D)
- [ ] **Both changed lib READMEs updated** (CLAUDE.md lib-README rule):
      `libs/mobile/title-detail/README.md` (revert-on-uncheck) and
      `libs/functions/sync-episodes/README.md` (new port + daily-pass revert). No
      other lib README changes. (Tasks A, B)
- [ ] **Verify-and-record NO change (D7/D9):** `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, `.github/workflows/ci.yml`,
      `apps/mobile-e2e/playwright.config.ts`, and all `scope:shared` files are
      NOT modified — owner-only `users/{userId}/{document=**}` covers the client
      status write; the functions write uses the Admin SDK (rules-exempt); the
      status read is a single-doc `get` (no index); no new shared field.
- [ ] **Guardrail verifications (review-checked):** (a) insert-only invariant
      preserved — no episode-doc `watched`/`watchedAt` overwrite (spec 0047); (b)
      the sync-side revert fires **only** when `toWrite.length > 0` **and** the port
      is present **and** status is `'completed'`; (c) uncheck target is **always**
      `'watching'` (D3) and the new branch is evaluated **before** Step 3 (D2/D3);
      (d) the new branch does **not** modify the `autoSetWatching` map; (e) the
      spec-0050 `revertIfNewEpisodes` is left intact (defense-in-depth, D6); (f)
      entry-point-A trigger omits the `watchlistStatus` port; (g) **no secret read
      or written**; (h) deploy is left to `/deploy-functions` (NOT auto-run from the
      implement flow, D10).
- [ ] **UI — reactive status transition only (no new element).** The status badge
      flips reactively (uncheck an episode of a Completed show → `Watching`),
      verified via `pnpm nx run mobile:serve-mock` or by inspection. No new Stitch
      screen. Record "no new UI element — reactive status transition only" in the PR.
- [ ] **PR description records:** the two-scope nature (`scope:mobile` +
      `scope:functions`), the `functions:deploy-preflight` requirement + that deploy
      is a separate manual `/deploy-functions` step, and that this **refines specs
      0050/0053** (adds a client uncheck revert + a sync source-of-truth revert)
      while leaving `revertIfNewEpisodes` intact as defense-in-depth.

## Risks

- **Behavior change to the merged spec-0050 `autoUpdateStatus` state machine.**
  This adds a branch to a shipped state machine; it must not regress the surviving
  transitions. **Mitigation:** the new branch is ordered **before** Step 1/2/3 and
  short-circuits with `return`, and the Test plan re-asserts every surviving
  0034/0050 transition. Because the new branch only fires when `status ===
'completed'` (which Step 1/2/3 never targeted on an uncheck), it is strictly
  additive for the previously-handled cases. Flag the ordering (new branch precedes
  Step 3) explicitly in the PR so a reviewer expects it.
- **Two-scope PR + Cloud Functions deploy gate.** The change touches both
  `scope:mobile` and `scope:functions`; `functions:deploy-preflight` must pass, and
  the actual deploy is a **separate manual** `/deploy-functions` step — do NOT
  deploy from the spec/implement flow (D10). Flagged so a reviewer does not expect
  the PR to ship functions.
- **Sync-side revert (D4) overlaps the spec-0050 page-init revert (D6).** These are
  **defense-in-depth, not a conflict** — the sync fixes the source of truth so
  every surface is correct; the page-init `revertIfNewEpisodes` is a now-largely-
  redundant fallback that is idempotent (it finds status already `'watching'` →
  no-op). Spelled out here so a reviewer does not flag the redundancy as a bug.
- **Optional-port design.** Entry-point-A's omission of `watchlistStatus` is
  **intentional** (a freshly-added show needs no completed→watching revert). The
  engine must **no-op safely** when the port is absent (guarded: the revert block
  is inside `if (toWrite.length > 0 && watchlistStatus)`). Covered by the
  port-absent unit test.
- **Functions status write cost.** The revert adds **one** per-show watchlist write
  **only** when new episodes were inserted **and** status is `'completed'` (a
  `getStatus` read is issued whenever `toWrite.length > 0` and the port is present).
  Bounded and cheap (personal-scale watchlists; most daily runs insert nothing for
  most shows). Noted so the added read/write is expected, not a surprise.
- **No PLAN conflict.** This uses the existing PLAN §4
  `users/{uid}/watchlist/{titleId}` `status` field and `…/episodes` subcollection,
  the spec-0047 port/adapter pattern, and the spec-0010 `AUTH_UID`/AngularFire DI
  contract. No new field, no new collection, no new dependency, no `scope:shared`
  change.
