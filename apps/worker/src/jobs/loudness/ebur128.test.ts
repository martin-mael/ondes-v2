import { describe, expect, it } from 'vitest';
import { Ebur128ParseError, parseEbur128Summary } from './ebur128.ts';

// ffmpeg 7.1's closing summary (worker image), with the lines that come before it.
const summary = (integrated: string, lra: string, peak: string) => `
  Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s
[Parsed_ebur128_0 @ 0xffff800034a0] Summary:

  Integrated loudness:
    I:         ${integrated} LUFS
    Threshold: -30.0 LUFS

  Loudness range:
    LRA:         ${lra} LU
    Threshold: -40.0 LUFS
    LRA low:   -20.4 LUFS
    LRA high:  -19.6 LUFS

  True peak:
    Peak:       ${peak} dBFS
[out#0/null @ 0xaaaaf06c3550] video:0KiB audio:1723KiB subtitle:0KiB other streams:0KiB
size=N/A time=00:00:10.00 bitrate=N/A speed= 251x
`;

describe('parseEbur128Summary', () => {
  it('reads integrated loudness, range and true peak', () => {
    expect(parseEbur128Summary(summary('-20.0', '0.8', '-19.9'))).toEqual({
      integratedLufs: -20,
      loudnessRangeLu: 0.8,
      truePeakDbtp: -19.9,
    });
    expect(parseEbur128Summary(summary('-8.3', '12.5', '1.2'))).toEqual({
      integratedLufs: -8.3,
      loudnessRangeLu: 12.5,
      truePeakDbtp: 1.2,
    });
  });

  it('reads digital silence as the gate and no peak', () => {
    expect(parseEbur128Summary(summary('-70.0', '0.0', '-inf'))).toEqual({
      integratedLufs: -70,
      loudnessRangeLu: 0,
      truePeakDbtp: null,
    });
    expect(parseEbur128Summary(summary('-inf', '0.0', '-inf')).integratedLufs).toBe(-70);
  });

  it('only reads the last summary', () => {
    const log = `${summary('-30.0', '1.0', '-25.0')}${summary('-14.0', '6.0', '-0.5')}`;
    expect(parseEbur128Summary(log).integratedLufs).toBe(-14);
  });

  it('rejects output it cannot read as a parse error (retried, not a file error)', () => {
    expect(() => parseEbur128Summary('Error while decoding stream')).toThrow(Ebur128ParseError);
    expect(() => parseEbur128Summary('Summary:\n nothing')).toThrow(/integrated/);
    // A changed format (here: the labels renamed) is not read as "no value".
    expect(() =>
      parseEbur128Summary(summary('-20.0', '0.8', '-19.9').replace('Integrated', 'Programme')),
    ).toThrow(Ebur128ParseError);
  });

  it('requires the true peak (measured with peak=true)', () => {
    const withoutPeak = summary('-20.0', '0.8', '-19.9').replace(/ {2}True peak:\n.*\n/, '');
    expect(withoutPeak).not.toContain('True peak');
    expect(() => parseEbur128Summary(withoutPeak)).toThrow(/no true peak/);
  });
});
