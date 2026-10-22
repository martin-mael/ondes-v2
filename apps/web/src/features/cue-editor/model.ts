import {
  type AssetCues,
  CUE_FIELDS,
  type CueField,
  type CuePoint,
  type UpdateCues,
} from '@ondes/shared';

// The cue editor's model (#24), pure: a draft of an asset's cue points, the markers it shows,
// how a dragged marker is kept in order, and the `PUT …/cues` body of a save.
//
// Positions are samples at the cue row's sample rate (the playout copy's, the peaks' too).
// `fadeIn`/`fadeOut` are durations, not positions: shown as regions from cue-in and up to
// cue-out, moving with them, and not dragged here.

/** The points with a marker on the waveform, in the order they're listed. */
export const MARKER_FIELDS = [
  'cueIn',
  'introEnd',
  'outroStart',
  'crossStartNext',
  'cueOut',
] as const satisfies readonly CueField[];
export type MarkerField = (typeof MARKER_FIELDS)[number];

export const isMarkerField = (field: string): field is MarkerField =>
  (MARKER_FIELDS as readonly string[]).includes(field);

/** Marker colours: plain colours that read on the light and the dark theme. */
export const MARKER_COLORS: Record<MarkerField, string> = {
  cueIn: '#16a34a',
  introEnd: '#0891b2',
  outroStart: '#d97706',
  crossStartNext: '#7c3aed',
  cueOut: '#dc2626',
};

export type CueDraft = Record<CueField, CuePoint>;

/** The draft of an asset's cues, as stored (nothing set when it has none yet). */
export function draftOf(cues: AssetCues | null): CueDraft {
  return Object.fromEntries(
    CUE_FIELDS.map((field) => [
      field,
      cues ? { ...cues[field] } : { samples: null, source: 'auto', locked: false },
    ]),
  ) as CueDraft;
}

const INNER = ['introEnd', 'outroStart', 'crossStartNext'] as const;

/**
 * The bounds a marker may move within: cue-in before every other point, cue-out after them,
 * the inner markers between the two. `length` is the asset's length in samples.
 */
export function boundsOf(draft: CueDraft, field: MarkerField, length: number): [number, number] {
  const cueIn = draft.cueIn.samples ?? 0;
  const cueOut = draft.cueOut.samples ?? length;
  const inner = INNER.map((f) => draft[f].samples).filter((s): s is number => s !== null);
  if (field === 'cueIn') return [0, Math.max(0, Math.min(cueOut - 1, ...inner))];
  if (field === 'cueOut') return [Math.min(length, Math.max(cueIn + 1, ...inner)), length];
  return [cueIn, cueOut];
}

/**
 * The draft with `field` moved to `samples`, kept inside its bounds; marks it manual and
 * locks it (the lock button shows what a save sends: a person may unlock it again).
 */
export function moveMarker(
  draft: CueDraft,
  field: MarkerField,
  samples: number,
  length: number,
): CueDraft {
  const [lo, hi] = boundsOf(draft, field, length);
  const clamped = Math.round(Math.min(hi, Math.max(lo, samples)));
  return { ...draft, [field]: { samples: clamped, source: 'manual', locked: true } };
}

/** The draft with `field` cleared (the engine falls back to its default), locked like a move. */
export const clearPoint = (draft: CueDraft, field: CueField): CueDraft => ({
  ...draft,
  [field]: { samples: null, source: 'manual', locked: true },
});

export const setLocked = (draft: CueDraft, field: CueField, locked: boolean): CueDraft => ({
  ...draft,
  [field]: { ...draft[field], locked },
});

/**
 * The `PUT …/cues` body that turns `saved` into `draft`, or `null` when nothing changed. Points
 * go with the draft's lock: a move locks a point unless the person unlocked it again. Either
 * way a moved point becomes `manual`, which autocue never overwrites.
 */
export function patchOf(saved: CueDraft, draft: CueDraft, sampleRate: number): UpdateCues | null {
  const patch: Record<string, { samples?: number | null; locked?: boolean }> = {};
  for (const field of CUE_FIELDS) {
    const before = saved[field];
    const after = draft[field];
    const moved = before.samples !== after.samples;
    if (moved) patch[field] = { samples: after.samples, locked: after.locked };
    else if (before.locked !== after.locked) patch[field] = { locked: after.locked };
  }
  if (Object.keys(patch).length === 0) return null;
  return { sampleRate, ...patch } as UpdateCues;
}

/** What a save would change; drives the unsaved-changes guard. */
export const isDirty = (saved: CueDraft, draft: CueDraft) => patchOf(saved, draft, 1) !== null;

/** Fade regions, as sample ranges: fade-in from cue-in, fade-out up to cue-out. */
export function fadeRegions(
  draft: CueDraft,
  length: number,
): { id: 'fadeIn' | 'fadeOut'; fromSample: number; toSample: number }[] {
  const cueIn = draft.cueIn.samples ?? 0;
  const cueOut = draft.cueOut.samples ?? length;
  const regions: { id: 'fadeIn' | 'fadeOut'; fromSample: number; toSample: number }[] = [];
  const fadeIn = draft.fadeIn.samples;
  const fadeOut = draft.fadeOut.samples;
  if (fadeIn) regions.push({ id: 'fadeIn', fromSample: cueIn, toSample: cueIn + fadeIn });
  if (fadeOut) regions.push({ id: 'fadeOut', fromSample: cueOut - fadeOut, toSample: cueOut });
  return regions;
}

/** Seconds of the outgoing track a transition preview plays before the next one starts. */
export const TRANSITION_LEAD_S = 6;
/** Seconds of the next track a transition preview plays. */
export const TRANSITION_TAIL_S = 6;

export interface TransitionPlan {
  /** Where the outgoing track starts playing, in its samples. */
  fromSample: number;
  /** Where the next track starts (the outgoing track's next-track start, else its cue-out). */
  switchAt: number;
  /** Where the outgoing track stops: its cue-out. */
  stopAt: number;
  /** Fade-out of the outgoing track: `[start, stopAt]`, or none. */
  fadeOutFrom: number | null;
}

/** The outgoing side of a transition preview, from the draft (saved or not). */
export function transitionPlan(
  draft: CueDraft,
  length: number,
  sampleRate: number,
): TransitionPlan {
  const cueIn = draft.cueIn.samples ?? 0;
  const stopAt = draft.cueOut.samples ?? length;
  // A stored next-track start past cue-out (it shouldn't be) starts the next track at cue-out.
  const switchAt = Math.min(draft.crossStartNext.samples ?? stopAt, stopAt);
  const fadeOut = draft.fadeOut.samples;
  return {
    fromSample: Math.max(cueIn, switchAt - TRANSITION_LEAD_S * sampleRate),
    switchAt,
    stopAt,
    fadeOutFrom: fadeOut ? Math.max(cueIn, stopAt - fadeOut) : null,
  };
}

/** Volume (0..1) of the outgoing track at `sample`: 1, ramping down over its fade-out. */
export function fadeGain(plan: TransitionPlan, sample: number): number {
  if (plan.fadeOutFrom === null || sample <= plan.fadeOutFrom) return 1;
  const span = plan.stopAt - plan.fadeOutFrom;
  return span > 0 ? Math.max(0, Math.min(1, (plan.stopAt - sample) / span)) : 0;
}
