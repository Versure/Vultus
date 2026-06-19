---
number: 0012
slug: notification-dispatcher
title: Add the notification dispatcher — Firestore trigger, transition detection, FCM dispatch
status: approved
slices: [slice:dispatch-notifications]
scopes: [scope:functions]
created: 2026-06-19
---

# Add the notification dispatcher — Firestore trigger, transition detection, FCM dispatch

## Context

PLAN §6 item 14 — the **notification dispatcher** — is the **last backend piece**,
the one that closes the **sync → detect → notify** pipeline end to end. Everything
before it lands the raw signal but never tells the user: spec 0008 (merged, `done`)
built the Firebase-free **sync engine** that refreshes `title-cache` and rolls
`RegionAvailability.previousSnapshot`; spec 0009 (merged, `done`) wrapped it in the
HTTP `syncTitles` function that, on each pass, **writes** `title-cache/{tmdbId}/
availability/{region}` documents. Spec 0009 explicitly drew the line: "the
function writes **no** notification … the per-user fan-out of availability changes
is #14's job, triggered by the `title-cache` availability writes this function
makes." This spec is that fan-out.

The dispatcher is a **Firestore `onDocumentWritten` trigger** on
`title-cache/{tmdbId}/availability/{region}`. When the sync engine writes an
availability doc, the trigger fires, diffs the **new** `providers` against the
written **`previousSnapshot`** (the engine already rolled it — §4), and on a
**0 → ≥1 flatrate** transition fans out to **every user who tracks that title in
that region**, writing a `users/{uid}/notifications/{id}` doc and sending an FCM
**data-only** message to each of the user's registered tokens. It also detects
**newly-aired episodes** that are now streamable and notifies likewise.

Like the rest of the functions backend (specs 0008/0009), the dispatcher follows
the **port/adapter** pattern: a **pure, Firebase-free** core library
`createNotificationDispatcher(config)` in `libs/functions/dispatch-notifications`
(injected `WatchlistStore` / `EpisodeStore` / `NotificationStore` / `FcmSender` /
clock), with the **Admin SDK wired only in the thin `apps/functions` entry point**
(`dispatch-notifications.ts`, which registers the `onDocumentWritten` trigger and
constructs the adapters). The dispatcher reads the FCM tokens that **spec 0011**
established (`users/{uid}.fcmTokens`) — it does **not** register tokens (that is
PLAN §6 item 21); it only **reads** them to send and **prunes** a token that FCM
reports as unregistered.

Intended outcome: with the daily sync running (spec 0009 + #13 cron), a title that
newly appears on a flatrate platform in a user's region, or a tracked show's
episode that has now aired and is streamable, produces a stored notification and a
pushed FCM data message within one sync cycle — completing the PLAN §1 promise of
"a push notification when a new episode drops or a movie becomes available."

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Two transitions notify; a third explicitly does not.**
   - **(A) Providers added — flatrate count `0 → ≥1` in the doc's region.** The
     title newly appeared on a streaming platform. `type: 'movie'` →
     `kind: 'movie-available'`; `type: 'tv'` (a show that previously had **0**
     flatrate providers) → `kind: 'show-came-to-platform'`.
   - **(B) New episode aired.** Any episode in
     `users/{uid}/watchlist/{titleId}/episodes/*` with `airDate ≤ now` **AND** the
     show now has **≥1 flatrate** provider in the trigger's region →
     `kind: 'episode-aired'`. Rationale: `airDate ≤ now` + providers present is the
     v1 proxy for "streaming now" (most platforms release on airDate). **No strict
     "episode doc newly appeared" check** — the date+provider check is the contract.
   - **(C) Providers removed** (flatrate `≥1 → 0`) → **no notification** (decided:
     too noisy for v1). The transition is detected (so it could be used later) but
     **never dispatched**.
2. **FCM payload is data-only.** No `notification` key. Data fields exactly:
   `{ notificationId, titleId, kind, region, tmdbId }` (all string values — FCM
   data values are strings). The app renders a local notification from this in a
   later spec; this spec ships **no** display logic.
3. **Idempotency is best-effort only.** Firestore triggers are **at-least-once**;
   the dispatcher accepts the rare duplicate notification rather than adding a
   dedup store. No idempotency-key collection in v1 (stated in Risks).
4. **Token cleanup, not registration.** The dispatcher **reads**
   `users/{uid}.fcmTokens` (written by spec 0011) and sends to all of them. As a
   **side-effect only**, when the `FcmSender` reports a token as
   unregistered/not-found, the dispatcher **deletes that stale token** from the
   user's `fcmTokens` array. It adds **no** new registration logic.
5. **Generate the slice lib in this spec.**
   `libs/functions/dispatch-notifications` **does not yet exist** (spec 0010 created
   only mobile stubs). This spec generates it via Nx. Tagging is **not** done in
   `project.json` — like the merged `libs/functions/sync-titles` (`"tags": []`),
   the new lib's `project.json` carries an **empty `tags` array**, and
   `sheriff.config.ts` resolves `scope:functions` + `slice:dispatch-notifications`
   from the path glob `libs/functions/dispatch-notifications/src/**`. No
   `--tags=…` generator flag and no manual `project.json` tag edit.

## Scope

In scope:

- **A new slice lib** `libs/functions/dispatch-notifications`
  (`scope:functions` + `slice:dispatch-notifications`), generated via Nx
  (`@nx/js:library`), Firebase-free, behind one `src/index.ts` barrel.
- **A pure transition + decision core** (`src/lib/transitions.ts`): pure functions
  that, given the **new** and **previous** providers arrays for one region,
  compute the **flatrate** transition (`0→≥1` "appeared", `≥1→0` "removed",
  otherwise "unchanged"); and that decide, given a title `type` + transition + a
  per-region "has-flatrate-now" boolean + a tracked-episode list with `airDate`,
  **which `NotificationKind`(s)** (if any) to dispatch. No I/O — fully unit-tested.
- **The dispatcher factory** `createNotificationDispatcher(config)`
  (`src/lib/dispatcher.ts`): given the change (tmdbId, region, type, new + previous
  providers) and the injected ports, it gathers the users tracking that title in
  that region, applies the transition/decision logic + each user's
  `notificationPrefs`, writes a `users/{uid}/notifications/{id}` doc per dispatched
  kind, and sends a data-only FCM message to each of the user's tokens (pruning
  stale tokens). Returns a structured per-run summary for diagnostics.
