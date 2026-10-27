/**
 * What a station engine container may look like, shared by the lifecycle (which builds the
 * create request, spec.ts) and the Docker proxy guard (which refuses anything else,
 * proxy-guard.ts). Dependency-free on purpose: the guard runs from these sources in a plain
 * Node image, with no node_modules.
 */

/** Ports inside the engine container. Fixed: only the host side of live varies. */
export const ENGINE_PORTS = { control: 7000, metrics: 9599, live: 8005, liveIcy: 8006 } as const;
/** Where the station's playout cache is mounted, read-only (ADR 0004). */
export const ENGINE_CACHE_MOUNT = '/cache';
/**
 * Live recordings (#67, ADR 0039): the station's `<cache>/recordings`, the one directory the
 * engine may write to. The worker joins and uploads the files, then deletes them.
 */
export const ENGINE_RECORDINGS_MOUNT = '/recordings';
/** The recordings directory inside a station's cache directory, on the host. */
export const RECORDINGS_DIR = 'recordings';
/**
 * The engine's root filesystem is read-only; the script copy goes to this tmpfs. Liquidsoap's
 * prebuilt standard-library cache stays readable in the image (it logs once that it can't
 * write a cache for the station script, which is harmless).
 */
export const ENGINE_TMPFS = ['/tmp'] as const;
/** Environment variable carrying the rendered script into the container. */
export const ENGINE_SCRIPT_ENV = 'ENGINE_SCRIPT';
/**
 * The script travels in the environment (no archive upload, which the guard refuses) and is
 * written to the tmpfs before Liquidsoap starts.
 */
export const ENGINE_ENTRYPOINT = [
  '/bin/sh',
  '-c',
  `umask 077 && printf '%s' "$${ENGINE_SCRIPT_ENV}" > /tmp/station.liq && unset ${ENGINE_SCRIPT_ENV} && exec /usr/bin/liquidsoap /tmp/station.liq`,
] as const;

export const ENGINE_LABELS = {
  managed: 'ondes.engine',
  station: 'ondes.station',
  configVersion: 'ondes.config_version',
  spec: 'ondes.spec',
} as const;

