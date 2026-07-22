# mobile-notifications

The **Notifications inbox** slice — a `scope:mobile` vertical slice owning the
in-app notification history's UI, state, data, and slice-local types (spec 0042).
It lists the user's past "new episode" / "now streaming" / "now available" /
"leaving your platform" alerts (persisted by the spec 0012/0057 dispatcher to
`users/{uid}/notifications`), lets them
tap a row to open the title (deep-link, reusing spec 0016's `title-detail` route),
mark all read, swipe to delete, and pull to refresh. The entry point is a bell
icon with an unread badge in the **watchlist** header (owned by the watchlist
slice); this slice owns the inbox page reached at `tabs/notifications`.

## Public surface (barrel `@vultus/mobile/notifications`)

- **`NotificationsPage`** — a standalone Ionic page component (selector
  `lib-notifications`), the `tabs/notifications` route's `loadComponent` target.
  Renders the realtime inbox: newest-first rows distinguishing unread (emerald
  tint + dot) from read (dimmed), a poster-or-icon thumbnail, a relative
  timestamp, a "Mark all read" header action, swipe-to-delete, pull-to-refresh,
  and shared empty / loading states.
- **`NotificationsService`** — `providedIn: 'root'` data-access service:
  - `notifications$()` — realtime `users/{uid}/notifications`, `sentAt` desc,
    `limit(50)`, each row carrying its real Firestore doc id (`idField`), mapped
    to `NotificationRow`. Null uid → `of([])`.
  - `posterUrl$(tmdbId)` — full TMDB poster URL from `title-cache/{tmdbId}`, or
    `null` (→ kind-based icon placeholder). Best-effort; missing cache doc → null.
  - `markRead(id)` — sets `readAt` on one notification. Null uid → no-op;
    best-effort.
  - `markAllRead(unreadIds)` — batch-sets `readAt` on the given unread ids via a
    `writeBatch`. Null uid → no-op.
  - `remove(id)` — deletes one notification. Null uid → no-op; best-effort.

`NotificationRow` (the domain `NotificationDoc` + its real Firestore `id`) is
**not** re-exported from the barrel today — `notifications.page.ts`,
`notifications.providers.mock.ts`, and the page's spec all import it directly
from `./notifications.service`, which is fine since they're all inside this
slice. Add it to the barrel only if a consumer outside this file needs the
type; `relativeTime` and the `TMDB_POSTER_BASE` constant stay slice-internal
regardless.

## Loading / empty states

Driven off a "not yet emitted" view-model branch (mirrors the watchlist's `vm$`
gating), rendered with the shared atoms from **`@vultus/shared/ui-kit`** (spec
0024):

- **loading** (before the first stream emission) → `<vultus-skeleton-card>`.
- **empty** (`notifications$()` emits `[]`) → `<vultus-empty-state>` with the
  `notifications-off-outline` icon.

The list itself is a realtime Firestore stream, so pull-to-refresh is a
supplementary affordance that completes on the next stream tick.

## Sheriff scope / slice boundaries

- **Tags:** `scope:mobile`, `slice:notifications` (assigned by path glob in
  `sheriff.config.ts` on `libs/mobile/<slice>/src`).
- **Imports only** `scope:shared` (`@vultus/shared/domain`,
  `@vultus/shared/firestore-schema`, `@vultus/shared/ui-kit`) and framework /
  third-party (`@angular/*`, `@angular/fire/firestore`, `@ionic/angular`,
  `ionicons`, `rxjs`). It imports **no other slice** — navigation to the title
  detail page is a `Router` string route (`['tabs','title-detail', tmdbId]`),
  never a symbol import — and **no `scope:functions`**.
