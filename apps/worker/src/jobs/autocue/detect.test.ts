import { type AutocueSettings, DEFAULT_AUTOCUE_SETTINGS } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { detectCues, type LoudnessSeries } from './detect.ts';

const RATE = 44_100;
const FRAME = 4410;

/** A piece of a series: `seconds` long, from `from` LUFS to `to` (linear in LU). */
type Part = { seconds: number; from: number; to?: number };
const silence = (seconds: number): Part => ({ seconds, from: -Infinity });
const level = (seconds: number, lufs: number): Part => ({ seconds, from: lufs });
const ramp = (seconds: number, from: number, to: number): Part => ({ seconds, from, to });

function series(parts: Part[], integratedLufs = -14, extra: Partial<LoudnessSeries> = {}) {
  const momentary: number[] = [];
  for (const part of parts) {
    const frames = Math.round((part.seconds * RATE) / FRAME);
    for (let i = 0; i < frames; i++) {
      const to = part.to ?? part.from;
      const step = frames === 1 || to === part.from ? 0 : (to - part.from) / (frames - 1);
      momentary.push(step === 0 ? part.from : part.from + step * i);
    }
  }
  return {
    sampleRate: RATE,
    frameSamples: FRAME,
    totalSamples: momentary.length * FRAME,
    momentary,
    integratedLufs,
    ...extra,
  } satisfies LoudnessSeries;
}

const at = (seconds: number) => Math.round(seconds * RATE);
const settings = (patch: Partial<AutocueSettings> = {}) => ({
  ...DEFAULT_AUTOCUE_SETTINGS,
  ...patch,
});

