---
number: 0057
slug: leaving-platform-notifications
title: Notify when a tracked title loses flatrate availability in the user's region
status: approved
slices: [slice:dispatch-notifications, slice:notifications, slice:settings]
scopes: [scope:functions, scope:mobile, scope:shared]
created: 2026-07-01
---

# Notify when a tracked title loses flatrate availability in the user's region

## Context

Spec 0012 (`done`) built the notification dispatcher: a Firestore
`onDocumentWritten` trigger on `title-cache/{tmdbId}/availability/{region}` that
classifies the flatrate transition for the changed region and fans out per-user
notifications. The pure classifier
(`libs/functions/dispatch-notifications/src/lib/transitions.ts`
`classifyFlatrateTransition`) already computes three transitions: flatrate count
`0 → ≥1` = `'appeared'`, `≥1 → ≥1` (or any non-transition) = `'unchanged'`, and —
critically — **any drop to flatrate count 0** (a provider disappearing, or a
provider switching from flatrate to rent/buy-only) = `'removed'`. Spec 0012
**decision 1C** deliberately made `'removed'` dispatch **nothing** (`decideKinds`
returns `[]`), a v1 scope cut.

Spec 0041 (`done`) added the app-side push handler + deep-link and the FCM
`notification` key; spec 0042 (`done`) added the in-app notifications inbox that
lists `users/{uid}/notifications`; spec 0051 (`done`) added the per-user
`deliveryHour` quiet-hours gate. Together these deliver every existing kind
end to end.

**This spec reopens decision 1C.** It's time to notify on removal too, so the
user knows to watch a title before it disappears from their subscription. The
sync pipeline, `previousSnapshot` rollover, and `classifyFlatrateTransition`
already run daily and already produce `'removed'` — this spec is purely about
**acting on a classification that already exists**, not building new sync or
transition-detection logic.

