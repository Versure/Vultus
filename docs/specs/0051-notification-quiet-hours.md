---
number: 0051
slug: notification-quiet-hours
title: Add a notification delivery-hour preference (UTC) gating FCM sends
status: approved
slices: [slice:settings, slice:dispatch-notifications]
scopes: [scope:shared, scope:mobile, scope:functions]
created: 2026-06-30
---

# Add a notification delivery-hour preference (UTC) gating FCM sends

## Context

Spec 0011 (`done`) gave the user a single global notifications toggle, and spec
0012 (`done`) built the dispatcher that, on a flatrate availability transition,
writes a `users/{uid}/notifications/{id}` doc and pushes a data-only FCM message
to each of the user's registered tokens. Spec 0042 (`done`) added the in-app
inbox that reads that `users/{uid}/notifications` collection.

Today the user has **no control over when** a push arrives — the daily sync cron
runs at a fixed UTC time and the dispatcher fires FCM immediately on any
transition it detects. A user who does not want a 3 a.m. buzz has no recourse.

This spec adds a **delivery-hour preference**: the user can pick a single UTC
hour during which push notifications are allowed to send (or "Any time" for the
current always-send behaviour). The dispatcher consults this before each FCM
send; if the current UTC hour does not match the user's chosen hour, it
**skips the FCM send for that user this run**. Notifications are **not queued**
— a skipped notification simply does not push; it will push on a future sync run
that happens to fall in the user's chosen hour (or never, if no run lands there).
Crucially, the **`users/{uid}/notifications/{id}` doc is still written** every
time regardless of the delivery window, so the in-app inbox (spec 0042) and the
unread badge always reflect the event — only the FCM push is gated.

Intended outcome: a user opens Settings, picks "08:00 UTC" as their notification
time, and from then on the dispatcher only pushes FCM to them during the 08:00
UTC hour; at every other hour the notification still lands in their inbox but no
push fires. A user who leaves it at "Any time" sees no behaviour change.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **UTC only — no timezone storage.** `deliveryHour` is a UTC hour (0–23) or
   `null`. There is **no** IANA timezone field, no local-time conversion, no DST
   handling. The check is exactly
   `deliveryHour === null || currentUTCHour === deliveryHour`.
2. **`deliveryHour: number | null` on `NotificationPrefs`.** `null` = no
   preference = send any time (the current behaviour, and the default for both
   new and pre-existing user docs that have no `deliveryHour` field). A number
   0–23 restricts FCM sends to that single UTC hour. Follows the existing spec
   0011 `NotificationPrefs` pattern.
3. **The skip is FCM-only and per-user.** When the window does not match, the
   dispatcher **still writes** the `users/{uid}/notifications/{id}` doc (inbox
   preserved, spec 0042) but **does not call `fcm.send`** for that user this run.
   Other users with a different (or `null`) `deliveryHour` are unaffected — the
   gate is evaluated independently per user.
4. **No queuing, no retry, no batching.** A notification skipped because it was
   outside the window is **not** stored-for-later or retried. It pushes only if a
   future sync run lands in the window. (Out of scope — see below.)
5. **Single hour, not a range.** v1 is one UTC hour, not a start/end quiet-hours
   range, and not per-notification-type windows. (Out of scope.)

## Scope

In scope:

- **`NotificationPrefs.deliveryHour: number | null`** added to
  `@vultus/shared/domain` (`scope:shared`), with the README updated.
- **Settings UI** (`libs/mobile/settings`, `scope:mobile`, `slice:settings`): a
  "Notification time" picker row below the existing notifications toggle, only
  enabled while global notifications are on, persisting `deliveryHour` to
  `users/{uid}.notificationPrefs` immediately on change (same persist-on-change
  pattern as the region picker, spec 0011/0018).
- **Dispatcher guard** (`libs/functions/dispatch-notifications`,
  `scope:functions`, `slice:dispatch-notifications`): after the prefs gate,
  before `fcm.send`, evaluate `deliveryHour` against the current UTC hour
  (derived from the injected `now` clock); skip the FCM send (only) when it does
  not match, logging a single debug line.
- Unit, component, and converter-round-trip tests per the Test plan.

Out of scope (explicitly):

- **Quiet-hours range** (start + end hours) — single hour only (decision 5).
- **Per-notification-type delivery windows** — one window for all kinds.
- **Timezone / IANA / local-time selection** — UTC only (decision 1).
- **Notification queuing, batching, or retry** of a missed window (decision 4).
  The notification doc is written; the FCM send is simply skipped, never deferred.
- **Changing the cron schedule** (spec 0017) — the cron's fixed UTC run time is
  unchanged; this spec only gates the per-user FCM send within whatever run fires.
- **Changing the global notifications toggle semantics** (the all-three-prefs
  projection from spec 0011) — `deliveryHour` is an **additional, independent**
  field, not folded into that projection.
- **`firestore.rules` / `firestore.indexes.json` changes** — owner-only
  `users/{uid}` read/write already covers the new field (spec 0011/0004); the
  dispatcher runs as the Admin SDK (bypasses rules). No rules/indexes edit.
- **e2e** — see the Test plan rubric outcome (none required).

## Affected slices & Sheriff tags

