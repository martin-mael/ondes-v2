// Island model for the splice tests: timings, the ffmpeg island renderer, the ideal
// reference splice and the cue points the engine gets.
//
// Island time u runs from 0 (the A→island join) to L (the end of the island):
//   A:  plays at gA, ducks to DUCK over [0.30, 0.60] s, fades out over [2.40, 3.00] s
//   VT: starts at 0.50 s (its own 20 ms fades), gain 0 dB
//   B:  fades in from silence over [2.20, 2.80] s, starting at B-time `bEnter`
// The first and last `handle` samples of the island are pure A×gA and pure B×gB, so the
// engine can either butt-splice or micro-crossfade over them.
import { type Audio, concat, dbToLinear, ffmpeg, SAMPLE_RATE, slice } from './audio.ts';

const sec = (s: number) => Math.round(s * SAMPLE_RATE);

export type Plan = {
  sampleRate: number;
  /** A body starts here (a seek into A). */
  aCueIn: number;
  /** A-time of the A→island join. */
  aJoin: number;
  /** B-time where B enters the island. */
  bEnter: number;
  /** Island length. */
  length: number;
  /** Handle (= micro-crossfade length) on each side. */
  handle: number;
  gainA: number;
  gainB: number;
  /** Island-time constants, in seconds. */
  envelope: {
    duckStart: number;
    duckEnd: number;
    duck: number;
    aOutStart: number;
    aOutEnd: number;
  };
  vtStart: number;
  bStart: number;
  bFullAt: number;
};

/**
 * Packet grid of a playout copy, in decoded samples: packet k starts at offset + k * size.
 * Liquidsoap 2.4 only seeks exactly to packet starts (see README), so every cue-in the
 * engine receives is snapped onto this grid.
 */
export type Grid = { size: number; offset: number };

const snapUp = (n: number, g: Grid) => g.offset + Math.ceil((n - g.offset) / g.size) * g.size;

export type Splice = 'butt' | 'micro';

/**
 * Odd sample positions on purpose: nothing lines up with frames or codec packets unless
 * `grid` is given, in which case the A cue-in is moved up to the next packet and the
 * island is extended (by less than one packet) so that the B cue-in lands on one too.
 */
export function makePlan(options: { handle?: number; splice: Splice; grid?: Grid }): Plan {
  const { handle = 441, splice, grid } = options;
  let aCueIn = 88_211;
  const bEnter = 308_737;
  let length = sec(3.2);
  if (grid) {
    aCueIn = snapUp(aCueIn, grid);
    const bCue = (len: number) => bEnter + len - sec(2.2) - (splice === 'micro' ? handle : 0);
    length += snapUp(bCue(length), grid) - bCue(length);
  }
  return {
    sampleRate: SAMPLE_RATE,
    aCueIn,
    aJoin: 529_417,
    bEnter,
    length,
    handle,
    gainA: -3.5,
    gainB: -1.5,
    envelope: { duckStart: 0.3, duckEnd: 0.6, duck: 0.25, aOutStart: 2.4, aOutEnd: 3.0 },
    vtStart: 0.5,
    bStart: 2.2,
    bFullAt: 2.8,
  };
}

/** B-time at island time L - handle: where the island's B handle begins. */
export const bJoin = (p: Plan): number => p.bEnter + (p.length - p.handle) - sec(p.bStart);

/** Piecewise-linear ramp from `from` to `to` over [t0, t1], as an ffmpeg expression in t. */
const ramp = (t0: number, t1: number, from: number, to: number) =>
  `if(lt(t,${t0}),${from},if(lt(t,${t1}),${from}+(${to - from})*(t-${t0})/${t1 - t0},${to}))`;

/**
 * Renders the island with ffmpeg into a 24-bit FLAC. Gains are applied exactly as the
 * engine applies `liq_amplify` (linear 10^(dB/20)), per sample through `aeval`.
 */
