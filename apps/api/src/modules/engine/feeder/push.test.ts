import { describe, expect, it } from 'vitest';
import {
  buildPushItem,
  buildPushSegment,
  crossOutMsOf,
  type FeedMedia,
  type PushSource,
  playLengthMs,
} from './push.ts';

const SR = 44_100;
const SHA = 'ab'.padEnd(64, '0');
const station = { loudnessTargetLufs: -16, truePeakLimitDbtp: -1 };

function media(overrides: Partial<FeedMedia> = {}): FeedMedia {
  return {
    assetId: 'asset-1',
    fileId: 'file-1',
    sha256: SHA,
    ext: 'flac',
    flacBlockSize: 1024,
    durationSamples: 180 * SR,
    sampleRate: SR,
    cached: true,
    title: 'Song',
    artists: ['A', 'B'],
    cues: null,
    gain: { normalizeLoudness: true, gainOverrideDb: null, loudness: null },
    ...overrides,
  };
}

const source = (m: FeedMedia, extra: Partial<PushSource> = {}): PushSource => ({
  itemId: 'item-1',
  title: null,
  cueOverrides: null,
  media: m,
  ...extra,
});

const cues = (c: Partial<NonNullable<FeedMedia['cues']>>) => ({
  sampleRate: SR,
  cueIn: null,
  cueOut: null,
  fadeIn: null,
  fadeOut: null,
  crossStartNext: null,
  ...c,
});

describe('buildPushItem', () => {
  it('pushes the cached playout path, ICY metadata and no gain when it is 0', () => {
    expect(buildPushItem(source(media()), { station })).toEqual({
      item_id: 'item-1',
      uri: `/cache/media/ab/${SHA}.flac`,
      title: 'Song',
      artist: 'A, B',
    });
  });

  it('biases cue points by half a sample: (n − ½)/sr with a cue-in', () => {
    const m = media({ cues: cues({ cueIn: 4410, cueOut: 441_000 }) });
    const item = buildPushItem(source(m), { station });
    expect(item.cue_in).toBe(Number((4409.5 / SR).toFixed(6)));
    expect(item.cue_out).toBe(Number((440_999.5 / SR).toFixed(6)));
    // Liquidsoap plays ceil(out·sr) − ceil(in·sr) samples: exactly cueOut − cueIn.
    expect(Math.ceil((item.cue_out as number) * SR) - Math.ceil((item.cue_in as number) * SR)).toBe(
      441_000 - 4410,
    );
  });

  it('biases a cue-out without cue-in by +½ sample: (n + ½)/sr', () => {
    const item = buildPushItem(source(media({ cues: cues({ cueIn: 0, cueOut: 441_000 }) })), {
      station,
    });
    expect(item.cue_in).toBeUndefined();
    expect(item.cue_out).toBe(Number((441_000.5 / SR).toFixed(6)));
    expect(Math.floor((item.cue_out as number) * SR)).toBe(441_000);
  });

  it('lets log overrides win, at their own sample rate', () => {
    const m = media({ cues: cues({ cueIn: 4410, cueOut: 441_000, fadeOut: 88_200 }) });
    const item = buildPushItem(
      source(m, { cueOverrides: { sampleRate: 48_000, cueOut: 96_000, fadeIn: 24_000 } }),
      { station },
    );
    expect(item.cue_out).toBe(Number((95_999.5 / 48_000).toFixed(6)));
    expect(item.fade_in).toBe(0.5);
    expect(item.fade_out).toBe(2);
  });

  it('sends the gain from getPlayoutGain, or the log override', () => {
    const m = media({
      gain: {
        normalizeLoudness: true,
        gainOverrideDb: null,
        loudness: { integratedLufs: -10, truePeakDbtp: -8 },
      },
    });
    expect(buildPushItem(source(m), { station }).amplify_db).toBe(-6);
    expect(
      buildPushItem(source(m, { cueOverrides: { gainDb: 2.5 } }), { station }).amplify_db,
    ).toBe(2.5);
    const disabled = media({ gain: { ...m.gain, normalizeLoudness: false } });
    expect(buildPushItem(source(disabled), { station }).amplify_db).toBeUndefined();
  });

  it('clamps a log gain override to the true-peak ceiling, like any gain', () => {
    // True peak −4 dBTP, ceiling −1 dBTP: at most +3 dB, whatever the log asks for.
    const loud = media({
      gain: {
        normalizeLoudness: false,
        gainOverrideDb: null,
        loudness: { integratedLufs: -20, truePeakDbtp: -4 },
      },
    });
    expect(
      buildPushItem(source(loud, { cueOverrides: { gainDb: 6 } }), { station }).amplify_db,
    ).toBe(3);
    expect(
      buildPushItem(source(loud, { cueOverrides: { gainDb: -2.04 } }), { station }).amplify_db,
    ).toBe(-2);
    // Unmeasured: applied as given, as getPlayoutGain does for an override.
    expect(
      buildPushItem(source(media(), { cueOverrides: { gainDb: 6 } }), { station }).amplify_db,
    ).toBe(6);
  });

  it('sets cross_in from the previous entry and cross_out from the log or the cues', () => {
    const m = media({ cues: cues({ cueOut: 441_000, crossStartNext: 352_800 }) });
    expect(crossOutMsOf(source(m))).toBe(2000);
    expect(buildPushItem(source(m), { station, crossInMs: 1500 })).toMatchObject({
      cross_in: 1.5,
      cross_out: 2,
    });
    const logged = source(m, { cueOverrides: { crossOutMs: 4000, crossInMs: 0 } });
    expect(buildPushItem(logged, { station, crossInMs: 1500 })).toMatchObject({
      cross_in: 0,
      cross_out: 4,
    });
  });

  it('trims the end for a hard start and makes sure it fades out', () => {
    const m = media({ cues: cues({ cueIn: 4410, cueOut: 100 * SR, fadeOut: SR }) });
    expect(playLengthMs(source(m))).toBe(99_900);
    const item = buildPushItem(source(m), { station, trimMs: 10_000 });
    expect(item.cue_out).toBe(Number(((90 * SR - 0.5) / SR).toFixed(6)));
    expect(item.fade_out).toBe(3);
    // No cue-out: trims from the end of the file.
    const whole = buildPushItem(source(media()), { station, trimMs: 30_000 });
    expect(whole.cue_out).toBe(Number(((150 * SR + 0.5) / SR).toFixed(6)));
  });

  it('uses the item title before the asset title', () => {
    expect(buildPushItem(source(media(), { title: 'Le Journal' }), { station }).title).toBe(
      'Le Journal',
    );
  });
});

