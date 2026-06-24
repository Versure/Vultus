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

```sh
# 1. Build the web bundle
pnpm nx run mobile:build

# 2. Sync web assets + plugins into android/
pnpm nx run mobile:sync

# 3. Open Android Studio (requires step 2 to complete first)
pnpm nx run mobile:open
```

Inside Android Studio:

4. Wait for Gradle sync to complete.
5. **Build → Build Bundle(s) / APK(s) → Build APK(s)** — or run from terminal:
   ```sh
   cd android && ./gradlew assembleDebug
   ```
   The debug APK is output to `android/app/build/outputs/apk/debug/app-debug.apk`.
6. **Run → Run 'app'** (with a device connected via USB or an emulator running) to install and launch directly from Android Studio.

> **Debug-only.** There is no signing config, no release flavour, and no Play Store listing in this setup (spec 0020 decision 1). Sideloading the debug APK via Android Studio / ADB is sufficient for v1.

### What `mobile:sync` does

`pnpm nx run mobile:sync` is equivalent to `npx cap sync android`. It:

- Copies the latest web bundle from `dist/apps/mobile/browser` into `android/app/src/main/assets/public`
- Updates `capacitor.config.json` in the native project
- Resolves all Capacitor plugins (`@capacitor/push-notifications`, `@capacitor/splash-screen`, etc.) into the Gradle project

Run this after every web build before opening Android Studio.

## Sheriff scope

Tags: **`scope:mobile`**. This app may import `scope:shared` and `scope:mobile` libs only.
