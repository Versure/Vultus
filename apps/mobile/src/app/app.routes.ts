import { Route } from '@angular/router';
import {
  onboardingGuard,
  reverseOnboardingGuard,
} from '@vultus/mobile/onboarding';

/**
 * App routes (spec 0010 + 0022): the tabs shell is the root; Watchlist is the
 * default landing tab. Each child route lazy-loads its slice's page through the
 * slice barrel (`@vultus/mobile/<slice>`). The `onboardingGuard` on `tabs`
 * redirects first-launch users to `/onboarding` until the Preferences flag is
 * set (spec 0022). Conversely, `reverseOnboardingGuard` on `/onboarding`
 * redirects already-onboarded users back to `/tabs/watchlist`, so the Android
 * hardware back button can't strand them on the onboarding page (issue #65).
 */
export const appRoutes: Route[] = [
  {
    path: 'onboarding',
    canActivate: [reverseOnboardingGuard],
    loadComponent: () =>
      import('@vultus/mobile/onboarding').then((m) => m.OnboardingPage),
  },
  {
    path: 'tabs',
    canActivate: [onboardingGuard],
    loadComponent: () => import('./tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'watchlist',
        loadComponent: () =>
          import('@vultus/mobile/watchlist').then((m) => m.WatchlistPage),
      },
      {
        path: 'search',
        loadComponent: () =>
          import('@vultus/mobile/search').then((m) => m.SearchPage),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('@vultus/mobile/settings').then((m) => m.SettingsPage),
      },
      {
        // Pushed (not a tab) per-title detail page (spec 0016). Reached from the
        // watchlist (0014) and search (0013) via ['tabs','title-detail', titleId];
        // nested under `tabs` so the tab bar stays visible.
        path: 'title-detail/:titleId',
        loadComponent: () =>
          import('@vultus/mobile/title-detail').then((m) => m.TitleDetailPage),
      },
      { path: '', redirectTo: 'watchlist', pathMatch: 'full' },
    ],
  },
  { path: '', redirectTo: 'tabs/watchlist', pathMatch: 'full' },
];
