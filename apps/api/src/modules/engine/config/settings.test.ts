import { describe, expect, it } from 'vitest';
import { stationEngineSettingsSchema } from './settings.ts';

const minimal = {
  stationId: 'vandale',
  name: 'Vandale Radio',
  outputs: [{ mount: 'vandale.mp3', format: 'mp3', bitrate: 128 }],
} as const;

describe('stationEngineSettingsSchema', () => {
  it('fills every default from the minimal settings', () => {
    const s = stationEngineSettingsSchema.parse(minimal);
    expect(s.control.port).toBe(7000);
    expect(s.metrics.port).toBe(9599);
    expect(s.live).toEqual({ enabled: true, port: 8005, mount: 'live', buffer: 5, maxBuffer: 10 });
    expect(s.crossfade.duration).toBe(3);
    expect(s.processing.compressor.enabled).toBe(true);
    expect(s.processing.limiter.enabled).toBe(true);
    expect(s.icecast).toEqual({ host: 'icecast', port: 8000 });
    expect(s.outputs[0]?.public).toBe(false);
  });

  it('keeps partial nested settings and defaults the rest', () => {
    const s = stationEngineSettingsSchema.parse({
      ...minimal,
      processing: { compressor: { enabled: false } },
    });
    expect(s.processing.compressor.enabled).toBe(false);
    expect(s.processing.compressor.ratio).toBe(3);
    expect(s.processing.limiter.enabled).toBe(true);
  });

  it('rejects a bitrate the encoder does not support', () => {
    const r = stationEngineSettingsSchema.safeParse({
      ...minimal,
      outputs: [{ mount: 'x.mp3', format: 'mp3', bitrate: 100 }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['outputs', 0, 'bitrate']);
  });

  it('rejects mounts and ids that would need escaping', () => {
    for (const mount of ['/x.mp3', 'a b', 'x"y', '']) {
      const r = stationEngineSettingsSchema.safeParse({
        ...minimal,
        outputs: [{ mount, format: 'mp3', bitrate: 128 }],
      });
      expect(r.success, mount).toBe(false);
    }
    expect(stationEngineSettingsSchema.safeParse({ ...minimal, stationId: 'a"b' }).success).toBe(
      false,
    );
  });

  it('rejects duplicate mounts and clashing ports', () => {
    const dup = stationEngineSettingsSchema.safeParse({
      ...minimal,
      outputs: [minimal.outputs[0], minimal.outputs[0]],
    });
    expect(dup.success).toBe(false);
    const ports = stationEngineSettingsSchema.safeParse({ ...minimal, live: { port: 7000 } });
    expect(ports.success).toBe(false);
    // The live port is free to reuse when live input is off.
    const off = stationEngineSettingsSchema.safeParse({
      ...minimal,
      live: { enabled: false, port: 7000 },
    });
    expect(off.success).toBe(true);
  });

  it('needs at least one output and a live buffer below its maximum', () => {
    expect(stationEngineSettingsSchema.safeParse({ ...minimal, outputs: [] }).success).toBe(false);
    expect(
      stationEngineSettingsSchema.safeParse({ ...minimal, live: { buffer: 10, maxBuffer: 5 } })
        .success,
    ).toBe(false);
  });

  it('accepts http(s) URLs only', () => {
    expect(
      stationEngineSettingsSchema.safeParse({ ...minimal, eventsUrl: 'file:///etc/passwd' })
        .success,
    ).toBe(false);
    expect(
      stationEngineSettingsSchema.safeParse({ ...minimal, eventsUrl: 'http://api:3000/events' })
        .success,
    ).toBe(true);
  });
});
