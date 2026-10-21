import { DEFAULT_AUTOCUE_SETTINGS } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { autocueAnalyzerVersion } from './autocue.ts';
import { analysisArgs, FrameParser } from './frames.ts';

// Lines as ffmpeg 7.1 prints them (`ametadata=mode=print`), trimmed to the keys we read.
const OUTPUT = `frame:0    pts:0       pts_time:0
lavfi.astats.Overall.Peak_level=-inf
lavfi.r128.M=-120.691
lavfi.r128.S=-120.691
lavfi.r128.I=-70.000
frame:1    pts:4410    pts_time:0.1
lavfi.astats.Overall.Peak_level=-inf
lavfi.r128.M=-163.156
lavfi.r128.I=-70.000
frame:2    pts:8820    pts_time:0.2
lavfi.astats.Overall.Peak_level=-32.601509
lavfi.r128.M=-38.442
lavfi.r128.I=-38.450
lavfi.r128.true_peaks_ch0=0.025
frame:4    pts:17640   pts_time:0.4
lavfi.astats.Overall.Peak_level=-32.601509
lavfi.r128.M=nan
lavfi.r128.I=-36.683
`;

describe('FrameParser', () => {
  it('reads momentary loudness, peaks and the final integrated loudness per frame', () => {
    const parser = new FrameParser(4410);
    for (const line of OUTPUT.split('\n')) parser.push(line);
    const series = parser.series(44_100, 5 * 4410);
    expect(Array.from(series.momentary)).toEqual([
      -120.691,
      -163.156,
      -38.442,
      // Frame 3 is missing: silence. `nan` too.
      -Infinity,
      -Infinity,
    ]);
    expect(Array.from(series.peak ?? [])).toEqual([
      -Infinity,
      -Infinity,
      -32.601509,
      Number.NaN,
      -32.601509,
    ]);
    expect(series).toMatchObject({
      sampleRate: 44_100,
      frameSamples: 4410,
      totalSamples: 22_050,
      integratedLufs: -36.683,
    });
  });

  it('ignores lines before the first frame', () => {
    const parser = new FrameParser(4410);
    parser.push('lavfi.r128.M=-10');
    expect(parser.series(44_100, 0).momentary).toHaveLength(0);
  });
});

describe('analysisArgs', () => {
  it('reads local files through the audio demuxers only', () => {
    const args = analysisArgs('/tmp/x.flac', 4410);
    expect(args).toContain('-protocol_whitelist');
    expect(args).toContain('-format_whitelist');
    expect(args.join(' ')).toContain('asetnsamples=n=4410:p=0');
  });
});

describe('autocueAnalyzerVersion', () => {
  it('is the algorithm version for default thresholds, plus a hash otherwise', () => {
    expect(autocueAnalyzerVersion(DEFAULT_AUTOCUE_SETTINGS)).toBe('autocue/1');
    const custom = autocueAnalyzerVersion({ ...DEFAULT_AUTOCUE_SETTINGS, overlayLu: -10 });
    expect(custom).toMatch(/^autocue\/1\+[0-9a-f]{8}$/);
    expect(autocueAnalyzerVersion({ ...DEFAULT_AUTOCUE_SETTINGS, overlayLu: -10 })).toBe(custom);
  });
});
