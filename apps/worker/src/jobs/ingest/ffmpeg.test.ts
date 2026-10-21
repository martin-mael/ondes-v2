import { describe, expect, it } from 'vitest';
import { bitDepth, durationSamples, isLossless, parseFlacStreamInfo } from './ffmpeg.ts';

/** `fLaC` + a STREAMINFO block, like ffmpeg writes it. */
function streamInfo(o: {
  min: number;
  max: number;
  rate: number;
  channels: number;
  bits: number;
  samples: number;
}) {
  const buf = Buffer.alloc(42);
  buf.write('fLaC', 0, 'latin1');
  buf.writeUInt8(0x80, 4); // last block, type 0 (STREAMINFO)
  buf.writeUIntBE(34, 5, 3);
  buf.writeUInt16BE(o.min, 8);
  buf.writeUInt16BE(o.max, 10);
  const packed =
    (BigInt(o.rate) << 44n) |
    (BigInt(o.channels - 1) << 41n) |
    (BigInt(o.bits - 1) << 36n) |
    BigInt(o.samples);
  buf.writeBigUInt64BE(packed, 18);
  return buf;
}

describe('parseFlacStreamInfo', () => {
  it('reads block sizes, format and length', () => {
    const info = { min: 1024, max: 1024, rate: 44_100, channels: 2, bits: 24, samples: 132_300 };
    expect(parseFlacStreamInfo(streamInfo(info))).toEqual({
      minBlockSize: 1024,
      maxBlockSize: 1024,
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 24,
      totalSamples: 132_300,
    });
  });

  it('rejects anything else', () => {
    expect(() => parseFlacStreamInfo(Buffer.from('RIFF....WAVEfmt '))).toThrow(/not a FLAC/);
  });
});

describe('stream helpers', () => {
  it('tells lossless codecs and their depth', () => {
    expect(isLossless({ index: 0, codec_name: 'pcm_s24le' })).toBe(true);
    expect(bitDepth({ index: 0, codec_name: 'pcm_s24le', bits_per_sample: 24 })).toBe(24);
    expect(bitDepth({ index: 0, codec_name: 'flac', bits_per_raw_sample: 16 })).toBe(16);
    expect(bitDepth({ index: 0, codec_name: 'pcm_f32le', sample_fmt: 'flt' })).toBe(32);
    expect(bitDepth({ index: 0, codec_name: 'mp3', sample_fmt: 'fltp' })).toBeNull();
  });

  it('counts samples from sample timestamps, else from the duration', () => {
    const probe = { streams: [] };
    expect(
      durationSamples(
        { index: 0, sample_rate: 48_000, time_base: '1/48000', duration_ts: 144_000 },
        probe,
      ),
    ).toBe(144_000);
    expect(
      durationSamples(
        { index: 0, sample_rate: 44_100, time_base: '1/14112000', duration: 3.0 },
        probe,
      ),
    ).toBe(132_300);
  });
});
