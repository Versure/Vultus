import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { Preferences } from '@capacitor/preferences';

/**
 * Preferences key that records first-launch onboarding completion. Persisted as
 * the string `'true'` once the user finishes the onboarding flow.
 */
export const ONBOARDING_DONE_KEY = 'onboarding_done';

/**
 * Route guard for the tabs shell (spec 0022): allows entry only once onboarding
 * has completed (the `onboarding_done` Preferences flag is `'true'`), otherwise
 * redirects to `/onboarding`.
 *
 * SHERIFF: scope:mobile / slice:onboarding. Uses only `@capacitor/preferences`
 * (third-party) and `@angular/router`; no cross-slice imports.
 */
export const onboardingGuard: CanActivateFn = async () => {
  // `inject()` must run synchronously while the guard's injection context is
  // active — capture the Router BEFORE the first await (the context is gone by
  // the time the Preferences promise resolves).
  const router = inject(Router);
  const { value } = await Preferences.get({ key: ONBOARDING_DONE_KEY });
  if (value === 'true') {
    return true;
  }
  return router.createUrlTree(['/onboarding']);
};

/**
 * Reverse guard for the `/onboarding` route (issue #65): once onboarding has
 * completed (the `onboarding_done` Preferences flag is `'true'`), re-entry to
 * `/onboarding` is blocked and the user is redirected to `/tabs/today`.
 * This prevents the Android hardware back button from landing on the (now
 * stuck) onboarding page after the flow is done.
 *
 * SHERIFF: scope:mobile / slice:onboarding. Uses only `@capacitor/preferences`
 * (third-party) and `@angular/router`; no cross-slice imports.
 */
export const reverseOnboardingGuard: CanActivateFn = async () => {
  // Capture the Router synchronously before the first await — the injection
  // context is gone once the Preferences promise resolves.
  const router = inject(Router);
  const { value } = await Preferences.get({ key: ONBOARDING_DONE_KEY });
  if (value === 'true') {
    return router.createUrlTree(['/tabs/today']);
  }
  return true;
};
