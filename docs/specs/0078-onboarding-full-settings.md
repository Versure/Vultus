---
number: 0078
slug: onboarding-full-settings
title: Expand onboarding into a multi-step wizard covering region, provider selection, notification settings, and Plex link
status: approved
slices: [slice:onboarding]
scopes: [scope:mobile]
created: 2026-07-20
---

# Expand onboarding into a multi-step wizard covering region, provider selection, notification settings, and Plex link

## Context

GitHub issue [#202 "Onboarding not complete"](https://github.com/Versure/Vultus/issues/202)
asks that first-launch onboarding let the user set **all** their settings up
front, not just region. Verbatim: _"In the onboarding feature i want to let users
directly set all settings options, whats missing now is: Provider selection, Plex
link, Notification settings."_

Today (spec 0022, done) `libs/mobile/onboarding` is a **single** Angular
standalone page (`OnboardingPage`, `libs/mobile/onboarding/src/lib/onboarding.page.ts`),
lazy-routed at `/onboarding`, gated by `onboardingGuard` (a `CanActivateFn` on the
`tabs` route in `apps/mobile/src/app/app.routes.ts`) that reads the Capacitor
`Preferences` flag `onboarding_done`. It collects only: a region pick
(`ion-select` over `REGIONS`, default `NL`) + a notifications explainer + a single
"Get started" button. `OnboardingService.complete(region)` does **one** batched
write: `setDoc(..., { merge: true })` of `users/{uid}` with the chosen `region` +
default `notificationPrefs` (all three per-type booleans `true`, `deliveryHour:
null`) + `fcmTokens: []` + `myProviderIds: []` + `hasPlex: false`, then — native
only, `Capacitor.isNativePlatform()`-guarded — requests OS push permission and, on
`granted`, registers + `arrayUnion`s one `FcmToken`, then sets `onboarding_done =
'true'` **last**. A denied/failed push never blocks completion.

The three things the issue wants added already exist, fully built, in the sibling
`libs/mobile/settings` slice (specs 0011/0049/0051/0060/0061/0073/0075/0077, all
done):

- **Provider selection ("My Providers", spec 0060):** `SettingsService`
  (`libs/mobile/settings/src/lib/settings.service.ts`) fetches the region's TMDB
  provider catalog via the root-provided `scope:shared` token `GET_WATCH_PROVIDERS`
  (`@vultus/shared/domain/tokens`, wired in `apps/mobile/src/app/app.config.ts:131-142`)
  and persists `users/{uid}.myProviderIds: number[]` (default `[]`) via
  `toggleProvider(id)` (writes the whole array). A region change reloads the catalog
  and prunes ids absent from the new catalog (`setRegion`). The manual **Plex chip**
  (spec 0061) is a **separate** `hasPlex: boolean` (default `false`) toggled by
  `toggleHasPlex()` — NOT a member of `myProviderIds` (spec 0077 excludes any TMDB
  "Plex" catalog entry server-side, so no collision).
- **Plex link ("Plex Server", spec 0073):** a **separate** feature from the manual
  `hasPlex` chip — the real LAN-sync link. `PlexLinkService`
  (`libs/mobile/settings/src/lib/plex-link.service.ts`, `providedIn: 'root'`) runs a
  plex.tv PIN-link state machine (`requestCode()` → 4-char code + 15-min wall-clock
  countdown + 2s poll; `stage: 'idle'|'code'|'waiting'|'connected'|'error'`,
  `errorReason: 'expired'|'no-server'|'network'`), discovers a LOCAL server via the
  root-provided `scope:shared` token `PLEX_CLIENT`
  (`@vultus/shared/domain/tokens`, wired in `app.config.ts:150-156`), and — **only
  if a server is found** (ordering invariant: discover before persist) — writes the
  X-Plex-Token to Capacitor `Preferences` (`plex_token`, **never** Firestore) and
  `users/{uid}.hasPlex=true` + `users/{uid}.plexSync={linkedAt,lastSyncAt,serverName}`,
  rolling the token back on a Firestore-write failure. The two typed errors it
  discriminates via `instanceof` (`PlexHttpError`, `PlexPinGoneError`) live in a
  tiny dependency-free module `libs/mobile/settings/src/lib/plex-errors.ts`, tagged
  `slice:settings`.
- **Notification settings (specs 0011/0051):** `SettingsService`'s global
  `notificationsEnabled` toggle is a projection (true iff all 3 per-type
  `notificationPrefs` booleans are true; `setNotificationsEnabled(enabled)` sets all
  three at once) plus a `deliveryHour: number | null` "quiet hours" picker (0-23 or
  `null` = "Any time"; `setDeliveryHour(hour)`, disabled while the global toggle is
  off).

The **binding constraint** is the vertical-slice rule (PLAN §3, CLAUDE.md):
`slice:onboarding` and `slice:settings` are sibling slices under `scope:mobile`;
a slice may import ONLY `scope:shared` + itself, and Sheriff lint enforces this.
`slice:onboarding` **cannot** import anything from `libs/mobile/settings`.
**However**, `GET_WATCH_PROVIDERS` and `PLEX_CLIENT` are both `scope:shared`
`InjectionToken`s already provided at the app **root** by the shell — exactly like
the `AUTH_UID` token onboarding already injects — so onboarding can inject them
**directly, today, with ZERO new shell wiring**. What onboarding genuinely cannot
reuse is the `slice:settings`-tagged **orchestration classes** (`SettingsService`,
`PlexLinkService`) and the `slice:settings`-tagged `plex-errors.ts` **module** —
those must be reimplemented / duplicated inside `slice:onboarding` (2 slices, below
the 3+-slice extraction threshold — CLAUDE.md).

Intended outcome: a fresh install walks a **5-step wizard** (Region → My Providers
→ Notifications → Plex link → Finish) that persists each choice as it goes and
lands on `/tabs/watchlist` with a fully-populated `users/{uid}` doc, instead of the
region-only single page it collects today.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Multi-step wizard, single page, internal step signal.** `OnboardingPage` stays
   the ONE Angular route (`/onboarding`, same guard, same barrel exports
   `OnboardingPage` + `onboardingGuard` unchanged) but internally renders one of 5
   ordered steps via a `currentStep` signal — **no new Angular routes, no router
   plumbing**: **1. Region → 2. My Providers → 3. Notifications → 4. Plex link → 5. Finish** (push-permission request + "Get started"/complete). A step-progress
   indicator (e.g. "Step 2 of 5") is part of the UI contract.
2. **Write-as-you-go persistence.** Each step persists to `users/{uid}` as soon as
   it completes (mirrors `SettingsService`'s per-change writes) rather than batching:
   Region writes `region` (creating the doc with defaults on first write — onboarding
   remains the doc's normal creator); Providers writes `myProviderIds` via the same
   toggle-and-persist-whole-array shape as `SettingsService.toggleProvider`;
   Notifications writes `notificationPrefs` (global toggle + delivery hour); the Plex
   step's own service persists `hasPlex`/`plexSync`/the on-device token when a link
   completes (same discover-before-persist / rollback-on-Firestore-failure ordering
   invariant as `PlexLinkService.completeLink`). The FINAL step still does: request OS
   push permission, and on grant register + `arrayUnion` the `FcmToken`, then set
   `Preferences.onboarding_done = 'true'` **last** (unchanged from spec 0022, decisions
   5/6) — the completion flag remains the last write of the whole wizard regardless of
   which earlier steps ran.
3. **Back navigation allowed.** Steps 2-5 show a "Back" control returning to the prior
   step with its previously-chosen value still shown/editable (state is already
   persisted per decision 2, so "back" just moves the step signal, no data loss).
4. **Plex step is skippable; all other steps are mandatory.** A "Skip for now" /
   "Connect later" affordance exists **only** on step 4 (advances to step 5 without
   linking; the user can link later from Settings, unchanged). Steps 1/2/3/5 have no
   skip (consistent with spec 0022 decision 10's "no skippable onboarding"); the
   exception is scoped to exactly this step because it depends on live LAN discovery of
   a real server the user may not be near. NB: an empty/zero provider selection on step
   2 and "notifications off" on step 3 are valid **choices** the user can complete the
   step with — "mandatory" means "the step must be visited and explicitly advanced,"
   not "a non-empty selection is required."
5. **Duplicate the orchestration logic into `slice:onboarding`; do NOT extract to
   `shared/` (2 slices < 3+ threshold) and do NOT cross-slice-import
   `libs/mobile/settings`.** Concretely:
   - **Provider selection:** onboarding-owned state/logic that injects the EXISTING
     root-provided `GET_WATCH_PROVIDERS` token directly (no new shell wiring) and
     reimplements just the catalog-fetch + `myProviderIds` toggle/persist shape (a few
     dozen lines, not the whole `SettingsService`).
   - **Plex link:** an onboarding-owned link service (its own class, NOT importing
     `PlexLinkService`) that injects the EXISTING root-provided `PLEX_CLIENT` token
     directly and reimplements the subset of the PIN state machine step 4 needs
     (request code, countdown, poll, discover+persist-with-rollback on completion,
     cancel/skip). It does NOT need `unlink()` or the settings-card
     `loadState()`/`serverName`/`lastSyncAt` projection (Settings-only). **Copy** the
     tiny dependency-free `plex-errors.ts` (`PlexHttpError`, `PlexPinGoneError`) into
     `libs/mobile/onboarding` — the one genuinely duplicated file, intentionally tiny
     and dependency-free by original design (spec 0073).
   - **Notification settings:** reimplement the small `notificationPrefs` read/write
     shape (global toggle projection + delivery-hour setter) — onboarding-owned copy.
   - **NOT duplicated (shared tokens injected directly, no new wiring):** `AUTH_UID`
     (already used), `GET_WATCH_PROVIDERS`, `PLEX_CLIENT`. **No new entries are needed
     in `apps/mobile/src/app/app.config.ts`** — all three are already provided at root.
6. **Full parity with Settings for notification controls:** the global on/off toggle
   AND the delivery-hour ("quiet hours") picker, writing the REAL `notificationPrefs`
   the user chose in step 3 (not hardcoded `true` defaults) before the final step's OS
   permission request. Step 3 sets the Firestore-side preference; step 5's OS prompt is
   a separate, orthogonal concern (a user can set prefs all-true in step 3 and still
   deny the OS prompt in step 5 — pushes won't arrive on-device, exactly as today's
   Settings/OS relationship works; no new resolution needed, just don't conflate them).
7. **e2e — mirror the existing fixme pattern for the one known gap.** Step 2's LIVE
   catalog fetch (`GET_WATCH_PROVIDERS` round-trip) has the SAME pre-existing gap as
   specs 0060/0077: the Playwright harness has no Functions-emulator runtime for the
   `getWatchProviders` callable (see the `test.fixme(...)` in
   `apps/mobile-e2e/src/provider-preferences.spec.ts`). The new onboarding e2e adds an
   equivalent `test.fixme(...)` for the live-catalog interaction on step 2, citing the
   same reasoning — do NOT wire Functions-emulator plumbing as a side quest, do NOT
   silently skip. Navigating THROUGH step 2 (renders, empty-selection advances) is NOT
   gated by the fixme and IS covered for real. The Plex step 4 live PIN/discovery
   round-trip is device/network-dependent and out of e2e scope (same device-only
   treatment spec 0022 gives native FCM), but navigating INTO step 4 and using "Skip
   for now" to reach step 5 IS in e2e scope.
8. **Existing onboarding e2e flows must be updated, not replaced.** F-onboard-1
   (first-launch → `/onboarding`) still holds (now asserting step 1/region renders
   first); F-onboard-2 (complete → `/tabs/watchlist` + `users/{uid}` fields) must walk
   all 5 steps and extend its Firestore assertions to `myProviderIds` +
   `notificationPrefs` reflecting mid-wizard choices (not just `region`); F-onboard-3
   (flag pre-set → straight to tabs) is unaffected. Add new flows for back-navigation
   and the Plex-skip affordance (exact IDs in Test plan).
9. **No shared-domain type changes.** `User.region`, `User.myProviderIds`,
   `User.notificationPrefs` (all 3 booleans + `deliveryHour`), `User.hasPlex`,
   `User.plexSync`, `User.fcmTokens` all already exist in `@vultus/shared/domain` and
   are converter-backed in `@vultus/shared/firestore-schema` (used today by Settings).
   Onboarding reads/writes EXACTLY these fields via the same converters/paths. No
   `firestore.rules` change (the existing owner-only `users/{uid}` rule already covers
   every field) and no `firestore.indexes.json` change (every access is a single-doc
   get/set/update — no new query).
10. **Out of scope (explicit):** iOS; multi-device token rotation; the Settings page
    itself (this spec touches ONLY `libs/mobile/onboarding` + the onboarding e2e spec +
    `libs/mobile/onboarding/README.md`; `libs/mobile/settings/**` is NOT touched);
    analytics/A/B wizard variants; a NEW skip-all-onboarding affordance (only the one
    Plex-step skip from decision 4); any `apps/functions`/`scope:functions` change
    (pure client-side restructuring on data paths/tokens that already exist); a
    shared-lib extraction of any Settings logic (decision 5 forbids it at 2 slices).

## Scope

In scope:

- Rework `OnboardingPage` (`libs/mobile/onboarding/src/lib/onboarding.page.{ts,html,scss}`)
  into a 5-step wizard driven by a `currentStep` signal, with a step-progress
  indicator, per-step "Back" (steps 2-5) and a "Skip for now" on step 4 only.
- Extend the onboarding data-access so each step persists write-as-you-go to
  `users/{uid}`: region (create-with-defaults on first write), providers (via the
  root-provided `GET_WATCH_PROVIDERS` token + toggle/persist-whole-array), notification
  prefs (global toggle projection + delivery-hour setter), and the final push
  registration + completion flag (unchanged from spec 0022).
- A new **onboarding-owned Plex-link service** (its own class, injecting the
  root-provided `PLEX_CLIENT` token) implementing the step-4 subset of the PIN state
  machine (request code, countdown, poll, discover+persist-with-rollback, cancel/skip),
  plus a **copied** `plex-errors.ts` (`PlexHttpError`, `PlexPinGoneError`) so it can do
  the same `instanceof` discrimination.
- Update `onboarding.providers.mock.ts` (the `--configuration=mock` structural mock) so
  the wizard renders offline (no Firebase, no native plugins, no live callables).
- Update `libs/mobile/onboarding/README.md` to the new public surface + behaviour.
- Update the onboarding e2e spec (`apps/mobile-e2e/src/onboarding.spec.ts`) to the
  5-step flow + new flows (Test plan), including the step-2 live-catalog `test.fixme`.
- Unit + component tests for the new step logic and page.

Out of scope (see decision 10): iOS; multi-device token rotation; **any**
`libs/mobile/settings` change; the Settings page itself; analytics/A/B variants; a
skip-all-onboarding affordance; any `scope:functions`/Cloud Functions change; any Nx /
CI / Firebase-config / `sheriff.config.ts` change; any new root dependency (the
Capacitor plugins used here — `@capacitor/preferences`, `@capacitor/push-notifications`,
`@capacitor/core` — are all already installed from spec 0022/0020); `firestore.rules` /
`firestore.indexes.json` changes (existing owner-only `users/{uid}` rules already cover
every field; single-doc access only, no query); a `shared/` extraction of any Settings
logic.

## Affected slices & Sheriff tags

Single slice: `scope:mobile` / `slice:onboarding`. Verified against
`sheriff.config.ts` (tags are assigned by PATH GLOB `'libs/mobile/<slice>/src':
['scope:mobile', 'slice:<slice>']`, line 56 — `libs/mobile/onboarding/src` already
inherits `['scope:mobile', 'slice:onboarding']`; **this spec does NOT edit
`sheriff.config.ts`**).

| Project / area    | Path                                     | Sheriff tags                       | Change                                                                                                                            |
| ----------------- | ---------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| mobile-onboarding | `libs/mobile/onboarding`                 | `scope:mobile`, `slice:onboarding` | rework page → wizard; extend data-access; new onboarding-owned Plex-link service + copied `plex-errors.ts`; mock + README + tests |
| mobile-e2e        | `apps/mobile-e2e/src/onboarding.spec.ts` | (test project)                     | update flows for the 5-step wizard + new back-nav / Plex-skip flows + step-2 live-catalog `test.fixme`                            |

**Import boundaries (verified against the merged `sheriff.config.ts` `depRules`):**

- `slice:onboarding` may import `['scope:shared', sameTag]` only (line 85). It imports:
  - `@vultus/shared/domain` (`Region`/`REGIONS`/`User`/`FcmToken`/`CatalogProvider`/
    `PlexServer`), `@vultus/shared/domain/tokens` (`AUTH_UID`, **`GET_WATCH_PROVIDERS`**,
    **`PLEX_CLIENT`**), `@vultus/shared/firestore-schema` (`userPath`, `userToData`,
    `dataToUser`, `FcmTokenWriteData`, `UserReadData`) — **all `scope:shared`, allowed
    (rule 4).**
  - AngularFire `Firestore` and the `@capacitor/*` plugins (`Preferences`,
    `PushNotifications`, `Capacitor`) — third-party, not policed by Sheriff.
  - **NO import of `libs/mobile/settings`** (a different slice — forbidden). This is the
    crux of the spec: the reused capabilities come in as **`scope:shared` tokens**
    (`GET_WATCH_PROVIDERS`, `PLEX_CLIENT`), never as the settings classes.
- **Token vs class distinction (critical — see Risks):** `GET_WATCH_PROVIDERS` and
  `PLEX_CLIENT` are `scope:shared` `InjectionToken`s whose values are wired at the app
  ROOT (`app.config.ts`). Injecting a `scope:shared` token is a `scope:shared` edge —
  allowed. But `SettingsService` and `PlexLinkService` are **`slice:settings`-tagged
  classes** — even though they are `providedIn: 'root'` and resolvable from the root
  injector, importing the class SYMBOL (`import { PlexLinkService } from
'@vultus/mobile/settings'`) is a `slice:onboarding → slice:settings` edge that Sheriff
  rejects. Likewise `plex-errors.ts` is `slice:settings`-tagged and cannot be imported
  cross-slice, hence the copy.
- **No `shared/` extraction.** The provider/notification/Plex-link orchestration lives
  **inside** `slice:onboarding`, used by 2 slices (onboarding + settings), below the
  3+-slice rule (CLAUDE.md / PLAN §3). Only the shared **types + tokens + converters**
  are shared, and they already exist.
- **No `scope:functions` file touched. No `apps/mobile` change** (the tokens are already
  provided at root — no `app.config.ts` / `app.routes.ts` edit; the route + guard are
  unchanged).

## Data model touchpoints

PLAN §4 `users/{uid}` is the only document touched. **Every field already exists and
is converter-backed** (`@vultus/shared/domain` `User` + `@vultus/shared/firestore-schema`
`userPath`/`userToData`/`dataToUser`) — this spec **reuses** it, adds nothing. Note: the
PLAN §4 document snippet only enumerates `region`/`notificationPrefs`/`fcmTokens`/
`myProviderIds` — it predates specs 0061/0073 and was never updated with `hasPlex`/
`plexSync`. Both fields exist today on the real `User` type
(`libs/shared/domain/src/lib/documents.ts`); **treat the domain `User` type, not the
PLAN §4 snippet, as the field authority** for this spec (pre-existing PLAN drift, not
introduced here — out of scope to fix PLAN itself).

| PLAN §4 path                            | Access by this slice                  | Fields (all pre-existing, converter-backed)                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}`                           | **create / set** (step 1 first write) | `region: Region`; default `notificationPrefs: { episodeAired, movieAvailable, cameToPlatform } = true`, `deliveryHour: null`; `fcmTokens: []`; `myProviderIds: []`; `hasPlex: false` (create-with-defaults, `setDoc(..., { merge: true })`) |
| `users/{uid}`                           | **update** (steps 1-5)                | `region` (step 1 re-writes on back-nav); `myProviderIds` (step 2, whole array); `notificationPrefs` (step 3, whole object); `hasPlex` + `plexSync` (step 4, on link success only); `fcmTokens` (step 5, `arrayUnion` on granted+native)     |
| `users/{uid}/**`                        | **none**                              | watchlist / episodes / notifications subcollections untouched                                                                                                                                                                               |
| `title-cache/**`, `provider-catalog/**` | **none** (READ via callable)          | the region catalog is fetched through the `GET_WATCH_PROVIDERS` callable (server-side reads `provider-catalog/{region}`); the slice never reads it directly                                                                                 |

- **Region step create-with-defaults:** on first write, `setDoc(doc(firestore,
userPath(uid)), userToData({ region, notificationPrefs: {episodeAired:true,
movieAvailable:true, cameToPlatform:true, deliveryHour:null}, fcmTokens:[],
myProviderIds:[], hasPlex:false }), { merge:true })` — identical to today's spec-0022
  create. Onboarding remains the doc's normal creator.
- **Provider step:** `updateDoc(ref, { myProviderIds: next })` writing the whole
  `number[]` (same shape as `SettingsService.toggleProvider`).
- **Notification step:** `updateDoc(ref, { notificationPrefs: {episodeAired,
movieAvailable, cameToPlatform, deliveryHour} })` writing the whole object (same shape
  as `SettingsService.setNotificationsEnabled`/`setDeliveryHour`).
- **Plex step (link success only):** the onboarding-owned link service persists the
  X-Plex-Token to `Preferences` (`plex_token`, **never** Firestore, **never** logged —
  spec 0068/0073 security), then `updateDoc(ref, { hasPlex:true, plexSync:{linkedAt,
lastSyncAt, serverName} })`, rolling the token back if the Firestore write fails
  (discover-before-persist ordering invariant). On skip, no `hasPlex`/`plexSync` write.
- **Finish step (unchanged from spec 0022):** `arrayUnion` one `FcmToken` (as
  `FcmTokenWriteData`) on granted+native; then `Preferences.onboarding_done = 'true'`.
- **No `firestore.rules` change** — spec 0004's owner-only `users/{uid}` read/write rule
  already permits every field written here (all owner writes to the user's own doc). Do
  NOT edit `firestore.rules`.
- **No `firestore.indexes.json` change** — no query; single-doc get/set/update only.

## Public types / APIs

- **No new shared domain type, token, or converter.** `User`, `FcmToken`,
  `NotificationPrefs`, `Region`/`REGIONS`, `CatalogProvider`, `PlexServer` in
  `@vultus/shared/domain`; `AUTH_UID`, `GET_WATCH_PROVIDERS`, `PLEX_CLIENT` in
  `@vultus/shared/domain/tokens`; `userPath`/`userToData`/`dataToUser`/`FcmTokenWriteData`/
  `UserReadData` in `@vultus/shared/firestore-schema` — **all reused**.
- **Onboarding barrel surface (`libs/mobile/onboarding/src/index.ts`) is UNCHANGED:**
  `OnboardingPage`, `onboardingGuard`, `reverseOnboardingGuard` — same exports, same
  shapes, same `/onboarding` route wiring. The shell (`app.routes.ts`) needs NO edit.
- **New / changed internal (slice-private) surface** — not exported unless a test needs
  it (page-scoped orchestration; document whatever is exported in the README):
  - **Extended onboarding data-access** (extend `OnboardingService` or add a small
    sibling — implementer's call). Recommended (non-binding) shape:

    ```ts
    // Step state — the wizard's single source of truth.
    readonly currentStep: Signal<1 | 2 | 3 | 4 | 5>;
    next(): void;                 // advance (no-op past 5)
    back(): void;                 // retreat (no-op before 1); step 2-5 only in UI

    // Region (step 1). Creates users/{uid} with defaults on first write.
    readonly regions: readonly Region[];          // = REGIONS
    readonly region: Signal<Region | null>;
    setRegion(region: Region): Promise<void>;      // write-as-you-go + catalog reload+prune

    // My Providers (step 2) — reimplements the spec-0060 shape locally.
    readonly providerCatalog: Signal<CatalogProvider[]>;
    readonly myProviderIds: Signal<number[]>;
    readonly catalogLoading: Signal<boolean>;
    loadProviderCatalog(): Promise<void>;          // via GET_WATCH_PROVIDERS token
    toggleProvider(providerId: number): Promise<void>; // persist whole number[]

    // Notifications (step 3) — reimplements the spec-0011/0051 shape locally.
    readonly notificationsEnabled: Signal<boolean>;   // projection of the 3 booleans
    readonly deliveryHour: Signal<number | null>;
    readonly deliveryHours: readonly number[];        // 0..23
    setNotificationsEnabled(enabled: boolean): Promise<void>; // sets all 3 at once
    setDeliveryHour(hour: number | null): Promise<void>;

    // Finish (step 5) — unchanged from spec 0022.
    complete(): Promise<void>; // push permission + token (native/granted) then flag LAST
    ```

    **Binding:** each step persists to `users/{uid}` write-as-you-go (decision 2);
    `setRegion` re-triggers the catalog-reload-and-prune behaviour (see Risks — genuine
    coupling); `complete()` is the final step's push-request + `arrayUnion` + set
    `onboarding_done='true'` last; the slice never writes outside `users/{uid}`, never
    imports another slice, never imports `apps/mobile`.

  - **New onboarding-owned Plex-link service** (own class, e.g.
    `OnboardingPlexLinkService`) — injects `PLEX_CLIENT` + `AUTH_UID` + `Firestore`,
    NOT `PlexLinkService`. Mirrors the subset of `PlexLinkService`'s shape it needs,
    trimmed per decision 5. Recommended (non-binding):

    ```ts
    export type PlexLinkStage = 'idle' | 'code' | 'waiting' | 'connected' | 'error';
    export type PlexLinkErrorReason = 'expired' | 'no-server' | 'network';

    readonly stage: Signal<PlexLinkStage>;
    readonly errorReason: Signal<PlexLinkErrorReason | null>;
    readonly code: Signal<string | null>;
    readonly server: Signal<PlexServer | null>;
    readonly expiresInSeconds: Signal<number>;
    readonly countdown: Signal<string>;              // mm:ss
    requestCode(): Promise<void>;
    regenerateCode(): Promise<void>;
    cancel(): void;                                  // back to idle (also backs "Skip")
    // completeLink is internal: discover → persist token (Preferences) → write
    // hasPlex/plexSync → rollback token on Firestore failure (ordering invariant).
    ```

    It **omits** `unlink()`, `loadState()`, `isLinked()`, `linked`/`serverName`/
    `lastSyncAt` (Settings-only; nothing to unlink/load during first-launch onboarding).

  - **Copied `plex-errors.ts`** in `libs/mobile/onboarding/src/lib/` exporting
    `PlexHttpError`, `PlexPinGoneError` (verbatim copies of the spec-0073 module;
    dependency-free by original design). The onboarding link service imports THIS copy,
    not the `slice:settings` one.

## UI / Stitch screen refs

Mobile slice — UI fidelity is a contract (CLAUDE.md). Authoritative tokens live at
**`docs/design/vultus-design-system.md`** (wired into `shared/ui-kit` `theme.scss`);
**reference that file — do NOT reprint or hand-transcribe hex** (primary is `#4edea3`,
NOT `#10B981`). Consume the `--vultus-*` / `--ion-*` vars `theme.scss` exposes.

**Stitch capture status (this session, via the mandatory `get_screen`-metadata recipe —
`list_screens` on `projects/13590348714018893783`):** there is **NO dedicated
onboarding / wizard / welcome screen** in the project — confirmed, consistent with spec
0022's note (the project has Search, Watchlist, Advanced Watchlist, Movie Detail ×3,
Notifications, Splash, Settings, Settings-My Providers, Settings-Plex ×3, Connect Plex,
Media Tracker). **The individual step CONTENT, however, DOES have authoritative screens
that the implementer MUST pull and align each step to** (via `htmlCode.downloadUrl` →
raw GET, NOT WebFetch — CLAUDE.md recipe; grab `screenshot.downloadUrl` for a visual
compare):

- **Step 2 (My Providers grid):** Stitch screen **`cebdfd02c7d44023b0e0019dd4907d48`**
  ("Settings - My Providers - Vultus") + **`0e2bb1f198f04186b39e4a2604413417`**
  ("Settings - Plex Provider & Catalog Counter"). The in-repo, already-Stitch-aligned
  implementation is the settings provider grid (spec 0060/0061/0077) — mirror its
  structure (provider chips, selected state, catalog counter). Do NOT cross-slice-import
  it; replicate the markup/tokens.
- **Step 3 (notification controls):** Stitch screen **`81945ff3381e453dafcc4e5ce896fcfa`**
  ("Settings - Vultus") hosts the notifications global toggle + quiet-hours picker
  (specs 0011/0051). Mirror those control shapes. (Note: the "Notifications - Vultus"
  screen `505a6e4713c04b27a37a8c20a44aeccf` is the notifications INBOX, spec 0042 — NOT
  the settings controls; do not use it for this step.)
- **Step 4 (Plex link code/waiting/connected/error states):** Stitch screen
  **`398cde766832491e92e1c0c5cc09ab4e`** ("Connect Plex - Vultus", the spec-0073 source
  of truth). The in-repo `plex-connect.page.html` renders ONE stage from
  `PlexLinkService.stage` (`code`/`waiting` share a card; `error` has reason-specific
  copy; `connected` shows the server row). Mirror that stage structure for the
  onboarding step (adapted to the wizard chrome — a step body, not a pushed sub-page).
- **Step 1 (region) + step 5 (finish):** reuse the existing spec-0022 region `ion-select`
  - "Get started" CTA pattern (already in `onboarding.page.html`). The Splash screen
    `c0a785aff1d54cd59bd41a5fd5f10d3d` is the only welcome-framing reference for tone.

> **BLOCKING OPEN ITEM — the WIZARD CHROME has no Stitch screen.** The step-progress
> indicator ("Step N of 5"), the per-step "Back" control (steps 2-5), and the step-4
> "Skip for now" affordance have **no** corresponding Stitch design (no onboarding/wizard
> screen exists). Per CLAUDE.md ("MCP unreachable is a retry, not a permission to ship
> token-only UI" — but here the MCP IS reachable and the screen genuinely does not
> exist), the implementer:
>
> 1. MUST align each step's CONTENT to the screens listed above (pull raw HTML, record
>    the screen IDs used in the PR).
> 2. MUST build the wizard chrome to the concrete contract below using `--vultus-*`
>    tokens (no hard-coded hex), and **flag the wizard chrome `needs-human` for visual
>    verification** in the PR — exactly as spec 0022 flagged the whole onboarding page.
>    Do NOT invent a chrome design and claim fidelity off a green build.

**Concrete wizard-chrome contract (token refs via `docs/design/vultus-design-system.md`;
pin values there):**

- **Page chrome:** dark-first; `ion-content` background = `surface`/`background`. `Inter`
  must be **loaded as a web font** (shell loads it in `index.html`, spec 0010 — verify it
  applies; a named family stack without the loaded font silently falls back to system-ui).
- **Step-progress indicator:** a "Step N of 5" label (type role `label-sm` from the design
  scale, `on-surface-variant`) at the top of each step; optionally a segmented/progress
  bar in `primary` (`#4edea3`) for the completed portion. Top inset **`md` (16px)** on
  the 8px grid, matching the merged Settings page's card gutter — identical across all
  5 steps so the step content doesn't jump vertically when navigating.
- **Step body cards / controls:** aligned to the step's referenced Stitch screen above;
  cards in `surface-container`, radius `DEFAULT` (0.5rem), `md` (16px) gutters, all sibling
  controls sharing one left/right margin (aligned to the primary CTA's insets).
- **Nav controls (per-step):**
  - "Continue"/"Next" — full-width `ion-button` `expand="block"`, `primary` background
    with `on-primary` label, standard Ionic control height (do not shrink); disabled +
    busy (spinner) while the step's write is in flight so a double-tap can't double-fire.
  - "Back" (steps 2-5) — a secondary/`fill="clear"` control, left-aligned; moves the step
    signal back with the prior value still shown (data is persisted, decision 3).
  - "Skip for now" (step 4 ONLY) — a `fill="clear"`/text button; advances to step 5 with
    NO `hasPlex`/`plexSync` write and calls the link service's `cancel()` to stop any live
    poll. Absent on steps 1/2/3/5.
  - Step 5 "Get started" — the final CTA; disabled + busy while `complete()` runs (push
    prompt is async), then navigates to `/tabs/watchlist` with `{ replaceUrl: true }`
    (issue #65 — unchanged).
- **Interactive states (per-element acceptance list — tick each):**
  - **Step 1 region select:** default (`NL`), focus (popover open), disabled while
    `setRegion` in flight.
  - **Step 2 provider chips:** default, **selected** (primary accent + checkmark, per the
    My Providers screen), pressed/active, catalog-loading skeleton/spinner, disabled while
    a toggle write is in flight; empty selection is a valid completable state.
  - **Step 3 notification toggle + delivery-hour picker:** toggle on/off/focus/disabled;
    delivery-hour picker **disabled while the global toggle is off** (spec 0051 parity);
    "notifications off" is a valid completable state.
  - **Step 4 Plex link:** the four stages render one-at-a-time from the link service —
    `code`/`waiting` (code + mm:ss countdown + "Get a new code" + waiting spinner),
    `error` with reason-specific copy (`expired` / `no-server` / `network` — never all
    "expired"), `connected` (server row); plus the "Skip for now" affordance in every
    non-connected stage.
  - **Step 5 "Get started":** default, hover/active, disabled+busy while `complete()`
    runs, transition to `/tabs/watchlist` only after `complete()` resolves (no flash of
    tabs before the OS permission dialog on native).
  - **Back-nav transition:** moving between steps preserves each step's persisted value;
    no data loss, no re-fetch flicker except the intentional region-change catalog reload
    (Risks).

**Visual verification (CLAUDE.md): a green build does NOT prove the UI is right.** Render
the wizard under the `mock` serve profile (`pnpm nx run mobile:serve-mock`, bypassing the
onboarding gate per the serve-mock verification notes) and screenshot each step, or
explicitly flag the wizard-chrome unverified for a human eyeball in the PR (alongside the
recorded step-content Stitch screen IDs). The native push dialog + FCM token write + real
Plex PIN/LAN discovery are **device-only** — flag those paths device-only.

## Implementation task graph

All work is `scope:mobile` / `slice:onboarding` (frontend-engineer) — **no
backend-engineer or infrastructure-engineer task** (no Cloud Functions change, no
Nx/CI/Firebase-config change, no new dependency, no `sheriff.config.ts`/`app.config.ts`/
`app.routes.ts` edit). Most work is sequential within the single slice/page; the two
test tracks (lib specs vs the e2e spec) are file-disjoint and fan out in parallel.

1. **[sequential] Copy `plex-errors.ts` + build the onboarding-owned Plex-link service.**
   frontend-engineer. (Foundational for step 4; touches its own files.)
   - Copy `plex-errors.ts` verbatim into `libs/mobile/onboarding/src/lib/plex-errors.ts`
     (`PlexHttpError`, `PlexPinGoneError` — dependency-free).
   - Create `onboarding-plex-link.service.ts`: inject `PLEX_CLIENT` + `AUTH_UID` +
     `Firestore`; implement `requestCode`/`regenerateCode`/`cancel` + internal
     `completeLink` (discover → persist token to `Preferences` → write `hasPlex`/`plexSync`
     → rollback token on Firestore failure), the wall-clock countdown, and the poll loop
     with `instanceof PlexPinGoneError` → `'expired'` discrimination. Omit
     `unlink`/`loadState`/`isLinked` and the settings-card projection (decision 5).
   - Files: `libs/mobile/onboarding/src/lib/plex-errors.ts`,
     `libs/mobile/onboarding/src/lib/onboarding-plex-link.service.ts`.

2. **[sequential] Extend the onboarding data-access (region create + providers +
   notifications + step state). Depends on task 1: `onboarding.providers.ts` registers
   the `onboarding-plex-link.service.ts` class task 1 creates, so task 1 must land
   first — not a file-conflict serialization, a real class-registration dependency.**
   frontend-engineer.
   - Extend `OnboardingService` (or add a sibling): `currentStep` signal + `next`/`back`;
     `setRegion` (create-with-defaults on first write + catalog reload-and-prune — the
     spec-0060 `setRegion` coupling, Risks); `loadProviderCatalog`/`toggleProvider` via the
     injected `GET_WATCH_PROVIDERS` token; `setNotificationsEnabled`/`setDeliveryHour` +
     the `notificationsEnabled` projection; `complete()` (unchanged spec-0022 push +
     flag-last logic). Null-uid guard before every Firestore call.
   - Files: `libs/mobile/onboarding/src/lib/onboarding.service.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.providers.ts` (register the new link
     service if page-provided), `libs/mobile/onboarding/src/index.ts` (barrel — export
     only what tests/page need).

3. **[sequential] Rework `OnboardingPage` into the 5-step wizard + mock + README.
   Depends on tasks 1-2.** frontend-engineer.
   - `onboarding.page.{ts,html,scss}`: render one of 5 steps from `currentStep`, the
     step-progress indicator, per-step Back (2-5), step-4 "Skip for now", and each step's
     controls aligned to the referenced Stitch screens (UI section). Wire the injected
     Plex-link service into step 4.
   - `onboarding.providers.mock.ts`: extend the structural mock so all 5 steps render
     offline (mock catalog, mock notification state, mock Plex-link stages) under
     `--configuration=mock`.
   - Rewrite `libs/mobile/onboarding/README.md` to the new public surface + wizard
     behaviour + the write-as-you-go model + Sheriff tags + the token-vs-class note (no
     leftover scaffold; CLAUDE.md lib-README rule).
   - **Pull + record the step-content Stitch screen IDs**; flag the wizard chrome
     `needs-human` (UI section).
   - Files: `libs/mobile/onboarding/src/lib/onboarding.page.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.page.html`,
     `libs/mobile/onboarding/src/lib/onboarding.page.scss`,
     `libs/mobile/onboarding/src/lib/onboarding.providers.mock.ts`,
     `libs/mobile/onboarding/README.md`.

4. **[parallel] Unit + component tests. Depends on tasks 1-3.** frontend-engineer /
   qa-runner.
   - Service unit tests (step writes, region-change prune, notification projection,
     null-uid guard, complete()), Plex-link service unit tests (stage machine, ordering
     invariant, rollback, error-reason discrimination), and the page component test
     (5-step render, back-nav, step-4 skip). Guard tests unchanged (no guard change) —
     add only if touched.
   - **File manifest: `libs/mobile/onboarding/src/lib/**/\*.spec.ts`** — concretely
`onboarding.service.spec.ts`, `onboarding-plex-link.service.spec.ts`,
`onboarding.page.spec.ts`. Disjoint from task 5 (`apps/mobile-e2e/src/\*\*`).

5. **[parallel] Update the onboarding e2e spec. Depends on tasks 1-3 (the wizard must be
   wired so the flows can run).** frontend-engineer / qa-runner.
   - Update `apps/mobile-e2e/src/onboarding.spec.ts` to the 5-step flow (decision 8) +
     new flows (Test plan) + the step-2 live-catalog `test.fixme` (decision 7).
   - **File manifest: `apps/mobile-e2e/src/onboarding.spec.ts`** (this one file only).
     Disjoint from task 4 (`libs/mobile/onboarding/**/*.spec.ts`) and tasks 1-3.

(All slice code is under `libs/mobile/onboarding/**`; the only file outside it is
`apps/mobile-e2e/src/onboarding.spec.ts` (task 5). No `sheriff.config.ts`,
`app.config.ts`, `app.routes.ts`, `firestore.rules`, `firestore.indexes.json`,
`libs/mobile/settings`, `package.json`, or `scope:functions` file is touched. The two
parallel manifests — `libs/mobile/onboarding/src/lib/**/*.spec.ts` (task 4) and
`apps/mobile-e2e/src/onboarding.spec.ts` (task 5) — are disjoint.)

## Test plan

Per the PLAN §5 pyramid: focused **unit** tests (the reimplemented step logic + the
Plex-link state machine), a **component** test (the wizard page), and updated **e2e**
flows. All Firebase + native-plugin + callable access is **mocked** in unit/component
(no live Firebase, no network, no native runtime, no secrets).

**Unit — `onboarding.service.spec.ts`** (Vitest; mocked `Firestore`, `AUTH_UID` signal,
`GET_WATCH_PROVIDERS` thunk, `@capacitor/*`):

- **Region create-with-defaults:** first `setRegion('DE')` writes `users/{uid}` (via
  `userToData`) with `region:'DE'`, all `notificationPrefs` true + `deliveryHour:null`,
  `fcmTokens:[]`, `myProviderIds:[]`, `hasPlex:false`, targeting `userPath(uid)`.
- **Providers toggle persists the whole array:** `toggleProvider(8)` then
  `toggleProvider(15)` → `updateDoc(..., { myProviderIds:[8,15] })`; re-toggling 8
  removes it → `[15]`.
- **Region-change prune coupling (Risks):** after selecting providers, a `setRegion` to a
  region whose catalog omits some selected ids drops exactly those ids and persists the
  pruned array; on a catalog-load failure the prune is SKIPPED (list preserved).
- **Notification projection + writes:** `setNotificationsEnabled(false)` sets all three
  booleans false while preserving `deliveryHour`; `setDeliveryHour(9)` preserves the three
  booleans and sets `deliveryHour:9`; `notificationsEnabled` reads true iff all three true.
- **`complete()` (spec-0022 parity):** web/non-native skips push but still sets the flag;
  native+granted `arrayUnion`s one `FcmTokenWriteData`; native+denied and push-error both
  proceed without throwing; `onboarding_done='true'` is the LAST write in every case.
- **Null-uid guard:** with `AUTH_UID() === null` no Firestore call fires on any step.
- **No write outside `users/{uid}`.**

**Unit — `onboarding-plex-link.service.spec.ts`** (mocked `PLEX_CLIENT`, `Firestore`,
`Preferences`):

- `requestCode` → `code` then `waiting`; poll returning an authToken → discover → persist
  token → write `hasPlex`/`plexSync` → `connected`.
- **Ordering invariant:** token persisted only AFTER a non-null server; discovery
  returning `null` → `error`/`no-server` and NO token, NO Firestore write.
- **Rollback:** Firestore write failure after token persist → token removed from
  `Preferences`, stage `error`/`network`.
- **Error discrimination:** a thrown `PlexPinGoneError` → `error`/`expired` immediately;
  transient transport errors tolerated up to the failure cap then `network`.
- **`cancel()`** stops timers and returns to `idle` (also backs the "Skip for now" path).
- Token value is never logged/echoed (spec 0068/0073).

**Component — `onboarding.page.spec.ts`** (Angular TestBed + Ionic; service + link
service + `Router` mocked):

- Renders step 1 (region select) first with the "Step 1 of 5" indicator; no Back on step 1.
- Advancing renders steps 2→3→4→5 in order; the progress indicator updates.
- **Back-nav** from step 2 returns to step 1 with the previously-picked region still shown.
- **Step-4 "Skip for now"** advances to step 5 and triggers NO `hasPlex`/`plexSync` write
  (asserts the link service's `cancel()` is called and no persist runs).
- Step 5 "Get started" calls `complete()` once and, on resolve, navigates to
  `/tabs/watchlist` with `{ replaceUrl: true }`; disabled while in flight (no double-fire).
- **Rendered-text assertions use the EXACT string** (e.g. the progress label
  `toHaveText('Step 2 of 5')`, a provider pill `/^On Netflix$/` if asserted) — do NOT
  whitespace-normalize before asserting; keep component and e2e assertions consistent on
  the same copy.

**e2e — `apps/mobile-e2e/src/onboarding.spec.ts`** (Playwright, emulator-backed; the
`CapacitorStorage.onboarding_done` localStorage-fallback convention from spec 0022).
Per the decision-7 rubric, `scope:mobile` primary-nav/critical-action work → e2e
**required**; flows:

- **F-onboard-1** (unchanged intent, updated assertion): first launch (no flag) → URL
  `/onboarding`; **step 1 (region select) + the "Step 1 of 5" progress indicator render
  first**; no tab bar.
- **F-onboard-2** (rewritten for 5 steps): pick region **"DE"** → step 2 (make a provider
  selection or continue with an empty selection — navigation-only, NOT gated by the
  step-2 fixme) → step 3 (set notification prefs, e.g. toggle off or set a delivery hour)
  → step 4 (tap **"Skip for now"**) → step 5 ("Get started") → URL `/tabs/watchlist`;
  assert `users/{uid}` in the emulator reflects the mid-wizard choices: `region:'DE'`,
  `myProviderIds` matching the step-2 selection (e.g. `[]` if none), and
  `notificationPrefs` matching the step-3 choice; `CapacitorStorage.onboarding_done =
'true'`. (Native FCM permission dialog + token write are device-only — NOT asserted.)
- **F-onboard-3** (unchanged): flag pre-set → boot lands on `/tabs/watchlist` directly, no
  redirect, tab bar renders.
- **F-onboard-4 (new — back navigation):** from step 2, tap "Back" → step 1; the
  previously-picked region is still selected/shown (persisted-state check, decision 3).
- **F-onboard-5 (new — Plex skip):** reach step 4, tap "Skip for now" → step 5; complete;
  assert `users/{uid}` has NO `hasPlex:true` / NO `plexSync` written by the wizard (the
  skip path performs no Plex write). (Landing on `/tabs/watchlist` after finish.)
- **`test.fixme` (decision 7 — the ONE known gap):** the step-2 **live catalog** round-trip
  (asserting real provider chips loaded from `GET_WATCH_PROVIDERS` and toggling one
  persists to `myProviderIds`) is `test.fixme`, with a comment citing the SAME
  Functions-emulator-runtime gap as `provider-preferences.spec.ts` /
  `manual-sync-trigger.spec.ts`. Do NOT wire Functions-emulator plumbing here. Navigation
  THROUGH step 2 (F-onboard-2) is covered for real and is NOT gated by this fixme.
- **Step-4 live PIN/discovery** round-trip is device/network-dependent → out of e2e scope
  (device-only, like spec 0022's native FCM); only navigating INTO step 4 + the "Skip for
  now" affordance (F-onboard-5) are exercised.

The `mock`-profile manual smoke (render each step, confirm nav) is encouraged for visual
verification; the native push dialog + token write + real Plex PIN/LAN discovery remain
device-only / human-verified.

## Definition of done

Tailored from PLAN §5. CI green gate is **lint/Sheriff + typecheck + unit + component +
build + e2e**. **There is NO `firestore.rules`, `firestore.indexes.json`, or rules-test
item in this DoD — none change** (decision 9: every field written already exists under the
owner-only `users/{uid}` rule; all access is single-doc, no query), so a reviewer should
NOT go looking for one. Every checkbox maps to a task (cross-check below).

- [ ] `pnpm nx run-many -t lint test -p mobile-onboarding` passes **with Sheriff active**:
      the slice imports only `@vultus/shared/*` (incl. the `GET_WATCH_PROVIDERS` +
      `PLEX_CLIENT` + `AUTH_UID` `scope:shared` tokens) + third-party — **no
      `libs/mobile/settings` import, no `apps/mobile` import, no `scope:functions`
      import**. (Tasks 1-4.)
- [ ] `pnpm nx typecheck mobile-onboarding` passes — the extended service, the new
      Plex-link service, the copied `plex-errors.ts`, and the wizard page compile. (Tasks
      1-3.)
- [ ] `pnpm nx build mobile` passes (production config) — the reworked page lazy-loads
      cleanly; the barrel surface (`OnboardingPage`/`onboardingGuard`/
      `reverseOnboardingGuard`) is unchanged so the shell route still resolves. (Task 3.)
- [ ] `pnpm nx affected -t lint test build --base=main` is green (mirrors CI). (Tasks 1-5.)
- [ ] **Unit tests** cover: region create-with-defaults, provider toggle + region-change
      prune, notification projection + writes, `complete()` push/flag-last parity,
      null-uid guard, and the Plex-link state machine (ordering invariant, rollback, error
      discrimination). (Task 4.)
- [ ] **Component test** asserts the 5-step render + progress indicator, back-nav preserves
      the prior value, step-4 skip performs no Plex write, and "Get started" completes +
      navigates once. Rendered-text assertions use exact strings (no whitespace
      normalization). (Task 4.)
- [ ] **e2e:** `apps/mobile-e2e/src/onboarding.spec.ts` has F-onboard-1..5 green
      (first-launch → step 1; walk all 5 steps → `/tabs/watchlist` + `users/{uid}`
      reflecting region + `myProviderIds` + `notificationPrefs`; flag pre-set → tabs;
      back-nav preserves region; Plex-skip performs no Plex write) and the step-2
      live-catalog interaction is `test.fixme` with the Functions-emulator-gap comment. All
      pre-existing e2e flows in other specs remain green. (Task 5.)
- [ ] `libs/mobile/onboarding/README.md` states the new public surface + wizard behaviour +
      write-as-you-go model + Sheriff tags + the token-vs-class note — no leftover scaffold.
      (Task 3.)
- [ ] **`sheriff.config.ts`, `apps/mobile/src/app/app.config.ts`,
      `apps/mobile/src/app/app.routes.ts`, `firestore.rules`, `firestore.indexes.json`,
      `libs/mobile/settings`, `package.json`, and any `scope:functions` file are NOT
      modified** (path-glob tagging + already-provided root tokens + owner-only rules +
      already-installed deps cover this slice). (All tasks — guardrail.)
- [ ] **Guardrail verifications (review-checked):** (a) every Firestore write targets
      `users/{uid}` — no subcollection, no other slice's data; (b) each step persists
      write-as-you-go and `onboarding_done='true'` is the LAST write of the whole wizard;
      (c) the Plex X-Plex-Token is persisted ONLY to `Preferences` (never Firestore, never
      logged), discover-before-persist with rollback; (d) the push flow is
      `isNativePlatform()`-guarded and a denied/failed prompt never blocks completion; (e)
      the reused provider/Plex/notification capabilities come in via `scope:shared` TOKENS,
      never a `slice:settings` class/module import; (f) no secret read/written. (Tasks 1-3;
      review.)
- [ ] PR records: the step-content **Stitch screen IDs** used (My Providers
      `cebdfd02c7d44023b0e0019dd4907d48`, Settings notification controls
      `81945ff3381e453dafcc4e5ce896fcfa`, Connect Plex `398cde766832491e92e1c0c5cc09ab4e`) + the **wizard-chrome `needs-human`** visual-verification status (or `mock`-render
      screenshots), the e2e result (F-onboard-1..5 + the step-2 fixme), and that the native
      FCM + real Plex PIN/LAN paths are device-only (not CI gates). (Task 3 + reviewer.)

### DoD ⇄ task-manifest cross-check

Every DoD checkbox maps to an owning task: lint/test/typecheck/build → tasks 1-4 (slice
files); component/unit tests → task 4 (`libs/mobile/onboarding/src/lib/**/*.spec.ts`);
e2e → task 5 (`apps/mobile-e2e/src/onboarding.spec.ts`); README → task 3
(`libs/mobile/onboarding/README.md`); guardrails/PR-record → tasks 1-3 + reviewer. **No
orphan requirement.** Explicitly: there is NO `firestore.rules` / `firestore.indexes.json`
/ rules-test file in any manifest **because none change** (decision 9) — this absence is
intentional, not an omission.

## Risks

- **Sheriff boundary — the token-vs-class distinction is easy to get wrong.**
  `GET_WATCH_PROVIDERS` and `PLEX_CLIENT` are `scope:shared` `InjectionToken`s (values
  wired at the app root in `app.config.ts`), so `inject(PLEX_CLIENT)` from
  `slice:onboarding` is a `scope:shared` edge — **allowed, no new wiring**. But
  `SettingsService`/`PlexLinkService`/`plex-errors.ts` are **`slice:settings`-tagged**;
  importing any of those SYMBOLS is a `slice:onboarding → slice:settings` edge Sheriff
  rejects, even though the classes are `providedIn:'root'` and resolvable from the root
  injector. Mitigation: onboarding injects only the tokens, reimplements the orchestration
  locally, and **copies** `plex-errors.ts` (its dependency-free-by-design shape, spec 0073,
  makes the copy trivial). The implementer must NOT "just import PlexLinkService because
  it's root-provided" — that green-runtime path is a red Sheriff lint.
- **Write-as-you-go vs batch (decision 2) — partial-completion-then-app-kill is now SAFER,
  not riskier.** Under spec 0022, a kill before "Get started" left NO user doc. Now each
  step persists immediately, so a kill mid-wizard leaves a valid partial `users/{uid}`
  (e.g. region + providers set, notifications not yet). Because `onboarding_done` is still
  the LAST write, the guard re-runs the wizard on next launch — and each step's
  create-with-`{merge:true}` / whole-array / whole-object write is idempotent, so re-walking
  simply re-affirms the persisted values. No half-written `notificationPrefs` (it's written
  as one object) and no half-written `myProviderIds` (whole array). This is a net
  improvement; flag it so a reviewer doesn't mistake the new intermediate writes for a bug.
- **Back-nav re-fires the step's write, and region↔providers is a GENUINE coupling
  (decision 3).** Going back and changing an earlier choice re-fires that step's persist; it
  does NOT need to invalidate later steps' already-persisted choices — EXCEPT the real
  coupling `SettingsService.setRegion` already has: changing the region on step 1 AFTER
  having picked providers on step 2 must re-trigger the SAME catalog-reload-and-prune (drop
  any `myProviderIds` absent from the new region's catalog, persist the pruned array, and
  skip the prune on a catalog-load failure to avoid destroying the list). The onboarding
  `setRegion` MUST replicate this behaviour (it's tested). Other back-edits (e.g. changing
  notifications) have no cross-step coupling. Flag precisely so the implementer handles the
  region-prune case and does not over-invalidate.
- **e2e fixme carry-forward (decision 7).** The step-2 live-catalog round-trip stays
  `test.fixme` for the SAME reason specs 0060/0077 do (no Functions-emulator runtime for
  `getWatchProviders` in the Playwright harness). This is a pre-existing harness gap, not a
  regression; do NOT add emulator-functions plumbing as a side quest. Navigation through
  step 2 is covered for real.
- **Duplication is intentional (2 slices < 3+).** The provider/notification/Plex-link logic
  now exists in BOTH `slice:settings` and `slice:onboarding`. Per CLAUDE.md / PLAN §3 this
  is correct at 2 slices — do NOT extract to `shared/`. If a THIRD consumer ever appears,
  that is the trigger to reconsider (a future spec), not now. Note the
  `shared-optional-field-toEqual` memory: no shared/domain field is added here, so no
  `nx affected -t test` ripple into settings/onboarding write-payload assertions is
  expected — but the implementer should still run `nx affected` (task-graph DoD) to confirm.
- **Native/device-only paths (project memory: emulator-tooling-limitation).** The OS push
  permission dialog + FCM token write and the REAL Plex PIN/LAN discovery cannot run under
  Claude Code tools or in the Playwright harness — they are device-only / human-verified,
  flagged in the PR; unit/component tests mock the plugins + the `PLEX_CLIENT` (the mock
  client already exists for non-native).
- **No PLAN conflict.** This extends PLAN §6 item 22 (first-run setup) on the PLAN §4
  `users/{uid}` shape and the spec-0010 DI contract, reusing existing `scope:shared` tokens
  and converters. No new architecture, no cross-slice import, no data shape outside §4.
