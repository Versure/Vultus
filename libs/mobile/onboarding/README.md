# @vultus/mobile/onboarding

First-launch onboarding slice for the Vultus mobile app (spec 0078, extending
spec 0022). It gates the tabs shell behind a one-time setup flow: until the
`onboarding_done` Capacitor Preferences flag is `'true'`, the guard redirects
into the onboarding page, which walks the user through a **5-step wizard** that
sets up their whole account before entering the app.

## Public surface (barrel)

The barrel (`src/index.ts`) is **unchanged** from spec 0022 — same three
exports, same shapes, same `/onboarding` route wiring (the shell needs no edit):

- **`OnboardingPage`** — standalone Ionic page (`selector: lib-onboarding`),
  registered as the `/onboarding` route by the shell. A single route that
  renders **one of five steps** from `OnboardingService.currentStep()`:
  **1. Region → 2. My Providers → 3. Notifications → 4. Plex link → 5. Finish.**
  There are no new Angular routes; steps are an internal signal.
- **`onboardingGuard`** — a `CanActivateFn` for the tabs route. Returns `true`
  when the `onboarding_done` flag is `'true'`, otherwise a `UrlTree` redirect to
  `/onboarding`.
- **`reverseOnboardingGuard`** — a `CanActivateFn` for the `/onboarding` route
  (issue #65). Returns a `UrlTree` redirect to `/tabs/today` when the flag is
  already `'true'`, otherwise `true`.

`ONBOARDING_DONE_KEY` (the Preferences key) is exported from
`onboarding.guard.ts` for the service; it is not part of the public barrel.

Slice-private (not exported unless a test needs it): `OnboardingService` (the
wizard's data-access + step state), `OnboardingPlexLinkService` (the step-4
PIN-link machine), and the copied `plex-errors.ts`.

## Wizard behaviour & write-as-you-go persistence

Each step persists its choice to `users/{uid}` **as it completes**, rather than
batching one write at the end (spec 0078 decision 2). This makes a mid-wizard
app-kill safe: a valid partial doc is left, and because `onboarding_done` is
still the **last** write of the whole flow, the guard simply re-runs the wizard
(every write is idempotent — create-with-`{merge:true}` / whole-array /
whole-object).

- **Step 1 — Region:** the FIRST `setRegion` CREATES `users/{uid}` with defaults
  (region + all-true `notificationPrefs`, `deliveryHour: null`, `fcmTokens: []`,
  `myProviderIds: []`, `hasPlex: false`) via `setDoc(..., { merge: true })`. A
  LATER `setRegion` (Back-nav / region change) updates `region` and re-triggers
  the catalog-reload-and-**prune** coupling: it drops any selected
  `myProviderIds` absent from the new region's catalog (and SKIPs the prune,
  preserving the list, if the catalog reload fails).
- **Step 2 — My Providers:** `loadProviderCatalog` fetches the region's catalog
  via the `GET_WATCH_PROVIDERS` token; `toggleProvider` persists the WHOLE
  `myProviderIds` array. Empty selection is a valid, completable state (Continue
  is always enabled). A chip grid mirrors the Settings "My Providers" markup.
- **Step 3 — Notifications:** a global toggle (`setNotificationsEnabled` sets all
  three per-type booleans at once) + a delivery-hour picker (`setDeliveryHour`,
  disabled while the global toggle is off — spec 0051 parity). "Notifications
  off" is a valid, completable state.
- **Step 4 — Plex link:** injects `OnboardingPlexLinkService` and renders ONE of
  its stages. The link is **user-initiated**: the step opens in the `idle` stage
  showing a **"Connect Plex"** button (it is NOT auto-started on step entry —
  auto-starting raced the deterministic auto-authorizing `MockPlexClient` to
  `connected` on every non-native surface, writing `hasPlex`/`plexSync` and
  tearing the skip button out of the DOM; keeping it user-triggered also matches
  spec 0078 decision 7, which scopes navigate-in + skip to e2e and the live
  PIN/discovery to device-only). Tapping "Connect Plex" calls `requestCode()`;
  the `code`/`waiting` stages then share a card (the code with a copy-to-clipboard
  button + transient "Copied" feedback, an mm:ss countdown, a "Get a new code"
  button, an "Open plex.tv/link" secondary button that opens the Plex link page via
  `@capacitor/browser`, and a waiting spinner — spec 0090); the `error` stage shows
  reason-specific copy for `expired`/`no-server`/`network`; the `connected`
  stage shows the discovered server row. A **"Skip for now"** affordance
  (present in every non-connected stage, including `idle`) calls `cancel()` and
  advances with NO `hasPlex`/`plexSync` write. When connected, a "Continue"
  advances instead. This step is the only skippable one.
