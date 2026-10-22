import type { IslandSource, IslandSpec } from '../contracts/segues.ts';
import { fillSourceGain } from './gain.ts';

// The island mix (#56, ADR 0018): pure, no I/O or platform APIs, so the worker's renderer, the
// splice test and (if it wants a sample-exact buffer) the editor all mix the same way. Every source's samples `[from, to)` placed at
// `at`, scaled per sample by the shared gain model (`fillSourceGain`: static gain as
// `liq_amplify` applies it, times the product of its envelopes), summed in float64, then
// quantised to the output's 24 bits. No micro-crossfade: the engine butt-splices the island
// against the bodies, and the 10 ms handles at both ends are plain A and plain B (spike #12).

/** Decoded PCM of one source's range: one array per channel (1 or 2), in [-1, 1). */
export type SourcePcm = Float32Array[];

/** 24-bit full scale. */
const FULL_SCALE = 2 ** 23;

export type Mix = {
  /** Interleaved stereo, 24-bit values (−2^23 … 2^23 − 1). */
  samples: Int32Array;
  /** Samples that went over full scale and were clipped (both channels counted). */
  clipped: number;
  /** The float mix before quantisation, one array per channel (tests compare against it). */
  float: [Float64Array, Float64Array];
};

/**
 * Mixes `spec`. `pcm[i]` holds source `i`'s samples `[from, to)` (fewer when the file ended
 * early: the rest is silence). Mono sources play on both channels, as the engine plays them.
 */
export function mixIsland(spec: IslandSpec, pcm: readonly SourcePcm[]): Mix {
  const length = spec.lengthSamples;
  const left = new Float64Array(length);
  const right = new Float64Array(length);
  spec.sources.forEach((source, i) => {
    const channels = pcm[i];
    if (!channels?.length) throw new Error(`mixIsland: no PCM for source ${i}`);
    addSource(source, channels, left, right);
  });
  const samples = new Int32Array(length * 2);
  let clipped = 0;
  for (let n = 0; n < length; n++) {
    const l = quantise(left[n] as number);
    const r = quantise(right[n] as number);
    clipped += l.clipped + r.clipped;
    samples[2 * n] = l.value;
    samples[2 * n + 1] = r.value;
  }
  return { samples, clipped, float: [left, right] };
}

function addSource(
  source: IslandSource,
  channels: SourcePcm,
  left: Float64Array,
  right: Float64Array,
) {
  const l = channels[0] as Float32Array;
  const r = (channels[1] ?? l) as Float32Array;
  // Island positions this source covers, clipped to the island and to the decoded samples.
  const start = Math.max(0, source.at);
  const end = Math.min(left.length, source.at + source.to - source.from, source.at + l.length);
  if (end <= start) return;
  const gain = fillSourceGain(source, start, new Float64Array(end - start));
  for (let n = start; n < end; n++) {
    const g = gain[n - start] as number;
    const k = n - source.at;
    left[n] = (left[n] as number) + (l[k] as number) * g;
    right[n] = (right[n] as number) + (r[k] as number) * g;
  }
}

function quantise(x: number): { value: number; clipped: number } {
  const v = Math.round(x * FULL_SCALE);
  if (v > FULL_SCALE - 1) return { value: FULL_SCALE - 1, clipped: 1 };
  if (v < -FULL_SCALE) return { value: -FULL_SCALE, clipped: 1 };
  return { value: v, clipped: 0 };
}
