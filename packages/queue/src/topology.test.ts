import { describe, expect, it } from 'vitest';
import { createTopology } from './topology.ts';

describe('createTopology', () => {
  it('defaults to 10 s / 1 min / 10 min tiers and 4 attempts', () => {
    const t = createTopology();
    expect(t.retryTiersMs).toEqual([10_000, 60_000, 600_000]);
    expect(t.maxAttempts).toBe(4);
    expect([1, 2, 3].map(t.retryDelayFor)).toEqual([10_000, 60_000, 600_000]);
  });

  it('repeats the last tier when attempts outnumber tiers', () => {
    const t = createTopology({ retryTiersMs: [100, 200], maxAttempts: 5 });
    expect([1, 2, 3, 4].map(t.retryDelayFor)).toEqual([100, 200, 200, 200]);
  });

  it('names queues per lane and per delay', () => {
    const t = createTopology({ prefix: 'x' });
    expect(t.laneQueue('high')).toBe('x.jobs.high');
    expect(t.retryQueue('bulk', 60_000)).toBe('x.jobs.bulk.retry.60000ms');
    expect(t.deadQueue).toBe('x.jobs.dead');
    expect(t.eventsExchange).toBe('x.events');
  });

  it('rejects empty or invalid tiers', () => {
    expect(() => createTopology({ retryTiersMs: [] })).toThrow();
    expect(() => createTopology({ retryTiersMs: [0] })).toThrow();
    expect(() => createTopology({ maxAttempts: 0 })).toThrow();
  });
});
