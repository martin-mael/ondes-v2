import { clipEnvelope, envelopeGainAt, type SegueMedia, sourceGainAt } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { type History, historyReducer, initialHistory } from './history.ts';
import {
  addPlacedVoice,
  addPoint,
  addRecordedVoice,
  addVoice,
  applyDuck,
  autoLanes,
  clipsOf,
  emptyLanes,
  extentOf,
  fitTrims,
  gainToY,
  handPlaced,
  islandOf,
  islandRange,
  type LaneMedia,
  type Lanes,
  moveLane,
  movePoint,
  ms,
  problemOf,
  replacesIn,
  SR,
  transitionStart,
  voiceKey,
  yToGain,
} from './model.ts';
import { previewPlan } from './preview.ts';
import { clampAxisView, ticks } from './view.ts';

const s = (n: number) => Math.round(n * SR);

function media(id: string, seconds: number, extra: Partial<SegueMedia> = {}): SegueMedia {
  return {
    assetId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    sha256: id.padEnd(64, '0'),
    sampleRate: SR,
    durationSamples: s(seconds),
    gainDb: -2,
    cueIn: 0,
    cueOut: s(seconds),
    ...extra,
  };
}

const A = media('a', 180, { cueIn: s(1), cueOut: s(178), gainDb: -3 });
const B = media('b', 200, { cueIn: s(0.5), gainDb: -1 });
const VT = media('c', 5, { gainDb: 1 });
const MEDIA: LaneMedia = { from: A, to: B, voices: { [VT.assetId]: VT } };

const withVoice = (): Lanes => moveLane(addVoice(emptyLanes(), VT.assetId), voiceKey(0), -s(3));

describe('lanes as clips', () => {
  it('places A before 0, voices at their start and B at in.start, with their gains', () => {
    const lanes = moveLane(withVoice(), 'in', -s(0.5));
    const [a, vt, b] = clipsOf(lanes, MEDIA);
    expect(a).toMatchObject({ key: 'out', from: s(1), to: s(178), at: -s(177), gainDb: -3 });
    expect(vt).toMatchObject({ key: 'voice:0', from: 0, to: s(5), at: -s(3), gainDb: 1 });
    expect(b).toMatchObject({ key: 'in', from: s(0.5), at: -s(0.5), gainDb: -1 });
    expect(extentOf(clipsOf(lanes, MEDIA))).toEqual({
      from: -s(177),
      to: -s(0.5) + s(199.5),
    });
    expect(transitionStart(lanes)).toBe(-s(3));
  });

  it('applies a voice trim and gain, and leaves out lanes without media', () => {
    const lanes = withVoice();
    lanes.voices[0] = { ...(lanes.voices[0] as Lanes['voices'][number]), cueIn: 100, gainDb: 3 };
    const vt = clipsOf(lanes, MEDIA)[1];
    expect(vt).toMatchObject({ from: 100, to: s(5), gainDb: 4 });
    expect(clipsOf(lanes, { ...MEDIA, voices: {} }).map((c) => c.key)).toEqual(['out', 'in']);
  });

  it('moves B and voices with their envelopes', () => {
    const lanes: Lanes = {
      ...withVoice(),
      in: { start: 0, envelope: [{ at: s(1), gainDb: -8 }] },
    };
    const moved = moveLane(lanes, 'in', s(2));
    expect(moved.in).toEqual({ start: s(2), envelope: [{ at: s(3), gainDb: -8 }] });
    // A never moves.
    expect(moveLane(lanes, 'out', s(5))).toBe(lanes);
  });
});

