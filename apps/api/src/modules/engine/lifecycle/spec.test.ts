import { describe, expect, it } from 'vitest';
import { renderStationScript } from '../config/render.ts';
import { checkEngineCreate } from './container-policy.ts';
import type { EngineLifecycleConfig } from './spec.ts';
import {
  containerName,
  ENGINE_ENTRYPOINT,
  ENGINE_LABELS,
  EngineOutputsError,
  engineContainerSpec,
  engineSettingsFor,
} from './spec.ts';

const config: EngineLifecycleConfig = {
  image: 'savonet/liquidsoap:v2.4.6',
  containerPrefix: 'ondes-engine',
  network: 'ondes_engines',
  internalApiUrl: 'http://api:3000/',
  icecast: { host: 'icecast', port: 8000 },
  cacheRoot: '/srv/ondes/cache/',
  livePorts: { min: 8100, max: 8199 },
  liveBindIp: '0.0.0.0',
  limits: { cpus: 1.5, memoryMb: 512, pids: 256 },
};
const secrets = { controlToken: 'ctl', livePassword: 'live', icecastSourcePassword: 'src' };
const station = { stationId: 'st-1', slug: 'vandale', name: 'Vandale Radio', engineSettings: {} };

describe('engine settings for a station', () => {
  it('forces what the lifecycle owns and defaults the outputs', () => {
    const settings = engineSettingsFor(
      {
        ...station,
        engineSettings: {
          stationId: 'forged',
          control: { port: 1234 },
          live: { enabled: false, port: 9999, mount: 'dj' },
          blank: { maxSeconds: 30 },
          icecast: { host: 'elsewhere', port: 1 },
        },
      },
      config,
    );
    expect(settings).toMatchObject({
      stationId: 'st-1',
      name: 'Vandale Radio',
      control: { port: 7000 },
      metrics: { port: 9599, enabled: false },
      eventsUrl: 'http://api:3000/internal/engine/stations/st-1/events',
      live: { enabled: false, port: 8005, mount: 'dj' },
      blank: { maxSeconds: 30 },
      paths: { safetyDir: '/cache/safety', emergencyFile: '/cache/emergency.flac' },
      icecast: { host: 'icecast', port: 8000 },
      outputs: [
        { mount: 'vandale/mp3', format: 'mp3', bitrate: 128 },
        { mount: 'vandale/aac', format: 'aac', bitrate: 128 },
      ],
    });
    // It renders.
    expect(renderStationScript(settings).version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps outputs and a name set in the station settings', () => {
    const outputs = [{ mount: 'vandale/opus', format: 'opus', bitrate: 96 }];
    const settings = engineSettingsFor(
      { ...station, engineSettings: { name: 'Vandale', outputs } },
      config,
    );
    expect(settings).toMatchObject({ name: 'Vandale', outputs });
  });

  it("refuses outputs outside the station's mount namespace", () => {
    for (const mount of ['other-station/mp3', 'vandale', 'vandale.mp3', 'vandalex/mp3']) {
      expect(() =>
        engineSettingsFor(
          { ...station, engineSettings: { outputs: [{ mount, format: 'mp3', bitrate: 128 }] } },
          config,
        ),
      ).toThrow(EngineOutputsError);
    }
  });
});

describe('engine container spec', () => {
  const spec = (over: Partial<EngineLifecycleConfig> = {}, livePort: number | null = 8100) =>
    engineContainerSpec(
      { ...config, ...over },
      { station: { stationId: 'st-1' }, configVersion: 'abc', script: 'SCRIPT', secrets, livePort },
    );

  it('runs the pinned image with limits, the read-only cache and secrets in its env', () => {
    const { body, specHash } = spec();
    expect(containerName(config, 'st-1')).toBe('ondes-engine-st-1');
    expect(body).toMatchObject({
      Image: 'savonet/liquidsoap:v2.4.6',
      Entrypoint: [...ENGINE_ENTRYPOINT],
      Cmd: [],
      Env: [
        'ENGINE_CONTROL_TOKEN=ctl',
        'ENGINE_LIVE_PASSWORD=live',
        'ICECAST_SOURCE_PASSWORD=src',
        'ENGINE_SCRIPT=SCRIPT',
      ],
      Labels: {
        [ENGINE_LABELS.managed]: 'true',
        [ENGINE_LABELS.station]: 'st-1',
        [ENGINE_LABELS.configVersion]: 'abc',
        [ENGINE_LABELS.spec]: specHash,
      },
      HostConfig: {
        NetworkMode: 'ondes_engines',
        NanoCpus: 1_500_000_000,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        PidsLimit: 256,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
        Mounts: [
          {
            Type: 'bind',
            Source: '/srv/ondes/cache/st-1',
            Target: '/cache',
            ReadOnly: true,
            BindOptions: { CreateMountpoint: true },
          },
          { Type: 'tmpfs', Target: '/tmp', TmpfsOptions: { SizeBytes: 64 * 1024 * 1024 } },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { ondes_engines: { Aliases: ['ondes-engine-st-1'] } } },
    });
  });

  it('publishes the live port only, never the control port', () => {
    expect(spec().body.HostConfig.PortBindings).toEqual({
      '8005/tcp': [{ HostIp: '0.0.0.0', HostPort: '8100' }],
    });
    expect(spec({}, null).body.HostConfig.PortBindings).toEqual({});
    expect(spec({ publishControlOnLoopback: true }, null).body.HostConfig.PortBindings).toEqual({
      '7000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
    });
  });

  it('is exactly what the Docker proxy guard allows', () => {
    const policy = {
      image: config.image,
      namePrefix: config.containerPrefix,
      network: config.network,
      cacheRoot: config.cacheRoot,
    };
    expect(checkEngineCreate(policy, 'ondes-engine-st-1', spec().body)).toBeNull();
    // The test-only loopback control port needs the guard's matching switch.
    const loopback = spec({ publishControlOnLoopback: true }).body;
    expect(checkEngineCreate(policy, 'ondes-engine-st-1', loopback)).toMatch(/7000/);
    expect(
      checkEngineCreate({ ...policy, allowLoopbackControl: true }, 'ondes-engine-st-1', loopback),
    ).toBeNull();
  });

  it('changes its hash with anything that changes the container', () => {
    const base = spec().specHash;
    expect(spec().specHash).toBe(base);
    expect(spec({ limits: { ...config.limits, pids: 300 } }).specHash).not.toBe(base);
    expect(spec({}, 8101).specHash).not.toBe(base);
    expect(
      engineContainerSpec(config, {
        station: { stationId: 'st-1' },
        configVersion: 'abc',
        script: 'SCRIPT',
        secrets: { ...secrets, controlToken: 'rotated' },
        livePort: 8100,
      }).specHash,
    ).not.toBe(base);
    expect(
      engineContainerSpec(config, {
        station: { stationId: 'st-1' },
        configVersion: 'def',
        script: 'SCRIPT',
        secrets,
        livePort: 8100,
      }).specHash,
    ).not.toBe(base);
  });
});
