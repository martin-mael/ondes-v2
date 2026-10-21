import type { AutocueSettings } from '@ondes/shared';

// Cue-point detection over a frame-loudness series (#20). Pure: the job feeds it the frames
// ffmpeg's ebur128 filter measured on the playout copy (frames.ts); tests feed it synthetic
// series.
//
// The thresholds and their logic are ported from Moonbase59's autocue (`cue_file`, v4.1.1,
// https://github.com/Moonbase59/autocue, MIT License, Copyright (c) 2024 Matthias C. Hormann):
// levels relative to the integrated loudness I, cue-in and cue-out where the momentary
// loudness crosses I + silence, the next track's start where the ending falls below
// I + overlay, the long-tail rule, the sustained-ending rule and blank skipping. Differences:
//
// - positions are integer samples on the frame grid, not seconds, and cue-out is the *end* of
//   the last loud frame (autocue takes its start, which can clip a tenth of a second);
// - per-frame sample peaks, when given, refine cue-in and cue-out within the 400 ms momentary
//   window (a soft attack that the window only catches late is not cut);
// - the sustained-ending drop is measured in perceived loudness (sones), not as a ratio of
//   LUFS values;
// - blank skipping is on by default (10 s): a hidden track after minutes of silence is dead
//   air on a radio;
// - fades, intro and outro markers, which autocue reserves but doesn't compute, are derived
//   from the same series (see {@link detectCues});
// - a silent track gets its whole length and nothing else, rather than failing.

/** One momentary window is four 100 ms frames. */
const WINDOW_FRAMES = 4;
/** autocue: a cue-in this close to the start is the start. */
const SNAP_TO_START_SECONDS = 0.4;
/** EBU R128's absolute gate: an integrated loudness at or below it is silence. */
const SILENCE_LUFS = -70;
/** Floor for averaging levels (`-Infinity` is digital silence). */
const FLOOR_LUFS = -120;
/** Shortest natural fade-in or fade-out we report. */
const MIN_FADE_SECONDS = 1;
/** A fade climbs or falls at least this much between its two halves. */
const FADE_LU = 6;

export interface LoudnessSeries {
  sampleRate: number;
  /** Samples per frame; frame `i` starts at `i * frameSamples` (the last may be shorter). */
  frameSamples: number;
  /** Length of the audio in samples. */
  totalSamples: number;
  /**
   * Momentary loudness (LUFS) of the 400 ms window ending at each frame's end. `-Infinity`
   * for digital silence.
   */
  momentary: ArrayLike<number>;
  /** Sample peak of each frame, in dBFS (optional; `NaN`: unknown). */
  peak?: ArrayLike<number>;
  /** Integrated loudness of the whole file, in LUFS. */
  integratedLufs: number;
}

/** Points that stay as they are (set or locked by a person); the others fit inside them. */
export interface FixedCues {
  cueIn?: number;
  cueOut?: number;
}

export interface DetectedCues {
  cueIn: number;
  cueOut: number;
  /** End of a quieter opening (ambient intro, slow build), as a position. */
  introEnd: number | null;
  /** Start of a quieter ending, as a position. */
  outroStart: number | null;
  /** Length of a natural fade-in from `cueIn`, in samples. */
  fadeIn: number | null;
  /** Length of a natural fade-out ending at `cueOut`, in samples. */
  fadeOut: number | null;
  /** Where the next track may start. */
  crossStartNext: number | null;
  /** How the points were found, for logs and tests. */
  flags: {
    silent: boolean;
    blankSkipped: boolean;
    longTail: boolean;
    sustained: boolean;
  };
}

