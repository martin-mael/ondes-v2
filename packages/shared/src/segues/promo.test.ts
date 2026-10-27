import { describe, expect, it } from 'vitest';
import { PLAYOUT_FLAC_BLOCK_SIZE, PLAYOUT_SAMPLE_RATE } from '../contracts/library.ts';
import { envelopeGainAt } from './gain.ts';
import { checkSegue, type IslandMedia } from './island.ts';
import { DEFAULT_DUCK, duckEnvelopes, type PlacementMedia } from './placement.ts';
import { defaultPromoLanes } from './promo.ts';

// Default promo segues (#60, ADR 0032): the voice over A's outro and B's intro from their cue
// markers, B never earlier than its natural start, and the owner's default ducking.

const SR = PLAYOUT_SAMPLE_RATE;
const s = (seconds: number) => Math.round(seconds * SR);
const VOICE = '00000000-0000-7000-8e01-000000000001';

/** A 3-minute song: cue-in at 1 s, cue-out at 179 s. */
const songA = (extra: Partial<PlacementMedia> = {}): PlacementMedia => ({
  cueIn: s(1),
  cueOut: s(179),
  ...extra,
});
const songB = songA;
const voice = (seconds: number) => ({ assetId: VOICE, cueIn: 0, cueOut: s(seconds) });

const media = (assetId: string, m: { cueIn: number; cueOut: number }): IslandMedia => ({
  assetId,
  sha256: 'a'.repeat(64),
  storageKey: 'k',
  sampleRate: SR,
  durationSamples: s(180),
  flacBlockSize: PLAYOUT_FLAC_BLOCK_SIZE,
  gainDb: 0,
  cueIn: m.cueIn,
  cueOut: m.cueOut,
});

describe('defaultPromoLanes', () => {
  it('talks over the outro and ends where B’s vocals come in (hitting the post)', () => {
    // A's outro: the last 12 s, its natural crossfade 7 s; B's intro: 8 s; voice: 15 s.
    const a = songA({ outroStart: s(167), crossStartNext: s(172) });
    const b = songB({ introEnd: s(9) });
    const lanes = defaultPromoLanes(a, b, voice(15));
    const v = lanes.voices[0];
    expect(v?.start).toBe(-s(12));
    // Voice ends at +3 s; B's intro (8 s) ends with it: B starts at −5 s.
    expect(lanes.in.start).toBe(-s(5));
    expect((v?.start ?? 0) + s(15)).toBe(lanes.in.start + s(8));
  });

  it('moves a short voice later rather than starting B before its natural start', () => {
    const a = songA({ outroStart: s(167), crossStartNext: s(176) });
    const b = songB({ introEnd: s(3) });
    const lanes = defaultPromoLanes(a, b, voice(4));
    // Natural start −3 s; voice ends at B's intro end: −3 + 2 s = −1 s; it starts at −5 s.
    expect(lanes.in.start).toBe(-s(3));
    expect(lanes.voices[0]?.start).toBe(-s(5));
  });

  it('delays B for a voice longer than the instrumental parts', () => {
    const a = songA({ outroStart: s(175) });
    const b = songB({ introEnd: s(3) });
    const lanes = defaultPromoLanes(a, b, voice(30));
    expect(lanes.voices[0]?.start).toBe(-s(4));
    expect(lanes.in.start).toBe(s(24));
  });

  it('without markers: the voice between A and B', () => {
    const lanes = defaultPromoLanes(songA(), songB(), voice(10));
    expect(lanes.voices[0]?.start).toBe(0);
    expect(lanes.in.start).toBe(s(10));
    // Nothing to duck in A (the voice starts after it), B starts after the voice.
    expect(lanes.out.envelope).toEqual([]);
    expect(lanes.in.envelope).toEqual([]);
  });

  it('ignores markers outside the cues', () => {
    const lanes = defaultPromoLanes(
      songA({ outroStart: s(0.5), crossStartNext: s(200) }),
      songB({ introEnd: s(0.2) }),
      voice(5),
    );
    expect(lanes.voices[0]?.start).toBe(0);
    expect(lanes.in.start).toBe(s(5));
  });

  it('ducks A and B 8 dB under the voice with 300 ms ramps', () => {
    const a = songA({ outroStart: s(167), crossStartNext: s(176) });
    const b = songB({ introEnd: s(9) });
    const lanes = defaultPromoLanes(a, b, voice(15));
    const start = lanes.voices[0]?.start ?? 0;
    const end = start + s(15);
    expect(envelopeGainAt(lanes.out.envelope, start - s(1))).toBe(1);
    expect(envelopeGainAt(lanes.out.envelope, start)).toBeCloseTo(10 ** (-8 / 20));
    expect(envelopeGainAt(lanes.in.envelope, lanes.in.start)).toBeCloseTo(10 ** (-8 / 20));
    expect(envelopeGainAt(lanes.in.envelope, end + s(0.3))).toBe(1);
    expect(lanes.out.envelope).toEqual(duckEnvelopes({ start, end }, lanes.in.start).out);
    expect(DEFAULT_DUCK).toEqual({ depthDb: -8, rampMs: 300 });
  });

  it('gives a segue the island derivation accepts', () => {
    for (const [a, b, seconds] of [
      [songA({ outroStart: s(167), crossStartNext: s(176) }), songB({ introEnd: s(9) }), 15],
      [songA({ outroStart: s(175) }), songB({ introEnd: s(3) }), 30],
      [songA(), songB(), 10],
      [songA({ crossStartNext: s(170) }), songB(), 60],
    ] as const) {
      const lanes = defaultPromoLanes(a, b, voice(seconds));
      const problem = checkSegue({
        segueId: 's',
        fromItemId: 'a',
        toItemId: 'b',
        from: media('a', a),
        to: media('b', b),
        out: lanes.out,
        in: lanes.in,
        voices: lanes.voices.map((v) => ({ ...v, media: media(VOICE, voice(seconds)) })),
      });
      expect(problem).toBeNull();
    }
  });
});

