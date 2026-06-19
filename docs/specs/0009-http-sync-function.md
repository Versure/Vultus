---
number: 0009
slug: http-sync-function
title: Add the HTTP sync function wrapping the sync engine in apps/functions
status: implementing
slices: [slice:sync-titles]
scopes: [scope:functions]
created: 2026-06-19
---

# Add the HTTP sync function wrapping the sync engine in apps/functions

## Context

PLAN §6 item 12 calls for the **HTTP sync function**: "Wrap sync engine in
HTTPS callable, validate secret header, idempotent." This spec delivers it. It
is the **follow-on to spec 0008** (merged, `done`), which delivered the pure,
Firebase-free `createSyncEngine(config)` library in `libs/functions/sync-titles`
and **deliberately deferred everything below** — auth, rate-limiting,
idempotency, gathering the tracked titles from the watchlist, the Admin-SDK
persistence adapter, and the `apps/functions` wiring — to this spec. Spec 0006
delivered the TMDB client; 0007 the Trakt client; 0008 the engine. This is the
fourth and final piece that makes the functions backend **runnable end to end**.

This is the **first code in the repo that imports `firebase-admin` and touches
Firestore for real.** Spec 0008 kept the engine SDK-free precisely so the
Firebase Admin SDK enters the slice in exactly one place — the `TitleCacheStore`
adapter built here. The HTTP handler in `apps/functions` then: authenticates the
caller, enforces the rate-limit window, gathers the **global union of tracked
titles** across all users, applies the staleness window, constructs a fully
credentialed `createSyncEngine(...)`, runs one pass, and returns a JSON summary.

Intended outcome: a GitHub Actions daily cron (PLAN §6 item 13, a separate spec)
can `POST` to the function with a shared secret and refresh the whole
`title-cache`; the mobile app's "refresh now" (PLAN §1, rate-limited to once per
5 minutes) can `POST` with its Firebase Auth ID token and refresh the same cache.

### Trigger + auth — `onRequest`, not callable (locked decision)

PLAN §2 says "GitHub Actions cron → HTTP Cloud Function" while PLAN §6 item 12
says "HTTPS callable". These conflict, and **this spec resolves them in favor of
a single HTTPS `onRequest` function** with **dual auth**. Rationale: a Firebase
**callable** requires a Firebase Auth context on every call, but the GitHub
Actions cron has **no Firebase Auth identity** — it can only present a shared
secret in a header. A callable cannot serve the cron path. An `onRequest`
function can accept **either** credential, giving PLAN §2's "single code path for
sync logic" (one function serves both cron and app). The function accepts:

- a **shared-secret header** (`X-Vultus-Sync-Secret`) — the privileged cron path
  (bypasses the rate limit, may `force`-refresh); the secret is **never** shipped
  in the app, OR
- a valid **Firebase Auth ID token** (`Authorization: Bearer <idToken>`) — the
  app's manual-refresh path (the app uses anonymous auth, PLAN §2); this path is
  rate-limited.

A request with neither valid credential → `401` (missing/malformed) / `403`
(present but invalid). This is the locked contract — do not re-litigate the
callable-vs-onRequest choice.

## Scope

In scope:

- **An Admin-SDK `TitleCacheStore` adapter** in `libs/functions/sync-titles`
  (`slice:sync-titles`), implementing the port spec 0008 exported from the
  barrel, backed by `firebase-admin` Firestore. This is the **only** place the
  SDK enters the slice; the engine stays SDK-free.
- **The HTTP `onRequest` handler** in `apps/functions/src` that wires the
  adapter + credentialed TMDB/Trakt clients + a clock into `createSyncEngine`,
  authenticates, rate-limits, gathers + dedupes the global tracked-title union,
  applies the staleness window, runs `engine.sync(titles)`, and returns a JSON
  result summary. Replaces the placeholder `healthcheck`.
- **A `collectionGroup('watchlist')` gather** across **all** users, projected to
  **distinct `{ tmdbId, type }`** (a title tracked by N users is synced **once**).
- **Rate-limiting + idempotency** via a single Firestore doc `system/sync`
  (`lastRunAt` / `lastRunStartedAt`): the authenticated-user path is rejected
  with `429` if the last run was < 5 minutes ago; the shared-secret cron path
  **bypasses** it. Idempotency is the natural overwrite-idempotence of the sync
  (it overwrites `title-cache`) plus the rate-limit window collapsing rapid
  retries — **no separate idempotency-key store** (the chosen, sufficient v1
  model; stated in Risks).
- **A configurable staleness window** (default ~20h): the function filters the
  gathered union, skipping any title whose stored `title-cache` `lastSyncedAt` is
  younger than the window, **before** calling `engine.sync`. A `force` flag
  (privileged/cron path only) bypasses the window. The **engine stays
  staleness-agnostic** (0008 contract unchanged) — the filter lives in the
  function.
- **Secret/config reads via `firebase-functions/params`** (`defineSecret` /
  `defineString`) — never `.env.local`. Constant-time secret comparison; never
  log a secret or token.
