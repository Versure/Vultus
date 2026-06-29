# mobile

The Vultus mobile app — Ionic + Angular shell wired via Capacitor for Android. It owns routing, environment bootstrapping, and DI root providers; feature UI lives in `libs/mobile/*` slices.

## Shell services

- **`NotificationHandlerService`** (`src/app/notification-handler.service.ts`, spec 0041) — registers the Capacitor `PushNotifications` listeners for incoming FCM messages. A foreground arrival shows an Ionic toast with a "View" action; tapping a delivered notification (background/cold-start) deep-links to `tabs/title-detail/:tmdbId` and marks the matching `users/{uid}/notifications/{id}` doc read (best-effort — a Firestore failure never blocks navigation). Native-only (a no-op in the browser/dev-server) and idempotent. Lives in the shell, not a slice, because it owns cross-cutting navigation; it deep-links by `Router` string segments rather than importing the title-detail slice (Sheriff: `scope:mobile` must not import `slice:*`). Wired from `App.ngOnInit()`.

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

| File                  | Used when              | Key source                           |
| --------------------- | ---------------------- | ------------------------------------ |
| `environment.ts`      | `nx serve mobile`      | `pnpm env:tmdb` or manual            |
| `environment.mock.ts` | `--configuration=mock` | n/a (mocked)                         |
| `environment.prod.ts` | `nx build` (CI)        | `TMDB_API_KEY` GitHub Actions secret |

## Production builds

Production builds run in CI only. The `TMDB_API_KEY` GitHub Actions secret is injected into `environment.prod.ts` by a workflow step before `nx build` runs. See `.github/workflows/ci.yml` for the injection step and `docs/PLAN.md` §7 for required secrets.

## Android native build (debug APK)

### Manual prerequisites

1. **Android Studio + Android SDK** — install from https://developer.android.com/studio.
   The Gradle build runs entirely inside Android Studio; no separate SDK install is required beyond what Android Studio provides.

2. **`google-services.json`** — download from the Firebase console and commit it:
   - Open [Firebase console](https://console.firebase.google.com/) → project **`vultus-cab62`**
   - Project settings → Your apps → Android app (package: `app.vultus.mobile`)
   - Click **Download google-services.json** and place the file at:
     ```
     android/app/google-services.json
     ```
   - **Commit the file** — it contains only public client identifiers (project id, app id, public API key, GCM sender id); no private key. Committing is the standard, recommended Firebase Android setup.
   - If the Android app does not yet exist in the console, register it first: Add app → Android → package name `app.vultus.mobile`.

### Build flow

The one-command device path builds, installs, and launches the debug APK on a
USB-connected phone:

```sh
pnpm nx run mobile:android-usb
```

It runs, in order: inject env → `--check-native` preflight → `mobile:build`
(production) → `npx cap sync android` → `npx cap run android` (which builds,
installs, and launches on the connected device). The phone must be in developer
mode with USB debugging enabled and visible to `adb devices`. See
`docs/setup/debug-apk-setup.md` for the full prerequisite + verification checklist.

To open the native project in Android Studio manually instead, run the raw
`npx cap open android` (there is no dedicated Nx target for this), then **Build →
Build APK(s)** or **Run → Run 'app'**.

> **Debug-only.** There is no signing config, no release flavour, and no Play Store listing in this setup (spec 0020 decision 1). Sideloading the debug APK via `cap run` / Android Studio / ADB is sufficient for v1.

### What `mobile:sync` does

`pnpm nx run mobile:sync` is equivalent to `npx cap sync android`. It:

- Copies the latest web bundle from `dist/apps/mobile/browser` into `android/app/src/main/assets/public`
- Updates `capacitor.config.json` in the native project
- Resolves all Capacitor plugins (`@capacitor/push-notifications`, `@capacitor/splash-screen`, etc.) into the Gradle project

Run this after every web build before opening Android Studio.

## Run / build targets

Five self-documenting scenario targets cover the common ways to run the app:

| Target                                | What it does / when to use                                              |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm nx run mobile:serve-mock`       | Mock data, **no Firebase dependency** — works offline; quickest UI loop |
| `pnpm nx run mobile:serve-emulator`   | Dev build vs **emulated** Firebase (offline-capable); starts emulators  |
| `pnpm nx run mobile:serve-prod-debug` | Dev/**debuggable** build vs **REAL prod** Firebase — diagnose prod data |
| `pnpm nx run mobile:serve-prod`       | **Optimized** prod build vs prod Firebase — final pre-deploy check      |
| `pnpm nx run mobile:android-usb`      | Build + **install + launch** on a USB-tethered phone                    |

These build on a small set of kept primitives: **`build`** (Angular application
build; default `production`), **`serve`** (raw dev-server, default `development` —
used by the e2e web server, do not change its default), **`sync`**
(`npx cap sync android`), and **`inject-env`** (generate
`environment.generated.ts` from `.env.local`).

> `serve-prod-debug`, `serve-prod`, and `android-usb` **require a populated
> `.env.local`** (repo root). `inject-mobile-env.mjs` runs first and **fails
> loudly (exit 1) naming the missing key** if any `TMDB_API_KEY` / `FIREBASE_*`
> value is absent.

## Sheriff scope

Tags: **`scope:mobile`**. This app may import `scope:shared` and `scope:mobile` libs only.
