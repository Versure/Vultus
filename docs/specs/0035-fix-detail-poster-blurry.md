---
number: 0035
slug: fix-detail-poster-blurry
title: Fix blurry title-detail hero poster by serving a larger TMDB image size
status: approved
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-06-29
---

# 0035 — Fix blurry title-detail hero poster by serving a larger TMDB image size

## Context

GitHub issue #81: when navigating to the title-detail view of a TV show or
movie, the poster/hero image renders **blurry**.

The title-detail hero renders the poster full-width at **530px tall** with
`object-fit: cover` (`libs/mobile/title-detail/src/lib/title-detail.page.scss`
`.hero` / `.hero-image`; markup in `title-detail.page.html` ~lines 49-79 binds
`[src]="detail.posterUrl"`). But the poster URL is built from TMDB image size
**w185** (185px wide), which is heavily upscaled to fill a phone-width 530px
hero → visibly blurry.

That size is baked into a single shared config value
`environment.tmdb.imageBaseUrl = 'https://image.tmdb.org/t/p/w185'`, present in
all committed env files (`environment.ts`, `environment.prod.ts`,
`environment.mock.ts`) and emitted by the generated-env renderer
`renderGeneratedEnv` in `tools/scripts/inject-mobile-env.mjs`. That same
`environment.tmdb` object is provided to **both** the search slice
(`TMDB_SEARCH_CONFIG`) and the title-detail slice (`TMDB_DETAIL_CONFIG`) in
`apps/mobile/src/app/app.config.ts` (~line 114 and the `TMDB_DETAIL_CONFIG`
provider at ~line 118, whose comment at ~lines 115-118 currently calls it the
"same `environment.tmdb` value"). The detail client
constructs `posterUrl = config.imageBaseUrl + raw.poster_path`
(`tmdb-detail.client.ts` `mapDetail`, ~line 158) and the service does the same
for the title-cache path (`title-detail.service.ts`, ~line 120).

w185 is **correct** for the small thumbnails in the search slice and the
watchlist slice (the watchlist hardcodes its own `TMDB_POSTER_BASE = w185` and
builds from the denormalized `posterPath`). Those are small cards and are not
reported blurry — the fix must **not** change them.

**Intended outcome:** the title-detail hero loads a sharp, appropriately-sized
poster (TMDB `w780`) while search/watchlist thumbnails keep requesting w185.

## Scope

In:

- Make `environment.tmdb.detailImageBaseUrl = 'https://image.tmdb.org/t/p/w780'`
  resolvable in every build configuration. **The env files are not uniform**, so
  the edit differs by file:
  - `environment.ts` and `environment.prod.ts` each have an **inline
    `tmdb: { ... }` block** — add the `detailImageBaseUrl` line there, immediately
    after the existing `imageBaseUrl` line.
  - `environment.mock.ts` is **different**: it has no inline `tmdb` block. It
    defines a named const `mockTmdbConfig` (≈lines 194-199) **explicitly typed
    `TmdbSearchConfig`** (imported from `@vultus/mobile/search`) and sets
    `tmdb: mockTmdbConfig` on the `environment` object (≈line 218). Adding the key
    inside `mockTmdbConfig` is a TS excess-property error against
    `TmdbSearchConfig`. Instead, leave `mockTmdbConfig` and its annotation
    untouched and set the env object's `tmdb` to spread it and add the key:
    `tmdb: { ...mockTmdbConfig, detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780' }`.
    This keeps the search-typed const valid while ensuring `detailImageBaseUrl`
    is defined under `--configuration=mock`.
  - The `renderGeneratedEnv` template in `tools/scripts/inject-mobile-env.mjs`
    **does** emit a plain inline `tmdb: { ... }` block, so the "after the
    `imageBaseUrl` line" insertion is correct there too (so CI/production-built
    APKs get it).
