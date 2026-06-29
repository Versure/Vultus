# Vultus

A personal Movie / TV tracker. Ionic + Angular (Capacitor) mobile app with a
Firebase Cloud Functions backend, in an Nx monorepo with a vertical-slice
architecture enforced by [Sheriff](https://sheriff.softarc.io/).

`docs/PLAN.md` is the source of truth for architecture and decisions.

## Stack

- **Monorepo:** Nx 23 (pnpm)
- **Mobile:** Ionic + Angular 21, Capacitor 8
- **Backend:** Firebase Cloud Functions (TypeScript), firebase-admin
- **Boundaries:** Sheriff (`@softarc/sheriff`), enforced through `nx lint`
- **Unit tests:** Vitest + Analog (`@analogjs/vitest-angular`)
- **e2e:** Playwright (`@nx/playwright`)

## Prerequisites

- Node.js 20 LTS
- pnpm (the configured package manager — `corepack enable` will provide it)

## Getting started

```bash
pnpm install
```

`pnpm install` also installs the Git pre-commit hook (husky), which runs
lint-staged (ESLint `--fix` incl. Sheriff + Prettier) on staged files so a
commit that breaks lint, the module boundaries, or formatting is blocked
locally.

## Common commands

Prefer `nx affected -t <target> --base=main` in day-to-day work.

| Command                                            | What it does                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm nx run mobile:serve-mock`                    | Mock data, **no Firebase dependency** — works offline; quickest UI loop |
| `pnpm nx run mobile:serve-emulator`                | Dev build vs **emulated** Firebase (offline-capable); starts emulators  |
| `pnpm nx run mobile:serve-prod-debug`              | Dev/**debuggable** build vs **REAL prod** Firebase — diagnose prod data |
| `pnpm nx run mobile:serve-prod`                    | **Optimized** prod build vs prod Firebase — final pre-deploy check      |
| `pnpm nx run mobile:android-usb`                   | Build + **install + launch** on a USB-tethered phone                    |
| `pnpm nx build mobile` / `pnpm nx build functions` | Production builds                                                       |
| `pnpm nx run-many -t lint --all`                   | Lint all projects (Sheriff boundaries included)                         |
| `pnpm nx run-many -t test --all`                   | Run unit/config tests (Vitest)                                          |
| `pnpm nx e2e mobile-e2e`                           | Run the Playwright e2e suite against the mobile app                     |

## Workspace structure

```
apps/
  mobile/          Ionic + Angular shell        (scope:mobile)
  mobile-e2e/      Playwright e2e for mobile
  functions/       Firebase Cloud Functions     (scope:functions)
libs/
  shared/
    domain/            shared domain types      (scope:shared)
    firestore-schema/  Firestore converters     (scope:shared)
    ui-kit/            shared UI / theming       (scope:shared)
tools/
  sheriff-test/        permanent Sheriff negative test
  sheriff-fixtures/    isolated boundary-violation fixture (lint/build-excluded)
sheriff.config.ts      single source of truth for scope/slice tags + boundary rules
```

Shared libs resolve via TypeScript path aliases: `@vultus/shared/domain`,
`@vultus/shared/firestore-schema`, `@vultus/shared/ui-kit`.

## Architecture

Each slice owns its UI, state, data, and types; **cross-slice imports are
forbidden** — slices communicate only through `scope:shared`. `scope:mobile` and
`scope:functions` may never import each other. These rules are encoded in
`sheriff.config.ts` and enforced by `nx lint`, with a permanent negative test
(`nx test sheriff-test`) that fails if Sheriff ever stops rejecting an illegal
cross-scope import. See `docs/PLAN.md` §3 for the full rationale.

## CI / scheduled sync configuration

The `Daily sync` workflow (`.github/workflows/daily-sync.yml`) runs on a daily
cron (and can be triggered manually) to POST to the deployed `syncTitles`
endpoint. It requires two pieces of repo config under **Settings → Secrets and
variables → Actions**:

- A repo Actions **variable** `VULTUS_SYNC_URL` — the public `syncTitles`
  endpoint URL (a public value, hence a variable, not a secret).
- A repo Actions **secret** `SYNC_SHARED_SECRET` — the shared secret the
  workflow sends in the `X-Vultus-Sync-Secret` header. The **same**
  `SYNC_SHARED_SECRET` value must also be provisioned on the Cloud Function side
  so the header matches; rotating one without the other breaks the cron.

To dry-run it without waiting for the cron, trigger it manually via
`workflow_dispatch` (Actions → Daily sync → Run workflow). See `docs/PLAN.md`
§7 for the full manual-prerequisite checklist.

## Development workflow

Vultus is built spec-first: a spec file under `docs/specs/NNNN-slug.md`, reviewed
and merged as a PR, is the unit of work (there are no GitHub issues). See
`docs/specs/README.md` for the spec format and `CLAUDE.md` for the standing
instructions and the skill-driven flow.