describe('defaultPromoLanes: bounds and B’s duck (review)', () => {
  it('keeps the voice within 30 s of A’s end, whatever the outro', () => {
    // A 60 s outro (crossfade 30 s): the voice would start a minute early; 30 s at most.
    const lanes = defaultPromoLanes(
      songA({ outroStart: s(119), crossStartNext: s(149) }),
      songB(),
      voice(10),
    );
    expect(lanes.voices[0]?.start).toBe(-s(30));
    // A long intro and a short voice: it would start 56 s after A's end; 30 s at most.
    const late = defaultPromoLanes(songA(), songB({ introEnd: s(61) }), voice(4));
    expect(late.voices[0]?.start).toBe(s(30));
  });

  it('without an outro marker, the voice starts at B’s natural start', () => {
    const lanes = defaultPromoLanes(songA({ crossStartNext: s(175) }), songB(), voice(10));
    expect(lanes.voices[0]?.start).toBe(-s(4));
  });

  it('ducks B only from where the voice comes in, like A', () => {
    // A short voice over a long intro: B (natural start −3 s) plays alone first, then ducks.
    const lanes = defaultPromoLanes(
      songA({ outroStart: s(167), crossStartNext: s(176) }),
      songB({ introEnd: s(9) }),
      voice(4),
    );
    const start = lanes.voices[0]?.start ?? 0;
    expect(lanes.in.start).toBeLessThan(start);
    expect(envelopeGainAt(lanes.in.envelope, lanes.in.start)).toBe(1);
    expect(envelopeGainAt(lanes.in.envelope, start)).toBeCloseTo(10 ** (-8 / 20));
    expect(envelopeGainAt(lanes.in.envelope, start + s(4) + s(0.3))).toBe(1);
  });
});
