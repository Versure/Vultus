# @vultus/mobile/onboarding

First-launch onboarding slice for the Vultus mobile app (spec 0022). It gates
the tabs shell behind a one-time onboarding flow: until the `onboarding_done`
Capacitor Preferences flag is set to `'true'`, the guard redirects into the
onboarding page where the user picks a content region, sees the
push-notification explainer, and taps **Get started** to enter the app.

## Public surface (barrel)

- **`OnboardingPage`** — standalone Ionic page (`selector: lib-onboarding`). A
  header-less, full-screen page: welcome header, region `ion-select`,
  push-permission explainer, and a primary "Get started" CTA. Registered as the
  `/onboarding` route by the shell.
- **`onboardingGuard`** — a `CanActivateFn` for the tabs route. Returns `true`
  when the `onboarding_done` Preferences flag is `'true'`, otherwise returns a
  `UrlTree` redirect to `/onboarding`.
- **`reverseOnboardingGuard`** — a `CanActivateFn` for the `/onboarding` route
  (issue #65). The inverse of `onboardingGuard`: returns a `UrlTree` redirect to
  `/tabs/watchlist` when the `onboarding_done` flag is `'true'` (onboarding is
  already complete), otherwise returns `true` to allow the onboarding page.

`ONBOARDING_DONE_KEY` (the Preferences key) is exported from
`onboarding.guard.ts` for the service; it is not part of the public barrel.

## Behavior

`OnboardingService.complete(region)`:

1. No-ops if there is no signed-in uid (null `AUTH_UID()`) — never touches
   Firestore or sets the flag on a null path.
2. Writes `users/{uid}` via `setDoc(..., { merge: true })` with the chosen
   region and default `notificationPrefs` (all three `true`) and an empty
   `fcmTokens` — `merge` so an existing doc's `fcmTokens` are not clobbered.
3. On a native platform only (`Capacitor.isNativePlatform()`): requests push
   permission, and on grant registers for FCM, awaits the one-shot
   `registration` event, and appends the device token to `fcmTokens` via
   `arrayUnion`. This branch is best-effort — **any** push error is swallowed
   and never blocks onboarding.
4. Sets the `onboarding_done` Preferences flag to `'true'` **last**, regardless
   of the push outcome.

The page sets a loading state during `complete()`, ignores double-taps while in
flight, and navigates to `/tabs/watchlist` on completion (and also on an
unexpected error, re-enabling the button). Both exit paths navigate with
`{ replaceUrl: true }`, which drops `/onboarding` from the Angular/Ionic history
stack so the Android hardware back button can't return to it (issue #65). In
tandem, the `/onboarding` route is protected by `reverseOnboardingGuard`, which
redirects already-onboarded users to `/tabs/watchlist` should they ever reach
the route again.

A `mock` build-profile replacement (`onboarding.providers.mock.ts`) supplies a
no-Firebase / no-native structural mock for the `--configuration=mock` serve
target.

## Design / visual verification

There is **no Stitch screen for onboarding** in the project
(`projects/13590348714018893783` has Settings, Movie Detail, Splash, Search,
Watchlist, and a Media Tracker screen only). The page is therefore built to the
spec's concrete UI contract using the shared `--vultus-*` / `--ion-*` theme
vars (no hard-coded hex). **It is flagged for human visual verification** — the
layout/typography were not pinned against a rendered design.

## Sheriff boundaries

Tags: `scope:mobile` + `slice:onboarding` (from the path glob). May import only
`@vultus/shared/*` and third-party packages — **no cross-slice imports**. The
uid is obtained via the `scope:shared` `AUTH_UID` injection token from
`@vultus/shared/domain/tokens`; the slice never imports `apps/mobile`.
