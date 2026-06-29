/**
 * Mobile build-time env injection + loud guard (spec 0026).
 *
 * Unifies the build-time injection of all real values needed for a
 * production-parity mobile build — the TMDB API key and the Firebase web config —
 * into a SINGLE mechanism shared by local and CI builds. It replaces the old
 * spec-0015 CI step that `sed`-mutated the tracked `environment.prod.ts` (a
 * commit-leak risk), writing instead a GITIGNORED generated file consumed via
 * Angular `fileReplacements`. The tracked `environment.prod.ts` is never touched;
 * it stays in the repo as the documented placeholder template.
 *
 * Value source (CI env vars take precedence over the local file):
 *   1. process.env (CI: GitHub Actions secrets/variables exported into the step).
 *   2. a gitignored `.env.local` at the repo root (local dev; KEY=VALUE lines).
 *
 * Output: apps/mobile/src/environments/environment.generated.ts — a
 * value-substituted copy of the EXACT `environment.prod.ts` shape
 * (production: true, useEmulators: false, mockAuthUid: null, projectId fixed).
 *
 * Loud guard: fails (exit 1) if any required value is missing/empty or any
 * `REPLACE_WITH_*` placeholder would survive into the generated file, naming the
 * exact key and BOTH where to set it (local `.env.local`) and in CI (the GitHub
 * secret/variable). With `--check-native` it instead asserts
 * `android/app/google-services.json` exists (the native-build preflight guard).
 *
 * Style modeled on tools/scripts/functions-deploy-preflight.mjs (numbered steps,
 * ok()/fail() helpers, synchronous fs, actionable messages). The main entry point
 * is guarded by an `import.meta.url === file://${process.argv[1]}` check so a
 * Vitest import of the pure helpers does NOT run the script against the real cwd.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The fixed Firebase project — hardcoded, NOT injected (matches both committed
// env files). The debug APK reuses prod `vultus-cab62` (spec 0026 decision 1).
export const PROJECT_ID = 'vultus-cab62';

// Required injected keys. Each maps an env-var name to its slot in the generated
// `environment` object. `projectId` is intentionally absent (hardcoded above).
export const REQUIRED_KEYS = [
  'TMDB_API_KEY',
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
];

const ok = (msg) => console.log(`  ✓ ${msg}`);
function fail(msg) {
  console.error(`\n✗ inject-mobile-env failed: ${msg}\n`);
  process.exit(1);
}

/**
 * Parse a minimal dotenv (`KEY=VALUE` lines). Blank lines and `#` comments are
 * skipped; surrounding single/double quotes on the value are stripped; the rest
 * of the value (including `=`) is preserved verbatim. Pure — no fs/process.
 */
