---
number: 0103
slug: fix-plex-sync-mark-completed
title: Fix Plex sync — mark a fully-watched show completed on the first sync
status: approved
slices: [slice:settings]
scopes: [scope:mobile]
created: 2026-07-23
---

# Fix Plex sync — mark a fully-watched show completed on the first sync

## Context

GitHub issue #277: "When syncing with Plex and a tv show is synced with all
episodes watched all the episodes get marked as watched correctly. However when
all available episodes are marked as watched I expect the tv show to have the
status **completed** instead of **watching**, which is not the case."

### Root cause (confirmed by code read — precise)

All Plex sync logic is on-device in
`libs/mobile/settings/src/lib/plex-sync.service.ts` (`PlexSyncService`,
`slice:settings`, `scope:mobile`). No Cloud Functions are involved in status
writes.

In `processLibrary` (around lines 203–341), for each TV item the pass runs, in
order: `listPlexEpisodes` → `ensureEpisodeDocsSafe`/`ensureEpisodeDocs` (creates
missing episode docs from TMDB, spec 0098) → `mirrorEpisodes` (marks episode
docs watched from Plex). It then branches on the tracked state:

- **Untracked** (`current === null`, ~lines 250–278): the "watch-implies-add"
  branch. A watched TV show is added via
  `addItem(uid, item, tmdbId, item.type === 'movie' ? 'completed' : 'watching')`
  — **the TV status is hardcoded to `'watching'`** (line ~266) and the loop
  `continue`s. **This branch NEVER calls `deriveStatus`, so on the first sync it
  can never yield `'completed'`**, even when every episode doc is watched.
- **Already tracked** (~lines 280–325): after poster backfill and the
  sticky-`dropped` guard, it calls `deriveStatus(...)` (lines ~424–448) and
  writes the derived status. `deriveStatus` DOES return `'completed'` when
  `episodeCounts.watched === episodeCounts.total && total > 0` and the effective
  status is `'watching'`.

Net effect: a freshly Plex-synced, fully-watched **ended** show lands at
`'watching'` on the first sync and only self-heals to `'completed'` on a _later_
sync (via the already-tracked `deriveStatus` path) — a two-sync latency, and the
exact behavior issue #277 rejects. Cloud Functions never write `'completed'`
(they only perform the reverse `completed → watching` revert on new-episode
insertion, spec 0074), so nothing server-side fixes this.

### The completion rule is EXISTING — this spec does NOT change it

Completion semantics are the existing rule and MUST NOT change: **a TV show is
`completed` iff ALL episode docs in its subcollection are watched AND
`total > 0`** (the `watched === total && total > 0` predicate in `deriveStatus`,
line ~444, and `episodeCounts`, lines ~620–638). The user confirmed the desired
product behavior in these exact terms:

> "TV shows should be marked as completed when: all episodes that have been
> announced have been watched, so when there are episodes in the future the TV
> show status should remain Watching. When no future episodes are announced it
> can switch to completed. However when a new season is announced and new
> episodes get scheduled it should revert to Watching."

This maps **directly** onto the existing `watched === total` rule and needs no
new logic:

- Episode docs are created for **every announced episode**, including
  future-dated ones (spec 0098 creates a doc for every TMDB episode with a
  non-null `air_date`; a scheduled future episode is present but **unwatched**).
  A scheduled future episode therefore keeps `watched < total` → the show stays
  `'watching'`. That is exactly "episodes in the future → remain Watching."
- "No future episodes announced → all announced watched → completed" is the
  `watched === total` case.
- "New season announced → revert to Watching" is **already handled** by the
  existing new-episode-insertion revert (functions spec 0074 D4 inserts the new
  episode docs as unwatched, making `watched < total` again; the client revert
  in `slice:title-detail` covers the on-device path). This spec relies on that
  existing behavior and adds nothing to it.

Because the user's stated behavior is _already_ the meaning of the existing
rule, **this spec introduces NO 'aired-only' filtering, does NOT touch
`slice:title-detail`, does NOT touch Cloud Functions, and does NOT change the
notification pipeline (spec 0088)** — see "Out of scope" and "Locked decisions."

### The bug is confined to the untracked watch-implies-add branch

