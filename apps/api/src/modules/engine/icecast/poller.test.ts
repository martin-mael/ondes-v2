import type { ListenerSample } from '@ondes/shared';
import { describe, expect, it, vi } from 'vitest';
import type { IcecastAdmin, IcecastStats } from './admin.ts';
import { stationMounts } from './mounts.ts';
import { createListenerStatsPoller, samplesFromStats } from './poller.ts';

const STATION = '0199f5a8-0000-7000-8000-000000000001';
const mounts = stationMounts({ id: STATION, orgId: STATION, slug: 'vandale', engineSettings: {} });
const at = new Date('2026-10-21T10:00:15Z');

const stats = (sources: IcecastStats['sources']): IcecastStats => ({ listeners: 0, sources });

describe('samplesFromStats', () => {
  it("counts the fallback's listeners for their mount", () => {
    const samples = samplesFromStats(
      stats([
        { mount: '/vandale/mp3', connected: false, listeners: 0 },
        { mount: '/vandale/aac', connected: true, listeners: 1 },
        { mount: '/_ondes/vandale/mp3.fallback.mp3', connected: true, listeners: 2 },
        { mount: '/somebody-else/mp3', connected: true, listeners: 40 },
      ]),
      mounts,
      at,
    );
    expect(samples).toEqual([
      { stationId: STATION, mount: '/vandale/mp3', at, listeners: 2, sourceConnected: false },
      { stationId: STATION, mount: '/vandale/aac', at, listeners: 1, sourceConnected: true },
    ]);
  });
});

describe('createListenerStatsPoller', () => {
  function setup(answers: Array<IcecastStats | Error>) {
    const recorded: ListenerSample[][] = [];
    const changes: Array<[string, boolean]> = [];
    const warn = vi.fn();
    const admin: IcecastAdmin = {
      stats: async () => {
        const next = answers.shift();
        if (!next || next instanceof Error) throw next ?? new Error('no answer');
        return next;
      },
    };
    const poller = createListenerStatsPoller({
      admin,
      mounts: () => mounts,
      record: async (s) => {
        recorded.push(s);
      },
      now: () => at,
      logger: { warn },
      onSourceChange: (m, connected) => changes.push([m.mount, connected]),
    });
    return { poller, recorded, changes, warn };
  }

  it('records nothing while Icecast is unreachable, and warns once', async () => {
    const { poller, recorded, warn } = setup([new Error('down'), new Error('down'), stats([])]);
    expect(await poller.pollOnce()).toEqual([]);
    expect(await poller.pollOnce()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await poller.pollOnce()).toHaveLength(2);
    expect(recorded).toHaveLength(1);
  });

  it('reports source changes only when they change', async () => {
    const live = stats([
      { mount: '/vandale/mp3', connected: true, listeners: 3 },
      { mount: '/vandale/aac', connected: true, listeners: 0 },
    ]);
    const { poller, changes } = setup([
      live,
      live,
      stats([{ mount: '/vandale/aac', connected: true, listeners: 0 }]),
    ]);
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(changes).toEqual([
      ['/vandale/mp3', true],
      ['/vandale/aac', true],
      ['/vandale/mp3', false],
    ]);
  });

  it('keeps polling after a database error', async () => {
    const warn = vi.fn();
    const poller = createListenerStatsPoller({
      admin: { stats: async () => stats([]) },
      mounts: () => mounts,
      record: async () => {
        throw new Error('db down');
      },
      logger: { warn },
    });
    expect(await poller.pollOnce()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'listener stats not recorded');
  });
});
