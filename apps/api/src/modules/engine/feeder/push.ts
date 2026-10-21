import {
  type CueOverrides,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineSegmentPart,
  getPlayoutGain,
  type PlayoutGainAsset,
  type PlayoutGainStation,
  playoutPath,
} from '@ondes/shared';

// What the feeder sends the engine for one log item (ADR 0002 "Per-item metadata", spike #12).
// Pure: the feeder loads the media (repo.ts), the planner decides what to push (plan.ts), this
// turns one item into the push body.
//
// - Cue points are sample positions; the engine takes seconds. Liquidsoap plays
//   `ceil(out·sr) − ceil(in·sr)` samples with a cue-in and stops at `floor(out·sr)` without one,
//   so positions go out biased by half a sample: `(n − ½)/sr` on a request with a cue-in,
//   `(n + ½)/sr` without (spike #12, `engine/spikes/splice/RESULTS.md`).
// - Fades are durations in samples, sent as seconds, unbiased.
// - Crossfades: the overlap between two entries is min(previous cross_out, next cross_in), so
//   an entry gets cross_in = the previous entry's cross_out (ADR 0002). Its own cross_out is the
//   log's `crossOutMs`, else the asset's natural overlap (`cueOut − crossStartNext`), else unset
//   (the station default).
// - Gain: `getPlayoutGain` (#19), with the log's `gainDb` as the override when set (so it is
//   clamped to the true-peak ceiling like any other gain); omitted when 0.
// - A trim (hard-start re-plan, ADR 0003) cuts the item's end and makes sure it fades out.

/** The playout copy of an asset and what plays it, as the repo loads it. */
export type FeedMedia = {
  assetId: string;
  /** The playout `asset_file`. */
  fileId: string;
  sha256: string;
  /** Extension of the playout file's storage key (`cacheExtOf`). */
  ext: string;
  /** FLAC block size of the playout copy: the grid seeks land on (spike #12). */
  flacBlockSize: number | null;
  /** Length of the playout copy in samples, at `sampleRate`. */
  durationSamples: number | null;
  sampleRate: number | null;
  /** In the station's playout cache (`playout_cache_file` ready). */
  cached: boolean;
  title: string;
  artists: string[];
  cues: FeedCues | null;
  gain: PlayoutGainAsset;
};

/** The asset's cue points in samples at `sampleRate` (fades are lengths in samples). */
export type FeedCues = {
  sampleRate: number;
  cueIn: number | null;
  cueOut: number | null;
  fadeIn: number | null;
  fadeOut: number | null;
  crossStartNext: number | null;
};

/** One request to build: a log item (or a segment part) and its media. */
export type PushSource = {
  itemId: string;
  title: string | null;
  cueOverrides: CueOverrides | null;
  media: FeedMedia;
};

export type PushContext = {
  station: PlayoutGainStation;
  /** Overlap into this entry: the previous entry's cross_out, in ms. */
  crossInMs?: number | undefined;
  /** How much to cut off the end (hard-start re-plan), in ms. */
  trimMs?: number;
  /** Fade-out given to a trimmed item, in seconds. Default 3. */
  trimFadeSeconds?: number;
  /** Engine-side cache root (`/cache`). */
  engineRoot?: string;
};

/** Seconds with microsecond resolution: enough for half a sample at 44.1 kHz. */
const round6 = (s: number) => Math.round(s * 1e6) / 1e6;

type Positions = {
  /** Samples and their rate; null when unset. */
  cueIn: { n: number; sr: number } | null;
  cueOut: { n: number; sr: number } | null;
  fadeIn: { n: number; sr: number } | null;
  fadeOut: { n: number; sr: number } | null;
  crossStartNext: { n: number; sr: number } | null;
};

