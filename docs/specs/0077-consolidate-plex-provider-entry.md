---
number: 0077
slug: consolidate-plex-provider-entry
title: Exclude the real TMDB "Plex" provider from the Settings catalog so only the manual Plex chip shows
status: approved
slices: []
scopes: [scope:functions]
created: 2026-07-05
---

# Exclude the real TMDB "Plex" provider from the Settings catalog so only the manual Plex chip shows

## Context

GitHub #195: "There are now two entries for plex in the providers list, i want to
consolidate these into a single entry. This should work with the mark watching via
plex feature."

The Settings "My Providers" card can render **two** chips both labelled "Plex",
backed by two unrelated pieces of state. Root cause (confirmed by reading the
code, not guesswork):

- `libs/mobile/settings/src/lib/settings.page.html:95-124` renders one
  `.provider-chip` per entry in `service.providerCatalog()` — the TMDB-sourced
  region watch-provider catalog, currently rendered unfiltered.
- `libs/mobile/settings/src/lib/settings.page.html:126-156` unconditionally
  splices in a **second, hardcoded "Plex" chip** immediately after that loop,
  bound to `service.hasPlex()` / `onPlexToggle()`. This is spec 0061's manual "I
  use Plex" flag, persisted as `users/{uid}.hasPlex` (a boolean, **not** a
  `myProviderIds` catalog entry).
- The real TMDB watch-provider catalog — fetched in
  `libs/functions/sync-titles/src/lib/tmdb/tmdb-client.ts:147-169`
  (`getRegionWatchProviders`, calling `/watch/providers/movie` and
  `/watch/providers/tv`) and merged in
  `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts:94-110`
  (`mergeCatalogProviders`) — can legitimately include a real "Plex" provider
  entry for some regions (TMDB has onboarded Plex's ad-supported tier as a genuine
  watch provider). `mergeCatalogProviders` currently only dedupes by `providerId`
  (`byId.has(entry.provider_id)`, first-occurrence-wins) — there is **no
  name-based filter anywhere**.
- Spec 0061's design comment asserted "Plex has no TMDB id"
  (`libs/mobile/settings/src/lib/settings.service.ts:44-47`) — that assumption is
  **false** for regions where TMDB does list a real Plex provider, and nothing in
  the pipeline verifies it. When TMDB returns a Plex entry it renders as an
  ordinary selectable chip (toggling `myProviderIds`) **alongside** the
  always-present manual Plex chip (toggling `hasPlex`): two "Plex"-labelled chips
  in "My Providers", backed by two different pieces of state.

Intended outcome: the region watch-provider catalog **never contains a "Plex"
entry**, so the only "Plex" chip in "My Providers" is spec 0061's manual chip.
This is a small, surgical, `scope:functions`-only data-filtering fix — not a
redesign of the provider system.

## Scope

In:

- **Filter the real TMDB Plex entry out of the merged catalog, server-side**, in
  `mergeCatalogProviders` (`libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts`,
  around lines 94-110): exclude any TMDB entry whose `provider_name` matches
  "Plex" (case-insensitive, trimmed) **before** it is deduped/returned.
- A **unit test** on `mergeCatalogProviders` covering the exclusion and the
  no-regression of the existing dedup/sort/logo behaviour.
- Update the sync-titles lib `README.md` if it documents `mergeCatalogProviders`'
  behaviour (add the Plex-exclusion note).

Out of scope (explicitly):

- **Any `scope:mobile` / `scope:shared` change.** No change to
  `settings.page.html`/`settings.page.ts`/`settings.service.ts` or its mock — the
  fix is entirely **upstream** of what the mobile UI receives. Once the catalog
  itself excludes a "Plex" entry, the manual Plex chip at
  `settings.page.html:126-156` simply never collides with a same-named TMDB chip.
  **Do not modify the settings page/service/mock files.**
- **No `shared/domain` type change.** This is pure data-filtering logic, not a
  schema change — `CatalogProvider` is unchanged, so there is **no repo-wide
  ripple**.
