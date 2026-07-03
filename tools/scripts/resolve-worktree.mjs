/**
 * Feature/spec worktree path resolver — the single deriver of `$root`/`$wt`
 * (spec 0071, cluster 2).
 *
 * Replaces the `git rev-parse --git-common-dir` / `GetFullPath` PowerShell
 * snippet that was hand-copied into FIVE skills (create-spec, rework-spec,
 * implement-feature, rework-feature, cleanup-feature) and had already drifted:
 * four copies stripped `'\.git$'`, cleanup-feature used the hardened
 * `'\.git[\\/]?$'`. This script is now the ONE place the formula lives; every
 * skill calls it, so a future change happens once.
 *
 * OUTPUT CONTRACT (two lines, in order — both are consumed by the skills):
 *   line 1: $root — the primary-checkout root (used by the seed step)
 *   line 2: $wt   — the absolute worktree path (used for `git -C $wt`)
 * A caller captures both, e.g. in PowerShell:
 *   $resolved = node tools/scripts/resolve-worktree.mjs feat-NNNN-slug
 *   $root = $resolved[0]
 *   $wt   = $resolved[1]
 * Emitting only $wt would break the seed step, so BOTH lines are required.
 *
 * The one argument is the worktree DIRECTORY NAME (e.g. `feat-0071-slug` or
 * `spec-0071-slug`), not a path — it must be a plain name with no separators or
 * `..` traversal (asserted before use). The worktree always lands under the
 * sibling `../Vultus-worktrees/` root, matching the layout the skills use.
 *
 * Style modeled on tools/scripts/seed-worktree.mjs: pure exported helpers so
 * Vitest can import them without spawning git, and a guarded CLI entry point.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The sibling directory (of the primary checkout) that holds all worktrees. */
export const WORKTREES_DIRNAME = 'Vultus-worktrees';

/**
 * Pure. Strip a trailing `.git` (optionally followed by a `/` or `\`) from the
 * git-common-dir path to yield the checkout root. This is the HARDENED regex
 * `cleanup-feature` used before this consolidation (spec 0071 chose it as the
 * single canonical form) — it tolerates a trailing separator the plain
 * `'\.git$'` did not.
 */
export function stripGitSuffix(gitCommonDir) {
  return gitCommonDir.replace(/\.git[\\/]?$/, '');
}

/**
 * Pure. Assert `name` is a plain directory name — no path separators, no `..`
 * traversal. Keeps the resolved `$wt` from escaping `../Vultus-worktrees/`.
 * Throws on violation; returns `name` on success.
 */
export function assertPlainDirName(name) {
  if (
    !name ||
    /[\\/]/.test(name) ||
    name === '.' ||
    name === '..' ||
    name.split(/[\\/]/).includes('..')
  ) {
    throw new Error(
      `invalid worktree dir name "${name}" — must be a plain directory name ` +
        `(no separators, no ".." traversal).`,
    );
  }
  return name;
}

/**
 * Pure. Given the primary-checkout root and a worktree directory name, resolve
 * the absolute worktree path under the sibling `../Vultus-worktrees/`.
 */
export function resolveWorktreePath(root, worktreeDirName) {
  assertPlainDirName(worktreeDirName);
  return resolve(root, '..', WORKTREES_DIRNAME, worktreeDirName);
}

/**
 * Read the primary-checkout root via git. Impure (spawns git). `git rev-parse
 * --path-format=absolute --git-common-dir` returns the primary `.git` dir even
 * when invoked from inside a linked worktree, so stripping `.git` yields the
 * primary checkout root regardless of cwd. Returns a normalized absolute path.
 */
export function readPrimaryRoot(cwd = process.cwd()) {
  const gitCommonDir = execSync(
    'git rev-parse --path-format=absolute --git-common-dir',
    { cwd, encoding: 'utf8' },
  ).trim();
  return resolve(stripGitSuffix(gitCommonDir));
}

/** The guarded CLI entry: `node resolve-worktree.mjs <worktree-dir-name>`. */
function runCli(argv) {
  const dirName = argv[2];
  if (!dirName) {
    console.error(
      'resolve-worktree: missing required argument — the worktree directory name.\n' +
        'Usage: node tools/scripts/resolve-worktree.mjs <worktree-dir-name>\n' +
        '  e.g. node tools/scripts/resolve-worktree.mjs feat-0071-normative-text-dedup',
    );
    process.exit(1);
  }

  let wt;
  try {
    const root = readPrimaryRoot();
    wt = resolveWorktreePath(root, dirName);
    // Emit the two-line contract: $root then $wt.
    console.log(root);
    console.log(wt);
  } catch (err) {
    console.error(`\n✗ resolve-worktree: ${err.message ?? err}\n`);
    process.exit(1);
  }

  process.exit(0);
}

// Guarded main entry — does NOT run when this module is imported (e.g. Vitest).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv);
}
