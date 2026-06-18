# Firebase config & local Emulator Suite

Version-controlled Firebase configuration for Vultus (spec 0004). The real
Firebase project is **`vultus-cab62`** (`.firebaserc`); that project id is not a
secret. No credentials or secrets are needed for anything below.

## Prerequisites

- **Java (JDK 11+, JDK 21 recommended) on `PATH`** — the Firestore emulator runs
  on the JVM. Without Java, `firebase emulators:start` and
  `firebase emulators:exec` both fail.
- `firebase-tools` is pinned as a workspace devDependency, so `pnpm`-prefixed
  commands use the local CLI (no global install required).

## Files

| File                     | Purpose                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.firebaserc`            | `default` project alias → `vultus-cab62`.                                                                                                                   |
| `firebase.json`          | `firestore` rules/indexes refs + emulator config (Firestore 8080, Auth 9099, UI 4000). No Functions emulator (stub backend — added in the functions specs). |
| `firestore.rules`        | PLAN §4 access-control rules (access control only; field/schema validation is deferred to `libs/shared/firestore-schema`).                                  |
| `firestore.indexes.json` | Empty skeleton. **Composite indexes are added per slice** when a real query needs one — none ship here.                                                     |

## Commands

```sh
# Start Firestore + Auth + Emulator UI with local data import/export.
# Data lives in ./.emulator-data (gitignored). Round-trips across restarts.
pnpm emulators

# Same, but with a fresh (empty) state — no import/export.
pnpm emulators:clean

# Run the security-rules test suite against a throwaway Firestore emulator.
# Boots the emulator (downloads the jar on first run), runs the *.rules.spec.ts
# suite via tools/firestore-rules-test/vitest.rules.config.mts, tears down.
pnpm test:rules
# equivalently:  pnpm nx run firestore-rules-test:test-rules
```

`pnpm test:rules` expands to the canonical command:

```sh
firebase emulators:exec --only firestore "vitest run -c tools/firestore-rules-test/vitest.rules.config.mts"
```

A clean run also validates `firestore.rules` and `firebase.json` — the emulator
refuses to start on invalid rules.

## Notes

- **Rules tests are local-only for now.** The CI workflow (spec 0002) installs
  neither Java nor a running Firestore emulator, so the rules tests are **not**
  gated in CI by this spec. Adding a `firestore-rules` CI job (`setup-java` +
  `firebase-tools` + `emulators:exec`) is a documented follow-up, to be done
  alongside the Playwright/emulator e2e job (PLAN §6 item 20).
- The rules specs use the `*.rules.spec.ts` pattern and are deliberately
  excluded from the default `nx test` graph, so CI stays green without an
  emulator. They run only via `test:rules` / the `test-rules` target.
- Emulator ports (8080/9099/4000) are the Firebase defaults, pinned in
  `firebase.json` so they can be changed in one place if they collide locally.