describe('envelopes', () => {
  it('maps gain to height linearly in amplitude, snapping near 0 dB', () => {
    expect(gainToY(-90)).toBe(0);
    expect(yToGain(0)).toBe(-90);
    expect(yToGain(gainToY(0))).toBe(0);
    expect(yToGain(gainToY(-8))).toBeCloseTo(-8, 1);
    expect(yToGain(gainToY(0.3))).toBe(0);
    expect(yToGain(1)).toBe(6);
  });

  it('keeps points strictly increasing', () => {
    const env = addPoint(addPoint([], { at: 10, gainDb: 0 }), { at: 5, gainDb: -6 });
    expect(env.map((p) => p.at)).toEqual([5, 10]);
    expect(addPoint(env, { at: 5, gainDb: -3 })).toEqual([
      { at: 5, gainDb: -3 },
      { at: 10, gainDb: 0 },
    ]);
    // Dragged past its neighbour, a point stops one sample before it.
    expect(movePoint(env, 0, { at: 50, gainDb: -6 })[0]?.at).toBe(9);
  });

  it('ducks A and B under the voice: −8 dB, 300 ms ramps', () => {
    const lanes = applyDuck(moveLane(withVoice(), 'in', -s(1)), MEDIA, {
      depthDb: -8,
      rampMs: 300,
    });
    expect(lanes.out.envelope).toEqual([
      { at: -s(3) - ms(300), gainDb: 0 },
      { at: -s(3), gainDb: -8 },
    ]);
    expect(lanes.in.envelope).toEqual([
      { at: s(2), gainDb: -8 },
      { at: s(2) + ms(300), gainDb: 0 },
    ]);
    // No voice: nothing to duck under.
    const plain = emptyLanes();
    expect(applyDuck(plain, MEDIA, { depthDb: -8, rampMs: 300 })).toBe(plain);
  });
});

describe('the api’s ±10 minutes', () => {
  const max = 600 * SR;
  it('clamps points and lane moves, envelope included', () => {
    expect(addPoint([], { at: max + 5, gainDb: 0 })).toEqual([{ at: max, gainDb: 0 }]);
    expect(movePoint([{ at: 0, gainDb: 0 }], 0, { at: -max - 9, gainDb: 0 })[0]?.at).toBe(-max);
    const lanes: Lanes = {
      ...emptyLanes(),
      in: { start: 0, envelope: [{ at: s(5), gainDb: -8 }] },
    };
    const moved = moveLane(lanes, 'in', max);
    // The envelope's last point stops at the limit, the start 5 s before it.
    expect(moved.in).toEqual({ start: max - s(5), envelope: [{ at: max, gainDb: -8 }] });
    expect(moveLane(withVoice(), voiceKey(0), -max - s(60)).voices[0]?.start).toBe(-max);
  });
});

describe('checks and islands', () => {
  it('flags what the api would refuse', () => {
    expect(problemOf(withVoice(), MEDIA)).toBeNull();
    expect(problemOf(moveLane(withVoice(), 'in', -s(400)), MEDIA)?.code).toBe('out_of_range');
    // Media still loading: nothing to say yet.
    expect(problemOf(withVoice(), { ...MEDIA, voices: {} })).toBeNull();
  });

  it('derives the island the api will render, on the segue axis', () => {
    const lanes = applyDuck(moveLane(withVoice(), 'in', -s(1)), MEDIA, {
      depthDb: -8,
      rampMs: 300,
    });
    const plan = islandOf(lanes, MEDIA);
    if (!plan) throw new Error('no island');
    const range = islandRange(plan, MEDIA);
    expect(range.from).toBe(-s(3) - ms(300) - 441);
    expect(range.to).toBeGreaterThan(s(2) + ms(300));
  });
});

describe('preview plan', () => {
  const lanes = applyDuck(moveLane(withVoice(), 'in', -s(1)), MEDIA, {
    depthDb: -8,
    rampMs: 300,
  });
  const clips = clipsOf(lanes, MEDIA);

  it('starts each clip at the right file sample and delay', () => {
    const { voices } = previewPlan(clips, -s(5));
    expect(voices.map((v) => v.key)).toEqual(['out', 'voice:0', 'in']);
    const [a, vt, b] = voices;
    expect(a).toMatchObject({ delay: 0, offset: A.cueOut - s(5), duration: s(5) });
    expect(vt).toMatchObject({ delay: s(2), offset: 0, duration: s(5) });
    expect(b).toMatchObject({ delay: s(4), offset: B.cueIn });
    // Started past a clip's end: it isn't scheduled.
    expect(previewPlan(clips, s(1)).voices.map((v) => v.key)).toEqual(['voice:0', 'in']);
  });

  it('gives the renderer’s gain at every point of the playback', () => {
    const from = -s(5);
    const { voices, length } = previewPlan(clips, from);
    for (const v of voices) {
      const clip = clips.find((c) => c.key === v.key);
      if (!clip) throw new Error('clip');
      // The automation, evaluated as Web Audio does (set, then linear ramps, hold), times the
      // static gain, equals the renderer's gain on the island's source at that time.
      const envelope = clipEnvelope(clip.envelope, -from, length);
      for (const t of [0, s(1.9), s(2), s(2.15), s(4), s(7.15), s(7.4), length]) {
        const automation = envelopeGainAt(envelope, t);
        expect(v.gain * automation).toBeCloseTo(
          sourceGainAt({ gainDb: clip.gainDb, envelopes: [clip.envelope] }, from + t),
          12,
        );
      }
      expect(v.envelopeStart).toBeCloseTo(envelopeGainAt(clip.envelope, from), 12);
    }
  });
});

