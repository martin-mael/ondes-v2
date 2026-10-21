import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { renderIcecastConfig, SECRET_PLACEHOLDER, xmlEscape } from './config.ts';
import { stationMounts } from './mounts.ts';

const mounts = [
  ...stationMounts({ id: 'a', orgId: 'o', slug: 'vandale', engineSettings: {} }),
  ...stationMounts({
    id: 'b',
    orgId: 'o',
    slug: 'other',
    engineSettings: {
      outputs: [
        {
          mount: 'other/opus',
          format: 'opus',
          bitrate: 96,
          fallback: false,
          intro: true,
          maxListeners: 10,
        },
      ],
    },
  }),
];

const parse = (xml: string) =>
  new XMLParser({
    ignoreAttributes: false,
    htmlEntities: true,
    isArray: (n) => n === 'mount',
  }).parse(xml).icecast;

describe('renderIcecastConfig', () => {
  it('declares every mount with its limits, charset and fallback', () => {
    const cfg = parse(renderIcecastConfig(mounts, { hostname: 'stream.vandale.fr' }));
    expect(cfg.hostname).toBe('stream.vandale.fr');
    const normal = cfg.mount.filter((m: Record<string, string>) => m['@_type'] === 'normal');
    expect(normal.map((m: Record<string, string>) => m['mount-name'])).toEqual([
      '/vandale/mp3',
      '/vandale/aac',
      '/other/opus',
    ]);
    expect(normal[0]).toMatchObject({
      charset: 'UTF-8',
      'max-listeners': 500,
      'burst-size': 65536,
      'queue-size': 524288,
      public: 0,
      'fallback-mount': '/_ondes/vandale/mp3.fallback.mp3',
      'fallback-override': 'all',
      'fallback-when-full': 1,
    });
    expect(normal[2]).toMatchObject({ 'max-listeners': 10, intro: '/_ondes/other/opus.intro.ogg' });
    expect(normal[2]).not.toHaveProperty('fallback-mount');
    const fallbackDefault = cfg.mount.find(
      (m: Record<string, string>) => m['@_type'] === 'default',
    );
    expect(fallbackDefault.charset).toBe('UTF-8');
  });

  it('sizes the global limits from the mounts', () => {
    const cfg = parse(renderIcecastConfig(mounts, { hostname: 'h', extraClients: 50 }));
    expect(cfg.limits.clients).toBe(500 + 500 + 10 + 50);
    // 3 mounts + 2 fallback files + headroom.
    expect(cfg.limits.sources).toBe(7);
    expect(cfg.limits['burst-size']).toBeLessThan(cfg.limits['queue-size']);
  });

  it('renders placeholders, never secrets', () => {
    const cfg = parse(renderIcecastConfig(mounts, { hostname: 'h' }));
    expect(cfg.authentication).toEqual({
      'source-password': SECRET_PLACEHOLDER.sourcePassword,
      'relay-password': SECRET_PLACEHOLDER.relayPassword,
      'admin-user': SECRET_PLACEHOLDER.adminUser,
      'admin-password': SECRET_PLACEHOLDER.adminPassword,
    });
  });

  it('is deterministic and escapes text', () => {
    const opts = { hostname: 'h', location: 'Lyon <&> "Croix-Rousse"' };
    const xml = renderIcecastConfig(mounts, opts);
    expect(renderIcecastConfig(mounts, opts)).toBe(xml);
    expect(parse(xml).location).toBe('Lyon <&> "Croix-Rousse"');
  });

  it('renders a config with no station at all', () => {
    const cfg = parse(renderIcecastConfig([], { hostname: 'h' }));
    expect(cfg.mount).toHaveLength(1);
  });
});

it('xmlEscape strips control characters', () => {
  expect(xmlEscape('a\u0001b<')).toBe('ab&#60;');
});