- **The injected ports** (`src/lib/ports.ts`): `WatchlistStore` (find users
  tracking `tmdbId` in `region`; read a user's `fcmTokens` + `notificationPrefs`;
  delete a stale token), `EpisodeStore` (read a tracked title's episodes for a
  user), `NotificationStore` (write a `users/{uid}/notifications/{id}` doc),
  `FcmSender` (send a data-only message to a token; report unregistered tokens),
  and an injectable `now` clock. All domain-typed, Firebase-free.
- **The thin Admin-SDK wiring** in `apps/functions/src/dispatch-notifications.ts`:
  build the Admin-SDK adapters for each port, register the
  `onDocumentWritten('title-cache/{tmdbId}/availability/{region}', …)` trigger,
  extract the change, and call the dispatcher. This is the **only** place the
  Firebase SDK (`firebase-admin`, `firebase-admin/messaging`) enters the slice's
  consumers; the core lib stays SDK-free.
- **Register the new trigger** in `apps/functions/src/main.ts` (export the
  `dispatchNotifications` function alongside the existing `syncTitles`).
- **An additive `tmdbId` field on `NotificationPayload`** in `@vultus/shared/domain`
  so the stored notification and the FCM payload can carry the tmdbId per decision 2
  (see Data model touchpoints + Risks — the current payload has no `tmdbId`). Because
  the firestore-schema converter treats `payload` as a wholesale passthrough (typed
  `NotificationPayload`), `tmdbId` flows through automatically — the only
  firestore-schema change is extending the round-trip test. A small, additive
  `scope:shared` foundation change that lands first.
- **Vitest unit tests** for `transitions.ts` (the decision heart) and
  `dispatcher.ts` (with fake in-memory stores + a fake `FcmSender` + a fixed
  clock). No emulator, no live FCM, no secrets.
- **A complete `libs/functions/dispatch-notifications/README.md`** (not Nx
  scaffold text).

Out of scope (each its own spec/slice):

- **FCM token registration / push permission / `@capacitor/push-notifications`** —
  PLAN §6 item 21. This spec only **reads** `fcmTokens` and **prunes** stale ones;
  it never registers a token or prompts for permission.
- **The app-side notification display / local-notification handler** — a later
  mobile spec. This spec sends a **data-only** message; rendering is the app's job.
- **Per-type notification preferences UI** — deferred (spec 0011 decision 2). This
  spec **reads** the persisted `notificationPrefs` (the three booleans) to gate
  dispatch by kind, but adds **no** UI and changes **no** pref shape.
- **The sync engine / HTTP function** — specs 0008/0009, unchanged. This spec
  **consumes** the `title-cache` availability writes; it does not modify them.
- **A dedup / idempotency-key store** — decision 3 (best-effort; at-least-once
  duplicates accepted). Not built.
- **An emulator-backed integration test as an in-session gate** — the Firestore
  emulator cannot run under Claude Code tools here (project memory). The gate is
  **unit tests with fakes**. (If a maintainer later wants an emulator-backed trigger
  test, it is a separate CI-wiring concern, mirroring 0009 — out of scope here.)
- **Watchmode accuracy fallback** (PLAN §9) — later.
- **`firestore.rules` / `firestore.indexes.json` changes** — the dispatcher runs as
  the Admin SDK (bypasses rules); its `collectionGroup('watchlist')` query needs no
  composite index (see Data model touchpoints). No rules/indexes edit.

## Affected slices & Sheriff tags

| Project                         | Path                                    | Sheriff tags                                       | Change                                                                  |
| ------------------------------- | --------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| functions-dispatch-notifications | `libs/functions/dispatch-notifications` | `scope:functions`, `slice:dispatch-notifications`  | **new lib** — transitions, dispatcher factory, ports, barrel, README, tests |
| functions (app)                 | `apps/functions`                        | `scope:functions`                                  | **add** `dispatch-notifications.ts` Admin-SDK trigger wiring; register in `main.ts` |
| shared-domain (edit)            | `libs/shared/domain`                    | `scope:shared`                                     | **add** `tmdbId: number` to `NotificationPayload` (additive)            |
| shared-firestore-schema (edit)  | `libs/shared/firestore-schema`          | `scope:shared`                                     | extend the notification round-trip test for `payload.tmdbId` (converter unchanged — `payload` is a passthrough) |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (per specs 0008/0009), **never
  via `project.json` `tags`**: the glob `'libs/functions/<slice>/src'` assigns
  `['scope:functions', 'slice:<slice>']` automatically, and `'apps/functions'` →
  `scope:functions`. So for the new lib, Sheriff resolves
  `slice:dispatch-notifications` from the path
  `libs/functions/dispatch-notifications/src/**` — **no `project.json` change is
  needed**. The new lib's `project.json` carries `"tags": []` (exactly like the
  merged `libs/functions/sync-titles/project.json`); do **not** pass `--tags=…` to
  the Nx generator and do **not** hand-edit a `tags` array into `project.json`.
  **This spec does NOT edit `sheriff.config.ts`** — the existing
  `'libs/functions/<slice>/src'` wildcard already covers the new lib; just verify
  the lib's source lives under `libs/functions/dispatch-notifications/src` so the
  glob matches.
