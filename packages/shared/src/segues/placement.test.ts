import { describe, expect, it } from 'vitest';
import { PLAYOUT_FLAC_BLOCK_SIZE, PLAYOUT_SAMPLE_RATE } from '../contracts/library.ts';
import { SEGUE_MAX_VOICES } from '../contracts/segues.ts';
import { envelopeGainAt } from './gain.ts';
import { checkSegue, deriveIslands, type IslandMedia } from './island.ts';
import {
  autoPlacement,
  DEFAULT_BED,
  DEFAULT_DUCK,
  duckEnvelopes,
  type PlacementBed,
  type PlacementMedia,
  type PlacementOptions,
  type PlacementReport,
  type PlacementVoice,
  VOICE_GAP_MS,
} from './placement.ts';

// Smart default VT placement (#61, ADR 0037). A deterministic case set over the markers that
// decide it (outro start, crossfade start, intro end) and the voice length, then the edge cases
// one by one. Every case must give a segue the island derivation accepts.

const SR = PLAYOUT_SAMPLE_RATE;
const s = (seconds: number) => Math.round(seconds * SR);
const VOICE = '00000000-0000-7000-8e01-000000000001';
const VOICE2 = '00000000-0000-7000-8e01-000000000002';
const BED = '00000000-0000-7000-8e01-0000000000be';

/** A 3-minute song: cue-in at 1 s, cue-out at 179 s. */
const song = (extra: Partial<PlacementMedia> = {}): PlacementMedia => ({
  cueIn: s(1),
  cueOut: s(179),
  ...extra,
});
const voice = (seconds: number, assetId = VOICE): PlacementVoice => ({
  assetId,
  cueIn: 0,
  cueOut: s(seconds),
});
const bed = (seconds = 60): PlacementBed => ({ assetId: BED, cueIn: 0, cueOut: s(seconds) });

const islandMedia = (assetId: string, m: { cueIn: number; cueOut: number }): IslandMedia => ({
  assetId,
  sha256: assetId.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
  storageKey: assetId,
  sampleRate: SR,
  durationSamples: Math.max(m.cueOut, s(180)),
  flacBlockSize: PLAYOUT_FLAC_BLOCK_SIZE,
  gainDb: 0,
  cueIn: m.cueIn,
  cueOut: m.cueOut,
});

/** Checks the placement the way the api's sync does, and derives its island. */
function check(
  a: PlacementMedia,
  b: PlacementMedia,
  voices: readonly PlacementVoice[],
  options: PlacementOptions = {},
) {
  const placed = autoPlacement(a, b, voices, options);
  const mediaOf = (assetId: string) => {
    if (assetId === BED && options.bed) return islandMedia(BED, options.bed);
    const v = voices.find((x) => x.assetId === assetId);
    if (!v) throw new Error(`no voice ${assetId}`);
    return islandMedia(assetId, { cueIn: 0, cueOut: Math.max(v.cueOut, s(1)) });
  };
  const input = {
    segueId: 's',
    fromItemId: 'a',
    toItemId: 'b',
    from: islandMedia('a', a),
    to: islandMedia('b', b),
    out: placed.lanes.out,
    in: placed.lanes.in,
    voices: placed.lanes.voices.map((v) => ({ ...v, media: mediaOf(v.assetId) })),
  };
  const problem = checkSegue(input);
  return { ...placed, problem, islands: problem ? [] : deriveIslands([input]) };
}

const end = (lanes: { voices: { start: number }[] }, lengths: number[]) =>
  (lanes.voices.at(-1)?.start ?? 0) + (lengths.at(-1) ?? 0);

// --- The case set ------------------------------------------------------------------------

type Case = {
  name: string;
  a: PlacementMedia;
  b: PlacementMedia;
  voice: number;
  bed?: boolean;
  expect: Partial<PlacementReport> & { voiceStart?: number; inStart?: number };
};

/**
 * Outro 12 s (crossfade at 7 s from the end), intro 8 s unless the case says otherwise. Voice
 * lengths cover "fits easily", "fits exactly", "a bit long", "much longer than both".
 */
