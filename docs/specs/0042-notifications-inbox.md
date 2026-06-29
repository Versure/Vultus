---
number: 42
slug: notifications-inbox
title: Add an in-app notifications inbox slice and a watchlist-header bell entry point
status: done
slices: [slice:notifications, slice:watchlist]
scopes: [scope:mobile]
created: 2026-06-29
---

# Add an in-app notifications inbox slice and a watchlist-header bell entry point

## 1. Context

Spec 0012 (`done`) built the notification dispatcher: a Firestore trigger that, on a
flatrate availability transition, writes a `users/{uid}/notifications/{id}` doc
(`NotificationDoc`) and sends an FCM push. Spec 0041 (`approved`) renders the live push
and deep-links a **tap on the live notification** to `tabs/title-detail/:titleId`,
marking `readAt` on tap. But 0041 deliberately deferred the in-app history:

> "A notifications inbox/list screen in the app (reading the `users/{uid}/notifications`
> collection for an in-app history) — a later mobile spec."

**This is that spec.** A user who missed or dismissed an FCM push today has **no way to
see it again** — the `users/{uid}/notifications` collection accumulates docs nothing in
the app reads. This spec adds an **in-app notifications inbox**: a new mobile slice
(`slice:notifications`) that lists the user's past "new episode" / "now streaming" /
"now available" alerts, lets them tap one to open the title (deep-link, reusing 0016's
route), mark all read, swipe to delete, and pull to refresh; plus a **bell icon with an
unread badge in the watchlist header** as the entry point.

Intended outcome: opening the inbox from the watchlist bell shows a live, newest-first
list of the user's notifications, visually distinguishing unread (emerald tint + dot)
from read (dimmed), with each row tappable to its title and an unread count surfaced on
the bell. This completes the user-facing notification loop — sync → detect → notify →
**the user can review and act on the history**, not just the single live push 0041 handles.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **New Nx lib `libs/mobile/notifications`** (`scope:mobile`, `slice:notifications`).
   Barrel exports `NotificationsPage` and `NotificationsService`. Mirrors the existing
   slices (watchlist / settings). Sheriff tags target the **`src`** module
   (`libs/mobile/notifications/src`) per the barrel-less tagging rule (project memory).
   A README is required. The slice imports **only** `scope:shared` + framework/
   third-party — **no other `slice:*` import**.

2. **Route `tabs/notifications`** — a child of the `tabs` shell route, lazy-loading
   `@vultus/mobile/notifications` `NotificationsPage`, registered in
   `apps/mobile/src/app/app.routes.ts` exactly mirroring the existing
   `title-detail/:titleId` child (0016). A **pushed** page; the tab bar stays visible
   (the Stitch screen draws the bottom nav, consistent with nesting under `tabs`).
   Editing `app.routes.ts` is a shell change (`scope:mobile`); the shell legitimately
   imports slice barrels (it already does).

3. **Entry point = a bell icon in the WATCHLIST header** (`slice:watchlist`), **not** a
   4th tab (keeps the 3-tab Stitch shell intact). It lives in the watchlist page's
   existing `ion-buttons slot="end"` toolbar, alongside the refresh + account buttons
   (`libs/mobile/watchlist/src/lib/watchlist.page.html`).
   - **Navigation:** `Router.navigate(['tabs','notifications'])` — string segments, **no
     import of `@vultus/mobile/notifications`** (Sheriff-clean; mirrors how 0041
     navigates cross-slice by string route).
   - **Unread badge:** an `ion-badge` on the bell showing the count of unread
     notifications (`readAt === null`). The watchlist reads this count from
     `users/{uid}/notifications` via `@vultus/shared/firestore-schema`
     (`notificationsPath`) + an `@angular/fire/firestore` query — a `scope:shared` read,
     **legal, not a cross-slice import**. Hide the badge when count is 0; cap the display
     at **"9+"**. Theme via Ionic / `--vultus-*` tokens (emerald accent); never hand-set
     a hex.
   - Rejected alternative (a shell-hosted global bell) recorded in Risks: Ionic headers
     are per-page, there is no shell-level header to host it.

4. **Inbox actions (all four, v1):**
   - **a. Tap a row** → deep-link `Router.navigate(['tabs','title-detail',
String(tmdbId)])` (reuse 0016; canonical segment is `tmdbId` per 0041) **and** mark
     that notification read. Mark-read identical to 0041's convention:
     `updateDoc(doc(firestore, notificationPath(uid, id)), { readAt: Timestamp.now() })`
     (`Timestamp` from `@angular/fire/firestore`), best-effort in `try/catch`, null-uid
     guard (skip the write, still navigate).
   - **b. Mark all read** → a header action that sets `readAt` on all currently-unread
     docs using a Firestore `writeBatch` (atomic). Best-effort / guarded.
   - **c. Swipe to delete** → `ion-item-sliding` with a trailing destructive option;
     `deleteDoc(doc(firestore, notificationPath(uid, id)))`. Red via Ionic
     `color="danger"` (the `status-dropped` token `#EF4444`) — do not hand-set hex. **No
     confirm dialog** in v1 (the swipe is deliberate) — noted in Risks.
   - **d. Pull to refresh** → `ion-refresher` at the top. The list is a **live Firestore
     stream** (auto-updates), so the refresher is a supplementary affordance; complete it
     on the next stream tick / a re-read. Document the realtime behavior.

5. **Data source:** read `users/{uid}/notifications` ordered by `sentAt` **desc**,
   **limit 50** (v1 cap, no pagination — older items are not shown). Live stream via
   `@angular/fire` `collectionData` using the firestore-schema path helper +
   `dataToNotification` converter. **No new domain fields** (everything needed is already
   on `NotificationDoc`).

