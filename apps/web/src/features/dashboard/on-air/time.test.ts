import type { OnAir } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  countdown,
  formatDuration,
  nextBoundary,
  nextTickAt,
  progressOf,
  withOverrun,
} from './time.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `01a15ddf-0000-7000-8000-${String(n).padStart(12, '0')}`;

function snap(over: Partial<OnAir> = {}): OnAir {
  return {
    at: iso(100_000),
    mode: { kind: 'automation', djName: null },
    current: null,
    next: [],
    nextHardEvent: null,
    show: null,
    ...over,
  };
}

const show = (endsAt: number): OnAir['show'] => ({
  showId: id(1),
  name: 'Show',
  colour: null,
  artworkUrl: null,
  type: 'live',
  startsAt: iso(0),
  endsAt: iso(endsAt),
  episode: null,
  rerun: false,
});

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

  it('names the soonest boundary after the snapshot: show end or next event', () => {
    expect(nextBoundary(snap())).toBeNull();
    expect(nextBoundary(snap({ show: show(500_000) }))).toBe(500_000);
    const event = {
      kind: 'show' as const,
      at: iso(300_000),
      title: 'Next',
      logItemId: null,
      showId: id(2),
    };
    expect(nextBoundary(snap({ show: show(500_000), nextHardEvent: event }))).toBe(300_000);
    // Already past at the snapshot's time: the api has seen it, nothing to wait for.
    expect(nextBoundary(snap({ show: show(90_000) }))).toBeNull();
  });

  it('pushes the flow items while the item on air overruns, up to an anchored one', () => {
    const item = (n: number, start: number, timing: 'flow' | 'hard' = 'flow') => ({
      logItemId: id(n),
      kind: n === 3 ? ('marker' as const) : ('song' as const),
      timing,
      title: `I${n}`,
      artists: [],
      plannedStart: iso(start),
      estimatedStart: iso(start),
      durationMs: 60_000,
    });
    const s = snap({
      // Expected to end at 100 s, the snapshot's time.
      current: {
        asRunId: id(9),
        source: 'log',
        kind: 'song',
        logItemId: id(8),
        title: 'On air',
        artist: null,
        startedAt: iso(0),
        durationMs: 100_000,
        introMs: null,
        outroMs: null,
      },
      next: [item(1, 100_000), item(3, 160_000), item(4, 400_000, 'hard'), item(5, 460_000)],
      nextHardEvent: {
        kind: 'marker',
        at: iso(160_000),
        title: 'I3',
        logItemId: id(3),
        showId: null,
      },
    });
    expect(withOverrun(s, 99_000).next).toBe(s.next);
    const late = withOverrun(s, 107_000);
    expect(late.next.map((i) => i.estimatedStart)).toEqual([
      iso(107_000),
      iso(167_000),
      iso(400_000),
      iso(460_000),
    ]);
    expect(late.nextHardEvent?.at).toBe(iso(167_000));
    // Live and safety follow the plan from now: nothing to push.
    const live = { ...s, current: s.current && { ...s.current, source: 'live' as const } };
    expect(withOverrun(live, 107_000).next).toBe(s.next);
  });
});
