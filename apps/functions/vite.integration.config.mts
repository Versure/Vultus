/// <reference types='vitest' />
import { defineConfig } from 'vite';

// Dedicated config for the emulator-backed integration spec(s). This is NOT
// part of the default `nx test functions` run (see vite.config.mts, which
// excludes `*.integration.spec.ts`); the `test-integration` Nx target runs only
// this config, and only behind a live Firestore emulator. Intended invocation:
//   pnpm exec firebase emulators:exec --only firestore --project vultus-cab62 \
//     "pnpm nx test-integration functions"
export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/functions-integration',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'functions-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/functions-integration',
      provider: 'v8' as const,
    },
  },
}));
