import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Db, type Executor, NotFoundError, type StationScope } from '@ondes/db';
import type { EngineRealtimeEvent } from '@ondes/shared';
import {
  createEngineAdapter,
  createStationEngine,
  type EngineAdapter,
  type EngineStatus,
  type StationEngineOptions,
  type StationEngines,
} from '../adapter/index.ts';
import { type Logger, silentLogger } from '../adapter/logger.ts';
import { loadStationTemplate, renderStationScript } from '../config/render.ts';
import { type ContainerInfo, type DockerClient, DockerError } from './docker.ts';
import { RestartGuard } from './guard.ts';
import {
  allocatePort,
  deleteStationEngine,
  listRunningStationScopes,
  loadControlToken,
  loadStationEngine,
  rotateSecrets,
  type StationEngineRecord,
  setApplied,
  setDesiredState,
  setStorm,
  stationsWithEngine,
  withStationLock,
} from './repo.ts';
import type { EngineSecretBox, EngineSecrets } from './secrets.ts';
import {
  containerName,
  ENGINE_LABELS,
  ENGINE_PORTS,
  ENGINE_RESTART_POLICY,
  type EngineLifecycleConfig,
  engineContainerSpec,
  engineSettingsFor,
  RECORDINGS_DIR,
} from './spec.ts';

/**
 * Station engine lifecycle (#35): creates, starts, stops and restarts each station's
 * Liquidsoap container through the Docker proxy guard, and keeps one `StationEngine`
 * (adapter + event ingest + health monitor, #28) per running station. See README.md.
 *
 * Every operation on a station runs under a Postgres advisory lock on it, so two api
 * replicas (or the old and new api during a rolling deploy) never act on one station at once.
 */

/** What `reconcile` did. */
export type ReconcileAction =
  /** No container: created and started. */
  | 'created'
  /** The script (`config_version`), the container spec or the secrets changed: replaced. */
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
  restartStorm: { tripped: boolean; since: string | null; restarts: number; windowSeconds: number };
};

/** The host port given to the station's live input is taken by something else. */
export class EnginePortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`host port ${port} (live input) is already in use on the Docker host`);
    this.name = 'EnginePortInUseError';
    this.port = port;
  }
}

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
  /**
   * Delay between supervisor passes. Default 5 s (#71: a crash restart is on the dashboard
   * within about 5 s; a pass is one Docker inspect per station and one container list).
   */
  superviseIntervalMs?: number;
  /** First retry delay for a station whose reconcile failed; doubles up to 5 min. Default 5 s. */
  retryBaseMs?: number;
  /** Stations reconciled at once at boot (each holds a database connection). Default 3. */
  bootConcurrency?: number;
  now?: () => number;
  logger?: Logger;
};

export type EngineLifecycle = ReturnType<typeof createEngineLifecycle>;

const MAX_RETRY_MS = 5 * 60_000;

