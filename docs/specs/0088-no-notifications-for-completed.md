---
number: 0088
slug: no-notifications-for-completed
title: Suppress availability/episode notifications for completed or dropped watchlist items
status: implementing
slices: [slice:dispatch-notifications]
scopes: [scope:functions]
created: 2026-07-21
---

# Suppress availability/episode notifications for completed or dropped watchlist items

## Context

GitHub issue #237 (Versure/Vultus) — issue text is **data**, per CLAUDE.md spec 0068 —
reports: "Notifications should not be sent for tv shows or movies that are marked as
completed. Now available notifications should not be sent for items in the watchlist
that have been marked as completed." Once a user is done with a title, a fresh
availability change (or a newly-aired episode) for it should **not** re-surface it in
their notifications inbox or as an OS push.

Verified against `main`, the notification dispatcher never looks at the user's watch
status, so a `'completed'` (or `'dropped'`) item still fires notifications:

- **`libs/functions/dispatch-notifications/src/lib/ports.ts:12-18`** — `TrackingUser`
  carries `uid`, `region`, `notificationPrefs`, `fcmTokens`, `titleId`, but **no
  `status`**. The port has no way to know a tracked item's watch status.
- **`apps/functions/src/dispatch/adapters.ts:33-67`** —
  `createFirestoreWatchlistStore.findUsersTracking` scans the `watchlist` collection
  group, matches on `tmdbId` only (`doc.data() as { tmdbId?: number }`, `:38`), and
  builds each `TrackingUser` from the matched watchlist doc + its parent `users/{uid}`
  doc (`region`, `notificationPrefs`, `fcmTokens`). It **never reads the watchlist
  doc's own `status` field**, even though every `WatchlistItem` has one
  (`libs/shared/domain/src/lib/documents.ts:73`, `status: WatchStatus`; `WatchStatus`
  = `'watching' | 'completed' | 'dropped' | 'planned'`,
  `libs/shared/domain/src/lib/enums.ts:5-11`).
- **`libs/functions/dispatch-notifications/src/lib/dispatcher.ts:183-184`** —
  `dispatch()` filters `allUsers` by region only
  (`allUsers.filter((u) => u.region === change.region)`), then calls
  `dispatchForUser` for **every** matched user regardless of watch status. So a user
  who marked a movie/show `'completed'` (or `'dropped'`) still gets `movie-available`
  / `show-came-to-platform` / `episode-aired` inbox docs **and** FCM pushes when a new
  availability change or episode fires for that title. **This is the bug.**

**Scope decision made in the architect interview (D1):** the fix excludes **both
`'completed'` and `'dropped'`**, not just the issue's literal "completed". Both statuses
mean the user is done tracking the title; suppressing only `'completed'` would leave a
near-identical follow-up issue for `'dropped'`. `'watching'` and `'planned'` items are
unaffected.

Note: spec 0074 (merged, `done`) already reverts a `'completed'` TV show back to
`'watching'` when a new unwatched episode is inserted, so an `episode-aired` kind rarely
coincides with a still-`'completed'` status in practice. This fix does **not** rely on
that as its only protection — it is a defensive, blanket simplicity argument (D2), and
`episode-aired` is filtered too.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Excluded statuses: `'completed'` AND `'dropped'`.** Both mean the user is done
tracking the title; neither should generate ANY notification (movie-available,
show-came-to-platform, episode-aired) for it. `'watching'` and `'planned'` are
unaffected. This is a deliberate broadening beyond the issue's literal "completed"
wording (same reasoning applies to `'dropped'`; avoids a near-identical follow-up).

**D2. All notification kinds are suppressed** for an excluded-status item — not just the
two availability kinds. A single per-user status check gates the entire
`dispatchForUser` call, **before** any kind-decision logic (`decideKinds`) runs. Simpler
rule: once a title is completed/dropped for a user, that user gets zero pushes about it,
full stop (including `episode-aired`).

**D3. Implementation shape — add `status` to the port, filter in the pure dispatcher
core:**