- Change **only** the `TMDB_DETAIL_CONFIG` provider in
  `apps/mobile/src/app/app.config.ts` so the detail slice receives the larger
  base, e.g.
  `{ provide: TMDB_DETAIL_CONFIG, useValue: { ...environment.tmdb, imageBaseUrl: environment.tmdb.detailImageBaseUrl } }`.
- Keep the inline comments in `app.config.ts` accurate after the change.
- A wiring/unit test asserting the detail config resolves to a w780-class base
  distinct from the search config's w185, plus extending the env-renderer test.

Out of scope:

- The **search slice** and its `TMDB_SEARCH_CONFIG` provider — unchanged
  (stays on w185).
- The **watchlist slice** and its hardcoded `TMDB_POSTER_BASE = w185` — unchanged.
- Any string-surgery on poster URLs (no regex/replace on the path); the fix is a
  config-value swap only.
- The detail slice's `TmdbDetailConfig` interface (`tmdb-detail.client.ts`): it
  needs **no** new field — only the value its `imageBaseUrl` resolves to changes,
  and the client/service code stays as-is.
- Any markup/SCSS change to the hero, the poster-placeholder fallback, or any
  visual layout; data model, Firestore rules, Sheriff config.

## Affected slices & Sheriff tags

- `apps/mobile` (app shell) — `scope:mobile`. The `TMDB_DETAIL_CONFIG` provider
  wiring and the env files live here.
- `tools/scripts/inject-mobile-env.mjs` + its test — workspace tooling (no
  Sheriff slice; root/tooling scope).
- `libs/mobile/title-detail` — `scope:mobile`, `slice:title-detail`. **Consumes**
  the changed config value; its source code does **not** change (only a test may
  be added/asserted here, see Test plan).

