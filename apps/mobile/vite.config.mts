/// <reference types='vitest' />
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/mobile',
  resolve: { tsconfigPaths: true },
  plugins: [angular()],
  test: {
    name: 'mobile',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // Ionic/Stencil ship `.js` files that are ESM but live in CommonJS-typed
    // packages, which trips Vitest's SSR module loader. Inline them so Vite
    // transforms them as ESM (the equivalent of the old Jest
    // transformIgnorePatterns allow-list).
    server: {
      deps: {
        inline: [/@ionic/, /@stencil\/core/, /ionicons/],
      },
    },
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/mobile',
      provider: 'v8' as const,
    },
  },
}));