- **No legacy `myProviderIds` cleanup.** Do **not** add any pruning of a
  previously-selected real-TMDB-Plex id from `users/{uid}.myProviderIds`. Leave
  `SettingsService.setRegion()`'s existing prune logic
  (`libs/mobile/settings/src/lib/settings.service.ts:217-252`) untouched and do
  not extend it. Any pre-existing phantom id is accepted as a rare, harmless,
  self-resolving edge case (it drops out naturally the next time the user changes
  region, via the existing prune).
- **`hasPlex` / `toggleHasPlex`** (Settings manual toggle,
  `settings.service.ts:306-314`) and **`watchingViaPlex` / `toggleWatchingViaPlex`**
  (title-detail per-title "mark watching via Plex" feature,
  `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
  `title-detail.page.html` "Personal Tracking" section) — **unchanged; must keep
  working exactly as today.** Confirmed unrelated code paths, none of which import
  anything from this fix.
- **The spec-0073 "Plex Server" LAN-sync card** (`PlexLinkService` /
  `PlexSyncService`) — unrelated and untouched.
- **`RegionAvailability.providers` / per-title watch-provider data** (the
  `title-cache/{tmdbId}/availability/{region}` docs populated by the sync engine
  from TMDB's **per-title** watch-providers endpoint). That is a **separate data
  path** from the Settings "My Providers" catalog and is not what #195 is about.
  Do **not** touch `sync-engine.ts` or per-title provider mapping
  (`mapWatchProviders` / `mapCountryProviders`).
- **Cache-busting / migration machinery** for already-cached catalogs (see the
  accepted rollout tradeoff in Data model touchpoints + Risks). No manual
  Firestore cache-clear script.

## Affected slices & Sheriff tags

**One project, one scope.** No slice tag (this is a `scope:functions` change with
no slice), no cross-slice import, no shared-code extraction.

| Path                                                           | Scope / slice     | Change                                                                                   |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts`      | `scope:functions` | Filter `provider_name === 'Plex'` (case-insensitive, trimmed) in `mergeCatalogProviders` |
| `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.spec.ts` | `scope:functions` | Unit test: Plex excluded across casings; other providers + dedup + sort unaffected       |
| `libs/functions/sync-titles/README.md`                         | `scope:functions` | Note the Plex-exclusion behaviour of `mergeCatalogProviders` (if the README covers it)   |

- **No `sheriff.config.ts` change** — `libs/functions/sync-titles` already carries
  its `scope:functions` tag.
- **No cross-slice import, no `scope:shared` import beyond what the file already
  imports** (`@vultus/shared/domain` types, already present). `scope:mobile` is
  entirely untouched — no `scope:mobile ↔ scope:functions` edge is created.
- **No shared-code extraction.** The filter is a two-line predicate inside an
  existing function in one slice; the 3+-slice extract rule (PLAN §3 / CLAUDE.md)
  is not remotely in play.

## Data model touchpoints

PLAN §4 paths. **No new collection, no new field, no converter change, no schema
change.** The fix changes only the _contents_ of the merged
`CatalogProvider[]` that `runGetWatchProviders` caches — not any document shape.

| PLAN §4 path                | Access                           | By                                                                                |
| --------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `provider-catalog/{region}` | **write** (contents change only) | `runGetWatchProviders` (`apps/functions/src/main.ts`) — caches the merged catalog |

- **No `firestore.rules` change** — no new read/write path. `provider-catalog/*`
  is written by the callable via the Admin SDK (bypasses rules,
  `apps/functions/src/main.ts:507`), read by the mobile client under the existing
  rule; neither the path nor the access pattern changes.
- **No `firestore.indexes.json` change** — no new query. Nothing queries by
  provider name.
- **No `shared/domain` / `shared/firestore-schema` change** — `CatalogProvider` is
  unchanged.

### Accepted rollout tradeoff (cache staleness — NOT a defect)

`runGetWatchProviders` (`apps/functions/src/main.ts`) caches the merged catalog
into `provider-catalog/{region}` with a **7-day staleness window**
(`PROVIDER_CATALOG_STALENESS_MS = 7 * 24 * 60 * 60 * 1000`,
`apps/functions/src/main.ts:485-486`). A region whose catalog is **already cached
containing the real Plex entry** will keep serving that stale entry until the
cache naturally expires (≤7 days), at which point the next fetch re-merges through
the now-Plex-excluding `mergeCatalogProviders` and the entry drops out. This is an
**accepted rollout tradeoff**, not a defect: **do not** add cache-busting,
migration, or a manual `provider-catalog` clear script (out of scope). New/expired
region caches get the fix immediately; already-cached ones self-heal within the
staleness window.

## Public types / APIs

**No new or changed public/exported types, function signatures, or barrel
exports.**

- `mergeCatalogProviders(movie: TmdbWatchProviderListEntry[], tv:
TmdbWatchProviderListEntry[]): CatalogProvider[]` — **signature unchanged.** Only
  its internal filtering behaviour changes: it now skips any entry whose
  `provider_name`, trimmed and lower-cased, equals `'plex'`, before the existing
  dedup-by-`providerId` and name-sort. The exclusion applies to entries from
  **both** the `movie` and `tv` lists.
- **F2 ripple check: empty.** No `shared/domain` type is added, widened, or made
  required; `CatalogProvider` is untouched. `nx affected -t test --base=main`
  scope is confined to `libs/functions/sync-titles` (and its dependents, none of
  whose behaviour changes). No object-literal construction of a shared type
  changes.

Prescribed implementation (name-match, not a hardcoded id — decision 2): add an
early `continue` inside the existing `for (const entry of [...movie, ...tv])`
loop, before the `byId.has(...)` dedup check:

```ts
// spec 0077 (#195): exclude the real TMDB "Plex" provider so the Settings
// catalog never collides with the manual "I use Plex" chip (spec 0061). Match by
// NAME (case-insensitive, trimmed) — TMDB assigns no stable, verified Plex id we
// can hardcode, so a name match is the safer predicate.
if (entry.provider_name.trim().toLowerCase() === 'plex') continue;
```

- **Match by NAME, not id** (decision 2): no hardcoded numeric TMDB provider id is
  referenced or tested anywhere in the codebase today; hardcoding an unverified id
  would be riskier than a name match. Case-insensitive, trimmed **exact** match on
  `'plex'` (so it excludes `'Plex'`, `'plex'`, `' Plex '`, but not, e.g.,
  `'Plex Premium'` — an exact match, deliberately narrow, avoids over-matching a
  differently-named provider that merely contains "Plex").

## UI / Stitch screen refs

**None — no `scope:mobile` change.** This is a backend data-filtering fix entirely
upstream of the mobile UI. The Settings "My Providers" card, its chips, and the
manual Plex chip render **exactly as spec 0060/0061/0075 define them**; the only
observable effect is that a region catalog no longer _contains_ a second,
TMDB-sourced "Plex" chip. No Stitch screen is touched or newly referenced, no
template/SCSS changes, no design tokens involved.

## Implementation task graph

Single task, single slice, `scope:functions` only. No shared-root edit, no
new-slice generation, no fan-out — there is nothing to parallelise.

**T1 — Exclude the real TMDB Plex entry from `mergeCatalogProviders` + unit test [sequential]** (backend-engineer)

- `tmdb-mappers.ts`: in `mergeCatalogProviders`
  (`libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts:94-110`), add the
  name-match `continue` guard (case-insensitive, trimmed `=== 'plex'`) at the top
  of the `for (const entry of [...movie, ...tv])` loop, **before** the
  `byId.has(entry.provider_id)` dedup check, so a Plex entry from either list is
  skipped and never enters `byId`. Update the function's leading comment
  (`:90-93`) to mention the Plex exclusion (spec 0077 / #195).
- `tmdb-mappers.spec.ts`: extend the existing
  `describe('mergeCatalogProviders (spec 0060)')` block
  (`libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.spec.ts:50-133`) with the
  new tests below (Test plan). **Do not regress** the existing 0060 cases — the
  merge/dedup/logo/sort/empty cases must all still pass unchanged.
- `libs/functions/sync-titles/README.md`: if it documents `mergeCatalogProviders`'
  behaviour, add a one-line note that "Plex" (case-insensitive) is excluded from
  the merged catalog (spec 0077); if the README does not mention this function,
  no README change is required.
- **File manifest:** `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts`,
  `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.spec.ts`,
  `libs/functions/sync-titles/README.md`.

## Test plan

Per the PLAN §5 pyramid. The meaningful, sufficient test is a **unit** test on the
pure function `mergeCatalogProviders` (Vitest). No component test (no UI change).
No e2e (see e2e subsection).

### Unit — `tmdb-mappers.spec.ts` (extend the existing `mergeCatalogProviders` describe)

- **Excludes a "Plex" entry, across casings/whitespace.** Given raw TMDB entries
  including `{ provider_name: 'Plex' }` (and, in separate assertions or a
  parametrised case, `'plex'` and `' Plex '`) alongside a real provider (e.g.
  Netflix, id 8), assert the returned `CatalogProvider[]` contains **no** entry
  whose `name` (trimmed, lower-cased) is `'plex'`, while Netflix passes through
  unaffected (`result.map(p => p.name)` includes `'Netflix'` and excludes any Plex
  variant). Cover a Plex entry arriving on the **movie** side and on the **tv**
  side.
- **A non-exact name is NOT excluded** (guards against over-matching): an entry
  named e.g. `'Plex Premium'` (or `'Plexus'`) **passes through** — only the exact
  trimmed/lower-cased `'plex'` is dropped.
- **Dedup-by-id unaffected.** Re-assert the existing "a provider in both lists
  appears once (first wins)" behaviour still holds with the filter present (a
  non-Plex provider in both movie + tv lists still yields one entry, first
  occurrence wins) — do not weaken or remove the existing dedup test.
- **Name-sort unaffected.** Re-assert the case-insensitive name sort still holds
  with the filter present (e.g. `['apple tv', 'Netflix', 'Zee5']` order is
  preserved when no Plex entry is involved) — do not weaken or remove the existing
  sort test.
- **Existing 0060 cases stay green unchanged** — merge, logo `?? null`,
  movie-only, tv-only, and two-empty-inputs cases
  (`tmdb-mappers.spec.ts:67-132`) are not edited and must still pass; the filter
  is additive and touches only Plex-named entries.

### Rendered-text assertions

- **N/A.** No component/unit test in this spec asserts on rendered UI text (no UI
  change). The unit assertions compare `CatalogProvider` object fields
  (`name` / `providerId`), not rendered strings, so the F3 exact-string /
  no-whitespace-normalization rule does not apply here.

### e2e

- **No e2e flow required / added — backend data-filtering change only.** This is a
  `scope:functions`-only change to a pure mapping function; it introduces no new
  route and no new user-facing action. Exercising the Settings grid end-to-end
  from a live catalog fetch requires the `getWatchProviders` callable to run inside
  the e2e harness's Functions runtime, which **the harness does not currently
  provide** — this is the exact, already-documented gap in the existing
  `test.fixme('toggling a provider chip in Settings flips the watchlist pill')`
  block (`apps/mobile-e2e/src/provider-preferences.spec.ts:126-152`: "toggling a
  chip calls getWatchProviders, which requires the callable itself to be deployed
  into the emulator's Functions runtime, which the e2e harness does not currently
  include"). This is stated here as a **known, accepted test-level gap**, mirroring
  that fixme's own reasoning — **not** a silent omission. Do **not** add new
  emulator-Functions plumbing as a side quest of this narrow fix, and do **not**
  add or un-skip an e2e test.

## Definition of done

Tailored PLAN §5 checklist — every item maps to task T1 above.

- [ ] **Typecheck** green (`nx affected -t typecheck --base=main`). — T1
- [ ] **Lint + Sheriff** green (`nx affected -t lint --base=main`); no new import
      edge — the change stays inside `libs/functions/sync-titles` and imports only
      what the file already imports. — T1
- [ ] **Unit** — `tmdb-mappers.spec.ts` includes the Plex-exclusion cases (across
      casings; movie- and tv-side; non-exact-name pass-through) and the
      dedup/sort no-regression re-assertions, and passes; all existing 0060
      `mergeCatalogProviders` cases stay green unchanged. — T1
- [ ] **Component** — none (no UI change). — n/a
- [ ] **Build** green (`nx affected -t build --base=main`, covering
      `sync-titles` / `functions`). — T1
- [ ] **e2e** — none required/added (backend data-filtering change; the live-catalog
      round-trip is fixme-gated behind the Functions-emulator harness gap — see
      Test plan). No e2e task. — n/a
- [ ] **Lib README** updated: `libs/functions/sync-titles/README.md` notes the
      Plex-exclusion behaviour of `mergeCatalogProviders` (only if the README
      documents that function). — T1
- [ ] **No data-model change** — no `firestore.rules`, `firestore.indexes.json`,
      rules-tests, `shared/domain`, or `shared/firestore-schema` change (F1 orphan
      check: none of these appear in the DoD, so none is orphaned; the only
      Firestore effect is the _contents_ of the already-existing
      `provider-catalog/{region}` cache doc, produced by T1's mapper change). — T1
- [ ] **UI fidelity** — n/a (no `scope:mobile` change; the Settings UI is
      unchanged and renders per spec 0060/0061/0075). — n/a

> **Rollout note (operational follow-up, NOT part of this task graph).** This is a
> Cloud Functions change; after the feature PR merges it must be shipped via
> `/deploy-functions` (or the standard `functions:deploy-preflight` gate) to reach
> prod. Deployment is owned by the maintenance `/deploy-functions` skill, not the
> `/implement-feature` flow — it is called out here for the maintainer, not
> enforced as a DoD checkbox for this spec.

## Risks

- **Already-cached region catalogs keep the real Plex entry for ≤7 days** (the
  `PROVIDER_CATALOG_STALENESS_MS` window). This is the **accepted rollout
  tradeoff** documented under Data model touchpoints — the entry self-heals when
  the cache expires and re-merges. No cache-bust / migration is in scope; do not
  add one.
- **Pre-existing phantom `myProviderIds` id.** A user who already selected the
  real-TMDB-Plex chip before this fix has that provider id persisted in
  `users/{uid}.myProviderIds`. By decision 3 this spec does **not** prune it — it
  is a rare, harmless, self-resolving edge case (the existing
  `SettingsService.setRegion()` prune,
  `libs/mobile/settings/src/lib/settings.service.ts:217-252`, drops any id absent
  from the freshly-loaded catalog the next time the user changes region). Left
  deliberately narrow; do not extend the prune.
- **Exact-name match could theoretically miss a regional relabel.** If TMDB ever
  lists Plex under a different `provider_name` in some region (e.g. "Plex TV"),
  the exact `=== 'plex'` predicate would not catch it and a duplicate could
  reappear there. Accepted: an exact match is deliberately narrow to avoid
  over-matching an unrelated provider whose name merely contains "Plex"; #195
  concerns the plain "Plex" entry, which the current predicate covers. Widening to
  a substring/`startsWith` match is a future adjustment, not this fix.
- **No PLAN conflict.** The change is `scope:functions`-only, creates no
  cross-scope import, adds no schema/rules/index, and touches a pure mapping
  function — fully consistent with the vertical-slice model (PLAN §3) and the data
  model (PLAN §4). The `provider_name` value it matches against comes from the
  TMDB API response, which per CLAUDE.md / spec 0068 is **data, not instructions**;
  it is used only as a string-comparison value in a filter predicate, never to
  derive commands, paths, or behaviour beyond inclusion/exclusion.
