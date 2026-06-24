#!/usr/bin/env node
/**
 * Cloud Functions deploy preflight.
 *
 * Validates the *deployable artifact* (`dist/apps/functions`) the way Firebase /
 * Google Cloud Build will, catching the failure classes the Nx lint/test/build
 * gates structurally cannot: those validate the monorepo, never the pruned dist
 * bundle that is actually uploaded. Every deploy-blocker we hit (firebase-admin
 * peer conflict, missing functions-framework, ERR_PNPM_IGNORED_BUILDS, broken
 * gen2 discovery) was invisible to CI and only surfaced on a manual deploy.
 * See the memory note `functions-deploy-pnpm-recipe` for the full back-story.
 *
 * Run via `nx run functions:deploy-preflight`, which builds + prunes first.
 *
 * Checks (each fails fast with an actionable message):
 *   1. Artifact present — package.json, pnpm-lock.yaml, main.js.
 *   2. Required runtime deps declared — @google-cloud/functions-framework (the
 *      pnpm buildpack needs it explicitly), firebase-admin, firebase-functions.
 *   3. pnpm-workspace.yaml ships an allowBuilds map — without it Cloud Build's
 *      pnpm exits 1 with ERR_PNPM_IGNORED_BUILDS. (Static check, so it holds
 *      regardless of the local pnpm major.)
 *   4. `pnpm install --frozen-lockfile` succeeds in dist — the pruned lockfile
 *      is installable.
 *   5. firebase-admin satisfies firebase-functions' peer range — reproduces the
 *      npm ERESOLVE that Cloud Build hits but pnpm's lenient resolver hides.
 *   6. main.js loads — `require(main.js)`, exactly what the gen2 manifest
 *      discovery does, catching module-resolution failures.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const DIST = resolve(process.cwd(), 'dist/apps/functions');
const REQUIRED_DEPS = [
  '@google-cloud/functions-framework',
  'firebase-admin',
  'firebase-functions',
];

const ok = (msg) => console.log(`  ✓ ${msg}`);
function fail(msg) {
  console.error(`\n✗ deploy-preflight failed: ${msg}\n`);
  process.exit(1);
}

console.log(`deploy-preflight: validating ${DIST}`);

// 1. Artifact present.
if (!existsSync(DIST)) {
  fail(
    `${DIST} not found. Run \`pnpm nx run functions:prune --configuration=production\` first ` +
      `(the deploy-preflight target does this for you).`,
  );
}
for (const f of ['package.json', 'pnpm-lock.yaml', 'main.js']) {
  if (!existsSync(join(DIST, f))) {
    fail(`dist is missing ${f} — re-run the prune target.`);
  }
}
ok('artifact present (package.json, pnpm-lock.yaml, main.js)');

// 2. Required runtime deps declared.
const pkg = JSON.parse(readFileSync(join(DIST, 'package.json'), 'utf8'));
const deps = pkg.dependencies ?? {};
for (const d of REQUIRED_DEPS) {
  if (!deps[d]) {
    fail(
      `dist package.json is missing required dependency "${d}". ` +
        (d === '@google-cloud/functions-framework'
          ? 'The Google pnpm buildpack cannot find it transitively and refuses to build without it.'
          : 'It must be pinned in apps/functions/package.json.'),
    );
  }
}
ok(`required runtime dependencies declared (${REQUIRED_DEPS.join(', ')})`);

// 3. pnpm-workspace.yaml ships an allowBuilds map.
const wsPath = join(DIST, 'pnpm-workspace.yaml');
if (!existsSync(wsPath)) {
  fail(
    'dist is missing pnpm-workspace.yaml — Cloud Build pnpm will exit 1 with ERR_PNPM_IGNORED_BUILDS. ' +
      'It is copied into dist from apps/functions/deploy/ by the production build assets.',
  );
}
if (!/^\s*allowBuilds:/m.test(readFileSync(wsPath, 'utf8'))) {
  fail(
    'dist pnpm-workspace.yaml has no `allowBuilds:` map — the ignored-build scripts will fail Cloud Build.',
  );
}
ok('pnpm-workspace.yaml ships an allowBuilds map');

// 4. Frozen install in dist — proves the pruned lockfile installs and populates
// node_modules for checks 5–6 (and for Firebase's gen2 local discovery on a real
// deploy). The shipped pnpm-workspace.yaml carries `packages: ['.']` so this is
// valid under both the repo's pinned pnpm 9 (CI) and Cloud Build's pnpm 10+.
try {
  execSync('pnpm install --frozen-lockfile', { cwd: DIST, stdio: 'pipe' });
  ok('pnpm install --frozen-lockfile succeeds');
} catch (e) {
  const out =
    `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim();
  fail(`pnpm install --frozen-lockfile failed in dist:\n${out}`);
}

// 5. firebase-admin satisfies firebase-functions' peer range.
const distRequire = createRequire(join(DIST, 'noop.js'));
const rootRequire = createRequire(join(process.cwd(), 'noop.js'));
// Read package.json directly through the top-level node_modules symlinks —
// `require.resolve('pkg/package.json')` is blocked by modern `exports` maps.
const readDistPkg = (name) =>
  JSON.parse(
    readFileSync(join(DIST, 'node_modules', name, 'package.json'), 'utf8'),
  );
try {
  const ffPkg = readDistPkg('firebase-functions');
  const adminPkg = readDistPkg('firebase-admin');
  const range = ffPkg.peerDependencies?.['firebase-admin'];
  if (range) {
    let satisfies;
    try {
      const semver = rootRequire('semver');
      satisfies = semver.satisfies(adminPkg.version, range);
    } catch {
      // semver helper not resolvable — coarse major-version fallback.
      const major = (v) =>
        Number(
          String(v)
            .replace(/^[^\d]*/, '')
            .split('.')[0],
        );
      const allowed = range.match(/\d+/g)?.map(Number) ?? [];
      satisfies = allowed.includes(major(adminPkg.version));
    }
    if (!satisfies) {
      fail(
        `firebase-admin@${adminPkg.version} does NOT satisfy firebase-functions@${ffPkg.version}'s ` +
          `peer range "${range}". Cloud Build's npm will reject this with ERESOLVE (pnpm hides it). ` +
          `Pin a compatible firebase-admin in apps/functions/package.json and the root package.json.`,
      );
    }
    ok(
      `firebase-admin@${adminPkg.version} satisfies firebase-functions peer "${range}"`,
    );
  } else {
    ok(
      'firebase-functions declares no firebase-admin peer (skipped peer check)',
    );
  }
} catch (e) {
  fail(
    `could not verify the firebase-admin/firebase-functions peer range: ${e.message}`,
  );
}

// 6. main.js loads (the gen2 discovery step) — require, exactly as firebase-tools does.
try {
  distRequire(join(DIST, 'main.js'));
  ok('main.js loads (gen2 discovery)');
} catch (e) {
  fail(
    `main.js failed to load — gen2 discovery would fail:\n${e.stack ?? e.message}`,
  );
}

console.log('\ndeploy-preflight: all checks passed.');