export function renderIsland(
  p: Plan,
  src: { a: string; vt: string; b: string },
  out: string,
): void {
  const e = p.envelope;
  const gA = dbToLinear(p.gainA);
  const gB = dbToLinear(p.gainB);
  const envA = `${ramp(e.duckStart, e.duckEnd, 1, e.duck)}*${ramp(e.aOutStart, e.aOutEnd, 1, 0)}`;
  const envB = ramp(p.bStart, p.bFullAt, 0, 1);
  const bLen = p.length - sec(p.bStart);
  const graph = [
    `[0:a]atrim=start_sample=${p.aJoin}:end_sample=${p.aJoin + p.length},asetpts=PTS-STARTPTS,` +
      `aeval='val(0)*${gA}*${envA}|val(1)*${gA}*${envA}'[a]`,
    `[1:a]adelay=delays=${sec(p.vtStart)}S:all=1[v]`,
    `[2:a]atrim=start_sample=${p.bEnter}:end_sample=${p.bEnter + bLen},asetpts=PTS-STARTPTS,` +
      `adelay=delays=${sec(p.bStart)}S:all=1,aeval='val(0)*${gB}*${envB}|val(1)*${gB}*${envB}'[b]`,
    `[a][v][b]amix=inputs=3:normalize=0:duration=first,atrim=end_sample=${p.length}[out]`,
  ].join(';');
  ffmpeg([
    '-i',
    src.a,
    '-i',
    src.vt,
    '-i',
    src.b,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-ar',
    String(p.sampleRate),
    '-c:a',
    'flac',
    '-sample_fmt',
    's32',
    out,
  ]);
}

/**
 * The ideal splice: A[aCueIn, aJoin)·gA ++ island[0, L - handle) ++ B[bJoin, end)·gB.
 * Both engine modes (butt splice and micro-crossfade) should reproduce it exactly.
 */
export function reference(p: Plan, a: Audio, island: Audio, b: Audio): Audio {
  const gA = dbToLinear(p.gainA);
  const gB = dbToLinear(p.gainB);
  const scale = (x: Audio, g: number): Audio => ({
    sampleRate: x.sampleRate,
    channels: x.channels.map((ch) => ch.map((v) => v * g)),
  });
  const bStart = bJoin(p);
  return concat([
    scale(slice(a, p.aCueIn, p.aJoin - p.aCueIn), gA),
    slice(island, 0, p.length - p.handle),
    scale(slice(b, bStart, (b.channels[0]?.length ?? 0) - bStart), gB),
  ]);
}

/** Reference positions of the two joins. */
export function joins(p: Plan, splice: Splice) {
  const first = p.aJoin - p.aCueIn;
  return splice === 'butt'
    ? [
        { at: first, span: 0, label: 'A→island' },
        { at: first + p.length, span: 0, label: 'island→B' },
      ]
    : [
        { at: first, span: p.handle, label: 'A→island' },
        { at: first + p.length - p.handle, span: p.handle, label: 'island→B' },
      ];
}

/**
 * Sample position → `liq_cue_in` / `liq_cue_out` seconds for Liquidsoap 2.4.
 *
 * On a request that has a cue-in, Liquidsoap plays ceil(out·sr) − ceil(in·sr) samples; on a
 * request without one, it stops at floor(out·sr). n/sr is rarely exact in binary, so a
 * plain n/sr can land one sample off either way. Biasing by half a sample makes the
 * rounding unambiguous: (n − ½)/sr when the request has a cue-in, (n + ½)/sr otherwise.
 */
export function liqSeconds(n: number, sampleRate: number, hasCueIn: boolean): string {
  return ((n + (hasCueIn ? -0.5 : 0.5)) / sampleRate).toFixed(9);
}

/** Cue points (seconds) for each of the three tracks the engine plays. */
export function cues(p: Plan, splice: Splice) {
  const s = (n: number) => liqSeconds(n, p.sampleRate, true);
  const extra = splice === 'micro' ? p.handle : 0;
  return {
    a: { cueIn: s(p.aCueIn), cueOut: s(p.aJoin + extra) },
    // Butt: B starts after the island's B handle. Micro: B overlaps it.
    b: { cueIn: s(bJoin(p) + (splice === 'butt' ? p.handle : 0)) },
  };
}
