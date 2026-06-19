/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/functions',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'functions',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Emulator-backed integration specs are NOT part of the default `nx test`
    // run — they need a live Firestore emulator. They run only via the dedicated
    // `test-integration` target (vite.integration.config.mts) behind the emulator.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.spec.ts'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/functions',
      provider: 'v8' as const,
    },
  },
}));
