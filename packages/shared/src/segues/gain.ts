import { ENVELOPE_SILENCE_DB, type Envelope, type EnvelopePoint } from '../contracts/segues.ts';

// The gain model of segues and islands (#55, #56, ADR 0017), shared by the island renderer
// (worker), the segue editor's WebAudio preview (#58) and anything else that has to hear what
// airs. Pure, no platform APIs. One model, two ways to evaluate it:
//
// - per sample (the renderer): `sourceGainAt` / `fillSourceGain`;
// - as AudioParam automation (the preview): `envelopeAutomation`, one GainNode per envelope
//   driven by `setValueAtTime` + `linearRampToValueAtTime`, chained after a GainNode at
//   `dbToAmplitude(gainDb)`. A linear ramp is exactly the interpolation below, so the two
//   agree to float32 rounding (`gain.test.ts` checks it against the Web Audio spec's formula).
//
// Gains are linear amplitude factors. A source's static gain is the playout gain the engine
// applies as `liq_amplify` (10^(dB/20) per sample, spike #12) plus the lane's own trim.

/** dB → linear amplitude, as `liq_amplify` does; at or below −90 dB it is exactly 0. */
export const dbToAmplitude = (db: number) => (db <= ENVELOPE_SILENCE_DB ? 0 : 10 ** (db / 20));

/**
 * The envelope's gain at `at`, as a linear amplitude factor: linear interpolation in amplitude
 * between points, holding before the first and after the last; 1 when empty. The renderer
 * multiplies each sample by this (and by every other envelope of the source).
 */
export function envelopeGainAt(points: Envelope, at: number): number {
  const first = points[0];
  if (!first) return 1;
  if (at <= first.at) return dbToAmplitude(first.gainDb);
  for (let i = 1; i < points.length; i++) {
    const b = points[i] as EnvelopePoint;
    if (at <= b.at) {
      const a = points[i - 1] as EnvelopePoint;
      return lerp(a, b, at);
    }
  }
  return dbToAmplitude((points[points.length - 1] as EnvelopePoint).gainDb);
}

/** The one interpolation formula: {@link envelopeGainAt} and {@link fillSourceGain} share it. */
function lerp(a: EnvelopePoint, b: EnvelopePoint, at: number): number {
  const ga = dbToAmplitude(a.gainDb);
  const gb = dbToAmplitude(b.gainDb);
  return ga + ((gb - ga) * (at - a.at)) / (b.at - a.at);
}

/** What decides a source's gain: an island source (`IslandSource`) or an editor lane. */
export type GainSource = { gainDb: number; envelopes: readonly Envelope[] };

/**
 * A source's gain at position `at` (same axis as its envelopes): its static gain times the
 * product of its envelopes, in that order.
 */
export function sourceGainAt(source: GainSource, at: number): number {
  let g = dbToAmplitude(source.gainDb);
  for (const e of source.envelopes) g *= envelopeGainAt(e, at);
  return g;
}

/**
 * Fills `out[i]` with `sourceGainAt(source, start + i)`, bit for bit, in one pass per envelope
 * instead of a search per sample. The renderer's hot loop.
 */
export function fillSourceGain(source: GainSource, start: number, out: Float64Array): Float64Array {
  out.fill(dbToAmplitude(source.gainDb));
  for (const points of source.envelopes) {
    const first = points[0];
    if (!first) continue;
    const last = points[points.length - 1] as EnvelopePoint;
    const before = dbToAmplitude(first.gainDb);
    const after = dbToAmplitude(last.gainDb);
    let seg = 1;
    for (let i = 0; i < out.length; i++) {
      const at = start + i;
      let g: number;
      if (at <= first.at) g = before;
      else {
        while (seg < points.length && at > (points[seg] as EnvelopePoint).at) seg++;
        g =
          seg < points.length
            ? lerp(points[seg - 1] as EnvelopePoint, points[seg] as EnvelopePoint, at)
            : after;
      }
      out[i] = (out[i] as number) * g;
    }
  }
  return out;
}

/**
 * One AudioParam automation step, positions in samples on the envelope's axis: `ramp: false`
 * is `setValueAtTime(value, t(at))`, `ramp: true` is `linearRampToValueAtTime(value, t(at))`.
 */
export type GainAutomationEvent = { at: number; value: number; ramp: boolean };

/**
 * The envelope as AudioParam automation: a set at the first point, then a linear ramp to each
 * next one; the param holds after the last. Empty envelope: no events (leave the param at 1).
 * The caller maps `at` to context time. Web Audio refuses negative times and can't schedule
 * into the past, so to start playback at axis position `p`, clip first:
 * `envelopeAutomation(clipEnvelope(points, -p, length))` gives events from 0, holding the gain
 * the envelope has at `p`. Before the first event a param plays its `value`: set it to the
 * first event's value too.
 */
export function envelopeAutomation(points: Envelope): GainAutomationEvent[] {
  return points.map((p, i) => ({ at: p.at, value: dbToAmplitude(p.gainDb), ramp: i > 0 }));
}
