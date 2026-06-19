import nx from '@nx/eslint-plugin';
import sheriff from '@softarc/eslint-plugin-sheriff';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Vultus root ESLint flat config.
 *
 * Layering (order matters — later entries win):
 *   1. Nx base / TS / JS presets (workspace graph + Nx conventions).
 *   2. Global ignores (dist + the Sheriff negative-test fixture).
 *   3. typescript-eslint recommended (type-checked) for every TS file — our
 *      baseline correctness rules for the whole stack.
 *   4. Sheriff `dependency-rule` — the SINGLE source of truth for module
 *      boundaries (PLAN §3). Never weakened below `error`.
 *   5. Angular component/template best practices, scoped to apps/mobile only.
 *   6. eslint-config-prettier LAST, so formatting-related rules never fight
 *      Prettier (the formatter is the source of truth for layout).
 */
export default tseslint.config(
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // dist/build output, plus the Sheriff negative-test fixture: it contains a
    // deliberate scope:mobile -> scope:functions violation and must never be
    // seen by the production `nx lint` (it is exercised only by the dedicated
    // programmatic-ESLint test in tools/sheriff-test).
    ignores: ['**/dist', '**/out-tsc', 'tools/sheriff-fixtures/**'],
  },

  // --- typescript-eslint, type-checked, for all first-party TS ------------
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // Let typescript-eslint discover the nearest tsconfig per file via the
        // TS project service. `allowDefaultProject` covers root-level config
        // files (vite/capacitor/sheriff configs) that no tsconfig includes.
        projectService: {
          allowDefaultProject: [
            '*.mjs',
            '*.config.ts',
            '*.config.mts',
            '*.config.cts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // --- Sheriff: module-boundary enforcement (single source of truth) ------
  {
    // Sheriff is the single enforcement mechanism for the module boundaries
    // declared in sheriff.config.ts (replacing @nx/enforce-module-boundaries).
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@softarc/sheriff': sheriff },
    rules: {
      '@softarc/sheriff/dependency-rule': 'error',
    },
  },

  // --- Angular TS best practices — apps/mobile (prefix `app`) -------------
  {
    files: ['apps/mobile/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
    },
  },

  // --- Angular TS best practices — mobile slice libs (prefix `lib`) -------
  // The mobile slice libs (libs/mobile/*) are the first libs to ship Angular
  // components + templates; their generated components use the `lib` selector
  // prefix. This mirrors each lib's own eslint.config.mjs so the root config
  // (used by the lint-staged pre-commit gate) also recognises them.
  {
    files: ['libs/mobile/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'lib', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'lib', style: 'kebab-case' },
      ],
    },
  },

  // --- Angular template best practices + a11y — mobile app + slice libs ---
  {
    files: ['apps/mobile/**/*.html', 'libs/mobile/**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
    ],
  },

  // --- Prettier: disable all formatting rules (must stay last) ------------
  prettier,
);
