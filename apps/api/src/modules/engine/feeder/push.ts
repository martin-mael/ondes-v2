import {
  type CueOverrides,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineSegmentPart,
  getPlayoutGain,
  PLAYOUT_SAMPLE_RATE,
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
  /** Voices to lay over the transition out of this entry (island fallback). */
  overlay?: readonly OverlayVoice[];
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
  if (ctx.overlay?.length) {
    // From its cue points when it has a cue-out (trims included), else from its length.
    const lengthMs = playLengthMs(source);
    const played =
      lastLengthSeconds(item) ?? (lengthMs === null ? null : Math.max(0, lengthMs - trimMs) / 1000);
    item.overlay = overlayAt(ctx.overlay, played);
  }
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
  if (ctx.overlay?.length) segment.overlay = overlayAt(ctx.overlay, lastLengthSeconds(segment));
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

// --- Island chains (#57, ADR 0024) ---------------------------------------------------------

/**
 * One body of an island chain: an item played from `from` to `to` (samples of its playout
 * copy). Null `from` is the item's own cue-in, null `to` its own end. The island's head body
 * ends at the island's head join; its tail body starts at the tail join.
 */
export type ChainBody = {
  kind: 'body';
  source: PushSource;
  from: number | null;
  to: number | null;
};

/** A rendered island inside a chain, played whole at 0 dB. */
export type ChainIsland = {
  kind: 'island';
  /** The engine `item_id`: `island:<spec hash>` (the as-run resolves it). */
  itemId: string;
  /** The rendered FLAC's own SHA-256 (its playout cache key, ADR 0018). */
  sha256: string;
  lengthSamples: number;
  title: string | null;
  artist: string | null;
};

/**
 * `A body, island, B body` (or a longer run, when islands follow one another), aired as one
 * `POST /v1/segment`. Its id is the head item's id: the planner sees the chain as one entry.
 */
export type ChainSource = {
  segmentId: string;
  steps: (ChainBody | ChainIsland)[];
  /** The head item's own `crossInMs` override (the head may have no body of its own). */
  crossInMs?: number | undefined;
};

/** The engine `item_id` of an island. */
export const islandEngineId = (hash: string) => `island:${hash}`;

/** Up to the next multiple of `grid`. */
const snapUp = (n: number, grid: number | null) =>
  grid && grid > 0 ? Math.ceil(n / grid) * grid : n;

/** Where a chain body starts and ends, in samples at `sr`, cue-in snapped up to the grid. */
export function chainBodyRange(body: ChainBody): { from: number; to: number; sr: number } | null {
  const p = positionsOf(body.source);
  const end = endOf(p, body.source.media);
  if (!end) return null;
  const sr = end.sr;
  const ownIn = p.cueIn && p.cueIn.sr === sr ? p.cueIn.n : 0;
  // Every seek into a body must land on the playout copy's grid (spike #12, ADR 0018 "Grid
  // snapping"): moved up, so it only ever shortens the body, never the island.
  const from = snapUp(body.from ?? ownIn, body.source.media.flacBlockSize);
  const to = body.to ?? end.n;
  return to > from ? { from, to, sr } : null;
}

/** Playing length of each step, in ms, in order (null when unknown). */
export function chainStepLengthsMs(source: ChainSource): (number | null)[] {
  return source.steps.map((step) => {
    if (step.kind === 'island')
      return Math.round((step.lengthSamples * 1000) / PLAYOUT_SAMPLE_RATE);
    const range = chainBodyRange(step);
    return range ? Math.round(((range.to - range.from) * 1000) / range.sr) : null;
  });
}

/**
 * `POST /v1/segment` body for an island chain, following spike #12 to the letter:
 * - bodies carry their own gain (`liq_amplify`), cue-ins on the grid, and cue points biased by
 *   half a sample (`(n − ½)/sr` with a cue-in, `cue_out = (n + ½)/sr` without);
 * - islands play whole with `liq_amplify` set explicitly to 0 dB, no cue points;
 * - nothing at the joins: fades and crossfades only on the way into and out of the chain.
 */
export function buildPushChain(source: ChainSource, ctx: PushContext): EnginePushSegment {
  const parts: EngineSegmentPart[] = [];
  for (const step of source.steps) {
    if (step.kind === 'island') {
      const part: EngineSegmentPart = {
        item_id: step.itemId,
        uri: playoutPath({ sha256: step.sha256, ext: 'flac' }, ctx.engineRoot),
        amplify_db: 0,
      };
      if (step.title) part.title = step.title;
      if (step.artist) part.artist = step.artist;
      parts.push(part);
      continue;
    }
    const range = chainBodyRange(step);
    if (!range) continue;
    const { media } = step.source;
    const part: EngineSegmentPart = {
      item_id: step.source.itemId,
      uri: playoutPath({ sha256: media.sha256, ext: media.ext }, ctx.engineRoot),
    };
    if (range.from > 0) part.cue_in = round6((range.from - 0.5) / range.sr);
    part.cue_out = round6((range.to + (range.from > 0 ? -0.5 : 0.5)) / range.sr);
    const amplify = gainOf(step.source, ctx.station);
    if (amplify !== undefined) part.amplify_db = amplify;
    const title = step.source.title ?? media.title;
    if (title) part.title = title;
    if (media.artists.length) part.artist = media.artists.join(', ');
    parts.push(part);
  }
  const segment: EnginePushSegment = { segment_id: source.segmentId, parts };
  const first = source.steps[0];
  const last = source.steps.at(-1);
  // A fade-in only when the chain starts on a body that starts at its own cue-in; a fade-out
  // only when it ends on a body that ends at its own end.
  if (first?.kind === 'body' && first.from === null) {
    const fadeIn = seconds(positionsOf(first.source).fadeIn);
    if (fadeIn !== undefined) segment.fade_in = fadeIn;
  }
  if (last?.kind === 'body' && last.to === null) {
    const fadeOut = seconds(positionsOf(last.source).fadeOut);
    if (fadeOut !== undefined) segment.fade_out = fadeOut;
  }
  const crossIn = source.crossInMs ?? ctx.crossInMs;
  if (crossIn !== undefined) segment.cross_in = crossIn / 1000;
  const crossOut = chainCrossOutMs(source);
  if (crossOut !== undefined) segment.cross_out = crossOut / 1000;
  if (ctx.overlay?.length) {
    // A chain ending on an island has no cue-out to read its length from: use the island's.
    const lastMs = chainStepLengthsMs(source).at(-1);
    const length = last?.kind === 'island' && lastMs != null ? lastMs / 1000 : null;
    segment.overlay = overlayAt(ctx.overlay, length ?? lastLengthSeconds(segment));
  }
  return segment;
}

/** The chain's overlap into the next entry: its tail item's, when the chain ends on a body. */
export function chainCrossOutMs(source: ChainSource): number | undefined {
  const last = source.steps.at(-1);
  if (last?.kind !== 'body' || last.to !== null) return undefined;
  return crossOutMsOf(last.source);
}

// --- Voice overlay (the island fallback, #57) ------------------------------------------------

/**
 * A voice to lay over the transition out of an entry when its island can't air. `start` is in
 * seconds relative to the end of the entry's last request (the segue axis, ADR 0017: negative
 * starts before A's end).
 */
export type OverlayVoice = {
  uri: string;
  start: number;
  duration: number;
  cueIn?: number;
  cueOut?: number;
  amplifyDb?: number;
  duckDb?: number;
};

/** How long the last request of a body plays, from its cue points; null when unknown. */
function lastLengthSeconds(body: EnginePushItem | EnginePushSegment): number | null {
  const last = 'parts' in body ? body.parts.at(-1) : body;
  if (last?.cue_out === undefined) return null;
  return last.cue_out - (last.cue_in ?? 0);
}

function overlayAt(voices: readonly OverlayVoice[], length: number | null) {
  return voices.map((v) => {
    const voice: NonNullable<EnginePushItem['overlay']>[number] = {
      uri: v.uri,
      at: round6(Math.max(0, (length ?? 0) + v.start)),
      duration: round6(v.duration),
    };
    if (v.cueIn !== undefined) voice.cue_in = v.cueIn;
    if (v.cueOut !== undefined) voice.cue_out = v.cueOut;
    if (v.amplifyDb !== undefined) voice.amplify_db = v.amplifyDb;
    if (v.duckDb !== undefined) voice.duck_db = v.duckDb;
    return voice;
  });
}
