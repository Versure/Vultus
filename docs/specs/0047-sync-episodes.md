---
number: 0047
slug: sync-episodes
title: Sync TV episodes from TMDB into the per-user episodes subcollection
status: approved
slices: [slice:sync-episodes]
scopes: [scope:functions, scope:shared]
created: 2026-06-30
---

# Sync TV episodes from TMDB into the per-user episodes subcollection

## Context

Spec 0034 (merged, `done`) built the episode-list UI in `slice:title-detail`: it
**reads** `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`, renders a
season-grouped list, and lets the user mark episodes watched. But it explicitly
left the **writer** out of scope — its Risks call this out: "the episode
subcollection is currently NEVER written … the sync engine writes **NO episodes**
… the section shows the **empty state** until a future `scope:functions` spec
teaches the sync engine to write episodes (incl. the new `EpisodeDoc.title`)."
This spec is that writer.

Spec 0012 (merged, `done`) built the notification dispatcher, whose
`episode-aired` path reads `users/{uid}/watchlist/{titleId}/episodes/*` and
notifies when an episode's `airDate ≤ now` and the show has flatrate availability.
That path **also has no data to work with today** — nothing populates the
subcollection. This spec gives both consumers (the 0034 UI and the 0012
dispatcher) their data.

The user need: when a user adds a TV show to their watchlist, the show's episodes
should appear in the detail page (no more "Episodes will appear after the next
sync." empty state), and as new episodes air, the daily sync should add them so
the user can track and be notified about them.

Intended outcome: a new `scope:functions` slice `libs/functions/sync-episodes`
holding a **pure, Firebase-free episode-upsert engine** (port/adapter pattern,
mirroring `sync-titles` (spec 0008) and `dispatch-notifications` (spec 0012)),
driven by **two entry points** in `apps/functions` that share that one engine:

- **(A)** a Firestore `onDocumentCreated` trigger on
  `users/{uid}/watchlist/{titleId}` that fires when a user adds a title, and
- **(B)** an extension to the daily-sync flow (`runSync` in `apps/functions/src/main.ts`)
  that, after the existing title-cache pass, runs the episode upsert for every TV
  show in every user's watchlist — picking up newly-aired episodes for shows
  already tracked.

The engine **only inserts episode docs that do not yet exist** — it **never**
overwrites an existing episode doc, because `watched` / `watchedAt` are user data
owned by spec 0034 and must never be touched by the sync.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Two entry points, one shared engine.**
   - **(A) `onDocumentCreated` on `users/{uid}/watchlist/{titleId}`** — fires when
     a user adds a title; if `type !== 'tv'` it is a **no-op** (movies have no
     episode subcollection); for a `tv` title it runs the upsert engine for that
     one `(uid, titleId, tmdbId)`.
   - **(B) daily-sync extension** — after the existing title-cache pass in
     `runSync` completes, run the **same** engine over every `(uid, titleId,
tmdbId)` TV show in every user's watchlist, to pick up newly-aired episodes for
     shows already tracked.
   - Both call the **same** Firebase-free engine, injected with the same ports.

2. **Episode document id format: `s${SS}e${EEE}`** — season zero-padded to **2**
   digits, episode zero-padded to **3** digits, both derived from the TMDB
   season/episode numbers: `s01e001`, `s01e010`, `s02e001`, `s10e001`,
   `s01e100`. (Episode numbers exceeding 999 are not expected in v1; see Risks.)

3. **Merge strategy — insert only NEW episodes; never overwrite.**
   ```
   existingIds = EpisodeStore.getExistingEpisodeIds(uid, titleId)   // keys only
   fetched     = TMDB seasons/episodes
   toWrite     = fetched.filter(e => !existingIds.has(episodeId(e)))
   EpisodeStore.writeEpisodes(uid, titleId, toWrite)                 // batched
   ```
   - **Never overwrite an existing episode doc.** `watched` / `watchedAt` are user
     data (spec 0034) and must never be touched by the sync.
   - **Re-adding a show after removal** uses the same merge — existing docs are
     left untouched, no subcollection wipe.
   - New episodes TMDB adds for a future season are inserted by the next daily
     pass (entry point B).

4. **`EpisodeDoc` fields written on creation** (only on a doc that does NOT yet
   exist):
   ```ts
   {
     season: number,        // from TMDB
     episode: number,       // from TMDB
     title: string | null,  // TMDB episode name, or null when unset (EpisodeDoc.title, spec 0034)
     airDate: string,       // null-air-date episodes are skipped — see Data model option (b)
     watched: false,        // ALWAYS false on creation — user data, never overwritten
     watchedAt: null        // ALWAYS null on creation — user data, never overwritten
   }
   ```
   `EpisodeDoc.title` already exists (spec 0034). **See Risks R1 / R2:** the TMDB
   layer that feeds these fields does **not yet carry the episode `name`, the show
   season count, or a nullable air date** — small additive changes to the
   `sync-titles` TMDB client/mapper and one `@vultus/shared/domain` entity are
   required (the decision-record claim "no shared/domain changes needed" does not
   hold against `main`). These are scoped in Public types / APIs + the task graph.

5. **New slice `libs/functions/sync-episodes`**, port/adapter, following
   `dispatch-notifications` / `sync-titles`:
   - **Pure, Firebase-free engine** in `src/lib/engine/` (the upsert orchestration
     + the `episodeId` / `EpisodeDoc`-construction helpers — all unit-tested with
     fakes).
   - **Thin Admin-SDK wiring** in `apps/functions`: the `onDocumentCreated` trigger
     (`apps/functions/src/sync-episodes.ts`) + the daily-sync integration in
     `apps/functions/src/main.ts`, plus the Admin-SDK port adapters.
   - Sheriff `scope:functions` + `slice:sync-episodes`, resolved by the path glob
     `libs/functions/<slice>/src` in `sheriff.config.ts` (no edit). `project.json`
     carries `"tags": []` like `sync-titles` / `dispatch-notifications`. Single
     `src/index.ts` barrel.

6. **Ports (Firebase-free interfaces), injected into the engine:**
   - **`TmdbEpisodeSource`** — the engine's view of TMDB: get a show's season
     count for a `tmdbId`, and get a season's episodes for `(tmdbId, seasonNumber)`.
     Backed in `apps/functions` by the existing `@vultus/functions/sync-titles`
     `TmdbClient` (`getTvShow` for the season count, `getSeasonEpisodes` per
     season) — **the sync-episodes slice does NOT import `slice:sync-titles`**
     (forbidden cross-slice); it depends only on the port, and `apps/functions`
     (which may import both functions slices) wires the adapter.
   - **`EpisodeStore`** — read the existing episode doc ids for `(uid, titleId)`;
     batch-write new episode docs for `(uid, titleId)`. Domain-typed, Firebase-free.
   - **`WatchlistTvSource`** — (daily-sync only) enumerate every `(uid, titleId,
tmdbId)` TV show across all users' watchlists; and (on-add trigger) read a
     single watchlist doc's `{ type, tmdbId }`. Admin-SDK-backed in `apps/functions`.

7. **Skip non-TV.** Entry point A no-ops on `type !== 'tv'`; entry point B only
   enumerates `type === 'tv'` items. Movies have no episode subcollection — there
   is no movie "episode" sync.

8. **Testing — unit only, no emulator, no e2e.** The pure engine is proven with a
   fake `TmdbEpisodeSource`, a fake `EpisodeStore`, and a fake `WatchlistTvSource`
   (Vitest): the merge logic (insert-only), `watched`/`watchedAt` never touched,
   movies skipped, the `episodeId` padding, season iteration. **No emulator**
   (the Firestore emulator cannot run under Claude Code tools — project memory;
   consistent with 0008/0009/0012). **No e2e added by this spec** — the episode
   e2e flows already exist as `test.fixme` in `apps/mobile-e2e/src/title-detail.spec.ts`
   (spec 0034) and are un-skipped when the emulator seed data is updated, which is
   out of scope here.

9. **Out of scope** (each its own spec/concern):
   - Any **mobile UI** change — spec 0034 already reads/renders episodes; the empty
     state disappears naturally once episodes are written.
   - **Deleting** episode docs when TMDB removes an episode (insert-only in v1).
   - Syncing **movie "episodes"** (movies have none).
   - **Backfilling** `EpisodeDoc.title` for docs written by other means (there are
     none — the subcollection has never been written before).
   - **Un-skipping the 0034 `test.fixme` e2e flows** / adding episode emulator seed
     data — a later step once the emulator runs in the user's own terminal.
   - **Notification dispatch** — spec 0012 already reacts to the episode subcollection;
     this spec only **populates** it. No `dispatch-notifications` change.
   - **Trakt calendar** episode data — TMDB seasons/episodes are the v1 source.

## Scope

In scope:

- **A new slice lib** `libs/functions/sync-episodes` (`scope:functions` +
  `slice:sync-episodes`), generated via Nx, Firebase-free, behind one
  `src/index.ts` barrel — mirroring the `sync-titles` / `dispatch-notifications`
  generator config.
- **A pure episode-upsert engine** (`src/lib/engine/`): the `episodeId(season,
episode)` helper (`s${SS}e${EEE}` padding), an `EpisodeDoc`-construction helper
  (decision 4 fields, `watched: false` / `watchedAt: null`), and the
  `createEpisodeSyncEngine(config)` factory orchestrating, per `(uid, titleId,
tmdbId)`: read the season count → fetch each season's episodes → read existing
  ids → write only the missing docs. No I/O — driven by injected ports; fully
  unit-tested with fakes.
- **The injected ports** (`src/lib/ports.ts`): `TmdbEpisodeSource`,
  `EpisodeStore`, `WatchlistTvSource` — all domain-typed, Firebase-free, exported
  from the barrel.
- **The thin Admin-SDK wiring** in `apps/functions`:
  - `apps/functions/src/sync-episodes.ts` — the `onDocumentCreated('users/{uid}/watchlist/{titleId}', …)`
    trigger (entry point A) + the Admin-SDK port adapters (the `EpisodeStore`
    over `episodesPath`/`episodePath` + `episodeToData`, the `TmdbEpisodeSource`
    over the sync-titles `TmdbClient`, the `WatchlistTvSource` over Firestore).
  - The daily-sync integration in `apps/functions/src/main.ts` — after the
    existing title-cache pass in `runSync`, run the episode engine over all TV
    watchlist items (entry point B); register/export `syncWatchlistEpisodes`
    (the trigger) from `main.ts` alongside `syncTitles` / `triggerSync` /
    `dispatchNotifications`.
- **Additive TMDB-layer changes in `slice:sync-titles` + one `@vultus/shared/domain`
  entity** to carry the data decision 4 needs (Risks R1/R2): the `Episode` entity
  gains `title: string | null`; `TmdbEpisodeEntry` gains `name`; `TmdbTvResponse`
  gains `number_of_seasons`; `mapSeasonEpisodes` carries the title and stops
  dropping null-air-date episodes (or the engine handles null air date — see
  Public types / APIs); `getTvShow` (or a new `getTvSeasonCount`) exposes the
  season count. **These ride the existing `sync-titles` barrel** so `apps/functions`
  can wire the adapter; the sync-episodes slice never imports sync-titles.
- **Vitest unit tests** for the engine (fakes + fixed clock) and the TMDB-mapper
  additions.
- **A complete `libs/functions/sync-episodes/README.md`** (not Nx scaffold text),
  and updated `sync-titles` / `shared/domain` READMEs for the additive surface.

Out of scope (per decision 9): mobile UI; episode deletion; movie episodes;
`EpisodeDoc.title` backfill; un-skipping the 0034 e2e flows / episode emulator
seed; `dispatch-notifications` changes; Trakt calendar episodes; any
`firestore.rules` / `firestore.indexes.json` change (see Data model touchpoints).

## Affected slices & Sheriff tags

| Project                  | Path                          | Sheriff tags                            | Change                                                                                                              |
| ------------------------ | ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| functions-sync-episodes  | `libs/functions/sync-episodes`| `scope:functions`, `slice:sync-episodes`| **new lib** — episode-upsert engine, `episodeId`/`EpisodeDoc` helpers, ports, barrel, README, tests                 |
| functions (app)          | `apps/functions`              | `scope:functions`                       | **add** `sync-episodes.ts` (onDocumentCreated trigger + adapters); extend `main.ts` daily-sync + export trigger     |
| functions-sync-titles    | `libs/functions/sync-titles`  | `scope:functions`, `slice:sync-titles`  | **additive** TMDB layer: episode `name`, season count, nullable air date in mapper (Risks R1/R2)                    |
| shared-domain (edit)     | `libs/shared/domain`          | `scope:shared`                          | **add** `title: string \| null` to the `Episode` entity (so the mapper can carry it) — additive                    |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (verified — lines 56–57:
  `'libs/functions/<slice>/src': ['scope:functions', 'slice:<slice>']`): the new
  lib's source under `libs/functions/sync-episodes/src` inherits `scope:functions`
  + `slice:sync-episodes` automatically. **This spec does NOT edit `sheriff.config.ts`**
  — the wildcard already covers the new slice; the generated `project.json` keeps
  `"tags": []` (like `sync-titles` / `dispatch-notifications`). Do **not** pass
  `--tags=…` to the generator and do **not** hand-edit a `tags` array.
- **Import boundaries (verified against `sheriff.config.ts` depRules):**
  - The sync-episodes **core lib** imports `@vultus/shared/domain` (`EpisodeDoc`,
    `Episode`, `TitleType`) and **MAY** import `@vultus/shared/firestore-schema`
    only if a port is expressed in its vocabulary — the recommended design keeps
    ports in pure domain terms, so the core likely imports only
    `@vultus/shared/domain`. It must import **no** `scope:mobile`, **no other
    slice** (critically **not** `slice:sync-titles` — rule 2 / `'slice:*':
['scope:shared', sameTag]`), and **no** `firebase-admin`/`firebase-functions`.
    The no-SDK / no-cross-slice constraint is verified by code review of the diff
    + the SDK-free unit tests passing with fakes (Sheriff governs workspace
    scope/slice edges, not third-party `firebase-admin`).
  - `apps/functions` importing **both** `@vultus/functions/sync-episodes` **and**
    `@vultus/functions/sync-titles` + `@vultus/shared/*` is **allowed** (rule 3:
    an app imports its own scope's slices). `apps/functions` is the only place the
    two functions slices meet — it wires the sync-titles `TmdbClient` into the
    sync-episodes `TmdbEpisodeSource` adapter. The Admin SDK +
    `firebase-functions/v2/firestore` imports live **only** in `apps/functions/src`.
  - The `sync-titles` TMDB additions stay within `slice:sync-titles`; the `Episode`
    entity addition is `scope:shared` (importable by anyone — rule 4).
- **Do NOT import the `sync-titles` slice from the sync-episodes slice.** The
  engine speaks the `TmdbEpisodeSource` **port**; `apps/functions` implements that
  port by delegating to the sync-titles `TmdbClient`. An `import` of
  `@vultus/functions/sync-titles` inside `libs/functions/sync-episodes` would be a
  Sheriff-forbidden cross-slice edge (rule 2). Stated so the implementer wires
  through the port, not a slice import.
- **No `shared/` extraction of slice logic.** The upsert orchestration, the
  `episodeId` helper, the ports stay inside `libs/functions/sync-episodes` — one
  consuming slice, far short of the 3+-slice rule (CLAUDE.md / PLAN §3). The lone
  `shared/` change is the additive `Episode.title` field (a domain-vocabulary
  addition, the spec-0003/0005 contract — not a slice extraction).

## Data model touchpoints

PLAN §4. The engine **reads** watchlist docs + existing episode doc ids and
**creates** new episode docs; it touches nothing else.

| PLAN §4 path                                              | Access                       | By                                                                                                  |
| --------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}`                         | **trigger source** (entry A) | the `onDocumentCreated` event's `data` → `{ type, tmdbId }`; `type !== 'tv'` → no-op                 |
| `users/{uid}/watchlist/{titleId}`                         | **read** (entry B)           | `collectionGroup('watchlist')` → every TV `{ uid, titleId, tmdbId }` (uid from `parent.parent.id`)  |
| `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`    | **read** (keys only)         | existing episode doc ids for the merge filter (read ids; do NOT read `watched`/`watchedAt` to write)|
| `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`    | **create** (new docs only)   | one `EpisodeDoc` per missing `episodeId`, via the spec-0005 `episodeToData` converter               |
| `title-cache/**`                                          | **none**                     | unchanged — this spec does not touch the title cache (the title-cache pass is the existing engine)  |
| `users/{uid}/notifications/**`                            | **none**                     | unchanged — dispatch is spec 0012's job; this spec only populates the episodes the dispatcher reads |

- **On-add trigger doc (entry A).** Path `users/{uid}/watchlist/{titleId}`. The
  wildcards give `uid` + `titleId`; read `event.data.data()` for `{ type, tmdbId }`
  (raw fields, no converter — avoids the `addedAt` Timestamp, matching
  `firestore-io.ts`/`user-gather.ts`). `type !== 'tv'` → return without any read
  or write.
- **Daily-sync enumeration (entry B).** A `collectionGroup('watchlist')` scan with
  **no `where`/`orderBy`** (so no composite index — mirrors `gatherWatchlistTitles`
  in `firestore-io.ts` and the 0012 adapter), projecting each doc to `{ uid (=
doc.ref.parent.parent.id), titleId (= doc.ref.id), tmdbId, type }` and keeping
  only `type === 'tv'`. **Do not dedupe by `tmdbId`** — episodes are **per-user**
  (each `(uid, titleId)` has its own subcollection), so two users tracking the same
  show each get their own upsert. (This differs from the title-cache pass, which
  dedupes globally because `title-cache` is shared; flagged in Risks R5.)
- **Existing-id read + merge.** For a `(uid, titleId)`, list the episode
  subcollection doc ids (`episodesPath(uid, titleId)`) — **ids only**, the merge
  needs only `existingIds.has(episodeId)`. Never read or write the user-owned
  `watched`/`watchedAt` of an existing doc.
- **New-doc write.** For each fetched episode whose `episodeId` is **not** in
  `existingIds`, create `users/{uid}/watchlist/{titleId}/episodes/{episodeId}` with
  the decision-4 `EpisodeDoc` via `episodeToData`. Use a **batched write** (`writeBatch`,
  chunked at Firestore's 500-op limit — a long-running show can exceed 500
  episodes across seasons, see Risks R6). Existing ids are skipped, so a re-run is
  idempotent at the doc level.
- **`airDate` mismatch — VERIFY + RESOLVE (Risks R2).** `EpisodeDoc.airDate` on
  `main` is typed **`string`** (non-null), but decision 4 writes `airDate: string |
null`. The existing `episodeToData` converter does
  `airDate: new Date(ep.airDate)` (no null branch). The implementer must **either**
  (a) widen `EpisodeDoc.airDate` + `EpisodeReadData`/`EpisodeWriteData.airDate` to
  `string | null` and add the null branch to `episodeToData`/`dataToEpisode` (a
  `scope:shared` change, mirroring how `watchedAt` is handled), **or** (b) keep
  `airDate` non-null and **skip** episodes TMDB returns with no air date (matching
  the current `mapSeasonEpisodes` behavior, which drops null-air-date episodes).
  **Pick (b) for v1** — it requires **no** further `shared/` change (only the
  `Episode.title` addition), keeps the converter untouched, and matches the
  existing mapper; decision 4's `airDate: string | null` is then satisfied by
  *never inserting* a null-air-date episode rather than storing a null. State the
  choice in the README; the unit test pins it.
- **No `firestore.rules` change — VERIFY and RECORD.** The episode docs are written
  by the **Admin SDK** (both entry points run server-side as the function's
  identity), which **bypasses security rules**. The existing owner-only
  `users/{userId}/{document=**}` rule (verified present by spec 0034) already
  governs the client's read; nothing changes. **Do NOT edit `firestore.rules`.**
- **No `firestore.indexes.json` change.** Both the on-add read and the daily
  `collectionGroup('watchlist')` scan use **no `where`/`orderBy`** (the TV filter
  is in memory), so no composite/collection-group index is needed. Record "no
  index change needed." Do **NOT** edit it.

## Public types / APIs

All new public surface of the slice is exported from the barrel
`libs/functions/sync-episodes/src/index.ts`. **No mobile screen, no HTTP endpoint**
— this is a Firestore-triggered function + a daily-sync extension + a pure core
lib.

### The injected ports (`src/lib/ports.ts`, exported from the barrel)

```ts
import type { Episode, EpisodeDoc, TitleType } from '@vultus/shared/domain';

/** One TV show in a user's watchlist that needs an episode upsert. */
export interface WatchlistTvShow {
  uid: string;
  titleId: string; // the watchlist doc id
  tmdbId: number;
}

/** The minimal `{ type, tmdbId }` an on-add trigger reads from a watchlist doc. */
export interface WatchlistDocRef {
  type: TitleType;
  tmdbId: number;
}

/** Enumerates TV watchlist items (daily sync) and reads one watchlist doc (on-add).
 *  Admin-SDK-backed in apps/functions; faked in tests. Firebase-free interface. */
export interface WatchlistTvSource {
  /** Every TV show across all users' watchlists (no dedupe — episodes are per-user). */
  listAllTvShows(): Promise<WatchlistTvShow[]>;
}

/** The engine's view of TMDB. Backed in apps/functions by the sync-titles
 *  TmdbClient (getTvShow → season count; getSeasonEpisodes → episodes). The
 *  sync-episodes slice depends ONLY on this port, never on slice:sync-titles. */
export interface TmdbEpisodeSource {
  /** The show's season count, or null if the show is unknown (TMDB 404). */
  getSeasonCount(tmdbId: number): Promise<number | null>;
  /** A season's episodes (each carries season/episode/airDate/title), or null on 404. */
  getSeasonEpisodes(tmdbId: number, seasonNumber: number): Promise<Episode[] | null>;
}

/** Reads existing episode doc ids and batch-writes new episode docs.
 *  Firebase-free interface; Admin-SDK adapter in apps/functions. */
export interface EpisodeStore {
  /** The ids (e.g. `s01e003`) of episode docs that already exist for (uid, titleId). */
  getExistingEpisodeIds(uid: string, titleId: string): Promise<Set<string>>;
  /** Create new episode docs (id → EpisodeDoc) for (uid, titleId). NEVER overwrites
   *  an existing doc (the engine pre-filters; the adapter uses create/batched set). */
  writeEpisodes(
    uid: string,
    titleId: string,
    docs: { id: string; doc: EpisodeDoc }[],
  ): Promise<void>;
}
```

(The exact method set is a recommendation; an implementer **may** add a single
`getWatchlistDocRef(uid, titleId)` to `WatchlistTvSource` if the on-add adapter is
expressed through the port rather than reading the event payload directly —
**binding:** the ports stay domain-typed, Firebase-free, exported from the barrel,
and the engine never imports a Firebase SDK or `slice:sync-titles`. State the
chosen shape in the README.)

### The `Episode` entity addition (`@vultus/shared/domain`, additive — Risks R1)

`libs/shared/domain/src/lib/entities.ts` — add `title` to the `Episode` value type
so the TMDB mapper can carry the episode name through to `EpisodeDoc.title`:

```ts
export interface Episode {
  season: number;
  episode: number;
  title: string | null; // NEW (spec 0047) — episode name; null when unset
  airDate: string; // ISO 8601
}
```

This is the only `scope:shared` change. `EpisodeDoc` already has `title` (spec
0034) and is **not** modified (decision: v1 keeps `EpisodeDoc.airDate` non-null,
Data-model option (b)).

### The `sync-titles` TMDB additions (`slice:sync-titles`, additive — Risks R1)

So `apps/functions` can build the `TmdbEpisodeSource` adapter:

- `libs/functions/sync-titles/src/lib/tmdb/tmdb-dtos.ts` — add `name?: string` to
  `TmdbEpisodeEntry`; add `number_of_seasons?: number` to `TmdbTvResponse`.
- `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts` — `mapSeasonEpisodes`
  carries `title: entry.name ?? null` onto each `Episode` (it already drops
  null-air-date episodes, which v1 keeps — Data-model option (b)). Expose the
  season count: either widen `mapTvShow` to also return it (a breaking shape change
  — avoid) **or** add a small `getTvSeasonCount(tmdbId)` to the `TmdbClient` that
  reads `TmdbTvResponse.number_of_seasons` (recommended — additive, leaves
  `getTvShow`'s `TitleMetadata` return shape untouched, and the season count is the
  only field the episode engine needs). The new `getTvSeasonCount` is exported
  through the existing `sync-titles` barrel on the `TmdbClient` type.
- These changes are **purely additive** to the merged `sync-titles` surface — they
  break **no** existing export. State in the `sync-titles` README that
  `getTvSeasonCount` + `Episode.title` exist for the episode-sync consumer.

### The engine (`src/lib/engine/`, exported)

```ts
import type { Episode, EpisodeDoc } from '@vultus/shared/domain';
import type { EpisodeStore, TmdbEpisodeSource, WatchlistTvSource } from '../ports';

/** `s${SS}e${EEE}` — season padded to 2, episode padded to 3.
 *  episodeId(1, 1) === 's01e001'; episodeId(10, 100) === 's10e100'. */
export function episodeId(season: number, episode: number): string;

/** Build the EpisodeDoc written on creation (decision 4): watched:false,
 *  watchedAt:null ALWAYS; title/airDate from the TMDB Episode. */
export function newEpisodeDoc(ep: Episode): EpisodeDoc;

export interface EpisodeSyncConfig {
  tmdb: TmdbEpisodeSource;
  episodes: EpisodeStore;
  /** daily-sync enumeration; omit for the single-title (on-add) path. */
  watchlist?: WatchlistTvSource;
}

/** Per-(uid,titleId) upsert result, for diagnostics. */
export interface EpisodeUpsertResult {
  uid: string;
  titleId: string;
  tmdbId: number;
  seasonsFetched: number;
  episodesWritten: number; // new docs only
  outcome: 'synced' | 'skipped' | 'error';
  reason?: string; // credential-free
}

export interface EpisodeSyncEngine {
  /** Upsert episodes for ONE tv title (entry point A). */
  syncOne(uid: string, titleId: string, tmdbId: number): Promise<EpisodeUpsertResult>;
  /** Upsert episodes for EVERY tv watchlist item (entry point B). Requires
   *  `watchlist` in the config; per-(uid,titleId) errors are isolated. */
  syncAll(): Promise<EpisodeUpsertResult[]>;
}

export function createEpisodeSyncEngine(config: EpisodeSyncConfig): EpisodeSyncEngine;
```

`syncOne` semantics, in order:

1. `count = tmdb.getSeasonCount(tmdbId)`. `null` (TMDB 404) → `outcome: 'skipped'`,
   `reason: 'show not found in TMDB'`, no write.
2. For `season` in `1..count`: `eps = tmdb.getSeasonEpisodes(tmdbId, season)`
   (`null` → skip that season). Accumulate all fetched episodes. (TMDB "season 0"
   specials are **not** fetched in v1 — iterate `1..count`; note in Risks R7.)
3. `existing = episodes.getExistingEpisodeIds(uid, titleId)`.
4. `toWrite = fetched.filter(e => !existing.has(episodeId(e.season, e.episode)))`,
   mapped to `{ id: episodeId(...), doc: newEpisodeDoc(e) }`.
5. `episodes.writeEpisodes(uid, titleId, toWrite)` (no-op when `toWrite` empty).
6. Return the result (`episodesWritten = toWrite.length`).

`syncAll`: `shows = watchlist.listAllTvShows()`; for each, call `syncOne(uid,
titleId, tmdbId)` with **per-show error isolation** (a thrown error for one show
is caught and recorded as that show's `outcome: 'error'` without aborting the
batch — mirroring the spec-0008 per-title isolation). Returns all results.

`newEpisodeDoc` **always** sets `watched: false`, `watchedAt: null`; the engine
**never** calls `writeEpisodes` for an id already in `existing`, so user-owned
fields on existing docs are never touched.

### The deployable functions (`apps/functions`)

- **Entry point A — `apps/functions/src/sync-episodes.ts`:**
  ```ts
  import { onDocumentCreated } from 'firebase-functions/v2/firestore';

  export const syncWatchlistEpisodes = onDocumentCreated(
    'users/{uid}/watchlist/{titleId}',
    async (event) => {
      // read event.data?.data() → { type, tmdbId }; if type !== 'tv' return;
      // build the Admin-SDK adapters; createEpisodeSyncEngine({...}).syncOne(uid, titleId, tmdbId).
    },
  );
  ```
  `setGlobalOptions({ region: 'europe-west1', maxInstances: 1 })` in `main.ts`
  already applies app-wide. Export `syncWatchlistEpisodes` from `main.ts`.
- **Entry point B — daily-sync integration in `main.ts`:** after the existing
  title-cache `engine.sync(inputs)` completes in `runSync`, build the episode
  engine (with the `WatchlistTvSource` + `EpisodeStore` + `TmdbEpisodeSource`
  Admin-SDK adapters and the same `TMDB_READ_TOKEN`-credentialed `TmdbClient`) and
  run `episodeEngine.syncAll()`. The episode pass is **best-effort**: it does
  **not** change the existing `SyncRunResponse` shape or fail the HTTP response on
  a per-show episode error (counts may be added to the log line, not the response
  contract — keep `SyncRunResponse` backward-compatible; state this). Inject the
  episode engine into `runSync` via the existing `RunSyncDeps` pattern (a
  `createEpisodeEngine?: (db) => EpisodeSyncEngine` dep, defaulted in the
  `onRequest` wiring) so the existing `runSync` tests stay green and the episode
  pass is unit-testable with a fake.
- **The Admin-SDK adapters** live under `apps/functions/src` (e.g. a
  `sync-episodes-adapters.ts` or inside `sync-episodes.ts`):
  - **Naming:** the new write-capable `EpisodeStore` factory must be named
    distinctly from the existing `createFirestoreEpisodeStore` in
    `apps/functions/src/dispatch/adapters.ts` (a **read-only** episode reader for
    the dispatcher) — use `createEpisodeUpsertStore` for this new adapter.
  - `EpisodeStore`: `getExistingEpisodeIds` lists `episodesPath(uid, titleId)` doc
    ids; `writeEpisodes` batches `set` of `episodeToData(doc)` at
    `episodePath(uid, titleId, id)` (chunked at 500). Uses the spec-0005
    converter; never reads/writes existing docs' user fields.
  - `TmdbEpisodeSource`: `getSeasonCount` → sync-titles `TmdbClient.getTvSeasonCount`;
    `getSeasonEpisodes` → `TmdbClient.getSeasonEpisodes`.
  - `WatchlistTvSource.listAllTvShows`: `collectionGroup('watchlist')` scan, in-memory
    `type === 'tv'` filter, `{ uid, titleId, tmdbId }` projection (no dedupe).

### Config / secrets

The episode engine needs **no new secret**. Entry point B reuses the existing
`TMDB_READ_TOKEN` already bound to `syncTitles` (the same `TmdbClient`). Entry
point A (`onDocumentCreated`) is a separate deployed function that also needs
`TMDB_READ_TOKEN` to call TMDB — bind it via `{ secrets: [TMDB_READ_TOKEN] }` on
the trigger (the param is already declared in `main.ts`; reference the same
`defineSecret`). **No `.env.local` access, no secret read/written in the lib.**

### Slice barrel

`libs/functions/sync-episodes/src/index.ts` exports `createEpisodeSyncEngine`,
`EpisodeSyncEngine`, `EpisodeSyncConfig`, `EpisodeUpsertResult`, `episodeId`,
`newEpisodeDoc`, and the ports (`TmdbEpisodeSource`, `EpisodeStore`,
`WatchlistTvSource`, `WatchlistTvShow`, `WatchlistDocRef`).

## UI / Stitch screen refs

Not applicable. This is `scope:functions` work — a Firestore-triggered Cloud
Function + a daily-sync extension + a Firebase-free core lib, plus an additive
`scope:shared` `Episode.title` field and additive `slice:sync-titles` TMDB-layer
changes. **No mobile slice, no Stitch screen, no design-system tokens.** The UI
that renders the episodes the engine writes is spec 0034 (already merged); this
spec adds **no** UI change — the 0034 empty state ("Episodes will appear after the
next sync.") simply stops showing once episodes exist.

## Implementation task graph

The `scope:shared` `Episode.title` edit lands first (the sync-titles mapper + the
engine typecheck against it); then the additive `sync-titles` TMDB layer (the
adapter depends on `getTvSeasonCount` + `Episode.title`); then the **slice
generation** (a shared dep — the lib must exist before its files); then the
Firebase-free core (ports → engine → barrel/README → tests); then the thin
`apps/functions` wiring (both entry points, depends on the slice barrel + the
sync-titles additions). All tasks are `[sequential]` — the shared edit feeds the
mapper, the lib generation feeds the lib files, the lib files share `src/index.ts`
and the one `engine/` group (no safe parallel fan-out within one lib), and the
`apps/functions` wiring imports the slice barrel and the sync-titles barrel.
File manifests are listed per the 0008/0012 convention.

1. **[sequential] Add `title` to the `Episode` entity in `@vultus/shared/domain`
   (foundation — `scope:shared`).** backend-engineer / domain.
   - Add `title: string | null` to `Episode` in `entities.ts`; update any
     `Episode` type-assertion literal in `type-assertions.ts` if one exists.
   - Update `libs/shared/domain/README.md` if it enumerates the `Episode` fields.
   - Files: `libs/shared/domain/src/lib/entities.ts`,
     `libs/shared/domain/src/lib/type-assertions.ts` (only if an `Episode` literal
     exists there), `libs/shared/domain/README.md` (if it lists `Episode` fields).

2. **[sequential] Additive TMDB layer in `slice:sync-titles` (depends on task 1).**
   backend-engineer.
   - `tmdb-dtos.ts`: add `name?: string` to `TmdbEpisodeEntry`; add
     `number_of_seasons?: number` to `TmdbTvResponse`.
   - `tmdb-mappers.ts`: `mapSeasonEpisodes` carries `title: entry.name ?? null`
     (keeps dropping null-air-date episodes — Data-model option (b)).
   - `tmdb-client.ts`: add `getTvSeasonCount(tmdbId): Promise<number | null>` to
     `TmdbClient` (reads `TmdbTvResponse.number_of_seasons`; 404 → null), exported
     through the barrel via the `TmdbClient` type. Do **not** change `getTvShow`'s
     `TitleMetadata` return shape.
   - Extend the TMDB mapper/client unit tests for `title` + the season count.
   - Update `libs/functions/sync-titles/README.md`: `getTvSeasonCount` +
     `Episode.title` exist for the episode-sync consumer.
   - Files: `libs/functions/sync-titles/src/lib/tmdb/tmdb-dtos.ts`,
     `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts`,
     `libs/functions/sync-titles/src/lib/tmdb/tmdb-client.ts`,
     `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.spec.ts` (+ the client
     spec if it asserts the season call), `libs/functions/sync-titles/README.md`.

3. **[sequential] Generate the slice lib (`functions-sync-episodes`).**
   infrastructure-engineer. (shared dep — the lib must exist before its files.)
   - Run, from the worktree root (PowerShell), mirroring the merged `sync-titles` /
     `dispatch-notifications` generator config (inspect their `project.json` /
     `vite.config.ts` first):
     ```powershell
     pnpm nx generate @nx/js:library sync-episodes `
       --directory=libs/functions/sync-episodes `
       --importPath=@vultus/functions/sync-episodes `
       --unitTestRunner=vitest --bundler=none --linter=eslint
     ```
     (No `--tags` flag — tagging is by path glob; `project.json` keeps `"tags": []`.)
   - Confirm `project.json` keeps `"tags": []`; verify the source lives under
     `libs/functions/sync-episodes/src` so the `'libs/functions/<slice>/src'` glob
     resolves `scope:functions` + `slice:sync-episodes`; verify the
     `@vultus/functions/sync-episodes` → `…/src/index.ts` path alias was added to
     `tsconfig.base.json`. Delete the generator's scaffold sample file/spec.
   - Files: `libs/functions/sync-episodes/project.json`,
     `libs/functions/sync-episodes/tsconfig*.json`,
     `libs/functions/sync-episodes/vite.config.ts` (or whatever matches the existing
     functions libs), root `tsconfig.base.json` (path alias). **No `sheriff.config.ts`
     edit.**

4. **[sequential] Ports + engine + helpers + barrel + README (depends on tasks 1–3).**
   backend-engineer.
   - `src/lib/ports.ts` — `TmdbEpisodeSource`, `EpisodeStore`, `WatchlistTvSource`,
     `WatchlistTvShow`, `WatchlistDocRef` (domain-typed, Firebase-free).
   - `src/lib/engine/episode-id.ts` — `episodeId(season, episode)` (the `s${SS}e${EEE}`
     padding) + `newEpisodeDoc(ep)` (decision 4; `watched:false`, `watchedAt:null`).
   - `src/lib/engine/episode-sync-engine.ts` — `createEpisodeSyncEngine(config)`
     with `syncOne` + `syncAll` per the semantics (season iteration → fetch →
     existing-id read → insert-only filter → batched write → per-show error
     isolation → `EpisodeUpsertResult[]`).
   - `src/index.ts` — barrel exporting the Public types / APIs surface.
   - `README.md` — what the lib is, its barrel surface, the port/adapter design
     (SDK + the sync-titles `TmdbClient` wiring enter only in `apps/functions`; the
     core never imports `slice:sync-titles`), decisions 1–4 + 6–7 (two entry
     points / id format / insert-only never-overwrite / TV-only / the `airDate`
     null-skip choice), and the Sheriff tags `scope:functions` + `slice:sync-episodes`.
     **No Nx scaffold text.**
   - Files: `libs/functions/sync-episodes/src/lib/ports.ts`,
     `libs/functions/sync-episodes/src/lib/engine/episode-id.ts`,
     `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts`,
     `libs/functions/sync-episodes/src/index.ts`,
     `libs/functions/sync-episodes/README.md`.

5. **[sequential] Unit tests for the core (depends on task 4).** backend-engineer /
   qa-runner.
   - `episode-id.spec.ts` (padding edge cases) + `episode-sync-engine.spec.ts`
     (fakes + fixed clock) per the Test plan.
   - Files: `libs/functions/sync-episodes/src/lib/engine/episode-id.spec.ts`,
     `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.spec.ts`.

6. **[sequential] Admin-SDK adapters + the on-add trigger + the daily-sync
   integration (`apps/functions`). Depends on tasks 2–4** (imports both the
   sync-episodes and sync-titles barrels). backend-engineer.
   - `apps/functions/src/sync-episodes.ts` — the `onDocumentCreated('users/{uid}/watchlist/{titleId}', …)`
     trigger (entry A; `type !== 'tv'` → no-op) + the Admin-SDK port adapters
     (`EpisodeStore` over `episodesPath`/`episodePath` + `episodeToData`;
     `TmdbEpisodeSource` over the sync-titles `TmdbClient`; `WatchlistTvSource`
     over `collectionGroup('watchlist')`). Bind `{ secrets: [TMDB_READ_TOKEN] }`.
   - `apps/functions/src/main.ts` — after the existing title-cache pass in
     `runSync`, run `episodeEngine.syncAll()` (entry B), injected via a new
     `createEpisodeEngine?` dep on `RunSyncDeps` (defaulted in the `onRequest`
     wiring) so existing `runSync` tests stay green and `SyncRunResponse` is
     unchanged; export `syncWatchlistEpisodes` from `main.ts` alongside the existing
     functions.
   - Unit tests: the on-add handler no-ops on a movie doc and calls `syncOne` on a
     tv doc; the daily-sync pass calls `syncAll` after the title-cache pass and
     does not alter the existing `SyncRunResponse`; the `EpisodeStore` adapter
     batches new docs and never overwrites an existing id (fake `db`).
   - If `apps/functions/README.md` exists, mention the new trigger; do not invent one.
   - Files: `apps/functions/src/sync-episodes.ts`,
     `apps/functions/src/sync-episodes.spec.ts` (and/or adapter specs),
     `apps/functions/src/main.ts`, `apps/functions/src/main.spec.ts` (extend).

(`firebase-admin` / `firebase-functions` are already root deps — no new runtime
dependency; verify before assuming. Symbol/file names are recommendations; the
binding contracts are the two entry points sharing one Firebase-free engine, the
`s${SS}e${EEE}` id, the **insert-only / never-overwrite** merge, the TV-only skip,
and the no-SDK-in-core / no-`slice:sync-titles`-import guardrails.)

## Test plan

Per the PLAN §5 pyramid — backend logic, so the surface is **unit tests** with
fakes/mocks. **No component, no e2e** (no UI flow — the episode e2e flows already
exist as `test.fixme` in spec 0034; un-skipping them + adding emulator seed data
is out of scope). **No emulator** (the Firestore emulator cannot run under Claude
Code tools — project memory; the engine is proven with fakes, the design's point).

**`episode-id.spec.ts`:**

- `episodeId(1, 1) === 's01e001'`; `episodeId(1, 10) === 's01e010'`;
  `episodeId(2, 1) === 's02e001'`; `episodeId(10, 1) === 's10e001'`;
  `episodeId(10, 100) === 's10e100'`; `episodeId(1, 100) === 's01e100'`.
- `newEpisodeDoc(ep)` sets `watched: false`, `watchedAt: null` **always**, and
  carries `season`/`episode`/`title`/`airDate` from the input `Episode`.

**`episode-sync-engine.spec.ts` (fake `TmdbEpisodeSource` / `EpisodeStore` /
`WatchlistTvSource` + fixed clock):**

- **Fresh show, no existing episodes:** `getSeasonCount` → 2, two seasons of
  episodes fetched, `getExistingEpisodeIds` → empty → `writeEpisodes` called with
  **every** episode as a new doc; each written doc has `watched: false`,
  `watchedAt: null`, correct `id` (`s01e001` …), `title`, `airDate`.
- **Partial existing — insert only the missing:** `getExistingEpisodeIds` returns
  `{s01e001, s01e002}`; fetched season 1 has `e001..e003` → `writeEpisodes`
  receives **only** `s01e003`. (The merge filter is the centerpiece.)
- **Existing docs never overwritten:** for an id already present, the engine does
  **not** include it in the `writeEpisodes` payload — assert the fake store's
  write list excludes existing ids, so `watched`/`watchedAt` of existing docs are
  untouched. (The load-bearing user-data-safety property.)
- **All episodes already present → no write:** `toWrite` empty → `writeEpisodes`
  not called (or called with `[]` — pick one and assert it); `episodesWritten: 0`.
- **Show not found (TMDB 404):** `getSeasonCount` → null → `outcome: 'skipped'`,
  no read, no write.
- **Null season fetch:** `getSeasonEpisodes` returns null for one season of N →
  that season contributes no episodes; other seasons still upsert.
- **Null air date skipped (Data-model option b):** an `Episode` with no air date
  is not produced by the mapper (it drops them); assert the engine writes only
  episodes the source returns (the mapper-level drop is covered in task 2's mapper
  spec — the engine test asserts it writes exactly what the fake source returns).
- **`syncAll` over a fake `WatchlistTvSource`:** 3 TV shows (across 2 uids, incl.
  two users tracking the **same** `tmdbId`) → `syncOne` runs **per (uid, titleId)**
  (not deduped by `tmdbId`), each user's subcollection upserted independently;
  `EpisodeUpsertResult[]` has one entry per show.
- **Per-show error isolation:** a `getSeasonEpisodes` (or `writeEpisodes`) that
  **throws** for the middle of three shows → that show's result is
  `outcome: 'error'`, the other two complete `synced`, and `syncAll` does not reject.
- **Clock determinism:** `newEpisodeDoc` does not stamp a time (creation fields are
  fixed `watched:false`/`watchedAt:null`), so the engine is deterministic without a
  clock; assert no `watchedAt` is ever set to a non-null value.

**TMDB mapper additions (`tmdb-mappers.spec.ts`, task 2):**

- `mapSeasonEpisodes` carries `title: entry.name ?? null` (a present `name`, and a
  missing `name` → `null`); still drops episodes with a null/empty `air_date`.
- `getTvSeasonCount` reads `number_of_seasons` (and 404 → null) — in the client spec.

**Handler / daily-sync wiring (`apps/functions`, fake `db`/`event`):**

- The `onDocumentCreated` handler **no-ops** on a `type: 'movie'` doc (no engine
  call) and calls `syncOne(uid, titleId, tmdbId)` on a `type: 'tv'` doc.
- The daily-sync pass calls `episodeEngine.syncAll()` **after** the title-cache
  `engine.sync(inputs)` and does **not** change the returned `SyncRunResponse`
  (existing `runSync`/`main` tests stay green).
- The `EpisodeStore` adapter batches new docs and **never** issues a write for an
  existing id (fake `db` records only new-id sets).

Component tests: **none** (no UI). e2e / emulator tests: **none added** — the
episode e2e flows are the existing spec-0034 `test.fixme` stubs; un-skipping them
+ adding episode emulator seed data is out of scope (the emulator cannot run under
Claude Code tools, and seeding is a later step).

## Definition of done

Tailored from the PLAN §5 checklist to the projects touched. No component/e2e (no
UI). `<lib>` = `functions-sync-episodes`; touched shared lib is `shared-domain`;
also-touched slice is `functions-sync-titles`; the app is `functions`.

- [ ] `pnpm nx typecheck functions-sync-episodes` passes — the engine + ports
      compile against `EpisodeDoc` + the new `Episode.title`.
- [ ] `pnpm nx typecheck shared-domain` passes — the additive `Episode.title`
      compiles (and any `type-assertions.ts` literal updated).
- [ ] `pnpm nx typecheck functions-sync-titles` passes — `getTvSeasonCount` +
      the `name`/`number_of_seasons` DTO fields + the mapper `title` compile;
      **no existing export dropped**.
- [ ] `pnpm nx typecheck functions` passes — the on-add trigger + adapters + the
      daily-sync integration + `main.ts` exports compile.
- [ ] `pnpm nx lint functions-sync-episodes` passes **with Sheriff active**: the
      lib imports only `@vultus/shared/domain` (and optionally
      `@vultus/shared/firestore-schema`) — **no** `scope:mobile`, **no other slice
      (critically NOT `slice:sync-titles`)**, and **no**
      `firebase-admin`/`firebase-functions`. Verified by code review of the diff +
      SDK-free tests passing with fakes.
- [ ] `pnpm nx lint functions` passes with Sheriff: `apps/functions` imports
      `@vultus/functions/sync-episodes` + `@vultus/functions/sync-titles` +
      `@vultus/shared/*` + Firebase packages only; **no `scope:mobile`**; the
      existing `syncTitles` / `triggerSync` / `dispatchNotifications` still present
      and unchanged in behavior.
- [ ] `pnpm nx lint functions-sync-titles` and `pnpm nx lint shared-domain` pass
      (still Firebase-free; `scope:shared → scope:shared`; `sync-titles` boundaries
      unchanged).
- [ ] `pnpm nx test functions-sync-episodes` passes — `episodeId` padding + the
      insert-only merge + never-overwrite + TV-only + season-iteration +
      per-show error isolation unit tests green (fakes; no Firebase, no network,
      no secrets).
- [ ] `pnpm nx test functions-sync-titles` passes — the new mapper `title` + the
      `getTvSeasonCount` tests green; the existing TMDB tests still pass.
- [ ] `pnpm nx test functions` passes — the on-add no-op-on-movie / call-on-tv,
      the daily-sync `syncAll`-after-title-cache, and the `EpisodeStore` never-
      overwrite adapter tests green; **the existing `runSync` / `main` tests still
      pass** and `SyncRunResponse` is unchanged.
- [ ] `pnpm nx build functions` passes — the deployable barrel builds with
      `syncWatchlistEpisodes` exported alongside the existing functions.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green (the
      affected set is `functions-sync-episodes` + `functions` +
      `functions-sync-titles` + `shared-domain` and any dependents).
- [ ] The new lib's source path matches the `sheriff.config.ts`
      `libs/functions/<slice>/src` glob (Sheriff resolves `scope:functions` +
      `slice:sync-episodes`); `project.json` keeps `"tags": []`; the
      `@vultus/functions/sync-episodes` alias resolves. **No `sheriff.config.ts`
      edit.**
- [ ] The barrel `@vultus/functions/sync-episodes` exports the full surface in
      Public types / APIs; the Admin-SDK adapter details stay in `apps/functions`
      (unexported from the lib).
- [ ] `libs/functions/sync-episodes/README.md` is **complete** (not Nx scaffold
      text): the lib, its barrel surface, the port/adapter design + the two entry
      points, the `s${SS}e${EEE}` id, the insert-only/never-overwrite merge, the
      TV-only skip, the `airDate` null-skip choice, and the Sheriff tags.
      `sync-titles` + `shared/domain` READMEs updated for the additive surface.
- [ ] **Boundary verifications (review-checked, like 0008/0012):** (a) **no secret
      is read or written** in the lib — entry B reuses the existing
      `TMDB_READ_TOKEN`, entry A binds the same param, no `.env.local`; (b) **the
      only writes are NEW `users/{uid}/watchlist/{titleId}/episodes/{episodeId}`
      docs** — **no** overwrite of an existing episode doc (so `watched`/`watchedAt`
      are never touched), **no** `title-cache` write, **no** notification write;
      (c) **the core lib imports no Firebase SDK and NOT `slice:sync-titles`** — the
      SDK + the sync-titles `TmdbClient` wiring live only in `apps/functions`; (d)
      **no `firestore.rules` / `firestore.indexes.json` change** (Admin SDK bypasses
      rules; the gathers use no `where`/`orderBy`); (e) the daily-sync episode pass
      is **per-user** (not deduped by tmdbId) and **best-effort** (does not alter
      `SyncRunResponse`).
- [ ] PR description records the exact verification commands (all four projects),
      confirms the no-secret / writes-only-new-episode-docs / never-overwrite /
      no-SDK-in-core / no-`slice:sync-titles`-import boundaries, notes that
      emulator-backed verification + un-skipping the 0034 e2e flows are out of scope
      (emulator cannot run under Claude Code tools; episode seed data is a later
      step), and confirms `SyncRunResponse` + the existing functions are unchanged.

## Risks

- **R1 — The TMDB layer does NOT carry the episode name today (decision-record
  claim "no shared/domain changes needed" does not hold against `main`).** Verified:
  the `Episode` entity (`libs/shared/domain/src/lib/entities.ts`) is `{ season,
episode, airDate }` with **no `title`/`name`**; `TmdbEpisodeEntry`
  (`tmdb-dtos.ts`) has no `name`; `mapSeasonEpisodes` (`tmdb-mappers.ts`) does not
  carry a title. To write `EpisodeDoc.title` (decision 4), this spec adds
  `Episode.title` (`scope:shared`, additive) + `TmdbEpisodeEntry.name` + the
  mapper carry (`slice:sync-titles`, additive). These are small and additive — no
  existing export drops — but they **are** required, contrary to the brief. Flagged
  so the implementer scopes tasks 1–2 rather than assuming the data already flows.
- **R2 — No show season count + `EpisodeDoc.airDate` is non-null.** Verified:
  `getTvShow` returns `TitleMetadata` (`{ title, overview, posterPath, releaseDate }`)
  — **no `number_of_seasons`**, so the engine cannot iterate seasons without an
  additive `getTvSeasonCount` (task 2). And `EpisodeDoc.airDate` on `main` is typed
  **`string`** (non-null) with `episodeToData` doing `new Date(ep.airDate)` (no null
  branch), while decision 4 writes `airDate: string | null`. **Resolution (v1):
  option (b)** — keep `airDate` non-null and **skip** TMDB episodes with no air date
  (matching the existing `mapSeasonEpisodes` drop), so no further `shared/` /
  converter change beyond `Episode.title` is needed. The alternative (widen
  `airDate` to nullable) is the upgrade path if "announced but undated" episodes
  must appear. Stated so the implementer does not write a null `airDate` against a
  non-null type.
- **R3 — `watched`/`watchedAt` are user data and must NEVER be overwritten
  (decisions 3–4).** The whole correctness of the merge is "insert only ids not
  already present." A bug that re-writes an existing doc (e.g. `set` without the
  pre-filter, or a `set` with merge that resets `watched`) would silently destroy a
  user's watch progress (spec 0034). **Guarded by the never-overwrite unit test**
  (the fake store asserts the write list excludes existing ids) and the adapter's
  create/pre-filtered-set. The load-bearing safety property; called out as the
  primary review focus.
- **R4 — Do NOT import `slice:sync-titles` from `slice:sync-episodes`.** The engine
  needs TMDB season/episode data that the sync-titles `TmdbClient` already fetches,
  but importing `@vultus/functions/sync-titles` inside `libs/functions/sync-episodes`
  is a Sheriff-forbidden cross-slice edge (rule 2, `'slice:*': ['scope:shared',
sameTag]`). The engine speaks the `TmdbEpisodeSource` **port**; `apps/functions`
  (which may import both functions slices — rule 3) wires the adapter that delegates
  to the sync-titles client. Stated so the implementer does not "just import the
  client."
- **R5 — Episodes are PER-USER; the daily pass must NOT dedupe by `tmdbId`.** The
  title-cache pass (`runSync` → `dedupeTitles`) syncs the **global** union once
  because `title-cache` is shared. Episode subcollections are **per `(uid,
titleId)`**, so the episode pass must enumerate **every** `(uid, titleId, tmdbId)`
  TV item (no dedupe) — two users tracking the same show each get their own upsert.
  Reusing the deduped `distinct` list from `runSync` would write episodes for only
  one arbitrary user. Guarded by the `syncAll` multi-user test. Flagged as an easy
  mistake given the adjacent deduped title-cache code.
- **R6 — Batched writes + the 500-op Firestore limit.** A long-running show can
  have hundreds of episodes across seasons; on first add, `toWrite` may exceed
  Firestore's 500-op batch limit. The adapter must **chunk** the batch at 500.
  Subsequent runs write only the (few) new episodes, so this only bites on the
  initial add of a large back-catalogue show. Noted; chunk in the adapter.
- **R7 — Specials (TMDB "season 0") are not synced in v1.** The engine iterates
  `1..number_of_seasons`; TMDB exposes specials as season 0, which `number_of_seasons`
  excludes. v1 deliberately skips specials (consistent with most trackers). If
  specials are wanted later, fetch season 0 explicitly — out of scope. Noted.
- **R8 — Episode-number overflow of the `s${SS}e${EEE}` id.** The 3-digit episode
  pad assumes < 1000 episodes per season (true for every real show). Padding is a
  **minimum width, not a cap**: an episode 1000 produces `s01e1000` (4 digits),
  which is unique and correct but loses lexical sort order. This is acceptable for
  v1 since there are no known shows with 1000+ episodes per season. Noted for
  completeness.
- **R9 — Best-effort daily pass; `SyncRunResponse` unchanged.** The episode pass
  runs after the title-cache pass and must not fail the HTTP sync response or change
  its JSON contract (the daily-sync cron + the manual `triggerSync` callers depend
  on it). Per-show episode errors are isolated and logged, not surfaced in
  `SyncRunResponse`. Guarded by the `main` test asserting the response is unchanged.
- **R10 — No PLAN conflict.** This implements the episode-write half of the data
  model PLAN §4 declares (`users/{uid}/watchlist/{titleId}/episodes/{episodeId}` —
  "tv only") that spec 0034 deferred to "a future `scope:functions` spec." It uses
  the existing PLAN §4 path, the spec-0005 `episodeToData` converter + `episodesPath`/
  `episodePath` helpers, the spec-0006 TMDB client, and the spec-0008/0012
  port/adapter pattern. The lone `shared/domain` addition (`Episode.title`) follows
  the spec-0003/0005 contract (a persisted/mapped field's source of truth is the
  domain lib). The deferrals (episode deletion, specials, movie episodes, e2e
  un-skip, nullable `airDate`) are explicit v1 product/scope calls, not conflicts.