No cross-slice import is introduced. The two TMDB config tokens already preserve
slice isolation (the detail slice never imports the search slice's token); this
spec deliberately keeps them divergent in value. The search and watchlist slices
are untouched, honoring vertical-slice boundaries (CLAUDE.md / PLAN §3). No
`shared/` extraction is involved (the "extract only at 3+ slices" rule does not
apply — this is per-slice config wiring).

## Data model touchpoints

None. No Firestore collections, fields, converters, or security rules are added
or changed. `posterPath` denormalization (PLAN §4, `title-cache` / watchlist)
is unchanged; only the **base URL prefix** the title-detail slice prepends to a
`poster_path` differs.

## Public types / APIs

No exported type or interface changes.

- `TmdbDetailConfig` (`tmdb-detail.client.ts`) is **unchanged** — `imageBaseUrl`
  already exists; only its provided value changes.
- `environment.tmdb` gains a new property `detailImageBaseUrl: string` in the
  three committed env files and the generated-env template. This is an
  app-internal config shape, not an exported library type, so no lib barrel
  changes and no lib README update is required (confirm during implementation).
- `TMDB_DETAIL_CONFIG` and `TMDB_SEARCH_CONFIG` injection-token identities are
  unchanged; only the `useValue` for `TMDB_DETAIL_CONFIG` changes.

## UI / Stitch screen refs

No Stitch screen fetch required — there is **no markup, layout, or design-token
change**. The hero element, its 530px height, `object-fit: cover`, radius, and
the poster-placeholder fallback (rendered when `posterUrl` is null) are all
untouched. The only observable change is the **resolution of the same hero
image**: the browser/WebView requests a w780 source instead of w185, so the
existing `cover` fill is no longer upscaled.

Because a green build does **not** prove UI fidelity (CLAUDE.md), the actual
sharpness improvement **must be confirmed by a human eyeball or screenshot** of
the title-detail hero **against a real TMDB poster** — flagged in the Test plan
and Risks as the one verification a green pipeline cannot provide.

**`--configuration=mock` is not a usable vehicle for this check.** Every mock
detail fixture in `environment.mock.ts` returns `poster_path: null`, so the mock
detail page always renders the poster-placeholder fallback — never an image —
making the w185→w780 change unobservable under mock. Confirm sharpness instead
on-device, or via a dev serve against **real TMDB** (a populated, gitignored
`.env.local` so live posters load), or by a human screenshot review. Adding a
mock fixture with a real `poster_path` is **out of scope** (it would touch the
e2e/mock seed data).

## Implementation task graph

1. **[sequential]** Add `detailImageBaseUrl` (w780) to the env config shape and
   the generated-env template, wire the `TMDB_DETAIL_CONFIG` provider to it, and
   add/extend tests. Single slice + app shell + tooling; no parallelism (the
   provider change depends on the env-shape change, and the test depends on both).
   - File manifest:
     - `apps/mobile/src/environments/environment.ts`
     - `apps/mobile/src/environments/environment.prod.ts`
     - `apps/mobile/src/environments/environment.mock.ts`
     - `tools/scripts/inject-mobile-env.mjs`
     - `tools/scripts/inject-mobile-env.test.mjs`
     - `apps/mobile/src/app/app.config.ts`
     - the chosen wiring-test file (see Test plan — prefer an existing
       title-detail spec under `libs/mobile/title-detail/src/lib/`, or an
       app.config provider test under `apps/mobile/src/app/`)
   - Steps:
     - In `environment.ts` and `environment.prod.ts` (both have an inline
       `tmdb: { ... }` block), add
       `detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780'` to that block,
       immediately after the existing `imageBaseUrl: '…/w185'` line. Keep the
       existing `imageBaseUrl` (w185) intact.
     - In `environment.mock.ts` (**different shape — no inline `tmdb` block**),
       do **not** touch the `mockTmdbConfig` const (≈lines 194-199) or its
       `TmdbSearchConfig` annotation — adding the key there is a TS
       excess-property error. Instead change the `environment` object's `tmdb`
       (≈line 218) from `tmdb: mockTmdbConfig` to
       `tmdb: { ...mockTmdbConfig, detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780' }`.
       This keeps the search-typed const valid and ensures
       `environment.tmdb.detailImageBaseUrl` is defined under
       `--configuration=mock` (whose `fileReplacements` swap `environment.ts` →
       `environment.mock.ts`), so mock detail posters never resolve to
       `"undefined/…"`.
     - In `renderGeneratedEnv` (`inject-mobile-env.mjs`, ~line 149-153) — which
       emits a plain inline `tmdb: { ... }` block — add the
       same `detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780'` line to the
       emitted `tmdb` block so CI/production-built APKs receive it. It is a
       constant (not injected from `values`), mirroring the existing constant
       `apiBaseUrl` / `imageBaseUrl` lines — no new `REQUIRED_KEYS` entry.
     - In `app.config.ts`, change **only** the `TMDB_DETAIL_CONFIG` provider to
       `{ provide: TMDB_DETAIL_CONFIG, useValue: { ...environment.tmdb, imageBaseUrl: environment.tmdb.detailImageBaseUrl } }`,
       and update the now-inaccurate adjacent comment (≈lines 115-118, currently
       "same `environment.tmdb` value") so it notes the detail token uses the
       larger detail base (w780) via `detailImageBaseUrl` while search stays on
       w185. Leave `TMDB_SEARCH_CONFIG` untouched.
     - Optional polish (not required): the example comment on
       `TmdbDetailConfig.imageBaseUrl` (`tmdb-detail.client.ts`, ≈line 41,
       currently `// e.g. …/w185`) may be updated to reflect the w780 detail
       base; the interface itself does not change.

## Test plan

- **Unit / wiring (new assertion):** verify the detail slice consumes a
  w780-class base distinct from search's w185. Pick the **lightest existing
  seam**:
  - Preferred: assert in a title-detail client/service spec
    (`tmdb-detail.client.spec.ts` or `title-detail.service.spec.ts`) that when
    the config's `imageBaseUrl` is a w780 base, the constructed `posterUrl`
    starts with `.../w780`; or
  - an `app.config` provider test that the value bound to `TMDB_DETAIL_CONFIG`
    has an `imageBaseUrl` ending in `w780` while `TMDB_SEARCH_CONFIG`'s ends in
    `w185`.
    Choose one; do not add both. The point is a regression guard that the two
    configs diverge as intended.
- **Reuse existing title-detail specs, do not churn them.** The client/service
  code is unchanged, so `title-detail.service.spec.ts`,
  `tmdb-detail.client.spec.ts`, and `title-detail.page.spec.ts` (which use w185
  fixtures) keep passing. Do **not** rewrite their fixtures from w185 to w780
  just to swap a string — only the one new assertion above exercises the new
  behavior.
- **Env renderer guard:** extend `tools/scripts/inject-mobile-env.test.mjs` to
  assert `renderGeneratedEnv` output includes the w780 `detailImageBaseUrl`
  value (e.g. `expect(content).toContain('https://image.tmdb.org/t/p/w780')`,
  mirroring how the test already asserts the tmdb key/url survive in the
  rendered output).
- **Visual verification (human/screenshot, not pipeline):** the actual sharpness
  of the hero at 530px must be confirmed by a screenshot or human eyeball against
  a **real TMDB poster** — on-device, or via a dev serve against real TMDB (a
  populated gitignored `.env.local` so live posters load). **Do not use
  `--configuration=mock`**: all mock detail fixtures have `poster_path: null`, so
  the mock detail page renders the placeholder fallback and the w185→w780 change
  is unobservable there. A green typecheck/lint/test/build does **not** prove the
  poster looks sharp (CLAUDE.md). Flag as needs-human if no visual check is
  performed.

### e2e

**No new e2e flows required — visual/config change only, no new route or user
action.** The existing search → detail e2e flow (spec 0019) already navigates to
the title-detail page and is unaffected (the page renders the same hero element;
only the image source resolution changes). No existing Playwright flow needs
editing and none is added.

## Definition of done

- Typecheck passes (`nx affected -t typecheck --base=main`).
- Lint + Sheriff pass — no new boundary violations; search and watchlist slices
  untouched.
- Unit tests pass, including the new divergence assertion and the extended env-
  renderer test; the title-detail slice keeps its existing tests green.
- Build passes (`nx affected -t build --base=main`).
- No new e2e flow; existing affected flows (search → detail, spec 0019) green
  where the e2e gate is runnable, degrading gracefully if tooling is absent
  (CLAUDE.md / skills).
- No lib README change (the fix changes app-level wiring + env config + tooling,
  not a lib barrel/public surface) — confirm during implementation; if a lib
  surface unexpectedly changes, update that lib's README in the same change.
- Hero sharpness visually confirmed (screenshot/human eyeball) or explicitly
  flagged unverified for a human.

## Risks

- **Larger image payload on the detail hero.** w780 is a bigger download than
  w185. This is the intended, accepted trade for sharpness on a 530px hero;
  `original` was rejected as wasteful on mobile and `w500` as still soft (decision
  1). Search/watchlist thumbnails stay on w185 so list scrolling cost is
  unchanged.
- **Generated env drift.** `environment.generated.ts` is gitignored and produced
  by `renderGeneratedEnv`; if the template is updated but a stale generated file
  lingers in a worktree, a CI/prod build could still emit w185. The env-renderer
  test guards the template; CI regenerates the file, so a fresh build picks up
  w780. Do not hand-edit `environment.generated.ts`.
- **Green build ≠ sharp poster.** The improvement is purely visual at runtime; no
  automated gate proves it. The visual check is the only real confirmation
  (called out in the Test plan and DoD).
- **Other consumers of `environment.tmdb.imageBaseUrl`.** The change keeps the
  shared `imageBaseUrl` at w185 and adds a sibling key, so any other consumer of
  `environment.tmdb` (search) is unaffected — verified against the two providers
  in `app.config.ts`. Only `TMDB_DETAIL_CONFIG`'s resolved value changes.
- No PLAN.md conflict: the fix stays within the title-detail vertical slice plus
  app-shell/env/tooling wiring and the existing Firestore data model (PLAN §3–§4).