export function createEngineLifecycle(options: EngineLifecycleOptions) {
  const { db, docker, config, secretBox, engines } = options;
  const logger = options.logger ?? silentLogger;
  const guard = options.guard ?? new RestartGuard();
  const template = options.template ?? loadStationTemplate();
  const superviseIntervalMs = options.superviseIntervalMs ?? 5_000;
  const retryBaseMs = options.retryBaseMs ?? 5_000;
  const now = options.now ?? Date.now;

  /** Control tokens seen, for the events route (cache; the database is the truth). */
  const tokens = new Map<string, string>();
  /** Stations kept running by this api, with the last restart count seen. */
  const managed = new Map<string, { scope: StationScope; restartCount: number }>();
  /** Stations whose last reconcile failed (boot, supervisor), retried with backoff. */
  const retries = new Map<string, { scope: StationScope; attempts: number; nextAt: number }>();
  /** Control URL and token each attached `StationEngine` was built with. */
  const attached = new Map<string, { baseUrl: string; token: string }>();
  const locks = new Map<string, Promise<unknown>>();
  /** Run before each container create (e.g. Icecast mount passwords, #32). */
  const beforeCreate: ((scope: StationScope, secrets: EngineSecrets) => Promise<void>)[] = [];
  let supervisor: NodeJS.Timeout | undefined;
  let supervising = false;

  /**
   * Runs `fn` after any other lifecycle operation on the same station in this process, then
   * under the station's advisory lock against other replicas. `fn` gets the locked
   * transaction as its database handle.
   */
  function exclusive<T>(stationId: string, fn: (tx: Executor) => Promise<T>): Promise<T> {
    const run = () => withStationLock(db, stationId, fn);
    const previous = locks.get(stationId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => {});
    locks.set(stationId, settled);
    void settled.then(() => {
      if (locks.get(stationId) === settled) locks.delete(stationId);
    });
    return next;
  }

  async function load(ex: Executor, scope: StationScope): Promise<StationEngineRecord> {
    const record = await loadStationEngine(ex, secretBox, scope);
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

  /**
   * The station's live recordings directory (#67, ADR 0039), made before the container so
   * Docker never creates it (as root: then neither the engine, uid 100, could write to it nor
   * the worker delete from it). Mode 0777 without the sticky bit: the engine writes, the
   * worker deletes. Best effort: an api that doesn't see the host's cache root leaves it to
   * the worker's sweep, which makes it too.
   */
  async function prepareRecordingsDir(stationId: string) {
    const dir = join(config.cacheRoot, stationId, RECORDINGS_DIR);
    try {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o777);
    } catch (err) {
      logger.warn({ stationId, dir, err }, 'Could not prepare the live recordings directory');
    }
  }

  /**
   * Creates and starts the container. Any failure after `create` removes it again, so an
   * interrupted create never leaves a dead container behind.
   */
  async function createAndStart(
    scope: StationScope,
    secrets: EngineSecrets,
    body: ReturnType<typeof engineContainerSpec>['body'],
    livePort: number | null,
  ): Promise<ContainerInfo> {
    const name = containerName(config, scope.stationId);
    for (const hook of beforeCreate) await hook(scope, secrets);
    await prepareRecordingsDir(scope.stationId);
    await docker.ensureImage(config.image);
    const id = await docker.create(name, body);
    try {
      try {
        await docker.start(id);
      } catch (error) {
        if (
          livePort !== null &&
          error instanceof DockerError &&
          /port is already allocated|address already in use/i.test(error.message)
        )
          throw new EnginePortInUseError(livePort);
        throw error;
      }
      const info = await docker.inspect(id);
      if (!info) throw new Error(`engine container ${name} vanished after start`);
      return info;
    } catch (error) {
      await docker.remove(id).catch((err) => {
        logger.error(
          { stationId: scope.stationId, err },
          'Removing a failed engine container failed',
        );
      });
      throw error;
    }
  }

  async function removeContainer(info: ContainerInfo) {
    await docker.stop(info.Id);
    await docker.remove(info.Id);
  }

  async function tripStorm(
    ex: Executor,
    scope: StationScope,
    restarts: number,
    info: ContainerInfo | null,
  ) {
    logger.error({ stationId: scope.stationId, restarts }, 'Engine restart storm: stopping it');
    await setStorm(ex, scope, new Date(now()));
    if (info) {
      await docker.setRestartPolicy(info.Id, { Name: 'no' }).catch(() => {});
      await docker.stop(info.Id).catch(() => {});
    }
    retries.delete(scope.stationId);
    try {
      await options.publish({
        id: randomUUID(),
        type: 'engine.restart_storm',
        stationId: scope.stationId,
        at: new Date(now()).toISOString(),
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

  async function doReconcile(ex: Executor, scope: StationScope): Promise<ReconcileResult> {
    const record = await load(ex, scope);
    const name = containerName(config, scope.stationId);
    let info = await docker.inspect(name);

    if (record.desiredState === 'stopped') {
      detach(scope.stationId);
      retries.delete(scope.stationId);
      if (info?.State.Running) await docker.stop(info.Id);
      return { action: 'stopped', configVersion: null, reportedVersion: null };
    }

    const rendered = render(record);
    if (record.stormAt || guard.isTripped(scope.stationId)) {
      return { action: 'storm', configVersion: rendered.version, reportedVersion: null };
    }

    const livePort = rendered.settings.live.enabled
      ? await allocatePort(ex, scope, 'live', config.livePorts)
      : null;
    const liveIcyPort =
      rendered.settings.live.enabled && rendered.settings.live.icy
        ? await allocatePort(ex, scope, 'live_icy', config.livePorts)
        : null;
    const { body, specHash } = engineContainerSpec(config, {
      station: { stationId: scope.stationId },
      configVersion: rendered.version,
      script: rendered.script,
      secrets: record.secrets,
      livePort,
      liveIcyPort,
    });

    // The engine says which script it runs: if it answers with another version than the
    // rendered one, the script is stale whatever the labels say.
    if (info?.State.Running) attach(scope, record.secrets, info);
    const reported = info?.State.Running ? await reportedVersion(scope.stationId) : null;

    let action: ReconcileAction;
    if (!info) {
      info = await createAndStart(scope, record.secrets, body, livePort);
      action = 'created';
    } else if (
      info.State.Status === 'created' ||
      info.Config.Labels?.[ENGINE_LABELS.spec] !== specHash ||
      (reported !== null && reported !== rendered.version)
    ) {
      // `created` = a create interrupted before its start: stale, replace it.
      logger.info(
        {
          stationId: scope.stationId,
          state: info.State.Status,
          from: reported ?? info.Config.Labels?.[ENGINE_LABELS.configVersion],
          to: rendered.version,
        },
        'Engine container out of date: recreating it',
      );
      await removeContainer(info);
      info = await createAndStart(scope, record.secrets, body, livePort);
      action = 'recreated';
    } else if (!info.State.Running && !info.State.Restarting) {
      await docker.start(info.Id);
      info = (await docker.inspect(info.Id)) ?? info;
      action = 'started';
    } else {
      action = 'unchanged';
      // The spec label can't see a restart policy changed after create (a storm, by hand).
      const policy = info.HostConfig.RestartPolicy;
      if (
        policy?.Name !== ENGINE_RESTART_POLICY.Name ||
        policy.MaximumRetryCount !== ENGINE_RESTART_POLICY.MaximumRetryCount
      ) {
        logger.warn(
          { stationId: scope.stationId, policy },
          'Engine restart policy drifted: resetting',
        );
        await docker.setRestartPolicy(info.Id, { ...ENGINE_RESTART_POLICY });
      }
    }

    managed.set(scope.stationId, { scope, restartCount: info.RestartCount });
    retries.delete(scope.stationId);
    attach(scope, record.secrets, info);
    if (action !== 'unchanged' || record.containerId !== info.Id) {
      await setApplied(ex, scope, { configVersion: rendered.version, containerId: info.Id });
    }
    return { action, configVersion: rendered.version, reportedVersion: reported };
  }

  function scheduleRetry(scope: StationScope, error: unknown) {
    const previous = retries.get(scope.stationId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(MAX_RETRY_MS, retryBaseMs * 2 ** (attempts - 1));
    retries.set(scope.stationId, { scope, attempts, nextAt: now() + delay });
    logger.error(
      { stationId: scope.stationId, attempts, retryInMs: delay, err: error },
      'Engine reconcile failed',
    );
  }

  /** One supervisor check of a managed station: Docker restarts, dead containers, storms. */
  async function superviseOne(ex: Executor, stationId: string): Promise<void> {
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
      await tripStorm(ex, scope, verdict.restarts, info);
      return;
    }
    await publishRestarted(scope, restarts, verdict.restarts, dead);
    if (dead) await doReconcile(ex, scope);
  }

  /** An unasked-for restart, for the `engine.restarted` alert (#71). Best effort. */
  async function publishRestarted(
    scope: StationScope,
    restarts: number,
    inWindow: number,
    crashed: boolean,
  ) {
    try {
      await options.publish({
        id: randomUUID(),
        type: 'engine.restarted',
        stationId: scope.stationId,
        at: new Date(now()).toISOString(),
        data: {
          bootId: engines.get(scope.stationId)?.health.last()?.boot_id ?? null,
          restarts,
          inWindow: Math.max(inWindow, restarts),
          windowSeconds: guard.windowSeconds,
          crashed,
        },
      });
    } catch (error) {
      logger.error({ stationId: scope.stationId, err: error }, 'Publishing engine restart failed');
    }
  }

  /**
   * Removes engine containers of this deployment (name prefix) whose station has no engine
   * row any more: a station deleted behind the lifecycle's back, or a crash mid-`remove`.
   */
  async function sweepOrphans(): Promise<string[]> {
    const containers = await docker.list([`${ENGINE_LABELS.managed}=true`]);
    const ours = containers.filter((c) =>
      c.Names.some((n) => n.replace(/^\//, '').startsWith(`${config.containerPrefix}-`)),
    );
    const known = await stationsWithEngine(
      db,
      ours.map((c) => c.Labels?.[ENGINE_LABELS.station] ?? ''),
    );
    const removed: string[] = [];
    for (const c of ours) {
      const stationId = c.Labels?.[ENGINE_LABELS.station] ?? '';
      if (known.has(stationId)) continue;
      logger.warn({ stationId, container: c.Names[0] }, 'Removing an orphaned engine container');
      detach(stationId);
      await docker.stop(c.Id).catch(() => {});
      await docker.remove(c.Id);
      removed.push(stationId);
    }
    return removed;
  }

  async function supervise(): Promise<void> {
    // One station at a time: each holds a database connection while it acts.
    for (const stationId of [...managed.keys()]) {
      if (retries.has(stationId)) continue;
      await exclusive(stationId, (ex) => superviseOne(ex, stationId)).catch((error) => {
        const scope = managed.get(stationId)?.scope;
        if (error instanceof NotFoundError) return detach(stationId);
        if (scope) scheduleRetry(scope, error);
      });
    }
    for (const [stationId, entry] of [...retries]) {
      if (entry.nextAt > now()) continue;
      await exclusive(stationId, (ex) => doReconcile(ex, entry.scope)).catch((error) => {
        if (error instanceof NotFoundError) return retries.delete(stationId);
        scheduleRetry(entry.scope, error);
      });
    }
    await sweepOrphans().catch((error) => {
      logger.error({ err: error }, 'Engine orphan sweep failed');
    });
  }

  function loop() {
    if (!supervising) return;
    void supervise().finally(() => {
      if (!supervising) return;
      supervisor = setTimeout(loop, superviseIntervalMs);
      supervisor.unref();
    });
  }

  /**
   * Commits what the caller wants (desired state, storm reset, new secrets) on its own, so a
   * failing reconcile afterwards doesn't roll the intent back with it.
   */
  function setIntent(scope: StationScope, fn: (ex: Executor) => Promise<void>): Promise<void> {
    return exclusive(scope.stationId, async (ex) => {
      await load(ex, scope);
      await fn(ex);
    });
  }

  /** Runs a reconcile; on failure the station joins the retry set, and the error is rethrown. */
  async function reconcileOrRetry(
    scope: StationScope,
    fn: (ex: Executor) => Promise<ReconcileResult>,
  ): Promise<ReconcileResult> {
    try {
      return await exclusive(scope.stationId, fn);
    } catch (error) {
      if (!(error instanceof NotFoundError)) scheduleRetry(scope, error);
      throw error;
    }
  }

  return {
    guard,

    /**
     * Makes the station's container match its settings and desired state. Restarts the
     * engine only when needed: a new `config_version` (settings or template changed) or a
     * changed container spec. Call it after changing `station.engine_settings`.
     */
    reconcile(scope: StationScope): Promise<ReconcileResult> {
      return reconcileOrRetry(scope, (ex) => doReconcile(ex, scope));
    },

    /** Marks the engine as wanted (committed even if the start fails) and brings it up. */
    async start(scope: StationScope): Promise<ReconcileResult> {
      await setIntent(scope, async (ex) => setDesiredState(ex, scope, 'running'));
      return reconcileOrRetry(scope, (ex) => doReconcile(ex, scope));
    },

    /** Marks the engine as not wanted and stops its container (kept, for its logs). */
    async stop(scope: StationScope): Promise<ReconcileResult> {
      await setIntent(scope, async (ex) => setDesiredState(ex, scope, 'stopped'));
      return exclusive(scope.stationId, (ex) => doReconcile(ex, scope));
    },

    /**
     * A person's restart: clears the storm guard and replaces the container even if nothing
     * changed (a fresh boot, an empty queue: the feeder re-pushes on `boot`).
     * `rotateSecrets` also generates new secrets for the station first.
     */
    async restart(
      scope: StationScope,
      opts: { rotateSecrets?: boolean } = {},
    ): Promise<ReconcileResult> {
      await setIntent(scope, async (ex) => {
        guard.reset(scope.stationId);
        await setStorm(ex, scope, null);
        await setDesiredState(ex, scope, 'running');
        if (opts.rotateSecrets) await rotateSecrets(ex, secretBox, scope);
      });
      return reconcileOrRetry(scope, async (ex) => {
        const info = await docker.inspect(containerName(config, scope.stationId));
        if (info) {
          await removeContainer(info);
          await setApplied(ex, scope, { configVersion: null, containerId: null });
        }
        const result = await doReconcile(ex, scope);
        return { ...result, action: info ? 'recreated' : result.action };
      });
    },

    /**
     * Removes the container, then forgets the station's engine (row, secrets, ports). Call it
     * before deleting a station: the foreign keys refuse the deletion until then.
     */
    remove(scope: StationScope): Promise<void> {
      return exclusive(scope.stationId, async (ex) => {
        detach(scope.stationId);
        retries.delete(scope.stationId);
        tokens.delete(scope.stationId);
        const info = await docker.inspect(containerName(config, scope.stationId));
        if (info) await removeContainer(info);
        await deleteStationEngine(ex, scope);
      });
    },

    async status(scope: StationScope): Promise<EngineStatusView> {
      const record = await load(db, scope);
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
          tripped: record.stormAt !== null || guard.isTripped(scope.stationId),
          since: record.stormAt?.toISOString() ?? null,
          restarts: guard.count(scope.stationId),
          windowSeconds: guard.windowSeconds,
        },
      };
    },

    /**
     * Registers a step that runs before every engine container is created (first start, a
     * config change, a secrets rotation), with the secrets the container will get. A failure
     * aborts the create. #32 uses it to put the station's Icecast mount passwords in place
     * before its engine connects.
     */
    onBeforeCreate(hook: (scope: StationScope, secrets: EngineSecrets) => Promise<void>): void {
      beforeCreate.push(hook);
    },

    /** Decrypted secrets, e.g. for the station's Icecast mount passwords (#32). */
    async secretsFor(scope: StationScope): Promise<EngineSecrets> {
      return (await load(db, scope)).secrets;
    },

    /**
     * The events route's token check: the station's control token. From the cache, else
     * from the database (an engine can post before this api reconciled it, e.g. at boot).
     */
    async tokenFor(stationId: string): Promise<string | undefined> {
      const cached = tokens.get(stationId);
      if (cached) return cached;
      const token = await loadControlToken(db, secretBox, stationId);
      if (token) tokens.set(stationId, token);
      return token ?? undefined;
    },

    /**
     * A command adapter for the station's engine, on any api replica: the attached one, or
     * a transient one built from the station's token (e.g. for a queue consumer running on
     * another replica, #33). Undefined when the station has no engine.
     */
    async adapterFor(stationId: string): Promise<EngineAdapter | undefined> {
      const engine = engines.get(stationId);
      if (engine) return engine.adapter;
      const token = await loadControlToken(db, secretBox, stationId);
      if (!token) return undefined;
      const info = config.publishControlOnLoopback
        ? await docker.inspect(containerName(config, stationId))
        : null;
      const baseUrl = controlUrl(stationId, info);
      return baseUrl ? createEngineAdapter({ stationId, baseUrl, token }) : undefined;
    },

    /**
     * Api boot: removes orphaned containers, then reconciles every station whose engine
     * should run (a few at a time) and starts its `StationEngine`. A station that fails is
     * retried by the supervisor with backoff; one failing doesn't stop the others.
     */
    async boot(): Promise<{ stationId: string; result?: ReconcileResult; error?: unknown }[]> {
      await sweepOrphans().catch((error) => {
        logger.error({ err: error }, 'Engine orphan sweep failed');
      });
      const scopes = await listRunningStationScopes(db);
      const results: { stationId: string; result?: ReconcileResult; error?: unknown }[] = [];
      const queue = [...scopes];
      const worker = async () => {
        for (let scope = queue.shift(); scope; scope = queue.shift()) {
          const current = scope;
          try {
            const result = await exclusive(current.stationId, (ex) => doReconcile(ex, current));
            logger.info({ stationId: current.stationId, action: result.action }, 'Engine ready');
            results.push({ stationId: current.stationId, result });
          } catch (error) {
            scheduleRetry(current, error);
            results.push({ stationId: current.stationId, error });
          }
        }
      };
      await Promise.all(Array.from({ length: options.bootConcurrency ?? 3 }, worker));
      return results;
    },

    /** Stations waiting for a retry, with their attempt count (tests, status pages). */
    pendingRetries: () =>
      new Map([...retries].map(([id, r]) => [id, { attempts: r.attempts, nextAt: r.nextAt }])),

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
