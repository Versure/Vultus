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
- Pure logic: `classifyFlatrateTransition`, `hasFlatrate`, `decideKinds`, and
  type `FlatrateTransition`.

## Boundaries

Sheriff tags: `scope:functions` + `slice:dispatch-notifications`. Imports only
from `@vultus/shared/domain`; must not import `scope:mobile` or another slice.

## Running unit tests

Run `pnpm nx test dispatch-notifications` (Vitest).
