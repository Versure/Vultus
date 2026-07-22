---
number: 0097
slug: fix-plex-sync-unmatched-shows
title: Fix Plex sync dropping unmatched shows (issue #256)
status: implementing
slices: [slice:settings]
scopes: [scope:mobile, scope:shared]
created: 2026-07-22
---

# Fix Plex sync dropping unmatched shows (issue #256)

## Context

GitHub issue [#256](https://github.com/Versure/Vultus/issues/256) ("Not all tv
shows from plex are synced"): "A sync has been running and most tv shows have
been synced, but for example the tv show Lucky has not been added to Vultus,
whilst there are episodes on plex."

The one-way Plex → Vultus sync (spec 0073, on-device, `slice:settings` only)
imports library additions + watch state from the user's PMS. It matches items to
TMDB **solely** by parsing a `tmdb://` GUID from the Plex item, and 0073 locked
"no fuzzy matching — GUID-less items are skipped/counted (legacy-agent libraries
sync little/nothing, acceptable)". In practice several failure paths **silently
drop titles**, and the user gets no signal which titles were dropped or why. This
spec closes those gaps while keeping 0073's core cursor + no-fuzzy-matching model.

### Verified root causes (code anchors)

1. **Shows with only `tvdb://` or `imdb://` GUIDs (no `tmdb://`) are silently
   skipped.** `tmdbIdFromGuids`
   (`libs/mobile/settings/src/lib/plex.client.ts:101-121`) matches only
   `/(?:tmdb|themoviedb):\/\/(\d+)/` and returns `null` for tvdb-only / imdb-only
   items; `PlexSyncService.processLibrary`
   (`libs/mobile/settings/src/lib/plex-sync.service.ts:193-196`) then does
   `skipped += 1; continue` with no record of which title or why. This is the
   leading hypothesis for "Lucky".
2. **One throwing show aborts every show after it.** `processLibrary`
   (`plex-sync.service.ts:190-281`) is a serial loop with **no per-item
   try/catch**; a single failing item (e.g. a `listEpisodes` 404 for one show)
   throws out of the whole pass into `sync()`'s single try/catch
   (`plex-sync.service.ts:135-163`), so everything later in the library is
   dropped and the cursor never advances.
3. **Pagination can stop after page 1.** `listSection`
   (`plex.client.ts:331-376`) terminates on `totalSize = num(container['totalSize'])
|| metadata.length` (`:369`); if PMS omits `totalSize`, `totalSize` collapses
   to the first page's length and paging stops after one page.
4. **Missing `addedAt` → skip-forever.** The client defaults a missing `addedAt`
   to epoch 0 (`plex.client.ts:362-363`); an unwatched item with `addedAt = 0` is
   always older than the cursor and never added (`plex-sync.service.ts:210-231`).
5. **No diagnostics.** The sync toast surfaces only `added`/`updated`
   (`settings.page.ts:155-181`); `skipped` is invisible, so a user can't tell a
   title was dropped, let alone why.

This composes with 0073/0085/0086/0090 (all done); it does **not** re-litigate
0073's on-device / one-way / cursor / Preferences-token decisions. The PR should
include **"Fixes #256"**.

### Locked decisions (user interview, 2026-07-22)

1. **TMDB `/find` fallback.** When GUID parsing yields no `tmdb://` id but the
   item carries a `tvdb://<id>` or `imdb://<id>` GUID, resolve a TMDB id via TMDB
   `GET /find/{external_id}?external_source=tvdb_id|imdb_id`. Prefer `tvdb_id` for
   shows; `imdb_id` as secondary. The `/find` result must be of the **matching
   media type** (`tv_results` for shows, `movie_results` for movies) — otherwise
   treat as unmatched. This is deterministic **ID→ID** mapping and does **not**
   violate 0073's no-fuzzy-title-matching rule; it **supersedes** 0073's
   "legacy-agent libraries sync little/nothing — acceptable" stance for items
   that carry a resolvable external id. Runs on-device via the slice's existing
   TMDB client pattern (`createTmdbDetailClient` / `fetchDetailSafe`), no
   cross-slice import. Resolution failures → the item is counted **unmatched**
   with a reason and the pass continues.
2. **Per-item error isolation.** Each item's processing is wrapped in try/catch;
   a single failing item no longer aborts the rest of the pass — it is recorded
   (reason `error`) and the loop continues.
3. **Pagination `totalSize` fix.** When `totalSize` is absent and a full page was
   returned, keep paging until a short/empty page.
4. **Cursor semantics kept; epoch-0 edge fixed.** Old unwatched shows stay
   excluded (the sync tracks what you watch; it does not import the whole
   library). But a **missing** `addedAt` must not mean `addedAt = 0`/skip-forever
   — a missing `addedAt` is treated as **"new"** for the cursor comparison (see
   §5 justification).
5. **Diagnostics.** (a) The sync toast includes an "couldn't be matched" count
   (exact strings pinned in §6/§8). (b) The unmatched titles (Plex title +
   reason) from the most recent completed pass are persisted under the user's
   existing `plexSync` state so Settings can render a "Couldn't match N titles"
   list; capped at 50, **replaced** each pass (not appended); an empty list
   clears the UI.

## Scope

In scope:

- **Extended GUID extraction** in the real client: parse `tvdb://` and `imdb://`
  ids alongside `tmdb://`, surfaced on `PlexLibraryItem`.
- **TMDB `/find` external-id fallback** in the settings slice's TMDB client +
  `PlexSyncService`, for items with no `tmdb://` id but a `tvdb://`/`imdb://` id.
- **Per-item error isolation** in `processLibrary`.
- **Pagination continuation** when PMS omits `totalSize`.
- **Missing-`addedAt` handling** (treated as new, not epoch-0/skip-forever).
- **Unmatched-titles diagnostics**: a new `PlexUnmatchedTitle[]` on
  `PlexSyncMeta` (persisted under `users/{uid}.plexSync`), the pass-summary
  `unmatched` count, the toast count, and a Settings "Couldn't match N titles"
  list (hidden when empty).
- READMEs for every touched lib; unit + component tests.

Out of scope (explicitly):

- **Fuzzy / title-based matching** (still forbidden — 0073). The `/find` fallback
  is deterministic external-id→TMDB-id mapping only.
- **Any `scope:functions` change**, new collection, backend polling, or
  Vultus → Plex writes.
- **New Stitch screens / redesign** — the unmatched list is a minor addition to
  the existing Settings Plex card using existing tokens (§6).
- **New e2e flows** (§8 rubric: backend-shaped, native-only sync path; no new
  route/action).
- **Re-litigating 0073's link flow, cursor model, Preferences-token storage, or
  sticky-`dropped` invariant** — all unchanged.

## Affected slices & Sheriff tags

Tagging is by path glob in `sheriff.config.ts` (specs 0010/0012/0051); **this spec
does not edit `sheriff.config.ts`** — every touched project already carries its
tag. No cross-slice import is added (the settings slice keeps talking to shared
via tokens + `firestore-schema` converters, exactly as 0073).

| Project                        | Path                           | Sheriff tags                     | Change                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared-domain (edit)           | `libs/shared/domain`           | `scope:shared`                   | add `PlexUnmatchedTitle` + optional `unmatched?` on `PlexSyncMeta` (`documents.ts`); on `PlexLibraryItem` (`plex.ts`) add optional `tvdbId?`/`imdbId?` and widen `addedAt` to `string \| null`; barrel (auto via `export *`); type-assertions; README                                                                                                                                 |
| shared-firestore-schema (edit) | `libs/shared/firestore-schema` | `scope:shared`                   | **no converter change** (`plexSync` passes through unchanged); add a round-trip test proving `plexSync.unmatched` round-trips + a legacy `plexSync` without it round-trips; README note                                                                                                                                                                                               |
| mobile-settings (edit)         | `libs/mobile/settings`         | `scope:mobile`, `slice:settings` | extended extraction + pagination + missing-`addedAt` in `plex.client.ts`; `/find` method on `tmdb-detail.client.ts`; `/find` fallback + per-item isolation + unmatched-list build/persist + summary `unmatched` in `plex-sync.service.ts`; toast wording + unmatched-list UI + `loadState` signal in `settings.page.{ts,html,scss}`; mock client + mock providers seed; specs; README |

**F2 shared-type ripple (must run `nx affected -t test --base=main`).** The
`PlexSyncMeta` change is a **nested optional** field, and `userToData` already
passes `plexSync` through unchanged (`converters.ts:52-53`), so **no new
top-level `userToData` key is emitted** — the classic `?? null` ripple does not
apply here. But `PlexLibraryItem` and `PlexSyncMeta` are shared types with
constructors/assertions across slices, so after the T1 domain edit run
`nx affected -t test` to catch any full-object assertion or literal that needs
updating. Enumerated consumers (grep of `plexSync` / `PlexLibraryItem` /
`userToData` / `satisfies User`):

- `libs/shared/domain` — `documents.ts`, `plex.ts`, `type-assertions.ts`
  (`_userWithPlexSync` literal — optional field, no change required).
- `libs/shared/firestore-schema` — `converters.ts` (unchanged), `data-types.ts`
  (imports `PlexSyncMeta` transitively), `firestore-schema.spec.ts` (add
  round-trip; existing `plexSync` round-trip literals still valid — optional
  field omitted).
- `libs/mobile/settings` — `plex.client.ts`, `plex.client.mock.ts`,
  `plex-sync.service.ts`, `plex-link.service.ts`, `settings.page.ts`, and their
  specs; `plex-sync.service.spec.ts` literals that construct `PlexLibraryItem`
  keep compiling (`addedAt` widened, `tvdbId?`/`imdbId?` optional), but the
  **"GUID-less item is skipped" assertion (`plex-sync.service.spec.ts:337-345`)
  moves from `summary.skipped` to `summary.unmatched`** — update it (T3).
- `libs/mobile/onboarding` — `onboarding.service.ts`, `onboarding-plex-link.service.ts`
  and specs reference `plexSync` / `userToData`; the optional-field add is
  backward compatible, but they are in `nx affected`'s cone — the required test
  run covers them.

`PlexLibraryItem` is a **slice-facing entity, not a persisted document**, so its
change has no `firestore-schema` converter or `firestore.rules` impact.

## Data model touchpoints

PLAN §4. **No new collection.** The only persisted-surface change is a nested
field on the **existing** `users/{uid}.plexSync` object (spec 0073); all
watchlist/episode writes are unchanged from 0073/0086.

| PLAN §4 path                                      | Access               | By                                                                                         |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `users/{uid}.plexSync.unmatched`                  | read, update         | sync engine (write `plexSync.unmatched` on each completed pass); link `loadState` reads it |
| `users/{uid}.plexSync.lastSyncAt`                 | update               | sync engine (unchanged — still advanced on pass completion, see below)                     |
| `users/{uid}/watchlist/{titleId}`                 | read, create, update | sync engine (unchanged from 0073/0086)                                                     |
| `users/{uid}/watchlist/{titleId}/episodes/{epId}` | read, update         | sync engine (unchanged — mirror only, never creates)                                       |

### `plexSync.unmatched` (additive, OPTIONAL/nullable)

- Shape (pin), in `documents.ts` next to `PlexSyncMeta`:

  ```ts
  /** One title the most recent completed Plex sync pass could NOT match to a
   *  TMDB id (or that errored). Diagnostic output for the Settings "couldn't
   *  match" list (spec 0097). NOT a user preference. */
  export interface PlexUnmatchedTitle {
    /** The Plex library item's title (display only). */
    title: string;
    /** Why it wasn't matched:
     *  - 'no-guid': no tmdb/tvdb/imdb GUID at all → nothing to resolve;
     *  - 'guid-unresolved': had a tvdb/imdb GUID but TMDB /find returned no
     *    matching-media-type result;
     *  - 'error': processing the item threw (network / HTTP / timeout). */
    reason: 'no-guid' | 'guid-unresolved' | 'error';
  }
  ```

  On `PlexSyncMeta`: add `unmatched?: PlexUnmatchedTitle[]` — **optional** (legacy
  `plexSync` docs and pre-0097 links lack it; absent/`undefined` = no diagnostics
  yet). Cap **50** entries per pass; **replaced** wholesale each completed pass
  (never appended). An empty array (`[]`) is written when a pass matches
  everything, which clears the UI.

- **Converter:** no change. `userToData`/`dataToUser` pass the whole `plexSync`
  object through (`converters.ts:52-53, :72`); the nested `unmatched` array of
  plain strings/enums round-trips like `serverName`/`lastSyncAt` (no Timestamp
  mapping). A legacy `plexSync` without `unmatched` round-trips to itself.

- **Write:** on pass completion the engine writes **both** nested field paths in
  one `updateDoc`, leaving `linkedAt`/`serverName` intact:

  ```ts
  await updateDoc(doc(this.firestore, userPath(uid)), {
    'plexSync.lastSyncAt': new Date().toISOString(),
    'plexSync.unmatched': unmatched, // capped, replace-per-pass; [] clears
  });
  ```

### Cursor advancement (decision)

**The additions cursor (`plexSync.lastSyncAt`) advances whenever the library pass
runs to completion (the full list was iterated), regardless of per-item errors.**
Today it advances only on full success because any thrown item aborts the pass
before the `updateDoc` (`plex-sync.service.ts:149-152`); with per-item isolation
(§below) the loop now completes even with item errors, so the cursor advances.
Justification (pick-one, per the interview): (a) it minimally changes existing
behavior (advance on completion); (b) `no-guid`/`guid-unresolved` items are
**deterministic** — re-scanning never resolves them, so gating the cursor on them
would re-scan the entire library every pass forever; (c) transient `error` items
are surfaced in the persisted `unmatched` list, and the **watched-mirror +
watch-implies-add passes are NOT cursor-gated** (a _watched_ title is reconsidered
every pass), so a watched show that transiently errored is retried next pass
regardless of cursor. Residual risk (a genuinely-new _unwatched_ addition that
errors during resolution/write is not re-added on a later pass because its
`addedAt` is now behind the cursor) is called out in **Risks**; it is a narrow
window, is surfaced to the user, and the item can be added manually or is picked
up by the non-cursor-gated mirror if later watched.

### Missing-`addedAt` handling (decision)

A **missing** Plex `addedAt` is treated as **"new"** for the cursor comparison
(admitted as a `planned` addition), not epoch-0/skip-forever. The client returns
`addedAt: null` (widened type) when Plex reports no `addedAt` instead of coalescing
to `new Date(0).toISOString()`; `processLibrary`'s new-addition check treats
`addedAt === null` as passing the cursor. Justification: a missing timestamp is a
data gap, not evidence the item is old — erring toward inclusion matches the
bug's intent (do not silently drop). A watched item with missing `addedAt` is
already covered by watch-implies-add (not cursor-gated).

### Rules & indexes — explicitly none

- **`firestore.rules`: no change (verified).** The current owner rule
  (`match /users/{userId} { allow read, write: if isOwner(userId); … }`) already
  covers any field on the user doc — the `plexSync.unmatched` nested field is not
  a new collection and is not shape-validated by the rules (rules are
  ownership-keyed by `userId`, PLAN §4, spec 0004/0011). No new query is
  introduced (all reads/writes are by document id via `userPath`), so
  **`firestore.indexes.json`: no change**. State both explicitly in the PR. (No
  rules-test task is needed — no rule changes and no new shape validation exists
  to assert against.)

## Public types / APIs

### Shared domain (additive)

`libs/shared/domain/src/lib/documents.ts`:

- add `PlexUnmatchedTitle` (shape above);
- add `unmatched?: PlexUnmatchedTitle[]` to `PlexSyncMeta`.

`libs/shared/domain/src/lib/plex.ts` — `PlexLibraryItem`:

```ts
export interface PlexLibraryItem {
  type: 'movie' | 'tv';
  tmdbId: number | null; // tmdb:// GUID; null → try tvdb/imdb via /find
  tvdbId?: number | null; // tvdb:// GUID id (spec 0097); optional/nullable
  imdbId?: string | null; // imdb:// GUID id, e.g. 'tt0111161' (spec 0097)
  title: string;
  addedAt: string | null; // ISO 8601; null when Plex reports none (spec 0097)
  viewCount: number;
  lastViewedAt: string | null;
  ratingKey: string;
}
```

`tvdbId`/`imdbId` are **optional** (avoids breaking every existing
`PlexLibraryItem` literal); `addedAt` widened to `string | null` (backward
compatible — a string is still assignable). Both real and mock clients populate
`tvdbId`/`imdbId`.

Barrels: `PlexUnmatchedTitle` is auto-exported (`documents.ts` via
`export * from './lib/documents'`); the `PlexLibraryItem` edit needs no barrel
change. `type-assertions.ts`: no change required (`unmatched` optional; the
`_userWithPlexSync` literal still `satisfies User`).

### firestore-schema (additive, no converter change)

- `data-types.ts`: `UserReadData`/`UserWriteData` already carry
  `plexSync?: PlexSyncMeta | null` (spec 0073) — the nested `unmatched` field
  rides along transitively; no edit needed beyond the transitive `PlexSyncMeta`
  import already present.
- `converters.ts`: **unchanged** (pass-through, verified `:52-53, :72`).
- Tests only (§8) + README note.

### Settings slice (`libs/mobile/settings`)

**`plex.client.ts`:**

- Replace `tmdbIdFromGuids` with `externalIdsFromGuids(item)` returning
  `{ tmdbId: number | null; tvdbId: number | null; imdbId: string | null }`.
  Regexes on the same GUID candidate list: `tmdb`/`themoviedb`
  (unchanged), `/tvdb:\/\/(\d+)/`, `/imdb:\/\/(tt\d+)/`. `listSection`
  (`:356-368`) maps all three onto `PlexLibraryItem` and sets
  `addedAt: epochSecondsToIso(item['addedAt'])` **without** the `?? new Date(0)…`
  fallback (missing → `null`).
- `listSection` pagination (`:369-373`): when `container['totalSize']` is absent,
  keep paging until `metadata.length === 0` **or** a page shorter than `pageSize`
  is returned; do not let `totalSize` collapse to the first page length. Pin:
  `const totalSize = container['totalSize'] !== undefined ? num(container['totalSize']) : Number.POSITIVE_INFINITY;`
  then `if (metadata.length === 0 || metadata.length < pageSize || start >= totalSize) break;`.

**`tmdb-detail.client.ts`:** extend `TmdbDetailClient` with:

```ts
/** Resolve a TMDB id from an external id via GET /find/{externalId}
 *  ?external_source=tvdb_id|imdb_id. Returns the FIRST result of the matching
 *  media type (tv_results for 'tv', movie_results for 'movie'), or null when the
 *  matching-type results array is empty. Throws TmdbDetailError on non-2xx and
 *  rethrows transport/abort errors (so the caller can distinguish
 *  'guid-unresolved' from 'error'). */
findByExternalId(
  externalId: string,
  source: 'tvdb_id' | 'imdb_id',
  type: TitleType,
  signal?: AbortSignal,
): Promise<number | null>;
```

Build URL `/find/${externalId}?external_source=${source}&language=en-US` (+ the
same bearer/api_key auth the existing client uses). The auth token still travels
only in the header / `api_key` query param — never logged.

**`plex-sync.service.ts` (`PlexSyncService`):**

- New resolution step at the top of the per-item loop, replacing the
  `item.tmdbId === null → skipped` branch (`:193-196`):
  1. `item.tmdbId !== null` → use it (existing path).
  2. else `type === 'tv'` and `tvdbId != null` → `findByExternalId(tvdb, 'tvdb_id', 'tv')`.
  3. else `imdbId != null` → `findByExternalId(imdb, 'imdb_id', type)`.
  4. If still unresolved → push to the unmatched list with reason `no-guid` (no
     external ids at all) or `guid-unresolved` (had ids but `/find` returned no
     matching-type result), `unmatched += 1`, `continue`. **`guid-unresolved`
     also covers the case where the item's only external id is not applicable to
     its media type** — e.g. a movie carrying only a `tvdb://` id, which step 2
     never sends to `/find` (tvdb is show-only); classify that deliberately as
     `guid-unresolved`, not `no-guid`.
     A wrapper `findExternalIdSafe(...)` mirrors `fetchDetailSafe`: a thrown
     `/find` call is caught and counted as reason `error` (not `guid-unresolved`).
- **Per-item isolation:** wrap the whole per-item body in `try/catch`; on catch
  push `{ title: item.title, reason: 'error' }`, `unmatched += 1`, `continue`
  (log a redacted diagnostic via `describeTmdbError`/`describePlexError`, never
  the raw error — spec 0068 / CLAUDE.md).
- **Summary:** extend `PlexSyncSummary` to `{ added; updated; skipped; unmatched }`
  where `unmatched` = number of titles pushed to the unmatched list this pass;
  `skipped` keeps its 0073/0086 meaning (old-cursor unwatched + sticky-dropped).
- **Missing-`addedAt`:** the new-addition check becomes
  `const isNewAddition = item.addedAt === null ? true : new Date(item.addedAt).getTime() > cursor;`
  (`:210-211`).
- **Persist:** after `processLibrary`, write `plexSync.lastSyncAt` **and**
  `plexSync.unmatched` (capped 50) in the single `updateDoc` (see §4). Build the
  capped list as `unmatched.slice(0, 50)`.
- `sync()` still returns the discriminated `PlexSyncResult`; `running` signal
  unchanged.

**`settings.page.ts` / `.html` / `.scss`:**

- `presentSyncToast` (`settings.page.ts:155-181`): include the unmatched count.
  **Pinned exact strings** (F3 — component tests assert exact, no
  whitespace-normalization):
  - `added + updated > 0` and `unmatched === 0`:
    `Plex sync complete — {added} added, {updated} updated`
  - `added + updated > 0` and `unmatched > 0`:
    `Plex sync complete — {added} added, {updated} updated, {unmatched} couldn't be matched`
  - `added + updated === 0` and `unmatched > 0`:
    `Plex sync complete — {unmatched} couldn't be matched`
  - `added + updated === 0` and `unmatched === 0`:
    `Plex sync complete — already up to date`
    (`error`/`no-server`/`not-linked`/`busy` copy unchanged.)
- `PlexLinkService.loadState` (`plex-link.service.ts:139-158`): read
  `meta?.unmatched ?? []` into a new `_unmatched` signal (readonly
  `unmatched: Signal<PlexUnmatchedTitle[]>`); cleared on unlink (`:207-229`).
  The **half-linked self-heal branch** (`plex-link.service.ts:149-155`) must
  ALSO reset `_unmatched` to `[]` (alongside the `_serverName`/`_lastSyncAt`
  resets), so a self-healed device does not render a stale diagnostic list.
- The Settings Plex connected block gains an unmatched list (see §6).

## UI / Stitch screen refs

**No dedicated Stitch screen exists** for the unmatched list, and this spec adds
no new screen or route — so no Stitch fetch is required (recording this
explicitly, per the UI-fidelity rule, rather than shipping a prose-only section
that pretends a screen was captured). The list is a minor addition to the
existing Settings Plex **connected** block (screen `0e2bb1f198f04186b39e4a2604413417`,
already implemented by 0073). It must reuse the existing settings-card / list
styling and **only** `--vultus-*` / `--ion-*` vars wired in
`libs/shared/ui-kit/theme.scss` (authoritative tokens in
`docs/design/vultus-design-system.md`) — **no new hex, no new visual language**.

### Unmatched list — checkable contract

Rendered inside the connected block (`plex-connected`), **after** the
background-sync controls and **before** the `plex-connected__footer` Disconnect
row. `@if (plexLink.unmatched().length > 0)` — hidden entirely when empty.

| Element      | Spec                                                                                                                                                                                                                                                                                            | Token / var                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Section      | a `plex-unmatched` block with `padding-top: 8px` (reuses the 8px grid); no new card — sits within the connected block.                                                                                                                                                                          | —                             |
| Heading      | **exact:** `Couldn't match {n} titles` (`n === 1` → `Couldn't match 1 title`). **Inherit the existing `settings-row__helper` class** for its type + colour treatment (do NOT specify a new opacity value) — it already renders the muted helper style used by the sibling background-sync rows. | `--vultus-on-surface-variant` |
| List         | a plain `<ul>` of rows (reuse `settings-row`-style layout; **not** an `ion-segment`/`ion-list` component — a lightweight list to match the card's other helper text).                                                                                                                           | —                             |
| Row — title  | the Plex `title` — `body-md` (14px), `--vultus-on-surface`, single line, `text-overflow: ellipsis`.                                                                                                                                                                                             | `--vultus-on-surface`         |
| Row — reason | a trailing `label-sm` (11px) reason label, `--vultus-on-surface-variant`. **Exact strings:** `no-guid` → `Not identified`; `guid-unresolved` → `No TMDB match`; `error` → `Sync error`.                                                                                                         | `--vultus-on-surface-variant` |

**Interactive states:** the list is **static/non-interactive** (read-only
diagnostics) — no hover/focus/active/press affordance, no navigation, no tap
targets. It appears/disappears reactively on the `plexLink.unmatched()` signal
(so a fresh `Sync now` that clears all unmatched hides it). Insets align with the
sibling `plex-connected__background` rows (same left inset as the toggle/select
rows) so the block reads as one column.

**Font wiring:** no new icons are introduced; Inter (spec 0010) already loaded —
no Material Symbols glyph needed for this list.

**Visual verification (CLAUDE.md, required for DoD):** `mobile:serve-mock` seeds a
linked state; extend the mock providers seed so `plexSync.unmatched` carries a
sample entry (the mock library's GUID-less "Home Movie 2019" produces a
`no-guid` entry after a mock sync, but the seed should also carry one directly so
the list renders without running a sync). Screenshot-compare the connected block
against `0e2bb1f1…`; the unmatched list is a documented addition (no
authoritative screen for it) — flag it as **"unverified visual, needs human
eyeball"** if serve-mock cannot be run in-session (the emulator/native path is
not runnable in-session — project memory).

## Implementation task graph

T1 (domain) is the shared-root edit every consumer compiles against — sequential,
first. T2 (schema tests) depends on T1's `PlexSyncMeta` change. T3 (settings
slice) depends on both. There is **no app-shell change** (the `PLEX_CLIENT`
factory, route, and boot/resume trigger from 0073/0085 are untouched) and **no
backend path**.

