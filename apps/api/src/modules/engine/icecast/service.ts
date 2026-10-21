import {
  type Db,
  downsampleListenerStats,
  recordListenerSamples,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createIcecastAdmin } from './admin.ts';
import { createStreamAlerts, type SourceAlerts } from './alerts.ts';
import type { IcecastConfigOptions } from './config.ts';
import { planMounts } from './mounts.ts';
import { icecastSourcePassword } from './passwords.ts';
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
  /**
   * `ICECAST_SOURCE_SECRET`: without the engine lifecycle (#35), per-station source passwords
   * are derived from it (`icecastSourcePassword`). Ignored when the lifecycle is there.
   */
  sourceSecret?: string;
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
 * `ICECAST_CONFIG_PATH` (+ `ICECAST_SOURCE_SECRET` without the lifecycle, `ICECAST_ASSETS_DIR`,
 * `ICECAST_PUBLIC_HOSTNAME`, `ICECAST_LOCATION`, `ICECAST_ADMIN_EMAIL`,
 * `ICECAST_SYNC_INTERVAL_MS`) for the config sync; `ICECAST_URL` + `ICECAST_ADMIN_USER` +
 * `ICECAST_ADMIN_PASSWORD` (+ `ICECAST_STATS_INTERVAL_MS`) for the poller.
 */
export function icecastServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IcecastServiceConfig {
  const { ICECAST_URL: url, ICECAST_ADMIN_PASSWORD: password } = env;
  return {
    configPath: env.ICECAST_CONFIG_PATH || undefined,
    sourceSecret: env.ICECAST_SOURCE_SECRET || undefined,
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

/** The part of #35's engine lifecycle (`app.engineLifecycle`) this needs. */
export type EngineLifecycleHooks = {
  secretsFor(
    scope: StationScope,
  ): { icecastSourcePassword: string } | Promise<{ icecastSourcePassword: string }>;
  /** Runs before every engine container create; a throw aborts the create. */
  onBeforeCreate(
    hook: (scope: StationScope, secrets: { icecastSourcePassword: string }) => Promise<unknown>,
  ): void;
};

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
  /**
   * #35's engine lifecycle (`app.engineLifecycle`): the stations' source passwords come from
   * it, and Icecast is synced before every engine create so it knows the password first.
   */
  lifecycle?: EngineLifecycleHooks;
}): IcecastService {
  const { db, config, logger, lifecycle } = options;
  const secret = config.sourceSecret;
  let sourcePasswordFor: ((st: { id: string; orgId: string }) => Promise<string>) | undefined;
  if (lifecycle) {
    sourcePasswordFor = async (st) =>
      (await lifecycle.secretsFor(unsafeScope(st.orgId, st.id))).icecastSourcePassword;
  } else if (secret) {
    icecastSourcePassword(secret, 'check'); // fails fast on a short secret
    sourcePasswordFor = async (st) => icecastSourcePassword(secret, st.id);
  } else if (config.configPath) {
    throw new Error(
      'ICECAST_CONFIG_PATH is set but there is no source of station passwords: ' +
        'the engine lifecycle or ICECAST_SOURCE_SECRET',
    );
  }
  const alerts = options.alerts
    ? createStreamAlerts({ alerts: options.alerts, logger })
    : undefined;
  const sync =
    config.configPath && sourcePasswordFor
      ? createIcecastConfigSync({
          db,
          path: config.configPath,
          config: config.config,
          sourcePasswordFor,
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
  if (sync && lifecycle) {
    // The engine gets its password when its container is created: Icecast must have it first.
    lifecycle.onBeforeCreate((scope, secrets) =>
      sync.syncStation({ id: scope.stationId, orgId: scope.orgId }, secrets.icecastSourcePassword),
    );
  }
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
