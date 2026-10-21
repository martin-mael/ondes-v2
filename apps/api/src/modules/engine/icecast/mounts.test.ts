import { describe, expect, it } from 'vitest';
import {
  opusOutput,
  planMounts,
  StationOutputsError,
  stationMounts,
  streamAssetPath,
} from './mounts.ts';

const vandale = { id: 'st-1', orgId: 'org-1', slug: 'vandale', engineSettings: {} };

describe('stationMounts', () => {
  it('defaults to MP3 128k and AAC 128k with a fallback each', () => {
    expect(stationMounts(vandale)).toEqual([
      {
        stationId: 'st-1',
        orgId: 'org-1',
        slug: 'vandale',
        mount: '/vandale/mp3',
        format: 'mp3',
        bitrate: 128,
        contentType: 'audio/mpeg',
        public: false,
        maxListeners: 500,
        burstSize: 65536,
        queueSize: 524288,
        fallbackFile: '/_ondes/vandale/mp3.fallback.mp3',
      },
      {
        stationId: 'st-1',
        orgId: 'org-1',
        slug: 'vandale',
        mount: '/vandale/aac',
        format: 'aac',
        bitrate: 128,
        contentType: 'audio/aac',
        public: false,
        maxListeners: 500,
        burstSize: 65536,
        queueSize: 524288,
        fallbackFile: '/_ondes/vandale/aac.fallback.aac',
      },
    ]);
  });

  it('reads the outputs from the engine settings', () => {
    const [opus] = stationMounts({
      ...vandale,
      engineSettings: {
        outputs: [{ ...opusOutput('vandale'), maxListeners: 20, fallback: false, intro: true }],
      },
    });
    expect(opus).toMatchObject({
      mount: '/vandale/opus',
      contentType: 'application/ogg',
      maxListeners: 20,
      introFile: '/_ondes/vandale/opus.intro.ogg',
    });
    expect(opus).not.toHaveProperty('fallbackFile');
  });

  it("refuses mounts outside the station's namespace", () => {
    for (const mount of ['other/mp3', 'vandale', 'vandale-2/mp3', 'vandale/']) {
      const station = {
        ...vandale,
        engineSettings: { outputs: [{ mount, format: 'mp3', bitrate: 128 }] },
      };
      expect(() => stationMounts(station), mount).toThrow(StationOutputsError);
    }
  });

  it('refuses invalid outputs', () => {
    const station = {
      ...vandale,
      engineSettings: { outputs: [{ mount: 'vandale/mp3', format: 'mp3', bitrate: 100 }] },
    };
    expect(() => stationMounts(station)).toThrow(/bitrate/);
  });
});

describe('planMounts', () => {
  it('skips a broken station without dropping the others', () => {
    const plan = planMounts([
      {
        id: 'st-2',
        orgId: 'org-1',
        slug: 'zeta',
        engineSettings: { outputs: [{ mount: 'vandale/mp3' }] },
      },
      vandale,
    ]);
    expect(plan.mounts.map((m) => m.mount)).toEqual(['/vandale/mp3', '/vandale/aac']);
    expect(plan.skipped.map((e) => e.stationId)).toEqual(['st-2']);
  });
});

it('names asset files after the mount', () => {
  expect(streamAssetPath('/vandale/hi', 'vorbis', 'intro')).toBe('/_ondes/vandale/hi.intro.ogg');
});
