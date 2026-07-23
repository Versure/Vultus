---
number: 0100
slug: indexed-dispatch-lookups
title: Indexed tracking-user lookups in notification dispatch
status: implementing
slices: []
scopes: [scope:functions]
created: 2026-07-22
---

# Indexed tracking-user lookups in notification dispatch

## Context

The notification dispatcher's watchlist adapter finds the users tracking a title
by reading the **entire** `watchlist` collection group and filtering in memory:

```ts
// apps/functions/src/dispatch/adapters.ts:34-39
async findUsersTracking(tmdbId: number): Promise<TrackingUser[]> {
  const snap = await db.collectionGroup('watchlist').get();
  const matches = snap.docs.filter((doc) => {
    const data = doc.data() as { tmdbId?: number; status?: WatchStatus };
    return data.tmdbId === tmdbId;
  });
  ...
```

This runs on **every** fire of `dispatchNotifications`, whose trigger is
`onDocumentWritten('title-cache/{tmdbId}/availability/{region}')`
(`apps/functions/src/dispatch-notifications.ts:108-114`). Availability docs are
written per-region during the nightly sync, so a single synced title fires the
trigger up to ~10 times per night (one per region; `REGIONS` has 10 members).
Each fire costs **O(total watchlist docs across all users)** reads.

At the design target this is catastrophic: 100k users × ~50 tracked titles = ~5M
document reads **per fire**, and billions of reads per night — while the actual
result set (users tracking that one `tmdbId`) is tiny. The scan is pure waste:
the docs already carry the field we need to index on.

Intended outcome: make each fire cost **O(users tracking that `tmdbId`)** by
replacing the scan with an indexed collection-group query, with **no change** to
notification behavior.

## Scope

In scope:

- Replace the unindexed scan in `createFirestoreWatchlistStore.findUsersTracking`
  (`apps/functions/src/dispatch/adapters.ts`) with an indexed collection-group
  query: `db.collectionGroup('watchlist').where('tmdbId', '==', tmdbId).get()`.
  The subsequent per-user join (region + prefs + tokens + status) is unchanged.
- Add the Firestore **collection-group index** for `watchlist.tmdbId` to
  `firestore.indexes.json` so the query is servable in prod.
- Update the adapter/unit tests that exercise `findUsersTracking` to assert the
  indexed query is issued.

Out of scope:

- The **once-per-run** full collection-group gathers in the nightly sync
  pipeline — `apps/functions/src/lib/firestore-io.ts` (gather),
  `apps/functions/src/sync-episodes.ts` (episode pass), and the airing-scan's own
  inline `db.collectionGroup('watchlist').get()` in
  `apps/functions/src/dispatch-episode-aired.ts:93`. These are a **different
  shape** (once per nightly run, not once per write) and are addressed by
  **spec 0101 (sync-pipeline sharding)**, drafted in parallel. Verified in code:
  `findUsersTracking` is called **only** on the availability path
  (`dispatcher.ts:230`); the episode-aired scan enumerates tracked shows with its
  **own** inline scan and does **not** route through `findUsersTracking`, so there
  is no shared per-title lookup helper to change here. Touching the episode-aired
  scan is left to 0101.
- Any change to notification recipients, doc ids, FCM payloads, delivery-window
  gate, or the dispatcher core.
- Any data migration (no field is added or reshaped).

## Affected slices & Sheriff tags

- `apps/functions` (`scope:functions`) — the adapter change lives here
  (`src/dispatch/adapters.ts`) and its test (`src/dispatch-notifications.spec.ts`).
- Root infra — `firestore.indexes.json` (no slice/scope; a root config file).

No cross-slice imports are introduced. The query stays in the `apps/functions`
adapter — the hexagonal port (`@vultus/functions/dispatch-notifications`
`WatchlistStore`) is **unchanged**, so `libs/functions/dispatch-notifications` is
not touched (its README needs no update; no public surface changes). No
`scope:shared` or `scope:mobile` code is involved.

## Data model touchpoints

