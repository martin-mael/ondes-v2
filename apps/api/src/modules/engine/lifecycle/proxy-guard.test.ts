import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDockerClient, DockerError } from './docker.ts';
import { createProxyGuard, proxyGuardOptionsFromEnv } from './proxy-guard.ts';
import { type EngineLifecycleConfig, engineContainerSpec } from './spec.ts';

// The guard in front of a stand-in Docker API that records what reaches it.

const STATION = '0199a4e2-7c1d-7000-8000-000000000001';
const ENGINE = `ondes-engine-${STATION}`;
const config: EngineLifecycleConfig = {
  image: 'savonet/liquidsoap:v2.4.6',
  containerPrefix: 'ondes-engine',
  network: 'ondes_engines',
  internalApiUrl: 'http://api:3000',
  icecast: { host: 'icecast', port: 8000 },
  cacheRoot: '/srv/ondes/cache',
  livePorts: { min: 8100, max: 8199 },
  liveBindIp: '0.0.0.0',
  limits: { cpus: 1, memoryMb: 512, pids: 256 },
};

let upstream: Server;
let guard: Server;
let guardUrl: string;
const reached: string[] = [];

const containers: Record<string, { Name: string; Labels: Record<string, string> }> = {
  [ENGINE]: { Name: `/${ENGINE}`, Labels: { 'ondes.engine': 'true' } },
  postgres: { Name: '/ondes-dev-postgres-1', Labels: {} },
  // An engine label on a container outside the prefix doesn't make it an engine.
  impostor: { Name: '/impostor', Labels: { 'ondes.engine': 'true' } },
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    const m = req.url?.match(/^(?:\/v[\d.]+)?\/containers\/([^/?]+)\/json/);
    if (req.method === 'GET' && m?.[1]) {
      const c = containers[decodeURIComponent(m[1])];
      if (!c) return res.writeHead(404).end('{"message":"no such container"}');
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          Id: m[1],
          Name: c.Name,
          RestartCount: 0,
          State: { Status: 'running', Running: true },
          Config: { Labels: c.Labels },
        }),
      );
    }
    if (req.url?.includes('/containers/create')) return res.writeHead(201).end('{"Id":"new"}');
    if (req.url?.includes('/containers/json')) return res.writeHead(200).end('[]');
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  guard = createProxyGuard({
    policy: {
      image: config.image,
      namePrefix: 'ondes-engine',
      network: 'ondes_engines',
      cacheRoot: '/srv/ondes/cache',
    },
    upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  });
  await new Promise<void>((r) => guard.listen(0, '127.0.0.1', r));
  guardUrl = `http://127.0.0.1:${(guard.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => guard?.close(r));
  await new Promise((r) => upstream?.close(r));
});

const raw = (method: string, path: string, body?: unknown) =>
  fetch(`${guardUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

describe('docker proxy guard', () => {
  const docker = () => createDockerClient({ url: guardUrl });
  const spec = () =>
    engineContainerSpec(config, {
      station: { stationId: STATION },
      configVersion: 'abc',
      script: 'x',
      secrets: { controlToken: 'a', livePassword: 'b', icecastSourcePassword: 'c' },
      livePort: 8100,
    }).body;

  it('forwards what the lifecycle does to an engine', async () => {
    reached.length = 0;
    await docker().ping();
    expect(await docker().create(ENGINE, spec())).toBe('new');
    expect(await docker().inspect(ENGINE)).toMatchObject({ Name: `/${ENGINE}` });
    await docker().start(ENGINE);
    await docker().setRestartPolicy(ENGINE, { Name: 'no' });
    await docker().stop(ENGINE);
    await docker().remove(ENGINE);
    await docker().list(['ondes.engine=true']);
    expect(reached.filter((r) => !r.includes('/json') || r.includes('/containers/json'))).toEqual([
      'GET /v1.44/_ping',
      `POST /v1.44/containers/create?name=${ENGINE}`,
      `POST /v1.44/containers/${ENGINE}/start`,
      `POST /v1.44/containers/${ENGINE}/update`,
      `POST /v1.44/containers/${ENGINE}/stop?t=10`,
      `DELETE /v1.44/containers/${ENGINE}?force=true&v=true`,
      expect.stringMatching(/^GET \/v1\.44\/containers\/json\?all=true&filters=/),
    ]);
  });

  it('refuses a privileged create before it reaches Docker', async () => {
    reached.length = 0;
    const body = spec();
    (body.HostConfig as Record<string, unknown>).Privileged = true;
    const error = await docker()
      .create(ENGINE, body)
      .catch((e) => e);
    expect(error).toBeInstanceOf(DockerError);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/Privileged/);
    expect(reached).toEqual([]);
  });

  it('hides and protects containers that are not engines', async () => {
    expect(await docker().inspect('postgres')).toBeNull();
    expect(await docker().inspect('impostor')).toBeNull();
    for (const call of [
      () => docker().stop('postgres'),
      () => docker().remove('postgres'),
      () => docker().start('impostor'),
    ]) {
      expect((await call().catch((e) => e)).status).toBe(403);
    }
    expect(reached.some((r) => /postgres\/(stop|start)|DELETE .*postgres/.test(r))).toBe(false);
  });

  it('refuses archives, exec, other images, unfiltered lists and smuggled paths', async () => {
    reached.length = 0;
    const denied = [
      await raw('PUT', `/v1.44/containers/${ENGINE}/archive?path=/etc`),
      await raw('GET', `/v1.44/containers/${ENGINE}/archive?path=/etc`),
      await raw('POST', `/v1.44/containers/${ENGINE}/exec`, { Cmd: ['sh'] }),
      await raw('POST', '/v1.44/exec/abc/start', {}),
      await raw('GET', '/v1.44/containers/json?all=true'),
      await raw('GET', '/v1.44/containers/postgres/logs'),
      await raw('POST', '/v1.44/images/create?fromImage=alpine&tag=3'),
      await raw('POST', '/v1.44/networks/create', { Name: 'x' }),
      await raw('GET', `/v1.44/containers/${ENGINE}%2F..%2Fpostgres/json`),
      await raw('POST', `/v1.44/containers/${ENGINE}/update`, { Memory: 1 }),
    ];
    expect(denied.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403, 403]);
    // Only the engine checks of the per-container requests reached Docker.
    expect(reached.every((r) => r.startsWith('GET ') && r.endsWith('/json'))).toBe(true);
  });

  it('lets only the engine image be checked and pulled', async () => {
    expect((await raw('GET', '/v1.44/images/savonet/liquidsoap:v2.4.6/json')).status).not.toBe(403);
    expect(
      (await raw('POST', '/v1.44/images/create?fromImage=savonet%2Fliquidsoap&tag=v2.4.6')).status,
    ).not.toBe(403);
    expect((await raw('GET', '/v1.44/images/alpine:3/json')).status).toBe(403);
  });

  it('reads its config from the environment and refuses the Docker network for engines', () => {
    const env = {
      GUARD_UPSTREAM: 'http://docker-socket-proxy:2375',
      GUARD_ENGINE_IMAGE: config.image,
      GUARD_ENGINE_PREFIX: 'ondes-engine',
      GUARD_ENGINE_NETWORK: 'ondes_engines',
      GUARD_ENGINE_CACHE_ROOT: '/srv/ondes/cache',
    };
    expect(proxyGuardOptionsFromEnv(env)).toMatchObject({
      port: 2375,
      policy: { network: 'ondes_engines' },
    });
    expect(() =>
      proxyGuardOptionsFromEnv({ ...env, GUARD_DOCKER_NETWORK: 'ondes_engines' }),
    ).toThrow();
    expect(() => proxyGuardOptionsFromEnv({ ...env, GUARD_UPSTREAM: '' })).toThrow(
      /GUARD_UPSTREAM/,
    );
  });
});
