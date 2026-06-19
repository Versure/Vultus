---
number: 0008
slug: sync-engine
title: Add the title-cache sync engine to the sync-titles functions slice
status: done
slices: [slice:sync-titles]
scopes: [scope:functions, scope:shared]
created: 2026-06-19
---

# Add the title-cache sync engine to the sync-titles functions slice

## Context

PLAN §6 item 11 calls for the **sync engine** in `functions/sync-titles`:
orchestrate the TMDB + Trakt clients, **compute availability transitions against
`previousSnapshot`**, and persist to `title-cache`. This spec is the **third and
final part** of the three-way split of the `sync-titles` slice. Spec 0006
(merged, `done`) delivered the typed **TMDB client**; spec 0007 (merged, `done`)
delivered the typed **Trakt calendar client**. Both only fetch and map — they
persist nothing and detect no transitions. This spec adds the orchestration +
transition-detection layer that consumes them.

It is the **engine only** (PLAN §6 item 11). The **HTTP/callable function** that
wraps the engine — shared-secret auth, rate-limiting, idempotency key, gathering
the tracked tmdbIds from the watchlist, `apps/functions` wiring, and deploy
(PLAN §6 item 12) — is **explicitly deferred to a separate follow-on spec**. So
is the **notification dispatch** (PLAN §6 item 14, the `dispatch-notifications`
slice), which is triggered by the availability writes the engine makes, not
performed by the engine. This spec is therefore a **pure, Firebase-free,
unit-testable orchestration library**: a factory `createSyncEngine(config)` that
takes injected clients + an injected persistence port + an injected clock, runs
one sync pass over a caller-supplied list of titles, computes per-region
transitions, writes through the port, and returns a structured per-title result.

The engine stays **Firebase-free** exactly like the clients (which inject
`fetch`) and `shared/firestore-schema` (which is SDK-agnostic): it imports **no**
`firebase-admin` / `@google-cloud/firestore`. It speaks `@vultus/shared/domain`
types and writes through an **injected `TitleCacheStore` port**. The real
Admin-SDK adapter that implements that port — and any emulator-backed
verification — is the **#12 HTTP-function spec's** thin wiring job. (The
environment cannot run the Firestore emulator under Claude Code tools anyway; the
gate here is **unit tests with a fake in-memory store**, no emulator.)

Intended outcome: an agent implementing the #12 HTTP function can
`import { createSyncEngine } from '@vultus/functions/sync-titles'`, construct it
with a `TmdbClient`, a `TraktClient`, an Admin-SDK-backed `TitleCacheStore`, and
a clock, hand it the tracked `{ tmdbId, type }[]`, and get back a per-title
`SyncResult[]` describing what was written and which availability transitions
were detected — without the engine ever touching HTTP, secrets, or Firestore
itself.

## Scope

In scope:

- **A sync engine** in the existing `libs/functions/sync-titles` lib, exposed via
  a factory `createSyncEngine(config)` returning an object with **one method**:
  `sync(titles): Promise<SyncResult[]>`. It lives in a **new in-slice group**
  `src/lib/engine/` (alongside the existing `tmdb/`, `trakt/`, `shared/`
  groups), behind the single `src/index.ts` barrel.
- **An injected persistence port** `TitleCacheStore` — a small slice-internal
  interface the engine calls to (a) read the stored `TitleCacheEntry` +
  per-region `RegionAvailability` for a tmdbId, and (b) write the refreshed
  `TitleCacheEntry` and per-region `RegionAvailability`. Defined in **domain
  terms** (`@vultus/shared/domain` types). **Slice-internal, exported from the
  barrel** so #12 can implement it with an Admin-SDK adapter. The engine imports
  **no** `firebase-admin`/SDK.
- **Injected clients + clock.** The factory config takes a `TmdbClient`, a
  `TraktClient` (or the relevant method subset), the `TitleCacheStore`, and an
  optional `now?: () => string` clock (default
  `() => new Date().toISOString()`) so `lastSyncedAt` and transition timestamps
  are deterministic in tests. All dependencies are injected — mirroring the
  client factories.
- **One sync pass = metadata + per-region availability transition detection.**
  For each caller-supplied `{ tmdbId, type }`: fetch TMDB metadata
  (`getMovie`/`getTvShow` by `type`) → build/refresh the `TitleCacheEntry`;
  fetch `getWatchProviders(tmdbId, type)` → for each returned region, **compute
  the transition vs the stored `previousSnapshot`/current providers** and write
  the updated `RegionAvailability`.
- **Trakt id resolution for tv titles only.** For `type === 'tv'`, call
  `getShowTraktId(tmdbId)` and store the result on `TitleCacheEntry.traktId`. For
  `type === 'movie'`, **`traktId` stays `null`** and `getShowTraktId` is **not
  called** (movies have no Trakt show-calendar role).
