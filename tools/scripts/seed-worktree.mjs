/**
 * Feature-worktree secret seed — narrow, allow-listed copy (spec 0068).
 *
 * Replaces the fragile inline PowerShell `Copy-Item` seed block (spec 0040,
 * `implement-feature/SKILL.md`) with a committed, single-invocation Node script
 * that `.claude/settings.json` allow-lists exactly once. It copies the fixed
 * three gitignored local-only files from the PRIMARY checkout into a feature
 * worktree — and nothing else.
 *
 * WHY THIS EXISTS (the security shape): the previous `Bash(*Copy-Item*...*)`
 * substring allows bound neither source, destination, nor command shape, so they
 * also auto-approved chained exfiltration in the same shell call and copies to
 * arbitrary/tracked destinations. This script closes both holes:
 *   - There is NO arbitrary source: the three sources are hardcoded (SEED_FILES)
 *     and their root is derived from THIS SCRIPT'S OWN location (import.meta.url),
 *     never from cwd or any argument.
 *   - There is NO arbitrary destination: the one argument (`$wt`) must resolve to
 *     a canonical DESCENDANT of the sibling `../Vultus-worktrees/` root
 *     (resolved-path containment, not a string prefix — rejects `..` traversal
 *     and symlink escape). A violation exits nonzero BEFORE any copy.
 *   - There is NO command chaining: a single node invocation copies opaque bytes
 *     via fs.copyFileSync and never shells out.
 *
 * RESIDUAL RISK (documented, honest): an agent holding Write could edit this
 * script before running it. The control RAISES THE BAR (no arbitrary dest, no
 * chaining, fixed sources) but is NOT tamper-proof. The `Read`-tool deny in
 * settings.json and the standing untrusted-content / never-read-secrets prose are
 * the backstops.
 *
 * SECRET SAFETY: the seeded files are secrets. This script NEVER reads or prints
 * their contents — it copies them as opaque bytes with fs.copyFileSync only.
 *
 * Style modeled on tools/scripts/inject-mobile-env.mjs: pure exported helpers so
 * Vitest can import without running the CLI, and a guarded main entry point
 * (`import.meta.url === pathToFileURL(process.argv[1]).href`).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The ONLY three files this script will ever copy — relative to the primary
 * checkout root. Hardcoded on purpose: no arbitrary-source argument exists.
 */
export const SEED_FILES = [
  '.env.local',
  'apps/mobile/src/environments/environment.generated.ts',
  'android/app/google-services.json',
];

/** Thrown when the destination fails the `../Vultus-worktrees/` containment guard. */
export class ContainmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainmentError';
  }
}

/**
 * The primary-checkout root, derived from this script's own location. The script
 * lives at `<root>/tools/scripts/seed-worktree.mjs`, so root = up two dirs from
 * the script directory. Pure — takes `import.meta.url` (never cwd, never argv).
 */
export function resolvePrimaryRoot(scriptUrl) {
  const scriptPath = fileURLToPath(scriptUrl);
  const scriptDir = dirname(scriptPath);
  return resolve(scriptDir, '..', '..');
}

/**
 * The worktrees root: the sibling `Vultus-worktrees` dir of the primary checkout
 * (the layout the implement-feature skill uses). Pure.
 */
export function worktreesRootFor(root) {
  return resolve(root, '..', 'Vultus-worktrees');
}

/**
 * Resolved-path containment check: is `wt` a strict descendant of
 * `worktreesRoot`? Both are resolved to absolute canonical paths, then compared
 * via `relative(...)` — this rejects `..` traversal and symlink escape and is NOT
 * a string-prefix match. Returns false when `wt` IS the worktrees root itself
 * (must be a descendant, not the root). Pure.
 */
export function isInsideWorktrees(wt, worktreesRoot) {
  const resolvedRoot = resolve(worktreesRoot);
  const resolvedWt = resolve(wt);
  const rel = relative(resolvedRoot, resolvedWt);
  if (rel === '') return false; // wt === worktreesRoot: not a descendant
  if (rel.startsWith('..')) return false; // outside / traversal
  if (isAbsolute(rel)) return false; // different drive/root (Windows)
  return true;
}

/**
 * Copy the fixed SEED_FILES from `root` into `wt`, preserving the spec-0040 seed
 * semantics:
 *   - enforce the `../Vultus-worktrees/` containment guard FIRST (throws
 *     ContainmentError, copies nothing, on violation);
 *   - create each destination's parent dir (recursive; no-op if present);
 *   - overwrite on reuse (copyFileSync is `-Force`);
 *   - SKIP-AND-WARN, never throw, on a missing source or a copy failure — the
 *     seed is best-effort.
 *
 * Never reads or prints the CONTENTS of the seeded files.
 *
 * Returns `{ seeded: string[], warnings: string[] }` (both arrays of `rel`
 * strings / warning strings). Throws ContainmentError only for the dest guard.
 */
export function seedWorktree({ root, wt }) {
  const worktreesRoot = worktreesRootFor(root);
  if (!isInsideWorktrees(wt, worktreesRoot)) {
    throw new ContainmentError(
      `refusing to seed: destination "${wt}" is not a descendant of the ` +
        `worktrees root "${worktreesRoot}". The seed may only target a feature ` +
        `worktree under ../Vultus-worktrees/.`,
    );
  }

  const resolvedWt = resolve(wt);
  const seeded = [];
  const warnings = [];

  for (const rel of SEED_FILES) {
    const src = join(root, rel);
    const dst = join(resolvedWt, rel);

    // Defense in depth: even though sources are fixed, assert each per-file
    // destination stays within the worktree (guards against a rel with traversal).
    const relFromWt = relative(resolvedWt, resolve(dst));
    if (relFromWt.startsWith('..') || isAbsolute(relFromWt)) {
      warnings.push(
        `⚠ Failed to copy ${rel} — worktree may not build: destination escapes the worktree`,
      );
      continue;
    }

    if (!existsSync(src)) {
      warnings.push(
        `⚠ ${rel} not found in primary checkout — app may not build in this worktree`,
      );
      continue;
    }

    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst); // opaque bytes; overwrites on reuse (-Force)
      seeded.push(rel);
    } catch (err) {
      warnings.push(
        `⚠ Failed to copy ${rel} — worktree may not build: ${err.message ?? err}`,
      );
    }
  }

  return { seeded, warnings };
}

/** The guarded CLI entry: `node seed-worktree.mjs <absolute-worktree-root>`. */
function runCli(argv) {
  const wt = argv[2];
  if (!wt) {
    console.error(
      'seed-worktree: missing required argument — the absolute worktree root.\n' +
        'Usage: node tools/scripts/seed-worktree.mjs <absolute-worktree-root>',
    );
    process.exit(1);
  }

  const root = resolvePrimaryRoot(import.meta.url);

  let result;
  try {
    result = seedWorktree({ root, wt });
  } catch (err) {
    if (err instanceof ContainmentError) {
      console.error(`\n✗ seed-worktree: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  for (const rel of result.seeded) {
    console.log(`  ✓ seeded: ${rel}`);
  }
  for (const warning of result.warnings) {
    console.error(warning);
  }

  if (result.warnings.length > 0) {
    console.log(
      `\nseed-worktree: seeded ${result.seeded.length}/${SEED_FILES.length} ` +
        `file(s) with ${result.warnings.length} warning(s).`,
    );
  } else {
    console.log(`\nseed-worktree: seeded all ${result.seeded.length} file(s).`);
  }

  // Best-effort: exit 0 even when sources were missing (warnings only).
  process.exit(0);
}

// Guarded main entry — does NOT run when this module is imported (e.g. Vitest).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv);
}