- **Vitest unit tests** for the adapter (mocked `firebase-admin`), the auth /
  rate-limit / staleness gating, and the handler wiring (fake engine; assert the
  deduped union is passed and that no `users/**` doc is ever written).
- **An automated, emulator-backed integration test** that exercises the real
  adapter (`createFirestoreTitleCacheStore(db)`) + the `collectionGroup('watchlist')`
  gather + the `syncTitles` handler end-to-end against the **Firestore emulator**
  (TMDB/Trakt HTTP stubbed, no live network/secrets), **wired as a GitHub Actions
  CI gate** (not an honor-system manual step). See Test plan.

Out of scope (each its own spec/slice):

- **The daily-sync GitHub Action** (`.github/workflows/daily-sync.yml`, PLAN §6
  item 13) — a separate spec. This delivers only the function the cron calls.
- **Notification dispatch** (PLAN §6 item 14, the `dispatch-notifications`
  slice). The function writes **no** notification and **no** `users/**` doc — the
  per-user fan-out of availability changes is #14's job, triggered by the
  `title-cache` availability writes this function makes.
- **Episode / calendar sync** — out, exactly as in 0008. The engine uses Trakt
  only for `getShowTraktId`; no `getCalendar` / `getSeasonEpisodes` here.
- **Deploy** — the workflow ends at a green merged PR; Firebase Functions deploy
  - secret/param provisioning is manual (PLAN §7, specs README "Scope &
    limitations").
- **Watchmode fallback** (PLAN §9) — later.
- **The engine internals** — unchanged. This spec wraps and wires the 0008
  engine; it does **not** modify the `createSyncEngine` contract.
- **Resumable cursor / Cloud-Tasks fan-out** — documented as future scaling work
  (see "Scaling & limits"), not built here.

## Affected slices & Sheriff tags

| Project               | Path                         | Sheriff tags                           | Change                                                    |
| --------------------- | ---------------------------- | -------------------------------------- | --------------------------------------------------------- |
| functions-sync-titles | `libs/functions/sync-titles` | `scope:functions`, `slice:sync-titles` | **add** the Admin-SDK `TitleCacheStore` adapter + barrel  |
| functions (app)       | `apps/functions`             | `scope:functions`                      | **replace** placeholder handler with the sync `onRequest` |

- **Tagging is by path glob in `sheriff.config.ts`** — `'apps/functions':
'scope:functions'` and `'libs/functions/<slice>': ['scope:functions',
'slice:<slice>']`. **This spec does not edit `sheriff.config.ts`.** The
  `apps/functions` `project.json` `tags: []` is correct as-is — Sheriff tags are
  assigned by path, **not** by Nx `project.json` tags (see the config's header
  comment) — so nothing needs adding there.
- **Import boundaries (verified against `sheriff.config.ts`):** `scope:functions`
  may import `['scope:shared', 'scope:functions']`. So:
  - `apps/functions` (a `scope:functions` app) importing
    `@vultus/functions/sync-titles` (`scope:functions` + `slice:sync-titles`) and
    `@vultus/shared/*` is **allowed**. (Rule 3: an app may import its own scope's
    slices.) `apps/functions` is the **deployable barrel** that wires the slice
    library into a Cloud Function — that is its job.
  - The adapter inside `libs/functions/sync-titles` importing `firebase-admin`
    is a **third-party** import that Sheriff does not police (Sheriff governs only
    `scope:`/`slice:` boundaries between **workspace** projects). The adapter may
    also import `@vultus/shared/firestore-schema` (path builders + converters,
    `scope:shared`) and `@vultus/shared/domain`.
  - **The 0008 engine must still import no Firebase SDK.** The SDK lives **only**
    in the new adapter file. Verified by code review of the diff + the engine's
    SDK-free unit tests still passing with a fake store.
- **Not a premature `shared/` extraction.** The adapter and handler logic stay in
  their respective projects; nothing is hoisted to `shared/`. There is still one
  consuming slice — the "extract only at 3+ slices" rule is respected.
- **CI-config touchpoint (the one place this spec touches CI).** The automated
  emulator integration test adds a Firestore-emulator integration-test step/job to
  `.github/workflows/ci.yml` — root/infra config (`scope:functions`-adjacent,
  outside any Sheriff slice; Sheriff governs only workspace import boundaries, not
  workflow YAML). The job must stay minimal: start the Firestore emulator, run the
  integration target/suite, tear down. Running it requires `firebase-tools`, which
  is **already a root devDependency** (the emulator commands referenced throughout
  these specs rely on it) — **verify it is present in the lockfile and do not add a
  new dependency**; if (and only if) it is genuinely absent, that addition is in
  scope for the CI-wiring task.

## Data model touchpoints

The function is a **reader of watchlists** and a **writer of the global
`title-cache` only** (via the engine's port + the rate-limit doc). It writes
**no** `users/**` document.

| PLAN §4 path                                 | Access   | By                                                                               |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `users/{userId}/watchlist/{titleId}`         | **read** | `collectionGroup('watchlist')` gather → distinct `{ tmdbId, type }`              |
| `title-cache/{tmdbId}`                       | r/w      | engine via the Admin-SDK `TitleCacheStore` adapter (`titleCacheDocPath`)         |
| `title-cache/{tmdbId}/availability/{region}` | r/w      | engine via the adapter (`availabilityDocPath`)                                   |
| `system/sync`                                | r/w      | the function's rate-limit / idempotency window (`lastRunAt`, `lastRunStartedAt`) |

- **Watchlist gather.** The watchlist doc shape (`libs/shared/domain`
  `WatchlistItem`, PLAN §4) carries `type: 'movie' | 'tv'` and `tmdbId: number`.
  The function reads them via `db.collectionGroup(COLLECTIONS.watchlist)` (the
  collection-id constant from `@vultus/shared/firestore-schema`), maps each doc
  to `{ tmdbId, type }`, and **dedupes by `tmdbId`** (a title tracked by many
  users is one sync). Use the spec-0005 `dataToWatchlistItem` converter or read
  `tmdbId`/`type` fields directly (they are non-timestamp primitives; reading two
  raw fields avoids needing the `addedAt` Timestamp — **pick reading the two raw
  fields**, since the gather needs only id + type and avoids constructing the
  full domain object).
- **No new Firestore index.** The `collectionGroup('watchlist')` query has **no
  `where`/`orderBy`** (it scans all watchlist docs and projects in memory), so it
  needs **no composite index** — `firestore.indexes.json` is **unchanged**.
  (Stated explicitly so the implementer does not add one.) A collection-group
  query is automatically available; no config is required to enable it.
- **`system/sync` is a new top-level collection/doc**, written **only** by the
  Admin SDK (which bypasses security rules entirely). It is **not** client-
  readable: `firestore.rules` already denies everything not explicitly allowed
  (the final `match /{document=**} { allow read, write: if false; }`), and
  `system/**` is not allowed anywhere, so clients are denied by default — **no
  `firestore.rules` change is required**. State this; do not add a rule.
- The `title-cache` writes go through the engine's `TitleCacheStore` port; their
  exact shapes are spec 0005's (`TitleCacheEntry` incl. the spec-0008 `traktId`,
  and `RegionAvailability` with the rolled `previousSnapshot`). This spec adds no
  new field to those documents.

## Public types / APIs

### HTTP endpoint (the deployable function)

A single Cloud Function exported from `apps/functions/src/main.ts`, replacing the
placeholder `healthcheck`. Recommended name: **`syncTitles`** (an `onRequest`
HTTPS function). `setGlobalOptions({ region: 'europe-west1', maxInstances: 1 })`
stays. The handler:

- **Method:** `POST` only (other methods → `405`). No request body is required;
  an optional JSON body `{ force?: boolean }` is accepted (cron may send
  `force: true`).
- **Auth (in order):**
  1. If header `X-Vultus-Sync-Secret` is present → **constant-time compare**
     (`crypto.timingSafeEqual` over equal-length buffers; unequal length → false
     without leaking timing) against the `SYNC_SHARED_SECRET` param. Match → the
     **privileged path** (rate-limit bypass; `force` honored). Mismatch → `403`.
  2. Else if `Authorization: Bearer <idToken>` is present → verify with
     `admin.auth().verifyIdToken(token)`. Valid → the **user path**
     (rate-limited; `force` ignored — only the privileged path may force).
     Invalid → `403`.
  3. Neither header present → `401`.
- **Rate limit (user path only):** read `system/sync.lastRunAt`; if `now -
lastRunAt < RATE_LIMIT_MS` (5 min) → `429` with a JSON body `{ error:
'rate_limited', retryAfterMs }`. The privileged path skips this check.
- **Gather:** `collectionGroup('watchlist')` → distinct `{ tmdbId, type }[]`.
- **Staleness filter:** unless `force` (privileged), drop any title whose stored
  `title-cache.lastSyncedAt` is younger than `STALENESS_WINDOW_MS` (default ~20h).
- **Run:** construct the engine and `await engine.sync(filteredTitles)`.
- **Record:** write `system/sync` `{ lastRunAt: <now>, lastRunStartedAt: <start> }`.
- **Respond `200`** with a JSON summary:

```ts
interface SyncRunResponse {
  ok: true;
  trigger: 'cron' | 'user';
  gathered: number; // distinct titles before staleness filter
  synced: number; // engine results with outcome 'synced'
  skipped: number; // staleness-skipped + engine 'skipped'
  errored: number; // engine results with outcome 'error'
  forced: boolean;
  durationMs: number;
}
```

The response **must never** include a secret, token, or raw `SyncResult.reason`
that could embed a credential (the engine already guarantees credential-free
reasons; the function aggregates counts, not raw reasons).

### The Admin-SDK `TitleCacheStore` adapter (in `libs/functions/sync-titles`)

Implements the `TitleCacheStore` interface spec 0008 exported from the barrel.
**Verify the exact 0008 port shape from the merged barrel before implementing**
(it may be the four-method form `getEntry` / `getAvailability` / `putEntry` /
`putAvailability`, or a consolidated `read`/`write` form — implement whichever
the merged `@vultus/functions/sync-titles` export actually declares; do not
change the port). A factory mirroring the client factories is recommended:

```ts
import type { Firestore } from 'firebase-admin/firestore';
import type { TitleCacheStore } from '@vultus/functions/sync-titles';

/** Admin-SDK-backed implementation of the engine's TitleCacheStore port.
 *  Maps domain types onto the spec-0005 path builders + converters. */
export function createFirestoreTitleCacheStore(db: Firestore): TitleCacheStore;
```

Mapping (using `@vultus/shared/firestore-schema`):

- `getEntry(tmdbId)` → `db.doc(titleCacheDocPath(tmdbId)).get()`; if it exists,
  `dataToTitleCache(snap.data() as TitleCacheReadData)` → `TitleCacheEntry`, else
  `null`.
- `getAvailability(tmdbId)` → `db.collection(availabilityPath(tmdbId)).get()`;
  for each doc, key = the doc id (a `Region`), value =
  `dataToAvailability(doc.data() as RegionAvailabilityReadData)`.
- `putEntry(tmdbId, entry)` → `db.doc(titleCacheDocPath(tmdbId)).set(
titleCacheToData(entry))` (the converter returns the `Date`-typed write shape;
  the Admin SDK coerces `Date` → `Timestamp` — never construct an SDK
  `Timestamp`).
- `putAvailability(tmdbId, region, availability)` →
  `db.doc(availabilityDocPath(tmdbId, region)).set(availabilityToData(
availability))`.

(If the merged port is the consolidated `read`/`write` form, implement those
method names over the same path builders + converters.) The adapter is exported
from the slice barrel so `apps/functions` can construct it. It is the thin wiring
layer 0008 explicitly left for this spec; it adds **no** business logic — the
transition detection + snapshot roll stay in the engine.

### Config / secrets (via `firebase-functions/params`)

Defined in `apps/functions/src` (the deployable boundary that owns config):

- `SYNC_SHARED_SECRET` — `defineSecret('SYNC_SHARED_SECRET')`; the cron's
  shared secret. Read via `.value()` **inside** the handler (not at module load).
- The **TMDB v4 read token** and **Trakt client id** — `defineSecret(
'TMDB_READ_TOKEN')` / `defineString('TRAKT_CLIENT_ID')` (the Trakt client id is
  not a secret per PLAN §5's secrets table, but treat both as configurable
  params); injected into `createTmdbClient({ readAccessToken })` /
  `createTraktClient({ clientId })`.
- **Hard rule (CLAUDE.md):** the implementer **never reads or writes
  `.env.local` or any secret value.** Params are declared by name only; their
  values are provisioned manually (PLAN §7) and read at runtime via `.value()`.
  Never log a secret or token; the secret comparison is constant-time.

`RATE_LIMIT_MS` (5 min) and `STALENESS_WINDOW_MS` (~20h) are plain constants (or
`defineString` with numeric default) — document which; constants are sufficient
for v1 (no secret involved).

### Slice barrel addition

`libs/functions/sync-titles/src/index.ts` adds
`export { createFirestoreTitleCacheStore } from './lib/store/firestore-title-cache-store';`
(or the chosen path), **keeping all existing 0006/0007/0008 exports**
(`createTmdbClient`, `createTraktClient`, `createSyncEngine`, `TitleCacheStore`,
`SyncResult`, etc. — **none dropped**).

## UI / Stitch screen refs

Not applicable. This is `scope:functions` work (a slice adapter + an
`apps/functions` HTTP handler) — no mobile slice, no screen, no design tokens.
The mobile "refresh now" caller is PLAN §6 item 18 (`slice:watchlist`), a
separate spec; this spec only delivers the endpoint it will call.

## Implementation task graph

The Admin-SDK adapter (slice lib) is a **dependency of** the `apps/functions`
handler (the handler constructs it), so the adapter lands first. The two projects
write **disjoint** file sets, but the handler imports the adapter's barrel export,
so they are ordered **[sequential]** rather than fanned out in parallel. All
tasks are `scope:functions`. File manifests are listed per the 0006/0007/0008
convention.

1. **[sequential] Admin-SDK `TitleCacheStore` adapter + barrel export
   (`functions-sync-titles`, `slice:sync-titles`).**
   - Add `src/lib/store/firestore-title-cache-store.ts` —
     `createFirestoreTitleCacheStore(db)` implementing the merged 0008
     `TitleCacheStore` port over `titleCacheDocPath` / `availabilityPath` /
     `availabilityDocPath` + the spec-0005 converters (`dataToTitleCache` /
     `titleCacheToData` / `dataToAvailability` / `availabilityToData`). Imports
     `firebase-admin/firestore` (this is the only SDK entry in the slice),
     `@vultus/shared/firestore-schema`, `@vultus/shared/domain`. No business
     logic.
   - Add `src/index.ts` export for `createFirestoreTitleCacheStore`, keeping
     **all** existing exports.
   - Add `src/lib/store/firestore-title-cache-store.spec.ts` — unit tests with a
     **mocked `firebase-admin` Firestore** (fake `db` with `doc()`/`collection()`
     returning canned snapshots): assert read maps via the converters, write
     calls `.set()` with the `Date`-typed converter output at the right path, and
     a missing entry → `null`.
   - Update `libs/functions/sync-titles/README.md`: add the adapter to **Public
     API** + **Internal layout** (`store/`); note `firebase-admin` enters the
     slice **only** here while the engine stays SDK-free; **rewrite Future work**
     so only **#13 daily-sync cron** + **#14 dispatch-notifications** remain (the
     HTTP function is now built).
   - Files: `libs/functions/sync-titles/src/lib/store/firestore-title-cache-store.ts`,
     `libs/functions/sync-titles/src/lib/store/firestore-title-cache-store.spec.ts`,
     `libs/functions/sync-titles/src/index.ts`,
     `libs/functions/sync-titles/README.md`.

