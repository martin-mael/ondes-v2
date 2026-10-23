import { describe, expect, it } from 'vitest';
import { countdown, formatDuration, nextTickAt, progressOf } from './time.ts';

describe('on-air time', () => {
  it('wakes on the soonest second boundary of any anchor', () => {
    // Wall clock at 10.200 s; an item started at 3.950 s: its next second ticks at 10.950.
    expect(nextTickAt(10_200, [0])).toBe(11_000);
    expect(nextTickAt(10_200, [0, 3_950])).toBe(10_950);
    // Exactly on a boundary: the next one, a second later.
    expect(nextTickAt(11_000, [0])).toBe(12_000);
    // Anchors in the future count too (a countdown).
    expect(nextTickAt(10_200, [60_700])).toBe(10_700);
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3_725)).toBe('1:02:05');
  });

  it('keeps elapsed + remaining equal to the length, whatever the phase', () => {
    const start = 1_000_250;
    for (const into of [0, 1, 999, 1_000, 59_400, 179_999]) {
      const p = progressOf(start, 180_000, start + into);
      expect(p.elapsed + (p.remaining ?? 0)).toBeGreaterThanOrEqual(180);
      expect(p.elapsed + (p.remaining ?? 0)).toBeLessThanOrEqual(181);
    }
    expect(progressOf(start, 180_000, start + 200_000)).toMatchObject({
      elapsed: 200,
      remaining: 0,
      percent: 100,
    });
    expect(progressOf(start, null, start + 5_000)).toEqual({
      elapsed: 5,
      remaining: null,
      percent: null,
    });
  });

  it('counts down to an event', () => {
    expect(countdown(10_000, 9_001)).toBe(1);
    expect(countdown(10_000, 10_000)).toBe(0);
    expect(countdown(10_000, 12_000)).toBe(0);
  });
});