- **Import boundaries (verified against the spec-0008/0009 rules — `scope:functions`
  may import `['scope:shared', 'scope:functions']`):**
  - The core lib imports `@vultus/shared/domain` (`NotificationKind`, `Region`,
    `TitleType`, `WatchProvider`, `WatchProviderType`, `NotificationDoc`,
    `NotificationPayload`, `FcmToken`, `NotificationPrefs`) and **MAY** import
    `@vultus/shared/firestore-schema` **only** if a port is expressed in its path
    vocabulary — but the **recommended** design keeps the ports in pure domain
    terms, so the core lib likely imports only `@vultus/shared/domain`. It must
    import **no** `scope:mobile`, **no other slice** (not `slice:sync-titles`), and
    **no** `firebase-admin`/`firebase-admin/messaging`/`firebase-functions`. The
    no-SDK constraint is **verified by code review of the diff + the SDK-free unit
    tests passing with fakes** (Sheriff governs only workspace `scope:`/`slice:`
    edges, not the third-party `firebase-admin` import — same as 0008/0009).
  - `apps/functions` importing `@vultus/functions/dispatch-notifications`
    (`scope:functions` + `slice:dispatch-notifications`) and `@vultus/shared/*` is
    **allowed** (rule 3: an app imports its own scope's slices). `apps/functions` is
    the deployable barrel that wires the slice into a Cloud Function — its job. The
    Admin-SDK + `firebase-functions/v2/firestore` imports live **only** there (and
    in the adapter files under `apps/functions/src`).
  - **`scope:functions` must never import `scope:mobile`** — and it does not.
- **No `shared/` extraction.** Transition detection, the decision logic, the ports,
  and the dispatcher all stay **inside** `libs/functions/dispatch-notifications`.
  There is exactly **one** consuming slice — the "extract only at 3+ slices" rule
  (CLAUDE.md / PLAN §3) is respected; nothing is hoisted to `shared/`. The lone
  `shared/` change is the additive `tmdbId` payload field (a persisted-field
  vocabulary addition, the spec-0003/0005 contract — not a slice extraction).
- **Do NOT import the `sync-titles` slice.** The dispatcher reacts to `title-cache`
  **writes** via the Firestore trigger event payload, **not** by importing
  `slice:sync-titles` (that would be a forbidden cross-slice import). The change
  data (new + previous providers) comes from the `onDocumentWritten` event's
  `before`/`after` snapshots, which already carry the `previousSnapshot` the engine
  wrote.

## Data model touchpoints

The dispatcher is **triggered by** a write to the global `title-cache` availability
doc and **writes** per-user `notifications` docs; it also **reads** watchlists,
episodes, and `fcmTokens`, and **mutates `fcmTokens`** only to prune a stale token.

| PLAN §4 path                                              | Access                  | By                                                                                       |
| --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `title-cache/{tmdbId}/availability/{region}`              | **trigger source** (read via event) | the `onDocumentWritten` event's `after` (new `providers`) + `before`/`previousSnapshot` |
| `title-cache/{tmdbId}`                                    | **read**                | to get the title `type` (`movie`/`tv`) for the kind decision (via the title-cache doc)   |
| `users/{userId}/watchlist/{titleId}`                      | **read**                | `collectionGroup('watchlist')` filtered to the changed `tmdbId` → the users tracking it  |
| `users/{userId}/watchlist/{titleId}/episodes/{episodeId}` | **read**                | per-tracking-user episodes for the `episode-aired` decision (`airDate ≤ now`)            |
| `users/{userId}`                                          | **read**, **update**    | read `region` + `notificationPrefs` + `fcmTokens`; **update** only to delete a stale token |
| `users/{userId}/notifications/{notificationId}`           | **create**              | one doc per dispatched kind (`NotificationDoc` via the spec-0005 converter)              |

- **Trigger doc selection.** The trigger path is
  `title-cache/{tmdbId}/availability/{region}`. The wildcards give the `tmdbId`
  (string param → number) and the `Region`. The dispatcher diffs
  `event.data.after.previousSnapshot` (the engine-rolled prior providers) vs
  `event.data.after.providers` (the new providers) — equivalently the engine writes
  `previousSnapshot = prior providers`, so the `after` doc already carries both
  sides of the diff in one snapshot. (Using `after.previousSnapshot` vs
  `after.providers` avoids depending on `event.data.before` being present, which it
  is not on a create.) **Decide and document** which of the two equivalent sources
  the implementer uses; the unit tests pin it.
- **Who tracks this title.** A `collectionGroup('watchlist')` query
  `where('tmdbId', '==', tmdbId)` yields every `users/{uid}/watchlist/{titleId}`
  doc for that title across all users; the `uid` comes from the doc's parent path
  (`docRef.parent.parent.id`). The user's `region` (read from `users/{uid}`) must
  equal the trigger's region for an availability-based notification. **Index note:**
  a single-field `where('tmdbId','==',…)` on a **collection-group** query requires a
  **collection-group single-field index on `tmdbId`** to be enabled. PLAN §4 does
  not currently declare one. **The implementer must verify** whether
  `firestore.indexes.json` already enables collection-group indexing for `tmdbId`;
  if not, **either** add the collection-group field-index entry to
  `firestore.indexes.json` **or** (simpler v1, and consistent with 0009's
  no-`where` collection-group scan) **scan `collectionGroup('watchlist')` with no
  `where` and filter `tmdbId` in memory** — the v1 watchlist is tiny. **Pick the
  in-memory filter for v1** to avoid an index dependency (state it; mirrors 0009);
  note the index as the scaling path in Risks.
- **Episode read (`episode-aired`).** For a tracked **tv** title and user, read
  `users/{uid}/watchlist/{titleId}/episodes/*` and select episodes with
  `airDate ≤ now` (the `EpisodeStore` may filter in the query or in memory —
  document which; in-memory is fine for v1). An `episode-aired` notification is
  dispatched when such an episode exists **and** the show now has ≥1 flatrate
  provider in the user's region (decision 1B). Per decision 1B there is **no**
  "episode doc newly appeared" check.
- **Notification write.** One `users/{uid}/notifications/{id}` doc per dispatched
  kind, built as a `NotificationDoc` and written via the spec-0005
  `notificationToData` converter (the Admin SDK coerces the converter's `Date`/ISO
  output to `Timestamp`). `readAt: null`, `sentAt: now()`.
- **`NotificationPayload.tmdbId` (additive shared change).** PLAN §4 says
  `notifications/{id}.payload: { ... }` (open shape); the merged
  `NotificationPayload` is `{ titleId, title, region, providerName? }` — it has
  **no `tmdbId`**, but decision 2 requires `tmdbId` in both the stored payload and
  the FCM data message. **Add `tmdbId: number` to `NotificationPayload`** in
  `@vultus/shared/domain`. The firestore-schema converter
  (`notificationToData`/`dataToNotification`) treats `payload` as an **opaque
  wholesale passthrough** typed `NotificationPayload` (`payload: n.payload` / `payload:
  data.payload`), so the new field flows through with **no converter-body edit** and
  **no new top-level field** on `NotificationReadData`/`NotificationWriteData` — the
  only firestore-schema change is extending the round-trip test to set + assert
  `payload.tmdbId`. This is the only `shared/` data change. See Public types / APIs +
  Risks.
- **Token pruning.** When `FcmSender` reports a token unregistered, the dispatcher
  updates `users/{uid}.fcmTokens` to the array minus that token (an
  `arrayRemove`-style update in the adapter; the core lib expresses it as a
  `WatchlistStore.removeFcmToken(uid, token)` port call). It writes **no** other
  `users/{uid}` field.
- **No `firestore.rules` change.** The dispatcher runs as the Admin SDK, which
  bypasses security rules entirely; all its reads/writes are server-side. The
  existing rules already deny client writes to `title-cache` and to other users'
  data; nothing changes. **Do NOT edit `firestore.rules`.**

## Public types / APIs

All new public surface is exported from the new barrel
`libs/functions/dispatch-notifications/src/index.ts`. **No mobile screen, no HTTP
endpoint** — this is a Firestore-triggered function plus a pure core lib.

### The injected ports (`src/lib/ports.ts`, exported from the barrel)

```ts
import type {
  FcmToken,
  NotificationDoc,
  NotificationPrefs,
  Region,
} from '@vultus/shared/domain';

/** A user who tracks the changed title, with the data needed to decide + dispatch. */
export interface TrackingUser {
  uid: string;
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
}

/** Reads watchlists + user prefs/tokens; prunes a stale token. Admin-SDK-backed
 *  in apps/functions; faked in tests. Firebase-free interface. */
export interface WatchlistStore {
  /** Users tracking `tmdbId` (any region); caller filters by region. */
  findUsersTracking(tmdbId: number): Promise<TrackingUser[]>;
  /** Remove one stale FCM token from a user's fcmTokens array. */
  removeFcmToken(uid: string, token: string): Promise<void>;
}

/** One tracked episode (the fields the decision needs). */
export interface TrackedEpisode {
  airDate: string; // ISO 8601
  season: number;
  episode: number;
}

export interface EpisodeStore {
  /** Episodes for a user's tracked tv title (the dispatcher selects airDate <= now). */
  getEpisodes(uid: string, titleId: string, tmdbId: number): Promise<TrackedEpisode[]>;
}

export interface NotificationStore {
  /** Create one users/{uid}/notifications/{id} doc. Id may be store-generated. */
  write(uid: string, doc: NotificationDoc): Promise<void>;
}

/** Result of one FCM send, so the dispatcher can prune unregistered tokens. */
export interface FcmSendResult {
  token: string;
  /** true when FCM reported the token unregistered/not-found (prune it). */
  unregistered: boolean;
}

export interface FcmSender {
  /** Send a data-only message to one token. Never throws on an unregistered
   *  token — returns { unregistered: true } so the caller can prune. */
  send(token: string, data: Record<string, string>): Promise<FcmSendResult>;
}
```

(The exact method set is a recommendation; an implementer **may** consolidate
`findUsersTracking` to also carry the matching `titleId` per user — needed for the
episode read and the notification path. **Binding:** the ports stay domain-typed,
Firebase-free, exported from the barrel, and carry enough per-user data
(`uid`, `region`, `prefs`, `tokens`, the tracked `titleId`) for the dispatcher to
read episodes and write notifications. State the chosen shape in the README.)

### Transition + decision core (`src/lib/transitions.ts`, exported)

```ts
import type {
  NotificationKind,
  TitleType,
  WatchProvider,
} from '@vultus/shared/domain';

/** The flatrate availability transition for one region, derived from the
 *  previous vs new providers arrays (counts of WatchProvider with type 'flatrate'). */
export type FlatrateTransition = 'appeared' | 'removed' | 'unchanged';

/** Pure: classify the flatrate transition (0->>=1 'appeared', >=1->0 'removed',
 *  else 'unchanged'). Keyed on flatrate-provider presence, NOT rent/buy. */
export function classifyFlatrateTransition(
  previous: WatchProvider[],
  next: WatchProvider[],
): FlatrateTransition;

/** True when `next` has >= 1 provider of type 'flatrate'. */
export function hasFlatrate(next: WatchProvider[]): boolean;

/** Pure: which kinds to dispatch for one user, given the title type, the
 *  flatrate transition, whether the show currently has flatrate, and the user's
 *  tracked episodes with airDate. `now` is injected for determinism.
 *  - 'appeared' + movie  -> ['movie-available']
 *  - 'appeared' + tv     -> ['show-came-to-platform']
 *  - tv + hasFlatrate now + an episode airDate <= now -> ['episode-aired']
 *  - 'removed'            -> [] (decision 1C: no notification)
 *  Multiple kinds may apply in one pass (e.g. a tv show both appears AND has an
 *  aired episode); return all that apply. */
export function decideKinds(input: {
  type: TitleType;
  transition: FlatrateTransition;
  hasFlatrateNow: boolean;
  episodeAirDates: string[]; // ISO 8601, the user's tracked episodes
  now: string; // ISO 8601 injected clock value
}): NotificationKind[];
```

The decision is then **gated by the user's `notificationPrefs`** in the dispatcher:
`movie-available` requires `prefs.movieAvailable`, `show-came-to-platform` requires
`prefs.cameToPlatform`, `episode-aired` requires `prefs.episodeAired`. A kind the
decision returns but the prefs disable is **dropped**.

### Dispatcher factory (`src/lib/dispatcher.ts`, exported)

```ts
import type { Region, TitleType, WatchProvider } from '@vultus/shared/domain';
import type {
  EpisodeStore,
  FcmSender,
  NotificationStore,
  WatchlistStore,
} from './ports';

/** The availability change that fired the trigger (extracted from the event in
 *  apps/functions; the core lib never sees Firebase). */
export interface AvailabilityChange {
  tmdbId: number;
  type: TitleType; // from the title-cache doc
  region: Region; // the changed availability doc's region
  previousProviders: WatchProvider[]; // the rolled previousSnapshot
  newProviders: WatchProvider[]; // the new providers
}

export interface DispatcherConfig {
  watchlist: WatchlistStore;
  episodes: EpisodeStore;
  notifications: NotificationStore;
  fcm: FcmSender;
  /** Injectable clock; default () => new Date().toISOString(). */
  now?: () => string;
}

/** Per-run diagnostics (not persisted). */
export interface DispatchSummary {
  tmdbId: number;
  region: Region;
  transition: FlatrateTransition;
  usersConsidered: number;
  notificationsWritten: number;
  fcmSent: number;
  staleTokensPruned: number;
}

export interface NotificationDispatcher {
  dispatch(change: AvailabilityChange): Promise<DispatchSummary>;
}

export function createNotificationDispatcher(
  config: DispatcherConfig,
): NotificationDispatcher;
```

`dispatch` semantics, per change, in order:

1. `transition = classifyFlatrateTransition(previousProviders, newProviders)`. If
   `transition === 'removed'` and there is no episode-aired path, there is nothing
   to dispatch for the availability side (decision 1C) — but still evaluate the
   episode path for tv if `hasFlatrate(newProviders)`.
2. `users = watchlist.findUsersTracking(tmdbId)`; **filter to users whose
   `region === change.region`** (an availability notification is region-specific).
3. For each matching user: read the user's tracked episodes (tv only) via
   `episodes.getEpisodes(...)`; `kinds = decideKinds({...})`; **gate by
   `notificationPrefs`**; for each surviving kind, build a `NotificationDoc`
   (`payload.tmdbId = change.tmdbId`, `payload.region = change.region`,
   `payload.title` from the title metadata, `sentAt = now()`, `readAt = null`),
   `notifications.write(uid, doc)`, then for each `fcmToken` `fcm.send(token,
   { notificationId, titleId, kind, region, tmdbId })`.
4. For every `FcmSendResult.unregistered === true`, call
   `watchlist.removeFcmToken(uid, token)` (decision 4 — cleanup only).
5. Per-user error isolation: a thrown error for one user/token is caught and does
   not abort the fan-out to other users (mirrors the 0008 per-title isolation).
6. Return the `DispatchSummary`.

### The Firestore trigger (the deployable function, `apps/functions`)

A single Cloud Function in `apps/functions/src/dispatch-notifications.ts`, exported
from `main.ts` alongside `syncTitles`. `setGlobalOptions({ region:
'europe-west1', maxInstances: 1 })` already applies app-wide. The function:

```ts
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

export const dispatchNotifications = onDocumentWritten(
  'title-cache/{tmdbId}/availability/{region}',
  async (event) => {
    /* read the title-cache doc for `type`; build AvailabilityChange from
       event.data.after (providers + previousSnapshot) + params; construct the
       Admin-SDK adapters; createNotificationDispatcher(...).dispatch(change). */
  },
);
```

- The Admin-SDK adapters (`createFirestoreWatchlistStore(db)`,
  `createFirestoreEpisodeStore(db)`, `createFirestoreNotificationStore(db)`,
  `createMessagingFcmSender(messaging)`) live under `apps/functions/src` (e.g.
  `apps/functions/src/dispatch/`), implementing the ports over `firebase-admin`
  Firestore + `firebase-admin/messaging`. The `FcmSender` adapter maps the
  `messaging-error` code `messaging/registration-token-not-found` (and
  `messaging/invalid-registration-token`) to `{ unregistered: true }`.
- The function does a single `db.doc(titleCacheDocPath(tmdbId)).get()` for `type`,
  and the `collectionGroup('watchlist')` gather (in-memory `tmdbId` filter per Data
  model). It writes **no** `title-cache` doc and **no** `system/**` doc.

### Config / secrets

The dispatcher needs **no** external API secret (no TMDB/Trakt call). FCM uses the
**Admin SDK's ambient service-account credentials** (the deployed function's
identity) — **no secret is read or written, no `.env.local` access**. If any FCM
config were ever needed it would be a deploy-time concern (PLAN §7), not read here.