| Project                          | Path                                    | Sheriff tags                                      | Change                                                                                              |
| -------------------------------- | --------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| shared-domain (edit)             | `libs/shared/domain`                    | `scope:shared`                                    | **add** `deliveryHour: number \| null` to `NotificationPrefs` (additive); update README + assertion |
| mobile-settings (edit)           | `libs/mobile/settings`                  | `scope:mobile`, `slice:settings`                  | add the "Notification time" picker row + service signal/setter; mock-providers mirror; README       |
| functions-dispatch-notifications (edit) | `libs/functions/dispatch-notifications` | `scope:functions`, `slice:dispatch-notifications` | gate `fcm.send` on the per-user `deliveryHour` window (doc still written); update README + tests     |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (specs 0010/0012). All three
  projects already resolve their tags from their paths
  (`libs/shared/domain` → `scope:shared`; `libs/mobile/settings/src` →
  `scope:mobile` + `slice:settings`; `libs/functions/dispatch-notifications/src`
  → `scope:functions` + `slice:dispatch-notifications`). **This spec does NOT edit
  `sheriff.config.ts`.**
- **Import boundaries — verified, no new edges introduced:**
  - `libs/mobile/settings` (`slice:settings`) already imports
    `@vultus/shared/domain` (`Region`/`REGIONS`/`User`/`NotificationPrefs`),
    `@vultus/shared/domain/tokens` (`AUTH_UID`),
    `@vultus/shared/firestore-schema` (`userPath`/`userToData`/`dataToUser`), and
    AngularFire/Ionic (third-party). This spec adds **no new import** — it reads
    `NotificationPrefs.deliveryHour` (already-imported type) and writes it through
    the existing converter path. No other slice, no `scope:functions`.
  - `libs/functions/dispatch-notifications` (`slice:dispatch-notifications`)
    already imports `@vultus/shared/domain` (`NotificationPrefs` is already
    imported in `dispatcher.ts`). The guard needs **no new import** — it reads
    `user.notificationPrefs.deliveryHour` and the existing injected `now` clock.
    Stays Firebase-free; **no** Admin-SDK import enters the core.
- **No `shared/` extraction.** The UTC-hour check is a one-line slice-local
  predicate in the dispatcher; the picker logic is slice-local to settings. The
  only shared change is the additive `deliveryHour` **type** field — a persisted
  vocabulary addition (the spec-0003/0005 contract), not a logic extraction. The
  3+-slice rule (CLAUDE.md / PLAN §3) is respected.
- **No `scope:mobile` ↔ `scope:functions` edge.** The settings slice and the
  dispatcher communicate only through the persisted `users/{uid}` document and
  the shared `NotificationPrefs` type — never by importing each other.

## Data model touchpoints

PLAN §4 `users/{uid}.notificationPrefs` is the only document field added. The
field rides on the **existing** `User` / `NotificationPrefs` shape and its
existing `userToData` / `dataToUser` converters in
`@vultus/shared/firestore-schema`.

| PLAN §4 path                                   | Access                          | By                                                                          |
| ---------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `users/{uid}.notificationPrefs.deliveryHour`   | **read**, **create**, **update**| settings slice (read on load; default `null` on eager create; write on pick)|
| `users/{uid}.notificationPrefs.deliveryHour`   | **read**                        | dispatcher (per-user, via the `TrackingUser.notificationPrefs` it loads)    |
| `users/{uid}/notifications/{id}`               | **create** (unchanged)          | dispatcher — **always** written regardless of the delivery window           |

- **New field shape:** `deliveryHour: number | null`. `null` (or, for legacy docs
  that predate this spec, **absent**) means "any time / no preference". A number
  is a UTC hour `0–23`.
- **Legacy-doc tolerance (load-bearing).** Existing `users/{uid}` docs written by
  spec 0011 have **no** `deliveryHour` field. Both readers must treat a missing
  value as `null`:
  - **Settings (`dataToUser`):** the converter must map an absent persisted
    `deliveryHour` to `null` (a `?? null` coalesce in `dataToUser`), so the
    picker shows "Any time" for a legacy doc. **Verify whether the existing
    `dataToUser` already passes `notificationPrefs` through wholesale** (like the
    notification `payload` passthrough in spec 0012); if it constructs the prefs
    object field-by-field, add `deliveryHour: data.notificationPrefs.deliveryHour
    ?? null`. Pin the chosen approach with a converter round-trip test (see Test
    plan).
  - **Dispatcher:** the guard treats `deliveryHour == null` (covers both `null`
    and `undefined`) as "send any time". Because the dispatcher gets its prefs
    from the Admin-SDK `WatchlistStore` adapter, the **adapter** in `apps/functions`
    that builds `TrackingUser.notificationPrefs` must also default a missing
    `deliveryHour` to `null` (or the core's `== null` check must tolerate
    `undefined` — prefer the explicit `== null` check so the core is robust to
    either). **Choose and document** the explicit `== null` check in the core.
- **Default on eager create:** the settings `load()` create path (spec 0011)
  writes the defaults `{ region: 'NL', notificationPrefs: { episodeAired: true,
  movieAvailable: true, cameToPlatform: true, deliveryHour: null }, fcmTokens: []
  }`. Add `deliveryHour: null` to the create defaults so a freshly-created doc has
  the field explicitly.
- **Write on pick:** persist by updating `notificationPrefs` (the same
  whole-object update the toggle uses today) so all four prefs are written
  together; **do not** introduce a separate top-level field. The picker sets
  `notificationPrefs.deliveryHour` to the chosen number or `null`, leaving the
  three booleans at their current values. (See Public types for the exact write
  shape — it must preserve the current booleans, not reset them.)