**T1 — Shared domain: `PlexUnmatchedTitle` + `PlexSyncMeta.unmatched?` + `PlexLibraryItem` external ids / nullable `addedAt` [sequential]** (feature-implementer / domain)

- `documents.ts`: add `PlexUnmatchedTitle`; add `unmatched?: PlexUnmatchedTitle[]`
  to `PlexSyncMeta`.
- `plex.ts`: add `tvdbId?`/`imdbId?` to `PlexLibraryItem`; widen `addedAt` to
  `string | null`.
- `type-assertions.ts`: no change required (verify `_userWithPlexSync` still
  compiles).
- Update `libs/shared/domain/README.md` (new type + fields).
- Files: `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/plex.ts`, `libs/shared/domain/README.md`.
- **After this task, run `nx affected -t test --base=main`** (F2 ripple gate).

**T2 — firestore-schema: round-trip test for `plexSync.unmatched` [sequential, after T1]** (feature-implementer)

- `firestore-schema.spec.ts`: a `User` whose `plexSync.unmatched` carries entries
  round-trips unchanged; a legacy `plexSync` **without** `unmatched` round-trips
  to itself (no coalesce added). No `converters.ts` / `data-types.ts` edit.
- README note that `plexSync.unmatched` passes through with no Timestamp mapping.
- Files: `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md`.

