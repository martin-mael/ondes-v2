import { describe, expect, it } from 'vitest';
import { engineLifecycleConfigFromEnv } from './plugin.ts';

const secret = 'x'.repeat(32);

describe('engine lifecycle config from env', () => {
  it('is off without ENGINE_DOCKER_URL', () => {
    expect(engineLifecycleConfigFromEnv({}, secret)).toBeNull();
  });

  it('requires the network, api url and cache root, and defaults the rest', () => {
    expect(() =>
      engineLifecycleConfigFromEnv({ ENGINE_DOCKER_URL: 'http://p:2375' }, secret),
    ).toThrow(/ENGINE_NETWORK/);
    const options = engineLifecycleConfigFromEnv(
      {
        ENGINE_DOCKER_URL: 'http://p:2375',
        ENGINE_NETWORK: 'ondes_engines',
        ENGINE_API_URL: 'http://api:3000',
        ENGINE_CACHE_ROOT: '/srv/ondes/cache',
        ICECAST_SOURCE_PASSWORD: 'src',
        ENGINE_MEMORY_MB: '768',
      },
      secret,
    );
    expect(options).toMatchObject({
      dockerUrl: 'http://p:2375',
      secret,
      config: {
        image: 'savonet/liquidsoap:v2.4.6',
        containerPrefix: 'ondes-engine',
        network: 'ondes_engines',
        icecast: { host: 'icecast', port: 8000 },
        sharedIcecastSourcePassword: 'src',
        livePorts: { min: 8100, max: 8199 },
        limits: { cpus: 1, memoryMb: 768, pids: 256 },
      },
      guard: { maxRestarts: 5, windowSeconds: 600 },
    });
  });
});
