import { SheriffConfig, sameTag } from '@softarc/sheriff-core';

/**
 * Vultus module-boundary contract — the single source of truth for every
 * scope/slice tag and the import rules between them (PLAN §3, CLAUDE.md).
 *
 * Tags are assigned here by PATH GLOB, never via Nx `project.json` `tags`. That
 * keeps tagging declarative and makes future slice libs under `libs/mobile/*`
 * and `libs/functions/*` inherit the correct `scope:` tag automatically the
 * moment they are generated.
 *
 * Scope tags
 *   scope:mobile     apps/mobile      + libs/mobile/*
 *   scope:functions  apps/functions   + libs/functions/*
 *   scope:shared     libs/shared/*    (importable by anyone)
 *
 * Slice-tag vocabulary. The mobile tab slices below are now in use (spec 0010
 * generated libs/mobile/{watchlist,search,settings}); the remaining tags are
 * declared ahead of the libs that will carry them in their own specs:
 *   slice:watchlist  slice:search  slice:settings   (in use — libs/mobile/*)
 *   slice:title-detail                               (pushed later, not a tab)
 *   slice:sync-titles  slice:dispatch-notifications  (functions slices)
 *
 * Boundary rules (PLAN §3 "Rules"):
 *   1. scope:mobile cannot import scope:functions, and vice versa.
 *   2. A slice cannot import a different slice; slices talk only via scope:shared.
 *   3. apps/* may import scope:shared and slices within their own scope only.
 *   4. Anything may import scope:shared.
 */
export const config: SheriffConfig = {
  version: 1,
  // Barrel-less: every folder matched below is a module regardless of whether
  // it has an index.ts. The app folders and the negative-test fixture have no
  // barrel, so this is required for them to be tagged and checked.
  enableBarrelLess: true,
  // The negative-test fixture lives in `tools/sheriff-fixtures` and deliberately
  // breaks rule 1. Sheriff still tags/evaluates it (so the programmatic ESLint
  // test sees the violation), but it is excluded from every production lint and
  // build target, so default `nx lint` / `nx build` stay green.
  modules: {
    'apps/mobile': 'scope:mobile',
    'apps/functions': 'scope:functions',

    // Libs expose their public API through a `src/index.ts` barrel. With
    // enableBarrelLess that barrel folder is itself a module, so the
    // scope/slice tag must be applied to `.../src` (not the lib root) for a
    // runtime (value) cross-module import of the barrel — e.g. the app's lazy
    // `import('@vultus/mobile/watchlist')` — to resolve to a *tagged* module
    // rather than an untagged `src`. (Type-only imports are elided and never
    // policed, which is why this only surfaced with the first runtime import.)
    'libs/shared/<name>/src': 'scope:shared',

    // Slice libs — tagged by glob so they inherit scope + slice on creation.
    'libs/mobile/<slice>/src': ['scope:mobile', 'slice:<slice>'],
    'libs/functions/<slice>/src': ['scope:functions', 'slice:<slice>'],

    // Negative-test fixtures (excluded from production targets).
    'tools/sheriff-fixtures/mobile-side': 'scope:mobile',
    'tools/sheriff-fixtures/functions-side': 'scope:functions',
  },
  depRules: {
    // Virtual root (main.ts, app shell, files outside any module) and untagged
    // barrel modules may depend on anything tagged — keeps generated scaffolding
    // green without weakening the cross-scope/cross-slice bans below.
    root: 'noTag',
    noTag: () => true,

    // Rule 4: anything may import scope:shared.
    '*': 'scope:shared',

    // Rules 1 + 3: mobile may import shared and mobile (its own scope/slices),
    // never functions.
    'scope:mobile': ['scope:shared', 'scope:mobile'],

    // Rules 1 + 3: functions may import shared and functions, never mobile.
    'scope:functions': ['scope:shared', 'scope:functions'],

    // scope:shared stays self-contained — it may only depend on scope:shared.
    'scope:shared': 'scope:shared',

    // Rule 2: a slice may import scope:shared and only the *same* slice tag —
    // never a different slice.
    'slice:*': ['scope:shared', sameTag],
  },
};
