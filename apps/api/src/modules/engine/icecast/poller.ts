import type { ListenerSample } from '@ondes/shared';
import type { IcecastAdmin, IcecastStats } from './admin.ts';
import type { StreamMount } from './mounts.ts';

// Listener stats poller: every `intervalMs`, reads `/admin/stats` and records one sample per
// planned mount. The database folds the samples into one row per mount and minute
// (`recordListenerSamples`, @ondes/db). Counts only: no addresses ever leave admin.ts.
//
// A mount's listeners include the ones parked on its fallback file (engine down, or mount
// full): they are still this station's audience, and `sourceConnected` tells the two apart.
// When Icecast can't be read, nothing is recorded for that poll: unknown is not zero.

type Logger = {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
};

export type ListenerStatsPollerOptions = {
  admin: IcecastAdmin;
  /** The current mount plan (the config sync's, so both always agree). */
  mounts: () => StreamMount[] | Promise<StreamMount[]>;
  record: (samples: ListenerSample[]) => Promise<void>;
  /** Default 15 s: four samples per minute. */
  intervalMs?: number;
  now?: () => Date;
  logger?: Logger;
  /**
   * The engine connected to or left a mount (first poll included). Listeners keep the
   * fallback meanwhile; this is the hook for a "stream source missing" alert (#33).
   */
  onSourceChange?: (mount: StreamMount, connected: boolean) => void;
};

export type ListenerStatsPoller = {
  /** One poll; resolves with what was recorded (empty when Icecast couldn't be read). */
  pollOnce(): Promise<ListenerSample[]>;
  start(): void;
  stop(): Promise<void>;
};

export function samplesFromStats(
  stats: IcecastStats,
  mounts: StreamMount[],
  at: Date,
): ListenerSample[] {
  const bySource = new Map(stats.sources.map((s) => [s.mount, s]));
  return mounts.map((m) => {
    const live = bySource.get(m.mount);
    const parked = m.fallbackFile ? bySource.get(m.fallbackFile) : undefined;
    return {
      stationId: m.stationId,
      mount: m.mount,
      at,
      listeners: (live?.listeners ?? 0) + (parked?.listeners ?? 0),
      sourceConnected: live?.connected ?? false,
    };
  });
}

export function createListenerStatsPoller(
  options: ListenerStatsPollerOptions,
): ListenerStatsPoller {
  const intervalMs = options.intervalMs ?? 15_000;
  const now = options.now ?? (() => new Date());
  const connected = new Map<string, boolean>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let failing = false;

  async function pollOnce(): Promise<ListenerSample[]> {
    const at = now();
    let stats: IcecastStats;
    let mounts: StreamMount[];
    try {
      [stats, mounts] = await Promise.all([options.admin.stats(), options.mounts()]);
    } catch (err) {
      // Logged once per outage, not every 15 s.
      if (!failing) options.logger?.warn({ err }, 'icecast stats unavailable');
      failing = true;
      return [];
    }
    if (failing) options.logger?.info?.({}, 'icecast stats available again');
    failing = false;

    const samples = samplesFromStats(stats, mounts, at);
    samples.forEach((s, i) => {
      const mount = mounts[i] as StreamMount;
      if (connected.get(s.mount) !== s.sourceConnected) {
        connected.set(s.mount, s.sourceConnected);
        options.onSourceChange?.(mount, s.sourceConnected);
      }
    });
    const planned = new Set(mounts.map((m) => m.mount));
    for (const m of connected.keys()) if (!planned.has(m)) connected.delete(m);

    try {
      await options.record(samples);
    } catch (err) {
      options.logger?.warn({ err }, 'listener stats not recorded');
      return [];
    }
    return samples;
  }

  return {
    pollOnce,
    start() {
      if (timer) return;
      const tick = () => {
        // Never two polls at once: a slow database skips a beat instead of piling up.
        if (running) return;
        running = pollOnce().finally(() => {
          running = undefined;
        });
      };
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
