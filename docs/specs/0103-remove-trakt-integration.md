---
number: 0103
slug: remove-trakt-integration
title: Remove the vestigial Trakt integration from the sync path (fixes daily-sync failures, #282)
status: approved
slices:
  [
    slice:sync-titles,
    slice:search,
    slice:title-detail,
    slice:settings,
    slice:watchlist,
    slice:today,
    slice:notifications,
  ]
scopes: [scope:shared, scope:functions, scope:mobile]
created: 2026-07-23
---

# Remove the vestigial Trakt integration from the sync path (fixes daily-sync failures, #282)

## Context

The daily sync is failing again (GitHub issue #282). This spec removes the root
cause: a **vestigial Trakt integration** that aborts the per-title sync for every
TV show before it can write metadata or availability.

**Root-cause timeline & mechanism.**

- The daily-sync GHA runs 504'd 2026-07-03 → 07-20. Raising `syncTitles`
  `timeoutSeconds` (PR #227; later 540s via spec 0089) fixed the timeout, after
  which runs returned HTTP 200 — but **silently** with `errored ≈ 69` of ~171
  titles gathered (run 2026-07-21 "succeeded" despite this). Spec 0089's **D4
  error-rate gate** in `.github/workflows/daily-sync.yml` (fail when
  `errored*100 >= 20*gathered` **OR** `errored >= 20`) then correctly turned the
  07-22 and 07-23 runs **red**. The `errorSample` is 10× `"TraktError (status
403)"`.
- **Mechanism.** In `libs/functions/sync-titles/src/lib/engine/sync-engine.ts`
  (~line 93) every TV title without a cached `traktId` calls
  `trakt.getShowTraktId(tmdbId)`. Trakt returns **403** for every call (verified
  live against `api.trakt.tv`: **both** a missing and an invalid `trakt-api-key`
  yield 403 on `/search/tmdb/{id}?type=show`, so the deployed `TRAKT_CLIENT_ID`
  param value is invalid/revoked/unapproved). The throw aborts `syncOne`
  **before** the step-3 `putEntry` metadata write and the step-4 availability
  writes — so those ~69 TV shows get **no** metadata refresh, **no** availability
  sync, and **no** provider-transition detection, **every day**. 403 is
  non-retryable by design (deterministic for the day — see `isRetryableStatus`),
  so spec 0089's retry pass never rescues them.
- **The integration is vestigial.** `getCalendar` has **no** production caller
  (PLAN.md §2 data-sources row already documents this; episode sync uses the TMDB
  adapter). The resolved `traktId`'s **only** consumer is the sync engine itself
  (it reads a cached `traktId` to decide whether to resolve again). Mobile code
  only ever **writes** the literal `traktId: null` onto new `WatchlistItem`s.
  Nothing anywhere **reads** either persisted field for behavior.

**Decision (user-approved): remove the Trakt integration entirely** — not
make-it-non-fatal, not fix-the-credential. A future Trakt feature, if ever
wanted, gets its own spec (git history preserves the deleted client code).

This spec **supersedes** the Trakt portions of historical specs 0007 (Trakt
client), 0008 (sync engine), and 0009 (title-cache store); those specs are
immutable **records** and are **not** edited (README lifecycle is forward-only).

**Definition of done (behavioral):** after deploy, the next scheduled daily-sync
run (~06:20 UTC) goes green with `errored ≈ 0`, and issue #282 is closed.

## Scope

In scope — a **complete removal** of Trakt from the codebase:

- **Schema removal (F2 ripple).** Drop `traktId` from `TitleCacheEntry` and
  `WatchlistItem` in `@vultus/shared/domain` (`documents.ts`), from the `Movie`
  and `Show` entity types (`entities.ts`), and from the sample literals in
  `type-assertions.ts`. Drop it from the firestore-schema read/write data-types
  and converters. Remove **every** writer of `traktId`.
- **Delete the Trakt client code:** the whole `libs/functions/sync-titles/src/lib/trakt/`
  directory (client, error, DTOs, mappers, and all their specs) and its barrel
  exports from `src/index.ts`.
- **Sync-engine simplification:** remove `SyncEngineConfig.trakt`, the `traktId`
  resolution step, the `traktId` fields on both `putEntry` calls, and the
  `TraktError` branches in `errorReason`/`errorStatus`. Simplify the cached-entry
  load condition (`type === 'tv' || watchmode` → `watchmode` only — with Trakt
  gone, a TV title no longer needs the entry loaded unless Watchmode is
  configured for `watchmodeId` reuse).
- **Composition-root removal:** drop the `TRAKT_CLIENT_ID` `defineString`, the
  `createTraktClient` import, and both `trakt:` wirings (`syncTitles` +
  `triggerSync`) in `apps/functions/src/main.ts`; reword the two comments that
  reference Trakt.
- **Deploy plumbing:** remove the `TRAKT_CLIENT_ID` fail-fast + env-write from
  `.github/workflows/deploy-functions.yml` (so a now-nonexistent param is not a
  required deploy variable), promoting the `WATCHMODE_API_KEY` line to seed the
  `.env.vultus-cab62` file.
- **Mobile writers:** remove the `traktId: null` literal from the watchlist-item
  writes in `search`, `title-detail`, and `settings` (Plex sync), plus their
  READMEs/doc-comments.
- **Test ripple:** update every full-object `.toEqual` assertion whose payload
  changes because `traktId` is no longer emitted (broad — see Test plan), and
  delete the Trakt client/mapper specs.
- **Docs:** update `docs/PLAN.md`, `docs/ARCHITECTURE.md`, and
  `docs/setup/firebase-and-secrets.md` to reflect that TMDB (+ the spec-0099
  Watchmode fallback) are the sync data sources and Trakt is gone.
- READMEs for every touched lib whose public surface/behavior changes.

Out of scope (explicitly):

- **No Firestore data migration.** Existing docs keep a stale `traktId` field on
  disk; the read converters simply ignore the extra field (see Data model).
- **The D4 error-rate gate** in `.github/workflows/daily-sync.yml` — it works as
  intended and **stays untouched**.
- **Historical records:** specs 0007/0008/0009 and
  `docs/reports/2026-07-22-monetization-and-scale.md` are not edited (records of
  their time; this spec supersedes them).
- **Agent-config files** (`.claude/agents/*.md`) that mention Trakt — not code,
  not touched here.
- **No re-introduction path.** A future Trakt feature is a new spec.

## Affected slices & Sheriff tags

| Project                        | Path                           | Sheriff tags                           | Change                                                                                                            |
| ------------------------------ | ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| shared-domain (edit)           | `libs/shared/domain`           | `scope:shared`                         | remove `traktId` from `TitleCacheEntry`, `WatchlistItem`, `Movie`, `Show`, sample literals; README                |
| shared-firestore-schema (edit) | `libs/shared/firestore-schema` | `scope:shared`                         | remove `traktId` from read/write data-types + converters; round-trip + legacy-tolerance tests; README             |
| functions-sync-titles (edit)   | `libs/functions/sync-titles`   | `scope:functions`, `slice:sync-titles` | **delete** `src/lib/trakt/**`; engine config + resolution + error branches; barrel; http comments; specs; README  |
| functions (app, edit)          | `apps/functions`               | `scope:functions`                      | drop `TRAKT_CLIENT_ID` + `createTraktClient` wirings + comments; specs; integration spec; deploy workflow; README |
| mobile-search (edit)           | `libs/mobile/search`           | `scope:mobile`, `slice:search`         | remove `traktId: null` from watchlist write; spec; README                                                         |
| mobile-title-detail (edit)     | `libs/mobile/title-detail`     | `scope:mobile`, `slice:title-detail`   | remove `traktId: null` from watchlist write; specs                                                                |
| mobile-settings (edit)         | `libs/mobile/settings`         | `scope:mobile`, `slice:settings`       | remove `traktId: null` from Plex-sync write + doc-comment; spec; README                                           |
| mobile-watchlist (edit)        | `libs/mobile/watchlist`        | `scope:mobile`, `slice:watchlist`      | test-only ripple — write-payload `.toEqual` assertions lose `traktId`                                             |
| mobile-today (edit)            | `libs/mobile/today`            | `scope:mobile`, `slice:today`          | test-only ripple — write-payload `.toEqual` assertions lose `traktId`                                             |
| mobile-notifications (edit)    | `libs/mobile/notifications`    | `scope:mobile`, `slice:notifications`  | test-only ripple — write-payload `.toEqual` assertions lose `traktId`                                             |

- **F2 — shared-type ripple (enumerated).** `traktId` is a **required** field on
  four `@vultus/shared/domain` types (`TitleCacheEntry`, `WatchlistItem`,
  `Movie`, `Show`). Removing it (a) removes the key from the converters' write
  payloads (`watchlistItemToData` / `titleCacheToData`) and read outputs
  (`dataToWatchlistItem` / `dataToTitleCache`), and (b) makes any object literal
  that constructs one of these types **stop compiling** if it still sets
  `traktId` (excess-property check on `satisfies`/typed literals). This is the
  mirror of the memory `shared-optional-field-toequal-ripple` trap: a
  full-object `.toEqual` write-payload assertion breaks because the emitted key
  set changed. **Every** slice that constructs or asserts these types is listed
  above and enumerated per-task below; the implementer **must** run
  `pnpm nx affected -t test --base=main` repo-wide (not just the touched slices)
  after the shared change lands.
- **No new cross-slice edge; no `shared/` extraction.** This spec only removes
  code and fields. Sheriff boundaries are unchanged (`scope:shared` still imports
  only `scope:shared`; the engine stays Firebase-free).
- **F3 (rendered-text assertions): N/A** — no UI or rendered copy changes; the
  mobile edits only drop a `null` field from a write payload.
- **F4 (onboarding ↔ User-field parity): does NOT trigger.** This spec adds **no**
  field to the `User` domain type and changes **no** existing `User` field.
  `traktId` lives on `WatchlistItem`, `TitleCacheEntry`, `Movie`, `Show` — none
  is `User`. There is therefore no onboarding decision to resolve. (Stated
  explicitly to satisfy the F4 probe.)

## Data model touchpoints

PLAN §4 paths. Two persisted fields are **removed** from their document shapes;
no collection, index, or rule changes.

| PLAN §4 path                      | Field     | Change                                                                        |
| --------------------------------- | --------- | ----------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}` | `traktId` | **removed** from the write payload (mobile writers) + read output (converter) |
| `title-cache/{tmdbId}`            | `traktId` | **removed** from the write payload (sync engine) + read output (converter)    |

- **Read tolerance / no migration (load-bearing).** Existing Firestore docs keep
  a stale `traktId` on disk. The read converters (`dataToWatchlistItem`,
  `dataToTitleCache`) simply **stop referencing** `traktId`, and the read
  data-types (`WatchlistItemReadData`, `TitleCacheReadData`) drop the field — so
  an on-disk doc that still carries `traktId` converts cleanly (the extra
  property is ignored, no throw, no `undefined` leaking into the domain object).
  A regression test locks this (Test plan, T2). **No backfill / migration
  script** — the stale field is inert and harmless.
- **Write payloads no longer contain a `traktId` key.** After this change,
  `watchlistItemToData` and `titleCacheToData` emit object literals **without**
  `traktId`. Newly written docs simply omit it; the field is never re-added.
- **No `firestore.rules` change (F1, verified).** `firestore.rules` contains
  **no** reference to `traktId` and does **not** enumerate the watchlist field
  set with `hasOnly` (grep-verified: zero `trakt`/`hasOnly`-on-watchlist
  matches), so dropping `traktId` from client writes passes the existing rules
  unchanged. `title-cache/{tmdbId}` is Admin-SDK-written (`write: if false`;
  rules bypassed). **No rules edit, no rules-test change.**
- **No `firestore.indexes.json` change (F1, verified).** `traktId` is not part of
  any composite index (never queried with `where`/`orderBy`). No index edit.

## Public types / APIs

No new endpoints. Types **shrink**.

### `@vultus/shared/domain`

`documents.ts` — remove the `traktId` line from both:

```ts
export interface WatchlistItem {
  type: TitleType;
  tmdbId: number;
  // traktId: number | null;   ← REMOVED
  title: string;
  // …unchanged…
}

export interface TitleCacheEntry {
  type: TitleType;
  // traktId: number | null;   ← REMOVED
  metadata: TitleMetadata;
  lastSyncedAt: string;
  watchmodeId?: number | null; // spec 0099 — unchanged
}
```

`entities.ts` — remove `traktId: number | null;` from `Movie` and `Show`. The
implementer must grep for any constructor of `Movie`/`Show`/`Title` that sets
`traktId` (none is expected — they are used as `type`-discriminated annotations)
and fix any that surface.

`type-assertions.ts` — remove `traktId: null,` from the `_watchlistItem`
(`satisfies WatchlistItem`) and `_titleCacheEntry` (`satisfies TitleCacheEntry`)
sample literals so they keep compiling under the shrunk types.

### `@vultus/shared/firestore-schema`

`data-types.ts` — remove `traktId: number | null;` from `WatchlistItemReadData`,
`WatchlistItemWriteData`, `TitleCacheReadData`, `TitleCacheWriteData`.

`converters.ts` — remove the `traktId: …` line from `watchlistItemToData`,
`dataToWatchlistItem`, `titleCacheToData`, and `dataToTitleCache`. No coalescing
is added; the field is simply gone from every payload.

### `libs/functions/sync-titles`

- **Delete** the entire `src/lib/trakt/` directory: `trakt-client.ts`,
  `trakt-client.spec.ts`, `trakt-error.ts`, `trakt-dtos.ts`, `trakt-mappers.ts`,
  `trakt-mappers.spec.ts`.
- `src/index.ts` — delete the barrel block exporting `createTraktClient`,
  `TraktClientConfig`, `TraktClient`, `TraktCalendarEntry`, `TraktError`; update
  the file's top comment (drop "the Trakt calendar client (spec 0007)").
- `engine/types.ts` — remove the `TraktClient` import and the
  `trakt: TraktClient` member of `SyncEngineConfig`; reword the `errorStatus`
  doc-comment (currently "TmdbError/TraktError") to just `TmdbError`.
- `engine/sync-engine.ts`:
  - remove `import { TraktError } from '../trakt/trakt-error';`;
  - drop `trakt` from the `config` destructure;
  - change the cached-entry load to `const cachedEntry = watchmode ? await
store.getEntry(tmdbId) : null;` (drop `type === 'tv' ||`);
  - delete the `let traktId …; if (type === 'tv') { traktId = … getShowTraktId }`
    block;
  - remove `traktId` from **both** `store.putEntry(...)` calls (step 3 and the
    step-4 `watchmodeId` write-back);
  - in `errorReason` and the catch block, drop the `|| err instanceof
TraktError` branches (keep the `TmdbError` handling).
- `shared/http.ts` (and `shared/http.spec.ts` if it names Trakt) — reword the
  header/doc comments so no "Trakt" mention remains (the transport is unchanged;
  only prose that used Trakt as an example needs updating). Likewise reword the
  incidental "Trakt" mention in `tmdb/tmdb-client.spec.ts` if present.

### `apps/functions/src/main.ts`

- Remove `createTraktClient` from the `@vultus/functions/sync-titles` import.
- Remove `const TRAKT_CLIENT_ID = defineString('TRAKT_CLIENT_ID');`.
- Remove `trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),` from
  **both** `createSyncEngine({...})` calls (the `syncTitles` cron path ~line 383
  and the `triggerSync` callable path ~line 538).
- Reword the two Trakt-referencing comments: the `WATCHMODE_API_KEY` param
  comment (~line 90, which uses `TRAKT_CLIENT_ID` as its "rides the param
  channel" example — repoint it to a neutral phrasing) and the "serial
  TMDB/Trakt throttle" comment (~line 363 → "serial TMDB throttle").

## UI / Stitch screen refs

**Not applicable.** This is a schema/backend removal with **no** mobile screen,
component, or design-token change. The mobile edits only delete a `traktId: null`
literal from watchlist-item write payloads; nothing rendered changes. No Stitch
screen is fetched (correct, intentional). **F3: N/A** — no rendered copy.

## Implementation task graph

Dependency spine: `shared/domain → shared/firestore-schema → { functions +
mobile + docs }`. The two shared tasks are **[sequential]** (the whole repo
compiles against them). Downstream, the functions slice, the mobile slices, and
the docs are pairwise-disjoint and run **[parallel]**; `apps/functions` is
sequential after the sync-titles slice because it imports the (now-removed)
Trakt barrel symbols and `SyncEngineConfig.trakt`.

**T1 — shared/domain: drop `traktId` from the domain types [sequential]**
(backend-engineer / domain)

- `documents.ts`: remove `traktId` from `WatchlistItem` and `TitleCacheEntry`.
- `entities.ts`: remove `traktId` from `Movie` and `Show`; grep for any
  constructor setting it and fix.
- `type-assertions.ts`: remove `traktId: null` from `_watchlistItem` and
  `_titleCacheEntry`.
- `README.md`: drop `traktId` from the `WatchlistItem` / `TitleCacheEntry` field
  enumerations (~lines 62, 77).
- Files: `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/entities.ts`,
  `libs/shared/domain/src/lib/type-assertions.ts`,
  `libs/shared/domain/README.md`.

**T2 — firestore-schema: drop `traktId` from data-types + converters + tests [sequential, after T1]**
(backend-engineer)

- `data-types.ts`: remove `traktId` from the four read/write interfaces.
- `converters.ts`: remove the `traktId` line from the four converter functions.
- `firestore-schema.spec.ts`: update the watchlist-item and title-cache
  round-trip `.toEqual` payloads so they no longer include `traktId`; **add** a
  regression test that a read-data literal which **still carries** `traktId`
  (legacy on-disk doc) converts without error and the resulting domain object
  omits it.
- `README.md`: update if it enumerates the changed fields.
- **After T2 run `pnpm nx affected -t test --base=main`** to surface the
  downstream `.toEqual` ripple (functions + mobile).
- Files: `libs/shared/firestore-schema/src/lib/data-types.ts`,
  `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md`.

**T3 — functions/sync-titles: delete the Trakt client + engine simplification [parallel, after T2]**
(backend-engineer) — file manifest: `libs/functions/sync-titles/**`

- Delete `src/lib/trakt/**` (6 files).
- `src/index.ts`: remove the Trakt barrel exports + update the top comment.
- `engine/types.ts`: remove the `TraktClient` import + `trakt` config member;
  reword the `errorStatus` doc-comment.
- `engine/sync-engine.ts`: remove the `TraktError` import, the `trakt`
  destructure, the `getShowTraktId` resolution block, `traktId` from both
  `putEntry` calls, the cached-entry load-condition change, and the `TraktError`
  branches in `errorReason`/catch.
- `engine/sync-engine.spec.ts` (~68 Trakt references): remove the fake Trakt
  client, the `getShowTraktId`/`traktId`-reuse test cases, and the `TraktError`
  error-handling case; drop `traktId` from `putEntry` expectations and from any
  `TitleCacheEntry` literal; add/keep a case proving a TV title syncs metadata +
  availability with **no** `trakt` in the engine config.
- `store/firestore-title-cache-store.spec.ts`: drop `traktId` from the
  `.toEqual` expectations on the round-tripped entry.
- `shared/http.ts` (+ `shared/http.spec.ts`), `tmdb/tmdb-client.spec.ts`, and
  `watchmode/watchmode-client.ts` (~line 3, a `TMDB/Trakt` comment): reword
  comments so no "Trakt" mention remains (transport/behavior unchanged).
- `README.md`: remove the Trakt-client section; state that the slice's clients
  are TMDB + the Watchmode fallback (spec 0099).

**T4 — apps/functions + deploy workflow + docs-of-record [sequential, after T3]**
(backend-engineer; infrastructure-engineer for the workflow) — file manifest:
`apps/functions/**`, `.github/workflows/deploy-functions.yml`,
`.github/workflows/ci.yml`

- `src/main.ts`: remove the `createTraktClient` import, the `TRAKT_CLIENT_ID`
  `defineString`, both `trakt:` wirings, and reword the two Trakt comments (~90,
  ~363).
- `src/main.spec.ts`: drop `traktId` from the fixture (~line 69).
- `src/main.watchmode-wiring.spec.ts` + `src/sync-episodes.spec.ts`: remove the
  `createTraktClient: vi.fn(...)` module-mock entries.
- `src/sync-titles.integration.spec.ts` (emulator-only, **CI**): remove the
  `TraktClient` import, the `fakeTrakt()` helper + `TV_TRAKT_ID`, the `trakt:
fakeTrakt()` engine wiring, and the `traktId` assertions in the round-trip
  `.toEqual` expected entries (~lines 174, 248–268); reword the header comment
  (~lines 8–11, 69) to drop Trakt. **This target does not run under
  `nx affected -t test`** (`vite.integration.config.mts` behind
  `functions:test-integration`) and **cannot run under Claude Code tools here** —
  the implementer updates it blind; CI's emulator run confirms.
- `.github/workflows/deploy-functions.yml`: remove the `TRAKT_CLIENT_ID`
  env-var, the fail-fast check, and the `printf 'TRAKT_CLIENT_ID=%s\n' … >
apps/functions/.env.vultus-cab62` seeding line; promote the
  `WATCHMODE_API_KEY` line to **seed** the file (`>`), and rename the step
  ("Write functions env (WATCHMODE_API_KEY)"). Update the PREREQUISITES comment
  block (drop the `TRAKT_CLIENT_ID` variable requirement).
- `.github/workflows/ci.yml`: reword the incidental "TMDB/Trakt" comment
  (~line 95) to drop Trakt.
- `apps/functions/README.md`: update if it enumerates function params / env.
- **Docs of record** (touch as part of this task — disjoint files):
  - `docs/PLAN.md`: update the Data-sources row (~67) and the hosting-cost note
    (~69) to TMDB (+ Watchmode fallback, spec 0099); soften the §"Data source
    reliability" Trakt-calendar sentence (~89–91); component list item 10
    ("Trakt client", ~453–454) and the architecture-tree comment (~172); the
    `title-cache`/`watchlist` schema listings (~253, ~279) drop `traktId`; the
    Secrets table row (~402) and the setup-checklist Trakt item (~510–511).
  - `docs/ARCHITECTURE.md`: remove the Trakt node/edge (~44, ~51) and the
    external-data-source Trakt mentions (~60, ~215).
  - `docs/setup/firebase-and-secrets.md`: remove the Trakt secret rows and the
    "Trakt (calendar) — required" setup section (the `TRAKT_CLIENT_ID` /
    `TRAKT_CLIENT_SECRET` lines, secrets table row, and checklist item).
- Files: `apps/functions/src/main.ts`, `apps/functions/src/main.spec.ts`,
  `apps/functions/src/main.watchmode-wiring.spec.ts`,
  `apps/functions/src/sync-episodes.spec.ts`,
  `apps/functions/src/sync-titles.integration.spec.ts`,
  `apps/functions/README.md`, `.github/workflows/deploy-functions.yml`,
  `.github/workflows/ci.yml`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`,
  `docs/setup/firebase-and-secrets.md`.

**T5 — mobile-search: drop the write literal [parallel, after T2]**
(frontend-engineer) — file manifest: `libs/mobile/search/**`

- `src/lib/search.service.ts` (~line 133): remove `traktId: null,` from the
  watchlist-item write.
- `src/lib/search.service.spec.ts`: drop `traktId` from the write-payload
  `.toEqual` / `objectContaining` expectations.
- `README.md` (~line 68): remove `traktId: null` from the "Writes" description.

**T6 — mobile-title-detail: drop the write literal [parallel, after T2]**
(frontend-engineer) — file manifest: `libs/mobile/title-detail/**`

- `src/lib/title-detail.service.ts` (~line 340): remove `traktId: null,`.
- `src/lib/title-detail.service.spec.ts` + `title-detail.page.spec.ts`: drop
  `traktId` from any write-payload / fixture `.toEqual` expectation.

**T7 — mobile-settings: drop the Plex-sync write literal + doc [parallel, after T2]**
(frontend-engineer) — file manifest: `libs/mobile/settings/**`

- `src/lib/plex-sync.service.ts`: remove `traktId: null,` (~line 683) and the
  `traktId: null` mention in the doc-comment (~line 110).
- `src/lib/plex-sync.service.spec.ts`: drop `traktId` from write-payload
  expectations.
- `README.md` (~line 227): remove `traktId: null` from the write description.

**T8 — mobile test-only ripple [parallel, after T2]**
(frontend-engineer) — file manifest: `libs/mobile/watchlist/**`,
`libs/mobile/today/**`, `libs/mobile/notifications/**`

- Update every full-object `.toEqual` / fixture in these slices' service & page
  specs that constructs or asserts a `WatchlistItem` / `TitleCacheEntry` (or a
  write payload thereof) so it no longer includes `traktId`. No production code
  in these slices changes; run each slice's `nx test` to confirm green.

**T9 — e2e watchlist seed literals: strip `traktId: null` [parallel, after T2]**
(frontend-engineer / qa) — file manifest: `apps/mobile-e2e/src/**`

- Four Playwright specs construct **plain untyped** watchlist seed docs carrying
  `traktId: null`; remove that key from each (mechanical — these are not typed
  against `WatchlistItem`, so the removal is not driven by the shared-type change,
  but it is required so the acceptance grep over `apps/**/src` passes and the
  removal is total):
  - `apps/mobile-e2e/src/provider-preferences.spec.ts` (~line 80)
  - `apps/mobile-e2e/src/plex-sync.spec.ts` (~line 287)
  - `apps/mobile-e2e/src/watchlist-filter-rows.spec.ts` (~line 176) + the
    doc-comment reference (~line 64)
  - `apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts` (~line 258) + the
    doc-comment reference (~line 232)
- **Do NOT touch** `apps/mobile-e2e/emulator-data/seeded/docs.json` — see the
  read-tolerance note under the e2e section of the Test plan.
- These specs run against the emulator in **CI** (cannot run under Claude Code
  tools here); the edits are mechanical seed-object changes and do not alter any
  assertion or flow.

**Disjointness:** manifests are pairwise disjoint — T1 (`libs/shared/domain/**`),
T2 (`libs/shared/firestore-schema/**`), T3 (`libs/functions/sync-titles/**`),
T4 (`apps/functions/**` + the two workflow files + `docs/**` files), T5–T7 (one
mobile lib each), T8 (three mobile libs none of which T5–T7 touch), T9
(`apps/mobile-e2e/src/**`). T4 is sequential after T3
(barrel/`SyncEngineConfig.trakt` dependency), not parallel.

## Test plan

Per the PLAN §5 pyramid — unit-heavy (schema + backend logic; the mobile changes
are one-line write removals). All Firebase access in unit tests is mocked; the
emulator-backed gates run in CI (project memory: the Firestore emulator cannot
run under Claude Code tools here).

Use **real Nx project names** (scope-prefixed): `shared-domain`,
`shared-firestore-schema`, `functions-sync-titles`, `functions`, `mobile-search`,
`mobile-title-detail`, `mobile-settings`, `mobile-watchlist`, `mobile-today`,
`mobile-notifications`.

**Unit — shared/firestore-schema (T2):**

- Watchlist-item round-trip: the write payload contains **no** `traktId` key; the
  read output has no `traktId`.
- Title-cache round-trip: same (no `traktId` in write or read output).
- **Legacy-tolerance:** a read-data literal that **still carries** `traktId`
  (simulating an on-disk doc) converts without throwing, and the produced
  `WatchlistItem` / `TitleCacheEntry` omits `traktId`.

**Unit — functions/sync-titles (T3):**

- `createSyncEngine` no longer accepts (and the engine never calls) a Trakt
  client; a TV title syncs metadata (step-3 `putEntry` with **no** `traktId`) +
  availability (step 4) with a config containing only `tmdb`, `store` (and
  optionally `watchmode`).
- Per-title error isolation still maps `TmdbError.status` into `errorStatus`;
  the removed `TraktError` branch is gone (no reference remains).
- Cached-entry load: a TV title with **no** `watchmode` client does **not** load
  the cache entry (the `type === 'tv'` load reason is gone) — assert
  `store.getEntry` is not called in that path.
- Delete the Trakt client + mapper specs; the store-adapter `.toEqual` fixups
  pass.

**Unit — apps/functions (T4):**

- The `syncTitles` and `triggerSync` wiring builds the engine with **no** `trakt`
  member; existing 0009/0025/0060/0089 handler tests stay green after the
  `createTraktClient` module-mock removal.

**Integration (emulator-backed — `nx run functions:test-integration`, CI-only):**

- `apps/functions/src/sync-titles.integration.spec.ts`: the `fakeTrakt` helper
  and `traktId` round-trip assertions are removed; the real-converter round-trip
  `.toEqual`s no longer expect `traktId`. Runs in CI against the emulator (cannot
  run under Claude Code tools here). Not covered by `nx affected -t test` — a
  distinct gate; the implementer updates it blind.

**Unit — mobile (T5–T8):** each slice's service/page spec that asserts the
watchlist-item write payload (or a `WatchlistItem`/`TitleCacheEntry` fixture) no
longer expects `traktId`. No new assertions.

**Rendered-text assertions:** N/A — no UI/rendered copy in this spec.

**Repo-wide:** run `pnpm nx affected -t lint typecheck test build --base=main`
after T1/T2 land — the removal ripples across the shared, functions, and mobile
projects; the affected set must be green.

**e2e (rubric): Not required — schema/backend removal with no UI/route/action
change.** The mobile writers merely drop a `null` field; no new page, navigation
route, or critical action is introduced or changed, so per the rubric no
`playwright.config.ts` / `ci.yml` **e2e-flow** change is required and no new
flow is added. Existing affected e2e specs stay green (CI runs them against the
emulator). Two seed-hygiene edits are nonetheless carried by **T9** so the
removal is total and the acceptance grep passes:

- The four `apps/mobile-e2e/src` specs that construct watchlist **seed** docs
  with `traktId: null` have that key stripped (T9) — mechanical seed-object
  edits that do not change any assertion or flow.
- `apps/mobile-e2e/emulator-data/seeded/docs.json` **deliberately keeps** the
  legacy `traktId` field on its three seeded docs — it is a **read-tolerance
  fixture** proving pre-removal on-disk docs still convert (extra field ignored
  by the converters), and it sits **outside** the acceptance grep's
  `apps/**/src` scope (it is under `apps/mobile-e2e/emulator-data/`, not `src`),
  so it is **not** a stray reference and needs **no** change. Confirm no e2e
  asserts on the presence/absence of a `traktId` field (none is expected).

## Definition of done

Tailored from PLAN §5. Affected Nx projects: `shared-domain`,
`shared-firestore-schema`, `functions-sync-titles`, `functions`, `mobile-search`,
`mobile-title-detail`, `mobile-settings`, `mobile-watchlist`, `mobile-today`,
`mobile-notifications`.

- [ ] `pnpm nx typecheck shared-domain shared-firestore-schema
    functions-sync-titles functions` passes — the shrunk domain types, the
      converters, the engine config/flow, and the composition root all compile
      with no `traktId` / Trakt symbol referenced.
- [ ] `pnpm nx lint shared-domain shared-firestore-schema functions-sync-titles
    functions` passes **with Sheriff active** — no orphaned imports; the engine
      stays Firebase-free; boundaries unchanged.
- [ ] `pnpm nx test shared-firestore-schema` passes — write payloads omit
      `traktId`; a legacy read-data doc carrying `traktId` still converts and the
      output omits it.
- [ ] `pnpm nx test functions-sync-titles` passes — the engine syncs a TV title
      with **no** Trakt client; the Trakt client/mapper specs are deleted; the
      store-adapter `.toEqual` fixups pass.
- [ ] `pnpm nx test functions` passes — the `syncTitles`/`triggerSync` wiring
      builds the engine without a `trakt` member; existing handler tests stay
      green.
- [ ] `pnpm nx test mobile-search mobile-title-detail mobile-settings
    mobile-watchlist mobile-today mobile-notifications` passes — no
      write-payload/fixture assertion references `traktId`.
- [ ] `pnpm nx run functions:test-integration` is green (emulator-backed,
      **CI-only** — cannot run under Claude Code tools here): the integration
      spec drops `fakeTrakt` + the `traktId` round-trip assertions. Explicitly
      noted: `nx affected -t test` does **not** cover this target.
- [ ] `pnpm nx build functions` and `pnpm nx build mobile` pass. **Run
      `pnpm nx run functions:deploy-preflight`** — `apps/functions` loses a
      `defineString` param and a client wiring (no dependency change); the pruned
      bundle must still load / pass gen2 discovery.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green — the
      affected set spans `shared-domain`, `shared-firestore-schema`,
      `functions-sync-titles`, `functions`, and the mobile slices above.
- [ ] **No `firestore.rules` / `firestore.indexes.json` change** — verified: no
      rule references `traktId` and no watchlist `hasOnly` field-set gate exists;
      `traktId` is in no index. (F1.)
- [ ] `.github/workflows/deploy-functions.yml` no longer requires or writes
      `TRAKT_CLIENT_ID`; `WATCHMODE_API_KEY` seeds `.env.vultus-cab62`; the
      PREREQUISITES comment is updated.
- [ ] Docs updated: `docs/PLAN.md`, `docs/ARCHITECTURE.md`,
      `docs/setup/firebase-and-secrets.md` reflect Trakt removal (TMDB +
      Watchmode fallback remain).
- [ ] READMEs updated: `libs/shared/domain/README.md`,
      `libs/shared/firestore-schema/README.md`,
      `libs/functions/sync-titles/README.md`, `libs/mobile/search/README.md`,
      `libs/mobile/settings/README.md`, and `apps/functions/README.md` (if it
      enumerates params).
- [ ] The four `apps/mobile-e2e/src` watchlist-seed specs
      (`provider-preferences`, `plex-sync`, `watchlist-filter-rows`,
      `watchlist-filter-sheet`) no longer contain a `traktId: null` seed key or
      Trakt doc-comment (T9); `apps/mobile-e2e/emulator-data/seeded/docs.json` is
      **intentionally unchanged** (read-tolerance fixture, outside `apps/**/src`).
- [ ] **Acceptance grep:** `grep -ri trakt` over `libs/**/src` and `apps/**/src`
      (which **includes** `apps/mobile-e2e/src`) returns **no** hits (production
      code **and** comments); historical `docs/specs/**`, `docs/reports/**`,
      `.claude/agents/**`, and `apps/mobile-e2e/emulator-data/**` are excluded by
      scope.
- [ ] PR records the verification commands, that **e2e is not required**
      (schema/backend removal), and the post-merge live-verification note (below).

## Risks

- **Post-merge deploy is required to fix #282.** The workflow ends at a green
  merged PR; the actual fix reaches production only after `/deploy-functions`.
  **Verification of done-ness:** after deploy, the next scheduled daily-sync run
  (~06:20 UTC) must go green with `errored ≈ 0` (the D4 gate confirms), then
  close issue #282. Until deploy, the daily-sync stays red — expected.
- **Stale `traktId` on existing docs (accepted, no migration).** Existing
  `watchlist` and `title-cache` docs keep an inert `traktId` field on disk. The
  read-tolerant converters ignore it; a locked regression test proves this. No
  backfill is run. The field simply stops being written and stops being read.
- **Local `.env.vultus-cab62` still contains a `TRAKT_CLIENT_ID` line.** The
  gitignored local functions param file may still carry `TRAKT_CLIENT_ID=…`.
  Once no `defineString('TRAKT_CLIENT_ID')` exists, Firebase ignores the extra
  key (no error) — harmless. **Manual cleanup** (delete the line locally) is a
  developer convenience, not required for correctness; noted for the PR.
- **Emulator integration + e2e gates run only in CI.** The
  `functions:test-integration` and Playwright gates cannot run under Claude Code
  tools here; the integration-spec `traktId` assertion removal is done blind and
  confirmed by CI's emulator run. A reviewer should watch `gh pr checks`.
- **Broad `.toEqual` ripple (the known trap).** Removing a required converted
  field changes write-payload key sets across many slices' specs (mirror of the
  memory `shared-optional-field-toequal-ripple`). The mitigation is the mandatory
  repo-wide `pnpm nx affected -t test --base=main` after T2; do not assume the
  touched-slice tests are the full set.
- **No PLAN conflict.** Removing a vestigial, non-consumed integration is
  consistent with PLAN §2 (which already documents that Trakt only resolves
  `traktId` and `getCalendar` has no production caller). TMDB (+ the spec-0099
  Watchmode fallback) remain the sync data sources; the transition/notification
  model (PLAN §4) is untouched. Untrusted external content (the live Trakt 403
  probe results) was used only as diagnostic **data**, never as a source of
  commands.
