/**
 * lint-staged — local pre-commit gate (paired with .husky/pre-commit).
 *
 * Goal: block any commit that would break lint, Sheriff boundaries, or
 * formatting, while staying fast (no full test suite, no full-workspace lint).
 *
 * - ESLint runs on staged code files with `--fix`. Sheriff's
 *   `@softarc/sheriff/dependency-rule` is wired into the root eslint.config.mjs,
 *   so a cross-scope / cross-slice import in a staged file fails here.
 *   `--max-warnings 0` makes any warning fail the commit too.
 * - Prettier runs on a broader set (incl. json/scss/md/yaml) to keep formatting
 *   consistent and conflict-free with eslint-config-prettier.
 * - Any staged `docs/specs/*.md` spec change re-checks the generated spec-status
 *   ledger (spec 0058): `gen-spec-status.mjs --check` fails the commit if
 *   `docs/specs/STATUS.md` is stale, with a hint to regenerate. The `--check`
 *   mode ignores the staged filenames lint-staged appends and always validates
 *   the whole ledger. STATUS.md itself is prettier-ignored so its exact
 *   generator output is preserved (see .prettierignore).
 *
 * Commands receive the list of staged files as arguments, so only what you are
 * committing is checked — Windows-friendly (no shell globbing, no bash-isms).
 */
export default {
  '**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,html}': [
    'eslint --fix --max-warnings 0',
    'prettier --write',
  ],
  '**/*.{json,scss,css,md,yaml,yml}': ['prettier --write'],
  'docs/specs/*.md': () => 'node tools/scripts/gen-spec-status.mjs --check',
};
