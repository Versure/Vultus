---
number: 0015
slug: tmdb-ci-key-injection
title: Wire TMDB API key injection for CI/CD and local dev
status: draft
slices: []
scopes: [scope:mobile]
created: 2026-06-22
---

# Wire TMDB API key injection for CI/CD and local dev

## Context

Spec 0013 (search slice) landed the mobile TMDB search client with placeholder keys:

- `apps/mobile/src/environments/environment.ts` — empty `auth.apiKey: ''` (dev placeholder, populated manually from `.env.local`)
- `apps/mobile/src/environments/environment.prod.ts` — `REPLACE_WITH_REAL_TMDB_API_KEY` placeholder, intended to be substituted by CI before production build

Until this spec is implemented:

- The search feature works in dev only after manually copying a key from `.env.local` into `environment.ts`.
- Production builds ship a broken placeholder — TMDB search does not work in production.

## Scope

In scope:

- **CI key substitution**: add a step to `.github/workflows/ci.yml` that runs before `nx build mobile --configuration=production`, replacing `REPLACE_WITH_REAL_TMDB_API_KEY` in `environment.prod.ts` with the value of the `TMDB_API_KEY` GitHub Actions secret (via `sed` or `envsubst`).
- **Local dev script**: add an `npm run env:tmdb` (or `pnpm env:tmdb`) helper script that copies `TMDB_API_KEY` from `.env.local` into `environment.ts` so `nx serve mobile` works without manual editing. Document this in `apps/mobile/README.md` and `libs/mobile/search/README.md`.
- **Validate the key is present**: the CI step should fail fast if `TMDB_API_KEY` is not set, rather than silently shipping a broken build.

Out of scope:

- Moving TMDB calls to a Cloud Function proxy (option 1, rejected in spec 0013 Risks — user confirmed option 2: key in client bundle is accepted for v1).
- Rotating or managing TMDB keys (ops concern).

## Definition of done

- [ ] `nx build mobile --configuration=production` in CI substitutes the real key (verified by checking the built `main.js` does **not** contain `REPLACE_WITH_REAL_TMDB_API_KEY`).
- [ ] Local dev: a single documented command syncs the key from `.env.local` → `environment.ts`.
- [ ] The `TMDB_API_KEY` GitHub Actions secret is documented in the repo README or `docs/PLAN.md` as a required secret for production builds.
- [ ] `.env.local` remains gitignored; no real key is committed.
