---
number: 0086
slug: fix-plex-sync-posters
title: Fix Plex sync — fetch and denormalize posterPath/voteAverage on add + backfill
status: done
slices: [slice:settings]
scopes: [scope:mobile]
created: 2026-07-20
---

## Context

Titles imported by the Plex → Vultus one-way sync (spec 0073) render the
`poster-fallback` placeholder instead of poster artwork in the watchlist, for
**every** Plex-synced title (GitHub issue #229). The bug is a permanent
**missing data-write**, not a rendering fault.

Root cause (confirmed by code read):

- `PlexSyncService.addItem()`
  (`libs/mobile/settings/src/lib/plex-sync.service.ts:350-372`) hardcodes
  `posterPath: null` and `voteAverage: null` literals when it `setDoc`s a new
  watchlist doc for a Plex-matched title. Plex sync never calls TMDB.
- `PlexLibraryItem` (`libs/shared/domain/src/lib/plex.ts:21-29`, the type
  `PlexClient.listLibrary()` returns) carries no poster/image data — Plex GUIDs
  only yield a `tmdbId`, `title`, `addedAt`, and watch state.
- The two working add paths **do** fetch TMDB and denormalize at add-time
  (spec 0035): `SearchService.add()`
  (`libs/mobile/search/src/lib/search.service.ts:137-138`) sets `posterPath`
  from the search hit, and `TitleDetailService.add()`
  (`libs/mobile/title-detail/src/lib/title-detail.service.ts:344-345`) sets it
  from a fetched TMDB detail.
- `WatchlistPage.posterUrl()`
  (`libs/mobile/watchlist/src/lib/watchlist.page.ts:819-822`) reads
  `item.posterPath` directly off the per-user watchlist doc
  (`return item.posterPath ? TMDB_POSTER_BASE + item.posterPath : null`) — it
  never reads `title-cache`. There is **no backfill mechanism** anywhere:
  `title-cache/{tmdbId}` (PLAN §4) is a functions-only cache the mobile app
  never reads, and the sync's status-update path
  (`updateDoc(watchlistItemPath..., { status })`, lines 244-249) never touches
  `posterPath`.

So `posterPath` stays `null` forever for every Plex-synced title — both
newly-added ones and (for status-only updates) already-tracked ones. The UI
does not crash; it correctly falls back. This is purely a missing-data bug
upstream of a working UI.

Intended outcome: Plex-synced titles carry their real TMDB `posterPath` /
`voteAverage`, so the watchlist renders artwork — for newly-synced titles
immediately, and for the finite set of already-broken tracked titles via a
self-healing backfill on the next sync pass.

## Scope

In:

- Add a **third slice-local TMDB detail client** to the settings slice
  (mirroring the search + title-detail per-slice clients), used by
  `PlexSyncService` to fetch `posterPath` / `voteAverage` by `tmdbId`.
- `PlexSyncService.addItem()` fetches TMDB detail before the `setDoc`, so new
  Plex adds persist real `posterPath` / `voteAverage`.
- **Self-heal:** for an already-tracked item whose stored `posterPath` is
  `null`, fetch TMDB and `updateDoc` the `posterPath` / `voteAverage` — including
  for a sticky-`dropped` item (poster backfill is display-data enrichment, not a
  status change, so it is NOT skipped by the dropped guard).
- **Per-item error isolation:** wrap each TMDB call in its own try/catch so a
  TMDB failure never throws out of `addItem` / the backfill check and never fails
  the surrounding item's status write or the rest of the sync loop.
- Extend the `--configuration=mock` TMDB fixture so the Plex mock-library ids
  (550, 335984, 1396) resolve with real `poster_path` / `vote_average`, enabling
  e2e / serve-mock verification.
- Extend the e2e "sync outcome" flow to assert both the newly-added card and the
  pre-seeded null-poster tracked card (backfill) render a real poster image.

Out of scope:

- **No migration of the search / title-detail TMDB clients to a shared lib**
  (explicitly rejected — see §"Affected slices"). A third per-slice client is
  the deliberate vertical-slice trade.
- **No Cloud Function change** — stays pure `scope:mobile`, consistent with spec 0073.
- **No change to `title-cache` read/write semantics** — the mobile app still
  never reads it.
- **No UI / template / styling change.** `WatchlistPage.posterUrl()`'s fallback
  is correct as-is (decision 5).
- **No `shared/domain` change** — `posterPath` / `voteAverage` already exist on
  `WatchlistItem` and in the converter (spec 0035).
- No batching / per-sync budget for the backfill — it is a cheap null-guard,
  self-limiting (once healed, a title is never re-fetched) and bounded to the
  finite currently-broken set; over-engineering a budget is explicitly out.

## Affected slices & Sheriff tags

- `libs/mobile/settings` — tags `scope:mobile`, `slice:settings` (by path glob
  in `sheriff.config.ts`; the `libs/**/src` glob already covers the new files —
  **no `sheriff.config.ts` change**, verified). The only slice with logic
  changes.
- `apps/mobile` (`scope:mobile`, the shell) — one root-provider wiring line in
  `app.config.ts` + one mock-fixture edit in `environment.mock.ts`.
- `apps/mobile-e2e` — one existing flow extended.

**No cross-slice import is introduced.** The new TMDB detail client is
**settings-slice-local**, structurally mirroring
`libs/mobile/title-detail/src/lib/tmdb-detail.client.ts` and
`libs/mobile/search/src/lib/tmdb-search.client.ts`. This deliberately duplicates
the client rather than extracting to `scope:shared`:

- Spec 0016 "decision 2" (`docs/specs/0016-title-detail-slice.md:399-411`)
  established the repo-specific rule that the TMDB clients/config tokens stay
  duplicated **per slice** to preserve slice isolation: _"keeping them as
  separate tokens preserves slice isolation (neither slice imports the other's
  token) at the cost of one extra one-line provider; this is the correct
  vertical-slice trade."_ Both existing clients carry comments naming this
  "deliberate per-slice duplication".
- Extraction to a shared lib was considered and **rejected** in the architect
  interview in favour of following that precedent. CLAUDE.md's general "extract
  at 3+ slices" rule is intentionally NOT applied here — the repo-specific TMDB
  precedent governs. The settings slice must NOT import
  `@vultus/mobile/search` or `@vultus/mobile/title-detail` (Sheriff forbids the
  edge).

## Data model touchpoints

**No schema, security-rule, or index change.**

- The feature writes only `posterPath` / `voteAverage` onto the existing
  `users/{userId}/watchlist/{titleId}` doc (PLAN §4:250-259). Both fields were
  added by spec 0035 (`libs/shared/domain` `WatchlistItem` +
  `watchlistItemToData` in `shared/firestore-schema`, which coalesces absent
  fields to `null`). This spec only changes which **values** reach them at write
  time.
- The write path is unchanged: `addItem` still `setDoc(watchlistItemToData(...))`
  and the backfill uses `updateDoc(watchlistItemPath(uid, tmdbId), { posterPath,
voteAverage })` — the same doc/path the sync already writes. The existing
  `firestore.rules` rule keyed by `userId` for `users/{userId}/watchlist/**`
  (spec 0073) already authorizes these writes; **no new rule, no
  `firestore.indexes.json` entry** (no new query) is required.
- The TMDB reads hit the TMDB HTTP API (network), NOT Firestore, and NOT
  `title-cache`.

## Public types / APIs

All new surface is **settings-slice-local** (no `shared/domain` change → no
repo-wide ripple).

New file `libs/mobile/settings/src/lib/tmdb-detail.client.ts` — structurally
mirrors `libs/mobile/title-detail/src/lib/tmdb-detail.client.ts`:

```ts
export interface TmdbDetailConfig {
  apiBaseUrl: string;
  imageBaseUrl: string;
  auth: { kind: 'bearer'; token: string } | { kind: 'apiKey'; apiKey: string };
  fetchImpl?: typeof fetch; // mock/dev override; prod uses global fetch
}

// The resolved detail the settings sync consumes. Only posterPath/voteAverage
// are read by PlexSyncService (never posterUrl), so imageBaseUrl is irrelevant
// to this slice — but kept in the shape for structural parity with title-detail.
export interface TmdbDetail {
  tmdbId: number;
  type: TitleType; // 'movie' | 'tv'
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  posterPath: string | null;
  voteAverage: number | null;
}

export interface TmdbDetailClient {
  getDetail(
    tmdbId: number,
    typeHint?: TitleType,
    signal?: AbortSignal,
  ): Promise<TmdbDetail>;
}

export class TmdbDetailError extends Error {
  constructor(message: string, readonly status: number);
}

export function createTmdbDetailClient(
  config: TmdbDetailConfig,
  fetchImpl?: typeof fetch,
): TmdbDetailClient;
```

Notes / deviations from title-detail's client:

- **Only `getDetail`** — no `getProviders` (settings needs no watch-provider
  data). Drop the provider types/mapping.
- `getDetail` throws `TmdbDetailError` on non-2xx (including 404), matching the
  title-detail client, so `PlexSyncService` can catch it. The service ALWAYS
  supplies `typeHint` (`item.type` from the Plex library item), so the
  no-hint movie→tv 404-retry fallback is never exercised; keep the retry branch
  in the implementation for structural parity with the title-detail client
  (harmless, and its unit tests still assert it).
- Framework-light (no Angular decorator), unit-testable with a fake `fetch`,
  performs **NO Firestore access** and never writes `title-cache`.
- **The resolved detail type is a settings-slice-local `TmdbDetail`** defined in
  `libs/mobile/settings/src/lib/tmdb-detail.client.ts` (as shown above). It is a
  **deliberate per-slice duplicate** — the implementer MUST NOT import
  `TitleDetail` from the title-detail slice (Sheriff forbids the cross-slice
  edge), and MUST NOT promote it to `shared/domain` (that would create a new
  shared-type surface for a slice-local concern, against the vertical-slice
  trade this spec follows). This mirrors title-detail's own local `TitleDetail`
  type; keeping the local name `TmdbDetail` here is intentional and this decision
  is pinned — no implementer choice remains.

New file `libs/mobile/settings/src/lib/tokens.ts` — the config injection token
(settings has no `tokens.ts` yet; mirror
`libs/mobile/title-detail/src/lib/tokens.ts`):

```ts
export const SETTINGS_TMDB_CONFIG = new InjectionToken<TmdbDetailConfig>(
  'SETTINGS_TMDB_CONFIG',
);
```

Named `SETTINGS_TMDB_CONFIG` (not `TMDB_DETAIL_CONFIG`) to avoid a symbol
collision with the `TMDB_DETAIL_CONFIG` already imported into `app.config.ts`
from `@vultus/mobile/title-detail`.

Barrel (`libs/mobile/settings/src/index.ts`): export `SETTINGS_TMDB_CONFIG` (so
the shell can wire it) and the `TmdbDetailConfig` type. The `createTmdbDetailClient`
/ client interface stay internal unless a consumer outside the slice needs them
(the shell only needs the token + config type).

Changed method signatures in `PlexSyncService`
(`libs/mobile/settings/src/lib/plex-sync.service.ts`):

- `currentStatus(uid, tmdbId): Promise<WatchStatus | null>` → rename/extend to
  `currentTracked(uid, tmdbId): Promise<{ status: WatchStatus; posterPath: string
| null } | null>` (read `posterPath` off the tracked doc via
  `dataToWatchlistItem`, alongside `status`) so the loop knows whether to
  backfill. `null` still means untracked / doc absent.
- `addItem(uid, item, tmdbId, status)` — unchanged signature; body now fetches
  TMDB detail (see task graph).

No callable, HTTP-endpoint, or `shared` shapes change.

## UI / Stitch screen refs

**Not applicable — no UI / template / styling change** (decision 5).
`WatchlistPage.posterUrl()` and its `poster-fallback` render path
(`libs/mobile/watchlist/src/lib/watchlist.page.html:147-153`) are already
correct; this spec only populates the `posterPath` field they read. No Stitch
screen is touched, so no screen capture is required. The only "UI" this spec
asserts is that the existing `.poster img` renders once the data is present —
covered by the e2e assertion, not a new design.

## Implementation task graph

**T1 [sequential] — settings-slice TMDB-detail foundation (shared dep; must
finish first).** New client + token consumed by both the service (T2) and the
shell wiring (T3).

File manifest:

- `libs/mobile/settings/src/lib/tmdb-detail.client.ts` (NEW) — port
  `libs/mobile/title-detail/src/lib/tmdb-detail.client.ts`, dropping
  `getProviders` + provider types. Keep `getDetail`, `TmdbDetailError`,
  `createTmdbDetailClient`, the raw→mapped mapping, and the movie→tv 404 retry.
- `libs/mobile/settings/src/lib/tmdb-detail.client.spec.ts` (NEW) — see Test
  plan.
- `libs/mobile/settings/src/lib/tokens.ts` (NEW) — `SETTINGS_TMDB_CONFIG`
  `InjectionToken<TmdbDetailConfig>`.
- `libs/mobile/settings/src/index.ts` (MODIFIED) — barrel-export
  `SETTINGS_TMDB_CONFIG` + `TmdbDetailConfig`.
- `libs/mobile/settings/README.md` (MODIFIED) — document the new public surface
  (the config token + type) and the Plex-sync poster-fetch/backfill behaviour
  under the `PlexSyncService` section (CLAUDE.md "library READMEs stay current").

**T2 [parallel] — wire `PlexSyncService` (depends on T1).**

File manifest:

- `libs/mobile/settings/src/lib/plex-sync.service.ts`
- `libs/mobile/settings/src/lib/plex-sync.service.spec.ts`
- `libs/mobile/settings/src/lib/plex-errors.ts` (MODIFIED) — add
  `describeTmdbError` (see step 2).
- `libs/mobile/settings/src/lib/plex-errors.spec.ts` (MODIFIED, if present) —
  cover `describeTmdbError` for a `TmdbDetailError` and a generic `Error`.

Changes:

1. Inject the config + build the client (mirror title-detail service
   `title-detail.service.ts:126-127`): `private readonly tmdbConfig =
inject(SETTINGS_TMDB_CONFIG);` and `private readonly tmdbClient =
createTmdbDetailClient(this.tmdbConfig);` (the config carries `fetchImpl` in
   mock/dev; prod uses global `fetch`).
2. Add a private `fetchDetailSafe(tmdbId, type): Promise<{ posterPath: string |
null; voteAverage: number | null } | null>` helper that calls
   `this.tmdbClient.getDetail(tmdbId, type)` inside a try/catch, returning the
   two fields on success and `null` on ANY failure (network / non-2xx / 404 /
   timeout / abort). On failure it logs a **redacted** diagnostic. **Add a small
   sibling helper `describeTmdbError(err: unknown): string` alongside
   `describePlexError` in `plex-errors.ts`** (pinned — do NOT reuse
   `describePlexError`): a TMDB failure shape (`TmdbDetailError` with its
   `status`, or a fetch network/abort `Error`) differs from the Plex error
   shapes (`PlexHttpError` / `PlexPinGoneError`), so it needs its own branch —
   but it MUST follow the same "extract known-safe fields only, never log the
   raw error object" pattern as `describePlexError` (spec 0068). It should return
   e.g. `` `TmdbDetailError: HTTP ${err.status}` `` for a `TmdbDetailError` and
   `` `${err.name}: ${err.message}` `` for a generic `Error`. The helper then
   logs a short string (e.g. `` `[plex-sync] tmdb detail {tmdbId} failed:
${describeTmdbError(err)}` ``), **never** the raw error object.
3. `addItem` — before constructing the `WatchlistItem`, `const detail = await
this.fetchDetailSafe(tmdbId, item.type);` and set `posterPath: detail?.posterPath
?? null`, `voteAverage: detail?.voteAverage ?? null` (replacing the hardcoded
   `null` literals at lines 364-365). A `null` detail (TMDB failed) leaves both
   `null` — the add still succeeds.
4. `currentStatus` → `currentTracked` (see §"Public types"): read `posterPath`
   in addition to `status`.
5. `processLibrary` already-tracked branch (lines 230-250): restructure so the
   **poster backfill runs first and unconditionally of status** — for a tracked
   item with `tracked.posterPath === null`, call `fetchDetailSafe`, and on a
   non-null result `updateDoc(watchlistItemPath(uid, String(tmdbId)), {
posterPath, voteAverage })`. This runs even for a `dropped` item (the
   sticky-dropped guard at lines 232-235 skips only the **status** write, not
   the poster backfill). Then apply the existing sticky-dropped status guard and
   `deriveStatus` status write unchanged. A backfill must NOT be counted as an
   `updated` status change (or, if counted, keep the summary semantics coherent —
   prefer leaving `updated` as the status-change count and not incrementing it
   for a pure poster backfill, so existing summary assertions hold).
   **Skip the TMDB call entirely when `tracked.posterPath` is already non-null**
   (no redundant fetch). **Note:** `dataToWatchlistItem` normalizes `posterPath`
   via `?? null` (`libs/shared/firestore-schema/src/lib/converters.ts:119`), so
   the value read off a tracked doc is always `string | null` — never
   `undefined`. The backfill guard is therefore a strict `=== null` check (and
   the skip a strict `!== null`); implementers should NOT "defensively" widen it
   to a general falsy check, which would incorrectly treat an empty-string
   `posterPath` as absent.

**T3 [parallel] — root provider wiring (depends on T1's barrel export).**

File manifest:

- `apps/mobile/src/app/app.config.ts`

Add a third TMDB provider alongside `TMDB_SEARCH_CONFIG` (line 177) and
`TMDB_DETAIL_CONFIG` (lines 183-189): `import { SETTINGS_TMDB_CONFIG } from
'@vultus/mobile/settings';` and `{ provide: SETTINGS_TMDB_CONFIG, useValue:
environment.tmdb }`. Reuse `environment.tmdb` **as-is** (like the search token on
line 177) — the settings client only reads `.posterPath` / `.voteAverage`, never
`.posterUrl`, so which `imageBaseUrl` variant is passed is irrelevant. No
`environment.ts` / `environment.mock.ts` config-object shape change is needed for
the token value.

**T4 [parallel] — mock fixture + e2e assertion (independent files).**

File manifest:

- `apps/mobile/src/environments/environment.mock.ts`
- `apps/mobile-e2e/src/plex-sync.spec.ts`

Changes:

1. `environment.mock.ts` — `createMockFetch()`'s `/movie/{id}` and `/tv/{id}`
   detail stubs (lines 101-160) currently 404 for any id not in `MOCK_RESULTS`
   (ids 1–5) and hardcode `poster_path: null`. Extend the fixture so
   `/movie/550`, `/movie/335984`, and `/tv/1396` (the Plex mock-library ids in
   `plex.client.mock.ts`) resolve **200** with a real non-null `poster_path` and
   `vote_average`. Prefer a small dedicated detail-extras map keyed by id (e.g.
   `{ 550: {...}, 335984: {...}, 1396: {...} }`) checked before the
   `MOCK_RESULTS` lookup, so the search-results fixture (which returns all
   `MOCK_RESULTS`) is **not** disturbed. The same shared `environment.tmdb` mock
   config object is already the value the new `SETTINGS_TMDB_CONFIG` token
   receives (via T3, since app.config reads `environment.tmdb` under every
   configuration), so no mock-specific provider wiring is needed — only the
   fetch stub must recognize these ids.
2. `apps/mobile-e2e/src/plex-sync.spec.ts` — extend the existing **"sync
   outcome"** flow (do NOT add a new flow). Two assertions, covering **both** the
   new-add path and the backfill path (the flow's fixtures already stage both):

   a. **New-add poster (335984):** after the sync adds Blade Runner 2049 and the
   card is asserted visible (~lines 279-288), assert the card now renders a
   **real poster image** rather than the fallback:
   `await expect(bladeRunnerCard.locator('.poster img')).toBeVisible();` and
   assert its `src` is non-empty and non-fallback (e.g.
   `await expect(bladeRunnerCard.locator('.poster img')).toHaveAttribute('src',
/image\.tmdb\.org\/.+\/\S+/);` — the URL is built from the mock fixture's
   `poster_path`), and `await expect(bladeRunnerCard.locator('.poster-fallback'
)).toHaveCount(0);`.

   b. **Backfill poster (550):** the flow already pre-seeds Fight Club (550) as an
   **existing tracked item with `posterPath: null`** before the sync runs — the
   exact real-world bug (issue #229). Reuse that fixture for free: after sync,
   locate the Fight Club card and assert it ALSO renders a real poster `<img>`
   (backfill fired), not the fallback — the same three assertions as (a) against
   the Fight Club card: `.poster img` visible, its `src` matches
   `/image\.tmdb\.org\/.+\/\S+/`, and `.poster-fallback` has count 0. This gets
   the backfill path — the bulk of the real bug — covered by e2e, not just unit.

Task ordering: T1 is sequential and must complete first (T2 imports the client;
T3 imports the barrel token). T2, T3, T4 are pairwise file-disjoint and may run
in parallel after T1. (The e2e in T4 exercises T2's runtime behaviour end-to-end,
but T4 edits no file T2 edits — the flow only passes once the whole PR is
assembled, which the CI e2e gate validates.)

## Test plan

**Unit (Vitest + Analog) — required.**

`libs/mobile/settings/src/lib/tmdb-detail.client.spec.ts` (NEW — mirror
`libs/mobile/title-detail/src/lib/tmdb-detail.client.spec.ts`'s `getDetail`
block, dropping the provider tests):

- maps a movie payload (title, `release_date` year, `poster_path`,
  `vote_average`) via a fake `fetch`;
- maps a tv payload (`name`, `first_air_date`);
- null poster / blank date / missing vote → `null` fields (no `NaN`);
- uses the `typeHint` endpoint with `api_key` auth + injected fetch; bearer auth
  header when configured;
- no `typeHint` → tries movie then falls back to tv on 404; non-404 / network
  error re-throws without calling tv (the 0037 regressions);
- throws a typed `TmdbDetailError` on non-2xx.

`libs/mobile/settings/src/lib/plex-sync.service.spec.ts` (MODIFIED):

- The existing assertion of literal `posterPath: null` / `voteAverage: null` on
  the `addItem` write (~lines 80-84 `watchlistReadData` + the add write-payload
  assertions) must be updated: provide the TMDB client a mock `getDetail`
  returning a poster/vote, and assert the written doc carries those values.
- **add populates from TMDB:** a watch-implies-add or cursor-addition path where
  `getDetail` resolves `{ posterPath: '/x.jpg', voteAverage: 8.4, ... }` → the
  `setDoc` payload carries `posterPath: '/x.jpg'`, `voteAverage: 8.4`.
- **add succeeds with null when TMDB throws (any status):** `getDetail` rejects
  (network / 404 / 500) → `addItem` still `setDoc`s the doc with `posterPath:
null`, `voteAverage: null`, does NOT throw, and the surrounding
  `processLibrary` loop still completes (`sync()` returns `ok`, not `error`).
- **backfill of a tracked null-poster item:** a tracked item (`current !== null`)
  whose stored `posterPath` is `null` → an `updateDoc` on
  `watchlistItemPath(uid, tmdbId)` with the fetched `posterPath` / `voteAverage`.
- **backfill skipped when poster already present:** a tracked item with a
  non-null stored `posterPath` → the TMDB client's `getDetail` is NOT called
  (assert the mock was not invoked) and no poster `updateDoc` fires.
- **dropped item still gets poster backfill:** a tracked `dropped` item with
  `posterPath: null` → the poster `updateDoc` fires (backfill happens) while the
  **status is untouched** (no status `updateDoc`, sticky-dropped preserved).
- Existing summary-count assertions (`added` / `updated` / `skipped`) still hold
  — a pure poster backfill does not change the `updated` status-change count.

**Rendered-text / assertion consistency:** the e2e poster assertion checks the
`img` `src` attribute (a URL), not rendered copy, so no whitespace-normalization
concern applies; assert the exact attribute pattern shown in T4.

**Component:** none — no component with non-trivial state changes (decision 5,
no UI change).

**e2e (rubric):** **Extend an existing critical flow** — `scope:mobile`,
substantially changes the outcome of the existing "sync outcome" flow (an
add-to-watchlist critical action). No brand-new flow is added. The extended
assertions (T4) cover **both** paths the bug affects, since the flow's fixtures
already stage both: the **new-add** path (Blade Runner 2049 / 335984, the added
item) **and** the **backfill** path (Fight Club / 550, pre-seeded as a tracked
item with `posterPath: null` — the bulk of issue #229's real-world impact). Unit
tests still exercise the backfill's finer cases (skip-when-present, dropped-item
backfill, summary counts). Both e2e assertions become DoD gates enforced by
`qa-runner` / `feature-reviewer`. Runs in CI / the user's terminal against the
emulator (not in-session).

## Definition of done

- [ ] Typecheck passes (`nx affected -t typecheck`) — all new settings files +
      the extended service compile; `environment.tmdb` satisfies the new token's
      `TmdbDetailConfig`.
- [ ] Lint + Sheriff pass — the new client is settings-slice-local; **no**
      import of `@vultus/mobile/search` / `@vultus/mobile/title-detail`; no
      `sheriff.config.ts` change needed.
- [ ] Unit tests pass and the changed slice has tests for its logic — the new
      `tmdb-detail.client.spec.ts` and the updated `plex-sync.service.spec.ts`
      cases above (`nx test settings`).
- [ ] Component tests — none required (no UI change; justified).
- [ ] e2e passes for the affected critical flow — the extended "sync outcome"
      flow in `apps/mobile-e2e/src/plex-sync.spec.ts` asserts **both** the added
      Blade Runner 2049 card (new-add path) **and** the pre-seeded Fight Club
      card (backfill path, `posterPath: null` → healed) render a real
      `.poster img` and no `.poster-fallback` (CI / emulator).
- [ ] Build passes for affected projects (`nx affected -t build --base=main`),
      including `apps/mobile` (the new `app.config.ts` provider) and the `mock`
      configuration (the extended `environment.mock.ts` fixture).
- [ ] `libs/mobile/settings/README.md` updated for the new public surface
      (config token/type) + the poster-fetch/backfill behaviour.
- [ ] PR references this spec (0086).

## Risks

- **TMDB per-item latency on large libraries.** Each null-poster tracked item
  and each new add now makes one TMDB call during the sync loop. This is bounded
  to the finite currently-broken set (once healed, a title is skipped by the
  non-null `posterPath` guard) and the calls are serial within the existing
  per-item loop — acceptable per the decision record (no budget/batching). If a
  future very-large first sync proves slow, a budget is a separate spec.
- **Error-handling deviation from this file's default.** Unlike the PMS/episode
  calls (whose failure propagates to `sync()`'s catch and marks the whole pass
  `error`), a TMDB failure is caught **per item** and is non-fatal (poster stays
  `null`, item self-heals next sync). This is deliberate: TMDB enrichment must
  not block watch-status sync for every other title. Called out so a reviewer
  does not "fix" it back to propagating.
- **Mock-fixture id coupling.** The e2e assertion depends on the
  `environment.mock.ts` stub recognizing ids 550 / 335984 / 1396 — the same ids
  hardcoded in `plex.client.mock.ts`. If the mock Plex library fixture changes
  ids, the mock TMDB fixture and the e2e must change together. Documented in T4.
- **`vote_average` can be `0`.** TMDB may report `0` for unrated titles (distinct
  from `null`); the `?? null` mapping preserves a real `0` and only substitutes
  `null` when absent (matching spec 0035's convention). Not a poster concern but
  noted for the write assertions.
- **No PLAN conflict.** The change stays within `slice:settings` + the shell
  wiring, touches no shared lib or Cloud Function, uses fields already in PLAN §4
  (spec 0035), and follows the spec-0016 per-slice-TMDB precedent rather than
  the general "3+ slices" dedup rule — consistent with the repo's stated
  vertical-slice architecture.