- **Collection group:** `users/{userId}/watchlist/{titleId}` (PLAN §4). The
  documents already carry `tmdbId: number` — the field the new query filters on.
  **No new field, no converter change, no migration.**
- **`firestore.indexes.json`** — add a collection-group index enabling
  `where('tmdbId', '==', …)` at `COLLECTION_GROUP` query scope for the
  `watchlist` collection group. The file currently holds
  `{ "indexes": [], "fieldOverrides": [] }`. A single-field collection-group
  equality query requires enabling the collection-group scope for that field,
  expressed as a `fieldOverrides` entry, e.g.:

  ```json
  {
    "fieldOverrides": [
      {
        "collectionGroup": "watchlist",
        "fieldPath": "tmdbId",
        "indexes": [
          { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" },
          { "order": "DESCENDING", "queryScope": "COLLECTION_GROUP" }
        ]
      }
    ]
  }
  ```

  (The implementer should confirm the exact shape the Firebase CLI emits/validates
  for a single-field collection-group override; the load-bearing requirement is
  **a `COLLECTION_GROUP`-scoped index on `watchlist.tmdbId`**. If the CLI prefers a
  composite `indexes` entry over a `fieldOverrides` entry, either is acceptable so
  long as `deploy` accepts it and the equality query is servable.)

- **`firestore.rules`** — **unaffected.** The dispatcher runs in Cloud Functions
  via the Admin SDK, which **bypasses security rules**; the query needs no rule
  change. Stated explicitly so the reviewer sees rules were considered and
  correctly excluded — there is no rules-test obligation for this spec.

## Public types / APIs

None. `WatchlistStore.findUsersTracking(tmdbId: number): Promise<TrackingUser[]>`
(port in `libs/functions/dispatch-notifications/src/lib/ports.ts`) keeps its exact
signature and contract ("users tracking `tmdbId`, any region"). Only the adapter's
**implementation** of the query changes. No `shared/domain` change → no repo-wide
ripple; F2 probe resolves to none.

## UI / Stitch screen refs

N/A — backend-only (`scope:functions`). No mobile UI, no Stitch screen.

## Implementation task graph

1. **[sequential] Add the collection-group index to `firestore.indexes.json`.**
   File manifest: `firestore.indexes.json`. Add the `COLLECTION_GROUP`-scoped
   index/override for `watchlist.tmdbId` (see Data model touchpoints). Sequenced
   first because the query in task 2 depends on this index existing to be servable
   in prod, and the rollout order (indexes before functions) mirrors it. This is
   the F1-probe task: the `firestore.indexes.json` change has an explicit owning
   task and is not folded into the code task's manifest by accident.

2. **[sequential] Swap the scan for the indexed query in the adapter + update
   tests.** File manifest: `apps/functions/src/dispatch/adapters.ts`,
   `apps/functions/src/dispatch-notifications.spec.ts`. Replace
   `db.collectionGroup('watchlist').get()` + in-memory `.filter(tmdbId === …)`
   with `db.collectionGroup('watchlist').where('tmdbId', '==', tmdbId).get()` and
   drop the now-redundant in-memory tmdbId filter (the per-user join, status
   fallback, and prefs pass-through logic on lines 41-71 are unchanged). Update
   the test doubles (see Test plan). Update the adapter's doc-comment
   (`adapters.ts:27-31`) which currently describes "scanning the group and
   matching `tmdbId`".

Both tasks are `[sequential]` (single scope, overlapping concern, and an ordering
dependency); there is no parallel fan-out for this spec.

## Test plan

Unit (Vitest, in `apps/functions/src/dispatch-notifications.spec.ts` — the file
that already covers `createFirestoreWatchlistStore.findUsersTracking`, spec 0088):

- **Issues the indexed query.** Extend the `createWatchlistDb` fake (currently
  `collectionGroup = () => ({ get: … })`) to expose a `where` method that records
  its arguments and returns the `{ get }` object, i.e.
  `collectionGroup = () => ({ where: (field, op, value) => { captured = {field, op, value}; return { get }; } })`.
  Add a test asserting `findUsersTracking(603)` calls `where` with exactly
  `('tmdbId', '==', 603)`. This is the acceptance check that the O(all-docs) scan
  is gone.