- **No `firestore.rules` change.** Spec 0004/0011 grant the owner read/write on
  `users/{uid}`; the additive field is covered. The dispatcher runs as the Admin
  SDK and bypasses rules. **Do NOT edit `firestore.rules` or
  `firestore.indexes.json`** (no new query — the dispatcher already loads the
  whole user doc; no `where` on `deliveryHour`).

## Public types / APIs

No new HTTP/callable endpoint, no new shared barrel export — only an additive
field on an existing type plus slice-local UI surface.

### Shared domain change (additive)

`libs/shared/domain/src/lib/documents.ts` — extend `NotificationPrefs`:

```ts
export interface NotificationPrefs {
  episodeAired: boolean;
  movieAvailable: boolean;
  cameToPlatform: boolean;
  /** UTC hour (0–23) FCM pushes are allowed; null = any time (no preference).
   *  Absent on legacy docs (spec 0011) — readers coalesce missing → null. */
  deliveryHour: number | null;
}
```

- **Required companion edit:** the representative `_user` literal in
  `libs/shared/domain/src/lib/type-assertions.ts` (lines ~102–112) sets
  `notificationPrefs` **without** `deliveryHour`; because the field is **required**
  (not optional), that literal will fail `nx typecheck`/`build` for `shared-domain`
  unless `deliveryHour: null` (or a number) is added to it. Add `deliveryHour: null`
  to that literal. (Making the field optional `deliveryHour?:` is **rejected** —
  the persisted contract should be explicit; legacy tolerance is handled in the
  converter via `?? null`, not by an optional type.)
- **Decision: field is required, value is nullable.** This mirrors how the other
  prefs are required booleans. The "missing on legacy docs" case is a
  **persistence** concern handled by the converter's `?? null` coalesce, not a
  type-optionality concern.

### Settings slice surface (`libs/mobile/settings`)

`SettingsService` (`settings.service.ts`) gains a delivery-hour signal + setter,
mirroring the region pattern. **Binding** behaviour (names are a recommendation):

```ts
/** Current persisted delivery hour (0–23) or null ("Any time"); null until load. */
readonly deliveryHour: Signal<number | null>;

/** The selectable UTC hours 0..23 (for the picker options besides "Any time"). */
readonly deliveryHours: readonly number[]; // [0,1,...,23]

/** Persists notificationPrefs.deliveryHour, preserving the three booleans. */
setDeliveryHour(hour: number | null): Promise<void>;
```

- **`load()`** reads `user.notificationPrefs.deliveryHour` into the new signal
  (via `dataToUser`, which coalesces a missing value to `null` — see Data model).
  The eager-create default sets `deliveryHour: null`.
- **`setDeliveryHour(hour)`** must persist the **whole** `notificationPrefs`
  object with the current three booleans preserved and `deliveryHour` set —
  because the existing `setNotificationsEnabled` writes `notificationPrefs`
  wholesale, `setDeliveryHour` must read the current booleans (from the service's
  own state / signals) and write all four together, e.g.:
  ```ts
  await updateDoc(doc(this.firestore, userPath(uid)), {
    notificationPrefs: {
      episodeAired: <current>,
      movieAvailable: <current>,
      cameToPlatform: <current>,
      deliveryHour: hour,
    },
  });
  ```
  **The implementer must keep the booleans in sync** — the simplest robust
  approach is to track the loaded `notificationPrefs` (all four fields) in service
  state and rebuild the object on every write, so neither setter clobbers the
  other. **State the chosen approach in the README** and cover it with the unit
  test "setDeliveryHour preserves the three booleans" + "setNotificationsEnabled
  preserves deliveryHour".
- **Mock providers (`settings.providers.mock.ts`) must mirror the surface.** The
  `MockSettingsServiceImpl` structurally mirrors `SettingsService`'s public
  surface (it does not extend it); add the `deliveryHour` signal,
  `deliveryHours` array, and `setDeliveryHour` method (seeded e.g.
  `deliveryHour = null` → "Any time") so `--configuration=mock` and the component
  test compile and render.

`SettingsPage` stays exported from `libs/mobile/settings/src/index.ts`
(unchanged surface); it gains a template row + a change handler + the `IonSelect`
import if not already present (it is — the region picker already imports it).

### Dispatcher change (`libs/functions/dispatch-notifications`)

A pure, slice-local UTC-window predicate gating the FCM send only. No barrel
surface change is required, but exporting the predicate for direct unit testing
is acceptable:

```ts
/** True when an FCM push is allowed now for this delivery-hour preference.
 *  null = any time. Compares the user's chosen UTC hour to `now`'s UTC hour. */
export function isWithinDeliveryWindow(
  deliveryHour: number | null,
  now: Date,
): boolean {
  return deliveryHour == null || now.getUTCHours() === deliveryHour;
}
```

- The dispatcher's `now` is injected as `() => string` (ISO 8601, see
  `DispatcherConfig.now`). Derive the UTC hour from it:
  `new Date(timestamp).getUTCHours()` — **reuse the same `timestamp` already
  computed once per `dispatch()` call** (`dispatcher.ts` computes `const
  timestamp = now()`), so the clock is consistent with `sentAt` and remains
  deterministic in tests.
