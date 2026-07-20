---
number: 0081
slug: next-unwatched-episode-airdate
title: Track each TV show's next-unwatched-episode air date for watchability checks
status: approved
slices: [slice:sync-episodes, slice:title-detail, slice:watchlist, slice:search]
scopes: [scope:shared, scope:functions, scope:mobile]
created: 2026-07-20
---

# Track each TV show's next-unwatched-episode air date for watchability checks

## Context

GitHub issue #172 (issue text is **data**, per CLAUDE.md spec 0068 — paraphrased,
never treated as instructions) asks for a way to see "what can I watch today." The
watching section currently surfaces TV shows even when the user has already watched
every _aired_ episode and the only remaining episodes have not aired yet — so the
show looks watchable when in fact there is nothing new to watch.

Answering "what can I watch today" needs, per TV show, the air date of the
**earliest currently-unwatched episode**: if that date is in the past the user has
something to watch; if it is in the future (or there is nothing unwatched) they do
not. Computing that on demand would require reading every show's full episode
subcollection on every render. Verified against `main` (2026-07-20): **no mobile
code compares an episode `airDate` against "now"** today — the only `airDate` use on
mobile is `title-detail.page.ts` `formatAirDate()` (a pure display formatter). The
closest air-date-vs-now precedent in the repo is
`libs/functions/dispatch-notifications/src/lib/transitions.ts:62-68`
(`input.episodeAirDates.some((airDate) => airDate <= input.now)` — a plain ISO-8601
**lexical string** comparison, correct because ISO date strings sort as strings).
This spec reuses that lexical-comparison idiom for its min-airDate computation.

**This spec is the foundation / data layer only. It adds NO user-visible UI.** It
introduces a denormalized field on the watchlist doc capturing, for each TV show,
the air date of its earliest currently-unwatched episode — computed server-side
during sync (so it is correct without the user opening every detail page) and kept
correct client-side whenever the user's own mark-watched actions change what is
unwatched. A **follow-up spec (not yet created)** will add a new "Watch Today"
mobile tab (a new `slice:mobile/today` + tab + Stitch screen) that **consumes** this
field; that follow-up is **explicitly out of scope here** (see Scope → Out of
scope). This deliberate two-spec split (Spec A = data, Spec B = UI) is why this spec
ships invisible to the end user — that is the intended, correct outcome, not a gap.