- **Behavior unchanged (regression).** Keep the existing spec-0088 assertions
  green: a matched doc with `status: 'completed'` yields a `TrackingUser` with
  that status; a doc missing `status` falls back to `'watching'`. Update the fake
  so the query result (the `where(...).get()` docs) drives these — the returned
  `TrackingUser` shape (uid, titleId, region, prefs, fcmTokens, status) must be
  byte-for-byte what it is today.
- **Full `handleDispatch` path stays green.** The existing removed-transition /
  availability end-to-end tests (`createRemovedDispatchDb` and siblings) exercise
  the adapter through the dispatcher; their fakes' `collectionGroup` doubles must
  be updated to the `where(...).get()` shape so the whole dispatch flow (same
  recipients, same idempotent doc ids, same FCM sends) still passes unchanged.

Command (real Nx project name — the functions app is `functions`):

```
pnpm nx test functions
```

No rendered-text assertions are involved (backend only), so the exact-string /
no-whitespace-normalize rule does not apply here.

**e2e:** No e2e flows required — backend/infra change only, with no user-facing
route or action change. (Per CLAUDE.md the Firestore emulator cannot run
in-session; the emulator-gated e2e suite runs in CI regardless, but this spec
adds no new flow to it.)

## Definition of done

- [ ] `findUsersTracking` issues `collectionGroup('watchlist').where('tmdbId','==',tmdbId).get()`
      and no longer reads the whole collection group; the in-memory tmdbId filter
      is removed (task 2).
- [ ] `firestore.indexes.json` contains a `COLLECTION_GROUP`-scoped index/override
      for `watchlist.tmdbId` that `firebase deploy` accepts (task 1).
- [ ] Adapter doc-comment updated to describe the indexed query, not a scan
      (task 2).
- [ ] Unit test asserts the `where('tmdbId','==',…)` collection-group query is
      issued; existing spec-0088 status tests and the `handleDispatch`
      availability/removed-transition tests remain green with updated fakes
      (task 2).
- [ ] `pnpm nx test functions`, `pnpm nx lint` (incl. Sheriff), `pnpm nx build`
      all green.
- [ ] `pnpm nx run functions:deploy-preflight` green (the change is inside
      `apps/functions`; no dep change is expected, but the gate confirms the
      pruned bundle still loads).
- [ ] No `firestore.rules` change (Admin SDK bypasses rules) — noted, no
      rules-test added.

## Risks

- **FAILED_PRECONDITION if the index is missing in prod at deploy time.** A
  collection-group equality query throws `FAILED_PRECONDITION` until its index is
  built. **Rollout order matters: deploy `firestore.indexes.json` (and let the
  index finish building) BEFORE deploying the updated function.** Record this in
  the deploy notes for `/deploy-functions`. Index build time on the current data
  volume is trivial; at the design target it is a one-time background build.
- **Query result completeness vs the old scan.** The old scan matched any doc with
  `data.tmdbId === tmdbId`, including docs where `tmdbId` might be stored as a
  non-number by a legacy writer. Verified in the codebase that watchlist docs are
  written with `tmdbId: number` (PLAN §4; the doc id is `titleId` and `tmdbId` is
  a typed field). An equality query on `tmdbId` returns exactly those docs, so
  behavior is equivalent for correctly-typed docs. Any doc with a mistyped/absent
  `tmdbId` was already effectively invisible to notifications (it could match only
  by JS `===`, which the indexed query reproduces for the number case). No
  behavior regression is expected for real data.
- **Out-of-scope neighbors remain expensive.** The nightly once-per-run scans
  (firestore-io gather, sync-episodes, dispatch-episode-aired's inline scan) are
  untouched and still O(all watchlist docs) per nightly run. That is intentional
  and owned by spec 0101; this spec does not regress or improve them.
- **No PLAN conflict.** The change stays within `scope:functions`, introduces no
  cross-slice import, and uses only fields already in PLAN §4.