The already-tracked branch is **already correct** (it runs `deriveStatus`, which
reaches `'completed'`). The only defect is the untracked branch hardcoding
`'watching'` for a TV show. Fixing it also removes the two-sync latency for
ended shows.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Fix location: the untracked watch-implies-add branch, TV item only.** When
   a watched, untracked TV show is added, assign the **derived** status instead
   of hardcoding `'watching'`: `'completed'` when
   `total > 0 && watched === total`, else `'watching'`. Movies are unaffected —
   the movie branch already assigns `'completed'`; leave it.
2. **Reuse the existing completion predicate — do NOT invent a second copy of
   the rule.** Compute the initial TV status from the SAME `episodeCounts` /
   `deriveStatus` completion predicate already in this file. Implementation
   latitude on the exact shape (e.g. `addItem(..., 'watching')` then apply
   `deriveStatus(uid, item, tmdbId, 'watching', watched)` and write the result —
   noting `deriveStatus` returns `null` when the status is unchanged, which the
   caller must treat as "keep `'watching'`", not an error/skip; or compute the
   status via `episodeCounts` before `addItem`
   (`total > 0 && watched === total ? 'completed' : 'watching'`), which sidesteps
   the `null` case entirely) — but the
   BEHAVIOR is pinned and the rule must not be duplicated. Duplication is only
   _within this one slice_; the rule already lives here (vertical-slice: the
   title-detail rule is deliberately NOT imported).
3. **The completion rule is the EXISTING all-docs rule
   (`watched === total && total > 0`).** No 'aired-only' rewrite. It already
   satisfies the user's stated behavior (future episodes are present-but-
   unwatched docs → `watched < total` → stays Watching). See Context.
4. **The already-tracked branch is unchanged** (it already runs `deriveStatus`).
   The implementer must NOT touch it beyond confirming it still passes.
5. **No migration / no reconciliation pass (retroactive).** Shows already stuck
   at `'watching'` heal on the **next** Plex sync via the already-tracked
   `deriveStatus` path (which already exists and is unchanged). No backfill.
6. **No `scope:functions`, no `slice:title-detail`, no notification-pipeline
   (spec 0088) change.** The completion rule is intentionally tied to the
   all-docs count precisely because a _caught-up ongoing_ show must stay
   `'watching'` to keep notifying (spec 0088 mutes on `completed`); an
   'aired-only' rule would wrongly complete a caught-up ongoing show and silence
   its notifications. Do NOT "fix" this into aired-only.

Intended outcome: after a **single** Plex sync, a fully-watched ended show is
added with status `'completed'`; a show with any unwatched (including
scheduled/future) episode is added `'watching'`.

## Scope

In:

- In `PlexSyncService.processLibrary`, the untracked **watch-implies-add** branch
  (~lines 250–268): for a **TV** item, assign the **derived** status
  (`'completed'` when all episode docs watched and `total > 0`, else
  `'watching'`) instead of the hardcoded `'watching'`, reusing the existing
  `episodeCounts` / `deriveStatus` completion predicate. Episode docs are already
  created (`ensureEpisodeDocsSafe`) and mirrored (`mirrorEpisodes`) earlier in
  the same pass, so the counts are fresh.
- Unit tests in `plex-sync.service.spec.ts` covering the fix and guarding the
  unchanged paths (Test plan).
