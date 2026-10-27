import { PLAYOUT_SAMPLE_RATE } from '../contracts/library.ts';
import { PROMO_MAX_LEAD_MS } from '../contracts/promos.ts';
import type { SegueInLane, SegueOutLane, SegueVoiceLane } from '../contracts/segues.ts';
import { autoPlacement, DEFAULT_DUCK, type DuckPreset, type PlacementMedia } from './placement.ts';

// Default lanes for a promo over a transition (#60, ADR 0032): where the generator puts a promo
// between two songs, from their cue markers, and the ducking under it. The placement itself is
// the smart default of #61 (`autoPlacement`, ADR 0037), bounded to the promo's air window. The
// segue editor (#58) edits the result like any segue.
//
// Positions are samples on the segue axis (ADR 0017): 0 is A's end, negative before it.

export interface PromoLanes {
  out: SegueOutLane;
  in: SegueInLane;
  voices: SegueVoiceLane[];
}

const samplesOfMs = (ms: number) => Math.round((ms * PLAYOUT_SAMPLE_RATE) / 1000);

/**
 * The default segue for a promo between A and B: {@link autoPlacement} ("hitting the post": over
 * A's outro and B's intro, B never before its natural start, delayed by a long voice, ducked),
 * with the voice starting within {@link PROMO_MAX_LEAD_MS} of A's end either way: the window
 * the validity checks assume before the segue exists (ADR 0032). No bed: a promo is short.
 */
export function defaultPromoLanes(
  a: PlacementMedia,
  b: PlacementMedia,
  voice: { assetId: string; cueIn: number; cueOut: number },
  preset: DuckPreset = DEFAULT_DUCK,
): PromoLanes {
  return autoPlacement(a, b, [voice], { duck: preset, maxLead: samplesOfMs(PROMO_MAX_LEAD_MS) })
    .lanes;
}
