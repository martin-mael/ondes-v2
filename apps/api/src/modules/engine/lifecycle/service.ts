import { randomUUID } from 'node:crypto';
import { type Db, NotFoundError, type StationScope } from '@ondes/db';
import type { EngineRealtimeEvent } from '@ondes/shared';
import {
  createStationEngine,
  type EngineStatus,
  type StationEngineOptions,
  type StationEngines,
} from '../adapter/index.ts';
import { type Logger, silentLogger } from '../adapter/logger.ts';
import { loadStationTemplate, renderStationScript } from '../config/render.ts';
import { type ContainerInfo, type DockerClient, tarFile } from './docker.ts';
import { RestartGuard } from './guard.ts';
import {
  allocatePort,
  listRunningStationScopes,
  loadStationEngine,
  releasePorts,
  type StationEngineRecord,
  setApplied,
  setDesiredState,
} from './repo.ts';
import type { EngineSecretBox, EngineSecrets } from './secrets.ts';
import {
  containerName,
  ENGINE_LABELS,
  ENGINE_PORTS,
  ENGINE_SCRIPT_DIR,
  ENGINE_SCRIPT_PATH,
  type EngineLifecycleConfig,
  engineContainerSpec,
  engineSettingsFor,
} from './spec.ts';

/**
 * Station engine lifecycle (#35): creates, starts, stops and restarts each station's
 * Liquidsoap container through the Docker socket proxy, and keeps one `StationEngine`
 * (adapter + event ingest + health monitor, #28) per running station. See README.md.
 */

/** What `reconcile` did. */
export type ReconcileAction =
  /** No container: created and started. */
  | 'created'
  /** The script (`config_version`) or the container spec changed: replaced. */
  | 'recreated'
  /** The container existed but wasn't running: started. */
  | 'started'
  /** Already running the right script. */
  | 'unchanged'
  /** Desired state is stopped: stopped (or already was). */
  | 'stopped'
  /** The restart-storm guard tripped: left alone until a manual restart. */
  | 'storm';

export type ReconcileResult = {
  action: ReconcileAction;
  /** The rendered script's version (null when stopped). */
  configVersion: string | null;
  /** The version the engine reported before the reconcile, if it answered. */
  reportedVersion: string | null;
};

export type EngineStatusView = {
  stationId: string;
  desiredState: 'running' | 'stopped';
  container: {
    id: string;
    status: string;
    running: boolean;
    restartCount: number;
    configVersion: string | null;
  } | null;
  /** The health monitor's view: `unknown` until the first probe, null when not monitored. */
  health: EngineStatus | null;
  /** `config_version` reported by the engine's last health answer. */
  reportedVersion: string | null;
  /** What the station's current settings render to. */
  expectedVersion: string;
  /** The engine runs an older script than its settings: a restart is due. */
  restartPending: boolean;
  livePort: number | null;
  restartStorm: { tripped: boolean; restarts: number; windowSeconds: number };
};

export type EngineLifecycleOptions = {
  db: Db;
  docker: DockerClient;
  config: EngineLifecycleConfig;
  secretBox: EngineSecretBox;
  engines: StationEngines;
  /** Real-time publisher (the api's RabbitMQ events fanout). */
  publish(event: EngineRealtimeEvent): Promise<void>;
  onResync?: StationEngineOptions['onResync'];
  guard?: RestartGuard;
  /** Health probe tuning for each station's monitor. */
  health?: StationEngineOptions['health'];
  /** Station template source; default: read from disk. */
  template?: string;
  /** Delay between supervisor passes. Default 15 s. */
  superviseIntervalMs?: number;
  logger?: Logger;
};

export type EngineLifecycle = ReturnType<typeof createEngineLifecycle>;

