import { describe, expect, it } from 'vitest';
import { icecastServiceConfigFromEnv } from './service.ts';

describe('icecastServiceConfigFromEnv', () => {
  it('enables only what is configured', () => {
    expect(icecastServiceConfigFromEnv({})).toEqual({
      configPath: undefined,
      config: { hostname: 'localhost' },
      syncIntervalMs: undefined,
      admin: undefined,
      statsIntervalMs: undefined,
    });
    expect(
      icecastServiceConfigFromEnv({
        ICECAST_CONFIG_PATH: '/srv/icecast/icecast.xml',
        ICECAST_PUBLIC_HOSTNAME: 'stream.vandale.fr',
        ICECAST_URL: 'http://icecast:8000',
        ICECAST_ADMIN_PASSWORD: 'pw',
        ICECAST_STATS_INTERVAL_MS: '30000',
      }),
    ).toMatchObject({
      configPath: '/srv/icecast/icecast.xml',
      config: { hostname: 'stream.vandale.fr' },
      admin: { url: 'http://icecast:8000', user: 'admin', password: 'pw' },
      statsIntervalMs: 30000,
    });
  });

  it('rejects a bad interval', () => {
    expect(() => icecastServiceConfigFromEnv({ ICECAST_STATS_INTERVAL_MS: '10' })).toThrow(
      /interval/,
    );
  });
});