const CASES: Case[] = [
  {
    name: 'short voice over a long intro: B at its natural start, the voice ends on the post',
    a: song({ outroStart: s(167), crossStartNext: s(172) }),
    b: song({ introEnd: s(9) }),
    voice: 5,
    expect: { fit: 'post', delay: 0, dry: 0, voiceStart: -s(7) + s(8) - s(5), inStart: -s(7) },
  },
  {
    name: 'voice exactly filling outro + intro',
    a: song({ outroStart: s(167), crossStartNext: s(172) }),
    b: song({ introEnd: s(9) }),
    voice: 13,
    expect: { fit: 'post', delay: 0, voiceStart: -s(12), inStart: -s(7) },
  },
  {
    name: 'voice a bit long: starts with the outro, B waits',
    a: song({ outroStart: s(167), crossStartNext: s(172) }),
    b: song({ introEnd: s(9) }),
    voice: 15,
    expect: { fit: 'delayed', delay: s(2), dry: 0, voiceStart: -s(12), inStart: -s(5) },
  },
  {
    name: 'VT longer than both: B starts after A has ended, the voice alone in between',
    a: song({ outroStart: s(174), crossStartNext: s(176) }),
    b: song({ introEnd: s(4) }),
    voice: 20,
    expect: { fit: 'delayed', voiceStart: -s(5), inStart: s(12), dry: s(12), bed: false },
  },
  {
    name: 'VT longer than both, with a bed: the bed covers the dry stretch',
    a: song({ outroStart: s(174), crossStartNext: s(176) }),
    b: song({ introEnd: s(4) }),
    voice: 20,
    bed: true,
    expect: { fit: 'delayed', inStart: s(12), dry: s(12), bed: true },
  },
  {
    name: 'no intro marker: B comes in as the voice ends',
    a: song({ outroStart: s(167), crossStartNext: s(172) }),
    b: song(),
    voice: 4,
    expect: { fit: 'post', voiceStart: -s(7) - s(4), inStart: -s(7) },
  },
  {
    name: 'no intro marker, voice a little longer than outro to crossfade: B waits a second',
    a: song({ outroStart: s(167), crossStartNext: s(172) }),
    b: song(),
    voice: 6,
    expect: { fit: 'delayed', delay: s(1), voiceStart: -s(12), inStart: -s(6) },
  },
  {
    name: 'no intro marker, voice longer than the outro: B waits for it',
    a: song({ outroStart: s(171), crossStartNext: s(172) }),
    b: song(),
    voice: 10,
    expect: { fit: 'delayed', voiceStart: -s(8), inStart: s(2), dry: s(2) },
  },
  {
    name: 'no outro marker: the voice starts at B’s natural start, never over A’s vocals',
    a: song({ crossStartNext: s(175) }),
    b: song({ introEnd: s(9) }),
    voice: 10,
    expect: { fit: 'delayed', voiceStart: -s(4), inStart: -s(2) },
  },
  {
    name: 'no markers at all: a dry VT between A and B',
    a: song(),
    b: song(),
    voice: 8,
    expect: { fit: 'delayed', voiceStart: 0, inStart: s(8), dry: s(8) },
  },
  {
    name: 'no markers at all, with a bed',
    a: song(),
    b: song(),
    voice: 8,
    bed: true,
    expect: { voiceStart: 0, inStart: s(8), dry: s(8), bed: true },
  },
  {
    name: 'short intro (1 s): the voice runs over the outro, B nearly right after',
    a: song({ outroStart: s(169), crossStartNext: s(176) }),
    b: song({ introEnd: s(2) }),
    voice: 12,
    expect: { fit: 'delayed', voiceStart: -s(10), inStart: s(1), dry: s(1), bed: false },
  },
  {
    name: 'short dry stretch under the bed threshold: no bed',
    a: song({ outroStart: s(169), crossStartNext: s(176) }),
    b: song({ introEnd: s(2) }),
    voice: 12,
    bed: true,
    expect: { inStart: s(1), dry: s(1), bed: false },
  },
  {
    name: 'markers outside the cues are ignored',
    a: song({ outroStart: s(200), crossStartNext: s(0.5) }),
    b: song({ introEnd: s(190) }),
    voice: 5,
    expect: { voiceStart: 0, inStart: s(5), markers: { outro: false, intro: false, cross: false } },
  },
  {
    name: 'VT longer than all of A: it starts with A’s outro, B waits',
    a: { cueIn: 0, cueOut: s(10), outroStart: s(2) },
    b: song({ introEnd: s(5) }),
    voice: 30,
    expect: { voiceStart: -s(8), inStart: s(18), fit: 'delayed' },
  },
];

