import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStreamAlerts, type SourceAlerts } from './alerts.ts';
import { StationOutputsError, stationMounts } from './mounts.ts';

const [mp3, aac] = stationMounts({
  id: 'st-1',
  orgId: 'org-1',
  slug: 'vandale',
  engineSettings: {},
});
if (!mp3 || !aac) throw new Error('no mounts');
const [other] = stationMounts({ id: 'st-2', orgId: 'org-1', slug: 'other', engineSettings: {} });
if (!other) throw new Error('no mounts');

function setup(opts: { graceMs?: number; resolveHoldMs?: number } = {}) {
  const calls: string[] = [];
  const alerts: SourceAlerts = {
    raise: async (scope, input) => {
      calls.push(`raise ${scope.stationId} ${input.type} ${input.dedupeKey} ${input.severity}`);
    },
    resolve: async (scope, key) => {
      calls.push(`resolve ${scope.stationId} ${key}`);
    },
  };
  const s = createStreamAlerts({ alerts, graceMs: 60_000, resolveHoldMs: 30_000, ...opts });
  return { s, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('stream.source_missing', () => {
  it('raises after the grace period and resolves after the hold', async () => {
    vi.useFakeTimers();
    const { s, calls } = setup();
    s.onSourceChange(mp3, false);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([
      'raise st-1 stream.source_missing stream.source_missing:/vandale/mp3 warning',
    ]);
    s.onSourceChange(mp3, true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.at(-1)).toBe('resolve st-1 stream.source_missing:/vandale/mp3');
  });

  it('neither raises nor resolves on a short flap', async () => {
    vi.useFakeTimers();
    const { s, calls } = setup();
    s.onSourceChange(mp3, false);
    await vi.advanceTimersByTimeAsync(70_000); // raised
    s.onSourceChange(mp3, true);
    await vi.advanceTimersByTimeAsync(5_000);
    s.onSourceChange(mp3, false); // gone again before the hold: stays open
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.filter((c) => c.startsWith('resolve'))).toEqual([]);
  });

  it('forgets a mount that left the plan', async () => {
    vi.useFakeTimers();
    const { s, calls } = setup();
    s.onSourceChange(mp3, false);
    s.onMountRemoved(mp3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual(['resolve st-1 stream.source_missing:/vandale/mp3']);
    s.stop();
  });
});

describe('stream.icecast_unreachable', () => {
  it('raises once per station and resolves them all on recovery', async () => {
    const { s, calls } = setup();
    s.onIcecastReachable(false, [mp3, aac, other]);
    s.onIcecastReachable(false, [mp3, aac, other]);
    s.onIcecastReachable(true, [mp3, aac, other]);
    await Promise.resolve();
    expect(calls).toEqual([
      'raise st-1 stream.icecast_unreachable stream.icecast_unreachable critical',
      'raise st-2 stream.icecast_unreachable stream.icecast_unreachable critical',
      'resolve st-1 stream.icecast_unreachable',
      'resolve st-2 stream.icecast_unreachable',
    ]);
  });
});

describe('stream.config_invalid', () => {
  it('raises and resolves per station', async () => {
    const { s, calls } = setup();
    s.onConfigInvalid(new StationOutputsError({ id: 'st-2', orgId: 'org-1' }, 'bad bitrate'));
    s.onConfigValid({ id: 'st-2', orgId: 'org-1' });
    await Promise.resolve();
    expect(calls).toEqual([
      'raise st-2 stream.config_invalid stream.config_invalid warning',
      'resolve st-2 stream.config_invalid',
    ]);
  });
});