6. **Row poster thumbnail:** `NotificationDoc.payload` has no `posterPath`, so source the
   thumbnail from **`title-cache/{tmdbId}.metadata.posterPath`** (global, authenticated-
   read) via `@vultus/shared/firestore-schema` (`titleCacheDocPath` + `dataToTitleCache`),
   composing the URL with the **same slice-local TMDB image-base constant the watchlist
   uses** (`'https://image.tmdb.org/t/p/w185'` — `watchlist.page.ts` line 57; **copy this
   constant into the notifications slice, do not import it cross-slice and do not invent a
   new base**). Fallback to a **kind-based ionicon placeholder** when `posterPath` is
   missing or the cache doc is absent. The `firestore.rules` client read of `title-cache`
   is **already permitted** (verified — see §4); no rules change.

## 2. Scope

In scope:

- A **new lib `libs/mobile/notifications`** (`scope:mobile`, `slice:notifications`),
  generated with the repo's Angular library generator, with a `@vultus/mobile/notifications`
  tsconfig path alias and a real README.
- A **`NotificationsService`** (`providedIn: 'root'`): a `notifications$` live stream
  (sentAt desc, limit 50, mapped to `NotificationDoc`), a `posterUrl$(tmdbId)` (or
  equivalent) title-cache read, and `markRead(id)` / `markAllRead(unreadIds)` /
  `remove(id)` writes — all null-uid-guarded and best-effort.
- A **`NotificationsPage`**: the inbox list per the pinned Stitch contract (§6) —
  unread vs read row styling, poster-or-icon thumbnail, relative timestamp, "Mark all
  read" header action, swipe-to-delete, pull-to-refresh, and empty + loading states
  (derived from the 0024 pattern).
- A small **relative-time helper** (pure function, slice-local) producing "2h ago",
  "Yesterday", "2 days ago", "1 week ago" from an ISO `sentAt`.
- A **`tabs/notifications` route** in `apps/mobile/src/app/app.routes.ts`.
- **Watchlist header bell + unread badge + navigation** (`slice:watchlist`): a bell
  `ion-button` in the existing toolbar, an `ion-badge` unread count (hidden at 0, "9+"
  cap), a navigate handler (`Router` string segments), and a slice-local unread-count
  stream reading `users/{uid}/notifications`.
- Unit + component tests; an authored e2e flow (run by the user — see §8).

Out of scope (explicitly):

- **Live FCM push rendering / the single-push deep-link + mark-read** — owned by spec 0041. This spec reads the persisted history; it does not register tokens, listen for
  pushes, or render toasts.
- **Pagination / infinite scroll** beyond the 50-item cap — a later spec if needed.
- **A delete-confirm dialog** — the swipe is deliberate (decision 4c).
- **Per-kind notification preferences / channels** — `NotificationPrefs` is owned by the
  settings slice; not touched here.
- **A 4th tab / tab-bar entry** — the inbox is a pushed page reached from the bell
  (decision 3).
- **Writing `title-cache`** — client read-only (functions-only write per `firestore.rules`).
- **Any `shared/` extraction** — well under the 3-slice rule (decision 1 / §3).
- **Marking-read on mere view/scroll** — read is set only on an explicit tap or "Mark all
  read" (mirrors 0041 decision 4).

## 3. Affected slices & Sheriff tags

| Project              | Path                                | Sheriff tags                          | Change                                                                                              |
| -------------------- | ----------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| mobile-notifications | `libs/mobile/notifications`         | `scope:mobile`, `slice:notifications` | **NEW** lib: `NotificationsPage` + `NotificationsService` + relative-time helper; README; tests     |
| mobile (app)         | `apps/mobile/src/app/app.routes.ts` | `scope:mobile`                        | register the lazy `tabs/notifications` child route (mirrors the 0016 `title-detail` child)          |
| mobile-watchlist     | `libs/mobile/watchlist`             | `scope:mobile`, `slice:watchlist`     | header bell + `ion-badge` unread count + `Router.navigate(['tabs','notifications'])`; unread stream |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (spec 0010): the config declares
  `'libs/mobile/<slice>': ['scope:mobile', 'slice:<slice>']`, so a newly-generated
  `libs/mobile/notifications/src` **inherits** `scope:mobile` + `slice:notifications`
  automatically **provided** `slice:notifications` is in the slice-tag vocabulary.
  **Verify-then-edit `sheriff.config.ts` once:** confirm the glob covers the new lib and
  the vocabulary lists `slice:notifications`; **edit only if a gap exists** (e.g. the
  vocabulary omits it), and record "no `sheriff.config.ts` change needed" in the PR if
  the verification passes. Generated `project.json` keeps `tags: []` (correct — tagging
  is by glob). **Per project memory the glob targets `libs/**/src`(the barrel module),
not the lib root — confirm the new lib's`src` is matched so runtime barrel imports
  resolve.\*\*
- **Import boundaries (notifications slice, `slice:notifications`)** — governed by
  `'slice:*': ['scope:shared', sameTag]`: it imports **only** `scope:shared` and its own
  modules. Concretely:
  - `@vultus/shared/domain` (`NotificationDoc`, `NotificationKind`, `NotificationPayload`)
    and `@vultus/shared/domain/tokens` (`AUTH_UID`);
  - `@vultus/shared/firestore-schema` (`notificationsPath`, `notificationPath`,
    `dataToNotification`, `titleCacheDocPath`, `dataToTitleCache`, and the
    `NotificationReadData` / `TitleCacheReadData` read-data types);
  - third-party (not policed by Sheriff): `@angular/core`, `@angular/router`,
    `@angular/fire/firestore`, `@ionic/angular/standalone`, `ionicons`, `rxjs`.
  - It imports **no other slice** (not `slice:watchlist`, not `slice:title-detail`) and
    **no `scope:functions`**. Navigation to the detail page is a `Router` **string route**
    (`['tabs','title-detail', String(tmdbId)]`), not a symbol import.
