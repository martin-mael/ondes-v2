import { describe, expect, it } from 'vitest';
import { engineLifecycleConfigFromEnv } from './plugin.ts';

const base = {
  ENGINE_DOCKER_URL: 'http://docker-proxy-guard:2375',
  ENGINE_NETWORK: 'ondes_engines',
  ENGINE_API_URL: 'http://api:3000',
  ENGINE_CACHE_ROOT: '/srv/ondes/cache',
  ENGINE_SECRETS_KEY: 'x'.repeat(32),
};

describe('engine lifecycle config from env', () => {
  it('is off without ENGINE_DOCKER_URL', () => {
    expect(engineLifecycleConfigFromEnv({})).toBeNull();
  });

  it('requires the network, api url, cache root and secrets key, and defaults the rest', () => {
    expect(() => engineLifecycleConfigFromEnv({ ENGINE_DOCKER_URL: 'http://p:2375' })).toThrow(
      /ENGINE_NETWORK/,
    );
    expect(() => engineLifecycleConfigFromEnv({ ...base, ENGINE_SECRETS_KEY: '' })).toThrow(
      /ENGINE_SECRETS_KEY/,
    );
    expect(engineLifecycleConfigFromEnv({ ...base, ENGINE_MEMORY_MB: '768' })).toMatchObject({
      dockerUrl: 'http://docker-proxy-guard:2375',
      secretKeys: { currentId: 'k1' },
      config: {
        image: 'savonet/liquidsoap:v2.4.6',
        containerPrefix: 'ondes-engine',
        network: 'ondes_engines',
        icecast: { host: 'icecast', port: 8000 },
        livePorts: { min: 8100, max: 8199 },
        limits: { cpus: 1, memoryMb: 768, pids: 256 },
      },
      guard: { maxRestarts: 5, windowSeconds: 600 },
    });
  });

  it('publishes the control port on loopback and adds hosts only when asked (dev)', () => {
    const config = engineLifecycleConfigFromEnv(base)?.config;
    expect(config?.publishControlOnLoopback).toBeUndefined();
    expect(config?.extraHosts).toBeUndefined();
    expect(
      engineLifecycleConfigFromEnv({
        ...base,
        ENGINE_PUBLISH_CONTROL_ON_LOOPBACK: 'true',
        ENGINE_EXTRA_HOSTS: 'host.docker.internal:host-gateway',
      })?.config,
    ).toMatchObject({
      publishControlOnLoopback: true,
      extraHosts: ['host.docker.internal:host-gateway'],
    });
  });

  it('refuses to put engines on the Docker API networks', () => {
    for (const network of ['docker-api', 'ondes_docker-api', 'ondes_docker-socket']) {
      expect(() => engineLifecycleConfigFromEnv({ ...base, ENGINE_NETWORK: network })).toThrow(
        /Docker API network/,
      );
    }
  });
});