describe('buildPushSegment', () => {
  it('pushes every part with its own cues and gain, cue-ins on the block grid', () => {
    const a = media({
      fileId: 'fa',
      cues: cues({ cueIn: 2048, cueOut: 441_000, fadeIn: 4410 }),
      gain: {
        normalizeLoudness: true,
        gainOverrideDb: -3,
        loudness: null,
      },
    });
    const vt = media({ fileId: 'fvt', title: 'VT', artists: [] });
    const b = media({
      fileId: 'fb',
      cues: cues({ cueIn: 5000, cueOut: 882_000, fadeOut: 88_200, crossStartNext: 793_800 }),
    });
    const segment = buildPushSegment(
      {
        segmentId: 'seg',
        cueOverrides: { crossInMs: 1000 },
        parts: [
          { itemId: 'p1', title: null, cueOverrides: null, media: a },
          { itemId: 'p2', title: null, cueOverrides: null, media: vt },
          { itemId: 'p3', title: null, cueOverrides: null, media: b },
        ],
      },
      { station, crossInMs: 4000 },
    );
    expect(segment.segment_id).toBe('seg');
    expect(segment.parts.map((p) => p.item_id)).toEqual(['p1', 'p2', 'p3']);
    expect(segment.parts[0]).toMatchObject({
      cue_in: Number((2047.5 / SR).toFixed(6)),
      cue_out: Number((440_999.5 / SR).toFixed(6)),
      amplify_db: -3,
    });
    expect(segment.parts[1]).not.toHaveProperty('cue_in');
    // 5000 is not on the 1024 grid: 4096 is where the decoder lands.
    expect(segment.parts[2]?.cue_in).toBe(Number((4095.5 / SR).toFixed(6)));
    expect(segment).toMatchObject({ fade_in: 0.1, fade_out: 2, cross_in: 1, cross_out: 2 });
  });
});