/** Log overrides win over the asset's cues; each value keeps its own sample rate. */
function positionsOf(source: PushSource): Positions {
  const o = source.cueOverrides;
  const c = source.media.cues;
  const pick = (
    override: number | undefined,
    cue: number | null | undefined,
  ): { n: number; sr: number } | null => {
    if (override !== undefined && o?.sampleRate) return { n: override, sr: o.sampleRate };
    if (cue !== null && cue !== undefined && c) return { n: cue, sr: c.sampleRate };
    return null;
  };
  return {
    cueIn: pick(o?.cueIn, c?.cueIn),
    cueOut: pick(o?.cueOut, c?.cueOut),
    fadeIn: pick(o?.fadeIn, c?.fadeIn),
    fadeOut: pick(o?.fadeOut, c?.fadeOut),
    crossStartNext: c?.crossStartNext != null ? { n: c.crossStartNext, sr: c.sampleRate } : null,
  };
}

/** Where the item stops, in samples, before any trim: its cue-out, else the file's end. */
function endOf(p: Positions, media: FeedMedia): { n: number; sr: number } | null {
  if (p.cueOut) return p.cueOut;
  if (media.durationSamples && media.sampleRate)
    return { n: media.durationSamples, sr: media.sampleRate };
  return null;
}

/** The entry's own overlap into the next one, in ms; undefined = station default. */
export function crossOutMsOf(source: PushSource): number | undefined {
  if (source.cueOverrides?.crossOutMs !== undefined) return source.cueOverrides.crossOutMs;
  const p = positionsOf(source);
  const end = endOf(p, source.media);
  if (!p.crossStartNext || !end || end.sr !== p.crossStartNext.sr) return undefined;
  return Math.max(0, Math.round(((end.n - p.crossStartNext.n) * 1000) / end.sr));
}

/** Playable length in ms (cue-in to cue-out, or to the file's end); null when unknown. */
export function playLengthMs(source: PushSource): number | null {
  const p = positionsOf(source);
  const end = endOf(p, source.media);
  if (!end) return null;
  const start = p.cueIn && p.cueIn.sr === end.sr ? p.cueIn.n : 0;
  return Math.max(0, Math.round(((end.n - start) * 1000) / end.sr));
}

/**
 * The log's `gainDb` is the item's own override: it replaces the asset's gain (even when the
 * asset's normalisation is off: someone set it on this item) but goes through the same true-peak
 * ceiling, rounding and bounds as every gain (#19), so a log edit can't push an item past it.
 */
function gainOf(source: PushSource, station: PlayoutGainStation): number | undefined {
  const override = source.cueOverrides?.gainDb;
  const asset =
    override === undefined
      ? source.media.gain
      : { ...source.media.gain, normalizeLoudness: true, gainOverrideDb: override };
  const db = getPlayoutGain(asset, station).gainDb;
  return db === 0 ? undefined : db;
}

function requestOf(
  source: PushSource,
  ctx: PushContext,
  options: { snapCueIn: boolean; trimMs: number },
): { request: EngineSegmentPart; positions: Positions } {
  const { media } = source;
  const p = positionsOf(source);
  let cueIn = p.cueIn && p.cueIn.n > 0 ? p.cueIn : null;
  // Inside a segment the join must be sample-exact: seeks land on the playout copy's block
  // grid, so put the cue-in on it rather than let the decoder pick an earlier sample.
  if (cueIn && options.snapCueIn && media.flacBlockSize) {
    const n = Math.floor(cueIn.n / media.flacBlockSize) * media.flacBlockSize;
    cueIn = n > 0 ? { n, sr: cueIn.sr } : null;
  }
  let cueOut = p.cueOut;
  if (options.trimMs > 0) {
    const end = endOf(p, media);
    if (end) {
      const startN = cueIn && cueIn.sr === end.sr ? cueIn.n : 0;
      const cut = Math.round((options.trimMs * end.sr) / 1000);
      // Never trim to nothing: the planner bounds the trim, this only guards the arithmetic.
      cueOut = { n: Math.max(startN + end.sr, end.n - cut), sr: end.sr };
    }
  }
  const request: EngineSegmentPart = {
    item_id: source.itemId,
    uri: playoutPath({ sha256: media.sha256, ext: media.ext }, ctx.engineRoot),
  };
  if (cueIn) request.cue_in = round6((cueIn.n - 0.5) / cueIn.sr);
  if (cueOut) request.cue_out = round6((cueOut.n + (cueIn ? -0.5 : 0.5)) / cueOut.sr);
  const amplify = gainOf(source, ctx.station);
  if (amplify !== undefined) request.amplify_db = amplify;
  const title = source.title ?? media.title;
  if (title) request.title = title;
  if (media.artists.length) request.artist = media.artists.join(', ');
  return { request, positions: p };
}