### Shared domain + firestore-schema change (additive)

- `libs/shared/domain/src/lib/documents.ts` — add `tmdbId: number;` to
  `NotificationPayload` (beside `titleId`). Update any representative type-assertion
  literal for `NotificationPayload`/`NotificationDoc` if one exists, or `typecheck`
  fails.
- `libs/shared/firestore-schema` — **no converter-body change and no new top-level
  data-type field.** The merged `NotificationReadData`/`NotificationWriteData` type
  `payload` as `NotificationPayload`, and `notificationToData`/`dataToNotification`
  copy `payload` wholesale (`payload: n.payload` / `payload: data.payload`), so the
  new `payload.tmdbId` rides through automatically. The only change is **extending
  the notification round-trip test** to set + assert `payload.tmdbId` survives the
  converter.
- READMEs: update `libs/shared/domain/README.md` and
  `libs/shared/firestore-schema/README.md` **only if** they enumerate the
  `NotificationPayload`/notification fields (CLAUDE.md lib-README rule).

### Slice barrel

`libs/functions/dispatch-notifications/src/index.ts` exports
`createNotificationDispatcher`, `NotificationDispatcher`, `DispatcherConfig`,
`AvailabilityChange`, `DispatchSummary`, the ports (`WatchlistStore`,
`EpisodeStore`, `NotificationStore`, `FcmSender`, `TrackingUser`, `TrackedEpisode`,
`FcmSendResult`), and the pure `classifyFlatrateTransition`, `hasFlatrate`,
`decideKinds`, `FlatrateTransition`.

