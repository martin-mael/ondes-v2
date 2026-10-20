import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Seam detector unit tests. The engine is not a workspace package, so the root config
// does not pick these up; `pnpm test:engine` runs them through this file.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.test.ts'],
  },
});
