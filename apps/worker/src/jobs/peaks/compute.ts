import { PEAKS_LEVELS, type Peaks, type PeaksLevel, peaksPointCount } from '@ondes/shared';

// Peak maths (#22), pure. The decoder streams interleaved 16-bit samples into a
// `PeaksAccumulator`, which keeps the min and max of each point of the finest level, per
// channel. Coarser levels are reduced from it (min of mins, max of maxes), which is exact since
// their point size is a multiple of the finest one. Values are quantised to 8 bits last
// (`>> 8`, which is monotonic, so quantising before or after the reduction is the same).

const INT16_MIN = -32768;
const INT16_MAX = 32767;
/** About 1 h 40 of audio at 256 samples per point (8 MB of stereo values). */
const MAX_PRESIZED_POINTS = 1 << 20;

/** Streams interleaved 16-bit samples into min/max points of `samplesPerPoint` samples. */
export class PeaksAccumulator {
  readonly channels: number;
  readonly samplesPerPoint: number;
  /** Samples per channel pushed so far. */
  lengthSamples = 0;
  private values: Int16Array;
  private points = 0;
  /** Samples (per channel) in the current, unfinished point. */
  private filled = 0;
  private readonly min: Int16Array;
  private readonly max: Int16Array;

  /** `expectedSamples` sizes the buffer up front (it grows if the file is longer). */
  constructor(channels: number, samplesPerPoint: number, expectedSamples = 0) {
    if (!Number.isInteger(channels) || channels < 1) throw new Error(`bad channels ${channels}`);
    if (!Number.isInteger(samplesPerPoint) || samplesPerPoint < 1) {
      throw new Error(`bad samples per point ${samplesPerPoint}`);
    }
    this.channels = channels;
    this.samplesPerPoint = samplesPerPoint;
    // Capped: the hint may come from a corrupt header; the buffer grows past it anyway.
    const points = Math.min(
      MAX_PRESIZED_POINTS,
      Math.max(16, peaksPointCount(expectedSamples, samplesPerPoint)),
    );
    this.values = new Int16Array(points * channels * 2);
    this.min = new Int16Array(channels).fill(INT16_MAX);
    this.max = new Int16Array(channels).fill(INT16_MIN);
  }

  /** Adds frames of interleaved samples; `samples.length` must be a multiple of `channels`. */
  push(samples: Int16Array): void {
    const { channels, samplesPerPoint, min, max } = this;
    if (samples.length % channels !== 0) throw new Error('partial frame');
    const frames = samples.length / channels;
    let frame = 0;
    while (frame < frames) {
      const take = Math.min(samplesPerPoint - this.filled, frames - frame);
      for (let ch = 0; ch < channels; ch++) {
        let lo = min[ch] as number;
        let hi = max[ch] as number;
        const end = (frame + take) * channels + ch;
        for (let i = frame * channels + ch; i < end; i += channels) {
          const v = samples[i] as number;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        min[ch] = lo;
        max[ch] = hi;
      }
      frame += take;
      this.filled += take;
      this.lengthSamples += take;
      if (this.filled === samplesPerPoint) this.closePoint();
    }
  }

  /** The finest level's values (16-bit), the last partial point included. */
  finish(): { lengthSamples: number; points: number; values: Int16Array } {
    if (this.filled > 0) this.closePoint();
    const values = this.values.slice(0, this.points * this.channels * 2);
    return { lengthSamples: this.lengthSamples, points: this.points, values };
  }

  private closePoint(): void {
    const { channels } = this;
    const at = this.points * channels * 2;
    if (at + channels * 2 > this.values.length) {
      const grown = new Int16Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    for (let ch = 0; ch < channels; ch++) {
      this.values[at + ch * 2] = this.min[ch] as number;
      this.values[at + ch * 2 + 1] = this.max[ch] as number;
    }
    this.min.fill(INT16_MAX);
    this.max.fill(INT16_MIN);
    this.filled = 0;
    this.points++;
  }
}

/** Merges every `factor` points into one (min of mins, max of maxes), per channel. */
export function reducePeaks(values: Int16Array, channels: number, factor: number): Int16Array {
  const width = channels * 2;
  const points = values.length / width;
  const outPoints = Math.ceil(points / factor);
  const out = new Int16Array(outPoints * width);
  for (let p = 0; p < outPoints; p++) {
    const from = p * factor;
    const to = Math.min(from + factor, points);
    for (let ch = 0; ch < channels; ch++) {
      let lo = INT16_MAX;
      let hi = INT16_MIN;
      for (let q = from; q < to; q++) {
        const lowValue = values[q * width + ch * 2] as number;
        const highValue = values[q * width + ch * 2 + 1] as number;
        if (lowValue < lo) lo = lowValue;
        if (highValue > hi) hi = highValue;
      }
      out[p * width + ch * 2] = lo;
      out[p * width + ch * 2 + 1] = hi;
    }
  }
  return out;
}

/** 16-bit to 8-bit values: `v >> 8` (floored), like audiowaveform's `-b 8`. */
export function toInt8(values: Int16Array): Int8Array {
  const out = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = (values[i] as number) >> 8;
  return out;
}

/**
 * Builds every level from an accumulator of the finest one. Each level's samples per point
 * must be a multiple of the accumulator's.
 */
export function finishPeaks(
  accumulator: PeaksAccumulator,
  sampleRate: number,
  levels: readonly number[] = PEAKS_LEVELS,
): Omit<Peaks, 'formatVersion'> {
  const { channels, samplesPerPoint } = accumulator;
  const finest = accumulator.finish();
  const built: PeaksLevel[] = levels.map((spp) => {
    if (spp % samplesPerPoint !== 0) {
      throw new Error(`level ${spp} is not a multiple of ${samplesPerPoint}`);
    }
    const values =
      spp === samplesPerPoint
        ? finest.values
        : reducePeaks(finest.values, channels, spp / samplesPerPoint);
    return {
      samplesPerPoint: spp,
      points: peaksPointCount(finest.lengthSamples, spp),
      values: toInt8(values),
    };
  });
  return { sampleRate, channels, lengthSamples: finest.lengthSamples, levels: built };
}

/** Peaks of a whole signal in memory (tests, small files). */
export function computePeaks(
  samples: Int16Array,
  options: { channels: number; sampleRate: number; levels?: readonly number[] },
): Omit<Peaks, 'formatVersion'> {
  const levels = options.levels ?? PEAKS_LEVELS;
  const accumulator = new PeaksAccumulator(options.channels, Math.min(...levels));
  accumulator.push(samples);
  return finishPeaks(accumulator, options.sampleRate, levels);
}
