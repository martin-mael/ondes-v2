import { type StationScope, unsafeScope } from '@ondes/db';
import type { StationOutputsError, StreamMount } from './mounts.ts';

// Stream alerts, through #33's alert framework (`app.alerts`):
// - `stream.source_missing` (warning): a planned mount has had no engine for `graceMs`.
//   Listeners hear the fallback loop meanwhile, and the grace period keeps an ordinary engine
//   restart from raising anything. Resolved once the engine has been back for `resolveHoldMs`,
//   so a flapping source doesn't open and close alerts every poll.
// - `stream.config_invalid` (warning): a station's outputs don't validate; Icecast keeps its
//   last good mounts. Resolved when they validate again.
// - `stream.icecast_unreachable` (critical): the stats poller couldn't read Icecast several
//   times in a row. Raised for every station with mounts (each station's streams are down),
//   resolved on the next successful poll.
// Scopes come from `station` rows (the plan), hence `unsafeScope`.

/** The part of #33's AlertService this needs. */
export type SourceAlerts = {
  raise(
    scope: StationScope,
    input: {
      type: string;
      severity: 'info' | 'warning' | 'critical';
      dedupeKey: string;
      title: string;
      message?: string;
      details?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  resolve(scope: StationScope, dedupeKey: string, opts?: { reason?: string }): Promise<unknown>;
};

type Logger = { warn(obj: object, msg: string): void };

export const STREAM_ALERT = {
  sourceMissing: 'stream.source_missing',
  configInvalid: 'stream.config_invalid',
  icecastUnreachable: 'stream.icecast_unreachable',
} as const;

export type StreamAlerts = {
  onSourceChange(mount: StreamMount, connected: boolean): void;
  /** The mount left the plan: drop its pending timers and close its alert. */
  onMountRemoved(mount: StreamMount): void;
  onIcecastReachable(reachable: boolean, mounts: StreamMount[]): void;
  onConfigInvalid(err: StationOutputsError): void;
  onConfigValid(station: { id: string; orgId: string }): void;
  stop(): void;
};

export function createStreamAlerts(options: {
  alerts: SourceAlerts;
  /** Without engine this long before alerting. Default 60 s. */
  graceMs?: number;
  /** Back this long before resolving. Default 30 s. */
  resolveHoldMs?: number;
  logger?: Logger;
}): StreamAlerts {
  const graceMs = options.graceMs ?? 60_000;
  const holdMs = options.resolveHoldMs ?? 30_000;
  const timers = new Map<string, NodeJS.Timeout>();
  /** Stations alerted as "Icecast unreachable". */
  const unreachable = new Map<string, StationScope>();
  const { alerts } = options;
  const fail = (err: unknown) => options.logger?.warn({ err }, 'stream alert not sent');
  const scopeOf = (m: { stationId: string; orgId: string }) => unsafeScope(m.orgId, m.stationId);
  const sourceKey = (m: StreamMount) => `${STREAM_ALERT.sourceMissing}:${m.mount}`;

  function later(key: string, ms: number, fn: () => Promise<unknown>) {
    clear(key);
    const t = setTimeout(() => {
      timers.delete(key);
      fn().catch(fail);
    }, ms);
    t.unref();
    timers.set(key, t);
  }
  function clear(key: string) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  return {
    onSourceChange(mount, connected) {
      const key = sourceKey(mount);
      if (connected) {
        // Always, after the hold: an alert may have been left open by a previous process.
        later(key, holdMs, () =>
          alerts.resolve(scopeOf(mount), key, { reason: 'engine reconnected' }),
        );
        return;
      }
      later(key, graceMs, () =>
        alerts.raise(scopeOf(mount), {
          type: STREAM_ALERT.sourceMissing,
          severity: 'warning',
          dedupeKey: key,
          title: `Stream ${mount.mount} is not fed by the engine`,
          message: mount.fallbackFile
            ? 'Listeners hear the fallback loop until the engine reconnects.'
            : 'Listeners are disconnected: this mount has no fallback file.',
          details: { mount: mount.mount, format: mount.format },
        }),
      );
    },
    onMountRemoved(mount) {
      const key = sourceKey(mount);
      clear(key);
      alerts.resolve(scopeOf(mount), key, { reason: 'mount removed' }).catch(fail);
    },
    onIcecastReachable(reachable, mounts) {
      const key = STREAM_ALERT.icecastUnreachable;
      if (reachable) {
        for (const scope of unreachable.values()) {
          alerts.resolve(scope, key, { reason: 'Icecast answers again' }).catch(fail);
        }
        unreachable.clear();
        return;
      }
      const stations = new Map(mounts.map((m) => [m.stationId, m]));
      for (const [stationId, m] of stations) {
        if (unreachable.has(stationId)) continue;
        const scope = scopeOf(m);
        unreachable.set(stationId, scope);
        alerts
          .raise(scope, {
            type: key,
            severity: 'critical',
            dedupeKey: key,
            title: 'The stream server is not answering',
            message: 'Icecast serves every station: listeners can probably not connect.',
          })
          .catch(fail);
      }
    },
    onConfigInvalid(err) {
      alerts
        .raise(scopeOf({ stationId: err.stationId, orgId: err.orgId }), {
          type: STREAM_ALERT.configInvalid,
          severity: 'warning',
          dedupeKey: STREAM_ALERT.configInvalid,
          title: "The station's stream settings are invalid",
          message: 'The streams keep their last valid settings until this is fixed.',
          details: { reason: err.reason },
        })
        .catch(fail);
    },
    onConfigValid(station) {
      alerts
        .resolve(
          scopeOf({ stationId: station.id, orgId: station.orgId }),
          STREAM_ALERT.configInvalid,
          {
            reason: 'settings valid',
          },
        )
        .catch(fail);
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
