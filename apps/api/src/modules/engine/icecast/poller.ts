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
  /** A mount seen by an earlier poll is no longer planned. */
  onMountRemoved?: (mount: StreamMount) => void;
  /**
   * Icecast stopped answering (`failuresBeforeDown` polls in a row) or answers again; with
   * the planned mounts, i.e. the stations it serves.
   */
  onIcecastReachable?: (reachable: boolean, mounts: StreamMount[]) => void;
  /** Default 4: one minute at the default interval. */
  failuresBeforeDown?: number;
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
  const failuresBeforeDown = options.failuresBeforeDown ?? 4;
  const connected = new Map<string, boolean>();
  /** Every mount the poller has reported on, to tell when one leaves the plan. */
  const seen = new Map<string, StreamMount>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let failures = 0;
  let down = false;

  async function pollOnce(): Promise<ListenerSample[]> {
    const at = now();
    let mounts: StreamMount[];
    try {
      mounts = await options.mounts();
    } catch (err) {
      options.logger?.warn({ err }, 'stream mounts unavailable');
      return [];
    }
    let stats: IcecastStats;
    try {
      stats = await options.admin.stats();
    } catch (err) {
      failures++;
      // Logged once per outage, not every 15 s.
      if (failures === 1) options.logger?.warn({ err }, 'icecast stats unavailable');
      if (failures >= failuresBeforeDown && !down) {
        down = true;
        options.onIcecastReachable?.(false, mounts);
      }
      return [];
    }
    if (failures > 0) options.logger?.info?.({ failures }, 'icecast stats available again');
    failures = 0;
    if (down) {
      down = false;
      options.onIcecastReachable?.(true, mounts);
    }

    const samples = samplesFromStats(stats, mounts, at);
    samples.forEach((s, i) => {
      const mount = mounts[i] as StreamMount;
      seen.set(mount.mount, mount);
      if (connected.get(s.mount) !== s.sourceConnected) {
        connected.set(s.mount, s.sourceConnected);
        options.onSourceChange?.(mount, s.sourceConnected);
      }
    });
    const planned = new Set(mounts.map((m) => m.mount));
    for (const [name, mount] of seen) {
      if (planned.has(name)) continue;
      seen.delete(name);
      connected.delete(name);
      options.onMountRemoved?.(mount);
    }

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
