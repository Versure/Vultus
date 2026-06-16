---
number: 0001
slug: bootstrap-workspace
title: Bootstrap the Nx workspace with Sheriff module boundaries enforced
status: implementing
slices: []
scopes: [scope:shared, scope:mobile, scope:functions]
created: 2026-06-16
---

# Bootstrap the Nx workspace with Sheriff module boundaries enforced

## Context

Vultus is a docs-only repository today: `docs/PLAN.md`, `CLAUDE.md`, and the
spec skeleton exist, but no Nx workspace, no `package.json`, no build/lint/test
tooling. Every subsequent feature spec assumes a working Nx monorepo with the
vertical-slice architecture from PLAN §3 already in place and enforced.

This is the first spec. It covers PLAN §6 foundation items **1 (Bootstrap Nx
workspace)** and **2 (Add Sheriff and configure tags)** **together**. Sheriff is
not a separable feature — it *is* the definition of the vertical-slice
architecture (PLAN §3, "Cross-slice imports are forbidden by Sheriff"). Shipping
the workspace without the boundary rules opens a window in which the agent's
documented over-DRY tendency (PLAN §3, CLAUDE.md) goes unchecked across the next
several specs. Combining them keeps the boundary contract live from the first
line of real code, and the combined work is still one-session-sized because both
items are scaffolding + config rather than feature logic.

The intended outcome: a contributor (human or agent) can clone the repo, run
`pnpm install`, and have `nx build`, `nx lint` (Sheriff included), and `nx test`
all succeed against a workspace whose structure matches the apps + shared-libs
subset of PLAN §3, with the cross-scope import ban proven by an automated test
that fails CI if Sheriff ever stops enforcing it.

The workspace **must be scaffolded on the latest stable versions available when
this is implemented** — Nx, Angular, Ionic, Capacitor, the Firebase Functions
Node SDK (and its targeted Node LTS runtime), and `@softarc/sheriff` /
`@softarc/eslint-plugin-sheriff`. Use the current `create-nx-workspace` and the
latest generators rather than an older toolchain or a pinned-old preset; do not
reach for a conservative/legacy version. (See **Scope** for the explicit
requirement and **Risks** for how "latest" reconciles with version pinning.)

## Scope

In scope:

- Scaffold the workspace on the **latest stable versions available when this is
  implemented** — Nx, Angular, Ionic, Capacitor, the Firebase Functions Node SDK
  (and the targeted Node LTS runtime), and `@softarc/sheriff` /
  `@softarc/eslint-plugin-sheriff`. Use the current `create-nx-workspace` /
  latest generators; do not use a pinned-old preset or a deliberately
  conservative toolchain. (Reproducibility is handled by pinning the *resolved*
  versions — see **Risks**.)
- Initialize an Nx workspace at the repo root using **pnpm** as the package
  manager (Nx `packageManager` setting = pnpm; `pnpm-lock.yaml` committed).
- Generate `apps/mobile` — Ionic + Angular (Capacitor) shell, tagged
  `scope:mobile`.
- Generate `apps/functions` — Firebase Cloud Functions TypeScript entry point,
  tagged `scope:functions`.
- Generate the three shared placeholder libs, each tagged `scope:shared`:
  - `libs/shared/domain`
  - `libs/shared/firestore-schema`
  - `libs/shared/ui-kit`
  Each is an empty barrel (`index.ts` exporting nothing meaningful yet) — no
  domain logic, converters, or components. Those arrive in specs 0005 / 0006 and
  the slice specs.
- Author `sheriff.config.ts` at the repo root encoding the full scope/slice tag
  vocabulary and the four boundary rules from PLAN §3.
- Wire Sheriff into `nx lint` (via `@softarc/eslint-plugin-sheriff` /
  ESLint flat config) so `nx lint` fails on a boundary violation.
- Configure TypeScript path aliases so the shared libs resolve via import
  aliases (e.g. `@vultus/shared/domain`).
- Add a **permanent negative test** that plants a `scope:mobile → scope:functions`
  illegal import in an isolated fixture and asserts Sheriff reports that specific
  violation, without breaking the default `nx lint` / `nx build` of production
  code.

Out of scope (each is its own later spec / manual step):

- **CI pipeline / GitHub Actions** — PLAN §6 item 3. This spec only ensures
  `nx lint` includes Sheriff locally; no `.github/workflows/*` is authored here.
- **Firebase project, `firebase.json`, `firestore.rules`,
  `firestore.indexes.json`, emulators** — PLAN §6 item 4 / §7.
- **Domain type definitions** (`Show`, `Movie`, `Episode`, …) — PLAN §6 item 5.
  The `shared/domain` lib is an empty placeholder here.
