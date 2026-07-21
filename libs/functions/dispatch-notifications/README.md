# @vultus/functions/dispatch-notifications

The Firebase-free notification dispatch **core**. It serves two paths: the
availability Firestore trigger (`dispatch`) and the daily episode-aired
airing-scan (`dispatchEpisodeAired`, spec 0089). Given a change it finds/uses the
relevant user(s), decides which notification kinds apply, writes per-user
`NotificationDoc`s, and pushes data-only FCM messages.

## Port / adapter design

The dispatcher depends only on the port interfaces in `ports.ts`
(`WatchlistStore`, `NotificationStore`, `FcmSender`). No `firebase-admin`,
`firebase-functions`, or FCM SDK is imported in this lib — the SDK-bound adapters
that implement these ports live in `apps/functions`. This keeps the decision
logic pure and unit-testable (PLAN §5 pyramid). The core owns notification **id
derivation** for both paths — `NotificationStore.write(uid, id, doc)` takes an
explicit id.

## What notifies (decision 1)

**Availability path** (`dispatch`) — transitions are classified by **flatrate**
providers only (rent/buy changes are ignored):

- `0 → ≥1` flatrate = `appeared` → `movie-available` (movie) or
  `show-came-to-platform` (tv). Id: `${tmdbId}-${region}-${kind}`.
- `≥1 → 0` flatrate = `removed` → **no notification** (decision 1C).
- `unchanged` → no availability kind.

The availability path **no longer emits `episode-aired`** and no longer reads
episodes (spec 0089 / D3): `decideKinds` returns only the availability kinds.

## Episode-aired airing-scan (spec 0089 / D3)

`episode-aired` is owned **exclusively** by `dispatchEpisodeAired`, driven by an
episode crossing into a recency window rather than by an availability write. Per
`EpisodeAiredChange` (one user + one episode) the gates run in order:

1. **status** — `completed`/`dropped` → no-op (self-implemented 0088 gate).
2. **prefs** — `episodeAired` off → no-op.
3. **recency** — `isEpisodeRecentlyAired(airDate, now, EPISODE_RECENCY_WINDOW_DAYS)`
   (`= 3`); `airDate ∈ [now - 3d, now]` inclusive. Guards the back-catalog storm.
4. **flatrate** — `hasFlatrateNow` false → no-op.
5. **idempotency** — `NotificationStore.exists(uid, id)` true → no-op, so the
   daily scan notifies each episode **exactly once** even though the episode
   stays in the window for up to 3 runs.

Then it writes the inbox doc with the **per-episode id**
`${tmdbId}-${region}-episode-aired-${episodeId}`, sends FCM to each token **only
within the delivery window** (0051), and prunes stale tokens. The inbox
`NotificationDoc` uses the existing shape (`title: ''`, the app renders the name
from its own cache). The FCM `data` record additionally carries `episodeId` (a
plain string field — no shared-type change). `EpisodeAiredChange` does **not**
carry the show title; the FCM body's show name is bound per-title in the sender
by the airing-scan wiring (`apps/functions`).

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
tmdbId }`, all string values (the episode path additionally carries `episodeId`).
The `notificationId` is `${tmdbId}-${region}-${kind}` for the availability path
and `${tmdbId}-${region}-episode-aired-${episodeId}` for the episode path.

## Idempotency & resilience

- **Availability path** — best-effort idempotency (decision 3): the
  deterministic notificationId lets a re-fired trigger be recognised; the
  dispatcher itself does not deduplicate writes.
- **Episode path** — strict idempotency via `NotificationStore.exists`: the
  per-episode notification doc is the "already notified" marker, so the daily
  airing-scan fires each episode exactly once across its 3-day window.
- **Token prune, not register** (decision 4): when `FcmSender` reports a token
  `unregistered`, the dispatcher calls `WatchlistStore.removeFcmToken`; it never
  registers tokens.
- **Per-user error isolation**: one user's failure does not abort the rest of
  the dispatch.
- **Injectable clock** via `DispatcherConfig.now` for deterministic `sentAt`.

## Barrel exports

- `createNotificationDispatcher`, `EPISODE_RECENCY_WINDOW_DAYS`, and types
  `NotificationDispatcher`, `DispatcherConfig`, `AvailabilityChange`,
  `EpisodeAiredChange`, `DispatchSummary`.
- Port types: `WatchlistStore`, `NotificationStore`, `FcmSender`,
  `TrackingUser`, `FcmSendResult`.
- Pure logic: `classifyFlatrateTransition`, `hasFlatrate`, `decideKinds`,
  `isEpisodeRecentlyAired`, `isWithinDeliveryWindow`, and type
  `FlatrateTransition`.

## Boundaries

Sheriff tags: `scope:functions` + `slice:dispatch-notifications`. Imports only
from `@vultus/shared/domain`; must not import `scope:mobile` or another slice.

## Running unit tests

Run `pnpm nx test dispatch-notifications` (Vitest).
