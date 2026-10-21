import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  type ContainerPolicy,
  checkEngineCreate,
  checkEngineUpdate,
  ENGINE_LABELS,
  isEngineName,
} from './container-policy.ts';

/**
 * Docker proxy guard (#35): the only Docker endpoint the api can reach. It sits between the
 * api and the Docker socket proxy (tecnativa), checks every request against the engine
 * container policy (container-policy.ts) and forwards the allowed ones. The socket proxy
 * filters paths only; this filters bodies and targets, so the api can't create a privileged
 * container, mount the host, or touch a container that isn't a station engine.
 *
 * Allowed: ping and version; listing containers filtered on `ondes.engine=true`; creating an
 * engine container; inspecting, starting, stopping, updating (restart policy only) and
 * removing engine containers; checking and pulling the engine image. Everything else is 403,
 * archive uploads and exec included.
 *
 * Dependency-free: run it with `node proxy-guard-main.ts` from these sources.
 */

const MAX_BODY = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type ProxyGuardOptions = {
  policy: ContainerPolicy;
  /** The Docker socket proxy, e.g. `http://docker-socket-proxy:2375`. */
  upstream: string;
  log?: (message: string) => void;
};

type Decision = { allow: true; body?: Buffer } | { allow: false; status: number; reason: string };

const deny = (reason: string, status = 403): Decision => ({ allow: false, status, reason });

export function createProxyGuard(options: ProxyGuardOptions): Server {
  const { policy } = options;
  const upstream = new URL(options.upstream);
  const log = options.log ?? (() => {});

  function forward(req: IncomingMessage, res: ServerResponse, body?: Buffer): void {
    const headers: Record<string, string> = {};
    const type = req.headers['content-type'];
    if (type) headers['content-type'] = type;
    if (body) headers['content-length'] = String(body.length);
    const up = request(
      {
        host: upstream.hostname,
        port: upstream.port || 80,
        method: req.method,
        path: req.url,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `docker proxy unreachable: ${error.message}` }));
    });
    up.end(body);
  }

  /** Whether `id` names an engine container (its labels and name, asked upstream). */
  function isEngine(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const up = request(
        {
          host: upstream.hostname,
          port: upstream.port || 80,
          method: 'GET',
          path: `/containers/${encodeURIComponent(id)}/json`,
        },
        (upRes) => {
          let raw = '';
          upRes.setEncoding('utf8');
          upRes.on('data', (chunk) => {
            raw += chunk;
          });
          upRes.on('end', () => {
            if (upRes.statusCode !== 200) return resolve(false);
            try {
              const info = JSON.parse(raw) as {
                Name?: string;
                Config?: { Labels?: Record<string, string> | null };
              };
              resolve(
                info.Config?.Labels?.[ENGINE_LABELS.managed] === 'true' &&
                  isEngineName(policy, (info.Name ?? '').replace(/^\//, '')),
              );
            } catch {
              resolve(false);
            }
          });
        },
      );
      up.on('error', () => resolve(false));
      up.end();
    });
  }

  async function readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function decide(req: IncomingMessage): Promise<Decision> {
    const url = new URL(req.url ?? '/', 'http://guard');
    // Decoded once: an encoded slash or dot segment can't smuggle another path through.
    const path = url.pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, '');
    if (/%2f|%2e|\.\./i.test(url.pathname)) return deny('encoded or relative path');
    const method = req.method ?? 'GET';
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

    if (method === 'GET' && (path === '/_ping' || path === '/version')) return { allow: true };

    if (parts[0] === 'containers') {
      if (method === 'GET' && parts.length === 2 && parts[1] === 'json') {
        const filters = url.searchParams.get('filters');
        let labels: unknown;
        try {
          labels = filters ? (JSON.parse(filters) as { label?: unknown }).label : undefined;
        } catch {
          return deny('bad filters', 400);
        }
        if (!Array.isArray(labels) || !labels.includes(`${ENGINE_LABELS.managed}=true`))
          return deny(`list must filter on ${ENGINE_LABELS.managed}=true`);
        return { allow: true };
      }
      if (method === 'POST' && parts.length === 2 && parts[1] === 'create') {
        const body = await readBody(req);
        if (!body) return deny('body too large', 413);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return deny('body must be JSON', 400);
        }
        const reason = checkEngineCreate(policy, url.searchParams.get('name') ?? '', parsed);
        return reason ? deny(reason) : { allow: true, body };
      }
      const id = parts[1] ?? '';
      if (!ID.test(id)) return deny('bad container id');
      const action = parts.slice(2).join('/');
      const allowed =
        (method === 'GET' && action === 'json') ||
        (method === 'POST' && ['start', 'stop', 'update'].includes(action)) ||
        (method === 'DELETE' && action === '');
      if (!allowed) return deny(`${method} /containers/{id}/${action} not allowed`);
      if (!(await isEngine(id))) {
        // An inspect of anything else looks like a missing container: nothing to probe.
        return method === 'GET' ? deny('no such container', 404) : deny('not an engine container');
      }
      if (action === 'update') {
        const body = await readBody(req);
        if (!body) return deny('body too large', 413);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return deny('body must be JSON', 400);
        }
        const reason = checkEngineUpdate(parsed);
        return reason ? deny(reason) : { allow: true, body };
      }
      return { allow: true };
    }

    if (parts[0] === 'images') {
      if (
        method === 'GET' &&
        parts.at(-1) === 'json' &&
        parts.slice(1, -1).join('/') === policy.image
      )
        return { allow: true };
      if (method === 'POST' && parts.length === 2 && parts[1] === 'create') {
        const repo = url.searchParams.get('fromImage') ?? '';
        const tag = url.searchParams.get('tag') ?? '';
        const sep = tag.includes(':') ? '@' : ':';
        if (
          `${repo}${sep}${tag}` === policy.image &&
          [...url.searchParams.keys()].every((k) => k === 'fromImage' || k === 'tag')
        )
          return { allow: true };
        return deny(`only ${policy.image} may be pulled`);
      }
    }
    return deny(`${method} ${path} not allowed`);
  }

  return createServer((req, res) => {
    decide(req).then(
      (decision) => {
        if (decision.allow) return forward(req, res, decision.body);
        log(`denied ${req.method} ${req.url}: ${decision.reason}`);
        res.writeHead(decision.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `proxy guard: ${decision.reason}` }));
      },
      (error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `proxy guard: ${String(error)}` }));
      },
    );
  });
}

/** Reads the guard's configuration from its environment. */
export function proxyGuardOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): ProxyGuardOptions & { port: number } {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is not set`);
    return value;
  };
  const policy: ContainerPolicy = {
    image: required('GUARD_ENGINE_IMAGE'),
    namePrefix: required('GUARD_ENGINE_PREFIX'),
    network: required('GUARD_ENGINE_NETWORK'),
    cacheRoot: required('GUARD_ENGINE_CACHE_ROOT'),
    allowLoopbackControl: env.GUARD_ALLOW_LOOPBACK_CONTROL === 'true',
    extraHosts: env.GUARD_EXTRA_HOSTS ? env.GUARD_EXTRA_HOSTS.split(',') : [],
  };
  if (env.GUARD_DOCKER_NETWORK && env.GUARD_DOCKER_NETWORK === policy.network)
    throw new Error('GUARD_ENGINE_NETWORK must not be the Docker API network');
  return { policy, upstream: required('GUARD_UPSTREAM'), port: Number(env.GUARD_PORT ?? 2375) };
}
