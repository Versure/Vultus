/// <reference types='vitest' />
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/libs/shared/ui-kit',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'shared-ui-kit',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/shared/ui-kit',
      provider: 'v8' as const,
    },
  },
}));
