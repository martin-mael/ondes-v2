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
};

describe('back-timing benchmark', () => {
  it('generates a week for a 20k-track library', () => {
    const dates = Array.from({ length: 7 }, (_, i) => addDays('2026-10-19', i));
    const snapshot = hardStartSnapshot(dates, {
      songs: 20_000,
      airedBefore: new Date('2026-10-18T22:00:00Z'),
    });
    const started = runtime.performance.now();
    const days = generateDays(snapshot, dates, { extensions: backTiming(snapshot) });
    const ms = runtime.performance.now() - started;
    runtime.console.log(`generator + back-timing: a week, 20k tracks, ${Math.round(ms)} ms`);
    expect(days.flatMap((d) => d.items).filter((i) => i.kind === 'fill').length).toBeGreaterThan(
      7 * 20,
    );
    expect(ms).toBeLessThan(10_000);
  }, 120_000);
});
