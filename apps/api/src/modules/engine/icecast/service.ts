import { type Db, downsampleListenerStats, recordListenerSamples } from '@ondes/db';
import { createIcecastAdmin } from './admin.ts';
import { createStreamAlerts, type SourceAlerts } from './alerts.ts';
import type { IcecastConfigOptions } from './config.ts';
import { planMounts } from './mounts.ts';
import { createListenerStatsPoller } from './poller.ts';
import { createIcecastConfigSync, type IcecastConfigSync, loadStreamStations } from './sync.ts';

// Wiring for the api process: the config sync (when the api owns Icecast's config), the
// listener stats poller (when it can reach Icecast's admin API) with the hourly downsampling
// of old stats, and the stream alerts. The sync and the poller are optional, so the dev
// stack's static Icecast config keeps working (see deploy/icecast/README.md).

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

export type IcecastServiceConfig = {
  /** `ICECAST_CONFIG_PATH`: write the generated config there. Unset: no config sync. */
  configPath?: string;
  config: IcecastConfigOptions;
  /** `ICECAST_SOURCE_PASSWORD`: master of the per-station source passwords. Required to sync. */
  sourceMaster?: string;
  /** `ICECAST_ASSETS_DIR`: the fallback/intro files volume, as the api sees it. */
  assetsDir?: string;
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
 * `ICECAST_CONFIG_PATH` + `ICECAST_SOURCE_PASSWORD` (+ `ICECAST_ASSETS_DIR`,
 * `ICECAST_PUBLIC_HOSTNAME`, `ICECAST_LOCATION`, `ICECAST_ADMIN_EMAIL`,
 * `ICECAST_SYNC_INTERVAL_MS`) for the config sync; `ICECAST_URL` + `ICECAST_ADMIN_USER` +
 * `ICECAST_ADMIN_PASSWORD` (+ `ICECAST_STATS_INTERVAL_MS`) for the poller.
 */
export function icecastServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IcecastServiceConfig {
  const { ICECAST_URL: url, ICECAST_ADMIN_PASSWORD: password } = env;
  const configPath = env.ICECAST_CONFIG_PATH || undefined;
  if (configPath && !env.ICECAST_SOURCE_PASSWORD) {
    throw new Error('ICECAST_CONFIG_PATH is set but ICECAST_SOURCE_PASSWORD is not');
  }
  return {
    configPath,
    sourceMaster: env.ICECAST_SOURCE_PASSWORD || undefined,
    assetsDir: env.ICECAST_ASSETS_DIR || undefined,
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
  /** #33's alert service (`app.alerts`): stream alerts are raised through it when set. */
  alerts?: SourceAlerts;
}): IcecastService {
  const { db, config, logger } = options;
  const alerts = options.alerts
    ? createStreamAlerts({ alerts: options.alerts, logger })
    : undefined;
  const sync = config.configPath
    ? createIcecastConfigSync({
        db,
        path: config.configPath,
        config: config.config,
        sourceMaster: config.sourceMaster ?? '',
        assetsDir: config.assetsDir,
        intervalMs: config.syncIntervalMs,
        logger,
        onConfigInvalid: alerts?.onConfigInvalid,
        onConfigValid: alerts?.onConfigValid,
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
        onSourceChange: alerts?.onSourceChange,
        onMountRemoved: alerts?.onMountRemoved,
        onIcecastReachable: alerts?.onIcecastReachable,
      })
    : undefined;
  let retention: NodeJS.Timeout | undefined;
  const downsample = () =>
    downsampleListenerStats(db).then(
      (r) => {
        if (r.folded || r.deleted) logger?.info(r, 'listener stats downsampled');
      },
      (err) => logger?.warn({ err }, 'listener stats downsampling failed'),
    );

  return {
    sync,
    start() {
      sync?.start();
      poller?.start();
      if (poller && !retention) {
        void downsample();
        retention = setInterval(downsample, 3_600_000);
        retention.unref();
      }
    },
    async stop() {
      clearInterval(retention);
      retention = undefined;
      alerts?.stop();
      await Promise.all([sync?.stop(), poller?.stop()]);
    },
  };
}
