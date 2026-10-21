import { type StationScope, unsafeScope } from '@ondes/db';
import type { StreamMount } from './mounts.ts';

// `stream.source_missing` alerts (type reserved by #33's alert framework): a planned mount has
// had no source for `graceMs`. Listeners hear the fallback loop meanwhile, so it's a warning,
// and the grace period keeps an ordinary engine restart (a few seconds) from raising anything.
// Resolved as soon as the engine is back on the mount.

/** The part of #33's AlertService this needs (`app.alerts`). */
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

export const SOURCE_MISSING_ALERT = 'stream.source_missing';

export function createSourceAlerts(options: {
  alerts: SourceAlerts;
  /** Default 60 s. */
  graceMs?: number;
  logger?: Logger;
}): {
  onSourceChange: (mount: StreamMount, connected: boolean) => void;
  stop(): void;
} {
  const graceMs = options.graceMs ?? 60_000;
  const pending = new Map<string, NodeJS.Timeout>();

  // The station id comes from the `station` row the plan was read from.
  const scopeOf = (m: StreamMount) => unsafeScope(m.orgId, m.stationId);
  const dedupeKey = (m: StreamMount) => `${SOURCE_MISSING_ALERT}:${m.mount}`;
  const fail = (err: unknown) => options.logger?.warn({ err }, 'stream alert not sent');

  return {
    onSourceChange(mount, connected) {
      const key = dedupeKey(mount);
      clearTimeout(pending.get(key));
      pending.delete(key);
      if (connected) {
        // Always: an alert may have been left open by a previous api process.
        options.alerts.resolve(scopeOf(mount), key, { reason: 'engine reconnected' }).catch(fail);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(key);
        options.alerts
          .raise(scopeOf(mount), {
            type: SOURCE_MISSING_ALERT,
            severity: 'warning',
            dedupeKey: key,
            title: `Stream ${mount.mount} is not fed by the engine`,
            message: mount.fallbackFile
              ? 'Listeners hear the fallback loop until the engine reconnects.'
              : 'Listeners are disconnected: this mount has no fallback.',
            details: { mount: mount.mount, format: mount.format },
          })
          .catch(fail);
      }, graceMs);
      timer.unref();
      pending.set(key, timer);
    },
    stop() {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
