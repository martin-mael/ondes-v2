import { createHash } from 'node:crypto';
import { stableStringify } from '@ondes/shared';
import { engineEventsUrl } from '../adapter/route.ts';
import type { StationEngineSettingsInput } from '../config/settings.ts';
import type { ContainerCreateBody } from './docker.ts';
import type { PortRange } from './repo.ts';
import type { EngineSecrets } from './secrets.ts';

/**
 * Pure part of the lifecycle: from a station and the lifecycle config to the settings the
 * script is rendered from and the container that runs it. No I/O, unit tested.
 */

/** Ports inside the engine container. Fixed: only the host side of live varies. */
export const ENGINE_PORTS = { control: 7000, metrics: 9599, live: 8005 } as const;
/** Where the station's playout cache is mounted, read-only (ADR 0004). */
export const ENGINE_CACHE_MOUNT = '/cache';
/** Where the rendered script is copied into the container before it starts. */
export const ENGINE_SCRIPT_DIR = '/etc';
export const ENGINE_SCRIPT_PATH = '/etc/ondes/station.liq';

export const ENGINE_LABELS = {
  managed: 'ondes.engine',
  station: 'ondes.station',
  configVersion: 'ondes.config_version',
  spec: 'ondes.spec',
} as const;

export type EngineLimits = {
  /** CPU cores (fractional), cgroup `NanoCpus`. */
  cpus: number;
  memoryMb: number;
  pids: number;
};

export type EngineLifecycleConfig = {
  /** Liquidsoap image, pinned (ADR 0002). */
  image: string;
  /** Container name prefix: `<prefix>-<stationId>`. */
  containerPrefix: string;
  /** Docker network shared by the api, Icecast and the engines. */
  network: string;
  /** The api's base URL as the engines see it, for ENGINE_EVENTS_URL. */
  internalApiUrl: string;
  icecast: { host: string; port: number };
  /**
   * One Icecast source password for every station (Icecast's global `<source-password>`).
   * Unset: each station gets its own generated password, for per-mount passwords (#32).
   */
  sharedIcecastSourcePassword?: string;
  /** Host directory holding one playout cache directory per station (ADR 0004). */
  cacheRoot: string;
  /** Host port pool for harbor live inputs, and the address they are published on. */
  livePorts: PortRange;
  liveBindIp: string;
  limits: EngineLimits;
  /**
   * Dev and tests only: publish the control port on 127.0.0.1 (random host port) so a
   * process outside Docker can reach it. Production engines never publish it.
   */
  publishControlOnLoopback?: boolean;
  /** Extra `/etc/hosts` entries, e.g. `host.docker.internal:host-gateway` in tests. */
  extraHosts?: string[];
  /** Extra labels on every engine container (tests use them to clean up). */
  labels?: Record<string, string>;
};

export function containerName(
  config: Pick<EngineLifecycleConfig, 'containerPrefix'>,
  stationId: string,
): string {
  return `${config.containerPrefix}-${stationId}`;
}

export type StationForEngine = {
  stationId: string;
  slug: string;
  name: string;
  /** `station.engine_settings`: the user-editable part (outputs, blank, processing, …). */
  engineSettings: Record<string, unknown>;
};

/**
 * The settings the station's script is rendered from: the station's stored engine settings,
 * with what the lifecycle owns forced (identity, ports, paths, event and Icecast endpoints).
 * Outputs default to one 128 kbps MP3 mount named after the station until #32 sets them.
 */
export function engineSettingsFor(
  station: StationForEngine,
  config: Pick<EngineLifecycleConfig, 'internalApiUrl' | 'icecast'>,
): StationEngineSettingsInput {
  const stored = station.engineSettings as Partial<StationEngineSettingsInput>;
  const live = (stored.live ?? {}) as NonNullable<StationEngineSettingsInput['live']>;
  return {
    ...stored,
    stationId: station.stationId,
    name: stored.name ?? station.name,
    control: { port: ENGINE_PORTS.control },
    metrics: { port: ENGINE_PORTS.metrics },
    eventsUrl: engineEventsUrl(config.internalApiUrl, station.stationId),
    live: { ...live, port: ENGINE_PORTS.live },
    paths: {
      safetyDir: `${ENGINE_CACHE_MOUNT}/safety`,
      emergencyFile: `${ENGINE_CACHE_MOUNT}/emergency.flac`,
    },
    icecast: { host: config.icecast.host, port: config.icecast.port },
    outputs: stored.outputs?.length
      ? stored.outputs
      : [{ mount: `${station.slug}.mp3`, format: 'mp3', bitrate: 128 }],
  };
}

export type ContainerSpecInput = {
  station: { stationId: string };
  configVersion: string;
  secrets: EngineSecrets;
  /** Host port for the live input, or null when live is disabled. */
  livePort: number | null;
};

/** The `POST /containers/create` body for a station's engine, and a hash of it. */
export function engineContainerSpec(
  config: EngineLifecycleConfig,
  input: ContainerSpecInput,
): { body: ContainerCreateBody; specHash: string } {
  const { stationId } = input.station;
  const name = containerName(config, stationId);
  const control = `${ENGINE_PORTS.control}/tcp`;
  const live = `${ENGINE_PORTS.live}/tcp`;
  const portBindings: NonNullable<ContainerCreateBody['HostConfig']['PortBindings']> = {};
  if (input.livePort !== null)
    portBindings[live] = [{ HostIp: config.liveBindIp, HostPort: String(input.livePort) }];
  if (config.publishControlOnLoopback)
    portBindings[control] = [{ HostIp: '127.0.0.1', HostPort: '' }];

  const body: ContainerCreateBody = {
    Image: config.image,
    Cmd: [ENGINE_SCRIPT_PATH],
    Env: [
      `ENGINE_CONTROL_TOKEN=${input.secrets.controlToken}`,
      `ENGINE_LIVE_PASSWORD=${input.secrets.livePassword}`,
      `ICECAST_SOURCE_PASSWORD=${config.sharedIcecastSourcePassword ?? input.secrets.icecastSourcePassword}`,
    ],
    Labels: {
      ...config.labels,
      [ENGINE_LABELS.managed]: 'true',
      [ENGINE_LABELS.station]: stationId,
      [ENGINE_LABELS.configVersion]: input.configVersion,
    },
    ExposedPorts: Object.fromEntries(Object.keys(portBindings).map((p) => [p, {}])),
    HostConfig: {
      NetworkMode: config.network,
      PortBindings: portBindings,
      Mounts: [
        {
          Type: 'bind',
          Source: `${config.cacheRoot.replace(/\/+$/, '')}/${stationId}`,
          Target: ENGINE_CACHE_MOUNT,
          ReadOnly: true,
          BindOptions: { CreateMountpoint: true },
        },
      ],
      // Docker restarts a crashed engine a few times on its own; the lifecycle's storm guard
      // decides what happens after that.
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
      NanoCpus: Math.round(config.limits.cpus * 1e9),
      Memory: config.limits.memoryMb * 1024 * 1024,
      MemorySwap: config.limits.memoryMb * 1024 * 1024,
      PidsLimit: config.limits.pids,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ExtraHosts: config.extraHosts ?? [],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
    NetworkingConfig: { EndpointsConfig: { [config.network]: { Aliases: [name] } } },
  };
  // The hash covers everything but itself, so any change to the container (secrets, limits,
  // ports, image, script version) is detected; secrets only enter it hashed.
  const specHash = createHash('sha256').update(stableStringify(body)).digest('hex').slice(0, 16);
  body.Labels = { ...body.Labels, [ENGINE_LABELS.spec]: specHash };
  return { body, specHash };
}
