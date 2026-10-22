import { PLAYOUT_SAMPLE_RATE } from '../contracts/library.ts';
import {
  ENVELOPE_SILENCE_DB,
  type Envelope,
  type EnvelopePoint,
  ISLAND_FORMAT,
  ISLAND_HANDLE_SAMPLES,
  ISLAND_MIN_BODY_SAMPLES,
  ISLAND_SPEC_VERSION,
  type IslandFiles,
  type IslandJoin,
  type IslandSource,
  type IslandSpec,
  type SegueInLane,
  type SegueOutLane,
  type SegueProblem,
  type SegueVoiceLane,
} from '../contracts/segues.ts';
import { stableStringify } from '../json.ts';
import { dbToAmplitude, envelopeGainAt } from './gain.ts';
import { sha256Hex } from './sha256.ts';

// Island derivation (#55, ADR 0017): segues → island specs. Pure and deterministic, so the api
// (on every save and log change), the renderer (#56) and the feeder (#57, to check that a
// rendered island still matches its inputs at air time) all compute the same spec and hash.
//
// Per segue, on its axis (0 = A's end):
// - the island starts {@link ISLAND_HANDLE_SAMPLES} before the first deviation from "A plays
//   normally": A's envelope leaving 0 dB, a voice starting, B starting, or A's end;
// - it ends a handle after B plays alone at full volume: B's envelope back at 0 dB for good,
//   every voice ended, A ended;
// - B's join is moved up to B's next FLAC block boundary, so the engine's seek into B's body is
//   sample-exact (spike #12). A's join needs no snapping: it is a cue-out;
// - a body shorter than {@link ISLAND_MIN_BODY_SAMPLES} is absorbed: the whole item goes into
//   the island. Between two segues that share an item, that merges their islands.

/** An item's or a voice's playout copy and what plays of it, resolved by the caller. */
export type IslandMedia = {
  assetId: string;
  sha256: string;
  storageKey: string;
  sampleRate: number;
  /** Length of the playout copy in samples. */
  durationSamples: number;
  flacBlockSize: number;
  /** Playout gain (`getPlayoutGain`, with the log item's override): the engine's `liq_amplify`. */
  gainDb: number;
  /** Effective cue-in and cue-out in samples of the playout copy (log override > asset cue). */
  cueIn: number;
  cueOut: number;
};

export type IslandSegueInput = {
  segueId: string;
  fromItemId: string;
  toItemId: string;
  from: IslandMedia;
  to: IslandMedia;
  out: SegueOutLane;
  in: SegueInLane;
  voices: (SegueVoiceLane & { media: IslandMedia })[];
};

/** One island to render, and where it sits in the log. */
export type IslandPlan = {
  spec: IslandSpec;
  /** Where to read each source's file: not part of the spec or its hash. */
  files: IslandFiles;
  head: IslandJoin;
  tail: IslandJoin;
  segueIds: string[];
  itemIds: string[];
};

// --- Envelopes ---------------------------------------------------------------------------

const amplitudeToDb = (a: number) =>
  a <= 0 ? ENVELOPE_SILENCE_DB : Math.max(ENVELOPE_SILENCE_DB, 20 * Math.log10(a));