2. **[sequential] The `syncTitles` `onRequest` handler + gating logic
   (`apps/functions`). Depends on task 1.**
   - Add the gather/dedupe, auth, rate-limit, and staleness logic as **pure,
     injectable helper functions** (so they unit-test without the SDK), e.g. in
     `apps/functions/src/lib/`:
     - `auth.ts` — `classifyAuth(headers, secret, verifyToken)` → `'cron' |
'user' | null` (constant-time secret compare; token verify injected).
     - `gather.ts` — `dedupeTitles(items)` → distinct `{ tmdbId, type }[]`.
     - `staleness.ts` — `filterStale(titles, lastSyncedByTmdbId, now, windowMs,
force)` → titles to sync.
     - `rate-limit.ts` — `isRateLimited(lastRunAt, now, windowMs)` → boolean.
   - Replace `healthcheck` in `src/main.ts` with `syncTitles` (`onRequest`):
     init `admin` (once), declare the params, run auth → rate-limit → gather →
     staleness → construct clients + `createFirestoreTitleCacheStore(db)` +
     `createSyncEngine(...)` → `engine.sync(...)` → write `system/sync` → respond
     `SyncRunResponse`. The Firestore-touching glue (`collectionGroup` read,
     `system/sync` r/w, `verifyIdToken`) lives in `main.ts` / a thin
     `firestore-io.ts`; the pure helpers carry the testable logic.
   - Add unit tests (`*.spec.ts`) for the pure helpers + a handler-wiring test
     that injects a **fake engine** and a **fake/mocked `db`**: assert the engine
     is called with the **deduped, staleness-filtered** union, that **no
     `users/**`write occurs**, that the secret path bypasses the rate limit and