export function detectCues(
  series: LoudnessSeries,
  settings: AutocueSettings,
  fixed: FixedCues = {},
): DetectedCues {
  const { sampleRate: rate, frameSamples: size, totalSamples: total, integratedLufs: I } = series;
  const m = series.momentary;
  const n = Math.min(m.length, Math.ceil(total / size));
  const start = (i: number) => Math.min(i * size, total);
  const end = (i: number) => Math.min((i + 1) * size, total);
  const frameAt = (samples: number) => Math.max(0, Math.min(n - 1, Math.floor(samples / size)));
  const seconds = (s: number) => Math.round(s * rate);

  const flags = { silent: false, blankSkipped: false, longTail: false, sustained: false };
  const bounds = (cueIn: number, cueOut: number) => {
    const inPos = fixed.cueIn ?? cueIn;
    let outPos = fixed.cueOut ?? cueOut;
    // A person's cue-in after the detected end: keep the file's end.
    if (outPos <= inPos) outPos = Math.max(total, inPos + 1);
    return { cueIn: inPos, cueOut: outPos };
  };
  const silentResult = (): DetectedCues => ({
    ...bounds(0, total),
    introEnd: null,
    outroStart: null,
    fadeIn: null,
    fadeOut: null,
    crossStartNext: null,
    flags: { ...flags, silent: true },
  });

  if (n === 0 || !(I > SILENCE_LUFS)) return silentResult();
  const silence = I + settings.silenceLu;
  const loud = (i: number) => (m[i] ?? -Infinity) > silence;
  const peak = series.peak;
  /** The frame has sound in it; an unknown peak (`NaN`) counts as sound. */
  const audible = (i: number) => {
    const p = peak?.[i] ?? Number.NaN;
    return Number.isNaN(p) || p > silence;
  };

  let first = 0;
  while (first < n && !loud(first)) first++;
  if (first === n) return silentResult();
  let last = n - 1;
  while (!loud(last)) last--;

  // Cue-in: the window first gets loud at `first`, but its 400 ms may have started earlier.
  let inFrame = first;
  if (peak) {
    for (let k = 1; k < WINDOW_FRAMES && inFrame > 0 && audible(inFrame - 1); k++) inFrame--;
  }
  let cueIn = start(inFrame);
  if (cueIn < seconds(SNAP_TO_START_SECONDS)) cueIn = 0;

  // Cue-out: the window stays loud up to 300 ms after the sound stops; the peaks say where.
  const endAfter = (lastLoud: number) => {
    let k = lastLoud;
    if (peak) {
      for (let j = 1; j < WINDOW_FRAMES && k > inFrame && !audible(k); j++) k--;
    }
    return end(k);
  };
  let cueOut = endAfter(last);

  // Blank skip: a long silence followed by more sound (a hidden track) ends the track there.
  if (settings.blankSkipSeconds > 0 && fixed.cueOut === undefined) {
    const minBlank = seconds(settings.blankSkipSeconds);
    for (let i = first; i < last; i++) {
      if (loud(i)) continue;
      let j = i;
      while (j < last && !loud(j)) j++;
      if (start(j) - start(i) >= minBlank) {
        cueOut = endAfter(i - 1);
        flags.blankSkipped = true;
        break;
      }
      i = j;
    }
  }

  ({ cueIn, cueOut } = bounds(cueIn, cueOut));
  const a = frameAt(cueIn);
  const b = frameAt(cueOut - 1);
  const clamp = (pos: number) => Math.max(cueIn, Math.min(cueOut, pos));
  const level = (i: number) => Math.max(FLOOR_LUFS, m[i] ?? -Infinity);
  const mean = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += level(i);
    return to > from ? sum / (to - from) : FLOOR_LUFS;
  };
  /** End of the last frame in [a, b] louder than `lufs`, or `null`. */
  const lastAbove = (lufs: number) => {
    for (let i = b; i >= a; i--) if ((m[i] ?? -Infinity) > lufs) return clamp(end(i));
    return null;
  };

  // Next track: where the ending falls below I + overlay (autocue's `liq_cross_start_next`).
  const overlay = I + settings.overlayLu;
  const lower = overlay + settings.longTailExtraLu;
  const crossNormal = lastAbove(overlay) ?? cueOut;
  let crossStartNext = crossNormal;

  // Sustained ending: the part after the overlay point barely gets quieter (a held chord):
  // look again, at its own level, so the next track doesn't start over it.
  const tailFrom = frameAt(crossNormal);
  const tailMid = Math.floor((tailFrom + b + 1) / 2);
  const y1 = mean(tailFrom, tailMid);
  const y2 = mean(tailMid, b + 1);
  // Perceived loudness halves every 10 LU (sones). autocue divides the LUFS values instead,
  // which calls a plain fade from -22 to -56 LUFS "sustained".
  const dropPercent = (1 - 2 ** ((y2 - y1) / 10)) * 100;
  if (settings.sustainedDropPercent > 0 && b - tailFrom >= 1) {
    if (dropPercent < settings.sustainedDropPercent) {
      flags.sustained = true;
      crossStartNext = Math.max(crossStartNext, lastAbove(Math.max(y2, lower)) ?? cueOut);
    }
  }
  // Long tail: an ending longer than `longTailSeconds` below the overlay level (a long fade,
  // a reverb tail) starts the next track at a lower level.
  if (cueOut - crossNormal > seconds(settings.longTailSeconds)) {
    flags.longTail = true;
    crossStartNext = Math.max(crossStartNext, lastAbove(lower) ?? cueOut);
  }

  const tail = cueOut - crossNormal;
  const fading = !flags.sustained && y1 - y2 >= FADE_LU && tail >= seconds(MIN_FADE_SECONDS);
  const outroStart = tail >= seconds(settings.minIntroSeconds) ? crossNormal : null;

  // Opening: from cue-in to the first frame above the overlay level.
  let ramp = a;
  while (ramp <= b && (m[ramp] ?? -Infinity) <= overlay) ramp++;
  const rampPos = ramp <= b ? clamp(start(ramp)) : null;
  const head = rampPos === null ? 0 : rampPos - cueIn;
  const headMid = Math.floor((a + ramp) / 2);
  const fadingIn =
    head >= seconds(MIN_FADE_SECONDS) && mean(headMid, ramp) - mean(a, headMid) >= FADE_LU;
  const introEnd = rampPos !== null && head >= seconds(settings.minIntroSeconds) ? rampPos : null;

  return {
    cueIn,
    cueOut,
    introEnd,
    outroStart,
    fadeIn: fadingIn ? head : null,
    fadeOut: fading ? tail : null,
    crossStartNext,
    flags,
  };
}