- **A `traktId` field added to `TitleCacheEntry`** in `@vultus/shared/domain`,
  flowing through `@vultus/shared/firestore-schema`'s `TitleCacheReadData` /
  `TitleCacheWriteData` and converters as a non-timestamp passthrough (decision 4
  below). These two `scope:shared` edits are **sequential foundation tasks** that
  land before the engine code.
- **A structured per-title `SyncResult`** (success / skip / error + the detected
  transitions), returned as `SyncResult[]` for diagnostics and so #12 can surface
  the outcome.
- **Per-title error isolation**: a thrown `TmdbError`/`TraktError` (or any error)
  for one title is **caught and recorded as that title's error result** without
  aborting the batch.
- **Pure Vitest unit tests** with mocked `TmdbClient`/`TraktClient`, a fake
  in-memory `TitleCacheStore`, and an injected clock. No live network, no
  emulator, no secrets. Plus extending the firestore-schema round-trip test to
  cover the new `traktId` field.

Out of scope (each belongs to a later spec or another slice):

- **The HTTP / callable function (PLAN §6 item 12).** No `firebase-functions`
  HTTP/callable handler, no shared-secret auth, no rate-limiting, no idempotency
  key, no scheduled trigger, no `apps/functions` wiring, no deploy. The engine is
  a library only.
- **Gathering the tracked tmdbIds.** The engine takes the title list as **input**
  — it does **not** read the user's watchlist (that is #12's job, querying
  `users/{userId}/watchlist`).
- **Notification dispatch (PLAN §6 item 14).** The engine **does NOT write
  notifications** (`users/{userId}/notifications/*`). It only refreshes
  `title-cache`; the `dispatch-notifications` slice reacts to the availability
  write. Stated as a hard boundary.
- **Episode / calendar sync.** `title-cache` has **no episode storage** (episodes
  are per-user under `users/{userId}/watchlist/{titleId}/episodes/*`). The Trakt
  calendar (`getCalendar`) and `getSeasonEpisodes` are **not** used by this
  engine; episode-aired detection is #12/#14's concern with per-user data. This
  engine uses Trakt **only** for `getShowTraktId`.
- **Secret / config provisioning.** No `.env.local`/env/`firebase-functions`
  config access. The clients (already credentialed by their own factories) and
  the store are injected.
- **A Watchmode fallback** for NL accuracy (PLAN §9) — a later, separate concern.
  The engine faithfully writes whatever TMDB returns.
- **Any `firebase` / `firebase-admin` / `@google-cloud/firestore` import in the
  engine.** The Admin-SDK `TitleCacheStore` adapter is #12's thin wiring layer.

## Affected slices & Sheriff tags

| Project                        | Path                           | Sheriff tags                           |
| ------------------------------ | ------------------------------ | -------------------------------------- |
| functions-sync-titles          | `libs/functions/sync-titles`   | `scope:functions`, `slice:sync-titles` |
| shared domain (edit)           | `libs/shared/domain`           | `scope:shared`                         |
| shared firestore-schema (edit) | `libs/shared/firestore-schema` | `scope:shared`                         |

- `functions-sync-titles` **already exists** (spec 0006) and is tagged
  `scope:functions` + `slice:sync-titles` **automatically by
  `sheriff.config.ts`** via the path-glob `'libs/functions/<slice>'`. This spec
  **does not edit `sheriff.config.ts`** and **does not add a path alias** — the
  `@vultus/functions/sync-titles` → `…/src/index.ts` entry already exists.
- **Import boundaries (verified against `sheriff.config.ts`):**
  - The engine imports `@vultus/shared/domain` (`TitleType`, `Region`,
    `WatchProvider`, `TitleMetadata`, `TitleCacheEntry`, `RegionAvailability`,
    `REGIONS`) and **MAY** import `@vultus/shared/firestore-schema` **only** for
    PLAN §4 path/type vocabulary **if the `TitleCacheStore` port is expressed in
    terms of it** — but the **recommended** design keeps the port in pure domain
    terms, so the engine likely imports only `@vultus/shared/domain`. The
    `scope:functions → scope:shared` rule (`'scope:functions': ['scope:shared',
'scope:functions']`) permits both. The same-slice import of the existing TMDB
    / Trakt client types within `libs/functions/sync-titles` is in-slice (no
    boundary crossed).
  - The engine must **NOT** import `scope:mobile`, any other slice, or
    `firebase-admin`/`@google-cloud/firestore`/`firebase-functions`. (Sheriff
    governs only `scope:`/`slice:` boundaries between **workspace** projects — it
    does **not** police the third-party `firebase-admin` import, which is a root
    dep and would resolve; like spec 0005, the **no-SDK constraint is verified by
    code review of the diff + the SDK-free unit tests** that pass with a fake
    store. A reviewer should flag any such import.)
  - `shared/domain` and `shared/firestore-schema` keep their existing
    Firebase-free constraints (spec 0003 / 0005); the `traktId` edits add no SDK
    import.