the user path is`429`'d when recent, and that `401`/`403`/`405` map
     correctly.
   - If `apps/functions` has a `README.md`, update it to describe the function;
     if it does not, do **not** invent one (only the lib-README rule is binding).
   - Files: `apps/functions/src/main.ts`,
     `apps/functions/src/lib/auth.ts`, `apps/functions/src/lib/gather.ts`,
     `apps/functions/src/lib/staleness.ts`, `apps/functions/src/lib/rate-limit.ts`,
     `apps/functions/src/lib/firestore-io.ts`,
     `apps/functions/src/lib/auth.spec.ts`,
     `apps/functions/src/lib/gather.spec.ts`,
     `apps/functions/src/lib/staleness.spec.ts`,
     `apps/functions/src/lib/rate-limit.spec.ts`,
     `apps/functions/src/main.spec.ts`.

3. **[sequential] Automated emulator-backed integration test + CI gate wiring.
   Depends on tasks 1 and 2** (it exercises the real adapter and the real
   handler).
   - Add the integration spec — an `*.integration.spec.ts` (or equivalent
     dedicated pattern) that boots against the **Firestore emulator**, seeds a
     watchlist across multiple users, stubs the TMDB/Trakt HTTP transport (no live
     network, no secrets), wires `createSyncEngine` to the **real**
     `createFirestoreTitleCacheStore(db)` + the `collectionGroup('watchlist')`
     gather + the `syncTitles` handler, and asserts the four behaviours in the
     Test plan ("Automated emulator integration gate"). **Backend work.**
   - Add the minimal Nx test target/configuration needed to run it under the
     emulator — e.g. a dedicated `integration` test configuration or a
     `*.integration.spec.ts` glob run separately in CI behind the emulator (kept
     **out** of the default `nx test` run so the SDK-free unit suites stay
     emulator-free). Decide whether the integration spec lives under
     `apps/functions` or `libs/functions/sync-titles` based on what it exercises
     end-to-end (the handler lives in `apps/functions`, so it lands there unless
     it can run purely against the slice barrel).
   - Add the CI step/job to `.github/workflows/ci.yml`: start the Firestore
     emulator, run the integration target/suite as a **required gate**, tear down.
     **Infrastructure work** (infrastructure-engineer territory) — the integration
     spec itself is backend.
   - Note the local-tooling reality: per project memory the Firestore emulator
     **cannot run under Claude Code tools here (loopback blocked)**, so the
     implementing agent runs/verifies this test in the **user's own terminal
     locally**; CI (where the emulator works) is the automated gate.
   - Files: the integration spec (e.g.
     `apps/functions/src/sync-titles.integration.spec.ts` **or**
     `libs/functions/sync-titles/src/lib/store/firestore-title-cache-store.integration.spec.ts`
     — one location, chosen per above), any Nx config it needs (the project's
     `project.json` / `vite.config.ts` test-configuration glob in the chosen
     project), and `.github/workflows/ci.yml`.

