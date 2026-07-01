import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * Deterministic lib-README guard (spec 0058 deliverable 3, task S5c).
 *
 * Enforces two things over every `libs/**\/README.md`, with NO prose-quality
 * judgment (that is the follow-up `/audit-docs` skill's job):
 *   1. the Nx library-generator scaffold sentinel is ABSENT, and
 *   2. the CLAUDE.md-mandated section trio is present as case-insensitive
 *      heading-presence checks: a top-level title on line 1, a public-surface
 *      heading (`/barrel|public/i`) and a Sheriff/boundary heading
 *      (`/sheriff|boundar/i`).
 *
 * MARKER SET (§8, empirically re-derived from all 12 current READMEs so the
 * live guard passes on every one with ZERO README edits). The `/usage/i`
 * marker is intentionally DROPPED: 5 compliant READMEs
 * (libs/mobile/{search,settings,notifications,onboarding} and
 * libs/functions/dispatch-notifications) have no `usage` heading, and requiring
 * it would false-fail them. The public-surface marker is widened to
 * `/barrel|public/i` so "Barrel exports" (used by
 * libs/functions/dispatch-notifications and libs/mobile/title-detail) passes
 * alongside "Public surface" / "Public API".
 *
 * SCAFFOLD SENTINEL (confirmed by inspecting the Nx generator templates in this
 * workspace — both emit the identical line):
 *   - node_modules/@nx/js/dist/src/generators/library/files/readme/README.md
 *   - node_modules/@nx/angular/dist/src/generators/library/files/base/README.md__tpl__
 * Observed literal (line 3 of both templates):
 *   `This library was generated with [Nx](https://nx.dev).`
 * The regex /generated with \[?Nx\]?/i matches that bracketed form and also the
 * shorter unbracketed `...generated with Nx.` variant, so no widening is needed.
 */
const SCAFFOLD_SENTINEL = /generated with \[?Nx\]?/i;
const PUBLIC_SURFACE_HEADING = /barrel|public/i;
const BOUNDARY_HEADING = /sheriff|boundar/i;

// Resolve the repo root relative to THIS spec file (not cwd): this file lives at
// <root>/tools/doc-integrity-test/src/lib-readme.spec.ts, so three levels up is
// the workspace root.
const specDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(specDir, '..', '..', '..');

interface ReadmeCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Recursively collect every `README.md` under `libs/`. A plain fs walk (no glob
 * dependency, no experimental API) so enumeration is deterministic and stable.
 */
function findLibReadmes(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...findLibReadmes(full));
    } else if (entry.isFile() && entry.name === 'README.md') {
      found.push(full);
    }
  }
  return found;
}

/**
 * Pure predicate: apply the four checks (title on line 1, public-surface
 * heading present, boundary heading present, scaffold sentinel absent) to a
 * README's raw contents. Returns { ok, problems } so callers can report exactly
 * what failed.
 */
function checkReadme(contents: string): ReadmeCheck {
  const problems: string[] = [];
  const lines = contents.split(/\r?\n/);

  // 1. Title: a top-level `# ` heading on line 1.
  const firstLine = lines[0] ?? '';
  if (!/^# .+/.test(firstLine)) {
    problems.push('missing top-level "# " title heading on line 1');
  }

  // Collect the ATX heading text (strip leading #s) for presence checks.
  const headingTexts = lines
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, ''));

  // 2. Public-surface heading matching /barrel|public/i.
  if (!headingTexts.some((h) => PUBLIC_SURFACE_HEADING.test(h))) {
    problems.push(
      'missing public-surface heading (expected a heading matching /barrel|public/i, e.g. "Public surface", "Public API", "Barrel exports")',
    );
  }

  // 3. Boundary heading matching /sheriff|boundar/i.
  if (!headingTexts.some((h) => BOUNDARY_HEADING.test(h))) {
    problems.push(
      'missing boundary heading (expected a heading matching /sheriff|boundar/i, e.g. "Sheriff scope", "Sheriff boundaries", "Boundaries")',
    );
  }

  // 4. Scaffold sentinel must be ABSENT anywhere in the file.
  if (SCAFFOLD_SENTINEL.test(contents)) {
    problems.push(
      'contains the Nx library-generator scaffold sentinel (/generated with \\[?Nx\\]?/i) — the README was left as generated scaffold',
    );
  }

  return { ok: problems.length === 0, problems };
}

