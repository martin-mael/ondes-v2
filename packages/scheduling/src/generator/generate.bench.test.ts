import { addDays } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from './fixture.ts';
import { generateDays } from './generate.ts';

// #50's acceptance: a week in under 10 s for a 20k-track library. The library is split over
// three music categories (5k, 7k and 8k songs) and 90 % of it has an older airing, so every
// pick orders thousands of members by time. Runs with the unit tests; the time limit only
// applies with ONDES_BENCH=1, since a shared or loaded machine makes timings meaningless.

// The package is platform-free (no Node types): reach the runtime through `globalThis`.
const runtime = globalThis as unknown as {
  performance: { now(): number };
  console: { log(message: string): void };
  process?: { env: Record<string, string | undefined> };
};

describe('generator benchmark', () => {
  it('generates a week for a 20k-track library', () => {
    const snapshot = fixtureSnapshot({
      songs: 20_000,
      airedBefore: new Date('2026-10-18T22:00:00Z'),
    });
    const dates = Array.from({ length: 7 }, (_, i) => addDays('2026-10-19', i));
    const started = runtime.performance.now();
    const days = generateDays(snapshot, dates);
    const ms = runtime.performance.now() - started;
    runtime.console.log(`generator: a week, 20k tracks, ${Math.round(ms)} ms`);
    expect(days.flatMap((d) => d.items).filter((i) => i.kind === 'song').length).toBeGreaterThan(
      7 * 24 * 14,
    );
    if (runtime.process?.env.ONDES_BENCH === '1') expect(ms).toBeLessThan(10_000);
  }, 120_000);
});
