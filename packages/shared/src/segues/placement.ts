import { PLAYOUT_SAMPLE_RATE } from '../contracts/library.ts';
import {
  ENVELOPE_SILENCE_DB,
  type Envelope,
  SEGUE_MAX_OFFSET_SAMPLES,
  SEGUE_MAX_VOICES,
  type SegueInLane,
  type SegueMedia,
  type SegueOutLane,
  type SegueVoiceLane,
} from '../contracts/segues.ts';

// Smart default VT placement (#61, ADR 0037): where voices go over a transition A → B when no
// person placed them, from A's and B's cue markers (autocue or the cue editor), and the ducking
// under them. Pure and deterministic, markers only: no AI or ML (the owner's rule). Used by the
// promo placements (#60, through `defaultPromoLanes`), the segue editor (a voice added from the
// library, a take recorded without music, "reset to auto placement") and the review seed.
//
// Positions are samples on the segue axis (ADR 0017): 0 is A's end, negative before it.

/** Ducking under a voice: A and B `depthDb` under it, ramps of `rampMs`. */
export interface DuckPreset {
  depthDb: number;
  rampMs: number;
}

/** The owner's default: 8 dB under the voice, 300 ms ramps (the segue editor's first preset). */
export const DEFAULT_DUCK: DuckPreset = { depthDb: -8, rampMs: 300 };

/**
 * A bed under a voice that outlasts the music: `gainDb` on its playout gain, faded in and out
 * over `fadeMs`, used only when the voice would otherwise play alone for at least `minGapMs`.
 */
export interface BedPreset {
  gainDb: number;
  fadeMs: number;
  minGapMs: number;
}

export const DEFAULT_BED: BedPreset = { gainDb: -10, fadeMs: 1000, minGapMs: 1500 };

/** Breath between two voices placed one after the other. */
export const VOICE_GAP_MS = 250;

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

/** A lane's media from `GET …/segues/media` as placement reads it: effective cues, markers. */
export function placementMediaOf(media: Pick<SegueMedia, 'cueIn' | 'cueOut' | 'markers'>) {
  return {
    cueIn: media.cueIn,
    cueOut: media.cueOut,
    outroStart: media.markers?.outroStart ?? null,
    introEnd: media.markers?.introEnd ?? null,
    crossStartNext: media.markers?.crossStartNext ?? null,
  } satisfies PlacementMedia;
}

/**
 * A voice to place: its effective range in its file (the lane's trim, else the asset's cues).
 * `lane` keeps what a person set on an existing voice (its trim, gain trim and envelope, which
 * moves with it); only its place changes.
 */
export interface PlacementVoice {
  assetId: string;
  cueIn: number;
  cueOut: number;
  lane?: Pick<SegueVoiceLane, 'start' | 'cueIn' | 'cueOut' | 'gainDb' | 'envelope'>;
}

/** A bed asset to lay under a voice that outlasts the music: its effective range. */
export interface PlacementBed {
  assetId: string;
  cueIn: number;
  cueOut: number;
}

export interface PlacementOptions {
  duck?: DuckPreset;
  /** Without one, a voice longer than the music only delays B (a dry stretch). */
  bed?: PlacementBed | null;
  bedPreset?: BedPreset;
  /** The voices start no further than this from A's end, either way (promos: ADR 0032). */
  maxLead?: number;
  /** The first voice starts here (a take recorded over the music): only B and ducks move. */
  voiceStart?: number;
}

export interface PlacementLanes {
  out: SegueOutLane;
  in: SegueInLane;
  voices: SegueVoiceLane[];
}

/**
 * How the placement came out, for tests and the owner's review (#61):
 * - `fit`: `post` when B starts at its natural start and the voices end on B's intro end or
 *   before; `delayed` when B had to wait for them (`delay` samples after its natural start);
 * - `dry`: samples where the voices play with neither A nor B (between A's end and B's start);
 * - `bed`: a bed covers that stretch;
 * - `markers`: which markers were usable.
 */
export interface PlacementReport {
  fit: 'post' | 'delayed';
  delay: number;
  dry: number;
  bed: boolean;
  markers: { outro: boolean; intro: boolean; cross: boolean };
}

export interface Placement {
  lanes: PlacementLanes;
  report: PlacementReport;
}

const inside = (at: number | null | undefined, m: PlacementMedia): at is number =>
  typeof at === 'number' && at > m.cueIn && at < m.cueOut;

const clamp = (at: number) =>
  Math.max(-SEGUE_MAX_OFFSET_SAMPLES, Math.min(SEGUE_MAX_OFFSET_SAMPLES, Math.round(at)));

const clampEnvelope = (envelope: Envelope): Envelope => {
  const out: Envelope = [];
  for (const p of envelope) {
    const at = clamp(p.at);
    if (!out.length || at > (out[out.length - 1] as { at: number }).at)
      out.push({ at, gainDb: p.gainDb });
  }
  return out;
};