/** What the guard allows; built from its environment. */
export type ContainerPolicy = {
  /** The one image engines may run (pinned). */
  image: string;
  /** Container names must be `<prefix>-<id>`. */
  namePrefix: string;
  /** The engine network: the only network an engine may join. */
  network: string;
  /** Host directory under which the playout cache bind mounts must be. */
  cacheRoot: string;
  /** Dev and tests: the control port may be published on 127.0.0.1. */
  allowLoopbackControl?: boolean;
  /** Allowed `ExtraHosts` entries (tests: `host.docker.internal:host-gateway`). */
  extraHosts?: string[];
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(where: string, value: Json, allowed: readonly string[]): string | null {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  return extra.length ? `${where}: ${extra.join(', ')} not allowed` : null;
}

export function isEngineName(policy: ContainerPolicy, name: string): boolean {
  return (
    name.startsWith(`${policy.namePrefix}-`) &&
    /^[A-Za-z0-9-]+$/.test(name.slice(policy.namePrefix.length + 1))
  );
}

/**
 * Checks a `POST /containers/create` request. Returns null when it describes an engine
 * container, else why not. Anything not listed is refused: privileged mode, binds, devices,
 * capabilities, host namespaces, other images, other networks, mounts outside the cache.
 */
export function checkEngineCreate(
  policy: ContainerPolicy,
  name: string,
  body: unknown,
): string | null {
  if (!isEngineName(policy, name)) return `name must be ${policy.namePrefix}-<id>`;
  if (!isObject(body)) return 'body must be an object';
  const top = onlyKeys('body', body, [
    'Image',
    'Entrypoint',
    'Cmd',
    'Env',
    'Labels',
    'ExposedPorts',
    'HostConfig',
    'NetworkingConfig',
  ]);
  if (top) return top;
  if (body.Image !== policy.image) return `image must be ${policy.image}`;
  if (JSON.stringify(body.Entrypoint) !== JSON.stringify(ENGINE_ENTRYPOINT))
    return 'entrypoint must be the engine entrypoint';
  if (body.Cmd !== undefined && !(Array.isArray(body.Cmd) && body.Cmd.length === 0))
    return 'cmd not allowed';
  if (
    body.Env !== undefined &&
    !(Array.isArray(body.Env) && body.Env.every((e) => typeof e === 'string'))
  )
    return 'env must be a list of strings';

  const labels = body.Labels;
  if (!isObject(labels) || labels[ENGINE_LABELS.managed] !== 'true')
    return `labels must include ${ENGINE_LABELS.managed}=true`;
  const foreign = Object.keys(labels).filter((k) => !k.startsWith('ondes.'));
  if (foreign.length) return `labels: ${foreign.join(', ')} not allowed (ondes.* only)`;

  const allowedPorts = [
    `${ENGINE_PORTS.live}/tcp`,
    // Harbor's Shoutcast (ICY) port, `live + 1`, when the station opens it (#64).
    `${ENGINE_PORTS.liveIcy}/tcp`,
    ...(policy.allowLoopbackControl ? [`${ENGINE_PORTS.control}/tcp`] : []),
  ];
  if (body.ExposedPorts !== undefined) {
    if (!isObject(body.ExposedPorts)) return 'exposed ports must be an object';
    const bad = onlyKeys('exposed ports', body.ExposedPorts, allowedPorts);
    if (bad) return bad;
  }

  const host = body.HostConfig;
  if (!isObject(host)) return 'host config required';
  const hostKeys = onlyKeys('host config', host, [
    'NetworkMode',
    'PortBindings',
    'Mounts',
    'RestartPolicy',
    'NanoCpus',
    'Memory',
    'MemorySwap',
    'PidsLimit',
    'ReadonlyRootfs',
    'CapDrop',
    'SecurityOpt',
    'ExtraHosts',
    'LogConfig',
  ]);
  if (hostKeys) return hostKeys;
  if (host.NetworkMode !== policy.network) return `network must be ${policy.network}`;
  if (host.ReadonlyRootfs !== true) return 'root filesystem must be read-only';
  if (JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL'])) return 'must drop all capabilities';
  if (JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges:true']))
    return 'security options must be no-new-privileges only';
  for (const key of ['NanoCpus', 'Memory', 'PidsLimit'] as const) {
    if (typeof host[key] !== 'number' || (host[key] as number) <= 0) return `${key} limit required`;
  }
  if (host.MemorySwap !== host.Memory) return 'swap not allowed';
  if (
    host.LogConfig !== undefined &&
    (!isObject(host.LogConfig) || host.LogConfig.Type !== 'json-file')
  )
    return 'log driver must be json-file';
  if (host.ExtraHosts !== undefined) {
    const allowed = policy.extraHosts ?? [];
    if (!Array.isArray(host.ExtraHosts) || host.ExtraHosts.some((h) => !allowed.includes(h)))
      return 'extra hosts not allowed';
  }
  if (host.RestartPolicy !== undefined) {
    const bad = checkRestartPolicy(host.RestartPolicy);
    if (bad) return bad;
  }

  const bindings = host.PortBindings ?? {};
  if (!isObject(bindings)) return 'port bindings must be an object';
  for (const [port, list] of Object.entries(bindings)) {
    if (!allowedPorts.includes(port)) return `port ${port} may not be published`;
    if (!Array.isArray(list) || list.length !== 1 || !isObject(list[0]))
      return `port ${port}: one binding`;
    if (port === `${ENGINE_PORTS.control}/tcp` && list[0].HostIp !== '127.0.0.1')
      return 'control port only on 127.0.0.1';
  }

  const mounts = host.Mounts ?? [];
  if (!Array.isArray(mounts)) return 'mounts must be a list';
  const root = policy.cacheRoot.replace(/\/+$/, '');
  for (const m of mounts) {
    if (!isObject(m)) return 'mount must be an object';
    if (m.Type === 'bind') {
      const bad = onlyKeys('bind mount', m, [
        'Type',
        'Source',
        'Target',
        'ReadOnly',
        'BindOptions',
      ]);
      if (bad) return bad;
      const source = String(m.Source ?? '');
      const rest = source.startsWith(`${root}/`) ? source.slice(root.length + 1) : '';
      if (m.Target === ENGINE_RECORDINGS_MOUNT) {
        // The only writable bind: the station's recordings directory (#67).
        const station = rest.endsWith(`/${RECORDINGS_DIR}`)
          ? rest.slice(0, -RECORDINGS_DIR.length - 1)
          : '';
        if (!/^[A-Za-z0-9-]+$/.test(station))
          return `bind source must be ${root}/<station>/${RECORDINGS_DIR}`;
        if (m.ReadOnly !== false) return `bind at ${ENGINE_RECORDINGS_MOUNT} must be read-write`;
        continue;
      }
      if (!/^[A-Za-z0-9-]+$/.test(rest)) return `bind source must be ${root}/<station>`;
      if (m.Target !== ENGINE_CACHE_MOUNT || m.ReadOnly !== true)
        return `bind must be read-only at ${ENGINE_CACHE_MOUNT}`;
    } else if (m.Type === 'tmpfs') {
      const bad = onlyKeys('tmpfs mount', m, ['Type', 'Target', 'TmpfsOptions']);
      if (bad) return bad;
      if (!(ENGINE_TMPFS as readonly unknown[]).includes(m.Target))
        return `tmpfs at ${String(m.Target)} not allowed`;
    } else {
      return `mount type ${String(m.Type)} not allowed`;
    }
  }

  const networking = body.NetworkingConfig;
  if (networking !== undefined) {
    if (!isObject(networking) || !isObject(networking.EndpointsConfig))
      return 'networking config invalid';
    const bad = onlyKeys('endpoints', networking.EndpointsConfig, [policy.network]);
    if (bad) return bad;
    const endpoint = networking.EndpointsConfig[policy.network];
    if (endpoint !== undefined) {
      if (!isObject(endpoint)) return 'endpoint invalid';
      const extra = onlyKeys('endpoint', endpoint, ['Aliases']);
      if (extra) return extra;
    }
  }
  return null;
}

/** `POST /containers/{id}/update`: the restart policy only. */
export function checkEngineUpdate(body: unknown): string | null {
  if (!isObject(body)) return 'body must be an object';
  const bad = onlyKeys('update', body, ['RestartPolicy']);
  if (bad) return bad;
  return checkRestartPolicy(body.RestartPolicy);
}

function checkRestartPolicy(policy: unknown): string | null {
  if (!isObject(policy)) return 'restart policy must be an object';
  const bad = onlyKeys('restart policy', policy, ['Name', 'MaximumRetryCount']);
  if (bad) return bad;
  if (!['no', 'on-failure'].includes(String(policy.Name)))
    return 'restart policy must be no or on-failure';
  return null;
}