const seconds = (v: { n: number; sr: number } | null) =>
  v && v.n > 0 ? round6(v.n / v.sr) : undefined;

/** `POST /v1/queue` body for a top-level item. */
export function buildPushItem(source: PushSource, ctx: PushContext): EnginePushItem {
  const trimMs = ctx.trimMs ?? 0;
  const { request, positions } = requestOf(source, ctx, { snapCueIn: false, trimMs });
  const item: EnginePushItem = { ...request };
  const fadeIn = seconds(positions.fadeIn);
  if (fadeIn !== undefined) item.fade_in = fadeIn;
  let fadeOut = seconds(positions.fadeOut);
  if (trimMs > 0) fadeOut = Math.max(fadeOut ?? 0, ctx.trimFadeSeconds ?? 3);
  if (fadeOut !== undefined) item.fade_out = fadeOut;
  const crossIn = source.cueOverrides?.crossInMs ?? ctx.crossInMs;
  if (crossIn !== undefined) item.cross_in = crossIn / 1000;
  const crossOut = crossOutMsOf(source);
  if (crossOut !== undefined) item.cross_out = crossOut / 1000;
  return item;
}

/** A `segment` item: its own overrides carry the transitions into and out of the chain. */
export type SegmentSource = {
  segmentId: string;
  cueOverrides: CueOverrides | null;
  parts: PushSource[];
};

/**
 * `POST /v1/segment` body for an island chain: every part with its own cues and gain (cue-ins
 * on the block grid), fades from the first part's fade-in and the last part's fade-out, the
 * crossfades from the segment's overrides (cross-out falling back to the last part's natural
 * overlap). Segments are never trimmed: their joins are planned to the sample.
 */
export function buildPushSegment(source: SegmentSource, ctx: PushContext): EnginePushSegment {
  const built = source.parts.map((part) => requestOf(part, ctx, { snapCueIn: true, trimMs: 0 }));
  const segment: EnginePushSegment = {
    segment_id: source.segmentId,
    parts: built.map((b) => b.request),
  };
  const fadeIn = seconds(built[0]?.positions.fadeIn ?? null);
  if (fadeIn !== undefined) segment.fade_in = fadeIn;
  const fadeOut = seconds(built.at(-1)?.positions.fadeOut ?? null);
  if (fadeOut !== undefined) segment.fade_out = fadeOut;
  const crossIn = source.cueOverrides?.crossInMs ?? ctx.crossInMs;
  if (crossIn !== undefined) segment.cross_in = crossIn / 1000;
  const crossOut = segmentCrossOutMs(source);
  if (crossOut !== undefined) segment.cross_out = crossOut / 1000;
  return segment;
}

export function segmentCrossOutMs(source: SegmentSource): number | undefined {
  if (source.cueOverrides?.crossOutMs !== undefined) return source.cueOverrides.crossOutMs;
  const last = source.parts.at(-1);
  if (!last) return undefined;
  // A part's own crossOutMs means nothing inside a segment (contracts/log.ts).
  const cueOverrides = last.cueOverrides ? { ...last.cueOverrides, crossOutMs: undefined } : null;
  return crossOutMsOf({ ...last, cueOverrides });
}
