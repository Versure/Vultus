# mobile

The Vultus mobile app — Ionic + Angular shell wired via Capacitor for Android. It owns routing, environment bootstrapping, and DI root providers; feature UI lives in `libs/mobile/*` slices.

## Local dev

### Prerequisites

- Node 20, pnpm 9
- Firebase emulators running (`pnpm emulators` from the repo root) for Auth + Firestore
- Optional: a real TMDB API key in `.env.local` for live search

### Start the dev server (mock data, no real API key needed)

```sh
pnpm nx serve mobile --configuration=mock
```

The mock configuration intercepts TMDB fetch calls and returns fixture data (see `libs/mobile/search/README.md`). Firebase still connects to the local emulator.

### Start with live TMDB search

1. Add your key to `.env.local` (gitignored) at the repo root:

   ```
   TMDB_API_KEY=your_key_here
   ```

2. Sync the key into the dev environment file:

   ```sh
   pnpm env:tmdb
   ```

3. Start the dev server:

   ```sh
   pnpm nx serve mobile
   ```

> `pnpm env:tmdb` patches `apps/mobile/src/environments/environment.ts` in place. The file is gitignored by the underlying env mechanism and the key is never committed.

## Environment files

| File                    | Used when           | Key source            |
| ----------------------- | ------------------- | --------------------- |
| `environment.ts`        | `nx serve mobile`   | `pnpm env:tmdb` or manual |
| `environment.mock.ts`   | `--configuration=mock` | n/a (mocked)       |
| `environment.prod.ts`   | `nx build` (CI)     | `TMDB_API_KEY` GitHub Actions secret |

## Production builds

Production builds run in CI only. The `TMDB_API_KEY` GitHub Actions secret is injected into `environment.prod.ts` by a workflow step before `nx build` runs. See `.github/workflows/ci.yml` for the injection step and `docs/PLAN.md` §7 for required secrets.

## Sheriff scope

Tags: **`scope:mobile`**. This app may import `scope:shared` and `scope:mobile` libs only.