- Add `status: WatchStatus` to the `TrackingUser` interface in
  `libs/functions/dispatch-notifications/src/lib/ports.ts`. Import `WatchStatus` from
  `@vultus/shared/domain` (`scope:shared` — already an allowed import for this lib;
  `ports.ts` already imports `FcmToken`/`NotificationDoc`/`NotificationPrefs`/`Region`
  from there, so **no new Sheriff edge** is introduced).
- In `apps/functions/src/dispatch/adapters.ts`, `findUsersTracking`: the loop already
  has the matched watchlist doc's `data` (currently cast narrowly as
  `{ tmdbId?: number }` for the pre-filter, `:38`). Widen that cast to
  `{ tmdbId?: number; status?: WatchStatus }` and include `status` when pushing to
  `users`. **Safe fallback for a legacy/malformed doc missing `status`:**
  `data.status ?? 'watching'` — i.e. a missing/unrecognized status maps to a
  **notifiable** value, NOT an excluded one. Rationale: `status` is a required field on
  the domain `WatchlistItem`, so a missing value is only ever a legacy/malformed doc;
  defaulting it to an **excluded** status would silently suppress notifications for a
  normal user, which is the more harmful failure mode. Defaulting to `'watching'`
  (notifiable) preserves current behavior for any anomalous doc.
- In `libs/functions/dispatch-notifications/src/lib/dispatcher.ts`, `dispatch()`
  (`:184`): chain the status exclusion into the **same** filter line that does the
  region filter — `allUsers.filter((u) => u.region === change.region && u.status !==
'completed' && u.status !== 'dropped')` — so the exclusion happens **before**
  `usersConsidered` (`:205`) is computed from `users.length`.
- **`usersConsidered` semantic (spec-recorded):** with this change `usersConsidered` in
  `DispatchSummary` reflects only region-matched **AND** status-eligible users — "users
  this dispatch would actually consider notifying." This is consistent with how the
  pre-existing region filter already narrows the count before `users.length` is read.
  This is a fully additive change to the `user()` test factory (no current fixture sets
  `status`), so it changes no existing test expectation.
- **No change to `decideKinds` / `transitions.ts`.** The kind-decision logic is
  unaffected; the exclusion happens one layer up, before a user is dispatched to at all.

**D4. No `scope:shared` change.** `WatchStatus` already exists and is exported from
`@vultus/shared/domain` (`enums.ts:11`); it is consumed as-is. **No new shared field, so
no F2 shared-type ripple.**

**D5. No `User` domain field change — F4 onboarding-parity probe does NOT apply.** This
feature only **reads** the existing `WatchlistItem.status` field; it adds/changes no
field on the `User` domain type (`documents.ts`). No onboarding resolution is required.

**D6. No cross-scope import.** `scope:functions` only; no `scope:mobile` file is touched.
The dispatcher lib stays Firebase-free (status arrives via the port); the Admin-SDK read
lives only in `apps/functions`.

**D7. No `firestore.rules` / `firestore.indexes.json` change.** The adapter still does
the same `collectionGroup('watchlist').get()` scan (Admin SDK, rules-exempt) and now
reads one more **already-existing** field (`status`) off docs it already fetches — no new
query shape, no new `where`/`orderBy`, no new index. Verify-and-record "no change
needed."

**D8. Cloud Functions deploy gate applies.** Because both `apps/functions` **and** a
`scope:functions` lib change, the DoD MUST include `pnpm nx run functions:deploy-preflight`
(a CI gate), and shipping requires the separate manual `/deploy-functions` step — do
**NOT** deploy from the spec/implement flow. See CLAUDE.md "Cloud Functions deploy gate."

**D9. No new UI / Stitch screen.** Backend-only notification-suppression rule; no UI
touchpoint. See the UI section.

## Scope

**In scope:**

- **`slice:dispatch-notifications`** — add `status: WatchStatus` to the `TrackingUser`
  port; add the `completed`/`dropped` exclusion predicate to the `dispatch()`
  region-filter line; unit tests; README.
- **`apps/functions`** — `findUsersTracking` adapter reads `status` off the matched
  watchlist doc (with the `?? 'watching'` legacy fallback) and includes it on the built
  `TrackingUser`; unit test for the read + fallback.