describe('lib-README guard', () => {
  describe('live assertion — every real libs/**/README.md passes', () => {
    const readmePaths = findLibReadmes(join(workspaceRoot, 'libs')).sort();

    it('finds the full set of lib READMEs (sanity: > 0, expected 12)', () => {
      expect(readmePaths.length).toBeGreaterThan(0);
      // There are 12 lib READMEs at the time of writing (§8). Asserting the
      // exact count guards against a broken glob silently checking nothing.
      expect(readmePaths.length).toBe(12);
    });

    it.each(readmePaths)(
      '%s satisfies the marker trio with no scaffold',
      (path) => {
        const contents = readFileSync(path, 'utf8');
        const { ok, problems } = checkReadme(contents);
        expect(
          ok,
          `${relative(workspaceRoot, path)} failed lib-README guard:\n  - ${problems.join('\n  - ')}`,
        ).toBe(true);
      },
    );
  });

  describe('fixture cases (pure predicate)', () => {
    const goodBase = [
      '# @vultus/example/lib',
      '',
      'A short intro describing what the lib is.',
      '',
      '## Public surface',
      '',
      'Exports the thing.',
      '',
      '## Sheriff boundaries',
      '',
      'scope:shared.',
      '',
    ].join('\n');

    it('(a) FAILS when the README contains the Nx scaffold sentinel', () => {
      const scaffold = [
        '# example-lib',
        '',
        'This library was generated with [Nx](https://nx.dev).',
        '',
        '## Public surface',
        '',
        '## Sheriff boundaries',
        '',
      ].join('\n');
      const { ok, problems } = checkReadme(scaffold);
      expect(ok).toBe(false);
      expect(problems.some((p) => /scaffold sentinel/i.test(p))).toBe(true);
    });

    it('(b) FAILS when the Sheriff/boundary heading is missing', () => {
      const noBoundary = [
        '# @vultus/example/lib',
        '',
        'Intro.',
        '',
        '## Public surface',
        '',
        'Exports the thing.',
        '',
      ].join('\n');
      const { ok, problems } = checkReadme(noBoundary);
      expect(ok).toBe(false);
      expect(problems.some((p) => /boundary heading/i.test(p))).toBe(true);
    });

    it('(c) FAILS when the public-surface/barrel heading is missing', () => {
      const noPublicSurface = [
        '# @vultus/example/lib',
        '',
        'Intro.',
        '',
        '## Behaviour',
        '',
        'Does stuff.',
        '',
        '## Sheriff boundaries',
        '',
        'scope:shared.',
        '',
      ].join('\n');
      const { ok, problems } = checkReadme(noPublicSurface);
      expect(ok).toBe(false);
      expect(problems.some((p) => /public-surface heading/i.test(p))).toBe(
        true,
      );
    });

    it('(d) PASSES with ONLY a "Barrel exports" public-surface heading (mirrors libs/functions/dispatch-notifications)', () => {
      const barrelOnly = [
        '# @vultus/functions/dispatch-notifications',
        '',
        'Intro describing the port/adapter design.',
        '',
        '## Barrel exports',
        '',
        'Exports the dispatcher.',
        '',
        '## Boundaries',
        '',
        'scope:functions.',
        '',
      ].join('\n');
      const { ok, problems } = checkReadme(barrelOnly);
      expect(
        ok,
        `expected barrel-only README to pass but got:\n  - ${problems.join('\n  - ')}`,
      ).toBe(true);
    });

    it('a well-formed README passes (baseline)', () => {
      expect(checkReadme(goodBase).ok).toBe(true);
    });
  });
});
