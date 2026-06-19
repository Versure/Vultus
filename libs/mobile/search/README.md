# mobile-search

The **Search** tab slice of the Vultus mobile app. It owns the UI, state, data
access, and types for searching movies and shows (TMDB) and adding results to the
watchlist. Today it is a **stub**: a single placeholder Ionic page wired into the
tabs shell so later work (PLAN §6 item 17) fleshes out an already-tagged,
already-routed lib.

## Public surface

The barrel (`@vultus/mobile/search`) exports:

- **`SearchPage`** — the standalone Ionic page component for the Search tab.

## Usage

The tabs shell in `apps/mobile` lazy-loads the page through the barrel:

```ts
{
  path: 'search',
  loadComponent: () =>
    import('@vultus/mobile/search').then((m) => m.SearchPage),
}
```

The page is a presentational placeholder for now; search logic, state, and the
TMDB/data layer arrive with the search feature spec.

## Sheriff scope / slice boundaries

Tags (by path glob in `sheriff.config.ts`): **`scope:mobile`**, **`slice:search`**.

This lib may import **only `scope:shared`** (e.g. `@vultus/shared/ui-kit`,
`@vultus/shared/domain`) and its **own slice**, plus third-party packages
(`@ionic/*`, `@angular/*`). It must **never** import another slice
(`slice:watchlist` / `slice:settings`) or anything in `scope:functions` — slices
communicate only through `scope:shared`.
