import { type EngineRealtimeEvent, engineRealtimeEventSchema } from '@ondes/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineAdapter } from './adapter.ts';
import { createEngineHealthMonitor, type EngineHealthMonitor } from './health.ts';
import { type FakeEngine, startFakeEngine } from './testing/fake-engine.ts';

let engine: FakeEngine;
let monitor: EngineHealthMonitor;
let published: EngineRealtimeEvent[];
let ups: Array<{ previous: string; bootChanged: boolean }>;

beforeEach(async () => {
  engine = await startFakeEngine();
  published = [];
  ups = [];
  monitor = createEngineHealthMonitor({
    stationId: engine.stationId,
    engine: createEngineAdapter({
      stationId: engine.stationId,
      baseUrl: engine.url,
      timeoutMs: 100,
      retries: 0,
    }),
    downAfter: 2,
    intervalMs: 10,
    async publish(event) {
      published.push(engineRealtimeEventSchema.parse(event));
    },
    onUp: (_, change) => {
      ups.push(change);
    },
  });
});

afterEach(async () => {
  monitor.stop();
  await engine.close();
});

const types = () => published.map((e) => e.type);

describe('engine health monitor', () => {
  it('reports up on the first probe, then nothing while it stays up', async () => {
    expect(await monitor.probe()).toBe('up');
    await monitor.probe();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'engine.up',
      stationId: engine.stationId,
      data: { bootId: engine.bootId, version: '2.4.6' },
    });
    expect(ups).toEqual([{ previous: 'unknown', bootChanged: false }]);
  });

  it('reports down after consecutive failures, and up again on recovery', async () => {
    await monitor.probe();
    engine.healthStatus = 503;
    expect(await monitor.probe()).toBe('up');
    expect(await monitor.probe()).toBe('down');
    await monitor.probe();
    expect(published[1]).toMatchObject({
      type: 'engine.down',
      data: { bootId: engine.bootId, reason: 'http_503' },
    });
    engine.healthStatus = null;
    expect(await monitor.probe()).toBe('up');
    expect(types()).toEqual(['engine.up', 'engine.down', 'engine.up']);
    expect(ups.at(-1)).toEqual({ previous: 'down', bootChanged: false });
  });

  it('reports a restart faster than the down threshold', async () => {
    await monitor.probe();
    engine.restart();
    await monitor.probe();
    expect(types()).toEqual(['engine.up', 'engine.up']);
    expect(ups.at(-1)).toEqual({ previous: 'up', bootChanged: true });
  });

  it('reports an engine that never came up', async () => {
    await engine.close();
    await monitor.probe();
    await monitor.probe();
    expect(published).toEqual([
      expect.objectContaining({
        type: 'engine.down',
        data: { bootId: null, reason: 'unreachable' },
      }),
    ]);
  });

  it('polls on its own once started', async () => {
    monitor.start();
    await expect.poll(() => engine.calls.length).toBeGreaterThan(3);
    monitor.stop();
    expect(types()).toEqual(['engine.up']);
  });
});
