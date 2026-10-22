import { describe, expect, it } from 'vitest';
import {
  ISLAND_FORMAT,
  ISLAND_SPEC_VERSION,
  type IslandSource,
  type IslandSpec,
} from '../contracts/segues.ts';
import { dbToAmplitude, envelopeAutomation, type GainAutomationEvent } from './gain.ts';
import { mixIsland, type SourcePcm } from './mix.ts';

// Null test of the island mix against an independent reference: the editor's preview path
// (#58), i.e. what an OfflineAudioContext computes for the same lanes. Node has no Web Audio,
// so the reference evaluates the AudioParam automation of `envelopeAutomation` with the Web
// Audio spec's formula in float32 (as AudioParam does), one GainNode per envelope chained
// after a static GainNode, summed in float32 like the graph's mixer.
//
// Tolerance (documented in ADR 0018): the render quantises to 24 bits (±½ LSB = 2^-24) and the
// preview computes gains in float32 (relative error < 2^-20 for a chain of gains). So every
// sample of the render is within 2^-24 + 2^-20 of the preview, and the residual is more than
// 120 dB under the signal.

const sha = (c: string) => c.repeat(64);
const f = Math.fround;

/** An AudioParam's value at frame k (Web Audio spec, "Computation of value"), float32. */
function paramAt(events: GainAutomationEvent[], k: number): number {
  let value = f(events[0]?.value ?? 1);
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as GainAutomationEvent;
    if (k < e.at) {
      if (e.ramp && i > 0) {
        const p = events[i - 1] as GainAutomationEvent;
        return f(f(p.value) + (f(e.value) - f(p.value)) * ((k - p.at) / (e.at - p.at)));
      }
      return value;
    }
    value = f(e.value);
  }
  return value;
}

/** The preview: AudioBufferSourceNode at `at` → GainNode(static) → GainNode per envelope. */
function preview(spec: IslandSpec, pcm: SourcePcm[]): [Float32Array, Float32Array] {
  const out: [Float32Array, Float32Array] = [
    new Float32Array(spec.lengthSamples),
    new Float32Array(spec.lengthSamples),
  ];
  spec.sources.forEach((s, i) => {
    const chans = pcm[i] as SourcePcm;
    const autos = s.envelopes.map(envelopeAutomation);
    const g0 = f(dbToAmplitude(s.gainDb));
    for (let k = Math.max(0, s.at); k < spec.lengthSamples; k++) {
      const j = k - s.at;
      if (j >= s.to - s.from || j >= (chans[0] as Float32Array).length) break;
      let g = g0;
      for (const a of autos) g = f(g * paramAt(a, k));
      for (let c = 0; c < 2; c++) {
        const x = (chans[c] ?? chans[0]) as Float32Array;
        const o = out[c] as Float32Array;
        o[k] = f((o[k] as number) + f((x[j] as number) * g));
      }
    }
  });
  return out;
}

function noise(n: number, seed: number, amp = 0.3): Float32Array {
  let x = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = (x * 1_103_515_245 + 12_345) % 2 ** 31;
    // 24-bit values, like a decoded playout copy.
    out[i] = Math.round(((x / 2 ** 31) * 2 - 1) * amp * 2 ** 23) / 2 ** 23;
  }
  return out;
}

const spec = (length: number, sources: IslandSource[]): IslandSpec => ({
  version: ISLAND_SPEC_VERSION,
  format: ISLAND_FORMAT,
  lengthSamples: length,
  sources,
});