/**
 * The default segue for voices between A and B ("hitting the post"):
 * 1. B's natural start is A's `crossStartNext` (0, A's end, without it).
 * 2. The voices start with A's outro (`outroStart`), or at B's natural start if that is earlier;
 *    without an outro marker, at B's natural start: never over A's vocals as far as the markers
 *    tell. Several voices play one after the other, {@link VOICE_GAP_MS} apart.
 * 3. B starts so that its intro (`introEnd`) ends with the last voice: the voices cover A's
 *    outro and B's intro and B's vocals come in as they end. Without an intro marker, B starts
 *    as they end.
 * 4. B never starts before its natural start: short voices move later instead, so they still
 *    end at B's intro end. Long ones delay B. Where that leaves the voice alone between A's end
 *    and B's start for {@link BedPreset.minGapMs} or more, a `bed` (when given, and a voice lane
 *    is free) plays under it, faded in as A ends and out once B has started.
 * 5. A and B duck under the voices ({@link DEFAULT_DUCK}).
 * The voices never start before A does, and within `maxLead` of A's end when given. With
 * `voiceStart`, the first voice stays there (it was spoken over the music) and only B, the
 * other voices and the ducks follow rules 3–5.
 */
export function autoPlacement(
  a: PlacementMedia,
  b: PlacementMedia,
  voices: readonly PlacementVoice[],
  options: PlacementOptions = {},
): Placement {
  const duck = options.duck ?? DEFAULT_DUCK;
  const aStart = a.cueIn - a.cueOut;
  const natural = inside(a.crossStartNext, a) ? a.crossStartNext - a.cueOut : 0;
  const outro = inside(a.outroStart, a) ? a.outroStart - a.cueOut : null;
  const intro = inside(b.introEnd, b) ? b.introEnd - b.cueIn : 0;
  const gap = samplesOfMs(VOICE_GAP_MS);
  const lengths = voices.map((v) => Math.max(0, v.cueOut - v.cueIn));
  const total = lengths.reduce((sum, n) => sum + n, 0) + gap * Math.max(0, voices.length - 1);
  const lead = options.maxLead ?? SEGUE_MAX_OFFSET_SAMPLES;
  const bounded = (at: number) => Math.max(aStart, -lead, Math.min(lead, at));

  let start: number;
  let inStart: number;
  if (options.voiceStart !== undefined) {
    start = options.voiceStart;
    inStart = Math.max(natural, start + total - intro);
  } else {
    start = bounded(outro === null ? natural : Math.min(outro, natural));
    inStart = start + total - intro;
    if (inStart < natural) {
      inStart = natural;
      start = bounded(inStart + intro - total);
    }
  }
  start = clamp(start);
  inStart = clamp(inStart);

  let at = start;
  const placed: SegueVoiceLane[] = voices.map((v, i) => {
    const lane = v.lane;
    const voiceLane: SegueVoiceLane = {
      assetId: v.assetId,
      start: clamp(at),
      ...(lane?.cueIn !== undefined && { cueIn: lane.cueIn }),
      ...(lane?.cueOut !== undefined && { cueOut: lane.cueOut }),
      gainDb: lane?.gainDb ?? 0,
      envelope: lane
        ? clampEnvelope(lane.envelope.map((p) => ({ ...p, at: p.at + clamp(at) - lane.start })))
        : [],
    };
    at += (lengths[i] ?? 0) + gap;
    return voiceLane;
  });

  const end = start + total;
  const ducks = voices.length ? duckEnvelopes({ start, end }, inStart, duck) : { out: [], in: [] };

  // Where the voices play alone: after A's end (and after they start), before B starts.
  const dry = Math.max(0, inStart - Math.max(0, start));
  const bedPreset = options.bedPreset ?? DEFAULT_BED;
  let bed = false;
  if (
    options.bed &&
    voices.length &&
    voices.length < SEGUE_MAX_VOICES &&
    dry >= samplesOfMs(bedPreset.minGapMs)
  ) {
    const lane = bedLane(options.bed, Math.max(0, start), inStart, aStart, bedPreset);
    if (lane) {
      placed.push(lane);
      bed = true;
    }
  }

  return {
    lanes: {
      out: { envelope: clampEnvelope(ducks.out) },
      in: { start: inStart, envelope: clampEnvelope(ducks.in) },
      voices: placed,
    },
    report: {
      fit: inStart > natural ? 'delayed' : 'post',
      delay: Math.max(0, inStart - natural),
      dry,
      bed,
      markers: { outro: outro !== null, intro: intro > 0, cross: natural !== 0 },
    },
  };
}

/**
 * A bed over the dry stretch `[from, to)`: it fades in over `fadeMs` ending where the stretch
 * starts (under A's last moments, never before A starts) and fades out over `fadeMs` once B has started. A bed shorter
 * than that plays whole, from its start, with shorter fades.
 */
function bedLane(
  bed: PlacementBed,
  from: number,
  to: number,
  earliest: number,
  preset: BedPreset,
): SegueVoiceLane | null {
  const fade = samplesOfMs(preset.fadeMs);
  const available = bed.cueOut - bed.cueIn;
  const start = clamp(Math.max(earliest, from - fade));
  const length = Math.min(available, to + fade - start);
  if (length < 4) return null;
  const f = Math.min(fade, Math.floor((length - 1) / 3));
  const end = start + length;
  return {
    assetId: bed.assetId,
    start,
    cueIn: bed.cueIn,
    cueOut: bed.cueIn + length,
    gainDb: preset.gainDb,
    envelope: clampEnvelope([
      { at: start, gainDb: ENVELOPE_SILENCE_DB },
      { at: start + f, gainDb: 0 },
      { at: end - f, gainDb: 0 },
      { at: end, gainDb: ENVELOPE_SILENCE_DB },
    ]),
  };
}