export function parseDotenv(contents) {
  const out = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Resolve every required value from the merged source. `env` (CI) takes
 * precedence over `fileVars` (the local `.env.local`). Returns
 * `{ values, missing }`: `values` maps each REQUIRED_KEY to its resolved string;
 * `missing` lists the keys that are absent or empty (after trim) in BOTH sources.
 * Pure — caller supplies both maps.
 */
export function resolveValues(env, fileVars) {
  const values = {};
  const missing = [];
  for (const key of REQUIRED_KEYS) {
    const raw = env[key] ?? fileVars[key] ?? '';
    const value = String(raw).trim();
    if (!value) {
      missing.push(key);
    } else {
      values[key] = value;
    }
  }
  return { values, missing };
}

/**
 * Build the actionable failure message for a missing/empty required key, naming
 * BOTH where to set it locally and in CI. Pure.
 */
export function missingKeyMessage(key) {
  return (
    `required value "${key}" is missing or empty. ` +
    `Set it locally in the gitignored \`.env.local\` at the repo root ` +
    `(\`${key}=...\`), or in CI as a GitHub Actions secret/variable named ` +
    `\`${key}\` (Settings → Secrets and variables → Actions). ` +
    `For the Firebase web config, copy values from the Firebase console → ` +
    `Project settings → Your apps → SDK setup for \`${PROJECT_ID}\`. ` +
    `For TMDB_API_KEY use your TMDB API key.`
  );
}

/**
 * Render the generated `environment.generated.ts` source from resolved values.
 * Mirrors the EXACT `environment.prod.ts` shape with real values substituted.
 * Pure — `values` must already contain every REQUIRED_KEY (non-empty).
 */
export function renderGeneratedEnv(values) {
  const s = (v) => JSON.stringify(v);
  return `/**
 * GENERATED FILE — DO NOT COMMIT, DO NOT EDIT.
 *
 * Produced at build time by tools/scripts/inject-mobile-env.mjs (spec 0026) from
 * CI env vars or the gitignored repo-root \`.env.local\`. It is the production
 * \`fileReplacements\` target (replacing \`environment.ts\`), giving a locally- or
 * CI-built APK full production parity while every committed file stays key-free.
 * The tracked \`environment.prod.ts\` remains the placeholder template. This file
 * is gitignored; if you see it in \`git status\` as tracked, something is wrong.
 */
export const environment = {
  production: true,
  useEmulators: false,
  mockAuthUid: null as string | null,
  firebase: {
    apiKey: ${s(values.FIREBASE_API_KEY)},
    authDomain: ${s(values.FIREBASE_AUTH_DOMAIN)},
    projectId: ${s(PROJECT_ID)},
    storageBucket: ${s(values.FIREBASE_STORAGE_BUCKET)},
    messagingSenderId: ${s(values.FIREBASE_MESSAGING_SENDER_ID)},
    appId: ${s(values.FIREBASE_APP_ID)},
  },
  tmdb: {
    apiBaseUrl: 'https://api.themoviedb.org/3',
    imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
    detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780',
    auth: { kind: 'apiKey' as const, apiKey: ${s(values.TMDB_API_KEY)} },
  },
};
`;
}

/**
 * The placeholder/empty guard over the rendered generated content. Returns an
 * array of problem strings (empty = clean): any surviving `REPLACE_WITH_*`
 * placeholder, or any required value that is empty in the rendered output. Pure.
 */
export function guardGeneratedContent(content, values) {
  const problems = [];
  const placeholders = content.match(/REPLACE_WITH_[A-Z_]*/g);
  if (placeholders) {
    problems.push(
      `generated content still contains placeholder(s): ${[
        ...new Set(placeholders),
      ].join(', ')}`,
    );
  }
  for (const key of REQUIRED_KEYS) {
    if (!values[key] || !String(values[key]).trim()) {
      problems.push(`required value "${key}" is empty in generated output`);
    }
  }
  return problems;
}

const GENERATED_RELATIVE =
  'apps/mobile/src/environments/environment.generated.ts';
const NATIVE_RELATIVE = 'android/app/google-services.json';

/** Read the local `.env.local` at the repo root, if present. */
function readLocalEnvFile(root) {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return {};
  return parseDotenv(readFileSync(path, 'utf8'));
}

/** `--check-native`: assert android/app/google-services.json exists. */
function runCheckNative(root) {
  console.log('inject-mobile-env: --check-native (google-services.json guard)');
  const path = resolve(root, NATIVE_RELATIVE);
  if (!existsSync(path)) {
    fail(
      `${NATIVE_RELATIVE} is missing. The native (APK) build needs it for the ` +
        `Firebase Android config. Download it from the Firebase console → ` +
        `Project settings → Your apps → the Android app ` +
        `\`app.vultus.mobile\` (project \`${PROJECT_ID}\`) and place it at ` +
        `\`${NATIVE_RELATIVE}\`. In CI it is decoded from the base64 GitHub ` +
        `secret \`GOOGLE_SERVICES_JSON\` before the build. The file is ` +
        `gitignored (spec 0026 decision 4), so each machine provisions it once.`,
    );
  }
  ok(`${NATIVE_RELATIVE} present`);
  console.log('\ninject-mobile-env: native check passed.');
}

/** The default flow: resolve values, render, guard, write the generated file. */
function runInject(root) {
  console.log(`inject-mobile-env: generating ${GENERATED_RELATIVE}`);

  // 1. Resolve values (CI env precedence, then local .env.local).
  const fileVars = readLocalEnvFile(root);
  const { values, missing } = resolveValues(process.env, fileVars);
  if (missing.length > 0) {
    fail(missingKeyMessage(missing[0]));
  }
  ok(`all ${REQUIRED_KEYS.length} required values resolved`);

  // 2. Render the generated env source from the exact prod shape.
  const content = renderGeneratedEnv(values);

  // 3. Loud placeholder/empty guard over the rendered content.
  const problems = guardGeneratedContent(content, values);
  if (problems.length > 0) {
    fail(
      `${problems.join('; ')}. ` +
        `Set the missing value(s) in the gitignored \`.env.local\` at the repo ` +
        `root, or as GitHub Actions secrets/variables in CI.`,
    );
  }
  ok('no REPLACE_WITH_* placeholders or empty required values survive');

  // 4. Write the gitignored generated file.
  const outPath = resolve(root, GENERATED_RELATIVE);
  writeFileSync(outPath, content, 'utf8');
  ok(`wrote ${GENERATED_RELATIVE}`);

  console.log('\ninject-mobile-env: all checks passed.');
}

// Guarded main entry — does NOT run when this module is imported (e.g. Vitest).
// `process.argv[1]` may be a relative or platform path (backslashes on Windows);
// `pathToFileURL` normalizes it to a comparable absolute file:// URL.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.cwd();
  if (process.argv.includes('--check-native')) {
    runCheckNative(root);
  } else {
    runInject(root);
  }
}