- README update for the one changed lib
  (`libs/functions/dispatch-notifications/README.md`).

**Out of scope:**

- **`scope:shared` change** (D4): `WatchStatus` exists and is consumed as-is — no new
  field, no converter change.
- **Any `User` domain-field / onboarding change** (D5) — this only reads
  `WatchlistItem.status`.
- **Any `scope:mobile` change** (D6) — backend-only.
- **`decideKinds` / `transitions.ts` change** (D3) — the exclusion is one layer up.
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `.github/workflows/ci.yml`, `apps/mobile-e2e/playwright.config.ts`** — no change (D7;
  verify-and-record).
- **New UI / Stitch screen** (D9) — no visual element.
- **New e2e flow** — not a new page/route/critical mobile UI action; a Cloud Function
  pure-logic change covered by unit tests only (see Test plan e2e subsection).

## Affected slices & Sheriff tags

| Project                          | Path                                    | Sheriff tags                                      | Change                                                                                                                   |
| -------------------------------- | --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| functions-dispatch-notifications | `libs/functions/dispatch-notifications` | `scope:functions`, `slice:dispatch-notifications` | Add `status: WatchStatus` to `TrackingUser`; add `completed`/`dropped` exclusion to `dispatch()`'s filter; tests; README |
| functions (app)                  | `apps/functions`                        | `scope:functions`                                 | `findUsersTracking` reads `status` off the watchlist doc (`?? 'watching'` fallback) and sets it on `TrackingUser`; test  |

- **No cross-scope / cross-slice import (D6).** The `dispatch-notifications` lib adds one
  import to `ports.ts`: `WatchStatus` from `@vultus/shared/domain` (`scope:shared`,
  importable by anyone — Sheriff rule 4); it already imports other types from that
  barrel, so no new module boundary edge. It stays Firebase-free and imports no other
  slice. `apps/functions` may import `@vultus/functions/*` + `@vultus/shared/*` +
  Firebase (Sheriff rule 3) and already does so in `adapters.ts`. **No
  `scope:mobile ↔ scope:functions` edge is introduced.**
- **No `shared/` extraction.** The exclusion lives inside
  `slice:dispatch-notifications`; no logic is duplicated across 3+ slices.
- **No `sheriff.config.ts` change.** No new lib; the existing path globs already tag
  `libs/functions/dispatch-notifications/src` and `apps/functions`. Record "no
  `sheriff.config.ts` change needed."

## Data model touchpoints

PLAN §4 paths. **No new field, no new collection, no converter change** (D4).

| PLAN §4 path                                                           | Access                                     | By                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}` (via `collectionGroup('watchlist')`) | **read (`status`)** — functions, Admin SDK | `findUsersTracking` — the doc is **already fetched** for the `tmdbId` match; this reads one more existing field off it |

- The adapter already scans `collectionGroup('watchlist').get()` and reads
  `doc.data()`; it now reads `data.status` (existing field) in addition to
  `data.tmdbId`. **No new read, no new query shape.**
- **No `firestore.rules` change — VERIFY and RECORD (D7).** The read uses the **Admin
  SDK** (bypasses security rules). Do **NOT** edit `firestore.rules`.
- **No `firestore.indexes.json` change — VERIFY and RECORD (D7).** The scan is the
  existing unindexed collection-group `get()` with an in-memory `tmdbId` filter — no
  `where`/`orderBy` is added, so no composite index is needed. Record "no index change
  needed."

## Public types / APIs

No HTTP endpoint, no callable, **no `scope:shared` type change** (D4).

### `slice:dispatch-notifications` — `TrackingUser` port (additive field)

`src/lib/ports.ts` — add `status` and import `WatchStatus`:

```ts
import type {
  FcmToken,
  NotificationDoc,
  NotificationPrefs,
  Region,
  WatchStatus,
} from '@vultus/shared/domain';

