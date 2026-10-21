import { z } from 'zod';

/**
 * The few Docker Engine API calls the lifecycle needs, over plain `fetch`. The api never
 * gets the Docker socket: it talks to the Docker socket proxy (`deploy/engine/
 * docker-socket-proxy.compose.yml`), which only lets container, image-pull, ping and version
 * requests through. See README.md.
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
  Cmd?: string[];
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
  /** Extracts a tar archive into `path` inside the container (created or stopped). */
  putArchive(id: string, path: string, tar: Uint8Array): Promise<void>;
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
    init: { body?: unknown; raw?: Uint8Array; ok?: number[]; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    let body: RequestInit['body'];
    if (init.raw) {
      headers['content-type'] = 'application/x-tar';
      body = init.raw;
    } else if (init.body !== undefined) {
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
    async putArchive(id, path, tar) {
      await call('PUT', `/containers/${enc(id)}/archive?path=${enc(path)}`, { raw: tar });
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
      const res = await call('GET', `/images/${enc(image)}/json`, { ok: [404] });
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

/**
 * A POSIX ustar archive holding one file, for `putArchive`. Parent directories of `name`
 * (e.g. `ondes/` for `ondes/station.liq`) get their own entries, mode 0755.
 */
export function tarFile(name: string, content: string | Uint8Array, mode = 0o444): Uint8Array {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const parts = name.split('/');
  const dirs = parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join('/')}/`);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([
    ...dirs.map((dir) => tarHeader(dir, 0, 0o755, '5')),
    tarHeader(name, data.length, mode, '0'),
    data,
    padding,
    Buffer.alloc(1024),
  ]);
}

function tarHeader(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error('tar: file name too long');
  const header = Buffer.alloc(512);
  const field = (offset: number, length: number, value: string) =>
    header.write(value, offset, length, 'ascii');
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0');
  field(0, 100, name);
  field(100, 8, octal(mode, 8));
  field(108, 8, octal(0, 8)); // uid
  field(116, 8, octal(0, 8)); // gid
  field(124, 12, octal(size, 12));
  field(136, 12, octal(Math.floor(Date.now() / 1000), 12));
  field(148, 8, '        '); // checksum placeholder: eight spaces
  field(156, 1, type);
  field(257, 6, 'ustar');
  field(263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, `${octal(sum, 7)}\0`);
  return header;
}
