import { Route } from '@angular/router';

/**
 * App routes (spec 0010): the tabs shell is the root; Watchlist is the default
 * landing tab. Each child route lazy-loads its slice's page through the slice
 * barrel (`@vultus/mobile/<slice>`).
 */
export const appRoutes: Route[] = [
  {
    path: 'tabs',
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
      { path: '', redirectTo: 'watchlist', pathMatch: 'full' },
    ],
  },
  { path: '', redirectTo: 'tabs/watchlist', pathMatch: 'full' },
];