describe('autoPlacement: case set', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const options = c.bed ? { bed: bed() } : {};
      const { lanes, report, problem, islands } = check(c.a, c.b, [voice(c.voice)], options);
      expect(problem).toBeNull();
      expect(islands).toHaveLength(1);
      const { voiceStart, inStart, ...rest } = c.expect;
      expect(report).toMatchObject(rest);
      if (voiceStart !== undefined) expect(lanes.voices[0]?.start).toBe(voiceStart);
      if (inStart !== undefined) expect(lanes.in.start).toBe(inStart);
      // Never before A; B never before its natural start; ducked as the editor's first preset.
      expect(lanes.voices[0]?.start).toBeGreaterThanOrEqual(c.a.cueIn - c.a.cueOut);
      expect(lanes).toMatchObject({
        out: {
          envelope: duckEnvelopes(
            { start: lanes.voices[0]?.start ?? 0, end: end(lanes, [s(c.voice)]) },
            lanes.in.start,
          ).out,
        },
      });
    });
  }

  it('is deterministic', () => {
    for (const c of CASES) {
      const options = c.bed ? { bed: bed() } : {};
      expect(autoPlacement(c.a, c.b, [voice(c.voice)], options)).toEqual(
        autoPlacement(c.a, c.b, [voice(c.voice)], options),
      );
    }
  });
});

// --- Edge cases --------------------------------------------------------------------------

