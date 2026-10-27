import { type DecodedPeaks, PEAKS_FORMAT_VERSION, PEAKS_LEVELS } from '@ondes/shared';

// A recorded take (#59), pure: the mono samples the microphone gave, at the context's rate,
// and where its first sample sits on the segue axis when it was recorded over a pre-roll.
// Trim, levels, waveform and the WAV file are computed here, so the page and the tests share
// them. Loudness is not touched: ingest measures the take and the playout gain brings it to
// the station's target, as for every asset (ADR 0025).

/** The segue axis rate (ADR 0017): positions and voice starts are in 44.1 kHz samples. */
export const AXIS_RATE = 44_100;

export interface Take {
  /** Mono, float, as captured. */
  samples: Float32Array;
  sampleRate: number;
  /**
   * Axis position (44.1 kHz samples, 0 = A's end) of `samples[0]`, latency compensated; null
   * for a take recorded without pre-roll (a standalone promo).
   */
  axisStart: number | null;
}

/** The kept part of a take, in take samples: `[from, to)`. */
export interface Trim {
  from: number;
  to: number;
}

const toDb = (amp: number) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);

/** Peak level of `samples[from, to)` in dBFS (−Infinity for silence). */
export function peakDb(samples: Float32Array, from = 0, to = samples.length): number {
  let peak = 0;
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i++) {
    const v = Math.abs(samples[i] as number);
    if (v > peak) peak = v;
  }
  return toDb(peak);
}

/** Above this the take is clipping (or about to): a calm warning, never a block. */
export const CLIP_DBFS = -0.5;
/** Below this peak the take is very quiet: the playout gain would raise its noise a lot. */
export const QUIET_DBFS = -30;

/**
 * The trim a take starts with: from just before the first sound to just after the last, the
 * sound being anything above `thresholdDb`. A take with no sound is kept whole.
 */
export function suggestTrim(
  samples: Float32Array,
  sampleRate: number,
  { thresholdDb = -45, leadMs = 150, tailMs = 300 } = {},
): Trim {
  const threshold = 10 ** (thresholdDb / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] as number) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { from: 0, to: samples.length };
  return {
    from: Math.max(0, first - Math.round((leadMs * sampleRate) / 1000)),
    to: Math.min(samples.length, last + 1 + Math.round((tailMs * sampleRate) / 1000)),
  };
}

/** Keeps a trim inside the take, at least 10 ms long, `from` before `to`. */
export function clampTrim(trim: Trim, length: number, sampleRate: number): Trim {
  const min = Math.min(length, Math.round(sampleRate / 100));
  const from = Math.max(0, Math.min(length - min, Math.round(trim.from)));
  const to = Math.max(from + min, Math.min(length, Math.round(trim.to)));
  return { from, to };
}

/** Where the trimmed voice starts on the segue axis, or null for a take without pre-roll. */
export function voiceStart(take: Take, trim: Trim): number | null {
  if (take.axisStart === null) return null;
  return take.axisStart + Math.round((trim.from * AXIS_RATE) / take.sampleRate);
}

/** The trimmed take's length on the segue axis (44.1 kHz samples). */
export function voiceLength(take: Pick<Take, 'sampleRate'>, trim: Trim): number {
  return Math.round(((trim.to - trim.from) * AXIS_RATE) / take.sampleRate);
}

/** Take samples → seconds. */
export const takeSeconds = (take: Pick<Take, 'sampleRate'>, n: number) => n / take.sampleRate;

/**
 * The take as waveform peaks, in the library's format (`@ondes/shared` peaks, min/max per
 * point as int8), so the cue editor's waveform draws it. Mono.
 */
export function takePeaks(samples: Float32Array, sampleRate: number): DecodedPeaks {
  const levels = PEAKS_LEVELS.map((samplesPerPoint) => {
    const points = Math.max(1, Math.ceil(samples.length / samplesPerPoint));
    const values = new Int8Array(points * 2);
    for (let p = 0; p < points; p++) {
      let lo = 0;
      let hi = 0;
      const end = Math.min(samples.length, (p + 1) * samplesPerPoint);
      for (let i = p * samplesPerPoint; i < end; i++) {
        const v = samples[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      values[p * 2] = Math.max(-128, Math.round(lo * 127));
      values[p * 2 + 1] = Math.min(127, Math.round(hi * 127));
    }
    return { samplesPerPoint, points, values, dat: new Uint8Array(0) };
  });
  return {
    formatVersion: PEAKS_FORMAT_VERSION,
    sampleRate,
    channels: 1,
    lengthSamples: samples.length,
    levels,
  };
}

/**
 * `samples[from, to)` as a mono 24-bit PCM WAV file. Lossless, so ingest measures and
 * transcodes the take as it was recorded; 24 bits keep a quiet take's detail when the playout
 * gain raises it.
 */
export function encodeWav(samples: Float32Array, sampleRate: number, trim?: Trim): Uint8Array {
  const from = trim?.from ?? 0;
  const to = trim?.to ?? samples.length;
  const frames = Math.max(0, to - from);
  const bytesPerSample = 3;
  const dataBytes = frames * bytesPerSample;
  // RIFF chunks are word-aligned: an odd-sized data chunk is followed by a pad byte, which the
  // RIFF size counts (the data chunk's own size doesn't).
  const pad = dataBytes % 2;
  const out = new Uint8Array(44 + dataBytes + pad);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes + pad, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 24, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  const MAX = 0x7fffff;
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, samples[from + i] as number));
    const n = Math.round(v < 0 ? v * (MAX + 1) : v * MAX);
    const at = 44 + i * bytesPerSample;
    out[at] = n & 0xff;
    out[at + 1] = (n >> 8) & 0xff;
    out[at + 2] = (n >> 16) & 0xff;
  }
  return out;
}