## UI / Stitch screen refs

Not applicable. This is `scope:functions` work — a Firestore-triggered Cloud
Function plus a Firebase-free core lib and two small `scope:shared` type edits. No
mobile slice, no Stitch screen, no design-system tokens. The app-side rendering of
the data-only FCM message is a later mobile spec.

## Implementation task graph

The two `scope:shared` edits (additive `tmdbId`) land first (the slice + adapters
typecheck against the payload); then the **lib generation** (a shared dep — the lib
must exist before any of its files or the `apps/functions` import); then the
Firebase-free core (ports → transitions → dispatcher → barrel/README → tests); then
the thin `apps/functions` Admin-SDK wiring (depends on the barrel). Everything is
`scope:functions` except tasks 1–2. **All tasks are `[sequential]`** — the
shared-domain edit feeds the schema edit, the lib-generation feeds the lib files,
the lib files share `src/index.ts` and the new `lib/` group (no safe parallel
fan-out within one lib), and the `apps/functions` wiring imports the lib barrel.
File manifests are listed per the 0008/0009 convention.

1. **[sequential] Add `tmdbId` to `NotificationPayload` in `@vultus/shared/domain`
   (foundation — `scope:shared`, depended on by the slice + schema).**
   backend-engineer / domain.
   - Add `tmdbId: number` to `NotificationPayload` in `documents.ts`; update any
     `NotificationPayload`/`NotificationDoc` type-assertion literal that exists.
   - Update `libs/shared/domain/README.md` only if it enumerates the payload fields.
   - Files: `libs/shared/domain/src/lib/documents.ts`,
     `libs/shared/domain/src/lib/type-assertions.ts` (only if a notification literal
     exists there), `libs/shared/domain/README.md` (if it lists payload fields).

