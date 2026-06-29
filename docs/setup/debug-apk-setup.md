# Debug APK setup — production parity (spec 0026)

A locally- (or CI-) built **debug-signed** Android APK can behave like
production: it searches real TMDB, reads/writes the real Firebase project
`vultus-cab62`, populates provider-availability badges, and receives push — while
**every committed file stays free of secrets and key-shaped values**. Real values
are injected at build time into a **gitignored generated env file** consumed via
Angular `fileReplacements`, and `android/app/google-services.json` is **untracked**
and re-sourced per machine / in CI.

> Backend note: the debug APK talks to the **same** Firebase project the deployed
> functions live in (`vultus-cab62`). Debug data mixing into prod Firestore is
> accepted (single-user personal tracker). There is no separate dev project.

## 1. Manual local prereqs

### a. The local env file

Create a gitignored **`.env.local` at the repo root** (already covered by the
root `.gitignore` `.env.local` / `.env*.local` rules — never commit it). It holds
`KEY=VALUE` lines for:

| Key                            | What it is                                 | Where to get it                                                     |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------- |
| `TMDB_API_KEY`                 | TMDB API key (a real secret)               | Your TMDB account → API                                             |
| `FIREBASE_API_KEY`             | Firebase web `apiKey` (public, key-shaped) | Firebase console → Project settings → Your apps → Web app SDK setup |
| `FIREBASE_AUTH_DOMAIN`         | Firebase web `authDomain`                  | same SDK config                                                     |
| `FIREBASE_STORAGE_BUCKET`      | Firebase web `storageBucket`               | same SDK config                                                     |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase web `messagingSenderId`           | same SDK config                                                     |
| `FIREBASE_APP_ID`              | Firebase web `appId`                       | same SDK config                                                     |

`projectId` is **not** injected — it is hardcoded to `vultus-cab62` in the
injection script and both committed env files.

The Firebase **web** config is public-by-design (it ships in every web client);
it is injected here only for **repo cleanliness** (a uniformly key-free working
tree), not for security. Firestore security rules are the real gate.

### b. `android/app/google-services.json`

The native (APK) build needs `android/app/google-services.json` for the Firebase
Android config.

- **Existing clones** already have the working-copy file on disk — spec 0026's
  untrack was index-only (`git rm --cached`), so it was **not** deleted from disk.
- **New clones** must download it from the Firebase console → Project settings →
  Your apps → the **Android app `app.vultus.mobile`** (project `vultus-cab62`) and
  place it at `android/app/google-services.json`.

The file is **gitignored** going forward (see §3), so each machine provisions it
once. If it is missing at native-build time the build **fails loudly** via the
`--check-native` preflight guard (it never reaches Gradle's silent-degrade path).

## 2. CI secrets / variables

The CI build injects the same values from GitHub Actions
(Settings → Secrets and variables → Actions):

- `TMDB_API_KEY`
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `GOOGLE_SERVICES_JSON` — the **base64-encoded** `google-services.json`, decoded
  to `android/app/google-services.json` before a native (APK) build.

The CI **web** build gate (`ci.yml`) exercises the env injection + loud guard but
does **not** need `google-services.json` (that is a native-build artifact). There
is currently **no** CI APK workflow — device verification is human/local.

## 3. PLAN §7 deviation — `google-services.json` untracked

PLAN §7 instructs **committing** `google-services.json` as public client config,
and spec 0020 did commit it. Spec 0026 **deliberately overrides** that:
`google-services.json` is now **untracked** (`git rm --cached`) and **gitignored**
(`android/.gitignore`), re-sourced per machine and in CI.

- **Reason:** repo uniformity — a working tree with **no** key-shaped values going
  forward (user preference). The committed value is a Firebase **Android `api_key`**,
  which is **public-by-design** client config (like the web `apiKey`, it is not a
  private credential). So this is a **repo-uniformity preference, not a security
  necessity**.
- **Decision 5 — no history scrub, no key rotation.** The public Android `api_key`
  **remains in past git history** by deliberate decision. A history rewrite has low
  security value (the value is public-by-design) and would disrupt open branches.
  A reader who finds the value in `git log` should know it is **intentional and
  harmless** — do **not** treat it as a leak requiring remediation, and do **not**
  re-commit `google-services.json` (PLAN §7's "commit it" instruction is
  superseded here).

## 4. Build + install on a USB device

> **USB device prerequisite.** Before running `android-usb` the phone must be in
> **developer mode** with **USB debugging enabled**, connected over USB, and
> visible to `adb devices` (it should appear in the list as `device`, not
> `unauthorized` — accept the "Allow USB debugging" prompt on the phone). With no
> target attached `npx cap run android` errors loudly; this is expected.

```powershell
pnpm nx run mobile:android-usb
```

This Nx target runs, in order:

1. `node tools/scripts/inject-mobile-env.mjs` — injects + loud-guards the env.
2. `node tools/scripts/inject-mobile-env.mjs --check-native` — asserts
   `android/app/google-services.json` exists (loud guard before the build).
3. `pnpm nx run mobile:build` — the production web build (uses the generated env).
4. `npx cap sync android` — copies web assets + plugin config into the native
   project (does **not** clobber `google-services.json`).
5. `npx cap run android` — builds the debug-signed APK, then **installs and
   launches it on the connected USB device** in one step (no separate manual
   sideload / Android-Studio step).

To open the native project in Android Studio manually instead (no dedicated Nx
target), run the raw `npx cap open android`.

To only (re)generate the env file without building:

```powershell
pnpm nx run mobile:inject-env
```

## 5. Human device-verification checklist (post-merge, physical device)

Cannot run in CI — needs a real Android device, real credentials, and merged
spec 0022 (FCM registration, now merged). This is the **real functional
verification**:

- [ ] Populate `.env.local` (`TMDB_API_KEY`, `FIREBASE_*`) and ensure
      `android/app/google-services.json` for `vultus-cab62` is present.
- [ ] Run `pnpm nx run mobile:android-usb` — it builds, installs, and launches
      the debug APK on the connected USB device directly (no manual sideload).
- [ ] App **boots** against real `vultus-cab62` (anonymous sign-in succeeds).
- [ ] **Onboarding (0022):** pick region + grant push permission → FCM token
      written to `users/{uid}.fcmTokens`.
- [ ] **Search** returns real **TMDB** results.
- [ ] **Add to watchlist** persists (visible in `users/{uid}/watchlist`).
- [ ] Trigger a sync (manual trigger if available, else the daily cron) →
      **provider-availability badges populate** from
      `title-cache/{tmdbId}/availability/{region}`.
- [ ] An availability change delivers a **real push** on the device (via the
      deployed `dispatchNotifications`).