describe('autoPlacement: edge cases', () => {
  const a = song({ outroStart: s(167), crossStartNext: s(172) });
  const b = song({ introEnd: s(9) });

  it('ends the voice on B’s intro end whenever B can start at its natural start', () => {
    for (const seconds of [1, 3, 8, 12.9]) {
      const { lanes } = autoPlacement(a, b, [voice(seconds)]);
      expect(lanes.in.start).toBe(-s(7));
      expect((lanes.voices[0]?.start ?? 0) + s(seconds)).toBe(-s(7) + s(8));
    }
  });

  it('places several voices one after the other, the last ending on the post', () => {
    const { lanes, problem } = check(a, b, [voice(4), voice(3, VOICE2)]);
    expect(problem).toBeNull();
    const gap = Math.round((VOICE_GAP_MS * SR) / 1000);
    const [v1, v2] = lanes.voices;
    expect(v2?.start).toBe((v1?.start ?? 0) + s(4) + gap);
    expect((v2?.start ?? 0) + s(3)).toBe(s(1));
    // One duck spans both voices.
    expect(lanes.out.envelope).toEqual(
      duckEnvelopes({ start: v1?.start ?? 0, end: s(1) }, lanes.in.start).out,
    );
  });

  it('keeps a voice’s trim, gain trim and envelope, moving the envelope with it', () => {
    const lane = {
      start: -s(20),
      cueIn: s(0.5),
      cueOut: s(4.5),
      gainDb: 2,
      envelope: [
        { at: -s(20), gainDb: -3 },
        { at: -s(18), gainDb: 0 },
      ],
    };
    const { lanes } = autoPlacement(a, b, [
      { assetId: VOICE, cueIn: s(0.5), cueOut: s(4.5), lane },
    ]);
    const v = lanes.voices[0];
    expect(v).toMatchObject({ cueIn: s(0.5), cueOut: s(4.5), gainDb: 2 });
    expect(v?.start).toBe(s(1) - s(4));
    expect(v?.envelope).toEqual([
      { at: (v?.start ?? 0) + 0, gainDb: -3 },
      { at: (v?.start ?? 0) + s(2), gainDb: 0 },
    ]);
  });

  it('with a fixed voice start (a take spoken over the music), places only B and the ducks', () => {
    // Spoken from −10 s for 12 s: ends at +2 s, B's 8 s intro starts it at −6 s.
    const { lanes, report } = autoPlacement(a, b, [voice(12)], { voiceStart: -s(10) });
    expect(lanes.voices[0]?.start).toBe(-s(10));
    expect(lanes.in.start).toBe(-s(6));
    expect(report).toMatchObject({ fit: 'delayed', delay: s(1) });
    // A short take spoken early: B still never before its natural start.
    const early = autoPlacement(a, b, [voice(2)], { voiceStart: -s(12) });
    expect(early.lanes.in.start).toBe(-s(7));
    expect(early.report.fit).toBe('post');
  });

  it('keeps every voice within `maxLead` of A’s end', () => {
    const long = song({ outroStart: s(119), crossStartNext: s(149) });
    expect(
      autoPlacement(long, song(), [voice(10)], { maxLead: s(30) }).lanes.voices[0]?.start,
    ).toBe(-s(30));
    // Unbounded, the short voice ends where B comes in (its natural start, 30 s early).
    expect(autoPlacement(long, song(), [voice(10)]).lanes.voices[0]?.start).toBe(-s(40));
  });

  it('lays a bed under the dry stretch, faded in under A and out under B', () => {
    const { lanes, problem } = check(song(), song(), [voice(8)], { bed: bed() });
    expect(problem).toBeNull();
    const laid = lanes.voices[1];
    const fade = Math.round((DEFAULT_BED.fadeMs * SR) / 1000);
    expect(laid).toMatchObject({
      assetId: BED,
      start: -fade,
      cueIn: 0,
      cueOut: s(8) + 2 * fade,
      gainDb: DEFAULT_BED.gainDb,
    });
    const env = laid?.envelope ?? [];
    expect(envelopeGainAt(env, -fade)).toBe(0);
    expect(envelopeGainAt(env, 0)).toBe(1);
    expect(envelopeGainAt(env, s(8))).toBe(1);
    expect(envelopeGainAt(env, s(8) + fade)).toBe(0);
  });

  it('plays a bed shorter than the stretch whole, with shorter fades', () => {
    const { lanes, problem } = check(song(), song(), [voice(20)], { bed: bed(3) });
    expect(problem).toBeNull();
    const laid = lanes.voices[1];
    expect(laid?.cueOut).toBe(s(3));
    expect(laid?.envelope).toHaveLength(4);
  });

  it('adds no bed when every voice lane is taken', () => {
    const voices = Array.from({ length: SEGUE_MAX_VOICES }, (_, i) =>
      voice(5, `00000000-0000-7000-8e01-00000000001${i}`),
    );
    const { lanes, report } = autoPlacement(song(), song(), voices, { bed: bed() });
    expect(lanes.voices).toHaveLength(SEGUE_MAX_VOICES);
    expect(report.bed).toBe(false);
  });

  it('without voices, B plays at its natural start and nothing ducks', () => {
    const { lanes } = autoPlacement(a, b, []);
    expect(lanes).toEqual({
      out: { envelope: [] },
      in: { start: -s(7), envelope: [] },
      voices: [],
    });
  });

  it('ducks with the given preset', () => {
    const preset = { depthDb: -12, rampMs: 500 };
    const { lanes } = autoPlacement(a, b, [voice(5)], { duck: preset });
    expect(lanes.out.envelope.at(-1)?.gainDb).toBe(-12);
    expect(DEFAULT_DUCK).toEqual({ depthDb: -8, rampMs: 300 });
  });
});
