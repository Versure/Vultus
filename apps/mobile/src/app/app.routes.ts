import { Route } from '@angular/router';
import {
  onboardingGuard,
  reverseOnboardingGuard,
} from '@vultus/mobile/onboarding';

/**
 * App routes (spec 0010 + 0022 + 0083): the tabs shell is the root; Watch Today
 * is the default landing tab (spec 0083, D1). Each child route lazy-loads its
 * slice's page through the slice barrel (`@vultus/mobile/<slice>`). The
 * `onboardingGuard` on `tabs` redirects first-launch users to `/onboarding`
 * until the Preferences flag is set (spec 0022). Conversely,
 * `reverseOnboardingGuard` on `/onboarding` redirects already-onboarded users
 * back to `/tabs/today`, so the Android hardware back button can't strand them
 * on the onboarding page (issue #65).
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
        path: 'today',
        loadComponent: () =>
          import('@vultus/mobile/today').then((m) => m.TodayPage),
      },
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
      {
        // Pushed (not a tab) in-app notifications inbox (spec 0042). Reached from
        // the watchlist header bell via ['tabs','notifications']; nested under
        // `tabs` so the tab bar stays visible.
        path: 'notifications',
        loadComponent: () =>
          import('@vultus/mobile/notifications').then(
            (m) => m.NotificationsPage,
          ),
      },
      {
        // Pushed (not a tab) Connect Plex sub-page (spec 0073). Reached from the
        // Settings Plex Server card's disconnected row via
        // ['tabs','settings','plex']; nested under `tabs` to preserve the tab
        // context, but the page renders WITHOUT the bottom nav (it has its own
        // header, per the Stitch screen 398cde76…).
        path: 'settings/plex',
        loadComponent: () =>
          import('@vultus/mobile/settings').then((m) => m.PlexConnectPage),
      },
      { path: '', redirectTo: 'today', pathMatch: 'full' },
    ],
  },
  { path: '', redirectTo: 'tabs/today', pathMatch: 'full' },
];