(`firebase-admin` and `firebase-functions` are already root dependencies, and
`firebase-tools` (the emulator) is an already-present root devDependency — no new
runtime dependency is added; verify before assuming. The actual helper file
names/grouping are a recommendation; keep the **pure logic injectable +
unit-tested** and the SDK glue thin.)

## Test plan

Per the PLAN §5 pyramid — backend logic, so the bulk of the surface is **unit
tests** with mocks/fakes; **no component, no e2e** (no UI flow). On top of those,
one **automated emulator-backed integration test** runs the real flow end-to-end
against the Firestore emulator as a **CI gate** (see "Automated emulator
integration gate" below).

**Admin-SDK adapter (`firestore-title-cache-store.spec.ts`):**

- `getEntry` of an existing doc → maps via `dataToTitleCache`; correct path
  (`titleCacheDocPath`); a missing doc → `null`.
- `getAvailability` → reads the `availability` subcollection, keys each entry by
  its `Region` doc id, maps via `dataToAvailability`; empty subcollection → `{}`.
- `putEntry` / `putAvailability` → call `.set()` at the right paths with the
  `Date`-typed converter output (assert the converter was used, not a hand-built
  Timestamp). Use a fake `db` whose `doc()`/`collection()` record calls.
- Round-trips a `TitleCacheEntry` incl. `traktId` (number and null) through the
  fake to confirm the spec-0008 field flows.

**Pure gating helpers:**

- `dedupeTitles`: a title tracked by 3 users → one `{ tmdbId, type }`; distinct
  tmdbIds preserved; mixed movie/tv preserved; empty → `[]`.
- `classifyAuth`: valid secret → `'cron'`; wrong secret → reject (and
  constant-time path exercised); valid bearer token → `'user'`; invalid token →
  reject; neither → `null`. **Never logs the secret/token.**
- `isRateLimited`: `now - lastRunAt < 5min` → true; `>= 5min` → false; no prior
  run → false.
- `filterStale`: a title fresher than the window is dropped; a stale one kept; a
  never-synced one kept; `force: true` keeps **all** regardless of freshness.

**Handler wiring (`main.spec.ts`, with a fake engine + fake `db`):**

- **Cron path**: secret header → `trigger: 'cron'`, rate limit **bypassed**,
  `force` honored, engine called with the deduped + (unless forced) staleness-
  filtered union; `system/sync` updated; `200` with the right counts.
- **User path**: valid token, last run > 5 min ago → runs; last run < 5 min ago
  → `429` and **engine NOT called**.
- **No-auth → `401`; bad secret/token → `403`; non-POST → `405`.**
- **Boundary assertion**: across all paths the fake `db` records **no write to
  any `users/**`path** and **no notification write** — only`title-cache/\*\*`(via the store) and`system/sync`. This is the load-bearing boundary test.
- Engine errors for some titles are reflected in `errored`/`synced` counts; the
  handler still returns `200` (best-effort, per 0008's per-title isolation).

**Automated emulator integration gate (`*.integration.spec.ts`, real Firestore
emulator, stubbed TMDB/Trakt):** one test that wires the **real**
`createSyncEngine(...)` to the **real** `createFirestoreTitleCacheStore(db)` +
the `collectionGroup('watchlist')` gather + the `syncTitles` handler, with the
TMDB/Trakt HTTP transport **mocked/stubbed** (no live network, no secrets) but a
**real Firestore emulator** as the backing store. It asserts:

- **(a) Gather + dedupe.** A seeded watchlist spread across **multiple users**
  (the same `{ tmdbId, type }` tracked by more than one user, plus distinct
  titles) is gathered via `collectionGroup('watchlist')` and deduped to the
  correct set of distinct `{ tmdbId, type }` (a shared title is synced **once**).
- **(b) Real round-trip through the spec-0005 converters.** After a pass the
  engine has written real `title-cache/{tmdbId}` + `title-cache/{tmdbId}/
availability/{region}` docs that read back through `dataToTitleCache` /
  `dataToAvailability` to the expected `TitleCacheEntry` (incl. `traktId`, number
  and null) and `RegionAvailability` — proving the adapter's path builders +
  converters work against real Firestore, not just a fake.
- **(c) Snapshot roll across two sequential passes.** Running the sync **twice in
  sequence** against the same emulator persists the spec-0005 `previousSnapshot`
  transition correctly (pass 2 rolls pass 1's availability into
  `previousSnapshot`) — the round trip that a fake store cannot exercise.
- **(d) Boundary, for real.** After the passes, **no `users/**`doc has been
written** (the seeded watchlist docs are unchanged, none created/mutated) and`system/sync` **is** updated.

**This test is a CI gate, not a manual step.** It is **wired to run automatically
in GitHub Actions** (the CI job starts the Firestore emulator, runs the
integration suite, tears down — see Implementation task graph task 3), so a future
change that breaks the real adapter/gather/handler flow **fails CI**. Per project
memory the **Firestore emulator cannot run under Claude Code tools here (loopback
blocked)**, so the **implementing agent runs and verifies this test in the user's
own terminal locally** rather than in-session; CI is where it runs as the
automated regression gate. The mocked-SDK unit suites above still stand on their
own (they run in the default emulator-free `nx test`).

## Definition of done

Tailored from the PLAN §5 checklist to the projects touched and the gates that
exist (`functions-sync-titles` and `functions` both have inferred `typecheck` /
`lint` / `test` / `build` targets via the Nx vite plugin). No component / e2e
(no UI). The emulator integration check is an **automated CI gate** (above), run
locally in the user's terminal by the implementing agent because the emulator
cannot run under Claude Code tools here.

- [ ] `pnpm nx typecheck functions-sync-titles` passes — the adapter compiles
      against the merged 0008 `TitleCacheStore` port + spec-0005 converters.
- [ ] `pnpm nx typecheck functions` passes — the `syncTitles` handler + helpers
      compile.
- [ ] `pnpm nx lint functions-sync-titles` passes **with Sheriff active**: the
      adapter imports `@vultus/shared/firestore-schema`, `@vultus/shared/domain`,
      and `firebase-admin` only — no `scope:mobile`, no other slice. **The 0008
      engine still imports no Firebase SDK** (the SDK is confined to the new
      adapter file).
- [ ] `pnpm nx lint functions` passes with Sheriff: `apps/functions` imports
      `@vultus/functions/sync-titles` + `@vultus/shared/*` + Firebase packages
      only; no `scope:mobile`.
- [ ] `pnpm nx test functions-sync-titles` passes — adapter unit tests (mocked
      Admin SDK) green; **the existing 0006/0007/0008 tests still pass**.
- [ ] `pnpm nx test functions` passes — gating helpers + handler-wiring tests
      green (fake engine + fake `db`; no network, no emulator, no secrets).
- [ ] `pnpm nx build functions` passes — the deployable barrel (esbuild) builds
      with the real `syncTitles` export replacing `healthcheck`.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green (the
      affected set is `functions-sync-titles` + `functions` and any dependents).
- [ ] **The automated emulator-backed integration test passes** (real Firestore
      emulator + stubbed TMDB/Trakt): gather + dedupe across users, the spec-0005
      converter round-trip incl. `traktId`, the `previousSnapshot` roll across two
      sequential passes, and the no-`users/**`-write / `system/sync`-updated
      boundary. Verified by the implementing agent **locally in the user's own
      terminal** (the emulator cannot run under Claude Code tools — loopback
      blocked).
- [ ] **`.github/workflows/ci.yml` runs this as a gate:** the CI workflow starts
      the Firestore emulator, runs the integration target/suite as a **required**
      step, and tears down — so a future regression in the real adapter / gather /
      handler flow fails CI. No new dependency added (`firebase-tools` already
      present; verified).
- [ ] The barrel `@vultus/functions/sync-titles` exports
      `createFirestoreTitleCacheStore` **in addition to** all existing
      0006/0007/0008 exports (**none dropped**); internal DTO/http/mapper/engine
      internals stay unexported.
- [ ] `libs/functions/sync-titles/README.md` is updated **in the same change**:
      adapter in Public API + Internal layout, the "SDK enters only here" note,
      and Future-work rewritten to leave only #13 cron + #14 dispatch (per
      CLAUDE.md's lib-README rule). `apps/functions` README updated **only if one
      exists**.
- [ ] **Boundary verifications (review-checked, like 0008):** (a) **no secret is
      read or written** — params declared by name, read via `.value()` at
      runtime, never `.env.local`, never logged; secret compared constant-time;
      (b) **no `users/**`write and no notification write** — only`title-cache`    (via the engine port) and`system/sync`; (c) **the engine contract is
      unchanged** and the engine remains SDK-free.
- [ ] PR description records the exact verification commands (both projects),
      confirms the no-secret / no-`users/**`-write / no-SDK-in-engine boundaries,
      and notes the automated emulator integration test as a **CI gate** that the
      implementing agent verified locally in the user's terminal (the emulator
      cannot run under Claude Code tools here).

## Scaling & limits

v1 is single-user (dozens of titles). The build is a **bounded throttled single
pass + a configurable staleness window** now; fan-out is documented future work.
The ceilings and the escalation ladder, so they are designed-for not surprises:

- **Cloud Function wall-clock bites first.** A serial `engine.sync` pass × the
  in-slice HTTP transport's min-interval throttle (spec 0007's `http.ts`) caps a
  single invocation at roughly a **few hundred to ~1k distinct titles** before
  risking the function timeout. `apps/functions/src/main.ts` currently pins
  `maxInstances: 1`; a gen2 `onRequest` timeout is configurable up to **60 min**
  (`setGlobalOptions`/per-function `timeoutSeconds`) — raising it buys headroom
  but the serial pass is still the limit. The **global-union dedupe makes work
  scale with distinct titles, not users** — a title tracked by N users is synced
  once.