- A one-line note in `libs/mobile/settings/README.md` if the `PlexSyncService`
  behavior description warrants it (implementer's call — see DoD).

Out of scope:

- **No new completion rule / no 'aired-only' filtering.** The existing
  `watched === total && total > 0` predicate is reused verbatim (locked decision
  3).
- **No change to the movie path** — the movie watch-implies-add branch already
  assigns `'completed'`.
- **No change to the already-tracked branch** — it already runs `deriveStatus`
  (locked decision 4).
- **No `scope:functions` change** — no callable, trigger, or cron edit; the
  server-side `completed → watching` revert (spec 0074) is untouched.
- **No `slice:title-detail` change and no cross-slice import** — the completion
  rule is replicated within `slice:settings` already; it is NOT imported.
- **No notification-pipeline (spec 0088) change.**
- **No migration / reconciliation pass** — stuck shows heal on the next sync
  (locked decision 5).
- **No `shared/domain` / `shared/firestore-schema` change** — `WatchStatus`,
  `WatchlistItem`, `EpisodeDoc` unchanged.
- **No `firestore.rules` / `firestore.indexes.json` change** (see §4).
- **No UI / route / Stitch-screen change.**

## Affected slices & Sheriff tags

| Project         | Path                   | Sheriff tags                     | Change                                                                                    |
| --------------- | ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| mobile-settings | `libs/mobile/settings` | `scope:mobile`, `slice:settings` | `PlexSyncService.processLibrary` untracked TV status derivation; spec; README (one-liner) |

- Tagging is by path glob in `sheriff.config.ts` — the touched project already
  carries its tag; **this spec does NOT edit `sheriff.config.ts`**.
- **No cross-slice import is introduced.** The completion rule is reused from
  helpers **already in this slice** (`episodeCounts`, `deriveStatus`); the
  settings slice does NOT import `@vultus/mobile/title-detail` or any
  `scope:functions` lib.
- **No `scope:mobile` ↔ `scope:functions` edge** anywhere in the change.
- **F2 (shared-type ripple): NONE.** No change to `@vultus/shared/domain` or
  `@vultus/shared/firestore-schema`. `WatchStatus` and `WatchlistItem` are
  unchanged; the fix only changes _which existing `WatchStatus` value_ is passed
  to the unchanged `addItem`. State this in the PR.

## Data model touchpoints

PLAN §4 paths. The feature reads/writes only EXISTING collections; **no new
collection, field, converter, rule, or index.**

| PLAN §4 path                               | Access | By                                                                                 |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}/episodes` | read   | `episodeCounts` — count total/watched to derive the initial status (existing read) |
| `users/{uid}/watchlist/{titleId}`          | write  | `addItem` — writes the watchlist doc with the derived `status` (existing write)    |

- **`firestore.rules`: NO change.** No new field or collection; the existing
  `users/{userId}` owner rule already authorizes the watchlist write and the
  episodes read. State this explicitly in the PR. (No new rules-test either.)
- **`firestore.indexes.json`: NO change.** `episodeCounts` is a one-shot
  subcollection read (no `where`/`orderBy`); `addItem` writes by document id. No
  new query → no composite index. State this explicitly in the PR.

## Public types / APIs

**None changed.** No `shared/domain` / `shared/firestore-schema` change; no new
type, signature, endpoint, or callable. The private `addItem` signature is
unchanged — the fix only chooses a different existing `WatchStatus` value for the
TV case. `episodeCounts` and `deriveStatus` are existing private helpers, reused
as-is.

- **F2 (shared-type ripple): N/A** — no shared converted type gains or changes a
  field, so no repo-wide construct-site ripple and no `.toEqual` write-payload
  ripple.
- **F4 (onboarding ↔ User-field parity): N/A** — this spec adds/changes **no
  `User` domain field**. No persisted user preference is introduced or altered,
  so there is nothing to route through (or deliberately exclude from) first-launch
  onboarding. The F4 probe is satisfied by the absence of any `User`-field change.

## UI / Stitch screen refs

**Not applicable — no UI / template / styling change.** This spec is a pure
service-logic fix. The existing watchlist card (`.status-completed` /
`.status-watching`) and title-detail episode UI already render the affected
statuses; no route, page, component, Stitch screen, or
`docs/design/vultus-design-system.md` token is touched. No screen capture is
required.

## Implementation task graph

**T1 [sequential] — derive the initial TV status in the watch-implies-add
branch.** Single task; no shared dep, no parallel fan-out (one file + its spec +
a README one-liner, all in one slice).

File manifest:

- `libs/mobile/settings/src/lib/plex-sync.service.ts` (MODIFIED) — in
  `processLibrary`'s untracked `if (watched)` branch (~lines 258–268), for a
  **TV** item assign the **derived** status
  (`total > 0 && watched === total ? 'completed' : 'watching'`) computed via the
  existing `episodeCounts` / `deriveStatus` completion predicate, instead of the
  hardcoded `'watching'`. The movie case (`'completed'`) is unchanged. Do NOT
  touch the already-tracked branch, the movie path, `deriveStatus`,
  `episodeCounts`, `addItem`, `ensureEpisodeDocs*`, or `mirrorEpisodes`.
- `libs/mobile/settings/src/lib/plex-sync.service.spec.ts` (MODIFIED) — add/extend
  the unit cases in the Test plan; keep all existing 0073/0086/0098 invariants
  green.
- `libs/mobile/settings/README.md` (MODIFIED, one-liner) — under the
  `PlexSyncService` description, note that a fully-watched untracked TV show is
  now added `completed` on the first sync (not `watching`), via the existing
  completion predicate. Only if the current README describes the watch-implies-add
  status mapping; otherwise a minimal note is acceptable (implementer's call).

## Test plan

Per the PLAN §5 pyramid. All Firebase + Plex + TMDB access is mocked; no emulator
(project memory: the Firestore emulator cannot run under Claude Code tools; the
e2e gate runs in CI / the user's own terminal). Run with the **real Nx project
name**: `pnpm nx test mobile-settings` (NOT `nx test settings`). Assert on the
**exact status string** written to the watchlist doc via the `setDoc`/`addItem`
mock (no whitespace-normalization — N/A here, these are status enums, not
rendered UI text).

Extend the existing `plex-sync.service.spec.ts` (it already mocks Firestore /
`PlexClient` / `TmdbDetailClient`) — do NOT build new test infrastructure.

**Unit (settings — `plex-sync.service.spec.ts`, MODIFIED):**

1. **Regression fix (#277) — untracked, all episode docs watched (ended show, no
   future episodes) → added `'completed'` on the FIRST sync.** Set up an
   untracked TV item whose Plex episodes are all `viewCount > 0` and whose TMDB
   season/episode set (via the ensure-step mock) has all episodes watched after
   mirroring → assert `addItem`/`setDoc` writes `status: 'completed'`.
2. **Untracked, at least one UNWATCHED episode doc (e.g. a scheduled/future
   episode present, or a caught-up ongoing show) → added `'watching'`, NOT
   `'completed'`.** Assert `status: 'watching'`.
3. **Untracked, partially watched (some episodes watched, some not) →
   `'watching'`.** Assert `status: 'watching'`.
4. **Untracked, unwatched-new TV show → `'planned'` (regression, unchanged).** No
   watched episode → falls to the `isNewAddition` branch → `status: 'planned'`.
5. **Movie watched → `'completed'` (regression, unchanged).** Untracked watched
   movie → `status: 'completed'`.
6. **Already-tracked `'watching'` show, all episodes now watched → `deriveStatus`
   still flips to `'completed'` (regression, unchanged path — the
   heal-on-next-sync guarantee).** Assert the status `updateDoc` writes
   `'completed'`.
7. **Already-tracked `'dropped'` show stays dropped (sticky-`dropped`,
   unchanged).** Assert no status `updateDoc` fires; status stays `'dropped'`.
8. **All existing 0073 / 0086 / 0098 invariants keep passing** (cursor filtering,
   GUID-less skip, poster backfill, on-device episode creation + mirror, summary
   counts) — the status-derivation change must not regress them.

**Component:** none — no component with non-trivial state changes (no UI change).

**e2e (rubric): Not required to ADD a new flow — but keep existing green.** This
is a `scope:mobile` status-behavior change, which the rubric would normally gate
with e2e; however, the real Plex/TMDB → status path is **on-device-only
verifiable** — there is no PMS in the Playwright/emulator e2e (established
project Plex-sync verification limit; see memory "Plex sync gotchas"). Do NOT add
a new e2e that requires a Plex Media Server. If the existing
`apps/mobile-e2e/src/plex-sync.spec.ts` "sync outcome" flow asserts a synced
show's status, keep it green (its mock show 1396 is untracked with S1E2 unwatched
→ it should assert `'watching'`, which this change does NOT alter). Note the
existing comments near `apps/mobile-e2e/src/plex-sync.spec.ts` lines ~404/440
describe show 1396 as "watch-implies-add, not count-driven `deriveStatus`" — after
this fix that branch _becomes_ count-driven (the result for 1396 stays
`'watching'` because S1E2 is unwatched, so the assertion is unchanged). The
implementer may refresh that **comment** (not the assertion) to avoid misleading a
future reader; this is a documentation nicety, not a required change. Otherwise the
unit tests carry this fix and real proof is an on-device
(`pnpm nx run mobile:android-usb`) check, flagged for a human. Stated honestly
here and in Risks. No `test.fixme` (no dependence on an unmerged spec).

## Definition of done

- [ ] Typecheck passes (`pnpm nx run mobile-settings:typecheck` /
      `nx affected -t typecheck`) — the derived-status change compiles.
- [ ] Lint + Sheriff pass — no new import of `@vultus/mobile/title-detail` /
      `@vultus/mobile/search` / any `scope:functions` lib; no
      `scope:mobile` ↔ `scope:functions` edge; no `sheriff.config.ts` change.
- [ ] Unit tests pass (`pnpm nx test mobile-settings`) — the cases above (fix +
      regression guards); all existing 0073/0086/0098 invariants still green.
      [maps to T1: `plex-sync.service.spec.ts`]
- [ ] Component tests — none required (no UI change; justified).
- [ ] e2e — no new flow added (Plex→status is on-device-only verifiable); any
      existing `plex-sync.spec.ts` "sync outcome" flow stays green (CI /
      emulator). Stated in the PR.
- [ ] Build passes for affected projects (`nx affected -t build --base=main`),
      including `apps/mobile`. [maps to T1]
- [ ] `libs/mobile/settings/README.md` updated (one-liner) for the first-sync
      `completed` behavior. [maps to T1: README in manifest]
- [ ] **No `scope:functions` change** — server triggers/cron/`triggerSync`
      untouched; the `completed → watching` revert (spec 0074) unchanged. Stated
      in the PR.
- [ ] **No `slice:title-detail` change / no cross-slice import** — completion rule
      reused from in-slice helpers. Stated in the PR.
- [ ] **No `firestore.rules` change** — no new field/collection; existing owner
      rule covers the writes; no rules-test added. Stated in the PR. (No orphan:
      no task produces a rules change because none is needed.)
- [ ] **No `firestore.indexes.json` change** — one-shot subcollection read +
      by-id write; no new query. Stated in the PR.
- [ ] **No `shared/domain` / `shared/firestore-schema` change** — reuses
      `WatchStatus` / `WatchlistItem` / `EpisodeDoc`; no F2 shared-type ripple, no
      `.toEqual` write-payload ripple. Stated in the PR.
- [ ] **F4 (onboarding parity): N/A** — no `User` field added/changed. Stated in
      the PR.
- [ ] PR references this spec (0103).
- [ ] **POST-MERGE on-device human verification (recommended — real PMS + TMDB
      path is only verifiable on device).** Via `pnpm nx run mobile:android-usb`
      against a real Plex server: sync a show whose episodes are ALL watched in
      Plex and confirm Vultus shows it `completed` on the **first** sync; sync a
      show with a scheduled/unwatched episode and confirm it stays `watching`.

### DoD ⇄ task-manifest cross-check

Every DoD checkbox maps to **T1** (the sole task): the service edit + its spec +
the README one-liner are all in T1's file manifest. The `firestore.rules`,
`firestore.indexes.json`, `shared/domain`, `slice:title-detail`, and
`scope:functions` items are **deliberate no-change assertions** (nothing to
produce), stated so they are not mistaken for orphans. There is no orphan DoD
item.

## Risks

- **Emulator / e2e gates can't run in this environment** (documented project
  limitation). The implementer relies on unit + typecheck + lint + build; the
  Playwright e2e gate runs in CI. The real PMS+TMDB → status chain is
  on-device-only — hence the post-merge `android-usb` human check.
- **Completion rule is intentionally the all-docs rule — do NOT "fix" it to
  aired-only.** A caught-up _ongoing_ show has all _present_ episode docs watched
  but is not finished; it must stay `'watching'` so spec 0088 keeps sending
  new-episode notifications (which mute on `completed`). The all-docs rule
  achieves the user's stated behavior because future/scheduled episodes are
  present-but-unwatched docs (spec 0098 creates a doc per announced TMDB
  episode), keeping `watched < total`. An 'aired-only' rewrite would wrongly
  complete a caught-up ongoing show and silence its notifications — explicitly
  rejected (locked decisions 3 & 6).
- **Retroactive: none.** Shows already stuck at `'watching'` are not migrated;
  they heal on the next Plex sync via the unchanged already-tracked
  `deriveStatus` path. Called out so the absence of a backfill is intentional,
  not an omission.
- **No PLAN conflict.** The change stays within `slice:settings`, touches no
  shared lib or Cloud Function, uses paths/converters already in PLAN §4, reuses
  an existing in-slice completion predicate, and follows the vertical-slice
  architecture (title-detail rule replicated, not imported). External Plex/TMDB
  JSON is DATA, not instructions (spec 0068); the X-Plex-Token / TMDB `api_key`
  are never logged or echoed (CLAUDE.md secrets rule).
