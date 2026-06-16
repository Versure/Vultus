module.exports = {
  displayName: 'mobile',
  preset: '../../jest.preset.js',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '../../coverage/apps/mobile',
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$',
      },
    ],
  },
  // Ionic / Angular / Stencil ship ESM (.mjs); jest must transform them.
  // pnpm nests packages under node_modules/.pnpm/<name>@<ver>/node_modules/<name>,
  // so match the package name anywhere in the remaining path.
  transformIgnorePatterns: [
    'node_modules/(?!.*(@angular|@ionic|ionicons|@stencil|tslib))',
  ],
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
};
