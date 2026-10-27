import { PLAYOUT_SAMPLE_RATE } from '../contracts/library.ts';
import { PROMO_MAX_LEAD_MS } from '../contracts/promos.ts';
import {
  type Envelope,
  SEGUE_MAX_OFFSET_SAMPLES,
  type SegueInLane,
  type SegueOutLane,
  type SegueVoiceLane,
} from '../contracts/segues.ts';

// Default lanes for a voice over a transition (#60, ADR 0032): where the generator puts a promo
// between two songs, from their cue markers, and the ducking under it. Deterministic, markers
// only. The segue editor (#58) edits the result like any segue; #61 refines the placement.
//
// Positions are samples on the segue axis (ADR 0017): 0 is A's end, negative before it.

/** Ducking under a voice: A and B `depthDb` under it, ramps of `rampMs`. */
export interface DuckPreset {
  depthDb: number;
  rampMs: number;
}

/** The owner's default: 8 dB under the voice, 300 ms ramps (the segue editor's first preset). */
export const DEFAULT_DUCK: DuckPreset = { depthDb: -8, rampMs: 300 };

const samplesOfMs = (ms: number) => Math.round((ms * PLAYOUT_SAMPLE_RATE) / 1000);

/**
 * A's and B's envelopes ducking under voices that play over `[start, end)`. Both ramp down to
 * `depthDb` over `rampMs`, ending where the voices start, and hold there; B ramps back to 0 dB
 * over `rampMs` once they end (A has ended by then, or plays on ducked). So B starting before the
 * voices plays at full level until they come in, and one starting under them comes in ducked.
 * A gets no envelope when the voices start after its end, B none when they end before it starts.
 */
export function duckEnvelopes(
  span: { start: number; end: number },
  inStart: number,
  preset: DuckPreset = DEFAULT_DUCK,
): { out: Envelope; in: Envelope } {
  const ramp = samplesOfMs(preset.rampMs);
  return {
    out:
      span.start < 0
        ? [
            { at: span.start - ramp, gainDb: 0 },
            { at: span.start, gainDb: preset.depthDb },
          ]
        : [],
    in:
      span.end > inStart
        ? [
            ...(span.start > inStart
              ? [
                  { at: span.start - ramp, gainDb: 0 },
                  { at: span.start, gainDb: preset.depthDb },
                ]
              : []),
            { at: span.end, gainDb: preset.depthDb },
            { at: span.end + ramp, gainDb: 0 },
          ]
        : [],
  };
}

/**
 * A lane's audio for placement: its effective cues (samples in the file, as `segueMedia`
 * resolves them) and the markers that matter, null when unset or outside the cues.
 */
export interface PlacementMedia {
  cueIn: number;
  cueOut: number;
  /** A only: where its outro (the instrumental end) starts. */
  outroStart?: number | null;
  /** A only: where B starts by default (the natural crossfade). */
  crossStartNext?: number | null;
  /** B only: where its intro (the instrumental start) ends. */
  introEnd?: number | null;
}

export interface PromoLanes {
  out: SegueOutLane;
  in: SegueInLane;
  voices: SegueVoiceLane[];
}

const inside = (at: number | null | undefined, m: PlacementMedia): at is number =>
  typeof at === 'number' && at > m.cueIn && at < m.cueOut;

const clamp = (at: number) =>
  Math.max(-SEGUE_MAX_OFFSET_SAMPLES, Math.min(SEGUE_MAX_OFFSET_SAMPLES, Math.round(at)));

/**
 * The default segue for a voice between A and B ("hitting the post"):
 * 1. B's natural start is A's `crossStartNext` (0, A's end, without it).
 * 2. The voice starts with A's outro (`outroStart`), or at B's natural start if that is earlier;
 *    without an outro marker, at B's natural start.
 * 3. B starts so that its intro (`introEnd`) ends with the voice: the voice talks over A's
 *    outro and B's intro and B's vocals come in as it ends. Without an intro marker, B starts as
 *    the voice ends.
 * 4. B never starts before its natural start: a short voice moves later instead, so it still
 *    ends at B's intro end. A long one delays B (a pause in the music under the voice).
 * 5. A and B duck under the voice ({@link DEFAULT_DUCK}).
 * The voice never starts before A does, and starts within {@link PROMO_MAX_LEAD_MS} of A's end
 * either way: the window the validity checks assume before the segue exists (ADR 0032). A voice
 * whose outro or intro would place it further keeps to that bound.
 */
export function defaultPromoLanes(
  a: PlacementMedia,
  b: PlacementMedia,
  voice: { assetId: string; cueIn: number; cueOut: number },
  preset: DuckPreset = DEFAULT_DUCK,
): PromoLanes {
  const aStart = a.cueIn - a.cueOut;
  const natural = inside(a.crossStartNext, a) ? a.crossStartNext - a.cueOut : 0;
  const outro = inside(a.outroStart, a) ? a.outroStart - a.cueOut : null;
  const intro = inside(b.introEnd, b) ? b.introEnd - b.cueIn : 0;
  const length = voice.cueOut - voice.cueIn;
  const lead = samplesOfMs(PROMO_MAX_LEAD_MS);
  const bounded = (at: number) => Math.max(aStart, -lead, Math.min(lead, at));

  let start = bounded(outro === null ? natural : Math.min(outro, natural));
  let inStart = start + length - intro;
  if (inStart < natural) {
    inStart = natural;
    start = bounded(inStart + intro - length);
  }
  start = clamp(start);
  inStart = clamp(inStart);
  const ducks = duckEnvelopes({ start, end: start + length }, inStart, preset);
  return {
    out: { envelope: ducks.out.map((p) => ({ ...p, at: clamp(p.at) })) },
    in: { start: inStart, envelope: ducks.in.map((p) => ({ ...p, at: clamp(p.at) })) },
    voices: [{ assetId: voice.assetId, start, gainDb: 0, envelope: [] }],
  };
}