/** No `-0`, and dB rounded to 1e-6 so equal envelopes hash the same across platforms. */
const cleanDb = (db: number) => {
  const r = Math.round(db * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Shifts an envelope by `offset` and keeps only what matters on `[0, length]`: the interior
 * points plus the gain at both ends. A flat 0 dB result is `[]`, so edits that change nothing
 * audible inside the island don't change its hash.
 */
export function clipEnvelope(points: Envelope, offset: number, length: number): Envelope {
  if (!points.length) return [];
  const shifted = points.map((p) => ({ at: p.at + offset, gainDb: p.gainDb }));
  const out: EnvelopePoint[] = [{ at: 0, gainDb: amplitudeToDb(envelopeGainAt(shifted, 0)) }];
  for (const p of shifted) if (p.at > 0 && p.at < length) out.push(p);
  out.push({ at: length, gainDb: amplitudeToDb(envelopeGainAt(shifted, length)) });
  const clean = out.map((p) => ({ at: p.at, gainDb: cleanDb(p.gainDb) }));
  // Drop points in the middle of a constant stretch.
  const kept = clean.filter(
    (p, i) =>
      i === 0 ||
      i === clean.length - 1 ||
      !(
        p.gainDb === (clean[i - 1] as EnvelopePoint).gainDb &&
        p.gainDb === (clean[i + 1] as EnvelopePoint).gainDb
      ),
  );
  return kept.every((p) => p.gainDb === 0) ? [] : kept;
}

/**
 * A's envelope: where it first leaves 0 dB (the start of the ramp away from it). `-Infinity`
 * when it starts off 0 dB (A is shaped from its first sample), `Infinity` when it never does.
 */
function firstDeviation(points: Envelope): number {
  const first = points[0];
  if (!first) return Number.POSITIVE_INFINITY;
  if (first.gainDb !== 0) return Number.NEGATIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    if ((points[i] as EnvelopePoint).gainDb !== 0) return (points[i - 1] as EnvelopePoint).at;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * B's envelope: from where it holds 0 dB for good (the end of the ramp back to it).
 * `Infinity` when it ends off 0 dB (B is shaped to its end), `-Infinity` when always 0 dB.
 */
function lastDeviation(points: Envelope): number {
  const last = points[points.length - 1];
  if (!last) return Number.NEGATIVE_INFINITY;
  if (last.gainDb !== 0) return Number.POSITIVE_INFINITY;
  for (let i = points.length - 2; i >= 0; i--) {
    if ((points[i] as EnvelopePoint).gainDb !== 0) return (points[i + 1] as EnvelopePoint).at;
  }
  return Number.NEGATIVE_INFINITY;
}

// --- Validation --------------------------------------------------------------------------

const voiceRange = (v: SegueVoiceLane & { media: IslandMedia }) => ({
  cueIn: v.cueIn ?? v.media.cueIn,
  cueOut: v.cueOut ?? v.media.cueOut,
});

/**
 * Why a segue can't be rendered against its media as they are now, or null. The api stores
 * this as the segue's problem (`invalid` / `unsupported_media`).
 */
export function checkSegue(input: IslandSegueInput): SegueProblem | null {
  const media = [input.from, input.to, ...input.voices.map((v) => v.media)];
  for (const m of media) {
    if (m.sampleRate !== PLAYOUT_SAMPLE_RATE || m.flacBlockSize <= 0) {
      return {
        code: 'unsupported_media',
        message: `asset ${m.assetId}: playout copy is not ${PLAYOUT_SAMPLE_RATE} Hz FLAC`,
      };
    }
    if (!(m.cueIn >= 0 && m.cueOut > m.cueIn && m.cueOut <= m.durationSamples)) {
      return { code: 'out_of_range', message: `asset ${m.assetId}: empty or invalid cue range` };
    }
  }
  const aStart = input.from.cueIn - input.from.cueOut;
  const bEnd = input.in.start + input.to.cueOut - input.to.cueIn;
  if (input.in.start < aStart) {
    return { code: 'out_of_range', message: 'B starts before A' };
  }
  for (const [i, v] of input.voices.entries()) {
    const { cueIn, cueOut } = voiceRange(v);
    if (cueIn < 0 || cueOut <= cueIn || cueOut > v.media.durationSamples) {
      return { code: 'out_of_range', message: `voice ${i + 1}: cue range outside the file` };
    }
    if (v.start < aStart) {
      return { code: 'out_of_range', message: `voice ${i + 1} starts before A` };
    }
    if (v.start + cueOut - cueIn > bEnd) {
      return { code: 'out_of_range', message: `voice ${i + 1} ends after B` };
    }
  }
  return null;
}

// --- Derivation --------------------------------------------------------------------------

/** One segue's island on its own axis, before merging. */
type Extent = {
  /** Island start and end on the segue axis. */
  start: number;
  end: number;
  /** A's join (sample of A's playout copy) and B's join (sample of B's). */
  headJoin: number;
  tailJoin: number;
};

function extentOf(s: IslandSegueInput): Extent {
  const a = s.from;
  const b = s.to;
  const aStart = a.cueIn - a.cueOut;
  const bEnd = s.in.start + b.cueOut - b.cueIn;
  const voices = s.voices.map((v) => {
    const { cueIn, cueOut } = voiceRange(v);
    return { start: v.start, end: v.start + cueOut - cueIn };
  });

  const deviation = Math.min(
    firstDeviation(s.out.envelope),
    s.in.start,
    0,
    ...voices.map((v) => v.start),
  );
  let start = Math.max(aStart, deviation - ISLAND_HANDLE_SAMPLES);
  let headJoin = a.cueOut + start;
  if (headJoin - a.cueIn < ISLAND_MIN_BODY_SAMPLES) {
    start = aStart;
    headJoin = a.cueIn;
  }

  const settled = Math.max(
    Math.max(s.in.start, lastDeviation(s.in.envelope)),
    0,
    ...voices.map((v) => v.end),
  );
  const rawEnd = Math.min(bEnd, settled + ISLAND_HANDLE_SAMPLES);
  const bs = b.flacBlockSize;
  let tailJoin = Math.ceil((rawEnd - s.in.start + b.cueIn) / bs) * bs;
  if (b.cueOut - tailJoin < ISLAND_MIN_BODY_SAMPLES) tailJoin = b.cueOut;
  const end = tailJoin - b.cueIn + s.in.start;
  return { start, end, headJoin, tailJoin };
}

/**
 * Splits a chain of segues into islands. `chain` is in play order and consecutive: each
 * segue's B is the next one's A (`toItemId === fromItemId`, same media). Every segue must pass
 * {@link checkSegue}; call this on each run of valid segues. Overlapping islands merge: when the
 * body left between two islands is shorter than {@link ISLAND_MIN_BODY_SAMPLES}, the shared item
 * is rendered whole into one island.
 */
export function deriveIslands(chain: readonly IslandSegueInput[]): IslandPlan[] {
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1] as IslandSegueInput;
    if (prev.toItemId !== (chain[i] as IslandSegueInput).fromItemId) {
      throw new Error('deriveIslands: segues are not consecutive');
    }
  }
  const extents = chain.map(extentOf);
  const groups: number[][] = [];
  for (let i = 0; i < chain.length; i++) {
    const current = groups[groups.length - 1];
    const prev = extents[i - 1];
    const ext = extents[i] as Extent;
    if (current && prev && ext.headJoin - prev.tailJoin < ISLAND_MIN_BODY_SAMPLES) {
      current.push(i);
    } else {
      groups.push([i]);
    }
  }
  return groups.map((g) =>
    buildIsland(
      g.map((i) => chain[i] as IslandSegueInput),
      g.map((i) => extents[i] as Extent),
    ),
  );
}

function buildIsland(segues: IslandSegueInput[], extents: Extent[]): IslandPlan {
  const first = segues[0] as IslandSegueInput;
  const last = segues[segues.length - 1] as IslandSegueInput;
  const firstExt = extents[0] as Extent;
  const lastExt = extents[extents.length - 1] as Extent;

  // Island position = segue axis + offset; the next segue's axis is shifted by B's placement
  // and length (its 0 is B's end).
  const offsets: number[] = [-firstExt.start];
  for (let j = 0; j < segues.length - 1; j++) {
    const s = segues[j] as IslandSegueInput;
    offsets.push((offsets[j] as number) + s.in.start + s.to.cueOut - s.to.cueIn);
  }
  const length = lastExt.end + (offsets[offsets.length - 1] as number);

  const sources: IslandSource[] = [];
  const files: IslandFiles = {};
  const add = (
    m: IslandMedia,
    from: number,
    to: number,
    at: number,
    extraDb: number,
    envelopes: Envelope[],
  ) => {
    if (to <= from) return;
    files[m.sha256] ??= { storageKey: m.storageKey, assetId: m.assetId };
    sources.push({
      sha256: m.sha256,
      from,
      to,
      at,
      gainDb: cleanDb(m.gainDb + extraDb),
      envelopes: envelopes.map((e) => clipEnvelope(e, 0, length)).filter((e) => e.length > 0),
    });
  };
  const shift = (e: Envelope, by: number): Envelope =>
    e.map((p) => ({ at: p.at + by, gainDb: p.gainDb }));

  // Head: A from its join to its end.
  add(first.from, firstExt.headJoin, first.from.cueOut, 0, 0, [
    shift(first.out.envelope, offsets[0] as number),
  ]);
  for (const [j, s] of segues.entries()) {
    const off = offsets[j] as number;
    for (const v of s.voices) {
      const { cueIn, cueOut } = voiceRange(v);
      add(v.media, cueIn, cueOut, v.start + off, v.gainDb, [shift(v.envelope, off)]);
    }
    const next = segues[j + 1];
    const bEnvelopes = [shift(s.in.envelope, off)];
    if (next) bEnvelopes.push(shift(next.out.envelope, offsets[j + 1] as number));
    // A middle item plays whole; the tail item up to its join.
    const to = next ? s.to.cueOut : lastExt.tailJoin;
    add(s.to, s.to.cueIn, to, s.in.start + off, 0, bEnvelopes);
  }
  // Stable order for hashing: by position, then file.
  sources.sort(compareSources);

  return {
    files,
    spec: { version: ISLAND_SPEC_VERSION, format: ISLAND_FORMAT, lengthSamples: length, sources },
    head: {
      itemId: first.fromItemId,
      assetId: first.from.assetId,
      joinSample: firstExt.headJoin,
      hasBody: firstExt.headJoin > first.from.cueIn,
    },
    tail: {
      itemId: last.toItemId,
      assetId: last.to.assetId,
      joinSample: lastExt.tailJoin,
      hasBody: lastExt.tailJoin < last.to.cueOut,
    },
    segueIds: segues.map((s) => s.segueId),
    itemIds: [first.fromItemId, ...segues.map((s) => s.toItemId)],
  };
}

/** Code-point order, not locale order: the same on every platform. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A total order on sources, so the order lanes were listed in never changes the hash: position,
 * file, range, gain, then envelopes.
 */
function compareSources(x: IslandSource, y: IslandSource): number {
  return (
    x.at - y.at ||
    compareText(x.sha256, y.sha256) ||
    x.from - y.from ||
    x.to - y.to ||
    x.gainDb - y.gainDb ||
    compareText(stableStringify(x.envelopes), stableStringify(y.envelopes))
  );
}

/** SHA-256 (lowercase hex) of the spec's canonical JSON: keys the rendered file. */
export function islandHash(spec: IslandSpec): string {
  return sha256Hex(stableStringify(spec));
}