- **The guard wraps ONLY the FCM send loop, not the notification write.** In
  `dispatchForUser` the current flow per enabled kind is: build the
  `NotificationDoc` → `notifications.write(...)` → loop `fcm.send(...)`. The guard
  must:
  - **Compute `withinWindow` ONCE at the top of `dispatchForUser`**, before the
    `for (const kind of enabledKinds)` loop — not inside it. The predicate value
    is per-user and identical for every kind; re-evaluating it inside the kind loop
    is correct but causes the debug log to fire once per kind instead of once per
    user. Concrete placement:
    ```ts
    const withinWindow = isWithinDeliveryWindow(
      user.notificationPrefs.deliveryHour, new Date(timestamp),
    );
    if (!withinWindow) console.debug('Skipping FCM for uid ' + user.uid + ': outside delivery window');
    // then below, inside the kind loop:
    if (withinWindow) { for (const fcmToken of user.fcmTokens) { ... } }
    ```
  - **always** run `notifications.write(...)` and increment
    `notificationsWritten` (inbox preserved, decision 3);
  - **skip the entire `for (const fcmToken of user.fcmTokens)` send loop** when
    `!withinWindow`, so `fcm.send` is never called and `fcmSent`/`staleTokensPruned`
    are not incremented for this user this run;
  - log **one** debug line when skipping (one line per skipped user, not per kind
    or per token; no secret, no token, in the log).
- **Per-user evaluation (decision 3):** the predicate uses **this user's**
  `deliveryHour`, inside the per-user loop, so users with different windows are
  gated independently. The `transition`/`decideKinds`/prefs-gate logic is
  unchanged — the window only suppresses the push, after the kind is already
  decided and the doc already written.
- **`DispatchSummary` is unchanged in shape.** `fcmSent` will simply be lower when
  sends are skipped; consider whether to add a `fcmSkipped` counter for
  diagnostics — **optional**, additive, non-binding; if added, document it in the
  README and assert it in a test, otherwise leave the summary as-is.

### Config / secrets

No secret is read or written. The dispatcher uses its ambient Admin credentials
(unchanged); the settings slice uses the shell's already-initialised AngularFire.
No `.env.local` access.

## UI / Stitch screen refs

This is a mobile slice (`slice:settings`). The visual contract is the existing
**Stitch "Settings - Vultus" screen, id `81945ff3381e453dafcc4e5ce896fcfa`**
(project `13590348714018893783`, "Vultus Android App Design"; design system
`docs/design/vultus-design-system.md`) — the same screen pinned by spec 0018.
The new "Notification time" row **reuses the established `.settings-card` /
`.settings-row` pattern** already implemented in
`libs/mobile/settings/src/lib/settings.page.{html,scss}` (spec 0018), so the new
row's styling is **derived from a sibling row already in the repo**, not invented.

**The implementer MUST still re-fetch the screen** to confirm the new row's
placement and any delivery-time control the screen may already depict, and
**record the screen id in the PR**. Fetch recipe (per CLAUDE.md / project memory
`stitch-mcp-reachable.md` — the MCP **is** reachable; a failed call is a retry):

1. `list_screens` in `projects/13590348714018893783`, locate the **Settings**
   screen; confirm its id is `81945ff3381e453dafcc4e5ce896fcfa`. Retry on MCP
   failure.
2. `get_screen` on it — record the id for the PR. It returns metadata + download
   URLs, not markup.
3. Fetch `htmlCode.downloadUrl` via a **plain HTTP GET** (PowerShell
   `Invoke-WebRequest`, **not** WebFetch) and read the Tailwind config + markup
   for the concrete values; fetch `screenshot.downloadUrl` for the visual compare.
4. If the screen genuinely cannot be read after retries, treat the UI task as
   `needs-human` and record it — do **not** ship token-only.

> **Note on the existing screen:** spec 0018 noted the Settings screen depicts a
> "Notification Preferences" nav row (deferred, not wired). If the fetched screen
> depicts a **delivery-time / notification-time** control specifically, match its
> styling for this row; if it does not, render the new row in the **same
> `.settings-card` silhouette as the Notifications toggle row** (decided below).
> Do **not** wire any other decorative row the screen shows (spec 0018 Out of
> scope still holds).

**Authoritative tokens** live in `docs/design/vultus-design-system.md`, consumed
via the `--vultus-*` / `--ion-*` vars in `libs/shared/ui-kit/src/lib/theme.scss`.
**Never hand-transcribe a hex** — primary is `#4edea3` (`--ion-color-primary` /
`--vultus-primary`), **not** `#10B981` (which is `primary-container`).

### Structure — the new "Notification time" row (checkable contract)

Render the new row as a **third `.settings-card`** in the existing
`.settings-cards` stack, immediately **below** the Notifications-toggle card,
reusing the **exact** `.settings-card` / `.settings-row` / `.settings-row__icon`
/ `.settings-row__body` / `.settings-row__select` / `.settings-row__helper`
classes already defined in `settings.page.scss` (spec 0018) so it is
pixel-consistent with the Region card (which is also an `IonSelect` in this
pattern). Concretely:

- **Card:** `.settings-card` — fill `surface-container` (`--vultus-surface-container`),
  radius `--vultus-radius-md` (0.75rem), 1px `outline-variant` hairline at 20%
  alpha, 16px internal padding (`--vultus-space-md`), 8px (`--vultus-space-sm`)
  gap from the sibling card above. **The 16px side inset and 8px inter-card gap
  must agree with the Region and Notifications cards** (same stack).
