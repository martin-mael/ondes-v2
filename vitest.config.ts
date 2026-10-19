import { defineConfig } from 'vitest/config';

// Unit tests: `*.test.ts` next to the code. Integration tests (`*.int.test.ts`) need the
// services from deploy/compose.dev.yml and run through vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.int.test.ts'],
  },
});