export function createEngineLifecycle(options: EngineLifecycleOptions) {
  const { db, docker, config, secretBox, engines } = options;
  const logger = options.logger ?? silentLogger;
  const guard = options.guard ?? new RestartGuard();
  const template = options.template ?? loadStationTemplate();
  const superviseIntervalMs = options.superviseIntervalMs ?? 15_000;

  /** Control tokens of the stations this api manages, for the events route. */
  const tokens = new Map<string, string>();
  /** Stations kept running by this api, with the last restart count seen. */
  const managed = new Map<string, { scope: StationScope; restartCount: number }>();
  /** Control URL and token each attached `StationEngine` was built with. */
  const attached = new Map<string, { baseUrl: string; token: string }>();
  const locks = new Map<string, Promise<unknown>>();
  let supervisor: NodeJS.Timeout | undefined;
  let supervising = false;

  /** Runs `fn` after any other lifecycle operation on the same station. */
  function serialized<T>(stationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(stationId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => {});
    locks.set(stationId, settled);
    void settled.then(() => {
      if (locks.get(stationId) === settled) locks.delete(stationId);
    });
    return next;
  }

  async function load(scope: StationScope): Promise<StationEngineRecord> {
    const record = await loadStationEngine(db, secretBox, scope);
    if (!record) throw new NotFoundError('station', scope.stationId);
    tokens.set(scope.stationId, record.secrets.controlToken);
    return record;
  }

  function render(record: StationEngineRecord) {
    return renderStationScript(
      engineSettingsFor(
        {
          stationId: record.scope.stationId,
          slug: record.slug,
          name: record.name,
          engineSettings: record.engineSettings,
        },
        config,
      ),
      template,
    );
  }

  function controlUrl(stationId: string, info: ContainerInfo | null): string | null {
    if (!config.publishControlOnLoopback)
      return `http://${containerName(config, stationId)}:${ENGINE_PORTS.control}`;
    const port = info?.NetworkSettings.Ports?.[`${ENGINE_PORTS.control}/tcp`]?.[0]?.HostPort;
    return port ? `http://127.0.0.1:${port}` : null;
  }

  /** (Re)creates the station's `StationEngine` if its control URL or token changed. */
  function attach(scope: StationScope, secrets: EngineSecrets, info: ContainerInfo | null) {
    const baseUrl = controlUrl(scope.stationId, info);
    if (!baseUrl) return;
    const current = attached.get(scope.stationId);
    if (
      engines.get(scope.stationId) &&
      current?.baseUrl === baseUrl &&
      current.token === secrets.controlToken
    )
      return;
    const engine = createStationEngine({
      stationId: scope.stationId,
      baseUrl,
      token: secrets.controlToken,
      publish: options.publish,
      onResync: options.onResync,
      health: options.health,
      logger,
    });
    engines.add(engine);
    attached.set(scope.stationId, { baseUrl, token: secrets.controlToken });
    engine.start();
  }

  function detach(stationId: string) {
    engines.remove(stationId);
    attached.delete(stationId);
    managed.delete(stationId);
  }

  async function reportedVersion(stationId: string): Promise<string | null> {
    const engine = engines.get(stationId);
    if (!engine) return null;
    try {
      return (await engine.adapter.health()).config_version ?? null;
    } catch {
      return null;
    }
  }

  async function createAndStart(
    record: StationEngineRecord,
    script: string,
    body: ReturnType<typeof engineContainerSpec>['body'],
  ): Promise<ContainerInfo> {
    const name = containerName(config, record.scope.stationId);
    await docker.ensureImage(config.image);
    const id = await docker.create(name, body);
    await docker.putArchive(
      id,
      ENGINE_SCRIPT_DIR,
      tarFile(ENGINE_SCRIPT_PATH.slice(ENGINE_SCRIPT_DIR.length + 1), script),
    );
    await docker.start(id);
    const info = await docker.inspect(id);
    if (!info) throw new Error(`engine container ${name} vanished after start`);
    return info;
  }

  async function removeContainer(info: ContainerInfo) {
    await docker.stop(info.Id);
    await docker.remove(info.Id);
  }

  async function tripStorm(scope: StationScope, restarts: number, info: ContainerInfo | null) {
    logger.error({ stationId: scope.stationId, restarts }, 'Engine restart storm: stopping it');
    if (info) {
      await docker.setRestartPolicy(info.Id, { Name: 'no' }).catch(() => {});
      await docker.stop(info.Id).catch(() => {});
    }
    try {
      await options.publish({
        id: randomUUID(),
        type: 'engine.restart_storm',
        stationId: scope.stationId,
        at: new Date().toISOString(),
        data: {
          bootId: engines.get(scope.stationId)?.health.last()?.boot_id ?? null,
          restarts,
          windowSeconds: guard.windowSeconds,
        },
      });
    } catch (error) {
      logger.error({ stationId: scope.stationId, err: error }, 'Publishing restart storm failed');
    }
  }

  async function doReconcile(scope: StationScope): Promise<ReconcileResult> {
    const record = await load(scope);
    const name = containerName(config, scope.stationId);
    let info = await docker.inspect(name);

    if (record.desiredState === 'stopped') {
      detach(scope.stationId);
      if (info?.State.Running) await docker.stop(info.Id);
      return { action: 'stopped', configVersion: null, reportedVersion: null };
    }

    const rendered = render(record);
    if (guard.isTripped(scope.stationId)) {
      return { action: 'storm', configVersion: rendered.version, reportedVersion: null };
    }

    const livePort = rendered.settings.live.enabled
      ? await allocatePort(db, scope, 'live', config.livePorts)
      : null;
    const { body, specHash } = engineContainerSpec(config, {
      station: { stationId: scope.stationId },
      configVersion: rendered.version,
      secrets: record.secrets,
      livePort,
    });

    // The engine says which script it runs: if it answers with another version than the
    // rendered one, the script is stale whatever the labels say.
    if (info?.State.Running) attach(scope, record.secrets, info);
    const reported = info?.State.Running ? await reportedVersion(scope.stationId) : null;

    let action: ReconcileAction;
    if (!info) {
      info = await createAndStart(record, rendered.script, body);
      action = 'created';
    } else if (
      info.Config.Labels?.[ENGINE_LABELS.spec] !== specHash ||
      (reported !== null && reported !== rendered.version)
    ) {
      logger.info(
        {
          stationId: scope.stationId,
          from: reported ?? info.Config.Labels?.[ENGINE_LABELS.configVersion],
          to: rendered.version,
        },
        'Engine config changed: recreating its container',
      );
      await removeContainer(info);
      info = await createAndStart(record, rendered.script, body);
      action = 'recreated';
    } else if (!info.State.Running && !info.State.Restarting) {
      await docker.start(info.Id);
      info = (await docker.inspect(info.Id)) ?? info;
      action = 'started';
    } else {
      action = 'unchanged';
    }

    managed.set(scope.stationId, { scope, restartCount: info.RestartCount });
    attach(scope, record.secrets, info);
    if (action !== 'unchanged' || record.containerId !== info.Id) {
      await setApplied(db, scope, { configVersion: rendered.version, containerId: info.Id });
    }
    return { action, configVersion: rendered.version, reportedVersion: reported };
  }

  /** One supervisor check of a managed station: Docker restarts, dead containers, storms. */
  async function superviseOne(stationId: string): Promise<void> {
    const entry = managed.get(stationId);
    if (!entry) return;
    const { scope } = entry;
    if (guard.isTripped(stationId)) return;
    const info = await docker.inspect(containerName(config, stationId));

    let restarts = 0;
    if (info && info.RestartCount > entry.restartCount)
      restarts += info.RestartCount - entry.restartCount;
    const dead = !info || (!info.State.Running && !info.State.Restarting);
    if (dead) restarts += 1;
    if (info) entry.restartCount = info.RestartCount;
    if (restarts === 0) return;

    const verdict = guard.record(stationId, restarts);
    logger.warn({ stationId, restarts: verdict.restarts, dead }, 'Engine restarted');
    if (verdict.tripped) {
      await tripStorm(scope, verdict.restarts, info);
      return;
    }
    if (dead) await doReconcile(scope);
  }

  async function supervise(): Promise<void> {
    await Promise.all(
      [...managed.keys()].map((stationId) =>
        serialized(stationId, () => superviseOne(stationId)).catch((error) => {
          logger.error({ stationId, err: error }, 'Engine supervision failed');
        }),
      ),
    );
  }

  function loop() {
    if (!supervising) return;
    void supervise().finally(() => {
      if (!supervising) return;
      supervisor = setTimeout(loop, superviseIntervalMs);
      supervisor.unref();
    });
  }

  return {
    guard,

    /**
     * Makes the station's container match its settings and desired state. Restarts the
     * engine only when needed: a new `config_version` (settings or template changed) or a
     * changed container spec. Call it after changing `station.engine_settings`.
     */
    reconcile(scope: StationScope): Promise<ReconcileResult> {
      return serialized(scope.stationId, () => doReconcile(scope));
    },

    /** Marks the engine as wanted and brings it up. */
    start(scope: StationScope): Promise<ReconcileResult> {
      return serialized(scope.stationId, async () => {
        await load(scope);
        await setDesiredState(db, scope, 'running');
        return doReconcile(scope);
      });
    },

    /** Marks the engine as not wanted and stops its container (kept, for its logs). */
    stop(scope: StationScope): Promise<ReconcileResult> {
      return serialized(scope.stationId, async () => {
        await load(scope);
        await setDesiredState(db, scope, 'stopped');
        return doReconcile(scope);
      });
    },

    /**
     * A person's restart: clears the storm guard and replaces the container even if
     * nothing changed (a fresh boot, an empty queue: the feeder re-pushes on `boot`).
     */
    restart(scope: StationScope): Promise<ReconcileResult> {
      return serialized(scope.stationId, async () => {
        guard.reset(scope.stationId);
        await load(scope);
        await setDesiredState(db, scope, 'running');
        const info = await docker.inspect(containerName(config, scope.stationId));
        if (info) {
          await removeContainer(info);
          await setApplied(db, scope, { configVersion: null, containerId: null });
        }
        const result = await doReconcile(scope);
        return { ...result, action: info ? 'recreated' : result.action };
      });
    },

    /** Removes the container and gives the station's ports back (station deletion). */
    remove(scope: StationScope): Promise<void> {
      return serialized(scope.stationId, async () => {
        detach(scope.stationId);
        tokens.delete(scope.stationId);
        const info = await docker.inspect(containerName(config, scope.stationId));
        if (info) await removeContainer(info);
        await setApplied(db, scope, { configVersion: null, containerId: null });
        await setDesiredState(db, scope, 'stopped');
        await releasePorts(db, scope);
      });
    },

    async status(scope: StationScope): Promise<EngineStatusView> {
      const record = await load(scope);
      const rendered = render(record);
      const info = await docker.inspect(containerName(config, scope.stationId));
      const engine = engines.get(scope.stationId);
      const reported = engine?.health.last()?.config_version ?? null;
      const livePort = info?.NetworkSettings.Ports?.[`${ENGINE_PORTS.live}/tcp`]?.[0]?.HostPort;
      return {
        stationId: scope.stationId,
        desiredState: record.desiredState,
        container: info
          ? {
              id: info.Id,
              status: info.State.Status,
              running: info.State.Running,
              restartCount: info.RestartCount,
              configVersion: info.Config.Labels?.[ENGINE_LABELS.configVersion] ?? null,
            }
          : null,
        health: engine ? engine.health.status() : null,
        reportedVersion: reported,
        expectedVersion: rendered.version,
        restartPending: reported !== null && reported !== rendered.version,
        livePort: livePort ? Number(livePort) : null,
        restartStorm: {
          tripped: guard.isTripped(scope.stationId),
          restarts: guard.count(scope.stationId),
          windowSeconds: guard.windowSeconds,
        },
      };
    },

    /** Decrypted secrets, e.g. for the Icecast mount config (#32). */
    async secretsFor(scope: StationScope): Promise<EngineSecrets> {
      return (await load(scope)).secrets;
    },

    /** The events route's token check: the station's control token, if this api manages it. */
    tokenFor: (stationId: string): string | undefined => tokens.get(stationId),

    /**
     * Api boot: reconciles every station whose engine should run (creating or updating
     * containers as needed) and starts its `StationEngine`. One station failing doesn't stop
     * the others.
     */
    async boot(): Promise<{ stationId: string; result?: ReconcileResult; error?: unknown }[]> {
      const scopes = await listRunningStationScopes(db);
      return Promise.all(
        scopes.map(async (scope) => {
          try {
            const result = await serialized(scope.stationId, () => doReconcile(scope));
            logger.info({ stationId: scope.stationId, action: result.action }, 'Engine ready');
            return { stationId: scope.stationId, result };
          } catch (error) {
            logger.error({ stationId: scope.stationId, err: error }, 'Engine boot failed');
            return { stationId: scope.stationId, error };
          }
        }),
      );
    },

    /** Runs one supervisor pass now (tests). */
    supervise,

    startSupervisor() {
      if (supervising) return;
      supervising = true;
      supervisor = setTimeout(loop, superviseIntervalMs);
      supervisor.unref();
    },

    /** Stops supervising and monitoring. Containers keep running: they don't need the api. */
    async close() {
      supervising = false;
      clearTimeout(supervisor);
      await Promise.all([...locks.values()]);
      engines.stopAll();
    },
  };
}
