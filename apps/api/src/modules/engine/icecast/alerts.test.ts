import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceAlerts, type SourceAlerts } from './alerts.ts';
import { stationMounts } from './mounts.ts';

const [mp3] = stationMounts({ id: 'st-1', orgId: 'org-1', slug: 'vandale', engineSettings: {} });
if (!mp3) throw new Error('no mount');

function fakeAlerts() {
  const calls: Array<[string, string]> = [];
  const alerts: SourceAlerts = {
    raise: async (scope, input) => {
      calls.push([
        'raise',
        `${scope.stationId} ${input.type} ${input.dedupeKey} ${input.severity}`,
      ]);
    },
    resolve: async (scope, key) => {
      calls.push(['resolve', `${scope.stationId} ${key}`]);
    },
  };
  return { alerts, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSourceAlerts', () => {
  it('raises after the grace period and resolves when the engine is back', async () => {
    vi.useFakeTimers();
    const { alerts, calls } = fakeAlerts();
    const s = createSourceAlerts({ alerts, graceMs: 60_000 });
    s.onSourceChange(mp3, false);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([
      ['raise', 'st-1 stream.source_missing stream.source_missing:/vandale/mp3 warning'],
    ]);
    s.onSourceChange(mp3, true);
    await vi.runAllTimersAsync();
    expect(calls.at(-1)).toEqual(['resolve', 'st-1 stream.source_missing:/vandale/mp3']);
  });

  it('raises nothing for a restart shorter than the grace period', async () => {
    vi.useFakeTimers();
    const { alerts, calls } = fakeAlerts();
    const s = createSourceAlerts({ alerts, graceMs: 60_000 });
    s.onSourceChange(mp3, false);
    await vi.advanceTimersByTimeAsync(10_000);
    s.onSourceChange(mp3, true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.map(([kind]) => kind)).toEqual(['resolve']);
    s.stop();
  });
});