- **Icon tile:** `.settings-row__icon` — 40×40px, `--vultus-radius` (0.5rem),
  surface-ramp tile, **primary-coloured glyph** (`--ion-color-primary`), 22px
  icon. Use the **`time-outline`** ionicon (register it via the page's
  `addIcons({...})` alongside the existing `globeOutline` / `notificationsOutline`).
- **Control:** an **`IonSelect`** styled by `.settings-row__select` exactly like
  the Region select — `label="Notification time"`, `labelPlacement="start"`,
  `interface="popover"`, `[value]="service.deliveryHour()"`,
  `(ionChange)="onDeliveryHourChange($event)"`. Options:
  - first option **"Any time"** with `[value]="null"`;
  - then 24 options, one per hour, `[value]="hour"` displaying the **zero-padded
    UTC label** `"00:00 UTC" … "23:00 UTC"` (format `String(hour).padStart(2,'0')
    + ':00 UTC'`). The selected value renders in `primary` per the
    `.settings-row__select ::part(text)` rule (same as Region).
- **Type roles:** the `label` ("Notification time") = `body-lg`/600 (the
  `.settings-row__select ::part(label)` rule); the selected value = `body-lg`/700
  primary; the helper text = `body-md` `on-surface-variant`. Pin via the existing
  classes — do **not** introduce new font sizes.
- **Helper text:** a `.settings-row__helper` `<p>` reading e.g. "Pushes are only
  sent during this hour (UTC). Notifications still appear in your inbox." —
  `body-md` (14/400), `--vultus-on-surface-variant`, 8px below the control,
  aligned to the control's left edge (same as the other rows' helpers).

### Enabled/disabled gating (decision: only enabled when notifications are on)

The decision record requires the row be **only shown / enabled when the global
notifications toggle is on**. Pin this as a **disabled state**, not a removal,
to avoid layout shift:

- When `service.notificationsEnabled()` is **true**: the row's `IonSelect` is
  **enabled** (default state, full opacity).
- When `service.notificationsEnabled()` is **false**: the `IonSelect` is
  **disabled** (`[disabled]="!service.notificationsEnabled()"`), rendered at the
  **Ionic disabled opacity** (the framework default `--ion-item`/control disabled
  treatment; do not invent a custom dim). The card and helper text remain
  visible. Toggling notifications back on re-enables it without a reload.
- **Decision (pinned):** the row stays **rendered but disabled** when
  notifications are off (chosen over hiding it, to keep the card stack stable and
  discoverable). If the fetched screen instead hides it, the implementer may match
  the screen — **note the choice in the PR**.

### Per-state acceptance contract (tick each off vs the fetched screen + screenshot)

- **Notification-time select — default (notifications on):** shows the current
  value ("Any time" when `deliveryHour` is null, else "HH:00 UTC"), `body-lg`,
  on `surface-container`, 0.5rem-ish control, selected value in `primary`
  `#4edea3` per `::part(text)`.
- **— open/focus:** `interface="popover"` popover matching the Region select's
  popover; any focus ring matches the Region select (same class).
- **— pressed:** the card's `:active` 5%-emerald overlay (the existing
  `.settings-card:active` rule), **not** a lift.
- **— disabled (notifications off):** Ionic default disabled opacity; not
  interactive; value still legible.
- **Sibling alignment:** the Region card, Notifications card, and Notification-time
  card share the **same 16px side inset, 8px inter-card gap, 40×40 icon tile, and
  helper left-edge** (no row drifts).
- **Font loading:** Inter is already loaded app-wide (spec 0010); confirm the new
  row renders in Inter, not a system fallback (the screenshot compare catches a
  fallback).
- **Transitions:** reuse the existing `.settings-card` `transition: background-color
  150ms` — add **no** new animation the screen doesn't show.

**Visual verification (CLAUDE.md):** serve `pnpm nx run mobile:serve-mock` (or
render the page with the mocked `SettingsService`, seeding `deliveryHour` to both
`null` and a number, and `notificationsEnabled` to both true and false) → take a
screenshot → compare against the Stitch `screenshot.downloadUrl`. A green
typecheck/lint/test/build does **not** prove fidelity. If the mock serve cannot
run under the tooling, **explicitly flag the UI unverified for a human eyeball**
in the PR.

## Implementation task graph

T1 (the shared field) is a foundation dep both other tasks compile against, so it
runs **first and alone**. T2a (settings) and T3b (dispatcher) are independent
slices in disjoint scopes and run **in parallel** after T1. Their file manifests
are pairwise disjoint.

**T1 — Add `deliveryHour` to `NotificationPrefs` [sequential]** (backend-engineer / domain)

- Add `deliveryHour: number | null` to `NotificationPrefs` in
  `libs/shared/domain/src/lib/documents.ts`.
- Add `deliveryHour: null` to the `_user` literal in
  `libs/shared/domain/src/lib/type-assertions.ts` (else `shared-domain`
  typecheck/build fails — the field is required).
- Update `libs/shared/domain/README.md`'s `NotificationPrefs` description to list
  `deliveryHour` (the README enumerates the document fields — CLAUDE.md lib-README
  rule).
