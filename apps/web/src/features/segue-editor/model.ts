import {
  checkSegue,
  dbToAmplitude,
  deriveIslands,
  ENVELOPE_MAX_POINTS,
  ENVELOPE_SILENCE_DB,
  type Envelope,
  type EnvelopePoint,
  type IslandMedia,
  type IslandPlan,
  SEGUE_MAX_OFFSET_SAMPLES,
  type SegueInLane,
  type SegueMedia,
  type SegueOutLane,
  type SegueProblem,
  type SegueVoiceLane,
} from '@ondes/shared';

// The segue editor's model (#58), pure. Every position is an integer sample on the segue axis
// (ADR 0017): 0 is A's end, negative is before it. A plays up to 0, B from `in.start`, each
// voice from its `start`. Envelopes are on the same axis, gains in dB relative to the playout
// gain, interpolated linearly in amplitude (`envelopeGainAt`).

export const SR = 44_100;
export const ms = (n: number) => Math.round((n * SR) / 1000);
export const seconds = (samples: number) => samples / SR;

/** What the editor edits and saves: the segue's lanes. */
export interface Lanes {
  out: SegueOutLane;
  in: SegueInLane;
  voices: SegueVoiceLane[];
}

/** The media of each lane, from `GET …/segues/media`. A missing one can't be placed yet. */
export interface LaneMedia {
  from: SegueMedia | null;
  to: SegueMedia | null;
  voices: Record<string, SegueMedia | null>;
}

export type LaneKey = 'out' | 'in' | `voice:${number}`;

export const voiceKey = (i: number): LaneKey => `voice:${i}`;
export const voiceIndex = (key: LaneKey): number | null =>
  key.startsWith('voice:') ? Number(key.slice(6)) : null;

/** A new transition: B starts at A's end, no voice, no envelope. */
export const emptyLanes = (): Lanes => ({
  out: { envelope: [] },
  in: { start: 0, envelope: [] },
  voices: [],
});

/** Where one lane's audio sits: file samples `[from, to)` played from axis position `at`. */
export interface Clip {
  key: LaneKey;
  media: SegueMedia;
  from: number;
  to: number;
  at: number;
  /** Static gain: playout gain plus the lane's trim. */
  gainDb: number;
  envelope: Envelope;
}

export const clipEnd = (c: Pick<Clip, 'from' | 'to' | 'at'>) => c.at + c.to - c.from;

/** File sample of `media` heard at axis position `axis` in this clip. */
export const fileSample = (c: Pick<Clip, 'from' | 'at'>, axis: number) => axis - c.at + c.from;

export function voiceRange(v: SegueVoiceLane, m: SegueMedia): { cueIn: number; cueOut: number } {
  return { cueIn: v.cueIn ?? m.cueIn, cueOut: v.cueOut ?? m.cueOut };
}

/** The lanes as clips, in lane order (A, voices, B); lanes without media are left out. */
export function clipsOf(lanes: Lanes, media: LaneMedia): Clip[] {
  const clips: Clip[] = [];
  const a = media.from;
  if (a) {
    clips.push({
      key: 'out',
      media: a,
      from: a.cueIn,
      to: a.cueOut,
      at: a.cueIn - a.cueOut,
      gainDb: a.gainDb,
      envelope: lanes.out.envelope,
    });
  }
  lanes.voices.forEach((v, i) => {
    const m = media.voices[v.assetId];
    if (!m) return;
    const { cueIn, cueOut } = voiceRange(v, m);
    clips.push({
      key: voiceKey(i),
      media: m,
      from: cueIn,
      to: cueOut,
      at: v.start,
      gainDb: m.gainDb + v.gainDb,
      envelope: v.envelope,
    });
  });
  const b = media.to;
  if (b) {
    clips.push({
      key: 'in',
      media: b,
      from: b.cueIn,
      to: b.cueOut,
      at: lanes.in.start,
      gainDb: b.gainDb,
      envelope: lanes.in.envelope,
    });
  }
  return clips;
}

/** The whole segue on the axis: A's first sample to the last clip's end. */
export function extentOf(clips: readonly Clip[]): { from: number; to: number } {
  if (!clips.length) return { from: -ms(30_000), to: ms(30_000) };
  return {
    from: Math.min(...clips.map((c) => c.at)),
    to: Math.max(...clips.map(clipEnd)),
  };
}

/** Where the transition begins: the first voice, B's start, or A's end, whichever is first. */
export function transitionStart(lanes: Lanes): number {
  return Math.min(0, lanes.in.start, ...lanes.voices.map((v) => v.start));
}

/**
 * Positions the api accepts: within {@link SEGUE_MAX_OFFSET_SAMPLES} (10 min) of A's end.
 * Every edit clamps to it, so a save never fails on a point or a lane dragged too far.
 */