2. **[sequential] Cover `payload.tmdbId` in `@vultus/shared/firestore-schema`
   (foundation — `scope:shared`, depends on task 1).** backend-engineer.
   - **No `data-types.ts` change and no `converters.ts` change.** The notification
     data types already type `payload` as `NotificationPayload`, and
     `notificationToData`/`dataToNotification` copy `payload` wholesale, so the new
     `payload.tmdbId` (from task 1) flows through with no edit. Adding a top-level
     `tmdbId` field or editing the converter bodies would be **wrong** — do not.
   - Extend the notification round-trip test in `firestore-schema.spec.ts` to set +
     assert `payload.tmdbId` survives `notificationToData` → `dataToNotification`.
   - Update `libs/shared/firestore-schema/README.md` only if it enumerates the
     notification/payload fields.
   - Files: `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
     `libs/shared/firestore-schema/README.md` (only if it lists payload fields).

3. **[sequential] Generate the slice lib (`functions-dispatch-notifications`).**
   infrastructure-engineer. (shared dep — the lib must exist before its files.)
   - Run, from the worktree root (PowerShell):
     ```powershell
     pnpm nx generate @nx/js:library dispatch-notifications `
       --directory=libs/functions/dispatch-notifications `
       --importPath=@vultus/functions/dispatch-notifications `
       --unitTestRunner=vitest --bundler=none --linter=eslint
     ```
     (No `--tags` flag — tagging is by path glob in `sheriff.config.ts`, so the
     generated `project.json` keeps `"tags": []`, matching `sync-titles`.)
     (Match the **exact** generator flags/options the merged `sync-titles` lib used —
     inspect `libs/functions/sync-titles` and its `project.json`/`vite.config.ts`
     and mirror them, e.g. `--bundler`, `--unitTestRunner=vitest`, the `importPath`
     pattern `@vultus/functions/<slice>`. Do not introduce a different test runner
     or bundler than the existing functions libs.)
   - Confirm `project.json` keeps `"tags": []` (matching `sync-titles`); **do not**
     add a tags array — Sheriff tags by path glob. Verify the lib's source lives
     under `libs/functions/dispatch-notifications/src` so the
     `'libs/functions/<slice>/src'` glob in `sheriff.config.ts` resolves
     `scope:functions` + `slice:dispatch-notifications` automatically. Verify the
     `tsconfig` path alias `@vultus/functions/dispatch-notifications` →
     `…/src/index.ts` was added. Delete the generator's scaffold sample file/spec.
   - Files: `libs/functions/dispatch-notifications/project.json`,
     `libs/functions/dispatch-notifications/tsconfig*.json`,
     `libs/functions/dispatch-notifications/vite.config.ts` (or whatever the
     generator emits matching sync-titles), root `tsconfig.base.json` (path alias).
     **No `sheriff.config.ts` edit** — the existing `libs/functions/<slice>/src`
     wildcard already covers the new lib.

4. **[sequential] Ports + transition/decision core + dispatcher + barrel + README
   (`slice:dispatch-notifications`). Depends on tasks 1–3.** backend-engineer.
   - `src/lib/ports.ts` — the port interfaces + `TrackingUser`/`TrackedEpisode`/
     `FcmSendResult` (domain-typed, Firebase-free).
   - `src/lib/transitions.ts` — `classifyFlatrateTransition`, `hasFlatrate`,
     `decideKinds` (pure, no I/O).
   - `src/lib/dispatcher.ts` — `createNotificationDispatcher(config)` per the
     semantics (gather → region filter → decide → prefs gate → write notification →
     send FCM → prune stale tokens → per-user error isolation → `DispatchSummary`).
   - `src/index.ts` — barrel exporting the surface in Public types / APIs.
   - `README.md` — what the lib is, its public surface (the barrel exports), the
     port/adapter design (SDK enters only in `apps/functions`), the two-transition +
     no-removal-notify decision (decision 1), the data-only FCM contract (decision
     2), the best-effort idempotency note (decision 3), token-prune-not-register
     (decision 4), and the Sheriff tags `scope:functions` +
     `slice:dispatch-notifications`. **No Nx scaffold text.**
   - Files: `libs/functions/dispatch-notifications/src/lib/ports.ts`,
     `libs/functions/dispatch-notifications/src/lib/transitions.ts`,
     `libs/functions/dispatch-notifications/src/lib/dispatcher.ts`,
     `libs/functions/dispatch-notifications/src/index.ts`,
     `libs/functions/dispatch-notifications/README.md`.

5. **[sequential] Unit tests for the core (`slice:dispatch-notifications`).
   Depends on task 4.** backend-engineer / qa-runner.
   - `transitions.spec.ts` + `dispatcher.spec.ts` per the Test plan (fakes + fixed
     clock; no Firebase, no FCM, no network, no secrets).
   - Files: `libs/functions/dispatch-notifications/src/lib/transitions.spec.ts`,
     `libs/functions/dispatch-notifications/src/lib/dispatcher.spec.ts`.

6. **[sequential] Admin-SDK adapters + the `onDocumentWritten` trigger wiring
   (`apps/functions`). Depends on tasks 3–4** (imports the lib barrel).
   backend-engineer.
   - Add `apps/functions/src/dispatch-notifications.ts` — the `onDocumentWritten`
     trigger that reads the title-cache `type`, builds the `AvailabilityChange`, and
     calls the dispatcher; and the Admin-SDK port adapters
     (`createFirestoreWatchlistStore` / `createFirestoreEpisodeStore` /
     `createFirestoreNotificationStore` / `createMessagingFcmSender`), e.g. under
     `apps/functions/src/dispatch/`. The `FcmSender` adapter maps FCM
     unregistered-token error codes to `{ unregistered: true }`.
   - Register/export `dispatchNotifications` in `apps/functions/src/main.ts`
     alongside the existing `syncTitles` (keep `syncTitles` unchanged).
   - Add a handler-wiring unit test that injects a fake `db`/`messaging` and asserts:
     the trigger extracts the change, calls `dispatch`, writes only
     `users/**/notifications/**` (no `title-cache`/`system` write), and prunes a
     token the fake messaging reports unregistered.
   - If `apps/functions` has a `README.md`, update it to mention the new trigger;
     do not invent one if absent (only the lib-README rule is binding).
   - Files: `apps/functions/src/dispatch-notifications.ts`,
     `apps/functions/src/dispatch/*.ts` (the adapters),
     `apps/functions/src/main.ts`,
     `apps/functions/src/dispatch-notifications.spec.ts` (and/or adapter specs).

(`firebase-admin` / `firebase-functions` are already root dependencies — no new
runtime dependency; verify before assuming. The helper/adapter file grouping is a
recommendation; keep the **pure logic injectable + unit-tested** and the SDK glue
thin, exactly as 0008/0009 did.)

## Test plan