- **Import boundaries (watchlist edit, `slice:watchlist`)** — stays within the existing
  watchlist allowances: it already imports `@vultus/shared/firestore-schema`
  (`notificationsPath` is in the same lib it already consumes) and `@angular/fire/firestore`;
  the navigation adds `@angular/router` `Router` (third-party — no Sheriff edge). It must
  **not** import `slice:notifications` (the bell navigates by string route).
- **Shell edit (`apps/mobile`, `scope:mobile`)** — adds one lazy child route importing
  the new slice barrel (rule 3, allowed — the shell may import the slices it owns).
- **No `shared/` extraction.** The relative-time helper, the poster-URL constant, and the
  notification data-access all live **inside** `libs/mobile/notifications` — one consumer,
  far short of the 3+-slice rule. The watchlist's unread-count read is its own slice-local
  copy (the watchlist already reads Firestore directly); the same `notificationsPath`
  helper is shared **schema**, not shared **logic**.

## 4. Data model touchpoints

PLAN §4 paths. **No new field is added to any shared type.** `NotificationDoc`
(`{ titleId, kind, payload{ tmdbId, titleId, title, region, providerName? }, sentAt,
readAt }`) and its converters (`dataToNotification` / `notificationToData`) already exist
(`libs/shared/domain/src/lib/documents.ts`, `libs/shared/firestore-schema/src/lib/converters.ts`).

| PLAN §4 path                             | Access                                       | By                                                                                  |
| ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `users/{uid}/notifications` (collection) | **read** (realtime, `sentAt` desc, limit 50) | notifications slice (the inbox list); watchlist slice (the unread count — see note) |
| `users/{uid}/notifications/{id}`         | **update** `readAt`                          | notifications slice — single on row tap; batched on "Mark all read"                 |
| `users/{uid}/notifications/{id}`         | **delete**                                   | notifications slice — swipe-to-delete                                               |
| `title-cache/{tmdbId}` (doc)             | **read** `metadata.posterPath`               | notifications slice — the row thumbnail                                             |
| `title-cache/{tmdbId}` (write)           | **none**                                     | functions-only (`write: if false`) — confirm not written                            |

- **List read (decision 5).** Build the collection ref via `notificationsPath(uid)`,
  apply `query(col, orderBy('sentAt', 'desc'), limit(50))`, stream with `collectionData`
  using `{ idField: 'id' }` so each emitted doc carries its **real Firestore doc id**
  (needed for mark-read / delete — see the doc-id note). Map each wire doc through
  `dataToNotification` and keep the `id` alongside.
- **Doc-id note (load-bearing — defuses the apparent 0041 dependency).** Mark-read and
  delete target the notification by the **real Firestore doc id read from the live stream
  via `idField`**, _not_ by 0041's deterministic `${tmdbId}-${region}-${kind}` id scheme.
  So the inbox is **robust regardless of how the dispatcher ids docs** — its only genuine
  cross-spec deps are the **0016 `title-detail` route** (merged) and the `readAt` /
  `Timestamp` convention (already in domain + 0041). State this in Risks.
- **Mark-read write (decision 4a/4b).** Single:
  `updateDoc(doc(firestore, notificationPath(uid, id)), { readAt: Timestamp.now() })`
  (`Timestamp` from `@angular/fire/firestore`, matching 0041 — a partial `updateDoc`
  cannot route through the whole-doc converter, so writing a `Timestamp` directly is
  correct and storage-compatible; the field stays `timestamp | null` per PLAN §4). Batch:
  a `writeBatch(firestore)`, one `batch.update(doc(firestore, notificationPath(uid, id)),
{ readAt: Timestamp.now() })` per currently-unread id, then `batch.commit()`. Both
  null-uid-guarded and wrapped best-effort (a failure must not crash the page).
- **Delete write (decision 4c).** `deleteDoc(doc(firestore, notificationPath(uid, id)))`,
  null-uid-guarded, best-effort.
- **Poster read (decision 6).** `docData(doc(firestore, titleCacheDocPath(tmdbId)),
{ idField: ... })` (or `getDoc`) mapped through `dataToTitleCache`; compose
  `TMDB_POSTER_BASE + metadata.posterPath` when present, else emit `null` so the row
  renders the kind-based icon placeholder. The read is per-row and best-effort; a missing
  cache doc is **normal** (not an error), exactly as title-detail treats a cache miss.
- **Unread-count read (watchlist, decision 3).** A slice-local stream in the watchlist:
  `query(collection(firestore, notificationsPath(uid)), where('readAt', '==', null))`
  streamed with `collectionData`, mapped to `docs.length`. **Or** stream the whole
  collection and count `readAt === null` client-side (avoids a composite index). Pick the
  no-index option unless a `where('readAt','==',null)` single-field query is index-free in
  this project — **do not add a `firestore.indexes.json` entry** for this; if a query
  would require a composite index, count client-side instead. Null uid → `0`.
- **`firestore.rules` — VERIFIED, no change needed (record in PR).** The merged rules
  (`firestore.rules`) grant the owner **read + write** (which covers update + delete) on
  `users/{userId}` and **every** subcollection via the recursive wildcard
  `match /users/{userId}/{document=**} { allow read, write: if isOwner(userId); }`
  (lines 25–31) — this covers the notifications list read, the `readAt` updates, and the
  swipe delete. And `match /title-cache/{tmdbId} { allow read: if request.auth != null; }`
  (lines 46–48) covers the client poster read, with `write: if false` confirming the slice
  cannot (and must not) write the cache. **The implementer verifies these blocks are
  present and records "no `firestore.rules` change needed."** If owner-delete or
  notifications-read were somehow server-only, that would be a **blocking open item** (a
  rules change is a separate decision — do not widen silently). Per the verified state
  above, no such gap exists.

