# mobile-settings

Region picker, global notifications toggle, and eager `users/{uid}` init for the
Vultus settings tab (PLAN §6 item 16, spec 0011).

## Public API

The barrel (`@vultus/mobile/settings`) exports:

- `SettingsPage` — standalone Ionic page (selector `lib-settings`); lazy-loaded
  by the tabs shell in `apps/mobile` via
  `loadComponent: () => import('@vultus/mobile/settings').then(m => m.SettingsPage)`.

`SettingsService` is an internal data-access service used only by `SettingsPage`
and is intentionally **not** barrel-exported (keeps the public surface minimal).

## Behaviour

On mount, `SettingsPage` calls `SettingsService.load()`, which reads
`users/{uid}` (path + wire mapping via `@vultus/shared/firestore-schema`'s
`userPath` / `dataToUser` / `userToData`). If the doc is absent it is created
with defaults `{ region: 'NL', notificationPrefs: { episodeAired: true,
movieAvailable: true, cameToPlatform: true }, fcmTokens: [] }`, guaranteeing
downstream slices can assume it exists.

The page exposes:

- a **Region** `ion-select` over the shared `REGIONS` list, writing
  `users/{uid}.region` on change;
- a global **Notifications** `ion-toggle` — a UI projection over the three
  `notificationPrefs` booleans (reads on when all three are true; writing sets
  all three at once). No `notificationsEnabled` field is persisted; per-type
  toggles are a later spec.

Writes happen on user interaction (no Save button). The form is render-gated on
`load()` (an `ion-spinner` shows until the doc resolves). `fcmTokens` is never
written beyond the `[]` default (FCM registration is PLAN §6 item 21).

The current uid is obtained via the `scope:shared` `AUTH_UID` injection token
(provided at the app root by the shell), so this slice never imports
`apps/mobile`.

## Sheriff boundaries

- Tags: `scope:mobile`, `slice:settings` (by path glob in `sheriff.config.ts`).
- May import: `scope:shared` libs (`@vultus/shared/domain`,
  `@vultus/shared/firestore-schema`) and third-party packages (Ionic,
  AngularFire).
- Must not import: other slices (`slice:search` / `slice:watchlist`),
  `apps/mobile`, or any `scope:functions` code.
