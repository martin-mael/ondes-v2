import { describe, expect, it } from 'vitest';
import {
  decodePeaks,
  encodePeaks,
  PeaksFormatError,
  peaksIdempotencyKey,
  peaksPointCount,
  peaksPointOfSample,
  peaksPointSamples,
  peaksStorageKey,
} from './peaks.ts';

const sha = 'a'.repeat(64);
const org = '0199f6a0-0000-7000-8000-000000000001';

function sample() {
  // 2 channels, 5 samples, levels of 2 and 4 samples per point.
  return encodePeaks({
    sampleRate: 44_100,
    channels: 2,
    lengthSamples: 5,
    levels: [
      {
        samplesPerPoint: 2,
        points: 3,
        values: Int8Array.from([-1, 1, -2, 2, -3, 3, -4, 4, 0, 0, 5, 5]),
      },
      { samplesPerPoint: 4, points: 2, values: Int8Array.from([-3, 3, -4, 4, 0, 0, 5, 5]) },
    ],
  });
}

describe('peaks file format', () => {
  it('writes the documented header, level table and audiowaveform .dat blobs', () => {
    const bytes = sample();
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('ODPK');
    expect(view.getUint16(4, true)).toBe(1);
    expect(view.getUint16(6, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(44_100);
    expect(view.getUint32(12, true)).toBe(2);
    expect(view.getBigUint64(16, true)).toBe(5n);
    // First level: right after the header (24) and two table entries (32).
    expect([0, 4, 8, 12].map((o) => view.getUint32(24 + o, true))).toEqual([2, 3, 56, 36]);
    expect([0, 4, 8, 12].map((o) => view.getUint32(40 + o, true))).toEqual([4, 2, 92, 32]);
    // audiowaveform v2 header: version, flags (8-bit), rate, samples per pixel, length, channels.
    expect([0, 4, 8, 12, 16, 20].map((o) => view.getInt32(56 + o, true))).toEqual([
      2, 1, 44_100, 2, 3, 2,
    ]);
    expect(Array.from(new Int8Array(bytes.buffer, 80, 12))).toEqual([
      -1, 1, -2, 2, -3, 3, -4, 4, 0, 0, 5, 5,
    ]);
    expect(bytes.length).toBe(124);
  });

  it('decodes what it encodes', () => {
    const decoded = decodePeaks(sample());
    expect(decoded).toMatchObject({
      formatVersion: 1,
      sampleRate: 44_100,
      channels: 2,
      lengthSamples: 5,
    });
    expect(decoded.levels.map((l) => [l.samplesPerPoint, l.points, Array.from(l.values)])).toEqual([
      [2, 3, [-1, 1, -2, 2, -3, 3, -4, 4, 0, 0, 5, 5]],
      [4, 2, [-3, 3, -4, 4, 0, 0, 5, 5]],
    ]);
    expect(decoded.levels[1]?.dat.length).toBe(32);
  });

  it('rejects other files and truncated ones', () => {
    expect(() => decodePeaks(new Uint8Array(32).fill(65))).toThrow(PeaksFormatError);
    expect(() => decodePeaks(sample().subarray(0, 100))).toThrow(/out of bounds/);
  });

  it('refuses levels whose value count disagrees with points and channels', () => {
    expect(() =>
      encodePeaks({
        sampleRate: 44_100,
        channels: 2,
        lengthSamples: 4,
        levels: [{ samplesPerPoint: 2, points: 2, values: new Int8Array(4) }],
      }),
    ).toThrow(/wrong number of values/);
  });
});

describe('sample mapping', () => {
  it('maps integer sample positions to points and back', () => {
    expect(peaksPointCount(44_100, 256)).toBe(173);
    expect(peaksPointCount(0, 256)).toBe(0);
    expect(peaksPointOfSample(0, 256)).toBe(0);
    expect(peaksPointOfSample(255, 256)).toBe(0);
    expect(peaksPointOfSample(256, 256)).toBe(1);
    expect(peaksPointSamples(172, 256, 44_100)).toEqual({ start: 44_032, end: 44_100 });
  });
});

describe('keys', () => {
  it('addresses the file by playout hash and format version', () => {
    expect(peaksStorageKey(org, sha)).toBe(`org/${org}/peaks/v1/${sha}.peaks`);
    expect(
      peaksIdempotencyKey({ orgId: org, stationId: org, assetId: org, playoutSha256: sha }),
    ).toBe(`peaks:${org}:${sha}:v1`);
  });
});