describe('detectCues', () => {
  it('trims silence at the head and the tail', () => {
    const cues = detectCues(series([silence(2), level(60, -14), silence(3)]), settings());
    expect(cues.cueIn).toBe(at(2));
    expect(cues.cueOut).toBe(at(62));
    // Loud to the last frame: no overlap, no fades, no intro.
    expect(cues.crossStartNext).toBe(at(62));
    expect(cues).toMatchObject({ introEnd: null, outroStart: null, fadeIn: null, fadeOut: null });
    expect(cues.flags).toEqual({
      silent: false,
      blankSkipped: false,
      longTail: false,
      sustained: false,
    });
  });

  it('positions are integer samples on the frame grid', () => {
    const cues = detectCues(series([silence(1.3), level(20, -14), silence(1)]), settings());
    for (const value of [cues.cueIn, cues.cueOut, cues.crossStartNext]) {
      expect(Number.isInteger(value)).toBe(true);
      expect((value ?? 0) % FRAME).toBe(0);
    }
  });

  it('snaps a cue-in within 0.4 s to the start', () => {
    const cues = detectCues(series([silence(0.3), level(30, -14)]), settings());
    expect(cues.cueIn).toBe(0);
  });

  it('counts only what is above I + silence, relative to the track', () => {
    // Noise floor at -60 LUFS: below -14 - 42 = -56, so it is trimmed like silence.
    const cues = detectCues(series([level(3, -60), level(30, -14), level(4, -60)]), settings());
    expect(cues.cueIn).toBe(at(3));
    expect(cues.cueOut).toBe(at(33));
  });

  it('refines cue-in and cue-out with frame peaks', () => {
    const base = series([silence(2), level(30, -14), silence(2)]);
    const peak = Array.from(base.momentary, (m) => (m === -Infinity ? -Infinity : -3));
    // The attack started two frames before the window got loud; the sound stopped a frame
    // before the window got quiet.
    peak[18] = -30;
    peak[19] = -30;
    peak[319] = -Infinity;
    const cues = detectCues({ ...base, peak }, settings());
    expect(cues.cueIn).toBe(18 * FRAME);
    expect(cues.cueOut).toBe(319 * FRAME);
  });

  it('starts the next track where a fade-out falls below I + overlay', () => {
    // 60 s at -14, then a 10 s fade to -70: below -22 after 8/56 of it, below -56 after 42/56.
    const cues = detectCues(series([level(60, -14), ramp(10, -14, -70), silence(2)]), settings());
    const fadeFrom = at(60);
    expect(cues.cueOut).toBeCloseTo(fadeFrom + at((10 * 42) / 56), -4);
    expect(cues.crossStartNext).toBeCloseTo(fadeFrom + at((10 * 8) / 56), -4);
    expect(cues.flags.sustained).toBe(false);
    expect(cues.flags.longTail).toBe(false);
    // A natural fade of about 6 s, ending at cue-out; it's an outro (≥ 5 s) too.
    expect(cues.fadeOut).toBe((cues.cueOut ?? 0) - (cues.crossStartNext ?? 0));
    expect(cues.outroStart).toBe(cues.crossStartNext);
  });

  it('starts the next track later on a long tail', () => {
    // A 40 s fade: 40 * 8/56 ≈ 5.7 s to -22, then ≈ 24 s more to -56: longer than 15 s.
    const cues = detectCues(series([level(60, -14), ramp(40, -14, -70)]), settings());
    expect(cues.flags.longTail).toBe(true);
    // Looked for again at -22 - 12 = -34: 40 * 20/56 ≈ 14.3 s into the fade.
    expect(cues.crossStartNext).toBeCloseTo(at(60 + (40 * 20) / 56), -4);
  });

  it('keeps a sustained ending playing before the next track starts', () => {
    // Held chord: drops just below -22 and stays there for 8 s, then stops.
    const held = series([level(60, -14), ramp(8, -23, -25), silence(1)]);
    const cues = detectCues(held, settings());
    expect(cues.flags.sustained).toBe(true);
    // At its own level (≈ -24.5) the chord is still "on" three quarters into it.
    expect(cues.crossStartNext).toBeCloseTo(at(66), -4);
    expect(cues.fadeOut).toBeNull();
    // Off: the overlay point is where the level first fell below -22.
    const off = detectCues(held, settings({ sustainedDropPercent: 0 }));
    expect(off.crossStartNext).toBe(at(60));
  });

  it('ends a track at a long silence followed by a hidden track', () => {
    const parts = [level(120, -14), silence(60), level(30, -14), silence(1)];
    const cues = detectCues(series(parts), settings());
    expect(cues.flags.blankSkipped).toBe(true);
    expect(cues.cueOut).toBe(at(120));
    expect(cues.crossStartNext).toBe(at(120));
    // Off, or shorter than the threshold: the hidden track plays.
    expect(detectCues(series(parts), settings({ blankSkipSeconds: 0 })).cueOut).toBe(at(210));
    expect(detectCues(series(parts), settings({ blankSkipSeconds: 90 })).cueOut).toBe(at(210));
  });

  it('keeps short pauses in the middle', () => {
    const cues = detectCues(series([level(30, -14), silence(4), level(30, -14)]), settings());
    expect(cues.flags.blankSkipped).toBe(false);
    expect(cues.cueOut).toBe(at(64));
  });

  it('marks a long ambient intro without calling it a fade', () => {
    // 20 s of quiet pad at -30 (above -56: it plays), then the song.
    const cues = detectCues(series([level(20, -30), level(120, -14)]), settings());
    expect(cues.cueIn).toBe(0);
    expect(cues.introEnd).toBe(at(20));
    expect(cues.fadeIn).toBeNull();
  });

  it('reports a natural fade-in', () => {
    const cues = detectCues(series([ramp(8, -50, -14), level(60, -14)]), settings());
    expect(cues.cueIn).toBe(0);
    // Above -22 after 28/36 of the ramp (6.2 s: an intro too).
    expect(cues.fadeIn).toBeCloseTo(at((8 * 28) / 36), -4);
    expect(cues.introEnd).toBe(cues.fadeIn);
  });

  it('handles a quiet track by its own loudness', () => {
    // A whole track at -45 LUFS: thresholds follow it (-87 and -53).
    const cues = detectCues(
      series([silence(1), level(90, -45), ramp(5, -45, -80), silence(1)], -45),
      settings(),
    );
    expect(cues.flags.silent).toBe(false);
    expect(cues.cueIn).toBe(at(1));
    expect(cues.crossStartNext).toBeCloseTo(at(91 + (5 * 8) / 35), -4);
    expect(cues.cueOut).toBeGreaterThan(at(95));
  });

  it('gives a silent track its whole length and nothing else', () => {
    const quiet = series([silence(30)], -Infinity);
    const cues = detectCues(quiet, settings());
    expect(cues).toMatchObject({
      cueIn: 0,
      cueOut: quiet.totalSamples,
      crossStartNext: null,
      introEnd: null,
      fadeIn: null,
      fadeOut: null,
    });
    expect(cues.flags.silent).toBe(true);
    // Gated out by the absolute gate (-70) too.
    expect(detectCues(series([level(30, -75)], -75), settings()).flags.silent).toBe(true);
  });

  it('fits the other points inside cue points a person set', () => {
    const s = series([level(60, -14), ramp(10, -14, -70), silence(2)]);
    // Cut in the middle of the song: the overlap stays before the person's cue-out.
    const cues = detectCues(s, settings(), { cueIn: at(5), cueOut: at(30) });
    expect(cues.cueIn).toBe(at(5));
    expect(cues.cueOut).toBe(at(30));
    expect(cues.crossStartNext).toBe(at(30));
    expect(cues.fadeOut).toBeNull();
    // A cue-in past the detected end keeps the file's end.
    const late = detectCues(s, settings(), { cueIn: at(69) });
    expect(late.cueOut).toBeGreaterThan(at(69));
  });

  it('uses the station thresholds', () => {
    const s = series([level(60, -14), ramp(10, -14, -70), silence(2)]);
    const strict = detectCues(s, settings({ overlayLu: -4 }));
    const loose = detectCues(s, settings({ overlayLu: -16 }));
    expect(strict.crossStartNext ?? 0).toBeLessThan(loose.crossStartNext ?? 0);
    const deep = detectCues(s, settings({ silenceLu: -50 }));
    expect(deep.cueOut).toBeGreaterThan(detectCues(s, settings()).cueOut);
  });
});