export const clampOffset = (at: number) =>
  Math.max(-SEGUE_MAX_OFFSET_SAMPLES, Math.min(SEGUE_MAX_OFFSET_SAMPLES, Math.round(at)));

// --- Envelopes ---------------------------------------------------------------------------

/** Gains shown and dragged in the editor: silence up to +6 dB. */
export const DISPLAY_MAX_DB = 6;
const DISPLAY_MAX_AMP = dbToAmplitude(DISPLAY_MAX_DB);

/** dB → height fraction from the lane's bottom, linear in amplitude (ramps draw straight). */
export const gainToY = (gainDb: number) => Math.min(1, dbToAmplitude(gainDb) / DISPLAY_MAX_AMP);

/** Height fraction → dB, rounded to 0.1 dB; the bottom is silence, 0 dB snaps within 0.5 dB. */
export function yToGain(y: number): number {
  const amp = Math.max(0, Math.min(1, y)) * DISPLAY_MAX_AMP;
  if (amp <= dbToAmplitude(-60)) return ENVELOPE_SILENCE_DB;
  const db = Math.round(200 * Math.log10(amp)) / 10;
  return Math.abs(db) < 0.5 ? 0 : db;
}

/** Inserts a point, keeping `at` strictly increasing (a point at the same time is replaced). */
export function addPoint(envelope: Envelope, point: EnvelopePoint): Envelope {
  if (envelope.length >= ENVELOPE_MAX_POINTS) return envelope;
  const at = clampOffset(point.at);
  const rest = envelope.filter((p) => p.at !== at);
  return [...rest, { at, gainDb: point.gainDb }].sort((a, b) => a.at - b.at);
}

/** Moves point `index`, kept strictly between its neighbours. */
export function movePoint(envelope: Envelope, index: number, point: EnvelopePoint): Envelope {
  const prev = envelope[index - 1];
  const next = envelope[index + 1];
  const at = Math.max(
    prev ? prev.at + 1 : -SEGUE_MAX_OFFSET_SAMPLES,
    Math.min(next ? next.at - 1 : SEGUE_MAX_OFFSET_SAMPLES, Math.round(point.at)),
  );
  return envelope.map((p, i) => (i === index ? { at, gainDb: point.gainDb } : p));
}

export const removePoint = (envelope: Envelope, index: number): Envelope =>
  envelope.filter((_, i) => i !== index);

/** Shifts every point: envelopes move with their clip when it is dragged. */
export const shiftEnvelope = (envelope: Envelope, by: number): Envelope =>
  envelope.map((p) => ({ at: p.at + by, gainDb: p.gainDb }));

// --- Presets -----------------------------------------------------------------------------

export interface DuckPreset {
  depthDb: number;
  rampMs: number;
}

/** The owner's default: A and B 8 dB under the voice, 300 ms ramps. */
export const DUCK_PRESETS: readonly DuckPreset[] = [
  { depthDb: -8, rampMs: 300 },
  { depthDb: -12, rampMs: 300 },
  { depthDb: -6, rampMs: 500 },
];

/**
 * Ducks A and B under the voices: A ramps down to `depthDb` over `rampMs` ending where the
 * first voice starts and holds there to its end; B is at `depthDb` until the last voice ends,
 * then ramps back to 0 dB. Without a voice nothing changes. Replaces both envelopes.
 */
export function applyDuck(lanes: Lanes, media: LaneMedia, preset: DuckPreset): Lanes {
  const spans = clipsOf(lanes, media)
    .filter((c) => voiceIndex(c.key) !== null)
    .map((c) => ({ start: c.at, end: clipEnd(c) }));
  if (!spans.length) return lanes;
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  const ramp = ms(preset.rampMs);
  const out: Envelope =
    start < 0
      ? [
          { at: start - ramp, gainDb: 0 },
          { at: start, gainDb: preset.depthDb },
        ]
      : [];
  const inEnvelope: Envelope =
    end > lanes.in.start
      ? [
          { at: end, gainDb: preset.depthDb },
          { at: end + ramp, gainDb: 0 },
        ]
      : [];
  return { ...lanes, out: { envelope: out }, in: { ...lanes.in, envelope: inEnvelope } };
}

/** A fades out to silence over `fadeMs`, ending at its end. */
export function applyFadeOut(lanes: Lanes, fadeMs: number): Lanes {
  return {
    ...lanes,
    out: {
      envelope: [
        { at: -ms(fadeMs), gainDb: 0 },
        { at: 0, gainDb: ENVELOPE_SILENCE_DB },
      ],
    },
  };
}

export const clearEnvelopes = (lanes: Lanes): Lanes => ({
  out: { envelope: [] },
  in: { ...lanes.in, envelope: [] },
  voices: lanes.voices.map((v) => ({ ...v, envelope: [] })),
});