## 5. Public types / APIs

No new shared domain type, no new HTTP/callable endpoint. All new surface is slice-local,
exported (as needed) from `libs/mobile/notifications/src/index.ts`.

### `NotificationsService` (`src/lib/notifications.service.ts`)

```ts
import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  Timestamp,
  collection,
  collectionData,
  deleteDoc,
  doc,
  docData,
  limit,
  orderBy,
  query,
  updateDoc,
  writeBatch,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import type { NotificationDoc } from '@vultus/shared/domain';
import {
  dataToNotification,
  dataToTitleCache,
  notificationPath,
  notificationsPath,
  titleCacheDocPath,
} from '@vultus/shared/firestore-schema';
import { Observable, of } from 'rxjs';

/** A list row = the domain doc + its real Firestore id (idField), for mark-read/delete. */
export interface NotificationRow extends NotificationDoc {
  id: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly firestore = inject(Firestore);
  private readonly uid = inject(AUTH_UID);

  /** Realtime inbox: users/{uid}/notifications, sentAt desc, limit 50, mapped to
   *  NotificationRow (id from idField). Null uid → of([]). */
  notifications$(): Observable<NotificationRow[]>;

  /** Full poster URL for a tmdbId from title-cache, or null (→ icon placeholder).
   *  Best-effort; missing cache doc → null. */
  posterUrl$(tmdbId: number): Observable<string | null>;

  /** Set readAt on one notification. Null uid → no-op; best-effort (try/catch). */
  markRead(id: string): Promise<void>;

  /** Batch-set readAt on all currently-unread ids (writeBatch). Null uid → no-op. */
  markAllRead(unreadIds: string[]): Promise<void>;

  /** Delete one notification. Null uid → no-op; best-effort. */
  remove(id: string): Promise<void>;
}
```

Method/signal names are a **recommendation**; what is **binding**: the realtime list
(`sentAt` desc, `limit(50)`, `idField` so each row carries its real doc id), the
`dataToNotification` mapping, the title-cache poster read via `titleCacheDocPath` +
`dataToTitleCache` (best-effort, null on miss), the `markRead`/`markAllRead`/`remove`
writes via the `notificationPath` helper with a `Timestamp` `readAt`, a **null-uid guard**
before any uid-keyed call (no-op / empty stream, never throw on an undefined path), and
**never** writing `title-cache`.

### Relative-time helper (`src/lib/relative-time.ts`)

A pure function `relativeTime(iso: string, now?: Date): string` returning "Just now",
"Nh ago" (< 24h), "Yesterday", "N days ago" (< 7d), "1 week ago" / "N weeks ago",
falling back to a short absolute date for older items. **Check whether `date-fns` or
`@angular/common` is already a workspace dependency before adding anything** — prefer an
existing dep; otherwise this tiny pure formatter has **no** new dependency. Unit-tested
directly.

### `NotificationsPage` (`src/lib/notifications.page.ts`)

Standalone Ionic page (selector e.g. `lib-notifications`), the route's `loadComponent`
target, exported from the barrel. Subscribes to `NotificationsService.notifications$()`,
renders per §6, wires the four actions (decision 4) and the empty/loading states.

### Barrel surface (`src/index.ts`)

Export `NotificationsPage` (route target) and `NotificationsService`. Export
`NotificationRow` only if a consumer/test needs it across the barrel; keep
`relativeTime` and `TMDB_POSTER_BASE` slice-internal. Document the exported surface in the
README.

### Watchlist edit (`libs/mobile/watchlist`)

- A slice-local unread-count stream (in `watchlist.service.ts` or a small companion
  service): `unreadCount$(uid)` reading `users/{uid}/notifications` via `notificationsPath`
  (already imported from `@vultus/shared/firestore-schema`) and counting `readAt === null`
  (§4 unread-count note). Null uid → `0`.
- A bell `ion-button` in the existing `ion-buttons slot="end"` toolbar with a
  `notifications-outline` ionicon and an `ion-badge` overlay bound to the unread count
  (hidden when 0; display "9+" when > 9). Register the icon via `addIcons({...})` per the
  existing slice pattern.
- A handler `openNotifications(): void { this.router.navigate(['tabs','notifications']); }`
  injecting `Router` (already used in the watchlist for `navigateToDetail`). **No import
  of `@vultus/mobile/notifications`.**

## 6. UI / Stitch screen refs

This is a mobile slice — the visual contract is the Stitch screen **"Notifications -
Vultus"**, screen id **`505a6e4713c04b27a37a8c20a44aeccf`** (project
`13590348714018893783`, "Vultus Android App Design"; design system
`assets/85f6615a0a1e433887bddf7dd763bb56`). **The screen was generated and its raw HTML
fetched by the orchestrator**; the concrete values below are extracted from that markup
and are the **authoritative pinned contract**. The implementer **MUST still `get_screen`
this exact id** (retry on MCP failure — the Stitch MCP **is** reachable here, per project
memory; a sub-agent "unreachable" is a retry, not a fallback) and **visually verify** the
built page (render/screenshot or `mobile:serve-mock`) against it, and **record the screen
id in the PR**. A green build alone does NOT prove fidelity (CLAUDE.md).

**`docs/design/vultus-design-system.md` is the authoritative token set**; consume the
wired `--vultus-*` / `--ion-*` CSS custom properties from `shared/ui-kit` `theme.scss`.
**Never hand-transcribe a hex** — the hex values below are pinned only so the implementer
can confirm the token wiring matches the screen (primary is `#4edea3`, **not** `#10B981`,
which is `primary-container`).

