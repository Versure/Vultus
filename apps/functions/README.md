# apps/functions

The deployable Firebase Cloud Functions for Vultus (gen2, Node + TypeScript,
Firebase Admin SDK). This app is where the Admin-SDK / FCM / HTTP bindings enter
the system; the pure logic lives in `libs/functions/*` and `libs/shared/*` and is
wired in here through hexagonal adapters.

**Sheriff scope:** `scope:functions`. This app may import `scope:shared` and
`scope:functions` libs only; it must never import `scope:mobile`.

## Functions

- **`syncTitles`** — HTTP/scheduled sync engine entry point (`src/lib/*`,
  `src/main.ts`). Fetches metadata + providers + episodes and writes
  `title-cache`.
- **`getWatchProviders`** — `onCall` callable (spec 0060). Given `{ region }`
  it reads-or-refreshes the global `provider-catalog/{region}` cache (7-day
  staleness) and returns `{ providers: CatalogProvider[] }`. On a cache miss/stale
  it fetches the region's TMDB watch-provider catalog via the `sync-titles`
  `TmdbClient`, best-effort writes the fresh doc, and returns it; if TMDB is
  unavailable a stale cache is preferred over throwing (`unavailable` only when
  there is no usable cache). SDK-agnostic core is `runGetWatchProviders`
  (injected `db` / `createTmdb` / clock), mirroring `triggerSync`.
- **`dispatchNotifications`** — Firestore `onDocumentWritten` trigger on
  `title-cache/{tmdbId}/availability/{region}` (spec 0012). On each availability
  write it diffs `previousSnapshot` vs `providers`, finds the in-region users
  tracking the title, decides which notification kinds fire, writes a
  notification doc per user, and sends an FCM message per registered token.

The trigger's wiring (`src/dispatch-notifications.ts`) keeps the Admin SDK at the
edges: `handleDispatch(event, db, messaging)` is SDK-agnostic via injected
`db` + `messaging`, and the firebase-admin bindings are confined to
`src/dispatch/adapters.ts`. The dispatch decision logic itself lives in the
Firebase-free `@vultus/functions/dispatch-notifications` core lib (not modified by
spec 0041).

## Notification wire payload (spec 0012 + 0041)

Each FCM message carries two blocks:

- **`data`** (drives in-app deep-link handling, spec 0041):
  `{ notificationId, titleId, kind, region, tmdbId }`. `notificationId` is the
  deterministic `{tmdbId}-{region}-{kind}`.
- **`notification: { title, body }`** (spec 0041): added so the **Android OS
  renders the notification natively** when the app is backgrounded or terminated
  (a data-only message is silent in that state). Copy is built per kind in
  `createMessagingFcmSender`:
  - `movie-available` / `show-came-to-platform` →
    `{ title: 'Now available to stream', body: '<title> is available on a streaming platform' }`
  - `episode-aired` →
    `{ title: 'New episode available', body: '<title> has a new episode on a streaming platform' }`

  `<title>` is the cached display title. `providerName` is **not** carried in the
  FCM `data` record, so the body uses the generic phrase `a streaming platform`;
  the mobile app renders richer copy from its own cache on tap.

### Title threading

The body needs the title string, which the dispatcher core does not carry.
`handleDispatch` reads `metadata.title` from the parent `title-cache/{tmdbId}`
doc and threads it into the sender via
`createMessagingFcmSender(messaging, titleStr)`. It falls back to `''` if the
cache doc predates the metadata write.

## Notification store doc id (spec 0041)

`createFirestoreNotificationStore` writes each notification to the **deterministic
doc id** `users/{uid}/notifications/{tmdbId}-{region}-{kind}` (via the shared
`notificationPath` helper) with `set(..., { merge: true })` — replacing the
previous Firestore-generated id. This lets the mobile app's mark-as-read write
target the exact doc, and makes a re-fired availability trigger idempotent
(it merges onto the same doc instead of duplicating).

## Commands

- `pnpm nx typecheck functions`
- `pnpm nx lint functions` (includes Sheriff)
- `pnpm nx test functions`
- `pnpm nx run functions:deploy-preflight` — validate the pruned deploy bundle
  (required CI gate for any deps/build change).