- **External rate limits** (TMDB ~50 req/s practical, Trakt ~1k/5min) are kept
  under by the **existing transport throttle + `429`/`Retry-After` retry** in the
  slice (0006/0007). This function adds no new external-call rate concern.
- **Firestore** reads scale with total tracked titles (one `collectionGroup`
  scan); writes are **~2 per title × regions returned**. On **Blaze** (per the
  project's Firebase setup) this is a **cost line, not a hard cap** — PLAN §9
  notes ~1000× personal headroom.
- **Escalation ladder (ALL future, OUT of scope here):** staleness window
  (**built**) → **resumable cursor** (bounded batch + a persisted cursor on
  `system/sync` spanning cron runs, so each invocation does a slice of the union)
  → **Cloud Tasks / Pub-Sub fan-out** with a raised `maxInstances` for parallel
  instances. None are built in this spec.

## Risks

- **PLAN §2-vs-§6 trigger conflict — resolved to `onRequest`.** PLAN §2 says
  "HTTP Cloud Function", PLAN §6 item 12 says "HTTPS callable". This spec picks a
  single `onRequest` function with dual auth **because the cron has no Firebase
  Auth context** and a callable cannot serve it. This is a deliberate resolution
  of the conflict, recorded here per the spec-author rule to flag PLAN conflicts
  rather than silently design around them. The single-function design preserves
  PLAN §2's "single code path for sync logic."
- **Idempotency is overwrite + rate-limit window, no key store.** The sync is
  naturally overwrite-idempotent (it `.set()`s `title-cache`), and the 5-minute
  window collapses rapid user retries; the cron runs daily. A duplicate cron
  hit within the same minute would re-do work but produce the same state — **no
  separate idempotency-key store is built**, which is the chosen, sufficient v1
  model. If exactly-once semantics are ever needed, add a run-id guard on
  `system/sync` — out of scope.
- **Staleness filter is in the function, not the engine.** The engine stays
  staleness-agnostic (0008 contract). The function reads each candidate's stored
  `lastSyncedAt` (via the store's `getEntry`, reusing the same adapter the engine
  uses — no extra read path) and drops fresh ones before `engine.sync`. Risk: a
  forced cron always refreshes everything (intended); a misconfigured window
  could over- or under-refresh — mitigated by it being a single named constant
  with a sane ~20h default and `filterStale` unit tests.
- **`collectionGroup` cost grows with total tracked titles.** Acceptable on Blaze
  with v1's volume (PLAN §9 headroom). If it ever dominates, the resumable-cursor
  step in the ladder bounds per-run work — future.
- **Data-source accuracy is not this function's concern (PLAN §9).** It writes
  whatever the engine derives from TMDB; the Watchmode fallback is later.
- **Emulator verification is an automated CI gate (run locally by the agent).**
  The Admin-SDK adapter + the `collectionGroup` query are unit-tested with a
  mocked SDK; on top of that, the real-Firestore behaviour is an **automated
  emulator-backed integration test wired into `.github/workflows/ci.yml`** (the
  emulator runs fine in GitHub Actions), so a subtle SDK/path mismatch is caught
  by CI as a regression gate rather than relying on an honor-system manual check.
  The reason the **implementing agent** verifies it **locally in the user's own
  terminal** rather than in-session is that the Firestore emulator (any Java NIO
  loopback server) **cannot run under Claude Code tools here** (project memory) —
  not because the check is optional. Mitigation remains that the adapter is a thin
  map onto the already-tested spec-0005 path builders + converters, and the
  integration test now exercises that map against real Firestore.
- **Spec 0008 must be implemented (not just spec-merged) before this lands.**
  This spec's adapter implements 0008's `TitleCacheStore` port and the handler
  imports `createSyncEngine` + `traktId`-bearing `TitleCacheEntry` from 0008's
  surface. If 0008's feature PR is not yet merged to `main`, the implementer must
  verify the actual merged barrel exports + the `traktId` field before coding the
  adapter signatures (stated in Public types / APIs). No PLAN conflict otherwise —
  this is PLAN §6 item 12 implemented faithfully, with #13 and #14 deferred.