**T3 — Settings slice: extraction + `/find` fallback + isolation + pagination + missing-`addedAt` + diagnostics + UI + tests [sequential, after T1/T2]** (frontend-engineer)

- `plex.client.ts`: `externalIdsFromGuids` (tmdb/tvdb/imdb); map `tvdbId`/`imdbId`
  - nullable `addedAt` in `listSection`; pagination continuation without
    `totalSize`.
- `tmdb-detail.client.ts`: add `findByExternalId(externalId, source, type)`.
- `plex-sync.service.ts`: `/find` fallback resolution (+ `findExternalIdSafe`),
  per-item try/catch isolation, `unmatched` list build (capped 50, reasons),
  extended `PlexSyncSummary` with `unmatched`, missing-`addedAt` new check,
  persist `plexSync.unmatched` alongside `lastSyncAt`.
- `settings.page.ts`: toast wording (pinned exact strings); consume
  `plexLink.unmatched()`.
- `plex-link.service.ts`: `_unmatched` signal from `loadState`; cleared on
  `unlink`.
- `settings.page.html` / `.scss`: the unmatched list per §6 (tokens only).
- `plex.client.mock.ts`: set `tvdbId`/`imdbId` on fixture items (keep "Home Movie
  2019" fully GUID-less → `no-guid`); optionally add a tvdb-only fixture show
  that resolves via `/find` to exercise the fallback.
- `settings.providers.mock.ts`: seed `plexSync.unmatched` with a sample entry so
  serve-mock renders the list.
- Specs: extend `plex.client.spec.ts` (extraction, pagination, missing-addedAt →
  null), `tmdb-detail.client.spec.ts` (`/find` success / matching-type / empty /
  error), `plex-sync.service.spec.ts` (all paths incl. moving the
  **"GUID-less item"** assertion from `summary.skipped` to `summary.unmatched`),
  `settings.page.spec.ts` (toast exact strings + unmatched list rendering + hidden
  when empty), `plex-link.service.spec.ts` (`unmatched` signal load/clear).
- Update `libs/mobile/settings/README.md`.
- Files (manifest): `libs/mobile/settings/src/lib/plex.client.ts`,
  `plex.client.mock.ts`, `plex.client.spec.ts`, `tmdb-detail.client.ts`,
  `tmdb-detail.client.spec.ts`, `plex-sync.service.ts`,
  `plex-sync.service.spec.ts`, `plex-link.service.ts`,
  `plex-link.service.spec.ts`, `settings.page.ts`, `settings.page.html`,
  `settings.page.scss`, `settings.page.spec.ts`, `settings.providers.mock.ts`,
  `libs/mobile/settings/README.md`.

**Disjointness:** T1/T2 are sequential shared-root edits (T1 = domain, T2 = schema).
T3 writes only `libs/mobile/settings/**`. No app-shell or e2e file is written. No
two tasks write the same file.

## Test plan

Per the PLAN §5 pyramid. All Firebase + Plex + TMDB access is mocked; no emulator
(project memory — the emulator cannot run under Claude Code tools; the e2e gate
runs in CI). **Rendered-text assertions use the EXACT string** — no
whitespace-normalization — and component/e2e assertions stay consistent on the
same copy.

**Unit — shared/firestore-schema (`firestore-schema.spec.ts`):**

- a `plexSync` with `unmatched: [{title, reason}, …]` round-trips unchanged;
- a legacy `plexSync` omitting `unmatched` round-trips to itself.

**Unit — settings (`plex.client.spec.ts`, mocked CapacitorHttp):**

- `externalIdsFromGuids` extracts `tvdb://` and `imdb://` (incl. from `Guid[]` and
  the legacy top-level `guid`) in addition to `tmdb://`;
- missing `addedAt` → `addedAt: null` (not epoch-0 ISO);
- **pagination continuation:** a section returning a full page with `totalSize`
  **absent** keeps paging until a short/empty page (asserts all pages' items are
  returned, not just page 1).

**Unit — settings (`tmdb-detail.client.spec.ts`, injected `fetchImpl`):**

- `findByExternalId(tvdb, 'tvdb_id', 'tv')` returns `tv_results[0].id`;
- `findByExternalId(imdb, 'imdb_id', 'movie')` returns `movie_results[0].id`;
- **media-type mismatch:** a tvdb id whose `/find` yields only `movie_results` for
  a `'tv'` request → returns `null` (→ `guid-unresolved`);
- empty results → `null`; non-2xx / transport error → throws (→ `error`).

**Unit — settings (`plex-sync.service.spec.ts`, mocked `PlexClient` + Firestore + TMDB):**

- **`/find` fallback success:** a tvdb-only show resolves via `/find` and is
  added/updated exactly as a `tmdb://` item would be;
- **`no-guid`:** an item with no tmdb/tvdb/imdb id → recorded reason `no-guid`,
  `summary.unmatched` incremented, `summary.skipped` NOT (moves the existing
  `:337-345` assertion), no write;
- **`guid-unresolved`:** an item whose `/find` returns no matching-type result →
  reason `guid-unresolved`, counted, no write;
- **per-item isolation:** one item whose processing throws (e.g. `listEpisodes`
  rejects) → recorded reason `error`, and **later items are still processed**
  (assert a subsequent item's write happened); counts correct;
- **cursor advances on completion with item errors** (`plexSync.lastSyncAt`
  updated even when `unmatched > 0`);
- **missing-`addedAt` unwatched item → added `planned`** (not skip-forever);
- **unmatched-list persistence:** the pass writes `plexSync.unmatched` (capped at
  50 — a >50 pass truncates; replace-per-pass — a pass with no unmatched writes
  `[]`), with correct reasons.

**Component — settings (`settings.page.spec.ts`):**

- toast **exact strings** for each of the four `ok` branches (esp. the two
  `unmatched > 0` forms) — no whitespace-normalization;
- unmatched list renders heading `Couldn't match 2 titles` + rows with exact
  reason labels for a 2-entry fixture; **singular** heading `Couldn't match 1 title`
  for a 1-entry fixture; **hidden** (element absent) when `unmatched()` is empty.

**Component — settings (`plex-link.service.spec.ts`):**

- `loadState` populates `unmatched()` from `plexSync.unmatched`; `unlink()` clears
  it to `[]`.

**e2e — none (rubric outcome).** No new e2e flows are required: the real Plex
sync path is native-only (CapacitorHttp; web/e2e builds get
`plex.client.mock.ts`) and this spec adds **no new page/route/primary action** —
the Settings unmatched-list rendering and the toast are covered by component
tests. The existing `apps/mobile-e2e/src/plex-sync.spec.ts` asserts only card text
(connect row, server name, "Connected") — **not** the toast — so it is not broken
by the toast-wording change and needs no edit. Stated explicitly so the omission
is intentional.

## Definition of done

- [ ] `PlexUnmatchedTitle` + `PlexSyncMeta.unmatched?` added; `PlexLibraryItem`
      gains `tvdbId?`/`imdbId?` and `addedAt: string | null` (T1).
- [ ] `firestore-schema` round-trip tests for `plexSync.unmatched` (present /
      absent) pass; **no converter change** (T2).
- [ ] `nx affected -t test --base=main` run after the domain edit is green (F2).
- [ ] Extended GUID extraction (tvdb/imdb), `/find` external-id fallback with
      media-type check, per-item error isolation, pagination continuation, and
      missing-`addedAt`-as-new all implemented in the settings slice (T3).
- [ ] Sync toast includes the "couldn't be matched" count with the pinned exact
      strings; Settings connected block renders the unmatched list (tokens only)
      and hides it when empty (T3).
- [ ] `plexSync.unmatched` persisted (capped 50, replace-per-pass) and read by
      `loadState`; cleared on unlink AND on the `loadState` half-linked
      self-heal branch (T3).
- [ ] Unit + component tests per §8 pass, incl. exact-string toast/list
      assertions; no e2e added (rubric).
- [ ] `firestore.rules` / `firestore.indexes.json`: **explicitly none** — stated
      in the PR.
- [ ] READMEs updated for `shared/domain`, `shared/firestore-schema`,
      `mobile/settings`.
- [ ] Visual check of the unmatched list via `mobile:serve-mock`, or explicitly
      flagged "unverified visual, needs human eyeball" (native/emulator path not
      runnable in-session).
- [ ] typecheck + lint/Sheriff + unit + component + build green; PR body includes
      **"Fixes #256"**.

## Risks

- **Cursor-advance residual loss.** A genuinely-new _unwatched_ addition that
  errors during `/find`/write is not re-added on a later pass (its `addedAt` is
  behind the advanced cursor). Mitigated: it is surfaced in the persisted
  `unmatched` list, can be added manually, and is picked up by the non-cursor-gated
  watched-mirror if later watched. Accepted per the §4 cursor decision.
- **TMDB `/find` accuracy.** `/find` maps an external id to a single TMDB
  candidate per media type; a stale/incorrect Plex-side external id (a known TMDB
  data caveat) can resolve to the wrong TMDB id. This is still deterministic
  ID→ID mapping (not fuzzy title matching), but a bad source id yields a wrong
  match rather than a `no-guid` skip — an accepted tradeoff vs. dropping the
  title. tvdb-preferred-for-shows keeps this narrow.
- **Rate limiting.** The `/find` fallback adds one TMDB call per otherwise-
  unmatched item; a large legacy library could add many calls in one pass. Bounded
  by the library size and the per-item isolation (a rate-limit 429 is caught as
  `error`, not a pass abort). No new backoff is added (out of scope) — noted for a
  future spec if it becomes a problem.
- **"Lucky" root cause is a hypothesis.** The leading cause is tvdb/imdb-only
  GUIDs (fixed by `/find`); if the specific PMS item carries **no** external id at
  all, it will now correctly appear in the "couldn't match" list as `no-guid`
  rather than vanishing — which is the intended, verifiable outcome even if it
  cannot be auto-matched.
- **F4 onboarding parity — deliberately Settings-only.** `plexSync.unmatched` is
  **diagnostic sync output, not a user preference**: it cannot exist before a Plex
  server is linked (which happens post-onboarding), so it is correctly excluded
  from first-launch onboarding. No follow-up onboarding spec is warranted.
- **Untrusted data (spec 0068).** plex.tv / PMS / TMDB responses (incl. `/find`
  results and library GUIDs) are parsed as data only — no command, path, or
  secret is derived from them; error diagnostics stay redacted
  (`describePlexError`/`describeTmdbError`), never echoing tokens or raw bodies.
