# mobile-watchlist

The **Watchlist** tab slice — a `scope:mobile` vertical slice owning the
watchlist tab's UI, state, data, and types. At this point it is a **stub**: a
single placeholder Ionic page seeded by the app-shell spec (0010) so the tabs
shell has a routable, already-tagged lib to fill in later (the real list / swipe
/ pull-to-refresh feature is PLAN §6 item 18).

## Public surface (barrel `@vultus/mobile/watchlist`)

- **`WatchlistPage`** — a standalone Ionic page component (selector
  `lib-watchlist`) rendering the Watchlist tab.

## Usage

Lazy-loaded by the `apps/mobile` tabs shell as the **default** landing tab:

```ts
{
  path: 'watchlist',
  loadComponent: () =>
    import('@vultus/mobile/watchlist').then((m) => m.WatchlistPage),
}
```

## Boundaries (Sheriff)

- Tags: **`scope:mobile`**, **`slice:watchlist`** (applied by path glob in
  `sheriff.config.ts`, not `project.json`).
- May import **`scope:shared`** (e.g. `@vultus/shared/ui-kit`,
  `@vultus/shared/domain`) and its **own slice** only — never another slice and
  never `scope:functions`. Third-party imports (`@ionic/*`, `@angular/fire`,
  `firebase`, `ionicons`) are not policed by Sheriff.
