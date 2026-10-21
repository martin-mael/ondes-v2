import type { Db } from '@ondes/db';
import { describe, expect, it } from 'vitest';
import {
  createIcecastService,
  type EngineLifecycleHooks,
  icecastServiceConfigFromEnv,
} from './service.ts';

describe('icecastServiceConfigFromEnv', () => {
  it('enables only what is configured', () => {
    expect(icecastServiceConfigFromEnv({})).toEqual({
      configPath: undefined,
      sourceSecret: undefined,
      assetsDir: undefined,
      config: { hostname: 'localhost' },
      syncIntervalMs: undefined,
      admin: undefined,
      statsIntervalMs: undefined,
    });
    expect(
      icecastServiceConfigFromEnv({
        ICECAST_CONFIG_PATH: '/srv/icecast/icecast.xml',
        ICECAST_SOURCE_SECRET: 'secret-password-16+',
        ICECAST_ASSETS_DIR: '/srv/stream-assets',
        ICECAST_PUBLIC_HOSTNAME: 'stream.vandale.fr',
        ICECAST_URL: 'http://icecast:8000',
        ICECAST_ADMIN_PASSWORD: 'pw',
        ICECAST_STATS_INTERVAL_MS: '30000',
      }),
    ).toMatchObject({
      configPath: '/srv/icecast/icecast.xml',
      assetsDir: '/srv/stream-assets',
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

describe('createIcecastService', () => {
  const db = {} as Db; // never touched: nothing is started
  const base = { configPath: '/tmp/icecast.xml', config: { hostname: 'h' } };

  it('needs a source of station passwords to write the config', () => {
    expect(() => createIcecastService({ db, config: base })).toThrow(/ICECAST_SOURCE_SECRET/);
    expect(() => createIcecastService({ db, config: { ...base, sourceSecret: 'short' } })).toThrow(
      /16 characters/,
    );
    expect(
      createIcecastService({ db, config: { ...base, sourceSecret: 'long-enough-secret' } }).sync,
    ).toBeDefined();
    // No config sync, no password needed.
    expect(
      createIcecastService({ db, config: { config: { hostname: 'h' } } }).sync,
    ).toBeUndefined();
  });

  it('syncs Icecast before every engine create of the lifecycle', () => {
    const hooks: unknown[] = [];
    const lifecycle: EngineLifecycleHooks = {
      secretsFor: () => ({ icecastSourcePassword: 'pw' }),
      onBeforeCreate: (hook) => hooks.push(hook),
    };
    const service = createIcecastService({ db, config: base, lifecycle });
    expect(service.sync).toBeDefined();
    expect(hooks).toHaveLength(1);
  });
});