// A voice-track island: A ducked then faded, a mono VT, B rising from silence.
const L = 3 * 44_100;
const vtSpec = spec(L, [
  {
    sha256: sha('a'),
    from: 529_417,
    to: 529_417 + 2 * 44_100,
    at: 0,
    gainDb: -3.5,
    envelopes: [
      [
        { at: 441, gainDb: 0 },
        { at: 13_230, gainDb: -12 },
        { at: 70_000, gainDb: -12 },
        { at: 88_200, gainDb: -90 },
      ],
    ],
  },
  { sha256: sha('b'), from: 0, to: 70_000, at: 22_050, gainDb: 1.25, envelopes: [] },
  {
    sha256: sha('c'),
    from: 89_088,
    to: 89_088 + 2 * 44_100,
    at: L - 2 * 44_100,
    gainDb: -1.5,
    envelopes: [
      [
        { at: L - 2 * 44_100, gainDb: -90 },
        { at: L - 44_100, gainDb: 0 },
      ],
    ],
  },
]);
const vtPcm: SourcePcm[] = [
  [noise(2 * 44_100, 1), noise(2 * 44_100, 2)],
  [noise(70_000, 3, 0.5)],
  [noise(2 * 44_100, 4), noise(2 * 44_100, 5)],
];

describe('mixIsland', () => {
  it('nulls against the Web Audio preview of the same spec within tolerance', () => {
    const mix = mixIsland(vtSpec, vtPcm);
    const ref = preview(vtSpec, vtPcm);
    expect(mix.clipped).toBe(0);
    let worst = 0;
    let residual = 0;
    let signal = 0;
    for (let n = 0; n < L; n++) {
      for (let c = 0; c < 2; c++) {
        const got = (mix.samples[2 * n + c] as number) / 2 ** 23;
        const want = (ref[c] as Float32Array)[n] as number;
        worst = Math.max(worst, Math.abs(got - want));
        residual += (got - want) ** 2;
        signal += want ** 2;
      }
    }
    expect(worst).toBeLessThan(2 ** -24 + 2 ** -20);
    expect(10 * Math.log10(residual / signal)).toBeLessThan(-120);
  });

  it('keeps the handles bit-exact: the first and last samples are plain A and plain B', () => {
    const mix = mixIsland(vtSpec, vtPcm);
    const gA = dbToAmplitude(-3.5);
    const gB = dbToAmplitude(-1.5);
    const a = vtPcm[0] as SourcePcm;
    const b = vtPcm[2] as SourcePcm;
    for (let n = 0; n < 441; n++) {
      expect(mix.samples[2 * n]).toBe(
        Math.round(((a[0] as Float32Array)[n] as number) * gA * 2 ** 23),
      );
    }
    for (let n = L - 441; n < L; n++) {
      const j = n - (L - 2 * 44_100);
      expect(mix.samples[2 * n + 1]).toBe(
        Math.round(((b[1] as Float32Array)[j] as number) * gB * 2 ** 23),
      );
    }
  });

  it('plays a mono source on both channels at its place, and silence elsewhere', () => {
    const s = spec(1000, [
      { sha256: sha('d'), from: 5, to: 105, at: 300, gainDb: 0, envelopes: [] },
    ]);
    const mono = new Float32Array(100).fill(0.25);
    const { samples } = mixIsland(s, [[mono]]);
    expect(samples[2 * 299]).toBe(0);
    expect(samples[2 * 300]).toBe(0.25 * 2 ** 23);
    expect(samples[2 * 300 + 1]).toBe(0.25 * 2 ** 23);
    expect(samples[2 * 399 + 1]).toBe(0.25 * 2 ** 23);
    expect(samples[2 * 400]).toBe(0);
  });

  it('treats a short decode as silence and stays within the island', () => {
    const s = spec(100, [{ sha256: sha('d'), from: 0, to: 500, at: 50, gainDb: 0, envelopes: [] }]);
    const { samples } = mixIsland(s, [[new Float32Array(20).fill(0.5)]]);
    expect(samples[2 * 69]).toBe(0.5 * 2 ** 23);
    expect(samples[2 * 70]).toBe(0);
    expect(samples.length).toBe(200);
  });

  it('clips at 24-bit full scale and counts it', () => {
    const s = spec(4, [{ sha256: sha('d'), from: 0, to: 4, at: 0, gainDb: 6, envelopes: [] }]);
    const { samples, clipped } = mixIsland(s, [[Float32Array.of(0.9, -0.9, 0.1, 0)]]);
    expect([...samples.slice(0, 4)]).toEqual([2 ** 23 - 1, 2 ** 23 - 1, -(2 ** 23), -(2 ** 23)]);
    expect(clipped).toBe(4);
  });
});
