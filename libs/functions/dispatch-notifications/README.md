# @vultus/functions/dispatch-notifications

The Firebase-free notification dispatch **core** for the availability Firestore
trigger. Given a flatrate-availability change to a title in a region, it finds
the in-region users tracking that title, decides which notification kinds apply,
writes per-user `NotificationDoc`s, and pushes data-only FCM messages.

## Port / adapter design

The dispatcher depends only on the port interfaces in `ports.ts`
(`WatchlistStore`, `EpisodeStore`, `NotificationStore`, `FcmSender`). No
`firebase-admin`, `firebase-functions`, or FCM SDK is imported in this lib — the
SDK-bound adapters that implement these ports live in `apps/functions`. This
keeps the decision logic pure and unit-testable (PLAN §5 pyramid).

## What notifies (decision 1)

Transitions are classified by **flatrate** providers only (rent/buy changes are
ignored):

- `0 → ≥1` flatrate = `appeared` → `movie-available` (movie) or
  `show-came-to-platform` (tv).
- A tv title currently on flatrate with any tracked episode whose air date is at
  or before "now" → `episode-aired` (orthogonal to the transition; movies never
  yield it).
- `≥1 → 0` flatrate = `removed` → **no notification** (decision 1C).
- `unchanged` → no availability kind (episode-aired may still fire).

Each kind is gated by the user's `NotificationPrefs` opt-in
(`movieAvailable` / `cameToPlatform` / `episodeAired`).

## Completed/dropped suppression (spec 0088)

Once a user is **done** with a title they receive **zero** notifications about it
— **all** kinds are suppressed, not just the availability kinds:

- `TrackingUser.status` (a `WatchStatus`) carries the user's watch status for the
  title. When it is `'completed'` or `'dropped'`, `dispatch()` excludes that user
  in the **same filter line** as the region filter — **before** any
  kind-decision logic runs — so no `movie-available`, `show-came-to-platform`, or
  `episode-aired` doc/push is produced for that user.
- `'watching'` and `'planned'` are unaffected.
- The adapter that populates `TrackingUser` maps a **missing/legacy** `status` to
  `'watching'` (notifiable), never to an excluded status, so an anomalous doc
  **fails open** rather than silently suppressing a real user's notifications.

Because the exclusion is chained into the same filter that already narrows by
region, **`usersConsidered`** in `DispatchSummary` now reflects region-matched
**AND** status-eligible users — "users this dispatch would actually consider
notifying." Completed/dropped users are not counted.

## Delivery window (spec 0051)

`NotificationPrefs.deliveryHour` lets a user pin the **UTC hour** at which they
want pushes delivered:

- The gate is **FCM-only**: when the dispatch timestamp's UTC hour does not match
  `deliveryHour`, the `fcm.send` for that user is skipped (and so are stale-token
  prunes — `fcmSent` / `staleTokensPruned` are not incremented).
- The **inbox `NotificationDoc` is always written** regardless of the window
  (decision 3) — the gate only defers the OS push, never the in-app record.
- The decision is **per-user** and evaluated **once per user** against the single
  dispatch timestamp (the same clock that stamps `sentAt`); there is **no queuing
  or retry** — a skipped push is simply not sent this run.
- `deliveryHour == null` (including `undefined` on legacy pre-0051 docs, via the
  `== null` check) means **"any time"** → always send.

The predicate lives in `transitions.ts` and is exported from the barrel:

```ts
isWithinDeliveryWindow(deliveryHour: number | null, now: Date): boolean
```

## FCM contract (decision 2)

Sends are **data-only** messages: `{ notificationId, titleId, kind, region,
tmdbId }`, all string values. The `notificationId` is the deterministic
`{tmdbId}-{region}-{kind}` so the app can dedupe.

## Idempotency & resilience

- **Best-effort idempotency** (decision 3): the deterministic notificationId
  lets a re-fired trigger be recognised; the dispatcher itself does not
  deduplicate writes.
- **Token prune, not register** (decision 4): when `FcmSender` reports a token
  `unregistered`, the dispatcher calls `WatchlistStore.removeFcmToken`; it never
  registers tokens.
- **Per-user error isolation**: one user's failure does not abort the rest of
  the dispatch.
- **Injectable clock** via `DispatcherConfig.now` for deterministic `sentAt`.

## Barrel exports

- `createNotificationDispatcher` and types `NotificationDispatcher`,
  `DispatcherConfig`, `AvailabilityChange`, `DispatchSummary`.
- Port types: `WatchlistStore`, `EpisodeStore`, `NotificationStore`,
  `FcmSender`, `TrackingUser`, `TrackedEpisode`, `FcmSendResult`.
- Pure logic: `classifyFlatrateTransition`, `hasFlatrate`, `decideKinds`,
  `isWithinDeliveryWindow`, and type `FlatrateTransition`.

## Boundaries

Sheriff tags: `scope:functions` + `slice:dispatch-notifications`. Imports only
from `@vultus/shared/domain`; must not import `scope:mobile` or another slice.

## Running unit tests

Run `pnpm nx test dispatch-notifications` (Vitest).
