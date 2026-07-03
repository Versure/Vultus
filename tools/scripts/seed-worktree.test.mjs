import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ContainmentError,
  SEED_FILES,
  isInsideWorktrees,
  resolvePrimaryRoot,
  seedWorktree,
  worktreesRootFor,
} from './seed-worktree.mjs';

/** Write `contents` to `path`, creating parent dirs. */
function writeFileEnsuringDir(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/**
 * Build a fake primary/worktrees layout under a fresh temp dir:
 *   <tmp>/Vultus                    (primary root)
 *   <tmp>/Vultus-worktrees/feat-xxxx (a valid dest)
 * Optionally populate the three source files. Returns handy paths.
 */
function makeLayout({ populate = SEED_FILES } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'seed-worktree-'));
  const root = join(tmp, 'Vultus');
  const worktreesRoot = join(tmp, 'Vultus-worktrees');
  const wt = join(worktreesRoot, 'feat-xxxx');
  mkdirSync(root, { recursive: true });
  mkdirSync(wt, { recursive: true });
  for (const rel of populate) {
    writeFileEnsuringDir(join(root, rel), `original:${rel}`);
  }
  return { tmp, root, worktreesRoot, wt };
}

describe('seed-worktree helpers', () => {
  it('derives the primary root two dirs up from the script location', () => {
    const root = resolvePrimaryRoot(
      'file:///C:/Projects/Prive/Vultus/Vultus/tools/scripts/seed-worktree.mjs',
    );
    // Normalize separators for a cross-platform assertion.
    expect(root.replace(/\\/g, '/')).toMatch(/\/Vultus$/);
    expect(worktreesRootFor(root).replace(/\\/g, '/')).toMatch(
      /\/Vultus-worktrees$/,
    );
  });

  // Direct isInsideWorktrees true/false coverage.
  it('isInsideWorktrees accepts a descendant and rejects escapes', () => {
    const wroot = join(tmpdir(), 'X', 'Vultus-worktrees');
    expect(isInsideWorktrees(join(wroot, 'feat-1'), wroot)).toBe(true);
    expect(isInsideWorktrees(join(wroot, 'a', 'b'), wroot)).toBe(true);
    // The worktrees root itself is not a descendant.
    expect(isInsideWorktrees(wroot, wroot)).toBe(false);
    // `..` traversal out of the worktrees root.
    expect(isInsideWorktrees(join(wroot, '..', 'evil'), wroot)).toBe(false);
    // A sibling primary checkout.
    expect(isInsideWorktrees(join(wroot, '..', 'Vultus'), wroot)).toBe(false);
  });
});

describe('seedWorktree', () => {
  // (a) copies the three files, creating parent dirs, overwriting on reuse.
  it('copies all three files into the dest, creating parent dirs', () => {
    const { tmp, root, wt } = makeLayout();
    try {
      const { seeded, warnings } = seedWorktree({ root, wt });
      expect(warnings).toEqual([]);
      expect(seeded.sort()).toEqual([...SEED_FILES].sort());

      for (const rel of SEED_FILES) {
        const dst = join(wt, rel);
        expect(existsSync(dst)).toBe(true);
        expect(readFileSync(dst, 'utf8')).toBe(`original:${rel}`);
      }
      // Parent dirs that did not exist in the fresh worktree were created.
      expect(
        existsSync(join(wt, 'apps', 'mobile', 'src', 'environments')),
      ).toBe(true);
      expect(existsSync(join(wt, 'android', 'app'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('overwrites seeded files on reuse (-Force semantics)', () => {
    const { tmp, root, wt } = makeLayout();
    try {
      seedWorktree({ root, wt });
      // Change the source content, seed again, assert the dest is overwritten.
      for (const rel of SEED_FILES) {
        writeFileEnsuringDir(join(root, rel), `updated:${rel}`);
      }
      const { seeded, warnings } = seedWorktree({ root, wt });
      expect(warnings).toEqual([]);
      expect(seeded.sort()).toEqual([...SEED_FILES].sort());
      for (const rel of SEED_FILES) {
        expect(readFileSync(join(wt, rel), 'utf8')).toBe(`updated:${rel}`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // (b) skips and warns (never throws) on a missing source.
  it('skips and warns on a missing source, still copying the present ones', () => {
    const missing = '.env.local';
    const present = SEED_FILES.filter((r) => r !== missing);
    const { tmp, root, wt } = makeLayout({ populate: present });
    try {
      let result;
      expect(() => {
        result = seedWorktree({ root, wt });
      }).not.toThrow();

      // A warning naming the missing rel path.
      expect(result.warnings.some((w) => w.includes(missing))).toBe(true);
      expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);

      // The missing one is absent; the present ones were copied.
      expect(existsSync(join(wt, missing))).toBe(false);
      expect(result.seeded.sort()).toEqual([...present].sort());
      for (const rel of present) {
        expect(existsSync(join(wt, rel))).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // (c) refuses a destination outside ../Vultus-worktrees/.
  it('refuses a `..`-traversal dest and copies nothing', () => {
    const { tmp, root, worktreesRoot } = makeLayout();
    try {
      // Resolves to <tmp>/evil — outside the worktrees root.
      const evilWt = join(worktreesRoot, '..', 'evil');
      expect(() => seedWorktree({ root, wt: evilWt })).toThrow(
        ContainmentError,
      );
      // Nothing was copied.
      for (const rel of SEED_FILES) {
        expect(existsSync(join(evilWt, rel))).toBe(false);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a dest pointing at the primary checkout', () => {
    const { tmp, root } = makeLayout();
    try {
      // The primary checkout is a sibling of Vultus-worktrees, never inside it.
      expect(() => seedWorktree({ root, wt: root })).toThrow(ContainmentError);
      expect(() =>
        seedWorktree({ root, wt: join(root, 'apps', 'mobile') }),
      ).toThrow(ContainmentError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