- **Firestore schema converters / query helpers** — PLAN §6 item 6.
  `shared/firestore-schema` is an empty placeholder.
- **The six slice libs** (`watchlist`, `search`, `title-detail`, `settings`,
  `sync-titles`, `dispatch-notifications`) — each arrives in its own feature
  spec. Their slice tags are *declared as vocabulary* in `sheriff.config.ts`, but
  no slice lib is generated here.
- **Any real feature/slice code, real UI screens, Capacitor Android native
  build** (PLAN §6 item 21).
- **Secrets** — none are needed for this spec. If any bootstrap step appears to
  require a secret (it should not), the implementer must stop and flag it rather
  than inventing one.

## Affected slices & Sheriff tags

No slice is built in this spec (`slices: []`). The work touches all three scopes
at the foundation level:

| Project | Path | Sheriff tags |
|---|---|---|
| mobile app | `apps/mobile` | `scope:mobile` |
| functions app | `apps/functions` | `scope:functions` |
| shared domain | `libs/shared/domain` | `scope:shared` |
| shared firestore-schema | `libs/shared/firestore-schema` | `scope:shared` |
| shared ui-kit | `libs/shared/ui-kit` | `scope:shared` |

**Slice tag vocabulary** declared in `sheriff.config.ts` for future use (no lib
carries these yet): `slice:watchlist`, `slice:search`, `slice:title-detail`,
`slice:settings`, `slice:sync-titles`, `slice:dispatch-notifications`.

**Boundary rules** (PLAN §3 §"Rules", encoded in `sheriff.config.ts`):

1. `scope:mobile` cannot import `scope:functions`, and vice versa.
2. A slice cannot import another slice (`slice:*` may not import a different
   `slice:*`). Slices communicate only through `scope:shared`.
3. `apps/*` may import `scope:shared` and slices within their own scope only.
4. Anything may import `scope:shared`.

No cross-slice imports are required by this spec, and no shared code is being
extracted (the shared libs are empty placeholders, generated up front because
PLAN §3 names them as the fixed `scope:shared` surface — this is structure, not a
premature 3+-slice extraction).

## Data model touchpoints

None. This spec creates no Firestore collections, fields, converters, or
security rules. PLAN §4 is untouched (the `firestore-schema` lib that will
encode §4 is an empty placeholder here; converters are PLAN §6 item 6).

## Public types / APIs

No domain types, function signatures, HTTP endpoints, or callable shapes are
defined. The only public surface introduced is the **import-alias vocabulary**
that later specs will consume (exact alias strings are fixed here so later specs
can rely on them):

- `@vultus/shared/domain` → `libs/shared/domain/src/index.ts`
- `@vultus/shared/firestore-schema` → `libs/shared/firestore-schema/src/index.ts`
- `@vultus/shared/ui-kit` → `libs/shared/ui-kit/src/index.ts`

(Use the workspace npm scope produced by the Nx init; `@vultus/*` is the
expected scope. If `create-nx-workspace` derives a different scope, the
implementer keeps the generator default and records the actual scope in the spec
PR description, but must keep the `shared/<name>` path segment.)

Each `index.ts` is an empty barrel — it may contain a single placeholder export
or comment so the file is non-empty and lints cleanly, with no behavior.

## UI / Stitch screen refs

Not applicable. No mobile screens are built in this spec; `apps/mobile` is the
generated Ionic shell only (whatever default page the Ionic/Angular generator
produces). The `shared/ui-kit` theming contract against the Stitch "Vultus
Design System" (PLAN §2) is deferred to the spec that first builds UI atoms.

## Implementation task graph

All work is root-config and new-project generation, where each step depends on
the artifacts of the previous one (the workspace must exist before projects;
projects must exist before they can be tagged; tags must exist before Sheriff
rules reference them; rules must exist before the negative test asserts them).
There is **no genuinely parallel work** in this spec — do not invent any. All
tasks are `[sequential]` and run by a single infrastructure engineer.

1. **[sequential] Initialize the Nx workspace with pnpm.**
   - Run `create-nx-workspace` (or `nx init`) producing an integrated monorepo
     at the repo root, alongside the existing `docs/` and `CLAUDE.md`. Use the
     **latest stable** `create-nx-workspace` and generators available at
     implementation time (latest stable Nx, Angular, Ionic, Capacitor, Firebase
     Functions Node SDK + Node LTS runtime, and `@softarc/*`) — do not pin to an
     older preset. Then **pin the resolved versions** for reproducibility (see
     `pnpm install` step and Risks).
   - Set the package manager to pnpm (`--packageManager=pnpm`); ensure
     `nx.json` / generated config records pnpm, generate `pnpm-lock.yaml`, and
     commit it.
   - Add the Angular/Ionic and Node plugins needed for the apps below.
   - Files: `package.json`, `pnpm-lock.yaml`, `nx.json`, `tsconfig.base.json`,
     `.gitignore` (Nx defaults), root ESLint/Prettier config, `.nx/`.

