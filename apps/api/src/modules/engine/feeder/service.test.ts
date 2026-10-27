import type { StationScope } from '@ondes/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The feeder service's wake-up for a held item (#52): a plan that holds an item until its time
// syncs the feeder then, not at the next tick. The feeder itself is a stub.

const hold = { current: null as { itemId: string; untilMs: number } | null };
const syncs = vi.fn();

vi.mock('./feeder.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./feeder.ts')>()),
  createStationFeeder: ({ scope }: { scope: StationScope }) => ({
    stationId: scope.stationId,
    sync: async () => {
      syncs(Date.now());
      return { plan: { hold: hold.current }, removed: [], pushed: [] };
    },
    onEvent: () => {},
    stop: () => {},
  }),
}));

const { createFeederService } = await import('./service.ts');

const scope = { orgId: 'org', stationId: 'station' } as StationScope;
const held = new Set<string>();
const leases = {
  acquire: async (id: string) => {
    held.add(id);
    return true;
  },
  release: async (id: string) => void held.delete(id),
  holds: async () => true,
  held: () => held,
  close: async () => {},
};

describe('feeder service: holds', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-21T10:00:00Z') });
    syncs.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('wakes the feeder when the item it holds is due, before the next tick', async () => {
    const service = createFeederService({
      leases,
      stations: async () => [scope],
      depsFor: () => ({}) as never,
      tickMs: 5_000,
      leaseIntervalMs: 60_000,
    });
    hold.current = { itemId: 'j', untilMs: Date.now() + 1_200 };
    await service.refresh();
    const first = syncs.mock.calls.length;
    hold.current = null;
    await vi.advanceTimersByTimeAsync(1_199);
    expect(syncs.mock.calls.length).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncs.mock.calls.length).toBe(first + 1);
    expect(syncs.mock.calls.at(-1)?.[0]).toBe(Date.parse('2026-10-21T10:00:01.200Z'));
    await service.close();
  });

  it('leaves holds beyond the next tick to the tick', async () => {
    const service = createFeederService({
      leases,
      stations: async () => [scope],
      depsFor: () => ({}) as never,
      tickMs: 5_000,
      leaseIntervalMs: 60_000,
    });
    hold.current = { itemId: 'j', untilMs: Date.now() + 60_000 };
    await service.refresh();
    const first = syncs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(syncs.mock.calls.length).toBe(first);
    await service.close();
  });
});
