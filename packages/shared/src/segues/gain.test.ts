import { describe, expect, it } from 'vitest';
import type { Envelope } from '../contracts/segues.ts';
import {
  dbToAmplitude,
  envelopeAutomation,
  envelopeGainAt,
  fillSourceGain,
  type GainAutomationEvent,
  sourceGainAt,
} from './gain.ts';
import { clipEnvelope } from './island.ts';

const duck: Envelope = [
  { at: 1000, gainDb: 0 },
  { at: 14_230, gainDb: -12 },
  { at: 60_001, gainDb: -12 },
  { at: 86_461, gainDb: -90 },
];
const rise: Envelope = [
  { at: -5000, gainDb: -90 },
  { at: 21_000, gainDb: 0 },
];
const source = { gainDb: -3.5, envelopes: [duck, rise] };

/**
 * An AudioParam's value at sample frame `k` of an OfflineAudioContext, per the Web Audio spec
 * (§ "Computation of value"): `setValueAtTime` holds from its time, `linearRampToValueAtTime`
 * interpolates from the previous event `v0 + (v1 − v0)·(t − t0)/(t1 − t0)`, then holds.
 * Values are float32, as AudioParam computes them. Node has no Web Audio, so this stands in
 * for the editor's preview path.
 */
function audioParamAt(events: GainAutomationEvent[], k: number, initial = 1): number {
  const f = Math.fround;
  let value = f(initial);
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

describe('gain model', () => {
  it('converts dB like liq_amplify, with −90 dB exactly silent', () => {
    expect(dbToAmplitude(0)).toBe(1);
    expect(dbToAmplitude(-6)).toBeCloseTo(0.501187, 6);
    expect(dbToAmplitude(-90)).toBe(0);
    expect(dbToAmplitude(-120)).toBe(0);
  });

  it('multiplies the static gain by every envelope', () => {
    for (const at of [-10_000, 0, 1000, 5000, 14_230, 30_000, 70_000, 90_000]) {
      expect(sourceGainAt(source, at)).toBe(
        dbToAmplitude(-3.5) * envelopeGainAt(duck, at) * envelopeGainAt(rise, at),
      );
    }
    expect(sourceGainAt({ gainDb: 0, envelopes: [] }, 5)).toBe(1);
  });

  it('fills a block bit for bit like the per-sample function', () => {
    const start = -6000;
    const out = fillSourceGain(source, start, new Float64Array(100_000));
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== sourceGainAt(source, start + i)) {
        throw new Error(`sample ${start + i}: ${out[i]} ≠ ${sourceGainAt(source, start + i)}`);
      }
    }
    // A block starting mid-envelope too.
    const mid = fillSourceGain(source, 50_000, new Float64Array(10));
    expect([...mid]).toEqual(
      Array.from({ length: 10 }, (_, i) => sourceGainAt(source, 50_000 + i)),
    );
  });

  // Tolerance of the preview path: AudioParam computes in float32, so its gain is the
  // renderer's within float32 rounding: a relative error under 2^-21 (≈ −126 dB), far under
  // the 24-bit output's own quantisation (−144 dBFS). Checked on every sample of the envelope.
  it('matches Web Audio automation of the same envelope within float32 rounding', () => {
    const events = envelopeAutomation(duck);
    expect(events[0]).toEqual({ at: 1000, value: 1, ramp: false });
    expect(events.slice(1).every((e) => e.ramp)).toBe(true);
    let worst = 0;
    for (let k = 0; k < 100_000; k++) {
      const want = envelopeGainAt(duck, k);
      const got = audioParamAt(events, k);
      worst = Math.max(worst, Math.abs(got - want));
    }
    expect(worst).toBeLessThan(2 ** -21);
  });

  it('starts a preview mid-envelope through clipEnvelope', () => {
    const p = 40_000;
    const events = envelopeAutomation(clipEnvelope(duck, -p, 60_000));
    expect(events[0]?.at).toBe(0);
    for (let k = 0; k < 60_000; k += 7) {
      expect(
        Math.abs(audioParamAt(events, k, events[0]?.value) - envelopeGainAt(duck, p + k)),
      ).toBeLessThan(2 ** -21);
    }
  });

  it('chained gain nodes (static × envelopes) give the source gain', () => {
    const chains = source.envelopes.map(envelopeAutomation);
    let worst = 0;
    for (let k = -6000; k < 100_000; k += 3) {
      let g = Math.fround(dbToAmplitude(source.gainDb));
      for (const ev of chains) g = Math.fround(g * audioParamAt(ev, k, ev[0]?.value));
      worst = Math.max(worst, Math.abs(g - sourceGainAt(source, k)));
    }
    expect(worst).toBeLessThan(2 ** -20);
  });
});