2. **[sequential] Generate `apps/mobile` (Ionic + Angular / Capacitor shell).**
   - Use the Nx Angular/Ionic generator; keep the default shell page.
   - Do **not** rely on `project.json` `tags` for boundary enforcement — Sheriff
     reads its own `sheriff.config.ts` and is the single source of truth for
     scope/slice tags (assigned by path-glob in task 5). If the generator emits
     `tags` in `project.json`, leave or remove them, but they are not the
     enforcement mechanism.
   - Files: `apps/mobile/**`.

3. **[sequential] Generate `apps/functions` (Firebase Cloud Functions, TS).**
   - Use an Nx Node application generator configured for a Firebase Functions
     TypeScript entry point (an `index.ts` exporting placeholder handlers is
     fine; no real handlers). Do **not** create `firebase.json` / emulators —
     that is item 4 (a later spec).
   - As with `apps/mobile`, the `scope:functions` tag is assigned by Sheriff
     path-glob in task 5, not via `project.json` `tags`.
   - Files: `apps/functions/**`.

4. **[sequential] Generate the three shared placeholder libs.**
   - `libs/shared/domain`, `libs/shared/firestore-schema`, `libs/shared/ui-kit`,
     each a buildable lib with an empty barrel `src/index.ts`.
   - The `scope:shared` tag is assigned by Sheriff path-glob in task 5 (e.g. a
     `libs/shared/**` key), not via `project.json` `tags`.
   - Ensure each is wired into `tsconfig.base.json` `paths` as
     `@vultus/shared/<name>` → `libs/shared/<name>/src/index.ts`.
   - Files: `libs/shared/domain/**`, `libs/shared/firestore-schema/**`,
     `libs/shared/ui-kit/**`, and the `paths` block of `tsconfig.base.json`.

5. **[sequential] Author `sheriff.config.ts` and wire it into `nx lint`.**
   - Encode the scope tags, the full slice-tag vocabulary, and the four boundary
     rules above. **`sheriff.config.ts` is the single source of truth for all
     scope/slice tags** — assign every tag via path-glob keys in the Sheriff
     `tagging` config (e.g. `apps/mobile` → `scope:mobile`, `apps/functions` →
     `scope:functions`, `libs/shared/**` → `scope:shared`), not via Nx
     `project.json` `tags`. Path-glob tagging also makes the planned future
     `libs/mobile/*` and `libs/functions/*` slice libs inherit the correct
     `scope:` tag automatically when generated.
   - Add `@softarc/eslint-plugin-sheriff` to the root ESLint config so the
     `dependency-rules` (and, if used, `encapsulation`) checks run as part of
     `nx lint` for every project. Verify production code is boundary-clean so the
     default `nx lint` is green.
   - Files: `sheriff.config.ts`, root ESLint config (e.g. `eslint.config.mjs` /
     `.eslintrc` per the Nx version generated), `package.json` (Sheriff dep).

6. **[sequential] Add the permanent Sheriff negative test.**
   - Create an **isolated fixture** containing a `scope:mobile → scope:functions`
     import that violates rule 1. The fixture must NOT be picked up by the
     default `nx lint` or `nx build` of production code — isolate it via a
     dedicated directory excluded from the apps' `tsconfig`/lint `include`
     globs (e.g. `tools/sheriff-fixtures/illegal-cross-scope-import.ts`, with the
     directory excluded from all project lint targets).
   - Add an automated test (Jest) that **programmatically invokes ESLint with the
     Sheriff plugin** on the fixture file and asserts the result contains at least
     one violation for the Sheriff boundary rule id (e.g.
     `@softarc/sheriff/dependency-rule`) — assert a **non-empty count of messages
     carrying that `ruleId`**, not an exact match on the human-readable message
     string, since Sheriff/@softarc message wording can change across versions and
     would break the test on an otherwise-correct upgrade. The test **passes when
     the violation is reported** and **fails if Sheriff stops reporting it** —
     making the rule verified on every CI run. Place this test under a small
     `tools` or
     `e2e`-style project so `nx test` runs it; document the exact target name in
     the PR.
   - Files: `tools/sheriff-fixtures/**`, the negative-test project
     (`tools/sheriff-test/**` or equivalent) and its `project.json`/jest config,
     plus any `tsconfig`/lint `exclude` entries needed to isolate the fixture.

