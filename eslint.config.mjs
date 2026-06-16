import nx from '@nx/eslint-plugin';
import sheriff from '@softarc/eslint-plugin-sheriff';

export default [
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
  {
    // Sheriff is the single enforcement mechanism for the module boundaries
    // declared in sheriff.config.ts (replacing @nx/enforce-module-boundaries).
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@softarc/sheriff': sheriff },
    rules: {
      '@softarc/sheriff/dependency-rule': 'error',
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
