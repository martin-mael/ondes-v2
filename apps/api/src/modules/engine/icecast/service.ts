import { type Db, recordListenerSamples } from '@ondes/db';
import { createIcecastAdmin } from './admin.ts';
import { createSourceAlerts, type SourceAlerts } from './alerts.ts';
import type { IcecastConfigOptions } from './config.ts';
import { planMounts } from './mounts.ts';
import { createListenerStatsPoller } from './poller.ts';
import { createIcecastConfigSync, type IcecastConfigSync, loadStreamStations } from './sync.ts';

// Wiring for the api process: the config sync (when the api owns Icecast's config) and the
// listener stats poller (when it can reach Icecast's admin API). Both are optional, so the
// dev stack's static Icecast config keeps working (see deploy/icecast/README.md).

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

export type IcecastServiceConfig = {
  /** `ICECAST_CONFIG_PATH`: write the generated config there. Unset: no config sync. */
  configPath?: string;
  config: IcecastConfigOptions;
  syncIntervalMs?: number;
  /** Unset: no stats poller. */
  admin?: { url: string; user: string; password: string };
  statsIntervalMs?: number;
};

const ms = (value: string | undefined) => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1000) throw new Error(`invalid interval: ${value} (ms, ≥ 1000)`);
  return n;
};

/**
 * `ICECAST_CONFIG_PATH`, `ICECAST_PUBLIC_HOSTNAME`, `ICECAST_LOCATION`, `ICECAST_ADMIN_EMAIL`,
 * `ICECAST_SYNC_INTERVAL_MS`; `ICECAST_URL` + `ICECAST_ADMIN_USER` + `ICECAST_ADMIN_PASSWORD`
 * for the poller, `ICECAST_STATS_INTERVAL_MS`.
 */
export function icecastServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IcecastServiceConfig {
  const { ICECAST_URL: url, ICECAST_ADMIN_PASSWORD: password } = env;
  return {
    configPath: env.ICECAST_CONFIG_PATH || undefined,
    config: {
      hostname: env.ICECAST_PUBLIC_HOSTNAME || 'localhost',
      ...(env.ICECAST_LOCATION ? { location: env.ICECAST_LOCATION } : {}),
      ...(env.ICECAST_ADMIN_EMAIL ? { adminEmail: env.ICECAST_ADMIN_EMAIL } : {}),
    },
    syncIntervalMs: ms(env.ICECAST_SYNC_INTERVAL_MS),
    admin: url && password ? { url, user: env.ICECAST_ADMIN_USER || 'admin', password } : undefined,
    statsIntervalMs: ms(env.ICECAST_STATS_INTERVAL_MS),
  };
}

export type IcecastService = {
  sync?: IcecastConfigSync;
  start(): void;
  stop(): Promise<void>;
};

export function createIcecastService(options: {
  db: Db;
  config: IcecastServiceConfig;
  logger?: Logger;
  /** #33's alert service: raises `stream.source_missing` when a mount stays without engine. */
  alerts?: SourceAlerts;
}): IcecastService {
  const { db, config, logger } = options;
  const sourceAlerts = options.alerts
    ? createSourceAlerts({ alerts: options.alerts, logger })
    : undefined;
  const sync = config.configPath
    ? createIcecastConfigSync({
        db,
        path: config.configPath,
        config: config.config,
        intervalMs: config.syncIntervalMs,
        logger,
      })
    : undefined;
  const poller = config.admin
    ? createListenerStatsPoller({
        admin: createIcecastAdmin(config.admin),
        // Same plan as the config when the api writes it; read from the database otherwise.
        mounts: sync ? sync.mounts : async () => planMounts(await loadStreamStations(db)).mounts,
        record: (samples) => recordListenerSamples(db, samples),
        intervalMs: config.statsIntervalMs,
        logger,
        onSourceChange: sourceAlerts?.onSourceChange,
      })
    : undefined;

  return {
    sync,
    start() {
      sync?.start();
      poller?.start();
    },
    async stop() {
      sourceAlerts?.stop();
      await Promise.all([sync?.stop(), poller?.stop()]);
    },
  };
}
