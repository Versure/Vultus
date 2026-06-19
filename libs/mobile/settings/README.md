# mobile-settings

The **Settings tab** slice of the Vultus mobile app. Right now it is a **stub**:
a single placeholder Ionic page that the tabs shell lazy-loads so the Settings
tab renders. A later spec (PLAN §6 item 16) fleshes this slice out to own the
region picker, notification preferences, FCM token registration, and the
`users/{uid}` Firestore document — none of which exist yet.

## Public surface

The barrel (`@vultus/mobile/settings`) exports:

- `SettingsPage` — a standalone Ionic page component (selector `lib-settings`)
  rendering an `ion-header`/`ion-toolbar`/`ion-title` ("Settings") and an
  `ion-content` placeholder. It is **lazy-loaded by the tabs shell** in
  `apps/mobile` via `loadComponent: () => import('@vultus/mobile/settings').then(m => m.SettingsPage)`.

## Usage

```ts
// apps/mobile — tabs child route
{ path: 'settings', loadComponent: () => import('@vultus/mobile/settings').then((m) => m.SettingsPage) }
```

## Boundaries (Sheriff)

- **Scope:** `scope:mobile` — **Slice:** `slice:settings` (tagged by path glob in
  `sheriff.config.ts`, not `project.json`).
- May import `scope:shared` (e.g. `@vultus/shared/ui-kit` theming), its **own**
  slice, and third-party packages (Ionic, AngularFire, etc.) only. It must **not**
  import another slice, and `scope:mobile` must never import `scope:functions`.
- The stub page imports Ionic standalone components only — no AngularFire init,
  and it writes **no** Firestore document (the `users/{uid}` doc is owned by this
  slice in the later feature spec, not by this stub).
