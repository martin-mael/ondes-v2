import { describe, expect, it } from 'vitest';
import { RestartGuard } from './guard.ts';

describe('restart-storm guard', () => {
  it('trips past maxRestarts in the window, and only once', () => {
    let now = 0;
    const guard = new RestartGuard({ maxRestarts: 3, windowSeconds: 60, now: () => now });
    expect(guard.record('s', 2)).toEqual({ restarts: 2, tripped: false, justTripped: false });
    now = 10_000;
    expect(guard.record('s')).toEqual({ restarts: 3, tripped: false, justTripped: false });
    now = 20_000;
    expect(guard.record('s')).toEqual({ restarts: 4, tripped: true, justTripped: true });
    expect(guard.record('s')).toMatchObject({ tripped: true, justTripped: false });
    expect(guard.isTripped('other')).toBe(false);
  });

  it('forgets restarts older than the window', () => {
    let now = 0;
    const guard = new RestartGuard({ maxRestarts: 2, windowSeconds: 60, now: () => now });
    guard.record('s', 2);
    now = 61_000;
    expect(guard.count('s')).toBe(0);
    expect(guard.record('s')).toEqual({ restarts: 1, tripped: false, justTripped: false });
  });

  it('stays tripped until reset', () => {
    let now = 0;
    const guard = new RestartGuard({ maxRestarts: 1, windowSeconds: 60, now: () => now });
    guard.record('s', 2);
    now = 10 * 60_000;
    expect(guard.isTripped('s')).toBe(true);
    guard.reset('s');
    expect(guard.isTripped('s')).toBe(false);
    expect(guard.count('s')).toBe(0);
  });
});
