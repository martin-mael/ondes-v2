import { writeAudit } from '@ondes/db';
import { engineRealtimeEventSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { actorOf, stationScopeOf } from '../../../plugins/auth.ts';
import { HttpError } from '../../../plugins/errors.ts';
import { registerEngineEventRoutes, StationEngines } from '../adapter/index.ts';
import { createDockerClient, type DockerClient, DockerError } from './docker.ts';
import { RestartGuard, type RestartGuardOptions } from './guard.ts';
import { PortPoolExhaustedError } from './repo.ts';
import { createEngineSecretBox } from './secrets.ts';
import {
  createEngineLifecycle,
  type EngineLifecycle,
  type EngineLifecycleOptions,
} from './service.ts';
import type { EngineLifecycleConfig } from './spec.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Station engine lifecycle (#35): reconcile after changing a station's engine settings. */
    engineLifecycle: EngineLifecycle;
    /** One `StationEngine` (adapter, ingest, health) per running station (#28). */
    stationEngines: StationEngines;
  }
}

export type EngineLifecyclePluginOptions = {
  config: EngineLifecycleConfig;
  /** The Docker socket proxy, e.g. `http://docker-socket-proxy:2375`. */
  dockerUrl: string;
  /** Key the engine secrets are encrypted with (the api's AUTH_SECRET). */
  secret: string;
  guard?: RestartGuardOptions;
  health?: EngineLifecycleOptions['health'];
  superviseIntervalMs?: number;
  /**
   * Reconcile every running station's engine once the api is ready, then supervise them.
   * Default true. Tests turn it off and call `app.engineLifecycle.boot()` themselves.
   */
  boot?: boolean;
  /** Tests: a Docker client double. */
  docker?: DockerClient;
  template?: string;
};

/**
 * Wires the lifecycle into the api: the engines registry, the internal events route (each
 * station's own token), the engine control routes under `/api/v1/stations/:stationId/engine`,
 * and, at boot, one engine per running station. Needs the db, rabbit and auth plugins.
 */
export const engineLifecyclePlugin = fp(
  async (app: FastifyInstance, options: EngineLifecyclePluginOptions) => {
    const engines = new StationEngines();
    const lifecycle = createEngineLifecycle({
      db: app.db,
      docker: options.docker ?? createDockerClient({ url: options.dockerUrl }),
      config: options.config,
      secretBox: createEngineSecretBox(options.secret),
      engines,
      publish: (event) => app.rabbit.events.publish(engineRealtimeEventSchema.parse(event)),
      guard: new RestartGuard(options.guard),
      health: options.health,
      superviseIntervalMs: options.superviseIntervalMs,
      template: options.template,
      logger: app.log,
    });
    app.decorate('engineLifecycle', lifecycle);
    if (!options.config.sharedIcecastSourcePassword) {
      // Icecast has one global source password (deploy/icecast): per-station generated ones
      // are only accepted with per-mount passwords, which the deploy doesn't configure.
      app.log.warn(
        'ICECAST_SOURCE_PASSWORD is not set: engines get per-station source passwords, which Icecast refuses unless mounts have their own passwords',
      );
    }
    app.decorate('stationEngines', engines);

    // Internal only (the engines' ENGINE_EVENTS_URL): never route /internal through Caddy.
    registerEngineEventRoutes(app, {
      ingestFor: engines.ingestFor,
      token: lifecycle.tokenFor,
      logger: app.log,
    });

    const STATION = '/api/v1/stations/:stationId/engine';
    app.get(STATION, { preHandler: app.requirePermission('engine', 'read') }, (request) =>
      lifecycle.status(stationScopeOf(request)),
    );
    for (const verb of ['start', 'stop', 'restart'] as const) {
      app.post(
        `${STATION}/${verb}`,
        { preHandler: app.requirePermission('engine', 'control') },
        async (request) => {
          const scope = stationScopeOf(request);
          const result = await lifecycle[verb](scope).catch(toHttpError);
          await writeAudit(
            app.db,
            { actor: actorOf(request), scope },
            {
              action: `engine.${verb}`,
              entity: { type: 'station_engine', id: scope.stationId },
              diff: { result: { from: null, to: result.action } },
            },
          );
          return result;
        },
      );
    }

    if (options.boot ?? true) {
      app.addHook('onReady', () => {
        // In the background: the api serves while engines come up (an image pull can take
        // minutes on a fresh host).
        void lifecycle.boot().finally(() => lifecycle.startSupervisor());
      });
    }
    app.addHook('onClose', () => lifecycle.close());
  },
  { name: 'engine-lifecycle', dependencies: ['db', 'rabbit'] },
);

/** Lifecycle failures the caller can't fix but should see as such, not as a bare 500. */
function toHttpError(error: unknown): never {
  if (error instanceof PortPoolExhaustedError)
    throw new HttpError(503, 'engine_port_pool_exhausted', error.message);
  if (error instanceof DockerError)
    throw new HttpError(502, 'engine_docker_error', 'the container runtime refused the request');
  throw error;
}

/**
 * Reads the lifecycle settings from the environment. Returns null when `ENGINE_DOCKER_URL`
 * is unset: the api then runs without managing engines (tests, a dev api without Docker).
 */
export function engineLifecycleConfigFromEnv(
  env: NodeJS.ProcessEnv,
  secret: string,
): EngineLifecyclePluginOptions | null {
  const dockerUrl = env.ENGINE_DOCKER_URL;
  if (!dockerUrl) return null;
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is not set (needed with ENGINE_DOCKER_URL)`);
    return value;
  };
  const num = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
    return value;
  };
  return {
    dockerUrl,
    secret,
    config: {
      image: env.ENGINE_IMAGE ?? 'savonet/liquidsoap:v2.4.6',
      containerPrefix: env.ENGINE_CONTAINER_PREFIX ?? 'ondes-engine',
      network: required('ENGINE_NETWORK'),
      internalApiUrl: required('ENGINE_API_URL'),
      icecast: {
        host: env.ENGINE_ICECAST_HOST ?? 'icecast',
        port: num('ENGINE_ICECAST_PORT', 8000),
      },
      sharedIcecastSourcePassword: env.ICECAST_SOURCE_PASSWORD || undefined,
      cacheRoot: required('ENGINE_CACHE_ROOT'),
      livePorts: { min: num('ENGINE_LIVE_PORT_MIN', 8100), max: num('ENGINE_LIVE_PORT_MAX', 8199) },
      liveBindIp: env.ENGINE_LIVE_BIND_IP ?? '0.0.0.0',
      limits: {
        cpus: num('ENGINE_CPUS', 1),
        memoryMb: num('ENGINE_MEMORY_MB', 512),
        pids: num('ENGINE_PIDS', 256),
      },
    },
    guard: {
      maxRestarts: num('ENGINE_RESTART_MAX', 5),
      windowSeconds: num('ENGINE_RESTART_WINDOW_SECONDS', 600),
    },
  };
}