describe('history', () => {
  type H = History<number>;
  const run = (state: H, ...actions: Parameters<typeof historyReducer<number>>[1][]) =>
    actions.reduce<H>((s0, a) => historyReducer(s0, a), state);

  it('undoes and redoes each change', () => {
    const h = run(initialHistory(0), { type: 'change', next: 1 }, { type: 'change', next: 2 });
    expect(run(h, { type: 'undo' }).present).toBe(1);
    expect(run(h, { type: 'undo' }, { type: 'undo' }, { type: 'redo' }).present).toBe(1);
    // A new change drops the redo stack.
    expect(run(h, { type: 'undo' }, { type: 'change', next: 5 }).future).toEqual([]);
  });

  it('records a drag as one step, and an empty drag as none', () => {
    const drag = run(
      initialHistory(0),
      { type: 'begin' },
      { type: 'change', next: 1 },
      { type: 'change', next: 2 },
      { type: 'change', next: 3 },
      { type: 'end' },
    );
    expect(drag.past).toEqual([0]);
    expect(run(drag, { type: 'undo' }).present).toBe(0);
    expect(run(initialHistory(0), { type: 'begin' }, { type: 'end' }).past).toEqual([]);
  });
});

describe('view', () => {
  it('stays inside the bounds and keeps its span', () => {
    expect(clampAxisView({ fromSample: -1000, toSample: 1000 }, { from: 0, to: 10_000 })).toEqual({
      fromSample: 0,
      toSample: 2000,
    });
    expect(clampAxisView({ fromSample: 0, toSample: 1e9 }, { from: -10, to: 10_000 })).toEqual({
      fromSample: -10,
      toSample: 10_000,
    });
  });

  it('puts ruler ticks on round seconds', () => {
    const at = ticks({ fromSample: -s(10), toSample: s(10) }, 800);
    expect(at).toContain(0);
    expect(at.every((x) => x % s(1) === 0)).toBe(true);
  });
});

describe('recorded voices (#59)', () => {
  it('places a take where it was recorded, from its first sample', () => {
    const lanes = addVoice(emptyLanes(), 'vt-1');
    const next = addRecordedVoice(lanes, 'take', -s(4.5));
    expect(next.voices[1]).toEqual({
      assetId: 'take',
      start: -s(4.5),
      cueIn: 0,
      gainDb: 0,
      envelope: [],
    });
    // Without a place (no pre-roll): where a new voice goes.
    expect(addRecordedVoice(emptyLanes(), 'take', null).voices[0]).toMatchObject({
      start: -s(3),
      cueIn: 0,
    });
    // Clamped to the api's ±10 minutes.
    expect(addRecordedVoice(emptyLanes(), 'take', -s(3600)).voices[0]?.start).toBe(-s(600));
  });

  it('clamps a pinned cue-out to a playout copy a little shorter than the take', () => {
    const take = media('t', 4);
    const lanes = addRecordedVoice(emptyLanes(), take.assetId, -s(2), {
      media: { from: null, to: null, voices: {} },
      length: s(4) + 2,
    });
    expect(lanes.voices[0]?.cueOut).toBe(s(4) + 2);
    const fitted = fitTrims(lanes, { from: A, to: B, voices: { [take.assetId]: take } });
    expect(fitted.voices[0]?.cueOut).toBe(s(4));
    expect(problemOf(lanes, { from: A, to: B, voices: { [take.assetId]: take } })).toBeNull();
    // Nothing to do: the same lanes back.
    expect(fitTrims(fitted, { from: A, to: B, voices: { [take.assetId]: take } })).toBe(fitted);
  });
});

