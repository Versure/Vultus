---
name: deploy-functions
description: Deploy Vultus Cloud Functions to Firebase from the pnpm/Nx monorepo. Builds + prunes the deployable artifact, runs the deploy-preflight, then `firebase deploy --only functions` — handling the pnpm/gen2 traps (admin peer range, functions-framework, allowBuilds, trigger-type changes). Use when the user wants to deploy, ship, or push the Cloud Functions (syncTitles, dispatchNotifications) to Firebase.
---

# Deploy Functions

Ship `apps/functions` to Firebase project `vultus-cab62`. The deployable unit is
the **pruned `dist/apps/functions`**, installed by Google Cloud Build with
**pnpm** — not the monorepo. Several traps live only on that path and are
invisible to `nx lint/test/build`; this skill front-loads the `deploy-preflight`
gate so they fail locally in seconds instead of after a multi-minute Cloud Build.
(Project-wide rules — shell is PowerShell — are in `CLAUDE.md`. Full back-story:
the `functions-deploy-pnpm-recipe` memo.)

## Safety rules (read first)

- **This deploys to production.** Confirm with the user before the `firebase
deploy` step unless they already said "deploy". Report the result faithfully.
- **Never read or write `.env.local` or any secret.** `TRAKT_CLIENT_ID` lives in
  the gitignored `apps/functions/.env.vultus-cab62` (a non-secret param, shipped
  into dist by the build assets); the secrets `SYNC_SHARED_SECRET` /
  `TMDB_READ_TOKEN` live in Secret Manager and are granted to the runtime SA at
  deploy. Don't inline any of them.
- **Don't bypass the preflight.** If it fails, fix the cause — it is reproducing
  exactly what Cloud Build will reject.

## Steps

### 1. Preflight (build + prune + validate the artifact)

```powershell
pnpm nx run functions:deploy-preflight
```

This builds + prunes `dist/apps/functions`, then asserts: the bundle installs
(`pnpm install --frozen-lockfile`), the required deps + `allowBuilds` config ship,
`firebase-admin` satisfies `firebase-functions`' peer range, and `main.js` loads
(gen2 discovery). It also leaves a valid `dist/apps/functions/node_modules` in
place, which Firebase's **local gen2 discovery** needs before upload.

If it fails, resolve per the message (and the `infrastructure-engineer` agent's
"Cloud Functions deploy" notes) before continuing. Do **not** proceed on a red
preflight.

### 2. Handle a trigger-type change (only if applicable)

Firebase rejects converting a function between HTTPS and background-triggered in
place: `Changing from an HTTPS function to a background triggered function is not
allowed`. If a function's trigger kind changed since the last deploy (e.g.
`onRequest` → `onDocumentWritten`), delete it first, then redeploy:

```powershell
firebase functions:delete <name> --region <region> --force
```

`syncTitles` is `europe-west1`; `dispatchNotifications` is `europe-west4`. Only
do this when the trigger kind actually changed — it is not a routine step.

### 3. Deploy

```powershell
firebase deploy --only functions
```

Scope to one function with `--only functions:<name>` when iterating. Firebase
loads `dist/apps/functions` (per `firebase.json`), runs local discovery against
the dist `node_modules` from step 1, uploads, and Cloud Build installs the pruned
bundle.

### 4. Report

- Confirm each function's operation succeeded (`Successful update/create
operation`) and surface the printed function URL(s).
- If Cloud Build fails, fetch the linked build log, map the error to the
  preflight checks / the `infrastructure-engineer` deploy notes, fix, and re-run
  from step 1.
- For an automated/CI deploy instead of a local one, see
  `.github/workflows/deploy-functions.yml` (manual `workflow_dispatch`).