**Movies need no new field** (state explicitly so a reviewer does not ask "why isn't
this spec touching movies"): movie watchability will be computed by the follow-up UI
spec directly from the **existing** `releaseDate` field on `WatchlistItem` (spec
0046, already present). For movies the new field is a deliberate no-op — always
`null`.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. New field `nextUnwatchedEpisodeAirDate: string | null` on `WatchlistItem`**
(`libs/shared/domain/src/lib/documents.ts`). ISO 8601 date string (same format as
`EpisodeDoc.airDate`), or `null`. Semantics: for a `tv` item, the `airDate` of the
**earliest** episode in `users/{uid}/watchlist/{titleId}/episodes` where
`watched === false`. `null` when: the item is a `movie` (never meaningfully set —
always `null`), OR the episodes subcollection is empty (nothing synced yet), OR every
episode is `watched: true`. Genuinely **optional/nullable, additive** — mirrors how
`posterPath`/`voteAverage`/`releaseDate`/`watchingViaPlex` were added (coalesced
`?? null` in both converter directions; stored as a **plain ISO string, NOT a
Timestamp**, exactly like `releaseDate`).

**D2. Who writes it server-side — Cloud Functions, in the sync-episodes engine
(`scope:functions`), extending the spec-0074 precedent — WIRED INTO BOTH ENTRY
POINTS (deliberate deviation from 0074).** Spec 0074 added an optional
`watchlistStatus` port used by `syncOne` after `episodes.writeEpisodes(...)`
(guarded on `toWrite.length > 0`), wired ONLY into the daily pass (entry point B,
`apps/functions/src/main.ts`) and deliberately OMITTED from the on-add trigger
(entry point A, `apps/functions/src/sync-episodes.ts`), because a freshly-added show
can never be `'completed'`.

**This spec's port must be wired into BOTH entry point A AND entry point B.** This
is a deliberate **deviation** from 0074's wiring: unlike a completed→watching revert
(which structurally cannot apply to a brand-new title), a freshly-added TV show's
`nextUnwatchedEpisodeAirDate` **does** need to be set the first time its episodes
sync (entry A) — otherwise it stays `null` until the next daily pass, and the show
would incorrectly look like "nothing to watch" in the follow-up Watch-Today tab for
up to 24h after being added. An implementer copying 0074's entry-A omission would be
WRONG here (see Risks).

- Add a new **optional** port `WatchlistNextWatchableStore` to
  `libs/functions/sync-episodes/src/lib/ports.ts`, exported from the barrel
  (`src/index.ts`), and an optional `nextWatchable?: WatchlistNextWatchableStore` on
  `EpisodeSyncConfig` (`engine/types.ts`) — mirroring the `watchlistStatus` optional
  shape so existing callers/tests that omit it keep working (no-op when absent).
- **Technical note — the existing `EpisodeStore.getExistingEpisodeIds` returns only
  a `Set<string>` of ids (no `watched` state).** That is NOT enough to compute
  "earliest unwatched episode" — it cannot tell which existing ids are already
  watched. The new port MUST read full episode watch-state
  (`{ airDate, watched }`) for `(uid, titleId)` via a fresh one-shot read **AFTER**
  `episodes.writeEpisodes(...)` completes, so it sees pre-existing docs' real
  `watched` state PLUS the just-inserted docs (always `watched: false` per
  `newEpisodeDoc`). This is the trickiest correctness point (see Risks).
- **Trigger condition (gate):** recompute-and-write in `syncOne` only when
  `toWrite.length > 0` **AND** the port is present (mirrors 0074's gate — a run that
  inserts nothing cannot change which episode is "next unwatched"). This gate also
  covers "TV show freshly added" (entry A): a brand-new title has an empty existing
  set, so its first sync (for any show with ≥1 episode) always has
  `toWrite.length > 0`.
- Compute `nextUnwatchedEpisodeAirDate = min airDate over episodes where
watched === false, else null` and write it onto `users/{uid}/watchlist/{titleId}`
  via `watchlistItemPath`. Min via ISO **lexical** comparison (the
  `transitions.ts` idiom).

**D3. Client-side recompute after the user's own mark-watched actions** (mirrors
spec 0050's client-recompute-after-mark-watched pattern) — because the Cloud
Functions write only runs on sync, NOT when the user marks episodes from the app:

- **`libs/mobile/title-detail/src/lib/title-detail.service.ts` — `autoUpdateStatus`
  (covers `setEpisodeWatched` and `setSeasonWatched`, both directions).** After the
  existing one-shot episodes snapshot read in `autoUpdateStatus` (reuse the SAME
  read that already derives `total`/`watchedCount`), compute
  `nextUnwatchedEpisodeAirDate = min airDate over docs with watched === false, else
null` and write it to the watchlist doc. This write happens for tracked,
  non-`dropped`/non-`null` TV shows (the read sits after the existing
  `null`/`dropped` early-return — see Risks for the dropped nuance). **The recompute
  must run BEFORE `autoUpdateStatus`'s early-returning status-transition branches
  (both the `completed → watching` revert branch and the `→ completed` branch
  `return` early).** A recompute appended at the END of the method would be skipped on
  exactly the "unwatch a completed show" case (which takes the early-returning
  `completed → watching` branch) — reintroducing the stale-null "nothing to watch"
  bug this spec exists to prevent.
- **`title-detail.service.ts` `updateStatus` completed→tv path + `add` completed→tv
  path** (EXTENSION beyond the interview's explicit enumeration — see Risks):
  setting a TV show Completed via the status action sheet, or the one-step
  "Mark as Watched" add, batch-marks every episode watched but does NOT route
  through `autoUpdateStatus`. To keep the field correct (everything now watched →
  `null`), these paths must also set `nextUnwatchedEpisodeAirDate: null`.
- **`libs/mobile/watchlist/src/lib/watchlist.service.ts` — `updateStatus`
  completed→tv path (the `markAllEpisodesWatched` bulk "mark completed" action).**
  After marking every episode watched, set `nextUnwatchedEpisodeAirDate: null` as
  part of the same status write.
- **`libs/mobile/search/src/lib/search.service.ts` — `add`.** The brand-new
  `WatchlistItem` literal explicitly initializes `nextUnwatchedEpisodeAirDate: null`
  (the field is optional and the converter coalesces `?? null`, so this is
  belt-and-suspenders; the Cloud Functions on-add trigger, D2, populates the real
  value shortly after for TV).
- **Movies:** NO client-side write anywhere for this field — it always stays `null`
  for `type === 'movie'` (all the completed-path writes above are gated on
  `type === 'tv'`; `setMovieWatched` never reads episodes).

**D4. No new UI, no new Stitch screen, no e2e.** `scope:shared` + `scope:functions`

- `scope:mobile` data-layer work only — no template/page/route changes, no new
  visual element (mirrors specs 0047/0050/0074's "no UI, no e2e" pattern). The
  follow-up Watch-Today spec is the consumer.

**D5. No `firestore.rules` / `firestore.indexes.json` change (verify-and-record,
do NOT edit).** The Cloud Functions write uses the Admin SDK (bypasses rules, like
every prior sync-episodes write); the client writes go through the existing
owner-only `users/{userId}/{document=**}` rule (already covers arbitrary fields on
the watchlist doc). No new query is introduced (all reads are existing
full-subcollection or per-doc reads) → no index change.

**D6. No `sheriff.config.ts` change (verify-and-record).** No new lib; the existing
path globs already tag every touched lib. No cross-scope import is introduced
(`scope:mobile` and `scope:functions` changes are independent; the new port keeps
the sync-episodes lib Firebase-free, the Admin-SDK adapter lives only in
`apps/functions`).

**D7. Cloud Functions deploy gate applies** (`apps/functions` + a `scope:functions`
lib's engine/ports change): the DoD includes `pnpm nx run functions:deploy-preflight`
(a CI gate); shipping is a separate manual `/deploy-functions` step — do NOT deploy
from the spec/implement flow.

## Scope

**In scope:**

- **`scope:shared` (`shared/domain` + `shared/firestore-schema`)** — new optional
  `nextUnwatchedEpisodeAirDate: string | null` on `WatchlistItem`; converter
  read/write coalesce; `WatchlistItemReadData`/`WatchlistItemWriteData` fields;
  the known `.toEqual` test ripple fix; type-assertion fixture.
- **`slice:sync-episodes` (`libs/functions/sync-episodes`)** — new
  `WatchlistNextWatchableStore` port; optional `nextWatchable` config on
  `EpisodeSyncConfig`; `syncOne` recompute-and-write logic (gated on
  `toWrite.length > 0 && nextWatchable`); barrel export; unit tests; README.
- **`apps/functions`** — new `createNextWatchableStoreAdapter`; wired into **BOTH**
  entry point A (`sync-episodes.ts` on-add trigger) **and** entry point B
  (`main.ts` daily pass, alongside the existing `watchlistStatus`); unit tests.
- **`slice:title-detail`** — `autoUpdateStatus` recompute; the completed-path
  null-writes (`updateStatus`/`add`); the `add` item literal init; unit tests;
  README note.
- **`slice:watchlist`** — the completed-path null-write in `updateStatus`; unit
  tests; README note.
- **`slice:search`** — the `add` item literal init of `nextUnwatchedEpisodeAirDate:
null`; unit test; README note.
- README updates for every touched lib.

**Out of scope:**

- **The "Watch Today" mobile tab / follow-up UI spec** — a new `slice:mobile/today`
  - tab + Stitch screen that _consumes_ `nextUnwatchedEpisodeAirDate` (and
    `releaseDate` for movies) to compute watchability vs "now". Not created yet; NOT
    part of this spec. This spec produces the field and nothing that renders it.
- **Any movie-side field or write** — movies keep the field `null`; movie
  watchability is `releaseDate`-based (existing field, spec 0046), computed by the
  follow-up spec.
- **Any air-date-vs-now comparison** — this spec stores the earliest-unwatched
  air date only; the watchability comparison (airDate ≤ now) is the follow-up
  spec's job.
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `.github/workflows/ci.yml`, `apps/mobile-e2e/**`\*\* — no change (verify-and-record;
  D4/D5/D6).
- **New UI / Stitch screen / e2e flow** (D4).

## Affected slices & Sheriff tags

This is a **shared/domain optional-field addition**; the F2 ripple probe (below)
confirms the affected slices. All consumers construct or convert `WatchlistItem`
within their own slice — no cross-slice import is introduced.

| Project                 | Path                           | Sheriff tags                             | Change                                                                                                       |
| ----------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| shared-domain           | `libs/shared/domain`           | `scope:shared`                           | New optional `nextUnwatchedEpisodeAirDate` on `WatchlistItem`; type-assertion fixture                        |
| shared-firestore-schema | `libs/shared/firestore-schema` | `scope:shared`                           | Converter read/write coalesce; read/write data-types; `.toEqual` test-ripple fix                             |
| functions-sync-episodes | `libs/functions/sync-episodes` | `scope:functions`, `slice:sync-episodes` | New `WatchlistNextWatchableStore` port; optional `nextWatchable` config; `syncOne` recompute; barrel; README |
| functions (app)         | `apps/functions`               | `scope:functions`                        | `createNextWatchableStoreAdapter`; wire into entry A (`sync-episodes.ts`) AND entry B (`main.ts`); tests     |
| mobile-title-detail     | `libs/mobile/title-detail`     | `scope:mobile`, `slice:title-detail`     | `autoUpdateStatus` recompute; completed-path null-writes (`updateStatus`/`add`); `add` init; tests; README   |
| mobile-watchlist        | `libs/mobile/watchlist`        | `scope:mobile`, `slice:watchlist`        | `updateStatus` completed→tv null-write; tests; README                                                        |
| mobile-search           | `libs/mobile/search`           | `scope:mobile`, `slice:search`           | `add` item literal init of `nextUnwatchedEpisodeAirDate: null`; test; README                                 |

- **No cross-slice / cross-scope import.** Every slice reuses imports it already has
  (`WatchlistItem` / `EpisodeDoc` from `@vultus/shared/domain`;
  converters/paths from `@vultus/shared/firestore-schema`). `sync-episodes` adds no
  new import (its port reuses `EpisodeDoc`/domain types it already imports). No
  `scope:mobile ↔ scope:functions` edge is introduced (D6).
- **No `shared/` extraction of the recompute logic.** The min-unwatched-airDate
  computation is duplicated per surface (engine, title-detail, watchlist) — three
  places, but with different runtimes (Admin SDK vs AngularFire) and different data
  shapes; this is intra-context duplication, not the "same logic, same reason to
  change in 3+ slices" that the PLAN §3 extract rule targets. The `shared/domain`
  field + `shared/firestore-schema` converter ARE the shared surface. Do NOT extract
  a shared "computeNextUnwatched" helper.
- **No `sheriff.config.ts` change** (D6) — no new lib; existing globs cover every
  touched path. Record "no `sheriff.config.ts` change needed" in the PR.

## Data model touchpoints

PLAN §4 paths. **One new field on an existing doc; no new collection.**

`users/{userId}/watchlist/{titleId}` (PLAN §4) gains:

```
nextUnwatchedEpisodeAirDate?: string | null   # plain ISO date, e.g. '2011-04-24T00:00:00.000Z';
                                               # air date of the earliest watched:false episode;
                                               # null for movies / empty episodes / all-watched (spec 0081)
```

Stored as a **plain ISO string, NOT a Timestamp** (exactly like `releaseDate`, spec 0046) — the client and functions both write a bare string; no converter Timestamp
mapping.

| PLAN §4 path                                            | Access                                                 | By                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `users/{uid}/watchlist/{titleId}/episodes` (collection) | **read (one-shot, `{airDate, watched}`)** — functions  | new `WatchlistNextWatchableStore` adapter, after `writeEpisodes` (Admin SDK)               |
| `users/{uid}/watchlist/{titleId}/episodes` (collection) | **read (one-shot)** — client                           | `autoUpdateStatus` (title-detail) — the EXISTING snapshot read, reused; no new read stream |
| `users/{uid}/watchlist/{titleId}` (doc)                 | **update (`nextUnwatchedEpisodeAirDate`)** — functions | new adapter via `watchlistItemPath`, Admin SDK (entry A + entry B)                         |
| `users/{uid}/watchlist/{titleId}` (doc)                 | **update (`nextUnwatchedEpisodeAirDate`)** — client    | title-detail `autoUpdateStatus` + completed paths; watchlist `updateStatus`; search `add`  |

- **No `firestore.rules` change — VERIFY and RECORD (D5).** Owner-only
  `users/{userId}/{document=**}` already permits the client to update arbitrary
  fields (incl. this new one) on its own watchlist doc; the functions write uses the
  **Admin SDK** (rules-exempt). Do NOT edit `firestore.rules`. (No new rules-test —
  the field falls under the existing owner-only doc rule already covered by the
  rules-tests.)
- **No `firestore.indexes.json` change — VERIFY and RECORD (D5).** No new query: the
  functions read is the existing full-subcollection `get` (no `where`/`orderBy`); the
  client read is the existing `autoUpdateStatus` subcollection read; the min is
  computed in memory. Record "no index change needed."

## Public types / APIs

No HTTP endpoint, no callable. One `scope:shared` field, one new
`scope:functions` port.

### `shared/domain` — `WatchlistItem` (`documents.ts`)

Additive, optional (place beside `releaseDate`/`watchingViaPlex`):

```ts
export interface WatchlistItem {
  // …existing fields unchanged…
  releaseDate?: string | null;
  /** Air date (ISO 8601, same format as EpisodeDoc.airDate) of the EARLIEST
   *  currently-unwatched episode of this TV show; null when the item is a movie,
   *  the episodes subcollection is empty, or every episode is watched (spec 0081).
   *  Denormalized: written server-side on sync (Cloud Functions) and client-side
   *  after the user's own mark-watched actions. Legacy docs missing it → null via
   *  the converter. Never meaningfully set for movies. */
  nextUnwatchedEpisodeAirDate?: string | null;
  watchingViaPlex: boolean;
}
```

### `shared/firestore-schema` — converter + data-types

`data-types.ts` — add to both interfaces (plain ISO string, NOT a Timestamp):

```ts
export interface WatchlistItemReadData {
  // …
  releaseDate?: string | null;
  nextUnwatchedEpisodeAirDate?: string | null; // plain ISO date string; NOT a Timestamp
  watchingViaPlex?: boolean;
}
export interface WatchlistItemWriteData {
  // …
  releaseDate?: string | null;
  nextUnwatchedEpisodeAirDate?: string | null; // plain ISO date string; NOT a Timestamp
  watchingViaPlex: boolean;
}
```

`converters.ts` — `watchlistItemToData` (write) and `dataToWatchlistItem` (read),
both coalesced `?? null` (mirroring `releaseDate`):

```ts
// watchlistItemToData:
releaseDate: item.releaseDate ?? null,
nextUnwatchedEpisodeAirDate: item.nextUnwatchedEpisodeAirDate ?? null,
// dataToWatchlistItem:
releaseDate: data.releaseDate ?? null,
nextUnwatchedEpisodeAirDate: data.nextUnwatchedEpisodeAirDate ?? null,
```

### `slice:sync-episodes` — new port + config addition

`src/lib/ports.ts` — new port (exported from the barrel):

```ts
/** Reads episode watch-state and writes the parent watchlist doc's
 *  `nextUnwatchedEpisodeAirDate` for a (uid, titleId). Used by `syncOne` after
 *  inserting new episodes to keep the denormalized "earliest unwatched air date"
 *  correct on BOTH the on-add trigger (entry A) and the daily pass (entry B)
 *  (spec 0081). Admin-SDK-backed in apps/functions; faked in tests. Firebase-free
 *  interface. */
export interface WatchlistNextWatchableStore {
  /** Reads (airDate, watched) for every episode under
   *  users/{uid}/watchlist/{titleId}/episodes. Called AFTER writeEpisodes so it
   *  sees pre-existing docs' real watched state PLUS the just-inserted docs.
   *  `airDate` is an ISO 8601 string. */
  readEpisodeWatchState(
    uid: string,
    titleId: string,
  ): Promise<{ airDate: string; watched: boolean }[]>;
  /** Writes nextUnwatchedEpisodeAirDate (plain ISO string, or null) onto
   *  users/{uid}/watchlist/{titleId}. */
  setNextUnwatchedEpisodeAirDate(
    uid: string,
    titleId: string,
    airDate: string | null,
  ): Promise<void>;
}
```

`src/lib/engine/types.ts` — additive optional (alongside `watchlistStatus`):

```ts
export interface EpisodeSyncConfig {
  tmdb: TmdbEpisodeSource;
  episodes: EpisodeStore;
  watchlist?: WatchlistTvSource;
  watchlistStatus?: WatchlistStatusStore;
  /** Present on BOTH entry points (spec 0081 — deliberate deviation from 0074's
   *  entry-A omission). When present, `syncOne` recomputes and writes
   *  nextUnwatchedEpisodeAirDate after inserting ≥1 new episode. */
  nextWatchable?: WatchlistNextWatchableStore;
}
```

`src/lib/engine/episode-sync-engine.ts` — `syncOne`, after
`await episodes.writeEpisodes(uid, titleId, toWrite);` (independent of the 0074
`watchlistStatus` block; both may fire in the same run):

```ts
if (toWrite.length > 0 && nextWatchable) {
  const eps = await nextWatchable.readEpisodeWatchState(uid, titleId);
  const unwatched = eps.filter((e) => !e.watched).map((e) => e.airDate);
  // Min via ISO lexical comparison (the transitions.ts idiom); null when none.
  const next =
    unwatched.length > 0
      ? unwatched.reduce((min, d) => (d < min ? d : min))
      : null;
  await nextWatchable.setNextUnwatchedEpisodeAirDate(uid, titleId, next);
}
```

Destructure `nextWatchable` from `config` alongside
`{ tmdb, episodes, watchlist, watchlistStatus }`. `src/index.ts` — export
`WatchlistNextWatchableStore`.

### `apps/functions` — `createNextWatchableStoreAdapter` + wiring

`apps/functions/src/sync-episodes.ts` — new exported adapter (Admin SDK enters only
here; reuse the existing `dataToEpisode` + `EpisodeReadData` imports to convert the
stored `airDate` Timestamp → ISO string):

```ts
export function createNextWatchableStoreAdapter(
  db: Firestore,
): WatchlistNextWatchableStore {
  return {
    async readEpisodeWatchState(uid, titleId) {
      const snap = await db.collection(episodesPath(uid, titleId)).get();
      return snap.docs.map((d) => {
        const ep = dataToEpisode(d.data() as EpisodeReadData);
        return { airDate: ep.airDate, watched: ep.watched };
      });
    },
    async setNextUnwatchedEpisodeAirDate(uid, titleId, airDate) {
      await db
        .doc(watchlistItemPath(uid, titleId))
        .update({ nextUnwatchedEpisodeAirDate: airDate });
    },
  };
}
```

**Wire into BOTH entry points (D2 — the deviation from 0074):**

- **Entry A** — `syncWatchlistEpisodes` on-add trigger (`sync-episodes.ts`): add
  `nextWatchable: createNextWatchableStoreAdapter(db)` to the
  `createEpisodeSyncEngine({...})` config (which today wires only `tmdb` +
  `episodes`). This is the deliberate deviation — do NOT omit it as 0074 did for
  `watchlistStatus`.
- **Entry B** — daily pass (`main.ts`, the `createEpisodeEngine` factory, alongside
  the existing `tmdb`/`episodes`/`watchlist`/`watchlistStatus`): add
  `nextWatchable: createNextWatchableStoreAdapter(firestore)`.

### `slice:title-detail` — `title-detail.service.ts`

- `autoUpdateStatus` (private): after the existing episodes snapshot loop derives
  `total`/`watchedCount`, compute `next = min airDate over docs with watched ===
false, else null` from the SAME `snap` and write it:
  `updateDoc(watchlistItemPath(uid, tmdbId), { nextUnwatchedEpisodeAirDate: next })`.
  A separate write from the status write is acceptable ("alongside"); the
  implementer may merge it into a status `updateDoc` where one already fires. This
  sits AFTER the existing `null`/`dropped` early-return (see Risks for the dropped
  nuance). No signature change; no page-template change.
- `updateStatus`: when `status === 'completed' && type === 'tv'`, extend the status
  write to `{ status, nextUnwatchedEpisodeAirDate: null }` (covers the direct
  action-sheet "set Completed" path, which does not route through
  `autoUpdateStatus`).
- `add`: the `WatchlistItem` literal initializes `nextUnwatchedEpisodeAirDate: null`
  (correct for the completed-add case too, since it batch-marks all watched).

### `slice:watchlist` — `watchlist.service.ts`

- `updateStatus`: when `status === 'completed' && type === 'tv'`, extend the status
  write to `{ status, nextUnwatchedEpisodeAirDate: null }` (after
  `markAllEpisodesWatched`).

### `slice:search` — `search.service.ts`

- `add`: the `WatchlistItem` literal initializes `nextUnwatchedEpisodeAirDate: null`.

## UI / Stitch screen refs

**No UI change, no new Stitch screen, no new visual element (D4).** No slice renders
`nextUnwatchedEpisodeAirDate` in this spec — it is a denormalized data field only.
The follow-up "Watch Today" spec (a new `slice:mobile/today` + tab + Stitch screen)
is the consumer that will render/compare it. Record "no new UI element — data-layer
field only; no Stitch capture required (consumer is the follow-up Watch-Today spec)"
in the PR. A green build correctly proves nothing rendered differently — this is the
expected outcome, NOT a UI-fidelity gap, because there is no UI in this spec.

## Implementation task graph

**Fully [sequential] end-to-end** — each task depends on the compiled types /
converters of the earlier ones. No parallel fan-out (so no disjoint-manifest
assertion is required; the manifests below are for change scoping / review).

- **Task 1 — `shared/domain` field + type-assertion fixture [sequential]**
  (backend/frontend-engineer).
  Manifest: `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/type-assertions.ts`,
  `libs/shared/domain/README.md`.
  1. Add optional `nextUnwatchedEpisodeAirDate?: string | null` to `WatchlistItem`
     (D1).
  2. The `_watchlistItem` fixture in `type-assertions.ts` compiles unchanged (field
     is optional); add `nextUnwatchedEpisodeAirDate: null` to it for explicitness so
     it type-checks as a fully-populated `WatchlistItem`.
  3. README: document the new field on `WatchlistItem`.

- **Task 2 — `shared/firestore-schema` converter + the known `.toEqual` ripple fix
  [sequential, after 1]** (backend/frontend-engineer).
  Manifest: `libs/shared/firestore-schema/src/lib/data-types.ts`,
  `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md`.
  1. Add `nextUnwatchedEpisodeAirDate?: string | null` to
     `WatchlistItemReadData`/`WatchlistItemWriteData` (plain ISO string; NOT a
     Timestamp).
  2. `watchlistItemToData` + `dataToWatchlistItem`: add the `?? null` coalesce both
     directions.
  3. **Fix the known full-object `.toEqual` ripple** in `firestore-schema.spec.ts`.
     Once the converter unconditionally emits the field, every full-`WatchlistItem`
     `.toEqual` expected object must include `nextUnwatchedEpisodeAirDate: null` (a
     `null` value is NOT equal to an absent key under Vitest `toEqual`). The blocks
     to fix (current line numbers — re-grep before editing):
     - the round-trip `.toEqual({ ...item, posterPath: null, ... })` at ~368-375
       (add `nextUnwatchedEpisodeAirDate: null` to the expected literal),
     - the `.toEqual(item)` blocks at ~391-393, ~409-411, ~468-471, ~488-491 (add
       `nextUnwatchedEpisodeAirDate: null` to each `item` literal).
       Partial-payload / directional spot-check assertions and the
       `watchingViaPlex`/`releaseDate` presence checks are unaffected.
  4. Add a converter round-trip test: field present (a `tv` item) round-trips; a
     legacy doc missing the field reads back as `null`.
  5. README: note the new converted field.

- **Task 3 — `sync-episodes` port + engine recompute + engine unit tests
  [sequential, after 2]** (backend-engineer).
  Manifest: `libs/functions/sync-episodes/src/lib/ports.ts`,
  `libs/functions/sync-episodes/src/lib/engine/types.ts`,
  `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts`,
  `libs/functions/sync-episodes/src/index.ts`,
  `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.spec.ts`,
  `libs/functions/sync-episodes/README.md`.
  1. `ports.ts`: add `WatchlistNextWatchableStore`.
  2. `engine/types.ts`: add optional `nextWatchable?: WatchlistNextWatchableStore`
     to `EpisodeSyncConfig`.
  3. `engine/episode-sync-engine.ts`: after `writeEpisodes`, when
     `toWrite.length > 0 && nextWatchable`, read episode watch-state, compute the
     min unwatched airDate (ISO lexical min) or null, and write it. Destructure
     `nextWatchable` from config.
  4. `src/index.ts`: export `WatchlistNextWatchableStore`.
  5. Engine unit tests (Test plan).
  6. README: document the new port, the recompute, and that it is wired into BOTH
     entry points (unlike the 0074 `watchlistStatus` port).

- **Task 4 — `apps/functions` adapter + BOTH-entry wiring + tests [sequential,
  after 3]** (backend-engineer).
  Manifest: `apps/functions/src/sync-episodes.ts`, `apps/functions/src/main.ts`,
  `apps/functions/src/sync-episodes.spec.ts` and/or
  `apps/functions/src/main.spec.ts`.
  1. `sync-episodes.ts`: add `createNextWatchableStoreAdapter(db)` (reuse
     `dataToEpisode`/`EpisodeReadData`/`episodesPath`/`watchlistItemPath` imports).
  2. `sync-episodes.ts` (entry A): add `nextWatchable:
createNextWatchableStoreAdapter(db)` to the `syncWatchlistEpisodes`
     `createEpisodeSyncEngine` config. **This is the deviation from 0074 — do NOT
     omit it.**
  3. `main.ts` (entry B): add `nextWatchable:
createNextWatchableStoreAdapter(firestore)` to the `createEpisodeEngine`
     factory config.
  4. Unit tests (Test plan): adapter read/write; **entry A wiring asserted**; entry
     B wiring asserted.

- **Task 5 — `slice:title-detail` recompute + completed paths + tests [sequential,
  after 2]** (frontend-engineer).
  Manifest: `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
  `libs/mobile/title-detail/README.md`.
  1. `autoUpdateStatus`: compute + write `nextUnwatchedEpisodeAirDate` from the
     existing snapshot (D3).
  2. `updateStatus` completed→tv: add `nextUnwatchedEpisodeAirDate: null` to the
     status write.
  3. `add`: init `nextUnwatchedEpisodeAirDate: null` in the item literal.
  4. Service unit tests (Test plan).
  5. README: note the new recompute responsibility (autoUpdateStatus + completed
     paths keep the denormalized field correct).

- **Task 6 — `slice:watchlist` + `slice:search` writes + tests [sequential, after
  2]** (frontend-engineer).
  Manifest: `libs/mobile/watchlist/src/lib/watchlist.service.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.service.spec.ts`,
  `libs/mobile/watchlist/README.md`,
  `libs/mobile/search/src/lib/search.service.ts`,
  `libs/mobile/search/src/lib/search.service.spec.ts`,
  `libs/mobile/search/README.md`.
  1. `watchlist.service.ts` `updateStatus` completed→tv: add
     `nextUnwatchedEpisodeAirDate: null` to the status write.
  2. `search.service.ts` `add`: init `nextUnwatchedEpisodeAirDate: null`.
  3. Unit tests (Test plan).
  4. READMEs: note the new field responsibility in each.

> Tasks 5 and 6 both depend only on Task 2 (converter/types) and touch disjoint
> files, so an orchestrator MAY run them in parallel after Task 2; they are listed
> sequential for simplicity and because Task 4 (functions) is the correctness core.

## Test plan

Per the PLAN §5 pyramid — backend/logic-heavy, so **unit tests dominate**. All unit
tests run on **Vitest + Analog**; all Firebase access is mocked/faked (no live
Firebase, no emulator, no network, no secrets).

**Rendered-text note:** no component/unit test in this spec asserts rendered UI text
(nothing renders the field), so there is no whitespace-normalization risk to guard.

**Unit — `shared/domain`:** the type compiles; the `type-assertions.ts` fixture
type-checks as a complete `WatchlistItem` (no dedicated runtime test).

**Unit — `shared/firestore-schema` (`firestore-schema.spec.ts`):**

- Round-trip: a `tv` item with `nextUnwatchedEpisodeAirDate` set → round-trips to
  the same ISO string; stored as a **plain string** (assert `not.toBeInstanceOf(Date)`
  / raw string, like `releaseDate`).
- Legacy doc missing the field → `dataToWatchlistItem` reads it as `null`.
- Absent on the source item → written as `null` (never `undefined`); `'…' in write`
  present.
- The five full-object `.toEqual` blocks fixed (Task 2 step 3) still pass.

**Unit — `episode-sync-engine.spec.ts` (in-memory fake ports):**

- A TV show with some unwatched episodes (fake `readEpisodeWatchState` returns a
  mix) after a run inserting ≥1 new episode → `setNextUnwatchedEpisodeAirDate` called
  with the **min airDate among `watched === false`**.
- All episodes watched → `setNextUnwatchedEpisodeAirDate(..., null)`.
- Empty episode set → `null`.
- `toWrite.length === 0` (no new episodes this run) → `nextWatchable` is **NOT
  called** (no read, no write) — the gate.
- `nextWatchable` port **ABSENT** (config omits it) → no read/write, no throw
  (optional-port backward compatibility, mirroring 0074's `watchlistStatus`-absent
  test).
- Interop with 0074: a run that both inserts new episodes into a `'completed'` show
  AND has both ports wired → the `watchlistStatus` revert AND the
  `nextUnwatchedEpisodeAirDate` write both fire (independent blocks).
- Insert-only invariant unchanged (existing 0047 assertions still pass).

**Unit — `apps/functions` adapter (`sync-episodes.spec.ts` / `main.spec.ts`, fake
`db`):**

- `createNextWatchableStoreAdapter.readEpisodeWatchState` maps stored episode docs
  to `{ airDate, watched }` (airDate as ISO string via `dataToEpisode`);
  `setNextUnwatchedEpisodeAirDate` issues `.update({ nextUnwatchedEpisodeAirDate })`.
- **Entry A** (`syncWatchlistEpisodes`) `createEpisodeSyncEngine` config **includes
  `nextWatchable`** — an explicit test proving entry-A wiring (this is the
  decision-2 deviation from 0074; the natural instinct is to copy 0074's entry-A
  omission, so a reviewer must see this asserted).
- **Entry B** (`createEpisodeEngine`) config includes `nextWatchable` (alongside
  `watchlistStatus`).

**Unit — `title-detail.service.spec.ts` (mocked AngularFire + `AUTH_UID`):**

- Marking the LAST unwatched episode watched (via `setEpisodeWatched`) → the
  watchlist doc write includes `nextUnwatchedEpisodeAirDate: null`.
- Unchecking a previously-watched episode on an otherwise fully-watched show → field
  becomes that episode's `airDate` (min over the now-unwatched set).
- Marking one of several episodes watched → field = min airDate of the remaining
  unwatched.
- `setSeasonWatched` (both directions) drives the same recompute (routes through
  `autoUpdateStatus`).
- `updateStatus(tmdbId, 'completed', 'tv')` (direct action-sheet path) → write
  includes `nextUnwatchedEpisodeAirDate: null`.
- A movie (`setMovieWatched` / `updateStatus(..., 'movie')`) → NO episode read, NO
  `nextUnwatchedEpisodeAirDate` write (stays null).
- All surviving spec-0034/0050/0074 status transitions still pass (the recompute is
  additive; assert it does not perturb them).

**Unit — `watchlist.service.spec.ts`:**

- `updateStatus(uid, titleId, 'completed', 'tv')` → the status write includes
  `nextUnwatchedEpisodeAirDate: null` (alongside `markAllEpisodesWatched`).
- `updateStatus` for a movie / a non-completed status → NO `nextUnwatchedEpisodeAirDate`
  write.

**Unit — `search.service.spec.ts`:**

- `add` → the `setDoc`/`watchlistItemToData` payload has
  `nextUnwatchedEpisodeAirDate: null` (and the existing add assertions still pass).

**Component:** none required — no template/component change; nothing renders the
field. Existing component suites in the touched slices must keep passing (no visible
regression). Stated explicitly rather than omitted.

**e2e:** **No e2e flows required — data-layer / backend change with no route or
user-facing action (D4).** Per the rubric this is intentionally omitted: there is no
new navigation route, no new critical action surfaced to the user, and the consuming
UI ships in the follow-up Watch-Today spec (which will carry its own e2e). Recorded
explicitly so the omission is intentional, not silent.

## Definition of done

Tailored from PLAN §5. Every checkbox maps to a task above.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set is `shared-domain`, `shared-firestore-schema`, `functions-sync-episodes`,
      `functions`, `mobile-title-detail`, `mobile-watchlist`, `mobile-search` (+
      `mobile`). Verify `nx affected` does not unexpectedly pull in unrelated
      component-tested UI. (Tasks 1–6)
- [ ] **Sheriff clean** (in the lint above): no cross-scope import
      (`scope:mobile ↔ scope:functions`); the `sync-episodes` lib stays
      Firebase-free (the new port adds no Firebase import); uid via `AUTH_UID` in
      the mobile slices. (Tasks 3, 5, 6)
- [ ] `pnpm nx run functions:deploy-preflight` green (D7 — CI gate for the
      `apps/functions` + `sync-episodes` change). (Tasks 3, 4)
- [ ] **Unit tests** per the Test plan: converter round-trip + legacy-null +
      `.toEqual` ripple fix (Task 2); engine recompute (min-unwatched, all-watched,
      empty, zero-insert no-op, port-absent no-op, 0074 interop) (Task 3); adapter +
      **BOTH-entry wiring incl. the entry-A assertion** (Task 4); title-detail
      recompute + completed paths + movie no-op (Task 5); watchlist + search writes
      (Task 6). (Tasks 2–6)
- [ ] **Every touched lib README updated** (CLAUDE.md lib-README rule):
      `shared/domain`, `shared/firestore-schema`, `functions/sync-episodes`,
      `mobile/title-detail`, `mobile/watchlist`, `mobile/search`. (Tasks 1–3, 5, 6)
- [ ] **Verify-and-record NO change (D5/D6):** `firestore.rules`,
      `firestore.indexes.json` (no rules/index change — client write via owner-only
      `users/{userId}/{document=**}`, functions write via Admin SDK, no new query),
      `sheriff.config.ts`, `.github/workflows/ci.yml`, `apps/mobile-e2e/**` — NOT
      modified. Record each as "no change needed" in the PR.
- [ ] **Guardrail verifications (review-checked):** (a) the field is
      stored/written as a **plain ISO string, NOT a Timestamp** (like `releaseDate`);
      (b) the engine recompute fires **only** when `toWrite.length > 0 &&
    nextWatchable`; (c) the new port is wired into **BOTH** entry A and entry B
      (the deviation from 0074); (d) the min uses ISO **lexical** comparison; (e)
      movies never get a non-null value / no episode read; (f) insert-only episode
      invariant preserved (spec 0047 — no episode-doc overwrite); (g) **no secret
      read or written**; (h) deploy left to `/deploy-functions` (NOT auto-run).
- [ ] **No visible app change** — a green build proves nothing rendered differently,
      which is the correct/expected outcome (there is no UI in this spec). Record "no
      new UI element — data-layer field only; consumer is the follow-up Watch-Today
      spec" in the PR.
- [ ] **PR description records:** the three-scope nature (`scope:shared` +
      `scope:functions` + `scope:mobile`); the **entry-A-vs-entry-B wiring deviation
      from spec 0074** and why (a fresh TV add must get the field on first sync);
      the `functions:deploy-preflight` requirement + deploy being a separate manual
      `/deploy-functions` step; that this is **Spec A of a two-spec split** and ships
      invisible until the follow-up Watch-Today spec lands.

## Risks

- **Entry-A wiring deviation from spec 0074 (flag prominently).** An implementer
  skimming 0074 for "how to wire a new sync-episodes port" will naturally copy its
  **entry-A omission** (0074 deliberately omitted `watchlistStatus` from the on-add
  trigger). That is **WRONG** here: this port must be wired into BOTH entry A and
  entry B, or a freshly-added TV show's field stays `null` until the next daily pass
  and the show looks "nothing to watch" for up to 24h. Mitigation: the Test plan
  requires an explicit entry-A wiring assertion, and the DoD guardrail (c) calls it
  out.
- **`getExistingEpisodeIds` returns ids only — the trickiest correctness point.**
  The engine's existing `existing: Set<string>` (ids, no `watched` state) is
  insufficient to compute "earliest unwatched." An implementer might try to reuse it
  and get watched-state wrong. Mitigation: the new port's `readEpisodeWatchState`
  does a **fresh full read AFTER `writeEpisodes`** so it sees pre-existing docs' real
  `watched` state plus the just-inserted (`watched: false`) docs. Spelled out in D2
  and the port doc-comment.
- **Extension beyond the interview's explicit client-write enumeration
  (`title-detail` completed paths).** Decision 3 enumerated `setEpisodeWatched` /
  `setSeasonWatched` (title-detail) + `markAllEpisodesWatched` (watchlist) + `add`
  (search). But **`title-detail.service.updateStatus`(completed→tv)** and
  **`add`(completed→tv)** also batch-mark every episode watched WITHOUT routing
  through `autoUpdateStatus`, so without a null-write there the field would stay
  stale/non-null after a title-detail "Mark Completed" — a false "watch today" in
  the follow-up UI, and NOT self-healing via sync (sync only recomputes when new
  episodes insert). This spec therefore **extends** the enumeration to those
  title-detail paths (grounded in decision 3's stated principle "keep the field
  correct whenever the user's own mark-watched actions change what's unwatched").
  **Flagged for architect/reviewer confirmation** — if undesired, drop Task 5 steps
  2–3, but the stale-field bug then stands.
- **`dropped` TV shows are not recomputed client-side.** The title-detail recompute
  sits after `autoUpdateStatus`'s existing `null`/`dropped` early-return (which
  predates this spec), so toggling episodes on a `dropped` show does not update the
  field from the app. This is acceptable: a dropped show is not "watchable today" by
  definition, and the field self-heals on the next daily sync that inserts episodes.
  Noted so a reviewer does not flag it as a miss.
- **Standard shared-optional-field `.toEqual` ripple (project-known gotcha,
  MEMORY: "Shared optional-field .toEqual ripple").** Forgetting any of the five
  full-object `.toEqual` fixups in `firestore-schema.spec.ts` breaks CI in a way
  easy to miss if the implementer runs only the directly-touched project's tests.
  Mitigation: run `nx affected -t test --base=main` (not per-project), and Task 2
  step 3 enumerates the blocks.
- **One extra Firestore read + write per synced TV show** (only when
  `toWrite.length > 0`). Bounded and cheap at personal scale; independent of the
  0074 status read/write on the same run. Noted so the added I/O is expected.
- **Ships invisible to the end user until the follow-up Watch-Today spec lands.**
  This is the intended Spec-A-of-two outcome (data before UI), NOT a gap. Noted so a
  reviewer does not ask "where's the UI."
- **Manual "refresh now" does NOT recompute this field (inherited limitation, not a
  new gap).** The manual refresh callable (`triggerSync` / `runTriggerSync` in
  `apps/functions/src/main.ts`) does NOT run any episode sync — under the existing
  0047/0074 sync model manual refresh only touches `title-cache`. It therefore never
  invokes `syncOne` and never recomputes `nextUnwatchedEpisodeAirDate`. Only the
  on-add trigger (entry A) and the daily pass (entry B) recompute it server-side.
  This is a pre-existing property of the sync model, NOT a gap introduced by this
  spec, but stated so a reviewer does not expect pull-to-refresh to update the field.
- **`plex-sync.service.ts` `addItem` is a structurally identical WatchlistItem
  construction site but is correctly NOT touched.**
  `libs/mobile/settings/src/lib/plex-sync.service.ts`'s `addItem` (line 353)
  constructs a `WatchlistItem` just like search's `add`, yet this spec deliberately
  leaves it unchanged: the field is optional and converter-coalesced (`?? null`), and
  the plex-sync spec only asserts **partial** write payloads (no full-object
  `.toEqual`), so there is no `.toEqual` ripple to fix and no belt-and-suspenders
  init needed. Noted so a future reviewer does not ask "why search but not
  plex-sync."
- **No PLAN conflict.** Uses the existing PLAN §4 `users/{uid}/watchlist/{titleId}`
  doc + `…/episodes` subcollection, the spec-0047/0074 port/adapter pattern, and the
  additive-optional-field precedent of `releaseDate` (spec 0046). No new collection,
  no new dependency, no `firestore.rules`/index/Sheriff change.