describe('smart default placement (#61)', () => {
  // A: outro from 12 s before its end, B's natural start 7 s before; B: an 8 s intro.
  const markers = (m: Partial<NonNullable<SegueMedia['markers']>>) => ({
    introEnd: null,
    outroStart: null,
    crossStartNext: null,
    ...m,
  });
  const a = { ...A, markers: markers({ outroStart: s(166), crossStartNext: s(171) }) };
  const b = { ...B, markers: markers({ introEnd: s(8.5) }) };
  const BED = media('d', 60, { kind: 'bed' });
  const placed: LaneMedia = { from: a, to: b, voices: { [VT.assetId]: VT, [BED.assetId]: BED } };

  it('places the first voice from the library over the outro, ending on B’s intro end', () => {
    const lanes = addPlacedVoice(emptyLanes(), placed, VT.assetId);
    expect(lanes.in.start).toBe(-s(7));
    expect(lanes.voices).toEqual([
      { assetId: VT.assetId, start: -s(7) + s(8) - s(5), gainDb: 0, envelope: [] },
    ]);
    expect(lanes.out.envelope.at(-1)).toEqual({ at: -s(4), gainDb: -8 });
    expect(problemOf(lanes, placed)).toBeNull();
    // The next voices go after the last one, and nothing else moves.
    const two = addPlacedVoice(lanes, placed, BED.assetId);
    expect(two.in).toEqual(lanes.in);
    expect(two.voices[1]?.start).toBe((lanes.voices[0]?.start ?? 0) + s(1));
  });

  it('falls back to addVoice while the media is missing', () => {
    const none: LaneMedia = { from: null, to: null, voices: {} };
    expect(addPlacedVoice(emptyLanes(), none, VT.assetId)).toEqual(
      addVoice(emptyLanes(), VT.assetId),
    );
  });

  it('places a take spoken over the music where it was spoken, B and ducks after it', () => {
    const lanes = addRecordedVoice(emptyLanes(), 'take', -s(10), { media: placed, length: s(12) });
    // Its whole length, pinned: autocue's cues later never trim the take B was placed on.
    expect(lanes.voices).toEqual([
      { assetId: 'take', start: -s(10), cueIn: 0, cueOut: s(12), gainDb: 0, envelope: [] },
    ]);
    // Ends at +2 s; B's 8 s intro ends there.
    expect(lanes.in.start).toBe(-s(6));
    expect(lanes.out.envelope).not.toEqual([]);
  });

  it('places a take recorded without music like a voice from the library', () => {
    const lanes = addRecordedVoice(emptyLanes(), 'take', null, { media: placed, length: s(5) });
    expect(lanes.voices[0]).toMatchObject({ start: -s(4), cueIn: 0, cueOut: s(5) });
    expect(lanes.in.start).toBe(-s(7));
    // A second take goes where it was recorded, its length pinned too.
    const two = addRecordedVoice(lanes, 'take-2', s(1), { media: placed, length: s(3) });
    expect(two.in).toEqual(lanes.in);
    expect(two.voices[1]).toEqual({
      assetId: 'take-2',
      start: s(1),
      cueIn: 0,
      cueOut: s(3),
      gainDb: 0,
      envelope: [],
    });
  });

  it('keeps B and the envelopes a person set when placing the first voice', () => {
    const fresh = emptyLanes();
    expect(handPlaced(fresh, placed)).toBe(false);
    expect(handPlaced({ ...fresh, in: { start: -s(7), envelope: [] } }, placed)).toBe(false);
    expect(handPlaced({ ...fresh, in: { start: -s(2), envelope: [] } }, placed)).toBe(true);
    const faded = { ...fresh, out: { envelope: [{ at: -s(2), gainDb: 0 }] } };
    expect(handPlaced(faded, placed)).toBe(true);
    expect(handPlaced(fresh, { ...placed, from: null })).toBeNull();

    // B moved by hand to −2 s: the voice ends where B's 8 s intro does, at +6 s.
    const moved = { ...fresh, in: { start: -s(2), envelope: [{ at: s(1), gainDb: -3 }] } };
    const lanes = addPlacedVoice(moved, placed, VT.assetId);
    expect(lanes.in).toEqual(moved.in);
    expect(lanes.out).toEqual(moved.out);
    expect(lanes.voices[0]?.start).toBe(-s(2) + s(8) - s(5));
    // A take spoken over the music stays where it was spoken; B too.
    const take = addRecordedVoice(faded, 'take', -s(9), { media: placed, length: s(4) });
    expect(take.in).toEqual(faded.in);
    expect(take.out).toEqual(faded.out);
    expect(take.voices[0]).toMatchObject({ start: -s(9), cueIn: 0, cueOut: s(4) });
  });

  it('tells when auto placement would replace B or the envelopes', () => {
    const lanes = addPlacedVoice(emptyLanes(), placed, VT.assetId);
    const auto = autoLanes(lanes, placed);
    expect(auto && replacesIn(lanes, auto)).toBe(false);
    const moved = { ...lanes, in: { ...lanes.in, start: lanes.in.start + s(1) } };
    expect(auto && replacesIn(moved, auto)).toBe(true);
    const drawn = { ...lanes, out: { envelope: [] } };
    expect(auto && replacesIn(drawn, auto)).toBe(true);
  });

  it('keeps a bed and what a person set on it', () => {
    let lanes = addVoice(addVoice(emptyLanes(), VT.assetId), BED.assetId);
    // The 5 s voice fits: there is nothing for the bed to cover, and it stays as it was.
    const fits = autoLanes(lanes, placed);
    expect(fits?.voices).toHaveLength(2);
    expect(fits?.voices[1]).toEqual(lanes.voices[1]);
    // A bed a person shaped keeps its gain trim and envelope (moved with it) under a long voice.
    const LONG = media('e', 25);
    const all: LaneMedia = { ...placed, voices: { ...placed.voices, [LONG.assetId]: LONG } };
    lanes = addVoice(addVoice(emptyLanes(), LONG.assetId), BED.assetId);
    const shaped = { start: lanes.voices[1]?.start ?? 0, gainDb: -14 };
    lanes = {
      ...lanes,
      voices: lanes.voices.map((v, i) =>
        i === 1
          ? { ...v, gainDb: shaped.gainDb, envelope: [{ at: shaped.start + s(2), gainDb: -3 }] }
          : v,
      ),
    };
    const reset = autoLanes(lanes, all);
    const bed = reset?.voices[1];
    expect(bed).toMatchObject({ assetId: BED.assetId, start: -s(1), gainDb: -14 });
    expect(bed?.envelope).toEqual([{ at: -s(1) + s(2), gainDb: -3 }]);
    expect(reset && problemOf(reset, all)).toBeNull();
  });

  it('resets to auto placement, a bed among the voices becoming the bed', () => {
    const LONG = media('e', 25);
    const all: LaneMedia = { ...placed, voices: { ...placed.voices, [LONG.assetId]: LONG } };
    let lanes = addVoice(addVoice(emptyLanes(), LONG.assetId), BED.assetId);
    lanes = { ...lanes, voices: lanes.voices.map((v, i) => (i === 0 ? { ...v, gainDb: 3 } : v)) };
    const reset = autoLanes(lanes, all);
    expect(reset).not.toBeNull();
    // 25 s from the outro (−12 s) ends at +13 s; the 8 s intro starts B at +5 s.
    expect(reset?.voices[0]).toMatchObject({ assetId: LONG.assetId, start: -s(12), gainDb: 3 });
    expect(reset?.in.start).toBe(s(5));
    expect(reset?.voices[1]).toMatchObject({ assetId: BED.assetId, start: -s(1), gainDb: -10 });
    expect(reset && problemOf(reset, all)).toBeNull();
    expect(autoLanes(lanes, { ...all, to: null })).toBeNull();
  });
});
