import { defineConfig } from 'vitest/config';

// Integration tests (`*.int.test.ts`), split into projects that CI runs as separate jobs
// (.github/workflows/ci.yml) so they run in parallel and only when a change needs them.
// `pnpm test:integration` runs all of them; `--project <name>` runs one.
//   engine: tests that start their own Liquidsoap/Icecast containers (testing/compose.yml).
//   worker: the worker's jobs, which run the worker image's ffmpeg (apps/worker/test/bin).
//   core:   everything else (Postgres, RabbitMQ, Garage).
const engine = [
  'apps/api/src/modules/engine/**/*.int.test.ts',
  'apps/api/src/modules/alerts/silence.int.test.ts',
  // Runs the station template's live input against the harbor auth callback (#63).
  'apps/api/src/modules/live/live-auth.engine.int.test.ts',
  // The harbor pool and live switching, recorded (#64).
  'apps/api/src/modules/live/live-switching.engine.int.test.ts',
  // Live metadata read back from Icecast (#68).
  'apps/api/src/modules/live/live-metadata.engine.int.test.ts',
  // DJ handover: crossfade, mute and cut between two DJs, recorded (#66).
  'apps/api/src/modules/live/live-handover.engine.int.test.ts',
  'apps/api/src/modules/prelisten/prelisten.engine.int.test.ts',
  // Fixed-time markers through the real feeder, recorded (#52).
  'engine/tests/markers/**/*.int.test.ts',
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
