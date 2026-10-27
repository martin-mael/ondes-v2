import { addDays } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { generateDays } from '../generator/generate.ts';
import { backTiming } from './backtime.ts';
import { hardStartSnapshot } from './fixture.ts';

// #50's budget (a week in under 10 s for a 20k-track library) with back-timing on, as the
// `log-generate` job runs it: every hour and every show re-plans its tail, re-picking songs
// through the rules (`AnchorTools.pick`) with filtered candidate lists.

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

describe('back-timing benchmark', () => {
  it('generates a week for a 20k-track library', () => {
    const dates = Array.from({ length: 7 }, (_, i) => addDays('2026-10-19', i));
    const snapshot = hardStartSnapshot(dates, {
      songs: 20_000,
      airedBefore: new Date('2026-10-18T22:00:00Z'),
    });
    const {
      result: days,
      cpuMs,
      wallMs,
    } = timed(() => generateDays(snapshot, dates, { extensions: backTiming(snapshot) }));
    runtime.console.log(
      `generator + back-timing: a week, 20k tracks, ${Math.round(cpuMs)} ms CPU (${Math.round(wallMs)} ms wall)`,
    );
    expect(days.flatMap((d) => d.items).filter((i) => i.kind === 'fill').length).toBeGreaterThan(
      7 * 20,
    );
    expect(cpuMs).toBeLessThan(10_000);
  }, 120_000);
});
