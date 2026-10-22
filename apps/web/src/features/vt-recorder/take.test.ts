import { describe, expect, it } from 'vitest';
import { clampTrim, encodeWav, peakDb, suggestTrim, takePeaks, voiceStart } from './take.ts';

const RATE = 48_000;

/** `seconds` of silence with a 0.5 amplitude tone between `from` and `to` seconds. */
function tone(seconds: number, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  }
  return out;
}

describe('take', () => {
  it('suggests a trim from just before the first sound to just after the last', () => {
    const samples = tone(5, 1, 3);
    const trim = suggestTrim(samples, RATE);
    // 150 ms lead, 300 ms tail; the sine crosses the threshold a few samples in.
    expect(trim.from / RATE).toBeCloseTo(0.85, 2);
    expect(trim.to / RATE).toBeCloseTo(3.3, 2);
    // Silence is kept whole.
    expect(suggestTrim(new Float32Array(100), RATE)).toEqual({ from: 0, to: 100 });
  });

  it('keeps a trim inside the take, ordered and at least 10 ms long', () => {
    expect(clampTrim({ from: -5, to: 1e9 }, 1000, RATE)).toEqual({ from: 0, to: 1000 });
    expect(clampTrim({ from: 600, to: 500 }, 1000, RATE)).toEqual({ from: 520, to: 1000 });
    expect(clampTrim({ from: 990, to: 995 }, 1000, RATE)).toEqual({ from: 520, to: 1000 });
  });

  it('places the trimmed voice on the 44.1 kHz axis, from a take at another rate', () => {
    const take = { samples: new Float32Array(RATE * 4), sampleRate: RATE, axisStart: -441_000 };
    // 1 s trimmed off the head: the voice starts 1 s (44 100 axis samples) later.
    expect(voiceStart(take, { from: RATE, to: RATE * 3 })).toBe(-441_000 + 44_100);
    expect(voiceStart({ ...take, axisStart: null }, { from: RATE, to: RATE * 3 })).toBeNull();
  });

  it('measures the peak of the kept part', () => {
    const samples = tone(2, 0.5, 1);
    expect(peakDb(samples)).toBeCloseTo(-6.02, 1);
    expect(peakDb(samples, 0, RATE / 4)).toBe(-Infinity);
  });

  it('encodes the kept part as a mono 24-bit WAV', () => {
    const samples = new Float32Array([0, 1, -1, 0.5, 2, -0.25]);
    const wav = encodeWav(samples, RATE, { from: 1, to: 5 });
    const view = new DataView(wav.buffer);
    const text = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(4 * 3);
    expect(wav.length).toBe(44 + 12);
    const sample = (i: number) => {
      const at = 44 + i * 3;
      const n =
        (wav[at] as number) | ((wav[at + 1] as number) << 8) | ((wav[at + 2] as number) << 16);
      return n & 0x800000 ? n - 0x1000000 : n;
    };
    expect([sample(0), sample(1), sample(2), sample(3)]).toEqual([
      0x7fffff,
      -0x800000,
      Math.round(0.5 * 0x7fffff),
      // Clipped to full scale.
      0x7fffff,
    ]);
  });

  it('draws as library peaks', () => {
    const samples = tone(1, 0, 1);
    const peaks = takePeaks(samples, RATE);
    expect(peaks.channels).toBe(1);
    expect(peaks.lengthSamples).toBe(RATE);
    const [fine] = peaks.levels;
    expect(fine?.samplesPerPoint).toBe(256);
    expect(fine?.points).toBe(Math.ceil(RATE / 256));
    expect(fine?.values[1]).toBeGreaterThan(60);
    expect(fine?.values[0]).toBeLessThan(-60);
  });
});
