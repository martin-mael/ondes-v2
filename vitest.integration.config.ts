import { defineConfig } from 'vitest/config';

// Integration tests (`*.int.test.ts`), split into projects that CI runs as separate jobs
// (.github/workflows/ci.yml) so they run in parallel and only when a change needs them.
// `pnpm test:integration` runs all of them; `--project <name>` runs one.
//   engine: tests that start their own Liquidsoap/Icecast compose project (testing/compose.yml).
//   worker: the worker's jobs, which run the worker image's ffmpeg (apps/worker/test/bin).
//   core:   everything else (Postgres, RabbitMQ, Garage).
const engine = [
  'apps/api/src/modules/engine/**/*.int.test.ts',
  'apps/api/src/modules/alerts/silence.int.test.ts',
];
const worker = ['apps/worker/src/**/*.int.test.ts'];

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**'],
    passWithNoTests: true,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          include: ['{apps,packages}/*/src/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', ...engine, ...worker],
        },
      },
      { extends: true, test: { name: 'engine', include: engine } },
      { extends: true, test: { name: 'worker', include: worker } },
    ],
  },
});