- **Not a premature `shared/` extraction.** The engine, the `TitleCacheStore`
  port, the transition-detection logic, and `SyncResult` all stay **inside
  `libs/functions/sync-titles`** (the new `src/lib/engine/` group). There is
  still exactly **one** consuming slice, so the "extract only at 3+ slices" rule
  is respected — nothing is hoisted to `shared/`. The `traktId` field is the only
  `shared/` change, and it is a domain-vocabulary addition (the source of truth
  for a persisted field per the spec-0003/0005 contract), not a slice extraction.

## Data model touchpoints

The engine **writes** to the PLAN §4 `title-cache` collection **through the
injected `TitleCacheStore` port** (the port's Admin-SDK implementation, which
actually calls Firestore, is #12). The shapes written are exactly spec 0005's:

| PLAN §4 path                                 | Domain type          | Written by the engine                                                                                |
| -------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `title-cache/{tmdbId}`                       | `TitleCacheEntry`    | `{ type, metadata, traktId, lastSyncedAt }` — refreshed metadata + (tv) resolved `traktId` + `now()` |
| `title-cache/{tmdbId}/availability/{region}` | `RegionAvailability` | `{ providers, previousSnapshot, lastSyncedAt }` — new providers, rolled snapshot, `now()`            |

**Domain change (decision 4):** add `traktId: number | null` to
**`TitleCacheEntry`** in `libs/shared/domain/src/lib/documents.ts`. This forces a
matching `shared/firestore-schema` change: `TitleCacheReadData` /
`TitleCacheWriteData` gain `traktId: number | null` (a plain **non-timestamp**
field that passes straight through `titleCacheToData` / `dataToTitleCache`
unchanged — like `type`), and the firestore-schema round-trip test for
`TitleCacheEntry` gains `traktId` coverage. See Public types / APIs and decision 4.

No new collections, indexes, or security rules are created. The
`previousSnapshot` field on `RegionAvailability` already exists (spec 0003/0005)
precisely for this transition model; this engine is its first writer. The store
port **reads and writes by `tmdbId` and `Region`** — the exact keys of
`titleCacheDocPath(tmdbId)` / `availabilityDocPath(tmdbId, region)` — so the #12
adapter is a thin map onto those path builders + the spec-0005 converters.

## Public types / APIs

All new public surface is exported through the existing barrel
`libs/functions/sync-titles/src/index.ts`. **No new path alias.** The barrel must
continue to export the full 0006 + 0007 surface — `createTmdbClient`,
`TmdbClientConfig`, `TmdbClient`, `RegionProviders`, `TmdbError`,
`createTraktClient`, `TraktClientConfig`, `TraktClient`, `TraktCalendarEntry`,
`TraktError` — **and** add the engine surface below. **None of the existing
exports may be dropped.**

### The persistence port (slice-internal, exported from the barrel)

```ts
import type {
  Region,
  RegionAvailability,
  TitleCacheEntry,
} from '@vultus/shared/domain';

/** Persistence boundary the engine writes through. Implemented by the #12
 *  HTTP-function spec with an Admin-SDK adapter (titleCacheDocPath /
 *  availabilityDocPath + the spec-0005 converters). The engine speaks only
 *  domain types and NEVER imports a Firebase SDK. All methods key on tmdbId /
 *  Region — the same keys as the PLAN §4 paths. */
export interface TitleCacheStore {
  /** Current cached entry for a title, or null if never synced. */
  getEntry(tmdbId: number): Promise<TitleCacheEntry | null>;
  /** Current per-region availability for a title; a region absent from the map
   *  means "never synced for that region". */
  getAvailability(
    tmdbId: number,
  ): Promise<Partial<Record<Region, RegionAvailability>>>;
  /** Write (create or overwrite) the title's cache entry. */
  putEntry(tmdbId: number, entry: TitleCacheEntry): Promise<void>;
  /** Write (create or overwrite) one region's availability for the title. */
  putAvailability(
    tmdbId: number,
    region: Region,
    availability: RegionAvailability,
  ): Promise<void>;
}
```

(The exact method set is a recommendation; an implementer **may** consolidate
`getEntry`/`getAvailability` into one `read(tmdbId)` and `putEntry`/
`putAvailability` into one `write(tmdbId, entry, availabilityByRegion)` **so long
as** the port stays domain-typed, Firebase-free, keys on `tmdbId`/`Region`, and
is exported from the barrel for #12 to implement. State the chosen shape in the
README.)

### Config + factory

```ts
import type { TitleType } from '@vultus/shared/domain';
import type { TmdbClient } from './lib/tmdb/tmdb-client';
import type { TraktClient } from './lib/trakt/trakt-client';

/** One title to sync. The engine does NOT know the watchlist — the caller (#12)
 *  supplies the tracked titles. */
export interface SyncTitleInput {
  tmdbId: number;
  type: TitleType;
}

export interface SyncEngineConfig {
  tmdb: TmdbClient; // or the method subset getMovie/getTvShow/getWatchProviders
  trakt: TraktClient; // or the method subset getShowTraktId
  store: TitleCacheStore;
  /** Injectable clock for deterministic `lastSyncedAt`. Default
   *  `() => new Date().toISOString()`. */
  now?: () => string;
}

export interface SyncEngine {
  /** Run one sync pass over the supplied titles. Per-title failures are
   *  isolated — one title's error never aborts the batch. */
  sync(titles: SyncTitleInput[]): Promise<SyncResult[]>;
}

export function createSyncEngine(config: SyncEngineConfig): SyncEngine;
```

(A class implementing the same surface is an acceptable alternative, provided its
constructor takes the same `SyncEngineConfig` with the injected clients, store,
and clock, and the barrel exports it. The factory form is recommended, matching
`createTmdbClient` / `createTraktClient`.)

### Per-title result + transition types (slice-internal, exported)

```ts
import type { Region, WatchProviderType } from '@vultus/shared/domain';

/** One provider's change in one region during a sync pass. */
export interface ProviderTransition {
  region: Region;
  providerId: number;
  name: string;
  type: WatchProviderType;
  /** 'added'  = present now, absent in previousSnapshot (newly available);
   *  'removed' = absent now, present in previousSnapshot (gone). */
  kind: 'added' | 'removed';
}

export type SyncOutcome = 'synced' | 'skipped' | 'error';

export interface SyncResult {
  tmdbId: number;
  type: TitleType;
  outcome: SyncOutcome;
  /** Region transitions detected this pass (empty when nothing changed or on
   *  skip/error). Drives no notifications here — for diagnostics and #12/#14. */
  transitions: ProviderTransition[];
  /** Set when outcome === 'skipped' (e.g. TMDB 404 → metadata null) or
   *  'error'. A human-readable reason; never embeds a credential. */
  reason?: string;
  /** Set when outcome === 'error': the caught error's class name + status if it
   *  is a TmdbError/TraktError (for diagnostics). */
  errorStatus?: number;
}
```

### Engine semantics (the contract)

Per input title `{ tmdbId, type }`, in order:

1. **Metadata fetch.** `type === 'movie'` → `tmdb.getMovie(tmdbId)`; `type ===
'tv'` → `tmdb.getTvShow(tmdbId)`. **A `null` (TMDB 404) →** the title is
   **`skipped`** (`outcome: 'skipped'`, `reason: 'title not found in TMDB'`); no
   write occurs and processing moves to the next title. (Rationale: with no
   metadata there is no entry to refresh; a 404 is a clean skip, not an error.)
2. **Trakt id (tv only).** If `type === 'tv'`, call
   `trakt.getShowTraktId(tmdbId)` → `number | null`; store on the entry's
   `traktId`. If `type === 'movie'`, **do not call** `getShowTraktId`; `traktId`
   is `null`.
3. **Write the entry.** `store.putEntry(tmdbId, { type, metadata, traktId,
lastSyncedAt: now() })`.
4. **Availability fetch + per-region transition detection.** `tmdb
.getWatchProviders(tmdbId, type)` → `RegionProviders | null`. **`null` (404)**
   → no availability write for this title; the title is still counted `synced`
   (its metadata was written) with `transitions: []` (`reason` optionally noting
   "no watch providers"). For a non-null map, **for each region key present**
   (the TMDB-returned regions, already filtered to `REGIONS` by the client):
   - Read the stored `RegionAvailability` for that region from
     `store.getAvailability(tmdbId)` (absent → treat current providers as `[]`).
   - **Transition detection (the unit-tested heart):** let `prev` = the stored
     entry's **current `providers`** (NOT its `previousSnapshot` — see below) and
     `next` = the freshly fetched providers for that region. Compute, **keyed by
     `providerId`**:
     - **added**: a `providerId` in `next` not in `prev` → `ProviderTransition`
       with `kind: 'added'` (newly available).
     - **removed**: a `providerId` in `prev` not in `next` → `ProviderTransition`
       with `kind: 'removed'` (gone).
     - a `providerId` in **both** → **no transition** (unchanged; even if `type`
       changed bucket, v1 keys transitions on provider presence by `providerId`
       — note in Risks).
   - **Write the rolled availability:** `store.putAvailability(tmdbId, region, {
providers: next, previousSnapshot: prev, lastSyncedAt: now() })`. The new
     `previousSnapshot` is **the prior `providers`** (the value transition
     detection diffed against), so the next pass diffs `next` against this pass's
     `next` — the snapshot rolls forward by exactly one pass.
5. **Result.** Push a `SyncResult` for the title: `outcome: 'synced'` with the
   accumulated `transitions` across all its regions (or `'skipped'` per step 1,
   or `'error'` per the error rule).

**Transition baseline decision (`providers` vs `previousSnapshot`).** Transitions
are computed **against the stored `providers`** (this title-region's last-known
current state), and **`previousSnapshot` is written to be the prior `providers`**.
Rationale: `previousSnapshot` is the _output_ of the roll (the "what it was before
this write" record spec 0003 names it for), not the diff baseline. Diffing
`next` against the stored `previousSnapshot` instead would compare against a
two-passes-old state and double-count. The first-ever sync (no stored entry) uses
`prev = []`, so every returned provider is `added` and `previousSnapshot` is
written `[]`.

**Per-title error isolation (hard rule).** Any thrown error from a client call
(`TmdbError`/`TraktError` for `401`/`403`/`5xx`/transport/`429`-exhausted, or any
other throw) **for one title is caught**, recorded as that title's `SyncResult`
with `outcome: 'error'` (capturing `error.status` into `errorStatus` when it is a
`TmdbError`/`TraktError`, and a credential-free `reason`), and the batch
**continues** to the next title. A store-write failure is likewise caught per
title. The engine **never** lets one title abort the pass.

**No notifications, no episodes.** The engine writes **only** `title-cache` entry

- availability through the port. It writes no `users/**` document, no
  notification, and does not fetch the Trakt calendar or season episodes.

### Domain + firestore-schema change (decision 4)

- `libs/shared/domain/src/lib/documents.ts` — add `traktId: number | null;` to
  `TitleCacheEntry` (placed beside `type`; **not** on `TitleMetadata`, which
  stays pure cached-TMDB fields — `traktId` is an identity/join key like `type`,
  matching how `WatchlistItem`/`Title` already carry `traktId: number | null`).
- `libs/shared/domain/src/lib/type-assertions.ts` — the representative
  `_titleCacheEntry` literal **must** add `traktId` (e.g. `traktId: null` for the
  movie example) or `typecheck` fails; update it.
- `libs/shared/firestore-schema/src/lib/data-types.ts` — `TitleCacheReadData` and
  `TitleCacheWriteData` gain `traktId: number | null;` (a non-timestamp field,
  identical on read and write).
- `libs/shared/firestore-schema/src/lib/converters.ts` — `titleCacheToData` /
  `dataToTitleCache` copy `traktId` straight through (no `Date`/`Timestamp`
  mapping). This is the spec-0005 "additive non-timestamp field needs no special
  handling" path.
- READMEs: update `libs/shared/domain/README.md` and
  `libs/shared/firestore-schema/README.md` **in the same change** if their
  public-surface descriptions enumerate `TitleCacheEntry`/`TitleCache*Data`
  fields (per CLAUDE.md's lib-README rule).

## UI / Stitch screen refs

Not applicable. This is a `scope:functions` library (plus two `scope:shared`
type edits) — no mobile slice, no screen, no design-system tokens.

## Implementation task graph

Two `scope:shared` foundation edits land **first** (other code typechecks against
them), then the engine. The `shared/domain` and `shared/firestore-schema` edits
touch **different files** but are a single small coherent type change with a hard
ordering dependency (schema references the domain type), and the engine depends on
both — so all are **[sequential]**; there is no safe parallel fan-out within the
one engine lib either (the tasks share `src/index.ts` and the new `engine/`
group). File manifests are listed per the 0006/0007 convention.

1. **[sequential] Add `traktId` to `TitleCacheEntry` in `shared/domain`
   (foundation — `scope:shared`, depended on by everything below).**
   - Add `traktId: number | null` to `TitleCacheEntry` in `documents.ts`.
   - Update `type-assertions.ts`'s `_titleCacheEntry` literal to set `traktId`.
   - Update `libs/shared/domain/README.md` if it enumerates `TitleCacheEntry`
     fields.
   - Files: `libs/shared/domain/src/lib/documents.ts`,
     `libs/shared/domain/src/lib/type-assertions.ts`,
     `libs/shared/domain/README.md`.

2. **[sequential] Thread `traktId` through `shared/firestore-schema`
   (foundation — `scope:shared`, depends on task 1).**
   - Add `traktId: number | null` to `TitleCacheReadData` + `TitleCacheWriteData`
     in `data-types.ts`; copy it through in `titleCacheToData` / `dataToTitleCache`
     in `converters.ts` (non-timestamp passthrough).
   - Extend the `TitleCacheEntry` round-trip test in `firestore-schema.spec.ts`
     to set + assert `traktId` (both a `number` and `null`).
   - Update `libs/shared/firestore-schema/README.md` if it enumerates the
     `TitleCache*Data` fields.
   - Files: `libs/shared/firestore-schema/src/lib/data-types.ts`,
     `libs/shared/firestore-schema/src/lib/converters.ts`,
     `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
     `libs/shared/firestore-schema/README.md`.

3. **[sequential] The `TitleCacheStore` port + `SyncResult`/transition types.**
   - Add `src/lib/engine/store.ts` exporting the `TitleCacheStore` interface
     (domain-typed, Firebase-free).
   - Add `src/lib/engine/types.ts` exporting `SyncTitleInput`, `SyncEngineConfig`,
     `SyncEngine`, `ProviderTransition`, `SyncOutcome`, `SyncResult`.
   - Files: `libs/functions/sync-titles/src/lib/engine/store.ts`,
     `libs/functions/sync-titles/src/lib/engine/types.ts`.

4. **[sequential] Transition-detection logic.**
   - Add `src/lib/engine/transitions.ts`: a pure function diffing `prev` vs
     `next` `WatchProvider[]` for one region (keyed by `providerId`) → the
     `added`/`removed` `ProviderTransition[]`. No I/O, fully unit-testable.
   - Files: `libs/functions/sync-titles/src/lib/engine/transitions.ts`.

5. **[sequential] The engine factory + `sync()` orchestration.**
   - Add `src/lib/engine/sync-engine.ts` exporting `createSyncEngine(config)`,
     wiring metadata fetch → entry write → (tv) trakt-id → availability fetch →
     per-region transition + rolled write, with the clock, the per-title
     error/skip isolation, and `SyncResult[]` accumulation per the semantics.
   - Files: `libs/functions/sync-titles/src/lib/engine/sync-engine.ts`.

6. **[sequential] Barrel exports + README.**
   - `src/index.ts` adds `createSyncEngine` and the types `SyncEngine`,
     `SyncEngineConfig`, `SyncTitleInput`, `TitleCacheStore`, `SyncResult`,
     `ProviderTransition`, `SyncOutcome` — keeping **all** existing TMDB + Trakt
     exports.
   - Update `libs/functions/sync-titles/README.md`: add the sync engine to
     **Public API**; describe the injected `TitleCacheStore`
     port + clock + clients; document the transition baseline + snapshot-roll
     semantics + tv-only `traktId` rule + the no-notifications/no-episodes
     boundary; add `engine/` to **Internal layout**; **rewrite Future work** —
     after this spec only the **HTTP function (PLAN §6 item 12)** remains (the
     "sync engine + HTTP function" line currently there must drop the engine).
   - Files: `libs/functions/sync-titles/src/index.ts`,
     `libs/functions/sync-titles/README.md`.

7. **[sequential] Unit tests (fakes + mocks).**
   - Per Test plan. Co-located `*.spec.ts` under `src/lib/engine/`. Provide a fake
     in-memory `TitleCacheStore`, mock `TmdbClient`/`TraktClient` method objects,
     and a fixed `now`.
   - Files: `libs/functions/sync-titles/src/lib/engine/transitions.spec.ts`,
     `libs/functions/sync-titles/src/lib/engine/sync-engine.spec.ts`.

## Test plan

Per the PLAN §5 pyramid — a logic-heavy library, so the surface is **unit tests
only**: pure Vitest with mocked clients, a **fake in-memory `TitleCacheStore`**,
and an **injected clock** (a fixed `now: () => '2026-06-19T00:00:00.000Z'`). **No
live network, no Firebase emulator, no secrets.** The mocked clients are plain
objects whose methods return canned values / throw on demand.

**Transition detection (the centerpiece — `transitions.spec.ts`):**

- **Provider appears**: `next` has a provider absent from `prev` → one
  `kind: 'added'` transition with the right `providerId`/`name`/`type`/`region`.
- **Provider disappears**: `prev` has a provider absent from `next` → one
  `kind: 'removed'` transition.
- **Provider unchanged**: a `providerId` in both `prev` and `next` → **no
  transition** for it.
- **First-ever sync**: `prev = []` (empty/absent) → every `next` provider is
  `added`; no `removed`.
- **Mixed**: a region with one added, one removed, one unchanged → exactly the two
  transitions, correct kinds.
- **Empty `next` (all gone)**: every `prev` provider → `removed`.

**Engine orchestration (`sync-engine.spec.ts`):**

- **Movie happy path**: `getMovie` returns metadata, `getWatchProviders` returns a
  one-region map → `store.putEntry` called with `{ type:'movie', metadata,
traktId: null, lastSyncedAt: '<fixed now>' }`; `getShowTraktId` **not called**;
  `store.putAvailability` called with `providers: next`, `previousSnapshot: prev`,
  `lastSyncedAt: '<fixed now>'`; `SyncResult.outcome === 'synced'`.
- **Tv happy path**: `getTvShow` + `getShowTraktId` returns `42` →
  `putEntry` with `traktId: 42`; `getShowTraktId` **called once** with the tmdbId.
- **Tv with no Trakt match**: `getShowTraktId` returns `null` → `traktId: null`,
  still `synced`.
- **Snapshot roll**: seed the fake store with a prior `RegionAvailability`
  (`providers: [A,B]`, `previousSnapshot: [X]`); a pass with `next: [B,C]` writes
  `previousSnapshot: [A,B]` (the prior `providers`, **not** `[X]`) and
  `providers: [B,C]`; transitions = `C added`, `A removed`. (Guards the
  baseline-and-roll decision — the load-bearing correctness property.)
- **Multi-region**: `getWatchProviders` returns NL + DE + US; each region's
  availability is written independently with its own transitions; absent regions
  (not in the map) get **no** write.
- **`getWatchProviders` returns null (404)**: entry still written, **no**
  availability write, `outcome: 'synced'`, `transitions: []`.
- **`getMovie`/`getTvShow` returns null (404)**: title **skipped** —
  `outcome: 'skipped'`, **no** `putEntry`/`putAvailability`, batch continues.
- **Per-title error isolation**: a batch of 3 titles where the middle title's
  `getMovie` **throws** a `TmdbError(…, 500, …)` → that title's `SyncResult` is
  `outcome: 'error'` with `errorStatus: 500`, the other two complete `synced`,
  and no exception escapes `sync()`. A second case: a `getWatchProviders` throw
  after the entry was written → `outcome: 'error'` (or a documented
  partial-success variant — pick one and assert it), batch continues.
- **Movie never calls `getShowTraktId`** (explicit assertion the mock was not
  called) vs **tv always does**.
- **Clock determinism**: every `lastSyncedAt` written equals the injected
  `now()`; with a `now` that advances, assert the engine reads it per write (or
  once per title — document which) consistently.
- **Empty batch**: `sync([])` → `[]`, no client/store calls.

**firestore-schema round-trip (extends the existing
`firestore-schema.spec.ts`):**

- `TitleCacheEntry` round-trip now sets `traktId` and asserts it survives — **two
  cases**: `traktId: 42` (a number) and `traktId: null`. Confirms the
  non-timestamp passthrough.

Component tests: **none** (no UI). e2e / emulator tests: **none** (no flow; the
fake store proves the engine without Firebase — the real Admin-SDK store +
emulator verification is #12's, and the emulator cannot run under Claude Code
tools here anyway).

## Definition of done

Tailored from the PLAN §5 checklist (no component/e2e/build/emulator — node
libraries with no UI, no flow, and no build target). `<engine>` =
`functions-sync-titles`; the touched shared libs are `shared-domain` and
`shared-firestore-schema`.

- [ ] `pnpm nx typecheck functions-sync-titles` passes
      (`tsc --noEmit -p tsconfig.lib.json`), including the engine wired against
      the updated `TitleCacheEntry`.
- [ ] `pnpm nx typecheck shared-domain` passes — the updated `type-assertions.ts`
      (`_titleCacheEntry` with `traktId`) compiles.
- [ ] `pnpm nx typecheck shared-firestore-schema` passes — `TitleCache*Data` +
      converters compile against the new field.
- [ ] `pnpm nx lint functions-sync-titles` passes **with Sheriff active**: the
      lib imports only `@vultus/shared/domain` (and optionally
      `@vultus/shared/firestore-schema`) — **no** `scope:mobile`, no other slice,
      and **no** `firebase-admin`/`@google-cloud/firestore`/`firebase-functions`.
- [ ] `pnpm nx lint shared-domain` and `pnpm nx lint shared-firestore-schema`
      pass (still Firebase-free; `scope:shared → scope:shared` only).
- [ ] `pnpm nx test functions-sync-titles` passes — transition detection +
      engine orchestration unit tests all green (fakes/mocks; no network, no
      emulator, no secrets).
- [ ] `pnpm nx test shared-firestore-schema` passes — the `TitleCacheEntry`
      round-trip now covers `traktId` (number **and** null).
- [ ] **The engine imports no Firebase SDK and no secret** — verified by code
      review of the diff (no `firebase-admin`/`@google-cloud/firestore`/
      `firebase-functions`/`.env`/env access) **and** by the SDK-free unit tests
      passing with only a fake in-memory store. No HTTP dependency added.
- [ ] **No build target is invoked** — none of the three projects has one.
- [ ] `pnpm nx affected -t lint typecheck test --base=main` is green (the affected
      set is `functions-sync-titles` + `shared-domain` + `shared-firestore-schema`
      and any dependents of the two shared libs already on `main`).
- [ ] The barrel `@vultus/functions/sync-titles` exports `createSyncEngine`,
      `SyncEngine`, `SyncEngineConfig`, `SyncTitleInput`, `TitleCacheStore`,
      `SyncResult`, `ProviderTransition`, `SyncOutcome` **in addition to** all
      existing 0006/0007 exports (`createTmdbClient`, `TmdbClientConfig`,
      `TmdbClient`, `RegionProviders`, `TmdbError`, `createTraktClient`,
      `TraktClientConfig`, `TraktClient`, `TraktCalendarEntry`, `TraktError` —
      **none dropped**); internal DTOs/http/mapper internals stay unexported.
- [ ] The **three touched READMEs** are updated **in the same change**: the slice
      README (Public API + engine in Internal layout + Future-work rewrite leaving
      only the HTTP function), `shared/domain` README, and
      `shared/firestore-schema` README (per CLAUDE.md's lib-README rule).
- [ ] No secret is read or written. PR description records the exact verification
      commands (all three projects) and confirms the no-SDK / no-notification /
      no-episode boundaries.

## Risks

- **Data-source accuracy is not the engine's concern (PLAN §9).** TMDB/JustWatch
  availability is known to have NL gaps for licensed content; the engine
  **faithfully writes whatever TMDB returns** and detects transitions over that.
  The Watchmode fallback (PLAN §2/§9) is a later, separately-encapsulated concern.
  Flagged so a reviewer does not expect accuracy handling here.
- **Transition correctness hinges on the snapshot roll.** A bug that diffs against
  the wrong baseline (e.g. against the stored `previousSnapshot` instead of the
  stored `providers`) or writes the wrong `previousSnapshot` would double-count or
  lose a transition. **Guarded by the dedicated snapshot-roll unit test** (seed
  prior state, assert the rolled `previousSnapshot` equals the prior `providers`,
  not a two-passes-old value). Stated as the load-bearing property.
- **Transitions keyed by `providerId` only.** A provider that stays present but
  changes bucket (`flatrate` → `rent`) yields **no** transition in v1 (presence,
  not bucket, drives notifications). If the product later wants "moved to
  rent-only" signals, extend `ProviderTransition` and the diff — out of scope.
  Noted.
- **Per-title error isolation is a hard requirement.** One title's thrown
  `TmdbError`/`TraktError` (or store failure) must be caught and recorded without
  aborting the batch; the daily sync should make best-effort progress. Guarded by
  the multi-title error test. A title that errors **after** its entry write is a
  partial success — the spec picks `outcome: 'error'` and the test asserts the
  chosen behavior so it is contractual, not incidental.
- **Injected-store design defers the real adapter + emulator verification to
  #12.** The engine's correctness is proven by unit tests with a fake store; the
  Admin-SDK `TitleCacheStore` adapter (`titleCacheDocPath`/`availabilityDocPath` +
  the spec-0005 converters) is a **thin wiring layer** built and emulator-verified
  in the #12 spec. The emulator cannot run under Claude Code tools here, so this
  split is both a clean design and a tooling necessity. Risk: a subtle
  domain↔Firestore mismatch surfaces only at #12; mitigated by the port being
  domain-typed and the converters already round-trip-tested (spec 0005, extended
  here for `traktId`).
- **`traktId`-on-`TitleCacheEntry` is additive and passes through firestore-schema
  untouched.** It is a non-timestamp field, so `titleCacheToData`/`dataToTitleCache`
  copy it straight through with no `Date`/`Timestamp` mapping (the spec-0005
  "additive non-timestamp field" path) — but the **data types + round-trip test +
  `type-assertions.ts` literal must still be extended**, or `typecheck`/`test`
  fail. Movies **never** get a `traktId` (it stays `null`; `getShowTraktId` is not
  called) — asserted.
- **No PLAN conflict.** This implements PLAN §6 item 11 (the sync engine) as the
  **final third** of the `sync-titles` slice; the deferrals (no HTTP function, no
  shared-secret/rate-limit/idempotency, no watchlist gathering, no notifications,
  no episode/calendar sync) are pushed to PLAN §6 items 12 (HTTP function) and 14
  (`dispatch-notifications`), which **consume** this engine's output. The lone
  `shared/domain` addition (`traktId`) follows the spec-0003/0005 contract that a
  persisted field's source of truth is the domain lib.