- **Step 5 — Finish:** "Get started" calls `complete()` — on a native platform it
  requests OS push permission and, on grant, registers + `arrayUnion`s one FCM
  token; then it sets `onboarding_done = 'true'` **last**. A denied/failed push
  never blocks completion. On resolve it navigates to `/tabs/today` with
  `{ replaceUrl: true }` (issue #65) so the back button can't return to
  onboarding.

Steps 2-5 show a **Back** control that moves the step signal back with the prior
(already-persisted) value still shown — no data loss.

### `OnboardingPlexLinkService`

An onboarding-**owned** plex.tv PIN-link state machine (its own class), a subset
of the Settings `PlexLinkService`. Signals `stage`
(`idle|code|waiting|connected|error`), `errorReason`
(`expired|no-server|network|null`), `code`, `server`, `expiresInSeconds`,
`countdown` (mm:ss); methods `requestCode()`, `regenerateCode()`, `cancel()`.
Internal `completeLink` follows the **discover-before-persist** ordering
invariant: discover the server, then persist the X-Plex-Token to Capacitor
`Preferences` (key `plex_token`, **never** Firestore, **never** logged), then
write `hasPlex`/`plexSync`, rolling the token back if the Firestore write fails.
It omits `unlink()`/`loadState()`/`isLinked()` (Settings-only). The copied
`plex-errors.ts` (`PlexHttpError`, `PlexPinGoneError`) lets it discriminate a
real PIN expiry (`instanceof PlexPinGoneError` → `expired`) from transient
transport failures.

## Mock (`--configuration=mock`)

`onboarding.providers.mock.ts` structurally mocks `OnboardingService` AND
page-scopes a mock `OnboardingPlexLinkService` (shadowing the root singleton) so
all five steps render and navigate with no Firebase / native plugins / callables
under `pnpm nx run mobile:serve-mock`. The catalog is seeded with a
selected/unselected mix and the Plex machine walks code → connected.

## Design / visual verification

**Step CONTENT is aligned to authoritative Stitch screens** (via the in-repo,
already-aligned Settings / Connect-Plex markup that the page mirrors — no
cross-slice import): My Providers `cebdfd02c7d44023b0e0019dd4907d48` /
`0e2bb1f198f04186b39e4a2604413417`, notification controls
`81945ff3381e453dafcc4e5ce896fcfa`, Connect Plex `398cde766832491e92e1c0c5cc09ab4e`.

**The wizard CHROME (the "Step N of 5" progress indicator, the per-step Back
control, and the step-4 "Skip for now" affordance) has NO Stitch screen** — no
onboarding/wizard screen exists in the project. It is built to the spec's
token-only contract using the shared `--vultus-*` / `--ion-*` vars (no
hard-coded hex) and is **flagged `needs-human` for visual verification**. The
native push dialog + FCM token write and the real Plex PIN/LAN discovery are
**device-only** paths, not covered by CI.

## Sheriff boundaries

Tags: `scope:mobile` + `slice:onboarding` (from the path glob). May import only
`@vultus/shared/*` and third-party packages (AngularFire, `@capacitor/*`, Ionic,
ionicons) — **no cross-slice imports**.

**Token-vs-class rule (the crux of spec 0078):** the reused provider, Plex-link
and notification capabilities come in as **`scope:shared` injection tokens**
(`AUTH_UID`, `GET_WATCH_PROVIDERS`, `PLEX_CLIENT` — all provided at the app
root), NOT as `slice:settings` classes. This slice **must never** import
`@vultus/mobile/settings` (`SettingsService` / `PlexLinkService` / its
`plex-errors.ts`): even though those are `providedIn: 'root'` and resolvable from
the root injector, importing the class **symbol** is a
`slice:onboarding → slice:settings` edge Sheriff rejects. The orchestration is
therefore **reimplemented locally** and `plex-errors.ts` is **copied** (2 slices
< the 3+-slice extraction threshold — do not extract to `shared/`).
