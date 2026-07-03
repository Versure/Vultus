import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  WORKTREES_DIRNAME,
  assertPlainDirName,
  readPrimaryRoot,
  resolveWorktreePath,
  stripGitSuffix,
} from './resolve-worktree.mjs';

describe('stripGitSuffix', () => {
  it('strips a bare trailing .git', () => {
    expect(stripGitSuffix('C:/Projects/Vultus/.git')).toBe(
      'C:/Projects/Vultus/',
    );
  });

  it('strips a trailing .git with a forward-slash', () => {
    expect(stripGitSuffix('/home/me/Vultus/.git/')).toBe('/home/me/Vultus/');
  });

  it('strips a trailing .git with a back-slash (the hardened case)', () => {
    // The divergence spec 0071 removed: plain `'\.git$'` left this trailing
    // separator behind; the hardened `'\.git[\\/]?$'` strips it.
    expect(stripGitSuffix('C:\\Projects\\Vultus\\.git\\')).toBe(
      'C:\\Projects\\Vultus\\',
    );
  });

  it('leaves a path without a trailing .git untouched', () => {
    expect(stripGitSuffix('C:/Projects/Vultus')).toBe('C:/Projects/Vultus');
  });
});

describe('assertPlainDirName', () => {
  it('accepts plain feat/spec worktree names', () => {
    expect(assertPlainDirName('feat-0071-normative-text-dedup')).toBe(
      'feat-0071-normative-text-dedup',
    );
    expect(assertPlainDirName('spec-0001-slug')).toBe('spec-0001-slug');
  });

  it('rejects separators and traversal', () => {
    expect(() => assertPlainDirName('')).toThrow();
    expect(() => assertPlainDirName('..')).toThrow();
    expect(() => assertPlainDirName('a/b')).toThrow();
    expect(() => assertPlainDirName('a\\b')).toThrow();
    expect(() => assertPlainDirName('../evil')).toThrow();
    expect(() => assertPlainDirName('..\\evil')).toThrow();
  });
});

describe('resolveWorktreePath', () => {
  it('resolves under the sibling ../Vultus-worktrees/ root', () => {
    const root = resolve('/tmp/checkouts/Vultus');
    const wt = resolveWorktreePath(root, 'feat-0071-slug');
    // Normalize separators for a cross-platform assertion.
    const norm = wt.replace(/\\/g, '/');
    expect(norm).toMatch(new RegExp(`/${WORKTREES_DIRNAME}/feat-0071-slug$`));
    // It is a sibling of the checkout, not a child of it.
    expect(norm).not.toMatch(/\/Vultus\/Vultus-worktrees\//);
    expect(isAbsolute(wt)).toBe(true);
  });

  it('does not depend on the checkout dir basename', () => {
    // CI clones to arbitrary dir names; the sibling naming must still hold.
    const wt = resolveWorktreePath(resolve('/x/some-checkout'), 'spec-9-z');
    expect(wt.replace(/\\/g, '/')).toMatch(
      new RegExp(`/${WORKTREES_DIRNAME}/spec-9-z$`),
    );
  });

  it('rejects a traversal dir name (no escape from the worktrees root)', () => {
    expect(() =>
      resolveWorktreePath(resolve('/x/Vultus'), '../evil'),
    ).toThrow();
  });
});

describe('readPrimaryRoot (integration — runs git in this repo)', () => {
  it('returns an existing absolute checkout root', () => {
    const root = readPrimaryRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(existsSync(root)).toBe(true);
    // A checkout root has a .git entry (a dir in the primary, a file in a
    // linked worktree — either way the path exists).
    expect(existsSync(join(root, '.git'))).toBe(true);
    // The path has no trailing `.git` segment left behind.
    expect(root.endsWith(`${sep}.git`)).toBe(false);
  });
});