7. **[sequential] Verify the definition-of-done gates locally.**
   - Run `pnpm install`, `nx build mobile`, `nx build functions`,
     `nx lint` (all projects), and `nx test` (including the negative test).
     All green. Record the commands run in the PR description.

## Test plan

Per the PLAN §5 pyramid, tailored — this is foundation work, so the test surface
is small and deliberate:

- **Unit / config tests:**
  - **Sheriff negative test (the centerpiece):** programmatic-ESLint test
    asserting the planted `scope:mobile → scope:functions` import yields a
    non-empty count of messages carrying the Sheriff `dependency-rule` `ruleId`
    (asserting on the rule id, not the exact message text, so a version upgrade
    that rewords the message does not break the test). This is a permanent guard,
    not a one-off.
  - Any smoke/unit test the Nx app and lib generators emit by default (kept
    green; not expanded).
- **Component tests:** none — no non-trivial UI is built (the mobile shell is the
  generated default page, pure presentational).
- **e2e tests:** none — Playwright + emulator e2e setup is PLAN §6 item 20, a
  separate spec. The workspace structure should not block adding an `e2e`
  project later, but no e2e is authored here.

## Definition of done

Tailored from the PLAN §5 checklist:

- [ ] `pnpm install` resolves cleanly and `pnpm-lock.yaml` is committed.
- [ ] `nx build mobile` and `nx build functions` pass.
- [ ] `nx lint` passes for all projects, with Sheriff active — production code is
      boundary-clean.
- [ ] `nx test` passes, including the Sheriff negative test that asserts the
      planted `scope:mobile → scope:functions` import is rejected.
- [ ] TypeScript path aliases resolve the three shared libs (npm scope per the
      recorded workspace scope; the `shared/<name>` path segment exact —
      `shared/domain`, `shared/firestore-schema`, `shared/ui-kit`).
- [ ] Workspace structure matches the apps + shared-libs subset of PLAN §3; no
      slice libs are generated, but all slice tags are declared in
      `sheriff.config.ts`.
- [ ] `sheriff.config.ts` encodes all four boundary rules and the full scope +
      slice tag vocabulary.
- [ ] No secret is read or written; if a step appeared to need one, it is flagged
      in the PR rather than worked around.
- [ ] PR description records the exact verification commands run and the actual
      npm scope chosen if it differs from `@vultus`.

## Risks

- **Generator drift vs PLAN §3 paths.** Nx/Ionic generators may produce slightly
  different default project layouts or an npm scope other than `@vultus`. The
  contract is the `scope/slice` *tags*, the boundary *rules*, and the
  `apps/* + libs/shared/*` path shape — keep those exact; record any
  generator-default deviation (e.g. npm scope) in the PR rather than fighting the
  generator.
- **Isolating the negative-test fixture is the trickiest part.** If the fixture
  is visible to the default lint/build, it will break the green-on-main
  invariant; if it is too isolated, Sheriff may not evaluate it. The chosen
  mechanism — a fixture directory excluded from all project lint/build targets,
  exercised by a programmatic ESLint invocation inside a dedicated test — must be
  implemented exactly so both the negative test passes and `nx lint` / `nx build`
  of real code stays clean. The negative test uses the workspace's own
  (latest-stable, then locked) Sheriff and ESLint versions — it asserts on the
  Sheriff rule id (`@softarc/sheriff/dependency-rule`), not the human-readable
  message string, so it survives `@softarc` upgrades and avoids the "version
  mismatch breaks CI" risk (PLAN §9).
- **Sheriff/Nx version compatibility** (PLAN §9). Install the **latest stable**
  Nx, Angular, Ionic, Capacitor, Firebase Functions Node SDK, and `@softarc/*`
  at implementation time, then **pin the resolved versions** — exact versions in
  `package.json` plus the committed `pnpm-lock.yaml` — so builds are
  reproducible. "Pin" here means *lock what you resolved*, not float and not
  deliberately old: latest-on-install, frozen-after-install. This keeps the
  PLAN §9 "version mismatch breaks CI" mitigation intact (the resolved set is
  locked; later bumps come through renovate-style update PRs, not silent
  floating).
- **Empty `scope:shared` libs and the 3+-slice rule.** Generating three shared
  libs before any slice exists could look like premature sharing (CLAUDE.md /
  PLAN §3 §"When to extract"). This is intentional and *not* a violation: PLAN §3
  names these three as the fixed `scope:shared` surface (`domain`,
  `firestore-schema`, `ui-kit`); they are structural placeholders, populated only
  by their own later specs, not extractions of duplicated slice logic.
- **No PLAN conflicts identified.** This spec implements PLAN §6 items 1–2 as
  written; combining them is a sequencing choice, not an architecture change.
