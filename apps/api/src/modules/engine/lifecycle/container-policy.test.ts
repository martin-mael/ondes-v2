import { describe, expect, it } from 'vitest';
import { type ContainerPolicy, checkEngineCreate, checkEngineUpdate } from './container-policy.ts';
import { type EngineLifecycleConfig, engineContainerSpec } from './spec.ts';

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
const policy: ContainerPolicy = {
  image: config.image,
  namePrefix: 'ondes-engine',
  network: 'ondes_engines',
  cacheRoot: '/srv/ondes/cache',
};
const NAME = 'ondes-engine-0199a4e2-7c1d-7000-8000-000000000001';
const good = () =>
  structuredClone(
    engineContainerSpec(config, {
      station: { stationId: '0199a4e2-7c1d-7000-8000-000000000001' },
      configVersion: 'abc',
      script: 'output.dummy(blank())',
      secrets: { controlToken: 'a', livePassword: 'b', icecastSourcePassword: 'c' },
      livePort: 8100,
    }).body,
  ) as unknown as Body;
type Body = Record<string, unknown> & {
  HostConfig: Record<string, unknown>;
  Labels: Record<string, string>;
  NetworkingConfig: { EndpointsConfig: Record<string, unknown> };
};
const firstMount = (b: Body) => (b.HostConfig.Mounts as Record<string, unknown>[])[0] ?? {};
const recordingsMount = (b: Body) => (b.HostConfig.Mounts as Record<string, unknown>[])[1] ?? {};

describe('engine container policy', () => {
  it('allows the lifecycle spec', () => {
    expect(checkEngineCreate(policy, NAME, good())).toBeNull();
  });

  it('allows the engine to run as a numeric non-root user (#67)', () => {
    const body = good();
    body.User = '1000:1000';
    expect(checkEngineCreate(policy, NAME, body)).toBeNull();
  });

  const refuses: [string, (b: ReturnType<typeof good>) => void, RegExp][] = [
    ['privileged mode', (b) => (b.HostConfig.Privileged = true), /Privileged/],
    ['host binds', (b) => (b.HostConfig.Binds = ['/:/host']), /Binds/],
    ['added capabilities', (b) => (b.HostConfig.CapAdd = ['SYS_ADMIN']), /CapAdd/],
    ['devices', (b) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]), /Devices/],
    ['host pid namespace', (b) => (b.HostConfig.PidMode = 'host'), /PidMode/],
    ['host network', (b) => (b.HostConfig.NetworkMode = 'host'), /network/],
    ['another image', (b) => (b.Image = 'alpine:3'), /image/],
    ['another entrypoint', (b) => (b.Entrypoint = ['sh']), /entrypoint/],
    ['a writable root', (b) => (b.HostConfig.ReadonlyRootfs = false), /read-only/],
    ['no memory limit', (b) => delete b.HostConfig.Memory, /Memory/],
    ['swap', (b) => (b.HostConfig.MemorySwap = -1), /swap/],
    ['a mount outside the cache root', (b) => (firstMount(b).Source = '/etc'), /bind source/],
    [
      'a cache path escaping the root',
      (b) => (firstMount(b).Source = '/srv/ondes/cache/../../etc'),
      /bind source/,
    ],
    ['a writable cache', (b) => (firstMount(b).ReadOnly = false), /read-only/],
    // Live recordings (#67): the station's own `recordings` directory only.
    [
      'recordings outside a station directory',
      (b) => (recordingsMount(b).Source = '/srv/ondes/cache/recordings'),
      /bind source/,
    ],
    [
      'recordings escaping the root',
      (b) => (recordingsMount(b).Source = '/srv/ondes/cache/../etc/recordings'),
      /bind source/,
    ],
    [
      'a writable cache disguised as recordings',
      (b) => (recordingsMount(b).Source = '/srv/ondes/cache/st-1'),
      /bind source/,
    ],
    [
      "another station's recordings",
      (b) =>
        (recordingsMount(b).Source =
          '/srv/ondes/cache/0199a4e2-7c1d-7000-8000-000000000002/recordings'),
      /bind source must be \/srv\/ondes\/cache\/0199a4e2-7c1d-7000-8000-000000000001\/recordings/,
    ],
    [
      "another station's cache",
      (b) => (firstMount(b).Source = '/srv/ondes/cache/0199a4e2-7c1d-7000-8000-000000000002'),
      /bind source/,
    ],
    ['running as root', (b) => (b.User = '0:0'), /user/],
    ['a named user', (b) => (b.User = 'root'), /user/],
    ['a uid without a group', (b) => (b.User = '1000'), /user/],
    [
      'the recordings directory at the cache target',
      (b) => {
        recordingsMount(b).Target = '/cache';
      },
      /bind source/,
    ],
    [
      'a docker volume',
      (b) => (b.HostConfig.Mounts as unknown[]).push({ Type: 'volume', Target: '/x' }),
      /volume/,
    ],
    [
      'a tmpfs elsewhere',
      (b) => (b.HostConfig.Mounts as unknown[]).push({ Type: 'tmpfs', Target: '/etc' }),
      /tmpfs/,
    ],
    ['foreign labels', (b) => (b.Labels['traefik.enable'] = 'true'), /labels/],
    ['no engine label', (b) => delete b.Labels['ondes.engine'], /labels/],
    [
      'the control port',
      (b) =>
        ((b.HostConfig.PortBindings as Record<string, unknown>)['7000/tcp'] = [
          { HostIp: '127.0.0.1', HostPort: '' },
        ]),
      /7000/,
    ],
    [
      'the metrics port',
      (b) =>
        ((b.HostConfig.PortBindings as Record<string, unknown>)['9599/tcp'] = [
          { HostPort: '9599' },
        ]),
      /9599/,
    ],
    ['another network endpoint', (b) => (b.NetworkingConfig.EndpointsConfig.bridge = {}), /bridge/],
    ['extra hosts', (b) => (b.HostConfig.ExtraHosts = ['evil:1.2.3.4']), /extra hosts/],
  ];
  for (const [what, mutate, reason] of refuses) {
    it(`refuses ${what}`, () => {
      const body = good();
      mutate(body);
      expect(checkEngineCreate(policy, NAME, body)).toMatch(reason);
    });
  }

  it('refuses other container names', () => {
    expect(checkEngineCreate(policy, 'postgres', good())).toMatch(/name/);
    expect(checkEngineCreate(policy, 'ondes-engine-../x', good())).toMatch(/name/);
  });

  it('only lets the restart policy be updated', () => {
    expect(checkEngineUpdate({ RestartPolicy: { Name: 'no' } })).toBeNull();
    expect(
      checkEngineUpdate({ RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 } }),
    ).toBeNull();
    expect(checkEngineUpdate({ RestartPolicy: { Name: 'no' }, Memory: 1 })).toMatch(/Memory/);
    expect(checkEngineUpdate({ RestartPolicy: { Name: 'always' } })).toMatch(/restart policy/);
  });
});
