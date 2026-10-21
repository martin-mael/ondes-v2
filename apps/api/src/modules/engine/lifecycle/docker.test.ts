import { describe, expect, it } from 'vitest';
import { createDockerClient, DockerError, tarFile } from './docker.ts';

describe('tarFile', () => {
  it('writes a ustar archive with parent directories', () => {
    const tar = Buffer.from(tarFile('ondes/station.liq', 'hello'));
    expect(tar.length % 512).toBe(0);
    const header = (offset: number) => ({
      name: tar
        .subarray(offset, offset + 100)
        .toString('ascii')
        .replace(/\0.*$/s, ''),
      mode: tar.subarray(offset + 100, offset + 107).toString('ascii'),
      size: Number.parseInt(tar.subarray(offset + 124, offset + 135).toString('ascii'), 8),
      type: tar.subarray(offset + 156, offset + 157).toString('ascii'),
      magic: tar.subarray(offset + 257, offset + 262).toString('ascii'),
      checksumOk: (() => {
        const h = Buffer.from(tar.subarray(offset, offset + 512));
        const stored = Number.parseInt(h.subarray(148, 155).toString('ascii'), 8);
        h.fill(' ', 148, 156);
        return h.reduce((a, b) => a + b, 0) === stored;
      })(),
    });
    expect(header(0)).toEqual({
      name: 'ondes/',
      mode: '0000755',
      size: 0,
      type: '5',
      magic: 'ustar',
      checksumOk: true,
    });
    expect(header(512)).toEqual({
      name: 'ondes/station.liq',
      mode: '0000444',
      size: 5,
      type: '0',
      magic: 'ustar',
      checksumOk: true,
    });
    expect(tar.subarray(1024, 1029).toString()).toBe('hello');
  });
});

describe('docker client', () => {
  function client(routes: Record<string, (init: RequestInit) => Response>) {
    const seen: string[] = [];
    const docker = createDockerClient({
      url: 'http://proxy:2375/',
      fetch: (async (url: string, init: RequestInit) => {
        const key = `${init.method} ${url.replace('http://proxy:2375', '')}`;
        seen.push(key);
        const route = Object.entries(routes).find(([k]) => key.startsWith(k));
        return route ? route[1](init) : new Response('nope', { status: 500 });
      }) as typeof fetch,
    });
    return { docker, seen };
  }

  it('maps 404 to null on inspect and parses containers', async () => {
    const { docker } = client({
      'GET /v1.44/containers/missing/json': () =>
        new Response('{"message":"no such container"}', { status: 404 }),
      'GET /v1.44/containers/eng/json': () =>
        Response.json({
          Id: 'abc',
          Name: '/eng',
          RestartCount: 2,
          State: { Status: 'running', Running: true },
          Config: { Labels: { a: 'b' } },
          NetworkSettings: { Ports: { '7000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49000' }] } },
        }),
    });
    expect(await docker.inspect('missing')).toBeNull();
    expect(await docker.inspect('eng')).toMatchObject({
      Id: 'abc',
      RestartCount: 2,
      State: { Running: true },
    });
  });

  it('accepts 304 on start and stop, and reports proxy refusals as DockerError', async () => {
    const { docker, seen } = client({
      'POST /v1.44/containers/x/start': () => new Response(null, { status: 304 }),
      'POST /v1.44/containers/x/stop?t=10': () => new Response(null, { status: 304 }),
      'POST /v1.44/containers/create?name=x': () =>
        new Response('<html>403 Forbidden</html>', { status: 403 }),
    });
    await docker.start('x');
    await docker.stop('x');
    const error = await docker.create('x', { Image: 'i', HostConfig: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(DockerError);
    expect(error.status).toBe(403);
    expect(seen).toEqual([
      'POST /v1.44/containers/x/start',
      'POST /v1.44/containers/x/stop?t=10',
      'POST /v1.44/containers/create?name=x',
    ]);
  });

  it('pulls a missing image and surfaces errors from the pull stream', async () => {
    const { docker, seen } = client({
      'GET /v1.44/images/': () => new Response('{}', { status: 404 }),
      'POST /v1.44/images/create': () =>
        new Response('{"status":"Pulling"}\n{"error":"manifest unknown"}\n'),
    });
    await expect(docker.ensureImage('savonet/liquidsoap:v2.4.6')).rejects.toThrow(
      /manifest unknown/,
    );
    expect(seen[1]).toBe('POST /v1.44/images/create?fromImage=savonet%2Fliquidsoap&tag=v2.4.6');
  });
});
