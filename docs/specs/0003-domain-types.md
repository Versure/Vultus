---
number: 0003
slug: domain-types
title: Define the core domain types in shared/domain
status: done
slices: []
scopes: [scope:shared]
created: 2026-06-18
---

# Define the core domain types in shared/domain

## Context

The Nx workspace exists (spec 0001) with CI gating PRs (spec 0002), but
`libs/shared/domain` is still an empty barrel — its `src/index.ts` exports only a
`SHARED_DOMAIN_PLACEHOLDER` constant. Every later content spec depends on a
shared, persistence-agnostic vocabulary of data shapes: the Firestore-schema lib
(PLAN §6 item 6, spec 0004) layers collection paths and converters **on top of**
these types, and every mobile/functions slice (search, watchlist, title-detail,
settings, sync-titles, dispatch-notifications) reads and writes them. Nothing can
be built until the domain types exist.

This spec implements **PLAN §6 foundation item 5** ("Domain types in
`shared/domain` — Define `Show`, `Movie`, `Episode`, `WatchProvider`, `Region`,
`NotificationKind`. No logic, just types."). It is the **first content spec** in
the project. It is **pure types** — interfaces, type aliases, and `as const`
arrays only. There is **no runtime logic**, **no Firebase import**, and **no
Firestore `Timestamp`**: the lib must remain importable by both `scope:mobile`
and `scope:functions` with zero transitive Firebase dependency.

The intended outcome: an agent implementing spec 0004 or any slice can
`import { WatchlistItem, Region, WATCH_STATUSES } from '@vultus/shared/domain'`
and get a complete, settled set of entity and Firestore-document shapes derived
directly from PLAN §4, with timestamps as ISO 8601 strings.

## Scope

In scope:

- Populate `libs/shared/domain/src` with TypeScript **types only**, re-exported
  through the single barrel `libs/shared/domain/src/index.ts`.
- **Enum-like fields** as string-literal unions. For the cases that are iterated
  at runtime (status, region, notification kind), pair the union with an
  `as const` array so callers can enumerate the cases — the const-array is the
  source and the type is derived from it:

  ```ts
  export const WATCH_STATUSES = [
    'watching',
    'completed',
    'dropped',
    'planned',
  ] as const;
  export type WatchStatus = (typeof WATCH_STATUSES)[number];
  ```

  Purely internal discriminants that are not iterated (title `type`
  `'movie' | 'tv'`, provider `type` `'flatrate' | 'rent' | 'buy'`) are bare
  string-literal unions with no companion array.

- **Both** the core entity/value types **and** the full Firestore-document
  interfaces, mapped 1:1 from PLAN §4 (see Public types / APIs).
- **Timestamps as ISO 8601 strings** everywhere (`addedAt: string`,
  `airDate: string`, `watchedAt: string | null`, `lastSyncedAt: string`, etc.).
  No `Date`, no Firestore `Timestamp`.
- **`Region`** as a curated **closed** union backed by a const array, NL primary:

  ```ts
  export const REGIONS = ['NL', 'DE', 'GB', 'US', 'FR', 'BE'] as const;
  export type Region = (typeof REGIONS)[number];
  ```

- A compile-time type-assertion **source** file
  (`libs/shared/domain/src/lib/type-assertions.ts`) proving the unions, const
  arrays, and document shapes compile and stay in sync — enforced by the
  `typecheck` target (`tsc --noEmit -p tsconfig.lib.json`), which compiles lib
  source but **not** spec files. A small `.spec.ts` carries one trivial runtime
  assertion so `nx test` has a real test (see Test plan).

Out of scope (each is its own later spec):

- **Firestore collection paths, document converters, and type-safe query
  helpers** — PLAN §6 item 6 / spec 0004. `firestore-schema` will _import_ these
  types and add the path/converter layer; it **must not redefine any shape here**
  (see the explicit contract in Public types / APIs and Risks).
- **Any runtime behavior** — no factory functions, no validators, no
  type-guards, no default-value builders. Pure types and `as const` literal
  arrays only.
- **Any Firebase / `firebase-admin` / `@angular/fire` import.** The lib stays
  dependency-free at runtime. The ISO-string ↔ `Timestamp` mapping lives in
  spec 0004's converters, at the persistence boundary.
- **Finalizing the detailed shapes of `notificationPrefs`, `TitleCacheEntry.metadata`,
  and `Notification.payload`.** Sensible minimal shapes are defined now (see
  Public types / APIs) but these firm up when the consuming slices
  (dispatch-notifications, sync-titles, title-detail) are specced — flagged in
  Risks as provisional.
- **`shared/ui-kit` types / theming**, and any slice-owned view-model types.

## Affected slices & Sheriff tags

No slice is built (`slices: []`). The work is confined to the single
`scope:shared` lib `libs/shared/domain`.

| Project       | Path                 | Sheriff tags   |
| ------------- | -------------------- | -------------- |
| shared domain | `libs/shared/domain` | `scope:shared` |

The `scope:shared` tag is **already** assigned to this lib by `sheriff.config.ts`
via the path-glob key `libs/shared/<name>` (spec 0001); this spec does **not**
edit `sheriff.config.ts` and does not need to re-assert the tag. The Sheriff rule
`'scope:shared': 'scope:shared'` keeps the lib self-contained — it may import
only other `scope:shared` code, which here is nothing (the file imports no other
module). No cross-slice or cross-scope import is introduced.

This is **not** a premature `shared/` extraction: PLAN §3 names `domain` as one
of the three fixed `scope:shared` libs, and PLAN §6 item 5 mandates these types
live here precisely so 3+ slices can share one vocabulary. Defining them up front
in the designated lib is the intended design, not a violation of the
"extract only at 3+ slices" rule (which governs _slice-owned_ code).

## Data model touchpoints

This spec defines the **TypeScript shapes** for every collection in PLAN §4 but
creates **no Firestore collections, indexes, or security rules** (those, plus the
ISO ↔ `Timestamp` converters and collection paths, are spec 0004). The types map
to PLAN §4 as follows (1:1, ISO strings substituted for `timestamp`):

| PLAN §4 path                                              | Domain type          | Notes                                                                                          |
| --------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `users/{userId}`                                          | `User`               | `region: Region`, `notificationPrefs`, `fcmTokens: FcmToken[]`                                 |
| `users/{userId}/watchlist/{titleId}`                      | `WatchlistItem`      | `type`, `tmdbId`, `traktId: number \| null`, `title`, `addedAt: string`, `status: WatchStatus` |
| `users/{userId}/watchlist/{titleId}/episodes/{episodeId}` | `EpisodeDoc`         | tv only; `season`, `episode`, `airDate: string`, `watched`, `watchedAt: string \| null`        |
| `users/{userId}/notifications/{notificationId}`           | `NotificationDoc`    | `titleId`, `kind: NotificationKind`, `payload`, `sentAt: string`, `readAt: string \| null`     |
| `title-cache/{tmdbId}`                                    | `TitleCacheEntry`    | `type`, `metadata`, `lastSyncedAt: string`                                                     |
| `title-cache/{tmdbId}/availability/{region}`              | `RegionAvailability` | `providers: WatchProvider[]`, `lastSyncedAt: string`, `previousSnapshot`                       |

The `RegionAvailability.previousSnapshot` field is **central to the
transition-detection design** (PLAN §3 "Data source reliability": "yesterday: not
on Netflix NL; today: on Netflix NL → notify"). Model it explicitly as the prior
`providers` array so the sync engine (spec for PLAN §6 item 11) and the
notification dispatcher (item 14) can diff current vs previous — see the shape in
Public types / APIs.

## Public types / APIs

All types are exported through `libs/shared/domain/src/index.ts` (the single
barrel — the convention proven by spec 0001's `@vultus/shared/domain` →
`libs/shared/domain/src/index.ts` path alias in `tsconfig.base.json`). The
implementer MAY split definitions across multiple files under `src/lib/` and
re-export them from `index.ts`, or keep them inline in `index.ts`; the **public
contract is the barrel**. The existing `SHARED_DOMAIN_PLACEHOLDER` export is
removed once real types land.

The names, unions, and field shapes below are the **settled contract**. Spec 0004
(firestore-schema) and every slice depend on these exact names; do not rename or
restructure them.

### Enum-like unions (with companion `as const` arrays where iterated)

```ts
// Iterated by UI/dispatch → const array + derived type.
export const WATCH_STATUSES = [
  'watching',
  'completed',
  'dropped',
  'planned',
] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export const REGIONS = ['NL', 'DE', 'GB', 'US', 'FR', 'BE'] as const; // NL = v1 primary/default
export type Region = (typeof REGIONS)[number];

export const NOTIFICATION_KINDS = [
  'episode-aired',
  'movie-available',
  'show-came-to-platform',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Internal discriminants — not iterated → bare unions, no companion array.
export type TitleType = 'movie' | 'tv';
export type WatchProviderType = 'flatrate' | 'rent' | 'buy';
```

### Core entity / value types

```ts
export interface WatchProvider {
  providerId: number; // TMDB provider id
  name: string;
  type: WatchProviderType; // 'flatrate' | 'rent' | 'buy'
}

// Title-type discriminant. Show (tv) vs Movie share a common base; the
// implementer MAY model this as a discriminated union `Title = Show | Movie`
// on the `type` field, or as a single interface with `type: TitleType` — choose
// the discriminated-union form so `type` narrows. Episode-bearing data lives on
// the Show branch / TV documents only.
export interface Movie {
  type: 'movie';
  tmdbId: number;
  traktId: number | null;
  title: string;
}

export interface Show {
  type: 'tv';
  tmdbId: number;
  traktId: number | null;
  title: string;
}

export type Title = Movie | Show;

// A TV episode value type (the data, persistence-agnostic).
export interface Episode {
  season: number;
  episode: number;
  airDate: string; // ISO 8601
}
```

### Firestore document shapes (persistence-agnostic; timestamps = ISO strings)

```ts
export interface FcmToken {
  token: string;
  deviceId: string;
  createdAt: string; // ISO 8601
}

// Provisional minimal shape — see Risks. Per-kind opt-in toggles aligned to
// NotificationKind.
export interface NotificationPrefs {
  episodeAired: boolean;
  movieAvailable: boolean;
  cameToPlatform: boolean;
}

export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
}

export interface WatchlistItem {
  type: TitleType; // 'movie' | 'tv'
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
}

// users/{userId}/watchlist/{titleId}/episodes/{episodeId} — tv only.
export interface EpisodeDoc {
  season: number;
  episode: number;
  airDate: string; // ISO 8601
  watched: boolean;
  watchedAt: string | null; // ISO 8601 or null
}

// Provisional minimal payload — see Risks. Keyed loosely now; firms up when
// dispatch-notifications is specced. Define as a typed object, NOT `any`.
export interface NotificationPayload {
  titleId: string;
  title: string;
  region: Region;
  providerName?: string; // present for availability/platform kinds
}

export interface NotificationDoc {
  titleId: string;
  kind: NotificationKind;
  payload: NotificationPayload;
  sentAt: string; // ISO 8601
  readAt: string | null; // ISO 8601 or null
}

// Provisional metadata — see Risks. Minimal cached TMDB fields now.
export interface TitleMetadata {
  title: string;
  overview: string;
  posterPath: string | null;
  releaseDate: string | null; // ISO 8601 or null
}

export interface TitleCacheEntry {
  type: TitleType;
  metadata: TitleMetadata;
  lastSyncedAt: string; // ISO 8601
}

export interface RegionAvailability {
  providers: WatchProvider[];
  lastSyncedAt: string; // ISO 8601
  previousSnapshot: WatchProvider[]; // prior providers array, for transition detection
}
```

Field names, union members, and nullability above are the contract. The
implementer chooses file layout and whether `Title` is a discriminated union, but
must not change the exported names or shapes.

### Explicit contract for spec 0004 (firestore-schema)

`firestore-schema` (PLAN §6 item 6) **adds collection PATHS and CONVERTERS that
reference these types — it does NOT redefine any shape.** Its converters map
Firestore `Timestamp` ↔ ISO 8601 `string` at the persistence boundary (that is
the _reason_ timestamps are strings here and Firebase is not imported here). Any
new persisted field discovered later is added to the type **in this lib** and
consumed there, never re-declared in `firestore-schema`.

## UI / Stitch screen refs

Not applicable. No mobile screens are built; this is a pure-types `scope:shared`
lib. (The watchlist `status` values defined here — `watching`/`completed`/
`dropped`/`planned` — are the same set the Stitch design system maps to status
colors in PLAN §2, but no UI is authored in this spec.)

## Implementation task graph

This is a **single-lib, single-scope, types-only** spec. There is **no parallel
work** — the entire deliverable is the contents of one lib, edited by one
engineer (a backend/foundation engineer; no Firebase, no UI). Splitting types
across files does not create parallelizable units (they share `index.ts` and
co-located test). All tasks are `[sequential]`.

1. **[sequential] Define the domain types and barrel exports.**
   - Replace the placeholder in `libs/shared/domain/src/index.ts` with the full
     type set from Public types / APIs — the enum-like unions + `as const`
     arrays, the core entity/value types, and the Firestore-document shapes.
   - Remove the `SHARED_DOMAIN_PLACEHOLDER` export.
   - Add **no** runtime logic and **no** Firebase/`firebase-admin`/`@angular/fire`
     import; timestamps are `string`.
   - Optionally organize into files under `libs/shared/domain/src/lib/`
     (e.g. `enums.ts`, `entities.ts`, `documents.ts`) re-exported from
     `index.ts`. Either way the public surface is the barrel.
   - Files: `libs/shared/domain/src/index.ts`, and (if the split is used)
     `libs/shared/domain/src/lib/**`.

2. **[sequential] Add the compile-time type-assertions source file.**
   - Add `libs/shared/domain/src/lib/type-assertions.ts` containing the
     compile-time assertions described in Test plan (the `AssertEqual<…>`
     helper, `satisfies` literals, and exhaustive-`never` checks). This is a
     **lib source file** (not a `.spec.ts`), so it is compiled by the
     `typecheck` target (`tsc --noEmit -p tsconfig.lib.json`) — which is the
     gate that makes a false assertion fail. It exports nothing of use to
     consumers; it exists solely so its type errors surface under `typecheck`.
     (Do **not** re-export it from `index.ts`; `typecheck` compiles all
     `src/**/*.ts` regardless of barrel re-export.)
   - Files: `libs/shared/domain/src/lib/type-assertions.ts`.

3. **[sequential] Add the trivial runtime test.**
   - Add `libs/shared/domain/src/lib/domain.spec.ts` with one runtime `expect`
     (e.g. `expect(REGIONS[0]).toBe('NL')`) so `nx test` has a real test (Vitest
     runner; the lib's `vite.config.mts` includes `src/**/*.{test,spec}.ts`).
   - Files: `libs/shared/domain/src/lib/domain.spec.ts`.

4. **[sequential] Verify the definition-of-done gates locally.**
   - Run `pnpm nx lint shared-domain`, `pnpm nx typecheck shared-domain`, and
     `pnpm nx test shared-domain` (or `pnpm nx affected -t lint typecheck test
--base=main`). All green. Record the commands in the PR description.

## Test plan

Per the PLAN §5 pyramid, tailored: there is **no runtime behavior**, so the test
surface is **compile-time assertions** plus one trivial runtime test. The
critical mechanics — verified against this lib's config:

- The `typecheck` target runs `tsc --noEmit -p tsconfig.lib.json`, which
  compiles `src/**/*.ts` **but excludes `src/**/\*.spec.ts`** (per the lib's
`tsconfig.lib.json` `exclude`).
- The lib's `vite.config.mts` has **no `test.typecheck` block**, so Vitest
  strips types at transform time — `expectTypeOf`/`AssertEqual`/`satisfies`
  placed in a `.spec.ts` are **inert at runtime and gated by nothing**.

Therefore the compile-time assertions **must live in a lib source file that
`typecheck` compiles**, not in a spec file. Chosen approach:

- **Compile-time type-assertions in `libs/shared/domain/src/lib/type-assertions.ts`**
  (a regular `.ts` source file, compiled by the `typecheck` target). A false
  assertion makes `tsc --noEmit -p tsconfig.lib.json` fail — this is the real
  enforcement gate. Zero extra dependency; use `satisfies` + a hand-rolled
  equality helper + exhaustive-`never` checks:
  - An equality helper
    `type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;`
    used as `const _watch: AssertEqual<WatchStatus, (typeof WATCH_STATUSES)[number]> = true;`
    (and likewise for `Region`/`NOTIFICATION_KINDS`) — equality failing resolves
    the annotation to `never`, so the `= true` assignment is a compile error.
  - Assert `REGIONS`, `WATCH_STATUSES`, `NOTIFICATION_KINDS` contain exactly
    their union members: an exhaustive `switch` over a value of the union with a
    `never` default catches a union member added without an array entry, and a
    literal `satisfies Region[]` on `[...REGIONS]` catches the reverse.
  - Assert representative document literals are assignable, e.g.
    `const u = { region: 'NL', notificationPrefs: {...}, fcmTokens: [] } satisfies User;`
    plus a `WatchlistItem`, `EpisodeDoc`, `NotificationDoc`, `TitleCacheEntry`,
    and `RegionAvailability` literal — proving the shapes compile and that
    timestamps accept ISO strings.
  - Assert `Title` narrows on `type` (a `switch (t.type)` with a `never`
    default).

  (Alternative, not chosen: enable `vitest --typecheck` by adding a
  `test.typecheck` block to `vite.config.mts` and writing `expectTypeOf`
  assertions in a spec — rejected to avoid Vitest typecheck-mode setup/flakiness
  and an extra config change; the source-file-in-`typecheck` path reuses an
  existing gate.)

- **One trivial runtime test in `libs/shared/domain/src/lib/domain.spec.ts`**,
  e.g. `expect(REGIONS[0]).toBe('NL')` (also pins NL as the first/primary
  region). The reason for this runtime `expect` is simply to give `nx test` a
  real test once the type checks live in their own `typecheck`-enforced file; it
  is not what enforces the type contract. (`passWithNoTests: true` in the Vitest
  config only controls whether an empty run is reported green — it does not force
  a runtime assertion; the trivial `expect` is for having a genuine test, not to
  satisfy that flag.)

- **No Firebase-dependency test is needed**, but the lib having **no** Firebase
  import is enforced structurally: `package.json`/imports carry no firebase
  dependency, and `typecheck` would fail to resolve one. Neither the
  type-assertions file nor the spec file may import firebase.
- **Component tests:** none — no UI.
- **e2e tests:** none — no flow; no emulator, no Firebase, no Playwright.

## Definition of done

Tailored from the PLAN §5 checklist (no component/e2e — no UI, no flow; no
emulator/Firebase needed):

- [ ] `pnpm nx typecheck shared-domain` passes — runs
      `tsc --noEmit -p tsconfig.lib.json`, compiling `type-assertions.ts` and so
      enforcing the const-array/union sync and document-shape assertions. (There
      is **no** `build` target on this lib — `@nx/vite/plugin` infers only
      `lint`/`typecheck`/`test`; `typecheck` is the compile gate.)
- [ ] `pnpm nx lint shared-domain` passes with Sheriff active — the lib imports
      only `scope:shared` (here, nothing) and no cross-scope/Firebase module.
- [ ] `pnpm nx test shared-domain` passes (the trivial runtime test registers
      under Vitest).
- [ ] All types from Public types / APIs are exported through
      `@vultus/shared/domain` (the single barrel `libs/shared/domain/src/index.ts`);
      the `SHARED_DOMAIN_PLACEHOLDER` placeholder is removed.
- [ ] **No** runtime logic and **no** `firebase` / `firebase-admin` /
      `@angular/fire` import is added; **no** `Date` or Firestore `Timestamp`
      type is used — all timestamps are ISO 8601 `string`.
- [ ] `pnpm nx affected -t lint typecheck test --base=main` is green (this is the
      affected set for a `libs/shared/domain` change; identical target set to
      task step 4).
- [ ] No secret is read or written (none is needed).
- [ ] PR description records the exact verification commands run.

## Risks

- **Provisional shapes: `notificationPrefs`, `TitleMetadata`, `NotificationPayload`.**
  PLAN §4 leaves `notificationPrefs: { ... }`, `metadata: { ... }`, and
  `payload: { ... }` open. This spec defines **sensible minimal, typed** shapes
  (not `any`/`unknown`) so consumers compile today, but their detailed fields
  firm up when the consuming slices are specced — `NotificationPrefs` /
  `NotificationPayload` with **dispatch-notifications** (PLAN §6 item 14),
  `TitleMetadata` with **sync-titles** (item 11) and **title-detail** (item 19).
  Those specs extend these interfaces **in this lib** (additive fields), not by
  redefining them elsewhere. Flagged so a later spec author expects to edit
  `shared/domain` rather than fork the shape.
- **ISO-string vs Firestore `Timestamp` boundary.** Choosing ISO 8601 strings
  here keeps `shared/domain` Firebase-free and importable by both scopes, but it
  **moves the burden to spec 0004's converters**, which must translate
  `Timestamp` ↔ `string` on every read/write. This is intentional and stated in
  the Public types / APIs contract; the risk is a converter that forgets a field
  or a slice that writes a non-ISO string. Mitigation: converters are the single
  serialization point (spec 0004), and a converter round-trip test there guards
  it. (A runtime ISO-format guard is explicitly out of scope here — no runtime
  logic in this lib.)
- **`Region` is a closed union.** Adding a streaming region later requires adding
  a member to `REGIONS` (a one-line change here that propagates to every
  consumer via the derived type) — by design (PLAN §2 "Multi-region from day
  one"). Trade-off accepted: a closed set gives exhaustiveness checks and a typed
  picker, at the cost of a code change (not a config/data change) to add a
  region. Not a PLAN conflict.
- **`Episode` value type vs `EpisodeDoc`.** Two related shapes exist: `Episode`
  (the persistence-agnostic value: season/episode/airDate) and `EpisodeDoc` (the
  Firestore document adding `watched`/`watchedAt`). This is deliberate — the
  watched-progress fields are document state, not intrinsic episode data — and is
  not duplication to DRY away. More broadly: `Movie`/`Show`/`Title` and the
  standalone `Episode` value type are the **in-memory domain vocabulary** consumed
  by slices (search results, view models, transient data), **not** referenced by
  any Firestore document interface — the persisted docs are `WatchlistItem` and
  `EpisodeDoc`. So the entity types and the document types are two intentionally
  distinct layers; the `Title` union being unreferenced by a doc shape is expected,
  not an unused-type smell. Noted so a reviewer does not flag it.
- **No PLAN conflicts identified.** This spec implements PLAN §6 item 5 as
  written and follows PLAN §4 field-for-field (timestamps re-typed as ISO
  strings, which is a serialization choice, not a model change). The only
  expansion beyond item 5's named list (`Show`, `Movie`, `Episode`,
  `WatchProvider`, `Region`, `NotificationKind`) is the full set of Firestore
  document interfaces, which PLAN §4 requires and which unblocks spec 0004 — a
  scope decision settled in the interview, not an architecture change.