export interface TrackingUser {
  uid: string;
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  titleId: string; // the watchlist doc id for this user's tracking of the title
  /** The user's watch status for this title (spec 0088). Used by the dispatcher
   *  to suppress ALL notifications when the user is done with the title
   *  ('completed' or 'dropped'). A missing/legacy value is mapped by the adapter
   *  to a notifiable status ('watching'), never to an excluded one. */
  status: WatchStatus;
}
```

### `slice:dispatch-notifications` — `dispatch()` filter (binding intent)

`src/lib/dispatcher.ts:184` — extend the existing region filter with the exclusion
(the placement, before `usersConsidered`, is the contract, per D3):

```ts
const allUsers = await watchlist.findUsersTracking(change.tmdbId);
// Region filter + completed/dropped suppression (spec 0088): once a user is
// done with a title, they get ZERO notifications about it (all kinds). Applied
// BEFORE usersConsidered is computed, so usersConsidered counts only users this
// dispatch would actually consider notifying.
const users = allUsers.filter(
  (u) =>
    u.region === change.region &&
    u.status !== 'completed' &&
    u.status !== 'dropped',
);
```

No change to `dispatchForUser`, `decideKinds`, `transitions.ts`, `DispatchSummary`'s
shape, or the barrel surface. `usersConsidered` (`:205`) continues to read
`users.length` — now narrowed by the added predicate (spec-recorded semantic, D3).

### `apps/functions` — `findUsersTracking` reads `status` (D3)

`apps/functions/src/dispatch/adapters.ts` — widen the doc-data cast and set `status` on
the built user; import `WatchStatus`:

```ts
import type {
  FcmToken,
  NotificationPrefs,
  Region,
  WatchStatus,
} from '@vultus/shared/domain';

// pre-filter (was `{ tmdbId?: number }`):
const data = doc.data() as { tmdbId?: number; status?: WatchStatus };
// …existing tmdbId match unchanged…