- **Icon mapping — the app uses ionicons, NOT Material Symbols.** Map every Stitch
  Material glyph to an ionicon and do **not** load the Material Symbols font:
  `chevron_left` → `ion-back-button` default chevron (or `chevron-back`); `delete` →
  `trash` / `trash-outline`; the empty-state glyph → `notifications-off-outline`; the bell
  → `notifications-outline`. **Inter is already loaded app-wide** (spec 0010); this page
  must render in Inter, not a system fallback.
- **Ignore the Stitch bottom nav** — the real page is pushed within the `tabs` outlet, so
  the real tab bar renders; do **not** reimplement a nav.

### Layout & tokens — pinned contract (each row a checkable acceptance item)

| Element                    | Spec (from the screen markup)                                                                                                                                                                                                               | Token / var                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Header**                 | Height **64px** (`h-16`), bg `surface` (#0b1326), bottom border `outline-variant` at 30% (#3c4a42). Realize as `ion-header > ion-toolbar`.                                                                                                  | `--vultus-surface`, `--vultus-outline-variant`                                         |
| Header back                | Chevron back affordance, `on-surface`. Realize as `ion-back-button slot="start"` (`defaultHref="tabs/watchlist"`), default chevron.                                                                                                         | `--vultus-on-surface`                                                                  |
| Header title               | "Notifications", role **headline-sm** (Inter 20/600), `on-surface`. `ion-title`.                                                                                                                                                            | type role `headline-sm`; `--vultus-on-surface`                                         |
| Header **"Mark all read"** | Right action, role **label-md** (12/600, +0.05em), `primary` (#4edea3), **hover → opacity 80%**. `ion-buttons slot="end"` → `ion-button fill="clear"` themed primary. Disabled/hidden when there are **0 unread** rows.                     | type role `label-md`; `--ion-color-primary` / `--vultus-primary`                       |
| **List container**         | Side padding **16px** (`margin-mobile`), top padding **24px** (`lg`), vertical gap **8px** (`sm`) between rows.                                                                                                                             | `--vultus-space-md` (16), `--vultus-space-lg` (24), `--vultus-space-sm` (8)            |
| **Row card**               | Radius **24px** (`rounded-xl` / 1.5rem), 1px border `outline-variant` (#3c4a42), bg `surface-container` (#171f33), inner padding **8px** (`sm`), flex row, gap **16px** (`md`).                                                             | `--vultus-radius-*` (1.5rem), `--vultus-outline-variant`, `--vultus-surface-container` |
| **Poster thumb**           | **48 × 72px** (2:3), radius **16px** (`rounded-lg`), `object-cover`, `surface-variant` (#2d3449) placeholder bg behind the image. Fallback = kind-based ionicon centered on the placeholder when no poster.                                 | `--vultus-surface-variant`                                                             |
| **Content column**         | Vertical, gap **4px** (`xs`). Title = role **body-lg** (16) **semibold**, `on-surface` (#dae2fd). Body = role **body-md** (14), `on-surface-variant` (#bbcabf). Timestamp = role **label-sm** (11), `outline` (#86948a), relative.          | `--vultus-on-surface`, `--vultus-on-surface-variant`, `--vultus-outline`               |
| **Unread row**             | Add `bg-primary-container/5` (5% emerald #10b981 tint over the container) **and** a trailing **emerald dot** (10px, `w-2.5 h-2.5`, `rounded-full`, `primary` #4edea3, 4px right margin). Text full opacity.                                 | `--vultus-primary-container` (alpha), `--vultus-primary`                               |
| **Read row**               | Plain `surface-container`, **no tint, no dot**; **content opacity 70%, poster opacity 60%**.                                                                                                                                                | —                                                                                      |
| **Swipe-delete action**    | Trailing red action (`status-dropped` #EF4444) revealed behind the row; `trash` ionicon + "Delete" label (role label-sm), both **white**. Realize as `ion-item-sliding` + `ion-item-options side="end"` + `ion-item-option color="danger"`. | `--vultus-status-dropped`; Ionic `color="danger"`                                      |
| **Pressed state**          | Subtle **5% emerald overlay**, **not** a lift (design-system "Interactions").                                                                                                                                                               | `--vultus-primary` (alpha overlay)                                                     |

- **Structure note (do not assume a 1:1 Ionic mapping):** the Stitch rows are plain
  bordered cards in a flex column, not an `ion-list` of default `ion-item`s — but
  swipe-to-delete needs `ion-item-sliding`/`ion-item-options`. Realize each row as an
  `ion-item-sliding` whose `ion-item` is styled (lines="none", custom bg/border/radius/
  padding) to match the card silhouette above, with the trailing `ion-item-options`
  carrying the danger delete option. The 8px inter-row gap and 16px side inset **must
  agree** across all rows and with the empty/loading states (no shift on swap).
- **Token wiring (easy to miss):** the emerald used for the dot, the "Mark all read"
  action, and the unread tint is **`primary` `#4edea3`** via `--ion-color-primary` /
  `--vultus-primary`; the 5% _tint background_ is `primary-container` `#10b981` at 5%
  alpha (`--vultus-primary-container`). Do not conflate them.

### Empty + loading states — NOT in the Stitch screen (derived from spec 0024)

The Stitch screen renders only populated content; the empty and loading states are **not
depicted**. This is an **intentional derivation from the spec 0024 state-atom pattern**,
not a skipped capture — stated explicitly so the spec-reviewer does not flag it. Read
`libs/shared/ui-kit` (`VultusEmptyState`, `VultusSkeletonCard`) before building.

- **Empty state** (`notifications$()` emits `[]`): render
  `<vultus-empty-state icon="notifications-off-outline" title="No notifications yet"
subtitle="You'll see new-episode and now-streaming alerts here.">` from
  `@vultus/shared/ui-kit`. Register `notificationsOffOutline` in the page via `addIcons`
  (the atom does not register consumer icons — 0024 contract). Title = body-lg, subtitle =
  body-md, centered, per the atom.
- **Loading state** (before the first stream emission): render
  `<vultus-skeleton-card [count]="6">` from `@vultus/shared/ui-kit` — its poster + title +
  meta silhouette already matches a notification row's left-thumb + two text lines, so the
  skeleton→content swap does not shift. Drive it off a "not yet emitted" view-model branch
  (e.g. `rows === null` → loading; `rows === []` → empty; otherwise the list), matching
  the watchlist's `vm$` gating pattern.

### Interactive-state contract (tick each off in review)

| Element              | default                                                                   | focus                       | hover / active                                      | result                                                      |
| -------------------- | ------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| **Row (tap target)** | card silhouette above; unread tint+dot or read dimming per state          | Ionic `:focus-visible` ring | **active → 5% emerald overlay** (no lift)           | navigate `['tabs','title-detail', tmdbId]` + `markRead(id)` |
| **Row swipe**        | trailing red `status-dropped` delete option revealed on left-swipe        | —                           | swipe transition (Ionic `ion-item-sliding` default) | `remove(id)`                                                |
| **"Mark all read"**  | `fill="clear"`, text `primary`, label-md; **hidden/disabled at 0 unread** | Ionic `:focus-visible` ring | **hover → opacity 80%**                             | `markAllRead(unreadIds)`                                    |
| **Back button**      | `ion-back-button` default chevron, `on-surface`                           | Ionic `:focus-visible` ring | Ionic default                                       | pop to `tabs/watchlist`                                     |
| **Pull-to-refresh**  | `ion-refresher` at top                                                    | —                           | Ionic refresher spinner during pull                 | complete on next stream tick / re-read                      |
| **Watchlist bell**   | `notifications-outline`, `ion-badge` unread count (hidden 0, "9+" cap)    | Ionic `:focus-visible` ring | Ionic toolbar-button default                        | navigate `['tabs','notifications']`                         |

- **Animations/transitions:** page push/back uses Ionic's default route transition; the
  swipe uses Ionic's `ion-item-sliding` transition (the screen's `swipe-transition` is
  `transform .3s cubic-bezier(.4,0,.2,1)` — Ionic's default is acceptable, note any
  simplification in the PR); the loading→loaded swap must **not flash** (gate on first
  emission).
- **UI fidelity must be visually verified** (`mobile:serve-mock` or render/screenshot) or
  **explicitly flagged unverified for a human** — a green build does not prove fidelity
  (CLAUDE.md). If a `providers.mock.ts` is added (see §7), seed a mix of unread/read rows
  with and without posters so all row states are exercised under `--configuration=mock`.

## 7. Implementation task graph

**T1 — generate `libs/mobile/notifications` [sequential]** (frontend-engineer)

New-lib / project-graph change goes first; T2–T4 depend on the lib existing. Generate the
Angular lib with the repo generator, the `@vultus/mobile/notifications` path alias, the
barrel, the README scaffold, and verify the Sheriff glob/vocabulary covers it (§3 —
edit `sheriff.config.ts` only if a gap exists). This task lands the empty lib skeleton +
README + barrel; the page/service bodies are T3.

Files (writes): `libs/mobile/notifications/**` (the generated lib: `project.json`,
tsconfig(s), `eslint.config.mjs`, `vite.config.mts`, `src/test-setup.ts`,
`src/index.ts`, `README.md`); `tsconfig.base.json` (path alias — shared root file, hence
sequential); `sheriff.config.ts` (only if a vocabulary gap exists).

**T2 — register `tabs/notifications` route [sequential, after T1]** (frontend-engineer)

Add a `{ path: 'notifications', loadComponent: () => import('@vultus/mobile/notifications')
.then(m => m.NotificationsPage) }` child of the `tabs` route in `app.routes.ts`, alongside
the existing `title-detail/:titleId` child, before the `{ path: '', redirectTo:
'watchlist' }` catch-all. Sequential because it imports the T1 barrel.

Files (writes): `apps/mobile/src/app/app.routes.ts`; `apps/mobile/src/app/app.routes.spec.ts`
(only if a route spec exists).

**T3 — NotificationsService + NotificationsPage [parallel, after T1]** (frontend-engineer)

Implement the service (§5: `notifications$` sentAt-desc/limit-50/idField stream,
`posterUrl$` title-cache read, `markRead`/`markAllRead` batch/`remove`, null-uid guards),
the relative-time helper, and the page per the §6 contract (unread/read styling, poster-or-
icon thumbnail, "Mark all read", swipe-delete, pull-to-refresh, empty + loading states via
the `@vultus/shared/ui-kit` atoms). Add a `providers.mock.ts` if the slice's mock-serve
pattern uses one (mirror `settings.providers.mock.ts`) so `--configuration=mock` renders
seeded rows. Co-located specs (§8).

Files (writes): `libs/mobile/notifications/src/lib/**` (page `.ts`/`.html`/`.scss`,
`notifications.service.ts`, `relative-time.ts`, `providers.mock.ts` if used, all
`*.spec.ts`), `libs/mobile/notifications/src/index.ts` (barrel exports),
`libs/mobile/notifications/README.md` (replace scaffold with real content).

**T4 — watchlist header bell + unread badge + navigation [parallel, after T1]** (frontend-engineer)

Add the unread-count stream (§4 note), the bell `ion-button` + `ion-badge` in the existing
toolbar, the `notifications-outline` icon registration, and `openNotifications()` navigating
by string route. Update tests + README. Independent of the notifications-lib internals (no
barrel import; only `@vultus/shared/firestore-schema` + `Router`) — but the
`tabs/notifications` route (T2) must exist at runtime for the nav to land (relevant to the
e2e, §8).

Files (writes): `libs/mobile/watchlist/src/lib/watchlist.page.ts`,
`libs/mobile/watchlist/src/lib/watchlist.page.html`,
`libs/mobile/watchlist/src/lib/watchlist.page.scss`,
`libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
`libs/mobile/watchlist/src/lib/watchlist.service.ts` (or a small companion unread-count
service + its spec, both under `libs/mobile/watchlist/src/lib/`),
`libs/mobile/watchlist/README.md`.

**Disjointness:** T3 writes only under `libs/mobile/notifications/**`; T4 only under
`libs/mobile/watchlist/**`; T2 only `apps/mobile/src/app/app.routes.ts(.spec.ts)`. The
three parallel-eligible manifests (T3 / T4 / T2) are **pairwise disjoint**. T1 (which
touches the shared root files `tsconfig.base.json` + possibly `sheriff.config.ts`) runs
**first and alone**; T2 also runs sequentially (depends on the T1 barrel). The e2e
**fixture/seed** that T3 or the qa step authors lives under `apps/mobile-e2e/**` — outside
every slice manifest, so it does not collide.

## 8. Test plan

Per the PLAN §5 pyramid (Vitest + Analog for unit/component; Playwright for e2e). All
Firebase access in unit/component tests is **mocked** — no live Firebase, no emulator
(project memory: the emulator cannot run under Claude Code tools here).

**Unit (Vitest) — `notifications.service.spec.ts` (mock `Firestore`/AngularFire fns):**

- `notifications$()` builds the query with `orderBy('sentAt','desc')` + `limit(50)`,
  maps wire docs through `dataToNotification`, and carries the `idField` id on each row;
  **null uid → `of([])`** (assert no collection ref built).
- `markRead(id)` calls `updateDoc` on `notificationPath(uid, id)` with `{ readAt:
<Timestamp> }`; **null uid → no write**; a rejected `updateDoc` is caught (non-fatal).
- `markAllRead(unreadIds)` opens a `writeBatch`, issues one `update` per id, and commits;
  empty array → no commit (or a harmless empty commit); null uid → no-op.
- `remove(id)` calls `deleteDoc` on `notificationPath(uid, id)`; null uid → no-op;
  rejection caught.
- `posterUrl$(tmdbId)` composes `TMDB_POSTER_BASE + metadata.posterPath` on a cache hit,
  emits `null` on a missing doc or null `posterPath` (best-effort, no throw).

**Unit (Vitest) — `relative-time.spec.ts`:** "Just now", "Nh ago", "Yesterday", "N days
ago", "1 week ago" boundaries against a fixed `now`.

**Component (TestBed/Analog) — `notifications.page.spec.ts` (mocked service):**

- renders rows from a mocked `notifications$` (assert count + first-row title/body/timestamp);
- **unread** row shows the emerald dot + tint, **read** row is dimmed with no dot;
- **empty stream → `vultus-empty-state`**; **pre-emission → `vultus-skeleton-card`**;
- **row tap** → `Router.navigate(['tabs','title-detail', String(tmdbId)])` **and**
  `service.markRead(id)` called with the row's real id;
- **"Mark all read"** → `service.markAllRead(<unread ids>)`; the action is hidden/disabled
  when no rows are unread;
- **swipe option** → `service.remove(id)`;
- **pull-to-refresh** → the refresher completes (assert `event.target.complete()` called).

**Component (TestBed/Analog) — watchlist (extend the existing `watchlist.page.spec.ts`):**
the bell renders; the `ion-badge` shows the unread count and **hides at 0** / shows **"9+"**
above 9; tapping the bell → `Router.navigate(['tabs','notifications'])`. Plus a unit test
for the unread-count stream (count of `readAt === null`; null uid → 0).

**e2e (Playwright, `apps/mobile-e2e`, emulator) — REQUIRED.** This is a `scope:mobile`
feature introducing a new primary route + critical action (open inbox, deep-link), so per
the rubric e2e is **required** and these flows become DoD gates. Author two named flows,
seeding `users/{uid}/notifications` docs (and optional `title-cache` poster docs) in the
emulator:

- **`notifications inbox lists seeded notifications and deep-links a tap`** — tap the
  watchlist header bell → the inbox lists the seeded notifications (assert row count, the
  first row's title text, the unread dot present); tap a row → URL is
  `tabs/title-detail/:titleId` for that title.
- **`notifications empty state`** — with **no** notifications seeded, the bell opens an
  inbox showing the empty state ("No notifications yet").

These are **real passing e2e** independent of live FCM (they read seeded Firestore, not a
push) — so unlike 0041's `test.fixme` push flow, they are **not** fixme-gated. **Memory
caveat:** the emulator / e2e gate **cannot run under Claude Code tools here** — author the
specs; the QA gate runs in the **user's own terminal** (`firebase emulators:start` +
`pnpm nx e2e mobile-e2e`). State this in the PR.

## 9. Definition of done

Tailored from the PLAN §5 checklist. `<app>` = `mobile`; affected projects:
`mobile-notifications` (new), `mobile-watchlist`, `mobile` (shell), `mobile-e2e`.

- [ ] `pnpm nx affected -t typecheck --base=main` passes (new slice + watchlist + shell compile).
- [ ] `pnpm nx affected -t lint --base=main` passes **with Sheriff active**: the
      notifications slice imports only `@vultus/shared/*` + framework/third-party — **no**
      `slice:*`, **no** `scope:functions`; both the inbox→detail nav and the bell→inbox nav
      use `Router` **string segments** (no cross-slice barrel import).
- [ ] `pnpm nx affected -t test --base=main` passes: `NotificationsService` + relative-time
      unit tests, `NotificationsPage` component tests (unread/read styling, empty, loading,
      tap navigate+markRead, mark-all-read, swipe-delete, refresher), and the watchlist
      bell/badge/unread-count tests, all green.
- [ ] `pnpm nx affected -t build --base=main` passes for all affected projects.
- [ ] **e2e authored** for the two named flows (`notifications inbox lists seeded
    notifications and deep-links a tap`, `notifications empty state`); they **pass in the
      user's terminal** against the emulator (the gate cannot run under Claude Code tools —
      recorded, not skipped).
- [ ] The new lib has a real `README.md` (purpose, public surface = barrel, usage,
      Sheriff scope/slice); the watchlist `README.md` is updated to note the new header
      bell + unread badge (it enumerates the page surface). CLAUDE.md lib-README rule.
- [ ] No hardcoded hex in any new `.scss`/template — all colors via `--vultus-*` /
      `--ion-*` vars (grep the diff for `#` literals); the only literal is the slice-local
      `TMDB_POSTER_BASE` URL constant (copied from the watchlist pattern).
- [ ] **Boundary verifications (review-checked):** (a) **no `slice:*` cross-import** — the
      bell navigates by `Router` string segments and the inbox imports only `scope:shared`;
      (b) `firestore.rules` **owner read+update+delete** on `users/{uid}/notifications/**`
      and **client read** of `title-cache` **verified present** (record "no rules change
      needed"); (c) the slice **never writes** `title-cache`; (d) **no secret read or written**.
- [ ] **UI fidelity vs Stitch screen `505a6e4713c04b27a37a8c20a44aeccf` visually verified**
      (`mobile:serve-mock` or screenshot) **or explicitly flagged unverified for a human**;
      the screen id recorded in the PR (a green build does not prove the UI is right — CLAUDE.md).
- [ ] PR description records: the screen id pulled + visual-verification result, the
      `firestore.rules` verification, the e2e run result from the user's terminal, and the
      chosen unread-count query approach (client-count vs `where`).

## 10. Risks

- **0041 coupling is shallow (defuses the apparent dependency).** The inbox marks-read /
  deletes by the **real streamed Firestore doc id** (`collectionData` `idField`), so it is
  **robust regardless of 0041's deterministic-id scheme**. Its only genuine cross-spec deps
  are the **0016 `title-detail` route** (merged) and the `readAt` / `Timestamp` convention
  (already in `shared/domain` + 0041). This spec **sequences after** 0041 conceptually but
  does not import or require 0041's id pinning.
- **Bell couples watchlist → notifications data** (the unread-count read). It is
  **Sheriff-legal** (a `scope:shared` schema read via `notificationsPath` +
  `@angular/fire`, no slice import) but a mild smell. The shell-hosted global-bell
  alternative was **rejected**: Ionic headers are per-page, there is no shell-level header
  to host a global bell, so the entry point must live in a page header — the watchlist's is
  the natural home.
- **`title-cache` client read for posters** depends on the rules permitting it. **Verified
  present** (`firestore.rules` line 47, `allow read: if request.auth != null`); if it were
  ever removed, fall back to the icon placeholder (the read is already best-effort) — **do
  not widen rules silently**.
- **`firestore.rules` owner-delete on notifications.** Verified present via the recursive
  `users/{userId}/{document=**}` owner read+write block; if it were absent, swipe-delete
  would silently fail (best-effort) and that would be a **blocking open item** (a rules
  change is a separate decision).
- **Unread-count query may want an index.** A `where('readAt','==',null)` is single-field
  (index-free) in Firestore, but to be safe the spec allows counting `readAt === null`
  client-side over the streamed collection — **do not add a `firestore.indexes.json`
  entry**. Stated so the implementer picks the index-free path deliberately.
- **Live stream + pull-to-refresh redundancy.** The list is realtime, so `ion-refresher`
  is a supplementary affordance (it completes on the next tick / a re-read); it does not
  fetch anything the stream wouldn't already deliver. Intentional, for the expected gesture.
- **50-item cap, no pagination (v1).** Older notifications beyond the newest 50 are not
  shown. Explicit; a later spec adds paging if needed.
- **No delete-confirm (v1).** A swipe immediately deletes; an accidental swipe loses a
  low-value notification. Acceptable for v1 (the gesture is deliberate); a confirm is a
  later refinement.
- **Material Symbols → ionicons mapping.** The Stitch screen names Material glyphs; the app
  uses ionicons and must **not** load the Material Symbols font. The mapping is pinned in
  §6 — a mis-map (wrong glyph) is the likely fidelity slip; verify visually.
- **Empty/loading states absent from the Stitch screen.** Derived from the spec 0024
  state-atom pattern (`VultusEmptyState` / `VultusSkeletonCard`) — an **intentional
  derivation**, not a skipped capture. Stated so the spec-reviewer does not flag it.
- **UI fidelity not provable by a green build** (CLAUDE.md) — requires a visual check
  (`mobile:serve-mock` / screenshot) or an explicit unverified-for-human flag in the PR.
- **No PLAN conflict.** This completes the user-facing notification loop deferred by 0041;
  vertical-slice (new slice owns its UI/state/data/types), the no-cross-slice-import rule
  (string-route navigation, shared-schema reads only), and the extract-at-3+ rule (no
  `shared/` extraction) are all respected.
