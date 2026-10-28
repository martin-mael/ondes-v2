import { z } from 'zod';

/**
 * The few Docker Engine API calls the lifecycle needs, over plain `fetch`. The api never
 * gets the Docker socket: it talks to the Docker proxy guard (`deploy/engine/
 * docker-socket-proxy.compose.yml`, proxy-guard.ts), which only lets station engine
 * containers be created and managed, in front of the socket proxy. See README.md.
 */

/** Engine API version the requests are written against (Docker 25+). */
export const DOCKER_API_VERSION = 'v1.44';

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`docker: ${message} (HTTP ${status})`);
    this.name = 'DockerError';
    this.status = status;
  }
}

const containerInspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  RestartCount: z.int().default(0),
  State: z.object({
    Status: z.string(),
    Running: z.boolean(),
    Restarting: z.boolean().default(false),
    ExitCode: z.int().default(0),
    StartedAt: z.string().optional(),
  }),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable().default({}) }),
  HostConfig: z
    .object({
      RestartPolicy: z
        .object({ Name: z.string(), MaximumRetryCount: z.int().optional() })
        .nullable()
        .optional(),
    })
    .default({}),
  NetworkSettings: z
    .object({
      Ports: z
        .record(
          z.string(),
          z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
        )
        .nullable()
        .default({}),
    })
    .default({ Ports: {} }),
});
export type ContainerInfo = z.infer<typeof containerInspectSchema>;

const containerSummarySchema = z.object({
  Id: z.string(),
  Names: z.array(z.string()),
  State: z.string(),
  Labels: z.record(z.string(), z.string()).nullable().default({}),
});
export type ContainerSummary = z.infer<typeof containerSummarySchema>;

/** The part of the `POST /containers/create` body the lifecycle uses. */
export type ContainerCreateBody = {
  Image: string;
  Entrypoint?: string[];
  Cmd?: string[];
  User?: string;
  Env?: string[];
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig: {
    NetworkMode?: string;
    PortBindings?: Record<string, { HostIp?: string; HostPort: string }[]>;
    Mounts?: {
      Type: 'bind' | 'volume' | 'tmpfs';
      Source?: string;
      Target: string;
      ReadOnly?: boolean;
      BindOptions?: { CreateMountpoint?: boolean };
      TmpfsOptions?: { SizeBytes?: number };
    }[];
    RestartPolicy?: {
      Name: 'no' | 'on-failure' | 'always' | 'unless-stopped';
      MaximumRetryCount?: number;
    };
    NanoCpus?: number;
    Memory?: number;
    MemorySwap?: number;
    PidsLimit?: number;
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    ExtraHosts?: string[];
    LogConfig?: { Type: string; Config?: Record<string, string> };
  };
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases?: string[] }>;
  };
};

export type DockerClient = {
  ping(): Promise<void>;
  /** null if there is no such container. */
  inspect(nameOrId: string): Promise<ContainerInfo | null>;
  /** Containers carrying every given label (`key=value` or `key`), running or not. */
  list(labels: string[]): Promise<ContainerSummary[]>;
  create(name: string, body: ContainerCreateBody): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSeconds?: number): Promise<void>;
  remove(id: string): Promise<void>;
  setRestartPolicy(
    id: string,
    policy: ContainerCreateBody['HostConfig']['RestartPolicy'],
  ): Promise<void>;
  /** Pulls an image unless it is already there. */
  ensureImage(image: string): Promise<void>;
};

export type DockerClientOptions = {
  /** The socket proxy, e.g. `http://docker-socket-proxy:2375`. */
  url: string;
  /** Per-request timeout. Default 30 s (stop waits for the container to exit). */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export function createDockerClient(options: DockerClientOptions): DockerClient {
  const base = `${options.url.replace(/\/+$/, '')}/${DOCKER_API_VERSION}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetch ?? fetch;

  async function call(
    method: string,
    path: string,
    init: { body?: unknown; ok?: number[]; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    let body: RequestInit['body'];
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
    });
    if (res.ok || init.ok?.includes(res.status)) return res;
    const text = await res.text().catch(() => '');
    let message = text.trim() || res.statusText;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // Not JSON (the proxy answers 403 with an HTML page).
    }
    throw new DockerError(res.status, `${method} ${path}: ${message}`);
  }

  const enc = encodeURIComponent;

  return {
    async ping() {
      await call('GET', '/_ping');
    },
    async inspect(nameOrId) {
      const res = await call('GET', `/containers/${enc(nameOrId)}/json`, { ok: [404] });
      if (res.status === 404) return null;
      return containerInspectSchema.parse(await res.json());
    },
    async list(labels) {
      const filters = enc(JSON.stringify({ label: labels }));
      const res = await call('GET', `/containers/json?all=true&filters=${filters}`);
      return z.array(containerSummarySchema).parse(await res.json());
    },
    async create(name, body) {
      const res = await call('POST', `/containers/create?name=${enc(name)}`, { body });
      return z.object({ Id: z.string() }).parse(await res.json()).Id;
    },
    async start(id) {
      // 304: already running.
      await call('POST', `/containers/${enc(id)}/start`, { ok: [304] });
    },
    async stop(id, timeoutSeconds = 10) {
      await call('POST', `/containers/${enc(id)}/stop?t=${timeoutSeconds}`, {
        ok: [304, 404],
        timeoutMs: timeoutMs + timeoutSeconds * 1000,
      });
    },
    async remove(id) {
      await call('DELETE', `/containers/${enc(id)}?force=true&v=true`, { ok: [404] });
    },
    async setRestartPolicy(id, policy) {
      await call('POST', `/containers/${enc(id)}/update`, { body: { RestartPolicy: policy } });
    },
    async ensureImage(image) {
      // Slashes stay literal: the proxy guard refuses encoded ones.
      const path = image.split('/').map(enc).join('/');
      const res = await call('GET', `/images/${path}/json`, { ok: [404] });
      if (res.status !== 404) return;
      const [repo, tag] = splitImage(image);
      // The pull streams progress as JSON lines; an error can arrive in the stream with a 200.
      const pull = await call('POST', `/images/create?fromImage=${enc(repo)}&tag=${enc(tag)}`, {
        timeoutMs: 10 * 60_000,
      });
      const log = await pull.text();
      const failed = log
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { error?: string })
        .find((line) => line.error);
      if (failed) throw new DockerError(500, `pull ${image}: ${failed.error}`);
    },
  };
}

function splitImage(image: string): [string, string] {
  const at = image.indexOf('@');
  if (at !== -1) return [image.slice(0, at), image.slice(at + 1)];
  const colon = image.lastIndexOf(':');
  if (colon > image.lastIndexOf('/')) return [image.slice(0, colon), image.slice(colon + 1)];
  return [image, 'latest'];
}