Per the PLAN §5 pyramid — backend logic, so the surface is **unit tests** with
fakes/mocks. **No component, no e2e** (no UI flow). **No emulator** (project memory:
the Firestore emulator cannot run under Claude Code tools here; the core is proven
with fake in-memory stores + a fake `FcmSender`, the design's whole point).

**Transition + decision (`transitions.spec.ts` — the centerpiece):**

- `classifyFlatrateTransition`: 0 flatrate → 1 flatrate = `'appeared'`; 2 → 0 =
  `'removed'`; 1 → 1 (same provider) = `'unchanged'`; rent/buy-only changes that do
  not change the flatrate count = `'unchanged'` (flatrate-keyed, decision 1A); a
  provider switching `flatrate → rent` (flatrate count 1 → 0) = `'removed'`.
- `hasFlatrate`: true with ≥1 flatrate provider; false with only rent/buy; false on
  empty.
- `decideKinds`:
  - `appeared` + `movie` → `['movie-available']`; `getShowTraktId`-style tv paths
    not involved here.
  - `appeared` + `tv` → `['show-came-to-platform']`.
  - `tv` + `hasFlatrateNow` + an episode `airDate <= now` → includes
    `'episode-aired'`.
  - `tv` that **both** `appeared` **and** has an aired episode → returns **both**
    `'show-came-to-platform'` and `'episode-aired'`.
  - `removed` → `[]` (decision 1C — no notification, even if a future episode
    exists).
  - `tv` + `hasFlatrateNow` but **all** episode `airDate > now` → no `episode-aired`.
  - `movie` never yields `episode-aired`.

**Dispatcher (`dispatcher.spec.ts`, fake `WatchlistStore`/`EpisodeStore`/
`NotificationStore` + fake `FcmSender` + fixed `now`):**

- **Movie appeared, single tracking user in-region:** one `movie-available`
  `NotificationDoc` written (assert `payload.tmdbId`, `payload.region`,
  `kind`, `readAt: null`, `sentAt === now()`); one FCM `send` per token with data
  `{ notificationId, titleId, kind, region, tmdbId }` (all strings).
- **Region filter:** a user tracking the title but with a **different** `region`
  gets **no** notification and **no** FCM send.
- **Prefs gate:** a user with `notificationPrefs.movieAvailable === false` gets the
  decided kind **dropped** — no write, no send; a user with it true gets it.
- **Tv appeared + aired episode:** **two** notifications written
  (`show-came-to-platform` + `episode-aired`) when both `cameToPlatform` and
  `episodeAired` prefs are true; only the pref-enabled subset otherwise.
- **Removed transition:** flatrate `≥1 → 0` → **no availability notification**
  (decision 1C); assert no `movie-available`/`show-came-to-platform` write. (The
  episode path is also not triggered because `hasFlatrate(newProviders)` is false.)
- **Multiple users:** title tracked by 3 in-region users → 3 users considered, one
  notification + sends each; the `DispatchSummary` counts are correct.
- **Stale-token prune (decision 4):** a `FcmSender` that returns
  `{ unregistered: true }` for one of a user's two tokens → `removeFcmToken(uid,
  token)` called **once** for that token, **not** for the good token; the
  notification is still written and the good token still sent.
- **FCM-not-registered does not throw:** the `send` for an unregistered token
  resolves (not rejects) and the run completes; `DispatchSummary.staleTokensPruned`
  counts it.
- **Per-user error isolation:** a `NotificationStore.write` (or `fcm.send`) that
  **throws** for the middle of three users is caught; the other two still get their
  notification + send; `dispatch` does not reject.
- **Clock determinism:** every `sentAt` equals the injected `now()`.
- **No write outside `users/**`:** the fake stores assert that the dispatcher only
  calls `NotificationStore.write` (→ `users/{uid}/notifications/**`) and
  `WatchlistStore.removeFcmToken` (→ `users/{uid}`) — **never** a `title-cache` or
  `system` write. (The load-bearing boundary, mirroring 0008/0009.)
- **Best-effort idempotency (decision 3):** calling `dispatch` **twice** with the
  same change writes the notification **twice** (no dedup) — asserted so the
  at-least-once behaviour is contractual, not incidental.

**Handler wiring (`apps/functions` `dispatch-notifications.spec.ts`, fake
`db`/`messaging`):**

- The `onDocumentWritten` handler reads the title-cache `type`, builds the
  `AvailabilityChange` from the event's `after` (providers + previousSnapshot) +
  params, and calls `dispatch`.
- The `FcmSender` adapter maps `messaging/registration-token-not-found` →
  `{ unregistered: true }` (a fake messaging that throws that code).
- **Boundary:** across paths the fake `db` records **no** `title-cache`/`system`
  write — only `users/**/notifications/**` creates and the `fcmTokens` prune update.

**firestore-schema round-trip (extends `firestore-schema.spec.ts`):** the
notification round-trip now sets + asserts `payload.tmdbId` survives the converter.

Component tests: **none** (no UI). e2e / emulator tests: **none** (no flow; the
emulator cannot run under Claude Code tools here, and the fake stores prove the
dispatcher without Firebase).

## Definition of done

Tailored from the PLAN §5 checklist to the projects touched. No component/e2e (no
UI). `<lib>` = `functions-dispatch-notifications`; touched shared libs are
`shared-domain` + `shared-firestore-schema`; the app is `functions`.

- [ ] `pnpm nx typecheck functions-dispatch-notifications` passes — the core
      compiles against the ports + the `tmdbId`-bearing `NotificationPayload`.
- [ ] `pnpm nx typecheck shared-domain` and `pnpm nx typecheck
      shared-firestore-schema` pass — the additive `tmdbId` + converter compile.
- [ ] `pnpm nx typecheck functions` passes — the trigger + adapters + `main.ts`
      registration compile.
- [ ] `pnpm nx lint functions-dispatch-notifications` passes **with Sheriff
      active**: the lib imports only `@vultus/shared/domain` (and optionally
      `@vultus/shared/firestore-schema`) — **no** `scope:mobile`, **no other slice**
      (not `slice:sync-titles`), and **no**
      `firebase-admin`/`firebase-admin/messaging`/`firebase-functions`. The core is
      Firebase-free, verified by code review of the diff + SDK-free tests passing
      with fakes.
- [ ] `pnpm nx lint functions` passes with Sheriff: `apps/functions` imports
      `@vultus/functions/dispatch-notifications` + `@vultus/shared/*` + Firebase
      packages only; **no `scope:mobile`**; `syncTitles` (spec 0009) still present
      and unchanged.
- [ ] `pnpm nx lint shared-domain` and `pnpm nx lint shared-firestore-schema` pass
      (still Firebase-free; `scope:shared → scope:shared` only).
- [ ] `pnpm nx test functions-dispatch-notifications` passes — transition/decision
      + dispatcher unit tests green (fakes + fixed clock; no Firebase, no FCM, no
      network, no secrets).
- [ ] `pnpm nx test functions` passes — the trigger-wiring + adapter unit tests
      green (fake `db`/`messaging`); **the existing 0009 tests still pass**.
- [ ] `pnpm nx test shared-firestore-schema` passes — the notification round-trip
      now covers `payload.tmdbId`.
- [ ] `pnpm nx build functions` passes — the deployable barrel builds with
      `dispatchNotifications` exported alongside `syncTitles`.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green (the
      affected set is `functions-dispatch-notifications` + `functions` +
      `shared-domain` + `shared-firestore-schema` and any dependents).
- [ ] The new lib's source path matches the `sheriff.config.ts`
      `libs/functions/<slice>/src` glob (so Sheriff resolves `scope:functions` +
      `slice:dispatch-notifications`) and `pnpm nx lint` passes with Sheriff active;
      the lib's `project.json` keeps `"tags": []` (matching `sync-titles` — tagging
      is by path glob, not `project.json`); the
      `@vultus/functions/dispatch-notifications` path alias resolves. **No
      `sheriff.config.ts` edit.**
- [ ] The barrel `@vultus/functions/dispatch-notifications` exports the full surface
      in Public types / APIs; internal adapter details stay in `apps/functions`
      (unexported from the lib).
- [ ] `libs/functions/dispatch-notifications/README.md` is **complete** (not Nx
      scaffold text): what the lib is, its barrel surface, the port/adapter design,
      decisions 1–4, and the Sheriff tags (CLAUDE.md lib-README rule). `shared/domain`
      + `shared/firestore-schema` READMEs updated only if they enumerate the payload/
      notification fields. `apps/functions` README updated only if one exists.
- [ ] **Boundary verifications (review-checked, like 0008/0009):** (a) **no secret
      is read or written** — FCM uses the function's ambient Admin credentials, no
      `.env.local`, nothing logged; (b) **the only writes are
      `users/{uid}/notifications/**` creates and the `users/{uid}.fcmTokens` stale-
      token prune** — **no** `title-cache`/`system` write, **no** token registration;
      (c) **the core lib imports no Firebase SDK and no other slice** — the SDK lives
      only in `apps/functions`; (d) **no `firestore.rules` change** (Admin SDK bypasses
      rules); the `collectionGroup('watchlist')` gather uses the in-memory `tmdbId`
      filter (no new composite index) unless the implementer deliberately adds the
      documented collection-group field index.
- [ ] PR description records the exact verification commands (all four projects),
      confirms the no-secret / writes-only-to-`users/**` / no-SDK-in-core /
      token-prune-not-register boundaries, and notes that emulator-backed verification
      is out of scope (the emulator cannot run under Claude Code tools here) with the
      core proven by fakes.

## Risks

- **`NotificationPayload` has no `tmdbId` today — additive shared change (decision
  2).** Decision 2 requires `tmdbId` in the stored payload and the FCM data message,
  but the merged `NotificationPayload` is `{ titleId, title, region, providerName? }`.
  This spec **adds `tmdbId: number`** to `NotificationPayload` in `shared/domain`.
  Because the firestore-schema converter treats `payload` as a wholesale passthrough
  (typed `NotificationPayload`), the field flows through with **no converter-body
  edit and no new top-level data-type field** — only the domain type and the
  round-trip test change. PLAN §4 leaves `notifications/{id}.payload` an open
  `{ ... }`, so this is **consistent with PLAN §4**, not a conflict. Stated so the
  implementer does not treat it as pre-existing nor over-edit the converter.
- **`episode-aired` is a date+provider proxy, not a true "now streaming" signal
  (decision 1B).** `airDate ≤ now` + the show having ≥1 flatrate provider in the
  user's region is the v1 proxy; a platform that delays streaming past airDate would
  produce a premature notification, and there is **no** "episode doc newly appeared"
  guard, so a re-fire of the trigger with the same aired episode can re-notify
  (bounded by best-effort idempotency, decision 3). Accepted for v1; the precise
  per-episode availability signal is a later refinement. Flagged so a reviewer does
  not expect stricter episode logic.
- **At-least-once trigger → duplicate notifications (decision 3).** Firestore
  `onDocumentWritten` is at-least-once and the engine may re-write an availability
  doc across passes; with no dedup store, a user can occasionally get a duplicate.
  Chosen, sufficient v1 model — accepted rather than adding an idempotency-key
  collection. If exactly-once is ever needed, key on a deterministic notification id
  (e.g. `${tmdbId}-${region}-${kind}-${episodeId?}-${day}`) so a re-fire overwrites
  rather than duplicates — out of scope here, noted as the upgrade path.
- **`collectionGroup('watchlist')` filtering by `tmdbId` and the index choice.** A
  `where('tmdbId','==',…)` collection-group query needs a collection-group
  single-field index that PLAN §4 does not declare. This spec picks the **in-memory
  filter** (scan `collectionGroup('watchlist')`, filter `tmdbId` in code) for v1 —
  no index dependency, consistent with 0009's no-`where` collection-group scan, fine
  at v1 volume. The indexed query is the scaling path (add the field index +
  `firestore.indexes.json` entry) if the watchlist ever grows large — out of scope.
- **Cross-slice temptation: do NOT import `slice:sync-titles`.** The dispatcher
  reacts to the engine's `title-cache` writes via the **trigger event payload**
  (`event.data.after`), not by importing the sync-titles slice — an import would be a
  Sheriff-forbidden cross-slice edge. The `previousSnapshot`/`providers` the engine
  rolled (spec 0008) are read off the changed availability doc. Stated so the
  implementer wires through the event, not a slice import.
- **FCM token cleanup only, never registration (decision 4 + PLAN §9 token churn).**
  PLAN §9 mitigates "FCM token expires/changes" by re-registering on every launch and
  storing an array — registration is **PLAN §6 item 21 / spec 0011's `fcmTokens`
  array**, not here. This spec only **reads** that array to send and **prunes** a
  token FCM reports unregistered. A reviewer should confirm no registration logic
  leaked in and that the prune touches only `fcmTokens`.
- **Lib-generation must mirror the existing functions libs.** The new lib must use
  the **same** Nx generator options (test runner = Vitest, bundler, `importPath`
  pattern) as `libs/functions/sync-titles`; a divergent generator config (e.g. Jest,
  a different `importPath`) would break the build/test gates or Sheriff resolution.
  The implementer inspects the merged `sync-titles` project before generating and
  deletes the scaffold sample file. **Tagging needs no action:** `sheriff.config.ts`
  uses a `'libs/functions/<slice>/src'` **wildcard**, so the new lib inherits
  `scope:functions` + `slice:dispatch-notifications` from its path the moment it is
  generated — `project.json` keeps `"tags": []` (like `sync-titles`) and
  `sheriff.config.ts` is **not** edited.
- **No PLAN conflict.** This implements PLAN §6 item 14 (the notification dispatcher)
  faithfully: a Firestore trigger on `title-cache/*/availability/*` that diffs the
  snapshot, finds users tracking the title in the matching region, writes
  `users/*/notifications/*`, and sends via FCM — exactly PLAN §6 item 14's wording.
  The two deferrals (token registration → item 21; app-side display → a later mobile
  spec) and the additive `payload.tmdbId` follow the spec-0003/0005 + spec-0011
  contracts. The "providers removed = no notification" choice (decision 1C) is a v1
  product call within PLAN §1's scope, not a conflict.
