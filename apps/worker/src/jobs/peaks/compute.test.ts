import { decodePeaks, encodePeaks, peaksPointOfSample, peaksPointSamples } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { computePeaks, PeaksAccumulator, reducePeaks, toInt8 } from './compute.ts';

// Peak maths on synthetic signals: hand-checked points, then sines whose envelope is known.

/** Interleaves per-channel signals into one Int16Array. */
function interleave(...channels: number[][]): Int16Array {
  const frames = channels[0]?.length ?? 0;
  const out = new Int16Array(frames * channels.length);
  for (let f = 0; f < frames; f++) {
    channels.forEach((c, ch) => {
      out[f * channels.length + ch] = c[f] as number;
    });
  }
  return out;
}

const sine = (frames: number, amplitude: number, period: number, phase = 0) =>
  Array.from({ length: frames }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * (i + phase)) / period)),
  );

/** Values of one channel of a level as [min, max] pairs. */
function pairs(values: ArrayLike<number>, channels: number, ch: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = ch * 2; i < values.length; i += channels * 2) {
    out.push([values[i] as number, values[i + 1] as number]);
  }
  return out;
}

describe('PeaksAccumulator', () => {
  it('keeps the min and max of each point, per channel', () => {
    const acc = new PeaksAccumulator(2, 4);
    acc.push(interleave([0, 5, -3, 2, 7, 7, 7, 7, -1], [100, -100, 0, 0, 0, 0, 0, 1, 2]));
    const { lengthSamples, points, values } = acc.finish();
    expect(lengthSamples).toBe(9);
    expect(points).toBe(3);
    expect(pairs(values, 2, 0)).toEqual([
      [-3, 5],
      [7, 7],
      [-1, -1], // the last point holds one sample
    ]);
    expect(pairs(values, 2, 1)).toEqual([
      [-100, 100],
      [0, 1],
      [2, 2],
    ]);
  });

  it('gives the same result however the samples are chunked', () => {
    const signal = interleave(sine(10_000, 20_000, 441), sine(10_000, 9000, 100, 7));
    const whole = new PeaksAccumulator(2, 256);
    whole.push(signal);
    const chunked = new PeaksAccumulator(2, 256, 10);
    for (let at = 0; at < signal.length; at += 2 * 97) {
      chunked.push(signal.subarray(at, Math.min(at + 2 * 97, signal.length)));
    }
    expect(chunked.finish()).toEqual(whole.finish());
  });

  it('refuses a partial frame', () => {
    expect(() => new PeaksAccumulator(2, 4).push(new Int16Array(3))).toThrow(/partial frame/);
  });

  it('has no points for an empty signal', () => {
    expect(new PeaksAccumulator(1, 256).finish()).toEqual({
      lengthSamples: 0,
      points: 0,
      values: new Int16Array(0),
    });
  });
});

describe('reducePeaks and toInt8', () => {
  it('merges points into the min of mins and max of maxes', () => {
    const fine = new Int16Array([-1, 1, -5, 2, 0, 9, -2, 3, 4, 4]);
    expect(Array.from(reducePeaks(fine, 1, 2))).toEqual([-5, 2, -2, 9, 4, 4]);
  });

  it('floors 16-bit values to 8 bits like audiowaveform', () => {
    expect(
      Array.from(toInt8(new Int16Array([-32768, -257, -256, -1, 0, 255, 256, 32767]))),
    ).toEqual([-128, -2, -1, -1, 0, 0, 1, 127]);
  });
});

describe('computePeaks', () => {
  it('traces the envelope of a full-scale sine at every level', () => {
    // 441 Hz at 44.1 kHz: a period of 100 samples, so every 256-sample point sees a full cycle.
    const frames = 44_100;
    const peaks = computePeaks(interleave(sine(frames, 32767, 100)), {
      channels: 1,
      sampleRate: 44_100,
    });
    expect(peaks.lengthSamples).toBe(frames);
    expect(peaks.levels.map((l) => [l.samplesPerPoint, l.points])).toEqual([
      [256, 173], // ceil(44100 / 256)
      [4096, 11],
    ]);
    for (const level of peaks.levels) {
      for (const [lo, hi] of pairs(level.values, 1, 0).slice(0, -1)) {
        expect([lo, hi]).toEqual([-128, 127]);
      }
    }
  });

  it('keeps channels apart and maps a burst to the points holding its samples', () => {
    // Left: silence with a burst at samples [1000, 1100). Right: a −6 dBFS sine throughout.
    const frames = 8192;
    const left = Array.from({ length: frames }, (_, i) => (i >= 1000 && i < 1100 ? 16384 : 0));
    const right = sine(frames, 16384, 64);
    const peaks = computePeaks(interleave(left, right), { channels: 2, sampleRate: 44_100 });
    const fine = peaks.levels[0];
    if (!fine) throw new Error('no level');
    const leftPoints = pairs(fine.values, 2, 0);
    const loud = leftPoints.flatMap(([, hi], p) => (hi > 0 ? [p] : []));
    expect(loud).toEqual([peaksPointOfSample(1000, 256), peaksPointOfSample(1099, 256)]);
    expect(loud).toEqual([3, 4]);
    expect(peaksPointSamples(3, 256, frames)).toEqual({ start: 768, end: 1024 });
    expect(leftPoints[3]).toEqual([0, 64]);
    for (const [lo, hi] of pairs(fine.values, 2, 1)) expect([lo, hi]).toEqual([-64, 64]);
  });

  it('round-trips through the peaks file format', () => {
    const peaks = computePeaks(interleave(sine(5000, 30_000, 300), sine(5000, -12_000, 77)), {
      channels: 2,
      sampleRate: 44_100,
    });
    const decoded = decodePeaks(encodePeaks(peaks));
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.lengthSamples).toBe(5000);
    expect(decoded.levels.map((l) => Array.from(l.values))).toEqual(
      peaks.levels.map((l) => Array.from(l.values)),
    );
  });
});