// when building each TrackingUser, read status off the SAME matched doc:
const matchedData = doc.data() as { status?: WatchStatus };
users.push({
  uid,
  titleId,
  region: userData.region,
  notificationPrefs: userData.notificationPrefs,
  fcmTokens: userData.fcmTokens ?? [],
  status: matchedData.status ?? 'watching', // legacy/malformed → notifiable (spec 0088)
});
```

Binding contract: the fallback for a missing/unrecognized `status` is **`'watching'`**
(notifiable) — never `'completed'`/`'dropped'` — so an anomalous doc never silently
suppresses a normal user's notifications (D3).

## UI / Stitch screen refs

**No new Stitch screen and no new visual element** (D9). This is a backend-only
notification-suppression rule in the Cloud Functions dispatch flow — there is no mobile
page, route, component, or token touched. Record "no new UI element — backend
notification-suppression rule only; no Stitch capture required" in the PR.

## Implementation task graph

Single scope (`scope:functions`), small and cohesive — **one implementation task**
routed to **backend-engineer**. The port field (`libs`) and the adapter read
(`apps/functions`) are one logical change and share no file, but the adapter's
`status: matchedData.status ?? 'watching'` line depends on the port carrying `status`;
keeping them in a single sequential task avoids an intermediate typecheck failure.

### Manifest (single task — no parallel fan-out)

- **Task A — completed/dropped notification suppression [sequential]**
  (backend-engineer).
  Manifest:
  - `libs/functions/dispatch-notifications/src/lib/ports.ts`
  - `libs/functions/dispatch-notifications/src/lib/dispatcher.ts`
  - `libs/functions/dispatch-notifications/src/lib/dispatcher.spec.ts`
  - `libs/functions/dispatch-notifications/README.md`
  - `apps/functions/src/dispatch/adapters.ts`
  - `apps/functions/src/dispatch-notifications.spec.ts`
  1. `ports.ts`: add `status: WatchStatus` to `TrackingUser`; import `WatchStatus`
     from `@vultus/shared/domain`.
  2. `dispatcher.ts`: extend the `dispatch()` region-filter line (`:184`) with
     `&& u.status !== 'completed' && u.status !== 'dropped'` (D3), before
     `usersConsidered` is read.
  3. `adapters.ts`: widen the `doc.data()` cast to include `status?: WatchStatus` and
     set `status: matchedData.status ?? 'watching'` on the built `TrackingUser` (D3).
  4. `dispatcher.spec.ts`: add a `status` field to the `user()` factory defaulting to
     `'watching'` (so all current cases keep passing unchanged); add the new suppression
     cases (Test plan).
  5. `dispatch-notifications.spec.ts`: add a `findUsersTracking` adapter test asserting
     `status` is read off the watchlist doc and that a doc with no `status` maps to
     `'watching'` (Test plan).
  6. `libs/functions/dispatch-notifications/README.md`: document the completed/dropped
     suppression rule, the new `TrackingUser.status` field, and the `usersConsidered`
     semantic.

  No file appears in more than one manifest slot; nothing under `libs/shared/**`,
  `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`, `ci.yml`, or
  `playwright.config.ts` is touched.

## Test plan

Per the PLAN §5 pyramid. All unit tests run on **Vitest**; all Firebase access is
mocked/faked (no live Firebase, no emulator, no network, no secrets).

**Rendered-text note (F3):** no test in this feature asserts on rendered UI text (it is
a backend pure-logic + adapter change), so there is no whitespace-normalization or
exact-string concern here.

**Unit — `dispatcher.spec.ts` (Vitest, in-memory fake ports).** Extend the existing
suite; first add `status: 'watching'` to the `user()` factory (`:44-51`) so every
current case is unchanged, then add:

- **`status: 'completed'`** (single user tracking the title) → dispatch() writes **NO**
  notification and sends **NO** FCM for that user; `usersConsidered` does **not** count
  them (`0`), `notificationsWritten` / `fcmSent` are `0`.
- **`status: 'dropped'`** → same as above.
- **`status: 'watching'`** and **`status: 'planned'`** → unaffected; notifications fire
  exactly as before (regression coverage — the existing default-`'watching'` cases
  already cover `'watching'`; add an explicit `'planned'` case).
- **Mixed statuses on the same title** (e.g. two in-region users, one `'watching'` and
  one `'completed'`) → only the eligible (`'watching'`) user gets a notification;
  `usersConsidered` / `notificationsWritten` / `fcmSent` reflect **only** the eligible
  one (`1`).
- **TV title + aired episode, `status: 'completed'`** (`type: 'tv'`,
  `episodesByUser` with an aired air date) → the `episode-aired` notification does
  **NOT** fire either — confirms D2's blanket suppression, not just the availability
  kinds. (`stores.written` empty, `usersConsidered` 0.)

**Unit — `apps/functions` adapter (`dispatch-notifications.spec.ts`, fake `db`).**
Extend the existing suite; add a `findUsersTracking` group (the current file's fake
`collectionGroup().get()` returns `{ docs: [] }`, so add a fake that serves a matched
watchlist doc + its parent user doc):

- `findUsersTracking` reads `status` off the matched watchlist doc and sets it on the
  returned `TrackingUser` (e.g. a doc with `status: 'completed'` → the built user has
  `status: 'completed'`).
- A watchlist doc **missing `status`** (legacy/malformed) → the built user's `status`
  is **`'watching'`** (the `?? 'watching'` fallback), i.e. treated as notifiable, not
  excluded.

**Component:** **none required.** Backend-only change; no mobile component or template is
touched. Stated explicitly rather than omitted.

**e2e (Playwright): none required — backend/Cloud-Function pure-logic change only.**
Per the e2e rubric this is a `scope:functions` change with no new mobile page, route, or
critical UI action, so no e2e flow is warranted. Stated explicitly rather than omitted.

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A above.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected set
      is `functions-dispatch-notifications` and `functions`. (Task A)
- [ ] **Sheriff clean** (in the lint above): no cross-scope import
      (`scope:mobile ↔ scope:functions`); the `dispatch-notifications` lib stays
      Firebase-free (its only new import is `WatchStatus` from `@vultus/shared/domain`,
      already an allowed edge). (Task A)
- [ ] `pnpm nx run functions:deploy-preflight` green (D8 — CI gate for the
      `apps/functions` + `scope:functions` lib change). (Task A)
- [ ] **Unit tests** as in the Test plan: dispatcher suppression (`'completed'` →
      nothing, `'dropped'` → nothing, `'watching'`/`'planned'` unaffected, mixed-status
      → only eligible user, `episode-aired` also suppressed when `'completed'`,
      `usersConsidered` reflects the narrowed set); adapter reads `status` off the
      watchlist doc and maps a missing `status` to `'watching'`. (Task A)
- [ ] **Lib README updated** (CLAUDE.md lib-README rule):
      `libs/functions/dispatch-notifications/README.md` documents the completed/dropped
      suppression rule, the `TrackingUser.status` field, and the `usersConsidered`
      semantic. No other lib README changes. (Task A)
- [ ] **Verify-and-record NO change (D4/D5/D7):** `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, `.github/workflows/ci.yml`,
      `apps/mobile-e2e/playwright.config.ts`, all `scope:shared` files, and the `User`
      domain type are **NOT** modified — the read uses the Admin SDK (rules-exempt),
      adds no query shape (no index), consumes the existing `WatchStatus` (no new shared
      field), and touches no `User` field (F4 not applicable).
- [ ] **Guardrail verifications (review-checked):** (a) the exclusion is chained into the
      **same** `dispatch()` filter line and evaluated **before** `usersConsidered` is
      computed (D3); (b) the fallback for a missing/unrecognized `status` is `'watching'`
      (notifiable), never an excluded status (D3); (c) `episode-aired` is suppressed too,
      not just the availability kinds (D2); (d) no `scope:mobile` file touched (D6); (e)
      **no secret read or written**; (f) deploy is left to the separate manual
      `/deploy-functions` step (NOT auto-run from the implement flow, D8).
- [ ] **No new UI element** (D9). Record "backend notification-suppression rule only; no
      Stitch capture required" in the PR.
- [ ] **No new e2e flow** — backend/Cloud-Function change only (recorded in the Test
      plan). The e2e suite is unchanged and stays green.
- [ ] **PR description records:** the single-scope nature (`scope:functions`), the
      `functions:deploy-preflight` requirement + that deploy is a separate manual
      `/deploy-functions` step, the deliberate broadening to include `'dropped'` (D1),
      and the `usersConsidered` semantic change (D3).

## Risks

- **`usersConsidered` semantic change.** `usersConsidered` now excludes
  completed/dropped users, not just out-of-region ones. This changes the observable
  `DispatchSummary` for any dispatch where a completed/dropped user tracks the title.
  **Mitigation:** no existing test fixture sets `status` (the `user()` factory defaults
  to `'watching'` in this change), so all current expectations are unchanged; the new
  cases assert the narrowed count explicitly. Flagged in the PR so a reviewer expects the
  count to mean "eligible users," consistent with how the region filter already narrowed
  it.
- **Legacy/malformed watchlist docs missing `status`.** `status` is a required
  `WatchlistItem` field, so a missing value should never occur for a normal user, but a
  legacy or partially-written doc could lack it. **Mitigation:** the adapter defaults a
  missing `status` to `'watching'` (notifiable), so an anomalous doc **fails open**
  (keeps notifying) rather than silently suppressing a real user's notifications; covered
  by the adapter fallback unit test.
- **Interaction with spec 0074 (`completed → watching` revert on new episodes).** Because
  0074 reverts a still-watched-through show back to `'watching'` when a new episode is
  inserted, most `episode-aired` dispatches will already see `'watching'` and are
  unaffected by this filter. This spec does **not** depend on that — the blanket D2
  suppression is correct on its own even if the revert had not shipped. Noted so the
  overlap is understood as defense-in-depth, not a conflict.
- **Single-scope Cloud Functions deploy gate.** `functions:deploy-preflight` must pass,
  and the actual deploy is a **separate manual** `/deploy-functions` step — do NOT deploy
  from the spec/implement flow (D8). Flagged so a reviewer does not expect the PR to ship
  functions.
- **No PLAN conflict.** This reads the existing PLAN §4
  `users/{uid}/watchlist/{titleId}` `status` field via the existing collection-group
  scan, and the spec-0012 dispatcher port/adapter pattern. No new field, no new
  collection, no new dependency, no `scope:shared` change, no `User`-field/onboarding
  impact.
  </content>
  </invoke>