- Decide the converter coalesce: verify how `dataToUser`/`userToData` in
  `libs/shared/firestore-schema` handle `notificationPrefs`. If they construct the
  prefs object field-by-field, add `deliveryHour: data.notificationPrefs.deliveryHour
  ?? null` to `dataToUser` (legacy-doc tolerance) and pass `deliveryHour` through
  in `userToData`; extend the user round-trip test to set + assert `deliveryHour`
  (number and null) and a **missing-field → null** case. If `notificationPrefs` is
  a wholesale passthrough, only the round-trip test changes (and the missing-field
  coalesce must still be proven — add the `?? null` if absent). Update
  `libs/shared/firestore-schema/README.md` only if it enumerates the prefs fields.
- Files: `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/type-assertions.ts`,
  `libs/shared/domain/README.md`,
  `libs/shared/firestore-schema/src/lib/converters.ts` (only if field-by-field),
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md` (only if it lists prefs fields).

**T2a — Settings delivery-hour picker [parallel, after T1]** (frontend-engineer)

- `SettingsService` (`settings.service.ts`): add the `deliveryHour` signal,
  `deliveryHours` (`0..23`) array, and `setDeliveryHour(hour)`; read
  `deliveryHour` in `load()`; add `deliveryHour: null` to the eager-create
  defaults; ensure both `setDeliveryHour` and `setNotificationsEnabled` write the
  whole `notificationPrefs` object **preserving the other fields** (track loaded
  prefs in state — see Public types). Guard null uid (existing pattern).
- Mirror the new surface in `settings.providers.mock.ts`
  (`MockSettingsServiceImpl`): `deliveryHour` signal, `deliveryHours`,
  `setDeliveryHour`.
- `SettingsPage` (`settings.page.ts`): add `onDeliveryHourChange($event)`; register
  the `timeOutline` ionicon; ensure `IonSelect`/`IonSelectOption` imported (already).
- `settings.page.html`: add the third `.settings-card` "Notification time" row per
  the UI contract (below the Notifications card), `[disabled]` bound to
  `!service.notificationsEnabled()`.
- `settings.page.scss`: reuse the existing classes; add row-specific styling **only**
  if the disabled/option rendering needs it (prefer the existing `.settings-row__select`
  rules; no hard-coded hex).
- Update `libs/mobile/settings/README.md` to note the delivery-hour control + the
  preserve-other-prefs write rule.
- Update/extend `settings.service.spec.ts` + `settings.page.spec.ts` (Test plan).
- Files (manifest): `libs/mobile/settings/src/lib/settings.service.ts`,
  `libs/mobile/settings/src/lib/settings.service.spec.ts`,
  `libs/mobile/settings/src/lib/settings.providers.mock.ts`,
  `libs/mobile/settings/src/lib/settings.page.ts`,
  `libs/mobile/settings/src/lib/settings.page.html`,
  `libs/mobile/settings/src/lib/settings.page.scss`,
  `libs/mobile/settings/src/lib/settings.page.spec.ts`,
  `libs/mobile/settings/README.md`.

**T3b — Dispatcher delivery-window guard [parallel, after T1]** (backend-engineer)

- Add `isWithinDeliveryWindow(deliveryHour, now)` (pure) to
  `libs/functions/dispatch-notifications/src/lib/transitions.ts` (or a small
  `delivery-window.ts`); export it from the barrel if a direct unit test imports
  it.
- In `dispatcher.ts` `dispatchForUser`: keep `notifications.write(...)` +
  `notificationsWritten++` unconditional; wrap the `for (const fcmToken of
  user.fcmTokens)` send loop in `if (isWithinDeliveryWindow(user.notificationPrefs
  .deliveryHour, new Date(timestamp))) { ... } else { console.debug(...) }`
  (one debug line per skipped user). The core uses `deliveryHour == null` semantics
  (tolerates `undefined` from legacy docs).
- If a `WatchlistStore` Admin adapter in `apps/functions` constructs
  `TrackingUser.notificationPrefs` field-by-field, ensure it carries `deliveryHour`
  (defaulting missing → `null`); if it passes the prefs through, the `== null`
  core check covers legacy docs. **Verify and document** which.
- Update `libs/functions/dispatch-notifications/README.md` to describe the
  delivery-window gate (FCM-only skip, inbox preserved, UTC, per-user).
- Extend `transitions.spec.ts` (predicate) + `dispatcher.spec.ts` (Test plan).
- Files (manifest): `libs/functions/dispatch-notifications/src/lib/transitions.ts`
  (or `.../src/lib/delivery-window.ts`),
  `libs/functions/dispatch-notifications/src/lib/transitions.spec.ts`
  (or `.../delivery-window.spec.ts`),
  `libs/functions/dispatch-notifications/src/lib/dispatcher.ts`,
  `libs/functions/dispatch-notifications/src/lib/dispatcher.spec.ts`,
  `libs/functions/dispatch-notifications/src/index.ts` (only if exporting the
  predicate),
  `libs/functions/dispatch-notifications/README.md`,
  `apps/functions/src/dispatch/adapters.ts` (only if the adapter builds prefs
  field-by-field and needs the `deliveryHour ?? null` default),
  `apps/functions/src/dispatch-notifications.spec.ts` (only if the adapter changes).

**Disjointness:** T2a writes only under `libs/mobile/settings/**`; T3b writes only
under `libs/functions/dispatch-notifications/**` (+ optionally `apps/functions/src/
dispatch/**`, which T2a never touches). T1 touches the shared root files
(`libs/shared/domain/**`, `libs/shared/firestore-schema/**`) and runs first, alone.
The three manifests are pairwise disjoint.

## Test plan

Per the PLAN §5 pyramid — unit (domain/converter, dispatcher), component
(settings page), and the e2e rubric outcome below.

**Unit (shared/domain + firestore-schema):**
- `NotificationPrefs` type accepts `deliveryHour: number` and `deliveryHour: null`
  (the `_user` literal compiles — a compile-time gate, no runtime assertion needed
  beyond the literal).
- **Converter round-trip (`firestore-schema.spec.ts`):** a `User` with
  `notificationPrefs.deliveryHour = 8` survives `userToData` → `dataToUser`
  unchanged; with `deliveryHour = null` survives as `null`; a **legacy persisted
  doc whose `notificationPrefs` has no `deliveryHour`** maps to `deliveryHour: null`
  through `dataToUser` (the coalesce). These pin the legacy-tolerance contract.

**Unit (dispatch-notifications):**
- `isWithinDeliveryWindow`: `null` → `true` at any hour; a number equal to
  `now.getUTCHours()` → `true`; a number not equal → `false`; boundary hours
  `0` and `23` behave correctly (use a fixed `Date` with a known UTC hour).
- `dispatcher.spec.ts` (fake stores + fixed `now`):
  - **Outside window → FCM skipped, doc still written:** a user with
    `deliveryHour` ≠ the fixed `now`'s UTC hour → `notifications.write` IS called
    (assert `notificationsWritten` and the doc), `fcm.send` is **never** called
    (`fcmSent === 0` for that user), no `removeFcmToken`.
  - **Inside window → sends as today:** a user with `deliveryHour ===` the fixed
    `now`'s UTC hour → doc written AND `fcm.send` called per token (existing
    behaviour).
  - **`deliveryHour === null` → sends any time:** unchanged behaviour (doc +
    sends), regardless of the fixed hour.
  - **Per-user independence:** in one `dispatch` call, three in-region users —
    one `null`, one matching, one non-matching — the first two get FCM, the third
    gets only the doc; all three get a notification doc written.
  - **Legacy doc (missing `deliveryHour`/`undefined`) → treated as any time:** a
    `TrackingUser` whose `notificationPrefs` omits `deliveryHour` still sends FCM
    (the `== null` check covers `undefined`).
  - **Clock determinism:** the window check uses the same injected `now`/`timestamp`
    as `sentAt`, proven by setting `now` to a fixed ISO with a known UTC hour.
  - The existing 0012 tests (region filter, prefs gate, stale-token prune,
    per-user error isolation, no-write-outside-`users/**`, best-effort idempotency)
    **stay green** — the guard only suppresses the send loop.

**Component (settings — `settings.page.spec.ts`, mocked `SettingsService`):**
- The "Notification time" `ion-select` renders once loaded, with an "Any time"
  option plus 24 hour options (assert option count = 25), the value reflecting
  `service.deliveryHour()`.
- Changing the select calls `service.setDeliveryHour(...)` with the chosen value
  (a number for an hour; `null` for "Any time").
- **Disabled gating:** when `service.notificationsEnabled()` is false, the select
  is `disabled`; when true, it is enabled.
- The existing settings assertions (region select, notifications toggle,
  render-gate, error state) **stay green**.
- **Service unit (`settings.service.spec.ts`):** `setDeliveryHour(8)` writes
  `notificationPrefs` with the **three booleans preserved** and `deliveryHour: 8`;
  `setNotificationsEnabled(false)` preserves the current `deliveryHour`;
  `load()` reads `deliveryHour` into the signal; eager-create writes
  `deliveryHour: null`; null-uid → no write.

**e2e (rubric):** **Not required.** Per the e2e decision rubric: although this
touches a `scope:mobile` slice, it adds a **preference control on an existing
page** (no new route, no new primary navigation/critical action) and a
backend-only delivery gate; the settings persist-on-change behaviour is covered by
the component + unit tests against a mocked Firestore (consistent with spec 0011
decision 5 and project memory: the emulator cannot run under Claude Code tools
here). **No new e2e flow is required — settings-preference + backend-gate change
only.** No `apps/mobile-e2e`, `playwright.config.ts`, or `ci.yml` change.

## Definition of done

Tailored from PLAN §5 to the projects touched. Green gate is **typecheck + lint
(incl. Sheriff) + unit + component + build** plus the **UI visual check** for the
settings row.

- [ ] `pnpm nx typecheck shared-domain shared-firestore-schema mobile-settings
      functions-dispatch-notifications` passes — the additive `deliveryHour`, the
      converter, the picker, and the dispatcher guard compile.
- [ ] `pnpm nx lint shared-domain shared-firestore-schema mobile-settings
      functions-dispatch-notifications` passes **with Sheriff active**: settings
      imports only `@vultus/shared/*` + AngularFire/Ionic (no other slice, no
      `scope:functions`); the dispatcher core stays Firebase-free and imports no
      other slice; no `scope:mobile` ↔ `scope:functions` edge.
- [ ] `pnpm nx test shared-firestore-schema` passes — the user round-trip covers
      `deliveryHour` (number, null, and missing → null).
- [ ] `pnpm nx test functions-dispatch-notifications` passes — `isWithinDeliveryWindow`
      + the dispatcher window tests (outside → FCM skipped but doc written; inside →
      sends; null → any time; per-user independence; legacy → any time); the 0012
      tests stay green.
- [ ] `pnpm nx test mobile-settings` passes — the delivery-hour service + page
      tests (preserve-other-prefs writes, 25 options, disabled-when-off) plus the
      existing settings tests.
- [ ] `pnpm nx build mobile` and `pnpm nx build functions` pass (and
      `pnpm nx run functions:deploy-preflight` if `apps/functions` deps/build
      changed — they should not here, but run it if the adapter file changed).
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green — the
      affected set is `shared-domain`, `shared-firestore-schema`, `mobile-settings`,
      `functions-dispatch-notifications`, `mobile`, `functions` and dependents.
- [ ] **Stitch Settings screen re-fetched:** the PR records the screen id
      `81945ff3381e453dafcc4e5ce896fcfa` (or notes the MCP was unreachable after
      retries → `needs-human`, **not** silently token-only).
- [ ] **UI fidelity verified** (`mobile:serve-mock` / screenshot vs the Stitch
      screenshot, with `deliveryHour` seeded null + a number and notifications
      on/off) **or explicitly flagged unverified for a human** — a green build does
      not prove fidelity (CLAUDE.md). The per-state acceptance contract is ticked.
- [ ] No hard-coded hex in the new template/SCSS — only `--vultus-*` / `--ion-*`
      vars; the new row reuses the existing `.settings-card` classes.
- [ ] READMEs updated: `libs/shared/domain/README.md` (lists `deliveryHour`),
      `libs/mobile/settings/README.md` (delivery-hour control + preserve-prefs
      write), `libs/functions/dispatch-notifications/README.md` (the FCM-only,
      inbox-preserving, UTC, per-user delivery gate); `shared/firestore-schema`
      README only if it enumerates prefs fields.
- [ ] **Boundary verifications (review-checked):** (a) the dispatcher **still
      writes the notification doc** for every dispatched kind regardless of the
      window — only `fcm.send` is gated (decision 3); (b) the gate is **per-user**
      using that user's `deliveryHour`; (c) **no queuing/retry** of a missed window
      (decision 4); (d) **legacy docs (missing `deliveryHour`) behave as "any
      time"** (the `?? null` converter coalesce + the `== null` core check); (e)
      `setDeliveryHour` / `setNotificationsEnabled` **each preserve the other prefs
      fields**; (f) **no `firestore.rules`/`firestore.indexes.json` change**; (g)
      **no secret** read/written.
- [ ] PR description records: the screen id + visual-verification result, the exact
      verification commands, the four boundary confirmations (doc-always-written /
      per-user / no-queue / legacy-tolerance), and that **e2e is not required**
      (settings-preference + backend-gate change only).

## Risks

- **Legacy `users/{uid}` docs lack `deliveryHour` (handled).** Docs created before
  this spec (spec 0011) have no `deliveryHour`. The required-but-nullable type is
  made safe by the `dataToUser` `?? null` coalesce (settings) and the dispatcher's
  `deliveryHour == null` check (which also catches `undefined`). Both are tested.
  Making the field optional was **rejected** — explicit persistence with a
  converter coalesce is the spec-0003/0005 pattern. A reviewer should confirm both
  readers tolerate a missing field (the round-trip "missing → null" test + the
  dispatcher "legacy → any time" test pin it).
- **Two setters writing `notificationPrefs` wholesale can clobber each other.**
  `setNotificationsEnabled` (spec 0011) writes all-three-booleans;
  `setDeliveryHour` must write the same object plus `deliveryHour` — if either
  forgets the other's fields it resets them. **Mitigation:** the service tracks the
  loaded `notificationPrefs` (all four fields) in state and rebuilds the whole
  object on every write; covered by the "preserve other prefs" tests. Flagged as
  the most likely implementation slip.
- **Missed-window notifications never push (by design, decision 4).** If no sync
  run lands in the user's chosen UTC hour, a notification is written to the inbox
  but **never** pushed. This is the accepted v1 model (no queue/retry). With the
  daily cron (spec 0017) running once/day at a fixed UTC time, a `deliveryHour`
  that does not equal the cron's run hour means the user gets **inbox-only**, never
  a push — the user must pick the hour the cron actually runs to receive pushes.
  **This is a real usability sharp edge** worth a product follow-up (e.g. validate
  `deliveryHour` against the cron hour, or run the dispatcher hourly), but it is
  **out of scope** here per decision 4/5 — recorded so it is a conscious v1
  limitation, not an oversight.
- **UTC-only is coarse (decision 1).** The window is a UTC hour, not the user's
  local time, so "08:00 UTC" is mid-morning in NL but late evening elsewhere. v1
  accepts this (no timezone storage); local-time windows are a later spec.
- **Single hour, not a range (decision 5).** Only one UTC hour is allowed; a
  user wanting "daytime only" cannot express a range yet. Deferred.
- **`fcmSent` summary drops silently when skipped.** `DispatchSummary.fcmSent` will
  be lower for skipped users; no `fcmSkipped` counter is required (optional,
  additive). A reviewer reading run diagnostics should know a low `fcmSent` with a
  positive `notificationsWritten` is the expected delivery-window skip, not a bug.
- **No PLAN conflict.** This extends `NotificationPrefs` (PLAN §4 `users/{uid}`)
  additively and gates the dispatcher's FCM send (PLAN §6 item 14) without
  changing the transition/decision logic, the inbox (spec 0042), or the cron
  (spec 0017). The UTC-only / single-hour / no-queue choices are v1 product calls
  within PLAN §1's scope, not conflicts.