Intended outcome: when the daily sync observes a tracked title lose all flatrate
providers in the user's region, the user gets a "leaving your platform" alert
(inbox doc + FCM push, subject to their per-kind opt-in and delivery-window),
routed by the same deep-link wiring as every other kind. A user who leaves the
new toggles on sees the new alerts; a user who turns them off does not.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Split by title type, mirroring the existing appeared-kinds pattern.** Add
   two new `NotificationKind` values to
   `libs/shared/domain/src/lib/enums.ts`'s `NOTIFICATION_KINDS` const array:
   `'movie-leaving-platform'` (movie, flatrate removed) and
   `'show-leaving-platform'` (tv show, flatrate removed) — mirroring the existing
   `'movie-available'` / `'show-came-to-platform'` split. Update the
   exhaustiveness-checked `assertKindExhaustive` switch in
   `libs/shared/domain/src/lib/type-assertions.ts` (the `default` `never` branch
   fails `typecheck` if a case is missed — that's the safety net).

2. **Reuse the existing `'removed'` classification verbatim — no new transition
   logic.** `classifyFlatrateTransition` already returns `'removed'` whenever
   flatrate count drops to 0, whether the title becomes fully unavailable or
   merely switches to rent/buy-only. Do NOT add a new transition case or
   distinguish "fully gone" from "rent/buy remains". `decideKinds` maps
   `'removed'` → `['movie-leaving-platform']` for movies and
   `['show-leaving-platform']` for tv shows, **replacing** today's `'removed' →
   []`.

3. **Same delivery pipeline as existing kinds — no new infrastructure.** Same
   `NotificationDoc` write to `users/{uid}/notifications/{id}`, same FCM
   data+notification message to registered tokens, same region-match +
   watchlist-tracking gate, same per-kind prefs gate, same quiet-hours
   `deliveryHour` gate (spec 0051). No new Firestore collections, no new Cloud
   Function, no new trigger — new cases inside the existing `onDocumentWritten`
   trigger's decision logic and its adapters.

4. **New per-kind opt-in toggles in `NotificationPrefs`.** Add
   `movieLeavingPlatform: boolean` and `showLeavingPlatform: boolean` to
   `NotificationPrefs`, following the existing per-kind boolean pattern. Both
   default **`true`** for new docs, and legacy docs missing them coalesce to
   **`true`** in `dataToUser` (mirroring how `deliveryHour` coalesces to `null`
   for legacy docs — see Data model for the rationale for `true` rather than
   `null`/`false`). Add two toggle **rows** in the mobile Settings UI.

5. **In-app notifications inbox (spec 0042) must render the new kinds.**
   `libs/mobile/notifications/src/lib/notifications.page.ts` maps each kind to an
   icon (`kindIcon`) and copy (`body`); add branches for the two new kinds.

6. **Push deep-link behaviour unchanged.** Spec 0041's handler deep-links FCM
   taps to title-detail by `data.tmdbId`, reading a `{ notificationId, titleId,
   kind, region, tmdbId }` data record. The new kinds flow through the exact same
   `NotificationPayload` shape and `data` record construction — no change to the
   mobile handler. The one FCM wiring touch is the OS-rendered copy
   (`buildNotification` in `apps/functions/src/dispatch/adapters.ts`), which today
   only knows `episode-aired` vs "everything else = availability copy" and would
   otherwise mis-label a leaving push as "Now available to stream" (see Public
   types / APIs).

7. **Out of scope:** predicting an *upcoming* removal before it's observed
   (TMDB/Trakt don't reliably expose a "leaving on" date) — this fires only once
   removal is actually observed in a sync pass, reactive not predictive; the
   "fully gone vs switched to rent/buy" distinction (decision 2); any change to
   the sync engine or classifier beyond consuming the existing `'removed'`
   output.

8. **No new e2e flows** (see Test plan rubric outcome). Backend decision-logic +
   two additive Settings toggle rows + two additive inbox row variants introduce
   **no new route or primary navigation/critical action**.

## Scope

In scope:

- **Two new `NotificationKind` values** (`'movie-leaving-platform'`,
  `'show-leaving-platform'`) in `@vultus/shared/domain` `NOTIFICATION_KINDS`,
  with `assertKindExhaustive` updated.
- **Two new `NotificationPrefs` booleans** (`movieLeavingPlatform`,
  `showLeavingPlatform`), required, defaulting `true`; the `dataToUser`
  legacy-doc coalesce to `true`; the `_user` type-assertion literal updated;
  READMEs updated.
- **Dispatcher decision change** (`libs/functions/dispatch-notifications`):
  `decideKinds` maps `'removed'` → the type-specific new kind; `isKindEnabled`
  gains the two cases (legacy-tolerant default `true`). The
  `apps/functions` `WatchlistStore` adapter must carry the two new prefs into
  `TrackingUser.notificationPrefs`, defaulting a missing value to `true`.
- **FCM OS-copy** (`apps/functions/src/dispatch/adapters.ts` `buildNotification`):
  add a leaving-platform copy branch so the two new kinds render "leaving"
  wording, not availability wording.
- **Inbox rendering** (`libs/mobile/notifications`): `kindIcon` + `body`
  branches for the two new kinds.
- **Settings UI** (`libs/mobile/settings`): two new toggle rows persisting the
  two new prefs, mirrored in the mock providers.
- Unit + component tests per the Test plan; no new e2e.

Out of scope (explicitly):

- **Predictive / "leaving on <date>" notifications** (decision 7) — reactive
  only, at the same trigger point as `'appeared'`.
- **The "fully gone vs switched to rent/buy" distinction** (decision 2) — both
  are `'removed'`; one kind per title type.
- **Any sync-engine / classifier change** — `classifyFlatrateTransition` already
  returns `'removed'`; this spec consumes it unchanged.
- **New Firestore collections / Cloud Function / trigger / FCM channel** —
  reuses the whole spec-0012/0041/0051 pipeline (decision 3).
- **Changing the global Notifications toggle semantics** — the spec-0011/0018
  global toggle is a projection over the *three original* booleans and its
  `setNotificationsEnabled` writes those three; the two new prefs are
  **independent per-kind rows**, NOT folded into that projection (see Public
  types / APIs — this avoids a behaviour change to the existing global toggle
  and its tests).
- **Deep-link / push-handler change** (spec 0041) — the new kinds reuse the
  existing `data`-record construction and route wiring; only the OS-copy branch
  is touched.
- **`firestore.rules` / `firestore.indexes.json` changes** — additive prefs
  fields on `users/{uid}` (owner read/write already granted); the dispatcher runs
  as the Admin SDK (bypasses rules); no new query. No rules/indexes edit.

## Affected slices & Sheriff tags

| Project                                 | Path                                    | Sheriff tags                                      | Change                                                                                                    |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| shared-domain (edit)                    | `libs/shared/domain`                    | `scope:shared`                                    | **add** two `NotificationKind`s + two `NotificationPrefs` booleans; update `assertKindExhaustive` + `_user` literal; README |
| shared-firestore-schema (edit)          | `libs/shared/firestore-schema`          | `scope:shared`                                    | `dataToUser` coalesce for the two new prefs (missing → `true`); extend round-trip tests; README if it lists prefs |
| functions-dispatch-notifications (edit) | `libs/functions/dispatch-notifications` | `scope:functions`, `slice:dispatch-notifications` | `decideKinds` maps `'removed'` → new kind; `isKindEnabled` two cases; README + tests                       |
| functions (app, edit)                   | `apps/functions`                        | `scope:functions`                                 | adapter carries new prefs into `TrackingUser`; `buildNotification` leaving-copy branch; specs             |
| mobile-notifications (edit)             | `libs/mobile/notifications`             | `scope:mobile`, `slice:notifications`             | `kindIcon` + `body` branches for the two new kinds; specs                                                  |
| mobile-settings (edit)                  | `libs/mobile/settings`                  | `scope:mobile`, `slice:settings`                  | two new toggle rows + service signals/setters; mock mirror; README; specs                                  |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (specs 0010/0012/0051). All
  six projects already resolve their tags from their paths. **This spec does NOT
  edit `sheriff.config.ts`.**
- **Import boundaries — no new edges.** Every touched project already imports the
  symbols it needs:
  - `libs/functions/dispatch-notifications` already imports `NotificationKind` /
    `NotificationPrefs` / `TitleType` in `transitions.ts` + `dispatcher.ts`; the
    new logic reads existing types only. Stays Firebase-free; no Admin-SDK import
    enters the core.
  - `apps/functions/src/dispatch/adapters.ts` already imports `NotificationPrefs`
    and the ports; the new prefs are additive fields on an already-imported type.
  - `libs/mobile/notifications` already imports `NotificationKind` and switches on
    `kind` in `kindIcon` / `body`; adding two cases needs no new import.
  - `libs/mobile/settings` already imports `User['notificationPrefs']` /
    `Firestore` / `AUTH_UID`; the new toggles read/write the already-imported
    prefs type through the existing converter path. No other slice, no
    `scope:functions`.
- **No `scope:mobile` ↔ `scope:functions` edge.** The settings slice and the
  dispatcher communicate only through the persisted `users/{uid}` doc and the
  shared `NotificationPrefs` type — never by importing each other.
- **No `shared/` extraction.** The only shared changes are additive type
  vocabulary (two enum members, two prefs booleans) — the spec-0003/0005/0012/0051
  persisted-vocabulary contract, not a logic extraction. The decision logic stays
  in the dispatcher slice; the UI stays in settings/notifications slices. The
  3+-slice rule (CLAUDE.md / PLAN §3) is respected.

## Data model touchpoints

PLAN §4 paths. The change is: two additive members of the
`notifications/{id}.kind` union, and two additive `users/{uid}.notificationPrefs`
booleans. No new collection, no new top-level field, no converter-body change to
`notificationToData`/`dataToNotification` (payload/kind pass through).

| PLAN §4 path                                       | Access                             | By                                                                                     |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `users/{uid}.notificationPrefs.movieLeavingPlatform` | **read**, **create**, **update** | settings slice (read on load; default `true` on eager create; write on toggle)         |
| `users/{uid}.notificationPrefs.showLeavingPlatform`  | **read**, **create**, **update** | settings slice (same)                                                                  |
| `users/{uid}.notificationPrefs.*` (both new)         | **read**                         | dispatcher (per-user, via `TrackingUser.notificationPrefs` the adapter loads)          |
| `title-cache/{tmdbId}/availability/{region}`         | **trigger source** (unchanged)   | the `onDocumentWritten` event's `after` (providers + previousSnapshot) — no change     |
| `users/{uid}/notifications/{id}`                     | **create** (unchanged shape)     | dispatcher — one doc per dispatched new kind, `kind` ∈ the two new members             |

- **`NotificationKind` union widened.** PLAN §4 lists
  `kind: "episode-aired" | "movie-available" | "show-came-to-platform"` as a
  representative sample (the merged code already added `tmdbId` to the payload,
  etc.); adding two members is **consistent with PLAN §4** (the field is an
  open-ended kind discriminant, not a fixed three). The
  `notificationToData`/`dataToNotification` converters copy `kind` straight
  through — **no converter-body change**; the round-trip test may add a case for a
  new kind but is not required to.
- **New prefs shape:** `movieLeavingPlatform: boolean`,
  `showLeavingPlatform: boolean` — required (mirroring the three existing required
  booleans), value always present on new docs.
- **Default `true`, not `false`/`null` — and why (load-bearing).** `deliveryHour`
  defaults `null` because `null` = "no restriction" = the *pre-existing* behaviour
  (send any time). For the leaving-platform kinds the pre-existing behaviour was
  "no such notification at all"; the product intent (decision 4) is that turning
  this feature on should make existing users **receive** the new alerts by
  default (opt-out), consistent with the other three kinds which default `true`.
  So:
  - **New docs:** the settings eager-create defaults set
    `movieLeavingPlatform: true, showLeavingPlatform: true`.
  - **Legacy docs (pre-0057):** `dataToUser` coalesces a **missing** value to
    `true` (`data.notificationPrefs.movieLeavingPlatform ?? true`), so a user who
    created their doc before this spec still gets the new alerts without touching
    Settings. This differs from `deliveryHour`'s `?? null` **intentionally**
    because `true` (not `null`) is the "no preference expressed → default on"
    value for a per-kind opt-in boolean.
  - **Dispatcher:** the `apps/functions` `WatchlistStore` adapter builds
    `TrackingUser.notificationPrefs` from the raw `users/{uid}` doc (it passes
    `userData.notificationPrefs` through — see `adapters.ts`
    `createFirestoreWatchlistStore`). A legacy doc's `notificationPrefs` lacks the
    new booleans, so `prefs.movieLeavingPlatform` would be `undefined`. The core's
    `isKindEnabled` must therefore treat a missing new-kind pref as **enabled**
    (`prefs.movieLeavingPlatform !== false`, i.e. `undefined`/`true` → enabled,
    only an explicit `false` disables). **Choose and document** this
    `!== false` semantics in the core so legacy docs behave as "on" without the
    adapter having to backfill. (The existing three kinds keep their strict
    boolean read — they are always present on every doc that reached the
    dispatcher via spec 0011's eager create.)
- **Eager-create defaults (settings `load()`):** extend the create literal to
  `{ region: 'NL', notificationPrefs: { episodeAired: true, movieAvailable: true,
  cameToPlatform: true, movieLeavingPlatform: true, showLeavingPlatform: true,
  deliveryHour: null }, fcmTokens: [] }`.
- **Write on toggle:** each new toggle persists by rewriting the **whole**
  `notificationPrefs` object from service state (the same pattern
  `setNotificationsEnabled` / `setDeliveryHour` already use — see
  `settings.service.ts`), so no setter clobbers another's fields. Do **not**
  introduce a separate top-level field.
- **No `firestore.rules` / `firestore.indexes.json` change.** Owner read/write on
  `users/{uid}` already covers the additive prefs (spec 0004/0011); the dispatcher
  runs as the Admin SDK; no new `where` query. **Do NOT edit either file.**

## Public types / APIs

No new HTTP/callable endpoint, no new barrel export — additive enum members,
additive prefs fields, and slice-local UI surface.

### Shared domain change (additive)

`libs/shared/domain/src/lib/enums.ts` — extend the const array:

```ts
export const NOTIFICATION_KINDS = [
  'episode-aired',
  'movie-available',
  'show-came-to-platform',
  'movie-leaving-platform',
  'show-leaving-platform',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
```

`libs/shared/domain/src/lib/type-assertions.ts` — add the two cases to the
exhaustive switch (else the `default` `never` branch fails `typecheck`):

```ts
function assertKindExhaustive(k: NotificationKind): void {
  switch (k) {
    case 'episode-aired':
    case 'movie-available':
    case 'show-came-to-platform':
    case 'movie-leaving-platform':
    case 'show-leaving-platform':
      return;
    default: {
      const _never: never = k;
      return _never;
    }
  }
}
```

The `_kindEq` / `_kindsLiteral` assertions are derived from the array and need no
edit. The `_notificationDoc` literal already uses `'show-came-to-platform'` (a
still-valid kind) — **no change required** to that literal.

`libs/shared/domain/src/lib/documents.ts` — extend `NotificationPrefs`:

```ts
export interface NotificationPrefs {
  episodeAired: boolean;
  movieAvailable: boolean;
  cameToPlatform: boolean;
  /** Alert when a tracked MOVIE loses all flatrate providers in the user's
   *  region (spec 0057). Default true; legacy docs missing it → true. */
  movieLeavingPlatform: boolean;
  /** Alert when a tracked TV SHOW loses all flatrate providers (spec 0057).
   *  Default true; legacy docs missing it → true. */
  showLeavingPlatform: boolean;
  deliveryHour: number | null;
}
```

**Required companion edit:** the `_user` literal in `type-assertions.ts`
(lines ~102–113) sets `notificationPrefs` without the two new booleans; because
they are **required**, that literal fails `typecheck` unless
`movieLeavingPlatform: true, showLeavingPlatform: true` are added to it.

### firestore-schema change (converter coalesce)

`dataToUser` (`libs/shared/firestore-schema/src/lib/converters.ts`) builds
`notificationPrefs` field-by-field. Add the two coalesced fields:

```ts
notificationPrefs: {
  episodeAired: data.notificationPrefs.episodeAired,
  movieAvailable: data.notificationPrefs.movieAvailable,
  cameToPlatform: data.notificationPrefs.cameToPlatform,
  movieLeavingPlatform: data.notificationPrefs.movieLeavingPlatform ?? true,
  showLeavingPlatform: data.notificationPrefs.showLeavingPlatform ?? true,
  deliveryHour: data.notificationPrefs.deliveryHour ?? null,
},
```

`userToData` passes `notificationPrefs` through wholesale (`notificationPrefs:
user.notificationPrefs`) — **no edit needed** there. No `data-types.ts` change
(`NotificationPrefs` types the read/write prefs directly and is already imported).

### Dispatcher change (`libs/functions/dispatch-notifications`)

`transitions.ts` `decideKinds` — replace the `'removed' → []` behaviour by
mapping the removed transition to the type-specific kind (place beside the
existing `'appeared'` branch):

```ts
if (input.transition === 'appeared') {
  kinds.push(input.type === 'movie' ? 'movie-available' : 'show-came-to-platform');
}
if (input.transition === 'removed') {
  kinds.push(input.type === 'movie' ? 'movie-leaving-platform' : 'show-leaving-platform');
}
```

The `episode-aired` branch is unchanged and does **not** fire on removal
(`hasFlatrateNow` is false after a `'removed'` transition, by definition).
`hasFlatrate` and `isWithinDeliveryWindow` are unchanged.

`dispatcher.ts` `isKindEnabled` — add the two cases with the legacy-tolerant
`!== false` semantics (Data model):

```ts
function isKindEnabled(kind: NotificationKind, prefs: NotificationPrefs): boolean {
  switch (kind) {
    case 'movie-available':
      return prefs.movieAvailable;
    case 'show-came-to-platform':
      return prefs.cameToPlatform;
    case 'episode-aired':
      return prefs.episodeAired;
    // Legacy docs (pre-0057) lack these; treat a missing value as enabled —
    // only an explicit false opts out (spec 0057 decision 4 / Data model).
    case 'movie-leaving-platform':
      return prefs.movieLeavingPlatform !== false;
    case 'show-leaving-platform':
      return prefs.showLeavingPlatform !== false;
    default:
      return false;
  }
}
```

The rest of `dispatch`/`dispatchForUser` is **unchanged**: the removed kinds flow
through the same doc write, the same `data` record (`{ notificationId, titleId,
kind, region, tmdbId }` with `notificationId = ${tmdbId}-${region}-${kind}`), the
same delivery-window gate, and the same stale-token prune. The
`DispatchSummary.transition` will now be `'removed'` for these dispatches with
`notificationsWritten > 0` (previously it was `'removed'` with `0`).

### apps/functions change

- **Adapter (`dispatch/adapters.ts` `createFirestoreWatchlistStore`).** It reads
  `userData.notificationPrefs` and passes it into `TrackingUser`. Since the core's
  `isKindEnabled` uses `!== false`, a legacy doc's missing new prefs already read
  as enabled — **no adapter backfill is strictly required**. **Verify** the
  adapter passes the prefs through unchanged (it does today: `notificationPrefs:
  userData.notificationPrefs`); if a future refactor constructs prefs
  field-by-field there, it must carry the two new fields defaulting missing →
  `true`. Document the chosen approach (pass-through + core `!== false`).
- **FCM OS-copy (`dispatch/adapters.ts` `buildNotification`).** Today it returns
  `episode-aired` copy or, for **everything else**, the availability copy ("Now
  available to stream" / "… is available on …"). A `'movie-leaving-platform'` /
  `'show-leaving-platform'` push would therefore render the **wrong** ("available")
  wording. Add a leaving branch so the OS notification is intelligible:

  ```ts
  function buildNotification(kind: string, titleStr: string): { title: string; body: string } {
    if (kind === 'episode-aired') {
      return { title: 'New episode available', body: `${titleStr} has a new episode on ${PLATFORM_FALLBACK}` };
    }
    if (kind === 'movie-leaving-platform' || kind === 'show-leaving-platform') {
      return { title: 'Leaving your streaming service', body: `${titleStr} is leaving ${PLATFORM_FALLBACK} — watch it soon` };
    }
    // movie-available + show-came-to-platform: availability copy.
    return { title: 'Now available to stream', body: `${titleStr} is available on ${PLATFORM_FALLBACK}` };
  }
  ```

  (`PLATFORM_FALLBACK = 'a streaming platform'` is the existing generic phrase —
  the FCM `data` record does not carry `providerName`, unchanged from 0041. Exact
  strings are a recommendation; keep them terse, "leaving"-toned, and distinct
  from the availability copy.)

### Notifications inbox change (`libs/mobile/notifications/src/lib/notifications.page.ts`)

Add branches to the two existing `switch (kind)` methods:

- `kindIcon`: `'movie-leaving-platform'` and `'show-leaving-platform'` → a
  leaving/exit glyph. Reuse an already-registered icon or register one via
  `addIcons`. Recommended: `'exit-outline'` (register `exitOutline` from
  `ionicons/icons` in the page constructor's `addIcons({...})` block); or reuse
  the type's existing glyph (`film-outline` for movie, `tv-outline` for show) if a
  distinct exit glyph is not wanted — **pick one and keep movie vs show visually
  distinguishable**. Register any new icon (the empty-state pattern shows icons
  must be registered on the page, not assumed global).
- `body`: `'movie-leaving-platform'` / `'show-leaving-platform'` →
  `` `Leaving your platform${on}` `` (where `on = row.payload.providerName ? \`
  on ${providerName}\` : ''`, matching the existing composition). Keep terse and
  consistent with the existing "Now available" / "Now streaming" tone.

No template, service, or route change in the notifications slice — the new kinds
are just two more `switch` cases; the row layout, unread styling, and deep-link
are kind-agnostic.

### Settings slice surface (`libs/mobile/settings`)

`SettingsService` gains two per-kind signals + setters, mirroring the existing
per-field pattern. **Binding** behaviour (names are a recommendation):

```ts
/** Current persisted per-kind opt-ins (spec 0057); default true. */
readonly movieLeavingPlatform: Signal<boolean>;
readonly showLeavingPlatform: Signal<boolean>;

/** Persist one leaving-platform pref, preserving all other prefs fields. */
setMovieLeavingPlatform(enabled: boolean): Promise<void>;
setShowLeavingPlatform(enabled: boolean): Promise<void>;
```

- **`load()`** reads `user.notificationPrefs.movieLeavingPlatform` /
  `showLeavingPlatform` (already coalesced to `true` by `dataToUser`) into the new
  signals, and adds both to the `_prefs` state signal and the eager-create
  defaults.
- **Each setter** rewrites the whole `notificationPrefs` object from `_prefs`
  state with the one field changed (exactly like `setDeliveryHour` reads
  `this._prefs()` and rebuilds), so the three original booleans, `deliveryHour`,
  and the other new boolean are all preserved. Null-uid guarded.
- **The global Notifications toggle is NOT changed.** `projectNotifications`
  (all-three-ANDed) and `setNotificationsEnabled` (writes the three original
  booleans + preserves `deliveryHour`) stay exactly as they are — the two new
  prefs are **independent per-kind rows**, not folded into the global projection.
  `setNotificationsEnabled` must, however, still **preserve** the two new fields
  when it rewrites `notificationPrefs` (it rebuilds from `_prefs`, so include them
  in the rebuilt object). This keeps the existing global-toggle tests green and
  avoids a semantics change (Out of scope). **Verify** `setNotificationsEnabled`
  and `setDeliveryHour` both preserve the two new booleans (extend their state
  rebuild to include them).
- **Mock providers (`settings.providers.mock.ts` `MockSettingsServiceImpl`)** must
  mirror the new surface: two signals (seeded `true`) + two setters. Update the
  service doc comment listing the mirrored surface.

`SettingsPage` (`settings.page.ts`) gains two change handlers
(`onMovieLeavingPlatformChange` / `onShowLeavingPlatformChange`) and, if a new
icon is used, registers it via `addIcons`.

### Config / secrets

No secret is read or written. The dispatcher uses ambient Admin credentials
(unchanged); the settings slice uses the shell's AngularFire. No `.env.local`
access.

## UI / Stitch screen refs

This spec touches two mobile slices, both **additive to existing, already-styled
screens** — it introduces **no new screen and no new visual element type**, so no
new Stitch screen is fetched. Per CLAUDE.md this is the correct, intentional
outcome, not a skipped capture: the new rows/variants reuse silhouettes already
pinned by merged specs.

**Authoritative tokens** live in `docs/design/vultus-design-system.md`, consumed
via the wired `--vultus-*` / `--ion-*` vars in
`libs/shared/ui-kit/src/lib/theme.scss`. **Never hand-transcribe a hex** — primary
is `#4edea3` (`--ion-color-primary` / `--vultus-primary`), **not** `#10B981`
(`primary-container`).

### Settings — two new toggle rows (Stitch "Settings - Vultus", screen id `81945ff3381e453dafcc4e5ce896fcfa`)

The Settings screen (pinned by specs 0018/0051, same screen id) uses the
`.settings-card` / `.settings-row` / `.settings-row__icon` / `.settings-row__body`
/ `.settings-row__toggle` / `.settings-row__helper` classes. The existing
**Notifications** row (`settings.page.html` lines ~68–87) is an `ion-toggle` in a
`.settings-card` and is the **exact sibling silhouette** each new row reuses — the
implementer derives the new rows from that row in-repo, not from a re-fetch. The
implementer **SHOULD still re-fetch the screen** (recipe below) to confirm
placement and record the screen id in the PR; a failed MCP call is a **retry**,
not a fallback (project memory `stitch-mcp-reachable.md`).

Fetch recipe: `list_screens` in `projects/13590348714018893783` → confirm the
Settings screen id `81945ff3381e453dafcc4e5ce896fcfa` → `get_screen` (metadata +
URLs) → fetch `htmlCode.downloadUrl` via a plain `Invoke-WebRequest` (NOT
WebFetch) for the markup, `screenshot.downloadUrl` for the visual compare. If the
screen genuinely can't be read after retries, record it `needs-human` — do not
ship token-only.

**Checkable contract (each row a `.settings-card` matching the Notifications
card):**

| Element             | Spec                                                                                                                                        | Token / var                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Card**            | `.settings-card` — fill `surface-container`, `--vultus-radius-md` (0.75rem), 1px `outline-variant` hairline (20% alpha), 16px padding, 8px gap from the sibling card above. Side inset + inter-card gap **must agree** with the Region / Notifications / Notification-time cards (same stack). | `--vultus-surface-container`, `--vultus-outline-variant`, `--vultus-space-md`, `--vultus-space-sm` |
| **Icon tile**       | `.settings-row__icon` — 40×40px, `--vultus-radius` (0.5rem), surface-ramp tile, **primary-coloured glyph** (`--ion-color-primary`), 22px icon. Suggested glyphs: `film-outline` (movie row), `tv-outline` (show row) — register via the page's `addIcons`. | `--ion-color-primary`                              |
| **Control**         | `ion-toggle` styled by `.settings-row__toggle` exactly like the Notifications toggle: `justify="space-between"`, `[checked]="service.movieLeavingPlatform()"` (resp. `showLeavingPlatform()`), `(ionChange)="…"`. Label text: "Movie leaving your platform" / "Show leaving your platform" (or terser "When a movie/show is leaving" — keep body-lg role). | `--ion-color-primary` (toggle track when on)       |
| **Type roles**      | Toggle label = `body-lg`/600 (the `.settings-row__toggle` label rule); helper = `body-md` (14/400) `on-surface-variant`. Pin via existing classes — introduce **no** new font sizes. | `--vultus-on-surface`, `--vultus-on-surface-variant` |
| **Helper text**     | `.settings-row__helper` `<p>` e.g. "Get notified when a tracked movie/show is about to leave your streaming service." — 8px below the control, aligned to the control's left edge (same as siblings). | `--vultus-on-surface-variant`                      |

**Placement:** the two rows go in the `.settings-cards` stack **after** the
Notifications card and **before** (or after — implementer's call, keep grouped
with the other notification rows) the Notification-time card. Keep all four
notification-related cards visually grouped; do not split the stack.

**Interactive-state contract (tick each vs the fetched screen + screenshot):**

| Element             | default                                          | focus                       | active                                      | result                                    |
| ------------------- | ------------------------------------------------ | --------------------------- | ------------------------------------------- | ----------------------------------------- |
| **Each new toggle** | `ion-toggle`, checked reflects the pref (default on); track uses `--ion-color-primary` when on | Ionic `:focus-visible` ring | card `:active` 5% emerald overlay (existing `.settings-card:active`), **not** a lift | `setMovieLeavingPlatform(checked)` / `setShowLeavingPlatform(checked)` |

- **Sibling alignment:** all notification cards share the same 16px side inset,
  8px inter-card gap, 40×40 icon tile, and helper left-edge (no row drifts).
- **Font loading:** Inter is loaded app-wide (spec 0010); confirm the new rows
  render in Inter (the screenshot compare catches a fallback).
- **No new animation** beyond the existing `.settings-card` `background-color`
  transition.

### Notifications inbox — two new row variants (Stitch "Notifications - Vultus", screen id `505a6e4713c04b27a37a8c20a44aeccf`)

The inbox screen (pinned by spec 0042) renders each notification as a card with a
poster/kind-icon thumb, title, body line, timestamp, and unread dot/tint. The two
new kinds reuse that **exact** row silhouette — the only per-kind differences are
the `kindIcon` fallback glyph and the `body` copy (Public types / APIs), both
kind-agnostic in layout. No layout, spacing, or state change. The implementer
SHOULD confirm the screen id in the PR (spec 0042 pinned the full row contract);
no new visual element is introduced, so the 0042 contract stands unchanged for the
new variants.

**Visual verification (CLAUDE.md):** serve `pnpm nx run mobile:serve-mock`,
seeding the settings mock with the two new toggles and the notifications mock with
a `movie-leaving-platform` + a `show-leaving-platform` row, and screenshot both
screens against the Stitch screenshots. A green build does NOT prove fidelity — if
the mock serve can't run under tooling, **explicitly flag the UI unverified for a
human** in the PR.

## Implementation task graph

T1 (shared domain enum + prefs) is the foundation both the schema converter and
every consumer compile against, so it runs **first and alone**. T2 (schema
converter) depends on T1's types and is a shared-root edit, so it also runs
sequentially after T1. T3 (dispatcher core), T4 (apps/functions), T5
(notifications inbox), and T6 (settings) then run against the settled shared
surface; their manifests are pairwise disjoint so the parallel-eligible ones fan
out. T4 imports the dispatcher lib barrel but only touches `apps/functions/**`
files (disjoint from T3's `libs/**` files), so T3 and T4 may run concurrently
provided T3's barrel surface is unchanged (it is — no new export). To be safe,
sequence T4 after T3.

**T1 — Shared domain: two kinds + two prefs [sequential]** (backend-engineer / domain)

- Add `'movie-leaving-platform'`, `'show-leaving-platform'` to
  `NOTIFICATION_KINDS` (`enums.ts`).
- Add the two cases to `assertKindExhaustive` (`type-assertions.ts`).
- Add `movieLeavingPlatform: boolean`, `showLeavingPlatform: boolean` to
  `NotificationPrefs` (`documents.ts`).
- Add `movieLeavingPlatform: true, showLeavingPlatform: true` to the `_user`
  literal (`type-assertions.ts`) — else `shared-domain` typecheck fails.
- Update `libs/shared/domain/README.md` where it enumerates `NotificationKind` /
  `NotificationPrefs` fields.
- Files: `libs/shared/domain/src/lib/enums.ts`,
  `libs/shared/domain/src/lib/type-assertions.ts`,
  `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/README.md`.

**T2 — firestore-schema: converter coalesce + tests [sequential, after T1]** (backend-engineer)

- Add `movieLeavingPlatform: data.notificationPrefs.movieLeavingPlatform ?? true`
  and `showLeavingPlatform: … ?? true` to `dataToUser` (`converters.ts`).
  `userToData` unchanged (wholesale pass-through). No `data-types.ts` change.
- Extend the user round-trip tests in `firestore-schema.spec.ts`: both booleans
  round-trip (true and false), and a **legacy doc missing them → `true`** case
  (mirror the existing `deliveryHour` missing-field test at lines ~126–145).
- Update `libs/shared/firestore-schema/README.md` only if it enumerates prefs
  fields.
- Files: `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md` (only if it lists prefs).

**T3 — Dispatcher decision change + tests [parallel, after T2]** (backend-engineer)

- `transitions.ts` `decideKinds`: add the `'removed'` → type-specific-kind branch
  (replaces `'removed' → []`).
- `dispatcher.ts` `isKindEnabled`: add the two cases with `!== false` semantics.
- Extend `transitions.spec.ts` (decideKinds `'removed'` cases) + `dispatcher.spec.ts`
  (removed-transition dispatch, prefs gate for the new kinds, legacy-missing-pref →
  enabled) per the Test plan.
- **Rewrite the pre-existing `'removed'` test that this change flips.**
  `dispatcher.spec.ts` (around line 230) has a test named
  `'removed transition: no availability notification written'` that today asserts
  `stores.written` **and** `stores.sent` are both length 0 on a `'removed'`
  transition and `summary.transition === 'removed'`. That assertion is a direct
  consequence of the old `'removed' → []` behaviour and **WILL fail** once
  `decideKinds`/`isKindEnabled` map `'removed'` to the new kinds — this is a
  **required behavioral flip**, not an incidental red. Rewrite it (keeping its
  intent as the canonical `'removed'` coverage) so the new expected assertions are:
  - **Movie `'removed'` transition:** exactly **one** `movie-leaving-platform`
    `NotificationDoc` is written and **one** FCM send occurs;
    `summary.transition === 'removed'` with `notificationsWritten === 1`.
  - **Tv `'removed'` transition:** exactly **one** `show-leaving-platform`
    `NotificationDoc` is written and **one** FCM send occurs;
    `summary.transition === 'removed'` with `notificationsWritten === 1`.

  Adjust the exact assertion shape to the file's existing structure (it uses
  `stores.written` / `stores.sent` arrays and the returned `summary`); the point is
  that the two length-0 assertions must become length-1 with the correct `kind`,
  and the implementer must treat this as an intentional flip, not a surprise.
- Update `libs/functions/dispatch-notifications/README.md` (the removed transition
  now notifies; the two new kinds; the `!== false` legacy semantics).
- Files: `libs/functions/dispatch-notifications/src/lib/transitions.ts`,
  `libs/functions/dispatch-notifications/src/lib/transitions.spec.ts`,
  `libs/functions/dispatch-notifications/src/lib/dispatcher.ts`,
  `libs/functions/dispatch-notifications/src/lib/dispatcher.spec.ts`,
  `libs/functions/dispatch-notifications/README.md`.

**T4 — apps/functions: adapter verify + FCM leaving-copy + tests [sequential, after T3]** (backend-engineer)

- Verify `createFirestoreWatchlistStore` passes `notificationPrefs` through
  unchanged (it does); document the pass-through + core `!== false` reliance.
- Add the leaving-platform branch to `buildNotification` (`dispatch/adapters.ts`).
- Extend `dispatch-notifications.spec.ts` (and/or an adapter spec): `buildNotification`
  returns leaving copy for the two new kinds and availability copy for the two
  availability kinds; a `'removed'` dispatch writes a notification doc with the new
  kind and sends FCM. Existing 0012/0041/0051 wiring tests stay green.
- Update `apps/functions/README.md` only if it enumerates the FCM copy / kinds.
- Files: `apps/functions/src/dispatch/adapters.ts`,
  `apps/functions/src/dispatch-notifications.spec.ts`,
  `apps/functions/README.md` (only if it documents the trigger copy).

**T5 — Notifications inbox: kindIcon + body branches + tests [parallel, after T1]** (frontend-engineer)

- `notifications.page.ts`: add the two kinds to `kindIcon` and `body`; register a
  new icon in `addIcons` if used.
- `notifications.providers.mock.ts`: add **two seed rows** — one
  `movie-leaving-platform` and one `show-leaving-platform` — so `mobile:serve-mock`
  visually exercises the new variants (the UI-verification step above depends on
  these rows). Update the mock's doc comment: it currently claims the fixture
  "exercises … all three notification kinds — so a visual check covers the full §6
  contract"; change "three" to **five** kinds to reflect the two new members.
- Extend `notifications.page.spec.ts`: a `'movie-leaving-platform'` and a
  `'show-leaving-platform'` row render the expected icon fallback + body copy.
- Update `libs/mobile/notifications/README.md` only if it enumerates the rendered
  kinds.
- Files: `libs/mobile/notifications/src/lib/notifications.page.ts`,
  `libs/mobile/notifications/src/lib/notifications.page.spec.ts`,
  `libs/mobile/notifications/src/lib/notifications.providers.mock.ts`,
  `libs/mobile/notifications/README.md` (only if it lists kinds).

**T6 — Settings: two toggle rows + service + mock + tests [parallel, after T1]** (frontend-engineer)

- `settings.service.ts`: add the two signals + the two setters (rewrite whole
  `notificationPrefs` from state); read both in `load()`; ensure
  `setNotificationsEnabled` + `setDeliveryHour` preserve the two new fields in their
  state rebuild. **Add `movieLeavingPlatform: true, showLeavingPlatform: true` to
  BOTH default `notificationPrefs` object literals** — there are two: (1) the
  `_prefs` signal's initial value (around lines 53–58) and (2) the `load()`
  method's eager-create branch (around lines 113–118). The `_prefs` initializer
  will fail typecheck once `NotificationPrefs` gains the two required fields (T1),
  so missing it is a compile-time trap; the eager-create literal is what persists
  the defaults for a brand-new user doc. Both must be updated.
- `settings.providers.mock.ts`: mirror the two signals (seeded `true`) + setters;
  update the doc comment.
- `settings.page.ts`: add the two change handlers. For the row icons, `filmOutline`
  is **already** imported and registered in the page's `addIcons({...})` block, but
  `tvOutline` is **NOT** — it must be **newly added** to both the `ionicons/icons`
  import and the `addIcons` call (or pick a single distinct glyph for both rows and
  register it). Do not assume `tvOutline` is already available.
- `settings.page.html`: add the two `.settings-card` toggle rows per the UI
  contract, grouped with the other notification cards.
- `settings.page.scss`: reuse existing classes; add styling only if strictly
  needed (no hard-coded hex).
- Update `libs/mobile/settings/README.md` (the two new controls + preserve-prefs
  write rule).
- Extend `settings.service.spec.ts` (setters preserve other prefs, load reads the
  fields, eager-create defaults include them, null-uid guard) + `settings.page.spec.ts`
  (both toggles render, `ionChange` calls the setter).
- Files: `libs/mobile/settings/src/lib/settings.service.ts`,
  `libs/mobile/settings/src/lib/settings.service.spec.ts`,
  `libs/mobile/settings/src/lib/settings.providers.mock.ts`,
  `libs/mobile/settings/src/lib/settings.page.ts`,
  `libs/mobile/settings/src/lib/settings.page.html`,
  `libs/mobile/settings/src/lib/settings.page.scss`,
  `libs/mobile/settings/src/lib/settings.page.spec.ts`,
  `libs/mobile/settings/README.md`.

**Disjointness:** T3 writes only `libs/functions/dispatch-notifications/**`; T4
only `apps/functions/**`; T5 only `libs/mobile/notifications/**`; T6 only
`libs/mobile/settings/**`. T1 (`libs/shared/domain/**`) and T2
(`libs/shared/firestore-schema/**`) are shared-root edits that run first and
sequentially. The parallel-eligible manifests (T3, T5, T6 after T1/T2; T4 after
T3) are pairwise disjoint.

## Test plan

Per the PLAN §5 pyramid — unit (domain/converter, dispatcher core + wiring),
component (settings page, notifications page), and the e2e rubric outcome below.
All Firebase access in unit/component tests is mocked; no emulator (project
memory: the emulator cannot run under Claude Code tools here).

**Unit (shared/domain + firestore-schema):**

- `NOTIFICATION_KINDS` includes the two new members; `assertKindExhaustive`
  compiles (a compile-time gate — the `_user` literal + the switch prove it).
- **Converter round-trip (`firestore-schema.spec.ts`):** a `User` whose
  `notificationPrefs.movieLeavingPlatform`/`showLeavingPlatform` are `true`
  round-trips unchanged; with `false` round-trips as `false`; a **legacy stored
  doc whose `notificationPrefs` omits both fields** maps them to `true` via
  `dataToUser` (mirror the existing `deliveryHour` missing-field test).

**Unit (dispatch-notifications):**

- `decideKinds` (`transitions.spec.ts`): `'removed'` + `movie` →
  `['movie-leaving-platform']`; `'removed'` + `tv` → `['show-leaving-platform']`;
  `'removed'` does **not** add `episode-aired` (even with an aired episode in the
  list — `hasFlatrateNow` is false on removal); the existing `'appeared'` /
  `'unchanged'` cases stay green.
- `dispatcher.spec.ts` (fake stores + fixed `now`):
  - **Movie removed, single in-region user, pref on/default:** one
    `movie-leaving-platform` `NotificationDoc` written (assert `kind`, `payload`,
    `notificationsWritten`); FCM `send` per token with `data.kind =
    'movie-leaving-platform'` and `notificationId = ${tmdbId}-${region}-movie-leaving-platform`;
    `DispatchSummary.transition === 'removed'`.
  - **Show removed → `show-leaving-platform`** analogously.
  - **Per-kind prefs gate:** a user with `movieLeavingPlatform === false` gets the
    kind **dropped** (no doc, no send); with `true` gets it.
  - **Legacy pref (missing / `undefined`) → enabled:** a `TrackingUser` whose
    `notificationPrefs` omits the new fields still dispatches the leaving kind (the
    `!== false` core check).
  - **Delivery-window still gates the send** (spec 0051): outside the window →
    doc written, FCM skipped, for a removed kind too.
  - The existing 0012/0051 tests (appeared, episode-aired, region filter,
    stale-token prune, per-user error isolation, no-write-outside-`users/**`,
    delivery-window) **stay green** — only the `'removed' → []` expectation flips.
    Specifically, the pre-existing `'removed transition: no availability
    notification written'` test (dispatcher.spec.ts ~line 230) **must be
    rewritten**: its `stores.written`/`stores.sent` length-0 assertions become
    length-1 with the type-specific new kind (see T3). This is a required
    behavioral flip, not an optional cleanup.

**Unit (apps/functions — `dispatch-notifications.spec.ts` / adapter spec, fake `db`/`messaging`):**

- `buildNotification` returns the **leaving** copy for `'movie-leaving-platform'`
  and `'show-leaving-platform'`, and the **availability** copy for
  `'movie-available'` / `'show-came-to-platform'`, and the **episode** copy for
  `'episode-aired'`.
- A `'removed'` availability change (previousSnapshot has flatrate, providers has
  none) writes a notification doc with the new kind and calls `messaging.send`
  with `data.kind` = the new kind + the leaving `notification` block.
- Existing 0012/0041/0051 wiring/adapter tests stay green.

**Component (settings — `settings.page.spec.ts`, mocked `SettingsService`):**

- Both new toggle rows render once loaded, reflecting `service.movieLeavingPlatform()`
  / `showLeavingPlatform()`.
- `ionChange` on each toggle calls the matching setter with the checked value.
- The existing settings assertions (region, notifications toggle, delivery-hour,
  render-gate, error state) stay green.

**Unit (settings — `settings.service.spec.ts`):**

- `setMovieLeavingPlatform(false)` / `setShowLeavingPlatform(false)` write the
  whole `notificationPrefs` with the target field changed and **all other fields
  (the three booleans, `deliveryHour`, and the other new boolean) preserved**.
- `setNotificationsEnabled` and `setDeliveryHour` **preserve** the two new
  booleans in their rewritten `notificationPrefs`.
- `load()` reads both new fields into their signals; eager-create writes both as
  `true`; a legacy doc missing them loads as `true` (via `dataToUser`).
- null-uid guard: no Firestore write on either setter.

**Component (notifications — `notifications.page.spec.ts`, mocked service):**

- A `'movie-leaving-platform'` row renders the expected icon fallback + body copy;
  a `'show-leaving-platform'` row likewise. Existing kind rows stay green.

**e2e (rubric):** **Not required.** Per the e2e decision rubric: this is a
`scope:functions`/`scope:shared` decision-logic change plus two additive Settings
toggle rows and two additive inbox row variants on **existing** pages — **no new
route, no new primary navigation or critical action**. The settings persist-on-
change behaviour and the inbox rendering are covered by component + unit tests
against mocked Firestore (consistent with specs 0051/0042 and project memory: the
emulator cannot run under Claude Code tools here). **No new e2e flow is required —
additive kind/prefs change only.** No `apps/mobile-e2e`, `playwright.config.ts`,
or `ci.yml` change. (If the merged notifications-inbox or settings e2e enumerates
`NotificationKind` explicitly and would break on the two new members, update that
enumeration in place — but no new spec file is added; verify during
implementation.)

## Definition of done

Tailored from the PLAN §5 checklist to the projects touched. Affected projects:
`shared-domain`, `shared-firestore-schema`, `functions-dispatch-notifications`,
`functions`, `mobile-notifications`, `mobile-settings` (+ `mobile` shell as a
dependent build).

- [ ] `pnpm nx typecheck shared-domain shared-firestore-schema
      functions-dispatch-notifications functions mobile-notifications
      mobile-settings` passes — the two kinds, the exhaustive switch, the two
      prefs, the converter, the dispatcher branches, the inbox branches, and the
      settings toggles compile.
- [ ] `pnpm nx lint <same projects>` passes **with Sheriff active**: the
      dispatcher core stays Firebase-free and imports no other slice; settings +
      notifications import only `@vultus/shared/*` + framework/third-party (no
      other slice, no `scope:functions`); no `scope:mobile` ↔ `scope:functions`
      edge.
- [ ] `pnpm nx test shared-firestore-schema` passes — the user round-trip covers
      both new prefs (true, false, and missing → true).
- [ ] `pnpm nx test functions-dispatch-notifications` passes — `decideKinds`
      `'removed'` → new kind, `isKindEnabled` legacy `!== false`, dispatcher
      removed-transition + prefs-gate + delivery-window tests; the 0012/0051 tests
      stay green.
- [ ] `pnpm nx test functions` passes — `buildNotification` leaving-copy + the
      `'removed'` dispatch wiring test; the 0012/0041/0051 tests stay green.
- [ ] `pnpm nx test mobile-notifications` passes — the two new inbox row variants.
- [ ] `pnpm nx test mobile-settings` passes — the two new toggle rows + the
      preserve-other-prefs service tests; the existing settings tests stay green.
- [ ] `pnpm nx build mobile` and `pnpm nx build functions` pass (run
      `pnpm nx run functions:deploy-preflight` if `apps/functions` deps/build
      changed — they should not; the change is source-only).
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green (the
      affected set is the six projects above + `mobile` + dependents).
- [ ] **Stitch Settings screen re-fetched:** the PR records the screen id
      `81945ff3381e453dafcc4e5ce896fcfa` (or notes the MCP unreachable after
      retries → `needs-human`, not silently token-only). The inbox screen id
      `505a6e4713c04b27a37a8c20a44aeccf` is recorded (0042 contract unchanged).
- [ ] **UI fidelity verified** (`mobile:serve-mock` / screenshot: the two new
      Settings toggle rows aligned with the sibling cards, and a leaving-platform
      inbox row) **or explicitly flagged unverified for a human** — a green build
      does not prove fidelity (CLAUDE.md).
- [ ] No hard-coded hex in any new template/SCSS — only `--vultus-*` / `--ion-*`
      vars; the new rows reuse the existing `.settings-card` classes.
- [ ] READMEs updated: `libs/shared/domain/README.md` (the two kinds + two prefs),
      `libs/functions/dispatch-notifications/README.md` (removed now notifies + the
      two kinds + `!== false` legacy semantics), `libs/mobile/settings/README.md`
      (the two controls + preserve-prefs write); `shared/firestore-schema`,
      `mobile/notifications`, and `apps/functions` READMEs only if they enumerate
      the changed surface.
- [ ] **Boundary verifications (review-checked):** (a) the classifier
      (`classifyFlatrateTransition`) and the sync engine are **unchanged** — only
      `decideKinds` consumption changes; (b) legacy docs missing the new prefs
      behave as **enabled** (converter `?? true` + core `!== false`), covered by
      tests; (c) the **global Notifications toggle semantics are unchanged** — the
      two new prefs are independent rows, and `setNotificationsEnabled` /
      `setDeliveryHour` preserve them; (d) the FCM leaving push renders **leaving**
      copy, not availability copy; (e) **no `firestore.rules`/`firestore.indexes.json`
      change**; (f) **no secret** read/written.
- [ ] PR description records: the verification commands, the screen ids + visual-
      verification result, the boundary confirmations above, and that **e2e is not
      required** (additive kind/prefs change on existing pages).

## Risks

- **Flipping decision 1C is a v1 product reversal, deliberately made.** Spec 0012
  cut removal notifications as "too noisy for v1"; this spec reinstates them
  behind a per-kind opt-in (default on). The noise risk is real — a title that
  churns providers could re-notify on each `'removed'`↔`'appeared'` flap. This is
  bounded by best-effort idempotency (the deterministic doc id
  `${tmdbId}-${region}-${kind}` from spec 0041 means a re-fired removal **merges**
  onto the same doc rather than duplicating the inbox row; the push still fires per
  send). The per-kind toggle is the user's mitigation. Flagged so a reviewer knows
  the reversal is intentional, not a regression of 0012 decision 1C.
- **Default `true` for the new prefs (opt-out) is a choice.** Legacy users get the
  new alerts without touching Settings (converter `?? true` + core `!== false`).
  The alternative — default `false`/opt-in — was rejected as inconsistent with the
  other three kinds (all default `true`) and because the feature's value is that
  the user is *warned* by default. A user who does not want it toggles it off. The
  `!== false` core semantics (not a strict boolean read) is the load-bearing detail
  that makes legacy docs (missing the field) behave as on — a reviewer must confirm
  the core does not use a strict `=== true` that would silently disable legacy
  users.
- **`buildNotification`'s "everything else = availability copy" fallthrough is a
  trap.** Today the two new kinds would hit the availability branch and render
  "Now available to stream" for a *leaving* push — a visible correctness bug, not a
  typecheck failure (the function takes a `string` kind). The explicit leaving
  branch (T4) fixes it; the test asserting per-kind copy is the guard. Flagged
  because it is easy to miss (the compiler won't catch it).
- **The global-toggle projection must keep preserving the new fields.**
  `setNotificationsEnabled` rewrites the whole `notificationPrefs` from `_prefs`
  state; if the implementer forgets to include the two new booleans in the rebuilt
  object, toggling the global switch would silently reset them. Mitigated by
  rebuilding from `_prefs` (which now carries all six fields) and by the
  "preserve other prefs" service tests. This is the most likely implementation
  slip (mirrors the spec-0051 two-setter clobber risk).
- **`episode-aired` is unaffected but easy to over-think.** A `'removed'`
  transition means `hasFlatrateNow` is false, so `decideKinds` cannot also emit
  `episode-aired` on removal — no interaction. Stated so the implementer does not
  add a guard that isn't needed.
- **Reactive-only, coarse signal (decision 7 + PLAN §9 data-source risk).** The
  alert fires only once removal is **observed** in a sync pass, and TMDB's watch-
  provider data has known accuracy gaps — a title wrongly reported as losing
  flatrate would produce a false "leaving" alert (and a wrongly-reported re-add
  would produce a false "available"). This is the same data-source risk 0012
  already carries; the new kind inherits it. There is no "leaving on <date>" lead
  time (TMDB/Trakt don't expose it). Accepted for v1.
- **No PLAN conflict.** This consumes the classifier's existing `'removed'` output
  (PLAN §6 item 14 / §4 `previousSnapshot` transition model) and extends
  `NotificationKind` + `NotificationPrefs` additively (PLAN §4 `notifications` /
  `users` docs). The two new kinds and the opt-out default are v1 product calls
  within PLAN §1's scope; the sync engine, classifier, inbox, deep-link, and cron
  are all untouched.
