import { type SegueMedia, sourceGainAt } from '@ondes/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  addVoice,
  applyDuck,
  clipsOf,
  emptyLanes,
  type LaneMedia,
  moveLane,
  SR,
  voiceKey,
} from './model.ts';
import { BUFFER_CACHE_SIZE, type PlayerDeps, SeguePlayer } from './preview.ts';

// The WebAudio player against a fake AudioContext: the gains it schedules, evaluated as the
// Web Audio spec evaluates AudioParam automation, are the renderer's (`sourceGainAt`); a stop
// or a second play while the audio loads never leaves two playbacks running.

const s = (n: number) => Math.round(n * SR);

type ParamEvent = { kind: 'set' | 'ramp'; value: number; time: number };

class FakeParam {
  value: number;
  events: ParamEvent[] = [];
  constructor(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'set', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'ramp', value, time });
    return this;
  }
  /** The param's value at `t`: the spec's set / linear-ramp / hold semantics. */
  at(t: number): number {
    let prev = { value: this.value, time: 0 };
    for (const e of this.events) {
      if (t < e.time) {
        return e.kind === 'ramp'
          ? prev.value + ((e.value - prev.value) * (t - prev.time)) / (e.time - prev.time)
          : prev.value;
      }
      prev = { value: e.value, time: e.time };
    }
    return prev.value;
  }
}

class FakeNode {
  connected: FakeNode[] = [];
  connect(node: FakeNode) {
    this.connected.push(node);
    return node;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  started: [number, number, number] | null = null;
  stopped = false;
  start(when: number, offset: number, duration: number) {
    this.started = [when, offset, duration];
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  currentTime = 10;
  state = 'running';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  createBufferSource() {
    const node = new FakeSource();
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  decodeAudioData(bytes: ArrayBuffer) {
    return Promise.resolve({ bytes });
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

function media(id: string, seconds: number, gainDb: number): SegueMedia {
  return {
    assetId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    sha256: id.padEnd(64, '0'),
    sampleRate: SR,
    durationSamples: s(seconds),
    gainDb,
    cueIn: 0,
    cueOut: s(seconds),
  };
}

const A = media('a', 60, -3);
const B = media('b', 60, -1.5);
const VT = media('c', 5, 1);
const MEDIA: LaneMedia = { from: A, to: B, voices: { [VT.assetId]: VT } };
const lanes = applyDuck(
  moveLane(moveLane(addVoice(emptyLanes(), VT.assetId), voiceKey(0), -s(3)), 'in', -s(1)),
  MEDIA,
  { depthDb: -8, rampMs: 300 },
);
const clips = clipsOf(lanes, MEDIA);

function setup(fetchAudio: PlayerDeps['fetchAudio'] = async () => new ArrayBuffer(8)) {
  const ctx = new FakeContext();
  const fetchSpy = vi.fn(fetchAudio);
  const player = new SeguePlayer('station', {
    createContext: () => ctx as unknown as AudioContext,
    fetchAudio: fetchSpy,
  });
  return { ctx, player, fetchSpy };
}

/** A player whose audio stays loading until `release()`. */
function held() {
  const pending: (() => void)[] = [];
  const player = setup(
    () => new Promise<ArrayBuffer>((resolve) => pending.push(() => resolve(new ArrayBuffer(8)))),
  );
  const release = () => {
    for (const resolve of pending.splice(0)) resolve();
  };
  return { ...player, release };
}

describe('SeguePlayer', () => {
  it('schedules the renderer’s gains', async () => {
    const { ctx, player } = setup();
    const from = -s(5);
    expect(await player.play(clips, from, () => {})).toBe('playing');
    expect(ctx.sources).toHaveLength(3);
    const t0 = 10.05;
    ctx.sources.forEach((source, i) => {
      const clip = clips[i];
      if (!clip) throw new Error('clip');
      // source → static gain → envelope gain → destination.
      const staticGain = source.connected[0] as FakeGain;
      const envelope = staticGain.connected[0] as FakeGain;
      expect(envelope.connected[0]).toBe(ctx.destination);
      const startAxis = Math.max(clip.at, from);
      expect(source.started?.[0]).toBeCloseTo(t0 + (startAxis - from) / SR, 9);
      expect(source.started?.[1]).toBeCloseTo((clip.from + startAxis - clip.at) / SR, 9);
      for (const axis of [-s(5), -s(3.4), -s(3.15), -s(3), s(0), s(2), s(2.1), s(2.3), s(6)]) {
        const t = t0 + (axis - from) / SR;
        expect(staticGain.gain.at(t) * envelope.gain.at(t)).toBeCloseTo(
          sourceGainAt({ gainDb: clip.gainDb, envelopes: [clip.envelope] }, axis),
          6,
        );
      }
    });
    expect(player.position()).toBe(from);
  });

  it('cancels a play stopped while its audio loads', async () => {
    const { ctx, player, release } = held();
    const onEnd = vi.fn();
    const playing = player.play(clips, -s(5), onEnd);
    player.stop();
    release();
    expect(await playing).toBe('cancelled');
    expect(ctx.sources).toHaveLength(0);
    expect(player.position()).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('never overlaps two plays started while loading', async () => {
    const { ctx, player, release } = held();
    const first = player.play(clips, -s(5), () => {});
    const second = player.play(clips, -s(2), () => {});
    release();
    expect(await first).toBe('cancelled');
    expect(await second).toBe('playing');
    // One set of sources, from the second play's position.
    expect(ctx.sources).toHaveLength(3);
    expect(player.position()).toBe(-s(2));
    player.stop();
    expect(ctx.sources.every((source) => source.stopped)).toBe(true);
  });

  it('keeps at most one decoded file per lane, and drops the ones no lane plays', async () => {
    const { player, fetchSpy } = setup();
    await player.play(clips, -s(5), () => {});
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await player.play(clips, -s(5), () => {});
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    player.retain([A.sha256]);
    await player.play(clips, -s(5), () => {});
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    for (let i = 0; i < BUFFER_CACHE_SIZE + 2; i++) {
      await player.load(media(`x${i}`, 1, 0));
    }
    // A was pushed out by the newer files.
    await player.load(A);
    expect(fetchSpy).toHaveBeenCalledTimes(5 + BUFFER_CACHE_SIZE + 2 + 1);
  });
});