// --- Moves -------------------------------------------------------------------------------

/**
 * Where a lane may start: its start and every point of its envelope, which moves with it,
 * stay within the api's ±10 minutes.
 */
function clampStart(current: number, envelope: Envelope, start: number): number {
  const ats = [current, ...envelope.map((p) => p.at)];
  const lo = -SEGUE_MAX_OFFSET_SAMPLES - Math.min(...ats);
  const hi = SEGUE_MAX_OFFSET_SAMPLES - Math.max(...ats);
  return current + Math.max(lo, Math.min(hi, Math.round(start) - current));
}

/** Moves B or a voice (and its envelope with it) to start at `start`. A doesn't move. */
export function moveLane(lanes: Lanes, key: LaneKey, start: number): Lanes {
  if (key === 'in') {
    const at = clampStart(lanes.in.start, lanes.in.envelope, start);
    const by = at - lanes.in.start;
    return { ...lanes, in: { start: at, envelope: shiftEnvelope(lanes.in.envelope, by) } };
  }
  const i = voiceIndex(key);
  if (i === null) return lanes;
  return {
    ...lanes,
    voices: lanes.voices.map((v, j) => {
      if (j !== i) return v;
      const at = clampStart(v.start, v.envelope, start);
      return { ...v, start: at, envelope: shiftEnvelope(v.envelope, at - v.start) };
    }),
  };
}

export function laneStart(lanes: Lanes, key: LaneKey): number | null {
  if (key === 'in') return lanes.in.start;
  const i = voiceIndex(key);
  return i === null ? null : (lanes.voices[i]?.start ?? null);
}

export function laneEnvelope(lanes: Lanes, key: LaneKey): Envelope {
  if (key === 'out') return lanes.out.envelope;
  if (key === 'in') return lanes.in.envelope;
  return lanes.voices[voiceIndex(key) ?? -1]?.envelope ?? [];
}

export function setLaneEnvelope(lanes: Lanes, key: LaneKey, envelope: Envelope): Lanes {
  if (key === 'out') return { ...lanes, out: { envelope } };
  if (key === 'in') return { ...lanes, in: { ...lanes.in, envelope } };
  const i = voiceIndex(key);
  return { ...lanes, voices: lanes.voices.map((v, j) => (j === i ? { ...v, envelope } : v)) };
}

/** A new voice: it starts where A starts to duck, or 3 s before A's end. */
export function addVoice(lanes: Lanes, assetId: string): Lanes {
  const start = lanes.voices.length
    ? Math.max(...lanes.voices.map((v) => v.start)) + ms(1000)
    : -ms(3000);
  return { ...lanes, voices: [...lanes.voices, { assetId, start, gainDb: 0, envelope: [] }] };
}

export const removeVoice = (lanes: Lanes, index: number): Lanes => ({
  ...lanes,
  voices: lanes.voices.filter((_, i) => i !== index),
});

// --- Checks, islands ---------------------------------------------------------------------

/** The lanes as the derivation sees them; null while some media is missing. */
function islandInput(lanes: Lanes, media: LaneMedia) {
  const island = (m: SegueMedia): IslandMedia => ({
    ...m,
    storageKey: m.sha256,
    flacBlockSize: 1024,
  });
  if (!media.from || !media.to) return null;
  const voices = [];
  for (const v of lanes.voices) {
    const m = media.voices[v.assetId];
    if (!m) return null;
    voices.push({ ...v, media: island(m) });
  }
  return {
    segueId: 'editor',
    fromItemId: 'from',
    toItemId: 'to',
    from: island(media.from),
    to: island(media.to),
    out: lanes.out,
    in: lanes.in,
    voices,
  };
}

/** What the api would flag (`invalid`), checked before saving. */
export function problemOf(lanes: Lanes, media: LaneMedia): SegueProblem | null {
  const input = islandInput(lanes, media);
  return input && checkSegue(input);
}

/** The island this segue renders on its own (merging with neighbours is the api's job). */
export function islandOf(lanes: Lanes, media: LaneMedia): IslandPlan | null {
  const input = islandInput(lanes, media);
  if (!input || checkSegue(input)) return null;
  return deriveIslands([input])[0] ?? null;
}

/** The island's range on the segue axis. */
export function islandRange(plan: IslandPlan, media: LaneMedia): { from: number; to: number } {
  const a = media.from as SegueMedia;
  const from = plan.head.joinSample - a.cueOut;
  return { from, to: from + plan.spec.lengthSamples };
}

/** Equal lanes, whatever the key order (dirty check). */
export const sameLanes = (a: Lanes, b: Lanes) => JSON.stringify(a) === JSON.stringify(b);
