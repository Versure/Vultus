# Manual setup — Firebase, API keys & secrets

This is the one-time, **human-only** setup that Claude Code cannot do for you
(it can't create cloud accounts, click consoles, or hold secrets). It expands
PLAN §2/§4/§7 and the secrets table in PLAN §5 into concrete steps.

> **Why this exists now.** Spec 0003 (domain types) and 0004 (firestore-schema)
> need none of this — they're pure TypeScript. But the Firebase + emulators spec
> and every backend slice (TMDB/Trakt clients, sync engine, FCM dispatch) are
> blocked on it. Doing it now means those specs aren't gated when we get there.

## TL;DR — what you end up with

| Thing                          | Where you create it         | Where it lives afterward                                       |
| ------------------------------ | --------------------------- | -------------------------------------------------------------- |
| Firebase project               | console.firebase.google.com | `.firebaserc` (project id, committed)                          |
| Firestore database             | Firebase console            | `firestore.rules` / `firestore.indexes.json` (committed)       |
| Anonymous Auth enabled         | Firebase console            | — (a console toggle, nothing in repo)                          |
| Cloud Messaging (FCM)          | Firebase console            | server key used by functions config                            |
| Firebase **web app** config    | Firebase console            | `apps/mobile` env (the 6 `FIREBASE_*` values — **not secret**) |
| TMDB API key                   | themoviedb.org              | `.env.local` + GitHub secret + functions config                |
| Trakt client ID                | trakt.tv                    | `.env.local` + GitHub secret + functions config                |
| Sync shared secret             | you generate it             | `.env.local` + GitHub secret + functions config                |
| (later) deploy service account | Google Cloud console        | GitHub secret only                                             |

**Hard rule:** the three real secrets (TMDB key, Trakt id, sync secret) and any
service-account JSON go in `.env.local` (now gitignored), GitHub Actions
secrets, and Firebase functions config — **never** in committed source. Claude
Code is instructed never to read or write `.env.local`.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**.
2. Name it (e.g. `vultus`). Note the **Project ID** it generates
   (e.g. `vultus-1a2b3`) — that's the stable identifier we commit to
   `.firebaserc`.
3. Google Analytics: **not needed** for v1 — disable it (one less moving part).

### ⚠️ Spark vs Blaze — read this

PLAN §2 assumes the **Spark (free)** plan + a GitHub Actions cron hitting an
HTTP function. Be aware: current Firebase **Cloud Functions deployment requires
the Blaze (pay-as-you-go) plan** — Spark can no longer deploy functions. Blaze
still has the same generous free monthly allowance and bills €0 under personal
usage, but it **requires a credit card and has no hard spending cap** (you can
set a budget _alert_, not a hard stop).

You have two paths — decide before the functions specs:

- **Blaze + a budget alert** (most likely): enable Blaze, set a low budget
  alert (e.g. €1) so you're notified long before any real cost. This is the
  realistic path for Cloud Functions.
- **Stay on Spark**: then the daily sync can't run as a deployed Cloud Function.
  The fallback is to run the sync logic directly in the GitHub Actions runner
  (Node script using the Firebase Admin SDK) and skip deployed functions
  entirely. This changes the `apps/functions` story and should be reflected in
  the relevant spec.

> **Decision needed from you:** Blaze-with-alert, or Spark-with-Actions-runner?
> Flag it and I'll spec the functions work to match. Until then, specs 0003/0004
> proceed regardless.

## 2. Enable the services

In the Firebase console for the project:

1. **Firestore Database** → Create database → **Production mode** (we ship real
   `firestore.rules`, not test mode) → pick a location. Choose
   **`eur3` (europe-west)** or `europe-west1` for NL latency. _Location is
   permanent — choose deliberately._
2. **Authentication** → Get started → **Sign-in method** → enable **Anonymous**
   (v1 auth per PLAN §2). Leave Email/Password off for now.
3. **Cloud Messaging (FCM)** → it's enabled with the project. You'll use it from
   functions via the Admin SDK; nothing to toggle, but confirm the **Cloud
   Messaging API (V1)** is enabled under Project settings → Cloud Messaging.
4. **Functions**: only relevant once you've chosen Blaze (see §1). Nothing to
   click now beyond the plan decision.

## 3. Get the Firebase **web app** config (for `apps/mobile`)

This is the client SDK config. It is **embedded in the app and is not a
secret** (Firestore security rules are what protect data, not these values) —
but we still keep it out of source via env for cleanliness/portability.

1. Project settings (gear icon) → **General** → _Your apps_ → **Add app** →
   **Web** (`</>`). Nickname `vultus-mobile`. Don't enable Hosting.
2. Copy the `firebaseConfig` object. You need these six values:

   ```
   FIREBASE_API_KEY=...
   FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
   FIREBASE_PROJECT_ID=<project-id>
   FIREBASE_STORAGE_BUCKET=<project-id>.appspot.com
   FIREBASE_MESSAGING_SENDER_ID=...
   FIREBASE_APP_ID=...
   ```

3. For Android push later you'll also add an **Android app** in the same screen
   and download `google-services.json` — but that's the Capacitor/Android spec
   (PLAN §6 item 21), not now.

## 4. API keys you need to sign up for

### TMDB (metadata + watch providers) — required

1. Create an account at <https://www.themoviedb.org>.
2. **Settings → API** → request a **Developer** key (free, instant; describe it
   as a personal, non-commercial project).
3. You'll see two credentials: a **v3 API Key** and a **v4 Read Access Token
   (Bearer)**. Grab **both**; we'll standardize on the **v4 Bearer token**
   (`Authorization: Bearer …`) which is the modern path. Store as:
   ```
   TMDB_API_KEY=<v3 key>
   TMDB_READ_ACCESS_TOKEN=<v4 bearer token>
   ```

### Trakt (calendar / upcoming episodes) — required

1. Create an account at <https://trakt.tv>.
2. <https://trakt.tv/oauth/applications> → **New Application**.
   - Name: `Vultus`
   - Redirect URI: `urn:ietf:wg:oauth:2.0:oob` (we only need the public
     **Client ID** for calendar reads in v1; no user OAuth flow yet).
3. Save and copy the **Client ID** (and Client Secret — keep it for later even
   though v1 calendar reads only need the Client ID):
   ```
   TRAKT_CLIENT_ID=...
   TRAKT_CLIENT_SECRET=...   # not used in v1, store anyway
   ```

### (Optional, later) Watchmode — fallback only

Per PLAN §9 risk register, if TMDB's NL provider accuracy is poor we layer in
Watchmode (1,000 free calls/month). **Don't sign up now** — only if monitoring
shows we need it.

## 5. Generate the sync shared secret

The daily-sync GitHub Action authenticates to the HTTP sync function with a
shared secret (PLAN §5 secrets table). Generate a long random string yourself:

```powershell
# PowerShell — 48 random bytes, base64
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
```

```
SYNC_SHARED_SECRET=<the generated string>
```

## 6. Where each secret goes (the three locations)

PLAN §5 mandates each secret lives in up to three places. Set them up as
follows.

### a) `.env.local` at repo root (local dev)

Now gitignored (this change ships with this doc). Create it yourself — Claude
Code will **not** touch it. Minimal contents:

```dotenv
# Firebase web config (client — not secret, but kept here for local dev)
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=...
FIREBASE_PROJECT_ID=...
FIREBASE_STORAGE_BUCKET=...
FIREBASE_MESSAGING_SENDER_ID=...
FIREBASE_APP_ID=...

# Data-source secrets (functions only)
TMDB_API_KEY=...
TMDB_READ_ACCESS_TOKEN=...
TRAKT_CLIENT_ID=...
TRAKT_CLIENT_SECRET=...

# Sync auth
SYNC_SHARED_SECRET=...
```

### b) GitHub Actions secrets (CI + daily-sync cron)

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add (same names, uppercase):

- `TMDB_API_KEY`, `TMDB_READ_ACCESS_TOKEN`
- `TRAKT_CLIENT_ID`
- `SYNC_SHARED_SECRET`
- _(when CI deploys functions — later)_ `FIREBASE_SERVICE_ACCOUNT` (see §7)

The `FIREBASE_*` web-config values are not secret; they can be plain repo
**Variables** rather than secrets, or baked into the mobile build config in a
later spec.

### c) Firebase functions config (deployed functions)

Only relevant once functions exist and you've chosen Blaze. The modern approach
is **`.env` files / parameterized config** (`firebase functions:config:set` is
deprecated for gen-2). The functions spec will define the exact
`functions/.env` keys; for now just keep the values ready:
`TMDB_READ_ACCESS_TOKEN`, `TRAKT_CLIENT_ID`, `SYNC_SHARED_SECRET`.

## 7. (Later) Service account for CI deploys — not needed yet

Deployment is out of scope of the spec/implement skills (they end at a green,
merged PR). When we add a deploy workflow, you'll create a service account:

Google Cloud console → IAM & Admin → Service Accounts → create one with
**Firebase Admin** / **Cloud Functions Admin** roles → create a JSON key →
paste the whole JSON into the GitHub secret `FIREBASE_SERVICE_ACCOUNT`. The
`*.serviceaccount.json` pattern is gitignored so a local copy never lands in
git. **Skip this until the deploy spec.**

---

## What I need _from you_ vs. what stays with you

- **Stays with you, never shared in chat or committed:** every value in
  `.env.local`, the Trakt client secret, any service-account JSON. I'm
  instructed never to read `.env.local`.
- **What I actually need to write the specs/code:** just _decisions_, not
  secret values —
  1. **Spark vs Blaze** (§1) — drives the functions architecture.
  2. The **Project ID** and **Firestore location** you picked — these are not
     secret; the Project ID gets committed to `.firebaserc`.
  3. Confirmation that **Anonymous Auth** and **Firestore** are enabled.

## Checklist (do these, then tell me #1–#3 above)

- [ ] Firebase project created; Project ID noted
- [ ] Spark-vs-Blaze decision made (§1)
- [ ] Firestore created (production mode, `eur3`/`europe-west1`)
- [ ] Anonymous Auth enabled
- [ ] Cloud Messaging API (V1) confirmed enabled
- [ ] Web app added; six `FIREBASE_*` values copied
- [ ] TMDB key + read-access token obtained
- [ ] Trakt client ID obtained
- [ ] `SYNC_SHARED_SECRET` generated
- [ ] `.env.local` created locally with all of the above
- [ ] GitHub Actions secrets added
- [ ] (deferred) service account — only at deploy time
