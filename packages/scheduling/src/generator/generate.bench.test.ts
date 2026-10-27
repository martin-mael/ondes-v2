import { addDays } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from './fixture.ts';
import { generateDays } from './generate.ts';

// #50's acceptance: a week in under 10 s for a 20k-track library. The library is split over
// three music categories (5k, 7k and 8k songs) and 90 % of it has an older airing, so every
// pick orders thousands of members by time. Runs with the unit tests (CI included) and enforces
// the acceptance bound on CPU time (see `timed`): about 2 s here.

// The package is platform-free (no Node types): reach the runtime through `globalThis`.
const runtime = globalThis as unknown as {
  performance: { now(): number };
  console: { log(message: string): void };
  process: {
    cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
  };
};

/**
 * The CPU time `run` takes, in ms, with its wall time. The bound is on CPU time: Vitest runs each
 * test file in its own process, alongside the others, so on a shared CI runner the wall time
 * also counts the other files' work (#50's 1.7 s week took 6.5 s there). CPU time is what the
 * job costs on a worker, where it runs alone.
 */
function timed<T>(run: () => T): { result: T; cpuMs: number; wallMs: number } {
  const wall = runtime.performance.now();
  const cpu = runtime.process.cpuUsage();
  const result = run();
  const used = runtime.process.cpuUsage(cpu);
  return {
    result,
    cpuMs: (used.user + used.system) / 1000,
    wallMs: runtime.performance.now() - wall,
  };
}

describe('generator benchmark', () => {
  it('generates a week for a 20k-track library', () => {
    const snapshot = fixtureSnapshot({
      songs: 20_000,
      airedBefore: new Date('2026-10-18T22:00:00Z'),
    });
    const dates = Array.from({ length: 7 }, (_, i) => addDays('2026-10-19', i));
    const { result: days, cpuMs, wallMs } = timed(() => generateDays(snapshot, dates));
    runtime.console.log(
      `generator: a week, 20k tracks, ${Math.round(cpuMs)} ms CPU (${Math.round(wallMs)} ms wall)`,
    );
    expect(days.flatMap((d) => d.items).filter((i) => i.kind === 'song').length).toBeGreaterThan(
      7 * 24 * 14,
    );
    expect(cpuMs).toBeLessThan(10_000);
  }, 120_000);
});
