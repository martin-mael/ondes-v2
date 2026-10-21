import { defineConfig } from 'vitest/config';

// Unit tests: `*.test.ts` next to the code. Integration tests (`*.int.test.ts`) need the
// services from deploy/compose.dev.yml and run through vitest.integration.config.ts.
// The web app has its own project (happy-dom, Vite config): apps/web/vitest.config.ts.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.int.test.ts', 'apps/web/**'],
        },
      },
      'apps/web/vitest.config.ts',
    ],
  },
});
