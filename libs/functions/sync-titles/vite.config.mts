/// <reference types='vitest' />
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/libs/functions/sync-titles',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'functions-sync-titles',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/functions/sync-titles',
      provider: 'v8' as const,
    },
  },
}));
